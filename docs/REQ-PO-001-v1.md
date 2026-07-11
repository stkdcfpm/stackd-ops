# REQ-PO-001 — Split Quote→PO Conversion by Supplier (fixes PO-GAP-001)

**Status:** Draft v1 — not yet submitted to requirements-gate
**Version:** 1
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** PO-GAP-001 (`docs/known-gaps.md`), QTE-GAP-001 (Quote status enforcement, v2.9.25), REQ-ORD-001-v3/SPEC-ORD-001-v3 (Order Management release this fix is recommended to land alongside)

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
- Any retroactive correction of POs already created (incorrectly) by the current buggy conversion — out of scope for this requirement; a data-repair utility is a separate, later decision if the operator determines historical POs need auditing

## 4. Schema Impact

**This changes `Quote.linkedPOId` from a scalar string to `Quote.linkedPOIds`, an array of strings.** This is a real schema-shape change to an existing, live entity field — not a new-field addition — and per this codebase's established discipline (see SPEC-DATA-001's `backfillRefNums()` history, and the general principle that state-layer changes are unrecoverable in a localStorage-only app), **this must go through schema-migration-reviewer**, not just spec-gate, before build.

**Backward compatibility for existing Quotes:** any Quote already carrying a `linkedPOId` (scalar) from before this change must not be silently orphaned. Proposed approach (to be confirmed at spec stage): a one-time, idempotent migration function reads any Quote with a `linkedPOId` (old scalar field, non-empty) and no `linkedPOIds` (new field, absent), and sets `linkedPOIds: [q.linkedPOId]` — preserving the existing single-PO link exactly as-is, since it was correct for any single-supplier Quote (the common case today) and only wrong for multi-supplier Quotes, which this migration cannot retroactively fix (per §3's out-of-scope note) but also must not break.

## 5. Acceptance Criteria

- AC-001: `qteToPoConvert()` produces exactly one PO per distinct `supId` present in `q.lines[]` (including a `supId: ''` group for lines with no supplier, if any exist)
- AC-002: Each generated PO contains only the lines belonging to its supplier group — no line ever appears on more than one PO, and no PO ever contains a line whose `supId` doesn't match its own `supId`
- AC-003: `Quote.linkedPOIds` (array) replaces `linkedPOId` (scalar); every UI location currently reading the scalar is updated to check array length / iterate, with no location left reading the old field name post-migration
- AC-004: A one-time idempotent migration converts any existing `linkedPOId` scalar to `linkedPOIds: [value]` without data loss, and does not run more than once per existing record (matching the established `backfillRefNums()`/`seedAdHocBuyer()` idempotency pattern)
- AC-005: The "PO RAISED" badge and Convert-to-PO button guard correctly reflect "one or more POs already exist" (button hidden, badge shown) rather than checking a single ID's truthiness
- AC-006: Re-running conversion on an already-converted Quote is still blocked (existing guard behavior preserved, generalized to "any POs already linked" rather than "the single PO already linked")
- AC-007: All existing tests continue to pass; new tests cover: single-supplier Quote (regression — must still produce exactly one PO, unchanged behavior), multi-supplier Quote (must produce one PO per supplier, correct line attribution), a Quote with a mix of supplier-assigned and unassigned (`supId: ''`) lines, and the `linkedPOId` → `linkedPOIds` migration (idempotency + no data loss)

## 6. Known Gap Being Fixed

**PO-GAP-001** (`docs/known-gaps.md`) — this requirement is the fix. PO-GAP-001 should be updated from "Open" to "Fixed" once this ships, citing the version.

## 7. Changelog

**v1 (this version):** Initial draft, addressing PO-GAP-001, recommended to land alongside or immediately after SPEC-ORD-001 given Order Requests make multi-supplier baskets a routine input.
