/**
 * Zod schemas for artifact content, one per artifact type.
 *
 * Each type has two views of the same shape:
 * - the **generation** schema is what the model returns (items point at sources by number,
 *   `sources: [1, 3]`);
 * - the **stored** schema is what lives in `LearningArtifact.content` and what a user edit must
 *   match (those numbers resolved to `citations`).
 *
 * The stored schemas are built from the same base item shapes as the generation ones, so a field
 * added to a type is validated both when it is generated and when it is edited.
 */

import { z } from "zod";
import type { ArtifactType } from "../../generated/prisma/client.js";

/** Source numbers the model reports for an item; turned into citations afterwards. */
const sourceNumbers = z.array(z.number().int());

/** A source an item is based on, as stored. Kept as sent when a user edits the item. */
const citationSchema = z
    .object({
        /** The number shown in the context and in summary text, e.g. `1` for `[1]`. */
        marker: z.number().int(),
        sourceId: z.string().min(1),
        /** The source's title. */
        label: z.string(),
    })
    .strict();

/** Citations on a stored item; optional when sent so a new item may have none. */
const citationsField = z.array(citationSchema).default([]);

/** A flashcard without its source reference. */
const flashcardBase = z.object({ front: z.string(), back: z.string() });

/** A quiz question without its source reference; `correctIndex` is 0-based into `options`. */
const quizQuestionBase = z.object({
    question: z.string(),
    options: z.array(z.string()).min(2).max(5),
    correctIndex: z.number().int().min(0),
    explanation: z.string(),
});

/** A report section without its source reference. */
const reportSectionBase = z.object({ title: z.string(), content: z.string() });

/** One mind map node. */
const mindmapNode = z.object({ id: z.string(), label: z.string() });

/** One mind map edge between two node ids. */
const mindmapEdge = z.object({ id: z.string(), source: z.string(), target: z.string() });

/** Repository wiki: overview, architecture, diagram and per-module guide. */
const wikiShape = {
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
};

// ---------------------------------------------------------------------------
// Generation: what the model returns
// ---------------------------------------------------------------------------

/** Model output for FLASHCARDS: 3-30 front/back cards. */
export const flashcardsSchema = z.object({
    cards: z
        .array(flashcardBase.extend({ sources: sourceNumbers }))
        .min(3)
        .max(30),
});

/** Model output for QUIZ: 3-15 multiple-choice questions. */
export const quizSchema = z.object({
    questions: z
        .array(quizQuestionBase.extend({ sources: sourceNumbers }))
        .min(3)
        .max(15),
});

/** Model output for MINDMAP: 2-40 labelled nodes plus edges referencing node ids. */
export const mindmapSchema = z.object({
    nodes: z.array(mindmapNode).min(2).max(40),
    edges: z.array(mindmapEdge),
});

/** Model output for TAKEAWAYS: 3-20 short bullet strings. */
export const takeawaysSchema = z.object({
    items: z.array(z.string()).min(3).max(20),
});

/** Model output for REPORT: the full markdown plus the same content split into titled sections. */
export const reportSchema = z.object({
    markdown: z.string(),
    sections: z.array(reportSectionBase.extend({ sources: sourceNumbers })),
});

/** Model output for WIKI. */
export const wikiSchema = z.object(wikiShape);

// ---------------------------------------------------------------------------
// Storage: what an edit must match
// ---------------------------------------------------------------------------

/** Stored SUMMARY: markdown text plus the sources its `[n]` markers point at. */
const storedSummarySchema = z
    .object({ markdown: z.string().min(1), citations: citationsField })
    .strict();

/** Stored TAKEAWAYS. */
const storedTakeawaysSchema = takeawaysSchema.strict();

/** Stored FLASHCARDS: each card carries its citations. */
const storedFlashcardsSchema = z
    .object({
        cards: z
            .array(flashcardBase.extend({ citations: citationsField }).strict())
            .min(3)
            .max(30),
    })
    .strict();

/** Stored QUIZ: every `correctIndex` must point at one of the question's options. */
const storedQuizSchema = z
    .object({
        questions: z
            .array(
                quizQuestionBase
                    .extend({ citations: citationsField })
                    .strict()
                    .refine((question) => question.correctIndex < question.options.length, {
                        path: ["correctIndex"],
                        message: "correctIndex must point at one of the options",
                    }),
            )
            .min(3)
            .max(15),
    })
    .strict();

/** Stored MINDMAP: unique node ids, and every edge connects two existing nodes. */
const storedMindmapSchema = z
    .object({
        nodes: z.array(mindmapNode.strict()).min(2).max(40),
        edges: z.array(mindmapEdge.strict()),
    })
    .strict()
    .superRefine((mindmap, ctx) => {
        const nodeIds = new Set<string>();
        mindmap.nodes.forEach((node, index) => {
            if (nodeIds.has(node.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["nodes", index, "id"],
                    message: `Duplicate node id "${node.id}"`,
                });
            }
            nodeIds.add(node.id);
        });

        const edgeIds = new Set<string>();
        mindmap.edges.forEach((edge, index) => {
            if (edgeIds.has(edge.id)) {
                ctx.addIssue({
                    code: "custom",
                    path: ["edges", index, "id"],
                    message: `Duplicate edge id "${edge.id}"`,
                });
            }
            edgeIds.add(edge.id);

            for (const end of ["source", "target"] as const) {
                if (!nodeIds.has(edge[end])) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["edges", index, end],
                        message: `Edge ${end} "${edge[end]}" is not a node id`,
                    });
                }
            }
        });
    });

/** Stored REPORT: markdown plus sections, each with citations. */
const storedReportSchema = z
    .object({
        markdown: z.string().min(1),
        sections: z.array(reportSectionBase.extend({ citations: citationsField }).strict()),
    })
    .strict();

/** Stored WIKI. */
const storedWikiSchema = wikiSchema.strict();

/**
 * The shape `content` must have for each artifact type once stored. Used to validate user edits
 * against the artifact's existing type.
 */
export const artifactContentSchemas = {
    SUMMARY: storedSummarySchema,
    TAKEAWAYS: storedTakeawaysSchema,
    FLASHCARDS: storedFlashcardsSchema,
    QUIZ: storedQuizSchema,
    MINDMAP: storedMindmapSchema,
    REPORT: storedReportSchema,
    WIKI: storedWikiSchema,
} satisfies Record<ArtifactType, z.ZodType>;
