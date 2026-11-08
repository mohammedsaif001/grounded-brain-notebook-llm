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
    excluded: true,
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
     * Finds one chunk, only if it belongs to the given source.
     *
     * @param chunkId - Chunk id
     * @param sourceId - Source it must belong to
     * @returns The chunk, or `null` when not found in that source
     */
    static findByIdAndSourceId(chunkId: string, sourceId: string) {
        return prisma.sourceChunk.findFirst({
            where: { id: chunkId, sourceId },
            select: sourceChunkSelect,
        });
    }

    /**
     * Flags a chunk as excluded from (or included in) retrieval and artifact generation.
     *
     * @param chunkId - Chunk to update
     * @param excluded - New flag value
     * @returns The updated chunk
     */
    static setExcluded(chunkId: string, excluded: boolean) {
        return prisma.sourceChunk.update({
            where: { id: chunkId },
            data: { excluded },
            select: sourceChunkSelect,
        });
    }

    /**
     * Finds which of the given sources have at least one excluded chunk.
     *
     * @param sourceIds - Sources to check
     * @returns The ids of sources that have excluded chunks
     */
    static async findSourceIdsWithExcluded(sourceIds: string[]) {
        const rows = await prisma.sourceChunk.findMany({
            where: { sourceId: { in: sourceIds }, excluded: true },
            select: { sourceId: true },
            distinct: ["sourceId"],
        });
        return rows.map((row) => row.sourceId);
    }

    /**
     * Returns a source's chunks that are not excluded, in order.
     *
     * @param sourceId - Source whose chunks to read
     */
    static findIncludedBySourceId(sourceId: string) {
        return prisma.sourceChunk.findMany({
            where: { sourceId, excluded: false },
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
