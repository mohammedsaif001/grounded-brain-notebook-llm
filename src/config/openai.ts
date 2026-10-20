/**
 * OpenAI clients configured from validated env, with outbound rate limiting.
 *
 * - `openai(modelId)`: AI SDK chat model, throttled through {@link openaiQueue}
 * - `openaiClient`: OpenAI SDK client (embeddings in `shared/ai/embeddings.ts`)
 * - `scheduleOpenAI(task)`: runs any OpenAI call through the same queue
 *
 * Every OpenAI request (chat, generation, query rewriting, embeddings) shares one queue
 * that caps concurrency and requests per minute, so a burst of users or a large PDF
 * can't push the account past its OpenAI rate limit. When the queue is full, callers
 * get a 429 immediately instead of waiting indefinitely.
 */

import OpenAI from "openai";
import PQueue from "p-queue";
import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, RetryError, wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { APIError } from "../shared/http/api-error.js";
import { env } from "./env.js";

/** Shared queue for every outbound OpenAI request. */
const openaiQueue = new PQueue({
    concurrency: env.OPENAI_MAX_CONCURRENCY,
    intervalCap: env.OPENAI_REQUESTS_PER_MINUTE,
    interval: 60_000,
});

/**
 * Runs an OpenAI call through {@link openaiQueue}.
 *
 * @param task - Function that performs the OpenAI request
 * @returns The task's result once it has had its turn in the queue
 * @throws {APIError} TooManyRequests when the queue already holds `OPENAI_MAX_QUEUE` waiting calls
 */
export function scheduleOpenAI<T>(task: () => PromiseLike<T>): Promise<T> {
    if (openaiQueue.size >= env.OPENAI_MAX_QUEUE) {
        throw APIError.TooManyRequests("The AI service is busy. Please try again shortly.");
    }

    return openaiQueue.add(() => task());
}

/**
 * Routes model calls through the queue. For streams, the slot is held until the response
 * starts streaming (not until it finishes), which is what OpenAI's per-minute limits count.
 */
const rateLimitMiddleware: LanguageModelMiddleware = {
    wrapGenerate: ({ doGenerate }) => scheduleOpenAI(doGenerate),
    wrapStream: ({ doStream }) => scheduleOpenAI(doStream),
};

/** Un-throttled AI SDK provider; always wrapped by {@link openai} before use. */
const provider = createOpenAI({ apiKey: env.OPENAI_API_KEY });

/**
 * AI SDK chat model for `modelId`, throttled through the shared OpenAI queue.
 *
 * @param modelId - OpenAI model id, e.g. one of `CHAT_MODELS`
 * @returns A language model usable with `generateText` / `streamText`
 */
export function openai(modelId: Parameters<typeof provider>[0]) {
    return wrapLanguageModel({
        model: provider(modelId),
        middleware: rateLimitMiddleware,
    });
}

/** Raw OpenAI SDK client. Retries 429/5xx with exponential backoff (honours `retry-after`). */
export const openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 3 });

/**
 * Whether an error is OpenAI rejecting us for rate/quota limits (after SDK retries).
 *
 * Unwraps AI SDK `RetryError`s so the underlying 429 is detected.
 *
 * @param error - Any thrown value
 * @returns `true` for OpenAI rate-limit / HTTP 429 errors
 */
export function isOpenAIRateLimitError(error: unknown): boolean {
    if (error instanceof OpenAI.RateLimitError) {
        return true;
    }

    if (RetryError.isInstance(error)) {
        return isOpenAIRateLimitError(error.lastError);
    }

    return APICallError.isInstance(error) && error.statusCode === 429;
}
