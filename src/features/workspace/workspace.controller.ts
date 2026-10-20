import type { Request, Response } from "express";
import { WorkspaceService } from "./workspace.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import {
    createWorkspaceSchema,
    updateWorkspaceSchema,
    workspaceIdParamSchema,
} from "./workspace.validator.js";

/** HTTP handlers for `/api/workspaces`. Each validates input, then delegates to the service. */
export class WorkspaceController {
    /** GET `/` — lists the signed-in user's workspaces (200). */
    static list = async (req: Request, res: Response) => {
        const workspaces = await WorkspaceService.listForUser(req.session.user.id);
        APIResponse.Ok(res, workspaces);
    };

    /** GET `/:workspaceId` — returns one workspace owned by the user (200). */
    static get = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const workspace = await WorkspaceService.getForUser(workspaceId, req.session.user.id);
        APIResponse.Ok(res, workspace);
    };

    /** POST `/` — creates a workspace (201). */
    static create = async (req: Request, res: Response) => {
        const input = createWorkspaceSchema.parse(req.body);
        const workspace = await WorkspaceService.create(req.session.user.id, input);
        APIResponse.Created(res, workspace);
    };

    /** PATCH `/:workspaceId` — updates title, description, icon or default model (200). */
    static update = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = updateWorkspaceSchema.parse(req.body);
        const workspace = await WorkspaceService.update(workspaceId, req.session.user.id, input);
        APIResponse.Ok(res, workspace);
    };

    /** DELETE `/:workspaceId` — deletes the workspace and everything in it (204). */
    static delete = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        await WorkspaceService.delete(workspaceId, req.session.user.id);
        APIResponse.NoContent(res);
    };
}
