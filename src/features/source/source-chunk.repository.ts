import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

/** Columns returned for every chunk query. */
export const sourceChunkSelect = {
    id: true,
    sourceId: true,
    index: true,
    content: true,
    tokenCount: true,
    metadata: true,
    createdAt: true,
} as const;

/** A chunk row as returned by this repository. */
export type SourceChunkRecord = Prisma.SourceChunkGetPayload<{
    select: typeof sourceChunkSelect;
}>;

/** Fields needed to insert a chunk; `index` is its position within the source. */
export type CreateSourceChunkData = {
    sourceId: string;
    index: number;
    content: string;
    tokenCount?: number | null;
    metadata?: Prisma.InputJsonValue;
};

/** Data access for source chunks (Postgres). */
export class SourceChunkRepository {
    /**
     * Returns every chunk of a source in order.
     *
     * @param sourceId - Source whose chunks to read
     */
    static findAllBySourceId(sourceId: string) {
        return prisma.sourceChunk.findMany({
            where: { sourceId },
            select: sourceChunkSelect,
            orderBy: { index: "asc" },
        });
    }

    /**
     * Inserts chunks in a single transaction.
     *
     * @param chunks - Chunks to insert; an empty array is a no-op
     * @returns The created chunks
     */
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

    /**
     * Deletes every chunk of a source.
     *
     * @param sourceId - Source whose chunks to delete
     */
    static deleteAllBySourceId(sourceId: string) {
        return prisma.sourceChunk.deleteMany({
            where: { sourceId },
        });
    }
}
