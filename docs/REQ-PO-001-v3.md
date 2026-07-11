# REQ-PO-001 — Split Quote→PO Conversion by Supplier (fixes PO-GAP-001)

**Status:** Draft v3 — requirements-gate FAILED v2 on one remaining finding (a factual error in §5's FM-1 argument: claimed `FIELD_MAPS.qt` doesn't exist, but it does — it's just unused); this revision corrects it (see §8 Changelog)
**Version:** 3
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** PO-GAP-001 (`docs/known-gaps.md`), QTE-GAP-001 (Quote status enforcement, v2.9.25), REQ-ORD-001-v3/SPEC-ORD-001-v3 (Order Management release this fix is recommended to land alongside), STACKD_CONTEXT.md FM-1 exception clauses
**Supersedes:** REQ-PO-001-v2 (requirements-gate FAIL — see §8 Changelog)

---

## 1. Business Context

`qteToPoConvert()` (`index.html`) converts an `Accepted` Quote into a Purchase Order. It currently creates exactly **one** PO from the entire Quote, using whichever line happens to be first in `q.lines[]` with a non-empty `supId` as the PO's supplier — every other line is copied onto that same PO regardless of its own, potentially different, `supId`:

```js
var firstSup = (q.lines||[]).find(function(l){ return l.supId; });
var po = { ..., supId: firstSup ? firstSup.supId : '', lines: (q.lines||[]).map(...), ... };
```

This was discovered as a real, live defect (not hypothetical) while reviewing a genuine multi-category procurement basket for the Order Management release — a single requisition spanning seeds, salt fish (China), mulching film/irrigation, sunflower oil, plastic bags, fertiliser (North Africa), fresh produce, and equipment, each line naturally belonging to a different supplier. Quoted as one Quote (the natural unit for "this is one customer's order," which is also how Order Requests per REQ-ORD-001 are meant to work — one `activeQuoteId` per Order Request), converting to PO today would silently misattribute every line except the first supplier's lines to the wrong PO. There is no error, warning, or split — the data is simply wrong, in a way an operator would only catch by manually auditing every PO line against the Quote afterward.

**Why this matters now, specifically:** Order Requests (SPEC-ORD-001) are designed around exactly this shape — a single Contact's request may reasonably span many product categories and countries of origin in one Quote. This bug turns that from a rare edge case into a routine, expected failure mode the moment Order Management ships, unless fixed first or alongside.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | POs correctly attributed to the supplier that actually owes/is owed for each line — this is money, not cosmetic |
| Suppliers | FPM's trading partners | Receive a PO that actually reflects what they're being asked to supply, not another supplier's lines |
| Order Management (dependent feature) | REQ-ORD-001/SPEC-ORD-001 | A correct one-Quote-to-many-POs conversion path, since multi-supplier baskets are the expected input shape |

## 3. Scope

### In scope
- `qteToPoConvert()` groups `q.lines[]` by `supId` and creates **one PO per distinct supplier group**, each PO containing only that supplier's lines
- `Quote.linkedPOId` (scalar) becomes `Quote.linkedPOIds` (array) — see §4 for the schema change and migration approach
- Every UI surface currently reading `q.linkedPOId` (list-view "PO linked" badge, Convert-to-PO button visibility guard, "PO RAISED" edit-modal badge, `saveQte()`'s edit-preservation of the field) updated to the array-aware equivalent
- Lines with no `supId` at all (should not normally occur, but the current code already defensively handles a missing `supId` with `''`) are grouped into their own PO with `supId: ''`, **not** silently dropped or merged into an arbitrary supplier's PO — this is itself a corrected behavior versus today, where a line with no `supId` currently ends up on the firstSup PO regardless
- Demo data (`loadDemoData()`) updated to the new field shape (`linkedPOIds: [poId]`)

### Out of scope
- Any change to how a Quote's lines get their `supId` assigned in the first place (unrelated — that's a data-entry concern, this is a conversion-logic concern)
- Any change to PO's own shape beyond what's needed to support this (POs already independently carry `quoteId`/`quoteNum` back-references — that part already supports one-Quote-to-many-POs correctly and needs no change)
- Any retroactive correction of POs already created (incorrectly) by the current buggy conversion — out of scope for this requirement; a data-repair utility is a separate, later decision if the operator determines historical POs need auditing. **Corrected in v2 (requirements-gate finding — this residual risk was left unlogged):** this scope cut must not simply be assumed safe. §7 mandates a new known gap (**PO-GAP-002**) be logged at the same time PO-GAP-001 is marked Fixed, documenting that any PO created before this fix ships, from a multi-supplier Quote, may carry incorrect supplier attribution with no automated audit or flag distinguishing it from a correctly-attributed one.

## 4. Schema Impact

**This changes `Quote.linkedPOId` from a scalar string to `Quote.linkedPOIds`, an array of strings.** This is a real schema-shape change to an existing, live entity field — not a new-field addition — and per this codebase's established discipline (see SPEC-DATA-001's `backfillRefNums()` history, and the general principle that state-layer changes are unrecoverable in a localStorage-only app), **this must go through schema-migration-reviewer**, not just spec-gate, before build.

**Backward compatibility for existing Quotes:** any Quote already carrying a `linkedPOId` (scalar) from before this change must not be silently orphaned. Proposed approach (to be confirmed at spec stage): a one-time, idempotent migration function reads any Quote with a `linkedPOId` (old scalar field, non-empty) and no `linkedPOIds` (new field, absent), and sets `linkedPOIds: [q.linkedPOId]` — preserving the existing single-PO link exactly as-is, since it was correct for any single-supplier Quote (the common case today) and only wrong for multi-supplier Quotes, which this migration cannot retroactively fix (per §3's out-of-scope note) but also must not break. **Migration trigger condition, stated explicitly (v2 — see AC-004):** the guard is `q.linkedPOId non-empty AND q.linkedPOIds absent` — a record is migrated exactly once, since after migration `linkedPOIds` is present and the guard no longer matches, identical in shape to `backfillRefNums()`'s `!rec.num` idempotency guard (SPEC-DATA-001-v6 §4).

## 5. FM-1 Compliance

**Added in v2 (requirements-gate finding — this was entirely absent from v1); prong (b) corrected in v3 (requirements-gate finding — factual error).** STACKD_CONTEXT.md's FM-1 exception clause 2 ("new fields on existing entities... permitted where the fields do not require a new sync mapping") is written for *adding* a field, not for *changing the type/cardinality of an existing live field* — `linkedPOId` (scalar) → `linkedPOIds` (array) is the latter, and does not fit clause 2's literal wording on its face. This requirement does not assume it is pre-approved. Position taken: this change (a) requires no new `K` key or `DB` entity (unlike REQ-ORD-001's category-3 case); (b) **corrected in v3** — `FIELD_MAPS.qt` does exist (`index.html:2815`: `qt: { num:'Quote #', client:'Buyer', dt:'Date', status:'Status', currency:'Currency', calc_totalLanded:'Grand Total', markup:'Margin', notes:'Notes' }`), so v2's claim that no such mapping exists was false. The accurate basis for this prong is narrower but still holds: `syncEnt('qt')` is never called anywhere in `index.html` — confirmed by searching the codebase — so `FIELD_MAPS.qt` is currently dead/unused configuration, not an active sync path. Neither `linkedPOId` nor the proposed `linkedPOIds` appears in that map today, and this requirement does not add either field to it. So while a sync mapping does exist for Quotes, it is inert, and this change neither activates it nor touches any field within it; (c) is accompanied by an explicit, idempotent, non-destructive migration path (§4) preserving every existing record's meaning exactly; and (d) is a bug fix restoring correctness to already-intended behavior (a Quote *should* have correctly resulted in the right supplier's PO all along), not a new feature. On this corrected basis, the requirement proposes this is in the spirit of FM-1's exception even though it does not match clause 2's literal "new field" wording — **but this is presented as a judgment call for requirements-gate to confirm, not a foregone conclusion**, consistent with how REQ-ORD-001-v3 §5 handled its own, differently-shaped FM-1 question.

## 6. Acceptance Criteria

- AC-001: `qteToPoConvert()` produces exactly one PO per distinct `supId` present in `q.lines[]` (including a `supId: ''` group for lines with no supplier, if any exist)
- AC-002: Each generated PO contains only the lines belonging to its supplier group — no line ever appears on more than one PO, and no PO ever contains a line whose `supId` doesn't match its own `supId`
- AC-003: `Quote.linkedPOIds` (array) replaces `linkedPOId` (scalar); every UI location currently reading the scalar is updated to check array length / iterate, with no location left reading the old field name post-migration
- AC-004 — **tightened in v2:** the migration runs exactly once per record, gated on the explicit condition stated in §4 (`q.linkedPOId` non-empty AND `q.linkedPOIds` absent); after migration, `q.linkedPOIds` is present (even if `[]` or `[value]`), so the guard cannot re-match on a second run; a record with neither field (a Quote never converted to PO) is left untouched by the migration, not defaulted to `linkedPOIds: []`
- AC-005 — **tightened in v2:** the "PO RAISED" badge's visible text and styling are unchanged from today; only its trigger condition changes from `!!q.linkedPOId` to `q.linkedPOIds && q.linkedPOIds.length > 0`. Same for the Convert-to-PO button's visibility guard and the list-view "PO linked" badge. This requirement does **not** require the badge to additionally display a count or list of PO numbers — that is an optional UI enhancement left to spec stage's discretion, not a required behavior change
- AC-006: Re-running conversion on an already-converted Quote is still blocked (existing guard behavior preserved, generalized to "any POs already linked" rather than "the single PO already linked")
- AC-007: All existing tests continue to pass; new tests cover: single-supplier Quote (regression — must still produce exactly one PO, unchanged behavior), multi-supplier Quote (must produce one PO per supplier, correct line attribution), a Quote with a mix of supplier-assigned and unassigned (`supId: ''`) lines, and the `linkedPOId` → `linkedPOIds` migration (idempotency + no data loss)

## 7. Known Gaps

**PO-GAP-001** (`docs/known-gaps.md`) — this requirement is the fix. PO-GAP-001 should be updated from "Open" to "Fixed" once this ships, citing the version.

**PO-GAP-002 (new, added in v2 — required, not optional, per §3's out-of-scope note):** must be logged at the same time PO-GAP-001 is closed — "POs created before REQ-PO-001 shipped, from a multi-supplier Quote, may carry incorrect supplier attribution on non-first-supplier lines. No automated audit exists to identify which historical POs are affected. Manual review recommended if a specific supplier dispute or reconciliation issue arises referencing a pre-fix PO."

## 8. Changelog

**v3 (this version):** Resubmitted after requirements-gate FAIL on v2's single remaining finding. §5 prong (b) corrected — v2 claimed "`Quote` does not sync to Sheets at all today, so there is no `FIELD_MAPS.qt` entry to update or break," which is factually wrong: `FIELD_MAPS.qt` does exist (`index.html:2815`). The corrected, narrower-but-accurate basis: the mapping exists but `syncEnt('qt')` is never called anywhere in the codebase, so it is dead/unused configuration; neither `linkedPOId` nor `linkedPOIds` appears in it, and this change doesn't add either field to the map or activate the dormant sync path. The overall FM-1 judgment call is unchanged in substance, but now rests on an accurate factual footing.

**v2:** Resubmitted after requirements-gate FAIL on v1. Four findings addressed:
1. **§5 FM-1 Compliance section added** — v1 had none at all. v2 states explicitly that a scalar-to-array field-shape change doesn't literally match FM-1 exception clause 2's "new field" wording, and argues its case (no new K/entity, no Sheets sync mapping exists for Quotes at all, non-destructive migration, bug-fix-not-feature framing) as a judgment call for requirements-gate to confirm, not an assumed pass.
2. **§3/§7 residual-risk logging made mandatory** — v1's "out of scope: no retroactive correction" left the residual risk unlogged. v2 requires a new PO-GAP-002 entry documenting the historical-mis-attribution risk, to be logged at the same time PO-GAP-001 closes.
3. **AC-004 tightened** — now states the exact migration guard condition inline (matching §4) rather than only asserting "idempotent" without saying how.
4. **AC-005 tightened** — now specifies precisely what changes (the trigger condition only) versus what's explicitly not required (a count/list display), removing the ambiguity a tester and builder could otherwise diverge on.

**v1:** Initial draft, addressing PO-GAP-001, recommended to land alongside or immediately after SPEC-ORD-001 given Order Requests make multi-supplier baskets a routine input. FAIL — requirements-gate found no FM-1 assessment, an unaddressed residual risk for historical mis-attributed POs, and two under-specified Acceptance Criteria.
