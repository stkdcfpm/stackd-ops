# SPEC-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Derived from:** REQ-DATA-001 v3
**Status:** Draft v3 — resubmitted after requirements-gate FAIL on the v2 requirement
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Supersedes:** SPEC-DATA-001-v2
**Sibling requirement:** REQ-RPT-002-v1 (external data-quality reporting pipeline — see §4.1)

---

## 1. Current State — Full Entity Inventory

| Entity | `DB` key | Internal PK | Existing business key? | Syncs to Sheets? | FK relationships (current) |
|---|---|---|---|---|---|
| Suppliers | `sup` | `id` (`uid()`) | **None** | Yes (`FIELD_MAPS.sup`) | `li.supId`, `po.supId` → `sup.id` |
| Line Items (catalogue) | `li` | `id` (`uid()`) | **None** — `sku` exists but is free-text, optional, not unique-enforced | Yes (`FIELD_MAPS.li`) | `li.supId` → `sup.id`; invoice line items reference `li.id` via `lid` |
| Buyers | `buy` | `id` (`uid()`, except seeded `BUY-ADHOC`) | **None** | **No** (BUY-GAP-001 — frozen, no `FIELD_MAPS` entry at all) | `inv.buyerId` → `buy.id` |
| Contacts | `con` | `id` (`uid()`) | **None** | Yes (`FIELD_MAPS.co`) | `con.supplierId` → `sup.id`; `qt.sourceContactId` → `con.id` |
| Invoices | `inv` | `id` (`uid()`) | `num` (e.g. `INV10001`) — auto-generated via `nextInvNum()` | Yes | `inv.buyerId` → `buy.id` |
| Credit Notes | `inv` (same table, `type` discriminator) | `id` (`uid()`) | `num` (e.g. `CN10001`) — reuses invoice numbering space | Yes | `linkedInvId` → `inv.id` **and** `linkedInvNum` → `inv.num` (both stored, redundant) |
| Purchase Orders | `po` | `id` (`uid()`) | `num` — **user-typed**, required, uniqueness-validated, not auto-generated | Yes | `po.supId` → `sup.id`; `po.invNum`/`invId` → `inv.num`/`inv.id` (when converted from an invoice) |
| Quotes | `qt` | `id` (`uid()`) | `num` (e.g. `QTE-0001`) — auto-generated via `nextQteNum()` | No | `qt.sourceContactId` → `con.id`; `qt.linkedPOId` → `po.id`; each quote line item carries its own `supId` → `sup.id` |
| Shipments | `sh` | `id` (`uid()`) | `ref` — **user-typed**, required, uniqueness-validated | No | `sh.linkedInvs` → **array of `inv.num` strings** (business key, not `id`) |
| Payments | `payments` | `id` (`uid()`) | None (not independently referenced elsewhere) | Yes | Tied to an invoice via context, not a stored FK field |
| Events | `events` | `id` (`uid()`) | None | No | `entityId` + `entityType` — a loose, untyped reference to any other entity's `id` |

**Observation carried into the ERD (§7):** the app already has two different FK conventions in production — internal-ID-based (`supId`, `buyerId`, `sourceContactId`, `linkedPOId`) and business-key-based (`linkedInvNum`, `sh.linkedInvs`). This spec does not reconcile that; it is noted so a future v3.0.0 migration decision-maker has the full picture rather than discovering it mid-migration.

## 2. New Field Definition

A single new field, `num`, is added to four entities: `sup`, `li`, `buy`, `con`.

```js
// Added to each record shape — example for Supplier (synthetic example name,
// not a real trading-partner name, per the public-repo GDPR reminder raised
// at requirements-gate review)
{
  id:   'mo98b4ito9o',        // unchanged — internal PK, uid() output
  num:  'SUP-0001',           // NEW — business key, human/AI-referenceable
  name: 'Example Supplier Co.',
  // ...existing fields unchanged
}
```

| Entity | Prefix | Example |
|---|---|---|
| Suppliers | `SUP` | `SUP-0001` |
| Line Items | `LI` | `LI-0001` |
| Buyers | `BUY` | `BUY-0001` |
| Contacts | `CON` | `CON-0001` |

Format: `<PREFIX>-NNNN`, zero-padded to 4 digits, matching the existing `QTE-0001` convention already in production.

**Properties:**
- Assigned once, at creation or backfill. Never re-assigned, never user-editable.
- Unique **per device, per entity type** (see §4.1 — not a claim of global uniqueness across devices for the same real-world entity, and this is now a permanent design characteristic, not a v1-only limitation — see §4.1 for why).
- Assignment-ordered (see §3 — not a verified true-creation-order guarantee for entities without `createdAt`).
- Never reused after a record is deleted (AC-009) — the sequence only advances forward.

## 3. Generation Function

One function per entity, following the exact existing pattern of `nextInvNum()` / `nextQteNum()`:

```js
function nextRefNum(entityArray, prefix) {
  var max = 0;
  entityArray.forEach(function(rec) {
    if (rec.num && rec.num.indexOf(prefix + '-') === 0) {
      var n = parseInt(rec.num.slice(prefix.length + 1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}
```

Called at record-creation time in each `save*()` function (`saveSup`, `saveLi`, `saveBuy`, `saveCon`), assigning `num` only when creating a **new** record.

**Note on AC-009 (no reuse after delete):** because `nextRefNum()` always scans the *current* array for the highest existing number, a deleted record's number is never reissued — the next created record always gets `max + 1` relative to whatever remains. No extra bookkeeping (e.g. a separate "last issued number" counter) is required.

## 4. Backfill / Migration Approach

A one-time, idempotent backfill function runs on every app load, following the exact existing pattern of `seedAdHocBuyer()` and `repairCalcFields()`:

```js
function backfillRefNums() {
  function assign(arr, prefix) {
    // Order by createdAt if present, else preserve existing array order
    // (array order is stable and append-only in this app — safe proxy for
    // creation order on entities with no createdAt field, e.g. Suppliers).
    // This is an assignment-order guarantee, not a verified creation-order
    // guarantee — see REQ-DATA-001-v3 AC-002.
    var ordered = arr.slice().sort(function(a, b) {
      if (a.createdAt && b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return 0; // no createdAt on either — leave relative order untouched
    });
    var next = 1;
    ordered.forEach(function(rec) {
      if (!rec.num) {
        rec.num = prefix + '-' + String(next).padStart(4, '0');
      }
      if (rec.num && rec.num.indexOf(prefix + '-') === 0) {
        var n = parseInt(rec.num.slice(prefix.length + 1), 10);
        if (!isNaN(n) && n >= next) next = n + 1;
      }
    });
  }
  assign(DB.sup, 'SUP');
  assign(DB.li,  'LI');
  assign(DB.buy, 'BUY');
  assign(DB.con, 'CON');
  saveAll();
}
```

Called once from `initApp()`, alongside the existing `seedAdHocBuyer()` / `repairCalcFields()` calls (`index.html:9241`).

**Idempotency guarantee (AC-004):** the `if (!rec.num)` guard means a record that already has a `num` is never touched on subsequent runs.

**AC-010 (restore/import interaction — factually resolved in v3, was ambiguous in v2):** `doImport()` is confirmed, by reading `index.html:7532-7576`, to perform a **wholesale replace** of each entity array — `entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; })` — not a merge. The confirm dialog itself states "This will replace ALL current local data." This makes "restored array order" a precisely defined quantity: it is exactly the array order present in the imported JSON file, with no interleaving against pre-existing local records. `backfillRefNums()` running on the next `initApp()` after a restore therefore assigns `num` in that exact restored order, with no ambiguity about merge behavior. Repeated restores do not compound divergence beyond what a single restore already produces, because each restore is an independent wholesale replace, not an accumulation on top of prior state.

### 4.1 Cross-Device Consistency (revised in v3 — corrected framing, no longer a flawed analogy to SEC-GAP-011)

Per §1, Suppliers, Line Items, and Contacts already sync to Google Sheets; `num` is **not** added to `FIELD_MAPS`. Unlike v2, this is stated here as a **permanent** design decision, not a "not yet" — because this session's investigation confirmed the live Sheets sync mechanism itself has a documented history of operational failure (`SYNC-GAP-001`, `SEC-GAP-011`, and a v2.9.38 security fix that had to be hot-fixed and reverted because Apps Script's `doPost()` cannot read HTTP headers). Extending that mechanism to also carry `num` would add a new failure surface to an already-fragile system.

**Consequence, stated without minimizing it:** `num` is assigned per-device, from local array order, with **no reconciliation mechanism** — this is unlike SEC-GAP-011, where Sheets deterministically "wins" on the next pull; there is no equivalent event that will ever bring two devices' `num` assignments for the same real-world Supplier/Line Item/Contact back into agreement. This is permanent, not temporary, and this spec does not claim otherwise.

**Mitigation — REQ-RPT-002, not sync:** rather than solve this in the sync layer, **REQ-RPT-002** (a sibling requirement drafted alongside this revision) provides a concrete, on-demand method for detecting this exact divergence: export a backup from each device in use, load both into the Excel Power Query-based reporting workbook described there, and compare `num` assignments for records with matching names/emails. This converts an invisible, unbounded risk into a periodically-checkable one — not eliminated, but reviewable, with a defined, documented process rather than an assertion that it's fine.

**Decision:** Logged as **DATA-GAP-001**, cross-referencing REQ-RPT-002 as its detection mechanism.

## 5. BUY-ADHOC Special Case

The seeded Ad-Hoc buyer record uses `BUY-ADHOC` as its **internal `id`** (not a `uid()` output) — a pre-existing special case (`index.html:4589`). Under the backfill logic above, this record would receive `num: 'BUY-0001'` like any other, since it has no `num` yet and the `id` field is untouched by this spec.

**Decision:** leave as-is. `BUY-ADHOC`'s `id` remains the special sentinel value already checked throughout the codebase (`id !== 'BUY-ADHOC'` guards at `index.html:4660`, `4722`, etc.) — this spec does not touch `id` values for any record, including this one. Buyers do not sync at all (BUY-GAP-001), so this record has no cross-device consistency exposure either.

## 6. Primary Key Strategy — Forward Compatibility with v3.0.0 Supabase Migration

STACKD_CONTEXT.md confirms v3.0.0 is a locked, planned migration to a Supabase (Postgres) backend, with a hard rule (FM-1) against new localStorage-stack architecture in the meantime. This spec is deliberately designed to make that future migration easier, without doing any of that migration work now:

| Concept | v2.9.x (now, unchanged) | v3.0.0 Supabase (future, not built by this spec) |
|---|---|---|
| Internal PK (`id`) | `uid()` — opaque, timestamp+random base36 string | Swapped to a real Postgres `UUID` (or `gen_random_uuid()`) in a single one-time remap script during migration — a safe, standard "surrogate key swap," since internal IDs are never user-facing. |
| Business key (`num`) | Introduced by this spec — human-facing, assignment-ordered, display-only | Becomes a `UNIQUE NOT NULL` indexed column on each corresponding Postgres table. Already populated for every record by the time migration happens — and the migration itself is the natural point that **permanently closes DATA-GAP-001**, since Supabase becomes the single shared source of truth server-side, making the current per-device divergence moot as a side effect of the cutover rather than something a v2.9.x patch needs to fix beforehand. |

**Why this matters:** without this spec, the v3.0.0 migration would need to *invent* a human-facing identifier scheme from scratch, under cutover pressure. This spec removes that problem years in advance, and correctly identifies the migration — not a local-only patch, and not the fragile sync mechanism — as the actual, permanent resolution point for cross-device consistency.

**Explicitly not done now (correctly, per FM-1):** no change to `uid()`, no UUID library, no Supabase client code, no server calls, no new `FIELD_MAPS` sync entries — not now, and per §4.1, not planned for later either.

## 7. Updated Entity Relationship Diagram

Delivered as a full rewrite of `docs/data-model.md`. See that file for the complete conceptual, logical, and physical model.

## 8. Test Plan

New tests in `tests/run.js`, following the existing test harness pattern:

- `nextRefNum()` unit tests: empty array → `PREFIX-0001`; existing records with gaps/out-of-order numbers → correct next value; prefix collision safety; deleted-record gap does not get reissued (AC-009)
- `backfillRefNums()`: assigns sequential numbers to records with no `num`; idempotent on second call; does not touch a record that already has `num`; `BUY-ADHOC` receives a `num` without its `id` changing; simulated restore scenario confirms AC-010's wholesale-replace behavior — records with no `num` (as if freshly restored) get fresh numbers in array order on the next backfill call, and a second simulated restore does not compound the divergence from the first
- `saveSup()` / `saveLi()` / `saveBuy()` / `saveCon()`: new record gets a `num` assigned; editing an existing record does not change its `num`
- Regression: existing FK-dependent tests continue to pass unmodified — confirms `num` is additive and does not disturb `id`-based relationships

## 9. Rollout

1. Build + tests pass locally
2. `build-gate` and `schema-migration-reviewer` review (mandatory per CLAUDE.md — new fields across four entity schemas)
3. Version bump, changelog, known-gaps entries — introduces **DATA-GAP-001** (§4.1, cross-device `num` divergence — permanent, mitigated by REQ-RPT-002's detection process, not "solved"); does not close AI-GAP-008 yet, only notes the prerequisite is in place
4. **REQ-RPT-002 should ship alongside or before this spec's build**, so DATA-GAP-001 has its mitigation available from day one rather than being logged as a gap with no usable detection process yet
5. PR raised for operator testing before merge, per standard process

## 10. Changelog

**v3 (this version):** Resubmitted after requirements-gate FAIL on v2. Two remaining gaps addressed:
1. §4.1 rewritten to drop the flawed SEC-GAP-011 analogy and instead reference REQ-RPT-002 (a new sibling requirement) as a concrete, on-demand detection mechanism for the cross-device divergence risk — which is now stated plainly as permanent and unresolved-by-sync, not minimized
2. AC-010 rewritten with the confirmed `doImport()` wholesale-replace behavior (verified by reading `index.html:7532-7576`), fully resolving the "restored array order" ambiguity and confirming repeated restores do not compound divergence
3. §3/§4.1/§6 revised throughout to state `num` will never be synced (a permanent decision, justified by the sync mechanism's own documented fragility), not merely deferred
4. §9 Rollout now recommends REQ-RPT-002 ship alongside this spec, not as an afterthought

**v2:** Addressed v1's three gaps but the SEC-GAP-011 analogy was found invalid and AC-010 was still ambiguous. FAIL.

**v1:** Initial draft. FAIL — cross-device divergence, deletion/restore interaction, and unsubstantiated "sequential" claim all unaddressed.
