# REQ-CLOUD-007 (Phase 3, sub-phase 2 of 3) — Extend Cloud Data to Shipment

**Status:** v1 — drafted, not yet reviewed. Ready for requirements-gate round 1.
**Scope:** Phase 3 sub-phase 2 of 3 of the cross-platform backend migration's fulfillment/financial step (`docs/architecture-data-model-v1.md` §8, point 5), following REQ/SPEC-CLOUD-001 through 006's already-proven mechanism. Sub-phase 1 (Invoice, Credit Note) shipped as `REQ/SPEC-CLOUD-006` (v2.9.79). Sub-phase 3 (Buyer Payment, Supplier Payment) is a separate, later REQ, not started here — see §0.
**Build baseline:** `main` @ `948c2ef`, 867/867 tests passing (includes `REQ-CLOUD-006`/`REQ-INTEG-002-2c`, already merged).

---

## 0. Scoping

Phase 3 covers Invoice, Credit Note, Shipment, Buyer Payment, and Supplier Payment (`docs/architecture-data-model-v1.md` §8, point 5). `REQ-CLOUD-006` §0 sequenced Invoice/Credit Note first ("the least entangled with other in-flight work") and named Shipment as sub-phase 2 and both Payment ledgers as sub-phase 3, deliberately last, "because `REQ-INTEG-002` sub-phases 2c/2d are actively changing the Buyer Payment ledger's own shape and matching logic." That reasoning is unaffected by this REQ: Shipment has no field referencing `DB.payments`/`DB.supPayments` in either direction (confirmed, §1.5) and does not touch either ledger. Sub-phase 3 (Buyer Payment, Supplier Payment) remains unscoped, future work, not started by this REQ.

A companion check of `docs/v3-architect-handoff.md` was not repeated here — `REQ-CLOUD-006` §0 already confirmed this migration series is not blocked by, and need not anticipate, the separate v3.0.0 multi-tenant rebuild; nothing about Shipment changes that conclusion (§3).

---

## 1. Business context

### 1.1 Why Shipment differs from every prior entity in this series — it is structurally the simplest migration so far

Every entity migrated in this series so far (`REQ/SPEC-CLOUD-001` through `006`) needed at least one of: a migration precondition on another entity, an outward reference sweep (its own id, once remapped, written into some other entity's field), an inward cross-phase retrofit (some other entity's existing local-sweep function needing a "push back if migrated" fix), or more than one creation path. Direct, exhaustive research against this worktree's `index.html` (grep for every `DB.sh` occurrence, every `linkedInvs` occurrence, and every `migrate*ToSupabase()`/`persist*Change()` function body) found **Shipment has none of these** — a materially simpler profile than any prior entity, not a coincidence of scope but a structural property of the entity itself:

**(a) Shipment has exactly one creation/update path.** `saveShp()` (`index.html:12069-12103`) is the only function that ever pushes onto or mutates `DB.sh` besides `loadDemoData()`'s local-only demo seed (`index.html:5001`, §1.4). Unlike Purchase Order (`savePO()`/`autoPos()`/`qteToPoConvert()`, three paths) or Invoice (`saveInv()`/`saveCN()`, two structurally-different shapes), there is no auto-creation analog for Shipment anywhere in the codebase — confirmed by grepping every `DB.sh.push(` and `DB.sh[idx]=`/`DB.sh[i]=` occurrence in the file (§1.4 table).

**(b) Shipment has zero outward references to any other entity, of any kind.** Every prior entity had at least one field holding another entity's id, even if unconstrained (Order Request's `contactId`, Quote's `sourceContactId`, PO's `supId`/`quoteId`/`invId`, Invoice's `buyerId`/`linkedQuoteId`/`pos[]`/`lineItems[].lid`). Shipment's only reference-shaped field is `linkedInvs` (`index.html:12073`, `12089`) — a comma-split, manually-typed, free-text array of Invoice *numbers*, not ids. `REQ-CLOUD-006` §1.5 already found and confirmed this field is never dereferenced against `DB.inv` anywhere in the app; re-verified directly against this worktree, the finding still holds and the field is used in exactly four places, all display/edit-only: `editShp()`'s form population (`index.html:12062`), `saveShp()`'s own parse-and-store (`index.html:12072-12073`, `12089`), the Shipments list-table cell (`index.html:12026`), and the Forwarder Update Request message body (`index.html:12229`). No function anywhere calls `DB.inv.find()`/`.filter()` keyed on any element of `linkedInvs`. There is no id-shaped counterpart field for it either (no `linkedInvIds[]`) — a structural difference from the `FIELD_MAPS.cn`/`.po`/`.payments` gaps discussed in §1.6 below, which each had a real, live id field that Sheets sync silently failed to populate.

**(c) Shipment has zero inward references — nothing else in the app stores or resolves a Shipment id.** Confirmed by an exhaustive grep for `shId`, `shpId`, `shipmentId`, and any object literal in the file assigning a field from `DB.sh` element data (§1.4/§1.5) — no PO, Invoice, Quote, Order Request, or Payment field of any kind holds a Shipment's own `id`. This is a genuine first in the series: every previously-migrated entity is referenced inward by at least one other array (Order Request by `Quote.sourceOrdId`; Quote by `PO.quoteId`/`Invoice.linkedQuoteId`; Line Item by `PO`/`Invoice`/`Quote` line `.lid`; PO by `Invoice.pos[]`/`Quote.linkedPOIds[]`; Invoice by `PO.invId`/CN's self-reference/`DB.payments[].invId`).

**(d) Shipment needs no migration precondition.** Because (b) holds, `migrateShToSupabase()` has no FK to pre-flight-resolve against a live project, and needs no "Supplier/Buyer/Line Item/etc. must have migrated first" gate. This is not unprecedented in isolation — Order Request and Quote also required no precondition (`docs/architecture-data-model-v1.md` §8 point 4: "required no precondition on Supplier/Contact, since nothing inside a `jsonb` blob can be FK-constrained"; the Settings card note at `index.html:805`/`813` says the same for both) — but those two entities still hold real (if unconstrained) id-reference fields to Contact. Shipment needs no precondition **and** carries no reference field for a future precondition to ever apply to.

**(e) Consequently, `migrateShToSupabase()` needs zero external-reference sweep, in either direction.** No outward sweep (nothing downstream to rewrite when Shipment's own id changes, per (c)) and no inward cross-phase retrofit (confirmed by reading every `migrate*ToSupabase()` function body — `migrateSuppliersBuyersToSupabase()`, `migrateLineItemsToSupabase()`, `migrateContactsToSupabase()`, `migrateOrdToSupabase()`, `migrateQteToSupabase()`, `migratePOToSupabase()`, `migrateInvToSupabase()` — none contains any `DB.sh` reference). Every prior entity in this series needed at least the outward-sweep half of this (even Order Request's own id feeds `Quote.sourceOrdId`); Shipment needs neither half. This is the "zero-sweep" migration the series has not seen before.

**(f) Shipment has no CSV import path at all — not even a local-only one to leave alone.** Every prior entity's own REQ found a CSV-import branch (`processImport()`/`processImportRecords()`) that bypasses Cloud Data and gets logged, not fixed, as a `CLOUD-GAP-003` instance. Shipment has no such branch to find: grepping both functions for any `'sh'`/shipment-handling branch, and the CSV Upload section of the Import Data view (`index.html:476-586`, six numbered steps — Suppliers, Line Items, Invoices, Purchase Orders, Order Requests, Contacts, in that exact order, ending at the "Import Log" card, `index.html:511/523/535/551/563/575/587`) confirm there is no seventh step, no upload input, and no processing branch for Shipment anywhere. `docs/architecture-data-model-v1.md`'s own entity table independently confirms this (`docs/architecture-data-model-v1.md:44`, CSV import column: "✗ none"). There is therefore no `CLOUD-GAP-003` instance to add for Shipment (§3).

**(g) Shipment already merges correctly through `pullAll()`'s existing business-key path — the FIELD_MAPS bug class this series has found three times does not apply here, checked explicitly, not assumed.** `REQ-CLOUD-006` §8 (rounds 5-7) found the same defect three times: `FIELD_MAPS.X` mapped a business-key "Num" field to Sheets but omitted the matching id field, so a Sheets-sync-originated record genuinely new to the local app gets a correct Num and an undefined id, corrupting `pullAll()`'s bulk merge for that record. Checking this exact bug class against Shipment from first principles, not by analogy:
- `FIELD_MAPS.sh` (`index.html:4432`) maps `ref` (the business key) to Sheets but never `id` — this is **not** the bug class, it is the *correct*, deliberate shape every business-key-matched entity in this series uses (PO/Quote/Invoice/CN's `FIELD_MAPS` entries likewise never map their own `id`; `mapRec()`/`unmapRec()`, `index.html:4436-4458`, are symmetric around this). The bug class is specifically about an entity's *outward reference* fields (a Num mapped with no accompanying Id), not about the entity's own identity field.
- `findLocalMatchByBizKey('sh', ...)` (`index.html:4464`) matches a pulled Shipment record against the local array by `ref`, exactly like PO/Quote/Invoice/CN match by `num`.
- Shipment sits in `pullAll()`'s `simpleEnts`/`_simpleEntsForBatch` arrays (`index.html:4547`, `4647`), **not** in `idKeyedEnts` (`index.html:4660`, which lists only `['sup', 'payments', 'co']`) — so for a Shipment record with no local match (a genuinely new Sheet row), the merge loop's `else if (idKeyedEnts.indexOf(eKey) === -1)` branch (`index.html:4679-4680`) already assigns a fresh `m.id = uid()` before the record ever reaches `DB.sh`. This is confirmed live by an existing test (`tests/run.js:1842-1848`, "a fresh id was assigned to the genuinely new record").
- Shipment's only reference-shaped field, `linkedInvs`, has no id counterpart to omit in the first place (§1.1b) — there is no `FIELD_MAPS.sh` entry analogous to `FIELD_MAPS.cn`'s `linkedInvNum`-without-`linkedInvId` gap, because Shipment never had a `linkedInvIds[]` field to omit.

Conclusion: Shipment's `pullAll()` behavior is already correct today, and stays correct after migration provided the exclusion gate (§1.7, REQ-CLOUD-007h) is added using the same array-filter shape already proven for Line Item/Contact/Quote — not Purchase Order's separate `_allPullKeys` mechanism, since Shipment was never promoted to that path.

### 1.2 What stays the same

The established migration mechanics apply, minus the two steps that don't exist for a zero-sweep entity: vendored Supabase client already in place, mandatory blocking backup-export attestation before any migration runs, insert-and-map loop assigning fresh Supabase ids, archive-the-true-pre-migration-snapshot-before-remapping, soft-delete-only (enforced by omitting the delete RLS policy), 30-day local rollback archive, disconnect-on-restore. The "exhaustive external-reference sweep, both directions" step that every prior REQ needed (§1.5, §2) is, for Shipment specifically, a documented empty set rather than an omitted step — the SPEC must still state this explicitly and test it (AC-8), not silently skip it. Shipment's own local behavior — its modal, its validation, its list view, its Forwarder Update Request/Load Calculator features — does not change for an operator who has not connected Cloud Data or has not yet migrated Shipments.

### 1.3 `saveShp()`/`delShp()` risk profile

Both are already `async` (`index.html:12069`, `12105`). Both are called only from inline `onclick` handlers (`index.html:2461` for `saveShp()`; `index.html:12030` for `delShp()`) — grepped exhaustively for every call site of each function name in the file; no caller captures a return value from either, matching every prior `save*()`/`del*()` in this series (`REQ-CLOUD-004` §1.3, `REQ-CLOUD-005` §1.3 reached the identical conclusion for `saveQte()`/`saveOrd()`, `savePO()`/`delPO()`). No ripple-effect fix needed for adding a Cloud Data branch to either.

### 1.4 Every `DB.sh` mutation site (exhaustive — the smallest count of any entity in this series)

| Site | Lines | Local-only today? | Needs Cloud Data branch |
|---|---|---|---|
| `saveShp()` | `12069-12103` | create/update, the only creation path | ✓ own dedicated create-or-update branch |
| `delShp()` | `12105-12110` | delete — a plain `Array.filter()`, no soft-delete concept locally | ✓ own dedicated soft-delete branch |
| `loadDemoData()` | `4984-5001` (push at `5001`) | demo seed, guarded by `hasDemo` check (`4985-4987`) against `allArrays` (includes `DB.sh`) | out of scope — local-only by design, matching every prior entity's `_demo` precedent (§3); note `migratePOToSupabase()`'s own precedent (`index.html:6525-6538`, its `DB.po` insert loop) confirms a demo record is *not* filtered out of a migration's insert loop, it migrates like any other record with `_demo` simply excluded from the Supabase column set — `migrateShToSupabase()` follows the identical pattern, no special-casing needed |

Confirmed **not** mutation sites, verified during this REQ's own research (not merely assumed):

- **No `autoPos()`/`qteToPoConvert()`-style auto-creation function exists for Shipment.** Exhaustive grep for every `DB.sh.push(`/`DB.sh[idx]=`/`DB.sh[i]=` occurrence in the file surfaces only `saveShp()` and `loadDemoData()` (above). No other function creates a Shipment as a side effect of saving something else.
- **`scanForPhantomRecords()`/`executeDataCleanup()`** (`index.html:2954-2957`, `10382-10392`) — `'sh'` is included in the phantom-record filter list (a record with no `.id` is removed), which needs no change: a real Cloud-hosted Shipment always has a real id and can never be phantom, the same reasoning already accepted for every prior migrated entity. Shipment is **not** in the sequential-renumbering list (`index.html:10396`, `[['sup','SUP'], ['li','LI'], ['buy','BUY'], ['con','CON'], ['ord','ORD']]`) — consistent with `docs/architecture-data-model-v1.md:124`'s own finding that Shipment's `ref` is "not covered by `backfillRefNums()`" — so there is nothing for this REQ to retrofit here either.
- **`verifyFkIntegrityAfterCleanup()`** (`index.html:10339-10373`) — never references `DB.sh` at all; nothing to check, since Shipment has no FK for it to verify (§1.1c).
- **`backfillRefNums()`** (`index.html:2908-2938`) — does not include Shipment in its `assign()` calls (`2932-2936`); `ref` stays fully manual, unformatted, matching the architecture doc's own finding. No change needed or possible here.
- **CSV import (`processImport()`/`processImportRecords()`)** — no `'sh'` branch exists in either function; confirmed by grep and by the Import Data view's own six-step CSV section (§1.1f). Nothing to defer or log — there is no local-only behavior to leave unchanged, because there is no behavior at all.
- **The AI-assistant dispatch path needs no Cloud Data handling — confirmed, not assumed**, mirroring the "confirm, don't assume" bar `REQ-CLOUD-006` §1.6 applied to its own AI-path check (itself citing `REQ-CLOUD-003`'s round-1 history of wrongly assuming an AI-adjacent function was safe). `AI_TOOLS` (`index.html:11203-11267`) lists six read-only tool schemas — `get_invoices`, `get_payments`, `get_kpis`, `get_pos`, `get_suppliers`, `get_buyers` — no `get_shipments` tool exists. `_aiExecTool()` (`index.html:11269` onward) implements exactly those six; the only one touching `DB.sh` is `get_kpis` (`index.html:11309-11339`), which reads two read-only aggregate counts, `inTransitShipments` (`11333`) and `totalShipments` (`11336`) — no write path. The `create_shipment` action block (`index.html:11113-11120`) only pre-fills the `ov-shp` modal's fields via `openShp()`; the actual write still goes through `saveShp()` (§1.4's own row above) exactly like every other `create_*` action block in this series.
- **`expAll()`/`doImport()`** (full JSON backup) — includes `DB.sh` in its snapshot already (unaffected by this REQ); `CLOUD-GAP-001` (Cloud Data connection fields excluded from the backup) is pre-existing and unrelated to Shipment specifically.

### 1.5 External-reference sweep, both directions

**Inward** — Shipment's own migration performs no inward remapping itself; it has no field referencing another entity's id at all (§1.1b).

**Outward** — Shipment's own id, once remapped by its own migration, needs no sweep into any other entity's field, because none exists (§1.1c). This is stated explicitly, not silently omitted, because every prior REQ in this series had a real, non-empty version of this section (`REQ-CLOUD-005` §1.5: `Quote.linkedPOIds[]`/`Invoice.pos[]`/`DB.supPayments[].poId`; `REQ-CLOUD-006` §1.5: `PO.invId/invNum`, CN's self-reference, `DB.payments[].invId`) and the SPEC/build-gate process for this REQ should not mistake an empty result for a skipped step.

### 1.6 Cross-phase retrofit sites, both directions

**None, in either direction — confirmed empty, not merely absent from the mutation-site table.** Every `migrate*ToSupabase()` function currently in the codebase (`migrateSuppliersBuyersToSupabase()` `index.html:6074-6165`, `migrateLineItemsToSupabase()` `6167-6257`, `migrateContactsToSupabase()` `6259-6334`, `migrateOrdToSupabase()` `6336-6394`, `migrateQteToSupabase()` `6396-6496`, `migratePOToSupabase()` `6498-6600`, `migrateInvToSupabase()` `6602-6784`) was read in full and grepped for any `DB.sh` reference — none exists. `migrateShToSupabase()` itself, once built, needs no outward retrofit into any other entity's migration function either, since nothing downstream needs a push-if-migrated fix (§1.5). This is the first entity in the series needing genuinely zero cross-phase retrofit sites in either direction — every previously-migrated entity needed at least the outward half (even Order Request's own id feeds into `Quote.sourceOrdId`, requiring `migrateOrdToSupabase()` to gain the mirror-image outward retrofit for Quote at that time).

### 1.7 Sheets/`pullAll()` integration

Shipment sits in `pullAll()`'s `_simpleEntsForBatch` (`index.html:4547`) and `simpleEnts` (`index.html:4647`) arrays today, matched by business key (`ref`) via `findLocalMatchByBizKey()` (§1.1g) — the same code path as Line Item/Contact/Quote, **not** Purchase Order's/Invoice's separate `_allPullKeys`/per-block-guard mechanism (`REQ-CLOUD-005` §1.1a; `index.html:4552-4554`, `4574`, `4625`). Excluding Shipment from this pull once `st_sh_cloud_migration_ts` is set is a one-line filter addition to *both* arrays, mirroring exactly the existing Line Item/Contact/Quote precedent (`index.html:4549-4551`, `4657-4659`) — a straightforward array-filter, not the two-part mechanism Purchase Order needed. `syncAll()`/`pushAll()`'s push-direction has no equivalent exclusion for any entity in this series (`CLOUD-GAP-002`, accepted, not this REQ's job to fix — see §3).

### 1.8 Findings with no precedent among the 8 already-migrated entities

- **The first entity in this series with zero outward references, zero inward references, and therefore zero external-reference sweep needed in either direction** (§1.1b/c/e, §1.5, §1.6) — every prior entity needed at least the outward-sweep half.
- **The first entity in this series with no CSV import path to leave alone or log** (§1.1f) — every prior entity's REQ found a real `CLOUD-GAP-003` instance to defer; Shipment has no branch to defer.
- **The first entity in this series with only one creation/update function and no migration precondition simultaneously.** Order Request and Quote also needed no precondition, but each still holds a real (if unconstrained) reference field to Contact; Line Item/Contact/PO/Invoice all needed a precondition. Shipment needs neither a precondition nor carries a field a future precondition could ever apply to.
- **A new, pre-existing (not introduced by this REQ) data-quality gap surfaced during check-first, not previously logged with a gap number:** Shipment has **zero audit trail of any kind** — no `logEv()`, no `audit()` — on create, edit, or delete, confirmed by reading `saveShp()`/`delShp()` in full (`index.html:12069-12110`, neither function calls either logging mechanism) and independently corroborated by `docs/architecture-data-model-v1.md` §6.5 ("Shipments have zero audit trail of any kind... confirmed by exhaustive grep, not inference") and §5.7 ("Line Item and Shipment are covered by neither \[`logEv()`/`audit()`\] for full lifecycle tracking"). This is unrelated to Cloud Data migration correctness (mirroring how `REQ-CLOUD-006` found and logged `CN-GAP-001`/`INV-GAP-002` as new, adjacent-but-separate gaps rather than folding a fix into the migration) — recommend logging as a new `SH-GAP-001` at ship time (§3, §7), not fixed here.
- **The FIELD_MAPS Num-without-Id bug class, explicitly checked against from first principles and confirmed not applicable** (§1.1g) — the third-time-found bug class this task was specifically asked to guard against up front. Shipment's shape (a free-text join field with no id counterpart at all, rather than a mapped-Num/unmapped-Id pair) is categorically different from the CN/`PO`/`payments` instances that bug class exploited, and this REQ's own research reached that conclusion by tracing the actual merge code path (`idKeyedEnts` exclusion, the existing `uid()` fallback assignment, and the corroborating test at `tests/run.js:1842-1848`), not by assumption.

---

## 2. Requirements

**REQ-CLOUD-007a.** New `supabase/migrations/0007_shipments.sql` table `shipments`, mirroring the RLS/soft-delete shape of `0001`-`0006`. Column list resolved against the full field set `saveShp()` (`index.html:12074-12094`) builds into a `shp` object:

| Local field | Column | Type | Notes |
|---|---|---|---|
| `id` | `id` | `uuid` (PK, `gen_random_uuid()`) | |
| `ref` | `ref` | `text not null unique` | manually entered, no format check anywhere (`docs/architecture-data-model-v1.md:124`), exact-match uniqueness enforced client-side by `vShp()`/`vBlurShpRef()` (`index.html:9392-9399`, `9557-9571`) — see REQ-CLOUD-007c |
| `blNum` | `bl_num` | `text` | |
| `vessel` | `vessel` | `text` | |
| `carrier` | `carrier` | `text` | |
| `originPort` | `origin_port` | `text` | |
| `destPort` | `dest_port` | `text` | |
| `etd` | `etd` | `text` | matches `Quote.dt`'s/`PurchaseOrder.date`'s precedent exactly — a bare `<input type="date">.value` string, never a JS `Date`, never reformatted |
| `eta` | `eta` | `text` | same as `etd` |
| `containerType` | `container_type` | `text` | fixed set of options in the UI (`20GP`/`40HQ`/`LCL`/`Other`, `index.html:2442`) but not enum-constrained at the database level, matching every prior free-text-with-UI-select field in this series |
| `containerNum` | `container_num` | `text` | |
| `dg` | `dg` | `boolean` | |
| `docsStatus` | `docs_status` | `text` | |
| `status` | `status` | `text not null` | |
| `linkedInvs` | `linked_invs` | `jsonb not null default '[]'::jsonb` | free-text array of Invoice numbers (not ids) — confirmed never dereferenced (§1.1b); matches `Quote.linked_po_ids`'s `jsonb` array-column precedent (`supabase/migrations/0004_quotes.sql`) |
| `forwarder` | `forwarder` | `text` | |
| `forwarderEmail` | `forwarder_email` | `text` | |
| `notes` | `notes` | `text` | |
| `updAt` | `upd_at` | `timestamptz` | set by `saveShp()` on every save (`index.html:12093`), both create and update — unlike Purchase Order, there is no second creation path with a different timestamp convention, so no `creAt`/`updAt` asymmetry exists here |
| `_demo` | *(excluded)* | — | local-only demo-data marker, matching every prior entity's identical precedent — carries forward unchanged locally, never sent to Supabase |

Standard `created_at`/`updated_at`/`deleted_at` Postgres-managed columns are additional to the above, matching every prior migration in this series.

**REQ-CLOUD-007b.** `migrateShToSupabase()` requires **no migration precondition on any other entity** — confirmed by §1.1b/d that Shipment carries no FK field of any kind. The SPEC must state this explicitly as an in-code comment (mirroring `migrateOrdToSupabase()`'s own explicit "no Supplier- or Contact-migration-completion precondition" comment, `index.html:6340-6342`, and `migrateQteToSupabase()`'s equivalent, `index.html:6402-6404`) rather than silently omitting a precondition check that a reader might otherwise assume was simply forgotten.

**REQ-CLOUD-007c.** A real pre-flight duplicate-`ref` scan, exact match (Shipment's `ref` has no case-normalization anywhere, same as PO's `num`/Quote's `num`/Invoice's `num`), blocking migration via a dedicated modal or a reuse decision. Four near-identical dedicated duplicate-scan modals already exist today — `ov-sb-dup` (Supplier, `index.html:2719-2726`), `ov-qt-dup` (Quote, `2731-2738`), `ov-po-dup` (Purchase Order, `2743-2750`), and `ov-inv-dup` (Invoice/Credit Note, `2755-2762`), each with its own hardcoded modal title per `REQ-CLOUD-004` §0.2's finding that these titles are not injectable markup, and each wired through its own `find*DupNums()`/`show*DupConflictModal()` helper pair (`findDuplicateQuoteNums()`/`findDuplicatePONums()`/`findDuplicateInvNums()`, `index.html:5982-6010`; `showQteDupConflictModal()`/`showPoDupConflictModal()`/`showInvDupConflictModal()`, `index.html:6012-6028`) — Supplier's own equivalent is `showDuplicateConflictModal()` (`index.html:5976-5980`), a same-shape but differently-named outlier. Confirm at SPEC time whether a fifth near-identical `ov-sh-dup` is warranted, or whether the pattern should finally be generalized into one shared, parameterized component — the same open question `REQ-CLOUD-005` §2c/§3 raised at the third instance and deferred each time since; now one instance more pressing at the fifth.

**REQ-CLOUD-007d.** `saveShp()` gains its own dedicated `_sb`-branch (create/update), gated on `_sb && localStorage.getItem('st_sh_cloud_migration_ts')` — mirroring `savePO()`'s/`saveQte()`'s marker-gated shape (`index.html:8826`, `index.html:12881`, both `_sb && st_..._cloud_migration_ts` checks) rather than `saveLI()`'s bare `if (_sb)` check (`index.html:7082`) — Line Item's own guard condition is not the correct template for an independently-migrated, marker-gated entity like Shipment; confirm at SPEC time this distinction is preserved. No `persistShChange()` helper is needed (§2f) since there is no dependent side-effect ordering concern and no other mutation site to share it with.

**REQ-CLOUD-007e.** `delShp()` gains its own dedicated soft-delete `_sb`-branch, mirroring `delPO()`'s exact shape (`index.html:8883-8887`, `.update({deleted_at: new Date().toISOString()}).eq('id', id)`, not a hard delete) gated on the same `st_sh_cloud_migration_ts` marker. No downstream array cleanup is needed in the same change (unlike `delPO()`'s `PO-GAP-007` fix) since nothing anywhere references a Shipment id (§1.5).

**REQ-CLOUD-007f.** No shared `persistShChange()` helper is needed — the first entity in this series not requiring one, since the mutation-site inventory (§1.4) contains no site outside `saveShp()`/`delShp()` themselves.

**REQ-CLOUD-007g.** No cross-phase retrofit work is needed in either direction (§1.6) — confirmed empty, not merely unaddressed. The SPEC/build-gate process should record this as a verified-empty result (e.g. an explicit test or a documented grep-audit step, per AC-8), not treat its absence from the diff as an oversight.

**REQ-CLOUD-007h.** `pullAll()` exclusion for `'sh'` once `st_sh_cloud_migration_ts` is set, via the same one-line array-filter shape already used for Line Item/Contact/Quote (`index.html:4549-4551`, `4657-4659`), applied to both `_simpleEntsForBatch` (`4547`) and `simpleEnts` (`4647`) — **not** Purchase Order's/Invoice's separate `_allPullKeys`/per-block-guard mechanism, since Shipment was never promoted to that pull path (§1.1g/§1.7). No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

**REQ-CLOUD-007i.** Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only — the same mechanics every prior Cloud Data migration in this series has used, with `st_sh_cloud_migration_ts`/`st_sh_pre_migration` as Shipment's own independent marker pair. Because there is no outward sweep to perform (§1.5), the insert-and-map loop only needs to build `shIdMap` for Shipment's own local-id-to-Supabase-id remap at the end (`DB.sh.forEach(function(s){ if (shIdMap[s.id]) s.id = shIdMap[s.id]; })`, mirroring the tail of every prior `migrate*ToSupabase()` function) — no consumer of that map exists beyond this.

**REQ-CLOUD-007j.** New `refreshShFromSupabase()`, wired into `initCloudDataLayer()` with the standard non-destructive guard (refuse to overwrite real local data unless this device has migrated or there is nothing local to lose), matching every prior entity's refresh function. New Settings → Cloud Data (Shipments) card, matching the existing per-entity card pattern (migrate button, restore-from-archive button) — its explanatory note should read "Independent of every other entity's migration — no other entity needs to migrate first" (mirroring the existing Order Request/Quote card notes at `index.html:805`/`813`), since that is genuinely true for Shipment too (§1.1d).

**REQ-CLOUD-007k.** `AI_SYSTEM_PROMPT` and `docs/user-guide.md`'s Cloud Data descriptions updated to name Shipment as the eighth independently-migratable entity.

**REQ-CLOUD-007l.** No CSV import work of any kind — there is no existing branch to leave local-only, defer, or log under `CLOUD-GAP-003` (§1.1f, §1.4). This item exists in the requirements list only to record, explicitly, that this REQ's own check-first process looked for the CSV-import item every other REQ in this series has needed and confirmed there is nothing here to do — not to leave a silent gap where every prior REQ had a corresponding requirement.

---

## 3. Out of scope

- **Sub-phase 3** (Buyer Payment, Supplier Payment) — explicitly the next, unscoped, future step, deliberately still deferred behind `REQ-INTEG-002` 2c/2d per `REQ-CLOUD-006` §0 (§0 above).
- **`SH-GAP-001`** (new, logged from §1.8): Shipment has zero audit trail (`logEv()`/`audit()`) on create/edit/delete, and its `ref` is manually entered with no format check and is not covered by `backfillRefNums()`. Pre-existing, unrelated to Cloud Data migration correctness, not fixed here — logged at ship time (§7), mirroring how `REQ-CLOUD-006` logged `CN-GAP-001`/`INV-GAP-002` rather than folding an unrelated fix into a migration REQ.
- **`CLOUD-GAP-001`/`002`** — pre-existing, unrelated to Shipment specifically, unaffected by this REQ.
- **`CLOUD-GAP-003`** — **not broadened by this REQ.** Unlike every prior entity in this series, Shipment has no CSV-import branch of any kind to add as a new instance (§1.1f, §1.4) — confirmed, not merely unmentioned. Recorded here explicitly so a future reader does not assume an omission.
- **Adding a CSV import capability for Shipment** — a feature gap (`docs/architecture-data-model-v1.md`'s own entity table already flags this as a pre-existing capability gap, not something this migration should be conflated with), not a Cloud Data concern, not built here.
- **Adding `logEv()`/`audit()` calls to `saveShp()`/`delShp()`** — tracked as `SH-GAP-001`, deliberately not fixed as part of this migration REQ.
- **A unified duplicate-scan-modal component** — the same open question `REQ-CLOUD-005` §2c/§3 raised and deferred to SPEC time; not re-litigated here as a requirement of this migration.
- **Per-record `syncEnt()`/`delEnt()` retirement for Shipment** — matches every prior entity's precedent: Sheets push (`syncEnt`) keeps running for Shipment regardless of Cloud Data state (only the *pull* side is excluded once migrated, per `CLOUD-GAP-002`).
- **The `v3.0.0` multi-tenant rebuild** (`docs/v3-architect-handoff.md`) — a separate, unscoped future initiative; this REQ's schema is expected to need redesign for tenant isolation later, an accepted tradeoff already priced into every prior Cloud Data sub-phase (§0).

---

## 4. Acceptance criteria

- **AC-1.** `supabase/migrations/0007_shipments.sql` matches REQ-CLOUD-007a's full column list exactly; `_demo` absent; `linked_invs` is a `not null default '[]'::jsonb` array column, not FK-constrained (it holds Invoice numbers, not ids, and Invoice-number matching happens client-side only, never as a database constraint).
- **AC-2.** A Cloud-configured `saveShp()` create inserts with no client-generated id, resolves the real Supabase-assigned id onto the local record, and calls `.update(...).eq('id',...)` (not `.insert()`) on a subsequent edit of the same record; local-only behavior is unchanged when Shipment has not migrated.
- **AC-3.** A Cloud-configured `delShp()` soft-deletes via `.update({deleted_at:...})`, not a hard delete; local-only behavior (a plain array filter) is unchanged when Shipment has not migrated.
- **AC-4.** `migrateShToSupabase()` runs to completion with **zero** other entities migrated — demonstrated with a fresh/default Cloud Data configuration (no Supplier, Buyer, Line Item, Contact, Order Request, Quote, or Purchase Order migration marker set), confirming REQ-CLOUD-007b's "no precondition" claim is real, not merely undocumented.
- **AC-5.** Migration is blocked by a duplicate `ref` (case-sensitive exact match) before any row is inserted.
- **AC-6.** `pullAll()` drops `'sh'` from both `_simpleEntsForBatch` and `simpleEnts` once `st_sh_cloud_migration_ts` is set; `syncAll()`/`pushAll()` are unaffected (matching `CLOUD-GAP-002`'s existing, accepted scope).
- **AC-7.** `refreshShFromSupabase()` refuses to overwrite real local data absent a completed migration or existing local data, matching every prior entity's refresh function.
- **AC-8.** A dedicated test (or documented audit step) demonstrates the zero-sweep claims of §1.5/§1.6/REQ-CLOUD-007g/i are genuinely empty on the current codebase — e.g. asserting no other entity's array is touched by `migrateShToSupabase()`, and that no `migrate*ToSupabase()` function references `DB.sh` — so a future code change that silently introduces a real Shipment reference (e.g. a new `Invoice.shipmentId` field) cannot slip past this REQ's own "nothing to sweep" assumption undetected.
- **AC-9.** Full pre-existing-test-suite audit, mirroring every prior REQ's own equivalent: every direct test-suite call site of `saveShp()`/`delShp()` traced and confirmed safe against whatever async-conversion changes this REQ introduces (both are already `async`, per §1.3, so this is expected to be a short list, not a long one).
- **AC-10.** CSV import (`processImport()`/`processImportRecords()`) and the AI-assistant dispatch path are demonstrated **unaffected** by this REQ — no `'sh'` branch exists in either import function, and `_aiExecTool()`/`create_shipment` behavior is unchanged (no Cloud Data path exists to test, per REQ-CLOUD-007l/§1.4).

---

## 5. Testing approach

The smallest test-addition footprint in this series so far, following directly from §1's findings: no multi-creation-path fixture (Shipment has one), no self-referential or array-element remap test (Shipment sweeps nothing), no combined-precondition fixture (Shipment has none). `mockSb()` harness (already fully generic per-table, no changes needed for a new `shipments` table). Mirrors the mechanical shape of `REQ-CLOUD-002`'s Contact migration (also precondition-light, single creation path) more closely than Purchase Order's or Invoice's, per-entity independent migration marker, `testAsync`/`await` throughout, and a dedicated test-hygiene cleanup test appended after this REQ's own test block, per the placement convention corrected during `SPEC-CLOUD-004`'s own spec-gate round 1 (B7).

---

## 6. Gate process

Follows the same rigorous SDLC pipeline as every prior REQ/SPEC in this series: REQ → independent requirements-gate review (Agent) → SPEC (exact diffs) → independent spec-gate review (Agent, applies diffs to a scratch copy, runs the real test suite) → implementation → self-directed mutation testing → independent build-gate review (Agent) → PR → CI green → merge → verify main consistent.

---

## 7. Tracker updates (at ship time)

- `docs/requirements-tracker.md` — new `REQ-CLOUD-007` row.
- `docs/known-gaps.md` — new `SH-GAP-001` entry (zero audit trail, unformatted `ref`, §1.8/§3), logged not fixed; confirm `CLOUD-GAP-003`'s existing title/Area line is **not** touched, since Shipment adds no new instance to it (§3).
- `docs/version-history.md` / `STACKD_CONTEXT.md` / `CLAUDE.md` — new version entry; test count bump; a note on Shipment joining Cloud Data as the first zero-sweep, zero-precondition migration in the series, if that turns out to be a genuinely new lesson worth a CLAUDE.md callout (mirroring how `REQ-CLOUD-004`'s outward-sweep pattern and `REQ-CLOUD-005`'s array-field-sweep pattern each became their own CLAUDE.md notes).
- `docs/architecture-data-model-v1.md` §8 — sequencing item 5 updated to mark Shipment's own sub-phase done, two of three Phase 3 entities remaining unscoped; §2's entity table (Shipment row, `docs/architecture-data-model-v1.md:44`) and §4.3's Shipment paragraph (`docs/architecture-data-model-v1.md:124`) both gain a Cloud Data migration note, mirroring every prior migrated entity's equivalent update, while preserving the paragraph's still-accurate "weakest-governed entity," zero-audit-trail, and no-CSV-import findings (now cross-referenced to `SH-GAP-001` instead of standing as unlogged prose).
- `docs/user-guide.md` — Settings → Cloud Data section updated for the new Shipment card.

---

## 8. Review-resolution log

*(Empty — this is v1, pre-review. Populated at requirements-gate round 1.)*
