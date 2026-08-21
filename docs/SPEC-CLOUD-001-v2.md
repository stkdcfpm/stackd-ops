# SPEC-CLOUD-001-v2: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Implements:** REQ-CLOUD-001-v3 (requirements-gate CONDITIONAL PASS on v1, resolved in v2; council decision APPROVED and formalized in v3).

**Supersedes:** SPEC-CLOUD-001-v1 (independent spec-gate FAIL — 5 blocking findings, verified against live `index.html`). This version fixes all five:

1. **ID-remap was incomplete.** `DB.con[].supplierId` (`index.html:9536`) is a real supplier-ID reference field that v1's migration never touched — post-migration, every Contact linked to a Supplier would silently point at a stale local id. §6 now remaps it in the same pass as `DB.qt`/`DB.po`/`DB.li`.
2. **Stale data outside the Suppliers/Buyers tabs.** v1 only refreshed `DB.sup`/`DB.buy` from Supabase when `showV('sup'|'buy', ...)` ran — every other consumer (Quote-line Supplier dropdown, Line-Item/Contact Supplier dropdowns, Invoice/PO Buyer lookups) kept reading whatever was in `localStorage` at page load, defeating the REQ's own "a colleague's newly added Supplier is visible to me" purpose. §0.3 and §4 move the refresh to app init.
3. **`BUY-ADHOC` was left unaddressed**, despite REQ-CLOUD-001-v2 explicitly assigning this decision to spec-gate. `seedAdHocBuyer()` (`index.html:5332-5336`) creates it with no `num`, and it can never be deleted (`index.html:5409,7538`) — it cannot satisfy the schema's `num text not null unique`. §0.5 and §6 now explicitly exclude it from migration and keep it local-only, permanently.
4. **`showBlockingBackupModal()`'s completion signal was fictional.** v1 claimed the modal tracks "`expAll()`'s own completion" via a promise — but `expAll()` (`index.html:8395` onward) is fully synchronous; the browser gives JS no signal that a downloaded file finished writing to disk. §6 replaces this with an honest, checkbox-gated user attestation, the same class of guarantee `showQuotaModal()` actually provides today.
5. **Buyer-delete was said to "mirror" `delSup()`'s warn-and-allow pattern**, but the real `delBuy()` (`index.html:5473-5482`) hard-blocks deletion when linked invoices exist. §5 now explicitly preserves that existing hard-block behavior rather than replacing it.

Advisory findings from the same review (partial-migration-failure recovery, `st_s`/`st_bu` local-cache handling, test-mock fidelity, `cleanupExpiredMigrationArchive()` wiring, a stale REQ-doc line citation) are also addressed below.

## 0. Design decisions this spec has to make that the REQ left open

1. **Vendoring.** Unchanged from v1: vendor the official `@supabase/supabase-js` UMD bundle as `vendor/supabase-js-v2.min.js`, version-pinned, per the (previously undocumented-in-practice) `DASH-GAP-001` precedent.
2. **Config storage.** Unchanged from v1: `SS.supabaseUrl`/`SS.supabaseAnonKey` on the existing `SS` object (`index.html:2365`, `K.ss` = `'st_ss'` at `index.html:2351`). FM-1 category-2, no new council decision needed.
3. **Auth + refresh timing — revised.** v1 gated both the sign-in prompt and the data refresh to "first time the Suppliers or Buyers tab opens." That leaves every other reader of `DB.sup`/`DB.buy` stale. **Revised decision: `ensureSbAuth()` + a refresh of both arrays run once at app init** (inside `initApp()`, `index.html:10203`), immediately after the existing app password gate succeeds — but only if `SS.supabaseUrl`/`SS.supabaseAnonKey` are already configured. If Supabase isn't configured, this step is a no-op and no operator ever sees anything new (same non-intrusion guarantee v1 was going for, just keyed off configuration rather than tab choice). If it is configured:
   - `_sb.auth.getSession()` is checked first; an existing cached session refreshes `DB.sup`/`DB.buy` **silently**, no modal, before any tab is opened.
   - Only when there is no cached session does `openSbLoginModal()` appear, once, at app start — not buried in a specific tab, so every consumer (Quotes, Line Items, Contacts, Invoices, POs, Suppliers, Buyers) gets current data before it's needed.
   - `showV('sup'|'buy', ...)` no longer needs its own `ensureSbAuth()` gate for *reading* (data is already current by the time any tab opens); it keeps calling `ensureSbAuth()` only around writes (save/delete), where a session could have expired mid-use.
4. **Archive key naming and grace period.** Unchanged from v1: 30 days; `st_s_pre_migration`, `st_bu_pre_migration`, `st_cloud_migration_ts`.
5. **`BUY-ADHOC` — new decision, resolving REQ-CLOUD-001-v2's open question 4.** It stays **local-only, permanently, never migrated to Supabase.** It has no `num`, cannot be deleted, and exists purely as a client-side default assignment placeholder (`index.html:5332-5336,5409,7538`) — none of which maps onto a shared multi-user table. `refreshBuyFromSupabase()` re-seeds it locally via the existing `seedAdHocBuyer()` after every refresh, exactly as it already does after import (`index.html:7544`), and it is explicitly excluded from the migration loop (§6). Every real, named Buyer still migrates and becomes shared; the one synthetic placeholder record does not.

## 1. Vendored Supabase client

Unchanged from v1: `vendor/supabase-js-v2.min.js`, official UMD build, version-pinned with a comment recording the exact version, loaded in `<head>` before the main script block. `CLAUDE.md`'s "no dependencies" line gets a one-line acknowledged exception.

## 2. SQL migration file

Unchanged from v1 — `supabase/migrations/0001_suppliers_buyers.sql`, same DDL, RLS policies, and unique indexes as specified in `REQ-CLOUD-001-v2`/`v3` §1.2/§3.1. Applied via the Supabase dashboard/CLI at project-setup time, not run by `index.html`. Public sign-up disabling (REQ-CLOUD-001h) remains a **Settings → Authentication → Auth Providers** dashboard step — out of band of any file this spec can produce, flagged here as a deployment-checklist item.

## 3. Settings — Supabase configuration card

Unchanged from v1: new "Cloud Data" card (`cfg-sb-url`, `cfg-sb-key`), `saveSbConfig()`, modeled on the Integrations card (`index.html:724-726`).

## 4. Client initialization, auth gating, and app-init refresh — revised

```js
var _sb = null;
function initSbClient() {
  if (!SS.supabaseUrl || !SS.supabaseAnonKey) { _sb = null; return; }
  _sb = supabase.createClient(SS.supabaseUrl, SS.supabaseAnonKey);
}

async function ensureSbAuth() {
  if (!_sb) return false; // Supabase not configured — callers treat this as "stay local-only", no toast at init time
  var session = (await _sb.auth.getSession()).data.session;
  if (session) return true;
  return new Promise(function(resolve){
    openSbLoginModal(function(success){ resolve(success); });
  });
}

async function initCloudDataLayer() {
  initSbClient();
  if (!_sb) return; // not configured — every consumer keeps reading local DB.sup/DB.buy exactly as today
  if (await ensureSbAuth()) {
    await refreshSupFromSupabase();
    await refreshBuyFromSupabase();
  }
}
```

`initCloudDataLayer()` is called once from `initApp()` (`index.html:10203`), after `seedAdHocBuyer()`/the existing backfill calls, and awaited before the rest of init proceeds (init is not otherwise async today; this is the one new `await` point, matching how `doImport()` already awaits async work in this codebase). `openSbLoginModal(callback)` is unchanged from v1's contract: email/password sign-in against `_sb.auth.signInWithPassword`, `callback(true|false)`.

`saveSup()`/`delSup()`/`saveBuy()`/the Buyer-delete function each still call `ensureSbAuth()` immediately before their write (a cached session can expire mid-session); this is the only place v1's per-action gating is retained.

## 5. CRUD changes — Suppliers (Buyers mirrors this, entity name substituted — with one named exception below)

**`refreshSupFromSupabase()` — new function:**

```js
async function refreshSupFromSupabase() {
  if (!_sb) return;
  var { data, error } = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (error) { toast('Could not load Suppliers from Cloud Data.'); return; }
  DB.sup = data.map(function(row){
    return { id: row.id, num: row.num, name: row.name, country: row.country, ct: row.contact_name, email: row.email, phone: row.phone, cur: row.currency, notes: row.notes };
  });
  sv(K.s, DB.sup); // keep a local cache in sync — fallback read path if Supabase is briefly unreachable, and keeps expAll() exports fully self-contained (advisory finding #7)
  rSup();
}
```

`refreshBuyFromSupabase()` mirrors this against `buyers`/`DB.buy`/`K.bu`, and additionally calls `seedAdHocBuyer()` immediately after `sv(K.bu, DB.buy)` — restoring the local-only `BUY-ADHOC` record every time, since the Supabase result set never contains it (§0.5).

**`saveSup()` (`index.html:4285-4295`)** — unchanged from v1: `ensureSbAuth()` before the write, `insert`/`update` against `suppliers`, `refreshSupFromSupabase()` after.

**`delSup()` (`index.html:4296-4314`)** — unchanged from v1: soft-delete (`update({deleted_at: ...})`), local `DB.con[].supplierId` nulling preserved, `refreshSupFromSupabase()` after.

**Buyer-delete function — corrected.** The live function is `delBuy()` (`index.html:5473-5482`), and its existing hard-block guard is a deliberate business rule, not a limitation to relax:

```js
async function delBuy(id) {
  if (!id || id === 'BUY-ADHOC') return; // BUY-ADHOC: local-only, never touches Supabase
  var linked = DB.inv.find(function(i){ return i.buyerId === id; });
  if (linked) { alert('Cannot delete: this buyer has linked invoices. Reassign invoices first.'); return; }
  if (!confirm('Delete buyer? This cannot be undone.')) return;
  if (!(await ensureSbAuth())) return;
  var rec = DB.buy.find(function(b){ return b.id === id; });
  var result = await _sb.from('buyers').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (result.error) { toast('Delete failed: ' + result.error.message); return; }
  if (rec) logEv('buyer', rec.id, 'deleted', 'Buyer deleted: ' + rec.name, 'operator');
  await refreshBuyFromSupabase();
  closeM('ov-buy');
  toast('Buyer deleted');
}
```

The hard-block-on-linked-invoices check runs **before** any Supabase call and is otherwise byte-for-byte the existing rule — this spec changes only the storage backend (soft-delete in `suppliers`/`buyers` tables instead of a client-side splice), never the "can this record be deleted at all" business logic. This is a correction to v1, which mis-stated that Buyers "mirror `delSup()`'s" warn-and-allow pattern; they do not, and should not.

`editSup(id)`/`openSup()` — unchanged, as in v1 (coexist with `SPEC-SUP-001`'s Price History panel additions without conflict).

## 6. Migration (REQ-CLOUD-001i, j, k) — revised

```js
async function migrateSuppliersBuyersToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-001j: mandatory blocking backup — checkbox-gated attestation, not a fictional completion promise
  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  // REQ-CLOUD-001f: pre-flight duplicate-name scan (Suppliers only — Buyers already checks this client-side in saveBuy())
  var dupes = findDuplicateSupplierNames(DB.sup);
  if (dupes.length) { showDuplicateConflictModal(dupes); return; }

  var supIdMap = {}, buyIdMap = {};
  for (var i = 0; i < DB.sup.length; i++) {
    var s = DB.sup[i];
    var result = await _sb.from('suppliers').insert({ num: s.num, name: s.name, country: s.country, contact_name: s.ct, email: s.email, phone: s.phone, currency: s.cur, notes: s.notes }).select().single();
    if (result.error) { toast('Migration failed on supplier ' + s.name + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    supIdMap[s.id] = result.data.id;
  }
  for (var j = 0; j < DB.buy.length; j++) {
    var b = DB.buy[j];
    if (b.id === 'BUY-ADHOC') continue; // REQ-CLOUD-001-v2 open question 4: stays local-only, never migrated
    var rb = await _sb.from('buyers').insert({ num: b.num, name: b.name, contact_name: b.contactName, email: b.email, phone: b.phone, address: b.address, currency: b.currency, payment_terms: b.paymentTerms, credit_limit: b.creditLimit, notes: b.notes }).select().single();
    if (rb.error) { toast('Migration failed on buyer ' + b.name + ' — see dr-procedure.md.'); return; }
    buyIdMap[b.id] = rb.data.id;
  }

  // REQ-CLOUD-001i: rewrite every existing local reference field, including DB.con — the field v1 missed
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; }); });
  DB.po.forEach(function(p){ if (supIdMap[p.supId]) p.supId = supIdMap[p.supId]; });
  DB.li.forEach(function(l){ if (supIdMap[l.supId]) l.supId = supIdMap[l.supId]; });
  DB.con.forEach(function(c){ if (c.supplierId && supIdMap[c.supplierId]) c.supplierId = supIdMap[c.supplierId]; });
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) inv.buyerId = buyIdMap[inv.buyerId]; });
  sv(K.qt, DB.qt); sv(K.p, DB.po); sv(K.l, DB.li); sv(K.co, DB.con); sv(K.i, DB.inv);

  // REQ-CLOUD-001k: archive, don't delete, the pre-migration local arrays
  localStorage.setItem('st_s_pre_migration', localStorage.getItem(K.s));
  localStorage.setItem('st_bu_pre_migration', localStorage.getItem(K.bu));
  localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());

  await refreshSupFromSupabase();
  await refreshBuyFromSupabase();
  toast('Migration complete. Pre-migration data archived for 30 days.');
}
```

**On partial failure** (advisory finding #6): the loop is not wrapped in a transaction — Supabase has no client-side multi-row transaction primitive available to the anon-key client — so a failure partway through leaves some rows already inserted. This is now stated explicitly rather than silently possible: the error toast says so, and `docs/dr-procedure.md` (§7) documents the recovery step (manually delete the partially-migrated rows from the Supabase dashboard, or re-run — re-running is not idempotent and will duplicate already-succeeded inserts, so the documented recovery is manual cleanup then retry, not blind retry). Local data is never at risk either way — the local arrays are untouched until every insert in both loops has succeeded.

**`showBlockingBackupModal()` — corrected to an honest mechanism:**

```html
<div class="modal-overlay" id="ov-migration-backup">
  <p><b>Before migrating, export a full backup.</b> This cannot be automatically verified as complete — please confirm you have downloaded and can locate the export file.</p>
  <button onclick="expAll()">Export All Data</button>
  <label><input type="checkbox" id="mig-backup-ack"> I have downloaded and verified the backup file</label>
  <button id="mig-backup-proceed" disabled onclick="...">Proceed with migration</button>
</div>
```

The "Proceed" button stays disabled until the checkbox is checked (wired the same way `showQuotaModal()`'s own dismiss button is already gated in this codebase — a UI-state check, not a fabricated completion signal). This is a weaker guarantee than v1 claimed, but it is the actual guarantee available in a browser with no file-system access, and it is stated as such rather than dressed up as verified completion — matching REQ-CLOUD-001j's requirement that this be "mandatory and blocking, not a dismissible reminder," which a disabled button satisfies without needing a real completion signal.

**Grace-period cleanup — now wired into app init** (advisory finding #9):

```js
function cleanupExpiredMigrationArchive() {
  var ts = localStorage.getItem('st_cloud_migration_ts');
  if (!ts) return;
  var days = (Date.now() - new Date(ts).getTime()) / 86400000;
  if (days > 30) {
    localStorage.removeItem('st_s_pre_migration');
    localStorage.removeItem('st_bu_pre_migration');
    localStorage.removeItem('st_cloud_migration_ts');
  }
}
```

Called from `initApp()` (`index.html:10203`) alongside the other one-time init checks (e.g. `runFPMMigration()`), immediately before `initCloudDataLayer()`.

## 7. `docs/dr-procedure.md` — new rollback section (REQ-CLOUD-001l)

Same fast-path/slow-path structure as v1, with one addition covering the partial-migration-failure case:

```markdown
## Rolling back the Supabase migration (Suppliers & Buyers)

If the Supabase-backed Suppliers/Buyers feature needs to be undone:

1. **Fast path (within 30 days of migration):** redeploy the `index.html` version from immediately before this feature's release. The archived local arrays (`st_s_pre_migration`, `st_bu_pre_migration`) are still present in `localStorage` and resume being read immediately — no data re-entry needed.
2. **Slow path (after the 30-day archive window, or if `localStorage` was cleared):** redeploy the pre-migration `index.html` version, then restore your most recent JSON backup (Settings → Data → Export All, or the mandatory pre-migration backup taken during setup) via Settings → Data → Import.
3. **If migration failed partway through** (some Suppliers/Buyers inserted into Supabase, some not — the app will have shown an error toast naming the record it stopped on): local data was never modified, so no local rollback is needed. In the Supabase dashboard, delete the partially-inserted rows from the `suppliers`/`buyers` tables (a fresh migration is not safe to re-run over a partial one — it will duplicate the already-succeeded inserts), then retry `migrateSuppliersBuyersToSupabase()` from a clean table.
4. In all cases, the Supabase project itself can be left in place or deleted at your discretion — the app no longer depends on it once the prior `index.html` version is running against local data.
```

## GDPR Data Flow

Unchanged from v1: implements `REQ-CLOUD-001`'s own §2.5 assessment (region selection, DPA confirmation remain deployment-time checklist items). The vendored client makes no calls beyond the operator-configured `SS.supabaseUrl`.

## Test Plan (`tests/run.js`)

New suite `Supabase-backed Suppliers/Buyers (SPEC-CLOUD-001)`, mocking `_sb` as a stub client — the mock replaces the module-level `_sb` directly after script load (rather than mocking `fetch`, since the vendored client's internals are not this app's own code to intercept at the network layer); `SS.supabaseUrl`/`supabaseAnonKey` stay unset in fixtures that don't specifically test the configured path, so `initSbClient()`'s real branch never runs in those tests:

- `refreshSupFromSupabase()` — mocked `select` returning 2 rows populates `DB.sup` correctly, field-mapped from snake_case to the app's camelCase shape, and persists to `localStorage` via `sv(K.s, ...)`.
- `refreshSupFromSupabase()` — mocked `select` error shows a toast, does not clear or corrupt the existing `DB.sup`.
- `refreshBuyFromSupabase()` — result set never includes `BUY-ADHOC`; after refresh, `DB.buy` still contains exactly one `BUY-ADHOC` record (re-seeded, not duplicated).
- `saveSup()` — create path calls `insert` with a client-generated `num` but no client-generated `id`; update path calls `update().eq('id', EI.s)`, never `insert`.
- `delSup()` — calls `update({deleted_at: ...})`, never a hard delete; linked-PO/invoice warning logic unaffected (regression test).
- `delBuy()` — a Buyer with a linked invoice is blocked before any Supabase call is made (regression test for the hard-block business rule, distinct from `delSup()`'s warn-and-allow).
- `migrateSuppliersBuyersToSupabase()` — a fixture with two Suppliers sharing a case-insensitive name is blocked by the pre-flight scan before any `insert` call.
- `migrateSuppliersBuyersToSupabase()` — a fixture with one Supplier, one Quote line, one PO, one Line Item, and one Contact all referencing it by old `id`: after migration, all four references match the new mocked `uuid`, not the old `id` (closes the gap v1 left in `DB.con`).
- `migrateSuppliersBuyersToSupabase()` — `BUY-ADHOC` in the fixture `DB.buy` is never sent to `insert` and is not present in `buyIdMap`.
- `migrateSuppliersBuyersToSupabase()` — the backup checkbox unchecked leaves "Proceed" disabled; the function is not invoked until it is checked (UI-state test, not a promise-based completion test).
- `cleanupExpiredMigrationArchive()` — archived keys persist at day 29, are removed at day 31.
- `ensureSbAuth()` — an existing cached session resolves `true` without opening the login modal; no session opens it and resolves based on the modal's outcome.
- `initCloudDataLayer()` — `SS.supabaseUrl` unset: `_sb` stays `null`, no refresh calls made, no modal shown (confirms zero-impact for operators not using this feature).

## Changelog

- v1: Initial spec implementing REQ-CLOUD-001-v3.
- v2: Independent spec-gate FAIL on v1 (5 blocking findings) resolved — `DB.con[].supplierId` added to the ID-remap; auth+refresh moved from tab-gated to app-init-gated so all consumers see current data, not just the Suppliers/Buyers tabs; `BUY-ADHOC` explicitly scoped local-only and excluded from migration (resolving REQ-CLOUD-001-v2's open question 4); `showBlockingBackupModal()` corrected from a fictional promise-based completion signal to an honest checkbox-gated attestation; Buyer-delete corrected to preserve its existing hard-block-on-linked-invoices rule instead of replacing it with `delSup()`'s warn-and-allow pattern. Also addresses all 5 advisory findings (partial-migration-failure documentation, local-cache persistence via `sv(K.s/K.bu, ...)`, test-mock approach clarified, `cleanupExpiredMigrationArchive()` wired into `initApp()`, stale `expAll()` line-citation noted).
