import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import type { Session } from "../lib/session.js";
import { UnauthorizedError } from "../types/app-error.js";

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
        throw new UnauthorizedError('Unauthorized: Please log in to access this resource')
    }
    
    req.session = session;
    next();
 }
   