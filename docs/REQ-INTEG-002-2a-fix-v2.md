# REQ-INTEG-002 (Sub-phase 2a) — Fix: Reconcile `PO.dep` display with the Supplier Payment ledger

**Status:** v2 — supersedes v1. Independent requirements-gate review of v1 returned **FAIL** (5 blocking findings, 5 advisory) — all ten addressed below; see §8 for the full review-resolution log.
**Type:** Fix-forward to already-shipped code — `REQ-INTEG-002-v2.md`/`SPEC-INTEG-002-v2.md` (Sub-phase 2a, shipped v2.9.62, PR #100) and the `lockFxRate()` function it introduced. Not a new REQ number in the tracker — logged as a patch row against the existing Sub-phase 2a entry.
**Scope:** Two independent-but-related fixes, both scoped strictly to what was decided in check-first/decision exchanges preceding this document (see §1.2):
1. Every place that reads `PO.dep` for display today reads the raw, disconnected field instead of reconciling against `DB.supPayments` — recording a real supplier payment currently has zero visible effect anywhere in the app. Fix: one shared helper, `getPOEffectiveDep(po)`, replacing all **10** identified inline read sites (corrected from v1's "9" — see §8, B-1).
2. `lockFxRate()` (shipped 2a) only snapshots the one exchange rate relevant to a payment's own currency→GBP leg. Reconciling a mixed-currency PO's ledger against the PO's own currency needs a second leg (GBP→PO-currency) that has no locked rate to use. Fix: widen `lockFxRate()`'s stored shape to snapshot the full static rate table at payment time, so both legs of any later cross-currency conversion are historically accurate, not derived from whatever rate happens to be live in `QR` at display time.

This document does **not** reopen 2a's core scope (the ledger, its modal, its FM-1 clearance), does not touch 2b (Invoice→PO enumeration), 2c (buyer tranches), or 2d (allocation linking) in any way, and does not consolidate the duplicated `fpmRecovered` logic (a separate, already-flagged, explicitly-deferred item).

---

## 1. Business context

### 1.1 The gap (discovered via real-world testing of v2.9.62)

A real operator recorded a payment through the new Supplier Payment ledger (the "$" action on a PO). The Edit PO modal's "Supplier Deposit Paid" figure, the PO PDF, the Dashboard, the Accounts view, and the AI assistant's PO-related answers all continued to show the old, unrelated `PO.dep` figure — completely unaffected by the payment just recorded. Investigation (this session, factual report delivered before this REQ) confirmed:
- `PO.dep` is read directly, with **zero reference to `getPOTotalPaid()`**, in `editPO()` (`index.html:6824`: `G('pf-dep').value=po.dep||'';` — corrected from v1's mis-citation of `6822`, see §8 A-1), `savePO()` (`6863`), and `rPO()` (`6876`).
- `calcPO()` (`index.html:6847-6857`) is a structurally different case from the other reads in this table: it never touches `po.dep` at all. It derives its `dep` local variable purely from the live DOM value `G('pf-dep').value` (line 6850), which `editPO()` populated when the modal opened. It is listed in the table below only because it's the render path for the Edit PO modal's tiles — see REQ-INTEG-002-2a-fix-d for why it requires **no code change** under this fix.
- `saveSupPayment()`/`addSupPaymentFromForm()` never write to `po.dep`/`po.fpmFunded`/`po.fpmRecovered` — confirmed by 2a's own build-gate regression testing and re-confirmed here. The two mechanisms are, and were always designed to be, fully disconnected data.
- This is not limited to the Edit PO modal. `po.dep`/`p.dep` is read as an inline raw expression, independently, at **10 call sites across 6 functions** (corrected from v1's undercount — see §8, B-1):

| # | Function | Lines | What it computes |
|---|---|---|---|
| 1 | `editPO()` (populates the modal's `pf-dep` field, which `calcPO()` then reads unmodified) | `6824` | Edit PO modal's Deposit Paid / Balance Due tiles (via `calcPO()`, `6847-6857`, no change needed there) |
| 2 | `rPO()` | `6876` | PO list view's Deposit column |
| 3 | `prevPODoc()` | `7117-7118` | PO PDF's Deposit Paid / Balance Due figures |
| 4 | `rDash()` — KPI tiles | `4508-4520` | Main dashboard: outstanding PO balance KPI, Net Cash Position |
| 5 | `rDash()` — "PO Commitments" chart | `4587` | Dashboard chart bar: `fmt(t-(+p.dep\|\|0),p.cur\|\|'USD')` — a distinct widget from #4, in the same function but a different render block, missed entirely in v1 (§8, B-1) |
| 6 | `renderAccts()` (per-invoice) | `4669`, `4674` | Accounts view: Sup. Dep. Paid, Sup. Bal. Due columns |
| 7 | `renderAccts()` (per-supplier) | `4734`, `4737` | Accounts view: Dep. Paid, Bal. Due, deposit-coverage % |
| 8 | `renderAccts()` (totals bar) | `4770`, `4772` | Accounts view: Total Paid to Suppliers, Net Cash Position |
| 9 | `_aiExecTool()` (`get_kpis`) | `9206` | AI assistant's `poBalanceDue` figure |
| 10 | `_aiExecTool()` (`get_pos`) | `9252-9255` | AI assistant's per-PO `depositPaid`/`balanceDue` fields |

`savePO()` (`index.html:6863`) also **writes** `dep:+G('pf-dep').value||0` back onto the PO record unconditionally on every save — this write path is unaffected by this fix (see REQ-INTEG-002-2a-fix-e for how it interacts with the reconciled, read-only-when-applicable field).

**Explicitly confirmed NOT in scope, and why (§8, B-9):** the CSV/Excel import handlers that write `dep:dep` when constructing new PO/Invoice records from spreadsheet rows (`index.html:7757, 7799, 8090, 8143`) are import-time **writes**, not display reads — irrelevant to a display-reconciliation fix. `autoPos()`'s `dep:0` (`index.html:5908`) is a legitimate initial-value write at PO-creation time, not a stale display read. Neither is a missed call site.

### 1.2 Decisions made before this document was written (binding on scope below)

Three design forks were surfaced and resolved by explicit user decision prior to drafting (the third, on EUR, was revisited and hardened after requirements-gate review — see §8, B-2):

1. **Reconciliation scope: everywhere, not partially.** All 10 call sites above are in scope. A partial fix (e.g. Edit PO + PDF only) would leave the Dashboard/Accounts/AI assistant showing a different, stale number for the same PO — reintroducing a version of the exact disconnect this fix exists to close, one level removed. One shared helper, `getPOEffectiveDep(po)`, replaces all 10 inline reads (9 of them called directly; the 10th — the Edit PO modal's tiles — reached indirectly via `editPO()` populating `pf-dep`, per REQ-INTEG-002-2a-fix-d).

2. **Currency aggregation: native-amount summing preferred over a naive GBP round-trip.** Do not take `getPOTotalPaid()`'s existing GBP-denominated total and convert the whole sum through `fromGBP()` at display time — this would introduce FX rounding noise even for payments already made in the PO's own currency, where none is needed or wanted. Instead: sum native `amount` directly for ledger records paid in the PO's own currency (exact, zero conversion); only pivot through GBP for records paid in a different currency than the PO. This surfaced a further sub-decision:
   - The GBP-pivot leg for a cross-currency record needs to convert *from* GBP *into* the PO's currency. 2a's shipped `lockFxRate()` only ever snapshotted the one rate relevant to the payment's own currency→GBP leg (e.g. `{fxGBPRMB: 9.20}` for an RMB payment) — there is no locked rate for an unrelated GBP→PO-currency leg. Resolved: **widen `lockFxRate()`** to snapshot the full static rate table (`fxGBPUSD`, `fxGBPRMB`, `fxGBPBBD`) at payment time, so any later conversion — into any of the app's supported currencies, not just the payment's own — uses a rate that was locked at payment time, consistent with the original purpose of rate-locking (avoid drift when Settings rates change later). This is explicitly logged as its own small fix-forward to already-shipped 2a code (§2, REQ-INTEG-002-2a-fix-a/-b), not folded invisibly into the `po.dep` reconciliation work.

3. **EUR: excluded from conversion, and now explicitly, safely fenced off — not merely "logged as backlog."** `toGBP()`/`fromGBP()` (`index.html:4288-4306`) have no EUR branch at all — an EUR amount falls through to the final `return n;`, i.e. is silently treated as if it were already GBP 1:1. This is a real, pre-existing gap in the shared FX mechanism (used by Invoices, POs, and now Supplier Payments), not something introduced by this fix. **Requirements-gate review correctly identified that the original v1 design would have made this gap actively worse, not neutral** (§8, B-2): a EUR-currency PO (`pf-cur` offers `EUR`; `spm-cur` never does) would have every one of its linked Supplier Payment records routed through the cross-currency GBP-pivot path unconditionally (since no payment currency can ever equal `EUR`), landing on `fromGBPLocked()`'s "unrecognized currency" fallthrough — which returns the GBP-equivalent number unconverted, mislabeled as if it were already a EUR amount, and feeds that wrong number onto the PO PDF, the one document an external supplier may actually see. Today, by contrast, a EUR PO's Deposit Paid never touches `toGBP`/`fromGBP` at all (straight native-field read) — so this fix, as originally designed, would have been the thing that newly introduces a silent, wrong-currency-labeled number for EUR POs the moment a payment is recorded against one. **Resolved:** REQ-INTEG-002-2a-fix-c now requires an explicit currency allow-list check — if a PO's currency isn't one `getPOTotalPaidNative()` can safely reconcile (today: `USD`/`GBP`/`RMB`/`CNY`/`BBD`), `getPOEffectiveDep()` falls back to the raw legacy `po.dep` figure (exactly as it does for the zero-ledger-records case) rather than attempting a conversion it cannot perform correctly, and the Edit PO modal must show a visible note when this fallback is active so the operator isn't left thinking the figure reflects the ledger when it does not. Fixing EUR conversion itself (a new `QR.fxGBPEUR` rate, `toGBP()`/`fromGBP()` branches, Settings UI) remains out of scope — a materially larger, separately-gated change — and is logged as `PROC-GAP-002` in `docs/known-gaps.md` (§7).

### 1.3 Facts re-confirmed during check-first for this document (against `main` @ `8e63bab`, 575/575 tests passing; re-verified independently by requirements-gate review against the same commit)

- **`getPOTotalPaid(poId)`/`getPOPayments(poId)` confirmed unchanged** (`index.html:11471-11478`): take only a `poId`, filter `DB.supPayments`, sum `rateLock.gbpEquiv`. Returns a GBP figure — not denominated in the PO's own currency. This fix does not remove or repurpose `getPOTotalPaid()` (still used, unmodified, by the existing Supplier Payments modal's "Total Paid (GBP equiv.)" tile, `renderPOPaymentsTab()`, `index.html:11522-11528`) — it adds a new, separate function for the PO-native-currency case.
- **Backward-compatibility risk confirmed real, and confirmed to be the default case, not an edge case.** `loadDemoData()` seeds `demo-po-002` (`index.html:4470`) with `dep: 0` and zero linked `DB.supPayments` records — a live example of "legacy `dep`, no ledger" already in shipped fixtures (though `0` masks the risk in that specific record). More materially: `DB.supPayments` only came into existence in v2.9.62. **Every PO created before that version has, by construction, a nonzero `dep` and zero linked ledger records** — this is the default state of all real pre-existing operator data the moment this ships, not a rare exception to guard against.
- **`lockFxRate()`'s current shipped shape confirmed** (`index.html:4308-4323`): `{ amount, currency, gbpEquiv, ratesUsed, ts }`, where `ratesUsed` today contains **at most one key** — whichever of `fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD` was actually applied by `toGBP()` for that payment's own currency (empty object `{}` for a GBP payment, since `toGBP()` applies no rate when `cur==='GBP'`).
- **`toGBP()`/`fromGBP()` confirmed at `index.html:4288-4306` (corrected from v1's stale `4266-4284` citation, an 18-line drift inherited from the original 2a REQ — see §8, A-2).** Both operate only on the single currently-live `QR` object (or `QR_DEFAULTS` fallback) — there is no existing mechanism anywhere in the codebase for converting using a *stored*, historical rate other than what this fix adds.
- **PO currency options (`pf-cur`) confirmed: `USD`, `CNY`, `GBP`, `EUR`** (`index.html:2192`). **Supplier Payment currency options (`spm-cur`) confirmed: `USD`, `GBP`, `RMB`, `BBD`** (`index.html:11559-11560`). Note the naming mismatch: a PO's own currency uses `CNY`; a Supplier Payment's currency uses `RMB` — both refer to the same real-world currency. `getPOTotalPaidNative()`'s same-currency-match check (§2, REQ-INTEG-002-2a-fix-c) must normalize `CNY`/`RMB` as equivalent, or a same-currency payment would be incorrectly routed through the GBP-pivot path. This normalization precedent already exists in `toGBP()`/`fromGBP()`/`lockFxRate()` (`index.html:4293, 4303, 4312`) — not a novel pattern.

---

## 2. Requirements

### REQ-INTEG-002-2a-fix-a — Widen `lockFxRate()`'s stored rate snapshot
`lockFxRate(amount, currency)` must snapshot **all three** static rates (`fxGBPUSD`, `fxGBPRMB`, `fxGBPBBD`) into `ratesUsed` at save time, applying the exact same live-value-or-`QR_DEFAULTS`-fallback logic per rate that `toGBP()`/`fromGBP()` already use individually (i.e. `QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD`, and so on for each of the three) — not just the one rate relevant to the payment's own currency. `gbpEquiv` continues to be computed via the unmodified `toGBP(amount, currency)` call, exactly as today. This is a superset of the current shape: every key that exists today continues to exist and hold the same value; two new keys are added for the two rates not relevant to the payment's own currency — **including for a GBP payment**, where today's shape stores `{}` (empty — AC-4b) and the new shape stores all three rates even though none is "used" by `gbpEquiv`'s own computation for that specific payment. This universal shape (always three keys, regardless of payment currency) is deliberate: it's what makes any later conversion into any PO currency possible from any payment record, not just ones whose own currency happens to match.

### REQ-INTEG-002-2a-fix-b — New `fromGBPLocked(gbpAmount, currency, ratesUsed)` helper
A new function, placed near `lockFxRate()`, mirroring `fromGBP()`'s branching exactly, but sourcing each rate from a passed-in `ratesUsed` object (a payment record's own locked snapshot) instead of the live `QR` object:
- `cur==='GBP'` → return the amount unchanged.
- `cur==='USD'` → multiply by `ratesUsed.fxGBPUSD`.
- `cur==='RMB'`/`'CNY'` → multiply by `ratesUsed.fxGBPRMB`.
- `cur==='BBD'` → multiply by `ratesUsed.fxGBPBBD`.
- **Backward-compatible fallback, and only for this reason:** if the requested rate key is missing from `ratesUsed` (i.e. a Supplier Payment record created *before* this fix ships, whose `rateLock.ratesUsed` has at most one key), fall back to the live `QR` value (or `QR_DEFAULTS`) for that specific rate, exactly as `fromGBP()` would. This fallback exists solely to keep pre-existing 2a records readable without a data migration — it must never trigger for any record created after this fix ships, since REQ-INTEG-002-2a-fix-a guarantees all three keys are always present going forward.
- Any currency not in `{GBP, USD, RMB, CNY, BBD}` (in practice today: `EUR`) is **not** handled by this function falling through silently — see REQ-INTEG-002-2a-fix-c, which is required to never call `fromGBPLocked()` with such a currency in the first place (the allow-list check happens one level up, before this function is ever invoked, precisely so this function never needs an "unrecognized currency" branch that could return a wrong, mislabeled number).

### REQ-INTEG-002-2a-fix-c — New `getPOTotalPaidNative(po)` and `getPOEffectiveDep(po)`, with an explicit currency allow-list guard
Two new functions, placed near `getPOTotalPaid()`:
- `getPOTotalPaidNative(po)` — takes the full PO object (not just an id, since it needs `po.cur`). Callers must only invoke this once `getPOEffectiveDep()`'s allow-list check (below) has already passed. For each of `po`'s linked Supplier Payment records (`getPOPayments(po.id)`):
  - If the record's `currency` (normalized: treat `RMB`/`CNY` as equivalent) matches `po.cur` (also normalized), add the record's raw `amount` directly — no conversion, no rounding, exact.
  - Otherwise, add `fromGBPLocked(record.rateLock.gbpEquiv, po.cur, record.rateLock.ratesUsed)` — the record's own historically-locked GBP-equivalent, converted into the PO's currency using that same record's own locked rate table (REQ-INTEG-002-2a-fix-a/-b), not today's live rate.
  - Returns the sum, denominated in `po.cur`.
- `getPOEffectiveDep(po)` — the single point of truth this whole fix exists to introduce:
  1. If `getPOPayments(po.id)` is empty, return `+po.dep || 0` unchanged (the legacy field, verbatim — REQ-INTEG-002-2a-fix-e for why this is not a permanent state).
  2. **Currency allow-list check (new in v2, per §1.2 point 3):** if `po.cur` (normalized) is not one of `USD`/`GBP`/`RMB`/`CNY`/`BBD`, return `+po.dep || 0` unchanged — the same legacy fallback as the zero-records case — and set a return-shape flag (see below) so callers that render a UI (specifically `editPO()`, REQ-INTEG-002-2a-fix-e) can show the "cannot reconcile into this currency" note. This function must never call `getPOTotalPaidNative()`/`fromGBPLocked()` with an unsupported target currency.
  3. Otherwise, return `getPOTotalPaidNative(po)`.
  - **Return shape:** `getPOEffectiveDep(po)` returns a plain number for the 9 non-modal call sites (REQ-INTEG-002-2a-fix-d), which only ever need a number to render. For `editPO()`'s specific need to know *why* a fallback occurred (to decide whether to show the "cannot reconcile" note vs. the plain "no payments yet, fully editable" state), `editPO()` may call a small companion, e.g. `getPOEffectiveDepInfo(po)`, returning `{ value: <number>, source: 'ledger' | 'legacy-no-records' | 'legacy-unsupported-currency' }`. `getPOEffectiveDep(po)` itself can be implemented as `getPOEffectiveDepInfo(po).value` to guarantee the two never drift apart. SPEC to finalize exact naming/shape.
  - This function never mutates `po.dep` itself, never writes anything, and is safe to call from a read-only render context.

### REQ-INTEG-002-2a-fix-d — Replace 9 direct read sites with `getPOEffectiveDep(po)`; the Edit PO modal's tiles are reached indirectly and require no change to `calcPO()`
Of the 10 sites in §1.1's table:
- **9 direct reads** (`rPO()`; `prevPODoc()`; `rDash()` KPI tiles; `rDash()` PO Commitments chart; `renderAccts()` ×3; `_aiExecTool()` ×2) are updated to call `getPOEffectiveDep(po)` in place of their current raw `+po.dep||0`/`+p.dep||0` expression, with no other logic in each surrounding function changed. `prevPODoc(po)` is the one call site among these that produces a document an external party (the supplier) may see — accuracy here is the headline reason this fix exists.
- **The 10th (`editPO()`/`calcPO()`) requires no change to `calcPO()` at all.** `editPO()` (`index.html:6824`) is updated to set `G('pf-dep').value = getPOEffectiveDep(po)` instead of the current `po.dep||''`. Because `calcPO()` already derives everything purely from `G('pf-dep').value` (line 6850) with no direct reference to `po` or `DB.po`, once `editPO()` populates that field with the reconciled figure, `calcPO()`'s existing, unmodified code automatically renders the correct effective figure in the modal's tiles. This resolves v1's internal inconsistency (§8, B-3), where fix-d implied `calcPO()` needed new access to "the currently-open PO's ledger state" while fix-e simultaneously specified the value should be pre-populated into the field — there is exactly one source of truth (the value written into `pf-dep` at modal-open time by `editPO()`), not two.

`savePO()`'s write of `dep:+G('pf-dep').value||0` (`index.html:6863`) is **not** changed by this requirement — see REQ-INTEG-002-2a-fix-e for why the manual field's write path must remain intact for POs with no ledger records (or an unsupported currency, per fix-c point 2), and for the read-only case's interaction with this same write path.

### REQ-INTEG-002-2a-fix-e — Manual "Supplier Deposit Paid" field: read-only via the `readonly` attribute once ledger records exist and can be reconciled; editable otherwise
The `pf-dep` input in the Edit PO modal:
- **PO has zero linked Supplier Payment records, OR has records but its currency cannot be reconciled (`getPOEffectiveDepInfo(po).source !== 'ledger'`)** — including every new PO being drafted, which cannot have a `poId` to link payments against until saved: the field remains fully editable exactly as today. For the unsupported-currency case specifically, a short inline note must also appear (e.g. "Supplier Payments exist for this PO but its currency (EUR) cannot yet be reconciled automatically — showing the manually-entered figure. This value is not derived from the ledger.") so the operator isn't misled into thinking the manually-editable figure already reflects recorded payments.
- **PO has one or more linked Supplier Payment records AND its currency can be reconciled**: the field is set to **`readonly`** (not `disabled` — v1 left this ambiguous, chosen and resolved here per §8, B-4: `readonly` keeps the field's value selectable/copyable and keyboard/tab-reachable, per this requirement's own "operator should still be able to see the number" intent, and is read via `.value` with zero ambiguity, unlike `disabled`, which in some form-serialization contexts can exclude a field from being read — though `savePO()`'s direct `G('pf-dep').value` element access is unaffected by that distinction either way, `readonly` is chosen for the UX reasons, not the read-path reasons). The field displays `getPOEffectiveDep(po)`. A short inline note or tooltip must indicate why (e.g. "Derived from recorded Supplier Payments — use the $ action to add another payment"), directing the operator to the correct place to make a change rather than leaving the read-only state unexplained.
- This is decision (a)/(b) resolved as a hybrid: option (a) "hidden/removed" was rejected because the field is still the only source of truth for POs with no ledger records (or an unreconcilable currency) and cannot simply disappear; full parallel editability (c) was rejected as explicitly reintroducing the disconnect.
- `savePO()` continues to submit whatever value the `pf-dep` input currently displays via `G('pf-dep').value` — with the `readonly` attribute (not `disabled`), this is a plain, unambiguous DOM read with no browser-compatibility caveat to document, unlike the `disabled` alternative v1 left open.

### REQ-INTEG-002-2a-fix-f — Tests
Full coverage, including:
- `lockFxRate()` now returns all three `ratesUsed` keys for every payment currency, including GBP (previously `{}` for GBP — now `{fxGBPUSD, fxGBPRMB, fxGBPBBD}`).
- `fromGBPLocked()`: correct conversion for each of USD/RMB/BBD/GBP using a fully-populated `ratesUsed`; correct fallback-to-live-rate behavior when a key is missing (simulating a pre-fix record).
- `getPOTotalPaidNative(po)`: a same-currency-only PO (sums native amounts exactly, no FX drift possible even with deliberately mismatched `QR` values); a mixed-currency PO (one native-currency record + one cross-currency record, asserting the cross-currency record is converted via its own locked rates, not `QR`'s current live values — the test must change `QR` after the record was created and confirm the result is unaffected); the `RMB`/`CNY` currency-code normalization case.
- `getPOEffectiveDep(po)`/`getPOEffectiveDepInfo(po)`: zero-records case returns raw `po.dep` unchanged with `source:'legacy-no-records'`; nonzero-records-supported-currency case returns `getPOTotalPaidNative(po)` with `source:'ledger'`; nonzero-records-EUR-PO case returns raw `po.dep` unchanged with `source:'legacy-unsupported-currency'` (the case requirements-gate review flagged as the real regression risk in v1 — this is the specific test that proves it's closed).
- **Regression, corrected count (§8, B-5):** exactly **2** of the 12 existing 2a tests require updating for the `ratesUsed`-shape widening — `tests/run.js:4092` ("ratesUsed has exactly one key," AC-2, becomes "has exactly three keys") and `tests/run.js:4125` ("ratesUsed is empty for GBP," AC-4b, becomes "ratesUsed has all three keys even for a GBP payment"). `tests/run.js:4112` (AC-3) asserts a specific rate's *value*, which is unchanged by the widening and needs no edit. The other 9 of the 12 do not reference `ratesUsed` and are unaffected.
- At least one test per direct call site (9 of the 10 in the §1.1 table) confirming it now derives its Deposit/Balance figure from `getPOEffectiveDep()` rather than raw `po.dep` when ledger records exist for that PO; one test confirming `editPO()` populates `pf-dep` with the reconciled figure and sets it `readonly` under the same condition, and confirming `calcPO()` requires no test changes since its own logic is unmodified.
- `savePO()` on a PO with existing ledger records does not corrupt or lose the effective-deposit display on next `editPO()` open (round-trip test).

---

## 3. Out of scope (explicit)

- No changes to buyer-side Payments/Invoice logic.
- No allocation linking buyer payments to specific supplier obligations (still 2d).
- No changes to `inv.pos[]` or Invoice→PO enumeration (still 2b).
- No consolidation of the duplicated `fpmRecovered` logic (separate, already-flagged item — not folded in here).
- No EUR fix to the shared `toGBP()`/`fromGBP()` mechanism — logged as `PROC-GAP-002` (§1.2 point 3, §7), not built here. This fix's only obligation regarding EUR is to never produce or display a silently-wrong reconciled number for a EUR PO — satisfied by the allow-list fallback in REQ-INTEG-002-2a-fix-c.
- No change to `PO.fpmFunded`'s display/reconciliation — this fix is scoped to `PO.dep` only, since only `PO.dep` has a corresponding ledger (`DB.supPayments`) to reconcile against; `fpmFunded` has no equivalent ledger in this or any prior phase.
- No changes to the CSV/Excel import handlers' `dep:dep` writes (`index.html:7757, 7799, 8090, 8143`) — these are import-time writes of a new record's initial value, not display reads, and are unaffected by this fix.
- No changes to `autoPos()`'s `dep:0` initial value (`index.html:5908`) — a legitimate write at PO-creation time, not a stale display read.

---

## 4. Acceptance criteria (summary — full AC numbering in SPEC)

- AC set 1: `lockFxRate()` widened shape (all three keys, always), backward-compatible read via `fromGBPLocked()`.
- AC set 2: `getPOTotalPaidNative()`/`getPOEffectiveDep()` correctness, including the same-currency-exact-sum guarantee, the cross-currency locked-rate guarantee (not live-rate), and the EUR/unsupported-currency safe-fallback guarantee.
- AC set 3: all 10 call sites verified to route through `getPOEffectiveDep()` (9 directly, 1 via `editPO()`→`pf-dep`→unmodified `calcPO()`).
- AC set 4: `pf-dep` `readonly`/editable state transition (including the unsupported-currency case remaining editable with a note), and `savePO()`'s correct read of a `readonly` field's value.
- AC set 5: zero-ledger-records backward compatibility (existing/demo PO with `dep>0`, no records, unaffected).
- AC set 6: full regression, including the 2 corrected 2a tests.

---

## 5. Currency allow-list (explicit, for SPEC to encode as a named constant, not a magic inline list)

`getPOEffectiveDep()`/`getPOTotalPaidNative()` may only reconcile a PO whose (normalized) currency is one of: `USD`, `GBP`, `RMB` (alias `CNY`), `BBD`. Any other PO currency (today, only `EUR` is reachable via `pf-cur`) falls back to the legacy `po.dep` field with a `source:'legacy-unsupported-currency'` flag. SPEC should name this list once (e.g. `PO_DEP_RECONCILE_CURS`) so it isn't duplicated inline in two functions and drifts.

---

## 6. Gate process

Full requirements-gate → spec-gate → build-gate pipeline. This changes the figure shown on real financial documents (PO PDFs) and widens the shape of an already-shipped, real-money ledger record (`rateLock`) — do not shortcut, particularly around the backward-compatibility handling in REQ-INTEG-002-2a-fix-b/-e and the currency allow-list guard in REQ-INTEG-002-2a-fix-c.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/requirements-tracker.md`: new row under Sub-phase 2a's existing entry (or an explicit "fix" annotation on that row, per the instruction that this is a patch, not a new REQ number) once build-gate passes.
- `docs/known-gaps.md`: new entry, `PROC-GAP-002` — "EUR has no FX conversion path in `toGBP()`/`fromGBP()`; a EUR-denominated PO with Supplier Payment records falls back to the legacy `po.dep` figure rather than reconciling against the ledger (this fix's allow-list guard prevents it from silently displaying a wrong number, but does not close the underlying EUR conversion gap)" — logged as Open/Backlog, explicitly not actioned by this fix (§1.2 point 3).
- `STACKD_CONTEXT.md` changelog updated per the established version-ship pattern.

---

## 8. Requirements-gate review resolution log (v1 → v2)

Independent requirements-gate review of v1 returned **FAIL**. All findings addressed below.

**Blocking:**
- **B-1 (missed 10th call site).** v1's §1.1 table and every "9 call sites" reference omitted `rDash()`'s "PO Commitments" chart (`index.html:4587`), a separate render block within the same function as the KPI tiles, computing `fmt(t-(+p.dep||0),p.cur||'USD')` per bar. Under v1's design this widget would have kept showing the stale raw figure post-fix — reproducing the exact bug being fixed. **Fixed:** added as table row #5; every "9"/"5 functions" reference corrected to "10"/"6 functions" throughout the document (§1.1, §1.2 point 1, §2 fix-d, §2 fix-f, §4 AC set 3).
- **B-2 (EUR conversion would silently corrupt PO-PDF figures for EUR POs).** v1 treated the EUR gap as an inert, unchanged pre-existing limitation. Reviewer correctly showed the original design would have actively introduced a new silent-corruption path: since `spm-cur` never offers `EUR`, every ledger record on a EUR PO would hit the cross-currency branch and fall through `fromGBPLocked()`'s "unrecognized currency" case, returning an unconverted GBP-equivalent number mislabeled as EUR, feeding the PO PDF. **Fixed:** REQ-INTEG-002-2a-fix-c now requires an explicit currency allow-list check (§5) — an unsupported PO currency (EUR today) is never passed into `fromGBPLocked()`; `getPOEffectiveDep()` falls back to the raw legacy `po.dep` instead, with a `source` flag so `editPO()` can show an explanatory note (REQ-INTEG-002-2a-fix-e) rather than silently displaying an unreconciled or wrong figure.
- **B-3 (fix-d/fix-e contradiction on `calcPO()`).** v1's fix-d implied `calcPO()` needed new access to "the currently-open PO's ledger state," while fix-e simultaneously specified the reconciled value should be pre-populated into `pf-dep` at modal-open time — two different, potentially inconsistent mechanisms for the same number. **Fixed:** REQ-INTEG-002-2a-fix-d now states explicitly that `calcPO()` requires **no code change**; the single source of truth is `editPO()` populating `pf-dep` with `getPOEffectiveDep(po)` when the modal opens, which `calcPO()`'s existing unmodified logic then reads like any other form value.
- **B-4 (`disabled` vs. `readonly` left unresolved).** v1's "disabled or visually locked" wording didn't commit to a concrete, buildable mechanism and left a write-prevention gap (a CSS-only "visually locked" treatment doesn't itself block typing). **Fixed:** REQ-INTEG-002-2a-fix-e now specifies `readonly` explicitly, with the reasoning (value stays selectable/copyable, keyboard/tab-reachable, unambiguous `.value` read) stated directly in the requirement.
- **B-5 (wrong test-count claim).** v1 claimed "all 12 existing 2a tests referencing `lockFxRate()`'s `ratesUsed` shape... must be updated," conflating "12 tests in the 2a suite" with "12 tests referencing `ratesUsed`." Independently verified: only 2 of the 12 (`tests/run.js:4092`, `4125`) assert the `ratesUsed` shape/count and need updating; a third (`4112`) asserts a value that remains valid unchanged. **Fixed:** REQ-INTEG-002-2a-fix-f now states the corrected count and both exact line numbers.

**Advisory:**
- **A-1 (editPO citation off by 2 lines).** v1 cited `index.html:6822` for `editPO()`'s `po.dep` read; the actual line is `6824`. **Fixed:** corrected throughout.
- **A-2 (stale `toGBP()`/`fromGBP()` citation, self-flagged in v1 as needing re-confirmation).** v1's inherited citation (`4266-4284`) had drifted 18 lines from the actual current location (`4288-4306`). **Fixed:** corrected in §1.3.
- **A-3 (imprecise classification of `calcPO()` as a "raw `po.dep` read site").** v1's table implied all 9 sites were structurally the same kind of direct object-field read; `calcPO()` is structurally different (reads a DOM value, not `po.dep` directly). **Fixed:** §1.1 now states this distinction explicitly, and it's the basis for B-3's resolution (no `calcPO()` code change needed).
- **A-4 ("9 sites / 5 functions" undercounted distinct functions).** Resolved as part of B-1's fix — now correctly stated as 10 sites / 6 functions.
- **A-5 (CSV import paths and `autoPos()` not explicitly named as out-of-scope, left to inspection).** **Fixed:** §3 now explicitly names `index.html:7757, 7799, 8090, 8143` (CSV import writes) and `index.html:5908` (`autoPos()`'s initial-value write) as confirmed-out-of-scope, not omissions.

**Confirmed correct, no change needed:** GDPR/PII assessment (no new person-identifying fields); `pf-cur`/`spm-cur` option-list citations; `lockFxRate()`'s current shape citation; RMB/CNY normalization precedent; `lockFxRate()`'s sole caller (`addSupPaymentFromForm()`) confirming no buyer-side leakage; `PROC-GAP-002` numbering (no collision with existing `docs/known-gaps.md` entries).
