import { Inngest } from "inngest";
import { env, inngestDevMode } from "./env.js";
import { logger } from "./logger.js";

export const inngest = new Inngest({
    id: "grounded-brain-notebook-llm",
    eventKey: env.INNGEST_EVENT_KEY,
    signingKey: env.INNGEST_SIGNING_KEY,
    isDev: inngestDevMode,
    logger: logger.child({ component: "inngest" }),
});
