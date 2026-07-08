# REQ-DATA-001 — Human-Friendly Reference Numbers for Master Data Entities

**Status:** Draft v3 — resubmitted after requirements-gate FAIL (v1, v2)
**Version:** 3
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** AI-GAP-006, AI-GAP-008, `docs/data-model.md`, **REQ-RPT-002-v1** (sibling requirement — see §6)
**Supersedes:** REQ-DATA-001-v2 (requirements-gate FAIL — flawed SEC-GAP-011 analogy, unresolved AC-010 ambiguity; see §7 Changelog)

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
- Syncing the new `num` field to Google Sheets — deliberately **not pursued at all**, in either this version or a future one, given the live sync mechanism's own documented fragility (see §6). The resolution path for cross-device consistency is REQ-RPT-002, not sync.
- `get_suppliers` / `get_buyers` AI read-tools and resolving `create_po`'s `supId` requirement via name lookup — this is the natural *next* step once `num` exists, tracked as the direct follow-up to close AI-GAP-008, but is a separate, reviewable change to `AI_TOOLS` and `handleAIAction()`
- Any server-side / backend persistence change — v3.0.0 Supabase migration is already locked in as a separate, later initiative (FM-1); this requirement explicitly does not bring that forward

## 4. FM-1 Compliance

STACKD_CONTEXT.md's FM-1 hard rule freezes new localStorage-stack features pending the v3.0.0 Supabase migration, with three explicit exceptions. This requirement is scoped to fit exception #2 exactly:

> "New fields on existing entities — Adding fields to an existing `DB` entity... is permitted where the fields do not require a new sync mapping and the entity already exists in `K` and `saveAll()`."

All four affected entities (`DB.sup`, `DB.buy`, `DB.con`, `DB.li`) already exist in `K` and `saveAll()`. The new `num` field will not be added to any `FIELD_MAPS` sync mapping — not in this version, and (per §3, revised in v3) not planned for any future version either, given §6's reasoning. This satisfies the exception's condition unambiguously, with no open question of "for now" versus "eventually."

**Verified against live code:** `FIELD_MAPS` has no `num` key for `sup`/`li`/`co`, and `buy` has no `FIELD_MAPS` entry or `synEnts` membership at all (consistent with BUY-GAP-001 — Buyers do not sync, period).

## 5. Acceptance Criteria

- AC-001: Every Supplier, Buyer, Contact, and Line Item record — new and pre-existing — has a non-empty `num` value after the backfill runs, **unique per device** (see §6 — this is not a claim of global uniqueness for a given real-world entity across devices, and is not intended to become one)
- AC-002: `num` values follow the format `<PREFIX>-NNNN` (zero-padded 4 digits), consistent with the existing `QTE-0001` convention. "Sequential" means **assignment order** — the order in which the backfill or creation logic encountered the record — not verified true creation order, since Suppliers, Buyers, and Line Items have no `createdAt` field to confirm against (Contacts do)
- AC-003: `num` is assigned once, at creation (or backfill), and is never re-assigned or edited by the operator
- AC-004: The backfill is idempotent — running it multiple times (e.g. on every `initApp()`) never re-assigns or duplicates a `num` for a record that already has one
- AC-005: `num` is visible in each entity's list table and detail/edit modal
- AC-006: No existing foreign-key relationship (`supId`, `buyerId`, `sourceContactId`, `linkedPOId`, `linkedInvs`, etc.) is modified — all continue to reference the internal `id` (or `num`, where that is already the existing convention — see SPEC-DATA-001 §3 for the current mixed state) exactly as today
- AC-007: `docs/data-model.md` accurately reflects every entity, its PK, its business key (where one exists), and every FK relationship in the live codebase
- AC-008: All existing tests continue to pass; new tests cover backfill idempotency and uniqueness
- AC-009: `num` values are never reused or reassigned after a record is deleted — the assignment sequence only advances forward, exactly matching how Invoice numbers are never recycled today
- **AC-010 (revised in v3 — factually grounded, was ambiguous in v2):** `doImport()` (confirmed at `index.html:7532-7576`) performs a **wholesale replace** of each entity array (`DB[k] = data[k]`), not a merge — the confirm dialog itself states "This will replace ALL current local data." Consequently, "restored array order" is a precisely defined quantity: it is exactly the array order present in the imported JSON file, with no interleaving against pre-existing local records to reason about. Restoring a pre-`num` backup therefore triggers the same idempotent backfill (AC-004) against the freshly-replaced arrays, assigning `num` values in that exact restored order. This is explicitly **not** guaranteed to reproduce `num` values seen before the restore, or on any other device — that is the same accepted characteristic described in §6, not a new or compounding one; repeated restores do not make divergence worse than a single restore already does, because each restore is an independent wholesale replace, not an accumulation.

## 6. Cross-Device Consistency (revised in v3 — corrected framing after requirements-gate FAIL on v2)

Suppliers, Line Items, and Contacts already sync to Google Sheets (`FIELD_MAPS`, confirmed in live code). `num` is **not** added to that sync mapping (§3, §4) — and, per this revision, this decision is now permanent rather than "for v1," for a specific reason: **the live sync mechanism itself is not reliable enough to extend.**

This session's investigation found that Stackd Ops' bidirectional Sheets sync has a documented history of operational failure: `SYNC-GAP-001` (destructive clear-and-rewrite), `SEC-GAP-011` (no conflict resolution on pull), and — most concretely — a v2.9.38 security fix moving the sync token to an `Authorization` header had to be hot-fixed and reverted in the next change, because Google Apps Script's `doPost()` cannot read HTTP headers at all. Extending this same mechanism to also carry `num` would add a new failure surface to an already-fragile system, in service of solving a problem (identifier consistency) that a working alternative already exists for.

**Consequence, stated plainly, without a flawed analogy to SEC-GAP-011 (as v2 incorrectly asserted):** `num` is assigned per-device, from local array order, with no shared sequence and **no reconciliation mechanism** — unlike SEC-GAP-011, where Sheets deterministically "wins" on the next pull, there is no equivalent "next pull" event that will ever bring two devices' `num` assignments back into agreement for the same real-world record. This is a permanent characteristic of this design, not a temporary one, and this document does not claim otherwise.

**Why this is still an acceptable design, correctly framed:** the mitigation is not "this rarely matters" or "it's like an existing accepted gap" — it is that **REQ-RPT-002** (a sibling requirement, drafted alongside this revision) provides a concrete, documented, on-demand method for detecting exactly this divergence: exporting a backup from each device and comparing `num` assignments for records with matching names/emails. This converts an invisible, unbounded risk into a periodically-checkable one. It does not eliminate the risk — it makes it something an operator can choose to check, with a defined process, rather than something silently accumulating with no way to even notice it.

**Decision:** Logged as **DATA-GAP-001** (to be raised alongside this feature's build), explicitly cross-referencing REQ-RPT-002 as its detection mechanism — not as a "solved" gap, but as one with a real, usable review process attached, which is a materially stronger position than the v2 framing.

## 7. Changelog

**v3 (this version):** Resubmitted after requirements-gate FAIL on v2. Two remaining gaps from that review addressed:
1. Dropped the flawed SEC-GAP-011 analogy in §6 (that gap is temporary/self-resolving; this one is permanent/unresolved by design) and replaced it with a direct reference to the new sibling requirement REQ-RPT-002, which provides an actual detection mechanism rather than an assertion that the risk resembles an already-accepted one
2. AC-010 rewritten with a factual, verified answer to the "restored array order" ambiguity — `doImport()` is confirmed (by reading `index.html:7532-7576`) to perform a wholesale array replace, not a merge, which fully resolves what "restored array order" means and confirms repeated restores do not compound divergence beyond what a single restore already produces
3. §3/§4/§6 revised to state that `num` will **never** be added to Sheets sync (not "not in v1") — this is now a permanent architectural position, justified by the sync mechanism's own documented fragility, not a deferral

**v2:** Addressed v1's three gaps (cross-device risk acknowledgment, AC-009/010 additions, softened AC-002 language) but the gate found the SEC-GAP-011 analogy invalid and AC-010 still ambiguous. FAIL.

**v1:** Initial draft — requirements-gate FAIL (cross-device divergence, deletion/restore interaction, and unsubstantiated "sequential" claim all unaddressed).
