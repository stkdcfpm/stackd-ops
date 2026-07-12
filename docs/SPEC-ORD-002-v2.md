# SPEC-ORD-002 — Order Request Line Items: Packaging/UOM Model and Field-Level Update Log

**Derived from:** REQ-ORD-002-v2 (requirements-gate PASS)
**Status:** Draft v2 — spec-gate FAILED v1 on four findings (`saveOrdFromForm()` never wires `ord.lines` into the object it builds, silently defeating AC-004's own warning; AC-002's "always logged" guarantee wasn't structural for operator-direct edits; missing `saveAll()` call-site specification; unaddressed new-record-created-as-`Quoted` edge case); this revision resolves all four (see §11 Changelog)
**Date:** 2026-07-12
**Author:** FPM International / Claude Code
**Related:** SPEC-ORD-001-v4 (`DB.ord` entity, shipped v2.9.44), `handleAIAction()` (existing AI propose-never-auto-save pattern)
**Supersedes:** SPEC-ORD-002-v1 (spec-gate FAIL — see §11 Changelog)

---

## 1. Line Item Shape

A new `lines[]` array added to `DB.ord` records (currently absent — confirmed against `saveOrd()`, `index.html:2394`).

```js
// DB.ord[].lines[] — new
{
  id:             uid(),
  category:       'string',            // e.g. "Produce (seed)", "Salt fish"
  itemSpec:       'string',            // e.g. "Tomato (large) seed packets"
  orderVolumeQty: 'string|number',     // the stated ask, e.g. 1, "2-3"
  orderVolumeUnit:'string',            // e.g. "container", "pallets", "bags"
  packingSpec:    'string',            // free text — e.g. "5kg boxes, 2 per carton"; often initially ''
  baseUom:        'string',            // e.g. "kg", "packet", "unit" — the costable unit
  baseQty:        null,                // number|null — nullable until resolved
  qtyStatus:      'Unknown',           // 'Unknown' | 'Estimated' | 'Confirmed'
  sourceCountry:  'string',
  variantOption:  'string',            // e.g. "Black/Silver, 91cm width"
  lineUpdates: [                       // append-only provenance log — see §2
    { id: uid(), ts: ISOString, source: 'buyer'|'supplier'|'ai'|'operator',
      field: 'string', oldValue: null, newValue: null, note: 'string', confirmedBy: null }
  ]
}
```

`qtyStatus` is an independent, operator/AI-settable field per REQ-ORD-002-v2 AC-005 — never auto-derived from whether `baseQty` is populated (e.g. a confirmed `baseQty` of `0` is valid; a populated estimate can be deliberately left as `Estimated`).

**Required wiring — added in v2 (spec-gate CRITICAL finding):** `saveOrdFromForm()` (`index.html:2503-2519`) currently builds the `ord` object it passes to `saveOrd()` from a **closed field list** — `id`, `contactId`, `stage`, `description`, `actions`, `activeQuoteId`, `outcome` — with no `lines` key at all. v1's §4 warning logic (`(ord.lines || []).filter(...)`) would therefore always evaluate against `undefined` → `[]`, silently defeating its own Acceptance Criterion. This spec requires `saveOrdFromForm()`'s object literal to add: `lines: existing ? existing.lines : []`. New Order Requests are created with `lines: []` (empty, populated afterward via the line-item UI — §5); existing records carry their `lines` array through the save unchanged, matching the existing pattern already used for `actions`.

## 2. `lineUpdates[]` — Append-Only Field Log

A new function `ordLogLineUpdate(ord, lineId, field, newValue, source, note, confirmedBy)`:

```js
function ordLogLineUpdate(ord, lineId, field, newValue, source, note, confirmedBy) {
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line) return false;
  var oldValue = line[field];
  line.lineUpdates.push({
    id: uid(), ts: new Date().toISOString(), source: source,
    field: field, oldValue: oldValue, newValue: newValue, note: note || '',
    confirmedBy: confirmedBy || null
  });
  if (confirmedBy) line[field] = newValue; // only a confirmed update changes the live field
  sv(K.ord, DB.ord);
  return true;
}
function ordConfirmLineUpdate(ord, lineId, updateId) {
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line) return false;
  var entry = line.lineUpdates.find(function(u){ return u.id === updateId; });
  if (!entry || entry.confirmedBy) return false; // already confirmed, or not found — no-op
  entry.confirmedBy = 'operator';
  line[entry.field] = entry.newValue;
  sv(K.ord, DB.ord);
  return true;
}
```

**Key invariant (REQ-ORD-002-v2 AC-002/AC-003):** every call to `ordLogLineUpdate()` appends to `lineUpdates[]`, but the live field (`line[field]`) is only overwritten when `confirmedBy` is truthy. This is what makes AI-sourced proposals safe by construction: `source: 'ai'` calls always pass `confirmedBy: null`, so `ordLogLineUpdate()` records the proposal without ever touching the line's live value — no separate "is this AI-sourced" branch is needed, the same function serves both the "operator directly edits a field" case (`confirmedBy: 'operator'`, applied immediately) and the "AI proposes, operator reviews later" case (`confirmedBy: null`, not applied) uniformly. Both functions call `sv(K.ord, DB.ord)` directly (not the full `saveAll()`), since only `DB.ord` changes — matching the existing pattern already used by `ordAdminOverride()`'s persistence.

**Structural enforcement for ALL line-edit paths — added in v2 (spec-gate finding: AC-002's "always logged" guarantee was previously only a convention, not a contract).** `ordLogLineUpdate()` is the **only** sanctioned way any code path — UI, AI action, or future caller — may change a line field. §5's UI edit-in-place controls **must** call `ordLogLineUpdate(ord, lineId, field, newValue, 'operator', note, 'operator')` (note `confirmedBy` is passed as `'operator'` for a direct operator edit, applying immediately) rather than assigning `line[field] = value` directly. No code path is permitted to mutate a line field outside this function. This is now a stated contract of the spec, not left to UI-implementation discretion — build-gate should treat any direct `line[field] = ...` assignment outside `ordLogLineUpdate()`/`ordConfirmLineUpdate()` as a spec deviation.

**Operator confirming a pending AI proposal:** `ordConfirmLineUpdate(ord, lineId, updateId)` (above) finds the specific `lineUpdates[]` entry by `id`, sets `entry.confirmedBy = 'operator'`, and applies `entry.newValue` to `line[entry.field]` at that point — this is the only place a `source: 'ai'` entry's value can reach the live field. It is a no-op (returns `false`) if the entry is already confirmed, preventing a double-apply.

## 3. AI Action: `update_order_line`

Extends `handleAIAction()` (`index.html:7165`) with a new branch, following the exact pre-fill-never-auto-save pattern already used for `create_po`/`create_quote`/etc.:

```js
} else if (action.action === 'update_order_line') {
  // payload: { ordId, lineId, field, newValue, note }
  var ord = DB.ord.find(function(o){ return o.id === p.ordId; });
  if (ord) {
    // confirmedBy hardcoded to null in this call site — not read from the AI payload,
    // so a malformed/malicious action payload cannot set its own confirmedBy value
    ordLogLineUpdate(ord, p.lineId, p.field, p.newValue, 'ai', p.note || '', null);
    openOrd(ord.id); // re-open the modal so the operator sees the pending proposal in the line's update log
  }
}
```

Since `confirmedBy` is hardcoded to `null` in this call site — never read from `p` (the AI's payload) — a malformed or adversarial action payload has no way to set its own `confirmedBy` value; the AI action handler itself is the only thing that decides this call is unconfirmed, not anything the model's output controls. Combined with `ordLogLineUpdate()`'s own internal gate (§2), the call above never touches the line's live field — it only ever appends a pending, review-only entry. This makes the "never auto-save" guarantee structural (enforced by the shared function's own logic and the hardcoded call site), not just a convention the new branch has to remember to honor. `ordLogLineUpdate()` already persists via its own `sv(K.ord, DB.ord)` call (§2) — no additional `saveAll()` is needed here.

`AI_SYSTEM_PROMPT`'s action-block documentation (`index.html`, the `ACTION BLOCKS` prompt text) gets a new line for `update_order_line → { ordId, lineId, field, newValue, note }`, alongside the existing action key list.

## 4. Stage-Transition Warning (Qualifying → Quoted)

Per REQ-ORD-002-v2 §3/§5 AC-004 (a **non-blocking warning**, not a gate — corrected from the FAILed v1's contradictory hard-block): `ordCanTransition()` (`index.html:2321-2323`) is **not modified**. Note the check's mechanism actually lives inside `saveOrd()` (`index.html:2394-2416`, where the existing `vErr('of-stage', ...)` transition-table check at lines 2399-2403 sits) — not in `saveOrdFromForm()` as v1 imprecisely stated; `saveOrdFromForm()` only *builds* the `ord` object and calls `saveOrd(ord)`. This spec adds one additional, non-blocking check inside `saveOrd()`, after its existing transition-table check has already passed (i.e., the stage-change is either identical or a validly-adjacent transition — not rejected):

```js
// Inside saveOrd(), after the existing ordCanTransition() check at lines 2399-2403 has passed:
var movingToQuoted = ord.stage === 'Quoted' && (!existing || existing.stage !== 'Quoted');
if (movingToQuoted) {
  var unresolvedCount = (ord.lines || []).filter(function(l){ return l.qtyStatus === 'Unknown'; }).length;
  if (unresolvedCount > 0) {
    vWarn('of-stage', unresolvedCount + ' line(s) have unresolved quantity — quoting may be premature');
  }
}
```

`vWarn()` (`index.html:5728-5735`) is the existing amber-styled, non-blocking validation helper (distinct from `vErr()`, which blocks). The save proceeds regardless of this warning — it only informs.

**Edge case, addressed explicitly — added in v2 (spec-gate finding, previously silently inherited):** `movingToQuoted` above is written as `!existing || existing.stage !== 'Quoted'` (not `existing && existing.stage !== 'Quoted'`, which was v1's version) specifically so a **brand-new** Order Request created directly with `stage: 'Quoted'` (`existing` is `null`) still triggers this warning check if it has unresolved lines. This is a deliberate correction, not an accepted gap: v1's condition required `existing` to be truthy, meaning a new record skipping straight to `Quoted` bypassed the warning entirely — the same silent-bypass shape the existing (pre-this-spec) `ordCanTransition()` gate already has for new records (since `saveOrd()`'s transition check only fires when `existing` exists, per index.html:2399, a new record can be created at any stage with no transition validation at all — this is accepted, pre-existing behavior this spec does not change). The warning check specifically should not inherit that same blind spot, since unlike the hard transition gate, a warning costs nothing to show even on a new record.

## 5. UI Surface

- Order Request modal (`ov-ord`) gains a line-items sub-section: a table listing each line's `category`/`itemSpec`/`orderVolumeQty+Unit`/`packingSpec`/`baseUom`/`baseQty`/`qtyStatus`, with add/edit-in-place controls, mirroring the existing `of-actions-list` pattern already built for the actions array (SPEC-ORD-001 §5). **Every edit-in-place control must call `ordLogLineUpdate(ord, lineId, field, newValue, 'operator', note, 'operator')` (§2) — never assign `line[field] = value` directly.** This is a hard requirement of this spec, not an implementation detail left to discretion.
- Each line's edit view shows its `lineUpdates[]` log (read-only, newest first) — timestamp, source, field, old→new value, note, confirmed-by-whom-or-pending
- A pending (`confirmedBy: null`) `lineUpdates[]` entry is visually distinguished (e.g. amber "Pending review" badge) with a one-click "Confirm" button calling `ordConfirmLineUpdate()`
- `qtyStatus` is a dropdown (`Unknown`/`Estimated`/`Confirmed`), independently settable — no auto-derivation from `baseQty`'s presence, per AC-005

## 6. FM-1 Compliance

New field (`lines[]`) on an existing entity (`DB.ord`) that already has no Sheets sync mapping (SPEC-ORD-001-v4 §6: "No `FIELD_MAPS.ord` entry, no `syncEnt` call"). This is FM-1 exception category 2 ("new fields on existing entities... permitted where the fields do not require a new sync mapping") — the same category `num` (SPEC-DATA-001) qualified under. No new sync mapping is introduced by this spec.

## 7. GDPR

Per REQ-ORD-002-v2 §6: structured line fields carry commercial/logistics data only. `lineUpdates[].note` is free text and carries the same practical risk profile as the already-accepted `Contact.enquiries[].summary` field — no new sanitization/redaction mechanism is introduced; operators are expected to avoid recording a named individual's identity in `note` beyond what the Contact record's own FK already provides.

## 8. New Known Gap

**ORD-GAP-002 (to be logged alongside this feature's build):** `update_order_line`'s AI proposal has no corresponding AI read-tool (e.g. `get_order_lines`) — the AI can propose an update but cannot query current line state to decide whether a proposal is even warranted (same read/write asymmetry already logged for other entities under AI-GAP-008's precedent). Explicitly out of scope per REQ-ORD-002-v2 §3.

## 9. Test Plan

- `ordLogLineUpdate()`: appends a `lineUpdates[]` entry every call; live field only changes when `confirmedBy` is truthy; unconfirmed (AI-sourced) calls never touch the live field value
- `ordConfirmLineUpdate()`: applies a specific pending entry's `newValue` to the live field and sets `confirmedBy: 'operator'`; does not affect other pending entries on the same or other lines
- `update_order_line` AI action: proposes via `ordLogLineUpdate()` with `confirmedBy: null`; live field unchanged immediately after the action fires; confirmed only via a subsequent, separate `ordConfirmLineUpdate()` call
- `qtyStatus` independence: setting `baseQty` to a non-null value does not auto-flip `qtyStatus` to `Confirmed`; `qtyStatus` must be set explicitly
- Stage-transition warning: moving to `Quoted` with one or more `Unknown`-status lines triggers `vWarn('of-stage', ...)` but the save still succeeds (`DB.ord` reflects the new stage); moving to `Quoted` with no `Unknown` lines triggers no warning; the warning does not fire for any other stage transition
- **New-record edge case (new in v2):** creating a brand-new Order Request directly with `stage: 'Quoted'` and one or more `Unknown`-status lines triggers the warning (verifies `!existing || existing.stage !== 'Quoted'`, not just the `existing`-truthy case)
- **Structural enforcement (new in v2):** a code review / build-gate check confirming no direct `line[field] = value` assignment exists outside `ordLogLineUpdate()`/`ordConfirmLineUpdate()` anywhere in the shipped diff — this is a static-inspection requirement, not a unit-testable one, but must be explicitly checked at build-gate per §2
- `saveOrdFromForm()` → `saveOrd()` wiring: confirm a new Order Request is created with `lines: []`, and an edited existing Order Request preserves its prior `lines[]` array through the save (regression-testing the fix for the v1 wiring gap)
- Regression: all existing tests (350) continue to pass

## 10. Rollout

1. Build per §1–§7
2. Run `node tests/run.js` — all existing + new tests pass
3. `build-gate` review of the resulting diff against this spec
4. Log ORD-GAP-002 (§8)
5. Version bump, changelog, `AI_SYSTEM_PROMPT` update (new `update_order_line` action + Order Request line-items behavior), PR

## 11. Changelog

**v2 (this version):** Resubmitted after spec-gate FAIL on v1. Four findings addressed:
1. **§1 `saveOrdFromForm()`/`saveOrd()` wiring gap fixed** — v1 never added a `lines` key to the object `saveOrdFromForm()` builds, which meant §4's warning logic would always evaluate against `undefined`/`[]`, silently defeating its own Acceptance Criterion. v2 requires `lines: existing ? existing.lines : []` explicitly.
2. **§2/§5 AC-002 structural enforcement added** — v1 only showed that `ordLogLineUpdate()` satisfies the "always logged" invariant when called, but never mandated that UI-driven edits actually call it rather than mutating a line field directly. v2 states this as a hard contract (§5), flags any direct assignment as a build-gate-checkable spec deviation, and adds `ordConfirmLineUpdate()`'s full body (previously only described in prose).
3. **`saveAll()`/`sv()` call sites pinned down** — v1 only specified persistence for the AI action branch. v2 states both `ordLogLineUpdate()` and `ordConfirmLineUpdate()` call `sv(K.ord, DB.ord)` directly (matching `ordAdminOverride()`'s existing pattern), removing the now-redundant `saveAll()` call from the AI action branch.
4. **§4 new-record-as-`Quoted` edge case addressed explicitly** — v1's condition (`existing && existing.stage !== 'Quoted'`) silently skipped the warning for a brand-new record created directly at `Quoted`. v2 corrects the condition (`!existing || existing.stage !== 'Quoted'`) and explains why the warning (unlike the hard transition gate, which retains its pre-existing new-record blind spot by design) should not inherit that same gap.

Also incorporated: an explicit code-comment in §3's AI action handler noting `confirmedBy` is hardcoded (never read from the AI payload), addressing the spec-gate review's question about payload tampering.

**v1:** Initial spec derived from REQ-ORD-002-v2 (requirements-gate PASS). FAIL — spec-gate found a critical wiring gap that would have silently defeated AC-004, an unenforced AC-002 guarantee, missing persistence call-site specification, and an unaddressed new-record edge case.
