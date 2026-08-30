# SPEC-INTEG-002-2b — Invoice→PO enumeration fix

**Status:** v4 — supersedes v3. Implements `docs/REQ-INTEG-002-2b-v4.md`. v3's own spec-gate review (checking only the v3-new §2.3/§5 content) found a genuine logic defect in `backfillInvoicePOs()` itself, present since v1 but only exposed once §2.3's `pullAll()`-re-link scenario (AC-14) was traced against it: the algorithm's per-invoice `p.invId===inv.id||p.invNum===inv.num` filter is not mutually exclusive across invoices when a PO's `invId` and `invNum` disagree (exactly what a `pullAll()` re-link produces, since `FIELD_MAPS.po` overwrites `invNum` but never touches `invId`) — the same PO could land in TWO invoices' `pos[]` simultaneously (the old one via stale `invId`, the new one via fresh `invNum`), not move cleanly from one to the other as claimed. **Fixed in v4:** §2's algorithm is inverted — instead of iterating invoices and filtering POs per-invoice, it now iterates POs once and assigns each to a single "home" invoice, preferring an `invNum` match (the field every import/pull path keeps fresh — `processImport()`/`processImportRecords()`/`pullAll()` all write `invNum`, and `FIELD_MAPS.po` never maps `invId` at all, so `invNum` is always the more up-to-date of the two whenever they disagree) and falling back to `invId` only when `invNum` is blank or doesn't resolve to any invoice. This guarantees every PO belongs to at most one invoice's `pos[]`, and correctly lets a Sheets-driven re-link (which can only ever change `invNum`, never `invId`) actually take effect — the opposite priority (preferring `invId`) would have silently ignored every such re-link forever, since the stale `invId` would always keep resolving to the old invoice. For every existing write path (`autoPos()`, `processImport()`, `processImportRecords()`, the `loadDemoData()` seed), `invId` and `invNum` are always set together from the same source and never disagree — so this priority choice changes nothing for any of AC-1 through AC-13's scenarios, only AC-14's genuine disagreement case. AC-14's test is corrected to assert exclusive membership, and a new direct regression test (§5 item 2b) targets the exclusivity property itself. Everything else from v1/v2/v3 is unchanged. See `docs/REQ-INTEG-002-2b-v4.md`'s §7 for the full five-round review-resolution log.
**Build baseline:** `main` @ `74dab27`, 609/609 tests passing.

---

## 1. New helper: `getInvoicePOs(inv)`

Placed immediately after `autoPos()` (`index.html:5963-5981`), since both concern the Invoice↔PO relationship:

```js
function getInvoicePOs(inv) {
  return (inv.pos||[]).map(function(id){ return DB.po.find(function(p){ return p.id===id; }); }).filter(Boolean);
}
```

No change to `autoPos()` itself (REQ-INTEG-002-2b-e) — it already pushes correctly into `inv.pos[]` (`index.html:5976`).

---

## 2. New migration: `backfillInvoicePOs()`

Placed immediately after `migrateLinkedPOIds()` (`index.html:2763-2773`), matching its exact structure:

Current `migrateLinkedPOIds()` (for reference, unchanged):
```js
function migrateLinkedPOIds() {
  var changed = false;
  DB.qt.forEach(function(q) {
    if (q.linkedPOId && !q.linkedPOIds) {
      q.linkedPOIds = [q.linkedPOId];
      delete q.linkedPOId;
      changed = true;
    }
  });
  if (changed) saveAll();
}
```

New function, added directly below it. **v4 correction:** rather than iterating invoices and filtering `DB.po` per-invoice with an OR condition (v1-v3's approach, which is not mutually exclusive when a PO's `invId`/`invNum` disagree — see the v4 status note above), this iterates `DB.po` once and assigns each PO to exactly one "home" invoice, preferring an `invNum` match (the field every import/pull path keeps fresh) and falling back to `invId` only when `invNum` is blank or doesn't resolve:
```js
function backfillInvoicePOs() {
  var posByInv = {};
  DB.po.forEach(function(po) {
    var home = po.invNum ? DB.inv.find(function(i){ return i.num === po.invNum; }) : null;
    if (!home && po.invId) home = DB.inv.find(function(i){ return i.id === po.invId; });
    if (!home) return;
    if (!posByInv[home.id]) posByInv[home.id] = [];
    posByInv[home.id].push(po.id);
  });
  var changed = false;
  DB.inv.forEach(function(inv) {
    var live = posByInv[inv.id] || [];
    var current = inv.pos || [];
    var same = current.length === live.length && current.every(function(id, i){ return id === live[i]; });
    if (!same) {
      inv.pos = live;
      changed = true;
    }
  });
  if (changed) saveAll();
}
```

The `same` check (rather than unconditionally reassigning) keeps this a true no-op on the common case where nothing has changed, matching `migrateLinkedPOIds()`'s own "only call `saveAll()` if something actually changed" discipline — reassigning `inv.pos` to a new-but-identical array every boot would otherwise mark `changed=true` unconditionally. Since `posByInv` is built from a single pass over `DB.po` where each PO contributes to exactly one `home.id` bucket (or none, if neither `invNum` nor `invId` resolves), no PO can ever appear under two different invoices — this is what actually guarantees the exclusivity property AC-14 requires, not an incidental side effect of the per-invoice loop that follows. No mutation to `po.invId`/`po.invNum` themselves — this migration only ever writes `inv.pos[]`, leaving the PO's own fields exactly as every other write path left them (their divergence in the disagreement case is an accepted, pre-existing characteristic of those fields, not something this REQ sets out to reconcile).

### 2.1 Wiring — two call sites, mirroring `migrateLinkedPOIds()`/`backfillOrderRequests()` exactly

**`doImport()`'s restore path**, current (`index.html:9946-9948`):
```js
    backfillConIds();
    migrateLinkedPOIds();
    backfillOrderRequests();
```
becomes:
```js
    backfillConIds();
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
```

**App boot**, current (`index.html:11937-11939`):
```js
    backfillConIds();
    migrateLinkedPOIds();
    backfillOrderRequests();
```
becomes:
```js
    backfillConIds();
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
```

### 2.2 Wiring — the two CSV/Sheets PO-import paths (new in v2, per REQ-INTEG-002-2b-a's widened scope)

Both `processImport()`'s and `processImportRecords()`'s `'po'` branches can link a PO to an invoice by number (`index.html:7889-7900`, `8242`) without ever touching `inv.pos[]`. Rather than duplicate per-row sync logic inline in the import loop, each branch calls the same `backfillInvoicePOs()` migration once, right after its batch `sv(K.p,DB.po)` call — a full re-derivation is cheap (two array scans) and correctly handles both newly-added and updated PO rows uniformly, regardless of how many rows in the batch were invoice-linked.

**`processImport()`'s `'po'` branch**, current (`index.html:7910-7915`):
```js
      if (existing) { var i=DB.po.findIndex(function(p){return p.num===num;}); DB.po[i]=rec; updated++; impLog('Updated PO: '+num); }
      else { DB.po.push(rec); added++; }
    });
    sv(K.p,DB.po);
    var msg='POs: '+added+' added, '+updated+' updated, '+skipped+' skipped'+(errors.length?' | '+errors.join('; '):'');
    G('imp-po-result').textContent=msg; impLog(msg); rPO(); rDash();
  }
```
becomes:
```js
      if (existing) { var i=DB.po.findIndex(function(p){return p.num===num;}); DB.po[i]=rec; updated++; impLog('Updated PO: '+num); }
      else { DB.po.push(rec); added++; }
    });
    sv(K.p,DB.po);
    backfillInvoicePOs();
    var msg='POs: '+added+' added, '+updated+' updated, '+skipped+' skipped'+(errors.length?' | '+errors.join('; '):'');
    G('imp-po-result').textContent=msg; impLog(msg); rPO(); rDash();
  }
```

**`processImportRecords()`'s `'po'` branch**, current (`index.html:8256-8261`):
```js
      if (existing) {
        var i=DB.po.findIndex(function(p){return p.num===num;}); DB.po[i]=rec; updated++;
      } else { DB.po.push(rec); added++; }
    });
    sv(K.p, DB.po); rPO(); rDash();
  }
```
becomes:
```js
      if (existing) {
        var i=DB.po.findIndex(function(p){return p.num===num;}); DB.po[i]=rec; updated++;
      } else { DB.po.push(rec); added++; }
    });
    sv(K.p, DB.po);
    backfillInvoicePOs();
    rPO(); rDash();
  }
```

`backfillInvoicePOs()` must be defined (§2) before either of these two call sites are reached at runtime — both are inside functions defined later in the file than `backfillInvoicePOs()`'s own definition point (near `migrateLinkedPOIds()`, early in the file), so no forward-reference/hoisting concern applies (both `processImport()`/`processImportRecords()` are themselves plain `function` declarations, hoisted the same way).

### 2.3 Wiring — `pullAll()`'s bulk Purchase-Orders Sheets-merge block (new in v3)

`pullAll()`'s own PO-merge block (`index.html:4083-4101`) is a third, distinct path — the "↓ Pull"/auto-poll-on-boot bulk sync, not a manual per-entity import — that can create or re-link a PO's `invNum` without touching `inv.pos[]` (REQ §1.1). `backfillInvoicePOs()` is called once, in `pullAll()`'s own existing tail, alongside its sibling migrations.

Current (`index.html:4143-4145`):
```js
  backfillRefNums();
  backfillConIds();
  saveAll(); renderAll();
```
becomes:
```js
  backfillRefNums();
  backfillConIds();
  backfillInvoicePOs();
  saveAll(); renderAll();
```

This one call covers the entire pull, not just the `'po'` block specifically — cheap (two array scans over what are, in practice, small entity counts) and correctly handles both a brand-new pulled PO (no local match, `invId` absent per `mergePulledWithLocal()`, `index.html:3971`) and a re-matched existing PO whose `invNum` was just overwritten by the pull (`index.html:3972`, `Object.assign({}, localMatch, pulledMapped)`) — `backfillInvoicePOs()`'s replace-not-merge semantics (§2) correctly move the PO's id out of its old invoice's `pos[]` and into its new one in the same pass, since it always rebuilds every invoice's `pos[]` from the current, post-merge `DB.po`/`DB.inv` state.

---

## 3. `delPO()` — new cleanup step

Current (`index.html:7000-7007`):
```js
async function delPO(id) {
  if(!confirm('Delete?')) return;
  var _poRec = DB.po.find(function(p){return p.id===id;});
  var _poNum = (_poRec||{}).num||id;
  DB.po=DB.po.filter(function(p){return p.id!==id;});
  if (_poRec) logEv('po', _poRec.id, 'deleted', 'PO ' + _poNum + ' deleted', 'operator');
  sv(K.p,DB.po); rPO(); rDash(); toast('Deleted'); await delEnt('po',_poNum).catch(function(){});
}
```
becomes:
```js
async function delPO(id) {
  if(!confirm('Delete?')) return;
  var _poRec = DB.po.find(function(p){return p.id===id;});
  var _poNum = (_poRec||{}).num||id;
  DB.po=DB.po.filter(function(p){return p.id!==id;});
  var _posChanged = false;
  DB.inv.forEach(function(i){
    if (i.pos && i.pos.length) {
      var idx = i.pos.indexOf(id);
      if (idx > -1) { i.pos.splice(idx,1); _posChanged = true; }
    }
  });
  if (_poRec) logEv('po', _poRec.id, 'deleted', 'PO ' + _poNum + ' deleted', 'operator');
  sv(K.p,DB.po); if (_posChanged) sv(K.i,DB.inv); rPO(); rDash(); toast('Deleted'); await delEnt('po',_poNum).catch(function(){});
}
```
`sv(K.i,DB.inv)` is conditional on `_posChanged` — matching `delInv()`'s own conditional-save precedent for its `libRefsChanged` flag (`index.html:6900`: `if (libRefsChanged) sv(K.l,DB.li);`), avoiding an unconditional extra localStorage write on every PO deletion when no invoice actually referenced it.

---

## 4. Switch the three forward-enumeration call sites

### 4.1 `renderAccts()`'s per-invoice `linkedPOs`

Current (`index.html:4723-4724`):
```js
      var linkedPOs = DB.po.filter(function(p){
        return p.invId === inv.id || p.invNum === inv.num;
      });
```
becomes:
```js
      var linkedPOs = getInvoicePOs(inv);
```
Nothing else in `renderAccts()` changes — `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` (REQ-CUR-002) are all computed from `linkedPOs` exactly as before.

### 4.2 `saveInv()`'s FPM-deposit auto-recovery block

Current (`index.html:5860-5869`):
```js
  if (inv.status === 'Paid') {
    var recovered = false;
    DB.po.forEach(function(po) {
      if ((po.invId === inv.id || po.invNum === inv.num) && po.fpmFunded > 0 && !po.fpmRecovered) {
        po.fpmRecovered = true;
        po.updAt = new Date().toISOString();
        recovered = true;
        syncEnt('po', po).catch(function(){});
      }
    });
```
becomes:
```js
  if (inv.status === 'Paid') {
    var recovered = false;
    getInvoicePOs(inv).forEach(function(po) {
      if (po.fpmFunded > 0 && !po.fpmRecovered) {
        po.fpmRecovered = true;
        po.updAt = new Date().toISOString();
        recovered = true;
        syncEnt('po', po).catch(function(){});
      }
    });
```
(Whatever follows this block — `if (recovered) {...}` — is unchanged, not shown here since it doesn't reference the enumeration.)

### 4.3 `savePayment()`'s FPM-deposit auto-recovery block

Current (`index.html:11444-11454`):
```js
    if (inv.status === 'Paid' && prevStatus !== 'Paid') {
      var recovered = false;
      DB.po.forEach(function(po) {
        if ((po.invId === inv.id || po.invNum === inv.num) && +po.fpmFunded > 0 && !po.fpmRecovered) {
          po.fpmRecovered = true;
          po.updAt = new Date().toISOString();
          recovered = true;
          syncEnt('po', po).catch(function(){});
        }
      });
```
becomes:
```js
    if (inv.status === 'Paid' && prevStatus !== 'Paid') {
      var recovered = false;
      getInvoicePOs(inv).forEach(function(po) {
        if (+po.fpmFunded > 0 && !po.fpmRecovered) {
          po.fpmRecovered = true;
          po.updAt = new Date().toISOString();
          recovered = true;
          syncEnt('po', po).catch(function(){});
        }
      });
```
This remains a separate, independent copy of the same logic as §4.2 — per `REQ-INTEG-002h` (2a), this REQ does not consolidate the two blocks into one function, only changes what each one iterates over.

---

## 5. Tests — `tests/run.js`

1. **`getInvoicePOs(inv)`** — an invoice with `pos: ['id1','id2']` where both ids resolve in `DB.po`: returns both records in order. An invoice with `pos: ['id1','stale-id']` where `stale-id` doesn't resolve: returns only the resolving record (defensive-drop, AC not explicitly numbered but covered by the helper's own contract). An invoice with no `pos` field at all: returns `[]`.
2. **`backfillInvoicePOs()` (AC-2, AC-5)** — an invoice whose `inv.pos` contains a stale id (simulating a pre-fix deletion) plus is missing a currently-linked PO's id (a PO whose `invId` resolves to that invoice): after running, `inv.pos` exactly matches the set of POs whose `invId` resolves to that invoice (or, for a PO with no resolving `invId`, whose `invNum` matches), in `DB.po` iteration order. Run twice in a row: second run makes no further change (assert via a marker — e.g. capture `JSON.stringify(DB.inv)` before/after the second run and compare, or spy on `saveAll` call count staying at the first-run total) — idempotency (AC-5).
2b. **`backfillInvoicePOs()` exclusivity (AC-15, new in v4)** — two invoices, and one PO whose `invId` resolves to the first invoice while its `invNum` matches the second invoice's `num` (the exact `invId`/`invNum` disagreement `pullAll()`'s re-link produces). After running `backfillInvoicePOs()`, assert the PO's id appears in the SECOND invoice's `pos[]` (via the resolving `invNum`, which takes priority) and is absent from the first invoice's `pos[]` — never both.
3. **`delPO()` removes the id from `inv.pos[]` (AC-3)** — an invoice with 2 POs in `pos[]`; delete one via `delPO()`; assert the invoice's `pos[]` now contains only the surviving PO's id, and `getInvoicePOs(inv)` returns only that one PO.
4. **`renderAccts()` regression guard (AC-6)** — an invoice with 2 linked POs (mirroring an existing REQ-CUR-002-style multi-currency scenario or a simpler same-currency one): assert `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` are unchanged from what direct computation via the OLD filter would have produced — i.e., this test should be constructible without needing to know internals, since both old and new sources should now return the identical set for an invoice generated the normal way (via `autoPos()`, which already correctly populates `pos[]`).
5. **`saveInv()` FPM-recovery regression guard (AC-7)** — a PO with `fpmFunded>0, fpmRecovered:false` linked to an invoice (via `autoPos()`, so `inv.pos[]` is correctly populated); save the invoice with `status:'Paid'`; assert the PO's `fpmRecovered` becomes `true` — identical outcome to pre-fix behavior, now sourced via `getInvoicePOs()`.
6. **`savePayment()` FPM-recovery regression guard (AC-8)** — same scenario, triggered via the payment-completion path instead of `saveInv()` directly (mirroring however the existing test suite currently exercises this block, if such a test already exists — check for one first as precedent).
7. **`autoPos()` unchanged (AC-9)** — a new invoice with 2 line items from 2 different suppliers, saved for the first time: assert both generated POs' ids appear in `inv.pos[]`, and `getInvoicePOs(inv)` returns both.
8. **`processImport()` CSV-linked PO syncs `inv.pos[]` immediately (AC-11, new in v2)** — seed an existing invoice (`ctx.DB.inv.push(...)`) and a supplier, then `ctx.processImport('po', csv)` with a CSV row whose "Linked Invoice #" column matches that invoice's `num` (a plain CSV string with a header row and one data row — no existing `processImport('po', ...)` test currently exists in `tests/run.js` to mirror; the header/column names follow `processImport()`'s own field-lookup keys, `index.html:7883-7888`: `'PO #'`, `'Supplier Name'`, `'Linked Invoice #'`). Assert the invoice's `pos[]` now contains the imported PO's id — no reload/boot needed.
9. **`processImportRecords()` Sheets-linked PO syncs `inv.pos[]` immediately (AC-12, new in v2)** — same scenario via `ctx.processImportRecords('po', [{ 'PO #': ..., 'Linked Invoice #': invNum, ... }], function(){})`, mirroring the existing `processImportRecords('inv', [...], function(){})` call pattern at `tests/run.js:7706`. Same assertion as AC-11.
10. **`pullAll()`'s PO-merge block syncs `inv.pos[]` for a brand-new pulled PO (AC-13, new in v3)** — mirroring the established `pullAll integration` test pattern at `tests/run.js:1624-1639` (`ctx.SS.url`/`ctx.SS.auto`/`ctx.SS.pol` set, `_mockPullResponses = { po: { status:'ok', records: [...] } }`, `await ctx.pullAll()`, then `_mockPullResponses = {}`). Seed an existing local invoice (`ctx.DB.inv.push(...)`), set `_mockPullResponses.po.records` to one row with `'PO #'`/`'Supplier'`/`'Linked Invoice'` (the actual `FIELD_MAPS.po` Sheet-column names, `index.html:3933` — not `'Linked Invoice #'`, which is `processImport()`'s own CSV header name, a different string) matching that invoice's `num`, and no matching local PO (so it's treated as brand-new per `mergePulledWithLocal()`). After `await ctx.pullAll()`, assert the invoice's `pos[]` contains the newly-pulled PO's id.
11. **`pullAll()`'s PO-merge block re-links `inv.pos[]` when an existing PO's linked invoice changes (AC-14, new in v3)** — seed two local invoices and one local PO already linked (`invId`/`invNum`) to the first; `_mockPullResponses.po.records` returns a row matching that PO's `num` but with `'Linked Invoice'` now naming the second invoice. After `await ctx.pullAll()`, assert the PO's id is present in the second invoice's `pos[]` and absent from the first's.

Checked `tests/run.js` for existing coverage of the two `fpmRecovered` auto-set blocks before writing this section: no test currently exercises either block's actual trigger path (an invoice reaching `Paid` status auto-setting a linked PO's `fpmRecovered`) — existing `fpmRecovered:false` seed data is used only for rendering/display tests (e.g. the REQ-CUR-002 totals-bar tests), not for testing the auto-recovery logic itself. AC-7/8 are therefore genuinely new tests, not extensions of existing ones. Also checked (per the confirmatory reviewer's advisory finding on v2): no existing `processImport('po',...)`/`processImportRecords('po',...)` test exists anywhere in `tests/run.js` to mirror for items 8-9 — v2's citation claiming otherwise was fabricated and is corrected above; items 8-9 are standalone new tests, built directly from the real function signatures/field names, not adapted from a non-existent precedent.

---

## 6. Out of scope (unchanged from REQ)

Reverse PO→Invoice lookups (`ordRealisedMargin()`, `backfillOrderRequests()`'s own reverse lookup), `PO-GAP-004` (logged, not fixed), consolidation of the two `fpmRecovered` blocks, Quote-converted PO linking behavior, `delInv()` cascade behavior, 2c/2d, and any currency-conversion logic.
