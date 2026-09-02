# SPEC-CLOUD-004 — Quote Cloud Data migration

**Status:** v1 — drafted against `docs/REQ-CLOUD-004-v1.md` (requirements-gate PASS, 3 rounds + 1 pre-SPEC self-caught clarification). Spec-gate round 1: CONDITIONAL PASS (7 blocking, 7 advisory) — every diff in §1-§2 was applied to a scratch copy of `index.html`/`tests/run.js` and the full suite run to verify; all 7 blocking findings and all 7 advisory findings fixed in place below (see §4). Verified: 752/752 tests pass (734 baseline + 18 new); the B1 and B2 fixes were each independently confirmed load-bearing by reverting them and observing the predicted failure reappear. Ready for spec-gate round 2.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **Nested-array embedding** (`REQ-CLOUD-004` §1.2): `quotes.lines` is one `jsonb` column, including each line's `priceHistory[]` and source-traceability fields. Lines have no id of their own (`rid` is a client-generated string never referenced by any other entity) — nothing to remap at the line level.
- **No migration precondition** (§1.2/REQ-CLOUD-004b): `source_contact_id` is a plain nullable `text` column, not FK-constrained; `lines[].supId`/`.lid`/`.sourceOrdId` are nested inside an opaque jsonb blob. Nothing to validate against.
- **`persistQteChange(qt, skipRefresh)` shared helper** (§1.2/REQ-CLOUD-004c), mirroring `persistOrdChange(ord, skipRefresh)` exactly — used by `qteToPoConvert()` and by the retrofit sweeps' cross-phase push loops. Not used by `saveQte()`/`delQte()`.
- **Both-direction external-reference sweep** (§1.5/REQ-CLOUD-004d): outward — `migrateQteToSupabase()` sweeps `Order Request.activeQuoteId`, `PurchaseOrder.quoteId`, `Invoice.linkedQuoteId` to Quote's newly-assigned ids, matched via the id-map built during its own insert loop, never through `Quote.linkedPOIds[]`. Inward — `sourceContactId`/`lines[].supId`/`.lid`/`.sourceOrdId` need no remapping step inside `migrateQteToSupabase()` itself; correctness is maintained entirely by the four retrofits below, regardless of migration order.
- **Five-site cross-phase retrofit** (§1.6/REQ-CLOUD-004e): `migrateSuppliersBuyersToSupabase()`, `migrateLineItemsToSupabase()`, `migrateContactsToSupabase()`, `migrateOrdToSupabase()` each gain touched-Quote tracking + push via `persistQteChange()` if Quote has migrated; `migrateQteToSupabase()` itself gains touched-Order-Request tracking + push via `persistOrdChange()` if Order Request has migrated (the outward retrofit, running in the opposite direction from the other four).
- **`pullAll()` exclusion for `'qt'`** (REQ-CLOUD-004f) once `st_qt_cloud_migration_ts` is set — Quote, unlike Order Request, has real Sheets sync.
- **Real pre-flight duplicate-`num` scan** (REQ-CLOUD-004g), case-sensitive exact match — Quote's `num` is manually editable, unlike Order Request's `ORD-####`.
- **`saveQte()`/`delQte()` get their own dedicated `_sb`-branches** (§1.2/§1.3/REQ-CLOUD-004h), not routed through `persistQteChange()` — same reasoning as `saveOrd()`/`delOrd()` in `REQ-CLOUD-003`. Both are already `async`; confirmed (§1.3) that no caller anywhere captures either's return value, so no ripple-effect fix is needed for any caller.
- **`qteToPoConvert()` becomes `async`** (REQ-CLOUD-004i), routing its `linkedPOIds` update through `persistQteChange()`. Its only production caller is a bare `onclick`; its nine existing test call sites all inspect state set before the new `await`.
- **Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only** — the same 9-step mechanics every prior Cloud Data migration has used.

## 0.1 A design decision this SPEC must add: `refreshQteFromSupabase()` must exist and be wired into `initCloudDataLayer()`

The REQ specifies `persistQteChange()` "mirroring `persistOrdChange()` exactly" (§1.2) — but `persistOrdChange()`'s own body calls `refreshOrdFromSupabase()` internally when `!skipRefresh` (`index.html:5623`), and `saveOrd()`'s cloud branch calls it after insert/update, and `migrateOrdToSupabase()` calls it at the end. For `persistQteChange()` to genuinely mirror that shape, a `refreshQteFromSupabase()` function must exist for it (and `saveQte()`'s new cloud branch, and `migrateQteToSupabase()`) to call. The REQ does not name this function as its own line item — an omission this SPEC corrects before it could repeat `REQ-CLOUD-003`'s own round-1 B2 lesson (a refresh function that exists but is never wired into `initCloudDataLayer()`, so it passes its own unit tests but never runs in practice). §2.1 below adds `refreshQteFromSupabase()`, mirroring `refreshOrdFromSupabase()`'s overwrite-guard-and-self-marking shape exactly, applied here from the start — and wires it into `initCloudDataLayer()` in the same diff, not as an afterthought.

**Spec-gate round-1 B1 finding — a required companion retrofit of one pre-existing test.** Wiring a fifth unconditional refresh call into `initCloudDataLayer()` is not cost-free against the existing suite: the pre-existing CLOUD-003 test `'initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding...)'` (`tests/run.js:7752`) configures `_sb` and stubs `ctx.refreshOrdFromSupabase`, but predates Quote's existence and does not know to stub `ctx.refreshQteFromSupabase` too. Left as-is, the real `refreshQteFromSupabase()` runs unmocked against `DB.qt` (empty at that point in the suite) and permanently sets `st_qt_cloud_migration_ts` in the shared test `localStorage` — which then silently corrupts a later, unrelated, already-shipped test (`migrateOrdToSupabase`'s own round-trip test) into taking the wrong branch. Verified empirically: applying every other diff in this SPEC without this one retrofit reproduces exactly that downstream failure; adding the retrofit and nothing else fixes it. §3 below applies this retrofit as the first item in the new test block, before any new CLOUD-004 test is added.

## 0.2 A design decision this SPEC must add: the pre-flight duplicate-`num` scan needs its own modal, not `ov-sb-dup`

`REQ-CLOUD-004g` requires a real pre-flight duplicate scan, mirroring `findDuplicateSupplierNames()`'s shape (§1.1). The existing `ov-sb-dup`/`sb-dup-list` modal (`index.html:2668-2678`) has "Migration Blocked — Duplicate Supplier Names" hardcoded in its markup, not in the injected content — reusing it verbatim for Quote would show a misleading title. §2.6 below adds a parallel, dedicated `ov-qt-dup`/`qt-dup-list` modal and a `findDuplicateQuoteNums()`/`showQteDupConflictModal()` pair, structurally identical to the Supplier pair but never modifying the existing, already-tested Supplier modal or its functions.

---

## 1. New SQL migration: `supabase/migrations/0004_quotes.sql`

```sql
-- SPEC-CLOUD-004: extends the Cloud Data shared-database layer to Quote.
--
-- Quote lines (including nested priceHistory[] and source-traceability fields)
-- stay embedded as a single `lines` jsonb column, never promoted to child
-- tables — lines have no id of their own (`rid` is a client-generated string
-- never referenced by any other entity), so nothing outside the parent Quote
-- ever needs to resolve a nested line to a new value (REQ-CLOUD-004 §1.2).
--
-- `source_contact_id` is deliberately NOT foreign-key-constrained: Contact may
-- not have migrated at the point a Quote migrates, and a real FK constraint
-- here would reject that case. It is `text`, not `uuid`, for the same reason
-- every prior migration's equivalent column is `text` — a not-yet-migrated
-- Contact's local id is never RFC-4122 format.
--
-- `dt` is `text`, not `date` — the app stores and reads back a plain
-- unreformatted YYYY-MM-DD string via a bare <input type="date">.value,
-- never a JS Date object; `text` matches `valid_until`'s own typing.
--
-- `_demo` (the local-only demo-data marker) is deliberately excluded from
-- this schema, matching REQ-CLOUD-003 AC-1's identical precedent for Order
-- Request's `_demo`/`_backfilled` markers — it carries forward unchanged in
-- the local record only, never sent to Supabase.

create table quotes (
  id                 uuid primary key default gen_random_uuid(),
  num                text not null unique,
  client             text,
  dt                 text,
  valid_until        text,
  currency           text,
  freight_mode       text,
  markup             numeric,
  status             text not null,
  notes              text,
  lines              jsonb not null default '[]'::jsonb,
  linked_po_ids      jsonb not null default '[]'::jsonb,
  source_contact_id  text,
  calc_total_landed  numeric,
  calc_sell_usd      numeric,
  calc_sell_gbp      numeric,
  approved_by        text,
  approved_reason    text,
  approved_at        timestamptz,
  origin_charges     numeric,
  dest_charges       numeric,
  fpm_admin          numeric,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table quotes enable row level security;

create policy "authenticated read" on quotes for select using (auth.role() = 'authenticated');
create policy "authenticated write" on quotes for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on quotes for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
```

`num text not null unique` matches every prior entity's ref-number convention, even though Quote's `num` is manually editable rather than machine-generated only — REQ-CLOUD-004g's pre-flight scan (§2.6) is what keeps a migration from ever hitting this constraint.

---

## 2. `index.html` changes

### 2.1 New `refreshQteFromSupabase()`, and `initCloudDataLayer()` wiring (§0.1)

Insert immediately after `refreshOrdFromSupabase()` closes (`index.html:5612`), before `persistOrdChange()`.

```js
async function refreshQteFromSupabase() {
  if (!_sb) return;
  if (DB.qt.length > 0 && !localStorage.getItem('st_qt_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('quotes').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Quotes from Cloud Data.'); return; }
  DB.qt = result.data.map(function(row){
    var q = {
      id: row.id, num: row.num, client: row.client, dt: row.dt, validUntil: row.valid_until,
      currency: row.currency, freightMode: row.freight_mode, markup: row.markup, status: row.status,
      notes: row.notes, lines: row.lines || [], linkedPOIds: row.linked_po_ids || [],
      sourceContactId: row.source_contact_id || '',
      calc_totalLanded: row.calc_total_landed, calc_sellUSD: row.calc_sell_usd, calc_sellGBP: row.calc_sell_gbp,
      approvedBy: row.approved_by || '', approvedReason: row.approved_reason || '', approvedAt: row.approved_at || ''
    };
    if (row.origin_charges != null) q.originCharges = row.origin_charges;
    if (row.dest_charges != null) q.destCharges = row.dest_charges;
    if (row.fpm_admin != null) q.fpmAdmin = row.fpm_admin;
    return q;
  });
  sv(K.qt, DB.qt);
  if (!localStorage.getItem('st_qt_cloud_migration_ts')) localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  rQte();
}
```

`originCharges`/`destCharges`/`fpmAdmin` are added to the mapped object only `if (row.origin_charges != null)` etc., rather than assigned unconditionally via `!= null ? val : undefined` — **spec-gate round-1 B2 finding**: assigning `undefined` inside an object literal still creates the key (`'originCharges' in obj` is `true` even when the value is `undefined`), so the original phrasing did not actually achieve the key-omission it claimed. Building the object without the three keys and conditionally adding them afterward is what actually omits them. This matters because `saveQte()` only ever sets these three keys conditionally (`if (origOvRaw !== '') qt.originCharges = ...`, `index.html:11741-11743`) — a Quote that never had an override set carries no key at all locally, not an explicit `null`; this preserves that shape across a Cloud round-trip rather than introducing three always-present `null`/`undefined` keys no local-only Quote ever had.

`initCloudDataLayer()` (`index.html:5514-5524`) gains one line, after Order Request (matching migration-order precedent):

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
  }
}
```

### 2.2 New `persistQteChange(qt, skipRefresh)`

Insert immediately after `refreshQteFromSupabase()` closes.

```js
async function persistQteChange(qt, skipRefresh) {
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('quotes').update({
      num: qt.num, client: qt.client, dt: qt.dt, valid_until: qt.validUntil, currency: qt.currency,
      freight_mode: qt.freightMode, markup: qt.markup, status: qt.status, notes: qt.notes,
      lines: qt.lines || [], linked_po_ids: qt.linkedPOIds || [], source_contact_id: qt.sourceContactId || null,
      calc_total_landed: qt.calc_totalLanded, calc_sell_usd: qt.calc_sellUSD, calc_sell_gbp: qt.calc_sellGBP,
      approved_by: qt.approvedBy || '', approved_reason: qt.approvedReason || '', approved_at: qt.approvedAt || null,
      origin_charges: qt.originCharges != null ? qt.originCharges : null,
      dest_charges: qt.destCharges != null ? qt.destCharges : null,
      fpm_admin: qt.fpmAdmin != null ? qt.fpmAdmin : null
    }).eq('id', qt.id);
    if (result.error) { console.warn('[Stackd] persistQteChange: failed to push Quote update for ' + qt.id, result.error.message); return; }
    if (!skipRefresh) await refreshQteFromSupabase();
    return;
  }
  sv(K.qt, DB.qt);
}
```

Note the local (non-`_sb`) branch persists the entire `DB.qt` array, matching `sv()`'s own semantics everywhere else — the `qt` parameter only matters for the Cloud-Data branch's single-row `.update()`. `skipRefresh` is used exactly as `persistOrdChange()`'s: the five multi-record retrofit loops (§2.9-§2.13) pass `true` and call `refreshQteFromSupabase()` themselves once, after their own loop.

### 2.3 `saveQte()` — cloud-aware create/update branch (`index.html:11668-11779`)

Current (relevant excerpt — the persistence block and everything after it; the line-building/priceHistory logic above it, lines 11668-11717, is unchanged):

```js
  if (origOvRaw !== '') qt.originCharges = +origOvRaw;
  if (destOvRaw !== '') qt.destCharges = +destOvRaw;
  if (admOvRaw  !== '') qt.fpmAdmin = +admOvRaw;
  if (EI.qt) {
    var idx = DB.qt.findIndex(function(x){ return x.id===EI.qt; });
    if (idx >= 0) DB.qt[idx] = qt; else DB.qt.push(qt);
  } else {
    DB.qt.push(qt);
  }
  sv(K.qt, DB.qt);
  if (cConvertId) {
    ...
  }
  if (cConvertOrdId) {
    ...
  }
  closeM('ov-qt');
  rQte();
  toast('Quote ' + qt.num + ' saved');
}
```

New:

```js
  if (origOvRaw !== '') qt.originCharges = +origOvRaw;
  if (destOvRaw !== '') qt.destCharges = +destOvRaw;
  if (admOvRaw  !== '') qt.fpmAdmin = +admOvRaw;

  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var qtRow = {
      num: qt.num, client: qt.client, dt: qt.dt, valid_until: qt.validUntil, currency: qt.currency,
      freight_mode: qt.freightMode, markup: qt.markup, status: qt.status, notes: qt.notes,
      lines: qt.lines || [], linked_po_ids: qt.linkedPOIds || [], source_contact_id: qt.sourceContactId || null,
      calc_total_landed: qt.calc_totalLanded, calc_sell_usd: qt.calc_sellUSD, calc_sell_gbp: qt.calc_sellGBP,
      approved_by: qt.approvedBy || '', approved_reason: qt.approvedReason || '', approved_at: qt.approvedAt || null,
      origin_charges: qt.originCharges != null ? qt.originCharges : null,
      dest_charges: qt.destCharges != null ? qt.destCharges : null,
      fpm_admin: qt.fpmAdmin != null ? qt.fpmAdmin : null
    };
    var qtResult;
    if (EI.qt) {
      qtResult = await _sb.from('quotes').update(qtRow).eq('id', EI.qt).select().single();
    } else {
      qtResult = await _sb.from('quotes').insert(qtRow).select().single();
    }
    if (qtResult.error) { toast('Save failed: ' + qtResult.error.message); return; }
    qt.id = qtResult.data.id;
    await refreshQteFromSupabase();
  } else {
    if (EI.qt) {
      var idx = DB.qt.findIndex(function(x){ return x.id===EI.qt; });
      if (idx >= 0) DB.qt[idx] = qt; else DB.qt.push(qt);
    } else {
      DB.qt.push(qt);
    }
    sv(K.qt, DB.qt);
  }

  if (cConvertId) {
    ... (unchanged)
  }
  if (cConvertOrdId) {
    ... (unchanged)
  }
  closeM('ov-qt');
  rQte();
  toast('Quote ' + qt.num + ' saved');
}
```

**Spec-gate round-1 A7 advisory (acknowledged, not changed):** the cloud branch's `await refreshQteFromSupabase()` already calls `rQte()` internally, and the shared tail below still calls `rQte()` again unconditionally — a harmless double-render specific to the cloud path only. Left as-is rather than threading a skip-render flag through `refreshQteFromSupabase()` just for this cosmetic optimization; the local branch still needs its own `rQte()` call, so the tail can't simply be removed.

`qt.id` is reset to the real Postgres-assigned id (`qtResult.data.id`) immediately after a successful cloud insert/update, **before** the `cConvertOrdId` block runs — that block sets `convOrd.activeQuoteId = qt.id` (`index.html:11770`), which must be the final, real id, not the client-generated `uid()` `qt.id` was constructed with at `index.html:11719` (`id: EI.qt || uid()`). `qtRow` never includes an `id` key, so a create always lets Postgres assign a fresh UUID regardless of what local placeholder `qt.id` already held — the same "no client-generated id sent on insert" invariant every prior `save*()` cloud branch in this codebase already enforces. `saveQte()` itself is already `async` (`REQ-CLOUD-002`) — no signature change, and (per REQ-CLOUD-004 §1.3) no caller anywhere reads its return value, so this branch needs no return-value contract of its own.

### 2.4 `delQte()` — cloud-aware soft-delete branch (`index.html:11781-11801`)

Current:

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
        if (revertResult.error) { console.warn('[Stackd] delQte: failed to revert Contact status for ' + relC.id, revertResult.error.message); }
        else { await refreshConFromSupabase(); }
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

New (only the Quote-side deletion changes; the Contact-side reversion logic that follows is untouched, verbatim):

```js
async function delQte(id) {
  if (!confirm('Delete this quote?')) return;
  var q = DB.qt.find(function(x){ return x.id === id; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('quotes').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshQteFromSupabase();
  } else {
    DB.qt = DB.qt.filter(function(x){ return x.id !== id; });
    sv(K.qt, DB.qt);
  }
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
  rQte();
  toast('Quote deleted');
}
```

`var q = ...` stays before the new `_sb` branch, since the cloud branch needs no local record but the Contact-reversion logic below still needs `q.sourceContactId` — captured before any deletion, exactly as today. The pre-existing test `'delQte() with sourceContactId — contact reverts to qualified, rQte called'` (`tests/run.js:3813`) is unaffected regardless of any leaked `ctx._sb` state from an earlier test, because the new branch's condition also requires `st_qt_cloud_migration_ts`, a marker no pre-existing test sets.

### 2.5 `qteToPoConvert()` — becomes `async`, routes through `persistQteChange()` (`index.html:12080-12131`)

Current (only the signature and the final persistence lines are shown; the supplier-grouping/PO-building logic in between, lines 12089-12121, is unchanged):

```js
function qteToPoConvert() {
  var id = EI.qt;
  if (!id) return;
  var q = DB.qt.find(function(x){ return x.id===id; });
  if (!q) return;
  if (q.linkedPOIds && q.linkedPOIds.length) { toast('This quote already has a linked PO'); return; }
  if (q.status !== 'Accepted') { toast('Set quote status to Accepted before converting to PO'); return; }

  ... (unchanged grouping/PO-building logic)

  sv(K.p, DB.po);
  q.linkedPOIds = newPOIds;
  sv(K.qt, DB.qt);
  G('qt-po-btn').style.display = 'none';
  closeM('ov-qt');
  rQte();
  rPO();
  toast('PO' + (poNums.length > 1 ? 's ' : ' ') + poNums.join(', ') + ' created from ' + q.num);
}
```

New:

```js
async function qteToPoConvert() {
  var id = EI.qt;
  if (!id) return;
  var q = DB.qt.find(function(x){ return x.id===id; });
  if (!q) return;
  if (q.linkedPOIds && q.linkedPOIds.length) { toast('This quote already has a linked PO'); return; }
  if (q.status !== 'Accepted') { toast('Set quote status to Accepted before converting to PO'); return; }

  ... (unchanged grouping/PO-building logic, verbatim)

  sv(K.p, DB.po);
  q.linkedPOIds = newPOIds;
  await persistQteChange(q);
  G('qt-po-btn').style.display = 'none';
  closeM('ov-qt');
  rQte();
  rPO();
  toast('PO' + (poNums.length > 1 ? 's ' : ' ') + poNums.join(', ') + ' created from ' + q.num);
}
```

The PO-creation portion (`DB.po.push(po)`, `sv(K.p, DB.po)`) is untouched — Purchase Order is not Cloud-Data-eligible. Its only production caller is a bare `onclick="qteToPoConvert()"` (`index.html:2603`) — safe. Its nine existing test call sites (`tests/run.js:1218-1337`) all check `DB.po`/`DB.qt[...].linkedPOIds` state set by `q.linkedPOIds = newPOIds` on the line immediately before the new `await` — none inspects `G('qt-po-btn')`/`closeM()`/`toast()`/`rQte()`/`rPO()` output, so no test conversion is needed.

### 2.6 Pre-flight duplicate-`num` scan — new `findDuplicateQuoteNums()`/`showQteDupConflictModal()`, new modal (§0.2)

Insert `findDuplicateQuoteNums()` immediately after `findDuplicateSupplierNames()` closes (`index.html:5644`); insert `showQteDupConflictModal()` immediately after `showDuplicateConflictModal()` closes (`index.html:5650`).

```js
function findDuplicateQuoteNums(qt) {
  var groups = {};
  qt.forEach(function(q){
    var key = q.num || '';
    if (!key) return;
    (groups[key] = groups[key] || []).push(q);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){ return g.length > 1; });
}

function showQteDupConflictModal(dupes) {
  G('qt-dup-list').innerHTML = '<p style="margin-bottom:10px;">Migration blocked: the following Quote numbers are duplicated (exact match) and would violate the cloud database\'s unique-number constraint. Rename one of each pair before migrating.</p><ul style="padding-left:18px;">' +
    dupes.map(function(g){ return '<li>' + g.map(function(q){ return san(q.num); }).join(' &nbsp;/&nbsp; '); }).join('</li>') + '</li></ul>';
  G('ov-qt-dup').classList.add('on');
}
```

Case-sensitive exact match (`q.num || ''`, no `.trim().toLowerCase()`) — deliberately unlike `findDuplicateSupplierNames()`'s case-insensitive comparison, since `saveQte()`/`vQte()` apply no case-normalization to `num` anywhere (REQ-CLOUD-004g).

New modal HTML, inserted immediately after the existing `ov-sb-dup` modal closes (`index.html:2678`):

```html
<div class="ov" id="ov-qt-dup" onclick="if(event.target===this)closeM('ov-qt-dup')">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Migration Blocked — Duplicate Quote Numbers</h2><button class="mx" onclick="closeM('ov-qt-dup')">&#215;</button></div>
    <div class="mb">
      <div id="qt-dup-list" style="font-size:.55rem;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-g" onclick="closeM('ov-qt-dup')">Close</button>
      </div>
    </div>
  </div>
</div>
```

Structurally identical to `ov-sb-dup` — a new, dedicated modal rather than modifying the existing, already-tested Supplier one (its title is hardcoded markup, not injectable).

### 2.7 `migrateQteToSupabase()` — new function

Insert immediately after `migrateOrdToSupabase()` closes (`index.html:5933`).

```js
async function migrateQteToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-004b: no Supplier/Contact/Order-Request migration-completion precondition —
  // sourceContactId/lines[].supId/.lid/.sourceOrdId are either nested inside an opaque
  // jsonb blob no Postgres constraint can reach, or a plain unconstrained text field.

  // REQ-CLOUD-004g: unlike Order Request's ORD-#### (machine-generated only), Quote's num
  // is manually editable via the Quote Number field with no case-normalization anywhere —
  // a real pre-flight duplicate scan is required, not a documented no-op.
  var qteDupes = findDuplicateQuoteNums(DB.qt);
  if (qteDupes.length) { showQteDupConflictModal(qteDupes); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var qteIdMap = {};
  for (var i = 0; i < DB.qt.length; i++) {
    var q = DB.qt[i];
    var result = await _sb.from('quotes').insert({
      num: q.num, client: q.client, dt: q.dt, valid_until: q.validUntil, currency: q.currency,
      freight_mode: q.freightMode, markup: q.markup, status: q.status, notes: q.notes,
      lines: q.lines || [], linked_po_ids: q.linkedPOIds || [], source_contact_id: q.sourceContactId || null,
      calc_total_landed: q.calc_totalLanded, calc_sell_usd: q.calc_sellUSD, calc_sell_gbp: q.calc_sellGBP,
      approved_by: q.approvedBy || '', approved_reason: q.approvedReason || '', approved_at: q.approvedAt || null,
      origin_charges: q.originCharges != null ? q.originCharges : null,
      dest_charges: q.destCharges != null ? q.destCharges : null,
      fpm_admin: q.fpmAdmin != null ? q.fpmAdmin : null
    }).select().single();
    if (result.error) { toast('Migration failed on Quote ' + (q.num||q.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    qteIdMap[q.id] = result.data.id;
  }

  // REQ-CLOUD-004d: outward sweep — every OTHER entity's field that references Quote.id,
  // matched directly against the id-map, never through Quote.linkedPOIds[] (which can
  // already contain a dangling id per PO-GAP-007 — matching linkedPOIds[] itself would
  // not be robust to that; matching PO/Order-Request/Invoice's own fields directly is).
  DB.po.forEach(function(p){ if (qteIdMap[p.quoteId]) p.quoteId = qteIdMap[p.quoteId]; });
  DB.inv.forEach(function(inv){ if (qteIdMap[inv.linkedQuoteId]) inv.linkedQuoteId = qteIdMap[inv.linkedQuoteId]; });
  sv(K.p, DB.po); sv(K.i, DB.inv);

  var touchedOrdIdsForQte = {};
  DB.ord.forEach(function(o){
    if (qteIdMap[o.activeQuoteId]) { o.activeQuoteId = qteIdMap[o.activeQuoteId]; touchedOrdIdsForQte[o.id] = true; }
  });
  sv(K.ord, DB.ord);

  // Outward cross-phase retrofit (REQ-CLOUD-004e): PurchaseOrder.quoteId/Invoice.linkedQuoteId
  // above are safe as plain local fixes — neither entity has a Supabase table. Order
  // Request is different: it already has one (REQ-CLOUD-003), and refreshOrdFromSupabase()
  // fires from at least eight call sites once Order Request has migrated (an ordinary
  // saveOrd()/delOrd(), persistOrdChange() itself by default, delCon()'s cascade,
  // executeDataCleanup(), the other retrofit sweeps) — any of which could run within
  // seconds of this migration completing. A purely-local activeQuoteId fix left in place
  // past this point would be silently reverted by whichever fires first. Pushed here,
  // synchronously, before this function returns.
  if (Object.keys(touchedOrdIdsForQte).length) {
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (touchedOrdIdsForQte[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }

  // Archive the true pre-migration snapshot BEFORE remapping DB.qt's own ids below.
  localStorage.setItem('st_qt_pre_migration', localStorage.getItem(K.qt));
  localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());

  DB.qt.forEach(function(q){ if (qteIdMap[q.id]) q.id = qteIdMap[q.id]; });
  sv(K.qt, DB.qt);

  await refreshQteFromSupabase();
  if (G('cfg-sb-qt-restore-btn')) G('cfg-sb-qt-restore-btn').style.display = '';
  toast('Quote migration complete. Pre-migration data archived for 30 days.');
}
```

`PurchaseOrder.quoteNum`/`Invoice.linkedQuoteNum` are confirmed to need no sweep — business-key strings, unaffected by an id remap.

### 2.8 Archive/rollback extensions

`restoreQteMigrationArchive()` — new, inserted after `restoreOrdMigrationArchive()` closes (`index.html:5982`).

```js
function restoreQteMigrationArchive() {
  var arch = localStorage.getItem('st_qt_pre_migration');
  if (!arch) { toast('No Quote migration archive available to restore.'); return; }
  if (!confirm('Restore Quotes to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, or any other document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Quotes — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.qt, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_qt_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

`cleanupExpiredMigrationArchive()` (`index.html:5984-6006`) — extend with a fifth independently-timed block, inserted immediately after the existing Order Request block (`index.html:6001-6004`) closes, before the function's own closing `}`:

```js
  var qtTs = localStorage.getItem('st_qt_cloud_migration_ts');
  if (qtTs && (Date.now() - new Date(qtTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_qt_pre_migration');
    localStorage.removeItem('st_qt_cloud_migration_ts');
  }
```

`rCfg()` (`index.html:10561-10564`, the four existing `cfg-sb-*-restore-btn` visibility lines) — add a fifth restore-button visibility line, immediately after the Order Request one (`index.html:10564`), before the `cfg-lang` line that follows it:

```js
  if(G('cfg-sb-qt-restore-btn')) G('cfg-sb-qt-restore-btn').style.display = localStorage.getItem('st_qt_cloud_migration_ts') ? '' : 'none';
```

### 2.9 Retrofit `migrateSuppliersBuyersToSupabase()` — add Quote touched-tracking and cross-phase push

Current sweep (`index.html:5723-5748`):

```js
  // REQ-CLOUD-001i: rewrite every existing local reference field
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; }); });
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
```

New:

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

### 2.10 Retrofit `migrateLineItemsToSupabase()` — add Quote touched-tracking and cross-phase push

Current sweep (`index.html:5796-5802`):

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  DB.po.forEach(function(po){ (po.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
  // Quote.lines[].lid is confirmed dead (never populated by any code path) —
  // checked anyway, never skipped, per index.html's own stated convention there.
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(ql){ if (liIdMap[ql.lid]) ql.lid = liIdMap[ql.lid]; }); });
  sv(K.i, DB.inv); sv(K.p, DB.po); sv(K.qt, DB.qt);
```

New:

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

### 2.11 Retrofit `migrateContactsToSupabase()` — add Quote touched-tracking and cross-phase push

Current sweep (`index.html:5858-5876`):

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  var touchedOrdIdsForCon = {};
  DB.ord.forEach(function(o){
    if (conIdMap[o.contactId]) { o.contactId = conIdMap[o.contactId]; touchedOrdIdsForCon[o.id] = true; }
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (conIdMap[r.contactId]) { r.contactId = conIdMap[r.contactId]; touchedOrdIdsForCon[o.id] = true; } });
    });
  });
  DB.qt.forEach(function(q){ if (conIdMap[q.sourceContactId]) q.sourceContactId = conIdMap[q.sourceContactId]; });
  sv(K.ord, DB.ord); sv(K.qt, DB.qt);

  // REQ-CLOUD-003e: same cross-phase fix as migrateSuppliersBuyersToSupabase() — push
  // to Supabase too if Order Request has already migrated, not just the local mirror.
  if (Object.keys(touchedOrdIdsForCon).length) {
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (touchedOrdIdsForCon[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }
```

New:

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  var touchedOrdIdsForCon = {};
  DB.ord.forEach(function(o){
    if (conIdMap[o.contactId]) { o.contactId = conIdMap[o.contactId]; touchedOrdIdsForCon[o.id] = true; }
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (conIdMap[r.contactId]) { r.contactId = conIdMap[r.contactId]; touchedOrdIdsForCon[o.id] = true; } });
    });
  });
  var touchedQteIdsForCon = {};
  DB.qt.forEach(function(q){ if (conIdMap[q.sourceContactId]) { q.sourceContactId = conIdMap[q.sourceContactId]; touchedQteIdsForCon[q.id] = true; } });
  sv(K.ord, DB.ord); sv(K.qt, DB.qt);

  // REQ-CLOUD-003e: same cross-phase fix as migrateSuppliersBuyersToSupabase() — push
  // to Supabase too if Order Request has already migrated, not just the local mirror.
  if (Object.keys(touchedOrdIdsForCon).length) {
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (touchedOrdIdsForCon[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }

  // REQ-CLOUD-004e: same cross-phase fix, for Quote.
  if (Object.keys(touchedQteIdsForCon).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForCon[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }
```

### 2.12 Retrofit `migrateOrdToSupabase()` — add Quote touched-tracking and cross-phase push

Current sweep (`index.html:5913-5921`):

```js
  // REQ-CLOUD-003d: exhaustive external-reference sweep — only Quote.lines[].sourceOrdId
  // needs rewriting; sourceOrdLineId/sourceRfqResponseId point at nested children that
  // are never remapped (REQ-CLOUD-003 §1.2) — checked anyway, never silently skipped.
  DB.qt.forEach(function(q){
    (q.lines||[]).forEach(function(l){
      if (ordIdMap[l.sourceOrdId]) l.sourceOrdId = ordIdMap[l.sourceOrdId];
    });
  });
  sv(K.qt, DB.qt);
```

New:

```js
  // REQ-CLOUD-003d: exhaustive external-reference sweep — only Quote.lines[].sourceOrdId
  // needs rewriting; sourceOrdLineId/sourceRfqResponseId point at nested children that
  // are never remapped (REQ-CLOUD-003 §1.2) — checked anyway, never silently skipped.
  var touchedQteIdsForOrd = {};
  DB.qt.forEach(function(q){
    (q.lines||[]).forEach(function(l){
      if (ordIdMap[l.sourceOrdId]) { l.sourceOrdId = ordIdMap[l.sourceOrdId]; touchedQteIdsForOrd[q.id] = true; }
    });
  });
  sv(K.qt, DB.qt);

  // REQ-CLOUD-004e: cross-phase fix for Quote — this is the newest of the four retrofitted
  // sweeps (built alongside REQ-CLOUD-003, before Quote was Cloud-eligible) and the one
  // whose original author could not have retrofitted at the time.
  if (Object.keys(touchedQteIdsForOrd).length) {
    for (var qi = 0; qi < DB.qt.length; qi++) {
      if (touchedQteIdsForOrd[DB.qt[qi].id]) await persistQteChange(DB.qt[qi], true);
    }
    await refreshQteFromSupabase();
  }
```

### 2.13 `pullAll()` — exclude `'qt'` once migrated

Current (`index.html:4446-4449`, `4527-4538`):

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
```

```js
  var simpleEnts = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  ...
  if (_sb) simpleEnts = simpleEnts.filter(function(e){ return e !== 'sup'; });
  ...
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'co'; });
```

New — one line added to each block:

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'qt'; });
```

```js
  var simpleEnts = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  ...
  if (_sb) simpleEnts = simpleEnts.filter(function(e){ return e !== 'sup'; });
  ...
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'qt'; });
```

No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

### 2.14 Settings UI (`index.html:799-806`, inside the Cloud Data card group)

New card inserted immediately after the existing "Cloud Data (Order Requests)" card:

```html
<div class="card">
  <div class="ct">Cloud Data (Quotes)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="migrateQteToSupabase()">Migrate Quotes to Cloud</button>
    <button class="btn btn-g" id="cfg-sb-qt-restore-btn" style="display:none;" onclick="restoreQteMigrationArchive()">Restore Pre-Migration Quotes</button>
  </div>
  <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Independent of Supplier/Contact/Order Request migration — Quote lines stay embedded with the Quote, so no other entity needs to migrate first. Uses the same Supabase connection configured above.</p>
</div>
```

### 2.15 `AI_SYSTEM_PROMPT` and `docs/user-guide.md` — Cloud Data description updated

Current (`index.html:9581`):

```
'Cloud Data (REQ/SPEC-CLOUD-001/002/003): Settings → Cloud Data lets an operator connect a shared Supabase database. Each of Supplier/Buyer, Line Item, Contact, and Order Request migrates independently, on its own schedule, via its own "Migrate ... to Cloud" button — a colleague on a different device/browser only sees the shared copy of an entity once that entity has actually been migrated, gated by a separate Supabase sign-in (distinct from the app password). Quote and Purchase Order are not yet Cloud-Data-eligible — they, and every other entity, stay local-only regardless of what has migrated. Each migration requires a full backup export first (mandatory, blocking) and archives that entity\'s pre-migration data locally for 30 days as a rollback safety net. The "Ad-Hoc" default Buyer never migrates and always stays local. Order Request\'s lines and RFQ Responses migrate embedded with their parent record — no separate migration or precondition for them, and they can migrate independently of whether Contact has. If nothing is configured, nothing changes — every entity behaves exactly as before Cloud Data existed.',
```

New:

```
'Cloud Data (REQ/SPEC-CLOUD-001/002/003/004): Settings → Cloud Data lets an operator connect a shared Supabase database. Each of Supplier/Buyer, Line Item, Contact, Order Request, and Quote migrates independently, on its own schedule, via its own "Migrate ... to Cloud" button — a colleague on a different device/browser only sees the shared copy of an entity once that entity has actually been migrated, gated by a separate Supabase sign-in (distinct from the app password). Purchase Order is not yet Cloud-Data-eligible — it, and every other entity, stays local-only regardless of what has migrated. Each migration requires a full backup export first (mandatory, blocking) and archives that entity\'s pre-migration data locally for 30 days as a rollback safety net. The "Ad-Hoc" default Buyer never migrates and always stays local. Order Request\'s and Quote\'s lines migrate embedded with their parent record — no separate migration or precondition for them, and each can migrate independently of whether Supplier, Contact, or the other has. If nothing is configured, nothing changes — every entity behaves exactly as before Cloud Data existed.',
```

`docs/user-guide.md`'s Cloud Data section (rewritten most recently in `REQ-CLOUD-003`) gets the identical update — Quote added to the list of independently-migratable entities, Purchase Order named as the sole remaining non-eligible one. Exact diff (spec-gate round-1 A6 advisory — the heading and both paragraphs at `docs/user-guide.md:75-85`):

Current:

```
## Cloud Data (Supplier & Buyer, Line Item, Contact, Order Request)

By default, all your data lives only in your own browser. **Cloud Data** (Settings → Cloud Data) is an optional feature that connects a shared Supabase database, so a colleague on a different device or browser can see the exact same records as you. It is not a single on/off switch — Supplier & Buyer, Line Item, Contact, and Order Request each migrate independently, on their own schedule, via their own "Migrate ... to Cloud" button in the same settings area. Quote and Purchase Order are not yet Cloud-Data-eligible and always stay local, along with every other entity (Invoices, Shipments, Payments, etc.) regardless of what has migrated.
```

New:

```
## Cloud Data (Supplier & Buyer, Line Item, Contact, Order Request, Quote)

By default, all your data lives only in your own browser. **Cloud Data** (Settings → Cloud Data) is an optional feature that connects a shared Supabase database, so a colleague on a different device or browser can see the exact same records as you. It is not a single on/off switch — Supplier & Buyer, Line Item, Contact, Order Request, and Quote each migrate independently, on their own schedule, via their own "Migrate ... to Cloud" button in the same settings area. Purchase Order is not yet Cloud-Data-eligible and always stays local, along with every other entity (Invoices, Shipments, Payments, etc.) regardless of what has migrated.
```

Line 85's list of "Migrate ... to Cloud" button names similarly gains "Migrate Quotes to Cloud" alongside the existing four.

### 2.16 No changes needed

Confirmed by `REQ-CLOUD-004` §1.4/§3: `delSup()`, `delCon()` (`CON-GAP-004`, deferred), `delPO()` (`PO-GAP-007`, deferred to `REQ-CLOUD-005`), `executeDataCleanup()`'s renumbering pairs list (Quote's `num` confirmed absent, same as Invoice/PO/Credit-Note) and phantom filter (structural no-op for migrated data, identical reasoning to `REQ-CLOUD-003`), the `create_quote` AI action (pre-fills only), and `migrateLinkedPOIds()` (left on `saveAll()` — a cloud-hosted Quote row can never carry the legacy scalar it looks for, since a full-backup restore re-runs it before any render and a Supabase `linked_po_ids` column is always `jsonb`). No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`).

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness unchanged (already fully generic per-table). **Spec-gate round-1 B7 finding:** the original draft of this section gave two contradictory placement instructions (insert before the CLOUD-003 cleanup test vs. insert as a dedicated block after it) — corrected here to match this file's own real, established precedent: `SPEC-CLOUD-003`'s own test section was itself appended *after* `SPEC-CLOUD-002`'s cleanup test (`tests/run.js:7748`, immediately following the `'…Line Item…Contact…'` cleanup test), not inserted before it. This SPEC's block follows the identical convention.

### 3.0 Required companion retrofit of a pre-existing CLOUD-003 test (spec-gate round-1 B1 finding — §0.1)

Before inserting any new test, retrofit the pre-existing test `'initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding...)'` (`tests/run.js:7752`) in place — do not duplicate it. Add `quotes: { selectData: [] }` to its `_sb` mock config, and stub `ctx.refreshQteFromSupabase` alongside the existing `ctx.refreshOrdFromSupabase` stub, restoring both afterward:

Current (`tests/run.js:7752-7766`):

```js
testAsync('initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding: previously wired for Supplier/Buyer/Line Item/Contact but not Order Request)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){}; // keep the mock _sb below in place instead of overwriting it with a real client
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshOrd = ctx.refreshOrdFromSupabase;
  ctx.refreshOrdFromSupabase = function(){ called = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshOrdFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshOrdFromSupabase = origRefreshOrd;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
});
```

New:

```js
testAsync('initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding: previously wired for Supplier/Buyer/Line Item/Contact but not Order Request)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){}; // keep the mock _sb below in place instead of overwriting it with a real client
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshOrd = ctx.refreshOrdFromSupabase;
  ctx.refreshOrdFromSupabase = function(){ called = true; return Promise.resolve(); };
  // SPEC-CLOUD-004 spec-gate round-1 B1 finding: initCloudDataLayer() now also calls
  // refreshQteFromSupabase() after refreshOrdFromSupabase() — stub it too, or the real
  // function runs unmocked against DB.qt (empty at this point) and permanently sets
  // st_qt_cloud_migration_ts, corrupting every later test that touches Quote.
  var origRefreshQte = ctx.refreshQteFromSupabase;
  ctx.refreshQteFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshOrdFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshOrdFromSupabase = origRefreshOrd; ctx.refreshQteFromSupabase = origRefreshQte;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
});
```

Verified empirically: without this retrofit, applying every other diff in this SPEC breaks this test itself (self-marks `st_qt_cloud_migration_ts` on the unmocked `quotes` table) and, downstream, the pre-existing `migrateOrdToSupabase` round-trip test (which then wrongly believes Quote has already migrated). With the retrofit and nothing else changed, both pass.

### 3.1 New test block

Insert this entire block (ending with its own dedicated cleanup test, §3.1's final test) immediately **after** the existing `'SPEC-CLOUD-003 test-hygiene cleanup'` test (`tests/run.js:8291-8295`) — the same convention `SPEC-CLOUD-003`'s own block followed relative to `SPEC-CLOUD-002`'s cleanup test.

```js
// ── CLOUD DATA — Quote (SPEC-CLOUD-004) ──

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
  ctx._sb = null; // spec-gate round-1 A4 advisory: reset explicitly, matching every other test in this block
});

testAsync('refreshQteFromSupabase — refuses to overwrite real local data when this device has never run the migration; proceeds when local data is empty (second-device case); sets its own marker on success; omits originCharges/destCharges/fpmAdmin keys entirely when Supabase returns null for them', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.DB.qt.push({ id: 'local-only-qt', num: 'QTE-0001', client: 'Local', lines: [] });
  ctx._sb = mockSb({ quotes: { selectData: [] } });
  await ctx.refreshQteFromSupabase();
  assertEqual(ctx.DB.qt.length, 1, 'real local Quote NOT wiped — this device never ran the migration');
  assertEqual(ctx.DB.qt[0].id, 'local-only-qt', 'original record untouched');

  resetDB();
  ctx._sb = mockSb({ quotes: { selectData: [{ id: 'cloud-qt-1', num: 'QTE-0001', client: 'Cloud Client', dt: '2026-01-01', valid_until: '', currency: 'USD', freight_mode: 'LCL', markup: 15, status: 'Draft', notes: '', lines: [], linked_po_ids: [], source_contact_id: null, calc_total_landed: 0, calc_sell_usd: 0, calc_sell_gbp: 0, approved_by: '', approved_reason: '', approved_at: null, origin_charges: null, dest_charges: null, fpm_admin: null }] } });
  await ctx.refreshQteFromSupabase();
  assertEqual(ctx.DB.qt.length, 1, 'real Cloud Data correctly loaded');
  assertEqual(ctx.DB.qt[0].id, 'cloud-qt-1', 'loaded from Supabase');
  assertEqual('originCharges' in ctx.DB.qt[0], false, 'originCharges key omitted entirely, not set to null, when never overridden');
  assert(!!ctx.localStorage.getItem('st_qt_cloud_migration_ts'), 'marker set even though this device never ran the migration itself');
});

testAsync('migrateQteToSupabase — inserts every field, preserves nested lines unchanged including nested ids, sweeps PurchaseOrder.quoteId/Invoice.linkedQuoteId locally and Order Request.activeQuoteId via persistOrdChange when Order Request has migrated', async function() {
  resetDB();
  ctx.DB.qt.push({
    id: 'q1', num: 'QTE-0001', client: 'Acme', dt: '2026-01-01', validUntil: '', currency: 'USD',
    freightMode: 'LCL', markup: 15, status: 'Accepted', notes: '',
    lines: [{ rid: 'r1', supId: 's1', desc: 'Widget', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0, markup: 15, priceHistory: [] }],
    linkedPOIds: [], sourceContactId: 'c1', calc_totalLanded: 10, calc_sellUSD: 12, calc_sellGBP: 9,
    approvedBy: 'Jane', approvedReason: '', approvedAt: '2026-01-01T00:00:00.000Z'
  });
  ctx.DB.po.push({ id: 'po1', num: 'PO-QTE-0001-1', supId: 's1', quoteId: 'q1', quoteNum: 'QTE-0001', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV10001', linkedQuoteId: 'q1', linkedQuoteNum: 'QTE-0001', lineItems: [] });
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: null, stage: 'Quoted', activeQuoteId: 'q1', actions: [], outcome: null, lines: [] });
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString()); // Order Request already migrated
  ctx.localStorage.setItem(ctx.K.qt, JSON.stringify(ctx.DB.qt)); // migrateQteToSupabase() reads localStorage[K.qt] for its archive step, not ctx.DB.qt directly

  var sb = mockSb({
    quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); },
      // spec-gate round-1 B3 finding: migrateQteToSupabase() calls refreshQteFromSupabase()
      // at its own tail — with no selectData configured here, that call defaults to an
      // empty result and wipes DB.qt to [] before this test's own assertions run below.
      selectData: [{ id: 'new-qte-uuid', num: 'QTE-0001', client: 'Acme', dt: '2026-01-01', valid_until: '', currency: 'USD',
        freight_mode: 'LCL', markup: 15, status: 'Accepted', notes: '',
        lines: [{ rid: 'r1', supId: 's1', desc: 'Widget', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0, markup: 15, priceHistory: [] }],
        linked_po_ids: [], source_contact_id: 'c1', calc_total_landed: 10, calc_sell_usd: 12, calc_sell_gbp: 9,
        approved_by: 'Jane', approved_reason: '', approved_at: '2026-01-01T00:00:00.000Z',
        origin_charges: null, dest_charges: null, fpm_admin: null }] },
    order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'ord1', num: 'ORD-0001', contact_id: null, stage: 'Quoted', actions: [], active_quote_id: 'new-qte-uuid', outcome: null, lines: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-qt-restore-btn');

  await ctx.migrateQteToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(JSON.stringify(insertCall.row.lines), JSON.stringify([{ rid: 'r1', supId: 's1', desc: 'Widget', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0, markup: 15, priceHistory: [] }]), 'nested lines inserted unchanged, including the nested supId — no inward remap performed by this function itself');

  assertEqual(ctx.DB.po[0].quoteId, 'new-qte-uuid', 'PurchaseOrder.quoteId remapped to the new Quote id');
  assertEqual(ctx.DB.po[0].quoteNum, 'QTE-0001', 'PurchaseOrder.quoteNum confirmed unchanged — business key, not an id');
  assertEqual(ctx.DB.inv[0].linkedQuoteId, 'new-qte-uuid', 'Invoice.linkedQuoteId remapped to the new Quote id');
  assertEqual(ctx.DB.inv[0].linkedQuoteNum, 'QTE-0001', 'Invoice.linkedQuoteNum confirmed unchanged');

  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assert(ordUpdateCall, 'Order Request activeQuoteId pushed to Supabase, not just fixed locally, since Order Request has already migrated');
  assertEqual(ordUpdateCall.row.active_quote_id, 'new-qte-uuid', 'the pushed value is the new Quote id');
  assertEqual(ctx.DB.ord[0].activeQuoteId, 'new-qte-uuid', 'local Order Request mirror also correct after the trailing refresh');

  assertEqual(ctx.DB.qt[0].id, 'new-qte-uuid', 'Quote own id remapped to the Supabase-assigned id');
  var archived = JSON.parse(ctx.localStorage.getItem('st_qt_pre_migration'));
  assertEqual(archived[0].id, 'q1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('migrateQteToSupabase — does NOT push Order Request via persistOrdChange when Order Request has not itself migrated (local-only fix instead)', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', client: 'Acme', status: 'Draft', lines: [] });
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: null, stage: 'Quoted', activeQuoteId: 'q1', actions: [], outcome: null, lines: [] });
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx.localStorage.setItem(ctx.K.qt, JSON.stringify(ctx.DB.qt));

  var sb = mockSb({ quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-qt-restore-btn');

  await ctx.migrateQteToSupabase();

  var ordCall = sb._calls.find(function(c){ return c.table === 'order_requests'; });
  assert(!ordCall, 'no Supabase call attempted for order_requests — Order Request has not migrated');
  assertEqual(ctx.DB.ord[0].activeQuoteId, 'new-qte-uuid', 'activeQuoteId still fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateQteToSupabase — blocked by a duplicate Quote num (exact match); does not insert any row', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0099', client: 'A', status: 'Draft', lines: [] });
  ctx.DB.qt.push({ id: 'q2', num: 'QTE-0099', client: 'B', status: 'Draft', lines: [] });
  var sb = mockSb({ quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); } } });
  ctx._sb = sb;
  mockEl('qt-dup-list');
  await ctx.migrateQteToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked before any insert');
});

testAsync('migrateQteToSupabase — migration succeeds when neither Supplier, Contact, nor Order Request has ever been Cloud-migrated (no precondition exists for Quote)', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', client: 'A', status: 'Draft', lines: [] });
  ctx.localStorage.setItem(ctx.K.qt, JSON.stringify(ctx.DB.qt));
  var sb = mockSb({ quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-qt-restore-btn');
  await ctx.migrateQteToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'insert'; });
  assert(insertCall, 'migration succeeded with nothing else ever migrated — no precondition check exists');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateSuppliersBuyersToSupabase — now also rewrites Quote.lines[].supId, and pushes to Supabase if Quote has already migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.qt.push({ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', supId: 's1' }] });
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-sup-uuid' }, row); } },
    quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', supId: 'new-sup-uuid' }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');

  await ctx.migrateSuppliersBuyersToSupabase();

  assertEqual(ctx.DB.qt[0].lines[0].supId, 'new-sup-uuid', 'Quote lines[].supId remapped locally');
  var qteUpdateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(qteUpdateCall, 'the rewritten Quote was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('migrateLineItemsToSupabase — now also rewrites Quote.lines[].lid when non-dead, and pushes to Supabase if Quote has already migrated (spec-gate round-1 B6 finding — AC-5 names this retrofit but no test previously exercised it)', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', supId: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, cur: 'USD', notes: '', priceHistory: [], invoiceRefs: [] });
  ctx.DB.qt.push({ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', lid: 'l1' }] });
  ctx.localStorage.setItem(ctx.K.l, JSON.stringify(ctx.DB.li));
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } },
    quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', lid: 'new-li-uuid' }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-li-restore-btn');

  await ctx.migrateLineItemsToSupabase();

  assertEqual(ctx.DB.qt[0].lines[0].lid, 'new-li-uuid', 'Quote lines[].lid remapped locally (field is dead in real data today, but the sweep itself is exercised end-to-end)');
  var qteUpdateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(qteUpdateCall, 'the rewritten Quote was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('migrateContactsToSupabase — now also rewrites Quote.sourceContactId, and pushes to Supabase if Quote has already migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 'new-sup-uuid', name: 'ACME' });
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', enquiries: [] });
  ctx.DB.qt.push({ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [], sourceContactId: 'c1' });
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); } },
    quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [], source_contact_id: 'new-con-uuid' }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');

  await ctx.migrateContactsToSupabase();

  assertEqual(ctx.DB.qt[0].sourceContactId, 'new-con-uuid', 'Quote.sourceContactId remapped');
  var qteUpdateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(qteUpdateCall, 'the rewritten Quote was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('migrateOrdToSupabase — pushes Quote to Supabase for its lines[].sourceOrdId sweep if Quote has already migrated', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', sourceOrdId: 'ord1', sourceOrdLineId: 'line1', sourceRfqResponseId: 'rfq1' }] });
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());

  var sb = mockSb({
    order_requests: { insertImpl: function(row){ return Object.assign({ id: 'new-ord-uuid' }, row); } },
    quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'qte-uuid-1', num: 'QTE-0001', status: 'Draft', lines: [{ rid: 'r1', sourceOrdId: 'new-ord-uuid', sourceOrdLineId: 'line1', sourceRfqResponseId: 'rfq1' }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-ord-restore-btn');

  await ctx.migrateOrdToSupabase();

  assertEqual(ctx.DB.qt[0].lines[0].sourceOrdId, 'new-ord-uuid', 'sourceOrdId remapped locally');
  assertEqual(ctx.DB.qt[0].lines[0].sourceOrdLineId, 'line1', 'sourceOrdLineId confirmed unchanged — nested child id never remapped');
  var qteUpdateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(qteUpdateCall, 'the rewritten Quote was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('saveQte — Cloud Data configured and Quote migrated: create calls insert with no client-generated id and resets qt.id to the real one before the Contact/Order-Request conversion side effects run; update calls update().eq(); local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  // spec-gate round-1 B4 finding: saveQte()'s first line is `if (!vQte()) return;`, which
  // requires a non-empty client/date and at least one real line — an empty ctx.cQL plus
  // bare mockEl() (leaving qf-client/qf-dt at '') never reaches any code under test here.
  // saveQteSetup() (tests/run.js:751) is this file's own established helper for exactly
  // this: it mocks every qf-*/ql-*-<rid> field a real save needs.
  ctx.cQL = [{ rid: 'r1', supId: '', desc: 'Test item', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0 }];
  saveQteSetup('r1', 10, 0, 15, '');
  ['qf-origOv','qf-destOv','qf-admOv','qf-approved-by','qf-approved-note'].forEach(function(id){ mockEl(id); });
  var sb = mockSb({ quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); }, selectData: [] } });
  ctx._sb = sb;
  ctx.cConvertOrdId = null;
  await ctx.saveQte();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');

  resetDB();
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.cQL = [{ rid: 'r2', supId: '', desc: 'Test item', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0 }];
  saveQteSetup('r2', 10, 0, 15, '');
  ['qf-origOv','qf-destOv','qf-admOv','qf-approved-by','qf-approved-note'].forEach(function(id){ mockEl(id); });
  ctx._sb = null;
  await ctx.saveQte();
  assertEqual(ctx.DB.qt.length, 1, 'local-only path still pushes directly to DB.qt, unchanged');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
});

testAsync('saveQte — Cloud Data configured, cConvertOrdId set: activeQuoteId written to Order Request is the real Supabase-assigned Quote id, not the client-generated placeholder', async function() {
  resetDB();
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  // spec-gate round-1 B4/B1-adjacent finding: persistOrdChange()'s own cloud branch is
  // gated on st_ord_cloud_migration_ts too — without setting it here, convOrd's update
  // silently takes the LOCAL branch instead and no order_requests update call is ever
  // made, so the very thing this test claims to verify would never be exercised.
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.cQL = [{ rid: 'r1', supId: '', desc: 'Test item', qty: 1, uom: 'pcs', cost: 10, cbm: 1, dg: false, dutyPct: 0 }];
  saveQteSetup('r1', 10, 0, 15, '');
  ['qf-origOv','qf-destOv','qf-admOv','qf-approved-by','qf-approved-note'].forEach(function(id){ mockEl(id); });
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.cConvertOrdId = 'ord1';
  var sb = mockSb({
    quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); }, selectData: [] },
    order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  await ctx.saveQte();
  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assert(ordUpdateCall, 'Order Request pushed');
  assertEqual(ordUpdateCall.row.active_quote_id, 'new-qte-uuid', 'the real Supabase-assigned Quote id was written, not the client-generated uid() placeholder');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('delQte — Cloud Data configured and Quote migrated: soft-delete via update({deleted_at}); local-only behavior unchanged when not migrated; Contact-side reversion logic still runs after either branch', async function() {
  resetDB();
  // spec-gate round-1 B5 finding: delQte()'s first line is `if (!confirm(...)) return;` —
  // every confirm-gated test in this file (e.g. tests/run.js:3817, :7697) sets ctx.confirm
  // to a true-returning stub first; without it here, ctx.confirm is left false by whatever
  // earlier testAsync test last touched it, and delQte() returns before doing anything.
  ctx.confirm = function(){ return true; };
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  // Contact must NOT be Cloud-migrated for this test's own intent (verifying the LOCAL
  // Contact-reversion branch) — the pre-existing "second-device" self-marking test for
  // refreshConFromSupabase() (tests/run.js:7630-7642, Line Item & Contact section) leaves
  // st_con_cloud_migration_ts set with no cleanup of its own, so this cannot be assumed
  // unset without explicitly clearing it here first — confirmed empirically: without this
  // line, delQte()'s Contact-reversion branch wrongly takes the Cloud path against an
  // unconfigured contacts table, calls the real refreshConFromSupabase(), and wipes DB.con.
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.DB.con.push({ id: 'c1', name: 'Bob', email: 'b@b.com', status: 'converted', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', sourceContactId: 'c1', status: 'Draft', lines: [] });
  var sb = mockSb({ quotes: { selectData: [] } });
  ctx._sb = sb;
  await ctx.delQte('q1');
  var updateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(ctx.DB.con[0].status, 'qualified', 'Contact-side reversion logic still ran after the cloud branch');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');

  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001' });
  ctx._sb = null;
  await ctx.delQte('q1');
  assertEqual(ctx.DB.qt.length, 0, 'local-only path still filters DB.qt directly, unchanged');
  ctx.confirm = function(){ return false; }; // restore this file's own default
});

testAsync('qteToPoConvert — Cloud Data configured and Quote migrated: linkedPOIds update pushed via persistQteChange; local-only behavior unchanged when not migrated; PO creation itself always stays local regardless', async function() {
  resetDB();
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0010', status: 'Accepted', currency: 'USD', lines: [{ rid: 'r1', supId: 'sA', desc: 'Item A', qty: 1, cost: 10, uom: 'pcs' }] });
  ctx.EI.qt = 'q1';
  var sb = mockSb({ quotes: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  mockEl('qt-po-btn');
  await ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 1, 'PO still created locally — Purchase Order is not Cloud-Data-eligible');
  var updateCall = sb._calls.find(function(c){ return c.table === 'quotes' && c.op === 'update'; });
  assert(updateCall, 'linkedPOIds update pushed to Supabase via persistQteChange');
  assertEqual(updateCall.row.linked_po_ids.length, 1, 'the pushed row carries the new linkedPOIds');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');

  resetDB();
  ctx.DB.qt.push({ id: 'q2', num: 'QTE-0011', status: 'Accepted', currency: 'USD', lines: [{ rid: 'r1', supId: 'sA', desc: 'Item A', qty: 1, cost: 10, uom: 'pcs' }] });
  ctx.EI.qt = 'q2';
  ctx._sb = null;
  mockEl('qt-po-btn');
  await ctx.qteToPoConvert();
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 1, 'local-only path still updates DB.qt directly, unchanged');
});

test('cleanupExpiredMigrationArchive — Quote archive expires independently of Supplier/Buyer/Line Item/Contact/Order Request', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_qt_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_qt_pre_migration'), null, 'expired Quote archive removed at day 31');
});

test('restoreQteMigrationArchive — restores K.qt and clears SS.supabaseUrl/supabaseAnonKey and its own marker', function() {
  resetDB();
  ctx.localStorage.setItem('st_qt_pre_migration', JSON.stringify([{ id: 'orig-qte', num: 'QTE-0001' }]));
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreQteMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.qt))[0].id, 'orig-qte', 'st_qt restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');
  assertEqual(ctx.localStorage.getItem('st_qt_cloud_migration_ts'), null, 'own marker cleared on restore');
  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('pullAll — drops \'qt\' from the batched pull_all request once its own Cloud Data migration marker is set, independently of every other entity\'s exclusion', async function() {
  // spec-gate round-1 A3 advisory: converted to this file's own established idiom — the
  // precedent li/co exclusion test (tests/run.js:7608) uses testAsync + await ctx.pullAll()
  // + the existing _fetchCallLog mock-fetch harness, rather than a hand-rolled sPost
  // override fired without awaiting pullAll() itself. More robust against any future
  // reordering of pullAll()'s internals.
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx._sb = mockSb({});

  _fetchCallLog = [];
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('qt') >= 0, 'qt still requested — its own migration marker is not set yet');

  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('qt'), -1, 'qt excluded from the batched request once its own migration marker is set');

  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.SS.url = '';
  ctx._sb = null;
});

testAsync('SPEC-CLOUD-004 test-hygiene cleanup — reset _sb and every Quote Cloud Data migration marker this block may have left set, so later unrelated tests are not affected', async function() {
  ctx._sb = null;
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_pre_migration');
});
```

This SPEC's own tests handle their own cleanup with the final test above — do not merge it into the existing `SPEC-CLOUD-003 test-hygiene cleanup` test, which stays scoped to its own five `st_ord_*`/entity keys, mirroring how each prior SPEC's block ends with its own dedicated cleanup test rather than extending an earlier one.

---

## 4. Spec-gate round-1 review-resolution log

Round 1 (dispatched against this SPEC's initial draft) came back **CONDITIONAL PASS** with the following findings, each verified by actually applying every diff to a scratch copy of the real codebase and running the full test suite (not by static reading alone):

- **B1** — `refreshQteFromSupabase()` wired unconditionally into `initCloudDataLayer()` breaks a pre-existing CLOUD-003 test and, downstream, a second one. Fixed: retrofitted the pre-existing test to also stub `refreshQteFromSupabase()` (§3.0, new). Verified: reverting this retrofit alone (with every other fix applied) reproduces the exact downstream failure the reviewer found; re-applying it fixes both.
- **B2** — `refreshQteFromSupabase()`'s `originCharges`/`destCharges`/`fpmAdmin` mapping used `!= null ? val : undefined` inside an object literal, which does not omit the key. Fixed: build the object without the three keys, add them conditionally (§2.1). Verified: reverting this fix alone reproduces the test's own failure.
- **B3** — the primary `migrateQteToSupabase()` test's `quotes` mock had no `selectData`, so the function's own trailing `refreshQteFromSupabase()` call wiped `DB.qt` before assertions ran. Fixed: added a `selectData` row matching the inserted/remapped state (§3.1).
- **B4** — both new `saveQte()` cloud-branch tests never satisfied `vQte()` (empty `cQL`, unfilled `qf-client`/`qf-dt`), so `saveQte()` returned before reaching any code under test. Fixed: both tests now use this file's own `saveQteSetup()` helper plus a real `cQL` line (§3.1).
- **B5** — both `delQte()` scenarios never set `ctx.confirm`, so `delQte()` returned before doing anything. Fixed: added `ctx.confirm = function(){ return true; };` (§3.1). While fixing this, found and fixed a second, related issue in the same test: a pre-existing, unrelated CLOUD-002/003-era test leaves `st_con_cloud_migration_ts` set with no cleanup of its own, which would otherwise make this test's Contact-reversion assertion flaky depending on file-wide test order — this test now explicitly clears that marker itself before running, rather than assuming it unset.
- **B6** — `migrateLineItemsToSupabase()`'s Quote retrofit (AC-5) had a code diff (§2.10) but no test. Fixed: added a dedicated test exercising the `lines[].lid` sweep end-to-end (§3.1).
- **B7** — the SPEC gave two directly contradictory instructions for where to insert the new test block and whether to merge or duplicate the cleanup test. Fixed: corrected to match this file's own real precedent (`SPEC-CLOUD-003`'s block was itself appended *after* `SPEC-CLOUD-002`'s cleanup test, not inserted before it) — restructured as §3.0 (a required retrofit of one pre-existing test) followed by §3.1 (the new block, appended after `SPEC-CLOUD-003 test-hygiene cleanup`, ending with its own dedicated cleanup test).
- **A1/A2** (citation precision) — fixed: corrected `rCfg()`'s citation to its real current lines and added the missing line-anchor for `cleanupExpiredMigrationArchive()`'s new block (§2.8).
- **A3** (pullAll test idiom) — fixed: converted to this file's own established `testAsync` + `await` + `_fetchCallLog` pattern (§3.1), matching the precedent li/co exclusion test instead of a hand-rolled, unawaited `sPost` override.
- **A4** (dangling `ctx._sb`) — fixed: the wiring test now resets `ctx._sb = null` at its end (§3.1).
- **A5** (confusing test title) — fixed: retitled to state the actual (positive) outcome directly (§3.1).
- **A6** (`user-guide.md` diff not given) — fixed: exact before/after text added (§2.15).
- **A7** (redundant render in `saveQte`'s cloud branch) — acknowledged, not changed: genuinely harmless, and avoiding it would require threading a skip-render flag through `refreshQteFromSupabase()` for a purely cosmetic optimization (§2.3).
