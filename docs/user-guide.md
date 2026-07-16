# Stackd Ops — User Guide

Living reference for how to use the app today. For what changed release-to-release, see `docs/version-history.md` or the in-app Release Notes (nav bar → version number).

## Dashboard

The Dashboard shows headline KPI tiles (invoices, revenue, margin, outstanding balances) drawn from your current data. A currency selector (GBP/USD/RMB/BBD) lets you view the aggregate figures converted into any currency, using whatever FX rates are configured in Settings. This conversion applies to the Dashboard KPIs, the Buyers list Outstanding column, and a Buyer's "Total invoiced" summary figure — it does **not** apply to a Buyer's own "Outstanding" figure or recent-invoice amounts (always shown in that buyer's native currency), the Buyer Statement report, the Aging Report, or the VAT/MTD export (always GBP, since that's a statutory figure). If your FX rates are more than 24 hours old and you've selected a non-GBP display currency, a staleness warning banner appears next to the converted figures.

## Contacts

Contacts track buyers and prospects through a simple pipeline: **lead → qualified → converted → closed**. Add a contact manually with name, email, phone, company, and notes, or upload a CSV via Import Data → Contacts step. CSV upload matches existing contacts by email (if present) or exact name — a re-upload updates the matched record rather than creating a duplicate, and any column you leave blank on a re-upload keeps that contact's previously-saved value rather than blanking it. Every Contact carries a lawful-basis marker (used internally for GDPR record-keeping) that's set automatically from the contact's pipeline stage — you don't need to set this yourself.

## Orders (Order Requests)

An Order Request tracks a single buyer's ask from first enquiry through to realised margin, separately from any Quote or Invoice. Stage flow (forward-only, system-enforced): **New → Qualifying → Quoted → Converting → Processing → Fulfilled**, with two side-exits (Qualifying → Declined, Quoted → Lost). If you need to jump stages out of sequence, an Admin Override is available (type CONFIRM plus a reason — this is permanently logged, unlike other confirm-style actions in the app).

Each Order Request has one or more lines describing what was actually asked for — category, item/spec, the stated order volume (e.g. "1 container," not yet a costable quantity), a packing spec, a base unit of measure/quantity (the costable figure, once packing is confirmed), and a Qty Status (Unknown/Estimated/Confirmed) that you set independently — it's never auto-derived just because a base quantity got filled in.

Each line also has a **"Check gaps" button**. Clicking it runs two checks:
- A **structural check** (instant, no AI needed) — flags any of packing spec, base UOM, base qty, source country, or Qty Status that's still unset/Unknown.
- A **semantic check** (only runs if a Claude API key is configured in Settings) — looks for values that are present but vague or inconsistent (e.g. a generic item description, an order volume that doesn't reconcile with the base unit), and phrases each one as a specific question you could send the buyer or supplier to resolve it.

Both checks are purely informational — nothing is written to the line, and nothing is saved, until you act on it yourself. Re-clicking "Check gaps" always reflects the line's current state, not a stale earlier result.

An Order Request has an "Create Quote" button that creates a linked Quote and moves the stage to Quoted automatically. Once the stage reaches Fulfilled, a realised margin figure appears, computed live from every Purchase Order and Invoice the linked Quote resolved to.

## Suppliers

Add a supplier manually (name, country, contact person, email, phone, currency, notes), or upload a CSV via Import Data → Suppliers step (the first step — suppliers must exist before you can import Line Items or Purchase Orders that reference them).

## Line Items

Your product catalogue — SKU, description, specs, HS code, linked supplier, unit of measure, unit cost, unit price, currency, dimensions, and a dangerous-goods flag. Add manually or via CSV upload (Import Data → Line Items step, after Suppliers). A Line Item's cost feeds Invoice COGS (cost of goods sold) automatically whenever an invoice line is created via "Import from Library." If you instead quick-add a line directly on an invoice (without linking it to the catalogue), make sure to enter a Unit Cost — COGS is still tracked correctly as long as a cost is entered; only leaving Unit Cost at zero causes profit figures to be understated for that line.

## Buyers

Buyer records hold contact details, currency, payment terms, and a credit limit. The credit limit is display-only today — it's shown for reference but doesn't block invoice creation if exceeded.

## Quotes

Build a Quote from one or more lines; the app calculates freight, duty, insurance, and landed cost per line, then rolls up to a total quoted price and margin. Changing cost, duty percentage, or markup on a saved Quote creates a new version, so you can see how pricing evolved. Setting a Quote's status to **Accepted** reveals two additional fields — **Approved By** (required) and an optional Approval Note — and captures an approval timestamp automatically the first time the quote transitions into Accepted (re-saving an already-Accepted quote never overwrites that original timestamp). Once Accepted, a **Convert to PO** button appears — clicking it creates one Purchase Order per distinct supplier on the quote's lines (so a multi-supplier quote correctly produces multiple POs, not one PO wrongly attributed to a single supplier).

## Purchase Orders

Track what you owe each supplier — status (Draft/Sent/Deposit Paid/Settled/Cancelled), deposit and balance, and an optional link to the Invoice it's funding. POs created via Convert to PO from a Quote are pre-populated and linked automatically.

## Invoices

Invoices track what a buyer owes you, including a Pro-forma status distinct from a normal Invoice. Add line items either by **Import from Library** (pulls in the correct cost automatically — preferred for physical products) or by **quick-add** (useful for pass-through charges like freight or customs, where you type in a description and price directly). If you quick-add a line, enter a Unit Cost — the app's cost-of-goods and profit calculations use it correctly as long as it's populated. A warning banner appears only when a line genuinely has neither a linked catalogue item nor a Unit Cost entered — meaning profit for that line really would be understated; it does not fire just because a line lacks a catalogue link if you've entered a cost for it directly.

## Shipments

Track a shipment's freight mode, origin/destination ports, ETD/ETA, and its link back to the Invoice it's fulfilling.

## Import Data

Bulk-load your existing data via CSV, in six steps (each downloadable as a template first): **Suppliers → Line Items → Invoices → Purchase Orders → Order Requests → Contacts**. Suppliers should be imported first since Line Items and Purchase Orders reference suppliers by name; Contacts has no such dependency and can be uploaded at any point. An alternate path — pulling directly from a connected Google Sheets master file — is available from the same tab if you have Sheets sync configured in Settings, and covers the same five original entities plus Contacts.

## Settings

Configure the AI Assistant (add your Claude API key here — required for the Order Request semantic gap check and the in-app AI chat), connect Google Sheets sync, adjust Rates & FX (exchange rates and freight/duty defaults used across Quotes and Invoices), your preferred display currency, and browse the Reference Data viewer (all lookup tables — ports, payment terms, units of measure — used throughout the app).
