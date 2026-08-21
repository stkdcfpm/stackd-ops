# REQ-QTE-001-v3: Per-Line Quote Margin & RFQ Supplier Comparison

**Supersedes:** REQ-QTE-001-v2 (independent requirements-gate CONDITIONAL PASS — a second, independent reviewer with no involvement in writing v2 found five further issues, three of them genuine functional/design defects rather than doc polish: (1) AC-013's reuse of `renderDispCurWarn()` is a no-op on the app's default settings — verified, the function early-exits whenever `QR.displayCurrency === 'GBP'` regardless of the RFQ responses' own currencies, which is exactly backwards for this use case; (2) Contact-delete orphaning of the new `contactId` field on `rfqResponses[]` was left unaddressed, same failure class as the already-logged `CON-GAP-004`; (3) REQ-QTE-001l named `openConvertToQuote()` as "the existing hand-off," but the actual Order-Request-side entry point is `ordConvertToQuote()`, which never touches quote lines at all — there is no existing mechanism to extend, this REQ must build one; (4) whether a Quote line created via commit carries a per-line margin (Part A) was left undefined; (5) three stale line-number citations. All five resolved below.)

## Business Context

Unchanged from v2. Raised in a live operator conversation about the Quote workflow: `Quote.markup` is a single quote-wide percentage; there is no per-line override, and no mechanism to record and compare multiple suppliers' RFQ responses against one requirement before committing to one.

## FM-1 Assessment

Unchanged from v2 — independently re-verified in this round: `FIELD_MAPS.qt` (`index.html:3413`) excludes `lines[]`; `DB.ord` has no `FIELD_MAPS.ord` entry. No new Sheets sync mapping required for either part. FM-1 category-2 (Part A) / category-3 precedent (Part B). No council decision required.

---

## Part A — Per-Line Quote Margin

**REQ-QTE-001a (per-line margin field):** Unchanged from v2. Each `Quote.lines[]` entry gains an optional `markup` field. Unset (`undefined`/`null`/empty string) means the line inherits the quote-level `markup`. An explicit `0` is a valid override, distinct from unset.

**REQ-QTE-001b (line-level override UI — citation and pattern-conflict fixed):** The quote line table (`rQLT()`, `index.html:9069-9101`) gains an editable per-line margin input. **Corrected citation:** the existing `ql-dutyPct-*` input is at `index.html:9095` (not `9091`, a v2 citation error). **The new input must NOT reuse the `dutyPct` read pattern verbatim** — `dutyPct`'s own read (`+qlFld(l.rid,'dutyPct')||0`, `index.html:9244`) collapses a blank field and an explicit `0` to the same value, which directly conflicts with REQ-QTE-001a/AC-004's required blank-vs-zero distinction. The new margin field's read logic must check the raw string for emptiness (e.g. `raw === '' ? undefined : +raw`) before falling back to "inherit," not apply a truthy/`||` default.

**REQ-QTE-001c (overhead treatment — citation fixed, decision unchanged):** `overhead` (`QR.originCharges + QR.destCharges + QR.fpmAdmin`) is computed at `index.html:9264` (not `9265`, a v2 citation error — `9265` is the `sellUSD` line that *consumes* the overhead value, not where it's computed). Decision unchanged from v2: `overhead` is never marked up under any line's or the quote's margin — added to the quote total at cost, mirroring DG surcharge's existing flat-add treatment. **Grand Total = Σ(each line's landed cost × (1 + that line's effective margin)) + overhead (unmarked-up).**

**REQ-QTE-001d (sell price / landed calc uses effective line margin):** Unchanged from v2.

**REQ-QTE-001e (price history — citation fixed, requirement unchanged):** The `changed` re-evaluation happens at `index.html:9258` (not `9256`, a v2 citation error — `9256` is `var calcR = lineCalcs[i];`, the line immediately before it). Requirement unchanged: `changed` must be evaluated against each line's *effective* margin, not the raw quote-level value alone.

**REQ-QTE-001f (backward compatibility):** Unchanged from v2.

### Acceptance Criteria — Part A

- AC-001 through AC-004, AC-010: unchanged from v2.
- AC-014 (new): the per-line margin input's read logic distinguishes a blank field from an explicit `"0"` entry — verified with a fixture asserting an untouched (never-focused) field reads as `undefined`/inherit, while a field explicitly cleared and typed as `0` reads as the number `0`.

---

## Part B — RFQ Supplier Comparison & Commit

**REQ-QTE-001g, REQ-QTE-001h, REQ-QTE-001i:** Unchanged from v2 (unit of comparison = one `DB.ord[].lines[]` entry; `rfqResponses[]` field set; no free-text PII, optional `contactId` FK to `DB.con` instead).

**REQ-QTE-001j (currency conversion — corrected staleness mechanism):** Ranking logic (convert each response to GBP via `toGBP()` before comparing) is unchanged from v2. **The staleness-warning requirement is corrected:** `renderDispCurWarn()` (`index.html:3807-3818`) cannot be reused verbatim — it early-exits whenever `QR.displayCurrency === 'GBP'` (line 3809), which is the app's default, regardless of what currency is actually being converted. That trigger condition is backwards for this feature: the RFQ comparison view converts to GBP internally *regardless* of the operator's display-currency preference, so staleness matters whenever **any compared response's own recorded currency is not GBP**, independent of `QR.displayCurrency`. This REQ requires a **new, comparison-specific staleness check** — same underlying data source (`st_qr_ts`, same 24h threshold, same visual treatment as `renderDispCurWarn()`'s existing warning banner, for consistency) — but with its own trigger: fire whenever at least one response being ranked is not already in GBP and `st_qr_ts` is >24h old (or unset). This is new logic, not a call to the existing function.

**REQ-QTE-001k (explicit commit action):** Unchanged from v2.

**REQ-QTE-001l (commit hands off into a new build, not an existing pipeline — corrected scope):** v2 incorrectly named `openConvertToQuote()` as "the existing 'Create Quote' handoff." **Verified: that function (`index.html:9528` onward) only accepts a `contactId` and pre-fills client name/notes — it never touches quote lines, and nothing in the codebase currently carries Order Request line data into a Quote's `cQL`.** The actual Order-Request-side entry point is `ordConvertToQuote(ordId)` (`index.html:2586`), which today only forwards `contactId` to `openConvertToQuote()`. **This REQ must extend `ordConvertToQuote()` itself**, not merely hook into something pre-existing: on conversion, it must collect every line on the Order Request that has a `committedResponseId` set, and seed `cQL` (after `openQte()`'s reset) with one quote line per committed response, carrying at minimum that response's `supId` and unit price (converted to the quote's working currency where needed). This is new functionality this REQ is responsible for building, explicitly scoped here rather than assumed to already exist.

**REQ-QTE-001m (Supplier-delete guard):** Unchanged from v2.

**REQ-QTE-001n (no new sync surface):** Unchanged from v2.

**REQ-QTE-001o (relationship to REQ-RPT-001 G-09):** Unchanged from v2.

**REQ-QTE-001p (Contact-delete guard, new — closes a gap the independent reviewer found, same class as `CON-GAP-004`):** `delCon()` (`index.html:9517-9526`) already nulls `DB.ord[].contactId` (the Order Request's own top-level field) on delete, but does not walk nested line data. This REQ requires `delCon()` be extended to also null `contactId` on every `rfqResponses[]` entry across every `DB.ord[].lines[]`, for every Order Request — mirroring exactly the silent-null convention `delCon()` already uses for the top-level field (no new warning dialog; this repo's existing Contact-delete UX has never warned on this class of reference, unlike `delSup()`'s warn-first pattern, and this REQ does not introduce an inconsistency by making RFQ responses the one exception). Persisted via the same existing `sv(K.ord, DB.ord)` call already present in `delCon()` (`index.html:9522`) — no new persistence call needed.

**REQ-QTE-001q (Part A × Part B interaction, new — resolves the undefined-interaction finding):** A Quote line created via the REQ-QTE-001l hand-off does **not** set a per-line `markup` (REQ-QTE-001a) — it is left unset, so it inherits the new quote's quote-level default margin like any manually-added line with no override. This is a deliberate, simplest-safe-default choice: sourcing/RFQ data does not carry a sell-margin decision, and inventing one from RFQ context would be a silent, unreviewed assumption about the operator's intended margin.

### Acceptance Criteria — Part B

- AC-005 through AC-009, AC-011, AC-012: unchanged from v2.
- AC-013 (corrected): with at least one compared response in a non-GBP currency and `st_qr_ts` >24h old (or unset), the RFQ comparison view shows a staleness warning — verified specifically with `QR.displayCurrency` left at its default (`'GBP'`), confirming the warning fires independent of display-currency setting (this is the exact case v2's AC-013 would have silently failed).
- AC-015 (new): committing responses on two lines of one Order Request, then converting via `ordConvertToQuote()`, produces a new Quote with two lines, each carrying the committed response's `supId` and unit price — not requiring the operator to re-enter either value, and not relying on any pre-existing hand-off mechanism (verified against the actual extended `ordConvertToQuote()` code path, not assumed).
- AC-016 (new): a Quote line created via the REQ-QTE-001l hand-off has no `markup` field set on creation — verified it inherits the quote-level default on calculation, per REQ-QTE-001q.
- AC-017 (new): deleting a Contact that is referenced via `contactId` on at least one `rfqResponses[]` entry results in that field being nulled — verified by asserting the specific nested `rfqResponses[].contactId` is `null` post-delete, not merely that the top-level `DB.ord[].contactId` was handled (the pre-existing, already-covered case).

## Open Questions for Spec-Gate (unchanged from v2)

1. Should landed-cost ranking account for supplier reliability signals in this iteration, or purely cost — recommendation unchanged: cost-only now, revisit once `REQ-RPT-001 G-09` ships.
2. Minimum viable field set for a recorded response — confirm against real supplier RFQ practice (e.g. is MOQ always quoted?).
