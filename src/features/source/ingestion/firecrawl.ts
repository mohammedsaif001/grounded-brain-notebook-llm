/**
 * Scrapes website content into markdown sources via Firecrawl.
 */

import { FirecrawlClient } from "../../../config/firecrawl.js";
import { APIError } from "../../../shared/http/api-error.js";

/** Turns web pages into markdown using Firecrawl. */
export class FirecrawlScraper {
    /**
     * Scrapes a public URL and returns clean markdown suitable for RAG indexing.
     *
     * @param url - Page URL to scrape (must be reachable by Firecrawl)
     * @returns Markdown content, optional page title, and canonical source URL
     * @throws {APIError} ServiceUnavailable when Firecrawl is not configured; BadRequest when extraction fails
     */
    static async scrape(url: string) {
        const result = await FirecrawlClient.get().scrape(url, {
            formats: ["markdown"],
        });

        const markdown = result.markdown?.trim();

        if (!markdown) {
            throw APIError.BadRequest("Could not extract content from this URL");
        }

        // Pages describe their author in a few ways; take the first string we find.
        const metadata = (result.metadata ?? {}) as Record<string, unknown>;
        const author = [metadata.author, metadata.ogSiteName, metadata.publisher].find(
            (value): value is string => typeof value === "string" && value.trim() !== "",
        );

        return {
            markdown,
            title: result.metadata?.title,
            sourceUrl: result.metadata?.sourceURL ?? url,
            author: author?.trim(),
        };
    }
}
