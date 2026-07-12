# SPEC-SYNC-001-v2: Fix pullAll() field-mapping and identity loss

**Supersedes:** SPEC-SYNC-001-v1
**Implements:** REQ-SYNC-001-v2 (requirements-gate PASS)

## Corrections from v1 (spec-gate FAIL)

1. **`unmapRec()`'s "carry forward unmapped fields" behavior removed entirely.** Spec-gate found `handlePullEntity()` (`Code.gs:263`) builds `rec` keys from the Sheet's *live* header row (`data[0]`), not the fixed `HEADERS` constant — so any stray/manually-added column in the actual spreadsheet (e.g. an operator typing "Internal Notes" as a header) would leak through v1's carry-forward loop verbatim onto the internal DB record under that exact literal string as a key. v1's stated justification (about `num`) doesn't address this general case. Fix: `unmapRec()` now **only** ever sets keys explicitly present in `FIELD_MAPS[entity]` — nothing carried forward, full stop. Nothing legitimate depended on the carry-forward (confirmed `num` is not in `HEADERS`/`FIELD_MAPS` at all today, so it was never actually reaching `sheetRec` in the first place).
2. **Concrete `cn` block rewrite added** (v1 only said "same pattern as inv/po" — the actual current code has a different shape: single `.id`-keyed filter/concat with no preservation loop, and `cn` records live inside `DB.inv`, not a separate array). See section 3.
3. **`priceHistory`/`invoiceRefs` preservation now spliced into a single, explicit loop location with an `eKey === 'li'` guard** (v1's two-pass loop left it ambiguous which pass it belonged in, and unguarded it would have silently run for `sh`/`qt` too). See section 3.
4. **Section 5 no longer claims existing test-mock infrastructure supports this.** Spec-gate confirmed `tests/run.js:56`'s `fetch` mock is a single static stub (`{"status":"ok","records":[]}` for every call, no entity/action dispatch) — new scaffolding is required and is now described explicitly.

## 1. New helper: `unmapRec(entity, sheetRec)`

Add next to `mapRec()` (`index.html:3250-3262`):

```js
function unmapRec(entity, sheetRec) {
  var map = FIELD_MAPS[entity];
  if (!map || !sheetRec) return sheetRec;
  var out = {};
  Object.keys(map).forEach(function(internalKey) {
    var headerKey = map[internalKey];
    if (Object.prototype.hasOwnProperty.call(sheetRec, headerKey)) out[internalKey] = sheetRec[headerKey];
  });
  return out;
}
```

Strictly the inverse of `mapRec()` — only fields declared in `FIELD_MAPS[entity]` ever appear on the output. Any other column in the live Sheet (stray operator-added columns, or the currently-unsynced `num`) is dropped, not leaked through.

## 2. Business-key merge helper

```js
function findLocalMatchByBizKey(entity, localArr, pulledRec) {
  if (entity === 'li') {
    if (pulledRec.sku) return localArr.find(function(l){ return l.sku === pulledRec.sku; });
    return localArr.find(function(l){ return pulledRec.desc && l.desc && l.desc.toLowerCase() === pulledRec.desc.toLowerCase() && l.supId === pulledRec.supId; });
  }
  if (entity === 'sh') return localArr.find(function(s){ return s.ref && s.ref === pulledRec.ref; });
  return localArr.find(function(r){ return pulledRec.num && r.num === pulledRec.num; }); // inv, cn, po, qt
}
```
Every branch requires the pulled record's key field to be truthy before comparing — a blank pulled `sku`/`ref`/`num`/`desc` never matches a populated or blank local field (REQ-SYNC-001-v2 AC-005).

## 3. `pullAll()` changes (`index.html:3331-3416`)

**Invoices block (`3336-3361`)**:
```js
try {
  var dInv = await sGet('inv');
  if (dInv.status === 'ok' && dInv.records && dInv.records.length) {
    var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
    var calcFields = ['calc_grandTotal','calc_cogs','calc_liTotal','calc_taxAmt',
                      'calc_grossProfit','calc_netProfit','calc_margin','calc_balanceDue'];
    for (var ii = 0; ii < invPulled.length; ii++) {
      var invLocal = findLocalMatchByBizKey('inv', DB.inv, invPulled[ii]);
      if (invLocal) {
        invPulled[ii].id = invLocal.id; // preserve local id — Sheets carries no id for inv (not in FIELD_MAPS.inv)
        if (isEmptyLI(invPulled[ii].lineItems, 'inv') && !isEmptyLI(invLocal.lineItems, 'inv'))
          invPulled[ii].lineItems = invLocal.lineItems;
        if (isEmptyLI(invPulled[ii].pos, 'pos') && !isEmptyLI(invLocal.pos, 'pos'))
          invPulled[ii].pos = invLocal.pos;
        calcFields.forEach(function(f) {
          if ((+invPulled[ii][f] || 0) === 0 && (+invLocal[f] || 0) > 0)
            invPulled[ii][f] = invLocal[f];
        });
      } else {
        invPulled[ii].id = uid();
      }
    }
    var invPulledNums = {};
    invPulled.forEach(function(p){ if (p.num) invPulledNums[p.num] = true; });
    var invLocalOnly = DB.inv.filter(function(r){ return !invPulledNums[r.num]; });
    DB.inv = invPulled.concat(invLocalOnly);
  }
} catch(e) { failed.push('inv'); console.warn('[Stackd] pullAll: inv failed —', e.message); }
```

**Credit notes block (`3363-3371`) — concrete rewrite (v2, was prose-only in v1)**:
```js
try {
  var dCn = await sGet('cn');
  if (dCn.status === 'ok' && dCn.records && dCn.records.length) {
    var cnPulled = dCn.records.map(function(r){ return unmapRec('cn', r); });
    cnPulled.forEach(function(c) {
      var cnLocal = DB.inv.find(function(r){ return c.num && r.num === c.num; });
      c.id = cnLocal ? cnLocal.id : uid();
    });
    var cnPulledNums = {};
    cnPulled.forEach(function(c){ if (c.num) cnPulledNums[c.num] = true; });
    // Only replace local CN/goodwill-credit records whose num was actually re-pulled;
    // ordinary invoices never match this filter (they aren't credit_note/goodwill_credit type).
    DB.inv = DB.inv.filter(function(r){
      var isCnType = r.type === 'credit_note' || r.type === 'goodwill_credit';
      return !(isCnType && cnPulledNums[r.num]);
    }).concat(cnPulled);
  }
} catch(e) { failed.push('cn'); console.warn('[Stackd] pullAll: cn failed —', e.message); }
```

**Purchase orders block (`3373-3388`)** — identical structure to Invoices:
```js
try {
  var dPo = await sGet('po');
  if (dPo.status === 'ok' && dPo.records && dPo.records.length) {
    var poPulled = dPo.records.map(function(r){ return unmapRec('po', r); });
    for (var pi = 0; pi < poPulled.length; pi++) {
      var poLocal = findLocalMatchByBizKey('po', DB.po, poPulled[pi]);
      if (poLocal) {
        poPulled[pi].id = poLocal.id;
        if (isEmptyLI(poPulled[pi].lineItems, 'po') && !isEmptyLI(poLocal.lineItems, 'po'))
          poPulled[pi].lineItems = poLocal.lineItems;
      } else {
        poPulled[pi].id = uid();
      }
    }
    var poPulledNums = {};
    poPulled.forEach(function(p){ if (p.num) poPulledNums[p.num] = true; });
    var poLocalOnly = DB.po.filter(function(r){ return !poPulledNums[r.num]; });
    DB.po = poPulled.concat(poLocalOnly);
  }
} catch(e) { failed.push('po'); console.warn('[Stackd] pullAll: po failed —', e.message); }
```

**`simpleEnts` block (`3390-3403`)** — single consolidated loop, `sup`/`payments`/`co` keep the existing `.id`-based path unchanged, `li`/`sh`/`qt` use the business-key path with an explicit, guarded splice point for `li`'s untracked fields:
```js
var idKeyedEnts = ['sup', 'payments', 'co'];
for (var ei = 0; ei < simpleEnts.length; ei++) {
  var eKey = simpleEnts[ei];
  var dbKey = eKey === 'co' ? 'con' : eKey;
  try {
    var sd = await sGet(eKey);
    if (sd.status === 'ok' && sd.records && sd.records.length) {
      var pulled = sd.records.map(function(r){ return unmapRec(eKey, r); });
      if (idKeyedEnts.indexOf(eKey) > -1) {
        var sPulledIds = {};
        for (var si = 0; si < pulled.length; si++) sPulledIds[pulled[si].id] = true;
        DB[dbKey] = pulled.concat(DB[dbKey].filter(function(r){ return !sPulledIds[r.id]; }));
      } else {
        var localArr = DB[dbKey];
        var matchedLocalIds = {};
        pulled.forEach(function(p) {
          var match = findLocalMatchByBizKey(eKey, localArr, p);
          if (match) {
            p.id = match.id;
            matchedLocalIds[match.id] = true;
            if (eKey === 'li') { // untracked fields not in FIELD_MAPS.li — must survive the merge explicitly
              if (match.priceHistory) p.priceHistory = match.priceHistory;
              if (match.invoiceRefs)  p.invoiceRefs  = match.invoiceRefs;
            }
          } else {
            p.id = uid();
          }
        });
        var localOnly = localArr.filter(function(r){ return !matchedLocalIds[r.id]; });
        DB[dbKey] = pulled.concat(localOnly);
      }
    }
  } catch(e) { failed.push(eKey); console.warn('[Stackd] pullAll: ' + eKey + ' failed —', e.message); }
}
```
Single `forEach` pass (not the two-pass v1 draft) — `matchedLocalIds` is built in the same pass that assigns `p.id`, eliminating the ambiguity spec-gate flagged. The `if (eKey === 'li')` guard makes explicit that this splice point only fires for Line Items; `sh`/`qt` pass through this same loop body unaffected (no `priceHistory`/`invoiceRefs` fields exist on those entities regardless).

## 4. Explicitly untouched

`mapRec()`, `syncAll()`, `Code.gs` (`handleBulkUpsert`, `handleUpsert`, `handlePullEntity`, `HEADERS`, `BIZ_KEYS`) — no push-side or Apps Script changes, per REQ-SYNC-004.

## 5. Tests (`tests/run.js`) — new scaffolding required (corrected from v1)

`tests/run.js:56`'s `fetch` mock is a single static stub returning `{"status":"ok","records":[]}` for every call, with no dispatch on `payload.entity`/`payload.action`. Testing `pullAll()`'s new merge logic requires either:
- **(a)** replacing the module-level `ctx.fetch` mock with a dispatching version that inspects `JSON.parse(options.body).entity`/`.action` and returns a per-test-configured response (a `let _mockPullResponses = {}` map, set per-test, read by the mock, reset after each test) — the more general, reusable option; or
- **(b)** testing `unmapRec()`, `findLocalMatchByBizKey()`, and the merge-assignment logic as pure functions directly (no `fetch` involved at all), and separately testing `pullAll()`'s end-to-end wiring with a single swapped-in `ctx.fetch` for one or two integration-style tests.

This SPEC adopts **(a)**, since it is reusable for every AC below without per-test mock duplication, and is a one-time, contained addition to the test harness (not a change to `index.html`).

New suite `pullAll field-mapping (SYNC-GAP-001 fix)`:
- `unmapRec('li', {...header keys...})` → correct internal keys, no header-named keys remain (AC-001).
- `unmapRec` on a fully-blank header-keyed record → all internal fields empty string, no crash, no stray keys carried through (AC-005 groundwork).
- `findLocalMatchByBizKey` unit tests for each entity's key logic (sku/desc+supId/ref/num), including the blank-key-never-matches guard.
- Using mock (a): simulated `pullAll()` Sheets response for `li` matching an existing local Line Item by `sku` → local `id`/`priceHistory`/`invoiceRefs` preserved, `desc`/`cost`/`price` adopt pulled values (AC-002).
- Simulated `inv` pull matching by `num` → local `id`/`lineItems`/`calc_*` preserved via the existing preservation logic, now correctly triggered (AC-003).
- Simulated `po` pull, same pattern (AC-003).
- Simulated pull with no local match (new `sku`/`num`/`ref`) → fresh `uid()` assigned, merges as new (AC-004).
- Regression using the actual corrupted-backup shape (header-keyed, all-blank) → after `unmapRec`, does not match any populated local Supplier by business key, and (new in v2) does not carry through any stray key (AC-005).
- `sup`/`payments`/`co` still merge by `.id` correctly post-`unmapRec()` (AC-006, regression).
- `cn` pull matching by `num` against `DB.inv`, preserving local `id`, only replacing matched CN-type records (new in v2, closes the v1 gap).
- No existing push-direction (`mapRec`/`syncAll`) test assertions change (AC-007).

## Changelog

- v2: Removed `unmapRec()`'s unmapped-field carry-forward entirely (closed the live-Sheet-header leak spec-gate found); added a concrete `cn` block rewrite; consolidated the `simpleEnts` merge into one guarded pass instead of two ambiguous ones; corrected section 5 to describe the new `fetch`-mock scaffolding required instead of claiming it already exists.
- v1: Initial spec (superseded — cn block was prose-only, priceHistory splice point ambiguous, unmapRec leak risk, test-mock claim inaccurate).
