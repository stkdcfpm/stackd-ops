# REQ-CLOUD-005 — Purchase Order Cloud Data migration

**Status:** v1 — drafted. Ready for requirements-gate round 1.

---

## 0. Scoping

This is **Phase 2, sub-phase 3 of 3** of the cross-platform backend migration's deal-pipeline step (`docs/architecture-data-model-v1.md` §8) — the final sub-phase of Phase 2, per the scoping decision made in `REQ-CLOUD-003` §0 and reaffirmed in `REQ-CLOUD-004` §0 (sub-phase 1: Order Request, shipped v2.9.74 → sub-phase 2: Quote, shipped v2.9.75 → **sub-phase 3: Purchase Order, this REQ**).

Purchase Order is chosen next because it is the only entity left in the deal pipeline still fully local, and because it is explicitly named in both prior sub-phases' own scoping language as the final piece: `REQ-CLOUD-004` §1.5 states Order Request's `activeQuoteId` and Invoice's `linkedQuoteId` are outward references into Quote that Quote's own migration sweeps, but `PurchaseOrder.quoteId` was fixed only as "a plain local field" at that time because — in `REQ-CLOUD-004`'s own words (`SPEC-CLOUD-004-v1.md` §2.7) — "PurchaseOrder.quoteId/Invoice.linkedQuoteId ... are safe as plain local fixes — neither entity has a Supabase table." This REQ makes that statement half-false: once Purchase Order migrates, `migrateQteToSupabase()`'s existing local fix to `PurchaseOrder.quoteId` needs the same cross-phase retrofit treatment every other inward-facing sweep in this series has already received.

After this REQ ships, **Phase 2 (the deal pipeline) is complete.** Phase 3 — Invoice, Credit Note, Shipment, and both Payment ledgers (`docs/architecture-data-model-v1.md` §8 item 5) — remains explicitly future, unscoped work, not to be started without further instruction, exactly as Purchase Order was treated after Order Request shipped and after Quote shipped.

---

## 1. Business context

### 1.1 Why Purchase Order differs from every prior entity in this series

Four things make Purchase Order a materially different migration profile than Supplier/Buyer, Line Item/Contact, Order Request, or Quote — each of which introduced exactly one kind of novel complexity. Purchase Order combines several of those *and* adds two of its own.

**(a) Purchase Order already has real, live Google Sheets sync — and it is not the "simple entity" shape.** Order Request had zero Sheets footprint. Quote had real Sheets sync, but through the `simpleEnts`/`_simpleEntsForBatch` arrays that `pullAll()` already knows how to gate on a migration marker (a one-line filter added to each array). Purchase Order is **not** in either of those arrays — it is one of only three entities (`inv`, `cn`, `po`) pulled through a separate, id-keyed code path (`_allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch)`, followed by its own `dPo = await pulled('po')` block with business-key matching via `findLocalMatchByBizKey`). Excluding Purchase Order from Sheets pull once it has migrated needs new logic shaped to *this* code path, not a copy of Quote's one-line array filter.

**(b) Purchase Order's own migration precondition combines two patterns no single prior entity needed together.** `vPO()` requires a Supplier on every Purchase Order (`if (!sup) return vErr('pf-sup', 'Please select a supplier')` — `index.html:8691`) — the same "every record must have a real Supplier" shape Line Item had, which needed both a genuine Supplier-migration-completion precondition and a live pre-flight scan verifying every local `supId` actually resolves against the *connected* Supabase project (`migrateLineItemsToSupabase()`'s `knownSupIdSet` pattern). Separately, `vPO()` also enforces a **local-only** uniqueness check on `num` (`index.html:8688-8689`) that is manually entered with no case-normalization — the same shape Quote had, which needed a genuine pre-flight duplicate-number scan against the live project rather than a documented no-op. Purchase Order needs *both* checks, a combination no prior entity in this series has required.

**(c) Purchase Order's own id is referenced outward by an array field, not a scalar.** `Quote.linkedPOIds[]` is a list — a Quote converted to multiple Purchase Orders (one per distinct Supplier in its line items, per `qteToPoConvert()`'s grouping logic) holds several PO ids in one array. Quote's own outward sweep in `REQ-CLOUD-004` only ever needed to rewrite scalar fields (`Order Request.activeQuoteId`, `PurchaseOrder.quoteId`, `Invoice.linkedQuoteId`). Sweeping an array field — finding each element that matches an old PO id and replacing it in place, potentially several elements per Quote — is new.

**(d) Two confirmed-live mutation sites exist entirely outside `savePO()`/`delPO()`, found during this REQ's own research, not previously logged anywhere.** When an Invoice is marked `Paid`, both `saveInv()` (`index.html:6923-6929`) and a second Invoice-payment-application code path (`index.html:12708-12718`) independently walk `getInvoicePOs(inv)` and, for any linked Purchase Order with `fpmFunded > 0 && !fpmRecovered`, mutate `po.fpmRecovered = true` and `po.updAt = ...` directly, then persist via a bare `sv(K.p, DB.po)` plus `syncEnt('po', po)` — bypassing whatever Cloud Data branch this REQ adds to `savePO()`/`delPO()` entirely. This is the same class of defect `REQ-CLOUD-002`/`REQ-CLOUD-003` each found late (a mutation site outside the entity's own save/delete path, silently discarded on the next Cloud refresh once the entity has migrated) — caught here during REQ drafting instead of a late spec-gate round, but still needing a real fix, not a documented no-op.

### 1.2 What stays the same

The established 9-step migration mechanics apply unchanged: vendored Supabase client already in place, mandatory blocking backup-export attestation before any migration runs, insert-and-map loop assigning fresh Supabase ids, exhaustive external-reference sweep (both directions, per 1.1c/1.5 below), archive-the-true-pre-migration-snapshot-before-remapping, soft-delete-only (enforced by omitting the delete RLS policy), 30-day local rollback archive, disconnect-on-restore, and a `dr-procedure.md` rollback section. Purchase Order's own local behavior — its forms, its validation, its print preview, its Supplier Payment tab — does not change for an operator who has not connected Cloud Data or has not yet migrated Purchase Orders.

### 1.3 `savePO()`/`delPO()` risk profile

Both are already `async` (`savePO()` since `syncEnt()`/`await` were introduced for Sheets sync; `delPO()` likewise for `delEnt()`). Confirm during SPEC drafting whether any caller anywhere captures either's return value (expected: no, mirroring every prior `save*()`/`del*()` in this series) — if confirmed, no ripple-effect fix is needed for adding a Cloud Data branch to either, the same conclusion `REQ-CLOUD-004` §1.3 reached for `saveQte()`/`delQte()`.

### 1.4 Mutation-site inventory

Confirmed mutation sites needing a Cloud Data branch or retrofit:

1. **`savePO()`** (`index.html:8029-8040`) — the primary create/update path. Needs its own dedicated `_sb`-branch, mirroring `saveOrd()`/`saveQte()`'s shape (not routed through a shared `persistPOChange()` helper, for the same reason those two weren't: a create needs to assign a fresh id before any dependent side effect runs).
2. **`delPO()`** (`index.html:8066-8079`) — the soft-delete path. Currently sweeps `Invoice.pos[]` locally (a plain array-splice, `index.html:8069-8074`) but has never swept `Quote.linkedPOIds[]` at all — this is **`PO-GAP-007`**, logged during `REQ-CLOUD-003`'s own research and explicitly deferred here. Fixing it is now in scope: `delPO()` should remove the deleted PO's id from any Quote's `linkedPOIds[]`, pushing the touched Quote back to Supabase if Quote has migrated (the same "local fix isn't enough once the referenced entity has its own table" reasoning as every other retrofit in this REQ).
3. **`qteToPoConvert()`'s PO-creation portion** (`index.html:12157-12210`, per current line numbers as of v2.9.75) — currently fully local regardless of Cloud Data state, by `REQ-CLOUD-004`'s own explicit design ("Purchase Order is not Cloud-Data-eligible"). Needs a real Cloud Data branch. Structurally different from every other entity's create path in this series: a single call can create **multiple** Purchase Orders at once (one per distinct Supplier among the Quote's line items) — the Cloud Data branch must insert each one, collect every real Supabase-assigned id, and write the complete resulting id list into `q.linkedPOIds` before `persistQteChange(q)` runs (mirroring `saveQte()`'s "reset id before dependent side effects" lesson from `REQ-CLOUD-004`, generalized to a list instead of a single id).
4. **The two FPM-funded-deposit auto-recovery sites** (`index.html:6923-6929` inside `saveInv()`, and `index.html:12708-12718` in the Invoice-payment-application path) — both mutate an *existing* Purchase Order's `fpmFunded`/`fpmRecovered`/`updAt` outside `savePO()` entirely. Both need to route through a new shared `persistPOChange(po, skipRefresh)` helper (mirroring `persistOrdChange()`/`persistQteChange()`) instead of the current bare `sv(K.p, DB.po)` + `syncEnt('po', po)`.

Confirmed **not** mutation sites, verified during this REQ's own research (not merely assumed):

- **`delSup()`** — per `docs/architecture-data-model-v1.md` §4.2, already confirmed warn-and-allow: it leaves `PO.supId` dangling by design, never mutates it. No change.
- **`delCon()`** — Contact has no field on Purchase Order to dangle; Purchase Order's only Contact-adjacent path is through Order Request/Quote, not directly. No change.
- **`migrateQtePoShape()`** (`index.html:2936-2951`) — a legacy repair migration converting old-shape Purchase Orders (`po.lines`/`po.dt`/`po.fpm`/`po.rec`) to the current shape (`po.lineItems`/`po.date`/`po.fpmFunded`/`po.fpmRecovered`). Its guard is `if (po.lines && !po.lineItems)` — a Purchase Order ever created or refreshed from Supabase always carries the current shape (`migratePOToSupabase()`'s insert and `refreshPOFromSupabase()`'s mapping both always populate `lineItems`, never `lines`), so this guard can never fire for a cloud-hosted record. Same disposition `REQ-CLOUD-004` gave `migrateLinkedPOIds()`: left on `saveAll()`, confirmed structurally unable to touch a cloud-migrated record.
- **`backfillInvoicePOs()`** (`index.html:2915-2934`) — rebuilds `Invoice.pos[]` by scanning whatever `DB.po` currently holds. Since it reads the in-memory/localStorage mirror (which stays correct post-migration via the standard refresh pattern) rather than caring whether an id is a local `uid()` or a Supabase UUID, this function needs no change regardless of Purchase Order's migration state.
- **`processImport()`'s `'po'` CSV-import branch** (`index.html:8967-8990`-ish) — bypasses Cloud Data entirely, writing straight to `DB.po` via a bare `sv(K.p, DB.po)`. Same class of gap as the already-accepted `CLOUD-GAP-003` (Supplier/Line Item/Contact's CSV importers). Candidate for a `CLOUD-GAP-003`-style logged-not-fixed entry, not an in-scope fix — see §3.

### 1.5 External-reference sweep, both directions

**Inward** — Purchase Order's own migration performs no inward remapping itself. `supId` and `quoteId` are whatever they currently are locally at migration time (already correct, since Supplier's and Quote's own migrations are what keep those fields current going forward); `invId`/`invNum` reference Invoice, which is not Cloud-eligible at all (Phase 3) and stays a plain `text` column matched by business key, exactly like every other not-yet-migrated reference in this series.

**Outward** — Purchase Order's own id, once remapped by its own migration, must be swept into every other entity's field that references it:

- **`Quote.linkedPOIds[]`** — an array, not a scalar (see §1.1c). Match each element against Purchase Order's id-map; for every Quote actually touched, push it back to Supabase via `persistQteChange(q, true)` if Quote has already migrated (mirroring `REQ-CLOUD-004`'s own outward retrofit onto Order Request, run here in the mirror-image direction).
- **`Invoice.pos[]`** — also an array. Invoice is not yet Cloud-eligible; a plain local fix (`sv(K.i, DB.inv)`) is correct and sufficient, matching how `PurchaseOrder.quoteId`/`Invoice.linkedQuoteId` were correctly left as plain local fixes by `REQ-CLOUD-004` for the entities that, at that time, had no Supabase table.
- **`DB.supPayments[].poId`** — the Supplier Payment ledger (`REQ-INTEG-002` sub-phase 2a) is not yet Cloud-eligible. Plain local fix (`sv(K.spm, DB.supPayments)`). Confirm during SPEC drafting whether `payment.poNum` (also present per `index.html:12936`/`12943`) needs updating too, or is an intentionally-immutable historical snapshot of the PO number at the time the payment was recorded — do not assume without checking every read site.

### 1.6 Cross-phase retrofit sites, both directions

**Inward** (existing sweep functions that already touch `DB.po` and need touched-tracking plus a push-if-Purchase-Order-has-migrated retrofit):

- **`migrateSuppliersBuyersToSupabase()`** — already sweeps `DB.po.forEach(p => supId remap)` (`index.html:5818`). Needs the retrofit.
- **`migrateQteToSupabase()`** — already sweeps `DB.po.forEach(p => quoteId remap)` (`index.html:6106`) as part of its own `REQ-CLOUD-004` outward sweep. This is the specific line `REQ-CLOUD-004`'s own comment called "safe as plain local fix... neither entity has a Supabase table" — that comment needs updating alongside the retrofit itself.
- **`migrateLineItemsToSupabase()`** — already sweeps `DB.po.forEach(po => (po.lineItems||[]).forEach(li => lid remap))` (`index.html:5900`). Confirm during SPEC drafting whether Purchase Order's `lineItems[].lid` is ever actually populated by any code path (Quote's equivalent field was confirmed dead in `REQ-CLOUD-004`; Purchase Order's may or may not be — `addPLI()`'s line-item shape includes an `lid` key initialized to `''`, suggesting it is likewise never populated in practice, but this must be verified, not assumed) — either way, the retrofit is added, checked but not skipped, per this series' own established convention for a field suspected dead.

Confirmed **not** retrofit sites, verified during this REQ's own research: **`migrateContactsToSupabase()`** and **`migrateOrdToSupabase()`** — neither function's body contains any `DB.po` reference (grepped directly; Purchase Order has no Contact field and no direct Order Request field, only reaching Order Request transitively through Quote). Confirm this holds during requirements-gate via an independent search, not just this REQ's own grep, matching the level of scrutiny every prior REQ's mutation-site inventory received.

**Outward** (Purchase Order's own migration retrofits the entity it references outward): `migratePOToSupabase()` itself gains the mirror-image retrofit — touched-Quote tracking plus a push via `persistQteChange(q, true)` if Quote has already migrated, exactly as `migrateQteToSupabase()` gained for Order Request in `REQ-CLOUD-004`.

This gives Purchase Order **four** cross-phase push sites in total (three inward + one outward) — one fewer than Quote's five, since Purchase Order has no direct Contact or Order Request reference for those two functions to retrofit.

### 1.7 Sheets/`pullAll()` integration

Per §1.1a, Purchase Order sits in `pullAll()`'s id-keyed group (`_allPullKeys`/`dPo = await pulled('po')`, `index.html:4480` and `4538-4554`), not the `simpleEnts` array Quote/Line Item/Contact use. Excluding Purchase Order from this pull once `st_po_cloud_migration_ts` is set needs its own conditional inside this specific block — the exact shape is a SPEC-level decision, not a REQ-level one, but the REQ requirement is the same in substance as every prior entity's: once migrated, Purchase Order stops being pulled from Sheets. `syncAll()`/`pushAll()`'s push-direction has no equivalent exclusion for any entity in this series (`CLOUD-GAP-002`, accepted, not this REQ's job to fix either — see §3).

---

## 2. Requirements

**REQ-CLOUD-005a.** New `supabase/migrations/0005_purchase_orders.sql` table `purchase_orders`, mirroring the RLS/soft-delete shape of `0001`-`0004`. `sup_id` is `text`, not FK-constrained at the database level (a not-yet-migrated Supplier's local id is never RFC-4122 format — same reasoning as every prior cross-entity reference in this series), but enforced by a live pre-flight scan at migration time (§2c). `line_items` is a single `jsonb` column (no child table — Purchase Order's line items have no id of their own outside the parent, same as every other embedded-lines entity in this series). `_demo` is excluded from the schema, matching `REQ-CLOUD-003`/`REQ-CLOUD-004`'s identical precedent. `upd_at` (the app's own locally-meaningful "last saved" timestamp, distinct from Postgres's own `created_at`/`updated_at` bookkeeping columns) is included as its own `timestamptz` column for round-trip fidelity — confirm at SPEC time whether any read site actually depends on this field surviving a Cloud round-trip before deciding its type/nullability.

**REQ-CLOUD-005b.** Migration precondition: Supplier must have completed its own migration first, checked via the existing `isSupplierMigrationComplete()` against the *live, connected* Supabase project (not a local flag) — the same precondition shape `Line Item` already established. A live pre-flight scan verifies every local Purchase Order's `supId` actually resolves against the connected project's Suppliers before any row is inserted, mirroring `migrateLineItemsToSupabase()`'s `knownSupIdSet` pattern, blocking the whole migration (not a partial insert) if any Purchase Order references an unresolvable Supplier.

**REQ-CLOUD-005c.** A real pre-flight duplicate-`num` scan, exact match (Purchase Order's `num` has no case-normalization anywhere, same as Quote's), blocking migration via a dedicated modal — do not reuse `ov-sb-dup`/`ov-qt-dup` verbatim (their titles are hardcoded markup, not injectable, per the precedent `REQ-CLOUD-004` §0.2 established); confirm at SPEC time whether a third dedicated modal is warranted or whether the pattern should be generalized at last, given this is now the third near-identical duplicate-scan modal in the codebase.

**REQ-CLOUD-005d.** New `persistPOChange(po, skipRefresh)` shared helper, mirroring `persistOrdChange()`/`persistQteChange()` exactly, used by the two FPM-funded-deposit auto-recovery sites (§1.4 item 4) and by any cross-phase retrofit push. Not used by `savePO()` (own dedicated branch, per §1.3/§2e) or by `delPO()` (own dedicated branch, since it must also perform the `PO-GAP-007` fix below).

**REQ-CLOUD-005e.** `savePO()` gains its own dedicated `_sb`-branch (create/update), mirroring `saveOrd()`/`saveQte()`'s shape — a create must assign the real Supabase id to the local `po` object before any dependent side effect runs (there are currently none identified for a bare `savePO()` create, unlike `saveQte()`'s Contact/Order-Request conversion side effects — confirm this holds at SPEC time).

**REQ-CLOUD-005f.** `delPO()` gains its own dedicated `_sb`-branch (soft-delete) and, in the same change, fixes `PO-GAP-007`: sweep every Quote's `linkedPOIds[]` for the deleted id, remove it, and push the touched Quote back via `persistQteChange(q, true)` if Quote has migrated (local-only fix if not). This closes `PO-GAP-007` regardless of whether Purchase Order itself has migrated — the fix is really "delPO() should always have cleaned this up," Purchase-Order-Cloud-Data-migration or not; confirm at SPEC time whether this piece should ship independent of `_sb` gating (i.e., always run) or only once Purchase Order has migrated, and document the reasoning either way.

**REQ-CLOUD-005g.** `qteToPoConvert()`'s PO-creation portion gains a real Cloud Data branch, correctly handling the one-call-creates-multiple-POs case (§1.4 item 3): insert every generated Purchase Order, collect every real id, write the complete resulting list into `q.linkedPOIds`, then call `persistQteChange(q)` — mirroring `saveQte()`'s "assign every real id before the dependent write" ordering lesson from `REQ-CLOUD-004`, generalized from one id to a list.

**REQ-CLOUD-005h.** Exhaustive external-reference sweep, both directions, per §1.5: outward into `Quote.linkedPOIds[]` (array-element match against Purchase Order's own id-map, pushing touched Quotes if Quote has migrated) and `Invoice.pos[]` (array-element match, local-only fix, Invoice not yet Cloud-eligible); confirm and resolve the `DB.supPayments[].poId`/`.poNum` question raised in §1.5 before implementation.

**REQ-CLOUD-005i.** Five-site cross-phase retrofit, per §1.6: three inward (`migrateSuppliersBuyersToSupabase()`, `migrateQteToSupabase()`, `migrateLineItemsToSupabase()`) each gain touched-Purchase-Order tracking and a push via `persistPOChange(po, true)` if Purchase Order has migrated; `migratePOToSupabase()` itself gains the mirror-image outward retrofit for Quote. Independently re-confirm during requirements-gate that `migrateContactsToSupabase()`/`migrateOrdToSupabase()` genuinely need no retrofit (§1.6) — do not accept this REQ's own grep as sufficient on its own.

**REQ-CLOUD-005j.** `pullAll()` exclusion for `'po'` once `st_po_cloud_migration_ts` is set, shaped to the id-keyed `_allPullKeys`/`dPo` pull path (§1.7) rather than a copy of the `simpleEnts` array pattern. No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

**REQ-CLOUD-005k.** Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only — the same mechanics every prior Cloud Data migration in this series has used, with `st_po_cloud_migration_ts`/`st_po_pre_migration` as Purchase Order's own independent marker pair.

**REQ-CLOUD-005l.** `AI_SYSTEM_PROMPT` and `docs/user-guide.md`'s Cloud Data descriptions updated to name Purchase Order as the fifth (deal-pipeline-complete) independently-migratable entity, with no remaining non-eligible entity named in the deal pipeline — the "Purchase Order is not yet Cloud-Data-eligible" phrasing introduced by every prior REQ in this series is retired entirely once this one ships.

---

## 3. Out of scope

- **Phase 3** (Invoice, Credit Note, Shipment, both Payment ledgers) — explicitly the next, unscoped, future step, not started by this REQ.
- **`CLOUD-GAP-001`/`002`/`003`** — pre-existing, unrelated to Purchase Order specifically (though `CLOUD-GAP-003` gains a Purchase Order instance per §1.4, logged the same way, not fixed).
- **`CON-GAP-004`** — Contact/Quote dangling reference, unrelated to Purchase Order.
- **Cloud-migrating the Supplier Payment ledger itself** (`DB.supPayments`) — only its `poId`/`poNum` fields are swept as part of Purchase Order's own outward sweep (§1.5); the ledger's own entity migration, if ever warranted, is Phase-3-adjacent and unscoped.
- **A unified duplicate-scan-modal component** — raised as a question in §2c, but generalizing the third near-identical modal into one shared component is a refactor, not a requirement of this migration; defer the decision to SPEC time and keep it scoped to "does this migration need its own modal or not," not "should the codebase have one shared modal type."
- **Per-record `syncEnt()`/`delEnt()` retirement for Purchase Order** — matches every prior entity's precedent: Sheets push (`syncEnt`) keeps running for Purchase Order regardless of Cloud Data state, same as Supplier/Buyer/Line Item/Contact/Quote (only the *pull* side is excluded once migrated, per `CLOUD-GAP-002`).

---

## 4. Acceptance criteria

- **AC-1.** `supabase/migrations/0005_purchase_orders.sql` matches REQ-CLOUD-005a exactly; `_demo` absent; `sup_id`/`inv_id`/`quote_id` all `text`, not FK-constrained at the database level.
- **AC-2.** Migration is blocked (no rows inserted) if Supplier has not completed its own migration, and separately blocked if any local Purchase Order's `supId` fails to resolve against the *live* connected project's Suppliers — both checked, not just one.
- **AC-3.** Migration is blocked by a duplicate `num` (case-sensitive exact match) before any row is inserted.
- **AC-4.** After migration, `Quote.linkedPOIds[]` and `Invoice.pos[]` both correctly reflect the remapped Purchase Order id(s) — tested for both a Quote/Invoice with a single linked PO and one with multiple.
- **AC-5.** `Quote.linkedPOIds[]`'s sweep is pushed to Supabase (not just fixed locally) when Quote has already migrated, and left as a local-only fix when it has not — both cases tested.
- **AC-6.** All three inward retrofits (`migrateSuppliersBuyersToSupabase()`, `migrateQteToSupabase()`, `migrateLineItemsToSupabase()`) push a touched Purchase Order to Supabase when Purchase Order has already migrated, and leave it local-only when it has not — tested for each of the three, both cases.
- **AC-7.** `delPO()` removes the deleted PO's id from every Quote's `linkedPOIds[]`, pushing the touched Quote if Quote has migrated — this must be demonstrated to work **regardless of whether Purchase Order itself has migrated**, per the `PO-GAP-007` fix's own scope (§2f).
- **AC-8.** `qteToPoConvert()`'s multi-PO-creation case is tested with at least two distinct Suppliers in one Quote's lines, confirming every created PO gets a real Supabase id and `q.linkedPOIds` contains all of them before `persistQteChange()` runs.
- **AC-9.** Both FPM-funded-deposit auto-recovery sites (`saveInv()`'s and the payment-application path's) are demonstrated to correctly push the touched Purchase Order via `persistPOChange()` once Purchase Order has migrated.
- **AC-10.** `pullAll()` excludes `'po'` from its id-keyed pull once `st_po_cloud_migration_ts` is set; `syncAll()`/`pushAll()` are unaffected (matching `CLOUD-GAP-002`'s existing, accepted scope).
- **AC-11.** Full pre-existing-test-suite audit, mirroring every prior REQ's own §2.17-equivalent: every direct test-suite call site of `savePO()`/`delPO()`/`qteToPoConvert()` traced and confirmed safe against whatever async-conversion or shared-helper changes this REQ introduces.

---

## 5. Testing approach

Mirrors every prior REQ in this series: `mockSb()` harness (already fully generic per-table, no changes needed for a new `purchase_orders` table), per-entity independent migration markers, `testAsync`/`await` throughout for any newly-`async` code path, and a dedicated test-hygiene cleanup test appended after this REQ's own test block (not merged into `SPEC-CLOUD-004`'s), per the placement convention corrected during `SPEC-CLOUD-004`'s own spec-gate round 1 (B7).

---

## 6. Gate process

Follows the same rigorous SDLC pipeline as every prior REQ/SPEC in this series: REQ → independent requirements-gate review (Agent) → SPEC (exact diffs) → independent spec-gate review (Agent, applies diffs to a scratch copy, runs the real test suite) → implementation → self-directed mutation testing → independent build-gate review (Agent) → PR → CI green → merge → verify main consistent.

---

## 7. Tracker updates (at ship time)

- `docs/requirements-tracker.md` — new `REQ-CLOUD-005` row.
- `docs/known-gaps.md` — `PO-GAP-007` marked closed, cross-referenced to this REQ.
- `docs/version-history.md` / `STACKD_CONTEXT.md` — new version entry; `REQ-CLOUD-005 (not a gap)` backlog row removed (closed by shipping); Phase 2 marked complete in the sequencing narrative.
- `docs/architecture-data-model-v1.md` §8 — sequencing item 4 updated to mark all three deal-pipeline sub-phases done; Purchase Order's own §4.2 entity-detail paragraph gains a Cloud Data migration note, mirroring Quote's and Order Request's.
- `CLAUDE.md` — version/test-count bump; a new Cloud Data gotcha note if this REQ's implementation surfaces a genuinely new lesson (the array-field outward sweep in §1.1c/§1.5 is the leading candidate, mirroring how `REQ-CLOUD-004`'s outward-sweep pattern itself became a CLAUDE.md note).

---

## 8. Review-resolution log

v1 — drafted, not yet reviewed. Ready for requirements-gate round 1.
