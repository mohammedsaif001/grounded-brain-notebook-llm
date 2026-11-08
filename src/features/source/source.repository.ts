import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";
import { pageArgs, toPage } from "../../shared/http/pagination.js";
import type { ListSourcesQuery } from "./source.validator.js";

/** Columns returned for a full source, including its (possibly large) `content`. */
export const sourceSelect = {
    id: true,
    workspaceId: true,
    type: true,
    title: true,
    content: true,
    url: true,
    status: true,
    metadata: true,
    createdAt: true,
    updatedAt: true,
} as const;

/** A source row including `content`. */
export type SourceRecord = Prisma.SourceGetPayload<{
    select: typeof sourceSelect;
}>;

/** Same as {@link sourceSelect} minus `content`, which can be megabytes per source. */
const sourceSummarySelect = {
    id: true,
    workspaceId: true,
    type: true,
    title: true,
    url: true,
    status: true,
    metadata: true,
    createdAt: true,
    updatedAt: true,
} as const;

/** A source row without `content`, used for listings. */
export type SourceSummaryRecord = Prisma.SourceGetPayload<{
    select: typeof sourceSummarySelect;
}>;

/** Fields needed to insert a source; `status` defaults to `PENDING`. */
export type CreateSourceData = {
    workspaceId: string;
    type: SourceRecord["type"];
    title: string;
    content?: string | null;
    url?: string | null;
    status?: SourceRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

/** Fields that change during processing or when the user edits a source. */
export type UpdateSourceData = {
    title?: string;
    content?: string | null;
    status?: SourceRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

/**
 * Builds the Prisma filter for listing sources.
 *
 * @param workspaceId - Workspace to restrict to
 * @param filters - Optional `type`, `status` and case-insensitive `q` (matches title or content)
 * @returns A `where` clause for `prisma.source.findMany`
 */
function buildSourcesWhere(workspaceId: string, filters: ListSourcesQuery) {
    const where: Prisma.SourceWhereInput = {
        workspaceId,
    };

    if (filters.type) {
        where.type = filters.type;
    }

    if (filters.status) {
        where.status = filters.status;
    }

    if (filters.q) {
        where.OR = [
            {
                title: {
                    contains: filters.q,
                    mode: "insensitive",
                },
            },
            {
                content: {
                    contains: filters.q,
                    mode: "insensitive",
                },
            },
        ];
    }

    return where;
}

/** Data access for workspace sources (Postgres). */
export class SourceRepository {
    /**
     * Lists sources without their `content`; use for listings and status checks.
     *
     * @param workspaceId - Owning workspace
     * @param filters - Optional list filters
     * @returns Sources, newest first
     */
    static findAllByWorkspaceId(workspaceId: string, filters: ListSourcesQuery = {}) {
        return prisma.source.findMany({
            where: buildSourcesWhere(workspaceId, filters),
            select: sourceSummarySelect,
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * One page of sources without `content`, with the total across all pages.
     *
     * Without `limit` the whole list comes back as a single page.
     *
     * @param workspaceId - Owning workspace
     * @param filters - Optional list filters plus `limit` and `cursor`
     * @returns Sources newest first, the total matching, and the cursor of the next page
     */
    static async findPage(workspaceId: string, filters: ListSourcesQuery = {}) {
        const where = buildSourcesWhere(workspaceId, filters);

        const [rows, total] = await Promise.all([
            prisma.source.findMany({
                where,
                select: sourceSummarySelect,
                // `id` breaks ties so a cursor always lands on one exact row.
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                ...pageArgs(filters),
            }),
            prisma.source.count({ where }),
        ]);

        return toPage(rows, total, filters);
    }

    /**
     * Finds the given sources that belong to a workspace (ids from elsewhere are ignored).
     *
     * @param workspaceId - Owning workspace
     * @param sourceIds - Ids to look up
     */
    static findManyByIds(workspaceId: string, sourceIds: string[]) {
        return prisma.source.findMany({
            where: { workspaceId, id: { in: sourceIds } },
            select: sourceSummarySelect,
        });
    }

    /**
     * Lists sources including full `content`; only for callers that need the text.
     *
     * @param workspaceId - Owning workspace
     * @param filters - Optional list filters
     * @returns Sources with content, newest first
     */
    static findAllWithContentByWorkspaceId(workspaceId: string, filters: ListSourcesQuery = {}) {
        return prisma.source.findMany({
            where: buildSourcesWhere(workspaceId, filters),
            select: sourceSelect,
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * Finds a source by id regardless of workspace (used by background jobs).
     *
     * @param sourceId - Source id
     * @returns The source, or `null` when missing
     */
    static findById(sourceId: string) {
        return prisma.source.findUnique({
            where: { id: sourceId },
            select: sourceSelect,
        });
    }

    /**
     * Finds a source only if it belongs to the given workspace.
     *
     * @param sourceId - Source id
     * @param workspaceId - Workspace it must belong to
     * @returns The source, or `null` when not found in that workspace
     */
    static findByIdAndWorkspaceId(sourceId: string, workspaceId: string) {
        return prisma.source.findFirst({
            where: { id: sourceId, workspaceId },
            select: sourceSelect,
        });
    }

    /**
     * Inserts a source.
     *
     * @param data - Source fields
     * @returns The created source
     */
    static create(data: CreateSourceData) {
        return prisma.source.create({
            data: {
                workspaceId: data.workspaceId,
                type: data.type,
                title: data.title,
                content: data.content ?? null,
                url: data.url ?? null,
                status: data.status ?? "PENDING",
                metadata: data.metadata,
            },
            select: sourceSelect,
        });
    }

    /**
     * Updates a source's content, status or metadata.
     *
     * @param sourceId - Source to update
     * @param data - Fields to change
     * @returns The updated source
     */
    static update(sourceId: string, data: UpdateSourceData) {
        return prisma.source.update({
            where: { id: sourceId },
            data,
            select: sourceSelect,
        });
    }

    /**
     * Updates a source only if it is still exactly as the caller last read it, in one atomic
     * statement (compare-and-set): `updatedAt` must match and the source must not be queued or
     * running. Nothing is written otherwise.
     *
     * @param sourceId - Source to update
     * @param workspaceId - Workspace it must belong to
     * @param expectedUpdatedAt - The `updatedAt` the caller read
     * @param data - Fields to change
     * @returns The updated source, or `null` when it changed, is processing, or no longer exists
     */
    static async updateIfCurrent(
        sourceId: string,
        workspaceId: string,
        expectedUpdatedAt: Date,
        data: UpdateSourceData,
    ) {
        const { count } = await prisma.source.updateMany({
            where: {
                id: sourceId,
                workspaceId,
                updatedAt: expectedUpdatedAt,
                status: { notIn: ["PENDING", "PROCESSING"] },
            },
            data,
        });

        return count === 1 ? this.findByIdAndWorkspaceId(sourceId, workspaceId) : null;
    }

    /**
     * Deletes a source (its chunks are removed by database cascade).
     *
     * @param sourceId - Source to delete
     */
    static async delete(sourceId: string) {
        await prisma.source.delete({
            where: { id: sourceId },
        });
    }
}
