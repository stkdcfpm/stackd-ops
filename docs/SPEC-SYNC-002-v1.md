# SPEC-SYNC-002 — Batch Sheets sync requests into one round trip per direction

**Status:** v1 — spec-gate PASS. Independent review confirmed the diffs match the real current code, REQ-SYNC-002e's error isolation holds under a concrete failure walkthrough, and all three client functions fall back correctly when the server doesn't recognize the batched actions. Four advisory (non-blocking) findings, all fixed in place below — see §6.
**Build baseline:** `main` @ current HEAD, 620/620 tests passing.
**Implements:** `docs/REQ-SYNC-002-v2.md` (REQ-SYNC-002a through REQ-SYNC-002f).

---

## 1. `apps-script/Code.gs` changes

### 1.1 `doPost()` — register the two new actions

Add two dispatch lines alongside the existing `bulk_upsert`/`pull_entity` ones (nothing else in `doPost()` changes):

```js
    if (action === 'ping')                        return respond(pingResponse());
    if (action === 'bulk_upsert')                 return respond(handleBulkUpsert(payload));
    if (action === 'bulk_upsert_all')             return respond(handleBulkUpsertAll(payload));
    if (action === 'upsert')                      return respond(handleUpsert(payload));
    if (action === 'delete')                      return respond(handleDelete(payload));
    if (action === 'push_entity')                 return respond(handlePushEntity(payload));
    if (action === 'pull_entity')                 return respond(handlePullEntity(payload));
    if (action === 'pull_all')                    return respond(handlePullAll(payload));
    if (action === 'update_shipment')             return respond(handleUpdateShipment(payload));
    if (action === 'update_requirements_tracker') return respond(handleTrackerUpdate(payload, REQUIREMENTS_TRACKER_ID, 'Requirements Tracker'));
    if (action === 'update_project_tracker')      return respond(handleTrackerUpdate(payload, PROJECT_TRACKER_ID, 'Project Tracker'));
```

### 1.2 `handleBulkUpsert` — accept an optional already-open spreadsheet handle

Add a second parameter `ss`, threaded into `getOrCreateSheet()` and `logAudit()`. When called from `doPost()` (single-entity path, unchanged call site `handleBulkUpsert(payload)`), `ss` is `undefined` and both helpers fall back to opening the spreadsheet themselves — **byte-identical behavior to today for the existing `bulk_upsert` action.**

```js
function handleBulkUpsert(payload, ss) {
  var entity  = payload.entity;
  var records = payload.records;
  if (!entity)              return { status: 'error', message: 'entity is required' };
  if (!Array.isArray(records)) return { status: 'error', message: 'records must be an array' };

  var sheet = getOrCreateSheet(entity, ss);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  // Deduplicate by business key (last-record-wins)
  var bizKey = BIZ_KEYS[entity];
  var dedupCount = 0;
  if (bizKey) {
    var seen = {};
    for (var i = 0; i < records.length; i++) {
      var kv = String(records[i][bizKey] || '');
      if (kv) {
        if (seen[kv] !== undefined) dedupCount++;
        seen[kv] = i; // always keep latest index
      }
    }
    if (dedupCount > 0) {
      var includedIdx = {};
      Object.keys(seen).forEach(function(k) { includedIdx[seen[k]] = true; });
      records = records.filter(function(_, idx) { return includedIdx[idx]; });
      logAudit(entity, dedupCount, ss);
    }
  }

  // Ensure header row exists
  var sheetHeaders = ensureHeaders(sheet, entity, records);

  // Clear data rows and rewrite
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  if (records.length === 0) return { status: 'ok', written: 0, deduped: dedupCount };

  var rows = records.map(function(rec) {
    return sheetHeaders.map(function(h) {
      var v = rec[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  });

  sheet.getRange(2, 1, rows.length, sheetHeaders.length).setValues(rows);
  return { status: 'ok', written: records.length, deduped: dedupCount };
}
```

(Only the function signature and the two `getOrCreateSheet(entity, ss)` / `logAudit(entity, dedupCount, ss)` call sites change — every other line is unchanged from the current file.)

### 1.3 `handlePullEntity` — same treatment

```js
function handlePullEntity(payload, ss) {
  var entity = payload.entity;
  if (!entity) return { status: 'error', message: 'entity is required' };

  var sheet = getSheet(entity, ss);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', entity: entity, records: [] };

  var headers = data[0].map(String);
  var records = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rec = {};
    for (var j = 0; j < headers.length; j++) {
      var v = row[j];
      if (typeof v === 'string' && (v.charAt(0) === '[' || v.charAt(0) === '{')) {
        try { v = JSON.parse(v); } catch (err) {}
      }
      rec[headers[j]] = v;
    }
    records.push(rec);
  }
  return { status: 'ok', entity: entity, records: records };
}
```

Only the signature and the `getSheet(entity, ss)` call site change.

### 1.4 `getSheet` / `getOrCreateSheet` / `logAudit` — accept the optional handle

```js
function getSheet(entity, ss) {
  var name = SHEET_NAMES[entity];
  if (!name) return null;
  ss = ss || SpreadsheetApp.openById(SPREADSHEET_ID);
  return ss.getSheetByName(name);
}

function getOrCreateSheet(entity, ss) {
  var name = SHEET_NAMES[entity];
  if (!name) return null;
  ss = ss || SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}
```

```js
function logAudit(entity, dedupCount, ss) {
  try {
    ss = ss || SpreadsheetApp.openById(SPREADSHEET_ID);
    var audit = ss.getSheetByName('Audit');
    if (!audit) {
      audit = ss.insertSheet('Audit');
      audit.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Entity', 'Action', 'Details']]);
    }
    audit.appendRow([new Date().toISOString(), entity, 'dedup', dedupCount + ' duplicate(s) removed on bulk_upsert']);
  } catch (e) {}
}
```

Every existing call site of `getSheet(entity)` / `getOrCreateSheet(entity)` / `logAudit(entity, dedupCount)` in the file (`handleUpsert`, `handleDelete`, `handlePushEntity`, and `handleUpdateShipment`'s `getSheet('sh')` call) passes no third/second argument, so `ss` is `undefined` there and each opens the spreadsheet itself exactly as it does today. **Zero behavior change to any existing action.**

### 1.5 New handler: `handleBulkUpsertAll` (REQ-SYNC-002a, error isolation per REQ-SYNC-002e)

```js
// ── bulk_upsert_all ──────────────────────────────────────────────
// Payload: { action:'bulk_upsert_all', entities: [{entity, records}, ...] }
// Opens the spreadsheet once, then reuses handleBulkUpsert's exact per-entity
// logic (dedup / ensureHeaders / clear / rewrite) for each entity in turn.
// One entity's exception cannot abort the others — REQ-SYNC-002e.

function handleBulkUpsertAll(payload) {
  var entities = payload.entities;
  if (!Array.isArray(entities)) return { status: 'error', message: 'entities must be an array' };

  var ss;
  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (err) {
    return { status: 'error', message: 'Could not open spreadsheet: ' + err.message };
  }

  var results = entities.map(function(e) {
    try {
      var r = handleBulkUpsert({ entity: e && e.entity, records: e && e.records }, ss);
      r.entity = e && e.entity;
      return r;
    } catch (err) {
      return { entity: e && e.entity, status: 'error', message: err.message };
    }
  });

  return { status: 'ok', results: results };
}
```

Note: `handleBulkUpsert` itself already returns `{status:'error', message:...}` objects (not thrown exceptions) for its own validation failures (missing entity, non-array records, unknown entity) — those pass through into `results` unchanged (with `entity` attached), same as a thrown exception would. The `try`/`catch` here exists for the failure modes `handleBulkUpsert` doesn't already guard — e.g. a Sheets API exception thrown mid-write for one entity (quota, transient API error) — so that one entity's failure still can't take down the rest of the loop.

### 1.6 New handler: `handlePullAll` (REQ-SYNC-002b, error isolation per REQ-SYNC-002e)

```js
// ── pull_all ─────────────────────────────────────────────────────
// Payload: { action:'pull_all', entities: ['inv','cn','po',...] }
// Opens the spreadsheet once, then reuses handlePullEntity's exact per-entity
// read logic for each requested entity key. Results keyed by entity so the
// client can look each one up directly (index.html REQ-SYNC-002c).
// One entity's exception cannot abort the others — REQ-SYNC-002e.

function handlePullAll(payload) {
  var entities = payload.entities;
  if (!Array.isArray(entities)) return { status: 'error', message: 'entities must be an array' };

  var ss;
  try {
    ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  } catch (err) {
    return { status: 'error', message: 'Could not open spreadsheet: ' + err.message };
  }

  var results = {};
  entities.forEach(function(entity) {
    try {
      results[entity] = handlePullEntity({ entity: entity }, ss);
    } catch (err) {
      results[entity] = { entity: entity, status: 'error', message: err.message };
    }
  });

  return { status: 'ok', results: results };
}
```

### 1.7 Behavior parity note (read before flagging as a gap at spec-gate)

Neither new handler introduces a *new* way for a partial failure to go unnoticed by the client beyond what already exists today. `syncAll()`/`pushAll()` already discard their `sPost()` return values entirely (§1.3 of the REQ) — a `{status:'error',...}` response from today's single-entity `bulk_upsert` is already silently ignored by those two functions, batching or not. `pullAll()` already only acts when `dXxx.status === 'ok'` and otherwise silently skips that entity with no `failed.push(...)` call — a non-'ok' status from today's single-entity `pull_entity` is already silently skipped, batching or not. Consolidating into `results` entries with the same `status` field preserves this exactly; REQ-SYNC-002e's isolation requirement is about **not losing other entities' results**, not about adding new user-facing error surfacing that doesn't exist today (out of scope, not requested).

---

## 2. `index.html` changes

### 2.1 New helper: `isUnknownAction()` — the fallback-trigger check (REQ-SYNC-002d)

Add immediately after `sGet()` (`index.html:3946`), before `syncEnt()`:

```js
function isUnknownAction(res) {
  return !!(res && res.status === 'error' && typeof res.message === 'string' && res.message.indexOf('Unknown action') === 0);
}
```

Matches `Code.gs:72`'s existing, unchanged fallback string (`'Unknown action: ' + action`) exactly — `indexOf(...) === 0` so it doesn't depend on the exact action name appended after it.

### 2.2 `syncAll()` — batch, with fallback (REQ-SYNC-002c, REQ-SYNC-002d)

Replace the current body (`index.html:4017-4036`) with:

```js
async function syncAll() {
  if (!SS.url || !SS.url.startsWith('https://')) { toast('Add Apps Script URL in Settings'); showV('cfg', document.querySelectorAll('.tab')[5]); return; }
  setSyncStatus('loading');
  try {
    var synEnts = ['sup','li','po','sh','qt','payments','co'];
    var invOnly = (DB.inv || []).filter(function(r){ return r.type !== 'credit_note' && r.type !== 'goodwill_credit'; })
                       .map(function(r){ return mapRec('inv', Object.assign({}, r, {type: r.type || 'invoice'})); });
    var cnOnly  = (DB.inv || []).filter(function(r){ return r.type === 'credit_note' || r.type === 'goodwill_credit'; })
                       .map(function(r){ return mapRec('cn', r); });
    var entities = synEnts.map(function(ent) {
      var entKey = ent === 'co' ? 'con' : ent;
      return { entity: ent, records: (DB[entKey] || []).map(function(r){ return mapRec(ent, r); }) };
    });
    entities.push({ entity: 'inv', records: invOnly });
    if (cnOnly.length) entities.push({ entity: 'cn', records: cnOnly });

    var batchRes = await sPost({ action: 'bulk_upsert_all', entities: entities });
    if (isUnknownAction(batchRes)) {
      for (var si = 0; si < synEnts.length; si++) {
        var entKey = synEnts[si] === 'co' ? 'con' : synEnts[si];
        await sPost({action:'bulk_upsert', entity:synEnts[si], records:(DB[entKey] || []).map(function(r){ return mapRec(synEnts[si], r); })});
      }
      await sPost({action:'bulk_upsert', entity:'inv', records:invOnly});
      if (cnOnly.length) await sPost({action:'bulk_upsert', entity:'cn', records:cnOnly});
    }
    setSyncStatus('ok'); toast('Full sync complete'); setTimeout(function(){ setSyncStatus('idle'); }, 4000);
    localStorage.setItem('st_last_sync', new Date().toISOString());
    renderSyncStatus();
  } catch(e) { setSyncStatus('err'); toast('Sync failed: ' + e.message); }
}
```

The `entities`-building logic is the exact same per-entity `mapRec()`/filter logic that runs today, just collected into an array up front instead of posted one at a time. The fallback block below `isUnknownAction(batchRes)` is the *exact* current sequential loop body (`index.html:4021-4031` today), reused verbatim as dead-until-triggered code, not reimplemented — satisfying REQ-SYNC-002d's "byte-identical" requirement.

### 2.3 `pushAll()` — batch, with fallback (REQ-SYNC-002c, REQ-SYNC-002d)

Replace the current body (`index.html:4213-4230`) with:

```js
async function pushAll() {
  setSyncStatus('loading');
  try {
    var ents = ['sup','li','po','sh','qt','payments','co'];
    var invOnly = (DB.inv || []).filter(function(r){ return r.type !== 'credit_note' && r.type !== 'goodwill_credit'; })
                       .map(function(r){ return mapRec('inv', Object.assign({}, r, {type: r.type || 'invoice'})); });
    var cnOnly  = (DB.inv || []).filter(function(r){ return r.type === 'credit_note' || r.type === 'goodwill_credit'; })
                       .map(function(r){ return mapRec('cn', r); });
    var invLines = buildInvLines();
    var entities = ents.map(function(ent) {
      var entKey = ent === 'co' ? 'con' : ent;
      return { entity: ent, records: (DB[entKey] || []).map(function(r){ return mapRec(ent, r); }) };
    });
    entities.push({ entity: 'inv', records: invOnly });
    entities.push({ entity: 'cn', records: cnOnly });
    entities.push({ entity: 'inv_lines', records: invLines });

    var batchRes = await sPost({ action: 'bulk_upsert_all', entities: entities });
    if (isUnknownAction(batchRes)) {
      for (var pi = 0; pi < ents.length; pi++) {
        var entKey = ents[pi] === 'co' ? 'con' : ents[pi];
        await sPost({action:'bulk_upsert', entity:ents[pi], records:(DB[entKey] || []).map(function(r){ return mapRec(ents[pi], r); })});
      }
      await sPost({action:'bulk_upsert', entity:'inv', records:invOnly});
      await sPost({action:'bulk_upsert', entity:'cn', records:cnOnly});
      await sPost({action:'bulk_upsert', entity:'inv_lines', records:invLines});
    }
    setSyncStatus('ok'); toast('Pushed all'); setTimeout(function(){ setSyncStatus('idle'); }, 3000);
  } catch(e) { setSyncStatus('err'); toast('Failed: ' + e.message); }
}
```

Note: `pushAll()`'s `cn` push stays unconditional (not gated by `cnOnly.length`, unlike `syncAll()`) in both the batched entities array and the fallback loop — this asymmetry already exists in the current code (flagged as a minor pre-existing inconsistency at REQ-SYNC-002's requirements-gate) and is preserved exactly, not fixed here — fixing it is unrelated to this REQ's scope (batching request count, not changing what gets sent).

### 2.4 `pullAll()` — batch, with fallback (REQ-SYNC-002c, REQ-SYNC-002d)

Add one `pulled()` helper and swap all four `sGet(...)` call sites in the function for `pulled(...)` (`sGet('inv')`, `sGet('cn')`, `sGet('po')`, and the parameterized `sGet(eKey)` inside the `simpleEnts` loop — confirmed by grep to be the complete set, no others exist in `pullAll()`). Everything else in the function — every line of merge logic — is untouched.

At the top of `pullAll()` (`index.html:4065-4068` today), before the `// ── Invoices` comment:

```js
async function pullAll() {
  if (!SS.url) { toast('No URL configured'); return; }
  setSyncStatus('loading');
  var failed = [];

  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch);

  var batched = null;
  try {
    var batchRes = await sPost({ action: 'pull_all', entities: _allPullKeys });
    if (batchRes && batchRes.status === 'ok' && batchRes.results) batched = batchRes.results;
  } catch (e) { /* network failure on the batched call — fall through to per-entity sGet(), same end state as before batching existed */ }

  async function pulled(entity) {
    if (batched) return batched[entity] || { status: 'error', message: 'No result for ' + entity };
    return await sGet(entity);
  }

  // ── Invoices (field-mapping reversed, business-key merge — SYNC-GAP-001) ─
  try {
    var dInv = await pulled('inv');
```

Then, unchanged from today except for the one substitution each:
- line `var dCn = await sGet('cn');` → `var dCn = await pulled('cn');`
- line `var dPo = await sGet('po');` → `var dPo = await pulled('po');`
- inside the `simpleEnts` loop, `var sd = await sGet(eKey);` → `var sd = await pulled(eKey);`

The existing `simpleEnts`/`idKeyedEnts` variable names and the loop body below stay exactly as they are — `_simpleEntsForBatch` is a separate variable computed up front purely to build `_allPullKeys` for the one batched request; it is intentionally *not* used to replace `simpleEnts` itself, so the existing loop (`index.html:4134-4171`) doesn't need to change at all beyond its one `sGet` → `pulled` substitution. (`_simpleEntsForBatch` and `simpleEnts` are computed by the identical filter logic and will always be the same array in practice — kept as two named variables only to avoid touching the untouched loop's variable, not because they can differ.)

**Fallback behavior:** if the server doesn't recognize `pull_all` (`Code.gs`'s existing `Unknown action` reply), `batchRes.status !== 'ok'`, so `batched` stays `null`, and every call to `pulled(entity)` falls through to `await sGet(entity)` — the *exact* current per-entity-loop code path, reused verbatim, satisfying REQ-SYNC-002d without a separate explicit fallback branch (the `if (batched)` check inside `pulled()` **is** the fallback trigger for the pull side).

**Network-failure case:** if the batched `sPost()` call itself throws (not an `Unknown action` reply but a genuine network failure), the `catch` leaves `batched` as `null` and every entity falls through to its own individual `sGet()` call — which will most likely also fail against the same network outage, landing in the *exact* same all-`failed` end state `pullAll()` would reach today under a real network outage, just with one extra failed round trip first. No behavior regression; documented here so it isn't mistaken for an oversight at spec-gate.

---

## 3. Test plan (`tests/run.js`)

Per REQ-SYNC-002 §5: extend the existing `mockFetch`/`_mockPullResponses` mechanism, don't invent a new one.

### 3.1 Mock harness additions

```js
let _mockPullAllResponse = null;    // set to {status:'ok', results:{...}} to test the batched pull path directly
let _mockUnknownBatchAction = false; // set true to make bulk_upsert_all/pull_all return the server's Unknown action reply
let _fetchCallLog = [];             // {action, entity?, entities?} per Sheets-sync call this test made
```

In `mockFetch`, after the existing Anthropic branch and JSON-parsing of `body`, before the existing `pull_entity` handling:

```js
  _fetchCallLog.push({ action: body.action, entity: body.entity, entities: body.entities });

  if ((body.action === 'bulk_upsert_all' || body.action === 'pull_all') && _mockUnknownBatchAction) {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'Unknown action: ' + body.action })) });
  }
  if (body.action === 'pull_all' && _mockPullAllResponse) {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(_mockPullAllResponse)) });
  }
```

The existing bottom branch (`pull_entity` lookup, default `{status:'ok', records:[]}`) is unchanged — this preserves every existing test's behavior exactly: with no new flags set, `pull_all` still gets the generic default response (`{status:'ok', records:[]}`, no `.results` key), so `pullAll()`'s own `if (batchRes.status === 'ok' && batchRes.results)` check is false, `batched` stays `null`, and every existing `_mockPullResponses`-based test falls through to the per-entity `sGet()` path exactly as it does today — zero changes needed to any of the ~14 existing `pullAll integration` tests.

### 3.2 New tests

- **`isUnknownAction()` unit tests** — true for the exact server shape, false for `{status:'ok',...}`, false for `{status:'error', message:'Something else'}`, false for `{status:'error'}` (no message), false for `null`/`undefined`.
- **`syncAll()` — batched happy path**: reset `_fetchCallLog`, call `syncAll()`, assert exactly one call with `action === 'bulk_upsert_all'` and its `entities` array contains the expected entity keys (`sup,li,po,sh,qt,payments,co,inv` at minimum; `cn` only when `DB.inv` has a credit-note-typed row).
- **`syncAll()` — fallback path**: `_mockUnknownBatchAction = true`, call `syncAll()`, assert the fetch log shows one `bulk_upsert_all` call followed by the expected sequence of individual `bulk_upsert` calls (same entity set as today, same order), and that `syncAll()` still resolves without throwing.
- **`pushAll()` — batched happy path**: same as `syncAll()`'s, plus asserting `inv_lines` is present in the single batched request's `entities`.
- **`pushAll()` — fallback path**: same as `syncAll()`'s fallback test, asserting the individual-call fallback sequence includes `inv_lines` as its own trailing `bulk_upsert` call.
- **`pullAll()` — batched happy path**: set `_mockPullAllResponse = {status:'ok', results:{ li: {status:'ok', records:[{...}]} }}` reusing the exact record fixture from the existing "li pull matching by sku" test (§1546 today), assert identical `DB.li` outcome to that existing test — proving the batched path produces byte-identical merge results to the fallback path for the same input data.
- **`pullAll()` — fallback path parity**: `_mockUnknownBatchAction = true`, re-run each of the existing `_mockPullResponses`-based scenarios (or at minimum a representative subset — li/inv/sh), asserting identical results to today, confirming the fallback path is truly untouched.

No test can exercise the Apps Script side (`handleBulkUpsertAll`/`handlePullAll` themselves) per REQ-SYNC-002 §5 — those remain manually verified after the user's redeploy, as already accepted in the REQ.

---

## 4. Manual step required after merge

The user must copy the updated `apps-script/Code.gs` into their Apps Script project and create a new deployment version. Until that happens, `syncAll()`/`pushAll()`/`pullAll()` all transparently fall back to today's exact sequential behavior (§2.2-§2.4) — no user-visible change, no broken sync, just no speed win yet. Confirmation once redeployed: open the browser's Network tab (or a console log) during a sync and confirm one `bulk_upsert_all`/`pull_all` request appears instead of 8-10 separate ones.

---

## 5. `docs/known-gaps.md` / tracker updates required on completion

Per REQ-SYNC-002 §7 — new `known-gaps.md` entry (two root causes + fix + manual redeploy step), new `requirements-tracker.md` row, `STACKD_CONTEXT.md`/`CLAUDE.md` version-ship housekeeping noting the manual redeploy requirement.

---

## 6. Spec-gate review-resolution log

Independent spec-gate review returned **PASS** — diffs verified accurate against the real current `Code.gs`/`index.html`, REQ-SYNC-002e's isolation confirmed under a concrete failure walkthrough (one entity's mid-write exception correctly isolated, response stays `status:'ok'` with every other entity's result intact), all three client functions' rollout fallback traced and confirmed correct, and the mock-harness extension confirmed to leave all ~14 existing `pullAll integration` tests and the `syncAll()` guard tests unaffected. Four advisory findings, all fixed in place (no blocking bug, so no v2 needed):

1. **`handleBulkUpsertAll`'s catch could itself throw if `e` were ever malformed** (`e.entity` dereferenced unguarded) — not reachable via the app's real client code (the `entities` array is always built from hardcoded keys), but a literal gap in the isolation guarantee as written. **Fixed:** guarded as `e && e.entity` / `e && e.records` at both the call site and the catch block.
2. **`handlePullAll`'s catch omitted the `entity` field** that AC-7 specifies for a failed entity's result shape. **Fixed:** added `entity: entity` to the caught-error object.
3. **§1.4 undercounted `getSheet`'s unmodified callers** — omitted `handleUpdateShipment`'s `getSheet('sh')` call. **Fixed:** added to the list; no functional impact, it also passes one argument so defaults exactly as before.
4. **§2.4 said "five" `sGet()` call sites; the real function has four.** **Fixed:** corrected to "four," with the exact four cited (confirmed complete by grep, no others exist in `pullAll()`).

One informational note, not a finding: the reviewer flagged that `/home/user/getstackdops` (a path it was told to also check) is a stale, unrelated shallow clone with none of this project's `docs/`/`apps-script/`/`tests/` — it correctly used `/workspace/stackd-ops` instead, which is this repo's real, current checkout. No action needed.

Proceeding to implementation.
