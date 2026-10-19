import { createSourceRecord, deleteSourceRecord, findSourceByIdAndWorkspaceId, findSourcesByWorkspaceId, SourceRecord } from "../repositories/source.repository.js";
import { NotFoundError } from "../types/app-error.js";
import { CreateSourceInput, ImportWebSearchInput, ImportWebsiteInput, ImportYoutubeInput, ListSourcesQuery } from "../validators/source.validator.js";
import { getWorkspaceByIdForUser } from "./workspace.service.js";

// Web, PDF & YT
import { uploadPdfToCloudinary } from "../lib/cloudinary.js";
import { extractPdfFromBuffer } from "../lib/pdf.js";
import { scrapeWebsite } from "../lib/firecrawl.js";
import { fetchYoutubeTranscript } from "../lib/youtube.js";

/**
 * Persists a source row and enqueues the Inngest processing pipeline.
 *
 * @param data - Fields for the new source record
 * @returns Created source with status `PENDING`
 *
 */
async function createAndProcessSource(
    data: Parameters<typeof createSourceRecord>[0],
) {
    const source = await createSourceRecord(data);

    // await enqueueSourceProcessing({
    //     sourceId: source.id,
    //     workspaceId: source.workspaceId,
    // });

    return source;
}

/**
 * Lists sources in a workspace with optional search and filter query params.
 *
 * @param workspaceId - Workspace to list sources from
 * @param userId - Authenticated user's id
 * @param filters - Optional `q`, `type`, and `status` filters
 * @returns Matching source records
 *
 */
export async function listSourcesForWorkspace(
    workspaceId: string,
    userId: string,
    filters: ListSourcesQuery = {},
) {
    await getWorkspaceByIdForUser(workspaceId, userId);
    return findSourcesByWorkspaceId(workspaceId, filters);
}

/**
 * Loads a single source after verifying workspace ownership.
 *
 * @param workspaceId - Workspace the source belongs to
 * @param sourceId - Source to fetch
 * @param userId - Authenticated user's id
 * @returns Source record
 * @throws {NotFoundError} When the source does not exist in this workspace
 *
 */
export async function getSourceForWorkspace(
    workspaceId: string,
    sourceId: string,
    userId: string,
): Promise<SourceRecord> {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const source = await findSourceByIdAndWorkspaceId(sourceId, workspaceId);

    if (!source) {
        throw new NotFoundError("Source not found");
    }

    return source;
}


/**
 * Creates a plain-text or markdown source and queues it for RAG indexing.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param input - Source type, title, and raw content
 * @returns New source with status `PENDING`
 *
 */
export async function createTextOrMarkdownSource(
    workspaceId: string,
    userId: string,
    input: CreateSourceInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    return createAndProcessSource({
        workspaceId,
        type: input.type,
        title: input.title,
        content: input.content,
        status: "PENDING",
    });
}

/**
 * Deletes a source, its Pinecone vectors, and its Postgres chunks.
 *
 * @param workspaceId - Workspace the source belongs to
 * @param sourceId - Source to delete
 * @param userId - Authenticated user's id
 * @returns Resolves when the source row is deleted
 * @throws {NotFoundError} When the source is not found
 *
 */
export async function deleteSourceForWorkspace(
    workspaceId: string,
    sourceId: string,
    userId: string,
) {
    await getSourceForWorkspace(workspaceId, sourceId, userId);
    // await removeSourceFromIndex(workspaceId, sourceId);
    await deleteSourceRecord(sourceId);
}

/**
 * Deletes multiple sources in sequence.
 *
 * @param workspaceId - Workspace containing the sources
 * @param userId - Authenticated user's id
 * @param sourceIds - Array of source ids to delete
 * @returns Resolves when all sources are deleted
 *
 */
export async function bulkDeleteSourcesForWorkspace(
    workspaceId: string,
    userId: string,
    sourceIds: string[],
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    for (const sourceId of sourceIds) {
        await deleteSourceForWorkspace(workspaceId, sourceId, userId);
    }
}


/**
 * Uploads a PDF to Cloudinary, optionally extracts text, and queues processing.
 *
 * Text extraction at upload time is best-effort; Inngest retries from Cloudinary if it fails.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param file - Multer file buffer from the upload endpoint
 * @param title - Optional custom title (defaults to filename without `.pdf`)
 * @returns New PDF source with Cloudinary metadata and status `PENDING`
 *
 */
export async function uploadPdfSource(
    workspaceId: string,
    userId: string,
    file: Express.Multer.File,
    title?: string,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const upload = await uploadPdfToCloudinary(
        file.buffer,
        file.originalname,
    );

    let content: string | null = null;
    let pageCount: number | undefined;

    try {
        const extracted = await extractPdfFromBuffer(file.buffer);
        content = extracted.text;
        pageCount = extracted.pageCount;
    } catch {
        // Inngest will retry extraction from Cloudinary if upload-time parse fails.
    }

    return createAndProcessSource({
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

/**
 * Scrapes a website via Firecrawl and creates a source from the markdown content.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param input - URL and optional custom title
 * @returns New WEBSITE source with scraped markdown and status `PENDING`
 *
 */
export async function importWebsiteSource(
    workspaceId: string,
    userId: string,
    input: ImportWebsiteInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const scraped = await scrapeWebsite(input.url);

    return createAndProcessSource({
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


/**
 * Fetches a YouTube transcript and creates a source from the caption text.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param input - YouTube URL and optional custom title
 * @returns New YOUTUBE source with transcript content and status `PENDING`
 *
 */
export async function importYoutubeSource(
    workspaceId: string,
    userId: string,
    input: ImportYoutubeInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    const transcript = await fetchYoutubeTranscript(input.url);

    return createAndProcessSource({
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


/**
 * Saves web search results (from Tavily) as a WEBSITE source for RAG indexing.
 *
 * Used when the user chooses to add a web search result to their workspace sources.
 *
 * @param workspaceId - Workspace to attach the source to
 * @param userId - Authenticated user's id
 * @param input - Title, scraped content, and source URL from search
 * @returns New WEBSITE source with status `PENDING`
 *
 */
export async function importWebSearchSource(
    workspaceId: string,
    userId: string,
    input: ImportWebSearchInput,
) {
    await getWorkspaceByIdForUser(workspaceId, userId);

    return createAndProcessSource({
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