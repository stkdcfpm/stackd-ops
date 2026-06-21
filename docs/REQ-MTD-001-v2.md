# REQ-MTD-001 v2 — MTD-Compatible VAT Export

**Status:** Awaiting gate PASS  
**Supersedes:** REQ-MTD-001-v1.md  
**FM:** FM-5 (Regulatory compliance — CRITICAL, do not defer to v3.x)  
**Risk:** R-004 — MTD compliance gap  
**Version target:** v2.9.32  

---

## Business need

FPM International Ltd is a UK-incorporated trade intermediary (Brighton). As a VAT-registered business, HMRC Making Tax Digital (MTD) for VAT requires FPM to keep digital records and submit VAT returns digitally via MTD-compatible software. Stackd Ops is FPM's primary transaction record system. Without an MTD bridge export, FPM must manually transcribe figures into a separate tool — breaking the HMRC "digital link" requirement and creating compliance exposure.

Stackd Ops cannot submit directly to HMRC (no server-side OAuth). The compliant path is MTD **bridging software** — Stackd exports a digital record (the VAT return boxes + transaction listing) which the operator imports into an MTD-registered bridging tool (e.g., ANNA Money, Sage bridging, BTC Software) for submission. This is an approved HMRC pattern under MTD legislation.

---

## Scope

**In scope:**
- VAT Return calculator: user selects a VAT period (date range), portal calculates the 9 statutory VAT return boxes from `DB.inv` data
- On-screen VAT return review before export
- Two export files:
  - **VAT Return Summary CSV** — 9 boxes in HMRC-labelled rows, suitable for MTD bridging import
  - **VAT Transaction Detail CSV** — line-level transaction listing underlying the calculation (digital records requirement)
- UI: new `[VAT Return]` button on the Invoices tab toolbar, opening a VAT Return modal (`ov-vat`)
- `AI_SYSTEM_PROMPT` update documenting the VAT return feature

**Out of scope:**
- Direct HMRC API submission (requires OAuth server — v3.0.0)
- Input VAT calculation (FPM does not currently track purchase invoices with VAT in DB — MTD-GAP-001)
- VAT groups or partial exemption
- EC acquisition boxes (Box 2, Box 8, Box 9 — post-Brexit these are £0 for FPM; rendered but zero)

---

## Data type clarification

`inv.date` is stored as a YYYY-MM-DD ISO 8601 string (e.g., `"2026-03-15"`). String lexicographic comparison on ISO 8601 YYYY-MM-DD is safe and correct. The period filter uses `inv.date >= fromDate && inv.date <= toDate` as string comparisons.

---

## Invoice inclusion rule

An invoice is **included** in the VAT return calculation if ALL of the following are true:
1. `inv.date >= fromDate` and `inv.date <= toDate` (string comparison, both bounds inclusive)
2. `inv.status !== 'Cancelled'`

All other statuses (Draft, Pro-forma, Sent, Partially Paid, Paid) are **included**. "Cancelled" is the **only** excluded status. This applies equally to standard invoices and credit notes.

Goodwill credits (`inv.type === 'goodwill_credit'`) are **excluded entirely** from all VAT box calculations — they do not represent a supply and carry no VAT. They do **not** appear in the VAT Transaction Detail CSV.

Credit notes (`inv.type === 'credit_note'`) are **included** and reduce Box 1 and Box 6 (see box definitions below).

---

## `iCalc(inv).grand` — confirmed VAT-inclusive

`iCalc(inv).grand` is the VAT-**inclusive** (gross) invoice total — the figure printed at the bottom of the invoice PDF as "Grand Total". It includes tax. Therefore:

**Net sale value for Box 6** = `iCalc(inv).grand − iCalc(inv).tax`

For zero-rated invoices (`taxRate = 0`), `iCalc(inv).tax = 0`, so the net equals the grand total. This formula is correct in both cases.

---

## Credit note VAT treatment

All credit notes in FPM's model are zero-rated (the underlying supply was a zero-rated export). Consequently `iCalc(cn).tax = 0` for all credit notes in practice. The Box 1 clause in AC-3 ("Box 1 reduced by its tax amount (if any)") is vacuously true — the reduction is always £0 for credit notes in FPM's operating context. The implementation must nonetheless apply the subtraction in the general case (`Box 1 -= iCalc(cn).tax` where `cn.type === 'credit_note' && cn.status !== 'Cancelled'`), so the logic is correct should a non-zero credit note tax arise. This is not a new scenario to test; AC-3 is acknowledged as vacuously satisfied at zero by FPM's current data.

---

## VAT return boxes

| Box | Label | Derivation |
|-----|-------|-----------|
| 1 | VAT due on sales and other outputs | `sum(iCalc(inv).tax for non-CN invoices in period, status ≠ Cancelled)` minus `sum(iCalc(cn).tax for credit_note in period, status ≠ Cancelled)`. Converted to GBP via `toGBP(val, inv.cur\|\|'USD')`. |
| 2 | VAT due on acquisitions from EC (post-Brexit) | £0.00 |
| 3 | Total VAT due (Box 1 + Box 2) | Box 1 + Box 2 |
| 4 | VAT reclaimed on purchases | £0.00 (MTD-GAP-001) |
| 5 | Net VAT payable to HMRC (Box 3 − Box 4) | Box 3 − Box 4 |
| 6 | Total value of sales excl. VAT | `sum((iCalc(inv).grand − iCalc(inv).tax) for non-CN invoices in period, status ≠ Cancelled)` minus `sum((iCalc(cn).grand − iCalc(cn).tax) for credit_note in period, status ≠ Cancelled)`. All converted to GBP. |
| 7 | Total value of purchases excl. VAT | £0.00 (MTD-GAP-001) |
| 8 | Total value of goods supplied to EC (post-Brexit) | £0.00 |
| 9 | Total value of goods acquired from EC (post-Brexit) | £0.00 |

All values rounded to 2 decimal places. GBP conversion uses `toGBP(val, cur)` with current QR rates (MTD-GAP-002 acknowledged).

---

## Period selection and default dates

**Quarter definition:** Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec.

**Previous quarter:** the completed calendar quarter immediately before the quarter in which today's date falls. If today = 1 April (first day of Q2), previous quarter = Q1 (1 Jan – 31 Mar). The boundary is calendar-quarter based, not "look back 90 days."

**Default values on modal open:** From = first day of previous quarter (YYYY-01-01, YYYY-04-01, YYYY-07-01, or YYYY-10-01); To = last day of previous quarter (YYYY-03-31, YYYY-06-30, YYYY-09-30, or YYYY-12-31). Computed from `new Date()` at modal open time.

---

## Export files

### File 1: VAT Return Summary CSV

Filename: `VAT-Return-<fromDate>-to-<toDate>.csv`

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

Columns: `Invoice #,Date,Buyer,Destination,Type,Status,Currency,Gross (orig cur),Net (orig cur),Tax (orig cur),Net GBP,Tax GBP`

- One row per invoice (non-cancelled, non-goodwill-credit) in period, sorted by `inv.date` ascending then `inv.num` ascending.
- Credit note rows carry **negative values** in `Gross`, `Net`, and `Tax` columns to reflect their reducing effect.
- Goodwill credits are **omitted entirely** from this file.

---

## UI

### Trigger

Existing Invoices tab toolbar (the row of buttons above the invoice list). Add: `<button class="btn btn-s" onclick="openVATReturn()">&#128196; VAT Return</button>`

### Modal: `ov-vat`

- Heading: `VAT Return`
- Sub-heading: `Making Tax Digital — VAT 100`
- From date input (`id="vat-from"`) and To date input (`id="vat-to"`), both type="date", defaulted on open
- `[Calculate]` button → runs `calcVATReturn()`, populates 9-box table
- 9-box table: read-only display of Box, Description, GBP value
- `[↓ Export VAT Return CSV]` button (`id="vat-export-summary"`) — disabled until Calculate has been run
- `[↓ Export Transactions CSV]` button (`id="vat-export-txn"`) — disabled until Calculate has been run
- Informational note below buttons: `"Export the VAT Return CSV and import it into your MTD bridging software (e.g. ANNA Money, Sage, BTC Software) for HMRC submission. Boxes 2, 4, 7, 8, 9 are £0.00 — input VAT tracking is not yet supported (MTD-GAP-001)."`
- `[Close]` button

---

## GDPR

FPM's buyers are exclusively B2B legal entities (company names such as "Apex Cold Chain GmbH", "Regency Wholesale Ltd") — not natural persons. Buyer names in `DB.inv` are business entity names; no personal data (as defined under UK GDPR Art.4(1)) is present in the `inv.buyer` field. The VAT Transaction Detail CSV therefore contains no personal data subject to GDPR data subject rights.

The VAT Return Summary CSV contains no buyer names at all.

Operator responsibility: the operator selects and maintains their MTD bridging tool. No new data processor relationship is created by Stackd — the export is a download to the operator's device only.

No new GDPR basis required.

---

## FM-1 exception

No new K key, no new DB entity. The VAT calculation is on-demand (not persisted). Falls under FM-1 exception item 1 (UI/AI layer feature with no new entity).

---

## Known gaps to log

| ID | Area | Summary |
|----|------|---------|
| MTD-GAP-001 | MTD / input VAT | Boxes 4 and 7 are always £0.00 — DB.po records purchase costs but no UK VAT invoices are captured; input VAT reclaim not supported in v2.9.32 |
| MTD-GAP-002 | MTD / FX rates | `toGBP()` uses configured QR rates at export time, not the rate on each invoice date — historic rate variance is operator's responsibility |

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Invoices with `taxRate=0` and `taxRate=0.2` in date range, none Cancelled | Calculate clicked | Box 1 = sum of `iCalc(inv).tax` (GBP) for invoices with tax; Box 6 = sum of `iCalc(inv).grand − iCalc(inv).tax` (GBP) across all included invoices |
| AC-2 | Only zero-rated invoices in range | Calculate clicked | Box 1 = £0.00; Box 6 = sum of grand totals (GBP) |
| AC-3 | Credit note (type=credit_note, status≠Cancelled) in date range | Calculate clicked | Box 6 reduced by credit note net (grand − tax) GBP value; Box 1 reduced by credit note tax (£0.00 in practice for FPM's zero-rated model) |
| AC-4 | No invoices in date range | Calculate clicked | All 9 boxes show £0.00; no error thrown |
| AC-5 | Calculation has been run | Export VAT Return CSV clicked | Browser downloads `VAT-Return-<from>-to-<to>.csv` with 9 rows, all values in GBP to 2 d.p. |
| AC-6 | Calculation has been run | Export Transactions CSV clicked | Browser downloads `VAT-Transactions-<from>-to-<to>.csv`; credit note rows have negative Net and Tax values; goodwill credits absent |
| AC-7 | Modal just opened | Export buttons inspected | Both export buttons are disabled (enabled only after Calculate is run) |
| AC-8 | Modal opened on any date | Default dates inspected | From = first day of previous calendar quarter; To = last day of previous calendar quarter |
| AC-9 | Cancelled invoice in date range | Calculate clicked | Cancelled invoice excluded from all boxes and transaction CSV |
| AC-10 | Goodwill credit in date range | Calculate clicked | Goodwill credit excluded from all boxes and absent from transaction CSV |
