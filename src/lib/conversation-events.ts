/**
 * Inngest event helpers for background conversation summarization.
 */

import { inngest } from "../inngest/client.js";
import { CONVERSATION_SUMMARY_INTERVAL } from "./ai-config.js";

/**
 * Enqueues a conversation summary job to run asynchronously via Inngest.
 *
 * Triggered once {@link CONVERSATION_SUMMARY_INTERVAL} messages have accumulated since
 * the last summary. `messageCount` is bucketed into the event id so that repeated
 * triggers before the job finishes are deduplicated by Inngest.
 *
 * @param input - Conversation and user ids for the summary worker, plus current message count
 * @returns Resolves when the event is accepted by Inngest
 *
 */
export async function enqueueConversationSummarize(input: {
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
