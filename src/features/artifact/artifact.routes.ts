import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { aiRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import { ArtifactController } from "./artifact.controller.js";

/** `/api/workspaces/:workspaceId/artifacts` */
export const artifactRouter = Router({ mergeParams: true });

artifactRouter.get("/", asyncHandler(ArtifactController.list));
artifactRouter.post("/", aiRateLimiter, asyncHandler(ArtifactController.create));
// Static path registered before `/:artifactId` so it isn't captured as an id.
artifactRouter.post("/bulk-delete", asyncHandler(ArtifactController.bulkDelete));
artifactRouter.get("/:artifactId", asyncHandler(ArtifactController.get));
artifactRouter.patch("/:artifactId", asyncHandler(ArtifactController.update));
artifactRouter.post(
    "/:artifactId/regenerate",
    aiRateLimiter,
    asyncHandler(ArtifactController.regenerate),
);
artifactRouter.post("/:artifactId/viewed", asyncHandler(ArtifactController.markViewed));
artifactRouter.delete("/:artifactId", asyncHandler(ArtifactController.delete));
