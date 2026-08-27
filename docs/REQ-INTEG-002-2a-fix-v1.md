# REQ-INTEG-002 (Sub-phase 2a) — Fix: Reconcile `PO.dep` display with the Supplier Payment ledger

**Status:** v1.
**Type:** Fix-forward to already-shipped code — `REQ-INTEG-002-v2.md`/`SPEC-INTEG-002-v2.md` (Sub-phase 2a, shipped v2.9.62, PR #100) and the `lockFxRate()` function it introduced. Not a new REQ number in the tracker — logged as a patch row against the existing Sub-phase 2a entry.
**Scope:** Two independent-but-related fixes, both scoped strictly to what was decided in check-first/decision exchanges preceding this document (see §1.2):
1. Every place that reads `PO.dep` for display today reads the raw, disconnected field instead of reconciling against `DB.supPayments` — recording a real supplier payment currently has zero visible effect anywhere in the app. Fix: one shared helper, `getPOEffectiveDep(po)`, replacing all 9 identified inline read sites.
2. `lockFxRate()` (shipped 2a) only snapshots the one exchange rate relevant to a payment's own currency→GBP leg. Reconciling a mixed-currency PO's ledger against the PO's own currency needs a second leg (GBP→PO-currency) that has no locked rate to use. Fix: widen `lockFxRate()`'s stored shape to snapshot the full static rate table at payment time, so both legs of any later cross-currency conversion are historically accurate, not derived from whatever rate happens to be live in `QR` at display time.

This document does **not** reopen 2a's core scope (the ledger, its modal, its FM-1 clearance), does not touch 2b (Invoice→PO enumeration), 2c (buyer tranches), or 2d (allocation linking) in any way, and does not consolidate the duplicated `fpmRecovered` logic (a separate, already-flagged, explicitly-deferred item).

---

## 1. Business context

### 1.1 The gap (discovered via real-world testing of v2.9.62)

A real operator recorded a payment through the new Supplier Payment ledger (the "$" action on a PO). The Edit PO modal's "Supplier Deposit Paid" figure, the PO PDF, the Dashboard, the Accounts view, and the AI assistant's PO-related answers all continued to show the old, unrelated `PO.dep` figure — completely unaffected by the payment just recorded. Investigation (this session, factual report delivered before this REQ) confirmed:
- `PO.dep` is read directly, with **zero reference to `getPOTotalPaid()`**, in `editPO()`/`calcPO()` (`index.html:6822`, `6849-6851`), `savePO()` (`6863`), and `rPO()` (`6876`).
- `saveSupPayment()`/`addSupPaymentFromForm()` never write to `po.dep`/`po.fpmFunded`/`po.fpmRecovered` — confirmed by 2a's own build-gate regression testing and re-confirmed here. The two mechanisms are, and were always designed to be, fully disconnected data.
- This is not limited to the Edit PO modal. `po.dep`/`p.dep` is read as an inline raw expression, independently, at **9 call sites across 5 functions**:

| # | Function | Lines | What it computes |
|---|---|---|---|
| 1 | `editPO()`/`calcPO()` | `6822`, `6849-6851` | Edit PO modal's Deposit Paid / Balance Due tiles |
| 2 | `rPO()` | `6876` | PO list view's Deposit column |
| 3 | `prevPODoc()` | `7117-7118` | PO PDF's Deposit Paid / Balance Due figures |
| 4 | `rDash()` | `4508-4520` | Main dashboard: outstanding PO balance KPI, Net Cash Position |
| 5 | `renderAccts()` (per-invoice) | `4669`, `4674` | Accounts view: Sup. Dep. Paid, Sup. Bal. Due columns |
| 6 | `renderAccts()` (per-supplier) | `4734`, `4737` | Accounts view: Dep. Paid, Bal. Due, deposit-coverage % |
| 7 | `renderAccts()` (totals bar) | `4770`, `4772` | Accounts view: Total Paid to Suppliers, Net Cash Position |
| 8 | `_aiExecTool()` (`get_kpis`) | `9206` | AI assistant's `poBalanceDue` figure |
| 9 | `_aiExecTool()` (`get_pos`) | `9252-9255` | AI assistant's per-PO `depositPaid`/`balanceDue` fields |

`savePO()` (`index.html:6863`) also **writes** `dep:+G('pf-dep').value||0` back onto the PO record unconditionally on every save — this write path is unaffected by this fix (see REQ-INTEG-002-2a-fix-c, §2, for how it interacts with the reconciled read).

### 1.2 Decisions made before this document was written (binding on scope below)

Two design forks were surfaced and resolved by explicit user decision prior to drafting:

1. **Reconciliation scope: everywhere, not partially.** All 9 call sites above are in scope. A partial fix (e.g. Edit PO + PDF only) would leave the Dashboard/Accounts/AI assistant showing a different, stale number for the same PO — reintroducing a version of the exact disconnect this fix exists to close, one level removed. One shared helper, `getPOEffectiveDep(po)`, replaces all 9 inline reads.
2. **Currency aggregation: native-amount summing preferred over a naive GBP round-trip.** Do not take `getPOTotalPaid()`'s existing GBP-denominated total and convert the whole sum through `fromGBP()` at display time — this would introduce FX rounding noise even for payments already made in the PO's own currency, where none is needed or wanted. Instead: sum native `amount` directly for ledger records paid in the PO's own currency (exact, zero conversion); only pivot through GBP for records paid in a different currency than the PO. This surfaced a further sub-decision:
   - The GBP-pivot leg for a cross-currency record needs to convert *from* GBP *into* the PO's currency. 2a's shipped `lockFxRate()` only ever snapshotted the one rate relevant to the payment's own currency→GBP leg (e.g. `{fxGBPRMB: 9.20}` for an RMB payment) — there is no locked rate for an unrelated GBP→PO-currency leg. Resolved: **widen `lockFxRate()`** to snapshot the full static rate table (`fxGBPUSD`, `fxGBPRMB`, `fxGBPBBD`) at payment time, so any later conversion — into any of the app's supported currencies, not just the payment's own — uses a rate that was locked at payment time, consistent with the original purpose of rate-locking (avoid drift when Settings rates change later). This is explicitly logged as its own small fix-forward to already-shipped 2a code (§2, REQ-INTEG-002-2a-fix-a/-b), not folded invisibly into the `po.dep` reconciliation work.
3. **EUR is out of scope, logged as a pre-existing, separate gap.** `toGBP()`/`fromGBP()` (`index.html:4266-4284`) have no EUR branch at all — an EUR amount falls through to the final `return n;`, i.e. is silently treated as if it were already GBP 1:1. This is a real, pre-existing gap in the shared FX mechanism (used by Invoices, POs, and now Supplier Payments), not something introduced by this fix, and not something this fix corrects — the Supplier Payment currency dropdown (`spm-cur`, `index.html`) already omits EUR entirely (`USD`/`GBP`/`RMB`/`BBD` only), so `getPOEffectiveDep()` cannot itself be handed a EUR-denominated ledger record. The pre-existing gap is that a PO's own currency field (`pf-cur`) *does* offer `CNY`/`EUR` — so a EUR-denominated PO with any ledger records would still hit this limitation when `getPOTotalPaidNative()` tries to convert a GBP-equivalent *into* EUR. Logged as `PROC-GAP-002` in `docs/known-gaps.md` (§6). Fixing it would mean extending the shared FX mechanism itself (new `QR.fxGBPEUR` rate, `toGBP()`/`fromGBP()` branches, Settings UI) — a materially larger, separately-gated change, not appropriate to bundle into a `po.dep`-reconciliation fix.

### 1.3 Facts re-confirmed during check-first for this document (against `main` @ `8e63bab`, 575/575 tests passing)

- **`getPOTotalPaid(poId)`/`getPOPayments(poId)` confirmed unchanged** (`index.html:11471-11478`): take only a `poId`, filter `DB.supPayments`, sum `rateLock.gbpEquiv`. Returns a GBP figure — not denominated in the PO's own currency. This fix does not remove or repurpose `getPOTotalPaid()` (still used, unmodified, by the existing Supplier Payments modal's "Total Paid (GBP equiv.)" tile, `renderPOPaymentsTab()`, `index.html:11522-11528`) — it adds a new, separate function for the PO-native-currency case.
- **Backward-compatibility risk confirmed real, and confirmed to be the default case, not an edge case.** `loadDemoData()` seeds `demo-po-002` (`index.html:4470`) with `dep: 0` and zero linked `DB.supPayments` records — a live example of "legacy `dep`, no ledger" already in shipped fixtures (though `0` masks the risk in that specific record). More materially: `DB.supPayments` only came into existence in v2.9.62. **Every PO created before that version has, by construction, a nonzero `dep` and zero linked ledger records** — this is the default state of all real pre-existing operator data the moment this ships, not a rare exception to guard against.
- **`lockFxRate()`'s current shipped shape confirmed** (`index.html:~4308-4320`, exact lines to be re-cited in SPEC): `{ amount, currency, gbpEquiv, ratesUsed, ts }`, where `ratesUsed` today contains **at most one key** — whichever of `fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD` was actually applied by `toGBP()` for that payment's own currency (empty object `{}` for a GBP payment, since `toGBP()` applies no rate when `cur==='GBP'`).
- **`toGBP()`/`fromGBP()` confirmed unchanged, still the sole conversion mechanism** (`index.html:4266-4284` as of the 2a REQ's own citations, exact current lines to be re-confirmed in SPEC). Both operate only on the single currently-live `QR` object (or `QR_DEFAULTS` fallback) — there is no existing mechanism anywhere in the codebase for converting using a *stored*, historical rate other than what this fix adds.
- **PO currency options (`pf-cur`) confirmed: `USD`, `CNY`, `GBP`, `EUR`.** Supplier Payment currency options (`spm-cur`) confirmed: `USD`, `GBP`, `RMB`, `BBD`. Note the naming mismatch: a PO's own currency uses `CNY`; a Supplier Payment's currency uses `RMB` — both refer to the same real-world currency. `getPOTotalPaidNative()`'s same-currency-match check (§2, REQ-INTEG-002-2a-fix-d) must normalize `CNY`/`RMB` as equivalent, or a same-currency payment would be incorrectly routed through the GBP-pivot path.

---

## 2. Requirements

### REQ-INTEG-002-2a-fix-a — Widen `lockFxRate()`'s stored rate snapshot
`lockFxRate(amount, currency)` must snapshot **all three** static rates (`fxGBPUSD`, `fxGBPRMB`, `fxGBPBBD`) into `ratesUsed` at save time, applying the exact same live-value-or-`QR_DEFAULTS`-fallback logic per rate that `toGBP()`/`fromGBP()` already use individually (i.e. `QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD`, and so on for each of the three) — not just the one rate relevant to the payment's own currency. `gbpEquiv` continues to be computed via the unmodified `toGBP(amount, currency)` call, exactly as today. This is a superset of the current shape: every key that exists today continues to exist and hold the same value; two new keys are added for the two rates not relevant to the payment's own currency.

### REQ-INTEG-002-2a-fix-b — New `fromGBPLocked(gbpAmount, currency, ratesUsed)` helper
A new function, placed near `lockFxRate()`, mirroring `fromGBP()`'s branching exactly, but sourcing each rate from a passed-in `ratesUsed` object (a payment record's own locked snapshot) instead of the live `QR` object:
- `cur==='GBP'` → return the amount unchanged.
- `cur==='USD'` → multiply by `ratesUsed.fxGBPUSD`.
- `cur==='RMB'`/`'CNY'` → multiply by `ratesUsed.fxGBPRMB`.
- `cur==='BBD'` → multiply by `ratesUsed.fxGBPBBD`.
- **Backward-compatible fallback, and only for this reason:** if the requested rate key is missing from `ratesUsed` (i.e. a Supplier Payment record created *before* this fix ships, whose `rateLock.ratesUsed` has at most one key), fall back to the live `QR` value (or `QR_DEFAULTS`) for that specific rate, exactly as `fromGBP()` would. This fallback exists solely to keep pre-existing 2a records readable without a data migration — it must never trigger for any record created after this fix ships, since REQ-INTEG-002-2a-fix-a guarantees all three keys are always present going forward.
- Unrecognized currency → return the amount unchanged (matches `fromGBP()`'s own fallthrough behavior).

### REQ-INTEG-002-2a-fix-c — New `getPOTotalPaidNative(po)` and `getPOEffectiveDep(po)`
Two new functions, placed near `getPOTotalPaid()`:
- `getPOTotalPaidNative(po)` — takes the full PO object (not just an id, since it needs `po.cur`). For each of `po`'s linked Supplier Payment records (`getPOPayments(po.id)`):
  - If the record's `currency` (normalized: treat `RMB`/`CNY` as equivalent — §1.3) matches `po.cur` (also normalized), add the record's raw `amount` directly — no conversion, no rounding, exact.
  - Otherwise, add `fromGBPLocked(record.rateLock.gbpEquiv, po.cur, record.rateLock.ratesUsed)` — the record's own historically-locked GBP-equivalent, converted into the PO's currency using that same record's own locked rate table (REQ-INTEG-002-2a-fix-a/-b), not today's live rate.
  - Returns the sum, denominated in `po.cur`.
- `getPOEffectiveDep(po)` — the single point of truth this whole fix exists to introduce:
  - If `getPOPayments(po.id)` is empty, return `+po.dep || 0` unchanged (the legacy field, verbatim — REQ-INTEG-002-2a-fix-e for why this is not a permanent state).
  - If any linked Supplier Payment records exist, return `getPOTotalPaidNative(po)`.
  - This function never mutates `po.dep` itself, never writes anything, and is safe to call from a read-only render context.

### REQ-INTEG-002-2a-fix-d — Replace all 9 identified read sites with `getPOEffectiveDep(po)`
Every call site in the table in §1.1 is updated to call `getPOEffectiveDep(po)` in place of its current raw `+po.dep||0`/`+p.dep||0` expression, with no other logic in each surrounding function changed:
1. `editPO()`/`calcPO()` — the Deposit Paid input (`pf-dep`) itself continues to display the raw legacy `po.dep` value when the modal is opened (REQ-INTEG-002-2a-fix-e governs this), but the **tiles** computed by `calcPO()` (Deposit Paid, Balance Due) must reflect `getPOEffectiveDep(po)` once any ledger records exist for that PO — this requires `calcPO()` to have access to the currently-open PO's ledger state, not just the raw form value (implementation detail for SPEC).
2. `rPO()` — the list view's Deposit/Balance columns.
3. `prevPODoc(po)` — the PDF's Deposit Paid/Balance Due figures. This is the one call site that produces a document an external party (the supplier) may see — accuracy here is the headline reason this fix exists.
4. `rDash()` — outstanding PO balance KPI, Net Cash Position.
5-7. `renderAccts()` — all three sections (per-invoice, per-supplier, totals bar).
8-9. `_aiExecTool()` — `get_kpis.poBalanceDue`, `get_pos.depositPaid`/`.balanceDue`.

`savePO()`'s write of `dep:+G('pf-dep').value||0` (`index.html:6863`) is **not** changed by this requirement — see REQ-INTEG-002-2a-fix-e for why the manual field's write path must remain intact for POs with no ledger records.

### REQ-INTEG-002-2a-fix-e — Manual "Supplier Deposit Paid" field: read-only once ledger records exist, editable otherwise
The `pf-dep` input in the Edit PO modal:
- **PO has zero linked Supplier Payment records** (including every new PO being drafted, which cannot have a `poId` to link payments against until saved): the field remains fully editable exactly as today. This is deliberate — there is no ledger to be the source of truth for yet, and a brand-new PO in `editPO()` has no `poId` at all until first saved, so a ledger-only past cannot ever exist for it before that point.
- **PO has one or more linked Supplier Payment records**: the field becomes read-only (disabled or visually locked, not hidden — the operator should still be able to see the number, just not edit it directly), displaying `getPOEffectiveDep(po)`. A short inline note or tooltip must indicate why (e.g. "Derived from recorded Supplier Payments — use the $ action to add another payment"), directing the operator to the correct place to make a change rather than leaving the read-only state unexplained.
- This is decision (a)/(b) resolved as a hybrid: option (a) "hidden/removed" was rejected because the field is still the only source of truth for POs with no ledger records and cannot simply disappear; full parallel editability (c) was rejected as explicitly reintroducing the disconnect. This resolves the ambiguity `REQ-INTEG-002-2a-fix`'s own scoping conversation flagged as "a real UX decision, not a detail to default silently."
- `savePO()` must not silently discard a value from a disabled input on save — the SPEC must define exactly what `savePO()` submits for `dep` when the field is read-only (options: continue submitting whatever value the disabled input currently displays via its `.value`, since a disabled input's value is still readable and still present in the DOM; SPEC to confirm this is reliable across browsers rather than assuming it, since a `disabled` attribute — as opposed to `readonly` — can in some implementations exclude a field from being read via `.value` in certain form-serialization patterns, though direct `G('pf-dep').value` element access, which is what `savePO()` already uses, is unaffected either way).

### REQ-INTEG-002-2a-fix-f — Tests
Full coverage, including:
- `lockFxRate()` now returns all three `ratesUsed` keys for every payment currency, including GBP (previously `{}` for GBP — now `{fxGBPUSD, fxGBPRMB, fxGBPBBD}` even though none is "used" by `gbpEquiv`'s own computation for a GBP payment; SPEC to confirm this is the intended universal shape rather than "only the non-payment-currency legs").
- `fromGBPLocked()`: correct conversion for each of USD/RMB/BBD/GBP using a fully-populated `ratesUsed`; correct fallback-to-live-rate behavior when a key is missing (simulating a pre-fix record).
- `getPOTotalPaidNative(po)`: a same-currency-only PO (sums native amounts exactly, no FX drift possible even with deliberately mismatched `QR` values); a mixed-currency PO (one native-currency record + one cross-currency record, asserting the cross-currency record is converted via its own locked rates, not `QR`'s current live values — the test must change `QR` after the record was created and confirm the result is unaffected); the `RMB`/`CNY` currency-code normalization case.
- `getPOEffectiveDep(po)`: zero-records case returns raw `po.dep` unchanged; nonzero-records case returns `getPOTotalPaidNative(po)`, not `po.dep`.
- Regression: all 12 existing 2a tests referencing `lockFxRate()`'s `ratesUsed` shape (specifically the "`ratesUsed` has exactly one key" assertion) must be updated to reflect the new three-key shape — this is an intentional, expected breaking change to that test's assertion, not a regression to preserve.
- At least one test per call site in the §1.1 table confirming it now derives its Deposit/Balance figure from `getPOEffectiveDep()` rather than raw `po.dep` when ledger records exist for that PO.
- `savePO()` on a PO with existing ledger records does not corrupt or lose the effective-deposit display on next `editPO()` open (round-trip test).

---

## 3. Out of scope (explicit)

- No changes to buyer-side Payments/Invoice logic.
- No allocation linking buyer payments to specific supplier obligations (still 2d).
- No changes to `inv.pos[]` or Invoice→PO enumeration (still 2b).
- No consolidation of the duplicated `fpmRecovered` logic (separate, already-flagged item — not folded in here).
- No EUR fix to the shared `toGBP()`/`fromGBP()` mechanism — logged as `PROC-GAP-002` (§1.2 point 3, §6), not built here.
- No change to `PO.fpmFunded`'s display/reconciliation — this fix is scoped to `PO.dep` only, since only `PO.dep` has a corresponding ledger (`DB.supPayments`) to reconcile against; `fpmFunded` has no equivalent ledger in this or any prior phase.

---

## 4. Acceptance criteria (summary — full AC numbering in SPEC)

- AC set 1: `lockFxRate()` widened shape, backward-compatible read via `fromGBPLocked()`.
- AC set 2: `getPOTotalPaidNative()`/`getPOEffectiveDep()` correctness, including the same-currency-exact-sum guarantee and the cross-currency locked-rate guarantee (not live-rate).
- AC set 3: all 9 call sites verified to route through `getPOEffectiveDep()`.
- AC set 4: `pf-dep` read-only/editable state transition, and `savePO()`'s correct read of a disabled field's value.
- AC set 5: zero-ledger-records backward compatibility (existing/demo PO with `dep>0`, no records, unaffected).
- AC set 6: full regression, including updated 2a tests.

---

## 5. Gate process

Full requirements-gate → spec-gate → build-gate pipeline. This changes the figure shown on real financial documents (PO PDFs) and widens the shape of an already-shipped, real-money ledger record (`rateLock`) — do not shortcut, particularly around the backward-compatibility handling in REQ-INTEG-002-2a-fix-b/-e.

---

## 6. Tracker / known-gaps updates required on completion

- `docs/requirements-tracker.md`: new row under Sub-phase 2a's existing entry (or an explicit "fix" annotation on that row, per the instruction that this is a patch, not a new REQ number) once build-gate passes.
- `docs/known-gaps.md`: new entry, `PROC-GAP-002` — "EUR has no FX conversion path in `toGBP()`/`fromGBP()`; a EUR-denominated PO with Supplier Payment records would hit this limitation in `getPOTotalPaidNative()`" — logged as Open/Backlog, explicitly not actioned by this fix (§1.2 point 3).
- `STACKD_CONTEXT.md` changelog updated per the established version-ship pattern.
