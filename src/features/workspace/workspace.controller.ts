import type { Request, Response } from "express";
import { WorkspaceService } from "./workspace.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import {
    createWorkspaceSchema,
    updateWorkspaceSchema,
    workspaceIdParamSchema,
} from "./workspace.validator.js";

export class WorkspaceController {
    static async list(req: Request, res: Response) {
        const workspaces = await WorkspaceService.listForUser(req.session.user.id);
        APIResponse.Ok(res, workspaces);
    }

    static async get(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const workspace = await WorkspaceService.getForUser(workspaceId, req.session.user.id);
        APIResponse.Ok(res, workspace);
    }

    static async create(req: Request, res: Response) {
        const input = createWorkspaceSchema.parse(req.body);
        const workspace = await WorkspaceService.create(req.session.user.id, input);
        APIResponse.Created(res, workspace);
    }

    static async update(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = updateWorkspaceSchema.parse(req.body);
        const workspace = await WorkspaceService.update(
            workspaceId,
            req.session.user.id,
            input,
        );
        APIResponse.Ok(res, workspace);
    }

    static async delete(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        await WorkspaceService.delete(workspaceId, req.session.user.id);
        APIResponse.NoContent(res);
    }
}
