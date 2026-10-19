import type { NextFunction, Request, Response } from "express";
import { flattenError, ZodError } from "zod";
import multer from "multer";
import { APIError } from "../http/api-error.js";
import { APIResponse } from "../http/api-response.js";

/**
 * Converts any thrown value into an {@link APIError}.
 *
 * Unknown errors are logged and reported as a generic 500 so internals never leak.
 */
function toAPIError(error: unknown): APIError {
    if (error instanceof APIError) {
        return error;
    }

    if (error instanceof ZodError) {
        return APIError.Validation(
            "Validation failed",
            flattenError(error).fieldErrors,
        );
    }

    if (error instanceof multer.MulterError) {
        return error.code === "LIMIT_FILE_SIZE"
            ? APIError.PayloadTooLarge(error.message)
            : APIError.BadRequest(error.message);
    }

    // Errors raised by express.json() (body-parser).
    const bodyParserType = (error as { type?: string } | null)?.type;
    if (bodyParserType === "entity.too.large") {
        return APIError.PayloadTooLarge("Request body is too large");
    }
    if (bodyParserType === "entity.parse.failed") {
        return APIError.BadRequest("Request body is not valid JSON");
    }

    const cloudinaryError = error as Error & {
        http_code?: number;
        name?: string;
    };
    if (
        cloudinaryError.name === "UnexpectedResponse" &&
        cloudinaryError.http_code === 403
    ) {
        return APIError.BadRequest(
            "Cloudinary upload rejected: your API key is missing Upload (create) permission. In Cloudinary Dashboard → Settings → API Keys, use the root secret or create a key with Upload enabled.",
        );
    }

    console.error(error);
    return APIError.Internal();
}

export function errorHandler(
    error: unknown,
    _req: Request,
    res: Response,
    next: NextFunction,
) {
    // A streaming response (e.g. chat) has already started; let Express close the connection.
    if (res.headersSent) {
        next(error);
        return;
    }

    APIResponse.Error(res, toAPIError(error));
}

/** Catch-all for unmatched routes; register after all routes, before {@link errorHandler}. */
export function notFoundHandler(req: Request) {
    throw APIError.NotFound(`Route ${req.method} ${req.path} not found`);
}
