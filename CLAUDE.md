For full project context including business strategy, FPM data, and programme roadmap, read STACKD_CONTEXT.md in this repo root.

# Stackd Ops — Claude Code Context

## What this project is
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies. Deployed via GitHub Pages.

**Current version: v2.9.18**  
**Test count: 193/193 PASS** (`node tests/run.js`)

---

## Architecture

| Concern | Detail |
|---|---|
| All code | `index.html` — HTML + `<style>` + `<script>` in one file |
| Persistence | `localStorage` only — no server, no API |
| Tests | `tests/run.js` — Node.js VM sandbox, run with `node tests/run.js` |
| Known gaps log | `docs/known-gaps.md` |
| Version history | `docs/version-history.md` |
| Agent architecture | `docs/agent-architecture.md` |
| Council decisions log | `docs/councils/` — verdicts from LLM Council sessions |
| Branch for new work | `claude/sync-race-condition-fixes-Q6Ion` |

---

## State layer

```js
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt }         // all entity arrays
let EI = { s, l, i, cn, p, sh, qt }                    // currently-editing ID (null = new)
let cIL = [], cPL = [], cQL = [], cCNL = []             // live line-item arrays for modals
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
| sup | st_s | Suppliers |
| li | st_l | Line items (product catalogue) |
| inv | st_i | Invoices |
| po | st_p | Purchase orders |
| payments | st_pm | Payment ledger entries |
| sh | st_sh | Shipments |
| qt | st_qt | Quotes (v2.9.4) |

---

## Quote engine (v2.9.4)

Calculation chain:

```
cQteLine(line, qr, freightMode, totalCBM)
  → { freight, dgAmt, ins, duty, landed }

cQte(qt)
  → { totalLanded, overhead, quotedTotal, sellUSD, sellGBP, lineCalcs[] }
```

Versioning triggers (on `saveQte()`): cost, dutyPct, or markup changed from last saved version. First save always creates v1. Each version entry: `{ v, ts, cost, dutyPct, markup, landed, sellPrice, note }`. `sellPrice = landed × (1 + markup/100)`. Stored on `line.priceHistory[]` inside the quote record.

---

## Key coding conventions

- **Validation helpers:** `vErr(id, msg)` / `vOk(id)` / `vClr(id)` / `vFormOk(modalId)`
- **XSS:** Always wrap user-supplied strings in `san()` before inserting into `innerHTML`.
- **Async save functions** are called fire-and-forget from `onclick`. `syncEnt`/`delEnt` have internal try/catch — chain `.catch(function(){})` on all calls for consistency.

Reference data helpers:
- `getAllPorts()` — merges `RD_PORTS` + `getCustomPorts()` (from `stackd_custom_ports`)
- `getPaymentTerms()` — merges `RD_PAYMENT_TERMS_BASE` + `rd_pt_cust`
- `getUOM()` — merges base UOM + `rd_uom_cust`

View routing: `showV(v, tab)` dispatches to render functions via the `fns` map. Adding a new top-level entity requires entries in: `K`, `DB`, `EI`, `saveAll`, `showV fns`, `renderAll`, `expAll snap`, `doImport entities`.

---

## Test runner notes

- Mock environment: `mockEl(id)` returns `{ value:'', checked:false, style:{}, classList:{} }` — no `focus()`, `remove()`, `querySelector()`
- `resetDB()` sets `ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[] }`
- `let`/`const` in app script are promoted to `var` by the test harness so they appear on `ctx`
- Async save functions (e.g. `saveShp`, `saveQte`) mutate DB synchronously before any `await` — tests call them without `await` and assert DB state immediately after

---

## On version delivery

At the end of each version delivery, update:

- **This file** — bump Current version, update Test count, update branch name if changed, tick off sprint items
- **`docs/version-history.md`** — prepend new version row
- **`docs/known-gaps.md`** — add new gap entries as they are identified
- **`AI_SYSTEM_PROMPT` in `index.html`** — **mandatory on every version, no exceptions.** Review against every change shipped. If any new entity, field, feature, workflow, setting, or known quirk was added or changed, update the prompt. Ask: "If the user asked the AI about this feature, would the answer be accurate?" A version is not complete until the prompt reflects current portal behaviour.
- **In-app changelog** — prepend a new version block with bullet-point summary of changes
- **Raise a PR** — push the branch and raise a PR so the user can test functionality in the portal before merging

---

## Known gaps (summary)

See `docs/known-gaps.md` for full entries.

| ID | Area | Summary |
|---|---|---|
| QTE-GAP-001 | Quote status | No workflow enforcement — Convert to PO available on any status |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates |
| SEC-GAP-001 | Code.gs secrets | Spreadsheet IDs and sync token hardcoded in source |
| SEC-GAP-002 | Sheets sync GDPR | PII transmitted externally; opt-in; accepted until first external client |
| SEC-GAP-003 | API key in browser | Anthropic key in localStorage — inherent no-server constraint |
| SEC-GAP-004 | Invoice locking | Client-side UX control only — not tamper-proof |

---

## Current sprint

| ID | Item | Status |
|---|---|---|
| 8 | Quote line price versioning | ✓ done (v2.9.4) |
| 9 | Xero export | ✓ done (v2.9.5) |
| 10 | Sync URL guard + status timestamp | ✓ done (v2.9.14) |
| 11 | Security fixes (XSS, pullAll crash, testConn token, PII) | ✓ done (v2.9.14) |
| 12 | Prompt caching (Layer 4) + section index (Layer 3A) + CLAUDE.md restructure (Layer 1) | ✓ done (v2.9.14) |
