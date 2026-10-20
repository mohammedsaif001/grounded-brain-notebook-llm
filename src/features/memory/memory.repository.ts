import { MemoryNotFoundError, ValidationError } from "mem0ai";
import { Mem0Client } from "../../config/mem0.js";
import { MEMORY_SEARCH_MIN_SCORE, MEMORY_SEARCH_TOP_K } from "../../config/ai.config.js";

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

/**
 * Maps a raw Mem0 record into the app's {@link MemoryRecord} shape.
 *
 * Fills in missing timestamps, serialises dates to ISO strings and derives `source`
 * (`manual` when `metadata.source` says so, otherwise `learned`).
 *
 * @param record - Raw record from the Mem0 SDK
 * @returns The normalised memory
 */
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

/** A raw Mem0 memory object, before normalisation. */
type RawMemory = Parameters<typeof toMemoryRecord>[0];

/**
 * Extracts the first memory from a Mem0 write response.
 *
 * mem0ai's typings say `add`/`update` return `Memory[]`, but the platform API actually
 * returns `{ results: [{ id, data: { memory } }] }` from `add` and a single memory object
 * from `update`. All three shapes are accepted so an SDK fix doesn't break us either way.
 *
 * @param response - Whatever the Mem0 SDK returned from `add` or `update`
 * @returns The first memory, or `null` when the response contains none
 */
function firstMemory(response: unknown): RawMemory | null {
    if (Array.isArray(response)) {
        return (response[0] as RawMemory | undefined) ?? null;
    }

    if (!response || typeof response !== "object") {
        return null;
    }

    const { results } = response as { results?: unknown };
    if (Array.isArray(results)) {
        const first = results[0] as (RawMemory & { data?: { memory?: string } }) | undefined;
        return first ? { ...first, memory: first.memory ?? first.data?.memory } : null;
    }

    return "id" in response ? (response as RawMemory) : null;
}

/**
 * Data access for user memories (Mem0).
 *
 * Read methods return empty results when Mem0 isn't configured so chat keeps working;
 * write methods throw `ServiceUnavailable` via {@link Mem0Client.get}.
 */
export class MemoryRepository {
    /**
     * Lists up to 100 memories for a user.
     *
     * @param userId - Owner's user id
     * @returns Memories, or an empty array when Mem0 isn't configured
     */
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

    /**
     * Fetches one memory plus its owning `userId`, or `null` when it doesn't exist.
     *
     * @param memoryId - Mem0 memory id (malformed ids are treated as not found)
     */
    static async findById(memoryId: string) {
        try {
            const record = await Mem0Client.get().get(memoryId);
            return { ...toMemoryRecord(record), userId: record.userId ?? null };
        } catch (error) {
            // Mem0 rejects ids that aren't UUIDs with a ValidationError; such an id can't
            // match any memory, so it's "not found" too rather than a server error.
            if (error instanceof MemoryNotFoundError || error instanceof ValidationError) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Semantic search over a user's memories, above {@link MEMORY_SEARCH_MIN_SCORE}.
     *
     * @param userId - Owner's user id
     * @param query - Text to match against; blank returns nothing
     * @returns Up to {@link MEMORY_SEARCH_TOP_K} memories, or `[]` when Mem0 is off
     */
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
     * @param userId - Owner's user id
     * @param input.memory - Memory text
     * @param input.metadata - Optional metadata, e.g. `{ source: "manual" }`
     * @returns The created memory
     * @throws When Mem0 returns no created record
     */
    static async create(
        userId: string,
        input: { memory: string; metadata?: Record<string, unknown> },
    ) {
        const created = await Mem0Client.get().add([{ role: "user", content: input.memory }], {
            userId,
            infer: false,
            metadata: input.metadata,
        });

        const first = firstMemory(created);
        if (!first) {
            throw new Error("Mem0 did not return a created memory");
        }

        // The add response doesn't echo metadata; use what we sent so `source` is right.
        return toMemoryRecord({ ...first, metadata: first.metadata ?? input.metadata ?? null });
    }

    /**
     * Lets Mem0 infer and store memories from conversation turns. No-op when Mem0 is off.
     *
     * @param userId - Owner's user id
     * @param messages - Conversation turns to learn from
     * @param metadata - Optional metadata attached to the created memories
     */
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
     * @param memoryId - Memory to update
     * @param input.memory - New text
     * @returns The updated memory
     * @throws When Mem0 returns no updated record
     */
    static async update(memoryId: string, input: { memory: string }) {
        const updated = await Mem0Client.get().update(memoryId, {
            text: input.memory,
        });

        const first = firstMemory(updated);
        if (!first) {
            throw new Error("Mem0 did not return an updated memory");
        }

        return toMemoryRecord(first);
    }

    /**
     * Deletes a memory.
     *
     * @param memoryId - Memory to delete
     */
    static async delete(memoryId: string) {
        await Mem0Client.get().delete(memoryId);
    }
}
