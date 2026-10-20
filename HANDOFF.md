# Grounded Brain — Handoff

Backend for a NotebookLM-style app: users create **workspaces**, add **sources** (PDF, website, YouTube, text, markdown), **chat** with them (RAG with citations), and generate **learning artifacts** (summary, takeaways, flashcards, quiz, mind map, report). Long-term **user memory** via Mem0.

State as of 2026-10-20: all work committed on `main` (last commit `afd1d8c`), working tree clean. `npm run check` and `npm run build` pass.

---

## Stack

| Concern         | Tech                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime         | Node 24, TypeScript 5.9 (ESM, `"type": "module"`, imports use `.js` suffix)                                    |
| HTTP            | Express 5                                                                                                      |
| DB              | Postgres via Prisma 7 (`@prisma/adapter-pg`), client generated to `src/generated/prisma`                       |
| Auth            | Better Auth (email/password in non-prod, optional Google OAuth)                                                |
| Background jobs | Inngest                                                                                                        |
| LLM             | OpenAI via AI SDK v7 (`gpt-4o-mini` default, `gpt-4o` allowed); embeddings `text-embedding-3-small` (1536d)    |
| Vectors         | Pinecone (one namespace per workspace)                                                                         |
| Memory          | Mem0                                                                                                           |
| Ingestion       | Cloudinary (PDF storage), unpdf (PDF text), Firecrawl (websites), youtube-transcript, Tavily (chat web search) |
| Validation      | zod v4 (request bodies, env, job payloads)                                                                     |

## Run it

```bash
npm install
cp .env.example .env          # fill in values; env is validated on boot (src/config/env.ts)
npx inngest-cli@latest dev    # separate terminal, for background jobs
npm run dev                   # tsx watch src/server.ts
npm run check                 # typecheck + eslint + prettier --check
npm run build && npm start    # dist/server.js
```

Required env: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `OPENAI_API_KEY`, `PINECONE_API_KEY`. Everything else is optional (features degrade gracefully) — see `.env.example`. In production, `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY` are required unless `INNGEST_DEV` is set.

---

## Project structure

```
src/
├── server.ts            app.listen only
├── app.ts               Express app: cors, rate limit, auth, body parsers, Inngest endpoint, routes, error handlers
├── routes.ts            mounts each feature's router (workspace-scoped routers nested under workspaceRouter)
├── config/              starting point: env + constants + clients created once
│   ├── env.ts           ONLY place that reads process.env (zod-validated, exits on bad config)
│   ├── ai.config.ts     model names, RAG/chunk/summary/artifact constants
│   ├── db.ts  auth.ts  inngest.ts  mem0.ts  pinecone.ts  cloudinary.ts
│   └── openai.ts        AI SDK model wrapper + OpenAI client + shared outbound rate-limit queue
├── shared/              used by 2+ features
│   ├── http/            APIError, APIResponse, asyncHandler
│   ├── middleware/      require-auth, error-handler (+ notFoundHandler), rate-limit
│   ├── ai/              embeddings (EmbeddingClient), vector.repository (Pinecone)
│   └── types/           session.types
├── jobs/                Inngest functions (index.ts) + EventPublisher (events.ts)
└── features/            one folder per feature; files named <feature>.<role>.ts
    ├── workspace/       routes · controller · service · repository · validator
    ├── source/          routes · controller · service · repository · validator · middleware (multer PDF upload)
    │                    source-processing.service, source-chunk.repository
    │                    ingestion/ youtube, firecrawl, pdf (PdfExtractor), pdf-validator, cloudinary (CloudinaryStorage), chunking (TextChunker)
    ├── conversation/    routes · controller · service · repository · validator · types
    │                    message.repository, conversation-memory.service (rolling summaries + Mem0 learning)
    ├── chat/            routes · controller · service · validator · types
    │                    retrieval.service, chat-prompt (ChatPrompt), chat-message.util, web-search/tavily
    ├── memory/          routes · controller · service · repository (Mem0) · validator
    └── artifact/        routes · controller · service · repository · validator, artifact-generation.service

prisma/
├── schema.prisma        generator + datasource only
├── models/*.prisma      one file per model (enums live with their model); Prisma merges the folder
└── migrations/
prisma7.config.ts        schema: "prisma" (folder), migrations path, datasource url
```

## Architecture rules (keep these)

1. **Flow:** `routes → controllers → services → repositories`. Controllers parse input (zod) and call **only services**. Only repositories touch Prisma / Pinecone / Mem0.
2. **Cross-feature access only via services** (plus validators/types). Repositories are private to their feature. E.g. artifacts use `SourceService.listReady*`, chat uses `ConversationService.*` — never another feature's repository.
3. **Everything is a class with static camelCase methods**: `WorkspaceService.getForUser`, `SourceRepository.findById`. Controllers use **static arrow properties** (`static list = async (req, res) => {}`) so they're safe to pass as route handlers (ESLint `unbound-method`).
4. **`config/` = setup, `shared/` = cross-feature code, feature-specific helpers live inside the feature.** `config/` imports nothing from features; `shared/` imports no features.
5. **Errors:** `throw APIError.NotFound(...)` (factories: BadRequest, Validation, Unauthorized, Forbidden, NotFound, Conflict, PayloadTooLarge, TooManyRequests, Internal, ServiceUnavailable). Never `res.status().json()` — use `APIResponse.Ok/Created/Accepted/NoContent`.
6. **Response envelope:** `{ success: true, data, message? }` / `{ success: false, error: { code, message, details? } }`. Exception: chat endpoint streams an AI SDK UI message stream.
7. **Ownership:** every workspace-scoped service method calls `WorkspaceService.getForUser(workspaceId, userId)` first (returns 404 for other users' workspaces). Memory ops check `memory.userId === userId`.
8. **Background jobs** call services only and validate `event.data` with zod. Publish events via `EventPublisher`, never `inngest.send` directly.

## API surface (all under auth except `/`, `/health`, `/api/auth/*`)

```
GET    /health
GET    /api/me
ALL    /api/auth/*                                         Better Auth
/api/workspaces                         GET POST  |  /:workspaceId  GET PATCH DELETE
/api/workspaces/:id/sources             GET POST(text/md)  POST /upload (multipart "file", "title")
                                        POST /import/website | /import/youtube | /import/web-search
                                        POST /bulk-delete  POST /reprocess (failed)
                                        GET/DELETE /:sourceId  GET /:sourceId/chunks  POST /:sourceId/reprocess
/api/workspaces/:id/conversations       GET POST  GET /:conversationId/messages  DELETE /:conversationId
/api/workspaces/:id/chat                POST  (streams; body: { conversationId?, messages, model?, webSearch? }; header X-Conversation-Id)
/api/workspaces/:id/artifacts           GET POST  GET/DELETE /:artifactId
/api/memory                             GET POST  PATCH/DELETE /:memoryId
/api/inngest                            Inngest (signed)
```

---

## Key flows

**Source ingestion** — `SourceService` creates the row (status PENDING) and publishes `source/created`. Job `process-source` (concurrency 1 per source; cancelled on `source/deleted` / `workspace/deleted`):

1. `extractAndChunk` — text from DB or PDF (Cloudinary download, signed-URL fallback) → recursive chunker (≤1000 chars, 100 overlap, PDF chunks keep `page`) → `source_chunk` rows. Extract+chunk are one step so big text never goes through Inngest state.
2. `index` — embed in batches of 50 → delete old vectors for the source → upsert → mark READY (or clean up if source deleted mid-run).
   PDF uploads are validated **before** Cloudinary: `%PDF-` header, must parse, ≤1000 pages, no JavaScript / launch actions / embedded files / XFA (raw-byte scan + pdf.js document & page checks), filename sanitized.

**Chat** (`ChatService.stream`):
save user msg → load last 12 messages **from DB** (client history ignored; only latest user message used) → rewrite follow-up into standalone query (LLM, only if prior turns) → parallel Pinecone retrieval (top 6, score ≥ 0.35) + Mem0 search (top 5, ≥ 0.3) → system prompt holds rules/memories/summary; **retrieved chunks go in the user turn inside `<sources>`** (prompt-injection hardening) → `streamText` with optional `web_search` (Tavily, `[W#]` labels unique across calls) → on finish: save assistant msg with **only the citations actually used** (each has `marker`), touch conversation, set title, enqueue summary when `messageCount - summaryMessageCount ≥ 8` (event id bucketed for dedupe).

**Conversation memory** (job `summarize-conversation`, concurrency 1 per conversation): incremental summary = previous summary + messages since `summaryMessageCount`; the same new messages go to Mem0 for memory extraction (the **only** place chat memories are learned).

**Artifacts**: create validates READY sources (no content load) → PENDING row → `artifact/generate` job → gather source text; if over 120k chars, budget split fairly and oversized sources condensed in 60k-char segments (map-reduce) → structured output per type → quiz `correctIndex` and mind-map edges sanitized → READY/FAILED.

## Rate limiting

- **Inbound** (`shared/middleware/rate-limit.middleware.ts`, express-rate-limit, in-memory store): 300/15min per IP on `/api` (skips `/api/inngest`); `aiRateLimiter` 20/min per user (chat, artifact create); `ingestionRateLimiter` 30/10min per user (uploads, imports, text create, reprocess). Errors use the standard envelope. `TRUST_PROXY_HOPS` env for real client IP behind proxies.
- **Outbound OpenAI** (`config/openai.ts`, p-queue): one shared queue for chat, generation, rewriting, embeddings; `OPENAI_MAX_CONCURRENCY` (4), `OPENAI_REQUESTS_PER_MINUTE` (300), `OPENAI_MAX_QUEUE` (100 → then 429 "AI service is busy"). OpenAI client `maxRetries: 3`. Provider 429s mapped to `TOO_MANY_REQUESTS` (HTTP) / readable in-stream message (chat).

## Tooling

`npm run check` = `tsc --noEmit` + `eslint .` (typescript-eslint `recommendedTypeChecked`) + `prettier --check .` (4 spaces, double quotes, 100 cols, LF; JSON/YAML 2 spaces). `.gitattributes` forces LF (repo is developed on Windows). Dev deps pinned exact.

---

## Commit history this session (oldest → newest)

1. `7eba6c5` Register missing Inngest jobs, fix memory IDOR, DB-loaded chat history, summary trigger, chunker, RAG quality (query rewrite, injection hardening, cited-only citations, Mem0 tuning, artifact map-reduce)
2. `921a9bd` Central zod-validated env (`config/env.ts`)
3. `6d96a02` `APIError` / `APIResponse` + envelope, not-found handler, body-parser error mapping
4. `34c7451` Class-based layers
5. `c254276` Clients → `config/`
6. `8370df4` Prisma per-model files
7. `f8dbd5f` Feature modules (+ conversation split from chat, `app.ts`/`server.ts`)
8. `adf2981` Rate limiting (API + OpenAI), urlencoded, PDF content validation
9. `afd1d8c` Prettier + ESLint, fixes for 55 lint findings (zod job payloads, upload body schema, controller arrow methods)

## Breaking changes the frontend must handle

- Every JSON response is wrapped: read `body.data`; errors at `body.error.{code,message}`. Deletes return 204.
- Message `citations` contain only cited items and each has `marker` (number used in `[n]` / `[Wn]`) — map by `marker`, not array index.
- `GET /sources` no longer returns `content` (use `GET /sources/:id`).
- Chat may send only the latest message; history is server-side.
- 429 responses can now come from rate limits.
- "Not configured" integrations (Cloudinary/Firecrawl/Mem0) return 503.

## Open items / known gaps

- **`requireWorkspaceAccess` middleware** (`workspace.middleware.ts`) — proposed, not built: verify workspace once per request and attach to `req`, replacing ~20 `WorkspaceService.getForUser` calls.
- **No tests** exist. `app.ts` is importable for supertest-style tests.
- **`npm audit`** reported vulnerabilities — not investigated.
- Infra issues found in the initial review, not fixed: `docker-compose.yml` mounts init SQL to `/` and its credentials/DB name don't match `.env.example`; pgvector image unused (vectors are in Pinecone); PDF reprocess fallback `resourceType` is `"image"` but uploads are `raw` (`source-processing.service.ts`).
- RAG: no reranking or hybrid search yet.
- Rate-limit counters are per instance — add a Redis store (`rate-limit-redis`) before running multiple instances. Per-user limiters not tested with a live session.
- PDF validation is not antivirus; consider ClamAV / cloud malware scanning. Parse-time checks for JS hidden in compressed streams weren't separately triggered in tests.
- `listSources` `?q=` still does `ILIKE` on full `content` (slow on large data).

## Gotchas

- Prisma config file is `prisma7.config.ts` (Prisma auto-detects it); `schema` points at the `prisma/` folder.
- npm may print `install-scripts` warnings for prisma/protobufjs (new npm policy); `prisma generate`/`validate` still work.
- `src/generated/prisma` is gitignored; `dev`/`build` run `prisma generate` first.
- On this Windows box, `npx tsx -e "..."` hangs — run scratch scripts as `.mts` files instead.
- When smoke-testing, run on a spare port (`PORT=8099 node dist/server.js`) and stop only that port's process.
