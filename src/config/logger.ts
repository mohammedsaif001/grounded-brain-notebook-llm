/**
 * Application logger (pino).
 *
 * JSON lines in production so any log platform can parse them; pretty-printed in
 * development. Per-request child loggers with a request id are attached by `pino-http`
 * in `app.ts` (`req.log`).
 */

import pino from "pino";
import { env, isProduction } from "./env.js";

export const logger = pino({
    level: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
    redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
    },
    transport: isProduction
        ? undefined
        : {
              target: "pino-pretty",
              options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
          },
});
