import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

const messageSelect = {
    id: true,
    conversationId: true,
    role: true,
    content: true,
    citations: true,
    createdAt: true,
} as const;

export type MessageRecord = Prisma.MessageGetPayload<{
    select: typeof messageSelect;
}>;

export type CreateMessageData = {
    conversationId: string;
    role: MessageRecord["role"];
    content: string;
    citations?: Prisma.InputJsonValue;
};

/** Data access for chat messages (Postgres). */
export class MessageRepository {
    static findAllByConversationId(conversationId: string) {
        return prisma.message.findMany({
            where: { conversationId },
            select: messageSelect,
            orderBy: { createdAt: "asc" },
        });
    }

    /** Returns the latest `limit` messages, oldest first. */
    static async findRecentByConversationId(conversationId: string, limit: number) {
        const messages = await prisma.message.findMany({
            where: { conversationId },
            select: messageSelect,
            orderBy: { createdAt: "desc" },
            take: limit,
        });

        return messages.reverse();
    }

    static countByConversationId(conversationId: string) {
        return prisma.message.count({
            where: { conversationId },
        });
    }

    static create(data: CreateMessageData) {
        return prisma.message.create({
            data: {
                conversationId: data.conversationId,
                role: data.role,
                content: data.content,
                citations: data.citations,
            },
            select: messageSelect,
        });
    }
}
