# SPEC-CON-003-v2: Backfill missing `id` on malformed Contact records

**Implements:** REQ-CON-003-v4 (requirements-gate PASS)

**Supersedes:** SPEC-CON-003-v1 (spec-gate PASS, but schema-migration-reviewer FAIL — Site 1's placement, immediately after `backfillOrderRequests()`'s own `if (changed) backfillRefNums();` line, was *after* that same function's internal `DB.con.forEach` loop that reads `c.id` and writes `contactId: c.id` into new `DB.ord` records (`index.html:2540-2541`). Since `backfillOrderRequests()` is called standalone in existing tests with no guaranteed prior `backfillConIds()` call, this ordering could reproduce the exact `contactId: undefined` orphaning scenario REQ-CON-003e claims cannot happen, one layer removed — making that function self-inconsistent rather than the fix being self-contained. Also flagged: `FIELD_MAPS.co` syncs `id` (as `Contact ID`) and matches pulled rows by it, an implication neither the REQ nor v1 examined — logged as `DATA-GAP-005` rather than silently unaddressed.)

## 1. `backfillConIds()` — new function, placed immediately after `backfillRefNums()` (`index.html:2395-2425`)

Unchanged from v1:

```js
function backfillConIds() {
  var changed = false;
  DB.con.forEach(function(c) {
    if (!c.id) { c.id = uid(); changed = true; }
  });
  if (changed) sv(K.co, DB.con);
}
```

- REQ-CON-003a: assigns a fresh `id` via `uid()` (`index.html:2379`) to any `DB.con` record where `id` is falsy — covers `undefined`, `null`, and `''` uniformly via the truthiness check `!c.id`.
- REQ-CON-003c: `sv(K.co, DB.con)` only runs if at least one record was actually backfilled (AC-005) — mirrors `backfillRefNums()`'s own `if (changed) saveAll();` pattern (`index.html:2424`), scoped to just `K.co`/`DB.con` since that's the only entity this function touches.
- REQ-CON-003e: two records missing `id` in the same run each get a distinct `uid()` call (AC-007) — no shared/batched id generation, each `forEach` iteration calls `uid()` independently.
- Scope confirmed `DB.con`-only (REQ-CON-003a) — no other entity array is touched.

## 2. Call sites — corrected in v2: Site 1 moves inside `backfillOrderRequests()`, before its own logic

**Site 1 — `index.html:2510-2511`, at the very top of `backfillOrderRequests()` (corrected placement):**

```js
function backfillOrderRequests() {
  backfillConIds();
  var changed = false;
  DB.qt.forEach(function(q) {
```

This is the schema-migration-reviewer-mandated fix: rather than calling `backfillConIds()` *after* `backfillOrderRequests()`'s own `DB.con.forEach` loop (which reads `c.id` at `index.html:2540-2541` to build new `DB.ord` records), the call now runs as the function's **first statement**. This makes `backfillOrderRequests()` self-contained and safe regardless of caller order — it no longer relies on some other call site having already run `backfillConIds()` first. The function's own closing `if (changed) backfillRefNums();` line (`index.html:2550`, unchanged) is untouched; no second `backfillConIds()` call is added there (would be redundant — the top-of-function call already guarantees every `DB.con` record has a real `id` before this function's own logic runs).

**Site 2 — `index.html:3612`, inside `pullAll()`, unchanged from v1:**
```js

  backfillRefNums();
  backfillConIds();
  saveAll(); renderAll();
```

**Site 3 — `index.html:8452`, post-restore, unchanged from v1:**
```js
    seedAdHocBuyer();
    backfillRefNums();
    backfillConIds();
    migrateLinkedPOIds();
```

**Site 4 — `index.html:10181`, inside `initApp()`, unchanged from v1:**
```js
    seedAdHocBuyer();
    backfillRefNums();
    backfillConIds();
    migrateLinkedPOIds();
```

Sites 2-4 each additionally call `backfillOrderRequests()` later in their own sequence (existing code, unchanged) — with Site 1's fix, that later call is now guaranteed safe even though `backfillConIds()` already ran earlier in the same sequence too (the function's internal call is idempotent — a `DB.con` array with no id-less records left is a fast no-op `forEach` with no `uid()` calls and no `sv()`).

## 3. No changes to `delCon()`/`editCon()`/`rCon()`

Per REQ-CON-003d, the fix is entirely upstream (§1/§2) — `delCon()` (`index.html:9517-9526`), `editCon()` (`index.html:9393` onward), and `rCon()`'s onclick generation (`index.html:9367-9369`) are untouched.

## 4. Known gap logged (new in v2 — per schema-migration-reviewer finding)

**DATA-GAP-005** added to `docs/known-gaps.md` and `CLAUDE.md`'s summary table: backfilling a Contact's `id` can orphan its Sheets sync row if that contact was previously pushed with a blank `Contact ID` column (`FIELD_MAPS.co` maps `id` → `'Contact ID'`; `co` is matched on pull by `id`). Accepted, not fixed — same class of risk as the already-accepted `SEC-GAP-011` (no timestamp-based sync conflict resolution), requiring the specific sequence of a malformed contact having already been pushed to Sheets before this fix ships. No local data loss either way.

## 5. Test plan (`tests/run.js`)

New suite `Contact id backfill (SPEC-CON-003)`, same as v1 plus one new regression test:

- `backfillConIds()` — a `DB.con` record with `id: undefined` is assigned a real, non-empty string `id` (AC-001).
- `backfillConIds()` — a `DB.con` record with `id: ''` is assigned a real id (covers the empty-string falsy case alongside `undefined`/`null`, AC-001).
- `backfillConIds()` — a `DB.con` record with a real existing `id` (e.g. `'c1'`) is left with that exact same `id` value afterward — object reference and value both unchanged (AC-002).
- `backfillConIds()` — after backfilling, calling `delCon()` with the newly-assigned id successfully removes the record (AC-003, the exact regression case reported by the user).
- `backfillConIds()` — after backfilling, calling `editCon()` with the newly-assigned id successfully finds the record (asserted via `EI.co` being set to the id and no early return, AC-004).
- `backfillConIds()` — called on a `DB.con` array where every record already has an `id` — asserts `sv`/persistence is not triggered unnecessarily (AC-005; test via a spy on `sv`, following the same stash/restore spy pattern already used elsewhere in the suite, e.g. `tests/run.js:3143-3155`'s `sv` spy around `delCon()`).
- `backfillConIds()` — two records both missing `id` in the same call each receive distinct, non-empty `id` values (AC-007).
- Regression: `DB.ord` records with real `contactId` values are unaffected by a `backfillConIds()` call — confirms this function never touches `DB.ord` at all (implicit scope-boundary check for REQ-CON-003a's `DB.con`-only scope).
- **New in v2 (schema-migration-reviewer-mandated):** `backfillOrderRequests()` called **standalone** (no preceding `backfillConIds()` call in the test), against a `DB.con` fixture containing a record with `enquiries: [{...}]` but no `id` — asserts the resulting new `DB.ord` record's `contactId` is a real, non-empty string (the backfilled id), never `undefined` — proving the Site 1 fix makes `backfillOrderRequests()` self-contained regardless of call order, closing the exact gap schema-migration-reviewer found.

AC-006 (backfill runs at the four confirmed call sites) is satisfied by the code placement in §2 itself, verified by direct citation rather than a runtime test — matching how `backfillRefNums()`'s own call-site correctness is treated elsewhere in this codebase.

## Changelog

- v2: Moved Site 1's `backfillConIds()` call from after `backfillOrderRequests()`'s own `DB.con`-reading loop to the very first statement inside that function — closes a critical ordering hazard schema-migration-reviewer found, where calling `backfillOrderRequests()` standalone (as existing tests already do) could write `contactId: undefined` into a new `DB.ord` record if an id-less contact existed and no prior backfill had run. Added a standalone-invocation regression test proving the fix. Logged `DATA-GAP-005` (Sheets sync duplicate-row risk on backfilled Contact ids) per the same review.
- v1: Initial spec implementing REQ-CON-003-v4 (spec-gate PASS, schema-migration-reviewer FAIL — see above).
