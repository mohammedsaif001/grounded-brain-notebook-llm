import { Inngest } from "inngest";
import { env, inngestDevMode } from "../config/env.js";

export const inngest = new Inngest({
    id: "grounded-brain-notebook-llm",
    eventKey: env.INNGEST_EVENT_KEY,
    signingKey: env.INNGEST_SIGNING_KEY,
    isDev: inngestDevMode,
});

export type SourceCreatedEvent = {
    name: "source/created";
    data: {
        sourceId: string;
        workspaceId: string;
    };
};

export type InngestEvents = SourceCreatedEvent;
