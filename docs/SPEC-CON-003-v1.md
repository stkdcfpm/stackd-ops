# SPEC-CON-003-v1: Backfill missing `id` on malformed Contact records

**Implements:** REQ-CON-003-v4 (requirements-gate PASS)

## 1. `backfillConIds()` — new function, placed immediately after `backfillRefNums()` (`index.html:2395-2425`)

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

## 2. Call sites — all four, matching `backfillRefNums()`'s existing pattern exactly (REQ-CON-003b)

**Site 1 — `index.html:2550`, inside `backfillOrderRequests()`:**
```js
  });
  if (changed) backfillRefNums();
  backfillConIds();
}
```
Placed *outside* the `if (changed)` guard (unlike `backfillRefNums()`'s call here, which is conditional on `backfillOrderRequests()`'s own local `changed` flag) — `backfillConIds()` has its own internal change-detection (§1) and must not be skipped just because `backfillOrderRequests()` itself made no Order Request changes.

**Site 2 — `index.html:3612`, inside `pullAll()`:**
```js

  backfillRefNums();
  backfillConIds();
  saveAll(); renderAll();
```

**Site 3 — `index.html:8452`, post-restore:**
```js
    seedAdHocBuyer();
    backfillRefNums();
    backfillConIds();
    migrateLinkedPOIds();
```

**Site 4 — `index.html:10181`, inside `initApp()`:**
```js
    seedAdHocBuyer();
    backfillRefNums();
    backfillConIds();
    migrateLinkedPOIds();
```

All four insertions are a single new line immediately after the existing `backfillRefNums();` call, matching REQ-CON-003b exactly — no other line at any of these four sites is modified.

## 3. No changes to `delCon()`/`editCon()`/`rCon()`

Per REQ-CON-003d, the fix is entirely upstream (§1/§2) — `delCon()` (`index.html:9517-9526`), `editCon()` (`index.html:9393` onward), and `rCon()`'s onclick generation (`index.html:9367-9369`) are untouched.

## 4. Test plan (`tests/run.js`)

New suite `Contact id backfill (SPEC-CON-003)`:

- `backfillConIds()` — a `DB.con` record with `id: undefined` is assigned a real, non-empty string `id` (AC-001).
- `backfillConIds()` — a `DB.con` record with `id: ''` is assigned a real id (covers the empty-string falsy case alongside `undefined`/`null`, AC-001).
- `backfillConIds()` — a `DB.con` record with a real existing `id` (e.g. `'c1'`) is left with that exact same `id` value afterward — object reference and value both unchanged (AC-002).
- `backfillConIds()` — after backfilling, calling `delCon()` with the newly-assigned id successfully removes the record (AC-003, the exact regression case reported by the user).
- `backfillConIds()` — after backfilling, calling `editCon()` with the newly-assigned id successfully finds the record (asserted via `EI.co` being set to the id and no early return, AC-004).
- `backfillConIds()` — called on a `DB.con` array where every record already has an `id` — asserts `sv`/persistence is not triggered unnecessarily (AC-005; test via a spy on `sv`, following the same stash/restore spy pattern already used elsewhere in the suite, e.g. the `rCon()` spy test added in `SPEC-CON-002`).
- `backfillConIds()` — two records both missing `id` in the same call each receive distinct, non-empty `id` values (AC-007).
- Regression: `DB.ord` records with real `contactId` values (from the existing `_ordLineFixture`-style fixtures, or a minimal inline fixture) are unaffected by a `backfillConIds()` call — confirms this function never touches `DB.ord` at all (implicit scope-boundary check, not a named AC but a natural regression guard given REQ-CON-003a's `DB.con`-only scope).

AC-006 (backfill runs at the four confirmed call sites) is satisfied by the code placement in §2 itself, verified by direct citation rather than a runtime test — matching how `backfillRefNums()`'s own call-site correctness is treated elsewhere in this codebase (no dedicated test asserts `initApp()` calls `backfillRefNums()`; it's confirmed by reading the function body).

## Changelog

- v1: Initial spec implementing REQ-CON-003-v4.
