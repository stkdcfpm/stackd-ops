# REQ-ORD-002 — Order Request Line Items: Packaging/UOM Model and Field-Level Update Log

**Status:** Draft v2 — requirements-gate FAILED v1 on three findings (AC-004/§7 self-contradiction, unspecified gating-check mechanism, unaddressed `lineUpdates[].note` free-text GDPR risk); this revision resolves all three (see §8 Changelog)
**Version:** 2
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** REQ-ORD-001-v3/SPEC-ORD-001-v4 (Order Requests — shipped in PR #59, `DB.ord` entity), Quote Engine (`DB.qt[].lines[]`, existing packaging-agnostic shape)
**Depends on:** REQ-ORD-001/SPEC-ORD-001 having shipped (`DB.ord` must already exist)
**Supersedes:** REQ-ORD-002-v1 (requirements-gate FAIL — see §8 Changelog)

---

## 1. Business Context

Order Requests (`DB.ord`, shipped via PR #59) currently carry a single free-text `description` field and nothing else structured about what's actually being requested — confirmed against the live `saveOrd()` (`index.html:2394`) and the record shape it persists (`contactId`, `stage`, `description`, `actions[]`, `activeQuoteId`, `outcome`, `createdAt`, `num`). There is no `lines[]` array on an Order Request, unlike Quotes (`DB.qt[].lines[]`), which already have a flat per-line shape (`desc`, `sku`, `uom`, `qty`, `cost`, `dutyPct`, `hsCode`, `supId`).

This gap was surfaced concretely while normalizing a real, messy multi-category procurement intake (seeds, salt fish, mulching film, irrigation, sunflower oil, plastic bags, fertiliser, fresh produce, equipment — 37 line items across 9 categories and 3 sourcing countries) into a spreadsheet ahead of testing Order Management. Two distinct problems emerged that neither `DB.ord`'s current shape nor Quote's existing `lines[]` shape can represent:

**Problem 1 — Order Volume vs. Base UOM are different dimensions, routinely conflated.** A requester states an order in logistics/shipping units ("1 container," "3 pallets," "50,000 bags"), but costing (`cQteLine()`) needs a base sellable/costable unit (kg, packet, unit) and a quantity in that unit. The conversion between the two (packing hierarchy: base unit → pack → case → pallet → container) is frequently **unknown at intake** and only resolves once a supplier confirms actual packing specs. Quote's existing `qty`/`uom`/`cost` shape is a single flat pair — it has no way to hold "the ask" (order volume) and "the costable quantity" (base qty) as two distinct, independently-timestamped values, nor a status flag distinguishing a confirmed base quantity from an estimated one.

**Problem 2 — No field-level provenance log.** A line's packing spec, base UOM, base quantity, or source country can each be touched multiple times before they're settled — an operator's initial estimate, then a supplier's confirmation, then a buyer's later change request. Today, saving any Quote or Order Request line simply overwrites the previous value with no record of who supplied it, when, or why it changed. This is the same problem the codebase has already solved for other entities (Contact `enquiries[]`, Invoice `editHistory[]`, Order Request `actions[]` — all append-only, timestamped, sourced logs) but has not yet been applied to line-item-level fields on any entity.

**Why this matters for the AI assistant specifically:** the existing AI action pattern (`create_supplier`, `create_po`, etc. — `handleAIAction()`) always proposes, never auto-saves. Extending this to line-item field updates (e.g., the AI picks up "the supplier confirmed 5kg boxes, 2-per-carton" from a chat and proposes updating a specific line's packing spec) requires the field-level log from Problem 2 to exist first — there's currently nowhere for an AI-sourced update to land pending operator confirmation, distinct from a supplier- or buyer-sourced one.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | See what was actually asked for, what's confirmed vs. estimated, and who said what and when, per line |
| Buyer/Supplier (indirect) | FPM's trading partners | Their confirmations are accurately captured and attributed, not silently overwritten |
| AI Assistant | Built-in Stackd Ops AI | A defined, reviewable place to propose line-level updates from conversational context, consistent with its existing propose-never-auto-save pattern |
| Future migration | v3.0.0 Supabase cutover (FM-1) | A line-item shape that's additive to the existing Order Request/Quote entities, not a parallel duplicate |

## 3. Scope

### In scope
- A new `lines[]` array on `DB.ord` records (Order Requests currently have none — this is the primary gap)
- Per-line packaging/UOM model: `orderVolumeQty` + `orderVolumeUnit` (the stated ask, e.g. "1 container"), `packingSpec` (free text or structured, often initially unknown), `baseUom` + `baseQty` (the costable quantity, nullable until resolved), and a `qtyStatus` enum (`Unknown` / `Estimated` / `Confirmed`)
- A per-line, append-only `lineUpdates[]` log: `{ id, ts, source: 'buyer'|'supplier'|'ai'|'operator', field, oldValue, newValue, note, confirmedBy: 'operator'|null }` — every change to a tracked field is recorded, not just overwritten
- A new AI action type, `update_order_line` (extending `handleAIAction()`'s existing pattern), which pre-fills a **proposed** `lineUpdates[]` entry (`source: 'ai'`, `confirmedBy: null`) for operator review — never auto-applied to the line's live value
- **Corrected in v2 (requirements-gate finding — was a hard block in v1, self-contradicted by v1's own §7):** a **non-blocking warning**, not a gate, when moving `Qualifying → Quoted` (i.e., "Create Quote" per SPEC-ORD-001 §2.4) while any line's `qtyStatus` is `Unknown` — the operator is shown the count of unresolved lines but the transition is **not prevented**. `ordCanTransition()` itself (the pure stage-lookup function) is untouched; the warning lives alongside the existing `saveOrdFromForm()`/`saveOrd()` validation path (using `vWarn()`, not `vErr()`, since it must not block the save) — see §5 AC-004 for the exact mechanism.

### Out of scope
- Applying this same `lines[]`/packaging model to Quote's existing `lines[]` shape — Quotes already have a working, shipped line-item model for costing; retrofitting it is a larger, separate migration and not needed for Order Requests to capture pre-Quote intake accurately
- A formal packing-hierarchy calculator (e.g., automatically computing base qty from order volume + a structured pack/case/pallet spec) — v1 captures the fields and the provenance log; unit conversion arithmetic is a natural v2 once real usage data shows what conversions actually recur
- Any AI tool for *reading* line-item state (e.g., a `get_order_lines` tool) — this requirement only adds the `update_order_line` proposal action; read-tool parity is a separate, already-familiar gap (see AI-GAP-008's precedent for read/write asymmetry)

## 4. FM-1 Compliance

This adds a **new field (`lines[]`) to an existing entity** (`DB.ord`, shipped under REQ-ORD-001's own FM-1 category-3 argument) — this is FM-1 exception category 2 ("new fields on existing entities... permitted where the fields do not require a new sync mapping"), the same category `num` (SPEC-DATA-001) qualified under, not the more contested category-3 judgment call REQ-ORD-001 itself needed. `DB.ord` has no Sheets sync mapping today (per SPEC-ORD-001-v4 §6) and this requirement does not add one. This should be a more straightforward FM-1 case than REQ-ORD-001 was — requirements-gate should confirm, but the analysis is simpler here.

## 5. Acceptance Criteria

- AC-001: `DB.ord[].lines[]` exists; each line carries `id`, `category`, `itemSpec` (description), `orderVolumeQty`, `orderVolumeUnit`, `packingSpec`, `baseUom`, `baseQty` (nullable), `qtyStatus` (`Unknown`/`Estimated`/`Confirmed`), `sourceCountry`, `variantOption`, `lineUpdates[]`
- AC-002: `lineUpdates[]` is append-only — saving a line-item field change always adds a new `lineUpdates[]` entry (with `source`, timestamp, old/new value) in addition to updating the live field value; no update overwrites or removes a prior log entry
- AC-003: `update_order_line` action: AI proposes a `lineUpdates[]` entry with `source: 'ai'`, `confirmedBy: null`; the line's live field value is **not** changed until an operator explicitly confirms the proposed entry (same review-and-confirm UX pattern as `create_supplier`/`create_po`)
- AC-004 — **corrected in v2 (requirements-gate finding: contradicted v1's own §7, and the mechanism was unspecified):** `ordCanTransition()` (`index.html:2321-2323`, a pure stage-lookup function with no access to `lines[]`) is **not modified** — this is not a hard gate. Instead, `saveOrd()`/`saveOrdFromForm()` (the existing validation path already using `vErr('of-stage', ...)` for the transition-table check, `index.html:2399-2403`) gains one additional check specifically when the new stage is `'Quoted'`: if any line in `ord.lines` has `qtyStatus === 'Unknown'`, call `vWarn('of-stage', N + ' line(s) have unresolved quantity — quoting may be premature')` — a non-blocking warning styling (amber, per the existing `vWarn()` convention already used elsewhere, e.g. HS-code lookup and payment-date checks), **not** `vErr()`. The save proceeds regardless; the operator is informed, not stopped. No new validation element ID is needed — `vWarn()` targets the same `of-stage` field the existing `vErr()`/`vOk()` calls already use.
- AC-005: `qtyStatus` is independently settable per line, not inferred automatically from whether `baseQty` is populated (an operator may have a confirmed `baseQty` of exactly zero, or may deliberately mark a populated estimate as `Estimated` rather than `Confirmed`)
- AC-006: All existing tests continue to pass; new tests cover `lineUpdates[]` append-only behavior, the AI-proposal-not-auto-applied guarantee, and the `Qualifying → Quoted` gating rule

## 6. GDPR

The structured fields (`category`, `itemSpec`, `orderVolumeQty`/`Unit`, `packingSpec`, `baseUom`/`baseQty`, `qtyStatus`, `sourceCountry`) carry commercial/logistics data, not personal data. `lineUpdates[].source` values (`buyer`/`supplier`/`ai`/`operator`) are role labels, not identifying the specific person who communicated the update.

**Added in v2 (requirements-gate finding — v1 did not address this at all):** `lineUpdates[].note` is a free-text field, and free text is exactly where personal data leaks into supposedly-structured records in practice — e.g., an operator writing "buyer's contact Jane Smith asked for 5kg boxes" rather than just "buyer requested 5kg boxes." This is the same class of risk this codebase already treats as first-class elsewhere (Contact `enquiries[].summary`, SEC-GAP-020's PII-exposure history) — it is not being newly introduced by this requirement, but it is being newly *asked about* in a note field whose whole purpose is capturing communication content, which makes it a more likely landing spot for a name than, say, a packing-spec field. Position taken, consistent with how `enquiries[].summary` is already handled (no special sanitization or redaction on that field either): `note` is operator-authored free text under the same practical guidance already implicit for `enquiries[]` — avoid recording a named individual's identity beyond what's operationally necessary, since the Contact record itself already carries that identity via the existing `contactId` FK and doesn't need it duplicated in a note. No new sanitization, redaction, or lawful-basis mechanism is proposed here; this is stated explicitly rather than left unaddressed, and the practical risk is judged equivalent to (not greater than) `enquiries[].summary`'s already-accepted risk profile.

## 7. Open Questions for requirements-gate

- Whether `packingSpec` should be free text (v1, simpler) or a structured `{ unitsPerPack, packsPerCase, casesPerPallet }` object (more useful for future conversion arithmetic, but a bigger build) — proposed: free text for v1, since real packing specs (per this session's sample data) arrive in inconsistent shapes ("2 per carton," "5kg boxes," "1000/roll") that don't cleanly fit one structured shape yet
- Whether `qtyStatus` should be a per-field concept (separate status for `orderVolumeQty` vs. `baseQty` vs. `packingSpec`) rather than one status per line — v1 proposes one status per line for simplicity, on the basis that a line isn't really "confirmed" for costing purposes until packing spec, base UOM, and base qty are all resolved together

## 8. Changelog

**v2 (this version):** Resubmitted after requirements-gate FAIL on v1. Three findings addressed:
1. **AC-004/§3/§7 contradiction resolved** — v1 asserted a hard, binding gate (cannot move `Qualifying → Quoted` with an `Unknown`-status line) as an Acceptance Criterion while simultaneously flagging that same rule as an open, unresolved question in §7 ("too strict for real operator workflow?"). A requirement cannot do both. v2 commits to a decision: the check is a **non-blocking warning** (`vWarn()`), not a gate — the operator is informed of unresolved lines but never prevented from proceeding. The corresponding §7 bullet is removed since it's now settled, not deferred.
2. **AC-004 mechanism specified** — v1 said `ordCanTransition()` "is extended," without saying how, and that function has no access to `lines[]` at all. v2 states plainly that `ordCanTransition()` is untouched; the warning is added to the existing `saveOrd()`/`saveOrdFromForm()` validation path instead, reusing the `of-stage` field ID and the existing `vWarn()`/`vErr()` convention already in the codebase.
3. **GDPR §6 extended** — v1 didn't address `lineUpdates[].note`'s free-text risk at all, despite this codebase already treating free-text/PII risk as a first-class concern elsewhere. v2 states the risk explicitly, judges it equivalent to the already-accepted `enquiries[].summary` risk profile (not novel or greater), and gives practical guidance (avoid naming individuals in notes; the Contact FK already carries identity) rather than leaving it unaddressed.

**v1:** Initial draft, capturing the packaging/UOM and field-provenance gap surfaced while normalizing a real multi-category procurement intake sheet during Order Management (REQ-ORD-001) testing. FAIL — requirements-gate found a self-contradictory Acceptance Criterion, an unspecified gating mechanism, and an unaddressed GDPR angle on the update log's free-text field.
