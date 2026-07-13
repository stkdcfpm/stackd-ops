# SPEC-SYNC-001-v1: Fix pullAll() field-mapping and identity loss

**Implements:** REQ-SYNC-001-v2 (requirements-gate PASS)

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
  // Carry forward any field NOT in FIELD_MAPS (e.g. `num`, already correctly named by backfillRefNums()/Code.gs pass-through)
  Object.keys(sheetRec).forEach(function(k) {
    var alreadyMapped = Object.keys(map).some(function(ik){ return map[ik] === k; });
    if (!alreadyMapped) out[k] = sheetRec[k];
  });
  return out;
}
```

`num` is not in any `FIELD_MAPS` entry and is written/read as a plain column named `num` by neither push nor pull today — confirmed `HEADERS` in `Code.gs:28-37` has no `num` column at all, so `num` is never actually synced to Sheets currently. (This is a pre-existing, separate gap — Suppliers/Line Items/etc.'s friendly reference numbers are not part of the Sheets round-trip. Out of scope for this SPEC; noted so the "carry forward unmapped fields" behavior above doesn't appear to silently fix it — it doesn't, since `num` was never in `sheetRec` to begin with.)

## 2. Business-key merge helper

Add near `pullAll()`:

```js
function findLocalMatchByBizKey(entity, localArr, pulledRec) {
  if (entity === 'li') {
    if (pulledRec.sku) return localArr.find(function(l){ return l.sku === pulledRec.sku; });
    return localArr.find(function(l){ return (l.desc||'').toLowerCase() === (pulledRec.desc||'').toLowerCase() && l.supId === pulledRec.supId; });
  }
  if (entity === 'sh') return localArr.find(function(s){ return s.ref && s.ref === pulledRec.ref; });
  // inv, cn, po, qt all use `num`
  return localArr.find(function(r){ return pulledRec.num && r.num === pulledRec.num; });
}
```

Every branch is guarded against a blank business key spuriously matching a blank local field (REQ-SYNC-001-v2 AC-005): `sku`/`num` paths require the pulled record's key to be truthy before comparing; the `desc`+`supId` fallback for `li` inherits this from `unmapRec()` never producing a match against an empty local `desc` unless the pulled `desc` is also that exact (non-empty in practice, since `desc` is a required field per `vLI()`) string.

## 3. `pullAll()` changes (`index.html:3331-3416`)

**Invoices block (`3336-3361`)**:
```js
var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
var invLocalOnly = DB.inv.filter(function(r){ return !invPulled.some(function(p){ return p.num && r.num === p.num; }); });
var calcFields = [...]; // unchanged
for (var ii = 0; ii < invPulled.length; ii++) {
  var invLocal = findLocalMatchByBizKey('inv', DB.inv, invPulled[ii]);
  if (invLocal) {
    invPulled[ii].id = invLocal.id; // preserve local id — Sheets never carries it (no `id` in FIELD_MAPS.inv)
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
DB.inv = invPulled.concat(invLocalOnly);
```
This is the fix for the gate's flagged inner-`.find()` issue: `invLocal` lookup now goes through `findLocalMatchByBizKey('inv', ...)` (which matches on `num`), not `r.id === invPulled[ii].id`.

**Credit notes block (`3363-3371`)**: same pattern — `unmapRec('cn', r)` applied to each of `dCn.records`, matched by `num` against `DB.inv` (cn records live in `DB.inv`), preserving local `id` on match / assigning `uid()` on new.

**Purchase orders block (`3373-3388`)**: identical structure to Invoices — `unmapRec('po', r)`, `findLocalMatchByBizKey('po', DB.po, ...)` (matches on `num`), preserve/assign `id`, then the existing `lineItems` preservation (`3383-3384`) runs off the correctly-found `poLocal`.

**`simpleEnts` block (`3390-3403`)**: split into two cases since `sup`/`payments`/`co` merge by `id` (already correct once reverse-mapped) while `li`/`sh`/`qt` need business-key merge:

```js
var idKeyedEnts = ['sup', 'payments', 'co'];
var bizKeyedEnts = ['li', 'sh', 'qt'];

idKeyedEnts.concat(bizKeyedEnts).forEach(function(eKey) { /* iterate as before, sGet(eKey) */ });
```
Concretely, replace the single loop body (`3392-3402`) with:
```js
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
        pulled.forEach(function(p) {
          var match = findLocalMatchByBizKey(eKey, localArr, p);
          p.id = match ? match.id : uid();
        });
        var pulledKeys = {}; // track which local records got matched, to exclude them from "local only"
        pulled.forEach(function(p) {
          var match = findLocalMatchByBizKey(eKey, localArr, p);
          if (match) pulledKeys[match.id] = true;
        });
        var localOnly = localArr.filter(function(r){ return !pulledKeys[r.id]; });
        DB[dbKey] = pulled.concat(localOnly);
      }
    }
  } catch(e) { failed.push(eKey); console.warn('[Stackd] pullAll: ' + eKey + ' failed —', e.message); }
}
```
(`simpleEnts` array itself, line `3391`, is unchanged — still `['sup', 'li', 'payments', 'sh', 'qt', 'co']`; only the loop body's merge strategy branches on `idKeyedEnts`/`bizKeyedEnts` membership.)

**General merge rule (untracked fields survive)**: automatically satisfied by construction — `unmapRec()` only ever sets keys present in `FIELD_MAPS[entity]` (plus any already-correctly-named passthrough field like `num`), so it never overwrites or clears an untracked local field like `li.priceHistory`/`li.invoiceRefs`, because those simply never appear in `pulled[si]` at all; they only exist on `match` (the local record), which is discarded in favor of `pulled[si]` for matched entities **except** where explicitly copied over (as `inv`/`po` already do for `lineItems`/`pos`/`calc_*`). This SPEC extends that same explicit-copy pattern to `li.priceHistory` and `li.invoiceRefs`, since those are load-bearing (quote-versioning and library-sync history) and must not silently vanish on a Pull:

```js
// inside the li bizKeyedEnts branch, after finding `match`:
if (match) {
  if (match.priceHistory) p.priceHistory = match.priceHistory;
  if (match.invoiceRefs) p.invoiceRefs = match.invoiceRefs;
}
```

## 4. Explicitly untouched

`mapRec()`, `syncAll()`, `Code.gs` (`handleBulkUpsert`, `handleUpsert`, `handlePullEntity`, `HEADERS`, `BIZ_KEYS`, `FIELD_MAPS`-equivalent) — no push-side or Apps Script changes, per REQ-SYNC-004.

## 5. Tests (`tests/run.js`)

New suite `pullAll field-mapping (SYNC-GAP-001 fix)`:
- `unmapRec('li', {...header keys...})` → correct internal keys (AC-001).
- `unmapRec` on a fully-blank header-keyed record → all internal fields empty, no crash.
- Simulated `sGet()` response (mock `sPost`/`fetch` already established pattern in `tests/run.js`) for `li` matching an existing local Line Item by `sku` → local `id`/`priceHistory`/`invoiceRefs` preserved, `desc`/`cost`/`price` adopt pulled values (AC-002).
- Simulated pull for `inv` matching by `num` → local `id`/`lineItems`/`calc_*` preserved via existing preservation logic, now correctly triggered (AC-003).
- Simulated pull for `po`, same pattern (AC-003).
- Simulated pull with no local match (new `sku`/`num`/`ref`) → fresh `uid()` assigned, merges as new (AC-004).
- Regression using the actual corrupted-backup shape (header-keyed, all-blank, e.g. `{'Supplier ID':'','Name':'',...}`) → after `unmapRec`, does not match any populated local Supplier (AC-005).
- `sup`/`payments`/`co` still merge by `.id` correctly post-`unmapRec()` (AC-006, regression).
- No existing push-direction (`mapRec`/`syncAll`) test assertions change (AC-007).

## Changelog

- v1: Initial spec, translating REQ-SYNC-001-v2 into concrete `pullAll()`/`unmapRec()`/`findLocalMatchByBizKey()` changes, extending the existing `inv`/`po` field-preservation pattern to `li.priceHistory`/`li.invoiceRefs`.
