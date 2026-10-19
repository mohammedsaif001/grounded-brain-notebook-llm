import type { Prisma } from "../../generated/prisma/client.js";
import { EventPublisher } from "../../jobs/events.js";
import { CloudinaryStorage } from "./ingestion/cloudinary.js";
import { FirecrawlClient } from "./ingestion/firecrawl.js";
import { PdfExtractor } from "./ingestion/pdf.js";
import { YoutubeClient } from "./ingestion/youtube.js";
import {
    SourceRepository,
    type CreateSourceData,
    type SourceRecord,
} from "./source.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import type {
    CreateSourceInput,
    ImportWebSearchInput,
    ImportWebsiteInput,
    ImportYoutubeInput,
    ListSourcesQuery,
    ReprocessSourcesInput,
} from "./source.validator.js";
import { SourceProcessingService } from "./source-processing.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";

/** Source business logic: imports, CRUD, and (re)processing requests. */
export class SourceService {
    /** Persists a source row and queues the processing pipeline. */
    private static async createAndQueue(data: CreateSourceData) {
        const source = await SourceRepository.create(data);

        await EventPublisher.sourceCreated({
            sourceId: source.id,
            workspaceId: source.workspaceId,
        });

        return source;
    }

    /** Lists sources (without content) with optional `q`, `type`, and `status` filters. */
    static async list(workspaceId: string, userId: string, filters: ListSourcesQuery = {}) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return SourceRepository.findAllByWorkspaceId(workspaceId, filters);
    }

    /**
     * Loads a single source after verifying workspace ownership.
     *
     * @throws {APIError} NotFound when the source does not exist in this workspace
     */
    static async get(workspaceId: string, sourceId: string, userId: string): Promise<SourceRecord> {
        await WorkspaceService.getForUser(workspaceId, userId);

        const source = await SourceRepository.findByIdAndWorkspaceId(sourceId, workspaceId);

        if (!source) {
            throw APIError.NotFound("Source not found");
        }

        return source;
    }

    /**
     * Lists READY sources (without content). For internal callers such as artifact
     * generation; does no ownership check, so callers must verify the workspace first.
     */
    static listReady(workspaceId: string) {
        return SourceRepository.findAllByWorkspaceId(workspaceId, { status: "READY" });
    }

    /**
     * Lists READY sources including their full text. Internal use only (no ownership check);
     * called from background jobs and after the caller has verified the workspace.
     */
    static listReadyWithContent(workspaceId: string) {
        return SourceRepository.findAllWithContentByWorkspaceId(workspaceId, { status: "READY" });
    }

    /** Creates a plain-text or markdown source and queues it for indexing. */
    static async createText(workspaceId: string, userId: string, input: CreateSourceInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        return this.createAndQueue({
            workspaceId,
            type: input.type,
            title: input.title,
            content: input.content,
            status: "PENDING",
        });
    }

    /**
     * Uploads a PDF to Cloudinary, extracts text best-effort, and queues processing.
     *
     * If upload-time extraction fails, the worker retries it from Cloudinary.
     */
    static async uploadPdf(
        workspaceId: string,
        userId: string,
        file: Express.Multer.File,
        title?: string,
    ) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const upload = await CloudinaryStorage.uploadPdf(file.buffer, file.originalname);

        let content: string | null = null;
        let pageCount: number | undefined;

        try {
            const extracted = await PdfExtractor.fromBuffer(file.buffer);
            content = extracted.text;
            pageCount = extracted.pageCount;
        } catch {
            // The worker will retry extraction from Cloudinary.
        }

        return this.createAndQueue({
            workspaceId,
            type: "PDF",
            title: title?.trim() || file.originalname.replace(/\.pdf$/i, ""),
            content,
            status: "PENDING",
            metadata: {
                fileUrl: upload.secureUrl,
                fileName: upload.originalFilename,
                fileSize: upload.bytes,
                publicId: upload.publicId,
                resourceType: upload.resourceType,
                pageCount,
            },
        });
    }

    /** Scrapes a website and creates a WEBSITE source from its markdown. */
    static async importWebsite(workspaceId: string, userId: string, input: ImportWebsiteInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const scraped = await FirecrawlClient.scrape(input.url);

        return this.createAndQueue({
            workspaceId,
            type: "WEBSITE",
            title: input.title || scraped.title || input.url,
            content: scraped.markdown,
            url: scraped.sourceUrl,
            status: "PENDING",
            metadata: {
                importedFrom: scraped.sourceUrl,
            },
        });
    }

    /** Fetches a YouTube transcript and creates a YOUTUBE source from it. */
    static async importYoutube(workspaceId: string, userId: string, input: ImportYoutubeInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const transcript = await YoutubeClient.fetchTranscript(input.url);

        return this.createAndQueue({
            workspaceId,
            type: "YOUTUBE",
            title: input.title || `YouTube: ${transcript.videoId}`,
            content: transcript.content,
            url: input.url,
            status: "PENDING",
            metadata: {
                videoId: transcript.videoId,
            },
        });
    }

    /** Saves a web search result the user chose to keep as a WEBSITE source. */
    static async importWebSearch(workspaceId: string, userId: string, input: ImportWebSearchInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        return this.createAndQueue({
            workspaceId,
            type: "WEBSITE",
            title: input.title,
            content: input.content,
            url: input.url,
            status: "PENDING",
            metadata: {
                importedFrom: "web-search",
                sourceUrl: input.url,
            },
        });
    }

    /**
     * Deletes a source, cancelling its processing run and removing its vectors and chunks.
     *
     * @throws {APIError} NotFound when the source is not found
     */
    static async delete(workspaceId: string, sourceId: string, userId: string) {
        await this.get(workspaceId, sourceId, userId);
        await EventPublisher.sourceDeleted({ sourceId, workspaceId });
        await SourceProcessingService.removeFromIndex(workspaceId, sourceId);
        await SourceRepository.delete(sourceId);
    }

    /** Deletes multiple sources in sequence. */
    static async bulkDelete(workspaceId: string, userId: string, sourceIds: string[]) {
        await WorkspaceService.getForUser(workspaceId, userId);

        for (const sourceId of sourceIds) {
            await this.delete(workspaceId, sourceId, userId);
        }
    }

    /** Returns indexed chunks for a source (debugging / admin UI). */
    static async getChunks(workspaceId: string, sourceId: string, userId: string) {
        await this.get(workspaceId, sourceId, userId);
        return SourceProcessingService.listChunks(sourceId);
    }

    /**
     * Clears a source's vectors/chunks and re-queues it for full re-indexing.
     *
     * @throws {APIError} NotFound when the source is not found
     */
    static async reprocess(workspaceId: string, sourceId: string, userId: string) {
        const source = await this.get(workspaceId, sourceId, userId);

        await SourceProcessingService.removeFromIndex(workspaceId, sourceId);

        const metadata =
            source.metadata &&
            typeof source.metadata === "object" &&
            !Array.isArray(source.metadata)
                ? { ...(source.metadata as Record<string, unknown>) }
                : {};

        delete metadata.processingError;

        await SourceRepository.update(sourceId, {
            status: "PENDING",
            metadata: metadata as Prisma.InputJsonValue,
        });

        await EventPublisher.sourceCreated({ sourceId, workspaceId });
    }

    /**
     * Re-queues FAILED sources. Without `sourceIds`, every failed source in the workspace
     * is reprocessed; with them, only the failed sources in that list.
     *
     * @returns Count of sources that were requeued
     */
    static async reprocessFailed(
        workspaceId: string,
        userId: string,
        input: ReprocessSourcesInput = {},
    ) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const sources = await SourceRepository.findAllByWorkspaceId(workspaceId, {
            status: "FAILED",
        });

        const targets = input.sourceIds?.length
            ? sources.filter((source) => input.sourceIds?.includes(source.id))
            : sources;

        for (const source of targets) {
            await this.reprocess(workspaceId, source.id, userId);
        }

        return { reprocessed: targets.length };
    }
}
