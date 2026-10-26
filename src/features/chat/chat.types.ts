/** A source chunk returned from vector search with its similarity score. */
export type RetrievedChunk = {
    sourceId: string;
    sourceTitle: string;
    sourceType: string;
    chunkId: string;
    chunkIndex: number;
    page?: number;
    /** File path within a repository (GITHUB sources). */
    path?: string;
    text: string;
    score: number;
};
