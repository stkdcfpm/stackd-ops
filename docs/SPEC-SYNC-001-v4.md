# SPEC-SYNC-001-v4: Fix pullAll() field-mapping and identity loss

**Supersedes:** SPEC-SYNC-001-v3
**Implements:** REQ-SYNC-001-v2 (requirements-gate PASS)

## Correction from v3 (spec-gate FAIL)

v3 fixed the untracked-field-survival bug for `inv`/`po`/`cn`/`li`/`sh`/`qt` but left the `idKeyedEnts` (`sup`, `payments`, `co`) branch on the old wholesale-replace logic (`DB[dbKey] = pulled.concat(...)`), which does **not** call `mergePulledWithLocal()` — reintroducing the exact same class of bug for these three entities. Spec-gate confirmed concrete live untracked fields that would be silently dropped on every matched pull:
- `co.enquiries` (index.html:3656, 9093-9159) — the actual enquiry-history payload, not cosmetic, and GDPR-relevant (`CON-GAP-001`/`CON-GAP-004` context).
- `sup.ct` (index.html:3655) — untracked (`FIELD_MAPS.sup` uses the mismatched key `contact`, a separate already-logged issue, but the *consequence* here is real data loss on pull).
- `payments.invId`, `.type`, `.reference`/`.ref`, `.creAt` — none tracked in `FIELD_MAPS.payments`.

**Fix: route all six `simpleEnts` (not just the five business-keyed ones) through the same `mergePulledWithLocal()` path**, unifying the two previously-separate branches into a single loop. The only difference between "id-keyed" and "business-keyed" entities is *how the local match is found* — once found, the same generic merge applies uniformly.

## 1–3. Unchanged from v3

`unmapRec()`, `findLocalMatchByBizKey()`, and `mergePulledWithLocal()` are unchanged — all three were spec-gate-verified correct in v3's review (items 1–4 of that review all confirmed).

## 4. `pullAll()` changes (`index.html:3331-3416`)

Invoices, Credit Notes, and Purchase Orders blocks are **unchanged from v3** (already spec-gate-verified correct for `inv.type` survival and the `calc_*` zero-clobber guard).

**`simpleEnts` block (`3390-3403`) — unified single loop, v4 fix**:
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
      var matchedLocalIds = {};
      var merged = pulled.map(function(p) {
        var local = idKeyedEnts.indexOf(eKey) > -1
          ? localArr.find(function(r){ return r.id === p.id; })
          : findLocalMatchByBizKey(eKey, localArr, p);
        var m = mergePulledWithLocal(p, local);
        if (local) {
          matchedLocalIds[local.id] = true;
        } else if (idKeyedEnts.indexOf(eKey) === -1) {
          m.id = uid(); // business-keyed entity, genuinely new — Sheets carries no id for these, assign one
        }
        // id-keyed entity, no local match: `m.id` is already the Sheets-provided id from `pulled` (p.id), used as-is — same as pre-fix behavior for a brand-new synced record.
        return m;
      });
      var localOnly = localArr.filter(function(r){ return !matchedLocalIds[r.id]; });
      DB[dbKey] = merged.concat(localOnly);
    }
  } catch(e) { failed.push(eKey); console.warn('[Stackd] pullAll: ' + eKey + ' failed —', e.message); }
}
```

This single loop now handles all six `simpleEnts` uniformly: `sup`/`payments`/`co` match by `.id` (per REQ-SYNC-003) and `li`/`sh`/`qt` match by business key (per REQ-SYNC-002), but **both** categories now go through `mergePulledWithLocal()`, so `co.enquiries`, `sup.ct`, `payments.invId`/`.type`/`.reference`/`.creAt`, `li.priceHistory`/`.invoiceRefs`, and any other untracked field on any of the six entities all survive automatically via the same shallow-copy mechanism — no per-entity special-casing needed anywhere in this block.

## 5. Explicitly untouched

`mapRec()`, `syncAll()`, `Code.gs` — unchanged, per REQ-SYNC-004.

## 6. Tests (`tests/run.js`)

Same as v3, plus:
- **New**: `co` pull matching by `.id` preserves local `enquiries` array while adopting Sheets-sourced `name`/`email`/`status`/etc (closes the gap spec-gate found).
- **New**: `sup` pull matching by `.id` preserves local `ct` while adopting Sheets-sourced `name`/`country`/etc.
- **New**: `payments` pull matching by `.id` preserves local `invId`/`type`/`reference`/`creAt` while adopting Sheets-sourced `amount`/`date`/`method`/etc.
- AC-006 (regression) extended: `sup`/`payments`/`co` merge by `.id` **and** preserve their respective untracked fields, not just "merge correctly" as a general statement.

## Changelog

- v4: Unified the `idKeyedEnts`/`bizKeyedEnts` branches into a single loop so `sup`/`payments`/`co` also route through `mergePulledWithLocal()` — closes the spec-gate v3 finding that these three still silently dropped untracked fields (`co.enquiries`, `sup.ct`, `payments.invId`/`.type`/`.reference`/`.creAt`) on every matched pull, the same bug class just fixed for `inv`/`po`/`cn`/`li`/`sh`/`qt` in v3.
- v3: Replaced hardcoded field allowlist with generic `mergePulledWithLocal()` for the five business-keyed entities (fixed the `inv.type` drop); `idKeyedEnts` branch left unfixed (this v4's correction).
- v2 / v1: superseded.
