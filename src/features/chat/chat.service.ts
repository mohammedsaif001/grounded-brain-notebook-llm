/**
 * RAG chat streaming pipeline.
 *
 * ```
 * User message
 *   → guard: sanitize + injection heuristics (blocked → fixed refusal, no LLM call)
 *   → load recent history from DB (guard-blocked turns excluded)
 *   → rewrite follow-up into standalone query
 *   → guard: scope classifier ∥ RAG retrieval ∥ Mem0 memories (blocked → fixed refusal)
 *   → save user message to DB
 *   → streamText (AI SDK) with optional web search tool, through the prompt-leak filter
 *   → save assistant reply + cited sources
 *   → summary job (which also feeds Mem0) every N messages
 * ```
 */

import type { Response } from "express";
import type { LanguageModelUsage } from "ai";
import { propagateAttributes } from "@langfuse/tracing";
import { z } from "zod";
import {
    createUIMessageStream,
    generateId,
    isStepCount,
    pipeUIMessageStreamToResponse,
    streamText,
    toUIMessageStream,
    tool,
    type ModelMessage,
    type UIMessage,
} from "ai";
import { EventPublisher } from "../../jobs/events.js";
import {
    CHAT_MAX_OUTPUT_TOKENS,
    CHAT_MODEL,
    CHAT_MODELS,
    CONVERSATION_SUMMARY_INTERVAL,
    QUERY_REWRITE_WINDOW,
    RECENT_MESSAGE_WINDOW,
    WEB_SEARCH_MAX_QUERY_CHARS,
} from "../../config/ai.config.js";
import { ChatPrompt } from "./chat-prompt.js";
import { logger } from "../../config/logger.js";
import { isOpenAIRateLimitError, openai } from "../../config/openai.js";
import { TavilyClient } from "../../config/tavily.js";
import { TavilySearch, type TavilySearchResult } from "./web-search/tavily.js";
import { APIError } from "../../shared/http/api-error.js";
import { UIMessageUtils } from "./chat-message.util.js";
import { ConversationService } from "../conversation/conversation.service.js";
import type { ConversationRecord } from "../conversation/conversation.repository.js";
import { MemoryService } from "../memory/memory.service.js";
import { SourceService } from "../source/source.service.js";
import type { RetrievedChunk } from "./chat.types.js";
import { ChatGuard, type GuardVerdict } from "./guardrails/chat-guard.js";
import { RetrievalService } from "./retrieval.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";

/** Input to {@link ChatService.stream}, mirroring the validated request body. */
export type ChatInput = {
    conversationId?: string;
    messages: UIMessage[];
    model?: string;
    webSearch?: boolean;
};

/** A guard verdict that blocked the message. */
type BlockedVerdict = Extract<GuardVerdict, { allowed: false }>;

/** Orchestrates a streamed, source-grounded chat reply. */
export class ChatService {
    /**
     * Keeps only the sources and web results the answer actually cites.
     * `marker` is the number used in the text (`[n]` for sources, `[Wn]` for web results).
     *
     * @param assistantText - The full reply, scanned for citation markers
     * @param retrievedChunks - Chunks shown to the model; position + 1 is the marker number
     * @param webResults - Web results shown to the model; position + 1 is the `W` marker number
     * @returns Citation objects stored with the assistant message
     */
    private static buildCitations(
        assistantText: string,
        retrievedChunks: RetrievedChunk[],
        webResults: TavilySearchResult[],
    ) {
        const cited = ChatPrompt.extractCitationMarkers(assistantText);

        const sourceCitations = retrievedChunks.flatMap((chunk, index) =>
            cited.sources.has(index + 1)
                ? [
                      {
                          marker: index + 1,
                          sourceId: chunk.sourceId,
                          sourceTitle: chunk.sourceTitle,
                          sourceType: chunk.sourceType,
                          chunkId: chunk.chunkId,
                          chunkIndex: chunk.chunkIndex,
                          chunkTotal: chunk.chunkTotal,
                          page: chunk.page,
                          chapter: chunk.chapter,
                          section: chunk.section,
                          path: chunk.path,
                          excerpt: chunk.text.slice(0, 280),
                          score: chunk.score,
                      },
                  ]
                : [],
        );

        const webCitations = webResults.flatMap((result, index) =>
            cited.web.has(index + 1)
                ? [
                      {
                          marker: index + 1,
                          sourceType: "WEB" as const,
                          sourceTitle: result.title,
                          url: result.url,
                          excerpt: result.content.slice(0, 280),
                      },
                  ]
                : [],
        );

        return [...sourceCitations, ...webCitations];
    }

    /**
     * Streams an AI reply grounded in workspace sources, with optional web search.
     *
     * Only the latest user message from `input.messages` is used; earlier messages in the
     * payload are ignored in favour of the persisted history.
     *
     * @param res - Express response (streamed via `pipeUIMessageStreamToResponse`)
     * @param workspaceId - Workspace whose sources to search
     * @param userId - Requesting user; must own the workspace
     * @param input - Conversation id, messages, model choice and web-search flag
     * @returns Writes the UI message stream to `res`; sets `X-Conversation-Id` header
     * @throws {APIError} BadRequest when no user message text is present or it is too long
     * @throws {APIError} NotFound when the conversation or workspace is not found
     */
    static stream(res: Response, workspaceId: string, userId: string, input: ChatInput) {
        // Tags every LLM trace in this request (query rewrite + reply) with the user and
        // conversation. A brand-new conversation has no id yet, so its first turn has no session.
        return propagateAttributes(
            { userId, sessionId: input.conversationId, traceName: "chat" },
            () => this.streamReply(res, workspaceId, userId, input),
        );
    }

    /**
     * Does the actual work of {@link ChatService.stream}: runs the chat guard, rewrites the
     * query, retrieves chunks and memories, streams the model reply, then persists the answer
     * (with citations) and queues a summary job when due.
     *
     * Blocked messages get a fixed refusal instead of a model reply (see {@link ChatGuard}).
     *
     * @param res - Express response the stream is piped to
     * @param workspaceId - Workspace whose sources to search
     * @param userId - Requesting user
     * @param input - Chat request input
     */
    private static async streamReply(
        res: Response,
        workspaceId: string,
        userId: string,
        input: ChatInput,
    ) {
        const startedAt = Date.now();
        const workspace = await WorkspaceService.getForUser(workspaceId, userId);
        const requestedModel = input.model ?? workspace.defaultModel;
        const chatModel = CHAT_MODELS.find((model) => model === requestedModel) ?? CHAT_MODEL;
        const webSearchEnabled = input.webSearch === true && TavilyClient.isConfigured();

        const rawText = UIMessageUtils.getLastUserText(input.messages);
        if (!rawText) {
            throw APIError.BadRequest("A user message is required");
        }

        // Guard layer 1: normalize and strip invisible characters before anything reads it.
        const userText = ChatGuard.sanitize(rawText);

        const conversation = await ConversationService.getOrCreate(
            workspaceId,
            input.conversationId,
            userText,
        );

        // Guard layer 2: regex heuristics, before any LLM sees the text.
        const heuristicVerdict = ChatGuard.checkHeuristics(userText);
        if (heuristicVerdict && !heuristicVerdict.allowed) {
            return this.streamRefusal(res, {
                originalMessages: input.messages,
                conversation,
                userId,
                userText,
                verdict: heuristicVerdict,
            });
        }

        // History is read from Postgres rather than trusted from the client payload, so a
        // client cannot inject fabricated assistant turns and the request body stays small no
        // matter how long the conversation gets. Older turns are covered by the rolling summary.
        // Read before the new message is saved; guard-blocked turns are excluded.
        const priorTurns = await ConversationService.getRecentTurns(
            conversation.id,
            RECENT_MESSAGE_WINDOW - 1,
        );

        const retrievalQuery = await RetrievalService.rewriteQuery(
            priorTurns.slice(-QUERY_REWRITE_WINDOW),
            userText,
        );

        // Guard layer 3 runs alongside retrieval so it adds no latency to allowed messages.
        const [verdict, retrievedChunks, userMemories] = await Promise.all([
            SourceService.listReady(workspaceId).then((sources) =>
                ChatGuard.classify(userText, retrievalQuery, {
                    workspaceTitle: workspace.title,
                    workspaceDescription: workspace.description,
                    sourceTitles: sources.map((source) => source.title),
                }),
            ),
            RetrievalService.retrieve(workspaceId, retrievalQuery),
            MemoryService.search(userId, retrievalQuery),
        ]);

        if (!verdict.allowed) {
            return this.streamRefusal(res, {
                originalMessages: input.messages,
                conversation,
                userId,
                userText,
                verdict,
            });
        }

        const userMessage = await ConversationService.addMessage({
            conversationId: conversation.id,
            role: "USER",
            content: userText,
        });

        // Guard layers 4-5: hardened system prompt, plus a canary that detects prompt leaks.
        const canary = ChatGuard.createCanary();
        let leaked = false;

        const systemPrompt = ChatPrompt.buildSystemPrompt({
            hasSourceContext: retrievedChunks.length > 0,
            webSearchEnabled,
            canary,
        });

        const modelMessages: ModelMessage[] = [
            ...priorTurns,
            {
                role: "user",
                content: ChatPrompt.buildUserPrompt({
                    chunks: retrievedChunks,
                    userText,
                    userMemories: userMemories.map((memory) => memory.memory),
                    conversationSummary: conversation.summary,
                }),
            },
        ];

        // Accumulated across every web_search call in this reply so [W#] labels stay unique.
        const webResults: TavilySearchResult[] = [];

        let totalUsage: PromiseLike<LanguageModelUsage> | undefined;

        const stream = createUIMessageStream({
            originalMessages: input.messages,
            // Headers are already sent once streaming starts, so failures are reported in-stream.
            // Only rate-limit messages are surfaced; anything else stays generic.
            onError: (error) => {
                if (error instanceof APIError && error.code === "TOO_MANY_REQUESTS") {
                    return error.message;
                }
                if (isOpenAIRateLimitError(error)) {
                    return "The AI provider is rate limiting requests. Please try again shortly.";
                }
                logger.error({ err: error, conversationId: conversation.id }, "Chat stream failed");
                return "Something went wrong while generating a reply. Please try again.";
            },
            execute: ({ writer }) => {
                const tools = webSearchEnabled
                    ? {
                          web_search: tool({
                              description:
                                  "Search the web for up-to-date detail on topics within the workspace's subject matter. Never use it for unrelated topics.",
                              inputSchema: z.object({
                                  query: z
                                      .string()
                                      .trim()
                                      .min(1)
                                      .max(WEB_SEARCH_MAX_QUERY_CHARS)
                                      .describe("The search query for current web information"),
                              }),
                              execute: async ({ query }) => {
                                  const response = await TavilySearch.search(query);
                                  const startIndex = webResults.length;
                                  webResults.push(...response.results);
                                  return TavilySearch.formatResultsForPrompt(response, startIndex);
                              },
                          }),
                      }
                    : undefined;

                const result = streamText({
                    model: openai(chatModel),
                    system: systemPrompt,
                    messages: modelMessages,
                    tools,
                    stopWhen: webSearchEnabled ? isStepCount(3) : undefined,
                    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
                    telemetry: { functionId: "chat" },
                });

                totalUsage = result.totalUsage;
                writer.merge(
                    toUIMessageStream({ stream: result.stream }).pipeThrough(
                        ChatGuard.createLeakFilter(canary, () => {
                            leaked = true;
                        }),
                    ),
                );
            },
            onFinish: async ({ responseMessage, isAborted }) => {
                if (leaked) {
                    await this.persistWithheldReply(conversation.id, userId, userMessage.id);
                    return;
                }

                if (isAborted) {
                    return;
                }

                const assistantText = UIMessageUtils.getText(responseMessage).trim();
                if (!assistantText) {
                    return;
                }

                const usage = await totalUsage?.then(
                    (u) => u,
                    () => undefined,
                );
                logger.info(
                    {
                        kind: "chat",
                        who: { userId, conversationId: conversation.id },
                        model: chatModel,
                        guard: verdict.category,
                        sources: retrievedChunks.length,
                        memories: userMemories.length,
                        webSearch: webSearchEnabled ? webResults.length : false,
                        ...(usage && {
                            tokens: `in ${usage.inputTokens ?? 0} | out ${usage.outputTokens ?? 0} | total ${usage.totalTokens ?? 0}`,
                        }),
                    },
                    `Chat reply (${chatModel}) - ${Date.now() - startedAt}ms`,
                );

                // Runs after the reply has streamed, so errors can't reach the Express error
                // handler; log them instead of letting them become an unhandled rejection.
                try {
                    await ConversationService.addMessage({
                        conversationId: conversation.id,
                        role: "ASSISTANT",
                        content: assistantText,
                        citations: this.buildCitations(assistantText, retrievedChunks, webResults),
                    });

                    await ConversationService.touch(conversation.id);
                    await ConversationService.ensureTitle(conversation, userText);

                    // Compare against what the last summary covered rather than using a modulo,
                    // so an aborted turn (user message saved, no reply) can't shift the count
                    // off the interval and stop summaries forever.
                    const messageCount = await ConversationService.countMessages(conversation.id);

                    if (
                        messageCount - conversation.summaryMessageCount >=
                        CONVERSATION_SUMMARY_INTERVAL
                    ) {
                        await EventPublisher.conversationSummaryRequested({
                            conversationId: conversation.id,
                            userId,
                            messageCount,
                        });
                    }
                } catch (error) {
                    logger.error(
                        { err: error, conversationId: conversation.id },
                        "Failed to persist assistant reply",
                    );
                }
            },
        });

        await pipeUIMessageStreamToResponse({
            response: res,
            stream,
            headers: {
                "X-Conversation-Id": conversation.id,
            },
        });
    }

    /**
     * Records a reply the leak filter cut off: the user message is flagged and the refusal is
     * saved in place of the leaked text, both excluded from future model context.
     *
     * @param conversationId - Conversation the turn belongs to
     * @param userId - Requesting user (for logs)
     * @param userMessageId - The already-saved user message to flag
     */
    private static async persistWithheldReply(
        conversationId: string,
        userId: string,
        userMessageId: string,
    ) {
        logger.warn(
            {
                kind: "chat-guard",
                layer: "output",
                category: "output_leak",
                who: { userId, conversationId },
            },
            "Chat guard withheld a reply that leaked the system prompt",
        );

        try {
            await ConversationService.markBlocked(userMessageId);
            await ConversationService.addMessage({
                conversationId,
                role: "ASSISTANT",
                content: ChatGuard.refusal("output_leak"),
                blocked: true,
            });
            await ConversationService.touch(conversationId);
        } catch (error) {
            logger.error({ err: error, conversationId }, "Failed to persist withheld reply");
        }
    }

    /**
     * Streams a fixed refusal for a guard-blocked message, in the same UI message stream
     * format as a normal reply so the client needs no special handling.
     *
     * Both the user message and the refusal are saved with `blocked: true`: the user still
     * sees them in the conversation, but they never reach the model, summaries or Mem0.
     *
     * @param res - Express response the stream is piped to
     * @param input.originalMessages - Messages from the request
     * @param input.conversation - Conversation the turn belongs to
     * @param input.userId - Requesting user (for logs)
     * @param input.userText - The sanitized message that was blocked
     * @param input.verdict - Why it was blocked
     */
    private static async streamRefusal(
        res: Response,
        input: {
            originalMessages: UIMessage[];
            conversation: ConversationRecord;
            userId: string;
            userText: string;
            verdict: BlockedVerdict;
        },
    ) {
        const { conversation, verdict } = input;
        const refusal = ChatGuard.refusal(verdict.category);

        // Only a short preview is logged: the message may be long or contain private data.
        logger.warn(
            {
                kind: "chat-guard",
                layer: verdict.layer,
                category: verdict.category,
                reason: verdict.reason,
                who: { userId: input.userId, conversationId: conversation.id },
                preview: input.userText.slice(0, 120),
            },
            `Chat guard blocked a message (${verdict.category} via ${verdict.layer})`,
        );

        try {
            await ConversationService.addMessage({
                conversationId: conversation.id,
                role: "USER",
                content: input.userText,
                blocked: true,
            });
            await ConversationService.addMessage({
                conversationId: conversation.id,
                role: "ASSISTANT",
                content: refusal,
                blocked: true,
            });
            await ConversationService.touch(conversation.id);
        } catch (error) {
            logger.error(
                { err: error, conversationId: conversation.id },
                "Failed to persist blocked turn",
            );
        }

        const stream = createUIMessageStream({
            originalMessages: input.originalMessages,
            execute: ({ writer }) => {
                const id = generateId();
                writer.write({ type: "start" });
                writer.write({ type: "text-start", id });
                writer.write({ type: "text-delta", id, delta: refusal });
                writer.write({ type: "text-end", id });
                writer.write({ type: "finish", finishReason: "stop" });
            },
        });

        await pipeUIMessageStreamToResponse({
            response: res,
            stream,
            headers: {
                "X-Conversation-Id": conversation.id,
            },
        });
    }
}
