import { Errors, type PineconeRecord } from "@pinecone-database/pinecone";
import { PineconeClient, type VectorMetadata } from "../../config/pinecone.js";

/** Pinecone upsert batch size. */
const UPSERT_BATCH_SIZE = 100;

/**
 * Runs a delete, treating "namespace not found" as success.
 *
 * A workspace's namespace only exists after its first upsert, and Pinecone answers deletes
 * against a missing namespace with 404. There is nothing to delete in that case.
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
    /** Upserts vectors into a workspace namespace in batches. */
    static async upsert(workspaceId: string, records: PineconeRecord<VectorMetadata>[]) {
        if (records.length === 0) {
            return;
        }

        const namespace = (await PineconeClient.getIndex()).namespace(workspaceId);

        for (let i = 0; i < records.length; i += UPSERT_BATCH_SIZE) {
            await namespace.upsert({ records: records.slice(i, i + UPSERT_BATCH_SIZE) });
        }
    }

    /** Returns the `topK` most similar vectors (with metadata) in a workspace. */
    static async query(workspaceId: string, vector: number[], topK: number) {
        const index = await PineconeClient.getIndex();
        const result = await index.namespace(workspaceId).query({
            vector,
            topK,
            includeMetadata: true,
        });

        return result.matches ?? [];
    }

    /** Deletes every vector belonging to one source. */
    static async deleteBySourceId(workspaceId: string, sourceId: string) {
        const index = await PineconeClient.getIndex();
        await ignoreMissingNamespace(() =>
            index.namespace(workspaceId).deleteMany({
                filter: { sourceId: { $eq: sourceId } },
            }),
        );
    }

    /** Deletes a workspace's entire namespace. */
    static async deleteByWorkspaceId(workspaceId: string) {
        const index = await PineconeClient.getIndex();
        await ignoreMissingNamespace(() => index.namespace(workspaceId).deleteAll());
    }
}
