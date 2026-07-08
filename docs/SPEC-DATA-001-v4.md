# SPEC-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Derived from:** REQ-DATA-001 v4
**Status:** Draft v4 — resubmitted after requirements-gate FAIL on the v3 requirement
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Supersedes:** SPEC-DATA-001-v3 (requirements-gate FAIL — AC-010 factually wrong for two of four entities; RPT-002 mitigation stated in present tense despite being unbuilt. See §10 Changelog.)
**Sibling requirement:** REQ-RPT-002-v2 (external data-quality reporting pipeline — see §4.1; DATA-GAP-001 is open/unmitigated until that requirement ships, per REQ-DATA-001-v4 §7)

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

**AC-010 (corrected in v4 — v3's claim was factually wrong for two of four entities):** `doImport()`'s restore behavior is **not uniform across the four `num`-bearing entities** — verified by reading `index.html:7532-7576` in full, not just the `entities.forEach` line:

- **Suppliers and Line Items** (`sup`, `li`): part of the `entities` array (`['sup','li','inv','po','payments','sh','qt']`), processed unconditionally at line 7557: `entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; })`. A restore always wholesale-replaces these two — a missing key in the imported file empties the array, it does not preserve the existing one. "Restored array order" for these two is precisely the array order in the imported JSON, full stop.
- **Buyers and Contacts** (`buy`, `con`): **not** in the `entities` array — each has its own conditional guard: `if (data.con !== undefined) { DB.con = ...; }` (line 7558-7560) and `if (data.buy && Array.isArray(data.buy)) { DB.buy = data.buy; ...; }` (line 7570). If the imported file lacks a `con` or `buy` key (e.g. a pre-Buyers or pre-Contacts backup), the **existing live array is silently preserved**, not replaced. This is the exact behavior already logged under `CON-GAP-005` for Contacts; Buyers exhibit the identical pattern, though no existing gap ID currently names it for Buyers specifically.

**Consequence for `backfillRefNums()`:** for Suppliers/Line Items, a restore is always followed by a fresh backfill pass against the imported array in its exact order — no ambiguity. For Buyers/Contacts, if the restored file lacks that key, there is nothing new to backfill — the live records (and any `num` values already assigned to them) are simply untouched. If the restored file *does* include `buy`/`con`, those records replace the local array wholesale and are backfilled in the imported order, identically to Suppliers/Line Items. In neither case does a restore compound divergence beyond what that single restore event produces — but the two entity groups reach that outcome via genuinely different code paths, and §8's test plan must cover both separately, not assume one behavior for all four entities.

### 4.1 Cross-Device Consistency (revised in v3 — corrected framing, no longer a flawed analogy to SEC-GAP-011)

Per §1, Suppliers, Line Items, and Contacts already sync to Google Sheets; `num` is **not** added to `FIELD_MAPS`. Unlike v2, this is stated here as a **permanent** design decision, not a "not yet" — because this session's investigation confirmed the live Sheets sync mechanism itself has a documented history of operational failure (`SYNC-GAP-001`, `SEC-GAP-011`, and a v2.9.38 security fix that had to be hot-fixed and reverted because Apps Script's `doPost()` cannot read HTTP headers). Extending that mechanism to also carry `num` would add a new failure surface to an already-fragile system.

**Consequence, stated without minimizing it:** `num` is assigned per-device, from local array order, with **no reconciliation mechanism** — this is unlike SEC-GAP-011, where Sheets deterministically "wins" on the next pull; there is no equivalent event that will ever bring two devices' `num` assignments for the same real-world Supplier/Line Item/Contact back into agreement. This is permanent, not temporary, and this spec does not claim otherwise.

**Mitigation status — corrected in v4 to state this as a dependency, not a present-tense claim:** **REQ-RPT-002** (a sibling requirement, currently Draft, not yet gate-passed or built) proposes a detection process for this exact divergence — comparing `num` assignments across per-device backup exports via an Excel reporting workbook. **This spec does not claim that mitigation currently exists.** DATA-GAP-001 must be logged as **open, with no mitigation available**, until REQ-RPT-002 has independently passed requirements-gate and spec-gate, and shipped. Only then does its status change to "detectable via documented process."

**Decision:** Logged as **DATA-GAP-001**, status open/unmitigated, cross-referencing REQ-RPT-002 as the intended (not yet available) detection mechanism.

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
- `backfillRefNums()`: assigns sequential numbers to records with no `num`; idempotent on second call; does not touch a record that already has `num`; `BUY-ADHOC` receives a `num` without its `id` changing
- **AC-010 test coverage, per entity group (corrected in v4 — v3 only tested one behavior for all four entities):**
  - Suppliers/Line Items: simulate a restore with a JSON payload lacking a `sup`/`li` key — confirm the array is emptied (not preserved), then backfilled from empty
  - Buyers/Contacts: simulate a restore with a JSON payload lacking a `buy`/`con` key — confirm the *existing* array and its `num` values are preserved untouched (matching `CON-GAP-005`'s documented behavior); separately, simulate a restore that *does* include `buy`/`con` — confirm wholesale replace and fresh backfill, identical to the Suppliers/Line Items case
  - Confirm a second simulated restore (either behavior) does not compound divergence beyond the first restore's outcome
- `saveSup()` / `saveLi()` / `saveBuy()` / `saveCon()`: new record gets a `num` assigned; editing an existing record does not change its `num`
- Regression: existing FK-dependent tests continue to pass unmodified — confirms `num` is additive and does not disturb `id`-based relationships

## 9. Rollout

1. Build + tests pass locally
2. `build-gate` and `schema-migration-reviewer` review (mandatory per CLAUDE.md — new fields across four entity schemas)
3. Version bump, changelog, known-gaps entries — introduces **DATA-GAP-001**, logged with status **open, unmitigated** (§4.1) — not "mitigated," since REQ-RPT-002 is not yet built; does not close AI-GAP-008 yet, only notes the prerequisite is in place
4. **REQ-RPT-002 should ship before or alongside this spec's build**, so DATA-GAP-001's status can be updated to "detectable via documented process" as soon as possible after this spec ships, rather than sitting open indefinitely
5. PR raised for operator testing before merge, per standard process

## 10. Changelog

**v4 (this version):** Resubmitted after requirements-gate FAIL on v3. Two remaining gaps addressed:
1. AC-010 corrected — v3 claimed a uniform "wholesale replace" for all four `num`-bearing entities; verified false for Buyers and Contacts, which use a conditional preserve-if-key-absent pattern (matching the already-logged `CON-GAP-005`), not the unconditional replace used for Suppliers and Line Items. AC-010 and its test coverage (§8) now describe both behaviors separately.
2. §4.1/§9 corrected to state the REQ-RPT-002 mitigation as a stated dependency/precondition ("DATA-GAP-001 is open and unmitigated until RPT-002 ships"), not a present-tense assumption that mitigation already exists for an unbuilt sibling requirement

**v3:** Dropped the flawed SEC-GAP-011 analogy and cited REQ-RPT-002, and attempted to resolve AC-010 via `doImport()` — but over-generalized the wholesale-replace finding to all four entities when it only verifiably applies to two, and stated the RPT-002 mitigation in the present tense despite it being unbuilt. FAIL.

**v2:** Addressed v1's three gaps but the SEC-GAP-011 analogy was found invalid and AC-010 was still ambiguous. FAIL.

**v1:** Initial draft. FAIL — cross-device divergence, deletion/restore interaction, and unsubstantiated "sequential" claim all unaddressed.
