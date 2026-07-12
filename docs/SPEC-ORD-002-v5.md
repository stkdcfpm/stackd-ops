# SPEC-ORD-002 — Order Request Line Items: Packaging/UOM Model and Field-Level Update Log

**Derived from:** REQ-ORD-002-v2 (requirements-gate PASS)
**Status:** Draft v5 — schema-migration-reviewer PASSED the three v3 findings but found a new MAJOR issue in v4's own fix: the `saveOrdFromForm()` wiring (`lines: existing ? existing.lines : []`) sets `lines: undefined` (not `[]`) for a pre-existing lines-less record, which `JSON.stringify` silently drops on persist — so the spec's own claim that a plain resave "guarantees `lines` is present" was false; this revision corrects the wiring itself so a resave genuinely heals the field (see §11 Changelog)
**Date:** 2026-07-12
**Author:** FPM International / Claude Code
**Related:** SPEC-ORD-001-v4 (`DB.ord` entity, shipped v2.9.44), `handleAIAction()` (existing AI propose-never-auto-save pattern)
**Supersedes:** SPEC-ORD-002-v4 (schema-migration-reviewer FAIL — see §11 Changelog)

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

**Required wiring — added in v2 (spec-gate CRITICAL finding); corrected in v5 (schema-migration-reviewer MAJOR finding).** `saveOrdFromForm()` (`index.html:2503-2519`) currently builds the `ord` object it passes to `saveOrd()` from a **closed field list** — `id`, `contactId`, `stage`, `description`, `actions`, `activeQuoteId`, `outcome` — with no `lines` key at all. v1's §4 warning logic (`(ord.lines || []).filter(...)`) would therefore always evaluate against `undefined` → `[]`, silently defeating its own Acceptance Criterion. This spec requires `saveOrdFromForm()`'s object literal to add: `lines: existing ? (existing.lines || []) : []` — **note the `|| []` on the existing-record branch, added in v5.** v4's version (`lines: existing ? existing.lines : []`) evaluates to `lines: undefined` for a pre-existing record that has no `lines` field, and `JSON.stringify` (used by `sv()` to persist to localStorage) silently drops any object property whose value is `undefined` — so v4's fix, despite looking like it assigns an empty array, actually wrote the record back with **no `lines` key at all**, identical to before the resave. The `|| []` addition means a plain resave of an old record now genuinely heals it to `lines: []`, not just "until next resave" as v4 incorrectly claimed but never delivered. New Order Requests are created with `lines: []`; existing records with a populated `lines` array carry it through the save unchanged, matching the existing pattern already used for `actions`.

### 1a. `backfillOrderRequests()` must also initialize `lines: []` — added in v4 (schema-migration-reviewer CRITICAL finding)

`backfillOrderRequests()` (`index.html:2352-2392`) creates new `DB.ord` records via two `DB.ord.push({...})` calls — one for Tier 1 (from Quotes with `sourceContactId`, `index.html:2366`), one for Tier 2 (from Contact enquiry logs, `index.html:2382`) — **neither of which includes a `lines` key**. Since this spec's §1 wiring fix only touches `saveOrdFromForm()`, every backfilled record would otherwise be created permanently missing the field until an operator happens to open and re-save it through the form — a guaranteed crash case for `ordLogLineUpdate()`/`ordConfirmLineUpdate()` (§2) or any §5 UI code that assumes `ord.lines` is an array. This spec requires both `DB.ord.push({...})` object literals in `backfillOrderRequests()` to add `lines: []`.

## 2. `lineUpdates[]` — Append-Only Field Log

A new function `ordLogLineUpdate(ord, lineId, field, newValue, source, note, confirmedBy)`:

```js
var ORD_LINE_UPDATES_CAP = 200; // see "Retention cap" note below

function ordLogLineUpdate(ord, lineId, field, newValue, source, note, confirmedBy) {
  if (!ord.lines) return false;
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line) return false;
  if (!line.lineUpdates) line.lineUpdates = [];
  var oldValue = line[field];
  line.lineUpdates.push({
    id: uid(), ts: new Date().toISOString(), source: source,
    field: field, oldValue: oldValue, newValue: newValue, note: note || '',
    confirmedBy: confirmedBy || null
  });
  if (line.lineUpdates.length > ORD_LINE_UPDATES_CAP) {
    line.lineUpdates.splice(0, line.lineUpdates.length - ORD_LINE_UPDATES_CAP); // drop oldest, FIFO
  }
  if (confirmedBy) line[field] = newValue; // only a confirmed update changes the live field
  sv(K.ord, DB.ord);
  return true;
}
function ordConfirmLineUpdate(ord, lineId, updateId) {
  if (!ord.lines) return false;
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line || !line.lineUpdates) return false;
  var entry = line.lineUpdates.find(function(u){ return u.id === updateId; });
  if (!entry || entry.confirmedBy) return false; // already confirmed, or not found — no-op
  entry.confirmedBy = 'operator';
  line[entry.field] = entry.newValue;
  sv(K.ord, DB.ord);
  return true;
}
```

**Defensive against missing `lines`/`lineUpdates` — added in v4 (schema-migration-reviewer CRITICAL finding); corrected in v5 (schema-migration-reviewer MAJOR finding on what the wiring fix actually delivers).** Every `DB.ord` record created before this spec ships — all of SPEC-ORD-001's shipped output — has no `lines` field in localStorage at all, until either `backfillOrderRequests()` re-runs (it doesn't touch pre-existing records, only creates new ones — §1a) or the record is saved through `saveOrdFromForm()` at least once. **Corrected in v5:** with the `|| []` fix in §1's wiring, an ordinary resave through the form **does** now genuinely heal a lines-less record to `lines: []` — this was previously (v4) claimed but not actually true, due to the `undefined`-property-dropped-by-`JSON.stringify` bug described in §1. What still does **not** help: a record that is opened for the very first time via the new line-item UI, or targeted directly by the `update_order_line` AI action (§3), before any resave has happened at all — for that narrow window, `ord.lines` is still genuinely absent in memory (read directly from `DB.ord`, not yet round-tripped through `saveOrdFromForm()`). Both functions above therefore still guard with `if (!ord.lines) return false;` at the top, and `ordLogLineUpdate()` additionally lazily initializes `line.lineUpdates = []` if absent. **Why no retroactive migration function:** unlike `backfillRefNums()` (which must run once to make every record correct), a missing `lines`/`lineUpdates` array is not incorrect data needing repair — it correctly means "no line items exist yet for this Order Request." The defensive guards, combined with the now-actually-working resave healing, are sufficient; inventing a dedicated empty-array migration would add a fourth `initApp()`/`doImport()` call site for no behavioral benefit beyond what these two mechanisms already provide together.

**Retention cap — added in v4 (schema-migration-reviewer MAJOR finding: no cap was previously stated for an unbounded, append-only structure, unlike the existing `DB.events` precedent).** `DB.events` is explicitly FIFO-capped at 2,000 entries (`index.html:2551-2552`, with the known, accepted UX gap EVT-GAP-001 — no user-visible warning on silent drop). `lineUpdates[]` is nested per-line, per-Order-Request, with no equivalent stated previously. This spec sets `ORD_LINE_UPDATES_CAP = 200` per line (not per Order Request, not global) — generous relative to any real line's expected negotiation history (a handful of buyer/supplier/AI/operator touches over a line's lifecycle, not thousands), FIFO-evicting the oldest entries once exceeded, mirroring `DB.events`' "silently drop the oldest, no user-visible warning" precedent exactly (i.e., this inherits EVT-GAP-001's same accepted trade-off, not a new one). **Known risk, inherited from the same precedent:** if more than 200 updates accumulate on one line before a pending (unconfirmed) entry is reviewed, that pending entry could be silently evicted before the operator ever sees it. Given 200 is far beyond any realistic per-line update count, this is treated the same way `DB.events`' 2,000 cap already treats the analogous risk for the global log — accepted, not solved, consistent with the existing precedent rather than inventing a new one.

**Key invariant (REQ-ORD-002-v2 AC-002/AC-003):** every call to `ordLogLineUpdate()` appends to `lineUpdates[]`, but the live field (`line[field]`) is only overwritten when `confirmedBy` is truthy. This is what makes AI-sourced proposals safe by construction: `source: 'ai'` calls always pass `confirmedBy: null`, so `ordLogLineUpdate()` records the proposal without ever touching the line's live value — no separate "is this AI-sourced" branch is needed, the same function serves both the "operator directly edits a field" case (`confirmedBy: 'operator'`, applied immediately) and the "AI proposes, operator reviews later" case (`confirmedBy: null`, not applied) uniformly. **Corrected in v3 (spec-gate finding — the v2 citation was fabricated):** both functions call `sv(K.ord, DB.ord)` directly, **not** `saveAll()`. v2 claimed this "matches the existing pattern already used by `ordAdminOverride()`'s persistence" — this was false; `ordAdminOverride()` (`index.html:2324-2335`) actually calls `saveAll()` at line 2332, not `sv(K.ord, DB.ord)`. The `sv(K.ord, DB.ord)` choice here is justified on its own merits, not by a borrowed precedent: only `DB.ord` is mutated by either function, so persisting via the entity-specific `sv()` call is sufficient and avoids the unnecessary overhead of `saveAll()`'s full multi-entity write — a legitimate, self-standing design choice that does not need (and should not have claimed) an existing-pattern justification it didn't actually have.

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
- **Defensive-guard regression (new in v4 — schema-migration-reviewer finding):** `ordLogLineUpdate()` and `ordConfirmLineUpdate()` called against a `DB.ord` fixture with no `lines` key at all must return `false` without throwing
- **`backfillOrderRequests()` initializes `lines: []` (new in v4):** both Tier 1 and Tier 2 backfilled records carry an empty `lines` array, not a missing field
- **Retention cap (new in v4):** pushing more than `ORD_LINE_UPDATES_CAP` (200) entries onto one line's `lineUpdates[]` retains only the most recent 200, oldest evicted first
- **Resave-heals-missing-`lines` regression (new in v5 — schema-migration-reviewer finding):** a `DB.ord` fixture with no `lines` key at all, saved via `saveOrdFromForm()`/`saveOrd()` through the ordinary edit path (stage/description change, no line-item UI touched), ends up with `lines: []` afterward — not `undefined`, and not still absent. This specifically catches the v4 bug where `JSON.stringify` would have silently dropped an `undefined`-valued property, leaving the field genuinely missing despite the wiring fix appearing to set it
- Regression: all existing tests (350) continue to pass

## 10. Rollout

1. Build per §1–§7
2. Run `node tests/run.js` — all existing + new tests pass
3. `build-gate` review of the resulting diff against this spec
4. Log ORD-GAP-002 (§8)
5. Version bump, changelog, `AI_SYSTEM_PROMPT` update (new `update_order_line` action + Order Request line-items behavior), PR

## 11. Changelog

**v5 (this version):** schema-migration-reviewer ran against v4 and confirmed the three v3 findings were correctly resolved, but surfaced one new MAJOR issue in v4's own fix (requested as part of an internal-consistency check between §1 and §2): v4's wiring fix, `lines: existing ? existing.lines : []`, evaluates to `lines: undefined` for a pre-existing record with no `lines` field — and `JSON.stringify` (used by `sv()` for localStorage persistence) silently drops any object property whose value is `undefined`. So v4's fix, despite reading as if it assigns an empty array, actually persisted the record with **no `lines` key at all** — identical to before the resave — directly contradicting §2's own claim that a resave "guarantees `lines` is present." v5 corrects the wiring to `lines: existing ? (existing.lines || []) : []` (note the added `|| []`), so an ordinary resave now genuinely heals a lines-less record. §2's rationale prose is corrected to match reality rather than the previously-incorrect claim. A new test case (§9) specifically catches this class of bug: assert the actual post-save value, not just that the code "looks like" it sets one.

**v4:** schema-migration-reviewer ran against v3 (spec-gate PASS) and FAILED on three findings, all addressed:
1. **§2 CRITICAL — `ordLogLineUpdate()`/`ordConfirmLineUpdate()` crash on pre-existing records.** Every `DB.ord` record shipped under SPEC-ORD-001 (and anything created by `backfillOrderRequests()` before this fix) has no `lines` field at all — calling either function against one would throw. Both now guard with `if (!ord.lines) return false;`, with an explicit rationale for why no retroactive migration function is needed (a missing array correctly means "no lines yet," not corrupted data).
2. **§1a CRITICAL — `backfillOrderRequests()` never initialized `lines: []`.** Both its Tier 1 and Tier 2 `DB.ord.push({...})` calls (`index.html:2366`, `2382`) are now required to include `lines: []`, closing the gap at its source rather than relying solely on the defensive guards in finding 1.
3. **§2 MAJOR — no retention cap on the unbounded, append-only `lineUpdates[]`,** unlike the existing `DB.events` 2,000-entry FIFO precedent (`index.html:2551-2552`, EVT-GAP-001). v4 sets `ORD_LINE_UPDATES_CAP = 200` per line, FIFO-evicting oldest entries, explicitly inheriting `DB.events`' same accepted "no user-visible warning" trade-off rather than solving it anew.

New tests added (§9) for all three: defensive-guard behavior on a lines-less fixture, `backfillOrderRequests()`'s `lines: []` initialization, and the retention cap's eviction behavior.

**v3:** Resubmitted after spec-gate FAIL on v2. Two findings addressed:
1. **§2 `ordAdminOverride()` citation corrected** — v2 claimed `ordLogLineUpdate()`/`ordConfirmLineUpdate()`'s `sv(K.ord, DB.ord)` persistence "matches the existing pattern already used by `ordAdminOverride()`," which is false (`ordAdminOverride()` calls `saveAll()`, not `sv()`). v3 removes the fabricated precedent and justifies the `sv()` choice on its own merits (only `DB.ord` changes, so the entity-specific call is sufficient).
2. **§9 test-count figure re-verified** — spec-gate flagged "350" as inconsistent with `CLAUDE.md`'s then-stated baseline of 349/349. Re-ran `node tests/run.js` directly: the actual current count is genuinely **350/350** — `CLAUDE.md` had simply not been updated after a UAT bugfix landed outside a formal version-delivery cycle. The spec's figure was correct; `CLAUDE.md` is being corrected separately (not a spec change).

**v2:** Resubmitted after spec-gate FAIL on v1. Four findings addressed:
1. **§1 `saveOrdFromForm()`/`saveOrd()` wiring gap fixed** — v1 never added a `lines` key to the object `saveOrdFromForm()` builds, which meant §4's warning logic would always evaluate against `undefined`/`[]`, silently defeating its own Acceptance Criterion. v2 requires `lines: existing ? existing.lines : []` explicitly.
2. **§2/§5 AC-002 structural enforcement added** — v1 only showed that `ordLogLineUpdate()` satisfies the "always logged" invariant when called, but never mandated that UI-driven edits actually call it rather than mutating a line field directly. v2 states this as a hard contract (§5), flags any direct assignment as a build-gate-checkable spec deviation, and adds `ordConfirmLineUpdate()`'s full body (previously only described in prose).
3. **`saveAll()`/`sv()` call sites pinned down** — v1 only specified persistence for the AI action branch. v2 states both `ordLogLineUpdate()` and `ordConfirmLineUpdate()` call `sv(K.ord, DB.ord)` directly, removing the now-redundant `saveAll()` call from the AI action branch.
4. **§4 new-record-as-`Quoted` edge case addressed explicitly** — v1's condition (`existing && existing.stage !== 'Quoted'`) silently skipped the warning for a brand-new record created directly at `Quoted`. v2 corrects the condition (`!existing || existing.stage !== 'Quoted'`) and explains why the warning (unlike the hard transition gate, which retains its pre-existing new-record blind spot by design) should not inherit that same gap.

Also incorporated: an explicit code-comment in §3's AI action handler noting `confirmedBy` is hardcoded (never read from the AI payload), addressing the spec-gate review's question about payload tampering.

**v1:** Initial spec derived from REQ-ORD-002-v2 (requirements-gate PASS). FAIL — spec-gate found a critical wiring gap that would have silently defeated AC-004, an unenforced AC-002 guarantee, missing persistence call-site specification, and an unaddressed new-record edge case.
