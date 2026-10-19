import type { Request, Response } from "express";
import type { UIMessage } from "ai";
import { ChatService } from "./chat.service.js";
import { chatBodySchema } from "./chat.validator.js";
import { workspaceIdParamSchema } from "../workspace/workspace.validator.js";

export class ChatController {
    /** Streams the reply as an AI SDK UI message stream (not the JSON envelope). */
    static stream = async (req: Request, res: Response) => {
        const { workspaceId } = workspaceIdParamSchema.parse(req.params);
        const body = chatBodySchema.parse(req.body);

        await ChatService.stream(res, workspaceId, req.session.user.id, {
            conversationId: body.conversationId,
            messages: body.messages as unknown as UIMessage[],
            model: body.model,
            webSearch: body.webSearch,
        });
    };
}
