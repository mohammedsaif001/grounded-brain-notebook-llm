import { Router } from "express";
import { MemoryController } from "../controllers/memory.controller.js";
import { requireAuth } from "../middleware/require-auth-middleware.js";
import { asyncHandler } from "../utils/async-handler.js";

/** `/api/memory` */
export const memoryRouter = Router();

memoryRouter.use(requireAuth);

memoryRouter.get("/", asyncHandler(MemoryController.list));
memoryRouter.post("/", asyncHandler(MemoryController.create));
memoryRouter.patch("/:memoryId", asyncHandler(MemoryController.update));
memoryRouter.delete("/:memoryId", asyncHandler(MemoryController.delete));
