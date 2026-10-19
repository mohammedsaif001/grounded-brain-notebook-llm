/**
 * Chat and conversation business logic.
 *
 * Handles CRUD for conversations/messages and the main RAG chat streaming pipeline:
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
import {
    CHAT_MODEL,
    CHAT_MODELS,
    CONVERSATION_SUMMARY_INTERVAL,
    QUERY_REWRITE_WINDOW,
    RECENT_MESSAGE_WINDOW,
} from "../lib/ai-config.js";
import { env } from "../config/env.js";
import { openai } from "../lib/openai.js";
import {
    buildChatSystemPrompt,
    buildUserPromptWithContext,
    extractCitationMarkers,
    retrieveWorkspaceContext,
    rewriteQueryForRetrieval,
    type ConversationTurn,
} from "../lib/rag/retrieve.js";
import {
    createConversationRecord,
    findConversationByIdAndWorkspaceId,
    findConversationsByWorkspaceId,
    touchConversation,
    updateConversationRecord,
    deleteConversationRecord,
} from "../repositories/conversation.repository.js";
import {
    createMessageRecord,
    countMessagesByConversationId,
    findMessagesByConversationId,
    findRecentMessagesByConversationId,
} from "../repositories/message.repository.js";

import { NotFoundError, ValidationError } from "../types/app-error.js";
import {
    buildConversationTitle,
    getLastUserMessageText,
    getTextFromUIMessage,
} from "../utils/chat-message.js";
import { getWorkspaceByIdForUser } from "./workspace.service.js";
import {
    formatTavilyResultsForPrompt,
    searchWeb,
    type TavilySearchResult,
} from "../lib/tavily.js";
import { searchUserMemories } from "../lib/mem0.js";
import { enqueueConversationSummarize } from "../lib/conversation-events.js";

/**
 * Lists all conversations in a workspace for the sidebar/history UI.
 *
 * @param workspaceId - Workspace to list conversations from
 * @param userId - Authenticated user's id
 * @returns Conversation records ordered by most recent activity
 *
 */
export async function listConversationsForWorkspace(
    workspaceId: string,
    userId: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);
    return findConversationsByWorkspaceId(workspaceId);
}

/**
 * Creates an empty conversation (optional title).
 *
 * Most chats are created implicitly on first message via {@link streamWorkspaceChat};
 * this endpoint supports explicit "new chat" actions from the UI.
 *
 * @param workspaceId - Workspace to attach the conversation to
 * @param userId - Authenticated user's id
 * @param title - Optional display title
 * @returns New conversation record
 *
 */
export async function createConversationForWorkspace(
    workspaceId: string,
    userId: string,
    title?: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);
    return createConversationRecord(workspaceId, title);
}

/**
 * Loads persisted message history for a conversation.
 *
 * @param workspaceId - Workspace the conversation belongs to
 * @param conversationId - Conversation to load messages for
 * @param userId - Authenticated user's id
 * @returns Message rows with role, content, citations, and timestamps
 * @throws {NotFoundError} When the conversation does not exist in this workspace
 *
 */
export async function getConversationMessagesForWorkspace(
    workspaceId: string,
    conversationId: string,
    userId: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const conversation = await findConversationByIdAndWorkspaceId(
        conversationId,
        workspaceId,
    );

    if (!conversation) {
        throw new NotFoundError("Conversation not found");
    }

    return findMessagesByConversationId(conversationId);
}

/**
 * Deletes a conversation and all its messages (cascade).
 *
 * @param workspaceId - Workspace the conversation belongs to
 * @param conversationId - Conversation to delete
 * @param userId - Authenticated user's id
 * @returns Resolves when the conversation row is deleted
 * @throws {NotFoundError} When the conversation does not exist
 *
 */
export async function deleteConversationForWorkspace(
    workspaceId: string,
    conversationId: string,
    userId: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const conversation = await findConversationByIdAndWorkspaceId(
        conversationId,
        workspaceId,
    );

    if (!conversation) {
        throw new NotFoundError("Conversation not found");
    }

    await deleteConversationRecord(conversationId);
}

/**
 * Finds an existing conversation or creates one from the first user message.
 *
 * @param workspaceId - Workspace scope
 * @param conversationId - Existing id from client, or undefined for a new chat
 * @param firstMessage - User text used to auto-generate a title for new conversations
 * @returns Conversation record (existing or newly created)
 * @throws {NotFoundError} When `conversationId` is provided but not found
 *
 *
 */
async function resolveConversation(
    workspaceId: string,
    conversationId: string | undefined,
    firstMessage: string,
) {
    if (conversationId) {
        const existing = await findConversationByIdAndWorkspaceId(
            conversationId,
            workspaceId,
        );

        if (!existing) {
            throw new NotFoundError("Conversation not found");
        }

        return existing;
    }

    return createConversationRecord(
        workspaceId,
        buildConversationTitle(firstMessage),
    );
}

/**
 * Loads recent persisted turns for the model.
 *
 * History is read from Postgres rather than trusted from the client payload, so a client
 * cannot inject fabricated assistant turns and the request body stays small no matter how
 * long the conversation gets. Older turns are covered by the rolling summary.
 *
 * @param conversationId - Conversation to load
 * @returns Recent turns, oldest first (includes the just-saved user message)
 *
 */
async function loadRecentTurns(conversationId: string): Promise<ConversationTurn[]> {
    const messages = await findRecentMessagesByConversationId(
        conversationId,
        RECENT_MESSAGE_WINDOW,
    );

    return messages.map((message) => ({
        role: message.role === "USER" ? "user" : "assistant",
        content: message.content,
    }));
}

/**
 * Main RAG chat endpoint: streams an AI reply with workspace context and optional web search.
 *
 * **Pipeline:**
 * 1. Validate user message and resolve/create conversation
 * 2. Save user message to Postgres and load recent history from Postgres
 * 3. Rewrite the message into a standalone query (follow-ups only)
 * 4. Parallel: Pinecone RAG retrieval + Mem0 memory search
 * 5. Stream model response via AI SDK; sources go in the user turn, not the system prompt
 * 6. On finish: save assistant message with the citations it actually used, title, summary job
 *
 * Only the latest user message from `input.messages` is used; earlier messages in the
 * payload are ignored in favour of the persisted history.
 *
 * @param res - Express response (streamed via `pipeUIMessageStreamToResponse`)
 * @param workspaceId - Workspace whose sources to search
 * @param userId - Authenticated user's id
 * @param input - Client chat payload from `useChat`
 * @returns Writes UI message stream to `res`; sets `X-Conversation-Id` header
 * @throws {ValidationError} When no user message text is present
 * @throws {NotFoundError} When conversation or workspace is not found
 *
 *
 */
export async function streamWorkspaceChat(
    res: Response,
    workspaceId: string,
    userId: string,
    input: {
        conversationId?: string;
        messages: UIMessage[];
        model?: string;
        webSearch?: boolean;
    },
) {
    const workspace = await getWorkspaceByIdForUser(workspaceId, userId);
    const requestedModel = input.model ?? workspace.defaultModel;
    const chatModel =
        CHAT_MODELS.find((model) => model === requestedModel) ?? CHAT_MODEL;
    const webSearchEnabled =
        input.webSearch === true && !!env.TAVILY_API_KEY;

    const userText = getLastUserMessageText(input.messages);
    if (!userText) {
        throw new ValidationError("A user message is required");
    }

    const conversation = await resolveConversation(
        workspaceId,
        input.conversationId,
        userText,
    );

    await createMessageRecord({
        conversationId: conversation.id,
        role: "USER",
        content: userText,
    });

    const recentTurns = await loadRecentTurns(conversation.id);
    const priorTurns = recentTurns.slice(0, -1);

    const retrievalQuery = await rewriteQueryForRetrieval(
        priorTurns.slice(-QUERY_REWRITE_WINDOW),
        userText,
    );

    const [retrievedChunks, userMemories] = await Promise.all([
        retrieveWorkspaceContext(workspaceId, retrievalQuery),
        searchUserMemories(userId, retrievalQuery),
    ]);

    const systemPrompt = buildChatSystemPrompt({
        hasSourceContext: retrievedChunks.length > 0,
        conversationSummary: conversation.summary,
        userMemories: userMemories.map((memory) => memory.memory),
        webSearchEnabled,
    });

    const modelMessages: ModelMessage[] = [
        ...priorTurns,
        {
            role: "user",
            content: buildUserPromptWithContext(retrievedChunks, userText),
        },
    ];

    // Accumulated across every web_search call in this reply so [W#] labels stay unique.
    const webResults: TavilySearchResult[] = [];

    const stream = createUIMessageStream({
        originalMessages: input.messages,
        execute: async ({ writer }) => {
            const tools =
                webSearchEnabled
                    ? {
                        web_search: tool({
                            description:
                                "Search the web for up-to-date information outside the workspace sources.",
                            inputSchema: z.object({
                                query: z
                                    .string()
                                    .describe(
                                        "The search query for current web information",
                                    ),
                            }),
                            execute: async ({ query }) => {
                                const response = await searchWeb(query);
                                const startIndex = webResults.length;
                                webResults.push(...response.results);
                                return formatTavilyResultsForPrompt(response, startIndex);
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

            const assistantText = getTextFromUIMessage(responseMessage).trim();
            if (!assistantText) {
                return;
            }

            // Persist only what the answer actually cites; `marker` is the number used
            // in the text ([n] for sources, [Wn] for web results).
            const cited = extractCitationMarkers(assistantText);

            const sourceCitations = retrievedChunks.flatMap((chunk, index) =>
                cited.sources.has(index + 1)
                    ? [{
                        marker: index + 1,
                        sourceId: chunk.sourceId,
                        sourceTitle: chunk.sourceTitle,
                        sourceType: chunk.sourceType,
                        chunkId: chunk.chunkId,
                        chunkIndex: chunk.chunkIndex,
                        page: chunk.page,
                        excerpt: chunk.text.slice(0, 280),
                        score: chunk.score,
                    }]
                    : [],
            );

            const webCitations = webResults.flatMap((result, index) =>
                cited.web.has(index + 1)
                    ? [{
                        marker: index + 1,
                        sourceType: "WEB" as const,
                        sourceTitle: result.title,
                        url: result.url,
                        excerpt: result.content.slice(0, 280),
                    }]
                    : [],
            );

            await createMessageRecord({
                conversationId: conversation.id,
                role: "ASSISTANT",
                content: assistantText,
                citations: [...sourceCitations, ...webCitations],
            });

            await touchConversation(conversation.id);

            if (!conversation.title) {
                await updateConversationRecord(conversation.id, {
                    title: buildConversationTitle(userText),
                });
            }

            // Compare against what the last summary covered rather than using a modulo,
            // so an aborted turn (user message saved, no reply) can't shift the count
            // off the interval and stop summaries forever.
            const messageCount = await countMessagesByConversationId(
                conversation.id,
            );

            if (
                messageCount - conversation.summaryMessageCount >=
                CONVERSATION_SUMMARY_INTERVAL
            ) {
                await enqueueConversationSummarize({
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
