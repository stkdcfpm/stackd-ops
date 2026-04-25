# Stackd Ops — QA Framework & Changelog
**Version:** 1.1.0
**Date:** 2026-04-21
**Covers:** stackd-ops-v2.3.2 through stackd-ops-v2.5.3
**Live URL:** https://stkdcfpm.github.io/stackd-ops/

---

## How to Use This Document
Run through the relevant test sections after every change before deploying to GitHub Pages.
Mark each item: **PASS** / **FAIL** / **SKIP** (with reason).
Log every test run in the Test Log section.
Every release gets a changelog entry.
Use the pre-release checklist before any `index.html` push.

---

## Pre-Release Checklist
Complete this before every deployment to GitHub Pages.

| # | Check | Done |
|---|-------|------|
| PR-1 | Node syntax check passes (`node --check script.js`) | |
| PR-2 | Password gate shows on fresh load (incognito window) | |
| PR-3 | Login works with correct password | |
| PR-4 | All six nav tabs load without error | |
| PR-5 | + New Supplier modal opens | |
| PR-6 | + New Invoice modal opens, auto-increment number populates | |
| PR-7 | Invoice print opens new window with document (not table row) | |
| PR-8 | Apps Script URL connects (Settings → Test) | |
| PR-9 | Pull from Sheets loads data | |
| PR-10 | Section 9 calculation values correct | |

---

## Changelog

### v2.5.3 — 2026-04-21
**Feature:** FPM funded deposit tracker. New field on POs: FPM Funded (out of pocket) — records amounts paid from operator funds separate from buyer-funded deposits. Auto-recovery rule: when invoice status changes to `Paid`, all linked PO FPM-funded deposits automatically marked recovered with toast notification. Accounts tracker updated with FPM Funded column, Total to Chase column (invoice balance + unrecovered FPM deposits), and FPM Exposure in totals bar.

### v2.5.2 — 2026-04-21
**Feature:** Accounts & Deposit Tracker added to dashboard. Per-invoice view: buyer deposit received, buyer balance due, supplier deposit paid, supplier balance due, net cash position per order. Per-supplier pivot: total COGS, deposit coverage bar, settlement progress. Totals bar: total received from buyers, total paid to suppliers, net cash position. Net Cash Position added as 6th KPI card.

### v2.5.1 — 2026-04-21
**Fix:** Net profit calculation for imported invoices. Charges (freight, insurance etc.) were not being deducted from net profit when invoices had no live line items. Root cause: `chgs` calculated as 0 when falling back to `calc_*` fields. Fixed by always reading charges directly from invoice record fields (`lf`, `ins`, `leg`, `isp`, `oth`).

### v2.5.0 — 2026-04-21
**Feature:** Tooltips — 50 field-level help tooltips across all modals (hover `?` icon). Country dial code dropdown on supplier phone field — ITU E.164 standard, 250 countries. Field validation: email (hard block), invoice number format INV/CN + digits with optional -D# draft suffix, HS code numeric check (warn), all numeric fields non-negative. Auth init fix: `initApp()` now called after password gate is passed, resolving Apps Script connection and settings not loading on first login.

### v2.4.5 — 2026-04-21
**Fix:** CSV template download — flattened template arrays from multiline to single-line format. Multiline array format caused header and example values to merge on download. Templates updated with real FPM data: INV10029 example row, Thorpes International, correct amounts.

### v2.4.4 — 2026-04-21
**Fix:** CSV template inline comments removed — comments inside JS array caused header/example merge. Templates updated with Jinan Jinbao and FPM real data.

### v2.4.3 — 2026-04-21
**Feature:** Invoice number format changed from `INV-YYYY-NNN` to `INV#####` matching FPM convention (e.g. INV10029). Auto-increment starts from highest existing number; if none exists, starts from INV10001. Status normalisation on import: `paid` → `Paid`, `part` → `Partially Paid` etc. (case-insensitive).

### v2.4.2 — 2026-04-21
**Fix:** Syntax error in CSV template builder — literal newline in JS string broke entire script. `var csv = tpl.headers.join(',') + '\n'` had a real line break instead of escape sequence. Node syntax check now mandatory before every build.

### v2.4.0 — 2026-04-21
**Feature:** Bulk import tab with four-step sequence (Suppliers → Line Items → Invoices → POs). CSV template download and upload per entity. Supplier name matching (case-insensitive). Invoice import without line items using `calc_*` fields for dashboard accuracy. Items Subtotal column added to invoice template. Pro-forma invoice status added. HS Code promoted to dedicated field on line items. Invoice number auto-increment. Input validation on all four save functions.

### v2.3.2 — 2026-04-21
**Feature:** Password gate — full-screen auth on load, simple hash, sessionStorage. Deployed to GitHub Pages. Print fix: `prevInvDoc` and `prevPODoc` open self-contained new windows with inline styles. Print button uses `setTimeout(print, 200)` for reliable execution. URL watermark resolved by unchecking Headers and Footers in print dialog.

### v2.3.1 — 2026-04-21
**Fix:** Print CSS `visibility:hidden` approach — did not reliably isolate print-body content.

### v2.3.0 — 2026-04-21
**Fix:** Print chain rebuilt — `prevInvDoc` stores HTML to `window._printDocHTML`, `printDoc` reads directly (no innerHTML round-trip). Eliminates HTML entity double-encoding issue.

### v2.2 — 2026-04-21
**Fix:** All `for...of` loops replaced with indexed `for` loops — resolves silent failure in Safari and file:// contexts.

### v2.1 — 2026-04-21
**Fix:** Invoice/PO print rendering table row not document. New window approach replaces DOM visibility manipulation.

### v2.0 — 2026-04-21
**Fix:** Complete JS rebuild. Safari/local-file compatibility. Python string-escaping corruption. Arrow functions replaced with ES5.

### v1.0 — 2026-04-21
**Release:** Initial build. Four-entity model: Suppliers, Line Items, Invoices, POs. Sheets sync. PO auto-generation. Print preview. Deposit tracking. Dynamic tax rate.

---

## Test Checklist

Run in Chrome or Safari via the GitHub Pages URL.
Mark each item: PASS / FAIL / SKIP (with reason).

---

### Section 1 — App Load, Auth & Navigation

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 1.1 | Open live URL in Chrome | Password gate shows immediately, app not visible | | |
| 1.2 | Open live URL in Safari | Password gate shows | | |
| 1.3 | Open live URL in incognito | Password gate shows (no session carry-over) | | |
| 1.4 | Enter wrong password | Error message, input clears, red underline | | |
| 1.5 | Enter correct password | App loads, Dashboard visible | | |
| 1.6 | Close tab and reopen | Password gate shows again | | |
| 1.7 | Click each nav tab | Correct view shows, active tab highlighted | | |
| 1.8 | Import Data tab | Import view loads with four steps | | |
| 1.9 | Settings tab | All fields visible, Google Sheets section present | | |
| 1.10 | Load with no data | Dashboard shows zero KPIs, empty states on all tabs | | |
| 1.11 | Paste Apps Script URL in banner → Connect | Banner dismisses, sync fires | | |
| 1.12 | All nav tabs work after login with saved URL | App initialises correctly, data loads | | |

---

### Section 2 — Suppliers

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 2.1 | Click + New Supplier | Modal opens | | |
| 2.2 | Hover ? icon on Name field | Tooltip appears with guidance text | | |
| 2.3 | Save with no name | Blocked — "Supplier name is required", field highlighted red | | |
| 2.4 | Save with invalid email | Blocked — "Invalid email address", field highlighted red | | |
| 2.5 | Valid email saves correctly | No error | | |
| 2.6 | Phone field shows dial code dropdown | Country selector present, defaults to +44 | | |
| 2.7 | Select +86 China dial code | Dropdown updates | | |
| 2.8 | Save supplier with all fields | Appears in table | | |
| 2.9 | Save supplier name only | Saves without error | | |
| 2.10 | Close modal (X button) | Modal closes, no data saved | | |
| 2.11 | Close modal (click outside) | Modal closes | | |
| 2.12 | Edit supplier | Modal opens with all data pre-filled including dial code | | |
| 2.13 | Edit and save | Row updates, no duplicate | | |
| 2.14 | Delete supplier | Removed from table, confirmation required | | |
| 2.15 | Search by name | Filters correctly | | |
| 2.16 | Search by country | Filters correctly | | |
| 2.17 | New supplier appears in Line Items dropdown | Supplier selectable | | |
| 2.18 | New supplier appears in PO dropdown | Supplier selectable | | |

---

### Section 3 — Line Items

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 3.1 | Click + New Line Item | Modal opens | | |
| 3.2 | Hover ? icon on HS Code field | Tooltip shows HS code guidance | | |
| 3.3 | Save with no description | Blocked — "Description is required" | | |
| 3.4 | Save with no supplier selected | Blocked — "Please select a supplier" | | |
| 3.5 | Enter negative unit cost | Blocked — "Unit cost cannot be negative" | | |
| 3.6 | Enter negative unit price | Blocked — "Unit price cannot be negative" | | |
| 3.7 | Enter non-numeric HS code | Warning shown, save allowed | | |
| 3.8 | Enter valid HS code e.g. 8418.50 | No warning | | |
| 3.9 | Enter unit cost and price | Margin value and % calculate live | | |
| 3.10 | Unit price > cost | Positive margin, green colour | | |
| 3.11 | Unit price < cost | Negative margin, red colour | | |
| 3.12 | Unit price = 0 | Margin shows - not error | | |
| 3.13 | HS Code field visible in table | Column present in Line Items tab | | |
| 3.14 | Save line item linked to supplier | Appears in table with HS code and supplier name | | |
| 3.15 | Filter by supplier | Only that supplier's items shown | | |
| 3.16 | Edit line item | Opens with all data pre-filled including HS code | | |
| 3.17 | Delete line item | Removed from table | | |
| 3.18 | Line item appears in invoice picker | Visible with supplier and price | | |

---

### Section 4 — Invoices

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 4.1 | Click + New Invoice | Modal opens, invoice number pre-filled (e.g. INV10032) | | |
| 4.2 | Invoice number follows INV##### format | Auto-increments from highest existing | | |
| 4.3 | Save with no invoice number | Blocked — "Invoice number is required" | | |
| 4.4 | Enter invalid invoice number e.g. 12345 | Blocked — must start with INV or CN | | |
| 4.5 | Valid formats accepted: INV10032, CN10029, INV10032-D1 | All pass validation | | |
| 4.6 | Enter duplicate invoice number | Blocked — "already exists" | | |
| 4.7 | Save with no buyer name | Blocked — "Buyer name is required" | | |
| 4.8 | Save with no line items | Blocked — "Add at least one line item" | | |
| 4.9 | Enter negative buyer deposit | Blocked — "cannot be negative" | | |
| 4.10 | Enter negative charge (freight etc.) | Blocked | | |
| 4.11 | Add line manually | Empty row added, totals update | | |
| 4.12 | Import from library | Picker shows all saved line items | | |
| 4.13 | Select items and click Add | Items added with correct price | | |
| 4.14 | Remove line item row | Row removed, totals update | | |
| 4.15 | Tax rate 0% | Tax amount = 0 | | |
| 4.16 | Tax rate 10% | Tax = 10% of subtotal | | |
| 4.17 | Custom tax rate 7.5% | Tax = 7.5% of subtotal | | |
| 4.18 | Enter all charges | Each adds to grand total | | |
| 4.19 | Enter buyer deposit | Balance due = grand total minus deposit | | |
| 4.20 | Pro-forma status available | Visible in status dropdown with purple tag | | |
| 4.21 | Live P&L updates as you type | Grand total, net profit, margin, balance due all live | | |
| 4.22 | Save invoice as Draft | Appears in table with grey Draft tag | | |
| 4.23 | PO auto-generates on save | One PO per supplier in PO tab | | |
| 4.24 | Edit invoice | All fields pre-filled correctly | | |
| 4.25 | Change status to Paid | Status tag updates | | |
| 4.26 | FPM-funded deposits auto-recovered when marked Paid | Toast notification, PO recovery checkbox ticked | | |
| 4.27 | Delete invoice | Removed, confirmation required | | |
| 4.28 | Search by invoice number | Filters correctly | | |
| 4.29 | Search by buyer | Filters correctly | | |
| 4.30 | Filter by status | Only matching invoices shown | | |
| 4.31 | Export CSV | Downloads with all invoice rows and P&L columns | | |
| 4.32 | Hover ? on Invoice # field | Tooltip shows INV#####, CN prefix, -D1 draft guidance | | |

---

### Section 5 — Invoice Print / PDF

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 5.1 | Click 👁 on invoice row | New window opens with invoice document | | |
| 5.2 | New window shows Stackd branding | S in crimson, TACKD in dark, tagline visible | | |
| 5.3 | Invoice header correct | Invoice #, date, expiry, customer ID, currency | | |
| 5.4 | Buyer name and address visible | Correct data | | |
| 5.5 | Shipping details block | Freight type, ship date, weight, CBM, packages | | |
| 5.6 | Line items table | All items, qty, unit price, tax per line, total | | |
| 5.7 | Charges breakdown | Subtotal, tax, freight, insurance, legal, other | | |
| 5.8 | Deposit deduction line | Shows in green, reduces balance due | | |
| 5.9 | Balance due correct | Grand total minus deposit | | |
| 5.10 | Payment details — bank blank | Shows pending placeholder message | | |
| 5.11 | Payment details — bank filled | Shows bank account details | | |
| 5.12 | Terms of sale visible | Matches entered terms | | |
| 5.13 | Origin/port footer | COO, POL, POD visible | | |
| 5.14 | Black toolbar visible | Title, Print / Save PDF button, Close button | | |
| 5.15 | Click Print / Save PDF button | Print dialog opens | | |
| 5.16 | Toolbar hidden in print | @media print hides toolbar — document only in PDF | | |
| 5.17 | Uncheck Headers and Footers | URL watermark removed from PDF | | |
| 5.18 | File → Print from main page | Blank page (documented workaround: use button in doc window) | | |
| 5.19 | Zero-deposit invoice | No deposit line shown, balance = grand total | | |
| 5.20 | Zero-tax invoice | Tax line shows 0, not error | | |
| 5.21 | Preview from inside invoice modal | Correct data shown before saving | | |

---

### Section 6 — Purchase Orders

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 6.1 | Auto-generated PO after invoice save | Correct supplier, linked invoice number | | |
| 6.2 | Auto-generated PO line items | Match invoice items for that supplier | | |
| 6.3 | Edit PO — add supplier deposit | Balance due reduces correctly | | |
| 6.4 | FPM Funded field visible | Crimson field, separate from total deposit | | |
| 6.5 | Enter FPM Funded amount | Shows in PO totals bar in red | | |
| 6.6 | Recovery checkbox disabled | Read-only — auto-set by system only | | |
| 6.7 | Mark linked invoice as Paid | FPM funded deposits auto-recovered, toast shown | | |
| 6.8 | Reopen PO after recovery | Recovery checkbox ticked, label updated | | |
| 6.9 | PO status change | Updates in table | | |
| 6.10 | Manual + New PO | Modal opens, all fields editable | | |
| 6.11 | Save PO with no number | Blocked — "PO number is required" | | |
| 6.12 | Save PO with no supplier | Blocked — "Please select a supplier" | | |
| 6.13 | Negative deposit blocked | Error message shown | | |
| 6.14 | Add line items manually | Rows add, totals calculate | | |
| 6.15 | PO print preview | New window with blue header (PURCHASE ORDER) | | |
| 6.16 | PO doc shows supplier details | Name, country, contact from supplier record | | |
| 6.17 | PO deposit deduction line | Shows in green, reduces balance due to supplier | | |
| 6.18 | Balance due to supplier correct | COGS + other minus deposit | | |
| 6.19 | Special instructions visible | Shows in PO footer | | |
| 6.20 | Delete PO | Removed, confirmation required | | |

---

### Section 7 — Accounts & Deposit Tracker

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 7.1 | Accounts section visible on dashboard | Below charts, above suppliers tab | | |
| 7.2 | By Invoice button active by default | Invoice table visible | | |
| 7.3 | Invoice table columns | Invoice #, Buyer, Destination, Status, Total, Buyer Dep, Buyer Bal, Sup Dep, FPM Funded, Sup Bal, Total to Chase | | |
| 7.4 | Buyer Bal Due shows correctly | Grand total minus buyer deposit | | |
| 7.5 | Fully paid invoice shows ✓ Settled | Green tick in Buyer Bal Due column | | |
| 7.6 | FPM Funded shows unrecovered amount | Red amount before recovery | | |
| 7.7 | FPM Funded shows ✓ Recovered | Green tick after invoice marked Paid | | |
| 7.8 | Total to Chase = balance + unrecovered FPM | Correct combined amount | | |
| 7.9 | Total to Chase labels inc. FPM dep | Annotation shown when FPM deposit included | | |
| 7.10 | Click By Supplier | Supplier pivot table shows | | |
| 7.11 | Supplier view columns | Supplier, POs, Total COGS, Dep Paid, Bal Due, Dep Coverage, Settlement | | |
| 7.12 | Deposit coverage bar | Visual bar showing % of COGS covered by deposit | | |
| 7.13 | Settlement progress | e.g. 1/3 settled | | |
| 7.14 | Totals bar — three figures | Total received from buyers, total paid to suppliers, net cash | | |
| 7.15 | FPM Exposure appears in totals | Shows when unrecovered FPM deposits exist | | |
| 7.16 | Net Cash Position KPI | 6th KPI card, green if positive, red if negative | | |
| 7.17 | Net Cash = buyer deps minus supplier deps | Correct calculation | | |

---

### Section 8 — Bulk Import

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 8.1 | Import Data tab loads | Four-step sequence visible with instructions | | |
| 8.2 | Instructions mention Google Drive / Excel workflow | Correct guidance present | | |
| 8.3 | Download Suppliers template | CSV downloads with correct headers and Jinan Jinbao example | | |
| 8.4 | Download Line Items template | CSV downloads with correct headers and REF-COMM-600L example | | |
| 8.5 | Download Invoices template | CSV with Items Subtotal column, INV10029 example row | | |
| 8.6 | Download POs template | CSV with PO10029-1 example | | |
| 8.7 | Upload Suppliers CSV | Suppliers imported, import log shows count | | |
| 8.8 | Duplicate supplier skipped | Import log notes skip, existing record unchanged | | |
| 8.9 | Upload Line Items CSV | Line items imported with supplier linked by name | | |
| 8.10 | Line item with unknown supplier | Error logged, row skipped | | |
| 8.11 | Upload Invoices CSV — minimum columns | Invoices appear in dashboard with correct totals | | |
| 8.12 | Status normalisation on import | paid → Paid, part → Partially Paid | | |
| 8.13 | Items Subtotal used for gross profit | Correct GP calculation (not grand total) | | |
| 8.14 | Duplicate invoice number skipped | Import log notes skip | | |
| 8.15 | Upload POs CSV | POs imported linked to correct invoice | | |
| 8.16 | Import log shows timestamps | Each import action logged with time | | |
| 8.17 | Clear log button | Import log clears | | |
| 8.18 | Auto-sync after import | Data pushed to Sheets if auto-sync enabled | | |

---

### Section 9 — Google Sheets Sync

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 9.1 | Paste Apps Script URL → Connect | Banner dismisses, sync fires | | |
| 9.2 | Run setup() in Apps Script | 5 tabs created in Sheet | | |
| 9.3 | Save supplier | Row in Suppliers tab | | |
| 9.4 | Edit supplier | Row updates, no duplicate | | |
| 9.5 | Delete supplier | Row removed | | |
| 9.6 | Save line item | Row in LineItems tab with HS code column | | |
| 9.7 | Save invoice | Row in Invoices tab with all calc_ fields | | |
| 9.8 | Auto-generated PO | Row in PurchaseOrders tab | | |
| 9.9 | AuditLog tab | Every operation logged with timestamp | | |
| 9.10 | Pull from Sheets | Local state matches Sheet data | | |
| 9.11 | Push All to Sheets | All local data written | | |
| 9.12 | Test connection button | Shows connected confirmation | | |
| 9.13 | Sync on second device | Data appears after Pull | | |
| 9.14 | Offline save | Saves locally, dot turns red, data not lost | | |
| 9.15 | generateTestData() runs without timeout | Completes in under 10 seconds | | |
| 9.16 | clearTestData() removes TEST- records only | Real data unaffected | | |

---

### Section 10 — Settings & Configuration

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 10.1 | Save company name | Reflects in invoice and PO header | | |
| 10.2 | Save tagline | Reflects in invoice header | | |
| 10.3 | Save address, email, phone | Reflects in documents | | |
| 10.4 | Save bank details | Appears in invoice payment section | | |
| 10.5 | Leave bank details blank | Invoice shows pending placeholder | | |
| 10.6 | Save default invoice terms | Pre-populates terms in new invoices | | |
| 10.7 | Apps Script URL save | Persists across sessions | | |
| 10.8 | Auto-sync checkbox | Toggles auto-sync behaviour | | |
| 10.9 | Pull on load checkbox | Toggles pull on app load | | |
| 10.10 | Clear local data | All data removed, app reloads empty | | |
| 10.11 | Tooltip on Bank Details field | Guidance on leaving blank until Stackd account open | | |

---

### Section 11 — Calculations Verification

Use these known values to verify calculations are correct.
Run using the test data generator (`generateTestData()` in Apps Script → Pull from Sheets).

**Test invoice INV-TEST-001:**
- Items subtotal: $2,750 (10 × $200 + 5 × $150)
- Tax 10%: $275
- Local freight: $300
- Insurance: $150
- Grand total: $2,750 + $275 + $300 + $150 = **$3,475**
- Buyer deposit: $1,000
- Balance due: $3,475 − $1,000 = **$2,475**
- COGS: (10 × $120) + (5 × $90) = **$1,650**
- Gross profit: $2,750 − $1,650 = **$1,100**
- Net profit: $3,475 − $1,650 − $300 − $150 = **$1,375**
- Net margin: $1,375 ÷ $3,475 = **39.6%**

| # | Test | Expected | Actual | Pass/Fail |
|---|------|----------|--------|-----------|
| 11.1 | Grand total | $3,475 | | |
| 11.2 | Balance due | $2,475 | | |
| 11.3 | Gross profit | $1,100 | | |
| 11.4 | Net profit | $1,375 | | |
| 11.5 | Net margin | 39.6% | | |
| 11.6 | COGS | $1,650 | | |
| 11.7 | Tax amount | $275 | | |
| 11.8 | Net Cash Position KPI | $1,000 (buyer dep received, no supplier deps) | | |

**Real invoice verification (INV10029, INV10030, INV10031):**

| # | Test | Expected | Actual | Pass/Fail |
|---|------|----------|--------|-----------|
| 11.9 | Total Revenue (all 3 invoices) | $47,436.50 | | |
| 11.10 | Total Net Profit | $7,827.68 | | |
| 11.11 | Avg Margin | ~16.5% | | |
| 11.12 | Outstanding from Buyers | $12,380.70 | | |
| 11.13 | INV10029 Balance Due | $0.00 (Paid) | | |
| 11.14 | INV10030 Balance Due | $10,180.00 | | |
| 11.15 | INV10031 Balance Due | $2,200.70 | | |

---

### Section 12 — Tooltips

| # | Test | Expected | Result | Notes |
|---|------|----------|--------|-------|
| 12.1 | Hover ? on Supplier Name | Tooltip shows company name guidance | | |
| 12.2 | Hover ? on Supplier Email | Tooltip shows email format guidance | | |
| 12.3 | Hover ? on HS Code | Tooltip mentions customs requirement | | |
| 12.4 | Hover ? on Unit Cost | Tooltip distinguishes from buyer price | | |
| 12.5 | Hover ? on Invoice # | Tooltip mentions INV#####, CN prefix, -D1 draft | | |
| 12.6 | Hover ? on Destination | Tooltip mentions dashboard charts | | |
| 12.7 | Hover ? on Buyer Deposit | Tooltip explains does not affect P&L | | |
| 12.8 | Hover ? on Port of Loading | Tooltip shows e.g. Qingdao | | |
| 12.9 | Hover ? on PO Special Instructions | Tooltip shows packaging/certification guidance | | |
| 12.10 | Hover ? on Bank Details (Settings) | Tooltip mentions leave blank until Stackd account open | | |
| 12.11 | Tooltip keyboard accessible | Tab to ? icon, tooltip shows on focus | | |
| 12.12 | Tooltip dismisses on mouse out | Disappears cleanly | | |

---

## Test Log

| Date | Version | Tester | Sections Tested | Failures | Notes |
|------|---------|--------|-----------------|----------|-------|
| 2026-04-21 | v2.0 | Carman | 1,2,3,4,5 | 5.1–5.20 (print) | Invoice printing table row not document |
| 2026-04-21 | v2.1 | — | 5 | — | Print fix applied, awaiting retest |
| 2026-04-21 | v2.3.2 | Carman | 1,5,9,11 | None | GitHub Pages live, print working, Section 11 PASS |
| 2026-04-21 | v2.5.1 | Carman | 11 | None | Net profit $7,827.68 ✓, Avg margin 16.5% ✓ |
| 2026-04-21 | v2.5.3 | — | — | — | Full QA run pending against v1.1.0 checklist |

---

## Known Issues & Backlog

| ID | Issue | Priority | Status |
|----|-------|----------|--------|
| BUG-001 | Invoice print rendering table row not document | High | Fixed v2.1 |
| BUG-002 | Safari/local file JS execution blocked | Medium | Fixed v2.3.2 — use GitHub Pages URL |
| BUG-003 | File → Print from main page prints blank | Low | By design — workaround: use Print button in document window |
| BUG-004 | Chrome blocked on local file:// path | Medium | Fixed v2.3.2 — use GitHub Pages URL |
| BUG-005 | Apps Script URL not connecting after login | High | Fixed v2.5.0 — initApp() now called after auth gate |
| BUG-006 | Net profit overstated on imported invoices | High | Fixed v2.5.1 — charges now read from invoice record |
| BUG-007 | CSV template download showing old data | Medium | Fixed v2.4.5 — template arrays flattened |
| ENH-001 | GitHub Pages hosting | High | Complete v2.3.2 |
| ENH-002 | System architecture documentation | Medium | Complete v1.0.0 |
| ENH-003 | User guide and quick reference | Medium | Complete v1.0.0 |
| ENH-004 | Mermaid diagrams for data model and architecture | Medium | Planned docs v1.1.0 |
| ENH-005 | Apps Script secret token (security) | High | Planned v2.6.0 |
| ENH-006 | XSS sanitisation | High | Planned v2.6.0 |
| ENH-007 | Session timeout | Medium | Planned v2.6.0 |
| ENH-008 | VAT number field | Medium | Planned v2.6.0 |
| ENH-009 | Incoterms 2020 dropdown | Medium | Planned v2.6.0 |
| ENH-010 | Country ISO lookup | Medium | Planned v2.6.0 |
| ENH-011 | Scheduled Sheets backup | High | Planned v2.6.0 |
| ENH-012 | AuditLog viewer in app | Medium | Planned v2.6.0 |
| ENH-013 | Credit note function (CN prefix) | High | Planned v2.6.0 |
| ENH-014 | Payment received date and amount | High | Planned v2.6.0 |
| ENH-015 | GitHub release tags | Low | Planned v2.6.0 |
