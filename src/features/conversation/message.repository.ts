import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

/** Columns returned for every message query. */
const messageSelect = {
    id: true,
    conversationId: true,
    role: true,
    content: true,
    citations: true,
    blocked: true,
    createdAt: true,
} as const;

/** A message row as returned by this repository. */
export type MessageRecord = Prisma.MessageGetPayload<{
    select: typeof messageSelect;
}>;

/** Fields needed to insert a message; `citations` holds the sources/web results it referenced. */
export type CreateMessageData = {
    conversationId: string;
    role: MessageRecord["role"];
    content: string;
    citations?: Prisma.InputJsonValue;
    /** Marks a guard-blocked message or refusal; excluded from model context. */
    blocked?: boolean;
};

/** Data access for chat messages (Postgres). */
export class MessageRepository {
    /**
     * Returns every message in a conversation, oldest first.
     *
     * @param conversationId - Conversation to read
     */
    static findAllByConversationId(conversationId: string) {
        return prisma.message.findMany({
            where: { conversationId },
            select: messageSelect,
            orderBy: { createdAt: "asc" },
        });
    }

    /**
     * Returns the latest `limit` non-blocked messages, oldest first. Used as model context,
     * so guard-blocked messages and their refusals are left out.
     *
     * @param conversationId - Conversation to read
     * @param limit - Maximum number of messages
     */
    static async findRecentByConversationId(conversationId: string, limit: number) {
        const messages = await prisma.message.findMany({
            where: { conversationId, blocked: false },
            select: messageSelect,
            orderBy: { createdAt: "desc" },
            take: limit,
        });

        return messages.reverse();
    }

    /**
     * Counts messages in a conversation.
     *
     * @param conversationId - Conversation to count
     */
    static countByConversationId(conversationId: string) {
        return prisma.message.count({
            where: { conversationId },
        });
    }

    /**
     * Inserts a message.
     *
     * @param data - Message fields
     * @returns The created message
     */
    static create(data: CreateMessageData) {
        return prisma.message.create({
            data: {
                conversationId: data.conversationId,
                role: data.role,
                content: data.content,
                citations: data.citations,
                blocked: data.blocked ?? false,
            },
            select: messageSelect,
        });
    }

    /**
     * Flags a message as guard-blocked so it is excluded from model context.
     *
     * @param messageId - Message to flag
     */
    static async markBlocked(messageId: string) {
        await prisma.message.update({
            where: { id: messageId },
            data: { blocked: true },
        });
    }
}
