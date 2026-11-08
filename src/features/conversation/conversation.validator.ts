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

/** Body for renaming a conversation: a title of 1-120 characters. */
export const updateConversationSchema = z
    .object({
        title: z.string().trim().min(1, "Title is required").max(120),
    })
    .strict();

/** Validated body for creating a conversation. */
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
/** Validated body for renaming a conversation. */
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
