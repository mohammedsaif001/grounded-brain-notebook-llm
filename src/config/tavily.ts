/**
 * Tavily API client.
 *
 * Only the connection lives here; web search goes through {@link TavilySearch}
 * in `features/chat/web-search/tavily.ts`.
 */

import { tavily } from "@tavily/core";
import { env } from "./env.js";
import { APIError } from "../shared/http/api-error.js";

export class TavilyClient {
    private static client: ReturnType<typeof tavily> | null = null;

    /** Whether web search is available. */
    static isConfigured() {
        return !!env.TAVILY_API_KEY;
    }

    /**
     * Returns the singleton Tavily client.
     *
     * @throws {APIError} ServiceUnavailable when `TAVILY_API_KEY` is missing
     */
    static get() {
        if (!env.TAVILY_API_KEY) {
            throw APIError.ServiceUnavailable("Web search is not configured on the server");
        }

        if (!this.client) {
            this.client = tavily({ apiKey: env.TAVILY_API_KEY });
        }

        return this.client;
    }
}
