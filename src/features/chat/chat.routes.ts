import { Router } from "express";
import { ChatController } from "./chat.controller.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

/** `/api/workspaces/:workspaceId/chat` */
export const chatRouter = Router({ mergeParams: true });

chatRouter.post("/", asyncHandler(ChatController.stream));
