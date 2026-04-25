# Stackd Ops — QA Framework & Changelog

## How to Use This Document
Run through the test checklist after every change before considering a release stable.
Log every test run in the Test Log section with date, tester, pass/fail per section, and notes on failures.
Every release gets a changelog entry.

---

## Changelog

### v2.1 — 2026-04-21
**Fix:** Invoice/PO print rendering — replaced DOM-manipulation print approach with dedicated new-window print method. Resolves issue where `window.print()` was printing the invoice table row instead of the invoice document. Root cause: `window.print()` fires before browser repaints DOM visibility changes.

### v2.0 — 2026-04-21
**Fix:** Complete JavaScript rebuild to resolve Safari/local-file compatibility and Python string-escaping corruption. All JS rewritten as raw file avoiding any Python template processing. Regex patterns (`/\s+/g`) and template literals were being silently corrupted during build. Switched from arrow functions to ES5 `function(){}` syntax for broader browser compatibility.

### v1.0 — 2026-04-21
**Release:** Initial Stackd Ops build. Four-entity model: Suppliers, Line Items, Invoices, Purchase Orders. Google Sheets sync via Apps Script. Auto-generation of POs from invoice save. Print preview for invoices and POs. Deposit tracking (buyer and supplier). Dynamic tax rate selector.

---

## Test Checklist

Run this checklist in Chrome. Mark each item: PASS / FAIL / SKIP (with reason).

---

### Section 1 — App Load & Navigation

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 1.1 | Open HTML file in Chrome | App loads, nav visible, Dashboard tab active | | |
| 1.2 | Click each nav tab | Correct view shows, active tab highlighted | | |
| 1.3 | Settings tab | All fields visible, bank field empty by default | | |
| 1.4 | Load with no data | Dashboard shows zero KPIs, empty states on all tabs | | |

---

### Section 2 — Suppliers

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 2.1 | Click + New Supplier | Modal opens | | |
| 2.2 | Close modal (X button) | Modal closes, no data saved | | |
| 2.3 | Close modal (click outside) | Modal closes | | |
| 2.4 | Save supplier with all fields | Supplier appears in table | | |
| 2.5 | Save supplier with name only | Saves without error | | |
| 2.6 | Edit supplier | Modal opens with existing data pre-filled | | |
| 2.7 | Edit and save supplier | Row updates, no duplicate created | | |
| 2.8 | Delete supplier | Removed from table, confirmation required | | |
| 2.9 | Search suppliers | Filters by name and country | | |
| 2.10 | New supplier appears in Line Item dropdown | Supplier selectable when creating line item | | |

---

### Section 3 — Line Items

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 3.1 | Click + New Line Item | Modal opens | | |
| 3.2 | Enter unit cost and unit price | Margin value and % calculate live | | |
| 3.3 | Unit price = 0 | Margin shows - (not error) | | |
| 3.4 | Unit price > unit cost | Positive margin, green colour | | |
| 3.5 | Unit price < unit cost | Negative margin, red colour | | |
| 3.6 | Save line item linked to supplier | Appears in table with supplier name | | |
| 3.7 | Filter by supplier | Only that supplier's items shown | | |
| 3.8 | Edit line item | Opens with data pre-filled | | |
| 3.9 | Delete line item | Removed from table | | |
| 3.10 | Line item appears in invoice picker | Visible when importing to invoice | | |

---

### Section 4 — Invoices

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 4.1 | Click + New Invoice | Modal opens | | |
| 4.2 | Click + Add Line (manual) | Empty row added to line items table | | |
| 4.3 | Enter qty and unit price | Row total calculates | | |
| 4.4 | Click Import from Library | Picker shows all saved line items | | |
| 4.5 | Select items in picker and click Add | Items added to invoice line items | | |
| 4.6 | Remove a line item row | Row removed, totals update | | |
| 4.7 | Tax rate = 0% | Tax amount = 0 | | |
| 4.8 | Tax rate = 20% | Tax = 20% of subtotal | | |
| 4.9 | Tax rate = Custom, enter 7.5 | Tax = 7.5% of subtotal | | |
| 4.10 | Enter local freight, insurance, legal, inspection, other | Each adds to grand total | | |
| 4.11 | Enter buyer deposit | Balance due = grand total minus deposit | | |
| 4.12 | Gross profit = line items total minus COGS | Correct when library items used | | |
| 4.13 | Net profit = grand total minus COGS minus charges | Correct calculation | | |
| 4.14 | Margin % = net profit / grand total * 100 | Correct percentage | | |
| 4.15 | Save invoice as Draft | Appears in Invoices table with Draft status | | |
| 4.16 | PO auto-generates on save | One PO per supplier in PO tab | | |
| 4.17 | Edit invoice | All fields pre-filled correctly | | |
| 4.18 | Change status to Paid | Status tag updates | | |
| 4.19 | Delete invoice | Removed from table | | |
| 4.20 | Search invoice by ref, buyer, destination | Filters correctly | | |
| 4.21 | Filter by status | Only matching invoices shown | | |
| 4.22 | Export CSV | Downloads CSV with all invoice rows and calculated fields | | |

---

### Section 5 — Invoice Print / PDF

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 5.1 | Click Preview Invoice (from modal) | New window opens with invoice document | | |
| 5.2 | Click Preview icon (from table row) | Correct invoice document opens | | |
| 5.3 | Invoice header shows Stackd wordmark | S in crimson, TACKD in dark | | |
| 5.4 | Invoice number, date, expiry, customer ID visible | Matches entered data | | |
| 5.5 | Buyer name and address visible | Correct | | |
| 5.6 | Ship To block visible | Shows ship-to or falls back to buyer address | | |
| 5.7 | Shipping details block | Freight type, ship date, weight, CBM, packages | | |
| 5.8 | Line items table | All items, qty, unit price, tax per line, line total | | |
| 5.9 | Charges breakdown | Subtotal, tax, freight, insurance, legal, inspection, other | | |
| 5.10 | Deposit deduction line | Shows in green, reduces balance due | | |
| 5.11 | Balance due is correct | Grand total minus deposit | | |
| 5.12 | Balance due label shows in crimson | Correct styling | | |
| 5.13 | Terms of sale visible | Matches entered terms | | |
| 5.14 | Payment details = blank placeholder | Shows pending message when bank field empty | | |
| 5.15 | Payment details = filled | Shows bank details when Settings populated | | |
| 5.16 | Country of origin, port of embarkation, port of discharge | Visible in footer row | | |
| 5.17 | Click Print / Save PDF | Print dialog opens in new window | | |
| 5.18 | Save as PDF | Invoice document only, no app chrome | | |
| 5.19 | Zero tax invoice | Tax line shows 0, not error | | |
| 5.20 | Invoice with no deposit | No deposit line shown, balance = grand total | | |

---

### Section 6 — Purchase Orders

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 6.1 | Auto-generated PO after invoice save | Correct supplier, linked invoice number | | |
| 6.2 | Auto-generated PO line items | Match the invoice items for that supplier | | |
| 6.3 | Edit PO — add supplier deposit | Balance due reduces correctly | | |
| 6.4 | PO status change | Updates in table | | |
| 6.5 | Manual + New PO | Modal opens, all fields editable | | |
| 6.6 | Add line items to PO manually | Rows add, totals calculate | | |
| 6.7 | PO print preview | New window opens with PO document | | |
| 6.8 | PO doc shows Stackd header | Correct branding | | |
| 6.9 | PO doc shows supplier details | Name, country, contact from supplier record | | |
| 6.10 | PO deposit deduction line | Shows in green, reduces balance due to supplier | | |
| 6.11 | Balance due to supplier correct | COGS total plus other charges minus deposit | | |
| 6.12 | Special instructions visible | If entered, shows in PO footer | | |
| 6.13 | Delete PO | Removed from table | | |

---

### Section 7 — Google Sheets Sync

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 7.1 | Paste Apps Script URL and click Connect | Banner dismisses, sync fires | | |
| 7.2 | Run setup function in Apps Script | 5 tabs created: Suppliers, LineItems, Invoices, PurchaseOrders, AuditLog | | |
| 7.3 | Save a supplier | Row appears in Suppliers tab | | |
| 7.4 | Edit supplier | Row updates, no duplicate | | |
| 7.5 | Delete supplier | Row removed from Suppliers tab | | |
| 7.6 | Save line item | Row appears in LineItems tab | | |
| 7.7 | Save invoice | Row appears in Invoices tab with calculated fields populated | | |
| 7.8 | Auto-generated PO | Row appears in PurchaseOrders tab | | |
| 7.9 | AuditLog tab | Every create/edit/delete logged with timestamp | | |
| 7.10 | Pull from Sheets | Local state matches Sheet data | | |
| 7.11 | Push All to Sheets | All local data written to Sheets | | |
| 7.12 | Test connection button | Shows connected confirmation | | |
| 7.13 | Sync on second device | Data appears after Pull | | |
| 7.14 | Offline — save order with no connection | Saves locally, sync button shows error, data not lost | | |

---

### Section 8 — Settings & Configuration

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 8.1 | Save company name | Reflects in invoice header | | |
| 8.2 | Save tagline | Reflects in invoice header | | |
| 8.3 | Save address, email, phone | Reflects in invoice and PO documents | | |
| 8.4 | Save bank details | Appears in invoice payment section | | |
| 8.5 | Leave bank details blank | Invoice shows pending placeholder | | |
| 8.6 | Save default invoice terms | Pre-populates terms field in new invoices | | |
| 8.7 | Clear local data | All data removed, app reloads to empty state | | |

---

### Section 9 — Calculations Verification

Use these known values to verify calculations are correct.

**Test invoice:**
- 2 line items: Item A qty 10 @ $200 = $2,000 / Item B qty 5 @ $150 = $750
- Line items subtotal: $2,750
- Tax rate: 10%  → Tax: $275
- Local freight: $300
- Insurance: $150
- Grand total: $2,750 + $275 + $300 + $150 = **$3,475**
- Buyer deposit: $1,000
- Balance due: $3,475 - $1,000 = **$2,475**
- COGS (if Item A cost $120, Item B cost $90): (10×$120) + (5×$90) = $1,200 + $450 = **$1,650**
- Gross profit: $2,750 - $1,650 = **$1,100**
- Net profit: $3,475 - $1,650 - $450 = **$1,375**
- Net margin: $1,375 / $3,475 = **39.6%**

| # | Test | Expected Value | Actual Value | Pass/Fail |
|---|------|---------------|--------------|-----------|
| 9.1 | Grand total | $3,475 | | |
| 9.2 | Balance due | $2,475 | | |
| 9.3 | Gross profit | $1,100 | | |
| 9.4 | Net profit | $1,375 | | |
| 9.5 | Net margin | 39.6% | | |

---

## Test Log

| Date | Version | Tester | Sections Tested | Failures | Notes |
|------|---------|--------|-----------------|----------|-------|
| 2026-04-21 | v2.0 | Carman | 1,2,3,4,5 | 5.1–5.20 (print) | Invoice printing table row not document |
| 2026-04-21 | v2.1 | - | 5 | - | Print fix applied, awaiting retest |

---

## Known Issues / Backlog

| ID | Issue | Priority | Status |
|----|-------|----------|--------|
| BUG-001 | Invoice print rendering table row not document | High | Fixed in v2.1 |
| BUG-002 | Safari/local file JS execution blocked | Medium | Resolved — use Chrome or host on GitHub Pages |
| ENH-001 | GitHub Pages hosting for cross-device access | High | Pending |
| ENH-002 | System architecture documentation | Medium | Pending |
| ENH-003 | User guide and quick reference | Medium | Pending |
