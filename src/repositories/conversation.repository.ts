import type { Prisma } from "../generated/prisma/client.js";
import prisma from "../lib/db.js";

export const conversationSelect = {
    id: true,
    workspaceId: true,
    title: true,
    summary: true,
    summaryMessageCount: true,
    summarizedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

export type ConversationRecord = Prisma.ConversationGetPayload<{
    select: typeof conversationSelect;
}>;

/** Data access for conversations (Postgres). */
export class ConversationRepository {
    static findAllByWorkspaceId(workspaceId: string) {
        return prisma.conversation.findMany({
            where: { workspaceId },
            select: conversationSelect,
            orderBy: { updatedAt: "desc" },
        });
    }

    static findById(conversationId: string) {
        return prisma.conversation.findUnique({
            where: { id: conversationId },
            select: conversationSelect,
        });
    }

    static findByIdAndWorkspaceId(conversationId: string, workspaceId: string) {
        return prisma.conversation.findFirst({
            where: { id: conversationId, workspaceId },
            select: conversationSelect,
        });
    }

    static create(workspaceId: string, title?: string) {
        return prisma.conversation.create({
            data: {
                workspaceId,
                title: title ?? null,
            },
            select: conversationSelect,
        });
    }

    static update(conversationId: string, data: { title?: string | null }) {
        return prisma.conversation.update({
            where: { id: conversationId },
            data,
            select: conversationSelect,
        });
    }

    static updateSummary(
        conversationId: string,
        data: {
            summary: string;
            summaryMessageCount: number;
        },
    ) {
        return prisma.conversation.update({
            where: { id: conversationId },
            data: {
                summary: data.summary,
                summaryMessageCount: data.summaryMessageCount,
                summarizedAt: new Date(),
            },
            select: conversationSelect,
        });
    }

    /** Bumps `updatedAt` so the conversation sorts to the top of the sidebar. */
    static touch(conversationId: string) {
        return prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
            select: conversationSelect,
        });
    }

    static async delete(conversationId: string) {
        await prisma.conversation.delete({
            where: { id: conversationId },
        });
    }
}
