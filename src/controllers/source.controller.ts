import type { Request, Response } from "express";
import { APIResponse } from "../utils/api-response.js";

import { bulkDeleteSourcesSchema, createSourceSchema, importWebSearchSchema, importWebsiteSchema, importYoutubeSchema, listSourcesQuerySchema, reprocessSourcesSchema, sourceIdParamSchema, workspaceIdParamSchema } from "../validators/source.validator.js";
import { bulkDeleteSourcesForWorkspace, createTextOrMarkdownSource, deleteSourceForWorkspace, getSourceChunksForWorkspace, getSourceForWorkspace, importWebSearchSource, importWebsiteSource, importYoutubeSource, listSourcesForWorkspace, reprocessSourceForWorkspace, reprocessSourcesForWorkspace, uploadPdfSource } from "../services/source.service.js";
import { APIError } from "../utils/api-error.js";

export async function listSources(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const filters = listSourcesQuerySchema.parse(req.query);
    const sources = await listSourcesForWorkspace(
        workspaceId,
        req.session.user.id,
        filters,
    );
    APIResponse.Ok(res, sources);
}

export async function getSource(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    const source = await getSourceForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    APIResponse.Ok(res, source);
}

export async function createSource(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = createSourceSchema.parse(req.body);
    const source = await createTextOrMarkdownSource(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Created(res, source);
}

export async function deleteSource(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    await deleteSourceForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    APIResponse.NoContent(res);
}
export async function bulkDeleteSources(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = bulkDeleteSourcesSchema.parse(req.body);
    await bulkDeleteSourcesForWorkspace(
        workspaceId,
        req.session.user.id,
        input.sourceIds,
    );
    APIResponse.NoContent(res);
}

export async function uploadPdf(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);

    if (!req.file) {
        throw APIError.BadRequest("PDF file is required");
    }

    const title =
        typeof req.body.title === "string" ? req.body.title : undefined;

    const source = await uploadPdfSource(
        workspaceId,
        req.session.user.id,
        req.file,
        title,
    );

    APIResponse.Created(res, source);
}

export async function importWebsite(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = importWebsiteSchema.parse(req.body);
    const source = await importWebsiteSource(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Created(res, source);
}

export async function importYoutube(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = importYoutubeSchema.parse(req.body);
    const source = await importYoutubeSource(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Created(res, source);
}

export async function importWebSearch(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = importWebSearchSchema.parse(req.body);
    const source = await importWebSearchSource(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Created(res, source);
}


export async function getSourceChunks(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    const result = await getSourceChunksForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    APIResponse.Ok(res, result);
}


export async function reprocessSources(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = reprocessSourcesSchema.parse(req.body ?? {});
    const result = await reprocessSourcesForWorkspace(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Ok(res, result);
}

export async function reprocessSource(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    await reprocessSourceForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    APIResponse.Accepted(res, { reprocessed: true });
}