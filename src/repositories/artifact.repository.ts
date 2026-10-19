import type { Prisma } from "../generated/prisma/client.js";
import prisma from "../lib/db.js";

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

export type ArtifactRecord = Prisma.LearningArtifactGetPayload<{
    select: typeof artifactSelect;
}>;

export type CreateArtifactData = {
    workspaceId: string;
    type: ArtifactRecord["type"];
    title: string;
    sourceIds: string[];
    status?: ArtifactRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

export type UpdateArtifactData = {
    title?: string;
    content?: Prisma.InputJsonValue;
    status?: ArtifactRecord["status"];
    metadata?: Prisma.InputJsonValue;
};

/** Data access for learning artifacts (Postgres). */
export class ArtifactRepository {
    static findAllByWorkspaceId(workspaceId: string) {
        return prisma.learningArtifact.findMany({
            where: { workspaceId },
            select: artifactSelect,
            orderBy: { createdAt: "desc" },
        });
    }

    static findById(artifactId: string) {
        return prisma.learningArtifact.findUnique({
            where: { id: artifactId },
            select: artifactSelect,
        });
    }

    static findByIdAndWorkspaceId(artifactId: string, workspaceId: string) {
        return prisma.learningArtifact.findFirst({
            where: { id: artifactId, workspaceId },
            select: artifactSelect,
        });
    }

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

    static update(artifactId: string, data: UpdateArtifactData) {
        return prisma.learningArtifact.update({
            where: { id: artifactId },
            data,
            select: artifactSelect,
        });
    }

    static async delete(artifactId: string) {
        await prisma.learningArtifact.delete({
            where: { id: artifactId },
        });
    }
}
