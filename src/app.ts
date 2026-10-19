/**
 * Express application: global middleware, auth, background-job endpoint, and feature routes.
 *
 * Kept separate from `server.ts` so the app can be imported (e.g. by tests) without
 * opening a port.
 */

import cors from "cors";
import express, { type RequestHandler } from "express";
import { toNodeHandler } from "better-auth/node";
import { serve } from "inngest/express";
import { auth } from "./config/auth.js";
import { env } from "./config/env.js";
import { inngest } from "./config/inngest.js";
import { functions } from "./jobs/index.js";
import { registerRoutes } from "./routes.js";
import { APIResponse } from "./shared/http/api-response.js";
import { errorHandler, notFoundHandler } from "./shared/middleware/error-handler.middleware.js";
import { apiRateLimiter } from "./shared/middleware/rate-limit.middleware.js";
import { requireAuth } from "./shared/middleware/require-auth.middleware.js";

/** Max size of JSON and form bodies. File uploads go through multer with their own limit. */
const BODY_LIMIT = "2mb";

export const app = express();

app.disable("x-powered-by");

// Behind a load balancer/CDN, trust its X-Forwarded-For so rate limiting keys on the
// real client IP. Left off by default so clients can't spoof their IP.
if (env.TRUST_PROXY_HOPS > 0) {
    app.set("trust proxy", env.TRUST_PROXY_HOPS);
}

app.use(
    cors({
        origin: env.CLIENT_URL,
        credentials: true,
    }),
);

// Applied before auth so login attempts are rate limited too.
app.use("/api", apiRateLimiter);

// Better Auth reads the raw body itself, so it is mounted before the body parsers.
app.all("/api/auth/{*any}", toNodeHandler(auth));

// Chat only needs the latest message (history is loaded server-side), but clients using
// `useChat` defaults still send the full history, so allow headroom above the 100kb default.
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// `serve` is typed as `any` upstream; it is a standard Express handler.
app.use("/api/inngest", serve({ client: inngest, functions }) as RequestHandler);

app.get("/", (_req, res) => {
    APIResponse.Ok(res, null, "Hello from Grounded Notebook API");
});

app.get("/health", (_req, res) => {
    APIResponse.Ok(res, { status: "ok" });
});

app.get("/api/me", requireAuth, (req, res) => {
    APIResponse.Ok(res, req.session.user);
});

registerRoutes(app);

app.use(notFoundHandler);
app.use(errorHandler);
