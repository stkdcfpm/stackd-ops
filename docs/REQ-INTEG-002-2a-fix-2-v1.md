# REQ-INTEG-002 (Sub-phase 2a) — Fix 2: Currency-mixing bug in Accounts totals bar

**Status:** v1 — requirements-gate independent review: **PASS** (no blocking findings; 2 advisory notes incorporated in place — the test-precedent citation and the `||'USD'` fallback are now spelled out explicitly in §2).
**Type:** Production-bug remediation against already-shipped v2.9.63 (REQ-INTEG-002-2a-fix). Not new scope, not a new REQ number — a further patch row against the same Sub-phase 2a tracker entry.
**Scope:** This document covers only the Priority 1 finding (currency-mixing totals). Priority 2 (PO list not re-rendering), Priority 3 (deposit-field float display, readOnly visual affordance), and the demo-data seed fix are implemented alongside this in the same PR but go through standard build-gate only, per explicit instruction — they involve no design decision and no financial-total-computation change.

---

## 1. Business context

Manual (Cowork-driven) testing of v2.9.63 found that `renderAccts()`'s totals bar (Accounts tab) sums raw, un-converted amounts across POs/Invoices in different currencies and displays the result labeled as a single currency (always `$`, since `fmt(n)` defaults to `USD` when no currency argument is passed). Confirmed concretely: a mix of `CN¥28,000 + $0 + $2,000 + CN¥61,732.28` was summed as raw numbers and displayed as if it were one `$` figure — meaningless as a financial total.

### 1.1 Facts established during check-first (against `main` @ `c2ce5aa`, 594/594 tests passing)

- **`renderAccts()`'s totals bar (`index.html`, "TOTALS BAR" section) has three affected reduces, not the one originally reported:**
  - `tBD` (Total Received from Buyers): `ai.reduce(function(s,i){ return s+(+i.dep||0); },0);` — sums raw `i.dep` across invoices regardless of `i.cur`.
  - `tSD` (Total Paid to Suppliers — the originally reported bug): `DB.po.filter(...).reduce(function(s,p){return s+getPOEffectiveDep(p);},0);` — sums the (correctly PO-native-currency) reconciled figure raw across POs regardless of `p.cur`.
  - `tFPM` (FPM Exposure — not in the original report, found during check-first): `DB.po.filter(...).reduce(function(s,p){return s+(+p.fpmFunded||0);},0);` — identical raw-sum flaw, same block.
  - `net = tBD - tSD` compounds both operands' errors.
- **The established, correct pattern already exists two functions away.** `rDash()`'s KPI tiles (`tPO`, `tBuyerDep`, `tSupDep`, `tGoodwillCredits`) each wrap the per-item amount in `toDisp(amount, itemCur)` *inside* the reduce, before summing — converting every item into a single common currency (`QR.displayCurrency || 'GBP'`) before the sum happens, then render via `fmt(total, dispCur)`. This fix replicates that exact pattern into `renderAccts()`'s totals bar; it does not invent a new mechanism.
- **`fmt(n, c)` (`index.html:3421-3426`) defaults `c` to `'USD'` when omitted** — confirmed the source of the "$"-labeled garbage total the tester observed, since none of the three totals bar calls currently pass a currency argument.
- **Confirmed scope boundary — NOT touching two adjacent things with the identical underlying flaw:**
  - `renderAccts()`'s per-invoice view (`supDepPaid`, `supBalDue`, displayed via `fmt(x, inv.cur)`) and per-supplier view (`totalDep`, `totalBal`, displayed via unlabeled `fmt(x)`) have the same raw-sum-across-possibly-different-currencies flaw whenever a linked PO's currency differs from its invoice's, or a supplier's POs span multiple currencies. **This is pre-existing, predating v2.9.63 entirely** — the pattern was `+p.dep||0` before this session's fix and is `getPOEffectiveDep(p)` now, but the missing conversion was never introduced or removed by that fix. Out of scope here; logged as a new known-gap (`ACCT-GAP-001`) rather than silently expanded or silently ignored.
  - `renderPOPaymentsTab()`'s own "Total Paid (GBP equiv.)" tile is unaffected — it already sums `rateLock.gbpEquiv` (already GBP-denominated) via `getPOTotalPaid()`, unrelated to this bug.

---

## 2. Requirements

### REQ-INTEG-002-2a-fix2-a — Convert before summing in the totals bar
`renderAccts()`'s totals-bar computation must convert each item's native-currency amount into the display currency (`QR.displayCurrency || 'GBP'`) via the existing `toDisp(amount, cur)` function *before* accumulating the sum — for all three totals: `tBD`, `tSD`, `tFPM`. Each item's currency argument must fall back to `'USD'` when absent (`i.cur||'USD'` / `p.cur||'USD'`), exactly matching `rDash()`'s own `tPO`/`tBuyerDep`/`tSupDep` calls (`index.html:4540-4551`) — this is not a new convention, just the existing one carried over unchanged. `net` (`tBD - tSD`) requires no separate change once both operands are already display-currency-denominated.

### REQ-INTEG-002-2a-fix2-b — Label the totals with the correct currency
Each of the four rendered figures (`tBD`, `tSD`, `net`, `tFPM`) must be rendered via `fmt(amount, dispCur)` where `dispCur = QR.displayCurrency || 'GBP'` — not the current bare `fmt(amount)`, which silently mislabels every converted total as USD regardless of what `QR.displayCurrency` actually is.

### REQ-INTEG-002-2a-fix2-c — Tests
Follow the existing precedent test for this exact function/element (`tests/run.js:4323`, "renderAccts() — per-invoice, per-supplier, and totals-bar sections..." — uses `resetDB()`/`ctx.DB.po.push()`/`ctx.DB.inv.push()`, calls `ctx.renderAccts()`, asserts on `mockElements['acct-totals'].innerHTML`) as the mechanical template for all of the below:
- A test constructing POs in 2+ different currencies (matching the tester's exact repro shape — e.g. one CNY, one USD) and asserting `renderAccts()`'s `tSD`-derived totals-bar figure equals the correctly-converted sum, not the raw sum.
- An equivalent test for `tBD` using invoices in 2+ different currencies (the buyer-side case that was untested in the original manual pass because all seeded invoices happened to share one currency).
- A test for `tFPM` with `fpmFunded` set on POs of different currencies.
- A regression test confirming the totals bar's `fmt()` calls receive `dispCur`, not the implicit `'USD'` default — assert the correct currency symbol renders when `QR.displayCurrency` is set to something other than USD/GBP (e.g. RMB).

---

## 3. Out of scope (explicit)

- `renderAccts()`'s per-invoice/per-supplier view columns (`ACCT-GAP-001`, logged not fixed — §1.1).
- Any change to `rDash()`'s own KPI tiles — already correct, used only as the reference pattern.
- Any change to `getPOEffectiveDep()`/`getPOTotalPaidNative()`/`lockFxRate()` — this fix is purely a display-aggregation fix in `renderAccts()`, not a change to the reconciliation mechanism itself.
- Priority 2 (PO list re-render), Priority 3 (deposit-field rounding, readOnly styling), and the demo-data seed fix — implemented in the same PR, but as standard build-gate-only fixes (no design decision, no financial-computation change), per explicit instruction.

---

## 4. Gate process

Full requirements-gate → spec-gate → build-gate for this fix specifically (financial totals display on the Accounts page). Priority 2/3 and the demo-data fix ride in the same PR and same build-gate review pass, but do not require their own requirements-gate/spec-gate documents.
