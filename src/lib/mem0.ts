/**
 * Mem0 API client.
 *
 * Only the connection lives here; memory reads and writes go through
 * {@link MemoryRepository} in `repositories/memory.repository.ts`.
 */

import { MemoryClient } from "mem0ai";
import { env } from "../config/env.js";
import { APIError } from "../utils/api-error.js";

export class Mem0Client {
    private static client: MemoryClient | null = null;

    /** Whether Mem0 is configured; memory features are skipped when it isn't. */
    static isConfigured() {
        return !!env.MEM0_API_KEY;
    }

    /**
     * Returns the singleton Mem0 client.
     *
     * @throws {APIError} ServiceUnavailable when `MEM0_API_KEY` is missing
     */
    static get() {
        if (!env.MEM0_API_KEY) {
            throw APIError.ServiceUnavailable("Memory is not configured on the server");
        }

        if (!this.client) {
            this.client = new MemoryClient({ apiKey: env.MEM0_API_KEY });
        }

        return this.client;
    }
}
