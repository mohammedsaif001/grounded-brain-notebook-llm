/**
 * Small measurements of source text shown in the library (word counts).
 */

/**
 * Counts the words in a text.
 *
 * @param text - Any text; whitespace separates words
 * @returns Number of words, 0 for blank text
 */
export function countWords(text: string) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}
