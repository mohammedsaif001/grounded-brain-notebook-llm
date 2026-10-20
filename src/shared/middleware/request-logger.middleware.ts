/** Per-request structured logging with request ids. */

import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "../../config/logger.js";

/** Accepts a caller-supplied request id (e.g. from a proxy) only if it looks sane. */
const REQUEST_ID_PATTERN = /^[\w-]{1,64}$/;

/**
 * One log line per request with a request id (echoed in `X-Request-Id`) and, once auth has
 * run, the user id. 4xx log as warn, 5xx as error with the error attached. Also exposes a
 * request-scoped child logger as `req.log`.
 */
export const requestLogger = pinoHttp({
    logger,
    genReqId: (req, res) => {
        const incoming = req.headers["x-request-id"];
        const id =
            typeof incoming === "string" && REQUEST_ID_PATTERN.test(incoming)
                ? incoming
                : randomUUID();
        res.setHeader("X-Request-Id", id);
        return id;
    },
    customProps: (req) => ({ userId: (req as Request).session?.user?.id }),
    customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
    },
    // Health probes are polled constantly; logging them would drown out real traffic.
    autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
    serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
});
