import type { Request, Response } from "express";
import { MemoryService } from "./memory.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import { createMemorySchema, memoryIdParamSchema, updateMemorySchema } from "./memory.validator.js";

export class MemoryController {
    static list = async (req: Request, res: Response) => {
        const memories = await MemoryService.listForUser(req.session.user.id);
        APIResponse.Ok(res, memories);
    };

    static create = async (req: Request, res: Response) => {
        const input = createMemorySchema.parse(req.body);
        const memory = await MemoryService.create(req.session.user.id, input);
        APIResponse.Created(res, memory);
    };

    static update = async (req: Request, res: Response) => {
        const { memoryId } = memoryIdParamSchema.parse(req.params);
        const input = updateMemorySchema.parse(req.body);
        const memory = await MemoryService.update(req.session.user.id, memoryId, input);
        APIResponse.Ok(res, memory);
    };

    static delete = async (req: Request, res: Response) => {
        const { memoryId } = memoryIdParamSchema.parse(req.params);
        await MemoryService.delete(req.session.user.id, memoryId);
        APIResponse.NoContent(res);
    };
}
