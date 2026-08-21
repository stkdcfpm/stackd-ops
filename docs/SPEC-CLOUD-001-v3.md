# SPEC-CLOUD-001-v3: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Implements:** REQ-CLOUD-001-v3 (council decision APPROVED, formalized in that file's Council Decision section).

**Supersedes:** SPEC-CLOUD-001-v2 (independent spec-gate FAIL — 5 blocking findings, verified against live `index.html` on branch `claude/spec-cloud-001-supabase-build`). v2 genuinely fixed 3 of v1's 5 original blocking findings (`DB.con[].supplierId` remap, `BUY-ADHOC` migration exclusion, `delBuy()` behavior preservation) but its fix for the remaining 2, plus its own new mechanism, introduced fresh blocking defects:

1. **`initApp()` is not `async`, and v2's own cited precedent for awaiting `initCloudDataLayer()` was false.** `index.html:10203` is a plain `function initApp()`; `await` inside it is a parse-time `SyntaxError`. v2 cited `doImport()` as prior art for "already awaits async work in this codebase" — `doImport()` (`index.html:8429`) is not `async` and contains no `await`; it uses a `FileReader.onload` callback. This spec now cites the real, correct precedent instead (see §4) and doesn't require `initApp` to change shape at all.
2. **v2's fix for "stale data outside Suppliers/Buyers tabs" placed the auth gate before `renderAll()` — blocking the entire app, not just Suppliers/Buyers, behind a Supabase login.** `renderAll()` (`index.html:3728`) renders every tab (Dashboard, Invoices, POs, everything), not just Suppliers/Buyers. Awaiting `ensureSbAuth()` before it means an operator with no cached Supabase session sees nothing at all until they resolve a login prompt unrelated to the tab they're trying to use — directly contradicting REQ-CLOUD-001's own scope ("Suppliers and Buyers only, everything else stays local"). §4 below fixes this by making the cloud refresh fire-and-forget, run *after* the initial render, never blocking app startup.
3. **`showBlockingBackupModal()`'s citation of `showQuotaModal()`'s "gating" was factually false** — the real `showQuotaModal()` (`index.html:2957-2970`) has an always-clickable, unguarded "Dismiss" button with no `disabled` attribute or checkbox anywhere. §6 below stops citing a precedent that doesn't exist and describes the checkbox-gated Proceed button as the new, purpose-built mechanism it actually is.
4. **`quickAddBuyer()` — a real, separate Buyer-creation path triggered from the Invoice form — was never converted.** `index.html:5350-5362` pushes directly to local `DB.buy` with no Supabase call; post-migration this both hides the new Buyer from other operators and gets silently deleted the next time `refreshBuyFromSupabase()` replaces `DB.buy` wholesale. §5 now converts it.
5. **~9 existing tests in `tests/run.js` call `saveSup`/`delSup`/`saveBuy`/`delBuy` synchronously**, and would break once those functions gain `await` points, with no note in the spec that they need converting. §8 (Test Plan) now states this explicitly as a required deliverable, not an incidental side-effect.

The 2 advisory findings from the same review (archived migration keys are write-only with no restore path, and `refreshBuyFromSupabase()` was left as an unwritten "mirror" risking a wrong render-function name) are also fixed below.

## 0. Design decisions this spec has to make that the REQ left open

1. **Vendoring.** Unchanged from v1/v2: vendor `@supabase/supabase-js` as `vendor/supabase-js-v2.min.js`, per the `DASH-GAP-001` precedent.
2. **Config storage.** Unchanged: `SS.supabaseUrl`/`SS.supabaseAnonKey` on the existing `SS` object (`index.html:2365`).
3. **Auth + refresh timing — revised again.** v2's "gate the whole app at init" over-corrected v1's "gate only the two tabs, leaving everything else stale." **Final decision: never block app startup.** `initCloudDataLayer()` runs as a **fire-and-forget** call immediately after the existing `renderAll()` in `initApp()` — the exact same pattern already used two lines earlier in that same function for `pullAll()` (`index.html:10233-10234`: `if (SS.pol!==false) pullAll().catch(function(){});` — real prior art, unlike v2's false citation). If Supabase isn't configured, it's a no-op, same as today. If configured and a session is already cached, `DB.sup`/`DB.buy` refresh silently in the background within roughly one network round-trip, and `rSup()`/`renderBuyers()` re-render themselves once data lands — the same "render now with whatever's local, reconcile shortly after in the background" model this app already uses for the Sheets pull. If no session is cached, `openSbLoginModal()` appears once, asynchronously, without blocking anything else the operator is doing. **Accepted trade-off, stated plainly:** for the first few seconds after app load, a Supplier/Buyer dropdown opened before the background refresh lands will show local cached data, not live cloud data. This converges automatically, typically well under the time it takes an operator to open a modal and start typing, and is explicitly preferred over blocking the entire app (v2's defect) or leaving every non-Supplier/Buyer view permanently stale (v1's defect).
4. **Archive key naming and grace period.** Unchanged: 30 days; `st_s_pre_migration`, `st_bu_pre_migration`, `st_cloud_migration_ts`.
5. **`BUY-ADHOC`.** Unchanged from v2: local-only, permanently, excluded from migration, re-seeded by `refreshBuyFromSupabase()`.

## 1. Vendored Supabase client

Unchanged from v1/v2.

## 2. SQL migration file

Unchanged from v1/v2.

## 3. Settings — Supabase configuration card

Unchanged from v1/v2.

## 4. Client initialization and background refresh — revised

```js
var _sb = null;
function initSbClient() {
  if (!SS.supabaseUrl || !SS.supabaseAnonKey) { _sb = null; return; }
  _sb = supabase.createClient(SS.supabaseUrl, SS.supabaseAnonKey);
}

async function ensureSbAuth() {
  if (!_sb) return false;
  var session = (await _sb.auth.getSession()).data.session;
  if (session) return true;
  return new Promise(function(resolve){
    openSbLoginModal(function(success){ resolve(success); });
  });
}

async function initCloudDataLayer() {
  initSbClient();
  if (!_sb) return;
  if (await ensureSbAuth()) {
    await refreshSupFromSupabase();
    await refreshBuyFromSupabase();
  }
}
```

**Wiring — `index.html:10203`'s `initApp()` itself is not touched in shape.** One line is added right after the existing `renderAll();` call (`index.html:10238`), matching the fire-and-forget style already used for `pullAll()` a few lines above it (`index.html:10233-10234`):

```js
renderAll();
initCloudDataLayer().catch(function(){}); // fire-and-forget — never blocks app startup, mirrors the existing pullAll() pattern immediately above
checkOnboarding();
// ...rest of initApp(), unchanged
```

`initApp()` stays a plain (non-`async`) function — no `await` is ever written inside it; `initCloudDataLayer()` is an independent async function called without awaiting its result, exactly like `pullAll()` already is.

`saveSup()`/`delSup()`/`saveBuy()`/`delBuy()`/`quickAddBuyer()` each still call `ensureSbAuth()` immediately before their own write, same as v2 — a session can expire mid-use even after a successful background refresh at load.

## 5. CRUD changes — Suppliers and Buyers (both written out in full — no unwritten "mirrors")

**`refreshSupFromSupabase()`** — unchanged from v2:

```js
async function refreshSupFromSupabase() {
  if (!_sb) return;
  var { data, error } = await _sb.from('suppliers').select('*').is('deleted_at', null);
  if (error) { toast('Could not load Suppliers from Cloud Data.'); return; }
  DB.sup = data.map(function(row){
    return { id: row.id, num: row.num, name: row.name, country: row.country, ct: row.contact_name, email: row.email, phone: row.phone, cur: row.currency, notes: row.notes };
  });
  sv(K.s, DB.sup);
  rSup();
}
```

**`refreshBuyFromSupabase()` — now written out in full** (v2 left this as an unwritten "mirror," which risked calling a non-existent `rBuy()`; the real Buyers-tab render function is `renderBuyers()`, `index.html:5364`):

```js
async function refreshBuyFromSupabase() {
  if (!_sb) return;
  var { data, error } = await _sb.from('buyers').select('*').is('deleted_at', null);
  if (error) { toast('Could not load Buyers from Cloud Data.'); return; }
  var adhoc = DB.buy.find(function(b){ return b.id === 'BUY-ADHOC'; });
  DB.buy = data.map(function(row){
    return { id: row.id, num: row.num, name: row.name, contactName: row.contact_name, email: row.email, phone: row.phone, address: row.address, currency: row.currency, paymentTerms: row.payment_terms, creditLimit: row.credit_limit, notes: row.notes, createdAt: row.created_at };
  });
  sv(K.bu, DB.buy);
  seedAdHocBuyer(); // re-inserts BUY-ADHOC (index.html:5332-5336) since it's never in the Supabase result set — no-ops if already present
  renderBuyers();
}
```

**`saveSup()` / `delSup()`** — unchanged from v2 (`ensureSbAuth()` before the write; soft-delete via `deleted_at`; `DB.con[].supplierId` nulling preserved on delete).

**`saveBuy()`** — mirrors `saveSup()`'s shape exactly (insert/update against `buyers`, `ensureSbAuth()` before the write, `refreshBuyFromSupabase()` after) — this part remains a true mirror since it's a straightforward parallel to a function already written out in full above and in v2, with no ambiguity about which render function to call (it's given explicitly in `refreshBuyFromSupabase()` now).

**`delBuy()`** — unchanged from v2 (hard-block on linked invoices preserved, `BUY-ADHOC` guarded, soft-delete via `deleted_at`).

**`quickAddBuyer()` (`index.html:5350-5362`) — new: converted to write through Supabase when configured, local-only otherwise:**

```js
async function quickAddBuyer() {
  var prevId = EI.i ? ((DB.inv.find(function(x){ return x.id === EI.i; }) || {}).buyerId || 'BUY-ADHOC') : 'BUY-ADHOC';
  var qName = prompt('New buyer name:');
  if (!qName || !qName.trim()) { populateBuyDropdown('if-b', prevId); return; }
  qName = qName.trim();
  var dup = DB.buy.find(function(b){ return b.name.toLowerCase() === qName.toLowerCase(); });
  if (dup) { alert('A buyer with this name already exists.'); populateBuyDropdown('if-b', dup.id); return; }
  if (_sb) {
    if (!(await ensureSbAuth())) { populateBuyDropdown('if-b', prevId); return; }
    var result = await _sb.from('buyers').insert({ num: nextRefNum(DB.buy,'BUY'), name: qName, currency: 'GBP' }).select().single();
    if (result.error) { toast('Could not create buyer: ' + result.error.message); populateBuyDropdown('if-b', prevId); return; }
    await refreshBuyFromSupabase();
    logEv('buyer', result.data.id, 'created', 'Buyer quick-created: ' + result.data.name, 'operator');
    populateBuyDropdown('if-b', result.data.id);
  } else {
    var nb = { id:'BUY' + Date.now(), num:nextRefNum(DB.buy,'BUY'), name:qName, contactName:'', email:'', phone:'', address:'', currency:'GBP', paymentTerms:'', creditLimit:null, notes:'', createdAt:new Date().toISOString() };
    DB.buy.push(nb);
    sv(K.bu, DB.buy);
    logEv('buyer', nb.id, 'created', 'Buyer quick-created: ' + nb.name, 'operator');
    populateBuyDropdown('if-b', nb.id);
  }
}
```

The inline `onchange="if(this.value==='__new__') quickAddBuyer()"` handler (`index.html:1015`) needs no change — calling an `async function` from an `onchange` attribute without `await` is already valid JS (fire-and-forget), and every UI update (`populateBuyDropdown`, `alert`) still happens, just after the function's internal `await`s resolve. No equivalent quick-add path exists for Suppliers (confirmed — only the standard `openSup()`/`saveSup()` modal flow), so no analogous change is needed there.

**`editSup(id)`/`openSup()`** — unchanged, as in v1/v2.

## 6. Migration (REQ-CLOUD-001i, j, k) — unchanged from v2's migration function itself

`migrateSuppliersBuyersToSupabase()` is unchanged from `SPEC-CLOUD-001-v2.md` §6 (the `DB.con`/`DB.qt`/`DB.po`/`DB.li`/`DB.inv` remap, `BUY-ADHOC` exclusion, pre-flight dedup scan, and partial-failure error messaging all stood up to this round's review with no new findings). Two things change around it:

**`showBlockingBackupModal()` — citation corrected, mechanism unchanged:**

```html
<div class="modal-overlay" id="ov-migration-backup">
  <p><b>Before migrating, export a full backup.</b> This cannot be automatically verified as complete — please confirm you have downloaded and can locate the export file.</p>
  <button onclick="expAll()">Export All Data</button>
  <label><input type="checkbox" id="mig-backup-ack" onchange="G('mig-backup-proceed').disabled = !this.checked;"> I have downloaded and verified the backup file</label>
  <button id="mig-backup-proceed" disabled onclick="...">Proceed with migration</button>
</div>
```

This is a **new mechanism**, not modeled on any existing modal — there is no prior "gated until checkbox checked" pattern anywhere in `index.html` today (`showQuotaModal()`'s own Dismiss button, checked directly against its live code at `index.html:2957-2970`, is always clickable with no gating at all). The `disabled` attribute toggled by a checkbox's `onchange` is standard DOM behavior, not something requiring a codebase precedent to justify. This remains the honest, weaker-than-a-true-completion-signal guarantee v2 already correctly identified as the right fix for v1's fictional promise — only the false "modeled on `showQuotaModal()`" claim is removed.

**`restoreFromMigrationArchive()` — new, closes the advisory finding that the archived keys were write-only.** A Settings-only admin action (button visible only while `localStorage.getItem('st_cloud_migration_ts')` is present, i.e. within the 30-day grace window):

```js
function restoreFromMigrationArchive() {
  var archS = localStorage.getItem('st_s_pre_migration'), archB = localStorage.getItem('st_bu_pre_migration');
  if (!archS || !archB) { toast('No migration archive available to restore.'); return; }
  if (!confirm('Restore Suppliers and Buyers to their state immediately before the Supabase migration? This does not affect Quotes, POs, Line Items, Invoices, or Contacts, which keep their current (remapped) references.')) return;
  localStorage.setItem(K.s, archS);
  localStorage.setItem(K.bu, archB);
  toast('Restored. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

This makes `dr-procedure.md`'s fast-path claim (§7) true by construction — restoring the archived arrays is now something a real function does, not just prose describing localStorage keys that nothing ever reads back. It's explicitly scoped to undoing a *bad migration result* (data-level rollback), distinct from the fast/slow *code* rollback paths in §7, which are about reverting `index.html` itself. Note this only restores `DB.sup`/`DB.buy` to their pre-migration shape — it does not un-remap `DB.qt`/`DB.po`/`DB.li`/`DB.con`/`DB.inv`, which is why the confirm text says so explicitly; a full undo of a bad migration is the slow-path JSON restore in §7, not this.

## 7. `docs/dr-procedure.md` — new rollback section (REQ-CLOUD-001l) — updated

```markdown
## Rolling back the Supabase migration (Suppliers & Buyers)

If the Supabase-backed Suppliers/Buyers feature needs to be undone:

1. **Fast path — code rollback (within 30 days of migration):** redeploy the `index.html` version from immediately before this feature's release. `st_s`/`st_bu` (the live, continuously-synced local keys) already hold the most recent cloud-mirrored data, so the prior app version reads current data immediately — no re-entry needed, no dependency on the archive.
2. **Fast path — data-only rollback (within 30 days of migration):** if the migration itself produced bad Supplier/Buyer data (not a reason to abandon the feature, just to undo one migration run), use Settings → Cloud Data → "Restore pre-migration Suppliers/Buyers" (`restoreFromMigrationArchive()`). This restores `DB.sup`/`DB.buy` only — Quotes/POs/Line Items/Contacts/Invoices keep their current (already-remapped) references.
3. **Slow path (after the 30-day archive window, or if `localStorage` was cleared):** redeploy the pre-migration `index.html` version, then restore your most recent JSON backup (Settings → Data → Export All, or the mandatory pre-migration backup taken during setup) via Settings → Data → Import.
4. **If migration failed partway through** (some Suppliers/Buyers inserted into Supabase, some not — the app shows an error toast naming the record it stopped on): local data was never modified. In the Supabase dashboard, delete the partially-inserted rows from the `suppliers`/`buyers` tables (a fresh migration run is not safe to re-run over a partial one — it will duplicate the already-succeeded inserts), then retry `migrateSuppliersBuyersToSupabase()` from a clean table.
5. In all cases, the Supabase project itself can be left in place or deleted at your discretion once the prior `index.html` version (or the restored local data) is in use.
```

## GDPR Data Flow

Unchanged from v1/v2.

## 8. Test Plan (`tests/run.js`)

**New, explicit deliverable — required test conversions before this spec can build-gate:** the following existing tests call `saveSup()`, `delSup()`, `saveBuy()`, or `delBuy()` synchronously inside plain `test()` blocks. Once these functions gain `await ensureSbAuth()`/`await _sb.from(...)` calls before their mutation, a synchronous call returns before the mutation runs, and these tests will assert against pre-mutation state. **Each of the following must be converted to `testAsync()` with an `await`ed call, using the same conversion pattern already established for `pullAll()`'s own tests** (e.g. `tests/run.js:1546` `testAsync('pullAll integration...', async function(){ ... await ctx.pullAll(); ... })`):

- `tests/run.js:3695` (`delSup` — AC-5 supplierId-nulling test)
- `tests/run.js:4358` (`saveSup` — supplier_created event test)
- `tests/run.js:4521-4598` (T-BUY-03 through T-BUY-08, six `saveBuy`/`delBuy` calls)
- `tests/run.js:4727,4733,4765,4771` (`saveSup`/`saveBuy` num-assignment regression tests)

In every converted test, `_sb` stays unset/`null` in the fixture (mirroring `SS.supabaseUrl` unset), so these become regression tests for the **local-only code path** — confirming the existing behavior is unchanged when Supabase isn't configured, which is the actual claim this spec needs to keep true.

**New suite** `Supabase-backed Suppliers/Buyers (SPEC-CLOUD-001)`, mocking `_sb` as a stub client:

- `refreshSupFromSupabase()` — mocked `select` returning 2 rows populates `DB.sup` correctly and persists via `sv(K.s, ...)`.
- `refreshSupFromSupabase()` — mocked `select` error shows a toast, doesn't corrupt existing `DB.sup`.
- `refreshBuyFromSupabase()` — result set never includes `BUY-ADHOC`; after refresh, `DB.buy` contains exactly one `BUY-ADHOC` (re-seeded, not duplicated), and calls `renderBuyers()` (not a non-existent `rBuy()` — regression test for the naming risk this version fixed).
- `saveSup()`/`saveBuy()` — create calls `insert` with a client-generated `num` but no client-generated `id`; update calls `update().eq('id', ...)`, never `insert`.
- `delSup()`/`delBuy()` — both call `update({deleted_at: ...})`, never a hard delete; `delBuy()`'s linked-invoice hard-block still fires before any Supabase call (regression test, distinct from `delSup()`'s warn-and-allow).
- `quickAddBuyer()` — with `_sb` configured, calls `_sb.from('buyers').insert(...)`, never pushes directly to `DB.buy`; with `_sb` unset, behaves exactly as today (local push, no Supabase call) — regression test for the pre-existing local-only path.
- `migrateSuppliersBuyersToSupabase()` — duplicate-name pre-flight scan blocks before any `insert`.
- `migrateSuppliersBuyersToSupabase()` — a fixture with a Supplier referenced from one each of `DB.qt`/`DB.po`/`DB.li`/`DB.con`, and a Buyer referenced from `DB.inv`: after migration, all five references match their new mocked `uuid`s.
- `migrateSuppliersBuyersToSupabase()` — `BUY-ADHOC` in the fixture is never sent to `insert`.
- `migrateSuppliersBuyersToSupabase()` — unchecked backup checkbox leaves "Proceed" disabled; the migration function is never invoked until it's checked.
- `restoreFromMigrationArchive()` — with archive keys present, restores `DB.sup`/`DB.bu`-backing localStorage keys to the archived values; with no archive present, shows a toast and makes no changes.
- `cleanupExpiredMigrationArchive()` — archived keys persist at day 29, removed at day 31.
- `ensureSbAuth()` — cached session resolves `true` without opening the login modal; no session opens it and resolves on the modal's outcome.
- `initCloudDataLayer()` — `SS.supabaseUrl` unset: `_sb` stays `null`, no refresh calls, no modal (zero-impact confirmation). **Also confirm `initApp()` itself still completes and calls `renderAll()` synchronously regardless of whether Supabase is configured** — i.e., `initCloudDataLayer()` being fire-and-forget means `renderAll()` never waits on it (regression test for this version's core fix).

## Changelog

- v1: Initial spec implementing REQ-CLOUD-001-v3.
- v2: Fixed v1's 5 blocking findings (ID-remap gap, tab-gated staleness, `BUY-ADHOC` open question, fictional `expAll()` completion signal, mis-described `delBuy()`).
- v3: Independent spec-gate FAIL on v2 (5 blocking findings) resolved — `initApp()` no longer requires `await`/`async` (v2's cited precedent was false; the real, correct fire-and-forget precedent is `pullAll()`, already in the same function); cloud refresh moved to run *after* `renderAll()`, fire-and-forget, so it never blocks the entire app behind a Supabase login (v2's over-correction); `showBlockingBackupModal()`'s false citation of `showQuotaModal()`'s (nonexistent) gating removed, described honestly as a new mechanism; `quickAddBuyer()` — a second, previously-missed Buyer-creation path — converted to write through Supabase; existing `tests/run.js` tests requiring conversion to `testAsync()` now listed explicitly as a required deliverable. Also fixes both advisory findings: `refreshBuyFromSupabase()` written out in full (was an unwritten "mirror" risking a wrong render-function name) and a new `restoreFromMigrationArchive()` function makes the dr-procedure's archived-data rollback claim real rather than aspirational.
