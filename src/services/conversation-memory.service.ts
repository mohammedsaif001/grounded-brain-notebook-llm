import { generateText } from "ai";
import { openai } from "../lib/openai.js";
import { CHAT_MODEL } from "../lib/ai-config.js";
import { addMemoriesFromMessages } from "../lib/mem0.js";
import {
    findConversationById,
    updateConversationSummary,
} from "../repositories/conversation.repository.js";
import { findMessagesByConversationId } from "../repositories/message.repository.js";
import { NotFoundError } from "../types/app-error.js";

/** Upper bound on messages sent to Mem0 for extraction in one summary run. */
const MAX_MEMORY_EXTRACTION_MESSAGES = 16;

/**
 * Incrementally updates a conversation's rolling summary and syncs new learnings to Mem0.
 *
 * Called asynchronously (via Inngest) every N messages. Only messages added since the
 * last summary (`summaryMessageCount`) are sent to the model, together with the previous
 * summary, so cost stays flat as the conversation grows. The same new messages are sent
 * to Mem0 for memory extraction; this is the only place chat memories are learned.
 *
 * @param conversationId - Conversation to summarize
 * @param userId - Owner of the conversation (used for Mem0)
 * @returns Updated conversation with `summary` and `summaryMessageCount`
 * @throws {NotFoundError} When the conversation does not exist
 *
 *
 */
export async function summarizeConversationById(
    conversationId: string,
    userId: string,
) {
    const conversation = await findConversationById(conversationId);

    if (!conversation) {
        throw new NotFoundError("Conversation not found");
    }

    const messages = await findMessagesByConversationId(conversationId);
    const newMessages = messages.slice(conversation.summaryMessageCount);

    if (newMessages.length === 0) {
        return conversation;
    }

    const transcript = newMessages
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n\n");
    const previousSummary = conversation.summary?.trim();

    const { text: summary } = await generateText({
        model: openai(CHAT_MODEL),
        system: [
            "You summarize chat conversations for a learning assistant.",
            "Produce a concise rolling summary covering topics discussed, questions asked,",
            "key insights, and unresolved threads.",
            "Write in third person about the user. Keep it under 250 words.",
        ].join("\n"),
        prompt: [
            previousSummary
                ? `Previous summary:\n${previousSummary}\n`
                : null,
            previousSummary
                ? "New messages since the previous summary:"
                : "Conversation transcript:",
            transcript,
            "",
            previousSummary
                ? "Write an updated summary that merges the previous summary with the new messages."
                : "Write a summary of the conversation.",
        ]
            .filter(Boolean)
            .join("\n"),
    });

    const updated = await updateConversationSummary(conversationId, {
        summary: summary.trim(),
        summaryMessageCount: messages.length,
    });

    const memoryMessages = newMessages
        .slice(-MAX_MEMORY_EXTRACTION_MESSAGES)
        .map((message) => ({
            role: message.role.toLowerCase() as "user" | "assistant",
            content: message.content,
        }));

    await addMemoriesFromMessages(userId, memoryMessages, {
        source: "learned",
        conversationId,
    });

    return updated;
}
