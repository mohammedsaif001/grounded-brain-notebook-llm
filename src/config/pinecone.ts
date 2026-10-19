/**
 * Pinecone client and index bootstrap.
 *
 * Only the connection lives here; vector reads and writes go through
 * {@link VectorRepository} in `shared/ai/vector.repository.ts`.
 *
 * In Vector DB compared to RDBMS:
 * Index -> Database, Namespace -> Schema, Vector -> Row
 */

import { Pinecone, type Index } from "@pinecone-database/pinecone";
import { env } from "./env.js";
import { EMBEDDING_DIMENSIONS } from "./ai.config.js";

/** Metadata stored on each Pinecone vector for RAG retrieval and citations. */
export type VectorMetadata = {
    workspaceId: string;
    sourceId: string;
    chunkId: string;
    chunkIndex: number;
    sourceTitle: string;
    sourceType: string;
    text: string;
    page?: number;
};

export class PineconeClient {
    private static client: Pinecone | null = null;
    private static indexReady = false;

    static readonly indexName = env.PINECONE_INDEX;

    private static getClient() {
        if (!this.client) {
            this.client = new Pinecone({ apiKey: env.PINECONE_API_KEY });
        }

        return this.client;
    }

    /**
     * Polls until a newly created index reports ready status.
     *
     * @throws When the index is not ready after 30 attempts (~60s)
     */
    private static async waitForIndexReady() {
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const description = await this.getClient().describeIndex(this.indexName);
            if (description.status?.ready) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        throw new Error(`Pinecone index "${this.indexName}" did not become ready in time`);
    }

    /** Ensures the index exists and is ready (creates it on first run if missing). */
    private static async ensureIndex() {
        if (this.indexReady) {
            return;
        }

        const indexes = await this.getClient().listIndexes();
        const exists = indexes.indexes?.some((index) => index.name === this.indexName);

        if (!exists) {
            await this.getClient().createIndex({
                name: this.indexName,
                dimension: EMBEDDING_DIMENSIONS,
                metric: "cosine",
                spec: {
                    serverless: {
                        cloud: "aws",
                        region: "us-east-1",
                    },
                },
            });
            await this.waitForIndexReady();
        }

        this.indexReady = true;
    }

    /** Returns the configured index handle, creating the index on first use. */
    static async getIndex(): Promise<Index> {
        await this.ensureIndex();
        return this.getClient().index({ name: this.indexName });
    }
}
