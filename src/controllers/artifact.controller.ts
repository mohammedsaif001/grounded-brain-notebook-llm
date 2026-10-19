import type { Request, Response } from "express";
import { ArtifactService } from "../services/artifact.service.js";
import { APIResponse } from "../utils/api-response.js";
import {
    artifactIdParamSchema,
    createArtifactSchema,
} from "../validators/artifact.validator.js";
import { workspaceIdParamSchema } from "../validators/workspace.validator.js";

export class ArtifactController {
    static async list(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const artifacts = await ArtifactService.list(workspaceId, req.session.user.id);
        APIResponse.Ok(res, artifacts);
    }

    static async get(req: Request, res: Response) {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        const artifact = await ArtifactService.get(workspaceId, artifactId, req.session.user.id);
        APIResponse.Ok(res, artifact);
    }

    static async create(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createArtifactSchema.parse(req.body);
        const artifact = await ArtifactService.create(workspaceId, req.session.user.id, input);
        APIResponse.Created(res, artifact);
    }

    static async delete(req: Request, res: Response) {
        const { workspaceId, artifactId } = artifactIdParamSchema.parse(req.params);
        await ArtifactService.delete(workspaceId, artifactId, req.session.user.id);
        APIResponse.NoContent(res);
    }
}
