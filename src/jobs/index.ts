/**
 * Inngest background functions: source processing, artifact generation and conversation
 * summaries. Served to Inngest by `app.ts` at `/api/inngest`.
 */

import { z } from "zod";
import { propagateAttributes } from "@langfuse/tracing";
import { inngest } from "../config/inngest.js";
import { ArtifactService } from "../features/artifact/artifact.service.js";
import { ConversationMemoryService } from "../features/conversation/conversation-memory.service.js";
import { SourceProcessingService } from "../features/source/source-processing.service.js";

// Event payloads are untyped at the Inngest boundary; validate them before use so a
// malformed event fails loudly instead of passing `undefined` ids downstream.
/** Payload of `source/created`. */
const sourceEventSchema = z.object({ sourceId: z.string().min(1), workspaceId: z.string().min(1) });
/** Payload of `artifact/generate`. */
const artifactEventSchema = z.object({ artifactId: z.string().min(1) });
/** Payload of `conversation/summarize`. */
const conversationEventSchema = z.object({
    conversationId: z.string().min(1),
    userId: z.string().min(1),
});

/**
 * Runs the source pipeline as separate retryable steps: mark processing → extract and
 * chunk → embed and index. Marks the source FAILED if any step exhausts its retries.
 * Runs one at a time per source and is cancelled if the source or workspace is deleted.
 */
const processSource = inngest.createFunction(
    {
        id: "process-source",
        retries: 3,
        triggers: [{ event: "source/created" }],
        // One run per source at a time: a reprocess request queues behind the active run
        // instead of racing it and leaving orphaned vectors behind.
        concurrency: { key: "event.data.sourceId", limit: 1 },
        cancelOn: [
            {
                event: "source/deleted",
                if: "async.data.sourceId == event.data.sourceId",
            },
            {
                event: "workspace/deleted",
                if: "async.data.workspaceId == event.data.workspaceId",
            },
        ],
    },
    async ({ event, step }) => {
        const { sourceId } = sourceEventSchema.parse(event.data);

        await step.run("mark-processing", () => SourceProcessingService.markProcessing(sourceId));

        try {
            const { chunkCount } = await step.run("extract-and-chunk", () =>
                SourceProcessingService.extractAndChunk(sourceId),
            );

            await step.run("embed-and-index", async () => {
                await SourceProcessingService.index(sourceId);
            });

            return { sourceId, status: "READY", chunkCount };
        } catch (error) {
            await step.run("mark-failed", () =>
                SourceProcessingService.markFailed(sourceId, error),
            );
            throw error;
        }
    },
);

/** Generates one learning artifact with the LLM. Cancelled if its workspace is deleted. */
const generateArtifact = inngest.createFunction(
    {
        id: "generate-artifact",
        retries: 2,
        triggers: [{ event: "artifact/generate" }],
        cancelOn: [
            {
                event: "workspace/deleted",
                if: "async.data.workspaceId == event.data.workspaceId",
            },
        ],
    },
    async ({ event, step }) => {
        const { artifactId } = artifactEventSchema.parse(event.data);

        await step.run("generate", () =>
            propagateAttributes({ traceName: "generate-artifact", metadata: { artifactId } }, () =>
                ArtifactService.generate(artifactId),
            ),
        );

        return { artifactId, status: "READY" };
    },
);

/** Updates a conversation's rolling summary. Serialised per conversation. */
const summarizeConversation = inngest.createFunction(
    {
        id: "summarize-conversation",
        retries: 2,
        triggers: [{ event: "conversation/summarize" }],
        // Summaries are incremental, so two runs for the same conversation must not overlap.
        concurrency: { key: "event.data.conversationId", limit: 1 },
    },
    async ({ event, step }) => {
        const { conversationId, userId } = conversationEventSchema.parse(event.data);

        await step.run("summarize", async () => {
            await propagateAttributes(
                { userId, sessionId: conversationId, traceName: "summarize-conversation" },
                () => ConversationMemoryService.summarize(conversationId, userId),
            );
        });

        return { conversationId, status: "SUMMARIZED" };
    },
);

/** All functions registered with the Inngest `serve` handler. */
export const functions = [processSource, generateArtifact, summarizeConversation];
