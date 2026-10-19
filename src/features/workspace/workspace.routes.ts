import { Router } from "express";
import { WorkspaceController } from "./workspace.controller.js";
import { requireAuth } from "../../shared/middleware/require-auth.middleware.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

/** `/api/workspaces` — nested workspace routers are mounted in `routes.ts`. */
export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);

workspaceRouter.get("/", asyncHandler(WorkspaceController.list));
workspaceRouter.post("/", asyncHandler(WorkspaceController.create));
workspaceRouter.get("/:workspaceId", asyncHandler(WorkspaceController.get));
workspaceRouter.patch("/:workspaceId", asyncHandler(WorkspaceController.update));
workspaceRouter.delete("/:workspaceId", asyncHandler(WorkspaceController.delete));
