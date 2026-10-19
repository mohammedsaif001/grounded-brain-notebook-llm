import { Router } from "express";
import { SourceController } from "./source.controller.js";
import { uploadSinglePdf } from "./source.middleware.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

/** `/api/workspaces/:workspaceId/sources` */
export const sourceRouter = Router({ mergeParams: true });

sourceRouter.get("/", asyncHandler(SourceController.list));
sourceRouter.post("/", asyncHandler(SourceController.create));

sourceRouter.post("/upload", uploadSinglePdf, asyncHandler(SourceController.uploadPdf));
sourceRouter.post("/import/website", asyncHandler(SourceController.importWebsite));
sourceRouter.post("/import/youtube", asyncHandler(SourceController.importYoutube));
sourceRouter.post("/import/web-search", asyncHandler(SourceController.importWebSearch));

sourceRouter.post("/bulk-delete", asyncHandler(SourceController.bulkDelete));
sourceRouter.post("/reprocess", asyncHandler(SourceController.reprocessFailed));

sourceRouter.get("/:sourceId", asyncHandler(SourceController.get));
sourceRouter.delete("/:sourceId", asyncHandler(SourceController.delete));
sourceRouter.get("/:sourceId/chunks", asyncHandler(SourceController.getChunks));
sourceRouter.post("/:sourceId/reprocess", asyncHandler(SourceController.reprocess));
