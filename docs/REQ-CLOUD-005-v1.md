# REQ-CLOUD-005 — Purchase Order Cloud Data migration

**Status:** v1 — drafted. Requirements-gate round 1: CONDITIONAL PASS (5 blocking, 5 advisory), fixed. Round 2: CONDITIONAL PASS (1 blocking, 2 advisory), fixed. Round 3: PASS, 0 findings. See §8. Ready for SPEC.

---

## 0. Scoping

This is **Phase 2, sub-phase 3 of 3** of the cross-platform backend migration's deal-pipeline step (`docs/architecture-data-model-v1.md` §8) — the final sub-phase of Phase 2, per the scoping decision made in `REQ-CLOUD-003` §0 and reaffirmed in `REQ-CLOUD-004` §0 (sub-phase 1: Order Request, shipped v2.9.74 → sub-phase 2: Quote, shipped v2.9.75 → **sub-phase 3: Purchase Order, this REQ**).

Purchase Order is chosen next because it is the only entity left in the deal pipeline still fully local, and because it is explicitly named in both prior sub-phases' own scoping language as the final piece: `REQ-CLOUD-004` §1.5 states Order Request's `activeQuoteId` and Invoice's `linkedQuoteId` are outward references into Quote that Quote's own migration sweeps, but `PurchaseOrder.quoteId` was fixed only as "a plain local field" at that time because — in `REQ-CLOUD-004`'s own words (`SPEC-CLOUD-004-v1.md` §2.7) — "PurchaseOrder.quoteId/Invoice.linkedQuoteId ... are safe as plain local fixes — neither entity has a Supabase table." This REQ makes that statement half-false: once Purchase Order migrates, `migrateQteToSupabase()`'s existing local fix to `PurchaseOrder.quoteId` needs the same cross-phase retrofit treatment every other inward-facing sweep in this series has already received.

After this REQ ships, **Phase 2 (the deal pipeline) is complete.** Phase 3 — Invoice, Credit Note, Shipment, and both Payment ledgers (`docs/architecture-data-model-v1.md` §8 item 5) — remains explicitly future, unscoped work, not to be started without further instruction, exactly as Purchase Order was treated after Order Request shipped and after Quote shipped.

---

## 1. Business context

### 1.1 Why Purchase Order differs from every prior entity in this series

Several things make Purchase Order a materially different migration profile than Supplier/Buyer, Line Item/Contact, Order Request, or Quote — each of which introduced exactly one kind of novel complexity. Purchase Order combines a few of those *and* adds real new territory of its own, most notably a second, automatic creation path that turned out to be the entity's primary one (§1.1e).

**(a) Purchase Order already has real, live Google Sheets sync — and it is matched by business key, not id.** Order Request had zero Sheets footprint. Quote had real Sheets sync, through the `simpleEnts`/`_simpleEntsForBatch` arrays that `pullAll()` already knows how to gate on a migration marker (a one-line filter added to each array). Purchase Order is **not** in either of those arrays — per `docs/architecture-data-model-v1.md` §5.1 and the codebase's own changelog (`index.html:1574`), it is one of the entities matched by **business key** rather than id when pulled from Sheets, through a separate code path (`_allPullKeys = ['inv','cn','po'].concat(_simpleEntsForBatch)`, followed by its own `dPo = await pulled('po')` block using `findLocalMatchByBizKey`). Excluding Purchase Order from Sheets pull once it has migrated needs new logic shaped to *this* code path, not a copy of Quote's one-line array filter.

**(b) Purchase Order's own migration precondition combines two patterns no single prior entity needed together.** `vPO()` requires a Supplier on every Purchase Order (`if (!sup) return vErr('pf-sup', 'Please select a supplier')` — `index.html:8691`) — the same "every record must have a real Supplier" shape Line Item had, which needed both a genuine Supplier-migration-completion precondition and a live pre-flight scan verifying every local `supId` actually resolves against the *connected* Supabase project (`migrateLineItemsToSupabase()`'s `knownSupIdSet` pattern). This is a **form-level** guarantee, not a data-model one — see §1.1e/§1.5 for a real, already-possible counter-example. Separately, `vPO()` also enforces a **local-only** uniqueness check on `num` (`index.html:8688-8689`) that is manually entered with no case-normalization — the same shape Quote had, which needed a genuine pre-flight duplicate-number scan against the live project rather than a documented no-op. Purchase Order needs *both* checks, a combination no prior entity in this series has required.

**(c) Purchase Order's own id is referenced outward by an array field, not a scalar.** `Quote.linkedPOIds[]` is a list — a Quote converted to multiple Purchase Orders (one per distinct Supplier in its line items) holds several PO ids in one array. Quote's own outward sweep in `REQ-CLOUD-004` only ever needed to rewrite scalar fields. Sweeping an array field — finding each element that matches an old PO id and replacing it in place — is mechanically a small delta over a scalar sweep (a `.map()`/`.filter()` instead of a direct assignment; the codebase already does this kind of array remapping elsewhere, e.g. `delPO()`'s existing `Invoice.pos[]` splice), not a new capability, but it is new *for this series' outward-sweep pattern specifically* and worth calling out so the SPEC doesn't copy Quote's scalar-only sweep code verbatim.

**(d) Two confirmed-live mutation sites exist entirely outside `savePO()`/`delPO()`, found during this REQ's own research, not previously logged anywhere.** When an Invoice is marked `Paid`, both `saveInv()` (`index.html:6923-6929`) and a second Invoice-payment-application code path (`index.html:12708-12718`) independently walk `getInvoicePOs(inv)` and, for any linked Purchase Order with `fpmFunded > 0 && !fpmRecovered`, mutate `po.fpmRecovered = true` and `po.updAt = ...` directly, then persist via a bare `sv(K.p, DB.po)` plus `syncEnt('po', po)` — bypassing whatever Cloud Data branch this REQ adds to `savePO()`/`delPO()` entirely. This is the same class of defect `REQ-CLOUD-002`/`REQ-CLOUD-003` each found late (a mutation site outside the entity's own save/delete path, silently discarded on the next Cloud refresh once the entity has migrated) — caught here during REQ drafting instead of a late spec-gate round, but still needing a real fix, not a documented no-op.

**(e) `autoPos()` — not `qteToPoConvert()` — is Purchase Order's primary creation path, and it is not Cloud-Data-aware at all.** Per `docs/architecture-data-model-v1.md` §4.2: *"the majority of real-world PO creation (which is automatic by design) is invisible in the event log."* `autoPos()` (`index.html:7025-7043`), called from `saveInv()` on every first save of a new Invoice, groups the Invoice's line items by their source Line Item's `supId` and creates one Purchase Order per distinct Supplier group — the same one-call-creates-multiple-POs shape as `qteToPoConvert()` (§1.4 item 3), but reached far more often, entirely bypassing `savePO()`. It also confirms `po.lineItems[].lid` is a genuinely live field (populated directly from the source Line Item's real id, `index.html:7029`), not dead the way `Quote.lines[].lid` is — `verifyFkIntegrityAfterCleanup()` and `delLI()`'s dangling-reference warning both already depend on it. And it produces a PO shape with a `creAt` timestamp `savePO()` never sets, while `savePO()`'s own `updAt` is never set by `autoPos()` — see §2a for the resulting schema requirement. Finally, on the empty-Supplier question: `autoPos()`'s own grouping (`index.html:7028`, `if(r && r.supId){ ... }`) explicitly guards against this — a source Line Item with no Supplier is silently **excluded from any generated PO entirely** (a data-coverage gap worth its own out-of-scope note, §3, but not a Cloud Data migration concern), never surfaced as an empty-`supId` PO. It is `qteToPoConvert()`'s equivalent grouping (`l.supId || ''`, `index.html:12350`) that can genuinely produce `supId: ''` — `vQte()` (`index.html:11883-11893`) does not require a Supplier per line, unlike `vLI()`'s own Supplier requirement on every Line Item (`index.html:8617`), so a Quote line with no Supplier selected really does reach `qteToPoConvert()`'s PO-creation code with a blank `supId`. This is a real, already-possible local state via `qteToPoConvert()` specifically (not `autoPos()`) that this REQ's Supplier pre-flight resolution check (§2b) must explicitly treat as unresolvable-and-blocking like any other bad value.

### 1.2 What stays the same

The established 9-step migration mechanics apply unchanged: vendored Supabase client already in place, mandatory blocking backup-export attestation before any migration runs, insert-and-map loop assigning fresh Supabase ids, exhaustive external-reference sweep (both directions, per 1.1c/1.5 below), archive-the-true-pre-migration-snapshot-before-remapping, soft-delete-only (enforced by omitting the delete RLS policy), 30-day local rollback archive, disconnect-on-restore, and a `dr-procedure.md` rollback section. Purchase Order's own local behavior — its forms, its validation, its print preview, its Supplier Payment tab — does not change for an operator who has not connected Cloud Data or has not yet migrated Purchase Orders.

### 1.3 `savePO()`/`delPO()` risk profile

Both are already `async` (`savePO()` since `syncEnt()`/`await` were introduced for Sheets sync; `delPO()` likewise for `delEnt()`). Confirm during SPEC drafting whether any caller anywhere captures either's return value (expected: no, mirroring every prior `save*()`/`del*()` in this series) — if confirmed, no ripple-effect fix is needed for adding a Cloud Data branch to either, the same conclusion `REQ-CLOUD-004` §1.3 reached for `saveQte()`/`delQte()`.

### 1.4 Mutation-site inventory

Confirmed mutation sites needing a Cloud Data branch or retrofit:

1. **`savePO()`** (`index.html:8029-8040`) — the primary create/update path. Needs its own dedicated `_sb`-branch, mirroring `saveOrd()`/`saveQte()`'s shape (not routed through a shared `persistPOChange()` helper, for the same reason those two weren't: a create needs to assign a fresh id before any dependent side effect runs).
2. **`delPO()`** (`index.html:8066-8079`) — the soft-delete path. Currently sweeps `Invoice.pos[]` locally (a plain array-splice, `index.html:8071-8076`) but has never swept `Quote.linkedPOIds[]` at all — this is **`PO-GAP-007`**, logged during `REQ-CLOUD-003`'s own research and explicitly deferred here. Fixing it is now in scope: `delPO()` should remove the deleted PO's id from any Quote's `linkedPOIds[]`, pushing the touched Quote back to Supabase if Quote has migrated (the same "local fix isn't enough once the referenced entity has its own table" reasoning as every other retrofit in this REQ).
3. **`qteToPoConvert()`'s PO-creation portion** (`index.html:12339-12390`) — currently fully local regardless of Cloud Data state, by `REQ-CLOUD-004`'s own explicit design ("Purchase Order is not Cloud-Data-eligible"). Needs a real Cloud Data branch. A single call can create **multiple** Purchase Orders at once (one per distinct Supplier among the Quote's line items) — the Cloud Data branch must insert each one, collect every real Supabase-assigned id, and write the complete resulting id list into `q.linkedPOIds` before `persistQteChange(q)` runs (mirroring `saveQte()`'s "reset id before dependent side effects" lesson from `REQ-CLOUD-004`, generalized to a list instead of a single id).
4. **`autoPos()`** (`index.html:7025-7043`) — **found during this REQ's own research, not previously named anywhere in this series' documentation.** Called from `saveInv()` on every first save of a new Invoice (`index.html:6920`, `if(!EI.i) autoPos(inv);`): groups the Invoice's line items by their source Line Item's `supId`, and creates one Purchase Order per distinct Supplier group, each via a direct `DB.po.push(po)` inside a loop, ending in a bare `sv(K.p,DB.po); sv(K.i,DB.inv); rPO();` with no `syncEnt()` call and no relation to `savePO()` whatsoever. Per `docs/architecture-data-model-v1.md` §4.2, this — not `qteToPoConvert()` — is the entity's **primary** creation path: *"the majority of real-world PO creation (which is automatic by design) is invisible in the event log."* This function has exactly the same one-call-creates-multiple-POs shape as `qteToPoConvert()` (grouped by `supId`, one PO per group) and needs the identical treatment: a Cloud Data branch that inserts every generated PO, collects every real id, and writes it into `Invoice.pos[]` before returning. Left unaddressed, the majority of real Purchase Orders would stay permanently local-only after migration — this is not an edge case.
5. **The two FPM-funded-deposit auto-recovery sites** (`index.html:6923-6929` inside `saveInv()`, and `index.html:12708-12718` in the Invoice-payment-application path) — both mutate an *existing* Purchase Order's `fpmFunded`/`fpmRecovered`/`updAt` outside `savePO()` entirely. Both need to route through a new shared `persistPOChange(po, skipRefresh)` helper (mirroring `persistOrdChange()`/`persistQteChange()`) instead of the current bare `sv(K.p, DB.po)` + `syncEnt('po', po)`.

Confirmed **not** mutation sites, verified during this REQ's own research (not merely assumed):

- **`delSup()`** — per `docs/architecture-data-model-v1.md` §4.2, already confirmed warn-and-allow: it leaves `PO.supId` dangling by design, never mutates it. No change.
- **`delCon()`** — Contact has no field on Purchase Order to dangle; Purchase Order's only Contact-adjacent path is through Order Request/Quote, not directly. No change.
- **`migrateQtePoShape()`** (`index.html:2936-2951`) — a legacy repair migration converting old-shape Purchase Orders (`po.lines`/`po.dt`/`po.fpm`/`po.rec`) to the current shape (`po.lineItems`/`po.date`/`po.fpmFunded`/`po.fpmRecovered`). Its guard is `if (po.lines && !po.lineItems)` — a Purchase Order ever created or refreshed from Supabase always carries the current shape (`migratePOToSupabase()`'s insert and `refreshPOFromSupabase()`'s mapping both always populate `lineItems`, never `lines`), so this guard can never fire for a cloud-hosted record. Same disposition `REQ-CLOUD-004` gave `migrateLinkedPOIds()`: left on `saveAll()`, confirmed structurally unable to touch a cloud-migrated record.
- **`backfillInvoicePOs()`** (`index.html:2915-2934`) — rebuilds `Invoice.pos[]` by scanning whatever `DB.po` currently holds. Since it reads the in-memory/localStorage mirror (which stays correct post-migration via the standard refresh pattern) rather than caring whether an id is a local `uid()` or a Supabase UUID, this function needs no change regardless of Purchase Order's migration state.
- **`processImport()`'s `'po'` CSV-import branch** (`index.html:8967-8990`-ish) **and `processImportRecords()`'s separate, functionally-identical `'po'` branch** (`index.html:9306-9355`-ish — a distinct, independently-maintained import path per `docs/architecture-data-model-v1.md` §5.3, easy to miss if only the first is checked) — both bypass Cloud Data entirely, writing straight to `DB.po` via a bare `sv(K.p, DB.po)`. Same class of gap as the already-accepted `CLOUD-GAP-003` (Supplier/Line Item/Contact's CSV importers). Candidate for a `CLOUD-GAP-003`-style logged-not-fixed entry covering both sites, not an in-scope fix — see §3.

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
- **`migrateLineItemsToSupabase()`** — already sweeps `DB.po.forEach(po => (po.lineItems||[]).forEach(li => lid remap))` (`index.html:5900`). Unlike `Quote.lines[].lid` (confirmed dead in `REQ-CLOUD-004`), Purchase Order's `lineItems[].lid` is a **genuinely live field**: `autoPos()` populates it directly from the source Line Item's real id (`index.html:7029`, §1.1e), and `verifyFkIntegrityAfterCleanup()`/`delLI()`'s dangling-reference warning both already depend on it. This retrofit's touched-set will **not** generally be empty in practice — the SPEC's test for this retrofit must cover a real non-empty case, not only the negative/empty-set case `Quote.lines[].lid`'s equivalent test used.

Confirmed **not** retrofit sites, verified during this REQ's own research: **`migrateContactsToSupabase()`** and **`migrateOrdToSupabase()`** — neither function's body contains any `DB.po` reference (grepped directly; Purchase Order has no Contact field and no direct Order Request field, only reaching Order Request transitively through Quote). Confirm this holds during requirements-gate via an independent search, not just this REQ's own grep, matching the level of scrutiny every prior REQ's mutation-site inventory received.

**Outward** (Purchase Order's own migration retrofits the entity it references outward): `migratePOToSupabase()` itself gains the mirror-image retrofit — touched-Quote tracking plus a push via `persistQteChange(q, true)` if Quote has already migrated, exactly as `migrateQteToSupabase()` gained for Order Request in `REQ-CLOUD-004`.

This gives Purchase Order **four** cross-phase push sites in total (three inward + one outward) — one fewer than Quote's five, since Purchase Order has no direct Contact or Order Request reference for those two functions to retrofit.

### 1.7 Sheets/`pullAll()` integration

Per §1.1a, Purchase Order sits in `pullAll()`'s business-key-matched group (`_allPullKeys`/`dPo = await pulled('po')`, `index.html:4480` and `4538-4554`), not the `simpleEnts` array Quote/Line Item/Contact use. Excluding Purchase Order from this pull once `st_po_cloud_migration_ts` is set needs its own conditional inside this specific block — the exact shape is a SPEC-level decision, not a REQ-level one, but the REQ requirement is the same in substance as every prior entity's: once migrated, Purchase Order stops being pulled from Sheets. `syncAll()`/`pushAll()`'s push-direction has no equivalent exclusion for any entity in this series (`CLOUD-GAP-002`, accepted, not this REQ's job to fix either — see §3).

---

## 2. Requirements

**REQ-CLOUD-005a.** New `supabase/migrations/0005_purchase_orders.sql` table `purchase_orders`, mirroring the RLS/soft-delete shape of `0001`-`0004`. Column list resolved against the union of every field `savePO()` (`index.html:8034`), `autoPos()` (`index.html:7035`), and `qteToPoConvert()` build into a `po` object:

| Local field | Column | Type | Notes |
|---|---|---|---|
| `id` | `id` | `uuid` (PK, `gen_random_uuid()`) | |
| `num` | `num` | `text not null unique` | manually entered, no case-normalization — see REQ-CLOUD-005c |
| `supId` | `sup_id` | `text` | not FK-constrained (a not-yet-migrated Supplier's local id is never RFC-4122 format); can legitimately be an empty string via `qteToPoConvert()` specifically — not `autoPos()`, which excludes any Supplier-less source line instead (§1.1e) — the pre-flight scan (§2b) treats an empty value as unresolvable, same as any other bad value |
| `invNum` | `inv_num` | `text` | business-key mirror of `invId`; Invoice is not Cloud-eligible |
| `invId` | `inv_id` | `text` | not FK-constrained, Invoice not Cloud-eligible; can be blank |
| `date` | `date` | `text` | matches `Quote.dt`'s precedent exactly — a bare `<input type="date">.value` string, never a JS `Date`, never reformatted |
| `del` | `del` | `text` | destination field; free text |
| `cur` | `cur` | `text not null` | |
| `paymentTerms` | `payment_terms` | `text` | |
| `lineItems` | `line_items` | `jsonb not null default '[]'::jsonb` | no child table — line items have no id of their own outside the parent, same as every other embedded-lines entity in this series; `lid` inside each element is genuinely live (§1.6), not dead |
| `dep` | `dep` | `numeric` | |
| `fpmFunded` | `fpm_funded` | `numeric` | |
| `fpmRecovered` | `fpm_recovered` | `boolean` | mutated by the two auto-recovery sites in §1.4 item 5, via `persistPOChange()` |
| `oth` | `oth` | `numeric` | |
| `notes` | `notes` | `text` | |
| `status` | `status` | `text not null` | |
| `updAt` | `upd_at` | `timestamptz` | set by `savePO()` on every save; never set by `autoPos()` — nullable |
| `creAt` | `cre_at` | `timestamptz` | set by `autoPos()` only; never set by `savePO()` — nullable; confirm at SPEC time whether `refreshPOFromSupabase()` needs to preserve the "only one of `creAt`/`updAt` may be present" shape (mirroring `REQ-CLOUD-004`'s `originCharges`/`destCharges`/`fpmAdmin` key-omission precedent) rather than defaulting both to a bare `\|\| ''`/`\|\| null` |
| `quoteId` | `quote_id` | `text` | not FK-constrained, only ever set by `qteToPoConvert()`; blank for every other PO |
| `quoteNum` | `quote_num` | `text` | business-key mirror, same caveat |
| `_demo` | *(excluded)* | — | local-only demo-data marker, matching `REQ-CLOUD-003`/`REQ-CLOUD-004`'s identical precedent — carries forward unchanged locally, never sent to Supabase |

Standard `created_at`/`updated_at`/`deleted_at` Postgres-managed columns are additional to the above, matching every prior migration in this series (and are distinct from the app's own `cre_at`/`upd_at`, which reflect the app's own save timestamps, not Postgres's insert time).

**REQ-CLOUD-005b.** Migration precondition: Supplier must have completed its own migration first, checked via the existing `isSupplierMigrationComplete()` against the *live, connected* Supabase project (not a local flag) — the same precondition shape `Line Item` already established. A live pre-flight scan verifies every local Purchase Order's `supId` actually resolves against the connected project's Suppliers before any row is inserted, mirroring `migrateLineItemsToSupabase()`'s `knownSupIdSet` pattern, blocking the whole migration (not a partial insert) if any Purchase Order references an unresolvable Supplier.

**REQ-CLOUD-005c.** A real pre-flight duplicate-`num` scan, exact match (Purchase Order's `num` has no case-normalization anywhere, same as Quote's), blocking migration via a dedicated modal — do not reuse `ov-sb-dup`/`ov-qt-dup` verbatim (their titles are hardcoded markup, not injectable, per the precedent `REQ-CLOUD-004` §0.2 established); confirm at SPEC time whether a third dedicated modal is warranted or whether the pattern should be generalized at last, given this is now the third near-identical duplicate-scan modal in the codebase.

**REQ-CLOUD-005d.** New `persistPOChange(po, skipRefresh)` shared helper, mirroring `persistOrdChange()`/`persistQteChange()` exactly, used by the two FPM-funded-deposit auto-recovery sites (§1.4 item 5) and by any cross-phase retrofit push. Not used by `savePO()` (own dedicated branch, per §1.3/§2e), `delPO()` (own dedicated branch, since it must also perform the `PO-GAP-007` fix below), `autoPos()`, or `qteToPoConvert()`'s PO-creation portion (both own dedicated multi-insert branches, per §2g).

**REQ-CLOUD-005e.** `savePO()` gains its own dedicated `_sb`-branch (create/update), mirroring `saveOrd()`/`saveQte()`'s shape — a create must assign the real Supabase id to the local `po` object before any dependent side effect runs (there are currently none identified for a bare `savePO()` create, unlike `saveQte()`'s Contact/Order-Request conversion side effects — confirm this holds at SPEC time).

**REQ-CLOUD-005f.** `delPO()` gains its own dedicated `_sb`-branch (soft-delete) and, in the same change, fixes `PO-GAP-007`: sweep every Quote's `linkedPOIds[]` for the deleted id, remove it, and push the touched Quote back via `persistQteChange(q, true)` if Quote has migrated (local-only fix if not). This closes `PO-GAP-007` regardless of whether Purchase Order itself has migrated — the fix is really "delPO() should always have cleaned this up," Purchase-Order-Cloud-Data-migration or not; confirm at SPEC time whether this piece should ship independent of `_sb` gating (i.e., always run) or only once Purchase Order has migrated, and document the reasoning either way.

**REQ-CLOUD-005g.** Both `qteToPoConvert()`'s PO-creation portion (§1.4 item 3) and `autoPos()` (§1.4 item 4 — the entity's actual primary creation path, per §1.1e) gain a real Cloud Data branch, each correctly handling its own one-call-creates-multiple-POs case: insert every generated Purchase Order, collect every real id, write the complete resulting list into the dependent field (`q.linkedPOIds` for `qteToPoConvert()`, `Invoice.pos[]` for `autoPos()`), then perform the dependent write (`persistQteChange(q)` / `sv(K.i, DB.inv)` respectively) — mirroring `saveQte()`'s "assign every real id before the dependent write" ordering lesson from `REQ-CLOUD-004`, generalized from one id to a list, and applied to both call sites, not just the less-common one.

**REQ-CLOUD-005h.** Exhaustive external-reference sweep, both directions, per §1.5: outward into `Quote.linkedPOIds[]` (array-element match against Purchase Order's own id-map, pushing touched Quotes if Quote has migrated) and `Invoice.pos[]` (array-element match, local-only fix, Invoice not yet Cloud-eligible); confirm and resolve the `DB.supPayments[].poId`/`.poNum` question raised in §1.5 before implementation.

**REQ-CLOUD-005i.** Four-site cross-phase retrofit, per §1.6: three inward (`migrateSuppliersBuyersToSupabase()`, `migrateQteToSupabase()`, `migrateLineItemsToSupabase()`) each gain touched-Purchase-Order tracking and a push via `persistPOChange(po, true)` if Purchase Order has migrated; `migratePOToSupabase()` itself gains the mirror-image outward retrofit for Quote. Independently re-confirm during requirements-gate that `migrateContactsToSupabase()`/`migrateOrdToSupabase()` genuinely need no retrofit (§1.6) — do not accept this REQ's own grep as sufficient on its own.

**REQ-CLOUD-005j.** `pullAll()` exclusion for `'po'` once `st_po_cloud_migration_ts` is set, shaped to the business-key-matched `_allPullKeys`/`dPo` pull path (§1.7) rather than a copy of the `simpleEnts` array pattern. No change to `syncAll()`/`pushAll()` (`CLOUD-GAP-002`, pre-existing, out of scope).

**REQ-CLOUD-005k.** Archive-before-remap, 30-day grace window, disconnect-on-restore, blocking backup gate, soft-delete-only — the same mechanics every prior Cloud Data migration in this series has used, with `st_po_cloud_migration_ts`/`st_po_pre_migration` as Purchase Order's own independent marker pair.

**REQ-CLOUD-005l.** `AI_SYSTEM_PROMPT` and `docs/user-guide.md`'s Cloud Data descriptions updated to name Purchase Order as the fifth (deal-pipeline-complete) independently-migratable entity, with no remaining non-eligible entity named in the deal pipeline — the "Purchase Order is not yet Cloud-Data-eligible" phrasing introduced by every prior REQ in this series is retired entirely once this one ships.

---

## 3. Out of scope

- **Phase 3** (Invoice, Credit Note, Shipment, both Payment ledgers) — explicitly the next, unscoped, future step, not started by this REQ.
- **`CLOUD-GAP-001`/`002`/`003`** — pre-existing, unrelated to Purchase Order specifically, though `CLOUD-GAP-003` gains a Purchase Order instance per §1.4: **both** `processImport()`'s `'po'` CSV branch (`index.html:8967-8990`-ish) **and** the separate, independently-maintained `processImportRecords()`'s functionally-identical `'po'` branch (`index.html:9306-9355`-ish, the Sheets-direct-pull import path `docs/architecture-data-model-v1.md` §5.3 warns is a recurring "missed the second import path" risk in this codebase) bypass Cloud Data the same way — log both instances under `CLOUD-GAP-003` at ship time, not just one.
- **`PO-GAP-006`** — `processImport()`'s CSV PO-update branch replaces wholesale rather than merging on a number collision, risking line-item loss; pre-existing, directly adjacent to but not caused or worsened by this REQ, not fixed here.
- **`CON-GAP-004`** — Contact/Quote dangling reference, unrelated to Purchase Order.
- **Cloud-migrating the Supplier Payment ledger itself** (`DB.supPayments`) — only its `poId`/`poNum` fields are swept as part of Purchase Order's own outward sweep (§1.5); the ledger's own entity migration, if ever warranted, is Phase-3-adjacent and unscoped.
- **A unified duplicate-scan-modal component** — raised as a question in §2c, but generalizing the third near-identical modal into one shared component is a refactor, not a requirement of this migration; defer the decision to SPEC time and keep it scoped to "does this migration need its own modal or not," not "should the codebase have one shared modal type."
- **Per-record `syncEnt()`/`delEnt()` retirement for Purchase Order** — matches every prior entity's precedent: Sheets push (`syncEnt`) keeps running for Purchase Order regardless of Cloud Data state, same as Supplier/Buyer/Line Item/Contact/Quote (only the *pull* side is excluded once migrated, per `CLOUD-GAP-002`).

---

## 4. Acceptance criteria

- **AC-1.** `supabase/migrations/0005_purchase_orders.sql` matches REQ-CLOUD-005a's full column list exactly; `_demo` absent; `sup_id`/`inv_id`/`quote_id` all `text`, not FK-constrained at the database level; both `cre_at`/`upd_at` present and independently nullable.
- **AC-2.** A Cloud-configured `savePO()` create inserts with no client-generated id, resolves the real Supabase-assigned id onto the local record, and calls `.update(...).eq('id',...)` (not `.insert()`) on a subsequent edit of the same record; local-only behavior is unchanged when Purchase Order has not migrated.
- **AC-3.** A Cloud-configured `delPO()` soft-deletes via `update({deleted_at:...})`, not a hard delete; local-only behavior is unchanged when Purchase Order has not migrated.
- **AC-4.** Migration is blocked (no rows inserted) if Supplier has not completed its own migration, and separately blocked if any local Purchase Order's `supId` fails to resolve against the *live* connected project's Suppliers — both checked, not just one; a Purchase Order with `supId: ''` (the real, already-possible empty-Supplier state from §1.1e) is treated as unresolvable and blocks the migration the same as any other bad value.
- **AC-5.** Migration is blocked by a duplicate `num` (case-sensitive exact match) before any row is inserted.
- **AC-6.** After migration, `Quote.linkedPOIds[]` and `Invoice.pos[]` both correctly reflect the remapped Purchase Order id(s) — tested for both a Quote/Invoice with a single linked PO and one with multiple.
- **AC-7.** `Quote.linkedPOIds[]`'s sweep is pushed to Supabase (not just fixed locally) when Quote has already migrated, and left as a local-only fix when it has not — both cases tested.
- **AC-8.** All three inward retrofits (`migrateSuppliersBuyersToSupabase()`, `migrateQteToSupabase()`, `migrateLineItemsToSupabase()`) push a touched Purchase Order to Supabase when Purchase Order has already migrated, and leave it local-only when it has not — tested for each of the three, both cases; the `migrateLineItemsToSupabase()` case is tested with a real, non-empty `lid` match (§1.6 — this field is live, not dead), not only an empty-touched-set case.
- **AC-9.** `delPO()` removes the deleted PO's id from every Quote's `linkedPOIds[]`, pushing the touched Quote if Quote has migrated — this must be demonstrated to work **regardless of whether Purchase Order itself has migrated**, per the `PO-GAP-007` fix's own scope (§2f).
- **AC-10.** Both `qteToPoConvert()`'s and `autoPos()`'s multi-PO-creation cases (§1.1e/§1.4 items 3 and 4 — these are the entity's two real one-call-creates-multiple-POs paths, `autoPos()` being the more common one in practice) are tested with at least two distinct Suppliers among the source lines, confirming every created PO gets a real Supabase id and the dependent write (`q.linkedPOIds` for the former, `Invoice.pos[]` for the latter) contains every one of them before it runs.
- **AC-11.** Both FPM-funded-deposit auto-recovery sites (`saveInv()`'s and the payment-application path's) are demonstrated to correctly push the touched Purchase Order via `persistPOChange()` once Purchase Order has migrated.
- **AC-12.** `pullAll()` excludes `'po'` from its business-key pull path (§1.1a) once `st_po_cloud_migration_ts` is set; `syncAll()`/`pushAll()` are unaffected (matching `CLOUD-GAP-002`'s existing, accepted scope).
- **AC-13.** Full pre-existing-test-suite audit, mirroring every prior REQ's own §2.17-equivalent: every direct test-suite call site of `savePO()`/`delPO()`/`qteToPoConvert()`/`autoPos()` traced and confirmed safe against whatever async-conversion or shared-helper changes this REQ introduces.

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

**Round 1 — CONDITIONAL PASS (5 blocking, 5 advisory).**

Blocking, all fixed:
- **B1.** The mutation-site inventory omitted `autoPos()` (`index.html:7025-7043`) entirely — per `docs/architecture-data-model-v1.md` §4.2, this, not `qteToPoConvert()`, is Purchase Order's *primary* creation path ("the majority of real-world PO creation... is automatic by design"), called from every first save of a new Invoice, with the identical one-call-creates-multiple-POs shape already flagged for `qteToPoConvert()`. Left unaddressed, most real Purchase Orders would have stayed permanently local-only after migration. Fixed: added as mutation-site item 4 (§1.1e, §1.4), given its own requirement (§2g, merged with `qteToPoConvert()`'s), its own AC (AC-10), and folded into the `lid`-is-live finding (A2) and the empty-`supId` edge case (B5) it also surfaced.
- **B2.** `qteToPoConvert()`'s citation (`index.html:12157-12210`) pointed at unrelated Contact/`saveCon()` code. Fixed: corrected to `index.html:12339-12390`, the real function.
- **B3.** `REQ-CLOUD-005a` gave no exhaustive column list, unlike every prior REQ in this series (a real regression in rigor — `REQ-CLOUD-004a`'s equivalent list was exhaustive, and an *unresolved* type question on one field was itself rated blocking in that REQ's own round 1). Fixed: full column-by-column table resolved against the combined field set of `savePO()`, `autoPos()`, and `qteToPoConvert()`, including the `creAt`/`updAt` asymmetry between creation paths this exposed.
- **B4.** No acceptance criterion tested `savePO()`/`delPO()`'s own Cloud Data create/update/soft-delete behavior directly — the most basic behavior REQ-CLOUD-005e/f describe had no AC coverage at all. Fixed: added AC-2/AC-3.
- **B5.** §1.1b treated "Supplier is mandatory" as a data-model invariant, but `qteToPoConvert()`/`autoPos()` can both legitimately produce `supId: ''` (a Quote line or Invoice line item with no Supplier resolves to an empty string, not a validation failure, since neither path calls `vPO()`). Fixed: reframed as a form-level guarantee only (§1.1b, §1.1e), with the pre-flight scan (§2b) and AC-4 made explicit about treating an empty `supId` as unresolvable-and-blocking like any other bad value.

Advisory, all fixed:
- **A1.** "Id-keyed" mislabeled the `_allPullKeys`/`dPo` pull-path group — per `docs/architecture-data-model-v1.md` §5.1 and the codebase's own changelog, Purchase Order is matched by *business key*, not id. Fixed throughout (§1.1a, §1.7, REQ-CLOUD-005j, AC-12).
- **A2.** Speculated `lineItems[].lid` might be dead like `Quote.lines[].lid`; it is not — `autoPos()` populates it directly from a real Line Item id, and two existing functions already depend on it. Fixed: reframed as confirmed-live throughout (§1.1e, §1.6, AC-8).
- **A3.** Named only `processImport()`'s `'po'` CSV branch, missing the separate, independently-maintained `processImportRecords()`'s functionally-identical branch that `docs/architecture-data-model-v1.md` §5.3 already warns is easy to miss. Fixed: both named together everywhere this REQ discusses the CSV-bypass gap (§1.4, §3).
- **A4.** Overstated the `Quote.linkedPOIds[]` array sweep as "genuinely new territory." Fixed: reframed as a small mechanical delta over a scalar sweep, new for this series' outward-sweep pattern specifically rather than a new capability (§1.1c).
- **A5.** §3 omitted `PO-GAP-006`, the PO-specific gap most directly adjacent to this REQ's own CSV-importer discussion. Fixed: added.

Also self-caught and fixed while resolving the above (not separately flagged by the reviewer): REQ-CLOUD-005i's own summary said "Five-site cross-phase retrofit," contradicting §1.6's correctly-derived count of four (three inward + one outward) — corrected to "Four-site."

**Round 2 (verification of round 1's fixes) — CONDITIONAL PASS (1 blocking, 2 advisory).**

- **Blocking.** B1's fix (folding `autoPos()` into the mutation-site inventory) had generalized B5's empty-`supId` finding to both `qteToPoConvert()` *and* `autoPos()` without re-checking `autoPos()`'s actual code — its grouping (`index.html:7028`, `if(r && r.supId){...}`) explicitly **excludes** any Supplier-less source line from ever reaching a generated PO, so `autoPos()` can never produce `supId:''`; only `qteToPoConvert()` can. Fixed: §1.1e and the `sup_id` schema-table row corrected to attribute the empty-`supId` state to `qteToPoConvert()` only, with `autoPos()`'s actual behavior (silently dropping a Supplier-less line from any PO) now stated accurately instead.
- **Advisory.** Two citation off-by-ones from the round-1 fixes themselves: `autoPos()`'s object-literal line (7036 → 7035, the `po={...}` line is one above the `DB.po.push()` cited) and `delPO()`'s `Invoice.pos[]` splice range (8069-8074 → 8071-8076, tightened to the actual `.splice()` call). Both fixed.
- Everything else from round 1 (B2/B3/B4, A1-A5, the self-caught count fix) reverified independently against the real code and confirmed genuinely fixed — including a full column-by-column re-check of the new schema table against `savePO()`/`autoPos()`/`qteToPoConvert()`'s real combined field set (20 fields, none missing), and an independent re-confirmation that `migrateContactsToSupabase()`/`migrateOrdToSupabase()` truly touch no `DB.po` reference.

Ready for requirements-gate round 3.

**Round 3 (fresh full-document read plus independent re-verification) — PASS, 0 findings.** Confirmed round 2's fix correct and complete (`autoPos()`'s guard structurally cannot produce `supId:''`; only `qteToPoConvert()` can, correctly attributed); read the entire document end to end for new inconsistencies (none found); spot-checked several citations not previously verified in this review chain (all accurate); confirmed every requirement maps to an acceptance criterion and no two ACs overlap. Does not warrant a fourth round.

Ready for SPEC.
