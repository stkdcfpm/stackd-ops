# Requirements Tracker — Stackd Ops

Last updated: 2026-08-23 (v2.9.57 — DATA-002 shipped, merged to main)

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
| REQ-CLOUD-001 | Supabase-backed shared data layer (Suppliers + Buyers only) | REQ-CLOUD-001-v3.md | SPEC-CLOUD-001-v4.md | v2.9.54 | CONDITIONAL PASS (v1→v2, council decision APPROVED recorded in v3, conditioned on verified backup/rollback) | 4 independent rounds (v1 FAIL 5 blocking → v2 FAIL 5 new blocking → v3 FAIL 1 blocking → v4 PASS, 2 advisory only) | ✓ shipped — build-gate round 1 found a real `pullAll()` Sheets-pull-back race + 2 re-entrancy bugs + a skipped test-conversion deliverable, fixed in v2.9.54 follow-up (PR #80, since PR #79 was merged before the fixes landed); round-2 build-gate review pending | #79, #80 |
| REQ-AI-GAP-002 | Invoice/Line Item/Credit Note AI creation + Supplier/Buyer read tools | REQ-AI-GAP-002-v2.md | SPEC-AI-GAP-002-v2.md | v2.9.55 | CONDITIONAL PASS (v1: 1 blocking on `create_line_item` min-fields, v2 resolved) | PASS (v1: 1 advisory citation error, v2 resolved) | ✓ shipped — build-gate independent review **PASS**: every field mapping/validation guard traced correctly to `vLI()`/real invoice line-item shape/`openNewCN()`; PII-minimization on `get_suppliers`/`get_buyers` confirmed structurally true, not just conventional. 1 advisory finding (the "Review in [Form]" `actionLabels` map wasn't extended for the 3 new action types, rendering raw action keys) fixed same-day. Closes AI-GAP-006/AI-GAP-008/AI-GAP-009 (known-gaps.md updated to reflect closure, corrects a doc-staleness gap the reviewer also caught). | #81 |
| REQ-CON-004 | AI-assisted enquiry intake check | REQ-CON-004-v2.md | SPEC-CON-004-v2.md | v2.9.55 | CONDITIONAL PASS (v1: 1 advisory-but-real PII-adjacency finding, v2 resolved) | CONDITIONAL PASS (v1: 1 blocking missing `AI_SYSTEM_PROMPT` update + 1 advisory citation error, v2 resolved) | ✓ shipped — build-gate independent review **PASS**, no issues found: `conCheckEnquirySemantic()` confirmed byte-for-byte contract-identical to `ordCheckLineGapsSemantic()`; PII-scoped payload confirmed via a real test parsing the actual outbound fetch body. | #81 |
| REQ-QTE-001 (Part B) | RFQ supplier comparison & commit (landed-value ranking) | REQ-QTE-001-v3.md | SPEC-QTE-001-partB-v2.md | v2.9.56 | CONDITIONAL PASS (3 rounds, carried over from Part A gating — v1: 5 findings, independent v2: staleness-warning bug/Contact-orphaning gap/wrong hand-off citation/Part A×B interaction undefined, v3 resolves all) | CONDITIONAL PASS (independent v1: 1 blocking — `ordConvertToQuote()` hand-off dropped REQ-QTE-001l's required currency conversion, silently corrupting downstream Quote math for non-USD responses; 1 citation error; 2 advisory — CBM-optionality undermining the "apples-to-apples" claim, hardcoded `qty:1` ignoring an already-in-scope `baseQty` — v2 resolves all, confirmed by an independent confirmatory re-review, PASS) | ✓ shipped — build-gate independent review **PASS**, no issues found: currency-conversion math traced with a worked example (RMB 700 → correctly non-identity-converted, not the raw number) and confirmed against a real independently-computed test assertion; `delSup()`'s warn-count confirmed to apply to both the Supabase and local branches from a single pre-split computation; all field guards/defensive-init, modal HTML, and doc consistency verified byte-for-byte. | #82 |
| REQ-DATA-002 | Data Integrity Cleanup (phantom record removal & safe renumbering) | REQ-DATA-002-v2.md | SPEC-DATA-002-v2.md | v2.9.57 | CONDITIONAL PASS → PASS (v1: 2 blocking — Contacts self-healed by `backfillConIds()` into id-bearing-but-blank zombies, defeating a plain `!id` check; wrong/incomplete FK-field list (`buyId`→`buyerId`, missing `lid`/`sourceContactId`) — v2 resolves both, confirmed by an independent confirmatory re-review, PASS) | CONDITIONAL PASS → PASS (independent v1: 3 blocking — incomplete Quote-line `lid` FK check; missing REQ-mandated sort-stability comment; `logEv()` audit-trail used a raw DB-key abbreviation + `'bulk'` placeholder id instead of the app's real per-record Activity-tab convention, meaning a renumbered Supplier/Contact would never show it in its own Activity tab — v2 resolves all three, confirmed by an independent confirmatory re-review, PASS) | ✓ shipped — `isPhantomRecord()`/`scanForPhantomRecords()`/`renumberEntitySequentially()`/`verifyFkIntegrityAfterCleanup()`/`executeDataCleanup()` + parallel backup-gate modal + `pullAll()` id-keyed-entity hardening. One pre-existing test's expectations updated to match the corrected `pullAll()` behavior. 15 new tests. 521/521 pass. Build-gate independent review **CONDITIONAL PASS** — no blocking findings (build confirmed a faithful, correct implementation of every spec'd function/modal/gate/FK-check across all 10 verification points); 1 advisory finding (this row's "17 new tests" was miscounted, corrected to 15) plus 2 cosmetic wording deviations from the spec's literal modal-copy suggestions, both fixed same-day, prior to merge. | #84 (docs), #85 (build) |

---

## Backlog / unscoped

| ID | Title | Area | Logged | Decision |
|---|---|---|---|---|
| AI-GAP-001 (broad) | Agentic multi-step order flow | AI Assistant | v2.9.27 | Deferred v3.0.x — requires server-side proxy |
| REQ-V3-GAP-006 (ev) | Event log emissions on delCon / link / unlink | Event log + Contacts | v2.9.28 | **✓ closed v2.9.56.** `delCon()`'s emission (the only part `REQ-V3-GAP-006-v3.md` actually deferred) was found already implemented when checked against the live code — `link`/`unlink` emissions were never a formally-gated requirement (only present in this backlog row's own description), added as a small, proportionate fix mirroring the already-established `logEv()` pattern rather than run through a full REQ/SPEC cycle. |
| S3-1 | Demo shipment mode | Trial conversion | pre-sprint | ✓ shipped v2.9.31 |
| S3-2 | MTD-compatible VAT export | Compliance | pre-sprint | ✓ shipped v2.9.32 |
| REQ-RPT-001 G-01 | AI date filter (get_invoices, get_payments) | AI / Reporting | v2.9.33 | **✓ shipped v2.9.34** (SPEC-RPT-001-G01-G04-v1.md) — tracker row corrected 2026-08-22, previously left showing "target v2.9.34" after shipping; see `docs/version-history.md` v2.9.34. |
| REQ-RPT-001 G-02 | Aging Report (0–30/31–60/61–90/90+ days, DSO) | Financial Control | v2.9.33 | **✓ shipped v2.9.35** (SPEC-RPT-001-G02-G03-v1.md) — tracker row corrected 2026-08-22; see `docs/version-history.md` v2.9.35. |
| REQ-RPT-001 G-03 | P&L by dimension (buyer, period) | Financial Control | v2.9.33 | **✓ shipped v2.9.35** (SPEC-RPT-001-G02-G03-v1.md) — tracker row corrected 2026-08-22; see `docs/version-history.md` v2.9.35. |
| REQ-RPT-001 G-04 | Quick-add COGS warning in invoice modal | Data Quality | v2.9.33 | **✓ shipped v2.9.34** (SPEC-RPT-001-G01-G04-v1.md) — tracker row corrected 2026-08-22; see `docs/version-history.md` v2.9.34. |
| REQ-RPT-001 G-05 | Full entity event log (Invoice, PO, Payment, Supplier) | Audit | v2.9.33 | **✓ shipped v2.9.36** (SPEC-RPT-001-G05-G06-v1.md) — tracker row corrected 2026-08-22; see `docs/version-history.md` v2.9.36. |
| REQ-RPT-001 G-06 | Invoice edit delta logging (old → new values) | Audit | v2.9.33 | **✓ shipped v2.9.36** (SPEC-RPT-001-G05-G06-v1.md) — tracker row corrected 2026-08-22; see `docs/version-history.md` v2.9.36. |
| REQ-RPT-001 G-07 | Input VAT on POs + MTD Boxes 4 & 7 | Compliance | v2.9.33 | Req gate CONDITIONAL PASS — council gate required before spec (`REQ-RPT-001-v1.md` §G-07). **Decision 2026-08-22: deferred to v3.0.x, council gate not run.** Boxes 4 & 7 remain operator responsibility (MTD-GAP-001, per `STACKD_CONTEXT.md`'s existing framing) — a live, real recurring VAT-reclaim under-claim, but building input-VAT tracking now against a single-file, no-server, no-audit-trail-beyond-`DB.events` stack was judged higher-risk than the value of closing it ahead of the v3.0 Supabase migration, where server-side validation and a proper audit trail make this materially safer to get right. Revisit as part of v3.0.x planning rather than late in the v2.9.x line. |
| REQ-RPT-001 G-08 | Intrastat report (UK → EU, 8-box CSV) | Compliance | v2.9.33 | Deferred v3.0.x — new schema required |
| REQ-RPT-001 G-09 | Supplier performance tracking (on-time %, cost variance) | Operational | v2.9.33 | Deferred v3.0.x |
| REQ-RPT-001 G-10 | HS code duty recalculation on existing invoices | Data Integrity | v2.9.33 | Deferred v3.0.x |
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
