import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";
import { pageArgs, toPage } from "../../shared/http/pagination.js";
import type { ListArtifactsQuery } from "./artifact.validator.js";

/** Columns returned for every artifact query. */
export const artifactSelect = {
    id: true,
    workspaceId: true,
    type: true,
    title: true,
    content: true,
    sourceIds: true,
    status: true,
    metadata: true,
    viewedAt: true,
    createdAt: true,
    updatedAt: true,
} as const;

/** An artifact row as returned by this repository. */
export type ArtifactRecord = Prisma.LearningArtifactGetPayload<{
    select: typeof artifactSelect;
}>;

/** Fields needed to insert an artifact; `status` defaults to `PENDING`. */
export type CreateArtifactData = {
    workspaceId: string;
    type: ArtifactRecord["type"];
    title: string;
    sourceIds: string[];
    status?: ArtifactRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

/** Fields that can change after creation (generation progress and results). */
export type UpdateArtifactData = {
    title?: string;
    content?: Prisma.InputJsonValue;
    status?: ArtifactRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

/** Data access for learning artifacts (Postgres). */
export class ArtifactRepository {
    /**
     * Finds all artifacts in a workspace, newest first.
     *
     * @param workspaceId - Owning workspace
     */
    static findAllByWorkspaceId(workspaceId: string) {
        return prisma.learningArtifact.findMany({
            where: { workspaceId },
            select: artifactSelect,
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * One page of a workspace's artifacts (newest first), with the total across all pages.
     *
     * Without `limit` the whole list comes back as a single page.
     *
     * @param workspaceId - Owning workspace
     * @param query - Optional `q` (title), `type` and `status` filters plus `limit` and `cursor`
     */
    static async findPage(workspaceId: string, query: ListArtifactsQuery = {}) {
        const where = {
            workspaceId,
            ...(query.q ? { title: { contains: query.q, mode: "insensitive" as const } } : {}),
            ...(query.type ? { type: query.type } : {}),
            ...(query.status ? { status: query.status } : {}),
        };

        const [rows, total] = await Promise.all([
            prisma.learningArtifact.findMany({
                where,
                select: artifactSelect,
                // `id` breaks ties so a cursor always lands on one exact row.
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                ...pageArgs(query),
            }),
            prisma.learningArtifact.count({ where }),
        ]);

        return toPage(rows, total, query);
    }

    /**
     * Finds the given artifacts that belong to a workspace (ids from elsewhere are ignored).
     *
     * @param workspaceId - Owning workspace
     * @param artifactIds - Ids to look up
     */
    static findManyByIds(workspaceId: string, artifactIds: string[]) {
        return prisma.learningArtifact.findMany({
            where: { workspaceId, id: { in: artifactIds } },
            select: { id: true },
        });
    }

    /**
     * Records the first time an artifact was opened; later calls change nothing.
     *
     * @param artifactId - Artifact that was opened
     */
    static async markViewed(artifactId: string) {
        await prisma.learningArtifact.updateMany({
            where: { id: artifactId, viewedAt: null },
            data: { viewedAt: new Date() },
        });
    }

    /**
     * Finds an artifact by id regardless of workspace (used by the background worker).
     *
     * @param artifactId - Artifact id
     * @returns The artifact, or `null` when it doesn't exist
     */
    static findById(artifactId: string) {
        return prisma.learningArtifact.findUnique({
            where: { id: artifactId },
            select: artifactSelect,
        });
    }

    /**
     * Finds an artifact only if it belongs to the given workspace.
     *
     * @param artifactId - Artifact id
     * @param workspaceId - Workspace the artifact must belong to
     * @returns The artifact, or `null` when not found in that workspace
     */
    static findByIdAndWorkspaceId(artifactId: string, workspaceId: string) {
        return prisma.learningArtifact.findFirst({
            where: { id: artifactId, workspaceId },
            select: artifactSelect,
        });
    }

    /**
     * Inserts a new artifact.
     *
     * @param data - Artifact fields
     * @returns The created artifact
     */
    static create(data: CreateArtifactData) {
        return prisma.learningArtifact.create({
            data: {
                workspaceId: data.workspaceId,
                type: data.type,
                title: data.title,
                sourceIds: data.sourceIds,
                status: data.status ?? "PENDING",
                metadata: data.metadata,
            },
            select: artifactSelect,
        });
    }

    /**
     * Updates an artifact's title, content, status or metadata.
     *
     * @param artifactId - Artifact to update
     * @param data - Fields to change
     * @returns The updated artifact
     */
    static update(artifactId: string, data: UpdateArtifactData) {
        return prisma.learningArtifact.update({
            where: { id: artifactId },
            data,
            select: artifactSelect,
        });
    }

    /**
     * Updates an artifact only if it is still exactly as the caller last read it, in one atomic
     * statement (compare-and-set): `updatedAt` must match and the artifact must be `READY`.
     * Nothing is written otherwise.
     *
     * @param artifactId - Artifact to update
     * @param workspaceId - Workspace it must belong to
     * @param expectedUpdatedAt - The `updatedAt` the caller read
     * @param data - Fields to change
     * @returns The updated artifact, or `null` when it changed, left `READY`, or no longer exists
     */
    static async updateIfCurrent(
        artifactId: string,
        workspaceId: string,
        expectedUpdatedAt: Date,
        data: UpdateArtifactData,
    ) {
        const { count } = await prisma.learningArtifact.updateMany({
            where: { id: artifactId, workspaceId, updatedAt: expectedUpdatedAt, status: "READY" },
            data,
        });

        return count === 1 ? this.findByIdAndWorkspaceId(artifactId, workspaceId) : null;
    }

    /**
     * Moves an artifact back to `PENDING` for regeneration, only if it is still as the caller
     * read it and is not already queued or running (one atomic compare-and-set). Its content
     * and title are kept until the new content replaces them.
     *
     * @param artifactId - Artifact to regenerate
     * @param workspaceId - Workspace it must belong to
     * @param expectedUpdatedAt - The `updatedAt` the caller read
     * @param metadata - Metadata to store (without the previous failure message)
     * @returns The artifact, or `null` when it changed, is already generating, or is gone
     */
    static async markPendingIfIdle(
        artifactId: string,
        workspaceId: string,
        expectedUpdatedAt: Date,
        metadata: Prisma.InputJsonValue,
    ) {
        const { count } = await prisma.learningArtifact.updateMany({
            where: {
                id: artifactId,
                workspaceId,
                updatedAt: expectedUpdatedAt,
                status: { in: ["READY", "FAILED"] },
            },
            data: { status: "PENDING", metadata },
        });

        return count === 1 ? this.findByIdAndWorkspaceId(artifactId, workspaceId) : null;
    }

    /**
     * Deletes an artifact.
     *
     * @param artifactId - Artifact to delete
     */
    static async delete(artifactId: string) {
        await prisma.learningArtifact.delete({
            where: { id: artifactId },
        });
    }
}
