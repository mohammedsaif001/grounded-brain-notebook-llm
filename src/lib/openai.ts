/**
 * OpenAI clients configured from validated env.
 *
 * - `openai`: AI SDK provider for chat/generation (`openai(CHAT_MODEL)`)
 * - `EmbeddingClient`: OpenAI SDK embeddings (RAG indexing and query embedding)
 */

import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../config/env.js";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./ai-config.js";

/** AI SDK OpenAI provider; use instead of the default `openai` export so the key comes from `env`. */
export const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });

export class EmbeddingClient {
    private static client: OpenAI | null = null;

    /**
     * Creates embedding vectors for one or more strings.
     *
     * @param texts - Strings to embed (empty array returns immediately)
     * @returns Vectors in the same order as `texts` ({@link EMBEDDING_DIMENSIONS} dimensions each)
     */
    static async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        if (!this.client) {
            this.client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
        }

        const response = await this.client.embeddings.create({
            input: texts,
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
        });

        return response.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
    }
}
