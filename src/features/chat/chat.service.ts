/**
 * RAG chat streaming pipeline.
 *
 * ```
 * User message
 *   → save to DB
 *   → load recent history from DB
 *   → rewrite follow-up into standalone query
 *   → RAG retrieval + Mem0 memories
 *   → streamText (AI SDK) with optional web search tool
 *   → save assistant reply + cited sources
 *   → summary job (which also feeds Mem0) every N messages
 * ```
 */

import type { Response } from "express";
import { z } from "zod";
import {
    createUIMessageStream,
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
    CHAT_MODEL,
    CHAT_MODELS,
    CONVERSATION_SUMMARY_INTERVAL,
    QUERY_REWRITE_WINDOW,
    RECENT_MESSAGE_WINDOW,
} from "../../config/ai.config.js";
import { ChatPrompt } from "./chat-prompt.js";
import { isOpenAIRateLimitError, openai } from "../../config/openai.js";
import { TavilyClient, type TavilySearchResult } from "./web-search/tavily.js";
import { APIError } from "../../shared/http/api-error.js";
import { UIMessageUtils } from "./chat-message.util.js";
import { ConversationService } from "../conversation/conversation.service.js";
import { MemoryService } from "../memory/memory.service.js";
import type { RetrievedChunk } from "./chat.types.js";
import { RetrievalService } from "./retrieval.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";

export type ChatInput = {
    conversationId?: string;
    messages: UIMessage[];
    model?: string;
    webSearch?: boolean;
};

export class ChatService {
    /**
     * Keeps only the sources and web results the answer actually cites.
     * `marker` is the number used in the text (`[n]` for sources, `[Wn]` for web results).
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
                          page: chunk.page,
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
     * @returns Writes the UI message stream to `res`; sets `X-Conversation-Id` header
     * @throws {APIError} BadRequest when no user message text is present
     * @throws {APIError} NotFound when the conversation or workspace is not found
     */
    static async stream(res: Response, workspaceId: string, userId: string, input: ChatInput) {
        const workspace = await WorkspaceService.getForUser(workspaceId, userId);
        const requestedModel = input.model ?? workspace.defaultModel;
        const chatModel = CHAT_MODELS.find((model) => model === requestedModel) ?? CHAT_MODEL;
        const webSearchEnabled = input.webSearch === true && TavilyClient.isConfigured();

        const userText = UIMessageUtils.getLastUserText(input.messages);
        if (!userText) {
            throw APIError.BadRequest("A user message is required");
        }

        const conversation = await ConversationService.getOrCreate(
            workspaceId,
            input.conversationId,
            userText,
        );

        await ConversationService.addMessage({
            conversationId: conversation.id,
            role: "USER",
            content: userText,
        });

        // History is read from Postgres rather than trusted from the client payload, so a
        // client cannot inject fabricated assistant turns and the request body stays small no
        // matter how long the conversation gets. Older turns are covered by the rolling summary.
        const recentTurns = await ConversationService.getRecentTurns(
            conversation.id,
            RECENT_MESSAGE_WINDOW,
        );
        const priorTurns = recentTurns.slice(0, -1);

        const retrievalQuery = await RetrievalService.rewriteQuery(
            priorTurns.slice(-QUERY_REWRITE_WINDOW),
            userText,
        );

        const [retrievedChunks, userMemories] = await Promise.all([
            RetrievalService.retrieve(workspaceId, retrievalQuery),
            MemoryService.search(userId, retrievalQuery),
        ]);

        const systemPrompt = ChatPrompt.buildSystemPrompt({
            hasSourceContext: retrievedChunks.length > 0,
            conversationSummary: conversation.summary,
            userMemories: userMemories.map((memory) => memory.memory),
            webSearchEnabled,
        });

        const modelMessages: ModelMessage[] = [
            ...priorTurns,
            {
                role: "user",
                content: ChatPrompt.buildUserPrompt(retrievedChunks, userText),
            },
        ];

        // Accumulated across every web_search call in this reply so [W#] labels stay unique.
        const webResults: TavilySearchResult[] = [];

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
                console.error("Chat stream failed:", error);
                return "Something went wrong while generating a reply. Please try again.";
            },
            execute: ({ writer }) => {
                const tools = webSearchEnabled
                    ? {
                          web_search: tool({
                              description:
                                  "Search the web for up-to-date information outside the workspace sources.",
                              inputSchema: z.object({
                                  query: z
                                      .string()
                                      .describe("The search query for current web information"),
                              }),
                              execute: async ({ query }) => {
                                  const response = await TavilyClient.search(query);
                                  const startIndex = webResults.length;
                                  webResults.push(...response.results);
                                  return TavilyClient.formatResultsForPrompt(response, startIndex);
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
                });

                writer.merge(toUIMessageStream({ stream: result.stream }));
            },
            onFinish: async ({ responseMessage, isAborted }) => {
                if (isAborted) {
                    return;
                }

                const assistantText = UIMessageUtils.getText(responseMessage).trim();
                if (!assistantText) {
                    return;
                }

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
