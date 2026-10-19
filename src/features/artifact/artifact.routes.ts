import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { aiRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import { ArtifactController } from "./artifact.controller.js";

/** `/api/workspaces/:workspaceId/artifacts` */
export const artifactRouter = Router({ mergeParams: true });

artifactRouter.get("/", asyncHandler(ArtifactController.list));
artifactRouter.post("/", aiRateLimiter, asyncHandler(ArtifactController.create));
artifactRouter.get("/:artifactId", asyncHandler(ArtifactController.get));
artifactRouter.delete("/:artifactId", asyncHandler(ArtifactController.delete));
