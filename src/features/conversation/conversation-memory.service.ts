import { generateText } from "ai";
import { CHAT_MODEL } from "../../config/ai.config.js";
import { openai } from "../../config/openai.js";
import { CONVERSATION_SUMMARY_SYSTEM, conversationSummaryPrompt } from "../../config/prompts.js";
import { ConversationRepository } from "./conversation.repository.js";
import { MessageRepository } from "./message.repository.js";
import { MemoryService } from "../memory/memory.service.js";

/** Upper bound on messages sent to Mem0 for extraction in one summary run. */
const MAX_MEMORY_EXTRACTION_MESSAGES = 16;

/** Long-running conversation memory: rolling summaries and Mem0 learning. */
export class ConversationMemoryService {
    /**
     * Incrementally updates a conversation's rolling summary and syncs new learnings to Mem0.
     *
     * Called by the Inngest worker every N messages. Only messages added since the last
     * summary (`summaryMessageCount`) are sent to the model, together with the previous
     * summary, so cost stays flat as the conversation grows. The same new messages are sent
     * to Mem0 for memory extraction; this is the only place chat memories are learned.
     *
     * @param userId - Owner of the conversation (used for Mem0)
     * @returns Updated conversation with `summary` and `summaryMessageCount`
     * @throws When the conversation does not exist
     */
    static async summarize(conversationId: string, userId: string) {
        const conversation = await ConversationRepository.findById(conversationId);

        if (!conversation) {
            throw new Error("Conversation not found");
        }

        const messages = await MessageRepository.findAllByConversationId(conversationId);
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
            system: CONVERSATION_SUMMARY_SYSTEM,
            prompt: conversationSummaryPrompt(transcript, previousSummary),
            telemetry: { functionId: "conversation-summary" },
        });

        const updated = await ConversationRepository.updateSummary(conversationId, {
            summary: summary.trim(),
            summaryMessageCount: messages.length,
        });

        await MemoryService.learnFromMessages(
            userId,
            newMessages.slice(-MAX_MEMORY_EXTRACTION_MESSAGES).map((message) => ({
                role: message.role === "USER" ? "user" : "assistant",
                content: message.content,
            })),
            {
                source: "learned",
                conversationId,
            },
        );

        return updated;
    }
}
