import type { Request, Response } from "express";
import { SourceService } from "./source.service.js";
import { APIError } from "../../shared/http/api-error.js";
import { APIResponse } from "../../shared/http/api-response.js";
import {
    bulkDeleteSourcesSchema,
    createSourceSchema,
    importGithubSchema,
    importWebSearchSchema,
    importWebsiteSchema,
    importYoutubeSchema,
    listSourcesQuerySchema,
    reprocessSourcesSchema,
    sourceIdParamSchema,
    uploadPdfBodySchema,
} from "./source.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** HTTP handlers for `/api/workspaces/:workspaceId/sources`. Each validates input, then delegates to the service. */
export class SourceController {
    /** GET `/` — lists sources without content; supports `q`, `type` and `status` filters (200). */
    static list = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const filters = listSourcesQuerySchema.parse(req.query);
        const sources = await SourceService.list(workspaceId, req.session.user.id, filters);
        APIResponse.Ok(res, sources);
    };

    /** GET `/:sourceId` — returns one source including its content (200). */
    static get = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const source = await SourceService.get(workspaceId, sourceId, req.session.user.id);
        APIResponse.Ok(res, source);
    };

    /** POST `/` — creates a TEXT or MARKDOWN source and queues processing (201). */
    static create = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createSourceSchema.parse(req.body);
        const source = await SourceService.createText(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    /** POST `/upload` — multipart PDF upload (field `file`, optional `title`) (201). */
    static uploadPdf = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);

        if (!req.file) {
            throw APIError.BadRequest("PDF file is required");
        }

        const { title } = uploadPdfBodySchema.parse(req.body ?? {});

        const source = await SourceService.uploadPdf(
            workspaceId,
            req.session.user.id,
            req.file,
            title,
        );
        APIResponse.Created(res, source);
    };

    /** POST `/import/website` — scrapes a URL with Firecrawl into a source (201). */
    static importWebsite = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importWebsiteSchema.parse(req.body);
        const source = await SourceService.importWebsite(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    /** POST `/import/youtube` — imports a YouTube transcript as a source (201). */
    static importYoutube = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importYoutubeSchema.parse(req.body);
        const source = await SourceService.importYoutube(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    /** POST `/import/github` - reads a GitHub repository into one source (201). */
    static importGithub = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importGithubSchema.parse(req.body);
        const source = await SourceService.importGithub(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    /** POST `/import/web-search` — saves a chosen web search result as a source (201). */
    static importWebSearch = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importWebSearchSchema.parse(req.body);
        const source = await SourceService.importWebSearch(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    /** DELETE `/:sourceId` — deletes a source and its vectors/chunks (204). */
    static delete = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        await SourceService.delete(workspaceId, sourceId, req.session.user.id);
        APIResponse.NoContent(res);
    };

    /** POST `/bulk-delete` — deletes several sources by id (204). */
    static bulkDelete = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = bulkDeleteSourcesSchema.parse(req.body);
        await SourceService.bulkDelete(workspaceId, req.session.user.id, input.sourceIds);
        APIResponse.NoContent(res);
    };

    /** GET `/:sourceId/chunks` — returns the indexed chunks and their count (200). */
    static getChunks = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const result = await SourceService.getChunks(workspaceId, sourceId, req.session.user.id);
        APIResponse.Ok(res, result);
    };

    /** POST `/:sourceId/reprocess` — re-indexes one source in the background (202). */
    static reprocess = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        await SourceService.reprocess(workspaceId, sourceId, req.session.user.id);
        APIResponse.Accepted(res, { reprocessed: true });
    };

    /** POST `/:sourceId/sync` - re-reads a GitHub source and re-indexes it if it changed (202). */
    static syncGithub = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const result = await SourceService.syncGithub(workspaceId, sourceId, req.session.user.id);
        APIResponse.Accepted(res, result);
    };

    /** GET `/:sourceId/files` - lists the files indexed from a GitHub source (200). */
    static getGithubFiles = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const result = await SourceService.getGithubFiles(
            workspaceId,
            sourceId,
            req.session.user.id,
        );
        APIResponse.Ok(res, result);
    };

    /** POST `/reprocess` — re-queues FAILED sources, optionally limited to `sourceIds` (200). */
    static reprocessFailed = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = reprocessSourcesSchema.parse(req.body ?? {});
        const result = await SourceService.reprocessFailed(workspaceId, req.session.user.id, input);
        APIResponse.Ok(res, result);
    };
}
