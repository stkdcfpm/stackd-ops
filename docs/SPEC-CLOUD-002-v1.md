# SPEC-CLOUD-002 — Extend Cloud Data (Supabase) to Line Item and Contact

**Status:** v1 — spec-gate round 1: CONDITIONAL PASS (4 blocking B1-B4, 5 advisories A1-A5), fixed. Round 2: CONDITIONAL PASS (1 new blocking, 2 advisories), fixed. Round 3: CONDITIONAL PASS (1 new blocking + 1 folded-in sibling case, 1 advisory), fixed. See §6 review-resolution log. Ready for implementation.

---

## 0. Design decision: the Supplier-migration-completion precondition (REQ-CLOUD-002 §1 point 3)

REQ-CLOUD-002 deliberately left open *how* to check "has Supplier's migration actually completed" (as opposed to merely "`_sb` is truthy"), since no such flag exists anywhere in the codebase today. Two mechanisms were weighed:

1. **A dedicated `migration_markers` Supabase table**, written once by `migrateSuppliersBuyersToSupabase()` on completion, read by the new precondition check. Rejected: it needs a backfill statement to retroactively mark already-migrated production deployments (the marker can't exist before this SPEC ships), it's schema surface the REQ's own §3 explicitly discourages ("a per-entity migration-completed flag as a reusable general mechanism"), and it still needs a live-Supabase-query fallback anyway for the same edge case below — so it adds a table without removing the need for the simpler check.
2. **A direct, live Supabase query** — `_sb.from('suppliers').select('*').is('deleted_at', null)` (the exact call shape `refreshSupFromSupabase()` already makes) — treating "at least one non-deleted Supplier row exists in Supabase" as proof migration has run. **Chosen.**

Option 2 is correct for the property that actually matters here: this check must hold across every device sharing the same Supabase project (that's the entire point of Cloud Data), and a live query against the shared database is authoritative in a way no local flag can be — `st_cloud_migration_ts` (localStorage) is per-browser and would wrongly block a second device that never ran the migration itself but is looking at an already-migrated project.

**Round-1 spec-gate finding (B3), fixed:** the live-only check above was originally shipped as the sole mechanism, with a "known, accepted limitation" note claiming a zero-Supplier install blocking Contact migration forever was narrow. The reviewer correctly rejected that framing on the Contact schema's own terms: `saveCon()`'s `status` values are `lead`/`qualified`-first (`index.html:11428`), `supplierId` is nullable, and `openSupConPicker()` (`index.html:5337-5339`) already assumes a substantial fraction of real Contacts carry no Supplier link at all — a sales/lead-tracking business with zero supplier-side sourcing is a normal shape for this domain model, not an edge case, and such a business would have no escape hatch short of creating a fake Supplier purely to satisfy the gate. The fix combines the live check with the local marker `migrateSuppliersBuyersToSupabase()` already writes unconditionally today (`index.html:5559`, regardless of Supplier count), rather than treating them as mutually exclusive options:

```js
async function isSupplierMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_cloud_migration_ts')) return true;
  var result = await _sb.from('suppliers').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
```

This closes the zero-Supplier lockout on the device that actually ran the migration (using state that already exists today, no new schema) while leaving the live-query fallback fully intact for the case it was chosen to solve: a second device that never ran the Supplier migration locally, looking at an already-migrated project with real Supplier rows in Supabase. The only remaining residual (a zero-Supplier install *and* a different device that never ran the migration locally) is genuinely narrow, unlike the original unqualified claim.

**Round-2 spec-gate finding (new blocking, fixed): the local marker is not scoped to a Supabase *project* — it can outlive the project it was true for.** `restoreFromMigrationArchive()` (`index.html:5567-5577`) restores Suppliers/Buyers and disconnects Cloud Data, but never removes `st_cloud_migration_ts`; neither it nor `saveSbConfig()` bind the marker to any project identity. Concretely reachable without ever touching the restore button at all: a device migrates Suppliers to project P (marker set), then an operator later reconfigures Cloud Data to a *different*, empty project Q via `saveSbConfig()` (a plausible real scenario — fixing a misconfigured project, moving staging→prod). `isSupplierMigrationComplete()` now returns `true` from the stale marker alone, without ever querying Q. Line Item is incidentally protected by the §2.5 pre-flight `supId`-resolution check (added for A2), which queries the *actually-connected* project and blocks cleanly — but **Contact had no equivalent check**, so a Contact carrying a real (non-null) `supplierId` UUID from project P would be inserted against project Q's `contacts` table, violate its `supplier_id` FK (referencing Q's `suppliers`, which has no row with P's UUID), and abort the migration mid-loop with the same "not auto-rolled-back" partial-write exposure A2 was built to close off for Line Items.

Two fixes, closing both the root cause and the specific failure mode it enables:

1. **`restoreFromMigrationArchive()` now also clears the marker on restore** (`index.html:5567-5577`) — the one already-shipped function this SPEC's own reasoning traces the staleness to:

```js
function restoreFromMigrationArchive() {
  var archS = localStorage.getItem('st_s_pre_migration'), archB = localStorage.getItem('st_bu_pre_migration');
  if (!archS || !archB) { toast('No migration archive available to restore.'); return; }
  if (!confirm('Restore Suppliers and Buyers to their state immediately before the Supabase migration, and disconnect Cloud Data?\n\nThis does not affect Quotes, POs, Line Items, Invoices, or Contacts, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect later.')) return;
  localStorage.setItem(K.s, archS);
  localStorage.setItem(K.bu, archB);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_cloud_migration_ts'); // (new line) the restore undid the migration this marker attests to — a fresh Supplier migration (to this or any other project) must re-earn it
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

2. **`migrateContactsToSupabase()` gets the same defense-in-depth pre-flight check A2 gave Line Items** — this is the fix that actually closes the failure regardless of *how* the marker went stale (restore is only one path; a bare reconfiguration via `saveSbConfig()` without ever touching restore is another, and (1) alone cannot catch that one). See §2.6.

---

## 1. New SQL migration: `supabase/migrations/0002_line_items_contacts.sql`

Follows `0001_suppliers_buyers.sql`'s exact pattern (uuid PK, soft-delete via `deleted_at`, `authenticated`-only RLS, no delete policy). Two deliberate departures, both required by REQ-CLOUD-002e: **no** unique index on `line_items.sku`, and **no** uniqueness constraint of any kind on `contacts` (email or name) — Contact's dedup stays the existing soft, client-side, edit-time check. `"desc"` is quoted because `DESC` is a reserved SQL keyword.

```sql
-- SPEC-CLOUD-002: extends the Cloud Data shared-database layer (SPEC-CLOUD-001)
-- to Line Item and Contact.
--
-- Deliberately NOT following 0001's unique-name-index pattern for either table:
-- line_items.sku is non-unique by design (REQ-CLOUD-002e; docs/data-model.md:37),
-- and Contact has no hard uniqueness constraint today (soft email dedup only,
-- CON-GAP-002) which this migration must not silently turn into a hard one.

create table line_items (
  id             uuid primary key default gen_random_uuid(),
  num            text not null unique,
  sku            text,
  "desc"         text,
  specs          text,
  hs             text,
  sup_id         uuid not null references suppliers(id),
  uom            text,
  cost           numeric,
  price          numeric,
  currency       text,
  notes          text,
  dg             boolean not null default false,
  dims           jsonb,
  price_history  jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create table contacts (
  id                 uuid primary key default gen_random_uuid(),
  num                text not null unique,
  name               text not null,
  email              text not null,
  phone              text,
  company            text,
  status             text,
  source             text,
  gdpr_basis         text,
  created_at         timestamptz not null default now(),
  last_contacted_at  timestamptz,
  enquiries          jsonb not null default '[]'::jsonb,
  notes              text,
  supplier_id        uuid references suppliers(id),
  role               text,
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table line_items enable row level security;
alter table contacts   enable row level security;

create policy "authenticated read" on line_items for select using (auth.role() = 'authenticated');
create policy "authenticated write" on line_items for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on line_items for update using (auth.role() = 'authenticated');
create policy "authenticated read" on contacts for select using (auth.role() = 'authenticated');
create policy "authenticated write" on contacts for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on contacts for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
```

`sup_id` on `line_items` is `not null references suppliers(id)`, matching Line Item's unconditional client-side requirement (`vLI()`); `supplier_id` on `contacts` is nullable, matching its optional FK.

---

## 2. `index.html` changes

### 2.1 `initCloudDataLayer()` — wire in the two new refreshes

Current (`index.html:5421-5428`):

```js
async function initCloudDataLayer() {
  initSbClient();
  if (!_sb) return;
  if (await ensureSbAuth()) {
    await refreshSupFromSupabase();
    await refreshBuyFromSupabase();
  }
}
```

New:

```js
async function initCloudDataLayer() {
  initSbClient();
  if (!_sb) return;
  if (await ensureSbAuth()) {
    await refreshSupFromSupabase();
    await refreshBuyFromSupabase();
    await refreshLIFromSupabase();
    await refreshConFromSupabase();
  }
}
```

### 2.2 New `refreshLIFromSupabase()` and `refreshConFromSupabase()`

Insert immediately after `refreshBuyFromSupabase()` closes (`index.html:5459`), before the new `isSupplierMigrationComplete()` from §0.

`refreshLIFromSupabase()` cannot be a naive full-replace like `refreshSupFromSupabase()`: `invoiceRefs[]` is a local-only reverse index (AC-2 — never migrated to a Supabase column, must carry forward unchanged) that would otherwise be silently wiped on every refresh, not just the first one. It is preserved by keying the *current* in-memory `DB.li` by `id` before replacing:

**Round-1 spec-gate finding (B1), fixed — both functions must refuse to overwrite un-migrated local data.** `_sb` is a single, global, per-install flag (`initSbClient()`, `index.html:5385-5387`) — it goes truthy the moment *any* Cloud Data entity is configured, not per-entity. Wiring these two refreshes unconditionally into `initCloudDataLayer()` (§2.1) means every existing CLOUD-001 adopter (anyone who has ever configured Cloud Data for Supplier/Buyer) would have `refreshLIFromSupabase()`/`refreshConFromSupabase()` fire on their very next reload after this SPEC ships — against the brand-new, still-empty `line_items`/`contacts` tables this SPEC's own migration creates — silently overwriting real local Line Item/Contact data with `[]` before the operator ever touches the new "Migrate Line Items/Contacts to Cloud" buttons (§2.8). Both functions now refuse to replace local data unless either this device has actually run the migration (the local marker, set unconditionally at the *start* of the corresponding migrate function's archive step — see §2.5/§2.6 — before it's ever safe to overwrite), or there's nothing local to lose:

```js
async function refreshLIFromSupabase() {
  if (!_sb) return;
  if (DB.li.length > 0 && !localStorage.getItem('st_li_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('line_items').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Line Items from Cloud Data.'); return; }
  var oldById = {};
  DB.li.forEach(function(l){ oldById[l.id] = l; });
  DB.li = result.data.map(function(row){
    var prev = oldById[row.id];
    return {
      id: row.id, num: row.num, sku: row.sku, desc: row.desc, specs: row.specs, hs: row.hs,
      supId: row.sup_id, uom: row.uom, cost: row.cost, price: row.price, cur: row.currency,
      notes: row.notes, dg: !!row.dg, dims: row.dims || null, priceHistory: row.price_history || [],
      invoiceRefs: prev ? (prev.invoiceRefs || []) : []
    };
  });
  sv(K.l, DB.li);
  // Round-3 spec-gate fix: a fresh/second device reaching this point (DB.li was empty,
  // so the guard above let it through) has just loaded real Supabase-shaped Line Items,
  // but never itself ran migrateLineItemsToSupabase() — so the marker other code reads
  // to mean "DB.li on THIS device currently holds Supabase ids" (§2.11) would otherwise
  // stay wrongly absent. Set it here too, once, if not already set.
  if (!localStorage.getItem('st_li_cloud_migration_ts')) localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  rLI();
}

async function refreshConFromSupabase() {
  if (!_sb) return;
  if (DB.con.length > 0 && !localStorage.getItem('st_con_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('contacts').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Contacts from Cloud Data.'); return; }
  DB.con = result.data.map(function(row){
    return {
      id: row.id, num: row.num, name: row.name, email: row.email, phone: row.phone,
      company: row.company, status: row.status, source: row.source, gdprBasis: row.gdpr_basis,
      createdAt: row.created_at, lastContactedAt: row.last_contacted_at || '',
      enquiries: row.enquiries || [], notes: row.notes, supplierId: row.supplier_id, role: row.role || ''
    };
  });
  sv(K.co, DB.con);
  if (!localStorage.getItem('st_con_cloud_migration_ts')) localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString()); // same reasoning as Line Item above
  rCon();
}
```

Contact needs no such preservation merge — every one of its 15 fields is migrated (AC-3), there is no local-only supplementary field.

**Why the guard is safe for a second device joining an already-migrated project:** a device that has never held any local Line Items/Contacts (`DB.li.length === 0`/`DB.con.length === 0`, e.g. a fresh browser or a device that only ever used other entities) has nothing to lose, so the guard's `length > 0` condition is false and the refresh proceeds — correctly loading the real Cloud Data. The guard only blocks the one dangerous case: real local data present, with no local record that this device's own copy has ever been reconciled against Supabase for that entity.

### 2.3 `saveLI()` / `delLI()` (`index.html:5735-5770`) — full replacement

The price-history-append and dimension-normalization logic must run identically regardless of `_sb`, so it moves ahead of the branch; only the persistence step differs, mirroring `saveSup()`'s exact mutually-exclusive shape.

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

  if (_sb) {
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
    closeM('ov-li');
    await refreshLIFromSupabase();
    audit(EI.l?'UPDATE':'CREATE','li', result.data.id, result.data);
    toast('Line item saved'); renderOnboarding();
    return;
  }

  var li={id:EI.l||uid(),num:existing?existing.num:nextRefNum(DB.li,'LI'),sku:G('lf-s').value.trim(),desc:G('lf-d').value.trim(),specs:G('lf-sp').value.trim(),hs:G('lf-hs').value.trim(),supId:G('lf-sup').value,uom:G('lf-u').value.trim(),cost:newCost,price:newPrice,cur:G('lf-cur').value,notes:G('lf-nt').value.trim(),priceHistory:history,invoiceRefs:existing?(existing.invoiceRefs||[]):[],dims:dims,dg:dg};
  if(EI.l){var i=DB.li.findIndex(function(x){return x.id===EI.l;});if(i>-1)DB.li[i]=li;}else DB.li.push(li);
  sv(K.l,DB.li); closeM('ov-li'); rLI(); audit(EI.l?'UPDATE':'CREATE','li',li.id,li); toast('Line item saved'); renderOnboarding(); await syncEnt('li',li).catch(function(){});
}

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

  if (_sb) {
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

`_sb` branches never reach `syncEnt('li',...)`/`delEnt('li',...)` (AC-5) — same mutual-exclusivity as Supplier/Buyer.

### 2.4 `saveCon()` / `delCon()` (`index.html:11398-11488`) — full replacement

`saveCon()`'s early duplicate-merge branch (triggered by `confirm()` on a matching email, before the main record is even built) also needs `_sb`-awareness, since it currently persists via a bare `sv(K.co, DB.con)`. Also becomes `async` (it already calls nothing async today, but now needs `ensureSbAuth()`/Supabase calls); `delCon()` likewise becomes `async`. Neither has any existing caller that awaits them — both are invoked as plain `onclick` handlers already, consistent with `saveLI`/`saveSup`'s existing async-handler pattern.

**Round-1 spec-gate finding (A1), fixed:** the merge branch originally mutated `dup.enquiries`/`dup.lastContactedAt` in place before the `await _sb.from(...).update(...)` call. On a Supabase error, the mutation would have been left standing in memory — never persisted (no `sv()` on the `_sb` path) and never rolled back, a failure mode the fully-synchronous original branch never had. The merge payload is now built into local variables (`mergedEnquiries`/`mergedLastContactedAt`) and `dup` is only mutated on the local (non-`_sb`) path, where mutate-then-`sv()` was always inseparable; the `_sb` path never mutates `dup` at all since `refreshConFromSupabase()` replaces `DB.con` wholesale from Supabase immediately after a successful update.

```js
async function saveCon() {
  var name   = G('ct-name').value.trim();
  var email  = G('ct-email').value.trim();
  var status = G('ct-status').value;
  if (!name)  { vErr('ct-name',  'Name is required');  return; }
  if (!email) { vErr('ct-email', 'Email is required'); return; }
  vOk('ct-name'); vOk('ct-email');

  var enqSummary = G('ct-enq-summary').value.trim();

  if (!EI.co) {
    var dup = DB.con.find(function(c){
      return c.email.toLowerCase() === email.toLowerCase();
    });
    if (dup) {
      var doMerge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
      if (doMerge) {
        var mergedEnquiries = (dup.enquiries || []).slice();
        if (enqSummary) mergedEnquiries.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });
        var mergedLastContactedAt = new Date().toISOString();
        if (_sb) {
          if (!(await ensureSbAuth())) return;
          var mergeResult = await _sb.from('contacts').update({ enquiries: mergedEnquiries, last_contacted_at: mergedLastContactedAt }).eq('id', dup.id);
          if (mergeResult.error) { toast('Merge failed: ' + mergeResult.error.message); return; }
          await refreshConFromSupabase();
        } else {
          dup.enquiries = mergedEnquiries;
          dup.lastContactedAt = mergedLastContactedAt;
          sv(K.co, DB.con);
        }
        closeM('ov-con');
        rCon();
        toast('Enquiry merged into existing contact');
        return;
      }
      if (!confirm('Create a separate contact record for this email address anyway?')) return;
    }
  }

  var gdprBasis = (['lead','qualified'].indexOf(status) >= 0) ? 'pre_contract' : 'legitimate_interests';
  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? ((existC.enquiries || []).slice()) : [];
  if (enqSummary) enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });

  var phone = G('ct-phone').value.trim(), company = G('ct-company').value.trim();
  var source = G('ct-source').value, notes = G('ct-notes').value.trim();
  var supplierId = G('ct-sup').value || null;
  var role = supplierId ? 'supplier_contact' : '';
  var createdAt = existC ? (existC.createdAt || new Date().toISOString()) : new Date().toISOString();
  var lastContactedAt = enqSummary ? new Date().toISOString() : (existC ? (existC.lastContactedAt || '') : '');
  var prevStatus = existC ? existC.status : null;

  if (_sb) {
    if (!(await ensureSbAuth())) return;
    var row = {
      name: name, email: email, phone: phone, company: company, status: status, source: source,
      gdpr_basis: gdprBasis, created_at: createdAt, last_contacted_at: lastContactedAt || null,
      enquiries: enqs, notes: notes, supplier_id: supplierId, role: role
    };
    var result;
    if (EI.co) {
      result = await _sb.from('contacts').update(row).eq('id', EI.co).select().single();
    } else {
      row.num = nextRefNum(DB.con, 'CON');
      result = await _sb.from('contacts').insert(row).select().single();
    }
    if (result.error) { toast('Save failed: ' + result.error.message); return; }
    closeM('ov-con');
    await refreshConFromSupabase();
    if (prevStatus !== null && prevStatus !== status) {
      logEv('contact', result.data.id, 'status_changed', 'Status changed to ' + status, 'user');
    } else if (enqSummary) {
      logEv('contact', result.data.id, 'note_added', 'Enquiry note added', 'user');
    } else {
      logEv('contact', result.data.id, EI.co?'updated':'created', EI.co?'Contact details updated':'Contact created', 'user');
    }
    toast('Contact saved');
    return;
  }

  var con = {
    id:              EI.co || uid(),
    num:             existC ? existC.num : nextRefNum(DB.con, 'CON'),
    name:            name,
    email:           email,
    phone:           phone,
    company:         company,
    status:          status,
    source:          source,
    gdprBasis:       gdprBasis,
    createdAt:       createdAt,
    lastContactedAt: lastContactedAt,
    enquiries:       enqs,
    notes:           notes,
    supplierId:      supplierId,
    role:            role
  };

  if (EI.co) {
    var idx = DB.con.findIndex(function(x){ return x.id === EI.co; });
    if (idx >= 0) DB.con[idx] = con; else DB.con.push(con);
    if (prevStatus !== null && prevStatus !== con.status) {
      logEv('contact', con.id, 'status_changed', 'Status changed to ' + con.status, 'user');
    } else if (enqSummary) {
      logEv('contact', con.id, 'note_added', 'Enquiry note added', 'user');
    } else {
      logEv('contact', con.id, 'updated', 'Contact details updated', 'user');
    }
  } else {
    DB.con.push(con);
    logEv('contact', con.id, 'created', 'Contact created', 'user');
  }
  sv(K.co, DB.con);
  syncEnt('co', con).catch(function(){});
  closeM('ov-con');
  rCon();
  toast('Contact saved');
}

async function delCon(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;

  if (_sb) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('contacts').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    DB.ord.forEach(function(o){
      if (o.contactId === id) o.contactId = null;
      (o.lines||[]).forEach(function(l){
        (l.rfqResponses||[]).forEach(function(r){ if (r.contactId === id) r.contactId = null; });
      });
    });
    sv(K.ord, DB.ord);
    logEv('contact', id, 'deleted', 'Contact deleted', 'user');
    await refreshConFromSupabase();
    toast('Contact deleted');
    return;
  }

  DB.con = DB.con.filter(function(c){ return c.id !== id; });
  DB.ord.forEach(function(o){
    if (o.contactId === id) o.contactId = null;
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (r.contactId === id) r.contactId = null; });
    });
  });
  sv(K.co, DB.con);
  sv(K.ord, DB.ord);
  logEv('contact', id, 'deleted', 'Contact deleted', 'user');
  rCon();
  toast('Contact deleted');
}
```

Note `delCon()`'s local branch never called `delEnt('co', id)` even before this SPEC (verified by direct read of the shipped code) — that pre-existing quirk is preserved unchanged (AC-9: zero regressions), not fixed here since it is out of REQ-CLOUD-002's scope.

### 2.5 `migrateLineItemsToSupabase()` — new function

Insert immediately after `migrateSuppliersBuyersToSupabase()` closes (`index.html:5565`).

```js
async function migrateLineItemsToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;
  if (!(await isSupplierMigrationComplete())) { toast('Migrate Suppliers to Cloud Data first — every Line Item requires a Supplier link.'); return; }

  // REQ-CLOUD-002g: sku is non-unique by design (REQ-CLOUD-002e) — no field exists
  // to pre-flight-scan for conflicts. Documented no-op, not an oversight.

  // Advisory A2 (spec-gate round 1), fixed: line_items.sup_id is NOT NULL + FK-constrained
  // (§1), so a single local Line Item whose supId never got remapped by
  // migrateSuppliersBuyersToSupabase()'s sweep (e.g. it pointed at a Supplier deleted
  // before that migration ran) would otherwise abort the insert loop below mid-batch,
  // after some rows are already irreversibly inserted (the documented "not
  // auto-rolled-back" behavior). Check every supId resolves to a real Supabase Supplier
  // id up front, so a bad reference is caught cleanly with zero inserts made.
  var knownSupIds = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (knownSupIds.error) { toast('Could not verify Supplier links before migrating: ' + knownSupIds.error.message); return; }
  var knownSupIdSet = {};
  knownSupIds.data.forEach(function(s){ knownSupIdSet[s.id] = true; });
  var orphanLI = DB.li.find(function(l){ return !knownSupIdSet[l.supId]; });
  if (orphanLI) { toast('Migration blocked: Line Item ' + (orphanLI.sku||orphanLI.num) + ' references a Supplier not found in Cloud Data. Fix or reassign its Supplier link before migrating.'); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var liIdMap = {};
  for (var i = 0; i < DB.li.length; i++) {
    var l = DB.li[i];
    var result = await _sb.from('line_items').insert({
      num: l.num, sku: l.sku, "desc": l.desc, specs: l.specs, hs: l.hs,
      sup_id: l.supId, uom: l.uom, cost: l.cost, price: l.price, currency: l.cur,
      notes: l.notes, dg: !!l.dg, dims: l.dims || null, price_history: l.priceHistory || []
    }).select().single();
    if (result.error) { toast('Migration failed on line item ' + (l.sku||l.num) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    liIdMap[l.id] = result.data.id;
  }

  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  DB.po.forEach(function(po){ (po.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  // Quote.lines[].lid is confirmed dead (never populated by any code path, index.html:8794-8796) —
  // checked anyway, never skipped, per that comment's own stated convention.
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(ql){ if (liIdMap[ql.lid]) ql.lid = liIdMap[ql.lid]; }); });
  sv(K.i, DB.inv); sv(K.p, DB.po); sv(K.qt, DB.qt);

  // REQ-CLOUD-002d: archive the true pre-migration snapshot BEFORE remapping DB.li's own ids below
  localStorage.setItem('st_li_pre_migration', localStorage.getItem(K.l));
  localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());

  // Remap DB.li's own ids in place so refreshLIFromSupabase()'s invoiceRefs-preserving
  // merge (keyed by id) finds a match on the very first post-migration refresh.
  DB.li.forEach(function(l){ if (liIdMap[l.id]) l.id = liIdMap[l.id]; });
  sv(K.l, DB.li);

  await refreshLIFromSupabase();
  if (G('cfg-sb-li-restore-btn')) G('cfg-sb-li-restore-btn').style.display = '';
  toast('Line Item migration complete. Pre-migration data archived for 30 days.');
}
```

### 2.6 `migrateContactsToSupabase()` — new function

Insert immediately after `migrateLineItemsToSupabase()` closes.

```js
async function migrateContactsToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;
  if (!(await isSupplierMigrationComplete())) { toast('Migrate Suppliers to Cloud Data first — Contact migration requires Supplier links to already be resolvable in Cloud Data.'); return; }

  // REQ-CLOUD-002g: no hard uniqueness constraint exists on Contact email/name
  // (REQ-CLOUD-002e) — no field exists to pre-flight-scan for conflicts.
  // Documented no-op, same reasoning as Line Item.

  // Round-2 spec-gate finding (new blocking, §0), fixed: isSupplierMigrationComplete()'s
  // local-marker branch can return true from a stale marker left over from a DIFFERENT,
  // previously-connected Supabase project (e.g. after a plain reconfiguration via
  // saveSbConfig() that doesn't go through restoreFromMigrationArchive() at all). A Contact
  // carrying a real supplierId from that other project would otherwise violate contacts'
  // supplier_id FK against the currently-connected project and abort the loop mid-batch.
  // Mirrors the Line Item pre-flight check (A2, §2.5) exactly, verified against the
  // ACTUALLY-CONNECTED project regardless of what the marker claims.
  var knownSupIdsForCon = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (knownSupIdsForCon.error) { toast('Could not verify Supplier links before migrating: ' + knownSupIdsForCon.error.message); return; }
  var knownSupIdSetForCon = {};
  knownSupIdsForCon.data.forEach(function(s){ knownSupIdSetForCon[s.id] = true; });
  var orphanCon = DB.con.find(function(c){ return c.supplierId && !knownSupIdSetForCon[c.supplierId]; });
  if (orphanCon) { toast('Migration blocked: Contact ' + orphanCon.name + ' references a Supplier not found in Cloud Data. Fix or clear its Supplier link before migrating.'); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var conIdMap = {};
  for (var i = 0; i < DB.con.length; i++) {
    var c = DB.con[i];
    var result = await _sb.from('contacts').insert({
      num: c.num, name: c.name, email: c.email, phone: c.phone, company: c.company,
      status: c.status, source: c.source, gdpr_basis: c.gdprBasis, created_at: c.createdAt,
      last_contacted_at: c.lastContactedAt || null, enquiries: c.enquiries || [], notes: c.notes,
      supplier_id: c.supplierId || null, role: c.role || ''
    }).select().single();
    if (result.error) { toast('Migration failed on contact ' + c.name + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    conIdMap[c.id] = result.data.id;
  }

  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.ord.forEach(function(o){
    if (conIdMap[o.contactId]) o.contactId = conIdMap[o.contactId];
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (conIdMap[r.contactId]) r.contactId = conIdMap[r.contactId]; });
    });
  });
  DB.qt.forEach(function(q){ if (conIdMap[q.sourceContactId]) q.sourceContactId = conIdMap[q.sourceContactId]; });
  sv(K.ord, DB.ord); sv(K.qt, DB.qt);

  localStorage.setItem('st_con_pre_migration', localStorage.getItem(K.co));
  localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());

  await refreshConFromSupabase();
  if (G('cfg-sb-con-restore-btn')) G('cfg-sb-con-restore-btn').style.display = '';
  toast('Contact migration complete. Pre-migration data archived for 30 days.');
}
```

Contact needs no own-id remap step (unlike Line Item) — it has no local-only supplementary field for a subsequent refresh to preserve.

### 2.7 Archive/rollback extensions

`restoreFromMigrationArchive()` (Supplier/Buyer) is left untouched. Two new sibling functions, inserted after it (`index.html:5577`), each independently restorable since Line Item and Contact migrate independently.

**Advisory A3 (spec-gate round 1), noted:** REQ-CLOUD-002d's literal wording asks for "an extension of `restoreFromMigrationArchive()`." This SPEC deliberately deviates to two sibling functions instead of one combined function, because Line Item and Contact each migrate independently — a combined function would need to handle every partial-archive-present permutation (only Line Item migrated, only Contact, both, neither) inside one control flow, which is materially more complex than three independent, single-purpose restore functions that each do one thing. The intent of REQ-CLOUD-002d (archive-not-delete, restorable, disconnects Cloud Data on restore) is fully met; only the literal "one function" framing is not.

**Advisory A4 (spec-gate round 1), fixed — restore copy now discloses the global-disconnect consequence explicitly.** Restoring just one entity's archive still clears `SS.supabaseUrl`/`SS.supabaseAnonKey` globally (per REQ-CLOUD-002d, reusing `SPEC-CLOUD-001-v4`'s fix), which also drops the live connection for every *other* entity currently on Cloud Data (Suppliers/Buyers, and whichever of Line Item/Contact wasn't the one being restored) — not just the one being restored. The confirm() copy now says so plainly:

```js
function restoreLIMigrationArchive() {
  var arch = localStorage.getItem('st_li_pre_migration');
  if (!arch) { toast('No Line Item migration archive available to restore.'); return; }
  if (!confirm('Restore Line Items to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Contacts, or any document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Line Items — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.l, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_li_cloud_migration_ts'); // the restore undid this device's Line Item migration — re-earning it prevents a stale marker from later letting refreshLIFromSupabase() overwrite the just-restored data against a different/reconfigured project
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}

function restoreConMigrationArchive() {
  var arch = localStorage.getItem('st_con_pre_migration');
  if (!arch) { toast('No Contact migration archive available to restore.'); return; }
  if (!confirm('Restore Contacts to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, or any document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Contacts — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.co, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_con_cloud_migration_ts'); // same reasoning as the Line Item restore above
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

**Round-2 spec-gate finding, applied proactively:** the same stale-marker-outliving-its-project reasoning that motivated clearing `st_cloud_migration_ts` in `restoreFromMigrationArchive()` (§0) applies identically here — without clearing `st_li_cloud_migration_ts`/`st_con_cloud_migration_ts` on their own restores, a subsequent reconnect to a different project would have the §2.2 B1 guard see a stale marker and wrongly permit `refreshLIFromSupabase()`/`refreshConFromSupabase()` to overwrite the just-restored real local data. Both restore functions now clear their own marker.

Each disconnects Cloud Data on restore, reusing the exact fix `SPEC-CLOUD-001-v4` proved necessary (REQ-CLOUD-002d) — otherwise the next `initCloudDataLayer()` would silently re-clobber the restore.

**Round-1 spec-gate finding (B4), fixed — the new restore buttons must reappear after a reload, not just inline during the same migration session.** The existing Supplier/Buyer restore button's visibility survives a reload because `rCfg()` (`index.html:9890`, re-run every time the Settings tab renders) re-checks `st_cloud_migration_ts` on every render: `if(G('cfg-sb-restore-btn')) G('cfg-sb-restore-btn').style.display = localStorage.getItem('st_cloud_migration_ts') ? '' : 'none';`. §2.5/§2.6 only set `style.display=''` inline inside the migrate functions themselves (same-session feedback) with no equivalent added to `rCfg()` — so after any reload, both new buttons silently revert to the HTML's default `display:none` and stay hidden even though a valid, restorable archive still exists. Add two equivalent lines to `rCfg()` (`index.html:9890`), immediately after the existing Supplier/Buyer line:

```js
if(G('cfg-sb-restore-btn')) G('cfg-sb-restore-btn').style.display = localStorage.getItem('st_cloud_migration_ts') ? '' : 'none';
if(G('cfg-sb-li-restore-btn')) G('cfg-sb-li-restore-btn').style.display = localStorage.getItem('st_li_cloud_migration_ts') ? '' : 'none';
if(G('cfg-sb-con-restore-btn')) G('cfg-sb-con-restore-btn').style.display = localStorage.getItem('st_con_cloud_migration_ts') ? '' : 'none';
```

`cleanupExpiredMigrationArchive()` (`index.html:5579-5588`) — extend to also expire the two new archive pairs, each independently timed off its own timestamp key:

```js
function cleanupExpiredMigrationArchive() {
  var ts = localStorage.getItem('st_cloud_migration_ts');
  if (ts && (Date.now() - new Date(ts).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_s_pre_migration');
    localStorage.removeItem('st_bu_pre_migration');
    localStorage.removeItem('st_cloud_migration_ts');
  }
  var liTs = localStorage.getItem('st_li_cloud_migration_ts');
  if (liTs && (Date.now() - new Date(liTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_li_pre_migration');
    localStorage.removeItem('st_li_cloud_migration_ts');
  }
  var conTs = localStorage.getItem('st_con_cloud_migration_ts');
  if (conTs && (Date.now() - new Date(conTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_con_pre_migration');
    localStorage.removeItem('st_con_cloud_migration_ts');
  }
}
```

### 2.8 Settings UI (`index.html:766-777`, inside the Cloud Data card)

Two new cards inserted immediately after the existing "Cloud Data (Suppliers & Buyers)" card and before "Accounting Export — Field Mapping Reference":

```html
<div class="card">
  <div class="ct">Cloud Data (Line Items)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="migrateLineItemsToSupabase()">Migrate Line Items to Cloud</button>
    <button class="btn btn-g" id="cfg-sb-li-restore-btn" style="display:none;" onclick="restoreLIMigrationArchive()">Restore Pre-Migration Line Items</button>
  </div>
  <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Suppliers to already be migrated to Cloud Data above — every Line Item requires a Supplier link. Uses the same Supabase connection configured above.</p>
</div>
<div class="card">
  <div class="ct">Cloud Data (Contacts)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="migrateContactsToSupabase()">Migrate Contacts to Cloud</button>
    <button class="btn btn-g" id="cfg-sb-con-restore-btn" style="display:none;" onclick="restoreConMigrationArchive()">Restore Pre-Migration Contacts</button>
  </div>
  <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Suppliers to already be migrated to Cloud Data above, even for Contacts with no Supplier link (see docs/architecture-data-model-v1.md §1 for why). Uses the same Supabase connection configured above.</p>
</div>
```

### 2.9 `pullAll()`'s Sheets-sync exclusion (`index.html:4375-4377` and `index.html:4454-4459`)

**Round-1 spec-gate finding (B2), fixed — round 2 found the fix was applied to only one of two parallel arrays.** `pullAll()` contains **two** separate `_sb`-filtered entity lists, confirmed by direct re-read: `_simpleEntsForBatch` (`index.html:4375-4377`), which decides what's *requested* in the batched `pull_all` call, and `simpleEnts` (`index.html:4454-4459`), which decides what's actually *merged* into `DB`. Supplier's existing exclusion filters **both**. The round-1 fix below only touched the second (merge-gating) array — it doesn't reintroduce the overwrite race the fix targets, since the merge loop is what actually writes `DB.li`/`DB.con`, but it left Line Item/Contact being requested from Sheets indefinitely after migration, half of Supplier's own precedent. Both arrays are now extended identically.

`index.html:4375-4377`, current code:

```js
var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
```

New:

```js
var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
```

`index.html:4454-4459`, current code:

```js
var simpleEnts = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
// Suppliers are cloud-authoritative once Cloud Data is configured (SPEC-CLOUD-001) — pulling them from
// Sheets here would race the fire-and-forget Supabase refresh in initCloudDataLayer(), with whichever
// resolves last silently overwriting DB.sup/localStorage. Excluded entirely when _sb is configured;
// zero change to this loop when it isn't.
if (_sb) simpleEnts = simpleEnts.filter(function(e){ return e !== 'sup'; });
```

Only `'sup'` is excluded. This SPEC introduces the exact same class of concurrent, fire-and-forget, full-replace Supabase refresh for `'li'`/`'co'` (`refreshLIFromSupabase()`/`refreshConFromSupabase()`, §2.2) — left unaddressed, any install with both Sheets sync and Cloud Data configured (a normal transitional state during a phased migration) would have `pullAll()`'s Sheets pull for Line Item/Contact race the new Supabase refreshes for the same two entities.

The existing Supplier exclusion is keyed purely on `_sb` being truthy — not on whether Supplier's own migration has completed — because CLOUD-001 only ever had one entity-group behind that flag. Line Item and Contact are independently migratable, so reusing bare `_sb` truthiness for them would prematurely kill Sheets sync for an entity that hasn't actually moved to Cloud Data yet. Gate the exclusion on the same per-entity local marker the rest of this SPEC uses (`st_li_cloud_migration_ts`/`st_con_cloud_migration_ts`), matching Supplier's own precedent of using a coarse, local, non-live signal for this specific decision (Supplier's exclusion is likewise not live-checked):

```js
var simpleEnts = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
// Suppliers are cloud-authoritative once Cloud Data is configured (SPEC-CLOUD-001) — pulling them from
// Sheets here would race the fire-and-forget Supabase refresh in initCloudDataLayer(), with whichever
// resolves last silently overwriting DB.sup/localStorage. Excluded entirely when _sb is configured;
// zero change to this loop when it isn't.
if (_sb) simpleEnts = simpleEnts.filter(function(e){ return e !== 'sup'; });
// Line Item / Contact (SPEC-CLOUD-002): same race, but these migrate independently of
// Supplier/Buyer and of each other, so exclusion is gated on each entity's own local
// migration marker rather than bare _sb truthiness — otherwise Sheets sync would stop
// for an entity that hasn't actually moved to Cloud Data yet.
if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'li'; });
if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'co'; });
```

**Known, accepted residual** (mirroring a limitation already implicitly accepted in the shipped Supplier exclusion): a second device that has never locally run the Line Item/Contact migration will still pull that entity from Sheets even after another device has migrated it to Supabase, until that second device's own migration marker is set (e.g. by visiting the Cloud Data settings after the project is already migrated — out of scope to fully solve here; REQ-CLOUD-002 §3 explicitly excludes building a general migration-status registry).

### 2.10 `migrateSuppliersBuyersToSupabase()` — unchanged

Confirmed no changes are needed to the already-shipped CLOUD-001 function itself; the precondition mechanism (§0) reads Supabase live rather than any marker it would need to write.

### 2.11 Round-3 spec-gate finding (blocking), fixed — five existing call sites bypass `saveCon()`/`delCon()` entirely and must be made `_sb`-aware too

The round-3 reviewer traced every direct `DB.con` mutation in the codebase and found five live, everyday UI paths that write Contact fields and persist via a bare `sv(K.co, DB.con)` — never going through `saveCon()`/`delCon()` at all, so none of this SPEC's `_sb` branches (§2.4) ever run for them:

- `unlinkSupCon()` (`index.html:5325-5335`) — the "Unlink" button on a Supplier's contact list.
- `openSupConPicker()` (`index.html:5336-5355`) — the "+ Link Contact" flow on a Supplier.
- `delSup()`'s own Contact-nulling cascade (`index.html:5645-5646`, inside its already-shipped `_sb` branch) — nulls `supplierId`/`role` on every Contact linked to a deleted Supplier.
- `saveQte()`'s Contact-to-Quote conversion (`index.html:11254-11263`) — sets `status`/`lastContactedAt` when a Quote is created from a Contact.
- `delQte()`'s Contact status revert (`index.html:11278-11292`) — reverts `status` from `converted` back to `qualified` when that Quote is deleted.

Once Contact is migrated, each of these becomes a silent local-only edit: the next `refreshConFromSupabase()` call (from any Contact/Line-Item cloud operation elsewhere, or simply the next page load) replaces `DB.con` wholesale from Supabase and reverts every one of these edits, since none of them were ever written to the `contacts` table. `delSup()`'s case is the sharpest — it already runs inside an `_sb` branch today (correct when Contact was local-only), and becomes wrong the moment Contact is cloud-backed: a dangling reference to a just-deleted Supplier silently reappears on the Contact after the next refresh.

**Why gating on the `st_con_cloud_migration_ts` marker (not bare `_sb`) is correct here, unlike `saveCon()`/`delCon()`:** these five sites reference an *existing* Contact's `id` directly (`c.id`, `lc.id`) rather than creating a new record or resolving one through `EI.co`. Before Contact has actually migrated, that `id` is a local `uid()`-generated string, not a Supabase UUID — a Supabase `.update(...).eq('id', <local-uid>)` call would match zero rows and return `{error: null}` (no error, no effect), so gating on bare `_sb` here would silently no-op the mutation entirely rather than either applying it locally or erroring loudly. `saveCon()`/`delCon()` don't have this problem in the same way (`saveCon()`'s create path never sends a client-generated `id`; its edit path fails loudly via `.single()` if the id doesn't resolve, matching `saveSup()`'s own already-accepted rough edge for the same scenario). The marker is the right signal specifically because it answers "does `DB.con`'s `id` field on *this device* currently hold Supabase UUIDs or local uids" — which is exactly what determines whether a `.eq('id', ...)` call can possibly match anything. §2.2's refresh functions now set this marker on any successful refresh (not just a migration this device itself ran), so it correctly reflects that state for a second device too.

```js
async function unlinkSupCon(contactId) {
  var c = DB.con.find(function(x){ return x.id === contactId; }); if (!c) return;
  var sup = DB.sup.find(function(s){ return s.id === c.supplierId; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('contacts').update({ supplier_id: null, role: '' }).eq('id', contactId);
    if (result.error) { toast('Unlink failed: ' + result.error.message); return; }
    await refreshConFromSupabase();
  } else {
    c.supplierId = null;
    c.role = '';
    sv(K.co, DB.con);
  }
  logEv('contact', contactId, 'unlinked', 'Unlinked from supplier ' + (sup ? sup.name : '(unknown)'), 'user');
  renderSupContacts();
  rCon();
  toast('Contact unlinked');
}

async function openSupConPicker() {
  var eligible = DB.con.filter(function(c){
    return !c.supplierId || c.supplierId === EI.s;
  });
  if (!eligible.length) { toast('No eligible contacts to link.'); return; }
  var list = eligible.map(function(c, i){ return (i+1) + '. ' + c.name + ' <' + c.email + '>'; }).join('\n');
  var input = prompt('Link a contact to this supplier.\nEnter the number:\n\n' + list);
  if (!input) return;
  var idx = parseInt(input, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= eligible.length) { toast('Invalid selection.'); return; }
  var c = eligible[idx];
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('contacts').update({ supplier_id: EI.s, role: 'supplier_contact' }).eq('id', c.id);
    if (result.error) { toast('Link failed: ' + result.error.message); return; }
    await refreshConFromSupabase();
  } else {
    c.supplierId = EI.s;
    c.role = 'supplier_contact';
    sv(K.co, DB.con);
  }
  var sup = DB.sup.find(function(s){ return s.id === EI.s; });
  logEv('contact', c.id, 'linked', 'Linked to supplier ' + (sup ? sup.name : '(unknown)'), 'user');
  renderSupContacts();
  rCon();
  toast('Contact linked');
}
```

`delSup()`'s existing `_sb` branch (`index.html:5640-5651`) — only its Contact-cascade lines change; the Supplier-side soft-delete above it is untouched:

```js
  if (_sb) {
    if (!(await ensureSbAuth())) return;
    var _delSupR = DB.sup.find(function(s){ return s.id===id; });
    var result = await _sb.from('suppliers').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    var linkedCons = DB.con.filter(function(c){ return c.supplierId === id; });
    if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
      for (var ci = 0; ci < linkedCons.length; ci++) {
        var conResult = await _sb.from('contacts').update({ supplier_id: null, role: '' }).eq('id', linkedCons[ci].id);
        if (conResult.error) { console.warn('[Stackd] delSup: failed to unlink contact ' + linkedCons[ci].id + ' from deleted supplier', conResult.error.message); }
      }
      if (linkedCons.length) await refreshConFromSupabase();
    } else {
      linkedCons.forEach(function(c){ c.supplierId = null; c.role = ''; });
      sv(K.co, DB.con);
    }
    if (_delSupR) logEv('supplier', _delSupR.id, 'deleted', 'Supplier ' + _delSupR.name + ' deleted', 'operator');
    await refreshSupFromSupabase();
    toast('Deleted');
    return;
  }
```

`saveQte()`'s Contact-to-Quote conversion (`index.html:11254-11263`):

```js
  if (cConvertId) {
    var convC = DB.con.find(function(x){ return x.id === cConvertId; });
    if (convC && convC.status !== 'converted') {
      if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
        var convResult = await _sb.from('contacts').update({ status: 'converted', last_contacted_at: new Date().toISOString() }).eq('id', convC.id);
        if (!convResult.error) await refreshConFromSupabase();
      } else {
        convC.status = 'converted';
        convC.lastContactedAt = new Date().toISOString();
        sv(K.co, DB.con);
      }
    }
    logEv('contact', cConvertId, 'converted', 'Quote ' + qt.num + ' created — contact converted', 'system');
    cConvertId = null;
  }
```

`saveQte()` is already `async` (verify at implementation time — it constructs `qt` and calls `sv(K.qt, DB.qt)` earlier in the same function); this addition needs no new `async` declaration.

`delQte()`'s Contact status revert (`index.html:11278-11292`) — `delQte()` itself becomes `async` (currently a plain `function`; its only caller is a plain `onclick`, same pattern as `delCon()`/`delLI()` becoming `async` in §2.3/§2.4):

```js
async function delQte(id) {
  if (!confirm('Delete this quote?')) return;
  var q = DB.qt.find(function(x){ return x.id === id; });
  DB.qt = DB.qt.filter(function(x){ return x.id !== id; });
  sv(K.qt, DB.qt);
  if (q && q.sourceContactId) {
    var relC = DB.con.find(function(x){ return x.id === q.sourceContactId; });
    if (relC && relC.status === 'converted') {
      if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) {
        var revertResult = await _sb.from('contacts').update({ status: 'qualified' }).eq('id', relC.id);
        if (!revertResult.error) await refreshConFromSupabase();
      } else {
        relC.status = 'qualified';
        sv(K.co, DB.con);
      }
    }
  }
  rQte();
  toast('Quote deleted');
}
```

### 2.12 Round-3 spec-gate finding (blocking), fixed — `saveInv()`'s Line Item price-history auto-recording bypasses `saveLI()`

`saveInv()` (`index.html:6150-6166`) auto-appends a `priceHistory` entry to the matching `DB.li` catalogue record whenever an invoice line's price deviates from the catalogue price, persisting via a bare `sv(K.l, DB.li)`. Unlike the neighboring `invoiceRefs[]` index update in the same function (`index.html:6168-6193`, correctly local-only and preserved by §2.2's merge-by-id), `priceHistory` **is** a migrated Supabase column (AC-2) and gets overwritten wholesale from `row.price_history` on every refresh — so this auto-recorded entry would be silently lost the next time `refreshLIFromSupabase()` runs, once Line Items are migrated. Same fix shape as §2.11, gated on `st_li_cloud_migration_ts` for the same id-shape reason:

```js
  // Auto-record price history when invoice price deviates from catalogue price
  var liChanged = false;
  var liHistoryUpdates = [];
  cIL.forEach(function(li) {
    if (!li.lid) return;
    var cat = DB.li.find(function(x){ return x.id === li.lid; });
    if (!cat) return;
    var invoicePrice = +li.up || 0;
    var catPrice     = +cat.price || 0;
    if (Math.abs(invoicePrice - catPrice) < 0.001) return; // no deviation
    var history = cat.priceHistory ? cat.priceHistory.slice() : [];
    // Skip if already recorded for this invoice ref
    if (history.some(function(h){ return h.invoiceRef === inv.num && h.price === invoicePrice; })) return;
    history.push({ date: inv.date || today(), cost: +cat.cost||0, price: invoicePrice, invoiceRef: inv.num, notes: 'Price at time of order' });
    cat.priceHistory = history;
    liChanged = true;
    liHistoryUpdates.push({ id: cat.id, priceHistory: history });
  });
  if (liChanged) {
    if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) {
      for (var hi = 0; hi < liHistoryUpdates.length; hi++) {
        await _sb.from('line_items').update({ price_history: liHistoryUpdates[hi].priceHistory }).eq('id', liHistoryUpdates[hi].id);
      }
      await refreshLIFromSupabase();
    } else {
      sv(K.l, DB.li);
    }
  }
```

The `invoiceRefs[]` block immediately below (`index.html:6168-6193`) is unchanged — it re-`find()`s `cat` from `DB.li` fresh each time it runs, so it correctly operates on the just-refreshed records if the branch above replaced `DB.li` via `refreshLIFromSupabase()`.

### 2.13 Advisory (round-3), noted — `syncAll()`/`pushAll()` have no `_sb`-based exclusion in either direction

`syncAll()`/`pushAll()` (`index.html:4312-4341`, `4534-4563` — the `bulk_upsert_all` push-direction counterpart to `pullAll()`) have no `_sb`-based exclusion at all, for any entity, including the pre-existing Supplier case from CLOUD-001. Once Line Items/Contacts are cloud-migrated, these will keep pushing Cloud-sourced snapshots of them up to Google Sheets on every sync. This is wasteful/confusing, not destructive — `pullAll()`'s exclusion (§2.9, correctly extended by this SPEC) means nothing pulls those stale Sheets rows back down, so there's no round-trip corruption loop. Symmetric with a pre-existing, never-fixed gap on the Supplier side; this SPEC does not make it categorically worse, so it's left as a documented, accepted residual rather than fixed here — a candidate for a future small, standalone REQ alongside `CLOUD-GAP-001`.

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness (`tests/run.js:6972-7015`) unchanged — every new call shape needed (`select().is()`, `insert().select().single()`, `update().eq().select().single()`, bare `update().eq()`) is already supported, since it was deliberately generalized across the 4 shapes the app uses, not hardcoded to Supplier/Buyer's table names. Insert this block after the existing CLOUD-001 test section (after `tests/run.js:7249` or wherever that section currently ends — locate via the `// ── CLOUD DATA` banner comment and insert after its last test).

```js
// ── CLOUD DATA — Line Item & Contact (SPEC-CLOUD-002) ──

testAsync('isSupplierMigrationComplete — true when Supabase suppliers has rows, true via local marker even when Supabase is currently empty, false when neither, false when unconfigured', async function() {
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx._sb = mockSb({ suppliers: { selectData: [{ id: 'u1', name: 'ACME' }] } });
  assertEqual(await ctx.isSupplierMigrationComplete(), true, 'true when rows exist');
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  assertEqual(await ctx.isSupplierMigrationComplete(), false, 'false when empty and no local marker');

  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({ suppliers: { selectData: [] } }); // zero-Supplier edge case (B3 fix)
  assertEqual(await ctx.isSupplierMigrationComplete(), true, 'true via local marker even though the live table is currently empty');
  ctx.localStorage.removeItem('st_cloud_migration_ts');

  ctx._sb = null;
  assertEqual(await ctx.isSupplierMigrationComplete(), false, 'false when Cloud Data not configured');
});

testAsync('migrateLineItemsToSupabase — blocked when Supplier migration has not completed; no insert made', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', supId: 's1', sku: 'SKU1' });
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  await ctx.migrateLineItemsToSupabase();
  assertEqual(ctx.DB.li[0].id, 'l1', 'Line Item id unchanged — migration never ran');
});

testAsync('migrateContactsToSupabase — blocked when Supplier migration has not completed; no insert made', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', supplierId: null, enquiries: [], gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', notes: '', role: '', status: 'lead', source: 'manual' });
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  await ctx.migrateContactsToSupabase();
  assertEqual(ctx.DB.con[0].id, 'c1', 'Contact id unchanged — migration never ran, even though this Contact has no Supplier link');
});

testAsync('migrateLineItemsToSupabase — blocked when a Line Item\'s supId does not resolve to a known Supabase Supplier; zero inserts made', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', supId: 'stale-local-id' });
  var sb = mockSb({ suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] }, line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateLineItemsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'insert'; });
  assert(!insertCall, 'no insert attempted — the orphaned supId was caught before the insert loop started');
  assertEqual(ctx.DB.li[0].id, 'l1', 'Line Item unchanged');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateLineItemsToSupabase — Supplier already migrated: inserts every field, rewrites Invoice/PO lid refs, checks-but-skips dead Quote.lines[].lid, preserves invoiceRefs across the post-migration refresh', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', supId: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, cur: 'USD', notes: '', priceHistory: [{date:'2026-01-01',cost:1,price:2,invoiceRef:'',notes:'Initial catalogue price'}], invoiceRefs: [{ invId: 'INV-1' }], dims: {l:1,w:1,h:1}, dg: true });
  ctx.DB.inv.push({ id: 'i1', lineItems: [{ lid: 'l1', qty: 1 }] });
  ctx.DB.po.push({ id: 'p1', lineItems: [{ lid: 'l1', qty: 1 }] });
  ctx.DB.qt.push({ id: 'q1', lines: [{ lid: 'l1' }] }); // Quote.lines[].lid is dead — checked anyway per AC-4

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    line_items: {
      insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); },
      selectData: [{ id: 'new-li-uuid', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', sup_id: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, currency: 'USD', notes: '', dg: true, dims: {l:1,w:1,h:1}, price_history: [{date:'2026-01-01',cost:1,price:2,invoiceRef:'',notes:'Initial catalogue price'}] }]
    }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-li-restore-btn');

  await ctx.migrateLineItemsToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(insertCall.row.dg, true, 'dg included in insert payload');
  assertEqual(JSON.stringify(insertCall.row.dims), JSON.stringify({l:1,w:1,h:1}), 'dims included in insert payload');
  assertEqual(insertCall.row.price_history.length, 1, 'priceHistory included in insert payload');
  assertEqual(insertCall.row.invoiceRefs, undefined, 'invoiceRefs never sent to Supabase — no such column');

  assertEqual(ctx.DB.inv[0].lineItems[0].lid, 'new-li-uuid', 'Invoice lineItems[].lid remapped');
  assertEqual(ctx.DB.po[0].lineItems[0].lid, 'new-li-uuid', 'PO lineItems[].lid remapped');
  assertEqual(ctx.DB.qt[0].lines[0].lid, 'l1', 'dead Quote.lines[].lid left as-is — sweep checked it (no crash) but had nothing real to rewrite');

  assertEqual(ctx.DB.li[0].id, 'new-li-uuid', 'Line Item own id remapped to the Supabase-assigned id');
  assertEqual(JSON.stringify(ctx.DB.li[0].invoiceRefs), JSON.stringify([{ invId: 'INV-1' }]), 'invoiceRefs preserved across the post-migration refresh, not dropped by the Supabase-sourced replacement');

  var archived = JSON.parse(ctx.localStorage.getItem('st_li_pre_migration'));
  assertEqual(archived[0].id, 'l1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — Supplier already migrated: inserts every field including role/enquiries, rewrites OrderRequest.contactId, nested RFQResponse.contactId, and Quote.sourceContactId', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: '2026-01-01T00:00:00.000Z', lastContactedAt: '', enquiries: [{id:'e1',ts:'2026-01-01',summary:'hi',source:'manual'}], notes: '', supplierId: 'new-sup-uuid', role: 'supplier_contact' });
  ctx.DB.ord.push({ id: 'o1', contactId: 'c1', lines: [{ rfqResponses: [{ contactId: 'c1' }] }] });
  ctx.DB.qt.push({ id: 'q1', sourceContactId: 'c1' });

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');

  await ctx.migrateContactsToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(insertCall.row.role, 'supplier_contact', 'role included in insert payload');
  assertEqual(insertCall.row.enquiries.length, 1, 'enquiries included in insert payload');
  assertEqual(insertCall.row.created_at, '2026-01-01T00:00:00.000Z', 'original createdAt preserved, not overwritten by a DB default');

  assertEqual(ctx.DB.ord[0].contactId, 'new-con-uuid', 'OrderRequest.contactId remapped');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, 'new-con-uuid', 'nested RFQResponse.contactId remapped');
  assertEqual(ctx.DB.qt[0].sourceContactId, 'new-con-uuid', 'Quote.sourceContactId remapped');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — a Contact with supplierId:null migrates cleanly once Supplier has completed, supplier_id sent as null', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'c2', num: 'CON-0002', name: 'Bob', email: 'b@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', enquiries: [], notes: '', supplierId: null, role: '' });
  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid-2' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');
  await ctx.migrateContactsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assertEqual(insertCall.row.supplier_id, null, 'supplier_id sent as null, not undefined or a stale local id');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — blocked when a Contact\'s supplierId does not resolve against the ACTUALLY-CONNECTED project, even if the stale local completion marker says migration is done (round-2 B3 fix)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString()); // stale marker left over from a different, previously-connected project
  ctx.DB.con.push({ id: 'c3', num: 'CON-0003', name: 'Carol', email: 'c@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', enquiries: [], notes: '', supplierId: 'uuid-from-a-different-project', role: 'supplier_contact' });
  // The currently-connected project's suppliers table has no such Supplier — proves the
  // pre-flight check queries live state and isn't fooled by the stale marker that just
  // let isSupplierMigrationComplete() return true.
  var sb = mockSb({ suppliers: { selectData: [{ id: 'a-completely-different-real-uuid', name: 'Real Local Supplier' }] }, contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid-3' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateContactsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assert(!insertCall, 'no insert attempted — the orphaned supplierId was caught before the insert loop started, despite the stale marker');
  assertEqual(ctx.DB.con[0].id, 'c3', 'Contact unchanged');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts');
});

test('restoreFromMigrationArchive / restoreLIMigrationArchive / restoreConMigrationArchive — each clears its own migration-completion marker on restore (round-2 B3 fix)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };

  ctx.localStorage.setItem('st_s_pre_migration', '[]'); ctx.localStorage.setItem('st_bu_pre_migration', '[]');
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.restoreFromMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_cloud_migration_ts'), null, 'st_cloud_migration_ts cleared so a later reconnect to a different project cannot inherit it');

  ctx.localStorage.setItem('st_li_pre_migration', '[]');
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.restoreLIMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_li_cloud_migration_ts'), null, 'st_li_cloud_migration_ts cleared on its own restore');

  ctx.localStorage.setItem('st_con_pre_migration', '[]');
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.restoreConMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_con_cloud_migration_ts'), null, 'st_con_cloud_migration_ts cleared on its own restore');

  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('saveLI — Cloud Data configured: create calls insert with client-generated num but no client-generated id; update calls update().eq(), never insert; local Sheets sync never called', async function() {
  resetDB();
  ctx.EI.l = null;
  ['lf-s','lf-d','lf-sp','lf-hs','lf-sup','lf-u','lf-c','lf-p','lf-cur','lf-nt','lf-diml','lf-dimw','lf-dimh'].forEach(function(id){ mockEl(id); });
  mockEl('lf-s').value = 'SKU1'; mockEl('lf-d').value = 'Widget'; mockEl('lf-sup').value = 'new-sup-uuid'; mockEl('lf-cur').value = 'USD';
  var syncCalled = false;
  ctx.syncEnt = function(){ syncCalled = true; return Promise.resolve(); };
  var sb = mockSb({ line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } } });
  ctx._sb = sb;
  await ctx.saveLI();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');
  assertEqual(syncCalled, false, 'syncEnt never called on the _sb path — mutually exclusive with Sheets sync');

  ctx.EI.l = 'new-li-uuid';
  var sb2 = mockSb({ line_items: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });
  ctx._sb = sb2;
  await ctx.saveLI();
  var updateCall = sb2._calls.find(function(c){ return c.op === 'update'; });
  var insertCall2 = sb2._calls.find(function(c){ return c.op === 'insert'; });
  assert(updateCall, 'update was called on edit path');
  assert(!insertCall2, 'insert never called on edit path');
});

testAsync('delLI — Cloud Data configured: soft-delete via update({deleted_at}), never a hard delete, never delEnt', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', sku: 'SKU1' });
  ctx.confirm = function(){ return true; };
  var delEntCalled = false;
  ctx.delEnt = function(){ delEntCalled = true; return Promise.resolve(); };
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.delLI('l1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(delEntCalled, false, 'delEnt never called on the _sb path');
  ctx.confirm = function(){ return false; };
});

testAsync('saveCon — Cloud Data configured: create calls insert with client-generated num; update calls update().eq(); duplicate-email merge path updates Supabase and never calls sv(K.co,...) directly', async function() {
  resetDB();
  ctx.EI.co = null;
  ['ct-name','ct-email','ct-status','ct-enq-summary','ct-phone','ct-company','ct-source','ct-notes','ct-sup'].forEach(function(id){ mockEl(id); });
  mockEl('ct-name').value = 'New Contact'; mockEl('ct-email').value = 'new@x.com'; mockEl('ct-status').value = 'lead';
  var sb = mockSb({ contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); } } });
  ctx._sb = sb;
  await ctx.saveCon();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');

  resetDB();
  ctx.DB.con.push({ id: 'dup1', name: 'Existing', email: 'dup@x.com', enquiries: [] });
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Someone'; mockEl('ct-email').value = 'dup@x.com'; mockEl('ct-status').value = 'lead';
  mockEl('ct-enq-summary').value = 'follow up';
  ctx.confirm = function(){ return true; }; // accept the merge prompt
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.saveCon();
  var mergeCall = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(mergeCall, 'merge path updates Supabase');
  assertEqual(mergeCall.row.enquiries.length, 1, 'merged enquiry included in the Supabase update payload');
  ctx.confirm = function(){ return false; };
});

testAsync('saveCon — merge path: on a Supabase update error, the in-memory dup record is never mutated (A1 fix)', async function() {
  resetDB();
  var dupRecord = { id: 'dup1', name: 'Existing', email: 'dup@x.com', enquiries: [], lastContactedAt: '' };
  ctx.DB.con.push(dupRecord);
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Someone'; mockEl('ct-email').value = 'dup@x.com'; mockEl('ct-status').value = 'lead';
  mockEl('ct-enq-summary').value = 'follow up';
  ctx.confirm = function(){ return true; };
  ctx._sb = mockSb({ contacts: { updateError: { message: 'network down' } } });
  await ctx.saveCon();
  assertEqual(dupRecord.enquiries.length, 0, 'dup.enquiries never mutated when the Supabase update fails');
  assertEqual(dupRecord.lastContactedAt, '', 'dup.lastContactedAt never mutated when the Supabase update fails');
  ctx.confirm = function(){ return false; };
});

testAsync('delCon — Cloud Data configured: soft-delete via update({deleted_at}); local DB.ord contactId and nested rfqResponses[].contactId still nulled', async function() {
  resetDB();
  ctx.DB.ord.push({ id: 'o1', contactId: 'c1', lines: [{ rfqResponses: [{ contactId: 'c1' }] }] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.delCon('c1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(ctx.DB.ord[0].contactId, null, 'OrderRequest.contactId nulled locally');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, null, 'nested RFQResponse.contactId nulled locally');
  ctx.confirm = function(){ return false; };
});

test('restoreLIMigrationArchive / restoreConMigrationArchive — each restores its own key and clears SS.supabaseUrl/supabaseAnonKey independently', function() {
  resetDB();
  ctx.localStorage.setItem('st_li_pre_migration', JSON.stringify([{ id: 'orig-li', sku: 'SKU1' }]));
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreLIMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.l))[0].id, 'orig-li', 'st_li restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');

  ctx.localStorage.setItem('st_con_pre_migration', JSON.stringify([{ id: 'orig-con', name: 'Alice' }]));
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.restoreConMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.co))[0].id, 'orig-con', 'st_con restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');

  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

test('cleanupExpiredMigrationArchive — Line Item and Contact archives expire independently of Supplier/Buyer\'s and of each other', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  var day5  = new Date(Date.now() - 5*86400000).toISOString();
  ctx.localStorage.setItem('st_li_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_li_pre_migration', '[]');
  ctx.localStorage.setItem('st_con_cloud_migration_ts', day5);
  ctx.localStorage.setItem('st_con_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_li_pre_migration'), null, 'expired Line Item archive removed at day 31');
  assertEqual(ctx.localStorage.getItem('st_con_pre_migration'), '[]', 'Contact archive at day 5 untouched');
});

testAsync('refreshLIFromSupabase / refreshConFromSupabase — refuse to overwrite real local data when this device has never run the migration (B1 fix); proceed when local data is empty (second-device case)', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.DB.li.push({ id: 'local-only-li', sku: 'REAL-LOCAL-SKU' });
  ctx._sb = mockSb({ line_items: { selectData: [] } }); // brand-new, still-empty table right after this SPEC ships
  await ctx.refreshLIFromSupabase();
  assertEqual(ctx.DB.li.length, 1, 'real local Line Item NOT wiped — this device never ran the Line Item migration');
  assertEqual(ctx.DB.li[0].id, 'local-only-li', 'original record untouched');

  resetDB(); // simulates a fresh/second device: no local Line Items at all
  ctx._sb = mockSb({ line_items: { selectData: [{ id: 'cloud-li-1', num: 'LI-0001', sku: 'CLOUD-SKU', currency: 'USD', price_history: [] }] } });
  await ctx.refreshLIFromSupabase();
  assertEqual(ctx.DB.li.length, 1, 'real Cloud Data correctly loaded — nothing local was at risk');
  assertEqual(ctx.DB.li[0].id, 'cloud-li-1', 'loaded from Supabase');

  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.DB.con.push({ id: 'local-only-con', name: 'Real Local Contact' });
  ctx._sb = mockSb({ contacts: { selectData: [] } });
  await ctx.refreshConFromSupabase();
  assertEqual(ctx.DB.con.length, 1, 'real local Contact NOT wiped — this device never ran the Contact migration');
});

test('rCfg — Line Item and Contact restore buttons reappear after reload based on their own local migration marker (B4 fix)', function() {
  mockEl('cfg-sb-li-restore-btn'); mockEl('cfg-sb-con-restore-btn'); mockEl('cfg-sb-restore-btn');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.rCfg();
  assertEqual(mockEl('cfg-sb-li-restore-btn').style.display, 'none', 'Line Item restore button hidden with no archive');
  assertEqual(mockEl('cfg-sb-con-restore-btn').style.display, 'none', 'Contact restore button hidden with no archive');

  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.rCfg();
  assertEqual(mockEl('cfg-sb-li-restore-btn').style.display, '', 'Line Item restore button visible again after a fresh rCfg() render, simulating a reload');
  assertEqual(mockEl('cfg-sb-con-restore-btn').style.display, 'none', 'Contact restore button independently still hidden');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
});

testAsync('pullAll — li/co dropped from the batched pull_all request once each entity\'s own Cloud Data migration marker is set, independently of Supplier\'s exclusion and of each other (B2 fix)', async function() {
  // Round-2 spec-gate fix: this test was originally written against a fictional
  // ctx.fetchSheetEntity stand-in. pullAll()'s real per-entity Sheets fetch is the
  // closure-local pulled(entity) function (index.html:4385-4388), which cannot be
  // intercepted from a test. Rewritten against this file's own existing fetch-mock
  // machinery (_fetchCallLog, set up at tests/run.js:43-88 and already used by the
  // pull_all/bulk_upsert_all tests around tests/run.js:2010-2099) — _fetchCallLog[0].entities
  // is exactly the _allPullKeys array pullAll() sends in its batched pull_all request,
  // which is built from _simpleEntsForBatch (index.html:4375-4377, the array this fix
  // extends alongside simpleEnts).
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx._sb = mockSb({});

  _fetchCallLog = [];
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('li') >= 0, 'li still requested — its own migration marker is not set yet');
  assert(_fetchCallLog[0].entities.indexOf('co') >= 0, 'co still requested — its own migration marker is not set yet');

  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('li'), -1, 'li excluded from the batched request once its own migration marker is set');
  assert(_fetchCallLog[0].entities.indexOf('co') >= 0, 'co still requested — its own marker is independently unset');

  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.SS.url = '';
});

testAsync('refreshConFromSupabase / refreshLIFromSupabase — set their own migration marker on a successful refresh even when this device never ran the migration itself (round-3 fix, second-device case)', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx._sb = mockSb({ contacts: { selectData: [{ id: 'cloud-con-1', num: 'CON-0001', name: 'Cloud Contact', email: 'c@x.com', enquiries: [] }] } });
  await ctx.refreshConFromSupabase(); // fresh device, DB.con was empty — guard lets this through
  assert(!!ctx.localStorage.getItem('st_con_cloud_migration_ts'), 'marker now set even though this device never ran migrateContactsToSupabase() itself');

  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx._sb = mockSb({ line_items: { selectData: [{ id: 'cloud-li-1', num: 'LI-0001', sku: 'X', currency: 'USD', price_history: [] }] } });
  await ctx.refreshLIFromSupabase();
  assert(!!ctx.localStorage.getItem('st_li_cloud_migration_ts'), 'marker now set for Line Item too');
});

testAsync('unlinkSupCon / openSupConPicker — Cloud Data + Contact migrated: push to Supabase and refresh, never a bare sv(K.co,...); Cloud Data configured but Contact NOT yet migrated: unchanged local-only behavior', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', supplierId: 'sup-uuid-1', role: 'supplier_contact' });
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.unlinkSupCon('con-uuid-1');
  var updateCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update'; });
  assert(updateCall, 'unlink pushed to Supabase once Contact has migrated');
  assertEqual(updateCall.row.supplier_id, null, 'supplier_id cleared in the Supabase payload');

  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts'); // Cloud Data configured for Supplier, but Contact never migrated
  ctx.DB.con.push({ id: 'local-uid-1', name: 'Bob', supplierId: 'sup-uuid-1', role: 'supplier_contact' });
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.unlinkSupCon('local-uid-1');
  var updateCall2 = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(!updateCall2, 'no Supabase call attempted — Contact ids on this device are still local uids');
  assertEqual(ctx.DB.con[0].supplierId, null, 'local unlink still applied directly, not silently dropped');
});

testAsync('delSup — Cloud Data configured, Contact ALSO migrated: linked contacts unlinked via Supabase update + refresh, not a bare sv(K.co,...)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.sup.push({ id: 'sup-uuid-1', name: 'ACME' });
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', supplierId: 'sup-uuid-1', role: 'supplier_contact', enquiries: [] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({ contacts: { selectData: [] } });
  ctx._sb = sb;
  await ctx.delSup('sup-uuid-1');
  var conUpdateCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update'; });
  assert(conUpdateCall, 'linked Contact unlinked via a real Supabase update once Contact has migrated');
  assertEqual(conUpdateCall.row.supplier_id, null, 'supplier_id cleared in the Supabase payload');
  ctx.confirm = function(){ return false; };
});

testAsync('saveQte / delQte — Contact status conversion round-trip pushes to Supabase once Contact has migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', status: 'qualified', enquiries: [] });
  ctx.cConvertId = 'con-uuid-1';
  ['qf-client','qf-nt'].forEach(function(id){ mockEl(id); });
  var sb = mockSb({ contacts: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'con-uuid-1', name: 'Alice', status: 'converted', enquiries: [] }] } });
  ctx._sb = sb;
  await ctx.saveQte();
  var convertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update' && c.row.status === 'converted'; });
  assert(convertCall, 'contact status pushed to Supabase as converted');

  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', status: 'converted', enquiries: [] });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE1', sourceContactId: 'con-uuid-1' });
  ctx.confirm = function(){ return true; };
  var sb2 = mockSb({ contacts: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'con-uuid-1', name: 'Alice', status: 'qualified', enquiries: [] }] } });
  ctx._sb = sb2;
  await ctx.delQte('q1');
  var revertCall = sb2._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update' && c.row.status === 'qualified'; });
  assert(revertCall, 'contact status reverted to qualified via Supabase on Quote deletion');
  ctx.confirm = function(){ return false; };
});

testAsync('saveInv — auto-recorded price history pushes to line_items via Supabase once Line Items have migrated, instead of a bare sv(K.l,...); unmigrated Line Items keep the existing local-only behavior', async function() {
  // Fixture pattern copied from the existing 'saveInv records price history when invoice
  // price deviates from catalogue' test (tests/run.js:575) — same cIL/mockEl shape, since
  // this is the same code path with a new _sb branch added ahead of its existing sv(K.l,...).
  resetDB();
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.DB.li  = [{ id:'li-uuid-1', num:'LI-0001', sku:'SKU-DEV', desc:'Deviation Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.DB.inv = [{ id:'inv-base', num:'INV10001', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-uuid-1', desc:'Deviation Test', uom:'pcs', qty:1, up:120 }]; // 120 ≠ 150
  ['if-n','if-b','if-ba','if-st','if-dst','if-cid','if-dt','if-ex','if-sd','if-ft','if-wt','if-cbm','if-pk','if-pol','if-pod','if-coo','if-cur','if-tx','if-lf','if-ins','if-leg','if-isp','if-oth','if-dep','if-inco','if-pt','if-terms','inv-sm'].forEach(function(id){ mockEl(id); });
  mockEl('if-n').value = 'INV10002'; mockEl('if-b').value = 'Test Buyer'; mockEl('if-dst').value = 'Barbados';
  mockEl('if-dt').value = '2026-05-01'; mockEl('if-cur').value = 'USD'; mockEl('if-tx').value = '0'; mockEl('if-lf').value = '0';
  mockEl('if-ins').value = '0'; mockEl('if-leg').value = '0'; mockEl('if-isp').value = '0'; mockEl('if-oth').value = '0'; mockEl('if-dep').value = '0';
  mockEl('if-inco').value = 'CIF'; mockEl('if-pt').value = 'Net 30'; mockEl('if-chi').checked = true; mockEl('inv-sm').value = 'Draft';

  var sb = mockSb({ line_items: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'li-uuid-1', num: 'LI-0001', sku: 'SKU-DEV', price: 150, cost: 100, currency: 'USD', price_history: [{ date: '2026-05-01', cost: 100, price: 120, invoiceRef: 'INV10002', notes: 'Price at time of order' }] }] } });
  ctx._sb = sb;
  await ctx.saveInv();
  var updateCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'update' && c.row.price_history; });
  assert(updateCall, 'price history pushed to Supabase rather than only sv(K.l,...)');
  assertEqual(updateCall.row.price_history[0].price, 120, 'deviated invoice price recorded in the pushed payload');

  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts'); // Cloud Data configured for Supplier, but Line Items never migrated
  ctx.DB.li  = [{ id:'li-dev', sku:'SKU-DEV', desc:'Deviation Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.DB.inv = [{ id:'inv-base', num:'INV10001', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-dev', desc:'Deviation Test', uom:'pcs', qty:1, up:120 }];
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.saveInv();
  var updateCall2 = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(!updateCall2, 'no Supabase call attempted — Line Item ids on this device are still local uids');
  var cat = ctx.DB.li.find(function(x){ return x.id === 'li-dev'; });
  assert(cat.priceHistory.length > 0, 'local-only behavior unchanged — history still recorded directly, matching the pre-existing test at tests/run.js:575');
});
```

---

## 4. Documentation / housekeeping (on completion)

- `docs/known-gaps.md`: add `CLOUD-GAP-001` — the pre-existing `expAll()`/`doImport()` Cloud Data connection-wipe bug (REQ-CLOUD-002 §3), confirmed still present, logged as open/accepted, not fixed here. Add `CLOUD-GAP-002` — `syncAll()`/`pushAll()` have no `_sb`-based exclusion in either direction, for any entity including Supplier (§2.13), confirmed pre-existing and not worsened by this SPEC, logged as open/accepted.
- `docs/requirements-tracker.md`: add `REQ-CLOUD-002` with full gate history, alongside `REQ-CLOUD-001`/`REQ-PO-002`.
- `STACKD_CONTEXT.md` / `CLAUDE.md`: version bump, test-count bump, new Cloud Data entities noted.
- `docs/architecture-data-model-v1.md`: update §2 ("Entity inventory") to mark Line Item and Contact's storage as Supabase-capable; update §4.1's Line Item/Contact narrative; update §8's sequencing recommendation to mark Phase 1's Line Item/Contact step complete.
- Version bump: next sequential version after v2.9.72 (implementer confirms the exact number at ship time — three files must move together: `<title>`, the nav button label, `AI_SYSTEM_PROMPT`), plus a new changelog entry, taking care with the `<ul>`/`<div>` nesting gotcha `REQ-PO-002`'s housekeeping already hit once.

---

## 5. Traceability

| AC | Implementation | Test |
|---|---|---|
| AC-1 | `isSupplierMigrationComplete()` gate in both migrate functions, live-check + local-marker OR (§0, §2.5, §2.6) | "blocked when Supplier migration has not completed" ×2, `isSupplierMigrationComplete` marker-OR test |
| AC-2 | `migrateLineItemsToSupabase()` insert payload, `0002_...sql`, pre-flight supId resolution check (§1, §2.5) | "inserts every field... preserves invoiceRefs", "blocked when a Line Item's supId does not resolve..." |
| AC-3 | `migrateContactsToSupabase()` insert payload (§2.6) | "inserts every field including role/enquiries..." |
| AC-4 | Quote.lines[].lid checked in the sweep (§2.5) | same test, asserts sweep ran and left it untouched |
| AC-5 | `_sb` branches return before `syncEnt`/`delEnt` (§2.3, §2.4) | saveLI/delLI/saveCon/delCon `_sb`-configured tests |
| AC-6 | `showBlockingBackupModal()` reused unchanged (§2.5, §2.6) | inherited from CLOUD-001's existing coverage; no new mechanism introduced |
| AC-7 | `restoreLIMigrationArchive()`/`restoreConMigrationArchive()`, extended `cleanupExpiredMigrationArchive()`, `rCfg()` button-visibility fix (§2.7) | archive/rollback/cleanup tests, `rCfg` restore-button test |
| AC-8 | `0002_line_items_contacts.sql` has no `sku` unique index, no Contact uniqueness (§1) | schema reviewed at spec-gate; no runtime test possible (SQL isn't executed by `tests/run.js`) |
| AC-9 | No changes to Supplier/Buyer code paths (§2.10 unchanged; `restoreFromMigrationArchive()` gets one additive line, §0); `refreshLIFromSupabase`/`refreshConFromSupabase` overwrite guard + self-marking (§2.2); `pullAll()`'s both entity arrays excluded per-entity (§2.9); Contact pre-flight orphan check mirroring Line Item's (§2.6); `unlinkSupCon`/`openSupConPicker`/`delSup`/`saveQte`/`delQte`/`saveInv` made `_sb`-aware (§2.11, §2.12); full existing suite re-run | full `tests/run.js` run, `refreshLIFromSupabase`/`refreshConFromSupabase` overwrite-guard + self-marking test, `pullAll` exclusion test (both arrays), Contact orphan/stale-marker test, restore-clears-marker test, `unlinkSupCon`/`openSupConPicker`/`delSup`/`saveQte`/`delQte`/`saveInv` `_sb`-aware tests, mutation testing on the new code only |

---

## 6. Review-resolution log

**Round 1: CONDITIONAL PASS — 4 blocking findings (B1-B4), 5 advisories (A1-A5), all fixed in place.** Every code citation in the original v1 draft was independently re-traced against the live `index.html`/`tests/run.js` and confirmed byte-for-byte accurate — the findings below are novel interactions this SPEC's new code creates with other existing subsystems (`initCloudDataLayer()`'s unconditional wiring, `pullAll()`'s Sheets exclusion, `rCfg()`'s button-visibility rendering), not citation drift.

- **B1 — blocking.** `refreshLIFromSupabase()`/`refreshConFromSupabase()`, wired unconditionally into `initCloudDataLayer()`, would silently wipe real local Line Item/Contact data with `[]` for every existing Cloud-Data adopter on their very first reload after this SPEC ships (the new tables are empty until an operator manually migrates). **Fixed:** §2.2 — both functions now refuse to replace local data when real local records exist and this device has never recorded running that entity's own migration.
- **B2 — blocking.** `pullAll()`'s `simpleEnts` Sheets-sync exclusion (`index.html:4454-4459`) only ever excluded `'sup'`; `'li'`/`'co'` would keep racing the new Supabase refreshes for any install running both Sheets sync and Cloud Data during a phased migration. **Fixed:** §2.9 (new) — per-entity exclusion gated on each entity's own local migration marker.
- **B3 — blocking.** The original `isSupplierMigrationComplete()` (live-query-only) permanently blocks Contact migration for any business with zero Suppliers ever recorded — not a narrow edge case given Contact's `supplierId` is nullable and a lead-tracking-only business is a normal shape for this domain model, as the reviewer demonstrated by citing the Contact schema's own design (`openSupConPicker()`, `saveCon()`'s status values) against the SPEC's own "narrow" claim. **Fixed:** §0 — combined with the local `st_cloud_migration_ts` marker `migrateSuppliersBuyersToSupabase()` already writes unconditionally today, via OR.
- **B4 — blocking.** The new restore buttons' visibility was only set inline inside the migrate functions (same-session only); `rCfg()` — which re-renders the existing Supplier/Buyer restore button's visibility on every Settings-tab render, including after a reload — was never extended, so both new buttons would silently stay hidden after any reload even with a valid, restorable archive present. **Fixed:** §2.7 — two equivalent lines added to `rCfg()`.
- **A1 — advisory.** `saveCon()`'s merge branch mutated `dup.enquiries`/`dup.lastContactedAt` in place before the Supabase call that could fail, leaving an un-persisted, un-rolled-back mutation standing in memory on error. **Fixed:** §2.4 — merge payload built into local variables; `dup` only mutated on the local (non-`_sb`) path, after success.
- **A2 — advisory.** `line_items.sup_id`'s `NOT NULL` FK constraint means a single local Line Item with a stale/unresolved `supId` would abort `migrateLineItemsToSupabase()`'s insert loop mid-batch, after some rows are already irreversibly inserted. **Fixed:** §2.5 — a pre-flight check verifies every local `supId` resolves to a real Supabase Supplier id before the insert loop starts.
- **A3 — advisory.** §2.7's two-sibling-function design is a reasonable but unflagged deviation from REQ-CLOUD-002d's literal "an extension of `restoreFromMigrationArchive()`" wording. **Fixed:** §2.7 — the deviation and its rationale are now stated explicitly.
- **A4 — advisory.** The restore confirm() copy didn't disclose that restoring one entity's archive disconnects Cloud Data globally, dropping the connection for every other Cloud-Data entity too, not just the one being restored. **Fixed:** §2.7 — copy reworded to say so plainly.
- **A5 — advisory.** Folded into the B3 fix and its writeup above — the "narrow limitation" framing has been replaced with the reviewer's own, better-supported argument.

Confirmed round-1-ready: all four blocking findings resolved with concrete diffs and matching new tests; all five advisories resolved in place.

**Round 2: CONDITIONAL PASS — 1 new blocking finding, 2 advisories, all fixed in place.** Independently re-verified every round-1 fix by re-tracing it against the live code a second time: B1's guard correctly unblocks the migration function's own first-ever refresh (marker is set before that call) and correctly proceeds for a fresh second device with no local data; B4's `rCfg()` lines and B2's original `simpleEnts` fix use the exact right keys and insertion point; A1's rewritten `saveCon()` merge branch is byte-for-byte behaviorally equivalent to the original on the local path and never mutates `dup` before a possible Supabase failure; A2's pre-flight reuses the exact existing query shape correctly. One new blocking finding and two advisories, all novel — not re-litigating round 1's resolved items:

- **New blocking — the local completion marker is not scoped to a Supabase project, so it can outlive the project it was true for.** Traced a concrete, standard-UI-reachable path: a device migrates Suppliers to project P (marker set), an operator later reconfigures Cloud Data to a different, empty project Q via `saveSbConfig()` alone (no restore involved) — `isSupplierMigrationComplete()` returns `true` from the stale marker without ever querying Q, and `migrateContactsToSupabase()` had no equivalent of Line Item's A2 pre-flight check to catch the resulting FK violation against Q's `contacts` table, so it would abort mid-batch. **Fixed:** §2.6 — `migrateContactsToSupabase()` now gets its own pre-flight `supId`-resolution check verified against the actually-connected project, mirroring A2 exactly (this is the fix that actually closes the failure regardless of *how* the marker went stale); §0 and §2.7 additionally clear all three completion markers (`st_cloud_migration_ts`, `st_li_cloud_migration_ts`, `st_con_cloud_migration_ts`) on their respective restores, closing the specific staleness path the reviewer traced to demonstrate the bug.
- **Advisory — the round-1 B2 fix only extended one of `pullAll()`'s two parallel `_sb`-filtered entity arrays.** `_simpleEntsForBatch` (`index.html:4375-4377`, controls what's *requested*) was left unextended while `simpleEnts` (`index.html:4454-4459`, controls what's *merged*) was fixed — didn't reintroduce the overwrite race (the merge array is what actually gates writes), but left Line Item/Contact being requested from Sheets indefinitely post-migration, half of Supplier's own precedent. **Fixed:** §2.9 — both arrays now extended identically.
- **Advisory — the round-1 `pullAll` test for B2 was written against a fictional, uninterceptable stand-in (`ctx.fetchSheetEntity`), which the SPEC itself had flagged as speculative but not yet corrected.** Traced `pullAll()`'s real per-entity fetch (`pulled()`, a closure-local function) and confirmed the SPEC's own caveat was right to be suspicious, and more literally broken than "needs renaming." **Fixed:** §3 — rewritten against this test file's own existing `_fetchCallLog` fetch-mock machinery, already used by neighboring tests for the same `pull_all` mechanism.

Confirmed round-2-ready: the round-2 finding resolved with a concrete diff and matching new test; both advisories resolved in place.

**Round 3: CONDITIONAL PASS — 1 new blocking finding (with a narrower sibling case folded into the same fix), 1 advisory, all fixed in place.** Confirmed `node tests/run.js` baseline green (687/687) before this SPEC's own code exists. Independently re-verified every round-1 and round-2 fix a further time against the live code: §2.6's Contact pre-flight check is structurally identical to §2.5's Line Item check and correctly lets `supplierId: null` through unconditionally; the marker-staleness closure (§0/§2.7) was traced end-to-end with no unswept reader of either new marker found; `_simpleEntsForBatch`'s fix (§2.9) matches the live file exactly; the rewritten `pullAll` test's `_fetchCallLog[0]` assumption holds in every path it exercises; every round-2 test is well-formed with no localStorage leaks across tests. One new blocking finding, from a "final systemic sanity pass" specifically looking for other code that reads/writes `DB.li`/`DB.con` with local-array assumptions this SPEC's diffs never touched:

- **New blocking — five existing UI code paths write Contact fields directly and persist via a bare `sv(K.co, DB.con)`, entirely bypassing `saveCon()`/`delCon()` and therefore every `_sb` branch this SPEC adds.** `unlinkSupCon()`, `openSupConPicker()`, `delSup()`'s own Contact-nulling cascade (already inside an `_sb` branch today — correct while Contact was local-only, wrong the moment Contact is cloud-backed), `saveQte()`'s Contact-to-Quote conversion, and `delQte()`'s status-revert on Quote deletion all mutate `DB.con` records in place outside the save/delete wrapper. Confirmed via a systematic grep of every non-import `DB.sup.find(...)` site that Supplier has no equivalent side-channel — this is new territory introduced by Contact's optional-FK, cross-referenced-from-elsewhere shape, not a previously-accepted gap. A narrower single-instance sibling exists on the Line Item side: `saveInv()`'s price-history auto-recording mutates a `DB.li` catalogue entry's `priceHistory` via `sv(K.l, DB.li)` alone — unlike the neighboring `invoiceRefs[]` update in the same function, which §2.2's merge-by-id already protects, `priceHistory` **is** a migrated column and would be silently overwritten on the next refresh. **Fixed:** §2.11 (the five Contact sites) and §2.12 (`saveInv()`) — each now branches on `_sb && ` the entity's own completion marker (not bare `_sb`, since these sites reference an existing record's `id` directly, and a local uid can't match a Supabase row before that entity has actually migrated) to either push the change to Supabase and refresh, or fall back to the exact original local-only behavior unchanged. §2.2's refresh functions were additionally extended to set their own marker on any successful refresh (not just a migration this device itself ran), closing the second-device gap this fix would otherwise have reopened.
- **Advisory — `syncAll()`/`pushAll()` (the push-direction counterpart to `pullAll()`) have no `_sb`-based exclusion at all, for any entity, including the pre-existing Supplier case.** Wasteful/confusing (stale Cloud-sourced snapshots keep getting pushed to Sheets) but not destructive — `pullAll()`'s correctly-extended exclusion means nothing pulls those rows back down, so there's no round-trip corruption loop. Symmetric with an already-existing, never-fixed CLOUD-001-era gap; this SPEC doesn't make it categorically worse. **Noted, not fixed:** §2.13 — logged as `CLOUD-GAP-002` in §4's housekeeping, a candidate for a future standalone REQ.

Confirmed implementation-ready: every blocking finding across all three rounds resolved with concrete diffs and matching new tests; every advisory resolved in place or explicitly logged as an accepted, pre-existing-pattern residual.

---

## 7. Gate process

requirements-gate (done, PASS) → SPEC v1 → spec-gate round 1 (done, CONDITIONAL PASS, resolved) → spec-gate round 2 (done, CONDITIONAL PASS, resolved) → spec-gate round 3 (done, CONDITIONAL PASS, resolved above) → **implementation** → self-performed mutation testing → build-gate → PR → CI green → merge, per `CLAUDE.md`'s standing checklist.
