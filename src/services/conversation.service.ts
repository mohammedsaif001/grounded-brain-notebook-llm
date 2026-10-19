import { ConversationRepository } from "../repositories/conversation.repository.js";
import { MessageRepository } from "../repositories/message.repository.js";
import { APIError } from "../utils/api-error.js";
import { UIMessageUtils } from "../utils/chat-message.js";
import { WorkspaceService } from "./workspace.service.js";

/** Conversation and message history business logic. */
export class ConversationService {
    /** Lists conversations in a workspace, most recently active first. */
    static async list(workspaceId: string, userId: string) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return ConversationRepository.findAllByWorkspaceId(workspaceId);
    }

    /**
     * Creates an empty conversation for an explicit "new chat" action.
     * Most chats are created implicitly on the first message (see {@link ConversationService.getOrCreate}).
     */
    static async create(workspaceId: string, userId: string, title?: string) {
        await WorkspaceService.getForUser(workspaceId, userId);
        return ConversationRepository.create(workspaceId, title);
    }

    /**
     * Loads a conversation in a workspace the user owns.
     *
     * @throws {APIError} NotFound when the workspace or conversation is not found
     */
    static async get(workspaceId: string, conversationId: string, userId: string) {
        await WorkspaceService.getForUser(workspaceId, userId);

        const conversation = await ConversationRepository.findByIdAndWorkspaceId(
            conversationId,
            workspaceId,
        );

        if (!conversation) {
            throw APIError.NotFound("Conversation not found");
        }

        return conversation;
    }

    /**
     * Returns the full persisted message history of a conversation.
     *
     * @throws {APIError} NotFound when the conversation does not exist in this workspace
     */
    static async listMessages(workspaceId: string, conversationId: string, userId: string) {
        await this.get(workspaceId, conversationId, userId);
        return MessageRepository.findAllByConversationId(conversationId);
    }

    /**
     * Deletes a conversation and all its messages (cascade).
     *
     * @throws {APIError} NotFound when the conversation does not exist
     */
    static async delete(workspaceId: string, conversationId: string, userId: string) {
        await this.get(workspaceId, conversationId, userId);
        await ConversationRepository.delete(conversationId);
    }

    /**
     * Returns the given conversation, or creates one titled from the first message.
     * Assumes workspace ownership was already verified by the caller.
     *
     * @throws {APIError} NotFound when `conversationId` is provided but not found
     */
    static async getOrCreate(
        workspaceId: string,
        conversationId: string | undefined,
        firstMessage: string,
    ) {
        if (!conversationId) {
            return ConversationRepository.create(
                workspaceId,
                UIMessageUtils.buildConversationTitle(firstMessage),
            );
        }

        const existing = await ConversationRepository.findByIdAndWorkspaceId(
            conversationId,
            workspaceId,
        );

        if (!existing) {
            throw APIError.NotFound("Conversation not found");
        }

        return existing;
    }
}
