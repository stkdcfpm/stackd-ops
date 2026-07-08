# REQ-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Status:** Draft — pending requirements-gate review
**Version:** 1
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** AI-GAP-006, AI-GAP-008, `docs/data-model.md`

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

### In scope (v1)
- A new `num` field on Suppliers, Buyers, Contacts, and Line Items — auto-generated, sequential, prefixed, immutable once assigned
- One-time idempotent backfill for existing records (demo data and any real records already in `localStorage`)
- Display of `num` in list tables and detail modals for all four entities
- Updated `docs/data-model.md` — full conceptual/logical/physical ERD covering every entity and FK relationship in the app, not just Contact↔Quote
- A documented, non-code-changing primary-key strategy note for the v3.0.0 Supabase migration (see SPEC-DATA-001 §6)

### Out of scope (v1 — explicitly deferred)
- Any change to the internal `id` field / `uid()` generation — this is the actual foreign-key linkage throughout the app and changing its format now is unnecessary architecture churn on the frozen v2.9.x stack (FM-1)
- Syncing the new `num` field to Google Sheets — adding it to an existing `FIELD_MAPS` entry is a judgement call best made separately, once the field has proven itself in local use (see SPEC-DATA-001 §4 for the FM-1 compliance reasoning)
- `get_suppliers` / `get_buyers` AI read-tools and resolving `create_po`'s `supId` requirement via name lookup — this is the natural *next* step once `num` exists, tracked as the direct follow-up to close AI-GAP-008, but is a separate, reviewable change to `AI_TOOLS` and `handleAIAction()`
- Any server-side / backend persistence change — v3.0.0 Supabase migration is already locked in as a separate, later initiative (FM-1); this requirement explicitly does not bring that forward

## 4. FM-1 Compliance

STACKD_CONTEXT.md's FM-1 hard rule freezes new localStorage-stack features pending the v3.0.0 Supabase migration, with three explicit exceptions. This requirement is scoped to fit exception #2 exactly:

> "New fields on existing entities — Adding fields to an existing `DB` entity... is permitted where the fields do not require a new sync mapping and the entity already exists in `K` and `saveAll()`."

All four affected entities (`DB.sup`, `DB.buy`, `DB.con`, `DB.li`) already exist in `K` and `saveAll()`. The new `num` field will not be added to any `FIELD_MAPS` sync mapping in v1, satisfying the exception's condition precisely.

## 5. Acceptance Criteria

- AC-001: Every Supplier, Buyer, Contact, and Line Item record — new and pre-existing — has a non-empty, unique `num` value after the backfill runs
- AC-002: `num` values follow the format `<PREFIX>-NNNN` (zero-padded 4 digits), consistent with the existing `QTE-0001` convention
- AC-003: `num` is assigned once, at creation (or backfill), and is never re-assigned or edited by the operator
- AC-004: The backfill is idempotent — running it multiple times (e.g. on every `initApp()`) never re-assigns or duplicates a `num` for a record that already has one
- AC-005: `num` is visible in each entity's list table and detail/edit modal
- AC-006: No existing foreign-key relationship (`supId`, `buyerId`, `sourceContactId`, `linkedPOId`, `linkedInvs`, etc.) is modified — all continue to reference the internal `id` (or `num`, where that is already the existing convention — see SPEC-DATA-001 §3 for the current mixed state) exactly as today
- AC-007: `docs/data-model.md` accurately reflects every entity, its PK, its business key (where one exists), and every FK relationship in the live codebase
- AC-008: All existing tests continue to pass; new tests cover backfill idempotency and uniqueness

## 6. Out-of-Scope Risks Acknowledged

- **BUY-ADHOC edge case:** the seeded Ad-Hoc buyer record already uses `BUY-ADHOC` as its internal `id` (not a `uid()` output) — a pre-existing special case predating this requirement. This requirement does not change `BUY-ADHOC`'s `id`; see SPEC-DATA-001 §5 for how its `num` is handled.
- **Mixed FK convention already exists:** Credit Notes link to Invoices via `linkedInvNum` (a business key) while Purchase Orders link to Suppliers via `supId` (an internal key), and Shipments link to Invoices via `linkedInvs` (an array of business keys). This requirement does not reconcile that inconsistency — it is noted for awareness in the updated ERD, and is a candidate for cleanup at the v3.0.0 migration, not before.
