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
