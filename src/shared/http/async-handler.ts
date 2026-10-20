/**
 * Express async route wrapper that forwards rejected promises to error middleware.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

/** An Express handler that returns a promise. */
type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * Wraps an async Express handler so thrown errors and rejections reach `next(err)`.
 *
 * Without this wrapper, unhandled promise rejections in async routes would not
 * trigger the global error handler.
 *
 * @param handler - Async route handler function
 * @returns Express-compatible `RequestHandler`
 */
export function asyncHandler(handler: AsyncRequestHandler): RequestHandler {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}
