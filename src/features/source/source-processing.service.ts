/**
 * Source processing pipeline for RAG (Retrieval-Augmented Generation).
 *
 * Turns raw source data into searchable vector embeddings:
 *
 * ```
 * Source (PDF / text)
 *   → extractAndChunk  — pull plain text (from DB or Cloudinary PDF), split, save chunks
 *   → index            — embed chunks with OpenAI, replace vectors in Pinecone
 *   → status: READY
 * ```
 *
 * Inngest runs these as separate durable steps (see `jobs/index.ts`).
 */

import type { PineconeRecord } from "@pinecone-database/pinecone";
import type { Prisma } from "../../generated/prisma/client.js";
import { TextChunker } from "./ingestion/chunking.js";
import { EmbeddingClient } from "../../shared/ai/embeddings.js";
import { PdfExtractor } from "./ingestion/pdf.js";
import type { VectorMetadata } from "../../config/pinecone.js";
import { SourceChunkRepository, type SourceChunkRecord } from "./source-chunk.repository.js";
import { SourceRepository, type SourceRecord } from "./source.repository.js";
import { VectorRepository } from "../../shared/ai/vector.repository.js";

/** Chunks embedded per OpenAI request. */
const EMBED_BATCH_SIZE = 50;

/** Shape of JSON stored on a source's `metadata` column. */
export type SourceMetadata = {
    fileUrl?: string;
    fileName?: string;
    fileSize?: number;
    publicId?: string;
    resourceType?: "raw" | "image";
    importedFrom?: string;
    videoId?: string;
    processingError?: string;
    chunkCount?: number;
    pageCount?: number;
    indexedAt?: string;
};

/** Reads `metadata` as an object, tolerating null or malformed JSON. */
function readMetadata(metadata: SourceRecord["metadata"]): SourceMetadata {
    return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

export class SourceProcessingService {
    static markProcessing(sourceId: string) {
        return SourceRepository.update(sourceId, { status: "PROCESSING" });
    }

    /**
     * Marks a source as `FAILED` and stores the error message in metadata.
     * No-op if the source was deleted meanwhile.
     */
    static async markFailed(sourceId: string, error: unknown) {
        const source = await SourceRepository.findById(sourceId);
        if (!source) {
            return;
        }

        const message = error instanceof Error ? error.message : "Source processing failed";

        await SourceRepository.update(sourceId, {
            status: "FAILED",
            metadata: {
                ...readMetadata(source.metadata),
                processingError: message,
            },
        });
    }

    /**
     * Reads extractable text from a source.
     *
     * 1. **PDF** — downloads from Cloudinary and extracts per page, so chunks keep page
     *    numbers for citations. The text saved at upload has no page boundaries, so it is
     *    only used when the PDF has no `fileUrl`.
     * 2. **Text already in DB** — `source.content` (TEXT, website scrape, YouTube transcript, etc.)
     *
     * @throws If the source has no content at all
     */
    private static async extractText(source: SourceRecord) {
        const metadata = readMetadata(source.metadata);

        if (source.type === "PDF" && metadata.fileUrl) {
            const extracted = await PdfExtractor.fromCloudinary({
                fileUrl: metadata.fileUrl,
                publicId: metadata.publicId,
                // Uploads go to Cloudinary's `raw/upload` endpoint.
                resourceType: metadata.resourceType ?? "raw",
            });
            return {
                text: extracted.text,
                pageCount: extracted.pageCount,
                pages: extracted.pages,
            };
        }

        const text = source.content?.trim();
        if (text) {
            return { text, pageCount: undefined, pages: undefined };
        }

        throw new Error(`Source ${source.id} has no extractable content`);
    }

    /**
     * Pipeline step 1: extract text, persist it, and replace the source's chunks.
     *
     * Extraction and chunking happen together so the full text and PDF pages never
     * pass through Inngest step state (which is size-limited).
     *
     * @returns Number of chunks saved
     */
    static async extractAndChunk(sourceId: string) {
        const source = await SourceRepository.findById(sourceId);
        if (!source) {
            throw new Error("Source not found");
        }

        const extracted = await this.extractText(source);
        const metadata = readMetadata(source.metadata);

        await SourceRepository.update(sourceId, {
            content: extracted.text,
            metadata: {
                ...metadata,
                pageCount: extracted.pageCount ?? metadata.pageCount,
            },
        });

        await SourceChunkRepository.deleteAllBySourceId(sourceId);

        const chunks = extracted.pages?.length
            ? await TextChunker.chunkPages(extracted.pages)
            : await TextChunker.chunkText(extracted.text);

        if (chunks.length === 0) {
            throw new Error("No chunks were generated from source content");
        }

        const saved = await SourceChunkRepository.createMany(
            chunks.map((chunk) => ({
                sourceId,
                index: chunk.index,
                content: chunk.content,
                tokenCount: chunk.tokenCount,
                metadata: chunk.metadata as Prisma.InputJsonValue | undefined,
            })),
        );

        return { chunkCount: saved.length };
    }

    /** Embeds chunks in batches and builds Pinecone records with retrieval metadata. */
    private static async buildVectorRecords(source: SourceRecord, chunks: SourceChunkRecord[]) {
        const records: PineconeRecord<VectorMetadata>[] = [];

        for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
            const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
            const embeddings = await EmbeddingClient.embed(batch.map((chunk) => chunk.content));

            batch.forEach((chunk, j) => {
                const chunkMetadata =
                    chunk.metadata &&
                    typeof chunk.metadata === "object" &&
                    !Array.isArray(chunk.metadata)
                        ? (chunk.metadata as Record<string, unknown>)
                        : {};

                records.push({
                    id: chunk.id,
                    values: embeddings[j],
                    metadata: {
                        workspaceId: source.workspaceId,
                        sourceId: source.id,
                        chunkId: chunk.id,
                        chunkIndex: chunk.index,
                        sourceTitle: source.title,
                        sourceType: source.type,
                        text: chunk.content.slice(0, 35000),
                        ...(typeof chunkMetadata.page === "number"
                            ? { page: chunkMetadata.page }
                            : {}),
                    },
                });
            });
        }

        return records;
    }

    /**
     * Pipeline step 2: embed the source's chunks, replace its vectors, and mark it `READY`.
     *
     * Pinecone metadata includes enough context for retrieval without re-querying Postgres:
     * `sourceTitle`, `sourceType`, chunk `text` (truncated to 35k chars), and optional `page`.
     *
     * @returns Updated source, or `null` if the source was deleted mid-run
     */
    static async index(sourceId: string) {
        const source = await SourceRepository.findById(sourceId);
        if (!source) {
            throw new Error("Source not found");
        }

        const chunks = await SourceChunkRepository.findAllBySourceId(sourceId);
        const records = await this.buildVectorRecords(source, chunks);

        // Clear vectors from any earlier run first: chunk ids are regenerated on every
        // run, so upserting alone would leave the previous run's vectors orphaned.
        await VectorRepository.deleteBySourceId(source.workspaceId, source.id);
        await VectorRepository.upsert(source.workspaceId, records);

        // The source may have been deleted while we were embedding; don't leave its vectors behind.
        if (!(await SourceRepository.findById(source.id))) {
            await VectorRepository.deleteBySourceId(source.workspaceId, source.id);
            return null;
        }

        return SourceRepository.update(source.id, {
            status: "READY",
            metadata: {
                ...readMetadata(source.metadata),
                chunkCount: chunks.length,
                indexedAt: new Date().toISOString(),
                processingError: undefined,
            },
        });
    }

    /** Removes a source's vectors and chunks (before delete or full re-index). */
    static async removeFromIndex(workspaceId: string, sourceId: string) {
        await VectorRepository.deleteBySourceId(workspaceId, sourceId);
        await SourceChunkRepository.deleteAllBySourceId(sourceId);
    }

    /** Returns all chunks for a source plus the total count. */
    static async listChunks(sourceId: string) {
        const chunks = await SourceChunkRepository.findAllBySourceId(sourceId);
        return { chunks, count: chunks.length };
    }
}
