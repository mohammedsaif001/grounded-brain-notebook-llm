/**
 * Express application: global middleware, auth, background-job endpoint, and feature routes.
 *
 * Kept separate from `server.ts` so the app can be imported (e.g. by tests) without
 * opening a port.
 */

import cors from "cors";
import express from "express";
import { toNodeHandler } from "better-auth/node";
import { serve } from "inngest/express";
import { auth } from "./config/auth.js";
import { env } from "./config/env.js";
import { inngest } from "./config/inngest.js";
import { functions } from "./jobs/index.js";
import { registerRoutes } from "./routes.js";
import { APIResponse } from "./shared/http/api-response.js";
import { errorHandler, notFoundHandler } from "./shared/middleware/error-handler.middleware.js";
import { requireAuth } from "./shared/middleware/require-auth.middleware.js";

export const app = express();

app.use(cors({
    origin: env.CLIENT_URL,
    credentials: true,
}));

// Better Auth reads the raw body itself, so it is mounted before express.json().
app.all("/api/auth/{*any}", toNodeHandler(auth));

// Chat only needs the latest message (history is loaded server-side), but clients using
// `useChat` defaults still send the full history, so allow headroom above the 100kb default.
app.use(express.json({ limit: "2mb" }));

app.use("/api/inngest", serve({ client: inngest, functions }));

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
