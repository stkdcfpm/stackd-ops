# SPEC-INTEG-002 (Sub-phase 2a) — Fix 2: Currency-mixing bug in Accounts totals bar

**Implements:** `docs/REQ-INTEG-002-2a-fix-2-v1.md` (requirements-gate: PASS, no blocking findings)
**Status:** v2 — supersedes v1. Independent spec-gate review of v1 returned CONDITIONAL PASS (2 blocking, 1 advisory) — all three addressed below; see §4 for the full review-resolution log. §1 (the actual code diff) was independently verified byte-perfect in v1 and is unchanged here — only §2 (the test plan) is revised.

All line numbers below are cited against `main` @ `c2ce5aa` plus this branch's own Priority 2/3/demo-fix commits (see `git log claude/v2963-postship-fixes`), 599/599 tests passing. Re-verify against current branch head before build if any time has passed.

---

## 1. Convert-before-sum + correct currency label in `renderAccts()`'s totals bar

**File:** `index.html`, the "TOTALS BAR" block inside `renderAccts()` (currently `index.html:4800-4816`):

```diff
   // ── TOTALS BAR ────────────────────────────────────────────
-  var tBD = ai.reduce(function(s,i){ return s+(+i.dep||0); },0);
-  var tSD = DB.po.filter(function(p){return p.status!=='Cancelled';})
-    .reduce(function(s,p){return s+getPOEffectiveDep(p);},0);
-  var tFPM = DB.po.filter(function(p){return p.status!=='Cancelled' && !p.fpmRecovered && +p.fpmFunded>0;})
-    .reduce(function(s,p){return s+(+p.fpmFunded||0);},0);
+  // Convert each item to the display currency BEFORE summing — mirrors the
+  // pattern already used correctly in rDash()'s KPI tiles (tPO/tBuyerDep/
+  // tSupDep/tGoodwillCredits). Summing raw native-currency amounts across
+  // items of different currencies produces a meaningless mixed total.
+  var dispCur = QR.displayCurrency || 'GBP';
+  var tBD = ai.reduce(function(s,i){ return s+toDisp(+i.dep||0, i.cur||'USD'); },0);
+  var tSD = DB.po.filter(function(p){return p.status!=='Cancelled';})
+    .reduce(function(s,p){return s+toDisp(getPOEffectiveDep(p), p.cur||'USD');},0);
+  var tFPM = DB.po.filter(function(p){return p.status!=='Cancelled' && !p.fpmRecovered && +p.fpmFunded>0;})
+    .reduce(function(s,p){return s+toDisp(+p.fpmFunded||0, p.cur||'USD');},0);
   var net = tBD - tSD;

   G('acct-totals').innerHTML =
     '<div><div class="dl" style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);margin-bottom:2px;">Total Received from Buyers</div>' +
-      '<div class="kv g" style="font-size:1.1rem;">' + fmt(tBD) + '</div></div>' +
+      '<div class="kv g" style="font-size:1.1rem;">' + fmt(tBD, dispCur) + '</div></div>' +
     '<div><div class="dl" style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);margin-bottom:2px;">Total Paid to Suppliers</div>' +
-      '<div class="kv b" style="font-size:1.1rem;">' + fmt(tSD) + '</div></div>' +
+      '<div class="kv b" style="font-size:1.1rem;">' + fmt(tSD, dispCur) + '</div></div>' +
     '<div><div class="dl" style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);margin-bottom:2px;">Net Cash Position</div>' +
-      '<div class="kv ' + (net>=0 ? 'g' : 'r') + '" style="font-size:1.1rem;">' + fmt(net) + '</div></div>' +
+      '<div class="kv ' + (net>=0 ? 'g' : 'r') + '" style="font-size:1.1rem;">' + fmt(net, dispCur) + '</div></div>' +
     (tFPM > 0 ? '<div><div class="dl" style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--cr);margin-bottom:2px;">FPM Exposure (to recover)</div>' +
-      '<div class="kv r" style="font-size:1.1rem;">' + fmt(tFPM) + '</div></div>' : '');
+      '<div class="kv r" style="font-size:1.1rem;">' + fmt(tFPM, dispCur) + '</div></div>' : '');
```

**Why `net` needs no separate `toDisp()` call:** once `tBD` and `tSD` are each already denominated in `dispCur`, `net = tBD - tSD` is already a valid `dispCur`-denominated figure — the same pattern `rDash()` uses for its own `netCash` (`tBuyerDep - tSupDep - tGoodwillCredits`, each operand pre-converted).

**Why this doesn't touch `renderAccts()`'s per-invoice/per-supplier sections:** those have the identical underlying flaw but pre-date v2.9.63 (§1.1 of the REQ) — explicitly out of scope, logged as `ACCT-GAP-001`.

---

## 2. Tests

Add to `tests/run.js`, in the existing "REQ-INTEG-002-2a-fix-2" test section (created for the Priority 2/3/demo-data fixes already on this branch), following the structural template of the existing precedent test at `tests/run.js:4323` (`resetDB()` → `ctx.DB.po.push()`/`ctx.DB.inv.push()` → `ctx.renderAccts()` → assert on `mockElements['acct-totals'].innerHTML`).

**Mandatory assertion mechanism for tests 1-3 (resolves spec-gate B1):** `fmt()` rounds to 0 decimal places and inserts thousands separators (`Intl.NumberFormat` with `maximumFractionDigits:0`) — a raw computed float (e.g. `4618.107320920379`) will never appear verbatim in rendered `innerHTML`. Each test must therefore compute its expected value by calling the real `ctx.toDisp()` for each item, sum those results exactly as production code does, and then format that expected sum through `ctx.fmt(expectedSum, dispCur)` **before** asserting — comparing formatted-expected against rendered-actual, not raw-float against rendered HTML. Example pattern for test 1:
```js
var dep1 = ctx.getPOEffectiveDep(po1), dep2 = ctx.getPOEffectiveDep(po2);
var expected = ctx.toDisp(dep1, po1.cur) + ctx.toDisp(dep2, po2.cur);
var expectedFormatted = ctx.fmt(expected, ctx.QR.displayCurrency || 'GBP');
ctx.renderAccts();
assertContains(mockElements['acct-totals'].innerHTML, expectedFormatted, '...');
```

**Mandatory `QR.displayCurrency` handling for every test in this section (resolves spec-gate A1):** save `ctx.QR.displayCurrency` at the start of each test and restore it at the end, mirroring the existing precedent elsewhere in this file (e.g. `tests/run.js:5891/5894`, `5899/5902`, `6755/6757`) — there is no global test-isolation reset for `QR`, so any test that changes it must put it back or risk leaking state into later tests.

1. **Mixed-currency `tSD` (the originally reported bug):** construct 2+ POs in different currencies (e.g. one `cur:'CNY'` with a nonzero effective deposit, one `cur:'USD'` with a nonzero effective deposit — at least one via a linked Supplier Payment record so `getPOEffectiveDep()` exercises the ledger path, not just raw `po.dep`). Using the mandatory assertion mechanism above, assert the totals bar shows the correctly-converted-and-formatted sum, not the raw arithmetic sum of the two native amounts (assert the raw-sum's formatted string does NOT appear, as a companion negative assertion).
2. **Mixed-currency `tBD` (the buyer-side case, untested in the original manual pass):** construct 2+ invoices with `dep>0` in different currencies (e.g. `cur:'GBP'` and `cur:'USD'`); assert the same convert-then-sum-then-format behavior.
3. **Mixed-currency `tFPM`:** construct 2+ POs with `fpmFunded>0`, `fpmRecovered:false`, in different currencies; assert the same.
4. **Currency label regression:** save `QR.displayCurrency`, set it to `'RMB'` (a non-GBP, non-USD currency), call `renderAccts()`, and assert `mockElements['acct-totals'].innerHTML` renders the RMB symbol/code (via the same `ctx.fmt(expected, 'RMB')` pre-formatting approach) — not the previous implicit `'USD'` default (`fmt()`'s own default when no currency arg is passed). Restore `QR.displayCurrency` afterward.
5. **Regression guard, corrected premise (resolves spec-gate B2):** `QR_DEFAULTS.displayCurrency` is `'GBP'`, not `'USD'` (`index.html:3376`) — so an all-USD PO/invoice scenario does **not** automatically reproduce the pre-fix raw-sum behavior once converted, since `toDisp(x,'USD')` under the default display currency divides by `QR.fxGBPUSD`, changing the number. The identity "conversion is a no-op" only holds when `QR.displayCurrency` equals the item currency being tested. This test must therefore explicitly save `QR.displayCurrency`, set it to `'USD'`, construct an all-USD-currency scenario (POs and invoices), and assert the total equals the raw arithmetic sum in that specific case — proving the conversion is a true no-op only under the stated precondition, not a general claim about the default state. Restore `QR.displayCurrency` afterward.

---

## 3. Out of scope (explicit, carried from REQ §3)

- `renderAccts()`'s per-invoice/per-supplier view columns — `ACCT-GAP-001`, logged not fixed.
- `rDash()`'s own KPI tiles — unchanged, used only as the reference pattern.
- `getPOEffectiveDep()`/`getPOTotalPaidNative()`/`lockFxRate()` — unchanged.

---

## 4. Spec-gate review resolution log (v1 → v2)

Independent spec-gate review of v1 returned **CONDITIONAL PASS** (2 blocking, 1 advisory). §1 (the code diff) was independently verified byte-perfect against the real `index.html` and required no change. All three findings addressed below, §2 only.

**Blocking:**
- **B1 (assertion mechanism underspecified — would not work as written).** v1's tests 1-3 instructed asserting `innerHTML` "contains a value matching" a raw computed float sum. Reviewer confirmed `fmt()` rounds to 0dp with thousands separators (`Intl.NumberFormat`), so an unformatted float essentially never appears verbatim in rendered output — this left the actual comparison mechanism to the builder's guesswork, the same failure mode a previous spec-gate round in this project caught. **Fixed:** §2 now mandates computing the expected value via the real `ctx.toDisp()`/summing/`ctx.fmt()` chain before comparison — an explicit code example is given — so the expected string is produced by the exact same formatting path as the code under test, with no ambiguity.
- **B2 (test 5's regression-guard premise was mathematically false under default state).** v1 claimed an all-USD scenario reproduces the pre-fix raw sum "automatically" — false, since `QR_DEFAULTS.displayCurrency` is `'GBP'`, not `'USD'`, so `toDisp(x,'USD')` under the default divides by `QR.fxGBPUSD`, changing the number. **Fixed:** §2 now states the corrected precondition explicitly — the test must pin `QR.displayCurrency` to `'USD'` (matching the scenario's own currency) for the no-op identity to actually hold, and restore it afterward.

**Advisory:**
- **A1 (QR state save/restore not specified).** v1's tests 4-5 mutate `ctx.QR.displayCurrency` with no stated save/restore requirement, risking state leakage into later tests (no global test-isolation reset for `QR` exists in this suite). **Fixed:** §2 now states this requirement once, up front, applying to every test in this section, citing the existing precedent pattern already used elsewhere in `tests/run.js`.

**Confirmed correct, no change needed:** the §1 diff (byte-perfect against real `index.html`); the line-range citation (`4800-4816`, unchanged); `toDisp()`/`fmt()` mechanics and the `net`-needs-no-extra-conversion reasoning; the `rDash()` reference-pattern citation; the existing test precedent (`tests/run.js:4323`) as a structural (not assertion-mechanism) template; scope boundaries (no stray changes to per-invoice/per-supplier sections, `rDash()`, or the reconciliation functions).
