import { logger } from "../../config/logger.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { EventPublisher } from "../../jobs/events.js";
import { CloudinaryStorage } from "./ingestion/cloudinary.js";
import { FirecrawlScraper } from "./ingestion/firecrawl.js";
import { GithubRepoClient, type RepoSnapshot } from "./ingestion/github.js";
import { PdfExtractor } from "./ingestion/pdf.js";
import { PdfValidator } from "./ingestion/pdf-validator.js";
import { YoutubeClient } from "./ingestion/youtube.js";
import { SourceRepository, type CreateSourceData, type SourceRecord } from "./source.repository.js";
import { APIError } from "../../shared/http/api-error.js";
import type {
    CreateSourceInput,
    ImportGithubInput,
    ImportWebSearchInput,
    ImportWebsiteInput,
    ImportYoutubeInput,
    ListSourcesQuery,
    ReprocessSourcesInput,
} from "./source.validator.js";
import { SourceChunkRepository } from "./source-chunk.repository.js";
import { countWords } from "./ingestion/text-stats.js";
import { SourceProcessingService, type SourceMetadata } from "./source-processing.service.js";
import { WorkspaceService } from "../workspace/workspace.service.js";

/** Outcome of one id in a bulk request. */
type BulkResult<Status extends string> = { sourceId: string; status: Status; reason?: string };

/**
 * Metadata stored on a GITHUB source: where it came from, the commit it was read at, and
 * the files that were read (so listing them never needs the packed content).
 *
 * @param snapshot - Repository contents just read from GitHub
 */
function githubMetadata(snapshot: RepoSnapshot): Prisma.InputJsonObject {
    return {
        importedFrom: `https://github.com/${snapshot.owner}/${snapshot.repo}`,
        owner: snapshot.owner,
        repo: snapshot.repo,
        branch: snapshot.branch,
        commitSha: snapshot.commitSha,
        description: snapshot.description,
        author: snapshot.owner,
        fileCount: snapshot.files.length,
        totalFiles: snapshot.totalFiles,
        truncated: snapshot.truncated,
        files: snapshot.files.map((file) => ({ path: file.path, size: file.content.length })),
    };
}

/**
 * Reads a source's `metadata` as an object, tolerating null or malformed JSON.
 *
 * @param metadata - Raw JSON column value
 */
function readMetadata(metadata: SourceRecord["metadata"]): SourceMetadata {
    return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
}

/** Source business logic: imports, CRUD, and (re)processing requests. */
export class SourceService {
    /**
     * Persists a source row and queues the processing pipeline.
     *
     * @param data - Source fields to insert
     * @returns The created source (status `PENDING`)
     */
    private static async createAndQueue(data: CreateSourceData) {
        const source = await SourceRepository.create({
            ...data,
            // Known up front for everything whose text is already in hand (not PDFs, until extracted).
            metadata: data.content
                ? {
                      ...(data.metadata as Prisma.InputJsonObject | undefined),
                      wordCount: countWords(data.content),
                  }
                : data.metadata,
        });
        logger.info(
            { kind: "ingest", sourceId: source.id, workspaceId: source.workspaceId },
            `Source queued: ${source.type} "${source.title}"`,
        );

        await EventPublisher.sourceCreated({
            sourceId: source.id,
            workspaceId: source.workspaceId,
        });

        return source;
    }

    /**
     * Lists sources (without content) with optional `q`, `type`, and `status` filters,
     * one page at a time when `limit` is given.
     *
     * @param workspaceId - Workspace to list from
     * @param userId - Requesting user
     * @param filters - Optional list filters plus `limit` and `cursor`
     * @returns The page of sources, the total matching, and the next cursor
     */
    static async list(workspaceId: string, userId: string, filters: ListSourcesQuery = {}) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return SourceRepository.findPage(workspaceId, filters);
    }

    /**
     * Loads a single source after verifying workspace ownership.
     *
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - Source to load
     * @param userId - Requesting user
     * @returns The source including its content
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
     *
     * @param workspaceId - Workspace to list from
     */
    static listReady(workspaceId: string) {
        return SourceRepository.findAllByWorkspaceId(workspaceId, { status: "READY" });
    }

    /**
     * Lists READY sources including their full text. Internal use only (no ownership check);
     * called from background jobs and after the caller has verified the workspace.
     *
     * @param workspaceId - Workspace to list from
     */
    static listReadyWithContent(workspaceId: string) {
        return SourceRepository.findAllWithContentByWorkspaceId(workspaceId, { status: "READY" });
    }

    /**
     * Creates a plain-text or markdown source and queues it for indexing.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param input - Type, title and content
     */
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
     * Validates a PDF's contents, uploads it to Cloudinary, extracts text best-effort,
     * and queues processing.
     *
     * If upload-time extraction fails, the worker retries it from Cloudinary.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param file - Uploaded file from Multer (in memory)
     * @param title - Optional title; defaults to the sanitised file name
     * @throws {APIError} BadRequest when the file isn't a real PDF or contains active content
     */
    static async uploadPdf(
        workspaceId: string,
        userId: string,
        file: Express.Multer.File,
        title?: string,
    ) {
        await WorkspaceService.getForUser(workspaceId, userId);

        // Verify the actual bytes before storing anything: the extension and MIME type
        // checked by multer are client-supplied and can be spoofed.
        await PdfValidator.assertSafe(file.buffer);
        const fileName = PdfValidator.sanitizeFilename(file.originalname);

        const upload = await CloudinaryStorage.uploadPdf(file.buffer, fileName);

        let content: string | null = null;
        let pageCount: number | undefined;

        try {
            const extracted = await PdfExtractor.fromBuffer(file.buffer);
            content = extracted.text;
            pageCount = extracted.pageCount;
        } catch (error) {
            // The worker will retry extraction from Cloudinary.
            logger.warn(
                { kind: "ingest", workspaceId, err: error },
                "PDF text extraction at upload failed; the worker will retry from Cloudinary",
            );
        }

        return this.createAndQueue({
            workspaceId,
            type: "PDF",
            title: title?.trim() || fileName.replace(/\.pdf$/i, ""),
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

    /**
     * Scrapes a website and creates a WEBSITE source from its markdown.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param input - URL and optional title
     * @throws {APIError} BadRequest when no content can be extracted
     */
    static async importWebsite(workspaceId: string, userId: string, input: ImportWebsiteInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const scraped = await FirecrawlScraper.scrape(input.url);

        return this.createAndQueue({
            workspaceId,
            type: "WEBSITE",
            title: input.title || scraped.title || input.url,
            content: scraped.markdown,
            url: scraped.sourceUrl,
            status: "PENDING",
            metadata: {
                importedFrom: scraped.sourceUrl,
                ...(scraped.author ? { author: scraped.author } : {}),
            },
        });
    }

    /**
     * Fetches a YouTube transcript and creates a YOUTUBE source from it.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param input - Video URL and optional title
     * @throws {APIError} BadRequest when the URL is invalid or has no transcript
     */
    static async importYoutube(workspaceId: string, userId: string, input: ImportYoutubeInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const transcript = await YoutubeClient.fetchTranscript(input.url);

        return this.createAndQueue({
            workspaceId,
            type: "YOUTUBE",
            title: input.title || transcript.title || `YouTube: ${transcript.videoId}`,
            content: transcript.content,
            url: input.url,
            status: "PENDING",
            metadata: {
                videoId: transcript.videoId,
                ...(transcript.author ? { author: transcript.author } : {}),
                ...(transcript.durationSeconds
                    ? { durationSeconds: transcript.durationSeconds }
                    : {}),
            },
        });
    }

    /**
     * Reads a GitHub repository and creates one GITHUB source from its text files.
     *
     * The repository is fetched here (so bad URLs, missing repos and rate limits fail the
     * request); chunking, embedding and indexing run in the background like any source.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param input - `owner/repo` or URL, optional branch and title
     * @throws {APIError} BadRequest for an invalid repo, NotFound when it can't be read,
     *   Conflict when it is already in the workspace
     */
    static async importGithub(workspaceId: string, userId: string, input: ImportGithubInput) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const { owner, repo } = GithubRepoClient.parseRepo(input.url);
        const url = `https://github.com/${owner}/${repo}`;

        const existing = await SourceRepository.findAllByWorkspaceId(workspaceId, {
            type: "GITHUB",
        });
        if (existing.some((source) => source.url?.toLowerCase() === url.toLowerCase())) {
            throw APIError.Conflict(
                "This repository is already in the workspace. Sync it instead.",
            );
        }

        const snapshot = await GithubRepoClient.fetchRepo(owner, repo, input.branch);

        return this.createAndQueue({
            workspaceId,
            type: "GITHUB",
            title: input.title || `${owner}/${repo}`,
            content: GithubRepoClient.pack(snapshot.files),
            url,
            status: "PENDING",
            metadata: githubMetadata(snapshot),
        });
    }

    /**
     * Re-reads a GitHub source's repository and re-indexes it when the branch has new commits.
     *
     * Costs one API call when nothing changed. Existing vectors keep serving chat until the
     * new index replaces them.
     *
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - GITHUB source to sync
     * @param userId - Requesting user
     * @returns The source and whether new commits were found
     * @throws {APIError} BadRequest for non-GitHub sources, Conflict while it is still processing
     */
    static async syncGithub(workspaceId: string, sourceId: string, userId: string) {
        const source = await this.get(workspaceId, sourceId, userId);

        if (source.type !== "GITHUB") {
            throw APIError.BadRequest("Only GitHub sources can be synced");
        }
        if (source.status === "PENDING" || source.status === "PROCESSING") {
            throw APIError.Conflict("This repository is still being processed");
        }

        const metadata = readMetadata(source.metadata);
        if (!metadata.owner || !metadata.repo) {
            throw APIError.BadRequest("This source has no repository information");
        }

        const head = await GithubRepoClient.getHead(metadata.owner, metadata.repo, metadata.branch);
        if (source.status === "READY" && head.commitSha === metadata.commitSha) {
            return { source, changed: false };
        }

        const snapshot = await GithubRepoClient.fetchRepo(
            metadata.owner,
            metadata.repo,
            metadata.branch,
        );

        const updated = await SourceRepository.update(sourceId, {
            content: GithubRepoClient.pack(snapshot.files),
            status: "PENDING",
            metadata: {
                ...githubMetadata(snapshot),
                syncedAt: new Date().toISOString(),
            },
        });

        await EventPublisher.sourceCreated({ sourceId, workspaceId });

        return { source: updated, changed: true };
    }

    /**
     * Lists the files indexed from a GitHub source, with how many chunks each produced.
     *
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - GITHUB source whose files to list
     * @param userId - Requesting user
     * @throws {APIError} BadRequest when the source is not a GitHub repository
     */
    static async getGithubFiles(workspaceId: string, sourceId: string, userId: string) {
        const source = await this.get(workspaceId, sourceId, userId);

        if (source.type !== "GITHUB") {
            throw APIError.BadRequest("Only GitHub sources have files");
        }

        const metadata = readMetadata(source.metadata);
        const chunks = await SourceChunkRepository.findAllBySourceId(sourceId);

        const chunkCounts = new Map<string, number>();
        for (const chunk of chunks) {
            const path =
                chunk.metadata &&
                typeof chunk.metadata === "object" &&
                !Array.isArray(chunk.metadata)
                    ? chunk.metadata.path
                    : undefined;
            if (typeof path === "string") {
                chunkCounts.set(path, (chunkCounts.get(path) ?? 0) + 1);
            }
        }

        return {
            repo: metadata.owner && metadata.repo ? `${metadata.owner}/${metadata.repo}` : null,
            branch: metadata.branch ?? null,
            commitSha: metadata.commitSha ?? null,
            totalFiles: metadata.totalFiles ?? null,
            truncated: metadata.truncated ?? false,
            files: (metadata.files ?? []).map((file) => ({
                ...file,
                chunkCount: chunkCounts.get(file.path) ?? 0,
            })),
        };
    }

    /**
     * Saves a web search result the user chose to keep as a WEBSITE source.
     *
     * @param workspaceId - Workspace to add the source to
     * @param userId - Requesting user; must own the workspace
     * @param input - Title, text content and URL of the result
     */
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
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - Source to delete
     * @param userId - Requesting user
     * @throws {APIError} NotFound when the source is not found
     */
    static async delete(workspaceId: string, sourceId: string, userId: string) {
        await this.get(workspaceId, sourceId, userId);
        await EventPublisher.sourceDeleted({ sourceId, workspaceId });
        await SourceProcessingService.removeFromIndex(workspaceId, sourceId);
        await SourceRepository.delete(sourceId);
    }

    /**
     * Deletes several sources, one by one, and reports what happened to each.
     *
     * Not atomic by design: a missing id or a failure on one source does not stop or undo the
     * others. Ids are de-duplicated, and ids from other workspaces count as `not_found`.
     *
     * @param workspaceId - Workspace the sources belong to
     * @param userId - Requesting user
     * @param sourceIds - Sources to delete
     * @returns How many were deleted and a status for every requested id
     */
    static async bulkDelete(workspaceId: string, userId: string, sourceIds: string[]) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const ids = [...new Set(sourceIds)];
        const existing = new Set(
            (await SourceRepository.findManyByIds(workspaceId, ids)).map((source) => source.id),
        );

        const results: BulkResult<"deleted" | "not_found" | "failed">[] = [];
        for (const sourceId of ids) {
            if (!existing.has(sourceId)) {
                results.push({ sourceId, status: "not_found" });
                continue;
            }

            try {
                await this.delete(workspaceId, sourceId, userId);
                results.push({ sourceId, status: "deleted" });
            } catch (error) {
                logger.warn({ kind: "ingest", sourceId, err: error }, "Bulk delete failed");
                results.push({ sourceId, status: "failed" });
            }
        }

        return {
            deleted: results.filter((result) => result.status === "deleted").length,
            results,
        };
    }

    /**
     * Returns indexed chunks for a source (debugging / admin UI).
     *
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - Source whose chunks to read
     * @param userId - Requesting user
     * @returns The chunks and their count
     */
    static async getChunks(workspaceId: string, sourceId: string, userId: string) {
        await this.get(workspaceId, sourceId, userId);
        return SourceProcessingService.listChunks(sourceId);
    }

    /**
     * Clears a source's vectors/chunks and re-queues it for full re-indexing.
     *
     * @param workspaceId - Workspace the source belongs to
     * @param sourceId - Source to re-index
     * @param userId - Requesting user
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
     * Re-queues sources for indexing.
     *
     * Without `sourceIds`, every FAILED source in the workspace is re-queued. With them, exactly
     * those sources are re-queued whatever their status, so a selection in the library can include
     * READY ones; nothing outside the list is touched. Sources that are still PENDING or
     * PROCESSING are skipped (re-indexing them would race the run in progress), and ids that are
     * not in this workspace are `not_found`. A failure on one source does not stop the others.
     *
     * @param workspaceId - Workspace to search for sources
     * @param userId - Requesting user; must own the workspace
     * @param input.sourceIds - Optional explicit list of source ids
     * @returns Count re-queued and a status for every source considered
     */
    static async reprocessFailed(
        workspaceId: string,
        userId: string,
        input: ReprocessSourcesInput = {},
    ) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const results: BulkResult<"queued" | "skipped" | "not_found" | "failed">[] = [];
        let targets: { id: string }[];

        if (input.sourceIds?.length) {
            const ids = [...new Set(input.sourceIds)];
            const found = await SourceRepository.findManyByIds(workspaceId, ids);
            const foundIds = new Set(found.map((source) => source.id));

            for (const sourceId of ids) {
                if (!foundIds.has(sourceId)) {
                    results.push({ sourceId, status: "not_found" });
                }
            }

            targets = found.filter((source) => {
                if (source.status === "PENDING" || source.status === "PROCESSING") {
                    results.push({
                        sourceId: source.id,
                        status: "skipped",
                        reason: "Already being processed",
                    });
                    return false;
                }
                return true;
            });
        } else {
            targets = await SourceRepository.findAllByWorkspaceId(workspaceId, {
                status: "FAILED",
            });
        }

        for (const { id: sourceId } of targets) {
            try {
                await this.reprocess(workspaceId, sourceId, userId);
                results.push({ sourceId, status: "queued" });
            } catch (error) {
                logger.warn({ kind: "ingest", sourceId, err: error }, "Reprocess failed");
                results.push({ sourceId, status: "failed" });
            }
        }

        return {
            reprocessed: results.filter((result) => result.status === "queued").length,
            results,
        };
    }
}
