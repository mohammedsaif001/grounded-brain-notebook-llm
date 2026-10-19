
/** Default chat model when the client or workspace does not specify one. */
export const CHAT_MODEL = "gpt-4o-mini";

/** Allowed chat models exposed to the client and workspace settings. */
export const CHAT_MODELS = ["gpt-4o-mini", "gpt-4o"] as const;

/** OpenAI embedding model used for RAG vector indexing and query embedding. */
export const EMBEDDING_MODEL = "text-embedding-3-small";

/** Vector dimension count — must match Pinecone index configuration. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Target max characters per text chunk during source processing. */
export const CHUNK_SIZE = 1000;

/** Character overlap between consecutive chunks at split boundaries. */
export const CHUNK_OVERLAP = 100;

/** Number of Pinecone chunks to retrieve per chat query. */
export const RAG_TOP_K = 6;

/** Minimum cosine similarity score for a retrieved chunk to be included in context. */
export const RAG_MIN_SCORE = 0.35;

/** Enqueue a conversation summary job once this many messages have accumulated since the last summary. */
export const CONVERSATION_SUMMARY_INTERVAL = 8;

/** Max recent persisted messages sent to the model (older turns are covered by the rolling summary). */
export const RECENT_MESSAGE_WINDOW = 12;

/** Recent messages used to rewrite a follow-up question into a standalone retrieval query. */
export const QUERY_REWRITE_WINDOW = 6;

/** Max Mem0 memories injected into the chat prompt. */
export const MEMORY_SEARCH_TOP_K = 5;

/** Minimum Mem0 relevance score for a memory to be injected into the chat prompt. */
export const MEMORY_SEARCH_MIN_SCORE = 0.3;

/** Max characters of source material sent to a single artifact generation call. */
export const ARTIFACT_MAX_CONTEXT_CHARS = 120_000;

/** Segment size used when condensing oversized sources before artifact generation. */
export const ARTIFACT_CONDENSE_SEGMENT_CHARS = 60_000;
