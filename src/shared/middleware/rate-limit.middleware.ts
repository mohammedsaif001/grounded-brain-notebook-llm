/**
 * Inbound API rate limiting (express-rate-limit).
 *
 * - {@link apiRateLimiter}: broad per-IP cap on all `/api` traffic (abuse / scraping)
 * - {@link aiRateLimiter}: per-user cap on routes that call the LLM (chat, artifacts)
 * - {@link ingestionRateLimiter}: per-user cap on routes that scrape, upload, or embed sources
 *
 * Counters live in process memory, so limits are per server instance. When running more
 * than one instance, plug in a shared store (e.g. `rate-limit-redis`) via the `store` option.
 */

import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { APIError } from "../http/api-error.js";

/**
 * Rate-limit key: the authenticated user id when `requireAuth` has run, otherwise the client IP.
 *
 * @param req - Incoming request
 * @returns A `user:<id>` or `ip:<address>` key
 */
function userOrIpKey(req: Request) {
    const userId = (req.session as Request["session"] | undefined)?.user?.id;
    return userId ? `user:${userId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * Builds a limiter that reports overages through the standard error envelope.
 *
 * @param options.windowMs - Length of the counting window in milliseconds
 * @param options.limit - Max requests per key within the window
 * @param options.message - Message returned in the 429 response
 * @param options.perUser - Key by user id (falling back to IP) instead of IP only
 * @param options.skip - Return `true` to exempt a request from limiting
 * @returns Express rate-limit middleware
 */
function createRateLimiter(options: {
    windowMs: number;
    limit: number;
    message: string;
    perUser?: boolean;
    skip?: (req: Request) => boolean;
}) {
    return rateLimit({
        windowMs: options.windowMs,
        limit: options.limit,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        ...(options.perUser ? { keyGenerator: userOrIpKey } : {}),
        ...(options.skip ? { skip: options.skip } : {}),
        // Hand off to the error handler so the response uses the standard error envelope.
        handler: (_req, _res, next) => {
            next(APIError.TooManyRequests(options.message));
        },
    });
}

/** 300 requests / 15 min per IP across the whole API. Inngest has its own signed endpoint. */
export const apiRateLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    message: "Too many requests. Please slow down and try again in a few minutes.",
    skip: (req) => req.originalUrl.startsWith("/api/inngest"),
});

/** 20 LLM-backed requests / minute per user (chat messages, artifact generation). */
export const aiRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    limit: 20,
    perUser: true,
    message: "You're sending AI requests too quickly. Please wait a moment and try again.",
});

/** 30 source imports / uploads / reprocess requests per 10 min per user. */
export const ingestionRateLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    perUser: true,
    message: "Too many source imports. Please wait a few minutes before adding more.",
});
