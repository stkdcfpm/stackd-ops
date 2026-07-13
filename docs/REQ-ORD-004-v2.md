# REQ-ORD-004-v2: Triage tool → Order Request CSV export

**Supersedes:** REQ-ORD-004-v1

## Business Context

(Unchanged from v1 — see that document for the full framing: the triage tool sits as a pre-screening gate before any Order Request exists, and today only produces a freeform text block, not anything importable.)

## Correction from v1 (requirements-gate FAIL)

**The parser-defect worked example was factually wrong.** v1 cited `Bob "Big Deal" Smith` as proof `parseImportCSV()`'s (`index.html:6355-6377`) quote-toggling would misalign columns — but requirements-gate traced it character-by-character and found this example has a **balanced (even)** count of literal `"` characters (2 wrapper + 2 embedded = 4 total), so `inQuote` toggles on-then-off and parity is restored before the next real delimiter — no misalignment actually occurs for this example.

**The defect is still real**, just for a different condition: an **odd** number of embedded literal quote characters. Corrected example: a Buyer name typed as `Bob "Big Deal Smith` (one unmatched `"`). Exported and wrapped, the field becomes `"Bob "Big Deal Smith"` — 3 total `"` characters (odd). Tracing `parseImportCSV()`'s loop: quote 1 (wrapper open) → `inQuote=true`; quote 2 (embedded) → `inQuote=false`; the field's closing wrapper quote 3 → `inQuote=true` again — so `inQuote` is `true` when the parser reaches the comma that should end this column, and that comma is incorrectly treated as "inside quotes" and swallowed into the field instead of ending it, shifting every subsequent column in that row. This is the actual, traceable failure mode `REQ-ORD-017`'s quote-stripping mitigation exists to prevent (stripping all `"` before write leaves zero quote characters regardless of original parity, so the field is safe under any input, odd or even count).

`AC-005` is corrected to use this same odd-quote-count example, so the acceptance test actually exercises the edge case being guarded against, rather than a balanced-quote case that was never going to fail either way.

**GDPR note added (flagged, non-blocking, by requirements-gate):** `REQ-ORD-014`'s new Contact Email field is a new PII input that feeds directly into `DB.con` via the existing v2.9.48 import path — same GDPR surface as any other Contact-creation path already in the app (`gdprBasis: 'pre_contract'` for a new `lead`-status Contact, matching the precedent established in `REQ-ORD-003`). The triage tool itself is client-side/ephemeral only (confirmed by code read — no transmission, no storage beyond the in-memory `state` object and the downloaded file) until the operator chooses to import the exported CSV into the portal; this REQ does not change that boundary.

## FM-1 Assessment

(Unchanged from v1 — this REQ touches only the standalone triage HTML file, no `K`/`DB`/`FIELD_MAPS` change; its only contact with the frozen app is read-only conformance to `TEMPLATES.ord`'s existing header list.)

## Requirements

(REQ-ORD-014 through REQ-ORD-016, REQ-ORD-018 unchanged from v1.)

**REQ-ORD-014**: Add a **Contact Email** input to the triage tool's `.meta` fields, alongside the existing Product/Buyer/Destination inputs.

**REQ-ORD-015**: Add a "Download Order Request CSV" button, visible/enabled only when the current verdict is `'go'` ("Cleared for study").

**REQ-ORD-016**: On click, generate a CSV file with exactly `TEMPLATES.ord`'s header row (`index.html:6312`, order preserved exactly) and one data row:
- `Submission ID`: `TRI-` + `YYYYMMDD` + a short random suffix (e.g. `TRI-20260713-a1b2`), guaranteed distinct per triage run.
- `Contact Name`: the **Buyer / contact** field value.
- `Contact Email`: the new email field value (REQ-ORD-014) — required; if blank, the export button is disabled/shows a validation message.
- `Order Description`: a synthesized string combining the Destination field and a triage-origin note, plus a summary of any open risks (the `risks` array) if present.
- `Category` and `Item/Spec`: both set to the **Product line** field value.
- `Order Volume Qty`, `Order Volume Unit`, `Packing Spec`, `Base UOM`, `Base Qty`, `Source Country`, `Variant/Option`: all blank.
- `Qty Status`: left blank (importer defaults blank → `Unknown`).

**REQ-ORD-017**: Before writing any field value into the CSV, strip literal `"` characters from every field — corrected justification (see above): this is required to guard against an **odd** count of embedded quote characters shifting `parseImportCSV()`'s column alignment on re-parse, not the previously-cited (incorrect) even-count example.

**REQ-ORD-018**: The exported file downloads client-side (same `data:text/csv` + anchor-click pattern `dlTemplate()` already uses, `index.html:6294-6301`) with a filename like `triage-order-request-<Submission-ID>.csv`.

## Acceptance Criteria

(AC-001 through AC-004, AC-006, AC-007 unchanged from v1; AC-005 corrected.)

- AC-001: With verdict `'go'` and a populated Contact Email, clicking the export button downloads a CSV with exactly `TEMPLATES.ord`'s 14 headers in the same order.
- AC-002: With verdict anything other than `'go'`, the export button is hidden or disabled.
- AC-003: With verdict `'go'` but a blank Contact Email, the export button is disabled and a validation message is shown — no CSV is generated.
- AC-004: The exported row's `Category` and `Item/Spec` both equal the Product line field's value.
- **AC-005 (corrected)**: A Buyer/contact name containing an **odd** number of embedded literal `"` characters (e.g. `Bob "Big Deal Smith`, one unmatched quote) is exported with all `"` characters stripped, and the resulting CSV re-parses correctly through the existing `parseImportCSV()`/`processImport('ord', ...)` path with no column misalignment — verified by actually running the exported string through the real import function and confirming every column lands in the correct field, not just visual inspection.
- AC-006: Two triage runs for the same product/buyer on the same day produce CSVs with two different Submission IDs.
- AC-007: Running the exported CSV through `processImport('ord', ...)` produces exactly one Order Request with one line, `qtyStatus: 'Unknown'`, and (if the Contact Email doesn't already match an existing Contact) creates a new lead-status Contact.

## Explicitly Out of Scope

(Unchanged from v1 — no change to `TEMPLATES.ord`/`processImport()`/the import contract; no decision on committing the triage tool into the repo; no capture of packing/UOM/source-country detail at triage time.)

## Residual Risks (logged, not blocking)

(Unchanged from v1 — the two-independent-files drift risk between the triage tool and `TEMPLATES.ord`.)

## Changelog

- v2: Corrected the parser-defect example and AC-005's test string from a balanced-quote-count case (which requirements-gate proved doesn't actually break `parseImportCSV()`) to an odd-quote-count case that does; added an explicit GDPR note for the new Contact Email field.
- v1: Initial draft (superseded — factually incorrect worked example).
