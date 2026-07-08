# REQ-RPT-002 — External Data-Quality Reporting Pipeline (Backup-Export-Driven)

**Status:** Draft — pending requirements-gate review
**Version:** 1
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Related:** SPEC-DATA-001-v2, SYNC-GAP-001, SEC-GAP-011, DATA-GAP-001

---

## 1. Business Context

Stackd Ops' live, bidirectional Google Sheets sync has a documented history of operational fragility: `SYNC-GAP-001` (a `Push All`/`Sync` operation can silently destroy another operator's records in Sheets if run out of order), `SEC-GAP-011` (pulling from Sheets unconditionally overwrites local edits with no conflict resolution), and — most tellingly — a security improvement in v2.9.38 (moving the sync token to an `Authorization` header) had to be hot-fixed and reverted in the very next change, because Google Apps Script's `doPost()` cannot read HTTP headers at all. This is not a one-off bug; it reflects a genuinely constrained integration surface (Apps Script's `doPost`) that has broken in production as recently as the version immediately preceding this requirement.

Separately, this session's work on `SPEC-DATA-001` (human-friendly reference numbers for Suppliers, Buyers, Contacts, and Line Items) surfaced a real design tension at requirements-gate review: if `num` values are assigned independently per device with no shared sequence, the same real-world Supplier could get a different `num` on two devices, with no mechanism in the live sync to ever reconcile that. The gate correctly rejected treating this as an "accepted risk" in the same sense as `SEC-GAP-011` — that gap is temporary (resolved deterministically on the next pull), whereas unsynced `num` divergence would be permanent, with no path back to consistency.

**The insight this requirement is built on:** the one part of the sync/data-integrity story that has never broken is the local JSON backup export (`expAll()`) — pure client-side generation, no external API call, no token, no Apps Script involvement, no race condition. Rather than deepen investment in the fragile live-sync mechanism to solve the `num` divergence problem, this requirement proposes building a **one-way, read-only reporting pipeline** on top of the already-reliable backup export: convert the exported JSON into a formatted spreadsheet (Excel, via the built-in Power Query "From JSON" connector — zero cost, no add-in) that uses standard spreadsheet functions (conditional formatting, `COUNTIFS`, data validation) to surface duplicates, near-duplicates, and cross-device inconsistencies for manual operator review.

This does not fix the live sync's underlying fragility, and does not attempt to. It sidesteps the entire class of live-sync bugs by never attempting a two-way merge — there is nothing to reconcile in real time, only a periodic, human-reviewed data-quality check against whatever the current backup says.

## 2. Stakeholders

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | Confidence that master data (Suppliers, Buyers, Contacts, Line Items) is not silently diverging or duplicating across devices, without depending on the fragile live sync to provide that assurance |
| SPEC-DATA-001 (`num` field) | Dependent feature | A downstream mechanism that makes an accepted local-only divergence risk *visible and reviewable*, rather than silent and unbounded |

## 3. Scope

### In scope (v1)
- A defined, documented process: export a backup JSON (existing `expAll()` function, unchanged), import it into Excel via Power Query's native JSON connector, and produce one sheet per entity (Suppliers, Buyers, Contacts, Line Items, Invoices, POs, Quotes, Shipments — the full existing backup contents)
- A set of standard, zero-cost Excel techniques applied to the resulting sheets:
  - `COUNTIFS`-based conditional formatting to highlight likely-duplicate records (e.g. same email on two Contact rows with different `num` values; same Supplier name with inconsistent casing/whitespace)
  - A documented, repeatable method for comparing exports **taken from two different devices** to surface `num` divergence for the same underlying record (directly addressing the risk accepted in SPEC-DATA-001's DATA-GAP-001)
  - Basic data validation flags (e.g. missing required fields visible in bulk, which is harder to spot one-record-at-a-time in the portal UI)
- A short operator runbook (a `docs/` markdown file, following the existing `dr-procedure.md` pattern) describing how to run this process and interpret its output

### Out of scope (v1 — explicitly deferred)
- Any change to the live Google Sheets sync mechanism (`syncEnt`, `pullAll`, `pushAll`, Apps Script `Code.gs`) — this requirement is deliberately independent of that system and does not attempt to fix its known gaps
- Automating the export/import/refresh cycle (e.g. a scheduled task, a cloud function, a watched-folder auto-refresh) — v1 is a manual, operator-triggered process; automation is a natural v2 candidate once the manual process has proven useful
- Any new field added to `FIELD_MAPS` or the Apps Script sync payload — this requirement is explicitly an *alternative* data-quality mechanism to extending sync, not a companion change to it
- Google Sheets as the reporting target (Excel Power Query is the v1 choice — see §4); a Sheets-based equivalent (via `IMPORTDATA`/Apps Script reading a Drive-hosted file) is a possible future alternative, not built here
- Writing data back into Stackd Ops from the spreadsheet — this is a read-only reporting/review tool; any correction identified must still be made manually in the portal, exactly as today

## 4. Tooling Decision — Why Excel Power Query

| Option | Cost | Fit |
|---|---|---|
| **Excel Power Query "Get Data → From File → From JSON"** (chosen) | £0 — built into any modern Excel install, no add-in | Native JSON-to-table flattening is a first-class Power Query feature; refresh is one click; conditional formatting and `COUNTIFS` are standard, well-understood Excel primitives requiring no new skill investment |
| Google Sheets `IMPORTDATA` / Apps Script reading a Drive file | £0 | Plausible alternative, but requires either a public/shared file URL (not appropriate given SEC-GAP-020's PII exposure history) or additional Apps Script code (the exact category of fragile integration this requirement is deliberately avoiding) |
| A dedicated BI tool (Power BI, etc.) | Free tier exists but adds a new tool/account to learn and maintain | Disproportionate for a sole-operator, periodic manual review use case |

Excel Power Query is chosen for v1: zero cost, no new account or tool, and it is the option that best matches the "avoid fragile integrations" premise of this requirement — importing a local file requires no network call, no token, no external service at all.

## 5. Acceptance Criteria

- AC-001: A documented process exists for producing a multi-sheet Excel workbook from a single `expAll()` JSON backup, with one sheet per entity
- AC-002: The workbook includes at least one conditional-formatting rule that visibly highlights likely-duplicate Suppliers, Buyers, or Contacts (by name/email similarity)
- AC-003: The runbook documents a concrete method for comparing two backups (e.g. one exported from each of two devices) to identify `num` values that have diverged for what appears to be the same underlying record
- AC-004: No code changes are made to `index.html`'s sync functions, `FIELD_MAPS`, or `apps-script/Code.gs` as part of this requirement
- AC-005: The runbook is written so a future session or the operator, without this conversation's context, can follow it unaided — consistent with the standard this repo already holds `docs/dr-procedure.md` to

## 6. Relationship to SPEC-DATA-001 / DATA-GAP-001

This requirement directly changes how DATA-GAP-001 (the accepted cross-device `num` divergence risk in SPEC-DATA-001-v2) should be framed. Rather than an unbounded, unreviewable risk, it becomes a **periodically-checkable one**: an operator using this reporting pipeline can, at will, compare backups from different devices and see exactly where `num` has diverged, and correct it manually in the portal if it matters for a given record. This does not eliminate the divergence risk, but it replaces "permanent and invisible" with "detectable on demand" — a materially different, and more defensible, risk posture. SPEC-DATA-001 should be revised to reference this requirement directly rather than relying on an analogy to SEC-GAP-011.
