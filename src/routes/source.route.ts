import { Router } from "express";
import { asyncHandler } from "../utils/async-handler.js";
import { bulkDeleteSources, createSource, deleteSource, getSource, importWebSearch, importWebsite, importYoutube, listSources, uploadPdf } from "../controllers/source.controller.js";
import { uploadSinglePdf } from "../middleware/upload.middleware.js";

export const sourceRoutes = Router({ mergeParams: true });

sourceRoutes.get("/", asyncHandler(listSources));
sourceRoutes.post("/", asyncHandler(createSource));

sourceRoutes.post("/bulk-delete", asyncHandler(bulkDeleteSources));
sourceRoutes.get("/:sourceId", asyncHandler(getSource));
sourceRoutes.delete("/:sourceId", asyncHandler(deleteSource));

sourceRoutes.post(
    "/upload",
    uploadSinglePdf,
    asyncHandler(uploadPdf),
);
sourceRoutes.post("/import/website", asyncHandler(importWebsite));
sourceRoutes.post("/import/youtube", asyncHandler(importYoutube));
sourceRoutes.post("/import/web-search", asyncHandler(importWebSearch));