import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ingestionRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import { SourceController } from "./source.controller.js";
import { uploadSinglePdf } from "./source.middleware.js";

/**
 * `/api/workspaces/:workspaceId/sources`
 *
 * Static paths (`/upload`, `/import/*`, `/bulk-delete`, `/reprocess`) are registered before
 * `/:sourceId` so they aren't captured as ids. Routes that scrape, upload or embed are
 * rate limited per user.
 */
export const sourceRouter = Router({ mergeParams: true });

sourceRouter.get("/", asyncHandler(SourceController.list));
sourceRouter.post("/", ingestionRateLimiter, asyncHandler(SourceController.create));

// Rate limit runs before multer so rejected requests never buffer the upload.
sourceRouter.post(
    "/upload",
    ingestionRateLimiter,
    uploadSinglePdf,
    asyncHandler(SourceController.uploadPdf),
);
sourceRouter.post(
    "/import/website",
    ingestionRateLimiter,
    asyncHandler(SourceController.importWebsite),
);
sourceRouter.post(
    "/import/youtube",
    ingestionRateLimiter,
    asyncHandler(SourceController.importYoutube),
);
sourceRouter.post(
    "/import/github",
    ingestionRateLimiter,
    asyncHandler(SourceController.importGithub),
);
sourceRouter.post(
    "/import/web-search",
    ingestionRateLimiter,
    asyncHandler(SourceController.importWebSearch),
);

sourceRouter.post("/bulk-delete", asyncHandler(SourceController.bulkDelete));
sourceRouter.post(
    "/reprocess",
    ingestionRateLimiter,
    asyncHandler(SourceController.reprocessFailed),
);

sourceRouter.get("/:sourceId", asyncHandler(SourceController.get));
sourceRouter.delete("/:sourceId", asyncHandler(SourceController.delete));
sourceRouter.get("/:sourceId/chunks", asyncHandler(SourceController.getChunks));
sourceRouter.get("/:sourceId/files", asyncHandler(SourceController.getGithubFiles));
sourceRouter.post(
    "/:sourceId/sync",
    ingestionRateLimiter,
    asyncHandler(SourceController.syncGithub),
);
sourceRouter.post(
    "/:sourceId/reprocess",
    ingestionRateLimiter,
    asyncHandler(SourceController.reprocess),
);
