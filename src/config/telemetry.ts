/**
 * LLM tracing with Langfuse.
 *
 * AI SDK calls (`generateText`, `streamText`, …) emit OpenTelemetry spans through the
 * registered Langfuse integration; `LangfuseSpanProcessor` batches and exports them.
 * Embeddings use the raw OpenAI SDK and are not traced.
 *
 * Disabled unless `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set, in which case
 * AI SDK calls skip telemetry entirely.
 */

import { registerTelemetry } from "ai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseVercelAiSdkIntegration } from "@langfuse/vercel-ai-sdk";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { env } from "./env.js";
import { logger } from "./logger.js";

const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

/** Max time to wait for pending spans to export on shutdown. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

let provider: NodeTracerProvider | null = null;

/** Registers the tracer provider and AI SDK integration. Call once at startup. */
export function initTelemetry() {
    if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
        logger.info("Langfuse tracing disabled (LANGFUSE_* keys not set)");
        return;
    }

    const baseUrl = env.LANGFUSE_BASE_URL ?? DEFAULT_LANGFUSE_BASE_URL;

    provider = new NodeTracerProvider({
        spanProcessors: [
            new LangfuseSpanProcessor({
                publicKey: env.LANGFUSE_PUBLIC_KEY,
                secretKey: env.LANGFUSE_SECRET_KEY,
                baseUrl,
                environment: env.NODE_ENV,
            }),
        ],
    });
    provider.register();

    registerTelemetry(new LangfuseVercelAiSdkIntegration());
    logger.info({ baseUrl }, "Langfuse tracing enabled");
}

/** Flushes pending spans. Bounded so an unreachable Langfuse can't block shutdown. */
export async function shutdownTelemetry() {
    if (!provider) {
        return;
    }

    await Promise.race([
        provider.shutdown(),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]).catch((error: unknown) => logger.warn({ err: error }, "Telemetry flush failed"));
}
