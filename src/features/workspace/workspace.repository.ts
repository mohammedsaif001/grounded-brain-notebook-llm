import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";
import type {
    CreateWorkspaceInput,
    ListWorkspacesQuery,
    UpdateWorkspaceInput,
} from "./workspace.validator.js";

/** Columns returned for every workspace query. */
const workspaceSelect = {
    id: true,
    title: true,
    description: true,
    icon: true,
    defaultModel: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { sources: true, artifacts: true } },
} as const;

/** A workspace row as returned by this repository, with its item counts. */
export type WorkspaceRecord = {
    id: string;
    title: string;
    description: string | null;
    icon: string | null;
    defaultModel: string;
    createdAt: Date;
    updatedAt: Date;
    /** All sources in the notebook, whatever their status. */
    sourceCount: number;
    /** All learning artifacts (study guides) in the notebook. */
    artifactCount: number;
};

/**
 * Flattens Prisma's `_count` into `sourceCount` and `artifactCount`.
 *
 * @param row - A workspace selected with {@link workspaceSelect}
 */
function toRecord<T extends { _count: { sources: number; artifacts: number } }>(row: T) {
    const { _count, ...rest } = row;
    return { ...rest, sourceCount: _count.sources, artifactCount: _count.artifacts };
}

/** Data access for workspaces (Postgres). */
export class WorkspaceRepository {
    /**
     * Finds workspaces owned by a user, searched and sorted on the server.
     *
     * @param userId - Owner's user id
     * @param query - Optional `q` (title or description, case-insensitive), `sort` and `order`
     * @returns Matching workspaces; most recently updated first by default
     */
    static async findAllByUserId(userId: string, query: Partial<ListWorkspacesQuery> = {}) {
        const sort = query.sort ?? "updatedAt";
        const order = query.order ?? (sort === "title" ? "asc" : "desc");

        const where: Prisma.WorkspaceWhereInput = { userId };
        if (query.q) {
            where.OR = [
                { title: { contains: query.q, mode: "insensitive" } },
                { description: { contains: query.q, mode: "insensitive" } },
            ];
        }

        const rows = await prisma.workspace.findMany({
            where,
            select: workspaceSelect,
            // `id` keeps the order stable when titles or timestamps tie.
            orderBy: [{ [sort]: order }, { id: "asc" }],
        });

        return rows.map(toRecord);
    }

    /**
     * Finds a workspace only if it is owned by the given user.
     *
     * @param workspaceId - Workspace id
     * @param userId - Required owner
     * @returns The workspace, or `null` when missing or owned by someone else
     */
    static async findByIdAndUserId(workspaceId: string, userId: string) {
        const row = await prisma.workspace.findFirst({
            where: { id: workspaceId, userId },
            select: workspaceSelect,
        });

        return row ? toRecord(row) : null;
    }

    /**
     * Inserts a workspace for a user.
     *
     * @param userId - Owner's user id
     * @param data - Validated workspace fields
     * @returns The created workspace
     */
    static async create(userId: string, data: CreateWorkspaceInput) {
        const row = await prisma.workspace.create({
            data: {
                userId,
                ...data,
            },
            select: workspaceSelect,
        });

        return toRecord(row);
    }

    /**
     * Updates workspace fields.
     *
     * @param workspaceId - Workspace to update
     * @param data - Fields to change
     * @returns The updated workspace
     */
    static async update(workspaceId: string, data: UpdateWorkspaceInput) {
        const row = await prisma.workspace.update({
            where: { id: workspaceId },
            data,
            select: workspaceSelect,
        });

        return toRecord(row);
    }

    /**
     * Counts what the sidebar needs for one workspace: sources, ready sources, artifacts still
     * generating, and finished artifacts the user has not opened yet.
     *
     * @param workspaceId - Workspace to summarise
     */
    static async summary(workspaceId: string) {
        const [sourceCount, readySourceCount, processingArtifactCount, unseenArtifactCount] =
            await Promise.all([
                prisma.source.count({ where: { workspaceId } }),
                prisma.source.count({ where: { workspaceId, status: "READY" } }),
                prisma.learningArtifact.count({
                    where: { workspaceId, status: { in: ["PENDING", "PROCESSING"] } },
                }),
                prisma.learningArtifact.count({
                    where: { workspaceId, status: "READY", viewedAt: null },
                }),
            ]);

        return { sourceCount, readySourceCount, processingArtifactCount, unseenArtifactCount };
    }

    /**
     * Deletes a workspace (child rows are removed by database cascades).
     *
     * @param workspaceId - Workspace to delete
     */
    static async delete(workspaceId: string) {
        await prisma.workspace.delete({
            where: { id: workspaceId },
        });
    }
}
