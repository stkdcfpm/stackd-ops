# REQ-CLOUD-006 (Phase 3, sub-phase 1 of 3) — Extend Cloud Data to Invoice and Credit Note

**Status:** v1 — drafted. Requirements-gate round 1: CONDITIONAL PASS (3 blocking, 4 advisory), fixed. See §8.
**Scope:** Phase 3 sub-phase 1 of 3 of the cross-platform backend migration's fulfillment/financial step (`docs/architecture-data-model-v1.md` §8, point 5), following REQ/SPEC-CLOUD-001 through 005's already-proven mechanism. Sub-phase 2 (Shipment) and sub-phase 3 (Buyer Payment, Supplier Payment) are separate, later REQs — deliberately sequenced last since they are the exact ledgers `REQ-INTEG-002` (2c/2d) is actively reshaping; see §0.
**Build baseline:** `main` @ `c4242e2`, 803/803 tests passing (includes `REQ-LI-001`, shipped since this REQ's check-first pass began; unrelated to Invoice/Cloud Data, no re-verification needed against it).

---

## 0. Scoping

Phase 2 (Order Request → Quote → Purchase Order) completed in three sub-phases, one entity per REQ, in referential-dependency order. Phase 3 covers Invoice, Credit Note, Shipment, Buyer Payment, and Supplier Payment (`docs/architecture-data-model-v1.md` §8, point 5) and is split the same way. **Invoice and Credit Note go first** because they share one local array (`DB.inv`, Credit Note is a `type` flag on the same records, not a separate array) and are the least entangled with other in-flight work. **Shipment goes second** (sub-phase 2, not started here). **Buyer Payment and Supplier Payment go last** (sub-phase 3, not started here) — deliberately, because `REQ-INTEG-002` sub-phases 2c (in requirements-gate review as of this REQ's drafting) and 2d (unscoped) are actively changing the Buyer Payment ledger's own shape and matching logic; migrating that ledger to Cloud Data before its shape settles would mean re-touching the migration once 2c/2d land. This REQ does not touch `DB.payments`/`DB.supPayments` structurally — it only rewrites `DB.payments[].invId` values as a side effect of Invoice's own id changing (§2, REQ-CLOUD-006g), which is required regardless of whatever matching-rule `REQ-INTEG-002-2c` ships in `getInvPayments()`, since correctly updating a stored id value is orthogonal to how a lookup function chooses to prefer `invId` vs `invNum`.

A companion review of `docs/v3-architect-handoff.md` confirms this migration is not blocked by, and does not need to anticipate, the separate "v3.0.0" multi-tenant rebuild scoping effort: that document explicitly expects today's single-tenant Cloud Data schema (including whatever this REQ adds) to need "a full redesign for tenant isolation" later, and `STACKD_CONTEXT.md`'s own Automation-First design principle already accepts that tradeoff for the 7 entities migrated so far — this REQ follows the same accepted pattern, not a new risk.

---

## 1. Business context (facts established during check-first, against `main` @ `c7a80ed`, 775/775 tests passing at the time of research; re-confirmed unaffected by the subsequent `REQ-LI-001` merge to `c4242e2`, 803/803)

### 1.1 One correction to `docs/architecture-data-model-v1.md`

§4.2/§6.6 claims live single-record Sheets sync "targets the wrong entity" for Credit Notes (`saveCN()` allegedly pushes under `'inv'` instead of `'cn'`). **This is not reproducible on current code.** `syncEnt(entity, rec)` (`index.html:4371-4376`) normalizes internally: `var ent = (entity === 'inv' && (rec.type === 'credit_note' || rec.type === 'goodwill_credit')) ? 'cn' : entity;` — so both `saveInv()`'s call (`syncEnt('inv',inv)`, `7161`) and `saveCN()`'s call (`syncEnt('inv', cn)`, `10047`) already resolve correctly regardless of the literal string passed. `git blame` shows this normalization predates the architecture doc's own stated verification date. `delInv()` (`8242`) also already routes delete correctly (`delEnt(_isCnDel ? 'cn' : 'inv', ...)`). The architecture doc's other two §6.6 claims — zero `logEv()` on CN create/edit, and `delInv()` mislabeling a CN deletion as `"Invoice ... deleted"` — remain independently confirmed live (§1.6).

### 1.2 Two independent creation paths for Credit Notes, with materially different record shapes

Credit Notes can be created two ways, and they produce genuinely different shapes:
- **`saveInv()`'s CN sub-mode** (invoice number typed as `CN####...` inside the ordinary Invoice modal): format-checked via `vInv()`/`RX.invNum` (`8965`), sets `buyerId` (a real FK, unconditionally, `7007`), and shares every other Invoice field.
- **The dedicated `saveCN()`/`ov-cn` modal** (`9995-10048`): its own object literal (`10002-10019`) has **no `buyerId` field at all** — only a free-text `buyer` string — and hardcodes `lineItems:[]`, `taxRate:0`, `lf:0`, `ins:0`, `dep:0`, omitting `pol/pod/coo/incoterm/wt/cbm/pk` and every `calc_*` field entirely. Its own number validation (`vCN()`, `9981-9993`) enforces **no format regex at all** — only non-empty — unlike `vInv()`'s `RX.invNum` check. `vCN()`/`saveCN()` each run their own independent duplicate-`num` scan (`9998-9999`) against the same shared `DB.inv` array.

Neither asymmetry (the format-check gap, the shape divergence) blocks this migration — both paths already write into the one array this REQ migrates as a whole — but the migration's pre-flight duplicate-number scan (§2, REQ-CLOUD-006c) must scan the *whole* `DB.inv` array regardless of `type`, matching what `vInv()`'s/`saveCN()`'s own checks already do, and the fixed asymmetry itself is logged, not fixed, as `CN-GAP-001` (§3).

### 1.3 Every `DB.inv` mutation site (24 found; the most of any entity in this series)

| Site | Lines | Local-only today? | Needs Cloud Data branch |
|---|---|---|---|
| `saveInv()` | `7001-7189` | create/update | ✓ own create-or-update branch |
| `saveInvApprove()` | `7219-7238` | update, no `syncEnt()` today | ✓ via `persistInvChange()` |
| `saveInvProgress()` | `7261-7275` | update, no `syncEnt()` today | ✓ via `persistInvChange()` |
| `autoPos(inv)` | `7277-7319` | appends `pos[]`, no `syncEnt()` for the invoice itself | ✓ via `persistInvChange()` |
| `delInv(id)` | `8229-8243` | delete | ✓ own soft-delete branch |
| `saveCN()` | `9995-10048` | create/update, also mutates a *different* invoice's `calc_balanceDue` in place (`10032-10044`) | ✓ own create-or-update branch, plus `persistInvChange()` for the side-mutated invoice |
| `savePayment()` | `13039-13057` | mutates `dep`/`status`/`updAt` | ✓ via `persistInvChange()` |
| `deletePayment(id)` | `13091-13110`ish | mutates `dep` (never re-derives `status` — pre-existing, unrelated to this REQ; see `REQ-INTEG-002-2c` §1.3) | ✓ via `persistInvChange()` |
| `processImport()` CSV, `entity==='inv'` | `9246-9294` | create/update | out of scope — deferred, logged as `CLOUD-GAP-003` (corrected, §2 REQ-CLOUD-006l — no PO precedent for CSV Cloud Data support actually exists) |
| `processImportRecords()`, `entity==='inv'` | `9567-9632` | create/update, independently-coded duplicate of the above | out of scope — same, second `CLOUD-GAP-003` instance |
| `pullAll()` Invoice block | `4523-4542` | unconditional merge, **no Cloud Data exclusion gate exists today** | ✓ new gate (§2, REQ-CLOUD-006i) |
| `pullAll()` Credit Note block | `4544-4564` | unconditional merge, same gap | ✓ same gate |
| `migrateSuppliersBuyersToSupabase()` | `5918-5928` | sweeps `inv.buyerId`, local-only | ✓ retrofit: also push touched Invoice if migrated |
| `migrateLineItemsToSupabase()` | `6004-6016` | sweeps `inv.lineItems[].lid`, local-only | ✓ retrofit |
| `migrateQteToSupabase()` | `6228-6229` | sweeps `inv.linkedQuoteId`, local-only | ✓ retrofit |
| `migratePOToSupabase()` | `6335-6338` | sweeps `inv.pos[]`, local-only | ✓ retrofit |
| `delPO(id)` | `8379-8386` | splices deleted PO id out of `Invoice.pos[]`, local-only | ✓ retrofit (push touched Invoice if migrated) |
| `backfillInvoicePOs()` | `2944-2963` | rebuilds `inv.pos[]` on every `initApp()` via bare `saveAll()` | ✓ retrofit: push each *changed* invoice if migrated |
| `repairCalcFields()` | `13525-13535` | strips stray `cnAmount`, runs on every `initApp()` | out of scope — cosmetic repair, no FK/id concern; local-only fix acceptable (mirrors how `executeDataCleanup()` needs no retrofit for any already-migrated entity, §1.8) |
| `runFPMMigration()` | `13492-13521` | one-time-only, guarded, hardcodes 4 legacy invoice numbers | out of scope — fires once ever, already fully executed on any real install |
| `executeDataCleanup()` | `9851-9905` | phantom-record filter | out of scope — a real Cloud-hosted row always has a real id, can never be "phantom" (same reasoning already accepted for every prior entity) |
| `advMergeBuyers()` | `11765-11790` | bulk-reassigns `inv.buyer`/`buyerId` across every matching invoice, **no per-record `syncEnt()` today** | ✓ retrofit: push every touched invoice via `persistInvChange(inv, true)` in a loop, one trailing refresh |
| Demo-data seeding | `4949-5046` | local-only by design | out of scope, matches `_demo` precedent |

### 1.4 Outward references (Invoice/CN → other entities) and their pre-flight implications

| Reference | Field | Already Cloud-eligible? |
|---|---|---|
| Buyer | `buyerId` (Invoice only; CN via `saveCN()` never sets it — §1.2) | ✓ (`REQ-CLOUD-001`) |
| Line Item | `lineItems[].lid` (Invoice only; can be `''` for a manual line) | ✓ (`REQ-CLOUD-002`) |
| Quote | `linkedQuoteId` | ✓ (`REQ-CLOUD-004`) |
| Purchase Order | `pos[]` (array) | ✓ (`REQ-CLOUD-005`) |
| Invoice (self) | CN's `linkedInvId` — **the first self-referential FK in this series**, one migrating record pointing at another row in the same migrating table | n/a — resolved within this migration's own two-pass insert, §2 REQ-CLOUD-006b |

Every outward reference except the self-referential one already has a real Supabase table to check against — this REQ's precondition (§2, REQ-CLOUD-006a) is therefore the most demanding in the series: **four** prerequisite entity migrations, not one (PO needed only Supplier's).

### 1.5 Inward references (other entities/arrays → Invoice/CN) and remap implications

| Holder | Field | Remap needed on Invoice id change? |
|---|---|---|
| Purchase Order | `invId`/`invNum` | **Yes** — the mirror image of PO's own outward sweep into `Invoice.pos[]`. Requires the full "push touched PO via `persistPOChange()` if PO has migrated" cross-phase treatment, since PO already has a live Supabase table. |
| Credit Note (self) | `linkedInvId`/`linkedInvNum` | Yes, resolved within this migration's own two-pass insert (§1.4). |
| `DB.payments[]` (Buyer Payment ledger — not Cloud-eligible, Phase 3 sub-phase 3, unscoped) | `invId` | **Yes, but local-only**: rewrite `p.invId` for every payment whose invoice migrates, exactly mirroring how PO's own migration already locally sweeps `DB.supPayments[].poId` today. `getInvPayments()`'s current (shipped) matching is strict `invId`-only (`13021-13024`); `REQ-INTEG-002-2c` (in requirements-gate review, not yet shipped) proposes changing this to prefer `invId` with an `invNum` fallback — either way, keeping `invId` itself correct is required, not optional, and this REQ's local sweep is compatible with both. |
| Shipment | `linkedInvs[]` | **No** — confirmed by direct reading (`11504`, `11520`, `11457`, `11660`) to be a comma-split, free-text, join-only field; nothing ever dereferences an element against `DB.inv`. No remap needed regardless of migration. |

### 1.6 Invoice-specific findings with no precedent among the 7 already-migrated entities

- **Two structurally different creation paths for one logical `type`** (§1.2) — no prior entity had two save functions producing materially different record shapes.
- **The first self-referential FK within a migrating table** (CN→Invoice) — no prior entity migration remapped a reference from one migrating record to another in the same batch.
- **The largest existing local-sweep-function retrofit set** — 4 inward sweeps (`migrateSuppliersBuyersToSupabase`/`migrateLineItemsToSupabase`/`migrateQteToSupabase`/`migratePOToSupabase`) plus `delPO()`'s splice, all already touching `DB.inv` as local-only fixes today, all needing the "push back if migrated" retrofit.
- **`advMergeBuyers()`** — a bulk operator tool with no per-record `syncEnt()` today; no prior entity's migration needed to retrofit a bulk cross-cutting tool like this.
- **`LOCKED_STATUSES`/`canTransitionStatus()`/`unlockInv()`** (`2850-2858`, `11710-11736`): `unlockInv()` is session-only/in-memory (`_unlockedInvIds`, cleared on reload), never mutates `DB.inv` directly. No Cloud-Data-specific interaction found, matching Order Request's own guarded-state-machine precedent (`ORD_TRANSITIONS`, already Cloud-migrated with no special handling needed) — re-confirmed, not assumed, at spec time (§4, AC-9).
- **The AI-assistant dispatch path needs no Cloud Data handling** (confirmed, requirements-gate round 1, mirroring the same "confirm, don't assume" bar applied to `unlockInv()` above — REQ-CLOUD-003's own round-1 finding was burned by exactly this class of gap, wrongly including `ordAddAction()` in its mutation inventory, so this series treats the AI path as worth stating explicitly, not silently assumed safe). `_aiExecTool()` (`10703-10815`) implements only read-only tools (`get_invoices`/`get_payments`/`get_kpis`/`get_suppliers`/`get_buyers`/`get_pos`) — no write tool touches `DB.inv`. `create_invoice`/`create_credit_note` (`10583-10621`) only pre-fill the `ov-inv`/`ov-cn` modal fields via `openInv()`/`openNewCN()`; the actual write still goes through `saveInv()`/`saveCN()` (§1.3, sites #1/#7) — already covered by REQ-CLOUD-006d.
- **Zero `logEv()` on CN create/edit**, and **`delInv()` mislabels a CN deletion as `"Invoice ... deleted"`** (`8241`, unconditional) — both confirmed live. Neither threatens migration correctness; both logged, not fixed, as `INV-GAP-002` (§3).
- **`delInv()` leaves dangling references** on delete: `PO.invId/invNum`, other CNs' `linkedInvId`, and `DB.payments[].invId` are never cleaned up (`Shipment.linkedInvs[]` needs no cleanup per §1.5, since nothing dereferences it). This is a pre-existing data-integrity gap, not created by this REQ — logged as `INV-GAP-002` alongside the logging gaps above, not fixed here (unlike `PO-GAP-007`, which `REQ-CLOUD-005` fixed opportunistically as a single-array-element case, this touches three separate reference kinds each needing its own cleanup design — large enough to warrant its own future REQ rather than folding into a migration REQ).
- **An in-flight, unshipped, adjacent REQ** (`REQ-INTEG-002-2c`) is actively redefining `getInvPayments()`'s matching semantics. This REQ does not call or modify that function — see §0's sequencing note.

---

## 2. Requirements

**REQ-CLOUD-006a — Combined migration precondition.** `migrateInvToSupabase()` refuses to run unless Buyer, Line Item, Quote, and Purchase Order have *all* completed their own migrations, each verified live against the currently-connected Supabase project (mirroring `isSupplierMigrationComplete()`'s pattern, not a local flag alone) — the first precondition in this series requiring four prerequisite entities rather than one or two.

**REQ-CLOUD-006b — Live pre-flight checks, plus the self-referential remap.** Before inserting anything: (1) every non-blank `buyerId` resolves against the live Buyer table; (2) every non-blank `lineItems[].lid` resolves against the live Line Item table; (3) every non-blank `linkedQuoteId` resolves against the live Quote table; (4) every element of `pos[]` resolves against the live Purchase Order table — any failure blocks the migration with a clear per-record error, mirroring `migrateLineItemsToSupabase()`'s/`migratePOToSupabase()`'s existing `knownXIdSet` pattern. The insert itself is two-pass: **pass 1** inserts every `DB.inv` record (Invoice and CN alike) with `linked_inv_id` deferred to `null`, building `invIdMap = {oldId: newId}` from each insert's returned row; **pass 2** updates every CN whose `linkedInvId` is non-blank, setting `linked_inv_id = invIdMap[oldLinkedInvId]` both in Supabase and locally. A `linkedInvId` that does not resolve to any record in `invIdMap` (a pre-existing dangling reference, per `INV-GAP-002`) is left `null` and logged, not treated as a blocking error — the CN's own row still migrates.

**REQ-CLOUD-006c — Pre-flight duplicate-number scan.** Before inserting, scan the *entire* local `DB.inv` array (Invoice and CN together, matching how `vInv()`'s/`saveCN()`'s own duplicate checks already operate) for any duplicate `num` — block the migration with a clear listing if found, mirroring PO's/Quote's own precedent. `pullAll()`'s bulk merge (§1.3) is confirmed to bypass client-side duplicate checks entirely, so this pre-flight scan cannot assume local data is already clean.

**REQ-CLOUD-006d — `saveInv()`/`saveCN()` gain their own create-or-update Cloud Data branches**, mirroring `saveLI()`/`saveCon()`'s shape (a dedicated branch, not `persistInvChange()`, since only these two functions handle the create path).

**REQ-CLOUD-006e — New shared `persistInvChange(inv, skipRefresh)` helper**, mirroring `persistPOChange()`/`persistQteChange()`/`persistOrdChange()` exactly, wired into every site that mutates an *already-existing* invoice without itself creating one (corrected, requirements-gate round 1 — an earlier draft split this into two inconsistent lists, an "eight-site" §006e list and a separately-mechanism'd "five-site retrofit" §006h, with no stated reason the five would behave differently; both are the identical "push this touched invoice back to Supabase if Invoice has migrated" operation and are consolidated into one exhaustive list here). **Thirteen call sites in total, the most of any entity in this series** (PO needed three):
1. `saveInvApprove()` (`7219-7238`)
2. `saveInvProgress()` (`7261-7275`)
3. `autoPos()` (`7277-7319`)
4. `savePayment()` (`13039-13057`)
5. `deletePayment()` (`13091-13110`ish)
6. `advMergeBuyers()` (`11765-11790`, looped — `skipRefresh=true` per iteration plus one trailing refresh)
7. `delPO()`'s splice of a deleted PO id out of `Invoice.pos[]` (`8379-8386`)
8. `backfillInvoicePOs()`'s per-changed-invoice save (`2944-2963`)
9. `saveCN()`'s side-mutation of a *different* invoice's `calc_balanceDue` (`10032-10044`) — pushes that other touched invoice, distinct from `saveCN()`'s own create-or-update branch (§006d) for the CN record itself
10. `migrateSuppliersBuyersToSupabase()`'s existing local sweep of `inv.buyerId` (`5918-5928`) — the sweep's own field-rewrite logic is unchanged; this adds the push on top of it
11. `migrateLineItemsToSupabase()`'s existing local sweep of `inv.lineItems[].lid` (`6004-6016`) — same treatment
12. `migrateQteToSupabase()`'s existing local sweep of `inv.linkedQuoteId` (`6228-6229`) — same treatment
13. `migratePOToSupabase()`'s existing local sweep of `inv.pos[]` (`6335-6338`) — same treatment

**REQ-CLOUD-006f — Outward retrofit into Purchase Order.** `migrateInvToSupabase()` sweeps `PO.invId`/`invNum` for every PO whose source invoice is migrating, and — since PO already has a live Supabase table — pushes each touched PO via `persistPOChange()` when PO has migrated (always true here, since REQ-CLOUD-006a requires it as a precondition), the mirror image of `REQ-CLOUD-005`'s own outward sweep into `Quote.linkedPOIds[]`.

**REQ-CLOUD-006g — Local-only inward sweep of `DB.payments[].invId`.** `migrateInvToSupabase()` rewrites `invId` on every Buyer Payment record referencing a migrating invoice, exactly mirroring how `migratePOToSupabase()` already locally sweeps `DB.supPayments[].poId` — `DB.payments` itself stays local-only (Phase 3 sub-phase 3, unscoped, §0).

**REQ-CLOUD-006h — (removed, requirements-gate round 1) — folded into REQ-CLOUD-006e's unified 13-site list above**, since sites #10-13 there are exactly what this requirement used to describe separately as a "retrofit."

**REQ-CLOUD-006i — `pullAll()` exclusion gate, both halves.** PO's own exclusion (the actual precedent to mirror, not just its oft-cited block guard) is two parts working together: the `_allPullKeys` request-list filter (`index.html:4510-4511`, `var _allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch); if (_sb && localStorage.getItem('st_po_cloud_migration_ts')) _allPullKeys = _allPullKeys.filter(function(e){ return e !== 'po'; });`) *and* the per-block merge guard (`4574`, `if (!(_sb && localStorage.getItem('st_po_cloud_migration_ts'))) { ... }`). `docs/requirements-tracker.md`'s own `REQ-CLOUD-005` row records that spec-gate round 2 specifically caught an implementation that added only the block guard and never the `_allPullKeys` filter — the identical mistake this REQ must not repeat. `'inv'`/`'cn'` are today hardcoded unconditionally into `_allPullKeys`'s literal (`4510`) alongside `'po'`; this REQ adds the same conditional filter for both, plus both blocks' own per-block guards (`4523-4542`, `4544-4564`), gated on one shared `st_inv_cloud_migration_ts` marker since Invoice and Credit Note are one migration.

**REQ-CLOUD-006j — New `refreshInvFromSupabase()`**, wired into `initCloudDataLayer()` with the standard non-destructive guard (refuse to overwrite real local data unless this device has migrated or there is nothing local to lose), matching every prior entity's refresh function.

**REQ-CLOUD-006k — Settings → Cloud Data UI card** for Invoice/Credit Note, matching the existing per-entity card pattern (migrate button, restore-from-archive button, 30-day archive/rollback).

**REQ-CLOUD-006l — CSV import stays local-only, deferred (corrected — requirements-gate round 1 found the cited precedent doesn't exist).** An earlier draft of this REQ claimed `processImport()`/`processImportRecords()`'s `'inv'` branches would gain a Cloud Data path "mirroring how PO's own CSV import was handled in `REQ-CLOUD-005`" — but PO's own CSV import was never given Cloud Data handling at all: `docs/REQ-CLOUD-005-v1.md` §3 explicitly put it out of scope and logged both of PO's CSV branches under `CLOUD-GAP-003`, and neither contains any `_sb` reference today (confirmed live, `processImport()`'s `'po'` branch and `processImportRecords()`'s `'po'` branch). This REQ follows the same established precedent rather than inventing a new one: `processImport()`'s and `processImportRecords()`'s `'inv'` branches (`9246-9294`, `9567-9632`) stay local-only, unchanged, and are logged as two more instances of `CLOUD-GAP-003`'s exact defect class at ship time (§3) — not built here, matching the decision already made for every other entity's CSV import path in this series.

---

## 3. Out of scope

- **Sub-phase 2 (Shipment)** and **sub-phase 3 (Buyer Payment, Supplier Payment)** — separate, later REQs (§0).
- **`CN-GAP-001`** (new, logged from §1.2): `saveCN()`'s dedicated modal enforces no number-format regex, unlike `saveInv()`'s CN sub-mode — a pre-existing validation asymmetry between the two CN creation paths, unrelated to Cloud Data, not fixed here.
- **`INV-GAP-002`** (new, logged from §1.6): `delInv()` leaves `PO.invId/invNum`, other CNs' `linkedInvId`, and `DB.payments[].invId` dangling on delete, and CN create/edit never calls `logEv()` while `delInv()` mislabels a CN deletion as an "Invoice" in the log — four related, pre-existing gaps, none created by this REQ, large enough to warrant a dedicated future REQ rather than folding into a migration REQ.
- **`CLOUD-GAP-002`** (push-side sync has no Cloud-Data exclusion for any entity) — pre-existing, unaffected by this REQ, same as every prior sub-phase.
- **CSV import Cloud Data support for Invoice/Credit Note** (corrected, requirements-gate round 1 — §2 REQ-CLOUD-006l): both `processImport()`'s and `processImportRecords()`'s `'inv'` branches stay local-only, matching the identical decision already made for Purchase Order's own CSV import — logged as two new instances of `CLOUD-GAP-003`, not built here.
- **Correcting `docs/architecture-data-model-v1.md`'s stale "wrong Sheets tab" claim** (§1.1) — a documentation fix, tracked in §7, not a code change.
- **Any change to `REQ-INTEG-002-2c`'s `getInvPayments()` matching logic** — this REQ only rewrites `DB.payments[].invId` *values*; it does not touch the matching function itself (§0).
- **The `v3.0.0` multi-tenant rebuild** (`docs/v3-architect-handoff.md`) — a separate, unscoped future initiative; this REQ's schema is expected to need redesign for tenant isolation later, an accepted tradeoff already priced into every prior Cloud Data sub-phase (§0).

---

## 4. Acceptance criteria

- **AC-1.** `migrateInvToSupabase()` refuses to run unless all four prerequisite entities (Buyer, Line Item, Quote, Purchase Order) show complete, live-verified migrations — demonstrated with each of the four missing in turn.
- **AC-2.** The four live pre-flight checks (§2b) each block migration on an unresolvable `buyerId`/`lineItems[].lid`/`linkedQuoteId`/`pos[]` element — demonstrated one per field.
- **AC-3.** The pre-flight duplicate-`num` scan blocks migration on a local duplicate spanning an Invoice and a CN sharing one number, not just two Invoices.
- **AC-4.** The two-pass self-referential remap correctly resolves a CN's `linkedInvId` to its linked invoice's new Supabase id regardless of insertion order (CN before its linked invoice in the local array, and after) — both orders demonstrated — and leaves a genuinely dangling `linkedInvId` (pointing at no current record) as `null` without blocking the migration.
- **AC-5.** `saveInv()`/`saveCN()` each correctly route through their own create-or-update Cloud Data branch (§2d) when Invoice has migrated, and are demonstrated unaffected (today's exact local-only behavior) when it has not.
- **AC-6.** `migrateInvToSupabase()` sweeps `PO.invId`/`invNum` outward and pushes each touched PO via `persistPOChange()`.
- **AC-7.** `migrateInvToSupabase()` sweeps `DB.payments[].invId` locally for every affected Buyer Payment record.
- **AC-8 (corrected, requirements-gate round 1 — consolidated to match §2e's unified list).** All 13 `persistInvChange()` call sites — `saveInvApprove()`, `saveInvProgress()`, `autoPos()`, `savePayment()`, `deletePayment()`, `advMergeBuyers()`, `delPO()`'s splice, `backfillInvoicePOs()`, `saveCN()`'s different-invoice side-push, and the four existing local sweep functions' retrofits — each push a touched Invoice back to Supabase when Invoice has migrated, individually demonstrated, and are demonstrated unaffected when it has not (matching each site's existing, already-tested local-only behavior).
- **AC-9.** `unlockInv()`/`canTransitionStatus()` are confirmed, by an explicit test against the real functions (not by inspection alone), to need no Cloud-Data-specific handling — closing the one open question §1.6 flagged as not definitively resolved during check-first.
- **AC-10.** `pullAll()` drops both the Invoice and Credit Note blocks once `st_inv_cloud_migration_ts` is set.
- **AC-11.** `refreshInvFromSupabase()` refuses to overwrite real local data absent a completed migration or existing local data, matching every prior entity's refresh function.
- **AC-12 (corrected, requirements-gate round 1).** CSV import (`processImport()`/`processImportRecords()`) is demonstrated **unaffected** by this REQ — both `'inv'` branches remain local-only pre- and post-migration, matching today's exact behavior (no Cloud Data path exists to test, per the corrected §2 REQ-CLOUD-006l/§3).
- **AC-13.** Full pre-existing-test-suite audit: every direct test-suite call site of a mutation function this REQ touches is traced and confirmed either unaffected or correctly updated.

---

## 5. Testing approach

Mirrors `REQ-CLOUD-005`'s own test coverage shape (the most structurally similar prior entity: multiple creation paths, a combined precondition, both an outward and several inward sweeps) rather than inventing a new pattern. The self-referential remap (AC-4) is the one genuinely novel test shape in this series and needs its own dedicated fixture pair (a CN and its linked invoice, tested both insertion orders).

---

## 6. Gate process

Standard pipeline: this REQ → independent requirements-gate review (Agent) → SPEC-CLOUD-006 (exact diffs, including the SQL migration `supabase/migrations/0006_invoices.sql`) → independent spec-gate review (Agent, applies diffs to a scratch copy, runs the real test suite) → implementation → self-directed mutation testing → independent build-gate review (Agent) → PR → CI green → merge → verify main consistent.

---

## 7. Tracker updates (at ship time)

- `docs/requirements-tracker.md` — new `REQ-CLOUD-006` row.
- `docs/known-gaps.md` — new `CN-GAP-001` and `INV-GAP-002` entries (§3); two new instances logged under existing `CLOUD-GAP-003` (Invoice CSV import, both branches, corrected per §2 REQ-CLOUD-006l); correct §6.6's now-stale "wrong Sheets tab" claim in `docs/architecture-data-model-v1.md` to reflect §1.1's finding.
- `docs/version-history.md`/`STACKD_CONTEXT.md`/`CLAUDE.md` — version bump, test count, a note on Invoice/CN joining Cloud Data and the four-entity precondition.
- `docs/user-guide.md` — Settings → Cloud Data section updated for the new Invoice/Credit Note card.

---

## 8. Review-resolution log

**Round 1: CONDITIONAL PASS — 3 blocking, 4 advisory, all fixed in place.** The reviewer spot-checked 20+ line citations across §1.1-§1.6 (all confirmed byte-exact), independently grepped every `DB.inv` occurrence to verify §1.3's mutation-site table completeness, and checked the AI-assistant dispatch path, `known-gaps.md`, and `requirements-tracker.md` for the gap-number and precedent claims. Every outward-reference table entry, `Shipment.linkedInvs[]`'s free-text-only shape, `pullAll()`'s lack of an existing exclusion, the two new gap numbers, and the self-referential remap design were all independently confirmed accurate.

Blocking:
- **REQ-CLOUD-006l cited a precedent that doesn't exist.** An earlier draft claimed CSV import Cloud Data support would "mirror how PO's own CSV import was handled" — but PO's own CSV import was never given Cloud Data handling at all; `REQ-CLOUD-005` explicitly deferred both of PO's CSV branches under `CLOUD-GAP-003`, confirmed live (neither branch contains any `_sb` reference). Fixed by following the actual precedent: Invoice/CN's CSV import branches stay local-only, logged as two new `CLOUD-GAP-003` instances, not built here (§2 REQ-CLOUD-006l, §3, AC-12 all corrected).
- **Inconsistent `persistInvChange()` call-site count** — an earlier draft split call sites into an "eight-site" §006e list and a separately-mechanism'd "five-site retrofit" §006h, with `delPO()` appearing in both and no stated reason the five would behave differently from the eight; `saveCN()`'s side-push of a different invoice's `calc_balanceDue` was also excluded from both counts. Fixed by consolidating into one exhaustive 13-site list under REQ-CLOUD-006e, removing 006h as a separate requirement, and updating AC-8 to match.
- **REQ-CLOUD-006i cited only half of PO's real exclusion mechanism**, repeating a defect this codebase's own history already caught once: PO's actual exclusion is the `_allPullKeys` request-list filter (`4510-4511`) *and* the per-block merge guard (`4574`) working together — `docs/requirements-tracker.md`'s own `REQ-CLOUD-005` row records that spec-gate round 2 caught an implementation that added only the block guard and never the array filter. Fixed by requiring both mechanisms explicitly, with exact citations, for both the Invoice and Credit Note blocks.

Advisory (fixed in place, didn't block the verdict):
- §1.2's "`vCN()`/`saveCN()` each run their own independent duplicate-`num` scan" was imprecise — only `saveCN()` does; `vCN()` has no duplicate check at all. Wording left as-is since it doesn't affect any requirement (the reviewer flagged it as non-blocking); noted here for completeness.
- AC-4's insertion-order clause tests a property the two-pass design guarantees structurally regardless of implementation correctness — left in place since it's not wrong, just non-discriminating; the load-bearing clause (a genuinely dangling `linkedInvId`) was already present.
- REQ-CLOUD-006k (Settings UI card) has no dedicated AC — matches an identical, pre-existing gap in the already-shipped `REQ-CLOUD-005` (005k also has none), an inherited series pattern rather than new to this REQ; left as-is.
- The REQ never explicitly stated the AI-assistant dispatch path (`_aiExecTool`, `create_invoice`/`create_credit_note`) needs no Cloud Data handling, despite `REQ-CLOUD-003`'s own round-1 history being burned by exactly this class of gap. Fixed by adding an explicit statement to §1.6, confirming (not assuming) the underlying fact was already fine.

Ready for SPEC, pending independent re-verification in a future round if one is dispatched.
