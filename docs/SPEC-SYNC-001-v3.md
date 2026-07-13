# SPEC-SYNC-001-v3: Fix pullAll() field-mapping and identity loss

**Supersedes:** SPEC-SYNC-001-v2
**Implements:** REQ-SYNC-001-v2 (requirements-gate PASS)

## Correction from v2 (spec-gate FAIL)

v2's inv/po merge blocks implemented only a **hardcoded allowlist** (`lineItems`, `pos`, 5 named `calc_*` fields for `inv`; `lineItems` for `po`) instead of REQ-SYNC-001-v2's general rule that *any* untracked field survives verbatim. Spec-gate confirmed this would silently drop `inv.type` (`'invoice'`/`'credit_note'`/`'goodwill_credit'`, not present in `FIELD_MAPS.inv`, used pervasively throughout the app) on every matched pull — a financial-document misclassification bug.

**Fix: genericize the merge instead of enumerating fields.** For a matched record, start from a **shallow copy of the local record** (so every field the local record already has — tracked or not — survives by default), then overlay only the keys `unmapRec()` actually produced (i.e. only `FIELD_MAPS`-tracked fields take the Sheets-sourced value). This makes the "untracked fields survive verbatim" rule automatic and exhaustive, rather than a maintained list that can silently miss a field (as it just did for `inv.type`).

This also **simplifies** the previous `lineItems`/`pos`/`priceHistory`/`invoiceRefs` special-casing entirely away: none of those four fields are in any entity's `FIELD_MAPS`, so under the shallow-copy-then-overlay pattern they survive automatically, with no per-field code needed. The one remaining special rule is the pre-existing "don't let a stale/zero pulled `calc_*` value clobber a real local one" business rule (`SEC-GAP-011`-adjacent), which still needs an explicit guard since those specific `calc_*` fields **are** tracked in `FIELD_MAPS.inv` and would otherwise take whatever (possibly zero/stale) value the Sheet has.

## 1. New helper: `unmapRec(entity, sheetRec)`

Unchanged from v2 (already spec-gate-verified correct — strictly the inverse of `mapRec()`, only `FIELD_MAPS`-tracked keys ever appear on the output, closing the live-Sheet-header leak):

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

## 2. Business-key merge helper

Unchanged from v2 (already spec-gate-verified — every branch guards against a blank key spuriously matching):

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

## 3. New helper: `mergePulledWithLocal(pulledMapped, localMatch, zeroClobberGuardFields)`

```js
function mergePulledWithLocal(pulledMapped, localMatch, zeroClobberGuardFields) {
  if (!localMatch) return pulledMapped; // genuinely new — only what the Sheet actually provided
  var merged = Object.assign({}, localMatch, pulledMapped); // untracked fields (incl. id) survive from local; tracked fields take pulled values
  merged.id = localMatch.id; // defensive — pulledMapped never contains `id` for these entities, but explicit beats implicit
  (zeroClobberGuardFields || []).forEach(function(f) {
    if ((+merged[f] || 0) === 0 && (+localMatch[f] || 0) > 0) merged[f] = localMatch[f];
  });
  return merged;
}
```

This single helper replaces v2's per-entity `lineItems`/`pos`/`priceHistory`/`invoiceRefs` special-casing entirely. `zeroClobberGuardFields` is only non-empty for `inv` (see below) — every other entity calls this with no third argument.

**Consequence: `isEmptyLI()` (`index.html:3311-3330`) becomes dead code.** Confirmed by grep — its only three call sites are the v2-superseded `lineItems`/`pos` special-casing in the invoice and PO blocks (`index.html:3349`, `3351`, `3383`), all removed by this design. Recommend deleting `isEmptyLI()` in the same change rather than leaving unused code behind.

## 4. `pullAll()` changes (`index.html:3331-3416`)

**Invoices block (`3336-3361`)**:
```js
try {
  var dInv = await sGet('inv');
  if (dInv.status === 'ok' && dInv.records && dInv.records.length) {
    var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
    var calcZeroGuard = ['calc_grandTotal','calc_cogs','calc_netProfit','calc_margin','calc_balanceDue']; // the calc_* fields FIELD_MAPS.inv actually tracks
    var mergedInv = invPulled.map(function(p) {
      var local = findLocalMatchByBizKey('inv', DB.inv, p);
      var m = mergePulledWithLocal(p, local, calcZeroGuard);
      if (!local) m.id = uid();
      return m;
    });
    var invMergedNums = {};
    mergedInv.forEach(function(m){ if (m.num) invMergedNums[m.num] = true; });
    var invLocalOnly = DB.inv.filter(function(r){ return !invMergedNums[r.num]; });
    DB.inv = mergedInv.concat(invLocalOnly);
  }
} catch(e) { failed.push('inv'); console.warn('[Stackd] pullAll: inv failed —', e.message); }
```
`calc_liTotal`, `calc_taxAmt`, `calc_grossProfit`, and `type` are **not** in `FIELD_MAPS.inv` — confirmed at `index.html:3242` — so they now survive automatically via the shallow-copy in `mergePulledWithLocal()`, with no special-case code, closing the exact gap spec-gate found.

**Credit notes block (`3363-3371`)**:
```js
try {
  var dCn = await sGet('cn');
  if (dCn.status === 'ok' && dCn.records && dCn.records.length) {
    var cnPulled = dCn.records.map(function(r){ return unmapRec('cn', r); });
    var mergedCn = cnPulled.map(function(p) {
      var local = DB.inv.find(function(r){ return p.num && r.num === p.num; });
      var m = mergePulledWithLocal(p, local);
      if (!local) m.id = uid();
      return m;
    });
    var cnMergedNums = {};
    mergedCn.forEach(function(m){ if (m.num) cnMergedNums[m.num] = true; });
    DB.inv = DB.inv.filter(function(r){
      var isCnType = r.type === 'credit_note' || r.type === 'goodwill_credit';
      return !(isCnType && cnMergedNums[r.num]);
    }).concat(mergedCn);
  }
} catch(e) { failed.push('cn'); console.warn('[Stackd] pullAll: cn failed —', e.message); }
```
(`FIELD_MAPS.cn` — unlike `FIELD_MAPS.inv` — does track `type:'Type'`, so no zero-clobber guard is needed here; `type` for CN records is intentionally Sheets-sourced.)

**Purchase orders block (`3373-3388`)**:
```js
try {
  var dPo = await sGet('po');
  if (dPo.status === 'ok' && dPo.records && dPo.records.length) {
    var poPulled = dPo.records.map(function(r){ return unmapRec('po', r); });
    var mergedPo = poPulled.map(function(p) {
      var local = findLocalMatchByBizKey('po', DB.po, p);
      var m = mergePulledWithLocal(p, local);
      if (!local) m.id = uid();
      return m;
    });
    var poMergedNums = {};
    mergedPo.forEach(function(m){ if (m.num) poMergedNums[m.num] = true; });
    var poLocalOnly = DB.po.filter(function(r){ return !poMergedNums[r.num]; });
    DB.po = mergedPo.concat(poLocalOnly);
  }
} catch(e) { failed.push('po'); console.warn('[Stackd] pullAll: po failed —', e.message); }
```

**`simpleEnts` block (`3390-3403`)**:
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
        var merged = pulled.map(function(p) {
          var local = findLocalMatchByBizKey(eKey, localArr, p);
          var m = mergePulledWithLocal(p, local);
          if (local) matchedLocalIds[local.id] = true; else m.id = uid();
          return m;
        });
        var localOnly = localArr.filter(function(r){ return !matchedLocalIds[r.id]; });
        DB[dbKey] = merged.concat(localOnly);
      }
    }
  } catch(e) { failed.push(eKey); console.warn('[Stackd] pullAll: ' + eKey + ' failed —', e.message); }
}
```
No entity-specific branching needed inside this loop anymore — `li.priceHistory`/`li.invoiceRefs` survive automatically via `mergePulledWithLocal()`'s shallow copy, same as every other untracked field on `sh`/`qt`. The v2 `if (eKey === 'li')` guard is no longer needed and is removed.

## 5. Explicitly untouched

`mapRec()`, `syncAll()`, `Code.gs` — unchanged, per REQ-SYNC-004.

## 6. Tests (`tests/run.js`)

Same test-harness note as v2: `tests/run.js:56`'s `fetch` mock is a single static stub with no entity/action dispatch — new scaffolding (a dispatching mock keyed on `payload.entity`/`.action`, configurable per test) is required, not reused from an existing pattern.

New suite `pullAll field-mapping (SYNC-GAP-001 fix)`:
- `unmapRec('li', {...})` → correct internal keys only (AC-001).
- `unmapRec` on a fully-blank header-keyed record → all fields empty, no stray keys (AC-005 groundwork).
- `mergePulledWithLocal()` unit tests: untracked field (e.g. a synthetic `inv.type`-shaped test, and `li.priceHistory`) survives from local when matched; tracked field takes pulled value; `zeroClobberGuardFields` reverts a pulled-zero to local's non-zero value; no local match → returns `pulledMapped` untouched.
- `findLocalMatchByBizKey` unit tests per entity (sku/desc+supId/ref/num), blank-key-never-matches guard.
- Integration (via new fetch-mock scaffolding): simulated `li` pull matching by `sku` → local `id`/`priceHistory`/`invoiceRefs` preserved, `desc`/`cost`/`price` adopt pulled values (AC-002).
- Simulated `inv` pull matching by `num` → local `id`/`lineItems`/`calc_liTotal`/`calc_taxAmt`/`calc_grossProfit`/**`type`** all preserved (new, explicit AC covering the exact field spec-gate flagged), tracked `calc_*` fields adopt pulled values unless the zero-clobber guard applies (AC-003).
- Simulated `po` pull, same pattern minus the `type`/`calc_*` specifics (AC-003).
- Simulated pull with no local match → fresh `uid()`, merges as new (AC-004).
- Regression: corrupted-backup shape (header-keyed, all-blank) → no spurious match, no stray keys (AC-005).
- `sup`/`payments`/`co` still merge by `.id` correctly (AC-006, regression).
- `cn` pull matching by `num`, only replacing matched CN-type records, `type` correctly Sheets-sourced (tracked for `cn`, unlike `inv`).
- No push-direction test changes (AC-007).

## Changelog

- v3: Replaced the hardcoded per-entity field allowlist (which spec-gate found silently dropped `inv.type`) with a generic `mergePulledWithLocal()` shallow-copy-then-overlay helper, making "untracked fields survive verbatim" automatic and exhaustive instead of a maintained list. This also let `lineItems`/`pos`/`priceHistory`/`invoiceRefs` special-casing be removed entirely (now automatic), and made `isEmptyLI()` dead code (recommended for deletion in the same change). Added an explicit AC covering `inv.type` survival.
- v2: Fixed `unmapRec()` leak, added concrete `cn` block, consolidated `li` splice, corrected test-mock claim.
- v1: Initial spec (superseded).
