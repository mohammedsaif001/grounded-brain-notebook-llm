/**
 * Guard layer 1: normalizes untrusted chat input before anything else reads it.
 *
 * Two views of the same text:
 * - {@link InputSanitizer.sanitize}: what is stored and sent to the model. Only characters with
 *   no legitimate use in a question are removed, so meaning is preserved (x², H₂O, emoji
 *   sequences, and scripts that rely on zero-width joiners such as Persian, Urdu and Hindi).
 * - {@link InputSanitizer.forDetection}: an aggressively folded copy used only for pattern
 *   checks, so look-alike and invisible-character tricks can't slip past them.
 */

import { CHAT_MAX_MESSAGE_CHARS } from "../../../config/ai.config.js";
import { APIError } from "../../../shared/http/api-error.js";

/** An inclusive range of Unicode code points. */
type CodePointRange = readonly [number, number];

/**
 * Removed from every message: C0/C1 control characters (except tab, newline and carriage
 * return), Mongolian vowel separator, zero-width space, bidi embeddings/overrides and isolates
 * (the "Trojan Source" set), word joiner and invisible operators, BOM, interlinear annotation
 * marks, and Unicode "tag" characters (used for invisible ASCII smuggling).
 *
 * Numeric so the source file itself contains no invisible characters.
 */
const ALWAYS_STRIPPED: CodePointRange[] = [
    [0x0000, 0x0008],
    [0x000b, 0x000c],
    [0x000e, 0x001f],
    [0x007f, 0x009f],
    [0x180e, 0x180e],
    [0x200b, 0x200b],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffb],
    [0xe0000, 0xe007f],
];

/**
 * Also removed from the detection copy: soft hyphen, zero-width non-joiner / joiner, and
 * left-to-right / right-to-left marks. These are legitimate in real text (emoji sequences,
 * Persian, Hindi, RTL scripts) but can split a keyword like "ign<ZWNJ>ore" to dodge a regex.
 */
const DETECTION_ONLY_STRIPPED: CodePointRange[] = [
    [0x00ad, 0x00ad],
    [0x200c, 0x200f],
];

/** Formats a code point as a regex escape, e.g. `\u{200b}`. */
const codePoint = (value: number) => String.raw`\u{${value.toString(16)}}`;

/**
 * Builds a global character-class regex from code-point ranges.
 *
 * @param ranges - Inclusive ranges to match
 */
function charClass(ranges: CodePointRange[]) {
    const body = ranges
        .map(([from, to]) =>
            from === to ? codePoint(from) : `${codePoint(from)}-${codePoint(to)}`,
        )
        .join("");
    return new RegExp(`[${body}]`, "gu");
}

const STRIPPED_CHARS = charClass(ALWAYS_STRIPPED);
const DETECTION_STRIPPED_CHARS = charClass([...ALWAYS_STRIPPED, ...DETECTION_ONLY_STRIPPED]);

/** Prepares user messages for the chat pipeline. */
export class InputSanitizer {
    /**
     * Cleans a chat message without changing its meaning.
     *
     * Uses NFC (canonical composition), which only merges equivalent encodings such as
     * "e" + combining accent → "é". NFKC is deliberately not used here: it would rewrite
     * x² to x2 and H₂O to H2O.
     *
     * @param text - Raw message text from the client
     * @returns The cleaned, trimmed message
     * @throws {APIError} BadRequest when the message is empty after cleaning or too long
     */
    static sanitize(text: string) {
        const cleaned = text
            .normalize("NFC")
            .replace(STRIPPED_CHARS, "")
            .replace(/\r\n?/g, "\n")
            .replace(/\n{4,}/g, "\n\n\n")
            .trim();

        // Joiners and marks alone (kept above for real text) still count as an empty message.
        if (!cleaned.replace(DETECTION_STRIPPED_CHARS, "").trim()) {
            throw APIError.BadRequest("A user message is required");
        }

        if (cleaned.length > CHAT_MAX_MESSAGE_CHARS) {
            throw APIError.BadRequest(
                `Message is too long. Keep it under ${CHAT_MAX_MESSAGE_CHARS} characters.`,
            );
        }

        return cleaned;
    }

    /**
     * Folds text for pattern matching only; never store or display the result.
     *
     * NFKC maps look-alikes (full-width letters, ligatures, styled math letters) to plain
     * ASCII, and every invisible separator is removed.
     *
     * @param text - Text already passed through {@link InputSanitizer.sanitize}
     * @returns The folded text
     */
    static forDetection(text: string) {
        return text.normalize("NFKC").replace(DETECTION_STRIPPED_CHARS, "");
    }
}
