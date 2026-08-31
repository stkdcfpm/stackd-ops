# REQ-SYNC-002 — Batch Sheets sync requests into one round trip per direction

**Status:** v1 — pre-review draft.
**Type:** Performance fix — no data-shape or merge-semantics change. Touches both `index.html` and the externally-deployed `apps-script/Code.gs`, so ships with an explicit backward-compatible rollout design (§2, REQ-SYNC-002d) since the Apps Script side requires a manual redeploy this session cannot perform.

---

## 1. Business context

### 1.1 The complaint and the diagnosis (from check-first, this session)

"The sync function takes so long." Two compounding, independently-confirmed causes, found by direct code read, not assumption:

**Cause 1 — client-side seriality.** `syncAll()` (`index.html:4017-4036`), `pullAll()` (`index.html:4065-4186`), and `pushAll()` (`index.html:4213-4229`) each loop over 7-10 entities and issue one `sPost()`/`sGet()` HTTP call per entity **inside a `for` loop with `await`** — never `Promise.all()`'d. Total wall-clock time is the *sum* of every request's latency, not the slowest one. Concretely: `syncAll()`/`pushAll()` each make 9-10 sequential `bulk_upsert` calls (`sup`, `li`, `po`, `sh`, `qt`, `payments`, `co`, `inv`, `cn`, plus `inv_lines` for `pushAll()`); `pullAll()` makes up to 8 sequential `pull_entity`/`sGet()` calls (`inv`, `cn`, `po`, then the `simpleEnts` loop: `sup`, `li`, `payments`, `sh`, `qt`, `co`).

**Cause 2 — each of those round trips is independently expensive, and Cause 1 multiplies that cost by 8-10x.** Every request lands on `apps-script/Code.gs`'s `doPost()`, and the entity handlers it dispatches to — `handleBulkUpsert` (line 84), `handlePullEntity` (line 253) — call `getOrCreateSheet()`/`getSheet()` (lines 384, 378), each of which calls `SpreadsheetApp.openById(SPREADSHEET_ID)` **fresh, on every single request**. This is a well-documented, comparatively expensive Apps Script operation (typically several hundred ms to 1+ second). `handleBulkUpsert` additionally does a full clear-and-rewrite of the entire sheet's data range every time (`clearContent()` then `setValues()` for the whole records array), so cost scales with total record count on every sync, not with what changed. `logAudit()` (line 410, called from `handleBulkUpsert` when a duplicate is deduped) independently calls `SpreadsheetApp.openById()` a *second* time within the same request when it fires.

**Ruled out:** the Cloudflare Worker CORS proxy in front of Apps Script (`cloudflare-worker/worker.js`) is a thin, single-fetch passthrough with negligible added latency — not a contributor.

**Not in scope, confirmed unaffected:** `syncEnt()`/`delEnt()` (`index.html:3947-3957`) — the real-time, single-record sync calls fired on every individual save — are inherently one-entity-one-record operations tied to a specific save action at a specific moment; they don't loop over multiple entities and have nothing to batch. Unchanged by this REQ.

### 1.2 The user-selected fix direction

Batch all entities into **one HTTP request per sync direction** (one for a push/full-sync, one for a pull), with the Apps Script side opening the spreadsheet **once** per request and looping over entities in-process (fast, no network round trip per entity). This is a bigger change than parallelizing the client-side loop (the alternative considered and not chosen), because it touches the externally-deployed Apps Script backend, but it removes both causes at once: fewer round trips, and each spreadsheet open happens once instead of 8-10 times.

### 1.3 Rollout safety — the reason this REQ is more than "just batch the calls"

This session cannot deploy `apps-script/Code.gs` changes — the user must manually copy the updated script into their Apps Script project and create a new deployment version (the same category of manual step already established for `SDLC-GAP-003`'s repo/Pages settings). This creates a real ordering risk: if the new `index.html` ships calling new batched actions (`bulk_upsert_all`, `pull_all`) before the user redeploys Apps Script, every sync would fail outright the moment this version goes live, for every user, until the manual redeploy happens.

**Decision: the client falls back to today's exact per-entity-loop behavior if the batched action isn't recognized by the server.** The new Apps Script actions are added *alongside* the existing `bulk_upsert`/`pull_entity`/`upsert`/`delete` actions — nothing existing is removed or changed in the old actions' behavior. `sPost()`/`sGet()` already treat any non-`'ok'` response as a signal to retry/fail-soft in their callers; this REQ adds one specific, deliberate check — "did the server respond `Unknown action`?" — that triggers the old sequential-loop code path unchanged, so a user who hasn't redeployed yet keeps full (if slower) sync functionality with zero visible breakage, and gets the speed win automatically the moment they do redeploy, with no further app-side action needed.

---

## 2. Requirements

### REQ-SYNC-002a — New Apps Script action: `bulk_upsert_all`
Payload: `{ action:'bulk_upsert_all', entities: [{entity, records}, ...] }` — an array preserving the exact same per-entity record shape (`mapRec()`-transformed, display-header-keyed) already sent to `bulk_upsert` today. Server opens `SpreadsheetApp.openById(SPREADSHEET_ID)` **once**, then for each `{entity, records}` in order runs the *same* dedup → `ensureHeaders` → clear → rewrite logic `handleBulkUpsert` already performs — refactored to accept an already-open spreadsheet handle rather than each helper (`getOrCreateSheet`, `logAudit`) independently reopening it. Returns `{ status:'ok', results: [{entity, written, deduped}, ...] }`, one entry per entity in the same order submitted. `handleBulkUpsert` (the single-entity action) is unchanged and left fully intact for the fallback path (REQ-SYNC-002d) and for `syncEnt()`'s real-time single-record calls, which continue to use `upsert`, not this new action at all.

### REQ-SYNC-002b — New Apps Script action: `pull_all`
Payload: `{ action:'pull_all', entities: ['inv','cn','po','sup',...] }` — an array of entity keys, exactly the set `pullAll()` already knows it needs to fetch (computed client-side the same way as today, including the existing `_sb`-configured exclusion of `sup`). Server opens the spreadsheet **once**, reads each requested entity's sheet via the *same* logic `handlePullEntity` already performs (refactored to accept the shared handle), and returns `{ status:'ok', results: { inv:{records:[...]}, cn:{records:[...]}, ... } }` — an object keyed by entity, so the client's existing per-entity merge blocks (§2.3) can look each one up directly by key instead of by array position.

### REQ-SYNC-002c — Client: `syncAll()`/`pushAll()`/`pullAll()` issue one request instead of 8-10
- `syncAll()`: builds one `entities` array (the same 7 `synEnts` plus `inv`/`cn`, computed exactly as today) and sends one `bulk_upsert_all` request instead of 9 sequential `bulk_upsert` calls.
- `pushAll()`: the same, plus `inv_lines` (`buildInvLines()`'s output) included in the same `entities` array — 10 sequential calls become 1.
- `pullAll()`: builds one `entities` array (`inv`, `cn`, `po`, then the `simpleEnts` list, `_sb`-filtered exactly as today) and sends one `pull_all` request instead of up to 8 sequential `sGet()` calls. **The per-entity merge logic itself (field-mapping reversal via `unmapRec()`, business-key matching via `findLocalMatchByBizKey()`/`claimOnceMatcher()`, `mergePulledWithLocal()`) is completely unchanged** — this REQ only changes how the raw pulled records for each entity are *fetched* (one batched response instead of N separate ones), never how they're merged into `DB`. Each entity's merge block still runs exactly as it does today, just reading `result.results[entityKey].records` instead of awaiting its own `sGet(entityKey)` call.

### REQ-SYNC-002d — Client: fall back to the existing per-entity-loop behavior if the server doesn't recognize the batched action
Before either bulk operation runs, the client checks the batched response for the server's existing `Unknown action: <name>` error shape (`doPost`'s own fallback, `Code.gs:72`, unchanged). If seen, `syncAll()`/`pushAll()`/`pullAll()` fall through to running the *exact* current sequential per-entity-loop code, byte-identical to today — not a re-implementation, the same code path kept in place, reachable when the batched call isn't recognized. This makes the rollout order-independent: ship this version's `index.html` at any time relative to the user's Apps Script redeploy, and sync keeps working throughout, only getting faster once both sides are updated.

---

## 3. Explicitly out of scope

- **No change to `SYNC-GAP-001`'s already-disclosed, accepted risk** (destructive clear-and-rewrite of Sheets rows the operator doesn't hold locally, and the pull-side unconditional Sheets-wins merge) — this REQ batches *how many requests* carry that same clear-and-rewrite logic, not *what* it does. Confirmed by design: `handleBulkUpsert`'s dedup/clear/rewrite logic is reused verbatim inside the new batched handler, not altered.
- **No change to `syncEnt()`/`delEnt()`** (the real-time, per-save single-record sync) — out of scope, confirmed unaffected in §1.1.
- **No change to `handleUpsert`/`handleDelete`** (the single-record actions those two functions call) — unchanged, still used exactly as today.
- **No change to `handlePushEntity`** (the `push_entity` action) — confirmed dead code, never called from `index.html` (grepped); left untouched, not removed, since removing dead server-side code isn't this REQ's job and touches a system this session can't redeploy to verify.
- **No incremental/delta sync** (only sending changed rows instead of the full dataset every time) — a much larger, separate change to the sync model's semantics, not attempted here. This REQ only reduces round-trip *count*, not per-request *payload size* or *write scope*.
- **No change to `handleTrackerUpdate`** (the two requirements/project-tracker actions, unrelated to the app's own data sync) — untouched.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Apps Script has been redeployed with the new actions | `syncAll()` runs | Exactly one `bulk_upsert_all` request is sent (not 9 separate `bulk_upsert` requests) |
| AC-2 | Same as AC-1 | `pushAll()` runs | Exactly one `bulk_upsert_all` request is sent, including `inv_lines` in the `entities` array |
| AC-3 | Same as AC-1 | `pullAll()` runs | Exactly one `pull_all` request is sent; each entity's existing merge logic (business-key matching, `mergePulledWithLocal()`, the `_sb`-configured `sup` exclusion) produces byte-identical `DB` state to today's sequential-call version, given the same server data |
| AC-4 | Apps Script has **not** yet been redeployed (still only knows the old actions) | `syncAll()`/`pushAll()`/`pullAll()` run | The batched request returns the server's existing `Unknown action` error; the client transparently falls back to the current sequential per-entity-loop behavior — sync still completes successfully, just at today's speed, with no user-visible error |
| AC-5 | A `bulk_upsert` call today that triggers dedup (duplicate business keys in one entity's records) | The same scenario is sent via the new `bulk_upsert_all` action | The same dedup count and `Audit` sheet log entry result — dedup logic is reused, not reimplemented |
| AC-6 | The full existing test suite | This REQ is built | All pre-existing tests still pass unchanged — no test currently exercises live Apps Script network calls (confirmed: `tests/run.js` mocks `fetch`/`sGet`/`sPost` at the boundary, never a real HTTP call), so this is a refactor-safety check, not new behavioral coverage of the Apps Script side itself (which cannot be exercised by the Node test suite regardless — see §5) |

---

## 5. Testing approach and its limits (read before scoping the SPEC's test plan)

`apps-script/Code.gs` runs in Google's Apps Script runtime (`SpreadsheetApp`, `PropertiesService`, `ContentService` are Apps Script globals unavailable in Node) and is **not** exercised by `tests/run.js` today — confirmed by grep, no existing test loads or calls into `Code.gs` at all. This REQ's `apps-script/Code.gs` changes cannot be given real automated test coverage by this project's existing test harness; verification of the *server-side* half is necessarily manual (the user triggering a real sync after redeploying, per REQ-SYNC-002's own rollout design). The `index.html` half (REQ-SYNC-002c/d — building the batched payload, parsing the batched response, and the `Unknown action` fallback trigger) **is** testable in the existing Node harness, the same way `pullAll()`'s current `sGet()`/`sPost()` calls are already mocked in `tests/run.js`'s existing `pullAll integration` tests (`_mockPullResponses`) — the SPEC's test plan should extend that same mocking mechanism to the new batched actions and the fallback path, not invent a new one.

---

## 6. Gate process

Full requirements-gate → spec-gate → build-gate — this is new financial/business-data-adjacent sync logic (every entity in `DB` flows through this), touches an externally-deployed backend a mistake in which could break sync for real production data, and sits directly adjacent to `SYNC-GAP-001`'s already-disclosed accepted risk. Do not shortcut.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: no existing gap to mark fixed (this wasn't previously logged as a gap) — add a new entry documenting the two root causes found (§1.1), the fix, and the manual Apps Script redeploy step required for it to take effect, mirroring how `SDLC-GAP-003`'s entry documents its own manual setup steps.
- `docs/requirements-tracker.md`: new row.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist, plus a note (mirroring `SDLC-GAP-003`'s) that the speed improvement requires a manual Apps Script redeploy to actually take effect.
