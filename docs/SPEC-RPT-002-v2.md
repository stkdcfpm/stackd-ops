# SPEC-RPT-002 — External Data-Quality Reporting Pipeline (Backup-Export-Driven)

**Derived from:** REQ-RPT-002 v2 (requirements-gate PASS)
**Status:** Draft v2 — spec-gate FAIL on v1 (data-minimisation gap, formula scalability inconsistency, undocumented edge case, scope ambiguity, no test fixture); resubmitted with all six addressed
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Supersedes:** SPEC-RPT-002-v1 (spec-gate FAIL. See §10 Changelog.)
**Depends on:** REQ-DATA-001-v5 / SPEC-DATA-001-v5 for AC-003 only (cross-device `num` comparison) — AC-001, AC-002, AC-004, AC-005, AC-006 are independently buildable today

---

## 1. Overview

This spec describes a **manual, operator-run process** — not new application code — for converting a Stackd Ops JSON backup into an Excel workbook that surfaces exact-duplicate records and (once `num` exists, per REQ-DATA-001) cross-device identifier divergence. No changes are made to `index.html`, `apps-script/Code.gs`, or any sync mechanism. The only artifact this spec produces is a **runbook** (a new `docs/` markdown file) and, optionally, a **reusable Power Query template file** (`.xlsx` with saved queries, containing no live data itself) that the operator opens and points at a fresh backup each time.

## 2. Source Data

The existing `expAll()` function (unchanged) produces a JSON file via Settings → Data → Export All, matching the structure already documented in `docs/dr-procedure.md`. The full backup contains eight top-level keys (`sup`, `li`, `buy`, `con`, `inv`, `po`, `qt`, `sh`), but **this pipeline only ever needs four of them** — `sup`, `li`, `buy`, `con` — since those are the only entities in scope for duplicate detection (REQ-RPT-002-v2 §5 match-key table) or `num` comparison (§5 below). This is now made explicit at the query level (§3), not just at the flattening step, per spec-gate finding (v1 loaded all eight into the query without excluding the four not needed, including Quotes' commercially sensitive landed-cost/duty/markup data with no defined use for it).

## 3. Power Query Import Process (AC-001)

**Scope note (corrected in v2):** REQ-RPT-002-v2 AC-001 says "one sheet per entity" — this is scoped, consistent with REQ §3/§5, to the four entities this pipeline's duplicate-detection and `num`-comparison logic actually covers (`sup`, `li`, `buy`, `con`), not all eight backup keys. Invoices, POs, Quotes, and Shipments are deliberately **excluded from the query entirely** (not merely left unflattened) — see step 3 below.

Documented as operator steps, since this is a manual process, not code:

1. In Excel, **Data → Get Data → From File → From JSON**
2. Select the backup file (e.g. `Stackd-Backup-2026-07-08.json`)
3. Power Query's editor opens showing the top-level JSON object as a single record. Click **Into Table**, then **Expand** — but select **only** `sup`, `li`, `buy`, `con` in the expand dialog's column checklist. **Do not select** `inv`, `po`, `qt`, `sh` — this is a data-minimisation decision, not an oversight: Quotes in particular carry the quote engine's commercially sensitive output (landed cost, duty%, markup, sell price), and nothing in this pipeline's scope (§4, §5) requires any of the four excluded entities. Excluding them at this step means they never enter the Power Query data model at all, not merely "loaded but unused."
4. For each of the four entities selected, right-click the column → **To Table** → **Expand** the resulting record column to flatten every field (`id`, `num` once it exists, `name`, `email`, etc.) into its own column
5. Rename each resulting query to match the entity (`Suppliers`, `LineItems`, `Buyers`, `Contacts`) and **Close & Load** each as its own worksheet — **loading to a worksheet via Power Query always creates the data as a named Excel Table (ListObject)**, e.g. `Suppliers[#All]`, not a plain cell range. This is relied on in §4/§5 below for structured references (corrected in v2 — v1 mixed hardcoded `$2:$1000` ranges with structured references inconsistently).

This is a one-time setup per workbook. Once built, **Data → Refresh All** re-runs the same steps against whichever backup file is currently selected as the source — this is the "one click" refresh referenced in REQ-RPT-002 §4.

**Saved as a template:** the operator can save the workbook (with its Power Query steps but the *data connection cleared*) as a reusable `.xlsx` template — opening it and pointing "Refresh" at a new backup file re-populates all four sheets without repeating steps 1-5 each time.

## 4. Exact-Duplicate Detection (AC-002)

**Terminology correction (v2):** REQ-RPT-002-v2 AC-002 and this spec's v1 heading both said "COUNTIFS" — the formulas below are single-criterion `COUNTIF`, since only one match key is ever checked at a time per entity (email, or name as fallback — never both simultaneously for the same check). `COUNTIFS` (plural) is Excel's multi-criteria variant and is not needed here; this document now uses `COUNTIF` consistently to avoid a future reader hunting for a formula that isn't actually used.

For each entity sheet (each an Excel Table per §3 step 5), add a helper column with a `COUNTIF` formula against the defined match key, using **structured table references** (not hardcoded ranges — corrected in v2, see §3 step 5) so the formula auto-scales as the table grows or shrinks on refresh, with no row-count ceiling to maintain.

**Match key per entity** (per REQ-RPT-002-v2 AC-002):

| Entity | Match key | Formula (helper column, e.g. `[MatchCount]`) |
|---|---|---|
| Suppliers | `email` if present, else `name` | `=IF([@Email]<>"", COUNTIF(Suppliers[Email], [@Email]), COUNTIF(Suppliers[Name], [@Name]))` |
| Contacts | `email` (always present per validation rules) | `=COUNTIF(Contacts[Email], [@Email])` |
| Buyers | `email` if present, else `name` | Same pattern as Suppliers, referencing the `Buyers` table |
| Line Items | `desc` (this entity has no `name` field — confirmed against `docs/data-model.md`; no email field either) | `=COUNTIF(LineItems[Desc], [@Desc])` |

Conditional formatting rule: **Home → Conditional Formatting → New Rule → Use a formula** — `=[@MatchCount]>1`, fill highlight colour applied to the whole row via "Apply to" range set to the table.

**Asymmetric fallback-match edge case (new in v2 — spec-gate finding):** the Suppliers/Buyers fallback logic checks `email` **or** `name`, never both for the same row. Two records with the same `name` — one with `email` populated, one without — are evaluated against **different columns** (the one with an email is counted against the Email column; the one without is counted against the Name column). This means such a pair is **not guaranteed to be flagged as a match**, even though a human reviewer would likely consider them the same entity. This is a known limitation of the exact-match, single-key-per-row approach — not a bug in the formula, but a real gap in what it catches. The runbook (§6) must state this explicitly, and recommend a supplementary manual step: sort each sheet by `name` and visually scan for near-neighbours regardless of what the `[MatchCount]` column shows.

**What this catches:** two Contact rows with the exact same email string; two Suppliers with the exact same name string (when both rows use the same match key — see asymmetric caveat above). **What this does not catch** (explicitly out of scope per REQ-RPT-002 §3): "Shandong Jinbao" vs "Shandong Jinbao Ltd" — spelling/formatting variants require either a paid fuzzy-match add-in or manual visual review (sort the sheet alphabetically by name and scan), which the runbook (§6) should mention as a supplementary manual step, not an automated one.

## 5. Cross-Device `num` Comparison (AC-003 — inert until REQ-DATA-001 ships)

**This section describes a process that cannot be exercised until `num` exists on Suppliers, Buyers, Contacts, and Line Items records (REQ-DATA-001).** It is specified now so the runbook is complete once that dependency ships, not left to be written later under time pressure.

Once `num` exists:

1. Export a backup from **Device A**, import into the workbook (§3) as `Suppliers_A`, `Contacts_A`, etc.
2. Export a backup from **Device B**, import as a second set of sheets (`Suppliers_B`, `Contacts_B`, etc.) — Power Query supports multiple named queries against different source files in the same workbook
3. Add a comparison sheet with a formula joining the two sets on the match key (§4 — email or name) and displaying both `num` values side by side. **Requires Excel 365 or Excel 2021+** (`XLOOKUP` is not available in Excel 2019 or earlier — if only an older version is available, `INDEX`/`MATCH` is an equivalent, older-compatible alternative):
   `=XLOOKUP([@Email], Suppliers_B[Email], Suppliers_B[num], "not found on device B")`
4. A conditional formatting rule highlights any row where `Suppliers_A[num] <> Suppliers_B[num]` for a matched record — this is the divergence DATA-GAP-001 describes, now made visible

**This is a manual, on-demand check** — per REQ-DATA-001-v5 §6's recommended (not enforced) cadence: when switching primary devices, or at minimum monthly if working across more than one device regularly.

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

This spec produces no `index.html` code changes, so there is nothing for `tests/run.js` to cover. Verification is manual, against a **defined fixture** (new in v2 — spec-gate found "confirm expected highlighting" was not falsifiable without one):

**Test fixture — a small synthetic backup JSON** (not a real export, to avoid using live business data for a repeatable test artifact), containing, for each of the four in-scope entities:
- 1 record with no duplicate (baseline — must **not** be highlighted)
- 2 records sharing an identical match-key value (true exact duplicate — must be highlighted)
- 2 records with near-identical but non-identical names, e.g. `"Acme Ltd"` vs `"Acme Ltd."` (near-duplicate — must **not** be highlighted, confirming §4's stated "does not catch" boundary is accurate, not accidentally over- or under-inclusive)
- For Suppliers/Buyers only: 1 pair demonstrating the asymmetric fallback edge case (§4) — same `name`, one record with `email` populated and one without — documented as a **known false-negative**, not asserted as "must be highlighted"

**Verification steps:**
1. Import the fixture via §3, confirm exactly four sheets are created (`Suppliers`, `LineItems`, `Buyers`, `Contacts`) and that `Invoices`/`POs`/`Quotes`/`Shipments` do **not** appear anywhere in the workbook's queries or sheets (confirms AC-001/§3's data-minimisation scope)
2. Confirm the `[MatchCount]` column and conditional formatting correctly highlight only the true-duplicate rows in each sheet, and correctly leave the baseline and near-duplicate rows unhighlighted
3. Confirm the asymmetric fallback pair is **not** highlighted, and note this in the runbook's expected-behaviour section rather than treating it as a defect at verification time
4. Confirm the runbook (§6) is followable by someone without this conversation's context — the same bar `dr-procedure.md` is already held to

## 9. Rollout

1. Write `docs/reporting-pipeline-runbook.md` per §6
2. Build and save the reusable Power Query template (no code repo changes — this artifact itself should **not** be committed if it ever contains cached preview data; keep the template's data source cleared before saving)
3. Cross-reference this spec from `docs/known-gaps.md`'s DATA-GAP-001 entry once REQ-DATA-001 ships, updating its status per REQ-DATA-001-v5 §7
4. No PR needed for the runbook alone beyond normal doc-change review, since no `index.html`/test changes are involved

## 10. Changelog

**v2 (this version):** Resubmitted after spec-gate FAIL on v1. Six gaps addressed:
1. **Data-minimisation gap closed (§2/§3):** v1 loaded all eight backup keys into the Power Query data model, including Quotes' commercially sensitive landed-cost/duty/markup output, despite nothing in scope needing them. v2 excludes `inv`/`po`/`qt`/`sh` at the query-expansion step itself, not merely at the flattening step — they never enter the workbook's data model at all.
2. **Formula scalability inconsistency resolved (§3/§4):** v1 mixed hardcoded `$2:$1000` ranges (§4) with structured table references (§5), with no stated ceiling or migration path. v2 establishes in §3 that Power Query's "Close & Load" always produces an Excel Table, and uses structured references consistently in §4, removing the row-count ceiling entirely.
3. **Asymmetric fallback-match edge case documented (§4):** the email-or-name fallback logic can leave a true duplicate pair unflagged if only one record has an email populated. Previously undocumented; now stated explicitly with a recommended manual supplementary check.
4. **AC-001 scope reconciled (§3):** explicitly ties the "four entities" scope back to REQ §3/§5's own match-key table, rather than asserting it without cross-reference.
5. **Concrete test fixture defined (§8):** a synthetic (not live-data) backup fixture with defined baseline/duplicate/near-duplicate/asymmetric-edge-case records, making the verification step falsifiable rather than "confirm it looks right."
6. **Terminology corrected throughout:** "COUNTIFS" → "COUNTIF," matching the actual single-criterion formulas used.

**v1:** Initial draft. FAIL — unnecessary sensitive-data exposure in the query scope, inconsistent/non-scaling formula approach, an undocumented detection edge case, an under-cited scope claim, and no concrete test fixture.
