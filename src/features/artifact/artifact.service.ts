import { EventPublisher } from "../../jobs/events.js";
import { ArtifactRepository, type ArtifactRecord } from "./artifact.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import type { CreateArtifactInput } from "./artifact.validator.js";
import { ArtifactGenerationService } from "./artifact-generation.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";

/** Default artifact titles by type, used when the client doesn't send one. */
const DEFAULT_ARTIFACT_TITLES: Record<ArtifactRecord["type"], string> = {
    SUMMARY: "Summary",
    TAKEAWAYS: "Key Takeaways",
    FLASHCARDS: "Flashcards",
    QUIZ: "Quiz",
    MINDMAP: "Mind Map",
    REPORT: "AI Report",
};

/** Learning artifact business logic: CRUD plus the background generation entry point. */
export class ArtifactService {
    /** Lists artifacts in a workspace, newest first. */
    static async list(workspaceId: string, userId: string) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return ArtifactRepository.findAllByWorkspaceId(workspaceId);
    }

    /**
     * Loads a single artifact after verifying workspace ownership.
     *
     * @throws {APIError} NotFound when the artifact does not exist in this workspace
     */
    static async get(workspaceId: string, artifactId: string, userId: string) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const artifact = await ArtifactRepository.findByIdAndWorkspaceId(artifactId, workspaceId);

        if (!artifact) {
            throw APIError.NotFound("Artifact not found");
        }

        return artifact;
    }

    /**
     * Creates a pending artifact and queues background generation.
     *
     * Validates that ready sources exist before creating the row; the AI work runs
     * asynchronously in {@link ArtifactService.generate}.
     *
     * @returns New artifact with status `PENDING`
     * @throws {APIError} BadRequest when no ready sources are available
     */
    static async create(workspaceId: string, userId: string, input: CreateArtifactInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        // Validate without loading source content; the worker gathers the text.
        const sourceIds = await ArtifactGenerationService.resolveReadySourceIds(
            workspaceId,
            input.sourceIds,
        );

        const artifact = await ArtifactRepository.create({
            workspaceId,
            type: input.type,
            title:
                input.title ||
                `${DEFAULT_ARTIFACT_TITLES[input.type]} · ${new Date().toLocaleDateString()}`,
            sourceIds,
            status: "PENDING",
        });

        await EventPublisher.artifactRequested({
            artifactId: artifact.id,
            workspaceId,
        });

        return artifact;
    }

    /**
     * @throws {APIError} NotFound when the artifact is not found
     */
    static async delete(workspaceId: string, artifactId: string, userId: string) {
        await this.get(workspaceId, artifactId, userId);
        await ArtifactRepository.delete(artifactId);
    }

    /**
     * Runs the full generation pipeline (called by the Inngest worker).
     *
     * ```
     * status: PROCESSING → gatherSourceContext → generateContent → status: READY (or FAILED)
     * ```
     *
     * @throws When the artifact is missing or generation fails (status set to `FAILED`)
     */
    static async generate(artifactId: string) {
        const artifact = await ArtifactRepository.findById(artifactId);
        if (!artifact) {
            throw new Error("Artifact not found");
        }

        await ArtifactRepository.update(artifactId, { status: "PROCESSING" });

        try {
            const context = await ArtifactGenerationService.gatherSourceContext(
                artifact.workspaceId,
                artifact.sourceIds,
            );

            const content = await ArtifactGenerationService.generateContent(
                artifact.type,
                context.text,
            );

            return ArtifactRepository.update(artifactId, {
                status: "READY",
                content,
                metadata: {
                    generatedAt: new Date().toISOString(),
                    processingError: undefined,
                },
            });
        } catch (error) {
            await ArtifactRepository.update(artifactId, {
                status: "FAILED",
                metadata: {
                    processingError:
                        error instanceof Error ? error.message : "Artifact generation failed",
                },
            });

            throw error;
        }
    }
}
