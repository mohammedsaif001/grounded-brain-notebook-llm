import type { Express } from "express";
import { artifactRouter } from "./artifact.routes.js";
import { chatRouter } from "./chat.routes.js";
import { conversationRouter } from "./conversation.routes.js";
import { memoryRouter } from "./memory.routes.js";
import { sourceRouter } from "./source.routes.js";
import { workspaceRouter } from "./workspace.routes.js";

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
