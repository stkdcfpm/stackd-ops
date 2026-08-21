# Requirements Tracker — Stackd Ops

Last updated: 2026-06-25 (v2.9.33 — specs gated)

---

## Active requirements

| ID | Title | Req file | Spec file | Version | Req gate | Spec gate | Build | PR |
|---|---|---|---|---|---|---|---|---|
| REQ-V3-GAP-007 | Global Event Log (`DB.events`) | REQ-V3-GAP-007-v3.md | SPEC-V3-GAP-007-v1.md | v2.9.28 | PASS | PASS | ✓ shipped | #46 |
| REQ-V3-GAP-006 | Supplier → Contact Sub-panel | REQ-V3-GAP-006-v3.md | SPEC-V3-GAP-006-v2.md | v2.9.29 | PASS | PASS | ✓ shipped | #46 |
| REQ-AI-GAP-001 | AI Order Flow Actions (narrow) | REQ-AI-GAP-001-v1.md | SPEC-AI-GAP-001-v1.md | v2.9.30 | PASS | PASS | ✓ shipped | #46 |
| REQ-DEMO-001 | End-to-End Demo Mode | REQ-DEMO-001-v2.md | SPEC-DEMO-001-v1.md | v2.9.31 | PASS | PASS | ✓ shipped | — |
| REQ-MTD-001 | MTD-Compatible VAT Export | REQ-MTD-001-v2.md | SPEC-MTD-001-v1.md | v2.9.32 | PASS | PASS | ✓ shipped | — |
| REQ-BUY-001 | Buyers / Customers Entity | REQ-BUY-001-v1.md | SPEC-BUY-001-v4.md | v2.9.37 | PASS | PASS | ✓ shipped | — |
| REQ-QTE-001 (Part A) | Per-line quote margin override | REQ-QTE-001-v3.md | SPEC-QTE-001-v2.md | v2.9.52 | CONDITIONAL PASS (3 rounds — v1: 2 findings, independent v2: 5 findings incl. 2 real bugs, v3 resolved all) | CONDITIONAL PASS (1 independent round — no blocking calc-logic bugs, citation/test-plan cleanup only) | ✓ shipped | — |
| REQ-SUP-001 | Supplier price intelligence retention & reference view | REQ-SUP-001-v2.md | SPEC-SUP-001-v2.md | v2.9.53 | CONDITIONAL PASS (v1: 4 findings, v2 resolved all) | CONDITIONAL PASS (1 independent round — no blocking defects, citation/test-plan cleanup only) | ✓ shipped | #76 |

---

## Backlog / unscoped

| ID | Title | Area | Logged | Decision |
|---|---|---|---|---|
| AI-GAP-001 (broad) | Agentic multi-step order flow | AI Assistant | v2.9.27 | Deferred v3.0.x — requires server-side proxy |
| REQ-V3-GAP-006 (ev) | Event log emissions on delCon / link / unlink | Event log + Contacts | v2.9.28 | Deferred — dependent on REQ-V3-GAP-006 shipping first; target v2.9.29+ |
| S3-1 | Demo shipment mode | Trial conversion | pre-sprint | ✓ shipped v2.9.31 |
| S3-2 | MTD-compatible VAT export | Compliance | pre-sprint | ✓ shipped v2.9.32 |
| REQ-RPT-001 G-01 | AI date filter (get_invoices, get_payments) | AI / Reporting | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G01-G04-v1.md) — target v2.9.34 |
| REQ-RPT-001 G-02 | Aging Report (0–30/31–60/61–90/90+ days, DSO) | Financial Control | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G02-G03-v1.md) — target v2.9.35 |
| REQ-RPT-001 G-03 | P&L by dimension (buyer, period) | Financial Control | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G02-G03-v1.md) — target v2.9.35 |
| REQ-RPT-001 G-04 | Quick-add COGS warning in invoice modal | Data Quality | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G01-G04-v1.md) — target v2.9.34 |
| REQ-RPT-001 G-05 | Full entity event log (Invoice, PO, Payment, Supplier) | Audit | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G05-G06-v1.md) — target v2.9.36 |
| REQ-RPT-001 G-06 | Invoice edit delta logging (old → new values) | Audit | v2.9.33 | Req gate PASS — Spec gate PASS (SPEC-RPT-001-G05-G06-v1.md) — target v2.9.36 |
| REQ-RPT-001 G-07 | Input VAT on POs + MTD Boxes 4 & 7 | Compliance | v2.9.33 | Req gate CONDITIONAL PASS — council gate required before spec, target v2.9.37 |
| REQ-RPT-001 G-08 | Intrastat report (UK → EU, 8-box CSV) | Compliance | v2.9.33 | Deferred v3.0.x — new schema required |
| REQ-RPT-001 G-09 | Supplier performance tracking (on-time %, cost variance) | Operational | v2.9.33 | Deferred v3.0.x |
| REQ-RPT-001 G-10 | HS code duty recalculation on existing invoices | Data Integrity | v2.9.33 | Deferred v3.0.x |
| REQ-QTE-001 (Part B) | RFQ supplier comparison & commit (landed-value ranking) | Quote Engine / Sourcing | v2.9.52 | Req gate: v1 CONDITIONAL PASS (5 findings) → v2 CONDITIONAL PASS, independent round (staleness-warning logic bug, Contact-delete orphaning gap, wrong hand-off function named/scope understated, Part A×B interaction undefined, 1 citation error) → v3 resolves all, per `REQ-QTE-001-v3.md`. **Part A shipped v2.9.52** (see Active requirements above). Spec not yet started for Part B — deliberately deferred until Part A shipped, per the REQ's own staged-build recommendation; now unblocked. |
| REQ-AI-GAP-002 | Invoice/Line Item/Credit Note AI creation + Supplier/Buyer read tools | AI Assistant | v2.9.52 | Req gate: v1 independent CONDITIONAL PASS (1 blocking — `create_line_item`'s stated minimum fields didn't match `vLI()`'s real validation, only Description+Supplier are actually required, not Cost/UOM too; 2 advisory) → v2 (`REQ-AI-GAP-002-v2.md`) resolves all. Closes `AI-GAP-006`/`AI-GAP-008`/`AI-GAP-009`. FM-1 category-1, no council decision needed. Spec gate: `SPEC-AI-GAP-002-v1.md` → independent review **PASS** (1 advisory citation error) → `SPEC-AI-GAP-002-v2.md` fixes it. **Ready for build-gate.** |
| REQ-CON-004 | AI-assisted enquiry intake check | Contacts / AI Assistant | v2.9.52 | Req gate: v1 independent CONDITIONAL PASS (1 advisory but real — the `ORD_GAP_CHECK_PROMPT` precedent is safe by construction there, not automatically here, since the Contact form has PII fields directly adjacent to the enquiry field being read) → v2 (`REQ-CON-004-v2.md`) mandates the defensive payload-construction technique explicitly rather than asserting the precedent transfers for free. FM-1 category-1. Spec gate: `SPEC-CON-004-v1.md` → independent review **CONDITIONAL PASS** (1 blocking — missing mandatory `AI_SYSTEM_PROMPT` update per `CLAUDE.md`; 1 advisory citation error) → `SPEC-CON-004-v2.md` resolves both (a confirmatory re-check caught and fixed one further off-by-one citation in the new content). **Ready for build-gate.** |
| REQ-SUP-001 | Supplier price intelligence retention & reference view | Supplier Intelligence / R-007 | v2.9.53 | **Built and shipped v2.9.53** — see Active requirements above. `getSupplierPriceHistory()`/`supPriceStaleness()`/`getProductPriceHistory()`/`renderSupPriceHistory()` added byte-for-byte per `SPEC-SUP-001-v2.md`; Price History panel wired into `openSup()`/`editSup()`; new Settings → Supplier Intelligence threshold control. 10 new tests, 454/454 passing. **Build-gate: independent review PASS** — every function/HTML/wiring change verified byte-for-byte against spec, tests confirmed real and passing; 2 advisory-only notes (a "9 vs 10 new tests" documentation undercount, since fixed, and a pre-existing spec-approved input-validation gap on the threshold setting — negative values aren't guarded, cosmetic-only impact in this trusted single-operator app). |

---

## Gate pipeline

```
requirements-gate → spec-gate → build-gate → security-gate
```

- **requirements-gate** — verifies requirement is complete, unambiguous, testable; flags GDPR/FPM risks
- **spec-gate** — verifies spec covers all ACs, is implementable without design decisions
- **build-gate** — post-build review of index.html changes against spec
- **security-gate** — run before any release to main

---

## FM-1 exception register

All active requirements have FM-1 clearance. See STACKD_CONTEXT.md for full exception text.

| Item | Scope | Approved |
|---|---|---|
| 1 | UI/AI layer features with no new localStorage entities | 2026-06-21 |
| 2 | New fields on existing entities (e.g. supplierId, role on DB.con) | 2026-06-21 |
| 3 | New internal-only K key / DB entity with no Sheets sync (K.ev / DB.events) | 2026-06-21 |
| 4 | Live external database dependency for Suppliers + Buyers only (`REQ-CLOUD-001`, Supabase) — scope-specific, not a general category; condition: mandatory backed-up/rollback-verified migration (see `REQ-CLOUD-001-v3.md`) | 2026-08-21 |
