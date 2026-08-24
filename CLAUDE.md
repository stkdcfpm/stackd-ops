For full project context including business strategy, FPM data, and programme roadmap, read STACKD_CONTEXT.md in this repo root.

For operator-facing workflow detail (how to use each tab/feature today), read docs/user-guide.md.

# Stackd Ops — Claude Code Context

## What this project is
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies (one acknowledged exception: `vendor/supabase-js-v2.min.js`, a vendored same-origin static file used only for Suppliers/Buyers when Cloud Data is configured — REQ/SPEC-CLOUD-001, no CDN, no auto-update). Deployed via GitHub Pages.

**Current version: v2.9.59**  
**Test count: 538/538 PASS** (`node tests/run.js`)

---

## Architecture

| Concern | Detail |
|---|---|
| All code | `index.html` — HTML + `<style>` + `<script>` in one file |
| Companion tools | `triage.html` — standalone "FPM Enquiry Triage — 10 Minute Screen", served at `app.getstackdops.com/triage.html`. Not linked from the main app nav. Exports a CSV matching `TEMPLATES.ord`'s exact header contract (`index.html:6312`) on a "Cleared for study" verdict, importable via the Import Data tab's Order Requests step. The two files are kept in sync manually — no build step connects them; if `TEMPLATES.ord.headers` changes, `triage.html`'s duplicated `ORD_HEADERS` literal must be updated by hand. |
| Persistence | `localStorage` only — no server, no API |
| **Public repo policy** | **GitHub Pages serves the ENTIRE repo at app.getstackdops.com. Every committed file is publicly readable. Never commit live data exports, backups, personal contact details, or credentials (SEC-GAP-020). `.gitignore` blocks `Test-data/` and `Stackd-*.json`.** |
| Tests | `tests/run.js` — Node.js VM sandbox, run with `node tests/run.js` |
| Known gaps log | `docs/known-gaps.md` |
| Version history | `docs/version-history.md` |
| DR procedure | `docs/dr-procedure.md` |
| Agent architecture | `docs/agent-architecture.md` |
| Council decisions log | `docs/councils/` — verdicts from LLM Council sessions |
| Branch for new work | `claude/production-sync-restored-b8mpb2` |

---

## State layer

```js
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai, co, ev }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt, con, events }   // all entity arrays
let EI = { s, l, i, cn, p, sh, qt, co }                // currently-editing ID (null = new)
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
| co | st_co | Contacts (v2.9.27) |
| events | st_ev | Activity event log (v2.9.28) |
| ord | st_ord | Order Requests (v2.9.44) |

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
- **`docs/user-guide.md`** — update the relevant feature-area section if this release changed operator-visible behavior (new feature, changed workflow, changed field). Skip only if the change is purely internal (bug fix with no visible behavior change, test-only, refactor).
- **In-app changelog** — prepend a new version block with bullet-point summary of changes
- **Raise a PR** — push the branch and raise a PR so the user can test functionality in the portal before merging

---

## Known gaps (summary)

See `docs/known-gaps.md` for full entries.

| ID | Area | Summary |
|---|---|---|
| QTE-GAP-001 | Quote status | Convert to PO restricted to Accepted status — Fixed v2.9.25 |
| PO-GAP-001 | Quote→PO conversion | qteToPoConvert() attributed every line to the first line's supplier — Fixed v2.9.44 (REQ/SPEC-PO-001, one PO per distinct supplier) |
| PO-GAP-002 | Quote→PO conversion | POs created before v2.9.44 may carry incorrect supplier attribution — not retroactively corrected, no automated audit |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates |
| SEC-GAP-001 | Code.gs secrets | Spreadsheet IDs and sync token hardcoded in source |
| SEC-GAP-002 | Sheets sync GDPR | PII transmitted externally; opt-in; accepted until first external client |
| SEC-GAP-003 | API key in browser | Anthropic key in localStorage — inherent no-server constraint |
| SEC-GAP-004 | Invoice locking | Client-side UX control only — not tamper-proof |
| AI-GAP-007 | AI assistant | Action block emission inconsistent — temperature 0.2 mitigation shipped v2.9.42, confirmed 3/3 on retest |
| AI-GAP-008 | AI assistant | create_po required internal supId with no name resolution — Fixed v2.9.55 via new get_suppliers/get_buyers read tools |
| AI-GAP-009 | AI assistant | AI_SYSTEM_PROMPT's PO status vocabulary didn't match the live po-sm dropdown — Fixed v2.9.55 (prompt + get_pos tool description both corrected to Draft/Sent/Deposit Paid/Settled/Cancelled) |
| AI-GAP-006 | AI assistant | All nine creatable entities now supported by handleAIAction() — Fixed v2.9.55 (Invoices/Line Items/Credit Notes shipped, closing out Suppliers/Buyers from v2.9.41) |
| INV-GAP-001 | Invoice rendering | Pro-forma status rendered as plain Invoice document — Fixed v2.9.40 |
| SEC-GAP-020 | Public Pages exposure | Live PII was publicly served — fully resolved 2026-07-05 (purge, history rewrite, GDPR assessment, GitHub PR/cache purge all complete) |
| SEC-GAP-011 | Sync / data integrity | `pullAll()` overwrites local records unconditionally — Sheets wins, no timestamp-based conflict resolution |
| PROC-GAP-001 | Dashboard / accounting | Multi-currency KPI aggregation without FX conversion — Fixed v2.9.15 via `toGBP()` |
| SDLC-GAP-003 | Staging / preview | No same-origin PR preview environment — Netlify blocked by localStorage origin isolation; gh-pages path preview deferred post-pilot |
| CON-GAP-001 | Contacts / GDPR | No automated purge of stale contacts — manual deletion only; UI flags >700d |
| CLOUD-GAP-001 | Cloud Data / Suppliers | Legacy CSV/Sheets Supplier importers bypass Cloud Data — writes silently discarded on next reload once Cloud Data is configured |
| ORD-GAP-003 | Order Requests / Quotes | RFQ commit ↔ Quote drift, no back-reference or staleness warning — Fixed v2.9.58 (REQ/SPEC-INTEG-001 Phase 1) |
| PO-GAP-003 | Invoices / Purchase Orders | Invoice ↔ auto-generated PO drift, no re-sync or warning after `autoPos()`'s first-save-only guard — Fixed v2.9.58 (REQ/SPEC-INTEG-001 Phase 1) |
| CON-GAP-002 | Contacts / dedup | Email dedup is soft (force-new allowed); no enforcement of true uniqueness; edit-path email changes not deduped |
| CON-GAP-004 | Contacts / data integrity | Deleting a contact leaves dangling sourceContactId on associated quotes; runtime guards no-op safely |
| CON-GAP-005 | Contacts / import | Restoring a v2 backup (no con key) preserves live contacts rather than clearing them; WARNING dialog text is not updated to reflect this |
| MTD-GAP-001 | MTD / input VAT | Boxes 4 and 7 are always £0.00 — no purchase VAT invoices captured; input VAT reclaim not supported in v2.9.32 |
| MTD-GAP-002 | MTD / FX rates | `toGBP()` uses configured QR rates at export time, not the rate on each invoice date — historic rate variance is operator's responsibility |
| BUY-GAP-001 | Buyers / sync | Buyers not synced to Google Sheets — FM-1 freeze; deferred to v3.x |
| BUY-GAP-002 | Buyers / legacy | Legacy invoices without buyerId matched by name on edit; default BUY-ADHOC if no match |
| BUY-GAP-003 | Buyers / credit | Credit limit is display-only; no enforcement on invoice save |
| DATA-GAP-003 | Reference numbers / cross-device | `num` (SUP-/LI-/BUY-/CON-####) can diverge between two devices that haven't synced; same-device `pullAll()` stripping is mitigated (v2.9.43); cross-device divergence remains open, accepted design trade-off |
| DATA-GAP-004 | List-render onclick pattern | `rSup()`/`rLI()`/`rPO()`'s string-concatenation onclick handlers silently no-op delete/edit if a record is missing `id` — same root cause fixed for Contacts via REQ/SPEC-CON-003; backlogged for other entities absent a confirmed report |
| DATA-GAP-005 | Contacts / Sheets sync | Backfilling a Contact's `id` (REQ/SPEC-CON-003) can orphan its Sheets sync row if it was previously pushed with a blank Contact ID column — creates a duplicate row on next sync, no automated reconciliation; accepted, same class as SEC-GAP-011 |
| ORD-GAP-001 | Order Requests | Legacy-backfilled records (from Contact enquiry logs, no linked Quote) are lower-fidelity; abandoned-Quote PO/Invoice not auto-re-attributed on activeQuoteId reassignment — both accepted limitations |
| ORD-GAP-002 | Order Requests / AI assistant | update_order_line AI action has no corresponding get_order_lines read tool — same read/write asymmetry as AI-GAP-008 |
| CUR-GAP-001 | Display currency / Aging Report | Aging Report mixes currencies unconverted — pre-existing, out of scope for v2.9.46's currency toggle |
| CUR-GAP-002 | Display currency / Buyer Statement | Buyer Statement (renderStatement()) mixes currencies unconverted — pre-existing, out of scope for v2.9.46's currency toggle |
| SYNC-GAP-001 | Sync / data integrity | pullAll() merged Sheets rows keyed by display header, never translated back to internal field names — corrupted every pulled record and silently broke delete — Fixed v2.9.47 |
| CON-GAP-006 | Contacts / reference numbers | CSV/webform-created Contacts never get a CON-#### num — inherited from a pre-existing processImportRecords() gap, not fixed in v2.9.48 (out of scope) |

---

## Current sprint

| ID | Item | Status |
|---|---|---|
| 8 | Quote line price versioning | ✓ done (v2.9.4) |
| 9 | Xero export | ✓ done (v2.9.5) |
| 10 | Sync URL guard + status timestamp | ✓ done (v2.9.14) |
| 11 | Security fixes (XSS, pullAll crash, testConn token, PII) | ✓ done (v2.9.14) |
| 12 | Prompt caching (Layer 4) + section index (Layer 3A) + CLAUDE.md restructure (Layer 1) | ✓ done (v2.9.14) |
| 13 | AI Compliance Review mode + AI_COMPLIANCE_PROMPT | ✓ done (v2.9.26) |
| 14 | Phase 1 visual redesign — depth, radius, refined interactions | ✓ done (v2.9.26) |
| 15 | Buyer statement fixes — Total Outstanding, ISO dates, credits negative | ✓ done (v2.9.26) |
| 16 | Contacts/Leads entity — pipeline, GDPR basis, quote integration, dedup | ✓ done (v2.9.27) |
