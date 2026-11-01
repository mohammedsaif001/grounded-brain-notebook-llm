/** Per-request structured logging with request ids. */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Request } from "express";
import { pinoHttp } from "pino-http";
import { logger } from "../../config/logger.js";

/** Full request path without the query string (routers strip their mount prefix from `req.url`). */
const pathOf = (req: IncomingMessage & { originalUrl?: string }) =>
    (req.originalUrl ?? req.url ?? "").split("?")[0];

/**
 * Requests that are only noise: health probes, and the Inngest dev server re-syncing
 * (`PUT /api/inngest`) every few seconds.
 */
const isQuiet = (req: IncomingMessage & { originalUrl?: string }) => {
    const path = pathOf(req);
    return path.startsWith("/health") || (req.method === "PUT" && path.startsWith("/api/inngest"));
};

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
    customProps: (req) => ({
        kind: "http",
        who: { userId: (req as Request).session?.user?.id, ip: req.socket.remoteAddress },
    }),
    customSuccessMessage: (req, res, ms) =>
        `${req.method} ${pathOf(req)} ${res.statusCode} - ${Math.round(ms)}ms`,
    customErrorMessage: (req, res) => `${req.method} ${pathOf(req)} ${res.statusCode} failed`,
    customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
    },
    // Probes and dev-server polling would drown out real traffic.
    autoLogging: { ignore: isQuiet },
    serializers: {
        req: (req: IncomingMessage & { id: string; originalUrl?: string }) => ({
            id: req.id,
            method: req.method,
            url: pathOf(req),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
});
