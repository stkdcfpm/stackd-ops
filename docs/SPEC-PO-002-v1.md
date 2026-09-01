# SPEC-PO-002 — Fix `qteToPoConvert()` field-shape mismatch corrupting Quote-converted Purchase Orders

**Status:** v1 — spec-gate **CONDITIONAL PASS**, advisories only (no blocking findings; the reviewer independently applied this SPEC's full diff to a scratch copy and ran the real 681-test suite plus both required mutation tests, reaching 687/687 passing). All 3 advisories fixed in place — see §7 review-resolution log.
**Implements:** `docs/REQ-PO-002-v1.md` (requirements-gate PASS, round 1 CONDITIONAL PASS with 2 blocking findings fixed in place, round 2 CONDITIONAL PASS with 2 wording advisories fixed in place).
**Touches:** `index.html` only (no `Code.gs`, no schema change beyond the migration itself, no `FIELD_MAPS` entry — `FIELD_MAPS.po` already correctly names `date`/`cur`, matching REQ §3's explicit non-goal).

---

## 1. `qteToPoConvert()` — corrected field shape (REQ-PO-002a)

**File:** `index.html:11472-11523`, full current function body already read and confirmed current against `main` @ v2.9.71.

**Current (`index.html:11500-11509`):**
```js
    var po = {
      id: uid(), num: poNum, supId: supId,
      invNum: '', invId: '', dt: today(), del: '', currency: q.currency||'USD',
      dep: 0, fpm: 0, rec: false, oth: 0, paymentTerms: '',
      notes: 'Auto-converted from ' + q.num, status: 'Draft',
      lines: lines.map(function(l){
        return { rid:uid(), liId:'', desc:l.desc, qty:l.qty||1, up:l.cost, uom:l.uom||'pcs', cur:q.currency||'USD' };
      }),
      quoteId: id, quoteNum: q.num
    };
```

**New:**
```js
    var po = {
      id: uid(), num: poNum, supId: supId,
      invNum: '', invId: '', date: today(), del: '', cur: q.currency||'USD',
      dep: 0, fpmFunded: 0, fpmRecovered: false, oth: 0, paymentTerms: '',
      notes: 'Auto-converted from ' + q.num, status: 'Draft',
      lineItems: lines.map(function(l){
        return { rid:uid(), lid:'', desc:l.desc, sku:'', uom:l.uom||'pcs', qty:l.qty||1, cost:l.cost };
      }),
      quoteId: id, quoteNum: q.num
    };
```

Every other line in `qteToPoConvert()` (the supplier grouping, the numbering/collision-suffix logic, the `sv()`/`linkedPOIds`/`closeM`/`rQte`/`rPO`/toast calls) is unchanged — this REQ is a field-naming fix, not a behavior change, per REQ §2's own framing. `creAt`/`updAt` are deliberately **not** added here: `autoPos()` sets `creAt` and `savePO()` sets `updAt`, but neither is required by any acceptance criterion in REQ-PO-002, and adding one now would be an unreviewed scope addition — left for a future REQ if timestamp-parity across creation paths is ever formally requested.

**Why `lid: ''` and `sku: ''`, not omitted:** `addPLI()` (`index.html:7273`) always includes both keys on a fresh line item (`{rid,lid:'',desc:'',sku:'',uom:'',qty:1,cost:0}`); omitting them here would make a `qteToPoConvert()`-created line item's key set differ from a manually-added one even after this fix, which is exactly the class of inconsistency this REQ exists to eliminate. `cost: l.cost` is a direct passthrough — no `+`/`||0` coercion is added beyond what the Quote line already guarantees (`saveQte()`'s line-construction always stores `cost` as a number).

---

## 2. New function: `migrateQtePoShape()` — one-time, idempotent shape correction (REQ-PO-002b)

**File:** insert immediately after `backfillInvoicePOs()` closes (`index.html:2855`), before the `// ── ORDER REQUESTS` comment block — grouping it with its nearest sibling in the existing informal "migration functions live together" ordering.

```js
function migrateQtePoShape() {
  var changed = false;
  DB.po.forEach(function(po) {
    if (po.lines && !po.lineItems) {
      po.lineItems = po.lines.map(function(l) {
        return { rid: l.rid || uid(), lid: '', desc: l.desc || '', sku: '', uom: l.uom || 'pcs', qty: l.qty || 1, cost: +l.up || 0 };
      });
      po.date = po.dt || today();
      po.cur = po.currency || 'USD';
      po.fpmFunded = +po.fpm || 0;
      po.fpmRecovered = !!po.rec;
      delete po.lines; delete po.dt; delete po.currency; delete po.fpm; delete po.rec;
      changed = true;
    }
  });
  if (changed) saveAll();
}
```

**Detection condition, exactly:** `po.lines && !po.lineItems`. This is deliberately narrow and matches REQ-PO-002b precisely — it can only match a record actually produced by the pre-fix `qteToPoConvert()` (the only code path that has ever written a `lines` key onto a `DB.po` record; confirmed by requirements-gate round 1's exhaustive check of every `DB.po.push`/write site). An ordinary manually-created (`savePO()`) or `autoPos()`-created PO has `lineItems` from the moment it is created and is never touched by this function — satisfying AC-5's "does not touch a Purchase Order that already has the correct shape" requirement by construction, not by an extra guard.

**Idempotency:** after the first run, `po.lines` is deleted and `po.lineItems` is set, so `po.lines && !po.lineItems` is false on every subsequent run — a second call is a guaranteed no-op for that record, satisfying AC-5's idempotency requirement without any separate "already migrated" marker.

**Line-item field mapping, matching REQ-PO-002b exactly:** `liId` is discarded outright (the corrected shape's `lid` is always `''` for a Quote-sourced line, matching §1's own construction — there is no real catalogue-link value to preserve, since Quote lines never carry one), `up` becomes `cost` (`+l.up || 0` mirrors the same safe-coercion idiom `calcPO()` already uses for `cost` elsewhere, `index.html:7293`), the stray per-line `cur` is dropped entirely (not mapped to anything — REQ-PO-002b is explicit that no real line item carries this field), and `sku: ''` is added to match `addPLI()`'s shape. `rid` is preserved from the original line item rather than re-minted, since nothing about this migration needs to change a line item's own identity — only its shape.

---

## 3. Wiring `migrateQtePoShape()` into the same 5 call sites as `backfillInvoicePOs()` (REQ-PO-002b / AC-6)

Per requirements-gate round 1's finding B-2, `backfillInvoicePOs()` — not `migrateLinkedPOIds()` — is the correct precedent, since both it and this new migration operate on `DB.po`. All 5 sites below add the new call **immediately after** the existing `backfillInvoicePOs()` call at that site, preserving call order (this migration's own correctness does not depend on running before or after `backfillInvoicePOs()` — the two touch disjoint fields — but keeping them adjacent in the source matches the existing convention of grouping related migration calls together).

**3.1 — `pullAll()`, `index.html:4467-4469`:**
```js
// Current:
  backfillRefNums();
  backfillConIds();
  backfillInvoicePOs();
// New:
  backfillRefNums();
  backfillConIds();
  backfillInvoicePOs();
  migrateQtePoShape();
```

**3.2 — `processImport()`'s Purchase Order CSV-import branch, `index.html:8272-8273`:**
```js
// Current:
    sv(K.p,DB.po);
    backfillInvoicePOs();
// New:
    sv(K.p,DB.po);
    backfillInvoicePOs();
    migrateQtePoShape();
```

**3.3 — `processImportRecords()`'s Purchase Order Sheets-import branch, `index.html:8621-8622`:**
```js
// Current:
    sv(K.p, DB.po);
    backfillInvoicePOs();
// New:
    sv(K.p, DB.po);
    backfillInvoicePOs();
    migrateQtePoShape();
```

**3.4 — `doImport()`, `index.html:10311-10313`:**
```js
// Current:
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
// New:
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
    migrateQtePoShape();
```

**3.5 — `initApp()`, `index.html:12336-12338`:**
```js
// Current:
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
// New:
    migrateLinkedPOIds();
    backfillOrderRequests();
    backfillInvoicePOs();
    migrateQtePoShape();
```

**Note on `sv(K.p, DB.po)` at 3.2/3.3:** both import branches already persist `DB.po` immediately before calling `backfillInvoicePOs()`. `migrateQtePoShape()` calls `saveAll()` itself when it makes a change (matching `backfillInvoicePOs()`'s and `migrateLinkedPOIds()`'s own pattern), so no additional explicit `sv(K.p,...)` call is needed at any of the 5 sites — this mirrors exactly how the two existing sibling migrations already behave at these same call sites.

---

## 4. Existing tests requiring field-name-only updates (REQ-PO-002c / AC-4)

**File:** `tests/run.js:1218-1301`. Three of the seven existing `qteToPoConvert()` tests assert `.lines`/`.lines.length` directly on the generated PO and must be updated to `.lineItems`/`.lineItems.length`. The other four tests (Draft-blocked, Sent-blocked, already-linked-blocked, PO-number-collision) assert `DB.po.length`/`linkedPOIds`/`num` only and are unaffected by this rename — confirmed by re-reading all seven tests in full; no other assertion in this block touches a field this SPEC changes.

**`tests/run.js:1266-1267`:**
```js
// Current:
  assertEqual(poA.lines.length, 2, 'supplier A PO has both its lines');
  assertEqual(poB.lines.length, 1, 'supplier B PO has only its line');
// New:
  assertEqual(poA.lineItems.length, 2, 'supplier A PO has both its lines');
  assertEqual(poB.lineItems.length, 1, 'supplier B PO has only its line');
```

**`tests/run.js:1283`:**
```js
// Current:
  assertEqual(poNone.lines.length, 1, 'unassigned PO has only the unassigned line');
// New:
  assertEqual(poNone.lineItems.length, 1, 'unassigned PO has only the unassigned line');
```

No other line in these seven tests references `lines`, `dt`, `currency`, `fpm`, or `rec` on the generated PO object — confirmed by direct re-read, not assumed.

---

## 5. New tests (REQ-PO-002 AC-1, AC-2, AC-3, AC-5)

**Placement:** immediately after the existing `qteToPoConvert()` test block (`tests/run.js:1301`), before the `migrateLinkedPOIds()` test that already follows it — keeping this REQ's tests grouped with the function they test, matching the file's existing organization.

**AC-1/AC-2 — corrected field shape, exact:**
```js
test('qteToPoConvert() builds PO with correct field names, not lines/dt/currency/fpm/rec (REQ-PO-002 AC-1, AC-2)', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt11', num:'QTE-0011', status:'Accepted', currency:'EUR', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:3, cost:12.5, uom:'box' },
  ] }];
  ctx.EI.qt = 'qt11';
  ctx.qteToPoConvert();
  var po = ctx.DB.po[0];
  assert(!('lines' in po), 'no stray lines key');
  assert(!('dt' in po), 'no stray dt key');
  assert(!('currency' in po), 'no stray currency key');
  assert(!('fpm' in po), 'no stray fpm key');
  assert(!('rec' in po), 'no stray rec key');
  assertEqual(po.date, ctx.today(), 'date field set (not dt)');
  assertEqual(po.cur, 'EUR', 'cur field carries Quote currency (not currency)');
  assertEqual(po.fpmFunded, 0, 'fpmFunded defaults to 0 (not fpm)');
  assertEqual(po.fpmRecovered, false, 'fpmRecovered defaults to false (not rec)');
  var li = po.lineItems[0];
  assertEqual(li.lid, '', 'line item lid blank');
  assertEqual(li.sku, '', 'line item sku blank');
  assertEqual(li.uom, 'box', 'line item uom carried through');
  assertEqual(li.qty, 3, 'line item qty carried through');
  assertEqual(li.cost, 12.5, 'line item cost carried through (not up)');
  assert(!('liId' in li), 'no stray liId key on line item');
  assert(!('up' in li), 'no stray up key on line item');
  assert(!('cur' in li), 'no stray per-line cur key');
});
```

**AC-3 — the fix is consumable by the real, unmodified `editPO()`, mutation-tested:**
```js
test('editPO() correctly loads a qteToPoConvert()-created PO\'s line items (REQ-PO-002 AC-3)', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt12', num:'QTE-0012', status:'Accepted', currency:'USD', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:4, cost:50, uom:'pcs' },
  ] }];
  ctx.EI.qt = 'qt12';
  ctx.qteToPoConvert();
  var poId = ctx.DB.po[0].id;
  ctx.editPO(poId);
  assertEqual(ctx.cPL.length, 1, 'editPO() populates cPL with the real line item, not an empty array');
  assertEqual(ctx.cPL[0].cost, 50, 'editPO() reads the correct cost value');
  ctx.calcPO();
});
```
This is the AC that would have failed against the pre-fix code — `editPO()` reads `po.lineItems||[]` (`index.html:7256`), which was always `[]` for a `qteToPoConvert()`-created PO before this fix, making `cPL.length` `0`. **Mutation check required before this test is counted as a real regression guard:** temporarily revert §1's diff alone (leaving §2/§3 in place) and confirm this test fails with `cPL.length === 0`, then restore — per this codebase's established mutation-testing discipline (used identically in `SPEC-ORD-006`, `SPEC-DATA-003`, and `SPEC-AI-GAP-011`'s own build-gate reviews).

**AC-5 — migration function: converts, is idempotent, and leaves correct-shaped records alone:**
```js
test('migrateQtePoShape() converts a legacy (pre-fix) qteToPoConvert()-shaped PO into the correct shape', () => {
  resetDB();
  ctx.DB.po = [{
    id: 'po-legacy-1', num: 'PO-QTE-0099-1', supId: 'sA',
    invNum: '', invId: '', dt: '2026-01-15', del: '', currency: 'GBP',
    dep: 0, fpm: 0, rec: false, oth: 0, paymentTerms: '',
    notes: 'Auto-converted from QTE-0099', status: 'Draft',
    lines: [{ rid: 'r1', liId: '', desc: 'Old Item', qty: 2, up: 30, uom: 'pcs', cur: 'GBP' }],
    quoteId: 'qt-legacy', quoteNum: 'QTE-0099',
  }];
  ctx.migrateQtePoShape();
  var po = ctx.DB.po[0];
  assert(!('lines' in po) && !('dt' in po) && !('currency' in po) && !('fpm' in po) && !('rec' in po), 'legacy keys removed');
  assertEqual(po.date, '2026-01-15', 'dt migrated to date');
  assertEqual(po.cur, 'GBP', 'currency migrated to cur');
  assertEqual(po.fpmFunded, 0, 'fpm migrated to fpmFunded');
  assertEqual(po.fpmRecovered, false, 'rec migrated to fpmRecovered');
  var li = po.lineItems[0];
  assertEqual(li.lid, '', 'liId migrated to blank lid');
  assertEqual(li.cost, 30, 'up migrated to cost');
  assertEqual(li.sku, '', 'sku added');
  assert(!('liId' in li) && !('up' in li) && !('cur' in li), 'legacy line-item keys removed');
});

test('migrateQtePoShape() is idempotent — a second run is a no-op', () => {
  resetDB();
  ctx.DB.po = [{ id:'po-legacy-2', num:'PO-QTE-0098-1', supId:'sA', dt:'2026-01-01', currency:'USD', fpm:0, rec:false, lines:[{ rid:'r1', liId:'', desc:'X', qty:1, up:10, uom:'pcs', cur:'USD' }] }];
  ctx.migrateQtePoShape();
  var afterFirst = JSON.stringify(ctx.DB.po[0]);
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), afterFirst, 'second run produces byte-identical result');
});

test('migrateQtePoShape() does not touch a PO that already has the correct shape', () => {
  resetDB();
  var correct = { id:'po-correct-1', num:'PO-0001', supId:'sA', invNum:'', invId:'', date:'2026-01-01', del:'', cur:'USD', dep:0, fpmFunded:0, fpmRecovered:false, oth:0, paymentTerms:'', notes:'', status:'Draft', lineItems:[{rid:'r1',lid:'',desc:'X',sku:'',uom:'pcs',qty:1,cost:10}] };
  ctx.DB.po = [Object.assign({}, correct)];
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), JSON.stringify(correct), 'already-correct PO is byte-identical after migration runs');
});

test('migrateQtePoShape() does not touch an ordinary autoPos()-created PO with no lines key at all', () => {
  resetDB();
  ctx.DB.inv = [{ id:'inv1', num:'INV0001', date:'2026-01-01', lineItems:[{ lid:'li1', desc:'X', qty:1, up:10 }] }];
  ctx.DB.li = [{ id:'li1', supId:'sA', sku:'SKU1', cost:10 }];
  ctx.autoPos(ctx.DB.inv[0]);
  var before = JSON.stringify(ctx.DB.po[0]);
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), before, 'autoPos()-created PO is untouched');
});
```

**Mutation-testing requirement for the four `migrateQtePoShape()` tests above:** temporarily revert §2's diff alone, leaving §3's 5 call sites in place (function called but not defined), confirm all four target tests fail with `migrateQtePoShape is not a function`, then restore. **Expect collateral noise, not a new defect:** with §2 removed but §3 still calling it, every one of the 5 call sites throws a `ReferenceError` the moment it runs — this cascades into roughly two dozen unrelated pre-existing tests (`pullAll()`, `doImport()`, the PO import tests, etc.) failing alongside the 4 intended targets, since they all exercise a function that now calls something undefined. This collateral failure count is the expected, correct signature of this specific mutation (function body removed, call sites intact) — it confirms the wiring in §3 is real and load-bearing, not evidence of an unrelated regression. Restore §2 immediately after confirming the pattern.

**AC-6 (call-site wiring) is verified by direct citation against the diff at build-gate, not by a runtime test** — matching exactly how requirements-gate round 1 itself verified `backfillInvoicePOs()`'s own 5 call sites (by reading source, not by exercising `pullAll()`'s live network path, which would require mocking the Apps Script HTTP layer this REQ does not otherwise touch). The build-gate reviewer should independently re-grep for `migrateQtePoShape()` and confirm exactly 5 call sites, each immediately following an existing `backfillInvoicePOs()` call, per §3 above.

---

## 6. Version-ship housekeeping (on completion)

Per `CLAUDE.md`'s standing checklist and REQ-PO-002 §6/§7:
- Version bump (next: v2.9.72), test count, in-app changelog, `docs/version-history.md`.
- `docs/known-gaps.md`: add `PO-GAP-005` documenting this defect (fixed), cross-referencing `docs/architecture-data-model-v1.md` §6.1. Per spec-gate advisory 3 (§7 below), also log a new, separate, **open, accepted** entry for the narrow pre-existing edge case spec-gate found: `processImport()`'s CSV Purchase-Order-update branch (`index.html:8256-8270`) replaces a matched existing PO with an entirely new object literal rather than merging, so re-importing a CSV whose PO # column exactly matches an already-existing, program-generated `PO-<quoteNum>...` number would silently destroy that PO's line-item data (`lineItems: existing.lineItems` evaluates to `undefined` on the replacement literal) before `migrateQtePoShape()` ever runs. Predates this REQ, is not introduced or worsened by it, and is out of this REQ's scope to fix.
- `docs/requirements-tracker.md`: add `REQ-PO-002` to the active requirements table with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `docs/architecture-data-model-v1.md`: update §6.1 and the `qteToPoConvert()` paragraph in §4.2 (line 114) to note the defect is fixed as of this version — separate, docs-only follow-up commit on this same PR, not part of the gate-reviewed `index.html`/`tests/run.js` diff above.

---

## 7. Review-resolution log

**Spec-gate: CONDITIONAL PASS, advisories only.** The reviewer independently verified every citation and, going beyond reading, applied this SPEC's complete diff (§1-§5) to a scratch copy of `index.html`/`tests/run.js` and ran the project's real test harness — 687/687 passing (681 baseline + 6 new). Both required mutation tests were executed for real, not merely reasoned about: reverting §1 alone reproduced the exact predicted AC-3 failure (`cPL.length`: expected 1, got 0); removing `migrateQtePoShape()`'s body alone (§3's call sites intact) produced the predicted `is not a function` failures on all 4 target tests. A full-file grep confirmed `po.lines`/`po.dt`/`po.currency`/`po.fpm`/`po.rec` are never read anywhere else in the codebase, and that no code path other than `qteToPoConvert()` ever writes a `lines` key onto a `DB.po` record — confirming the migration's detection condition is safe and this fix is isolated. Three non-blocking advisories, all fixed in place:

1. **Weaker-than-necessary "stray key" assertions at the document level** (`!po.fpm` instead of `!('fpm' in po)`, etc.) — inconsistent with the already-strict line-item-level checks in the same tests, and would not catch a hypothetical future regression that left `fpm:0`/`rec:false` behind instead of deleting the key outright. **Fixed:** both the AC-1/AC-2 test (§5) and the migration-conversion test (§5) now use `'key' in obj` presence checks at the document level, matching the line-item-level checks already present.
2. **The §5 mutation-test instructions for `migrateQtePoShape()` undersold the collateral effect of that specific mutation** — reverting the function body while leaving §3's 5 call sites in place throws in every one of those 5 call paths, cascading into roughly two dozen unrelated pre-existing tests failing alongside the 4 intended targets. **Fixed:** §5 now states this explicitly, so a build-gate reviewer repeating the mutation isn't confused by the collateral failure count into thinking something unrelated broke.
3. **A narrow, pre-existing, out-of-scope edge case was found**, unrelated to and predating this REQ: `processImport()`'s CSV PO-update branch replaces a matched PO with a fresh object literal rather than merging, which could destroy a legacy PO's line data via a specific number-collision re-import scenario before this REQ's migration ever sees it. **Resolved by disclosure, not by fixing:** logged as a new, separate, open/accepted `known-gaps.md` entry alongside `PO-GAP-005` in §6 above — correctly out of scope for this REQ to fix, per the reviewer's own assessment.
