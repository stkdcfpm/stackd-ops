# REQ-ORD-003-v2: CSV Import → Order Request wiring + Quote approval audit trail

**Supersedes:** REQ-ORD-003-v1

## Business Context

(Unchanged from v1 — see that document. Both parts remain: A) a new CSV import path for Order Requests, mirroring the existing template-download/upload-button pattern in the Import Data tab; B) a Quote approval audit trail, since `qteToPoConvert()` — confirmed at `index.html:9252`, `if (q.status !== 'Accepted')` — already gates PO conversion on `Accepted` status, but nothing records who approved it or why.)

## Corrections from v1 (requirements-gate FAIL)

**1. Two competing import pipelines exist — this REQ now names which one `ord` extends.** Requirements-gate found the codebase has two near-duplicate CSV/record-import engines for `sup`/`li`/`inv`/`po`: `processImport()` (`index.html:6360` onward, driven by file upload in the Import Data tab, `bulkUpload()` → `processImport()`) and a separate `processImportRecords()` (`index.html:6577` onward, driven only by `importFromSheets()` — a direct Google-Sheets-read path, unrelated to file upload). **This REQ extends `processImport()`/`bulkUpload()` only** — the Import Data tab, file-upload path — since that's what a webform-exported CSV naturally feeds into. `processImportRecords()` is untouched; no `ord` branch is added there.

**2. Corrected dedup precedent citation.** v1 cited `saveCon()`'s email-match logic (`index.html:9158-9159`) as the pattern to mirror for silent Contact matching — but requirements-gate correctly found that code path is followed by an interactive `confirm()` dialog (`index.html:9161-9174`), which cannot work in a headless, multi-row CSV import loop. **The correct precedent is `processImportRecords()`'s existing `co` branch** (`index.html:6731-6761`), which already does exactly this: silent, no-dialog email match (falling back to name match if email is blank), auto-creates a new Contact if no match, and derives `gdprBasis` automatically. Confirmed exact values stored: `gdprBasis = (status === 'lead' || status === 'qualified') ? 'pre_contract' : 'legitimate_interests'` (`index.html:6741`) — the literal string `'pre_contract'`, not the human-readable label `"Art.6(1)(b)"` (that label is UI/doc-only text, `index.html:7200`). This REQ's Contact-matching logic for `ord` import should be a straight adaptation of this existing `co` branch, not a new implementation.

**3. GDPR lawful-basis statement added for webform-sourced Contacts** — see new paragraph in Business Context below and REQ-ORD-005's explicit basis statement.

**GDPR note (new in v2):** the CSV import creates Contact PII (name, email) sourced from an external, out-of-scope webform. This REQ takes the position that the lawful basis is the same `pre_contract` (Art.6(1)(b)) basis already used for every other `lead`-status Contact creation path in this app (manual entry, Sheets import) — the act of a prospective buyer submitting a purchase enquiry is itself the pre-contractual step this basis is designed to cover. This REQ does **not** invent a new consent-collection mechanism; it assumes the (out-of-scope, future) webform itself is responsible for any privacy notice/consent language shown to the submitter before their data reaches this import path — same division of responsibility as any other external data source feeding this pipeline. Logged as a residual risk below rather than blocking, consistent with how the existing Sheets-import `co` path already carries this same assumption today.

## FM-1 Assessment

(Unchanged from v1 — confirmed by requirements-gate: `FIELD_MAPS` has no `ord` entry at all, `FIELD_MAPS.qt` lists only `num/client/dt/status/currency/calc_totalLanded/markup/notes` — none of the three new `qt` fields. Both `ord.importBatchId` and `qt.approvedBy`/`approvedReason`/`approvedAt` are new fields on already-existing entities with no new Sheets sync mapping — **FM-1 Exception 2**.)

## Requirements

### Part A — CSV Import → Order Request

**REQ-ORD-004**: Add a new CSV import path for Order Requests via `processImport()`/`bulkUpload()`/the Import Data tab (not `processImportRecords()`/Sheets-pull — see Correction 1).

**Column shape** (one CSV row = one Order Request *line*; rows sharing a **Submission ID** merge into one Order Request with multiple lines):
`Submission ID, Contact Name, Contact Email, Order Description, Category, Item/Spec, Order Volume Qty, Order Volume Unit, Packing Spec, Base UOM, Base Qty, Qty Status, Source Country, Variant/Option`

**REQ-ORD-005**: Contact matching adapts `processImportRecords()`'s existing `co` branch (`index.html:6731-6761`) exactly: match by email (case-insensitive) if present, else by exact name match; auto-create a new Contact if no match (`status: 'lead'`, `source: 'webform'`, `gdprBasis: 'pre_contract'` — the literal stored value, matching the existing derivation rule). **Contact Email** is required per row; rows missing it are skipped (mirrors `processImport()`'s existing skip-on-missing-required-field pattern, `index.html:6371`, `6389`).

**REQ-ORD-006**: Order Request matching/dedup uses a new field `ord.importBatchId` (stores the CSV's Submission ID). Re-importing a CSV containing a Submission ID already present on an existing Order Request **updates** that Order Request's lines rather than creating a duplicate. A genuinely new Submission ID creates a new Order Request at stage `New`, linked to the matched/created Contact.

**REQ-ORD-007**: Each CSV row becomes one Order Request line in the exact shape established by `SPEC-ORD-002` (`category`, `itemSpec`, `orderVolumeQty`, `orderVolumeUnit`, `packingSpec`, `baseUom`, `baseQty`, `qtyStatus`, `sourceCountry`, `variantOption`) — no new line-level fields invented. A row is skipped (not the whole Order Request) if both **Category** and **Item/Spec** are blank.

**REQ-ORD-008**: **Qty Status** in the CSV must be one of `Unknown`/`Estimated`/`Confirmed` (case-insensitive); blank or unrecognised values default to `Unknown`.

**REQ-ORD-009**: A downloadable CSV template (`TEMPLATES.ord`, mirroring `TEMPLATES.sup`/`li`/`inv`/`po`) and a new "Order Requests" step card in the Import Data tab, wired to `bulkUpload('ord', this)` → `processImport('ord', csvText)`.

### Part B — Quote approval audit trail

(Unchanged from v1 — requirements-gate verified all of this accurate against `saveQte()`/`vQte()`/`qteToPoConvert()`.)

**REQ-ORD-010**: Add three fields to the Quote record: `approvedBy` (string), `approvedReason` (string, optional), `approvedAt` (ISO timestamp).

**REQ-ORD-011**: The Quote modal gains two new fields — **Approved By** and **Approval Note** — shown only when the Status dropdown (`qf-st`) is set to `Accepted`. **Approved By** is required whenever `saveQte()` is called with status `Accepted`; **Approval Note** is optional.

**REQ-ORD-012**: `approvedAt` is set to `new Date().toISOString()` only the first time a Quote's status transitions into `Accepted` (`existing.status !== 'Accepted'` before this save). If already `Accepted` and re-saved, `approvedAt` is preserved from its original value.

**REQ-ORD-013**: `vQte()` (`index.html:8934-8942`, confirmed to currently have exactly three checks — client, date, line items, no status-conditional logic) gains a check: if status being saved is `Accepted` and `approvedBy` is blank, block the save with a validation error.

## Acceptance Criteria

(Unchanged from v1 — all independently testable per requirements-gate.)

- AC-001: A CSV with 3 rows sharing one Submission ID and a Contact Email matching an existing Contact produces one Order Request with 3 lines, linked to that existing Contact.
- AC-002: A CSV with a Contact Email matching no existing Contact creates a new Contact (`status: 'lead'`, `source: 'webform'`, `gdprBasis: 'pre_contract'`) and links the new Order Request to it.
- AC-003: Re-importing the same Submission ID with an added 4th row updates the existing Order Request to 4 lines, does not create a second Order Request.
- AC-004: A row with blank Category and blank Item/Spec is skipped; other rows in the same Submission ID still import.
- AC-005: A row with blank Contact Email is skipped entirely.
- AC-006: `Qty Status` values `"confirmed"`, `"CONFIRMED"`, `""`, `"garbage"` map to `Confirmed`, `Confirmed`, `Unknown`, `Unknown`.
- AC-007: Saving a Quote with status `Accepted` and blank Approved By is blocked with a validation error.
- AC-008: Saving a Quote with status `Accepted` and populated Approved By succeeds, sets `approvedAt` to the current time.
- AC-009: Re-saving an already-`Accepted` Quote (editing only Approval Note) leaves `approvedAt` unchanged.
- AC-010: A Quote never set to `Accepted` has `approvedBy`/`approvedReason`/`approvedAt` all absent/blank.

## Explicitly Out of Scope

(Unchanged from v1 — the external webform itself; `qteToPoConvert()`'s existing gate logic; a stronger `CONFIRM`+reason typed gate for Quote acceptance; a full edit-history log for approval fields.)

## Residual Risks (logged, not blocking)

(v1's two risks retained, plus:)
- **GDPR basis for webform-sourced Contacts assumes the external webform (out of scope) handles its own consent/privacy-notice presentation** before data reaches this import path — this REQ only ensures the *portal's* Contact-creation logic matches the already-accepted `pre_contract` basis used everywhere else; it does not audit or specify what the webform itself must show a submitter. Flagged for revisit once the webform is actually scoped.
- No edit history for `approvedBy`/`approvedReason` after initial approval (only `approvedAt`'s first-transition value is protected).
- CSV-imported Contacts get no `enquiries[]` entry (Order Request lines already capture the ask).

## Changelog

- v2: Named `processImport()`/`bulkUpload()` (not `processImportRecords()`) as the pipeline `ord` import extends; corrected the Contact-dedup precedent citation from `saveCon()` (interactive, wrong for batch CSV) to `processImportRecords()`'s existing `co` branch (silent, correct precedent); corrected the stored `gdprBasis` value to the literal `'pre_contract'` string; added an explicit GDPR lawful-basis statement for webform-sourced Contacts.
- v1: Initial draft (superseded).
