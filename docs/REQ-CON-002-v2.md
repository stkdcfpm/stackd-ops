# REQ-CON-002-v2: Contacts CSV upload button

**Supersedes:** REQ-CON-002-v1 (requirements-gate PASS, with one correction required before spec — REQ-CON-002e and CON-GAP-007 both incorrectly claimed `sup`/`li`/`inv`/`po` have no `processImportRecords()` equivalent; they do, at `index.html:6795-6944`, and are live/reachable via `importAllFromSheets()`'s entity list, `index.html:6780`)

## Business Context

The Import Data tab (`index.html:480-544`) has CSV upload buttons for Suppliers, Line Items, Invoices, Purchase Orders, and Order Requests — each wired via `bulkUpload(entity, input)` (`index.html:6442-6457`) → `processImport(entity, csvText)` (`index.html:6499` onward). Contacts (`DB.con`) has no equivalent button, even though the field-mapping logic for a Contacts import already exists and works — it's just wired to a different code path.

That existing logic is `processImportRecords()`'s `co` branch (`index.html:6945-6975`), which is only reachable via the Google Sheets pull flow (`importFromSheets()`/`importAllFromSheets()`, `index.html:6730-6788`), not from a direct CSV file upload. `processImportRecords()` and `processImport()` are two separate functions — the former takes already-parsed record objects (from a Sheets API response), the latter parses raw CSV text (`parseImportCSV()`, `index.html:6459-6497`) and has its own per-entity branches. Adding a Contacts CSV button requires a **new `co` branch inside `processImport()`** (mirroring the field logic already proven in `processImportRecords()`'s `co` branch), not a rewiring of the existing Sheets-only function.

Trigger: the user has a CSV of contacts (e.g. `FPM_Stackd_Contacts.csv`) they want into the app, and today the only paths are (a) manual one-by-one entry via Contacts → + New Contact, or (b) routing through Google Sheets (not applicable if the operator doesn't have/want that pipeline configured).

## FM-1 Assessment

No new `K`/`DB`/`EI` entity — reuses the existing `DB.con` entity and its existing fields verbatim (same field set `processImportRecords()`'s `co` branch already writes: `name`, `email`, `phone`, `company`, `status`, `source`, `enquirySummary`, `notes`, `createdAt`, `lastContactedAt`, `gdprBasis`, `enquiries`). No new Sheets sync mapping — Contacts already sync via the existing `co` `FIELD_MAPS` entry regardless of import path. Falls under FM-1 exception item 1, `STACKD_CONTEXT.md:111` ("UI/AI layer features with no new localStorage entities... No new `K` key, no new `DB` entity required"). No separate council decision required.

## GDPR (new in v2 — explicit statement per requirements-gate v1 suggestion)

No GDPR reassessment needed. This REQ changes only the ingestion mechanism (a second entry path into the same `DB.con` entity) — the fields captured, the `gdprBasis` derivation rule, and the retention/purge posture (`CON-GAP-001`) are all reused unchanged from the already-reviewed `processImportRecords()` `co` branch, not reinvented.

## Requirements

**REQ-CON-002a (template):** Add a `TEMPLATES.co` entry (alongside the existing `sup`/`li`/`inv`/`po`/`ord` entries, `index.html:6398-6419`) with headers matching the field set `processImportRecords()`'s `co` branch already reads: `['Name','Email','Phone','Company','Status','Source','Enquiry Summary','Notes']`. `dlTemplate()`'s `names` map (`index.html:6424`) gains `co:'contacts'`.

**REQ-CON-002b (import logic in `processImport()`):** Add a `co` branch to `processImport()` mirroring `processImportRecords()`'s `co` branch (`index.html:6945-6975`) field-for-field: dedup by email (case-insensitive) when present, else by exact name match; `status` validated against `['lead','qualified','converted','closed']`, defaulting to `'lead'` for any unrecognized/blank value; `gdprBasis` derived as `'pre_contract'` for `lead`/`qualified`, `'legitimate_interests'` otherwise (same rule, not reinvented); `source` defaults to `'manual'` if blank (distinguishing CSV-uploaded contacts from Sheets-pulled or webform-created ones, which default to `'sheets'`/`'webform'` respectively elsewhere in the app); on update, unspecified CSV columns preserve the existing record's values rather than blanking them (matching `processImportRecords()`'s `existing&&existing.field||''` pattern) — a partial re-upload never destroys previously-captured detail.

**REQ-CON-002c (UI wiring):** Add a new "Contacts" step card to the Import Data tab (`index.html`, alongside the existing Steps 1-5, `index.html:484-544`), with a "Download Template" button (`dlTemplate('co')`), an "Upload Contacts CSV" button + hidden file input (`onchange="bulkUpload('co',this)"`, following the exact same markup pattern as the other steps), and a result div (`imp-co-result`). Placement: since Contacts has no dependency on Suppliers/Line Items (unlike Line Items depending on Suppliers existing first), it can be added as a standalone step — not required to precede or follow any specific existing step.

**REQ-CON-002d (result reporting and refresh):** On completion, `processImport()`'s `co` branch calls `sv(K.co, DB.con)`, updates `G('imp-co-result').textContent` with an added/updated/skipped summary (matching the exact message format used by every other entity's branch, e.g. `'Contacts: N added, N updated, N skipped'`), logs via `impLog()`, and calls `rCon()` to refresh the live Contacts list view if currently open.

**REQ-CON-002e (existing duplication pattern extended, not newly introduced — corrected in v2):** `processImportRecords()` (`index.html:6795-6944`) already has independent `sup`/`li`/`inv`/`po` branches alongside its `co` branch — every one of those four entities already has two independently-maintained import code paths today (`processImport()` for direct CSV upload, `processImportRecords()` for the Sheets-pull flow reachable via `importAllFromSheets()`'s `['sup','li','inv','po','co']` entity list, `index.html:6780`). This REQ does not introduce a new kind of duplication risk — it extends an already-existing, already-accepted pattern to a fifth entity (Contacts). No refactor to a shared helper is proposed here, consistent with how `sup`/`li`/`inv`/`po` are already handled — scope discipline, not an oversight.

## Acceptance Criteria

- AC-001: Uploading a CSV with headers `Name,Email,Phone,Company,Status,Source,Enquiry Summary,Notes` and one data row creates exactly one new `DB.con` record with all fields correctly mapped.
- AC-002: A second upload of the same CSV (same email) updates the existing record (matched by email) rather than creating a duplicate — `added` stays 0, `updated` increments.
- AC-003: A row with an email not matching any existing contact, but a name matching an existing contact by exact string, is still treated as a fresh row needing email-based matching first (i.e., email match takes priority over name match, replicating `processImportRecords()`'s existing `existing = email ? ... : ...` priority exactly) — not a new rule invented for this REQ.
- AC-004: A row with neither `Name` nor `Email` populated is skipped (`skipped` increments), not created as a blank contact.
- AC-005: An invalid/unrecognized `Status` value (e.g. "Prospect") defaults to `'lead'`, not left blank or erroring.
- AC-006: Re-uploading a CSV that omits the `Notes` column for an existing contact preserves that contact's previously-saved `notes` value rather than blanking it.
- AC-007: The new `TEMPLATES.co` downloadable template's headers exactly match what the `co` import branch reads (no header the branch ignores, no field the branch reads that isn't in the template).
- AC-008: After a successful upload, the Contacts tab (if open) reflects the new/updated records without requiring a manual page reload.
- AC-009: The result message format (`'Contacts: N added, N updated, N skipped'`) is consistent with the message format already used by every other entity's `processImport()` branch.

## Known gap to log (corrected in v2)

**CON-GAP-007** (new — corrected scope): Contacts becomes the fifth entity (alongside `sup`/`li`/`inv`/`po`, already the case before this REQ) with two independently-maintained import code paths — `processImportRecords()` (Sheets-pull) and `processImport()` (direct CSV upload). This is an extension of an existing, pre-existing pattern/risk (not new to Contacts, and not newly introduced by this REQ) — a future change to one dedup rule (e.g. status validation list, gdprBasis derivation) in either function must be manually mirrored in the other or the paths will silently diverge in behavior, for any of the five entities. No automated test currently asserts any of the five entity-pairs' branches stay in sync; this REQ's test plan tests the new `co` branch in `processImport()` independently, not its equivalence to `processImportRecords()`'s existing `co` branch.

## Changelog

- v2: Corrected REQ-CON-002e and CON-GAP-007's factual claim that `sup`/`li`/`inv`/`po` have no `processImportRecords()` equivalent — they do (`index.html:6795-6944`), and are live/reachable via `importAllFromSheets()`. Re-scoped both as "extending an existing pattern to a fifth entity," not introducing a new one. Added an explicit GDPR section stating no reassessment is needed (requirements-gate v1 suggestion, non-blocking).
- v1: Initial requirements draft (requirements-gate PASS, with the above correction required before spec).
