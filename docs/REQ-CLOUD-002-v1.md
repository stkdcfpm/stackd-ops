# REQ-CLOUD-002 — Extend Cloud Data (Supabase) to Line Item and Contact

**Status:** v1 — draft, pending requirements-gate.

---

## 1. Business context

This is Phase 1 of the migration roadmap in `docs/architecture-data-model-v1.md` §9.4: master-data migration, the first step after the Phase 0 fix (`REQ-PO-002`, shipped v2.9.72). The end goal, stated in the same document's Executive Summary, is closing `SEC-GAP-011` — the accepted architectural risk that Google Sheets sync has no conflict resolution, causing two devices on the same account to silently diverge (the exact problem that started this whole initiative).

`REQ/SPEC-CLOUD-001` (shipped v2.9.54) already built and proved the mechanism this REQ extends: a Supabase-backed shared-database layer, currently scoped to Supplier and Buyer only. This REQ applies that same, already-working mechanism to two more entities — **Line Item** and **Contact** — chosen because, per the architecture doc's roadmap, they are the two master-data entities that don't require any new architectural decision to be settled first: both use identifier-based foreign keys already, both are flat top-level records (no nesting), and both are already covered by the standard reference-number scheme. Order Request, Quote, and Purchase Order (Phase 2) do require new decisions — nested-record handling, unifying incompatible numbering schemes — and are explicitly out of scope here.

**What "extend the same mechanism" means precisely**, verified against the real, current code (not assumed from the REQ/SPEC-CLOUD-001 docs, which contain a few small citation drifts noted in their own spec-gate history):

- A new Postgres table per entity (`line_items`, `contacts`), following the exact pattern of `supabase/migrations/0001_suppliers_buyers.sql`'s `suppliers`/`buyers` tables: `uuid` primary key, soft-delete via a `deleted_at` column, `authenticated`-only RLS with no delete policy (soft-delete enforced by omission, not by application logic).
- Client-side `_sb`-gated branches added to `saveLI()`/`delLI()` (`index.html:5735-5770`) and `saveCon()`/`delCon()` (`index.html:11398-11488`), mirroring `saveSup()`/`delSup()`'s exact structure (`index.html:5594-5657`) — including the detail, confirmed by direct read and correcting an imprecise assumption from initial scoping, that **Sheets sync and Cloud Data are mutually exclusive per entity, not simultaneous**: once `_sb` is truthy, `saveSup()`/`delSup()` return from their `_sb` branch before ever reaching the `syncEnt()`/`delEnt()` calls at the bottom of the local branch. Line Item and Contact must follow the same mutually-exclusive structure, not run both.
- A migration function following `migrateSuppliersBuyersToSupabase()`'s exact shape (`index.html:5521-5565`): insert every local record, build an old-id→new-id map, then sweep every other entity's field known to reference the old id.
- Archive-not-delete rollback (`restoreFromMigrationArchive()`, `index.html:5567-5577`) and the 30-day expiry cleanup (`cleanupExpiredMigrationArchive()`, `index.html:5579-5588`), extended to cover the two new archive keys.

**Two design questions the architecture-doc research settled, and one it did not (flagged for spec-gate):**

1. **Line Item's foreign key is unconditional — every row requires a `supId`** (enforced client-side at `vLI()`, `index.html:7917`: `if (!sup) return vErr('lf-sup', 'Please select a supplier');`). If `line_items` gets a real Postgres foreign-key constraint against `suppliers(id)` (matching the referential-integrity style already established for Contact→Supplier at the SQL level), every Line Item insert would need a valid Supabase Supplier UUID already in place. **REQ-CLOUD-002a below requires Line Item migration to be blocked unless Supplier's own migration has already completed** — not merely that Cloud Data is *configured* (`_sb` truthy), which is a materially weaker condition (see point 3 below).

2. **Contact's foreign key is optional** — `supplierId` is nullable, and per the existing `openSupConPicker()` eligibility filter (`index.html:5337-5339`), a substantial fraction of real Contacts have no Supplier link at all. A Contact with `supplierId: null` hits no FK constraint regardless of Supplier's migration status. **REQ-CLOUD-002b below adopts the same precondition as Line Item for simplicity and consistency** (both master-data migrations require Supplier to already be done) rather than inventing a second, narrower precondition that only blocks the subset of Contacts with a live Supplier link — the cost of the stricter, simpler rule is negligible, since an operator who has already gone through Cloud Data setup for Suppliers has no reason not to have done so before reaching Line Item/Contact in the roadmap's own stated sequence.

3. **Not yet settled — flagged for spec-gate:** the precondition in REQ-CLOUD-002a/b must check that Supplier's migration has **actually completed** (existing Suppliers are present in the `suppliers` table), not merely that `_sb` is truthy. Verified by direct read that these are different states: `saveSbConfig()` (`index.html:5430-5436`) sets `SS.supabaseUrl`/`SS.supabaseAnonKey` and calls `initSbClient()` alone — it does **not** call `migrateSuppliersBuyersToSupabase()` or any refresh function. `_sb` becomes truthy the moment Cloud Data is configured, before any Supplier has actually been migrated. There is no existing per-entity "migration completed" flag anywhere in the codebase (confirmed by exhaustive search of every `migrate*`/`backfill*` function) — the SPEC must define the actual check (e.g., querying Supabase for at least one non-empty result, or introducing a new persisted marker) rather than this REQ guessing at an unverified mechanism.

---

## 2. Requirements

**REQ-CLOUD-002a — Line Item Cloud Data migration, blocked on Supplier's prior completion.** New `line_items` Supabase table (schema below); `_sb`-gated branches in `saveLI()`/`delLI()`; a `migrateLineItemsToSupabase()` function that inserts every local Line Item, builds an old-id→new-id map, and rewrites every known external reference (§2c). Must refuse to proceed (clear operator-facing message, no partial migration) if Supplier's own Cloud Data migration has not actually completed, per point 3 above.

**REQ-CLOUD-002b — Contact Cloud Data migration, same precondition as Line Item.** New `contacts` table; `_sb`-gated branches in `saveCon()`/`delCon()`; `migrateContactsToSupabase()` following the same shape. Same Supplier-completion precondition as REQ-CLOUD-002a (§1, point 2's rationale). Contact's own `supplierId` field does **not** need rewriting during this migration — it already carries a valid Supabase Supplier UUID (or `null`) today, since `migrateSuppliersBuyersToSupabase()` already rewrites `DB.con[].supplierId` as part of its existing external-reference sweep (`index.html:5552`), independent of whether Contact itself has a Supabase table yet.

**REQ-CLOUD-002c — Exhaustive external-reference sweep, both entities.** Every field anywhere in the platform known to store a Line Item id or a Contact id must be rewritten to the new Supabase-assigned id as part of the same migration pass, mirroring `migrateSuppliersBuyersToSupabase()`'s existing pattern exactly:

*Line Item id, referenced by:*
- `Invoice.lineItems[].lid` (live, populated — constructed at `index.html:6088`, read at 17+ sites)
- `PurchaseOrder.lineItems[].lid` (live, populated — constructed at `index.html:6329`/`7300`/import paths)
- `Quote.lines[].lid` — **confirmed dead, never populated by any code path** (verified by exhaustive grep of every `.lid` occurrence; the codebase's own existing comment at `index.html:8794-8796` already documents this). Must still be checked by the migration sweep (never silently skipped, matching the standing convention `index.html:8794-8796` itself states — "checked anyway, never skipped"), but requires no rewrite logic since it will never match.
- `LineItem.invoiceRefs[]` (a reverse index living on the Line Item record's own row, populated by Invoice-side code, `index.html:6171-6192`) — out of scope for id-rewriting in this REQ: it references Invoice ids, and Invoice is not being migrated here. Carries forward unchanged.

*Contact id, referenced by:*
- `OrderRequest.contactId` (live, top-level, `index.html:3660`)
- `RFQResponse.contactId` (live, nested inside `DB.ord[].lines[].rfqResponses[]`, `index.html:3247`)
- `Quote.sourceContactId` (live, `index.html:11234`) — note this field is *not* cascade-nulled by `delCon()`'s existing delete behavior (`CON-GAP-004`, unaffected by this REQ), but the migration sweep must still rewrite it on migration, matching the exhaustive-sweep principle regardless of that separate, pre-existing delete-time gap.

**REQ-CLOUD-002d — Archive-not-delete rollback, both entities.** Pre-migration `DB.li`/`DB.con` arrays archived under clearly-marked keys (mirroring `st_s_pre_migration`/`st_bu_pre_migration`) for the same 30-day grace period, restorable via an extension of `restoreFromMigrationArchive()` that also disconnects Cloud Data on restore (reusing the exact fix `SPEC-CLOUD-001-v4` already made after finding a restore could otherwise be silently re-clobbered by the next background refresh).

**REQ-CLOUD-002e — No unique constraint on Line Item's `sku`.** Unlike Supplier/Buyer's case-insensitive unique `name` index (`supabase/migrations/0001_suppliers_buyers.sql:24,42`), `line_items.sku` must **not** get an equivalent unique index — `sku` is confirmed non-unique by design today (`docs/data-model.md:37`; no uniqueness check exists in `vLI()`), and imposing one now would silently reject legitimate existing duplicate-SKU data. No content-level uniqueness constraint on Contact either — Contact's existing dedup is a soft, client-side, edit-time check (`CON-GAP-002`), not a hard invariant, and must not become one via a Postgres unique index as a side effect of this migration.

**REQ-CLOUD-002f — Mandatory blocking backup gate.** Reuses the exact `expAll()`-based blocking-export pattern already proven in `REQ-CLOUD-001j` — no migration write happens until a full, successful backup export is confirmed.

**REQ-CLOUD-002g — Pre-flight duplicate/conflict scan.** Mirrors `findDuplicateSupplierNames()`/`showDuplicateConflictModal()`'s existing pattern (`index.html:5461-5476, 5530-5531`) adapted to whatever the SPEC determines is the right conflict signal for each entity (Line Item has no unique field to conflict on per REQ-CLOUD-002e — the SPEC must state explicitly whether this step is therefore a no-op for Line Item, and Contact's conflict signal, if any, should reuse its existing soft email-dedup logic rather than inventing a new one).

---

## 3. Explicitly out of scope

- **Order Request, Quote, Purchase Order.** Phase 2 of the roadmap, requiring the nested-record and cross-incompatible-numbering decisions the architecture doc explicitly separates out (`docs/architecture-data-model-v1.md` §9.3). Not addressed here.
- **Fixing `SEC-GAP-011` in general** (Sheets pull conflict resolution) beyond what naturally follows from Line Item and Contact no longer depending on Sheets sync once migrated. The wider architectural fix remains the cumulative effect of every phase completing, not something this REQ claims to close on its own.
- **The pre-existing `expAll()`/`doImport()` bug** where a JSON backup restore silently wipes `SS.supabaseUrl`/`SS.supabaseAnonKey` (neither field is captured by `expAll()`; `doImport()` replaces `SS` wholesale rather than merging, `index.html:10277,10326`). Confirmed still present, predates this REQ (inherited from `REQ-CLOUD-001`), and becomes more consequential as more entities depend on Cloud Data — but is a general Cloud Data reliability fix orthogonal to extending scope to two new entities. Recommend a small, standalone follow-up REQ; logged as a new known-gap as part of this REQ's housekeeping regardless of whether that follow-up is taken.
- **A per-entity "migration completed" flag as a reusable general mechanism.** REQ-CLOUD-002a/b's precondition check only needs to answer "has Supplier's migration completed," not establish a general-purpose migration-status registry for all future entities. If the SPEC's chosen mechanism happens to generalize, that's a bonus, not a requirement.
- **Retroactively enforcing SKU or Contact-email uniqueness.** Explicitly rejected by REQ-CLOUD-002e — existing non-unique data must continue to be representable after migration.

---

## 4. Acceptance criteria

- **AC-1:** Attempting to migrate Line Item or Contact to Cloud Data when Supplier's own migration has not completed is blocked with a clear message, and makes no partial write to Supabase or the local archive.
- **AC-2:** With Supplier already migrated, migrating Line Item inserts every local Line Item into `line_items`, correctly maps every field (`num`, `sku`, `desc`, `specs`, `hs`, `supId`→the *already-correct* Supabase Supplier UUID, `uom`, `cost`, `price`, `cur`, `notes`), and rewrites `Invoice.lineItems[].lid` and `PurchaseOrder.lineItems[].lid` across every affected record to the new Supabase-assigned Line Item id.
- **AC-3:** With Supplier already migrated, migrating Contact inserts every local Contact into `contacts`, correctly maps every field including the derived `gdprBasis` (carried forward as a plain value, not recomputed), and rewrites `OrderRequest.contactId`, `RFQResponse.contactId` (including nested inside `rfqResponses[]`), and `Quote.sourceContactId` across every affected record to the new Supabase-assigned Contact id.
- **AC-4:** `Quote.lines[].lid` is explicitly checked by the migration sweep (present in the diff, not silently omitted) and confirmed to require no rewrite, since it is never populated by any existing code path.
- **AC-5:** Post-migration, `saveLI()`/`delLI()` and `saveCon()`/`delCon()` route through their `_sb` branch and no longer call `syncEnt()`/`delEnt()` for that entity, mirroring `saveSup()`/`delSup()`'s existing mutually-exclusive structure exactly.
- **AC-6:** A full, successful `expAll()` backup is confirmed before any Supabase write begins; declining or failing the backup aborts the migration with no partial state.
- **AC-7:** Pre-migration `DB.li`/`DB.con` are archived (not deleted) under dedicated keys for 30 days, restorable via an extended `restoreFromMigrationArchive()` that also disconnects Cloud Data on restore.
- **AC-8:** No unique index exists on `line_items.sku`; no hard uniqueness constraint is introduced for Contact beyond its existing soft, client-side dedup behavior.
- **AC-9:** Zero regressions to Supplier/Buyer's existing Cloud Data behavior, Sheets sync for any unmigrated entity, or any of the 687 existing tests.

---

## 5. Testing approach

Follows the established pattern from `REQ-DATA-002`/`REQ-CLOUD-001`: unit tests for the precondition gate (AC-1, both blocked and allowed cases), the migration functions' field-mapping and external-reference-sweep correctness (AC-2, AC-3, AC-4 — including a case with a Contact linked to a Supplier and one with `supplierId: null`, and a case with an RFQ Response nested two levels deep), the mutually-exclusive sync/Cloud-Data routing (AC-5), the backup gate (AC-6, including a declined/failed-backup abort case), archive/rollback (AC-7), and a direct check that no unique index is asserted anywhere in the new SQL migration file for `sku` (AC-8). Given this touches two entities with genuinely different FK cardinality (Line Item required, Contact optional), test fixtures must cover both a Contact with a Supplier link and one without, not just one representative case.

---

## 6. Gate process

Per `CLAUDE.md`'s standing checklist: requirements-gate → SPEC → spec-gate → implementation → build-gate → ship, matching every REQ in this tracker. Given `REQ-CLOUD-001` itself needed 4 independent spec-gate rounds before shipping (3 FAIL rounds), and this REQ deliberately leaves one real mechanism (the Supplier-migration-completion check, §1 point 3) for the SPEC to pin down rather than guessing, expect at least one non-trivial spec-gate round here too.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: add a new entry for the `expAll()`/`doImport()` Cloud Data connection-wipe bug flagged in §3 (out of scope, not fixed) — proposed ID `CLOUD-GAP-001`.
- `docs/requirements-tracker.md`: add `REQ-CLOUD-002` to the active requirements table with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `docs/architecture-data-model-v1.md`: update the entity inventory table (§2.2) and Line Item/Contact's `§4.1` narrative to reflect Cloud Data now in scope for both, and update `§9.4`'s Phase 1 status.

---

## 8. Review-resolution log

(Pending requirements-gate review.)
