import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

/** Columns returned for every conversation query. */
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

/** A conversation row as returned by this repository. */
export type ConversationRecord = Prisma.ConversationGetPayload<{
    select: typeof conversationSelect;
}>;

/** Data access for conversations (Postgres). */
export class ConversationRepository {
    /**
     * Finds all conversations in a workspace, most recently updated first.
     *
     * @param workspaceId - Owning workspace
     */
    static findAllByWorkspaceId(workspaceId: string) {
        return prisma.conversation.findMany({
            where: { workspaceId },
            select: conversationSelect,
            orderBy: { updatedAt: "desc" },
        });
    }

    /**
     * Finds a conversation by id regardless of workspace (used by background jobs).
     *
     * @param conversationId - Conversation id
     * @returns The conversation, or `null` when missing
     */
    static findById(conversationId: string) {
        return prisma.conversation.findUnique({
            where: { id: conversationId },
            select: conversationSelect,
        });
    }

    /**
     * Finds a conversation only if it belongs to the given workspace.
     *
     * @param conversationId - Conversation id
     * @param workspaceId - Workspace it must belong to
     * @returns The conversation, or `null` when not found in that workspace
     */
    static findByIdAndWorkspaceId(conversationId: string, workspaceId: string) {
        return prisma.conversation.findFirst({
            where: { id: conversationId, workspaceId },
            select: conversationSelect,
        });
    }

    /**
     * Inserts a conversation.
     *
     * @param workspaceId - Owning workspace
     * @param title - Optional title; stored as `null` when omitted
     */
    static create(workspaceId: string, title?: string) {
        return prisma.conversation.create({
            data: {
                workspaceId,
                title: title ?? null,
            },
            select: conversationSelect,
        });
    }

    /**
     * Updates a conversation's title.
     *
     * @param conversationId - Conversation to update
     * @param data.title - New title, or `null` to clear it
     */
    static update(conversationId: string, data: { title?: string | null }) {
        return prisma.conversation.update({
            where: { id: conversationId },
            data,
            select: conversationSelect,
        });
    }

    /**
     * Stores a new rolling summary and records how many messages it covers.
     *
     * @param conversationId - Conversation to update
     * @param data.summary - Summary text
     * @param data.summaryMessageCount - Number of messages summarised so far
     * @returns The updated conversation (`summarizedAt` set to now)
     */
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

    /**
     * Bumps `updatedAt` so the conversation sorts to the top of the sidebar.
     *
     * @param conversationId - Conversation to touch
     */
    static touch(conversationId: string) {
        return prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
            select: conversationSelect,
        });
    }

    /**
     * Deletes a conversation (its messages are removed by database cascade).
     *
     * @param conversationId - Conversation to delete
     */
    static async delete(conversationId: string) {
        await prisma.conversation.delete({
            where: { id: conversationId },
        });
    }
}
