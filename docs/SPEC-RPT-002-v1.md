# SPEC-RPT-002 — External Data-Quality Reporting Pipeline (Backup-Export-Driven)

**Derived from:** REQ-RPT-002 v2 (requirements-gate PASS)
**Status:** Draft v1 — pending spec-gate review
**Date:** 2026-07-08
**Author:** FPM International / Claude Code
**Depends on:** REQ-DATA-001-v4 / SPEC-DATA-001-v4 for AC-003 only (cross-device `num` comparison) — AC-001, AC-002, AC-004, AC-005, AC-006 are independently buildable today

---

## 1. Overview

This spec describes a **manual, operator-run process** — not new application code — for converting a Stackd Ops JSON backup into an Excel workbook that surfaces exact-duplicate records and (once `num` exists, per REQ-DATA-001) cross-device identifier divergence. No changes are made to `index.html`, `apps-script/Code.gs`, or any sync mechanism. The only artifact this spec produces is a **runbook** (a new `docs/` markdown file) and, optionally, a **reusable Power Query template file** (`.xlsx` with saved queries, containing no live data itself) that the operator opens and points at a fresh backup each time.

## 2. Source Data

The existing `expAll()` function (unchanged) produces a JSON file via Settings → Data → Export All, matching the structure already documented in `docs/dr-procedure.md`. Relevant top-level keys for this pipeline:

```json
{
  "sup": [ ... ],   // Suppliers
  "li":  [ ... ],   // Line Items
  "buy": [ ... ],   // Buyers
  "con": [ ... ],   // Contacts
  "inv": [ ... ],   // Invoices (includes Credit Notes, type-discriminated)
  "po":  [ ... ],   // Purchase Orders
  "qt":  [ ... ],   // Quotes
  "sh":  [ ... ]    // Shipments
}
```

No new export function is needed — this spec consumes the backup exactly as `dr-procedure.md` already describes it being produced.

## 3. Power Query Import Process (AC-001)

Documented as operator steps, since this is a manual process, not code:

1. In Excel, **Data → Get Data → From File → From JSON**
2. Select the backup file (e.g. `Stackd-Backup-2026-07-08.json`)
3. Power Query's editor opens showing the top-level JSON object as a single record. Click **Into Table**, then **Expand** to surface `sup`, `li`, `buy`, `con`, `inv`, `po`, `qt`, `sh` as columns, each containing a nested list
4. For each entity of interest (v1 scope: `sup`, `li`, `buy`, `con` — the four entities this pipeline is built to check), right-click the column → **To Table** → **Expand** the resulting record column to flatten every field (`id`, `num` once it exists, `name`, `email`, etc.) into its own column
5. Rename each resulting query to match the entity (`Suppliers`, `LineItems`, `Buyers`, `Contacts`) and **Close & Load** each as its own worksheet

This is a one-time setup per workbook. Once built, **Data → Refresh All** re-runs the same steps against whichever backup file is currently selected as the source — this is the "one click" refresh referenced in REQ-RPT-002 §4.

**Saved as a template:** the operator can save the workbook (with its Power Query steps but the *data connection cleared*) as a reusable `.xlsx` template — opening it and pointing "Refresh" at a new backup file re-populates all sheets without repeating steps 1-5 each time.

## 4. Exact-Duplicate Detection (AC-002)

For each entity sheet, add a helper column with a `COUNTIFS` formula against the defined match key, then a conditional formatting rule that highlights any row where the count exceeds 1.

**Match key per entity** (per REQ-RPT-002-v2 AC-002):

| Entity | Match key | Formula (helper column, e.g. column Z) |
|---|---|---|
| Suppliers | `email` if present, else `name` | `=IF(D2<>"", COUNTIF($D$2:$D$1000, D2), COUNTIF($B$2:$B$1000, B2))` *(column letters illustrative — adjust to actual sheet layout)* |
| Contacts | `email` (always present per validation rules) | `=COUNTIF($C$2:$C$1000, C2)` |
| Buyers | `email` if present, else `name` | Same pattern as Suppliers |
| Line Items | `name`/`desc` (no email field exists on this entity) | `=COUNTIF($B$2:$B$1000, B2)` |

Conditional formatting rule: **Home → Conditional Formatting → New Rule → Use a formula** — `=Z2>1` (referencing the helper column), fill highlight colour applied to the whole row via "Apply to" range.

**What this catches:** two Contact rows with the exact same email string; two Suppliers with the exact same name string. **What this does not catch** (explicitly out of scope per REQ-RPT-002 §3): "Shandong Jinbao" vs "Shandong Jinbao Ltd" — spelling/formatting variants require either a paid fuzzy-match add-in or manual visual review (sort the sheet alphabetically by name and scan), which the runbook (§6) should mention as a supplementary manual step, not an automated one.

## 5. Cross-Device `num` Comparison (AC-003 — inert until REQ-DATA-001 ships)

**This section describes a process that cannot be exercised until `num` exists on Suppliers, Buyers, Contacts, and Line Items records (REQ-DATA-001).** It is specified now so the runbook is complete once that dependency ships, not left to be written later under time pressure.

Once `num` exists:

1. Export a backup from **Device A**, import into the workbook (§3) as `Suppliers_A`, `Contacts_A`, etc.
2. Export a backup from **Device B**, import as a second set of sheets (`Suppliers_B`, `Contacts_B`, etc.) — Power Query supports multiple named queries against different source files in the same workbook
3. Add a comparison sheet with a formula joining the two sets on the match key (§4 — email or name) and displaying both `num` values side by side:
   `=XLOOKUP([@Email], Suppliers_B[Email], Suppliers_B[num], "not found on device B")`
4. A conditional formatting rule highlights any row where `Suppliers_A[num] <> Suppliers_B[num]` for a matched record — this is the divergence DATA-GAP-001 describes, now made visible

**This is a manual, on-demand check** — per REQ-DATA-001-v4 §6's recommended (not enforced) cadence: when switching primary devices, or at minimum monthly if working across more than one device regularly.

## 6. Runbook (AC-006)

A new file, `docs/reporting-pipeline-runbook.md`, following the structure and tone of `docs/dr-procedure.md`:

```
# Data-Quality Reporting Pipeline — Runbook

**Applies to:** v2.9.x+ (requires REQ-DATA-001's `num` field for §3 cross-device
comparison; duplicate detection in §2 works independent of that)

## What this is
[Same framing as REQ-RPT-002 §1 — why this exists instead of relying on live sync]

## ⚠️ Handling the generated workbook
[AC-004 policy, stated as prominently as dr-procedure.md's existing backup-storage
warning — never commit, private storage only, delete/overwrite after each session]

## 1. One-time setup — building the workbook
[§3 steps above]

## 2. Running an exact-duplicate check
[§4 steps above]

## 3. Running a cross-device num comparison (requires num field)
[§5 steps above]

## 4. What to do when you find a duplicate or divergence
[Manual correction happens in the Stackd Ops portal itself — this pipeline is
read-only and never writes back]
```

## 7. Storage, Retention, Deletion Policy (AC-004)

Matching `docs/dr-procedure.md`'s existing backup-handling warning, stated explicitly in the new runbook (§6):

- The generated `.xlsx` workbook (once populated with live data via Refresh) **must never be committed to any git repository** — same rationale as `SEC-GAP-020`
- Store only in a private location: local disk, or a personal cloud folder **without link-shareable/public access** (not a publicly-synced or link-anyone-can-view folder)
- After each review session, either delete the populated workbook or clear its data connections back to the empty template state before storing it long-term — do not retain a standing, indefinitely-growing copy of exported commercial and personal data
- The reusable **template** (Power Query steps only, no live data — see §3) is safe to keep long-term, since it contains no data until "Refresh" is run against a real backup

## 8. Test Plan

This spec produces no `index.html` code changes, so there is nothing for `tests/run.js` to cover. Verification is manual:

- Follow §3-§5 against a real (or demo-mode) backup export and confirm the workbook produces the expected sheets and highlighting
- Confirm the runbook (§6) is followable by someone without this conversation's context — the same bar `dr-procedure.md` is already held to

## 9. Rollout

1. Write `docs/reporting-pipeline-runbook.md` per §6
2. Build and save the reusable Power Query template (no code repo changes — this artifact itself should **not** be committed if it ever contains cached preview data; keep the template's data source cleared before saving)
3. Cross-reference this spec from `docs/known-gaps.md`'s DATA-GAP-001 entry once REQ-DATA-001 ships, updating its status per REQ-DATA-001-v4 §7
4. No PR needed for the runbook alone beyond normal doc-change review, since no `index.html`/test changes are involved
