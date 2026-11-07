/**
 * YouTube client for transcript extraction (YOUTUBE source imports).
 */

import { YoutubeTranscript } from "youtube-transcript";
import { logger } from "../../../config/logger.js";
import { APIError } from "../../../shared/http/api-error.js";

/** How long to wait for YouTube's oEmbed endpoint before going without the title and channel. */
const OEMBED_TIMEOUT_MS = 4_000;

/**
 * Looks up a video's title and channel through YouTube's public oEmbed endpoint.
 * Best effort: any failure just means the import goes without them.
 *
 * @param videoId - The 11-character video id
 */
async function fetchVideoInfo(videoId: string) {
    try {
        const response = await fetch(
            `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
                `https://www.youtube.com/watch?v=${videoId}`,
            )}`,
            { signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS) },
        );
        if (!response.ok) {
            return {};
        }

        const info = (await response.json()) as { title?: unknown; author_name?: unknown };
        return {
            title: typeof info.title === "string" ? info.title : undefined,
            author: typeof info.author_name === "string" ? info.author_name : undefined,
        };
    } catch (error) {
        logger.debug({ kind: "ingest", videoId, err: error }, "YouTube oEmbed lookup failed");
        return {};
    }
}

/**
 * Length of the video in seconds, from where the last caption ends.
 *
 * The transcript library reports offsets in milliseconds for some caption formats and in seconds
 * for others. A single caption longer than 60 units would be over a minute in seconds, which no
 * caption is, so such values are read as milliseconds.
 *
 * @param segments - Caption segments with `offset` and `duration`
 * @returns Whole seconds, or 0 when the segments carry no timing
 */
function durationOf(segments: { offset: number; duration: number }[]) {
    const last = segments[segments.length - 1];
    if (!last) {
        return 0;
    }

    const inMilliseconds = segments.some((segment) => segment.duration > 60);
    const end = last.offset + last.duration;
    return Math.round(inMilliseconds ? end / 1000 : end);
}

/** Fetches YouTube transcripts. */
export class YoutubeClient {
    /**
     * Fetches caption transcript text for a YouTube video.
     *
     * @param url - YouTube page URL (watch, youtu.be, embed, or shorts)
     * @returns Video id, concatenated transcript text, and when known the title, channel and length in seconds
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
            const [segments, info] = await Promise.all([
                YoutubeTranscript.fetchTranscript(videoId),
                fetchVideoInfo(videoId),
            ]);
            const content = segments
                .map((segment) => segment.text)
                .join(" ")
                .trim();

            if (!content) {
                throw APIError.BadRequest("No transcript found for this video");
            }

            return {
                videoId,
                content,
                title: info.title,
                author: info.author,
                durationSeconds: durationOf(segments),
            };
        } catch (error) {
            if (error instanceof APIError) {
                throw error;
            }
            logger.warn({ kind: "ingest", videoId, err: error }, "YouTube transcript fetch failed");
            throw APIError.BadRequest(
                "Could not fetch transcript. The video may not have captions.",
            );
        }
    }
}
