# SPEC-PO-001 — Split Quote→PO Conversion by Supplier (fixes PO-GAP-001)

**Derived from:** REQ-PO-001-v3 (requirements-gate PASS)
**Status:** Draft v3 — spec-gate PASSED v2; schema-migration-reviewer PASSED with one required addition (existing `tests/run.js` assertions hardcode the old `linkedPOId` scalar and will break under the new schema — not previously called out explicitly); this revision adds the exact required test rewrites (see §9 Changelog)
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** PO-GAP-001, PO-GAP-002 (to be logged, see §6), `docs/known-gaps.md`
**Supersedes:** SPEC-PO-001-v2 (spec-gate PASS — see §9 Changelog)

---

## 1. Current Behavior — Exact Code Being Replaced

```js
// index.html — qteToPoConvert(), current implementation
function qteToPoConvert() {
  var id = EI.qt;
  if (!id) return;
  var q = DB.qt.find(function(x){ return x.id===id; });
  if (!q) return;
  if (q.linkedPOId) { toast('This quote already has a linked PO'); return; }
  if (q.status !== 'Accepted') { toast('Set quote status to Accepted before converting to PO'); return; }
  var firstSup = (q.lines||[]).find(function(l){ return l.supId; });
  var poNum = 'PO-' + q.num;
  var po = {
    id: uid(), num: poNum, supId: firstSup ? firstSup.supId : '',
    invNum: '', invId: '', dt: today(), del: '', currency: q.currency||'USD',
    dep: 0, fpm: 0, rec: false, oth: 0, paymentTerms: '',
    notes: 'Auto-converted from ' + q.num, status: 'Draft',
    lines: (q.lines||[]).map(function(l){
      return { rid:uid(), liId:'', desc:l.desc, qty:l.qty||1, up:l.cost, uom:l.uom||'pcs', cur:q.currency||'USD' };
    }),
    quoteId: id, quoteNum: q.num
  };
  DB.po.push(po);
  sv(K.p, DB.po);
  q.linkedPOId = po.id;
  sv(K.qt, DB.qt);
  ...
}
```

Every downstream read site (verified, per REQ-PO-001-v3 §3):
- List-view "PO linked" badge: `index.html` (`rQte()`'s row template) — `(q.linkedPOId ? 'PO linked' : '')`
- Convert-to-PO button visibility: `updQtePoBtn()` — `poBtn.style.display = (st === 'Accepted' && !(q && q.linkedPOId)) ? '' : 'none';`
- "PO RAISED" edit-modal badge: `editQte()` — `q.linkedPOId ? '<span>...PO RAISED</span>' : ''`
- `saveQte()`'s field preservation on edit: `linkedPOId: existQ ? (existQ.linkedPOId||'') : ''`
- Demo seed: `loadDemoData()` — `linkedPOId: poId` (single string)
- The re-conversion guard inside `qteToPoConvert()` itself (shown above)

## 2. New Behavior

```js
function qteToPoConvert() {
  var id = EI.qt;
  if (!id) return;
  var q = DB.qt.find(function(x){ return x.id===id; });
  if (!q) return;
  if (q.linkedPOIds && q.linkedPOIds.length) { toast('This quote already has a linked PO'); return; }
  if (q.status !== 'Accepted') { toast('Set quote status to Accepted before converting to PO'); return; }

  // Group lines by supId (including '' for lines with no supplier — grouped
  // together, never merged into another supplier's PO, per REQ-PO-001-v3 §3)
  var groups = {};
  var order = [];
  (q.lines||[]).forEach(function(l){
    var key = l.supId || '';
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(l);
  });

  var newPOIds = [];
  order.forEach(function(supId, i){
    var lines = groups[supId];
    var poNum = 'PO-' + q.num + (order.length > 1 ? '-' + (i + 1) : '');
    // Uniqueness guard — added in v2 (spec-gate finding): qteToPoConvert()
    // never routes through vPO(), the only place num uniqueness is normally
    // checked (index.html:5688), so an operator's manually-typed PO number
    // could otherwise collide with an auto-generated one. Suffix with an
    // incrementing letter until unique, rather than silently pushing a
    // duplicate num into DB.po.
    var suffix = '';
    var attempt = 0;
    while (DB.po.some(function(p){ return p.num === poNum + suffix; })) {
      attempt++;
      suffix = String.fromCharCode(97 + attempt - 1); // 'a', 'b', 'c', ...
    }
    poNum = poNum + suffix;
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
    DB.po.push(po);
    newPOIds.push(po.id);
  });

  sv(K.p, DB.po);
  q.linkedPOIds = newPOIds;
  sv(K.qt, DB.qt);
  ...
}
```

**Design notes:**
- **PO numbering for the multi-PO case:** single-supplier Quotes (the common case, and the only case today) keep the exact existing numbering (`PO-` + quote num, no suffix, **unless that exact string is already taken** — see the uniqueness guard below) — a regression-safe near-no-op. Multi-supplier Quotes get a `-1`, `-2`, ... suffix per generated PO, so PO numbers stay unique and traceable back to the source Quote without colliding with each other.
- **Line grouping preserves original line order within each group** (`Array.prototype.forEach` + push, no sort) — group creation order follows first-appearance order in `q.lines[]`, so the group containing the original `firstSup` supplier still becomes `PO-<num>-1` (or the unsuffixed `PO-<num>` if it's the only group), keeping today's single-supplier behavior byte-for-byte identical when there's only one group.
- **No line is ever duplicated or dropped** — every line in `q.lines[]` is placed into exactly one group, and every group becomes exactly one PO containing only its own lines. This directly satisfies REQ-PO-001-v3 AC-001/AC-002.
- **Uniqueness guard against manually-typed PO numbers — added in v2 (spec-gate finding):** `qteToPoConvert()` writes directly to `DB.po` and has never routed through `vPO()` (`index.html:5681`), the only place PO `num` uniqueness is normally validated (`index.html:5688`). This is true of both the current buggy code and the naive replacement — neither checks whether an auto-generated number happens to collide with a PO an operator typed in manually (e.g. `PO-Q0042-1` already exists as a hand-created PO before Quote `Q0042` is converted). Rather than accept this as a residual risk (the way §6/PO-GAP-002 accepts the historical-misattribution risk, where there genuinely is no fix short of a manual audit), this case **is** fixable at generation time: the loop above checks `DB.po` for an existing exact match before finalizing each `poNum`, and appends an incrementing lowercase letter (`a`, `b`, `c`, ...) until the candidate number is unique. This guarantees `qteToPoConvert()` never pushes a duplicate `num` into `DB.po`, without needing to route through the full `vPO()` form-validation path (which also checks supplier/deposit/FPM fields not relevant here).

## 3. Schema Change: `linkedPOId` → `linkedPOIds`

Per REQ-PO-001-v3 §4/§5 (schema-migration-reviewer required — see §7 Rollout):

```js
// Quote record shape — field renamed and re-typed
{
  ...,
  linkedPOIds: ['po-id-1', 'po-id-2'],   // NEW — array, was linkedPOId (scalar string)
}
```

### 3.1 Migration function

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

Guard condition, exactly as pinned in REQ-PO-001-v3 AC-004: `q.linkedPOId` non-empty **and** `q.linkedPOIds` absent. A Quote with neither field (never converted to PO) is untouched — no `linkedPOIds: []` is defaulted onto it, since an absent array and an empty array are meant to be distinguishable states here (absent = "never converted"; empty is not a state this migration or the normal flow ever produces, since a Quote either has no POs or has ≥1). This mirrors `backfillRefNums()`'s established idempotency shape (SPEC-DATA-001-v6 §4): a per-record guard checked on every load, safe to call unconditionally, no double-processing.

**Old field removal:** the migration `delete`s `linkedPOId` after copying it, so no code path can accidentally read the stale scalar post-migration. This is a deliberate departure from SPEC-DATA-001's pattern (which never removes old data) because here the old field is being *replaced*, not supplemented — leaving both `linkedPOId` and `linkedPOIds` populated simultaneously would let old and new code disagree about state depending on which field they read, which SPEC-DATA-001's `num` addition never risked (it added a new field, it never replaced or removed one).

### 3.2 Call-site position

`migrateLinkedPOIds()` is called once from `initApp()`, immediately after the existing `backfillRefNums()` call (`index.html:9306`) — i.e., `repairCalcFields() → seedAdHocBuyer() → backfillRefNums() → migrateLinkedPOIds()` — and once from `doImport()`, in the same relative position after its existing `backfillRefNums()` call, so a restored backup with pre-migration Quote records is migrated on the spot. This is independent of `backfillOrderRequests()` (SPEC-ORD-001 §4, also positioned after `backfillRefNums()`) — the two migrations don't interact, since one touches `DB.qt.linkedPOId` and the other touches `DB.ord`, but both being pinned to explicit positions (rather than left inferable) follows the discipline schema-migration-reviewer required for SPEC-ORD-001's own call-site ambiguity.

## 4. UI Site Updates

| Site | Current | New |
|---|---|---|
| List-view badge | `(q.linkedPOId ? 'PO linked' : '')` | `(q.linkedPOIds && q.linkedPOIds.length ? 'PO linked' : '')` — text unchanged, per REQ-PO-001-v3 AC-005 |
| `updQtePoBtn()` | `!(q && q.linkedPOId)` | `!(q && q.linkedPOIds && q.linkedPOIds.length)` |
| `editQte()` "PO RAISED" badge | `q.linkedPOId ? '<span>...</span>' : ''` | `(q.linkedPOIds && q.linkedPOIds.length) ? '<span>...</span>' : ''` — badge markup unchanged |
| `saveQte()` field preservation | `linkedPOId: existQ ? (existQ.linkedPOId||'') : ''` | `linkedPOIds: existQ ? (existQ.linkedPOIds||[]) : []` |
| `qteToPoConvert()` re-conversion guard | `if (q.linkedPOId) {...}` | `if (q.linkedPOIds && q.linkedPOIds.length) {...}` |
| `loadDemoData()` seed | `linkedPOId: poId` | `linkedPOIds: [poId]` |

No badge/button gains a count or list-of-PO-numbers display — explicitly not required, per REQ-PO-001-v3 AC-005.

## 5. GDPR

None. No new PII field, no new external transmission, no change to any Sheets sync path (`FIELD_MAPS.qt` exists but `syncEnt('qt')` is never called — confirmed dead code, per REQ-PO-001-v3 §5 — and this spec doesn't add `linkedPOIds` or any other new field to that map).

## 6. Known Gaps

- **PO-GAP-001** — this spec is the fix. Update status to "Fixed vX.X.X" once shipped.
- **PO-GAP-002 (new — required per REQ-PO-001-v3 §7, log at the same time PO-GAP-001 closes):** "POs created before this fix shipped, from a multi-supplier Quote, may carry incorrect supplier attribution on non-first-supplier lines. No automated audit exists to identify which historical POs are affected. Manual review recommended if a specific supplier dispute or reconciliation issue arises referencing a pre-fix PO."

## 7. Test Plan

**Required pre-existing test rewrites — added in v3 (schema-migration-reviewer MAJOR finding):** `tests/run.js`'s existing `qteToPoConvert` suite (lines 816-847) hardcodes the old `linkedPOId` scalar directly in fixtures and assertions and **will break** under the new schema if left as-is — this was not previously called out explicitly, and "all existing tests continue to pass" (§7's own closing bullet, below) was not a true claim until this is fixed. Specifically, before build:
- Line 818 (`'qteToPoConvert blocked when status is Draft'`) and line 827 (`'qteToPoConvert blocked when status is Sent'`): fixture's `linkedPOId:null` → drop entirely (the new schema has no `linkedPOId` field at all on a fresh record; absence, not `null`, is the correct un-converted state)
- Line 822: `assert(ctx.DB.qt[0].linkedPOId === null, ...)` → `assert(!ctx.DB.qt[0].linkedPOIds, 'linkedPOIds unchanged')`
- Line 835 (`'qteToPoConvert creates PO when status is Accepted'`) fixture: drop `linkedPOId:null`
- Line 839: `assertEqual(ctx.DB.qt[0].linkedPOId, ctx.DB.po[0].id, 'linkedPOId set on quote')` → `assertEqual(ctx.DB.qt[0].linkedPOIds[0], ctx.DB.po[0].id, 'linkedPOIds[0] set on quote')`
- Lines 843-845 (`'qteToPoConvert blocked when quote already has linkedPOId'`): rename the test to `'qteToPoConvert blocked when quote already has linkedPOIds'`; fixture's `linkedPOId:'existing-po-id'` → `linkedPOIds:['existing-po-id']`; the guard being tested now keys off `linkedPOIds.length`, not `linkedPOId` truthiness

- **Regression — single-supplier Quote:** produces exactly one PO, `num` unsuffixed (`PO-<quoteNum>`, unchanged from today), `linkedPOIds` has exactly one element, all lines present on that one PO
- **Multi-supplier Quote:** a Quote with lines across 3 distinct `supId` values produces exactly 3 POs, each `num` suffixed `-1`/`-2`/`-3` in first-appearance order, each PO containing only its own supplier's lines, `linkedPOIds` has 3 elements
- **Mixed supplier-assigned + unassigned lines:** a Quote with some lines carrying a `supId` and some with none produces a separate PO for the `supId: ''` group, not merged into any other group
- **PO-numbering collision (new in v2):** given a pre-existing, manually-created PO already numbered exactly what a candidate auto-generated number would be (e.g. `PO-Q0042-1`), converting Quote `Q0042` produces a PO numbered `PO-Q0042-1a` (or the next free letter), never a silent duplicate `num` in `DB.po`
- **Re-conversion guard:** calling `qteToPoConvert()` on a Quote that already has `linkedPOIds.length > 0` is blocked, same toast message as today
- **`migrateLinkedPOIds()`:** a Quote with legacy `linkedPOId` (non-empty) and no `linkedPOIds` is migrated to `linkedPOIds: [value]` with `linkedPOId` removed; idempotent on second call (no-op, since `linkedPOIds` is now present); a Quote with neither field is untouched (not defaulted to `linkedPOIds: []`); a Quote already migrated (has `linkedPOIds`, no `linkedPOId`) is untouched
- **UI sites:** list-view badge, Convert-to-PO button visibility, "PO RAISED" edit-modal badge, and `saveQte()` field preservation all correctly reflect `linkedPOIds.length > 0` in place of the old scalar truthiness check, verified for both the zero-POs and one-or-more-POs cases
- Regression: all existing tests continue to pass

## 8. Rollout

1. **Route the schema change (§3) through schema-migration-reviewer** before build, per REQ-PO-001-v3 §4/§5 — this changes an existing live field's type/cardinality, not just adds one
2. Build per §1–§6
3. Run `node tests/run.js` — all existing + new tests pass
4. `build-gate` review of the resulting diff against this spec
5. Update `docs/known-gaps.md`: PO-GAP-001 → Fixed (cite version); log PO-GAP-002
6. Version bump, changelog, `AI_SYSTEM_PROMPT` update if PO/Quote conversion behavior is described there, PR

## 9. Changelog

**v3 (this version):** schema-migration-reviewer ran on the `linkedPOId`→`linkedPOIds` schema change. **Result: PASS**, with one required addition — the existing `qteToPoConvert` test suite in `tests/run.js` (lines 816-847) hardcodes the old scalar field and would break under the new schema without a rewrite, which the spec's §7 hadn't previously named explicitly (its "all existing tests continue to pass" claim was not yet true). v3 adds the exact line-by-line rewrite required (§7). The migration function itself, the `delete`-after-copy pattern, the call-site position, and the full 7-site `linkedPOId` inventory were all independently re-verified as sound and required no changes — the synchronous, single-threaded nature of this codebase (no async gap between in-memory mutation and `saveAll()`) was confirmed to make the field-deletion pattern safe (a mid-migration exception leaves `localStorage` at its pre-migration state, and the migration simply reruns idempotently next load).

**v2:** Resubmitted after spec-gate FAIL on v1. One finding addressed: §2's PO-numbering scheme asserted collision-safety without any supporting mechanism — `qteToPoConvert()` never routes through `vPO()`'s uniqueness check, so an auto-generated number could silently collide with a manually-typed PO number already in `DB.po`. v2 adds an explicit pre-push uniqueness loop (incrementing letter suffix on collision) so this is genuinely prevented rather than merely asserted, plus a corresponding test case (§7).

**v1:** Initial spec derived from REQ-PO-001-v3 (requirements-gate PASS). FAIL — spec-gate found the PO-numbering collision-safety claim unsupported by any actual check against manually-typed PO numbers.
