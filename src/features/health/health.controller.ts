import type { Request, Response } from "express";
import { HealthService } from "./health.service.js";
import { APIError } from "../../shared/http/api-error.js";
import { APIResponse } from "../../shared/http/api-response.js";

export class HealthController {
    /** Liveness: the process is up and serving. Never touches dependencies. */
    static live = (_req: Request, res: Response) => {
        APIResponse.Ok(res, { status: "ok" });
    };

    /** Readiness: every dependency the main flow needs. 503 when a required one is down. */
    static ready = async (_req: Request, res: Response) => {
        const report = await HealthService.readiness();

        if (report.status === "down") {
            APIResponse.Error(
                res,
                APIError.ServiceUnavailable("A required dependency is down", report),
            );
            return;
        }

        APIResponse.Ok(res, report);
    };
}
