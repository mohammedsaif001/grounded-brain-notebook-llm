import { z } from "zod";
import { CHAT_MODELS } from "../../config/ai.config.js";

/**
 * Body for a chat request.
 *
 * `messages` follows the AI SDK `UIMessage` shape but is validated loosely here; only the
 * latest user message is read. `model` must be one of `CHAT_MODELS`.
 */
export const chatBodySchema = z.object({
    conversationId: z.string().trim().min(1).optional(),
    // Only the latest user message is used; history is loaded from the database.
    // Clients may send just `[latestMessage]` to keep requests small.
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
    model: z.enum(CHAT_MODELS).optional(),
    webSearch: z.boolean().optional(),
});

/** Validated chat request body. */
export type ChatBody = z.infer<typeof chatBodySchema>;
