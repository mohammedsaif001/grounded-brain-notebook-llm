import type { Request, Response } from "express";
import * as workspaceService from "../services/workspace.service.js";
import {
    createWorkspaceSchema,
    updateWorkspaceSchema,
    workspaceIdParamSchema,
} from "../validators/workspace.validator.js";

export async function listWorkspaces(req: Request, res: Response) {
    const workspaces = await workspaceService.listWorkspacesByUser(req.session.user.id);
    res.json(workspaces);
}

export async function getWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const workspace = await workspaceService.getWorkspaceByIdForUser(
        workspaceId,
        req.session.user.id,
    );
    res.json(workspace);
}

export async function createWorkspace(req: Request, res: Response) {
    const input = createWorkspaceSchema.parse(req.body);
    const workspace = await workspaceService.createWorkspaceForUser(
        req.session.user.id,
        input,
    );
    res.status(201).json(workspace);
}

export async function updateWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    const input = updateWorkspaceSchema.parse(req.body);
    const workspace = await workspaceService.updateWorkspaceForUser(
        workspaceId,
        req.session.user.id,
        input,
    );
    res.json(workspace);
}

export async function deleteWorkspace(req: Request, res: Response) {
    const { workspaceId } = workspaceIdParamSchema.parse(req.params);
    await workspaceService.deleteWorkspaceForUser(workspaceId, req.session.user.id);
    res.status(204).send();
}
