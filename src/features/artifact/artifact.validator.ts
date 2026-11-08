import { z } from "zod";
import { paginationQuerySchema } from "../../shared/http/pagination.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** Supported learning artifact kinds. `WIKI` needs a GitHub repository source. */
const artifactTypes = [
    "SUMMARY",
    "TAKEAWAYS",
    "FLASHCARDS",
    "QUIZ",
    "MINDMAP",
    "REPORT",
    "WIKI",
] as const;

/** Route params for artifact-specific endpoints (`:workspaceId` and `:artifactId`). */
export const artifactIdParamSchema = workspaceIdParamSchema.extend({
    artifactId: z.string().trim().min(1, "Artifact id is required"),
});

/** Generation states an artifact moves through: PENDING → PROCESSING → READY or FAILED. */
const artifactStatuses = ["PENDING", "PROCESSING", "READY", "FAILED"] as const;

/** Query string for listing artifacts: `q` (title), `type` and `status` filters plus `limit` and `cursor`. */
export const listArtifactsQuerySchema = z.object({
    q: z.string().trim().optional(),
    type: z.enum(artifactTypes).optional(),
    status: z.enum(artifactStatuses).optional(),
    ...paginationQuerySchema.shape,
});

/**
 * Body for creating an artifact: type and optional title (max 120 chars), built from one of:
 * the workspace's ready sources (all, or a `sourceIds` subset), or a conversation
 * (`conversationId`, optionally only its `messageIds`).
 */
export const createArtifactSchema = z
    .object({
        type: z.enum(artifactTypes),
        title: z.string().trim().min(1).max(120).optional(),
        sourceIds: z.array(z.string().trim().min(1)).optional(),
        conversationId: z.string().trim().min(1).optional(),
        messageIds: z.array(z.string().trim().min(1)).min(1).max(200).optional(),
    })
    .superRefine((input, ctx) => {
        if (input.messageIds && !input.conversationId) {
            ctx.addIssue({
                code: "custom",
                path: ["messageIds"],
                message: "messageIds needs a conversationId",
            });
        }
        if (input.conversationId && input.sourceIds?.length) {
            ctx.addIssue({
                code: "custom",
                path: ["sourceIds"],
                message: "Use either sourceIds or conversationId, not both",
            });
        }
        if (input.conversationId && input.type === "WIKI") {
            ctx.addIssue({
                code: "custom",
                path: ["type"],
                message: "A repository wiki can't be generated from a conversation",
            });
        }
    });

/** Body for bulk deletion: 1-100 artifact ids. */
export const bulkDeleteArtifactsSchema = z
    .object({
        artifactIds: z.array(z.string().trim().min(1)).min(1).max(100),
    })
    .strict();

/** Validated query for listing artifacts. */
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;

/** Validated body for bulk-deleting artifacts. */
export type BulkDeleteArtifactsInput = z.infer<typeof bulkDeleteArtifactsSchema>;

/** Validated body for creating an artifact. */
export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;
