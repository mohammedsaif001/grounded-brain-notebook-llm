import type { Prisma } from "../../generated/prisma/client.js";
import prisma from "../../config/db.js";

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
