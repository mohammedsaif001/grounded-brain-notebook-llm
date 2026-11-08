# UI handover: backend changes for UI Revamp 2.0

All 10 items in `grounded-brain-ui/docs/backend-requirements.md` are implemented and tested. This
file is the contract: what each endpoint returns now, how to use it, and where the data is
limited. Full reference: [API.md](API.md). Everything below was verified against a running
server (smoke test: 58 checks, including real AI generation).

Base URL in dev: `http://localhost:8080`. Auth is the existing Better Auth cookie session; every
call below needs it and is scoped to the signed-in user (other users' data is 404).

## 0. Read this first: what changed for existing code

| Change                                                                                                                       | Impact on the UI                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST .../sources/bulk-delete` now returns **200** with a body, not **204**                                                  | Code that checks `status === 204` breaks. Read `data.results` instead.                        |
| `POST .../sources/reprocess` with `sourceIds` now re-queues **exactly those ids, any status** (it used to ignore non-FAILED) | The library bulk bar can reprocess a READY selection. Response is `{ reprocessed, results }`. |
| Paginated lists add a top-level **`meta`** next to `data`                                                                    | `data` is still a plain array, so old code keeps working.                                     |
| Workspaces now include `sourceCount` and `artifactCount`                                                                     | Additive.                                                                                     |
| SUMMARY / FLASHCARDS / QUIZ / REPORT `content` gains `citations`                                                             | Additive. Old artifacts simply lack it (see section 9).                                       |

Envelope (unchanged): `{ "success": true, "data": ..., "message"?, "meta"? }` or
`{ "success": false, "error": { "code", "message", "details"? } }`.

## 1. Notebook counts and search/sort (items 1, 10)

`GET /api/workspaces?q=&sort=&order=`

- `q`: case-insensitive match on title **or** description (max 120 chars).
- `sort`: `updatedAt` (default) | `createdAt` | `title`. Anything else is 400.
- `order`: `asc` | `desc`. Default: `desc` for dates, `asc` for `title`.

```json
{
    "id": "...",
    "title": "Learning how to learn",
    "description": null,
    "icon": "brain",
    "defaultModel": "gpt-4o-mini",
    "sourceCount": 8,
    "artifactCount": 6,
    "createdAt": "...",
    "updatedAt": "..."
}
```

- `sourceCount` = every source regardless of status. `artifactCount` = every artifact, any status
  (including PENDING/FAILED), so "6 study guides" can include one still generating. If the card
  should only show finished ones, use `GET .../summary` or filter `GET .../artifacts?status=READY`.
- Counts are also on `GET /api/workspaces/:id`, `POST` and `PATCH` responses.
- `updatedAt` only changes when the workspace row itself is edited, **not** when sources or
  artifacts are added. A "Last updated" sort therefore means "last edited", not "last activity".
  Tell me if you want it to follow activity; it is a small backend change.

## 2. Icon contract (item 7)

No change was needed: `icon` already accepts any trimmed string up to **8 characters** (not
restricted to emoji). All the keys you listed fit (`compass`, `library` are 7). 9+ characters is 400. The server stores it verbatim and never validates against a list, so unknown keys must fall
back to a default icon in the UI.

## 3. Workspace summary (item 5)

`GET /api/workspaces/:workspaceId/summary`

```json
{ "sourceCount": 8, "readySourceCount": 7, "processingArtifactCount": 1, "unseenArtifactCount": 2 }
```

- `processingArtifactCount`: artifacts `PENDING` or `PROCESSING`.
- `unseenArtifactCount`: artifacts that are `READY` and have `viewedAt === null`.
- It is four `COUNT` queries; fine to poll (e.g. every 5-10 s while something is processing).

### Clearing the "new" dot: `POST /api/workspaces/:id/artifacts/:artifactId/viewed` (204)

- Call it **when the user actually opens the artifact**. It is idempotent.
- `GET /artifacts/:id` does **not** mark it viewed on purpose, because the UI polls that endpoint
  for READY and the dot would clear itself.
- `viewedAt` (ISO string or `null`) is on every artifact object, so the list can render a "New" badge.
- Artifacts that were already READY before this release were backfilled as seen.

## 4. Pagination (item 8)

Applies to `GET .../sources` and `GET .../artifacts`.

- `?limit=` 1-100 turns paging on (0 or 101 is 400). `?cursor=` is the previous `meta.nextCursor`.
- **Without `limit` you get everything**, same as before.
- Always returns `meta: { "total": <rows matching the filters, all pages>, "nextCursor": "<id>" | null }`.
- Order is stable (newest first, ties broken by id). Stop when `nextCursor` is `null`.
- Filters combine with paging and `total` respects them: sources `q`, `type`, `status`;
  artifacts `type`, `status` (new). An invalid enum value is 400.
- Cursors are row ids. If the row a cursor points at is deleted between pages, that page comes
  back empty; restart from the first page.
- `total` is fine for "8 sources" counters and "Showing 25 of 140".

## 5. Bulk endpoints (item 9, verified and changed)

Neither is atomic; one bad id never stops or undoes the others.

`POST .../sources/bulk-delete` `{ "sourceIds": ["..."] }` (at least 1) returns **200**:

```json
{
    "deleted": 2,
    "results": [
        { "sourceId": "a", "status": "deleted" },
        { "sourceId": "zzz", "status": "not_found" }
    ]
}
```

`status` is `deleted` | `not_found` | `failed`. Duplicate ids are collapsed. Ids from another
workspace are `not_found`.

`POST .../sources/reprocess`:

- Body `{}`: re-queues every FAILED source (the "Retry failed" button).
- Body `{ "sourceIds": [...] }`: re-queues exactly those, any status. Returns

```json
{
    "reprocessed": 1,
    "results": [
        { "sourceId": "a", "status": "queued" },
        { "sourceId": "b", "status": "skipped", "reason": "Already being processed" },
        { "sourceId": "c", "status": "not_found" }
    ]
}
```

- `status`: `queued` | `skipped` | `not_found` | `failed`. Skipped = still `PENDING`/`PROCESSING`;
  surface it as "already running", not as an error.
- Reprocessing runs in the background; the source goes `PENDING` -> `PROCESSING` -> `READY`.
  Poll the list/get. Rate limit: 30 ingestion requests / 10 min / user (429 beyond that).
- Reprocessing a READY source clears its old index first, so it briefly has no vectors and chat
  cannot cite it until it is READY again.

## 6. Normalised source metadata (item 6)

Read from `source.metadata` (present on list responses; `content` is not). Keys that do not apply
are **absent**, never null, so always null-check.

| Key               | Meaning                                                                           | Present for                                                                                           |
| ----------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `author`          | PDF author, YouTube channel, site name, or repo owner                             | PDF (only if the file's properties name one), YOUTUBE, WEBSITE (only if the page says), GITHUB        |
| `pageCount`       | pages                                                                             | PDF                                                                                                   |
| `wordCount`       | words in the text                                                                 | all types. Known immediately for text/markdown/website/YouTube/GitHub; **PDFs only after processing** |
| `durationSeconds` | video length (seconds)                                                            | YOUTUBE                                                                                               |
| `fileCount`       | files read                                                                        | GITHUB                                                                                                |
| `repo`, `owner`   | repo name and its owner. **`repo` is the name only**; build `owner/repo` yourself | GITHUB                                                                                                |

Plus the existing keys (`chunkCount`, `indexedAt`, `processingError`, `importedFrom`, ...).

Row text suggestions: PDF `"{author} · {pageCount} pages"`, YouTube `"{author} · {mm:ss}"`,
GitHub `"{fileCount} files"`, others `"{wordCount} words"`; fall back to host / "Added X ago".

Caveats:

- `durationSeconds` is derived from the last caption's end time, so it can be a little short for
  videos with a silent outro, and is absent if the video has no timed captions.
- YouTube `author` and the default title come from YouTube's public oEmbed endpoint, best effort
  with a 4 s timeout. If it fails the title is `YouTube: <videoId>` and `author` is missing.
- Sources created **before** this release: `wordCount` and PDF `author` appear only after a
  reprocess. They have no `durationSeconds`/`fileCount`/`author` (YouTube/GitHub) until
  re-imported. GitHub sources get `fileCount` only on re-import or sync.
- WEBSITE `author` is best effort (page `author`, then site name). Often missing.

## 7. Richer chat citations (item 2)

`GET .../conversations/:id/messages` -> `message.citations[]` for source citations now includes:

| Field                                                                            | Meaning                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `chunkIndex`                                                                     | 0-based position of the chunk. Show `chunkIndex + 1`.                              |
| `chunkTotal`                                                                     | chunks in the source -> "Chunk 12 of 48"                                           |
| `page`                                                                           | PDFs                                                                               |
| `chapter`                                                                        | PDFs **that have a bookmark outline**: the top-level bookmark the page falls under |
| `section`                                                                        | WEBSITE and MARKDOWN sources: nearest markdown heading above the chunk             |
| `path`                                                                           | GITHUB sources (existing)                                                          |
| `excerpt`, `score`, `marker`, `sourceId`, `sourceTitle`, `sourceType`, `chunkId` | existing                                                                           |

Web citations (`sourceType: "WEB"`) are unchanged and have none of the new fields.

**Limitations**

- **There is no `pageEnd`.** A citation is exactly one chunk and a chunk never spans pages, so a
  range ("pp. 28-31") cannot be produced. Render `p. {page}` only. If you really need ranges,
  that is a chunking redesign, not a small field.
- `chapter` is absent for PDFs without bookmarks (many scanned or exported PDFs). `section` is
  absent for plain TEXT sources and for content before the first heading. Every new field is
  optional: render each only when present.
- `chunkTotal`, `chapter`, `section` exist only on chunks indexed **after** this release. Old
  sources need a reprocess; until then those citations lack them (`chunkIndex` still works).
- Chapter detection uses only the PDF's top-level bookmarks. Sub-chapters are ignored.

## 8. Per-item citations in generated artifacts (item 3)

For `SUMMARY`, `FLASHCARDS`, `QUIZ`, `REPORT`. Citation shape:

```json
{ "marker": 1, "sourceId": "cm...", "label": "Make It Stick" }
```

`label` is the source title; `marker` is its number in the generation context.

| Type         | Where                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FLASHCARDS` | `content.cards[i].citations`                                                                                                               |
| `QUIZ`       | `content.questions[i].citations`                                                                                                           |
| `REPORT`     | `content.sections[i].citations` (the full `markdown` field has no markers)                                                                 |
| `SUMMARY`    | `content.markdown` contains inline `[1]`, `[2]` markers; `content.citations` lists the sources they point at, in order of first appearance |

For SUMMARY, map `[n]` in the markdown to the citation with `marker === n`. Render
`[1]` as a link/footnote and the "Source notes" list from `content.citations`.

**Limitations**

- **No page numbers** on artifact citations (`page?` in your spec is never set). The generation
  text has no page boundaries. Show `label` only.
- The model chooses the citations. Treat them as "based on", not proof. An item can have an
  empty `citations: []`; the UI must handle that (hide the "Source" chip).
- Numbers that match no source are dropped server-side, so every citation resolves to a real
  `sourceId` that was in the workspace at generation time. The source may have been deleted since.
- Large sources are condensed before generation, so a citation says which source, not where in it.
- MINDMAP, TAKEAWAYS and WIKI are unchanged (no citations).
- Artifacts generated before this release have no `citations` keys at all. Use
  `item.citations ?? []`.

## 9. Generate an artifact from a conversation (item 4)

`POST .../artifacts`

```json
{ "type": "FLASHCARDS", "conversationId": "cm...", "messageIds": ["cm..."], "title": "optional" }
```

- `conversationId` replaces "all ready sources". `messageIds` (optional, 1-200) limits to some of
  that conversation's messages; ids not in the conversation are 400.
- Validation (all `400` `VALIDATION_ERROR` unless noted): `messageIds` without `conversationId`;
  `conversationId` together with `sourceIds`; `type: "WIKI"` with a conversation. Unknown or
  foreign conversation is **404**. A conversation with no messages is **400**.
- Returns **201** with a `PENDING` artifact, then poll `GET .../artifacts/:id` until `READY` or
  `FAILED` exactly as before. Rate limit: 20 AI requests / min / user.
- `artifact.sourceIds` = the sources the chosen replies cited (may be empty).
  `artifact.metadata.conversationId` (and `messageIds` if a subset) records the origin.
- Items have `citations: []` because a transcript has no numbered sources. Do not show a source
  chip for conversation-based artifacts unless you build one from `artifact.sourceIds`.
- The chat's own `[1]` / `[W1]` markers are stripped from the transcript before generation. Long
  conversations are cut to the most recent messages that fit the context budget.
- Conversation is read when the background job runs, not at request time; messages added in
  between are included (unless `messageIds` was given).

## 10. Endpoint cheat sheet

| Method | Path                                                     | Notes                              |
| ------ | -------------------------------------------------------- | ---------------------------------- |
| GET    | `/api/workspaces?q&sort&order`                           | counts included                    |
| GET    | `/api/workspaces/:id`                                    | counts included                    |
| GET    | `/api/workspaces/:id/summary`                            | sidebar counts                     |
| GET    | `/api/workspaces/:id/sources?q&type&status&limit&cursor` | `meta` always                      |
| POST   | `/api/workspaces/:id/sources/bulk-delete`                | **200** + results                  |
| POST   | `/api/workspaces/:id/sources/reprocess`                  | `{}` or `{ sourceIds }`            |
| GET    | `/api/workspaces/:id/artifacts?type&status&limit&cursor` | `meta` always; `viewedAt` on items |
| POST   | `/api/workspaces/:id/artifacts`                          | `conversationId`, `messageIds` new |
| POST   | `/api/workspaces/:id/artifacts/:artifactId/viewed`       | 204, idempotent                    |

## 10b. Editing, regeneration and chunk control (new)

Every endpoint is under `/api/workspaces/:workspaceId`. Errors use the usual envelope
`{ success: false, error: { code, message, details? } }`. `updatedAt` is returned on every source and artifact.

| Endpoint                                         | Body                                                                                            | Success                                                                                        | Errors                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PATCH /sources/:sourceId`                       | `{ title?: 1-200, content?: non-empty, expectedUpdatedAt?: ISO }` (≥1 of title/content, strict) | **200** source (same shape as `GET /sources/:id`, with `content`)                              | 400 validation; 400 content on a non-text source; 404; 409 still processing; 409 `CONFLICT` |
| `PATCH /sources/:sourceId/chunks/:chunkId`       | `{ excluded: boolean }` (strict)                                                                | **200** chunk (`excluded` included)                                                            | 400; 404 source/chunk; 409 source processing                                                |
| `PATCH /artifacts/:artifactId`                   | `{ title?: 1-200, content?: object, expectedUpdatedAt?: ISO }` (≥1, strict)                     | **200** artifact                                                                               | 400 validation with field `details`; 404; 409 not `READY`; 409 `CONFLICT`                   |
| `POST /artifacts/:artifactId/regenerate`         | `{ force?: boolean }`                                                                           | **202** artifact (`PENDING`)                                                                   | 400 no ready sources; 404; 409 `ARTIFACT_EDITED`; 409 already generating                    |
| `GET /artifacts?q=&type=&status=&limit=&cursor=` | –                                                                                               | **200** `{ data, meta: { total, nextCursor } }`                                                | 400 validation                                                                              |
| `POST /artifacts/bulk-delete`                    | `{ artifactIds: string[1-100] }`                                                                | **200** `{ deleted, results: [{ artifactId, status: "deleted" \| "not_found" \| "failed" }] }` | 400; 404 workspace                                                                          |
| `PATCH /conversations/:conversationId`           | `{ title: 1-120 }` (strict)                                                                     | **200** conversation                                                                           | 400; 404                                                                                    |

How the UI should use them:

- **Source content edit replaces, never appends.** Old chunks and vectors are deleted and the text is
  re-indexed from scratch, so old and new versions cannot both be retrieved. The source returns as
  `PENDING`; poll `GET /sources/:id` until `READY` (chat uses the old text until the old vectors are
  removed, which happens immediately after the save, then has no text from this source until `READY`).
- **Title edit** is instant (no re-index) and fixes chat citation titles. Older messages keep the title
  they were saved with.
- **Concurrency:** send the `updatedAt` you last read as `expectedUpdatedAt`. On **409 `CONFLICT`**
  (`"This item was changed elsewhere. Reload and try again."`) reload the item and let the user retry.
- **Artifact edit:** send a full `content` object in the shape of the artifact's type (the same shape
  `GET` returns). Citations are stored as you send them; omit `citations` on a brand new item.
  Content edits set `metadata.userEdited` (and `editedAt`); a rename alone does not.
- **Regenerate:** if you get **409 `ARTIFACT_EDITED`**, show "Regenerating will discard your edits",
  then call again with `{ "force": true }`. The artifact keeps its id and title and shows `PENDING` →
  `READY`; its old content remains until the new one is ready.
- **Titles:** generated artifacts now get a short topic title instead of `Quiz · 11/8/2026`, once they
  reach `READY`. Titles you set are never overwritten.
- **Excluded chunks:** show an `excluded` toggle per chunk in the chunk viewer. Excluded chunks are
  skipped by chat and by artifact generation. Flags reset if the source is re-indexed.

## 11. Suggested UI wiring

- Dashboard: one `GET /api/workspaces` (with `q`/`sort` bound to the search box and sort menu,
  debounce `q`). No per-notebook requests needed.
- Sidebar: `GET .../summary` on notebook open, then poll while `processingArtifactCount > 0` or any
  source is not READY. Show the Learn dot when `unseenArtifactCount > 0`.
- Opening an artifact: render, then fire `POST .../viewed` and refresh the summary.
- Library: request `?limit=25`, "Load more" while `meta.nextCursor`. Keep selection by id across
  pages. After a bulk action refresh the current pages and read `results` for per-row errors.
- Make It Stick card: `POST .../artifacts` with the current `conversationId` (and the visible
  `messageIds` if you want a subset), then route to Learn.

## 12. Operational notes

- **Migrations required:** `20261107090000_add_artifact_viewed_at` (adds `learning_artifact.viewedAt`) and
  `20261108090000_add_chunk_excluded` (adds `source_chunk.excluded BOOLEAN NOT NULL DEFAULT false`).
  Run `npm run db:migrate:deploy`. Both are applied to the local dev DB. Existing Pinecone vectors need
  no backfill: the retrieval filter `excluded != true` also matches vectors without the field.
- Smoke test: `npm run smoke` (needs `npm run dev` running). It covers every behaviour above.
  It leaves two throwaway `smoke-*@test.local` users in the DB by design.
- Postman collection has the new requests; the bulk-delete test now expects 200.
- Not covered by automated tests: a live website scrape and a live GitHub import with the new
  metadata (the code paths are small and type-checked; `--external` smoke exercises them).

## 13. Not done / decisions that need you

- `pageEnd` / page ranges: not possible with current chunking (section 7).
- Page numbers inside artifact citations: not available (section 8).
- "Last updated" follows workspace edits, not activity (section 1).
- Backfilling metadata/citation fields for existing sources is done by reprocessing, not
  automatically. If the demo data matters, reprocess those sources once
  (`POST .../sources/reprocess` with their ids).
- `login-hero.jpg` is not backend (as in your doc).
