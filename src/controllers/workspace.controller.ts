import type { Request, Response } from "express";
import { APIResponse } from "../utils/api-response.js";
import * as workspaceService from "../services/workspace.service.js";
import {
    createWorkspaceSchema,
    updateWorkspaceSchema,
    workspaceIdParamSchema,
} from "../validators/workspace.validator.js";

export async function listWorkspaces(req: Request, res: Response) {
    const workspaces = await workspaceService.listWorkspacesByUser(req.session.user.id);
    APIResponse.Ok(res, workspaces);
}

export async function getWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const workspace = await workspaceService.getWorkspaceByIdForUser(
        workspaceId,
        req.session.user.id,
    );
    APIResponse.Ok(res, workspace);
}

export async function createWorkspace(req: Request, res: Response) {
    const input = createWorkspaceSchema.parse(req.body);
    const workspace = await workspaceService.createWorkspaceForUser(
        req.session.user.id,
        input,
    );
    APIResponse.Created(res, workspace);
}

export async function updateWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = updateWorkspaceSchema.parse(req.body);
    const workspace = await workspaceService.updateWorkspaceForUser(
        workspaceId,
        req.session.user.id,
        input,
    );
    APIResponse.Ok(res, workspace);
}

export async function deleteWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    await workspaceService.deleteWorkspaceForUser(workspaceId, req.session.user.id);
    APIResponse.NoContent(res);
}
