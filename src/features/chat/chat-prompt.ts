/**
 * Prompt construction and citation parsing for RAG chat.
 *
 * Pure helpers with no I/O; retrieval itself lives in `RetrievalService`.
 */

import {
    CHAT_GROUNDED_RULES,
    CHAT_MEMORIES_INTRO,
    CHAT_NO_INVENTED_CITATIONS,
    CHAT_NO_SOURCES_NOTICE,
    CHAT_NO_SOURCES_WITHOUT_WEB_SEARCH,
    CHAT_NO_SOURCES_WITH_WEB_SEARCH,
    CHAT_SUMMARY_INTRO,
    CHAT_SYSTEM_BASE,
    CHAT_WEB_SEARCH_RULES,
    chatUserPrompt,
} from "../../config/prompts.js";
import type { RetrievedChunk } from "./chat.types.js";

/**
 * Neutralizes text that could close or spoof the XML-style delimiters used in prompts.
 *
 * @param text - Untrusted text (source content, titles, memories)
 * @returns Text safe to embed inside a delimited block
 */
function escapeDelimiters(text: string) {
    return text.replace(/<\/?(sources|source|memories)\b/gi, (match) => match.replace("<", "&lt;"));
}

export class ChatPrompt {
    /**
     * Builds the chat system prompt: behavior rules, user memories, and conversation summary.
     *
     * Retrieved source text is deliberately NOT placed here; it goes into the user turn via
     * {@link ChatPrompt.buildUserPrompt} so untrusted document content never carries
     * system-level authority.
     */
    static buildSystemPrompt(input: {
        hasSourceContext: boolean;
        conversationSummary?: string | null;
        userMemories?: string[];
        webSearchEnabled?: boolean;
    }) {
        const sections: string[] = [...CHAT_SYSTEM_BASE];

        if (input.webSearchEnabled) {
            sections.push(...CHAT_WEB_SEARCH_RULES);
        }

        if (input.userMemories?.length) {
            const memoryBlock = input.userMemories
                .map((memory) => `- ${escapeDelimiters(memory)}`)
                .join("\n");

            sections.push(CHAT_MEMORIES_INTRO, `<memories>\n${memoryBlock}\n</memories>`);
        }

        const summary = input.conversationSummary?.trim();
        if (summary) {
            sections.push(CHAT_SUMMARY_INTRO, summary);
        }

        if (!input.hasSourceContext) {
            sections.push(
                CHAT_NO_SOURCES_NOTICE,
                input.webSearchEnabled
                    ? CHAT_NO_SOURCES_WITH_WEB_SEARCH
                    : CHAT_NO_SOURCES_WITHOUT_WEB_SEARCH,
                CHAT_NO_INVENTED_CITATIONS,
            );
            return sections.join("\n");
        }

        sections.push(...CHAT_GROUNDED_RULES);

        return sections.join("\n");
    }

    /**
     * Wraps the user's message with the retrieved chunks as a delimited data block.
     *
     * @param chunks - Retrieved chunks; their 1-based position is the citation number
     * @param userText - The user's actual question
     */
    static buildUserPrompt(chunks: RetrievedChunk[], userText: string) {
        if (chunks.length === 0) {
            return userText;
        }

        const sources = chunks
            .map((chunk, index) => {
                const attributes = [
                    `id="${index + 1}"`,
                    `title="${escapeDelimiters(chunk.sourceTitle).replace(/"/g, "'")}"`,
                    `type="${chunk.sourceType}"`,
                    ...(chunk.page ? [`page="${chunk.page}"`] : []),
                ].join(" ");
                return `<source ${attributes}>\n${escapeDelimiters(chunk.text)}\n</source>`;
            })
            .join("\n");

        return chatUserPrompt(sources, userText);
    }

    /**
     * Extracts the citation markers the model actually used in its answer.
     *
     * Handles `[1]`, `[W2]`, and grouped forms like `[1, 3]` or `[W1, W2]`.
     *
     * @returns 1-based source numbers and web result numbers that were cited
     */
    static extractCitationMarkers(text: string) {
        const sources = new Set<number>();
        const web = new Set<number>();

        for (const match of text.matchAll(/\[(W?\d+(?:\s*,\s*W?\d+)*)\]/g)) {
            for (const marker of match[1].split(",")) {
                const trimmed = marker.trim();
                if (trimmed.startsWith("W")) {
                    web.add(Number(trimmed.slice(1)));
                } else {
                    sources.add(Number(trimmed));
                }
            }
        }

        return { sources, web };
    }
}
