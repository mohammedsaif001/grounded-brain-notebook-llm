/**
 * Standard API error.
 *
 * Throw these from anywhere in the request path (controllers, services, libs);
 * the global error handler turns them into the standard error envelope:
 *
 * ```json
 * { "success": false, "error": { "code": "NOT_FOUND", "message": "Workspace not found" } }
 * ```
 *
 * Always create them through the static factories, e.g. `throw APIError.NotFound("Workspace not found")`.
 */

/** Machine-readable error codes exposed to API clients. */
export type APIErrorCode =
    | "BAD_REQUEST"
    | "VALIDATION_ERROR"
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "PAYLOAD_TOO_LARGE"
    | "TOO_MANY_REQUESTS"
    | "INTERNAL_SERVER_ERROR"
    | "SERVICE_UNAVAILABLE";

/**
 * Error carrying an HTTP status, a stable machine-readable code and an optional `details` payload.
 *
 * The constructor is private; use the static factories below.
 */
export class APIError extends Error {
    /**
     * @param statusCode - HTTP status to respond with
     * @param code - Machine-readable error code
     * @param message - Client-safe message
     * @param details - Optional extra info (e.g. field errors)
     */
    private constructor(
        public readonly statusCode: number,
        public readonly code: APIErrorCode,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = "APIError";
    }

    /**
     * 400 — the request is malformed or can't be processed as sent.
     *
     * @param message - Client-safe error message
     * @param details - Extra context returned to the client (e.g. field errors)
     * @returns An {@link APIError} ready to `throw`
     */
    static BadRequest(message = "Bad request", details?: unknown) {
        return new APIError(400, "BAD_REQUEST", message, details);
    }

    /**
     * 400 — request body, params, or query failed schema validation.
     *
     * @param message - Client-safe error message
     * @param details - Extra context returned to the client (e.g. field errors)
     * @returns An {@link APIError} ready to `throw`
     */
    static Validation(message = "Validation failed", details?: unknown) {
        return new APIError(400, "VALIDATION_ERROR", message, details);
    }

    /**
     * 401 — the caller is not authenticated.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static Unauthorized(message = "Unauthorized") {
        return new APIError(401, "UNAUTHORIZED", message);
    }

    /**
     * 403 — the caller is authenticated but not allowed to do this.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static Forbidden(message = "Forbidden") {
        return new APIError(403, "FORBIDDEN", message);
    }

    /**
     * 404 — the resource doesn't exist (or isn't visible to the caller).
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static NotFound(message = "Resource not found") {
        return new APIError(404, "NOT_FOUND", message);
    }

    /**
     * 409 — the request conflicts with the current state of the resource.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static Conflict(message = "Conflict") {
        return new APIError(409, "CONFLICT", message);
    }

    /**
     * 413 — the request body or uploaded file is too large.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static PayloadTooLarge(message = "Payload too large") {
        return new APIError(413, "PAYLOAD_TOO_LARGE", message);
    }

    /**
     * 429 — the caller is being rate limited.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static TooManyRequests(message = "Too many requests") {
        return new APIError(429, "TOO_MANY_REQUESTS", message);
    }

    /**
     * 500 — unexpected server failure. Never include internal details in the message.
     *
     * @param message - Client-safe error message
     * @returns An {@link APIError} ready to `throw`
     */
    static Internal(message = "Internal server error") {
        return new APIError(500, "INTERNAL_SERVER_ERROR", message);
    }

    /**
     * 503 — a required integration is not configured or unavailable.
     *
     * @param message - Client-safe error message
     * @param details - Extra context returned to the client (e.g. field errors)
     * @returns An {@link APIError} ready to `throw`
     */
    static ServiceUnavailable(message = "Service unavailable", details?: unknown) {
        return new APIError(503, "SERVICE_UNAVAILABLE", message, details);
    }
}
