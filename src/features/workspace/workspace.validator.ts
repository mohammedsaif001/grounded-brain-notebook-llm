import { z } from "zod";
import { CHAT_MODELS } from "../../config/ai.config.js";

/** Body for creating a workspace: required title, optional description, icon and default chat model. */
export const createWorkspaceSchema = z.object({
    title: z.string().trim().min(1, "Title is required").max(120),
    description: z.string().trim().max(500).optional(),
    icon: z.string().trim().max(8).optional(),
    defaultModel: z.enum(CHAT_MODELS).optional(),
});

/** Body for updating a workspace: any create field, but at least one must be present. */
export const updateWorkspaceSchema = createWorkspaceSchema
    .partial()
    .refine((data) => Object.keys(data).length > 0, { message: "At least one field is required" });

/** Validated body for creating a workspace. */
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
/** Validated body for updating a workspace. */
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

/** Route params containing `:workspaceId`; reused by every workspace-scoped feature. */
export const workspaceIdParamSchema = z.object({
    workspaceId: z.string().trim().min(1),
});
