# SPEC-RPT-001 G-02 & G-03 v1 — Aging Report + P&L by Dimension

**Requirement:** REQ-RPT-001-v1.md (G-02, G-03)  
**Version target:** v2.9.35  
**Status:** PASS (spec-gate 2026-06-25) — LOW gap noted: AC-2 conjunction test (Partially Paid + 90+ bucket) to be added at build time  
**FM-1:** Approved — UI panels, computed from existing `DB.inv` / `DB.payments`; no new entities

---

## Overview

Two new report panels added to the Invoices tab toolbar:

- **G-02 — Aging Report:** Invoice aging by bucket (Current / 0–30 / 31–60 / 61–90 / 90+ days) with DSO KPI and CSV export.
- **G-03 — P&L Report:** Profit & loss broken down by Buyer or by Period (monthly/quarterly), with date range filter and CSV export.

Both panels follow the same pattern as the existing VAT Return panel: a toolbar button opens a modal; the modal renders the report; export downloads a CSV.

---

## §1 — G-02: Aging Report

### 1.1 Toolbar button

In the Invoices tab toolbar (the same bar containing `[VAT Return]`, `[Accounting Export]`, etc.), add:

```html
<button class="btn btn-g" onclick="openAgingReport()" style="font-size:.52rem;">Aging</button>
```

### 1.2 Modal HTML (`ov-aging`)

Add a new modal `ov-aging` following the same structure as `ov-vat`. Key elements:

```html
<div class="modal-overlay" id="ov-aging" style="display:none;">
  <div class="modal" style="max-width:780px;">
    <div class="modal-hdr">
      <h2 style="font-size:.82rem;">Aging Report</h2>
      <button onclick="closeM('ov-aging')" class="cls-btn">&#10005;</button>
    </div>
    <div class="modal-body">
      <div id="aging-kpi" style="margin-bottom:16px;"></div>
      <table id="aging-tbl" style="width:100%;font-size:.58rem;border-collapse:collapse;"></table>
      <div id="aging-summary" style="margin-top:12px;font-size:.6rem;font-weight:600;"></div>
      <div style="margin-top:16px;display:flex;gap:8px;">
        <button class="btn btn-s" onclick="exportAgingCSV()" style="font-size:.52rem;">↓ Export CSV</button>
      </div>
    </div>
  </div>
</div>
```

### 1.3 `parsePtDays()` helper (module-level)

Add as a module-level function near the other report helpers:

```js
function parsePtDays(pt) {
  var m = (pt||'').match(/\d+/);
  return m ? parseInt(m[0], 10) : 30;
}
```

This is shared by `renderAgingReport()` and `exportAgingCSV()` — do not define it inline in either function.

### 1.4 `openAgingReport()` function

```js
function openAgingReport() {
  renderAgingReport();
  openM('ov-aging');
}
```

### 1.5 `renderAgingReport()` function

```js
function renderAgingReport() {
  var today = new Date();
  today.setHours(0,0,0,0);

  // Include only Sent / Partially Paid invoices
  var invs = DB.inv.filter(function(inv) {
    return (inv.status === 'Sent' || inv.status === 'Partially Paid') &&
           inv.type !== 'credit_note' && inv.type !== 'goodwill_credit' && !isCN(inv.num);
  });

  var rows = invs.map(function(inv) {
    var c = iCalc(inv);
    var invDate = new Date(inv.date);
    invDate.setHours(0,0,0,0);
    var ptDays = parsePtDays(inv.paymentTerms || inv.pt || '');
    var dueDate = new Date(invDate.getTime() + ptDays * 86400000);
    var daysOld = Math.floor((today - invDate) / 86400000);
    var daysOverdue = Math.floor((today - dueDate) / 86400000);
    var bucket;
    if (daysOverdue <= 0)       bucket = 'Current';
    else if (daysOverdue <= 30) bucket = '0–30';
    else if (daysOverdue <= 60) bucket = '31–60';
    else if (daysOverdue <= 90) bucket = '61–90';
    else                        bucket = '90+';
    return { inv: inv, bal: c.bal, daysOld: daysOld, daysOverdue: daysOverdue, dueDate: dueDate, bucket: bucket };
  }).filter(function(r){ return r.bal > 0; });

  // DSO = sum(daysOld × balance) / sum(balance)
  var totalBal = rows.reduce(function(s,r){ return s + r.bal; }, 0);
  var dso = totalBal > 0
    ? Math.round(rows.reduce(function(s,r){ return s + r.daysOld * r.bal; }, 0) / totalBal)
    : 0;

  // Bucket totals
  var buckets = ['Current','0–30','31–60','61–90','90+'];
  var bucketTotals = {};
  buckets.forEach(function(b){ bucketTotals[b] = 0; });
  rows.forEach(function(r){ bucketTotals[r.bucket] += r.bal; });

  // KPI strip
  var kpiEl = G('aging-kpi');
  if (kpiEl) kpiEl.innerHTML =
    '<div style="display:flex;gap:24px;flex-wrap:wrap;">' +
    '<div><div style="font-size:.44rem;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">Total Outstanding</div><div style="font-size:.9rem;font-weight:700;color:var(--cr);">$' + totalBal.toFixed(2) + '</div></div>' +
    '<div><div style="font-size:.44rem;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">DSO</div><div style="font-size:.9rem;font-weight:700;">' + dso + ' days</div></div>' +
    '<div><div style="font-size:.44rem;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">Overdue invoices</div><div style="font-size:.9rem;font-weight:700;">' + rows.filter(function(r){ return r.bucket !== 'Current'; }).length + '</div></div>' +
    '</div>';

  // Table
  var tbl = G('aging-tbl');
  if (!tbl) return;
  var html = '<thead><tr style="font-size:.5rem;text-transform:uppercase;letter-spacing:.07em;color:var(--m);">' +
    '<th style="text-align:left;padding:4px 8px;">Invoice</th>' +
    '<th style="text-align:left;padding:4px 8px;">Buyer</th>' +
    '<th style="text-align:left;padding:4px 8px;">Invoice Date</th>' +
    '<th style="text-align:left;padding:4px 8px;">Due Date</th>' +
    '<th style="text-align:right;padding:4px 8px;">Balance Due</th>' +
    '<th style="text-align:center;padding:4px 8px;">Bucket</th>' +
    '</tr></thead><tbody>';

  var bucketColour = { 'Current':'var(--gn)', '0–30':'#D97706', '31–60':'#EA580C', '61–90':'var(--cr)', '90+':'var(--cr)' };

  rows.slice().sort(function(a,b){ return b.daysOverdue - a.daysOverdue; }).forEach(function(r) {
    html += '<tr style="border-top:1px solid var(--border);">' +
      '<td style="padding:5px 8px;color:var(--cr);font-weight:500;">' + san(r.inv.num) + '</td>' +
      '<td style="padding:5px 8px;">' + san(r.inv.buyer) + '</td>' +
      '<td style="padding:5px 8px;">' + (r.inv.date||'') + '</td>' +
      '<td style="padding:5px 8px;">' + r.dueDate.toISOString().slice(0,10) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;font-weight:600;">$' + r.bal.toFixed(2) + '</td>' +
      '<td style="padding:5px 8px;text-align:center;"><span style="background:' + (bucketColour[r.bucket]||'var(--m)') + ';color:white;border-radius:3px;padding:1px 7px;font-size:.46rem;">' + r.bucket + '</span></td>' +
      '</tr>';
  });
  html += '</tbody>';
  tbl.innerHTML = html;

  // Summary row
  var sumEl = G('aging-summary');
  if (sumEl) {
    var sumParts = buckets.map(function(b){
      return b + ': $' + bucketTotals[b].toFixed(2);
    });
    sumEl.textContent = 'Totals — ' + sumParts.join(' | ');
  }
}
```

### 1.6 `exportAgingCSV()` function

```js
function exportAgingCSV() {
  var today = new Date();
  today.setHours(0,0,0,0);
  var invs = DB.inv.filter(function(inv){
    return (inv.status==='Sent'||inv.status==='Partially Paid') &&
           inv.type!=='credit_note'&&inv.type!=='goodwill_credit'&&!isCN(inv.num);
  });
  var rows = [['Invoice','Buyer','Invoice Date','Due Date','Currency','Balance Due','Bucket','Days Overdue']];
  invs.forEach(function(inv) {
    var c = iCalc(inv);
    if (c.bal <= 0) return;
    var invDate = new Date(inv.date); invDate.setHours(0,0,0,0);
    var ptDays = parsePtDays(inv.paymentTerms||inv.pt||'');
    var dueDate = new Date(invDate.getTime() + ptDays*86400000);
    var daysOverdue = Math.floor((today - dueDate)/86400000);
    var bucket = daysOverdue<=0?'Current':daysOverdue<=30?'0–30':daysOverdue<=60?'31–60':daysOverdue<=90?'61–90':'90+';
    rows.push([inv.num,inv.buyer||'',inv.date||'',dueDate.toISOString().slice(0,10),inv.cur||'USD',c.bal.toFixed(2),bucket,Math.max(0,daysOverdue)]);
  });
  var csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'aging-report-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
}
```

---

## §2 — G-03: P&L Report

### 2.1 Toolbar button

Add to the Invoices tab toolbar alongside the Aging button:

```html
<button class="btn btn-g" onclick="openPLReport()" style="font-size:.52rem;">P&amp;L</button>
```

### 2.2 Modal HTML (`ov-pl`)

```html
<div class="modal-overlay" id="ov-pl" style="display:none;">
  <div class="modal" style="max-width:820px;">
    <div class="modal-hdr">
      <h2 style="font-size:.82rem;">P&amp;L Report</h2>
      <button onclick="closeM('ov-pl')" class="cls-btn">&#10005;</button>
    </div>
    <div class="modal-body">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
        <div>
          <label style="font-size:.52rem;color:var(--m);">Dimension</label><br>
          <select id="pl-dim" onchange="renderPLReport()" style="font-size:.58rem;">
            <option value="buyer">By Buyer</option>
            <option value="month">By Month</option>
            <option value="quarter">By Quarter</option>
          </select>
        </div>
        <div>
          <label style="font-size:.52rem;color:var(--m);">From</label><br>
          <input type="date" id="pl-from" onchange="renderPLReport()" style="font-size:.58rem;">
        </div>
        <div>
          <label style="font-size:.52rem;color:var(--m);">To</label><br>
          <input type="date" id="pl-to" onchange="renderPLReport()" style="font-size:.58rem;">
        </div>
      </div>
      <div id="pl-warn" style="display:none;background:#FEF3C7;border:1px solid #D97706;border-radius:4px;padding:8px 12px;font-size:.56rem;color:#92400E;margin-bottom:12px;"></div>
      <table id="pl-tbl" style="width:100%;font-size:.58rem;border-collapse:collapse;"></table>
      <div style="margin-top:16px;">
        <button class="btn btn-s" onclick="exportPLCSV()" style="font-size:.52rem;">↓ Export CSV</button>
      </div>
    </div>
  </div>
</div>
```

### 2.3 `openPLReport()` function

```js
function openPLReport() {
  // Default date range: current calendar year
  var now = new Date();
  var yr = now.getFullYear();
  var fromEl = G('pl-from'); var toEl = G('pl-to');
  if (fromEl && !fromEl.value) fromEl.value = yr + '-01-01';
  if (toEl   && !toEl.value)   toEl.value   = yr + '-12-31';
  renderPLReport();
  openM('ov-pl');
}
```

### 2.4 `renderPLReport()` function

```js
function renderPLReport() {
  var dim    = (G('pl-dim')  ? G('pl-dim').value  : 'buyer');
  var dfrom  = (G('pl-from') ? G('pl-from').value : '');
  var dto    = (G('pl-to')   ? G('pl-to').value   : '');

  // Filter: non-cancelled invoices only; no credit notes; apply date range
  var invs = DB.inv.filter(function(inv) {
    if (inv.status === 'Cancelled') return false;
    if (inv.type === 'credit_note' || inv.type === 'goodwill_credit' || isCN(inv.num)) return false;
    if (dfrom && inv.date < dfrom) return false;
    if (dto   && inv.date > dto)   return false;
    return true;
  });

  // COGS warning: invoices with zero calc_cogs and no library-linked lines
  var zeroCogs = invs.filter(function(inv){
    return !(+inv.calc_cogs > 0) &&
           !(inv.lineItems||[]).some(function(li){ return li.lid && DB.li.find(function(x){ return x.id===li.lid; }); });
  });
  var warnEl = G('pl-warn');
  if (warnEl) {
    if (zeroCogs.length > 0) {
      warnEl.innerHTML = '⚠ ' + zeroCogs.length + ' invoice(s) have no COGS data — profit figures may be understated. Use Import from Library on those invoices to fix.';
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }
  }

  // Grouping key function
  function groupKey(inv) {
    if (dim === 'buyer')   return inv.buyer || 'Unknown';
    if (dim === 'month')   return (inv.date||'').slice(0,7);   // YYYY-MM
    if (dim === 'quarter') {
      var d = inv.date||''; var yr = d.slice(0,4); var mo = parseInt(d.slice(5,7),10)||1;
      return yr + ' Q' + Math.ceil(mo/3);
    }
    return inv.buyer || 'Unknown';
  }

  // Aggregate
  var groups = {};
  invs.forEach(function(inv) {
    var key = groupKey(inv);
    var c   = iCalc(inv);
    if (!groups[key]) groups[key] = { revenue:0, cogs:0, gp:0, np:0 };
    var cogs = +inv.calc_cogs || 0;
    groups[key].revenue += c.grand;
    groups[key].cogs    += cogs;
    groups[key].gp      += (c.grand - cogs);
    groups[key].np      += c.np;
  });

  var keys = Object.keys(groups).sort();
  var totals = { revenue:0, cogs:0, gp:0, np:0 };
  keys.forEach(function(k){ ['revenue','cogs','gp','np'].forEach(function(f){ totals[f]+=groups[k][f]; }); });

  var dimLabel = dim === 'buyer' ? 'Buyer' : dim === 'month' ? 'Month' : 'Quarter';
  var hdr = '<thead><tr style="font-size:.5rem;text-transform:uppercase;letter-spacing:.07em;color:var(--m);">' +
    '<th style="text-align:left;padding:4px 8px;">' + dimLabel + '</th>' +
    '<th style="text-align:right;padding:4px 8px;">Revenue</th>' +
    '<th style="text-align:right;padding:4px 8px;">COGS</th>' +
    '<th style="text-align:right;padding:4px 8px;">Gross Profit</th>' +
    '<th style="text-align:right;padding:4px 8px;">Net Profit</th>' +
    '<th style="text-align:right;padding:4px 8px;">Margin %</th>' +
    '</tr></thead>';

  function fmtRow(label, d, bold) {
    var mgn = d.revenue > 0 ? (d.np/d.revenue*100).toFixed(1)+'%' : '—';
    var s = bold ? 'font-weight:700;border-top:2px solid var(--border);' : 'border-top:1px solid var(--border);';
    return '<tr style="' + s + '">' +
      '<td style="padding:5px 8px;">' + san(label) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;">$' + d.revenue.toFixed(2) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;">$' + d.cogs.toFixed(2) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;">$' + d.gp.toFixed(2) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;' + (d.np<0?'color:var(--cr);':'') + '">$' + d.np.toFixed(2) + '</td>' +
      '<td style="padding:5px 8px;text-align:right;">' + mgn + '</td>' +
      '</tr>';
  }

  var body = '<tbody>' + keys.map(function(k){ return fmtRow(k, groups[k], false); }).join('') +
             fmtRow('TOTAL', totals, true) + '</tbody>';

  var tbl = G('pl-tbl');
  if (tbl) tbl.innerHTML = hdr + body;
}
```

### 2.5 `exportPLCSV()` function

```js
function exportPLCSV() {
  var dim   = G('pl-dim')  ? G('pl-dim').value  : 'buyer';
  var dfrom = G('pl-from') ? G('pl-from').value : '';
  var dto   = G('pl-to')   ? G('pl-to').value   : '';
  var dimLabel = dim==='buyer'?'Buyer':dim==='month'?'Month':'Quarter';

  function groupKey(inv) {
    if (dim==='buyer')   return inv.buyer||'Unknown';
    if (dim==='month')   return (inv.date||'').slice(0,7);
    var d=inv.date||''; var yr=d.slice(0,4); var mo=parseInt(d.slice(5,7),10)||1;
    return yr+' Q'+Math.ceil(mo/3);
  }

  var invs = DB.inv.filter(function(inv){
    if (inv.status==='Cancelled') return false;
    if (inv.type==='credit_note'||inv.type==='goodwill_credit'||isCN(inv.num)) return false;
    if (dfrom && inv.date<dfrom) return false;
    if (dto   && inv.date>dto)   return false;
    return true;
  });

  var groups = {};
  invs.forEach(function(inv){
    var key=groupKey(inv); var c=iCalc(inv); var cogs=+inv.calc_cogs||0;
    if (!groups[key]) groups[key]={revenue:0,cogs:0,gp:0,np:0};
    groups[key].revenue+=c.grand; groups[key].cogs+=cogs;
    groups[key].gp+=(c.grand-cogs); groups[key].np+=c.np;
  });

  var rows = [[dimLabel,'Revenue','COGS','Gross Profit','Net Profit','Margin %']];
  var totals = {revenue:0,cogs:0,gp:0,np:0};
  Object.keys(groups).sort().forEach(function(k){
    var d=groups[k]; var mgn=d.revenue>0?(d.np/d.revenue*100).toFixed(1)+'%':'—';
    rows.push([k,d.revenue.toFixed(2),d.cogs.toFixed(2),d.gp.toFixed(2),d.np.toFixed(2),mgn]);
    totals.revenue+=d.revenue; totals.cogs+=d.cogs; totals.gp+=d.gp; totals.np+=d.np;
  });
  var totMgn=totals.revenue>0?(totals.np/totals.revenue*100).toFixed(1)+'%':'—';
  rows.push(['TOTAL',totals.revenue.toFixed(2),totals.cogs.toFixed(2),totals.gp.toFixed(2),totals.np.toFixed(2),totMgn]);

  var csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(','); }).join('\n');
  var a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'pl-report-' + dim + '-' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
}
```

---

## §3 — Tests

**Note on DOM-dependent functions:** `renderAgingReport()` and `renderPLReport()` call `G()` (DOM lookup) and are not testable in the VM sandbox. `mockEl()` returns `{value:'', checked:false, style:{}, classList:{}}` with no `querySelector` or child element support — `G()` calls return `null` in the harness. The tests below are algorithm-isolation tests that verify the core calculation, bucketing, and filter logic using `iCalc()`, `isCN()`, and `parsePtDays()` from `ctx`, exactly as that logic executes inside the report functions. All DOM-dependent ACs (rendering, CSV download) are verified via the manual QA checklist in §5. Bucket label strings use en-dash (–) throughout production code and tests: `'0–30'`, `'31–60'`, `'61–90'`.

Append to `tests/run.js`:

```js
// ── REQ-RPT-001 G-02: Aging Report ──────────────────────────────

test('aging bucket: invoice 65 days old with Net 30 terms in 31-60 bucket (daysOverdue=35)', function() {
  // Bucket logic: daysOverdue = today - dueDate; dueDate = invDate + ptDays
  // 65 days old, Net 30 -> dueDate = invDate + 30 -> daysOverdue = 35 -> '31–60'
  var today = new Date(); today.setHours(0,0,0,0);
  var invDate = new Date(today.getTime() - 65*86400000);
  var ptDays = ctx.parsePtDays('Net 30');
  var dueDate = new Date(invDate.getTime() + ptDays*86400000);
  var daysOverdue = Math.floor((today - dueDate)/86400000);
  var bucket = daysOverdue<=0?'Current':daysOverdue<=30?'0–30':daysOverdue<=60?'31–60':daysOverdue<=90?'61–90':'90+';
  assertEqual(bucket, '31–60', '65-day-old invoice with Net 30 -> daysOverdue 35 -> 31-60 bucket');
});

test('aging bucket: invoice 95 days old with Net 30 terms in 90+ bucket', function() {
  var today = new Date(); today.setHours(0,0,0,0);
  var invDate = new Date(today.getTime() - 95*86400000);
  var ptDays = ctx.parsePtDays('Net 30');
  var dueDate = new Date(invDate.getTime() + ptDays*86400000);
  var daysOverdue = Math.floor((today - dueDate)/86400000);
  var bucket = daysOverdue<=0?'Current':daysOverdue<=30?'0–30':daysOverdue<=60?'31–60':daysOverdue<=90?'61–90':'90+';
  assertEqual(bucket, '90+', '95-day-old invoice with Net 30 in 90+ bucket');
});

test('parsePtDays: payment terms defaults and extraction', function() {
  assertEqual(ctx.parsePtDays('COD'), 30, 'COD defaults to 30');
  assertEqual(ctx.parsePtDays(''), 30, 'empty defaults to 30');
  assertEqual(ctx.parsePtDays('Net 45'), 45, 'Net 45 parses 45');
  assertEqual(ctx.parsePtDays('30 days EOM'), 30, '30 days EOM parses 30');
});

test('aging DSO is 0 when no invoices with outstanding balance', function() {
  var rows = [];  // empty - no outstanding invoices
  var totalBal = rows.reduce(function(s,r){ return s + r.bal; }, 0);
  var dso = totalBal > 0
    ? Math.round(rows.reduce(function(s,r){ return s + r.daysOld * r.bal; }, 0) / totalBal)
    : 0;
  assertEqual(dso, 0, 'DSO is 0 when no outstanding balance');
});

test('aging filter: Paid invoices excluded, Sent included', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'1000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'0' });
  var filtered = ctx.DB.inv.filter(function(inv){
    return (inv.status === 'Sent' || inv.status === 'Partially Paid') &&
           inv.type !== 'credit_note' && inv.type !== 'goodwill_credit' && !ctx.isCN(inv.num);
  });
  assertEqual(filtered.length, 1, 'only Sent/Partially Paid included in aging');
  assertEqual(filtered[0].num, 'INV002', 'Paid invoice excluded');
});

test('aging filter: Partially Paid invoice with outstanding balance included (REQ AC-2)', function() {
  ctx.resetDB();
  // Grand total 2000, dep (deposit/paid) 800 -> bal = 1200 outstanding
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-05', status:'Partially Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'800' });
  var filtered = ctx.DB.inv.filter(function(inv){
    return (inv.status === 'Sent' || inv.status === 'Partially Paid') &&
           inv.type !== 'credit_note' && inv.type !== 'goodwill_credit' && !ctx.isCN(inv.num);
  });
  assertEqual(filtered.length, 1, 'Partially Paid invoice included in aging filter');
  var c = ctx.iCalc(filtered[0]);
  assert(c.bal > 0, 'outstanding balance > 0 for Partially Paid invoice');
});

// -- REQ-RPT-001 G-03: P&L Report --

test('P&L grouping: revenue, cogs, np aggregated correctly by buyer', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'Apex', date:'2026-03-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'10000', calc_cogs:'6000', calc_netProfit:'4000', calc_margin:'40', dep:'10000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'Apex', date:'2026-04-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'5000', calc_cogs:'3000', calc_netProfit:'2000', calc_margin:'40', dep:'5000' });
  ctx.DB.inv.push({ id:'i3', num:'INV003', buyer:'Romerry', date:'2026-04-15', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'8000', calc_cogs:'5000', calc_netProfit:'3000', calc_margin:'37', dep:'0' });

  var invs = ctx.DB.inv.filter(function(i){ return i.status!=='Cancelled'&&i.type!=='credit_note'&&!ctx.isCN(i.num); });
  var groups = {};
  invs.forEach(function(inv){
    var key = inv.buyer||'Unknown';
    var c = ctx.iCalc(inv);
    var cogs = +inv.calc_cogs||0;
    if (!groups[key]) groups[key]={revenue:0,cogs:0,gp:0,np:0};
    groups[key].revenue += c.grand;
    groups[key].cogs    += cogs;
    groups[key].gp      += (c.grand - cogs);
    groups[key].np      += c.np;
  });
  assertEqual(+groups['Apex'].revenue.toFixed(2), 15000, 'Apex revenue aggregated correctly');
  assertEqual(+groups['Apex'].cogs.toFixed(2), 9000, 'Apex COGS aggregated correctly');
  assertEqual(+groups['Apex'].gp.toFixed(2), 6000, 'Apex gross profit aggregated correctly');
  assertEqual(+groups['Apex'].np.toFixed(2), 6000, 'Apex NP aggregated correctly');
  assert(groups['Romerry'], 'Romerry group present');
});

test('P&L date range filter excludes out-of-range invoices', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2025-12-31', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'1000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-03-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000' });
  var dfrom='2026-01-01'; var dto='2026-12-31';
  var filtered = ctx.DB.inv.filter(function(inv){
    if (inv.status==='Cancelled') return false;
    if (dfrom && inv.date<dfrom) return false;
    if (dto   && inv.date>dto)   return false;
    return true;
  });
  assertEqual(filtered.length, 1, 'only in-range invoice included');
  assertEqual(filtered[0].num, 'INV002', 'correct invoice retained');
});

test('P&L filter: cancelled invoices excluded', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Cancelled', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000' });
  var filtered = ctx.DB.inv.filter(function(i){ return i.status!=='Cancelled'&&i.type!=='credit_note'&&!ctx.isCN(i.num); });
  assertEqual(filtered.length, 1, 'cancelled invoice excluded');
});

test('P&L COGS warning: zero-cogs invoice with no library lines detected', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'0', calc_netProfit:'0', calc_margin:'0', dep:'1000',
    lineItems:[{ desc:'Widget', qty:1, up:1000, lid:'' }] });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Paid', type:'invoice', cur:'USD',
    calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000',
    lineItems:[{ desc:'Gadget', qty:1, up:2000, lid:'lib-1' }] });
  ctx.DB.li.push({ id:'lib-1', name:'Gadget', price:2000 });

  var invs = ctx.DB.inv.filter(function(inv){ return inv.status !== 'Cancelled'; });
  var zeroCogs = invs.filter(function(inv){
    return !(+inv.calc_cogs > 0) &&
           !(inv.lineItems||[]).some(function(li){ return li.lid && ctx.DB.li.find(function(x){ return x.id===li.lid; }); });
  });
  assertEqual(zeroCogs.length, 1, 'one invoice flagged as zero-COGS');
  assertEqual(zeroCogs[0].num, 'INV001', 'correct invoice flagged');
});
```

---

## §4 — Version delivery

On completion:
- `CLAUDE.md`: bump to `v2.9.35`, update Test count
- `docs/version-history.md`: prepend v2.9.35 row
- `AI_SYSTEM_PROMPT` version string: update to v2.9.35. Add a new entry describing the Aging Report and P&L Report panels so the AI can answer user questions about them: `'Reporting: Aging Report (Invoices tab → [Aging]) shows outstanding invoices in buckets (Current / 0–30 / 31–60 / 61–90 / 90+ days overdue) with DSO KPI and CSV export. P&L Report (Invoices tab → [P&L]) shows Revenue, COGS, Gross Profit, Net Profit, Margin % by Buyer / Month / Quarter with date range filter and CSV export — v2.9.35.'`
- In-app changelog: prepend v2.9.35 block
- Raise PR

---

## §5 — Manual QA checklist

**G-02 Aging Report:**
- [ ] Click [Aging] on Invoices tab — modal opens
- [ ] Invoices with status Sent / Partially Paid with outstanding balance appear; Paid/Cancelled/Draft not shown
- [ ] Bucket assignment correct for known invoice dates (verify manually against today)
- [ ] DSO figure is non-zero when overdue invoices exist
- [ ] Export CSV — downloads with correct columns and bucket values
- [ ] No invoices outstanding — modal shows empty table, DSO = 0

**G-03 P&L Report:**
- [ ] Click [P&L] on Invoices tab — modal opens with current year pre-selected
- [ ] By Buyer dimension: one row per buyer, correct revenue/COGS/NP/margin
- [ ] By Month: rows grouped by YYYY-MM, totals correct
- [ ] By Quarter: rows grouped by YYYY Q1/Q2/Q3/Q4, totals correct
- [ ] Change date range — report updates reactively
- [ ] Invoice with no COGS (quick-add lines) — amber warning shown with count
- [ ] Export CSV — downloads with correct dimension label and figures
- [ ] Cancelled invoices not included in totals
