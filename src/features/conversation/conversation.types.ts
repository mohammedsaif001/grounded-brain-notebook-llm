/** A persisted chat turn in the shape the model and query rewriter expect. */
export type ConversationTurn = {
    role: "user" | "assistant";
    content: string;
};
