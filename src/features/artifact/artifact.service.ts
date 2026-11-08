import { EventPublisher } from "../../jobs/events.js";
import type { z } from "zod";
import {
    ArtifactRepository,
    type ArtifactRecord,
    type UpdateArtifactData,
} from "./artifact.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import type {
    CreateArtifactInput,
    ListArtifactsQuery,
    RegenerateArtifactInput,
    UpdateArtifactInput,
} from "./artifact.validator.js";
import { artifactContentSchemas } from "./artifact-content.schema.js";
import { ArtifactGenerationService } from "./artifact-generation.service.js";
import { ConversationService } from "../conversation/conversation.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { logger } from "../../config/logger.js";
import type { Prisma } from "../../generated/prisma/client.js";

/** Default artifact titles by type, used when the client doesn't send one. */
const DEFAULT_ARTIFACT_TITLES: Record<ArtifactRecord["type"], string> = {
    SUMMARY: "Summary",
    TAKEAWAYS: "Key Takeaways",
    FLASHCARDS: "Flashcards",
    QUIZ: "Quiz",
    MINDMAP: "Mind Map",
    REPORT: "AI Report",
    WIKI: "Repo Wiki",
};

/**
 * Reads a JSON column as a plain object, tolerating null or malformed values.
 *
 * @param value - Raw JSON column value
 */
function readObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * Turns content validation issues into field-level details, keyed by the dotted path under
 * `content` (e.g. `content.cards.0.front`).
 *
 * @param error - Failed parse of the content against its type's schema
 */
function contentErrors(error: z.ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of error.issues) {
        const key = ["content", ...issue.path.map(String)].join(".");
        (details[key] ??= []).push(issue.message);
    }
    return details;
}

/**
 * Whether a title is still the date-based default given at creation (`Mind Map · 8/11/2026`),
 * as opposed to one the user chose or the model already wrote.
 *
 * @param type - Artifact type
 * @param title - Current title
 */
function isDefaultTitle(type: ArtifactRecord["type"], title: string) {
    return title.startsWith(`${DEFAULT_ARTIFACT_TITLES[type]} \u00b7 `);
}

/** Learning artifact business logic: CRUD plus the background generation entry point. */
export class ArtifactService {
    /**
     * Lists artifacts in a workspace, newest first, one page at a time when `limit` is given.
     *
     * @param workspaceId - Workspace to list from
     * @param userId - Requesting user; must own the workspace
     * @param query - Optional `q` (title), `type` and `status` filters plus `limit` and `cursor`
     * @returns The page of artifacts, the total matching, and the next cursor
     */
    static async list(workspaceId: string, userId: string, query: ListArtifactsQuery = {}) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return ArtifactRepository.findPage(workspaceId, query);
    }

    /**
     * Records that the user opened a finished artifact (clears its "new" state). Safe to repeat.
     *
     * @param workspaceId - Workspace the artifact belongs to
     * @param artifactId - Artifact that was opened
     * @param userId - Requesting user; must own the workspace
     * @throws {APIError} NotFound when the artifact is not found
     */
    static async markViewed(workspaceId: string, artifactId: string, userId: string) {
        await this.get(workspaceId, artifactId, userId);
        await ArtifactRepository.markViewed(artifactId);
    }

    /**
     * Loads a single artifact after verifying workspace ownership.
     *
     * @param workspaceId - Workspace the artifact belongs to
     * @param artifactId - Artifact to load
     * @param userId - Requesting user; must own the workspace
     * @returns The artifact record
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
     * @param workspaceId - Workspace to create the artifact in
     * @param userId - Requesting user; must own the workspace
     * @param input - Artifact type plus optional title and source subset
     * @returns New artifact with status `PENDING`
     * @throws {APIError} BadRequest when no ready sources are available
     */
    static async create(workspaceId: string, userId: string, input: CreateArtifactInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        // Validate without loading source content; the worker gathers the text.
        const fromConversation = input.conversationId
            ? await this.resolveConversation(
                  workspaceId,
                  userId,
                  input.conversationId,
                  input.messageIds,
              )
            : undefined;

        const sourceIds =
            fromConversation?.sourceIds ??
            (await ArtifactGenerationService.resolveReadySourceIds(
                workspaceId,
                input.sourceIds,
                input.type === "WIKI" ? "GITHUB" : undefined,
            ));

        const artifact = await ArtifactRepository.create({
            workspaceId,
            type: input.type,
            title:
                input.title ||
                `${DEFAULT_ARTIFACT_TITLES[input.type]} · ${new Date().toLocaleDateString()}`,
            sourceIds,
            status: "PENDING",
            // Tells the worker to read the conversation instead of the sources.
            ...(fromConversation && {
                metadata: fromConversation.metadata,
            }),
        });

        await EventPublisher.artifactRequested({
            artifactId: artifact.id,
            workspaceId,
        });

        return artifact;
    }

    /**
     * Checks that a conversation can be turned into an artifact and works out what to record.
     *
     * @param workspaceId - Workspace the conversation must belong to
     * @param userId - Requesting user
     * @param conversationId - Conversation to learn from
     * @param messageIds - Optional subset of its messages
     * @returns The ids of the sources the conversation cited, and the metadata for the worker
     * @throws {APIError} NotFound for an unknown conversation, BadRequest for unknown messages
     *   or when there is nothing to learn from
     */
    private static async resolveConversation(
        workspaceId: string,
        userId: string,
        conversationId: string,
        messageIds?: string[],
    ) {
        const messages = await ConversationService.listMessages(
            workspaceId,
            conversationId,
            userId,
        );

        const selected = messageIds?.length
            ? messages.filter((message) => messageIds.includes(message.id))
            : messages;

        if (messageIds?.length && selected.length !== new Set(messageIds).size) {
            throw APIError.BadRequest("Some messageIds do not belong to this conversation");
        }
        if (selected.length === 0) {
            throw APIError.BadRequest("This conversation has no messages to learn from yet");
        }

        // Sources the chosen replies cited, so the artifact lists what it was built from.
        const cited = new Set<string>();
        for (const message of selected) {
            if (Array.isArray(message.citations)) {
                for (const citation of message.citations as { sourceId?: unknown }[]) {
                    if (typeof citation?.sourceId === "string") {
                        cited.add(citation.sourceId);
                    }
                }
            }
        }

        return {
            sourceIds: [...cited],
            metadata: {
                conversationId,
                ...(messageIds?.length ? { messageIds: [...new Set(messageIds)] } : {}),
            } satisfies Prisma.InputJsonObject,
        };
    }

    /**
     * Deletes an artifact after verifying workspace ownership.
     *
     * @param workspaceId - Workspace the artifact belongs to
     * @param artifactId - Artifact to delete
     * @param userId - Requesting user; must own the workspace
     * @throws {APIError} NotFound when the artifact is not found
     */
    static async delete(workspaceId: string, artifactId: string, userId: string) {
        await this.get(workspaceId, artifactId, userId);
        await ArtifactRepository.delete(artifactId);
    }

    /**
     * Edits a finished artifact's title and/or content.
     *
     * Content must match the schema of the artifact's own type (the same shapes generation
     * produces; citations are kept as sent). Editing content marks the artifact
     * `metadata.userEdited` so a later regenerate asks before discarding the changes; renaming
     * alone does not, since a regenerate keeps the title anyway. The write is a single
     * compare-and-set on `updatedAt` and status.
     *
     * @param workspaceId - Workspace the artifact belongs to
     * @param artifactId - Artifact to edit
     * @param userId - Requesting user; must own the workspace
     * @param input - New title and/or content, and the `updatedAt` the client last saw
     * @returns The updated artifact
     * @throws {APIError} NotFound, Conflict unless the artifact is `READY`, Validation (with
     *   per-field details) for invalid content, `CONFLICT` when it changed elsewhere
     */
    static async update(
        workspaceId: string,
        artifactId: string,
        userId: string,
        input: UpdateArtifactInput,
    ) {
        const artifact = await this.get(workspaceId, artifactId, userId);

        if (artifact.status !== "READY") {
            throw APIError.Conflict("Only finished artifacts can be edited");
        }
        if (
            input.expectedUpdatedAt &&
            new Date(input.expectedUpdatedAt).getTime() !== artifact.updatedAt.getTime()
        ) {
            throw APIError.StaleWrite();
        }

        const data: UpdateArtifactData = {};
        if (input.title !== undefined) {
            data.title = input.title;
        }
        if (input.content !== undefined) {
            const parsed = artifactContentSchemas[artifact.type].safeParse(input.content);
            if (!parsed.success) {
                throw APIError.Validation("Invalid artifact content", contentErrors(parsed.error));
            }

            data.content = parsed.data;
            data.metadata = {
                ...readObject(artifact.metadata),
                userEdited: true,
                editedAt: new Date().toISOString(),
            };
        }

        const updated = await ArtifactRepository.updateIfCurrent(
            artifactId,
            workspaceId,
            artifact.updatedAt,
            data,
        );
        if (!updated) {
            throw APIError.StaleWrite();
        }

        return updated;
    }

    /**
     * Re-runs generation for an existing artifact, in place: same id and title, using the
     * sources it was built from (or the workspace's READY sources if none were recorded), or
     * its conversation.
     *
     * The artifact goes back to `PENDING` and is picked up by the worker like a new one. Its old
     * content stays visible until the new content is ready. An artifact the user has edited is
     * only regenerated with `force`, since that discards the edits.
     *
     * @param workspaceId - Workspace the artifact belongs to
     * @param artifactId - Artifact to regenerate
     * @param userId - Requesting user; must own the workspace
     * @param input - `force` confirms discarding the user's edits
     * @returns The artifact with status `PENDING`
     * @throws {APIError} NotFound, Conflict while it is generating or when it changed meanwhile,
     *   `ARTIFACT_EDITED` for an edited artifact without `force`, BadRequest when no ready
     *   sources are left to build it from
     */
    static async regenerate(
        workspaceId: string,
        artifactId: string,
        userId: string,
        input: RegenerateArtifactInput = {},
    ) {
        const artifact = await this.get(workspaceId, artifactId, userId);

        if (artifact.status === "PENDING" || artifact.status === "PROCESSING") {
            throw APIError.Conflict("This artifact is already being generated");
        }

        const { processingError: _cleared, ...metadata } = readObject(artifact.metadata);
        if (metadata.userEdited === true && !input.force) {
            throw APIError.ArtifactEdited();
        }

        // Fail here, not in the worker, when nothing is left to build it from.
        if (typeof metadata.conversationId !== "string") {
            await ArtifactGenerationService.resolveReadySourceIds(
                workspaceId,
                artifact.sourceIds,
                artifact.type === "WIKI" ? "GITHUB" : undefined,
            );
        }

        const queued = await ArtifactRepository.markPendingIfIdle(
            artifactId,
            workspaceId,
            artifact.updatedAt,
            metadata as Prisma.InputJsonObject,
        );
        if (!queued) {
            throw APIError.Conflict(
                "This artifact changed or started generating. Reload and retry.",
            );
        }

        try {
            await EventPublisher.artifactRequested({ artifactId, workspaceId });
        } catch (error) {
            await ArtifactRepository.update(artifactId, { status: "FAILED" });
            throw error;
        }

        return queued;
    }

    /**
     * Deletes several artifacts, one by one, and reports what happened to each.
     *
     * Not atomic by design: a missing id or a failure on one artifact does not stop or undo the
     * others. Ids are de-duplicated, and ids from other workspaces count as `not_found`.
     *
     * @param workspaceId - Workspace the artifacts belong to
     * @param userId - Requesting user; must own the workspace
     * @param artifactIds - Artifacts to delete
     * @returns How many were deleted and a status for every requested id
     */
    static async bulkDelete(workspaceId: string, userId: string, artifactIds: string[]) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const ids = [...new Set(artifactIds)];
        const existing = new Set(
            (await ArtifactRepository.findManyByIds(workspaceId, ids)).map(
                (artifact) => artifact.id,
            ),
        );

        const results: { artifactId: string; status: "deleted" | "not_found" | "failed" }[] = [];
        for (const artifactId of ids) {
            if (!existing.has(artifactId)) {
                results.push({ artifactId, status: "not_found" });
                continue;
            }

            try {
                await ArtifactRepository.delete(artifactId);
                results.push({ artifactId, status: "deleted" });
            } catch (error) {
                logger.warn({ kind: "artifact", artifactId, err: error }, "Bulk delete failed");
                results.push({ artifactId, status: "failed" });
            }
        }

        return {
            deleted: results.filter((result) => result.status === "deleted").length,
            results,
        };
    }

    /**
     * Runs the full generation pipeline (called by the Inngest worker).
     *
     * ```
     * status: PROCESSING → gatherSourceContext → generateContent → status: READY (or FAILED)
     * ```
     *
     * @param artifactId - Artifact row created by {@link ArtifactService.create}
     * @returns The updated artifact with status `READY` and its generated content
     * @throws When the artifact is missing or generation fails (status set to `FAILED`)
     */
    static async generate(artifactId: string) {
        const artifact = await ArtifactRepository.findById(artifactId);
        if (!artifact) {
            throw new Error("Artifact not found");
        }

        await ArtifactRepository.update(artifactId, { status: "PROCESSING" });

        const origin =
            artifact.metadata &&
            typeof artifact.metadata === "object" &&
            !Array.isArray(artifact.metadata)
                ? (artifact.metadata as { conversationId?: string; messageIds?: string[] })
                : {};

        try {
            // Built from a conversation when it was asked for, otherwise from the ready sources.
            const context = origin.conversationId
                ? await ArtifactGenerationService.gatherConversationContext(
                      origin.conversationId,
                      origin.messageIds,
                  )
                : await ArtifactGenerationService.gatherSourceContext(
                      artifact.workspaceId,
                      artifact.sourceIds,
                  );

            const content = await ArtifactGenerationService.generateContent(
                artifact.type,
                context.text,
                context.sources,
            );

            // Replace the date-based default title with one that names the topic.
            const title = isDefaultTitle(artifact.type, artifact.title)
                ? await ArtifactGenerationService.generateTitle(artifact.type, content)
                : null;

            return ArtifactRepository.update(artifactId, {
                status: "READY",
                content,
                ...(title ? { title } : {}),
                metadata: {
                    ...(origin.conversationId
                        ? { conversationId: origin.conversationId, messageIds: origin.messageIds }
                        : {}),
                    generatedAt: new Date().toISOString(),
                    processingError: undefined,
                },
            });
        } catch (error) {
            await ArtifactRepository.update(artifactId, {
                status: "FAILED",
                metadata: {
                    // The previous content is kept on failure, so keep its edit marker too.
                    ...(readObject(artifact.metadata).userEdited === true
                        ? {
                              userEdited: true,
                              editedAt: readObject(artifact.metadata).editedAt as string,
                          }
                        : {}),
                    // Kept so a retry still reads the conversation it was asked to.
                    ...(origin.conversationId
                        ? { conversationId: origin.conversationId, messageIds: origin.messageIds }
                        : {}),
                    processingError:
                        error instanceof Error ? error.message : "Artifact generation failed",
                },
            });

            throw error;
        }
    }
}
