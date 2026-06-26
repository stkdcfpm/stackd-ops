# REQ-BUY-001 — Buyers / Customers Entity (v1)

**Status:** Requirements gate CONDITIONAL PASS → gaps resolved → ready for spec gate  
**Logged:** 2026-06-25  
**Target version:** v2.9.37

---

## Background

Stackd Ops currently stores the buyer name as a free-text field on each invoice. FPM needs a managed customer list so that buyer contact details are stored once, invoices are linked to buyer records, and per-buyer financial history is accessible in-app.

---

## Requirement

### BUY-001-1: Buyer entity

The system shall maintain a `DB.buy` array (localStorage key `st_buy`, K key `K.bu`) of Buyer records with the following fields:

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | generated: `BUY` + timestamp |
| `name` | string | yes | company name; hard-block unique (case-insensitive) |
| `contactName` | string | no | primary contact person |
| `email` | string | no | |
| `phone` | string | no | |
| `address` | string | no | free-text |
| `currency` | string | no | default invoice currency: USD / GBP / RMB / BBD; defaults to GBP |
| `paymentTerms` | string | no | from `getPaymentTerms()` list |
| `creditLimit` | number | no | display only; no enforcement |
| `notes` | string | no | |
| `createdAt` | string | yes | ISO timestamp set on creation |

On every app init, an **Ad-Hoc** buyer record (name: `'Ad-Hoc'`) shall be seeded idempotently (created if absent, never duplicated). This record cannot be deleted.

### BUY-001-2: Buyer management UI

The system shall provide a **Buyers** tab in the main navigation with:

- List table columns: Name, Contact, Email, Currency, Payment Terms, Credit Limit, Outstanding (GBP equiv.)
- Outstanding balance per row = sum of `iCalc(inv).bal` for all invoices linked to this buyer, converted to GBP via `toGBP()`
- Add / Edit modal (`ov-buy`) with all fields above
- Delete with confirmation; delete blocked (with error message) if any invoice has `buyerId === buyer.id`; Ad-Hoc buyer cannot be deleted

### BUY-001-3: Invoice integration

- The invoice modal buyer field shall be replaced with a `<select>` dropdown (`if-b`) populated from `DB.buy` sorted by name
- A **"＋ New Buyer…"** option at the top of the dropdown opens a quick-create flow (name required, other fields optional); on save the new buyer is auto-selected in the invoice dropdown
- Invoices shall store a `buyerId` field (FK to `buyer.id`) in addition to retaining the raw `buyer` string for display fallback
- **Backward compatibility:** existing invoices with no `buyerId` remain valid; the invoice display falls back to the raw `buyer` string; the buyer field in the edit modal defaults to the Ad-Hoc buyer if no `buyerId` is present and the raw `buyer` string matches no record
- **Save rule:** all new and edited invoices must have a valid `buyerId`; the dropdown must not permit saving with an empty selection

### BUY-001-4: Per-buyer summary panel

The Buyer edit modal shall include a read-only summary sub-panel showing:

- Total invoiced (all time, GBP equiv. via `toGBP()`)
- Outstanding balance in **buyer's default currency** via `fromGBP(totalGBP, buyer.currency)` helper
- Last invoice date
- List of the 5 most recent invoices (number, date, status, amount in buyer's currency)
- **Buyer Statement** button — **hidden** if buyer has no linked invoices; calls existing `openStatement(buyerName)` entry point

### BUY-001-5: `fromGBP` helper

A module-level `fromGBP(gbp, currency)` function shall convert a GBP amount to the target currency using current QR rates (same caveat as MTD-GAP-002 — historic rate variance is operator's responsibility). Gap BUY-GAP-002 logged.

### BUY-001-6: Sheets sync

Buyer records shall **NOT** sync to Google Sheets in v2.9.x (FM-1 freeze). Sync deferred to v3.0. Gap BUY-GAP-001 logged.

### BUY-001-7: AI tool

The existing `get_invoices` AI tool response shall include a `buyerName` field: resolved from `DB.buy` where `buyerId` exists, else the raw `buyer` string. No new AI tool required.

### BUY-001-8: Backup / restore

`expAll` snapshot shall include `buy: DB.buy`. `doImport` shall restore `DB.buy` from the snapshot. The existing backup GDPR disclosure note shall be updated to reference buyer records.

### BUY-001-9: GDPR

A Buyers GDPR disclosure card shall be added to Settings stating:
- Fields stored: company name, contact name, email, phone, address
- Legal basis: UK GDPR Article 6(1)(b) — contractual necessity (invoicing); Article 6(1)(c) — legal obligation (HMRC 6-year financial record retention, Companies Act 2006 s.388)
- Retention: records retained for the duration of the business relationship and minimum 6 years thereafter per HMRC requirement; no automated purge
- Backup exports include buyer PII (covered by existing backup disclosure)
- No external transmission (Sheets sync excluded from v2.9.x)

---

## Acceptance criteria

| AC | Description | Test type |
|---|---|---|
| AC1 | `saveBuy()` creates a record: `DB.buy` length increases by 1, record contains all supplied fields | Automated |
| AC2 | `saveBuy()` hard-blocks duplicate name (case-insensitive): second save with same name throws/returns without adding record | Automated |
| AC3 | `delBuy()` is blocked if any invoice has `buyerId === buyer.id`; `DB.buy` unchanged | Automated |
| AC4 | `delBuy()` succeeds for a buyer with no linked invoices; `DB.buy` length decreases by 1 | Automated |
| AC5 | `fromGBP(100, 'USD')` returns `100 * QR.fxGBPUSD` | Automated |
| AC6 | `seedAdHocBuyer()` called twice results in exactly one Ad-Hoc record in `DB.buy` | Automated |
| AC7 | `get_invoices` AI tool response includes `buyerName` resolved from `DB.buy` when `buyerId` is set | Automated |
| AC8 | `expAll` snapshot includes `buy` array | Automated |
| AC9 | Ad-Hoc buyer cannot be deleted (guarded) | Automated |
| AC10 | Buyer Statement button in buyer modal is hidden when buyer has no invoices | Manual |
| AC11 | "＋ New Buyer…" in invoice dropdown creates a buyer and auto-selects it | Manual |

---

## Out of scope

- Sheets sync (deferred v3.0 — BUY-GAP-001)
- Credit limit enforcement (display only)
- Buyer-to-Contact linking (future)
- Inbound leads / pipeline (Contacts entity)
- Historic FX rate conversion (MTD-GAP-002 caveat applies to BUY-GAP-002)

---

## Known gaps to log

| ID | Summary |
|---|---|
| BUY-GAP-001 | Sheets sync deferred to v3.0 (FM-1 freeze) |
| BUY-GAP-002 | `fromGBP()` uses QR rates at render time, not historic rates — same caveat as MTD-GAP-002 |
| BUY-GAP-003 | Ad-Hoc buyer accumulates all unlinked legacy invoices — operator should periodically reassign to named buyers |
