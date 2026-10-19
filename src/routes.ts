import type { Express } from "express";
import { artifactRouter } from "./features/artifact/artifact.routes.js";
import { chatRouter } from "./features/chat/chat.routes.js";
import { conversationRouter } from "./features/conversation/conversation.routes.js";
import { memoryRouter } from "./features/memory/memory.routes.js";
import { sourceRouter } from "./features/source/source.routes.js";
import { workspaceRouter } from "./features/workspace/workspace.routes.js";

/**
 * Mounts all API routers.
 *
 * Request flow: routes → controllers → services → repositories.
 * Workspace-scoped routers are nested under `workspaceRouter`, so they inherit its
 * `requireAuth` and receive `:workspaceId` via `mergeParams`.
 */
export function registerRoutes(app: Express): void {
    workspaceRouter.use("/:workspaceId/sources", sourceRouter);
    workspaceRouter.use("/:workspaceId/conversations", conversationRouter);
    workspaceRouter.use("/:workspaceId/chat", chatRouter);
    workspaceRouter.use("/:workspaceId/artifacts", artifactRouter);

    app.use("/api/workspaces", workspaceRouter);
    app.use("/api/memory", memoryRouter);
}
