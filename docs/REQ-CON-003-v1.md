# REQ-CON-003-v1: Backfill missing `id` on malformed Contact records

## Business Context

Reported directly by the user: a stray, blank Contact record (no name, no email, showing `CON-0001` after a reload triggered `backfillRefNums()`) could not be deleted or edited through the UI. Root-caused by direct code read:

- `rCon()` (`index.html:9377-9379`) generates each row's Edit/Del/Quote buttons via string concatenation: `onclick="delCon('" + c.id + "')"`. If `c.id` is JS `undefined` (a malformed record — likely a corrupted/legacy record predating consistent `id` assignment, or a bad import/restore path), string concatenation coerces it to the literal text `undefined`, so the generated markup is `onclick="delCon('undefined')"` — a **string** `'undefined'`, not the real `undefined` value.
- `delCon(id)` (`index.html:9527-9536`) filters `DB.con = DB.con.filter(function(c){ return c.id !== id; })`. For the malformed record, `c.id` (real `undefined`) `!== 'undefined'` (the string) evaluates `true` — so the record is always kept, and the delete silently no-ops every time.
- `editCon(id)` (`index.html:9403-9404`) uses `DB.con.find(function(x){ return x.id === id; })` — the same string/undefined mismatch means Edit also silently fails to locate the record (`if (!c) return;` at line 9405 exits quietly, no error surfaced to the operator).

The user worked around this immediately via a manual browser-console fix (`DB.con = DB.con.filter(c => c.id); ...; location.reload()`), which is not a repeatable or discoverable fix for a future recurrence — the user then asked for a proper fix so any future id-less Contact record is deletable/editable normally through the UI rather than needing console surgery.

## FM-1 Assessment

No new `K`/`DB`/`EI` entity, no new field on the `DB.con` schema — this backfills the *existing* `id` field (which every other entity/every non-malformed contact already has) onto any record currently missing it. Same category as the existing `backfillRefNums()` precedent (`index.html:2405-2435`), which already backfills a missing `num` the same way, at the same call sites. Falls under FM-1 exception item 1 (`STACKD_CONTEXT.md:111`) — a defensive data-integrity fix to an existing field, not a new entity or field. No separate council decision required.

## Requirements

**REQ-CON-003a (backfill function):** Add a function that assigns a fresh `id` (via the existing `uid()` helper, same generator used everywhere else in the app) to any `DB.con` record where `id` is falsy (`undefined`, `null`, or an empty string). Scope is `DB.con` only — this REQ fixes the specific, confirmed defect reported by the user; it does not preemptively backfill `id` on other entities (`sup`/`li`/`inv`/`po`/`ord`/etc.) absent any evidence they have the same defect. If a similar report surfaces for another entity, that's a separate REQ.

**REQ-CON-003b (call sites — same as `backfillRefNums()`'s precedent):** Call the new backfill function at the same points `backfillRefNums()` already runs: on `initApp()` (`index.html:10191` area), immediately after a backup restore (`index.html:8462` area), and after a Sheets pull (`index.html:3622`, inside `pullAll()`) — so any id-less record self-heals the next time the app loads or syncs, matching the existing self-healing pattern already established for missing `num`s. Placed adjacent to the existing `backfillRefNums()` call at each site (same ordering rationale — run early, before any render/save cycle that would otherwise render an unusable row).

**REQ-CON-003c (persistence):** If any record was backfilled, the function calls `sv(K.co, DB.con)` (mirroring `backfillRefNums()`'s own `if (changed) saveAll();` pattern, scoped to just the `co` entity since that's the only entity this REQ touches) so the fix survives without requiring a further save action from the operator.

**REQ-CON-003d (no change to delete/edit logic itself):** `delCon()`/`editCon()` are not modified — the fix is upstream (ensuring `id` is always real before these functions ever run), not downstream (adding defensive parsing to every id-comparison call site across the app). This keeps the fix small and localized, consistent with the existing `backfillRefNums()` precedent's own design (fix data at the source, not every consumer).

**REQ-CON-003e (idempotent, safe to run repeatedly):** Running the backfill function multiple times (e.g. on every `initApp()` call across many sessions) must not reassign a new `id` to a record that already has one, and must not collide two different backfilled records onto the same generated `id` (relies on `uid()`'s existing collision-avoidance guarantee, already trusted everywhere else in the app — not re-verified by this REQ).

## Acceptance Criteria

- AC-001: A `DB.con` record with `id: undefined` (or missing entirely) is assigned a real, non-empty `id` string after the backfill function runs.
- AC-002: A `DB.con` record that already has a real `id` is left completely unchanged (same `id` value, same reference) by the backfill function.
- AC-003: After backfill, `delCon(newlyAssignedId)` successfully removes the record — the exact failure mode reported by the user is fixed.
- AC-004: After backfill, `editCon(newlyAssignedId)` successfully locates and opens the record for editing.
- AC-005: If no record needed backfilling, `sv(K.co, DB.con)` is not called unnecessarily (mirrors `backfillRefNums()`'s own `if (changed)` guard — no wasted writes on every load).
- AC-006: The backfill function runs at `initApp()`, post-restore, and post-`pullAll()` — the same three call sites as `backfillRefNums()` — confirmed via direct code citation, not assumed.

## Changelog

- v1: Initial requirements draft.
