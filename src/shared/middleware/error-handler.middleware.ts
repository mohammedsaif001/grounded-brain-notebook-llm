import type { NextFunction, Request, Response } from "express";
import { flattenError, ZodError } from "zod";
import multer from "multer";
import { isOpenAIRateLimitError } from "../../config/openai.js";
import { Prisma } from "../../generated/prisma/client.js";
import { APIError } from "../http/api-error.js";
import { APIResponse } from "../http/api-response.js";

/**
 * Codes meaning the database can't be reached. With the pg driver adapter, connection
 * failures surface as `PrismaClientKnownRequestError` carrying the Node socket code
 * (e.g. `ECONNREFUSED`) rather than Prisma's own `P1001`.
 */
const DB_UNAVAILABLE_CODES = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "P1001", // can't reach database server
    "P1002", // database server timed out
    "P1017", // server closed the connection
    "P2024", // timed out fetching a connection from the pool
]);

/**
 * Maps Prisma errors to client-safe API errors, so repositories don't need their own
 * try/catch. Returns `null` for errors that should stay a 500.
 *
 * Most of these come from races, e.g. a row deleted by another request between the
 * ownership check and the write.
 */
function fromPrismaError(error: unknown): APIError | null {
    if (error instanceof Prisma.PrismaClientInitializationError) {
        console.error(error);
        return APIError.ServiceUnavailable("Database is unavailable. Please try again shortly.");
    }

    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
        return null;
    }

    if (DB_UNAVAILABLE_CODES.has(error.code)) {
        console.error(error);
        return APIError.ServiceUnavailable("Database is unavailable. Please try again shortly.");
    }

    switch (error.code) {
        case "P2025": // record required for update/delete not found
            return APIError.NotFound();
        case "P2003": // foreign key: the parent record no longer exists
            return APIError.NotFound("A related resource no longer exists");
        case "P2002": // unique constraint
            return APIError.Conflict("A resource with these values already exists");
        default:
            return null;
    }
}

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
        return APIError.Validation("Validation failed", flattenError(error).fieldErrors);
    }

    if (error instanceof multer.MulterError) {
        return error.code === "LIMIT_FILE_SIZE"
            ? APIError.PayloadTooLarge(error.message)
            : APIError.BadRequest(error.message);
    }

    const prismaError = fromPrismaError(error);
    if (prismaError) {
        return prismaError;
    }

    if (isOpenAIRateLimitError(error)) {
        return APIError.TooManyRequests(
            "The AI provider is rate limiting requests. Please try again shortly.",
        );
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
    if (cloudinaryError.name === "UnexpectedResponse" && cloudinaryError.http_code === 403) {
        return APIError.BadRequest(
            "Cloudinary upload rejected: your API key is missing Upload (create) permission. In Cloudinary Dashboard → Settings → API Keys, use the root secret or create a key with Upload enabled.",
        );
    }

    console.error(error);
    return APIError.Internal();
}

export function errorHandler(error: unknown, _req: Request, res: Response, next: NextFunction) {
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
