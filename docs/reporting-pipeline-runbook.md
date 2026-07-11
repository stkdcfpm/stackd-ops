# Data-Quality Reporting Pipeline — Runbook

**Applies to:** v2.9.x+ (requires REQ-DATA-001's `num` field for §3 cross-device comparison; duplicate detection in §2 works independently of that)
**Audience:** Operators
**Source spec:** `docs/SPEC-RPT-002-v2.md`

---

## What this is

Stackd Ops is a localStorage-only app — there is no server-side database, and the live Google Sheets sync (`syncEnt`/`pullAll`) is a best-effort, fragile mechanism not designed to answer data-quality questions like "do I have duplicate suppliers?" or "have my two devices drifted apart?"

This pipeline answers those questions a different way: take a JSON backup (Settings → Data → Backup All JSON — the same file used for disaster recovery, see `docs/dr-procedure.md`), load it into an Excel workbook via Power Query, and use spreadsheet formulas to surface exact duplicates and, once the `num` field exists on records (REQ-DATA-001), cross-device identifier divergence.

This is a **manual, operator-run, read-only process**. No code in `index.html` changes. No data is ever written back to Stackd Ops from the workbook — if you find a problem, you go fix it in the portal itself (§4 below).

---

## ⚠️ Handling the generated workbook

**Once the workbook has been "Refreshed" against a real backup, it contains live commercial and personal data — treat it exactly like a backup file.**

- **Never commit the populated workbook to any git repository.** The same reasoning as `SEC-GAP-020` and `dr-procedure.md`'s backup-storage warning applies in full — this repo is publicly served via GitHub Pages.
- Store it only in a private location: local disk, or a personal cloud folder **without link-shareable/public access**.
- After each review session, either **delete** the populated workbook or **clear its data connections** back to the empty template state (Data → Queries & Connections → right-click each query → Delete, or use Data → Refresh against a blank/no source) before storing it long-term.
- Do not keep a standing, indefinitely-growing copy of exported commercial and personal data lying around.
- The reusable **template** (Power Query steps only, cleared of any data source/cached preview) is safe to keep long-term — it contains nothing until you point "Refresh" at a real backup file.

---

## 1. One-time setup — building the workbook

1. In Excel: **Data → Get Data → From File → From JSON**
2. Select a Stackd Ops backup file (e.g. `Stackd-Backup-2026-07-08.json`)
3. In the Power Query editor, click **Into Table**, then **Expand** — in the expand dialog's column checklist, select **only** `sup`, `li`, `buy`, `con`. **Do not select** `inv`, `po`, `qt`, `sh`. This is deliberate data minimisation: Quotes in particular carry commercially sensitive landed-cost/duty/markup figures that this pipeline has no use for, so they should never enter the workbook's data model at all — not just go unused once loaded.
4. For each of the four selected entities: right-click the column → **To Table** → **Expand** the resulting record column to flatten every field (`id`, `num`, `name`, `email`, etc.) into its own column.
5. Rename each query to match its entity — `Suppliers`, `LineItems`, `Buyers`, `Contacts` — and **Close & Load** each as its own worksheet. Loading via Power Query always creates a named Excel Table (e.g. `Suppliers[#All]`), which the formulas in §2/§3 depend on for auto-scaling structured references.

This is a one-time setup per workbook. After that, **Data → Refresh All** re-runs the same import against whichever backup file is currently selected as the source — no need to repeat steps 1–5.

**Saving as a reusable template:** clear the workbook's data connections (so no live data is embedded — see the warning above) and save it as an `.xlsx` template. Next time, open the template, point "Refresh" at a fresh backup file, and all four sheets repopulate without rebuilding the queries.

---

## 2. Running an exact-duplicate check

Each entity sheet (an Excel Table per §1 step 5) has a helper column with a `COUNTIF` formula against a defined match key, using structured table references so it auto-scales as the table grows or shrinks on refresh.

**Match key per entity:**

| Entity | Match key | Formula (helper column `[MatchCount]`) |
|---|---|---|
| Suppliers | `email` if present, else `name` | `=IF([@Email]<>"", COUNTIF(Suppliers[Email], [@Email]), COUNTIF(Suppliers[Name], [@Name]))` |
| Contacts | `email` (always present) | `=COUNTIF(Contacts[Email], [@Email])` |
| Buyers | `email` if present, else `name` | Same pattern as Suppliers, referencing the `Buyers` table |
| Line Items | `desc` (no `name` or `email` field on this entity) | `=COUNTIF(LineItems[Desc], [@Desc])` |

Add conditional formatting: **Home → Conditional Formatting → New Rule → Use a formula** — `=[@MatchCount]>1`, with "Apply to" set to the whole table so the entire row highlights.

**What this catches:** two Contact rows with the exact same email string; two Suppliers with the exact same name string (when both use the same match key — see caveat below).

**What this does NOT catch (by design, out of scope):**
- Spelling/formatting variants — e.g. `"Shandong Jinbao"` vs `"Shandong Jinbao Ltd"`. Catching these needs either a paid fuzzy-match add-in or manual review. **Supplementary manual step:** sort each sheet alphabetically by name and visually scan for near-neighbours, regardless of what `[MatchCount]` shows.
- **Asymmetric fallback edge case:** the Suppliers/Buyers email-or-name fallback checks only one column per row. Two records with the same name — one with an email populated, one without — get counted against *different* columns (Email vs Name), so they are **not guaranteed to be flagged as a match** even though they're likely the same entity. This is a known limitation of the exact-match, single-key-per-row approach, not a formula bug. Use the same manual sort-and-scan step above to catch these.

---

## 3. Running a cross-device `num` comparison (requires the `num` field)

This section only works once Suppliers, Buyers, Contacts, and Line Items records carry a `num` (REQ-DATA-001, SPEC-DATA-001). If your backups don't have `num` populated yet, skip this section.

1. Export a backup from **Device A**, import it (§1) as `Suppliers_A`, `Contacts_A`, etc.
2. Export a backup from **Device B**, import it as a second set of sheets (`Suppliers_B`, `Contacts_B`, etc.) — Power Query supports multiple named queries against different source files in the same workbook.
3. Add a comparison sheet joining the two sets on the match key (§2 — email or name) and displaying both `num` values side by side:
   `=XLOOKUP([@Email], Suppliers_B[Email], Suppliers_B[num], "not found on device B")`
   **Requires Excel 365 or Excel 2021+.** If you only have an older version, use `INDEX`/`MATCH` instead — same result, older-compatible.
4. Add a conditional formatting rule highlighting any row where `Suppliers_A[num] <> Suppliers_B[num]` for a matched record. This is the cross-device divergence risk described in `docs/known-gaps.md` DATA-GAP-003, made visible.

**This is a manual, on-demand check** — run it when switching primary devices, or at minimum monthly if you regularly work across more than one device. It does not run automatically and nothing in Stackd Ops enforces it.

---

## 4. What to do when you find a duplicate or divergence

This pipeline is **read-only** — it never writes back to Stackd Ops. All correction happens manually, in the portal itself:

- **Exact duplicate (§2):** open both records in Stackd Ops, decide which is the "true" one, manually merge any information you need from the other (e.g. copy notes/history across), then delete the duplicate.
- **Cross-device `num` divergence (§3):** decide which device's assignment should stand. There is no automated reconciliation — you are the reconciliation. If both records are genuinely the same real-world entity with different `num` values, treat one `num` as authoritative and note the discrepancy; Stackd Ops does not currently support renumbering an existing record's `num`.
- **Near-duplicate / asymmetric-fallback pairs found via manual scan (§2):** use judgement — these are not flagged automatically, so false positives from your own visual scan are expected and fine to dismiss.

---

## Known limitations (see `docs/known-gaps.md` for full entries)

- **DATA-GAP-003** — cross-device `num` divergence is not prevented, only surfaced by this pipeline's §3 check, and only when you remember to run it.
- Exact-duplicate detection (§2) is single-match-key, single-row — it does not catch spelling variants or the asymmetric email/name fallback case (documented above).
