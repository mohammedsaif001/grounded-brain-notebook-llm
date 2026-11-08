import { generateText, Output } from "ai";
import { openai } from "../../config/openai.js";
import {
    ARTIFACT_PROMPTS,
    ARTIFACT_TITLE_SYSTEM,
    artifactSystem,
    artifactTitlePrompt,
    condenseSourcePrompt,
    condenseSourceSystem,
} from "../../config/prompts.js";
import { type z } from "zod";
import {
    ARTIFACT_CONDENSE_SEGMENT_CHARS,
    ARTIFACT_MAX_CONTEXT_CHARS,
    CHAT_MODEL,
} from "../../config/ai.config.js";
import {
    flashcardsSchema,
    mindmapSchema,
    quizSchema,
    reportSchema,
    takeawaysSchema,
    wikiSchema,
} from "./artifact-content.schema.js";
import { GithubRepoClient } from "../source/ingestion/github.js";
import { MessageRepository } from "../conversation/message.repository.js";
import { SourceService } from "../source/source.service.js";
import type { ArtifactRecord } from "./artifact.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import { logger } from "../../config/logger.js";

/** Characters reserved for per-source headers and separators in the combined context. */
const CONTEXT_OVERHEAD_CHARS = 2_000;

/** Max parallel model calls when condensing one oversized source. */
const CONDENSE_CONCURRENCY = 4;

/** A source the generated material was built from, numbered as in the context (`# [1] Title`). */
export type ContextSource = { id: string; title: string };

/** A source an item (card, question, section, summary statement) is based on. */
export type ArtifactCitation = {
    /** The number shown in the context and in summary text, e.g. `1` for `[1]`. */
    marker: number;
    sourceId: string;
    /** The source's title. */
    label: string;
};

/**
 * Splits a total character budget across sources fairly.
 *
 * Sources smaller than their fair share keep their full length, and the leftover
 * budget is redistributed to the larger ones.
 *
 * @param lengths - Content length of each source
 * @param total - Total characters available
 * @returns Per-source character budgets, in the same order as `lengths`
 */
function allocateBudgets(lengths: number[], total: number) {
    const budgets = new Array<number>(lengths.length).fill(0);
    const order = lengths.map((_, index) => index).sort((a, b) => lengths[a] - lengths[b]);

    let remaining = total;
    let left = lengths.length;

    for (const index of order) {
        const fairShare = Math.floor(remaining / left);
        budgets[index] = Math.min(lengths[index], fairShare);
        remaining -= budgets[index];
        left -= 1;
    }

    return budgets;
}

/**
 * Condenses an oversized source into dense notes that fit its budget (map step).
 *
 * The content is split into segments; each segment is summarized independently and
 * the notes are concatenated, so every part of the document is represented instead
 * of only its beginning.
 *
 * @param title - Source title (for model context)
 * @param content - Full source text
 * @param budget - Target max characters for the condensed result
 * @returns Condensed notes, at most `budget` characters
 */
async function condenseSource(title: string, content: string, budget: number) {
    const segments: string[] = [];
    for (let i = 0; i < content.length; i += ARTIFACT_CONDENSE_SEGMENT_CHARS) {
        segments.push(content.slice(i, i + ARTIFACT_CONDENSE_SEGMENT_CHARS));
    }

    const targetChars = Math.max(800, Math.floor(budget / segments.length));
    const notes = new Array<string>(segments.length);

    for (let i = 0; i < segments.length; i += CONDENSE_CONCURRENCY) {
        const batch = segments.slice(i, i + CONDENSE_CONCURRENCY);
        const results = await Promise.all(
            batch.map((segment, offset) =>
                generateText({
                    model: openai(CHAT_MODEL),
                    system: condenseSourceSystem(Math.round(targetChars / 6)),
                    prompt: condenseSourcePrompt(title, i + offset + 1, segments.length, segment),
                    maxOutputTokens: Math.ceil(targetChars / 3),
                    telemetry: { functionId: "artifact-condense" },
                }),
            ),
        );

        results.forEach((result, offset) => {
            notes[i + offset] = result.text.trim();
        });
    }

    return notes.join("\n\n").slice(0, budget);
}

/**
 * Drops quiz questions whose `correctIndex` doesn't point at one of their options.
 *
 * @param quiz - Raw quiz returned by the model
 * @returns The quiz containing only valid questions
 * @throws {Error} When fewer than 3 valid questions remain (lets Inngest retry)
 */
function sanitizeQuiz(quiz: z.infer<typeof quizSchema>) {
    const questions = quiz.questions.filter(
        (question) => question.correctIndex < question.options.length,
    );

    if (questions.length < 3) {
        throw new Error("Quiz generation produced too few valid questions");
    }

    return { questions };
}

/**
 * Removes duplicate nodes and edges that reference unknown nodes, self-loops,
 * or duplicate ids, so the client can render the graph without crashing.
 *
 * @param mindmap - Raw mind map returned by the model
 * @returns A cleaned graph where every edge connects two existing nodes
 */
function sanitizeMindmap(mindmap: z.infer<typeof mindmapSchema>) {
    const nodeIds = new Set<string>();
    const nodes = mindmap.nodes.filter((node) => {
        if (nodeIds.has(node.id)) {
            return false;
        }
        nodeIds.add(node.id);
        return true;
    });

    const edgeIds = new Set<string>();
    const edges = mindmap.edges.filter((edge) => {
        if (
            edgeIds.has(edge.id) ||
            edge.source === edge.target ||
            !nodeIds.has(edge.source) ||
            !nodeIds.has(edge.target)
        ) {
            return false;
        }
        edgeIds.add(edge.id);
        return true;
    });

    return { nodes, edges };
}

/**
 * Strips markdown code fences the model may wrap a Mermaid diagram in, so the client
 * can pass `diagram` straight to a Mermaid renderer.
 *
 * @param wiki - Raw wiki returned by the model
 * @returns The wiki with a clean `diagram` string
 */
function sanitizeWiki(wiki: z.infer<typeof wikiSchema>) {
    const diagram = wiki.diagram
        .replace(/^\s*```(?:mermaid)?\s*/i, "")
        .replace(/\s*```\s*$/, "")
        .trim();

    return { ...wiki, diagram };
}

/**
 * Turns the source numbers a model reported into citations, dropping numbers that match no
 * source and repeats.
 *
 * @param numbers - Source numbers from the model (1-based)
 * @param sources - The numbered sources the material was built from
 */
function toCitations(numbers: number[], sources: ContextSource[]): ArtifactCitation[] {
    const seen = new Set<number>();

    return numbers.flatMap((marker) => {
        const source = sources[marker - 1];
        if (!source || seen.has(marker)) {
            return [];
        }
        seen.add(marker);
        return [{ marker, sourceId: source.id, label: source.title }];
    });
}

/**
 * Replaces each item's `sources` numbers with resolved `citations`.
 *
 * @param items - Items as the model returned them
 * @param sources - The numbered sources the material was built from
 */
function withCitations<T extends { sources: number[] }>(items: T[], sources: ContextSource[]) {
    return items.map(({ sources: numbers, ...item }) => ({
        ...item,
        citations: toCitations(numbers, sources),
    }));
}

/**
 * Citations for a markdown text: the sources its `[n]` markers point at, in order of appearance.
 *
 * @param markdown - Text containing markers like `[1]` or `[1, 2]`
 * @param sources - The numbered sources the material was built from
 */
function citationsInMarkdown(markdown: string, sources: ContextSource[]) {
    const numbers: number[] = [];
    for (const match of markdown.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
        numbers.push(...match[1].split(",").map((part) => Number(part.trim())));
    }
    return toCitations(numbers, sources);
}

/** Builds the source context for learning artifacts and generates their content with the model. */
export class ArtifactGenerationService {
    /**
     * Resolves which READY sources an artifact should use, without loading their content.
     *
     * Cheap enough to run inside the create request for validation.
     *
     * @param workspaceId - Workspace whose sources to check
     * @param sourceIds - Optional subset of source ids; defaults to all READY sources
     * @param onlyType - When set, only sources of this type are used (e.g. `GITHUB` for a wiki)
     * @returns Ids of the READY sources that will be used
     * @throws {APIError} BadRequest when no ready sources match
     */
    static async resolveReadySourceIds(
        workspaceId: string,
        sourceIds?: string[],
        onlyType?: "GITHUB",
    ) {
        const sources = (await SourceService.listReady(workspaceId)).filter(
            (source) => !onlyType || source.type === onlyType,
        );

        const selected = sourceIds?.length
            ? sources.filter((source) => sourceIds.includes(source.id))
            : sources;

        if (selected.length === 0) {
            throw APIError.BadRequest(
                onlyType === "GITHUB"
                    ? "No ready GitHub repositories found. Import and process a repository first."
                    : "No ready sources found. Add and process sources before generating learning tools.",
            );
        }

        return selected.map((source) => source.id);
    }

    /**
     * Collects text from READY workspace sources for artifact generation.
     *
     * When the combined text fits in {@link ARTIFACT_MAX_CONTEXT_CHARS} it is used verbatim.
     * Otherwise the budget is split fairly across sources and oversized sources are
     * condensed with {@link condenseSource} (map-reduce), so later sources are never
     * silently dropped.
     *
     * @param workspaceId - Workspace whose sources to read
     * @param sourceIds - Optional subset of source ids; defaults to all READY sources
     * @returns Combined source text and the ids actually used
     * @throws {APIError} BadRequest when no ready sources exist or none have extracted content
     */
    static async gatherSourceContext(workspaceId: string, sourceIds?: string[]) {
        const sources = await SourceService.listReadyWithContent(workspaceId);

        const selected = sourceIds?.length
            ? sources.filter((source) => sourceIds.includes(source.id))
            : sources;

        if (selected.length === 0) {
            throw APIError.BadRequest(
                "No ready sources found. Add and process sources before generating learning tools.",
            );
        }

        const withContent = selected.flatMap((source) => {
            const content = source.content?.trim();
            if (!content) {
                return [];
            }

            // Repositories lead with their file tree so structure survives condensing.
            const files =
                source.type === "GITHUB" && source.metadata && typeof source.metadata === "object"
                    ? (source.metadata as { files?: { path: string }[] }).files
                    : undefined;
            const header = files?.length
                ? `File tree:\n${GithubRepoClient.renderTree(files.map((file) => file.path))}\n\n`
                : "";

            return [{ id: source.id, title: source.title, content, header }];
        });

        if (withContent.length === 0) {
            throw APIError.BadRequest("Selected sources have no extracted content yet.");
        }

        const headerChars = withContent.reduce((sum, source) => sum + source.header.length, 0);
        const budgets = allocateBudgets(
            withContent.map((source) => source.content.length),
            ARTIFACT_MAX_CONTEXT_CHARS - CONTEXT_OVERHEAD_CHARS - headerChars,
        );

        const fitted = await Promise.all(
            withContent.map(async (source, index) => ({
                title: source.title,
                content:
                    source.header +
                    (source.content.length <= budgets[index]
                        ? source.content
                        : await condenseSource(source.title, source.content, budgets[index])),
            })),
        );

        // Numbered so the model can say which source each item is based on.
        const text = fitted
            .map((source, index) => `# [${index + 1}] ${source.title}\n\n${source.content}`)
            .join("\n\n---\n\n");

        return {
            text,
            sourceIds: selected.map((source) => source.id),
            /** The sources in the text, in the order of their numbers. */
            sources: withContent.map((source): ContextSource => ({
                id: source.id,
                title: source.title,
            })),
        };
    }

    /**
     * Builds the material for an artifact made from a conversation: its messages as a transcript.
     *
     * The chat's own `[1]` / `[W1]` citation markers are removed, since they would be mistaken
     * for source numbers. Over {@link ARTIFACT_MAX_CONTEXT_CHARS} the oldest messages are left out.
     * There are no numbered sources, so the generated items carry no citations.
     *
     * @param conversationId - Conversation to read
     * @param messageIds - Optional subset of its messages
     * @throws {APIError} BadRequest when there is nothing to learn from
     */
    static async gatherConversationContext(conversationId: string, messageIds?: string[]) {
        const messages = (await MessageRepository.findAllByConversationId(conversationId)).filter(
            (message) => !messageIds?.length || messageIds.includes(message.id),
        );

        const lines = messages.map(
            (message) =>
                `${message.role === "USER" ? "User" : "Assistant"}: ${message.content
                    .replace(/\s?\[W?\d+(?:\s*,\s*W?\d+)*\]/g, "")
                    .trim()}`,
        );

        // Keep the most recent messages that fit.
        const kept: string[] = [];
        let used = 0;
        for (const line of lines.reverse()) {
            if (used + line.length > ARTIFACT_MAX_CONTEXT_CHARS - CONTEXT_OVERHEAD_CHARS) {
                break;
            }
            kept.unshift(line);
            used += line.length;
        }

        if (kept.length === 0) {
            throw APIError.BadRequest("This conversation has no messages to learn from yet");
        }

        return {
            text: `# Conversation\n\n${kept.join("\n\n")}`,
            sources: [] as ContextSource[],
        };
    }

    /**
     * Asks the model for a short title that names the topic of a generated artifact.
     *
     * Best effort: any failure or an unusable answer returns `null` so the caller keeps the
     * existing title instead of failing the artifact.
     *
     * @param type - Artifact type
     * @param content - The generated content
     * @returns A cleaned title of at most 80 characters, or `null`
     */
    static async generateTitle(type: ArtifactRecord["type"], content: unknown) {
        try {
            const { text } = await generateText({
                model: openai(CHAT_MODEL),
                system: ARTIFACT_TITLE_SYSTEM,
                prompt: artifactTitlePrompt(type, JSON.stringify(content).slice(0, 6_000)),
                maxOutputTokens: 30,
                telemetry: { functionId: "artifact-title" },
            });

            const title = text
                .trim()
                .replace(/^["'\u201c\u2018]+|["'\u201d\u2019.]+$/g, "")
                .trim()
                .slice(0, 80);
            return title.length >= 2 ? title : null;
        } catch (error) {
            logger.warn({ kind: "artifact", type, err: error }, "Artifact title generation failed");
            return null;
        }
    }

    /**
     * Generates structured or markdown content for a learning artifact using the AI SDK.
     *
     * @param type - Artifact type (`SUMMARY`, `QUIZ`, `FLASHCARDS`, etc.)
     * @param sourceText - Combined source material from {@link ArtifactGenerationService.gatherSourceContext}
     * @param sources - The numbered sources in that material, used to resolve citations
     * @returns Type-specific JSON content stored on the artifact row. Summaries, flashcards,
     *   quiz questions and report sections carry `citations` naming the sources they came from
     * @throws {APIError} BadRequest when the artifact type is unsupported
     */
    static async generateContent(
        type: ArtifactRecord["type"],
        sourceText: string,
        sources: ContextSource[] = [],
    ) {
        const system = artifactSystem(type);
        const telemetry = { functionId: `artifact-${type.toLowerCase()}` };

        switch (type) {
            case "SUMMARY": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    prompt: ARTIFACT_PROMPTS.SUMMARY(sourceText),
                });
                return {
                    markdown: result.text,
                    citations: citationsInMarkdown(result.text, sources),
                };
            }
            case "TAKEAWAYS": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: takeawaysSchema }),
                    prompt: ARTIFACT_PROMPTS.TAKEAWAYS(sourceText),
                });
                return result.output;
            }
            case "FLASHCARDS": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: flashcardsSchema }),
                    prompt: ARTIFACT_PROMPTS.FLASHCARDS(sourceText),
                });
                return { cards: withCitations(result.output.cards, sources) };
            }
            case "QUIZ": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: quizSchema }),
                    prompt: ARTIFACT_PROMPTS.QUIZ(sourceText),
                });
                return {
                    questions: withCitations(sanitizeQuiz(result.output).questions, sources),
                };
            }
            case "MINDMAP": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: mindmapSchema }),
                    prompt: ARTIFACT_PROMPTS.MINDMAP(sourceText),
                });
                return sanitizeMindmap(result.output);
            }
            case "REPORT": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: reportSchema }),
                    prompt: ARTIFACT_PROMPTS.REPORT(sourceText),
                });
                return {
                    markdown: result.output.markdown,
                    sections: withCitations(result.output.sections, sources),
                };
            }
            case "WIKI": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: wikiSchema }),
                    prompt: ARTIFACT_PROMPTS.WIKI(sourceText),
                });
                return sanitizeWiki(result.output);
            }
            default:
                throw APIError.BadRequest(`Unsupported artifact type: ${String(type)}`);
        }
    }
}
