# SPEC-INTEG-002 (Sub-phase 2a) — Fix 2: Currency-mixing bug in Accounts totals bar

**Implements:** `docs/REQ-INTEG-002-2a-fix-2-v1.md` (requirements-gate: PASS, no blocking findings)
**Status:** v1.

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

Add to `tests/run.js`, in the existing "REQ-INTEG-002-2a-fix-2" test section (created for the Priority 2/3/demo-data fixes already on this branch):

1. **Mixed-currency `tSD` (the originally reported bug):** construct 2+ POs in different currencies (e.g. one `cur:'CNY'` with a nonzero effective deposit, one `cur:'USD'` with a nonzero effective deposit — at least one via a linked Supplier Payment record so `getPOEffectiveDep()` exercises the ledger path, not just raw `po.dep`). Call `renderAccts()`, then assert `mockElements['acct-totals'].innerHTML` contains a value matching `toDisp(dep1,'CNY') + toDisp(dep2,'USD')` (computed independently in the test, not by re-deriving the production code's own formula) — not the raw arithmetic sum of the two native amounts.
2. **Mixed-currency `tBD` (the buyer-side case, untested in the original manual pass):** construct 2+ invoices with `dep>0` in different currencies (e.g. `cur:'GBP'` and `cur:'USD'`); assert the same convert-then-sum behavior.
3. **Mixed-currency `tFPM`:** construct 2+ POs with `fpmFunded>0`, `fpmRecovered:false`, in different currencies; assert the same.
4. **Currency label regression:** set `QR.displayCurrency = 'RMB'` (or another non-GBP, non-USD currency), call `renderAccts()`, and assert `mockElements['acct-totals'].innerHTML` renders the RMB symbol/code (via `Intl.NumberFormat`) for `tBD`/`tSD`/`net` — not the previous implicit `'USD'` default (`fmt()`'s own default when no currency arg is passed).
5. **Regression guard:** a same-currency-only scenario (all POs/invoices in USD) must produce an identical total to what the pre-fix code would have produced — proves the conversion is a no-op when there's nothing to convert, not a behavior change for the common single-currency case.

---

## 3. Out of scope (explicit, carried from REQ §3)

- `renderAccts()`'s per-invoice/per-supplier view columns — `ACCT-GAP-001`, logged not fixed.
- `rDash()`'s own KPI tiles — unchanged, used only as the reference pattern.
- `getPOEffectiveDep()`/`getPOTotalPaidNative()`/`lockFxRate()` — unchanged.
