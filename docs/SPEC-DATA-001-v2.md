# SPEC-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Derived from:** REQ-DATA-001 v2
**Status:** Draft v2 — resubmitted after requirements-gate FAIL on the v1 requirement
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Supersedes:** SPEC-DATA-001-v1

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

**New column added in v2, per requirements-gate finding:** "Syncs to Sheets?" — this is the direct basis for the cross-device consistency risk in §4.1. Three of the four entities affected by this spec (`sup`, `li`, `con`) already sync; `buy` does not.

## 2. New Field Definition

A single new field, `num`, is added to four entities: `sup`, `li`, `buy`, `con`.

```js
// Added to each record shape — example for Supplier (synthetic example name,
// not a real trading-partner name — per requirements-gate v1 GDPR reminder
// on avoiding real supplier/buyer names in example blocks in this public repo)
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

Format: `<PREFIX>-NNNN`, zero-padded to 4 digits, matching the existing `QTE-0001` convention already in production. Consistent, so a future session or the AI system prompt only needs to learn one pattern, not four bespoke ones.

**Properties:**
- Assigned once, at creation or backfill. Never re-assigned, never user-editable (no form field for it — consistent with how `INV10001` numbers are also not directly editable by the operator today).
- Unique **per device, per entity type** (see §4.1 — not globally unique across devices for a given real-world entity; not globally unique across entity types either — `SUP-0001` and `BUY-0001` coexisting is fine, exactly like `INV10001` and `PO10001` coexist today).
- Assignment-ordered (see §3 — this is not a verified true-creation-order guarantee for entities without `createdAt`).
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

Called at record-creation time in each `save*()` function (`saveSup`, `saveLi`, `saveBuy`, `saveCon`), assigning `num` only when creating a **new** record (`num` is never touched on an edit-save of an existing record).

**Note on AC-009 (no reuse after delete):** because `nextRefNum()` always scans the *current* array for the highest existing number, a deleted record's number is never reissued — the next created record always gets `max + 1` relative to whatever remains, and since numbers are never removed from already-existing records, the historical maximum is never lost even if the record holding it is deleted. No extra bookkeeping (e.g. a separate "last issued number" counter) is required.

## 4. Backfill / Migration Approach

Existing records (demo data, and any real records already in a user's `localStorage`) have no `num`. A one-time, idempotent backfill function runs on every app load, following the exact existing pattern of `seedAdHocBuyer()` and `repairCalcFields()` — both already called from `initApp()` for this same class of problem (bringing older localStorage data in line with newer schema expectations).

```js
function backfillRefNums() {
  function assign(arr, prefix) {
    // Order by createdAt if present, else preserve existing array order
    // (array order is stable and append-only in this app — safe proxy for
    // creation order on entities with no createdAt field, e.g. Suppliers).
    // This is an assignment-order guarantee, not a verified creation-order
    // guarantee — see REQ-DATA-001-v2 AC-002.
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

**AC-010 (restore/import interaction):** `backfillRefNums()` runs on every `initApp()`, including immediately after a `doImport()` restore. If the restored backup pre-dates `num` entirely, the restored records get freshly assigned `num` values in their restored array order — same idempotent logic, no special-casing needed. This is explicitly **not** guaranteed to match `num` values from before the restore, or from any other device — see §4.1.

### 4.1 Cross-Device Consistency — Accepted Risk (added in v2, per requirements-gate finding)

Per the sync column in §1, Suppliers, Line Items, and Contacts already sync to Google Sheets; `num` is deliberately **not** added to `FIELD_MAPS` in this version (§5 out-of-scope). Consequence: **`num` is assigned per-device, from local array order, with no shared sequence.** The same real-world Supplier pulled onto a second device can receive a different `num` there than on the first device.

This does not corrupt data or break any relationship — `id` remains the actual foreign key everywhere, completely untouched by this spec. The only consequence is potential operator confusion if `num` values are compared across two devices for what is believed to be the same record. Buyers are entirely unaffected (they don't sync at all — BUY-GAP-001).

**Accepted at current scale** (sole operator, 1–3 devices, low sync frequency), consistent with the precedent already set by SEC-GAP-011's acceptance of a related sync-conflict risk. To be logged as **DATA-GAP-001** alongside this feature's build. Resolution path if revisited: add `num` to the relevant `FIELD_MAPS` entries so Sheets becomes the shared source of truth for sequence numbers — a distinct, separately-reviewable change (a genuine *new* sync-mapping addition, unlike this spec's purely local scope).

## 5. BUY-ADHOC Special Case

The seeded Ad-Hoc buyer record uses `BUY-ADHOC` as its **internal `id`** (not a `uid()` output) — a pre-existing special case (`index.html:4589`) predating this spec. Under the backfill logic above, this record would receive `num: 'BUY-0001'` like any other, since it has no `num` yet and the `id` field is untouched by this spec.

**Decision:** leave as-is. `BUY-ADHOC`'s `id` remains the special sentinel value already checked throughout the codebase (`id !== 'BUY-ADHOC'` guards at `index.html:4660`, `4722`, etc.) — this spec does not touch `id` values for any record, including this one. Its new `num` (e.g. `BUY-0001`) is purely additive and does not interact with any existing `BUY-ADHOC` string-literal check. Buyers do not sync (§4.1), so this record has no cross-device consistency exposure either.

## 6. Primary Key Strategy — Forward Compatibility with v3.0.0 Supabase Migration

STACKD_CONTEXT.md confirms v3.0.0 is a locked, planned migration to a Supabase (Postgres) backend, with a hard rule (FM-1) against new localStorage-stack architecture in the meantime. This spec is deliberately designed to make that future migration easier, without doing any of that migration work now:

| Concept | v2.9.x (now, unchanged) | v3.0.0 Supabase (future, not built by this spec) |
|---|---|---|
| Internal PK (`id`) | `uid()` — opaque, timestamp+random base36 string | Swapped to a real Postgres `UUID` (or `gen_random_uuid()`) in a single one-time remap script during migration. Safe, standard "surrogate key swap" — internal IDs are never user-facing, so remapping every `id` (and every FK that points to it) in one migration transaction carries no user-visible risk. |
| Business key (`num`) | Introduced by this spec — human-facing, assignment-ordered, display-only | Becomes a `UNIQUE NOT NULL` indexed column on each corresponding Postgres table (e.g. `suppliers.num`). Already populated for every record by the time migration happens — and crucially, the migration itself is the natural point to **also resolve §4.1's cross-device divergence**, since Supabase becomes the single shared source of truth server-side, permanently closing DATA-GAP-001 as a side effect of the cutover rather than requiring a separate local-only fix beforehand. |

**Why this matters:** without this spec, the v3.0.0 migration would need to *invent* a human-facing identifier scheme for Suppliers/Buyers/Contacts/Line Items from scratch, under the time pressure of a live cutover, likely reusing whatever `id` values existed (opaque `uid()` strings) as a stopgap. This spec removes that problem years in advance by making the business-key backfill a routine, low-stakes v2.9.x change instead — and identifies that the migration itself, not a v2.9.x patch, is the natural point to close the cross-device gap this version knowingly accepts.

**Explicitly not done now (correctly, per FM-1):** no change to `uid()`, no UUID library added, no Supabase client code, no server calls, no new `FIELD_MAPS` sync entries. The only new client-side logic is the `num` generation/backfill functions described above — pure `localStorage`-only, matching every existing convention in the file.

## 7. Updated Entity Relationship Diagram

Delivered as a full rewrite of `docs/data-model.md` (previously scoped to Contact↔Quote only). See that file for the complete conceptual, logical, and physical model.

## 8. Test Plan

New tests in `tests/run.js`, following the existing test harness pattern:

- `nextRefNum()` unit tests: empty array → `PREFIX-0001`; existing records with gaps/out-of-order numbers → correct next value; prefix collision safety (e.g. `SUP-0001` vs `SUPPLIER-0001` do not collide); **deleted-record gap does not get reissued** (AC-009 — create three, delete the middle one, confirm the next created record gets the next-highest number, not the deleted one's)
- `backfillRefNums()`: assigns sequential numbers to a set of records with no `num`; idempotent on second call (no duplicate/reassigned numbers); does not touch a record that already has `num`; `BUY-ADHOC` receives a `num` without its `id` changing; **simulated restore scenario** (AC-010 — records with no `num` field, as if freshly imported from a pre-`num` backup, get assigned fresh numbers in array order on the next backfill call)
- `saveSup()` / `saveLi()` / `saveBuy()` / `saveCon()`: new record gets a `num` assigned; editing an existing record does not change its `num`
- Regression: existing FK-dependent tests (Supplier delete cascades, Buyer statement, Contact→Quote conversion) continue to pass unmodified — confirms `num` is additive and does not disturb `id`-based relationships

## 9. Rollout

1. Build + tests pass locally
2. `build-gate` and `schema-migration-reviewer` review (mandatory per CLAUDE.md — this is exactly the class of change that gate exists for: new fields across four entity schemas)
3. Version bump, changelog, known-gaps entries — this spec directly informs a future fix for AI-GAP-008 (do not close that gap yet, only note the prerequisite is now in place) and introduces **DATA-GAP-001** (§4.1, cross-device `num` divergence, accepted risk)
4. PR raised for operator testing before merge, per standard process

## 10. Changelog

**v2 (this version):** Resubmitted alongside REQ-DATA-001-v2 after requirements-gate FAIL on v1. Changes:
1. Added "Syncs to Sheets?" column to §1 entity inventory — the basis for the new cross-device risk analysis
2. Added §4.1 — Cross-Device Consistency accepted-risk section, and referenced it from §2, §4, §5, §6
3. Replaced the real supplier name (`Shandong Jinbao New Materials` — a name appearing in `STACKD_CONTEXT.md`'s actual trading-partner data) in the §2 example with a synthetic placeholder, per the GDPR/public-repo reminder raised at requirements-gate
4. Softened "sequential" language throughout to "assignment-ordered," consistent with REQ-DATA-001-v2 AC-002
5. Added AC-009/AC-010 coverage to §3, §4, and the §8 test plan
6. §9 Rollout now explicitly calls out logging DATA-GAP-001 alongside the build

**v1:** Initial draft, derived from REQ-DATA-001-v1.
