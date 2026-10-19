import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

export const sourceChunkSelect = {
    id: true,
    sourceId: true,
    index: true,
    content: true,
    tokenCount: true,
    metadata: true,
    createdAt: true,
} as const;

export type SourceChunkRecord = Prisma.SourceChunkGetPayload<{
    select: typeof sourceChunkSelect;
}>;

export type CreateSourceChunkData = {
    sourceId: string;
    index: number;
    content: string;
    tokenCount?: number | null;
    metadata?: Prisma.InputJsonValue;
};

/** Data access for source chunks (Postgres). */
export class SourceChunkRepository {
    static findAllBySourceId(sourceId: string) {
        return prisma.sourceChunk.findMany({
            where: { sourceId },
            select: sourceChunkSelect,
            orderBy: { index: "asc" },
        });
    }

    static createMany(chunks: CreateSourceChunkData[]) {
        if (chunks.length === 0) {
            return Promise.resolve([]);
        }

        return prisma.$transaction(
            chunks.map((chunk) =>
                prisma.sourceChunk.create({
                    data: {
                        sourceId: chunk.sourceId,
                        index: chunk.index,
                        content: chunk.content,
                        tokenCount: chunk.tokenCount ?? null,
                        metadata: chunk.metadata,
                    },
                    select: sourceChunkSelect,
                }),
            ),
        );
    }

    static deleteAllBySourceId(sourceId: string) {
        return prisma.sourceChunk.deleteMany({
            where: { sourceId },
        });
    }
}
