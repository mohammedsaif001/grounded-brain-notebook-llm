/** CORS policy for the web client. */

import cors from "cors";
import { env } from "../../config/env.js";

/**
 * Allows the web client's origin, with cookies (Better Auth sessions).
 *
 * `X-Conversation-Id` must be exposed: browsers hide non-standard response headers from
 * cross-origin JavaScript, so without this the client can't learn a new chat's id.
 */
export const corsMiddleware = cors({
    origin: env.CLIENT_URL,
    credentials: true,
    exposedHeaders: ["X-Conversation-Id"],
});
