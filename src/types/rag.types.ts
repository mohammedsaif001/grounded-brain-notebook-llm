/** A source chunk returned from vector search with its similarity score. */
export type RetrievedChunk = {
    sourceId: string;
    sourceTitle: string;
    sourceType: string;
    chunkId: string;
    chunkIndex: number;
    page?: number;
    text: string;
    score: number;
};

/** A prior chat turn used for query rewriting and model history. */
export type ConversationTurn = {
    role: "user" | "assistant";
    content: string;
};
