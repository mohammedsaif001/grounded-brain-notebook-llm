import { findSourceById } from "../repositories/source.repository.js";
import { findChunksBySourceId } from "../repositories/source-chunk.repository.js";
import { processArtifactById } from "../services/artifact.service.js";
import { summarizeConversationById } from "../services/conversation-memory.service.js";
import { chunkSourceContent, embedAndIndexSource, extractSourceContent, markSourceFailed, markSourceProcessing } from "../services/source-processing.service.js";
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

        await step.run("mark-processing", () => markSourceProcessing(sourceId));

        try {
            // Extract + chunk run in one step so the full document text and PDF pages
            // never pass through Inngest step state (which is size-limited).
            const { chunkCount } = await step.run("extract-and-chunk", async () => {
                const extracted = await extractSourceContent(sourceId);
                const chunks = await chunkSourceContent(
                    sourceId,
                    extracted.text,
                    extracted.pages,
                );
                return { chunkCount: chunks.length };
            });

            await step.run("embed-and-index", async () => {
                const source = await findSourceById(sourceId);
                if (!source) {
                    throw new Error("Source not found");
                }

                const chunks = await findChunksBySourceId(sourceId);
                await embedAndIndexSource(source, chunks);
            });

            return { sourceId, status: "READY", chunkCount };
        } catch (error) {
            await step.run("mark-failed", async () => {
                const source = await findSourceById(sourceId);
                if (source) {
                    await markSourceFailed(sourceId, error, source.metadata);
                }
            });
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

        await step.run("generate", () => processArtifactById(artifactId));

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

        await step.run("summarize", () =>
            summarizeConversationById(conversationId, userId),
        );

        return { conversationId, status: "SUMMARIZED" };
    },
);

export const functions = [processSource, generateArtifact, summarizeConversation];
