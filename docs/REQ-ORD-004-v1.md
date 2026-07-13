# REQ-ORD-004-v1: Triage tool → Order Request CSV export

## Business Context

The "FPM Enquiry Triage — 10 Minute Screen" tool (standalone HTML, recolored to Stackd Ops' brand palette this session, not yet committed to the repo) sits as a pre-screening gate *before* any Order Request is created — an operator runs an inbound enquiry through it, and only a "Cleared for study" verdict should become a real Order Request.

Confirmed by direct code read: today the tool's only output is a freeform text block (`buildOutput()`, generates a Notion/email/WhatsApp-pasteable string) — it does not produce anything matching the CSV shape `TEMPLATES.ord` expects (`index.html:6311-6314`: `['Submission ID','Contact Name','Contact Email','Order Description','Category','Item/Spec','Order Volume Qty','Order Volume Unit','Packing Spec','Base UOM','Base Qty','Qty Status','Source Country','Variant/Option']`), consumed by the `processImport()` `ord` branch shipped in v2.9.48 (`REQ/SPEC-ORD-003`). This REQ adds a CSV export to the triage tool so a cleared enquiry can be downloaded and run straight through the existing importer, rather than manually retyped into a new Order Request.

**Gap found while scoping this**: the triage tool has no email field at all — only `mProduct`, `mBuyer` (freeform name/contact text), `mDest`. `REQ-ORD-005` (v2.9.48) requires **Contact Email** on every CSV row; rows without it are skipped entirely (`index.html`'s `processImport()` `ord` branch). A new email input is required for this export to actually work, not just a formatting change.

**Parser constraint found while scoping this**: `parseImportCSV()` (`index.html:6344-6372`) toggles quote-state on every literal `"` character (`if (ch === '"') { inQuote = !inQuote; }`) — it does not unescape doubled quotes (`""`) as a single literal quote, the standard CSV convention. A generated CSV containing an unescaped `"` inside a field (e.g. a buyer name typed with a quote character) would silently corrupt column alignment for that row when re-parsed. This REQ's export function must strip literal `"` characters from every field value before writing the CSV, since the consuming parser cannot be assumed to handle them — not because it's good CSV hygiene in the abstract, but because `parseImportCSV()` specifically breaks on them today.

## FM-1 Assessment

This REQ touches only the standalone triage HTML file, not `index.html`/`Code.gs`/`FIELD_MAPS` — no `K`/`DB` entity, no Sheets sync mapping, nothing that falls under FM-1's scope at all. The one point of contact with the frozen app is read-only: this REQ's CSV output must exactly match `TEMPLATES.ord`'s existing header list — it does not add or change that contract.

## Requirements

**REQ-ORD-014**: Add a **Contact Email** input to the triage tool's `.meta` fields, alongside the existing Product/Buyer/Destination inputs.

**REQ-ORD-015**: Add a "Download Order Request CSV" button, visible/enabled only when the current verdict is `'go'` ("Cleared for study") — mirrors the existing verdict-gated UI pattern (the Convert-to-PO button pattern in the main app: only appears when the relevant precondition is met).

**REQ-ORD-016**: On click, generate a CSV file with exactly `TEMPLATES.ord`'s header row (`index.html:6312`, order preserved exactly) and one data row:
- `Submission ID`: generated as `TRI-` + `YYYYMMDD` + a short random suffix (e.g. `TRI-20260713-a1b2`), guaranteed distinct per triage run.
- `Contact Name`: the **Buyer / contact** field value.
- `Contact Email`: the new email field value (REQ-ORD-014) — required; if blank, the export button is disabled/shows a validation message rather than producing an unimportable row (mirrors `REQ-ORD-005`'s required-field rule, enforced client-side here instead of silently producing a row that would just get skipped on import).
- `Order Description`: a synthesized string combining the Destination field and a note that this came from the triage screen (e.g. `"Destination: Bridgetown, Barbados. Cleared via 10-Minute Triage Screen."`), plus, if any open risks remain (the `risks` array), an appended summary of them — since a "go" verdict can still carry open risks per the tool's own existing logic (`evaluate()`'s `risks.length` branch).
- `Category` and `Item/Spec`: both set to the **Product line** field value (satisfies `REQ-ORD-007`'s "at least one of Category/Item-Spec non-blank" rule; duplicating avoids inventing a distinction the triage tool doesn't actually capture).
- `Order Volume Qty`, `Order Volume Unit`, `Packing Spec`, `Base UOM`, `Base Qty`, `Source Country`, `Variant/Option`: all blank — none of this detail is collected by the triage screen, and inventing placeholder values would misrepresent what's actually known at this stage.
- `Qty Status`: left blank, so the importer's existing default (`REQ-ORD-008`: blank → `Unknown`) applies — correct, since packaging/quantity genuinely isn't resolved yet at triage time.

**REQ-ORD-017**: Before writing any field value into the CSV, strip literal `"` characters (per the parser-constraint finding above) — apply to every field, not just freeform ones, for consistency and to avoid a future regression if a currently-fixed field (e.g. `Qty Status`) is ever made freeform.

**REQ-ORD-018**: The exported file downloads client-side (same `data:text/csv` + anchor-click pattern `dlTemplate()` already uses in the main app, `index.html:6294-6301` — no server, no new dependency) with a filename like `triage-order-request-<Submission-ID>.csv`.

## Acceptance Criteria

- AC-001: With verdict `'go'` and a populated Contact Email, clicking the export button downloads a CSV with exactly `TEMPLATES.ord`'s 14 headers in the same order.
- AC-002: With verdict anything other than `'go'` (`kill`/`ask`/`part`/`idle`), the export button is hidden or disabled.
- AC-003: With verdict `'go'` but a blank Contact Email, the export button is disabled and a validation message is shown — no CSV is generated.
- AC-004: The exported row's `Category` and `Item/Spec` both equal the Product line field's value.
- AC-005: A Buyer/contact name containing a literal `"` character is exported with that character stripped, and the resulting CSV re-parses correctly through the existing `parseImportCSV()`/`processImport('ord', ...)` path with no column misalignment (verified by actually running the exported string through the real import function, not just visual inspection).
- AC-006: Two triage runs for the same product/buyer on the same day produce CSVs with two different Submission IDs (no collision from the date-based portion alone).
- AC-007: Running the exported CSV through `processImport('ord', ...)` produces exactly one Order Request with one line, `qtyStatus: 'Unknown'`, and (if the Contact Email doesn't already match an existing Contact) creates a new lead-status Contact — i.e. the full existing v2.9.48 import path handles this export correctly with zero special-casing needed on the import side.

## Explicitly Out of Scope

- Any change to `index.html`'s `TEMPLATES.ord`, `processImport()`, or the import contract itself — this REQ only produces a file compatible with what already exists.
- Committing the triage tool into the `stackd-ops` repo as a permanent page/route — that's a separate decision (where it lives, whether it becomes part of the product's own hosted pages) not addressed here.
- Capturing any of the currently-blank fields (packing spec, base UOM/qty, source country, variant) at triage time — the triage screen's scope is deliberately a fast go/no-go filter, not a full intake form.

## Residual Risks (logged, not blocking)

- If the triage tool and `TEMPLATES.ord` ever diverge (e.g. a future header added to one but not the other), this export silently breaks with no shared source of truth between the two files — they're two independent HTML files with no build step to catch a drift. Worth a manual note/checklist item whenever `TEMPLATES.ord` changes in the main app.
