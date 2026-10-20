import { z } from "zod";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** Supported learning artifact kinds. */
const artifactTypes = ["SUMMARY", "TAKEAWAYS", "FLASHCARDS", "QUIZ", "MINDMAP", "REPORT"] as const;

/** Route params for artifact-specific endpoints (`:workspaceId` and `:artifactId`). */
export const artifactIdParamSchema = workspaceIdParamSchema.extend({
    artifactId: z.string().trim().min(1, "Artifact id is required"),
});

/** Body for creating an artifact: type, optional title (max 120 chars) and optional source subset. */
export const createArtifactSchema = z.object({
    type: z.enum(artifactTypes),
    title: z.string().trim().min(1).max(120).optional(),
    sourceIds: z.array(z.string().trim().min(1)).optional(),
});

/** Validated body for creating an artifact. */
export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;
