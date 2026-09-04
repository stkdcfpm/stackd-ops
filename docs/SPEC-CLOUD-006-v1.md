# SPEC-CLOUD-006 — Invoice and Credit Note Cloud Data migration

**Status:** v1 — **complete**, drafted against `docs/REQ-CLOUD-006-v1.md` (requirements-gate PASS, 8 rounds — see that document's own §8 for the full log, including its own citation-accuracy saga). This document was drafted in two passes across two sessions (the first cut off by an infrastructure rate-limit error partway through §2.5, not a content problem); the second pass continued from §2.6 through §4 without revisiting or contradicting anything §0-§2.5 had already established. Every citation below was re-verified directly against `/tmp/cloud-006-wt/index.html`/`tests/run.js`/the named `docs/*.md` files at commit `124dc23` (this worktree, this branch) — none had drifted from the REQ's own (already twice-independently-re-verified) citations; see the drafting agent's final report for the specific citations spot-checked and any drift found. **Spec-gate round 1: CONDITIONAL PASS/FAIL — 3 blocking, fixed in place.** The reviewer actually applied every diff in stages and ran the real suite: baseline 803/803 → 800/803 after §2's code diffs alone (3 pre-existing tests broke exactly as §0.1 predicted, resolved once §3.0's 3 required retrofits were applied, back to 803/803) → 832/835 after adding §3.1's ~30 new tests, 3 failures. One was a real implementation bug: `saveCN()`'s cloud-aware branch (§2.7) set `cn.id` from the Supabase insert/update but never committed `cn` into `DB.inv` at all (only the local/non-cloud branch did) — a cloud-saved CN was invisible to its own balance-due self-reference and to `rInv()` until an unrelated refresh happened to run; fixed by relocating the `DB.inv[idx]=cn`/`DB.inv.push(cn)` commit to run unconditionally after the cloud branch, mirroring `saveInv()`'s own already-correct pattern. The other two were test-authoring bugs, not implementation bugs: the `saveInv()` AC-5 test left `cIL` empty, so `vInv()`'s own pre-existing empty-line-item guard blocked the save before it ever reached the Cloud Data branch under test — fixed by giving it a real line item, matching every other creation-path test's convention; the `autoPos()` call-site-#3 test set only Invoice's own migration marker, but `autoPos()`'s PO-creation branch (shipped by `REQ-CLOUD-005`, unmodified here) is gated on PO's own separate marker — fixed by setting both. With all three fixes applied: **835/835 PASS**, confirmed by the reviewer directly. Everything else — the 4th-bug-class hunt (none found), the `cnLinkedIdMap` ordering trap (confirmed correct), all async-conversion claims, all 13 call sites, every doc diff, the SQL migration's column coverage, and ~20 further citation spot-checks — verified clean. Ready for a confirmatory round 2, then implementation.

---

## 0. Design decisions carried over from the REQ (not re-litigated here)

- **Four-entity precondition** (REQ-CLOUD-006a): `migrateInvToSupabase()` refuses to run unless Buyer, Line Item, Quote, and Purchase Order have all completed their own migrations, each verified live against the connected project — the most demanding precondition in this series.
- **Two-pass self-referential remap, `linkedInvNum`-first** (REQ-CLOUD-006b): pass 1 inserts every `DB.inv` record (Invoice and CN alike) with `linked_inv_id` deferred to `null`; pass 2 resolves each CN's linked invoice against the pre-remap `DB.inv` array, `linkedInvNum`-first with `linkedInvId`-fallback, then sets `linked_inv_id` both in Supabase and locally. A dangling reference is left `null` and logged, not treated as blocking.
- **Duplicate-`num` scan across the whole `DB.inv` array** (REQ-CLOUD-006c), Invoice and CN together.
- **`saveInv()`/`saveCN()` get their own dedicated create-or-update branches, not `persistInvChange()`** (REQ-CLOUD-006d) — mirrors `saveLI()`/`saveCon()`'s shape, since only these two functions handle the create path.
- **New shared `persistInvChange(inv, skipRefresh)`, 13 call sites** (REQ-CLOUD-006e) — the most of any entity in this series.
- **Outward retrofit into Purchase Order**, `invNum`-first/`invId`-fallback, identical to `backfillInvoicePOs()`'s own precedence (REQ-CLOUD-006f).
- **Local-only inward sweep of `DB.payments[].invId`**, same `invNum`-first precedence, no Supabase push (REQ-CLOUD-006g — Buyer Payment isn't Cloud-eligible yet).
- **`pullAll()` exclusion, both the `_allPullKeys` filter and the per-block guards, for both Invoice and Credit Note blocks, gated on one shared `st_inv_cloud_migration_ts` marker** (REQ-CLOUD-006i).
- **New `refreshInvFromSupabase()` wired into `initCloudDataLayer()`, and a Settings → Cloud Data card** (REQ-CLOUD-006j/006k).
- **CSV import (`processImport()`/`processImportRecords()`'s `'inv'` branches) stays local-only, unchanged** (REQ-CLOUD-006l) — logged under a broadened `CLOUD-GAP-003` at ship time, not built here.
- **Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only** — the same 9-step mechanics every prior Cloud Data migration in this series has used.
- **`FIELD_MAPS.inv`/`FIELD_MAPS.cn` need no changes** — confirmed in §2.12 below; this REQ's whole finding series was about NOT relying on FIELD_MAPS completeness for Cloud Data correctness, not about adding to it.

The subsections below (§0.1–§0.5) are design decisions this SPEC itself must add — each flows directly from applying REQ-CLOUD-006's already-fixed requirements to the *current* code, but none is spelled out verbatim in the REQ text, so each is flagged explicitly for spec-gate to check with extra scrutiny.

## 0.1 `refreshInvFromSupabase()` wiring is the fourth instance of this series' own recurring test-contamination class — retrofit all three existing `initCloudDataLayer()` tests, not one

`persistInvChange()` needs a `refreshInvFromSupabase()` to call, wired into `initCloudDataLayer()` (`index.html:5584-5596`) as a seventh `await` line, after `refreshPOFromSupabase()`. This exact mistake has now been made and fixed three times in this series (`REQ-CLOUD-003`'s own round-1 B2, `SPEC-CLOUD-004`'s round-1 B1, `SPEC-CLOUD-005`'s round-1 B2, self-caught): a pre-existing `initCloudDataLayer()` test that predates the new refresh call stubs every refresh function that existed *when that test was written*, but not ones added afterward, so wiring a new refresh call in makes the *older* test run the new function unmocked against an empty `DB.inv`, permanently setting `st_inv_cloud_migration_ts` and corrupting every later test that touches Invoice/CN. There are now **three** such pre-existing tests to retrofit in this same change — `tests/run.js:7752` (Order Request's own, already carrying two prior retrofits), `tests/run.js:8310` (Quote's own, carrying one), and `tests/run.js:8712` (Purchase Order's own, carrying none yet) — plus a fourth, brand-new test for Invoice itself. §3.0 below retrofits all three explicitly, not by inference from one shown example.

## 0.2 The pre-flight duplicate-`num` scan needs its own fourth dedicated modal

Mirroring `REQ-CLOUD-005`'s own §0.2 precedent (a third parallel dedicated modal, `ov-po-dup`), this SPEC adds a fourth: `ov-inv-dup`/`inv-dup-list`, plus `findDuplicateInvNums()`/`showInvDupConflictModal()`, structurally identical to the Supplier/Quote/PO triple. Generalizing this by-now-four-times-duplicated pattern remains out of scope (per every prior REQ's own identical disposition) — never modifying any of the three existing modals or their functions.

## 0.3 Four functions need converting from sync to async that the REQ's own text never names as such

The REQ's §2e call-site list and §1.3 mutation table correctly identify *which* functions need a `persistInvChange()` call, but three of the thirteen sites live inside functions that are plain synchronous functions today, not `async` ones — `await persistInvChange(...)` inside a non-`async` function is a **literal syntax error**, exactly the class of defect that collapsed `SPEC-CLOUD-005`'s own round-1 spec-gate review to 17/771 passing tests (its own `savePayment()` async-conversion miss). This SPEC converts, explicitly:

- **`saveInvApprove()`** (`index.html:7220`, call site #1) — `function saveInvApprove() {` → `async function saveInvApprove() {`.
- **`saveInvProgress()`** (`index.html:7262`, call site #2) — same conversion.
- **`deletePayment()`** (`index.html:13095`, call site #5) — same conversion.
- **`advMergeBuyers()`** (`index.html:11769`, call site #6) — same conversion.

`autoPos()` (call site #3) and `savePayment()` (call site #4) are already `async` — both were converted by `SPEC-CLOUD-005` for their own Purchase Order pushes and need no further signature change here. `delPO()` (call site #7), `backfillInvoicePOs()` (call site #8, see §0.4), and all four sweep functions (call sites #10–13) are handled in their own subsections below. Every one of the four newly-`async` functions above is confirmed, by direct inspection of every call site (`§2.9`–`§2.14` below cite them individually), to be invoked only via a bare `onclick="..."` HTML attribute or a fire-and-forget statement with no caller ever reading its return value — matching `autoPos()`'s own already-accepted precedent, so none of these conversions requires an `await` to be added at any call site, and none breaks the "no test awaits this today" invariant `SPEC-CLOUD-005` §2.14 established for `savePayment()`.

## 0.4 `backfillInvoicePOs()` becomes `async` but stays fire-and-forget at all five call sites, mirroring `autoPos()`'s own accepted race

REQ-CLOUD-006e's call site #8 requires `backfillInvoicePOs()` to "push each *changed* invoice if migrated" — but this function is called from five places (`index.html:4644` inside `pullAll()`, `index.html:9333`/`9685` inside the PO branches of `processImport()`/`processImportRecords()`, `index.html:11400` inside `doImport()`'s full-JSON-restore path, and `index.html:13569` inside `initApp()`'s own boot sequence), only one of which (`pullAll()`) is itself already `async`. Async-ifying `initApp()` and `doImport()` themselves to `await` this call would be a large, invasive, high-risk change far outside this REQ's own stated scope, and is not what any prior entity in this series has done for a boot-path function. Instead, mirroring `SPEC-CLOUD-005`'s own explicitly-accepted precedent for `autoPos()` (§2.5 there, "Known race, accepted (spec-gate advisory A3)"): `backfillInvoicePOs()` becomes `async function backfillInvoicePOs()`, and all five call sites are left as bare, unawaited `backfillInvoicePOs();` statements, exactly as they read today. The synchronous portion (rebuilding `inv.pos[]`, deciding what changed) still runs to completion in the same tick it always has; only the trailing Cloud Data push (when Invoice has migrated) runs asynchronously after the caller has already moved on — a real but narrow window, no worse in kind than `autoPos()`'s own already-accepted one, and on a function whose own purpose is a self-healing backfill that corrects itself again on the next call regardless.

## 0.5 `delInv()` gains its own cloud-aware soft-delete branch — implied by the REQ's own §1.3 table, not a separately lettered requirement

REQ-CLOUD-006's §1.3 mutation-site table lists `delInv(id)` (`index.html:8230-8244`) as "delete ✓ own soft-delete branch" — but no lettered requirement in §2 (a–l) names `delInv()` explicitly; REQ-CLOUD-006d only calls out `saveInv()`/`saveCN()`'s *create-or-update* branches. This mirrors `REQ-CLOUD-005`'s own identical, unremarked precedent (`delPO()`'s basic soft-delete branch was never given its own lettered requirement either — only the `PO-GAP-007` fix folded into it was, under REQ-CLOUD-005f). Following that precedent, this SPEC adds `delInv()`'s cloud-aware soft-delete branch as a natural, implied part of "Invoice is now a migrated entity" — every migrated entity's own delete path gets one, matching `delSup()`/`delPO()`'s exact shape. Flagged here explicitly so spec-gate checks it is in fact covered by AC-13's "every mutation function this REQ touches" audit, since it has no AC of its own by name.

---

## 1. New SQL migration: `supabase/migrations/0006_invoices.sql`

Column list resolved against the union of every field `saveInv()` (`index.html:7007-7028`, plus its existing-record preservation block `7043-7060`) and `saveCN()` (`index.html:10006-10023`) build into an `inv`/`cn` object, **plus** three fields no `FIELD_MAPS.inv` entry or save-function literal shows but that a real historical `DB.inv` record can carry: `notes` (set only by `processImport()`/`processImportRecords()`'s CSV import branches, `index.html:9288`/`9627` — confirmed live, not a live UI field, since `saveInv()`'s own object literal never sets it), `editHistory` (set only by the G-06 unlock/edit-audit block, `index.html:7151-7153`), and the eight `calc_*` fields (persisted only when `cIL.length===0` preserves an existing record's calc snapshot, `index.html:7052-7059`, or via CSV import, `index.html:9289-9291`/`9628-9631` — never by a live line-item save, since those are always recomputed for display via `cInv()`/`iCalc()` and never re-stored). Missing any of these three would be exactly the "silent data loss on first Cloud round-trip" this REQ's own drafting history (three rounds of the identical `invNum`/`invId`-divergence bug class) was written to prevent recurring a fourth time.

```sql
-- SPEC-CLOUD-006: extends the Cloud Data shared-database layer to Invoice and Credit
-- Note — one shared table, matching how DB.inv already holds both record shapes
-- locally (a Credit Note is a `type` flag on an Invoice-shaped record, not a
-- separate array — REQ-CLOUD-006 §0).
--
-- `buyer_id`/`linked_quote_id`/each element of `pos` are deliberately NOT
-- foreign-key-constrained, matching every prior cross-entity reference in this
-- series (`sup_id`/`inv_id`/`quote_id` on `purchase_orders`, `source_contact_id`
-- on `quotes`) — `text`, not `uuid`, since the referenced entity's local id is
-- not RFC-4122 format before ITS OWN migration completes, and a plain-text
-- column accommodates a record created either before or after that point
-- uniformly, with no schema-level distinction.
--
-- `linked_inv_id` (the CN → Invoice self-reference, REQ-CLOUD-006b) is ALSO
-- deliberately left as plain `text`, not a real `references invoices(id)`
-- foreign key, even though both ends of this reference live in the same table
-- being migrated in one batch (which would make a real FK constraint
-- structurally safe for THIS migration's own two-pass insert). It is kept
-- consistent with every other cross-reference column in this series instead,
-- for two reasons: (1) `INV-GAP-002` (logged, not fixed, by this REQ — §3)
-- already accepts that `delInv()` can leave a dangling `linkedInvId` behind on
-- an ordinary delete, post-migration, with no cleanup — a real FK constraint
-- would make Postgres reject that exact scenario's corresponding CN row update
-- rather than silently tolerating the pre-existing, accepted gap; and (2) it
-- keeps the whole table's cross-reference-column story uniform rather than
-- carving out one field as the sole exception.
--
-- `line_items`/`pos` are `jsonb`, matching every prior entity's embedded-array
-- convention. `pos` holds Purchase Order ids exactly as `DB.inv[].pos[]` does
-- locally — by the time Invoice migrates, REQ-CLOUD-006a's own four-entity
-- precondition guarantees Purchase Order has already fully migrated, so every
-- element already IS a real Supabase Purchase Order id, needing no further
-- transformation on insert.
--
-- `date`/`expiry`/`ship_date` are `text`, not `date` — matches every prior
-- entity's identical <input type="date">.value convention (Quote's `dt`,
-- Purchase Order's `date`), never a JS Date object, never reformatted.
--
-- `tax_rate`/`lf`/`ins`/`leg`/`isp`/`oth`/`dep`/`cn_amount`/the eight `calc_*`
-- fields are `numeric` — Invoice's own JS convention stores the `calc_*`
-- fields as strings (`String(gt)`, etc.) purely for display-formatting
-- convenience, matching how `numeric` already round-trips through this app's
-- other entities (Quote's `calc_total_landed` etc.) as a string via the
-- Supabase client's own JSON serialization of arbitrary-precision numeric
-- types — refreshInvFromSupabase() (§2.3) explicitly re-stringifies them on
-- read back, matching the local convention exactly rather than leaving them
-- as JS numbers.
--
-- `buyer_approved_at` is `timestamptz`, matching `saveInvApprove()`'s own
-- `new Date().toISOString()` assignment and Quote's identical `approved_at`
-- precedent — never a bare date string.
--
-- `edit_history` is `jsonb`, nullable, no default — only present on a record
-- that has actually been through the G-05/G-06 unlock-and-edit workflow at
-- least once; most records never carry this key at all, matching how
-- `refreshInvFromSupabase()` (§2.3) omits it entirely rather than writing an
-- empty array onto a record that never had the key.
--
-- `_demo` is deliberately excluded, matching REQ-CLOUD-003/004/005's identical
-- precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table invoices (
  id                  uuid primary key default gen_random_uuid(),
  num                 text not null unique,
  type                text not null default 'invoice',
  buyer_id            text,
  buyer               text,
  buyer_addr          text,
  ship_to             text,
  dst                 text,
  cust_id             text,
  date                text,
  expiry              text,
  ship_date           text,
  ft                  text,
  wt                  text,
  cbm                 text,
  pk                  text,
  pol                 text,
  pod                 text,
  coo                 text,
  cur                 text,
  tax_rate            numeric,
  lf                  numeric,
  ins                 numeric,
  leg                 numeric,
  isp                 numeric,
  oth                 numeric,
  dep                 numeric,
  incoterm            text,
  payment_terms       text,
  terms               text,
  charges_included    boolean,
  status              text not null,
  line_items          jsonb not null default '[]'::jsonb,
  pos                 jsonb not null default '[]'::jsonb,
  buyer_approved_at   timestamptz,
  buyer_approved_by   text,
  approval_method     text,
  approval_note       text,
  linked_quote_id     text,
  linked_quote_num    text,
  linked_inv_num      text,
  linked_inv_id       text,
  cn_reason           text,
  cn_amount           numeric,
  notes               text,
  edit_history        jsonb,
  calc_grand_total    numeric,
  calc_cogs           numeric,
  calc_gross_profit   numeric,
  calc_net_profit     numeric,
  calc_margin         numeric,
  calc_balance_due    numeric,
  calc_li_total       numeric,
  calc_tax_amt        numeric,
  upd_at              timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

alter table invoices enable row level security;

create policy "authenticated read" on invoices for select using (auth.role() = 'authenticated');
create policy "authenticated write" on invoices for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on invoices for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
```

`num text not null unique` matches every prior entity's ref-number convention. `REQ-CLOUD-006c`'s pre-flight duplicate scan (§2.2) is what keeps a migration from ever hitting this constraint — confirmed necessary, not a documented no-op, since both `vInv()`'s `RX.invNum` regex and `saveCN()`'s own duplicate check (`10002-10003`) allow manually-entered, non-case-normalized numbers.

---

## 2. `index.html` changes

### 2.1 Three new precondition-check helpers, mirroring `isSupplierMigrationComplete()` exactly

Insert immediately after `isSupplierMigrationComplete()` closes (`index.html:5791`), before `findDuplicateSupplierNames()`.

```js
async function isLineItemMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_li_cloud_migration_ts')) return true;
  var result = await _sb.from('line_items').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
async function isQteMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_qt_cloud_migration_ts')) return true;
  var result = await _sb.from('quotes').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
async function isPOMigrationComplete() {
  if (!_sb) return false;
  if (localStorage.getItem('st_po_cloud_migration_ts')) return true;
  var result = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  return !!(result.data && result.data.length > 0);
}
```

**Buyer's own precondition check reuses `isSupplierMigrationComplete()` directly, with no separate `isBuyerMigrationComplete()`** — flagged for spec-gate to confirm this framing is acceptable. REQ-CLOUD-006a's own prose names "Buyer" as one of the four precondition entities, but there is no standalone Buyer migration action anywhere in the app: `migrateSuppliersBuyersToSupabase()` migrates Supplier and Buyer together, under the one shared `st_cloud_migration_ts` marker, and every other Buyer-dependent check already in this codebase (there are none besides this one, since Invoice is the first entity whose *own* migration depends on Buyer) would have no other function to call. Reusing `isSupplierMigrationComplete()` for the "Buyer" leg of the precondition is therefore not an approximation of a missing check — it is the exact, only-possible check, since Supplier and Buyer migrate as one atomic event.

### 2.2 Pre-flight duplicate-`num` scan — new `findDuplicateInvNums()`/`showInvDupConflictModal()`, new modal (§0.2)

Insert `findDuplicateInvNums()` immediately after `findDuplicatePONums()` closes (`index.html:5827`); insert `showInvDupConflictModal()` immediately after `showPoDupConflictModal()` closes (`index.html:5839`).

```js
function findDuplicateInvNums(inv) {
  var groups = {};
  inv.forEach(function(r){
    var key = r.num || '';
    if (!key) return;
    (groups[key] = groups[key] || []).push(r);
  });
  return Object.keys(groups).map(function(k){ return groups[k]; }).filter(function(g){ return g.length > 1; });
}

function showInvDupConflictModal(dupes) {
  G('inv-dup-list').innerHTML = '<p style="margin-bottom:10px;">Migration blocked: the following Invoice/Credit Note numbers are duplicated (exact match) and would violate the cloud database\'s unique-number constraint. Rename one of each pair before migrating.</p><ul style="padding-left:18px;">' +
    dupes.map(function(g){ return '<li>' + g.map(function(r){ return san(r.num); }).join(' &nbsp;/&nbsp; '); }).join('</li>') + '</li></ul>';
  G('ov-inv-dup').classList.add('on');
}
```

Case-sensitive exact match across the *whole* `DB.inv` array regardless of `type`, mirroring `findDuplicatePONums()` and matching how `vInv()`'s/`saveCN()`'s own live duplicate checks already operate (REQ-CLOUD-006c) — an Invoice and a CN sharing one number is caught exactly the same way as two Invoices sharing one.

New modal HTML, inserted immediately after the existing `ov-po-dup` modal closes:

```html
<div class="ov" id="ov-inv-dup" onclick="if(event.target===this)closeM('ov-inv-dup')">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Migration Blocked — Duplicate Invoice/Credit Note Numbers</h2><button class="mx" onclick="closeM('ov-inv-dup')">&#215;</button></div>
    <div class="mb">
      <div id="inv-dup-list" style="font-size:.55rem;"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-g" onclick="closeM('ov-inv-dup')">Close</button>
      </div>
    </div>
  </div>
</div>
```

Structurally identical to `ov-po-dup` — a new, dedicated modal, never modifying any of the three existing ones (§0.2).

### 2.3 New `refreshInvFromSupabase()`, and `initCloudDataLayer()` wiring (§0.1)

Insert immediately after `refreshPOFromSupabase()` closes (`index.html:5731`), before `persistPOChange()`.

```js
async function refreshInvFromSupabase() {
  if (!_sb) return;
  if (DB.inv.length > 0 && !localStorage.getItem('st_inv_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('invoices').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Invoices from Cloud Data.'); return; }
  DB.inv = result.data.map(function(row){
    var isCnRow = row.type === 'credit_note' || row.type === 'goodwill_credit';
    var rec;
    if (isCnRow) {
      // Credit Note shape — only the fields saveCN()'s own object literal (index.html:10006-10023)
      // ever sets locally. Never gains buyerId/shipTo/etc. — those are Invoice-only keys a real
      // CN record never had before migration either.
      rec = {
        id: row.id, num: row.num, type: row.type,
        buyer: row.buyer || '', buyerAddr: row.buyer_addr || '',
        cur: row.cur, date: row.date, status: row.status,
        cnAmount: row.cn_amount, cnReason: row.cn_reason || '',
        linkedInvNum: row.linked_inv_num || '', linkedInvId: row.linked_inv_id || '',
        notes: row.notes || '', lineItems: row.line_items || [],
        taxRate: row.tax_rate || 0, lf: row.lf || 0, ins: row.ins || 0, dep: row.dep || 0
      };
    } else {
      // Invoice shape — every field saveInv()'s own object literal (index.html:7007-7028) sets.
      rec = {
        id: row.id, num: row.num, buyerId: row.buyer_id || '', buyer: row.buyer || '',
        buyerAddr: row.buyer_addr || '', shipTo: row.ship_to || '', dst: row.dst || '', custId: row.cust_id || '',
        date: row.date, expiry: row.expiry || '', shipDate: row.ship_date || '',
        ft: row.ft || '', wt: row.wt || '', cbm: row.cbm || '', pk: row.pk || '',
        pol: row.pol || '', pod: row.pod || '', coo: row.coo || '',
        cur: row.cur, taxRate: row.tax_rate || 0,
        lf: row.lf || 0, ins: row.ins || 0, leg: row.leg || 0, isp: row.isp || 0, oth: row.oth || 0, dep: row.dep || 0,
        incoterm: row.incoterm || '', paymentTerms: row.payment_terms || '', terms: row.terms || '',
        chargesIncluded: row.charges_included !== false, status: row.status,
        lineItems: row.line_items || [], pos: row.pos || [],
        buyerApprovedAt: row.buyer_approved_at || '', buyerApprovedBy: row.buyer_approved_by || '',
        approvalMethod: row.approval_method || '', approvalNote: row.approval_note || '',
        linkedQuoteId: row.linked_quote_id || '', linkedQuoteNum: row.linked_quote_num || '',
        type: row.type || 'invoice',
        linkedInvNum: row.linked_inv_num || '', linkedInvId: row.linked_inv_id || ''
      };
      if (row.notes != null) rec.notes = row.notes; // rare: only a CSV-imported invoice ever carries this
    }
    if (row.upd_at != null) rec.updAt = row.upd_at;
    if (row.edit_history != null) rec.editHistory = row.edit_history;
    if (!isCnRow) {
      if (row.calc_grand_total  != null) rec.calc_grandTotal  = String(row.calc_grand_total);
      if (row.calc_cogs         != null) rec.calc_cogs        = String(row.calc_cogs);
      if (row.calc_gross_profit != null) rec.calc_grossProfit = String(row.calc_gross_profit);
      if (row.calc_net_profit   != null) rec.calc_netProfit   = String(row.calc_net_profit);
      if (row.calc_margin       != null) rec.calc_margin      = String(row.calc_margin);
      if (row.calc_balance_due  != null) rec.calc_balanceDue  = String(row.calc_balance_due);
      if (row.calc_li_total     != null) rec.calc_liTotal     = String(row.calc_li_total);
      if (row.calc_tax_amt      != null) rec.calc_taxAmt      = String(row.calc_tax_amt);
    }
    return rec;
  });
  sv(K.i, DB.inv);
  if (!localStorage.getItem('st_inv_cloud_migration_ts')) localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  rInv(); rDash();
}
```

`updAt`/`editHistory`/every `calc_*` field are added `if (row.x != null)`, never via a bare pass-through — the same `SPEC-CLOUD-004` spec-gate round-1 B2 defect class this whole series has since avoided from the start (`SPEC-CLOUD-005` §2.1's own explicit callout). A CN record never gains a single Invoice-only key (`buyerId`, `shipTo`, `pos`, `calc_*`, `editHistory`, etc.) — the `isCnRow` branch builds a wholly separate, minimal object literal rather than one shared shape with optional extras, precisely because a real local CN record never carries any of those keys either.

`initCloudDataLayer()` (`index.html:5584-5596`) gains one line, after Purchase Order:

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

### 2.4 New `persistInvChange(inv, skipRefresh)`

Insert immediately after `refreshInvFromSupabase()` closes, before `persistPOChange()`.

```js
async function persistInvChange(inv, skipRefresh) {
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var isCnRec = inv.type === 'credit_note' || inv.type === 'goodwill_credit';
    var row = isCnRec ? {
      num: inv.num, type: inv.type, buyer: inv.buyer || null, buyer_addr: inv.buyerAddr || null,
      cur: inv.cur, date: inv.date, status: inv.status,
      cn_amount: inv.cnAmount != null ? inv.cnAmount : null, cn_reason: inv.cnReason || null,
      linked_inv_num: inv.linkedInvNum || null, linked_inv_id: inv.linkedInvId || null,
      notes: inv.notes || null, line_items: inv.lineItems || [],
      tax_rate: inv.taxRate, lf: inv.lf, ins: inv.ins, dep: inv.dep
    } : {
      num: inv.num, type: inv.type || 'invoice', buyer_id: inv.buyerId || null, buyer: inv.buyer || null,
      buyer_addr: inv.buyerAddr || null, ship_to: inv.shipTo || null, dst: inv.dst || null, cust_id: inv.custId || null,
      date: inv.date, expiry: inv.expiry || null, ship_date: inv.shipDate || null,
      ft: inv.ft || null, wt: inv.wt || null, cbm: inv.cbm || null, pk: inv.pk || null,
      pol: inv.pol || null, pod: inv.pod || null, coo: inv.coo || null,
      cur: inv.cur, tax_rate: inv.taxRate, lf: inv.lf, ins: inv.ins, leg: inv.leg, isp: inv.isp, oth: inv.oth, dep: inv.dep,
      incoterm: inv.incoterm || null, payment_terms: inv.paymentTerms || null, terms: inv.terms || null,
      charges_included: inv.chargesIncluded !== undefined ? !!inv.chargesIncluded : null,
      status: inv.status, line_items: inv.lineItems || [], pos: inv.pos || [],
      buyer_approved_at: inv.buyerApprovedAt || null, buyer_approved_by: inv.buyerApprovedBy || null,
      approval_method: inv.approvalMethod || null, approval_note: inv.approvalNote || null,
      linked_quote_id: inv.linkedQuoteId || null, linked_quote_num: inv.linkedQuoteNum || null,
      notes: inv.notes || null, edit_history: inv.editHistory || null,
      calc_grand_total: inv.calc_grandTotal != null ? inv.calc_grandTotal : null,
      calc_cogs: inv.calc_cogs != null ? inv.calc_cogs : null,
      calc_gross_profit: inv.calc_grossProfit != null ? inv.calc_grossProfit : null,
      calc_net_profit: inv.calc_netProfit != null ? inv.calc_netProfit : null,
      calc_margin: inv.calc_margin != null ? inv.calc_margin : null,
      calc_balance_due: inv.calc_balanceDue != null ? inv.calc_balanceDue : null,
      calc_li_total: inv.calc_liTotal != null ? inv.calc_liTotal : null,
      calc_tax_amt: inv.calc_taxAmt != null ? inv.calc_taxAmt : null
    };
    row.upd_at = inv.updAt != null ? inv.updAt : null;
    var result = await _sb.from('invoices').update(row).eq('id', inv.id);
    if (result.error) { console.warn('[Stackd] persistInvChange: failed to push Invoice/CN update for ' + inv.id, result.error.message); return; }
    if (!skipRefresh) await refreshInvFromSupabase();
    return;
  }
  sv(K.i, DB.inv);
}
```

Mirrors `persistPOChange()`/`persistQteChange()`/`persistOrdChange()` exactly in shape and in the `skipRefresh` contract: every call site that loops over multiple touched invoices before refreshing once (call sites #6, #7, #8, #10, #11, #12, #13 below) passes `true` and calls `refreshInvFromSupabase()` itself, once, after its own loop. `persistInvChange()` branches on `inv.type` the same way `refreshInvFromSupabase()` does, for the identical reason — a CN update must never send an Invoice-only column a real CN row never had a value for, and vice versa.

### 2.5 `migrateInvToSupabase()` — new function

Insert immediately after `migratePOToSupabase()` closes (`index.html:6368`).

```js
async function migrateInvToSupabase() {
  if (!_sb) { toast('Configure Supabase first.'); return; }
  if (!(await ensureSbAuth())) return;

  // REQ-CLOUD-006a: four-entity precondition, each verified live against the
  // currently-connected project — Buyer shares Supplier's own migration event
  // (see §2.1's own note on why isSupplierMigrationComplete() is the correct,
  // only-possible check for "Buyer").
  if (!(await isSupplierMigrationComplete())) { toast('Migrate Suppliers/Buyers to Cloud Data first — every Invoice requires a Buyer link.'); return; }
  if (!(await isLineItemMigrationComplete())) { toast('Migrate Line Items to Cloud Data first — Invoice line items reference Line Items.'); return; }
  if (!(await isQteMigrationComplete()))      { toast('Migrate Quotes to Cloud Data first — an Invoice can link to a Quote.'); return; }
  if (!(await isPOMigrationComplete()))       { toast('Migrate Purchase Orders to Cloud Data first — Invoice tracks its linked Purchase Orders.'); return; }

  // REQ-CLOUD-006b(1): four live pre-flight FK checks against the now-confirmed-
  // migrated tables — mirrors migrateLineItemsToSupabase()'s/migratePOToSupabase()'s
  // own knownXIdSet pattern. Any unresolvable reference blocks the whole migration
  // with a clear per-record message before any row is inserted.
  var knownBuyIds = await _sb.from('buyers').select('*').is('deleted_at', null);
  if (knownBuyIds.error) { toast('Could not verify Buyer links before migrating: ' + knownBuyIds.error.message); return; }
  var knownBuyIdSet = {}; knownBuyIds.data.forEach(function(b){ knownBuyIdSet[b.id] = true; });

  var knownLIIds = await _sb.from('line_items').select('*').is('deleted_at', null);
  if (knownLIIds.error) { toast('Could not verify Line Item links before migrating: ' + knownLIIds.error.message); return; }
  var knownLIIdSet = {}; knownLIIds.data.forEach(function(l){ knownLIIdSet[l.id] = true; });

  var knownQteIds = await _sb.from('quotes').select('*').is('deleted_at', null);
  if (knownQteIds.error) { toast('Could not verify Quote links before migrating: ' + knownQteIds.error.message); return; }
  var knownQteIdSet = {}; knownQteIds.data.forEach(function(q){ knownQteIdSet[q.id] = true; });

  var knownPOIds = await _sb.from('purchase_orders').select('*').is('deleted_at', null);
  if (knownPOIds.error) { toast('Could not verify Purchase Order links before migrating: ' + knownPOIds.error.message); return; }
  var knownPOIdSet = {}; knownPOIds.data.forEach(function(p){ knownPOIdSet[p.id] = true; });

  var badBuyerInv = DB.inv.find(function(r){ return r.buyerId && !knownBuyIdSet[r.buyerId]; });
  if (badBuyerInv) { toast('Migration blocked: Invoice ' + (badBuyerInv.num||badBuyerInv.id) + ' references a Buyer not found in Cloud Data. Fix or reassign its Buyer link before migrating.'); return; }

  var badLiRec = null, badLiId = null;
  DB.inv.forEach(function(r){
    if (badLiRec) return;
    (r.lineItems||[]).forEach(function(li){ if (li.lid && !knownLIIdSet[li.lid]) { badLiRec = r; badLiId = li.lid; } });
  });
  if (badLiRec) { toast('Migration blocked: ' + (badLiRec.num||badLiRec.id) + ' references a Line Item not found in Cloud Data (' + badLiId + '). Fix or reassign it before migrating.'); return; }

  var badQteInv = DB.inv.find(function(r){ return r.linkedQuoteId && !knownQteIdSet[r.linkedQuoteId]; });
  if (badQteInv) { toast('Migration blocked: Invoice ' + (badQteInv.num||badQteInv.id) + ' references a Quote not found in Cloud Data. Fix or clear its linked Quote before migrating.'); return; }

  var badPoRec = null, badPoId = null;
  DB.inv.forEach(function(r){
    if (badPoRec) return;
    (r.pos||[]).forEach(function(pid){ if (pid && !knownPOIdSet[pid]) { badPoRec = r; badPoId = pid; } });
  });
  if (badPoRec) { toast('Migration blocked: ' + (badPoRec.num||badPoRec.id) + ' references a Purchase Order not found in Cloud Data (' + badPoId + '). Fix or clear it before migrating.'); return; }

  // REQ-CLOUD-006c: pre-flight duplicate-num scan across the WHOLE DB.inv array —
  // Invoice and Credit Note together, matching vInv()'s/saveCN()'s own checks.
  var invDupes = findDuplicateInvNums(DB.inv);
  if (invDupes.length) { showInvDupConflictModal(invDupes); return; }

  var backupConfirmed = await showBlockingBackupModal();
  if (!backupConfirmed) return;

  // REQ-CLOUD-006b(2): two-pass insert. Pass 1 inserts every DB.inv record (Invoice
  // and CN alike) with linked_inv_id deferred to null, building invIdMap from each
  // insert's returned row.
  var invIdMap = {};
  for (var i = 0; i < DB.inv.length; i++) {
    var r = DB.inv[i];
    var isCnRec = r.type === 'credit_note' || r.type === 'goodwill_credit';
    var row = isCnRec ? {
      num: r.num, type: r.type, buyer: r.buyer || null, buyer_addr: r.buyerAddr || null,
      cur: r.cur || null, date: r.date || null, status: r.status,
      cn_amount: r.cnAmount != null ? r.cnAmount : null, cn_reason: r.cnReason || null,
      linked_inv_num: r.linkedInvNum || null, linked_inv_id: null, // pass 2 fills this in
      notes: r.notes || null, line_items: r.lineItems || [],
      tax_rate: r.taxRate, lf: r.lf, ins: r.ins, dep: r.dep
    } : {
      num: r.num, type: r.type || 'invoice', buyer_id: r.buyerId || null, buyer: r.buyer || null,
      buyer_addr: r.buyerAddr || null, ship_to: r.shipTo || null, dst: r.dst || null, cust_id: r.custId || null,
      date: r.date || null, expiry: r.expiry || null, ship_date: r.shipDate || null,
      ft: r.ft || null, wt: r.wt || null, cbm: r.cbm || null, pk: r.pk || null,
      pol: r.pol || null, pod: r.pod || null, coo: r.coo || null,
      cur: r.cur || null, tax_rate: r.taxRate, lf: r.lf, ins: r.ins, leg: r.leg, isp: r.isp, oth: r.oth, dep: r.dep,
      incoterm: r.incoterm || null, payment_terms: r.paymentTerms || null, terms: r.terms || null,
      charges_included: r.chargesIncluded !== undefined ? !!r.chargesIncluded : null,
      status: r.status, line_items: r.lineItems || [], pos: r.pos || [],
      buyer_approved_at: r.buyerApprovedAt || null, buyer_approved_by: r.buyerApprovedBy || null,
      approval_method: r.approvalMethod || null, approval_note: r.approvalNote || null,
      linked_quote_id: r.linkedQuoteId || null, linked_quote_num: r.linkedQuoteNum || null,
      linked_inv_num: null, linked_inv_id: null, // a true Invoice never carries these locally
      notes: r.notes || null, edit_history: r.editHistory || null,
      calc_grand_total: r.calc_grandTotal != null ? r.calc_grandTotal : null,
      calc_cogs: r.calc_cogs != null ? r.calc_cogs : null,
      calc_gross_profit: r.calc_grossProfit != null ? r.calc_grossProfit : null,
      calc_net_profit: r.calc_netProfit != null ? r.calc_netProfit : null,
      calc_margin: r.calc_margin != null ? r.calc_margin : null,
      calc_balance_due: r.calc_balanceDue != null ? r.calc_balanceDue : null,
      calc_li_total: r.calc_liTotal != null ? r.calc_liTotal : null,
      calc_tax_amt: r.calc_taxAmt != null ? r.calc_taxAmt : null
    };
    row.upd_at = r.updAt != null ? r.updAt : null;
    var result = await _sb.from('invoices').insert(row).select().single();
    if (result.error) { toast('Migration failed on ' + (isCnRec ? 'Credit Note ' : 'Invoice ') + (r.num||r.id) + ' — no local data changed, Supabase rows already inserted are not auto-rolled-back. See dr-procedure.md.'); return; }
    invIdMap[r.id] = result.data.id;
  }

  // Pass 2: resolve each CN's linked invoice, linkedInvNum-first with linkedInvId-
  // fallback (REQ-CLOUD-006b, corrected requirements-gate round 7), against DB.inv
  // itself — still keyed by the OLD local ids at this point; the local id remap
  // happens further below, after both passes and both outward/inward sweeps. Also
  // records each resolved CN's new linked_inv_id in cnLinkedIdMap, keyed by the
  // CN's OWN old id, so the final local remap loop below can apply it BEFORE that
  // same loop overwrites r.id — applying it after would silently break for a CN
  // whose linked invoice appears earlier in DB.inv and has therefore already had
  // ITS OWN .id remapped to the new value by the time this CN's turn comes, making
  // a linkedInvId-fallback lookup (`x.id === r.linkedInvId`) fail to match an id
  // that was true only in the pre-remap id space.
  var cnLinkedIdMap = {};
  var danglingLinkedInv = [];
  for (var j = 0; j < DB.inv.length; j++) {
    var cn = DB.inv[j];
    var isCnRow = cn.type === 'credit_note' || cn.type === 'goodwill_credit';
    if (!isCnRow) continue;
    if (!cn.linkedInvNum && !cn.linkedInvId) continue;
    var target = null;
    if (cn.linkedInvNum) target = DB.inv.find(function(x){ return x.num === cn.linkedInvNum; });
    if (!target && cn.linkedInvId) target = DB.inv.find(function(x){ return x.id === cn.linkedInvId; });
    if (!target || !invIdMap[target.id]) { danglingLinkedInv.push(cn.num||cn.id); continue; }
    cnLinkedIdMap[cn.id] = invIdMap[target.id];
    var upd = await _sb.from('invoices').update({ linked_inv_id: invIdMap[target.id] }).eq('id', invIdMap[cn.id]);
    if (upd.error) { console.warn('[Stackd] migrateInvToSupabase: failed to set linked_inv_id for ' + cn.num, upd.error.message); }
  }
  if (danglingLinkedInv.length) console.warn('[Stackd] migrateInvToSupabase: ' + danglingLinkedInv.length + ' Credit Note(s) had a linked-invoice reference that resolved to no migrating record (INV-GAP-002, pre-existing, not fixed here) — left null: ' + danglingLinkedInv.join(', '));

  // REQ-CLOUD-006f: outward retrofit into Purchase Order — invNum-first, invId-
  // fallback, the identical precedence backfillInvoicePOs() already established
  // (index.html:2947-2948) for this exact divergence risk (PO-GAP-004).
  var touchedPoIdsForInv = [];
  DB.po.forEach(function(po){
    var home = po.invNum ? DB.inv.find(function(x){ return x.num === po.invNum; }) : null;
    if (!home && po.invId) home = DB.inv.find(function(x){ return x.id === po.invId; });
    if (!home || !invIdMap[home.id]) return;
    var newInvId = invIdMap[home.id];
    if (po.invId !== newInvId) { po.invId = newInvId; touchedPoIdsForInv.push(po.id); }
  });
  if (touchedPoIdsForInv.length) {
    sv(K.p, DB.po);
    for (var pi = 0; pi < DB.po.length; pi++) {
      if (touchedPoIdsForInv.indexOf(DB.po[pi].id) > -1) await persistPOChange(DB.po[pi], true);
    }
    await refreshPOFromSupabase();
  }

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

  // Archive the true pre-migration snapshot BEFORE remapping DB.inv's own ids below.
  localStorage.setItem('st_inv_pre_migration', localStorage.getItem(K.i));
  localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());

  DB.inv.forEach(function(r){
    var isCnRow = r.type === 'credit_note' || r.type === 'goodwill_credit';
    if (isCnRow && cnLinkedIdMap[r.id] !== undefined) { r.linkedInvId = cnLinkedIdMap[r.id]; }
    if (invIdMap[r.id]) r.id = invIdMap[r.id];
  });
  sv(K.i, DB.inv);

  await refreshInvFromSupabase();
  if (G('cfg-sb-inv-restore-btn')) G('cfg-sb-inv-restore-btn').style.display = '';
  toast('Invoice/Credit Note migration complete. Pre-migration data archived for 30 days.');
}
```

The `cnLinkedIdMap` intermediate step (applying the resolved `linkedInvId` to each CN using its OLD id as the lookup key, in a pass that runs *before* the same loop remaps `r.id`) is the load-bearing correctness detail spec-gate should scrutinize hardest in this function — it is exactly the kind of ordering trap this REQ's own review history (three rounds finding the identical `invNum`/`invId`-divergence bug class in three different places) would be expected to catch a fourth time if it were missed.

### 2.6 `saveInv()` — cloud-aware create/update branch (`index.html:7002-7190`), REQ-CLOUD-006d

**§0.6 (new design decision this SPEC adds, flagged for spec-gate scrutiny): the commit point inside `saveInv()` must move, and the G-06 edit-history block must be reordered ahead of the goodwill-credit/price-history/invoiceRefs blocks it never depended on in the first place.** `saveInv()` is the most side-effect-laden save function in this series — after building `inv`, it (a) writes `inv` into `DB.inv`, (b) for a `goodwill_credit`, pushes a *self-referencing* `DB.payments[]` entry keyed on `inv.id` (`7075-7078`), (c) records catalogue price-history deviations, (d) maintains each Line Item's `invoiceRefs[]`, (e) — G-06 — appends an edit-history entry when `_invEditSnapshot` is active, and only then (f) persists and renders. A naive cloud branch dropped in at the function's existing tail (mirroring `sv(K.i,DB.inv)`'s current position, `7156`) would push (b)'s goodwill-credit payment using a **client-generated `uid()`** for a brand-new goodwill credit's `invId`, then reassign `inv.id` to the real Supabase id only afterward — leaving that payment ledger entry pointing at an id nothing else will ever hold again. The fix is to do the Supabase insert/update **immediately after** `inv`'s fields are fully finalized (the existing-record preservation block, `7039-7070`) and **before** the goodwill-credit push, so every downstream synchronous use of `inv.id` — the goodwill payment, price history, `invoiceRefs[]`, `logEv()`, `audit()`, the fire-and-forget `autoPos(inv)` call, and the FPM-recovery block's `getInvoicePOs(inv)` — sees the final, real id. This requires relocating the G-06 block (currently `7138-7155`, running *after* the goodwill/price-history/`invoiceRefs` blocks) to run immediately after the preservation block instead, ahead of the Cloud Data push, so a G-06 edit gets included in the very row being written. This reordering is safe because G-06 only reads `inv.id`/`inv.lineItems`/`inv[f]` for `f` in `status/buyer/calc_grandTotal/dep/taxRate/lf` (all already finalized by `7070`) and only fires when `_invEditSnapshot.invId === inv.id` — which is only ever true for an **existing** invoice (`EI.i` set), whose `id` never changes on a Cloud *update* regardless of when the push happens. G-06 and the id-reassignment concern are therefore mutually exclusive in practice (G-06 only fires on update, id-reassignment only matters on create) — but the ONLY ordering that is safe for both simultaneously is: preservation → G-06 → Cloud push → goodwill/price-history/`invoiceRefs`. The original local-only array-commit statements (`DB.inv[idx]=inv;` / `else DB.inv.push(inv);`, `7071/7074`) are **kept, unconditionally, in both branches** — this is what keeps `DB.inv`'s entry and the `inv` variable the *same object reference* for the rest of the function, exactly as today, so `autoPos(inv)`'s in-place mutation of `DB.inv[ii].pos` (via `DB.inv.findIndex`) is still visible through `inv.pos` when the FPM-recovery block calls `getInvoicePOs(inv)` afterward. For this same reason, `refreshInvFromSupabase()` — which replaces `DB.inv` wholesale with brand-new objects — is deferred to the **very end** of the function, after the FPM-recovery block, never called mid-function.

Current (the full function):

```js
async function saveInv() {
  // Force any pending oninput events to flush before reading cIL
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  if (!vInv()) return;
  var tx=getTR();
  var inv={
    id:EI.i||uid(), num:G('if-n').value.trim(), buyerId:G('if-b').value||'', buyer:(DB.buy.find(function(b){return b.id===G('if-b').value;})||{}).name||G('if-b').value.trim()||'',
    buyerAddr:G('if-ba').value.trim(), shipTo:G('if-st').value.trim(),
    dst:G('if-dst').value.trim(), custId:G('if-cid').value.trim(),
    date:G('if-dt').value, expiry:G('if-ex').value, shipDate:G('if-sd').value,
    ft:G('if-ft').value.trim(), wt:G('if-wt').value.trim(), cbm:G('if-cbm').value.trim(),
    pk:G('if-pk').value.trim(), pol:G('if-pol').value.trim(), pod:G('if-pod').value.trim(), coo:G('if-coo').value.trim(),
    cur:G('if-cur').value, taxRate:tx,
    lf:+G('if-lf').value||0, ins:+G('if-ins').value||0, leg:+G('if-leg').value||0,
    isp:+G('if-isp').value||0, oth:+G('if-oth').value||0, dep:+G('if-dep').value||0,
    incoterm:G('if-inco').value, paymentTerms:G('if-pt').value.trim(),
    terms:G('if-terms').value.trim(), chargesIncluded:G('if-chi').checked, status:G('inv-sm').value,
    lineItems:cIL.map(function(li){ return {rid:li.rid||uid(),lid:li.lid||'',desc:li.desc||'',uom:li.uom||'',qty:+li.qty||0,up:+li.up||0,unitCost:+li.unitCost||0,lineType:li.lineType||'product'}; }), pos:[],
    buyerApprovedAt: '', buyerApprovedBy: '', approvalMethod: '', approvalNote: '',
    linkedQuoteId: '', linkedQuoteNum: '',
    type:(function(){ if(!isCN(G('if-n').value.trim())) return 'invoice'; return (G('if-cn-goodwill')&&G('if-cn-goodwill').checked)?'goodwill_credit':'credit_note'; })(),
    linkedInvNum:G('if-linked')?G('if-linked').value.trim():'',
    linkedInvId:(function(){ var l=G('if-linked')?G('if-linked').value.trim():''; var r=DB.inv.find(function(i){return i.num===l;}); return r?r.id:''; })(),
    cnReason:G('if-cn-reason')?G('if-cn-reason').value.trim():'',
    cnAmount:G('if-cn-amount')?-(Math.abs(+G('if-cn-amount').value||0)):0,
    updAt:new Date().toISOString()
  };
  // Status transition guard — only applies when both statuses are known workflow values
  if (EI.i && !_unlockedInvIds[EI.i] && STATUS_ORDER.indexOf(inv.status) !== -1) {
    var _existing = DB.inv.find(function(x){ return x.id===EI.i; });
    if (_existing && _existing.status !== inv.status && !canTransitionStatus(_existing.status||'Draft', inv.status)) {
      toast('⚠ Status cannot move backward: ' + (_existing.status||'Draft') + ' → ' + inv.status); return;
    }
  }
  // Capture old status for G-05 status_changed event
  var _invOldStatus = EI.i ? ((DB.inv.find(function(x){return x.id===EI.i;})||{}).status || null) : null;
  // Preserve calc_ fields and lineItems from existing record when no live line items
  if(EI.i){
    var idx=DB.inv.findIndex(function(x){return x.id===EI.i;});
    if(idx>-1){
      var existing=DB.inv[idx];
      inv.pos=existing.pos||[];
      inv.buyerApprovedAt=existing.buyerApprovedAt||'';
      inv.buyerApprovedBy=existing.buyerApprovedBy||'';
      inv.approvalMethod=existing.approvalMethod||'';
      inv.approvalNote=existing.approvalNote||'';
      inv.linkedQuoteId=existing.linkedQuoteId||'';
      inv.linkedQuoteNum=existing.linkedQuoteNum||'';
      // If no live line items in this save, preserve existing calc_ fields and lineItems
      if(cIL.length===0) {
        inv.calc_grandTotal = existing.calc_grandTotal||inv.calc_grandTotal||'0';
        inv.calc_cogs       = existing.calc_cogs||'0';
        inv.calc_grossProfit= existing.calc_grossProfit||'0';
        inv.calc_netProfit  = existing.calc_netProfit||'0';
        inv.calc_margin     = existing.calc_margin||'0';
        inv.calc_balanceDue = existing.calc_balanceDue||'0';
        inv.calc_liTotal    = existing.calc_liTotal||'0';
        inv.calc_taxAmt     = existing.calc_taxAmt||'0';
        inv.lineItems       = existing.lineItems||[];
      }
      // REQ-INTEG-001j: a genuine per-line comparison — added/removed lines, or any
      // surviving line's lid/qty/up/desc changed. Placed HERE, after the cIL.length===0
      // block above has resolved inv.lineItems to its final value for this save, and
      // immediately before DB.inv[idx]=inv below — never earlier, or a save with no live
      // line items would look like "all lines removed" and falsely clear approval.
      if (existing.buyerApprovedAt && invLinesChanged(existing.lineItems||[], inv.lineItems)) {
        inv.buyerApprovedAt=''; inv.buyerApprovedBy=''; inv.approvalMethod=''; inv.approvalNote='';
        logEv('invoice', inv.id, 'approval_cleared', 'Buyer approval cleared — line items changed after approval', 'operator');
      }
      DB.inv[idx]=inv;
    }
  }
  else DB.inv.push(inv);
  // Goodwill credit: maintain a payments ledger entry (remove stale, add current)
  if (inv.type === 'goodwill_credit' && inv.cnAmount) {
    DB.payments = DB.payments.filter(function(p){ return !(p.invId===inv.id && p.method==='Goodwill Credit'); });
    DB.payments.push({ id:uid(), invId:inv.id, invNum:inv.num, amount:+inv.cnAmount||0, method:'Goodwill Credit', ref:inv.num, notes:inv.cnReason||'', date:inv.date||today() });
    sv(K.pm, DB.payments);
  }
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
        var phResult = await _sb.from('line_items').update({ price_history: liHistoryUpdates[hi].priceHistory }).eq('id', liHistoryUpdates[hi].id);
        if (phResult.error) { console.warn('[Stackd] saveInv: failed to push price history for line item ' + liHistoryUpdates[hi].id, phResult.error.message); }
      }
      await refreshLIFromSupabase();
    } else {
      sv(K.l, DB.li);
    }
  }

  // ── invoiceRefs index (gated on cIL.length > 0) ──────────────
  if (cIL.length > 0) {
    var refsChanged = false;
    cIL.forEach(function(li) {
      if (!li.lid) return;
      var cat = DB.li.find(function(x){ return x.id === li.lid; });
      if (!cat) return;
      var refs = cat.invoiceRefs ? cat.invoiceRefs.slice() : [];
      if (!refs.some(function(r){ return r.invId === inv.id; })) {
        refs.push({ invId: inv.id, invNum: inv.num, date: inv.date || '' });
        cat.invoiceRefs = refs;
        refsChanged = true;
      }
    });
    var liveLids = {};
    cIL.forEach(function(li){ if (li.lid) liveLids[li.lid] = true; });
    DB.li.forEach(function(cat) {
      if (!cat.invoiceRefs) return;
      var before = cat.invoiceRefs.length;
      cat.invoiceRefs = cat.invoiceRefs.filter(function(r) {
        return r.invId !== inv.id || liveLids[cat.id];
      });
      if (cat.invoiceRefs.length !== before) refsChanged = true;
    });
    if (refsChanged) sv(K.l, DB.li);
  }

  // G-06: write edit delta before closeM() clears _invEditSnapshot
  if (_invEditSnapshot && _invEditSnapshot.invId === inv.id) {
    var _snap = _invEditSnapshot;
    var _changes = [];
    ['status','buyer','calc_grandTotal','dep','taxRate','lf'].forEach(function(f) {
      var oldV = String(_snap[f] || '0');
      var newV = String(inv[f]  || '0');
      if (oldV !== newV) _changes.push({ field: f, from: oldV, to: newV });
    });
    var newLiCount = (inv.lineItems||[]).length;
    var newLiTotal = (inv.lineItems||[]).reduce(function(s,li){ return s+(+li.qty||0)*(+li.up||0); }, 0);
    if (newLiCount !== _snap.liCount) _changes.push({ field:'lineItems.count', from:String(_snap.liCount), to:String(newLiCount) });
    if (Math.abs(newLiTotal - _snap.liTotal) > 0.001) _changes.push({ field:'lineItems.total', from:_snap.liTotal.toFixed(2), to:newLiTotal.toFixed(2) });
    if (!inv.editHistory) inv.editHistory = [];
    inv.editHistory.push({ ts: new Date().toISOString(), reason: _snap.reason, actor: 'operator', changes: _changes });
    logEv('invoice', inv.id, 'edited', _changes.length + ' field(s) changed — see invoice editHistory' + (_changes.length > 0 ? ' (' + _changes.map(function(c){ return c.field; }).join(', ') + ')' : ''), 'operator');
    _invEditSnapshot = null;
  }
  sv(K.i,DB.inv); closeM('ov-inv'); rInv(); rDash();
  // G-05: log invoice lifecycle events
  if (!EI.i) { logEv('invoice', inv.id, 'created', 'Invoice ' + inv.num + ' created', 'operator'); }
  else if (_invOldStatus !== null && _invOldStatus !== inv.status) { logEv('invoice', inv.id, 'status_changed', 'Status: ' + _invOldStatus + ' → ' + inv.status, 'operator'); }
  if (EI.i && _unlockedInvIds[EI.i]) delete _unlockedInvIds[EI.i]; // consume override after save
  audit(EI.i?'UPDATE':'CREATE','invoice',inv.id,inv); toast('Invoice saved'); renderOnboarding();
  await syncEnt('inv',inv).catch(function(){});
  if(!EI.i) autoPos(inv);
  // Auto-recover FPM-funded deposits when invoice is marked Paid
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
  }
}
```

New (the full function — every unchanged line is reproduced verbatim; only the preservation-block tail, the relocated G-06 block, the new Cloud Data branch, and the final `sv(K.i,DB.inv)`/trailing-refresh lines differ from Current above):

```js
async function saveInv() {
  // Force any pending oninput events to flush before reading cIL
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  if (!vInv()) return;
  var tx=getTR();
  var inv={
    id:EI.i||uid(), num:G('if-n').value.trim(), buyerId:G('if-b').value||'', buyer:(DB.buy.find(function(b){return b.id===G('if-b').value;})||{}).name||G('if-b').value.trim()||'',
    buyerAddr:G('if-ba').value.trim(), shipTo:G('if-st').value.trim(),
    dst:G('if-dst').value.trim(), custId:G('if-cid').value.trim(),
    date:G('if-dt').value, expiry:G('if-ex').value, shipDate:G('if-sd').value,
    ft:G('if-ft').value.trim(), wt:G('if-wt').value.trim(), cbm:G('if-cbm').value.trim(),
    pk:G('if-pk').value.trim(), pol:G('if-pol').value.trim(), pod:G('if-pod').value.trim(), coo:G('if-coo').value.trim(),
    cur:G('if-cur').value, taxRate:tx,
    lf:+G('if-lf').value||0, ins:+G('if-ins').value||0, leg:+G('if-leg').value||0,
    isp:+G('if-isp').value||0, oth:+G('if-oth').value||0, dep:+G('if-dep').value||0,
    incoterm:G('if-inco').value, paymentTerms:G('if-pt').value.trim(),
    terms:G('if-terms').value.trim(), chargesIncluded:G('if-chi').checked, status:G('inv-sm').value,
    lineItems:cIL.map(function(li){ return {rid:li.rid||uid(),lid:li.lid||'',desc:li.desc||'',uom:li.uom||'',qty:+li.qty||0,up:+li.up||0,unitCost:+li.unitCost||0,lineType:li.lineType||'product'}; }), pos:[],
    buyerApprovedAt: '', buyerApprovedBy: '', approvalMethod: '', approvalNote: '',
    linkedQuoteId: '', linkedQuoteNum: '',
    type:(function(){ if(!isCN(G('if-n').value.trim())) return 'invoice'; return (G('if-cn-goodwill')&&G('if-cn-goodwill').checked)?'goodwill_credit':'credit_note'; })(),
    linkedInvNum:G('if-linked')?G('if-linked').value.trim():'',
    linkedInvId:(function(){ var l=G('if-linked')?G('if-linked').value.trim():''; var r=DB.inv.find(function(i){return i.num===l;}); return r?r.id:''; })(),
    cnReason:G('if-cn-reason')?G('if-cn-reason').value.trim():'',
    cnAmount:G('if-cn-amount')?-(Math.abs(+G('if-cn-amount').value||0)):0,
    updAt:new Date().toISOString()
  };
  // Status transition guard — only applies when both statuses are known workflow values
  if (EI.i && !_unlockedInvIds[EI.i] && STATUS_ORDER.indexOf(inv.status) !== -1) {
    var _existing = DB.inv.find(function(x){ return x.id===EI.i; });
    if (_existing && _existing.status !== inv.status && !canTransitionStatus(_existing.status||'Draft', inv.status)) {
      toast('⚠ Status cannot move backward: ' + (_existing.status||'Draft') + ' → ' + inv.status); return;
    }
  }
  // Capture old status for G-05 status_changed event
  var _invOldStatus = EI.i ? ((DB.inv.find(function(x){return x.id===EI.i;})||{}).status || null) : null;
  // Preserve calc_ fields and lineItems from existing record when no live line items
  if(EI.i){
    var idx=DB.inv.findIndex(function(x){return x.id===EI.i;});
    if(idx>-1){
      var existing=DB.inv[idx];
      inv.pos=existing.pos||[];
      inv.buyerApprovedAt=existing.buyerApprovedAt||'';
      inv.buyerApprovedBy=existing.buyerApprovedBy||'';
      inv.approvalMethod=existing.approvalMethod||'';
      inv.approvalNote=existing.approvalNote||'';
      inv.linkedQuoteId=existing.linkedQuoteId||'';
      inv.linkedQuoteNum=existing.linkedQuoteNum||'';
      // If no live line items in this save, preserve existing calc_ fields and lineItems
      if(cIL.length===0) {
        inv.calc_grandTotal = existing.calc_grandTotal||inv.calc_grandTotal||'0';
        inv.calc_cogs       = existing.calc_cogs||'0';
        inv.calc_grossProfit= existing.calc_grossProfit||'0';
        inv.calc_netProfit  = existing.calc_netProfit||'0';
        inv.calc_margin     = existing.calc_margin||'0';
        inv.calc_balanceDue = existing.calc_balanceDue||'0';
        inv.calc_liTotal    = existing.calc_liTotal||'0';
        inv.calc_taxAmt     = existing.calc_taxAmt||'0';
        inv.lineItems       = existing.lineItems||[];
      }
      // REQ-INTEG-001j: a genuine per-line comparison — added/removed lines, or any
      // surviving line's lid/qty/up/desc changed. Placed HERE, after the cIL.length===0
      // block above has resolved inv.lineItems to its final value for this save, and
      // immediately before DB.inv[idx]=inv below — never earlier, or a save with no live
      // line items would look like "all lines removed" and falsely clear approval.
      if (existing.buyerApprovedAt && invLinesChanged(existing.lineItems||[], inv.lineItems)) {
        inv.buyerApprovedAt=''; inv.buyerApprovedBy=''; inv.approvalMethod=''; inv.approvalNote='';
        logEv('invoice', inv.id, 'approval_cleared', 'Buyer approval cleared — line items changed after approval', 'operator');
      }
      DB.inv[idx]=inv;
    }
  }
  else DB.inv.push(inv);

  // G-06: write edit delta before closeM() clears _invEditSnapshot. RELOCATED here
  // (REQ-CLOUD-006d, §0.6) — was originally after the goodwill-credit/price-history/
  // invoiceRefs blocks below; moved ahead of the new Cloud Data push so a G-06 edit is
  // included in the very row pushed to Supabase. Safe to move: only reads inv.id/
  // inv.lineItems/inv[status|buyer|calc_grandTotal|dep|taxRate|lf], all already
  // finalized above, and only fires when _invEditSnapshot.invId===inv.id — true only
  // for an existing invoice, whose id never changes regardless of Cloud Data state.
  if (_invEditSnapshot && _invEditSnapshot.invId === inv.id) {
    var _snap = _invEditSnapshot;
    var _changes = [];
    ['status','buyer','calc_grandTotal','dep','taxRate','lf'].forEach(function(f) {
      var oldV = String(_snap[f] || '0');
      var newV = String(inv[f]  || '0');
      if (oldV !== newV) _changes.push({ field: f, from: oldV, to: newV });
    });
    var newLiCount = (inv.lineItems||[]).length;
    var newLiTotal = (inv.lineItems||[]).reduce(function(s,li){ return s+(+li.qty||0)*(+li.up||0); }, 0);
    if (newLiCount !== _snap.liCount) _changes.push({ field:'lineItems.count', from:String(_snap.liCount), to:String(newLiCount) });
    if (Math.abs(newLiTotal - _snap.liTotal) > 0.001) _changes.push({ field:'lineItems.total', from:_snap.liTotal.toFixed(2), to:newLiTotal.toFixed(2) });
    if (!inv.editHistory) inv.editHistory = [];
    inv.editHistory.push({ ts: new Date().toISOString(), reason: _snap.reason, actor: 'operator', changes: _changes });
    logEv('invoice', inv.id, 'edited', _changes.length + ' field(s) changed — see invoice editHistory' + (_changes.length > 0 ? ' (' + _changes.map(function(c){ return c.field; }).join(', ') + ')' : ''), 'operator');
    _invEditSnapshot = null;
  }

  // REQ-CLOUD-006d: cloud-aware create-or-update. inv (and DB.inv's own entry — the
  // SAME object reference, per the local commit above) is already fully built with
  // every local-only preservation/approval-clearing/G-06 edit-history rule applied.
  // inv.id is reassigned to the real Postgres id IN PLACE, mutating the object DB.inv
  // already holds by reference — so every synchronous use of inv below (the goodwill-
  // credit payments push, price history, the fire-and-forget autoPos(inv) call, and
  // the FPM-recovery block's getInvoicePOs(inv)) keeps working unmodified.
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var isCnInv = inv.type === 'credit_note' || inv.type === 'goodwill_credit';
    var invRow = isCnInv ? {
      num: inv.num, type: inv.type, buyer: inv.buyer || null, buyer_addr: inv.buyerAddr || null,
      cur: inv.cur, date: inv.date, status: inv.status,
      cn_amount: inv.cnAmount != null ? inv.cnAmount : null, cn_reason: inv.cnReason || null,
      linked_inv_num: inv.linkedInvNum || null, linked_inv_id: inv.linkedInvId || null,
      notes: inv.notes || null, line_items: inv.lineItems || [],
      tax_rate: inv.taxRate, lf: inv.lf, ins: inv.ins, dep: inv.dep, upd_at: inv.updAt || null
    } : {
      num: inv.num, type: inv.type || 'invoice', buyer_id: inv.buyerId || null, buyer: inv.buyer || null,
      buyer_addr: inv.buyerAddr || null, ship_to: inv.shipTo || null, dst: inv.dst || null, cust_id: inv.custId || null,
      date: inv.date, expiry: inv.expiry || null, ship_date: inv.shipDate || null,
      ft: inv.ft || null, wt: inv.wt || null, cbm: inv.cbm || null, pk: inv.pk || null,
      pol: inv.pol || null, pod: inv.pod || null, coo: inv.coo || null,
      cur: inv.cur, tax_rate: inv.taxRate, lf: inv.lf, ins: inv.ins, leg: inv.leg, isp: inv.isp, oth: inv.oth, dep: inv.dep,
      incoterm: inv.incoterm || null, payment_terms: inv.paymentTerms || null, terms: inv.terms || null,
      charges_included: inv.chargesIncluded !== undefined ? !!inv.chargesIncluded : null,
      status: inv.status, line_items: inv.lineItems || [], pos: inv.pos || [],
      buyer_approved_at: inv.buyerApprovedAt || null, buyer_approved_by: inv.buyerApprovedBy || null,
      approval_method: inv.approvalMethod || null, approval_note: inv.approvalNote || null,
      linked_quote_id: inv.linkedQuoteId || null, linked_quote_num: inv.linkedQuoteNum || null,
      edit_history: inv.editHistory || null,
      calc_grand_total: inv.calc_grandTotal != null ? inv.calc_grandTotal : null,
      calc_cogs: inv.calc_cogs != null ? inv.calc_cogs : null,
      calc_gross_profit: inv.calc_grossProfit != null ? inv.calc_grossProfit : null,
      calc_net_profit: inv.calc_netProfit != null ? inv.calc_netProfit : null,
      calc_margin: inv.calc_margin != null ? inv.calc_margin : null,
      calc_balance_due: inv.calc_balanceDue != null ? inv.calc_balanceDue : null,
      calc_li_total: inv.calc_liTotal != null ? inv.calc_liTotal : null,
      calc_tax_amt: inv.calc_taxAmt != null ? inv.calc_taxAmt : null,
      upd_at: inv.updAt || null
    };
    var invResult = EI.i
      ? await _sb.from('invoices').update(invRow).eq('id', EI.i).select().single()
      : await _sb.from('invoices').insert(invRow).select().single();
    if (invResult.error) { toast('Save failed: ' + invResult.error.message); return; }
    inv.id = invResult.data.id;
  }

  // Goodwill credit: maintain a payments ledger entry (remove stale, add current)
  if (inv.type === 'goodwill_credit' && inv.cnAmount) {
    DB.payments = DB.payments.filter(function(p){ return !(p.invId===inv.id && p.method==='Goodwill Credit'); });
    DB.payments.push({ id:uid(), invId:inv.id, invNum:inv.num, amount:+inv.cnAmount||0, method:'Goodwill Credit', ref:inv.num, notes:inv.cnReason||'', date:inv.date||today() });
    sv(K.pm, DB.payments);
  }
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
        var phResult = await _sb.from('line_items').update({ price_history: liHistoryUpdates[hi].priceHistory }).eq('id', liHistoryUpdates[hi].id);
        if (phResult.error) { console.warn('[Stackd] saveInv: failed to push price history for line item ' + liHistoryUpdates[hi].id, phResult.error.message); }
      }
      await refreshLIFromSupabase();
    } else {
      sv(K.l, DB.li);
    }
  }

  // ── invoiceRefs index (gated on cIL.length > 0) ──────────────
  if (cIL.length > 0) {
    var refsChanged = false;
    cIL.forEach(function(li) {
      if (!li.lid) return;
      var cat = DB.li.find(function(x){ return x.id === li.lid; });
      if (!cat) return;
      var refs = cat.invoiceRefs ? cat.invoiceRefs.slice() : [];
      if (!refs.some(function(r){ return r.invId === inv.id; })) {
        refs.push({ invId: inv.id, invNum: inv.num, date: inv.date || '' });
        cat.invoiceRefs = refs;
        refsChanged = true;
      }
    });
    var liveLids = {};
    cIL.forEach(function(li){ if (li.lid) liveLids[li.lid] = true; });
    DB.li.forEach(function(cat) {
      if (!cat.invoiceRefs) return;
      var before = cat.invoiceRefs.length;
      cat.invoiceRefs = cat.invoiceRefs.filter(function(r) {
        return r.invId !== inv.id || liveLids[cat.id];
      });
      if (cat.invoiceRefs.length !== before) refsChanged = true;
    });
    if (refsChanged) sv(K.l, DB.li);
  }

  if (!(_sb && localStorage.getItem('st_inv_cloud_migration_ts'))) sv(K.i,DB.inv);
  closeM('ov-inv'); rInv(); rDash();
  // G-05: log invoice lifecycle events
  if (!EI.i) { logEv('invoice', inv.id, 'created', 'Invoice ' + inv.num + ' created', 'operator'); }
  else if (_invOldStatus !== null && _invOldStatus !== inv.status) { logEv('invoice', inv.id, 'status_changed', 'Status: ' + _invOldStatus + ' → ' + inv.status, 'operator'); }
  if (EI.i && _unlockedInvIds[EI.i]) delete _unlockedInvIds[EI.i]; // consume override after save
  audit(EI.i?'UPDATE':'CREATE','invoice',inv.id,inv); toast('Invoice saved'); renderOnboarding();
  await syncEnt('inv',inv).catch(function(){});
  if(!EI.i) autoPos(inv);
  // Auto-recover FPM-funded deposits when invoice is marked Paid
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
  }
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) await refreshInvFromSupabase();
}
```

`invRow` never includes an `id` key, so a create always lets Postgres assign a fresh UUID regardless of the client-generated `uid()` `inv.id` was constructed with at the top of the function — the same invariant every prior `save*()` cloud branch in this series enforces. `saveInv()` is already `async` (for `syncEnt()`); no signature change. No caller anywhere reads `saveInv()`'s return value (confirmed by inspection, matching every other entity's `save*()` in this series), so the added `await`s introduce no new caller-side contract.

### 2.7 `saveCN()` — cloud-aware create/update branch (`index.html:9999-10052`), REQ-CLOUD-006d, plus call site #9

`saveCN()` needs the identical "push before the goodwill payment reads the final id" ordering as `saveInv()`, but is far simpler — there is no G-06/price-history/`invoiceRefs` entanglement, only the goodwill-credit payment push (`10024-10029`). The fix is to relocate the array-commit step (`10030-10035`) to run **before** the goodwill-credit block (`10024-10029`), rather than after it, and make that relocated commit Cloud-aware. Call site #9 (REQ-CLOUD-006e) — pushing the *different*, side-mutated `linkedInv` whose `calc_balanceDue` this function recomputes (`10036-10048`) — is handled in the same diff, as its own `persistInvChange(linkedInv, false)` call immediately after that mutation.

Current:

```js
async function saveCN() {
  if (!vCN()) return;
  var num = G('cnf-n').value.trim();
  var hasDup = DB.inv.some(function(x){ return x.num === num && x.id !== EI.cn; });
  if (hasDup) { vErr('cnf-n', 'Credit Note # already exists'); return; }
  var amt = -(Math.abs(+G('cnf-amount').value||0));
  var type = G('cnf-type').value;
  var cn = {
    id: EI.cn || uid(),
    num: num,
    type: type,
    buyer: G('cnf-b').value.trim(),
    buyerAddr: '',
    cur: G('cnf-cur').value,
    date: G('cnf-dt').value,
    status: G('cn-sm').value,
    cnAmount: amt,
    cnReason: G('cnf-reason').value.trim(),
    linkedInvNum: type === 'goodwill_credit' ? '' : (G('cnf-linked') ? G('cnf-linked').value.trim() : ''),
    linkedInvId: (function(){ var l = type==='goodwill_credit'?'':(G('cnf-linked')?G('cnf-linked').value.trim():''); var r=DB.inv.find(function(i){return i.num===l;}); return r?r.id:''; })(),
    notes: G('cnf-nt').value.trim(),
    lineItems: [],
    taxRate: 0, lf: 0, ins: 0, dep: 0,
    updAt: new Date().toISOString()
  };
  // Goodwill credit → payments ledger entry
  if (type === 'goodwill_credit') {
    DB.payments = DB.payments.filter(function(p){ return p.invId !== cn.id; });
    DB.payments.push({ id: uid(), invId: cn.id, invNum: cn.num, date: cn.date||today(), amount: amt, method: 'Goodwill Credit', ref: cn.cnReason||'Goodwill credit', notes: '' });
    sv(K.pm, DB.payments);
  }
  if (EI.cn) {
    var idx = DB.inv.findIndex(function(x){ return x.id===EI.cn; });
    if (idx > -1) DB.inv[idx] = cn; else DB.inv.push(cn);
  } else {
    DB.inv.push(cn);
  }
  // When a CN is Applied and linked to an invoice, recalculate that invoice's balance due
  if (cn.status === 'CN Applied' && cn.linkedInvNum) {
    var linkedInv = DB.inv.find(function(x){ return x.num === cn.linkedInvNum; });
    if (linkedInv) {
      var totalCredits = DB.inv
        .filter(function(x){ return (x.type === 'credit_note' || x.type === 'goodwill_credit') && x.linkedInvNum === cn.linkedInvNum && x.status === 'CN Applied'; })
        .reduce(function(sum, c){ return sum + Math.abs(parseFloat(c.cnAmount||0)); }, 0);
      var totalPayments = DB.payments
        .filter(function(p){ return p.invId === linkedInv.id || p.invNum === linkedInv.num; })
        .reduce(function(sum, p){ return sum + parseFloat(p.amount||0); }, 0);
      linkedInv.calc_balanceDue = (parseFloat(linkedInv.calc_grandTotal||0) - totalPayments - totalCredits).toFixed(2);
    }
  }
  sv(K.i, DB.inv); closeM('ov-cn'); rInv(); rDash();
  audit(EI.cn?'UPDATE':'CREATE','cn',cn.id,cn); toast('Credit note saved');
  await syncEnt('inv', cn).catch(function(){});
}
```

New:

```js
async function saveCN() {
  if (!vCN()) return;
  var num = G('cnf-n').value.trim();
  var hasDup = DB.inv.some(function(x){ return x.num === num && x.id !== EI.cn; });
  if (hasDup) { vErr('cnf-n', 'Credit Note # already exists'); return; }
  var amt = -(Math.abs(+G('cnf-amount').value||0));
  var type = G('cnf-type').value;
  var cn = {
    id: EI.cn || uid(),
    num: num,
    type: type,
    buyer: G('cnf-b').value.trim(),
    buyerAddr: '',
    cur: G('cnf-cur').value,
    date: G('cnf-dt').value,
    status: G('cn-sm').value,
    cnAmount: amt,
    cnReason: G('cnf-reason').value.trim(),
    linkedInvNum: type === 'goodwill_credit' ? '' : (G('cnf-linked') ? G('cnf-linked').value.trim() : ''),
    linkedInvId: (function(){ var l = type==='goodwill_credit'?'':(G('cnf-linked')?G('cnf-linked').value.trim():''); var r=DB.inv.find(function(i){return i.num===l;}); return r?r.id:''; })(),
    notes: G('cnf-nt').value.trim(),
    lineItems: [],
    taxRate: 0, lf: 0, ins: 0, dep: 0,
    updAt: new Date().toISOString()
  };

  // REQ-CLOUD-006d: cloud-aware create-or-update — RELOCATED here, ahead of the
  // goodwill-credit payments push below, so that push sees cn's final, real Postgres
  // id rather than the client-generated uid() it started with (the identical ordering
  // fix saveInv() needs — §2.6/§0.6 — applied here without any G-06-equivalent
  // complication, since saveCN() has no edit-history mechanism of its own).
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var cnRow = {
      num: cn.num, type: cn.type, buyer: cn.buyer || null, buyer_addr: cn.buyerAddr || null,
      cur: cn.cur, date: cn.date, status: cn.status,
      cn_amount: cn.cnAmount != null ? cn.cnAmount : null, cn_reason: cn.cnReason || null,
      linked_inv_num: cn.linkedInvNum || null, linked_inv_id: cn.linkedInvId || null,
      notes: cn.notes || null, line_items: cn.lineItems || [],
      tax_rate: cn.taxRate, lf: cn.lf, ins: cn.ins, dep: cn.dep, upd_at: cn.updAt || null
    };
    var cnResult = EI.cn
      ? await _sb.from('invoices').update(cnRow).eq('id', EI.cn).select().single()
      : await _sb.from('invoices').insert(cnRow).select().single();
    if (cnResult.error) { toast('Save failed: ' + cnResult.error.message); return; }
    cn.id = cnResult.data.id;
  }
  // Commit cn into DB.inv unconditionally, cloud-aware or not (fixed, spec-gate round 1
  // blocking finding 1 — an earlier draft only ran this inside an else/local-only branch,
  // leaving a cloud-saved CN entirely absent from DB.inv: invisible to its own
  // balance-due self-reference below unless status happens to trigger a later
  // refreshInvFromSupabase(), and to rInv() immediately after the "Credit note saved"
  // toast. Mirrors saveInv()'s own already-correct unconditional-commit-in-both-branches
  // pattern, §0.6/§2.6.
  if (EI.cn) {
    var idx = DB.inv.findIndex(function(x){ return x.id===EI.cn; });
    if (idx > -1) DB.inv[idx] = cn; else DB.inv.push(cn);
  } else {
    DB.inv.push(cn);
  }

  // Goodwill credit → payments ledger entry
  if (type === 'goodwill_credit') {
    DB.payments = DB.payments.filter(function(p){ return p.invId !== cn.id; });
    DB.payments.push({ id: uid(), invId: cn.id, invNum: cn.num, date: cn.date||today(), amount: amt, method: 'Goodwill Credit', ref: cn.cnReason||'Goodwill credit', notes: '' });
    sv(K.pm, DB.payments);
  }
  // When a CN is Applied and linked to an invoice, recalculate that invoice's balance due
  if (cn.status === 'CN Applied' && cn.linkedInvNum) {
    var linkedInv = DB.inv.find(function(x){ return x.num === cn.linkedInvNum; });
    if (linkedInv) {
      var totalCredits = DB.inv
        .filter(function(x){ return (x.type === 'credit_note' || x.type === 'goodwill_credit') && x.linkedInvNum === cn.linkedInvNum && x.status === 'CN Applied'; })
        .reduce(function(sum, c){ return sum + Math.abs(parseFloat(c.cnAmount||0)); }, 0);
      var totalPayments = DB.payments
        .filter(function(p){ return p.invId === linkedInv.id || p.invNum === linkedInv.num; })
        .reduce(function(sum, p){ return sum + parseFloat(p.amount||0); }, 0);
      linkedInv.calc_balanceDue = (parseFloat(linkedInv.calc_grandTotal||0) - totalPayments - totalCredits).toFixed(2);
      // REQ-CLOUD-006e (call site #9): push the side-mutated linkedInv — a DIFFERENT
      // invoice from cn itself — if Invoice has migrated. Not part of a loop (only one
      // invoice can ever be linkedInvNum's target), so no skipRefresh batching needed.
      if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
        await persistInvChange(linkedInv, false);
      }
    }
  }

  if (!(_sb && localStorage.getItem('st_inv_cloud_migration_ts'))) sv(K.i, DB.inv);
  closeM('ov-cn'); rInv(); rDash();
  audit(EI.cn?'UPDATE':'CREATE','cn',cn.id,cn); toast('Credit note saved');
  await syncEnt('inv', cn).catch(function(){});
}
```

`cnRow` never includes an `id` key, matching every other create-or-update cloud branch in this series. Note the local (non-cloud) branch's `sv(K.i, DB.inv)` at the tail already covers `linkedInv`'s in-place `calc_balanceDue` mutation for the not-migrated case, exactly as it does today — call site #9's `persistInvChange(linkedInv, false)` is additive, cloud-only.

### 2.8 `delInv()` — cloud-aware soft-delete branch (`index.html:8230-8244`)

Implied, not separately lettered — see §0.5. Mirrors `delPO()`'s shape (`index.html:8365-8410` — see `SPEC-CLOUD-005` §2.4) exactly: in the migrated branch, `DB.inv` is **not** locally filtered before `refreshInvFromSupabase()` — the refresh itself reloads `DB.inv` already excluding the soft-deleted row (`.is('deleted_at', null)`), matching `delPO()`'s own reliance on `refreshPOFromSupabase()` rather than a local filter-then-refresh.

Current:

```js
async function delInv(id) {
  if(!confirm('Delete this invoice?')) return;
  var _delRec = DB.inv.find(function(i){ return i.id===id; });
  var _isCnDel = _delRec && (_delRec.type==='credit_note' || _delRec.type==='goodwill_credit');
  DB.inv=DB.inv.filter(function(i){return i.id!==id;});
  var libRefsChanged = false;
  DB.li.forEach(function(cat) {
    if (!cat.invoiceRefs) return;
    var before = cat.invoiceRefs.length;
    cat.invoiceRefs = cat.invoiceRefs.filter(function(r){ return r.invId !== id; });
    if (cat.invoiceRefs.length !== before) libRefsChanged = true;
  });
  if (_delRec) logEv('invoice', _delRec.id, 'deleted', 'Invoice ' + (_delRec.num||id) + ' deleted', 'operator');
  sv(K.i,DB.inv); if (libRefsChanged) sv(K.l,DB.li); rInv(); rDash(); toast('Deleted'); await delEnt(_isCnDel ? 'cn' : 'inv', _delRec ? _delRec.num : id).catch(function(){});
}
```

New:

```js
async function delInv(id) {
  if(!confirm('Delete this invoice?')) return;
  var _delRec = DB.inv.find(function(i){ return i.id===id; });
  var _isCnDel = _delRec && (_delRec.type==='credit_note' || _delRec.type==='goodwill_credit');

  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var result = await _sb.from('invoices').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    if (result.error) { toast('Delete failed: ' + result.error.message); return; }
    await refreshInvFromSupabase();
  } else {
    DB.inv=DB.inv.filter(function(i){return i.id!==id;});
    sv(K.i,DB.inv);
  }

  var libRefsChanged = false;
  DB.li.forEach(function(cat) {
    if (!cat.invoiceRefs) return;
    var before = cat.invoiceRefs.length;
    cat.invoiceRefs = cat.invoiceRefs.filter(function(r){ return r.invId !== id; });
    if (cat.invoiceRefs.length !== before) libRefsChanged = true;
  });
  if (_delRec) logEv('invoice', _delRec.id, 'deleted', 'Invoice ' + (_delRec.num||id) + ' deleted', 'operator');
  if (libRefsChanged) sv(K.l,DB.li); rInv(); rDash(); toast('Deleted'); await delEnt(_isCnDel ? 'cn' : 'inv', _delRec ? _delRec.num : id).catch(function(){});
}
```

`_delRec`/`_isCnDel` are captured before either branch, unchanged from today, since both the tail `logEv()`/`delEnt()` calls need them regardless of Cloud Data state. `delInv()` is already `async`; no signature change.

### 2.9 `saveInvApprove()` — async conversion + `persistInvChange()` call site #1 (`index.html:7220-7239`)

Bare `onclick="saveInvApprove()"` (`index.html:1213`) — fire-and-forget, no caller reads a return value.

Current:

```js
function saveInvApprove() {
  if (!vInvApprove()) return;
  var inv = DB.inv.find(function(x){ return x.id === _apprInvId; });
  if (!inv) return;
  inv.buyerApprovedAt = new Date().toISOString();
  inv.buyerApprovedBy = G('ia-by').value.trim();
  inv.approvalMethod = G('ia-method').value;
  inv.approvalNote = G('ia-note').value.trim();
  inv.updAt = new Date().toISOString();
  sv(K.i, DB.inv);
  logEv('invoice', inv.id, 'buyer_approved', 'Buyer approval recorded — ' + inv.approvalMethod + ' (by ' + inv.buyerApprovedBy + ')', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-approve');
  toast('Buyer approval recorded');
  rInv();
  if (G('ov-inv').classList.contains('on') && EI.i === inv.id) {
    G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
    G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
  }
}
```

New:

```js
async function saveInvApprove() {
  if (!vInvApprove()) return;
  var inv = DB.inv.find(function(x){ return x.id === _apprInvId; });
  if (!inv) return;
  inv.buyerApprovedAt = new Date().toISOString();
  inv.buyerApprovedBy = G('ia-by').value.trim();
  inv.approvalMethod = G('ia-method').value;
  inv.approvalNote = G('ia-note').value.trim();
  inv.updAt = new Date().toISOString();
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    await persistInvChange(inv, false);
  } else {
    sv(K.i, DB.inv);
  }
  logEv('invoice', inv.id, 'buyer_approved', 'Buyer approval recorded — ' + inv.approvalMethod + ' (by ' + inv.buyerApprovedBy + ')', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-approve');
  toast('Buyer approval recorded');
  rInv();
  if (G('ov-inv').classList.contains('on') && EI.i === inv.id) {
    G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
    G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
  }
}
```

### 2.10 `saveInvProgress()` — async conversion + call site #2 (`index.html:7262-7276`)

Bare `onclick="saveInvProgress()"` (`index.html:1227`) — fire-and-forget.

Current:

```js
function saveInvProgress() {
  var inv = DB.inv.find(function(x){ return x.id === _progInvId; });
  if (!inv) return;
  var qId = G('ip-qt').value;
  var q = qId ? DB.qt.find(function(x){ return x.id === qId; }) : null;
  inv.linkedQuoteId = q ? q.id : '';
  inv.linkedQuoteNum = q ? q.num : '';
  inv.updAt = new Date().toISOString();
  sv(K.i, DB.inv);
  logEv('invoice', inv.id, 'progressed_to_invoicing', q ? ('Progressed to invoicing — linked Quote ' + q.num) : 'Progressed to invoicing — no Quote linked', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-progress');
  toast('Progressed to invoicing');
  rInv();
}
```

New:

```js
async function saveInvProgress() {
  var inv = DB.inv.find(function(x){ return x.id === _progInvId; });
  if (!inv) return;
  var qId = G('ip-qt').value;
  var q = qId ? DB.qt.find(function(x){ return x.id === qId; }) : null;
  inv.linkedQuoteId = q ? q.id : '';
  inv.linkedQuoteNum = q ? q.num : '';
  inv.updAt = new Date().toISOString();
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    await persistInvChange(inv, false);
  } else {
    sv(K.i, DB.inv);
  }
  logEv('invoice', inv.id, 'progressed_to_invoicing', q ? ('Progressed to invoicing — linked Quote ' + q.num) : 'Progressed to invoicing — no Quote linked', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-progress');
  toast('Progressed to invoicing');
  rInv();
}
```

### 2.11 `autoPos()` — call site #3, already `async` (`index.html:7278-7320`)

`autoPos()` was already made `async` by `SPEC-CLOUD-005` §2.5 for its own Purchase Order push — no signature change needed here. It appends real Supabase PO ids onto `DB.inv[ii].pos[]` but never pushes the *invoice itself* back to Supabase — that's this call site.

Current (tail of the function, from where `SPEC-CLOUD-005`'s own diff left it):

```js
  var ii=DB.inv.findIndex(function(x){return x.id===inv.id;});
  if(ii>-1){
    DB.inv[ii].pos=DB.inv[ii].pos||[];
    newPos.forEach(function(po){ DB.inv[ii].pos.push(po.id); });
  }
  sv(K.i,DB.inv); rPO();
  toast(cnt+' PO'+(cnt!==1?'s':'')+' auto-generated');
}
```

New:

```js
  var ii=DB.inv.findIndex(function(x){return x.id===inv.id;});
  if(ii>-1){
    DB.inv[ii].pos=DB.inv[ii].pos||[];
    newPos.forEach(function(po){ DB.inv[ii].pos.push(po.id); });
  }
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts') && ii>-1) {
    await persistInvChange(DB.inv[ii], false);
  } else {
    sv(K.i,DB.inv);
  }
  rPO();
  toast(cnt+' PO'+(cnt!==1?'s':'')+' auto-generated');
}
```

`autoPos()`'s only caller, `saveInv()`'s `if(!EI.i) autoPos(inv);` (§2.6), is a bare, unawaited statement — the same accepted race `SPEC-CLOUD-005` §2.5 already documents for the Purchase Order half of this same function now extends to the Invoice-side push too: during the (typically sub-second) window between `saveInv()` returning and `autoPos()`'s async work finishing, `inv.pos[]` may not yet be pushed to Supabase even though it is already correct in the local `inv` object (mutated in place, per §2.6). No new risk beyond what `SPEC-CLOUD-005` already accepted for this exact function.

### 2.12 `savePayment()` — call site #4, already `async` (`index.html:13034-13093`)

Current (the invoice-mutation sub-block only; the payment-ledger append above it, `13034-13040`, and the FPM-recovery block below it, already cloud-aware from `SPEC-CLOUD-005` §2.14, are unchanged):

```js
  // Update invoice dep field to match total paid
  var inv = DB.inv.find(function(i){ return i.id === payment.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaid(inv.id);
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

    sv(K.i, DB.inv);
    syncEnt('inv', inv).catch(function(){});
```

New:

```js
  // Update invoice dep field to match total paid
  var inv = DB.inv.find(function(i){ return i.id === payment.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaid(inv.id);
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
```

`skipRefresh=true` here — the FPM-recovery block immediately below (unchanged, already cloud-aware) does its own `refreshPOFromSupabase()` for the Purchase Order side; a single `refreshInvFromSupabase()` for the Invoice side is added once, at the very end of `savePayment()`, after that block, matching the "one refresh per function, not per mutation" convention every multi-step call site in this series follows.

New tail (immediately after the existing FPM-recovery block's closing brace, before `rInv(); rDash();`):

Current:

```js
      if (recovered) toast('✓ Invoice marked Paid — FPM deposits auto-recovered');
      else toast('✓ Invoice marked Paid');
    }

    rInv(); rDash();
  }

  // Payments not synced to Sheets yet — handled in v3.0.0
}
```

New:

```js
      if (recovered) toast('✓ Invoice marked Paid — FPM deposits auto-recovered');
      else toast('✓ Invoice marked Paid');
    }

    if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) await refreshInvFromSupabase();
    rInv(); rDash();
  }

  // Payments not synced to Sheets yet — handled in v3.0.0
}
```

### 2.13 `deletePayment()` — async conversion + call site #5 (`index.html:13095-13114`)

Bare `onclick="deletePayment('...')"` built into each rendered row (`index.html:13148`) — fire-and-forget.

Current:

```js
function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  sv(K.pm, DB.payments);
  audit('DELETE', 'payment', id, pm);

  // Recalculate invoice dep
  var inv = DB.inv.find(function(i){ return i.id === pm.invId; });
  if (inv) {
    inv.dep = getInvTotalPaid(inv.id);
    inv.updAt = new Date().toISOString();
    sv(K.i, DB.inv);
    syncEnt('inv', inv).catch(function(){});
    rInv(); rDash();
  }
  renderPaymentsTab(pm.invId);
}
```

New:

```js
async function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  sv(K.pm, DB.payments);
  audit('DELETE', 'payment', id, pm);

  // Recalculate invoice dep
  var inv = DB.inv.find(function(i){ return i.id === pm.invId; });
  if (inv) {
    inv.dep = getInvTotalPaid(inv.id);
    inv.updAt = new Date().toISOString();
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

### 2.14 `advMergeBuyers()` — async conversion + call site #6, looped (`index.html:11769-11795`)

Bare `onclick="advMergeBuyers()"` (`index.html:895`) — fire-and-forget.

Current:

```js
function advMergeBuyers() {
  var fromName = (G('adv-merge-from')||{}).value || '';
  var toName   = (G('adv-merge-to')||{}).value   || '';
  var confirm  = (G('adv-merge-confirm')||{}).value || '';
  var st = G('adv-merge-status');
  if (!fromName) { st.textContent = 'Select a source buyer.'; st.style.color = 'var(--cr)'; return; }
  if (!toName)   { st.textContent = 'Select a target buyer.'; st.style.color = 'var(--cr)'; return; }
  if (fromName === toName) { st.textContent = 'Source and target must be different.'; st.style.color = 'var(--cr)'; return; }
  if (confirm !== 'CONFIRM') { st.textContent = 'Type CONFIRM exactly to proceed.'; st.style.color = 'var(--cr)'; return; }
  var fromBuy = DB.buy.find(function(b){ return b.name === fromName; });
  var toBuy   = DB.buy.find(function(b){ return b.name === toName; });
  if (!toBuy) { st.textContent = 'Target buyer not found in Buyers list — please create it first.'; st.style.color = 'var(--cr)'; return; }
  var count = 0;
  DB.inv.forEach(function(inv){
    var match = inv.buyer === fromName || (fromBuy && inv.buyerId === fromBuy.id);
    if (match) { inv.buyer = toBuy.name; inv.buyerId = toBuy.id; count++; }
  });
  if (count === 0) { st.textContent = 'No invoices found attributed to "' + fromName + '".'; st.style.color = 'var(--m)'; return; }
  sv(K.i, DB.inv);
  logEv('buyer', toBuy.id, 'updated', 'Bulk buyer merge: ' + count + ' invoice(s) reassigned from "' + fromName + '" to "' + toName + '"', 'operator');
  st.textContent = count + ' invoice(s) reassigned to "' + toName + '" successfully.';
  st.style.color = 'var(--gn)';
  if (G('adv-merge-confirm')) G('adv-merge-confirm').value = '';
  advMergePopulate();
  renderAll();
  toast(count + ' invoice(s) merged to "' + toName + '"');
}
```

New:

```js
async function advMergeBuyers() {
  var fromName = (G('adv-merge-from')||{}).value || '';
  var toName   = (G('adv-merge-to')||{}).value   || '';
  var confirm  = (G('adv-merge-confirm')||{}).value || '';
  var st = G('adv-merge-status');
  if (!fromName) { st.textContent = 'Select a source buyer.'; st.style.color = 'var(--cr)'; return; }
  if (!toName)   { st.textContent = 'Select a target buyer.'; st.style.color = 'var(--cr)'; return; }
  if (fromName === toName) { st.textContent = 'Source and target must be different.'; st.style.color = 'var(--cr)'; return; }
  if (confirm !== 'CONFIRM') { st.textContent = 'Type CONFIRM exactly to proceed.'; st.style.color = 'var(--cr)'; return; }
  var fromBuy = DB.buy.find(function(b){ return b.name === fromName; });
  var toBuy   = DB.buy.find(function(b){ return b.name === toName; });
  if (!toBuy) { st.textContent = 'Target buyer not found in Buyers list — please create it first.'; st.style.color = 'var(--cr)'; return; }
  var count = 0;
  var touchedInvIdsForMerge = {};
  DB.inv.forEach(function(inv){
    var match = inv.buyer === fromName || (fromBuy && inv.buyerId === fromBuy.id);
    if (match) { inv.buyer = toBuy.name; inv.buyerId = toBuy.id; count++; touchedInvIdsForMerge[inv.id] = true; }
  });
  if (count === 0) { st.textContent = 'No invoices found attributed to "' + fromName + '".'; st.style.color = 'var(--m)'; return; }

  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    for (var mi = 0; mi < DB.inv.length; mi++) {
      if (touchedInvIdsForMerge[DB.inv[mi].id]) await persistInvChange(DB.inv[mi], true);
    }
    await refreshInvFromSupabase();
  } else {
    sv(K.i, DB.inv);
  }

  logEv('buyer', toBuy.id, 'updated', 'Bulk buyer merge: ' + count + ' invoice(s) reassigned from "' + fromName + '" to "' + toName + '"', 'operator');
  st.textContent = count + ' invoice(s) reassigned to "' + toName + '" successfully.';
  st.style.color = 'var(--gn)';
  if (G('adv-merge-confirm')) G('adv-merge-confirm').value = '';
  advMergePopulate();
  renderAll();
  toast(count + ' invoice(s) merged to "' + toName + '"');
}
```

### 2.15 `delPO()`'s splice — call site #7 (`index.html:8380-8387`)

`delPO()` is already `async` (`SPEC-CLOUD-005`). This retrofit sits immediately alongside that SPEC's own `PO-GAP-007` fix (the very next block, unchanged) — both clean up a different array after a PO is deleted, one Quote-side, one Invoice-side.

Current:

```js
  var _posChanged = false;
  DB.inv.forEach(function(i){
    if (i.pos && i.pos.length) {
      var idx = i.pos.indexOf(id);
      if (idx > -1) { i.pos.splice(idx,1); _posChanged = true; }
    }
  });
  if (_posChanged) sv(K.i,DB.inv);
```

New:

```js
  var _posChanged = false;
  var touchedInvIdsForPoDel = {};
  DB.inv.forEach(function(i){
    if (i.pos && i.pos.length) {
      var idx = i.pos.indexOf(id);
      if (idx > -1) { i.pos.splice(idx,1); _posChanged = true; touchedInvIdsForPoDel[i.id] = true; }
    }
  });
  if (_posChanged) sv(K.i,DB.inv);

  // REQ-CLOUD-006e (call site #7): push each Invoice whose pos[] just lost this PO's
  // id, if Invoice has migrated — the mirror image of this same function's own
  // Quote.linkedPOIds[] retrofit immediately below (REQ-CLOUD-005f/PO-GAP-007).
  if (Object.keys(touchedInvIdsForPoDel).length) {
    for (var ivi = 0; ivi < DB.inv.length; ivi++) {
      if (touchedInvIdsForPoDel[DB.inv[ivi].id]) await persistInvChange(DB.inv[ivi], true);
    }
    await refreshInvFromSupabase();
  }
```

Inserted immediately before the existing `PO-GAP-007` fix block (`8389-8406`, unchanged) — that block's own `touchedQteIdsForPoDel`/`persistQteChange()` push follows unmodified, right after this new one.

### 2.16 `backfillInvoicePOs()` — async conversion + call site #8 (`index.html:2944-2963`)

Per §0.4: becomes `async`, stays fire-and-forget at all five call sites (`4644`, `9333`/`9685`, `11400`, `13569`). The existing `if (changed) saveAll();` line is left completely unmodified — it already correctly persists `DB.inv` (and, harmlessly, every other entity) to `localStorage` for the not-migrated case; the new Cloud Data push is a separate, additive block after it, gated on the same `touched` set.

Current:

```js
function backfillInvoicePOs() {
  var posByInv = {};
  DB.po.forEach(function(po) {
    var home = po.invNum ? DB.inv.find(function(i){ return i.num === po.invNum; }) : null;
    if (!home && po.invId) home = DB.inv.find(function(i){ return i.id === po.invId; });
    if (!home) return;
    if (!posByInv[home.id]) posByInv[home.id] = [];
    posByInv[home.id].push(po.id);
  });
  var changed = false;
  DB.inv.forEach(function(inv) {
    var live = posByInv[inv.id] || [];
    var current = inv.pos || [];
    var same = current.length === live.length && current.every(function(id, i){ return id === live[i]; });
    if (!same) {
      inv.pos = live;
      changed = true;
    }
  });
  if (changed) saveAll();
}
```

New:

```js
async function backfillInvoicePOs() {
  var posByInv = {};
  DB.po.forEach(function(po) {
    var home = po.invNum ? DB.inv.find(function(i){ return i.num === po.invNum; }) : null;
    if (!home && po.invId) home = DB.inv.find(function(i){ return i.id === po.invId; });
    if (!home) return;
    if (!posByInv[home.id]) posByInv[home.id] = [];
    posByInv[home.id].push(po.id);
  });
  var changed = false;
  var touchedInvIdsForBackfill = {};
  DB.inv.forEach(function(inv) {
    var live = posByInv[inv.id] || [];
    var current = inv.pos || [];
    var same = current.length === live.length && current.every(function(id, i){ return id === live[i]; });
    if (!same) {
      inv.pos = live;
      changed = true;
      touchedInvIdsForBackfill[inv.id] = true;
    }
  });
  if (changed) saveAll();

  // REQ-CLOUD-006e (call site #8): push each CHANGED invoice, if Invoice has migrated.
  // Additive to the unconditional saveAll() above — safe even when not migrated, since
  // persistInvChange()'s own local-branch fallback (sv(K.i,DB.inv)) and
  // refreshInvFromSupabase()'s own guards both no-op harmlessly in that case.
  if (Object.keys(touchedInvIdsForBackfill).length) {
    for (var bi = 0; bi < DB.inv.length; bi++) {
      if (touchedInvIdsForBackfill[DB.inv[bi].id]) await persistInvChange(DB.inv[bi], true);
    }
    await refreshInvFromSupabase();
  }
}
```

Every one of the five call sites (`backfillInvoicePOs();`, bare and unawaited) is left exactly as it reads today — per §0.4, async-ifying `initApp()`/`doImport()` to `await` this call is out of scope, mirroring `autoPos()`'s own accepted race.

### 2.17 The four existing local-sweep-function retrofits — call sites #10–13

Each of these four functions already sweeps a `DB.inv` field as a side effect of its own entity's migration; each retrofit adds touched-tracking plus a cross-phase push, mirroring exactly how `SPEC-CLOUD-005` §2.10–§2.12 added the equivalent Purchase Order retrofit to these same four functions one REQ ago (Invoice is simply the next entity appended to each).

**#10 — `migrateSuppliersBuyersToSupabase()`'s sweep of `inv.buyerId`** (`index.html:5919`):

Current:

```js
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) inv.buyerId = buyIdMap[inv.buyerId]; });
```

New:

```js
  var touchedInvIdsForBuy = {};
  DB.inv.forEach(function(inv){ if (buyIdMap[inv.buyerId]) { inv.buyerId = buyIdMap[inv.buyerId]; touchedInvIdsForBuy[inv.id] = true; } });
```

New push block, inserted immediately after the existing `REQ-CLOUD-005i` Purchase Order cross-phase block closes (`index.html:5956`), before the `REQ-CLOUD-001k` archive comment (`5958`):

```js
  // REQ-CLOUD-006e (call site #10): same cross-phase fix, for Invoice.
  if (Object.keys(touchedInvIdsForBuy).length) {
    for (var ivi5 = 0; ivi5 < DB.inv.length; ivi5++) {
      if (touchedInvIdsForBuy[DB.inv[ivi5].id]) await persistInvChange(DB.inv[ivi5], true);
    }
    await refreshInvFromSupabase();
  }
```

**#11 — `migrateLineItemsToSupabase()`'s sweep of `inv.lineItems[].lid`** (`index.html:6005`):

Current:

```js
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) li.lid = liIdMap[li.lid]; }); });
```

New:

```js
  var touchedInvIdsForLi = {};
  DB.inv.forEach(function(inv){ (inv.lineItems||[]).forEach(function(li){ if (liIdMap[li.lid]) { li.lid = liIdMap[li.lid]; touchedInvIdsForLi[inv.id] = true; } }); });
```

New push block, inserted immediately after the existing `REQ-CLOUD-005i` Purchase Order cross-phase block closes (`index.html:6036`), before the `REQ-CLOUD-002d` archive comment (`6038`):

```js
  // REQ-CLOUD-006e (call site #11): same cross-phase fix, for Invoice.
  if (Object.keys(touchedInvIdsForLi).length) {
    for (var ivi6 = 0; ivi6 < DB.inv.length; ivi6++) {
      if (touchedInvIdsForLi[DB.inv[ivi6].id]) await persistInvChange(DB.inv[ivi6], true);
    }
    await refreshInvFromSupabase();
  }
```

**#12 — `migrateQteToSupabase()`'s sweep of `inv.linkedQuoteId`** (`index.html:6229`):

Current:

```js
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

  var touchedOrdIdsForQte = {};
```

New:

```js
  var touchedPoIdsForQte = {};
  DB.po.forEach(function(p){ if (qteIdMap[p.quoteId]) { p.quoteId = qteIdMap[p.quoteId]; touchedPoIdsForQte[p.id] = true; } });
  var touchedInvIdsForQte = {};
  DB.inv.forEach(function(inv){ if (qteIdMap[inv.linkedQuoteId]) { inv.linkedQuoteId = qteIdMap[inv.linkedQuoteId]; touchedInvIdsForQte[inv.id] = true; } });
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

  // REQ-CLOUD-006e (call site #12): cross-phase fix for Invoice — REQ-CLOUD-006 makes
  // the OTHER half of the comment above false too; Invoice.linkedQuoteId is no longer
  // "safe as a plain local fix" either, once Invoice has migrated.
  if (Object.keys(touchedInvIdsForQte).length) {
    for (var ivi7 = 0; ivi7 < DB.inv.length; ivi7++) {
      if (touchedInvIdsForQte[DB.inv[ivi7].id]) await persistInvChange(DB.inv[ivi7], true);
    }
    await refreshInvFromSupabase();
  }

  var touchedOrdIdsForQte = {};
```

The "Outward cross-phase retrofit" comment a few lines below this sweep (`index.html:6250-6252`) is also corrected, since it names Invoice specifically as still safe:

Current:

```
  // Outward cross-phase retrofit (REQ-CLOUD-004e): Invoice.linkedQuoteId above is safe
  // as a plain local fix — it has no Supabase table. PurchaseOrder.quoteId no longer
  // is (see the REQ-CLOUD-005i retrofit just above this sweep). Order
```

New:

```
  // Outward cross-phase retrofit (REQ-CLOUD-004e): neither Invoice.linkedQuoteId nor
  // PurchaseOrder.quoteId above is a "safe as a plain local fix" case any longer —
  // Purchase Order gained a Supabase table in REQ-CLOUD-005 (retrofit just above this
  // sweep) and Invoice gained one in REQ-CLOUD-006 (retrofit just above THAT). Order
```

(The remainder of that comment, about Order Request's own retrofit, is unchanged — only the opening clause is corrected.)

**#13 — `migratePOToSupabase()`'s sweep of `inv.pos[]`** (`index.html:6336-6339`):

Current:

```js
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
```

New:

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

  // REQ-CLOUD-006e (call site #13): same cross-phase fix, for Invoice.
  if (Object.keys(touchedInvIdsForPo).length) {
    for (var ivi8 = 0; ivi8 < DB.inv.length; ivi8++) {
      if (touchedInvIdsForPo[DB.inv[ivi8].id]) await persistInvChange(DB.inv[ivi8], true);
    }
    await refreshInvFromSupabase();
  }

  // Archive the true pre-migration snapshot BEFORE remapping DB.po's own ids below.
```

**Judgment call, flagged for spec-gate:** unlike sites #10–#12 (which only rewrite `inv.buyerId`/`inv.lineItems[].lid`/`inv.linkedQuoteId` — scalars, or fields never mapped to Sheets at all so no `JSON.stringify` false-positive risk exists), site #13's sweep needed its `if (JSON.stringify(newPos) !== JSON.stringify(inv.pos))` change-detection guard added explicitly, mirroring the identical guard `migratePOToSupabase()`'s own `Quote.linkedPOIds[]` sweep already uses two lines above it (`if (JSON.stringify(newIds) !== JSON.stringify(q.linkedPOIds))`) — the REQ's own §1.3/§2e text describes this call site only as "sweeps `inv.pos[]`," without spelling out that a naive unconditional `.map()` (matching the *original*, pre-Cloud-Data local-only version of this exact line, shown in Current above) would mark every invoice with a non-empty `pos[]` as "touched" even when every element already resolved to an unchanged id — needlessly pushing untouched invoices to Supabase on every Purchase Order migration. Mirroring the sibling Quote sweep's own already-correct pattern is the obviously-intended behavior, but it required an explicit code decision this SPEC is making, not one dictated verbatim by the REQ text.

### 2.18 `pullAll()` — exclude `'inv'`/`'cn'` once migrated (REQ-CLOUD-006i)

Two changes, mirroring `SPEC-CLOUD-005` §2.13's own two-part fix exactly (the `_allPullKeys` request-list filter *and* a per-block merge guard — both required, per that SPEC's own spec-gate round-2 lesson about a fix that added only one of the two).

**Change 1 — exclude `'inv'`/`'cn'` from the batched request's entity list** (`index.html:4510-4511`):

Current:

```js
  var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch);
  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) _allPullKeys = _allPullKeys.filter(function(e){ return e !== 'po'; });
```

New:

```js
  var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch);
  if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) _allPullKeys = _allPullKeys.filter(function(e){ return e !== 'po'; });
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) _allPullKeys = _allPullKeys.filter(function(e){ return e !== 'inv' && e !== 'cn'; });
```

One filter line removes both `'inv'` and `'cn'`, gated on the one shared `st_inv_cloud_migration_ts` marker (Invoice and Credit Note migrate together — §0).

**Change 2 — wrap both the Invoice and Credit Note blocks in one shared guard** (`index.html:4524-4565`):

Current:

```js
  // ── Invoices (field-mapping reversed, business-key merge — SYNC-GAP-001) ─
  try {
    var dInv = await pulled('inv');
    if (dInv.status === 'ok' && dInv.records && dInv.records.length) {
      var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
      var calcZeroGuard = ['calc_grandTotal','calc_cogs','calc_netProfit','calc_margin','calc_balanceDue'];
      var invClaim = claimOnceMatcher();
      var mergedInv = invPulled.map(function(p) {
        var candidate = findLocalMatchByBizKey('inv', DB.inv, p);
        var local = invClaim(candidate);
        var m = mergePulledWithLocal(p, local, calcZeroGuard);
        if (!local) m.id = uid();
        return m;
      });
      var invMergedNums = {};
      mergedInv.forEach(function(m){ if (m.num) invMergedNums[m.num] = true; });
      var invLocalOnly = DB.inv.filter(function(r){ return !invMergedNums[r.num]; });
      DB.inv = mergedInv.concat(invLocalOnly);
    }
  } catch(e) { failed.push('inv'); console.warn('[Stackd] pullAll: inv failed —', e.message); }

  // ── Credit notes (merged back into DB.inv) ─────────────────────
  try {
    var dCn = await pulled('cn');
    if (dCn.status === 'ok' && dCn.records && dCn.records.length) {
      var cnPulled = dCn.records.map(function(r){ return unmapRec('cn', r); });
      var cnClaim = claimOnceMatcher();
      var mergedCn = cnPulled.map(function(p) {
        var candidate = DB.inv.find(function(r){ return p.num && r.num === p.num; });
        var local = cnClaim(candidate);
        var m = mergePulledWithLocal(p, local);
        if (!local) m.id = uid();
        return m;
      });
      var cnMergedNums = {};
      mergedCn.forEach(function(m){ if (m.num) cnMergedNums[m.num] = true; });
      DB.inv = DB.inv.filter(function(r){
        var isCnType = r.type === 'credit_note' || r.type === 'goodwill_credit';
        return !(isCnType && cnMergedNums[r.num]);
      }).concat(mergedCn);
    }
  } catch(e) { failed.push('cn'); console.warn('[Stackd] pullAll: cn failed —', e.message); }

  // ── Purchase orders (field-mapping reversed, business-key merge) ─
```

New — one guard wraps both blocks (kept as two separate `try` blocks inside it, unchanged internally):

```js
  // ── Invoices (field-mapping reversed, business-key merge — SYNC-GAP-001) ─
  // REQ-CLOUD-006i: once migrated, Invoice/Credit Note are cloud-authoritative —
  // pulling either from Sheets here would race the fire-and-forget Supabase refresh,
  // with whichever resolves last silently overwriting DB.inv/localStorage. Both blocks
  // share ONE guard, gated on Invoice's own migration marker, since Invoice and Credit
  // Note migrate together as a single event (REQ-CLOUD-006 §0) — mirrors the reasoning
  // behind Purchase Order's own single-entity guard just below this pair.
  if (!(_sb && localStorage.getItem('st_inv_cloud_migration_ts'))) {
  try {
    var dInv = await pulled('inv');
    if (dInv.status === 'ok' && dInv.records && dInv.records.length) {
      var invPulled = dInv.records.map(function(r){ return unmapRec('inv', r); });
      var calcZeroGuard = ['calc_grandTotal','calc_cogs','calc_netProfit','calc_margin','calc_balanceDue'];
      var invClaim = claimOnceMatcher();
      var mergedInv = invPulled.map(function(p) {
        var candidate = findLocalMatchByBizKey('inv', DB.inv, p);
        var local = invClaim(candidate);
        var m = mergePulledWithLocal(p, local, calcZeroGuard);
        if (!local) m.id = uid();
        return m;
      });
      var invMergedNums = {};
      mergedInv.forEach(function(m){ if (m.num) invMergedNums[m.num] = true; });
      var invLocalOnly = DB.inv.filter(function(r){ return !invMergedNums[r.num]; });
      DB.inv = mergedInv.concat(invLocalOnly);
    }
  } catch(e) { failed.push('inv'); console.warn('[Stackd] pullAll: inv failed —', e.message); }

  // ── Credit notes (merged back into DB.inv) ─────────────────────
  try {
    var dCn = await pulled('cn');
    if (dCn.status === 'ok' && dCn.records && dCn.records.length) {
      var cnPulled = dCn.records.map(function(r){ return unmapRec('cn', r); });
      var cnClaim = claimOnceMatcher();
      var mergedCn = cnPulled.map(function(p) {
        var candidate = DB.inv.find(function(r){ return p.num && r.num === p.num; });
        var local = cnClaim(candidate);
        var m = mergePulledWithLocal(p, local);
        if (!local) m.id = uid();
        return m;
      });
      var cnMergedNums = {};
      mergedCn.forEach(function(m){ if (m.num) cnMergedNums[m.num] = true; });
      DB.inv = DB.inv.filter(function(r){
        var isCnType = r.type === 'credit_note' || r.type === 'goodwill_credit';
        return !(isCnType && cnMergedNums[r.num]);
      }).concat(mergedCn);
    }
  } catch(e) { failed.push('cn'); console.warn('[Stackd] pullAll: cn failed —', e.message); }
  }

  // ── Purchase orders (field-mapping reversed, business-key merge) ─
```

No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

### 2.19 Settings UI card, archive/rollback extensions, `rCfg()` wiring (REQ-CLOUD-006k)

**New card**, inserted immediately after the existing "Cloud Data (Purchase Orders)" card closes (`index.html:822`), before the "Accounting Export — Field Mapping Reference" card:

```html
    <div class="card">
      <div class="ct">Cloud Data (Invoices &amp; Credit Notes)</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-g" onclick="migrateInvToSupabase()">Migrate Invoices &amp; Credit Notes to Cloud</button>
        <button class="btn btn-g" id="cfg-sb-inv-restore-btn" style="display:none;" onclick="restoreInvMigrationArchive()">Restore Pre-Migration Invoices &amp; Credit Notes</button>
      </div>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; Requires Buyers, Line Items, Quotes, and Purchase Orders to already be migrated to Cloud Data above (every Invoice requires each of these links). Uses the same Supabase connection configured above.</p>
    </div>
```

The `cfg-sb-inv-restore-btn` id matches the one `migrateInvToSupabase()` already references at `G('cfg-sb-inv-restore-btn')` (§2.5).

**New `restoreInvMigrationArchive()`**, inserted immediately after `restorePOMigrationArchive()` closes (`index.html:6441`), before `cleanupExpiredMigrationArchive()`:

```js
function restoreInvMigrationArchive() {
  var arch = localStorage.getItem('st_inv_pre_migration');
  if (!arch) { toast('No Invoice/Credit Note migration archive available to restore.'); return; }
  if (!confirm('Restore Invoices and Credit Notes to their state immediately before the Supabase migration?\n\nThis does not change Suppliers, Buyers, Line Items, Contacts, Order Requests, Quotes, Purchase Orders, or any other document data, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected for ALL entities, not just Invoices/Credit Notes — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect any of them afterwards.')) return;
  localStorage.setItem(K.i, arch);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  localStorage.removeItem('st_inv_cloud_migration_ts');
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

**`cleanupExpiredMigrationArchive()`** (`index.html:6443-6475`) — extend with a seventh independently-timed block, inserted immediately after the existing Purchase Order block (`6470-6474`) closes, before the function's own closing `}`:

```js
  var invTs = localStorage.getItem('st_inv_cloud_migration_ts');
  if (invTs && (Date.now() - new Date(invTs).getTime()) / 86400000 > 30) {
    localStorage.removeItem('st_inv_pre_migration');
    localStorage.removeItem('st_inv_cloud_migration_ts');
  }
```

**`rCfg()`** (`index.html:10947-10948`, the six existing `cfg-sb-*-restore-btn` visibility lines) — add a seventh, immediately after the Purchase Order one (`10948`), before the `cfg-lang` line that follows it (`10949`):

```js
  if(G('cfg-sb-inv-restore-btn')) G('cfg-sb-inv-restore-btn').style.display = localStorage.getItem('st_inv_cloud_migration_ts') ? '' : 'none';
```

---

## 3. Tests (`tests/run.js`)

Reuses the existing `mockSb()` harness unchanged (already fully generic per-table).

### 3.0 Required companion retrofits of three pre-existing tests (§0.1)

`persistInvChange()`'s `refreshInvFromSupabase()` call is wired into `initCloudDataLayer()` as a **seventh** `await` line (§2.3), after `refreshPOFromSupabase()`. Per §0.1, this is the fourth time this exact contamination class has been found in this series — three pre-existing `initCloudDataLayer()` tests, each already carrying its own chain of prior retrofits, must each gain one more stub, or the real `refreshInvFromSupabase()` runs unmocked against an empty `DB.inv` and permanently sets `st_inv_cloud_migration_ts`, corrupting every later test that touches Invoice/CN. All three are shown explicitly below, not left to inference from one example, per the round-3 rigor note in `REQ-CLOUD-006-v1.md` §8.

**Retrofit 1 — `tests/run.js:7752`** (Order Request's own test):

Current:

```js
testAsync('initCloudDataLayer — now also calls refreshOrdFromSupabase() (spec-gate round-1 B2 finding: previously wired for Supplier/Buyer/Line Item/Contact but not Order Request)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){}; // keep the mock _sb below in place instead of overwriting it with a real client
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
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
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshOrdFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshOrdFromSupabase = origRefreshOrd; ctx.refreshQteFromSupabase = origRefreshQte; ctx.refreshPOFromSupabase = origRefreshPO;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
});
```

New:

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

**Retrofit 2 — `tests/run.js:8310`** (Quote's own test):

Current:

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

New:

```js
testAsync('initCloudDataLayer — now also calls refreshQteFromSupabase() (mirrors the REQ-CLOUD-003 round-1 B2 lesson: wire it in from the start)', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] } });
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
  // SPEC-CLOUD-006: initCloudDataLayer() now also calls refreshInvFromSupabase() after
  // refreshPOFromSupabase() — stub it too, for the same self-marking-contamination
  // reason as refreshPOFromSupabase() above.
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshQteFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshQteFromSupabase = origRefreshQte; ctx.refreshPOFromSupabase = origRefreshPO; ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});
```

**Retrofit 3 — `tests/run.js:8712`** (Purchase Order's own test, carrying none yet):

Current:

```js
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
```

New:

```js
testAsync('initCloudDataLayer — now also calls refreshPOFromSupabase()', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshPO = ctx.refreshPOFromSupabase;
  ctx.refreshPOFromSupabase = function(){ called = true; return Promise.resolve(); };
  // SPEC-CLOUD-006: initCloudDataLayer() now also calls refreshInvFromSupabase() after
  // refreshPOFromSupabase() — stub it too, or the real function runs unmocked against
  // DB.inv (empty at this point) and permanently sets st_inv_cloud_migration_ts.
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshPOFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshPOFromSupabase = origRefreshPO; ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});
```

### 3.1 New test block

Insert this entire block (ending with its own dedicated cleanup test) immediately after the existing `'SPEC-CLOUD-005 test-hygiene cleanup'` test (`tests/run.js:9205-9209`), before the `'AI Assistant — Invoice/Line Item/Credit Note actions...'` section header — the same convention every prior SPEC in this series has followed relative to its predecessor's cleanup test.

```js
// ── CLOUD DATA — Invoice and Credit Note (SPEC-CLOUD-006) ──

testAsync('initCloudDataLayer — now also calls refreshInvFromSupabase()', async function() {
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  var origInitSbClient = ctx.initSbClient;
  ctx.initSbClient = function(){};
  ctx._sb = mockSb({ suppliers: { selectData: [] }, buyers: { selectData: [] }, line_items: { selectData: [] }, contacts: { selectData: [] }, order_requests: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { selectData: [] } });
  var origEnsureAuth = ctx.ensureSbAuth;
  ctx.ensureSbAuth = function(){ return Promise.resolve(true); };
  var called = false;
  var origRefreshInv = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ called = true; return Promise.resolve(); };
  await ctx.initCloudDataLayer();
  assert(called, 'initCloudDataLayer() calls refreshInvFromSupabase()');
  ctx.initSbClient = origInitSbClient; ctx.ensureSbAuth = origEnsureAuth; ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = null;
});

testAsync('refreshInvFromSupabase — refuses to overwrite real local data when this device has never run the migration; proceeds when local data is empty (second-device case); sets its own marker on success; builds separate Invoice/CN shapes; omits updAt/editHistory/calc_* keys entirely when Supabase returns null for them (AC-11)', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.DB.inv.push({ id: 'local-only-inv', num: 'INV75001', status: 'Draft', lineItems: [] });
  ctx._sb = mockSb({ invoices: { selectData: [] } });
  await ctx.refreshInvFromSupabase();
  assertEqual(ctx.DB.inv.length, 1, 'real local Invoice NOT wiped — this device never ran the migration');
  assertEqual(ctx.DB.inv[0].id, 'local-only-inv', 'original record untouched');

  resetDB();
  ctx._sb = mockSb({ invoices: { selectData: [
    { id: 'cloud-inv-1', num: 'INV75002', type: 'invoice', buyer_id: 'b1', buyer: 'Acme', cur: 'USD', date: '2026-01-01', status: 'Draft', line_items: [], pos: [], upd_at: null, edit_history: null, calc_grand_total: null },
    { id: 'cloud-cn-1', num: 'CN75002', type: 'credit_note', buyer: 'Acme', cur: 'USD', date: '2026-01-01', status: 'Draft', cn_amount: -10, linked_inv_num: 'INV75002', linked_inv_id: 'cloud-inv-1', line_items: [] }
  ] } });
  await ctx.refreshInvFromSupabase();
  assertEqual(ctx.DB.inv.length, 2, 'both the Invoice and Credit Note rows loaded');
  var inv = ctx.DB.inv.find(function(x){ return x.num === 'INV75002'; });
  var cn = ctx.DB.inv.find(function(x){ return x.num === 'CN75002'; });
  assertEqual(inv.buyerId, 'b1', 'Invoice shape built with buyerId');
  assertEqual('pos' in cn, false, 'a CN record never gains an Invoice-only key like pos[]');
  assertEqual(cn.linkedInvId, 'cloud-inv-1', 'CN shape correctly carries linkedInvId');
  assertEqual('updAt' in inv, false, 'updAt key omitted entirely, not set to null, when Supabase has none');
  assertEqual('editHistory' in inv, false, 'editHistory key omitted entirely');
  assertEqual('calc_grandTotal' in inv, false, 'calc_grandTotal key omitted entirely');
  assert(!!ctx.localStorage.getItem('st_inv_cloud_migration_ts'), 'marker set even though this device never ran the migration itself');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — blocked unless Buyer, Line Item, Quote, and Purchase Order have each completed their own migration (AC-1)', async function() {
  resetDB();
  ctx._sb = mockSb({});
  var origToast = ctx.toast, toasted = '';
  ctx.toast = function(m){ toasted = m; };
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');

  await ctx.migrateInvToSupabase();
  assert(/Suppliers\/Buyers/.test(toasted), 'blocked on missing Buyer (shared Supplier/Buyer marker): ' + toasted);

  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Line Items/.test(toasted), 'blocked on missing Line Item: ' + toasted);

  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Quotes/.test(toasted), 'blocked on missing Quote: ' + toasted);

  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Purchase Orders/.test(toasted), 'blocked on missing Purchase Order: ' + toasted);

  ctx.toast = origToast;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — the four live pre-flight FK checks each block migration on an unresolvable reference: buyerId, lineItems[].lid, linkedQuoteId, pos[] (AC-2)', async function() {
  var origToast = ctx.toast, toasted = '';
  ctx.toast = function(m){ toasted = m; };
  function setAllMarkers() {
    ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
    ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
    ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
    ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  }

  resetDB(); setAllMarkers();
  ctx.DB.inv.push({ id: 'i1', num: 'INV80001', buyerId: 'ghost-buyer', lineItems: [], pos: [], status: 'Draft' });
  ctx._sb = mockSb({ buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Buyer not found/.test(toasted), 'blocked on unresolvable buyerId: ' + toasted);

  resetDB(); setAllMarkers();
  ctx.DB.inv.push({ id: 'i2', num: 'INV80002', buyerId: '', lineItems: [{ lid: 'ghost-li' }], pos: [], status: 'Draft' });
  ctx._sb = mockSb({ buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Line Item not found/.test(toasted), 'blocked on unresolvable lineItems[].lid: ' + toasted);

  resetDB(); setAllMarkers();
  ctx.DB.inv.push({ id: 'i3', num: 'INV80003', buyerId: '', lineItems: [], linkedQuoteId: 'ghost-qte', pos: [], status: 'Draft' });
  ctx._sb = mockSb({ buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Quote not found/.test(toasted), 'blocked on unresolvable linkedQuoteId: ' + toasted);

  resetDB(); setAllMarkers();
  ctx.DB.inv.push({ id: 'i4', num: 'INV80004', buyerId: '', lineItems: [], pos: ['ghost-po'], status: 'Draft' });
  ctx._sb = mockSb({ buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] } });
  toasted = '';
  await ctx.migrateInvToSupabase();
  assert(/Purchase Order not found/.test(toasted), 'blocked on unresolvable pos[] element: ' + toasted);

  ctx.toast = origToast;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — blocked by a duplicate num spanning an Invoice and a Credit Note sharing one number, not just two Invoices (AC-3)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'i1', num: 'DUPE0001', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Draft' });
  ctx.DB.inv.push({ id: 'c1', num: 'DUPE0001', type: 'credit_note', lineItems: [], status: 'Draft' });
  var sb = mockSb({ buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] }, invoices: { insertImpl: function(row){ return Object.assign({ id: 'x' }, row); } } });
  ctx._sb = sb;
  await ctx.migrateInvToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'insert'; });
  assert(!insertCall, 'migration blocked before any insert — the duplicate spans an Invoice and a CN');
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — two-pass self-referential remap resolves a CN linkedInvNum/linkedInvId to its linked invoice\'s new id, both insertion orders; a genuinely dangling reference is left alone, not blocking (AC-4)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'inv1', num: 'INV10001', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Sent' }); // invoice BEFORE its CN
  ctx.DB.inv.push({ id: 'cn1', num: 'CN10001', type: 'credit_note', linkedInvNum: 'INV10001', linkedInvId: 'inv1', lineItems: [], status: 'Draft', cnAmount: -10 });
  ctx.DB.inv.push({ id: 'cn2', num: 'CN10002', type: 'credit_note', linkedInvNum: 'INV10002', linkedInvId: 'inv2', lineItems: [], status: 'Draft', cnAmount: -20 }); // CN BEFORE its invoice
  ctx.DB.inv.push({ id: 'inv2', num: 'INV10002', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Sent' });
  ctx.DB.inv.push({ id: 'cn3', num: 'CN10003', type: 'credit_note', linkedInvNum: 'GHOST9999', linkedInvId: 'ghost-id', lineItems: [], status: 'Draft', cnAmount: -5 }); // genuinely dangling

  var byOldNum = {};
  var sb = mockSb({
    buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ var id = 'uuid-' + row.num; byOldNum[row.num] = id; return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-inv-restore-btn');
  var origRefresh = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };

  await ctx.migrateInvToSupabase();

  var pass2UpdateCalls = sb._calls.filter(function(c){ return c.table === 'invoices' && c.op === 'update' && c.row && ('linked_inv_id' in c.row); });
  assertEqual(pass2UpdateCalls.length, 2, 'exactly 2 CNs (the resolvable ones) had their linked_inv_id pushed — the dangling one was not');
  var pushedIds = pass2UpdateCalls.map(function(c){ return c.row.linked_inv_id; });
  assert(pushedIds.indexOf(byOldNum['INV10001']) > -1, 'CN10001 (appears after its invoice) resolved to INV10001\'s real new id');
  assert(pushedIds.indexOf(byOldNum['INV10002']) > -1, 'CN10002 (appears before its invoice) also resolved correctly, regardless of insertion order');

  ctx.refreshInvFromSupabase = origRefresh;
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — a CN whose linkedInvId points at another CN (not a true Invoice) is still resolved correctly by the type-agnostic remap (AC-4a)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'cnA', num: 'CN20001', type: 'credit_note', lineItems: [], status: 'Draft' });
  ctx.DB.inv.push({ id: 'cnB', num: 'CN20002', type: 'credit_note', linkedInvNum: 'CN20001', linkedInvId: 'cnA', lineItems: [], status: 'Draft' });
  var byOldNum = {};
  var sb = mockSb({
    buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ var id = 'uuid-' + row.num; byOldNum[row.num] = id; return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-inv-restore-btn');
  var origRefresh = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.migrateInvToSupabase();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update' && c.row && ('linked_inv_id' in c.row); });
  assert(upd, 'CN20002\'s linked_inv_id was pushed');
  assertEqual(upd.row.linked_inv_id, byOldNum['CN20001'], 'CN20002 correctly resolves to CN20001\'s new id — another CN, not a true Invoice — via the type-agnostic invIdMap');
  ctx.refreshInvFromSupabase = origRefresh;
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — a Sheets-sync-originated CN with blank/absent linkedInvId but correct linkedInvNum is still resolved via the linkedInvNum-first fallback (AC-4b)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'inv9', num: 'INV19999', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Sent' });
  // simulates pullAll()'s mergePulledWithLocal() genuinely-new-record path (REQ-CLOUD-006 §1.6):
  // linkedInvId entirely absent as an own key, linkedInvNum correctly populated.
  ctx.DB.inv.push({ id: 'cn9', num: 'CN19999', type: 'credit_note', linkedInvNum: 'INV19999', lineItems: [], status: 'Draft' });
  var byOldNum = {};
  var sb = mockSb({
    buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ var id = 'uuid-' + row.num; byOldNum[row.num] = id; return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-inv-restore-btn');
  var origRefresh = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.migrateInvToSupabase();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update' && c.row && ('linked_inv_id' in c.row); });
  assert(upd, 'CN19999\'s linked_inv_id was pushed despite having no linkedInvId locally');
  assertEqual(upd.row.linked_inv_id, byOldNum['INV19999'], 'resolved via linkedInvNum, not silently left blank for lacking a resolvable linkedInvId');
  ctx.refreshInvFromSupabase = origRefresh;
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('saveInv — cloud-aware create/update when Invoice has migrated (insert with no client-generated id, id reassigned in place); local-only behavior unchanged when not migrated (AC-5)', async function() {
  resetDB();
  setupInvForm('INV30001');
  ctx.EI.i = null;
  // Fixed, spec-gate round 1 blocking finding 2: an earlier draft left cIL empty, but
  // vInv() blocks a NEW invoice save with no line items (and EI.i null, so it can't fall
  // back to an existing calc_grandTotal>0 record either) -- saveInv() never even reaches
  // this test's Cloud Data branch without at least one real line item, matching every
  // other creation-path test's own convention (e.g. tests/run.js:2146).
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Ocean Freight', qty:1, up:4600, unitCost:0 }];
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { insertImpl: function(row){ return Object.assign({ id: 'real-inv-uuid' }, row); }, selectData: [] } });
  ctx._sb = sb;
  var origRefresh = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.saveInv();
  var insertCall = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'insert'; });
  assert(insertCall, 'create routes through Supabase insert when Invoice has migrated');
  assert(!('id' in insertCall.row), 'no client-generated id sent on insert — Postgres assigns it');
  var savedInv = ctx.DB.inv.find(function(x){ return x.num === 'INV30001'; });
  assertEqual(savedInv.id, 'real-inv-uuid', 'inv.id reassigned to the real Postgres id in place');
  ctx.refreshInvFromSupabase = origRefresh;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  setupInvForm('INV30002');
  ctx.EI.i = null;
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Ocean Freight', qty:1, up:4600, unitCost:0 }];
  ctx._sb = null;
  await ctx.saveInv();
  assertEqual(ctx.DB.inv.length, 1, 'local-only path unaffected when Invoice has not migrated');
  assert(ctx.DB.inv[0].id !== 'real-inv-uuid', 'a plain client-generated id is used locally, not a Postgres one');
});

testAsync('saveCN — cloud-aware create/update when Invoice has migrated (insert with no client-generated id; a goodwill-credit payment references the REAL id, not the placeholder); local-only behavior unchanged when not migrated (AC-5)', async function() {
  resetDB();
  mockEl('cnf-n').value = 'CN30001'; mockEl('cnf-amount').value = '50'; mockEl('cnf-type').value = 'goodwill_credit';
  mockEl('cnf-b').value = 'Acme Buyer'; mockEl('cnf-cur').value = 'USD'; mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'Draft'; mockEl('cnf-reason').value = 'Damaged goods'; mockEl('cnf-nt').value = '';
  ctx.EI.cn = null;
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { insertImpl: function(row){ return Object.assign({ id: 'real-cn-uuid' }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveCN();
  var insertCall = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'insert'; });
  assert(insertCall, 'create routes through Supabase insert when Invoice has migrated');
  var goodwillPay = ctx.DB.payments.find(function(p){ return p.method === 'Goodwill Credit' && p.invNum === 'CN30001'; });
  assert(goodwillPay, 'goodwill payment ledger entry created');
  assertEqual(goodwillPay.invId, 'real-cn-uuid', 'goodwill payment references the REAL Postgres id, not the client-generated placeholder cn.id started with');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  mockEl('cnf-n').value = 'CN30002'; mockEl('cnf-amount').value = '50'; mockEl('cnf-type').value = 'credit_note';
  mockEl('cnf-b').value = 'Acme Buyer'; mockEl('cnf-cur').value = 'USD'; mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'Draft'; mockEl('cnf-reason').value = ''; mockEl('cnf-nt').value = ''; mockEl('cnf-linked').value = 'INV0001';
  ctx.EI.cn = null;
  ctx._sb = null;
  await ctx.saveCN();
  assertEqual(ctx.DB.inv.length, 1, 'local-only path unaffected when Invoice has not migrated');
});

testAsync('migrateInvToSupabase — sweeps PO.invId outward via invNum-first/invId-fallback and pushes each touched PO via persistPOChange; demonstrated for a PO whose invId/invNum disagree (PO-GAP-004 shape) (AC-6/AC-6a)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'inv-old-1', num: 'INV40001', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Sent' });
  // stale invId, correct invNum — PO-GAP-004's documented divergence shape
  ctx.DB.po.push({ id: 'po1', num: 'PO-0001', supId: 's1', invId: 'some-other-stale-id', invNum: 'INV40001', status: 'Draft', lineItems: [] });
  var sb = mockSb({
    buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] },
    purchase_orders: { selectData: [{ id: 'po1', num: 'PO-0001', sup_id: 's1', inv_id: 'some-other-stale-id', inv_num: 'INV40001', status: 'Draft', line_items: [] }] },
    invoices: { insertImpl: function(row){ return Object.assign({ id: 'new-inv-uuid' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-inv-restore-btn');
  var origRefreshInv = ctx.refreshInvFromSupabase; ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };
  await ctx.migrateInvToSupabase();
  var poUpdateCall = sb._calls.find(function(c){ return c.table === 'purchase_orders' && c.op === 'update'; });
  assert(poUpdateCall, 'the PO was pushed to Supabase via persistPOChange');
  assertEqual(poUpdateCall.row.inv_id, 'new-inv-uuid', 'PO\'s stale invId corrected via the invNum match, not silently skipped for having a stale invId');
  ctx.refreshInvFromSupabase = origRefreshInv;
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('migrateInvToSupabase — sweeps DB.payments[].invId locally via invNum-first/invId-fallback, including a self-referencing goodwill-credit entry and a Sheets-sync payment with blank invId but correct invNum (AC-7/AC-7a)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_qt_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  ctx.DB.inv.push({ id: 'inv-a', num: 'INV50001', type: 'invoice', buyerId: '', lineItems: [], pos: [], status: 'Sent' });
  ctx.DB.inv.push({ id: 'gw-b', num: 'CN50002', type: 'goodwill_credit', lineItems: [], status: 'Draft', cnAmount: -30 });
  ctx.DB.payments.push({ id: 'pm1', invId: 'inv-a', invNum: 'INV50001', amount: 100, method: 'Bank Transfer', date: '2026-01-01' });
  // self-referencing goodwill-credit payment: invId === the credit's OWN old DB.inv id
  ctx.DB.payments.push({ id: 'pm2', invId: 'gw-b', invNum: 'CN50002', amount: 30, method: 'Goodwill Credit', date: '2026-01-01' });
  // Sheets-sync-originated payment: blank invId, correct invNum (pullAll()'s genuinely-new-record path)
  ctx.DB.payments.push({ id: 'pm3', invId: '', invNum: 'INV50001', amount: 50, method: 'Bank Transfer', date: '2026-01-02' });

  var byOldNum = {};
  var sb = mockSb({
    buyers: { selectData: [] }, line_items: { selectData: [] }, quotes: { selectData: [] }, purchase_orders: { selectData: [] },
    invoices: { insertImpl: function(row){ var id = 'uuid-' + row.num; byOldNum[row.num] = id; return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-inv-restore-btn');
  var origRefresh = ctx.refreshInvFromSupabase;
  ctx.refreshInvFromSupabase = function(){ return Promise.resolve(); };

  await ctx.migrateInvToSupabase();

  assertEqual(ctx.DB.payments.find(function(p){return p.id==='pm1';}).invId, byOldNum['INV50001'], 'ordinary payment invId rewritten to the new Supabase invoice id');
  assertEqual(ctx.DB.payments.find(function(p){return p.id==='pm2';}).invId, byOldNum['CN50002'], 'self-referencing goodwill-credit payment invId rewritten to the credit\'s OWN new Supabase id, not skipped for lacking a cross-reference shape');
  assertEqual(ctx.DB.payments.find(function(p){return p.id==='pm3';}).invId, byOldNum['INV50001'], 'a payment with blank invId but correct invNum is still resolved via the invNum-first fallback, not skipped for lacking a resolvable invId');

  ctx.refreshInvFromSupabase = origRefresh;
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts'); ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_qt_cloud_migration_ts'); ctx.localStorage.removeItem('st_po_cloud_migration_ts');
});

testAsync('saveInvApprove — pushes the approved invoice via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #1)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv1', num: 'INV60001', status: 'Sent', lineItems: [] });
  ctx._apprInvId = 'inv1';
  mockEl('ia-method').value = 'Bank Transfer'; mockEl('ia-by').value = 'Jane'; mockEl('ia-note').value = '';
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveInvApprove();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'approval pushed to Supabase via persistInvChange');
  assertEqual(upd.row.buyer_approved_by, 'Jane', 'approval fields included in the pushed row');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.inv.push({ id: 'inv2', num: 'INV60002', status: 'Sent', lineItems: [] });
  ctx._apprInvId = 'inv2';
  mockEl('ia-method').value = 'Bank Transfer'; mockEl('ia-by').value = 'Jane'; mockEl('ia-note').value = '';
  ctx._sb = null;
  await ctx.saveInvApprove();
  assertEqual(ctx.DB.inv[0].buyerApprovedBy, 'Jane', 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('saveInvProgress — pushes the progressed invoice via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #2)', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', client: 'Acme', status: 'Accepted', lines: [] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV61001', status: 'Draft', lineItems: [] });
  ctx._progInvId = 'inv1';
  mockEl('ip-qt').value = 'q1';
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveInvProgress();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'progress-to-invoicing pushed to Supabase via persistInvChange');
  assertEqual(upd.row.linked_quote_id, 'q1', 'linkedQuoteId included in the pushed row');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.qt.push({ id: 'q2', num: 'QTE-0002', client: 'Acme', status: 'Accepted', lines: [] });
  ctx.DB.inv.push({ id: 'inv2', num: 'INV61002', status: 'Draft', lineItems: [] });
  ctx._progInvId = 'inv2';
  mockEl('ip-qt').value = 'q2';
  ctx._sb = null;
  await ctx.saveInvProgress();
  assertEqual(ctx.DB.inv[0].linkedQuoteId, 'q2', 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('autoPos — pushes the invoice\'s new pos[] via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #3)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.li.push({ id: 'li1', desc: 'Widget', uom: 'pcs', supId: 's1', cost: 5, price: 10, priceHistory: [] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV62001', status: 'Draft', pos: [], lineItems: [{ rid: 'r1', lid: 'li1', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  // Fixed, spec-gate round 1 blocking finding 3: an earlier draft set only Invoice's own
  // migration marker, but autoPos()'s PO-creation branch (shipped by REQ-CLOUD-005,
  // unmodified here) is gated on PO's OWN st_po_cloud_migration_ts marker, not Invoice's
  // -- without it, autoPos() creates the auto-generated PO locally via uid(), and pos[]
  // ends up containing a random local id instead of the asserted 'new-po-uuid'.
  ctx.localStorage.setItem('st_po_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  await ctx.autoPos(ctx.DB.inv[0]);
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'invoice pos[] pushed to Supabase via persistInvChange');
  assertEqual(JSON.stringify(upd.row.pos), JSON.stringify(['new-po-uuid']), 'pos[] contains the real Supabase PO id');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');

  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.li.push({ id: 'li1', desc: 'Widget', uom: 'pcs', supId: 's1', cost: 5, price: 10, priceHistory: [] });
  ctx.DB.inv.push({ id: 'inv2', num: 'INV62002', status: 'Draft', pos: [], lineItems: [{ rid: 'r1', lid: 'li1', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }] });
  ctx._sb = null;
  await ctx.autoPos(ctx.DB.inv[0]);
  assertEqual(ctx.DB.inv[0].pos.length, 1, 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('savePayment — pushes the invoice\'s updated dep/status via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #4)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv1', num: 'INV63001', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 100 }], calc_grandTotal: '100' });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.savePayment({ id: 'pm1', invId: 'inv1', invNum: 'INV63001', amount: 100, date: '2026-01-01', method: 'Bank Transfer' });
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'invoice dep/status pushed to Supabase via persistInvChange');
  assertEqual(upd.row.status, 'Paid', 'auto-status included in the pushed row');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.inv.push({ id: 'inv2', num: 'INV63002', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 100 }], calc_grandTotal: '100' });
  ctx._sb = null;
  await ctx.savePayment({ id: 'pm2', invId: 'inv2', invNum: 'INV63002', amount: 100, date: '2026-01-01', method: 'Bank Transfer' });
  assertEqual(ctx.DB.inv[0].status, 'Paid', 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('deletePayment — pushes the invoice\'s recalculated dep via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #5)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv1', num: 'INV64001', status: 'Paid', dep: 100, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm1', invId: 'inv1', invNum: 'INV64001', amount: 100, method: 'Bank Transfer', date: '2026-01-01' });
  ctx.confirm = function(){ return true; };
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.deletePayment('pm1');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'invoice dep recalculation pushed to Supabase via persistInvChange');
  assertEqual(upd.row.dep, 0, 'dep recalculated to 0 after the payment was deleted');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.inv.push({ id: 'inv2', num: 'INV64002', status: 'Paid', dep: 100, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm2', invId: 'inv2', invNum: 'INV64002', amount: 100, method: 'Bank Transfer', date: '2026-01-01' });
  ctx._sb = null;
  await ctx.deletePayment('pm2');
  assertEqual(ctx.DB.inv[0].dep, 0, 'local-only behavior unchanged when Invoice has not migrated');
  ctx.confirm = function(){ return false; };
});

testAsync('advMergeBuyers — pushes every reassigned invoice via persistInvChange (looped, skipRefresh) plus one trailing refresh, when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #6)', async function() {
  resetDB();
  ctx.DB.buy.push({ id: 'b1', name: 'Old Buyer Ltd' });
  ctx.DB.buy.push({ id: 'b2', name: 'New Buyer Ltd' });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV65001', buyer: 'Old Buyer Ltd', buyerId: 'b1', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv2', num: 'INV65002', buyer: 'Old Buyer Ltd', buyerId: 'b1', lineItems: [] });
  mockEl('adv-merge-from').value = 'Old Buyer Ltd'; mockEl('adv-merge-to').value = 'New Buyer Ltd'; mockEl('adv-merge-confirm').value = 'CONFIRM';
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  var origRefresh = ctx.refreshInvFromSupabase, refreshCalled = 0;
  ctx.refreshInvFromSupabase = function(){ refreshCalled++; return Promise.resolve(); };
  await ctx.advMergeBuyers();
  var updates = sb._calls.filter(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assertEqual(updates.length, 2, 'both reassigned invoices pushed to Supabase');
  assertEqual(refreshCalled, 1, 'exactly one trailing refresh, not one per invoice');
  ctx.refreshInvFromSupabase = origRefresh;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.buy.push({ id: 'b1', name: 'Old Buyer Ltd' });
  ctx.DB.buy.push({ id: 'b2', name: 'New Buyer Ltd' });
  ctx.DB.inv.push({ id: 'inv3', num: 'INV65003', buyer: 'Old Buyer Ltd', buyerId: 'b1', lineItems: [] });
  mockEl('adv-merge-from').value = 'Old Buyer Ltd'; mockEl('adv-merge-to').value = 'New Buyer Ltd'; mockEl('adv-merge-confirm').value = 'CONFIRM';
  ctx._sb = null;
  await ctx.advMergeBuyers();
  assertEqual(ctx.DB.inv[0].buyerId, 'b2', 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('delPO — pushes each Invoice whose pos[] just lost the deleted PO\'s id via persistInvChange when Invoice has migrated; local-only behavior unchanged when not migrated (AC-8, call site #7)', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'po1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV66001', pos: ['po1'], lineItems: [] });
  ctx.confirm = function(){ return true; };
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx.localStorage.removeItem('st_po_cloud_migration_ts');
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.delPO('po1');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'invoice pos[] pushed to Supabase via persistInvChange');
  assertEqual(JSON.stringify(upd.row.pos), JSON.stringify([]), 'the deleted PO id removed from pos[]');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.po.push({ id: 'po2', num: 'PO-0002', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv2', num: 'INV66002', pos: ['po2'], lineItems: [] });
  ctx._sb = null;
  await ctx.delPO('po2');
  assertEqual(ctx.DB.inv[0].pos.length, 0, 'local-only behavior unchanged when Invoice has not migrated');
  ctx.confirm = function(){ return false; };
});

testAsync('backfillInvoicePOs — pushes each CHANGED invoice via persistInvChange when Invoice has migrated; the existing unconditional saveAll() local persistence is unaffected when not migrated (AC-8, call site #8)', async function() {
  resetDB();
  ctx.DB.po.push({ id: 'po1', num: 'PO-0001', supId: 's1', invNum: 'INV67001', invId: '', status: 'Draft', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv1', num: 'INV67001', pos: [], lineItems: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.backfillInvoicePOs();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the changed invoice was pushed to Supabase via persistInvChange');
  assertEqual(JSON.stringify(upd.row.pos), JSON.stringify(['po1']), 'pos[] rebuilt to include the matching PO');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.po.push({ id: 'po2', num: 'PO-0002', supId: 's1', invNum: 'INV67002', invId: '', status: 'Draft', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv2', num: 'INV67002', pos: [], lineItems: [] });
  ctx._sb = null;
  await ctx.backfillInvoicePOs();
  assertEqual(ctx.DB.inv[0].pos.length, 1, 'local saveAll() persistence unaffected when Invoice has not migrated');
});

testAsync('saveCN — pushes the DIFFERENT, side-mutated linked invoice\'s recalculated calc_balanceDue via persistInvChange when Invoice has migrated, distinct from saveCN\'s own create-or-update branch; local-only behavior unchanged when not migrated (AC-8, call site #9)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv1', num: 'INV68001', status: 'Sent', calc_grandTotal: '100', lineItems: [] });
  mockEl('cnf-n').value = 'CN68001'; mockEl('cnf-amount').value = '20'; mockEl('cnf-type').value = 'credit_note';
  mockEl('cnf-b').value = 'Acme Buyer'; mockEl('cnf-cur').value = 'USD'; mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'CN Applied'; mockEl('cnf-reason').value = ''; mockEl('cnf-nt').value = ''; mockEl('cnf-linked').value = 'INV68001';
  ctx.EI.cn = null;
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({ invoices: { insertImpl: function(row){ return Object.assign({ id: 'real-cn-uuid' }, row); }, updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] } });
  ctx._sb = sb;
  await ctx.saveCN();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the side-mutated linked invoice was pushed via persistInvChange');
  assertEqual(upd.row.calc_balance_due, '80.00', 'the recalculated calc_balanceDue was included in the pushed row');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');

  resetDB();
  ctx.DB.inv.push({ id: 'inv2', num: 'INV68002', status: 'Sent', calc_grandTotal: '100', lineItems: [] });
  mockEl('cnf-n').value = 'CN68002'; mockEl('cnf-amount').value = '20'; mockEl('cnf-type').value = 'credit_note';
  mockEl('cnf-b').value = 'Acme Buyer'; mockEl('cnf-cur').value = 'USD'; mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'CN Applied'; mockEl('cnf-reason').value = ''; mockEl('cnf-nt').value = ''; mockEl('cnf-linked').value = 'INV68002';
  ctx.EI.cn = null;
  ctx._sb = null;
  await ctx.saveCN();
  assertEqual(ctx.DB.inv[0].calc_balanceDue, '80.00', 'local-only behavior unchanged when Invoice has not migrated');
});

testAsync('migrateSuppliersBuyersToSupabase — now also rewrites Invoice.buyerId, and pushes to Supabase if Invoice has already migrated (AC-8, call site #10)', async function() {
  resetDB();
  ctx.DB.buy.push({ id: 'bu1', num: 'BUY-0001', name: 'Acme Buyer' });
  ctx.DB.inv.push({ id: 'inv-uuid-1', num: 'INV69001', buyerId: 'bu1', lineItems: [], pos: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    buyers: { insertImpl: function(row){ return Object.assign({ id: 'new-buy-uuid' }, row); } },
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'inv-uuid-1', num: 'INV69001', type: 'invoice', buyer_id: 'new-buy-uuid', status: 'Draft', line_items: [], pos: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');
  await ctx.migrateSuppliersBuyersToSupabase();
  assertEqual(ctx.DB.inv[0].buyerId, 'new-buy-uuid', 'Invoice buyerId remapped locally');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the rewritten Invoice was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migrateLineItemsToSupabase — now also rewrites Invoice.lineItems[].lid, and pushes to Supabase if Invoice has already migrated (AC-8, call site #11)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.li.push({ id: 'li1', num: 'LI-0001', sku: 'W1', desc: 'Widget', supId: 's1', uom: 'pcs', cost: 5, price: 10, priceHistory: [] });
  ctx.DB.inv.push({ id: 'inv-uuid-2', num: 'INV70001', lineItems: [{ rid: 'r1', lid: 'li1', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1', name: 'ACME' }] },
    line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } },
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'inv-uuid-2', num: 'INV70001', type: 'invoice', line_items: [{ rid: 'r1', lid: 'new-li-uuid', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-li-restore-btn');
  await ctx.migrateLineItemsToSupabase();
  assertEqual(ctx.DB.inv[0].lineItems[0].lid, 'new-li-uuid', 'Invoice lineItems[].lid remapped locally');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the rewritten Invoice was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migrateQteToSupabase — now also rewrites Invoice.linkedQuoteId, and pushes to Supabase if Invoice has already migrated — corrects the now-stale "Invoice has no Supabase table" comment (AC-8, call site #12)', async function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QTE-0001', client: 'Acme', status: 'Accepted', lines: [] });
  ctx.DB.inv.push({ id: 'inv-uuid-3', num: 'INV71001', linkedQuoteId: 'q1', lineItems: [], pos: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    quotes: { insertImpl: function(row){ return Object.assign({ id: 'new-qte-uuid' }, row); } },
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'inv-uuid-3', num: 'INV71001', type: 'invoice', linked_quote_id: 'new-qte-uuid', line_items: [], pos: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-qt-restore-btn');
  await ctx.migrateQteToSupabase();
  assertEqual(ctx.DB.inv[0].linkedQuoteId, 'new-qte-uuid', 'Invoice linkedQuoteId remapped locally');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the rewritten Invoice was pushed to Supabase, not just fixed locally, now that Invoice has its own table');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migratePOToSupabase — now also pushes a touched Invoice.pos[] to Supabase if Invoice has already migrated (AC-8, call site #13)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.po.push({ id: 'po1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  ctx.DB.inv.push({ id: 'inv-uuid-4', num: 'INV72001', pos: ['po1'], lineItems: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1', name: 'ACME' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); } },
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'inv-uuid-4', num: 'INV72001', type: 'invoice', pos: ['new-po-uuid'], line_items: [] }] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-po-restore-btn');
  await ctx.migratePOToSupabase();
  assertEqual(JSON.stringify(ctx.DB.inv[0].pos), JSON.stringify(['new-po-uuid']), 'Invoice.pos[] element remapped locally');
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(upd, 'the rewritten Invoice was pushed to Supabase, not just fixed locally');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

testAsync('migratePOToSupabase — does NOT push an Invoice whose pos[] resolves to the identical id set (no actual change), even though Invoice has migrated (§2.17 change-detection guard)', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'ACME' });
  ctx.DB.po.push({ id: 'po1', num: 'PO-0001', supId: 's1', status: 'Draft', lineItems: [] });
  // an Invoice referencing a PO NOT in THIS migration batch — poIdMap[pid] is undefined,
  // so .map(pid => poIdMap[pid]||pid) returns an array identical to the original.
  ctx.DB.inv.push({ id: 'inv-uuid-5', num: 'INV72002', pos: ['already-migrated-po-id'], lineItems: [] });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  var sb = mockSb({
    suppliers: { selectData: [{ id: 's1', name: 'ACME' }] },
    purchase_orders: { insertImpl: function(row){ return Object.assign({ id: 'new-po-uuid' }, row); } },
    invoices: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-po-restore-btn');
  await ctx.migratePOToSupabase();
  var upd = sb._calls.find(function(c){ return c.table === 'invoices' && c.op === 'update'; });
  assert(!upd, 'no Supabase push for an invoice whose pos[] did not actually change — the JSON.stringify change-detection guard works');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
});

test('unlockInv/canTransitionStatus — confirmed to need no Cloud-Data-specific handling: unlockInv() only mutates in-memory _unlockedInvIds/_invEditSnapshot, never DB.inv directly, regardless of _sb/migration state (AC-9)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv1', num: 'INV73001', status: 'Paid', lineItems: [], calc_grandTotal: '100', dep: '100', taxRate: '0', lf: '0' });
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({});
  mockEl('adv-unlock-num').value = 'INV73001';
  mockEl('adv-unlock-reason').value = 'Correcting a typo';
  mockEl('adv-unlock-confirm').value = 'CONFIRM';
  var before = JSON.stringify(ctx.DB.inv);
  ctx.unlockInv();
  assertEqual(JSON.stringify(ctx.DB.inv), before, 'unlockInv() never mutates DB.inv directly, Cloud-configured or not');
  assert(ctx._unlockedInvIds['inv1'], '_unlockedInvIds is purely session-only in-memory state');
  assert(typeof ctx.canTransitionStatus('Draft', 'Sent') === 'boolean', 'canTransitionStatus() is a pure function with no Cloud Data dependency');
  ctx._sb = null;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx._invEditSnapshot = null;
  delete ctx._unlockedInvIds['inv1'];
});

testAsync('pullAll — drops both \'inv\' and \'cn\' from the batched pull_all request once the shared Invoice/CN Cloud Data migration marker is set (AC-10)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx._sb = mockSb({});

  _fetchCallLog = [];
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('inv') >= 0, 'inv still requested — the shared migration marker is not set yet');
  assert(_fetchCallLog[0].entities.indexOf('cn') >= 0, 'cn still requested — same reason');

  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('inv'), -1, 'inv excluded from the batched request once the shared marker is set');
  assertEqual(_fetchCallLog[0].entities.indexOf('cn'), -1, 'cn excluded too — one shared marker, both entities');

  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.SS.url = '';
  ctx._sb = null;
});

test('processImportRecords() — CSV import for entity "inv" remains local-only, unaffected by Invoice Cloud Data migration state (REQ-CLOUD-006l, AC-12)', function() {
  resetDB();
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({});
  ctx.processImportRecords('inv', [{ 'Invoice #': 'INV74001', 'Buyer': 'Acme' }], function(){});
  assert(ctx.DB.inv.some(function(x){ return x.num === 'INV74001'; }), 'CSV-imported invoice still lands in local DB.inv exactly as before, migrated or not');
  assert(!ctx._sb._calls.some(function(c){ return c.table === 'invoices'; }), 'no Supabase call attempted — CSV import bypasses Cloud Data entirely, matching today\'s exact behavior');
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx._sb = null;
});

test('cleanupExpiredMigrationArchive — Invoice/Credit Note archive expires independently of every other entity', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_inv_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_inv_pre_migration'), null, 'expired Invoice/Credit Note archive removed at day 31');
});

test('restoreInvMigrationArchive — restores K.i and clears SS.supabaseUrl/supabaseAnonKey and its own marker', function() {
  resetDB();
  ctx.localStorage.setItem('st_inv_pre_migration', JSON.stringify([{ id: 'orig-inv', num: 'INV76001' }]));
  ctx.localStorage.setItem('st_inv_cloud_migration_ts', new Date().toISOString());
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreInvMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.i))[0].id, 'orig-inv', 'K.i restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');
  assertEqual(ctx.localStorage.getItem('st_inv_cloud_migration_ts'), null, 'own marker cleared on restore');
  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('SPEC-CLOUD-006 test-hygiene cleanup — reset _sb and every Invoice/Credit Note Cloud Data migration marker this block may have left set, so later unrelated tests are not affected', async function() {
  ctx._sb = null;
  ctx.localStorage.removeItem('st_inv_cloud_migration_ts');
  ctx.localStorage.removeItem('st_inv_pre_migration');
});
```

### 3.2 AC-13 audit — full pre-existing-test-suite trace

Every direct pre-existing test-suite call site of a function this REQ touches was traced against the diffs in §2:

- **`saveInv()`** — every pre-existing test calling `ctx.saveInv()` directly (the `invoiceRefs`/G-05/G-06/`INTEG-001`/`INTEG-002` blocks' own tests, none exhaustively re-listed here) leaves `ctx._sb` unset (`null`) at the point it calls `saveInv()`, per this codebase's existing `resetDB()`/test-isolation convention (`_sb` is reset to `null` between tests unless a test explicitly sets it) — so every one of them exercises exactly the local-only branch this SPEC's §2.6 diff leaves behavior-identical to today. None needs updating.
- **`saveCN()`** — same reasoning; no pre-existing test sets `_sb` before calling `saveCN()`.
- **`delInv()`**, **`savePayment()`**, **`deletePayment()`**, **`advMergeBuyers()`** (no pre-existing tests — new in this SPEC, per the grep in §0.3/§2.14), **`delPO()`**, **`backfillInvoicePOs()`**, **`migrateSuppliersBuyersToSupabase()`**, **`migrateLineItemsToSupabase()`**, **`migrateQteToSupabase()`**, **`migratePOToSupabase()`** — every pre-existing test calling each of these directly was checked the same way: none sets `st_inv_cloud_migration_ts`, so every one of them exercises the unchanged local-only/no-Invoice-retrofit path this SPEC's diffs leave behavior-identical to today.
- **`pullAll()`** — every pre-existing test exercising `pullAll()`'s Invoice/CN blocks leaves `st_inv_cloud_migration_ts` unset, so the new exclusion guard (§2.18) never activates for them; behavior is unchanged.
- **`initCloudDataLayer()`** — the three pre-existing tests retrofitted in §3.0 are the only ones this REQ's new `refreshInvFromSupabase()` wiring could otherwise silently break; both are now stubbed correctly.
- **`processImportRecords()`/`processImport()`** — per AC-12, both `'inv'` branches are unchanged code; every pre-existing test exercising either (including the CSV-import regression-guard test at `tests/run.js:10754-10764`) needs no update.

No pre-existing test was found to need a fix beyond the three explicit retrofits in §3.0.

---

## 4. Doc-file diffs (REQ-CLOUD-006 §7 ship-time checklist)

### 4.1 `docs/known-gaps.md` — new `INV-GAP-002`, new `CN-GAP-001`, broadened `CLOUD-GAP-003`

**New `INV-GAP-002`**, inserted immediately after `INV-GAP-001` closes (`docs/known-gaps.md:117`), before the `## Quote Engine` section header:

```markdown
### INV-GAP-002 — `delInv()` leaves dangling references on delete; Credit Note create/edit is never logged *(Open, accepted)*
**Area:** `delInv()` (`index.html:8230-8244`); `saveCN()`/`saveInv()`'s CN sub-mode (no `logEv()` call on CN create or edit, unlike Invoice's own G-05 lifecycle logging).
**Logged:** REQ-CLOUD-006 (2026-09), found during check-first for extending Cloud Data to Invoice and Credit Note.
**Detail:** Four related, pre-existing gaps, none created by this REQ:
1. `delInv()` never cleans a deleted invoice's id out of `PO.invId`/`PO.invNum`, out of other Credit Notes' `linkedInvId`, or out of `DB.payments[].invId` — all three are left dangling, pointing at an id that no longer resolves to any record.
2. `saveCN()` and `saveInv()`'s CN sub-mode never call `logEv()` on Credit Note create or edit — a CN's Activity tab shows no create/edit history at all, unlike an ordinary Invoice's G-05 lifecycle log.
3. `delInv()` mislabels a Credit Note deletion as `"Invoice ... deleted"` in the event log (`index.html:8242`, unconditional — never checks `_isCnDel` for the log message text, even though it correctly routes the Sheets delete call via `_isCnDel ? 'cn' : 'inv'` two lines later).
**Decision:** Not fixed — `delPO()`'s equivalent `PO-GAP-007` cleanup was folded into `REQ-CLOUD-005f` as a single-array-element case; this gap touches three separate reference kinds (a scalar PO field pair, another CN's `linkedInvId`, and a payments-ledger array), each needing its own cleanup design, large enough to warrant its own future REQ rather than folding into a Cloud Data migration REQ. Not worsened by REQ-CLOUD-006 — Cloud Data migration only remaps ids that already exist; it does not change what `delInv()` cleans up afterward.
```

**New `CN-GAP-001`**, in a new `## Credit Notes` section inserted immediately after the `## Invoices` section closes (`docs/known-gaps.md:118`), before `## Quote Engine`:

```markdown
## Credit Notes

### CN-GAP-001 — `saveCN()`'s dedicated modal enforces no Credit Note number format, unlike `saveInv()`'s CN sub-mode *(Open, accepted)*
**Area:** `vCN()` (`index.html:9985-9997`) vs. `vInv()`'s `RX.invNum` check (`index.html:8969`).
**Logged:** REQ-CLOUD-006 (2026-09), found during check-first — two independent creation paths for Credit Notes produce materially different record shapes (see `docs/architecture-data-model-v1.md` §6.6 for the related Sheets-sync/logging findings).
**Detail:** A Credit Note can be created two ways: typing a `CN####...`-prefixed number inside the ordinary Invoice modal (format-checked via `vInv()`'s `RX.invNum` regex), or via the dedicated `saveCN()`/`ov-cn` modal, whose own `vCN()` validator checks only that a number is non-empty — no format regex at all. A Credit Note created through the dedicated modal can therefore carry a number that would never pass validation through the Invoice-modal path.
**Decision:** Not fixed — a pre-existing validation asymmetry between the two CN creation paths, unrelated to Cloud Data. Neither path is blocked by, nor blocks, this REQ's migration (`migrateInvToSupabase()`'s own duplicate-`num` pre-flight scan, REQ-CLOUD-006c, catches a collision either path could produce, regardless of format). Logged for visibility; revisit if the two creation paths are ever unified.

---
```

**`CLOUD-GAP-003`** (`docs/known-gaps.md:643-647`) — broadened to cover four entity families, not three, and to close the "committed to log, never logged" gap this REQ's own drafting process found for Purchase Order (`docs/REQ-CLOUD-006-v1.md` §2 REQ-CLOUD-006l, §8):

Current:

```markdown
### CLOUD-GAP-003 — `processImport()`'s CSV import branches bypass Cloud Data for Supplier, Line Item, and Contact *(Open, accepted)*

**Area:** `processImport()`'s `'sup'`, `'li'`, `'co'`, and `'ord'`-Contact-creation CSV import branches.
**Logged:** v2.9.73 (REQ/SPEC-CLOUD-002, round-4 spec-gate finding).
**Detail:** These CSV import branches build `DB.sup`/`DB.li`/`DB.con` records directly and persist via a bare `sv(K.s,...)`/`sv(K.l,...)`/`sv(K.co,...)`, bypassing every `_sb` branch entirely — an imported record for a cloud-migrated entity is silently local-only until the next Cloud Data refresh discards it. This is the same class of gap as `CLOUD-GAP-001` but a genuinely different code path (`processImport()`'s CSV importer, not `expAll()`/`doImport()`'s full-JSON-backup restore) — not previously logged under any existing gap despite predating REQ-CLOUD-002 for the Supplier case. Not fixed here, since REQ-CLOUD-002 scoped its fixes to UI code paths that mutate already-migrated records (see the five sites plus `saveInv()` fixed in SPEC-CLOUD-002 §2.11/§2.12), not the CSV importer; candidate for a future standalone REQ alongside `CLOUD-GAP-001`/`CLOUD-GAP-002`.
```

New:

```markdown
### CLOUD-GAP-003 — `processImport()`'s CSV import branches bypass Cloud Data for Supplier, Line Item, Contact, Purchase Order, Invoice, and Credit Note *(Open, accepted)*

**Area:** `processImport()`'s/`processImportRecords()`'s `'sup'`, `'li'`, `'co'`, `'ord'`-Contact-creation, `'po'`, and `'inv'` (Invoice and Credit Note together — one CSV entity, per REQ-CLOUD-006 §0) CSV/Sheets-record import branches.
**Logged:** v2.9.73 (REQ/SPEC-CLOUD-002, round-4 spec-gate finding); broadened to Purchase Order and Invoice/Credit Note by REQ-CLOUD-006 (2026-09) — Purchase Order's own instance was committed to being logged here at REQ-CLOUD-005's ship time (`docs/REQ-CLOUD-005-v1.md` §3) but never actually was, a gap REQ-CLOUD-006's own drafting process found and closes here rather than compounding a third time.
**Detail:** These CSV/Sheets-record import branches build `DB.sup`/`DB.li`/`DB.con`/`DB.po`/`DB.inv` records directly and persist via a bare `sv(K.s,...)`/`sv(K.l,...)`/`sv(K.co,...)`/`sv(K.p,...)`/`sv(K.i,...)`, bypassing every `_sb` branch entirely — an imported record for a cloud-migrated entity is silently local-only until the next Cloud Data refresh discards it. This is the same class of gap as `CLOUD-GAP-001` but a genuinely different code path (the CSV/Sheets-record importer, not `expAll()`/`doImport()`'s full-JSON-backup restore). Not fixed for any of the six entity families — each entity's own REQ/SPEC in this series has scoped its fixes to UI code paths that mutate already-migrated records, not the CSV/Sheets-record importer; candidate for a future standalone REQ covering all six at once, alongside `CLOUD-GAP-001`/`CLOUD-GAP-002`.
```

### 4.2 `docs/architecture-data-model-v1.md` §6.6 correction (per REQ §1.1), plus the identical row-43 claim

**§6.6** (`docs/architecture-data-model-v1.md:177`):

Current:

```markdown
**6.6 Credit Notes: three distinct issues.** Zero `logEv()` on create/edit; deletions are mislabeled in the event log as "Invoice ... deleted"; live single-record Sheets sync targets the wrong entity (`inv` instead of `cn`) while bulk sync and delete both correctly use `cn`.
```

New:

```markdown
**6.6 Credit Notes: two distinct issues, not three (corrected by REQ-CLOUD-006 §1.1 — the third, a claimed "wrong Sheets tab" on live single-record sync, is not reproducible on current code).** Zero `logEv()` on create/edit; deletions are mislabeled in the event log as "Invoice ... deleted". `syncEnt(entity, rec)` (`index.html:4372-4377`) normalizes internally — `var ent = (entity === 'inv' && (rec.type === 'credit_note' || rec.type === 'goodwill_credit')) ? 'cn' : entity;` — so both `saveInv()`'s call (`syncEnt('inv',inv)`) and `saveCN()`'s call (`syncEnt('inv', cn)`) already resolve correctly regardless of the literal string passed, confirmed via `git blame` to predate this document's own original claim; `delInv()` also already routes delete correctly (`delEnt(_isCnDel ? 'cn' : 'inv', ...)`). Both remaining gaps are logged, not fixed, as `INV-GAP-002` (`docs/known-gaps.md`).
```

**Row 43** (`docs/architecture-data-model-v1.md:43`) carries the identical now-disproven claim in its "Sheets sync" cell:

Current:

```markdown
| Credit Note | inside `DB.inv`, `type` flag | free text, shares Invoice's number space | **✗ not covered** | ✓ (**wrong tab on live-save**) | out of scope | **✗ none** | ✓ |
```

New:

```markdown
| Credit Note | inside `DB.inv`, `type` flag | free text, shares Invoice's number space | **✗ not covered** | ✓ | out of scope | **✗ none** | ✓ |
```

**Judgment call, flagged for spec-gate:** the "Cloud Data (Supabase)" column for rows 40-43 (Quote/Purchase Order/Invoice/Credit Note) still reads "out of scope" even after Quote and Purchase Order actually shipped Cloud Data support (`REQ/SPEC-CLOUD-004`/`005`) — a pre-existing table-staleness issue this document was apparently never updated for at either of those ship times, unrelated to REQ-CLOUD-006's own §1.1 finding (which is specifically about the Sheets-sync-tab claim, not the Cloud Data column). This SPEC does **not** correct rows 40-42's "out of scope" cells (Quote/Purchase Order/Invoice) to reflect their now-true Cloud Data status, including for Invoice itself — REQ-CLOUD-006 §7's own ship-time checklist names only the §1.1 correction, not a general table-accuracy pass, and widening scope to fix three additional stale cells was judged out of proportion for a migration REQ's doc-diff obligation. Flagged explicitly rather than silently left inconsistent — spec-gate should confirm this narrow scoping is acceptable, or direct it be widened.

### 4.3 `docs/requirements-tracker.md` — new `REQ-CLOUD-006` row

Inserted as a new row immediately after the `REQ-CLOUD-005` row closes (`docs/requirements-tracker.md:39`), before the `REQ-LI-001` row:

```markdown
| REQ-CLOUD-006 | Extend Cloud Data (Supabase) to Invoice and Credit Note — Phase 3 sub-phase 1 of 3 of the cross-platform backend migration (`docs/architecture-data-model-v1.md` §8, point 5), following REQ-CLOUD-001-005's already-proven mechanism. Invoice and Credit Note go first within Phase 3 because they share one local array (`DB.inv`) and are the least entangled with `REQ-INTEG-002`'s in-flight Buyer Payment work; Shipment (sub-phase 2) and Buyer/Supplier Payment (sub-phase 3) remain deferred. The most demanding precondition in the series (four prerequisite entities — Buyer, Line Item, Quote, Purchase Order) and the first self-referential FK within a migrating table (a Credit Note's `linkedInvId` pointing at another row in the same batch). | REQ-CLOUD-006-v1.md | SPEC-CLOUD-006-v1.md | v2.9.78 (proposed) | 8 rounds. Round 1: 3 blocking (a false CSV-import precedent citation; an inconsistent 13-vs-8-site `persistInvChange()` call-site count; half of PO's real `pullAll()` exclusion mechanism cited) + 4 advisory, all fixed. Round 2: 1 blocking (round 1's own CSV-import fix replaced one false precedent with another — `CLOUD-GAP-003` doesn't actually cover Purchase Order) + 1 advisory, fixed; 1 candidate finding investigated and rejected. Round 3: re-raised the identical `pullAll()` citation dispute a third time, this time definitively resolving it — both prior rounds had been reading a stale, wrong-branch copy of `index.html`, not this REQ's own pinned worktree; triggered a full citation-accuracy pass correcting 44 further citation instances. Round 4: 1 blocking (goodwill-credit `DB.payments[]` entries are self-referencing, not cross-referencing, and needed explicit sweep coverage) + 1 advisory (a CN's `linkedInvId` can resolve to another CN), fixed. Round 5: 1 blocking (the outward sweep into Purchase Order left its `invId`/`invNum` matching algorithm unspecified — the identical `PO-GAP-004` divergence risk), fixed with `backfillInvoicePOs()`'s own precedence. Round 6: 1 blocking (the identical unaddressed matching ambiguity, one array over, for `DB.payments[].invId`), fixed with the same precedence. Round 7: 1 blocking (a third instance of the identical bug class, this time in the CN self-referential remap itself — `linkedInvNum`-first, `linkedInvId`-fallback), fixed. Round 8: **PASS**, clean — hunted for a 4th instance in the reverse direction (Invoice's own outward refs) and confirmed none exploitable; 30+ citations spot-checked, zero errors. | (pending — this SPEC's own independent spec-gate review has not yet run) | (pending implementation) | (pending) |
```

**Judgment call, flagged for spec-gate:** the `Version` column above is written as `v2.9.78 (proposed)` — this REQ series' convention (see the `REQ-CLOUD-005` row) is to record the version a REQ actually shipped under, normally filled in at build time once the real next-available version number is known. Since this SPEC is written before implementation, spec-gate review, or build, `v2.9.78` is this SPEC's own best-guess next-version number (the current `HEAD` is `v2.9.77` per `CLAUDE.md`/`STACKD_CONTEXT.md` at the time of drafting) rather than a confirmed fact — flagged so whoever ships this REQ corrects it if a different version has shipped in the meantime. Likewise the `Spec gate`/`Build`/`PR` columns are placeholders (`pending`), to be filled in as each stage actually completes, mirroring how `docs/requirements-tracker.md` itself already records `REQ-CLOUD-005`'s `PR` column as `(pending)` at a comparable stage of that REQ's own lifecycle.

### 4.4 `docs/version-history.md` / `STACKD_CONTEXT.md` / `CLAUDE.md` — version bump

**`docs/version-history.md`** — new row inserted at the top of the table (`docs/version-history.md:5`), above the existing `v2.9.77` row:

```markdown
| v2.9.78 | New: **Invoice and Credit Note join the Cloud Data layer** (REQ/SPEC-CLOUD-006, `docs/REQ-CLOUD-006-v1.md`/`docs/SPEC-CLOUD-006-v1.md`) — Phase 3 sub-phase 1 of 3 of the cross-platform backend migration, following Suppliers/Buyers, Line Item, Contact, Order Request, Quote, and Purchase Order (`REQ/SPEC-CLOUD-001` through `005`). `migrateInvToSupabase()` refuses to run unless Buyer, Line Item, Quote, and Purchase Order have each completed their own migration — the most demanding precondition in the series. A Credit Note is a `type` flag on the same `DB.inv` array, not a separate entity, migrating together with Invoice under one shared marker; its `linkedInvId` self-reference (the first self-referential FK within a migrating table in this series) is resolved via a two-pass insert, `linkedInvNum`-first. Thirteen call sites — the most of any entity so far — share a new `persistInvChange()` helper. Closes no open gaps outright, but logs two new ones found during research (`CN-GAP-001`, `INV-GAP-002`) and broadens `CLOUD-GAP-003` to cover Purchase Order's own CSV-import bypass, which `REQ-CLOUD-005` had committed to logging but never did. `[N]` new tests, `[TOTAL]/[TOTAL]` pass. |
```

**Judgment call, flagged for spec-gate:** the `[N]`/`[TOTAL]` placeholders are deliberate — this SPEC's own §3 test list totals 33 new tests (30 in §3.1 plus the 3 retrofits in §3.0, though the retrofits modify existing tests rather than adding new ones, so the actual net-new count is 30) against a baseline of 803/803 (`v2.9.77`), which would put the shipped total at **833/833** if implemented exactly as specified and no further tests are added during implementation/mutation-testing — but per this series' own consistent practice (see every prior `REQ-CLOUD-*` row in `docs/version-history.md`), the actual figure is filled in at ship time from the real, final `node tests/run.js` output, not computed in advance from a pre-implementation SPEC's own test count, since implementation-time mutation testing in this series has repeatedly added tests beyond the SPEC's own list (e.g., `REQ-CLOUD-003`'s two post-spec-gate regression tests). Left as an explicit placeholder rather than a possibly-wrong precomputed number.

**`STACKD_CONTEXT.md`** — two changes:

1. `Current state` table (`STACKD_CONTEXT.md:13-15`) — `Current version`/`Test count`/`Last updated` rows updated to `v2.9.78`/`833 / 833 passing (pending confirmation at ship time — see §4.4 judgment call)`/a new date and REQ-CLOUD-006 mention, mirroring exactly how the `REQ-CLOUD-005` line in this same table was worded at its own comparable pre-merge stage (`"REQ-CLOUD-005, built and tested on branch claude/cloud-005-purchase-order, PR pending at time of writing"`).
2. The long "Version history" narrative paragraph (`STACKD_CONTEXT.md:20`) — append, after the existing `v2.9.77 (REQ-LI-001 ...)` sentence closes:

```
 v2.9.78 (REQ-CLOUD-006 — extends the same Cloud Data layer to Invoice and Credit Note, Phase 3 sub-phase 1 of 3 of the cross-platform backend migration, with Shipment and Buyer/Supplier Payment deferred as later sub-phases; the most demanding precondition in the series (Buyer, Line Item, Quote, AND Purchase Order must all have completed their own migrations); the first self-referential FK within one migrating table (a Credit Note's linkedInvId pointing at another row in the same DB.inv batch), resolved via a two-pass insert; thirteen call sites — the most of any entity so far — share a new persistInvChange() helper; requirements-gate took 8 rounds, the longest in this series, three of them (rounds 5-7) each finding one more instance of the identical invId/invNum-divergence bug class in a different sweep (Purchase Order's outward link, the local Buyer Payment sweep, then the CN self-referential remap itself), the third instance found only because round 7 specifically hunted for a fourth instance of a pattern the first two rounds had already found twice; closes no open gaps outright but logs CN-GAP-001/INV-GAP-002 and broadens CLOUD-GAP-003 to finally cover Purchase Order's own CSV-import bypass, which REQ-CLOUD-005 had committed to logging but never did), shipped and merged via PR #[N].
```

**Judgment call, flagged for spec-gate:** `PR #[N]` is left as an explicit placeholder — no PR exists yet at SPEC-writing time.

**`CLAUDE.md`** — two changes:

1. Line 8 (the "What this project is" paragraph's Cloud Data entity list):

Current:

```markdown
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies (one acknowledged exception: `vendor/supabase-js-v2.min.js`, a vendored same-origin static file used for Supplier/Buyer, Line Item, Contact, Order Request, Quote, and Purchase Order when Cloud Data is configured — REQ/SPEC-CLOUD-001, extended to Line Item/Contact by REQ/SPEC-CLOUD-002, to Order Request by REQ/SPEC-CLOUD-003, to Quote by REQ/SPEC-CLOUD-004, and to Purchase Order by REQ/SPEC-CLOUD-005 — completing Phase 2 of the cross-platform backend migration; no CDN, no auto-update). Deployed via GitHub Pages.
```

New:

```markdown
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies (one acknowledged exception: `vendor/supabase-js-v2.min.js`, a vendored same-origin static file used for Supplier/Buyer, Line Item, Contact, Order Request, Quote, Purchase Order, Invoice, and Credit Note when Cloud Data is configured — REQ/SPEC-CLOUD-001, extended to Line Item/Contact by REQ/SPEC-CLOUD-002, to Order Request by REQ/SPEC-CLOUD-003, to Quote by REQ/SPEC-CLOUD-004, to Purchase Order by REQ/SPEC-CLOUD-005 (completing Phase 2), and to Invoice/Credit Note by REQ/SPEC-CLOUD-006 (Phase 3 sub-phase 1 of 3) — of the cross-platform backend migration; no CDN, no auto-update). Deployed via GitHub Pages.
```

2. Lines 10-11 (version/test-count banner):

Current:

```markdown
**Current version: v2.9.77**  
**Test count: 803/803 PASS** (`node tests/run.js`)
```

New:

```markdown
**Current version: v2.9.78**  
**Test count: 833/833 PASS** (`node tests/run.js`)
```

(Per §4.4's judgment call, `833` is this SPEC's own precomputed estimate — confirm against the real `node tests/run.js` output at ship time before committing this line.)

### 4.5 `docs/user-guide.md` — Settings → Cloud Data section updated

(`docs/user-guide.md:75-89`) Six edits to the one `## Cloud Data (...)` section, all within the existing paragraph structure — no new subsection needed, matching how Purchase Order's own addition (`REQ-CLOUD-005`) extended this same section rather than creating a new one.

**Edit 1 — section heading** (`docs/user-guide.md:75`):

Current:

```markdown
## Cloud Data (Supplier & Buyer, Line Item, Contact, Order Request, Quote, Purchase Order)
```

New:

```markdown
## Cloud Data (Supplier & Buyer, Line Item, Contact, Order Request, Quote, Purchase Order, Invoice & Credit Note)
```

**Edit 2 — intro paragraph, migrate-button list and "not yet eligible" clause** (`docs/user-guide.md:77`). Per-entity fixed in the same diff: this paragraph's migrate-button list never actually named Purchase Order at all despite Purchase Order having shipped Cloud Data support in `REQ-CLOUD-005` — a pre-existing doc-staleness gap this SPEC closes opportunistically while touching the identical sentence for Invoice/Credit Note, rather than leaving one freshly-noticed inaccuracy standing beside the one being fixed:

Current:

```markdown
By default, all your data lives only in your own browser. **Cloud Data** (Settings → Cloud Data) is an optional feature that connects a shared Supabase database, so a colleague on a different device or browser can see the exact same records as you. It is not a single on/off switch — Supplier & Buyer, Line Item, Contact, Order Request, Quote, and Purchase Order each migrate independently, on their own schedule, via their own "Migrate ... to Cloud" button in the same settings area (Purchase Order requires Suppliers to have migrated first, since every Purchase Order requires a Supplier link). Invoices, Shipments, Payments, and Credit Notes are not yet Cloud-Data-eligible and always stay local, regardless of what has migrated.
```

New:

```markdown
By default, all your data lives only in your own browser. **Cloud Data** (Settings → Cloud Data) is an optional feature that connects a shared Supabase database, so a colleague on a different device or browser can see the exact same records as you. It is not a single on/off switch — Supplier & Buyer, Line Item, Contact, Order Request, Quote, Purchase Order, and Invoice & Credit Note each migrate independently, on their own schedule, via their own "Migrate ... to Cloud" button in the same settings area (Purchase Order requires Suppliers to have migrated first, since every Purchase Order requires a Supplier link; Invoice/Credit Note requires Buyers, Line Items, Quotes, AND Purchase Orders to have all migrated first — the most demanding requirement of any entity, since an Invoice can reference all four). A Credit Note is not a separate migration step — it shares Invoice's own "Migrate Invoices & Credit Notes to Cloud" button and moves together with it. Shipments and Payments are not yet Cloud-Data-eligible and always stay local, regardless of what has migrated.
```

**Edit 3 — one-time migration action list** (`docs/user-guide.md:85`):

Current:

```markdown
Moving your **existing** local records into Cloud Data is a one-time, explicit action per entity ("Migrate Suppliers/Buyers to Cloud," "Migrate Line Items to Cloud," "Migrate Contacts to Cloud," "Migrate Order Requests to Cloud," "Migrate Quotes to Cloud" — each its own button, Settings → Cloud Data) that requires a full backup export first and automatically updates every reference to those records elsewhere in the app. It's safe to undo within 30 days via the matching "Restore Pre-Migration ..." button in the same settings card — restoring one entity disconnects Cloud Data entirely (you'll need to reconnect and re-migrate any other entity you want back in the cloud).
```

New:

```markdown
Moving your **existing** local records into Cloud Data is a one-time, explicit action per entity ("Migrate Suppliers/Buyers to Cloud," "Migrate Line Items to Cloud," "Migrate Contacts to Cloud," "Migrate Order Requests to Cloud," "Migrate Quotes to Cloud," "Migrate Purchase Orders to Cloud," "Migrate Invoices & Credit Notes to Cloud" — each its own button, Settings → Cloud Data) that requires a full backup export first and automatically updates every reference to those records elsewhere in the app. It's safe to undo within 30 days via the matching "Restore Pre-Migration ..." button in the same settings card — restoring one entity disconnects Cloud Data entirely (you'll need to reconnect and re-migrate any other entity you want back in the cloud).
```

**Edit 4 — precondition paragraph** (`docs/user-guide.md:87`):

Current:

```markdown
Line Item migration requires Suppliers to already be migrated first (every Line Item links to a Supplier). Contact migration requires Suppliers to already be migrated too, even for a Contact with no Supplier link. Order Request and Quote have no such requirement — each can migrate independently of Supplier or Contact (or of each other), at any time, since their Line/RFQ-Response data travels embedded with the parent record rather than needing a separate migration step of its own.
```

New:

```markdown
Line Item migration requires Suppliers to already be migrated first (every Line Item links to a Supplier). Contact migration requires Suppliers to already be migrated too, even for a Contact with no Supplier link. Order Request and Quote have no such requirement — each can migrate independently of Supplier or Contact (or of each other), at any time, since their Line/RFQ-Response data travels embedded with the parent record rather than needing a separate migration step of its own. Purchase Order requires Suppliers first. Invoice & Credit Note has the strictest requirement of all — it needs Buyers, Line Items, Quotes, and Purchase Orders to have *all four* already migrated, since a single Invoice can reference every one of them.
```

**Edit 5 — CSV-limitation bullet** (`docs/user-guide.md:89`), broadened for consistency with the newly-corrected `CLOUD-GAP-003` (§4.1) rather than leaving Purchase Order's identical, pre-existing gap undisclosed here while disclosing Invoice/Credit Note's:

Current:

```markdown
One current limitation: the legacy CSV upload and "Import from Google Sheets" paths for Supplier, Line Item, and Contact don't yet know about Cloud Data — avoid using those import methods for those three entities once Cloud Data is connected (adding a record through the normal form, or importing an Order Request CSV, is unaffected and works correctly).
```

New:

```markdown
One current limitation: the legacy CSV upload and "Import from Google Sheets" paths for Supplier, Line Item, Contact, Purchase Order, and Invoice/Credit Note don't yet know about Cloud Data — avoid using those import methods for those entities once Cloud Data is connected (adding a record through the normal form, or importing an Order Request CSV, is unaffected and works correctly).
```

**Judgment call, flagged for spec-gate:** Edit 2's "Purchase Order was never actually named in the migrate-button list" fix and Edit 5's "Purchase Order was never disclosed in the CSV-limitation bullet" fix are both pre-existing inaccuracies this SPEC noticed only because it was already editing the exact same sentences for Invoice/Credit Note's own sake — neither is named in REQ-CLOUD-006 §7's own ship-time checklist (which only commits to "Settings → Cloud Data section updated for the new Invoice/Credit Note card"). Both are corrected here rather than left standing beside a freshly-added, contradictory-in-spirit accuracy fix for Invoice/Credit Note, mirroring this REQ's own repeated practice elsewhere (e.g., `CLOUD-GAP-003`'s broadening, §4.1) of not compounding a known "should have been updated, wasn't" gap a further time when already touching the relevant text. Flagged explicitly since it is scope beyond the REQ's literal ship-time checklist wording.

---
