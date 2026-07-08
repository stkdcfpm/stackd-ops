# REQ-RPT-002 — External Data-Quality Reporting Pipeline (Backup-Export-Driven)

**Status:** Draft v2 — resubmitted after requirements-gate FAIL (v1)
**Version:** 2
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** REQ-DATA-001-v4 (this requirement's AC-003 is inert until DATA-001 ships — see §7), SYNC-GAP-001, SEC-GAP-011, SEC-GAP-020, DATA-GAP-001
**Supersedes:** REQ-RPT-002-v1 (requirements-gate FAIL — unmeasurable ACs, undisclosed circular dependency, no storage/retention policy for exported data. See §8 Changelog.)

---

## 1. Business Context

Stackd Ops' live, bidirectional Google Sheets sync has a documented history of operational fragility: `SYNC-GAP-001` (a `Push All`/`Sync` operation can silently destroy another operator's records in Sheets if run out of order), `SEC-GAP-011` (pulling from Sheets unconditionally overwrites local edits with no conflict resolution), and — most tellingly — a security improvement in v2.9.38 (moving the sync token to an `Authorization` header) had to be hot-fixed and reverted in the very next change, because Google Apps Script's `doPost()` cannot read HTTP headers at all (verified: `docs/known-gaps.md` SEC-GAP-007).

**The insight this requirement is built on:** the one part of the sync/data-integrity story that has never broken is the local JSON backup export (`expAll()`) — pure client-side generation, no external API call, no token, no Apps Script involvement. Rather than deepen investment in the fragile live-sync mechanism, this requirement proposes a **one-way, read-only reporting pipeline** on top of the already-reliable backup export: convert the exported JSON into a formatted spreadsheet (Excel Power Query, zero cost) that uses standard spreadsheet functions to surface data-quality issues for manual review.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | Confidence that master data is not silently diverging or duplicating across devices, without depending on the fragile live sync |
| REQ-DATA-001 (`num` field) | Upstream dependency | This requirement's AC-003 (cross-device `num` comparison) requires `num` to exist — see §7 for the explicit dependency statement |

## 3. Scope

### In scope (v1 build)
- A defined, documented process: export a backup JSON (`expAll()`, unchanged), import via Excel Power Query's native JSON connector, one sheet per entity
- **Exact-duplicate detection only** (see §5 AC-002 — "near-duplicate"/fuzzy matching is explicitly out of scope, corrected from v1): `COUNTIFS`-based conditional formatting highlighting rows where a chosen match key (email, for entities that have one; exact name string otherwise) appears more than once
- A documented method (§5 AC-003) for comparing two backups (one per device) to identify divergent `num` values for records sharing the same match key — **this AC is inert until REQ-DATA-001 ships `num`** (§7)
- A storage, retention, and deletion policy for the generated workbook (§6 — new in v2, addressing a requirements-gate finding)
- A short operator runbook (`docs/` markdown, following the `dr-procedure.md` pattern)

### Out of scope (v1 — explicitly deferred)
- Any change to the live Google Sheets sync mechanism
- Automating the export/import/refresh cycle — v1 is manual, operator-triggered
- Any new field added to `FIELD_MAPS` or Apps Script
- Google Sheets as the reporting target (Excel Power Query is the v1 choice)
- Writing data back into Stackd Ops from the spreadsheet
- **Near-duplicate / fuzzy matching** (e.g. catching "Shandong Jinbao" vs "Shandong Jinbao Ltd" as likely-the-same) — this requires either a paid Excel add-in (`FUZZY.VLOOKUP` is not built-in) or a manual, human-judgment visual review sorted alphabetically. v1 delivers exact-match detection only, which is a smaller but genuinely zero-cost, fully-automatable claim. Fuzzy matching is a candidate for a future version if the exact-match pass proves insufficient in practice.

## 4. Tooling Decision — Why Excel Power Query

| Option | Cost | Fit |
|---|---|---|
| **Excel Power Query "Get Data → From File → From JSON"** (chosen) | £0 | Native JSON-to-table flattening; refresh is one click; `COUNTIFS`/conditional formatting are standard Excel primitives |
| Google Sheets `IMPORTDATA` / Apps Script | £0 | Requires either a public/shared file URL (inappropriate given SEC-GAP-020) or more Apps Script code — the exact fragile-integration category this requirement avoids |
| Dedicated BI tool | Free tier exists, but a new tool/account to maintain | Disproportionate for a sole-operator, periodic manual review |

## 5. Acceptance Criteria

- AC-001: A documented process exists for producing a multi-sheet Excel workbook from a single `expAll()` JSON backup, with one sheet per entity
- **AC-002 (corrected in v2 — was unmeasurable):** The workbook includes a `COUNTIFS`-based conditional-formatting rule that highlights rows sharing an **exact-match** value on a defined key: `email` for Contacts and Suppliers (where present); exact `name` string for Suppliers, Buyers, and Line Items where no email exists. This detects true duplicates only — spelling/formatting variants are not detected by this AC (see §3 out-of-scope).
- **AC-003 (corrected in v2 — dependency now explicit, was previously assumed):** The runbook documents a method for comparing two backups (one per device) to identify `num` values that differ for records sharing the same AC-002 match key. **This AC cannot be exercised or tested until REQ-DATA-001 ships the `num` field** — until then, this AC is written and reviewable, but not executable, and must not be marked complete in any version-history or changelog entry.
- **AC-004 (new in v2):** The generated Excel workbook must never be committed to any git repository (consistent with `CLAUDE.md`'s existing "never commit live data exports" policy and the `SEC-GAP-020` incident), must be stored only in a private, non-publicly-synced location (local disk, or a private/encrypted cloud folder — not a folder with public or link-anyone-can-view sharing), and should be deleted or overwritten after each review session rather than retained indefinitely as a standing copy of exported commercial and personal data.
- AC-005: No code changes are made to `index.html`'s sync functions, `FIELD_MAPS`, or `apps-script/Code.gs`
- AC-006: The runbook is written so a future session or the operator, without this conversation's context, can follow it unaided

## 6. Data Sensitivity of the Exported Workbook (new in v2 — requirements-gate finding)

The full backup export includes Invoices, Purchase Orders, and **Quotes** alongside master data. Quotes carry the quote engine's commercially sensitive output — landed cost, duty percentage, markup, sell price (`cQte`/`cQteLine` results, per `docs/data-model.md` §2). Suppliers, Buyers, and Contacts carry personal data (names, emails, phone numbers). The generated Excel workbook is therefore a **new, standing copy of the same sensitivity class of data** that `SEC-GAP-020` already demonstrated real exposure risk for, in a different (but comparably careless) form.

**This is why AC-004 exists as a hard acceptance criterion, not a nice-to-have:** the workbook must be treated with the same handling discipline as any other export of this data — private storage only, never committed, not retained indefinitely. The runbook (AC-006) must state this explicitly to the operator, not merely rely on it being "obvious."

## 7. Explicit Dependency on REQ-DATA-001

**This requirement's AC-003 is inert until REQ-DATA-001 ships.** `num` is the field AC-003's comparison method is built around; it does not exist until REQ-DATA-001 is built. This requirement can and should still pass requirements-gate and spec-gate independently — AC-001, AC-002, AC-004, AC-005, and AC-006 do not depend on `num` at all, and deliver real value (exact-duplicate detection, safe export handling) on their own. AC-003 alone is gated on REQ-DATA-001's delivery, and this must be stated plainly in any status tracking, not silently assumed.

## 8. Changelog

**v2 (this version):** Resubmitted after requirements-gate FAIL on v1. Three gaps addressed:
1. AC-002 narrowed to exact-match detection only, dropping the previously unmeasurable "near-duplicate" claim (§3 out-of-scope now explicitly names fuzzy matching as deferred, since it requires a paid add-in or manual review, not a zero-cost automatable claim)
2. AC-003 and §7 now state explicitly that this requirement depends on REQ-DATA-001 shipping `num` first — previously this was silently assumed rather than stated
3. Added AC-004 and §6 — a storage/retention/deletion policy for the generated workbook, given it contains the same sensitivity class of data (PII, quote pricing/duty/markup) that `SEC-GAP-020` already showed real exposure risk for

**v1:** Initial draft. FAIL — AC-002/AC-003 not measurable, silent circular dependency on unbuilt REQ-DATA-001, no storage/retention policy for the exported workbook.
