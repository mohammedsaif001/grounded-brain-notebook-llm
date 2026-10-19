
export type TextChunk = {
    index: number;
    content: string;
    metadata?: Record<string, unknown>;
};

/** Default maximum characters per chunk when no option is passed. */
const DEFAULT_CHUNK_SIZE = 1000;

/** Default overlap between consecutive chunks (helps preserve context at boundaries). */
const DEFAULT_CHUNK_OVERLAP = 100;

/**
 * Separators tried in order, from "most natural" to "most aggressive".
 *
 * The splitter splits on the first separator present in the text, then recursively
 * re-splits any piece that is still too large using the next separators in the list.
 * The empty string `""` means "split into individual characters" (last resort).
 */
const SEPARATORS = ["\n\n", "\n", ". ", " ", ""];

/**
 * Combines small text splits into chunks of at most `chunkSize`, with overlap.
 *
 * Think of this as packing sentences/paragraphs into boxes: keep adding splits
 * until the next one would overflow the box, then seal the box. The next box starts
 * with the tail of the previous one (up to `chunkOverlap` characters) so context
 * isn't lost at the boundary.
 *
 * @param splits - Pieces produced by splitting on one separator, each <= `chunkSize`
 * @param separator - The separator to re-join with (e.g. `"\n\n"`)
 * @param chunkSize - Maximum characters allowed in one merged chunk
 * @param chunkOverlap - Max characters carried over from the previous chunk
 * @returns An array of merged chunk strings
 *
 */
function mergeSplits(
    splits: string[],
    separator: string,
    chunkSize: number,
    chunkOverlap: number,
) {
    const docs: string[] = [];
    const sepLen = separator.length;
    let current: string[] = [];
    // Length of `current.join(separator)`.
    let total = 0;

    for (const split of splits) {
        const len = split.length;

        if (current.length > 0 && total + sepLen + len > chunkSize) {
            docs.push(current.join(separator));

            // Drop pieces from the front until what's left fits within the overlap
            // budget and leaves room for the incoming split.
            while (
                current.length > 0 &&
                (total > chunkOverlap ||
                    (total > 0 && total + sepLen + len > chunkSize))
            ) {
                total -= current[0].length + (current.length > 1 ? sepLen : 0);
                current.shift();
            }
        }

        current.push(split);
        total += len + (current.length > 1 ? sepLen : 0);
    }

    if (current.length > 0) {
        docs.push(current.join(separator));
    }

    return docs;
}

/**
 * Splits raw text into chunk strings using a recursive separator strategy.
 *
 * **How it works (step by step):**
 * 1. Split on the coarsest separator present (paragraphs `\n\n` first)
 * 2. Pieces that fit are packed together by {@link mergeSplits}
 * 3. Pieces that are still too large are recursively split with the finer
 *    separators (lines → sentences → words → characters)
 *
 * Every chunk is therefore guaranteed to be at most `chunkSize` characters, while
 * keeping the most natural boundaries possible.
 *
 * @param text - Full text to split
 * @param chunkSize - Max characters per chunk
 * @param chunkOverlap - Characters carried over between adjacent chunks
 * @param separators - Remaining separators to try (finest last)
 * @returns Array of chunk strings (may include whitespace-only entries; caller filters)
 *
 */
function splitText(
    text: string,
    chunkSize: number,
    chunkOverlap: number,
    separators: string[] = SEPARATORS,
): string[] {
    let separatorIndex = separators.length - 1;
    for (let i = 0; i < separators.length; i += 1) {
        if (separators[i] === "" || text.includes(separators[i])) {
            separatorIndex = i;
            break;
        }
    }

    const separator = separators[separatorIndex];
    const finerSeparators = separators.slice(separatorIndex + 1);
    const splits = separator ? text.split(separator) : Array.from(text);

    const chunks: string[] = [];
    let pending: string[] = [];

    for (const split of splits) {
        if (!split) {
            continue;
        }

        if (split.length <= chunkSize) {
            pending.push(split);
            continue;
        }

        if (pending.length > 0) {
            chunks.push(...mergeSplits(pending, separator, chunkSize, chunkOverlap));
            pending = [];
        }

        chunks.push(...splitText(split, chunkSize, chunkOverlap, finerSeparators));
    }

    if (pending.length > 0) {
        chunks.push(...mergeSplits(pending, separator, chunkSize, chunkOverlap));
    }

    return chunks;
}

/**
 * Public API: split any plain string into numbered `TextChunk` objects.
 *
 * This is the function you call for articles, transcripts, scraped web text, etc.
 * Each chunk gets a sequential `index` and optional shared `metadata`.
 *
 * @param text - The full document text
 * @param options.chunkSize - Max characters per chunk (default: 1000)
 * @param options.chunkOverlap - Overlap for character-level splits (default: 100)
 * @param options.metadata - Extra fields attached to every chunk (e.g. `{ sourceId: "abc" }`)
 * @returns Array of `TextChunk` ready for embedding/storage
 */
export function chunkText(
    text: string,
    options: {
        chunkSize?: number;
        chunkOverlap?: number;
        metadata?: Record<string, unknown>;
    } = {},
): TextChunk[] {
    const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const parts = splitText(text.trim(), chunkSize, chunkOverlap)
        .map((part) => part.trim())
        .filter(Boolean);

    return parts.map((content, index) => ({
        index,
        content,
        metadata: options.metadata,
    }));
}

/**
 * Chunk a multi-page document (e.g. PDF pages) while preserving page numbers.
 *
 * Unlike `chunkText`, this:
 * - processes each page separately (chunks never span two pages)
 * - assigns `metadata.page` (1-based) to every chunk from that page
 * - re-numbers `index` globally across all pages (0, 1, 2, …)
 *
 * Empty or whitespace-only pages are skipped.
 *
 * @param pages - Array of page texts, e.g. from `extractPdfPages()`
 * @param options.chunkSize - Max characters per chunk (default: 1000)
 * @param options.chunkOverlap - Overlap for character-level splits (default: 100)
 * @returns Flat list of chunks from all pages with page metadata
 *
 */
export function chunkPages(
    pages: string[],
    options: {
        chunkSize?: number;
        chunkOverlap?: number;
    } = {},
): TextChunk[] {
    const chunks: TextChunk[] = [];
    let index = 0;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const pageText = pages[pageIndex].trim();
        if (!pageText) {
            continue;
        }

        const pageChunks = chunkText(pageText, {
            ...options,
            metadata: { page: pageIndex + 1 },
        });

        for (const chunk of pageChunks) {
            chunks.push({
                index,
                content: chunk.content,
                metadata: chunk.metadata,
            });
            index += 1;
        }
    }

    return chunks;
}
