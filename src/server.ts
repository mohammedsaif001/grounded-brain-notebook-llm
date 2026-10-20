import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initTelemetry, shutdownTelemetry } from "./config/telemetry.js";

initTelemetry();

const server = app.listen(env.PORT, () => {
    logger.info(`Server running on http://localhost:${env.PORT}`);
});

/** Stops accepting connections and flushes traces before exiting. */
function shutdown(signal: NodeJS.Signals) {
    logger.info({ signal }, "Shutting down");
    server.close();
    void shutdownTelemetry().finally(() => process.exit(0));
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
