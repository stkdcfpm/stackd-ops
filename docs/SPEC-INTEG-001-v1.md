# SPEC-INTEG-001 (Phase 1) — Implementation Spec

**Implements:** `docs/REQ-INTEG-001-v2.md` (requirements-gate: CONDITIONAL PASS v1 → PASS v2, confirmatory re-review)
**Status:** Draft — spec-gate not yet run

All line numbers below are cited against `main` as of this spec's writing (521/521 tests passing). Re-verify against current `main` before build if any time has passed.

---

## 1. `ordConvertToQuote()` — add source fields to pushed Quote lines (REQ-INTEG-001a)

**File:** `index.html:2799-2815`

```diff
 function ordConvertToQuote(ordId) {
   var ord = DB.ord.find(function(o){ return o.id === ordId; });
   if (!ord) return;
   cConvertOrdId = ordId;
   openConvertToQuote(ord.contactId);
   var qCur = G('qf-cur') ? G('qf-cur').value : 'USD';
   var committedLines = (ord.lines || []).filter(function(l){ return l.committedResponseId; });
   committedLines.forEach(function(l){
     var resp = (l.rfqResponses || []).find(function(r){ return r.id === l.committedResponseId; });
     if (!resp) return;
     cQL.push({
       rid: uid(), supId: resp.supId, desc: l.itemSpec, qty: l.baseQty || 1, uom: 'pcs',
-      cost: fromGBP(toGBP(resp.cost, resp.currency), qCur), cbm: resp.cbm || 0, dg: !!resp.dg, dutyPct: resp.dutyPct || 0
+      cost: fromGBP(toGBP(resp.cost, resp.currency), qCur), cbm: resp.cbm || 0, dg: !!resp.dg, dutyPct: resp.dutyPct || 0,
+      sourceOrdId: ord.id, sourceOrdLineId: l.id, sourceRfqResponseId: resp.id
     });
   });
   if (committedLines.length) rQLT();
 }
```

Manually-added lines (`addQteLine()`, `index.html:10071-10074`) are unchanged — they never set these fields, so they remain `undefined` on those lines, satisfying REQ-INTEG-001a's "must NOT carry these fields" requirement with no code change needed there.

---

## 2. `saveQte()` — carry source fields through the save (REQ-INTEG-001b)

**File:** `index.html:10249-10337`, specifically the `lines = cQL.map(...)` block at `10252-10265`.

The source fields are never rendered into a DOM input (there is no UI to edit them, per REQ-INTEG-001c), so they must be read directly off the `cQL[i]` working-array element itself, not via `qlFld()` (which reads a DOM element by id — there is no such element for these fields). Conditionally attach them only when present, so a manually-added line's saved object genuinely has no such keys (not `undefined`-valued keys — an actual absence, matching the codebase's existing convention).

```diff
   var lines = cQL.map(function(l){
-    return {
+    var out = {
       rid: l.rid,
       supId: qlFld(l.rid,'supId'),
       desc: qlFld(l.rid,'desc'),
       qty: +qlFld(l.rid,'qty')||1,
       uom: qlFld(l.rid,'uom')||'pcs',
       cost: +qlFld(l.rid,'cost')||0,
       cbm: +qlFld(l.rid,'cbm')||0,
       dg: qlFld(l.rid,'dg'),
       dutyPct: +qlFld(l.rid,'dutyPct')||0,
       markup: qlEffectiveMarkupInput(l.rid)
     };
+    if (l.sourceOrdId) {
+      out.sourceOrdId = l.sourceOrdId;
+      out.sourceOrdLineId = l.sourceOrdLineId;
+      out.sourceRfqResponseId = l.sourceRfqResponseId;
+    }
+    return out;
   });
```

**Why this is safe on every path that reaches `saveQte()`:**
- **Initial creation** (via `ordConvertToQuote()` → operator clicks Save): `cQL[i]` still has the fields pushed in §1, untouched by `rQLT()`'s DOM rendering (which reads `cQL` to build inputs but does not strip extra properties off the array elements themselves).
- **Later edit-save**: `editQte()` (`index.html:10034-10058`) sets `cQL = (q.lines || []).map(function(l){ return Object.assign({}, l); });` (`10038`) — a shallow copy of the *saved* line object, which already carries the source fields from the prior save. `Object.assign({}, l)` copies every own-enumerable property, source fields included. This is the exact mechanism that closes REQ-INTEG-001-v2's AC-2 (fields survive a no-op re-save).

---

## 3. New function `renderQteSourceDriftWarn(q)` + `editQte()` wiring (REQ-INTEG-001e)

### 3.1 New HTML target

**File:** `index.html:2349`, immediately after the existing `qt-rates-warn` div (same modal, same visual convention):

```diff
       <div id="qt-rates-warn" style="margin-bottom:8px;"></div>
+      <div id="qt-drift-warn" style="margin-bottom:8px;"></div>
       <div style="font-family:'Bebas Neue',sans-serif;font-size:.75rem;letter-spacing:.08em;color:var(--cr);margin-bottom:6px;">LINE ITEMS</div>
```

### 3.2 New function

Insert near `renderQteRatesWarn()` (`index.html:10733-10744`), which it deliberately mirrors in visual style (same amber warning-box CSS, same "targeted `<div>`, cleared to empty when not applicable" pattern):

```js
function renderQteSourceDriftWarn(q) {
  var el = G('qt-drift-warn');
  if (!el) return;
  el.innerHTML = '';
  var trackedLines = (q.lines || []).filter(function(l){ return l.sourceOrdId; });
  if (!trackedLines.length) return; // AC-7: no source-tracked lines at all — never show a banner
  var sourceDeleted = false, mismatched = false;
  trackedLines.forEach(function(l) {
    var ord = DB.ord.find(function(o){ return o.id === l.sourceOrdId; });
    if (!ord) { sourceDeleted = true; return; }
    var ordLine = (ord.lines || []).find(function(x){ return x.id === l.sourceOrdLineId; });
    if (!ordLine) { sourceDeleted = true; return; }
    if (ordLine.committedResponseId !== l.sourceRfqResponseId) mismatched = true;
  });
  if (!sourceDeleted && !mismatched) return; // AC-4: everything still matches — no banner
  // "Source deleted" takes precedence over "mismatched" when a Quote has multiple
  // source-tracked lines and different lines hit different conditions — a harder
  // failure (nothing to compare against) is surfaced ahead of a soft mismatch.
  var msg = sourceDeleted
    ? 'Source Order Request no longer exists for one or more lines on this Quote.'
    : 'Source pricing has changed since this Quote was created — review before sending.';
  el.innerHTML = '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;">&#9888; ' + msg + '</div>';
}
```

### 3.3 Wiring into `editQte()`

**File:** `index.html:10034-10058`, alongside the existing `renderQteRatesWarn()` call:

```diff
   updQtePoBtn();
   rQLT();
   calcQte();
   renderQteRatesWarn();
+  renderQteSourceDriftWarn(q);
   G('ov-qt').classList.add('on');
 }
```

`openQte()` (brand-new Quote, `index.html:10011-10021`) needs no equivalent call — a new Quote has no `lines` yet, and even if it's called defensively it would no-op via the `!trackedLines.length` early return. Not adding the call there keeps the diff minimal; adding it defensively is also acceptable and left to the implementer's judgment, since it's a no-op either way.

---

## 4. `autoPos()` — capture the invoice unit-price snapshot per PO line (REQ-INTEG-001f, part 1)

**File:** `index.html:5564-5582`, the line-item push at `5568`.

```diff
 function autoPos(inv) {
   var sm = {};
   (inv.lineItems||[]).forEach(function(li){
     var r=DB.li.find(function(x){return x.id===li.lid;});
-    if(r&&r.supId){ if(!sm[r.supId]) sm[r.supId]=[]; sm[r.supId].push({rid:uid(),lid:li.lid,desc:li.desc,sku:r.sku||'',uom:r.uom||li.uom,qty:li.qty,cost:r.cost||0}); }
+    if(r&&r.supId){ if(!sm[r.supId]) sm[r.supId]=[]; sm[r.supId].push({rid:uid(),lid:li.lid,desc:li.desc,sku:r.sku||'',uom:r.uom||li.uom,qty:li.qty,cost:r.cost||0,sourceInvUp:+li.up||0}); }
   });
   ...
```

No other change to `autoPos()` is needed. `qty:li.qty` (unchanged) already serves as the quantity-comparison baseline per REQ-INTEG-001f/§1.1's finding that no new field is needed for quantity — only price required a new field, since `cost:r.cost||0` is catalogue COGS, never the invoice's own `up`.

---

## 5. New function `renderPoSourceDriftWarn(po)` + `editPO()` wiring (REQ-INTEG-001f, part 2)

### 5.1 New HTML target

**File:** `index.html:2098-2099`, immediately before the Line Items section, mirroring the Quote modal's placement in §3.1:

```diff
         <div class="fld"><label>Payment Terms</label><select id="pf-pt"><option value="">Select (optional)...</option></select></div>
       </div>
+      <div id="po-drift-warn" style="margin-bottom:8px;"></div>
       <div class="ms"><div class="mst b">Line Items (this supplier only)</div>
```

### 5.2 New function

```js
function renderPoSourceDriftWarn(po) {
  var el = G('po-drift-warn');
  if (!el) return;
  el.innerHTML = '';
  if (!po.invId) return; // AC-12: manually created, or qteToPoConvert()-originated — never checked
  var inv = DB.inv.find(function(x){ return x.id === po.invId; });
  if (!inv) {
    el.innerHTML = '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;">&#9888; Source Invoice no longer exists for this PO.</div>';
    return;
  }
  var invLines = inv.lineItems || [];
  var stale = false;

  // Existing PO lines: has the matched invoice line's qty/price changed, or vanished entirely?
  (po.lineItems || []).forEach(function(pl) {
    if (!pl.lid) return; // manually-added via addPLI() — no source to compare, never flags
    var invLine = invLines.find(function(il){ return il.lid === pl.lid; });
    if (!invLine || +invLine.qty !== +pl.qty || +invLine.up !== +(pl.sourceInvUp||0)) stale = true;
  });

  // Reverse check: has a NEW line for this PO's own supplier appeared on the invoice
  // since generation? (REQ-INTEG-001f.3 — the fix for the requirements-gate B-1 finding.)
  if (!stale) {
    var poLids = {};
    (po.lineItems || []).forEach(function(pl){ if (pl.lid) poLids[pl.lid] = true; });
    invLines.some(function(il) {
      if (!il.lid || poLids[il.lid]) return false;
      var cat = DB.li.find(function(x){ return x.id === il.lid; });
      if (cat && cat.supId === po.supId) { stale = true; return true; }
      return false;
    });
  }

  if (!stale) return;
  el.innerHTML = '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;">&#9888; Source Invoice has changed since this PO was generated — review before proceeding.</div>';
}
```

### 5.3 Wiring into `editPO()`

**File:** `index.html:6442-6451`:

```diff
 function editPO(id) {
   var po=DB.po.find(function(x){return x.id===id;}); if(!po) return;
   EI.p=id; cPL=JSON.parse(JSON.stringify(po.lineItems||[]));
   G('po-mt').textContent='Edit PO'; G('po-sm').value=po.status||'Draft';
   G('pf-n').value=po.num||''; G('pf-dt').value=po.date||today();
   G('pf-del').value=po.del||''; G('pf-sup').value=po.supId||'';
   G('pf-cur').value=po.cur||'USD'; G('pf-dep').value=po.dep||'';
   G('pf-oth').value=po.oth||''; G('pf-nt').value=po.notes||''; G('pf-inv').value=po.invNum||''; G('pf-pt').value=po.paymentTerms||'';
+  renderPoSourceDriftWarn(po);
   rPLT(); calcPO(); showV('po',document.querySelector('[data-v="po"]')); G('ov-po').classList.add('on');
 }
```

`openPO()` (brand-new PO, `index.html:6433-6441`) needs no call — a new PO has no `invId` yet, so the check would no-op immediately even if called defensively (same reasoning as §3.3).

---

## 6. `saveInv()` — add `sourceQuoteId` (schema-only, REQ-INTEG-001g)

**File:** `index.html:5413-5562`.

**6.1 — default on the initial object literal** (so every invoice, including brand-new ones, has the key present rather than it being sometimes-absent):

```diff
     incoterm:G('if-inco').value, paymentTerms:G('if-pt').value.trim(),
     terms:G('if-terms').value.trim(), chargesIncluded:G('if-chi').checked, status:G('inv-sm').value,
     lineItems:cIL.map(function(li){ return {rid:li.rid||uid(),lid:li.lid||'',desc:li.desc||'',uom:li.uom||'',qty:+li.qty||0,up:+li.up||0,unitCost:+li.unitCost||0,lineType:li.lineType||'product'}; }), pos:[],
+    sourceQuoteId: '',
     type:(function(){ if(!isCN(G('if-n').value.trim())) return 'invoice'; return (G('if-cn-goodwill')&&G('if-cn-goodwill').checked)?'goodwill_credit':'credit_note'; })(),
```

**6.2 — preserve on every edit-save**, in the existing preserve block, alongside the existing `inv.pos=existing.pos||[];` line (this line already runs unconditionally on every edit-save, regardless of `cIL.length` — the right place to mirror):

```diff
   if(EI.i){
     var idx=DB.inv.findIndex(function(x){return x.id===EI.i;});
     if(idx>-1){
       var existing=DB.inv[idx];
       inv.pos=existing.pos||[];
+      inv.sourceQuoteId=existing.sourceQuoteId||'';
       // If no live line items in this save, preserve existing calc_ fields and lineItems
       if(cIL.length===0) {
```

No other change. Nothing in this phase ever sets `sourceQuoteId` to a non-empty value — per REQ-INTEG-001g, that is explicitly deferred to a future phase.

---

## 7. FM-1 / sync-mapping confirmation (implementation-level, matches REQ-INTEG-001d)

No change to `FIELD_MAPS` (`index.html:3796-3805`), `mapRec()`, `unmapRec()`, `apps-script/Code.gs`, or any `syncEnt`/`pullAll`/`pushAll` entity list. All eight new fields (`sourceOrdId`, `sourceOrdLineId`, `sourceRfqResponseId` on Quote lines; `sourceInvUp` on PO line items; `sourceQuoteId` on Invoice) are local-only additions on already-synced entities, consistent with the existing `approvedBy`/`approvedReason`/`approvedAt` precedent on Quote.

---

## 8. Test plan (maps to `docs/REQ-INTEG-001-v2.md` §3)

One test per acceptance criterion at minimum. Suggested structure, mirroring existing test-file conventions (`tests/run.js`):

- **AC-1, AC-2, AC-3** — build an Order Request with a committed RFQ response, run `ordConvertToQuote()`, assert `cQL[0].sourceOrdId`/`sourceOrdLineId`/`sourceRfqResponseId` are set correctly; call `saveQte()`, assert `DB.qt[0].lines[0]` still has them; re-open via `editQte()` and re-save with no edits, assert they persist (AC-2's exact no-op-resave scenario); separately call `addQteLine()` and save, assert that line has no source keys at all (`'sourceOrdId' in line === false`, not just falsy).
- **AC-4 through AC-7** — construct a Quote with a tracked line, an Order Request with a matching/mismatched/deleted-entirely `committedResponseId`/record, call `renderQteSourceDriftWarn(q)` directly (mock `G('qt-drift-warn')` per the existing `mockEl()` pattern in `tests/run.js`), assert `innerHTML` is empty vs. contains the expected message text.
- **AC-8 through AC-12** — construct an Invoice + `autoPos()`-generated PO, mutate the invoice's line item qty/price/removal, call `renderPoSourceDriftWarn(po)` directly, assert banner presence/absence and message content; separately test a PO with no `invId` and a PO whose `invId` points to a deleted invoice.
- **AC-13** — call `saveInv()` on a brand-new invoice, assert `DB.inv[0].sourceQuoteId === ''`.
- **AC-14** — full suite regression: re-run `node tests/run.js` after the build and confirm the pre-existing count (re-verify the exact number at build time; do not hardcode 521 into a test assertion) plus all new tests pass.
- **AC-15** — a Quote with one manual line (no source fields) and one stale source-tracked line: assert the banner still appears.
- **AC-16** — an invoice with an `autoPos()`-generated PO for supplier X, then a new line item added to the invoice for a Line Item catalogue entry also belonging to supplier X (no change to any existing PO line): assert the banner appears, isolating the new §5.2 reverse-check branch from the existing-line comparison.
- **AC-17** — a PO with one `autoPos()`-line (has `lid`) and one `addPLI()`-line (`lid:''`): with the real line unchanged, assert no banner and no thrown error.
- **AC-18** — a new invoice line added for a supplier with no PO from that invoice at all: assert no error anywhere in normal use (this documents the accepted residual gap as a tested absence — there is no PO object to assert a banner on, so the test's job is only to confirm nothing breaks).
