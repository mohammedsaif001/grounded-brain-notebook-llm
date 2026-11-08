import type { Request, Response } from "express";
import { ArtifactService } from "./artifact.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import {
    artifactIdParamSchema,
    bulkDeleteArtifactsSchema,
    createArtifactSchema,
    listArtifactsQuerySchema,
    updateArtifactSchema,
} from "./artifact.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** HTTP handlers for `/api/workspaces/:workspaceId/artifacts`. Each validates input, then delegates to the service. */
export class ArtifactController {
    /** GET `/` — lists the workspace's artifacts; `q`, `type`, `status` filters and `limit`/`cursor` paging (200). */
    static list = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const query = listArtifactsQuerySchema.parse(req.query);
        const page = await ArtifactService.list(workspaceId, req.session.user.id, query);
        APIResponse.Page(res, page);
    };

    /** POST `/:artifactId/viewed` — records that the user opened the artifact (204). */
    static markViewed = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        await ArtifactService.markViewed(workspaceId, artifactId, req.session.user.id);
        APIResponse.NoContent(res);
    };

    /** GET `/:artifactId` — returns one artifact (200). */
    static get = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        const artifact = await ArtifactService.get(workspaceId, artifactId, req.session.user.id);
        APIResponse.Ok(res, artifact);
    };

    /** POST `/` — creates a pending artifact from the sources or a conversation and queues generation (201). */
    static create = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createArtifactSchema.parse(req.body);
        const artifact = await ArtifactService.create(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, artifact);
    };

    /** POST `/bulk-delete` — deletes several artifacts by id and reports the outcome of each (200). */
    static bulkDelete = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = bulkDeleteArtifactsSchema.parse(req.body);
        const result = await ArtifactService.bulkDelete(
            workspaceId,
            req.session.user.id,
            input.artifactIds,
        );
        APIResponse.Ok(res, result);
    };

    /** PATCH `/:artifactId` — edits the title and/or content of a finished artifact (200). */
    static update = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        const input = updateArtifactSchema.parse(req.body);
        const artifact = await ArtifactService.update(
            workspaceId,
            artifactId,
            req.session.user.id,
            input,
        );
        APIResponse.Ok(res, artifact);
    };

    /** DELETE `/:artifactId` — deletes an artifact (204). */
    static delete = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        await ArtifactService.delete(workspaceId, artifactId, req.session.user.id);
        APIResponse.NoContent(res);
    };
}
