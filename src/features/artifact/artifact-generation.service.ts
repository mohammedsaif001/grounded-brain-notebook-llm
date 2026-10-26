import { generateText, Output } from "ai";
import { openai } from "../../config/openai.js";
import {
    ARTIFACT_PROMPTS,
    artifactSystem,
    condenseSourcePrompt,
    condenseSourceSystem,
} from "../../config/prompts.js";
import { z } from "zod";
import {
    ARTIFACT_CONDENSE_SEGMENT_CHARS,
    ARTIFACT_MAX_CONTEXT_CHARS,
    CHAT_MODEL,
} from "../../config/ai.config.js";
import { GithubRepoClient } from "../source/ingestion/github.js";
import { SourceService } from "../source/source.service.js";
import type { ArtifactRecord } from "./artifact.repository.js";
import { APIError } from "../../shared/http/api-error.js";

/** Characters reserved for per-source headers and separators in the combined context. */
const CONTEXT_OVERHEAD_CHARS = 2_000;

/** Max parallel model calls when condensing one oversized source. */
const CONDENSE_CONCURRENCY = 4;

/** Model output for FLASHCARDS: 3-30 front/back cards. */
const flashcardsSchema = z.object({
    cards: z
        .array(
            z.object({
                front: z.string(),
                back: z.string(),
            }),
        )
        .min(3)
        .max(30),
});

/** Model output for QUIZ: 3-15 multiple-choice questions; `correctIndex` is 0-based into `options`. */
const quizSchema = z.object({
    questions: z
        .array(
            z.object({
                question: z.string(),
                options: z.array(z.string()).min(2).max(5),
                correctIndex: z.number().int().min(0),
                explanation: z.string(),
            }),
        )
        .min(3)
        .max(15),
});

/** Model output for MINDMAP: 2-40 labelled nodes plus edges referencing node ids. */
const mindmapSchema = z.object({
    nodes: z
        .array(
            z.object({
                id: z.string(),
                label: z.string(),
            }),
        )
        .min(2)
        .max(40),
    edges: z.array(
        z.object({
            id: z.string(),
            source: z.string(),
            target: z.string(),
        }),
    ),
});

/** Model output for TAKEAWAYS: 3-20 short bullet strings. */
const takeawaysSchema = z.object({
    items: z.array(z.string()).min(3).max(20),
});

/** Model output for REPORT: the full markdown plus the same content split into titled sections. */
const reportSchema = z.object({
    markdown: z.string(),
    sections: z.array(
        z.object({
            title: z.string(),
            content: z.string(),
        }),
    ),
});

/** Model output for WIKI: a repository overview, architecture, diagram and per-module guide. */
const wikiSchema = z.object({
    overview: z.string(),
    techStack: z.array(z.object({ name: z.string(), purpose: z.string() })).max(25),
    architecture: z.string(),
    diagram: z.string(),
    modules: z
        .array(
            z.object({
                name: z.string(),
                path: z.string(),
                description: z.string(),
                keyFiles: z.array(z.string()).max(10),
            }),
        )
        .min(1)
        .max(30),
    gettingStarted: z.string(),
});

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

            return [{ title: source.title, content, header }];
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

        const text = fitted
            .map((source) => `# ${source.title}\n\n${source.content}`)
            .join("\n\n---\n\n");

        return {
            text,
            sourceIds: selected.map((source) => source.id),
        };
    }

    /**
     * Generates structured or markdown content for a learning artifact using the AI SDK.
     *
     * @param type - Artifact type (`SUMMARY`, `QUIZ`, `FLASHCARDS`, etc.)
     * @param sourceText - Combined source material from {@link ArtifactGenerationService.gatherSourceContext}
     * @returns Type-specific JSON content stored on the artifact row
     * @throws {APIError} BadRequest when the artifact type is unsupported
     */
    static async generateContent(type: ArtifactRecord["type"], sourceText: string) {
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
                return { markdown: result.text };
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
                return result.output;
            }
            case "QUIZ": {
                const result = await generateText({
                    model: openai(CHAT_MODEL),
                    system,
                    telemetry,
                    output: Output.object({ schema: quizSchema }),
                    prompt: ARTIFACT_PROMPTS.QUIZ(sourceText),
                });
                return sanitizeQuiz(result.output);
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
                return result.output;
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
