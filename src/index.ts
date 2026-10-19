import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { errorHandler } from './middleware/error-handler.middleware.js';
import { registerRoutes } from './routes/index.js';
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { requireAuth } from './middleware/require-auth-middleware.js';
import { serve } from "inngest/express";
import { inngest } from './inngest/client.js';
import { functions } from "./inngest/index.js";

const app = express();
const port = process.env.PORT ?? 8080;
const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:3000';

app.use(cors({
    origin: clientUrl,
    credentials: true
}))

app.all("/api/auth/{*any}", toNodeHandler(auth));
// Chat only needs the latest message (history is loaded server-side), but clients using
// `useChat` defaults still send the full history, so allow headroom above the 100kb default.
app.use(express.json({ limit: "2mb" }));

app.use("/api/inngest", serve({ client: inngest, functions }));

app.get("/", (_req, res) => {
    res.json({ message: "Hello from Grounded Notebook API" });
});

app.get('/health', (_req, res) => {
    res.json({status: 'ok'});
})

registerRoutes(app);
app.get("/api/me", requireAuth, (req, res) => {
    res.json(req.session.user);
});

app.use(errorHandler);

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
})