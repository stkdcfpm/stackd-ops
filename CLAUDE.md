# Stackd Ops — Claude Code Context

## What this project is
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies. Deployed via GitHub Pages.

**Current version: v2.9.5**  
**Test count: 68/68 PASS** (`node tests/run.js`)

---

## Architecture

| Concern | Detail |
|---|---|
| All code | `index.html` — HTML + `<style>` + `<script>` in one file |
| Persistence | `localStorage` only — no server, no API |
| Tests | `tests/run.js` — Node.js VM sandbox, run with `node tests/run.js` |
| Known gaps log | `docs/known-gaps.md` |
| Branch for new work | `claude/code-structure-review-093lq` |

---

## State layer

```javascript
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt }         // all entity arrays
let EI = { s, l, i, p, sh, qt }                         // currently-editing ID (null = new)
let cIL = [], cPL = [], cQL = []                        // live line-item arrays for modals
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin }
var QR = { ...QR_DEFAULTS, ...ld('st_qr') }             // active rates (editable in Settings)
```

`saveAll()` persists every DB entity. `ldArr(k)` always returns `[]` if localStorage key is absent or malformed.

---

## Entities

| Key | Store key | Description |
|---|---|---|
| `sup` | `st_s` | Suppliers |
| `li` | `st_l` | Line items (product catalogue) |
| `inv` | `st_i` | Invoices |
| `po` | `st_p` | Purchase orders |
| `payments` | `st_pm` | Payment ledger entries |
| `sh` | `st_sh` | Shipments |
| `qt` | `st_qt` | Quotes (v2.9.4) |

---

## Quote engine (v2.9.4)

**Calculation chain:**
```
cQteLine(line, qr, freightMode, totalCBM)
  → { freight, dgAmt, ins, duty, landed }

cQte(qt)
  → { totalLanded, overhead, quotedTotal, sellUSD, sellGBP, lineCalcs[] }
```

**Versioning triggers** (on `saveQte()`): `cost`, `dutyPct`, or `markup` changed from last saved version. First save always creates v1. Each version entry: `{ v, ts, cost, dutyPct, markup, landed, sellPrice, note }`. `sellPrice = landed × (1 + markup/100)`. Stored on `line.priceHistory[]` inside the quote record.

---

## Key coding conventions

**Validation helpers:** `vErr(id, msg)` / `vOk(id)` / `vClr(id)` / `vFormOk(modalId)`

**XSS:** Always wrap user-supplied strings in `san()` before inserting into innerHTML.

**Async save functions** are called fire-and-forget from `onclick`. `syncEnt`/`delEnt` have internal try/catch — chain `.catch(function(){})` on all calls for consistency (see lines ~2292, ~4455, ~4483).

**Reference data helpers:**
- `getAllPorts()` — merges `RD_PORTS` + `getCustomPorts()` (from `stackd_custom_ports`)
- `getPaymentTerms()` — merges `RD_PAYMENT_TERMS_BASE` + `rd_pt_cust`
- `getUOM()` — merges base UOM + `rd_uom_cust`

**View routing:** `showV(v, tab)` dispatches to render functions via the `fns` map. Adding a new top-level entity requires entries in: `K`, `DB`, `EI`, `saveAll`, `showV fns`, `renderAll`, `expAll snap`, `doImport entities`.

---

## Test runner notes

- Mock environment: `mockEl(id)` returns `{ value:'', checked:false, style:{}, classList:{} }` — no `focus()`, `remove()`, `querySelector()`
- `resetDB()` sets `ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[] }`
- `let`/`const` in app script are promoted to `var` by the test harness so they appear on `ctx`
- Async save functions (e.g. `saveShp`, `saveQte`) mutate DB synchronously before any `await` — tests call them without `await` and assert DB state immediately after

---

## Version history (brief)

| Version | Highlights |
|---|---|
| v2.9.5 | Accounting export — generic CSV/JSON + Xero/QuickBooks/FreeAgent mappers, data quality check, export modal |
| v2.9.4 | Quote engine, rate engine, per-line price versioning, Settings Rates card |
| v2.9.3 | Incoterms + Payment Terms fields, custom ports, 5 new UN/LOCODE ports |
| v2.9.2 | Reference data audit |
| v2.9.1 | Price history on line items and invoices |
| v2.8.1 | Shipment CRUD, DG flag, linked invoices |
| v2.8.0 | Payments ledger, balance tracking |

---

## Known gaps

See `docs/known-gaps.md` for full entries.

| ID | Area | Summary |
|---|---|---|
| QTE-GAP-001 | Quote status | No workflow enforcement — Convert to PO available on any status; no transition guards |

---

## On version delivery

At the end of each version delivery, update:
1. **This file** — bump `Current version`, update `Test count`, add row to Version history, add any new Known gaps, tick off sprint items
2. **`docs/known-gaps.md`** — add new gap entries as they are identified

---

## Current sprint

| ID | Item | Status |
|---|---|---|
| 8 | Quote line price versioning | ✓ done (v2.9.4) |
| 9 | Xero export | ✓ done (v2.9.5) |
