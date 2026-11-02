/**
 * Timing for calls to external services (OpenAI, Pinecone, Mem0, Tavily, GitHub).
 *
 * Logs one debug line per call with its duration, and a warning when it is slow, so a
 * sluggish dependency shows up in the logs without tracing every call at info level.
 */

import { logger } from "../../config/logger.js";

/** Calls slower than this (ms) are logged as warnings. */
const SLOW_CALL_MS = 3_000;

/**
 * Runs `fn` and logs how long it took, whether it succeeded or not. Errors are rethrown unchanged.
 *
 * @param service - Dependency being called, e.g. `pinecone`
 * @param operation - What is being done, e.g. `query`
 * @param fn - The call to time
 * @param fields - Extra fields to log with the line (counts, ids; never content)
 */
export async function timed<T>(
    service: string,
    operation: string,
    fn: () => Promise<T>,
    fields: Record<string, unknown> = {},
): Promise<T> {
    const startedAt = Date.now();
    try {
        const result = await fn();
        const ms = Date.now() - startedAt;
        logger[ms >= SLOW_CALL_MS ? "warn" : "debug"](
            { kind: "external", service, operation, ms, ...fields },
            `${service}.${operation} ${ms >= SLOW_CALL_MS ? "slow " : ""}- ${ms}ms`,
        );
        return result;
    } catch (error) {
        logger.warn(
            { kind: "external", service, operation, ms: Date.now() - startedAt, ...fields },
            `${service}.${operation} failed - ${Date.now() - startedAt}ms`,
        );
        throw error;
    }
}
