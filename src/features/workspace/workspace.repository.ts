import prisma from "../../config/db.js";
import type {
    CreateWorkspaceInput,
    UpdateWorkspaceInput,
} from "./workspace.validator.js";

export const workspaceSelect = {
    id: true,
    title: true,
    description: true,
    icon: true,
    defaultModel: true,
    createdAt: true,
    updatedAt: true,
} as const;

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
    static findAllByUserId(userId: string) {
        return prisma.workspace.findMany({
            where: { userId },
            select: workspaceSelect,
            orderBy: { updatedAt: "desc" },
        });
    }

    static findByIdAndUserId(workspaceId: string, userId: string) {
        return prisma.workspace.findFirst({
            where: { id: workspaceId, userId },
            select: workspaceSelect,
        });
    }

    static create(userId: string, data: CreateWorkspaceInput) {
        return prisma.workspace.create({
            data: {
                userId,
                ...data,
            },
            select: workspaceSelect,
        });
    }

    static update(workspaceId: string, data: UpdateWorkspaceInput) {
        return prisma.workspace.update({
            where: { id: workspaceId },
            data,
            select: workspaceSelect,
        });
    }

    static async delete(workspaceId: string) {
        await prisma.workspace.delete({
            where: { id: workspaceId },
        });
    }
}
