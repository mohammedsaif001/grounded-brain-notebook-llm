/**
 * OpenAI clients configured from validated env.
 *
 * - `openai`: AI SDK provider for chat/generation (`openai(CHAT_MODEL)`)
 * - `embedTexts`: OpenAI SDK client for embeddings (RAG indexing and query embedding)
 */

import OpenAI from "openai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../config/env.js";
import {
    CHAT_MODEL,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
} from "./ai-config.js";

export { CHAT_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };

/** AI SDK OpenAI provider; use instead of the default `openai` export so the key comes from `env`. */
export const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });

let client: OpenAI | null = null;

/**
 * Creates embedding vectors for one or more text strings.
 *
 * Used during source indexing (`embedAndIndexSource`) and RAG query embedding
 * (`retrieveWorkspaceContext`).
 *
 * @param texts - Strings to embed (empty array returns immediately)
 * @returns Embedding vectors in the same order as input texts (1536 dimensions each)
 *
 *
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
        return [];
    }

    if (!client) {
        client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }

    const response = await client.embeddings.create({
        input: texts,
        model: EMBEDDING_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
    })

    return response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
}
