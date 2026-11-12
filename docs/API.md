# API guide and Postman collection

Every endpoint, feature by feature: what to send, what comes back, and which errors to expect.
The [Postman collection](../grounded-brain.postman_collection.json) has a ready-made request
(with tests) for everything listed here.

Related docs: [README](../README.md) · [Architecture](ARCHITECTURE.md) · [Database](DATABASE.md)

---

## Contents

- [Using the Postman collection](#using-the-postman-collection)
- [Conventions](#conventions) (base URL, auth, envelope, errors, rate limits)
- [00 · Health](#00--health)
- [01 · Auth](#01--auth)
- [02 · Workspaces](#02--workspaces)
- [03 · Sources](#03--sources)
- [04 · Sources: uploads and imports](#04--sources-uploads-and-imports)
- [05 · Chat](#05--chat)
- [06 · Conversations](#06--conversations)
- [07 · Memory](#07--memory)
- [08 · Artifacts](#08--artifacts)
- [09 · Cross-user isolation](#09--cross-user-isolation)
- [10 · Cleanup](#10--cleanup) and [11 · Signed out](#11--signed-out-401)
- [Endpoint index](#endpoint-index)

---

## Using the Postman collection

1. **Import** `grounded-brain.postman_collection.json` (Postman → Import → File).
2. **Start the stack:** `npm run dev`. This starts Postgres, the API on `:8080`, the Inngest dev
   server (needed for background processing) and Prisma Studio.
3. **Run it all:** open the collection → **Run** (Collection Runner) → Run. Folders run in order and
   build on each other: sign up → workspace → sources → chat → memory → artifacts → isolation
   checks → cleanup → signed-out checks.
4. **Or send requests one by one** in folder order. Ids are saved into collection variables
   automatically by the request that creates them.

What the collection does for you:

- A **collection-level pre-request script** adds the `Origin` header Better Auth requires.
- **Sign up** generates a fresh email per run (`user-<timestamp>@test.local`), so you can re-run it any time.
- Postman's cookie jar keeps the **session cookie** after sign-in.
- **"Wait until READY"** requests poll every 2 s in the Collection Runner (sources up to ~90 s,
  artifacts longer). Sent by hand they just show the current status; re-send until `READY`.
- Requests prefixed `[400]`, `[401]`, `[404]` are **negative tests** that check the error responses.
- Every request has **tests** (status code, envelope shape, saved ids).

### Collection variables

| Variable                                                 | Meaning                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `baseUrl`                                                | API base URL, default `http://localhost:8080`                                              |
| `origin`                                                 | Must match the server's `CLIENT_URL`, default `http://localhost:3000`                      |
| `emailA`, `emailB`, `password`                           | Test users (emails generated per run)                                                      |
| `workspaceId`                                            | Set by **Create workspace**                                                                |
| `sourceId`, `sourceId2`, `pdfSourceId`, `githubSourceId` | Set by the source create/upload requests                                                   |
| `conversationId`, `conversationId2`                      | Set by **Send first message** (from `X-Conversation-Id`) and **Create empty conversation** |
| `memoryId`                                               | Set by **Create memory**                                                                   |
| `artifactId`, `wikiArtifactId`                           | Set by the artifact create requests                                                        |
| `pollCount`                                              | Internal counter for the polling requests                                                  |

### Optional integrations

Some requests need extra API keys in the server's `.env`. Without them the server answers **503
`SERVICE_UNAVAILABLE`** and the rest keeps working.

| Requests                    | Needs                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Upload PDF                  | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET`                                                                      |
| Import website              | `FIRECRAWL_API_KEY`                                                                                                      |
| Import GitHub repo          | nothing for public repos; `GITHUB_TOKEN` for private repos and a higher rate limit (otherwise **503** when rate-limited) |
| Send with web search        | `TAVILY_API_KEY` (otherwise web search is silently off)                                                                  |
| Memory create/update/delete | `MEM0_API_KEY`                                                                                                           |
| Chat and artifacts          | `OPENAI_API_KEY`, `PINECONE_API_KEY` (always required)                                                                   |

---

## Conventions

### Base URL

`http://localhost:8080` locally. All feature routes are under `/api`; health checks are under `/health`.

### Authentication

Cookie sessions via Better Auth. Sign up or sign in, then send the session cookie on every
request. Browsers do this automatically (`credentials: "include"`); Postman does it with its
cookie jar. Requests must come from the `CLIENT_URL` origin. All `/api/workspaces/**` and
`/api/memory/**` routes return **401** without a session.

### Response envelope

```jsonc
// success
{ "success": true, "data": { /* resource or list */ }, "message": "optional", "meta": { /* paginated lists only */ } }

// error
{ "success": false, "error": { "code": "NOT_FOUND", "message": "Workspace not found", "details": { } } }
```

- **201** for creates, **202** for accepted async work, **204** (no body) for deletes.
- **Pagination.** `GET .../sources` and `GET .../artifacts` take `?limit=` (1–100) and `?cursor=`.
  Without `limit` the whole list comes back, as before. Every response carries
  `meta: { "total": <matching rows>, "nextCursor": "<id>" | null }`; pass `nextCursor` as `cursor`
  to get the next page, and stop when it is `null`.
- **Optimistic concurrency.** `PATCH` on a source or an artifact accepts `expectedUpdatedAt` (the
  `updatedAt` you last read). If the item changed since, the request is rejected with **409**
  `CONFLICT` and nothing is written; reload and retry. The check and the write are one atomic
  statement, so two simultaneous edits from the same version can never both succeed. Sources and
  artifacts return `updatedAt` everywhere they are returned.
- `POST /chat` is the exception: it returns a **stream**, not JSON.
- Every response has an **`X-Request-Id`** header. Send your own `X-Request-Id` to correlate with server logs.
- Resources that exist but belong to someone else return **404** (not 403).

### Error codes

| Status | Code                    | Typical cause                                                       |
| ------ | ----------------------- | ------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`      | Body/params/query failed validation; `details` has field errors     |
| 400    | `BAD_REQUEST`           | Invalid JSON, bad PDF, no ready sources, invalid YouTube URL, ...   |
| 401    | `UNAUTHORIZED`          | No or expired session                                               |
| 404    | `NOT_FOUND`             | Unknown route, or the resource isn't yours                          |
| 409    | `CONFLICT`              | Unique constraint, a stale `expectedUpdatedAt`, or still processing |
| 409    | `ARTIFACT_EDITED`       | Regenerating an artifact the user edited, without `force`           |
| 413    | `PAYLOAD_TOO_LARGE`     | Body > 2 MB or PDF > 10 MB                                          |
| 429    | `TOO_MANY_REQUESTS`     | Rate limit hit, or the OpenAI queue is full                         |
| 500    | `INTERNAL_SERVER_ERROR` | Unexpected; check the server log for the request id                 |
| 503    | `SERVICE_UNAVAILABLE`   | Integration not configured, or database/AI provider unavailable     |

Validation error example:

```json
{
    "success": false,
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "Validation failed",
        "details": { "title": ["Title is required"] }
    }
}
```

### Rate limits

| Scope                                              | Limit                        |
| -------------------------------------------------- | ---------------------------- |
| All `/api` routes                                  | 300 requests / 15 min per IP |
| `POST /chat`, `POST /artifacts`                    | 20 / min per user            |
| `POST /artifacts/:id/regenerate`                   | 20 / min per user (AI limit) |
| Source create, upload, imports, reprocess, `PATCH` | 30 / 10 min per user         |

Over the limit: **429**. `RateLimit-*` response headers show the remaining budget.

---

## 00 · Health

Public, no auth.

### `GET /health`

Liveness: the process is running. Never touches dependencies.

```json
{ "success": true, "data": { "status": "ok" } }
```

### `GET /health/ready`

Readiness: probes every dependency (5 s timeout each, cached 10 s).

- **200** with `status: "ok"`, or `"degraded"` when only an optional integration is down.
- **503** `SERVICE_UNAVAILABLE` when a required one (database, Pinecone, OpenAI, Inngest) is down;
  the report is in `error.details`.

```json
{
    "success": true,
    "data": {
        "status": "ok",
        "checks": {
            "database": { "status": "up", "required": true, "latencyMs": 3 },
            "pinecone": { "status": "up", "required": true, "latencyMs": 210 },
            "openai": { "status": "up", "required": true, "latencyMs": 180 },
            "inngest": { "status": "up", "required": true, "latencyMs": 4 },
            "mem0": { "status": "up", "required": false, "latencyMs": 150 },
            "cloudinary": { "status": "configured", "required": false },
            "firecrawl": { "status": "configured", "required": false },
            "tavily": { "status": "not_configured", "required": false },
            "langfuse": { "status": "not_configured", "required": false }
        }
    }
}
```

Check statuses: `up`, `down`, `configured` (keys set, no free probe), `not_configured`.
`latencyMs` and `error` appear only outside production.

---

## 01 · Auth

Handled by Better Auth under `/api/auth/*`. These responses are Better Auth's own JSON, **not**
the app envelope. Email/password works only when `NODE_ENV` is not `production`; production uses
Google (`POST /api/auth/sign-in/social` with `{ "provider": "google" }`).

| Request              | Endpoint                       | Body                              | Expect                                               |
| -------------------- | ------------------------------ | --------------------------------- | ---------------------------------------------------- |
| Sign up              | `POST /api/auth/sign-up/email` | `{ "name", "email", "password" }` | 200, `{ user, token }`, session cookie set           |
| Sign in              | `POST /api/auth/sign-in/email` | `{ "email", "password" }`         | 200, session cookie set                              |
| [401] Wrong password | `POST /api/auth/sign-in/email` | wrong password                    | 401                                                  |
| Get session          | `GET /api/auth/get-session`    | –                                 | 200, `{ session, user }` (or `null` when signed out) |
| Current user         | `GET /api/me`                  | –                                 | 200, app envelope with the user                      |
| Sign out             | `POST /api/auth/sign-out`      | –                                 | 200, cookie cleared                                  |

`GET /api/me`:

```json
{
    "success": true,
    "data": {
        "id": "Xk2...",
        "name": "Test User",
        "email": "user-1729418400000@test.local",
        "emailVerified": false,
        "image": null,
        "createdAt": "2026-10-20T10:00:00.000Z",
        "updatedAt": "2026-10-20T10:00:00.000Z"
    }
}
```

---

## 02 · Workspaces

`/api/workspaces` · auth required. A workspace is a notebook; everything else lives inside one.

### Workspace object

```json
{
    "id": "cm2abc...",
    "title": "Biology notes",
    "description": "Photosynthesis and respiration",
    "icon": "sprout",
    "defaultModel": "gpt-4o-mini",
    "sourceCount": 8,
    "artifactCount": 6,
    "createdAt": "2026-10-20T10:00:00.000Z",
    "updatedAt": "2026-10-20T10:00:00.000Z"
}
```

`sourceCount` is every source in the notebook, whatever its status; `artifactCount` is every
artifact (study guide). Both come with the list, so a dashboard needs no per-notebook requests.
`icon` is any short string up to 8 characters: a key such as `sprout` or `rocket`, or a legacy
emoji. The server stores it as given; the client decides how to draw it.

| Request           | Endpoint                                   | Body / query                                                                                                            | Success                                                                                   |
| ----------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Create workspace  | `POST /api/workspaces`                     | `title` (1–120, required), `description` (≤500), `icon` (≤8), `defaultModel` (`gpt-4o-mini` \| `gpt-4o`)                | **201** workspace                                                                         |
| List workspaces   | `GET /api/workspaces`                      | `q` (title or description, case-insensitive), `sort` (`updatedAt` \| `createdAt` \| `title`), `order` (`asc` \| `desc`) | **200** array; default `sort=updatedAt`, newest first (`title` defaults to A–Z)           |
| Get workspace     | `GET /api/workspaces/:workspaceId`         | –                                                                                                                       | **200** workspace                                                                         |
| Workspace summary | `GET /api/workspaces/:workspaceId/summary` | –                                                                                                                       | **200** `{ sourceCount, readySourceCount, processingArtifactCount, unseenArtifactCount }` |
| Update workspace  | `PATCH /api/workspaces/:workspaceId`       | any create field; at least one                                                                                          | **200** workspace                                                                         |
| Delete workspace  | `DELETE /api/workspaces/:workspaceId`      | –                                                                                                                       | **204**                                                                                   |

The summary is cheap enough to poll for the sidebar: `processingArtifactCount` is artifacts still
`PENDING` or `PROCESSING`, and `unseenArtifactCount` is `READY` artifacts nobody has opened yet
(see `POST .../artifacts/:artifactId/viewed`).

Deleting a workspace also cancels its running background jobs, deletes its vectors, and (by
cascade) its sources, chunks, conversations, messages and artifacts.

Negative tests in the collection:

| Request                                 | Expect                                                    |
| --------------------------------------- | --------------------------------------------------------- |
| [400] Create with blank title (`"   "`) | 400 `VALIDATION_ERROR`                                    |
| [400] Update with empty body `{}`       | 400 `VALIDATION_ERROR` ("At least one field is required") |
| [400] Malformed JSON body               | 400 `BAD_REQUEST` ("Request body is not valid JSON")      |
| [404] Get nonexistent workspace         | 404 `NOT_FOUND`                                           |

---

## 03 · Sources

`/api/workspaces/:workspaceId/sources` · auth required.

Sources are the material a workspace is grounded in. Creating one returns it as `PENDING`; a
background job extracts text, chunks it, embeds it and indexes it, then marks it `READY` (or
`FAILED` with `metadata.processingError`). **Poll `GET /:sourceId` until it is `READY`** before
expecting chat to use it.

Statuses: `PENDING` → `PROCESSING` → `READY` | `FAILED`.

### Source object

```json
{
    "id": "cm2src...",
    "workspaceId": "cm2abc...",
    "type": "TEXT",
    "title": "Photosynthesis",
    "content": "Photosynthesis turns light into chemical energy...",
    "url": null,
    "status": "READY",
    "metadata": { "chunkCount": 3, "indexedAt": "2026-10-20T10:00:05.000Z" },
    "createdAt": "2026-10-20T10:00:00.000Z",
    "updatedAt": "2026-10-20T10:00:05.000Z"
}
```

List responses leave out `content` (it can be very large). See
[DATABASE.md](DATABASE.md#sourcemetadata-sourcemetadata-in-source-processingservicets) for every `metadata` field.

| Request                    | Endpoint                                        | Body / query                                                           | Success                                                 |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| Create TEXT source         | `POST /`                                        | `{ "type": "TEXT", "title" (≤200), "content" }`                        | **201** source (`PENDING`)                              |
| Create MARKDOWN source     | `POST /`                                        | `{ "type": "MARKDOWN", "title", "content" }`                           | **201** source (`PENDING`)                              |
| Wait until source is READY | `GET /:sourceId`                                | –                                                                      | **200**; poll until `status` is `READY`                 |
| List sources               | `GET /`                                         | `limit`, `cursor` (see Pagination)                                     | **200** array (no `content`), newest first, plus `meta` |
| List sources (filtered)    | `GET /?type=TEXT&status=READY&q=photosynthesis` | `type`, `status`, `q` (title or content, case-insensitive)             | **200** array, plus `meta`                              |
| Get source                 | `GET /:sourceId`                                | –                                                                      | **200** source with `content`                           |
| Get source chunks          | `GET /:sourceId/chunks`                         | –                                                                      | **200** `{ chunks: [...], count }`                      |
| Reprocess one source       | `POST /:sourceId/reprocess`                     | –                                                                      | **202** `{ reprocessed: true }`                         |
| Reprocess sources          | `POST /reprocess`                               | `{}` (all FAILED) or `{ "sourceIds": [...] }` (exactly those)          | **200** `{ reprocessed, results }`                      |
| Edit source                | `PATCH /:sourceId`                              | `{ "title"?, "content"?, "expectedUpdatedAt"? }` (≥1 of title/content) | **200** source with `content`                           |
| Exclude / include a chunk  | `PATCH /:sourceId/chunks/:chunkId`              | `{ "excluded": true }`                                                 | **200** chunk                                           |
| Delete source              | `DELETE /:sourceId`                             | –                                                                      | **204**                                                 |
| Bulk delete sources        | `POST /bulk-delete`                             | `{ "sourceIds": ["...", "..."] }` (≥1)                                 | **200** `{ deleted, results }`                          |

**Editing a source: `PATCH /:sourceId`.** Body `{ "title"?: 1-200, "content"?: non-empty, "expectedUpdatedAt"?: ISO }`;
unknown keys are rejected. Returns the source exactly as `GET /:sourceId` does.

- **Title** (any source type): saved, and the vectors' `sourceTitle` is updated so chat citations show the
  new title. No re-embedding; the source stays `READY`.
- **Content** (`TEXT` and `MARKDOWN` only; others get **400** "Content can only be edited for text and
  markdown sources"): the new text **replaces** the old. The old chunks and vectors are deleted, the
  source goes back to `PENDING` and through ingestion, and the new chunks are embedded from the new text
  only. Nothing is appended, so no mix of old and new text can be retrieved. Poll until `READY`. Sending
  the content the source already has changes nothing.
- **409** while the source is `PENDING` or `PROCESSING`; **409 `CONFLICT`** when `expectedUpdatedAt` is stale.
- Earlier chat messages keep the citation text they were saved with, and artifacts already generated keep
  what they were built from; regenerate an artifact to pick up an edit.

**Excluding a chunk: `PATCH /:sourceId/chunks/:chunkId`.** Body `{ "excluded": boolean }` (strict).
Excluded chunks stay indexed but are skipped by chat retrieval (the vector query filters them out) and
left out of artifact generation. Nothing is re-embedded. Returns the chunk. **404** for an unknown chunk,
**409** while the source is processing. Flags do not survive a re-index (re-indexing creates new chunks).

**Bulk behaviour.** Both bulk endpoints are per-id, not all-or-nothing: one bad id never stops or
undoes the others, and the response lists what happened to every id.

- `POST /bulk-delete` → `{ "deleted": 2, "results": [{ "sourceId", "status": "deleted" | "not_found" | "failed" }] }`.
  Ids are de-duplicated; ids from other workspaces are `not_found`.
- `POST /reprocess` without `sourceIds` re-queues every `FAILED` source. With `sourceIds` it re-queues
  **exactly those** sources whatever their status (so READY ones can be re-indexed too) and touches
  nothing else. It returns `{ "reprocessed": 2, "results": [{ "sourceId", "status": "queued" | "skipped" | "not_found" | "failed", "reason"? }] }`.
  A source that is still `PENDING` or `PROCESSING` is `skipped`.

**Normalised `metadata`.** The same keys mean the same thing for every source type; keys that do
not apply are absent.

| Key               | Meaning                                                                                 | Set for                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `author`          | Who wrote or published it: PDF author, YouTube channel, site name, repository owner     | PDF (if the file names one), YOUTUBE, WEBSITE (when the page says), GITHUB |
| `pageCount`       | Number of pages                                                                         | PDF                                                                        |
| `wordCount`       | Words in the text (known at once for text, markdown, web pages, videos; PDFs once read) | all                                                                        |
| `durationSeconds` | Length of the video                                                                     | YOUTUBE                                                                    |
| `fileCount`       | Files that were read                                                                    | GITHUB                                                                     |
| `repo`, `owner`   | Repository name and its owner (`owner/repo` is both joined by `/`)                      | GITHUB                                                                     |

Sources imported before these keys existed gain them when reprocessed (`wordCount`, `author` for PDFs).
YouTube titles now default to the video's real title (fetched best-effort), not `YouTube: <id>`.

Chunk object (from `/chunks`):

```json
{
    "id": "cm2chk...",
    "sourceId": "cm2src...",
    "index": 0,
    "content": "Photosynthesis turns light...",
    "tokenCount": 212,
    "metadata": { "page": 1 },
    "excluded": false,
    "createdAt": "2026-10-20T10:00:04.000Z"
}
```

Negative tests:

| Request                                     | Expect                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| [400] PDF type via JSON                     | 400 `VALIDATION_ERROR` (only `TEXT`/`MARKDOWN` via `POST /`; use `/upload` for PDFs) |
| [400] Invalid type filter (`?type=VIDEO`)   | 400 `VALIDATION_ERROR`                                                               |
| [404] Get nonexistent source                | 404 `NOT_FOUND`                                                                      |
| [400] Edit source with an empty body        | 400 `VALIDATION_ERROR`                                                               |
| [400] Edit content of a PDF source          | 400 `BAD_REQUEST` (title edits are allowed for every type)                           |
| [409] Edit with a stale `expectedUpdatedAt` | 409 `CONFLICT`                                                                       |
| [409] Edit a source that is processing      | 409 `CONFLICT`                                                                       |
| [404] Exclude a nonexistent chunk           | 404 `NOT_FOUND`                                                                      |

---

## 04 · Sources: uploads and imports

Same base path and same lifecycle as above: each returns **201** with a `PENDING` source.

### Upload PDF: `POST /api/workspaces/:workspaceId/sources/upload`

`multipart/form-data` with:

| Field   | Required | Notes                                                 |
| ------- | -------- | ----------------------------------------------------- |
| `file`  | yes      | A `.pdf`, ≤ 10 MB                                     |
| `title` | no       | ≤ 200 chars; defaults to the file name without `.pdf` |

In Postman, pick a PDF in the `file` field of the request body (the collection can't ship a file).

The server checks the actual bytes. Expect **400** for: not a real PDF, password-protected,
more than 1000 pages, or active content (JavaScript, embedded files, launch actions). **413** for
files over 10 MB. **503** when Cloudinary isn't configured.

`metadata` on a PDF source: `fileUrl`, `fileName`, `fileSize`, `publicId`, `resourceType`,
`pageCount`. Its chunks carry `metadata.page`, so chat citations can show page numbers.

### Import website: `POST .../sources/import/website`

```json
{ "url": "https://en.wikipedia.org/wiki/Photosynthesis", "title": "optional" }
```

Scraped to markdown by Firecrawl. The title defaults to the page title. **400** if nothing could
be extracted; **503** without `FIRECRAWL_API_KEY`.

### Import YouTube: `POST .../sources/import/youtube`

```json
{ "url": "https://www.youtube.com/watch?v=aircAruvnKk", "title": "optional" }
```

Accepts `watch?v=`, `youtu.be/`, `embed/` and `shorts/` URLs. The title defaults to
`YouTube: <videoId>`. **400** for an invalid URL or a video without captions (collection test:
**[400] Bad YouTube URL**).

### Import a GitHub repository: `POST .../sources/import/github`

```json
{ "url": "owner/repo", "branch": "optional", "title": "optional" }
```

Accepts `owner/repo`, `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo.git`.
The whole repository becomes **one** `GITHUB` source: text files are read (up to 200 files /
2 MB, overview files first; lockfiles, binaries, `node_modules`, `dist`, ... are skipped) and
chunked per file, so every chunk and chat citation carries the file `path`. The title defaults
to `owner/repo`. Public repos work without a token; set `GITHUB_TOKEN` on the server for
private repos and a higher rate limit.

`metadata` holds `owner`, `repo`, `branch`, `commitSha`, `totalFiles`, `truncated` and the list
of indexed `files`. **404** repo not found / private, **409** already in the workspace,
**503** GitHub rate limit or bad server token. Collection requests: **Import GitHub repo**,
**Wait until GitHub repo is READY**, **List GitHub repo files**, **Sync GitHub repo**,
**[409] Import the same repo again**, **[400] Bad repo string**, **[400] Sync a non-GitHub source**.

### Sync a repository: `POST .../sources/:sourceId/sync`

Checks the branch's latest commit (one API call). **202** with `{ "source", "changed": false }`
when nothing changed; otherwise the repo is re-read, the source goes back to `PENDING` and is
re-indexed (`changed: true`). Old vectors keep serving chat until the new index replaces them.
**400** for non-GitHub sources, **409** while the source is still processing.

### List repository files: `GET .../sources/:sourceId/files`

```json
{
    "repo": "owner/repo",
    "branch": "main",
    "commitSha": "d0dd1f6...",
    "totalFiles": 42,
    "truncated": false,
    "files": [{ "path": "src/index.ts", "size": 1832, "chunkCount": 3 }]
}
```

### Import a web search result: `POST .../sources/import/web-search`

```json
{
    "title": "Chlorophyll",
    "content": "Chlorophyll absorbs mostly blue and red light...",
    "url": "https://en.wikipedia.org/wiki/Chlorophyll"
}
```

Saves a result the user found through chat web search as a `WEBSITE` source
(`metadata.importedFrom = "web-search"`).

---

## 05 · Chat

`POST /api/workspaces/:workspaceId/chat` · auth required · 20 requests/min per user.

Answers from the workspace's **READY** sources with inline citations (`[1]`, `[2]`), optionally
using web search (`[W1]`). The reply is **streamed**.

### Request

```json
{
    "conversationId": "cm2conv...",
    "model": "gpt-4o-mini",
    "webSearch": false,
    "messages": [
        {
            "id": "msg-1",
            "role": "user",
            "parts": [{ "type": "text", "text": "What does the Calvin cycle produce?" }]
        }
    ]
}
```

| Field            | Required | Notes                                                                                                                                                 |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`       | yes (≥1) | AI SDK `UIMessage` format. **Only the latest user message is used**; history is loaded from the database, so sending just `[latestMessage]` is enough |
| `conversationId` | no       | Omit to start a new conversation (titled from the message)                                                                                            |
| `model`          | no       | `gpt-4o-mini` or `gpt-4o`; defaults to the workspace's `defaultModel`                                                                                 |
| `webSearch`      | no       | `true` gives the model a web search tool (needs `TAVILY_API_KEY`)                                                                                     |

### Response

- **Status 200**, `Content-Type: text/event-stream`: an AI SDK **UI message stream**. The
  `useChat` hook consumes it directly. Raw, it looks like:

    ```
    data: {"type":"start"}
    data: {"type":"text-start","id":"..."}
    data: {"type":"text-delta","id":"...","delta":"The Calvin cycle "}
    data: {"type":"text-delta","id":"...","delta":"produces glucose [1]."}
    data: {"type":"text-end","id":"..."}
    data: {"type":"finish"}
    data: [DONE]
    ```

- **Header `X-Conversation-Id`**: the conversation id (new or existing). The collection saves it
  as `conversationId`.
- **Citations** are not in the stream. After the reply finishes, the server saves the assistant
  message with the sources it actually cited; read them from
  [`GET /conversations/:id/messages`](#06--conversations).
- Errors **before** streaming starts use the normal JSON envelope (400/401/404/429). Errors
  **during** the stream arrive as a `{"type":"error","errorText":"..."}` chunk.

| Request                      | What it shows                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Send first message           | Starts a conversation; saves `conversationId`                                           |
| Send follow-up               | Same `conversationId`; the follow-up is rewritten into a standalone query for retrieval |
| Send with web search         | `webSearch: true`; web results are cited as `[W1]`...                                   |
| [400] Empty messages (`[]`)  | 400 `VALIDATION_ERROR`                                                                  |
| [404] Unknown conversationId | 404 `NOT_FOUND`                                                                         |

### Guardrails

Chat is scoped to the workspace's sources. It does **not** answer from general knowledge: when
the sources don't cover a question, the reply says so and suggests adding a source. Every message
passes through layered checks before the chat model sees it:

| Layer                 | What it does                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Input sanitization | NFKC normalization; strips zero-width, bidi-control and Unicode tag characters; max 4000 characters (400 `BAD_REQUEST` otherwise)                            |
| 2. Injection rules    | Regex heuristics (instruction override, prompt extraction, persona/jailbreak, chat-template and delimiter spoofing). Runs before any LLM call                |
| 3. Scope classifier   | Small model labels the message `in_scope`, `conversational`, `off_topic`, `prompt_injection` or `harmful`, using the workspace and source titles. Fails open |
| 4. Hardened prompt    | Fixed scope and confidentiality rules; the question is wrapped in `<user_question>` and all retrieved and stored text is escaped and treated as data         |
| 5. Leak filter        | A per-request canary sits in the system prompt; if it appears in the reply stream, the rest of the reply is cut off and replaced with a refusal              |

A blocked message still returns **200** with a normal UI message stream containing a short
refusal, so `useChat` needs no special handling. Both the message and the refusal are saved with
`blocked: true` (visible in `GET /conversations/:id/messages`) but excluded from model history,
conversation summaries and Mem0, so an attack can't carry over into later turns. Blocks are logged
at `warn` with `kind: "chat-guard"`, the layer, the category and a 120-character preview.

`npm run test:guard` runs the deterministic layers (1, 2, 4 and 5) against attack and benign cases.

---

## 06 · Conversations

`/api/workspaces/:workspaceId/conversations` · auth required.

### Conversation object

```json
{
    "id": "cm2conv...",
    "workspaceId": "cm2abc...",
    "title": "What does the Calvin cycle produce?",
    "summary": null,
    "summaryMessageCount": 0,
    "summarizedAt": null,
    "createdAt": "2026-10-20T10:01:00.000Z",
    "updatedAt": "2026-10-20T10:01:04.000Z"
}
```

`summary` is filled in by a background job once a conversation has 8+ messages.

| Request                                    | Endpoint                        | Body                                        | Success                                   |
| ------------------------------------------ | ------------------------------- | ------------------------------------------- | ----------------------------------------- |
| List conversations                         | `GET /`                         | –                                           | **200** array, most recently active first |
| Create empty conversation                  | `POST /`                        | `{ "title": "Exam prep" }` (optional, ≤120) | **201** conversation                      |
| Get messages                               | `GET /:conversationId/messages` | –                                           | **200** array, oldest first               |
| Rename conversation                        | `PATCH /:conversationId`        | `{ "title": "Exam prep v2" }` (1-120)       | **200** updated conversation              |
| Delete conversation                        | `DELETE /:conversationId`       | –                                           | **204** (messages deleted too)            |
| [404] Messages of nonexistent conversation | `GET /does-not-exist/messages`  | –                                           | 404                                       |

### Message object

```json
{
    "id": "cm2msg...",
    "conversationId": "cm2conv...",
    "role": "ASSISTANT",
    "content": "The Calvin cycle produces glucose [1].",
    "citations": [
        {
            "marker": 1,
            "sourceId": "cm2src...",
            "sourceTitle": "Photosynthesis",
            "sourceType": "TEXT",
            "chunkId": "cm2chk...",
            "chunkIndex": 1,
            "chunkTotal": 3,
            "excerpt": "The Calvin cycle takes place in the stroma...",
            "score": 0.81
        }
    ],
    "createdAt": "2026-10-20T10:01:04.000Z"
}
```

User messages have `"role": "USER"` and `"citations": null`. Web citations look like
`{ "marker": 1, "sourceType": "WEB", "sourceTitle": "...", "url": "...", "excerpt": "..." }`
and match `[W1]` in the text.

Where the source has them, source citations also carry: `page` (PDFs), `chapter` (PDFs with a
bookmark outline: the top-level bookmark the page falls under), `section` (WEBSITE and MARKDOWN
sources: the nearest heading above the chunk) and `chunkTotal` (chunks in the source, for "chunk 12
of 48"; `chunkIndex` is 0-based). A citation is exactly one chunk, which never spans pages, so there is
no `pageEnd`. Sources indexed before these fields existed lack `chunkTotal`, `chapter` and `section`
until they are reprocessed.

---

## 07 · Memory

`/api/memory` · auth required · needs `MEM0_API_KEY` for writes.

Long-term facts about the **user**, shared by all their workspaces. Relevant memories are added
to the chat prompt automatically. Memories are also **learned** from chats in the background.

### Memory object

```json
{
    "id": "6f1c2b9e-...",
    "memory": "Prefers short answers with real-world examples.",
    "createdAt": "2026-10-20T10:02:00.000Z",
    "updatedAt": "2026-10-20T10:02:00.000Z",
    "metadata": { "source": "manual" },
    "categories": ["preferences"],
    "source": "manual"
}
```

`source` is `manual` (created through this API) or `learned` (extracted from chats).

| Request                         | Endpoint                           | Body                                 | Success                                                  |
| ------------------------------- | ---------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| Create memory                   | `POST /api/memory`                 | `{ "memory": "..." }` (1–2000 chars) | **201** memory                                           |
| List memories                   | `GET /api/memory`                  | –                                    | **200** array (up to 100; `[]` if Mem0 isn't configured) |
| Update memory                   | `PATCH /api/memory/:memoryId`      | `{ "memory": "..." }`                | **200** memory                                           |
| Delete memory                   | `DELETE /api/memory/:memoryId`     | –                                    | **204**                                                  |
| [400] Empty memory              | `POST /api/memory` with `""`       | –                                    | 400 `VALIDATION_ERROR`                                   |
| [404] Update nonexistent memory | `PATCH /api/memory/does-not-exist` | –                                    | 404 (malformed ids count as not found)                   |

Mem0 may take a moment before a new memory shows up in the list.

---

## 08 · Artifacts

`/api/workspaces/:workspaceId/artifacts` · auth required · create: 20/min per user.

AI-generated study material from the workspace's READY sources. Creating returns a `PENDING`
artifact; a background job generates it. **Poll `GET /:artifactId` until `READY`** (or `FAILED`
with `metadata.processingError`).

### Create: `POST /`

```json
{ "type": "QUIZ", "title": "Photosynthesis quiz", "sourceIds": ["cm2src..."] }
```

```json
{ "type": "FLASHCARDS", "conversationId": "cm2conv...", "messageIds": ["cm2msg..."] }
```

| Field            | Required | Notes                                                                                        |
| ---------------- | -------- | -------------------------------------------------------------------------------------------- |
| `type`           | yes      | `SUMMARY`, `TAKEAWAYS`, `FLASHCARDS`, `QUIZ`, `MINDMAP`, `REPORT`, `WIKI`                    |
| `title`          | no       | ≤ 120; default like `Quiz · 10/20/2026`                                                      |
| `sourceIds`      | no       | Limit to these sources; default: all READY sources                                           |
| `conversationId` | no       | Build it from this conversation instead of the sources. Not with `sourceIds`; not for `WIKI` |
| `messageIds`     | no       | Only these messages of the conversation (needs `conversationId`); default: all of them       |

**400** `BAD_REQUEST` when there are no READY sources (or none of `sourceIds` are READY), or the
conversation has no messages. **404** for a conversation that is not in this workspace.

From a conversation the artifact's `sourceIds` are the sources its replies cited, and
`metadata.conversationId` records where it came from. Items get empty `citations` arrays, since a
transcript has no numbered sources.

The default title (`Mind Map · 10/20/2026`) is replaced, once generation finishes, by a short title the
model writes from the content. A title you sent, or later set with `PATCH`, is never changed.

### Edit: `PATCH /:artifactId`

```json
{
    "title": "Photosynthesis quiz",
    "content": { "questions": ["..."] },
    "expectedUpdatedAt": "2026-10-20T10:02:00.000Z"
}
```

At least one of `title` (1-200) or `content` (an object); unknown keys, including `type`, are rejected.
Only `READY` artifacts can be edited (**409** otherwise). Returns the artifact as `GET /:artifactId` does.

`content` must match the stored shape of the artifact's own type (the same shapes generation produces).
On failure: **400** `VALIDATION_ERROR` with field-level `details`, keyed by dotted path, e.g.
`{ "content.questions.0.correctIndex": ["correctIndex must point at one of the options"] }`.

| Type         | Stored `content`                                                                             | Extra rules                                          |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `SUMMARY`    | `{ markdown, citations[] }`                                                                  |                                                      |
| `TAKEAWAYS`  | `{ items: string[3-20] }`                                                                    |                                                      |
| `FLASHCARDS` | `{ cards: [{ front, back, citations[] }] }` (3-30)                                           |                                                      |
| `QUIZ`       | `{ questions: [{ question, options[2-5], correctIndex, explanation, citations[] }] }` (3-15) | `correctIndex` < `options.length`                    |
| `MINDMAP`    | `{ nodes: [{ id, label }] (2-40), edges: [{ id, source, target }] }`                         | unique node ids; every edge ends on an existing node |
| `REPORT`     | `{ markdown, sections: [{ title, content, citations[] }] }`                                  |                                                      |
| `WIKI`       | `{ overview, techStack[], architecture, diagram, modules[], gettingStarted }`                |                                                      |

A citation is `{ marker: int, sourceId, label }`. Citations are stored as sent, so an edited item keeps
its citations; `citations` may be omitted on a new item. Editing `content` sets
`metadata.userEdited: true` and `metadata.editedAt`; renaming alone does not. **409 `CONFLICT`** when
`expectedUpdatedAt` is stale.

### Regenerate: `POST /:artifactId/regenerate`

Body `{ "force"?: boolean }`. Re-runs generation **in place**: same id and title, using the sources it was
built from (or the READY sources if none were recorded), or its conversation. Rate limited like creation.
Returns **202** with the artifact (`PENDING`); poll `GET /:artifactId`. The old content stays visible until
the new content replaces it, and `metadata.userEdited` is cleared on success.

- **409 `ARTIFACT_EDITED`** when the artifact was edited and `force` is not `true`: ask the user, then
  retry with `{ "force": true }`.
- **409 `CONFLICT`** while it is `PENDING` or `PROCESSING`.
- **400** when no READY sources are left to build it from.

### List: `GET /?q=&type=&status=&limit=&cursor=`

`q` is a case-insensitive match on the title. With no parameters the response is unchanged. Always
`{ data: [...], meta: { total, nextCursor } }`.

### Bulk delete: `POST /bulk-delete`

```json
{ "artifactIds": ["cm2art...", "cm2art2..."] }
```

1-100 ids. Per-id and not atomic, like the sources endpoint. **200**
`{ "deleted": 2, "results": [{ "artifactId", "status": "deleted" | "not_found" | "failed" }] }`.
Ids are de-duplicated; ids from other workspaces are `not_found`.

### Seen / unseen: `POST /:artifactId/viewed`

Records the first time the user opened an artifact (**204**, safe to repeat). `viewedAt` on the
artifact is `null` until then, and `GET .../summary` counts `READY` artifacts with a `null`
`viewedAt` as `unseenArtifactCount`. Reading an artifact with `GET` does **not** mark it viewed
(polling for `READY` would otherwise clear it), so call this when the user actually opens it.

### Artifact object (READY)

```json
{
    "id": "cm2art...",
    "workspaceId": "cm2abc...",
    "type": "FLASHCARDS",
    "title": "Flashcards · 10/20/2026",
    "content": {
        "cards": [{ "front": "Where does the Calvin cycle happen?", "back": "In the stroma." }]
    },
    "sourceIds": ["cm2src..."],
    "status": "READY",
    "metadata": { "generatedAt": "2026-10-20T10:03:10.000Z" },
    "viewedAt": null,
    "createdAt": "2026-10-20T10:03:00.000Z",
    "updatedAt": "2026-10-20T10:03:10.000Z"
}
```

**Citations.** For `SUMMARY`, `FLASHCARDS`, `QUIZ` and `REPORT`, each card, question and report
section has a `citations` array saying which sources it is based on; a summary has one `citations`
array for the whole text, in the order its `[n]` markers first appear:

```json
{ "marker": 1, "sourceId": "cm2src...", "label": "Make It Stick" }
```

`marker` is the source's number, the `[1]` in summary text; `label` is the source's title. These
come from the model, which can be wrong or leave an item uncited (an empty array). Numbers that
match no source are dropped. There is no page number: the text the model reads has no page
boundaries.

`content` by type:

| Type         | `content`                                                                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUMMARY`    | `{ "markdown": "... [1] ...", "citations": [Citation] }`                                                                                                                                                                  |
| `TAKEAWAYS`  | `{ "items": ["...", "..."] }`                                                                                                                                                                                             |
| `FLASHCARDS` | `{ "cards": [{ "front", "back", "citations": [Citation] }] }`                                                                                                                                                             |
| `QUIZ`       | `{ "questions": [{ "question", "options": [...], "correctIndex", "explanation", "citations": [Citation] }] }` (`correctIndex` is 0-based)                                                                                 |
| `MINDMAP`    | `{ "nodes": [{ "id", "label" }], "edges": [{ "id", "source", "target" }] }`                                                                                                                                               |
| `REPORT`     | `{ "markdown": "...", "sections": [{ "title", "content", "citations": [Citation] }] }`                                                                                                                                    |
| `WIKI`       | `{ "overview", "techStack": [{ "name", "purpose" }], "architecture", "diagram", "modules": [{ "name", "path", "description", "keyFiles" }], "gettingStarted" }` (`diagram` is raw Mermaid; needs a READY `GITHUB` source) |

| Request                                                    | Endpoint                                     | Success                                  |
| ---------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| Create SUMMARY / TAKEAWAYS / FLASHCARDS / MINDMAP / REPORT | `POST /` with `{ "type": "..." }`            | **201** (`PENDING`)                      |
| Create QUIZ (custom title, selected sources)               | `POST /` with `type`, `title`, `sourceIds`   | **201**                                  |
| Wait until artifact is READY                               | `GET /:artifactId` (polls in the Runner)     | **200**                                  |
| Get artifact                                               | `GET /:artifactId`                           | **200**                                  |
| List artifacts                                             | `GET /` (`?q=&type=&status=&limit=&cursor=`) | **200** array, newest first, plus `meta` |
| Rename / edit artifact                                     | `PATCH /:artifactId`                         | **200** artifact                         |
| Regenerate artifact                                        | `POST /:artifactId/regenerate`               | **202** (`PENDING`)                      |
| Bulk delete artifacts                                      | `POST /bulk-delete`                          | **200** `{ deleted, results }`           |
| Mark artifact opened                                       | `POST /:artifactId/viewed`                   | **204**                                  |
| Delete artifact                                            | `DELETE /:artifactId`                        | **204**                                  |
| [400] Unknown type (`"POEM"`)                              | `POST /`                                     | 400 `VALIDATION_ERROR`                   |
| [404] Get nonexistent artifact                             | `GET /does-not-exist`                        | 404                                      |
| [400] Edit with invalid content / empty body               | `PATCH /:artifactId`                         | 400 `VALIDATION_ERROR`                   |
| [409] Edit with a stale `expectedUpdatedAt`                | `PATCH /:artifactId`                         | 409 `CONFLICT`                           |
| [409] Regenerate an edited artifact without `force`        | `POST /:artifactId/regenerate`               | 409 `ARTIFACT_EDITED`                    |

---

## 09 · Cross-user isolation

Checks that one user can't see or change another user's data. User B signs up and tries to
reach user A's resources; every attempt must return **404** (not 403, so ids can't be probed).

| Request                  | Expect |
| ------------------------ | ------ |
| Sign up user B           | 200    |
| B: get A's workspace     | 404    |
| B: get A's source        | 404    |
| B: chat in A's workspace | 404    |
| B: delete A's memory     | 404    |
| Sign back in as A        | 200    |

---

## 10 · Cleanup

Deletes everything the run created, then signs out.

| Request                                          | Expect |
| ------------------------------------------------ | ------ |
| Delete artifact / memory / conversation / source | 204    |
| Bulk delete artifacts                            | 200    |
| Bulk delete sources                              | 200    |
| Delete workspace                                 | 204    |
| [404] Get deleted workspace                      | 404    |
| Sign out                                         | 200    |
| [401] Current user after sign-out                | 401    |

## 11 · Signed out (401)

With no session, protected routes return **401 `UNAUTHORIZED`**:
`GET /api/workspaces`, `GET …/sources`, `POST …/chat`, `GET /api/memory`, `POST …/artifacts`.

---

## Endpoint index

| Method | Path                                                                  | Auth   | Success      | Notes                             |
| ------ | --------------------------------------------------------------------- | ------ | ------------ | --------------------------------- |
| GET    | `/`                                                                   | –      | 200          | Hello message                     |
| GET    | `/health`                                                             | –      | 200          | Liveness                          |
| GET    | `/health/ready`                                                       | –      | 200 / 503    | Readiness                         |
| *      | `/api/auth/*`                                                         | –      | –            | Better Auth                       |
| GET    | `/api/me`                                                             | ✓      | 200          | Current user                      |
| GET    | `/api/workspaces`                                                     | ✓      | 200          | `?q&sort&order`                   |
| POST   | `/api/workspaces`                                                     | ✓      | 201          |                                   |
| GET    | `/api/workspaces/:workspaceId`                                        | ✓      | 200          |                                   |
| GET    | `/api/workspaces/:workspaceId/summary`                                | ✓      | 200          | Sidebar counts                    |
| PATCH  | `/api/workspaces/:workspaceId`                                        | ✓      | 200          |                                   |
| DELETE | `/api/workspaces/:workspaceId`                                        | ✓      | 204          |                                   |
| GET    | `/api/workspaces/:workspaceId/sources`                                | ✓      | 200          | `?q&type&status&limit&cursor`     |
| POST   | `/api/workspaces/:workspaceId/sources`                                | ✓      | 201          | TEXT / MARKDOWN · ingestion limit |
| POST   | `/api/workspaces/:workspaceId/sources/upload`                         | ✓      | 201          | multipart PDF · ingestion limit   |
| POST   | `/api/workspaces/:workspaceId/sources/import/website`                 | ✓      | 201          | ingestion limit                   |
| POST   | `/api/workspaces/:workspaceId/sources/import/youtube`                 | ✓      | 201          | ingestion limit                   |
| POST   | `/api/workspaces/:workspaceId/sources/import/github`                  | ✓      | 201          | ingestion limit                   |
| POST   | `/api/workspaces/:workspaceId/sources/import/web-search`              | ✓      | 201          | ingestion limit                   |
| POST   | `/api/workspaces/:workspaceId/sources/bulk-delete`                    | ✓      | 200          | Per-id results                    |
| POST   | `/api/workspaces/:workspaceId/sources/reprocess`                      | ✓      | 200          | FAILED, or the given ids · limit  |
| GET    | `/api/workspaces/:workspaceId/sources/:sourceId`                      | ✓      | 200          |                                   |
| PATCH  | `/api/workspaces/:workspaceId/sources/:sourceId`                      | ✓      | 200          | Title / text content · limit      |
| DELETE | `/api/workspaces/:workspaceId/sources/:sourceId`                      | ✓      | 204          |                                   |
| GET    | `/api/workspaces/:workspaceId/sources/:sourceId/chunks`               | ✓      | 200          |                                   |
| PATCH  | `/api/workspaces/:workspaceId/sources/:sourceId/chunks/:chunkId`      | ✓      | 200          | Exclude / include a chunk         |
| GET    | `/api/workspaces/:workspaceId/sources/:sourceId/files`                | ✓      | 200          | GITHUB only                       |
| POST   | `/api/workspaces/:workspaceId/sources/:sourceId/sync`                 | ✓      | 202          | GITHUB only · ingestion limit     |
| POST   | `/api/workspaces/:workspaceId/sources/:sourceId/reprocess`            | ✓      | 202          | ingestion limit                   |
| POST   | `/api/workspaces/:workspaceId/chat`                                   | ✓      | 200 (stream) | AI limit                          |
| GET    | `/api/workspaces/:workspaceId/conversations`                          | ✓      | 200          |                                   |
| POST   | `/api/workspaces/:workspaceId/conversations`                          | ✓      | 201          |                                   |
| GET    | `/api/workspaces/:workspaceId/conversations/:conversationId/messages` | ✓      | 200          |                                   |
| PATCH  | `/api/workspaces/:workspaceId/conversations/:conversationId`          | ✓      | 200          | Rename                            |
| DELETE | `/api/workspaces/:workspaceId/conversations/:conversationId`          | ✓      | 204          |                                   |
| GET    | `/api/workspaces/:workspaceId/artifacts`                              | ✓      | 200          | `?q&type&status&limit&cursor`     |
| POST   | `/api/workspaces/:workspaceId/artifacts`                              | ✓      | 201          | AI limit                          |
| POST   | `/api/workspaces/:workspaceId/artifacts/bulk-delete`                  | ✓      | 200          | Per-id results                    |
| GET    | `/api/workspaces/:workspaceId/artifacts/:artifactId`                  | ✓      | 200          |                                   |
| PATCH  | `/api/workspaces/:workspaceId/artifacts/:artifactId`                  | ✓      | 200          | READY only · `expectedUpdatedAt`  |
| POST   | `/api/workspaces/:workspaceId/artifacts/:artifactId/regenerate`       | ✓      | 202          | AI limit · `ARTIFACT_EDITED`      |
| POST   | `/api/workspaces/:workspaceId/artifacts/:artifactId/viewed`           | ✓      | 204          | Clears the unseen state           |
| DELETE | `/api/workspaces/:workspaceId/artifacts/:artifactId`                  | ✓      | 204          |                                   |
| GET    | `/api/memory`                                                         | ✓      | 200          |                                   |
| POST   | `/api/memory`                                                         | ✓      | 201          |                                   |
| PATCH  | `/api/memory/:memoryId`                                               | ✓      | 200          |                                   |
| DELETE | `/api/memory/:memoryId`                                               | ✓      | 204          |                                   |
| POST   | `/api/inngest`                                                        | signed | –            | Inngest only, not for clients     |
