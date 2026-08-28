# SPEC-INTEG-002 (Sub-phase 2a) — Fix: Reconcile `PO.dep` display with the Supplier Payment ledger

**Implements:** `docs/REQ-INTEG-002-2a-fix-v2.md` (requirements-gate: FAIL v1 → PASS v2, confirmatory re-review)
**Status:** v1.

All line numbers below are cited against `main` @ `8e63bab` (575/575 tests passing). Re-verify against current `main` before build if any time has passed.

---

## 1. Widen `lockFxRate()`; new `fromGBPLocked()` (REQ-INTEG-002-2a-fix-a, -b)

**File:** `index.html:4308-4323` (current `lockFxRate()`, unchanged `toGBP()`/`fromGBP()` above it at `4288-4306` for reference only):

```diff
 function lockFxRate(amount, currency) {
   var cur = (currency || 'USD').toUpperCase();
-  var ratesUsed = {};
-  if (cur === 'USD') ratesUsed.fxGBPUSD = QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD;
-  else if (cur === 'RMB' || cur === 'CNY') ratesUsed.fxGBPRMB = QR.fxGBPRMB || QR_DEFAULTS.fxGBPRMB;
-  else if (cur === 'BBD') ratesUsed.fxGBPBBD = QR.fxGBPBBD || QR_DEFAULTS.fxGBPBBD;
-  // GBP, or any unrecognized currency string: no rate applied, ratesUsed stays {} —
-  // matches toGBP()'s own fall-through branch identically.
+  // Snapshot ALL three static rates at save time, not just the one relevant to this
+  // payment's own currency — a later reconciliation against a DIFFERENT PO currency
+  // (getPOTotalPaidNative(), §3 below) needs a historically-locked rate for that
+  // second leg too, not just the payment's own currency-to-GBP leg.
+  var ratesUsed = {
+    fxGBPUSD: QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD,
+    fxGBPRMB: QR.fxGBPRMB || QR_DEFAULTS.fxGBPRMB,
+    fxGBPBBD: QR.fxGBPBBD || QR_DEFAULTS.fxGBPBBD
+  };
   return {
     amount: +amount || 0,
     currency: cur,
     gbpEquiv: toGBP(amount, cur),
     ratesUsed: ratesUsed,
     ts: new Date().toISOString()
   };
 }
+
+// Converts a GBP amount into `currency` using a PASSED-IN, already-locked rate table
+// (a Supplier Payment record's own rateLock.ratesUsed) instead of the live QR object —
+// mirrors fromGBP()'s branching exactly, but the rate source is historical, not live.
+// Backward-compat fallback: a rate missing from `ratesUsed` (a pre-fix record, which
+// only ever stored ONE key) falls back to the live QR value/QR_DEFAULTS, exactly what
+// fromGBP() itself would do — this path must never be taken for any record created
+// after this fix ships, since lockFxRate() above now always populates all three keys.
+function fromGBPLocked(gbpAmount, currency, ratesUsed) {
+  var n = +gbpAmount || 0;
+  var cur = (currency || 'GBP').toUpperCase();
+  var rates = ratesUsed || {};
+  if (cur === 'GBP') return n;
+  if (cur === 'USD') return n * (rates.fxGBPUSD || QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD);
+  if (cur === 'RMB' || cur === 'CNY') return n * (rates.fxGBPRMB || QR.fxGBPRMB || QR_DEFAULTS.fxGBPRMB);
+  if (cur === 'BBD') return n * (rates.fxGBPBBD || QR.fxGBPBBD || QR_DEFAULTS.fxGBPBBD);
+  return n; // unrecognized currency (e.g. EUR) — never actually reached: getPOEffectiveDep()
+            // (§3) filters via PO_DEP_RECONCILE_CURS before ever calling this function.
+}
```

**Note on the "unrecognized currency" branch:** per REQ-INTEG-002-2a-fix-b, this function is never supposed to be called with an unsupported currency — the allow-list guard in §3 below is the enforcement point. The branch is kept only as a defensive fallback (matching `fromGBP()`'s own identical fallthrough), never exercised in the intended call path. A test in §7 confirms the guard actually prevents this branch from being hit via the real call chain, not just that the branch itself behaves sanely in isolation.

---

## 2. Currency allow-list constant (REQ-INTEG-002-2a-fix-c, §5)

**File:** immediately above the new `getPOTotalPaidNative()`/`getPOEffectiveDep()` functions (§3 below), as a single named constant so it is never duplicated inline:

```diff
+// Currencies getPOEffectiveDep()/getPOTotalPaidNative() can safely reconcile a PO's
+// ledger against. A PO in any OTHER currency (today, only EUR is reachable via
+// pf-cur — index.html:2192) falls back to the legacy po.dep figure rather than
+// risk a silently wrong/mislabeled conversion (see REQ-INTEG-002-2a-fix-v2.md §1.2
+// point 3 for why this guard exists).
+var PO_DEP_RECONCILE_CURS = ['USD', 'GBP', 'RMB', 'CNY', 'BBD'];
```

---

## 3. New `getPOTotalPaidNative(po)`, `getPOEffectiveDepInfo(po)`, `getPOEffectiveDep(po)` (REQ-INTEG-002-2a-fix-c)

**File:** `index.html:11476-11478` (immediately after the existing, unmodified `getPOTotalPaid(poId)`):

```diff
 function getPOTotalPaid(poId) {
   return getPOPayments(poId).reduce(function(s,p){ return s + (+(p.rateLock && p.rateLock.gbpEquiv) || 0); }, 0);
 }
+
+// Sums a PO's linked Supplier Payment records DENOMINATED IN THE PO'S OWN CURRENCY
+// (po.cur), not GBP. Only called once getPOEffectiveDep() below has already confirmed
+// po.cur is in PO_DEP_RECONCILE_CURS — never call this directly with an unsupported
+// PO currency.
+function getPOTotalPaidNative(po) {
+  var poCur = (po.cur || 'USD').toUpperCase();
+  if (poCur === 'CNY') poCur = 'RMB'; // normalize: PO currency uses CNY, payment currency uses RMB — same real currency
+  return getPOPayments(po.id).reduce(function(sum, p) {
+    var pCur = (p.currency || 'USD').toUpperCase();
+    if (pCur === 'CNY') pCur = 'RMB';
+    if (pCur === poCur) {
+      // Same currency as the PO: sum the raw native amount directly. Zero conversion,
+      // zero FX rounding noise — exact, per REQ-INTEG-002-2a-fix-v2.md §1.2 point 2.
+      return sum + (+p.amount || 0);
+    }
+    // Different currency than the PO: pivot through this record's OWN locked
+    // GBP-equivalent, converted into the PO's currency using that SAME record's
+    // own locked rate table — never today's live QR rate for either leg (fix-a/-b).
+    var gbp = (p.rateLock && p.rateLock.gbpEquiv) || 0;
+    var ratesUsed = (p.rateLock && p.rateLock.ratesUsed) || {};
+    return sum + fromGBPLocked(gbp, po.cur, ratesUsed);
+  }, 0);
+}
+
+// Single point of truth for "what should this PO's Deposit Paid figure show." Returns
+// { value, source } — source is one of:
+//   'ledger'                      — reconciled from DB.supPayments via getPOTotalPaidNative()
+//   'legacy-no-records'           — no Supplier Payment records exist yet; raw po.dep
+//   'legacy-unsupported-currency' — records exist, but po.cur isn't in PO_DEP_RECONCILE_CURS; raw po.dep
+// Never mutates po.dep. Safe to call from any read-only render context.
+function getPOEffectiveDepInfo(po) {
+  var payments = getPOPayments(po.id);
+  if (!payments.length) {
+    return { value: +po.dep || 0, source: 'legacy-no-records' };
+  }
+  var poCur = (po.cur || 'USD').toUpperCase();
+  if (poCur === 'CNY') poCur = 'RMB';
+  if (PO_DEP_RECONCILE_CURS.indexOf(poCur) === -1) {
+    return { value: +po.dep || 0, source: 'legacy-unsupported-currency' };
+  }
+  return { value: getPOTotalPaidNative(po), source: 'ledger' };
+}
+
+function getPOEffectiveDep(po) {
+  return getPOEffectiveDepInfo(po).value;
+}
```

**Why `PO_DEP_RECONCILE_CURS.indexOf('RMB')` catches a normalized `'CNY'` correctly:** both `poCur` (normalized above) and the constant itself list `RMB`; a PO whose `pf-cur` is `CNY` is normalized to `'RMB'` before the `indexOf` check, so it correctly matches. `EUR` is never normalized to anything in the list, so it correctly falls through to `'legacy-unsupported-currency'`.

---

## 4. Replace 9 direct read sites with `getPOEffectiveDep(po)` (REQ-INTEG-002-2a-fix-d)

### 4.1 `rPO()` — PO list view

**File:** `index.html:6876`:

```diff
-    var dep=+po.dep||0, bal=liT+(+po.oth||0)-dep, cur=po.cur||'USD';
+    var dep=getPOEffectiveDep(po), bal=liT+(+po.oth||0)-dep, cur=po.cur||'USD';
```

### 4.2 `prevPODoc(po)` — PO PDF

**File:** `index.html:7118`:

```diff
-  var dep=+po.dep||0, oth=+po.oth||0, grand=liT+oth, bal=grand-dep;
+  var dep=getPOEffectiveDep(po), oth=+po.oth||0, grand=liT+oth, bal=grand-dep;
```

### 4.3 `rDash()` — outstanding PO balance KPI and Net Cash Position

**File:** `index.html:4511-4520`:

```diff
   var tPO = DB.po.filter(function(p){ return !p._demo && p.status!=='Cancelled' && p.status!=='Settled'; })
     .reduce(function(s,p){
       var t = (p.lineItems||[]).reduce(function(a,l){ return a + (+l.qty||0)*(+l.cost||0); }, 0);
-      return s + toDisp(t - (+p.dep||0), p.cur||'USD');
+      return s + toDisp(t - getPOEffectiveDep(p), p.cur||'USD');
     }, 0);
   var mg = ai.map(function(i){ return iCalc(i).mgn; }).filter(function(m){ return m !== null && !isNaN(m); });
   var aM = mg.length ? mg.reduce(function(a,b){ return a+b; }, 0) / mg.length : 0;

   // Net cash: total buyer deposits received minus total supplier deposits paid minus goodwill credits issued
   var tBuyerDep = ai.reduce(function(s,i){ return s + toDisp(+i.dep||0, i.cur||'USD'); }, 0);
   var tSupDep = DB.po.filter(function(p){ return !p._demo && p.status!=='Cancelled'; })
-    .reduce(function(s,p){ return s + toDisp(+p.dep||0, p.cur||'USD'); }, 0);
+    .reduce(function(s,p){ return s + toDisp(getPOEffectiveDep(p), p.cur||'USD'); }, 0);
```

`tBuyerDep`'s `i.dep` (buyer Invoice deposit) is untouched — out of scope, buyer-side field, no ledger to reconcile against.

### 4.4 `rDash()` — "PO Commitments" chart

**File:** `index.html:4587`:

```diff
-    return '<div class="br"><div class="bl2">' + san(p.num||gsn(p.supId)||'-') + '</div><div class="bt"><div class="bf bl" style="width:' + (t/mxP*100) + '%"></div></div><div class="bv">' + fmt(t-(+p.dep||0),p.cur||'USD') + '</div></div>';
+    return '<div class="br"><div class="bl2">' + san(p.num||gsn(p.supId)||'-') + '</div><div class="bt"><div class="bf bl" style="width:' + (t/mxP*100) + '%"></div></div><div class="bv">' + fmt(t-getPOEffectiveDep(p),p.cur||'USD') + '</div></div>';
```

### 4.5 `renderAccts()` — per-invoice section

**File:** `index.html:4669`, `4674`:

```diff
-    var supDepPaid  = linkedPOs.reduce(function(s,p){ return s + (+p.dep||0); }, 0);
+    var supDepPaid  = linkedPOs.reduce(function(s,p){ return s + getPOEffectiveDep(p); }, 0);
     var fpmFunded   = linkedPOs.reduce(function(s,p){ return s + (+p.fpmFunded||0); }, 0);
     var fpmRecovered= linkedPOs.every(function(p){ return !p.fpmFunded || p.fpmRecovered; });
     var supBalDue   = linkedPOs.reduce(function(s,p){
       var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
-      return s + Math.max(0, t + (+p.oth||0) - (+p.dep||0));
+      return s + Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p));
     }, 0);
```

### 4.6 `renderAccts()` — per-supplier section

**File:** `index.html:4734`, `4737`:

```diff
-    var totalDep = s.pos.reduce(function(a,p){ return a+(+p.dep||0); },0);
+    var totalDep = s.pos.reduce(function(a,p){ return a+getPOEffectiveDep(p); },0);
     var totalBal = s.pos.reduce(function(a,p){
       var t=(p.lineItems||[]).reduce(function(b,l){return b+(+l.qty||0)*(+l.cost||0);},0);
-      return a+Math.max(0,t+(+p.oth||0)-(+p.dep||0));
+      return a+Math.max(0,t+(+p.oth||0)-getPOEffectiveDep(p));
     },0);
```

**Note:** the local parameter name here is `s` for the outer `supMap` entry and `p`/`a` for the inner reduce — `s.pos` is an array of PO objects, `p` inside each reduce is a single PO. `getPOEffectiveDep(p)` is correct; do not confuse with the outer `s`.

### 4.7 `renderAccts()` — totals bar

**File:** `index.html:4772` only (NOT `4770` — that line sums `i.dep`, a buyer Invoice field, out of scope):

```diff
   var tBD = ai.reduce(function(s,i){ return s+(+i.dep||0); },0);
   var tSD = DB.po.filter(function(p){return p.status!=='Cancelled';})
-    .reduce(function(s,p){return s+(+p.dep||0);},0);
+    .reduce(function(s,p){return s+getPOEffectiveDep(p);},0);
```

`net = tBD - tSD` (unchanged line, just below) automatically reflects the reconciled figure once `tSD` does — no separate change needed for Net Cash Position itself.

### 4.8 `_aiExecTool()` — `get_kpis`

**File:** `index.html:9204-9207`:

```diff
       var poBal = DB.po.filter(function(p){ return p.status!=='Completed'&&p.status!=='Cancelled'; })
         .reduce(function(s,p){
           var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
-          return s + Math.max(0, t + (+p.oth||0) - (+p.dep||0));
+          return s + Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p));
         }, 0);
```

### 4.9 `_aiExecTool()` — `get_pos`

**File:** `index.html:9251-9256`:

```diff
         var lineTotal = (po.lineItems||[]).reduce(function(s,l){ return s+(+l.qty||0)*(+l.cost||0); },0);
-        var balance   = Math.max(0, lineTotal + (+po.oth||0) - (+po.dep||0));
+        var effDep    = getPOEffectiveDep(po);
+        var balance   = Math.max(0, lineTotal + (+po.oth||0) - effDep);
         return { num: po.num, supplier: sup ? sup.name : po.supId, date: po.date,
                  status: po.status, currency: po.cur||'USD',
-                 lineTotal: +lineTotal.toFixed(2), depositPaid: +(+po.dep||0).toFixed(2),
+                 lineTotal: +lineTotal.toFixed(2), depositPaid: +effDep.toFixed(2),
                  balanceDue: +balance.toFixed(2) };
```

---

## 5. The 10th site: `editPO()`/`calcPO()` — no change to `calcPO()` (REQ-INTEG-002-2a-fix-d, -e)

`calcPO()` (`index.html:6847-6857`) is **not modified**. It already derives its `dep` local variable purely from `G('pf-dep').value` (line 6850) with no reference to `po`/`DB.po` — once `editPO()` populates that field correctly (below), `calcPO()`'s existing code renders the right figure automatically.

### 5.1 `editPO()` — populate `pf-dep` with the reconciled figure and set readonly state

**File:** `index.html:6818-6827` (current `editPO()`):

```diff
 function editPO(id) {
   var po=DB.po.find(function(x){return x.id===id;}); if(!po) return;
   EI.p=id; cPL=JSON.parse(JSON.stringify(po.lineItems||[]));
   G('po-mt').textContent='Edit PO'; G('po-sm').value=po.status||'Draft';
   G('pf-n').value=po.num||''; G('pf-dt').value=po.date||today();
   G('pf-del').value=po.del||''; G('pf-sup').value=po.supId||'';
-  G('pf-cur').value=po.cur||'USD'; G('pf-dep').value=po.dep||'';
+  G('pf-cur').value=po.cur||'USD';
   G('pf-oth').value=po.oth||''; G('pf-nt').value=po.notes||''; G('pf-inv').value=po.invNum||''; G('pf-pt').value=po.paymentTerms||'';
+  var depInfo = getPOEffectiveDepInfo(po);
+  G('pf-dep').value = depInfo.value || '';
+  G('pf-dep').readOnly = (depInfo.source === 'ledger');
+  renderPoDepNote(depInfo);
   renderPoSourceDriftWarn(po);
   rPLT(); calcPO(); showV('po',document.querySelector('[data-v="po"]')); G('ov-po').classList.add('on');
 }
```

**Why `depInfo` is fetched once and both `.value` and `.readOnly`/the note derive from it:** confirmatory re-review of the REQ (advisory note) flagged that computing `getPOEffectiveDep()` and `getPOEffectiveDepInfo()` separately would be redundant and could theoretically drift if ever changed independently — `getPOEffectiveDep(po)` is defined as `getPOEffectiveDepInfo(po).value` (§3) specifically so this single call in `editPO()` is sufficient and can never disagree with itself.

**New in `editPO()` — creating a brand-new PO (`EI.p` was falsy before this call).** `getPOEffectiveDepInfo(po)` is only called with a real, found `po` (the function returns early via `if(!po) return;` for a lookup miss) — this covers the "editing an existing PO" path. A brand-new PO (opened via `openNewPO()` or equivalent, not `editPO()`) never reaches this function at all, so `pf-dep` remains in whatever default/editable state that separate code path already sets it to — no new PO can ever have `readOnly` set true by this change, since `getPOPayments(po.id)` cannot return records for a `poId` that doesn't exist yet in `DB.supPayments`. (SPEC confirms no change needed to the "new PO" open path — verify `openNewPO()`, or whatever resets `ov-po` for a new record, doesn't need a corresponding `readOnly=false`/note-clear reset; if it re-uses `editPO()`-populated DOM state from a previous edit without clearing `pf-dep.readOnly`, add a one-line reset there instead of assuming a fresh `readOnly` default. Confirm against the actual "new PO" trigger during build and adjust if the field's `readOnly` state can leak between opens.)

### 5.2 New `renderPoDepNote(depInfo)` — inline explanatory note

**File:** immediately after `renderPoSourceDriftWarn()` (`index.html:5918-...`, ends before `editPO()` at `6818`):

```diff
+function renderPoDepNote(depInfo) {
+  var el = G('po-dep-note');
+  if (!el) return;
+  if (depInfo.source === 'ledger') {
+    el.innerHTML = '<div style="font-size:.48rem;color:var(--m);margin-top:2px;">Derived from recorded Supplier Payments — use the $ action to add another payment.</div>';
+  } else if (depInfo.source === 'legacy-unsupported-currency') {
+    el.innerHTML = '<div style="font-size:.48rem;color:#B8283A;margin-top:2px;">&#9888; Supplier Payments exist for this PO but its currency cannot yet be reconciled automatically — showing the manually-entered figure. This value is not derived from the ledger.</div>';
+  } else {
+    el.innerHTML = '';
+  }
+}
```

### 5.3 New `<div id="po-dep-note">` container in the Edit PO modal HTML

**File:** `index.html:2201` (the `pf-dep` field's line, inside the `.fg.fg3` group that also contains `pf-fpm`/`pf-oth`):

```diff
-        <div class="fld"><label id="lbl-po-dep">Supplier Deposit Paid</label><input type="number" id="pf-dep" placeholder="0.00" step="0.01" oninput="calcPO()" style="border-bottom-color:var(--bl);background:rgba(26,79,219,.04);"></div>
+        <div class="fld"><label id="lbl-po-dep">Supplier Deposit Paid</label><input type="number" id="pf-dep" placeholder="0.00" step="0.01" oninput="calcPO()" style="border-bottom-color:var(--bl);background:rgba(26,79,219,.04);"><div id="po-dep-note"></div></div>
```

### 5.4 `savePO()` — no change

`savePO()` (`index.html:6858-6869`) continues to read `+G('pf-dep').value||0` unchanged. With `readOnly` (not `disabled`) set on the input, `.value` is always a plain, reliable read of whatever the field currently displays — no branching needed in `savePO()` for the two states.

---

## 6. Test plan (maps to `docs/REQ-INTEG-002-2a-fix-v2.md` §4)

All new tests added to the existing "Supplier Payment ledger (REQ-INTEG-002 2a)" section of `tests/run.js`, immediately after the 12 existing tests (before the "REQ-MTD-001: VAT Return" section, per the existing file layout).

**AC set 1 — `lockFxRate()`/`fromGBPLocked()`:**
1. `lockFxRate(920, 'RMB')` — `ratesUsed` now has all three keys (`fxGBPUSD`, `fxGBPRMB`, `fxGBPBBD`), not one. (Replaces the assertion at `tests/run.js:4092`.)
2. `lockFxRate(50, 'GBP')` — `ratesUsed` now has all three keys even though `gbpEquiv` used none of them (identity conversion). (Replaces the assertion at `tests/run.js:4125`.)
3. `tests/run.js:4112`'s existing assertion (a specific rate's *value*) — confirm it still passes unmodified; no new test needed, just a regression check.
4. `fromGBPLocked(100, 'USD', {fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5})` → `125`.
5. `fromGBPLocked(100, 'RMB', {...})` and `fromGBPLocked(100, 'CNY', {...})` → identical result (alias).
6. `fromGBPLocked(100, 'GBP', {})` → `100` (identity, no rate needed).
7. Backward-compat: `fromGBPLocked(100, 'USD', {fxGBPRMB: 9.0})` (a pre-fix single-key `ratesUsed`, missing `fxGBPUSD`) — falls back to live `QR.fxGBPUSD`/`QR_DEFAULTS.fxGBPUSD`, does not throw or return `NaN`.

**AC set 2 — `getPOTotalPaidNative()`/`getPOEffectiveDep()`/`getPOEffectiveDepInfo()`:**
8. PO with `cur:'USD'`, two Supplier Payment records both `currency:'USD'` — `getPOTotalPaidNative()` returns the exact raw sum, and a test that first mutates `QR.fxGBPUSD` to a wrong value confirms the result is completely unaffected (proves the same-currency path never touches FX at all).
9. PO with `cur:'USD'`, one `USD` record + one `RMB` record — result equals `usdAmount + fromGBPLocked(rmbRecord.rateLock.gbpEquiv, 'USD', rmbRecord.rateLock.ratesUsed)`; then mutate `QR.fxGBPUSD`/`QR.fxGBPRMB` and re-run — result must be unchanged (proves the cross-currency leg uses the record's own locked rates, not live `QR`).
10. PO with `cur:'CNY'`, a Supplier Payment record with `currency:'RMB'` — same-currency path taken (raw sum), proving the `CNY`/`RMB` normalization applies on both sides of the comparison.
11. `getPOEffectiveDepInfo(po)` with zero linked records → `{value: po.dep, source:'legacy-no-records'}`.
12. `getPOEffectiveDepInfo(po)` with `cur:'EUR'` and one or more linked records → `{value: po.dep, source:'legacy-unsupported-currency'}` — **this is the test that proves the v1 regression risk (a EUR PO getting a silently wrong PDF figure) is actually closed**, not just documented as avoided.
13. `getPOEffectiveDep(po)` returns exactly `getPOEffectiveDepInfo(po).value` for all three source cases (guards against the two ever being reimplemented independently and drifting).

**AC set 3 — call-site wiring (one test per site, 9 direct + 1 indirect):**
14–22. For each of `rPO()`, `prevPODoc()`, `rDash()` (KPI tPO/tSupDep), `rDash()` (PO chart), `renderAccts()` (×3), `_aiExecTool()` `get_kpis`, `_aiExecTool()` `get_pos`: construct a PO with linked Supplier Payment records whose ledger total differs from `po.dep`, and assert the rendered/returned figure matches the ledger total, not `po.dep`. Where the existing test harness's `mockEl()`/DOM-based rendering makes a full UI assertion impractical for a given function, assert via the underlying data-producing function directly (e.g. `_aiExecTool('get_pos', {})`'s returned JSON, parsed) rather than skipping the site.
23. `editPO(id)` on a PO with linked records and a supported currency — `G('pf-dep').value` equals the ledger total and `G('pf-dep').readOnly` is `true`.
24. `editPO(id)` on a PO with zero linked records — `G('pf-dep').value` equals raw `po.dep` and `readOnly` is `false`.
25. `editPO(id)` on a PO with linked records but `cur:'EUR'` — `G('pf-dep').value` equals raw `po.dep` and `readOnly` is `false` (the unsupported-currency case remains editable, per REQ-INTEG-002-2a-fix-e).
26. `calcPO()` itself needs no new test beyond confirming (via test 23/24 above) that its output tiles reflect whatever `pf-dep` was populated with — no direct `calcPO()` test change, per REQ-INTEG-002-2a-fix-v2.md §8 B-3's resolution.

**AC set 4 — `pf-dep` read-only/editable + `savePO()`:**
27. `savePO()` on a PO whose `pf-dep` is `readOnly` and displays the ledger-derived figure — confirm the saved `po.dep` equals that displayed figure (i.e. `savePO()`'s unmodified read-path correctly persists whatever the reconciled figure was, keeping `po.dep` a reasonable snapshot even though it's no longer the display source of truth once records exist).

**AC set 5 — backward compatibility:**
28. Existing/demo-style PO with `dep>0` and zero `DB.supPayments` records — `getPOEffectiveDep()` returns the raw `dep` unchanged; none of the 9 direct call sites' output changes versus pre-fix behavior for this PO.

**AC set 6 — full regression:** run the complete suite; expect the 2 corrected 2a tests (§ above, items 1-2) plus all new tests passing, with zero unrelated regressions. Target: 575 (current) − 2 (replaced, not removed) + ~26 new ≈ 599 tests, exact count to be confirmed at build time.

---

## 7. Out of scope reminders for build (carried from REQ, not new)

- `PO.fpmFunded` is not touched by any of the above — no ledger exists to reconcile it against.
- CSV import handlers (`index.html:7757, 7799, 8090, 8143`) and `autoPos()`'s `dep:0` (`index.html:5908`) are writes, not reads — no change.
- `docs/known-gaps.md`: add `PROC-GAP-002` (EUR FX gap) as part of this build's doc updates, per REQ §7 — not a code change, a documentation deliverable of this same PR.
