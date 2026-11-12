/**
 * Guard layer 1: normalizes untrusted chat input before anything else reads it.
 *
 * Removes characters that are invisible to humans but readable by models, which are a common
 * way to smuggle instructions past reviewers and regex filters, and enforces a length cap.
 */

import { CHAT_MAX_MESSAGE_CHARS } from "../../../config/ai.config.js";
import { APIError } from "../../../shared/http/api-error.js";

/**
 * Code-point ranges stripped from messages: C0/C1 control characters (except tab, newline and
 * carriage return), soft hyphen, Mongolian vowel separator, zero-width characters and
 * directional marks, bidi embeddings/overrides and isolates (the "Trojan Source" set), word
 * joiners, BOM, interlinear annotation marks, and Unicode "tag" characters (used for invisible
 * ASCII smuggling). Numeric so the source file contains no invisible characters itself.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x0000, 0x0008],
    [0x000b, 0x000c],
    [0x000e, 0x001f],
    [0x007f, 0x009f],
    [0x00ad, 0x00ad],
    [0x180e, 0x180e],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffb],
    [0xe0000, 0xe007f],
];

/** Formats a code point as a regex escape, e.g. `\u{200b}`. */
const codePoint = (value: number) => String.raw`\u{${value.toString(16)}}`;

const INVISIBLE_CHARS = new RegExp(
    `[${INVISIBLE_RANGES.map(([from, to]) => (from === to ? codePoint(from) : `${codePoint(from)}-${codePoint(to)}`)).join("")}]`,
    "gu",
);

/** Prepares user messages for the chat pipeline. */
export class InputSanitizer {
    /**
     * Normalizes and strips hidden characters from a chat message.
     *
     * NFKC folds look-alike forms (full-width letters, ligatures) to plain text, so later
     * pattern checks see what the model sees.
     *
     * @param text - Raw message text from the client
     * @returns The cleaned, trimmed message
     * @throws {APIError} BadRequest when the message is empty after cleaning or too long
     */
    static sanitize(text: string) {
        const cleaned = text
            .normalize("NFKC")
            .replace(INVISIBLE_CHARS, "")
            .replace(/\r\n?/g, "\n")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();

        if (!cleaned) {
            throw APIError.BadRequest("A user message is required");
        }

        if (cleaned.length > CHAT_MAX_MESSAGE_CHARS) {
            throw APIError.BadRequest(
                `Message is too long. Keep it under ${CHAT_MAX_MESSAGE_CHARS} characters.`,
            );
        }

        return cleaned;
    }
}
