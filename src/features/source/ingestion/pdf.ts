/**
 * PDF text extraction using `unpdf`.
 *
 * Supports in-memory buffers and Cloudinary-hosted PDFs with signed URL
 * fallback when public access returns 401.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { logger } from "../../../config/logger.js";
import { CloudinaryStorage } from "./cloudinary.js";

/** A chapter-level entry of a PDF's outline (bookmarks), with the 1-based page it starts on. */
export type PdfOutlineEntry = { title: string; page: number };

/** Result of extracting text from a PDF document. */
export type PdfExtractResult = {
    text: string;
    pages: string[];
    pageCount: number;
    /** Author from the PDF's document properties, when it has one. */
    author?: string | undefined;
    /** Top-level outline entries in page order; empty when the PDF has no bookmarks. */
    outline: PdfOutlineEntry[];
};

/** An opened PDF document. */
type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * Resolves the page an outline destination points at.
 *
 * @param pdf - The opened document
 * @param dest - The outline item's destination: a name, an explicit destination, or nothing
 * @returns 1-based page number, or `null` when it can't be resolved
 */
async function pageOfDestination(pdf: PdfDocument, dest: unknown): Promise<number | null> {
    try {
        const resolved = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
        const target: unknown = Array.isArray(resolved) ? (resolved as unknown[])[0] : undefined;

        if (typeof target === "number") {
            return target + 1;
        }
        if (target && typeof target === "object") {
            return (
                (await pdf.getPageIndex(target as Parameters<PdfDocument["getPageIndex"]>[0])) + 1
            );
        }
    } catch {
        // An unresolvable bookmark is simply left out.
    }
    return null;
}

/**
 * Reads the PDF's top-level bookmarks (usually its chapters) and the pages they start on, plus
 * the author. Best effort: a PDF without bookmarks or with odd metadata gives empty values.
 *
 * @param pdf - The opened document
 */
async function readPdfInfo(pdf: PdfDocument) {
    let author: string | undefined;
    try {
        const { info } = await pdf.getMetadata();
        const value = (info as { Author?: unknown }).Author;
        author = typeof value === "string" && value.trim() ? value.trim() : undefined;
    } catch {
        // No readable document properties.
    }

    const outline: PdfOutlineEntry[] = [];
    try {
        for (const item of (await pdf.getOutline()) ?? []) {
            const title = item.title.trim();
            const page = title ? await pageOfDestination(pdf, item.dest) : null;
            if (page !== null) {
                outline.push({ title, page });
            }
        }
    } catch {
        // No readable outline.
    }

    return { author, outline: outline.sort((a, b) => a.page - b.page) };
}

/**
 * Downloads a PDF.
 *
 * @param url - Where to fetch the file from
 * @returns The raw bytes
 * @throws {Error} `Failed to download PDF (<status>)` for non-OK responses
 */
async function downloadPdf(url: string) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to download PDF (${response.status})`);
    }

    return response.arrayBuffer();
}

/** Extracts text from PDFs held in memory or stored on Cloudinary. */
export class PdfExtractor {
    /**
     * Extracts plain text from PDF bytes.
     *
     * @param buffer - PDF bytes
     * @returns Joined full text, per-page strings, and total page count
     * @throws When no text could be extracted from the PDF
     */
    static async fromBuffer(buffer: ArrayBuffer | Buffer): Promise<PdfExtractResult> {
        const arrayBuffer =
            buffer instanceof Buffer
                ? (buffer.buffer.slice(
                      buffer.byteOffset,
                      buffer.byteOffset + buffer.byteLength,
                  ) as ArrayBuffer)
                : buffer;

        const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
        const { totalPages, text } = await extractText(pdf, { mergePages: false });
        const { author, outline } = await readPdfInfo(pdf);

        const pages = Array.isArray(text) ? text.map((page) => page.trim()) : [String(text).trim()];

        const joined = pages.filter(Boolean).join("\n\n");

        if (!joined) {
            throw new Error("No text could be extracted from the PDF");
        }

        return {
            text: joined,
            pages,
            pageCount: totalPages,
            author,
            outline,
        };
    }

    /**
     * Extracts text from a PDF stored on Cloudinary.
     *
     * Tries the public `fileUrl` first; on 401, falls back to a signed download URL
     * when `publicId` and Cloudinary API credentials are available.
     *
     * @param input.fileUrl - Public Cloudinary URL of the PDF
     * @param input.publicId - Cloudinary public id, needed for the signed fallback
     * @param input.resourceType - Cloudinary resource type (defaults to `raw`)
     * @returns Joined full text, per-page strings, and total page count
     * @throws When download or extraction fails, or a signed URL cannot be generated
     */
    static async fromCloudinary(input: {
        fileUrl: string;
        publicId?: string;
        resourceType?: "raw" | "image";
    }): Promise<PdfExtractResult> {
        try {
            return await this.fromBuffer(await downloadPdf(input.fileUrl));
        } catch (error) {
            const isUnauthorized = error instanceof Error && error.message.includes("(401)");

            if (!isUnauthorized || !input.publicId) {
                throw error;
            }

            logger.debug(
                { kind: "ingest", publicId: input.publicId },
                "Cloudinary public URL returned 401, retrying with a signed URL",
            );
            logger.debug(
                { kind: "ingest", publicId: input.publicId },
                "Cloudinary public URL returned 401, retrying with a signed URL",
            );
            const signedUrl = CloudinaryStorage.getSignedDownloadUrl(
                input.publicId,
                input.resourceType ?? "raw",
            );

            if (!signedUrl) {
                throw new Error(
                    "PDF download requires authentication. Add CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to server/.env, or re-upload the PDF.",
                    { cause: error },
                );
            }

            return this.fromBuffer(await downloadPdf(signedUrl));
        }
    }
}
