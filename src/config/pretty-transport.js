// Development-only console formatting (see logger.ts): pino-pretty with a coloured label per kind of
// line, compact one-line values for structured fields, and a blank line between entries.
// Production logs stay plain JSON.
import process from "node:process";
import { Writable } from "node:stream";
import pretty from "pino-pretty";

/** `kind` field -> [label, colour]. */
const LABELS = {
    http: ["[HTTP]", "cyan"],
    chat: ["[CHAT]", "magenta"],
    ingest: ["[INGEST]", "green"],
    job: ["[JOB]", "yellow"],
    auth: ["[AUTH]", "blue"],
    external: ["[EXT]", "gray"],
};

export default (options) =>
    pretty({
        ...options,
        ignore: "pid,hostname,req,res,responseTime,kind,service,operation,ms",
        // A blank line after every entry.
        destination: new Writable({
            write: (chunk, _encoding, done) =>
                process.stdout.write(`${chunk.toString()}\n`, () => done()),
        }),
        messageFormat: (log, messageKey, _level, { colors }) => {
            const label = LABELS[log.kind];
            const message = log[messageKey];
            return label ? `${colors[label[1]](colors.bold(label[0]))}  ${message}` : message;
        },
        customPrettifiers: {
            who: (v) =>
                [v.userId ?? "anonymous", v.ip, v.conversationId].filter(Boolean).join(" | "),
            args: (value) => JSON.stringify(value),
        },
    });
