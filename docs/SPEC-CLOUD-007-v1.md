# SPEC-CLOUD-007 — Shipment Cloud Data migration

**Status:** v1 — drafted against `docs/REQ-CLOUD-007-v1.md` (requirements-gate PASS, 3 rounds — see that document's own §8 for the full log, including its own `linkedInvs`/`SH-GAP-002` bug-fix saga and the REQ-CLOUD-007k doc-staleness resolution deferred to `#133`). Every citation below was re-verified directly against this worktree's `index.html`/`tests/run.js` at commit `5622994` (branch `claude/cloud-007-shipment`) — a small number of line numbers had drifted by a handful of lines from the REQ's own citations (e.g. `vShp()`/`vBlurShpRef()`'s two citations were swapped in the REQ's own prose; the actual lines are `vBlurShpRef()` at `9392-9399` and `vShp()` at `9557-9571`) but no cited function's *shape* had changed. `saveShp()` (`12069-12103`), `delShp()` (`12105-12110`), `migrateOrdToSupabase()` (`6336-6393`), `pullAll()`'s two array declarations (`4547`, `4647`), and `FIELD_MAPS.sh` (`4432`) all match the REQ's own citations exactly, byte-for-byte. Baseline: `main` @ `948c2ef`, 869/869 tests passing, confirmed by re-running the real suite in this worktree before drafting (`node tests/run.js`).

**Spec-gate round 1: CONDITIONAL PASS/FAIL — 1 blocking, 0 advisory, fixed in place.** An independent reviewer applied every diff in §1–§3 verbatim to a scratch copy and ran the real suite: 883/887 (4 failures), all traced to two of this SPEC's own newly-authored tests in §3.2 (not the implementation diffs, which were independently confirmed correct, complete, and precisely matched to the REQ with no gaps). Both failing tests omitted a `selectData` entry on their `mockSb()` config, so `migrateShToSupabase()`'s/`saveShp()`'s own spec-correct trailing `refreshShFromSupabase()` call (mirroring `migrateOrdToSupabase()`'s/`savePO()`'s proven precedent) ran unstubbed against an empty result set and wiped `DB.sh` back out from under the assertion — the second failure additionally leaked a no-op `refreshShFromSupabase` stub past its own cleanup line into two subsequent tests, a live instance of this series' own "self-marking test contamination" class, this time inside the SPEC's own test authoring rather than the implementation. Fixed by adding a matching `selectData` to both tests' `mockSb()` config (removing the second test's now-unnecessary stub entirely, matching `saveOrd()`'s own precedent test pattern). Reviewer applied both fixes and confirmed 887/887, all green; fixes applied here in place, re-verified directly (§5). No implementation (`index.html`) change was needed. Per the project's own tightened-process convention (narrow, mechanical, self-verified fixes don't require a second independent round), this SPEC proceeds to implementation without a further spec-gate round.

**Build baseline:** 869/869 (unchanged — this document adds no code, only a plan for §2/§3's diffs).
**Target files:** `supabase/migrations/0007_shipments.sql` (new), `index.html`, `tests/run.js`. No other file is touched by this SPEC (§4).

This REQ is, by its own §1 finding, the structurally simplest migration in the series so far: exactly one creation/update path, zero outward references, zero inward references, zero migration precondition, zero CSV import branch, zero cross-phase retrofit in either direction. The diffs below are correspondingly the smallest in the series — no precondition-check helpers, no `persistShChange()` helper, no external-reference sweep, no async-conversion hunt.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **No migration precondition of any kind** (REQ-CLOUD-007b) — confirmed structurally in the REQ's own §1.1b/d; `migrateShToSupabase()` opens with only the standard `_sb`/auth guards.
- **A real pre-flight duplicate-`ref` scan, exact match, blocking migration via a dedicated modal** (REQ-CLOUD-007c) — resolved below (§0.2) as a fifth near-identical `ov-sh-dup` modal, generalization still deferred.
- **`saveShp()`/`delShp()` get their own dedicated create-or-update/soft-delete branches**, gated on `_sb && localStorage.getItem('st_sh_cloud_migration_ts')`, mirroring `savePO()`'s/`saveQte()`'s marker-gated shape exactly, not `saveLI()`'s bare `if (_sb)` (REQ-CLOUD-007d/e).
- **No shared `persistShChange()` helper** — the mutation-site inventory contains no site outside `saveShp()`/`delShp()` themselves (REQ-CLOUD-007f).
- **No cross-phase retrofit in either direction** — confirmed empty, not merely absent (REQ-CLOUD-007g).
- **`pullAll()` exclusion for `'sh'`** via the same one-line array-filter shape already used for Line Item/Contact/Quote, applied to both `_simpleEntsForBatch` (`4547`) and `simpleEnts` (`4647`) — **not** Purchase Order's/Invoice's separate `_allPullKeys`/per-block-guard mechanism (REQ-CLOUD-007h).
- **Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only**, `st_sh_cloud_migration_ts`/`st_sh_pre_migration` as Shipment's own independent marker pair; `shIdMap` built at the insert loop's tail purely for Shipment's own id remap, with no consumer beyond that (REQ-CLOUD-007i).
- **Defensive `linkedInvs` array-coercion in `migrateShToSupabase()`'s insert loop**, exact expression per REQ-CLOUD-007i-1: `Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : [])`. The underlying `mapRec()`/`unmapRec()` asymmetry (`SH-GAP-002`) is not fixed here.
- **New `refreshShFromSupabase()` wired into `initCloudDataLayer()`, and a new Settings → Cloud Data (Shipments) card** with the note "Independent of every other entity's migration — no other entity needs to migrate first" (REQ-CLOUD-007j).
- **`FIELD_MAPS.sh` needs no change** — confirmed below (§2.7), not silently omitted.
- **No CSV import work of any kind** — there is no existing branch to leave local-only, defer, or log (REQ-CLOUD-007l).
- **REQ-CLOUD-007k is out of scope for this SPEC entirely** — see §4.

The subsections below (§0.1–§0.4) are design decisions this SPEC itself must add — each flows directly from applying REQ-CLOUD-007's already-fixed requirements to the *current* code, but none is spelled out verbatim in the REQ text, so each is flagged explicitly for spec-gate to check with extra scrutiny, mirroring the convention `SPEC-CLOUD-004`/`005`/`006` each used for their own equivalent §0 subsections.

### 0.1 `refreshShFromSupabase()` wiring is the fifth instance of this series' own recurring test-contamination class — retrofit all four existing `initCloudDataLayer()` tests, not one

`initCloudDataLayer()` (`index.html:5633-5646`) gains an eighth `await` line, after `refreshInvFromSupabase()`. This exact mistake has now been made and fixed four times in this series (`REQ-CLOUD-003`'s own round-1 B2, `SPEC-CLOUD-004`'s round-1 B1, `SPEC-CLOUD-005`'s round-1 B2, `SPEC-CLOUD-006`'s own §0.1, self-caught each time): a pre-existing `initCloudDataLayer()` test that predates the new refresh call stubs every refresh function that existed *when that test was written*, but not ones added afterward, so wiring a new refresh call in makes the *older* test run the new function unmocked against an empty `DB.sh`, permanently setting `st_sh_cloud_migration_ts` and corrupting every later test that touches Shipment. There are now **four** such pre-existing tests to retrofit in this same change — `tests/run.js:8089` (Order Request's own, already carrying three prior retrofits), `tests/run.js:8653` (Quote's own, carrying two), `tests/run.js:9060` (Purchase Order's own, carrying one), and `tests/run.js:9566` (Invoice's own, carrying none yet) — verified directly by reading each in full (§3.0 below retrofits all four explicitly).

### 0.2 The pre-flight duplicate-`ref` scan resolved: a fifth near-identical dedicated modal, generalization still deferred

REQ-CLOUD-007c explicitly left open, at SPEC time, whether to add a fifth near-identical modal (`ov-sh-dup`) or finally generalize the by-now-four-times-duplicated pattern (`ov-sb-dup`/`ov-qt-dup`/`ov-po-dup`/`ov-inv-dup`, each with its own `find*DupNums()`/`show*DupConflictModal()` pair). `REQ-CLOUD-005` §2c/§3 raised and deferred the identical question at the *third* instance; this REQ is the *fifth*. No new information has arrived since that changes the calculus — the four existing modals are still each small, independently correct, and none has ever needed a bug fix that the others didn't also need fixed identically (each pair was copy-verified in this SPEC's own drafting pass, §2.1 below). Generalizing now would touch four already-shipped, working code paths to build one shared, parameterized component, for a REQ that itself is the smallest-scope entry in the series — a disproportionate refactor nobody has asked for. **Resolution: add a fifth near-identical `ov-sh-dup` modal and `findDuplicateShRefs()`/`showShDupConflictModal()` pair, following the existing pattern exactly (§2.1). Generalizing this pattern remains explicitly deferred, not attempted here.**

### 0.3 `FIELD_MAPS.sh` needs no change — confirmed directly, not silently assumed

REQ-CLOUD-007 §1.1g already found this from first principles; re-confirmed here directly against the current file (`index.html:4432`): `FIELD_MAPS.sh` maps every field `saveShp()`'s object literal builds (`ref`, `blNum`, `vessel`, `carrier`, `originPort`, `destPort`, `etd`, `eta`, `status`, `containerType`, `containerNum`, `dg`, `docsStatus`, `forwarder`, `forwarderEmail`, `linkedInvs`, `notes`) to a Sheets header string, and (correctly, per the series' own established convention) never maps `id`, since `sh` is business-key-matched (`findLocalMatchByBizKey('sh', ...)`, `index.html:4464`) exactly like `po`/`qt`/`inv`/`cn`. No entry is missing, and no entry needs to change. **§2.7 below states this explicitly as a "no change" line item so a future reader does not assume the map was silently overlooked.**

### 0.4 Settings-card plumbing (`restoreShMigrationArchive()`, `cleanupExpiredMigrationArchive()` extension, `rCfg()` wiring) is implied by REQ-CLOUD-007i/j, not separately lettered

Mirroring `SPEC-CLOUD-006`'s own §0.5 precedent (`delInv()`'s soft-delete branch was implied by the REQ's §1.3 mutation table, not given its own lettered requirement), REQ-CLOUD-007i's own "archive-before-remap, 30-day grace window, disconnect-on-restore" sentence implies the same three plumbing pieces every prior entity's migration needed: a `restoreShMigrationArchive()` function (mirroring `restoreInvMigrationArchive()` exactly), a seventh independently-timed block in `cleanupExpiredMigrationArchive()`, and a `cfg-sb-sh-restore-btn` visibility line in `rCfg()`. None of these is named by letter in REQ-CLOUD-007 §2, but all three are load-bearing — without them, a completed Shipment migration would have no working 30-day-expiring rollback path, silently violating REQ-CLOUD-007i's own stated mechanics. Included in §2.6 below. Flagged here explicitly so spec-gate checks these are covered by AC-9's "every mutation/plumbing function this REQ touches" style audit, since none has an AC of its own by name (mirroring `SPEC-CLOUD-006` §0.5's identical flag for `delInv()`).

---

## 1. New SQL migration: `supabase/migrations/0007_shipments.sql`

Column list resolved against REQ-CLOUD-007a's own table, cross-checked directly against `saveShp()`'s current object literal (`index.html:12074-12094`) — every field it builds is covered; `_demo` is excluded, matching every prior entity's identical precedent (it carries forward unchanged in the local record only, never sent to Supabase). Unlike Invoice's 006 migration, there is no third source of extra fields (no CSV-import-only field, no unlock/edit-audit field, no calc-snapshot field) — `saveShp()` is Shipment's *only* creation/update path (REQ-CLOUD-007 §1.1a), so its own object literal is the column list's complete and only source.

```sql
-- SPEC-CLOUD-007: extends the Cloud Data shared-database layer to Shipment.
--
-- Column list resolved 1:1 against the fields saveShp() (index.html:12074-12094)
-- builds into its `shp` object — the ONLY function that ever pushes onto or
-- mutates DB.sh besides loadDemoData()'s local-only demo seed (REQ-CLOUD-007
-- §1.1a/§1.4). Unlike every prior entity in this series, there is no second
-- source of extra fields (no CSV-import-only field, no unlock/edit-audit field,
-- no calc-snapshot field) to reconcile against.
--
-- `ref` is `text not null unique`, manually entered, with no format check
-- anywhere and no case-normalization (docs/architecture-data-model-v1.md:124) —
-- REQ-CLOUD-007c's own pre-flight duplicate-ref scan (§2.1) is what keeps a
-- migration from ever hitting this constraint, exactly as every prior entity's
-- own num/ref uniqueness constraint depends on its own pre-flight scan.
--
-- `etd`/`eta` are `text`, not `date` — matches every prior entity's identical
-- <input type="date">.value convention (Quote's `dt`, Purchase Order's `date`,
-- Invoice's `date`/`expiry`/`ship_date`) — never a JS Date object, never
-- reformatted.
--
-- `linked_invs` is `jsonb not null default '[]'::jsonb` — a free-text array of
-- Invoice NUMBERS, not ids, confirmed never dereferenced against DB.inv anywhere
-- in the app (REQ-CLOUD-007 §1.1b). Matches Quote's `linked_po_ids` jsonb-array
-- precedent (supabase/migrations/0004_quotes.sql) in column shape only — unlike
-- that column, this one is never FK-adjacent even informally, since it never
-- held ids in the first place. NOT foreign-key-constrained and never will be:
-- Invoice-number matching against this field happens client-side only, never as
-- a database constraint (AC-1).
--
-- linkedInvs is also the only array-valued field in any FIELD_MAPS entry in the
-- whole app; mapRec()/unmapRec() are asymmetric for it (SH-GAP-002, logged not
-- fixed — REQ-CLOUD-007 §3), so migrateShToSupabase()'s own insert loop (§2.2)
-- defensively coerces it to an array before ever reaching this column
-- (REQ-CLOUD-007i-1) rather than relying on the column default alone.
--
-- `upd_at` is `timestamptz`, set by saveShp() on every save, both create and
-- update — unlike Purchase Order, there is no second creation path with a
-- different timestamp convention, so no cre_at/upd_at asymmetry exists here;
-- one nullable column is sufficient (loadDemoData()'s demo seed never sets it).
--
-- `_demo` is deliberately excluded, matching every prior entity's identical
-- precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table shipments (
  id                 uuid primary key default gen_random_uuid(),
  ref                text not null unique,
  bl_num             text,
  vessel             text,
  carrier            text,
  origin_port        text,
  dest_port          text,
  etd                text,
  eta                text,
  container_type     text,
  container_num      text,
  dg                 boolean,
  docs_status        text,
  status             text not null,
  linked_invs        jsonb not null default '[]'::jsonb,
  forwarder          text,
  forwarder_email    text,
  notes              text,
  upd_at             timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table shipments enable row level security;

create policy "authenticated read" on shipments for select using (auth.role() = 'authenticated');
create policy "authenticated write" on shipments for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on shipments for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
```

AC-1 confirmed: `_demo` absent, `linked_invs` is `not null default '[]'::jsonb`, not FK-constrained, and the column list matches REQ-CLOUD-007a's own table exactly (17 data columns + the standard `id`/`created_at`/`updated_at`/`deleted_at`, matching REQ-CLOUD-007a's own count of Local field rows).

---

## 2. `index.html` changes

### 2.1 Pre-flight duplicate-`ref` scan — new `findDuplicateShRefs()`/`showShDupConflictModal()`, new `ov-sh-dup` modal (§0.2)

Insert `findDuplicateShRefs()` immediately after `findDuplicateInvNums()` closes (`index.html:6010`), before `showQteDupConflictModal()` (`6012`):

```js
function findDuplicateShRefs(sh) {
  var groups = {};
  sh.forEach(function(r){
    var key = r.ref || '';
    if (!key) return;
    (groups[key] = groups[key] || []).push(r);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){ return g.length > 1; });
}
```

Insert `showShDupConflictModal()` immediately after `showInvDupConflictModal()` closes (`index.html:6028`), before `var _sbMigrationResolve = null;` (`6030`):

```js
function showShDupConflictModal(dupes) {
  G('sh-dup-list').innerHTML = '<p style="margin-bottom:10px;">Migration blocked: the following Shipment references are duplicated (exact match) and would violate the cloud database\'s unique-reference constraint. Rename one of each pair before migrating.</p><ul style="padding-left:18px;">' +
    dupes.map(function(g){ return '<li>' + g.map(function(r){ return san(r.ref); }).join(' &nbsp;/&nbsp; '); }).join('</li>') + '</li></ul>';
  G('ov-sh-dup').classList.add('on');
}
```

Case-sensitive exact match across the whole `DB.sh` array, mirroring `findDuplicatePONums()`/`findDuplicateInvNums()` exactly and matching how `vShp()`'s/`vBlurShpRef()`'s own live duplicate checks already operate (`index.html:9397`, `9563`).

New modal HTML, inserted immediately after the existing `ov-inv-dup` modal closes (`index.html:2765`), before `ov-data-cleanup-preview` (`2767`):

```html
<div class="ov" id="ov-sh-dup" onclick="if(event.target===this)closeM('ov-sh-dup')">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Migration Blocked — Duplicate Shipment References</h2><button class="mx" onclick="closeM('ov-sh-dup')">&#215;</button></div>
    <div class="mb">
      <div id="sh-dup-list" style="font-size:.55rem;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-g" onclick="closeM('ov-sh-dup')">Close</button>
      </div>
    </div>
  </div>
</div>
```

Structurally identical to `ov-inv-dup` — a fifth, dedicated modal, never modifying any of the four existing ones (§0.2).

### 2.2 `migrateShToSupabase()` — new function

Insert immediately after `migrateInvToSupabase()` closes (`index.html:6784`), before `restoreFromMigrationArchive()` (`6786`) — the file's own established append-order convention (each entity's migrate function follows the previously-most-recently-added one).

```js
async function migrateShToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-007b: no migration precondition on any other entity — Shipment
  // carries no FK field of any kind. linkedInvs is a free-text array of Invoice
  // NUMBERS (not ids), confirmed never dereferenced against DB.inv anywhere in
  // the app (REQ-CLOUD-007 §1.1b) — there is nothing here for a precondition to
  // ever validate against.

  // REQ-CLOUD-007c: ref is manually entered with no format check anywhere and no
  // case-normalization — a real pre-flight duplicate scan is required, not a
  // documented no-op.
  var shDupes = findDuplicateShRefs(DB.sh);
  if (shDupes.length) { showShDupConflictModal(shDupes); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  // REQ-CLOUD-007i-1 (SH-GAP-002 defensive fix): linkedInvs is the only
  // array-valued FIELD_MAPS field in the app — mapRec() joins it to a
  // comma-string for Sheets, but unmapRec() never splits it back, so a local
  // record that has been through one Sheets-pull-with-non-empty-invoices cycle
  // can reach migration time with a string-typed linkedInvs (confirmed live,
  // requirements-gate round 1). Coerced once per record here, local record left
  // as-is — the underlying mapRec()/unmapRec() asymmetry is a separate,
  // pre-existing defect, logged not fixed (SH-GAP-002, §3).
  var shIdMap = {};
  for (var i = 0; i < DB.sh.length; i++) {
    var s = DB.sh[i];
    var result = await _sb.from('shipments').insert({
      ref: s.ref, bl_num: s.blNum || null, vessel: s.vessel || null, carrier: s.carrier || null,
      origin_port: s.originPort || null, dest_port: s.destPort || null, etd: s.etd || null, eta: s.eta || null,
      container_type: s.containerType || null, container_num: s.containerNum || null, dg: !!s.dg,
      docs_status: s.docsStatus || null, status: s.status,
      linked_invs: Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : []),
      forwarder: s.forwarder || null, forwarder_email: s.forwarderEmail || null, notes: s.notes || null,
      upd_at: s.updAt != null ? s.updAt : null
    }).select().single();
    if (result.error) { toast('Migration failed on Shipment ' + (s.ref||s.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    shIdMap[s.id] = result.data.id;
  }

  // REQ-CLOUD-007i/§1.5: no external-reference sweep in either direction —
  // nothing else in the app stores or resolves a Shipment id (REQ-CLOUD-007
  // §1.1c), so shIdMap has no consumer beyond Shipment's own records remapped
  // immediately below. Stated explicitly, not silently omitted (AC-8).

  // Archive the true pre-migration snapshot BEFORE remapping DB.sh's own ids below.
  localStorage.setItem('st_sh_pre_migration', localStorage.getItem(K.sh));
  localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());

  DB.sh.forEach(function(s){ if (shIdMap[s.id]) s.id = shIdMap[s.id]; });
  sv(K.sh, DB.sh);

  await refreshShFromSupabase();
  if (G('cfg-sb-sh-restore-btn')) G('cfg-sb-sh-restore-btn').style.display = '';
  toast('Shipment migration complete. Pre-migration data archived for 30 days.');
}
```

Mirrors `migrateOrdToSupabase()` (`6336-6393`) almost exactly — the closest precedent in the file, per REQ-CLOUD-007's own framing (zero-precondition, single creation path, `xIdMap` built purely for the entity's own id remap with no consumer). Differs only in adding the REQ-CLOUD-007c duplicate-scan gate (Order Request needed none, since `ORD-####` is machine-generated) and the REQ-CLOUD-007i-1 coercion (Order Request has no array-valued `FIELD_MAPS` field to worry about).

### 2.3 New `refreshShFromSupabase()`, and `initCloudDataLayer()` wiring (§0.1)

Insert immediately after `refreshPOFromSupabase()` closes (`index.html:5781`), before `refreshInvFromSupabase()` (`5783`) — keeping every `refresh*FromSupabase()` function in the same file order as `initCloudDataLayer()`'s own call sequence, matching the existing convention.

```js
async function refreshShFromSupabase() {
  if (!_sb) return;
  if (DB.sh.length > 0 && !localStorage.getItem('st_sh_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
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

`updAt` is added `if (row.upd_at != null)`, never via a bare pass-through — the `SPEC-CLOUD-004` spec-gate round-1 B2 defect class this series has avoided ever since (`loadDemoData()`'s own demo Shipment record never sets `updAt` either, confirmed at `index.html:5001`, so this guard is exercised by real data, not a hypothetical). `rDash()` is called (unlike `refreshQteFromSupabase()`/`refreshPOFromSupabase()`, which call only their own render function) because `rDash()` reads `DB.sh` directly for the "In Transit" KPI (`index.html:5136-5152`) — mirroring `refreshInvFromSupabase()`'s identical `rInv(); rDash();` pairing for the same reason.

`initCloudDataLayer()` (`index.html:5633-5646`) gains one line, after Invoice:

Current:

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
    await refreshInvFromSupabase();
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
    await refreshOrdFromSupabase();
    await refreshQteFromSupabase();
    await refreshPOFromSupabase();
    await refreshInvFromSupabase();
    await refreshShFromSupabase();
  }
}
```

### 2.4 `saveShp()` — cloud-aware create/update branch (`index.html:12069-12103`), REQ-CLOUD-007d

Mirrors `savePO()` (`8819-8852`) and `saveQte()`'s cloud branch (`12881-12904`) exactly in shape — both were read in full to confirm the identical pattern: build the row inline, `.update(...).eq('id',...).select().single()` on edit vs `.insert(...).select().single()` on create, reassign the local record's `id` from the real response, then `await refresh*FromSupabase()`; the local-only branch is otherwise untouched, with `sv(K.sh, DB.sh)` moved inside it (matching `savePO()`'s restructuring, since the cloud branch persists via Supabase, not `sv()`).

Current (`index.html:12069-12103`):

```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    blNum: G('shf-bl').value.trim(),
    vessel: G('shf-vessel').value.trim(),
    carrier: G('shf-carrier').value.trim(),
    originPort: G('shf-op').value.trim(),
    destPort: G('shf-dp').value.trim(),
    etd: G('shf-etd').value,
    eta: G('shf-eta').value,
    containerType: G('shf-ctype').value,
    containerNum: G('shf-cnum').value.trim(),
    dg: G('shf-dg').checked,
    docsStatus: G('shf-docs').value,
    status: G('shf-st').value,
    linkedInvs: linkedInvs,
    forwarder: G('shf-fwd') ? G('shf-fwd').value.trim() : '',
    forwarderEmail: G('shf-fwde') ? G('shf-fwde').value.trim() : '',
    notes: G('shf-nt').value.trim(),
    updAt: new Date().toISOString()
  };
  if (EI.sh) {
    var idx = DB.sh.findIndex(function(x){ return x.id===EI.sh; });
    if (idx>-1) DB.sh[idx]=shp; else DB.sh.push(shp);
  } else {
    DB.sh.push(shp);
  }
  sv(K.sh, DB.sh); closeM('ov-shp'); rShp(); rDash(); toast('Shipment saved');
  await syncEnt('sh', shp).catch(function(){});
}
```

New:

```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    blNum: G('shf-bl').value.trim(),
    vessel: G('shf-vessel').value.trim(),
    carrier: G('shf-carrier').value.trim(),
    originPort: G('shf-op').value.trim(),
    destPort: G('shf-dp').value.trim(),
    etd: G('shf-etd').value,
    eta: G('shf-eta').value,
    containerType: G('shf-ctype').value,
    containerNum: G('shf-cnum').value.trim(),
    dg: G('shf-dg').checked,
    docsStatus: G('shf-docs').value,
    status: G('shf-st').value,
    linkedInvs: linkedInvs,
    forwarder: G('shf-fwd') ? G('shf-fwd').value.trim() : '',
    forwarderEmail: G('shf-fwde') ? G('shf-fwde').value.trim() : '',
    notes: G('shf-nt').value.trim(),
    updAt: new Date().toISOString()
  };

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var shRow = {
      ref: shp.ref, bl_num: shp.blNum || null, vessel: shp.vessel || null, carrier: shp.carrier || null,
      origin_port: shp.originPort || null, dest_port: shp.destPort || null, etd: shp.etd || null, eta: shp.eta || null,
      container_type: shp.containerType || null, container_num: shp.containerNum || null, dg: !!shp.dg,
      docs_status: shp.docsStatus || null, status: shp.status, linked_invs: shp.linkedInvs || [],
      forwarder: shp.forwarder || null, forwarder_email: shp.forwarderEmail || null, notes: shp.notes || null,
      upd_at: shp.updAt
    };
    var shResult;
    if (EI.sh) {
      shResult = await _sb.from('shipments').update(shRow).eq('id', EI.sh).select().single();
    } else {
      shResult = await _sb.from('shipments').insert(shRow).select().single();
    }
    if (shResult.error) { toast('Save failed: ' + shResult.error.message); return; }
    shp.id = shResult.data.id;
    await refreshShFromSupabase();
  } else {
    if (EI.sh) {
      var idx = DB.sh.findIndex(function(x){ return x.id===EI.sh; });
      if (idx>-1) DB.sh[idx]=shp; else DB.sh.push(shp);
    } else {
      DB.sh.push(shp);
    }
    sv(K.sh, DB.sh);
  }

  closeM('ov-shp'); rShp(); rDash(); toast('Shipment saved');
  await syncEnt('sh', shp).catch(function(){});
}
```

`syncEnt('sh', shp)` is kept unconditional at the tail, exactly as `savePO()`/`saveQte()` keep their own `syncEnt()` calls unconditional — Sheets push (`syncEnt`) keeps running for Shipment regardless of Cloud Data state, matching every prior entity's precedent (`CLOUD-GAP-002`, out of scope). No `audit()`/`logEv()` call is added to either branch — Shipment has zero audit trail today (`SH-GAP-001`, logged not fixed, §3) and this migration REQ does not change that.

### 2.5 `delShp()` — cloud-aware soft-delete branch (`index.html:12105-12110`), REQ-CLOUD-007e

Mirrors `delPO()`'s basic soft-delete branch (`8878-8891`) exactly — `.update({deleted_at: new Date().toISOString()}).eq('id', id)`, never a hard delete — but omits `delPO()`'s further `Quote.linkedPOIds[]`/`Invoice.pos[]` cleanup sections entirely, since nothing anywhere references a Shipment id (REQ-CLOUD-007 §1.5) and no `SH`-equivalent of `PO-GAP-007` exists to fix. No `logEv()` call is added on delete either, for the same `SH-GAP-001` reason as §2.4.

Current (`index.html:12105-12110`):

```js
async function delShp(id) {
  if (!confirm('Delete this shipment?')) return;
  var _shRef = (DB.sh.find(function(s){return s.id===id;})||{}).ref||id;
  DB.sh = DB.sh.filter(function(s){ return s.id!==id; });
  sv(K.sh, DB.sh); rShp(); rDash(); toast('Deleted'); await delEnt('sh', _shRef).catch(function(){});
}
```

New:

```js
async function delShp(id) {
  if (!confirm('Delete this shipment?')) return;
  var _shRef = (DB.sh.find(function(s){return s.id===id;})||{}).ref||id;

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('shipments').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshShFromSupabase();
  } else {
    DB.sh = DB.sh.filter(function(s){ return s.id!==id; });
    sv(K.sh, DB.sh);
  }

  rShp(); rDash(); toast('Deleted'); await delEnt('sh', _shRef).catch(function(){});
}
```

`delEnt('sh', _shRef)` is likewise kept unconditional, matching `delPO()`'s own unconditional `delEnt()` call and `CLOUD-GAP-002`'s existing, accepted scope.

### 2.6 Settings UI card, archive/rollback extensions, `rCfg()` wiring (§0.4)

**New card**, inserted immediately after the existing "Cloud Data (Invoices & Credit Notes)" card closes (`index.html:830`), before the "Accounting Export — Field Mapping Reference" card:

```html
    <div class="card">
      <div class="ct">Cloud Data (Shipments)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-g" onclick="migrateShToSupabase()">Migrate Shipments to Cloud</button>
        <button class="btn btn-g" id="cfg-sb-sh-restore-btn" style="display:none;" onclick="restoreShMigrationArchive()">Restore Pre-Migration Shipments</button>
      </div>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Independent of every other entity's migration — no other entity needs to migrate first. Uses the same Supabase connection configured above.</p>
    </div>
```

Note text matches REQ-CLOUD-007j's exact wording, mirroring the Order Request/Quote cards' equivalent notes (`index.html:805`, `813`) — genuinely true for Shipment for the same structural reason (REQ-CLOUD-007 §1.1d).

**New `restoreShMigrationArchive()`**, inserted immediately after `restoreInvMigrationArchive()` closes (`index.html:6869`), before `cleanupExpiredMigrationArchive()` (`6871`):

```js
function restoreShMigrationArchive() {
  var arch = localStorage.getItem('st_sh_pre_migration');
  if (!arch) { toast('No Shipment migration archive available to restore.'); return; }
  if (!confirm('Restore Shipments to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, Quotes, Purchase Orders, Invoices, Credit Notes, or any other document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Shipments — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.sh, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_sh_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

**`cleanupExpiredMigrationArchive()`** (`index.html:6871-6908`) — extend with an eighth independently-timed block, inserted immediately after the existing Invoice block (`6903-6907`), before the function's own closing `}` (`6908`):

```js
  var shTs = localStorage.getItem('st_sh_cloud_migration_ts');
  if (shTs && (Date.now() - new Date(shTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_sh_pre_migration');
    localStorage.removeItem('st_sh_cloud_migration_ts');
  }
```

**`rCfg()`** (`index.html:11495-11519`) — add an eighth restore-button visibility line, immediately after the Invoice one (`11513`), before the `cfg-lang` line that follows it (`11514`):

```js
  if(G('cfg-sb-sh-restore-btn')) G('cfg-sb-sh-restore-btn').style.display = localStorage.getItem('st_sh_cloud_migration_ts') ? '' : 'none';
```

### 2.7 `pullAll()` — exclude `'sh'` once migrated (REQ-CLOUD-007h)

One-line filter addition to *both* arrays, mirroring the existing Line Item/Contact/Quote precedent exactly — **not** a two-part `_allPullKeys`-plus-per-block-guard fix like Purchase Order's/Invoice's, since Shipment sits in the business-key-matched `simpleEnts`/`_simpleEntsForBatch` path, not `idKeyedEnts` (REQ-CLOUD-007 §1.1g/§1.7).

**Change 1** (`index.html:4547-4552`):

Current:

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'qt'; });
  var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch);
```

New:

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'qt'; });
  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sh'; });
  var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch);
```

Since `_allPullKeys` is built by concatenating `_simpleEntsForBatch`, this one line also removes `'sh'` from the batched `pull_all` request automatically — no separate `_allPullKeys` edit is needed (unlike Purchase Order's/Invoice's own two-array `_allPullKeys` filters, which exist because those two are *not* built by concatenating `_simpleEntsForBatch`).

**Change 2** (`index.html:4647-4660`):

Current:

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
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'qt'; });
  var idKeyedEnts = ['sup', 'payments', 'co'];
```

New:

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
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'qt'; });
  // Shipment (SPEC-CLOUD-007): same race — cloud-authoritative once migrated, excluded
  // once its own local completion marker is set, matching Line Item/Contact/Quote's
  // identical per-entity-marker shape.
  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'sh'; });
  var idKeyedEnts = ['sup', 'payments', 'co'];
```

No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope, unaffected).

### 2.8 `FIELD_MAPS.sh` — no change (confirmed, §0.3)

`index.html:4432` — no diff. `FIELD_MAPS.sh` already maps every field `saveShp()` builds, correctly omits `id` (business-key-matched, like every other `simpleEnts`-path entity), and has no outward-reference field to omit an id-counterpart for in the first place (unlike the `CN`/`PO`/`payments` Num-without-Id bug class this series has found three times — REQ-CLOUD-007 §1.1g). Stated here explicitly per the task's own instruction, rather than silently omitted from this SPEC.

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness (`tests/run.js:7309-7354`) unchanged — already fully generic per-table, no changes needed for a new `shipments` table. The smallest test-addition footprint in this series so far, following directly from REQ-CLOUD-007 §1's findings: no multi-creation-path fixture, no self-referential or array-element remap test, no combined-precondition fixture, no async-conversion fixture.

### 3.0 Required companion retrofits of four pre-existing `initCloudDataLayer()` tests (§0.1)

Each of the four tests below gains a `shipments: { selectData: [] }` entry in its `mockSb()` config and a stub/restore pair for `ctx.refreshShFromSupabase`, inserted immediately after that test's existing `refreshInvFromSupabase` stub (the most-recently-added one in each).

**`tests/run.js:8089`** ("initCloudDataLayer — now also calls refreshOrdFromSupabase()..."):

Current (`8089-8120`):

```js
testAsync('initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding: previously wired for Supplier/Buyer/Line Item/Contact but not Order Request)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){}; // keep the mock _sb below in place instead of overwriting it with a real client
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] } });
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
  // SPEC-CLOUD-005: initCloudDataLayer() now also calls refreshPOFromSupabase() after
  // refreshQteFromSupabase() — stub it too, or the real function runs unmocked against
  // DB.po (empty at this point) and permanently sets st_po_cloud_migration_ts.
  var origRefreshPO = ctx.refreshPOFromSupabase;
  ctx.refreshPOFromSupabase = function(){ return Promise.resolve(); };
  // SPEC-CLOUD-006: initCloudDataLayer() now also calls refreshInvFromSupabase() after
  // refreshPOFromSupabase() — stub it too, or the real function runs unmocked against
  // DB.inv (empty at this point) and permanently sets st_inv_cloud_migration_ts,
  // corrupting every later test that touches Invoice/CN.
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshOrdFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshOrdFromSupabase = origRefreshOrd; ctx.refreshQteFromSupabase = origRefreshQte; ctx.refreshPOFromSupabase = origRefreshPO; ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
});
```

New (changed lines only — `mockSb` config gains `shipments: { selectData: [] }`; a new stub/restore pair added after the `refreshInv` one; the restore line gains `ctx.refreshShFromSupabase = origRefreshSh`):

```js
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] }, shipments: { selectData: [] } });
  ...
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  // SPEC-CLOUD-007: initCloudDataLayer() now also calls refreshShFromSupabase() after
  // refreshInvFromSupabase() — stub it too, or the real function runs unmocked against
  // DB.sh (empty at this point) and permanently sets st_sh_cloud_migration_ts,
  // corrupting every later test that touches Shipment.
  var origRefreshSh = ctx.refreshShFromSupabase;
  ctx.refreshShFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshOrdFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshOrdFromSupabase = origRefreshOrd; ctx.refreshQteFromSupabase = origRefreshQte; ctx.refreshPOFromSupabase = origRefreshPO; ctx.refreshInvFromSupabase = origRefreshInv; ctx.refreshShFromSupabase = origRefreshSh;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
```

**`tests/run.js:8653`** ("initCloudDataLayer — now also calls refreshQteFromSupabase()...") — identical treatment: `mockSb` config gains `shipments: { selectData: [] }`; after the existing `refreshInv` stub, add the same `origRefreshSh`/stub pair and comment; the restore line gains `ctx.refreshShFromSupabase = origRefreshSh` (this test already ends with `ctx._sb = null;` at `8679` — left unchanged).

**`tests/run.js:9060`** ("initCloudDataLayer — now also calls refreshPOFromSupabase()...") — same treatment (already ends with `ctx._sb = null;` at `9079`).

**`tests/run.js:9566`** ("initCloudDataLayer — now also calls refreshInvFromSupabase()...") — same treatment; this is the test whose own `refreshInv` stub sets `called = true` (the function under direct test), so the new `refreshSh` stub is a plain no-op addition, exactly mirroring how `SPEC-CLOUD-006` §0.1 added a `refreshInv` no-op stub to the (then-)three pre-existing tests. Already ends with `ctx._sb = null;` at `9580` — left unchanged.

### 3.1 Test-hygiene fix to the three pre-existing Shipment CRUD tests (REQ-CLOUD-007 §5 advisory)

REQ-CLOUD-007 §5's own advisory (round-1) flagged that `tests/run.js`'s three existing Shipment CRUD tests don't explicitly reset `ctx._sb` to `null`, relying on ambient state — the "self-marking test contamination" class `CLAUDE.md` documents as having recurred repeatedly in this series. Since this SPEC already touches `saveShp()`/`delShp()`, this is the correct time to fix it, per the REQ's own instruction.

**`tests/run.js:407`** ("saveShp stores a new shipment in DB.sh"):

Current:

```js
test('saveShp stores a new shipment in DB.sh', () => {
  resetDB();
  ctx.DB.sh = [];
  ctx.EI.sh = null;
```

New:

```js
test('saveShp stores a new shipment in DB.sh', () => {
  resetDB();
  ctx._sb = null;
  ctx.DB.sh = [];
  ctx.EI.sh = null;
```

**`tests/run.js:440`** ("saveShp parses DG flag correctly") — identical one-line addition (`ctx._sb = null;`) immediately after `resetDB();`.

**`tests/run.js:469`** ("delShp removes shipment from DB.sh"):

Current:

```js
test('delShp removes shipment from DB.sh', () => {
  resetDB();
  ctx.DB.sh = [{ id:'sh-1', ref:'SHP-DEL', status:'Pending', linkedInvs:[], dg:false }];
  ctx.confirm = () => true;
```

New:

```js
test('delShp removes shipment from DB.sh', () => {
  resetDB();
  ctx._sb = null;
  ctx.DB.sh = [{ id:'sh-1', ref:'SHP-DEL', status:'Pending', linkedInvs:[], dg:false }];
  ctx.confirm = () => true;
```

None of these three tests' assertions change — `ctx._sb` was already implicitly `null`/falsy at these points given the current test-execution order, so this is a pure hygiene fix with no behavior change today, matching REQ-CLOUD-007 §5's own framing of it as an advisory, not a bug.

### 3.2 New test block

Insert immediately after the `'SPEC-CLOUD-006 test-hygiene cleanup...'` test closes (`tests/run.js:10445`), before the `// ── AI Assistant...` section comment (`10447`) — matching this series' own established placement convention (each REQ's tests form one contiguous block immediately following the prior REQ's own cleanup test; REQ-CLOUD-007 §5's own citation of the `SPEC-CLOUD-004` round-1 B7 convention).

```js
// ── CLOUD DATA — Shipment (SPEC-CLOUD-007) ──

testAsync('migrateShToSupabase — inserts every field including linkedInvs, remaps DB.sh\'s own id, archives the true pre-migration snapshot before remapping', async function() {
  resetDB();
  ctx.DB.sh.push({
    id: 'sh1', ref: 'SHP-1001', blNum: 'MEDU1234567', vessel: 'MSC Mara', carrier: 'MSC',
    originPort: 'Qingdao', destPort: 'Bridgetown', etd: '2026-05-01', eta: '2026-06-01',
    containerType: '40HQ', containerNum: 'MSCU1234567', dg: true, docsStatus: 'Complete',
    status: 'Booked', linkedInvs: ['INV10030','INV10031'], forwarder: 'Kuehne+Nagel',
    forwarderEmail: 'ops@kn-demo.example', notes: 'test note', updAt: '2026-01-01T00:00:00.000Z'
  });
  ctx.localStorage.setItem(ctx.K.sh, JSON.stringify(ctx.DB.sh));
  var sb = mockSb({ shipments: { insertImpl: function(row){ return Object.assign({ id: 'new-sh-uuid' }, row); },
    selectData: [{ id: 'new-sh-uuid', ref: 'SHP-1001', bl_num: 'MEDU1234567', vessel: 'MSC Mara', carrier: 'MSC',
      origin_port: 'Qingdao', dest_port: 'Bridgetown', etd: '2026-05-01', eta: '2026-06-01',
      container_type: '40HQ', container_num: 'MSCU1234567', dg: true, docs_status: 'Complete',
      status: 'Booked', linked_invs: ['INV10030','INV10031'], forwarder: 'Kuehne+Nagel',
      forwarder_email: 'ops@kn-demo.example', notes: 'test note', upd_at: '2026-01-01T00:00:00.000Z' }] } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-sh-restore-btn');
  await ctx.migrateShToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(insertCall.row.ref, 'SHP-1001', 'ref inserted');
  assertEqual(insertCall.row.bl_num, 'MEDU1234567', 'bl_num inserted');
  assertEqual(insertCall.row.container_type, '40HQ', 'container_type inserted');
  assertEqual(insertCall.row.dg, true, 'dg inserted');
  assertEqual(JSON.stringify(insertCall.row.linked_invs), JSON.stringify(['INV10030','INV10031']), 'linked_invs inserted as array, unchanged');
  assertEqual(insertCall.row.upd_at, '2026-01-01T00:00:00.000Z', 'upd_at inserted');
  assertEqual(ctx.DB.sh[0].id, 'new-sh-uuid', 'Shipment\'s own id remapped to the Supabase-assigned id');
  var archived = JSON.parse(ctx.localStorage.getItem('st_sh_pre_migration'));
  assertEqual(archived[0].id, 'sh1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx._sb = null;
});

testAsync('migrateShToSupabase — succeeds with zero other entities ever migrated (AC-4)', async function() {
  resetDB();
  ctx.DB.sh.push({ id: 'sh1', ref: 'SHP-0001', status: 'Pending', linkedInvs: [] });
  ctx.localStorage.setItem(ctx.K.sh, JSON.stringify(ctx.DB.sh));
  ['st_cloud_migration_ts','st_li_cloud_migration_ts','st_con_cloud_migration_ts','st_ord_cloud_migration_ts','st_qt_cloud_migration_ts','st_po_cloud_migration_ts','st_inv_cloud_migration_ts'].forEach(function(k){ ctx.localStorage.removeItem(k); });
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-sh-restore-btn');
  await ctx.migrateShToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assert(insertCall, 'migration succeeded with zero other entities ever migrated — no precondition check exists (REQ-CLOUD-007b)');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx._sb = null;
});

testAsync('migrateShToSupabase — blocked by a duplicate ref (exact match); does not insert any row (AC-5)', async function() {
  resetDB();
  ctx.DB.sh.push({ id: 'sh1', ref: 'SHP-0099', status: 'Pending', linkedInvs: [] });
  ctx.DB.sh.push({ id: 'sh2', ref: 'SHP-0099', status: 'Booked', linkedInvs: [] });
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  mockEl('sh-dup-list');
  await ctx.migrateShToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked before any insert');
  ctx._sb = null;
});

testAsync('migrateShToSupabase — coerces a string-typed linkedInvs into an array before insert (AC-11, SH-GAP-002/REQ-CLOUD-007i-1)', async function() {
  resetDB();
  ctx.DB.sh.push({ id: 'sh1', ref: 'SHP-2001', status: 'Pending', linkedInvs: 'INV0001, INV0002' });
  ctx.localStorage.setItem(ctx.K.sh, JSON.stringify(ctx.DB.sh));
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-sh-restore-btn');
  await ctx.migrateShToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assertEqual(JSON.stringify(insertCall.row.linked_invs), JSON.stringify(['INV0001','INV0002']), 'string-typed linkedInvs coerced into the equivalent array, not inserted as a raw string');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx._sb = null;
});

testAsync('migrateShToSupabase — a genuinely-empty string linkedInvs inserts as [], an already-correct array passes through unchanged (AC-11)', async function() {
  resetDB();
  ctx.DB.sh.push({ id: 'sh1', ref: 'SHP-2002', status: 'Pending', linkedInvs: '' });
  ctx.DB.sh.push({ id: 'sh2', ref: 'SHP-2003', status: 'Pending', linkedInvs: ['INV0009'] });
  ctx.localStorage.setItem(ctx.K.sh, JSON.stringify(ctx.DB.sh));
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-sh-restore-btn');
  await ctx.migrateShToSupabase();
  var calls = sb._calls.filter(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assertEqual(JSON.stringify(calls[0].row.linked_invs), JSON.stringify([]), 'empty string coerces to []');
  assertEqual(JSON.stringify(calls[1].row.linked_invs), JSON.stringify(['INV0009']), 'already-correct array passes through unchanged');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx._sb = null;
});

testAsync('migrateShToSupabase — touches no other entity\'s array (AC-8)', async function() {
  resetDB();
  ctx.DB.sup.push({id:'s1'}); ctx.DB.li.push({id:'l1'}); ctx.DB.inv.push({id:'i1'}); ctx.DB.po.push({id:'p1'});
  ctx.DB.qt.push({id:'q1'}); ctx.DB.con.push({id:'c1'}); ctx.DB.ord.push({id:'o1'});
  ctx.DB.sh.push({ id: 'sh1', ref: 'SHP-AC8', status: 'Pending', linkedInvs: [] });
  var before = JSON.stringify({sup:ctx.DB.sup, li:ctx.DB.li, inv:ctx.DB.inv, po:ctx.DB.po, qt:ctx.DB.qt, con:ctx.DB.con, ord:ctx.DB.ord});
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-sh-restore-btn');
  await ctx.migrateShToSupabase();
  var after = JSON.stringify({sup:ctx.DB.sup, li:ctx.DB.li, inv:ctx.DB.inv, po:ctx.DB.po, qt:ctx.DB.qt, con:ctx.DB.con, ord:ctx.DB.ord});
  assertEqual(after, before, 'no other entity array mutated by migrateShToSupabase() — confirms the zero-sweep claim (REQ-CLOUD-007 §1.5) operationally, not just by inspection');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx._sb = null;
});

test('migrateShToSupabase — no other migrate*ToSupabase function references DB.sh anywhere in the source (AC-8)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  var start = html.indexOf('async function migrateSuppliersBuyersToSupabase()');
  var end = html.indexOf('async function migrateShToSupabase()');
  assert(start > -1 && end > start, 'both markers found in source, in the expected order');
  var otherMigrateFns = html.slice(start, end);
  assert(otherMigrateFns.indexOf('DB.sh') === -1, 'no migrate*ToSupabase function other than migrateShToSupabase() itself references DB.sh — confirms REQ-CLOUD-007 §1.6\'s "zero cross-phase retrofit" claim is still true on the current codebase');
});

testAsync('saveShp — cloud-configured create inserts with no client-generated id and resolves the real Supabase id onto the local record (AC-2)', async function() {
  resetDB();
  ctx.DB.sh = []; ctx.EI.sh = null;
  ctx.localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ shipments: { insertImpl: function(row){ return Object.assign({ id: 'real-sh-uuid' }, row); },
    selectData: [{ id: 'real-sh-uuid', ref: 'SHP-CLOUD-1', status: 'Booked', linked_invs: [] }] } });
  ctx._sb = sb;
  mockEl('shf-ref').value = 'SHP-CLOUD-1'; mockEl('shf-bl').value=''; mockEl('shf-vessel').value='';
  mockEl('shf-carrier').value=''; mockEl('shf-op').value=''; mockEl('shf-dp').value='';
  mockEl('shf-etd').value=''; mockEl('shf-eta').value=''; mockEl('shf-ctype').value='20GP';
  mockEl('shf-cnum').value=''; mockEl('shf-dg').checked=false; mockEl('shf-docs').value='Pending';
  mockEl('shf-st').value='Booked'; mockEl('shf-invs').value=''; mockEl('shf-nt').value='';
  await ctx.saveShp();
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assert(insertCall, 'insert called, not update');
  assert(insertCall.row.id === undefined, 'no client-generated id sent in the insert row');
  assertEqual(ctx.DB.sh[0].id, 'real-sh-uuid', 'real Supabase-assigned id resolved onto the local record');
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = null;
});

testAsync('saveShp — cloud-configured update calls .update(...).eq(\'id\',...), not .insert(), on a subsequent edit of the same record (AC-2)', async function() {
  resetDB();
  ctx.DB.sh = [{ id: 'sh-existing', ref: 'SHP-EXIST', status: 'Booked', linkedInvs: [] }];
  ctx.EI.sh = 'sh-existing';
  ctx.localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ shipments: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });
  ctx._sb = sb;
  var origRefresh = ctx.refreshShFromSupabase;
  ctx.refreshShFromSupabase = function(){ return Promise.resolve(); };
  mockEl('shf-ref').value = 'SHP-EXIST'; mockEl('shf-bl').value=''; mockEl('shf-vessel').value='';
  mockEl('shf-carrier').value=''; mockEl('shf-op').value=''; mockEl('shf-dp').value='';
  mockEl('shf-etd').value=''; mockEl('shf-eta').value=''; mockEl('shf-ctype').value='20GP';
  mockEl('shf-cnum').value=''; mockEl('shf-dg').checked=false; mockEl('shf-docs').value='Pending';
  mockEl('shf-st').value='In Transit'; mockEl('shf-invs').value=''; mockEl('shf-nt').value='';
  await ctx.saveShp();
  var updateCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'update'; });
  var insertCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'insert'; });
  assert(updateCall, 'update called');
  assert(!insertCall, 'insert NOT called on an edit');
  var eqCall = sb._calls.find(function(c){ return c.table==='shipments' && c.op==='eq' && c.col==='id'; });
  assertEqual(eqCall.val, 'sh-existing', '.eq(\'id\', ...) targets the existing record');
  ctx.refreshShFromSupabase = origRefresh;
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = null;
});

testAsync('delShp — cloud-configured delete soft-deletes via .update({deleted_at:...}), not a hard delete (AC-3)', async function() {
  resetDB();
  ctx.DB.sh = [{ id: 'sh-del', ref: 'SHP-DEL2', status: 'Pending', linkedInvs: [] }];
  ctx.confirm = function(){ return true; };
  ctx.localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ shipments: {} });
  ctx._sb = sb;
  var origRefresh = ctx.refreshShFromSupabase;
  ctx.refreshShFromSupabase = function(){ return Promise.resolve(); };
  await ctx.delShp('sh-del');
  var updateCall = sb._calls.find(function(c){ return c.table === 'shipments' && c.op === 'update'; });
  assert(updateCall, 'update called (soft delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set on the update row');
  assertEqual(ctx.DB.sh.length, 1, 'DB.sh NOT spliced locally — the cloud branch relies on refreshShFromSupabase(), not a local filter, for the visible list to update');
  ctx.refreshShFromSupabase = origRefresh;
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = null;
  ctx.confirm = function(){ return false; };
});

testAsync('refreshShFromSupabase — mocked select returning rows populates DB.sh correctly including linkedInvs, persists to localStorage, sets its own marker', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = mockSb({ shipments: { selectData: [
    { id: 'u1', ref: 'SHP-3001', bl_num: 'BL1', vessel: 'V1', carrier: 'C1', origin_port: 'CNQAO', dest_port: 'DEHAM',
      etd: '2026-01-01', eta: '2026-02-01', container_type: '40HQ', container_num: 'CN1', dg: true, docs_status: 'Complete',
      status: 'In Transit', linked_invs: ['INV0001'], forwarder: 'Fwd Co', forwarder_email: 'ops@fwd.example', notes: 'n1', upd_at: '2026-01-01T00:00:00.000Z' }
  ] } });
  await ctx.refreshShFromSupabase();
  assertEqual(ctx.DB.sh.length, 1, '1 shipment loaded');
  assertEqual(ctx.DB.sh[0].id, 'u1', 'id mapped');
  assertEqual(ctx.DB.sh[0].blNum, 'BL1', 'bl_num mapped to blNum');
  assertEqual(JSON.stringify(ctx.DB.sh[0].linkedInvs), JSON.stringify(['INV0001']), 'linked_invs mapped to linkedInvs array');
  assertEqual(ctx.DB.sh[0].updAt, '2026-01-01T00:00:00.000Z', 'upd_at mapped');
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.sh)).length, 1, 'persisted to localStorage via sv(K.sh,...)');
  assert(ctx.localStorage.getItem('st_sh_cloud_migration_ts'), 'own migration marker set on success (second-device case)');
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = null;
});

testAsync('refreshShFromSupabase — refuses to overwrite real local data when this device has never migrated; proceeds when local data is empty (AC-7)', async function() {
  resetDB();
  ctx.DB.sh.push({ id: 'local-sh', ref: 'SHP-LOCAL' });
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = mockSb({ shipments: { selectData: [{ id: 'cloud-sh', ref: 'SHP-CLOUD', status: 'Booked', linked_invs: [] }] } });
  await ctx.refreshShFromSupabase();
  assertEqual(ctx.DB.sh.length, 1, 'real local data NOT overwritten');
  assertEqual(ctx.DB.sh[0].id, 'local-sh', 'existing local record preserved');

  resetDB(); // local now empty — second-device case
  await ctx.refreshShFromSupabase();
  assertEqual(ctx.DB.sh.length, 1, 'proceeds and loads Cloud Data when local is empty');
  assertEqual(ctx.DB.sh[0].id, 'cloud-sh', 'cloud record loaded');
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx._sb = null;
});

testAsync('pullAll() — drops \'sh\' from both _simpleEntsForBatch/_allPullKeys and simpleEnts once st_sh_cloud_migration_ts is set (AC-6)', async function() {
  resetDB();
  ctx.SS.url = 'https://script.google.com/mock';
  ctx._sb = mockSb({});
  _fetchCallLog = [];
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('sh') >= 0, 'sh still requested — not migrated yet');

  ctx.localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('sh'), -1, 'sh excluded from the batched request once its own marker is set');

  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx.SS.url = '';
  ctx._sb = null;
});

testAsync('initCloudDataLayer — now also calls refreshShFromSupabase()', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] }, shipments: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshSh = ctx.refreshShFromSupabase;
  ctx.refreshShFromSupabase = function(){ called = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshShFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshShFromSupabase = origRefreshSh;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});

test('processImportRecords()/processImport() and the AI-assistant dispatch path are unaffected by Shipment Cloud Data — no \'sh\' CSV branch exists, DB.sh untouched by a CSV import attempt (REQ-CLOUD-007l, AC-10)', () => {
  var html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  var recStart = html.indexOf('function processImportRecords(entity, records, callback) {');
  var recEnd = html.indexOf('\nfunction openPayments(');
  var impStart = html.indexOf('async function processImport(entity, csvText) {');
  var impEnd = html.indexOf('\nfunction processImportRecords(');
  assert(recStart > -1 && recEnd > recStart, 'processImportRecords() boundaries found');
  assert(impStart > -1 && impEnd > impStart, 'processImport() boundaries found');
  assert(!/entity\s*===\s*'sh'/.test(html.slice(recStart, recEnd)), 'processImportRecords() has no entity===\'sh\' branch');
  assert(!/entity\s*===\s*'sh'/.test(html.slice(impStart, impEnd)), 'processImport() has no entity===\'sh\' branch');

  resetDB();
  ctx.DB.sh.push({ id: 'sh-existing', ref: 'SHP-KEEP' });
  var before = JSON.stringify(ctx.DB.sh);
  ctx.processImportRecords('sh', [{ 'Shipment Ref': 'SHP-NEW' }], function(){});
  assertEqual(JSON.stringify(ctx.DB.sh), before, 'DB.sh completely unchanged after a CSV import attempt for entity \'sh\' — no branch exists to process the record');
});

test('cleanupExpiredMigrationArchive — Shipment archive expires independently of every other entity', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_sh_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_sh_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_sh_pre_migration'), null, 'expired Shipment archive removed at day 31');
});

test('restoreShMigrationArchive — restores K.sh and clears SS.supabaseUrl/supabaseAnonKey and its own marker', function() {
  resetDB();
  ctx.localStorage.setItem('st_sh_pre_migration', JSON.stringify([{ id: 'orig-sh', ref: 'SHP-76001' }]));
  ctx.localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreShMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.sh))[0].id, 'orig-sh', 'K.sh restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');
  assertEqual(ctx.localStorage.getItem('st_sh_cloud_migration_ts'), null, 'own marker cleared on restore');
  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('SPEC-CLOUD-007 test-hygiene cleanup — reset _sb and every Shipment Cloud Data migration marker this block may have left set, so later unrelated tests are not affected', async function() {
  ctx._sb = null;
  ctx.localStorage.removeItem('st_sh_cloud_migration_ts');
  ctx.localStorage.removeItem('st_sh_pre_migration');
});
```

18 new tests, covering AC-1 (via §1's SQL review, not a JS-testable claim in this harness — confirmed by direct column-list inspection instead), AC-2 through AC-11 directly.

### 3.3 AC-9 audit — full pre-existing-test-suite trace

Every direct pre-existing test-suite call site of a function this REQ touches was traced against the diffs in §2:

- **`saveShp()`/`delShp()`** — the three pre-existing tests at `tests/run.js:407/440/469` are the only pre-existing call sites of either function. All three leave `ctx._sb` unset (`null`) before calling `saveShp()`/`delShp()`, per this codebase's `resetDB()`/test-isolation convention — so all three exercise exactly the local-only branch this SPEC's §2.4/§2.5 diffs leave behavior-identical to today. §3.1 adds the explicit `ctx._sb = null;` reset REQ-CLOUD-007 §5 advised, closing the ambient-state gap without changing any assertion.
- **`migrateSuppliersBuyersToSupabase()`, `migrateLineItemsToSupabase()`, `migrateContactsToSupabase()`, `migrateOrdToSupabase()`, `migrateQteToSupabase()`, `migratePOToSupabase()`, `migrateInvToSupabase()`** — none of these functions' own pre-existing tests sets `st_sh_cloud_migration_ts`, references `DB.sh`, or calls `migrateShToSupabase()`; §2.2 confirms (and §3.2's own static-audit test locks in) that none of these seven functions' bodies references `DB.sh` at all. No pre-existing test needs updating.
- **`pullAll()`** — every pre-existing test exercising `pullAll()`'s `simpleEnts`/`_simpleEntsForBatch` loop leaves `st_sh_cloud_migration_ts` unset, so the new exclusion guard (§2.7) never activates for them; behavior is unchanged. The existing AC-8 test at `tests/run.js` ("pullAll() — drops an id-keyed pulled record (Contact) that resolves to a falsy id, keeps the rest of the batch") does not touch `'sh'` at all and is unaffected.
- **`initCloudDataLayer()`** — the four pre-existing tests retrofitted in §3.0 (`8089`, `8653`, `9060`, `9566`) are the only ones this REQ's new `refreshShFromSupabase()` wiring could otherwise silently break; all four are now stubbed correctly.
- **`processImportRecords()`/`processImport()`** — neither function gains a `'sh'` branch (REQ-CLOUD-007l); every pre-existing test exercising either is unaffected code and needs no update.
- **`cleanupExpiredMigrationArchive()`/`rCfg()`** — no pre-existing test asserts an exhaustive/exact set of restore-button ids or archive-expiry blocks (each existing per-entity test, e.g. the Invoice one at `tests/run.js:3121`-equivalent, only asserts its own entity's key), so appending an eighth block/line to each does not invalidate any existing assertion.

No pre-existing test was found to need a fix beyond the seven explicit retrofits in §3.0/§3.1 (four `initCloudDataLayer()` tests, three Shipment CRUD tests).

**Expected final test count: 869 (baseline) + 18 (new, §3.2) = 887/887.** (The seven §3.0/§3.1 retrofits modify existing tests in place and do not change the total count.)

---

## 4. Doc-file diffs — deliberately out of scope for this SPEC (REQ-CLOUD-007k, superseded)

REQ-CLOUD-007k was superseded and narrowed at requirements-gate round 3 (REQ-CLOUD-007 §2/§8): the broader Cloud Data documentation-staleness class it originally described (`index.html:781`/`10702`, `CLAUDE.md:94`, `docs/architecture-data-model-v1.md` §2/§4.3/§8, `STACKD_CONTEXT.md`) has been fixed directly and comprehensively **outside this REQ**, in `stkdcfpm/stackd-ops#133` (`claude/cloud-docs-currency-fix`), **not yet merged as of this SPEC**. Per the REQ's own explicit instruction, this SPEC:

- Does **not** touch `docs/architecture-data-model-v1.md`, `STACKD_CONTEXT.md`, `CLAUDE.md`, or `index.html:781`/`10702` at all.
- Does **not** attempt any grep-audit or doc-currency fix of its own devising for these files — that work is `#133`'s, independent of this REQ.
- Records this REQ's own remaining doc obligation as a small, mechanical, ship-time-only step, to be done **after** implementation and **after** confirming `#133` has merged: flip `#133`'s existing "Shipment ... in progress" phrasing to "done" in the four locations `#133` already left room for (`index.html:781`/`10702`, `CLAUDE.md:94`, `docs/architecture-data-model-v1.md` §2/§8), plus adding `REQ-CLOUD-007`'s own two new citation numbers (REQ and SPEC) where `#133` already left room for them. This is a build-gate/ship-time checklist item, not a SPEC-time diff, and is listed here only so it is not lost, not because this SPEC performs it.

The remaining ship-time tracker updates every REQ in this series performs (REQ-CLOUD-007 §7) are likewise deferred to implementation/build-gate time, not diffed in this SPEC: a new `REQ-CLOUD-007` row in `docs/requirements-tracker.md`; new `SH-GAP-001` (zero audit trail, unformatted `ref`) and `SH-GAP-002` (`mapRec()`/`unmapRec()` array-field asymmetry) entries in `docs/known-gaps.md`, both logged not fixed, with `CLOUD-GAP-003`'s existing title/Area line confirmed untouched since Shipment adds no CSV-import instance to it; a version-history/test-count bump; and a `docs/user-guide.md` Settings → Cloud Data section update for the new Shipment card. None of these five is architecture-data-model-v1.md/STACKD_CONTEXT.md/CLAUDE.md/`index.html:781`/`10702`, so none is precluded by the instruction above, but all five are ordinary post-implementation ship-time work in this series' own established pipeline (§6, "implementation → mutation testing → build-gate → PR → CI green → merge"), not SPEC-time diffs — consistent with how this SPEC's own §0–§3 are the only sections spec-gate needs to apply and test.

---

## 5. Baseline verification

`node tests/run.js` was re-run in this worktree before and after drafting this SPEC (which adds only this `.md` file — no `index.html`/`tests/run.js` change yet): **869/869 passing**, unchanged. This SPEC's own diffs (§1–§3) are not yet applied to either file; implementation begins from this document, per §6's gate process (SPEC → independent spec-gate review, applying every diff to a scratch copy and running the real suite → implementation → ... ).
