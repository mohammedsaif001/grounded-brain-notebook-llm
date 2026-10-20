/** CORS policy for the web client. */

import cors from "cors";
import { env } from "../../config/env.js";

/** Allows the web client's origin, with cookies (Better Auth sessions). */
export const corsMiddleware = cors({
    origin: env.CLIENT_URL,
    credentials: true,
});
