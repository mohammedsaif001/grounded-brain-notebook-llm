/**
 * Standard API response helpers.
 *
 * Every JSON response uses one envelope so clients can handle them uniformly:
 *
 * ```json
 * { "success": true, "data": { ... }, "message": "optional", "meta": { ... optional } }
 * { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": ... } }
 * ```
 *
 * Use these instead of `res.status(...).json(...)`, e.g. `APIResponse.Created(res, workspace)`.
 */

import type { Response } from "express";
import type { APIError, APIErrorCode } from "./api-error.js";

/** Shape of every successful JSON response. */
export type APISuccessBody<T> = {
    success: true;
    data: T;
    message?: string;
    /** Extra information about `data`, e.g. `{ total, nextCursor }` for paginated lists. */
    meta?: Record<string, unknown>;
};

/** Shape of every error JSON response. */
export type APIErrorBody = {
    success: false;
    error: {
        code: APIErrorCode;
        message: string;
        details?: unknown;
    };
};

/**
 * Writes the success envelope.
 *
 * @param res - Express response
 * @param statusCode - HTTP status to send
 * @param data - Payload placed under `data`
 * @param message - Optional human-readable message
 * @param meta - Optional extra information placed under `meta`
 */
function sendSuccess<T>(
    res: Response,
    statusCode: number,
    data: T,
    message?: string,
    meta?: Record<string, unknown>,
) {
    const body: APISuccessBody<T> = {
        success: true,
        data,
        ...(message ? { message } : {}),
        ...(meta ? { meta } : {}),
    };
    res.status(statusCode).json(body);
}

/** Helpers that send responses in the standard envelope. */
export class APIResponse {
    /**
     * 200 — request succeeded.
     *
     * @param res - Express response
     * @param data - Payload placed under `data`
     * @param message - Optional human-readable message
     * @param meta - Optional extra information placed under `meta`
     */
    static Ok<T>(res: Response, data: T, message?: string, meta?: Record<string, unknown>) {
        sendSuccess(res, 200, data, message, meta);
    }

    /**
     * 200 — one page of a list: the items under `data`, `total` and `nextCursor` under `meta`.
     *
     * @param res - Express response
     * @param page - Items plus pagination info from `toPage`
     */
    static Page<T>(res: Response, page: { items: T[]; total: number; nextCursor: string | null }) {
        sendSuccess(res, 200, page.items, undefined, {
            total: page.total,
            nextCursor: page.nextCursor,
        });
    }

    /**
     * 201 — a resource was created.
     *
     * @param res - Express response
     * @param data - Payload placed under `data`
     * @param message - Optional human-readable message
     */
    static Created<T>(res: Response, data: T, message?: string) {
        sendSuccess(res, 201, data, message);
    }

    /**
     * 202 — work was accepted and will complete asynchronously.
     *
     * @param res - Express response
     * @param data - Payload placed under `data`
     * @param message - Optional human-readable message
     */
    static Accepted<T>(res: Response, data: T, message?: string) {
        sendSuccess(res, 202, data, message);
    }

    /**
     * 204 — request succeeded with no response body (e.g. deletes).
     *
     * @param res - Express response
     */
    static NoContent(res: Response) {
        res.status(204).end();
    }

    /**
     * Sends an {@link APIError} in the standard error envelope (used by the error handler).
     *
     * @param res - Express response
     * @param error - Error whose status, code, message and details are serialised
     */
    static Error(res: Response, error: APIError) {
        const body: APIErrorBody = {
            success: false,
            error: {
                code: error.code,
                message: error.message,
                ...(error.details !== undefined ? { details: error.details } : {}),
            },
        };
        res.status(error.statusCode).json(body);
    }
}
