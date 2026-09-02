# SPEC-CLOUD-003 — Order Request Cloud Data migration

**Status:** v1 — drafted against `docs/REQ-CLOUD-003-v1.md` (requirements-gate PASS, 3 rounds). Spec-gate round 1: FAIL (6 blocking, 4 advisory), fixed in place. See §4. Ready for spec-gate round 2.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **Nested-array embedding** (`REQ-CLOUD-003` §1.2): `order_requests.lines` is one `jsonb` column. Order Request Line and RFQ Response ids are never remapped — they keep their existing `uid()` string values. Only the parent Order Request's own top-level id is swept (into `Quote.lines[].sourceOrdId`).
- **No Supplier/Contact-migration-completion precondition** (§1.2/§2b): nothing inside a `jsonb` blob can be constrained by Postgres, so there is nothing to gate on. `contact_id`/`active_quote_id` are plain nullable columns, deliberately not FK-constrained.
- **`persistOrdChange(ord)` shared helper** (§1.4/§2c): eleven mutation sites (confirmed exhaustive across three requirements-gate rounds, the last two of which found and added real missed sites) call this instead of their current `sv(K.ord, DB.ord)`/`saveAll()`.
- **`.supId`-only retrofit to `migrateSuppliersBuyersToSupabase()`**, plus a symmetric "push if Order Request has already migrated" fix applied to that retrofit *and* to `migrateContactsToSupabase()`'s already-correct `.contactId` sweep (§1.3/§2.5).

## 0.1 A design decision this SPEC must add: `saveOrd()` cannot simply call `persistOrdChange()`

Ten of the eleven mutation sites operate on an **already-existing** Order Request (a record whose `id` is already set, whether a local `uid()` string or a Supabase UUID). `persistOrdChange(ord)` is designed for exactly that shape: push an update. `saveOrd()` is the one site that also **creates** a brand-new Order Request — and for the Cloud-Data-configured case, creating one must `insert()` into Supabase and let Postgres assign the real `id`/mint `num` via `nextRefNum()` only after determining there's no existing row, exactly mirroring `saveCon()`/`saveLI()`'s own internal `if (existing) {update} else {insert}` shape (`index.html:11736-11781` region for `saveCon()`, similarly for `saveLI()`). Folding this into `persistOrdChange()` would conflate two different operations (insert-with-id-assignment vs. update-of-known-id) under one signature. **`saveOrd()` therefore gets its own full `_sb`-branch restructuring, matching `saveCon()`/`saveLI()`'s established shape exactly; `persistOrdChange()` is used by the other ten sites**, all of which never create a new Order Request.

## 0.2 A real ripple effect this SPEC must handle: two callers depend on `saveOrd()`'s synchronous return value

`saveOrd()` is currently a plain (non-`async`) function whose two callers depend on its **synchronous** return value's truthiness to decide whether to proceed:

- `saveOrdFromForm()` (`index.html:3681-3698`): `var saved = saveOrd(ord); if (!saved) return; closeM('ov-ord'); rOrd(); toast(...)`.
- `processImport('ord')`'s per-submission loop (`index.html:8639-8712`, the `saveOrd()` call at `8703`): `var saved = saveOrd(ordObj); if (saved) { ... }`.

If `saveOrd()` becomes `async` without also fixing these two callers, `saved` becomes a `Promise` object — **always truthy**, regardless of what it resolves to. `saveOrdFromForm()`'s `if (!saved) return;` guard (the one thing preventing `closeM()`/`rOrd()`/the success toast from firing on a validation failure) would silently stop working. This is not a hypothetical edge case; it is the normal path every time an operator tries to save an Order Request with no Contact selected. **Fix:** `saveOrdFromForm()` becomes `async` and `await`s `saveOrd()` (safe — its only caller is a bare `onclick`, never itself awaited). `processImport('ord')`'s branch requires more care: it currently calls `saveOrd()` inside an `Object.keys(bySubmission).forEach(...)` callback (`index.html:8647-8707`) — `Array.prototype.forEach` does not await an `async` callback, so simply marking that callback `async` would let every submission's `saveOrd()` call fire concurrently, out of order, with the trailing `sv(K.co, DB.con); sv(K.ord, DB.ord); rCon(); rOrd(); rDash();` (`index.html:8709`) executing before any of them resolve. **Fix:** that `forEach` loop is rewritten as a `for...of` loop with `await saveOrd(ordObj)` inside, and `processImport()` itself becomes `async` (harmless for its other, unchanged branches — its own caller, a `FileReader.onload` handler at `index.html:8398`, already doesn't await it, matching the established fire-and-forget convention for user-triggered async work).

---

## 1. New SQL migration: `supabase/migrations/0003_order_requests.sql`

```sql
-- SPEC-CLOUD-003: extends the Cloud Data shared-database layer to Order Request.
--
-- Order Request Lines and their nested RFQ Responses stay embedded as a single
-- `lines` jsonb column, never promoted to child tables — nothing outside the
-- parent Order Request needs to resolve a nested child id to a new value after
-- migration (REQ-CLOUD-003 §1.2). `contact_id` and `active_quote_id` are
-- deliberately NOT foreign-key-constrained: Contact may not have migrated (and
-- Quote is not Cloud-Data-eligible at all yet) at the point an Order Request
-- migrates, and a real FK constraint here would reject exactly the case
-- REQ-CLOUD-003's AC-2 requires to work (an install where Contact has never
-- been Cloud-migrated).
--
-- Both columns are `text`, NOT `uuid` (spec-gate round-1 B1 finding): uid()
-- (index.html:2788) mints local ids like "lz3k9a1x2", never RFC-4122 format,
-- and every Contact created before Contact's own Cloud migration, plus every
-- Quote for the entire lifetime of this sub-phase (Quote migration is
-- REQ-CLOUD-004, still future), carries an id in that shape. A `uuid`-typed
-- column would reject those values outright with "invalid input syntax for
-- type uuid" on the very first insert/update that references one.

create table order_requests (
  id               uuid primary key default gen_random_uuid(),
  num              text not null unique,
  contact_id       text,
  stage            text not null,
  description      text,
  actions          jsonb not null default '[]'::jsonb,
  active_quote_id  text,
  outcome          jsonb,
  lines            jsonb not null default '[]'::jsonb,
  import_batch_id  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

alter table order_requests enable row level security;

create policy "authenticated read" on order_requests for select using (auth.role() = 'authenticated');
create policy "authenticated write" on order_requests for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on order_requests for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
```

No unique-name-index equivalent is needed (Order Request has no `name` field); `num text not null unique` matches every prior entity's ref-number convention.

---

## 2. `index.html` changes

### 2.1 New `refreshOrdFromSupabase()`

Insert immediately after `refreshConFromSupabase()` closes (`index.html:5547`), before `isSupplierMigrationComplete()`.

Unlike `refreshLIFromSupabase()`, no merge-by-id is needed — Order Request has no local-only supplementary field analogous to `invoiceRefs[]` (everything the app reads on an Order Request record lives inside fields this migration maps).

```js
async function refreshOrdFromSupabase() {
  if (!_sb) return;
  if (DB.ord.length > 0 && !localStorage.getItem('st_ord_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('order_requests').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Order Requests from Cloud Data.'); return; }
  DB.ord = result.data.map(function(row){
    return {
      id: row.id, num: row.num, contactId: row.contact_id, stage: row.stage, description: row.description,
      actions: row.actions || [], activeQuoteId: row.active_quote_id || '',
      outcome: row.outcome || { result: null, reason: '', closedAt: null },
      lines: row.lines || [], createdAt: row.created_at, importBatchId: row.import_batch_id || undefined
    };
  });
  sv(K.ord, DB.ord);
  if (!localStorage.getItem('st_ord_cloud_migration_ts')) localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  rOrd();
}
```

Reuses the B1 overwrite-guard and self-marking fixes `REQ-CLOUD-002` needed two separate spec-gate rounds to reach — applied here from the start, per `REQ-CLOUD-003`'s own stated intent.

**`initCloudDataLayer()` (`index.html:5468-5477`) must also be extended** — this is the function that actually runs on every page load (`initCloudDataLayer().catch(...)`, fire-and-forget, `index.html:12753`) and is the only automatic trigger for a second device to ever pull Order Request data. Without this wiring, `refreshOrdFromSupabase()` would exist and pass its own unit tests but never run in practice (spec-gate round-1 B2 finding). Current:

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

New (one line added, after Contact, matching migration-order precedent):

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
  }
}
```

### 2.2 New `isSupplierMigrationComplete()`-adjacent function: none needed

Per §0/REQ-CLOUD-003b, Order Request's own migration has no precondition function to write — `migrateOrdToSupabase()` (§2.4) goes straight from auth to the backup gate.

### 2.3 `persistOrdChange(ord)` — new shared helper

Insert immediately after `refreshOrdFromSupabase()` closes.

```js
async function persistOrdChange(ord, skipRefresh) {
  if (_sb && localStorage.getItem('st_ord_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('order_requests').update({
      num: ord.num, contact_id: ord.contactId || null, stage: ord.stage, description: ord.description,
      actions: ord.actions || [], active_quote_id: ord.activeQuoteId || null,
      outcome: ord.outcome || null, lines: ord.lines || [], import_batch_id: ord.importBatchId || null
    }).eq('id', ord.id);
    if (result.error) { console.warn('[Stackd] persistOrdChange: failed to push Order Request update for ' + ord.id, result.error.message); return; }
    if (!skipRefresh) await refreshOrdFromSupabase();
    return;
  }
  sv(K.ord, DB.ord);
}
```

Note the local (non-`_sb`) branch persists the **entire** `DB.ord` array, not just the passed-in `ord` — this is intentional and matches `sv()`'s own existing semantics everywhere else in the codebase (a full-array localStorage write); the `ord` parameter only matters for the Cloud-Data branch, where a single-row `.update()` is used.

**`skipRefresh` (spec-gate round-1 B6 finding):** the four sites that call `persistOrdChange()` inside a loop over multiple touched Order Requests (§2.7, §2.8, §2.12, §2.13) must pass `true` for this and call `refreshOrdFromSupabase()` themselves exactly once, after the loop, instead of once per record. Calling it once per record inside a multi-record loop is a real bug, not just an inefficiency: `refreshOrdFromSupabase()` wholesale-replaces `DB.ord` from a full-table `select('*')`, and any touched record later in the same loop that hasn't been pushed to Supabase *yet* has its already-applied local fix silently overwritten by its still-stale server copy — this happens on every 2-or-more-touched-record cascade, not only on a push failure. Doing all N pushes first and refreshing once afterward guarantees the single refresh reflects every push's true outcome (including an honest reversion of any push that genuinely failed) without clobbering an already-successful sibling push in between. The ten single-record call sites (§2.10, §2.11) are unaffected and call `persistOrdChange(ord)` with `skipRefresh` omitted, as before.

### 2.4 `saveOrd()` / `delOrd()` — full replacement (`index.html:3029-3062`)

`saveOrd()` gets the full `_sb`-branch restructuring per §0.1; `saveOrd` becomes `async`. `delOrd()` gets a symmetric branch per `REQ-CLOUD-003i` despite being confirmed dead code today (`docs/architecture-data-model-v1.md` §6.3).

```js
async function saveOrd(ord) {
  var existing = ord.id ? DB.ord.find(function(o){ return o.id === ord.id; }) : null;
  var contactExists = ord.contactId ? DB.con.some(function(c){ return c.id === ord.contactId; }) : false;
  if (!contactExists) { vErr('of-contact', 'Please select a valid contact'); return false; }
  vOk('of-contact');
  if (existing && ord.stage !== existing.stage && !ordCanTransition(existing.stage, ord.stage)) {
    vErr('of-stage', 'Cannot move from ' + existing.stage + ' to ' + ord.stage + ' directly — use Admin Override');
    return false;
  }
  vOk('of-stage');
  var movingToQuoted = ord.stage === 'Quoted' && (!existing || existing.stage !== 'Quoted');
  if (movingToQuoted) {
    var unresolvedCount = (ord.lines || []).filter(function(l){ return l.qtyStatus === 'Unknown'; }).length;
    if (unresolvedCount > 0) {
      vWarn('of-stage', unresolvedCount + ' line(s) have unresolved quantity — quoting may be premature');
    }
  }

  if (_sb && localStorage.getItem('st_ord_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return false;
    var row = {
      contact_id: ord.contactId || null, stage: ord.stage, description: ord.description,
      actions: ord.actions || [], active_quote_id: ord.activeQuoteId || null,
      outcome: ord.outcome || { result: null, reason: '', closedAt: null },
      lines: ord.lines || []
    };
    var result;
    if (existing) {
      result = await _sb.from('order_requests').update(row).eq('id', existing.id).select().single();
    } else {
      row.num = nextRefNum(DB.ord, 'ORD');
      row.created_at = new Date().toISOString();
      result = await _sb.from('order_requests').insert(row).select().single();
    }
    if (result.error) { toast('Save failed: ' + result.error.message); return false; }
    await refreshOrdFromSupabase();
    return DB.ord.find(function(o){ return o.id === result.data.id; }) || true;
  }

  if (existing) {
    Object.assign(existing, ord);
  } else {
    ord.id = uid();
    ord.num = nextRefNum(DB.ord, 'ORD');
    ord.createdAt = new Date().toISOString();
    if (!ord.actions) ord.actions = [];
    if (!ord.outcome) ord.outcome = { result: null, reason: '', closedAt: null };
    DB.ord.push(ord);
  }
  sv(K.ord, DB.ord);
  return existing || ord;
}

async function delOrd(id) {
  if (_sb && localStorage.getItem('st_ord_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('order_requests').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshOrdFromSupabase();
    return;
  }
  DB.ord = DB.ord.filter(function(o){ return o.id !== id; });
  sv(K.ord, DB.ord);
}
```

Both callers of `saveOrd()` only check the return value's truthiness (never a specific field), so returning `DB.ord.find(...) || true` on the Cloud-Data create/update path is a safe, minimal change — see §2.9/§2.10 for why those callers need their own fix regardless (the `await` problem, §0.2).

**`row` is built entirely from `ord.*` for every field (spec-gate round-1 B3 finding):** an earlier draft of this SPEC had `active_quote_id`, `outcome`, and `lines` fall back to `existing.*` whenever `existing` was truthy — this silently discarded whatever the caller actually passed for an update. Concretely, `processImport('ord')`'s update-with-new-lines path (§2.14, `index.html:8664-8703`) builds `ordObj.lines = existingLines.concat(newLines)` specifically to append freshly-imported CSV lines onto an existing Order Request, then calls `saveOrd(ordObj)` — the buggy draft's `lines: existing ? (existing.lines || []) : ...` would have sent the *old* `lines` to Supabase and, since `saveOrd()`'s cloud path never reaches the local `Object.assign(existing, ord)`, would also have dropped the new lines from `DB.ord` in-memory once the trailing `refreshOrdFromSupabase()` reloaded the (also-unchanged) server copy. This is also what `saveLI()`/`saveCon()` actually do — both build their cloud-branch `row` entirely from the current caller-supplied values, never substituting `existing.*` for a field the caller is actively setting — so sourcing every field from `ord.*` here is the correct mirror of that precedent, not a departure from it. Every current caller (`saveOrdFromForm()`, `processImport('ord')`) already constructs `ord.lines`/`ord.activeQuoteId`/`ord.outcome` correctly, falling back to `existing.*` itself when it doesn't intend a change — `saveOrd()` doesn't need to duplicate that fallback logic, and duplicating it is exactly what introduced this bug.

### 2.5 `migrateOrdToSupabase()` — new function

Insert immediately after `migrateContactsToSupabase()` closes (after its retrofit in §2.7 below).

```js
async function migrateOrdToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-003b: no Supplier- or Contact-migration-completion precondition — supId/
  // contactId values nested inside RFQ Responses live inside an opaque jsonb blob no
  // Postgres constraint can reach, so there is nothing to validate against.

  // REQ-CLOUD-003h: ORD-#### numbers are generated by nextRefNum(DB.ord, 'ORD'), which
  // scans the current max and increments — no duplicate-producing path exists today
  // outside a genuine concurrent-tab race. Documented no-op, not an oversight.

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var ordIdMap = {};
  for (var i = 0; i < DB.ord.length; i++) {
    var o = DB.ord[i];
    var result = await _sb.from('order_requests').insert({
      num: o.num, contact_id: o.contactId || null, stage: o.stage, description: o.description,
      actions: o.actions || [], active_quote_id: o.activeQuoteId || null, outcome: o.outcome || null,
      lines: o.lines || [], created_at: o.createdAt, import_batch_id: o.importBatchId || null
    }).select().single();
    if (result.error) { toast('Migration failed on Order Request ' + (o.num||o.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    ordIdMap[o.id] = result.data.id;
  }

  // REQ-CLOUD-003d: exhaustive external-reference sweep — only Quote.lines[].sourceOrdId
  // needs rewriting; sourceOrdLineId/sourceRfqResponseId point at nested children that
  // are never remapped (REQ-CLOUD-003 §1.2) — checked anyway, never silently skipped.
  DB.qt.forEach(function(q){
    (q.lines||[]).forEach(function(l){
      if (ordIdMap[l.sourceOrdId]) l.sourceOrdId = ordIdMap[l.sourceOrdId];
    });
  });
  sv(K.qt, DB.qt);

  // Archive the true pre-migration snapshot BEFORE remapping DB.ord's own ids below.
  localStorage.setItem('st_ord_pre_migration', localStorage.getItem(K.ord));
  localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());

  DB.ord.forEach(function(o){ if (ordIdMap[o.id]) o.id = ordIdMap[o.id]; });
  sv(K.ord, DB.ord);

  await refreshOrdFromSupabase();
  if (G('cfg-sb-ord-restore-btn')) G('cfg-sb-ord-restore-btn').style.display = '';
  toast('Order Request migration complete. Pre-migration data archived for 30 days.');
}
```

### 2.6 Archive/rollback extensions

`restoreOrdMigrationArchive()` — new, inserted after `restoreConMigrationArchive()` (`index.html:5812`). Clears its own marker on restore from the start (per `REQ-CLOUD-002`'s round-2 lesson, applied proactively per `REQ-CLOUD-003`'s own §1.5).

```js
function restoreOrdMigrationArchive() {
  var arch = localStorage.getItem('st_ord_pre_migration');
  if (!arch) { toast('No Order Request migration archive available to restore.'); return; }
  if (!confirm('Restore Order Requests to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, or any document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Order Requests — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.ord, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_ord_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

`cleanupExpiredMigrationArchive()` (`index.html:5814-5831`) — extend with a fourth independently-timed block:

```js
  var ordTs = localStorage.getItem('st_ord_cloud_migration_ts');
  if (ordTs && (Date.now() - new Date(ordTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_ord_pre_migration');
    localStorage.removeItem('st_ord_cloud_migration_ts');
  }
```

(Added as a fourth `if` block alongside the existing Supplier/Buyer, Line Item, and Contact blocks, same shape.)

`rCfg()` (`index.html:10177-10191`) — add a fourth restore-button visibility line, immediately after the Contact one:

```js
  if(G('cfg-sb-ord-restore-btn')) G('cfg-sb-ord-restore-btn').style.display = localStorage.getItem('st_ord_cloud_migration_ts') ? '' : 'none';
```

### 2.7 Retrofit `migrateSuppliersBuyersToSupabase()` — add the missing RFQ Response `.supId` sweep, and cross-phase push-awareness

Current sweep (`index.html:5644-5649`):

```js
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; }); });
  DB.po.forEach(function(p){ if (supIdMap[p.supId]) p.supId = supIdMap[p.supId]; });
  DB.li.forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; });
  DB.con.forEach(function(c){ if (c.supplierId && supIdMap[c.supplierId]) c.supplierId = supIdMap[c.supplierId]; });
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) inv.buyerId = buyIdMap[inv.buyerId]; });
  sv(K.qt, DB.qt); sv(K.p, DB.po); sv(K.l, DB.li); sv(K.co, DB.con); sv(K.i, DB.inv);
```

New:

```js
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

(`persistOrdChange()` internally no-ops to a local `sv()` when Order Request hasn't migrated, so this loop is safe to run unconditionally — it becomes a real Supabase push only once `st_ord_cloud_migration_ts` is set. `skipRefresh=true` plus a single trailing `refreshOrdFromSupabase()` avoids the per-iteration-refresh bug described in §2.3's `skipRefresh` note — spec-gate round-1 B6 finding — where refreshing after every touched record can clobber an already-pushed sibling's fix with its still-stale server copy before its own turn in the loop arrives.)

### 2.8 Retrofit `migrateContactsToSupabase()` — apply the same cross-phase push-awareness to its already-correct sweep

Current sweep (`index.html:5759-5767`):

```js
  // REQ-CLOUD-002c: exhaustive external-reference sweep
  DB.ord.forEach(function(o){
    if (conIdMap[o.contactId]) o.contactId = conIdMap[o.contactId];
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (conIdMap[r.contactId]) r.contactId = conIdMap[r.contactId]; });
    });
  });
  DB.qt.forEach(function(q){ if (conIdMap[q.sourceContactId]) q.sourceContactId = conIdMap[q.sourceContactId]; });
  sv(K.ord, DB.ord); sv(K.qt, DB.qt);
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

(Same `skipRefresh=true` + single trailing refresh reasoning as §2.7 — spec-gate round-1 B6 finding.)

### 2.9 `saveOrdFromForm()` — becomes `async`, awaits `saveOrd()`

Current (`index.html:3681-3698`):

```js
function saveOrdFromForm() {
  ...
  var saved = saveOrd(ord);
  if (!saved) return;
  closeM('ov-ord');
  rOrd();
  toast('Order Request saved');
}
```

New: only the signature and the `saveOrd()` call line change.

```js
async function saveOrdFromForm() {
  ...
  var saved = await saveOrd(ord);
  if (!saved) return;
  closeM('ov-ord');
  rOrd();
  toast('Order Request saved');
}
```

Its only caller is a bare `onclick="saveOrdFromForm()"` (`index.html:433`), never awaited — safe.

### 2.10 `ordAdminOverride()` / `ordLogLineUpdate()` / `ordConfirmLineUpdate()` / `ordAddLine()` / `saveRfqResponse()` / `delRfqResponse()` / `ordCommitRfqResponse()` — become `async`, call `persistOrdChange()`

All seven become `async function`; their business logic is unchanged, only the trailing persistence line changes. (Advisory, spec-gate round-1 A4: once Order Request is Cloud-migrated, these previously-instant local actions now wait on a Supabase round trip before `closeM()`/`toast()`/re-render fires — an inherited trade-off, identical to `saveCon()`'s already-shipped behavior today, not a new one.) All seven have only bare `onclick` callers (or, for `ordLogLineUpdate`/`ordConfirmLineUpdate`, callers — `ordSetLineStatus`, `ordEditLineField`-equivalent, `ordConfirmLineUpdateUI`, and the AI action handler at `index.html:9878` — that discard the return value and re-render from the already-synchronously-mutated in-memory object), so none need further changes.

```js
async function ordAdminOverride(ordId, newStage, reason) {
  var confirmEl = G('ord-override-confirm');
  if (!confirmEl || confirmEl.value !== 'CONFIRM') { toast('Type CONFIRM exactly to proceed.', 4000); return; }
  if (!reason || !reason.trim()) { toast('A reason is required.', 4000); return; }
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  var oldStage = ord.stage;
  ord.stage = newStage;
  await persistOrdChange(ord);
  logEv('order', ord.id, 'stage_overridden', 'Stage force-changed from ' + oldStage + ' to ' + newStage + ' — reason: ' + reason.trim(), 'operator');
  toast('Order Request stage overridden to ' + newStage);
}
```

(Replaces `saveAll()` — a deliberate, disclosed behavior change per `REQ-CLOUD-003` §1.4: this stops incidentally re-persisting the other eleven `saveAll()` keys, which this function never modifies.)

```js
async function ordLogLineUpdate(ord, lineId, field, newValue, source, note, confirmedBy) {
  if (!ord.lines) return false;
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line) return false;
  if (!line.lineUpdates) line.lineUpdates = [];
  var oldValue = line[field];
  line.lineUpdates.push({
    id: uid(), ts: new Date().toISOString(), source: source,
    field: field, oldValue: oldValue, newValue: newValue, note: note || '',
    confirmedBy: confirmedBy || null
  });
  if (line.lineUpdates.length > ORD_LINE_UPDATES_CAP) {
    line.lineUpdates.splice(0, line.lineUpdates.length - ORD_LINE_UPDATES_CAP);
  }
  if (confirmedBy) line[field] = newValue;
  await persistOrdChange(ord);
  return true;
}
async function ordConfirmLineUpdate(ord, lineId, updateId) {
  if (!ord.lines) return false;
  var line = ord.lines.find(function(l){ return l.id === lineId; });
  if (!line || !line.lineUpdates) return false;
  var entry = line.lineUpdates.find(function(u){ return u.id === updateId; });
  if (!entry || entry.confirmedBy) return false;
  entry.confirmedBy = 'operator';
  line[entry.field] = entry.newValue;
  await persistOrdChange(ord);
  return true;
}
```

```js
async function ordAddLine() {
  if (!EI.ord) { toast('Save the Order Request first, then add line items.', 4000); return; }
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var category = prompt('Category (e.g. "Salt fish"):'); if (category === null) return;
  var itemSpec = prompt('Item / spec:'); if (itemSpec === null) return;
  var orderVolumeQty = prompt('Order volume qty (e.g. "1", "2-3"):') || '';
  var orderVolumeUnit = prompt('Order volume unit (e.g. "container", "pallets"):') || '';
  if (!ord.lines) ord.lines = [];
  ord.lines.push({
    id: uid(), category: category.trim(), itemSpec: itemSpec.trim(),
    orderVolumeQty: orderVolumeQty.trim(), orderVolumeUnit: orderVolumeUnit.trim(),
    packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown',
    sourceCountry: '', variantOption: '', lineUpdates: [],
    rfqResponses: [], committedResponseId: null
  });
  await persistOrdChange(ord);
  ... (rest of the function, rendering, unchanged)
}
```

```js
async function saveRfqResponse() {
  var ord = DB.ord.find(function(o){ return o.id === cRfqOrdId; });
  if (!ord) { closeM('ov-rfq'); return; }
  var line = (ord.lines || []).find(function(l){ return l.id === cRfqLineId; });
  if (!line) { closeM('ov-rfq'); return; }
  var supId = G('rfq-sup').value;
  if (!supId) { vErr('rfq-sup', 'Supplier is required'); return; }
  var costStr = G('rfq-cost').value;
  if (costStr === '' || isNaN(+costStr) || +costStr < 0) { vErr('rfq-cost', 'A valid unit cost is required'); return; }
  vOk('rfq-sup'); vOk('rfq-cost');
  if (!line.rfqResponses) line.rfqResponses = [];
  var newResp = {
    id: uid(), supId: supId, cost: +costStr, currency: G('rfq-cur').value,
    cbm: +G('rfq-cbm').value || 0, dutyPct: +G('rfq-dutypct').value || 0, dg: G('rfq-dg').checked,
    moq: G('rfq-moq').value.trim(), leadTime: G('rfq-leadtime').value.trim(),
    paymentTerms: G('rfq-payterms').value.trim(), notes: G('rfq-notes').value.trim(),
    contactId: G('rfq-con').value || null, ts: new Date().toISOString()
  };
  var wasEditing = !!cRfqEditId;
  if (wasEditing) {
    var idx = line.rfqResponses.findIndex(function(r){ return r.id === cRfqEditId; });
    if (idx > -1) {
      line.rfqResponses[idx] = newResp;
      if (line.committedResponseId === cRfqEditId) line.committedResponseId = newResp.id;
    }
    cRfqEditId = null;
  } else {
    line.rfqResponses.push(newResp);
  }
  await persistOrdChange(ord);
  closeM('ov-rfq');
  renderRfqComparison(cRfqLineId);
  toast(wasEditing ? 'RFQ response updated' : 'RFQ response recorded');
}

async function delRfqResponse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var resp = (line.rfqResponses || []).find(function(r){ return r.id === responseId; });
  if (!resp) return;
  var isCommitted = line.committedResponseId === responseId;
  var msg = isCommitted
    ? 'Delete this RFQ response? It is currently committed — deleting it will un-commit this line, and any Quote already built from it will show a "source pricing changed" warning.'
    : 'Delete this RFQ response?';
  if (!confirm(msg)) return;
  line.rfqResponses = (line.rfqResponses || []).filter(function(r){ return r.id !== responseId; });
  if (isCommitted) line.committedResponseId = null;
  await persistOrdChange(ord);
  renderRfqComparison(lineId);
  toast('RFQ response deleted');
}

async function ordCommitRfqResponse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  line.committedResponseId = (line.committedResponseId === responseId) ? null : responseId;
  await persistOrdChange(ord);
  renderRfqComparison(lineId);
}
```

### 2.11 `saveQte()`'s `convOrd` mutation — persists via `persistOrdChange()`

Current (`index.html:11571-11579`):

```js
  if (cConvertOrdId) {
    var convOrd = DB.ord.find(function(x){ return x.id === cConvertOrdId; });
    if (convOrd) {
      convOrd.activeQuoteId = qt.id;
      if (ordCanTransition(convOrd.stage, 'Quoted')) convOrd.stage = 'Quoted';
      saveAll();
    }
    cConvertOrdId = null;
  }
```

New:

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
```

`saveQte()` is already `async` (fixed by `REQ-CLOUD-002`'s round-4 correction) — no signature change needed here.

### 2.12 `delCon()`'s Order-Request cascade — both branches persist via `persistOrdChange()`

Current (`index.html:11837-11858`):

```js
    DB.ord.forEach(function(o){
      if (o.contactId === id) o.contactId = null;
      (o.lines||[]).forEach(function(l){
        (l.rfqResponses||[]).forEach(function(r){ if (r.contactId === id) r.contactId = null; });
      });
    });
    sv(K.ord, DB.ord);
    // ... (this exact block appears twice: once in the _sb branch, once in the local branch)
```

New (applied identically to both the `_sb` branch, `index.html:11837-11843`, and the local branch, `11851-11858`):

```js
    var touchedOrds = [];
    DB.ord.forEach(function(o){
      var touched = false;
      if (o.contactId === id) { o.contactId = null; touched = true; }
      (o.lines||[]).forEach(function(l){
        (l.rfqResponses||[]).forEach(function(r){ if (r.contactId === id) { r.contactId = null; touched = true; } });
      });
      if (touched) touchedOrds.push(o);
    });
    for (var oi = 0; oi < touchedOrds.length; oi++) { await persistOrdChange(touchedOrds[oi], true); }
    if (touchedOrds.length) await refreshOrdFromSupabase();
```

`delCon()` is already `async` — no signature change needed. Same `skipRefresh=true` + single trailing refresh reasoning as §2.7 (spec-gate round-1 B6 finding).

### 2.13 `executeDataCleanup()`'s renumbering step — pushes to Supabase if Order Request has migrated

`executeDataCleanup()` becomes `async`; its caller `confirmDataCleanup()` (`index.html:9111-9116`, already `async`) awaits it.

Current (`index.html:9118-9155`, relevant excerpt):

```js
function executeDataCleanup() {
  ...
  var renumberedLabels = [];
  [['sup','SUP'], ['li','LI'], ['buy','BUY'], ['con','CON'], ['ord','ORD']].forEach(function(pair) {
    var key = pair[0], prefix = pair[1];
    var changes = renumberEntitySequentially(DB[key], prefix);
    if (changes.length) {
      renumberedLabels.push(DATA_CLEANUP_LABELS[key]);
      changes.forEach(function(c) {
        logEv(DATA_CLEANUP_ENTITY_TYPE[key], c.id, 'renumbered', 'Renumbered from ' + (c.oldNum || '(none)') + ' to ' + c.newNum + ' during data integrity cleanup', 'operator');
      });
    }
  });

  var dangling = verifyFkIntegrityAfterCleanup();
  saveAll();
  renderAll();
  ...
}
```

New:

```js
async function executeDataCleanup() {
  ...
  var renumberedLabels = [];
  var ordRenumberChanges = [];
  [['sup','SUP'], ['li','LI'], ['buy','BUY'], ['con','CON'], ['ord','ORD']].forEach(function(pair) {
    var key = pair[0], prefix = pair[1];
    var changes = renumberEntitySequentially(DB[key], prefix);
    if (key === 'ord') ordRenumberChanges = changes;
    if (changes.length) {
      renumberedLabels.push(DATA_CLEANUP_LABELS[key]);
      changes.forEach(function(c) {
        logEv(DATA_CLEANUP_ENTITY_TYPE[key], c.id, 'renumbered', 'Renumbered from ' + (c.oldNum || '(none)') + ' to ' + c.newNum + ' during data integrity cleanup', 'operator');
      });
    }
  });

  var dangling = verifyFkIntegrityAfterCleanup();
  saveAll();
  // REQ-CLOUD-003 round-2 finding: renumberEntitySequentially(DB.ord,'ORD') touches every
  // Order Request's num, not just corrupted ones, on every "Clean Up Now" click — push each
  // renumbered record to Supabase too if Order Request has already migrated, or the fix is
  // silently reverted by the next refreshOrdFromSupabase(). (The phantom-record filter a few
  // lines above this needs no equivalent fix — a phantom record has no `id` at all, and a
  // Postgres-hosted row always has a real gen_random_uuid()-assigned id, so no cloud-sourced
  // record can ever be phantom; that filter step is a structural no-op for migrated data.)
  if (ordRenumberChanges.length) {
    var ordChangedIds = {};
    ordRenumberChanges.forEach(function(c){ ordChangedIds[c.id] = true; });
    for (var oi = 0; oi < DB.ord.length; oi++) {
      if (ordChangedIds[DB.ord[oi].id]) await persistOrdChange(DB.ord[oi], true);
    }
    await refreshOrdFromSupabase();
  }
  renderAll();
  ...
}
```

(Same `skipRefresh=true` + single trailing refresh reasoning as §2.7 — spec-gate round-1 B6 finding.)

`confirmDataCleanup()`'s one-line change:

```js
async function confirmDataCleanup() {
  closeM('ov-data-cleanup-preview');
  var backupConfirmed = await showDataCleanupBackupModal();
  if (!backupConfirmed) return;
  await executeDataCleanup();
}
```

### 2.14 `processImport('ord')` — `forEach` → `for...of`, `processImport()` becomes `async`

Current (`index.html:8462` function signature; `8647-8712` the `ord` branch):

```js
function processImport(entity, csvText) {
  ...
  else if (entity === 'ord') {
    ...
    Object.keys(bySubmission).forEach(function(sid) {
      ...
      var saved = saveOrd(ordObj);
      if (saved) {
        if (existingOrd) { updated++; } else { added++; }
      }
    });

    sv(K.co, DB.con); sv(K.ord, DB.ord); rCon(); rOrd(); rDash();
    ...
  }
}
```

New (only the `ord` branch's loop shape and the function's own signature change; every other branch — `sup`/`li`/`inv`/`po`/`co` — is untouched and continues to run synchronously inside the now-`async` function body):

```js
async function processImport(entity, csvText) {
  ...
  else if (entity === 'ord') {
    ...
    for (var si = 0; si < Object.keys(bySubmission).length; si++) {
      var sid = Object.keys(bySubmission)[si];
      ... (unchanged body, verbatim)
      var saved = await saveOrd(ordObj);
      if (saved) {
        if (existingOrd) { updated++; } else { added++; }
      }
    }

    sv(K.co, DB.con); rCon(); rOrd(); rDash();
    ...
  }
}
```

Note `sv(K.ord, DB.ord)` is dropped from the trailing line — `saveOrd()` (§2.4) already persists via its own `_sb`-aware branch or its own `sv(K.ord, DB.ord)` call on every iteration, so the old trailing call was already redundant even before this SPEC (confirmed by `REQ-CLOUD-003`'s own round-2 requirements-gate finding, which is why this SPEC does not need a separate `CLOUD-GAP-003` fix for this code path at all — see REQ-CLOUD-003 §3/§7). `sv(K.co, DB.con)` is kept since Contact-creation in this same branch (`index.html:8657-8662`) still bypasses `saveCon()` — a pre-existing, already-logged `CLOUD-GAP-003` instance, unchanged and out of scope here.

`processImport()`'s only caller (`index.html:8398`, a `FileReader.onload` callback) does not await it — safe, matching the established fire-and-forget convention.

### 2.15 Settings UI (`index.html:791-798`, inside the Cloud Data card group)

New card inserted immediately after the existing "Cloud Data (Contacts)" card:

```html
<div class="card">
  <div class="ct">Cloud Data (Order Requests)</div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="migrateOrdToSupabase()">Migrate Order Requests to Cloud</button>
    <button class="btn btn-g" id="cfg-sb-ord-restore-btn" style="display:none;" onclick="restoreOrdMigrationArchive()">Restore Pre-Migration Order Requests</button>
  </div>
  <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Independent of Supplier/Contact migration — Order Request Lines and RFQ Responses stay embedded with the Order Request, so no other entity needs to migrate first. Uses the same Supabase connection configured above.</p>
</div>
```

### 2.16 No changes to `pullAll()`/`syncAll()`/`pushAll()`/`FIELD_MAPS`

Per REQ-CLOUD-003j — Order Request has no existing footprint in any of them.

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness with one small, backward-compatible addition (spec-gate round-1 B6 finding): `cfg.updateError` may now be either a static value (existing behavior, unchanged for every current caller) or a function `(row, id) => errorOrNull`, so a test can make one record's push fail while another succeeds within the same `mockSb()` instance. In `tests/run.js:6993-7002`, both places that read `cfg.updateError` become:

```js
var upErr = typeof cfg.updateError === 'function' ? cfg.updateError(pendingRow, pendingId) : cfg.updateError;
```

used in place of the bare `cfg.updateError` reference in both the `single()` update branch and the `then()` branch.

Also note (spec-gate round-1 B4/B5 findings): every test below whose code path triggers `refreshOrdFromSupabase()` — directly, via `saveOrd()`/`persistOrdChange()`, or via a migration function's trailing refresh — configures `order_requests.selectData` to reflect the state *after* the mutation under test, exactly as the existing `migrateLineItemsToSupabase` precedent test does (`tests/run.js:7303-7346`); an empty or missing `selectData` would wipe `DB.ord` to `[]` partway through the test. Multi-step tests that call cloud-configured Order Request functions more than once use a fresh `mockSb()` per step (`sb1`, `sb2`, ...) with `selectData` matching that step's expected post-mutation state, mirroring the existing Contact-status precedent at `tests/run.js:7685-7696`. And `migrateOrdToSupabase()`'s archive step reads `localStorage[K.ord]` directly, not `ctx.DB.ord` — every test calling it seeds `ctx.localStorage.setItem(ctx.K.ord, ...)` first, exactly as the `migrateLineItemsToSupabase` precedent test's own explanatory comment (`tests/run.js:7309-7313`) warns is necessary.

Insert this block after the existing `SPEC-CLOUD-002` test section.

```js
// ── CLOUD DATA — Order Request (SPEC-CLOUD-003) ──

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

testAsync('refreshOrdFromSupabase — refuses to overwrite real local data when this device has never run the migration; proceeds when local data is empty (second-device case); sets its own marker on success', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx.DB.ord.push({ id: 'local-only-ord', num: 'ORD-0001', contactId: 'c1', stage: 'New', lines: [] });
  ctx._sb = mockSb({ order_requests: { selectData: [] } });
  await ctx.refreshOrdFromSupabase();
  assertEqual(ctx.DB.ord.length, 1, 'real local Order Request NOT wiped — this device never ran the migration');
  assertEqual(ctx.DB.ord[0].id, 'local-only-ord', 'original record untouched');

  resetDB(); // simulates a fresh/second device
  ctx._sb = mockSb({ order_requests: { selectData: [{ id: 'cloud-ord-1', num: 'ORD-0001', contact_id: 'c1', stage: 'New', actions: [], active_quote_id: null, outcome: null, lines: [] }] } });
  await ctx.refreshOrdFromSupabase();
  assertEqual(ctx.DB.ord.length, 1, 'real Cloud Data correctly loaded — nothing local was at risk');
  assertEqual(ctx.DB.ord[0].id, 'cloud-ord-1', 'loaded from Supabase');
  assert(!!ctx.localStorage.getItem('st_ord_cloud_migration_ts'), 'marker set even though this device never ran the migration itself');
});

testAsync('migrateOrdToSupabase — inserts every field, preserves nested lines/rfqResponses unchanged including nested ids, rewrites Quote.lines[].sourceOrdId only', async function() {
  resetDB();
  ctx.DB.ord.push({
    id: 'o1', num: 'ORD-0001', contactId: 'c1', stage: 'Qualifying', description: 'Test order',
    actions: [{ id: 'a1', text: 'Follow up', dueDate: '2026-01-01', done: false, createdAt: '2026-01-01T00:00:00.000Z', completedAt: null }],
    activeQuoteId: '', outcome: { result: null, reason: '', closedAt: null },
    lines: [{ id: 'line1', category: 'Widgets', itemSpec: 'Blue widget', orderVolumeQty: '1', orderVolumeUnit: 'container',
      packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
      rfqResponses: [{ id: 'rfq1', supId: 's1', cost: 10, currency: 'USD', cbm: 1, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '2026-01-01T00:00:00.000Z' }],
      committedResponseId: 'rfq1' }],
    createdAt: '2026-01-01T00:00:00.000Z'
  });
  ctx.DB.qt.push({ id: 'q1', lines: [{ rid: 'r1', sourceOrdId: 'o1', sourceOrdLineId: 'line1', sourceRfqResponseId: 'rfq1' }] });
  // migrateOrdToSupabase()'s archive step reads localStorage[K.ord] directly, not ctx.DB.ord,
  // so this must not be left to whatever an unrelated earlier test happened to leave behind
  // (spec-gate round-1 B5 finding — same pitfall the migrateLineItemsToSupabase precedent
  // test's own comment at tests/run.js:7309-7313 warns about).
  ctx.localStorage.setItem(ctx.K.ord, JSON.stringify(ctx.DB.ord));

  var sb = mockSb({ order_requests: { insertImpl: function(row){ return Object.assign({ id: 'new-ord-uuid' }, row); },
    selectData: [{ id: 'new-ord-uuid', num: 'ORD-0001', contact_id: 'c1', stage: 'Qualifying', description: 'Test order',
      actions: [{ id: 'a1', text: 'Follow up', dueDate: '2026-01-01', done: false, createdAt: '2026-01-01T00:00:00.000Z', completedAt: null }],
      active_quote_id: null, outcome: { result: null, reason: '', closedAt: null },
      lines: [{ id: 'line1', category: 'Widgets', itemSpec: 'Blue widget', orderVolumeQty: '1', orderVolumeUnit: 'container',
        packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
        rfqResponses: [{ id: 'rfq1', supId: 's1', cost: 10, currency: 'USD', cbm: 1, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '2026-01-01T00:00:00.000Z' }],
        committedResponseId: 'rfq1' }] }] } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-ord-restore-btn');

  await ctx.migrateOrdToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(JSON.stringify(insertCall.row.lines), JSON.stringify([{ id: 'line1', category: 'Widgets', itemSpec: 'Blue widget', orderVolumeQty: '1', orderVolumeUnit: 'container',
    packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
    rfqResponses: [{ id: 'rfq1', supId: 's1', cost: 10, currency: 'USD', cbm: 1, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '2026-01-01T00:00:00.000Z' }],
    committedResponseId: 'rfq1' }]), 'nested lines/rfqResponses inserted unchanged, including nested ids (line1, rfq1) never remapped');

  assertEqual(ctx.DB.qt[0].lines[0].sourceOrdId, 'new-ord-uuid', 'Quote.lines[].sourceOrdId remapped to the new Order Request id');
  assertEqual(ctx.DB.qt[0].lines[0].sourceOrdLineId, 'line1', 'sourceOrdLineId confirmed unchanged — nested child id never remapped');
  assertEqual(ctx.DB.qt[0].lines[0].sourceRfqResponseId, 'rfq1', 'sourceRfqResponseId confirmed unchanged — nested child id never remapped');

  assertEqual(ctx.DB.ord[0].id, 'new-ord-uuid', 'Order Request own id remapped to the Supabase-assigned id');
  var archived = JSON.parse(ctx.localStorage.getItem('st_ord_pre_migration'));
  assertEqual(archived[0].id, 'o1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateOrdToSupabase — no precondition blocks migration when neither Supplier nor Contact has ever been Cloud-migrated', async function() {
  resetDB();
  ctx.DB.ord.push({ id: 'o1', num: 'ORD-0001', contactId: 'c1', stage: 'New', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  var sb = mockSb({ order_requests: { insertImpl: function(row){ return Object.assign({ id: 'new-ord-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-ord-restore-btn');
  await ctx.migrateOrdToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'insert'; });
  assert(insertCall, 'migration succeeded with no Supplier/Contact ever migrated — no precondition check exists');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateSuppliersBuyersToSupabase — now also rewrites RFQ Response supId (round-1 bug fix), and pushes to Supabase if Order Request has already migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.ord.push({ id: 'ord-uuid-1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null,
    lines: [{ id: 'line1', rfqResponses: [{ id: 'rfq1', supId: 's1' }], committedResponseId: null }] });
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString()); // Order Request already migrated

  var sb = mockSb({
    suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-sup-uuid' }, row); } },
    order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'ord-uuid-1', num: 'ORD-0001', contact_id: null, stage: 'Qualifying', actions: [], active_quote_id: null, outcome: null,
        lines: [{ id: 'line1', rfqResponses: [{ id: 'rfq1', supId: 'new-sup-uuid' }], committedResponseId: null }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');

  await ctx.migrateSuppliersBuyersToSupabase();

  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].supId, 'new-sup-uuid', 'RFQ Response supId remapped locally');
  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assert(ordUpdateCall, 'the rewritten Order Request was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('migrateSuppliersBuyersToSupabase — does NOT push to Supabase when Order Request has not itself migrated (no marker set)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.ord.push({ id: 'local-ord-1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null,
    lines: [{ id: 'line1', rfqResponses: [{ id: 'rfq1', supId: 's1' }], committedResponseId: null }] });
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');

  var sb = mockSb({ suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-sup-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');

  await ctx.migrateSuppliersBuyersToSupabase();

  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].supId, 'new-sup-uuid', 'RFQ Response supId still remapped locally');
  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests'; });
  assert(!ordUpdateCall, 'no Supabase call attempted for order_requests — Order Request has not migrated');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — existing RFQ Response contactId sweep still correct, and now also pushes to Supabase if Order Request has already migrated', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 'new-sup-uuid', name: 'ACME' }); // already-migrated Supplier, satisfies precondition
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', enquiries: [] });
  ctx.DB.ord.push({ id: 'ord-uuid-1', num: 'ORD-0001', contactId: 'c1', stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null,
    lines: [{ id: 'line1', rfqResponses: [{ id: 'rfq1', supId: 's1', contactId: 'c1' }], committedResponseId: null }] });
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString()); // Supplier migration precondition
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString()); // Order Request already migrated

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); } },
    order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
      selectData: [{ id: 'ord-uuid-1', num: 'ORD-0001', contact_id: 'new-con-uuid', stage: 'Qualifying', actions: [], active_quote_id: null, outcome: null,
        lines: [{ id: 'line1', rfqResponses: [{ id: 'rfq1', supId: 's1', contactId: 'new-con-uuid' }], committedResponseId: null }] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');

  await ctx.migrateContactsToSupabase();

  assertEqual(ctx.DB.ord[0].contactId, 'new-con-uuid', 'top-level Order Request contactId remapped');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, 'new-con-uuid', 'nested RFQResponse.contactId remapped — confirms the sweep was already correct');
  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assert(ordUpdateCall, 'the rewritten Order Request was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('saveOrd — Cloud Data configured and Order Request migrated: create calls insert with client-generated num but no client-generated id; update calls update().eq(); local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'c1', name: 'Alice' });
  var sb = mockSb({ order_requests: { insertImpl: function(row){ return Object.assign({ id: 'new-ord-uuid' }, row); },
    selectData: [{ id: 'new-ord-uuid', num: 'ORD-0001', contact_id: 'c1', stage: 'New', description: 'Test', actions: [], active_quote_id: null, outcome: null, lines: [] }] } });
  ctx._sb = sb;
  var saved = await ctx.saveOrd({ contactId: 'c1', stage: 'New', description: 'Test', actions: [], lines: [] });
  assert(saved, 'save succeeded');
  assertEqual(saved.id, 'new-ord-uuid', 'returned the actual found record after refresh, not just the bare true sentinel (spec-gate round-1 A2 fix)');
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');

  resetDB();
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx.DB.con.push({ id: 'c1', name: 'Alice' });
  ctx._sb = null;
  var savedLocal = await ctx.saveOrd({ contactId: 'c1', stage: 'New', description: 'Local test', actions: [], lines: [] });
  assert(savedLocal, 'local save succeeded');
  assertEqual(ctx.DB.ord.length, 1, 'local-only path still pushes directly to DB.ord, unchanged');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('delOrd — Cloud Data configured and Order Request migrated: soft-delete via update({deleted_at}); local-only behavior unchanged when not migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ order_requests: { selectData: [] } });
  ctx._sb = sb;
  await ctx.delOrd('o1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');

  resetDB();
  ctx.DB.ord.push({ id: 'o1', num: 'ORD-0001' });
  ctx._sb = null;
  await ctx.delOrd('o1');
  assertEqual(ctx.DB.ord.length, 0, 'local-only path still filters DB.ord directly, unchanged');
});

testAsync('ordAdminOverride / ordAddLine / saveRfqResponse / delRfqResponse / ordCommitRfqResponse / ordLogLineUpdate / ordConfirmLineUpdate — each persists via persistOrdChange(), Supabase when migrated, local sv() otherwise', async function() {
  // Each Cloud-Data-configured step below uses its OWN mockSb() instance with selectData
  // reflecting THAT step's expected post-mutation state (spec-gate round-1 B4 finding) —
  // a single shared instance with static/empty selectData would have the first step's
  // trailing refreshOrdFromSupabase() wipe DB.ord before the second step ever runs,
  // mirroring the existing Contact-status precedent at tests/run.js:7685-7696.
  resetDB();
  ctx.DB.ord.push({ id: 'o1', num: 'ORD-0001', contactId: 'c1', stage: 'New', actions: [], activeQuoteId: '', outcome: null,
    lines: [{ id: 'l1', rfqResponses: [{ id: 'r1', supId: 's1' }], committedResponseId: null, lineUpdates: [] }] });
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());

  var sb1 = mockSb({ order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
    selectData: [{ id: 'o1', num: 'ORD-0001', contact_id: 'c1', stage: 'Lost', actions: [], active_quote_id: null, outcome: null,
      lines: [{ id: 'l1', rfqResponses: [{ id: 'r1', supId: 's1' }], committedResponseId: null, lineUpdates: [] }] }] } });
  ctx._sb = sb1;
  mockEl('ord-override-confirm').value = 'CONFIRM';
  await ctx.ordAdminOverride('o1', 'Lost', 'test reason');
  assert(sb1._calls.some(function(c){ return c.table === 'order_requests' && c.op === 'update'; }), 'ordAdminOverride pushed via persistOrdChange');
  assertEqual(ctx.DB.ord[0].stage, 'Lost', 'stage change reflected after refresh');

  var sb2 = mockSb({ order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
    selectData: [{ id: 'o1', num: 'ORD-0001', contact_id: 'c1', stage: 'Lost', actions: [], active_quote_id: null, outcome: null,
      lines: [{ id: 'l1', rfqResponses: [{ id: 'r1', supId: 's1' }, { id: 'r2', supId: 's1', cost: 5, currency: 'USD' }], committedResponseId: null, lineUpdates: [] }] }] } });
  ctx._sb = sb2;
  ctx.EI.ord = 'o1';
  ctx.cRfqOrdId = 'o1'; ctx.cRfqLineId = 'l1'; ctx.cRfqEditId = null;
  mockEl('rfq-sup').value = 's1'; mockEl('rfq-cost').value = '5'; mockEl('rfq-cur').value = 'USD';
  mockEl('rfq-cbm').value = '1'; mockEl('rfq-dutypct').value = '0'; mockEl('rfq-dg').checked = false;
  mockEl('rfq-moq').value = ''; mockEl('rfq-leadtime').value = ''; mockEl('rfq-payterms').value = ''; mockEl('rfq-notes').value = ''; mockEl('rfq-con').value = '';
  await ctx.saveRfqResponse();
  assert(sb2._calls.some(function(c){ return c.table === 'order_requests' && c.op === 'update'; }), 'saveRfqResponse pushed via persistOrdChange');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses.length, 2, 'new RFQ response reflected after refresh');

  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx._sb = null;
  await ctx.ordCommitRfqResponse('l1', 'r1');
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.ord))[0].lines[0].committedResponseId, 'r1', 'local-only path still persists via sv(K.ord,...), unchanged');
});

test('cleanupExpiredMigrationArchive — Order Request archive expires independently of Supplier/Buyer/Line Item/Contact', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_ord_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_ord_pre_migration'), null, 'expired Order Request archive removed at day 31');
});

test('restoreOrdMigrationArchive — restores K.ord and clears SS.supabaseUrl/supabaseAnonKey and its own marker', function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_pre_migration', JSON.stringify([{ id: 'orig-ord', num: 'ORD-0001' }]));
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreOrdMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.ord))[0].id, 'orig-ord', 'st_ord restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');
  assertEqual(ctx.localStorage.getItem('st_ord_cloud_migration_ts'), null, 'own marker cleared on restore');
  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('saveQte — Order-Request-side convOrd mutation persists via persistOrdChange(), Supabase when Order Request migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.cConvertOrdId = 'ord1';
  ['qf-client','qf-nt','qf-num','qf-dt','qf-valid','qf-cur'].forEach(function(id){ mockEl(id); });
  var sb = mockSb({ order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveQte();
  var updateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assert(updateCall, 'Order Request activeQuoteId/stage pushed to Supabase');
  assertEqual(updateCall.row.stage, 'Quoted', 'stage transitioned and pushed correctly');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('delCon — Order-Request cascade (contactId + nested rfqResponses[].contactId) persists via persistOrdChange() for each touched Order Request only', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: 'c1', stage: 'New', actions: [], activeQuoteId: '', outcome: null,
    lines: [{ id: 'l1', rfqResponses: [{ id: 'r1', contactId: 'c1' }], committedResponseId: null }] });
  ctx.DB.ord.push({ id: 'ord2', num: 'ORD-0002', contactId: 'c2', stage: 'New', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({ contacts: { selectData: [] }, order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
    selectData: [
      { id: 'ord1', num: 'ORD-0001', contact_id: null, stage: 'New', actions: [], active_quote_id: null, outcome: null,
        lines: [{ id: 'l1', rfqResponses: [{ id: 'r1', contactId: null }], committedResponseId: null }] },
      { id: 'ord2', num: 'ORD-0002', contact_id: 'c2', stage: 'New', actions: [], active_quote_id: null, outcome: null, lines: [] }
    ] } });
  ctx._sb = sb;
  await ctx.delCon('c1');
  var ordUpdateCalls = sb._calls.filter(function(c){ return c.table === 'order_requests' && c.op === 'update'; });
  assertEqual(ordUpdateCalls.length, 1, 'only the touched Order Request (ord1) was pushed, not the untouched one (ord2)');
  var ordSelectCalls = sb._calls.filter(function(c){ return c.table === 'order_requests' && c.op === 'is'; });
  assertEqual(ordSelectCalls.length, 1, 'exactly one refresh for the whole cascade, not one per touched record (B6 fix)');
  assertEqual(ctx.DB.ord[0].contactId, null, 'top-level contactId nulled');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, null, 'nested rfqResponse contactId nulled');
  assertEqual(ctx.DB.ord[1].contactId, 'c2', 'untouched Order Request left alone');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx.confirm = function(){ return false; };
});

testAsync('delCon — Order-Request cascade with a partial push failure: one touched Order Request failing to push does not revert another touched Order Request\'s already-applied fix', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0001', contactId: 'c1', stage: 'New', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.DB.ord.push({ id: 'ord3', num: 'ORD-0003', contactId: 'c1', stage: 'New', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({
    contacts: { selectData: [] },
    order_requests: {
      updateError: function(row, id){ return id === 'ord1' ? { message: 'network error' } : null; }, // ord1's push fails, ord3's succeeds
      selectData: [
        { id: 'ord1', num: 'ORD-0001', contact_id: 'c1', stage: 'New', actions: [], active_quote_id: null, outcome: null, lines: [] }, // server still has the OLD value — its push genuinely failed
        { id: 'ord3', num: 'ORD-0003', contact_id: null, stage: 'New', actions: [], active_quote_id: null, outcome: null, lines: [] }  // server reflects the successful push
      ]
    }
  });
  ctx._sb = sb;
  await ctx.delCon('c1');
  var ordSelectCalls = sb._calls.filter(function(c){ return c.table === 'order_requests' && c.op === 'is'; });
  assertEqual(ordSelectCalls.length, 1, 'exactly one refresh for the whole cascade, even with a partial failure');
  assertEqual(ctx.DB.ord[1].contactId, null, 'ord3\'s successful push is NOT reverted just because ord1\'s push, sharing the same refresh, failed');
  assertEqual(ctx.DB.ord[0].contactId, 'c1', 'ord1 honestly reflects its failed push rather than appearing to have succeeded');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
  ctx.confirm = function(){ return false; };
});

testAsync('executeDataCleanup — renumbered Order Requests pushed to Supabase when migrated; phantom-filter step needs no equivalent fix', async function() {
  resetDB();
  ctx.localStorage.setItem('st_ord_cloud_migration_ts', new Date().toISOString());
  ctx.DB.ord.push({ id: 'ord1', num: 'ORD-0099', contactId: null, stage: 'New', createdAt: '2026-01-01T00:00:00.000Z', actions: [], activeQuoteId: '', outcome: null, lines: [] });
  var sb = mockSb({ order_requests: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); },
    selectData: [{ id: 'ord1', num: 'ORD-0001', contact_id: null, stage: 'New', actions: [], active_quote_id: null, outcome: null, lines: [] }] } });
  ctx._sb = sb;
  mockEl('data-cleanup-status');
  await ctx.executeDataCleanup();
  assertEqual(ctx.DB.ord[0].num, 'ORD-0001', 'renumbered locally');
  var ordUpdateCall = sb._calls.find(function(c){ return c.table === 'order_requests' && c.op === 'update' && c.row.num === 'ORD-0001'; });
  assert(ordUpdateCall, 'renumbered Order Request pushed to Supabase');
  ctx.localStorage.removeItem('st_ord_cloud_migration_ts');
});

testAsync('processImport(\'ord\') — sequential await per submission, not a forEach race; saveOrd() already persists per iteration', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'existing-con', name: 'Bob', email: 'bob@x.com' });
  var csv = 'Submission ID,Contact Email,Contact Name,Category,Item/Spec,Order Volume Qty,Order Volume Unit,Qty Status\n' +
    'sub1,new1@x.com,New One,Widgets,Blue widget,1,container,Unknown\n' +
    'sub2,new2@x.com,New Two,Gadgets,Red gadget,2,pallets,Unknown\n';
  ctx._sb = null;
  await ctx.processImport('ord', csv);
  assertEqual(ctx.DB.ord.length, 2, 'both submissions processed sequentially, not raced');
  assert(ctx.DB.ord.every(function(o){ return !!o.num; }), 'every Order Request got a real, sequentially-assigned num — no interleaving corruption');
});
```

---

## 4. Review-resolution log

**Spec-gate round 1: FAIL — 6 blocking, 4 advisory.** All fixed in place, in this v1 document (no separate v2 file — matching this project's convention of revising a SPEC/REQ in place rather than forking a new version file for gate-fix rounds).

The reviewer confirmed the eleven-mutation-site inventory itself had no drift or omission from REQ-CLOUD-003's own final, thrice-corrected list — independently re-derived from a fresh search of `index.html`, not a re-check of the SPEC's own claims. All findings were implementation-detail defects in how this SPEC executed the REQ's already-passed decisions, not re-litigations of those decisions:

- **B1** (SQL): `contact_id`/`active_quote_id` were typed `uuid` but real Contact/Quote ids are `uid()`-format strings, never RFC-4122 — would have broken REQ's own AC-2 and every Order Request that ever reaches "Quoted". Fixed: both retyped `text` (§1), matching `import_batch_id`'s existing `text` typing in the same table for the same reason.
- **B2** (wiring): `refreshOrdFromSupabase()` was fully specified but never wired into `initCloudDataLayer()` — Order Request would never sync automatically on page load or on a second device. Fixed: one line added to `initCloudDataLayer()` (§2.1), after Contact.
- **B3** (`saveOrd()` data loss): the cloud-branch `row` sourced `active_quote_id`/`outcome`/`lines` from `existing.*` instead of `ord.*`, silently discarding whatever the caller passed — concretely breaking `processImport('ord')`'s update-with-new-lines path, both server-side and locally. Fixed: `row` now built entirely from `ord.*` (§2.4), matching what `saveLI()`/`saveCon()` actually do (verified against their real current code, not assumed).
- **B4** (broken tests): six new tests configured `order_requests` mocks without `selectData` matching post-mutation state, so an internal `refreshOrdFromSupabase()` mid-test wiped `DB.ord` and later assertions threw or failed. Fixed: all six given `selectData` reflecting the expected post-mutation state; the combined multi-step test (§3) split into per-step `mockSb()` instances (`sb1`/`sb2`) mirroring the existing Contact-status precedent.
- **B5** (broken archive assertion): the `migrateOrdToSupabase` field-mapping test never seeded `localStorage[K.ord]`, so its archive assertion could read stale leftover data from an unrelated earlier test. Fixed: seeded explicitly, reusing the exact fix pattern (and warning comment) the `migrateLineItemsToSupabase` precedent test already uses for the same pitfall.
- **B6** (silent revert in multi-record loops): calling `persistOrdChange()` once per touched record inside the four multi-record sites (§2.7/§2.8/§2.12/§2.13) meant an early record's refresh could clobber a not-yet-pushed later record's already-applied local fix with its still-stale server copy — a real bug on any 2+-touched-record cascade, not just a failure case. Fixed: `persistOrdChange()` gained an optional `skipRefresh` parameter (§2.3); all four sites now push every touched record with `skipRefresh=true` and call `refreshOrdFromSupabase()` exactly once afterward. A new partial-failure test (§3, `delCon` cascade) proves one record's failed push no longer reverts a sibling's successful one, and required a small backward-compatible addition to `mockSb()` (functional `updateError`).
- **A1** (`saveOrd()` field-sourcing asymmetry): resolved as a side effect of the B3 fix — every field is now sourced from `ord.*` uniformly.
- **A2** (`saveOrd()` create test didn't exercise its own "found" branch): fixed — `selectData` now includes the newly-created row, and the test asserts `saved.id`, not just truthiness.
- **A3** (`pullAll()`'s harmless `saveAll()` bypass not named alongside REQ §1.4's other accepted exceptions): noted here for completeness, matching this codebase's "checked anyway, never silently skipped" convention — no code change, `pullAll()` has no Order Request footprint (REQ-CLOUD-003 §1.1) so calling `saveAll()` inside it is a no-op for `DB.ord` regardless.
- **A4** (undocumented UI-latency trade-off): one line added to §2.10's intro acknowledging the inherited (not novel) round-trip delay, matching `saveCon()`'s already-shipped behavior.
