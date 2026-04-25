# Stackd Ops — User Guide
**Version:** 1.0.0
**Date:** 2026-04-21
**For:** FPM International operations team
**App URL:** https://stkdcfpm.github.io/stackd-ops/

---

## What is Stackd Ops?

Stackd Ops is FPM International's operations platform for managing procurement, invoicing, and supplier purchase orders. It replaces manual tracking via spreadsheets and WhatsApp with a structured system that keeps all your order data in one place and automatically syncs to Google Sheets.

**What it does:**
- Stores your supplier list
- Holds a catalogue of products you source (line items)
- Creates invoices for buyers with automatic P&L calculations
- Auto-generates purchase orders for each supplier when you save an invoice
- Tracks buyer deposits received and supplier deposits paid
- Prints professional invoices and POs as PDFs
- Syncs everything to Google Sheets so your data is never locked in one device

---

## Getting Started

### Accessing the app
1. Go to **https://stkdcfpm.github.io/stackd-ops/**
2. Enter the password when prompted
3. Bookmark this URL on every device you use

### First time setup
Before creating invoices, complete Settings:
1. Click **Settings** in the top navigation
2. Fill in company details — name, tagline, address, email, phone
3. Leave **Bank / Payment Details** blank until your Stackd business account is open
4. Set your **Default Invoice Terms** — this pre-fills every new invoice
5. Paste your **Apps Script URL** and click **Save & Connect**
6. Click **Save Settings**

---

## The Four Tabs

### Suppliers
Your master list of all companies you source from. Add a supplier once — they become available across all line items and purchase orders.

### Line Items
Your product catalogue. Each item represents one product from one supplier with its cost price (what you pay) and selling price (what you charge). Build this library once and reuse items across multiple invoices.

### Invoices
Buyer-facing commercial documents. Each invoice is for one buyer and can contain products from multiple suppliers. The system calculates gross profit, net profit, margin, and balance due automatically.

### Purchase Orders
Supplier-facing documents. Created automatically when you save an invoice — one PO per supplier. Tracks what you owe each supplier and what deposits you have already paid.

---

## Core Workflows

---

### Workflow 1: Add a Supplier

1. Click **Suppliers** tab
2. Click **+ New Supplier**
3. Fill in:
   - **Name** — company name (required)
   - **Country** — full country name e.g. `China`
   - **Currency** — supplier's transaction currency
   - **Contact Person** — your main contact there
   - **Email and Phone / WeChat**
   - **Notes** — certifications, lead times, MOQs, any red flags
4. Click **Save Supplier**

The supplier now appears in your supplier list and is available in the Line Items and PO dropdowns.

---

### Workflow 2: Add a Line Item

Do this for every product you source regularly. Build up the library over time — you don't need to add everything at once.

1. Click **Line Items** tab
2. Click **+ New Line Item**
3. Fill in:
   - **SKU / Item #** — your reference code e.g. `REF-COMM-600L`
   - **Supplier** — select from your supplier list (required)
   - **Unit of Measure** — `pcs`, `kg`, `m²`, `sheets` etc.
   - **Description** — clear product name
   - **Specifications** — size, grade, model, colour, voltage, anything that distinguishes it
   - **Unit Cost** — what you pay the supplier per unit
   - **Unit Price** — what you charge the buyer per unit
   - **Currency** — the currency for both cost and price
   - **Notes** — HS code, certifications, packaging notes
4. Watch the **Unit Margin** and **Margin %** update as you type — confirm they look right
5. Click **Save Line Item**

---

### Workflow 3: Create an Invoice

This is the main workflow. Follow these steps in order.

**Step 1 — Open a new invoice**
1. Click **Invoices** tab
2. Click **+ New Invoice**

**Step 2 — Fill in invoice details**
- **Invoice #** — use format `INV-YYYY-NNN` e.g. `INV-2025-001`
- **Date** — today's date (auto-filled)
- **Expiry / Due Date** — when payment is due
- **Customer ID** — your reference for this buyer e.g. `CUS-001`
- **Buyer / Company** — buyer name (required)
- **Buyer Address** — full delivery/billing address
- **Destination** — destination country e.g. `Barbados`

**Step 3 — Fill in shipping details**
- Freight type, estimated ship date, gross weight, cubic weight, total packages
- Port of Embarkation (where goods leave from) e.g. `Qingdao`
- Port of Discharge (where goods arrive) e.g. `Bridgetown`
- Country of Origin e.g. `China`

**Step 4 — Add line items**

Option A — Import from your library (recommended):
1. Click **Import from Library**
2. Tick the items you want to include
3. Click **Add Selected**
4. Adjust quantities in the invoice line items table

Option B — Add manually:
1. Click **+ Add Line**
2. Type description, UOM, quantity, and unit price directly

**Step 5 — Set charges, tax and deposits**
- **Currency** — set this first before anything else
- **Tax Rate** — select from dropdown or choose Custom and enter your rate
- Fill in any applicable charges: Local Freight, Insurance, Legal/Consular, Inspection/Cert., Other
- **Buyer Deposit Received** — enter any deposit already paid by the buyer

**Step 6 — Check the P&L**
The Live P&L section at the bottom of the modal updates as you type. Verify:
- Grand Total looks correct
- Balance Due = Grand Total minus deposit
- Gross Profit and Net Margin look right for this deal

**Step 7 — Set status and save**
- Set status to `Draft` (default) or `Sent` if already dispatched to buyer
- Add **Terms of Sale** if different from your default
- Click **Save Invoice**

**What happens automatically:**
- Invoice saved to your device and synced to Google Sheets
- One Purchase Order created per supplier across the invoice's line items
- Dashboard updates with new totals

---

### Workflow 4: Print an Invoice as PDF

1. In the **Invoices** tab, find your invoice
2. Click the **👁 eye icon** on the right of the row
3. A new window opens with the formatted invoice document
4. Click **Print / Save PDF** in the black bar at the top
5. In the print dialog:
   - Set destination to **Save as PDF**
   - Uncheck **Headers and Footers** (removes browser URL watermark)
   - Set margins to **None** or **Minimum**
6. Click **Save** and name the file using the invoice number

> ⚠️ Do not use browser File → Print or Cmd+P/Ctrl+P from the main app page — this will print a blank page. Always use the Print / Save PDF button inside the document window.

---

### Workflow 5: Update a Supplier Deposit on a PO

When you pay a deposit to a supplier:

1. Click **Purchase Orders** tab
2. Find the relevant PO (linked to your invoice)
3. Click the **✎ edit icon**
4. Enter the amount paid in **Supplier Deposit Paid**
5. Change status to **Deposit Paid**
6. Click **Save PO**

The balance due to the supplier updates automatically.

---

### Workflow 6: Mark an Invoice as Paid

1. Click **Invoices** tab
2. Click the **✎ edit icon** on the invoice
3. Change **Status** to `Paid`
4. Click **Save Invoice**

The dashboard pipeline updates. Paid invoices are excluded from the outstanding balance KPI.

---

### Workflow 7: Sync to Google Sheets

**Auto-sync:** Every time you save a record, it syncs to Sheets automatically. The dot in the top right of the nav turns green when sync is confirmed.

**Manual sync — push all:**
Settings → Push All → confirms all local data is written to Sheets.

**Manual sync — pull from Sheets:**
Settings → Pull → loads all data from Sheets into the app. Use this when:
- Opening the app on a new device for the first time
- After another device has made changes
- After restoring from a backup

**If sync fails:**
The dot turns red. Your data is safe in localStorage. Check your internet connection, then try Settings → Push All.

---

### Workflow 8: Export Invoice Data to CSV

1. Click **Invoices** tab
2. Click **↓ Export CSV**
3. A CSV file downloads containing all invoices with full P&L columns
4. Open in Excel or Google Sheets for reporting and tax preparation

---

## Understanding the Dashboard

The dashboard shows a live summary of all active (non-cancelled) invoices and POs.

| KPI | What it means |
|-----|--------------|
| **Invoice Revenue** | Total grand total across all active invoices |
| **Net Profit** | Total revenue minus all costs across all active invoices |
| **Avg Margin** | Average net margin % across active invoices with full cost data |
| **Outstanding from Buyers** | Total balance due across all invoices (grand total minus deposits received) |
| **PO Balance Due** | Total amount still owed to suppliers across active (non-settled) POs |

**Margin colour coding:**
- 🟢 Green — 20% or above
- 🟡 Amber — 10–20%
- 🔴 Red — below 10%

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Password screen not showing | Hard refresh the page (Cmd+Shift+R) |
| Sync dot stays red | Check internet connection. Try Settings → Test connection |
| Data not showing after Pull | Check Apps Script URL in Settings. Run setup() in Apps Script if needed |
| Invoice calculations showing zero | Pull from Sheets to load supplier/line item data first |
| Print button not working | Check pop-ups are allowed for the site. Safari: address bar will show blocked pop-up notification |
| Printed PDF has URL watermark | Uncheck Headers and Footers in print dialog |
| POs not auto-generating | Line items must be imported from library (with supplier link) not added manually |
| Changes not appearing on another device | Settings → Pull from Sheets on that device |
