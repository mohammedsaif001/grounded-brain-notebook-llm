import multer from "multer";
import { APIError } from "../../shared/http/api-error.js";

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;

const PDF_MIME_TYPES = new Set(["application/pdf", "application/x-pdf"]);

/**
 * Multer config for PDF uploads.
 *
 * This is only a first, cheap filter on what the client *claims* (extension + MIME type),
 * both of which can be spoofed. The file's actual bytes are verified by `PdfValidator`
 * in the service before anything is stored.
 */
export const pdfUpload = multer({
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

export const uploadSinglePdf = pdfUpload.single("file");
