import { Router } from "express";
import { requireAuth } from "../middleware/require-auth-middleware.js";
import { asyncHandler } from "../utils/async-handler.js";
import * as controllers from "../controllers/workspace.controller.js";

export const workspaceRoutes = Router();
workspaceRoutes.use(requireAuth);

workspaceRoutes.get("/", asyncHandler(controllers.listWorkspaces));
workspaceRoutes.post("/", asyncHandler(controllers.createWorkspace));
workspaceRoutes.get("/:workspaceId", asyncHandler(controllers.getWorkspace));
workspaceRoutes.patch("/:workspaceId", asyncHandler(controllers.updateWorkspace));
workspaceRoutes.delete("/:workspaceId", asyncHandler(controllers.deleteWorkspace));
