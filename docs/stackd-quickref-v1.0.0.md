# Stackd Ops — Quick Reference
**Version:** 1.0.0  |  **URL:** https://stkdcfpm.github.io/stackd-ops/

---

## 5 Core Workflows

### 1 · Add a Supplier
Suppliers → + New Supplier → fill Name, Country, Currency, Contact → Save Supplier

### 2 · Add a Line Item
Line Items → + New Line Item → fill SKU, Supplier, Description, Cost, Price → Save Line Item

### 3 · Create an Invoice
Invoices → + New Invoice → Invoice details → Shipping details → Import from Library → Set tax rate → Set charges → Check P&L → Save Invoice
**Auto-generates one PO per supplier.**

### 4 · Print Invoice or PO as PDF
Click 👁 on any row → new window opens → click **Print / Save PDF** → uncheck Headers and Footers → Save as PDF
**Never use browser File → Print from the main app.**

### 5 · Sync to Sheets
Auto-syncs on every save. To force: Settings → Push All
To load on new device: Settings → Pull from Sheets

---

## Status Values

| Entity | Statuses |
|--------|---------|
| Invoice | Draft → Sent → Partially Paid → Paid → Cancelled |
| PO | Draft → Sent → Deposit Paid → Settled → Cancelled |

---

## Key Calculations

| Calculation | Formula |
|-------------|---------|
| Grand Total | Line items subtotal + tax + freight + insurance + legal + inspection + other |
| Balance Due | Grand Total − Buyer Deposit |
| Gross Profit | Line items subtotal − COGS |
| Net Profit | Grand Total − COGS − all charges |
| Net Margin | Net Profit ÷ Grand Total × 100 |
| PO Balance Due | COGS subtotal + other − Supplier Deposit |

---

## Invoice Numbering
Format: **INV-YYYY-NNN** e.g. `INV-2025-001`
PO auto-format: **PO-INV-2025-001-1**, **PO-INV-2025-001-2**
Never reuse a number. Cancelled invoices retire their number.

---

## Margin Colour Guide
🟢 Green = 20%+  |  🟡 Amber = 10–20%  |  🔴 Red = below 10%

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Sync dot red | Check internet → Settings → Test connection |
| Calculations showing zero | Pull from Sheets to load line item cost data |
| Print button not working | Allow pop-ups for the site |
| URL on printed PDF | Uncheck Headers and Footers in print dialog |
| POs not auto-generating | Use Import from Library — manual lines have no supplier link |
| Data missing on new device | Settings → Pull from Sheets |

---

## QA Verification Values (test data)
Invoice INV-TEST-001 should show:
Grand Total **$3,475** · Balance Due **$2,475** · Gross Profit **$1,100** · Net Profit **$1,375** · Margin **39.6%**
