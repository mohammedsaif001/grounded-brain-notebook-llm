import prisma from "../../config/db.js";
import { CHAT_MODEL } from "../../config/ai.config.js";
import { cloudinary, cloudinaryConfig } from "../../config/cloudinary.js";
import { env, inngestDevMode, isProduction } from "../../config/env.js";
import { Mem0Client } from "../../config/mem0.js";
import { openaiClient } from "../../config/openai.js";
import { PineconeClient } from "../../config/pinecone.js";

/** Local Inngest dev server started by `npm run dev`. */
const INNGEST_DEV_SERVER_URL = "http://localhost:8288";

/** Langfuse EU cloud, used when `LANGFUSE_BASE_URL` is unset. */
const DEFAULT_LANGFUSE_BASE_URL = "https://cloud.langfuse.com";

/** Result of probing one dependency: `true` = reachable, `"configured"` = no free probe exists. */
export type PingResult = true | "configured";

/**
 * Fetches a URL and fails unless the response is 2xx.
 *
 * @param url - URL to request
 * @param init - Optional fetch options
 * @throws {Error} `HTTP <status>` for non-OK responses
 */
async function expectOk(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
}

/**
 * Cheap, free probes for each external dependency. None of them consume tokens or credits.
 */
export class HealthRepository {
    /** Runs `SELECT 1` against Postgres. */
    static async database(): Promise<PingResult> {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    }

    /** Reads index stats, which also creates the index if it is missing. */
    static async pinecone(): Promise<PingResult> {
        await (await PineconeClient.getIndex()).describeIndexStats();
        return true;
    }

    /** Looks up the chat model: verifies the key and model access without generating anything. */
    static async openai(): Promise<PingResult> {
        await openaiClient.models.retrieve(CHAT_MODEL);
        return true;
    }

    /**
     * In dev, pings the local Inngest dev server (jobs never run without it). In cloud mode
     * there is no free probe, so the signing/event keys being set is the best signal.
     */
    static async inngest(): Promise<PingResult> {
        const devMode = inngestDevMode ?? !isProduction;
        if (devMode) {
            await expectOk(INNGEST_DEV_SERVER_URL);
            return true;
        }

        if (!env.INNGEST_EVENT_KEY || !env.INNGEST_SIGNING_KEY) {
            throw new Error("INNGEST_EVENT_KEY / INNGEST_SIGNING_KEY are not set");
        }
        return "configured";
    }

    /** Calls the Mem0 ping endpoint (throws `ServiceUnavailable` if unconfigured). */
    static async mem0(): Promise<PingResult> {
        await Mem0Client.get().ping();
        return true;
    }

    /** Pings the Admin API when credentials allow it; uploads only need the unsigned preset. */
    static async cloudinary(): Promise<PingResult> {
        if (!cloudinaryConfig.canSign) {
            return "configured";
        }
        await cloudinary.api.ping();
        return true;
    }

    /** Hits Langfuse's public health endpoint. */
    static async langfuse(): Promise<PingResult> {
        await expectOk(`${env.LANGFUSE_BASE_URL ?? DEFAULT_LANGFUSE_BASE_URL}/api/public/health`);
        return true;
    }
}
