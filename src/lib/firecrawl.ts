/**
 * Firecrawl client for scraping website content into markdown sources.
 */

import Firecrawl from "@mendable/firecrawl-js";
import { env } from "../config/env.js";
import { APIError } from "../utils/api-error.js";

export class FirecrawlClient {
    /**
     * Scrapes a public URL and returns clean markdown suitable for RAG indexing.
     *
     * @param url - Page URL to scrape (must be reachable by Firecrawl)
     * @returns Markdown content, optional page title, and canonical source URL
     * @throws {APIError} ServiceUnavailable when Firecrawl is not configured; BadRequest when extraction fails
     */
    static async scrape(url: string) {
        if (!env.FIRECRAWL_API_KEY) {
            throw APIError.ServiceUnavailable("Firecrawl is not configured on the server");
        }

        const client = new Firecrawl({ apiKey: env.FIRECRAWL_API_KEY });
        const result = await client.scrape(url, {
            formats: ["markdown"],
        });

        const markdown = result.markdown?.trim();

        if (!markdown) {
            throw APIError.BadRequest("Could not extract content from this URL");
        }

        return {
            markdown,
            title: result.metadata?.title,
            sourceUrl: result.metadata?.sourceURL ?? url,
        };
    }
}
