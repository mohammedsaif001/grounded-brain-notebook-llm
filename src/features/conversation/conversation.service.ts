import { APIError } from "../../shared/http/api-error.js";
import { WorkspaceService } from "../workspace/workspace.service.js";
import { ConversationRepository, type ConversationRecord } from "./conversation.repository.js";
import type { ConversationTurn } from "./conversation.types.js";
import { MessageRepository, type CreateMessageData } from "./message.repository.js";

/** Max characters of a conversation title derived from the first message. */
const MAX_TITLE_LENGTH = 72;

/** Conversations and their message history. Other features (chat) go through this service. */
export class ConversationService {
    /** Builds a sidebar title from a user message, truncated to {@link MAX_TITLE_LENGTH}. */
    private static buildTitle(text: string) {
        const normalized = text.replace(/\s+/g, " ").trim();
        if (!normalized) {
            return "New chat";
        }

        return normalized.length > MAX_TITLE_LENGTH
            ? `${normalized.slice(0, MAX_TITLE_LENGTH).trim()}…`
            : normalized;
    }

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
            return ConversationRepository.create(workspaceId, this.buildTitle(firstMessage));
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

    /** Appends a message to a conversation. */
    static addMessage(data: CreateMessageData) {
        return MessageRepository.create(data);
    }

    /** Latest `limit` messages as model turns, oldest first. */
    static async getRecentTurns(
        conversationId: string,
        limit: number,
    ): Promise<ConversationTurn[]> {
        const messages = await MessageRepository.findRecentByConversationId(conversationId, limit);

        return messages.map((message) => ({
            role: message.role === "USER" ? "user" : "assistant",
            content: message.content,
        }));
    }

    static countMessages(conversationId: string) {
        return MessageRepository.countByConversationId(conversationId);
    }

    /** Bumps `updatedAt` so the conversation sorts to the top of the sidebar. */
    static async touch(conversationId: string) {
        await ConversationRepository.touch(conversationId);
    }

    /** Sets a title from `firstMessage` if the conversation doesn't have one yet. */
    static async ensureTitle(conversation: ConversationRecord, firstMessage: string) {
        if (!conversation.title) {
            await ConversationRepository.update(conversation.id, {
                title: this.buildTitle(firstMessage),
            });
        }
    }
}
