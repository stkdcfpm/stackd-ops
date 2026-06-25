# REQ-RPT-001 v1 — Reporting & Analytics Suite

**Status:** Draft — awaiting requirements-gate  
**FM-1:** Partially applicable — see per-item notes below  
**Version target:** v2.9.x (scoped items) / v3.0.x (deferred items)  
**Logged:** 2026-06-25

---

## Business need

Stackd Ops can store and compute accurate trade data but has no way to interrogate it across dimensions. The operator cannot answer basic questions like "which buyer is most profitable?", "which invoices are overdue by more than 60 days?", or "what duty did we pay this quarter?" without manually scanning individual records. This limits use as a management tool, creates compliance risk (HMRC Intrastat, duty audit), and forces manual work that the data already supports.

This requirement documents **ten identified gaps** across reporting, audit, and data quality. Each is scoped individually below with a v2.9.x / v3.0.x target and FM-1 status.

---

## Gap register

| # | Gap | Area | v2.9.x viable? | FM-1 status | Priority |
|---|---|---|---|---|---|
| G-01 | Date-range filter on AI data tools | AI / Reporting | ✅ Yes | Approved (UI/AI layer) | High |
| G-02 | Aging Report (0–30 / 31–60 / 61–90 / 90+ days) | Financial Control | ✅ Yes | Approved (UI only, existing data) | High |
| G-03 | P&L by dimension (buyer, period) | Financial Control | ✅ Yes | Approved (UI only, existing data) | High |
| G-04 | Quick-add COGS warning | Data Quality | ✅ Yes | Approved (UI only) | High |
| G-05 | Full entity event log (Invoices, POs, Payments, Suppliers) | Audit | ✅ Yes | Approved (DB.events exists, new emissions only) | Medium |
| G-06 | Invoice edit delta logging (old → new values) | Audit | ✅ Yes | Approved (fields on existing entity) | Medium |
| G-07 | Input VAT on POs + MTD Boxes 2 & 4 | Compliance | ⚠️ Possible | Requires new fields on DB.po — FM-1 item 2 | Medium |
| G-08 | Intrastat report (UK → EU, 8-box CSV) | Compliance | ❌ v3.0.x | New entity fields, complex logic | Low (v3) |
| G-09 | Supplier performance tracking (on-time %, cost variance) | Operational | ❌ v3.0.x | New fields + Supabase aggregation | Low (v3) |
| G-10 | HS code duty recalculation on existing invoices | Data Integrity | ❌ v3.0.x | Cascading recalc risk — post-migration | Low (v3) |

---

## G-01 — Date-range filter on AI data tools

**Area:** AI Assistant — `get_invoices`, `get_payments`  
**FM-1:** Approved (UI/AI layer, no new entities)  
**Target:** v2.9.x (next sprint)

**Business need:** "What was our revenue from Apex Cold Chain in Q1?" or "Show me all payments received in May" are currently unanswerable by the AI because `get_invoices` and `get_payments` have no date filter. The operator must ask for all invoices and mentally filter.

**Behaviour:**
- `get_invoices` gains optional `date_from` and `date_to` params (ISO date strings, inclusive). Filter applied against `inv.date`.
- `get_payments` gains optional `date_from` and `date_to` params. Filter applied against `p.date`.
- `AI_SYSTEM_PROMPT` updated to describe the date filter capability.
- No UI change. No schema change. No new entity.

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | `date_from: "2026-01-01"` passed to `get_invoices` | Tool executes | Only invoices with `date >= 2026-01-01` returned |
| AC-2 | `date_to: "2026-03-31"` passed | Tool executes | Only invoices with `date <= 2026-03-31` returned |
| AC-3 | Both `date_from` and `date_to` passed | Tool executes | Only invoices within inclusive range returned |
| AC-4 | Neither param passed | Tool executes | All invoices returned (existing behaviour preserved) |
| AC-5 | Date filter applied to `get_payments` | Tool executes | Same inclusive-range logic on `p.date` |

---

## G-02 — Aging Report

**Area:** Invoices tab  
**FM-1:** Approved (UI panel, computed from existing `DB.inv` + `DB.payments`)  
**Target:** v2.9.x

**Business need:** The operator cannot see which invoices are overdue and by how long. Chasing buyer payments requires manually scanning invoice dates. An aging bucket view surfaces cash risk immediately.

**Behaviour:**
- New **Aging Report** panel on Invoices tab (behind a `[Aging]` toolbar button, similar to VAT Return).
- Buckets: **Current** (not yet due), **0–30 days**, **31–60 days**, **61–90 days**, **90+ days**. Due date = `inv.date + payment terms days` (or `inv.date + 30` if payment terms not parseable).
- Shows: buyer, invoice number, invoice date, due date, outstanding balance, bucket.
- Summary row: total outstanding per bucket.
- **DSO KPI** (Days Sales Outstanding): weighted average age of outstanding invoices.
- Export as CSV.
- Only Sent / Partially Paid invoices included (Draft, Pro-forma, Paid, Cancelled excluded).

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Invoice Sent 45 days ago, unpaid | Aging Report opened | Appears in 31–60 bucket |
| AC-2 | Invoice Partially Paid, balance > 0, 95 days old | Aging Report opened | Appears in 90+ bucket with remaining balance |
| AC-3 | Invoice status = Paid | Aging Report opened | Not shown |
| AC-4 | All invoices current | Report shown | All in Current bucket, DSO = weighted avg days |
| AC-5 | Export CSV clicked | — | CSV downloaded with all rows and bucket column |

---

## G-03 — P&L by Dimension

**Area:** Dashboard / Invoices tab  
**FM-1:** Approved (UI panel, computed from existing data)  
**Target:** v2.9.x

**Business need:** Dashboard KPIs show aggregate totals only. The operator cannot answer "which buyer is most profitable?" or "did margin improve in Q2 vs Q1?" without exporting to a spreadsheet and pivoting manually.

**Behaviour:**
- New **P&L Report** panel (behind a `[P&L]` toolbar button on Dashboard or Invoices tab).
- Dimensions: **By Buyer** and **By Period** (monthly or quarterly toggle).
- Columns per row: Revenue, COGS, Gross Profit, Net Profit, Margin %.
- Totals row.
- Warning banner if any included invoices have zero COGS (quick-add lines) — counts and flags them; does not suppress those invoices from totals.
- Date range filter (from/to, defaults to current calendar year).
- Export as CSV.

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | 3 invoices for buyer A, 2 for buyer B | P&L by Buyer opened | Two rows shown, correct revenue/profit/margin per buyer |
| AC-2 | One invoice has quick-add lines (COGS = 0) | P&L opened | Warning banner shown: "N invoice(s) have no COGS data — profit figures may be understated" |
| AC-3 | Date range filter applied | Report refreshed | Only invoices within range included |
| AC-4 | By Period toggled | Report shown | Rows grouped by month/quarter with correct aggregates |
| AC-5 | Export CSV | — | CSV downloaded with dimension, revenue, COGS, NP, margin columns |

---

## G-04 — Quick-add COGS Warning

**Area:** Invoice modal — line items section  
**FM-1:** Approved (UI only)  
**Target:** v2.9.x (small change, high value)

**Business need:** The rule "use Import from Library, not quick-add" exists in docs and the AI system prompt but is invisible in the UI. Operators regularly add quick-add lines and only discover missing profit data after the fact when KPIs look wrong.

**Behaviour:**
- When the invoice modal has one or more quick-add lines (lines where `li.lid` is empty/null), show an inline amber warning below the line items table:
  > ⚠ N line item(s) added without a library link. COGS will be £0 for these lines — profit calculations will be understated. Use **Import from Library** to fix.
- Warning appears/disappears reactively as lines are added/removed.
- Warning does not block Save.
- The existing `renderInvLineTable()` function should call a helper to check for quick-add lines and show/hide the warning element.

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Invoice has 1 quick-add line (no lid) | Modal open | Amber warning shown with count = 1 |
| AC-2 | Invoice has only library-linked lines | Modal open | No warning shown |
| AC-3 | Operator imports a line from library | Warning shown | Count decrements; warning disappears when count reaches 0 |
| AC-4 | Save clicked with warning present | — | Save proceeds normally; warning does not block |

---

## G-05 — Full Entity Event Log

**Area:** `DB.events` / `logEv()` — Invoices, POs, Payments, Suppliers  
**FM-1:** Approved — `DB.events` and `logEv()` already exist; this adds new emission points only  
**Target:** v2.9.x

**Business need:** The activity log only covers Contacts. Invoice edits, PO status changes, payment receipts, and supplier updates are unaudited. For a trade intermediary, a complete audit trail is a basic operational control.

**Behaviour — new emission points:**

| Entity | Events to emit |
|---|---|
| Invoice | `created`, `status_changed` (old → new), `unlocked` (reason logged), `deleted` |
| PO | `created`, `status_changed` (old → new), `deleted` |
| Payment | `created` (amount, method, invNum), `deleted` |
| Supplier | `created`, `updated`, `deleted` |

- All emissions use existing `logEv(entityType, entityId, verb, summary, actor)` signature.
- `summary` field includes key changed values where applicable (e.g. `"Status: Sent → Partially Paid"`).
- No new `K` key, no schema change. Uses existing `DB.events` / `K.ev`.

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | New invoice saved | `saveInv()` completes | `DB.events` contains `{entityType:'invoice', verb:'created', ...}` |
| AC-2 | Invoice status changed | Save with new status | Event with `verb:'status_changed'`, summary shows old → new |
| AC-3 | Invoice unlocked | Unlock confirmed | Event with `verb:'unlocked'`, summary includes reason |
| AC-4 | Payment recorded | `savePmt()` completes | Event with `entityType:'payment'`, amount and invNum in summary |
| AC-5 | PO status changed | Save | Event with `verb:'status_changed'` on PO entity |
| AC-6 | Supplier deleted | `delSup()` completes | Event with `verb:'deleted'` on supplier entity |

---

## G-06 — Invoice Edit Delta Logging

**Area:** Invoice modal — unlock + edit flow  
**FM-1:** Approved (new fields on existing DB.inv entity — FM-1 item 2)  
**Target:** v2.9.x

**Business need:** The unlock flow logs a reason but not what changed. An auditor asking "what was changed on INV10031 on date X?" cannot be answered. For HMRC, invoice amendments must be traceable.

**Behaviour:**
- When a locked invoice is saved after unlock, compare key fields against the pre-edit snapshot captured at unlock time.
- Fields to diff: `status`, `buyer`, `calc_grandTotal`, `dep`, `taxRate`, `lf`, `lineItems` (count + total value).
- Append a `editHistory[]` array to the invoice record. Each entry: `{ ts, reason, actor, changes: [{field, from, to}] }`.
- The existing unlock reason (already captured) becomes the `reason` field on the edit history entry.
- No UI display required in v1 — data is captured; future version surfaces it. The audit entry in `DB.events` should reference the delta count (e.g. `"3 fields changed — see invoice editHistory"`).

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Locked invoice unlocked, `calc_grandTotal` changed on save | Save completes | `inv.editHistory` contains entry with `{field:'calc_grandTotal', from:'X', to:'Y'}` |
| AC-2 | Invoice unlocked but no tracked fields changed | Save completes | `editHistory` entry recorded with empty `changes[]` |
| AC-3 | Invoice never unlocked | — | `inv.editHistory` is absent or `[]` |
| AC-4 | `DB.events` entry created on edit | Save completes | Event `verb:'edited'` with summary referencing change count |

---

## G-07 — Input VAT on POs (MTD-GAP-001 resolution)

**Area:** Purchase Orders → VAT Return (MTD)  
**FM-1:** Requires council decision — new fields on `DB.po` (FM-1 item 2 covers new fields on existing entities, but MTD implication needs sign-off)  
**Target:** v2.9.x conditional on council PASS

**Business need:** VAT Return Boxes 4 and 7 are hardcoded £0. FPM pays VAT on UK supplier invoices. Without tracking input VAT on POs, the VAT reclaim is zero and the return is incomplete. This is a direct financial loss each quarter.

**Behaviour:**
- Add `vatAmount` and `vatRate` optional fields to `DB.po` records.
- PO modal gains optional **VAT Rate** (0% / 5% / 20%) and computed **VAT Amount** fields.
- `calcVATReturn()` updated: Box 4 = sum of `po.vatAmount` for POs with dates in the period; Box 7 = sum of PO net values (line total excl. VAT) for same period.
- MTD-GAP-001 closed when delivered.
- UI note updated to remove "always £0.00" advisory for Boxes 4 & 7.

**Acceptance criteria:**

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | PO has `vatRate: 20`, `vatAmount: 500` | VAT Return calculated for that period | Box 4 includes £500; Box 7 includes PO net value |
| AC-2 | PO has no VAT fields | VAT Return calculated | PO excluded from Boxes 4 & 7 (no regression) |
| AC-3 | MTD export CSV | — | Box 4 and Box 7 values populated correctly |

---

## G-08 — Intrastat Report (deferred v3.0.x)

**Area:** Compliance / Customs  
**Target:** v3.0.x  
**Reason for deferral:** Requires CN8 commodity code field on line items (new schema), statistical value calculation, and net mass tracking — none of which exist. Better built on Supabase with proper aggregation. No FM-1 clearance for current stack.

**Scope when v3.0 ready:**
- 8-column report: commodity code (CN8), description, qty, UOM, net mass (kg), statistical value (GBP), incoterm, country of origin.
- Period filter (calendar month — Intrastat is monthly).
- Export CSV for HMRC/customs broker upload.
- Arrivals and dispatches separated.

---

## G-09 — Supplier Performance Tracking (deferred v3.0.x)

**Area:** Suppliers / Shipments  
**Target:** v3.0.x  
**Reason for deferral:** On-time delivery % requires ETA vs. actual arrival date tracking (new field on `DB.sh`). Cost variance requires linking PO cost to quote cost at line-item level. Scorecard aggregation is better done server-side.

---

## G-10 — HS Code Duty Recalculation (deferred v3.0.x)

**Area:** Line Items / Invoices  
**Target:** v3.0.x  
**Reason for deferral:** Cascading recalc on saved invoices is a data integrity risk on localStorage. Post-migration, a server-side recalc job is the correct approach. UI warning (existing) is the interim mitigation.

---

## Delivery order recommendation

For v2.9.x, deliver in this sequence to maximise compliance and operational value:

| Sprint | Items | Rationale |
|---|---|---|
| v2.9.34 | G-01 (AI date filter), G-04 (quick-add warning) | Small, high-impact, unblock AI reporting queries |
| v2.9.35 | G-02 (Aging), G-03 (P&L by dimension) | Core financial visibility — operator-facing reports |
| v2.9.36 | G-05 (Entity event log), G-06 (Invoice delta) | Audit completeness before any external clients |
| v2.9.37 | G-07 (Input VAT / MTD boxes 4 & 7) | Compliance — requires council gate |
