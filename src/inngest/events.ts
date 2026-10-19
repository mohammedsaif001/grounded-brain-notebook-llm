/**
 * Publishes Inngest events that trigger or cancel background jobs.
 *
 * Services call this instead of `inngest.send` directly so every event name and
 * payload shape is defined in one place.
 */

import { CONVERSATION_SUMMARY_INTERVAL } from "../lib/ai-config.js";
import { inngest } from "./client.js";

export class EventPublisher {
    /** Queues the extract → chunk → embed → index pipeline for a source. */
    static async sourceCreated(input: { sourceId: string; workspaceId: string }) {
        await inngest.send({
            name: "source/created",
            data: input,
        });
    }

    /** Cancels any in-flight processing run for a deleted source. */
    static async sourceDeleted(input: { sourceId: string; workspaceId: string }) {
        await inngest.send({
            name: "source/deleted",
            data: input,
        });
    }

    /** Cancels in-flight source and artifact runs for a deleted workspace. */
    static async workspaceDeleted(input: { workspaceId: string }) {
        await inngest.send({
            name: "workspace/deleted",
            data: input,
        });
    }

    /** Queues AI generation for a pending learning artifact. */
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
