/**
 * Inngest event helpers for background source processing (RAG indexing).
 */

import { inngest } from "../inngest/client.js";

/**
 * Enqueues a source processing job to run asynchronously via Inngest.
 *
 * The worker runs extract → chunk → embed → Pinecone upsert.
 *
 * @param input - Source and workspace ids for the processing worker
 * @returns Resolves when the event is accepted by Inngest
 *
 */
export async function enqueueSourceProcessing(input: {
    sourceId: string;
    workspaceId: string;
}) {
    await inngest.send({
        name: "source/created",
        data: input,
    });
}

/**
 * Signals that a source was deleted so any in-flight processing run is cancelled
 * before it can write vectors for a source that no longer exists.
 *
 * @param input - Deleted source and its workspace id
 * @returns Resolves when the event is accepted by Inngest
 *
 */
export async function emitSourceDeleted(input: {
    sourceId: string;
    workspaceId: string;
}) {
    await inngest.send({
        name: "source/deleted",
        data: input,
    });
}

/**
 * Signals that a workspace was deleted so in-flight source and artifact runs are cancelled.
 *
 * @param input - Deleted workspace id
 * @returns Resolves when the event is accepted by Inngest
 *
 */
export async function emitWorkspaceDeleted(input: { workspaceId: string }) {
    await inngest.send({
        name: "workspace/deleted",
        data: input,
    });
}
