/**
 * YouTube client for transcript extraction (YOUTUBE source imports).
 */

import { YoutubeTranscript } from "youtube-transcript";
import { APIError } from "../../../shared/http/api-error.js";

export class YoutubeClient {
    /**
     * Fetches caption transcript text for a YouTube video.
     *
     * @param url - YouTube page URL (watch, youtu.be, embed, or shorts)
     * @returns Video id and concatenated transcript text
     * @throws {APIError} BadRequest when the URL is invalid, captions are missing, or fetch fails
     */
    static async fetchTranscript(url: string) {
        const videoId =
            url.match(
                /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/,
            )?.[1] ?? url.match(/youtube\.com\/shorts\/([\w-]{11})/)?.[1];

        if (!videoId) {
            throw APIError.BadRequest("Enter a valid YouTube URL");
        }

        try {
            const segments = await YoutubeTranscript.fetchTranscript(videoId);
            const content = segments.map((segment) => segment.text).join(" ").trim();

            if (!content) {
                throw APIError.BadRequest("No transcript found for this video");
            }

            return { videoId, content };
        } catch (error) {
            if (error instanceof APIError) {
                throw error;
            }
            throw APIError.BadRequest(
                "Could not fetch transcript. The video may not have captions.",
            );
        }
    }
}
