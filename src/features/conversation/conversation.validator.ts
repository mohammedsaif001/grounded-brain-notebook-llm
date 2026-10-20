import { z } from "zod";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** Route params for conversation-specific endpoints (`:workspaceId` and `:conversationId`). */
export const conversationIdParamSchema = workspaceIdParamSchema.extend({
    conversationId: z.string().trim().min(1, "Conversation id is required"),
});

/** Body for creating a conversation: optional title up to 120 characters. */
export const createConversationSchema = z.object({
    title: z.string().trim().min(1).max(120).optional(),
});

/** Validated body for creating a conversation. */
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
