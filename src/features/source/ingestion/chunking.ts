/**
 * Text chunking for RAG indexing, built on LangChain's recursive splitter.
 *
 * Chunks are sized in characters; token counts are measured with the embedding model's
 * tokenizer (`cl100k_base`, used by `text-embedding-3-*`) and stored for reference.
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { CHUNK_OVERLAP, CHUNK_SIZE } from "../../../config/ai.config.js";

/** One piece of source text ready for embedding. */
export type TextChunk = {
    index: number;
    content: string;
    tokenCount: number;
    metadata?: Record<string, unknown>;
};

/** Tried in order: paragraphs → lines → sentences → words → characters. */
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/** Recursive splitter configured with `CHUNK_SIZE` / `CHUNK_OVERLAP`. */
const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    separators: SEPARATORS,
});

/** Tokenizer matching the embedding model, used only for `tokenCount`. */
const tokenizer = new Tiktoken(cl100k_base);

/**
 * Splits text into trimmed, non-empty parts.
 *
 * @param text - Text to split
 * @returns Chunk strings in document order
 */
async function split(text: string) {
    const parts = await splitter.splitText(text.trim());
    return parts.map((part) => part.trim()).filter(Boolean);
}

/** Matches a markdown heading line; captures its text. */
const HEADING_PATTERN = /^#{1,6}[ \t]+(.+?)[ \t#]*$/gm;

/** Splits extracted text into embedding-sized chunks. */
export class TextChunker {
    /**
     * Splits any plain string into numbered chunks.
     *
     * @param text - The full document text
     * @param metadata - Extra fields attached to every chunk (e.g. `{ page: 3 }`)
     * @returns Chunks with 0-based `index` and measured `tokenCount`
     */
    static async chunkText(text: string, metadata?: Record<string, unknown>): Promise<TextChunk[]> {
        const parts = await split(text);

        return parts.map((content, index) => ({
            index,
            content,
            tokenCount: tokenizer.encode(content).length,
            metadata,
        }));
    }

    /**
     * Chunks markdown, tagging each chunk with the heading it sits under (`metadata.section`).
     *
     * Chunks before the first heading have no section.
     *
     * @param text - Markdown text, e.g. a scraped web page
     * @returns Chunks in document order
     */
    static async chunkMarkdown(text: string): Promise<TextChunk[]> {
        const body = text.trim();
        const headings = [...body.matchAll(HEADING_PATTERN)].map((match) => ({
            at: match.index,
            title: match[1].trim(),
        }));
        const parts = await split(body);

        // Chunks overlap, so each search starts at the previous chunk's start, not its end.
        let from = 0;
        let section: string | undefined;

        return parts.map((content, index) => {
            const found = body.indexOf(content, from);
            if (found !== -1) {
                from = found;
                section = headings.filter((heading) => heading.at <= found).pop()?.title;
            }

            return {
                index,
                content,
                tokenCount: tokenizer.encode(content).length,
                ...(section ? { metadata: { section } } : {}),
            };
        });
    }

    /**
     * Chunks a multi-page document (e.g. PDF pages) while preserving page numbers.
     *
     * Chunks never span two pages, every chunk gets `metadata.page` (1-based), and
     * `index` is numbered globally across pages. Empty pages are skipped. When the document has
     * an outline, chunks also get `metadata.chapter`: the last chapter that started on or
     * before their page.
     *
     * @param pages - Array of page texts, e.g. from `PdfExtractor`
     * @param outline - Chapter entries (title and start page), in page order
     * @returns Chunks tagged with their page number and chapter
     */
    static async chunkPages(
        pages: string[],
        outline: { title: string; page: number }[] = [],
    ): Promise<TextChunk[]> {
        const chunks: TextChunk[] = [];

        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const page = pageIndex + 1;
            const chapter = outline.filter((entry) => entry.page <= page).pop()?.title;
            const pageChunks = await this.chunkText(pages[pageIndex], {
                page,
                ...(chapter ? { chapter } : {}),
            });

            for (const chunk of pageChunks) {
                chunks.push({ ...chunk, index: chunks.length });
            }
        }

        return chunks;
    }

    /**
     * Chunks repository files while preserving file paths.
     *
     * Chunks never span two files, every chunk gets `metadata.path`, and `index` is
     * numbered globally across files. Each chunk starts with a `File: <path>` line so
     * the path is part of the embedded text and "where is X handled?" questions match.
     *
     * @param files - Repository files, e.g. from `GithubRepoClient`
     * @returns Chunks tagged with the path of their file
     */
    static async chunkFiles(files: { path: string; content: string }[]): Promise<TextChunk[]> {
        const chunks: TextChunk[] = [];

        for (const file of files) {
            const fileChunks = await this.chunkText(file.content, { path: file.path });

            for (const chunk of fileChunks) {
                const content = `File: ${file.path}
${chunk.content}`;
                chunks.push({
                    ...chunk,
                    index: chunks.length,
                    content,
                    tokenCount: tokenizer.encode(content).length,
                });
            }
        }

        return chunks;
    }
}
