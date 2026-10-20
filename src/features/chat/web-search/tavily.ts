/**
 * Web search for the chat `web_search` tool, backed by Tavily.
 */

import { TavilyClient } from "../../../config/tavily.js";

/** One normalised web result. */
export type TavilySearchResult = {
    title: string;
    url: string;
    content: string;
    score?: number;
};

/** Normalised response for one search query. */
export type TavilySearchResponse = {
    query: string;
    answer?: string;
    results: TavilySearchResult[];
};

/** Runs Tavily web searches and formats them for the chat model. */
export class TavilySearch {
    /**
     * Runs a web search query.
     *
     * @param query - Natural-language search query from the model
     * @returns Up to 5 normalized results plus an optional answer summary
     * @throws {APIError} ServiceUnavailable when `TAVILY_API_KEY` is not configured
     */
    static async search(query: string): Promise<TavilySearchResponse> {
        const response = await TavilyClient.get().search(query, {
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
     * @returns Text block returned to the model as the tool result
     */
    static formatResultsForPrompt(response: TavilySearchResponse, startIndex = 0): string {
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
