import type { Request, Response } from "express";
import { ArtifactService } from "./artifact.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import { artifactIdParamSchema, createArtifactSchema } from "./artifact.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** HTTP handlers for `/api/workspaces/:workspaceId/artifacts`. Each validates input, then delegates to the service. */
export class ArtifactController {
    /** GET `/` — lists the workspace's artifacts (200). */
    static list = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const artifacts = await ArtifactService.list(workspaceId, req.session.user.id);
        APIResponse.Ok(res, artifacts);
    };

    /** GET `/:artifactId` — returns one artifact (200). */
    static get = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        const artifact = await ArtifactService.get(workspaceId, artifactId, req.session.user.id);
        APIResponse.Ok(res, artifact);
    };

    /** POST `/` — creates a pending artifact and queues generation (201). */
    static create = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createArtifactSchema.parse(req.body);
        const artifact = await ArtifactService.create(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, artifact);
    };

    /** DELETE `/:artifactId` — deletes an artifact (204). */
    static delete = async (req: Request, res: Response) => {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        await ArtifactService.delete(workspaceId, artifactId, req.session.user.id);
        APIResponse.NoContent(res);
    };
}
