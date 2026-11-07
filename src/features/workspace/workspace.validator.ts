import { z } from "zod";
import { CHAT_MODELS } from "../../config/ai.config.js";

/** Body for creating a workspace: required title, optional description, icon and default chat model. */
export const createWorkspaceSchema = z.object({
    title: z.string().trim().min(1, "Title is required").max(120),
    description: z.string().trim().max(500).optional(),
    // A short key (e.g. "sprout", "rocket") or legacy emoji; the client decides how to draw it.
    icon: z.string().trim().max(8).optional(),
    defaultModel: z.enum(CHAT_MODELS).optional(),
});

/** Body for updating a workspace: any create field, but at least one must be present. */
export const updateWorkspaceSchema = createWorkspaceSchema
    .partial()
    .refine((data) => Object.keys(data).length > 0, { message: "At least one field is required" });

/** Fields the notebook list can be sorted by. */
const workspaceSortFields = ["updatedAt", "createdAt", "title"] as const;

/** Query string for listing workspaces: free-text `q` (title or description), `sort` and `order`. */
export const listWorkspacesQuerySchema = z.object({
    q: z.string().trim().max(120).optional(),
    sort: z.enum(workspaceSortFields).default("updatedAt"),
    // Defaults to newest first for dates and A-Z for titles.
    order: z.enum(["asc", "desc"]).optional(),
});

/** Validated body for creating a workspace. */
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
/** Validated query for listing workspaces. */
export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQuerySchema>;
/** Validated body for updating a workspace. */
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

/** Route params containing `:workspaceId`; reused by every workspace-scoped feature. */
export const workspaceIdParamSchema = z.object({
    workspaceId: z.string().trim().min(1),
});
