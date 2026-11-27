# REQ-LI-003 v4 — Line Item Cost & Margin History (reorder decision modal)

**Status:** Draft v4 — confirmatory resubmission after round-3 CONDITIONAL PASS  
**Supersedes:** REQ-LI-003-v3.md (and v2, v1)  
**Schema impact:** None. No new stored fields on the Line Item or its history entries, no `localStorage` key change, no Supabase migration, no Sheets-sync change (§7).  
**Version target:** v2.9.104  
**Operator scope source:** operator-written feature scope pasted 2026-11-27 (sections 1–9) plus their answers the same day. Departures are listed in §12.

**Round-3 gate result (CONDITIONAL PASS) — how it was handled:** no blocking findings. The five should-fix items (AC-13 vs the tolerance, wrong "Sheets pull" advice, the unreachable zero-history case, undefined order-entry ordering/lookup and a missing "Last charged on" criterion, and staleness criteria missing price drift and float-safe values) are closed in v4; the four nits are applied. The "Sheets pull" error was also in the author's own chat advice and is corrected everywhere: the destructive action is **Import Data → CSV import, or Import from Sheets**; an ordinary Sheets sync (`pullAll`) keeps history.

**Round-2 gate result (FAIL) — how it was handled:** all six round-1 blockers were confirmed closed. The FAIL came from the new import fix (v2 §3.10, AC-20 to AC-22): its scope was undecided, AC-22 widened into the known Cloud Data importer gap, and it misdescribed the second import path as CSV (it is the Import-from-Sheets path, reached from `importFromSheets()`). The operator decided on 2026-11-27 to **split the import bug out** as its own gap and fix (`LI-GAP-007`); v3 removes §3.10 and those three acceptance criteria and adds the remaining reviewer points (order-entry price label, a no-catalogue-entry state, a staleness tolerance, a clearer read-only criterion). The reviewer also withdrew its round-1 B6 inference about the dedupe (confirmed at `index.html:8941`).

**Round-1 gate result (FAIL) — how it was handled:** six blocking and eight should-fix findings, each re-verified against `index.html` by the author before being accepted. B1 (stale citations) was the author's own error: they were measured before PR #170 shifted the file; every citation in this version is re-measured at the current commit. B3–B6 and S1–S8 are addressed in §3, §9 and §11. One agent inference was **not** accepted as written: B6's claim that the invoice auto-recording skips an order entry "for a price that was already a catalogue price". The code dedupes per invoice **and** price (`h.invoiceRef === inv.num && h.price === invoicePrice`, `index.html:8941`); the real source of lossiness is the earlier deviation guard (`index.html:8938`), recorded in §3.4.

---

## 1. Business need

When reordering a product from a supplier, the operator needs to see — in one place and in seconds — **what that item has cost from the supplier over time, and what margin is attainable at today's sell price**, so they can decide whether the reorder is commercially viable.

- Used on each reorder; the operator expects repeat orders for the same products.
- "Bought for" means the **unit cost from the supplier side** (the Line Item's Unit Cost, `cost`). It is not the sell price and is not read from Purchase Order lines.
- Not a reporting feature: no forecasting, no portfolio analytics (§8).

## 2. Current behaviour (verified in code, `index.html` at the current commit)

| Fact | Where |
|---|---|
| Line Item price history is an **inline expandable row** under the price, toggled by a small "N pt(s)" badge — not a modal. The "clock icon" in the operator scope and in the AI prompt belongs to **Quote** line history, not Line Items. | badge `index.html:8152`, `togglePH()` `index.html:8184` |
| Each history entry is `{date, cost, price, invoiceRef, notes}`. | `saveLI()` `index.html:8223`; pushes at `index.html:8232`, `index.html:8235`; `saveInv()` push at `index.html:8942` |
| An entry is written (a) on creation and (b) when Unit Cost **or** Unit Price changes on save, both with `invoiceRef: ''`; and (c) by `saveInv()` **only when an invoice line's price differs from the current catalogue price** (`index.html:8938`), as `notes: 'Price at time of order'` with `invoiceRef` = the invoice number, `price` = the invoice's unit price **in the invoice's currency**, `cost` = the catalogue cost at the moment of saving (catalogue currency), `date` = the invoice date. | `index.html:8232`, `index.html:8235`, `index.html:8938`–`index.html:8942` |
| Line Items have no duty % or markup % field. (The "cost, duty %, markup %" trigger in the operator scope and in two `AI_SYSTEM_PROMPT` lines describes **Quote** line versioning.) | `saveLI()` record literal `index.html:8271` |
| The catalogue row already shows margin % on price, `(price − cost) / price × 100`, with pill bands ≥20 good, ≥10 medium, else low. | `index.html:8149`–`index.html:8150`; `liMgn()` `index.html:8189` |
| Entries are appended in **save order**, not date order (an invoice dated earlier but saved later lands after a newer entry). | `index.html:8942` |
| `saveLI()` coerces a blank cost or price to 0, so a cost of 0 is normal data meaning "not entered". | `index.html:8225`–`index.html:8226` |
| A Line Item saved through the form has **no creation or last-updated timestamp** (the record literal is a whitelist). Both Line Item import paths (CSV and Import-from-Sheets) do write `updAt` onto the record, which the next `saveLI()` drops. There is **no user identity** in the app; `logEv()`'s default actor is the string `user` and some call sites pass `operator`. | `index.html:8271`; imports `index.html:11604`, `index.html:11928`; `logEv()` `index.html:4561` |
| **Both Line Item import paths replace an existing record wholesale** (`DB.li[i]=rec`) with a literal that omits `priceHistory`, `invoiceRefs` and the `num` (`LI-####`) — and the Sheets-import path also omits `dims` and `dg`. They are the CSV import `processImport()` and the Import-from-Sheets path `processImportRecords()` (reached from `importFromSheets()` at `index.html:11824`, called at `index.html:11861`); both write locally only. Importing over an existing item therefore erases its price history. **Existing defect, found by the round-1 gate, OUT OF SCOPE here — logged as `LI-GAP-007` and to be fixed under its own REQ (§3.10).** No test exercises either path. | `index.html:11600`–`index.html:11606`, `index.html:11924`–`index.html:11930` |
| A Sheets pull changes an existing item's `cost` and `price` but keeps local `priceHistory` (`Object.assign({}, local, pulled)`); it writes **no** history entry. A Line Item that first arrives via Sheets has no history at all. | `mergePulledWithLocal()` `index.html:5188`–`index.html:5196` |
| Cloud Data rebuilds each Line Item from an **explicit field list** on refresh; a new stored field is dropped unless a column and four touchpoints are added. `priceHistory` rides in one `jsonb` column. | `index.html:6442`–`index.html:6449` |
| Line Items **are** in the Google Sheets sync (`sku, desc, uom, cost, price, cur, hs, supId, notes`). | `FIELD_MAPS` `index.html:5138`–`index.html:5148` |
| An existing **toolbar button "Price History CSV"** exports every history row for every Line Item (columns SKU, Description, Currency, Current Cost, Current Price, History Date/Cost/Price, Invoice Ref, Notes). It protects cells with `csvSafe()` but does not use `csvRow()` and does not filter demo records. | button `index.html:302`, `expPriceHistoryCSV()` `index.html:13545` |
| `getSupplierPriceHistory()` reads **every** Line Item history entry's `cost` — order entries included — as a supplier price point for the Supplier modal's price-history panel and staleness check. | `index.html:6190`, `supPriceStaleness()` `index.html:6225` |
| Existing documentation is wrong in two `AI_SYSTEM_PROMPT` lines ("Click the clock icon on any line … only when cost, duty %, or markup %") and `docs/user-guide.md` has no Line Item price-history section. | `index.html:12576`, `index.html:12737`; `docs/user-guide.md` |

## 3. Behaviour

### 3.1 Entry point
The history badge on a Line Items row opens a **modal** (not an inline row). The inline expandable row and `togglePH()` are removed; nothing else references `ph-<id>` or `togglePH`. A Line Item with **no history entries at all** shows no badge and has no modal (unchanged); its current cost, price and margin are already on its row, so the modal would add nothing. This is also the common state of an item whose history an import erased (§3.10). Any existing test that asserts the inline row's HTML is updated to the modal (none was found referencing `togglePH` or `ph-`; the suite has ~107 `priceHistory` references, each reviewed, not bulk-edited).

### 3.2 Header
`Cost & Margin History — <SKU> <Description>` (SKU omitted when blank), then the supplier name and the Line Item currency (`li.cur || 'USD'`). Supplier shows `No supplier` when `supId` is blank and `Unknown supplier` when it no longer resolves (SUP-GAP-001 leaves a dangling id). Below: **Last price change: <date>**, derived as the date of the newest *catalogue* entry (§3.4). No "last updated by" actor is shown (§12).

### 3.3 Cost range summary (primary view)
Computed over **catalogue entries with a usable cost** (§3.4, §3.5a). Rows: **Lowest cost**, **Highest cost**, **Latest cost** — each with the cost, the date it applied and **the margin at today's sell price** (`li.price`): `(price − cost) / price × 100`. A separate, always-present row **Current catalogue cost** shows `li.cost` with its margin at `li.price`.

- **Staleness notice.** Compare `li.cost` with the latest catalogue entry's cost and `li.price` with its price (latest = newest in date order, §3.4), each rounded to 3 decimals; if either pair differs by **0.001 or more** (the tolerance `saveInv()` already uses), a notice states: "The catalogue cost/price has changed since the last history entry (for example by a Sheets pull or an import) — history may be incomplete." A comparison is skipped for a field whose latest-entry value is unusable (§3.5a): with nothing comparable, no notice is raised for that field. This is the operator's most important staleness signal at reorder time.
- "Today's sell price" means `li.price`. The most recent order entry (§3.4) whose invoice currency is known **and equals the Line Item currency** is shown as context: `Last charged on <invoice> at <price>`; it is omitted otherwise.
- If `li.price` ≤ 0 or blank, margins show "n/a". If every usable catalogue cost is equal, Lowest, Highest and Latest collapse into one row. If only one catalogue entry exists the modal says "Only one price on record — no trend yet".
- **No catalogue entries but at least one order entry** (reachable, for example after an import erased the history and the item was then invoiced at a deviating price): the badge still appears and the modal shows the **Current catalogue cost** row and the order-entry section, with the message "No catalogue price history — only prices charged on orders are recorded". Lowest, Highest, Latest, Last price change and the trend are hidden.

### 3.4 Two kinds of history entry — never mixed in maths
- **Catalogue entry**: `invoiceRef` is empty, whitespace, null or absent. (Entries written by older versions or restored from older backups that lack the key are therefore catalogue entries.) These are changes to the supplier price list: creation, or a cost/price edit through the form.
- **Order entry**: `invoiceRef` is a non-blank string (today only `saveInv()` writes these, and always with a non-blank invoice number).

Order entries exist **only where the invoice price differed from the then-current catalogue price** (`index.html:8938`); they are not a complete order history and the modal labels the section "Prices charged that differed from the catalogue". Shifts, the cost range, the trend and "last price change" use catalogue entries only, ordered by `date` ascending with array position as the tie-break (same-day edits are normal: `today()`).

Order entries are ordered like catalogue entries — by `date`, with array position as the tie-break — and "most recent" means last in that order. Each is listed with date, invoice reference and price charged. **Invoice lookup:** an exact match of the entry's `invoiceRef` against `DB.inv[].num` (first match; the UI prevents duplicate numbers but an invoice CSV import can bypass that); an invoice that is missing, renumbered or deleted counts as "not found". **Currency rule:** an order entry carries no currency, so the modal looks up the invoice by `invoiceRef` and uses its `cur`. An order entry's **price is labelled with the invoice's currency** when the invoice can be found, and "currency unknown" when it cannot (never silently with the Line Item currency). The margin for an order entry is shown **only when that currency equals the Line Item currency**; if the invoice is missing, or the currencies differ, the margin shows "n/a (different or unknown currency)". Order entries carry no shift badges. Re-saving the same invoice at a changed price adds a further order entry for that invoice (the dedupe keys on invoice and price), and each is listed.

### 3.5 Timeline table (catalogue entries, newest first)
Columns: Date · Unit Cost · Unit Price · Margin % · Notes. Beside Cost and Price the **change from the previous catalogue entry**, absolute and percent, with the Line Item currency symbol/code and 3-decimal formatting consistent with the existing rows (`fmtN(value, cur, 3)`), e.g. `↑ USD 2.500 (+5.2%)`. Beside Margin the change in **percentage points** (`↑ 2.3 pp`). The oldest entry shows no change. Increases and decreases are coloured green and red; hover text states the change in words. Everything is computed when the modal renders from each entry's own `cost` and `price`; nothing is stored. The table body scrolls; there is no cap on entries.

### 3.5a Numeric rules
- A **cost ≤ 0 or non-numeric** is treated as "no cost recorded": shown `–`, excluded from the range and from shifts. A **price ≤ 0 or non-numeric** makes that entry's margin `n/a` and excludes its price shift.
- A **percent change is `n/a`** (absolute change still shown) when the previous value is 0 or excluded.
- **Negative margins** (cost above price) are shown with their sign and use the "low" band.
- The neutral **"At cost"** state applies when `|cost − price| < 0.001` (the tolerance `saveInv()` already uses), not on exact equality.
- **Currency edits are not detected.** `li.cur` can be changed in `saveLI()` and entries store no currency, so shifts across such an edit are not meaningful; this is an accepted limitation (§9).

### 3.6 Trend line
With two or more usable catalogue entries: `Cost ↑ 8.5% | Price ↑ 3.2% | Margin ↓ 4.1 pp`, first usable entry to latest; a part whose first or latest value is unusable shows "n/a". Hidden if fewer than two usable entries.

### 3.7 Margin health badge
Bands match the existing catalogue pill (≥20 good, ≥10 medium, <10 low). A Line Item at cost (§3.5a) shows a neutral **"At cost"** badge, not "Low margin".

### 3.7a Volatility flag
Excluded from v1 (decided): unlikely to fire on repeat-order data, and it would need to exclude order entries.

### 3.8 Per-item CSV export
**Export as CSV** in the modal: one row per history entry, both kinds, columns `Date, Type (catalogue|order), Unit Cost, Unit Price, Margin %, Cost shift, Price shift, Margin shift (pp), Invoice Ref, Notes`, written through `csvRow()` (handles commas, quotes, newlines and `= + - @` neutralisation, SEC-GAP-026). The **toolbar "Price History CSV" button and `expPriceHistoryCSV()` are unchanged** (all-items export, its own column set); this feature does not touch it. Demo Line Items carry no history, so there is nothing to export for them; no demo filtering is added.

### 3.9 Rendering safety
Every free-text value rendered in the modal (SKU, description, supplier name, notes, invoice reference) goes through `san()`; the modal must neutralise an HTML payload in `notes` exactly as the old inline row did.

### 3.10 Import paths — out of scope (`LI-GAP-007`)
The Line Item import data-loss defect (§2) is **not** fixed by this release and the modal does not depend on it: an item whose history an import erased shows fewer or no catalogue entries; if none remain it has no badge or modal (§3.1) — a known limitation — and if some remain the §3.3 staleness notice says so. It is to be fixed under its own REQ covering both import paths (CSV and Import-from-Sheets), every lost field (`priceHistory`, `invoiceRefs`, `num`, and on the Sheets path `dims` and `dg`), blank-column handling, and the Cloud Data question; until then, **do not use Import Data → CSV import, or Import from Sheets → Line Items, over existing items you want to keep history or numbering for.** An ordinary Sheets sync keeps history.

## 4. Data model
**No change** to Line Item fields or history entries. Margin and every shift are derived on render.

## 5. Backward compatibility
Nothing to backfill: every existing entry already has the `cost` and `price` the maths needs, so the modal works on first load, on a restored backup, across Cloud Data refresh and across a Sheets pull. Entries lacking an `invoiceRef` key are catalogue entries (§3.4). History already erased by a past import cannot be recovered.

## 6. GDPR
No personal data in the history fields. Supplier names and prices are business data already stored. `notes` is operator free text and is not inspected; a promotion note may carry a Quote number. The per-item CSV is a local download with no external transmission.

## 7. Cloud Data / Sheets sync
No schema, column, mapping or sync change, so none of the four Cloud Data touchpoints and no `schema-migration-reviewer` pass is needed for the modal. The import paths (§3.10) are untouched by this release. The operator scope says Sheets sync is "frozen for line items"; that is **not** true (`index.html:5138`) — this feature simply adds no synced field. `getSupplierPriceHistory()` (`index.html:6190`) keeps treating every entry's `cost` as a supplier price point, order entries included; this feature does not change it (logged as a gap, §9).

## 8. Out of scope
- Any stored `lastUpdatedAt` / `lastUpdatedBy` / audit trail → v3.0 (Notion tracker row 185); needs a user identity first.
- Recalculating prices on existing invoices; changes to Sheets sync; versioning on non-price fields (already not done); a margin override on the Line Item form; forecasting.
- Reading actual costs from Purchase Order lines.
- The volatility flag; Purchase Order and credit-note PDFs; any change to the toolbar "Price History CSV" or to `getSupplierPriceHistory()`.
- Writing a history entry for a cost/price change that arrives via Sheets pull.
- The Line Item import paths and their data loss (`LI-GAP-007`, §3.10).

## 9. Risks and accepted limitations
1. **The history is only as complete as the catalogue.** A repeat order at a new supplier price that is never entered into the Line Item's Unit Cost leaves no entry; a Sheets pull can also change cost/price without one. §3.3's staleness notice reduces, but does not remove, this.
2. Order entries record the catalogue cost at invoice-save time and only appear where the invoice price deviated; they are labelled and excluded from the maths.
3. Currency edits between entries are not detected (§3.5a).
4. Thin history on items the operator only recently started maintaining; "Only one price on record" is the honest result.
5. **Gaps logged with this REQ:** `LI-GAP-007` (the import data loss, §3.10) now; and on ship, that `getSupplierPriceHistory()` treats order-entry costs as supplier price points (§7).

## 10. Decisions recorded (formerly open questions)
Volatility flag out of v1; modal-only (no cost hint on the Line Items row); toolbar CSV unchanged; PO-line cost cross-check is a possible later release. Decided by the operator: the import data-loss fix is split out as `LI-GAP-007` under its own REQ.

## 11. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A Line Item with ≥1 history entry | Operator clicks the history badge | A modal opens; no inline row exists in the DOM; `togglePH` is gone |
| AC-2 | Catalogue entries costs 10, 12, 11; `li.price` 20; `li.cost` 11 | Modal renders | Lowest 10, Highest 12, Latest 11 with margins 50.0 / 40.0 / 45.0; Current catalogue cost 11 (45.0); no staleness notice |
| AC-3 | `li.price` 0 or blank | Modal renders | Margins "n/a"; no NaN or Infinity anywhere |
| AC-4 | Catalogue entries cost 10 then 12, USD | Table renders | Cost change `↑ USD 2.000 (+20.0%)`; margin change in pp; oldest entry has no change |
| AC-5 | Catalogue cost 10, then an order entry at a discounted price, then catalogue cost 12 | Modal renders | The cost-12 change is measured against cost 10; the order entry appears only in its own section and in no shift, range or trend |
| AC-6 | Entries in array order ≠ date order | Modal renders | Shifts, trend, range and "last price change" follow date order; same-day entries follow array order |
| AC-7 | ≥2 usable catalogue entries | Modal renders | Trend line first→latest with margin in pp |
| AC-8 | One catalogue entry | Modal renders | "Only one price on record — no trend yet"; no trend line |
| AC-9 | An entry with cost 0, blank or non-numeric | Modal renders | Cost shown `–`; excluded from range and shifts; no NaN |
| AC-10 | A previous value of 0 | Shift renders | Absolute change shown, percent "n/a" |
| AC-11 | Margins 25 / 15 / 5 | Badge renders | good / medium / low per the 20/10 bands |
| AC-12 | `|cost − price| < 0.001` | Badge renders | Neutral "At cost", not "Low margin"; cost above price shows a negative margin in the low band |
| AC-13 | `li.cost` differs from the latest catalogue entry's cost by 0.001 or more (for example after a Sheets pull) | Modal renders | The staleness notice is shown; the Current catalogue cost row shows the live `li.cost`. AC-21 gives the boundary cases |
| AC-14 | An order entry whose invoice currency equals the Line Item currency / differs / the invoice is deleted (the margin; AC-22 covers the price label) | Modal renders | Margin shown / "n/a (different or unknown currency)" / "n/a (different or unknown currency)" |
| AC-15 | An entry with `invoiceRef` blank, whitespace, null or the key absent | Modal renders | Classified as a catalogue entry |
| AC-16 | `notes`, SKU, description and supplier name containing `<img src=x onerror=...>` | Modal renders | The payload is escaped and inert |
| AC-17 | Blank SKU; blank supplier; deleted supplier | Header renders | SKU omitted; "No supplier"; "Unknown supplier" |
| AC-18 | A note containing a comma, a double quote, a newline and one beginning `=cmd` | Per-item CSV export | Correctly quoted; the formula cell neutralised; one row per entry; both kinds present with a Type column |
| AC-19 | A Line Item with history | The modal is opened and closed with no other action | Nothing is written: the Line Item record and every history entry are identical before and after (the modal is read-only) |
| AC-20 | An item with no catalogue entries but ≥1 order entry | Modal renders | Badge present; message "No catalogue price history — only prices charged on orders are recorded"; Current catalogue cost row and the order-entry section shown; Lowest, Highest, Latest, Last price change and trend hidden; no NaN |
| AC-21 | Latest catalogue entry cost 10, price 20; live `li.cost` / `li.price` = 10.0004 / 20 (cost off by 0.0004) · 10.01 / 20 (cost off by 0.01) · 10 / 20.01 (price-only) · 10.01 / 20.01 (both) · a latest entry whose own cost is 0 | Modal renders | No notice · notice · notice · notice · no cost-based notice (price compared only) |
| AC-22 | An order entry whose invoice is found / not found | Modal renders | Price labelled with the invoice's currency / labelled "currency unknown" |
| AC-23 | A restored pre-feature backup / Cloud Data refresh / ordinary Sheets sync | Modal opened | Works with no migration step |
| AC-24 | Toolbar "Price History CSV" | Clicked after this release | Output byte-identical to before the release for the same data |
| AC-25 | Release docs | Delivery | `AI_SYSTEM_PROMPT` lines `index.html:12576` and `index.html:12737` corrected and a new passage distinguishes Line Item history from Quote-line history and names the history badge, not a clock icon |
| AC-26 | Release docs | Delivery | `docs/user-guide.md` gains a Line Item cost-history section (add, not update); in-app changelog block added |
| AC-27 | Release docs | Delivery | The three hardcoded version strings in `index.html` and the `AI_SYSTEM_PROMPT` self-description read v2.9.104 (`grep` for the old string finds none outside the changelog and feature labels) |
| AC-28 | Release docs | Delivery | `docs/version-history.md`, `CLAUDE.md` (version and test count), `docs/known-gaps.md` (the supplier price panel treats order entries as cost points; `LI-GAP-007` already logged), `STACKD_CONTEXT.md` backlog and `docs/requirements-tracker.md` updated; Notion tracker rows added or updated |
| AC-29 | Tests | Delivery | Any existing test asserting the inline history row is updated; new tests cover AC-1 to AC-24 and AC-30 to AC-32 |
| AC-30 | Two order entries with known invoices, one in the Line Item currency and later by date | Modal renders | "Last charged on <invoice> at <price>" shows the latest-dated one whose currency matches; omitted when none matches or the invoice is not found |
| AC-31 | An order entry whose `invoiceRef` matches two invoices / a renumbered or deleted invoice | Modal renders | First match is used / treated as not found, price labelled "currency unknown" |
| AC-32 | A catalogue entry with usable cost but price 0 | Trend renders | The Price part of the trend shows "n/a"; Cost and Margin parts follow the §3.5a rules |

## 12. Deviations from the operator scope (all reversible on request)

| Operator scope | This REQ | Why |
|---|---|---|
| "Price History **Modal**" opened by a **clock icon** | Real modal (operator confirmed) opened from the existing "N pt(s)" badge | The clock icon belongs to Quote-line history; Line Item history is currently an inline row. The AI prompt repeats the same mistake and is corrected (AC-25) |
| Versioning triggered by cost, **duty %, markup %** | Cost and price only, unchanged | Duty/markup are Quote fields, not Line Item fields |
| Store `marginPct`, `costShift`, `priceShift`, `marginShift`; backfill | Compute on render; store nothing | Derivable from each entry's own cost and price; stored copies drift and force a backfill; "margin shift %" is meaningless (the scope itself asks for pp) |
| Shift/trend over **all** entries | Catalogue entries only; order entries separate, currency-checked | An invoice-sourced entry would show a one-off discount as a price drop then a rise; order entries carry no currency |
| `lastUpdatedAt`, `lastUpdatedBy` stored, backfilled from a "creation timestamp" / "system" | Derived "Last price change" date; no actor | Line Items have no creation timestamp; no user identity exists; a stored field needs a Cloud Data column, migration and four touchpoints; deferred to the v3.0 audit trail |
| Margin health green >30% / red <10% | Existing 20/10 bands; neutral "At cost" | One definition of "healthy" per screen; at-cost pass-through items are legitimate |
| Volatility flag (optional) | Excluded from v1 | §3.7a |
| Backfill hooked into Settings → Data → "Repair invoice totals" | No backfill | The button is for invoice totals; nothing to repair here |
| §7: "Sheets sync remains frozen for line items" | Statement corrected; no sync change | Line Items are in the Sheets sync today |
| Acceptance: "Last Updated timestamp **and actor**" | Date only | See above |
| Operator suggestion (agreed in discussion): lowest / highest / latest cost with margin at today's sell price | Added as the primary view (§3.3), plus a Current catalogue cost row and a staleness notice | Answers "is this worth reordering?" and shows when the history cannot be trusted |
| — (not in the operator scope) | Import data-loss bug found by the gate is **excluded** and logged as `LI-GAP-007` | Operator decision: it is wider than history (also `num`, `invoiceRefs`, and on the Sheets path `dims`/`dg`), touches both import paths and the known Cloud Data importer gap, and the modal does not depend on it |
