import { env } from './config/env.js';
import cors from 'cors'
import express from 'express'
import { errorHandler, notFoundHandler } from './middleware/error-handler.middleware.js';
import { APIResponse } from './utils/api-response.js';
import { registerRoutes } from './routes/index.js';
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { requireAuth } from './middleware/require-auth-middleware.js';
import { serve } from "inngest/express";
import { inngest } from './inngest/client.js';
import { functions } from "./inngest/index.js";

const app = express();
app.use(cors({
    origin: env.CLIENT_URL,
    credentials: true
}))

app.all("/api/auth/{*any}", toNodeHandler(auth));
// Chat only needs the latest message (history is loaded server-side), but clients using
// `useChat` defaults still send the full history, so allow headroom above the 100kb default.
app.use(express.json({ limit: "2mb" }));

app.use("/api/inngest", serve({ client: inngest, functions }));

app.get("/", (_req, res) => {
    APIResponse.Ok(res, null, "Hello from Grounded Notebook API");
});

app.get('/health', (_req, res) => {
    APIResponse.Ok(res, { status: 'ok' });
})

registerRoutes(app);
app.get("/api/me", requireAuth, (req, res) => {
    APIResponse.Ok(res, req.session.user);
});

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
    console.log(`Server running on http://localhost:${env.PORT}`);
})