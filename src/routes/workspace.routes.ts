import { Router } from "express";
import { WorkspaceController } from "../controllers/workspace.controller.js";
import { requireAuth } from "../middleware/require-auth-middleware.js";
import { asyncHandler } from "../utils/async-handler.js";

/** `/api/workspaces` — nested workspace routers are mounted in `routes/index.ts`. */
export const workspaceRouter = Router();

workspaceRouter.use(requireAuth);

workspaceRouter.get("/", asyncHandler(WorkspaceController.list));
workspaceRouter.post("/", asyncHandler(WorkspaceController.create));
workspaceRouter.get("/:workspaceId", asyncHandler(WorkspaceController.get));
workspaceRouter.patch("/:workspaceId", asyncHandler(WorkspaceController.update));
workspaceRouter.delete("/:workspaceId", asyncHandler(WorkspaceController.delete));
