# REQ-RPT-003 — Accounting Export reads real invoice line shape (v2)

**Status:** DRAFT v2 for requirements-gate (v1 round 1: FAIL, 3 blocking B1-B3 + advisories A1-A10, all verified against code and resolved below; clean-round count restarts at 0) · **Owner:** Carms · **Drafted:** 2026-11-09 · **Baseline:** `main` @ `ecfa6cb` (v2.9.95), 1111/1111 tests
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
- 2.2 Format options that do not apply to the selected entity are disabled, with the reason in the option's `title` tooltip and its label text (the existing 'Invoices only' / 'Payments only' wording is kept): Xero and QuickBooks for Payments; FreeAgent for Invoices. Changing the Entity dropdown inside the open modal re-evaluates this, and if the currently selected format becomes disabled the selection returns to Generic CSV.
- 2.3 The "Unsupported format for this entity" toast remains as a backstop.
- 2.4 No other redesign of the modal.

**REQ-RPT-003-3 (line shape).** Every invoice exporter and `acctQualityCheck` iterate `inv.lineItems`; they fall back to legacy `inv.lines` only when `lineItems` is absent (not merely empty). The unit-cost field read is `unitCost`, falling back to `cu` only for a legacy-shape line. Applies to all four sites in D-2; the writer must grep the whole file for any other invoice-level `inv.lines` consumer and report the result (current result: none outside these four; the remaining `.lines` hits are Order Request and Quote lines).

**REQ-RPT-003-4 (SKU).** SKU is the catalogue SKU when `lid` resolves in `DB.li`. If `lid` is blank or unresolved: a line read from the legacy `inv.lines` array may use its own `sku`; any other line exports an empty SKU. A SKU is never invented. ("Legacy" means only a line taken from the `lines` fallback array; demo-shaped lines are out of scope, see REQ-7.6.)

**REQ-RPT-003-5 (cost basis, Generic CSV).**
- 5.1 Per-line COGS uses the same rule as `cInv()`'s live path (`index.html:5440`): catalogue cost when `lid` resolves (any `lineType`), otherwise the line's `unitCost` (absent key counts as 0, exactly as `cInv()`'s `cogsLive` does).
- 5.2 The Generic CSV gains `Unit Cost (stored on line)` (the line's `unitCost`, empty if the key is absent) and `Unit Cost (catalogue now)` (catalogue cost, empty when `lid` does not resolve), so drift is visible per line. Existing columns keep their relative order; the new columns are appended at the end, followed by `Line Type` and `Supplier` (REQ-6).
- 5.3 `cInv()` also has an invoice-level fallback (`index.html:5488`-`5494`): when NO line resolves a `lid` and NO line has a `unitCost` key, it uses the stored `calc_cogs`. For such an invoice the per-line COGS values are all `0.00` and cannot sum to `cInv().cogs`; this is a "stored-COGS exception" handled by REQ-8, never silently zeroed.
- 5.4 `iCalc()`, `cInv()`, `calc_cogs` and `repairCalcFields` are not modified.

**REQ-RPT-003-6 (extra columns).** Generic CSV only: `Line Type` (`lineType`, default `product` when absent) and `Supplier` (`line.supId` resolved to a supplier name via `DB.sup`; if the line has no `supId`, the catalogue entry's `supId` is the fallback; empty if still unresolved). Xero and QuickBooks gain no columns.

**REQ-RPT-003-7 (record selection, D2).**
- 7.1 **Where the filter lives.** One new pure function `acctExportSets()` returns the filtered `{invoices, payments}` and is the single source for `openAcctExport()` (warnings), `doAcctExport()` (all formats, including JSON) and the "nothing to export" checks. The formatters (`acctInvCSV`, etc.) stay pure and take already-filtered arrays, so tests can drive them directly and drive the filter through `acctExportSets()`.
- 7.2 **Demo identification.** An invoice or payment is demo if its `_demo` flag is truthy OR its immutable `id` starts with `demo-`. The id test is required because `saveInv()` does not carry `_demo` forward on re-save (open INV-GAP-012; probed: `_demo` appears nowhere in `saveInv()`), whereas `saveInv()` preserves `id`. A payment is demo if it is demo itself or its invoice is demo, where the invoice is resolved with `getInvPayments()`'s rule (`invId` first, `invNum` fallback; `index.html:15504`). Payments are matched to invoices in the exporters and quality check with that same rule, replacing the current `invId`-only lookups.
- 7.3 Cancelled invoices are included in all invoice exports; `Status` is visible in Generic CSV and JSON. Xero and QuickBooks have no status column, so a cancelled invoice would import there as a live receivable; the modal shows a one-line notice (when Xero or QuickBooks is selected) that cancelled invoices are included and must be excluded in the accounting package, and the same caveat goes in the release note and user guide.
- 7.4 **Credit notes and goodwill credits** (`type` credit_note/goodwill_credit, or legacy `!type && isCN(num)`): today they yield no line rows in any line-level CSV, and that is preserved by skipping them explicitly in `acctInvCSV`/`acctXeroCSV`/`acctQBCSV`, whether or not a given record happens to carry `lineItems` (a credit note saved through the invoice form can). They still appear in JSON. `cInv()` returns COGS 0 for them, so they are outside the parity rule.
- 7.5 **Invoices with no `lineItems`** (CSV-imported invoices keep `lineItems: []` plus stored `calc_*` figures, `index.html:11369`, `:11408`, `:11709`, `:11758`) produce no line rows. This is not silent: `acctQualityCheck` gains a warning "Invoice X: no line items, not included in line-level CSV exports", and the delivery note counts them.
- 7.6 "No invoices/payments to export" is evaluated after the filter, so a demo-only dataset shows the empty toast. Demo-shaped lines (`price`/`cost`/`sku` keys, `DINV-0001`) are not read by any exporter and are explicitly out of scope: demo data never reaches an export.
- 7.7 `acctQualityCheck` runs over the filtered sets, ignores credit-note/goodwill records for its Incoterm/Payment-Terms/no-payment warnings, matches payments with the REQ-7.2 rule, and is recomputed when the Entity dropdown changes (invoice-level warnings show for Invoices, payment-related for Payments).

**REQ-RPT-003-8 (COGS parity report).** For every exportable invoice that has at least one line and is not a REQ-7.4 record, `sum(exported line COGS)` must equal `cInv(inv).cogs`, compared within a tolerance of `0.005 x line count` (per-line `toFixed(2)` rounding). The test fails on any mismatch except an invoice classed as a stored-COGS exception (REQ-5.3), which is reported, not failed. The delivery note lists separately (a) every stored-COGS exception, (b) every no-line invoice (REQ-7.5), and (c) every invoice whose displayed `iCalc(inv).cogs` differs from `cInv(inv).cogs`, each with the reason. Real data is never committed (SEC-GAP-020); the report is produced from the operator's own data in the delivery note only, and from synthetic fixtures in the tests.

**REQ-RPT-003-9 (no data-model change).** No change to storage keys, to the invoice record, or to any Cloud Data/Supabase surface. Export is read-only.

## 4. Out of scope
Payments export content and format logic (only the broken entry point and format-availability UI), VAT exports, the P&L CSV, any change to `calc_cogs`/`repairCalcFields`/COGS formula, Supabase work, the credit-note-vs-net-profit formula, and fixing other reports' coverage gaps (RPT-GAP-001 is logged only).

## 5. Acceptance criteria
- **AC1** `openAcctExport('inv')` and `('pmt')` do not throw and `ov-acct-exp` has class `on` (fails on current `main`).
- **AC2** Opening with a previously chosen non-default format resets to Generic CSV; changing Entity disables inapplicable formats (tooltip + label) and falls back to Generic CSV when needed.
- **AC3** With the default selected, `doAcctExport()` produces a download with no extra clicks.
- **AC4** A real-shape invoice (`lineItems`/`unitCost`/`lid`) gives one row per line in Generic CSV, Xero and QuickBooks; JSON contains `lineItems`; payments with `fa` and `generic-csv` each produce a download.
- **AC5** SKU resolves via catalogue; empty for an unlinked real-shape line; a legacy-shape line (`lines`) with its own `sku` and no `lid` exports that `sku`.
- **AC6** Per-line COGS equals the `cInv()` per-line rule for a catalogue-linked line, an unlinked line with `unitCost`, and a pass-through line (with and without a `lid`); the two unit-cost columns show stored and catalogue values; `Line Type` and `Supplier` (incl. catalogue fallback) are correct.
- **AC7** A legacy-shape invoice (`lines`/`cu`) still exports, including `acctQualityCheck`.
- **AC8** An invoice built through the real `saveInv()` path exports line rows.
- **AC9** Via `acctExportSets()` and `doAcctExport()`: demo invoices and payments (by `_demo` flag, by `demo-` id with the flag stripped as `saveInv()` would, and by `invNum`-only link to a demo invoice) never appear in any format, including JSON; cancelled invoices do; credit notes/goodwill appear in JSON only, not in the line-level CSVs, even when they carry `lineItems`; a demo-only dataset gives the empty-export toast.
- **AC10** Parity (REQ-8) holds for catalogue-linked, unlinked and pass-through fixtures; a stored-COGS-exception fixture and a no-line fixture are classified correctly and reported, with the no-line fixture producing the REQ-7.5 warning; the displayed-vs-live difference list is produced from a fixture where `calc_cogs` differs from the live figure. Demo records are not part of AC10.
- **AC11** Mutation tests: reverting the shape fix fails AC4/AC8; reverting the opener fix fails AC1; reverting demo exclusion (each of the three identification routes separately) fails AC9; reverting the credit-note skip fails AC9.
- **AC12** All 1111 existing tests still pass. The existing `acctInvCSV`/Xero/QB/`acctQualityCheck` tests are rewritten to the real saved shape with every assertion kept (only the fixture shape changes); one legacy-shape test per exporter is retained for the fallback. Final count reported against baseline.
- **AC13** Manual real-browser check, one coherent procedure: (1) click both entry buttons; each opens the modal with no console error; (2) load Demo Mode and confirm both invoice and payment exports report nothing to export; (3) create one non-demo test invoice through the form (catalogue-linked line plus one unlinked line), export Generic CSV, Xero and QuickBooks and confirm line rows; (4) delete the test invoice. The first three data rows are pasted in the delivery note.
- **AC14** Test-harness changes needed to verify AC2-AC4 are made in `tests/run.js` and documented: `document.querySelectorAll` and the radio elements must be mockable (currently `querySelectorAll` returns an empty `forEach`, `tests/run.js:43`), and downloads are captured by swapping `document.createElement` for the duration of one test (the existing pattern at `tests/run.js:15272`), restored afterwards; any shared `mockEl` state touched is reset.

## 6. Flags
- **FPM domain risk:** LOW. No quote engine, freight, duty, or COGS-formula change. Output only.
- **GDPR:** the export already contains buyer name/address/email-adjacent fields and is saved by the operator to their own device via a data-URI download. No new data flow, no transmission, no new fields about natural persons. Supplier names are business data, but `Supplier` together with both `Unit Cost` columns links supplier identity to cost pricing in a file the operator may hand to an accountant: this is commercially sensitive, disclosed here and in the user guide. JSON export is unchanged except for the demo filter and already contains named approver and notes fields. Real exports must not be committed to the public repo.
- **Version/doc obligations:** version bump (v2.9.96, which pushes the not-yet-merged sort/filter branch to v2.9.97), all three hardcoded version strings, `AI_SYSTEM_PROMPT`, in-app changelog, `docs/version-history.md`, `docs/user-guide.md` (Accounting Export section: default format, disabled options, new columns, demo/cancelled behaviour), `docs/known-gaps.md`, `CLAUDE.md`, `STACKD_CONTEXT.md` backlog, tracker rows.

## 7. Process note for reviewers (explicit request)
Both defects shipped because tests covered pure formatters but not the user-facing entry point, and used fixtures unlike saved data. Audit result on `main` (direct calls in `tests/run.js`): `openAgingReport` 0, `openPLReport` 0, `expCSV` 0, `expAll` covered (`tests/run.js:15278`, plus indirect uses), `openVATReturn` covered (`tests/run.js:6150`, opener at `index.html:9477`). The main navigation has roughly 30 further `open*` handlers (for example `openStatement`, `openCN`, `openLoadCalc`, `openFwdReq`) that this brief does NOT audit; the claim is therefore limited to the five named report/export openers. Uncovered openers and the unaudited remainder are logged as **RPT-GAP-001** and are **not fixed** in this brief. Reviewers: confirm no other of the named five is in the same state.
