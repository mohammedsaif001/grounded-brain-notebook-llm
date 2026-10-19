import {
    MemoryRepository,
    type MemoryMessage,
} from "../repositories/memory.repository.js";
import { APIError } from "../utils/api-error.js";

/** User memory business logic (manual memories plus memories learned from chat). */
export class MemoryService {
    /**
     * Verifies that a memory exists and belongs to the given user.
     *
     * Memories owned by other users are reported as not found so their ids can't be probed.
     *
     * @throws {APIError} NotFound when the memory does not exist or belongs to another user
     */
    private static async assertOwnedByUser(userId: string, memoryId: string) {
        const memory = await MemoryRepository.findById(memoryId);

        if (!memory || memory.userId !== userId) {
            throw APIError.NotFound("Memory not found");
        }
    }

    static listForUser(userId: string) {
        return MemoryRepository.findAllByUserId(userId);
    }

    /** Memories relevant to `query`, for injecting into the chat prompt. */
    static search(userId: string, query: string) {
        return MemoryRepository.search(userId, query);
    }

    /** Stores a user-authored memory verbatim (not inferred). */
    static create(userId: string, input: { memory: string }) {
        return MemoryRepository.create(userId, {
            memory: input.memory,
            metadata: { source: "manual" },
        });
    }

    /** Lets Mem0 infer new memories from conversation turns. */
    static learnFromMessages(
        userId: string,
        messages: MemoryMessage[],
        metadata?: Record<string, unknown>,
    ) {
        return MemoryRepository.createFromMessages(userId, messages, metadata);
    }

    /**
     * @throws {APIError} NotFound when the memory is missing or owned by another user
     */
    static async update(userId: string, memoryId: string, input: { memory: string }) {
        await this.assertOwnedByUser(userId, memoryId);
        return MemoryRepository.update(memoryId, input);
    }

    /**
     * @throws {APIError} NotFound when the memory is missing or owned by another user
     */
    static async delete(userId: string, memoryId: string) {
        await this.assertOwnedByUser(userId, memoryId);
        await MemoryRepository.delete(memoryId);
    }
}
