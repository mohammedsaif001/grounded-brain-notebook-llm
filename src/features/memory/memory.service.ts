import { MemoryRepository, type MemoryMessage } from "./memory.repository.js";
import { APIError } from "../../shared/http/api-error.js";

/** User memory business logic (manual memories plus memories learned from chat). */
export class MemoryService {
    /**
     * Verifies that a memory exists and belongs to the given user.
     *
     * Memories owned by other users are reported as not found so their ids can't be probed.
     *
     * @param userId - Expected owner
     * @param memoryId - Memory to check
     * @throws {APIError} NotFound when the memory does not exist or belongs to another user
     */
    private static async assertOwnedByUser(userId: string, memoryId: string) {
        const memory = await MemoryRepository.findById(memoryId);

        if (!memory || memory.userId !== userId) {
            throw APIError.NotFound("Memory not found");
        }
    }

    /**
     * Lists a user's memories.
     *
     * @param userId - Owner's user id
     */
    static listForUser(userId: string) {
        return MemoryRepository.findAllByUserId(userId);
    }

    /**
     * Memories relevant to `query`, for injecting into the chat prompt.
     *
     * @param userId - Owner's user id
     * @param query - The user's message or rewritten query
     */
    static search(userId: string, query: string) {
        return MemoryRepository.search(userId, query);
    }

    /**
     * Stores a user-authored memory verbatim (not inferred), tagged `source: "manual"`.
     *
     * @param userId - Owner's user id
     * @param input.memory - Memory text
     */
    static create(userId: string, input: { memory: string }) {
        return MemoryRepository.create(userId, {
            memory: input.memory,
            metadata: { source: "manual" },
        });
    }

    /**
     * Lets Mem0 infer new memories from conversation turns.
     *
     * @param userId - Owner's user id
     * @param messages - Turns to learn from
     * @param metadata - Optional metadata attached to created memories
     */
    static learnFromMessages(
        userId: string,
        messages: MemoryMessage[],
        metadata?: Record<string, unknown>,
    ) {
        return MemoryRepository.createFromMessages(userId, messages, metadata);
    }

    /**
     * Replaces a memory's text after verifying ownership.
     *
     * @param userId - Requesting user
     * @param memoryId - Memory to update
     * @param input.memory - New text
     * @throws {APIError} NotFound when the memory is missing or owned by another user
     */
    static async update(userId: string, memoryId: string, input: { memory: string }) {
        await this.assertOwnedByUser(userId, memoryId);
        return MemoryRepository.update(memoryId, input);
    }

    /**
     * Deletes a memory after verifying ownership.
     *
     * @param userId - Requesting user
     * @param memoryId - Memory to delete
     * @throws {APIError} NotFound when the memory is missing or owned by another user
     */
    static async delete(userId: string, memoryId: string) {
        await this.assertOwnedByUser(userId, memoryId);
        await MemoryRepository.delete(memoryId);
    }
}
