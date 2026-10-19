import {
    addUserMemory,
    deleteUserMemory,
    getUserMemory,
    updateUserMemory,
} from "../lib/mem0.js";
import { APIError } from "../utils/api-error.js";

/**
 * Verifies that a memory exists and belongs to the given user.
 *
 * Memories owned by other users are reported as not found so their ids can't be probed.
 *
 * @param userId - Authenticated user's id
 * @param memoryId - Mem0 memory id
 * @throws {APIError} NotFound when the memory does not exist or belongs to another user
 *
 */
async function assertMemoryOwnedByUser(userId: string, memoryId: string) {
    const memory = await getUserMemory(memoryId);

    if (!memory || memory.userId !== userId) {
        throw APIError.NotFound("Memory not found");
    }
}

/**
 * Creates a user-authored memory (not inferred by Mem0).
 *
 * @param userId - Owner of the memory
 * @param input - Raw memory text from the client
 * @returns Created Mem0 memory record
 * @throws {APIError} BadRequest when memory text is empty after trimming
 *
 *
 */
export function createMemoryForUser(
    userId: string,
    input: { memory: string },
) {
    return addUserMemory(userId, {
        memory: input.memory,
        infer: false,
        metadata: { source: "manual" },
    });
}

/**
 * Updates the text of a memory after verifying the user owns it.
 *
 * @param userId - Authenticated user's id
 * @param memoryId - Mem0 memory id to update
 * @param input - New memory text
 * @returns Updated Mem0 memory record
 * @throws {APIError} NotFound when the memory is missing or owned by another user
 *
 */
export async function updateMemoryForUser(
    userId: string,
    memoryId: string,
    input: { memory: string },
) {
    await assertMemoryOwnedByUser(userId, memoryId);
    return updateUserMemory(memoryId, input);
}

/**
 * Deletes a memory after verifying the user owns it.
 *
 * @param userId - Authenticated user's id
 * @param memoryId - Mem0 memory id to delete
 * @returns Resolves when deletion completes
 * @throws {APIError} NotFound when the memory is missing or owned by another user
 *
 */
export async function deleteMemoryForUser(userId: string, memoryId: string) {
    await assertMemoryOwnedByUser(userId, memoryId);
    await deleteUserMemory(memoryId);
}
