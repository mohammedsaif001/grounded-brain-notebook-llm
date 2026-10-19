import type { UIMessage } from "ai";

/** Helpers for AI SDK {@link UIMessage} payloads sent by `useChat`. */
export class UIMessageUtils {
    /** Joins all `type: "text"` parts of a message. */
    static getText(message: UIMessage) {
        return message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    }

    /**
     * Finds the most recent non-empty user message text.
     *
     * @returns Latest user message text, or `null` when none found
     */
    static getLastUserText(messages: UIMessage[]) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message.role === "user") {
                const text = this.getText(message).trim();
                if (text) {
                    return text;
                }
            }
        }

        return null;
    }
}
