import { Router } from "express";
import { HealthController } from "./health.controller.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

/** `/health` (liveness, for load balancers) and `/health/ready` (every dependency). Public. */
export const healthRouter = Router();

healthRouter.get("/", HealthController.live);
healthRouter.get("/ready", asyncHandler(HealthController.ready));
