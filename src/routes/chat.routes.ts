import { Router } from "express";
import { ChatController } from "../controllers/chat.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

/** `/api/workspaces/:workspaceId/chat` */
export const chatRouter = Router({ mergeParams: true });

chatRouter.post("/", asyncHandler(ChatController.stream));
