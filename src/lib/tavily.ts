/**
 * Tavily client for the chat `web_search` tool.
 */

import { tavily } from "@tavily/core";
import { env } from "../config/env.js";
import { APIError } from "../utils/api-error.js";

export type TavilySearchResult = {
    title: string;
    url: string;
    content: string;
    score?: number;
};

export type TavilySearchResponse = {
    query: string;
    answer?: string;
    results: TavilySearchResult[];
};

export class TavilyClient {
    private static client: ReturnType<typeof tavily> | null = null;

    /** Whether web search is available. */
    static isConfigured() {
        return !!env.TAVILY_API_KEY;
    }

    /**
     * Runs a web search query.
     *
     * @param query - Natural-language search query from the model
     * @returns Up to 5 normalized results plus an optional answer summary
     * @throws {APIError} ServiceUnavailable when `TAVILY_API_KEY` is not configured
     */
    static async search(query: string): Promise<TavilySearchResponse> {
        if (!env.TAVILY_API_KEY) {
            throw APIError.ServiceUnavailable("Web search is not configured on the server");
        }

        if (!this.client) {
            this.client = tavily({ apiKey: env.TAVILY_API_KEY });
        }

        const response = await this.client.search(query, {
            searchDepth: "basic",
            maxResults: 5,
            includeAnswer: true,
        });

        return {
            query,
            answer: typeof response.answer === "string" ? response.answer : undefined,
            results: (response.results ?? []).map((result) => ({
                title: result.title ?? result.url ?? "Untitled",
                url: result.url ?? "",
                content: result.content ?? "",
                score: result.score,
            })),
        };
    }

    /**
     * Formats results into the tool output shown to the chat model.
     *
     * Results are labeled `[W1]`, `[W2]`, etc. Numbering continues from `startIndex`
     * so labels stay unique across multiple searches in the same reply.
     *
     * @param response - Normalized search response
     * @param startIndex - Number of web results already shown to the model in this reply
     */
    static formatResultsForPrompt(
        response: TavilySearchResponse,
        startIndex = 0,
    ): string {
        if (response.results.length === 0) {
            return "No web results were found.";
        }

        const blocks = response.results.map(
            (result, index) =>
                `[W${startIndex + index + 1}] ${result.title} (${result.url})\n${result.content}`,
        );

        const parts = ["Web search results:"];

        if (response.answer) {
            parts.push(`Summary: ${response.answer}`);
        }

        parts.push(blocks.join("\n\n"));

        return parts.join("\n\n");
    }
}
