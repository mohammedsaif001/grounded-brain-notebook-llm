import type { Request, Response } from "express";
import { APIResponse } from "../utils/api-response.js";
import {
    createMemoryForUser,
    deleteMemoryForUser,
    updateMemoryForUser,
} from "../services/memory.service.js";
import { listUserMemories } from "../lib/mem0.js";
import {
    createMemorySchema,
    memoryIdParamSchema,
    updateMemorySchema,
} from "../validators/memory.validator.js";

export async function listMemories(req: Request, res: Response) {
    const memories = await listUserMemories(req.session.user.id);
    APIResponse.Ok(res, memories);
}

export async function createMemory(req: Request, res: Response) {
    const input = createMemorySchema.parse(req.body);
    const memory = await createMemoryForUser(req.session.user.id, input);
    APIResponse.Created(res, memory);
}

export async function updateMemory(req: Request, res: Response) {
    const { memoryId } = memoryIdParamSchema.parse(req.params);
    const input = updateMemorySchema.parse(req.body);
    const memory = await updateMemoryForUser(
        req.session.user.id,
        memoryId,
        input,
    );
    APIResponse.Ok(res, memory);
}

export async function deleteMemory(req: Request, res: Response) {
    const { memoryId } = memoryIdParamSchema.parse(req.params);
    await deleteMemoryForUser(req.session.user.id, memoryId);
    APIResponse.NoContent(res);
}
