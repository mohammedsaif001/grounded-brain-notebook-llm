/**
 * Publishes Inngest events that trigger or cancel background jobs.
 *
 * Services call this instead of `inngest.send` directly so every event name and
 * payload shape is defined in one place.
 */

import { CONVERSATION_SUMMARY_INTERVAL } from "../config/ai.config.js";
import { inngest } from "../config/inngest.js";

/** Typed wrappers around `inngest.send` for each background-job event. */
export class EventPublisher {
    /**
     * Queues the extract → chunk → embed → index pipeline for a source.
     *
     * @param input.sourceId - Source to process
     * @param input.workspaceId - Workspace owning the source
     */
    static async sourceCreated(input: { sourceId: string; workspaceId: string }) {
        await inngest.send({
            name: "source/created",
            data: input,
        });
    }

    /**
     * Cancels any in-flight processing run for a deleted source.
     *
     * @param input.sourceId - Deleted source
     * @param input.workspaceId - Workspace that owned it
     */
    static async sourceDeleted(input: { sourceId: string; workspaceId: string }) {
        await inngest.send({
            name: "source/deleted",
            data: input,
        });
    }

    /**
     * Cancels in-flight source and artifact runs for a deleted workspace.
     *
     * @param input.workspaceId - Deleted workspace
     */
    static async workspaceDeleted(input: { workspaceId: string }) {
        await inngest.send({
            name: "workspace/deleted",
            data: input,
        });
    }

    /**
     * Queues AI generation for a pending learning artifact.
     *
     * @param input.artifactId - Artifact row to fill in
     * @param input.workspaceId - Workspace owning the artifact
     */
    static async artifactRequested(input: { artifactId: string; workspaceId: string }) {
        await inngest.send({
            name: "artifact/generate",
            data: input,
        });
    }

    /**
     * Queues an incremental conversation summary.
     *
     * `messageCount` is bucketed by {@link CONVERSATION_SUMMARY_INTERVAL} into the event id,
     * so repeated triggers before the job finishes are deduplicated by Inngest.
     *
     * @param input.conversationId - Conversation to summarize
     * @param input.userId - Owner, used for tracing and memory
     * @param input.messageCount - Current number of messages in the conversation
     */
    static async conversationSummaryRequested(input: {
        conversationId: string;
        userId: string;
        messageCount: number;
    }) {
        const bucket = Math.floor(input.messageCount / CONVERSATION_SUMMARY_INTERVAL);

        await inngest.send({
            id: `conversation-summarize-${input.conversationId}-${bucket}`,
            name: "conversation/summarize",
            data: {
                conversationId: input.conversationId,
                userId: input.userId,
            },
        });
    }
}
