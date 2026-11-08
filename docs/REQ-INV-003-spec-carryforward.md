# REQ-INV-003 — obligations carried forward to the SPEC

**Source:** `requirements-gate` round 5 on `docs/REQ-INV-003-v6.md` returned **PASS (first clean round)** with five advisory items. They were deliberately **not** edited into v6 so that the three consecutive clean rounds the process asks for are taken against the exact same file. Each item below is **binding on the SPEC** (the `spec-gate` should check it) and the SPEC must be able to point at where each is satisfied.

| # | Applies to | Obligation |
|---|---|---|
| C1 | §3, REQ-INV-012, REQ-INV-019, REQ-INV-013 | An **absent `lineType` is treated as `'product'`**, exactly as `rILT()` (`index.html:8476`), `vInv()` (`:11049`) and `saveInv()` (`:8626`) already do. The resolver, the RAC applicability test and the cost-basis predicate's RAC clause must apply the same defaulting, so a legacy or imported line without the key cannot get an RAC from the form yet fail the predicate. |
| C2 | REQ-INV-023 (named exceptions) | Scope "no direct reads of stored `calc_*`" to **consumers that report cost or profit**. The exhaustive-search test's whitelist must also include `iCalc()`'s line-less branch (`:5589-5591`, kept by REQ-INV-017). The Cloud Data and Sheets mappers (`:5179`, `:6480`, `:6575`, `:7439`, `:8740`) and the CSV import writers (`:11363`, `:11703`) are persistence, not consumers. |
| C3 | REQ-INV-027, AC22 | Add a case: **an earlier line is removed and a later line's RAC is edited** — the audit entry must land on the correct line. This guards a positional snapshot key against misattribution. |
| C4 | REQ-INV-016, AC10 | Say "**resolving** `lid`" wherever that is meant (not merely "has a `lid`"). The intro sentence must read "catalogue-linked **or RAC-bearing** product line". State `from: none` for a first-time RAC in REQ-INV-016 and AC10, not only in REQ-INV-027. |
| C5 | AC4, REQ-INV-021 | Move AC4's RAC fixture into its own criterion (byte-identity "before and after" cannot apply to a fixture with no "before"). State the refusal outcome for **a line that already has an RAC** (the cell reverts to the prior RAC). State that editing a **dangling-`lid` line with no RAC** writes `unitCost` exactly as today. |

Nothing here changes any operator decision (Q1-Q5) or the scope of the fix.

---

## Gate result on v6 (2026-11-08)

Rounds 5, 6 and 7 on the unchanged `REQ-INV-003-v6.md` were all clean PASS (no blocking). That is three consecutive clean rounds; the requirements gate is closed. The advisories below are binding SPEC inputs (C1-C5 above still stand).

### Round 6 advisories (R6-A#)
- R6-A1 §7/REQ-INV-017: ~81 lines of `tests/run.js` touch `calc_cogs`/`calc_netProfit`, 25 touch `iCalc`; every `iCalc` test asserting stored figures for an invoice with lines must be revisited, not one test.
- R6-A2 AC16 must also list invoices whose live COGS is LOWER than stored (INV-GAP-006 class: INV10028/10031) so profit can rise; operator sees the list before sign-off.
- R6-A3 REQ-INV-015: state "only RAC, rid, updAt change"; say whether editHistory is appended; handle legacy lines with no rid as REQ-INV-016 does.
- R6-A4 Unit: RAC is recorded in the catalogue item's own currency unit today; either say so or label `Catalogue <cost>` with the item's `cur`.
- R6-A5 Scope AC13 to profit-reporting rows (buildInvLines/autoPos show unit cost, not profit).
- R6-A6 AC14: single-currency invoice set only (dashboard uses toDisp; P&L sums raw).
- R6-A7 Zero-COGS warning: state the test is simply `iCalc(inv).cogs <= 0` or keep the resolving-lid exemption explicitly.
- R6-A8 AC15 sentinel: search raw, 2dp and 3dp renderings; unique derived margin string.
- R6-A9 REQ-INV-016 correction must update/clear any open unlock snapshot, else REQ-INV-027 double-audits as `from: none`.
- R6-A10 Commit RAC on blur/change/save only, never per keystroke (extends C5).

### Round 7 advisories (R7-A#)
- R7-A1 AC19/AC23 fixtures must include `supId` (legacy dangling-lid lines have none and fail `invLineHasSupplier`); "not rejected on re-save" covers the cost gate only.
- R7-A2 REQ-INV-016 eligibility: define "credit note" (use iCalc's predicate: type credit_note, goodwill_credit, legacy `!type && isCN(num)`); state status restrictions; define behaviour when the invoice is open in the form (stale `cIL`).
- R7-A3 Add read-only display of recorded cost/RAC and editHistory in `showInvReadOnly` so a locked-invoice correction is visible.
- R7-A4 AC15: assert raw value, 2dp rendering and qty x RAC.
- R7-A5 `expCSV` uses `cInv` not `iCalc`: route through iCalc or scope AC14 to invoices with lines.
- R7-A6 REQ-INV-023 table add `get_kpis` (:12895), `rInv` COGS column (:9573), dashboard recent-invoices pane (:5779).
- R7-A7 REQ-INV-024: `persistInvChange` returns undefined on every path and ends in `refreshInvFromSupabase()`; SPEC needs a result-returning path without changing the 12+ existing callers (INV-GAP-005 interaction).
- R7-A8 REQ-INV-015(a): backup gate is the `ov-migration-backup` checkbox attestation; say so or define a verifiable signal.
- R7-A9 Split AC16 (RAC round-trip vs. figures-that-move report); name the artifact/format; no real data committed (SEC-GAP-020).
- R7-A10 Operator procedure: freeze FIRST, then edit catalogue costs (else INV10031 reprices); PO for INV10028 stays at 25 and drift check won't flag it.
- R7-A11 Same as R6-A10 (commit event).
- R7-A12 REQ-INV-017 edge: lines present but `liT === 0` (cInv falls back to stored grand/liT) - state in or out of scope.
- GDPR note: editHistory `reason` is free text that syncs to Supabase and could contain a person's name; warn in the UI.
