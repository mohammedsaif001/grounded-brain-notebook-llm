/**
 * Process entry point: starts telemetry, opens the HTTP port, and handles graceful shutdown.
 */

import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initTelemetry, shutdownTelemetry } from "./config/telemetry.js";

initTelemetry();

/** The HTTP server created by `app.listen`. */
const server = app.listen(env.PORT, () => {
    logger.info(
        { env: env.NODE_ENV, port: env.PORT },
        `Server running on http://localhost:${env.PORT}`,
    );
});

server.on("error", (error) => {
    logger.fatal({ err: error }, "HTTP server error");
    process.exit(1);
});

// Last-resort handlers so a stray rejection or crash is logged before the process dies.
process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "Uncaught exception");
    process.exit(1);
});

/**
 * Stops accepting connections and flushes traces before exiting.
 *
 * @param signal - The OS signal that triggered shutdown (`SIGTERM` or `SIGINT`)
 */
function shutdown(signal: NodeJS.Signals) {
    logger.info({ signal }, "Shutting down");
    server.close();
    void shutdownTelemetry().finally(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
