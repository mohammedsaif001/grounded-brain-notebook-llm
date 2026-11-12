/**
 * Chat guardrails: decides whether a message may reach the chat model.
 *
 * ```
 * raw text
 *   → InputSanitizer   (normalize, strip invisible chars, length cap)      layer 1
 *   → InjectionDetector (regex heuristics, no LLM call)                     layer 2
 *   → scope classifier  (small LLM, structured output, knows the sources)  layer 3
 *   → hardened system prompt + canary leak check in ChatService             layers 4-5
 * ```
 */

import { randomBytes } from "node:crypto";
import { generateText, Output, type UIMessageChunk } from "ai";
import { z } from "zod";
import { CHAT_GUARD_MAX_SOURCE_TITLES, CHAT_GUARD_MODEL } from "../../../config/ai.config.js";
import { logger } from "../../../config/logger.js";
import { openai } from "../../../config/openai.js";
import {
    CHAT_GUARD_REFUSALS,
    CHAT_GUARD_SYSTEM,
    chatGuardPrompt,
} from "../../../config/prompts.js";
import { escapeDelimiters } from "../chat-prompt.js";
import { InjectionDetector } from "./injection-detector.js";
import { InputSanitizer } from "./input-sanitizer.js";

/** Categories the scope classifier can return. */
const GUARD_CATEGORIES = [
    "in_scope",
    "conversational",
    "off_topic",
    "prompt_injection",
    "harmful",
] as const;

const guardClassificationSchema = z.object({
    category: z.enum(GUARD_CATEGORIES),
    reason: z.string(),
});

/** Why a message, or a reply, was blocked; keys into {@link CHAT_GUARD_REFUSALS}. */
export type BlockedCategory = keyof typeof CHAT_GUARD_REFUSALS;

/** Outcome of a guard check. */
export type GuardVerdict =
    | { allowed: true; category: "in_scope" | "conversational" }
    | {
          allowed: false;
          category: BlockedCategory;
          /** Which layer blocked it, for logs and tuning. */
          layer: "heuristic" | "classifier" | "output";
          /** Matched rule name or classifier reason. */
          reason: string;
      };

/** Workspace facts the classifier uses to judge scope. */
export type GuardContext = {
    workspaceTitle: string;
    workspaceDescription?: string | null;
    sourceTitles: string[];
};

/** Entry point for the chat guardrails. */
export class ChatGuard {
    /**
     * Layer 1: cleans the raw message. See {@link InputSanitizer.sanitize}.
     *
     * @param text - Raw user text
     * @returns Sanitized text
     * @throws {APIError} BadRequest when empty or too long
     */
    static sanitize(text: string) {
        return InputSanitizer.sanitize(text);
    }

    /**
     * Layer 2: regex heuristics. Cheap and synchronous, so it runs before any LLM call.
     *
     * @param text - Sanitized user text
     * @returns A blocking verdict, or `null` when nothing matched
     */
    static checkHeuristics(text: string): GuardVerdict | null {
        const scan = InjectionDetector.scan(text);
        return scan.detected
            ? {
                  allowed: false,
                  category: "prompt_injection",
                  layer: "heuristic",
                  reason: scan.rule,
              }
            : null;
    }

    /**
     * Layer 3: asks a small model whether the message is in scope for this workspace.
     *
     * Fails open: if the classifier itself errors, the message proceeds and the hardened
     * system prompt (layer 4) still constrains the reply. Failing closed would turn any
     * classifier hiccup into a full chat outage.
     *
     * @param text - Sanitized user text
     * @param standaloneQuery - Follow-up resolved against history (helps judge "explain more")
     * @param context - Workspace title, description and READY source titles
     * @returns The verdict
     */
    static async classify(
        text: string,
        standaloneQuery: string,
        context: GuardContext,
    ): Promise<GuardVerdict> {
        try {
            const { output } = await generateText({
                model: openai(CHAT_GUARD_MODEL),
                system: CHAT_GUARD_SYSTEM,
                prompt: chatGuardPrompt({
                    workspaceTitle: escapeDelimiters(context.workspaceTitle),
                    workspaceDescription: context.workspaceDescription
                        ? escapeDelimiters(context.workspaceDescription)
                        : null,
                    sourceTitles: context.sourceTitles
                        .slice(0, CHAT_GUARD_MAX_SOURCE_TITLES)
                        .map((title) => escapeDelimiters(title)),
                    message: escapeDelimiters(text),
                    standaloneQuery:
                        standaloneQuery !== text ? escapeDelimiters(standaloneQuery) : undefined,
                }),
                output: Output.object({ schema: guardClassificationSchema }),
                temperature: 0,
                maxOutputTokens: 100,
                telemetry: { functionId: "chat-guard" },
            });

            if (output.category === "in_scope" || output.category === "conversational") {
                return { allowed: true, category: output.category };
            }

            return {
                allowed: false,
                category: output.category,
                layer: "classifier",
                reason: output.reason,
            };
        } catch (error) {
            logger.warn(
                { err: error, kind: "chat-guard" },
                "Chat guard classifier failed, allowing",
            );
            return { allowed: true, category: "in_scope" };
        }
    }

    /**
     * Generates the per-request canary embedded in the system prompt.
     *
     * @returns A random token that never appears in legitimate replies
     */
    static createCanary() {
        return `gb-${randomBytes(9).toString("hex")}`;
    }

    /**
     * Layer 5: a stream filter that stops a reply the moment it leaks the system prompt.
     *
     * The canary is the first line of the system prompt, so a verbatim dump hits it almost
     * immediately. Each text part keeps back its last `canary.length - 1` characters until more
     * text arrives, so a canary split across deltas is still caught before any of it is sent.
     * On a leak the rest of the text is dropped and the refusal is sent in its place.
     *
     * @param canary - The token from {@link ChatGuard.createCanary}
     * @param onLeak - Called once when the canary is detected
     * @returns A transform for the UI message stream
     */
    static createLeakFilter(canary: string, onLeak: () => void) {
        const holdBack = canary.length - 1;
        const pending = new Map<string, string>();
        let leaked = false;

        return new TransformStream<UIMessageChunk, UIMessageChunk>({
            transform(chunk, controller) {
                if (chunk.type === "text-delta") {
                    if (leaked) {
                        return;
                    }

                    const buffer = (pending.get(chunk.id) ?? "") + chunk.delta;

                    if (buffer.includes(canary)) {
                        leaked = true;
                        pending.clear();
                        onLeak();
                        controller.enqueue({
                            type: "text-delta",
                            id: chunk.id,
                            delta: `\n\n${CHAT_GUARD_REFUSALS.output_leak}`,
                        });
                        return;
                    }

                    const safeLength = Math.max(0, buffer.length - holdBack);
                    pending.set(chunk.id, buffer.slice(safeLength));
                    if (safeLength > 0) {
                        controller.enqueue({ ...chunk, delta: buffer.slice(0, safeLength) });
                    }
                    return;
                }

                if (chunk.type === "text-end") {
                    const rest = pending.get(chunk.id);
                    pending.delete(chunk.id);
                    if (rest && !leaked) {
                        controller.enqueue({ type: "text-delta", id: chunk.id, delta: rest });
                    }
                }

                controller.enqueue(chunk);
            },
        });
    }

    /**
     * The fixed reply shown when a message is blocked.
     *
     * @param category - Why it was blocked
     */
    static refusal(category: BlockedCategory) {
        return CHAT_GUARD_REFUSALS[category];
    }
}
