import { cloudinaryConfig } from "../../config/cloudinary.js";
import { env, isProduction } from "../../config/env.js";
import { FirecrawlClient } from "../../config/firecrawl.js";
import { Mem0Client } from "../../config/mem0.js";
import { TavilyClient } from "../../config/tavily.js";
import { HealthRepository, type PingResult } from "./health.repository.js";

/** A probe slower than this counts as down. */
const CHECK_TIMEOUT_MS = 5_000;

/** Readiness results are reused for this long, so polling can't hammer external APIs. */
const CACHE_TTL_MS = 10_000;

/** Outcome of one probe; `configured` means keys are present but no free probe exists. */
type CheckStatus = "up" | "down" | "configured" | "not_configured";

/** Result of checking a single dependency. */
type CheckResult = {
    status: CheckStatus;
    /** Required dependencies take the whole service down; optional ones only degrade it. */
    required: boolean;
    /** Only outside production, so infrastructure details aren't exposed publicly. */
    latencyMs?: number;
    error?: string;
};

/** Aggregate readiness: `down` if a required check failed, `degraded` if only optional ones did. */
export type ReadinessReport = {
    status: "ok" | "degraded" | "down";
    checks: Record<string, CheckResult>;
};

/** How to probe one dependency. */
type CheckDefinition = {
    required: boolean;
    /** `false` = integration not configured; skipped without probing. */
    enabled: boolean;
    probe: () => Promise<PingResult>;
};

/** Every dependency checked by `/health/ready`, keyed by the name shown in the report. */
const CHECKS: Record<string, CheckDefinition> = {
    database: { required: true, enabled: true, probe: () => HealthRepository.database() },
    pinecone: { required: true, enabled: true, probe: () => HealthRepository.pinecone() },
    openai: { required: true, enabled: true, probe: () => HealthRepository.openai() },
    inngest: { required: true, enabled: true, probe: () => HealthRepository.inngest() },
    mem0: {
        required: false,
        enabled: Mem0Client.isConfigured(),
        probe: () => HealthRepository.mem0(),
    },
    cloudinary: {
        required: false,
        enabled: cloudinaryConfig.canUpload,
        probe: () => HealthRepository.cloudinary(),
    },
    firecrawl: {
        required: false,
        enabled: FirecrawlClient.isConfigured(),
        probe: () => Promise.resolve("configured"),
    },
    tavily: {
        required: false,
        enabled: TavilyClient.isConfigured(),
        probe: () => Promise.resolve("configured"),
    },
    langfuse: {
        required: false,
        enabled: !!(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY),
        probe: () => HealthRepository.langfuse(),
    },
};

/**
 * Rejects if `promise` takes longer than {@link CHECK_TIMEOUT_MS}.
 *
 * @param promise - The probe to bound
 * @returns The probe's result
 */
function withTimeout<T>(promise: Promise<T>) {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
                CHECK_TIMEOUT_MS,
            ),
        ),
    ]);
}

/**
 * Runs one probe and converts the outcome (or failure) into a {@link CheckResult}.
 * Latency and error text are only included outside production.
 *
 * @param definition - The dependency to probe
 */
async function runCheck({ required, enabled, probe }: CheckDefinition): Promise<CheckResult> {
    if (!enabled) {
        return { status: "not_configured", required };
    }

    const started = Date.now();
    try {
        const result = await withTimeout(probe());
        return {
            status: result === "configured" ? "configured" : "up",
            required,
            ...(isProduction ? {} : { latencyMs: Date.now() - started }),
        };
    } catch (error) {
        return {
            status: "down",
            required,
            ...(isProduction
                ? {}
                : {
                      latencyMs: Date.now() - started,
                      error: error instanceof Error ? error.message : String(error),
                  }),
        };
    }
}

/** Aggregates dependency probes into a readiness report. */
export class HealthService {
    /** Last report and when it stops being reused. */
    private static cached: { report: ReadinessReport; expiresAt: number } | null = null;

    /**
     * Probes every dependency in parallel.
     *
     * `down` when a required dependency (database, Pinecone, OpenAI, Inngest) fails,
     * `degraded` when only an optional integration fails, otherwise `ok`.
     * Results are cached for {@link CACHE_TTL_MS}.
     *
     * @returns The readiness report
     */
    static async readiness(): Promise<ReadinessReport> {
        if (this.cached && this.cached.expiresAt > Date.now()) {
            return this.cached.report;
        }

        const names = Object.keys(CHECKS);
        const results = await Promise.all(names.map((name) => runCheck(CHECKS[name])));
        const checks = Object.fromEntries(names.map((name, i) => [name, results[i]]));

        const failed = results.filter((result) => result.status === "down");
        const status = failed.some((result) => result.required)
            ? "down"
            : failed.length > 0
              ? "degraded"
              : "ok";

        const report: ReadinessReport = { status, checks };
        this.cached = { report, expiresAt: Date.now() + CACHE_TTL_MS };
        return report;
    }
}
