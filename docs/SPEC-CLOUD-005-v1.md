# SPEC-CLOUD-005 — Purchase Order Cloud Data migration

**Status:** v1 — drafted against `docs/REQ-CLOUD-005-v1.md` (requirements-gate PASS, 3 rounds). Ready for spec-gate.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **Two real creation paths, both fixed** (§1.1e/§1.4 items 3-4/REQ-CLOUD-005g): `autoPos()` (`index.html:7025-7043`, the entity's *primary* creation path per the REQ's own research) and `qteToPoConvert()`'s PO-creation portion (`index.html:12339-12390`) both gain Cloud Data branches, each handling their own one-call-creates-multiple-POs shape.
- **`PO-GAP-007` fix folded into `delPO()`'s own Cloud Data branch** (REQ-CLOUD-005f): sweeping the deleted PO's id out of every Quote's `linkedPOIds[]` ships regardless of whether Purchase Order itself has migrated — see §2.4 for the exact placement reasoning.
- **Combined precondition** (REQ-CLOUD-005b/c): a genuine Supplier-migration-completion + live pre-flight `supId`-resolution check (Line-Item-style), *and* a genuine pre-flight duplicate-`num` scan (Quote-style) — the first entity in this series needing both.
- **`persistPOChange(po, skipRefresh)` shared helper** (REQ-CLOUD-005d), mirroring `persistOrdChange()`/`persistQteChange()` exactly — used by the two FPM-funded-deposit auto-recovery sites (`saveInv()` and `savePayment()`) and by cross-phase retrofit push loops. Not used by `savePO()`/`delPO()`/`autoPos()`/`qteToPoConvert()` (each gets its own dedicated branch, for the same "must assign a fresh id before a dependent write" reasoning as every prior entity's create path in this series).
- **Four-site cross-phase retrofit, both directions** (REQ-CLOUD-005i): three inward (`migrateSuppliersBuyersToSupabase()`, `migrateQteToSupabase()`, `migrateLineItemsToSupabase()` — each already touches `DB.po` today) gain touched-PO tracking + push via `persistPOChange()` if Purchase Order has migrated; `migratePOToSupabase()` itself (new) gains the mirror-image outward retrofit pushing touched Quotes via `persistQteChange()` if Quote has migrated.
- **Outward array-field sweep into `Quote.linkedPOIds[]`** (REQ-CLOUD-005h): matched via Purchase Order's own id-map, element-by-element, never via any other array field as the join key. `Invoice.pos[]` and `DB.supPayments[].poId` get the same array-element treatment but stay local-only fixes (neither entity is Cloud-eligible).
- **`pullAll()` exclusion shaped to the business-key pull path** (REQ-CLOUD-005j): Purchase Order is matched by business key via `findLocalMatchByBizKey('po', ...)` inside its own `try` block (`index.html:4536-4554`), not the `simpleEnts`/`_simpleEntsForBatch` array pattern Quote/Line Item/Contact use.
- **Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only** — the same 9-step mechanics every prior Cloud Data migration has used.

## 0.1 A design decision this SPEC must add: `refreshPOFromSupabase()` must exist, be wired into `initCloudDataLayer()`, **and** the one pre-existing test that wiring breaks must be retrofitted in the same change

Mirroring `persistOrdChange()`/`persistQteChange()`'s own shape, `persistPOChange()` needs a `refreshPOFromSupabase()` to call. §2.1 adds it, wires it into `initCloudDataLayer()` (`index.html:5545-5556`) as a sixth `await` line.

**This repeats a pattern this series has now made the same mistake on twice** (`REQ-CLOUD-003`'s own round-1 B2; `SPEC-CLOUD-004`'s own spec-gate round-1 B1): the pre-existing test `'initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding...)'` (`tests/run.js:7752-7766`) was retrofitted once already (by `SPEC-CLOUD-004`) to stub `ctx.refreshQteFromSupabase` alongside `ctx.refreshOrdFromSupabase`, but it does not yet know about a sixth refresh call. Left unfixed, wiring `refreshPOFromSupabase()` into `initCloudDataLayer()` makes this exact test self-mark `st_po_cloud_migration_ts` on the real, unmocked function (since `DB.po` is empty at that point in the suite), corrupting a later, unrelated, already-shipped test the same way it did for Quote. §3.0 below retrofits this test a second time, in the same change that adds the new refresh call — not as an afterthought discovered by a spec-gate round.

## 0.2 A design decision this SPEC must add: the pre-flight duplicate-`num` scan needs its own third modal

`REQ-CLOUD-005c` requires a real pre-flight duplicate scan, raising (but not resolving) the question of generalizing the by-now-three-times-duplicated modal pattern. Per `REQ-CLOUD-005` §3, that generalization is explicitly out of scope for this migration. §2.6 below adds a third parallel, dedicated `ov-po-dup`/`po-dup-list` modal and a `findDuplicatePONums()`/`showPoDupConflictModal()` pair, structurally identical to the Supplier and Quote pairs, never modifying either existing modal or its functions.

---

## 1. New SQL migration: `supabase/migrations/0005_purchase_orders.sql`

```sql
-- SPEC-CLOUD-005: extends the Cloud Data shared-database layer to Purchase Order.
--
-- Column list resolved against the union of every field savePO() (index.html:8034),
-- autoPos() (index.html:7035), and qteToPoConvert() (index.html:12367-12376) build
-- into a `po` object (REQ-CLOUD-005 §2a) — this is the first entity in this series
-- assembled from three different creation paths with slightly different field sets,
-- rather than one save function.
--
-- `sup_id`/`inv_id`/`quote_id` are deliberately NOT foreign-key-constrained: the
-- referenced entity may not have migrated (or, for Invoice, is not Cloud-eligible at
-- all yet) at the point a Purchase Order migrates. All three are `text`, not `uuid`,
-- for the same reason every prior cross-entity reference in this series is — a
-- not-yet-migrated entity's local id is never RFC-4122 format.
--
-- `date` is `text`, not `date` — matches Quote's `dt` precedent exactly: a bare
-- <input type="date">.value string, never a JS Date object, never reformatted.
--
-- `cre_at`/`upd_at` are two independent, both-nullable timestamptz columns, not one:
-- autoPos() sets `creAt` and never `updAt`; savePO() sets `updAt` and never `creAt`.
-- These reflect the app's own save-time bookkeeping and are distinct from Postgres's
-- own `created_at`/`updated_at` (insert-time only, not touched on UPDATE, matching
-- every prior migration's identical, if slightly misleading, convention).
--
-- `_demo` is deliberately excluded from this schema, matching REQ-CLOUD-003/004's
-- identical precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  num              text not null unique,
  sup_id           text,
  inv_num          text,
  inv_id           text,
  date             text,
  del              text,
  cur              text not null,
  payment_terms    text,
  line_items       jsonb not null default '[]'::jsonb,
  dep              numeric,
  fpm_funded       numeric,
  fpm_recovered    boolean,
  oth              numeric,
  notes            text,
  status           text not null,
  upd_at           timestamptz,
  cre_at           timestamptz,
  quote_id         text,
  quote_num        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

alter table purchase_orders enable row level security;

create policy "authenticated read" on purchase_orders for select using (auth.role() = 'authenticated');
create policy "authenticated write" on purchase_orders for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on purchase_orders for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
```

`num text not null unique` matches every prior entity's ref-number convention, even though Purchase Order's `num` is manually editable — `REQ-CLOUD-005c`'s pre-flight scan (§2.6) is what keeps a migration from ever hitting this constraint.

---

## 2. `index.html` changes

### 2.1 New `refreshPOFromSupabase()`, and `initCloudDataLayer()` wiring (§0.1)

Insert immediately after `refreshQteFromSupabase()` closes (`index.html:5666`), before `persistQteChange()`.

```js
async function refreshPOFromSupabase() {
  if (!_sb) return;
  if (DB.po.length > 0 && !localStorage.getItem('st_po_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Purchase Orders from Cloud Data.'); return; }
  DB.po = result.data.map(function(row){
    var po = {
      id: row.id, num: row.num, supId: row.sup_id || '', invNum: row.inv_num || '', invId: row.inv_id || '',
      date: row.date, del: row.del || '', cur: row.cur, paymentTerms: row.payment_terms || '',
      lineItems: row.line_items || [], dep: row.dep, fpmFunded: row.fpm_funded, fpmRecovered: !!row.fpm_recovered,
      oth: row.oth, notes: row.notes || '', status: row.status
    };
    if (row.upd_at != null) po.updAt = row.upd_at;
    if (row.cre_at != null) po.creAt = row.cre_at;
    if (row.quote_id != null) po.quoteId = row.quote_id;
    if (row.quote_num != null) po.quoteNum = row.quote_num;
    return po;
  });
  sv(K.p, DB.po);
  if (!localStorage.getItem('st_po_cloud_migration_ts')) localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  rPO();
}
```

`updAt`/`creAt`/`quoteId`/`quoteNum` are added to the mapped object only `if (row.x != null)`, never via a bare pass-through or a `!= null ? val : undefined` ternary — the latter still creates the object key with value `undefined` (`'k' in obj` is `true` even then), which is exactly the `SPEC-CLOUD-004` spec-gate round-1 B2 defect this SPEC avoids from the start. `updAt` is set by `savePO()` and never by `autoPos()`; `creAt` is set by `autoPos()` and never by `savePO()`; `quoteId`/`quoteNum` are set only by `qteToPoConvert()`. A Purchase Order round-tripped through Cloud Data must not gain keys it never had locally.

`initCloudDataLayer()` (`index.html:5545-5556`) gains one line, after Quote (matching migration-order precedent):

```js
async function initCloudDataLayer() {
  initSbClient();
  if (!_sb) return;
  if (await ensureSbAuth()) {
    await refreshSupFromSupabase();
    await refreshBuyFromSupabase();
    await refreshLIFromSupabase();
    await refreshConFromSupabase();
    await refreshOrdFromSupabase();
    await refreshQteFromSupabase();
    await refreshPOFromSupabase();
  }
}
```

### 2.2 New `persistPOChange(po, skipRefresh)`

Insert immediately after `refreshPOFromSupabase()` closes.

```js
async function persistPOChange(po, skipRefresh) {
  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('purchase_orders').update({
      num: po.num, sup_id: po.supId || null, inv_num: po.invNum || null, inv_id: po.invId || null,
      date: po.date, del: po.del || null, cur: po.cur, payment_terms: po.paymentTerms || null,
      line_items: po.lineItems || [], dep: po.dep, fpm_funded: po.fpmFunded, fpm_recovered: !!po.fpmRecovered,
      oth: po.oth, notes: po.notes || null, status: po.status,
      upd_at: po.updAt != null ? po.updAt : null, cre_at: po.creAt != null ? po.creAt : null,
      quote_id: po.quoteId != null ? po.quoteId : null, quote_num: po.quoteNum != null ? po.quoteNum : null
    }).eq('id', po.id);
    if (result.error) { console.warn('[Stackd] persistPOChange: failed to push Purchase Order update for ' + po.id, result.error.message); return; }
    if (!skipRefresh) await refreshPOFromSupabase();
    return;
  }
  sv(K.p, DB.po);
}
```

The local (non-`_sb`) branch persists the entire `DB.po` array, matching `sv()`'s own semantics everywhere else. `skipRefresh` is used exactly as `persistOrdChange()`/`persistQteChange()`'s: the four multi-record retrofit loops (§2.9-§2.12) pass `true` and call `refreshPOFromSupabase()` themselves once, after their own loop.

### 2.3 `savePO()` — cloud-aware create/update branch (`index.html:8029-8040`)

Current:

```js
async function savePO() {
  if (!vPO()) return;
  var invNumVal = G('pf-inv').value.trim();
  var linkedInv = DB.inv.find(function(i){ return i.num === invNumVal; });
  var _poOldStatus = EI.p ? ((DB.po.find(function(x){return x.id===EI.p;})||{}).status || null) : null;
  var po={id:EI.p||uid(),num:G('pf-n').value.trim(),supId:G('pf-sup').value,invNum:invNumVal,invId:linkedInv?linkedInv.id:'',date:G('pf-dt').value,del:G('pf-del').value,cur:G('pf-cur').value,paymentTerms:G('pf-pt').value.trim(),lineItems:cPL,dep:+G('pf-dep').value||0,fpmFunded:+G('pf-fpm').value||0,fpmRecovered:G('pf-rec').checked,oth:+G('pf-oth').value||0,notes:G('pf-nt').value.trim(),status:G('po-sm').value,updAt:new Date().toISOString()};
  if(EI.p){var i=DB.po.findIndex(function(x){return x.id===EI.p;});if(i>-1)DB.po[i]=po;}else DB.po.push(po);
  sv(K.p,DB.po); closeM('ov-po'); rPO(); rDash(); audit(EI.p?'UPDATE':'CREATE','po',po.id,po);
  if (!EI.p) { logEv('po', po.id, 'created', 'PO ' + po.num + ' created', 'operator'); }
  else if (_poOldStatus !== null && _poOldStatus !== po.status) { logEv('po', po.id, 'status_changed', 'Status: ' + _poOldStatus + ' → ' + po.status, 'operator'); }
  toast('PO saved'); await syncEnt('po',po).catch(function(){});
}
```

New:

```js
async function savePO() {
  if (!vPO()) return;
  var invNumVal = G('pf-inv').value.trim();
  var linkedInv = DB.inv.find(function(i){ return i.num === invNumVal; });
  var _poOldStatus = EI.p ? ((DB.po.find(function(x){return x.id===EI.p;})||{}).status || null) : null;
  var po={id:EI.p||uid(),num:G('pf-n').value.trim(),supId:G('pf-sup').value,invNum:invNumVal,invId:linkedInv?linkedInv.id:'',date:G('pf-dt').value,del:G('pf-del').value,cur:G('pf-cur').value,paymentTerms:G('pf-pt').value.trim(),lineItems:cPL,dep:+G('pf-dep').value||0,fpmFunded:+G('pf-fpm').value||0,fpmRecovered:G('pf-rec').checked,oth:+G('pf-oth').value||0,notes:G('pf-nt').value.trim(),status:G('po-sm').value,updAt:new Date().toISOString()};

  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var poRow = {
      num: po.num, sup_id: po.supId || null, inv_num: po.invNum || null, inv_id: po.invId || null,
      date: po.date, del: po.del || null, cur: po.cur, payment_terms: po.paymentTerms || null,
      line_items: po.lineItems || [], dep: po.dep, fpm_funded: po.fpmFunded, fpm_recovered: po.fpmRecovered,
      oth: po.oth, notes: po.notes || null, status: po.status, upd_at: po.updAt
    };
    var poResult;
    if (EI.p) {
      poResult = await _sb.from('purchase_orders').update(poRow).eq('id', EI.p).select().single();
    } else {
      poResult = await _sb.from('purchase_orders').insert(poRow).select().single();
    }
    if (poResult.error) { toast('Save failed: ' + poResult.error.message); return; }
    po.id = poResult.data.id;
    await refreshPOFromSupabase();
  } else {
    if(EI.p){var i=DB.po.findIndex(function(x){return x.id===EI.p;});if(i>-1)DB.po[i]=po;}else DB.po.push(po);
    sv(K.p,DB.po);
  }

  closeM('ov-po'); rPO(); rDash(); audit(EI.p?'UPDATE':'CREATE','po',po.id,po);
  if (!EI.p) { logEv('po', po.id, 'created', 'PO ' + po.num + ' created', 'operator'); }
  else if (_poOldStatus !== null && _poOldStatus !== po.status) { logEv('po', po.id, 'status_changed', 'Status: ' + _poOldStatus + ' → ' + po.status, 'operator'); }
  toast('PO saved'); await syncEnt('po',po).catch(function(){});
}
```

`poRow` never includes an `id` key, so a create always lets Postgres assign a fresh UUID regardless of the client-generated `uid()` placeholder `po.id` was constructed with. No dependent side effect reads `po.id` after this point in `savePO()` today (unlike `saveQte()`'s Contact/Order-Request conversion side effects) — confirmed by inspection of the full function body; `savePO()` is already `async` (for `syncEnt()`), so no signature change, and per `REQ-CLOUD-005` §1.3, no caller anywhere reads its return value.

### 2.4 `delPO()` — cloud-aware soft-delete branch, plus the `PO-GAP-007` fix (`index.html:8066-8079`)

Current:

```js
async function delPO(id) {
  if(!confirm('Delete?')) return;
  var _poRec = DB.po.find(function(p){return p.id===id;});
  var _poNum = (_poRec||{}).num||id;
  DB.po=DB.po.filter(function(p){return p.id!==id;});
  var _posChanged = false;
  DB.inv.forEach(function(i){
    if (i.pos && i.pos.length) {
      var idx = i.pos.indexOf(id);
      if (idx > -1) { i.pos.splice(idx,1); _posChanged = true; }
    }
  });
  if (_poRec) logEv('po', _poRec.id, 'deleted', 'PO ' + _poNum + ' deleted', 'operator');
  sv(K.p,DB.po); if (_posChanged) sv(K.i,DB.inv); rPO(); rDash(); toast('Deleted'); await delEnt('po',_poNum).catch(function(){});
}
```

New:

```js
async function delPO(id) {
  if(!confirm('Delete?')) return;
  var _poRec = DB.po.find(function(p){return p.id===id;});
  var _poNum = (_poRec||{}).num||id;

  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('purchase_orders').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshPOFromSupabase();
  } else {
    DB.po=DB.po.filter(function(p){return p.id!==id;});
    sv(K.p,DB.po);
  }

  var _posChanged = false;
  DB.inv.forEach(function(i){
    if (i.pos && i.pos.length) {
      var idx = i.pos.indexOf(id);
      if (idx > -1) { i.pos.splice(idx,1); _posChanged = true; }
    }
  });
  if (_posChanged) sv(K.i,DB.inv);

  // PO-GAP-007 fix (REQ-CLOUD-005f): delPO() never cleaned a deleted PO's id out of the
  // source Quote's linkedPOIds[] — ships unconditionally here, independent of whether
  // Purchase Order itself has migrated, since the underlying bug (a plain array never
  // cleaned up) exists regardless of Cloud Data state.
  var touchedQteIdsForPoDel = {};
  DB.qt.forEach(function(q){
    if (q.linkedPOIds && q.linkedPOIds.indexOf(id) > -1) {
      q.linkedPOIds = q.linkedPOIds.filter(function(pid){ return pid !== id; });
      touchedQteIdsForPoDel[q.id] = true;
    }
  });
  if (Object.keys(touchedQteIdsForPoDel).length) {
    sv(K.qt, DB.qt);
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForPoDel[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }

  if (_poRec) logEv('po', _poRec.id, 'deleted', 'PO ' + _poNum + ' deleted', 'operator');
  rPO(); rDash(); toast('Deleted'); await delEnt('po',_poNum).catch(function(){});
}
```

`_poRec`/`_poNum` are captured before either branch, since `logEv()` at the tail and the `delEnt()` Sheets-delete call both still need them — unchanged from today. The `PO-GAP-007` fix runs unconditionally (matching `REQ-CLOUD-005f`'s resolved disposition: this is a delete-time cleanup bug independent of whether Purchase Order has migrated, not a migration-gated behavior), and pushes the touched Quote via `persistQteChange(q, true)` only if Quote has itself migrated — `persistQteChange()`'s own local-branch fallback (`sv(K.qt, DB.qt)`) handles the non-migrated case correctly with no extra code here.

### 2.5 `autoPos()` — cloud-aware multi-PO creation branch (`index.html:7025-7043`)

Current:

```js
function autoPos(inv) {
  var sm = {};
  (inv.lineItems||[]).forEach(function(li){
    var r=DB.li.find(function(x){return x.id===li.lid;});
    if(r&&r.supId){ if(!sm[r.supId]) sm[r.supId]=[]; sm[r.supId].push({rid:uid(),lid:li.lid,desc:li.desc,sku:r.sku||'',uom:r.uom||li.uom,qty:li.qty,cost:r.cost||0,sourceInvUp:+li.up||0}); }
  });
  var cnt=Object.keys(sm).length; if(!cnt) return;
  var idx=0;
  Object.entries(sm).forEach(function(entry){
    var supId=entry[0], lis=entry[1];
    var po={id:uid(),num:'PO-'+(inv.num||Date.now().toString(36))+'-'+(idx+1),supId:supId,invId:inv.id,invNum:inv.num,date:inv.date||today(),del:'',cur:'USD',lineItems:lis,dep:0,oth:0,notes:'',status:'Draft',creAt:new Date().toISOString()};
    DB.po.push(po);
    var ii=DB.inv.findIndex(function(x){return x.id===inv.id;});
    if(ii>-1){DB.inv[ii].pos=DB.inv[ii].pos||[];DB.inv[ii].pos.push(po.id);}
    idx++;
  });
  sv(K.p,DB.po); sv(K.i,DB.inv); rPO();
  toast(cnt+' PO'+(cnt!==1?'s':'')+' auto-generated');
}
```

New:

```js
async function autoPos(inv) {
  var sm = {};
  (inv.lineItems||[]).forEach(function(li){
    var r=DB.li.find(function(x){return x.id===li.lid;});
    if(r&&r.supId){ if(!sm[r.supId]) sm[r.supId]=[]; sm[r.supId].push({rid:uid(),lid:li.lid,desc:li.desc,sku:r.sku||'',uom:r.uom||li.uom,qty:li.qty,cost:r.cost||0,sourceInvUp:+li.up||0}); }
  });
  var cnt=Object.keys(sm).length; if(!cnt) return;
  var idx=0;
  var newPos = [];
  Object.entries(sm).forEach(function(entry){
    var supId=entry[0], lis=entry[1];
    var po={id:uid(),num:'PO-'+(inv.num||Date.now().toString(36))+'-'+(idx+1),supId:supId,invId:inv.id,invNum:inv.num,date:inv.date||today(),del:'',cur:'USD',lineItems:lis,dep:0,oth:0,notes:'',status:'Draft',creAt:new Date().toISOString()};
    newPos.push(po);
    idx++;
  });

  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) { return; }
    for (var i = 0; i < newPos.length; i++) {
      var poRow = {
        num: newPos[i].num, sup_id: newPos[i].supId, inv_num: newPos[i].invNum, inv_id: newPos[i].invId,
        date: newPos[i].date, del: newPos[i].del || null, cur: newPos[i].cur, line_items: newPos[i].lineItems,
        dep: newPos[i].dep, oth: newPos[i].oth, notes: newPos[i].notes || null, status: newPos[i].status,
        cre_at: newPos[i].creAt
      };
      var result = await _sb.from('purchase_orders').insert(poRow).select().single();
      if (result.error) { toast('Auto-generated PO failed to save to Cloud Data: ' + result.error.message); return; }
      newPos[i].id = result.data.id;
    }
    await refreshPOFromSupabase();
  } else {
    newPos.forEach(function(po){ DB.po.push(po); });
    sv(K.p,DB.po);
  }

  var ii=DB.inv.findIndex(function(x){return x.id===inv.id;});
  if(ii>-1){
    DB.inv[ii].pos=DB.inv[ii].pos||[];
    newPos.forEach(function(po){ DB.inv[ii].pos.push(po.id); });
  }
  sv(K.i,DB.inv); rPO();
  toast(cnt+' PO'+(cnt!==1?'s':'')+' auto-generated');
}
```

Every generated PO's real Supabase id is assigned onto `newPos[i].id` before `Invoice.pos[]` is built — the same "assign every real id before the dependent write" ordering `REQ-CLOUD-005g` requires, applied here to `autoPos()` specifically. `autoPos()` becomes `async`; its only caller, `saveInv()`'s `if(!EI.i) autoPos(inv);` (`index.html:6920`), is a bare, unawaited statement already inside an `async` function and does not use `autoPos()`'s return value — confirm at implementation time that no test-suite call site does either.

### 2.6 Pre-flight duplicate-`num` scan — new `findDuplicatePONums()`/`showPoDupConflictModal()`, new modal (§0.2)

Insert `findDuplicatePONums()` immediately after `findDuplicateQuoteNums()` closes (`index.html:5736`); insert `showPoDupConflictModal()` immediately after `showQteDupConflictModal()` closes (`index.html:5743`).

```js
function findDuplicatePONums(po) {
  var groups = {};
  po.forEach(function(p){
    var key = p.num || '';
    if (!key) return;
    (groups[key] = groups[key] || []).push(p);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){ return g.length > 1; });
}

function showPoDupConflictModal(dupes) {
  G('po-dup-list').innerHTML = '<p style="margin-bottom:10px;">Migration blocked: the following Purchase Order numbers are duplicated (exact match) and would violate the cloud database\'s unique-number constraint. Rename one of each pair before migrating.</p><ul style="padding-left:18px;">' +
    dupes.map(function(g){ return '<li>' + g.map(function(p){ return san(p.num); }).join(' &nbsp;/&nbsp; '); }).join('</li>') + '</li></ul>';
  G('ov-po-dup').classList.add('on');
}
```

Case-sensitive exact match, mirroring `findDuplicateQuoteNums()` — `savePO()`/`vPO()` apply no case-normalization to `num` anywhere (`REQ-CLOUD-005c`).

New modal HTML, inserted immediately after the existing `ov-qt-dup` modal closes (`index.html:2703`):

```html
<div class="ov" id="ov-po-dup" onclick="if(event.target===this)closeM('ov-po-dup')">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Migration Blocked — Duplicate Purchase Order Numbers</h2><button class="mx" onclick="closeM('ov-po-dup')">&#215;</button></div>
    <div class="mb">
      <div id="po-dup-list" style="font-size:.55rem;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-g" onclick="closeM('ov-po-dup')">Close</button>
      </div>
    </div>
  </div>
</div>
```

Structurally identical to `ov-qt-dup` — a new, dedicated modal rather than modifying either existing one (per `REQ-CLOUD-005` §3, generalizing the pattern is out of scope here).

### 2.7 `migratePOToSupabase()` — new function

Insert immediately after `migrateQteToSupabase()` closes (`index.html:6142`).

```js
async function migratePOToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-005b: Supplier must have completed its own migration first, checked
  // against the live, connected project — mirrors migrateLineItemsToSupabase()'s
  // precondition, since every Purchase Order's supId is expected to resolve to a
  // real Supplier (though qteToPoConvert() can leave it blank — see the orphan
  // check immediately below, which treats a blank supId as unresolvable too).
  if (!(await isSupplierMigrationComplete())) { toast('Migrate Suppliers to Cloud Data first — every Purchase Order requires a Supplier link.'); return; }

  var knownSupIds = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (knownSupIds.error) { toast('Could not verify Supplier links before migrating: ' + knownSupIds.error.message); return; }
  var knownSupIdSet = {};
  knownSupIds.data.forEach(function(s){ knownSupIdSet[s.id] = true; });
  var orphanPO = DB.po.find(function(p){ return !knownSupIdSet[p.supId]; });
  if (orphanPO) { toast('Migration blocked: Purchase Order ' + (orphanPO.num||orphanPO.id) + ' references a Supplier not found in Cloud Data (or has none at all). Fix or reassign its Supplier link before migrating.'); return; }

  // REQ-CLOUD-005c: unlike Order Request's ORD-#### (machine-generated only), Purchase
  // Order's num is manually editable via the PO Number field with no case-normalization
  // anywhere — a real pre-flight duplicate scan is required, not a documented no-op.
  var poDupes = findDuplicatePONums(DB.po);
  if (poDupes.length) { showPoDupConflictModal(poDupes); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var poIdMap = {};
  for (var i = 0; i < DB.po.length; i++) {
    var p = DB.po[i];
    var result = await _sb.from('purchase_orders').insert({
      num: p.num, sup_id: p.supId || null, inv_num: p.invNum || null, inv_id: p.invId || null,
      date: p.date, del: p.del || null, cur: p.cur, payment_terms: p.paymentTerms || null,
      line_items: p.lineItems || [], dep: p.dep, fpm_funded: p.fpmFunded, fpm_recovered: !!p.fpmRecovered,
      oth: p.oth, notes: p.notes || null, status: p.status,
      upd_at: p.updAt != null ? p.updAt : null, cre_at: p.creAt != null ? p.creAt : null,
      quote_id: p.quoteId != null ? p.quoteId : null, quote_num: p.quoteNum != null ? p.quoteNum : null
    }).select().single();
    if (result.error) { toast('Migration failed on Purchase Order ' + (p.num||p.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    poIdMap[p.id] = result.data.id;
  }

  // REQ-CLOUD-005h: outward sweep — Quote.linkedPOIds[] is an array, not a scalar;
  // rewrite each matching element in place via the id-map, never via any other field
  // as the join key. Invoice.pos[] gets the same array-element treatment but stays a
  // plain local fix — Invoice is not Cloud-eligible. DB.supPayments[].poId likewise
  // stays local-only; .poNum is an immutable historical snapshot, confirmed unused for
  // lookup anywhere, and is left untouched.
  var touchedQteIdsForPo = {};
  DB.qt.forEach(function(q){
    if (q.linkedPOIds && q.linkedPOIds.length) {
      var newIds = q.linkedPOIds.map(function(pid){ return poIdMap[pid] || pid; });
      if (JSON.stringify(newIds) !== JSON.stringify(q.linkedPOIds)) { q.linkedPOIds = newIds; touchedQteIdsForPo[q.id] = true; }
    }
  });
  sv(K.qt, DB.qt);

  DB.inv.forEach(function(inv){
    if (inv.pos && inv.pos.length) { inv.pos = inv.pos.map(function(pid){ return poIdMap[pid] || pid; }); }
  });
  sv(K.i, DB.inv);

  DB.supPayments.forEach(function(pm){ if (poIdMap[pm.poId]) pm.poId = poIdMap[pm.poId]; });
  sv(K.spm, DB.supPayments);

  // Outward cross-phase retrofit (REQ-CLOUD-005i): the mirror image of
  // migrateQteToSupabase()'s own outward retrofit onto Order Request in
  // SPEC-CLOUD-004. Quote already has a Supabase table (REQ-CLOUD-004) and
  // refreshQteFromSupabase() fires from many call sites once Quote has migrated — a
  // purely-local linkedPOIds[] fix left in place past this point would be silently
  // reverted by whichever fires first. Pushed here, synchronously, before this
  // function returns.
  if (Object.keys(touchedQteIdsForPo).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForPo[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }

  // Archive the true pre-migration snapshot BEFORE remapping DB.po's own ids below.
  localStorage.setItem('st_po_pre_migration', localStorage.getItem(K.p));
  localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());

  DB.po.forEach(function(p){ if (poIdMap[p.id]) p.id = poIdMap[p.id]; });
  sv(K.p, DB.po);

  await refreshPOFromSupabase();
  if (G('cfg-sb-po-restore-btn')) G('cfg-sb-po-restore-btn').style.display = '';
  toast('Purchase Order migration complete. Pre-migration data archived for 30 days.');
}
```

The `orphanPO` pre-flight check treats a blank `supId` (possible via `qteToPoConvert()`, per `REQ-CLOUD-005` §1.1e/§2a) as unresolvable — `knownSupIdSet['']` is never `true`, so this falls out of the existing lookup with no special-case code needed.

### 2.8 Archive/rollback extensions

`restorePOMigrationArchive()` — new, inserted after `restoreQteMigrationArchive()` closes (`index.html:6201`).

```js
function restorePOMigrationArchive() {
  var arch = localStorage.getItem('st_po_pre_migration');
  if (!arch) { toast('No Purchase Order migration archive available to restore.'); return; }
  if (!confirm('Restore Purchase Orders to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, Quotes, or any other document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Purchase Orders — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.p, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_po_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

`cleanupExpiredMigrationArchive()` (`index.html:6205-6232`) — extend with a sixth independently-timed block, inserted immediately after the existing Quote block (`index.html:6227-6231`) closes, before the function's own closing `}`:

```js
  var poTs = localStorage.getItem('st_po_cloud_migration_ts');
  if (poTs && (Date.now() - new Date(poTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_po_pre_migration');
    localStorage.removeItem('st_po_cloud_migration_ts');
  }
```

`rCfg()` (`index.html:10614-10615`, the five existing `cfg-sb-*-restore-btn` visibility lines) — add a sixth restore-button visibility line, immediately after the Quote one (`index.html:10614`), before the `cfg-lang` line that follows it:

```js
  if(G('cfg-sb-po-restore-btn')) G('cfg-sb-po-restore-btn').style.display = localStorage.getItem('st_po_cloud_migration_ts') ? '' : 'none';
```

### 2.9 Retrofit `migrateSuppliersBuyersToSupabase()` — add Purchase Order touched-tracking and cross-phase push

Current sweep (`index.html:5811-5842`):

```js
  // REQ-CLOUD-001i: rewrite every existing local reference field
  var touchedQteIdsForSup = {};
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (supIdMap[l.supId]) { l.supId = supIdMap[l.supId]; touchedQteIdsForSup[q.id] = true; } }); });
  DB.po.forEach(function(p){ if (supIdMap[p.supId]) p.supId = supIdMap[p.supId]; });
  DB.li.forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; });
  DB.con.forEach(function(c){ if (c.supplierId && supIdMap[c.supplierId]) c.supplierId = supIdMap[c.supplierId]; });
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) inv.buyerId = buyIdMap[inv.buyerId]; });
  // REQ-CLOUD-003e: RFQ Response supId was previously missing from this sweep entirely —
  // a confirmed, currently-live bug (REQ-CLOUD-003 §1.3). Track which Order Requests
  // actually changed so the push-if-already-migrated step below only touches those.
  var touchedOrdIdsForSup = {};
  DB.ord.forEach(function(o){
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (supIdMap[r.supId]) { r.supId = supIdMap[r.supId]; touchedOrdIdsForSup[o.id] = true; } });
    });
  });
  sv(K.qt, DB.qt); sv(K.p, DB.po); sv(K.l, DB.li); sv(K.co, DB.con); sv(K.i, DB.inv); sv(K.ord, DB.ord);

  // Cross-phase fix: if Order Request has ITSELF already migrated to Supabase, the
  // sv(K.ord, DB.ord) above only fixes the local mirror — push each touched record to
  // the cloud-hosted row too, or the next refreshOrdFromSupabase() silently reverts it.
  if (Object.keys(touchedOrdIdsForSup).length) {
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (touchedOrdIdsForSup[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }

  // REQ-CLOUD-004e: same cross-phase fix, for Quote — the sv(K.qt, DB.qt) above only
  // fixes the local mirror if Quote has already migrated to Supabase.
  if (Object.keys(touchedQteIdsForSup).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForSup[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }
```

New — one changed line, one new tracking map, one new push block:

```js
  // REQ-CLOUD-001i: rewrite every existing local reference field
  var touchedQteIdsForSup = {};
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (supIdMap[l.supId]) { l.supId = supIdMap[l.supId]; touchedQteIdsForSup[q.id] = true; } }); });
  var touchedPoIdsForSup = {};
  DB.po.forEach(function(p){ if (supIdMap[p.supId]) { p.supId = supIdMap[p.supId]; touchedPoIdsForSup[p.id] = true; } });
  DB.li.forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; });
  DB.con.forEach(function(c){ if (c.supplierId && supIdMap[c.supplierId]) c.supplierId = supIdMap[c.supplierId]; });
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) inv.buyerId = buyIdMap[inv.buyerId]; });
  // REQ-CLOUD-003e: RFQ Response supId was previously missing from this sweep entirely —
  // a confirmed, currently-live bug (REQ-CLOUD-003 §1.3). Track which Order Requests
  // actually changed so the push-if-already-migrated step below only touches those.
  var touchedOrdIdsForSup = {};
  DB.ord.forEach(function(o){
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (supIdMap[r.supId]) { r.supId = supIdMap[r.supId]; touchedOrdIdsForSup[o.id] = true; } });
    });
  });
  sv(K.qt, DB.qt); sv(K.p, DB.po); sv(K.l, DB.li); sv(K.co, DB.con); sv(K.i, DB.inv); sv(K.ord, DB.ord);

  // Cross-phase fix: if Order Request has ITSELF already migrated to Supabase, the
  // sv(K.ord, DB.ord) above only fixes the local mirror — push each touched record to
  // the cloud-hosted row too, or the next refreshOrdFromSupabase() silently reverts it.
  if (Object.keys(touchedOrdIdsForSup).length) {
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (touchedOrdIdsForSup[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }

  // REQ-CLOUD-004e: same cross-phase fix, for Quote — the sv(K.qt, DB.qt) above only
  // fixes the local mirror if Quote has already migrated to Supabase.
  if (Object.keys(touchedQteIdsForSup).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForSup[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }

  // REQ-CLOUD-005i: same cross-phase fix, for Purchase Order.
  if (Object.keys(touchedPoIdsForSup).length) {
    for (var pi = 0; pi < DB.po.length; pi++) {
      if (touchedPoIdsForSup[DB.po[pi].id]) await persistPOChange(DB.po[pi], true);
    }
    await refreshPOFromSupabase();
  }
```

### 2.10 Retrofit `migrateLineItemsToSupabase()` — add Purchase Order touched-tracking and cross-phase push

Current sweep (`index.html:5896-5904`):

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  DB.po.forEach(function(po){ (po.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  // Quote.lines[].lid is confirmed dead (never populated by any code path) —
  // checked anyway, never skipped, per index.html's own stated convention there.
  var touchedQteIdsForLi = {};
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(ql){ if (liIdMap[ql.lid]) { ql.lid = liIdMap[ql.lid]; touchedQteIdsForLi[q.id] = true; } }); });
  sv(K.i, DB.inv); sv(K.p, DB.po); sv(K.qt, DB.qt);

  // REQ-CLOUD-004e: cross-phase fix for Quote, same reasoning as the Supplier/Buyer
  // retrofit — the touched-set will always be empty in practice today (lid is a
  // confirmed-dead field), but this loop is safe to run unconditionally regardless.
  if (Object.keys(touchedQteIdsForLi).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForLi[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }
```

New:

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  // Purchase Order.lineItems[].lid is a genuinely live field (REQ-CLOUD-005 §1.6,
  // §1.1e) — autoPos() populates it directly from the source Line Item's real id, and
  // verifyFkIntegrityAfterCleanup()/delLI()'s dangling-reference warning both already
  // depend on it. Unlike Quote's equivalent field, this touched-set will not generally
  // be empty in practice.
  var touchedPoIdsForLi = {};
  DB.po.forEach(function(po){ (po.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) { li.lid = liIdMap[li.lid]; touchedPoIdsForLi[po.id] = true; } }); });
  // Quote.lines[].lid is confirmed dead (never populated by any code path) —
  // checked anyway, never skipped, per index.html's own stated convention there.
  var touchedQteIdsForLi = {};
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(ql){ if (liIdMap[ql.lid]) { ql.lid = liIdMap[ql.lid]; touchedQteIdsForLi[q.id] = true; } }); });
  sv(K.i, DB.inv); sv(K.p, DB.po); sv(K.qt, DB.qt);

  // REQ-CLOUD-004e: cross-phase fix for Quote, same reasoning as the Supplier/Buyer
  // retrofit — the touched-set will always be empty in practice today (lid is a
  // confirmed-dead field), but this loop is safe to run unconditionally regardless.
  if (Object.keys(touchedQteIdsForLi).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForLi[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }

  // REQ-CLOUD-005i: same cross-phase fix, for Purchase Order — this touched-set is
  // expected to be non-empty in real usage, unlike Quote's.
  if (Object.keys(touchedPoIdsForLi).length) {
    for (var pi = 0; pi < DB.po.length; pi++) {
      if (touchedPoIdsForLi[DB.po[pi].id]) await persistPOChange(DB.po[pi], true);
    }
    await refreshPOFromSupabase();
  }
```

### 2.11 Retrofit `migrateQteToSupabase()` — add Purchase Order touched-tracking and cross-phase push

Current sweep (`index.html:6099-6103`):

```js
  // REQ-CLOUD-004d: outward sweep — every OTHER entity's field that references Quote.id,
  // matched directly against the id-map, never through Quote.linkedPOIds[] (which can
  // already contain a dangling id per PO-GAP-007 — matching linkedPOIds[] itself would
  // not be robust to that; matching PO/Order-Request/Invoice's own fields directly is).
  DB.po.forEach(function(p){ if (qteIdMap[p.quoteId]) p.quoteId = qteIdMap[p.quoteId]; });
  DB.inv.forEach(function(inv){ if (qteIdMap[inv.linkedQuoteId]) inv.linkedQuoteId = qteIdMap[inv.linkedQuoteId]; });
  sv(K.p, DB.po); sv(K.i, DB.inv);
```

New — plus the outward cross-phase retrofit comment update this REQ's own §0 scoping named:

```js
  // REQ-CLOUD-004d: outward sweep — every OTHER entity's field that references Quote.id,
  // matched directly against the id-map, never through Quote.linkedPOIds[] (which can
  // already contain a dangling id per PO-GAP-007 — matching linkedPOIds[] itself would
  // not be robust to that; matching PO/Order-Request/Invoice's own fields directly is).
  var touchedPoIdsForQte = {};
  DB.po.forEach(function(p){ if (qteIdMap[p.quoteId]) { p.quoteId = qteIdMap[p.quoteId]; touchedPoIdsForQte[p.id] = true; } });
  DB.inv.forEach(function(inv){ if (qteIdMap[inv.linkedQuoteId]) inv.linkedQuoteId = qteIdMap[inv.linkedQuoteId]; });
  sv(K.p, DB.po); sv(K.i, DB.inv);

  // REQ-CLOUD-005i: cross-phase fix for Purchase Order — REQ-CLOUD-004 shipped this
  // sweep as a plain local fix because Purchase Order had no Supabase table at the
  // time ("PurchaseOrder.quoteId/Invoice.linkedQuoteId ... are safe as plain local
  // fixes — neither entity has a Supabase table," SPEC-CLOUD-004 §2.7). That is now
  // half false: Invoice still isn't Cloud-eligible, but Purchase Order is.
  if (Object.keys(touchedPoIdsForQte).length) {
    for (var pi = 0; pi < DB.po.length; pi++) {
      if (touchedPoIdsForQte[DB.po[pi].id]) await persistPOChange(DB.po[pi], true);
    }
    await refreshPOFromSupabase();
  }
```

The outward-cross-phase-retrofit comment a few lines below this sweep (`index.html:6109-6115`, beginning "Outward cross-phase retrofit (REQ-CLOUD-004e): PurchaseOrder.quoteId/Invoice.linkedQuoteId above are safe as plain local fixes — neither entity has a Supabase table.") is updated to drop the now-inaccurate claim about Purchase Order:

Current:
```
  // Outward cross-phase retrofit (REQ-CLOUD-004e): PurchaseOrder.quoteId/Invoice.linkedQuoteId
  // above are safe as plain local fixes — neither entity has a Supabase table. Order
```

New:
```
  // Outward cross-phase retrofit (REQ-CLOUD-004e): Invoice.linkedQuoteId above is safe
  // as a plain local fix — it has no Supabase table. PurchaseOrder.quoteId no longer
  // is (see the REQ-CLOUD-005i retrofit just above this sweep). Order
```

(The remainder of that comment, about Order Request's own retrofit, is unchanged — only the opening clause naming Purchase Order is corrected.)

### 2.12 `pullAll()` — exclude `'po'` once migrated

Current (`index.html:4536-4554`):

```js
  // ── Purchase orders (field-mapping reversed, business-key merge) ─
  try {
    var dPo = await pulled('po');
    if (dPo.status === 'ok' && dPo.records && dPo.records.length) {
      var poPulled = dPo.records.map(function(r){ return unmapRec('po', r); });
      var poClaim = claimOnceMatcher();
      var mergedPo = poPulled.map(function(p) {
        var candidate = findLocalMatchByBizKey('po', DB.po, p);
        var local = poClaim(candidate);
        var m = mergePulledWithLocal(p, local);
        if (!local) m.id = uid();
        return m;
      });
      var poMergedNums = {};
      mergedPo.forEach(function(m){ if (m.num) poMergedNums[m.num] = true; });
      var poLocalOnly = DB.po.filter(function(r){ return !poMergedNums[r.num]; });
      DB.po = mergedPo.concat(poLocalOnly);
    }
  } catch(e) { failed.push('po'); console.warn('[Stackd] pullAll: po failed —', e.message); }
```

New — one guard added, matching the shape of this block's own existing per-entity `try` structure rather than a `simpleEnts`-style array filter:

```js
  // ── Purchase orders (field-mapping reversed, business-key merge) ─
  // REQ-CLOUD-005j: once migrated, Purchase Order is cloud-authoritative — pulling it
  // from Sheets here would race the fire-and-forget Supabase refresh, with whichever
  // resolves last silently overwriting DB.po/localStorage. Excluded entirely once its
  // own local completion marker is set, mirroring the reasoning behind Supplier's
  // bare-_sb exclusion just below this block, but gated on PO's own marker rather than
  // bare _sb truthiness, since Purchase Order (unlike Supplier) migrates independently.
  if (!(_sb && localStorage.getItem('st_po_cloud_migration_ts'))) {
  try {
    var dPo = await pulled('po');
    if (dPo.status === 'ok' && dPo.records && dPo.records.length) {
      var poPulled = dPo.records.map(function(r){ return unmapRec('po', r); });
      var poClaim = claimOnceMatcher();
      var mergedPo = poPulled.map(function(p) {
        var candidate = findLocalMatchByBizKey('po', DB.po, p);
        var local = poClaim(candidate);
        var m = mergePulledWithLocal(p, local);
        if (!local) m.id = uid();
        return m;
      });
      var poMergedNums = {};
      mergedPo.forEach(function(m){ if (m.num) poMergedNums[m.num] = true; });
      var poLocalOnly = DB.po.filter(function(r){ return !poMergedNums[r.num]; });
      DB.po = mergedPo.concat(poLocalOnly);
    }
  } catch(e) { failed.push('po'); console.warn('[Stackd] pullAll: po failed —', e.message); }
  }
```

No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

### 2.13 The two FPM-funded-deposit auto-recovery sites — route through `persistPOChange()`

**Site 1 — `saveInv()`** (`index.html:6923-6929`):

Current:

```js
  if (inv.status === 'Paid') {
    var recovered = false;
    getInvoicePOs(inv).forEach(function(po) {
      if (po.fpmFunded > 0 && !po.fpmRecovered) {
        po.fpmRecovered = true;
        po.updAt = new Date().toISOString();
        recovered = true;
        syncEnt('po', po).catch(function(){});
      }
    });
    if (recovered) {
      sv(K.p, DB.po);
      toast('FPM-funded deposits marked as recovered ✓');
    }
```

New:

```js
  if (inv.status === 'Paid') {
    var recovered = false;
    var _touchedPoIdsForFpm1 = [];
    getInvoicePOs(inv).forEach(function(po) {
      if (po.fpmFunded > 0 && !po.fpmRecovered) {
        po.fpmRecovered = true;
        po.updAt = new Date().toISOString();
        recovered = true;
        _touchedPoIdsForFpm1.push(po.id);
        syncEnt('po', po).catch(function(){});
      }
    });
    if (recovered) {
      if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
        for (var fi1 = 0; fi1 < _touchedPoIdsForFpm1.length; fi1++) {
          var _fpmPo1 = DB.po.find(function(x){ return x.id === _touchedPoIdsForFpm1[fi1]; });
          if (_fpmPo1) await persistPOChange(_fpmPo1, true);
        }
        await refreshPOFromSupabase();
      } else {
        sv(K.p, DB.po);
      }
      toast('FPM-funded deposits marked as recovered ✓');
    }
```

**Site 2 — `savePayment()`** (`index.html:12708-12722`):

Current:

```js
    if (inv.status === 'Paid' && prevStatus !== 'Paid') {
      var recovered = false;
      getInvoicePOs(inv).forEach(function(po) {
        if (+po.fpmFunded > 0 && !po.fpmRecovered) {
          po.fpmRecovered = true;
          po.updAt = new Date().toISOString();
          recovered = true;
          syncEnt('po', po).catch(function(){});
        }
      });
      sv(K.p, DB.po);
```

New:

```js
    if (inv.status === 'Paid' && prevStatus !== 'Paid') {
      var recovered = false;
      var _touchedPoIdsForFpm2 = [];
      getInvoicePOs(inv).forEach(function(po) {
        if (+po.fpmFunded > 0 && !po.fpmRecovered) {
          po.fpmRecovered = true;
          po.updAt = new Date().toISOString();
          recovered = true;
          _touchedPoIdsForFpm2.push(po.id);
          syncEnt('po', po).catch(function(){});
        }
      });
      if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) {
        for (var fi2 = 0; fi2 < _touchedPoIdsForFpm2.length; fi2++) {
          var _fpmPo2 = DB.po.find(function(x){ return x.id === _touchedPoIdsForFpm2[fi2]; });
          if (_fpmPo2) await persistPOChange(_fpmPo2, true);
        }
        await refreshPOFromSupabase();
      } else {
        sv(K.p, DB.po);
      }
```

Both sites need `savePayment()`/`saveInv()`'s surrounding function to already be (or become) `async` for the new `await persistPOChange(...)` calls — `saveInv()` is already `async`; confirm `savePayment()`'s own async status and every direct test-suite call site at implementation time (`REQ-CLOUD-005` AC-13).

### 2.14 Settings UI (`index.html:806-810`, inside the Cloud Data card group)

New card inserted immediately after the existing "Cloud Data (Quotes)" card:

```html
<div class="card">
  <div class="ct">Cloud Data (Purchase Orders)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="migratePOToSupabase()">Migrate Purchase Orders to Cloud</button>
    <button class="btn btn-g" id="cfg-sb-po-restore-btn" style="display:none;" onclick="restorePOMigrationArchive()">Restore Pre-Migration Purchase Orders</button>
  </div>
  <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Suppliers to already be migrated to Cloud Data above (every Purchase Order requires a Supplier link). Uses the same Supabase connection configured above.</p>
</div>
```

### 2.15 `AI_SYSTEM_PROMPT` and `docs/user-guide.md` — Cloud Data description updated

Current (`index.html:9807`):

```
'Cloud Data (REQ/SPEC-CLOUD-001/002/003/004): Settings → Cloud Data lets an operator connect a shared Supabase database. Each of Supplier/Buyer, Line Item, Contact, Order Request, and Quote migrates independently, on its own schedule, via its own "Migrate ... to Cloud" button — a colleague on a different device/browser only sees the shared copy of an entity once that entity has actually been migrated, gated by a separate Supabase sign-in (distinct from the app password). Purchase Order is not yet Cloud-Data-eligible — it, and every other entity, stays local-only regardless of what has migrated. Each migration requires a full backup export first (mandatory, blocking) and archives that entity\'s pre-migration data locally for 30 days as a rollback safety net. The "Ad-Hoc" default Buyer never migrates and always stays local. Order Request\'s and Quote\'s lines migrate embedded with their parent record — no separate migration or precondition for them, and each can migrate independently of whether Supplier, Contact, or the other has. If nothing is configured, nothing changes — every entity behaves exactly as before Cloud Data existed.',
```

New:

```
'Cloud Data (REQ/SPEC-CLOUD-001/002/003/004/005): Settings → Cloud Data lets an operator connect a shared Supabase database. Each of Supplier/Buyer, Line Item, Contact, Order Request, Quote, and Purchase Order migrates independently, on its own schedule, via its own "Migrate ... to Cloud" button — a colleague on a different device/browser only sees the shared copy of an entity once that entity has actually been migrated, gated by a separate Supabase sign-in (distinct from the app password). Every deal-pipeline and master-data entity is now Cloud-Data-eligible; only Invoice, Credit Note, Shipment, and the Payment ledgers remain local-only, regardless of what has migrated. Each migration requires a full backup export first (mandatory, blocking) and archives that entity\'s pre-migration data locally for 30 days as a rollback safety net. The "Ad-Hoc" default Buyer never migrates and always stays local. Order Request\'s and Quote\'s lines migrate embedded with their parent record — no separate migration or precondition for them; Purchase Order requires Suppliers to have migrated first (every Purchase Order requires a Supplier link). Each entity can migrate independently of the others except where a precondition is stated. If nothing is configured, nothing changes — every entity behaves exactly as before Cloud Data existed.',
```

`docs/user-guide.md`'s Cloud Data section (rewritten most recently in `REQ-CLOUD-004`) gets the identical update — Purchase Order added to the list of independently-migratable entities, with its Supplier precondition named, and Invoice/Credit Note/Shipment/Payment-ledgers named as the entities remaining non-eligible.

### 2.16 No changes needed

Confirmed by `REQ-CLOUD-005` §1.4/§3: `delSup()` (already confirmed warn-and-allow, leaves `PO.supId` dangling by design, unaffected), `delCon()` (no Contact field on Purchase Order to dangle), `migrateQtePoShape()`/`backfillInvoicePOs()` (both confirmed structurally unable to affect or be affected by a cloud-hosted record), `executeDataCleanup()`'s renumbering pairs list and phantom filter (Purchase Order's `num` confirmed absent from the renumbering list, same as Invoice/Quote/Credit-Note; phantom filter is a structural no-op for migrated data, identical reasoning to every prior REQ in this series), `migrateContactsToSupabase()`/`migrateOrdToSupabase()` (independently confirmed, twice, to contain zero `DB.po` references), the CSV-import branches in `processImport()`/`processImportRecords()` (both logged under `CLOUD-GAP-003`, not fixed — see `docs/known-gaps.md` update at ship time), and `PO-GAP-006` (pre-existing, unrelated to this migration). No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`).

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness unchanged (already fully generic per-table).

### 3.0 Required companion retrofit of a pre-existing test (§0.1)

Before inserting any new test, retrofit the pre-existing test `'initCloudDataLayer — now also calls refreshQteFromSupabase() (mirrors the REQ-CLOUD-003 round-1 B2 lesson: wire it in from the start)'` (`tests/run.js:8305-8319`) in place — do not duplicate it. Add `purchase_orders: { selectData: [] }` to its `_sb` mock config, and stub `ctx.refreshPOFromSupabase` alongside the existing stubs, restoring it afterward:

Current:

```js
testAsync('initCloudDataLayer — now also calls refreshQteFromSupabase() (mirrors the REQ-CLOUD-003 round-1 B2 lesson: wire it in from the start)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshQte = ctx.refreshQteFromSupabase;
  ctx.refreshQteFromSupabase = function(){ called = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshQteFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshQteFromSupabase = origRefreshQte;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});
```

New:

```js
testAsync('initCloudDataLayer — now also calls refreshQteFromSupabase() (mirrors the REQ-CLOUD-003 round-1 B2 lesson: wire it in from the start)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshQte = ctx.refreshQteFromSupabase;
  ctx.refreshQteFromSupabase = function(){ called = true; return Promise.resolve(); };
  // SPEC-CLOUD-005 spec-gate self-caught (mirroring SPEC-CLOUD-004 round-1 B1):
  // initCloudDataLayer() now also calls refreshPOFromSupabase() after
  // refreshQteFromSupabase() — stub it too, or the real function runs unmocked
  // against DB.po (empty at this point) and permanently sets
  // st_po_cloud_migration_ts, corrupting every later test that touches PO.
  var origRefreshPO = ctx.refreshPOFromSupabase;
  ctx.refreshPOFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshQteFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshQteFromSupabase = origRefreshQte; ctx.refreshPOFromSupabase = origRefreshPO;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});
```

### 3.1 New test block

Insert this entire block (ending with its own dedicated cleanup test) immediately **after** the existing `'SPEC-CLOUD-004 test-hygiene cleanup'` test (`tests/run.js:8692-8696`) — the same convention `SPEC-CLOUD-004`'s own block followed relative to `SPEC-CLOUD-003`'s cleanup test.

```js
// ── CLOUD DATA — Purchase Order (SPEC-CLOUD-005) ──

testAsync('initCloudDataLayer — now also calls refreshPOFromSupabase()', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshPO = ctx.refreshPOFromSupabase;
  ctx.refreshPOFromSupabase = function(){ called = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshPOFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshPOFromSupabase = origRefreshPO;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});

testAsync('refreshPOFromSupabase — refuses to overwrite real local data when this device has never run the migration; proceeds when local data is empty (second-device case); sets its own marker on success; omits updAt/creAt/quoteId/quoteNum keys entirely when Supabase returns null for them', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  ctx.DB.po.push({ id: 'local-only-po', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx._sb = mockSb({ purchase_orders: { selectData: [] } });
  await ctx.refreshPOFromSupabase();
  assertEqual(ctx.DB.po.length, 1, 'real local Purchase Order NOT wiped — this device never ran the migration');
  assertEqual(ctx.DB.po[0].id, 'local-only-po', 'original record untouched');

  resetDB();
  ctx._sb = mockSb({ purchase_orders: { selectData: [{ id: 'cloud-po-1', num: 'PO-0001', sup_id: 's1', inv_num: '', inv_id: '', date: '2026-01-01', del: '', cur: 'USD', payment_terms: '', line_items: [], dep: 0, fpm_funded: 0, fpm_recovered: false, oth: 0, notes: '', status: 'Draft', upd_at: null, cre_at: null, quote_id: null, quote_num: null }] } });
  await ctx.refreshPOFromSupabase();
  assertEqual(ctx.DB.po.length, 1, 'real Cloud Data correctly loaded');
  assertEqual(ctx.DB.po[0].id, 'cloud-po-1', 'loaded from Supabase');
  assertEqual('updAt' in ctx.DB.po[0], false, 'updAt key omitted entirely, not set to null, when Supabase has none');
  assertEqual('creAt' in ctx.DB.po[0], false, 'creAt key omitted entirely');
  assertEqual('quoteId' in ctx.DB.po[0], false, 'quoteId key omitted entirely');
  assertEqual('quoteNum' in ctx.DB.po[0], false, 'quoteNum key omitted entirely');
  assert(!!ctx.localStorage.getItem('st_po_cloud_migration_ts'), 'marker set even though this device never ran the migration itself');
});

testAsync('migratePOToSupabase — inserts every field, preserves nested lineItems unchanged including nested ids, sweeps Quote.linkedPOIds[]/Invoice.pos[]/supPayments.poId locally and pushes the touched Quote via persistQteChange when Quote has migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.po.push({
    id: 'p1', num: 'PO-0001', supId: 's1', invNum: '', invId: '', date: '2026-01-01', del: '', cur: 'USD',
    paymentTerms: '', lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', sku: '', uom: 'pcs', qty: 1, cost: 10 }],
    dep: 0, fpmFunded: 0, fpmRecovered: false, oth: 0, notes: '', status: 'Draft', updAt: '2026-01-01T00:00:00.000Z'
  });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linkedPOIds: ['p1'] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV10001', pos: ['p1'], lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pm1', poId: 'p1', poNum: 'PO-0001', amount: 100, currency: 'USD' });
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString()); // Quote already migrated
  ctx.localStorage.setItem(ctx.K.p, JSON.stringify(ctx.DB.po)); // migratePOToSupabase() reads localStorage[K.p] for its archive step, not ctx.DB.po directly

  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1', name: 'ACME' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); } },
    quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linked_po_ids: ['new-po-uuid'] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-po-restore-btn');

  await ctx.migratePOToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(JSON.stringify(insertCall.row.line_items), JSON.stringify([{ rid: 'r1', lid: '', desc: 'Widget', sku: '', uom: 'pcs', qty: 1, cost: 10 }]), 'nested lineItems inserted unchanged');

  assertEqual(ctx.DB.qt[0].linkedPOIds[0], 'new-po-uuid', 'Quote.linkedPOIds[] element remapped to the new Purchase Order id');
  assertEqual(ctx.DB.inv[0].pos[0], 'new-po-uuid', 'Invoice.pos[] element remapped');
  assertEqual(ctx.DB.supPayments[0].poId, 'new-po-uuid', 'supPayments.poId remapped');
  assertEqual(ctx.DB.supPayments[0].poNum, 'PO-0001', 'supPayments.poNum confirmed unchanged — immutable historical snapshot');

  var qteUpdateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(qteUpdateCall, 'Quote.linkedPOIds[] pushed to Supabase, not just fixed locally, since Quote has already migrated');
  assertEqual(qteUpdateCall.row.linked_po_ids[0], 'new-po-uuid', 'the pushed value is the new Purchase Order id');
  assertEqual(ctx.DB.qt[0].linkedPOIds[0], 'new-po-uuid', 'local Quote mirror also correct after the trailing refresh');

  assertEqual(ctx.DB.po[0].id, 'new-po-uuid', 'Purchase Order own id remapped to the Supabase-assigned id');
  var archived = JSON.parse(ctx.localStorage.getItem('st_po_pre_migration'));
  assertEqual(archived[0].id, 'p1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('migratePOToSupabase — does NOT push Quote via persistQteChange when Quote has not itself migrated (local-only fix instead)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linkedPOIds: ['p1'] });
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.localStorage.setItem(ctx.K.p, JSON.stringify(ctx.DB.po));

  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1', name: 'ACME' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); } }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-po-restore-btn');

  await ctx.migratePOToSupabase();

  var qteCall = sb._calls.find(function(c){ return c.table === 'quotes'; });
  assert(!qteCall, 'no Supabase call attempted for quotes — Quote has not migrated');
  assertEqual(ctx.DB.qt[0].linkedPOIds[0], 'new-po-uuid', 'linkedPOIds[] still fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migratePOToSupabase — blocked if Supplier has not completed its own migration', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  var sb = mockSb({ suppliers: { selectData: [] } });
  ctx._sb = sb;
  await ctx.migratePOToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked before any insert — Supplier has not migrated');
});

testAsync('migratePOToSupabase — blocked if any local Purchase Order references a Supplier not found in the live connected project, including a blank supId', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001', supId: '', status: 'Draft', lineItems: [] }); // qteToPoConvert()'s blank-supId case
  var sb = mockSb({ suppliers: { selectData: [{ id: 's1', name: 'ACME' }] } });
  ctx._sb = sb;
  await ctx.migratePOToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked — blank supId does not resolve against the live project');
  ctx.localStorage.removeItem('st_cloud_migration_ts');
});

testAsync('migratePOToSupabase — blocked by a duplicate PO num (exact match); does not insert any row', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.DB.po.push({ id: 'p1', num: 'PO-0099', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.po.push({ id: 'p2', num: 'PO-0099', supId: 's1', status: 'Draft', lineItems: [] });
  var sb = mockSb({ suppliers: { selectData: [{ id: 's1', name: 'ACME' }] }, purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); } } });
  ctx._sb = sb;
  mockEl('po-dup-list');
  await ctx.migratePOToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked before any insert');
  ctx.localStorage.removeItem('st_cloud_migration_ts');
});

testAsync('migrateSuppliersBuyersToSupabase — now also rewrites Purchase Order.supId, and pushes to Supabase if Purchase Order has already migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.po.push({ id: 'po-uuid-1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-sup-uuid' }, row); } },
    purchase_orders: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'po-uuid-1', num: 'PO-0001', sup_id: 'new-sup-uuid', status: 'Draft', line_items: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');

  await ctx.migrateSuppliersBuyersToSupabase();

  assertEqual(ctx.DB.po[0].supId, 'new-sup-uuid', 'Purchase Order supId remapped locally');
  var poUpdateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(poUpdateCall, 'the rewritten Purchase Order was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateLineItemsToSupabase — now also rewrites Purchase Order.lineItems[].lid, and pushes to Supabase if Purchase Order has already migrated (this field is genuinely live, unlike Quote\'s equivalent)', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', supId: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, cur: 'USD', notes: '', priceHistory: [], invoiceRefs: [] });
  ctx.DB.po.push({ id: 'po-uuid-1', num: 'PO-0001', supId: 'new-sup-uuid', status: 'Draft', lineItems: [{ rid: 'r1', lid: 'l1' }] });
  ctx.localStorage.setItem(ctx.K.l, JSON.stringify(ctx.DB.li));
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } },
    purchase_orders: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'po-uuid-1', num: 'PO-0001', sup_id: 'new-sup-uuid', status: 'Draft', line_items: [{ rid: 'r1', lid: 'new-li-uuid' }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-li-restore-btn');

  await ctx.migrateLineItemsToSupabase();

  assertEqual(ctx.DB.po[0].lineItems[0].lid, 'new-li-uuid', 'Purchase Order lineItems[].lid remapped locally');
  var poUpdateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(poUpdateCall, 'the rewritten Purchase Order was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateQteToSupabase — now also rewrites Purchase Order.quoteId, and pushes to Supabase if Purchase Order has already migrated', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-uuid-1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [], quoteId: 'q1' });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linkedPOIds: [] });
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); } },
    purchase_orders: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'po-uuid-1', num: 'PO-0001', sup_id: 's1', status: 'Draft', line_items: [], quote_id: 'new-qte-uuid' }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-qt-restore-btn');

  await ctx.migrateQteToSupabase();

  assertEqual(ctx.DB.po[0].quoteId, 'new-qte-uuid', 'Purchase Order.quoteId remapped locally');
  var poUpdateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(poUpdateCall, 'the rewritten Purchase Order was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('savePO — Cloud Data configured and Purchase Order migrated: create calls insert with no client-generated id and resets po.id to the real one; update calls update().eq(); local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ['pf-n','pf-sup','pf-inv','pf-dt','pf-del','pf-cur','pf-pt','pf-dep','pf-fpm','pf-oth','pf-nt'].forEach(function(id){ mockEl(id); });
  mockEl('pf-n').value = 'PO-0001'; mockEl('pf-sup').value = 's1'; mockEl('pf-cur').value = 'USD';
  mockEl('po-sm').value = 'Draft';
  mockEl('pf-rec').checked = false;
  ctx.cPL = [];
  var sb = mockSb({ purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); }, selectData: [] } });
  ctx._sb = sb;
  ctx.EI.p = null;
  await ctx.savePO();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');

  resetDB();
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  mockEl('pf-n').value = 'PO-0002'; mockEl('pf-sup').value = 's1';
  ctx.cPL = [];
  ctx._sb = null;
  ctx.EI.p = null;
  await ctx.savePO();
  assertEqual(ctx.DB.po.length, 1, 'local-only path still pushes directly to DB.po, unchanged');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('delPO — Cloud Data configured and Purchase Order migrated: soft-delete via update({deleted_at}); local-only behavior unchanged when not migrated; PO-GAP-007 fix (Quote.linkedPOIds[] cleanup) runs in both cases', async function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linkedPOIds: ['p1', 'p2'] });
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  var sb = mockSb({ purchase_orders: { selectData: [] } });
  ctx._sb = sb;
  await ctx.delPO('p1');
  var updateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 1, 'PO-GAP-007 fix: deleted PO id removed from Quote.linkedPOIds[]');
  assertEqual(ctx.DB.qt[0].linkedPOIds[0], 'p2', 'the surviving id is untouched');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');

  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', status: 'Accepted', lines: [], linkedPOIds: ['p1'] });
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001' });
  ctx._sb = null;
  await ctx.delPO('p1');
  assertEqual(ctx.DB.po.length, 0, 'local-only path still filters DB.po directly, unchanged');
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 0, 'PO-GAP-007 fix runs regardless of Purchase Order Cloud Data state');
  ctx.confirm = function(){ return false; };
});

testAsync('autoPos — Cloud Data configured and Purchase Order migrated: multi-supplier Invoice creates one PO per Supplier, each with a real Supabase id, before Invoice.pos[] is written; local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.li.push({ id: 'l1', supId: 's1', sku: 'A', cost: 1 }, { id: 'l2', supId: 's2', sku: 'B', cost: 2 });
  var inv = { id: 'inv1', num: 'INV10001', date: '2026-01-01', lineItems: [{ lid: 'l1', desc: 'A', qty: 1, uom: 'pcs', up: 1 }, { lid: 'l2', desc: 'B', qty: 1, uom: 'pcs', up: 2 }] };
  ctx.DB.inv.push(inv);
  var callCount = 0;
  var sb = mockSb({ purchase_orders: { insertImpl: function(row){ callCount++; return Object.assign({ id: 'new-po-uuid-' + callCount }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.autoPos(inv);
  var insertCalls = sb._calls.filter(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assertEqual(insertCalls.length, 2, 'one PO inserted per distinct Supplier');
  assertEqual(ctx.DB.inv[0].pos.length, 2, 'Invoice.pos[] contains both real Supabase ids');
  assert(ctx.DB.inv[0].pos.indexOf('new-po-uuid-1') > -1 && ctx.DB.inv[0].pos.indexOf('new-po-uuid-2') > -1, 'both real ids present, not client-generated placeholders');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');

  resetDB();
  ctx.DB.li.push({ id: 'l1', supId: 's1', sku: 'A', cost: 1 });
  var inv2 = { id: 'inv2', num: 'INV10002', date: '2026-01-01', lineItems: [{ lid: 'l1', desc: 'A', qty: 1, uom: 'pcs', up: 1 }] };
  ctx.DB.inv.push(inv2);
  ctx._sb = null;
  await ctx.autoPos(inv2);
  assertEqual(ctx.DB.po.length, 1, 'local-only path still pushes directly to DB.po, unchanged');
  assertEqual(ctx.DB.inv[0].pos.length, 1, 'Invoice.pos[] still written locally');
});

testAsync('qteToPoConvert — Cloud Data configured and Purchase Order migrated: multi-supplier Quote creates one PO per Supplier, each with a real Supabase id, before q.linkedPOIds is written and persistQteChange runs; local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0010', status: 'Accepted', currency: 'USD', linkedPOIds: [], lines: [
    { rid: 'r1', supId: 'sA', desc: 'Item A', qty: 1, cost: 10, uom: 'pcs' },
    { rid: 'r2', supId: 'sB', desc: 'Item B', qty: 1, cost: 20, uom: 'pcs' }
  ] });
  ctx.EI.qt = 'q1';
  var callCount = 0;
  var sb = mockSb({ purchase_orders: { insertImpl: function(row){ callCount++; return Object.assign({ id: 'new-po-uuid-' + callCount }, row); }, selectData: [] } });
  ctx._sb = sb;
  mockEl('qt-po-btn');
  await ctx.qteToPoConvert();
  var insertCalls = sb._calls.filter(function(c){ return c.table === 'purchase_orders' && c.op === 'insert'; });
  assertEqual(insertCalls.length, 2, 'one PO inserted per distinct Supplier');
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 2, 'q.linkedPOIds contains both real Supabase ids');
  assert(ctx.DB.qt[0].linkedPOIds.indexOf('new-po-uuid-1') > -1 && ctx.DB.qt[0].linkedPOIds.indexOf('new-po-uuid-2') > -1, 'both real ids present, not client-generated placeholders');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');

  resetDB();
  ctx.DB.qt.push({ id: 'q2', num: 'QTE-0011', status: 'Accepted', currency: 'USD', linkedPOIds: [], lines: [{ rid: 'r1', supId: 'sA', desc: 'Item A', qty: 1, cost: 10, uom: 'pcs' }] });
  ctx.EI.qt = 'q2';
  ctx._sb = null;
  mockEl('qt-po-btn');
  await ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 1, 'local-only path still pushes directly to DB.po, unchanged');
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 1, 'q.linkedPOIds still updated locally');
});

testAsync('saveInv — FPM-funded-deposit auto-recovery pushes the touched Purchase Order via persistPOChange when Purchase Order has already migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.po.push({ id: 'p1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [], fpmFunded: 500, fpmRecovered: false });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV10001', pos: ['p1'], lineItems: [], calc_grandTotal: 0 });
  ['if-n','if-b','if-ba','if-st','if-dst','if-cid','if-dt','if-ex','if-sd','if-ft','if-wt','if-cbm','if-pk','if-pol','if-pod','if-coo','if-inco','if-cur','if-lf','if-ins','if-leg','if-isp','if-oth','if-dep','if-pt','if-terms'].forEach(function(id){ mockEl(id); });
  mockEl('if-n').value = 'INV10001'; mockEl('if-cur').value = 'USD';
  mockEl('inv-sm').value = 'Paid';
  ctx.EI.i = 'inv1';
  ctx.cIL = [];
  var sb = mockSb({ purchase_orders: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveInv();
  var updateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(updateCall, 'the FPM-recovered Purchase Order was pushed to Supabase via persistPOChange');
  assertEqual(updateCall.row.fpm_recovered, true, 'fpm_recovered pushed as true');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

test('pullAll — drops \'po\' from its business-key-matched pull once its own Cloud Data migration marker is set, independently of every other entity\'s exclusion', function() {
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({});
  var _pulledCalled = false;
  var origPulled = ctx.pulled;
  ctx.pulled = function(entity){ if (entity === 'po') _pulledCalled = true; return origPulled ? origPulled(entity) : Promise.resolve({ status: 'ok', records: [] }); };
  ctx.pullAll().catch(function(){});
  ctx.pulled = origPulled;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  ctx._sb = null;
  assert(!_pulledCalled, 'pulled(\'po\') never called once the migration marker is set');
});

test('cleanupExpiredMigrationArchive — Purchase Order archive expires independently of every other entity', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_po_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_po_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_po_pre_migration'), null, 'expired Purchase Order archive removed at day 31');
});

test('restorePOMigrationArchive — restores K.p and clears SS.supabaseUrl/supabaseAnonKey and its own marker', function() {
  resetDB();
  ctx.localStorage.setItem('st_po_pre_migration', JSON.stringify([{ id: 'orig-po', num: 'PO-0001' }]));
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restorePOMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.p))[0].id, 'orig-po', 'K.p restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');
  assertEqual(ctx.localStorage.getItem('st_po_cloud_migration_ts'), null, 'own marker cleared on restore');
  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('SPEC-CLOUD-005 test-hygiene cleanup — reset _sb and every Purchase Order Cloud Data migration marker this block may have left set, so later unrelated tests are not affected', async function() {
  ctx._sb = null;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  ctx.localStorage.removeItem('st_po_pre_migration');
});
```

This SPEC's own tests handle their own cleanup with the final test above — do not merge it into the existing `SPEC-CLOUD-004 test-hygiene cleanup` test, which stays scoped to its own two `st_qt_*` keys, mirroring how each prior SPEC's block ends with its own dedicated cleanup test rather than extending an earlier one.
