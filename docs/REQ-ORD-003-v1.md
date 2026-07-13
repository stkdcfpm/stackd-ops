# REQ-ORD-003-v1: CSV Import → Order Request wiring + Quote approval audit trail

## Business Context

Two related asks from the same conversation:

**A. CSV Import → Order Request.** The portal already has a CSV import pipeline (`processImport()`, `index.html:6360` onward) for `sup`/`li`/`inv`/`po`, each with a template download (`TEMPLATES`, `index.html:6263-6280`) and dedicated upload button in the Import Data tab (`index.html:484-506` pattern). Order Requests (`DB.ord`, shipped v2.9.44/v2.9.45 — `REQ/SPEC-ORD-001`/`002`) have no CSV import path at all today — the only ways an Order Request is created are the manual "+ New Order Request" form, or automatic backfill from existing Quotes/Contacts (`backfillOrderRequests()`). The user wants a **webform** (a separate, future "Stackd webpage" product, explicitly out of scope here) to collect structured purchase requirements from buyers, which get exported as CSV and imported into the portal as Order Requests via **this REQ's** import wiring — this REQ covers only the ingestion mechanism inside the existing portal, not the external form itself.

**B. Quote approval audit trail.** Confirmed by code read: `qteToPoConvert()` (`index.html:9246-9252`) already refuses to convert a Quote to Purchase Order(s) unless `q.status === 'Accepted'` (`QTE-GAP-001`, fixed v2.9.25) — so "Accepted" status already functions as the approval gate before supplier commitment happens. But `saveQte()` (`index.html:8944` onward) sets `status: G('qf-st').value` from a plain dropdown (`index.html:2152-2157`) with **no record of who approved it or why** — no approver name, no reason, no timestamp of when it was approved. The user wants that audit trail added.

## FM-1 Assessment

**Part A**: no new `K`/`DB` entity — `DB.ord` and `DB.con` both already exist (`ord` since v2.9.44, with an established FM-1 category-3 precedent of **no Sheets sync mapping** for this entity — confirmed no `FIELD_MAPS.ord` entry exists and none is being added here). The one new field this REQ adds (`ord.importBatchId`, see REQ-ORD-005 below) is a new field on an existing entity with no new sync mapping required — **FM-1 Exception 2**.

**Part B**: three new fields on `DB.qt` (`approvedBy`, `approvedReason`, `approvedAt`) — `qt` already exists in `K`/`DB`/`saveAll()`; these fields require no new `FIELD_MAPS.qt` entry (Quote already has a Sheets mapping for other fields, but these three audit fields are not being added to it) — **FM-1 Exception 2**, same category as the already-approved precedent (`supplierId`/`role` on `DB.con`).

Neither part touches Sheets sync (`FIELD_MAPS`, `syncEnt`, Apps Script tabs) — both stay clear of the FM-1 freeze line that blocked the earlier `sourceContactId`/`enquiries` idea.

## Requirements

### Part A — CSV Import → Order Request

**REQ-ORD-004**: Add a new CSV import path for Order Requests, following the existing `processImport()`/`TEMPLATES`/Import Data tab pattern used for `sup`/`li`/`inv`/`po`.

**Column shape** (one CSV row = one Order Request *line*; multiple rows sharing the same **Submission ID** merge into a single Order Request with multiple lines — a webform submission naturally produces several requested items per submission):
`Submission ID, Contact Name, Contact Email, Order Description, Category, Item/Spec, Order Volume Qty, Order Volume Unit, Packing Spec, Base UOM, Base Qty, Qty Status, Source Country, Variant/Option`

**REQ-ORD-005**: Contact matching mirrors `saveCon()`'s existing dedup rule exactly (`index.html:9158-9159`, case-insensitive email match). If **Contact Email** matches an existing Contact, link to it. If not, auto-create a new Contact (`status: 'lead'`, `source: 'webform'`, GDPR basis auto-derived the same way `saveCon()` already does it — `Art.6(1)(b)` for lead status). **Contact Email** is required per row; rows missing it are skipped (mirrors the existing skip-on-missing-required-field pattern in `sup`/`li` import, `index.html:6371`, `6389`).

**REQ-ORD-006**: Order Request matching/dedup uses a new field `ord.importBatchId` (stores the CSV's Submission ID). Re-importing a CSV containing a Submission ID already present on an existing Order Request **updates** that Order Request's lines rather than creating a duplicate (mirrors the update-vs-add dedup pattern already used for `sup`/`li` import). A genuinely new Submission ID creates a new Order Request at stage `New`, linked to the matched/created Contact.

**REQ-ORD-007**: Each CSV row becomes one Order Request line in the exact shape established by `SPEC-ORD-002` (`category`, `itemSpec`, `orderVolumeQty`, `orderVolumeUnit`, `packingSpec`, `baseUom`, `baseQty`, `qtyStatus`, `sourceCountry`, `variantOption`) — no new line-level fields invented, reusing the schema exactly as it already exists. A row is skipped (not the whole Order Request) if both **Category** and **Item/Spec** are blank (mirrors `li` import's `if (!desc) skipped++`).

**REQ-ORD-008**: **Qty Status** in the CSV must be one of `Unknown`/`Estimated`/`Confirmed` (case-insensitive); blank or unrecognised values default to `Unknown` (the safe default — never silently assume a quantity is confirmed when the source data doesn't say so, consistent with `SPEC-ORD-002`'s design intent that `qtyStatus` is never auto-derived).

**REQ-ORD-009**: A downloadable CSV template (`TEMPLATES.ord`, mirroring `TEMPLATES.sup`/`li`/`inv`/`po`, `index.html:6263-6280`) and a new "Order Requests" step card in the Import Data tab (mirroring the existing Suppliers/Line Items/Invoices/POs cards, `index.html:484-506` pattern), wired to `bulkUpload('ord', this)` → `processImport('ord', csvText)`.

### Part B — Quote approval audit trail

**REQ-ORD-010**: Add three fields to the Quote record: `approvedBy` (string), `approvedReason` (string, optional), `approvedAt` (ISO timestamp).

**REQ-ORD-011**: The Quote modal gains two new fields — **Approved By** and **Approval Note** — that appear only when the Status dropdown (`qf-st`) is set to `Accepted`. **Approved By** is required whenever `saveQte()` is called with status `Accepted`; **Approval Note** is optional.

**REQ-ORD-012**: `approvedAt` is set to `new Date().toISOString()` **only the first time** a Quote's status transitions into `Accepted` (i.e. `existing.status !== 'Accepted'` before this save, mirroring how `createdAt` is set once and never overwritten). If the Quote is already `Accepted` and re-saved (e.g. to correct `approvedReason`), `approvedAt` is preserved from its original value, not refreshed.

**REQ-ORD-013**: `vQte()` (`index.html` — quote validation, exact line TBD in spec) gains a check: if the status being saved is `Accepted` and `approvedBy` is blank, block the save with a validation error (mirrors the existing `vErr()`/`vOk()` pattern used throughout the form).

## Acceptance Criteria

- AC-001: A CSV with 3 rows sharing one Submission ID and a Contact Email matching an existing Contact produces **one** Order Request with **3** lines, linked to that existing Contact (not a new one).
- AC-002: A CSV with a Contact Email that doesn't match any existing Contact creates a new Contact (`status: 'lead'`, `source: 'webform'`) and links the new Order Request to it.
- AC-003: Re-importing the same Submission ID with an added 4th row updates the existing Order Request to 4 lines, does not create a second Order Request.
- AC-004: A row with blank Category and blank Item/Spec is skipped; other rows in the same Submission ID still import.
- AC-005: A row with blank Contact Email is skipped entirely (not just the line).
- AC-006: `Qty Status` values `"confirmed"`, `"CONFIRMED"`, `""`, and `"garbage"` map to `Confirmed`, `Confirmed`, `Unknown`, `Unknown` respectively.
- AC-007: Saving a Quote with status `Accepted` and a blank Approved By field is blocked with a validation error.
- AC-008: Saving a Quote with status `Accepted` and a populated Approved By field succeeds, sets `approvedAt` to the current time.
- AC-009: Re-saving an already-`Accepted` Quote (editing only the Approval Note) leaves `approvedAt` unchanged from its original value.
- AC-010: A Quote never set to `Accepted` has `approvedBy`/`approvedReason`/`approvedAt` all absent/blank — no regression to the existing Draft/Sent/Declined/Expired flow.

## Explicitly Out of Scope

- The actual external "Stackd webpage" webform (hosting, public submission handling, its own backend) — a separate, larger initiative. This REQ only covers the CSV ingestion mechanism inside the existing portal.
- Any change to `qteToPoConvert()`'s existing `Accepted`-status gate logic — unchanged, this REQ only adds an audit trail alongside it.
- A stronger `CONFIRM`+reason typed-gate (like `ordAdminOverride()`'s pattern) for Quote acceptance — this REQ uses required-fields-on-save instead, judged sufficient for an audit trail; a harder gate can be a future escalation if needed.
- Any change-log for edits to `approvedReason` after the fact (only the first `approvedAt` is captured, not a full history of edits to the approval fields) — logged as a residual risk below.

## Residual Risks (logged, not blocking)

- No history of edits to `approvedBy`/`approvedReason` after the initial approval is captured — only `approvedAt` (first-transition timestamp) is protected from being overwritten. If a Quote is later re-accepted after being un-accepted and re-accepted (status round-trips through Draft/Sent and back to Accepted), `approvedAt` would update again on the second genuine transition — this is correct behavior (a fresh approval), not a bug, but worth stating explicitly.
- CSV-imported Contacts (`source: 'webform'`) get no enquiry log entry today — `saveCon()`'s manual-entry path appends to `enquiries[]`, but this CSV path does not (Order Request lines already capture the actual ask; duplicating it into the Contact's enquiry log was judged unnecessary for this REQ, logged here in case that's revisited).
