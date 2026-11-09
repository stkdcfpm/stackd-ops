# REQ-RPT-003 — Accounting Export reads real invoice line shape (v1)

**Status:** DRAFT for requirements-gate · **Owner:** Carms · **Drafted:** 2026-11-09 · **Baseline:** `main` @ `ecfa6cb` (v2.9.95), 1111/1111 tests
**Gap IDs:** ACCT-GAP-002 (modal never opens), ACCT-GAP-003 (line-shape mismatch), ACCT-GAP-004 (opens only if cost drift is found on real data), RPT-GAP-001 (entry-point test coverage audit, log only)
**IDs checked against:** `docs/requirements-tracker.md`, `docs/known-gaps.md`, `STACKD_CONTEXT.md`, and every `docs/REQ-*`/`SPEC-*` filename on `main`. The external Requirements Tracker Sheet could not be read in this session; the writer must re-confirm the IDs there before the tracker rows are appended.

## 1. Problem (all verified by reproduction on `main`, 2026-11-09)

**D-1 — the modal never opens.** `openAcctExport()` (`index.html:13430`) ends with `openM('ov-acct-exp')` (`index.html:13443`). `openM` is not defined anywhere in the file and that is its only use. `openAcctExport('inv')` and `openAcctExport('pmt')` both throw `ReferenceError: openM is not defined`. Entry points: Invoices tab button (`index.html:315`) and Payments view button (`index.html:15734`). Working report modals use `G('ov-xxx').classList.add('on')` (`index.html:9484`, `:9633`, `:9750`). `closeM` exists (`index.html:5437`), so this is a typo-class miss, not a removed helper.

**D-2 — exporters read a line shape the app never saves.** `acctInvCSV` (`:13314`), `acctXeroCSV` (`:13360`), `acctQBCSV` (`:13383`) and `acctQualityCheck` (`:13416`) iterate `inv.lines` and read `l.cu`/`l.sku`. `saveInv()` writes `inv.lineItems` with `{rid,lid,desc,uom,qty,up,unitCost,lineType[,supId]}` (`index.html:8637`). Reproduced: a two-line real-shape invoice yields 0 data rows in Generic CSV, Xero and QB, and `acctQualityCheck`'s zero-value-line warning never fires. `acctInvJSON` (`:13352`) dumps whole invoices and is unaffected.

**D-3 — no format is pre-selected.** None of the five `name="acct-fmt"` radios is checked (`index.html:1073`-`1077`); Download with nothing ticked shows only a "Select a format" toast. Xero/QB are invoices-only and FreeAgent is payments-only but nothing stops or explains the wrong pairing except a late toast.

**Why tests missed both:** tests exercise the pure formatters with fixtures in the `lines`/`cu` shape (`tests/run.js:1607`-`1727`); nothing calls `openAcctExport` or `doAcctExport`. Same defect class as PO-GAP-005.

## 2. Decisions already taken by Carms (2026-11-09)

| ID | Decision |
|---|---|
| D1 | Export **both** `Unit Cost (stored on line)` and `Unit Cost (catalogue now)`; exported line COGS follows the app's existing rule. Open ACCT-GAP-004 if drift is found on any real invoice. |
| D2 | **Demo records are excluded completely** from every export. **Cancelled invoices are retained** for full transparency, with upstream exclusion left to the consumer. Credit notes and goodwill credits: behaviour unchanged (see REQ-3.5). |
| D3 | Add `Line Type` and `Supplier` to the Generic CSV only. |
| Parity | The acceptance test compares against `cInv()`'s live COGS, and separately reports every invoice where the displayed (`iCalc()`) figure differs. |

## 3. Requirements

**REQ-RPT-003-1 (modal opens).** `openAcctExport(entity)` opens `ov-acct-exp` by adding class `on` (the pattern of the other report modals). No `openM` helper is added. Both entry points open the modal with no console error.

**REQ-RPT-003-2 (default format and entity-aware options).**
- 2.1 Each time the modal opens, Generic CSV is selected, regardless of any earlier choice.
- 2.2 Format options that do not apply to the selected entity are disabled, with a visible reason: Xero and QuickBooks for Payments; FreeAgent for Invoices. Changing the Entity dropdown inside the open modal re-evaluates this, and if the currently selected format becomes disabled the selection returns to Generic CSV.
- 2.3 The "Unsupported format for this entity" toast remains as a backstop.
- 2.4 No other redesign of the modal.

**REQ-RPT-003-3 (line shape).** Every invoice exporter and `acctQualityCheck` iterate `inv.lineItems`; they fall back to legacy `inv.lines` only when `lineItems` is absent (not merely empty). The unit-cost field read is `unitCost`, falling back to `cu` only for a legacy-shape line. Applies to all four sites in D-2; the writer must grep the whole file for any other invoice-level `inv.lines` consumer and report the result (current result: none outside these four; the remaining `.lines` hits are Order Request and Quote lines).

**REQ-RPT-003-4 (SKU).** SKU is resolved from the catalogue (`DB.li` by `lid`). If `lid` is blank or does not resolve, SKU is empty. A SKU is never invented. A legacy line carrying its own `sku` may use it only when `lid` does not resolve.

**REQ-RPT-003-5 (cost basis, Generic CSV).**
- 5.1 Per-line COGS uses the same rule as `cInv()`'s live path (`index.html:5440`): catalogue cost when `lid` resolves (any `lineType`), otherwise the line's `unitCost`.
- 5.2 The Generic CSV gains `Unit Cost (stored on line)` (the line's `unitCost`) and `Unit Cost (catalogue now)` (catalogue cost, empty when `lid` does not resolve), so drift is visible per line. Existing columns keep their relative order; new columns are appended at the end, together with `Line Type` and `Supplier` (REQ-6).
- 5.3 A line with no `unitCost` key and no resolving `lid` (legacy/imported, the case `cInv()` covers via stored `calc_cogs`) exports empty cost columns and COGS `0.00` and is counted as a parity exception, not silently zeroed (REQ-8).
- 5.4 `iCalc()`, `cInv()`, `calc_cogs` and `repairCalcFields` are not modified.

**REQ-RPT-003-6 (extra columns).** Generic CSV only: `Line Type` (`lineType`, default `product` when absent) and `Supplier` (supplier name resolved from `line.supId` via `DB.sup`; empty if unresolved). Xero and QuickBooks formats gain no columns.

**REQ-RPT-003-7 (record selection, D2).**
- 7.1 Records with `_demo` are excluded from all invoice and payment exports, in every format including JSON. Payments whose own `_demo` flag is set, or whose invoice is `_demo`, are excluded.
- 7.2 Cancelled invoices are included in all invoice exports with their `Status` visible in Generic CSV and JSON. Xero and QuickBooks formats have no status column; that limitation is disclosed in the release note and the user guide, not worked around.
- 7.3 Credit notes and goodwill credits remain in `DB.inv`-based exports exactly as today. They have empty `lineItems`, so they yield no line rows in the line-level CSVs and appear in JSON. No behaviour change.
- 7.4 "No invoices/payments to export" is evaluated after demo exclusion, so a demo-only dataset shows the empty toast.
- 7.5 `acctQualityCheck`'s warnings are computed over the same filtered set as the export, so a demo record never produces a warning.

**REQ-RPT-003-8 (COGS parity report).** For every exportable invoice, the sum of exported line COGS equals `cInv(inv).cogs` (to 2 dp). The test suite and the delivery note report each invoice where (a) that fails, with the reason, and (b) `iCalc(inv).cogs` differs from `cInv(inv).cogs` (stored `calc_cogs` preferred at `index.html:5593`). Mismatches are explained, never hidden. Real data is never committed (SEC-GAP-020); the report is produced in the delivery note from the operator's own export or demo data only.

**REQ-RPT-003-9 (no data-model change).** No change to storage keys, to the invoice record, or to any Cloud Data/Supabase surface. Export is read-only.

## 4. Out of scope
Payments export content and format logic (only the broken entry point and format-availability UI), VAT exports, the P&L CSV, any change to `calc_cogs`/`repairCalcFields`/COGS formula, Supabase work, the credit-note-vs-net-profit formula, and fixing other reports' coverage gaps (RPT-GAP-001 is logged only).

## 5. Acceptance criteria
- **AC1** `openAcctExport('inv')` and `('pmt')` do not throw and `ov-acct-exp` has class `on` (fails on current `main`).
- **AC2** Opening with a previously chosen non-default format resets to Generic CSV; changing Entity disables inapplicable formats and falls back to Generic CSV when needed.
- **AC3** With the default selected, `doAcctExport()` produces a download (via `dlText`) with no extra clicks.
- **AC4** A real-shape invoice (`lineItems`/`unitCost`/`lid`) gives one row per line in Generic CSV, Xero and QuickBooks; JSON contains `lineItems`; payments with `fa` and `generic-csv` each produce a download.
- **AC5** SKU resolves via catalogue; blank for unlinked line.
- **AC6** Per-line COGS equals `cInv()`'s per-line rule for a catalogue-linked line, an unlinked line, and a pass-through line (both with and without a `lid`); the two new unit-cost columns show the stored and catalogue values.
- **AC7** A legacy-shape invoice (`lines`/`cu`) still exports (fallback), including `acctQualityCheck`.
- **AC8** An invoice built through the real `saveInv()` path exports line rows.
- **AC9** Demo invoices and demo payments never appear in any format; cancelled invoices do; credit notes behave as today.
- **AC10** Parity test: sum of exported line COGS equals `cInv().cogs` for catalogue-linked, unlinked and pass-through fixtures and for every `loadDemoData()` invoice; the iCalc-vs-cInv difference list is produced.
- **AC11** Mutation tests: reverting the shape fix fails AC4/AC8; reverting the opener fix fails AC1; reverting demo exclusion fails AC9.
- **AC12** All 1111 existing tests still pass, none weakened (the rewritten `acctInvCSV`/Xero/QB fixtures are replaced by real-shape ones; one legacy-shape test is retained). Final count reported against baseline.
- **AC13** Manual real-browser check: both entry buttons open the modal; with Demo Mode loaded, Generic CSV, Xero and QB each export; first three data rows are pasted in the delivery note. Note: with demo excluded (REQ-7.1) the demo dataset itself will export nothing, so the manual check must use at least one non-demo invoice saved through the form (operator-created test invoice, deleted afterwards).

## 6. Flags
- **FPM domain risk:** LOW. No quote engine, freight, duty, or COGS-formula change. Output only.
- **GDPR:** the export already contains buyer name/address/email-adjacent fields and is saved by the operator to their own device via a data-URI download. No new data flow, no transmission, no new fields about natural persons. Supplier names are business data. Real exports must not be committed to the public repo.
- **Version/doc obligations:** version bump (v2.9.96, which pushes the not-yet-merged sort/filter branch to v2.9.97), all three hardcoded version strings, `AI_SYSTEM_PROMPT`, in-app changelog, `docs/version-history.md`, `docs/user-guide.md` (Accounting Export section: default format, disabled options, new columns, demo/cancelled behaviour), `docs/known-gaps.md`, `CLAUDE.md`, `STACKD_CONTEXT.md` backlog, tracker rows.

## 7. Process note for reviewers (explicit request)
Both defects shipped because tests covered pure formatters but not the user-facing entry point, and used fixtures unlike saved data. Reviewers: confirm no other export/report with a modal opener is silently in the same state. Observed on `main`: `openAgingReport`, `openPLReport` and `expCSV` have zero direct test calls in `tests/run.js`; `expAll` has one; the VAT report opener is `openVATReturn` (`index.html:9477`, modal opened at `:9484`), which the reviewer must check for entry-point coverage too. These are logged as **RPT-GAP-001** and are **not fixed** in this brief.
