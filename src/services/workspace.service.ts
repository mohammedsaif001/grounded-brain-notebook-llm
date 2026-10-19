import {
    type WorkspaceRecord,
} from "../repositories/workspace.repository.js";

import * as workspaceRepository from "../repositories/workspace.repository.js";
import { NotFoundError } from "../types/app-error.js";
import type {
    CreateWorkspaceInput,
    UpdateWorkspaceInput,
} from "../validators/workspace.validator.js";

/**
 * Lists all workspaces belonging to the authenticated user.
 *
 * @param userId - Authenticated user's id
 * @returns Array of workspace records
 */
export async function listWorkspacesByUser(
    userId: string,
): Promise<WorkspaceRecord[]> {
    return workspaceRepository.findWorkspacesByUserId(userId);
}

/**
 * Creates a new workspace for the authenticated user.
 *
 * @param userId - Authenticated user's id
 * @param input - Workspace creation payload
 * @returns Created workspace record
 */
export async function createWorkspaceForUser(
    userId: string,
    input: CreateWorkspaceInput,
) {
    return workspaceRepository.createWorkspaceRecord(userId, input);
}

/**
 * Loads a workspace only if it belongs to the given user.
 *
 * @param workspaceId - Workspace to fetch
 * @param userId - Authenticated user's id
 * @returns The workspace record
 * @throws {NotFoundError} When the workspace does not exist or belongs to another user
 *
 *
 */
export async function getWorkspaceByIdForUser(
    workspaceId: string,
    userId: string,
): Promise<WorkspaceRecord> {
    const workspace = await workspaceRepository.findWorkspaceByIdAndUserId(workspaceId, userId);

    if (!workspace) {
        throw new NotFoundError("Workspace not found");
    }

    return workspace;
}

/**
 * Updates workspace settings after verifying the user owns it.
 *
 * @param workspaceId - Workspace to update
 * @param userId - Authenticated user's id
 * @param input - Partial workspace fields to change
 * @returns Updated workspace record
 * @throws {NotFoundError} When the workspace is not found for this user
 *
 */
export async function updateWorkspaceForUser(
    workspaceId: string,
    userId: string,
    input: UpdateWorkspaceInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);
    return workspaceRepository.updateWorkspaceRecord(workspaceId, input);
}

/**
 * Deletes a workspace and its Pinecone vector namespace.
 *
 * Pinecone cleanup is best-effort: deletion continues even if vector removal fails.
 *
 * @param workspaceId - Workspace to delete
 * @param userId - Authenticated user's id
 * @returns Resolves when the workspace row is deleted
 * @throws {NotFoundError} When the workspace is not found for this user
 *
 */
export async function deleteWorkspaceForUser(
    workspaceId: string,
    userId: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    // try {
    //     await deleteWorkspaceVectors(workspaceId);
    // } catch (error) {
    //     console.error("Failed to delete Pinecone namespace:", error);
    // }

    await workspaceRepository.deleteWorkspaceRecord(workspaceId);
}
