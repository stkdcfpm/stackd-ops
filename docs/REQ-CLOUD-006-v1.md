# REQ-CLOUD-006 (Phase 3, sub-phase 1 of 3) — Extend Cloud Data to Invoice and Credit Note

**Status:** v1 — drafted, awaiting requirements-gate review.
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
| `processImport()` CSV, `entity==='inv'` | `9246-9294` | create/update | ✓ via a Cloud Data branch mirroring PO's own CSV-import handling |
| `processImportRecords()`, `entity==='inv'` | `9567-9632` | create/update, independently-coded duplicate of the above | ✓ same treatment |
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
- **Zero `logEv()` on CN create/edit**, and **`delInv()` mislabels a CN deletion as `"Invoice ... deleted"`** (`8241`, unconditional) — both confirmed live. Neither threatens migration correctness; both logged, not fixed, as `INV-GAP-002` (§3).
- **`delInv()` leaves dangling references** on delete: `PO.invId/invNum`, other CNs' `linkedInvId`, and `DB.payments[].invId` are never cleaned up (`Shipment.linkedInvs[]` needs no cleanup per §1.5, since nothing dereferences it). This is a pre-existing data-integrity gap, not created by this REQ — logged as `INV-GAP-002` alongside the logging gaps above, not fixed here (unlike `PO-GAP-007`, which `REQ-CLOUD-005` fixed opportunistically as a single-array-element case, this touches three separate reference kinds each needing its own cleanup design — large enough to warrant its own future REQ rather than folding into a migration REQ).
- **An in-flight, unshipped, adjacent REQ** (`REQ-INTEG-002-2c`) is actively redefining `getInvPayments()`'s matching semantics. This REQ does not call or modify that function — see §0's sequencing note.

---

## 2. Requirements

**REQ-CLOUD-006a — Combined migration precondition.** `migrateInvToSupabase()` refuses to run unless Buyer, Line Item, Quote, and Purchase Order have *all* completed their own migrations, each verified live against the currently-connected Supabase project (mirroring `isSupplierMigrationComplete()`'s pattern, not a local flag alone) — the first precondition in this series requiring four prerequisite entities rather than one or two.

**REQ-CLOUD-006b — Live pre-flight checks, plus the self-referential remap.** Before inserting anything: (1) every non-blank `buyerId` resolves against the live Buyer table; (2) every non-blank `lineItems[].lid` resolves against the live Line Item table; (3) every non-blank `linkedQuoteId` resolves against the live Quote table; (4) every element of `pos[]` resolves against the live Purchase Order table — any failure blocks the migration with a clear per-record error, mirroring `migrateLineItemsToSupabase()`'s/`migratePOToSupabase()`'s existing `knownXIdSet` pattern. The insert itself is two-pass: **pass 1** inserts every `DB.inv` record (Invoice and CN alike) with `linked_inv_id` deferred to `null`, building `invIdMap = {oldId: newId}` from each insert's returned row; **pass 2** updates every CN whose `linkedInvId` is non-blank, setting `linked_inv_id = invIdMap[oldLinkedInvId]` both in Supabase and locally. A `linkedInvId` that does not resolve to any record in `invIdMap` (a pre-existing dangling reference, per `INV-GAP-002`) is left `null` and logged, not treated as a blocking error — the CN's own row still migrates.

**REQ-CLOUD-006c — Pre-flight duplicate-number scan.** Before inserting, scan the *entire* local `DB.inv` array (Invoice and CN together, matching how `vInv()`'s/`saveCN()`'s own duplicate checks already operate) for any duplicate `num` — block the migration with a clear listing if found, mirroring PO's/Quote's own precedent. `pullAll()`'s bulk merge (§1.3) is confirmed to bypass client-side duplicate checks entirely, so this pre-flight scan cannot assume local data is already clean.

**REQ-CLOUD-006d — `saveInv()`/`saveCN()` gain their own create-or-update Cloud Data branches**, mirroring `saveLI()`/`saveCon()`'s shape (a dedicated branch, not `persistInvChange()`, since only these two functions handle the create path). `saveCN()`'s side-mutation of a *different* invoice's `calc_balanceDue` (`10032-10044`) additionally pushes that other touched invoice via `persistInvChange()` when Invoice has migrated.

**REQ-CLOUD-006e — New shared `persistInvChange(inv, skipRefresh)` helper**, mirroring `persistPOChange()`/`persistQteChange()`/`persistOrdChange()` exactly, wired into every existing mutation site that updates an already-existing invoice without creating one: `saveInvApprove()`, `saveInvProgress()`, `autoPos()`, `savePayment()`, `deletePayment()`, `advMergeBuyers()` (looped, `skipRefresh=true` plus one trailing refresh), `delPO()`'s splice, and `backfillInvoicePOs()`'s per-changed-invoice save — eight call sites, the most of any entity in this series.

**REQ-CLOUD-006f — Outward retrofit into Purchase Order.** `migrateInvToSupabase()` sweeps `PO.invId`/`invNum` for every PO whose source invoice is migrating, and — since PO already has a live Supabase table — pushes each touched PO via `persistPOChange()` when PO has migrated (always true here, since REQ-CLOUD-006a requires it as a precondition), the mirror image of `REQ-CLOUD-005`'s own outward sweep into `Quote.linkedPOIds[]`.

**REQ-CLOUD-006g — Local-only inward sweep of `DB.payments[].invId`.** `migrateInvToSupabase()` rewrites `invId` on every Buyer Payment record referencing a migrating invoice, exactly mirroring how `migratePOToSupabase()` already locally sweeps `DB.supPayments[].poId` — `DB.payments` itself stays local-only (Phase 3 sub-phase 3, unscoped, §0).

**REQ-CLOUD-006h — Retrofit the 4 existing local-only sweep functions plus `delPO()`'s splice.** `migrateSuppliersBuyersToSupabase()`, `migrateLineItemsToSupabase()`, `migrateQteToSupabase()`, `migratePOToSupabase()`, and `delPO()` each gain "push the touched Invoice back to Supabase if Invoice has migrated" alongside their existing local-only field rewrite — five retrofit sites, the most of any entity in this series (PO needed three).

**REQ-CLOUD-006i — `pullAll()` exclusion gate.** Both the Invoice block (`4523-4542`) and the Credit Note block (`4544-4564`) drop out of the batched pull once `st_inv_cloud_migration_ts` is set, mirroring PO's own gate (`4573`) exactly — both blocks share one gate/marker, since they are one migration.

**REQ-CLOUD-006j — New `refreshInvFromSupabase()`**, wired into `initCloudDataLayer()` with the standard non-destructive guard (refuse to overwrite real local data unless this device has migrated or there is nothing local to lose), matching every prior entity's refresh function.

**REQ-CLOUD-006k — Settings → Cloud Data UI card** for Invoice/Credit Note, matching the existing per-entity card pattern (migrate button, restore-from-archive button, 30-day archive/rollback).

**REQ-CLOUD-006l — CSV import Cloud Data branches.** `processImport()`'s and `processImportRecords()`'s `entity==='inv'` branches each gain a Cloud Data create-or-update path, mirroring how PO's own CSV import was handled in `REQ-CLOUD-005`.

---

## 3. Out of scope

- **Sub-phase 2 (Shipment)** and **sub-phase 3 (Buyer Payment, Supplier Payment)** — separate, later REQs (§0).
- **`CN-GAP-001`** (new, logged from §1.2): `saveCN()`'s dedicated modal enforces no number-format regex, unlike `saveInv()`'s CN sub-mode — a pre-existing validation asymmetry between the two CN creation paths, unrelated to Cloud Data, not fixed here.
- **`INV-GAP-002`** (new, logged from §1.6): `delInv()` leaves `PO.invId/invNum`, other CNs' `linkedInvId`, and `DB.payments[].invId` dangling on delete, and CN create/edit never calls `logEv()` while `delInv()` mislabels a CN deletion as an "Invoice" in the log — four related, pre-existing gaps, none created by this REQ, large enough to warrant a dedicated future REQ rather than folding into a migration REQ.
- **`CLOUD-GAP-002`** (push-side sync has no Cloud-Data exclusion for any entity) — pre-existing, unaffected by this REQ, same as every prior sub-phase.
- **Correcting `docs/architecture-data-model-v1.md`'s stale "wrong Sheets tab" claim** (§1.1) — a documentation fix, tracked in §7, not a code change.
- **Any change to `REQ-INTEG-002-2c`'s `getInvPayments()` matching logic** — this REQ only rewrites `DB.payments[].invId` *values*; it does not touch the matching function itself (§0).
- **The `v3.0.0` multi-tenant rebuild** (`docs/v3-architect-handoff.md`) — a separate, unscoped future initiative; this REQ's schema is expected to need redesign for tenant isolation later, an accepted tradeoff already priced into every prior Cloud Data sub-phase (§0).

---

## 4. Acceptance criteria

- **AC-1.** `migrateInvToSupabase()` refuses to run unless all four prerequisite entities (Buyer, Line Item, Quote, Purchase Order) show complete, live-verified migrations — demonstrated with each of the four missing in turn.
- **AC-2.** The four live pre-flight checks (§2b) each block migration on an unresolvable `buyerId`/`lineItems[].lid`/`linkedQuoteId`/`pos[]` element — demonstrated one per field.
- **AC-3.** The pre-flight duplicate-`num` scan blocks migration on a local duplicate spanning an Invoice and a CN sharing one number, not just two Invoices.
- **AC-4.** The two-pass self-referential remap correctly resolves a CN's `linkedInvId` to its linked invoice's new Supabase id regardless of insertion order (CN before its linked invoice in the local array, and after) — both orders demonstrated — and leaves a genuinely dangling `linkedInvId` (pointing at no current record) as `null` without blocking the migration.
- **AC-5.** `saveInv()`, `saveCN()`, `saveInvApprove()`, `saveInvProgress()`, `autoPos()`, `savePayment()`, `deletePayment()`, `advMergeBuyers()`, `delPO()`, and `backfillInvoicePOs()` each correctly route through the new Cloud Data create/update/`persistInvChange()` paths when Invoice has migrated, and are demonstrated unaffected (today's exact local-only behavior) when it has not.
- **AC-6.** `migrateInvToSupabase()` sweeps `PO.invId`/`invNum` outward and pushes each touched PO via `persistPOChange()`.
- **AC-7.** `migrateInvToSupabase()` sweeps `DB.payments[].invId` locally for every affected Buyer Payment record.
- **AC-8.** All five retrofit sites (§2h) push a touched Invoice back to Supabase when Invoice has migrated, and are demonstrated unaffected when it has not (matching the existing, already-tested local-only behavior each currently has).
- **AC-9.** `unlockInv()`/`canTransitionStatus()` are confirmed, by an explicit test against the real functions (not by inspection alone), to need no Cloud-Data-specific handling — closing the one open question §1.6 flagged as not definitively resolved during check-first.
- **AC-10.** `pullAll()` drops both the Invoice and Credit Note blocks once `st_inv_cloud_migration_ts` is set.
- **AC-11.** `refreshInvFromSupabase()` refuses to overwrite real local data absent a completed migration or existing local data, matching every prior entity's refresh function.
- **AC-12.** CSV import (`processImport()`/`processImportRecords()`) correctly creates/updates via Cloud Data when Invoice has migrated.
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
- `docs/known-gaps.md` — new `CN-GAP-001` and `INV-GAP-002` entries (§3); correct §6.6's now-stale "wrong Sheets tab" claim in `docs/architecture-data-model-v1.md` to reflect §1.1's finding.
- `docs/version-history.md`/`STACKD_CONTEXT.md`/`CLAUDE.md` — version bump, test count, a note on Invoice/CN joining Cloud Data and the four-entity precondition.
- `docs/user-guide.md` — Settings → Cloud Data section updated for the new Invoice/Credit Note card.

---

## 8. Review-resolution log

_None yet — v1 has not been through requirements-gate review._
