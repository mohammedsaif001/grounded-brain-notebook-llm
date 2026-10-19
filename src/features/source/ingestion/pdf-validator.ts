/**
 * Content-based validation for uploaded PDFs.
 *
 * File extensions and MIME types are client-controlled, so a renamed executable or
 * HTML file sails through them. This checks the bytes themselves and rejects PDFs that
 * carry active content, since uploaded files are later served back to users from Cloudinary.
 */

import { getDocumentProxy } from "unpdf";
import { APIError } from "../../../shared/http/api-error.js";

/** The PDF spec allows the `%PDF-` header anywhere in the first 1024 bytes. */
const HEADER_SEARCH_BYTES = 1024;
const PDF_HEADER = Buffer.from("%PDF-");

/** Guards against page-count bombs that are cheap to upload but expensive to process. */
const MAX_PDF_PAGES = 1000;

/**
 * PDF name tokens for active content: scripts, launching external programs, embedded
 * files, Flash/3D, and XFA forms (which can carry scripts). Checked in the raw bytes;
 * the parsed checks below also catch JavaScript and attachments hidden in compressed streams.
 */
const ACTIVE_CONTENT_PATTERN =
    /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|ImportData|SubmitForm)\b/;

const ACTIVE_CONTENT_MESSAGE =
    "This PDF contains active content (scripts, embedded files, or launch actions) and was rejected for security reasons.";

export class PdfValidator {
    /**
     * Verifies that `buffer` is a well-formed PDF without active content.
     *
     * @throws {APIError} BadRequest when the file is not a PDF, is password-protected,
     *   has too many pages, or contains scripts, attachments, or launch actions
     */
    static async assertSafe(buffer: Buffer) {
        if (buffer.subarray(0, HEADER_SEARCH_BYTES).indexOf(PDF_HEADER) === -1) {
            throw APIError.BadRequest("The uploaded file is not a valid PDF.");
        }

        if (ACTIVE_CONTENT_PATTERN.test(buffer.toString("latin1"))) {
            throw APIError.BadRequest(ACTIVE_CONTENT_MESSAGE);
        }

        let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
        try {
            // Copy: pdf.js may transfer/detach the buffer it is given.
            pdf = await getDocumentProxy(new Uint8Array(buffer));
        } catch (error) {
            if (error instanceof Error && error.name === "PasswordException") {
                throw APIError.BadRequest("Password-protected PDFs are not supported.");
            }
            throw APIError.BadRequest("The uploaded file could not be read as a PDF.");
        }

        try {
            if (pdf.numPages > MAX_PDF_PAGES) {
                throw APIError.BadRequest(`PDFs can have at most ${MAX_PDF_PAGES} pages.`);
            }

            const [attachments, documentActions] = await Promise.all([
                pdf.getAttachments(),
                pdf.getJSActions(),
            ]);

            if (
                (attachments && attachments.size > 0) ||
                (documentActions && documentActions.size > 0)
            ) {
                throw APIError.BadRequest(ACTIVE_CONTENT_MESSAGE);
            }

            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
                const page = await pdf.getPage(pageNumber);
                const pageActions = await page.getJSActions();
                if (pageActions && pageActions.size > 0) {
                    throw APIError.BadRequest(ACTIVE_CONTENT_MESSAGE);
                }
            }
        } finally {
            await pdf.cleanup();
        }
    }

    /**
     * Makes a client-supplied filename safe to store and display: strips any path,
     * control characters, and unusual symbols, caps the length, and keeps a `.pdf` suffix.
     */
    static sanitizeFilename(originalName: string) {
        const baseName = originalName.split(/[\\/]/).pop() ?? "";
        const stem = baseName
            .replace(/\.pdf$/i, "")
            .normalize("NFKC")
            // eslint-disable-next-line no-control-regex -- stripping control characters is the point
            .replace(/[\u0000-\u001f\u007f]/g, "")
            .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 100);

        return `${stem || "document"}.pdf`;
    }
}
