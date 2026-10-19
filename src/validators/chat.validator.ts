import { z } from "zod";
import { CHAT_MODELS } from "../config/ai.config.js";
import { workspaceIdParamSchema } from "./workspace.validator.js";

export const conversationIdParamSchema = workspaceIdParamSchema.extend({
    conversationId: z.string().trim().min(1, "Conversation id is required"),
});

export const chatBodySchema = z.object({
    conversationId: z.string().trim().min(1).optional(),
    // Only the latest user message is used; history is loaded from the database.
    // Clients may send just `[latestMessage]` to keep requests small.
    messages: z.array(z.record(z.string(), z.unknown())).min(1),
    model: z.enum(CHAT_MODELS).optional(),
    webSearch: z.boolean().optional(),
});

export type ChatBody = z.infer<typeof chatBodySchema>;

export const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
