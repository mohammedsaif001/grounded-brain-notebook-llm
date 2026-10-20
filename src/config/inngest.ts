/**
 * Inngest client used to publish events (see `jobs/events.ts`) and to define
 * background functions (see `jobs/index.ts`).
 *
 * Keys are optional in development, where the Inngest dev server needs none.
 */

import { Inngest } from "inngest";
import { env, inngestDevMode } from "./env.js";
import { logger } from "./logger.js";

/** The application's single Inngest client. */
export const inngest = new Inngest({
    id: "grounded-brain-notebook-llm",
    eventKey: env.INNGEST_EVENT_KEY,
    signingKey: env.INNGEST_SIGNING_KEY,
    isDev: inngestDevMode,
    logger: logger.child({ component: "inngest" }),
});
