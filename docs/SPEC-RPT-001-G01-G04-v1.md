# SPEC-RPT-001 G-01 & G-04 v1 — AI Date Filter + Quick-add COGS Warning

**Requirement:** REQ-RPT-001-v1.md (G-01, G-04)  
**Version target:** v2.9.34  
**Status:** PASS (spec-gate 2026-06-25)  
**FM-1:** Approved — UI/AI layer only, no new entities, no new K keys

---

## Overview

Two independent, small-scope changes delivered together:

- **G-01:** Add `date_from` / `date_to` optional filters to the `get_invoices` and `get_payments` AI data tools, enabling conversational period-scoped queries (e.g. "revenue from Apex in Q1"). `G()` used throughout is `document.getElementById` — an existing alias defined in `index.html`.
- **G-04:** Show an amber inline warning in the invoice modal when any line item was added without a library link (`li.lid` empty/null), alerting the operator that COGS will be zero for those lines.

No new `K` key. No new `DB` entity. No schema change. No test harness changes to `resetDB()`.

---

## §1 — G-01: Date filter on AI data tools

### 1.1 `get_invoices` tool schema update

In `AI_TOOLS`, locate the `get_invoices` entry. Add two new optional properties to `input_schema.properties`:

```js
date_from: { type: 'string', description: 'Include only invoices on or after this date (ISO 8601, e.g. "2026-01-01")' },
date_to:   { type: 'string', description: 'Include only invoices on or before this date (ISO 8601, e.g. "2026-03-31")' }
```

### 1.2 `get_invoices` filter logic in `_aiExecTool`

In the `get_invoices` branch of `_aiExecTool`, add date filtering after the existing `buyer`/`status`/`num` guards:

```js
if (inp.date_from && inv.date < inp.date_from) return false;
if (inp.date_to   && inv.date > inp.date_to)   return false;
```

`inv.date` is stored as `YYYY-MM-DD` ISO format (confirmed from `saveInv()` — date input value is stored directly). String lexicographic comparison is correct and safe for this format.

### 1.3 `get_payments` tool schema update

In `AI_TOOLS`, locate the `get_payments` entry. Add the same two optional properties:

```js
date_from: { type: 'string', description: 'Include only payments on or after this date (ISO 8601)' },
date_to:   { type: 'string', description: 'Include only payments on or before this date (ISO 8601)' }
```

### 1.4 `get_payments` filter logic in `_aiExecTool`

In the `get_payments` branch, add after the existing `buyer`/`inv_num` guards:

```js
if (inp.date_from && p.date < inp.date_from) return false;
if (inp.date_to   && p.date > inp.date_to)   return false;
```

`p.date` is stored as `YYYY-MM-DD` ISO format — confirmed from `addPaymentFromForm()` which reads it directly from a `<input type="date">` and stores as-is. No normalisation guard required.

### 1.5 `AI_SYSTEM_PROMPT` update

Add as a new string entry in the `AI_SYSTEM_PROMPT` array, after the existing tool capability description:

```js
'Data tool date filtering: get_invoices and get_payments both accept optional date_from and date_to params (ISO 8601, e.g. "2026-01-01"). Use these to answer period-scoped questions like "revenue in Q1 2026" (date_from: "2026-01-01", date_to: "2026-03-31") or "payments received in May" (date_from: "2026-05-01", date_to: "2026-05-31"). Both params are optional and inclusive.',
```

---

## §2 — G-04: Quick-add COGS warning in invoice modal

### 2.1 Add warning element to invoice modal HTML

Locate the invoice line items section in the invoice modal (`ov-inv`). After the line items table container, add a hidden warning element:

```html
<div id="inv-qa-warn" style="display:none;background:#FEF3C7;border:1px solid #D97706;border-radius:4px;padding:8px 12px;font-size:.58rem;color:#92400E;margin-top:8px;">
  ⚠ <span id="inv-qa-warn-count"></span> line item(s) added without a library link — COGS will be £0 for these lines and profit calculations will be understated. Use <strong>Import from Library</strong> to fix.
</div>
```

### 2.2 Add `_updQaWarn()` helper

Add near `rILT()` (the existing invoice line items table render function, located at line ~3608):

```js
function _updQaWarn() {
  var qaCount = cIL.filter(function(li){ return !li.lid; }).length;
  var el = G('inv-qa-warn');
  var ct = G('inv-qa-warn-count');
  if (!el) return;
  if (qaCount > 0) {
    if (ct) ct.textContent = qaCount;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}
```

### 2.3 Call `_updQaWarn()` from `rILT()`

`rILT()` is the existing function that re-renders the invoice line items table (located at line ~3608 in `index.html`). It is called whenever a line is added, removed, or changed. At the end of `rILT()`, add:

```js
_updQaWarn();
```

### 2.4 Call `_updQaWarn()` when modal opens

`openInv()` has two population paths for `cIL`:
- New invoice (line ~3460): `EI.i=null; cIL=[];`
- Edit invoice (line ~3519): `EI.i=id; cIL=JSON.parse(JSON.stringify(inv.lineItems||[]));`

Add a single call to `_updQaWarn()` at the **end** of `openInv()`, after the `openM('ov-inv')` call. This covers both paths — `cIL` is fully populated by the time the function exits regardless of path taken.

### 2.5 AC test waiver

G-04 ACs (AC-1 through AC-4) are DOM-only. `mockEl()` in the test harness returns `{value:'', checked:false, style:{}, classList:{}}` with no `querySelector` or child element support — `_updQaWarn()` calls `G()` (DOM lookup) and sets `el.style.display`, which is not testable in the VM sandbox. All four ACs are verified via the manual QA checklist (§5) only.

---

## §3 — Tests

Append to `tests/run.js`:

```js
// ── REQ-RPT-001 G-01: AI date filter ──────────────────────────

test('_aiExecTool get_invoices: date_from filters correctly', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-20', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_from: '2026-02-01' }));
  assert.strictEqual(result.length, 1, 'only invoices on/after date_from returned');
  assert.strictEqual(result[0].num, 'INV002', 'correct invoice returned');
});

test('_aiExecTool get_invoices: date_to filters correctly', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-20', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_to: '2026-02-28' }));
  assert.strictEqual(result.length, 1, 'only invoices on/before date_to returned');
  assert.strictEqual(result[0].num, 'INV001', 'correct invoice returned');
});

test('_aiExecTool get_invoices: date range inclusive both ends', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-31', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i3', num:'INV003', buyer:'C', date:'2026-04-01', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'500', calc_cogs:'300', calc_netProfit:'200', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_from: '2026-01-01', date_to: '2026-03-31' }));
  assert.strictEqual(result.length, 2, 'both boundary dates inclusive');
});

test('_aiExecTool get_invoices: no date params returns all (regression)', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-06-01', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', {}));
  assert.strictEqual(result.length, 2, 'all invoices returned when no date filter');
});

test('_aiExecTool get_payments: date_from filters correctly', function() {
  ctx.resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-02-10', amount:500, method:'Bank Transfer', reference:'REF1' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-04-15', amount:800, method:'Bank Transfer', reference:'REF2' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_from: '2026-03-01' }));
  assert.strictEqual(result.length, 1, 'only payments on/after date_from returned');
  assert.strictEqual(result[0].invNum, 'INV002', 'correct payment returned');
});

test('_aiExecTool get_payments: date_to filters correctly', function() {
  ctx.resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-02-10', amount:500, method:'Bank Transfer', reference:'REF1' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-04-15', amount:800, method:'Bank Transfer', reference:'REF2' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_to: '2026-03-31' }));
  assert.strictEqual(result.length, 1, 'only payments on/before date_to returned');
  assert.strictEqual(result[0].invNum, 'INV001', 'correct payment returned');
});

test('_aiExecTool get_payments: date range inclusive both ends', function() {
  ctx.resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-01-01', amount:100, method:'Bank Transfer', reference:'A' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-03-31', amount:200, method:'Bank Transfer', reference:'B' });
  ctx.DB.payments.push({ id:'p3', invNum:'INV003', invId:'i3', date:'2026-04-01', amount:300, method:'Bank Transfer', reference:'C' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_from: '2026-01-01', date_to: '2026-03-31' }));
  assert.strictEqual(result.length, 2, 'both boundary dates inclusive for payments');
});
```

---

## §4 — Version delivery

On completion:
- `CLAUDE.md`: bump to `v2.9.34`, update Test count
- `docs/version-history.md`: prepend v2.9.34 row
- `AI_SYSTEM_PROMPT` version string: update to v2.9.34
- In-app changelog: prepend v2.9.34 block
- Raise PR

---

## §5 — Manual QA checklist

**G-01:**
- [ ] Ask AI: "What invoices did we raise in January 2026?" — verify only January invoices returned
- [ ] Ask AI: "What payments did we receive in Q1 2026?" — verify only Q1 payments returned
- [ ] Ask AI: "Show all invoices" (no date) — verify all invoices returned as before

**G-04 (all four ACs verified manually — DOM not testable in VM sandbox):**
- [ ] AC-1: Open an invoice with only library-linked lines — no warning shown
- [ ] AC-1: Add a quick-add line — amber warning appears, count = 1
- [ ] AC-1: Add a second quick-add line — count increments to 2
- [ ] AC-2: Import a library line alongside quick-add lines — quick-add count shown, library lines not counted
- [ ] AC-3: Remove all quick-add lines — warning disappears
- [ ] AC-4: Click Save with warning present — save succeeds normally
- [ ] AC-1 (edit path): Open an existing invoice that already has quick-add lines — warning shown immediately on modal open
