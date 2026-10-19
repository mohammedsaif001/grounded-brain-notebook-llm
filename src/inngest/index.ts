import { ArtifactService } from "../services/artifact.service.js";
import { ConversationMemoryService } from "../services/conversation-memory.service.js";
import { SourceProcessingService } from "../services/source-processing.service.js";
import { inngest } from "./client.js";

export const processSource = inngest.createFunction(
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
        const { sourceId } = event.data;

        await step.run("mark-processing", () =>
            SourceProcessingService.markProcessing(sourceId),
        );

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

export const generateArtifact = inngest.createFunction(
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
        const { artifactId } = event.data;

        await step.run("generate", async () => {
            await ArtifactService.generate(artifactId);
        });

        return { artifactId, status: "READY" };
    },
);

export const summarizeConversation = inngest.createFunction(
    {
        id: "summarize-conversation",
        retries: 2,
        triggers: [{ event: "conversation/summarize" }],
        // Summaries are incremental, so two runs for the same conversation must not overlap.
        concurrency: { key: "event.data.conversationId", limit: 1 },
    },
    async ({ event, step }) => {
        const { conversationId, userId } = event.data;

        await step.run("summarize", async () => {
            await ConversationMemoryService.summarize(conversationId, userId);
        });

        return { conversationId, status: "SUMMARIZED" };
    },
);

export const functions = [processSource, generateArtifact, summarizeConversation];
