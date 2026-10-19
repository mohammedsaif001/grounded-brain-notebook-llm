/**
 * Cloudinary configuration.
 *
 * Uploads use an unsigned preset (no API secret needed); signed download URLs for
 * private PDFs need the API key and secret. Upload logic lives in `features/source/ingestion/cloudinary.ts`.
 */

import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";

export const cloudinaryConfig = {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
    /** Unsigned PDF uploads are possible. */
    canUpload: !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_UPLOAD_PRESET),
    /** Signed download URLs are possible. */
    canSign: !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET),
} as const;

if (cloudinaryConfig.canSign) {
    cloudinary.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        secure: true,
    });
}

/** Cloudinary SDK, configured with API credentials when they are set. */
export { cloudinary };
