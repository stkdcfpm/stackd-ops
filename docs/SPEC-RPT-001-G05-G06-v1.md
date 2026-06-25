# SPEC-RPT-001 G-05 & G-06 v1 — Full Entity Event Log + Invoice Edit Delta

**Requirement:** REQ-RPT-001-v1.md (G-05, G-06)  
**Version target:** v2.9.36  
**Status:** PASS (spec-gate 2026-06-25)  
**FM-1:** Approved — G-05 uses existing `DB.events`/`logEv()`; G-06 adds `editHistory[]` field to existing `DB.inv` (FM-1 item 2)

---

## Overview

- **G-05:** Emit `DB.events` log entries for Invoice, PO, Payment, and Supplier entity lifecycle events. `logEv()` already exists; this spec adds the call sites.
- **G-06:** When a locked invoice is edited and saved, capture a structured diff of changed fields into `inv.editHistory[]`. `actor` is always `'operator'` (no personal data).

---

## §1 — G-05: New event emission points

All calls use the existing signature: `logEv(entityType, entityId, verb, summary, actor)` where `actor = 'operator'`.

### 1.1 Invoice events

Locate `saveInv()`. Add emissions at the following points:

| Point | verb | entityId | summary example |
|---|---|---|---|
| New invoice saved (EI.i === null before save) | `'created'` | `inv.id` | `'Invoice INV10035 created'` |
| Existing invoice saved with status change | `'status_changed'` | `inv.id` | `'Status: Sent → Partially Paid'` — capture old status before overwriting |
| Invoice deleted (`delInv()`) | `'deleted'` | `inv.id` (from record before splice) | `'Invoice INV10035 deleted'` |

For status change detection: capture `existing.status` before the update, compare with new `inv.status` after form read. Only emit if status differs.

**Unlock events:** `unlockInv()` (line ~7118) calls `audit()` — it does **not** call `logEv()`. Add an explicit `logEv()` call inside `unlockInv()` immediately after the existing `audit()` call:

```js
logEv('invoice', inv.id, 'unlocked', 'Unlock reason: ' + reason, 'operator');
```

`reason` is the string already captured from the unlock form at that point in `unlockInv()`.

### 1.2 PO events

Locate `savePO()` and `delPO()`. Add emissions:

| Point | verb | entityId | summary example |
|---|---|---|---|
| New PO saved | `'created'` | `po.id` | `'PO DPO-0001 created'` |
| Existing PO saved with status change | `'status_changed'` | `po.id` | `'Status: Confirmed → In Production'` |
| PO deleted | `'deleted'` | `po.id` | `'PO DPO-0001 deleted'` |

### 1.3 Payment events

Locate `savePayment(payment)` (line ~8092) and `deletePayment(id)` (line ~8142). Add emissions:

| Point | verb | entityId | summary example |
|---|---|---|---|
| `savePayment(payment)` called | `'created'` | `payment.id` | `'Payment $1,500 received — INV10035'` |
| `deletePayment(id)` called (before splice) | `'deleted'` | `pm.id` | `'Payment deleted — INV10035'` |

`entityType` for payments: `'payment'`.

### 1.4 Supplier events

Locate `saveSup()` and `delSup()`. Add emissions:

| Point | verb | entityId | summary example |
|---|---|---|---|
| New supplier saved | `'created'` | `sup.id` | `'Supplier Romerry International created'` |
| Existing supplier saved | `'updated'` | `sup.id` | `'Supplier Romerry International updated'` |
| Supplier deleted | `'deleted'` | `sup.id` | `'Supplier Romerry International deleted'` |

For `updated`: only emit if EI.s is not null (i.e. editing an existing supplier, not creating). Do not emit `updated` on create.

### 1.5 EVT-GAP-001 note

The 2,000-event FIFO cap is pre-existing. These new emission points will accelerate cap exhaustion on active portals. No fix is required in this version — note in the changelog.

---

## §2 — G-06: Invoice edit delta logging

### 2.1 Capture pre-edit snapshot at unlock time

In the unlock confirmation handler (the function that fires when the operator types "CONFIRM" and submits the unlock form), capture a snapshot of the invoice's tracked fields before the modal switches to edit mode:

```js
// Store snapshot on the window-level unlock state object (or as a module-level var)
var _invEditSnapshot = null;  // declare near other AI/modal state vars

// At unlock confirm:
_invEditSnapshot = {
  invId:          inv.id,
  reason:         unlockReason,  // the reason string from the unlock form
  status:         inv.status,
  buyer:          inv.buyer,
  calc_grandTotal: String(inv.calc_grandTotal || '0'),
  dep:            String(inv.dep || '0'),
  taxRate:        String(inv.taxRate || '0'),
  lf:             String(inv.lf || '0'),
  liCount:        (inv.lineItems || []).length,
  liTotal:        (inv.lineItems || []).reduce(function(s,li){ return s+(+li.qty||0)*(+li.up||0); }, 0)
};
```

### 2.2 Write delta on save in `saveInv()`

At the point in `saveInv()` where an existing (unlocked) invoice is about to be persisted, check if `_invEditSnapshot` matches the current invoice ID. If so, compute the delta and write it:

```js
if (_invEditSnapshot && _invEditSnapshot.invId === inv.id) {
  var snap = _invEditSnapshot;
  var changes = [];
  var tracked = ['status','buyer','calc_grandTotal','dep','taxRate','lf'];
  tracked.forEach(function(f) {
    var oldV = String(snap[f] || '0');
    var newV = String(inv[f]  || '0');
    if (oldV !== newV) changes.push({ field: f, from: oldV, to: newV });
  });
  // Line items delta (count + total)
  var newLiCount = (inv.lineItems||[]).length;
  var newLiTotal = (inv.lineItems||[]).reduce(function(s,li){ return s+(+li.qty||0)*(+li.up||0); }, 0);
  if (newLiCount !== snap.liCount) changes.push({ field:'lineItems.count', from:String(snap.liCount), to:String(newLiCount) });
  if (Math.abs(newLiTotal - snap.liTotal) > 0.001) changes.push({ field:'lineItems.total', from:snap.liTotal.toFixed(2), to:newLiTotal.toFixed(2) });

  if (!inv.editHistory) inv.editHistory = [];
  inv.editHistory.push({
    ts:      new Date().toISOString(),
    reason:  snap.reason,
    actor:   'operator',
    changes: changes
  });

  // Also emit to DB.events
  logEv('invoice', inv.id, 'edited',
    changes.length + ' field(s) changed — see invoice editHistory' + (changes.length > 0 ? ' (' + changes.map(function(c){ return c.field; }).join(', ') + ')' : ''),
    'operator');

  _invEditSnapshot = null;  // clear after use
}
```

### 2.3 `editHistory` and exports

`editHistory` is a new field on `DB.inv` records. It is:
- **Included** in `saveAll()` / full JSON backup (`expAll`) automatically (no change needed — `saveAll()` serialises the entire `DB.inv` array).
- **Excluded** from all accounting export mappers (Xero, QuickBooks, FreeAgent, generic CSV/JSON). Verify that the export field lists in the accounting export functions do not include `editHistory`. These mappers work by explicit field inclusion, so no change is needed unless a mapper does a full object spread — check and confirm.

### 2.4 `_invEditSnapshot` reset on modal close

The invoice modal backdrop close is an inline `onclick` on the overlay element and cannot receive new JS without touching HTML. The Cancel button and X button both call `closeM('ov-inv')`.

The correct approach: in `closeM(id)`, add a guard that clears the snapshot when the invoice modal closes:

```js
function closeM(id) {
  // ... existing closeM body ...
  if (id === 'ov-inv') _invEditSnapshot = null;
}
```

Place this line at the **start** of `closeM()`'s existing body (before the `G(id).style.display = 'none'` call or equivalent). This covers all close paths: Cancel button, X button, and backdrop click — without modifying any inline HTML. On Save, `_invEditSnapshot` is already set to `null` in §2.2 before `closeM()` is called, so the guard is a no-op on the save path.

---

## §3 — Tests

Append to `tests/run.js`:

```js
// ── REQ-RPT-001 G-05: Entity event log ──────────────────────────

test('saveInv creates invoice_created event', function() {
  ctx.resetDB();
  ctx.EI.i = null;  // new invoice
  ctx.DB.inv = [];
  ctx.DB.events = [];
  // Minimal valid invoice fields
  mockEl('inv-num').value   = 'INV-T01';
  mockEl('inv-buyer').value = 'Test Buyer';
  mockEl('inv-dst').value   = 'UK';
  mockEl('inv-date').value  = '2026-01-01';
  mockEl('inv-status').value= 'Draft';
  mockEl('inv-cur').value   = 'USD';
  mockEl('inv-tax').value   = '0';
  mockEl('inv-lf').value    = '0';
  mockEl('inv-ins').value   = '0';
  mockEl('inv-oth').value   = '0';
  mockEl('inv-dep').value   = '0';
  mockEl('inv-inco').value  = 'FOB';
  mockEl('inv-pt').value    = 'Net 30';
  mockEl('inv-pol').value   = '';
  mockEl('inv-pod').value   = '';
  mockEl('inv-coo').value   = '';
  mockEl('inv-ft').value    = '';
  mockEl('inv-notes').value = '';
  ctx.cIL = [];
  ctx.saveInv();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='invoice'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'invoice created event emitted');
});

test('savePO creates po_created event', function() {
  ctx.resetDB();
  ctx.EI.p = null;
  ctx.DB.events = [];
  ctx.DB.sup.push({ id:'S1', name:'ACME', cur:'USD' });
  mockEl('pf-sup').value  = 'S1';
  mockEl('pf-num').value  = 'PO-T01';
  mockEl('pf-date').value = '2026-01-01';
  mockEl('pf-cur').value  = 'USD';
  mockEl('pf-status').value = 'Draft';
  mockEl('pf-del').value  = '';
  mockEl('pf-dep').value  = '0';
  mockEl('pf-oth').value  = '0';
  mockEl('pf-pt').value   = '';
  mockEl('pf-nt').value   = '';
  ctx.cPL = [];
  ctx.savePO();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='po'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'PO created event emitted');
});

test('saveSup creates supplier_created event', function() {
  ctx.resetDB();
  ctx.EI.s = null;
  ctx.DB.events = [];
  mockEl('sf-name').value = 'Test Supplier';
  mockEl('sf-cty').value  = 'China';
  mockEl('sf-cur').value  = 'CNY';
  mockEl('sf-ct').value   = '';
  mockEl('sf-em').value   = '';
  mockEl('sf-ph').value   = '';
  mockEl('sf-pt').value   = '';
  mockEl('sf-nt').value   = '';
  ctx.saveSup();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='supplier'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'supplier created event emitted');
});

test('savePayment creates payment_created event', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  var pmt = { id:'pm1', invId:'i1', invNum:'INV001', date:'2026-03-01', amount:1500, method:'Bank Transfer', reference:'REF-01' };
  ctx.savePayment(pmt);
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='payment'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'payment created event emitted');
});

test('deletePayment creates payment_deleted event', function() {
  ctx.resetDB();
  ctx.DB.events = [];
  var pmt = { id:'pm-del', invId:'i1', invNum:'INV001', date:'2026-03-01', amount:500, method:'Bank Transfer', reference:'REF-02' };
  ctx.DB.payments.push(pmt);
  ctx.deletePayment('pm-del');
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='payment'&&e.verb==='deleted'; });
  assertEqual(evts.length, 1, 'payment deleted event emitted');
});

test('saveInv emits status_changed event when status changes', function() {
  ctx.resetDB();
  ctx.DB.inv.push({ id:'i-sc', num:'INV-SC1', buyer:'A', date:'2026-01-01', status:'Draft', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'0', lineItems:[] });
  ctx.DB.events = [];
  ctx.EI.i = 'i-sc';
  mockEl('inv-num').value='INV-SC1'; mockEl('inv-buyer').value='A'; mockEl('inv-dst').value='UK';
  mockEl('inv-date').value='2026-01-01'; mockEl('inv-status').value='Sent'; mockEl('inv-cur').value='USD';
  mockEl('inv-tax').value='0'; mockEl('inv-lf').value='0'; mockEl('inv-ins').value='0';
  mockEl('inv-oth').value='0'; mockEl('inv-dep').value='0'; mockEl('inv-inco').value='FOB';
  mockEl('inv-pt').value='Net 30'; mockEl('inv-pol').value=''; mockEl('inv-pod').value='';
  mockEl('inv-coo').value=''; mockEl('inv-ft').value=''; mockEl('inv-notes').value='';
  ctx.cIL = [];
  ctx.saveInv();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='invoice'&&e.verb==='status_changed'; });
  assertEqual(evts.length, 1, 'status_changed event emitted');
  assert(evts[0].summary.indexOf('Draft')>=0 && evts[0].summary.indexOf('Sent')>=0, 'summary contains old and new status');
});

// ── REQ-RPT-001 G-06: Invoice edit delta ──────────────────────────
// Note: resetDB() does not clear _invEditSnapshot (module-level var). Each G-06 test
// sets ctx._invEditSnapshot explicitly, so isolation is maintained without harness changes.

test('invoice editHistory captures changed field on unlock+save', function() {
  ctx.resetDB();
  // Seed a locked invoice
  var inv = { id:'i-ed1', num:'INV-ED1', buyer:'Apex', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'10000', calc_cogs:'6000', calc_netProfit:'4000', calc_margin:'40', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);

  // Simulate unlock — set snapshot
  ctx._invEditSnapshot = { invId:'i-ed1', reason:'Freight correction', status:'Sent', buyer:'Apex',
    calc_grandTotal:'10000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };

  // Simulate save with changed grand total
  ctx.EI.i = 'i-ed1';
  mockEl('inv-num').value   = 'INV-ED1';
  mockEl('inv-buyer').value = 'Apex';
  mockEl('inv-dst').value   = 'UK';
  mockEl('inv-date').value  = '2026-01-01';
  mockEl('inv-status').value= 'Sent';
  mockEl('inv-cur').value   = 'USD';
  mockEl('inv-tax').value   = '0';
  mockEl('inv-lf').value    = '500';  // changed from 0
  mockEl('inv-ins').value   = '0';
  mockEl('inv-oth').value   = '0';
  mockEl('inv-dep').value   = '0';
  mockEl('inv-inco').value  = 'FOB';
  mockEl('inv-pt').value    = 'Net 30';
  mockEl('inv-pol').value   = ''; mockEl('inv-pod').value = '';
  mockEl('inv-coo').value   = ''; mockEl('inv-ft').value  = '';
  mockEl('inv-notes').value = '';
  ctx.cIL = [];
  ctx.saveInv();

  var saved = ctx.DB.inv.find(function(i){ return i.id==='i-ed1'; });
  assert(saved && saved.editHistory && saved.editHistory.length >= 1, 'editHistory entry created');
  var entry = saved.editHistory[0];
  assertEqual(entry.reason, 'Freight correction', 'reason recorded');
  assertEqual(entry.actor, 'operator', 'actor is operator');
  var lfChange = entry.changes.find(function(c){ return c.field==='lf'; });
  assert(lfChange, 'lf field change captured');
  assertEqual(lfChange.from, '0', 'from value correct');
  assertEqual(lfChange.to, '500', 'to value correct');
});

test('invoice editHistory records empty changes array when no tracked fields changed', function() {
  ctx.resetDB();
  var inv = { id:'i-ed2', num:'INV-ED2', buyer:'Apex', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'5000', calc_cogs:'3000', calc_netProfit:'2000', calc_margin:'40', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);
  ctx._invEditSnapshot = { invId:'i-ed2', reason:'Review', status:'Sent', buyer:'Apex',
    calc_grandTotal:'5000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };
  ctx.EI.i = 'i-ed2';
  mockEl('inv-num').value='INV-ED2'; mockEl('inv-buyer').value='Apex'; mockEl('inv-dst').value='UK';
  mockEl('inv-date').value='2026-01-01'; mockEl('inv-status').value='Sent'; mockEl('inv-cur').value='USD';
  mockEl('inv-tax').value='0'; mockEl('inv-lf').value='0'; mockEl('inv-ins').value='0';
  mockEl('inv-oth').value='0'; mockEl('inv-dep').value='0'; mockEl('inv-inco').value='FOB';
  mockEl('inv-pt').value='Net 30'; mockEl('inv-pol').value=''; mockEl('inv-pod').value='';
  mockEl('inv-coo').value=''; mockEl('inv-ft').value=''; mockEl('inv-notes').value='';
  ctx.cIL = [];
  ctx.saveInv();
  var saved = ctx.DB.inv.find(function(i){ return i.id==='i-ed2'; });
  assert(saved.editHistory.length >= 1, 'history entry created even with no changes');
  assertEqual(saved.editHistory[0].changes.length, 0, 'changes array empty');
});

test('_invEditSnapshot null after save clears state', function() {
  ctx.resetDB();
  var inv = { id:'i-ed3', num:'INV-ED3', buyer:'B', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'500', calc_netProfit:'500', calc_margin:'50', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);
  ctx._invEditSnapshot = { invId:'i-ed3', reason:'Test', status:'Sent', buyer:'B',
    calc_grandTotal:'1000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };
  ctx.EI.i = 'i-ed3';
  mockEl('inv-num').value='INV-ED3'; mockEl('inv-buyer').value='B'; mockEl('inv-dst').value='UK';
  mockEl('inv-date').value='2026-01-01'; mockEl('inv-status').value='Sent'; mockEl('inv-cur').value='USD';
  mockEl('inv-tax').value='0'; mockEl('inv-lf').value='0'; mockEl('inv-ins').value='0';
  mockEl('inv-oth').value='0'; mockEl('inv-dep').value='0'; mockEl('inv-inco').value='FOB';
  mockEl('inv-pt').value='Net 30'; mockEl('inv-pol').value=''; mockEl('inv-pod').value='';
  mockEl('inv-coo').value=''; mockEl('inv-ft').value=''; mockEl('inv-notes').value='';
  ctx.cIL = [];
  ctx.saveInv();
  assertEqual(ctx._invEditSnapshot, null, 'snapshot cleared after save');
});
```

---

## §4 — Version delivery

On completion:
- `CLAUDE.md`: bump to `v2.9.36`, update Test count
- `docs/version-history.md`: prepend v2.9.36 row
- `docs/known-gaps.md`: note EVT-GAP-001 remains open; new emission points accelerate cap
- `AI_SYSTEM_PROMPT`: update version string; add note that invoice edit history is now captured
- In-app changelog: prepend v2.9.36 block
- Raise PR

---

## §5 — Manual QA checklist

**G-05:**
- [ ] Create a new invoice — event appears in DB.events (check via browser DevTools → localStorage → `st_ev`)
- [ ] Change invoice status (e.g. Draft → Sent) and save — status_changed event recorded with old → new
- [ ] Delete an invoice — deleted event recorded
- [ ] Create a new PO — created event recorded
- [ ] Change PO status and save — status_changed event recorded
- [ ] Delete a PO — deleted event recorded
- [ ] Save a payment — payment created event recorded
- [ ] Create a new supplier — supplier created event recorded
- [ ] Update a supplier — supplier updated event recorded
- [ ] Delete a supplier — supplier deleted event recorded

**G-06:**
- [ ] Unlock an invoice, change the local freight charge, save — `editHistory[0]` present with `lf` change captured
- [ ] Unlock an invoice, change nothing, save — `editHistory[0]` present with empty `changes[]`
- [ ] Invoice never unlocked — `editHistory` absent or `[]`
- [ ] Check accounting export — `editHistory` not present in Xero/CSV export columns
- [ ] Restore from backup — `editHistory` preserved after restore
