import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../config/auth.js";
import type { Session } from "../types/session.types.js";
import { APIError } from "../utils/api-error.js";

declare module "express-serve-static-core" {
    interface Request {
        session: Session;
    }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
    })

    if (!session?.user) {
        throw APIError.Unauthorized('Unauthorized: Please log in to access this resource')
    }
    
    req.session = session;
    next();
 }
   