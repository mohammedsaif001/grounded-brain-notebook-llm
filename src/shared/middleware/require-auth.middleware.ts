/** Authentication guard for protected routes. */

import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../../config/auth.js";
import type { Session } from "../types/session.types.js";
import { APIError } from "../http/api-error.js";

/** Adds the authenticated `session` to Express requests (set by {@link requireAuth}). */
declare module "express-serve-static-core" {
    interface Request {
        session: Session;
    }
}

/**
 * Resolves the Better Auth session from the request cookies and attaches it as `req.session`.
 *
 * @param req - Incoming request
 * @param res - Unused response
 * @param next - Called once the session is attached
 * @throws {APIError} Unauthorized when there is no valid session
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
        throw APIError.Unauthorized("Unauthorized: Please log in to access this resource");
    }

    req.session = session;
    next();
}
