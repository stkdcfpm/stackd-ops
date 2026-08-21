# SPEC-CLOUD-001-v1: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Implements:** REQ-CLOUD-001-v3 (requirements-gate CONDITIONAL PASS on v1, resolved in v2; council decision APPROVED and formalized in v3 — see that file's Council Decision section).

## 0. Design decisions this spec has to make that the REQ left open

REQ-CLOUD-001 fixed the data model, security posture, and backup/rollback conditions in unusual detail for a REQ. What it left to spec-gate:

1. **How does a 100%-client-side, no-build-step app talk to Supabase at all?** This app has never loaded a third-party JS library — `CLAUDE.md`'s own architecture principle is "No build step, no framework, no dependencies," and the CSP (`SEC-GAP-008`) blocks any CDN-loaded script. **Decision: vendor the official `@supabase/supabase-js` UMD bundle as a static file** (e.g. `vendor/supabase-js-v2.min.js`, version-pinned), loaded via `<script src="vendor/supabase-js-v2.min.js">` — same-origin, same precedent already documented (though never yet adopted) for a charting library in `DASH-GAP-001`: "vendored... committed as a same-origin static `.js` file... version pin (no auto-update)." This is the first time that precedent is actually exercised, not a new one invented for this REQ.
2. **Where do the Supabase project URL and anon key live?** Not hardcoded (would repeat `SEC-GAP-001`'s original mistake with the Sheets sync token). **Decision: new fields on the existing `SS` settings object** (`index.html:2365`, `SS = ld(K.ss) || { url, auto, pol, token }` — the established home for operator-entered external-service configuration, already holding the Sheets sync URL/token). Adding `SS.supabaseUrl`/`SS.supabaseAnonKey` is a new-field-on-existing-entity change — FM-1 category-2, already pre-approved, distinct from (and not needing to re-litigate) the council decision already obtained for the architecture itself.
3. **Auth UX — how does "Supabase Auth scoped only to Suppliers/Buyers" actually present to the operator?** The existing app-wide password gate (`AUTH_HASH`) stays exactly as-is for the rest of the app, per REQ-CLOUD-001's scope. **Decision: a second, narrower sign-in prompt appears the first time a session opens the Suppliers or Buyers tab**, using Supabase Auth email/password sign-in. A successful sign-in is cached by the vendored client (session/token refresh handled by the library itself, not hand-rolled) for the remainder of the browser session. This is additive to the existing gate, not a replacement — an operator who hasn't touched Suppliers/Buyers yet never sees it.
4. **Archive key naming and grace period.** REQ-CLOUD-001k left the exact grace period as an open question. **Decision: 30 days**, long enough to catch a "this isn't working" call made days-to-weeks in, short enough not to leave two copies of the same data drifting indefinitely (matches REQ-CLOUD-001-v3's own stated reasoning for picking a number in that range). Archive keys: `st_s_pre_migration`, `st_bu_pre_migration`, plus a `st_cloud_migration_ts` timestamp marking when the grace period started.

## 1. Vendored Supabase client

`vendor/supabase-js-v2.min.js` — the official UMD build, version-pinned (exact version TBD at build time to the latest stable v2.x, recorded in a comment at the top of the vendored file per the `DASH-GAP-001` precedent's own requirement). Loaded in `index.html`'s `<head>`, before the main `<script>` block, alongside a note in `CLAUDE.md`'s "no dependencies" line acknowledging this one exception — directly satisfying `DASH-GAP-001`'s own stated adoption checklist.

## 2. SQL migration file

`supabase/migrations/0001_suppliers_buyers.sql` — the exact DDL already specified in `REQ-CLOUD-001-v2`/`v3` (§1.2, §3.1), reproduced here as an actual committed file rather than left inline in a requirements doc:

```sql
create table suppliers (
  id           uuid primary key default gen_random_uuid(),
  num          text not null unique,
  name         text not null,
  country      text,
  contact_name text,
  email        text,
  phone        text,
  currency     text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create unique index suppliers_name_ci_idx on suppliers (lower(name)) where deleted_at is null;

create table buyers (
  id            uuid primary key default gen_random_uuid(),
  num           text not null unique,
  name          text not null,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  currency      text,
  payment_terms text,
  credit_limit  numeric,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index buyers_name_ci_idx on buyers (lower(name)) where deleted_at is null;

alter table suppliers enable row level security;
alter table buyers enable row level security;

create policy "authenticated read" on suppliers for select using (auth.role() = 'authenticated');
create policy "authenticated write" on suppliers for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on suppliers for update using (auth.role() = 'authenticated');
create policy "authenticated read" on buyers for select using (auth.role() = 'authenticated');
create policy "authenticated write" on buyers for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on buyers for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
```

This file is applied via the Supabase dashboard's SQL editor or CLI migration tooling at project-setup time — it is not run by `index.html` at runtime. Public sign-up (REQ-CLOUD-001h) is disabled via Supabase project **Settings → Authentication → Auth Providers**, a dashboard configuration step, not something expressible in this SQL file or in client code — noted here as a deployment-checklist item, not something this spec can encode.

## 3. Settings — Supabase configuration card

New "Cloud Data" card in Settings, modeled on the existing Integrations card (`index.html:724-726`, the Forwarder Webhook URL pattern):

```html
<div class="ct">Cloud Data (Suppliers & Buyers)</div>
<label>Supabase Project URL</label>
<input type="text" id="cfg-sb-url" placeholder="https://xxxx.supabase.co">
<label>Supabase Anon Key</label>
<input type="text" id="cfg-sb-key" placeholder="anon public key">
```

```js
function saveSbConfig() {
  SS.supabaseUrl = G('cfg-sb-url').value.trim();
  SS.supabaseAnonKey = G('cfg-sb-key').value.trim();
  sv(K.ss, SS);
  initSbClient();
}
```

Loaded into the form the same way `cfg-fwd-webhook` is (`index.html:8025`-style pattern): `if (G('cfg-sb-url')) G('cfg-sb-url').value = SS.supabaseUrl||'';` etc., in the existing Settings-population code path.

## 4. Client initialization and auth gating

```js
var _sb = null;
function initSbClient() {
  if (!SS.supabaseUrl || !SS.supabaseAnonKey) { _sb = null; return; }
  _sb = supabase.createClient(SS.supabaseUrl, SS.supabaseAnonKey);
}
initSbClient(); // called once at app load, after SS is loaded from localStorage

async function ensureSbAuth() {
  if (!_sb) { toast('Configure Supabase in Settings → Cloud Data first.'); return false; }
  var session = (await _sb.auth.getSession()).data.session;
  if (session) return true;
  return new Promise(function(resolve){
    openSbLoginModal(function(success){ resolve(success); });
  });
}
```

`openSbLoginModal(callback)` — a small modal (new markup, following the existing modal-overlay pattern used throughout `index.html`, e.g. `ov-sup`'s structure) with email/password fields and a "Sign in" button calling `_sb.auth.signInWithPassword({ email, password })`, invoking `callback(true)` on success or showing an inline error and `callback(false)` on failure. Exact modal HTML is a minor layout decision for build, not fixed here — the auth call contract above is what's fixed.

`showV('sup', ...)`/`showV('buy', ...)` (the existing tab-dispatch function) is extended: before calling the existing render path, call `await ensureSbAuth()`; if it resolves `false`, do not proceed to render the tab (show a "sign-in required" state instead of a stale/empty table).

## 5. CRUD changes — Suppliers (Buyers mirrors this exactly, entity name substituted)

**`refreshSupFromSupabase()` — new function, populates the existing `DB.sup` array from a live query, does not replace `rSup()`:**

```js
async function refreshSupFromSupabase() {
  if (!_sb) return;
  var { data, error } = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (error) { toast('Could not load Suppliers from Cloud Data.'); return; }
  DB.sup = data.map(function(row){
    return { id: row.id, num: row.num, name: row.name, country: row.country, ct: row.contact_name, email: row.email, phone: row.phone, cur: row.currency, notes: row.notes };
  });
  rSup(); // existing render function, unchanged — renders whatever DB.sup currently holds, exactly as it does today
}
```

Called from `showV`'s Suppliers-tab dispatch (§4) after `ensureSbAuth()` succeeds, and after every save/delete below. `rSup()` itself (the existing table-render function) is **unchanged** — it already renders from `DB.sup`, and doesn't care where that array came from.

**`saveSup()` (`index.html:4285-4295`) — modified:**

```js
async function saveSup() {
  if (!vSup()) return;
  if (!(await ensureSbAuth())) return;
  var _existSup = EI.s ? DB.sup.find(function(x){ return x.id===EI.s; }) : null;
  var row = { name: G('sf-n').value.trim(), country: G('sf-c').value.trim(), contact_name: G('sf-ct').value.trim(), email: G('sf-e').value.trim(), phone: getSupPhone(), currency: G('sf-cur').value, notes: G('sf-nt').value.trim() };
  var result;
  if (EI.s) {
    result = await _sb.from('suppliers').update(row).eq('id', EI.s).select().single();
  } else {
    row.num = nextRefNum(DB.sup, 'SUP');
    result = await _sb.from('suppliers').insert(row).select().single();
  }
  if (result.error) { toast('Save failed: ' + result.error.message); return; }
  closeM('ov-sup');
  await refreshSupFromSupabase();
  audit(EI.s?'UPDATE':'CREATE','supplier', result.data.id, result.data);
  logEv('supplier', result.data.id, EI.s?'updated':'created', 'Supplier ' + result.data.name + (EI.s?' updated':' created'), 'operator');
  toast('Supplier saved');
}
```

`nextRefNum(DB.sup, 'SUP')` (existing helper, unchanged) still computes the next `num` client-side from the in-memory `DB.sup` cache — this is a pre-existing accepted limitation (`DATA-GAP-003`, "friendly reference numbers can diverge across devices/browsers"), not newly introduced here; it applies exactly as much to a Supabase-backed array as it did to a Sheets-synced one, since it's a race on *concurrent creation*, not on storage backend.

**`delSup()` (`index.html:4296-4314`) — modified to soft-delete:**

```js
async function delSup(id) {
  var poCount  = DB.po.filter(function(p){ return p.supId===id; }).length;
  var invRef   = DB.inv.filter(function(i){
    return (i.lineItems||[]).some(function(li){ var cat=DB.li.find(function(x){return x.id===li.lid;}); return cat && cat.supId===id; });
  }).length;
  var warns = [];
  if (poCount > 0)  warns.push(poCount + ' purchase order' + (poCount>1?'s':'') + ' linked to this supplier');
  if (invRef > 0)   warns.push(invRef + ' invoice' + (invRef>1?'s':'') + ' reference items from this supplier');
  var msg = 'Delete this supplier?';
  if (warns.length) msg += '\n\nWarning: ' + warns.join('\n') + '\n\nThe POs and invoices will remain but will show a missing supplier reference.';
  if (!confirm(msg)) return;
  if (!(await ensureSbAuth())) return;
  var _delSup = DB.sup.find(function(s){ return s.id===id; });
  var result = await _sb.from('suppliers').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (result.error) { toast('Delete failed: ' + result.error.message); return; }
  DB.con.forEach(function(c){ if (c.supplierId === id) { c.supplierId = null; c.role = ''; } });
  sv(K.co, DB.con);
  if (_delSup) logEv('supplier', _delSup.id, 'deleted', 'Supplier ' + _delSup.name + ' deleted', 'operator');
  await refreshSupFromSupabase();
  toast('Deleted');
}
```

The linked-PO/invoice warning logic is **unchanged** — it already reads local `DB.po`/`DB.inv`/`DB.li` (which stay local per REQ-CLOUD-001's scope) against `id`, and continues to work correctly *because* REQ-CLOUD-001i's migration (§6 below) has already remapped every local `supId` reference to match the new Supabase `uuid` before this code ever runs against post-migration data.

**`editSup(id)`/`openSup()`** — unchanged from `SPEC-SUP-001`'s wiring (both specs touch the same functions for different, additive reasons — `SPEC-SUP-001`'s Price History panel and this spec's Supabase-backed save path coexist without conflict, since neither rewrites the other's addition).

**Buyers**: `refreshBuyFromSupabase()`, `saveBuy()`, and the Buyer-delete function (name TBD — build-gate should confirm against the actual current function, not assumed here) mirror the above exactly, substituting `buyers`/`DB.buy` and the Buyer field set. Not written out a second time in full — same pattern, same contract.

## 6. Migration (REQ-CLOUD-001i, j, k)

```js
async function migrateSuppliersBuyersToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-001j: mandatory blocking backup, reusing the existing expAll() export
  var backupConfirmed = await showBlockingBackupModal(); // new, modeled directly on showQuotaModal() (index.html:2957-2970)
  if (!backupConfirmed) return;

  // REQ-CLOUD-001f: pre-flight duplicate-name scan (Suppliers only — Buyers already has this check client-side)
  var dupes = findDuplicateSupplierNames(DB.sup); // new helper: groups by lower(name), returns groups with >1 member
  if (dupes.length) { showDuplicateConflictModal(dupes); return; } // surfaces conflicts, does not proceed

  // Insert and build the old-id -> new-uuid map
  var idMap = {};
  for (var i = 0; i < DB.sup.length; i++) {
    var s = DB.sup[i];
    var result = await _sb.from('suppliers').insert({ num: s.num, name: s.name, country: s.country, contact_name: s.ct, email: s.email, phone: s.phone, currency: s.cur, notes: s.notes }).select().single();
    if (result.error) { toast('Migration failed on supplier ' + s.name + ': ' + result.error.message); return; }
    idMap[s.id] = result.data.id;
  }
  // (mirrored for DB.buy -> buyers, own idMap)

  // REQ-CLOUD-001i: rewrite every existing local reference field in the same pass
  DB.qt.forEach(function(q){ (q.lines||[]).forEach(function(l){ if (idMap[l.supId]) l.supId = idMap[l.supId]; }); });
  DB.po.forEach(function(p){ if (idMap[p.supId]) p.supId = idMap[p.supId]; });
  DB.li.forEach(function(l){ if (idMap[l.supId]) l.supId = idMap[l.supId]; });
  sv(K.qt, DB.qt); sv(K.p, DB.po); sv(K.l, DB.li);
  // (mirrored: DB.inv[].buyerId rewritten via the Buyer idMap)

  // REQ-CLOUD-001k: archive, don't delete, the pre-migration local arrays
  localStorage.setItem('st_s_pre_migration', localStorage.getItem(K.s));
  localStorage.setItem('st_bu_pre_migration', localStorage.getItem(K.bu));
  localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());

  await refreshSupFromSupabase();
  await refreshBuyFromSupabase();
  toast('Migration complete. Pre-migration data archived for 30 days.');
}
```

`showBlockingBackupModal()` — new function, structurally identical to `showQuotaModal()` (`index.html:2957-2970`): a full-screen overlay, no dismiss button that bypasses the export, only proceeds once `expAll()` has actually been invoked (tracked via a promise resolved from `expAll()`'s own completion, not merely the button being clicked) — directly implements REQ-CLOUD-001j's "mandatory and blocking, not a dismissible reminder" requirement using the exact UX weight already established for the equivalent quota-exceeded risk.

**Grace-period cleanup**, checked once at app load:

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

## 7. `docs/dr-procedure.md` — new rollback section (REQ-CLOUD-001l)

New section appended to the existing DR procedure doc:

```markdown
## Rolling back the Supabase migration (Suppliers & Buyers)

If the Supabase-backed Suppliers/Buyers feature needs to be undone:

1. **Fast path (within 30 days of migration):** redeploy the `index.html` version from immediately before this feature's release. The archived local arrays (`st_s_pre_migration`, `st_bu_pre_migration`) are still present in `localStorage` and resume being read immediately — no data re-entry needed.
2. **Slow path (after the 30-day archive window, or if `localStorage` was cleared):** redeploy the pre-migration `index.html` version, then restore your most recent JSON backup (Settings → Data → Export All, or the mandatory pre-migration backup taken during setup) via Settings → Data → Import.
3. In both cases, the Supabase project itself can be left in place or deleted at your discretion — the app no longer depends on it once the prior `index.html` version is running against local data.
```

## GDPR Data Flow

Unchanged in substance from `REQ-CLOUD-001`'s own assessment (§2.5) — this spec implements what that REQ already required (region selection, DPA confirmation remain deployment-time checklist items, not something this spec's code can enforce). One addition: the vendored client library (§1) makes no calls anywhere except to the operator-configured `SS.supabaseUrl` — no telemetry, no additional third-party endpoint, confirmed by using only the official client's documented `createClient`/`from`/`auth` surface, nothing else.

## Test Plan (`tests/run.js`)

New suite `Supabase-backed Suppliers/Buyers (SPEC-CLOUD-001)` — mocking `_sb` as a stub client (`{ from: function(){...}, auth: {...} }`) rather than a live Supabase project, consistent with this repo's existing `fetch`-mocking pattern for the Google Sheets sync tests:

- `refreshSupFromSupabase()` — mocked `select` returning 2 rows populates `DB.sup` correctly, field-mapped from snake_case columns to the app's existing camelCase shape.
- `refreshSupFromSupabase()` — mocked `select` error shows a toast, does not clear or corrupt the existing `DB.sup`.
- `saveSup()` — create path calls `insert` with a client-generated `num` but no client-generated `id` (Supabase assigns the `uuid`); update path calls `update().eq('id', EI.s)`, never `insert`.
- `delSup()` — calls `update({deleted_at: ...})`, never any method resembling a hard `delete`.
- `delSup()`'s linked-PO/invoice warning — unaffected by the Supabase change, still computed from local `DB.po`/`DB.inv`/`DB.li` (regression test against the pre-existing behavior).
- `migrateSuppliersBuyersToSupabase()` — a fixture with two Suppliers sharing a case-insensitive name is blocked by the pre-flight scan before any `insert` call is made.
- `migrateSuppliersBuyersToSupabase()` — a fixture with one Supplier and one Quote line referencing it by old `id`: after migration, the Quote line's `supId` matches the new mocked `uuid`, not the old `id`.
- `migrateSuppliersBuyersToSupabase()` — `showBlockingBackupModal()` returning `false` (backup not completed) halts migration before any `insert` call.
- `cleanupExpiredMigrationArchive()` — archived keys persist at day 29, are removed at day 31 (boundary test around the 30-day threshold).
- `ensureSbAuth()` — an existing cached session resolves `true` without opening the login modal; no session opens it and resolves based on the modal's outcome.

## Changelog

- v1: Initial spec implementing REQ-CLOUD-001-v3.
