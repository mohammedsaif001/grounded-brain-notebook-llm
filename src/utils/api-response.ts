/**
 * Standard API response helpers.
 *
 * Every JSON response uses one envelope so clients can handle them uniformly:
 *
 * ```json
 * { "success": true, "data": { ... }, "message": "optional" }
 * { "success": false, "error": { "code": "NOT_FOUND", "message": "...", "details": ... } }
 * ```
 *
 * Use these instead of `res.status(...).json(...)`, e.g. `APIResponse.Created(res, workspace)`.
 */

import type { Response } from "express";
import type { APIError, APIErrorCode } from "./api-error.js";

export type APISuccessBody<T> = {
    success: true;
    data: T;
    message?: string;
};

export type APIErrorBody = {
    success: false;
    error: {
        code: APIErrorCode;
        message: string;
        details?: unknown;
    };
};

function sendSuccess<T>(
    res: Response,
    statusCode: number,
    data: T,
    message?: string,
) {
    const body: APISuccessBody<T> = {
        success: true,
        data,
        ...(message ? { message } : {}),
    };
    res.status(statusCode).json(body);
}

export class APIResponse {
    /** 200 — request succeeded. */
    static Ok<T>(res: Response, data: T, message?: string) {
        sendSuccess(res, 200, data, message);
    }

    /** 201 — a resource was created. */
    static Created<T>(res: Response, data: T, message?: string) {
        sendSuccess(res, 201, data, message);
    }

    /** 202 — work was accepted and will complete asynchronously. */
    static Accepted<T>(res: Response, data: T, message?: string) {
        sendSuccess(res, 202, data, message);
    }

    /** 204 — request succeeded with no response body (e.g. deletes). */
    static NoContent(res: Response) {
        res.status(204).end();
    }

    /** Sends an {@link APIError} in the standard error envelope (used by the error handler). */
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
