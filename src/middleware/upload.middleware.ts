import multer from 'multer';

const MAX_PDF_SIZE_BYTES = 10 * 1024 * 1024;


export const pdfUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PDF_SIZE_BYTES,
    },
    fileFilter: (_req, file, cb) => {
        if (file.mimetype === "application/pdf") {
            cb(null, true);
            return
        } 

        cb(new Error("Only PDF files are allowed"));
    }
})


export const uploadSinglePdf = pdfUpload.single("file");