# SPEC-CUR-002 — Convert-before-summing fix for `renderAccts()` and `get_kpis`

**Status:** v1 — implements `docs/REQ-CUR-002-v1.md` (requirements-gate: CONDITIONAL PASS, 3 advisories resolved in place).
**Build baseline:** `main` @ `7a3f0af`, 604/604 tests passing.

---

## 1. `renderAccts()` — `index.html:4695-4834`

### 1.1 Hoist `dispCur` to the top of the function

Current line 1 of the function body:
```js
function renderAccts() {
  var ai = DB.inv.filter(function(i){ return i.status !== 'Cancelled'; });
```
becomes:
```js
function renderAccts() {
  var ai = DB.inv.filter(function(i){ return i.status !== 'Cancelled'; });
  var dispCur = QR.displayCurrency || 'GBP';
```

Remove the now-redundant re-declaration in the TOTALS BAR section (currently `index.html:4814`, comment block above it retained as-is since it documents the same pattern now used more broadly):
```js
     var dispCur = QR.displayCurrency || 'GBP';
     var tBD = ai.reduce(...
```
becomes:
```js
     var tBD = ai.reduce(...
```
(the `dispCur` variable itself is dropped from this block; every other line in the TOTALS BAR section is unchanged since it already used `toDisp()`/`dispCur` correctly).

### 1.2 Per-invoice view — `supDepPaid`, `fpmFunded`, `supBalDue`, `totalToChase`

Current:
```js
       var supDepPaid  = linkedPOs.reduce(function(s,p){ return s + getPOEffectiveDep(p); }, 0);
       var fpmFunded   = linkedPOs.reduce(function(s,p){ return s + (+p.fpmFunded||0); }, 0);
       var fpmRecovered= linkedPOs.every(function(p){ return !p.fpmFunded || p.fpmRecovered; });
       var supBalDue   = linkedPOs.reduce(function(s,p){
         var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
         return s + Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p));
       }, 0);

       // Total to chase = invoice balance + any unrecovered FPM-funded deposits
       var unrecoveredFPM = fpmRecovered ? 0 : fpmFunded;
       var totalToChase = balFromBuyer + unrecoveredFPM;
```
becomes:
```js
       // Convert each linked PO's figure to the display currency BEFORE
       // summing — a PO's own currency may differ from this invoice's, and
       // from other linked POs'. Mirrors the totals-bar pattern.
       var supDepPaid  = linkedPOs.reduce(function(s,p){ return s + toDisp(getPOEffectiveDep(p), p.cur||'USD'); }, 0);
       var fpmFunded   = linkedPOs.reduce(function(s,p){ return s + toDisp(+p.fpmFunded||0, p.cur||'USD'); }, 0);
       var fpmRecovered= linkedPOs.every(function(p){ return !p.fpmFunded || p.fpmRecovered; });
       var supBalDue   = linkedPOs.reduce(function(s,p){
         var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
         return s + toDisp(Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p)), p.cur||'USD');
       }, 0);

       // Total to chase = invoice balance + any unrecovered FPM-funded deposits.
       // balFromBuyer is buyer-native; fpmFunded is now already in dispCur — both
       // must be in the same currency before adding, since the buyer's currency
       // can differ from the supplier POs' currency.
       var unrecoveredFPM = fpmRecovered ? 0 : fpmFunded;
       var totalToChase = toDisp(balFromBuyer, cur) + unrecoveredFPM;
```

Note: `supDepPaid`, `fpmFunded`, `supBalDue`, `totalToChase` are now all in `dispCur`, not in the invoice's own `cur`. `c.grand`, `buyerDep`, `balFromBuyer` are unchanged (still invoice-native), rendered with `cur` exactly as before.

### 1.3 Per-invoice view — render cells

Current:
```js
       var fpmCell = fpmFunded > 0
         ? (fpmRecovered
             ? '<span style="color:var(--gn);font-size:.52rem;">&#10003; Recovered</span>'
             : '<span style="color:var(--cr);">' + fmt(fpmFunded,cur) + '</span>')
         : '-';

       var chaseCell = totalToChase > 0
         ? '<span style="color:var(--cr);font-weight:600;">' + fmt(totalToChase,cur) + (unrecoveredFPM>0?' <span style="font-size:.48rem;">(inc. FPM dep)</span>':'') + '</span>'
         : '<span style="color:var(--gn);">&#10003; Settled</span>';
```
becomes (only the `fmt()` currency argument changes, `cur` → `dispCur`):
```js
       var fpmCell = fpmFunded > 0
         ? (fpmRecovered
             ? '<span style="color:var(--gn);font-size:.52rem;">&#10003; Recovered</span>'
             : '<span style="color:var(--cr);">' + fmt(fpmFunded,dispCur) + '</span>')
         : '-';

       var chaseCell = totalToChase > 0
         ? '<span style="color:var(--cr);font-weight:600;">' + fmt(totalToChase,dispCur) + (unrecoveredFPM>0?' <span style="font-size:.48rem;">(inc. FPM dep)</span>':'') + '</span>'
         : '<span style="color:var(--gn);">&#10003; Settled</span>';
```

And in the row template, current:
```js
         '<td class="num" style="color:var(--bl);">' + (supDepPaid ? fmt(supDepPaid,cur) : '-') + '</td>' +
         '<td class="num">' + fpmCell + '</td>' +
         '<td class="num ' + (supBalDue>0?'neg':'') + '">' + (supBalDue>0 ? fmt(supBalDue,cur) : (linkedPOs.length?'<span style="color:var(--gn);">&#10003;</span>':'-')) + '</td>' +
```
becomes:
```js
         '<td class="num" style="color:var(--bl);">' + (supDepPaid ? fmt(supDepPaid,dispCur) : '-') + '</td>' +
         '<td class="num">' + fpmCell + '</td>' +
         '<td class="num ' + (supBalDue>0?'neg':'') + '">' + (supBalDue>0 ? fmt(supBalDue,dispCur) : (linkedPOs.length?'<span style="color:var(--gn);">&#10003;</span>':'-')) + '</td>' +
```
(`c.grand`, `buyerDep`, `balFromBuyer` cells above these are unchanged — still `fmt(x, cur)`.)

Add a one-line header note so a future reader isn't surprised that some columns in this row are `dispCur` and some are `cur` — insert directly above the `invRows` map, before `var invRows = ai.slice().reverse().map(...)`:
```js
     // NOTE: Invoice Total / Buyer Dep. Rec. / Buyer Bal. Due render in the
     // invoice's own native currency (cur). Sup. Dep. Paid / FPM Funded /
     // Sup. Bal. Due / Total to Chase render in dispCur, since they aggregate
     // figures that may span multiple PO currencies.
```

### 1.4 Per-supplier view — `totalCOGS`, `totalDep`, `totalBal`

Current:
```js
       var totalCOGS = s.pos.reduce(function(a,p){
         return a + (p.lineItems||[]).reduce(function(b,l){ return b+(+l.qty||0)*(+l.cost||0); },0);
       }, 0);
       var totalDep = s.pos.reduce(function(a,p){ return a+getPOEffectiveDep(p); },0);
       var totalBal = s.pos.reduce(function(a,p){
         var t=(p.lineItems||[]).reduce(function(b,l){return b+(+l.qty||0)*(+l.cost||0);},0);
         return a+Math.max(0,t+(+p.oth||0)-getPOEffectiveDep(p));
       },0);
```
becomes:
```js
       var totalCOGS = s.pos.reduce(function(a,p){
         var t = (p.lineItems||[]).reduce(function(b,l){ return b+(+l.qty||0)*(+l.cost||0); },0);
         return a + toDisp(t, p.cur||'USD');
       }, 0);
       var totalDep = s.pos.reduce(function(a,p){ return a+toDisp(getPOEffectiveDep(p), p.cur||'USD'); },0);
       var totalBal = s.pos.reduce(function(a,p){
         var t=(p.lineItems||[]).reduce(function(b,l){return b+(+l.qty||0)*(+l.cost||0);},0);
         return a+toDisp(Math.max(0,t+(+p.oth||0)-getPOEffectiveDep(p)), p.cur||'USD');
       },0);
```
`pct` (`(totalDep/totalCOGS)*100`) is unchanged — it's now automatically correct once both inputs are in `dispCur` (ratio-invariance, REQ-CUR-002 §1.1).

Render cells — current:
```js
         '<td class="num">' + fmt(totalCOGS) + '</td>' +
         '<td class="num" style="color:var(--bl);">' + fmt(totalDep) + '</td>' +
         '<td class="num ' + (totalBal>0?'neg':'pos') + '">' + fmt(totalBal) + '</td>' +
```
becomes:
```js
         '<td class="num">' + fmt(totalCOGS,dispCur) + '</td>' +
         '<td class="num" style="color:var(--bl);">' + fmt(totalDep,dispCur) + '</td>' +
         '<td class="num ' + (totalBal>0?'neg':'pos') + '">' + fmt(totalBal,dispCur) + '</td>' +
```

---

## 2. `_aiExecTool('get_kpis')` — `index.html:9279-9305`

Current:
```js
   if (name === 'get_kpis') {
     var activeInvs = DB.inv.filter(function(i){
       return i.status !== 'Cancelled' && i.type !== 'credit_note' && i.type !== 'goodwill_credit' && !isCN(i.num);
     });
     var revenue = activeInvs.reduce(function(s,i){ return s + iCalc(i).grand; }, 0);
     var np      = activeInvs.reduce(function(s,i){ return s + iCalc(i).np;    }, 0);
     var outstanding = activeInvs.filter(function(i){
       return i.status==='Partially Paid'||i.status==='Sent'||i.status==='Pro-forma';
     }).reduce(function(s,i){ return s + iCalc(i).bal; }, 0);
     var poBal = DB.po.filter(function(p){ return p.status!=='Completed'&&p.status!=='Cancelled'; })
       .reduce(function(s,p){
         var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
         return s + Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p));
       }, 0);
     return JSON.stringify({
       invoiceRevenue:      +revenue.toFixed(2),
       netProfit:           +np.toFixed(2),
       avgMargin:           revenue > 0 ? +(np/revenue*100).toFixed(1) : 0,
       outstanding:         +outstanding.toFixed(2),
       poBalanceDue:        +poBal.toFixed(2),
       inTransitShipments:  DB.sh.filter(function(s){ return s.status==='In Transit'; }).length,
       totalInvoices:       activeInvs.length,
       totalSuppliers:      DB.sup.length,
       totalShipments:      DB.sh.length,
       totalPOs:            DB.po.length
     });
   }
```
becomes:
```js
   if (name === 'get_kpis') {
     var dispCur = QR.displayCurrency || 'GBP';
     var activeInvs = DB.inv.filter(function(i){
       return i.status !== 'Cancelled' && i.type !== 'credit_note' && i.type !== 'goodwill_credit' && !isCN(i.num);
     });
     // Convert each invoice/PO figure to the display currency before summing —
     // invoices/POs may be denominated in different currencies (see ACCT-GAP-001).
     var revenue = activeInvs.reduce(function(s,i){ return s + toDisp(iCalc(i).grand, i.cur||'USD'); }, 0);
     var np      = activeInvs.reduce(function(s,i){ return s + toDisp(iCalc(i).np,    i.cur||'USD'); }, 0);
     var outstanding = activeInvs.filter(function(i){
       return i.status==='Partially Paid'||i.status==='Sent'||i.status==='Pro-forma';
     }).reduce(function(s,i){ return s + toDisp(iCalc(i).bal, i.cur||'USD'); }, 0);
     var poBal = DB.po.filter(function(p){ return p.status!=='Completed'&&p.status!=='Cancelled'; })
       .reduce(function(s,p){
         var t = (p.lineItems||[]).reduce(function(a,l){ return a+(+l.qty||0)*(+l.cost||0); },0);
         return s + toDisp(Math.max(0, t + (+p.oth||0) - getPOEffectiveDep(p)), p.cur||'USD');
       }, 0);
     return JSON.stringify({
       currency:            dispCur,
       invoiceRevenue:      +revenue.toFixed(2),
       netProfit:           +np.toFixed(2),
       avgMargin:           revenue > 0 ? +(np/revenue*100).toFixed(1) : 0,
       outstanding:         +outstanding.toFixed(2),
       poBalanceDue:        +poBal.toFixed(2),
       inTransitShipments:  DB.sh.filter(function(s){ return s.status==='In Transit'; }).length,
       totalInvoices:       activeInvs.length,
       totalSuppliers:      DB.sup.length,
       totalShipments:      DB.sh.length,
       totalPOs:            DB.po.length
     });
   }
```
`avgMargin` is unchanged — automatically correct once `revenue`/`np` are consistently converted (ratio-invariance, REQ-CUR-002 §1.1).

---

## 3. `AI_TOOLS`'s `get_kpis` entry — `index.html:9203-9207`

Current:
```js
  {
    name: 'get_kpis',
    description: 'Get current dashboard KPI values: total invoice revenue, net profit, average margin, total outstanding balance, PO balance due, in-transit shipment count, and entity counts.',
    input_schema: { type: 'object', properties: {} }
  },
```
becomes:
```js
  {
    name: 'get_kpis',
    description: 'Get current dashboard KPI values: total invoice revenue, net profit, average margin, total outstanding balance, PO balance due, in-transit shipment count, and entity counts. All monetary figures are converted to and returned in a single common currency, given in the response\'s currency field — do not assume USD.',
    input_schema: { type: 'object', properties: {} }
  },
```

---

## 4. Tests — `tests/run.js`

Following the established pattern at `tests/run.js:4548-4571` (save/restore `ctx.QR.displayCurrency`, compute expected via `ctx.toDisp()` then `ctx.fmt()`, assert against rendered HTML or parsed JSON):

1. **`renderAccts` per-invoice, multi-currency POs** — one invoice (native `cur`, e.g. `'USD'`) with 2 linked POs in different currencies (e.g. one `'GBP'`, one `'USD'`), one PO with `fpmFunded` set and unrecovered. Set `QR.displayCurrency` to a third currency (e.g. `'EUR'` — check `PO_DEP_RECONCILE_CURS`/EUR exclusion doesn't block this; if EUR is excluded from PO.dep reconciliation, use `'GBP'` as `dispCur` instead to avoid conflating two different known-gap areas). Compute expected `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` via `ctx.toDisp()` per the SPEC formulas above, format via `ctx.fmt(expected, dispCur)`, assert each appears in `mockElements['acct-inv'].innerHTML`.
2. **`renderAccts` per-supplier, multi-currency POs** — one supplier with 2 POs in different currencies. Compute expected `totalCOGS`/`totalDep`/`totalBal` the same way; assert `pct` equals `((expectedDep/expectedCOGS)*100).toFixed(0)`.
3. **`get_kpis`, multi-currency invoices/POs** — invoices and POs spanning 2+ currencies; call `_aiExecTool('get_kpis')` (or however the harness invokes it — check existing AI-tool test precedent in `tests/run.js` for the correct call surface), `JSON.parse()` the result, assert `invoiceRevenue`/`netProfit`/`outstanding`/`poBalanceDue` match `toDisp()`-summed expected values (rounded to 2dp per `.toFixed(2)`), and assert `currency === (QR.displayCurrency||'GBP')`.
4. **Same-currency regression guards** for all three sites above — single-currency scenario, `QR.displayCurrency` explicitly pinned to that scenario's own currency, confirms output is unchanged from pre-fix behavior.
5. Save/restore `ctx.QR.displayCurrency` in every test above (no global reset exists for `QR`).

---

## 5. Out of scope (unchanged from REQ)

`CUR-GAP-001`, `CUR-GAP-002`, `getPOEffectiveDep()`/`toDisp()`/`toGBP()`/`fromGBP()` internals, `renderPOPaymentsTab()`, `rDash()`. No other `AI_TOOLS` entries touched.
