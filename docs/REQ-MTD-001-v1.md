# REQ-MTD-001 v1 — MTD-Compatible VAT Export

**Status:** Awaiting gate PASS  
**FM:** FM-5 (Regulatory compliance — CRITICAL, do not defer to v3.x)  
**Risk:** R-004 — MTD compliance gap  
**Version target:** v2.9.32  

---

## Business need

FPM International Ltd is a UK-incorporated trade intermediary (Brighton). As a VAT-registered business, HMRC Making Tax Digital (MTD) for VAT requires FPM to keep digital records and submit VAT returns digitally via MTD-compatible software. Stackd Ops is FPM's primary transaction record system. Without an MTD bridge export, FPM must manually transcribe figures into a separate tool — breaking the HMRC "digital link" requirement and creating compliance exposure.

Stackd Ops cannot submit directly to HMRC (no server-side OAuth). The compliant path is MTD **bridging software** — Stackd exports a digital record (the VAT return boxes + transaction listing) which is then imported into an MTD-registered bridging tool (e.g., ANNA Money, Sage bridging, BTC Software) for submission. This is an approved HMRC pattern under MTD legislation.

---

## Scope

**In scope:**
- VAT Return calculator: user selects a VAT period (date range), portal calculates the 9 statutory VAT return boxes from `DB.inv` data
- On-screen VAT return review before export
- Two export files:
  - **VAT Return Summary CSV** — 9 boxes in HMRC-labelled rows, suitable for MTD bridging import
  - **VAT Transaction Detail CSV** — line-level transaction listing underlying the calculation (digital records requirement)
- UI: new "VAT Return" button on the Invoices tab toolbar, opening a VAT Return modal
- AI_SYSTEM_PROMPT update documenting the VAT return feature

**Out of scope:**
- Direct HMRC API submission (requires OAuth server — v3.0.0)
- Input VAT calculation (FPM does not currently track purchase invoices with VAT in DB)
- VAT groups or partial exemption
- EC acquisition boxes (Box 2, Box 8, Box 9 — post-Brexit these are £0 for FPM; rendered but zero)

---

## VAT return boxes

HMRC VAT 100 — 9 statutory boxes:

| Box | Label | Source in Stackd |
|-----|-------|-----------------|
| 1 | VAT due on sales and other outputs | Sum of `taxAmt` on invoices in period where `taxRate > 0` and status ≠ Cancelled |
| 2 | VAT due on acquisitions from EC | £0.00 (post-Brexit — no EC acquisitions) |
| 3 | Total VAT due (Box 1 + Box 2) | Box 1 + Box 2 |
| 4 | VAT reclaimed on purchases | £0.00 (input VAT not tracked in current DB — flagged in known-gaps) |
| 5 | Net VAT to pay to HMRC (Box 3 − Box 4) | Box 3 − Box 4 |
| 6 | Total value of sales, excl. VAT | Sum of `grand − taxAmt` on invoices in period, status ≠ Cancelled, converted to GBP |
| 7 | Total value of purchases, excl. VAT | £0.00 (input not tracked — flagged in known-gaps) |
| 8 | Total value of goods supplied to EC | £0.00 (post-Brexit) |
| 9 | Total value of goods acquired from EC | £0.00 (post-Brexit) |

All values in GBP. FX conversion via existing `toGBP()` function using configured QR rates. Values rounded to 2 decimal places. No pence rounding correction applied (operator responsibility).

---

## Period selection

User selects a VAT period by entering a **From date** and **To date** (YYYY-MM-DD). Invoices are included where `inv.date >= fromDate && inv.date <= toDate && inv.status !== 'Cancelled'`.

Credit notes (type `credit_note`) are included in Box 6 as negative values (reducing output). Goodwill credits (type `goodwill_credit`) are excluded from Box 6 (not a supply).

No VAT quarter presets required — free date range is sufficient for v1.

---

## Tax amount derivation

The `taxAmt` for an invoice is derived using the existing `iCalc(inv)` function: `iCalc(inv).tax`. This is the authoritative calculated tax figure already used on invoice PDFs.

The net sale value for Box 6 is: `iCalc(inv).grand − iCalc(inv).tax`, converted to GBP via `toGBP(val, inv.cur||'USD')`.

For credit notes included in Box 6: `cnAmount` (stored positive, treated as negative adjustment) — reduces Box 6. `taxAmt` for credit notes: `iCalc(cn).tax` (should be zero for credit notes in FPM's zero-rated model, but derived from data regardless).

---

## Export files

### File 1: VAT Return Summary CSV

Filename: `VAT-Return-<fromDate>-to-<toDate>.csv`

Format:
```
Box,Description,GBP
Box 1,VAT due on sales and other outputs,<value>
Box 2,VAT due on acquisitions from EC (post-Brexit £0),0.00
Box 3,Total VAT due (Box 1 + Box 2),<value>
Box 4,VAT reclaimed on purchases,0.00
Box 5,Net VAT payable to HMRC (Box 3 - Box 4),<value>
Box 6,Total value of sales excluding VAT,<value>
Box 7,Total value of purchases excluding VAT,0.00
Box 8,Total value of goods supplied to EC (post-Brexit £0),0.00
Box 9,Total value of goods acquired from EC (post-Brexit £0),0.00
```

### File 2: VAT Transaction Detail CSV

Filename: `VAT-Transactions-<fromDate>-to-<toDate>.csv`

Columns: `Invoice #,Date,Buyer,Destination,Currency,Net (orig cur),Tax (orig cur),Net GBP,Tax GBP,Status,Type`

One row per invoice/credit note in period. Sorted by `inv.date` ascending.

---

## UI

### Trigger

New button on Invoices tab toolbar: `[&#128196; VAT Return]` — opens `ov-vat` modal.

### Modal: `ov-vat`

- Heading: `VAT Return`
- Sub-heading: `Making Tax Digital — VAT 100`
- Two date inputs: `From` (`id="vat-from"`) and `To` (`id="vat-to"`) — default to first day of previous calendar quarter and last day of previous calendar quarter on open
- `[Calculate]` button → runs calculation, populates the 9-box summary table on screen
- 9-box table: Box number | Description | GBP value — rendered read-only
- Below table: `[&#8659; Export VAT Return CSV]` and `[&#8659; Export Transactions CSV]` buttons — both disabled until Calculate has been run
- Informational note: `"Export the VAT Return CSV to import into your MTD bridging software for HMRC submission. Boxes 2, 4, 7, 8, 9 are zero — input VAT tracking is not yet supported in Stackd (MTD-GAP-001)."`
- `[Close]` button

---

## Known gaps to log

| ID | Area | Summary |
|----|------|---------|
| MTD-GAP-001 | MTD / input VAT | Boxes 4 and 7 are always £0.00 — DB.po records purchase costs in supplier currency but no VAT invoices are captured; input VAT reclaim not supported in v2.9.32 |
| MTD-GAP-002 | MTD / FX rates | `toGBP()` uses live-configured QR rates at export time, not the rate prevailing on the invoice date — historic rate variance is operator's responsibility |

---

## GDPR

No new personal data fields. Export files contain buyer names and invoice numbers — existing data already in scope. Export is download-only to operator device, no external transmission.

---

## FM-1 exception

No new K key, no new DB entity. `_vatReturn` is not stored — calculation is on-demand at export time. This falls under FM-1 exception item 1 (UI layer feature, no new entity).

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Invoices exist in the selected date range | User enters From/To dates and clicks Calculate | Box 1 shows sum of taxAmt (GBP) on non-cancelled invoices in range; Box 6 shows sum of net sale value (GBP) |
| AC-2 | Mix of taxed (20%) and zero-rated (0%) invoices in range | Calculate clicked | Box 1 reflects only the taxed invoices' tax amounts; zero-rated invoices contribute £0 to Box 1 but their net values appear in Box 6 |
| AC-3 | Credit note (type=credit_note) falls within date range | Calculate clicked | Credit note reduces Box 6 by its net value; Box 1 reduced by its tax amount (if any) |
| AC-4 | No invoices in date range | Calculate clicked | All boxes show £0.00; no error thrown |
| AC-5 | Calculation has been run | User clicks Export VAT Return CSV | Browser downloads `VAT-Return-<from>-to-<to>.csv` with 9 rows in specified format |
| AC-6 | Calculation has been run | User clicks Export Transactions CSV | Browser downloads `VAT-Transactions-<from>-to-<to>.csv` with one row per invoice/CN in period |
| AC-7 | Export buttons visible | Calculate not yet run | Both export buttons are disabled |
| AC-8 | Modal opened | Default dates shown | From = first day of previous calendar quarter; To = last day of previous calendar quarter |
| AC-9 | Cancelled invoice in date range | Calculate clicked | Cancelled invoice excluded from all boxes |
| AC-10 | Goodwill credit in date range | Calculate clicked | Goodwill credit excluded from Box 6 and Box 1 (not a supply) |
