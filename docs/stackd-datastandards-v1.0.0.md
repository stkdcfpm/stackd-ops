# Stackd Ops — Data Quality & Standards
**Version:** 1.0.0
**Date:** 2026-04-21
**Author:** FPM International
**Framework reference:** DAMA-DMBOK (Data Management Body of Knowledge)

---

## 1. Purpose

This document defines the data quality standards, validation rules, and data management practices for Stackd Ops. It serves as the reference for:
- What constitutes a complete, valid record in each entity
- What the system enforces vs what the operator is responsible for
- How data quality is measured and maintained
- Standards to apply when Stackd Ops becomes a multi-user product (TradeFlow)

---

## 2. Data Quality Dimensions

Following DAMA-DMBOK, data quality is measured across six dimensions:

| Dimension | Definition | Applies to Stackd Ops |
|-----------|------------|----------------------|
| **Completeness** | All required fields are populated | Invoice num, buyer, date, status required |
| **Accuracy** | Data correctly represents the real-world value | Unit costs, prices, quantities, tax rates |
| **Consistency** | Data is the same across all stores | localStorage must match Google Sheets |
| **Timeliness** | Data is current and up to date | Sync on every save, pull on load |
| **Uniqueness** | No duplicate records | Invoice numbers must be unique per operator |
| **Validity** | Data conforms to defined formats and rules | Dates, currencies, numeric fields |

---

## 3. Validation Rules by Entity

### 3.1 Suppliers

| Field | Rule | Enforcement | Action on violation |
|-------|------|-------------|---------------------|
| `name` | Required. Non-empty string. | App (planned) | Block save |
| `email` | Valid email format if provided. `x@x.x` minimum. | App (planned) | Warn on save |
| `cur` | Must be one of: USD, CNY, GBP, EUR | UI dropdown — enforced by design | n/a |
| `country` | Free text — no constraint. Standardise to country name not code. | Operator responsibility | n/a |

### 3.2 Line Items

| Field | Rule | Enforcement | Action on violation |
|-------|------|-------------|---------------------|
| `desc` | Required. Non-empty string. | App (planned) | Block save |
| `supId` | Required. Must reference existing supplier. | App (planned) | Block save |
| `cost` | Required if used in invoices. Must be >= 0. Non-negative number. | App (planned) | Warn on save |
| `price` | Required if used in invoices. Must be >= 0. | App (planned) | Warn on save |
| `price >= cost` | Price should be >= cost. If price < cost, margin is negative — flag but do not block. | App (planned) | Warn — negative margin highlighted in red |
| `cur` | Must be one of: USD, GBP, EUR, BBD, NGN, GHS | UI dropdown | n/a |

### 3.3 Invoices

| Field | Rule | Enforcement | Action on violation |
|-------|------|-------------|---------------------|
| `num` | Required. Non-empty. Should be unique. Recommended format: `INV-YYYY-NNN`. | Operator responsibility | No system block currently |
| `buyer` | Required. Non-empty string. | App (planned) | Block save |
| `date` | Required. Valid date. Not future date on Paid invoices. | App (planned) | Block save |
| `status` | Required. Must be one of defined enum values. | UI dropdown | n/a |
| `taxRate` | Required. Must be >= 0 and <= 1. e.g. 0.20 for 20%. | UI dropdown + custom field | Warn if > 0.50 (50% unlikely) |
| `cur` | Must be one of defined values. | UI dropdown | n/a |
| `lineItems` | Must contain at least one line item. | App (planned) | Block save |
| `dep` | Must be >= 0. Must not exceed grand total. | App (planned) | Warn if deposit > total |
| Numeric charges | lf, ins, leg, isp, oth must be >= 0. | App (planned) | Block negative values |

### 3.4 Purchase Orders

| Field | Rule | Enforcement | Action on violation |
|-------|------|-------------|---------------------|
| `num` | Required. Non-empty. | App (planned) | Block save |
| `supId` | Required. Must reference existing supplier. | App (planned) | Block save |
| `status` | Required. Must be one of defined enum values. | UI dropdown | n/a |
| `dep` | Must be >= 0. Must not exceed calc_grandTotal. | App (planned) | Warn if deposit > total |
| `lineItems` | At least one line item required. | App (planned) | Block save |
| `cost` on line items | Must be >= 0. | App (planned) | Block negative values |

---

## 4. Data Standardisation Rules (Operator Responsibility)

These are not enforced by the system but must be followed for data to be consistent and reportable.

### 4.1 Invoice Numbering
Use the format: `INV-YYYY-NNN`
- `YYYY` = year e.g. `2025`
- `NNN` = sequential number padded to 3 digits e.g. `001`, `012`, `100`
- Example: `INV-2025-001`, `INV-2025-002`
- Never reuse a number. If an invoice is cancelled, the number is retired.

### 4.2 PO Numbering
Auto-generated POs follow: `PO-[invoice-num]-[index]`
- Example: `PO-INV-2025-001-1`, `PO-INV-2025-001-2`
- Manual POs: `PO-YYYY-NNN` following same pattern as invoices.

### 4.3 Country Names
Use full country names, not ISO codes.
- Correct: `China`, `Barbados`, `Nigeria`, `United Kingdom`
- Incorrect: `CN`, `BB`, `NG`, `UK`

### 4.4 Currency
Always set the correct currency on the invoice before adding line items. Do not mix currencies within one invoice.

### 4.5 Dates
Always use the date picker — do not type dates manually. Format is `YYYY-MM-DD` in storage.

### 4.6 Supplier Notes
Use the notes field to record:
- Certification status and expiry dates
- Lead times
- MOQs (minimum order quantities)
- Any red flags or due diligence findings
- Last contact date

---

## 5. Data Consistency Rules

The system maintains two copies of data: localStorage (browser) and Google Sheets. These rules govern consistency:

| Rule | Description |
|------|-------------|
| Sheets is master | On conflict between local and Sheets, Sheets wins on Pull. |
| Auto-sync on save | Every save operation syncs to Sheets immediately (if online). |
| Pull on load | App pulls from Sheets on load if `pullOnLoad` is enabled. |
| ID is immutable | Once an `id` is generated it never changes. This is the join key across all stores. |
| Calculated fields | `calc_*` fields in Sheets are always re-calculated by Apps Script on save. Never edit them manually in the Sheet. |
| AuditLog is append-only | Never delete rows from the AuditLog tab. It is the system of record for all changes. |

---

## 6. Data Retention

| Data type | Retention | Notes |
|-----------|-----------|-------|
| Invoices | Indefinite | Legal requirement — see regulatory doc |
| Purchase Orders | Indefinite | Commercial record |
| Suppliers | Indefinite | Keep even inactive suppliers — historical reference |
| Line Items | Indefinite | Editing a line item does not affect historical invoices |
| AuditLog | Indefinite | Never delete |
| Test data | Delete after QA | Use clearTestData() — all TEST- prefixed records |
| localStorage | Session-based | Cleared if user clears browser data — Sheets is backup |

---

## 7. Data Glossary

| Term | Definition |
|------|------------|
| **Supplier** | A manufacturer or vendor from whom FPM International sources goods for resale. |
| **Line Item** | A single product from a single supplier with a defined unit cost and unit price. The atomic unit of procurement. |
| **Invoice** | A buyer-facing commercial document requesting payment for goods supplied. Groups line items from multiple suppliers. |
| **Purchase Order (PO)** | A supplier-facing commercial document committing to purchase specific goods at a defined price. One PO per supplier per job. |
| **COGS** | Cost of Goods Sold. The total cost FPM paid suppliers for the items on an invoice. Calculated as sum of (qty × unit cost) across all line items. |
| **Gross Profit** | Revenue from line items minus COGS. Does not account for freight, insurance, or other charges. |
| **Net Profit** | Grand total revenue minus COGS minus all charges (freight, insurance, legal, inspection, other). |
| **Net Margin** | Net profit expressed as a percentage of grand total revenue. |
| **Realisation** | Same as net margin in current implementation — the percentage of invoice revenue retained as profit after all costs. |
| **Buyer Deposit** | A partial payment received from the buyer in advance of delivery. Reduces the balance due on the invoice. Does not affect P&L calculations. |
| **Supplier Deposit** | A partial payment made to the supplier to secure a production slot. Reduces the balance due on the PO. |
| **Balance Due (invoice)** | Grand total minus buyer deposit. The amount the buyer still owes FPM. |
| **Balance Due (PO)** | Total COGS plus other charges minus supplier deposit. The amount FPM still owes the supplier. |
| **Grand Total** | Line items subtotal plus tax plus all charges. The full invoice value. |
| **Tax Rate** | Applied to line items subtotal only. Expressed as decimal (0.20 = 20%). |
| **Auto-generated PO** | A PO created automatically when an invoice is saved, grouping line items by supplier. |
| **Sync** | The process of writing local data to Google Sheets (push) or reading from Sheets into local state (pull). |
| **Audit Log** | A tamper-evident record of every create, update, and delete operation with timestamp and data snapshot. |
| **Entity key** | Short code used in the app to identify an entity: `sup`, `li`, `inv`, `po`. |
| **calc_ fields** | Pre-calculated values written to Google Sheets by the Apps Script to enable Sheet-level reporting without the app. |

---

## 8. Data Quality Scorecard

Use this to assess data quality periodically. Open the Google Sheet and review each tab.

| Check | How to assess | Frequency |
|-------|--------------|-----------|
| All invoices have a buyer name | Filter Invoices tab for empty buyer column | Monthly |
| All invoices have at least one line item | Check lineItems column for `[]` | Monthly |
| No duplicate invoice numbers | Sort Invoices by num, scan for duplicates | Monthly |
| All POs linked to a supplier | Filter POs for empty supId | Monthly |
| Calculated fields match expected values | Spot-check calc_grandTotal against manual calculation | Quarterly |
| AuditLog growing correctly | Check last row timestamp vs last known change | Monthly |
| Sheets and localStorage in sync | Pull from Sheets, verify record counts match | Monthly |

---

## 9. Planned Validation Enhancements (v2.4.0)

The following validations are planned for the next feature release. Currently operator responsibility.

- [ ] Required field enforcement on all save operations with specific error messages
- [ ] Invoice number uniqueness check on save
- [ ] Deposit amount validation — cannot exceed grand total
- [ ] Negative cost/price prevention
- [ ] Date logic — expiry date must be after invoice date
- [ ] At least one line item required before saving invoice
- [ ] Supplier existence check when saving line items
- [ ] Currency consistency warning when line items have mixed currencies
