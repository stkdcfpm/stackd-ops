# REQ-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Status:** Draft v4 — resubmitted after requirements-gate FAIL (v1, v2, v3)
**Version:** 4
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** AI-GAP-006, AI-GAP-008, `docs/data-model.md`, **REQ-RPT-002-v2** (sibling requirement — see §6; note version bump, see that document's own changelog)
**Supersedes:** REQ-DATA-001-v3 (requirements-gate FAIL — AC-010 factually incorrect for two of four entities; RPT-002 dependency stated in present tense as if already mitigating; no cadence for the mitigation process. See §7 Changelog.)

---

## 1. Business Context

Five entity types in Stackd Ops already have a human-friendly, sequential reference number that operators and documents use to identify a record: Invoices (`INV10001`), Credit Notes (`CN10001`), Quotes (`QTE-0001`), Purchase Orders (user-typed, e.g. `PO10029-1`), and Shipments (user-typed, e.g. `SHP-2026-014`).

Four entity types have **no such number**: Suppliers, Buyers, Contacts, and Line Items (product catalogue). These are only identifiable by an internal, opaque record ID (`uid()` — e.g. `mo98b4ito9o`) and a `name`/`desc` field. This was surfaced as a live, reproducible defect during AI assistant testing (2026-07-08): a user asking the AI to "create a supplier, then a PO for that supplier" in one conversation hit a dead end, because `create_po` requires a `supId` the AI has no way to resolve or look up.

This is also a standing UX gap independent of the AI: two Suppliers with similar names are only distinguishable today by opening each record.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | Reliably identify and reference Suppliers, Buyers, Contacts, and Line Items without opening each record |
| AI Assistant | Built-in Stackd Ops AI | A human-referenceable identifier it can resolve from conversation, closing AI-GAP-008 |
| Future migration | v3.0.0 Supabase cutover (STACKD_CONTEXT.md, FM-1) | A stable business key already populated and consistent *before* the migration, not invented under pressure during it |

## 3. Scope

### In scope (v1 build)
- A new `num` field on Suppliers, Buyers, Contacts, and Line Items — auto-generated, assignment-ordered, prefixed, immutable once assigned
- One-time idempotent backfill for existing records
- Display of `num` in list tables and detail modals for all four entities
- Updated `docs/data-model.md` — full conceptual/logical/physical ERD
- A documented, non-code-changing primary-key strategy note for the v3.0.0 Supabase migration (see SPEC-DATA-001 §6)

### Out of scope (v1 — explicitly deferred)
- Any change to the internal `id` field / `uid()` generation
- Syncing `num` to Google Sheets — permanently not pursued (see §6)
- `get_suppliers` / `get_buyers` AI read-tools and `create_po` supId resolution — natural next step, separate reviewable change
- Any server-side / backend persistence change

## 4. FM-1 Compliance

This requirement is scoped to fit FM-1's exception #2 ("new fields on existing entities... where the fields do not require a new sync mapping"). All four affected entities already exist in `K` and `saveAll()`. `num` will not be added to any `FIELD_MAPS` sync mapping, permanently, per §6.

## 5. Acceptance Criteria

- AC-001: Every Supplier, Buyer, Contact, and Line Item record has a non-empty `num` value after the backfill runs, **unique per device** (not global uniqueness across devices for the same real-world entity — see §6)
- AC-002: `num` values follow `<PREFIX>-NNNN` (zero-padded 4 digits), matching the `QTE-0001` convention. "Sequential" means assignment order, not verified creation order (most affected entities have no `createdAt`)
- AC-003: `num` is assigned once, never re-assigned or operator-edited
- AC-004: The backfill is idempotent
- AC-005: `num` is visible in each entity's list table and detail/edit modal
- AC-006: No existing foreign-key relationship is modified — all continue to reference `id` (or `num`, where already the convention) exactly as today
- AC-007: `docs/data-model.md` accurately reflects every entity, PK, business key, and FK relationship
- AC-008: All existing tests continue to pass; new tests cover backfill idempotency and uniqueness
- AC-009: `num` values are never reused after a record is deleted
- **AC-010 (corrected in v4 — was factually wrong in v3 for two of four entities):** `doImport()`'s restore behavior must be described **per-entity**, because it is not uniform:
  - **Suppliers and Line Items** (`sup`, `li`): confirmed at `index.html:7540-7557` — these two are in the `entities` array processed by an unconditional `DB[k] = Array.isArray(data[k]) ? data[k] : []`. A restore always wholesale-replaces these two arrays, whether or not the imported file contains them (missing key → replaced with `[]`, i.e. emptied, not preserved).
  - **Buyers and Contacts** (`buy`, `con`): confirmed at `index.html:7558-7560` and `7570` — these are **not** in the `entities` array; each has its own conditional guard (`if (data.con !== undefined) {...}`, `if (data.buy && Array.isArray(data.buy)) {...}`). If the imported backup **lacks** a `buy` or `con` key (e.g. an old, pre-Buyers or pre-Contacts backup), the current **live** array is silently preserved, not replaced or emptied. This is the exact behavior already documented for Contacts under `CON-GAP-005`; Buyers exhibit the identical pattern, though no existing gap ID currently names it for Buyers specifically.
  - **Consequence for `num` backfill:** for Suppliers/Line Items, a restore followed by `backfillRefNums()` assigns `num` strictly in the imported file's array order (no ambiguity). For Buyers/Contacts, if the restored file lacks that key, the *existing local* records (with their existing `num` values, if already assigned) are untouched — the backfill has nothing new to assign `num` to. If the restored file *does* include `buy`/`con`, those records replace the local array entirely and are backfilled in the imported order, same as Suppliers/Line Items. There is no scenario under either behavior where restore causes divergence to compound beyond what a single restore event already produces — but the two entity groups reach that outcome via different code paths, and this distinction must be reflected in test coverage (SPEC-DATA-001 §8).

## 6. Cross-Device Consistency

Suppliers, Line Items, and Contacts already sync to Google Sheets. `num` is **not** added to that sync mapping — permanently, not "for v1" — because this session's investigation found the live Sheets sync mechanism has a documented history of operational failure: `SYNC-GAP-001` (destructive clear-and-rewrite), `SEC-GAP-011` (no conflict resolution on pull), and a v2.9.38 security fix that had to be hot-fixed and reverted because Google Apps Script's `doPost()` cannot read HTTP headers at all (verified against `docs/known-gaps.md`'s own SEC-GAP-007 entry). Extending this mechanism to also carry `num` would add a new failure surface to an already-fragile system.

**Consequence, stated plainly:** `num` is assigned per-device, from local array order, with **no reconciliation mechanism**. Unlike SEC-GAP-011 (where Sheets deterministically "wins" on the next pull), there is no equivalent event that will ever bring two devices' `num` assignments back into agreement for the same real-world record. This is permanent, not temporary.

**Mitigation status — corrected in v4 to state this as a dependency, not an assumption:** **REQ-RPT-002** (a sibling requirement, currently Draft, not yet gate-passed or built) proposes a detection process for this exact divergence — comparing `num` assignments across per-device backup exports via an Excel reporting workbook. **This requirement does not claim that mitigation is currently in place.** DATA-GAP-001 (§7) must be logged as **open, with no mitigation available**, until REQ-RPT-002 has independently passed requirements-gate and spec-gate, and shipped. Only at that point does DATA-GAP-001's status change to "detectable via documented process" — this is a stated precondition, not a present-tense claim.

**Recommended cadence (new in v4 — a gate finding: a mitigation with no trigger doesn't change the risk profile unless exercised):** once REQ-RPT-002 ships, the operator should run its cross-device comparison process (a) whenever switching primary devices for portal use, and (b) at minimum monthly if working across more than one device in the same period. This is a recommendation, not an enforced or automated trigger — there is no code mechanism in this local-only app that could compel it.

## 7. New Known Gap

**DATA-GAP-001** (to be logged in `docs/known-gaps.md` alongside this feature's build): `num` values for Suppliers, Line Items, and Contacts may diverge permanently across devices, with no reconciliation mechanism, because `num` deliberately does not sync (§6). **Status at time of this feature's build: open, unmitigated**, pending REQ-RPT-002 shipping. Do not describe this gap as "mitigated" in any changelog or version-history entry until REQ-RPT-002 has actually shipped.

## 8. Changelog

**v4 (this version):** Resubmitted after requirements-gate FAIL on v3. Two remaining gaps addressed:
1. AC-010 corrected — v3 claimed `doImport()` performs a uniform "wholesale replace" for all four `num`-bearing entities. This was verified false for Buyers and Contacts, which use a conditional preserve-if-key-absent pattern (matching the already-logged CON-GAP-005), not the unconditional replace used for Suppliers and Line Items. AC-010 now describes both behaviors separately and correctly.
2. §6/§7 corrected to state the REQ-RPT-002 dependency as a precondition ("DATA-GAP-001 is open and unmitigated until RPT-002 ships"), not a present-tense assumption that mitigation already exists for an unbuilt sibling requirement
3. Added a recommended (non-enforced) review cadence for the mitigation process, since a mitigation with no trigger does not meaningfully change an unbounded risk

**v3:** Dropped the flawed SEC-GAP-011 analogy and cited REQ-RPT-002, and attempted to resolve AC-010 via `doImport()` — but over-generalized the wholesale-replace finding to all four entities when it only verifiably applies to two, and stated the RPT-002 mitigation in the present tense despite it being unbuilt. FAIL.

**v2:** Addressed v1's three gaps but the SEC-GAP-011 analogy was invalid and AC-010 was still ambiguous. FAIL.

**v1:** Initial draft — three gaps unaddressed. FAIL.
