# REQ-QTE-001-v2: Per-Line Quote Margin & RFQ Supplier Comparison

**Supersedes:** REQ-QTE-001-v1 (requirements-gate CONDITIONAL PASS — six findings required correction before spec: (1) undefined treatment of quote-level `overhead` once margin is per-line; (2) "requirement" never pinned to a specific data unit for Part B; (3) no GDPR flag for a possible named-contact field on RFQ responses, despite `agent-architecture.md`'s explicit rule that PII-touching requirements must be flagged at requirements-gate; (4) landed-cost ranking inherits the same unconverted-currency defect already logged twice in this codebase as `CUR-GAP-001`/`CUR-GAP-002`; (5) no guard for dangling `supId` references on Supplier delete, despite an established pattern for exactly this (`delSup()`); (6) non-mandatory language ("should be able to") on the one requirement that keeps Part B from being a dead end. All six resolved below.)

## Business Context

Unchanged from v1. Raised in a live operator conversation reminding themselves of the Quote workflow: `Quote.markup` (`qf-mkp`, `index.html:9038`/`9250`) is a single quote-wide percentage applied uniformly to every line's landed cost in `saveQte()` (`index.html:9256-9260`) and `cQte()` (`index.html:8950-8960`). There is no per-line override, and no mechanism to record multiple suppliers' responses to one requirement side by side and compare them on landed value before committing to one. This REQ bundles two related but independently-shippable pieces:

- **Part A — Per-line quote margin** (contained, Quote-only change)
- **Part B — RFQ supplier comparison & commit** (larger, new capability)

Recommend spec-gating and building Part A first.

## FM-1 Assessment

**Part A:** Unchanged from v1. New field (`markup`) on an existing `Quote.lines[]` array element. `Quote.lines[]` is **not** in `FIELD_MAPS.qt` (`index.html:3413`) — line items are already local-only, never synced. No new Sheets sync mapping required. FM-1 category-2. No council decision required.

**Part B (now decided, not merely recommended — resolves v1's Open Question 1):** RFQ responses attach to `DB.ord[].lines[]` — one Order Request line, as created by `ordAddLine()` (`index.html:2709-2725`), is the unit an RFQ comparison is recorded against (see REQ-QTE-001g below, resolves v1 finding #2). `DB.ord` already exists in `K`/`saveAll()` and has no `FIELD_MAPS.ord` entry — local-only, same FM-1 category-3 precedent as `DB.events` (v2.9.28) and `DB.ord` itself (v2.9.44). No council decision required. **A new Sheets sync mapping for RFQ data remains explicitly out of scope.**

---

## Part A — Per-Line Quote Margin

**REQ-QTE-001a (per-line margin field):** Each `Quote.lines[]` entry gains an optional `markup` field. Unset (`undefined`/`null`/empty string — the sentinel is "field not present or blank," not "field present and zero") means the line inherits the quote-level `markup`. An explicit `0` is a valid override (e.g. a zero-margin pass-through line) and is **not** treated as unset.

**REQ-QTE-001b (line-level override UI):** The quote line table (`rQLT()`, `index.html:9069-9101`) gains an editable per-line margin input, mirroring the existing `ql-dutyPct-*` input pattern (`index.html:9091`). Blank input = inherit (REQ-QTE-001a).

**REQ-QTE-001c (overhead treatment — resolves v1 finding #1):** `overhead` (`QR.originCharges + QR.destCharges + QR.fpmAdmin`, `index.html:9265`) is a flat, quote-level operational pass-through cost, not attributable to any single line. **Decision: `overhead` is never marked up, regardless of any line's or the quote's margin — it is added to the quote total at cost.** This mirrors how DG surcharge (`qr.dgSurcharge`, `index.html:8943`) is already a flat per-line add with no margin logic applied to it — `overhead` gets the same treatment, just at quote level instead of line level. This is a deliberate, documented behavior change from v2.9.51's current uniform `(totalLanded + overhead) * (1 + markup/100)`: **Grand Total = Σ(each line's landed cost × (1 + that line's effective margin)) + overhead (unmarked-up)**. Spec-gate must ensure the UI clearly labels `overhead` as a flat add (e.g. "+ Overhead (no margin)") so an operator reviewing the total isn't confused by where the number moved.

**REQ-QTE-001d (sell price / landed calc uses effective line margin):** `cQteLine()`/`cQte()`/`saveQte()`'s sell-price computation (`index.html:8950-8960`, `9256-9265`) uses each line's *effective* margin (its own `markup` if set per REQ-QTE-001a, else the quote-level `markup`).

**REQ-QTE-001e (price history captures effective margin, unchanged mechanism):** The existing `priceHistory[]` versioning (`index.html:9250-9258`) requires no new tracking mechanism — only that the stored `markup` value is the line's *effective* margin at save time, and that a version increments when the *effective* margin changes (whether from the line's own override or, for a line with no override, the quote-level default changing) — i.e. `changed` (`index.html:9256`) is re-evaluated against effective margin, not the raw quote-level value alone.

**REQ-QTE-001f (backward compatibility):** Existing quotes/priceHistory entries have no per-line `markup` — every historical entry's stored `markup` already equals what was, at the time, the effective margin (since no per-line override existed before this ships). No migration required; historical data remains valid as-is under the new semantics.

### Acceptance Criteria — Part A

- AC-001: A quote with two lines, one with an explicit line-level `markup: 0` and one with no override (inherits quote-level `markup: 20`), computes each line's sell price at its own effective margin — the 0%-margin line's sell price equals its landed cost.
- AC-002: A pre-existing quote (no line has ever had a `markup` field) loads and recomputes identically to its current (pre-REQ-QTE-001) per-line totals; only the Grand Total changes, and only by the amount `overhead` was previously marked up by (per REQ-QTE-001c's documented behavior change) — verified with a fixture asserting the exact expected delta, not just "some difference."
- AC-003: Changing only a line's own margin (quote-level unchanged) creates a new `priceHistory` version on that line; a sibling line whose effective margin didn't change does not get a spurious new version.
- AC-004: Clearing a line's margin override (distinct from setting it to `0`) reverts that line to the quote-level default on next save/recalculation.
- AC-010 (new): `overhead` is added to the Grand Total unmarked-up regardless of quote-level or any line-level margin value — verified with a fixture where quote-level margin is non-zero and the total's `overhead` component matches the raw `QR.originCharges + QR.destCharges + QR.fpmAdmin` sum exactly, not that sum times any margin factor.

---

## Part B — RFQ Supplier Comparison & Commit

**REQ-QTE-001g (unit of comparison — resolves v1 finding #2):** One "requirement" = one `DB.ord[].lines[]` entry. RFQ responses are recorded against a specific Order Request line, not against the whole Order Request. This means an Order Request with multiple lines can have a different committed supplier per line — consistent with, and not creating any new risk against, the existing per-supplier PO grouping already shipped in `PO-GAP-001`'s fix (v2.9.44, one PO per distinct supplier on Quote→PO conversion). **An RFQ comparison always requires an existing Order Request line to attach to** — this resolves v1's Open Question 2: there is no ad-hoc, Order-Request-free RFQ entry point in this REQ's scope.

**REQ-QTE-001h (capture multiple supplier responses per line):** Each Order Request line gains an `rfqResponses[]` array. Each response captures: `supId` (FK → `DB.sup`, required), unit price, currency, MOQ, lead time, payment terms, and free-text notes. Recording a response never auto-creates or mutates a Quote/PO.

**REQ-QTE-001i (no new PII field — resolves v1 finding #3):** An RFQ response does **not** carry a free-text named-individual field. If the operator wants to note who at the supplier provided a given response, the response may optionally carry a `contactId` (FK → `DB.con`), referencing an existing Contact record — reusing that entity's already-reviewed `gdprBasis` derivation and retention posture rather than introducing a new PII capture surface. No new field, no new GDPR basis to define, no requirements-gate PII flag needed for this REQ's scope: **this REQ introduces zero new fields capable of storing personal data outside the already-governed `DB.con` entity.** Spec-gate should confirm the UI resolves `contactId` to an existing Contact via lookup/select, never a free-text name/email input on the response itself.

**REQ-QTE-001j (value-based comparison with currency conversion — resolves v1 finding #4):** The comparison view ranks responses by **landed cost converted to a single common currency (GBP)**, not raw quoted price and not raw per-currency landed cost. Each response's landed cost is computed via the existing `cQteLine()` rate engine (same freight/duty/insurance calculation used for Quotes) in the response's own recorded currency, then converted using the existing `toGBP(amount, cur)` helper (`index.html:3783-3792`) before ranking — the same helper already used for Dashboard KPI aggregation and Buyer display currency (`CUR-001`, v2.9.46). This deliberately avoids reproducing `CUR-GAP-001`/`CUR-GAP-002` (currencies mixed unconverted) in a third location. The comparison view reuses the existing FX-staleness warning pattern (`renderDispCurWarn()`, `index.html:3807`, keyed off `st_qr_ts`) so an operator comparing responses with stale FX rates gets the same warning already shown elsewhere, rather than a silently approximate ranking.

**REQ-QTE-001k (explicit commit action):** The operator can mark exactly one response per Order Request line as **committed** (`committedResponseId` on the line). Committing is explicit, never automatic or inferred from "cheapest"/"fastest" ranking. Re-committing to a different response replaces the prior selection; it does not delete any previously recorded response — all remain visible as a record of what was compared.

**REQ-QTE-001l (commit hands off into the existing pipeline — tightened language, resolves v1 finding #6):** Committing a response **MUST** pre-fill a new Quote line with, at minimum, the committed response's `supId` and unit price (matching AC-009) when the operator uses the existing "Create Quote" handoff (`openConvertToQuote()`) from that Order Request. This is not optional or aspirational — an operator must never have to manually re-type values already captured in a committed RFQ response. Exact UI wiring (e.g. whether the Quote line pre-fill happens immediately on commit or at the point "Create Quote" is clicked) is left to spec-gate; the requirement is the data must transfer, full stop.

**REQ-QTE-001m (Supplier-delete guard — resolves v1 finding #5):** `delSup()` (`index.html:4277-4292`) already counts and warns on linked POs/invoices before deletion, and explicitly nulls `Contact.supplierId` on delete. This REQ requires the same treatment for RFQ responses: `delSup()` must additionally count Order Request lines with an `rfqResponses[]` entry referencing the deleted supplier's `id`, include that count in the existing warning dialog (following the same `warns.push(...)` pattern, `index.html:4284-4285`), and — since an orphaned `supId` on a historical response is informational record, not an active reference the way `Contact.supplierId` is — leave the response's `supId` in place but ensure the comparison/commit UI degrades gracefully (shows "supplier deleted" rather than crashing) rather than nulling it, since nulling would destroy the historical record of what was actually compared.

**REQ-QTE-001n (no new sync surface):** Unchanged from v1. RFQ response data is local-only — no `FIELD_MAPS` entry, no Apps Script tab, in this REQ's scope.

**REQ-QTE-001o (relationship to REQ-RPT-001 G-09, disambiguation):** Unchanged from v1. This REQ is prospective (comparing quotes before committing), not retrospective (`REQ-RPT-001 G-09`'s supplier performance tracking, still deferred to v3.0.x). Complementary, not duplicative.

### Acceptance Criteria — Part B

- AC-005: Two responses recorded against the same Order Request line, from two different suppliers, in **different currencies**, where the raw-cheapest (in its own currency) response is not the GBP-landed-cheapest once converted, rank in GBP-landed-cost order — the UI surfaces the true landed-cheapest as better value, not the nominal lowest quoted number.
- AC-006: Committing a response sets exactly one `committedResponseId` per Order Request line; committing a second response replaces, not adds to, the committed selection.
- AC-007: Un-committing (or re-committing to a different response) does not delete any previously recorded response — all remain queryable/visible.
- AC-008: No response record, comparison, or commit action writes to `FIELD_MAPS` or triggers `syncEnt()`.
- AC-009: A committed response's `supId` and unit price pre-fill a new Quote line created via `openConvertToQuote()` from that Order Request — operator does not manually re-enter either value.
- AC-011 (new): Deleting a Supplier with at least one `rfqResponses[]` reference shows a warning count in the existing `delSup()` confirmation dialog (mirroring the PO/invoice warning pattern), and after deletion, viewing the affected Order Request line's RFQ comparison renders without error, visibly indicating the referenced supplier no longer exists.
- AC-012 (new): No RFQ response object, in any code path, contains a free-text name, email, or phone field — only an optional `contactId` FK to an existing `DB.con` record — verified by a test asserting the response schema has no such field.
- AC-013 (new): With FX rates >24h stale (per the existing `st_qr_ts` staleness check), the RFQ comparison view shows the same staleness warning already used elsewhere (`renderDispCurWarn()`), rather than ranking silently.

## Open Questions for Spec-Gate (carried from v1, others resolved above)

1. Should landed-cost ranking (REQ-QTE-001j) account for supplier-specific lead time / reliability signals at all in this iteration, or purely on cost — given `REQ-RPT-001 G-09` (supplier performance tracking) is separately deferred to v3.0.x and could later feed a blended "best value" score. **Recommendation: cost-only for this REQ; revisit blending once G-09 ships, so this REQ isn't blocked waiting on a v3.0.x-deferred item.**
2. Minimum viable field set for a recorded response (REQ-QTE-001h) — confirm against what the operator actually receives from suppliers in practice (e.g. is MOQ always quoted?).
