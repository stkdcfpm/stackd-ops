# REQ-CUR-002 — Close `ACCT-GAP-001` and `AI-GAP-010`: remaining currency-mixing sites

**Status:** v1 — requirements-gate independent review: **CONDITIONAL PASS** (no blocking findings; 3 advisory notes incorporated in place, not requiring a new review round — see §6).
**Type:** Bug-fix remediation of two already-logged, pre-existing known gaps (`docs/known-gaps.md`), not new scope. Continues the currency-mixing fix begun in REQ-INTEG-002-2a-fix-2 (v2.9.64, which fixed `renderAccts()`'s totals bar) — same defect class, two more sites, user-prioritized as the immediate next item after that fix shipped.
**Scope:** `renderAccts()`'s per-invoice and per-supplier view sections (`ACCT-GAP-001`), and `_aiExecTool('get_kpis')` (`AI-GAP-010`).

---

## 1. Business context

Both gaps are the identical defect already fixed once in this codebase: summing raw native-currency amounts across records that may be denominated in different currencies, with no conversion, producing a meaningless mixed total displayed (or returned to the AI assistant) with no indication anything is wrong.

### 1.1 Facts established during check-first (against `main` @ `7a3f0af`, 604/604 tests passing)

**`ACCT-GAP-001` — re-scoped, wider than originally logged.** The original gap entry (logged v2.9.64) named only the per-invoice "Sup. Dep. Paid"/"Sup. Bal. Due" columns and the per-supplier "Dep. Paid"/"Bal. Due" columns. Re-reading the live `renderAccts()` code (`index.html:4695-4807`) for this REQ found **two further affected values not named in the original gap log**:
- **Per-invoice `fpmFunded`** (`index.html:4710`) — summed raw across `linkedPOs`, same flaw, rendered via `fmt(fpmFunded,cur)` in the `fpmCell` (`4727`) using the invoice's own currency label.
- **Per-invoice `totalToChase`** (`index.html:4717-4719`) — `balFromBuyer + unrecoveredFPM`, where `balFromBuyer` is invoice-native and `unrecoveredFPM` derives from the (buggy, raw) `fpmFunded` sum above — this line mixes a buyer-side figure with a supplier-side figure that can be in a genuinely different currency, a second, distinct flavor of the same underlying defect (not just "multiple POs of different currencies," but "buyer currency ≠ supplier currency").
- **Per-supplier `totalCOGS`** (`index.html:4771-4773`) — summed raw across `s.pos`' line-item costs, same flaw, rendered via unlabeled `fmt(totalCOGS)` (implicit `'USD'` default, per `fmt()`'s own signature, `index.html:3430`, corrected citation — see §6, A-2).

The full, corrected list of affected values for this REQ: per-invoice `supDepPaid`, `fpmFunded`, `supBalDue`, `totalToChase`; per-supplier `totalCOGS`, `totalDep`, `totalBal`.

**Confirmed NOT affected, no change needed:** per-invoice `c.grand` (Invoice Total), `buyerDep` (Buyer Dep. Rec.), `balFromBuyer` (Buyer Bal. Due) — each is a single invoice's own figure, inherently one currency, correctly rendered via `fmt(x, cur)` using that invoice's own `cur`. These stay exactly as they are; this REQ does not convert buyer-side, single-invoice figures into the display currency, only the sums that genuinely span potentially-multiple currencies. `totalToChase` is the one exception requiring `balFromBuyer` to be converted too, since that specific figure combines it with a cross-currency supplier aggregate (see REQ-CUR-002-a below) — the "Buyer Bal. Due" *column* itself is untouched.

**`pct` (Dep. Coverage %, per-supplier) needs no separate fix.** Once `totalDep` and `totalCOGS` are both computed via the same convert-then-sum treatment, their ratio (`(totalDep/totalCOGS)*100`) is automatically correct — verified algebraically, not just asserted: `toDisp(a,cur) = a · k(cur) · f(dispCur)`, where `f(dispCur)` is a single multiplier common to every term regardless of source currency; since `totalDep` and `totalCOGS` sum over the *same* PO set, that common factor cancels exactly in their ratio — `pct` is fully invariant to the choice of `dispCur`, not merely "correct once inputs are fixed." This mirrors how `net = tBD - tSD` required no separate conversion in the totals-bar fix. **The same reasoning applies to `get_kpis`' `avgMargin` (§REQ-CUR-002-c below, added per §6 A-3): `avgMargin = (np/revenue)*100` is a ratio of two figures summed over the *same* invoice set with the *same* per-invoice currency weights, so it is automatically correct once `revenue`/`np` are fixed — no separate treatment required.**

**`AI-GAP-010` confirmed exactly as logged, current code (`index.html:9279-9305`).** `revenue`, `np`, `outstanding` (from `iCalc(i).grand`/`.np`/`.bal`, each denominated in that invoice's own `i.cur` — confirmed via `iCalc()`/`cInv()`, `index.html:4236`, `4391-4407`, no conversion performed inside either) and `poBal` (via `getPOEffectiveDep(p)`, PO-native) are all summed raw with no `toDisp()`. **Additionally, and more severe than the Accounts-page instances:** the JSON response has **no currency field at all** — `fmt()` at least renders a visible currency symbol on the Accounts page; here, the AI model receives a bare number (`invoiceRevenue: 59512.34`) with nothing to indicate what currency it's in, meaning even a same-currency, bug-free scenario leaves the AI guessing what unit to state when it relays this figure to the operator.

**Related, same defect class, confirmed still open, explicitly NOT in scope for this REQ:** `CUR-GAP-001` (Aging Report, `renderAgingReport()`) and `CUR-GAP-002` (Buyer Statement, `renderStatement()`/`openStatement()`) — both logged v2.9.46, both still unfixed, both the identical raw-sum-no-conversion pattern. Not touched here because they weren't named in the user's stated priority for this pass (`ACCT-GAP-001`, `AI-GAP-010` specifically) — flagged here so they aren't mistaken for newly-discovered, rather than already-known and independently deferred.

---

## 2. Requirements

### REQ-CUR-002-a — Convert before summing, `renderAccts()` per-invoice view
For each invoice row: `supDepPaid`, `fpmFunded`, and `supBalDue` must each be computed by converting every linked PO's per-item amount via `toDisp(amount, po.cur||'USD')` before summing (mirroring the totals-bar pattern) — not raw-summed then rendered in the invoice's currency. `totalToChase` must be computed as `toDisp(balFromBuyer, cur) + unrecoveredFPM` (where `unrecoveredFPM` derives from the now-already-converted `fpmFunded`) — both operands in `dispCur` before adding. All four values render via `fmt(x, dispCur)`, where `dispCur = QR.displayCurrency || 'GBP'` — computed once, near the top of `renderAccts()` (currently computed only in the TOTALS BAR section, `index.html:4814`; must move earlier so the per-invoice/per-supplier sections can use it too). The "Invoice Total"/"Buyer Dep. Rec."/"Buyer Bal. Due" columns are unchanged, still `fmt(x, cur)` in the invoice's own native currency.

### REQ-CUR-002-b — Convert before summing, `renderAccts()` per-supplier view
`totalCOGS`, `totalDep`, `totalBal` must each convert every PO's per-item amount via `toDisp(amount, po.cur||'USD')` before summing, rendered via `fmt(x, dispCur)`. `pct` (Dep. Coverage %) requires no separate change — it becomes correct automatically once both its inputs are consistently converted.

### REQ-CUR-002-c — Convert before summing + add a currency field, `_aiExecTool('get_kpis')`
`revenue`, `np`, `outstanding` must each convert every invoice's `iCalc()` figure via `toDisp(amount, inv.cur||'USD')` before summing; `poBal` must convert every PO's balance via `toDisp(amount, po.cur||'USD')` before summing — all four using the same `dispCur = QR.displayCurrency||'GBP'`. The JSON response must add a `currency: dispCur` field so the AI assistant has an explicit, machine-readable unit for every monetary figure in the response, and `AI_SYSTEM_PROMPT`'s description of `get_kpis` must be updated to state that the returned figures are in `currency`, not assumed to be USD or the querying invoice's own currency (mandatory `AI_SYSTEM_PROMPT` review per `CLAUDE.md`'s "On version delivery" checklist, since this changes what a live tool actually returns). `avgMargin` requires no separate conversion treatment — see the ratio-invariance note under §1.1.

### REQ-CUR-002-d — Tests
- `renderAccts()` per-invoice: an invoice with 2+ linked POs in different currencies — assert `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` each reflect the correctly-converted sum (via the same `ctx.toDisp()`-then-`ctx.fmt()` pre-formatting comparison mechanism established in REQ-INTEG-002-2a-fix-2, since raw floats will not appear verbatim in `fmt()`'s rounded output).
- `renderAccts()` per-supplier: a supplier with 2+ POs in different currencies — assert `totalCOGS`/`totalDep`/`totalBal` reflect the correctly-converted sum, and `pct` is computed from the converted figures (not the raw ones).
- `_aiExecTool('get_kpis')`: invoices/POs in 2+ different currencies — assert `invoiceRevenue`/`netProfit`/`outstanding`/`poBalanceDue` all reflect correctly-converted sums, and the response includes `currency` matching `QR.displayCurrency||'GBP'`.
- Regression guard for each of the three sites: a same-currency-only scenario, with `QR.displayCurrency` explicitly pinned to that scenario's own currency (per REQ-INTEG-002-2a-fix-2's corrected precedent — the no-op identity does NOT hold under the app's actual default, `QR_DEFAULTS.displayCurrency:'GBP'`), confirms the fix doesn't change output for the common single-currency case.
- `QR.displayCurrency` save/restore in every test that mutates it, per the same established precedent (`tests/run.js:4548-4571`, corrected citation — see §6, A-1).

---

## 3. Out of scope (explicit)

- `CUR-GAP-001` (Aging Report) and `CUR-GAP-002` (Buyer Statement) — same defect class, confirmed still open, not touched here; not part of the user's stated priority for this pass.
- `getPOEffectiveDep()`/`getPOTotalPaidNative()`/`lockFxRate()`/`toDisp()`/`toGBP()`/`fromGBP()` themselves — unchanged, used only as the existing, correct conversion mechanism.
- `renderPOPaymentsTab()`'s "Total Paid (GBP equiv.)" tile — already correct (sums locked `gbpEquiv`, explicitly GBP-labeled), unrelated.
- No change to `rDash()` — already correct, used only as the reference pattern (as it was for REQ-INTEG-002-2a-fix-2).
- `AI_SYSTEM_PROMPT` changes limited to `get_kpis`'s own description — no unrelated prompt edits.

---

## 4. Gate process

Full requirements-gate → spec-gate → build-gate, matching the precedent set by REQ-INTEG-002-2a-fix-2 for the same defect class (financial totals display, plus a live AI-assistant-facing data tool this time) — do not shortcut.

---

## 5. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: mark `ACCT-GAP-001` and `AI-GAP-010` fixed, with a corrected note on `ACCT-GAP-001` acknowledging the widened scope found during this REQ's check-first (`fpmFunded`/`totalToChase`/`totalCOGS` were not named in the original log entry).
- `docs/requirements-tracker.md`: new row for `REQ-CUR-002`.
- `STACKD_CONTEXT.md`'s Backlog carried forward table: remove the now-fixed rows, per the standing "On version delivery" checklist item added this session.

---

## 6. Requirements-gate review resolution log

Independent requirements-gate review returned **CONDITIONAL PASS** — no blocking findings, 3 advisory. All addressed in place below; no second review round required for cosmetic/completeness-only notes (consistent with how equivalent advisory-only findings were handled in REQ-INTEG-002-2a-fix's own requirements-gate pass).

- **A-1 (wrong test-precedent citation).** v1 cited `tests/run.js:5891/5894` as the established save/restore-`QR.displayCurrency` precedent — reviewer found those lines belong to an unrelated `ordCheckLineGapsSemantic` test with nothing to do with currency. The real precedent (save/restore + pin-to-scenario-currency + `toDisp()`/`fmt()`-derived expected values) lives at `tests/run.js:4548-4571` (the two `renderAccts()` totals-bar tests from REQ-INTEG-002-2a-fix-2). **Fixed:** citation corrected in §2, REQ-CUR-002-d.
- **A-2 (`fmt()` signature citation off by 9 lines).** v1 cited `index.html:3421`; the function actually starts at `index.html:3430` (3421 is an unrelated preceding function's closing brace). The underlying claim (`fmt()` defaults its currency argument to `'USD'`) was itself confirmed correct. **Fixed:** citation corrected in §1.1.
- **A-3 (`avgMargin` is the same self-correcting-ratio case as `pct`, but wasn't stated).** `get_kpis`' `avgMargin = (np/revenue)*100` is a ratio of two figures REQ-CUR-002-c already requires fixing, summed over the same invoice set with the same per-invoice currency weights — by the identical algebraic argument made for `pct`, it's automatically correct once `revenue`/`np` are fixed, with nothing further to build. **Fixed:** noted explicitly in §1.1 and cross-referenced from REQ-CUR-002-c, so a spec-gate reviewer or builder doesn't have to independently re-derive this.

**Confirmed correct, no change needed:** the full `renderAccts()` affected-sites list (`fpmFunded`, `totalToChase`, `totalCOGS` genuinely unconverted and genuinely absent from the original `ACCT-GAP-001` log entry); the `totalToChase` fix design (no double-conversion risk, confirmed by tracing `unrecoveredFPM`'s only source); the `pct` ratio-invariance reasoning (verified algebraically); `get_kpis`'s current code and missing `currency` field; `CUR-GAP-001`/`CUR-GAP-002` correctly excluded as the same defect class in genuinely distinct, unrelated code; §1/§2/§3 internal consistency; no GDPR/PII exposure. Build baseline reproduced exactly: `main` @ `7a3f0af`, 604/604 tests passing.
