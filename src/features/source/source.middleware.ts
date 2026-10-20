/** Multer upload middleware for PDF sources. */

import multer from "multer";
import { APIError } from "../../shared/http/api-error.js";

/** Maximum accepted PDF size (10 MB). */
const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

/** MIME types accepted for PDFs (`application/octet-stream` is also tolerated in the filter). */
const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/**
 * Multer config for PDF uploads.
 *
 * This is only a first, cheap filter on what the client *claims* (extension + MIME type),
 * both of which can be spoofed. The file's actual bytes are verified by `PdfValidator`
 * in the service before anything is stored.
 */
const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PDF_SIZE_BYTES,
        files: 1,
        fields: 5,
        fieldSize: 10 * 1024,
        parts: 10,
    },
    fileFilter: (_req, file, cb) => {
        const hasPdfExtension = file.originalname.toLowerCase().endsWith(".pdf");
        const hasPdfMime =
            PDF_MIME_TYPES.has(file.mimetype) || file.mimetype === "application/octet-stream";

        if (hasPdfExtension && hasPdfMime) {
            cb(null, true);
            return;
        }

        cb(APIError.BadRequest("Only PDF files are allowed"));
    },
});

/** Express middleware that parses one PDF from the multipart field `file` into `req.file` (in memory). */
export const uploadSinglePdf = pdfUpload.single("file");
