# SPEC-CLOUD-008 — Buyer Payment and Supplier Payment Cloud Data migration

**Status:** v1 — drafted against `docs/REQ-CLOUD-008-v1.md` (requirements-gate PASS, 2 rounds, all findings fixed in place — see that document's own §8). Build baseline: `main` @ `948c2ef`, 869/869 tests passing. All line citations below re-verified directly against this exact commit's `index.html` (14,402 lines) / `tests/run.js` (12,229 lines) in this worktree (`/tmp/cloud-008-payments-wt`, branch `claude/cloud-008-payments`, commit `d27fe1b`).

**Spec-gate round 1: CONDITIONAL PASS/FAIL — 2 blocking, 2 advisory, all fixed in place.** An independent reviewer applied every diff to a scratch copy and ran the real suite: 888/891 (3 failures), all traced to the SPEC's own §3 test text, not the production diffs in §0-§2 (independently re-derived and confirmed correct, including the single most important correctness property — `invId`-primary resolution, not Num-first, confirmed structural via a source probe showing `if (idResolves) return false;` short-circuits before `numResolves` is even computed). Blocking: (1) §3.6's AC-8 test permanently clobbered `ctx.sPost` without restoring it, corrupting a later, unrelated `pullAll()` test — fixed by restoring the original; (2) §3.5/§3.7 contained elided pseudocode (including one reference to a non-existent field id, `if-buyer`, the real id is `if-b`) and an unwritten comment in place of two required AC-9 tests — fixed by writing all of them out in full against the file's own established fixture conventions (`setupCNForm()`/`setupCNFormNew()`, and the `refreshInvFromSupabase()` stub convention at `tests/run.js:9885-9886`). Advisory: §3.9's test-count arithmetic didn't sum to its own stated total — corrected to 891/891; §0.4's "no reachable state" safety claim was stated more absolutely than warranted (the same self-marking risk every other entity's refresh function in this series already carries, not a new defect) — noted below, no code change needed. Reviewer applied all fixes and confirmed 891/891, all green; fixes applied here in place, re-verified directly. Per the project's tightened-process convention, this SPEC proceeds to implementation without a further spec-gate round.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **One migration file, two tables, two independent functions/markers/Settings cards** (REQ-CLOUD-008 §0.2) — mirrors `REQ-CLOUD-002`'s Line-Item-and-Contact shape, not `REQ-CLOUD-001`'s combined Supplier-and-Buyer exception.
- **No id-remapping and no outward sweep for either ledger** (§0.3) — both `p.invId`/`pm.poId` are already real, final Supabase ids by the time each ledger's own precondition is satisfiable (Invoice's/PO's own prior migrations already rewrote them), and nothing else references either ledger's own id (§1.5).
- **`getInvPayments(inv)`'s settled `invId`-primary/`invNum`-fallback rule is reused, inverted in direction, for Buyer Payment's orphan scan — NOT the older Num-first pattern** (§1.4). Supplier Payment's orphan scan is a bare `poId` match, no `poNum` fallback of any kind, matching `getPOPayments(poId)`'s own rule exactly.
- **No shared `persistPmtChange()`/`persistSupPmtChange()` helper for either ledger** (§1.1) — each of the four Buyer Payment mutation sites and two Supplier Payment mutation sites gets its own dedicated inline Cloud Data branch.
- **The orphan scan (REQ-CLOUD-008c) is non-blocking and purely informational** for both ledgers — a real, structural departure from every prior entity's blocking pre-flight FK check, because both ledgers already tolerate a dangling reference today as an accepted, pre-existing state (`INV-GAP-002`, `docs/architecture-data-model-v1.md` §6.10).
- **No duplicate-reference-number pre-flight scan** (REQ-CLOUD-008d) — neither ledger has a `num` field.
- **REQ-CLOUD-008i's cross-phase retrofit is included** — see §0.7 below for the reviewer-facing confirmation the REQ itself asked this document to make.
- **No `CLOUD-GAP-003` instance for either ledger's CSV import** — confirmed, neither has an import branch to bypass.
- **`FIELD_MAPS` needs no changes** — `FIELD_MAPS.payments` keeps its pre-existing (separately logged, not fixed here) `cur`/`currency` mismatch; no `FIELD_MAPS.supPayments` entry exists or is added.
- **Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only** — the same mechanics every prior Cloud Data migration in this series has used, with two fully independent marker pairs: `st_pmt_cloud_migration_ts`/`st_pmt_pre_migration` (Buyer Payment) and `st_spm_cloud_migration_ts`/`st_spm_pre_migration` (Supplier Payment).

The subsections below are design decisions this SPEC itself must add — each flows from applying REQ-CLOUD-008's already-fixed requirements to the *current* code, but none is spelled out verbatim in the REQ text, so each is flagged for spec-gate to check with extra scrutiny.

### 0.1 `savePayment()` cannot early-return like `saveLI()`/`saveCon()` do

`saveLI()`/`saveCon()`'s cloud branch persists, closes the modal, calls its own refresh function, and returns — the local branch is a fully separate code path. `savePayment()` cannot follow that shape: its own cascading logic (recomputing `inv.dep`/`inv.status`, the FPM-recovery sweep, calling `persistInvChange()`/`persistPOChange()`) reads the just-updated `DB.payments` array directly and must run identically whether the payment row itself was just persisted to Supabase or saved locally — REQ-CLOUD-008e item 1 does not ask for any change to that cascading logic. §2.5 below therefore only replaces the *top* of the function (the payment record's own persistence) with an `if (_sb && marker) {…} else {…}` branch that both paths fall through from, rather than two fully separate branches with early returns. `deletePayment()` (§2.6) follows the identical shape for the same reason.

### 0.2 `saveSupPayment()`, unlike `savePayment()`, mirrors `saveLI()`'s early-return shape exactly

Unlike Buyer Payment, `saveSupPayment()` has no cascading side effects on any other entity — its own body (today) is nothing but the upsert, `sv()`, `audit()`, `logEv()`. There is no reason for its cloud branch not to fully mirror `saveLI()`'s early-return shape (§2.9), which is the closer, more literal reading of REQ-CLOUD-008f item 1's "identical shape to REQ-CLOUD-008e item 1" instruction as applied to a function that — unlike `savePayment()` — has nothing else to fall through to afterward. `deleteSupPayment()` keeps a single flow (not an early return) only because it has a real shared tail (`renderPOPaymentsTab()`/`rPO()`/`rDash()`) that must run in both the cloud and local case, exactly mirroring `deletePayment()`'s own shape.

### 0.3 `addSupPaymentFromForm()` stays synchronous, unawaited — the identical, already-accepted precedent `addPaymentFromForm()` already established for `savePayment()`

Converting `saveSupPayment()` to `async` means a caller that does not `await` it (as `addSupPaymentFromForm()` does today, and continues to do here) will, once Supplier Payment is Cloud Data-migrated, invoke `renderPOPaymentsTab(poId); rPO(); rDash();` immediately after firing off `saveSupPayment(pm)` — before the Cloud Data round-trip resolves. This is a real, narrow staleness window (the PO list momentarily shows the pre-save ledger total until the next redraw), but it is **not new territory**: `addPaymentFromForm()` already has the exact same shape for `savePayment()` today (already `async`, already unawaited by its own synchronous caller), and `SPEC-CLOUD-005` §2.14 already established "no test awaits this today" as the accepted invariant for that exact call. `addSupPaymentFromForm()` is deliberately left unconverted and `saveSupPayment(pm);` stays a bare, unawaited call — mirroring the sibling ledger's own already-accepted disposition rather than introducing an `await` that would (a) do nothing for the overwhelming common case where Supplier Payment has not yet migrated on this device, and (b) force a cascading `testAsync`/`await` retrofit onto all four pre-existing `addSupPaymentFromForm()` tests (`tests/run.js:4589/4615/4653/5288`) and the one `deleteSupPayment()` test (`tests/run.js:5300`) for a benefit (fresher UI during an already-narrow window) this REQ never asked for. §3's AC-10 audit confirms this is safe: none of those five tests ever configure `_sb`, so the new `await`-bearing branches inside `saveSupPayment()`/`deleteSupPayment()` are structurally unreachable for every one of them, and both functions run to completion fully synchronously exactly as they do today.

### 0.4 Goodwill-credit pushes reuse `st_pmt_cloud_migration_ts` only, never re-check Invoice's own marker — safe by the precondition chain, not by coincidence

`saveInv()`'s/`saveCN()`'s goodwill-credit pushes (§2.7/§2.8) gate their new Cloud Data branch on `st_pmt_cloud_migration_ts` alone — not on whether *this* Invoice/CN save is itself cloud-configured. This is safe, not merely convenient: REQ-CLOUD-008b's own precondition requires Invoice's migration to be complete *before* Buyer Payment's migration can ever begin, so by the time `st_pmt_cloud_migration_ts` could possibly be set, `inv.id`/`cn.id` are unconditionally already real Supabase ids (Invoice/CN's own migration already ran). This holds for `migratePmtToSupabase()`'s own precondition-gated path. **Caveat, spec-gate round 1 (A2):** `refreshPmtFromSupabase()`, called unconditionally from `initCloudDataLayer()`, can itself set `st_pmt_cloud_migration_ts` independent of that precondition (its own guard only checks `DB.payments.length > 0 && !marker`, not Invoice's migration state) — a second device with an empty local `DB.payments` but a not-yet-locally-migrated `DB.inv` could self-set this marker on first load against an already-migrated project. This is the identical, already-accepted self-marking risk shape every other entity's own refresh function in this series carries (e.g. `refreshPOFromSupabase()`/`refreshInvFromSupabase()`), not a new defect this SPEC introduces — no code change needed, noted here so the claim above is not read as an unconditional guarantee.

### 0.5 `refreshPmtFromSupabase()`/`refreshSupPmtFromSupabase()` call no list-render function

Every prior entity's refresh function ends with a call to that entity's own list/table render function (`rLI()`, `rCon()`, `rInv(); rDash();`, etc.) because each entity has a dedicated list view. Neither payment ledger does — both render exclusively via `renderPaymentsTab(invId)`/`renderPOPaymentsTab(poId)`, each of which needs a specific parent id a blind full-array refresh does not have in scope, and each of which is already called from every mutation site that needs it (§2.5/§2.6/§2.9/§2.10, and pre-existing goodwill/FPM-recovery call sites). §2.2's two new refresh functions therefore end with `sv(...)` and the marker-set line only, calling no render function — a deliberate, narrower shape than every prior entity's, not an oversight.

### 0.6 REQ-CLOUD-008c's "surfaced in the pre-migration confirmation modal" is implemented as a `toast()` before the existing generic backup gate, not by modifying `showBlockingBackupModal()`

`showBlockingBackupModal()` (`index.html:6031-6039`) is a single, parameterless, shared modal reused by every migration function in this series (`migrateSuppliersBuyersToSupabase()` through `migrateInvToSupabase()`) — it has no mechanism to accept custom per-call text, and giving it one would be a broader refactor of shared code than this REQ scopes. The closer, cheaper fit for "surfaced… so an operator can review it before proceeding" is a `toast()` call immediately before `showBlockingBackupModal()` is invoked, when the orphan count is non-zero — visible to the operator (unlike CN's own precedent for its structurally similar dangling-reference case, `console.warn()` only, which is developer-facing) without touching shared modal code. §2.3/§2.4 implement it this way.

### 0.7 REQ-CLOUD-008i's cross-phase retrofit — confirmed included

REQ-CLOUD-008i left it to this SPEC to "confirm... whether the reviewer agrees this compound scenario justifies the added code." **This SPEC includes it.** The reasoning in REQ §1.6 is sound on its own terms — the retrofit only matters in the compound restore-Invoice-then-remigrate-after-Buyer-Payment-has-separately-migrated scenario, but that scenario is real and reachable (nothing currently prevents it), the fix is a handful of lines per sweep with no new precondition or schema surface, and it closes the exact same class of already-accepted cross-project staleness risk every prior retrofit in this series carries — not a new risk this REQ would be introducing. Declining it would leave a asymmetry (every other entity's inward sweep in this series gets this treatment once its target becomes Cloud-eligible; these two would not) for no savings large enough to justify the inconsistency. §2.11 implements both sweeps' retrofits.

### 0.8 Retrofit sweep pushes use a narrow, single-field `_sb` call directly — no shared persist helper needed

Since neither ledger has a `persistPmtChange()`/`persistSupPmtChange()` helper (§0 above), the two retrofit pushes in §2.11 do not route through one either. Each pushes exactly the one field the sweep itself changed (`inv_id`/`po_id`) via a direct `_sb.from(<table>).update({...}).eq('id', <id>)` call — mirroring this exact same function's own already-shipped, narrower-than-a-full-row precedent for the identical situation: `migrateInvToSupabase()`'s own `linked_inv_id` fix-up (`index.html:6730`) is a single-field update via a bare `_sb` call, not a full-row `persistInvChange()` push, for the same reason (the sweep only ever changes one column).

### 0.9 `supplier_payments.rate_lock` is `not null` — reconciling REQ §2's descriptive table against AC-1's literal wording

REQ-CLOUD-008a's own descriptive column table (§2) lists `supplier_payments.rate_lock` with the note "always present" but does not literally say "not null" the way it does for `currency`/`purpose`/`type`/`cre_at` on the same table. **AC-1, however, is explicit and unambiguous**: "`supplier_payments`' equivalents [of `currency`/`purpose`/`rate_lock`/`type`/`cre_at`] all `not null`" — naming all five fields as a matched, symmetric set against `buyer_payments`' identical five-field nullable set. Since the AC is the literally testable, authoritative statement and the descriptive table's omission reads as an inconsistency rather than a deliberate exception (no reasoning anywhere in the REQ singles `rate_lock` out for different treatment — §1.3 confirms it actually is unconditionally computed via `lockFxRate()` on every `addSupPaymentFromForm()` call, so `not null` costs nothing in practice), §1 below applies `not null` to `supplier_payments.rate_lock`, resolving the inconsistency in AC-1's favor. Flagged explicitly for spec-gate to double-check against the REQ author's actual intent.

---

## 1. New SQL migration: `supabase/migrations/0007_payments.sql`

```sql
-- SPEC-CLOUD-008: extends the Cloud Data shared-database layer to Buyer Payment and
-- Supplier Payment (Phase 3 sub-phase 3 of 3). One migration file, two independent
-- tables — mirrors 0002_line_items_contacts.sql's shape (REQ-CLOUD-008 §0.2), not
-- 0001's combined-table exception.
--
-- inv_id/po_id are deliberately NOT foreign-key-constrained and stay plain `text`,
-- matching every other cross-entity reference column in this series — even though,
-- uniquely among every entity migrated so far, neither value is ever remapped at
-- insert time (Invoice/Purchase Order already completed their own, separate, prior
-- migrations by the time either of these tables' own migration can run — REQ §0.3/
-- §1.4). Carried through verbatim.
--
-- buyer_payments.currency/purpose/rate_lock/type/cre_at are all independently
-- NULLABLE — REQ-INTEG-002-2c added purpose/currency/rateLock/type/creAt after this
-- ledger's own genesis shape, so a legacy pre-2c local record, and both of saveInv()'s/
-- saveCN()'s goodwill-credit pushes (which never set any of these five fields), are
-- real, currently-reachable record shapes this table must accept as-is (AC-1).
--
-- buyer_payments.ref (distinct from `reference`) preserves the goodwill-credit pushes'
-- own, narrower field verbatim, matching the ledger's own already-accepted, not-fixed-
-- here reference/ref display quirk (REQ §1.3, REQ-INTEG-002-2c §3) rather than merging
-- it into `reference` or silently dropping it.
--
-- supplier_payments.currency/purpose/rate_lock/type/cre_at are all NOT NULL — every
-- creation path for this ledger (addSupPaymentFromForm(), the only one) unconditionally
-- sets all five; there is no legacy-record or secondary-creation-path gap on this side
-- (REQ §1.3, AC-1).
--
-- Neither table has a `num`/reference-number field of any kind — no pre-flight
-- duplicate-number scan is needed for either ledger (REQ-CLOUD-008d), and no unique
-- constraint beyond the primary key is added.

create table buyer_payments (
  id          uuid primary key default gen_random_uuid(),
  inv_id      text,
  inv_num     text,
  date        text,
  amount      numeric,
  method      text,
  purpose     text,
  currency    text,
  rate_lock   jsonb,
  reference   text,
  ref         text,
  notes       text,
  type        text,
  cre_at      timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  po_id       text,
  po_num      text,
  date        text,
  amount      numeric,
  currency    text not null,
  purpose     text not null,
  method      text,
  reference   text,
  notes       text,
  rate_lock   jsonb not null,
  type        text not null default 'supplier_payment',
  cre_at      timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

alter table buyer_payments    enable row level security;
alter table supplier_payments enable row level security;

create policy "authenticated read"   on buyer_payments    for select using (auth.role() = 'authenticated');
create policy "authenticated write"  on buyer_payments    for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on buyer_payments    for update using (auth.role() = 'authenticated');
create policy "authenticated read"   on supplier_payments for select using (auth.role() = 'authenticated');
create policy "authenticated write"  on supplier_payments for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on supplier_payments for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
```

---

## 2. `index.html` changes

### 2.1 New `isInvMigrationComplete()` — mirrors `isPOMigrationComplete()` exactly

Current (`index.html:5959-5964`, last of the four existing `is*MigrationComplete()` helpers, immediately before `findDuplicateSupplierNames()` at `5966`):

```js
async function isPOMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_po_cloud_migration_ts')) return true;
  var result = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
```

New — insert immediately after this function closes (`index.html:5964`), before `findDuplicateSupplierNames()`:

```js
async function isPOMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_po_cloud_migration_ts')) return true;
  var result = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}

async function isInvMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_inv_cloud_migration_ts')) return true;
  var result = await _sb.from('invoices').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
```

Supplier Payment's own precondition reuses `isPOMigrationComplete()` verbatim — no new helper on that side (REQ-CLOUD-008b/§1.8).

### 2.2 New `refreshPmtFromSupabase()`/`refreshSupPmtFromSupabase()`, and `initCloudDataLayer()` wiring

Insert immediately after `refreshInvFromSupabase()` closes (`index.html:5842`), before `persistInvChange()` (`index.html:5844`):

```js
async function refreshPmtFromSupabase() {
  if (!_sb) return;
  if (DB.payments.length > 0 && !localStorage.getItem('st_pmt_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('buyer_payments').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Payments from Cloud Data.'); return; }
  DB.payments = result.data.map(function(row){
    var rec = { id: row.id, invId: row.inv_id || '', invNum: row.inv_num || '', date: row.date, amount: row.amount, method: row.method || '' };
    if (row.purpose   != null) rec.purpose   = row.purpose;
    if (row.currency  != null) rec.currency  = row.currency;
    if (row.rate_lock != null) rec.rateLock  = row.rate_lock;
    if (row.reference != null) rec.reference = row.reference;
    if (row.ref       != null) rec.ref       = row.ref;
    if (row.notes     != null) rec.notes     = row.notes;
    if (row.type      != null) rec.type      = row.type;
    if (row.cre_at    != null) rec.creAt     = row.cre_at;
    return rec;
  });
  sv(K.pm, DB.payments);
  if (!localStorage.getItem('st_pmt_cloud_migration_ts')) localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  // No list-render call — Buyer Payment has no dedicated list view; every mutation site
  // that needs a redraw already calls renderPaymentsTab(invId) itself (SPEC §0.5).
}

async function refreshSupPmtFromSupabase() {
  if (!_sb) return;
  if (DB.supPayments.length > 0 && !localStorage.getItem('st_spm_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('supplier_payments').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Supplier Payments from Cloud Data.'); return; }
  DB.supPayments = result.data.map(function(row){
    return {
      id: row.id, poId: row.po_id || '', poNum: row.po_num || '', date: row.date, amount: row.amount,
      currency: row.currency, purpose: row.purpose, method: row.method || '',
      reference: row.reference || '', notes: row.notes || '', rateLock: row.rate_lock,
      type: row.type, creAt: row.cre_at
    };
  });
  sv(K.spm, DB.supPayments);
  if (!localStorage.getItem('st_spm_cloud_migration_ts')) localStorage.setItem('st_spm_cloud_migration_ts', new Date().toISOString());
  // No list-render call — same reasoning as refreshPmtFromSupabase() above; Supplier
  // Payment renders exclusively via renderPOPaymentsTab(poId).
}
```

`initCloudDataLayer()` (`index.html:5633-5646`), current:

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

New — two lines added, immediately after `await refreshInvFromSupabase();`:

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
    await refreshPmtFromSupabase();
    await refreshSupPmtFromSupabase();
  }
}
```

**This wiring requires retrofitting all four pre-existing `initCloudDataLayer()` tests in `tests/run.js`** — see §3, AC-7.

### 2.3 `migratePmtToSupabase()` — new function

Insert immediately after `migrateInvToSupabase()` closes (`index.html:6784`), before `restoreFromMigrationArchive()` (`index.html:6786`):

```js
async function migratePmtToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-008b: single precondition — Invoice must have completed its own
  // migration first. Every DB.payments[].invId, once resolvable, already resolves to
  // a real Supabase invoice id by this point (REQ §0.3/§1.4) — Buyer's own completion
  // is already transitively guaranteed by Invoice's own precondition (REQ-CLOUD-006a),
  // so no separate Buyer check is needed here.
  if (!(await isInvMigrationComplete())) { toast('Migrate Invoices to Cloud Data first — every Buyer Payment requires an Invoice link.'); return; }

  // REQ-CLOUD-008d: neither ledger has a num field — no duplicate-reference-number
  // pre-flight scan applies here. Documented no-op, not an oversight.

  // REQ-CLOUD-008c: non-blocking informational orphan scan, reusing getInvPayments()'s
  // own settled invId-primary/invNum-fallback rule (§1.4), inverted in direction —
  // given a payment, does ANY current DB.inv record satisfy it. Checked against local
  // DB.inv (already carrying real Supabase ids by this point, per the precondition
  // above), NOT a live query — unlike every prior entity's BLOCKING pre-flight FK
  // check, this never blocks the migration (both ledgers already tolerate a dangling
  // reference today as an accepted, pre-existing state — REQ §2c).
  var orphanPmtCount = DB.payments.filter(function(p){
    var idResolves = p.invId && DB.inv.some(function(i){ return i.id === p.invId; });
    if (idResolves) return false;
    var numResolves = p.invNum && DB.inv.some(function(i){ return i.num === p.invNum; });
    return !numResolves;
  }).length;
  if (orphanPmtCount) toast('⚠ ' + orphanPmtCount + ' payment record(s) reference an invoice that could not be resolved — they will migrate with the dangling reference preserved, not blocked. Review Payments after migrating if unexpected.');

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  // REQ-CLOUD-008 §0.3: no id-remapping needed at insert time — invId/invNum are
  // already real, final values (Invoice's own migration already rewrote them via
  // migrateInvToSupabase()'s own existing sweep, §2.11) — carried through verbatim.
  var pmtIdMap = {};
  for (var i = 0; i < DB.payments.length; i++) {
    var p = DB.payments[i];
    var row = {
      inv_id: p.invId || null, inv_num: p.invNum || null, date: p.date || null, amount: p.amount,
      method: p.method || null, purpose: p.purpose != null ? p.purpose : null,
      currency: p.currency != null ? p.currency : null, rate_lock: p.rateLock != null ? p.rateLock : null,
      reference: p.reference != null ? p.reference : null, ref: p.ref != null ? p.ref : null,
      notes: p.notes || null, type: p.type != null ? p.type : null, cre_at: p.creAt != null ? p.creAt : null
    };
    var result = await _sb.from('buyer_payments').insert(row).select().single();
    if (result.error) { toast('Migration failed on payment ' + (p.invNum||p.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    pmtIdMap[p.id] = result.data.id;
  }

  // REQ-CLOUD-008 §1.5: no outward sweep — nothing else references a payment's own id.

  localStorage.setItem('st_pmt_pre_migration', localStorage.getItem(K.pm));
  localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());

  DB.payments.forEach(function(p){ if (pmtIdMap[p.id]) p.id = pmtIdMap[p.id]; });
  sv(K.pm, DB.payments);

  await refreshPmtFromSupabase();
  if (G('cfg-sb-pmt-restore-btn')) G('cfg-sb-pmt-restore-btn').style.display = '';
  toast('Buyer Payment migration complete. Pre-migration data archived for 30 days.');
}
```

### 2.4 `migrateSupPmtToSupabase()` — new function

Insert immediately after `migratePmtToSupabase()` closes:

```js
async function migrateSupPmtToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-008b: single precondition — Purchase Order must have completed its own
  // migration first. isPOMigrationComplete() (existing) is reused verbatim.
  if (!(await isPOMigrationComplete())) { toast('Migrate Purchase Orders to Cloud Data first — every Supplier Payment requires a Purchase Order link.'); return; }

  // REQ-CLOUD-008d: no num field on this ledger — no duplicate-reference-number scan.

  // REQ-CLOUD-008c: non-blocking informational orphan scan — bare poId match, NO
  // poNum fallback of any kind (getPOPayments()'s own settled rule, §1.4). Checked
  // against the LIVE, connected Purchase Order table (unlike Buyer Payment's scan
  // above, which checks local DB.inv) — Supplier Payment has zero Sheets footprint
  // (§1.2/§1.7), so a second device's local DB.po copy carries no equivalent
  // guarantee of being current that Buyer Payment's precondition chain gives DB.inv.
  // Never blocks the migration.
  var knownPOIdsForScan = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  if (knownPOIdsForScan.error) { toast('Could not verify Purchase Order links before migrating: ' + knownPOIdsForScan.error.message); return; }
  var knownPOIdSetForScan = {};
  knownPOIdsForScan.data.forEach(function(p){ knownPOIdSetForScan[p.id] = true; });
  var orphanSupPmtCount = DB.supPayments.filter(function(pm){ return !pm.poId || !knownPOIdSetForScan[pm.poId]; }).length;
  if (orphanSupPmtCount) toast('⚠ ' + orphanSupPmtCount + ' supplier payment record(s) reference a Purchase Order that could not be resolved — they will migrate with the dangling reference preserved, not blocked. Review Supplier Payments after migrating if unexpected.');

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  var supPmtIdMap = {};
  for (var i = 0; i < DB.supPayments.length; i++) {
    var pm = DB.supPayments[i];
    var row = {
      po_id: pm.poId || null, po_num: pm.poNum || null, date: pm.date || null, amount: pm.amount,
      currency: pm.currency, purpose: pm.purpose, method: pm.method || null,
      reference: pm.reference || null, notes: pm.notes || null, rate_lock: pm.rateLock || null,
      type: pm.type || null, cre_at: pm.creAt || null
    };
    var result = await _sb.from('supplier_payments').insert(row).select().single();
    if (result.error) { toast('Migration failed on supplier payment ' + (pm.poNum||pm.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    supPmtIdMap[pm.id] = result.data.id;
  }

  // No outward sweep — nothing else references a Supplier Payment's own id (§1.5).

  localStorage.setItem('st_spm_pre_migration', localStorage.getItem(K.spm));
  localStorage.setItem('st_spm_cloud_migration_ts', new Date().toISOString());

  DB.supPayments.forEach(function(pm){ if (supPmtIdMap[pm.id]) pm.id = supPmtIdMap[pm.id]; });
  sv(K.spm, DB.supPayments);

  await refreshSupPmtFromSupabase();
  if (G('cfg-sb-spm-restore-btn')) G('cfg-sb-spm-restore-btn').style.display = '';
  toast('Supplier Payment migration complete. Pre-migration data archived for 30 days.');
}
```

### 2.5 `savePayment()` (`index.html:13662-13726`) — create-or-update `_sb` branch

Current, top of the function (`13662-13668`):

```js
async function savePayment(payment) {
  var existing = DB.payments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.payments[existing] = payment; }
  else { DB.payments.push(payment); }
  sv(K.pm, DB.payments);
  audit('SAVE', 'payment', payment.id, payment);
  logEv('payment', payment.id, 'created', 'Payment $' + (+payment.amount||0).toFixed(2) + ' received — ' + (payment.invNum||payment.invId||''), 'operator');
```

New (everything from `// Update invoice dep field...` at `13670` through the end of the function at `13726` is **unchanged** — see §0.1 for why):

```js
async function savePayment(payment) {
  // REQ-CLOUD-008e item 1: own dedicated create-or-update _sb-branch. Cannot early-
  // return like saveLI()/saveCon() do — the cascading Invoice/PO logic below reads
  // the just-updated DB.payments array and must run in both the cloud and local case
  // (SPEC §0.1).
  var pmtIsNew = !DB.payments.some(function(p){ return p.id === payment.id; });
  if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var pmtRow = {
      inv_id: payment.invId || null, inv_num: payment.invNum || null, date: payment.date || null,
      amount: payment.amount, method: payment.method || null,
      purpose: payment.purpose != null ? payment.purpose : null,
      currency: payment.currency != null ? payment.currency : null,
      rate_lock: payment.rateLock != null ? payment.rateLock : null,
      reference: payment.reference != null ? payment.reference : null,
      ref: payment.ref != null ? payment.ref : null,
      notes: payment.notes || null, type: payment.type != null ? payment.type : null,
      cre_at: payment.creAt != null ? payment.creAt : null
    };
    var pmtResult = pmtIsNew
      ? await _sb.from('buyer_payments').insert(pmtRow).select().single()
      : await _sb.from('buyer_payments').update(pmtRow).eq('id', payment.id).select().single();
    if (pmtResult.error) { toast('Save failed: ' + pmtResult.error.message); return; }
    payment.id = pmtResult.data.id; // resolve the real Supabase id onto the local record (AC-4) — no client-generated id is ever sent
  }
  var existing = DB.payments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.payments[existing] = payment; }
  else { DB.payments.push(payment); }
  if (!(_sb && localStorage.getItem('st_pmt_cloud_migration_ts'))) sv(K.pm, DB.payments);
  audit('SAVE', 'payment', payment.id, payment);
  logEv('payment', payment.id, 'created', 'Payment $' + (+payment.amount||0).toFixed(2) + ' received — ' + (payment.invNum||payment.invId||''), 'operator');

  // Update invoice dep field to match total paid
  var inv = DB.inv.find(function(i){ return i.id === payment.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaidNative(inv);
    inv.dep = totalPaid;
    inv.updAt = new Date().toISOString();

    // Auto-status based on payments
    // Use calc_grandTotal as source of truth — round to 2dp to avoid float issues
    var grand = Math.round((+inv.calc_grandTotal || cInv(inv).grand) * 100) / 100;
    var paid  = Math.round(totalPaid * 100) / 100;
    var prevStatus = inv.status;
    if (paid >= grand && grand > 0) {
      inv.status = 'Paid';
    } else if (paid > 0 && paid < grand) {
      inv.status = 'Partially Paid';
    }

    if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
      await persistInvChange(inv, true);
    } else {
      sv(K.i, DB.inv);
    }
    syncEnt('inv', inv).catch(function(){});

    // Auto-recover FPM deposits if now Paid
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
      if (recovered) toast('✓ Invoice marked Paid — FPM deposits auto-recovered');
      else toast('✓ Invoice marked Paid');
    }

    if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) await refreshInvFromSupabase();
    rInv(); rDash();
  }

  // Payments not synced to Sheets yet — handled in v3.0.0
}
```

### 2.6 `deletePayment()` (`index.html:13728-13768`) — soft-delete `_sb` branch

Current, top of the function (`13728-13735`):

```js
async function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  sv(K.pm, DB.payments);
  audit('DELETE', 'payment', id, pm);
```

New (everything from `// Recalculate invoice dep` at `13737` through `13768` is **unchanged**):

```js
async function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  // REQ-CLOUD-008e item 2: own dedicated soft-delete branch.
  if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var pmtDelResult = await _sb.from('buyer_payments').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (pmtDelResult.error) { toast('Delete failed: ' + pmtDelResult.error.message); return; }
  } else {
    sv(K.pm, DB.payments);
  }
  audit('DELETE', 'payment', id, pm);

  // Recalculate invoice dep
  var inv = DB.inv.find(function(i){ return i.id === pm.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaidNative(inv);
    inv.dep = totalPaid;
    inv.updAt = new Date().toISOString();

    // Re-derive inv.status, narrowly — only when the CURRENT status is one this exact
    // auto-status logic (savePayment()'s own, mirrored here) could itself have produced.
    // Never touch Draft/Pro-forma/Sent/Cancelled (REQ §1.3/§2c-d, AC-6).
    if (inv.status === 'Partially Paid' || inv.status === 'Paid') {
      var grand = Math.round((+inv.calc_grandTotal || cInv(inv).grand) * 100) / 100;
      var paid  = Math.round(totalPaid * 100) / 100;
      if (paid >= grand && grand > 0) {
        inv.status = 'Paid';
      } else if (paid > 0 && paid < grand) {
        inv.status = 'Partially Paid';
      } else {
        inv.status = 'Sent';
      }
    }

    if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
      await persistInvChange(inv, false);
    } else {
      sv(K.i, DB.inv);
    }
    syncEnt('inv', inv).catch(function(){});
    rInv(); rDash();
  }
  renderPaymentsTab(pm.invId);
}
```

### 2.7 `saveInv()`'s goodwill-credit push (`index.html:7582-7587`)

Current:

```js
  // Goodwill credit: maintain a payments ledger entry (remove stale, add current)
  if (inv.type === 'goodwill_credit' && inv.cnAmount) {
    DB.payments = DB.payments.filter(function(p){ return !(p.invId===inv.id && p.method==='Goodwill Credit'); });
    DB.payments.push({ id:uid(), invId:inv.id, invNum:inv.num, amount:+inv.cnAmount||0, method:'Goodwill Credit', ref:inv.num, notes:inv.cnReason||'', date:inv.date||today() });
    sv(K.pm, DB.payments);
  }
```

New:

```js
  // Goodwill credit: maintain a payments ledger entry (remove stale, add current)
  if (inv.type === 'goodwill_credit' && inv.cnAmount) {
    var _gwPmt = { id: uid(), invId: inv.id, invNum: inv.num, amount: +inv.cnAmount||0, method: 'Goodwill Credit', ref: inv.num, notes: inv.cnReason||'', date: inv.date||today() };
    if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) {
      if (!(await ensureSbAuth())) return;
      // REQ-CLOUD-008e item 3: delete-then-recreate, mirroring the local filter's own
      // shape exactly (never an in-place edit). Predicate: inv_id = <resolved Supabase
      // invoice id> and method = 'Goodwill Credit' — matches the local filter above
      // verbatim. Safe to assume inv.id is already a real Supabase id whenever this
      // branch is reachable — REQ-CLOUD-008b's own precondition requires Invoice's
      // migration to already be complete before st_pmt_cloud_migration_ts can be set
      // (SPEC §0.4).
      var gwDelResult = await _sb.from('buyer_payments').update({ deleted_at: new Date().toISOString() }).eq('inv_id', inv.id).eq('method', 'Goodwill Credit');
      if (gwDelResult.error) { toast('Save failed: ' + gwDelResult.error.message); return; }
      var gwInsResult = await _sb.from('buyer_payments').insert({
        inv_id: inv.id, inv_num: inv.num, amount: +inv.cnAmount||0, method: 'Goodwill Credit',
        ref: inv.num, notes: inv.cnReason||'', date: inv.date||today()
      }).select().single();
      if (gwInsResult.error) { toast('Save failed: ' + gwInsResult.error.message); return; }
      _gwPmt.id = gwInsResult.data.id;
      DB.payments = DB.payments.filter(function(p){ return !(p.invId===inv.id && p.method==='Goodwill Credit'); });
      DB.payments.push(_gwPmt);
    } else {
      DB.payments = DB.payments.filter(function(p){ return !(p.invId===inv.id && p.method==='Goodwill Credit'); });
      DB.payments.push(_gwPmt);
      sv(K.pm, DB.payments);
    }
  }
```

`saveInv()` is already `async` (its own `_sb` invoice-row branch immediately above this, ending at `index.html:7580`, already `await`s) — no signature change needed.

### 2.8 `saveCN()`'s goodwill-credit push (`index.html:10586-10591`)

Current:

```js
  // Goodwill credit → payments ledger entry
  if (type === 'goodwill_credit') {
    DB.payments = DB.payments.filter(function(p){ return p.invId !== cn.id; });
    DB.payments.push({ id: uid(), invId: cn.id, invNum: cn.num, date: cn.date||today(), amount: amt, method: 'Goodwill Credit', ref: cn.cnReason||'Goodwill credit', notes: '' });
    sv(K.pm, DB.payments);
  }
```

New:

```js
  // Goodwill credit → payments ledger entry
  if (type === 'goodwill_credit') {
    var _gwCnPmt = { id: uid(), invId: cn.id, invNum: cn.num, date: cn.date||today(), amount: amt, method: 'Goodwill Credit', ref: cn.cnReason||'Goodwill credit', notes: '' };
    if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) {
      if (!(await ensureSbAuth())) return;
      // REQ-CLOUD-008e item 4: identical delete-then-recreate treatment, matched on
      // inv_id ONLY — mirrors the local filter above, which removes ALL prior entries
      // for this CN's own id (cn.id here IS the Credit Note's own id, never an
      // Invoice's), not just ones matching a method.
      var gwCnDelResult = await _sb.from('buyer_payments').update({ deleted_at: new Date().toISOString() }).eq('inv_id', cn.id);
      if (gwCnDelResult.error) { toast('Save failed: ' + gwCnDelResult.error.message); return; }
      var gwCnInsResult = await _sb.from('buyer_payments').insert({
        inv_id: cn.id, inv_num: cn.num, date: cn.date||today(), amount: amt, method: 'Goodwill Credit',
        ref: cn.cnReason||'Goodwill credit', notes: ''
      }).select().single();
      if (gwCnInsResult.error) { toast('Save failed: ' + gwCnInsResult.error.message); return; }
      _gwCnPmt.id = gwCnInsResult.data.id;
      DB.payments = DB.payments.filter(function(p){ return p.invId !== cn.id; });
      DB.payments.push(_gwCnPmt);
    } else {
      DB.payments = DB.payments.filter(function(p){ return p.invId !== cn.id; });
      DB.payments.push(_gwCnPmt);
      sv(K.pm, DB.payments);
    }
  }
```

`saveCN()` is already `async` (its own `_sb` CN-row branch immediately above, `cn.id = cnResult.data.id;` at `index.html:10570`, already runs before this block) — no signature change needed.

### 2.9 `saveSupPayment()` (`index.html:13994-14001`) — converted to `async`, create-or-update `_sb` branch

Current:

```js
function saveSupPayment(payment) {
  var existing = DB.supPayments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.supPayments[existing] = payment; }
  else { DB.supPayments.push(payment); }
  sv(K.spm, DB.supPayments);
  audit('SAVE', 'sup_payment', payment.id, payment);
  logEv('sup_payment', payment.id, 'created', 'Supplier payment ' + payment.currency + ' ' + (+payment.amount||0).toFixed(2) + ' recorded — ' + (payment.poNum||payment.poId||''), 'operator');
}
```

New:

```js
async function saveSupPayment(payment) {
  // REQ-CLOUD-008f item 1: own dedicated create-or-update _sb-branch. Unlike
  // savePayment(), this function has no cascading side effects on any other entity,
  // so its cloud branch fully mirrors saveLI()'s early-return shape (SPEC §0.2).
  var spmIsNew = !DB.supPayments.some(function(p){ return p.id === payment.id; });
  if (_sb && localStorage.getItem('st_spm_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var spmRow = {
      po_id: payment.poId || null, po_num: payment.poNum || null, date: payment.date || null,
      amount: payment.amount, currency: payment.currency, purpose: payment.purpose,
      method: payment.method || null, reference: payment.reference || null, notes: payment.notes || null,
      rate_lock: payment.rateLock || null, type: payment.type || null, cre_at: payment.creAt || null
    };
    var spmResult = spmIsNew
      ? await _sb.from('supplier_payments').insert(spmRow).select().single()
      : await _sb.from('supplier_payments').update(spmRow).eq('id', payment.id).select().single();
    if (spmResult.error) { toast('Save failed: ' + spmResult.error.message); return; }
    payment.id = spmResult.data.id; // resolve the real Supabase id onto the local record (AC-4)
    var spmIdx = DB.supPayments.findIndex(function(p){ return p.id === payment.id; });
    if (spmIdx >= 0) { DB.supPayments[spmIdx] = payment; } else { DB.supPayments.push(payment); }
    audit('SAVE', 'sup_payment', payment.id, payment);
    logEv('sup_payment', payment.id, 'created', 'Supplier payment ' + payment.currency + ' ' + (+payment.amount||0).toFixed(2) + ' recorded — ' + (payment.poNum||payment.poId||''), 'operator');
    return;
  }
  var existing = DB.supPayments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.supPayments[existing] = payment; }
  else { DB.supPayments.push(payment); }
  sv(K.spm, DB.supPayments);
  audit('SAVE', 'sup_payment', payment.id, payment);
  logEv('sup_payment', payment.id, 'created', 'Supplier payment ' + payment.currency + ' ' + (+payment.amount||0).toFixed(2) + ' recorded — ' + (payment.poNum||payment.poId||''), 'operator');
}
```

`addSupPaymentFromForm()` (`index.html:14070-14101`) is **not** converted and its bare `saveSupPayment(pm);` call (`14098`) is **not** awaited — see §0.3.

### 2.10 `deleteSupPayment()` (`index.html:14003-14013`) — converted to `async`, soft-delete `_sb` branch

Current:

```js
function deleteSupPayment(id) {
  var pm = DB.supPayments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this supplier payment record?')) return;
  logEv('sup_payment', pm.id, 'deleted', 'Supplier payment deleted — ' + (pm.poNum||pm.poId||''), 'operator');
  DB.supPayments = DB.supPayments.filter(function(p){ return p.id !== id; });
  sv(K.spm, DB.supPayments);
  audit('DELETE', 'sup_payment', id, pm);
  renderPOPaymentsTab(pm.poId);
  rPO(); rDash();
}
```

New:

```js
async function deleteSupPayment(id) {
  var pm = DB.supPayments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this supplier payment record?')) return;
  logEv('sup_payment', pm.id, 'deleted', 'Supplier payment deleted — ' + (pm.poNum||pm.poId||''), 'operator');
  DB.supPayments = DB.supPayments.filter(function(p){ return p.id !== id; });
  // REQ-CLOUD-008f item 2: own dedicated soft-delete branch. A single flow, not an
  // early return — renderPOPaymentsTab()/rPO()/rDash() below must run in both the
  // cloud and local case, mirroring deletePayment()'s own shape (SPEC §0.2).
  if (_sb && localStorage.getItem('st_spm_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var spmDelResult = await _sb.from('supplier_payments').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (spmDelResult.error) { toast('Delete failed: ' + spmDelResult.error.message); return; }
  } else {
    sv(K.spm, DB.supPayments);
  }
  audit('DELETE', 'sup_payment', id, pm);
  renderPOPaymentsTab(pm.poId);
  rPO(); rDash();
}
```

**AC-10 call-site audit (`saveSupPayment()`/`deleteSupPayment()`), performed directly against `tests/run.js`:**

| Call site | Line | Style | Configures `_sb`? | Safe? |
|---|---|---|---|---|
| `addSupPaymentFromForm()` test — creates record with poId/poNum/rateLock (AC-1) | `4579-4653` (calls at `4589`) | `test()` (sync) | No | Yes — local branch only, no `await` ever reached |
| `addSupPaymentFromForm()` test — currency handling | calls at `4615` | `test()` (sync) | No | Yes |
| `addSupPaymentFromForm()` test — always requires poId (AC-6) | calls at `4653` | `test()` (sync) | No | Yes |
| `addSupPaymentFromForm()` re-renders PO list (Priority 2) | `5276-5290` (calls at `5288`) | `test()` (sync) | No | Yes |
| `deleteSupPayment()` re-renders PO list (Priority 2) | `5292-5303` (calls at `5300`) | `test()` (sync) | No | Yes |

No test file anywhere sets `ctx._sb` before line `7358` (confirmed by direct grep of every `ctx._sb =` assignment in `tests/run.js`) — every one of the five call sites above runs strictly before Cloud Data is ever configured in the suite, so the newly-added `if (_sb && localStorage.getItem(...))` branches inside both functions are structurally unreachable for all of them. Both functions therefore still run to completion **fully synchronously** in every existing test, exactly as they do today (no `await` is ever actually reached) — no test changes are required for this async conversion, beyond the four `initCloudDataLayer()` retrofits in §3/AC-7 (a separate, unrelated wiring change).

### 2.11 Cross-phase retrofit (REQ-CLOUD-008i — confirmed included, §0.7)

`migrateInvToSupabase()`'s existing `DB.payments[].invId` sweep (`index.html:6754-6768`). Current:

```js
  // REQ-CLOUD-006g: local-only inward sweep of DB.payments[].invId — invNum-first,
  // invId-fallback, identical precedence. No Supabase push — Buyer Payment isn't
  // Cloud-eligible yet (Phase 3 sub-phase 3). Also covers self-referencing
  // goodwill-credit DB.payments[] entries automatically (§1.6 of the REQ), since
  // those always carry a correct invId/invNum pair at creation and resolve via
  // either path identically.
  var paymentsChanged = false;
  DB.payments.forEach(function(p){
    var home = p.invNum ? DB.inv.find(function(x){ return x.num === p.invNum; }) : null;
    if (!home && p.invId) home = DB.inv.find(function(x){ return x.id === p.invId; });
    if (!home || !invIdMap[home.id]) return;
    var newInvId = invIdMap[home.id];
    if (p.invId !== newInvId) { p.invId = newInvId; paymentsChanged = true; }
  });
  if (paymentsChanged) sv(K.pm, DB.payments);
```

New:

```js
  // REQ-CLOUD-006g: local-only inward sweep of DB.payments[].invId — invNum-first,
  // invId-fallback, identical precedence. Also covers self-referencing goodwill-credit
  // DB.payments[] entries automatically (§1.6 of REQ-CLOUD-006), since those always
  // carry a correct invId/invNum pair at creation and resolve via either path
  // identically.
  //
  // REQ-CLOUD-008i (defense-in-depth retrofit, SPEC §0.7): in the ORDINARY case this
  // sweep runs strictly before Buyer Payment's own migration is even reachable (its
  // precondition requires Invoice's migration to already be complete), so nothing here
  // needs pushing. The one compound scenario where it matters: Invoice is restored and
  // re-migrated AFTER Buyer Payment has separately already migrated (its own marker
  // survives Invoice's own restore untouched) — a touched payment record could then
  // genuinely need pushing. Narrow, single-field push, no shared persistPmtChange()
  // helper (SPEC §0.8) — mirrors this same function's own linked_inv_id fix-up above.
  var paymentsChanged = false;
  var touchedPmtIdsForInv = {};
  DB.payments.forEach(function(p){
    var home = p.invNum ? DB.inv.find(function(x){ return x.num === p.invNum; }) : null;
    if (!home && p.invId) home = DB.inv.find(function(x){ return x.id === p.invId; });
    if (!home || !invIdMap[home.id]) return;
    var newInvId = invIdMap[home.id];
    if (p.invId !== newInvId) { p.invId = newInvId; paymentsChanged = true; touchedPmtIdsForInv[p.id] = true; }
  });
  if (paymentsChanged) sv(K.pm, DB.payments);

  if (Object.keys(touchedPmtIdsForInv).length && localStorage.getItem('st_pmt_cloud_migration_ts')) {
    for (var pmi = 0; pmi < DB.payments.length; pmi++) {
      if (!touchedPmtIdsForInv[DB.payments[pmi].id]) continue;
      var pmtSweepResult = await _sb.from('buyer_payments').update({ inv_id: DB.payments[pmi].invId }).eq('id', DB.payments[pmi].id);
      if (pmtSweepResult.error) console.warn('[Stackd] migrateInvToSupabase: failed to push retrofit invId update for payment ' + DB.payments[pmi].id, pmtSweepResult.error.message);
    }
    await refreshPmtFromSupabase();
  }
```

`migratePOToSupabase()`'s existing `DB.supPayments[].poId` sweep (`index.html:6565-6566`, in context of `6540-6566`). Current:

```js
  // REQ-CLOUD-005h: outward sweep — Quote.linkedPOIds[] is an array, not a scalar;
  // rewrite each matching element in place via the id-map, never via any other field
  // as the join key. Invoice.pos[] gets the same array-element treatment (REQ-CLOUD-006e
  // call site #13, corrected — Invoice is now Cloud-eligible too, so this sweep also
  // pushes each touched invoice back to Supabase, below). DB.supPayments[].poId likewise
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

  var touchedInvIdsForPo = {};
  DB.inv.forEach(function(inv){
    if (inv.pos && inv.pos.length) {
      var newPos = inv.pos.map(function(pid){ return poIdMap[pid] || pid; });
      if (JSON.stringify(newPos) !== JSON.stringify(inv.pos)) { inv.pos = newPos; touchedInvIdsForPo[inv.id] = true; }
    }
  });
  sv(K.i, DB.inv);

  DB.supPayments.forEach(function(pm){ if (poIdMap[pm.poId]) pm.poId = poIdMap[pm.poId]; });
  sv(K.spm, DB.supPayments);
```

New (only the `DB.supPayments` block, at the tail, changes — the Quote/Invoice blocks above it are untouched):

```js
  // REQ-CLOUD-008i (defense-in-depth retrofit, SPEC §0.7): same reasoning as
  // migrateInvToSupabase()'s identical treatment of DB.payments[].invId above — the
  // ordinary case needs no push (this sweep runs strictly before Supplier Payment's
  // own migration is reachable), but a restore-and-remigrate of Purchase Order after
  // Supplier Payment has separately already migrated makes this non-vacuous.
  var touchedSupPmtIdsForPo = {};
  DB.supPayments.forEach(function(pm){ if (poIdMap[pm.poId]) { pm.poId = poIdMap[pm.poId]; touchedSupPmtIdsForPo[pm.id] = true; } });
  sv(K.spm, DB.supPayments);

  if (Object.keys(touchedSupPmtIdsForPo).length && localStorage.getItem('st_spm_cloud_migration_ts')) {
    for (var spmi = 0; spmi < DB.supPayments.length; spmi++) {
      if (!touchedSupPmtIdsForPo[DB.supPayments[spmi].id]) continue;
      var spmtSweepResult = await _sb.from('supplier_payments').update({ po_id: DB.supPayments[spmi].poId }).eq('id', DB.supPayments[spmi].id);
      if (spmtSweepResult.error) console.warn('[Stackd] migratePOToSupabase: failed to push retrofit poId update for supplier payment ' + DB.supPayments[spmi].id, spmtSweepResult.error.message);
    }
    await refreshSupPmtFromSupabase();
  }
```

`migratePOToSupabase()` is already `async` — no signature change needed.

### 2.12 `pullAll()`'s Sheets-sync exclusion for `'payments'` only (REQ-CLOUD-008h)

`index.html:4547-4551`, current:

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'qt'; });
```

New — one line added, immediately alongside the existing `qt` filter:

```js
  var _simpleEntsForBatch = ['sup', 'li', 'payments', 'sh', 'qt', 'co'];
  if (_sb) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'sup'; });
  if (_sb && localStorage.getItem('st_li_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'li'; });
  if (_sb && localStorage.getItem('st_con_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'co'; });
  if (_sb && localStorage.getItem('st_qt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'qt'; });
  if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) _simpleEntsForBatch = _simpleEntsForBatch.filter(function(e){ return e !== 'payments'; });
```

`index.html:4647-4659`, current:

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

New — one line added, immediately alongside the existing `qt` filter (this one is the load-bearing filter, per REQ-CLOUD-008h/§0):

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
  // Buyer Payment (REQ-CLOUD-008h): same race — this is the load-bearing filter of the
  // two (the merge loop below iterates ONLY over simpleEnts; the _simpleEntsForBatch
  // filter above merely avoids a wasted server round-trip on the happy path).
  if (_sb && localStorage.getItem('st_pmt_cloud_migration_ts')) simpleEnts = simpleEnts.filter(function(e){ return e !== 'payments'; });
  var idKeyedEnts = ['sup', 'payments', 'co'];
```

**No `pullAll()` change of any kind for Supplier Payment** — confirmed, §1.7, `'supPayments'`/`'spm'` has zero Sheets footprint and appears in no `pullAll()`-related array before or after this SPEC (AC-8).

### 2.13 Archive/rollback extensions

Insert two new sibling restore functions immediately after `restoreInvMigrationArchive()` closes (`index.html:6869`), before `cleanupExpiredMigrationArchive()` (`index.html:6871`):

```js
function restorePmtMigrationArchive() {
  var arch = localStorage.getItem('st_pmt_pre_migration');
  if (!arch) { toast('No Payment migration archive available to restore.'); return; }
  if (!confirm('Restore Payments to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, Quotes, Purchase Orders, Invoices/Credit Notes, or Supplier Payments, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Payments — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.pm, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_pmt_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}

function restoreSupPmtMigrationArchive() {
  var arch = localStorage.getItem('st_spm_pre_migration');
  if (!arch) { toast('No Supplier Payment migration archive available to restore.'); return; }
  if (!confirm('Restore Supplier Payments to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, Quotes, Purchase Orders, Invoices/Credit Notes, or Payments, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Supplier Payments — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.spm, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_spm_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

`cleanupExpiredMigrationArchive()` (`index.html:6871-6908`) — two new blocks added immediately after the existing `invTs` block (`6903-6907`), before the closing brace:

```js
  var invTs = localStorage.getItem('st_inv_cloud_migration_ts');
  if (invTs && (Date.now() - new Date(invTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_inv_pre_migration');
    localStorage.removeItem('st_inv_cloud_migration_ts');
  }
  var pmtTs = localStorage.getItem('st_pmt_cloud_migration_ts');
  if (pmtTs && (Date.now() - new Date(pmtTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_pmt_pre_migration');
    localStorage.removeItem('st_pmt_cloud_migration_ts');
  }
  var spmTs = localStorage.getItem('st_spm_cloud_migration_ts');
  if (spmTs && (Date.now() - new Date(spmTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_spm_pre_migration');
    localStorage.removeItem('st_spm_cloud_migration_ts');
  }
}
```

`rCfg()` (`index.html:11495-11514`) — two new lines added immediately after the existing `cfg-sb-inv-restore-btn` line (`11513`), before the `cfg-lang` line (`11514`):

```js
  if(G('cfg-sb-inv-restore-btn')) G('cfg-sb-inv-restore-btn').style.display = localStorage.getItem('st_inv_cloud_migration_ts') ? '' : 'none';
  if(G('cfg-sb-pmt-restore-btn')) G('cfg-sb-pmt-restore-btn').style.display = localStorage.getItem('st_pmt_cloud_migration_ts') ? '' : 'none';
  if(G('cfg-sb-spm-restore-btn')) G('cfg-sb-spm-restore-btn').style.display = localStorage.getItem('st_spm_cloud_migration_ts') ? '' : 'none';
  if(G('cfg-lang')) G('cfg-lang').value = _lang;
```

### 2.14 Settings → Cloud Data UI (REQ-CLOUD-008j — no dedicated AC, matches prior precedent)

Two new cards inserted immediately after the existing "Cloud Data (Invoices & Credit Notes)" card closes (`index.html:830`) and before "Accounting Export — Field Mapping Reference" (`index.html:831`):

```html
    <div class="card">
      <div class="ct">Cloud Data (Buyer Payments)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-g" onclick="migratePmtToSupabase()">Migrate Payments to Cloud</button>
        <button class="btn btn-g" id="cfg-sb-pmt-restore-btn" style="display:none;" onclick="restorePmtMigrationArchive()">Restore Pre-Migration Payments</button>
      </div>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Invoices to already be migrated to Cloud Data above — every Buyer Payment requires an Invoice link. Uses the same Supabase connection configured above.</p>
    </div>
    <div class="card">
      <div class="ct">Cloud Data (Supplier Payments)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-g" onclick="migrateSupPmtToSupabase()">Migrate Supplier Payments to Cloud</button>
        <button class="btn btn-g" id="cfg-sb-spm-restore-btn" style="display:none;" onclick="restoreSupPmtMigrationArchive()">Restore Pre-Migration Supplier Payments</button>
      </div>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Purchase Orders to already be migrated to Cloud Data above — every Supplier Payment requires a Purchase Order link. Uses the same Supabase connection configured above.</p>
    </div>
```

---

## 3. Testing approach

Closer in shape to `REQ-CLOUD-002`'s own two-independent-entities-one-migration-file test coverage than to `REQ-CLOUD-005`'s/`006`'s own multi-sweep, multi-retrofit shape (REQ §5) — except for §2.11's retrofit, which is genuinely new territory for this pair. `mockSb()` (`tests/run.js:7309-7354`, already fully generic per-table) needs no changes for either new table. AC-1 (the SQL migration's own column list) has no dedicated automated test, matching this series' unbroken precedent — no test file reads `supabase/migrations/*.sql` directly; it is verified by direct comparison against §1's table at spec-gate/build-gate time.

New tests, added to `tests/run.js` immediately after the existing `// ── CLOUD DATA — Invoice and Credit Note (SPEC-CLOUD-006) ──` block (after its own test-hygiene cleanup test), under a new `// ── CLOUD DATA — Buyer Payment and Supplier Payment (SPEC-CLOUD-008) ──` heading:

### 3.1 AC-7 — retrofit the four pre-existing `initCloudDataLayer()` tests

Each of the four tests below gets two new stub lines (and two new restore lines), inserted immediately after its existing `ctx.refreshInvFromSupabase = function(){ ... };` stub line, mirroring the exact pattern each already uses for Ord/Qte/PO/Inv:

**`tests/run.js:8089`** (Order Request test) — after line `8115` (`ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };`):

```js
  // SPEC-CLOUD-008: initCloudDataLayer() now also calls refreshPmtFromSupabase() and
  // refreshSupPmtFromSupabase() after refreshInvFromSupabase() — stub both, or the real
  // functions run unmocked against DB.payments/DB.supPayments (empty at this point) and
  // permanently set st_pmt_cloud_migration_ts/st_spm_cloud_migration_ts, corrupting
  // every later test that touches either payment ledger.
  var origRefreshPmt = ctx.refreshPmtFromSupabase;
  ctx.refreshPmtFromSupabase = function(){ return Promise.resolve(); };
  var origRefreshSupPmt = ctx.refreshSupPmtFromSupabase;
  ctx.refreshSupPmtFromSupabase = function(){ return Promise.resolve(); };
```

and its cleanup line (`8118`) gains `ctx.refreshPmtFromSupabase = origRefreshPmt; ctx.refreshSupPmtFromSupabase = origRefreshSupPmt;`.

**`tests/run.js:8653`** (Quote test) — identical two-stub block inserted after its own `ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };` line (`8674`), identical cleanup-line addition.

**`tests/run.js:9060`** (Purchase Order test) — identical two-stub block inserted after its own `ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };` line (`9074`), identical cleanup-line addition.

**`tests/run.js:9566`** (Invoice test — the function under test is `refreshInvFromSupabase()` itself) — identical two-stub block inserted after its own `ctx.refreshInvFromSupabase = function(){ called = true; return Promise.resolve(); };` line (`9575`), identical cleanup-line addition.

Plus one new test verifying the wiring itself:

```js
testAsync('initCloudDataLayer — now also calls refreshPmtFromSupabase() and refreshSupPmtFromSupabase() after refreshInvFromSupabase() (AC-7)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] }, buyer_payments: { selectData: [] }, supplier_payments: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var pmtCalled = false, supPmtCalled = false;
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  var origRefreshPmt = ctx.refreshPmtFromSupabase;
  ctx.refreshPmtFromSupabase = function(){ pmtCalled = true; return Promise.resolve(); };
  var origRefreshSupPmt = ctx.refreshSupPmtFromSupabase;
  ctx.refreshSupPmtFromSupabase = function(){ supPmtCalled = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(pmtCalled, 'initCloudDataLayer() calls refreshPmtFromSupabase()');
  assert(supPmtCalled, 'initCloudDataLayer() calls refreshSupPmtFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshInvFromSupabase = origRefreshInv; ctx.refreshPmtFromSupabase = origRefreshPmt; ctx.refreshSupPmtFromSupabase = origRefreshSupPmt;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});
```

### 3.2 AC-2 — migration preconditions

```js
testAsync('migratePmtToSupabase — blocked unless Invoice has completed its own migration; PO alone does not satisfy it (AC-2)', async function() {
  resetDB();
  ctx._sb = mockSb({ invoices: { selectData: [] } });
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString()); // PO migrated, Invoice not
  var insertCall1;
  await ctx.migratePmtToSupabase();
  insertCall1 = ctx._sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; });
  assert(!insertCall1, 'blocked — Invoice has not migrated');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migratePmtToSupabase();
  assertEqual(ctx._sb._calls.filter(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; }).length, 0, 'no local payments to insert, but no longer blocked by the precondition');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migrateSupPmtToSupabase — blocked unless Purchase Order has completed its own migration; Invoice alone does not satisfy it (AC-2)', async function() {
  resetDB();
  ctx._sb = mockSb({ purchase_orders: { selectData: [] } });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString()); // Invoice migrated, PO not
  await ctx.migrateSupPmtToSupabase();
  assert(!ctx._sb._calls.find(function(c){ return c.table === 'supplier_payments' && c.op === 'insert'; }), 'blocked — Purchase Order has not migrated');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});
```

### 3.3 AC-3 — orphan scan, three cases per ledger, non-blocking

```js
testAsync('migratePmtToSupabase — orphan scan: blank/dangling invId with a resolving invNum is NOT counted as orphaned (AC-3)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-real', num: 'INV90001', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm1', invId: 'ghost-id', invNum: 'INV90001', amount: 100, date: '2026-01-01' });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'new-pm-1' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  var origToast = ctx.toast; var toastMsgs = [];
  ctx.toast = function(m){ toastMsgs.push(m); };
  await ctx.migratePmtToSupabase();
  assert(!toastMsgs.some(function(m){ return /reference an invoice that could not be resolved/.test(m); }), 'not counted as orphaned — invNum resolves');
  assert(sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; }), 'migration proceeded, not blocked');
  ctx.toast = origToast; ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migratePmtToSupabase — orphan scan: resolving invId with a stale/mismatched invNum is NOT counted as orphaned (AC-3)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-real2', num: 'INV90002', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm2', invId: 'inv-real2', invNum: 'GHOST-NUM', amount: 100, date: '2026-01-01' });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({ buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'new-pm-2' }, row); } } });
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  var origToast = ctx.toast; var toastMsgs = [];
  ctx.toast = function(m){ toastMsgs.push(m); };
  await ctx.migratePmtToSupabase();
  assert(!toastMsgs.some(function(m){ return /reference an invoice that could not be resolved/.test(m); }), 'not counted as orphaned — invId resolves regardless of invNum');
  ctx.toast = origToast; ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migratePmtToSupabase — orphan scan: neither invId nor invNum resolves — counted, surfaced via toast, still NOT blocking (AC-3)', async function() {
  resetDB();
  ctx.DB.payments.push({ id: 'pm3', invId: 'ghost-id', invNum: 'GHOST-NUM', amount: 100, date: '2026-01-01' });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({ buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'new-pm-3' }, row); } } });
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  var origToast = ctx.toast; var toastMsgs = [];
  ctx.toast = function(m){ toastMsgs.push(m); };
  await ctx.migratePmtToSupabase();
  assert(toastMsgs.some(function(m){ return /1 payment record\(s\) reference an invoice that could not be resolved/.test(m); }), 'genuinely orphaned record surfaced via toast');
  assert(ctx._sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; }), 'migration still proceeded — non-blocking');
  ctx.toast = origToast; ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migrateSupPmtToSupabase — orphan scan: resolving poId is NOT counted; a dangling poId IS counted and surfaced, still non-blocking (AC-3)', async function() {
  resetDB();
  ctx.DB.supPayments.push({ id: 'spm1', poId: 'real-po', poNum: 'PO-0001', amount: 50, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  ctx.DB.supPayments.push({ id: 'spm2', poId: 'ghost-po', poNum: 'PO-9999', amount: 50, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({
    purchase_orders: { selectData: [{ id: 'real-po', num: 'PO-0001' }] },
    supplier_payments: { insertImpl: function(row){ return Object.assign({ id: 'new-spm-' + Math.random() }, row); } }
  });
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  var origToast = ctx.toast; var toastMsgs = [];
  ctx.toast = function(m){ toastMsgs.push(m); };
  await ctx.migrateSupPmtToSupabase();
  assert(toastMsgs.some(function(m){ return /1 supplier payment record\(s\) reference a Purchase Order that could not be resolved/.test(m); }), 'exactly one orphan counted — poNum fallback never applies (bare poId match)');
  assertEqual(ctx._sb._calls.filter(function(c){ return c.table === 'supplier_payments' && c.op === 'insert'; }).length, 2, 'both records still inserted — non-blocking');
  ctx.toast = origToast; ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});
```

### 3.4 AC-4/AC-5 — create-or-update and soft-delete for both ledgers

```js
test('savePayment() — local-only behavior unchanged when Buyer Payment has not migrated (AC-4)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-sv1', num: 'INV91001', status: 'Draft', lineItems: [], calc_grandTotal: '100' });
  ctx.savePayment({ id: 'pm-sv1', invId: 'inv-sv1', invNum: 'INV91001', amount: 100, date: '2026-01-01', method: 'Bank Transfer' });
  assertEqual(ctx.DB.payments.find(function(p){ return p.id === 'pm-sv1'; }).amount, 100, 'saved locally, no Supabase involvement');
});

testAsync('savePayment() — Cloud-configured create inserts with no client-generated id, resolves the real Supabase id onto the local record; a subsequent edit calls .update().eq(\'id\',...) (AC-4)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-sv2', num: 'INV91002', status: 'Draft', lineItems: [], calc_grandTotal: '100' });
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'real-pmt-uuid' }, row); }, updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });
  ctx._sb = sb;
  await ctx.savePayment({ id: 'local-uid-1', invId: 'inv-sv2', invNum: 'INV91002', amount: 40, date: '2026-01-01', method: 'Bank Transfer' });
  var insertCall = sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; });
  assert(insertCall, 'insert called on create');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent');
  assertEqual(ctx.DB.payments[0].id, 'real-pmt-uuid', 'real Supabase id resolved onto the local record');

  await ctx.savePayment({ id: 'real-pmt-uuid', invId: 'inv-sv2', invNum: 'INV91002', amount: 60, date: '2026-01-02', method: 'Wire Transfer' });
  var updateCall = sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'update'; });
  assert(updateCall, 'update called on a subsequent edit of the same record');
  ctx._sb = null;
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
});

testAsync('deletePayment() — Cloud-configured delete soft-deletes via update({deleted_at}), not a hard delete (AC-5)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-del1', num: 'INV91003', status: 'Sent', lineItems: [], calc_grandTotal: '100' });
  ctx.DB.payments.push({ id: 'pm-del1', invId: 'inv-del1', invNum: 'INV91003', amount: 50, date: '2026-01-01' });
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({});
  ctx._sb = sb;
  ctx.confirm = function(){ return true; };
  await ctx.deletePayment('pm-del1');
  var delCall = sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'update'; });
  assert(delCall, 'soft-delete update called');
  assert(delCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  ctx._sb = null; ctx.confirm = function(){ return false; };
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
});

testAsync('saveSupPayment() — Cloud-configured create/update mirrors savePayment()\'s shape; local-only unchanged when not migrated (AC-4)', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-sv1', num: 'PO-9001', supId: 's1', cur: 'USD', status: 'Confirmed', dep: 0, lineItems: [] });
  var sb = mockSb({ supplier_payments: { insertImpl: function(row){ return Object.assign({ id: 'real-spm-uuid' }, row); }, updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });

  await ctx.saveSupPayment({ id: 'local-uid-2', poId: 'po-sv1', poNum: 'PO-9001', amount: 100, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  assert(!sb._calls.length, 'not yet configured for _sb in this call — resetDB() leaves _sb unset, so this is local-only');
  assertEqual(ctx.DB.supPayments[0].id, 'local-uid-2', 'local id preserved when not Cloud-configured');

  ctx.localStorage.setItem('st_spm_cloud_migration_ts', new Date().toISOString());
  ctx._sb = sb;
  await ctx.saveSupPayment({ id: 'local-uid-3', poId: 'po-sv1', poNum: 'PO-9001', amount: 200, currency: 'USD', purpose: 'Deposit', date: '2026-01-02' });
  var insertCall = sb._calls.find(function(c){ return c.table === 'supplier_payments' && c.op === 'insert'; });
  assert(insertCall, 'insert called on create once Cloud-configured');
  assertEqual(ctx.DB.supPayments[1].id, 'real-spm-uuid', 'real Supabase id resolved onto the local record');
  ctx._sb = null;
  ctx.localStorage.removeItem('st_spm_cloud_migration_ts');
});

testAsync('deleteSupPayment() — Cloud-configured delete soft-deletes via update({deleted_at}) (AC-5)', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-del1', num: 'PO-9002', supId: 's1', cur: 'USD', status: 'Confirmed', dep: 0, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'spm-del1', poId: 'po-del1', poNum: 'PO-9002', amount: 30, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  ctx.localStorage.setItem('st_spm_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({});
  ctx._sb = sb;
  ctx.confirm = function(){ return true; };
  await ctx.deleteSupPayment('spm-del1');
  var delCall = sb._calls.find(function(c){ return c.table === 'supplier_payments' && c.op === 'update'; });
  assert(delCall, 'soft-delete update called');
  assert(delCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  ctx._sb = null; ctx.confirm = function(){ return false; };
  ctx.localStorage.removeItem('st_spm_cloud_migration_ts');
});
```

### 3.5 AC-6 — goodwill-credit pushes, both call sites, including first-goodwill-credit case

**Rewritten, spec-gate round 1 (B2 — real, appliable tests, not elided pseudocode).** Built against `setupCNForm()`/`setupCNFormNew()`, the file's own established goodwill-credit fixture conventions (`tests/run.js:2939-2960`, `3130-3163`), not against a non-existent `if-buyer` field id (the round-1 draft's own placeholder, `mockEl('if-buyer')`, referenced a field that does not exist — the real Invoice-buyer field is `if-b`, `index.html:1134`). Each test stubs `refreshInvFromSupabase()`, matching the file's own established convention for this exact situation (`tests/run.js:9885-9886`) — `saveInv()`'s pre-existing (unrelated) Invoice-row cloud branch calls it near the end, and without a stub it wipes `DB.inv` back to `[]` against the unconfigured mock, destroying the very CN record the test asserts on.

```js
testAsync('saveInv() goodwill-credit push — Cloud-configured: no prior row exists, inserts the fresh replacement and assigns a real Supabase id (AC-6)', async function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN94001', '', 300, true);
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    invoices: { insertImpl: function(row){ return Object.assign({ id: 'gw-inv-1' }, row); } },
    buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'gw-pmt-1' }, row); } }
  });
  ctx._sb = sb;
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.saveInv();
  var insCall = sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; });
  assert(insCall, 'fresh replacement row inserted even with no prior matching row');
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN94001'; });
  assert(cn, 'CN record saved with a real Supabase invoice id');
  assert(ctx.DB.payments.some(function(p){ return p.id === 'gw-pmt-1' && p.invId === cn.id && p.method === 'Goodwill Credit'; }), 'local payment record carries the real Supabase id and references the CN\'s own real id');
  ctx._sb = null;
  ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
});

testAsync('saveInv() goodwill-credit push — Cloud-configured: a prior matching row IS soft-deleted before the fresh replacement is inserted (AC-6)', async function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN94002', '', 100, true);
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  var sb1 = mockSb({ invoices: { insertImpl: function(row){ return Object.assign({ id: 'gw-inv-2' }, row); } }, buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'gw-pmt-2a' }, row); } } });
  ctx._sb = sb1;
  await ctx.saveInv(); // first goodwill credit, creates the row
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN94002', '', 250, true); // edit the amount, re-save (same CN num → same record)
  ctx.EI.i = ctx.DB.inv.find(function(i){ return i.num === 'CN94002'; }).id;
  var sb2 = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); } }, buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'gw-pmt-2b' }, row); } } });
  ctx._sb = sb2;
  await ctx.saveInv();
  var delCall = sb2._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'update' && c.row && c.row.deleted_at; });
  assert(delCall, 'prior matching row soft-deleted on the second goodwill-credit save');
  var eqInvId = sb2._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'eq' && c.col === 'inv_id'; });
  var eqMethod = sb2._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'eq' && c.col === 'method' && c.val === 'Goodwill Credit'; });
  assert(eqInvId && eqMethod, 'delete predicate matches saveInv()\'s own local filter: inv_id AND method=Goodwill Credit');
  var insCall = sb2._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'insert'; });
  assert(insCall, 'fresh replacement row inserted');
  ctx._sb = null;
  ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
});

testAsync('saveCN() goodwill-credit push — Cloud-configured: matched on inv_id ONLY (no method filter), soft-deletes ALL prior entries for this CN id (AC-6)', async function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN94101', '', 400, true);
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  var cnSb = mockSb({
    invoices: { insertImpl: function(row){ return Object.assign({ id: 'gw-cn-1' }, row); } },
    buyer_payments: { insertImpl: function(row){ return Object.assign({ id: 'gw-cn-pmt-1' }, row); } }
  });
  ctx._sb = cnSb;
  await ctx.saveCN();
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN94101'; });
  assert(cn, 'goodwill CN record saved with a real Supabase invoice id');
  var delCall = cnSb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'eq' && c.col === 'inv_id'; });
  assert(delCall, 'delete predicate keyed on inv_id only');
  var eqMethodCalls = cnSb._calls.filter(function(c){ return c.table === 'buyer_payments' && c.op === 'eq' && c.col === 'method'; });
  assertEqual(eqMethodCalls.length, 0, 'no method filter on the CN goodwill-credit delete predicate — unlike saveInv()\'s own');
  assert(ctx.DB.payments.some(function(p){ return p.id === 'gw-cn-pmt-1' && p.invId === cn.id; }), 'local record carries the real Supabase id and references the CN\'s own real id');
  ctx._sb = null;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
});
```

### 3.6 AC-8 — `pullAll()` filters and the Supplier Payment absence confirmation

**Fixed, spec-gate round 1 (B1 — `ctx.sPost` was permanently clobbered, never restored, corrupting a later, unrelated test).** Cleanup now restores the original `ctx.sPost`.

```js
testAsync('pullAll() — drops \'payments\' from the batched request and the merge loop once st_pmt_cloud_migration_ts is set (AC-8)', async function() {
  resetDB();
  ctx.SS.url = 'https://sheets.example';
  ctx._sb = mockSb({});
  var _fetchCallLog = [];
  var origSPost = ctx.sPost; // restore below — or every later test relying on the real sPost()/_mockPullResponses mechanism (e.g. the Contact pullAll() falsy-id test) silently breaks for the rest of the run.
  ctx.sPost = function(payload){ _fetchCallLog.push(payload); return Promise.resolve({ status: 'ok', results: {} }); };
  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('payments') >= 0, 'payments still requested — its own migration marker is not set yet');

  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('payments'), -1, 'payments excluded from the batched request once its own migration marker is set');

  ctx.localStorage.removeItem('st_pmt_cloud_migration_ts');
  ctx.SS.url = ''; ctx._sb = null; ctx.sPost = origSPost;
});

test('AC-8 — \'supPayments\'/\'spm\' never appears in any pullAll()-related array, before or after this SPEC', function() {
  var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  var pullAllSrc = src.slice(src.indexOf('async function pullAll()'), src.indexOf('async function pullAll()') + 6000);
  assert(pullAllSrc.indexOf("'supPayments'") === -1, 'supPayments never referenced inside pullAll()');
  assert(pullAllSrc.indexOf("'spm'") === -1, 'spm never referenced inside pullAll()');
});
```

### 3.7 AC-9 — retrofit sweep pushes, both directions, both sweeps

**Completed, spec-gate round 1 (B2 — the PO/supPayments-side pair was left as a comment, not real tests; written out in full below.)**

```js
testAsync('migrateInvToSupabase() retrofit — pushes a touched DB.payments[].invId sweep update when Buyer Payment has ALSO already migrated (AC-9)', async function() {
  resetDB();
  ctx.DB.buy.push({ id: 'b1', name: 'Buyer' });
  ctx.DB.inv.push({ id: 'inv-old', num: 'INV92001', status: 'Draft', lineItems: [], buyerId: 'b1' });
  ctx.DB.payments.push({ id: 'real-pmt-x', invId: 'inv-old', invNum: 'INV92001', amount: 10, date: '2026-01-01' });
  ctx.localStorage.setItem('st_pmt_cloud_migration_ts', new Date().toISOString()); // Buyer Payment ALREADY migrated
  // (rest of migrateInvToSupabase()'s own standard fixture: Buyer/LineItem/Quote/PO already migrated, etc.)
  var sb = mockSb({
    buyers: { selectData: [{ id: 'b1' }] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ return Object.assign({ id: 'new-inv-id' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateInvToSupabase();
  var pmtSweepCall = sb._calls.find(function(c){ return c.table === 'buyer_payments' && c.op === 'update' && c.row.inv_id === 'new-inv-id'; });
  assert(pmtSweepCall, 'touched payment record pushed to Supabase via the retrofit — Buyer Payment had already migrated');
  ctx.showBlockingBackupModal = origShowBackup; ctx._sb = null;
  ['st_li_cloud_migration_ts','st_qt_cloud_migration_ts','st_po_cloud_migration_ts','st_inv_cloud_migration_ts','st_pmt_cloud_migration_ts'].forEach(function(k){ ctx.localStorage.removeItem(k); });
});

testAsync('migrateInvToSupabase() retrofit — does NOT push when Buyer Payment has not itself migrated (local-only fix instead, matching the ordinary case)', async function() {
  resetDB();
  ctx.DB.buy.push({ id: 'b1', name: 'Buyer' });
  ctx.DB.inv.push({ id: 'inv-old2', num: 'INV92002', status: 'Draft', lineItems: [], buyerId: 'b1' });
  ctx.DB.payments.push({ id: 'local-pmt-y', invId: 'inv-old2', invNum: 'INV92002', amount: 10, date: '2026-01-01' });
  var sb = mockSb({
    buyers: { selectData: [{ id: 'b1' }] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ return Object.assign({ id: 'new-inv-id-2' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateInvToSupabase();
  assert(!sb._calls.find(function(c){ return c.table === 'buyer_payments'; }), 'no push attempted — Buyer Payment has not migrated (the ordinary case)');
  assertEqual(ctx.DB.payments[0].invId, 'new-inv-id-2', 'local fix still applied');
  ctx.showBlockingBackupModal = origShowBackup; ctx._sb = null;
  ['st_li_cloud_migration_ts','st_qt_cloud_migration_ts','st_po_cloud_migration_ts','st_inv_cloud_migration_ts'].forEach(function(k){ ctx.localStorage.removeItem(k); });
});

testAsync('migratePOToSupabase() retrofit — pushes a touched DB.supPayments[].poId sweep update when Supplier Payment has ALSO already migrated (AC-9)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', name: 'Supplier' });
  ctx.DB.po.push({ id: 'po-old', num: 'PO-93001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'real-spm-x', poId: 'po-old', poNum: 'PO-93001', amount: 10, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  ctx.localStorage.setItem('st_spm_cloud_migration_ts', new Date().toISOString()); // Supplier Payment ALREADY migrated
  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-id' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migratePOToSupabase();
  var spmSweepCall = sb._calls.find(function(c){ return c.table === 'supplier_payments' && c.op === 'update' && c.row.po_id === 'new-po-id'; });
  assert(spmSweepCall, 'touched supplier payment record pushed to Supabase via the retrofit — Supplier Payment had already migrated');
  ctx.showBlockingBackupModal = origShowBackup; ctx._sb = null;
  ['st_po_cloud_migration_ts','st_spm_cloud_migration_ts'].forEach(function(k){ ctx.localStorage.removeItem(k); });
});

testAsync('migratePOToSupabase() retrofit — does NOT push when Supplier Payment has not itself migrated (local-only fix instead, matching the ordinary case)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', name: 'Supplier' });
  ctx.DB.po.push({ id: 'po-old2', num: 'PO-93002', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'local-spm-y', poId: 'po-old2', poNum: 'PO-93002', amount: 10, currency: 'USD', purpose: 'Deposit', date: '2026-01-01' });
  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-id-2' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migratePOToSupabase();
  assert(!sb._calls.find(function(c){ return c.table === 'supplier_payments'; }), 'no push attempted — Supplier Payment has not migrated (the ordinary case)');
  assertEqual(ctx.DB.supPayments[0].poId, 'new-po-id-2', 'local fix still applied');
  ctx.showBlockingBackupModal = origShowBackup; ctx._sb = null;
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});
```

### 3.8 AC-10

No new tests — the audit in §2.9/§2.10 above is the deliverable; it confirms every existing direct call site is safe against the `async` conversion without modification.

### 3.9 Expected final test count

**Corrected, spec-gate round 1 (A1 — the original arithmetic didn't sum to its own stated total).** 869 (baseline) + 22 new tests (1 wiring test + 2 precondition tests + 4 orphan-scan tests + 5 create/update/delete tests + 3 goodwill-push tests + 1 pullAll marker test + 1 static-source AC-8 confirmation + 4 retrofit tests, both sweeps × both branches, all now written out in full, §3.7 + 1 test-hygiene cleanup test) = **891/891**, independently confirmed by spec-gate applying every diff/test above against the real suite.

---

## 4. Explicitly out of scope for this SPEC (REQ-CLOUD-008l/m)

Per REQ-CLOUD-008l/m: this SPEC and its implementation **do not** touch `docs/architecture-data-model-v1.md`, `STACKD_CONTEXT.md`, or any other broader documentation file. That work is `stkdcfpm/stackd-ops#133` (not yet merged as of this SPEC's drafting) — a separate, already-completed fix for the whole class of pre-existing Cloud Data documentation staleness this and `REQ-CLOUD-007`'s own reviews kept re-discovering. This REQ's own remaining doc obligation, per REQ-CLOUD-008m (superseded/narrowed), is a small "in progress" → "done" flip in `docs/architecture-data-model-v1.md` §2/§8 at ship time, confirming `#133` is still merged first — not part of this SPEC's own diff, and not part of the implementation this SPEC specifies. `docs/requirements-tracker.md`, `docs/known-gaps.md`, `docs/version-history.md`, `STACKD_CONTEXT.md`, and `CLAUDE.md` updates listed in REQ-CLOUD-008 §7 are ship-time tracker bookkeeping, likewise outside this SPEC's `index.html`/SQL/`tests/run.js` diff scope.

---

## 5. Gate process

Follows the same SDLC pipeline as every prior REQ/SPEC in this series: REQ → requirements-gate (complete, PASS, 2 rounds) → **this SPEC** → independent spec-gate review (applies every diff above to a scratch copy, runs the real test suite, confirms the ≈899/899 figure in §3.9 exactly) → implementation → self-directed mutation testing → independent build-gate review → PR → CI green → merge.
