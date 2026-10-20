/**
 * Firecrawl API client.
 *
 * Only the connection lives here; scraping goes through {@link FirecrawlScraper}
 * in `features/source/ingestion/firecrawl.ts`.
 */

import Firecrawl from "@mendable/firecrawl-js";
import { env } from "./env.js";
import { APIError } from "../shared/http/api-error.js";

export class FirecrawlClient {
    private static client: Firecrawl | null = null;

    /** Whether website imports are available. */
    static isConfigured() {
        return !!env.FIRECRAWL_API_KEY;
    }

    /**
     * Returns the singleton Firecrawl client.
     *
     * @throws {APIError} ServiceUnavailable when `FIRECRAWL_API_KEY` is missing
     */
    static get() {
        if (!env.FIRECRAWL_API_KEY) {
            throw APIError.ServiceUnavailable("Firecrawl is not configured on the server");
        }

        if (!this.client) {
            this.client = new Firecrawl({ apiKey: env.FIRECRAWL_API_KEY });
        }

        return this.client;
    }
}
