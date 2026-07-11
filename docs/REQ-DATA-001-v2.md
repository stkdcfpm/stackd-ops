# REQ-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Status:** Draft v2 — resubmitted after requirements-gate FAIL (v1)
**Version:** 2
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** AI-GAP-006, AI-GAP-008, `docs/data-model.md`
**Supersedes:** REQ-DATA-001-v1 (requirements-gate FAIL — 3 gaps, see §7 Changelog)

---

## 1. Business Context

Five entity types in Stackd Ops already have a human-friendly, sequential reference number that operators and documents use to identify a record: Invoices (`INV10001`), Credit Notes (`CN10001`), Quotes (`QTE-0001`), Purchase Orders (user-typed, e.g. `PO10029-1`), and Shipments (user-typed, e.g. `SHP-2026-014`).

Four entity types have **no such number**: Suppliers, Buyers, Contacts, and Line Items (product catalogue). These are only identifiable by an internal, opaque record ID (`uid()` — e.g. `mo98b4ito9o`) and a `name`/`desc` field. This was surfaced as a live, reproducible defect during AI assistant testing (2026-07-08): a user asking the AI to "create a supplier, then a PO for that supplier" in one conversation hit a dead end, because `create_po` requires a `supId` the AI has no way to resolve or look up — there is nothing a human or the AI can type or reference that reliably identifies a not-yet-saved (or even already-saved) Supplier record, short of an internal ID string no operator would know to find.

This is also a standing UX gap independent of the AI: two Suppliers with similar names are only distinguishable today by opening each record — there is no printed code to tell them apart at a glance in a list, on a PDF, or in conversation with a colleague.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | Reliably identify and reference Suppliers, Buyers, Contacts, and Line Items without opening each record |
| AI Assistant | Built-in Stackd Ops AI | A human-referenceable identifier it can resolve from conversation, closing AI-GAP-008 |
| Future migration | v3.0.0 Supabase cutover (STACKD_CONTEXT.md, FM-1) | A stable business key already populated and consistent *before* the migration, not invented under pressure during it |

## 3. Scope

### In scope (v1 build)
- A new `num` field on Suppliers, Buyers, Contacts, and Line Items — auto-generated, assignment-ordered, prefixed, immutable once assigned
- One-time idempotent backfill for existing records (demo data and any real records already in `localStorage`)
- Display of `num` in list tables and detail modals for all four entities
- Updated `docs/data-model.md` — full conceptual/logical/physical ERD covering every entity and FK relationship in the app, not just Contact↔Quote
- A documented, non-code-changing primary-key strategy note for the v3.0.0 Supabase migration (see SPEC-DATA-001 §6)

### Out of scope (v1 — explicitly deferred)
- Any change to the internal `id` field / `uid()` generation — this is the actual foreign-key linkage throughout the app and changing its format now is unnecessary architecture churn on the frozen v2.9.x stack (FM-1)
- Syncing the new `num` field to Google Sheets — deferred to a follow-up version once cross-device consistency (§6, AC-009) has been validated in local use; see §6 for the accepted interim risk this creates
- `get_suppliers` / `get_buyers` AI read-tools and resolving `create_po`'s `supId` requirement via name lookup — this is the natural *next* step once `num` exists, tracked as the direct follow-up to close AI-GAP-008, but is a separate, reviewable change to `AI_TOOLS` and `handleAIAction()`
- Any server-side / backend persistence change — v3.0.0 Supabase migration is already locked in as a separate, later initiative (FM-1); this requirement explicitly does not bring that forward

## 4. FM-1 Compliance

STACKD_CONTEXT.md's FM-1 hard rule freezes new localStorage-stack features pending the v3.0.0 Supabase migration, with three explicit exceptions. This requirement is scoped to fit exception #2 exactly:

> "New fields on existing entities — Adding fields to an existing `DB` entity... is permitted where the fields do not require a new sync mapping and the entity already exists in `K` and `saveAll()`."

All four affected entities (`DB.sup`, `DB.buy`, `DB.con`, `DB.li`) already exist in `K` and `saveAll()`. The new `num` field will not be added to any `FIELD_MAPS` sync mapping in v1, satisfying the exception's condition precisely.

**Verified against live code (requirements-gate v1 review):** `FIELD_MAPS` has no `num` key for `sup`/`li`/`co`, and `buy` has no `FIELD_MAPS` entry or `synEnts` membership at all (consistent with BUY-GAP-001 — Buyers do not sync, period). This confirms the exception genuinely applies, not merely as asserted.

## 5. Acceptance Criteria

- AC-001: Every Supplier, Buyer, Contact, and Line Item record — new and pre-existing — has a non-empty `num` value after the backfill runs, **unique per device** (see §6 for the explicit multi-device caveat — this is not a claim of global uniqueness for a given real-world entity across devices)
- AC-002: `num` values follow the format `<PREFIX>-NNNN` (zero-padded 4 digits), consistent with the existing `QTE-0001` convention. "Sequential" means **assignment order** — the order in which the backfill or creation logic encountered the record — not verified true creation order, since Suppliers, Buyers, and Line Items have no `createdAt` field to confirm against (Contacts do)
- AC-003: `num` is assigned once, at creation (or backfill), and is never re-assigned or edited by the operator
- AC-004: The backfill is idempotent — running it multiple times (e.g. on every `initApp()`) never re-assigns or duplicates a `num` for a record that already has one
- AC-005: `num` is visible in each entity's list table and detail/edit modal
- AC-006: No existing foreign-key relationship (`supId`, `buyerId`, `sourceContactId`, `linkedPOId`, `linkedInvs`, etc.) is modified — all continue to reference the internal `id` (or `num`, where that is already the existing convention — see SPEC-DATA-001 §3 for the current mixed state) exactly as today
- AC-007: `docs/data-model.md` accurately reflects every entity, its PK, its business key (where one exists), and every FK relationship in the live codebase
- AC-008: All existing tests continue to pass; new tests cover backfill idempotency and uniqueness
- **AC-009 (new in v2):** `num` values are never reused or reassigned after a record is deleted — the assignment sequence only advances forward, exactly matching how Invoice numbers are never recycled today
- **AC-010 (new in v2):** Restoring a pre-`num` backup (via `doImport`) on a device where `num` values have already been assigned triggers the same idempotent backfill on next load, assigning fresh `num` values to the restored records in their restored array order. This is explicitly **not** guaranteed to produce the same `num` values as any other device or any prior backup for what is conceptually the same real-world record — see §6.

## 6. Cross-Device Consistency — Accepted Risk (new in v2)

Suppliers, Line Items, and Contacts already sync to Google Sheets (`FIELD_MAPS`, confirmed in live code). Because `num` is explicitly **not** added to that sync mapping in this version (§3, §4), the following limitation is accepted rather than solved:

**`num` is assigned per-device, from local array order, with no shared sequence.** If the same real-world Supplier record exists on two devices (via Sheets sync), each device's backfill assigns `num` independently — there is no guarantee both devices assign the same `num` to that record. This is directly analogous to, and compounds with, the existing SEC-GAP-011 (`pullAll()` has no timestamp-based conflict resolution) and CON-GAP-005 (backup/restore inconsistency) gaps already accepted in this codebase at the current 1–3-operator scale.

**Why this is accepted rather than blocking v1:** Buyers do not sync at all (BUY-GAP-001), so this risk does not apply to them. For the three entities that do sync, `num` is a **display/reference convenience**, not the actual foreign-key linkage (`id` remains that, untouched, §3) — so a `num` mismatch across devices cannot cause data corruption or broken relationships, only potential confusion if an operator compares `num` values seen on two different devices for what they believe is the same record. At current operational scale (sole operator, 1–3 devices, low sync frequency), this is judged acceptable, matching the precedent already set by SEC-GAP-011's own acceptance decision.

**Decision:** Logged as a new known-gap (DATA-GAP-001, to be raised alongside this feature's build) rather than solved in v1. Resolution path, if pursued later: add `num` to the relevant `FIELD_MAPS` entries so Sheets becomes the shared source of truth for sequence numbers — deferred exactly because that is a **new sync mapping change**, a materially different (and reviewable) risk category than the purely local, additive change this requirement is scoped to.

## 7. Changelog

**v2 (this version):** Resubmitted after requirements-gate FAIL on v1. Three gaps addressed:
1. Added §6 — explicit cross-device `num` consistency risk, previously unaddressed (AC-001 updated to clarify "unique per device," not global uniqueness)
2. Added AC-009 (no reuse after delete) and AC-010 (restore/import interaction) — previously unaddressed
3. Softened AC-002 — "sequential" now explicitly means assignment order, not verified creation order, since most affected entities lack `createdAt`

**v1:** Initial draft — requirements-gate FAIL (see above).
