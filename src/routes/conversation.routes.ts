import { Router } from "express";
import { ConversationController } from "../controllers/conversation.controller.js";
import { asyncHandler } from "../utils/async-handler.js";

/** `/api/workspaces/:workspaceId/conversations` */
export const conversationRouter = Router({ mergeParams: true });

conversationRouter.get("/", asyncHandler(ConversationController.list));
conversationRouter.post("/", asyncHandler(ConversationController.create));
conversationRouter.get(
    "/:conversationId/messages",
    asyncHandler(ConversationController.listMessages),
);
conversationRouter.delete("/:conversationId", asyncHandler(ConversationController.delete));
