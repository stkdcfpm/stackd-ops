# Stackd Ops — Data Model
**Version:** 1.0.0
**Date:** 2026-04-21
**Author:** FPM International
**Status:** Live — matches stackd-ops-v2.3.2.html and stackd-appsscript-v2.1.0.gs

---

## 1. Overview

Stackd Ops uses four core entities. Every piece of operational data in the system belongs to one of these entities. They are stored in browser localStorage (offline cache) and synced to Google Sheets via Apps Script (persistent store).

```
SUPPLIERS ──────────────────────────────────────────────────────┐
  │ One supplier has many line items                            │
  ▼                                                             │
LINE ITEMS ──────────────────────────────────────────────────── │
  │ Many line items belong to one invoice                       │
  ▼                                                             │
INVOICES ────────────────────────────────────────────────────── │
  │ One invoice auto-generates one PO per supplier              │
  ▼                                                             │
PURCHASE ORDERS ◄───────────────────────────────────────────────┘
  Each PO links back to the invoice that created it
  Each PO links to exactly one supplier
```

---

## 2. Entity: Suppliers

**Purpose:** Master list of all suppliers FPM International sources from.
**Sheet tab:** `Suppliers`
**Entity key:** `sup`

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Unique identifier. Auto-generated. Format: `[timestamp36][random]`. Test records prefixed `TEST-`. |
| `name` | String | Yes | Supplier company name. |
| `country` | String | No | Country of operation. e.g. `China`, `Barbados`. |
| `ct` | String | No | Contact person name at the supplier. |
| `email` | String | No | Supplier contact email address. |
| `phone` | String | No | Supplier phone or WeChat ID. |
| `cur` | String | No | Supplier's preferred transaction currency. Values: `USD`, `CNY`, `GBP`, `EUR`. Default: `USD`. |
| `notes` | String | No | Free text. Certifications, lead times, MOQs, red flags, due diligence notes. |
| `updAt` | ISO DateTime | Auto | Last updated timestamp. Set automatically on every save. |

### Business Rules
- A supplier must exist before a line item can be linked to it.
- Deleting a supplier does not cascade-delete linked line items — line items retain the `supId` reference but the supplier name will show as `?` in the UI.
- Supplier currency is informational only — invoice and PO currencies are set independently.

---

## 3. Entity: Line Items

**Purpose:** Product catalogue. Each record represents one product from one supplier with its cost and selling price. Line items are the atomic unit of an order.
**Sheet tab:** `LineItems`
**Entity key:** `li`

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Unique identifier. Auto-generated. |
| `sku` | String | No | Stock Keeping Unit or item reference number. e.g. `REF-COMM-600L`. |
| `desc` | String | Yes | Product description. Plain English name of the product. |
| `specs` | String | No | Technical specifications. Size, grade, model, colour, voltage, material. |
| `supId` | String | Yes | Foreign key → Suppliers.id. Links this item to its supplier. |
| `uom` | String | No | Unit of measure. e.g. `pcs`, `kg`, `m²`, `sheets`, `sets`. |
| `cost` | Number | No | Unit cost — what FPM pays the supplier per unit. Used for COGS and margin calculations. |
| `price` | Number | No | Unit price — what FPM charges the buyer per unit. |
| `cur` | String | No | Currency for cost and price. Values: `USD`, `GBP`, `EUR`, `BBD`, `NGN`, `GHS`. |
| `notes` | String | No | HS code, certifications, packaging requirements, compliance notes. |
| `updAt` | ISO DateTime | Auto | Last updated timestamp. |

### Calculated (UI only, not stored)
| Calculation | Formula |
|-------------|---------|
| Unit margin | `price - cost` |
| Margin % | `(price - cost) / price × 100` |

### Business Rules
- A line item must be linked to a supplier via `supId`.
- `cost` and `price` are in the currency specified by `cur` — mixing currencies within one invoice is not currently supported. All invoice line items should use the same currency as the invoice.
- Line items are reusable across multiple invoices. Editing a line item's cost or price does not retroactively update existing invoices.
- When imported into an invoice, `price` becomes the `up` (unit price) on the invoice line item. The `cost` is looked up at calculation time via `supId` → COGS.

---

## 4. Entity: Invoices

**Purpose:** Buyer-facing commercial document. Groups line items from multiple suppliers into a single invoice for one buyer. The primary revenue record.
**Sheet tab:** `Invoices`
**Entity key:** `inv`

### Fields — Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Unique identifier. Auto-generated. |
| `num` | String | Yes | Invoice number. User-defined. e.g. `INV-2025-001`. Appears on printed document. |
| `buyer` | String | Yes | Buyer company or individual name. |
| `buyerAddr` | String | No | Buyer full address. |
| `shipTo` | String | No | Delivery address if different from buyer address. |
| `dst` | String | No | Destination country or region. e.g. `Barbados`, `Nigeria`. Used in dashboard charts. |
| `custId` | String | No | Customer reference ID. e.g. `CUS-001`. |
| `date` | Date | Yes | Invoice date. Format: `YYYY-MM-DD`. |
| `expiry` | Date | No | Payment due / expiry date. |
| `shipDate` | Date | No | Estimated ship date. |
| `status` | Enum | Yes | Pipeline status. Values: `Draft`, `Sent`, `Partially Paid`, `Paid`, `Cancelled`. |

### Fields — Shipping

| Field | Type | Description |
|-------|------|-------------|
| `ft` | String | Freight type. e.g. `Sea - FCL 40HQ`, `Air`. |
| `wt` | String | Estimated gross weight. e.g. `4200 KGS`. |
| `cbm` | String | Estimated cubic/volumetric weight. e.g. `22 CBM`. |
| `pk` | String | Total number of packages. |
| `pol` | String | Port of embarkation. e.g. `Qingdao`. |
| `pod` | String | Port of discharge. e.g. `Bridgetown`. |
| `coo` | String | Country of origin. e.g. `China`. |

### Fields — Financial

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cur` | String | Yes | Invoice currency. Values: `USD`, `GBP`, `EUR`, `BBD`, `NGN`, `GHS`. |
| `taxRate` | Number | Yes | Tax rate as a decimal. e.g. `0.10` = 10%. `0` = zero rated. |
| `lf` | Number | No | Local freight charge. |
| `ins` | Number | No | Insurance charge. |
| `leg` | Number | No | Legal / consular fees. |
| `isp` | Number | No | Inspection / certification fees. |
| `oth` | Number | No | Other charges. |
| `dep` | Number | No | Buyer deposit received. Deducted from grand total to show balance due. |
| `terms` | String | No | Terms of sale and payment. Printed on invoice document. |

### Fields — Line Items (embedded)

| Field | Type | Description |
|-------|------|-------------|
| `lineItems` | JSON Array | Array of line item objects embedded on the invoice. See Line Item Sub-record below. |
| `pos` | JSON Array | Array of PO IDs auto-generated from this invoice. e.g. `["po-id-1","po-id-2"]`. |

### Line Item Sub-record (embedded in invoice)

| Field | Type | Description |
|-------|------|-------------|
| `rid` | String | Row ID. Unique within this invoice. |
| `lid` | String | Reference to LineItems.id. Used to look up `cost` for COGS calculation. Empty if line item added manually. |
| `desc` | String | Description as it appears on the invoice. Editable after import. |
| `uom` | String | Unit of measure. |
| `qty` | Number | Quantity. |
| `up` | Number | Unit price charged to buyer. |

### Calculated Fields (written to Sheet by Apps Script)

| Field | Formula |
|-------|---------|
| `calc_liTotal` | Sum of `qty × up` across all line items |
| `calc_taxAmt` | `calc_liTotal × taxRate` |
| `calc_grandTotal` | `calc_liTotal + calc_taxAmt + lf + ins + leg + isp + oth` |
| `calc_cogs` | Sum of `qty × cost` looked up from LineItems |
| `calc_grossProfit` | `calc_liTotal - calc_cogs` |
| `calc_netProfit` | `calc_grandTotal - calc_cogs - lf - ins - leg - isp - oth` |
| `calc_margin` | `calc_netProfit / calc_grandTotal × 100` |
| `calc_balanceDue` | `calc_grandTotal - dep` |

### Business Rules
- Invoice number must be unique. No system enforcement currently — operator responsibility.
- Saving a new invoice (not an edit) triggers automatic PO generation — one PO per unique supplier across the invoice's line items.
- Line items with no `lid` (manually added) do not contribute to COGS — gross profit will be understated for manual lines.
- Tax rate is applied to the items subtotal only, not to freight/insurance/other charges.
- Deposit is a deduction from grand total for invoice purposes only — it does not affect P&L calculations (net profit is calculated on full revenue).

---

## 5. Entity: Purchase Orders

**Purpose:** Supplier-facing document. One PO per supplier per job. Created automatically when an invoice is saved, or manually. Tracks what FPM owes each supplier, deposit paid, and balance due.
**Sheet tab:** `PurchaseOrders`
**Entity key:** `po`

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | String | Yes | Unique identifier. Auto-generated. |
| `num` | String | Yes | PO number. Auto-generated as `PO-[invoice-num]-[index]` or user-defined. |
| `supId` | String | Yes | Foreign key → Suppliers.id. |
| `invId` | String | No | Foreign key → Invoices.id. Empty if PO created manually. |
| `invNum` | String | No | Invoice number for display. Denormalised for readability. |
| `date` | Date | Yes | PO date. |
| `del` | Date | No | Required delivery date. |
| `cur` | String | Yes | PO currency. Usually matches supplier currency. |
| `lineItems` | JSON Array | Yes | Array of line item sub-records. See below. |
| `dep` | Number | No | Supplier deposit paid. Deducted from balance due. |
| `oth` | Number | No | Other charges (e.g. freight to port). |
| `notes` | String | No | Special instructions, packaging requirements, certification requirements. |
| `status` | Enum | Yes | Values: `Draft`, `Sent`, `Deposit Paid`, `Settled`, `Cancelled`. |
| `creAt` | ISO DateTime | Auto | Created timestamp. Set on first save only. |
| `updAt` | ISO DateTime | Auto | Last updated timestamp. |

### PO Line Item Sub-record

| Field | Type | Description |
|-------|------|-------------|
| `rid` | String | Row ID. Unique within this PO. |
| `lid` | String | Reference to LineItems.id. |
| `desc` | String | Product description. |
| `sku` | String | SKU from line item record. |
| `uom` | String | Unit of measure. |
| `qty` | Number | Quantity ordered. |
| `cost` | Number | Unit cost paid to supplier. |

### Calculated Fields (written to Sheet)

| Field | Formula |
|-------|---------|
| `calc_liTotal` | Sum of `qty × cost` |
| `calc_grandTotal` | `calc_liTotal + oth` |
| `calc_balanceDue` | `calc_grandTotal - dep` |

### Business Rules
- Auto-generated POs inherit line items and quantities from the parent invoice, mapped to their respective suppliers.
- Auto-generated PO deposit defaults to `0` — must be updated manually when deposit is paid.
- A PO can exist without a linked invoice (manually created standalone PO).
- Status `Settled` means full payment made to supplier. Used in dashboard to exclude from PO commitment totals.

---

## 6. Entity Relationships Summary

```
Suppliers (1) ──────────── (many) LineItems
    │                              │
    │                              │ (embedded as sub-records)
    │                              ▼
    │                          Invoices (1) ──── (many) PurchaseOrders
    │                                                       │
    └───────────────────────────────────────────────────────┘
                    PO.supId → Supplier
```

---

## 7. Data Storage Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  BROWSER (per device)                                        │
│                                                              │
│  localStorage                                                │
│  ├── st_s    → Suppliers array (JSON)                       │
│  ├── st_l    → Line Items array (JSON)                      │
│  ├── st_i    → Invoices array (JSON)                        │
│  ├── st_p    → Purchase Orders array (JSON)                 │
│  ├── st_ss   → Sync settings (URL, auto-sync, pull-on-load) │
│  ├── st_as   → App settings (company, bank, terms)          │
│  └── st_au   → Audit log (last 500 entries)                 │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTPS POST/GET
                       │ Apps Script Web App URL
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  GOOGLE APPS SCRIPT (stackd-appsscript-v2.1.0.gs)           │
│                                                              │
│  doGet()   → get_all, ping                                   │
│  doPost()  → upsert, bulk_upsert, delete                    │
│                                                              │
│  Calculates derived fields server-side before writing        │
│  Writes audit entry on every operation                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  GOOGLE SHEETS (persistent store)                            │
│                                                              │
│  Tab: Suppliers        → one row per supplier                │
│  Tab: LineItems        → one row per line item               │
│  Tab: Invoices         → one row per invoice                 │
│       lineItems field  → JSON string (embedded array)        │
│       pos field        → JSON string (array of PO IDs)       │
│       calc_* fields    → pre-calculated values               │
│  Tab: PurchaseOrders   → one row per PO                      │
│       lineItems field  → JSON string (embedded array)        │
│       calc_* fields    → pre-calculated values               │
│  Tab: AuditLog         → timestamped record of all changes   │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Audit Trail

Every create, update, delete, and bulk operation writes a row to the `AuditLog` sheet with:

| Field | Content |
|-------|---------|
| `timestamp` | ISO 8601 datetime |
| `action` | `CREATE`, `UPDATE`, `DELETE`, `BULK_UPSERT`, `SEED`, `CLEAR` |
| `entity` | `sup`, `li`, `inv`, `po`, `system` |
| `recordId` | The `id` of the affected record |
| `snapshot` | First 500 characters of the record JSON at time of operation |

The browser also maintains a local audit log (last 500 entries) in `st_au` localStorage key.

---

## 9. ID Convention

All IDs are auto-generated using:
```javascript
Date.now().toString(36) + Math.random().toString(36).slice(2,5)
```
This produces a short, unique, time-ordered string. e.g. `lf3k2abc`.

Test data IDs use the prefix `TEST-` e.g. `TEST-SUP-001`. The `clearTestData()` function identifies and removes all records with this prefix.

---

## 10. TradeFlow Scaling Notes

These are design decisions that will need to change when Stackd Ops becomes a multi-user SaaS product (TradeFlow).

| Current design | TradeFlow change required |
|----------------|--------------------------|
| localStorage as offline cache | Replace with IndexedDB or service worker cache |
| Single Google Sheet per user | Multi-tenant database (PostgreSQL or Firestore) |
| Apps Script as backend | REST API (Node.js/Express or equivalent) |
| Simple hash password gate | OAuth2 / JWT authentication per user |
| Single currency per invoice | Multi-currency with FX rate storage |
| Manual invoice numbering | Auto-incrementing sequence per organisation |
| Embedded line items in invoice row | Normalised line_items table with foreign key |
| No role-based access | Admin / operator / read-only roles |
| Audit log capped at 500 entries | Unlimited audit log with search |
