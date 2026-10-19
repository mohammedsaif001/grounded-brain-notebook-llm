import type { Request, Response } from "express";
import { ConversationService } from "../services/conversation.service.js";
import { APIResponse } from "../utils/api-response.js";
import {
    conversationIdParamSchema,
    createConversationSchema,
} from "../validators/chat.validator.js";
import { workspaceIdParamSchema } from "../validators/workspace.validator.js";

export class ConversationController {
    static async list(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const conversations = await ConversationService.list(workspaceId, req.session.user.id);
        APIResponse.Ok(res, conversations);
    }

    static async create(req: Request, res: Response) {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createConversationSchema.parse(req.body ?? {});
        const conversation = await ConversationService.create(
            workspaceId,
            req.session.user.id,
            input.title,
        );
        APIResponse.Created(res, conversation);
    }

    static async listMessages(req: Request, res: Response) {
        const { workspaceId, conversationId } = conversationIdParamSchema.parse(req.params);
        const messages = await ConversationService.listMessages(
            workspaceId,
            conversationId,
            req.session.user.id,
        );
        APIResponse.Ok(res, messages);
    }

    static async delete(req: Request, res: Response) {
        const { workspaceId, conversationId } = conversationIdParamSchema.parse(req.params);
        await ConversationService.delete(workspaceId, conversationId, req.session.user.id);
        APIResponse.NoContent(res);
    }
}
