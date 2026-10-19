import { MemoryNotFoundError } from "mem0ai";
import { Mem0Client } from "../lib/mem0.js";
import { MEMORY_SEARCH_MIN_SCORE, MEMORY_SEARCH_TOP_K } from "../lib/ai-config.js";

/** Message shape accepted by Mem0 for inferred memory extraction. */
export type MemoryMessage = {
    role: "user" | "assistant";
    content: string;
};

/** Normalized memory record returned by the memory APIs. */
export type MemoryRecord = {
    id: string;
    memory: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown> | null;
    categories?: string[];
    source: "manual" | "learned";
};

/** Maps a raw Mem0 record into the app's {@link MemoryRecord} shape. */
function toMemoryRecord(record: {
    id: string;
    memory?: string;
    createdAt?: Date | string;
    updatedAt?: Date | string;
    metadata?: Record<string, unknown> | null;
    categories?: string[];
}): MemoryRecord {
    const metadata = record.metadata ?? null;
    const createdAt = record.createdAt ?? new Date().toISOString();
    const updatedAt = record.updatedAt ?? createdAt;

    return {
        id: record.id,
        memory: record.memory ?? "",
        createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
        updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt,
        metadata,
        categories: record.categories,
        source: metadata?.source === "manual" ? "manual" : "learned",
    };
}

/**
 * Data access for user memories (Mem0).
 *
 * Read methods return empty results when Mem0 isn't configured so chat keeps working;
 * write methods throw `ServiceUnavailable` via {@link Mem0Client.get}.
 */
export class MemoryRepository {
    /** Lists up to 100 memories for a user. */
    static async findAllByUserId(userId: string) {
        if (!Mem0Client.isConfigured()) {
            return [];
        }

        const page = await Mem0Client.get().getAll({
            filters: { user_id: userId },
            page: 1,
            pageSize: 100,
        });

        return page.results.map(toMemoryRecord);
    }

    /** Fetches one memory plus its owning `userId`, or `null` when it doesn't exist. */
    static async findById(memoryId: string) {
        try {
            const record = await Mem0Client.get().get(memoryId);
            return { ...toMemoryRecord(record), userId: record.userId ?? null };
        } catch (error) {
            if (error instanceof MemoryNotFoundError) {
                return null;
            }
            throw error;
        }
    }

    /** Semantic search over a user's memories, above {@link MEMORY_SEARCH_MIN_SCORE}. */
    static async search(userId: string, query: string) {
        if (!Mem0Client.isConfigured() || !query.trim()) {
            return [];
        }

        const results = await Mem0Client.get().search(query, {
            filters: { user_id: userId },
            topK: MEMORY_SEARCH_TOP_K,
            threshold: MEMORY_SEARCH_MIN_SCORE,
        });

        return results.results.map(toMemoryRecord);
    }

    /**
     * Stores one memory verbatim (no inference).
     *
     * @throws When Mem0 returns no created record
     */
    static async create(
        userId: string,
        input: { memory: string; metadata?: Record<string, unknown> },
    ) {
        const created = await Mem0Client.get().add(
            [{ role: "user", content: input.memory }],
            {
                userId,
                infer: false,
                metadata: input.metadata,
            },
        );

        const first = created[0];
        if (!first) {
            throw new Error("Mem0 did not return a created memory");
        }

        return toMemoryRecord(first);
    }

    /** Lets Mem0 infer and store memories from conversation turns. No-op when Mem0 is off. */
    static async createFromMessages(
        userId: string,
        messages: MemoryMessage[],
        metadata?: Record<string, unknown>,
    ) {
        if (!Mem0Client.isConfigured() || messages.length === 0) {
            return;
        }

        await Mem0Client.get().add(messages, {
            userId,
            infer: true,
            metadata,
        });
    }

    /**
     * Replaces a memory's text.
     *
     * @throws When Mem0 returns no updated record
     */
    static async update(memoryId: string, input: { memory: string }) {
        const updated = await Mem0Client.get().update(memoryId, {
            text: input.memory,
        });

        const first = updated[0];
        if (!first) {
            throw new Error("Mem0 did not return an updated memory");
        }

        return toMemoryRecord(first);
    }

    static async delete(memoryId: string) {
        await Mem0Client.get().delete(memoryId);
    }
}
