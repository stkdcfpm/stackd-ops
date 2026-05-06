# Stackd Ops — Claude Code Context

## What this project is
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies. Deployed via GitHub Pages.

**Current version: v2.9.6**  
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

```js
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt }         // all entity arrays
let EI = { s, l, i, p, sh, qt }                        // currently-editing ID (null = new)
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
- **Async save functions** are called fire-and-forget from `onclick`. `syncEnt`/`delEnt` have internal try/catch — chain `.catch(function(){})` on all calls for consistency (see lines ~2292, ~4455, ~4483).

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

## Version history

| Version | Highlights |
|---|---|
| v2.9.6 | Brand lockup — Rajdhani 700 wordmark, JetBrains Mono tagline, D in #C8312E, HR rule; drops SVG container mark |
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

- **This file** — bump Current version, update Test count, add row to Version history, add any new Known gaps, tick off sprint items
- **`docs/known-gaps.md`** — add new gap entries as they are identified

---

## Current sprint

| ID | Item | Status |
|---|---|---|
| 8 | Quote line price versioning | ✓ done (v2.9.4) |
| 9 | Xero export | ✓ done (v2.9.5) |

---

---

# Agent Architecture & Delivery Framework

## Overview

This project uses a Claude Code subagent system to enforce quality gates across the delivery pipeline. Agents are independent reviewers — they do not write code or make decisions. They verify exit criteria and log evidence.

**Agent files live in:** `.claude/agents/`
**Scope:** Project-level (scoped to stackd-ops only)
**Audit trail:** Notion (via MCP when connected)

---

## Delivery pipeline

Every feature or change must pass through these stages in order:

```
Requirement → Spec → Build → Security → QA → Release
```

No stage is skipped. No gate is bypassed. A CRITICAL issue from any gate is a hard block.

---

## Active agents (Phase 1 — build first)

| Agent | Role | Tools | Status |
|---|---|---|---|
| `requirements-gate` | Verifies requirements are complete, unambiguous, testable. Flags GDPR implications. | Read only | Build |
| `spec-gate` | Reviews technical spec against requirement. Checks data model, API contracts, GDPR data flows. | Read only | Build |
| `build-gate` | Code review against spec. Flags deviations as defects. Severity: CRITICAL / MAJOR / MINOR. | Read, Grep | Build |
| `security-gate` | GDPR PII handling, OWASP, auth, secrets, CVEs. Hard block on release if critical issues found. | Read, Grep | Build |
| `schema-migration-reviewer` | Reviews any future DB/storage migration scripts. Flags destructive ops and missing rollbacks. | Read only | Build |

---

## Planned agents (Phase 2 — when Phase 1 is stable)

| Agent | Role |
|---|---|
| `requirements-analyst` | Breaks feature requests into functional + non-functional requirements |
| `data-modeller` | Conceptual → logical → physical data modelling, ERDs |
| `spec-writer` | Turns rough feature ideas into full technical specs |
| `qa-gate` | Verifies tests exist and pass for every acceptance criterion |
| `release-planner` | Reads commits since last tag, produces structured release notes |
| `release-gate` | Final independent check before any release. Produces release evidence document. |

---

## Gate exit criteria

| Stage | Gate agent | Exit criteria | Evidence output |
|---|---|---|---|
| Requirement | `requirements-gate` | Complete, unambiguous, testable. GDPR implications flagged. | Signed-off requirement → Notion |
| Specification | `spec-gate` | Data model, API contracts, edge cases, GDPR data flows defined. | Spec approval / gaps listed → Notion |
| Build | `build-gate` | Code matches spec. No unresolved CRITICALs. | Code review report → Git PR |
| Security | `security-gate` | GDPR PII verified. OWASP passed. No critical CVEs. | Security clearance report → Notion |
| QA | `qa-gate` | All acceptance criteria tested and passing. Coverage threshold met. | Test evidence report → Notion |
| Release | `release-gate` | All prior gates passed and logged. Release evidence document produced. | Release artefact → Notion + Git tag |

---

## Stackd-ops specific agent behaviour

- **`build-gate`** must reference `index.html` as the single source file. Flag any suggestion to split into multiple files as out of scope unless a sprint item explicitly covers architecture change.
- **`security-gate`** must check: `san()` usage on all user-supplied strings in `innerHTML`, no PII written to `localStorage` beyond operational necessity, no secrets or API keys in source.
- **`schema-migration-reviewer`** applies to `localStorage` key changes — treat any rename, removal, or restructure of `K` keys as a migration requiring backward-compatibility check and `ldArr` safety verification.
- **`requirements-gate`** — for FPM domain: flag any requirement that touches freight rate calculation, duty, or quote versioning for extra scrutiny. These are high-risk calculation chains.

---

## Agent operating rules

1. **Agents are read-only by default.** Only grant Write or Bash access where explicitly justified.
2. **Every gate produces a logged evidence record.** An outcome in chat only is not an audit trail.
3. **CRITICAL = hard block.** Nothing proceeds until resolved and gate re-run.
4. **Agents do not write code.** If an agent starts writing implementation, the system prompt is wrong.
5. **Do not build Phase 3 agents speculatively.** Build when a specific recurring pain justifies it.

---

## Git convention

Use conventional commits tied to requirement IDs:

```
feat(REQ-042): implement consent capture flow
fix(REQ-037): correct duty calculation for DG freight
test(REQ-042): add acceptance tests for consent flow
```

This binds every commit to a traceable requirement for audit purposes.

---

## GDPR surface (stackd-ops specific)

- Supplier contact data stored in `localStorage` — minimise fields, no sensitive categories
- Quote and invoice data may contain commercially sensitive pricing — treat as confidential
- No user authentication currently — access control is environmental (GitHub Pages, private repo)
- Any future feature touching PII must be flagged at `requirements-gate` before spec work begins
