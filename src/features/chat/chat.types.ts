/** A source chunk returned from vector search with its similarity score. */
export type RetrievedChunk = {
    sourceId: string;
    sourceTitle: string;
    sourceType: string;
    chunkId: string;
    /** 0-based position of the chunk in its source. */
    chunkIndex: number;
    /** Chunks in the source; missing for sources indexed before it was recorded. */
    chunkTotal?: number;
    page?: number;
    /** PDF chapter the chunk falls under. */
    chapter?: string;
    /** Markdown heading the chunk falls under. */
    section?: string;
    /** File path within a repository (GITHUB sources). */
    path?: string;
    text: string;
    score: number;
};
