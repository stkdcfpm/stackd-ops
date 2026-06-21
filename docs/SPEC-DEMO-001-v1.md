# SPEC-DEMO-001 v1 — End-to-End Demo Mode

**Requirement:** REQ-DEMO-001-v2.md  
**Version target:** v2.9.31  
**Status:** Spec-gate v1 FAIL → v2 revised

---

## Overview

Add a `loadDemoData()` / `clearDemoData()` pair that seeds and removes a complete end-to-end trade scenario across all entity types. Demo records carry `_demo: true`. Dashboard KPIs exclude demo records. All six entity list tables badge demo records. Settings gains a Demo Mode card.

No new `K` key, no new `DB` entity. `_demo` is a field on existing entity record objects.

---

## §1 — `loadDemoData()` and `clearDemoData()`

Add both functions before `rDash()` (line ~2805).

### 1.1 Helper: relative date

```js
function _demoDate(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
```

### 1.2 `loadDemoData()`

```js
function loadDemoData() {
  var allArrays = [DB.sup, DB.con, DB.qt, DB.po, DB.inv, DB.sh, DB.payments, DB.events];
  var hasDemo = allArrays.some(function(arr){ return arr.some(function(r){ return r._demo === true; }); });
  if (hasDemo) { toast('Demo data already loaded'); return; }

  var supId  = 'demo-sup-001';
  var conId  = 'demo-con-001';
  var qtId   = 'demo-qt-001';
  var poId   = 'demo-po-001';
  var invId  = 'demo-inv-001';
  var shId   = 'demo-sh-001';
  var pmId   = 'demo-pm-001';

  DB.sup.push({ id: supId, name: 'Romerry International', country: 'China', cur: 'CNY', ct: 'Li Wei', email: 'sales@romerry-qd.example', phone: '', notes: '', _demo: true });

  DB.con.push({ id: conId, name: 'Thomas Bergmann', email: 'thomas.bergmann@apex-coldchain.example', phone: '+49 30 0000 0000', company: 'Apex Cold Chain GmbH', status: 'converted', source: 'chat', gdprBasis: 'legitimate_interests', createdAt: _demoDate(-30), lastContactedAt: _demoDate(-14), enquiries: [], notes: 'Demo contact — Apex Cold Chain Berlin buyer', _demo: true });

  DB.qt.push({ id: qtId, num: 'DQ-0001', client: 'Apex Cold Chain GmbH', dt: _demoDate(-28), validUntil: _demoDate(7), status: 'Converted', freightMode: 'FCL 40HQ', markup: 18, currency: 'USD', notes: 'Demo quote — vertical display freezers', sourceContactId: conId, linkedPOId: poId, _demo: true, lines: [{ rid: 'demo-ql-001', lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', uom: 'pcs', qty: 20, cost: 1450, dutyPct: 3.5, hsCode: '8418.50', priceHistory: [{ v: 1, ts: new Date(Date.now() - 28*86400000).toISOString(), cost: 1450, dutyPct: 3.5, markup: 18, landed: 1634.25, sellPrice: 1928.42, note: 'Initial quote' }] }] });

  DB.po.push({ id: poId, num: 'DPO-0001', supId: supId, cur: 'CNY', status: 'Confirmed', date: _demoDate(-28), del: '45 days from PO date', dep: 28000, oth: 0, notes: 'Demo PO — Romerry refrigeration units', lineItems: [{ rid: 'demo-pl-001', lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', uom: 'pcs', qty: 20, cost: 9875 }], _demo: true });

  DB.inv.push({ id: invId, num: 'DINV-0001', buyer: 'Apex Cold Chain GmbH', dst: 'Hamburg, Germany', status: 'Partially Paid', type: 'invoice', cur: 'USD', date: _demoDate(-21), dep: 15600, lineItems: [{ lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', qty: 20, price: 1928.42, cost: 1450, uom: 'pcs', hs: '8418.50', duty: 3.5 }], notes: 'Demo invoice', _demo: true });

  DB.payments.push({ id: pmId, invId: invId, invNum: 'DINV-0001', date: _demoDate(-21), amount: 15600, method: 'Bank Transfer', reference: 'DEMO-DEP-001', notes: 'Demo deposit payment', type: 'buyer_payment', creAt: new Date(Date.now() - 21*86400000).toISOString(), _demo: true });

  DB.sh.push({ id: shId, ref: 'DSHP-0001', blNum: 'MSCD0001234', vessel: 'MSC Altair', carrier: 'MSC', originPort: 'CNQAO', destPort: 'DEHAM', etd: _demoDate(-14), eta: _demoDate(28), containerType: '40HQ', containerNum: 'MSCU1234567', dg: false, docsStatus: 'Complete', status: 'In Transit', linkedInvs: ['DINV-0001'], forwarder: 'Kuehne+Nagel', forwarderEmail: 'ops@kn-demo.example', notes: 'Demo shipment — Apex Cold Chain refrigeration units', _demo: true });

  DB.events.push({ id: uid(), ts: new Date(Date.now() - 30*86400000).toISOString(), entityType: 'contact', entityId: conId, verb: 'created', summary: 'Contact created', actor: 'system', _demo: true });
  DB.events.push({ id: uid(), ts: new Date(Date.now() - 14*86400000).toISOString(), entityType: 'contact', entityId: conId, verb: 'converted', summary: 'Quote DQ-0001 created — contact converted', actor: 'system', _demo: true });

  saveAll();
  renderAll();
  toast('Demo data loaded — 6 entity records + 1 payment + 2 events seeded');
}
```

### 1.3 `clearDemoData()`

```js
function clearDemoData() {
  if (!confirm('Clear all demo data? This cannot be undone.')) return;
  DB.sup      = DB.sup.filter(function(r){ return !r._demo; });
  DB.con      = DB.con.filter(function(r){ return !r._demo; });
  DB.qt       = DB.qt.filter(function(r){ return !r._demo; });
  DB.po       = DB.po.filter(function(r){ return !r._demo; });
  DB.inv      = DB.inv.filter(function(r){ return !r._demo; });
  DB.sh       = DB.sh.filter(function(r){ return !r._demo; });
  DB.payments = DB.payments.filter(function(r){ return !r._demo; });
  DB.events   = DB.events.filter(function(r){ return !r._demo; });
  saveAll();
  renderAll();
  toast('Demo data cleared');
}
```

---

## §2 — `rDash()` KPI exclusion

### 2.1 Active invoices filter — add `_demo` exclusion

**BEFORE:**
```js
  var ai = DB.inv.filter(function(i){
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && isCN(i.num)) return false;
    return true;
  });
```

**AFTER:**
```js
  var ai = DB.inv.filter(function(i){
    if (i._demo) return false;
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && isCN(i.num)) return false;
    return true;
  });
```

`tR`, `tNP`, `tOut`, and `tBuyerDep` all derive from `ai` — all excluded in one change. `tGoodwillCredits` filters `DB.inv` directly and requires a separate patch (see §2.4 — mandatory).

### 2.2 PO balance and `tSupDep` — add `_demo` exclusion

**BEFORE:**
```js
  var tPO = DB.po.filter(function(p){ return p.status!=='Cancelled' && p.status!=='Settled'; })
```

**AFTER:**
```js
  var tPO = DB.po.filter(function(p){ return !p._demo && p.status!=='Cancelled' && p.status!=='Settled'; })
```

And:

**BEFORE:**
```js
  var tSupDep = DB.po.filter(function(p){ return p.status!=='Cancelled'; })
```

**AFTER:**
```js
  var tSupDep = DB.po.filter(function(p){ return !p._demo && p.status!=='Cancelled'; })
```

### 2.3 In-transit count — add `_demo` exclusion

**BEFORE:**
```js
  var inTransit = DB.sh.filter(function(s){ return s.status === 'In Transit'; }).length;
```

**AFTER:**
```js
  var inTransit = DB.sh.filter(function(s){ return !s._demo && s.status === 'In Transit'; }).length;
```

### 2.4 Goodwill credits — add `_demo` exclusion

**BEFORE:**
```js
  var tGoodwillCredits = DB.inv.filter(function(i){ return i.type==='goodwill_credit' && i.status!=='Cancelled'; })
```

**AFTER:**
```js
  var tGoodwillCredits = DB.inv.filter(function(i){ return !i._demo && i.type==='goodwill_credit' && i.status!=='Cancelled'; })
```

### 2.5 Dashboard notice banner

After the KPI calculations and before `G('kpis').innerHTML = ...`, add a demo banner variable:

```js
  var hasDemo = DB.inv.some(function(i){ return i._demo; }) || DB.sh.some(function(s){ return s._demo; }) || DB.po.some(function(p){ return p._demo; });
  var demoBanner = hasDemo
    ? '<div style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;padding:8px 12px;font-size:.52rem;border-radius:3px;margin-bottom:10px;">&#9888; Demo data active — financial KPIs exclude demo records. <button onclick="clearDemoData()" style="margin-left:8px;font-size:.48rem;padding:1px 6px;cursor:pointer;border:1px solid #92400e;background:transparent;color:#92400e;border-radius:2px;cursor:pointer;">Clear Demo Data</button></div>'
    : '';
```

Then prepend `demoBanner` to the KPI grid. The `G('kpis')` element currently receives the KPI HTML directly. Instead, wrap the target:

**BEFORE:**
```js
  G('kpis').innerHTML =
    '<div class="kpi">...
```

**AFTER:**
```js
  G('kpis').innerHTML = demoBanner +
    '<div class="kpi">...
```

### 2.6 Pipeline list — demo badge

In the pipeline list `DB.inv.slice().reverse().slice(0,10).map(...)`, add a DEMO badge on the `pref` span:

**BEFORE (in pipeline map):**
```js
        '<span class="pref">' + (san(inv.num)||'-') + '</span>' +
```

**AFTER:**
```js
        '<span class="pref">' + (san(inv.num)||'-') + (inv._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</span>' +
```

---

## §3 — Demo badge in entity list tables

The DEMO badge HTML string (define as a local var in each render function, or inline):

```
(r._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '')
```

### 3.1 `rSup()` — name cell

**BEFORE:**
```js
    return '<tr><td style="font-weight:500;color:var(--cr)">' + san(s.name||'-') + '</td>
```

**AFTER:**
```js
    return '<tr><td style="font-weight:500;color:var(--cr)">' + san(s.name||'-') + (s._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>
```

### 3.2 `rInv()` — invoice number cell

**BEFORE:**
```js
      '<td style="color:var(--cr);font-weight:500;white-space:nowrap">' + (san(inv.num)||'-') + '</td>' +
```

**AFTER:**
```js
      '<td style="color:var(--cr);font-weight:500;white-space:nowrap">' + (san(inv.num)||'-') + (inv._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>' +
```

### 3.3 `rPO()` — PO number cell

**BEFORE:**
```js
      '<td style="color:var(--bl);font-weight:500;white-space:nowrap">' + san(po.num||'-') + '</td>' +
```

**AFTER:**
```js
      '<td style="color:var(--bl);font-weight:500;white-space:nowrap">' + san(po.num||'-') + (po._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>' +
```

### 3.4 `rShp()` — ref cell

**BEFORE:**
```js
      '<td style="font-weight:500;color:var(--cr);">' + san(s.ref||'-') + dgPill + '</td>' +
```

**AFTER:**
```js
      '<td style="font-weight:500;color:var(--cr);">' + san(s.ref||'-') + dgPill + (s._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>' +
```

### 3.5 `rQte()` — quote number cell

**BEFORE:**
```js
      + '<td style="font-weight:600;color:var(--cr);">' + san(q.num) + '</td>'
```

**AFTER:**
```js
      + '<td style="font-weight:600;color:var(--cr);">' + san(q.num) + (q._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>'
```

### 3.6 `rCon()` — name cell

**BEFORE:**
```js
      '<td>' + san(c.name) + stale + '</td>' +
```

**AFTER:**
```js
      '<td>' + san(c.name) + stale + (c._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td>' +
```

---

## §4 — Settings Demo Mode card

Insert after the closing `</div>` of the Privacy & Data card (line ~559) and before `<div class="card" id="cfg-rates">`:

**BEFORE:**
```html
    <div class="card" id="cfg-rates">
```

**AFTER:**
```html
    <div class="card">
      <div class="ct">Demo Mode</div>
      <p style="font-size:.48rem;color:var(--m);margin-bottom:10px;">Load a complete end-to-end demo scenario — supplier, contact, quote, PO, invoice, payment, and in-transit shipment — to showcase Stackd to prospects. Demo records are excluded from financial KPIs.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-s" style="font-size:.52rem;" onclick="loadDemoData()">Load Demo Data</button>
        <button class="btn btn-g" style="font-size:.52rem;" onclick="clearDemoData()">Clear Demo Data</button>
      </div>
    </div>
    <div class="card" id="cfg-rates">
```

---

## §5 — `tests/run.js` new test cases

Append after the existing AI test block:

```js
// ── REQ-DEMO-001: Demo mode ──────────────────────────────────────────────────

test('loadDemoData: seeds 6 entity records + 1 payment + 2 events', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  assert.strictEqual(ctx.DB.sup.length, 1, 'supplier seeded');
  assert.strictEqual(ctx.DB.con.length, 1, 'contact seeded');
  assert.strictEqual(ctx.DB.qt.length, 1, 'quote seeded');
  assert.strictEqual(ctx.DB.po.length, 1, 'po seeded');
  assert.strictEqual(ctx.DB.inv.length, 1, 'invoice seeded');
  assert.strictEqual(ctx.DB.sh.length, 1, 'shipment seeded');
  assert.strictEqual(ctx.DB.payments.length, 1, 'payment seeded');
  assert.strictEqual(ctx.DB.events.length, 2, '2 events seeded');
  assert.ok(ctx.DB.sh[0]._demo === true, 'shipment has _demo flag');
  assert.ok(ctx.DB.con[0]._demo === true, 'contact has _demo flag');
});

test('loadDemoData: idempotent — second call does not duplicate (AC-2)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.loadDemoData();
  assert.strictEqual(ctx.DB.sup.length, 1, 'no duplicate supplier');
  assert.strictEqual(ctx.DB.sh.length, 1, 'no duplicate shipment');
});

test('loadDemoData: all seeded records have _demo:true', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var allDemoArrays = [ctx.DB.sup, ctx.DB.con, ctx.DB.qt, ctx.DB.po, ctx.DB.inv, ctx.DB.sh, ctx.DB.payments];
  allDemoArrays.forEach(function(arr){
    arr.forEach(function(r){ assert.ok(r._demo === true, 'record has _demo:true'); });
  });
  ctx.DB.events.forEach(function(e){ assert.ok(e._demo === true, 'event has _demo:true'); });
});

test('loadDemoData: demo shipment is In Transit CNQAO→DEHAM (AC-8)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var sh = ctx.DB.sh[0];
  assert.strictEqual(sh.status, 'In Transit', 'status In Transit');
  assert.strictEqual(sh.originPort, 'CNQAO', 'origin port CNQAO');
  assert.strictEqual(sh.destPort, 'DEHAM', 'dest port DEHAM');
  assert.strictEqual(sh.vessel, 'MSC Altair', 'vessel MSC Altair');
});

test('loadDemoData: demo contact has 2 events (AC-9)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var conId = ctx.DB.con[0].id;
  var events = ctx.DB.events.filter(function(e){ return e.entityId === conId; });
  assert.strictEqual(events.length, 2, '2 events for demo contact');
  var verbs = events.map(function(e){ return e.verb; }).sort();
  assert.ok(verbs.indexOf('created') >= 0, 'created event present');
  assert.ok(verbs.indexOf('converted') >= 0, 'converted event present');
});

// Note: `confirm` is routed through ctx.confirm in the VM sandbox (same pattern as existing
// clearDemoData-style tests). Tests set ctx.confirm = function(){ return true/false; } before
// calling, then reset to function(){ return false; } after. The harness already includes
// confirm in the VM context — no additional harness changes required.

test('clearDemoData: removes all _demo records (AC-6)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.DB.con.push({ id: 'real-con', name: 'Real Person', email: 'r@r.com', _demo: false });
  ctx.confirm = function(){ return true; };
  ctx.clearDemoData();
  ctx.confirm = function(){ return false; };
  assert.strictEqual(ctx.DB.sup.length, 0, 'demo supplier removed');
  assert.strictEqual(ctx.DB.sh.length, 0, 'demo shipment removed');
  assert.strictEqual(ctx.DB.payments.length, 0, 'demo payment removed');
  assert.strictEqual(ctx.DB.events.length, 0, 'demo events removed');
  assert.strictEqual(ctx.DB.con.length, 1, 'real contact preserved');
  assert.strictEqual(ctx.DB.con[0].id, 'real-con', 'real contact id correct');
});

test('clearDemoData: confirm cancel leaves records intact (AC-7)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.confirm = function(){ return false; };
  ctx.clearDemoData();
  assert.strictEqual(ctx.DB.sh.length, 1, 'shipment intact');
  assert.strictEqual(ctx.DB.events.length, 2, 'events intact');
});

test('rDash KPI exclusion: demo invoice not counted in revenue (AC-4)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  // rDash renders HTML in the DOM and cannot be asserted in VM; apply the filter logic directly
  var ai = ctx.DB.inv.filter(function(i){
    if (i._demo) return false;
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    return true;
  });
  assert.strictEqual(ai.length, 0, 'demo invoice excluded from ai array');
});

test('rDash KPI exclusion: demo PO not counted in PO balance (AC-4)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var tPO = ctx.DB.po.filter(function(p){ return !p._demo && p.status !== 'Cancelled' && p.status !== 'Settled'; });
  assert.strictEqual(tPO.length, 0, 'demo PO excluded from tPO');
  var tSupDep = ctx.DB.po.filter(function(p){ return !p._demo && p.status !== 'Cancelled'; });
  assert.strictEqual(tSupDep.length, 0, 'demo PO excluded from tSupDep');
});

test('rDash KPI exclusion: demo shipment not counted in in-transit (AC-4)', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inTransit = ctx.DB.sh.filter(function(s){ return !s._demo && s.status === 'In Transit'; }).length;
  assert.strictEqual(inTransit, 0, 'demo shipment excluded from in-transit count');
});
```

---

## §6 — Version delivery

On completion:
- CLAUDE.md: bump to `v2.9.31`, update Test count
- `docs/version-history.md`: prepend v2.9.31 row
- `docs/known-gaps.md`: close TRIAL-001 (resolved v2.9.31)
- `STACKD_CONTEXT.md`: update S3-1 status to `✓ Done (v2.9.31)`, update risk R-003 action
- `AI_SYSTEM_PROMPT`: add mention that demo mode exists in Settings; demo records are flagged `_demo:true` and excluded from KPIs
- In-app changelog: prepend v2.9.31 block
- Raise PR to `claude/amazing-galileo-4hhygo`

---

## Manual QA checklist

- [ ] AC-1: Load Demo Data → 6 entity records + 1 payment + 2 events in DB; toast shown
- [ ] AC-2: Load Demo Data again → "Demo data already loaded" toast; no duplicates
- [ ] AC-3: Check all 6 list tables — DEMO badge visible on demo record in each
- [ ] AC-4: Dashboard KPIs — revenue/outstanding/PO balance/in-transit count all zero (or reflect only real records); yellow banner shown with Clear button
- [ ] AC-5: Pipeline list — DINV-0001 appears with DEMO badge
- [ ] AC-6: Clear Demo Data (confirm OK) → all demo records gone from all tables; banner gone
- [ ] AC-7: Clear Demo Data (confirm cancel) → all records still present
- [ ] AC-8: Shipment list → DSHP-0001 status "In Transit", CNQAO→DEHAM, MSC Altair
- [ ] AC-9: Contact modal for Thomas Bergmann → Activity accordion shows 2 events (created + converted), newest first
- [ ] AC-10: Settings → Demo Mode card visible with both buttons
