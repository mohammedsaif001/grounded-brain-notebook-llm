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
     * Chunks a multi-page document (e.g. PDF pages) while preserving page numbers.
     *
     * Chunks never span two pages, every chunk gets `metadata.page` (1-based), and
     * `index` is numbered globally across pages. Empty pages are skipped.
     *
     * @param pages - Array of page texts, e.g. from `PdfExtractor`
     * @returns Chunks tagged with their page number
     */
    static async chunkPages(pages: string[]): Promise<TextChunk[]> {
        const chunks: TextChunk[] = [];

        for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
            const pageChunks = await this.chunkText(pages[pageIndex], { page: pageIndex + 1 });

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
