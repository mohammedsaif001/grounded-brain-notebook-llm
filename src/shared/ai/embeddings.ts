import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../../config/ai.config.js";
import { openaiClient } from "../../config/openai.js";

export class EmbeddingClient {
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

        const response = await openaiClient.embeddings.create({
            input: texts,
            model: EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
        });

        return response.data
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
    }
}
