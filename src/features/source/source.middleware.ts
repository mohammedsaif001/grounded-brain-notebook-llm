import multer from 'multer';
import { APIError } from '../../shared/http/api-error.js';

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;


export const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PDF_SIZE_BYTES,
    },
    fileFilter: (_req, file, cb) => {
        const isPdfMime =
            file.mimetype === "application/pdf" ||
            file.mimetype === "application/x-pdf";
        const isPdfExt = file.originalname.toLowerCase().endsWith(".pdf");

        if (isPdfMime || (isPdfExt && file.mimetype === "application/octet-stream")) {
            cb(null, true);
            return;
        }

        cb(APIError.BadRequest("Only PDF files are allowed"));
    },
})


export const uploadSinglePdf = pdfUpload.single("file");