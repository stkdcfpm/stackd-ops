# SPEC-ORD-002 — Order Request Line Items: Packaging/UOM Model and Field-Level Update Log

**Derived from:** REQ-ORD-002-v2 (requirements-gate PASS)
**Status:** Draft v1 — first spec submission
**Date:** 2026-07-12
**Author:** FPM International / Claude Code
**Related:** SPEC-ORD-001-v4 (`DB.ord` entity, shipped v2.9.44), `handleAIAction()` (existing AI propose-never-auto-save pattern)

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
  return true;
}
```

**Key invariant (REQ-ORD-002-v2 AC-002/AC-003):** every call appends to `lineUpdates[]`, but the live field (`line[field]`) is only overwritten when `confirmedBy` is truthy. This is what makes AI-sourced proposals safe by construction: `source: 'ai'` calls always pass `confirmedBy: null`, so `ordLogLineUpdate()` records the proposal without ever touching the line's live value — no separate "is this AI-sourced" branch is needed, the same function serves both the "operator directly edits a field" case (`confirmedBy: 'operator'`, applied immediately) and the "AI proposes, operator reviews later" case (`confirmedBy: null`, not applied) uniformly.

**Operator confirming a pending AI proposal:** a new function `ordConfirmLineUpdate(ord, lineId, updateId)` finds the specific `lineUpdates[]` entry by `id`, sets `entry.confirmedBy = 'operator'`, and applies `entry.newValue` to `line[entry.field]` at that point — this is the only place a `source: 'ai'` entry's value can reach the live field.

## 3. AI Action: `update_order_line`

Extends `handleAIAction()` (`index.html:7165`) with a new branch, following the exact pre-fill-never-auto-save pattern already used for `create_po`/`create_quote`/etc.:

```js
} else if (action.action === 'update_order_line') {
  // payload: { ordId, lineId, field, newValue, note }
  var ord = DB.ord.find(function(o){ return o.id === p.ordId; });
  if (ord) {
    ordLogLineUpdate(ord, p.lineId, p.field, p.newValue, 'ai', p.note || '', null); // confirmedBy: null — proposal only
    saveAll();
    openOrd(ord.id); // re-open the modal so the operator sees the pending proposal in the line's update log
  }
}
```

Since `confirmedBy` is always `null` for this action, the call to `ordLogLineUpdate()` above never touches the line's live field — it only ever appends a pending, review-only entry. This makes the "never auto-save" guarantee structural (enforced by the shared function's own logic), not just a convention the new branch has to remember to honor.

`AI_SYSTEM_PROMPT`'s action-block documentation (`index.html`, the `ACTION BLOCKS` prompt text) gets a new line for `update_order_line → { ordId, lineId, field, newValue, note }`, alongside the existing action key list.

## 4. Stage-Transition Warning (Qualifying → Quoted)

Per REQ-ORD-002-v2 §3/§5 AC-004 (a **non-blocking warning**, not a gate — corrected from the FAILed v1's contradictory hard-block): `ordCanTransition()` (`index.html:2321-2323`) is **not modified**. Instead, `saveOrdFromForm()`'s existing validation path (`index.html:2399-2403`, which already calls `vErr('of-stage', ...)` for the transition-table check) gains one additional, non-blocking check:

```js
// Inside saveOrdFromForm(), after the existing ordCanTransition() check passes:
if (ord.stage === 'Quoted' && existing && existing.stage !== 'Quoted') {
  var unresolvedCount = (ord.lines || []).filter(function(l){ return l.qtyStatus === 'Unknown'; }).length;
  if (unresolvedCount > 0) {
    vWarn('of-stage', unresolvedCount + ' line(s) have unresolved quantity — quoting may be premature');
  }
}
```

`vWarn()` (`index.html:5728-5735`) is the existing amber-styled, non-blocking validation helper (distinct from `vErr()`, which blocks). The save proceeds regardless of this warning — it only informs.

## 5. UI Surface

- Order Request modal (`ov-ord`) gains a line-items sub-section: a table listing each line's `category`/`itemSpec`/`orderVolumeQty+Unit`/`packingSpec`/`baseUom`/`baseQty`/`qtyStatus`, with add/edit-in-place controls, mirroring the existing `of-actions-list` pattern already built for the actions array (SPEC-ORD-001 §5)
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
- Regression: all existing tests (350) continue to pass

## 10. Rollout

1. Build per §1–§7
2. Run `node tests/run.js` — all existing + new tests pass
3. `build-gate` review of the resulting diff against this spec
4. Log ORD-GAP-002 (§8)
5. Version bump, changelog, `AI_SYSTEM_PROMPT` update (new `update_order_line` action + Order Request line-items behavior), PR

## 11. Changelog

**v1 (this version):** Initial spec derived from REQ-ORD-002-v2 (requirements-gate PASS).
