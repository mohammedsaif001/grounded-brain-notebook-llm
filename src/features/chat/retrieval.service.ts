/**
 * RAG retrieval: query rewriting and vector search over workspace sources.
 */

import { generateText } from "ai";
import { CHAT_MODEL, RAG_MIN_SCORE, RAG_TOP_K } from "../../config/ai.config.js";
import { openai } from "../../config/openai.js";
import { EmbeddingClient } from "../../shared/ai/embeddings.js";
import { VectorRepository } from "../../shared/ai/vector.repository.js";
import type { ConversationTurn } from "../conversation/conversation.types.js";
import type { RetrievedChunk } from "./chat.types.js";

export class RetrievalService {
    /**
     * Rewrites the latest user message into a standalone search query using recent turns.
     *
     * Follow-ups like "explain that in more detail" embed poorly on their own; resolving
     * pronouns and references against the conversation makes retrieval find the right chunks.
     * Falls back to the raw message when there is no history or the rewrite fails.
     *
     * @param history - Recent prior turns (oldest first), excluding the latest user message
     * @param userText - Latest user message
     * @returns Standalone query for vector and memory search
     */
    static async rewriteQuery(
        history: ConversationTurn[],
        userText: string,
    ): Promise<string> {
        if (history.length === 0) {
            return userText;
        }

        const transcript = history
            .map((turn) => `${turn.role}: ${turn.content.slice(0, 1500)}`)
            .join("\n");

        try {
            const { text } = await generateText({
                model: openai(CHAT_MODEL),
                system: [
                    "You rewrite the user's latest message into a standalone search query for a document retrieval system.",
                    "Resolve pronouns and references using the conversation. Keep the user's intent and key terms.",
                    "If the message is already standalone, return it unchanged.",
                    "Output only the query, with no quotes or explanation.",
                ].join("\n"),
                prompt: `Conversation:\n${transcript}\n\nLatest message: ${userText}`,
                maxOutputTokens: 120,
            });

            return text.trim() || userText;
        } catch (error) {
            console.error("Query rewrite failed, using raw message:", error);
            return userText;
        }
    }

    /**
     * Retrieves the most relevant source chunks for a query via vector search.
     *
     * @param workspaceId - Workspace to search
     * @param query - Standalone query text to embed and search with
     * @returns Chunks scoring above {@link RAG_MIN_SCORE}, up to {@link RAG_TOP_K}
     */
    static async retrieve(workspaceId: string, query: string): Promise<RetrievedChunk[]> {
        const [embedding] = await EmbeddingClient.embed([query]);
        const matches = await VectorRepository.query(workspaceId, embedding, RAG_TOP_K);

        const chunks: RetrievedChunk[] = [];

        for (const match of matches) {
            const score = match.score ?? 0;
            if (score < RAG_MIN_SCORE) {
                continue;
            }

            const metadata = match.metadata as Record<string, unknown> | undefined;
            if (
                !metadata ||
                typeof metadata.sourceId !== "string" ||
                typeof metadata.sourceTitle !== "string" ||
                typeof metadata.sourceType !== "string" ||
                typeof metadata.chunkId !== "string" ||
                typeof metadata.text !== "string"
            ) {
                continue;
            }

            chunks.push({
                sourceId: metadata.sourceId,
                sourceTitle: metadata.sourceTitle,
                sourceType: metadata.sourceType,
                chunkId: metadata.chunkId,
                chunkIndex: Number(metadata.chunkIndex ?? 0),
                ...(typeof metadata.page === "number" ? { page: metadata.page } : {}),
                text: metadata.text,
                score,
            });
        }

        return chunks;
    }
}
