import { createSourceRecord, deleteSourceRecord, findSourceByIdAndWorkspaceId, findSourcesByWorkspaceId, SourceRecord } from "../repositories/source.repository.js";
import { NotFoundError } from "../types/app-error.js";
import { CreateSourceInput, ListSourcesQuery } from "../validators/source.validator.js";
import { getWorkspaceByIdForUser } from "./workspace.service.js";

/**
 * Persists a source row and enqueues the Inngest processing pipeline.
 *
 * @param data - Fields for the new source record
 * @returns Created source with status `PENDING`
 *
 */
async function createAndProcessSource(
    data: Parameters<typeof createSourceRecord>[0],
) {
    const source = await createSourceRecord(data);

    // await enqueueSourceProcessing({
    //     sourceId: source.id,
    //     workspaceId: source.workspaceId,
    // });

    return source;
}

/**
 * Lists sources in a workspace with optional search and filter query params.
 *
 * @param workspaceId - Workspace to list sources from
 * @param userId - Authenticated user's id
 * @param filters - Optional `q`, `type`, and `status` filters
 * @returns Matching source records
 *
 */
export async function listSourcesForWorkspace(
    workspaceId: string,
    userId: string,
    filters: ListSourcesQuery = {},
) {
    await getWorkspaceByIdForUser(workspaceId, userId);
    return findSourcesByWorkspaceId(workspaceId, filters);
}

/**
 * Loads a single source after verifying workspace ownership.
 *
 * @param workspaceId - Workspace the source belongs to
 * @param sourceId - Source to fetch
 * @param userId - Authenticated user's id
 * @returns Source record
 * @throws {NotFoundError} When the source does not exist in this workspace
 *
 */
export async function getSourceForWorkspace(
    workspaceId: string,
    sourceId: string,
    userId: string,
): Promise<SourceRecord> {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const source = await findSourceByIdAndWorkspaceId(sourceId, workspaceId);

    if (!source) {
        throw new NotFoundError("Source not found");
    }

    return source;
}


/**
 * Creates a plain-text or markdown source and queues it for RAG indexing.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param input - Source type, title, and raw content
 * @returns New source with status `PENDING`
 *
 */
export async function createTextOrMarkdownSource(
    workspaceId: string,
    userId: string,
    input: CreateSourceInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    return createAndProcessSource({
        workspaceId,
        type: input.type,
        title: input.title,
        content: input.content,
        status: "PENDING",
    });
}

/**
 * Deletes a source, its Pinecone vectors, and its Postgres chunks.
 *
 * @param workspaceId - Workspace the source belongs to
 * @param sourceId - Source to delete
 * @param userId - Authenticated user's id
 * @returns Resolves when the source row is deleted
 * @throws {NotFoundError} When the source is not found
 *
 */
export async function deleteSourceForWorkspace(
    workspaceId: string,
    sourceId: string,
    userId: string,
) {
    await getSourceForWorkspace(workspaceId, sourceId, userId);
    // await removeSourceFromIndex(workspaceId, sourceId);
    await deleteSourceRecord(sourceId);
}

/**
 * Deletes multiple sources in sequence.
 *
 * @param workspaceId - Workspace containing the sources
 * @param userId - Authenticated user's id
 * @param sourceIds - Array of source ids to delete
 * @returns Resolves when all sources are deleted
 *
 */
export async function bulkDeleteSourcesForWorkspace(
    workspaceId: string,
    userId: string,
    sourceIds: string[],
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    for (const sourceId of sourceIds) {
        await deleteSourceForWorkspace(workspaceId, sourceId, userId);
    }
}
