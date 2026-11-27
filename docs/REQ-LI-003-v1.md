# REQ-LI-003 v1 — Line Item Cost & Margin History (reorder decision modal)

**Status:** Draft — awaiting requirements-gate  
**Schema impact:** None. No new stored fields, no `localStorage` key change, no Supabase migration, no Sheets-sync change (see §7).  
**Version target:** v2.9.104  
**Operator scope source:** operator-written feature scope pasted 2026-11-27 (sections 1–9). Where this REQ departs from it, §12 says so and why.

---

## 1. Business need

When reordering a product from a supplier, the operator needs to see — in one place and in seconds — **what that item has cost from the supplier over time, and what margin is attainable at today's sell price**, so they can decide whether the reorder is commercially viable.

- Used on each reorder. The operator expects repeat orders for the same products.
- "Bought for" means the **unit cost from the supplier side** (the Line Item's Unit Cost, `cost`). It does not mean the sell price, and it is not read from Purchase Order lines.
- Not a reporting feature: no forecasting, no portfolio analytics (§8).

## 2. Current behaviour (verified in code, `index.html`)

| Fact | Where |
|---|---|
| Line Item price history is an **inline expandable row** under the price, toggled by a small "N pts" badge — not a modal. | `index.html:8139` (badge), `index.html:8171` (`togglePH()`) |
| Each history entry is `{date, cost, price, invoiceRef, notes}`. | `index.html:8210` (`saveLI()` pushes entries) |
| An entry is written (a) on creation, (b) when Unit Cost **or** Unit Price changes on save, and (c) **automatically when an invoice line's price differs from the catalogue price** (`notes: 'Price at time of order'`, `cost` = the catalogue cost at the moment the invoice was saved, `date` = the invoice date). | `index.html:8210`, `index.html:8929` |
| Line Items have no duty % or markup % field. (The "cost, duty %, markup %" versioning trigger in the operator scope belongs to **Quote** line versioning, a different feature.) | `saveLI()`, Quote engine |
| The catalogue row already shows margin % on price, `(price − cost) / price × 100`, with colour bands ≥20 good, ≥10 medium, else low. | `index.html:8136` |
| Entries are appended in **save order**, not date order (an invoice dated earlier but saved later lands after a newer entry). | `index.html:8929` |
| A Line Item has **no creation or last-updated timestamp** and the app has **no user identity** (event actor is the fixed string `operator`). | `saveLI()` record literal; `logEv()` |
| Cloud Data rebuilds each Line Item from an **explicit field list** on refresh; a new stored field is dropped unless a column and four touchpoints are added. `priceHistory` rides in one `jsonb` column. | `index.html:6435` |
| Line Items **are** in the Google Sheets sync (`sku, desc, uom, cost, price, cur, hs, supId, notes`); a Sheets pull preserves fields it does not map (SYNC-GAP-001). | `index.html:5127` |
| A Supplier price-staleness check already exists (Settings threshold). | `index.html:6212` |

## 3. Behaviour

### 3.1 Entry point
The "N pts" badge on a Line Items row opens a **modal** (not an inline row). The inline expandable row is removed. A Line Item with no history entries shows no badge (unchanged).

### 3.2 Header
`Cost & Margin History — <SKU> <Description>`, the supplier name, and the Line Item currency. Below it: **Last price change: <date>**, derived as the date of the newest *catalogue* entry (§3.4). No "Last Updated by" actor is shown (§12).

### 3.3 Cost range summary (primary view)
Computed over **catalogue entries only** (§3.4). Three rows — **Lowest cost**, **Highest cost**, **Latest cost** — each showing the cost, the date it applied, and **the margin the operator would get at today's sell price** (the Line Item's current `price`): `(price − cost) / price × 100`. Also shown: today's sell price and today's catalogue margin. If the current price is 0 or blank, margins show "n/a". If only one catalogue entry exists, the range collapses to a single row and the modal says "Only one price on record — no trend yet".

### 3.4 Two kinds of history entry — never mixed in maths
- **Catalogue entries**: `invoiceRef` blank. These are changes to the supplier price list (creation, or a cost/price edit in the catalogue).
- **Order entries**: `invoiceRef` set (`Price at time of order`). These are deal-specific and often discounts.

Shifts (§3.5), the cost range (§3.3), the trend (§3.6) and "last price change" use **catalogue entries only**, ordered by `date` ascending with array position as the tie-break (not array order alone). Order entries are listed in their own section below the table with date, invoice reference, price charged and margin against the cost recorded on that entry; they carry no shift badges.

### 3.5 Timeline table (catalogue entries, newest first)
Columns: Date · Unit Cost · Unit Price · Margin % · Notes. Beside Cost and Price: the **change from the previous catalogue entry**, absolute and percent (`↑ $2.50 (+5.2%)`). Beside Margin: the change in **percentage points** (`↑ 2.3 pp`) — never a percent of a percent. The oldest entry shows no shift. Increases and decreases are coloured green/red; the hover text states the change in words. Shifts are **computed when the modal renders** from the entries' own `cost` and `price`; nothing is stored. An entry with a missing or non-numeric cost or price is shown with "–" and skipped in the maths rather than treated as 0.

### 3.6 Trend line
When there are two or more catalogue entries: `Cost ↑ 8.5% | Price ↑ 3.2% | Margin ↓ 4.1 pp`, comparing the first with the latest catalogue entry.

### 3.7 Margin health badge
Colour bands match the existing catalogue pill (≥20% good, ≥10% medium, <10% low) so one screen never has two definitions of "healthy". A Line Item whose cost equals its price (margin exactly 0, the pass-through / at-cost pattern) shows a neutral **"At cost"** badge, not "Low margin".

### 3.7a Volatility flag — decision for the gate
The scope's optional "more than 3 changes in 90 days" amber flag is **excluded from v1**: with the repeat-order data expected it is unlikely to fire, and it must exclude order entries to be meaningful. Include later if wanted.

### 3.8 CSV export
**Export as CSV** in the modal: one row per history entry (both kinds), columns `Date, Type (catalogue|order), Unit Cost, Unit Price, Margin %, Cost shift, Price shift, Margin shift (pp), Invoice Ref, Notes`. Written through the existing `csvRow()` so text beginning `= + - @` cannot run as a spreadsheet formula (SEC-GAP-026). Demo records follow the existing "never exported" rule.

## 4. Data model
**No change.** Margin and every shift are derived on render. `priceHistory[]` entries are untouched, including the existing mixed ordering.

## 5. Backward compatibility
Nothing to backfill: every existing history entry already has the `cost` and `price` the maths needs, so it works on first load, on a restored backup, and across Cloud Data refresh and a Sheets pull with no migration step. (The operator scope's §6 backfill — stored `marginPct`, shifts, `lastUpdatedAt`, `lastUpdatedBy` — is not needed under this design; see §12.)

## 6. GDPR
No personal data. Supplier names and prices are business data already stored on the record. No new external transmission.

## 7. Cloud Data / Sheets sync
No schema, column, mapping or sync change, so none of the four Cloud Data touchpoints and no `schema-migration-reviewer` pass is needed. The operator scope says Sheets sync is "frozen for line items" — that is **not** true (Line Items are in `FIELD_MAPS`, `index.html:5127`); this feature simply adds no synced field.

## 8. Out of scope
- Any stored `lastUpdatedAt` / `lastUpdatedBy` / audit trail → v3.0 (Notion tracker row 185); needs a user identity first.
- Recalculating prices on existing invoices.
- Changes to Sheets sync.
- Versioning on non-price fields (already not done).
- A margin override on the Line Item form.
- Forecasting or predictive trends.
- Reading actual costs from Purchase Order lines (see §10).
- Purchase Order and credit-note PDFs, and the volatility flag (§3.7a).

## 9. Risks and accepted limitations
1. **The history is only as complete as the catalogue.** A repeat order at a new supplier price that is never entered into the Line Item's Unit Cost leaves no history entry. The modal cannot see it.
2. **Order entries record the catalogue cost at invoice-save time**, not necessarily the supplier cost on the order date. They are labelled and excluded from the maths for that reason.
3. History written before an operator started using the catalogue consistently may be thin; the "Only one price on record" state is the honest result, not an error.

## 10. Open questions for the gate
1. Should a later release add a PO-line cost cross-check (flag a PO whose line cost differs from the catalogue cost) to close risk 1?
2. Volatility flag in or out (default out, §3.7a).
3. Keep any compact cost-range hint on the Line Items row itself (e.g. "lowest £x"), or modal-only (default modal-only)?

## 11. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A Line Item with ≥1 history entry | Operator clicks the "N pts" badge | A modal opens; no inline row is expanded |
| AC-2 | Catalogue entries with costs 10, 12, 11 and price 20 | Modal renders | Lowest 10, highest 12, latest 11, each with margin at price 20 (50.0%, 40.0%, 45.0%) |
| AC-3 | Current price 0 or blank | Modal renders | Margins show "n/a", no NaN/Infinity |
| AC-4 | Catalogue entries cost 10 → 12 | Table renders | Cost shift `↑ 2.00 (+20.0%)`; margin shift in pp; oldest entry has no shift |
| AC-5 | Mixed entries: catalogue cost 10, then an invoice-sourced "Price at time of order" at a discounted price, then catalogue cost 12 | Modal renders | Shift for the cost-12 entry is computed against cost 10 (the invoice entry is ignored); the invoice entry appears only in the order-entries section |
| AC-6 | Entries saved out of date order (array order ≠ date order) | Modal renders | Shifts and trend follow date order |
| AC-7 | ≥2 catalogue entries | Modal renders | Trend line first→latest, margin change in pp |
| AC-8 | One catalogue entry | Modal renders | "Only one price on record — no trend yet"; no trend line |
| AC-9 | An entry with a blank or non-numeric cost | Modal renders | Shown with "–"; excluded from range and shifts; no NaN |
| AC-10 | Margin 25% / 15% / 5% | Badge renders | Good / medium / low using the existing 20/10 bands |
| AC-11 | Cost equals price (margin 0) | Badge renders | Neutral "At cost", not "Low margin" |
| AC-12 | Any Line Item | Modal and `saveLI()` | No new field is written to the Line Item record or its history entries (record byte-identical to before the feature for the same inputs) |
| AC-13 | A history note beginning `=cmd` | CSV export | The cell is neutralised by `csvRow()`; one row per entry; both kinds present with a Type column |
| AC-14 | A restored pre-feature backup / Cloud Data refresh / Sheets pull | Modal opened | Works with no migration step |
| AC-15 | Demo Line Item | CSV export | Follows the existing demo-records-never-exported rule |
| AC-16 | Feature shipped | Docs | `AI_SYSTEM_PROMPT`, `docs/user-guide.md`, changelog, version strings, `docs/version-history.md`, `CLAUDE.md`, tracker updated |

## 12. Deviations from the operator scope (all reversible on request)

| Operator scope | This REQ | Why |
|---|---|---|
| "Price History **Modal**"; current state "clicking the clock icon opens a modal" | Real modal (operator confirmed); the existing UI is an inline row | Current-state description corrected |
| Versioning triggered by cost, **duty %, markup %** | Cost and price only, unchanged | Duty/markup are Quote fields, not Line Item fields |
| Store `marginPct`, `costShift`, `priceShift`, `marginShift` on each entry; backfill | Compute on render; store nothing | Derivable from the entry's own cost/price; stored copies drift and force a backfill; "margin shift %" is meaningless (the scope itself asks for pp) |
| Shift/trend over **all** entries | Catalogue entries only | Invoice-sourced entries would show a one-off discount as a price drop then a rise; order of array ≠ date order |
| `lastUpdatedAt`, `lastUpdatedBy` stored, backfilled from "creation timestamp" / "system" | Derived "Last price change" date; no actor | Line Items have no creation timestamp; no user identity exists; a stored field needs a Cloud Data column + migration + four touchpoints; deferred to the v3.0 audit trail |
| Margin health green >30% / red <10% | Existing 20/10 bands; neutral "At cost" | One definition of "healthy" per screen; zero-margin pass-through items are legitimate |
| Volatility flag (optional) | Excluded from v1 | §3.7a |
| Backfill hooked into Settings → Data → "Repair invoice totals" | No backfill needed | The button is for invoice totals; nothing to repair here |
| §7: "Sheets sync remains frozen for line items" | Statement corrected; no sync change | Line Items are in the Sheets sync today |
| Acceptance: "Last Updated timestamp **and actor**" | Date only | See above |
| Operator suggestion (agreed in discussion): lowest / highest / latest cost with margin at today's sell price | Added as the primary view (§3.3) | Answers "is this worth reordering?" most directly |
