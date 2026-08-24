# Stackd Ops — User Guide

Living reference for how to use the app today. For what changed release-to-release, see `docs/version-history.md` or the in-app Release Notes (nav bar → version number).

## How a trade typically flows through the app

This is the map — each stage is documented in full further down, but here's how they connect end to end:

1. **Contact** comes in (manually added, or via CSV/Sheets import) — a lead or prospect, with an enquiry logged against them.
2. **Order Request** is opened against that Contact, capturing what was actually asked for, line by line (category, spec, stated volume). Run **Check gaps** per line to catch missing/ambiguous fields before you go further.
3. **Compare RFQs** on each line — record what one or more suppliers quoted for it, let the app rank them by true landed cost (not just the sticker price), and **Commit** to the one you're going with. This step is optional — you can skip straight to a Quote if you already know your supplier.
4. **Create Quote** from the Order Request — any line with a committed RFQ response pre-fills into the new Quote automatically (supplier, cost, currency all carried over correctly), so you're not retyping numbers you already captured.
5. Quote is reviewed, priced (per-line margin overrides available), and moved to **Accepted** — this requires an Approved By name and captures a timestamp.
6. **Convert to PO** — turns the accepted Quote into one Purchase Order per supplier (a quote spanning several suppliers correctly produces several POs, not one).
7. **Invoice** the buyer — starts as a Pro-forma if needed, becomes a normal Invoice once confirmed. Credit Notes (goodwill or linked to a specific invoice) are issued from the same modal when needed.
8. **Shipment** tracks the physical movement, linked back to the Invoice it's fulfilling.
9. Once the Order Request reaches **Fulfilled**, a realised margin figure appears, computed live from every PO and Invoice the chain actually resolved to.

The **AI Assistant** (chat panel, bottom right) can help at almost every one of these steps — it can look up existing data for you, and it can propose a fully-filled-in Supplier, Buyer, Contact, Quote, PO, Shipment, Invoice, Line Item, or Credit Note for your review. It never saves anything on its own — see the **AI Assistant** section below for exactly how that works.

## Dashboard

The Dashboard shows headline KPI tiles (invoices, revenue, margin, outstanding balances) drawn from your current data. A currency selector (GBP/USD/RMB/BBD) lets you view the aggregate figures converted into any currency, using whatever FX rates are configured in Settings. This conversion applies to the Dashboard KPIs, the Buyers list Outstanding column, and a Buyer's "Total invoiced" summary figure — it does **not** apply to a Buyer's own "Outstanding" figure or recent-invoice amounts (always shown in that buyer's native currency), the Buyer Statement report, the Aging Report, or the VAT/MTD export (always GBP, since that's a statutory figure). If your FX rates are more than 24 hours old and you've selected a non-GBP display currency, a staleness warning banner appears next to the converted figures.

## Contacts

Contacts track buyers and prospects through a simple pipeline: **lead → qualified → converted → closed**. Add a contact manually with name, email, phone, company, and notes, or upload a CSV via Import Data → Contacts step. CSV upload matches existing contacts by email (if present) or exact name — a re-upload updates the matched record rather than creating a duplicate, and any column you leave blank on a re-upload keeps that contact's previously-saved value rather than blanking it. Every Contact carries a lawful-basis marker (used internally for GDPR record-keeping) that's set automatically from the contact's pipeline stage — you don't need to set this yourself.

A **"Check enquiry"** button next to the Enquiry Summary field runs an AI-assisted check (only if a Claude API key is configured in Settings) for vague or ambiguous wording in what the contact actually asked for, phrasing each issue as a specific question you could send back to clarify. This only reads the enquiry text and company name — never the contact's name, email, or phone — and is purely informational: nothing is saved or changed until you act on it.

## Orders (Order Requests)

An Order Request tracks a single buyer's ask from first enquiry through to realised margin, separately from any Quote or Invoice. Stage flow (forward-only, system-enforced): **New → Qualifying → Quoted → Converting → Processing → Fulfilled**, with two side-exits (Qualifying → Declined, Quoted → Lost). If you need to jump stages out of sequence, an Admin Override is available (type CONFIRM plus a reason — this is permanently logged, unlike other confirm-style actions in the app).

Each Order Request has one or more lines describing what was actually asked for — category, item/spec, the stated order volume (e.g. "1 container," not yet a costable quantity), a packing spec, a base unit of measure/quantity (the costable figure, once packing is confirmed), and a Qty Status (Unknown/Estimated/Confirmed) that you set independently — it's never auto-derived just because a base quantity got filled in.

Each line also has a **"Check gaps" button**. Clicking it runs two checks:
- A **structural check** (instant, no AI needed) — flags any of packing spec, base UOM, base qty, source country, or Qty Status that's still unset/Unknown.
- A **semantic check** (only runs if a Claude API key is configured in Settings) — looks for values that are present but vague or inconsistent (e.g. a generic item description, an order volume that doesn't reconcile with the base unit), and phrases each one as a specific question you could send the buyer or supplier to resolve it.

Both checks are purely informational — nothing is written to the line, and nothing is saved, until you act on it yourself. Re-clicking "Check gaps" always reflects the line's current state, not a stale earlier result.

### Comparing supplier quotes (RFQ comparison)

Each line also has a **"Compare RFQs"** button. This is where you record what different suppliers actually quoted for that specific line item, before committing to one:

- Click **"+ Add Response"** to record one supplier's quote — unit cost, currency, CBM (per unit — needed for a fair freight comparison), duty %, dangerous-goods flag, MOQ, lead time, payment terms, and optionally a linked Contact if you want to note who at the supplier gave you the quote. There's no free-text name/email field here — only an existing Contact record can be linked, to keep this data GDPR-clean.
- The app ranks every recorded response by **landed cost converted to GBP** — not the raw quoted number. A supplier quoting a nominally lower price in one currency isn't necessarily cheaper once freight, duty, and currency conversion are actually applied; the ranking reflects the real comparison, not the sticker price.
- If a response has no CBM entered, its landed-cost figure carries a warning — with freight left out, it isn't a genuine like-for-like comparison against a response that did include it.
- Click **Commit** on whichever response you're going with. Only one response per line can be committed at a time; committing a different one replaces the previous choice. Clicking Commit again on the already-committed response un-commits it. **No recorded response is ever deleted** — everything you compared stays visible as a record, even after you've moved on.
- This step is entirely optional. If you already know your supplier, skip straight to Create Quote.

### Handing off to a Quote

The **"Create Quote"** button creates a linked Quote and moves the Order Request's stage to Quoted automatically. Any line with a committed RFQ response pre-fills straight into the new Quote — supplier, quantity (using the line's own base quantity if you set one), and unit cost, correctly converted into the new Quote's working currency if the response was recorded in a different one. You never have to retype or manually reconvert a number you already captured while comparing quotes. A line hand-off doesn't set a per-line margin override — it just inherits the new quote's default margin, same as any manually-added line.

Once the Order Request's stage reaches Fulfilled, a realised margin figure appears, computed live from every Purchase Order and Invoice the linked Quote resolved to.

## Suppliers

Add a supplier manually (name, country, contact person, email, phone, currency, notes), or upload a CSV via Import Data → Suppliers step (the first step — suppliers must exist before you can import Line Items or Purchase Orders that reference them). See **Cloud Data** below — if it's configured, adding/editing/deleting a Supplier requires being signed in, and the record becomes visible to every other connected device/colleague, not just yours.

## Line Items

Your product catalogue — SKU, description, specs, HS code, linked supplier, unit of measure, unit cost, unit price, currency, dimensions, and a dangerous-goods flag. Add manually or via CSV upload (Import Data → Line Items step, after Suppliers). A Line Item's cost feeds Invoice COGS (cost of goods sold) automatically whenever an invoice line is created via "Import from Library." If you instead quick-add a line directly on an invoice (without linking it to the catalogue), make sure to enter a Unit Cost — COGS is still tracked correctly as long as a cost is entered; only leaving Unit Cost at zero causes profit figures to be understated for that line.

Opening a Supplier's record shows a **Price History** panel aggregating every price point recorded for that supplier — from Line Items, Quote lines, and PO lines — newest first, flagged if a price point is older than your configured staleness threshold (Settings).

## Buyers

Buyer records hold contact details, currency, payment terms, and a credit limit. The credit limit is display-only today — it's shown for reference but doesn't block invoice creation if exceeded. See **Cloud Data** below — if it's configured, the same shared-record behavior applies to Buyers as to Suppliers.

## Cloud Data (Suppliers & Buyers)

By default, all your data — including Suppliers and Buyers — lives only in your own browser. **Cloud Data** (Settings → Cloud Data) is an optional feature that connects Suppliers and Buyers specifically to a shared Supabase database, so a colleague on a different device or browser sees the exact same Supplier/Buyer records as you. Nothing else in the app (Quotes, Invoices, POs, Contacts, etc.) is affected — those always stay local to each browser.

Once Cloud Data is configured:
- The first time you load the app, you'll be asked to sign in (an email/password created specifically for this — separate from anything else in the app).
- Adding, editing, or deleting a Supplier or Buyer now saves to the shared database instead of just your own browser, and a background refresh keeps your view up to date with anyone else's changes.
- Everything else about the Supplier/Buyer forms works exactly the same as before — same fields, same validation.

Moving your **existing** local Suppliers/Buyers into Cloud Data is a one-time, explicit action ("Migrate Suppliers/Buyers to Cloud," Settings → Cloud Data) that requires a full backup export first and automatically updates every reference to those records elsewhere in the app (Quotes, POs, Line Items, Contacts, Invoices). It's safe to undo within 30 days via "Restore Pre-Migration Suppliers/Buyers" in the same settings card.

One current limitation: the legacy CSV upload and "Import from Google Sheets" paths for Suppliers don't yet know about Cloud Data — avoid using those two specific import methods for Suppliers once Cloud Data is connected (adding a Supplier through the normal form is unaffected and works correctly).

## Quotes

Build a Quote from one or more lines; the app calculates freight, duty, insurance, and landed cost per line, then rolls up to a total quoted price and margin. Each line can carry its own margin override — leave it blank to inherit the quote-level default, or set an explicit value (including `0`) to override it for just that line. Changing cost, duty percentage, or margin on a saved Quote creates a new version, so you can see how pricing evolved. Setting a Quote's status to **Accepted** reveals two additional fields — **Approved By** (required) and an optional Approval Note — and captures an approval timestamp automatically the first time the quote transitions into Accepted (re-saving an already-Accepted quote never overwrites that original timestamp). Once Accepted, a **Convert to PO** button appears — clicking it creates one Purchase Order per distinct supplier on the quote's lines (so a multi-supplier quote correctly produces multiple POs, not one PO wrongly attributed to a single supplier).

**Source pricing changed since this Quote was created:** if a Quote line was created via "Create Quote" from an Order Request's committed RFQ response, and you later commit a *different* supplier response on that same Order Request line, re-opening the Quote shows a warning banner. Nothing on the Quote changes automatically — it's a prompt to review the Quote's pricing before sending it, not a block on saving. A separate message appears if the source Order Request has since been deleted entirely.

## Purchase Orders

Track what you owe each supplier — status (Draft/Sent/Deposit Paid/Settled/Cancelled), deposit and balance, and an optional link to the Invoice it's funding. POs created via Convert to PO from a Quote are pre-populated and linked automatically.

**Source Invoice changed since this PO was generated:** a PO auto-generated from an Invoice's line items remembers the invoice's price at the time it was created. If you later edit that Invoice — change a line's price or quantity, remove a line, or add a new line for the same supplier — re-opening the PO shows a warning banner. As with the Quote-side warning above, nothing is fixed automatically; it's there so you notice before proceeding with a now-outdated PO. A separate message appears if the source Invoice has since been deleted. One known gap: a brand-new line added for a supplier that has no PO yet from that invoice isn't flagged anywhere — check Purchase Orders manually after adding a new supplier's line to an already-invoiced order.

## Invoices

Invoices track what a buyer owes you, including a Pro-forma status distinct from a normal Invoice. Add line items either by **Import from Library** (pulls in the correct cost automatically — preferred for physical products) or by **quick-add** (useful for pass-through charges like freight or customs, where you type in a description and price directly). If you quick-add a line, enter a Unit Cost — the app's cost-of-goods and profit calculations use it correctly as long as it's populated. A warning banner appears only when a line genuinely has neither a linked catalogue item nor a Unit Cost entered — meaning profit for that line really would be understated; it does not fire just because a line lacks a catalogue link if you've entered a cost for it directly.

**Credit Notes** are issued from the same modal — either linked to a specific existing invoice (standard credit) or marked as a standalone goodwill credit. A credit note reduces the linked invoice's balance due automatically.

## Shipments

Track a shipment's freight mode, origin/destination ports, ETD/ETA, and its link back to the Invoice it's fulfilling.

## Import Data

Bulk-load your existing data via CSV, in six steps (each downloadable as a template first): **Suppliers → Line Items → Invoices → Purchase Orders → Order Requests → Contacts**. Suppliers should be imported first since Line Items and Purchase Orders reference suppliers by name; Contacts has no such dependency and can be uploaded at any point. An alternate path — pulling directly from a connected Google Sheets master file — is available from the same tab if you have Sheets sync configured in Settings, and covers the same five original entities plus Contacts. If Cloud Data is configured, avoid using either import path for Suppliers specifically (see **Cloud Data** above) — Buyers and every other entity are unaffected.

## AI Assistant

The chat panel (bottom right of the screen) can answer questions about your live data and, when you ask it to create something, propose a ready-to-review record for one of the forms below. It never creates or changes anything on its own — every proposal ends with a **"Review in [Form] form"** button that opens the real form pre-filled with what it suggested, exactly as if you'd typed it in yourself, and nothing is saved until you click Save there.

**What it can look up for you:** Invoices, Payments, Dashboard KPIs, Purchase Orders (all filterable, e.g. "show me overdue invoices for Acme Foods"), and — for resolving names to the right record — Suppliers and Buyers. Its Supplier/Buyer lookups deliberately return only name/country/currency-type details, never contact/email/phone, so asking it for a supplier's contact details will get you pointed to the Suppliers tab instead of an answer.

**What it can propose creating** (each via the review-and-save pattern above): a Purchase Order, a Quote, a Shipment, a Contact, a Supplier, a Buyer, an Invoice, a Line Item, or a Credit Note. If you ask for something that depends on a Supplier or Buyer that doesn't exist yet, the natural flow works in one conversation — ask it to create the Supplier first, save that, then ask for the PO/Invoice/Line Item referencing it.

A couple of practical notes: the AI never invents a reference number (Invoice #, PO #, etc.) — those are always assigned by the app itself when you save. For an Invoice specifically, it needs at least one line item before it will propose one at all; ask for the invoice with the line items described in the same request.

## Settings

Configure the AI Assistant (add your Claude API key here — required for the Order Request semantic gap check, the Contact enquiry check, and the in-app AI chat), connect Google Sheets sync, configure Cloud Data (see above), adjust Rates & FX (exchange rates and freight/duty defaults used across Quotes and Invoices), your preferred display currency, Supplier price-staleness threshold, and browse the Reference Data viewer (all lookup tables — ports, payment terms, units of measure — used throughout the app).

**Data → Scan for phantom records:** if you notice blank or undeletable records anywhere (most often Suppliers or Contacts left over from a historical sync issue), this tool finds them for you. It shows exactly what it found before touching anything — if it finds nothing, it says so and stops there. If it finds something, confirming asks you to export a backup first (a checkbox you tick once you've actually downloaded it), then removes the blank records and renumbers your Supplier/Line Item/Buyer/Contact/Order Request reference numbers so there are no gaps left behind. Invoice, PO, Quote, and Credit Note numbers are never touched by this tool, since those numbers appear on documents you may have already sent out. Every record affected shows the change in its own Activity tab, same as any other edit.
