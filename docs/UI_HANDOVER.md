# UI handover: editing, regeneration and chunk control

This file covers **only this change**. The earlier handover (counts, pagination, bulk endpoints,
citations, conversation artifacts) is already delivered and lives in git history. Full reference for
every endpoint: [API.md](API.md).

Base URL in dev: `http://localhost:8080`. Auth is the existing Better Auth cookie session; every call
below is scoped to the signed-in user (other users' data is 404). All paths are under
`/api/workspaces/:workspaceId`.

Envelope (unchanged): `{ "success": true, "data": ... }` or
`{ "success": false, "error": { "code", "message", "details"? } }`.

## 0. Read this first: what changed for existing code

| Change                                                                                | Impact on the UI                                                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Chunk objects from `GET /sources/:id/chunks` gain **`excluded`** (boolean)            | Additive.                                                                                        |
| `GET /artifacts` accepts `?q=` (title search)                                         | Additive. With no params the response is unchanged.                                              |
| New 409 code **`ARTIFACT_EDITED`**, and `CONFLICT` now also means "changed elsewhere" | Branch on `error.code`, not just the status.                                                     |
| Newly generated artifacts get a short topic title instead of `Quiz · 11/8/2026`       | The title changes once, when the artifact reaches `READY`. Titles you set are never overwritten. |
| Artifact `metadata` may now contain `userEdited: true` and `editedAt`                 | Use it to show an "edited" badge.                                                                |

## 1. Endpoint contract

| Endpoint                                   | Request body                                                                                                                   | Success                                                           | Errors                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PATCH /sources/:sourceId`                 | `{ title?: 1-200, content?: non-empty string, expectedUpdatedAt?: ISO }`; at least one of title/content; unknown keys rejected | **200** source (same shape as `GET /sources/:id`, with `content`) | 400 validation; 400 content sent for a non-text source; 404; 409 while `PENDING`/`PROCESSING`; 409 `CONFLICT` |
| `PATCH /sources/:sourceId/chunks/:chunkId` | `{ excluded: boolean }`                                                                                                        | **200** chunk                                                     | 400; 404 unknown source or chunk; 409 while the source is processing                                          |
| `PATCH /artifacts/:artifactId`             | `{ title?: 1-200, content?: object, expectedUpdatedAt?: ISO }`; at least one; `type` is not editable                           | **200** artifact (same shape as `GET /artifacts/:id`)             | 400 validation with field-level `details`; 404; 409 unless `READY`; 409 `CONFLICT`                            |
| `POST /artifacts/:artifactId/regenerate`   | `{ force?: boolean }`                                                                                                          | **202** artifact with `status: "PENDING"`                         | 400 no READY sources left; 404; 409 `ARTIFACT_EDITED`; 409 already generating                                 |
| `GET /artifacts`                           | query: `q`, `type`, `status`, `limit`, `cursor`                                                                                | **200** `{ data: [...], meta: { total, nextCursor } }`            | 400 invalid query                                                                                             |
| `POST /artifacts/bulk-delete`              | `{ artifactIds: string[1-100] }`                                                                                               | **200** `{ deleted, results: [{ artifactId, status }] }`          | 400; 404 workspace                                                                                            |
| `PATCH /conversations/:conversationId`     | `{ title: 1-120 }`                                                                                                             | **200** conversation                                              | 400; 404                                                                                                      |

`status` in bulk results is `"deleted" | "not_found" | "failed"`. Bulk delete is per-id, not atomic;
duplicate ids collapse and ids from other workspaces are `not_found`. Read `results` for per-row errors.

## 2. Editing a source

- **Title (any source type):** instant. The source stays `READY`, no re-index. Chat citations show the
  new title from the next message on; older messages keep the title they were saved with.
- **Content (TEXT and MARKDOWN only):** the new text **replaces** the old. The backend deletes the old
  chunks and vectors and re-indexes from the new text, so old and new versions can never both be
  retrieved. The response is the source with `status: "PENDING"`. Poll `GET /sources/:id` until
  `READY`; until then chat has no text from this source. Show it as "re-indexing".
- Sending the same content the source already has changes nothing (200, no re-index).
- For PDF, website, YouTube and GitHub sources, hide or disable the content editor: the API returns
  400 "Content can only be edited for text and markdown sources". Title editing stays available.
- A source that is `PENDING` or `PROCESSING` cannot be edited (409). Disable the edit action while it
  is indexing.
- Artifacts already generated keep what they were built from. Offer "regenerate" after a source edit.

## 3. Optimistic concurrency (sources and artifacts)

Send the `updatedAt` you last read as `expectedUpdatedAt`. If the item changed since:

```json
{
    "success": false,
    "error": {
        "code": "CONFLICT",
        "message": "This item was changed elsewhere. Reload and try again."
    }
}
```

Reload the item and let the user retry. The check and the write are one atomic statement, so two
simultaneous edits from the same version cannot both succeed. If you omit `expectedUpdatedAt` the
backend still guards against a change that happens during the request itself. `updatedAt` is returned
everywhere sources and artifacts are returned.

## 4. Editing an artifact

- Only `READY` artifacts can be edited. Send the **full** `content` object in the shape of the
  artifact's type, the same shape `GET` returns. Rename-only requests need just `title`.
- `content` is validated against the artifact's own type. On failure, **400 `VALIDATION_ERROR`** with
  `details` keyed by dotted path, so you can mark the exact field:

```json
{
    "success": false,
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "Invalid artifact content",
        "details": {
            "content.questions.0.correctIndex": ["correctIndex must point at one of the options"]
        }
    }
}
```

| Type         | Stored `content`                                                                             | Extra rules                                          |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `SUMMARY`    | `{ markdown, citations[] }`                                                                  |                                                      |
| `TAKEAWAYS`  | `{ items: string[3-20] }`                                                                    |                                                      |
| `FLASHCARDS` | `{ cards: [{ front, back, citations[] }] }` (3-30)                                           |                                                      |
| `QUIZ`       | `{ questions: [{ question, options[2-5], correctIndex, explanation, citations[] }] }` (3-15) | `correctIndex` < `options.length`                    |
| `MINDMAP`    | `{ nodes: [{ id, label }] (2-40), edges: [{ id, source, target }] }`                         | unique node ids; every edge ends on an existing node |
| `REPORT`     | `{ markdown, sections: [{ title, content, citations[] }] }`                                  |                                                      |
| `WIKI`       | `{ overview, techStack[], architecture, diagram, modules[], gettingStarted }`                |                                                      |

- A citation is `{ marker: int, sourceId, label }`. Citations are stored exactly as sent, so keep an
  item's `citations` when the user edits its text. `citations` may be omitted on a brand new item.
- Unknown keys are rejected (strict), so do not send extra fields.
- Editing `content` sets `metadata.userEdited = true` and `metadata.editedAt`. A rename alone does not.

## 5. Regenerating an artifact

`POST /artifacts/:artifactId/regenerate` re-runs generation in place: same id and same title, using the
sources it was built from (or the workspace's READY sources if none were recorded), or its original
conversation.

1. Call with `{}`. If the artifact was edited you get **409 `ARTIFACT_EDITED`**.
2. Show "Regenerating will discard your edits. Continue?". On confirm, call again with
   `{ "force": true }`.
3. The response is **202** with the artifact `PENDING`. Poll `GET /artifacts/:id` until `READY` (or
   `FAILED` with `metadata.processingError`). The old content stays visible until the new content is
   ready, and `userEdited` is cleared on success.
4. 409 `CONFLICT` means it is already generating or changed meanwhile; reload.

It is rate limited like creation (20 per minute per user).

## 6. Excluding chunks

`PATCH /sources/:id/chunks/:chunkId` with `{ "excluded": true | false }` returns the chunk. Excluded
chunks stay indexed but are skipped by chat retrieval and left out of artifact generation. Nothing is
re-embedded, so the toggle is instant.

- Show an "excluded" toggle per chunk in the chunk viewer, driven by `chunk.excluded`.
- The flags reset to `false` if the source is re-indexed (content edit or reprocess), because
  re-indexing creates new chunks.
- Excluding every chunk of a source leaves it with no usable text: artifact generation from only that
  source fails with "Selected sources have no extracted content yet".

## 7. Smaller items

- **Rename conversation:** `PATCH /conversations/:id` `{ "title": "..." }`; the title is trimmed and
  must be 1-120 characters. Returns the updated conversation.
- **Artifact search:** `GET /artifacts?q=photosynthesis` matches titles case-insensitively and combines
  with `type`, `status`, `limit` and `cursor`.
- **Artifact bulk delete:** register the selection UI against `POST /artifacts/bulk-delete`; the route
  is `/artifacts/bulk-delete`, not `/artifacts/:id`.
- **Titles:** generated artifacts are renamed once, at `READY`, from the default
  `Quiz · 11/8/2026` to a short topic title. The artifact list may therefore show the date title
  briefly while an artifact is `PENDING`/`PROCESSING`.

## 8. Suggested UI wiring

- Source editor: show title editing always; show the content editor only for TEXT/MARKDOWN. On save,
  send `expectedUpdatedAt`; on 409 `CONFLICT` reload and re-apply. After a content save, show the
  source as re-indexing and poll until `READY`.
- Artifact viewer: "Edit" when `READY`; send the full `content`; surface `details` per field on 400.
  Show an "edited" badge from `metadata.userEdited`.
- Regenerate button: handle `ARTIFACT_EDITED` with a confirmation, then retry with `force: true`.
- Chunk viewer: per-chunk exclude toggle bound to `excluded`.
- Library: bulk delete with the selected ids, then refresh and read `results`.

## 9. Operational notes

- **Migration required:** `20261108090000_add_chunk_excluded` (adds
  `source_chunk.excluded BOOLEAN NOT NULL DEFAULT false`). Run `npm run db:migrate:deploy`. It is already
  applied to the local dev DB. Existing Pinecone vectors need no backfill.
- **Verified against a running server:** smoke test `npm run smoke` (92 checks with AI, 49 with
  `--no-ai`) and the Postman collection run with newman (133 requests, 328 assertions, 0 failures).
- The smoke test uses about 250 of the API's 300 requests per 15 minutes per IP; wait before re-running
  it back to back.
- Postman: new requests are in folders 03 (sources, chunks), 04 (PDF content edit), 06 (rename) and
  08 (artifact edit, regenerate, search), plus bulk artifact delete in 10.

## 10. Decisions to be aware of

- A rename does not mark an artifact as edited, so it never triggers the discard prompt. Say if you
  want it to.
- Past chat messages keep the source title they were saved with; only new answers show a new title.
- Existing artifacts keep their old content after a source edit until they are regenerated.
- The two new diagrams (source edit, artifact edit/regenerate) are Mermaid-only in
  `ARCHITECTURE.md` until their PNGs are exported from Eraser.
