# REQ-CON-002-v1: Contacts CSV upload button

## Business Context

The Import Data tab (`index.html:480-544`) has CSV upload buttons for Suppliers, Line Items, Invoices, Purchase Orders, and Order Requests — each wired via `bulkUpload(entity, input)` (`index.html:6442-6457`) → `processImport(entity, csvText)` (`index.html:6499` onward). Contacts (`DB.con`) has no equivalent button, even though the field-mapping logic for a Contacts import already exists and works — it's just wired to a different code path.

That existing logic is `processImportRecords()`'s `co` branch (`index.html:6945-6975`), which is only reachable via the Google Sheets pull flow (`importFromSheets()`/`importAllFromSheets()`, `index.html:6730-6788`), not from a direct CSV file upload. `processImportRecords()` and `processImport()` are two separate functions — the former takes already-parsed record objects (from a Sheets API response), the latter parses raw CSV text (`parseImportCSV()`, `index.html:6459-6497`) and has its own per-entity branches. Adding a Contacts CSV button requires a **new `co` branch inside `processImport()`** (mirroring the field logic already proven in `processImportRecords()`'s `co` branch), not a rewiring of the existing Sheets-only function.

Trigger: the user has a CSV of contacts (e.g. `FPM_Stackd_Contacts.csv`) they want into the app, and today the only paths are (a) manual one-by-one entry via Contacts → + New Contact, or (b) routing through Google Sheets (not applicable if the operator doesn't have/want that pipeline configured).

## FM-1 Assessment

No new `K`/`DB`/`EI` entity — reuses the existing `DB.con` entity and its existing fields verbatim (same field set `processImportRecords()`'s `co` branch already writes: `name`, `email`, `phone`, `company`, `status`, `source`, `enquirySummary`, `notes`, `createdAt`, `lastContactedAt`, `gdprBasis`, `enquiries`). No new Sheets sync mapping — Contacts already sync via the existing `co` `FIELD_MAPS` entry regardless of import path. Falls under FM-1 exception item 1, `STACKD_CONTEXT.md:111` ("UI/AI layer features with no new localStorage entities... No new `K` key, no new `DB` entity required"). No separate council decision required.

## Requirements

**REQ-CON-002a (template):** Add a `TEMPLATES.co` entry (alongside the existing `sup`/`li`/`inv`/`po`/`ord` entries, `index.html:6398-6419`) with headers matching the field set `processImportRecords()`'s `co` branch already reads: `['Name','Email','Phone','Company','Status','Source','Enquiry Summary','Notes']`. `dlTemplate()`'s `names` map (`index.html:6424`) gains `co:'contacts'`.

**REQ-CON-002b (import logic in `processImport()`):** Add a `co` branch to `processImport()` mirroring `processImportRecords()`'s `co` branch (`index.html:6945-6975`) field-for-field: dedup by email (case-insensitive) when present, else by exact name match; `status` validated against `['lead','qualified','converted','closed']`, defaulting to `'lead'` for any unrecognized/blank value; `gdprBasis` derived as `'pre_contract'` for `lead`/`qualified`, `'legitimate_interests'` otherwise (same rule, not reinvented); `source` defaults to `'manual'` if blank (distinguishing CSV-uploaded contacts from Sheets-pulled or webform-created ones, which default to `'sheets'`/`'webform'` respectively elsewhere in the app); on update, unspecified CSV columns preserve the existing record's values rather than blanking them (matching `processImportRecords()`'s `existing&&existing.field||''` pattern) — a partial re-upload never destroys previously-captured detail.

**REQ-CON-002c (UI wiring):** Add a new "Contacts" step card to the Import Data tab (`index.html`, alongside the existing Steps 1-5, `index.html:484-544`), with a "Download Template" button (`dlTemplate('co')`), an "Upload Contacts CSV" button + hidden file input (`onchange="bulkUpload('co',this)"`, following the exact same markup pattern as the other steps), and a result div (`imp-co-result`). Placement: since Contacts has no dependency on Suppliers/Line Items (unlike Line Items depending on Suppliers existing first), it can be added as a standalone step — not required to precede or follow any specific existing step.

**REQ-CON-002d (result reporting and refresh):** On completion, `processImport()`'s `co` branch calls `sv(K.co, DB.con)`, updates `G('imp-co-result').textContent` with an added/updated/skipped summary (matching the exact message format used by every other entity's branch, e.g. `'Contacts: N added, N updated, N skipped'`), logs via `impLog()`, and calls `rCon()` to refresh the live Contacts list view if currently open.

**REQ-CON-002e (no duplication of dedup logic — single source of truth risk, acknowledged):** This REQ intentionally duplicates `processImportRecords()`'s `co` field-mapping logic into `processImport()`'s new `co` branch, rather than refactoring both entry points to share one function. This mirrors the existing pattern for every other entity (`sup`/`li`/`inv`/`po` each have separate, independently-maintained branches in `processImport()` vs. no `processImportRecords()` equivalent at all, since only Sheets-pull uses that function) — Contacts is the only entity with both import paths, so this is a new but bounded duplication. Not refactored in this REQ (scope discipline — a shared-helper refactor is a larger, separate change with its own regression risk against the already-working Sheets-pull path); logged as a new known gap (see below) rather than silently accepted.

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

## Known gap to log

**CON-GAP-007** (new): Contacts field-mapping/dedup logic now exists in two places — `processImportRecords()` (Sheets-pull path) and `processImport()` (CSV-upload path, this REQ) — each independently maintained. A future change to one dedup rule (e.g. status validation list, gdprBasis derivation) must be manually mirrored in the other or the two import paths will silently diverge in behavior. No automated test currently asserts the two branches stay in sync; this REQ's test plan tests each branch independently, not their equivalence.

## Changelog

- v1: Initial requirements draft.
