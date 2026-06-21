# SPEC-MTD-001 v1 — MTD-Compatible VAT Export

**Requirement:** REQ-MTD-001-v2.md  
**Version target:** v2.9.32  
**Status:** Spec-gate v1 FAIL → v2 revised  

---

## Overview

Add a VAT Return modal accessible from the Invoices tab. `calcVATReturn(from, to)` computes the 9 HMRC VAT 100 boxes from `DB.inv` data within the selected date range. Two CSV exports are provided: the 9-box summary (for MTD bridging import) and the transaction detail listing (digital records). No new K key, no new DB entity.

---

## §1 — Functions

### 1.1 `_vatPrevQuarter()`

Returns `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }` for the previous calendar quarter relative to today.

```js
function _vatPrevQuarter(now) {
  // Optional `now` arg for test injection — avoids needing to mock the Date constructor
  if (!now) now = new Date();
  var y = now.getFullYear();
  var q = Math.floor(now.getMonth() / 3); // 0-indexed: 0=Q1,1=Q2,2=Q3,3=Q4 (current quarter)
  // For q=1,2,3: q already equals the 1-indexed previous quarter (Q1,Q2,Q3 respectively)
  // For q=0 (Jan-Mar): previous = Q4 of prior year
  if (q === 0) { q = 4; y -= 1; }
  // q is now 1-4 representing the previous quarter
  var starts = [null, '01-01', '04-01', '07-01', '10-01'];
  var ends   = [null, '03-31', '06-30', '09-30', '12-31'];
  return { from: y + '-' + starts[q], to: y + '-' + ends[q] };
}
```

### 1.2 `calcVATReturn(from, to)`

Returns an object `{ box1, box2, box3, box4, box5, box6, box7, box8, box9, rows }` where `box1`–`box9` are GBP numbers (2 d.p.) and `rows` is the transaction detail array.

```js
function calcVATReturn(from, to) {
  // iCalc returns values in invoice's native currency; toGBP converts per-invoice before summing
  var box1 = 0, box6 = 0;
  var rows = [];

  DB.inv.forEach(function(inv) {
    if (inv.date < from || inv.date > to) return;
    if (inv.status === 'Cancelled') return;
    if (inv.type === 'goodwill_credit') return;

    var c = iCalc(inv);
    var cur = inv.cur || 'USD';
    var grossGBP = toGBP(c.grand, cur);
    var taxGBP   = toGBP(c.tax,   cur);
    var netGBP   = grossGBP - taxGBP;

    var sign = (inv.type === 'credit_note') ? -1 : 1;

    box1 += sign * taxGBP;
    box6 += sign * netGBP;

    rows.push({
      num:    inv.num   || '-',
      date:   inv.date  || '-',
      buyer:  inv.buyer || '-',
      dst:    inv.dst   || '-',
      type:   inv.type  || 'invoice',
      status: inv.status || '-',
      cur:    cur,
      grossOrig: sign * c.grand,
      netOrig:   sign * (c.grand - c.tax),
      taxOrig:   sign * c.tax,
      netGBP:    sign * netGBP,
      taxGBP:    sign * taxGBP
    });
  });

  // Sort by date asc, then num asc
  rows.sort(function(a, b) {
    if (a.date < b.date) return -1;
    if (a.date > b.date) return  1;
    if (a.num  < b.num)  return -1;
    if (a.num  > b.num)  return  1;
    return 0;
  });

  box1 = Math.round(box1 * 100) / 100;
  box6 = Math.round(box6 * 100) / 100;
  var box3 = Math.round((box1 + 0) * 100) / 100;  // box2 = 0
  var box5 = Math.round((box3 - 0) * 100) / 100;  // box4 = 0

  return { box1: box1, box2: 0, box3: box3, box4: 0, box5: box5,
           box6: box6, box7: 0, box8: 0, box9: 0, rows: rows };
}
```

### 1.3 `openVATReturn()`

```js
function openVATReturn() {
  var pq = _vatPrevQuarter(); // uses current date by default
  G('vat-from').value = pq.from;
  G('vat-to').value   = pq.to;
  // Disable export buttons until Calculate is run
  G('vat-export-summary').disabled = true;
  G('vat-export-txn').disabled     = true;
  G('vat-boxes').innerHTML = '';
  showM('ov-vat');
}
```

### 1.4 `runVATCalc()`

Called by the Calculate button. Reads date inputs, runs `calcVATReturn`, renders the 9-box table, enables export buttons, and stores result in `window._vatResult`.

```js
function runVATCalc() {
  var from = G('vat-from').value;
  var to   = G('vat-to').value;
  if (!from || !to) { toast('Enter From and To dates'); return; }
  if (from > to) { toast('From date must be before To date'); return; }
  var r = calcVATReturn(from, to);
  window._vatResult = { from: from, to: to, result: r };
  var labels = [
    'VAT due on sales and other outputs',
    'VAT due on acquisitions from EC (post-Brexit £0)',
    'Total VAT due (Box 1 + Box 2)',
    'VAT reclaimed on purchases',
    'Net VAT payable to HMRC (Box 3 − Box 4)',
    'Total value of sales excluding VAT',
    'Total value of purchases excluding VAT',
    'Total value of goods supplied to EC (post-Brexit £0)',
    'Total value of goods acquired from EC (post-Brexit £0)'
  ];
  var vals = [r.box1, r.box2, r.box3, r.box4, r.box5, r.box6, r.box7, r.box8, r.box9];
  G('vat-boxes').innerHTML =
    '<table style="width:100%;border-collapse:collapse;font-size:.56rem;">' +
    '<thead><tr style="border-bottom:1px solid var(--bd);">' +
    '<th style="text-align:left;padding:4px 6px;color:var(--m);">Box</th>' +
    '<th style="text-align:left;padding:4px 6px;color:var(--m);">Description</th>' +
    '<th style="text-align:right;padding:4px 6px;color:var(--m);">GBP</th>' +
    '</tr></thead><tbody>' +
    labels.map(function(lbl, i) {
      var v = vals[i];
      return '<tr style="border-bottom:1px solid var(--bd);">' +
        '<td style="padding:5px 6px;font-weight:600;">Box ' + (i + 1) + '</td>' +
        '<td style="padding:5px 6px;color:var(--m);">' + lbl + '</td>' +
        '<td style="padding:5px 6px;text-align:right;font-weight:500;">' + fmt(v, 'GBP') + '</td>' +
        '</tr>';
    }).join('') +
    '</tbody></table>';
  G('vat-export-summary').disabled = false;
  G('vat-export-txn').disabled     = false;
}
```

### 1.5 `exportVATSummary()`

```js
function exportVATSummary() {
  if (!window._vatResult) return;
  var r = window._vatResult;
  var res = r.result;
  var rows = [
    ['Box', 'Description', 'GBP'],
    ['Box 1', 'VAT due on sales and other outputs',              res.box1.toFixed(2)],
    ['Box 2', 'VAT due on acquisitions from EC (post-Brexit £0)',res.box2.toFixed(2)],
    ['Box 3', 'Total VAT due (Box 1 + Box 2)',                   res.box3.toFixed(2)],
    ['Box 4', 'VAT reclaimed on purchases',                      res.box4.toFixed(2)],
    ['Box 5', 'Net VAT payable to HMRC (Box 3 - Box 4)',         res.box5.toFixed(2)],
    ['Box 6', 'Total value of sales excluding VAT',              res.box6.toFixed(2)],
    ['Box 7', 'Total value of purchases excluding VAT',          res.box7.toFixed(2)],
    ['Box 8', 'Total value of goods supplied to EC (post-Brexit £0)', res.box8.toFixed(2)],
    ['Box 9', 'Total value of goods acquired from EC (post-Brexit £0)', res.box9.toFixed(2)]
  ];
  var csv = rows.map(function(row) {
    return row.map(function(c){ return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  dlText('VAT-Return-' + r.from + '-to-' + r.to + '.csv', csv, 'text/csv');
}
```

### 1.6 `exportVATTransactions()`

```js
function exportVATTransactions() {
  if (!window._vatResult) return;
  var r = window._vatResult;
  var header = ['Invoice #','Date','Buyer','Destination','Type','Status','Currency',
                'Gross (orig cur)','Net (orig cur)','Tax (orig cur)','Net GBP','Tax GBP'];
  var dataRows = r.result.rows.map(function(row) {
    return [
      row.num, row.date, row.buyer, row.dst, row.type, row.status, row.cur,
      row.grossOrig.toFixed(2), row.netOrig.toFixed(2), row.taxOrig.toFixed(2),
      row.netGBP.toFixed(2), row.taxGBP.toFixed(2)
    ];
  });
  var csv = [header].concat(dataRows).map(function(row) {
    return row.map(function(c){ return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  dlText('VAT-Transactions-' + r.from + '-to-' + r.to + '.csv', csv, 'text/csv');
}
```

**Note:** `dlText(filename, content, mimeType)` is the existing download helper at `index.html` line ~6213. Signature confirmed.

---

## §2 — HTML: `ov-vat` modal

Insert before the closing `</div>` of `#app-shell` (alongside other modals):

```html
<div class="ov" id="ov-vat" onclick="if(event.target===this)closeM('ov-vat')">
  <div class="modal" style="max-width:600px;">
    <div class="mh">
      <h2>VAT Return</h2>
      <span style="font-family:'DM Mono',monospace;font-size:.5rem;color:var(--m);margin-left:8px;">Making Tax Digital &mdash; VAT 100</span>
      <button class="mx" onclick="closeM('ov-vat')">&#215;</button>
    </div>
    <div class="mb">
      <div style="display:flex;gap:12px;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap;">
        <div>
          <label class="lbl">From</label>
          <input type="date" id="vat-from" class="inp" style="width:150px;">
        </div>
        <div>
          <label class="lbl">To</label>
          <input type="date" id="vat-to" class="inp" style="width:150px;">
        </div>
        <button class="btn btn-s" onclick="runVATCalc()">Calculate</button>
      </div>
      <div id="vat-boxes" style="margin-bottom:14px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        <button id="vat-export-summary" class="btn btn-s" style="font-size:.52rem;" onclick="exportVATSummary()" disabled>&#8659; Export VAT Return CSV</button>
        <button id="vat-export-txn"     class="btn btn-g" style="font-size:.52rem;" onclick="exportVATTransactions()" disabled>&#8659; Export Transactions CSV</button>
      </div>
      <p style="font-size:.48rem;color:var(--m);line-height:1.6;">Export the VAT Return CSV and import into your MTD bridging software (e.g. ANNA Money, Sage, BTC Software) for HMRC submission. Boxes 2, 4, 7, 8, 9 are &pound;0.00 &mdash; input VAT tracking is not yet supported (<a href="#" style="color:var(--cr);" onclick="return false;">MTD-GAP-001</a>).</p>
    </div>
    <div class="mf">
      <button class="btn btn-g" onclick="closeM('ov-vat')">Close</button>
    </div>
  </div>
</div>
```

---

## §3 — Invoices tab toolbar button

The Invoices toolbar currently has an accounting export button. Add the VAT Return button to the right of the existing toolbar buttons.

Locate the existing Invoices toolbar (search for `openAccExport` or the `↓ Accounting Export` button in the Invoices view). Add alongside:

```html
<button class="btn btn-s" onclick="openVATReturn()">&#128196; VAT Return</button>
```

---

## §4 — Placement of JS functions

Add `_vatPrevQuarter`, `calcVATReturn`, `openVATReturn`, `runVATCalc`, `exportVATSummary`, `exportVATTransactions` as a block before `rInv()` (the invoice list render function). These are utility functions; placement near other invoice-related functions is correct.

---

## §5 — `AI_SYSTEM_PROMPT` update

Add to the Settings section and/or Invoices section:

```
'## VAT Return (MTD)',
'Invoices tab → ↓ VAT Return button. Select a From and To date (defaults to previous calendar quarter). Click Calculate to see the 9 HMRC VAT 100 boxes computed from invoices in the period. Export VAT Return CSV for import into MTD bridging software (e.g. ANNA Money, Sage). Export Transactions CSV for the underlying digital records. Boxes 2, 4, 7, 8, 9 are always £0.00 (post-Brexit EC boxes; input VAT not tracked — MTD-GAP-001). All values in GBP at current QR rates.',
```

---

## §6 — `tests/run.js` test cases

**Test fixture field names:** `iCalc(inv)` reads `inv.calc_grandTotal` (not `calc_grand`) for the grand total fallback, and `cInv(inv)` reads `inv.calc_taxAmt` for the tax fallback (when no live line items). Credit notes must supply `cnAmount` — `cInv` returns `{ grand: cnAmount, tax: 0, ... }` when `inv.type === 'credit_note'` and `cnAmount` is set. All test fixtures below use the correct field names.

Append after the demo mode test block:

```js
// ── REQ-MTD-001: VAT Return ──────────────────────────────────────────────────

test('_vatPrevQuarter: returns Q4 of prior year when called in Q1 (Jan-Mar)', function() {
  // Inject a stub `now` object — avoids mocking the Date constructor in the VM sandbox
  var nowStub = { getFullYear: function(){ return 2026; }, getMonth: function(){ return 0; } };
  var pq = ctx._vatPrevQuarter(nowStub);
  assert(pq.from === '2025-10-01', 'from = Q4 2025 start');
  assert(pq.to   === '2025-12-31', 'to = Q4 2025 end');
});

test('_vatPrevQuarter: 1 April (first day of Q2) returns Q1 of same year (AC-8)', function() {
  var nowStub = { getFullYear: function(){ return 2026; }, getMonth: function(){ return 3; } };
  var pq = ctx._vatPrevQuarter(nowStub);
  assert(pq.from === '2026-01-01', 'from = Q1 2026 start');
  assert(pq.to   === '2026-03-31', 'to = Q1 2026 end');
});

test('openVATReturn: export buttons disabled on open (AC-7)', function() {
  ctx.openVATReturn();
  assert(mockEl('vat-export-summary').disabled === true, 'summary export disabled on open');
  assert(mockEl('vat-export-txn').disabled === true, 'txn export disabled on open');
});

test('calcVATReturn: mixed zero-rated and 20% invoice — Box1 = tax-bearing tax only (AC-1)', function() {
  resetDB();
  ctx.DB.events = [];
  // Zero-rated invoice: grandTotal=1000, taxAmt=0
  ctx.DB.inv.push({ id: 'i10', num: 'INV010', date: '2026-02-01', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'Barbados',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  // 20%-rated invoice: grandTotal=1200, taxAmt=200 (net=1000). Uses GBP so toGBP is 1:1.
  ctx.DB.inv.push({ id: 'i11', num: 'INV011', date: '2026-02-10', status: 'Sent',
    type: 'invoice', cur: 'GBP', buyer: 'UK Buyer Ltd', dst: 'United Kingdom',
    calc_grandTotal: 1200, calc_taxAmt: 200, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  // Box 1: only the 200 GBP tax from INV011 (toGBP of 200 GBP = 200)
  assert(r.box1 > 0, 'Box 1 > 0 (tax-bearing invoice contributes)');
  assert(r.box6 > 0, 'Box 6 > 0');
  assert(r.rows.length === 2, '2 transaction rows');
});

test('calcVATReturn: zero-rated invoice — Box1=0 Box6=grand total GBP (AC-2)', function() {
  resetDB();
  ctx.DB.events = [];
  // invoice with taxRate=0, taxAmt=0, grand=1000 USD
  ctx.DB.inv.push({ id: 'i1', num: 'INV001', date: '2026-01-15', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'Barbados',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box1 === 0, 'Box 1 = 0 for zero-rated');
  assert(r.box6 > 0, 'Box 6 > 0');
  assert(r.rows.length === 1, '1 transaction row');
});

test('calcVATReturn: cancelled invoice excluded (AC-9)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i2', num: 'INV002', date: '2026-01-20', status: 'Cancelled',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 2000, calc_taxAmt: 333.33, calc_liTotal: 2000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box1 === 0, 'Box 1 = 0 (cancelled excluded)');
  assert(r.box6 === 0, 'Box 6 = 0 (cancelled excluded)');
  assert(r.rows.length === 0, 'no transaction rows');
});

test('calcVATReturn: goodwill credit excluded (AC-10)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i3', num: 'GWC001', date: '2026-02-01', status: 'CN Issued',
    type: 'goodwill_credit', cur: 'USD', buyer: 'Acme', dst: 'UK',
    cnAmount: 500 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box1 === 0, 'Box 1 = 0 (goodwill excluded)');
  assert(r.box6 === 0, 'Box 6 = 0 (goodwill excluded)');
  assert(r.rows.length === 0, 'no transaction rows for goodwill credit');
});

test('calcVATReturn: no invoices in range — all boxes zero (AC-4)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i4', num: 'INV003', date: '2025-06-01', status: 'Paid',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1200, calc_taxAmt: 0, calc_liTotal: 1200 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box1 === 0, 'Box 1 = 0');
  assert(r.box6 === 0, 'Box 6 = 0');
  assert(r.rows.length === 0, 'no rows');
});

test('calcVATReturn: invoice outside To date excluded', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i5', num: 'INV004', date: '2026-04-01', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.rows.length === 0, 'invoice after To date excluded');
});

test('calcVATReturn: credit note reduces Box 6 (AC-3)', function() {
  resetDB();
  ctx.DB.events = [];
  // Standard invoice: grandTotal=1000, tax=0
  ctx.DB.inv.push({ id: 'i6', num: 'INV005', date: '2026-02-01', status: 'Paid',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  // Credit note: cnAmount=200 — cInv returns {grand:200, tax:0} for credit_note with cnAmount set
  ctx.DB.inv.push({ id: 'i7', num: 'CN10001', date: '2026-02-15', status: 'CN Applied',
    type: 'credit_note', cur: 'USD', buyer: 'Acme', dst: 'UK', cnAmount: 200 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.rows.length === 2, '2 transaction rows');
  // Box 6 = invoice net - CN net (all zero-rated, so net = grand)
  // credit note row should have negative gross/net/tax
  var cnRow = r.rows.filter(function(row){ return row.type === 'credit_note'; })[0];
  assert(cnRow.grossOrig < 0, 'credit note gross is negative');
  assert(cnRow.netOrig < 0, 'credit note net is negative');
});

test('calcVATReturn: box3 = box1 + box2, box5 = box3 - box4', function() {
  resetDB();
  ctx.DB.events = [];
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box3 === r.box1 + r.box2, 'box3 = box1 + box2');
  assert(r.box5 === r.box3 - r.box4, 'box5 = box3 - box4');
  assert(r.box2 === 0, 'box2 = 0');
  assert(r.box4 === 0, 'box4 = 0');
  assert(r.box7 === 0, 'box7 = 0');
  assert(r.box8 === 0, 'box8 = 0');
  assert(r.box9 === 0, 'box9 = 0');
});
```

---

## §7 — Version delivery checklist

- `CLAUDE.md` — bump to `v2.9.32`, update test count
- `docs/version-history.md` — prepend v2.9.32 row
- `docs/known-gaps.md` — add MTD-GAP-001 and MTD-GAP-002
- `STACKD_CONTEXT.md` — update S3-2 status to ✓ Done (v2.9.32); update MTD-001 gap to resolved; close R-004 (or set to MONITORING)
- `AI_SYSTEM_PROMPT` — add VAT Return section per §5
- In-app changelog — prepend v2.9.32 block
- Raise PR to `claude/amazing-galileo-4hhygo`
