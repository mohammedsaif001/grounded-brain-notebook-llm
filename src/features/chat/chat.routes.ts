import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { aiRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import { ChatController } from "./chat.controller.js";

/** `/api/workspaces/:workspaceId/chat` — a single streaming POST endpoint, rate limited per user. */
export const chatRouter = Router({ mergeParams: true });

chatRouter.post("/", aiRateLimiter, asyncHandler(ChatController.stream));
