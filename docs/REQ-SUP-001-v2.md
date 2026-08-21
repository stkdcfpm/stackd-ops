# REQ-SUP-001-v2: Supplier Price Intelligence Retention & Reference View

**Supersedes:** REQ-SUP-001-v1 (independent requirements-gate CONDITIONAL PASS — four findings, all confirmed on re-verification, three of them real defects in the doc's own claims rather than missing detail: (1) v1 cited a mitigation labeled "`FM-3`" for risk `R-007` that does not exist anywhere in the current `STACKD_CONTEXT.md` — traced to my own earlier rewrite of that file this session, which removed the old "Six failure modes" table (including FM-3) without my catching that I'd cite it again later; `STACKD_CONTEXT.md:196` now lists R-007 with no named mitigation at all. (2) The GDPR assessment's "no PII" claim doesn't hold for the future scenario it explicitly commits to (REQ-SUP-001e) — `REQ-QTE-001-v3`'s `rfqResponses[]` carries an optional `contactId` FK into `DB.con`, which holds real PII; the blanket claim needed a caveat, not a rewrite. (3) The PO source in REQ-SUP-001a was under-specified — POs have no top-level price field; cost lives one level deeper in `po.lineItems[]` (confirmed at `index.html:5717`), unlike Line Items and Quote lines which were already described at the correct nesting level. (4) REQ-SUP-001c proposed storing the staleness threshold in `QR` — confirmed `QR`/`QR_DEFAULTS` (`index.html:2871`) is exclusively the freight-rate/duty calculation object feeding `cQteLine()`, not a general settings object; this repo's own gate rule flags anything touching that calculation chain for extra scrutiny, and co-mingling an unrelated reporting field into it was the wrong call even though it wouldn't have affected the math. One advisory citation fix (openSup() → editSup(id)) also applied. All resolved below.)

## Business Context

`R-007` in `STACKD_CONTEXT.md` — "Supplier intelligence empty database" — is currently listed with no verified mitigation (`STACKD_CONTEXT.md:196`: "Unverifiable from repo — Data lives in operator's localStorage"). What is verifiable, directly from the code: the app already holds substantial supplier pricing history *today* — `DB.li[].priceHistory[]` (line-item cost/price versions), `DB.qt[].lines[].priceHistory[]` (per-quote-line cost/duty/margin versions, extended per-line by `REQ-QTE-001` Part A), and `DB.po[].lineItems[]` (actual committed purchase costs, per line) — none of it currently surfaced as intelligence; it sits siloed inside individual records, viewable one at a time.

The immediate trigger was a conversation about `REQ-QTE-001` Part B (RFQ supplier comparison — requirements-gated, not yet spec'd or built): RFQ comparison data is inherently pre-sales, and much of it is "thrown away" when a deal doesn't close — should it instead be retained as market intelligence? **This REQ answers that question, deliberately scoped separately from Part B's comparison UI**, because the three sources above are buildable *now*, independent of whether Part B ever ships.

**Scope decision (deliberate, stated up front):** this REQ is a **reference/reporting capability over data the app already retains**, not a new persistence mechanism. It does not depend on `REQ-QTE-001` Part B shipping. If/when Part B ships, its `rfqResponses[]` becomes one additional feed into the same view, not a separate system — with a GDPR caveat, see below.

## GDPR Assessment

Favorable for the three sources this REQ actually builds against: Line Item cost/price, Quote line pricing, and PO line costs are all commercial data about a supplier relationship, not personal data about a natural person. This REQ aggregates and displays only: supplier identity (`DB.sup.id`/`name`), product/spec description, price, currency, date, and source record type — no Contact-level PII, for these three sources.

**Caveat, corrected from v1's blanket claim:** `REQ-QTE-001-v3`'s `rfqResponses[]` (Part B, not yet built) carries an *optional* `contactId` FK into `DB.con` (per `REQ-QTE-001-v3` REQ-QTE-001i), and `DB.con` holds real personal data (name/email/phone, `gdprBasis`). REQ-SUP-001e (below) is corrected to require that **`contactId` is explicitly excluded from the aggregation** when/if RFQ responses become a fourth source — the aggregation must carry the response's commercial fields only (supplier, price, terms), never the linked Contact reference. This is not automatic just because the other three sources are PII-free; it has to be enforced when that integration is actually built.

## FM-1 Assessment

Unchanged from v1, re-verified: no new `K`/`DB` entity, no new field on any existing entity, no new Sheets sync mapping. Pure read/aggregation view over `DB.li`, `DB.qt`, `DB.po` (and, once it exists, `DB.ord[].lines[].rfqResponses[]`) — same category as the existing Aging Report / P&L Report (`REQ-RPT-001` G-02/G-03, confirmed via `SPEC-RPT-001-G02-G03-v1.md`), which introduced no new persisted entity either. FM-1 category-1. No council decision required.

**One narrow exception, unchanged from v1:** if/when `REQ-QTE-001` Part B ships, this REQ only reads whatever Part B already persists — it doesn't reopen Part B's own local-only commitment (`REQ-QTE-001n`). Any retention cap Part B's own volume needs is Part B's responsibility, not this REQ's.

## Requirements

**REQ-SUP-001a (aggregation, read-only — PO source corrected to per-line):** A new function collects every historical price point for a given Supplier across three existing sources:
- `DB.li[].priceHistory[]` entries where `li.supId` matches.
- `DB.qt[].lines[]` entries where `line.supId` matches (using each line's own `priceHistory[]`).
- **`DB.po[].lineItems[]` entries (`index.html:5717`) where the parent `po.supId` matches** — corrected from v1, which described aggregating "`DB.po[]` records" directly; POs have no top-level price field, so each PO must be expanded to its constituent line items, matching the per-line granularity already correct for the other two sources. A PO with 3 line items produces 3 price points, not 1.

All three normalize into one chronological list per supplier: `{ date, sourceType ('line_item'|'quote'|'po'), sourceRef (record num/id), product/desc, price, currency, status }`. Purely computed at render time — nothing new is written to `DB`.

**REQ-SUP-001b (Supplier view integration — citation corrected):** The existing Supplier detail/edit view — **`editSup(id)`** (`index.html:4254`), corrected from v1's incorrect citation of `openSup()`, which is the blank "New Supplier" initializer, not the record-detail view — gains a "Price History" section listing REQ-SUP-001a's aggregated result for that supplier, most recent first, with source-type badges (Line Item / Quote / PO).

**REQ-SUP-001c (staleness signal, mandatory — storage location corrected):** Every displayed price point shows its age (e.g. "8 months ago") and any entry older than a configurable threshold (default 12 months) is visually flagged as stale (matching the existing amber-warning visual language, e.g. `renderDispCurWarn()`'s staleness banner, `index.html:3807-3818`). **Corrected from v1: the threshold is stored under its own dedicated `localStorage` key** (e.g. `stackd_sup_intel_threshold`), **not inside `QR`**. `QR`/`QR_DEFAULTS` (`index.html:2871-2872`) is exclusively the freight-rate/duty calculation object, fed directly into `cQteLine()`'s landed-cost chain — co-mingling an unrelated reporting threshold into it would touch the exact object this repo's own gate rule flags for extra scrutiny on any change, for no benefit (the two concerns have nothing to do with each other). This REQ requires its own, separate settings key.

**REQ-SUP-001d (cross-supplier product view, secondary):** Unchanged from v1. A second view, accessible from the same Price History section, lets the operator search/filter by product description or SKU across *all* suppliers' historical price points — reusing REQ-SUP-001a's aggregation, grouped by product instead of by supplier.

**REQ-SUP-001e (RFQ integration point, forward-compatible only, not built here — GDPR exclusion made explicit):** If `REQ-QTE-001` Part B ships, its `rfqResponses[]` (including responses never committed/converted) becomes a fourth `sourceType` fed into REQ-SUP-001a's aggregation. **Corrected from v1:** when that integration is built, the aggregation must include only the response's commercial fields (supplier, price, terms, date) — **`contactId` is explicitly excluded**, never carried into the aggregated view, per the GDPR Assessment above. This REQ does not build the integration now (Part B doesn't exist yet); it specifies both the aggregation function's shape (REQ-SUP-001a) and this exclusion requirement so a future implementer isn't left to independently rediscover the PII risk.

**REQ-SUP-001f (no export/sync of aggregated intelligence):** Unchanged from v1. In-app reference only — no CSV export, no Sheets sync of the aggregated data.

## Open Questions for Requirements-Gate / Spec-Gate

1. **Threshold defaults.** Unchanged from v1 — confirm 12 months matches how FPM actually re-quotes across categories.
2. **Volume, once Part B exists.** Unchanged from v1 — aggregation should be written defensively (capped/paginated) rather than assuming small N indefinitely.
3. **Multi-tenant data ownership.** Unchanged from v1 — flagged, not resolved here, relevant before v3.0.0.
4. **"Best supplier" beyond price.** Unchanged from v1 — this REQ stays price/history-only; reliability blending is `REQ-RPT-001 G-09`'s territory.
5. **(New) Settings key naming/location.** REQ-SUP-001c proposes a standalone `localStorage` key rather than folding into any existing settings structure — confirm this is preferable to, e.g., a small dedicated "reporting settings" object if more reporting-configurable thresholds are anticipated later, rather than one-off keys accumulating.
