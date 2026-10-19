/**
 * Cloudinary client for PDF file storage.
 */

import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env.js";
import { APIError } from "../utils/api-error.js";

/** Normalized result returned after a successful Cloudinary upload. */
export type CloudinaryUploadResult = {
    secureUrl: string;
    publicId: string;
    bytes: number;
    originalFilename: string;
    resourceType: "raw" | "image";
};

type CloudinaryUploadResponse = {
    secure_url: string;
    public_id: string;
    bytes: number;
    resource_type?: string;
    error?: { message: string };
};

export class CloudinaryClient {
    /**
     * Builds a signed download URL for a private asset.
     *
     * @returns The signed URL, or `null` when API credentials are not configured
     */
    static getSignedDownloadUrl(
        publicId: string,
        resourceType: "raw" | "image" = "raw",
    ) {
        if (
            !env.CLOUDINARY_CLOUD_NAME ||
            !env.CLOUDINARY_API_KEY ||
            !env.CLOUDINARY_API_SECRET
        ) {
            return null;
        }

        cloudinary.config({
            cloud_name: env.CLOUDINARY_CLOUD_NAME,
            api_key: env.CLOUDINARY_API_KEY,
            api_secret: env.CLOUDINARY_API_SECRET,
            secure: true,
        });

        return cloudinary.url(publicId, {
            resource_type: resourceType,
            type: "upload",
            sign_url: true,
            secure: true,
        });
    }

    /**
     * Uploads a PDF buffer using the unsigned upload preset.
     *
     * @param buffer - PDF file bytes from Multer
     * @param filename - Original filename (used in the multipart form)
     * @returns Upload metadata including secure URL and public id
     * @throws {APIError} ServiceUnavailable when Cloudinary is not configured; BadRequest when the upload is rejected
     */
    static async uploadPdf(
        buffer: Buffer,
        filename: string,
    ): Promise<CloudinaryUploadResult> {
        const cloudName = env.CLOUDINARY_CLOUD_NAME;
        const uploadPreset = env.CLOUDINARY_UPLOAD_PRESET;

        if (!cloudName || !uploadPreset) {
            throw APIError.ServiceUnavailable("Cloudinary is not configured on the server");
        }

        const form = new FormData();
        form.append(
            "file",
            new Blob([new Uint8Array(buffer)], { type: "application/pdf" }),
            filename,
        );
        form.append("upload_preset", uploadPreset);
        form.append("folder", "grounded_brain_notebook_llm/pdfs");

        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
            { method: "POST", body: form },
        );

        const result = (await response.json()) as CloudinaryUploadResponse;

        if (!response.ok) {
            if (response.status === 403) {
                throw APIError.BadRequest(
                    "Cloudinary rejected the upload. Check CLOUDINARY_UPLOAD_PRESET in server/.env matches an unsigned preset in your dashboard.",
                );
            }

            throw APIError.BadRequest(
                result.error?.message ?? `Cloudinary upload failed (${response.status})`,
            );
        }

        return {
            secureUrl: result.secure_url,
            publicId: result.public_id,
            bytes: result.bytes,
            originalFilename: filename,
            resourceType: result.resource_type === "image" ? "image" : "raw",
        };
    }
}
