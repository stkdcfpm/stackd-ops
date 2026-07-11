# SPEC-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Derived from:** REQ-DATA-001 v5
**Status:** Draft v5 — spec-gate FAIL on v4 (factual error in §1 Buyer PK claim, plus four code-correctness gaps); resubmitted with all five addressed
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Supersedes:** SPEC-DATA-001-v4 (spec-gate FAIL. See §10 Changelog.)
**Sibling requirement:** REQ-RPT-002-v2 (external data-quality reporting pipeline — see §4.1; DATA-GAP-001 is open/unmitigated until that requirement ships, per REQ-DATA-001-v5 §7)

---

## 1. Current State — Full Entity Inventory

| Entity | `DB` key | Internal PK | Existing business key? | Syncs to Sheets? | `createdAt` field? | FK relationships (current) |
|---|---|---|---|---|---|---|
| Suppliers | `sup` | `id` (`uid()`) | **None** | Yes (`FIELD_MAPS.sup`) | **No** — confirmed at `index.html:3547` | `li.supId`, `po.supId` → `sup.id` |
| Line Items (catalogue) | `li` | `id` (`uid()`) | **None** — `sku` exists but is free-text, optional, not unique-enforced | Yes (`FIELD_MAPS.li`) | **No** — confirmed at `index.html:3665` | `li.supId` → `sup.id`; invoice line items reference `li.id` via `lid` |
| Buyers | `buy` | **Corrected in v5 — was wrongly stated as `uid()` in v1-v4.** `id: 'BUY' + Date.now()` — a `BUY`-prefixed decimal timestamp (e.g. `BUY1720608432891`), verified at `saveBuy()` (`index.html:4708`) and `quickAddBuyer()` (`index.html:4611`). Neither function calls `uid()`. Exception: the seeded `BUY-ADHOC` sentinel record, whose `id` is the literal string `'BUY-ADHOC'`. | **None** | **No** (BUY-GAP-001 — frozen, no `FIELD_MAPS` entry at all) | **Yes** — set at both `saveBuy()` and `quickAddBuyer()` creation paths; **not guaranteed on every existing record** (legacy records created before `createdAt` was added to these functions may lack it — see §4's corrected comparator) | `inv.buyerId` → `buy.id` |
| Contacts | `con` | `id` (`uid()`) — confirmed at `index.html:8565` | **None** | Yes (`FIELD_MAPS.co`) | **Yes**, with the same legacy caveat as Buyers — `saveCon()` (`index.html:8573`) falls back to `existC.createdAt \|\| new Date().toISOString()` on edit, meaning a record that was never re-edited since before `createdAt` existed can still lack it | `con.supplierId` → `sup.id`; `qt.sourceContactId` → `con.id`|
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

**Corrected in v5 — spec-gate found the original `parseInt`-based parsing was not malformed-value-safe** (`parseInt('01x', 10)` returns `1`, not `NaN` — a partially-numeric corrupted `num`, e.g. from direct localStorage tampering, would silently count toward the max rather than being ignored or flagged). Also corrected: `nextRefNum()` and the backfill's inline logic were two independent implementations of the same "find next number" logic (v4 spec-gate finding — code duplication risk). v5 uses one shared, strictly-validated function for both:

```js
function parseRefNum(numStr, prefix) {
  // Strict format check — only a fully-matching PREFIX-NNNN (4+ digits)
  // counts as a validly-assigned number. Anything else (malformed,
  // partially-numeric, wrong prefix) returns null and is treated as
  // "not a valid existing number" rather than silently mis-parsed.
  var m = numStr && numStr.match(new RegExp('^' + prefix + '-(\\d{4,})$'));
  return m ? parseInt(m[1], 10) : null;
}

function nextRefNum(entityArray, prefix) {
  var max = 0;
  entityArray.forEach(function(rec) {
    var n = parseRefNum(rec.num, prefix);
    if (n !== null && n > max) max = n;
  });
  return prefix + '-' + String(max + 1).padStart(4, '0');
}
```

Called at record-creation time in each `save*()` function (`saveSup`, `saveLi`, `saveBuy`, `saveCon`), assigning `num` only when creating a **new** record.

**Malformed `num` handling (new in v5):** a record whose `num` doesn't match the strict `PREFIX-NNNN` pattern (e.g. `SUP-01x`, corrupted by direct localStorage editing, which this app does not prevent) is treated as if it has no valid number for max-tracking purposes — it does not silently participate in the sequence via a truncated partial parse. The malformed value itself is **not** overwritten or auto-corrected by `nextRefNum()` or the backfill (neither function ever touches a record that already has a non-empty `num` string, valid or not — see AC-003, "never re-assigned"). This is a deliberate choice: silently "fixing" a value that reached this state through unknown tampering risks masking a larger data-integrity problem the operator should investigate, not have hidden from them. A malformed `num` will surface visibly if using REQ-RPT-002's reporting pipeline, since a non-conforming value stands out in a sorted column.

**Note on AC-009 (no reuse after delete):** because `nextRefNum()` always scans the *current* array for the highest existing valid number, a deleted record's number is never reissued.

**Pre-existing duplicate `num` values (new in v5 — spec-gate finding):** neither `nextRefNum()` nor the backfill detects or prevents two records sharing an identical `num` (possible only via direct localStorage tampering — no code path in this app ever assigns a non-unique `num`, since both functions always compute `max + 1` fresh). This is accepted, consistent with the app's existing posture elsewhere: uniqueness for other business keys (e.g. invoice `num`) is enforced only at UI save-time validation (`vInv()`), not as a structural/storage-level constraint, and there is no existing precedent in this codebase for a background integrity scan enforcing uniqueness retroactively. **Detection, not prevention, is the appropriate mitigation:** `initApp()` already runs a "Data integrity check" (`index.html:9227-9235`, currently checking for CN/invoice type mismatches and logging `console.warn`) — this spec recommends extending that existing check to also flag duplicate `num` values per entity, following the same established pattern rather than inventing a new one. This is a minor, optional addition to `initApp()`'s existing integrity check function, not a new subsystem.

## 4. Backfill / Migration Approach

A one-time, idempotent backfill function runs on every app load, following the exact existing pattern of `seedAdHocBuyer()` and `repairCalcFields()`, and reusing `parseRefNum()` from §3 rather than reimplementing parsing logic (v5 correction — v4 had two independent implementations):

```js
function backfillRefNums() {
  function assign(arr, prefix) {
    // Order by createdAt where present; records without createdAt are
    // treated as older than any record that has one (a defensible,
    // simple policy — legacy records predate the field's introduction
    // on Buyers/Contacts, so are more likely to be genuinely older).
    // Corrected in v5: the original comparator returned 0 (no reorder)
    // whenever EITHER record lacked createdAt, not just when BOTH did —
    // incoherent for Buyers/Contacts, which commonly have a mix of
    // legacy (no createdAt) and newer (has createdAt) records.
    var ordered = arr.slice().sort(function(a, b) {
      var aHas = !!a.createdAt, bHas = !!b.createdAt;
      if (aHas && bHas) return a.createdAt < b.createdAt ? -1 : (a.createdAt > b.createdAt ? 1 : 0);
      if (aHas && !bHas) return 1;
      if (!aHas && bHas) return -1;
      return 0; // neither has createdAt — preserve original relative order (stable sort)
    });
    var next = 1;
    ordered.forEach(function(rec) {
      if (!rec.num) {
        rec.num = prefix + '-' + String(next).padStart(4, '0');
      }
      var n = parseRefNum(rec.num, prefix); // shared with §3 — same strict validation
      if (n !== null && n >= next) next = n + 1;
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
| Internal PK (`id`) | `uid()` for Suppliers, Line Items, Contacts — opaque, timestamp+random base36 string. **Buyers are the exception** (corrected in v5): `'BUY' + Date.now()`, a recognisable but non-`uid()` format — see §1. | Swapped to a real Postgres `UUID` (or `gen_random_uuid()`) in a single one-time remap script during migration — a safe, standard "surrogate key swap" regardless of the pre-migration format, since internal IDs are never user-facing in either case. Buyers' timestamp-based IDs remap exactly the same way `uid()` strings do. |
| Business key (`num`) | Introduced by this spec — human-facing, assignment-ordered, display-only | Becomes a `UNIQUE NOT NULL` indexed column on each corresponding Postgres table. Already populated for every record by the time migration happens — and the migration itself is the natural point that **permanently closes DATA-GAP-001**, since Supabase becomes the single shared source of truth server-side, making the current per-device divergence moot as a side effect of the cutover rather than something a v2.9.x patch needs to fix beforehand. |

**Why this matters:** without this spec, the v3.0.0 migration would need to *invent* a human-facing identifier scheme from scratch, under cutover pressure. This spec removes that problem years in advance, and correctly identifies the migration — not a local-only patch, and not the fragile sync mechanism — as the actual, permanent resolution point for cross-device consistency.

**Explicitly not done now (correctly, per FM-1):** no change to `uid()` or Buyers' timestamp-based ID generation, no UUID library, no Supabase client code, no server calls, no new `FIELD_MAPS` sync entries — not now, and per §4.1, not planned for later either.

## 6.1 GDPR Data-Minimisation Statement (new in v5 — spec-gate finding)

`num` itself carries no personal data — it is a sequential reference string (`SUP-0001`, `CON-0001`, etc.) with no PII content, derived from nothing but a counter. Its introduction on Contacts (a PII-bearing entity with its own `gdprBasis` logic — see `CON-GAP-002`/`CON-GAP-004` in `docs/known-gaps.md`) requires **no new lawful-basis analysis and no update to `gdprBasis` derivation logic**, since it adds no personal data field and is excluded from Sheets sync (§4.1) — it never leaves the browser via any existing or new data flow. This is stated explicitly here rather than left inferable, per spec-gate review.

## 7. Updated Entity Relationship Diagram

Delivered as a full rewrite of `docs/data-model.md`. See that file for the complete conceptual, logical, and physical model. **Note (v5):** `docs/data-model.md` line 42's Buyer PK description is corrected in the same commit as this spec revision, to match §1's correction above.

## 8. Test Plan

New tests in `tests/run.js`, following the existing test harness pattern:

- `parseRefNum()` unit tests (new in v5): valid `PREFIX-0001` → `1`; malformed suffix (`PREFIX-01x`, `PREFIX-12abc`) → `null`, not a truncated partial parse; wrong prefix → `null`; empty/missing `num` → `null`
- `nextRefNum()` unit tests: empty array → `PREFIX-0001`; existing records with gaps/out-of-order numbers → correct next value; prefix collision safety; deleted-record gap does not get reissued (AC-009); a malformed `num` present in the array does not affect the computed next value (new in v5)
- `backfillRefNums()`: assigns sequential numbers to records with no `num`; idempotent on second call; does not touch a record that already has `num` (valid or malformed — new in v5 assertion); `BUY-ADHOC` receives a `num` without its `id` changing
- **Mixed-`createdAt` comparator test (new in v5):** an array containing a mix of records with and without `createdAt` sorts records lacking it before (as older than) all records that have it, and records within each group retain correct relative order (chronological for the `createdAt` group, stable original-array-order for the no-`createdAt` group) — directly tests the corrected comparator, not just the "all-or-nothing" case v4's test plan implied
- **AC-010 test coverage, per entity group:**
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

**v5 (this version):** Resubmitted after spec-gate FAIL on v4. Five gaps addressed:
1. **§1 factual error corrected:** Buyer internal PK was wrongly stated as `uid()` — verified at `index.html:4611`/`4708` that `saveBuy()`/`quickAddBuyer()` actually generate `id: 'BUY' + Date.now()`. Corrected here, in `REQ-DATA-001-v5`, and in `docs/data-model.md`. Also corrected: Buyers and Contacts DO have a `createdAt` field (not absent as v4 implied for all four entities) — only Suppliers and Line Items lack it, confirmed by direct code inspection.
2. **Malformed `num` handling added (§3):** `parseRefNum()` replaces the previous bare `parseInt`, using a strict `PREFIX-NNNN` regex so a partially-numeric corrupted value (e.g. `SUP-01x`) is treated as invalid rather than silently truncate-parsed as `1`.
3. **Pre-existing duplicate `num` detection addressed (§3):** acknowledged as an accepted, tampering-only edge case consistent with this app's existing posture (no structural uniqueness enforcement anywhere), with a concrete, low-effort mitigation recommended — extend the existing `initApp()` data-integrity check rather than build new infrastructure.
4. **Mixed-`createdAt` comparator corrected (§4):** v4's comparator returned "no reorder" whenever *either* record lacked `createdAt`, incoherent for Buyers/Contacts which commonly have a mix of legacy and newer records. v5's comparator treats no-`createdAt` records as uniformly older, with correct behavior within each group.
5. **Explicit GDPR non-PII statement added (§6.1):** states plainly that `num` carries no personal data and requires no new lawful-basis analysis on Contacts, rather than leaving this inferable.

Also: `nextRefNum()` and the backfill's inline parsing logic are now unified via the shared `parseRefNum()` helper, removing the code-duplication risk flagged at spec-gate.

**v4:** Resubmitted after requirements-gate FAIL on v3. Two remaining gaps addressed:
1. AC-010 corrected — v3 claimed a uniform "wholesale replace" for all four `num`-bearing entities; verified false for Buyers and Contacts, which use a conditional preserve-if-key-absent pattern (matching the already-logged `CON-GAP-005`), not the unconditional replace used for Suppliers and Line Items. AC-010 and its test coverage (§8) now describe both behaviors separately.
2. §4.1/§9 corrected to state the REQ-RPT-002 mitigation as a stated dependency/precondition ("DATA-GAP-001 is open and unmitigated until RPT-002 ships"), not a present-tense assumption that mitigation already exists for an unbuilt sibling requirement

**v3:** Dropped the flawed SEC-GAP-011 analogy and cited REQ-RPT-002, and attempted to resolve AC-010 via `doImport()` — but over-generalized the wholesale-replace finding to all four entities when it only verifiably applies to two, and stated the RPT-002 mitigation in the present tense despite it being unbuilt. FAIL.

**v2:** Addressed v1's three gaps but the SEC-GAP-011 analogy was found invalid and AC-010 was still ambiguous. FAIL.

**v1:** Initial draft. FAIL — cross-device divergence, deletion/restore interaction, and unsubstantiated "sequential" claim all unaddressed.
