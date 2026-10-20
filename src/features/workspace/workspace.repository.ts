import prisma from "../../config/db.js";
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from "./workspace.validator.js";

/** Columns returned for every workspace query. */
const workspaceSelect = {
    id: true,
    title: true,
    description: true,
    icon: true,
    defaultModel: true,
    createdAt: true,
    updatedAt: true,
} as const;

/** A workspace row as returned by this repository. */
export type WorkspaceRecord = {
    id: string;
    title: string;
    description: string | null;
    icon: string | null;
    defaultModel: string;
    createdAt: Date;
    updatedAt: Date;
};

/** Data access for workspaces (Postgres). */
export class WorkspaceRepository {
    /**
     * Finds all workspaces owned by a user, most recently updated first.
     *
     * @param userId - Owner's user id
     */
    static findAllByUserId(userId: string) {
        return prisma.workspace.findMany({
            where: { userId },
            select: workspaceSelect,
            orderBy: { updatedAt: "desc" },
        });
    }

    /**
     * Finds a workspace only if it is owned by the given user.
     *
     * @param workspaceId - Workspace id
     * @param userId - Required owner
     * @returns The workspace, or `null` when missing or owned by someone else
     */
    static findByIdAndUserId(workspaceId: string, userId: string) {
        return prisma.workspace.findFirst({
            where: { id: workspaceId, userId },
            select: workspaceSelect,
        });
    }

    /**
     * Inserts a workspace for a user.
     *
     * @param userId - Owner's user id
     * @param data - Validated workspace fields
     * @returns The created workspace
     */
    static create(userId: string, data: CreateWorkspaceInput) {
        return prisma.workspace.create({
            data: {
                userId,
                ...data,
            },
            select: workspaceSelect,
        });
    }

    /**
     * Updates workspace fields.
     *
     * @param workspaceId - Workspace to update
     * @param data - Fields to change
     * @returns The updated workspace
     */
    static update(workspaceId: string, data: UpdateWorkspaceInput) {
        return prisma.workspace.update({
            where: { id: workspaceId },
            data,
            select: workspaceSelect,
        });
    }

    /**
     * Deletes a workspace (child rows are removed by database cascades).
     *
     * @param workspaceId - Workspace to delete
     */
    static async delete(workspaceId: string) {
        await prisma.workspace.delete({
            where: { id: workspaceId },
        });
    }
}
