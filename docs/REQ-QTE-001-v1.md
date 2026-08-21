# REQ-QTE-001-v1: Per-Line Quote Margin & RFQ Supplier Comparison

## Business Context

Raised in a live operator conversation reminding themselves of the Quote workflow: today `Quote.markup` (`qf-mkp`, `index.html:9038`/`9250`) is a single quote-wide percentage applied uniformly to every line's landed cost in `saveQte()` (`index.html:9256-9260`) and `cQte()` (`index.html:8950-8960`) — confirmed directly against the code, not assumed. There is no per-line override anywhere in `Quote.lines[]` (fields are `rid, supId, desc, qty, uom, cost, cbm, dg, dutyPct` — see `addQteLine()`, `index.html:9058-9061`, and `saveQte()`'s line-building block, `index.html:9235-9245`). A quote mixing a low-margin freight-passthrough line with a full-margin product line cannot be represented today; the only workaround is splitting into separate quotes.

The same conversation surfaced a second, larger gap: Stackd has no way to capture **multiple suppliers' responses to the same sourcing requirement side by side and compare them on landed value (not just quoted unit price) before committing to one.** Today, a Quote line already has a single `supId` (`index.html:9061`) — there is no concept of "this requirement went to 3 suppliers, here's what each quoted, here's who we picked and why." The closest existing entity is Order Request lines (`DB.ord[].lines[]`, `ordAddLine()`, `index.html:2709-2725`), which model a buyer-side requirement (`category`, `itemSpec`, `orderVolumeQty/Unit`, `packingSpec`, `baseUom`, `baseQty`, `qtyStatus`, `sourceCountry`) but have no supplier-response data at all.

The user's stated goal is explicit: **add margin control, and compare RFQ responses to see who's best to work with for the best value, then commit to the right supplier** — value-based selection (accounting for landed cost, not raw price), not just a lowest-quote pick.

This REQ bundles two related but independently-shippable pieces, following the `REQ-RPT-001`-style umbrella pattern already used in this repo for grouped, separately-gated items:

- **Part A — Per-line quote margin** (contained, Quote-only change)
- **Part B — RFQ supplier comparison & commit** (larger, new capability, likely its own entity/sub-structure)

Recommend spec-gating and building Part A first (small, low-risk, directly closes the gap the operator hit) and Part B as a separate, larger spec-gate pass — they don't block each other, though Part B's "commit" action should be able to hand off into a Quote whose line can carry Part A's per-line margin if both ship.

## FM-1 Assessment

**Part A:** New field (`markup`) on an existing `Quote.lines[]` array element. `Quote.lines[]` is **not** in `FIELD_MAPS.qt` today (`index.html:3413` lists only `num, client, dt, status, currency, calc_totalLanded, markup, notes` — no `lines`) — line items are already local-only, never synced to Sheets in their current form. Adding a per-line field therefore requires **no new Sheets sync mapping**. Falls under FM-1 category-2 (new field on an existing entity, entity already in `K`/`saveAll()`). No council decision required.

**Part B:** Depends on where RFQ response data lives — a decision for spec-gate, not fixed here. Two directions, both compatible with FM-1 without a council decision:
1. **Attach RFQ responses to `DB.ord[].lines[]`** (recommended direction, not binding) — a new `rfqResponses[]` array per Order Request line, alongside a `committedResponseId`. `DB.ord` already exists in `K`/`saveAll()` and is already local-only (no `FIELD_MAPS.ord` entry exists — Order Requests were built under FM-1's local-only exception at v2.9.44). Adding fields to an already-unsynced entity is category-2/category-3 territory, not a new freeze violation.
2. A new standalone entity (e.g. `DB.rfq`) — still buildable under category-3 (new local-only `K`/`DB` entity, no sync mapping) with no council decision required, same precedent as `DB.events` (v2.9.28) and `DB.ord` (v2.9.44) — **only** if spec-gate concludes a standalone entity is genuinely warranted over attaching to Order Request lines.

Either direction stays inside the FM-1 exceptions already established in `STACKD_CONTEXT.md`. **A new Sheets sync mapping for RFQ data is explicitly out of scope for this REQ** — if a future need for RFQ visibility in Sheets emerges, that requires a separate council decision per the standing freeze.

---

## Part A — Per-Line Quote Margin

**REQ-QTE-001a (per-line margin field):** Each `Quote.lines[]` entry gains an optional `markup` field (percentage, same unit/shape as the existing quote-level `markup`). When a line's `markup` is unset/blank, it inherits the quote-level `markup` (`qf-mkp`) exactly as all lines do today — this is additive, not a breaking change to existing quotes.

**REQ-QTE-001b (line-level override UI):** The quote line table (`rQLT()`, `index.html:9069-9101`) gains an editable per-line margin input, mirroring the existing `ql-dutyPct-*` input pattern (`index.html:9091`). Leaving it blank falls back to quote-level margin (REQ-QTE-001a).

**REQ-QTE-001c (sell price / landed calc uses effective line margin):** `cQteLine()`/`cQte()`/`saveQte()`'s sell-price computation (`index.html:8950-8960`, `9256-9265`) uses each line's *effective* margin (its own `markup` if set, else the quote-level `markup`) instead of applying the single quote-level `markup` uniformly. The quote total (`calc_sellUSD`/`calc_sellGBP`, `index.html:9270-9271`) is the sum of each line's own sell price at its effective margin, not `totalLanded × (1 + quote markup)`.

**REQ-QTE-001d (price history captures the effective margin, unchanged mechanism):** The existing per-line `priceHistory[]` versioning (`index.html:9250-9258`) already stores `markup` per version — this REQ requires no new tracking mechanism, only that the value stored is the line's *effective* margin at save time, and that a version increments when either the line's own override or the quote-level default (if the line has no override) changes — i.e. `changed` (`index.html:9256`) must be re-evaluated against effective margin, not only the raw quote-level value.

**REQ-QTE-001e (backward compatibility):** Existing quotes saved before this ships have no per-line `markup` — they must continue to compute and display exactly as they do today (100% inherited from quote-level margin). No migration script required; the "unset → inherit" behavior handles this natively.

### Acceptance Criteria — Part A

- AC-001: A quote with two lines, one with an explicit line-level `markup: 0` (pass-through) and one with no override (inherits quote-level `markup: 20`), computes each line's sell price at its own effective margin — the 0%-margin line's sell price equals its landed cost.
- AC-002: A pre-existing quote (no line has ever had a `markup` field) loads and recomputes identically to its current (pre-REQ-QTE-001) totals.
- AC-003: Changing only a line's own margin (quote-level unchanged) creates a new `priceHistory` version on that line; a sibling line whose effective margin didn't change does not get a spurious new version.
- AC-004: Clearing a line's margin override reverts that line to the quote-level default on next save/recalculation.

---

## Part B — RFQ Supplier Comparison & Commit

**REQ-QTE-001f (capture multiple supplier responses per requirement):** The operator can record more than one supplier's response to the same sourcing requirement — at minimum: supplier (`supId` → `DB.sup`), unit price, currency, MOQ, lead time, payment terms, and free-text notes, per response. Recording a response never auto-creates or mutates a Quote/PO — consistent with the existing "propose, operator commits explicitly" pattern already used for AI actions (`handleAIAction()` precedent) and Order Request line updates (`ordConfirmLineUpdate()`).

**REQ-QTE-001g (value-based comparison, not raw price):** The comparison view ranks responses by **landed cost**, reusing the existing rate engine (`cQteLine()`/`QR`, the same freight/duty/insurance calculation already used for Quotes) applied to each response's unit price — not a raw quoted-price sort. This directly answers the user's stated goal ("best value," not "lowest quote") and keeps the ranking logic consistent with how the rest of the app already prices landed cost, rather than introducing a second calculation method.

**REQ-QTE-001h (explicit commit action):** The operator can mark exactly one response as **committed** for a given requirement (`committedResponseId`-style field). Committing is a deliberate, explicit action — never automatic, never inferred from "cheapest" or "fastest." Un-committing / changing the committed response later is allowed (sourcing decisions change) and must not silently orphan or delete the other recorded responses — they stay visible as a record of what was compared.

**REQ-QTE-001i (commit hands off into the existing pipeline):** Committing a response should be able to pre-fill or feed the existing downstream flow — e.g. populating a new Quote line (or, if attached to an Order Request line, feeding the existing "Create Quote" handoff, `openConvertToQuote()`) with the committed supplier's `supId`/price — rather than creating a second, parallel place suppliers get recorded. Exact wiring is a spec-gate decision; the requirement is that the committed response is not a dead end that has to be manually re-typed into a Quote.

**REQ-QTE-001j (no new sync surface):** Per the FM-1 Assessment above, RFQ response data is local-only in this REQ's scope — no `FIELD_MAPS` entry, no Apps Script tab. If cross-device visibility of RFQ comparisons is needed later, that is a separate, explicit council decision, not assumed here.

**REQ-QTE-001k (relationship to REQ-RPT-001 G-09, disambiguation):** This REQ is **not** the same as the already-logged, still-deferred `REQ-RPT-001 G-09` ("Supplier performance tracking — on-time %, cost variance," `docs/requirements-tracker.md`) — G-09 is retrospective (how did a supplier perform *after* the fact, across history), this REQ is prospective (comparing quotes *before* committing to one, on a single requirement). They are complementary, not duplicative — spec-gate should note the distinction so the two aren't merged or one mistaken for having superseded the other.

### Acceptance Criteria — Part B

- AC-005: Two responses recorded against the same requirement, from two different suppliers with different unit prices, currencies, and implied freight/duty profiles, rank in landed-cost order — not raw quoted-price order — when they diverge (i.e. a test case where the raw-cheapest response is not the landed-cheapest response, and the UI/data correctly surfaces the landed-cheapest as better value).
- AC-006: Committing a response sets exactly one `committedResponseId`-equivalent per requirement; committing a second response replaces, not adds to, the committed selection.
- AC-007: Un-committing (or re-committing to a different response) does not delete any previously recorded response — all remain queryable/visible.
- AC-008: No response record, comparison, or commit action writes to `FIELD_MAPS` or triggers `syncEnt()` — confirmed via a test asserting no sync call fires for this data path.
- AC-009: A committed response can be carried into a new Quote line (at minimum, `supId` and unit cost pre-filled) without the operator having to manually re-enter values already captured in the RFQ response.

---

## Open Questions for Spec-Gate

1. Does Part B attach to `DB.ord[].lines[]` (recommended) or warrant a standalone entity? (See FM-1 Assessment.)
2. Should a "requirement" for RFQ purposes require an Order Request to exist first, or can an operator start an RFQ comparison ad hoc, with no linked Order Request/Contact? (Affects whether Part B is usable by an operator who hasn't adopted the Order Request workflow.)
3. Should landed-cost ranking (REQ-QTE-001g) account for supplier-specific lead time / reliability signals at all in this iteration, or purely on cost — given `REQ-RPT-001 G-09` (supplier performance tracking) is separately deferred to v3.0.x and could later feed a "best value" score that blends cost and reliability.
4. Minimum viable field set for a recorded response (REQ-QTE-001f lists a starting set) — confirm against what the operator actually receives from suppliers in practice (e.g. is MOQ always quoted? Is there a standard RFQ document format to mirror?).
