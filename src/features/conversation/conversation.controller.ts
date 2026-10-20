import type { Request, Response } from "express";
import { ConversationService } from "./conversation.service.js";
import { APIResponse } from "../../shared/http/api-response.js";
import { conversationIdParamSchema, createConversationSchema } from "./conversation.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

/** HTTP handlers for `/api/workspaces/:workspaceId/conversations`. */
export class ConversationController {
    /** GET `/` — lists conversations, most recently active first (200). */
    static list = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const conversations = await ConversationService.list(workspaceId, req.session.user.id);
        APIResponse.Ok(res, conversations);
    };

    /** POST `/` — creates an empty conversation with an optional title (201). */
    static create = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const input = createConversationSchema.parse(req.body ?? {});
        const conversation = await ConversationService.create(
            workspaceId,
            req.session.user.id,
            input.title,
        );
        APIResponse.Created(res, conversation);
    };

    /** GET `/:conversationId/messages` — returns the full message history (200). */
    static listMessages = async (req: Request, res: Response) => {
        const { workspaceId, conversationId } = conversationIdParamSchema.parse(req.params);
        const messages = await ConversationService.listMessages(
            workspaceId,
            conversationId,
            req.session.user.id,
        );
        APIResponse.Ok(res, messages);
    };

    /** DELETE `/:conversationId` — deletes the conversation and its messages (204). */
    static delete = async (req: Request, res: Response) => {
        const { workspaceId, conversationId } = conversationIdParamSchema.parse(req.params);
        await ConversationService.delete(workspaceId, conversationId, req.session.user.id);
        APIResponse.NoContent(res);
    };
}
