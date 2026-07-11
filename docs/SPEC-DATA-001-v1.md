# SPEC-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Derived from:** REQ-DATA-001 v1
**Status:** Draft — pending spec-gate review
**Date:** 2026-07-08
**Author:** FPM International / Claude Code

---

## 1. Current State — Full Entity Inventory

| Entity | `DB` key | Internal PK | Existing business key? | FK relationships (current) |
|---|---|---|---|---|
| Suppliers | `sup` | `id` (`uid()`) | **None** | `li.supId`, `po.supId` → `sup.id` |
| Line Items (catalogue) | `li` | `id` (`uid()`) | **None** — `sku` exists but is free-text, optional, not unique-enforced | `li.supId` → `sup.id`; invoice line items reference `li.id` via `lid` |
| Buyers | `buy` | `id` (`uid()`, except seeded `BUY-ADHOC`) | **None** | `inv.buyerId` → `buy.id` |
| Contacts | `con` | `id` (`uid()`) | **None** | `con.supplierId` → `sup.id`; `qt.sourceContactId` → `con.id` |
| Invoices | `inv` | `id` (`uid()`) | `num` (e.g. `INV10001`) — auto-generated via `nextInvNum()` | `inv.buyerId` → `buy.id` |
| Credit Notes | `inv` (same table, `type` discriminator) | `id` (`uid()`) | `num` (e.g. `CN10001`) — reuses invoice numbering space | `linkedInvId` → `inv.id` **and** `linkedInvNum` → `inv.num` (both stored, redundant) |
| Purchase Orders | `po` | `id` (`uid()`) | `num` — **user-typed**, required, uniqueness-validated, not auto-generated | `po.supId` → `sup.id`; `po.invNum`/`invId` → `inv.num`/`inv.id` (when converted from an invoice) |
| Quotes | `qt` | `id` (`uid()`) | `num` (e.g. `QTE-0001`) — auto-generated via `nextQteNum()` | `qt.sourceContactId` → `con.id`; `qt.linkedPOId` → `po.id`; each quote line item carries its own `supId` → `sup.id` |
| Shipments | `sh` | `id` (`uid()`) | `ref` — **user-typed**, required, uniqueness-validated | `sh.linkedInvs` → **array of `inv.num` strings** (business key, not `id`) |
| Payments | `payments` | `id` (`uid()`) | None (not independently referenced elsewhere) | Tied to an invoice via context, not a stored FK field |
| Events | `events` | `id` (`uid()`) | None | `entityId` + `entityType` — a loose, untyped reference to any other entity's `id` |

**Observation carried into the ERD (§7):** the app already has two different FK conventions in production — internal-ID-based (`supId`, `buyerId`, `sourceContactId`, `linkedPOId`) and business-key-based (`linkedInvNum`, `sh.linkedInvs`). This spec does not reconcile that; it is noted so a future v3.0.0 migration decision-maker has the full picture rather than discovering it mid-migration.

## 2. New Field Definition

A single new field, `num`, is added to four entities: `sup`, `li`, `buy`, `con`.

```js
// Added to each record shape — example for Supplier
{
  id:   'mo98b4ito9o',   // unchanged — internal PK, uid() output
  num:  'SUP-0001',      // NEW — business key, human/AI-referenceable
  name: 'Shandong Jinbao New Materials',
  // ...existing fields unchanged
}
```

| Entity | Prefix | Example |
|---|---|---|
| Suppliers | `SUP` | `SUP-0001` |
| Line Items | `LI` | `LI-0001` |
| Buyers | `BUY` | `BUY-0001` |
| Contacts | `CON` | `CON-0001` |

Format: `<PREFIX>-NNNN`, zero-padded to 4 digits, matching the existing `QTE-0001` convention already in production. Consistent, so a future session or the AI system prompt only needs to learn one pattern, not four bespoke ones.

**Properties:**
- Assigned once, at creation or backfill. Never re-assigned, never user-editable (no form field for it — consistent with how `INV10001` numbers are also not directly editable by the operator today).
- Unique per entity type (not globally unique across entity types — `SUP-0001` and `BUY-0001` coexisting is fine, exactly like `INV10001` and `PO10001` coexist today).
- Sequential, based on creation order.

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

Called at record-creation time in each `save*()` function (`saveSup`, `saveLi`, `saveBuy`, `saveCon`), assigning `num` only when creating a **new** record (`num` is never touched on an edit-save of an existing record).

## 4. Backfill / Migration Approach

Existing records (demo data, and any real records already in a user's `localStorage`) have no `num`. A one-time, idempotent backfill function runs on every app load, following the exact existing pattern of `seedAdHocBuyer()` and `repairCalcFields()` — both already called from `initApp()` for this same class of problem (bringing older localStorage data in line with newer schema expectations).

```js
function backfillRefNums() {
  function assign(arr, prefix) {
    // Order by createdAt if present, else preserve existing array order
    // (array order is stable and append-only in this app — safe proxy for
    // creation order on entities with no createdAt field, e.g. Suppliers)
    var ordered = arr.slice().sort(function(a, b) {
      if (a.createdAt && b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return 0; // no createdAt on either — leave relative order untouched
    });
    var next = 1;
    ordered.forEach(function(rec) {
      if (!rec.num) {
        rec.num = prefix + '-' + String(next).padStart(4, '0');
      }
      // advance `next` past any already-assigned number so re-runs don't collide
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

**Idempotency guarantee (AC-004):** the `if (!rec.num)` guard means a record that already has a `num` is never touched on subsequent runs — safe to call on every page load indefinitely, exactly like `seedAdHocBuyer()` already is.

## 5. BUY-ADHOC Special Case

The seeded Ad-Hoc buyer record uses `BUY-ADHOC` as its **internal `id`** (not a `uid()` output) — a pre-existing special case (`index.html:4589`) predating this spec. Under the backfill logic above, this record would receive `num: 'BUY-0001'` like any other, since it has no `num` yet and the `id` field is untouched by this spec.

**Decision:** leave as-is. `BUY-ADHOC`'s `id` remains the special sentinel value already checked throughout the codebase (`id !== 'BUY-ADHOC'` guards at `index.html:4660`, `4722`, etc.) — this spec does not touch `id` values for any record, including this one. Its new `num` (e.g. `BUY-0001`) is purely additive and does not interact with any existing `BUY-ADHOC` string-literal check.

## 6. Primary Key Strategy — Forward Compatibility with v3.0.0 Supabase Migration

STACKD_CONTEXT.md confirms v3.0.0 is a locked, planned migration to a Supabase (Postgres) backend, with a hard rule (FM-1) against new localStorage-stack architecture in the meantime. This spec is deliberately designed to make that future migration easier, without doing any of that migration work now:

| Concept | v2.9.x (now, unchanged) | v3.0.0 Supabase (future, not built by this spec) |
|---|---|---|
| Internal PK (`id`) | `uid()` — opaque, timestamp+random base36 string | Swapped to a real Postgres `UUID` (or `gen_random_uuid()`) in a single one-time remap script during migration. Safe, standard "surrogate key swap" — internal IDs are never user-facing, so remapping every `id` (and every FK that points to it) in one migration transaction carries no user-visible risk. |
| Business key (`num`) | Introduced by this spec — human-facing, sequential, display-only | Becomes a `UNIQUE NOT NULL` indexed column on each corresponding Postgres table (e.g. `suppliers.num`). Already fully populated and consistent for every record by the time migration happens, because the v2.9.x backfill in §4 will have run for months beforehand — no first-time backfill needed under migration pressure. |

**Why this matters:** without this spec, the v3.0.0 migration would need to *invent* a human-facing identifier scheme for Suppliers/Buyers/Contacts/Line Items from scratch, under the time pressure of a live cutover, likely reusing whatever `id` values existed (opaque `uid()` strings) as a stopgap. This spec removes that problem years in advance by making the business-key backfill a routine, low-stakes v2.9.x change instead.

**Explicitly not done now (correctly, per FM-1):** no change to `uid()`, no UUID library added, no Supabase client code, no server calls. The only new client-side logic is the `num` generation/backfill functions described above — pure `localStorage`-only, matching every existing convention in the file.

## 7. Updated Entity Relationship Diagram

Delivered as a full rewrite of `docs/data-model.md` (previously scoped to Contact↔Quote only). See that file for the complete conceptual, logical, and physical model.

## 8. Test Plan

New tests in `tests/run.js`, following the existing test harness pattern:

- `nextRefNum()` unit tests: empty array → `PREFIX-0001`; existing records with gaps/out-of-order numbers → correct next value; prefix collision safety (e.g. `SUP-0001` vs `SUPPLIER-0001` do not collide)
- `backfillRefNums()`: assigns sequential numbers to a set of records with no `num`; idempotent on second call (no duplicate/reassigned numbers); does not touch a record that already has `num`; `BUY-ADHOC` receives a `num` without its `id` changing
- `saveSup()` / `saveLi()` / `saveBuy()` / `saveCon()`: new record gets a `num` assigned; editing an existing record does not change its `num`
- Regression: existing FK-dependent tests (Supplier delete cascades, Buyer statement, Contact→Quote conversion) continue to pass unmodified — confirms `num` is additive and does not disturb `id`-based relationships

## 9. Rollout

1. Build + tests pass locally
2. `build-gate` and `schema-migration-reviewer` review (mandatory per CLAUDE.md — this is exactly the class of change that gate exists for: new fields across four entity schemas)
3. Version bump, changelog, known-gaps entries (this spec directly informs a future fix for AI-GAP-008 — do not close that gap yet, only note the prerequisite is now in place)
4. PR raised for operator testing before merge, per standard process
