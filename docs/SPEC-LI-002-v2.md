# SPEC-LI-002 v2 — Supplier-linked Line Item catalogue: quick-add fix, Quote→catalogue promotion queue, picker/library search+grouping

**Requirement:** REQ-LI-002 v11 (clean PASS, independent requirements-gate review round 11)
**Status:** v2 — revises v1 after independent spec-gate review round 1: **CONDITIONAL PASS**, 2 blocking + 3 advisory, all personally re-verified against live code before being accepted. Blocking: (1) §12.1's "Current" HTML quote for `index.html:2544-2548` silently dropped a real line (`<div class="mb"><p>...Select items to add...</p>`) with no ellipsis marking the omission, making the diff impossible to place correctly — corrected to the complete, real markup (now `:2544-2549`), with the new `pick-q` search box placed inside the existing `.mb` wrapper; (2) the test-count arithmetic was self-contradictory and wrong in three places ("29 cases total" vs "31 total" vs "+31"/"31 new tests") — the REQ has exactly 30 ACs (AC-1 through AC-15 plus every lettered variant, recounted directly from the REQ text) and §14's own 29-item list already covered all 30 correctly (item 29 covers two ACs as a pair); all three wrong numbers corrected to 30. Advisory, also fixed: a dangling `§6.4` cross-reference (and a second dangling `§6` reference) pointing at the wrong section — both corrected to `§8` / `§8.3`, the review-banner/auto-dismissal sections; the version-delivery checklist gained two explicit checkbox lines for the `showV fns`/`renderAll` and `syncEnt`/`pullAll`/`pushAll` "no new entry needed" confirmations, which were justified in the body (§2.6/§2.7) but had no corresponding checklist line; a caution note added to §14 that `tests/fixtures.js` lacks a `liPending` key (pre-existing precedent, not a new gap) and new tests must use `resetDB()`, not `loadFixtures()`. **Process note:** v1 was edited in place for this round's fixes rather than preserved as a separate historical file before editing — a deviation from this repo's own REQ/SPEC versioning discipline (each revision should be its own file). This is corrected going forward: `docs/SPEC-LI-002-v1.md` as it now stands on disk contains v2's own fixes, not the original round-1-submitted draft; v2 (this file) is the authoritative current version from this point on, and every subsequent revision will be its own new file per the established convention.
**Date:** 2026-10-17

---

## 1. Overview

Three independent fixes to the Line Item catalogue (`DB.li`), all in `index.html`, no build step, no Supabase migration, no change to `DB.li`'s own record shape:

1. **Quick-add stops discarding supplier attribution.** Invoice quick-add (`quickAddLine()`) requires a supplier for Product lines; the new value is editable in `rILT()`'s own table; `vInv()` backstops it at save time.
2. **Quote acceptance auto-queues catalogue promotion, review-gated.** `saveQte()` queues a `'new'` or `'update'` candidate into a new local-only entity, `DB.liPending[]`, whenever an accepted Quote's line describes a supplier-attributed item the catalogue doesn't yet have (or has stale pricing for). A banner on the Line Items tab lets the operator Approve (opens the real Line Item form, pre-filled) or Dismiss each candidate — nothing is ever written to `DB.li` without an explicit save.
3. **The "Import from Library" picker and the main Line Items tab both gain search + supplier grouping,** matching patterns already used elsewhere in the app.

This SPEC is the literal code-level translation of REQ-LI-002 v11's LI-002a through LI-002j. Every function/line cited below was independently re-verified against the current `index.html` while drafting this SPEC (not copied from the REQ's own citations without re-checking) — line numbers match the REQ's v11 citations because no edits have been made to `index.html` since that review concluded.

---

## 2. State layer additions

### 2.1 `_liApproveCtx` session-scoped variable

Add immediately after the existing `_invEditSnapshot` declaration (`index.html:3061`):

```js
var _invEditSnapshot = null; // G-06: pre-edit snapshot captured at unlock, cleared on save or close
var _liApproveCtx = null;    // REQ/SPEC-LI-002: {candidateId, quoteNum} while Approve is mid-flow; null otherwise. Set AFTER openLI()/editLI() (which clear it first), never before.
```

### 2.2 `K` (localStorage key)

Add `lip` to `const K` (`index.html:3020`):

```js
const K = {s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm', sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai', co:'st_co', ev:'st_ev', bu:'st_buy', ord:'st_ord', spm:'st_spm', lip:'st_lip'};
```

### 2.3 `DB` entity

Add `liPending` to the `DB` init object (`index.html:3033`):

```js
let DB = { sup: ldArr(K.s), li: ldArr(K.l), inv: ldArr(K.i), po: ldArr(K.p), payments: ldArr(K.pm), sh: ldArr(K.sh), qt: ldArr(K.qt), con: ldArr(K.co), events: ldArr(K.ev), buy: ldArr(K.bu), ord: ldArr(K.ord), supPayments: ldArr(K.spm), liPending: ldArr(K.lip) };
```

### 2.4 `EI` — no change

No `EI.lip` entry (REQ LI-002e §2): there is no single "currently editing" concept for this entity — the review banner (§8 below) operates on the live list directly, and Approve routes through the existing `EI.l`/`openLI()`/`editLI()` machinery instead.

### 2.5 `saveAll`

Add `sv(K.lip,DB.liPending)` to the end of the arrow function (`index.html:4335`):

```js
const saveAll = () => { sv(K.s,DB.sup); sv(K.l,DB.li); sv(K.i,DB.inv); sv(K.p,DB.po); sv(K.pm,DB.payments); sv(K.sh,DB.sh); sv(K.qt,DB.qt); sv(K.co,DB.con); sv(K.ev,DB.events); sv(K.bu,DB.buy); sv(K.ord,DB.ord); sv(K.spm,DB.supPayments); sv(K.lip,DB.liPending); };
```

### 2.6 `showV fns` / `renderAll` — confirmed no new entry needed

`DB.liPending` has no standalone nav tab. Its UI is a banner on the existing `v-li` view, rendered by `rLIPending()`, called from inside `rLI()` (§6.2) — and `rLI` is already both `fns.li` (`index.html:5312`) and one of `renderAll()`'s calls (`index.html:5315`). No change to either.

### 2.7 `syncEnt()` / `pullAll()` / `pushAll()` — confirmed no entry

`DB.liPending` is deliberately local-only, never Cloud-Data-synced (REQ Decision 5). Do not add `'liPending'`/`'lip'` to any Supabase sync entity list.

---

## 3. `DB.liPending[]` record schema

```js
{
  id:             string,          // uid()
  status:         'pending'|'approved'|'dismissed',
  kind:           'new'|'update',
  matchedLiId:    string|null,     // set only for kind:'update' — the DB.li.id being proposed for an update
  quoteId:        string,          // the Quote that produced this candidate (finalized id, post-persist)
  quoteNum:       string,          // Quote's own num, for display and for history-note attribution
  supId:          string,
  desc:           string,
  uom:            string,
  cost:           number,
  suggestedPrice: number,          // the Quote line's own already-computed sellP, verbatim
  currency:       string,          // qt.currency at queue time
  notes:          string,          // optional — set only on auto-dismissal (§8.3)
  createdAt:      string           // ISO datetime
}
```

No schema change to `DB.li` itself.

---

## 4. Quick-add supplier field (LI-002a)

### 4.1 Quick-add form HTML — new `qal-sup` field + grid fix

Current container and children, `index.html:1201-1208`:

```html
<div style="display:grid;grid-template-columns:90px 2fr 52px 52px 88px 92px auto;gap:6px;margin-top:8px;align-items:end;">
  <div class="fld" style="margin:0;"><label style="font-size:.44rem;">Type</label><select id="qal-type" onchange="qaTypeChg()" ...>...</select></div>
  <div class="fld" style="margin:0;"><label style="font-size:.44rem;">Description</label><input type="text" id="qal-desc" placeholder="e.g. Local Freight"></div>
  ... (UOM, Qty, Unit Cost, Unit Price) ...
  <button class="btn btn-s" style="white-space:nowrap;" onclick="quickAddLine()">+ Add</button>
</div>
```

Replace with (one new `90px` track inserted after the first; one new child inserted between the Type field and the Description field, matching the existing `.fld` markup shape exactly):

```html
<div style="display:grid;grid-template-columns:90px 90px 2fr 52px 52px 88px 92px auto;gap:6px;margin-top:8px;align-items:end;">
  <div class="fld" style="margin:0;"><label style="font-size:.44rem;">Type</label><select id="qal-type" onchange="qaTypeChg()" ...>...</select></div>
  <div class="fld" style="margin:0;"><label style="font-size:.44rem;">Supplier</label><select id="qal-sup" style="font-size:.6rem;border:none;border-bottom:1px dashed var(--ln);padding:2px 0;background:transparent;outline:none;width:100%;"><option value="">Select...</option></select></div>
  <div class="fld" style="margin:0;"><label style="font-size:.44rem;">Description</label><input type="text" id="qal-desc" placeholder="e.g. Local Freight"></div>
  ... (UOM, Qty, Unit Cost, Unit Price unchanged) ...
  <button class="btn btn-s" style="white-space:nowrap;" onclick="quickAddLine()">+ Add</button>
</div>
```

All 7 pre-existing tracks/children are otherwise untouched; this is purely an insertion.

### 4.2 Populate `qal-sup` — add to `rSup()`'s existing population list

`rSup()` (`index.html:5936`) already populates every supplier `<select>` in the app from one `opts` string on every Supplier CRUD and on `renderAll()` (which calls `rSup()` at startup). Add `'qal-sup'` to its target list:

```js
['lf-sup','pf-sup','qal-sup'].forEach(function(id){ var el=G(id); if(el) el.innerHTML='<option value="">Select...</option>'+opts; });
```

No separate population call is needed anywhere else — this one-line addition covers initial load (via `renderAll()`→`rSup()`) and every subsequent Supplier add/edit/delete.

### 4.3 New helper — `invLineHasSupplier(li)`

Add immediately after `invLineHasCostBasis()` (`index.html:8169-8172`), mirroring its exact shape:

```js
function invLineHasCostBasis(li) {
  var resolved = li.lid && DB.li.find(function(x){ return x.id === li.lid; });
  return !!resolved || (+li.unitCost > 0);
}
function invLineHasSupplier(li) {
  var resolved = li.lid && DB.li.find(function(x){ return x.id === li.lid; });
  return !!(resolved && resolved.supId) || !!li.supId;
}
```

A catalogue-linked line (`li.lid` resolves to a real `DB.li` record) is considered to have a supplier via that record's own `supId`, exactly as `invLineHasCostBasis` treats a catalogue-linked line as having a cost basis via the record's own `cost` — even if the line's own `unitCost`/`supId` field is blank. A non-catalogue line needs its own `supId` set directly.

### 4.4 `quickAddLine()` — full replacement

Current (`index.html:8173-8194`):

```js
function quickAddLine() {
  var desc = G('qal-desc') ? G('qal-desc').value.trim() : '';
  var uom  = G('qal-uom')  ? G('qal-uom').value.trim()  : 'pcs';
  var qty  = G('qal-qty')  ? +G('qal-qty').value  : 1;
  var up   = G('qal-up')   ? +G('qal-up').value   : 0;
  var lt   = G('qal-type') ? G('qal-type').value   : 'product';
  var uc   = lt === 'pass-through' ? up : (G('qal-uc') ? +G('qal-uc').value : 0);
  if (!desc) { toast('⚠ Enter a description'); return; }
  if (lt === 'product' && !invLineHasCostBasis({ lid:'', unitCost:uc })) {
    toast('⚠ Product lines need a Unit Cost greater than 0 — enter a real cost, or set Type to Pass-thru/Charge if there\'s no separate cost to record');
    return;
  }
  if (qty === 0) qty = 1;
  cIL.push({ rid:uid(), lid:'', desc:desc, uom:uom, qty:qty, up:up, unitCost:uc, lineType:lt });
  rILT(); calcInv();
  // Clear form
  if (G('qal-desc')) G('qal-desc').value = '';
  if (G('qal-up'))   G('qal-up').value   = '';
  if (G('qal-uc'))   G('qal-uc').value   = '';
  if (G('qal-qty'))  G('qal-qty').value  = '1';
  if (G('qal-type')) { G('qal-type').value = 'product'; qaTypeChg(); }
  toast('✓ Line item added — click Save Invoice to keep');
}
```

Replace with:

```js
function quickAddLine() {
  var desc = G('qal-desc') ? G('qal-desc').value.trim() : '';
  var uom  = G('qal-uom')  ? G('qal-uom').value.trim()  : 'pcs';
  var qty  = G('qal-qty')  ? +G('qal-qty').value  : 1;
  var up   = G('qal-up')   ? +G('qal-up').value   : 0;
  var lt   = G('qal-type') ? G('qal-type').value   : 'product';
  var uc   = lt === 'pass-through' ? up : (G('qal-uc') ? +G('qal-uc').value : 0);
  var sup  = G('qal-sup')  ? G('qal-sup').value    : '';
  if (!desc) { toast('⚠ Enter a description'); return; }
  if (lt === 'product' && !invLineHasCostBasis({ lid:'', unitCost:uc })) {
    toast('⚠ Product lines need a Unit Cost greater than 0 — enter a real cost, or set Type to Pass-thru/Charge if there\'s no separate cost to record');
    return;
  }
  if (lt === 'product' && !invLineHasSupplier({ lid:'', supId:sup })) {
    toast('⚠ Product lines need a Supplier — select one, or set Type to Pass-thru/Charge if there\'s no supplier to record');
    return;
  }
  if (qty === 0) qty = 1;
  cIL.push({ rid:uid(), lid:'', desc:desc, uom:uom, qty:qty, up:up, unitCost:uc, supId:sup, lineType:lt });
  rILT(); calcInv();
  // Clear form
  if (G('qal-desc')) G('qal-desc').value = '';
  if (G('qal-up'))   G('qal-up').value   = '';
  if (G('qal-uc'))   G('qal-uc').value   = '';
  if (G('qal-qty'))  G('qal-qty').value  = '1';
  if (G('qal-sup'))  G('qal-sup').value  = '';
  if (G('qal-type')) { G('qal-type').value = 'product'; qaTypeChg(); }
  toast('✓ Line item added — click Save Invoice to keep');
}
```

Per Decision 1 (REQ §1.2), the new gate only fires for `lineType==='product'` — Pass-through/Charge lines are never blocked on supplier, same as the existing cost-basis gate.

---

## 5. `vInv()` save-time supplier backstop (LI-002b)

Add immediately after the existing cost-basis backstop block (`index.html:10672-10679`), same shape, same scoping to `lineType==='product'`:

```js
  var badProductLine = cIL.some(function(li){
    var lt = li.lineType || 'product';
    return lt === 'product' && !invLineHasCostBasis(li);
  });
  if (badProductLine) {
    toast('⚠ One or more Product lines has no Unit Cost and no linked catalogue item — enter a cost, link a catalogue item, or change that line\'s Type');
    return false;
  }
  // REQ/SPEC-LI-002: hard save-time backstop for supplier attribution, mirroring the
  // cost-basis backstop immediately above exactly — quickAddLine()'s own gate can be
  // bypassed by clearing the Supplier dropdown directly in rILT() after the line was
  // added. Scoped to 'product' lines only, for the same reason as the cost backstop.
  var badSupplierLine = cIL.some(function(li){
    var lt = li.lineType || 'product';
    return lt === 'product' && !invLineHasSupplier(li);
  });
  if (badSupplierLine) {
    toast('⚠ One or more Product lines has no Supplier and no linked catalogue item — select a supplier, link a catalogue item, or change that line\'s Type');
    return false;
  }
```

---

## 6. `rILT()` supplier column (LI-002c)

### 6.1 Invoice line-items table header — new column

Current header (`index.html:1196`):

```html
<table class="lit"><thead><tr><th style="width:22px">#</th><th>Description</th><th style="width:52px">UOM</th><th style="width:40px">Qty</th><th style="width:80px">Unit Cost</th><th style="width:83px">Unit Price</th><th style="width:62px" class="num">Margin</th><th style="width:75px" class="num">Total</th><th style="width:65px">Type</th><th style="width:22px"></th></tr></thead><tbody id="il-tb"></tbody></table>
```

Insert a new `Supplier` column right after `Description` (11 columns total):

```html
<table class="lit"><thead><tr><th style="width:22px">#</th><th>Description</th><th style="width:90px">Supplier</th><th style="width:52px">UOM</th><th style="width:40px">Qty</th><th style="width:80px">Unit Cost</th><th style="width:83px">Unit Price</th><th style="width:62px" class="num">Margin</th><th style="width:75px" class="num">Total</th><th style="width:65px">Type</th><th style="width:22px"></th></tr></thead><tbody id="il-tb"></tbody></table>
```

### 6.2 `rILT()` — add the supplier cell, fix the empty-state `colspan`

Current (`index.html:8215-8254`):

```js
function rILT() {
  var tb=G('il-tb'), cur=G('if-cur').value||'USD';
  if(!cIL.length){ tb.innerHTML='<tr><td colspan="10" style="text-align:center;color:var(--m);font-size:.58rem;padding:12px;">No line items - add manually or import from library</td></tr>'; return; }
  tb.innerHTML=cIL.map(function(li,i){
    ...
    return '<tr>' +
      '<td>' + (i+1) + '</td>' +
      '<td>...(Description input)...</td>' +
      '<td>...(UOM input)...</td>' +
      ...
```

Replace the `colspan` and insert a new `<td>` for Supplier right after the Description `<td>` (editable for every line type — no enforcement here, only in `quickAddLine()`/`vInv()`):

```js
function rILT() {
  var tb=G('il-tb'), cur=G('if-cur').value||'USD';
  if(!cIL.length){ tb.innerHTML='<tr><td colspan="11" style="text-align:center;color:var(--m);font-size:.58rem;padding:12px;">No line items - add manually or import from library</td></tr>'; return; }
  tb.innerHTML=cIL.map(function(li,i){
    var lt = li.lineType || 'product';
    var libItem = li.lid ? DB.li.find(function(x){return x.id===li.lid;}) : null;
    var uc = lt==='pass-through' ? (+li.up||0) : (libItem ? (+libItem.cost||0) : (+li.unitCost||0));
    var ucReadonly = lt==='pass-through' || !!libItem;
    var ucStyle = 'width:74px;text-align:right;' + (ucReadonly ? 'background:#f5f5f5;color:var(--m);' : '');
    var tot = (+li.qty||0)*(+li.up||0);
    var lineMgn;
    if (lt==='pass-through') { lineMgn = '<span style="font-size:.5rem;background:#ddd;color:#555;padding:1px 5px;border-radius:2px;white-space:nowrap;">0% PASS</span>'; }
    else if (lt==='charge') { lineMgn = '<span style="font-size:.5rem;background:rgba(201,150,58,.15);color:var(--gold);padding:1px 5px;border-radius:2px;">CHRG</span>'; }
    else {
      var mgnVal = (+li.up>0 && uc>0) ? (((+li.up-uc)/(+li.up))*100).toFixed(1) : null;
      lineMgn = mgnVal!==null ? '<span style="font-size:.54rem;color:' + (+mgnVal>=20?'var(--gn)':+mgnVal>=10?'var(--gold)':'var(--cr)') + ';">' + mgnVal + '%</span>' : '<span style="color:var(--m);font-size:.52rem;">-</span>';
    }
    var typeOpts = [['product','Product'],['pass-through','Pass-thru'],['charge','Charge']].map(function(t){
      return '<option value="'+t[0]+'"'+(lt===t[0]?' selected':'')+'>'+t[1]+'</option>';
    }).join('');
    var priceOninput = lt==='pass-through'
      ? 'cIL['+i+'].up=+this.value;cIL['+i+'].unitCost=+this.value;calcInv()'
      : 'cIL['+i+'].up=+this.value;calcInv()';
    var supOpts = '<option value="">-</option>' + DB.sup.map(function(s){
      return '<option value="' + s.id + '"' + (li.supId===s.id?' selected':'') + '>' + san(s.name) + '</option>';
    }).join('');
    return '<tr>' +
      '<td style="color:var(--m);font-size:.52rem;">' + (i+1) + '</td>' +
      '<td><input type="text" value="' + (li.desc||'').replace(/"/g,'&quot;') + '" oninput="cIL['+i+'].desc=this.value;calcInv()" placeholder="Description"></td>' +
      '<td><select style="font-size:.56rem;border:none;background:transparent;width:100%;" onchange="cIL['+i+'].supId=this.value;">' + supOpts + '</select></td>' +
      '<td><input type="text" value="' + (li.uom||'') + '" oninput="cIL['+i+'].uom=this.value" placeholder="pcs" style="width:47px;"></td>' +
      '<td><input type="number" value="' + (li.qty||1) + '" min="0" step="any" oninput="cIL['+i+'].qty=+this.value;calcInv()" style="width:36px;"></td>' +
      '<td><input type="number" value="' + uc + '" min="0" step="0.01" '+(ucReadonly?'readonly ':'')+' oninput="cIL['+i+'].unitCost=+this.value;calcInv()" style="'+ucStyle+'"></td>' +
      '<td><input type="number" value="' + (li.up||0) + '" min="0" step="0.01" oninput="'+priceOninput+'" style="width:78px;text-align:right;"></td>' +
      '<td class="num">' + lineMgn + '</td>' +
      '<td class="num litot">' + fmt(tot,cur) + '</td>' +
      '<td><select style="font-size:.5rem;border:none;background:var(--bg);color:var(--m);cursor:pointer;padding:2px;width:100%;" onchange="(function(s){cIL['+i+'].lineType=s.value;if(s.value===\'pass-through\'){cIL['+i+'].unitCost=+cIL['+i+'].up||0;}rILT();calcInv();})(this);">'+typeOpts+'</select></td>' +
      '<td><button class="ab" onclick="remILI(\'' + li.rid + '\')">&#10005;</button></td>' +
      '</tr>';
  }).join('');
  _updQaWarn();
}
```

(The `supOpts` select renders for every line type, per REQ AC-2b — nothing here checks `lineType`; enforcement stays exclusively in `quickAddLine()`/`vInv()`, per Decision 1.)

---

## 7. `saveQte()` — promotion queueing (LI-002d)

### 7.1 Capture `sellP` per line inside the existing versioning loop

Current loop (`index.html:14229-14241`):

```js
lines.forEach(function(l, i) {
  var existLine = existQ ? (existQ.lines||[]).find(function(x){ return x.rid===l.rid; }) : null;
  var history = existLine && existLine.priceHistory ? existLine.priceHistory.slice() : [];
  var lastV = history.length ? history[history.length-1] : null;
  var calcR = lineCalcs[i];
  var effM = qteEffectiveMargin(l, markup);
  var sellP = +(calcR.landed * (1 + effM/100)).toFixed(2);
  var changed = !lastV || lastV.cost !== l.cost || lastV.dutyPct !== l.dutyPct || lastV.markup !== effM || lastV.insRate !== calcR.insPct;
  if (changed) {
    history.push({ v: lastV ? lastV.v+1 : 1, ts: new Date().toISOString(), cost: l.cost, dutyPct: l.dutyPct, markup: effM, insRate: calcR.insPct, ins: +fn(calcR.ins,2), landed: +fn(calcR.landed,2), sellPrice: sellP, note: qlFld(l.rid,'note') });
  }
  l.priceHistory = history;
});
```

Add a `sellPByRid` map, populated in the same loop (no new computation — `sellP` already exists here):

```js
var sellPByRid = {};
lines.forEach(function(l, i) {
  var existLine = existQ ? (existQ.lines||[]).find(function(x){ return x.rid===l.rid; }) : null;
  var history = existLine && existLine.priceHistory ? existLine.priceHistory.slice() : [];
  var lastV = history.length ? history[history.length-1] : null;
  var calcR = lineCalcs[i];
  var effM = qteEffectiveMargin(l, markup);
  var sellP = +(calcR.landed * (1 + effM/100)).toFixed(2);
  sellPByRid[l.rid] = sellP;
  var changed = !lastV || lastV.cost !== l.cost || lastV.dutyPct !== l.dutyPct || lastV.markup !== effM || lastV.insRate !== calcR.insPct;
  if (changed) {
    history.push({ v: lastV ? lastV.v+1 : 1, ts: new Date().toISOString(), cost: l.cost, dutyPct: l.dutyPct, markup: effM, insRate: calcR.insPct, ins: +fn(calcR.ins,2), landed: +fn(calcR.landed,2), sellPrice: sellP, note: qlFld(l.rid,'note') });
  }
  l.priceHistory = history;
});
```

### 7.2 New insertion point — after the existing Order-Request post-persist block

Current tail of `saveQte()` (`index.html:14327-14339`):

```js
  if (cConvertOrdId) {
    var convOrd = DB.ord.find(function(x){ return x.id === cConvertOrdId; });
    if (convOrd) {
      convOrd.activeQuoteId = qt.id;
      if (ordCanTransition(convOrd.stage, 'Quoted')) convOrd.stage = 'Quoted';
      await persistOrdChange(convOrd);
    }
    cConvertOrdId = null;
  }
  closeM('ov-qt');
  rQte();
  toast('Quote ' + qt.num + ' saved');
}
```

Insert the new promotion-queueing block immediately after the `cConvertOrdId` block closes and before `closeM('ov-qt')`:

```js
  if (cConvertOrdId) {
    var convOrd = DB.ord.find(function(x){ return x.id === cConvertOrdId; });
    if (convOrd) {
      convOrd.activeQuoteId = qt.id;
      if (ordCanTransition(convOrd.stage, 'Quoted')) convOrd.stage = 'Quoted';
      await persistOrdChange(convOrd);
    }
    cConvertOrdId = null;
  }

  // REQ/SPEC-LI-002 LI-002d: queue catalogue promotion candidates on the genuine
  // Accepted-transition only (never on a re-save of an already-Accepted Quote),
  // placed here — after both persistence branches and the existing post-persist
  // side effects above — so it never runs on a failed/cancelled save and always has
  // the real, finalized qt.id/qt.num/qt.currency.
  if (isAccepted && !wasAccepted) {
    lines.forEach(function(l) {
      if (!l.supId) return; // LI-002d: lines with no supplier are never queued
      var existingLi = DB.li.find(function(x){
        return x.desc.toLowerCase() === l.desc.toLowerCase() && x.supId === l.supId;
      });
      if (existingLi) {
        var sellP = sellPByRid[l.rid];
        if (+existingLi.cost === +l.cost && +existingLi.price === sellP) return; // AC-5: nothing changed
        var dupUpdate = DB.liPending.some(function(p){
          return p.status === 'pending' && p.kind === 'update' && p.matchedLiId === existingLi.id;
        });
        if (dupUpdate) return; // Decision 7 extended to 'update' (round-2 finding)
        DB.liPending.push({
          id: uid(), status: 'pending', kind: 'update', matchedLiId: existingLi.id,
          quoteId: qt.id, quoteNum: qt.num, supId: l.supId, desc: l.desc, uom: l.uom,
          cost: l.cost, suggestedPrice: sellP, currency: qt.currency,
          createdAt: new Date().toISOString()
        });
      } else {
        var dupNew = DB.liPending.some(function(p){
          return p.status === 'pending' && p.kind === 'new' &&
            p.desc.toLowerCase() === l.desc.toLowerCase() && p.supId === l.supId;
        });
        if (dupNew) return; // Decision 7 (round-1 finding 4)
        DB.liPending.push({
          id: uid(), status: 'pending', kind: 'new', matchedLiId: null,
          quoteId: qt.id, quoteNum: qt.num, supId: l.supId, desc: l.desc, uom: l.uom,
          cost: l.cost, suggestedPrice: sellPByRid[l.rid], currency: qt.currency,
          createdAt: new Date().toISOString()
        });
      }
    });
    sv(K.lip, DB.liPending);
    rLIPending();
  }

  closeM('ov-qt');
  rQte();
  toast('Quote ' + qt.num + ' saved');
}
```

**Why this is correctly ordered for the intra-Quote dedup (AC-8e, round-7 finding):** `lines.forEach` is a plain synchronous loop over a plain array; each iteration's `DB.liPending.some(...)` dup-check reads `DB.liPending` live, which already includes any entry an *earlier line in this same loop* just `.push()`ed — JS arrays are mutated in place, and `.some()` always sees the array's current contents at call time, not a snapshot taken before the loop started. No extra bookkeeping is needed to satisfy AC-8e: the existing `DB.liPending.some(...)` + `.push(...)` pattern, used verbatim and in this order, already has the right semantics.

**Why `existingLi`/`matchedLiId` resolution matches the CSV importer exactly:** the `desc.toLowerCase() === ... && supId === ...` comparison is copied verbatim from `processImport()`'s own fallback match (`index.html:10915-10929`), per REQ §1.1's citation of that precedent. Quote lines never carry a `sku` (confirmed: `cQL`'s line shape, `index.html:14202-14222`, has no `sku` key), so the sku-first branch of the CSV importer's logic is never applicable here and is correctly omitted.

---

## 8. Review UI (LI-002f) — banner, Approve, Dismiss

### 8.1 Banner HTML — new block on the Line Items tab

Insert immediately after the opening `<div class="view" id="v-li">` tag (`index.html:289`), before the existing `<div class="tb">` (`index.html:290`):

```html
<div class="view" id="v-li">
  <div id="li-pending-banner" class="banner" style="display:none;margin-bottom:10px;background:#FEF3C7;border:1px solid #D97706;border-radius:4px;padding:10px 12px;">
    <div style="font-size:.6rem;color:#92400E;margin-bottom:6px;font-weight:600;">&#9888; Catalogue suggestions from accepted Quotes awaiting review:</div>
    <div id="li-pending-list"></div>
  </div>
  <div class="tb">
    ... (unchanged — li-q, li-sf, + New Line Item, etc.) ...
```

### 8.2 `rLIPending()` — renders the banner, called from `rLI()`

```js
function rLIPending() {
  var banner = G('li-pending-banner');
  if (!banner) return;
  var pending = DB.liPending.filter(function(c){ return c.status === 'pending'; });
  if (!pending.length) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';
  G('li-pending-list').innerHTML = pending.map(function(c){
    var kindLabel = c.kind === 'new' ? 'New item' : 'Price update';
    return '<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid rgba(217,119,6,.25);font-size:.58rem;color:#92400E;">' +
      '<span style="font-weight:600;flex:1;">' + san(c.desc) + '</span>' +
      '<span>' + san(gsn(c.supId)) + '</span>' +
      '<span style="font-size:.5rem;background:rgba(217,119,6,.2);padding:1px 5px;border-radius:2px;">' + kindLabel + '</span>' +
      '<span>' + fmtN(c.suggestedPrice, c.currency, 2) + '</span>' +
      '<span style="font-size:.52rem;color:#78350f;">from Quote ' + san(c.quoteNum) + '</span>' +
      '<button class="btn btn-s" style="padding:2px 8px;font-size:.5rem;" onclick="approveLIPending(\'' + c.id + '\')">Approve</button>' +
      '<button class="btn btn-g" style="padding:2px 8px;font-size:.5rem;" onclick="dismissLIPending(\'' + c.id + '\')">Dismiss</button>' +
    '</div>';
  }).join('');
}
```

Add a call to `rLIPending()` at the end of `rLI()` (§10.2 below folds this in).

### 8.3 `approveLIPending(id)`

```js
function approveLIPending(id) {
  var c = DB.liPending.find(function(x){ return x.id === id && x.status === 'pending'; });
  if (!c) return;
  if (c.kind === 'update') {
    // Round-5 fix: matchedLiId may have been deleted on a different device since
    // this (local-only, un-synced) candidate was queued. Check BEFORE calling
    // editLI() — editLI() itself only does a silent `if(!li) return;` with no error.
    var target = DB.li.find(function(x){ return x.id === c.matchedLiId; });
    if (!target) {
      toast("This update suggestion's line item no longer exists — dismissing it.");
      c.status = 'dismissed';
      c.notes = 'Auto-dismissed: matched line item was deleted';
      sv(K.lip, DB.liPending);
      rLIPending();
      return;
    }
    editLI(c.matchedLiId); // clears any stale _liApproveCtx as its own first statement (§9.2)
    G('lf-c').value = c.cost;
    G('lf-p').value = c.suggestedPrice;
  } else {
    openLI(); // clears any stale _liApproveCtx as its own first statement (§9.2)
    G('lf-d').value = c.desc;
    G('lf-sup').value = c.supId;
    G('lf-u').value = c.uom;
    G('lf-c').value = c.cost;
    G('lf-p').value = c.suggestedPrice;
  }
  // Set AFTER openLI()/editLI() — both just cleared it, and both reset lf-cur to
  // USD, which is why lf-cur is also set here, after the call, not before.
  _liApproveCtx = { candidateId: c.id, quoteNum: c.quoteNum };
  G('lf-cur').value = c.currency || 'USD';
}
```

### 8.4 `dismissLIPending(id)`

```js
function dismissLIPending(id) {
  var c = DB.liPending.find(function(x){ return x.id === id && x.status === 'pending'; });
  if (!c) return;
  if (!confirm('Dismiss this catalogue suggestion for "' + c.desc + '"? It will not be added or updated.')) return;
  c.status = 'dismissed';
  sv(K.lip, DB.liPending);
  rLIPending();
  toast('Suggestion dismissed');
}
```

---

## 9. `saveLI()` / `openLI()` / `editLI()` — `_liApproveCtx` mechanism (LI-002f continued)

### 9.1 `saveLI()` — full replacement

Current (`index.html:7948-7992`):

```js
async function saveLI() {
  if (!vLI()) return;
  var newCost  = +G('lf-c').value||0;
  var newPrice = +G('lf-p').value||0;
  var existing = EI.l ? DB.li.find(function(x){ return x.id===EI.l; }) : null;
  var history  = (existing && existing.priceHistory) ? existing.priceHistory.slice() : [];

  if (!existing) {
    history.push({ date: today(), cost: newCost, price: newPrice, invoiceRef: '', notes: 'Initial catalogue price' });
  } else if (newCost !== (+existing.cost||0) || newPrice !== (+existing.price||0)) {
    history.push({ date: today(), cost: newCost, price: newPrice, invoiceRef: '', notes: 'Catalogue price updated' });
  }

  var diml=+G('lf-diml').value||0, dimw=+G('lf-dimw').value||0, dimh=+G('lf-dimh').value||0;
  var dims=(diml&&dimw&&dimh)?{l:diml,w:dimw,h:dimh}:(existing&&existing.dims)||null;
  var dg = !!(G('lf-dg')&&G('lf-dg').checked);

  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var row = { ... };
    var result;
    if (EI.l) { result = await _sb.from('line_items').update(row).eq('id', EI.l).select().single(); }
    else { row.num = nextRefNum(DB.li, 'LI'); result = await _sb.from('line_items').insert(row).select().single(); }
    if (result.error) { toast('Save failed: ' + result.error.message); return; }
    closeM('ov-li');
    await refreshLIFromSupabase();
    audit(EI.l?'UPDATE':'CREATE','li', result.data.id, result.data);
    toast('Line item saved'); renderOnboarding();
    return;
  }

  var li={ ... };
  if(EI.l){ ... } else DB.li.push(li);
  sv(K.l,DB.li); closeM('ov-li'); rLI(); audit(...); toast('Line item saved'); renderOnboarding(); await syncEnt('li',li).catch(function(){});
}
```

Replace with (changes: history-note text substitution when `_liApproveCtx` is set; a new `markCandidateApproved()` inline step duplicated into **both** branches, immediately before each branch's own `closeM('ov-li')` — mirroring `delLI()`/`delCon()`'s own established dual-branch-with-early-return pattern, not `delQte()`'s single-fallthrough pattern):

```js
async function saveLI() {
  if (!vLI()) return;
  var newCost  = +G('lf-c').value||0;
  var newPrice = +G('lf-p').value||0;
  var existing = EI.l ? DB.li.find(function(x){ return x.id===EI.l; }) : null;
  var history  = (existing && existing.priceHistory) ? existing.priceHistory.slice() : [];

  // Seed first history entry on create, or append when cost/price changed via catalogue edit
  if (!existing) {
    history.push({ date: today(), cost: newCost, price: newPrice, invoiceRef: '',
      notes: _liApproveCtx ? ('Initial catalogue price (from Quote ' + _liApproveCtx.quoteNum + ')') : 'Initial catalogue price' });
  } else if (newCost !== (+existing.cost||0) || newPrice !== (+existing.price||0)) {
    history.push({ date: today(), cost: newCost, price: newPrice, invoiceRef: '',
      notes: _liApproveCtx ? ('Catalogue price updated (from Quote ' + _liApproveCtx.quoteNum + ')') : 'Catalogue price updated' });
  }

  var diml=+G('lf-diml').value||0, dimw=+G('lf-dimw').value||0, dimh=+G('lf-dimh').value||0;
  var dims=(diml&&dimw&&dimh)?{l:diml,w:dimw,h:dimh}:(existing&&existing.dims)||null;
  var dg = !!(G('lf-dg')&&G('lf-dg').checked);

  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var row = {
      sku: G('lf-s').value.trim(), "desc": G('lf-d').value.trim(), specs: G('lf-sp').value.trim(),
      hs: G('lf-hs').value.trim(), sup_id: G('lf-sup').value, uom: G('lf-u').value.trim(),
      cost: newCost, price: newPrice, currency: G('lf-cur').value, notes: G('lf-nt').value.trim(),
      dg: dg, dims: dims, price_history: history
    };
    var result;
    if (EI.l) {
      result = await _sb.from('line_items').update(row).eq('id', EI.l).select().single();
    } else {
      row.num = nextRefNum(DB.li, 'LI');
      result = await _sb.from('line_items').insert(row).select().single();
    }
    if (result.error) { toast('Save failed: ' + result.error.message); return; }
    if (_liApproveCtx) {
      var pc1 = DB.liPending.find(function(x){ return x.id === _liApproveCtx.candidateId; });
      if (pc1) { pc1.status = 'approved'; sv(K.lip, DB.liPending); }
      _liApproveCtx = null;
    }
    closeM('ov-li');
    await refreshLIFromSupabase(); // ends in its own rLI(), which covers the banner re-render too
    audit(EI.l?'UPDATE':'CREATE','li', result.data.id, result.data);
    toast('Line item saved'); renderOnboarding();
    return;
  }

  var li={id:EI.l||uid(),num:existing?existing.num:nextRefNum(DB.li,'LI'),sku:G('lf-s').value.trim(),desc:G('lf-d').value.trim(),specs:G('lf-sp').value.trim(),hs:G('lf-hs').value.trim(),supId:G('lf-sup').value,uom:G('lf-u').value.trim(),cost:newCost,price:newPrice,cur:G('lf-cur').value,notes:G('lf-nt').value.trim(),priceHistory:history,invoiceRefs:existing?(existing.invoiceRefs||[]):[],dims:dims,dg:dg};
  if(EI.l){var i=DB.li.findIndex(function(x){return x.id===EI.l;});if(i>-1)DB.li[i]=li;}else DB.li.push(li);
  sv(K.l,DB.li);
  if (_liApproveCtx) {
    var pc2 = DB.liPending.find(function(x){ return x.id === _liApproveCtx.candidateId; });
    if (pc2) { pc2.status = 'approved'; sv(K.lip, DB.liPending); }
    _liApproveCtx = null;
  }
  closeM('ov-li'); rLI(); audit(EI.l?'UPDATE':'CREATE','li',li.id,li); toast('Line item saved'); renderOnboarding(); await syncEnt('li',li).catch(function(){});
}
```

Neither branch needs its own separate render call for the banner: the local branch's existing `rLI()` (right after `closeM(...)` on the same statement sequence) already re-renders it (since `rLI()` calls `rLIPending()`, §10.2), and the Cloud Data branch's existing `await refreshLIFromSupabase()` ends in its own `rLI()` call too — both already run *after* the new approved-marking step above, so both already cover it.

### 9.2 `openLI()` / `editLI()` — clear `_liApproveCtx` as the first statement

Current (`index.html:7927-7947`):

```js
function openLI() {
  EI.l=null; G('li-mt').textContent='New Line Item';
  ...
}
function editLI(id) {
  var li=DB.li.find(function(x){return x.id===id;}); if(!li) return;
  EI.l=id; ...
}
```

Replace with:

```js
function openLI() {
  _liApproveCtx = null; // REQ/SPEC-LI-002: clear any stale Approve context before this entry point takes over the form
  EI.l=null; G('li-mt').textContent='New Line Item';
  ['lf-s','lf-d','lf-sp','lf-u','lf-nt','lf-hs'].forEach(function(f){ var e=G(f); if(e) e.value=''; });
  G('lf-c').value=''; G('lf-p').value=''; G('lf-cur').value='USD'; G('lf-sup').value='';
  G('lf-diml').value=''; G('lf-dimw').value=''; G('lf-dimh').value=''; G('lf-cbm-calc').value='';
  if(G('lf-dg')) G('lf-dg').checked=false;
  vClrAll(['lf-d','lf-sup','lf-hs','lf-c','lf-p']);
  liMgn(); G('ov-li').classList.add('on'); setTimeout(function(){ G('lf-s').focus(); }, 50);
}
function editLI(id) {
  _liApproveCtx = null; // REQ/SPEC-LI-002: clear BEFORE the existence check, so even a failed lookup clears stale context
  var li=DB.li.find(function(x){return x.id===id;}); if(!li) return;
  EI.l=id; G('li-mt').textContent='Edit Line Item' + (li.num ? ' — ' + li.num : '');
  G('lf-s').value=li.sku||''; G('lf-d').value=li.desc||''; G('lf-sp').value=li.specs||''; G('lf-hs').value=li.hs||'';
  G('lf-u').value=li.uom||''; G('lf-nt').value=li.notes||'';
  G('lf-c').value=li.cost||''; G('lf-p').value=li.price||'';
  G('lf-cur').value=li.cur||'USD'; G('lf-sup').value=li.supId||'';
  G('lf-diml').value=li.dims?li.dims.l:''; G('lf-dimw').value=li.dims?li.dims.w:''; G('lf-dimh').value=li.dims?li.dims.h:'';
  if(G('lf-dg')) G('lf-dg').checked=!!li.dg;
  calcLICBM();
  liMgn(); G('ov-li').classList.add('on');
}
```

**Why this closes the AI Assistant re-entrancy gap without touching `closeM()` or the AI handler:** `openLI()` is also called from the "+ New Line Item" button (`index.html:293`) and from `handleAIAction()`'s `create_line_item` branch (`index.html:12351`) — neither of those call sites needs any change, because the clearing now happens inside `openLI()`/`editLI()` themselves, covering every caller uniformly. `closeM()` (`index.html:5316`) also needs no change — it has no `ov-li` case today and none is added; the cancel-then-reopen case is already covered because the *next* `openLI()`/`editLI()` call (the only two functions that ever reopen `ov-li`) clears stale context regardless of how the modal was previously closed.

---

## 10. `delQte()` / `delLI()` cascades (LI-002g, LI-002h)

### 10.1 `delQte()` — single insertion point (both branches already fall through to shared code)

Current (`index.html:14341-14368`):

```js
async function delQte(id) {
  if (!confirm('Delete this quote?')) return;
  var q = DB.qt.find(function(x){ return x.id === id; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) {
    ...
  } else {
    ...
  }
  if (q && q.sourceContactId) {
    ...
  }
  rQte();
  toast('Quote deleted');
}
```

Insert the new cascade after the Contact-revert block, before `rQte()` (one insertion point is correct here — unlike `delLI()` below — because both of `delQte()`'s own branches fall through to this shared tail code):

```js
  if (q && q.sourceContactId) {
    var relC = DB.con.find(function(x){ return x.id === q.sourceContactId; });
    if (relC && relC.status === 'converted') {
      if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
        var revertResult = await _sb.from('contacts').update({ status: 'qualified' }).eq('id', relC.id);
        if (revertResult.error) { console.warn('[Stackd] delQte: failed to revert Contact status for ' + relC.id, revertResult.error.message); }
        else { await refreshConFromSupabase(); }
      } else {
        relC.status = 'qualified';
        sv(K.co, DB.con);
      }
    }
  }
  // REQ/SPEC-LI-002 LI-002g: remove only still-pending candidates referencing this
  // Quote — approved/dismissed entries already served their review purpose and are
  // kept as resolved history.
  var beforeLen = DB.liPending.length;
  DB.liPending = DB.liPending.filter(function(p){ return !(p.quoteId === id && p.status === 'pending'); });
  if (DB.liPending.length !== beforeLen) { sv(K.lip, DB.liPending); rLIPending(); }
  rQte();
  toast('Quote deleted');
}
```

### 10.2 `delLI()` — duplicated in BOTH branches, plus a third `warns` category

Current (`index.html:7993-8018`):

```js
async function delLI(id) {
  var invRefs = DB.inv.filter(function(inv){
    return (inv.lineItems||[]).some(function(li){ return li.lid===id; });
  });
  var poRefs = DB.po.filter(function(po){
    return (po.lineItems||[]).some(function(li){ return li.lid===id; });
  });
  var warns = [];
  if (invRefs.length) warns.push(invRefs.length + ' invoice' + (invRefs.length>1?'s':'') + ' (' + invRefs.map(function(i){return i.num||i.id;}).join(', ') + ')');
  if (poRefs.length)  warns.push(poRefs.length  + ' purchase order' + (poRefs.length>1?'s':'')  + ' (' + poRefs.map(function(p){return p.num||p.id;}).join(', ') + ')');
  var msg = 'Delete this line item?';
  if (warns.length) msg += '\n\nWarning: This item is referenced in:\n  ' + warns.join('\n  ') + '\n\nExisting line entries on those documents will be preserved but the catalogue link will be broken.';
  if (!confirm(msg)) return;

  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('line_items').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshLIFromSupabase();
    toast('Deleted');
    return;
  }

  var _liSku = (DB.li.find(function(l){return l.id===id;})||{}).sku||id;
  DB.li=DB.li.filter(function(l){return l.id!==id;}); sv(K.l,DB.li); rLI(); toast('Deleted'); await delEnt('li',_liSku).catch(function(){});
}
```

Replace with — a new `warns` category (any pending `'update'` candidate targeting this id), and the `DB.liPending` cascade duplicated once in each branch, mirroring `delCon()`'s own verbatim-duplication pattern (not `delQte()`'s single-point pattern, since `delLI()`'s Cloud Data branch ends in its own `return` before ever reaching the local branch's code):

```js
async function delLI(id) {
  var invRefs = DB.inv.filter(function(inv){
    return (inv.lineItems||[]).some(function(li){ return li.lid===id; });
  });
  var poRefs = DB.po.filter(function(po){
    return (po.lineItems||[]).some(function(li){ return li.lid===id; });
  });
  var pendingUpdate = DB.liPending.find(function(p){
    return p.matchedLiId === id && p.status === 'pending';
  });
  var warns = [];
  if (invRefs.length) warns.push(invRefs.length + ' invoice' + (invRefs.length>1?'s':'') + ' (' + invRefs.map(function(i){return i.num||i.id;}).join(', ') + ')');
  if (poRefs.length)  warns.push(poRefs.length  + ' purchase order' + (poRefs.length>1?'s':'')  + ' (' + poRefs.map(function(p){return p.num||p.id;}).join(', ') + ')');
  if (pendingUpdate) warns.push('1 pending catalogue-update suggestion (from Quote ' + pendingUpdate.quoteNum + ')');
  var msg = 'Delete this line item?';
  if (warns.length) msg += '\n\nWarning: This item is referenced in:\n  ' + warns.join('\n  ') + '\n\nExisting line entries on those documents will be preserved but the catalogue link will be broken.';
  if (!confirm(msg)) return;

  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('line_items').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    // REQ/SPEC-LI-002 LI-002h: duplicated here, not placed once after this branch —
    // this branch ends in its own `return` below, mirroring delCon()'s own
    // dual-branch cascade for the identical reason.
    var cloudBeforeLen = DB.liPending.length;
    DB.liPending = DB.liPending.filter(function(p){ return !(p.matchedLiId === id && p.status === 'pending'); });
    if (DB.liPending.length !== cloudBeforeLen) sv(K.lip, DB.liPending);
    await refreshLIFromSupabase(); // ends in its own rLI(), which covers the banner re-render too
    toast('Deleted');
    return;
  }

  var _liSku = (DB.li.find(function(l){return l.id===id;})||{}).sku||id;
  DB.li=DB.li.filter(function(l){return l.id!==id;}); sv(K.l,DB.li);
  var localBeforeLen = DB.liPending.length;
  DB.liPending = DB.liPending.filter(function(p){ return !(p.matchedLiId === id && p.status === 'pending'); });
  if (DB.liPending.length !== localBeforeLen) sv(K.lip, DB.liPending);
  rLI(); toast('Deleted'); await delEnt('li',_liSku).catch(function(){});
}
```

(`rLI()` already covers the banner re-render in the local branch, same as everywhere else in this SPEC.)

---

## 11. `doImport()` / `expAll()` — backup/restore (LI-002e, round-6/7 findings)

### 11.1 `expAll()` — add `liPending` to the export snapshot

Add to the `snap` object (`index.html:13072-13097`), after `supPayments: DB.supPayments,`:

```js
    supPayments: DB.supPayments,
    liPending: DB.liPending,
```

### 11.2 `doImport()` — new restore line

Current restore lines (`index.html:13146-13148`):

```js
    if (data.buy && Array.isArray(data.buy)) { DB.buy = data.buy; sv(K.bu, DB.buy); }
    if (data.ord && Array.isArray(data.ord)) { DB.ord = data.ord; sv(K.ord, DB.ord); }
    if (data.supPayments && Array.isArray(data.supPayments)) { DB.supPayments = data.supPayments; sv(K.spm, DB.supPayments); }
```

Add immediately after, in the same style:

```js
    if (data.buy && Array.isArray(data.buy)) { DB.buy = data.buy; sv(K.bu, DB.buy); }
    if (data.ord && Array.isArray(data.ord)) { DB.ord = data.ord; sv(K.ord, DB.ord); }
    if (data.supPayments && Array.isArray(data.supPayments)) { DB.supPayments = data.supPayments; sv(K.spm, DB.supPayments); }
    if (data.liPending && Array.isArray(data.liPending)) { DB.liPending = data.liPending; sv(K.lip, DB.liPending); }
```

Without this, `saveAll()` (called at the end of `doImport()`, `index.html:13157`) would silently re-persist whatever was already in memory over a restored backup's actual `liPending` contents — the same class of gap `DB.events`/`DB.con`/`DB.buy`/`DB.ord`/`DB.supPayments` already needed, and have, their own explicit restore lines for.

### 11.3 Restore `confirm()` dialog — deliberately unchanged

Per REQ §2 LI-002e: do **not** add a `liPending` count to the dialog message (`index.html:13125-13131`). `DB.events`/`DB.buy`/`DB.supPayments` are restored by the same function without being mentioned there either — this is existing, accepted precedent, not a new gap.

---

## 12. `openPicker()` — search + supplier grouping (LI-002i)

### 12.1 Modal HTML — new search box

Current (`index.html:2544-2549`, round-1 spec-gate finding: v1 had silently dropped the `.mb`/`<p>` line below without an ellipsis marker — corrected to the real, complete markup):

```html
<div class="ov" id="ov-pick" onclick="if(event.target===this)closeM('ov-pick')">
  <div class="modal" style="max-width:620px;"><div class="mh"><h2>Import Line Items</h2><button class="mx" onclick="closeM('ov-pick')">&#215;</button></div>
  <div class="mb"><p style="font-size:.6rem;color:var(--m);margin-bottom:10px;">Select items to add. Quantities editable after import.</p>
  <div id="pick-list"></div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;"><button class="btn btn-g" onclick="closeM('ov-pick')">Cancel</button><button class="btn btn-s" onclick="doPick()">Add Selected</button></div>
  </div></div>
```

Replace with (the new search box is inserted inside the existing `.mb` wrapper, immediately after the instructional `<p>` and before `#pick-list` — `.mb` has no closing tag of its own until the very end of the modal, alongside `.modal`'s, so nothing about its scope needs to change):

```html
<div class="ov" id="ov-pick" onclick="if(event.target===this)closeM('ov-pick')">
  <div class="modal" style="max-width:620px;"><div class="mh"><h2>Import Line Items</h2><button class="mx" onclick="closeM('ov-pick')">&#215;</button></div>
  <div class="mb"><p style="font-size:.6rem;color:var(--m);margin-bottom:10px;">Select items to add. Quantities editable after import.</p>
  <input class="sb" type="text" placeholder="Search items..." id="pick-q" oninput="rPickList()" style="width:100%;margin-bottom:8px;box-sizing:border-box;">
  <div id="pick-list"></div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;"><button class="btn btn-g" onclick="closeM('ov-pick')">Cancel</button><button class="btn btn-s" onclick="doPick()">Add Selected</button></div>
  </div></div>
```

### 12.2 New session-scoped selection state + `openPicker()`/`rPickList()`/`doPick()` — full replacement

Current (`index.html:8255-8271`):

```js
function openPicker() {
  if(!DB.li.length){toast('No items in library yet.');return;}
  G('pick-list').innerHTML=DB.li.map(function(li){ ... }).join('');
  G('ov-pick').classList.add('on');
}
function doPick() {
  var ck=[].slice.call(G('pick-list').querySelectorAll('input:checked')).map(function(c){return c.value;});
  ck.forEach(function(id){ var li=DB.li.find(function(x){return x.id===id;}); if(li) addILI(li.id,li.desc,li.uom,1,li.price); });
  closeM('ov-pick'); toast(ck.length+' item'+(ck.length!==1?'s':'')+' added');
}
```

Replace with (selection state is tracked in a plain object, `_pickChecked`, so checked boxes survive re-rendering when the operator filters — re-rendering the whole list on each keystroke would otherwise silently drop any selections made before typing):

```js
var _pickChecked = {};
function openPicker() {
  if(!DB.li.length){toast('No items in library yet.');return;}
  _pickChecked = {};
  if (G('pick-q')) G('pick-q').value = '';
  rPickList();
  G('ov-pick').classList.add('on');
}
function rPickList() {
  var q = (G('pick-q') ? G('pick-q').value : '').toLowerCase();
  var f = DB.li.filter(function(li){ return !q || (li.desc||'').toLowerCase().includes(q) || (li.sku||'').toLowerCase().includes(q); });
  var groups = {};
  f.forEach(function(li){ var key = li.supId||''; (groups[key]=groups[key]||[]).push(li); });
  var keys = Object.keys(groups).sort(function(a,b){
    if (!a) return 1; if (!b) return -1;
    return gsn(a).localeCompare(gsn(b));
  });
  G('pick-list').innerHTML = keys.map(function(key){
    var label = key ? gsn(key) : 'No Supplier';
    var hdr = '<div style="font-weight:600;font-size:.56rem;color:var(--m);text-transform:uppercase;letter-spacing:.04em;padding:6px 2px 3px;">' + san(label) + '</div>';
    var rows = groups[key].map(function(li){
      var onInv = cIL.some(function(c){ return c.lid === li.id; });
      var refCount = (li.invoiceRefs||[]).length;
      var checked = _pickChecked[li.id] ? ' checked' : '';
      return '<label class="' + (onInv ? 'li-already-on-inv' : '') + '" style="display:flex;align-items:center;gap:9px;padding:7px 9px;border:1px solid var(--ln);margin-bottom:3px;cursor:pointer;font-size:.6rem;' + (onInv ? 'background:#f0fdf4;' : '') + '">' +
        '<input type="checkbox" value="' + li.id + '"' + checked + ' onchange="_pickChecked[\'' + li.id + '\']=this.checked;" style="flex-shrink:0;">' +
        '<div style="flex:1;"><div style="font-weight:500;">' + (san(li.desc)||'-') + (onInv ? ' <span style="color:#1a7a4a;font-size:.5rem;">&#10003; on this invoice</span>' : '') + '</div>' +
        '<div style="color:var(--m);font-size:.54rem;">' + gsn(li.supId) + ' - ' + (li.uom||'-') + ' - ' + fmtN(li.price,li.cur,3) + (refCount ? ' &nbsp;&middot;&nbsp; used on ' + refCount + ' invoice(s)' : '') + '</div></div></label>';
    }).join('');
    return hdr + rows;
  }).join('');
}
function doPick() {
  var ck = Object.keys(_pickChecked).filter(function(id){ return _pickChecked[id]; });
  ck.forEach(function(id){ var li=DB.li.find(function(x){return x.id===id;}); if(li) addILI(li.id,li.desc,li.uom,1,li.price); });
  _pickChecked = {};
  closeM('ov-pick'); toast(ck.length+' item'+(ck.length!==1?'s':'')+' added');
}
```

---

## 13. `rLI()` — supplier grouping on the main Line Items tab (LI-002j)

Current (`index.html:7874-7910`):

```js
function rLI() {
  var q = (G('li-q').value||'').toLowerCase(), sf = G('li-sf').value;
  var f = DB.li.filter(function(l){ return (!q||(l.desc||'').toLowerCase().includes(q)||(l.sku||'').toLowerCase().includes(q)) && (!sf||l.supId===sf); });
  G('li-em').style.display = f.length ? 'none' : 'block';
  G('li-tb').innerHTML = f.map(function(li){
    ... (existing per-row rendering, unchanged — see §10.2 of the live file) ...
  }).join('');
}
```

Replace with — the existing filter logic and the existing per-row rendering body are both **unchanged**; only the grouping wrapper and the new `rLIPending()` call at the end are new:

```js
function rLI() {
  var q = (G('li-q').value||'').toLowerCase(), sf = G('li-sf').value;
  var f = DB.li.filter(function(l){ return (!q||(l.desc||'').toLowerCase().includes(q)||(l.sku||'').toLowerCase().includes(q)) && (!sf||l.supId===sf); });
  G('li-em').style.display = f.length ? 'none' : 'block';
  var groups = {};
  f.forEach(function(li){ var key = li.supId||''; (groups[key]=groups[key]||[]).push(li); });
  var groupKeys = Object.keys(groups).sort(function(a,b){
    if (!a) return 1; if (!b) return -1;
    return gsn(a).localeCompare(gsn(b));
  });
  G('li-tb').innerHTML = groupKeys.map(function(key){
    var label = key ? gsn(key) : 'No Supplier';
    var hdr = '<tr class="li-grp-hdr"><td colspan="12" style="background:var(--bg);font-weight:600;padding:6px 10px;color:var(--m);font-size:.56rem;letter-spacing:.04em;text-transform:uppercase;">' + san(label) + '</td></tr>';
    var rows = groups[key].map(function(li){
      // unchanged body — identical to the existing per-row rendering (margin/price-history/etc.)
      var m = +li.price>0 ? ((+li.price||0)-(+li.cost||0))/(+li.price||1)*100 : null;
      var mc = m===null?'':(m>=20?'phi':m>=10?'pmi':'plo');
      var ph = li.priceHistory || [];
      var phBadge = ph.length
        ? '<span onclick="togglePH(\'' + li.id + '\')" style="cursor:pointer;font-size:.44rem;color:var(--bl);border:1px solid var(--bl);padding:1px 5px;border-radius:2px;white-space:nowrap;margin-left:4px;" title="Show price history">' + ph.length + ' pt' + (ph.length!==1?'s':'') + '</span>'
        : '';
      var phRow = ph.length
        ? '<tr id="ph-' + li.id + '" style="display:none;"><td colspan="12" style="padding:0;background:var(--card);border-bottom:1px solid var(--ln);">' +
            '<div style="padding:8px 14px;">' +
            '<table style="width:100%;border-collapse:collapse;font-size:.52rem;">' +
            '<thead><tr style="color:var(--m);"><th style="padding:3px 8px;text-align:left;">Date</th><th style="padding:3px 8px;text-align:right;">Cost</th><th style="padding:3px 8px;text-align:right;">Price</th><th style="padding:3px 8px;text-align:left;">Invoice</th><th style="padding:3px 8px;text-align:left;">Notes</th></tr></thead><tbody>' +
            ph.map(function(h){
              return '<tr style="border-top:1px solid var(--ln);">' +
                '<td style="padding:3px 8px;">' + san(h.date||'-') + '</td>' +
                '<td style="padding:3px 8px;text-align:right;">' + fmtN(h.cost, li.cur||'USD', 3) + '</td>' +
                '<td style="padding:3px 8px;text-align:right;">' + fmtN(h.price, li.cur||'USD', 3) + '</td>' +
                '<td style="padding:3px 8px;color:var(--cr);">' + san(h.invoiceRef||'-') + '</td>' +
                '<td style="padding:3px 8px;color:var(--m);">' + san(h.notes||'-') + '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table></div></td></tr>'
        : '';
      return '<tr><td style="font-family:monospace;color:var(--m);font-size:.65rem;">' + san(li.num||'-') + (li._demo ? '<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>' : '') + '</td><td style="color:var(--m);font-size:.54rem;">' + (san(li.sku)||'-') + '</td><td style="font-weight:500;">' + (san(li.desc)||'-') + '</td><td style="color:var(--m);font-size:.56rem;">' + san(li.specs||'-') + '</td><td style="color:var(--m);font-size:.54rem;">' + san(li.hs||'-') + '</td><td>' + san(gsn(li.supId)) + '</td>' +
        '<td class="num">' + fmtN(li.cost,li.cur||'USD',3) + '</td>' +
        '<td class="num">' + fmtN(li.price,li.cur||'USD',3) + phBadge + '</td>' +
        '<td>' + (li.uom||'-') + '</td>' +
        '<td class="num"><span class="pill ' + mc + '">' + fp(m) + '</span></td><td>' + (li.cur||'-') + '</td>' +
        '<td>' + (li.invoiceRefs && li.invoiceRefs.length ? '<span style="font-size:.5rem;color:#1a7a4a;">used on ' + li.invoiceRefs.length + ' invoice(s)</span>' : '-') + '</td>' +
        '<td><button class="ab" onclick="editLI(\'' + li.id + '\')">&#9998;</button><button class="ab" onclick="delLI(\'' + li.id + '\')">&#10005;</button></td></tr>' +
        phRow;
    }).join('');
    return hdr + rows;
  }).join('');
  rLIPending();
}
```

`li-q`/`li-sf` (`index.html:291-292`) need no change — the filter they drive is computed first, exactly as before; grouping is applied to the already-filtered result.

---

## 14. Tests

`tests/run.js`'s `resetDB()` (`:211-213`) — add `liPending: []`:

```js
function resetDB() {
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: [], events: [], buy: [], ord: [], supPayments: [], liPending: [] };
}
```

**Caution (round-1 spec-gate advisory):** `tests/fixtures.js` has only its original 7 top-level keys (`sup`/`li`/`inv`/`po`/`payments`/`sh`/`qt`) — it already omits `con`/`events`/`buy`/`ord`/`supPayments` too, so this is established precedent, not a new gap this SPEC introduces. But it means `loadFixtures()` leaves `DB.liPending` `undefined`, not `[]`. Every new test below must use `resetDB()` (which this SPEC does update), not `loadFixtures()`, unless it first confirms `DB.liPending` is set — otherwise `rLI()`'s new `rLIPending()` call, or `saveQte()`'s new `DB.liPending.push(...)`, would throw on a fixture-loaded `DB`.

New test cases, one per acceptance criterion in REQ-LI-002 v11 §3 (AC-1 through AC-15 and all lettered variants — **30 ACs in total**, confirmed by listing every `AC-\d+[a-z]?` identifier in the REQ: AC-1, 2, 2b, 2c, 3, 4, 4b, 5, 6, 7, 8, 8b, 8c, 8d, 8e, 9, 9b, 9c, 9d, 10, 10b, 11, 12, 12b, 12c, 13, 13b, 13c, 14, 15. The 29 numbered items below map one-to-one to the first 28 ACs; item 29 alone covers the last two, AC-14 and AC-15, as a pair — 28 + 2 = 30 test cases in total, not 29 and not 31; both of those numbers appeared elsewhere in v1 and are corrected below, round-1 spec-gate finding):

1. AC-1 — `quickAddLine()` blocks a Product line with no `qal-sup` selected; Pass-through/Charge unaffected.
2. AC-2 — Product quick-add with a supplier persists `supId` on `cIL`, editable via `rILT()`'s new select.
3. AC-2b — Supplier select renders for Pass-through and Charge lines too.
4. AC-2c — quick-add's 8 fields render with no grid overlap (DOM structure check — 8 children, 8-track `grid-template-columns`).
5. AC-3 — `vInv()` rejects a Product line with `supId` cleared directly in `rILT()`, even though quick-add's own gate passed at add time.
6. AC-4 — Accepting a Quote queues one `'new'` candidate with `suggestedPrice === sellP` (not recomputed) and `currency === qt.currency`.
7. AC-4b — Simulated Cloud Data insert failure (mocked `ensureSbAuth()` returning false) queues nothing.
8. AC-5 — Matching existing cost+price queues nothing.
9. AC-6 — Matching existing record with differing cost/price queues one `'update'` candidate.
10. AC-7 — Re-saving an already-Accepted Quote queues nothing.
11. AC-8 — A line with blank `supId` is never queued.
12. AC-8b — Two Quotes, same new desc+supId — second queues nothing while first is pending.
13. AC-8c — Same as AC-8b with differing case in `desc`.
14. AC-8d — Two Quotes, same existing record, differing cost — second queues nothing while first `'update'` is pending.
15. AC-8e — One Quote, two duplicate lines (both `'new'`-triggering, and separately both `'update'`-triggering) — queues exactly one candidate each.
16. AC-9 — Approving a `'new'` candidate pre-fills desc/supplier/cost/price/currency; nothing written until save; candidate → `'approved'`; `priceHistory` names the Quote.
17. AC-9b — Local branch: post-approval manual edit has no Quote reference; cancel-then-manual-edit is unaffected.
18. AC-9c — Cloud Data branch variant of AC-9/AC-9b.
19. AC-9d — Re-entrancy: abandon an Approve flow, trigger `openLI()` via "+ New Line Item" (and separately via the AI Assistant path), save — no false attribution, original candidate stays `'pending'`.
20. AC-10 — Approving an `'update'` candidate overwrites only cost/price/currency.
21. AC-10b — `matchedLiId` no longer resolves — error toast, auto-`'dismissed'`, `DB.li` unchanged.
22. AC-11 — Dismissing marks `'dismissed'`, no `DB.li` write.
23. AC-12 — `DB.liPending` absent from `syncEnt()`/`pullAll()`/`pushAll()` entity lists.
24. AC-12b — `expAll()` includes `liPending`; `saveAll()` persists it; `resetDB()` initializes `[]`.
25. AC-12c — `doImport()` with a differing `liPending` array in the backup replaces the in-memory queue.
26. AC-13 — `delQte()` removes only the pending entry, not the approved one.
27. AC-13b — `delLI()` local branch: same, for `matchedLiId`.
28. AC-13c — `delLI()` Cloud Data branch variant of AC-13b; `confirm()` message names the pending candidate.
29. AC-14 / AC-15 — `openPicker()`/`rLI()` search + supplier grouping, each as its own case within this one list item (so this list's 29 numbered items cover 30 ACs in total — see the note above).

---

## 15. Data model ERD update (`docs/data-model.md`)

```
LiPending (DB.liPending / K.lip = 'st_lip')  — local-only, never Cloud-Data-synced
  id              PK
  status          'pending' | 'approved' | 'dismissed'
  kind            'new' | 'update'
  matchedLiId     FK → LineItem.id   (only for kind:'update')
  quoteId         FK → Quote.id
  quoteNum, supId, desc, uom, cost, suggestedPrice, currency, notes, createdAt

LineItem (DB.li / K.l = 'st_l')
  id              PK
  supId           FK → Supplier.id   (required — vLI())
  ...

Quote (DB.qt / K.qt = 'st_qt')
  id              PK
  ...

LiPending ─── (0..1) ──→ LineItem   via LiPending.matchedLiId  (kind:'update' only)
LiPending ─── (1) ────→ Quote       via LiPending.quoteId
```

---

## 16. Known gaps to add to `docs/known-gaps.md`

| ID | Area | Summary |
|---|---|---|
| LI-GAP-001 | Line Items / promotion queue | A pending `'new'` candidate isn't re-validated against the catalogue at approval time — a manual `saveLI()` duplicate added while the candidate was pending can coexist with it |
| LI-GAP-002 | Line Items / promotion queue | A pending `'update'` candidate's queued cost/price/currency are applied blindly at approval, with no comparison against the live record |
| LI-GAP-003 | Line Items / promotion queue | A dismissed candidate is never automatically re-queued, even for the same Quote — the operator must use the ordinary `saveLI()` form to add it manually |
| LI-GAP-004 | Line Items / promotion queue | No multi-source tracking — if a third Quote later targets the same not-yet-reviewed desc+supId, it is silently skipped (Decision 7), not merged or counted |
| LI-GAP-005 | Line Items / import | `doImport()`'s restore `confirm()` dialog does not mention `liPending` counts (same precedent as `DB.events`/`DB.buy`/`DB.supPayments`) |

---

## 17. `AI_SYSTEM_PROMPT` update (mandatory)

- Invoice quick-add: Product lines now require a Supplier (same as Unit Cost); Pass-through/Charge lines are exempt.
- Invoice line-items table: Supplier is now an editable column for every line type.
- Line Items tab: accepting a Quote may add a catalogue-suggestion banner at the top — Approve opens the real Line Item form pre-filled (nothing saved until the operator saves); Dismiss discards the suggestion. Neither writes to the catalogue silently.
- "Import from Library" and the main Line Items list are now searchable and grouped by supplier.

---

## 18. `CLAUDE.md` updates

- Bump version.
- Add `lip | st_lip | Line Item Pending Promotions (local-only, not Cloud-Data-synced)` to the Entities table.
- No `EI` entry to add (§2.4).
- Add sprint item: Line Item catalogue — quick-add supplier requirement, Quote-acceptance promotion queue, picker/library search+grouping.
- Update test count (+30, per §14).

---

## 19. Version delivery checklist

- [ ] `_liApproveCtx` declared (`index.html:3061`-adjacent)
- [ ] `K.lip = 'st_lip'`
- [ ] `DB.liPending = []`; `DB.liPending = ldArr(K.lip)` on startup
- [ ] No `EI.lip` entry (intentional)
- [ ] `showV fns` / `renderAll` confirmed to need no new entry (§2.6, intentional — covered by the existing `rLI()` call both already make)
- [ ] `syncEnt()` / `pullAll()` / `pushAll()` confirmed to have no `liPending`/`lip` entry (§2.7, intentional — `DB.liPending` is not Cloud-Data-synced)
- [ ] `saveAll()` includes `sv(K.lip, DB.liPending)`
- [ ] Quick-add form: `qal-sup` field inserted; `grid-template-columns` updated to 8 tracks
- [ ] `rSup()`'s population list includes `'qal-sup'`
- [ ] `invLineHasSupplier(li)` added, mirroring `invLineHasCostBasis(li)`
- [ ] `quickAddLine()` — supplier gate added; `supId` pushed onto `cIL`; form-clear includes `qal-sup`
- [ ] `vInv()` — supplier backstop added, mirroring the cost-basis backstop
- [ ] Invoice line-items table header (`index.html:1196`) — Supplier `<th>` added
- [ ] `rILT()` — Supplier `<td>`/`<select>` added; empty-state `colspan` 10→11
- [ ] `saveQte()` — `sellPByRid` map added to the versioning loop; promotion-queueing block inserted after the `cConvertOrdId` block, before `closeM('ov-qt')`
- [ ] Line Items tab: `li-pending-banner`/`li-pending-list` HTML added
- [ ] `rLIPending()`, `approveLIPending(id)`, `dismissLIPending(id)` implemented
- [ ] `saveLI()` — history-note substitution; approved-marking step duplicated into both branches
- [ ] `openLI()`/`editLI()` — `_liApproveCtx = null;` as first statement in both
- [ ] `delQte()` — `DB.liPending` cascade inserted (single point)
- [ ] `delLI()` — `warns` extended with pending-candidate category; `DB.liPending` cascade duplicated into both branches
- [ ] `expAll()` — `liPending: DB.liPending` added
- [ ] `doImport()` — new `data.liPending` restore line added (confirm dialog left unchanged)
- [ ] `openPicker()`/`rPickList()`/`doPick()` replaced; `_pickChecked` added; `pick-q` search box added to `ov-pick`
- [ ] `rLI()` — grouping wrapper added; existing per-row body unchanged; `rLIPending()` called at the end
- [ ] `resetDB()` in `tests/run.js` includes `liPending: []`
- [ ] 30 new tests passing; test count updated
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` updated
- [ ] `docs/known-gaps.md` updated (LI-GAP-001 through LI-GAP-005)
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` updated
- [ ] In-app changelog updated
