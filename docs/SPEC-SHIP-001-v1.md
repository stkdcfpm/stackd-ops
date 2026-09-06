# SPEC-SHIP-001 — Auto-created Shipment record with a progressive trade-document checklist, triggered on Invoice → Paid

**Status:** v1 — drafted directly against `REQ-SHIP-001-v1.md` (requirements-gate complete, 3 independent review rounds, ready for spec-gate per that document's own status line). Not yet independently spec-reviewed.
**Depends on:** nothing unshipped. Shipment is already Cloud-Data-migrated (`REQ-CLOUD-007`, v2.9.80); this SPEC extends its existing table with two new nullable columns.

All line numbers below were re-verified directly against the current `index.html`/`supabase/migrations/` at spec-drafting time, not carried forward from the REQ's own (slightly earlier) citations.

---

## 1. New module-level constant / schema shape

No new module-level JS variable is needed — `tradeDocs`/`autoCreatedFromInvIds` are plain properties on `DB.sh[]` records, following every other entity's convention (no dedicated `K`/`DB` top-level key, since Shipment already has one).

**New shared helper**, placed immediately before `autoCreateShipmentFromInvoice()` (§3 below):

```js
var SHIP_DEFAULT_TRADE_DOCS = ['Purchase Invoice', 'Commercial Invoice', 'Packing List', 'Bill of Lading', 'Certificate of Origin', 'Verified Gross Mass (VGM) Declaration', 'Insurance Certificate'];

function shpNewTradeDocEntry(type, autoManaged) {
  return { id: uid(), type: type, status: 'Pending', refNum: '', fileLocation: '', receivedDate: '', notes: '', autoManaged: !!autoManaged };
}

function shpSeedTradeDocs(dg) {
  var docs = SHIP_DEFAULT_TRADE_DOCS.map(function(t){ return shpNewTradeDocEntry(t, false); });
  if (dg) docs.push(shpNewTradeDocEntry('Dangerous Goods Declaration', true));
  return docs;
}

function shpComputeDocsStatus(tradeDocs) {
  if (!Array.isArray(tradeDocs) || !tradeDocs.length) return null; // caller decides whether to apply
  var anyReceived = tradeDocs.some(function(d){ return d.status === 'Received'; });
  var allDone = tradeDocs.every(function(d){ return d.status === 'Received' || d.status === 'N/A'; });
  if (allDone) return 'Complete';
  if (anyReceived) return 'In Progress';
  return 'Pending';
}
```

`shpComputeDocsStatus()` returning `null` for an absent/empty `tradeDocs` array is deliberate — REQ-SHIP-001g requires **no** recomputation at all for a Shipment with no `tradeDocs` array, not a recomputation that happens to also yield `null`; every call site below only assigns `docsStatus` when this returns non-null.

---

## 2. `saveInv()` — new trigger call, placed beside the existing FPM-deposit-recovery block

**File:** `index.html`, inside `saveInv()`. Current code at the exact insertion point (verified, `index.html:8442-8474`):

```js
  audit(EI.i?'UPDATE':'CREATE','invoice',inv.id,inv); toast('Invoice saved'); renderOnboarding();
  await syncEnt('inv',inv).catch(function(){});
  if(!EI.i) autoPos(inv);
  // Auto-recover FPM-funded deposits when invoice is marked Paid
  if (inv.status === 'Paid') {
    var recovered = false;
    ... (unchanged, lines 8449-8472)
  }
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) await refreshInvFromSupabase();
```

**Change:** add the new call immediately after the FPM-deposit-recovery block's closing `}` and before the trailing `refreshInvFromSupabase()` line:

```js
  audit(EI.i?'UPDATE':'CREATE','invoice',inv.id,inv); toast('Invoice saved'); renderOnboarding();
  await syncEnt('inv',inv).catch(function(){});
  if(!EI.i) autoPos(inv);
  // Auto-recover FPM-funded deposits when invoice is marked Paid
  if (inv.status === 'Paid') {
    var recovered = false;
    ... (unchanged)
  }
  if (inv.status === 'Paid') await autoCreateShipmentFromInvoice(inv);
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) await refreshInvFromSupabase();
```

This placement satisfies REQ-SHIP-001b's toast-ordering requirement automatically: `toast('Invoice saved')` (line 8446) always fires before this new call, matching `autoPos()`'s own precedent. A separate `if (inv.status === 'Paid')` block (rather than folding into the existing deposit-recovery `if`) keeps the two concerns independently readable and independently testable — no shared state between them.

**Never called from:** `processImportRecords()` (`index.html:10852` onward — its `entity === 'inv'` branch, like every other entity branch, builds a `rec` object and pushes/updates `DB.inv` directly via `sv(K.i, DB.inv)`, confirmed by direct read of the function's `sup`-entity branch pattern at `index.html:10855-10867`, which every other entity branch including `inv` repeats structurally — no branch calls `saveInv()`), `pullAll()`'s invoice merge (writes `DB.inv` directly), or any Cloud Data refresh function. No code change needed to enforce this — it falls out naturally from the call living inside `saveInv()`'s own body, which none of those paths invoke. Re-verify the `inv`-specific branch's exact line range at implementation time (this function is long and re-verifying every entity's own branch boundary is worth the minute it costs), but the structural claim was independently confirmed twice already (round-1 requirements-gate review, and this spec's own read of the function's shared shape).

---

## 3. New function: `autoCreateShipmentFromInvoice(inv)`

Placed directly after `autoPos()` (`index.html:8572-8612` currently) so the two Invoice-triggered auto-creation functions sit adjacent, matching this codebase's convention of grouping related mutation functions.

```js
async function autoCreateShipmentFromInvoice(inv) {
  if (SS.autoCreateShipmentOnPaid === false) return;
  var already = DB.sh.some(function(s){
    return (s.autoCreatedFromInvIds||[]).indexOf(inv.id) > -1 || (s.linkedInvs||[]).indexOf(inv.num) > -1;
  });
  if (already) return;

  var ref = 'SHP-' + (inv.num || Date.now().toString(36));
  var suffix = 2;
  while (DB.sh.some(function(s){ return s.ref === ref; })) { ref = 'SHP-' + (inv.num || Date.now().toString(36)) + '-' + suffix; suffix++; }

  var newShp = {
    id: uid(), ref: ref, blNum: '', vessel: '', carrier: '', originPort: '', destPort: '',
    etd: '', eta: '', containerType: '', containerNum: '', dg: false,
    tradeDocs: shpSeedTradeDocs(false), docsStatus: 'Pending', status: RD_SHP_STATUS[0],
    linkedInvs: [inv.num], autoCreatedFromInvIds: [inv.id],
    forwarder: '', forwarderEmail: '', notes: '', updAt: new Date().toISOString()
  };

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var shRow = {
      ref: newShp.ref, bl_num: null, vessel: null, carrier: null, origin_port: null, dest_port: null,
      etd: null, eta: null, container_type: null, container_num: null, dg: false,
      docs_status: newShp.docsStatus, status: newShp.status, linked_invs: newShp.linkedInvs,
      trade_docs: newShp.tradeDocs, auto_created_from_inv_ids: newShp.autoCreatedFromInvIds,
      forwarder: null, forwarder_email: null, notes: null, upd_at: newShp.updAt
    };
    var result = await _sb.from('shipments').insert(shRow).select().single();
    if (result.error) { toast('Auto-created Shipment failed to save to Cloud Data: ' + result.error.message); return; }
    newShp.id = result.data.id;
    await refreshShFromSupabase();
  } else {
    DB.sh.push(newShp);
    sv(K.sh, DB.sh);
  }
  rShp();
  toast('Shipment ' + ref + ' auto-created — add details as they become available');
}
```

Notes tying this directly to REQ-SHIP-001's decisions:
- The `SS.autoCreateShipmentOnPaid === false` check (not `!== true`) is REQ-SHIP-001k's exact requirement — an upgrading operator whose `SS` predates this field has the property `undefined`, which is `=== false` → `false`, so the check passes through and auto-creation proceeds, matching AC-13's default-on requirement.
- The idempotency check is the two-part OR from Decision 3/§9b: `autoCreatedFromInvIds` (primary, immutable-`id`-keyed) **or** `linkedInvs` (secondary, catches a human-pre-created Shipment). Implemented as a single `.some()` for clarity — no ordering dependency between the two conditions.
- `status: RD_SHP_STATUS[0]` reads the live constant rather than hardcoding `'Booked'` as a string literal, so a future reordering of `RD_SHP_STATUS` (unlikely, but this avoids the exact class of drift `SH_STATUSES`/`RD_SHP_STATUS` naming confusion produced during requirements-gate) can't silently desync this default from the dropdown's own first option.
- `rShp()` is called unconditionally after either branch (mirroring `autoPos()`'s own `rPO()` call) so the Shipments tab reflects the new record immediately if the operator is already looking at it — cheap no-op if they're on a different tab, since `rShp()` only touches `#sh-tb`/`#sh-em` if the DOM elements exist.
- No `vShp()` call anywhere in this function — this path bypasses form validation entirely, exactly as `autoPos()` bypasses `vPO()`, since there is no form for the trigger to have populated.

---

## 4. `saveShp()` — preserve `tradeDocs`/`autoCreatedFromInvIds` on every edit (REQ-SHIP-001e2, the fix for finding B1)

**File:** `index.html:12915-12969` (current). Exact current code:

```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    ... (11 more plain fields)
    updAt: new Date().toISOString()
  };

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    ...
    var shRow = { ref: shp.ref, bl_num: shp.blNum || null, ... upd_at: shp.updAt };
    ...
  } else {
    if (EI.sh) {
      var idx = DB.sh.findIndex(function(x){ return x.id===EI.sh; });
      if (idx>-1) DB.sh[idx]=shp; else DB.sh.push(shp);
    } else {
      DB.sh.push(shp);
    }
    sv(K.sh, DB.sh);
  }
```

**Change:** insert a preservation block immediately after the `shp` object literal is built and before the Cloud Data branch, only on the edit path:

```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    ... (unchanged, 11 more plain fields)
    updAt: new Date().toISOString()
  };

  // REQ-SHIP-001e2: neither field has a form control on the Edit Shipment modal —
  // without this, any edit here silently discards the entire trade-document
  // checklist and the auto-creation idempotency marker (build-gate finding B1).
  if (EI.sh) {
    var existingShp = DB.sh.find(function(x){ return x.id === EI.sh; });
    shp.tradeDocs = (existingShp && existingShp.tradeDocs) || [];
    shp.autoCreatedFromInvIds = (existingShp && existingShp.autoCreatedFromInvIds) || [];
  } else {
    shp.tradeDocs = []; shp.autoCreatedFromInvIds = [];
  }

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    ...
    var shRow = {
      ref: shp.ref, bl_num: shp.blNum || null, ... upd_at: shp.updAt,
      trade_docs: shp.tradeDocs, auto_created_from_inv_ids: shp.autoCreatedFromInvIds
    };
    ...
  } else {
    ... (unchanged)
  }
```

**Why the create path (`else` branch) sets both to `[]` rather than leaving them undefined:** a brand-new Shipment created through the normal "New Shipment" modal has no `tradeDocs` at all — this matches REQ-SHIP-001a's "absent... on any Shipment created before this feature ships" only in spirit (that clause is about *pre-existing* records, not new ones created after the feature ships via the manual path). A manually-created Shipment created *after* this feature ships getting `tradeDocs: []` rather than an absent key is a deliberate, minor divergence from "absent": it means `shpComputeDocsStatus([])` would be called on it once REQ-SHIP-001f's CRUD functions start touching it, correctly reporting `'Pending'` for zero tracked documents (the right answer — a manually-created Shipment simply doesn't participate in the auto-checklist until an operator adds a line via REQ-SHIP-001f, which is exactly what `[]` — not `undefined` — behaviorally means: "opted into tracking, zero documents yet" vs. "never opted in"). This is a spec-gate judgment call, not carried over from the REQ; flagging it explicitly for review rather than silently deciding it.

---

## 5. `refreshShFromSupabase()` — carry both new fields (fix for finding C1)

**File:** `index.html:6187-6206` (current, re-verified). Exact current code:

```js
async function refreshShFromSupabase() {
  if (!_sb) return;
  var result = await _sb.from('shipments').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Shipments from Cloud Data.'); return; }
  DB.sh = result.data.map(function(row){
    var s = {
      id: row.id, ref: row.ref, blNum: row.bl_num || '', vessel: row.vessel || '', carrier: row.carrier || '',
      originPort: row.origin_port || '', destPort: row.dest_port || '', etd: row.etd || '', eta: row.eta || '',
      containerType: row.container_type || '', containerNum: row.container_num || '', dg: !!row.dg,
      docsStatus: row.docs_status || '', status: row.status, linkedInvs: row.linked_invs || [],
      forwarder: row.forwarder || '', forwarderEmail: row.forwarder_email || '', notes: row.notes || ''
    };
    if (row.upd_at != null) s.updAt = row.upd_at;
    return s;
  });
  sv(K.sh, DB.sh);
  if (!localStorage.getItem('st_sh_cloud_migration_ts')) localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  rShp(); rDash();
}
```

**Change:** add two bare-`!= null` guarded lines, following the exact idiom the function already uses for `upd_at`:

```js
    if (row.upd_at != null) s.updAt = row.upd_at;
    if (row.trade_docs != null) s.tradeDocs = row.trade_docs;
    if (row.auto_created_from_inv_ids != null) s.autoCreatedFromInvIds = row.auto_created_from_inv_ids;
    return s;
```

**Never** `s.tradeDocs = row.trade_docs || [];` — a legacy row's `trade_docs: null` must leave `tradeDocs` absent, not `[]`, or `shpComputeDocsStatus([])` (§1) would be reachable for a record that never opted into this feature at all, reporting `'Complete'` for zero documents and violating AC-8/AC-18.

---

## 6. `migrateShToSupabase()` — carry both new fields (fix for finding C1)

**File:** `index.html:7319-7360` (current, re-verified). Exact current insert-payload code (`index.html:7346-7354`):

```js
    var result = await _sb.from('shipments').insert({
      ref: s.ref, bl_num: s.blNum || null, vessel: s.vessel || null, carrier: s.carrier || null,
      origin_port: s.originPort || null, dest_port: s.destPort || null, etd: s.etd || null, eta: s.eta || null,
      container_type: s.containerType || null, container_num: s.containerNum || null, dg: !!s.dg,
      docs_status: s.docsStatus || null, status: s.status,
      linked_invs: Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : []),
      forwarder: s.forwarder || null, forwarder_email: s.forwarderEmail || null, notes: s.notes || null,
      upd_at: s.updAt != null ? s.updAt : null
    }).select().single();
```

**Change:** add two fields, mirroring the existing `linked_invs` coercion pattern immediately preceding them:

```js
    var result = await _sb.from('shipments').insert({
      ref: s.ref, bl_num: s.blNum || null, vessel: s.vessel || null, carrier: s.carrier || null,
      origin_port: s.originPort || null, dest_port: s.destPort || null, etd: s.etd || null, eta: s.eta || null,
      container_type: s.containerType || null, container_num: s.containerNum || null, dg: !!s.dg,
      docs_status: s.docsStatus || null, status: s.status,
      linked_invs: Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : []),
      trade_docs: Array.isArray(s.tradeDocs) ? s.tradeDocs : null,
      auto_created_from_inv_ids: Array.isArray(s.autoCreatedFromInvIds) ? s.autoCreatedFromInvIds : null,
      forwarder: s.forwarder || null, forwarder_email: s.forwarderEmail || null, notes: s.notes || null,
      upd_at: s.updAt != null ? s.updAt : null
    }).select().single();
```

---

## 7. New Supabase migration file: `supabase/migrations/0008_shipments_trade_docs.sql`

```sql
-- SPEC-SHIP-001: adds two nullable jsonb columns to the existing shipments
-- table for the auto-created trade-document checklist. Additive only — no
-- backfill, no data migration, no change to any existing column or
-- constraint. Both columns are null on every pre-existing row; refreshShFromSupabase()
-- (index.html) leaves the corresponding local field absent (not []) when the
-- column is null, per REQ-SHIP-001a's "absent for pre-existing records" rule.

alter table shipments
  add column trade_docs jsonb,
  add column auto_created_from_inv_ids jsonb;
```

No RLS policy change needed — the existing `shipments` table policies (`authenticated read/insert/update`, no delete) already cover these new columns since RLS is row-level, not column-level.

---

## 8. Settings → Integrations: new toggle + `saveShp()`/Settings-load wiring

**File:** `index.html`, Integrations card (`index.html:751-758`, current):

```html
    <div class="card">
      <div class="ct">Integrations</div>
      <div class="fld" style="margin-bottom:10px;">
        <label>Forwarder Webhook URL <span style="font-size:.44rem;color:var(--m);">(Power Automate or Zapier — receives JSON with shipmentRef + message)</span></label>
        <input type="text" id="cfg-fwd-webhook" placeholder="https://prod.example.com/triggers/..." autocomplete="off">
      </div>
      <button class="btn btn-s" onclick="saveFwdWebhook()">Save Webhook</button>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; ...</p>
    </div>
```

**Change:** add a new `<div class="fld">` with a checkbox, above the existing webhook field, in the same card:

```html
    <div class="card">
      <div class="ct">Integrations</div>
      <div class="fld" style="margin-bottom:10px;">
        <label><input type="checkbox" id="cfg-autoship-toggle" onchange="saveAutoShipToggle()"> Auto-create Shipment when an Invoice is marked Paid <span style="font-size:.44rem;color:var(--m);">(default on)</span></label>
      </div>
      <div class="fld" style="margin-bottom:10px;">
        <label>Forwarder Webhook URL ...</label>
        <input type="text" id="cfg-fwd-webhook" ...>
      </div>
      <button class="btn btn-s" onclick="saveFwdWebhook()">Save Webhook</button>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; ...</p>
    </div>
```

**New function**, placed immediately after `saveFwdWebhook()` (`index.html:13152-13157`):

```js
function saveAutoShipToggle() {
  SS.autoCreateShipmentOnPaid = G('cfg-autoship-toggle').checked;
  sv(K.ss, SS);
  rInv(); rShp();
  toast('Setting saved');
}
```

`rInv()`/`rShp()` are called immediately so the persistent off-state banner (§9 below) appears/disappears without a page reload, satisfying AC-12's requirement directly — both functions already run cheaply as no-ops if their tab isn't the active one.

**Settings-tab load wiring**, in `rCfg()` (`index.html:12309-...`, the Settings view's own render function — confirmed by direct read, dispatched via `showV()`'s `fns` map for the `cfg` tab), at the exact line that currently loads `cfg-fwd-webhook`'s value (`index.html:12317`):

```js
  if(G('cfg-fwd-webhook')) G('cfg-fwd-webhook').value=SS.fwdWebhook||'';
  if(G('cfg-autoship-toggle')) G('cfg-autoship-toggle').checked = SS.autoCreateShipmentOnPaid !== false;
```

`!== false` (not `=== true`) so an upgrading operator's `SS.autoCreateShipmentOnPaid === undefined` renders the checkbox as **checked**, matching the default-on requirement (AC-13) visually, not just behaviorally.

---

## 9. Persistent off-state banner on Invoices and Shipments tabs

**Static HTML**, added immediately inside each view's opening `<div class="view" id="v-inv">`/`id="v-sh">`, before the existing `<div class="tb">` toolbar row. Invoices view (`index.html`, immediately before line 296's `<div style="font-family:'Bebas Neue'...">INVOICES</div>` toolbar content):

```html
<div id="inv-autoship-banner" class="banner" style="display:none;position:static;margin-bottom:10px;">
  <span>&#9888; Shipment auto-creation is OFF — Paid invoices will not create a Shipment record automatically. Turn back on in Settings → Integrations.</span>
</div>
```

Shipments view, symmetrically, immediately after `<div class="view" id="v-sh">` and before its own `<div class="tb">` (`index.html:333-334`):

```html
<div id="sh-autoship-banner" class="banner" style="display:none;position:static;margin-bottom:10px;">
  <span>&#9888; Shipment auto-creation is OFF — Paid invoices will not create a Shipment record automatically. Turn back on in Settings → Integrations.</span>
</div>
```

**Reusing the existing `.banner` CSS class** (already defined for the page-load Sheets-sync-URL banner, `index.html:218`) rather than a new style — that banner is `position: fixed` by default for its own page-header placement; both new banner instances need `position: static` inline (as shown above) so they lay out normally within their view instead of overlaying content, since they aren't page-global. Confirm `.banner`'s base CSS rule at implementation time and add whatever override is needed beyond `position` if the fixed variant's other properties (width, z-index) also assume page-header placement — this is a spec-gate-acknowledged detail, not fully resolved here, since the exact CSS cascade depends on rules not reproduced in this SPEC.

**Wiring into `rInv()`/`rShp()`** — add one line near the top of each function's body (`rInv()`, `index.html:8838`; `rShp()`, `index.html:12834`), before either function does anything else:

```js
function rInv() {
  var banner = G('inv-autoship-banner'); if (banner) banner.style.display = (SS.autoCreateShipmentOnPaid === false) ? 'flex' : 'none';
  var q=(G('inv-q')&&G('inv-q').value||'').toLowerCase(), sf=G('inv-sf')&&G('inv-sf').value||'';
  ... (unchanged)
```

```js
function rShp() {
  var banner = G('sh-autoship-banner'); if (banner) banner.style.display = (SS.autoCreateShipmentOnPaid === false) ? 'flex' : 'none';
  var q = (G('sh-q') ? G('sh-q').value.toLowerCase() : '');
  ... (unchanged)
```

Since `rInv()`/`rShp()` already run on every tab-open (`showV()`'s `fns` dispatch) and are called explicitly by `saveAutoShipToggle()` (§8), the banner reflects the current toggle state on every path that could change it — no separate "check on interval" or "check on focus" mechanism needed.

---

## 10. REQ-SHIP-001e — DG toggle add/remove logic, inside `saveShp()`

Placed in the same preservation block added in §4, immediately after `tradeDocs`/`autoCreatedFromInvIds` are carried forward, still inside the `if (EI.sh)` branch (this logic only applies on edit — a brand-new Shipment's `dg` starts `false` with no DG line to add or remove):

```js
  if (EI.sh) {
    var existingShp = DB.sh.find(function(x){ return x.id === EI.sh; });
    shp.tradeDocs = (existingShp && existingShp.tradeDocs) || [];
    shp.autoCreatedFromInvIds = (existingShp && existingShp.autoCreatedFromInvIds) || [];
    var wasDg = !!(existingShp && existingShp.dg);
    var dgLineIdx = shp.tradeDocs.findIndex(function(d){ return d.autoManaged && d.type === 'Dangerous Goods Declaration'; });
    if (shp.dg && !wasDg && dgLineIdx === -1) {
      shp.tradeDocs = shp.tradeDocs.concat([shpNewTradeDocEntry('Dangerous Goods Declaration', true)]);
    } else if (!shp.dg && wasDg && dgLineIdx > -1) {
      var dgLine = shp.tradeDocs[dgLineIdx];
      var untouched = dgLine.status === 'Pending' && !dgLine.refNum && !dgLine.fileLocation && !dgLine.notes;
      if (untouched) shp.tradeDocs = shp.tradeDocs.filter(function(d, i){ return i !== dgLineIdx; });
    }
  } else {
    shp.tradeDocs = shp.dg ? [shpNewTradeDocEntry('Dangerous Goods Declaration', true)] : [];
    shp.autoCreatedFromInvIds = [];
  }
```

The `wasDg`/current-`shp.dg` comparison (rather than reacting to `dg` alone) means this logic only fires on an actual toggle, not on every save of an already-`dg:true` Shipment — a re-save with `dg` unchanged neither adds nor removes anything, leaving an operator's own custom "Dangerous Goods Declaration"-labeled line (which never has `autoManaged: true`) untouched in every case, per REQ-SHIP-001e's own disambiguation requirement.

**`docsStatus` recomputation**, immediately after the block above, still inside `saveShp()`:

```js
  if (shp.tradeDocs.length) shp.docsStatus = shpComputeDocsStatus(shp.tradeDocs);
```

This one line covers REQ-SHIP-001g for the `saveShp()` path — the DG add/remove case above, and any future edit that mutates `tradeDocs` through `saveShp()` directly (none does today; REQ-SHIP-001f's CRUD functions, §11, are the actual mutation surface for a general document-status change, and must call `shpComputeDocsStatus()` themselves after their own mutation, then persist via their own path — not necessarily through `saveShp()`).

---

## 11. REQ-SHIP-001f — per-document CRUD functions

Three new functions, exact UI trigger/placement left to implementation (a details panel on the Shipment edit view is the natural fit, given `tradeDocs` isn't a form field on the main modal per §4's design) — but the **function contracts and preservation rigor below are not optional**, per REQ-SHIP-001f's own explicit carry-forward requirement:

```js
async function shpAddTradeDoc(shId, type) {
  var s = DB.sh.find(function(x){ return x.id === shId; });
  if (!s || !type || !type.trim()) return;
  s.tradeDocs = (s.tradeDocs || []).concat([shpNewTradeDocEntry(type.trim(), false)]);
  s.docsStatus = shpComputeDocsStatus(s.tradeDocs);
  s.updAt = new Date().toISOString();
  await shpPersistTradeDocsChange(s);
}

async function shpEditTradeDoc(shId, docId, fields) {
  var s = DB.sh.find(function(x){ return x.id === shId; });
  if (!s) return;
  var d = (s.tradeDocs || []).find(function(x){ return x.id === docId; });
  if (!d) return;
  ['status','refNum','fileLocation','receivedDate','notes'].forEach(function(k){
    if (fields[k] !== undefined) d[k] = fields[k];
  });
  s.docsStatus = shpComputeDocsStatus(s.tradeDocs);
  s.updAt = new Date().toISOString();
  await shpPersistTradeDocsChange(s);
}

async function shpRemoveTradeDoc(shId, docId) {
  var s = DB.sh.find(function(x){ return x.id === shId; });
  if (!s) return;
  s.tradeDocs = (s.tradeDocs || []).filter(function(d){ return d.id !== docId; });
  s.docsStatus = shpComputeDocsStatus(s.tradeDocs);
  s.updAt = new Date().toISOString();
  await shpPersistTradeDocsChange(s);
}

async function shpPersistTradeDocsChange(s) {
  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('shipments').update({
      trade_docs: s.tradeDocs, docs_status: s.docsStatus, upd_at: s.updAt
    }).eq('id', s.id).select().single();
    if (result.error) { toast('Save failed: ' + result.error.message); return; }
    await refreshShFromSupabase();
  } else {
    sv(K.sh, DB.sh);
  }
  rShp();
}
```

Every one of these three mutation functions operates on `s.tradeDocs` **in place on the existing `DB.sh` record** (found by `id`, mutated, never rebuilt from a partial field set) and pushes only the two touched columns (`trade_docs`, `docs_status`) on the Cloud Data branch — this is the structural reason none of them can reintroduce B1's bug class: there is no full-object-replace anywhere in this section, so there is nothing to preserve *against*. `shpPersistTradeDocsChange()` deliberately does not touch `ref`/`status`/`linkedInvs`/etc. at all, on either branch, for the same reason.

`shpRemoveTradeDoc()` on the last surviving `autoManaged: true` DG line has no special guard — an operator can remove it directly through this path even without toggling `dg` off first; REQ-SHIP-001e's own guard only governs the `saveShp()`-driven add/remove-on-toggle path (§10), not this direct per-document deletion, which is an explicit, deliberate operator action requiring no additional protection (mirrors `delRfqResponse()`'s own unguarded-by-default deletion pattern elsewhere in this codebase).

---

## 12. `AI_SYSTEM_PROMPT` update (REQ-SHIP-001i)

**File:** `index.html`, `## Shipments` section (`index.html:11643-11648`, current):

```
'## Shipments',
'Shipments tab → + New Shipment. Ref format: SHP-001.',
...
```

**Add** one new line immediately after the existing `'## Shipments'` heading line:

```js
'## Shipments',
'A Shipment is now also auto-created automatically whenever an Invoice is saved with status Paid (unless disabled in Settings → Integrations → Auto-create Shipment toggle) — it starts with a 7-item trade-document checklist (Purchase Invoice, Commercial Invoice, Packing List, Bill of Lading, Certificate of Origin, VGM Declaration, Insurance Certificate; an 8th, Dangerous Goods Declaration, if the shipment is DG-flagged) that the operator fills in with reference numbers, received dates, and a file-location note as documents arrive — no file upload, location/link tracking only.',
'Shipments tab → + New Shipment. Ref format: SHP-001.',
...
```

---

## 13. Explicitly unchanged (confirmed by this spec, not just asserted by the REQ)

- `FIELD_MAPS.sh` (`index.html:4804`) — no entry added for `tradeDocs`/`autoCreatedFromInvIds`. Confirmed compatible with the Sheets sync path per REQ-SHIP-001's own Decision 4 verification (`unmapRec()`/`mergePulledWithLocal()` preserve unmapped local fields).
- `vShp()` (`index.html:10352-10367`) — no change. The auto-creation path bypasses it entirely (§3); the manual edit/create path's validation rules are unaffected by either new field.
- `shpStatusClass()` (`index.html:12795-12804`) — no change. Governs the physical-transit `status` tag only, untouched by this feature.
- The existing `docsStatus` tag-class lookup inline in `rShp()` (`'s-paid'`/`'s-sent'`/`'s-draft'` ternary, `index.html:12871` currently) — no change needed; it already reads `s.docsStatus` as a plain string regardless of whether that value was set manually or computed by `shpComputeDocsStatus()`.
- `editShp()` — no change beyond whatever populates the edit modal's existing fields; it does not need to read `tradeDocs`/`autoCreatedFromInvIds` into any form field, since neither is edited through the main modal (§4/§11 use separate functions).

---

## 14. Test plan

Every AC from `REQ-SHIP-001-v1.md` §3 maps to at least one test; several ACs are split into more than one test for isolation. Fixture pattern: a `mkPaidInvoice(overrides)` helper returning a minimal valid Invoice object with `status: 'Paid'`, mirroring existing fixture helpers' style (e.g. `mkOrdTwoLines()` from the prior REQ-AI-GAP-012 delivery).

- **AC-1 / AC-1b:** `autoCreateShipmentFromInvoice()` called directly with a fresh Paid invoice and no existing Shipment → exactly one `DB.sh` record created, `tradeDocs.length === 7`, `ref` matches the `'SHP-' + num` pattern, `linkedInvs === [inv.num]`, `autoCreatedFromInvIds === [inv.id]`. A second test drives it via `saveInv()` directly (not calling the helper function itself) with a brand-new invoice object (`EI.i` unset) saved straight to `status: 'Paid'`, confirming AC-1b's exact scenario end-to-end.
- **AC-2 / AC-3 / AC-3b:** call `autoCreateShipmentFromInvoice()` twice with the same invoice → `DB.sh.length` unchanged after the second call (AC-2/AC-3). A third test creates the Shipment, then mutates `inv.num` on the in-memory invoice object and calls again → still no second Shipment (AC-3b), asserting specifically that the match came from `autoCreatedFromInvIds`, not `linkedInvs`.
- **AC-4 / AC-5:** call `processImportRecords('inv', [...])`/simulate a `pullAll()` merge with a row carrying `status: 'Paid'` → `DB.sh.length` unchanged (no `autoCreateShipmentFromInvoice` call reachable from either path — verified by spying on the function, asserting it was never called, not just asserting no net `DB.sh` change).
- **AC-6:** pre-seed `DB.sh` with a record whose `ref` equals the exact string `autoCreateShipmentFromInvoice()` would synthesize for a given invoice, call it, assert the new record's `ref` has the `-2` suffix and no collision.
- **AC-7:** build a `tradeDocs` array by hand in each of the three states (`all Pending`, `one Received rest Pending`, `all Received/N-A`), call `shpComputeDocsStatus()` directly on each, assert `'Pending'`/`'In Progress'`/`'Complete'` respectively.
- **AC-8:** a Shipment fixture with no `tradeDocs` key at all, run it through `saveShp()`'s edit path unrelated-field-change scenario (same setup as AC-14) — assert `docsStatus` is byte-identical to its pre-edit value, and `shpComputeDocsStatus` is never invoked with an empty/absent array in a way that would set `docsStatus`.
- **AC-9 / AC-15:** three sub-cases via `saveShp()`'s DG-toggle logic (§10) directly: (a) `dg` false→true with no existing DG line → one added, `autoManaged: true`; (b) `dg` true→false with the DG line still untouched/`Pending` → removed; (c) `dg` true→false with the DG line having a `refNum` set → NOT removed. A fourth sub-case for AC-9 specifically: an operator's own custom `tradeDocs` entry typed `'Dangerous Goods Declaration'` with `autoManaged` absent/false is never touched by any of the above.
- **AC-10:** two variants of the Cloud Data branch in `autoCreateShipmentFromInvoice()` — mocked `_sb`/migration marker present (insert called with `trade_docs`/`auto_created_from_inv_ids` in the payload, `refreshShFromSupabase()` called after) vs. absent (`DB.sh.push`/`sv(K.sh,...)` called, no Supabase call).
- **AC-11:** a `fileLocation` value containing `"><script>` rendered through whatever `rShp()`/the new REQ-SHIP-001f UI's render path uses — assert the output HTML has no unescaped `<script>` tag (reuse the existing `SEC-GAP-021`-era assertion helper pattern if one exists in `tests/run.js`).
- **AC-12 / AC-13:** `saveAutoShipToggle()` called with the checkbox unchecked → `SS.autoCreateShipmentOnPaid === false`, `mockEl('inv-autoship-banner').style.display`/`mockEl('sh-autoship-banner').style.display` both `'flex'` after calling `rInv()`/`rShp()`; toggled back → both `'none'`. A separate test confirms `autoCreateShipmentFromInvoice()` itself is a no-op (asserted via a spy, not just "no new Shipment," to distinguish "correctly bailed" from "bailed for the wrong reason") when the toggle is off, and behaves as AC-1 when on/unset.
- **AC-14 / AC-16:** the primary B1-regression tests. AC-14: auto-create via AC-1's fixture, then call `saveShp()` with `EI.sh` set to that record's id and only an unrelated field (`vessel`) changed on the mock form — assert `tradeDocs` on the resulting `DB.sh` record is deep-equal to its pre-edit value. AC-16: same shape but starting from a manually-created Shipment (no auto-creation involved) that has `tradeDocs` populated via `shpAddTradeDoc()` first.
- **AC-17 / AC-18 / AC-19:** mock `_sb`, drive `autoCreateShipmentFromInvoice()` through its Cloud Data branch, then call `refreshShFromSupabase()` with a mocked response echoing back the inserted row's `trade_docs`/`auto_created_from_inv_ids` — assert both survive on the resulting `DB.sh` record (AC-17). A second test mocks a row with both columns `null` (simulating a legacy pre-feature record) — assert `tradeDocs`/`autoCreatedFromInvIds` are absent (`'tradeDocs' in record === false`), not `[]`, and `docsStatus` is untouched (AC-18, the negative-assertion pattern this codebase's own `CLAUDE.md` calls out as necessary for this exact bug class). A third test drives `migrateShToSupabase()` on a local record with real `tradeDocs` progress, mocks the insert response, and confirms the payload sent to Supabase included both new fields (AC-19).

Mutation-testing discipline (per this session's established practice): once implemented, revert each of the following in a scratch copy and confirm the predicted test(s) fail — (a) the `saveShp()` preservation block from §4, (b) the two new lines in `refreshShFromSupabase()`, (c) the two new fields in `migrateShToSupabase()`'s insert payload, (d) the `autoCreatedFromInvIds` half of the idempotency `.some()` check in §3, (e) the `SS.autoCreateShipmentOnPaid === false` bail-out.

---

## 15. Version-ship housekeeping (on completion, per `CLAUDE.md`'s standing checklist)

- Bump `Current version`, test count, and the three hardcoded version-number strings (`<title>`, nav badge, `AI_SYSTEM_PROMPT` self-description) — run the `grep -n "v2\.9\.<old>"` sweep before closing out.
- `docs/version-history.md` — prepend new version row describing this feature and its 3-round requirements-gate history.
- `docs/known-gaps.md` — no new gap expected if build-gate finds nothing; log anything build-gate does find.
- `STACKD_CONTEXT.md`'s "Backlog carried forward" table — remove/mark this item once shipped; the deferred webhook REQ and Contacts-via-Excel REQ remain queued behind it.
- `docs/user-guide.md` — new subsection under Shipments describing the auto-creation trigger, the trade-document checklist, and the Settings toggle.
- `docs/requirements-tracker.md` — append the REQ-SHIP-001 row with full req-gate (3 rounds) and spec-gate history once spec-gate completes.
- In-app changelog — new version block.
- Update `supabase/migrations/0007_shipments.sql`'s own header comment? **No** — per this codebase's own convention (confirmed by reading every existing migration file), a shipped migration file is never edited after the fact; `0008_shipments_trade_docs.sql` (§7) is the correct, additive, separate file.

---

## 16. Review-resolution log

(Populated once independent spec-gate review runs.)
