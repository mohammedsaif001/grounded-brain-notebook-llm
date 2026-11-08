import { Errors, type PineconeRecord } from "@pinecone-database/pinecone";
import { timed } from "../logging/timed.js";
import { PineconeClient, type VectorMetadata } from "../../config/pinecone.js";

/** Pinecone upsert batch size. */
const UPSERT_BATCH_SIZE = 100;

/**
 * Runs a delete, treating "namespace not found" as success.
 *
 * A workspace's namespace only exists after its first upsert, and Pinecone answers deletes
 * against a missing namespace with 404. There is nothing to delete in that case.
 *
 * @param remove - Callback performing the Pinecone delete
 */
async function ignoreMissingNamespace(remove: () => Promise<void>) {
    try {
        await remove();
    } catch (error) {
        if (!(error instanceof Errors.PineconeNotFoundError)) {
            throw error;
        }
    }
}

/**
 * Data access for source chunk vectors (Pinecone).
 *
 * Each workspace is its own namespace, so queries never cross workspaces.
 */
export class VectorRepository {
    /**
     * Upserts vectors into a workspace namespace in batches.
     *
     * @param workspaceId - Namespace to write to
     * @param records - Vectors with their {@link VectorMetadata}; an empty array is a no-op
     */
    static async upsert(workspaceId: string, records: PineconeRecord<VectorMetadata>[]) {
        if (records.length === 0) {
            return;
        }

        const namespace = (await PineconeClient.getIndex()).namespace(workspaceId);

        await timed(
            "pinecone",
            "upsert",
            async () => {
                for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
                    await namespace.upsert({ records: records.slice(i, i + UPSERT_BATCH_SIZE) });
                }
            },
            { vectors: records.length },
        );
    }

    /**
     * Returns the `topK` most similar vectors (with metadata) in a workspace.
     *
     * @param workspaceId - Namespace to search
     * @param vector - Query embedding
     * @param topK - Maximum number of matches to return
     * @returns Matches ordered by descending cosine similarity (empty if none)
     */
    static async query(workspaceId: string, vector: number[], topK: number) {
        const index = await PineconeClient.getIndex();
        const result = await timed(
            "pinecone",
            "query",
            () =>
                index.namespace(workspaceId).query({
                    vector,
                    topK,
                    includeMetadata: true,
                    // Chunks the user excluded stay indexed but never reach the model.
                    filter: { excluded: { $ne: true } },
                }),
            { topK },
        );

        return result.matches ?? [];
    }

    /**
     * Merges metadata into one vector without re-embedding it.
     *
     * @param workspaceId - Namespace containing the vector
     * @param id - Vector id (the chunk id)
     * @param metadata - Fields to set; other metadata is left as is
     */
    static async updateMetadata(
        workspaceId: string,
        id: string,
        metadata: Partial<VectorMetadata>,
    ) {
        const index = await PineconeClient.getIndex();
        await ignoreMissingNamespace(() => index.namespace(workspaceId).update({ id, metadata }));
    }

    /**
     * Deletes every vector belonging to one source.
     *
     * @param workspaceId - Namespace containing the vectors
     * @param sourceId - Source whose chunk vectors should be removed
     */
    static async deleteBySourceId(workspaceId: string, sourceId: string) {
        const index = await PineconeClient.getIndex();
        await ignoreMissingNamespace(() =>
            index.namespace(workspaceId).deleteMany({
                filter: { sourceId: { $eq: sourceId } },
            }),
        );
    }

    /**
     * Deletes a workspace's entire namespace.
     *
     * @param workspaceId - Namespace (workspace) to wipe
     */
    static async deleteByWorkspaceId(workspaceId: string) {
        const index = await PineconeClient.getIndex();
        await ignoreMissingNamespace(() => index.namespace(workspaceId).deleteAll());
    }
}
