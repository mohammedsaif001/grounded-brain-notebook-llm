/**
 * Application logger (pino).
 *
 * JSON lines in production so any log platform can parse them; pretty-printed in
 * development. Per-request child loggers with a request id are attached by `pino-http`
 * in `app.ts` (`req.log`).
 *
 * When `AXIOM_TOKEN` is set, every log line is also shipped to Axiom's `AXIOM_DATASET`
 * (searchable in its web UI), in addition to the console output.
 */

import pino, { type TransportTargetOptions } from "pino";
import { env, isProduction } from "./env.js";

/** Minimum level written, from `LOG_LEVEL` or `info` in production / `debug` otherwise. */
const level = env.LOG_LEVEL ?? (isProduction ? "info" : "debug");

/** Console output: pretty in development, plain JSON on stdout in production. */
const consoleTarget: TransportTargetOptions = isProduction
    ? { target: "pino/file", level, options: { destination: 1 } }
    : {
          target: "pino-pretty",
          level,
          options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      };

/** Axiom output, only when a token is configured (env validation then guarantees a dataset). */
const axiomTarget: TransportTargetOptions | null =
    env.AXIOM_TOKEN && env.AXIOM_DATASET
        ? {
              target: "@axiomhq/pino",
              level,
              options: {
                  token: env.AXIOM_TOKEN,
                  dataset: env.AXIOM_DATASET,
                  ...(env.AXIOM_EDGE ? { edge: env.AXIOM_EDGE } : {}),
              },
          }
        : null;

/**
 * Transports to run in pino's worker thread. Production without Axiom writes straight to
 * stdout instead (no worker), which is the fastest option.
 */
const targets = axiomTarget ? [consoleTarget, axiomTarget] : isProduction ? [] : [consoleTarget];

/**
 * Root pino logger. Use `logger.child({ component })` for module-scoped loggers.
 *
 * Auth and cookie headers are redacted from logged requests/responses.
 */
export const logger = pino({
    level,
    redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        censor: "[redacted]",
    },
    transport: targets.length > 0 ? { targets } : undefined,
});
