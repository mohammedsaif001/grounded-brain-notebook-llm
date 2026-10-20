import { EventPublisher } from "../../jobs/events.js";
import { logger } from "../../config/logger.js";
import { WorkspaceRepository, type WorkspaceRecord } from "./workspace.repository.js";
import { VectorRepository } from "../../shared/ai/vector.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from "./workspace.validator.js";

/** Workspace business logic. Also the ownership gate used by every workspace-scoped service. */
export class WorkspaceService {
    /**
     * Lists the user's workspaces, most recently updated first.
     *
     * @param userId - Owner's user id
     */
    static listForUser(userId: string): Promise<WorkspaceRecord[]> {
        return WorkspaceRepository.findAllByUserId(userId);
    }

    /**
     * Creates a workspace owned by the user.
     *
     * @param userId - Owner's user id
     * @param input - Validated title/description/icon/default model
     * @returns The created workspace
     */
    static create(userId: string, input: CreateWorkspaceInput) {
        return WorkspaceRepository.create(userId, input);
    }

    /**
     * Loads a workspace only if it belongs to the given user.
     *
     * Other services call this first to enforce ownership of workspace-scoped data.
     *
     * @param workspaceId - Workspace to load
     * @param userId - Requesting user
     * @returns The workspace record
     * @throws {APIError} NotFound when the workspace does not exist or belongs to another user
     */
    static async getForUser(workspaceId: string, userId: string): Promise<WorkspaceRecord> {
        const workspace = await WorkspaceRepository.findByIdAndUserId(workspaceId, userId);

        if (!workspace) {
            throw APIError.NotFound("Workspace not found");
        }

        return workspace;
    }

    /**
     * Updates workspace settings after verifying ownership.
     *
     * @param workspaceId - Workspace to update
     * @param userId - Requesting user
     * @param input - Fields to change (at least one)
     * @returns The updated workspace
     * @throws {APIError} NotFound when the workspace is not found for this user
     */
    static async update(workspaceId: string, userId: string, input: UpdateWorkspaceInput) {
        await this.getForUser(workspaceId, userId);
        return WorkspaceRepository.update(workspaceId, input);
    }

    /**
     * Deletes a workspace, cancels its background jobs, and drops its vector namespace.
     *
     * Vector cleanup is best-effort: deletion continues even if it fails.
     *
     * @param workspaceId - Workspace to delete
     * @param userId - Requesting user
     * @throws {APIError} NotFound when the workspace is not found for this user
     */
    static async delete(workspaceId: string, userId: string) {
        await this.getForUser(workspaceId, userId);
        await EventPublisher.workspaceDeleted({ workspaceId });

        try {
            await VectorRepository.deleteByWorkspaceId(workspaceId);
        } catch (error) {
            logger.warn({ err: error, workspaceId }, "Failed to delete Pinecone namespace");
        }

        await WorkspaceRepository.delete(workspaceId);
    }
}
