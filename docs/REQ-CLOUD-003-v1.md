# REQ-CLOUD-003 — Order Request Cloud Data migration (Phase 2, sub-phase 1 of 3)

**Status:** v1 — drafted. Ready for requirements-gate.

---

## 0. Scoping decision: Phase 2 split into three sequential sub-REQs, not one

`docs/architecture-data-model-v1.md` §8's sequencing step 4 groups Order Request, Quote, and Purchase Order into "the same delivery." Having now researched the real current code in depth (see §1), that combined scope is materially larger than either Phase 0 (`REQ-CLOUD-001`, Supplier+Buyer) or Phase 1 (`REQ-CLOUD-002`, Line Item+Contact) — both of which needed multiple spec-gate rounds on a single entity pair. Order Request alone has a nested three-level structure (`ord.lines[].rfqResponses[]`), roughly ten distinct mutation call sites bypassing any single choke point, and a confirmed pre-existing cross-entity bug in the already-shipped Supplier migration sweep. Combining all three into one REQ/SPEC/PR risks an unreviewable mega-change and a build-gate pass that can't meaningfully verify it end to end.

**Decision: split Phase 2 into three sequential sub-REQs, following the same incremental pattern `REQ-CLOUD-001`→`REQ-CLOUD-002` already established** — each gated, implemented, and merged before the next starts:

1. **`REQ-CLOUD-003` (this document) — Order Request**, first because it has zero existing Sheets-sync footprint (confirmed below) — migrating it to Supabase is a strict win with no coexistence question to resolve, unlike Quote/PO.
2. **`REQ-CLOUD-004` (future) — Quote**, including closing the Quote-specific logging/sync gaps `docs/architecture-data-model-v1.md` §8 calls out.
3. **`REQ-CLOUD-005` (future) — Purchase Order**, including closing `docs/architecture-data-model-v1.md` §6.4 (`autoPos()`/`qteToPoConvert()` never call `logEv()`) and a newly-found `delPO()` gap (§1.6 below).

This still satisfies §8's intent — all three entities get migrated, and the logging/sync gaps get fixed — just as three reviewable increments rather than one. Each sub-REQ's own migration-completion marker (`st_ord_cloud_migration_ts` here) becomes a precondition input for the ones after it wherever a real cross-entity reference requires it (see §1.5).

---

## 1. Business context

### 1.1 Why Order Request first, and why it's simpler than it looks

Order Request (`DB.ord`) has **zero Sheets-sync footprint today** — verified absent from `FIELD_MAPS` (`index.html:4278-4288`), from `syncAll()`/`pushAll()`'s entity arrays (`index.html:4341`, `4570`), and from `pullAll()` (neither `_allPullKeys` nor any hand-written block references `ord`). This was a deliberate `REQ-ORD-001` decision ("FM-1 category-3 precedent"), not an oversight. `SEC-GAP-011` (`pullAll()`'s no-conflict-resolution risk, the architecture doc's own stated driver for this whole initiative) **does not even apply to Order Request today** — there is currently zero cross-device sharing of Order Request data of any kind; every operator's Order Requests live only in their own browser's localStorage. Migrating it to Supabase is therefore a pure, unambiguous improvement: there is no existing sync behavior to preserve, retire, or reconcile against, unlike Quote/PO which already have (imperfect) Sheets sync this migration would need to coexist with or retire.

### 1.2 The nested-array question, resolved

`docs/architecture-data-model-v1.md` §8 flags this as genuinely new territory: "an id-remap sweep for [nested entities] needs to walk three levels deep, and needs a decision on whether nested entities get their own backend rows/ids at all or stay embedded JSON on the parent." Resolved by direct inspection of every place an Order Request Line id or RFQ Response id is referenced *from outside* the Order Request itself (`Quote.lines[].sourceOrdLineId`, `Quote.lines[].sourceRfqResponseId`) — these are the only two candidate reasons a nested child would need a stable, independently-resolvable id post-migration.

**Decision: `order_requests.lines` is a single `jsonb` column. Nested Order Request Line and RFQ Response ids are never remapped — they keep their existing `uid()` string values unchanged when the parent Order Request migrates.** This works because nothing outside the Order Request's own JSONB blob needs to resolve a nested child id to a *new* value: `Quote.lines[].sourceOrdLineId`/`sourceRfqResponseId` continue pointing at the same string they always did, which is still findable inside the (now-cloud-hosted) parent's `lines` JSONB after migration. Only `Quote.lines[].sourceOrdId` — a reference to the **parent** Order Request's own top-level id — needs rewriting, because that id *does* change (from a local `uid()` string to a Postgres-assigned UUID) when the Order Request row is created in Supabase.

This mirrors the precedent already set by `0002_line_items_contacts.sql`, which embeds `price_history`/`enquiries` as `jsonb` rather than promoting them to child tables — the same reasoning applies here, just one level deeper.

A consequence worth stating plainly: because the entire `lines` array (including every RFQ Response nested inside every line) is one JSONB value, Postgres cannot enforce a foreign-key constraint on any `supId`/`contactId` value buried inside it. **This means Order Request's own migration needs no Supplier- or Contact-migration-completion precondition** — a real, useful simplification relative to Line Item/Contact/PO, none of which had this option since their FK columns are real relational columns. The trade-off (documented, not hidden) is that a stale `supId`/`contactId` inside an RFQ Response is not caught by any database constraint — data-quality here depends entirely on the sweep-retrofit in §2.4/§2.5 being correct, not on schema enforcement.

### 1.3 A confirmed, currently-live pre-existing bug this REQ must fix

Direct read of `migrateSuppliersBuyersToSupabase()` (`index.html:5616-5660`, shipped and unchanged since `REQ-CLOUD-001`) confirms its external-reference sweep (`index.html:5644-5648`) rewrites `Quote.lines[].supId`, `PO.supId`, `LineItem.supId`, `Contact.supplierId`, and `Invoice.buyerId` — but **never touches `DB.ord[].lines[].rfqResponses[].supId`**. This is not a hypothetical: any operator who has ever run "Migrate Suppliers/Buyers to Cloud" while holding any RFQ Response data has had every one of those RFQ Responses' `supId` silently go stale — pointing at a local Supplier id that no longer resolves to anything, since the real Supplier row moved to Supabase under a new UUID. `renderRfqComparison()` (`index.html:3336-3378`) and `rfqLandedGBP()` (`index.html:3311-3314`) both depend on resolving `resp.supId` against `DB.sup` — a broken reference there silently degrades supplier comparison for every affected RFQ Response, with no error surfaced anywhere. This REQ closes it (§2.4).

### 1.4 The mutation-call-site problem, and why a shared helper is the right fix here (not per-site patches)

`REQ-CLOUD-002`'s round-3 spec-gate finding established the pattern: any code that mutates a Cloud-Data-eligible entity's fields outside its own `save*()`/`del*()` function will silently discard the edit on the next Cloud Data refresh once that entity has migrated, unless it is also made `_sb`-aware. For Contact, that pattern showed up at five call sites. For Order Request, it is far worse — direct inspection finds Order Request document/line/RFQ-response mutations happening at **`saveOrd()`** (`index.html:3029`), **`delOrd()`** (`3059`), **`ordAdminOverride()`** (`2928`), **`ordLogLineUpdate()`**/**`ordConfirmLineUpdate()`** (`2957`, `2975`), **`ordAddLine()`** (`3578`), **`ordAddAction()`** (`3666`), **`saveRfqResponse()`** (`3256`), **`delRfqResponse()`** (`3291`), and **`ordCommitRfqResponse()`** (`3325`) — nine functions, none of which route through a shared choke point, all of which currently end with a bare `sv(K.ord, DB.ord)`. Patching each independently (as `REQ-CLOUD-002` did for Contact's five sites) would mean nine near-identical `_sb`-branch copies, each a fresh opportunity for the exact class of bug this pattern exists to prevent.

**Decision: introduce one shared helper, `persistOrdChange(ord)`,** that every one of these nine sites calls instead of `sv(K.ord, DB.ord)` directly. It performs the entire `_sb`-branch logic once: push a whole-row update of the given Order Request to Supabase and refresh when Cloud Data is configured and Order Request has migrated, otherwise fall back to the existing `sv(K.ord, DB.ord)` behavior unchanged. Every call site's business logic (validation, id rotation, cascading field updates) stays exactly as it is today — only the final persistence line changes, from `sv(K.ord, DB.ord)` to `await persistOrdChange(ord)`. This is a design choice grounded directly in what `REQ-CLOUD-002` learned costs the most when skipped, applied proactively here rather than discovered again three spec-gate rounds in.

### 1.5 Established migration-function pattern (for spec-gate's reference, not a novel decision here)

Every `migrate*ToSupabase()` function shipped so far (`index.html:5616-5775`) follows: precondition (`_sb` configured, auth, any required prior-migration-completion check) → mandatory blocking backup attestation (`showBlockingBackupModal()`) → pre-flight conflict/orphan scan verified against the live, currently-connected project (not a local flag, per `REQ-CLOUD-002`'s round-2 fix) → sequential insert-and-map loop → exhaustive external-reference sweep (including deliberately-dead fields, checked but never silently skipped) → archive-before-remap (`localStorage.setItem('st_&lt;x&gt;_pre_migration', ...)` before any local id is rewritten) → self-id remap → refresh-and-reveal. `refresh&lt;X&gt;FromSupabase()` refuses to replace real local data unless this device's own completion marker is set or there is nothing local to lose, and sets its own marker on any successful refresh (including a fresh second device's first-ever load) — closing the gap `REQ-CLOUD-002`'s round 3 found. `restore&lt;X&gt;MigrationArchive()` disconnects Cloud Data and clears its own marker on restore (`REQ-CLOUD-002`'s round-2 fix, applied proactively to `restoreOrdMigrationArchive()` from the start here).

### 1.6 A second, newly-found pre-existing bug — explicitly deferred to `REQ-CLOUD-005`, not fixed here

Direct read of `delPO()` (`index.html:7665-7679`) confirms it cleans `Invoice.pos[]` (added by `REQ-INTEG-002` Phase 2b) but never cleans `Quote.linkedPOIds[]` — a Quote whose only PO is deleted keeps its "PO RAISED" badge (`index.html:11247`) and its `qteToPoConvert()` re-conversion guard (`index.html:11881`) permanently blocked, with no way to recover short of manual data surgery. This is real and currently live, but it is a Quote↔PO relationship concern, not an Order Request one — logged here for continuity and explicitly assigned to `REQ-CLOUD-005` (Purchase Order), alongside `docs/architecture-data-model-v1.md` §6.4 (`autoPos()`/`qteToPoConvert()` never call `logEv()`), since both require touching PO's own migration/CRUD code this REQ does not.

---

## 2. Requirements

**REQ-CLOUD-003a — New `order_requests` Supabase table.** Schema (§2.1 below) with `lines` as a single `jsonb` column carrying the full nested Order Request Line + RFQ Response structure unchanged (§1.2). `contact_id` is a real `uuid references suppliers|contacts` — actually a real FK to `contacts(id)`, nullable to match the app's own tolerance for a missing/deleted Contact (`Order Request.contactId` is required at save time by `vErr('of-contact', ...)`, `index.html:3032`, but this REQ does not add a hard NOT NULL + FK constraint requiring Contact to have already migrated — see REQ-CLOUD-003b's precondition discussion). `active_quote_id` is a plain nullable `text`/`uuid` column with **no** FK constraint (Quote is not yet Cloud-Data-eligible; forcing a constraint here would either block Order Request's migration on Quote's, contradicting §0's sequencing, or require a nullable-but-unenforced column anyway — simpler to just not constrain it).

**REQ-CLOUD-003b — No Supplier- or Contact-migration-completion precondition for Order Request's own migration.** Per §1.2's reasoning: `supId`/`contactId` values nested inside RFQ Responses live inside an opaque `jsonb` blob no Postgres constraint can reach, so there is nothing to validate against before Order Request can migrate. **Exception:** `order_requests.contact_id` (the *top-level* Order Request's own required Contact FK) is a real relational column and does need a resolvable Contact — but per REQ-CLOUD-003a, this REQ deliberately makes that column nullable-without-hard-FK-enforcement too (see acceptance criteria for the exact rationale), avoiding a Contact-migration precondition for the same reason Quote's `source_contact_id` will avoid one in `REQ-CLOUD-004`.

**REQ-CLOUD-003c — `persistOrdChange(ord)` shared persistence helper**, used by all nine mutation sites listed in §1.4 (`saveOrd`, `delOrd`, `ordAdminOverride`, `ordLogLineUpdate`/`ordConfirmLineUpdate`, `ordAddLine`, `ordAddAction`, `saveRfqResponse`, `delRfqResponse`, `ordCommitRfqResponse`) in place of their current bare `sv(K.ord, DB.ord)` call. Each site's own business logic (validation, state-machine checks, id rotation on RFQ-response edit) is unchanged; only the final persistence step changes.

**REQ-CLOUD-003d — Exhaustive external-reference sweep on migration.** Only `Quote.lines[].sourceOrdId` is rewritten (to the new Supabase-assigned Order Request id); `Quote.lines[].sourceOrdLineId`/`sourceRfqResponseId` are explicitly checked-but-confirmed-unchanged in the SPEC and its tests, per §1.2's reasoning, matching this codebase's established "checked anyway, never silently skipped" convention for fields that don't need rewriting.

**REQ-CLOUD-003e — Retrofit `migrateSuppliersBuyersToSupabase()`'s sweep** (`index.html:5644-5648`) to additionally walk `DB.ord[].lines[].rfqResponses[].supId` and `DB.ord[].lines[].rfqResponses[].contactId`, closing §1.3's confirmed bug, **and** to push the rewritten `lines` value to the cloud-hosted `order_requests` row (via `persistOrdChange()` or equivalent direct Supabase call) rather than only fixing the local `DB.ord` array, whenever Order Request has itself already completed its own migration (`st_ord_cloud_migration_ts` set) — otherwise the fix is silently lost the next time Order Request refreshes from Supabase. This closes the general cross-phase risk `REQ-CLOUD-002`'s own sweep would otherwise reproduce here in reverse (an earlier-migrated entity's rewrite of a later-migrated entity's field, applied only locally).

**REQ-CLOUD-003f — Archive-not-delete rollback**, mirroring the established pattern: `st_ord_pre_migration`/`st_ord_cloud_migration_ts`, `restoreOrdMigrationArchive()` (disconnects Cloud Data and clears its own marker on restore, from the start — not added retroactively as `REQ-CLOUD-002` had to), extended `cleanupExpiredMigrationArchive()`, extended `rCfg()`'s restore-button visibility.

**REQ-CLOUD-003g — Mandatory blocking backup gate**, reusing `showBlockingBackupModal()` unchanged.

**REQ-CLOUD-003h — Pre-flight conflict scan: documented no-op.** `ORD-####` numbers are generated by `nextRefNum(DB.ord, 'ORD')` (`index.html:3050`), which scans the current max and increments — no duplicate-producing path exists today outside a genuine concurrent-tab race (exactly the class of risk `SEC-GAP-011`/this whole initiative exists to reduce over time, not something a single migration's pre-flight scan can meaningfully guard against). No pre-flight scan is added; this is stated explicitly rather than left as a silent gap, matching `REQ-CLOUD-002`'s established convention for genuine no-ops (REQ-CLOUD-002g).

**REQ-CLOUD-003i — `delOrd()` gets a symmetric `_sb` branch despite being confirmed dead code today** (`docs/architecture-data-model-v1.md` §6.3 — defined, unit-tested, but no UI element calls it). Included for consistency with every other entity's save/delete pair, and because a future REQ wiring up a delete button should not also have to remember to add Cloud Data awareness at that point.

**REQ-CLOUD-003j — No changes to `pullAll()`/`syncAll()`/`pushAll()`/`FIELD_MAPS` for Order Request.** It has no existing footprint in any of them (§1.1) — there is nothing to exclude.

---

## 3. Explicitly out of scope

- **Quote and Purchase Order Cloud Data migration** — `REQ-CLOUD-004`/`REQ-CLOUD-005` (§0).
- **`docs/architecture-data-model-v1.md` §6.4** (`autoPos()`/`qteToPoConvert()` never call `logEv()`) — assigned to `REQ-CLOUD-005` (§1.6), since both functions are PO-creation code this REQ does not touch.
- **The newly-found `delPO()` → `Quote.linkedPOIds[]` cleanup gap** — assigned to `REQ-CLOUD-005` (§1.6).
- **`ORD-GAP-001`/`002`/`004`** — pre-existing, unrelated to Cloud Data migration mechanics.
- **Making `delOrd()` reachable from the UI** — it gets a Cloud Data branch (REQ-CLOUD-003i) but stays otherwise dead code; wiring up a delete button for Order Requests is a separate product decision.
- **`processImport('ord')`'s CSV import branch** (`index.html:8639-8712`) bypassing Cloud Data, including its embedded Contact-creation sub-path — this is the same class of gap already logged as `CLOUD-GAP-003`; not fixed here, extending that gap's scope statement on completion (§7) rather than fixing it, matching `REQ-CLOUD-002`'s own precedent of leaving CSV-import bypass for a future standalone REQ.
- **`Order Request Line`'s CSV-import shape inconsistency** (`docs/architecture-data-model-v1.md` §6.11 — CSV-imported lines don't initialize `rfqResponses`/`committedResponseId`) — pre-existing, unrelated to Cloud Data mechanics, already tolerated by defensive `||[]`/`||null` guards everywhere it's read.
- **`REQ-ORD-004`** (triage → Order Request CSV export) — confirmed unshipped/untracked by direct research; unrelated to this REQ regardless.

---

## 4. Acceptance criteria

- **AC-1:** With Cloud Data configured, migrating Order Requests inserts every local Order Request into `order_requests`, mapping every real `DB.ord` field (`num`, `contactId`→`contact_id`, `stage`, `description`, `actions[]`→jsonb, `activeQuoteId`→`active_quote_id` — carried forward as its current local-or-cloud value, not resolved or rewritten, since Quote is out of scope here — `outcome`→jsonb, `lines[]`→`lines` jsonb **unchanged, including every nested RFQ Response and every nested id**, `createdAt`→`created_at`, `importBatchId`→`import_batch_id`). `id` is correctly omitted (Postgres assigns a fresh UUID, matching every prior migration's convention).
- **AC-2:** No Supplier- or Contact-migration-completion precondition blocks Order Request's migration (§1.2, §2b); an install where neither Supplier nor Contact has ever been Cloud-migrated can still migrate Order Requests successfully.
- **AC-3:** After migration, `Quote.lines[].sourceOrdId` is rewritten to the new Supabase-assigned Order Request id everywhere it matches; `sourceOrdLineId`/`sourceRfqResponseId` are confirmed unchanged by an explicit test, not merely absent from the sweep by omission.
- **AC-4:** `migrateSuppliersBuyersToSupabase()`'s sweep now also rewrites `DB.ord[].lines[].rfqResponses[].supId` and `.contactId` wherever they match a migrated Supplier/Contact — verified both when Order Request has not yet migrated (local-only fix) and when it has (the fix is pushed to the cloud-hosted `order_requests` row, not just the local array).
- **AC-5:** All nine mutation sites listed in §1.4/REQ-CLOUD-003c persist via `persistOrdChange()`; each one's existing local-only behavior is byte-for-byte unchanged when Cloud Data is not configured or Order Request has not yet migrated, and each pushes correctly to Supabase once it has.
- **AC-6:** `showBlockingBackupModal()`'s existing manual-attestation gate blocks any Supabase write until checked; declining aborts with no partial state, matching every prior migration.
- **AC-7:** Pre-migration `DB.ord` is archived (not deleted) for 30 days, restorable via `restoreOrdMigrationArchive()`, which disconnects Cloud Data and clears `st_ord_cloud_migration_ts` on restore.
- **AC-8:** Zero regressions to Supplier/Buyer, Line Item, or Contact's existing Cloud Data behavior, or any of the 712 existing tests.
- **AC-9:** `refreshOrdFromSupabase()` refuses to overwrite real local `DB.ord` data on a device that has never itself run the Order Request migration and sets its own completion marker on any successful refresh (including a fresh second device's first load) — both fixes `REQ-CLOUD-002` needed two separate spec-gate rounds to reach, applied here from the start.

---

## 5. Testing approach

Follows the established pattern: unit tests for the (absence of a) precondition gate (AC-2, both zero-Supplier and zero-Contact cases), the migration function's field-mapping and nested-structure-preservation correctness (AC-1, including a multi-line Order Request with multiple RFQ Responses per line and at least one committed response), the external-reference sweep (AC-3, including a Quote line with all three `source*` fields set, confirming exactly one is rewritten), the Supplier-sweep retrofit (AC-4, both the not-yet-migrated and already-migrated Order Request cases — this is the test that would have caught §1.3's bug had it existed at `REQ-CLOUD-001` time), each of the nine `persistOrdChange()` call sites in both its `_sb`-configured-and-migrated and local-only forms (AC-5 — by far the largest test surface in this REQ, mirroring `REQ-CLOUD-002`'s round-3 finding that this exact class of site is where real bugs hide), the backup gate (AC-6), archive/rollback (AC-7), and the refresh-guard/self-marking pair (AC-9, reusing the exact test pattern `REQ-CLOUD-002`'s `tests/run.js` already established for Line Item/Contact).

---

## 6. Gate process

Per `CLAUDE.md`'s standing checklist: requirements-gate → SPEC → spec-gate → implementation → self-performed mutation testing → build-gate → PR → CI green → merge. Given `REQ-CLOUD-002` needed 4 spec-gate rounds for a materially smaller scope (two flat entities vs. one entity with a nested structure and nine mutation sites), expect at least as many here, and budget for a genuine possibility of a new class of finding around the `persistOrdChange()` shared-helper design itself (e.g., whether a whole-row update is safe if two of the nine sites could plausibly race within one operator's own session).

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: extend `CLOUD-GAP-003`'s scope statement to note it also covers `processImport('ord')`'s Order-Request-creation path (not just its embedded Contact-creation sub-path already covered).
- `docs/requirements-tracker.md`: add `REQ-CLOUD-003` with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `docs/architecture-data-model-v1.md`: update §2 entity inventory (Order Request/Order Request Line/RFQ Response rows) and §4.2's Order Request narrative to reflect Cloud Data now in scope; update §8's sequencing to record Phase 2 is proceeding as three sequential sub-phases (this document's §0) rather than one combined delivery, and mark sub-phase 1 (Order Request) complete once shipped.

---

## 8. Review-resolution log

(Pending requirements-gate.)
