import type { Request, Response } from "express";

import { bulkDeleteSourcesSchema, createSourceSchema, listSourcesQuerySchema, sourceIdParamSchema, workspaceIdParamSchema } from "../validators/source.validator.js";
import { bulkDeleteSourcesForWorkspace, createTextOrMarkdownSource, deleteSourceForWorkspace, getSourceForWorkspace, listSourcesForWorkspace } from "../services/source.service.js";

export async function listSources(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const filters = listSourcesQuerySchema.parse(req.query);
    const sources = await listSourcesForWorkspace(
        workspaceId,
        req.session.user.id,
        filters,
    );
    res.json(sources);
}

export async function getSource(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    const source = await getSourceForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    res.json(source);
}

export async function createSource(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = createSourceSchema.parse(req.body);
    const source = await createTextOrMarkdownSource(
        workspaceId,
        req.session.user.id,
        input,
    );
    res.status(201).json(source);
}

export async function deleteSource(req: Request, res: Response) {
    const { workspaceId, sourceId } = sourceIdParamSchema.parse(req.params);
    await deleteSourceForWorkspace(
        workspaceId,
        sourceId,
        req.session.user.id,
    );
    res.status(204).send();
}
export async function bulkDeleteSources(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = bulkDeleteSourcesSchema.parse(req.body);
    await bulkDeleteSourcesForWorkspace(
        workspaceId,
        req.session.user.id,
        input.sourceIds,
    );
    res.status(204).send();
}