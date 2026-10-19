import { Router } from "express";
import { ArtifactController } from "./artifact.controller.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

/** `/api/workspaces/:workspaceId/artifacts` */
export const artifactRouter = Router({ mergeParams: true });

artifactRouter.get("/", asyncHandler(ArtifactController.list));
artifactRouter.post("/", asyncHandler(ArtifactController.create));
artifactRouter.get("/:artifactId", asyncHandler(ArtifactController.get));
artifactRouter.delete("/:artifactId", asyncHandler(ArtifactController.delete));
