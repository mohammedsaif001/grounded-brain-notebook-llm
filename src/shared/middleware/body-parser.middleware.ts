/** Body parsing middleware (JSON and URL-encoded). */

import express from "express";

/**
 * Max size of JSON and form bodies. File uploads go through multer with their own limit.
 *
 * Chat only needs the latest message (history is loaded server-side), but clients using
 * `useChat` defaults still send the full history, so allow headroom above the 100kb default.
 */
const BODY_LIMIT = "2mb";

/** JSON and URL-encoded form body parsers. */
export const bodyParsers = [
    express.json({ limit: BODY_LIMIT }),
    express.urlencoded({ extended: true, limit: BODY_LIMIT }),
];
