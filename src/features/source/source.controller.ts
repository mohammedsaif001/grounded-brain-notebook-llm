import type { Request, Response } from "express";
import { SourceService } from "./source.service.js";
import { APIError } from "../../shared/http/api-error.js";
import { APIResponse } from "../../shared/http/api-response.js";
import {
    bulkDeleteSourcesSchema,
    createSourceSchema,
    importWebSearchSchema,
    importWebsiteSchema,
    importYoutubeSchema,
    listSourcesQuerySchema,
    reprocessSourcesSchema,
    sourceIdParamSchema,
    uploadPdfBodySchema,
} from "./source.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

export class SourceController {
    static list = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const filters = listSourcesQuerySchema.parse(req.query);
        const sources = await SourceService.list(workspaceId, req.session.user.id, filters);
        APIResponse.Ok(res, sources);
    };

    static get = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const source = await SourceService.get(workspaceId, sourceId, req.session.user.id);
        APIResponse.Ok(res, source);
    };

    static create = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createSourceSchema.parse(req.body);
        const source = await SourceService.createText(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

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

    static importWebsite = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importWebsiteSchema.parse(req.body);
        const source = await SourceService.importWebsite(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    static importYoutube = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importYoutubeSchema.parse(req.body);
        const source = await SourceService.importYoutube(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    static importWebSearch = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = importWebSearchSchema.parse(req.body);
        const source = await SourceService.importWebSearch(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, source);
    };

    static delete = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        await SourceService.delete(workspaceId, sourceId, req.session.user.id);
        APIResponse.NoContent(res);
    };

    static bulkDelete = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = bulkDeleteSourcesSchema.parse(req.body);
        await SourceService.bulkDelete(workspaceId, req.session.user.id, input.sourceIds);
        APIResponse.NoContent(res);
    };

    static getChunks = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        const result = await SourceService.getChunks(workspaceId, sourceId, req.session.user.id);
        APIResponse.Ok(res, result);
    };

    static reprocess = async (req: Request, res: Response) => {
        const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
        await SourceService.reprocess(workspaceId, sourceId, req.session.user.id);
        APIResponse.Accepted(res, { reprocessed: true });
    };

    static reprocessFailed = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = reprocessSourcesSchema.parse(req.body ?? {});
        const result = await SourceService.reprocessFailed(workspaceId, req.session.user.id, input);
        APIResponse.Ok(res, result);
    };
}
