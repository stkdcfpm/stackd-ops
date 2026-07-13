# SPEC-SYNC-001-v5: Fix pullAll() field-mapping and identity loss

**Supersedes:** SPEC-SYNC-001-v4
**Implements:** REQ-SYNC-001-v2 (requirements-gate PASS)

## Correction from v4 (schema-migration-reviewer FAIL — CRITICAL)

**Duplicate business-key collision within a single pull, unaddressed in all four prior rounds.** If two Sheets rows share the same business key (e.g. two rows with an identical `sku` — an operator-error case, not hypothetical), `findLocalMatchByBizKey()` returns the **same** local record for both. Each independently goes through `mergePulledWithLocal()`, which unconditionally sets `merged.id = localMatch.id` — so both merged records end up in `DB.li`/`DB.sh`/`DB.qt`/etc carrying the **same real local `id`**, a duplicate-id pair written straight to `localStorage` on the next `saveAll()`, no undo path. Any code doing `.find(r => r.id === x)` afterward (edit modals, `liId`/`supId` references, delete-by-id) silently operates on whichever duplicate comes first; the other is an orphaned zombie sharing an identity it doesn't own.

**Also flagged**: this is a *worse* failure mode than what existed pre-fix, not a carryover — before this fix, these entities' pulled rows never carried a real `.id` at all, so a duplicate business key just produced harmless extra ghost rows with no identity collision. Logging this explicitly rather than letting it pass silently.

**Fix: claim-once semantics within a single pull.** Process each `simpleEnts`/`inv`/`po`/`cn` pulled array sequentially (not via independent per-record lookups), tracking which local ids have already been claimed by an earlier pulled record in the *same* pull. A pulled record whose matched local id was already claimed by a prior pulled record in this pull is treated as **unmatched** — same as if no local record existed — so it gets its own fresh identity instead of colliding with an already-claimed one.

## 1–3. Unchanged from v3/v4

`unmapRec()`, `mergePulledWithLocal()` unchanged. `findLocalMatchByBizKey()` unchanged (the claim-once logic wraps its result, not its internals).

## New helper: `claimOnceMatcher()`

```js
function claimOnceMatcher() {
  var claimed = {};
  return function(candidate) {
    if (!candidate || claimed[candidate.id]) return null; // no match, or already claimed by an earlier pulled record in this same pull
    claimed[candidate.id] = true;
    return candidate;
  };
}
```

One fresh `claimOnceMatcher()` instance per entity per pull (not shared across entities or across pulls) — scoped identically to how `matchedLocalIds`/`sPulledIds` were already scoped per-entity in prior spec rounds.

## 4. `pullAll()` changes (`index.html:3331-3416`)

**Invoices block** — wrap the existing `findLocalMatchByBizKey` call:
```js
try {
  var dInv = await sGet('inv');
  if (dInv.status === 'ok' && dInv.records && dInv.records.length) {
    var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
    var calcZeroGuard = ['calc_grandTotal','calc_cogs','calc_netProfit','calc_margin','calc_balanceDue'];
    var invClaim = claimOnceMatcher();
    var mergedInv = invPulled.map(function(p) {
      var candidate = findLocalMatchByBizKey('inv', DB.inv, p);
      var local = invClaim(candidate);
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
A second Sheets invoice row with a duplicate `num` (itself already prevented at save-time by `vInv()`'s uniqueness check, `index.html:6101-6102`, but not guaranteed for Sheets-side data an operator could hand-edit) now gets its own fresh `id` instead of colliding with the first row's matched local record.

**Credit notes block** — same wrapping:
```js
try {
  var dCn = await sGet('cn');
  if (dCn.status === 'ok' && dCn.records && dCn.records.length) {
    var cnPulled = dCn.records.map(function(r){ return unmapRec('cn', r); });
    var cnClaim = claimOnceMatcher();
    var mergedCn = cnPulled.map(function(p) {
      var candidate = DB.inv.find(function(r){ return p.num && r.num === p.num; });
      var local = cnClaim(candidate);
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

**Purchase orders block** — same wrapping:
```js
try {
  var dPo = await sGet('po');
  if (dPo.status === 'ok' && dPo.records && dPo.records.length) {
    var poPulled = dPo.records.map(function(r){ return unmapRec('po', r); });
    var poClaim = claimOnceMatcher();
    var mergedPo = poPulled.map(function(p) {
      var candidate = findLocalMatchByBizKey('po', DB.po, p);
      var local = poClaim(candidate);
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

**`simpleEnts` block** — same wrapping, applied uniformly to both id-keyed and business-keyed entities (id-keyed entities get the same protection in case a Sheet ever has an accidental duplicate id-column value from manual editing):
```js
var idKeyedEnts = ['sup', 'payments', 'co'];
for (var ei = 0; ei < simpleEnts.length; ei++) {
  var eKey = simpleEnts[ei];
  var dbKey = eKey === 'co' ? 'con' : eKey;
  try {
    var sd = await sGet(eKey);
    if (sd.status === 'ok' && sd.records && sd.records.length) {
      var pulled = sd.records.map(function(r){ return unmapRec(eKey, r); });
      var localArr = DB[dbKey];
      var claim = claimOnceMatcher();
      var matchedLocalIds = {};
      var merged = pulled.map(function(p) {
        var candidate = idKeyedEnts.indexOf(eKey) > -1
          ? localArr.find(function(r){ return r.id === p.id; })
          : findLocalMatchByBizKey(eKey, localArr, p);
        var local = claim(candidate);
        var m = mergePulledWithLocal(p, local);
        if (local) {
          matchedLocalIds[local.id] = true;
        } else if (idKeyedEnts.indexOf(eKey) === -1) {
          m.id = uid(); // business-keyed, genuinely unmatched (either no local record, or its match was already claimed this pull)
        }
        return m;
      });
      var localOnly = localArr.filter(function(r){ return !matchedLocalIds[r.id]; });
      DB[dbKey] = merged.concat(localOnly);
    }
  } catch(e) { failed.push(eKey); console.warn('[Stackd] pullAll: ' + eKey + ' failed —', e.message); }
}
```
Note: for an id-keyed entity, if `claim()` rejects an already-claimed candidate, `local` is `null` and the `else if` is false (since `idKeyedEnts.indexOf(eKey) === -1` is false for these), so `m.id` stays whatever `p.id` already was (the Sheets-provided id) — meaning a genuine duplicate-id row in the Sheet for `sup`/`payments`/`co` produces two merged records sharing that Sheets-provided id. This is a pre-existing possibility independent of this fix (a Sheet with two rows sharing an ID column value was already just as broken before), not newly introduced — the claim-once guard only prevents *this fix's own* business-key matching from creating new collisions; it cannot manufacture identity for data that's already ambiguous at the source for id-keyed entities. Logged as a residual risk below, not blocking.

## 5. Explicitly untouched

`mapRec()`, `syncAll()`, `Code.gs` — unchanged, per REQ-SYNC-004.

## 6. Tests (`tests/run.js`)

Same as v4, plus:
- **New (closes the schema-migration-reviewer CRITICAL)**: two pulled Sheets `li` rows sharing an identical `sku`, both matching the same existing local Line Item — the first pulled row correctly claims and merges with the local record (preserving its `id`/`priceHistory`/`invoiceRefs`); the second pulled row gets a **fresh `uid()`**, not the same local `id` — assert the two merged records in `DB.li` have different `id`s.
- Same duplicate-key test repeated for `sh` (duplicate `ref`) and `inv`/`po`/`cn`/`qt` (duplicate `num`).
- Regression: a Sheets pull with no duplicate keys behaves identically to v4's already-verified behavior (claim-once is a no-op when there's nothing to collide with).

## Residual Risks (logged, not blocking)

- A genuinely duplicate id-column value across two rows in the Sheet itself, for `sup`/`payments`/`co`, is not resolvable by this fix (see note in section 4) — this is a pre-existing data-quality issue at the Sheet level, not introduced or worsened by this change, and would require a separate Sheet-side integrity check to fully close (out of scope here).

## Changelog

- v5: Added `claimOnceMatcher()` and wrapped every business-key/id lookup in `pullAll()` with claim-once semantics, closing the schema-migration-reviewer CRITICAL finding that two pulled records sharing a business key (or, for id-keyed entities, a duplicate Sheets id) could both end up carrying the same local `id` — an identity collision worse than the pre-fix behavior it replaces.
- v4: Unified `idKeyedEnts`/business-keyed merge into one loop via `mergePulledWithLocal()` — closed `co.enquiries`/`sup.ct`/`payments.invId` etc. untracked-field drop.
- v3: Replaced hardcoded field allowlist with generic `mergePulledWithLocal()` — closed `inv.type` drop.
- v2 / v1: superseded.
