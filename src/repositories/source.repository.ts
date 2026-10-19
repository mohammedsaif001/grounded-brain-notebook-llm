import { Prisma } from "../generated/prisma/client.js";
import prisma from "../lib/db.js";
import type { ListSourcesQuery } from "../validators/source.validator.js";

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

export type SourceRecord = Prisma.SourceGetPayload<{
    select: typeof sourceSelect;
}>;

/** Same as {@link sourceSelect} minus `content`, which can be megabytes per source. */
export const sourceSummarySelect = {
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

export type SourceSummaryRecord = Prisma.SourceGetPayload<{
    select: typeof sourceSummarySelect;
}>;

export type CreateSourceData = {
    workspaceId: string;
    type: SourceRecord["type"];
    title: string;
    content?: string | null;
    url?: string | null;
    status?: SourceRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

export type UpdateSourceData = {
    content?: string | null;
    status?: SourceRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

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
    /** Lists sources without their `content`; use for listings and status checks. */
    static findAllByWorkspaceId(workspaceId: string, filters: ListSourcesQuery = {}) {
        return prisma.source.findMany({
            where: buildSourcesWhere(workspaceId, filters),
            select: sourceSummarySelect,
            orderBy: { createdAt: "desc" },
        });
    }

    /** Lists sources including full `content`; only for callers that need the text. */
    static findAllWithContentByWorkspaceId(
        workspaceId: string,
        filters: ListSourcesQuery = {},
    ) {
        return prisma.source.findMany({
            where: buildSourcesWhere(workspaceId, filters),
            select: sourceSelect,
            orderBy: { createdAt: "desc" },
        });
    }

    static findById(sourceId: string) {
        return prisma.source.findUnique({
            where: { id: sourceId },
            select: sourceSelect,
        });
    }

    static findByIdAndWorkspaceId(sourceId: string, workspaceId: string) {
        return prisma.source.findFirst({
            where: { id: sourceId, workspaceId },
            select: sourceSelect,
        });
    }

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

    static update(sourceId: string, data: UpdateSourceData) {
        return prisma.source.update({
            where: { id: sourceId },
            data,
            select: sourceSelect,
        });
    }

    static async delete(sourceId: string) {
        await prisma.source.delete({
            where: { id: sourceId },
        });
    }
}
