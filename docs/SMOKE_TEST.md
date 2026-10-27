# Smoke test

`scripts/smoke-test.ts` checks the whole API end to end against a running server. It talks
to the server over HTTP like a real client: cookie sessions, the `{ success, data }`
envelope, the streamed chat response. It creates its own users and data, runs every
feature, and cleans up after itself.

Use it after a refactor, a dependency upgrade, or before a deploy to confirm nothing broke.

## Running it

```bash
npm run dev                     # terminal 1: Postgres, API, Inngest, Prisma Studio
npm run smoke                   # terminal 2
```

| Command                       | What runs                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run smoke`               | Core + AI flows: indexing, chat, memory, artifacts (~1–2 min)                                       |
| `npm run smoke -- --no-ai`    | Skips everything that calls OpenAI (fast, free). Indexing, chat and artifact generation are skipped |
| `npm run smoke -- --external` | Also PDF upload, website, YouTube, GitHub repo and web search                                       |
| `npm run smoke -- --keep`     | Leaves the test workspaces in place so you can inspect them                                         |

Flags can be combined, e.g. `npm run smoke -- --external --keep`.

| Env var          | Default                 | Notes                                |
| ---------------- | ----------------------- | ------------------------------------ |
| `SMOKE_BASE_URL` | `http://localhost:8080` | Server to test                       |
| `SMOKE_ORIGIN`   | `http://localhost:3000` | Must match the server's `CLIENT_URL` |

The exit code is `0` when everything passes and `1` on any failure, so it can gate CI.

## What it covers

Each check is marked **PASS**, **FAIL** or **SKIP**. Optional integrations that aren't
configured (the server answers 503) are reported as SKIP, not FAIL.

### System

- `GET /health` returns `{ status: "ok" }`
- `GET /health/ready` returns 200: database, Pinecone, OpenAI and Inngest are up. On failure it
  lists which dependency is down and why.
- Unknown routes return a 404 in the standard error envelope
- Every response carries an `X-Request-Id` header

### Auth (Better Auth, email/password)

- `GET /api/me` without a session is 401
- Sign up and sign in user A; a wrong password is rejected
- `GET /api/me` returns the signed-in user
- A second user (B) is created for the isolation checks below

### Workspaces

- Create, list, get and update a workspace
- Validation: a blank title and an empty update body return 400 (`VALIDATION_ERROR`)
- **Isolation:** user B gets 404 for user A's workspace

### Sources

- Create TEXT and MARKDOWN sources (they start as `PENDING`)
- A PDF type sent as JSON is rejected
- The list omits `content`; the `?type=` filter works; get-one includes `content`
- **Isolation:** user B gets 404 for user A's source
- _AI:_ the background job (Inngest) indexes both sources to `READY`
- _AI:_ chunks exist and have real token counts
- _AI:_ reprocessing one source returns 202 and it goes back to `READY`
- _AI:_ reprocessing failed sources is a no-op when none have failed

### Chat (RAG), _AI only_

- The first message streams a reply and returns `X-Conversation-Id`
- A follow-up in the same conversation works (history is loaded server-side)
- Saved messages carry citations, each with a numeric `marker`
- The conversation is listed with an auto-generated title
- Empty `messages` is 400
- **Isolation:** user B gets 404 chatting in user A's workspace

### Conversations

- Create an empty conversation and delete it (204)

### Memory (Mem0)

- Create, list, update and delete a memory
- **Isolation:** user B cannot delete user A's memory (404)
- An empty memory is 400
- Skipped if Mem0 isn't configured

### Artifacts

- An unknown type is 400
- A workspace without READY sources is 400
- _AI:_ generate a **SUMMARY** (markdown) and a **QUIZ** (structured output, `correctIndex`
  in range) through the background job to `READY`
- A **WIKI** artifact in a workspace with no GitHub source is 400
- _AI:_ list artifacts; delete one (204), after which it is 404

### External integrations, `--external` only

- **PDF upload:** a generated one-page PDF is uploaded to Cloudinary and indexed, and
  every chunk has `metadata.page`
- Non-PDF bytes named `.pdf` are rejected by the content validator
- **Website import** (Firecrawl, `https://example.com`) indexes to `READY`
- **YouTube import** (a captioned video) indexes to `READY`
- A bad YouTube URL is 400
- **GitHub repo import** (`octocat/Spoon-Knife`, public) becomes a `GITHUB` source, indexes to
  `READY`, and every chunk has `metadata.path`
- The repo's **file list** shows files with chunk counts and a commit sha
- Importing the same repo again is 409; a bad repo string is 400
- **Sync** with no new commits returns `changed: false`; syncing a non-GitHub source is 400
- _AI:_ chat about the repo returns a citation with a file `path`
- _AI:_ a **WIKI** artifact for the repo reaches `READY` with an overview, modules and a diagram
- A web-search result can be imported as a source
- _AI:_ chat with `webSearch: true` (Tavily) streams a reply

### Cleanup

- Bulk delete sources (204; deleted sources are 404)
- Delete the test workspaces, which also removes their Pinecone vectors (204, then 404)
- Sign out; `GET /api/me` is 401 again

## Not covered

- **Conversation summaries.** The summary job only triggers after 8 messages.
- **Mem0 learning from chat.** This is part of the summary job.
- **TAKEAWAYS, FLASHCARDS, MINDMAP and REPORT** artifacts, and **syncing a repo that did change** (it would need a repo you can push to). Only SUMMARY and QUIZ run, to keep cost and time down.
- **Google OAuth.**
- **Rate limits.**
- **Langfuse traces.** These are sent if Langfuse is configured, but not asserted.
- **Production auth.** Email/password sign-up is disabled when `NODE_ENV=production`, so run the smoke test against a non-production server.

## Side effects and cost

- **Test users:** two users (`smoke-a-<timestamp>@test.local`, `smoke-b-…`) are left in
  the database. There is no delete-user endpoint. All their workspaces, sources and
  memories are deleted.
- **OpenAI:** a few small calls per run (embeddings, 2 chat replies, a query rewrite, 2
  artifacts). These are tiny with `gpt-4o-mini`.
- **`--external`:** uses one Firecrawl credit, uploads a small PDF to Cloudinary, makes a
  Tavily search, and reads a tiny public GitHub repo (a few API calls; anonymous GitHub allows
  60 per hour, so set `GITHUB_TOKEN` if you run it often). A GitHub rate limit shows as SKIP.

## Troubleshooting

| Symptom                                          | Likely cause                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `Server not reachable`                           | API isn't running. Start it with `npm run dev`.                                            |
| `timed out … is the Inngest dev server running?` | Inngest dev server isn't running or can't reach the API. It must point at the API's `PORT` |
| Sign-up returns 403                              | `SMOKE_ORIGIN` doesn't match the server's `CLIENT_URL`                                     |
| Memory or PDF steps SKIP                         | Mem0 / Cloudinary keys aren't set in `.env`                                                |
| A source ends `FAILED`                           | See the `processingError` in the failure message and the API log                           |
