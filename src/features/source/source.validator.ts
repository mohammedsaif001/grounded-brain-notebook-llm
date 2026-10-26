import { z } from "zod";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** Source kinds a client may filter by. */
const sourceTypeSchema = z.enum(["PDF", "WEBSITE", "YOUTUBE", "TEXT", "MARKDOWN", "GITHUB"]);

/** Processing states a source moves through: PENDING → PROCESSING → READY or FAILED. */
const sourceStatusSchema = z.enum(["PENDING", "PROCESSING", "READY", "FAILED"]);

/** Route params for source-specific endpoints (`:workspaceId` and `:sourceId`). */
export const sourceIdParamSchema = workspaceIdParamSchema.extend({
    sourceId: z.string().trim().min(1),
});

/** Query string for listing sources: free-text `q` (title or content), `type`, `status`. */
export const listSourcesQuerySchema = z.object({
    q: z.string().trim().optional(),
    type: sourceTypeSchema.optional(),
    status: sourceStatusSchema.optional(),
});

/** Body for a plain-text source. */
const createTextSourceSchema = z.object({
    type: z.literal("TEXT"),
    title: z.string().trim().min(1, "Title is required").max(200),
    content: z.string().trim().min(1, "Content is required"),
});

/** Body for a markdown source. */
const createMarkdownSourceSchema = z.object({
    type: z.literal("MARKDOWN"),
    title: z.string().trim().min(1, "Title is required").max(200),
    content: z.string().trim().min(1, "Content is required"),
});

/** Body for creating a TEXT or MARKDOWN source, discriminated by `type`. */
export const createSourceSchema = z.discriminatedUnion("type", [
    createTextSourceSchema,
    createMarkdownSourceSchema,
]);

/** Body for importing a website: a valid URL and optional title. */
export const importWebsiteSchema = z.object({
    url: z.string().trim().url("Enter a valid URL"),
    title: z.string().trim().max(200).optional(),
});

/** Body for importing a YouTube video: its URL (parsed later) and optional title. */
export const importYoutubeSchema = z.object({
    url: z.string().trim().min(1, "YouTube URL is required"),
    title: z.string().trim().max(200).optional(),
});

/** Body for importing a GitHub repository: `owner/repo` or a URL, plus optional branch and title. */
export const importGithubSchema = z.object({
    url: z.string().trim().min(1, "Repository is required").max(300),
    branch: z.string().trim().min(1).max(250).optional(),
    title: z.string().trim().max(200).optional(),
});

/** Text fields sent alongside the PDF in the multipart upload form. */
export const uploadPdfBodySchema = z.object({
    title: z.string().trim().max(200).optional(),
});

/** Body for bulk deletion: at least one source id. */
export const bulkDeleteSourcesSchema = z.object({
    sourceIds: z.array(z.string().trim().min(1)).min(1),
});

/** Body for reprocessing failed sources: optional subset of ids (omit for all failed). */
export const reprocessSourcesSchema = z.object({
    sourceIds: z.array(z.string().trim().min(1)).optional(),
});

/** Body for saving a web search result: title, text content and its URL. */
export const importWebSearchSchema = z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1),
    url: z.string().trim().url(),
});

/** Validated input for creating a text/markdown source. */
export type CreateSourceInput = z.infer<typeof createSourceSchema>;
/** Validated input for listing sources. */
export type ListSourcesQuery = z.infer<typeof listSourcesQuerySchema>;
/** Validated input for importing a website. */
export type ImportWebsiteInput = z.infer<typeof importWebsiteSchema>;
/** Validated input for importing a YouTube video. */
export type ImportYoutubeInput = z.infer<typeof importYoutubeSchema>;
/** Validated input for importing a GitHub repository. */
export type ImportGithubInput = z.infer<typeof importGithubSchema>;
/** Validated input for bulk-deleting sources. */
export type BulkDeleteSourcesInput = z.infer<typeof bulkDeleteSourcesSchema>;
/** Validated input for reprocessing failed sources. */
export type ReprocessSourcesInput = z.infer<typeof reprocessSourcesSchema>;
/** Validated input for importing a web search result. */
export type ImportWebSearchInput = z.infer<typeof importWebSearchSchema>;
