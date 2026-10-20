/**
 * PDF text extraction using `unpdf`.
 *
 * Supports in-memory buffers and Cloudinary-hosted PDFs with signed URL
 * fallback when public access returns 401.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { CloudinaryStorage } from "./cloudinary.js";

/** Result of extracting text from a PDF document. */
export type PdfExtractResult = {
    text: string;
    pages: string[];
    pageCount: number;
};

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

        const pages = Array.isArray(text) ? text.map((page) => page.trim()) : [String(text).trim()];

        const joined = pages.filter(Boolean).join("\n\n");

        if (!joined) {
            throw new Error("No text could be extracted from the PDF");
        }

        return {
            text: joined,
            pages,
            pageCount: totalPages,
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
