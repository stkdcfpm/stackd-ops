# REQ-INTEG-001 (Phase 2) — Buyer-Approval Capture on Invoice

**Status:** v1 — first draft, check-first already complete (carried forward from this session's own prior investigation plus a fresh re-verification against `main` @ `93f71e6`, 538/538 tests passing).
**Builds on:** REQ/SPEC-INTEG-001-v2.md (Phase 1, shipped v2.9.58, `sourceQuoteId` later removed in v2.9.59 — see that REQ's §7 and the tracker's post-merge note).
**Scope:** Phase 2 of 4. Buyer-approval capture and a manual, non-binding Quote-link for audit trail only. No payment-request entity (Phase 3), no automation/email/AI action-block work (Phase 4).

---

## 1. Business context

The real-world flow, per the business: a Quote is raised, a PO is submitted, the buyer approves it out-of-band (email, WhatsApp, WeChat, verbally — never inside this app), and only then does the operator proceed to invoice. Today, nothing in the Invoice record captures *that this approval happened*, *how*, *by whom it was recorded*, or *when* — the Invoice simply sits at `Pro-forma` status with no distinguishable "buyer signed off" state. This phase adds that capture, plus a manual (never automatic, never required) way to record which Quote an Invoice traces back to, for audit-trail purposes only.

This phase does **not** dictate or enforce the underlying business process — it only lets the operator *record*, after the fact, that approval happened and by what channel, and *optionally* record which Quote the Invoice corresponds to. Nothing in this phase blocks invoicing, blocks status changes, or requires any of these fields to be filled in order to use the Invoice normally.

### 1.1 Facts established during check-first re-verification (against `main` @ `93f71e6`, 538/538 tests passing) that shape this REQ

- **`Sent` is a locked status with no dedicated trigger.** `LOCKED_STATUSES = ['Sent', 'Partially Paid', 'Paid', 'Cancelled']` (`index.html:2575`); once an Invoice's status is `Sent` the edit modal becomes read-only. `STATUS_ORDER = ['Draft', 'Pro-forma', 'Sent', 'Partially Paid', 'Paid', 'Cancelled']` (`index.html:2576`), enforced by `canTransitionStatus()` (`index.html:2580-2584`), a linear index comparison with `Cancelled` special-cased as reachable from any status. There is no button or automated path anywhere that sets status to `Sent` — it is set purely via the manual `<select id="inv-sm">` dropdown (`index.html:1061`) plus Save. **Consequence, already resolved with the user via `AskUserQuestion`:** "Progress to Invoicing" (item 4 below) does not change Invoice status at all — `Sent` logically means "emailed to the buyer," which precedes buyer approval, not follows it, so mapping this action onto a `Sent` transition would be semantically backwards.
- **Order Request has its own, separate transition-legality mechanism**, `ordCanTransition(fromStage, toStage)` (`index.html:2681-2683`), an explicit adjacency-map lookup against `ORD_TRANSITIONS` (`index.html:2671-2683`) — genuinely different from Invoice's `canTransitionStatus()` and never to be conflated with it. The precedent for a legality-gated Order Request stage-advance is `ordConvertToQuote()`'s guard at `index.html:10405`: `if (ordCanTransition(convOrd.stage, 'Quoted')) convOrd.stage = 'Quoted';` — never an unconditional assignment. This phase does not need to touch `ordCanTransition()` at all, since (per the design decision in §1.2) it does not advance any Order Request stage.
- **Quote already has a directly comparable "capture approval on action" precedent, and it is lighter than the checkbox-gated backup-confirmation pattern.** When a Quote's status dropdown (`id="qf-st"`, `index.html:2354-2357`) is set to `Accepted`, two previously-hidden fields are revealed inline in the same modal — `qf-approved-by-wrap`/`qf-approved-note-wrap` (`index.html:2359-2366`), toggled by `updQtePoBtn()` (`index.html:10070-10075`) — and `vQte()` (`index.html:10306-10312`) requires `qf-approved-by` to be non-empty before the Quote can be saved as `Accepted`. `saveQte()` (`index.html:10362-10384`) then writes `approvedBy`/`approvedReason`/`approvedAt` (the latter timestamped once, on first transition to `Accepted`, and preserved unchanged on every subsequent save while still `Accepted` — `wasAccepted`/`isAccepted` logic at `10360-10361`/`10381-10383`). This is a materially lighter, already-proven mechanism than the checkbox-gated "I have downloaded and verified the backup" modal pattern (`ov-migration-backup`/`ov-data-cleanup-backup`, `index.html:2440-2453`/`2480-2493`) — that heavier pattern exists specifically for irreversible bulk data operations (cloud migration, phantom-record cleanup) and is not used anywhere for approval-recording. **This REQ follows the Quote-acceptance precedent's weight, not the backup-modal's**, adapted into a small dedicated modal (see REQ-INTEG-001i) because — unlike Quote's `Accepted` — Invoice buyer-approval is not tied to any status-dropdown value (it must remain available while status stays `Pro-forma`, per this phase's own scope).
- **No dedicated per-Invoice Activity-tab UI exists.** Unlike Supplier/Contact (`renderSupActivity()`/`renderConActivity()`, filtering `DB.events` by `entityId`), Invoice lifecycle events are recorded via `logEv('invoice', ...)` (signature at `index.html:3261-3271`; existing call sites at `5561-5562`/`5556` for `created`/`status_changed`/`edited`) but never rendered per-record anywhere. This phase's new events (buyer-approval recorded, approval cleared by edit, Progress-to-Invoicing triggered) follow the same `logEv()` convention as the existing calls — they are captured in the data model, consistent with everything else on Invoice, even though no viewer exists yet. Building that viewer is not in this phase's scope (see §4).
- **`saveInv()` reconstructs the whole `inv` object from form fields on every save** (`index.html:5439-5458`), then, for an existing record, runs a further preserve/patch block (`if(EI.i){...}`, `5469-5488`) that explicitly carries forward fields not present in the fresh literal — e.g. `inv.pos=existing.pos||[];` (`5473`). **Consequence, load-bearing for this REQ, directly the same class of bug Phase 1's `saveQte()` allowlist finding was about:** none of this phase's new fields (`buyerApprovedAt`, `buyerApprovedBy`, `approvalMethod`, `approvalNote`, `linkedQuoteId`, `linkedQuoteNum`) appear in the base literal (`5439-5458`) at all. Every one of them must be explicitly defaulted and explicitly preserved inside the `if(EI.i){...}` block, mirroring `inv.pos`'s exact pattern, or a normal Save on an already-approved Invoice will silently wipe the approval the very next time the operator edits anything else on it.
- **No Quote → Invoice conversion path exists** (re-confirmed, third time this session, no new evidence contradicting Phase 1's finding at `REQ-INTEG-001-v2.md` §1.1). **No PO record carries both a `quoteId` and an `invId`** — `qteToPoConvert()` (`index.html:10640` onward) sets `quoteId`/`quoteNum`, `autoPos()` (`index.html:5585` onward) sets `invId`/`invNum`; neither function's object literal contains the other pair. **Consequence:** there is no automatic, PO-mediated path from an Invoice back to a Quote in the common case. The only real, already-working link in the codebase that connects a Quote to anything upstream is Order Request → Quote via `ord.activeQuoteId` (set at `index.html:2760`, `3231`, `10405`, read at `2698`, `3189`). This phase's Quote-link (REQ-INTEG-001k) is therefore necessarily a **manual selection from the full Quote list**, not a derived/automatic lookup — there is no live chain to derive it from.
- **Invoice has a `buyer`/`buyerId` field** (`G('if-b').value`, resolved to `DB.buy` — `index.html:5440`); **Quote has a free-text `client` field** (`G('qf-client').value.trim()`, `index.html:10365`), not a `buyerId`. There is no structural guarantee these match for the same real-world counterparty (a Quote's `client` is free text, entered independently of the Buyer list). Any convenience filtering of the Quote dropdown by buyer name is therefore a best-effort UX aid only, never a hard constraint — the operator must always be able to pick any Quote, matching the user's explicit "does not dictate the process" instruction.

### 1.2 Design decisions carried into this REQ

1. **Approval method is a closed-set dropdown**, not free text (resolved directly by the user in the brief; confirmed there is no shipping-cost difference between a `<select>` and a `<input>` in this codebase's pattern, so the more reportable closed-set option is used with no downside). Closed set: `Email`, `WhatsApp`, `WeChat`, `Phone / Verbal`, `Other`. `Other` requires `approvalNote` to be non-empty (mirrors `vQte()`'s existing pattern of conditionally requiring a field based on another field's value, `index.html:10309-10310`).
2. **"Progress to Invoicing" causes no Invoice status change of any kind** (resolved via `AskUserQuestion`, user selected "No status change at all," per §1.1's `Sent`-semantics finding). It is purely an audit-trail action: it logs an authorization event and, optionally, records a manual Quote-link.
3. **Editing an Invoice's line items after buyer approval automatically clears the approval** (`buyerApprovedAt`, `buyerApprovedBy`, `approvalMethod`, `approvalNote` all reset to empty), forcing re-approval — an explicit, hard instruction from the user, citing the financial stakes of proceeding on stale-approved numbers. This phase does **not** implement a warn-but-allow variant; that was explicitly ruled out without further confirmation needed.
4. **The Quote-link (item 4c) is a real schema field with a manual, optional dropdown selection at "Progress to Invoicing" time — not a log-entry-only text reference.** This is a design decision made by Claude to resolve an ambiguity the user's own freeform answer left open (see below), and it is called out here explicitly for requirements-gate and for the user to challenge if this reads the brief too broadly.

   The user's own words, in full: *"can we build in a stage that once and only manually updated it allows the progression to invoice, but this does not dictate the process... a user can update the state to Progress to invoicing at which point the link is determined to the quote that is linked to the invoice for the correct audit trail, perhaps force a dropdown of reasons for approval, email, social verbal etc and user credentials time and date recorded too."* Two readings are both defensible from this text: (a) a real `linkedQuoteId` field, populated via a dropdown, so the link is queryable/reportable data — the reading used here — or (b) a narrower log-line that just mentions a Quote reference in the event summary text, with no new schema field and no dropdown-driven lookup. Reading (a) is used because the user's phrasing — *"the link is determined,"* not *"the link is noted"* or *"the link is described"* — reads as establishing a real, structural link, consistent with how every other traceability field in Phase 1 (`sourceOrdId`, `sourceRfqResponseId`, `sourceInvUp`) was built as real schema fields rather than free-text log mentions, and consistent with "for the correct audit trail" implying something a future report or Invoice-detail view could query, not just a sentence buried in an event log nobody currently has a UI to read (§1.1, no per-Invoice Activity tab exists yet). **This is the one open item this REQ asks the user to confirm or correct before Phase 2 proceeds past requirements-gate** — if the narrower reading (b) was intended instead, REQ-INTEG-001k below is replaced with a single sentence: `logEv()`'s summary text for the Progress-to-Invoicing event includes a free-typed Quote reference, no schema field, no dropdown.

---

## 2. Requirements

### REQ-INTEG-001h — Invoice buyer-approval fields (schema)
Add four new fields to the Invoice record shape built in `saveInv()` (`index.html:5439-5458`):
- `buyerApprovedAt` — ISO timestamp, set once, on the transition from not-approved to approved (mirrors Quote's `approvedAt` semantics at `index.html:10381-10383`, i.e. not re-stamped on every subsequent save while still approved).
- `buyerApprovedBy` — free text, the name/identifier of who confirmed the approval was received (required at the point of setting — see REQ-INTEG-001i).
- `approvalMethod` — one of the closed set in §1.2 item 1.
- `approvalNote` — free text, optional except when `approvalMethod === 'Other'` (§1.2 item 1).

All four default to `''` (or unset/falsy) on a brand-new Invoice, and — per §1.1's `saveInv()` finding — must be explicitly preserved from the existing record inside the `if(EI.i){...}` block (`5469-5488`) on every edit-save that isn't itself the approval action or the clearing trigger (REQ-INTEG-001j), exactly mirroring `inv.pos=existing.pos||[];`'s pattern (`5473`).

### REQ-INTEG-001i — "Mark Buyer Approved" UI action
A dedicated action, available only when the Invoice's current status is `Pro-forma` (per the brief's own scope — not `Draft`, not `Sent` or later), opens a small confirmation modal (new, e.g. `ov-inv-approve`) containing:
- Approval Method — the closed-set dropdown from §1.2 item 1 (required).
- Approved By — free text (required; mirrors `vQte()`'s existing "Approved By is required when status is Accepted" validation pattern, `index.html:10309-10310`).
- Approval Note — free text (required only when Method is `Other`, otherwise optional).
- A "Mark Buyer Approved" confirm button, disabled until Method and Approved By are both filled (Note as well, when Method is `Other`).

On confirm: sets `buyerApprovedAt` (now), `buyerApprovedBy`, `approvalMethod`, `approvalNote` on the Invoice; saves; logs `logEv('invoice', inv.id, 'buyer_approved', <summary including method and approver>, 'operator')`. This is a distinct, one-shot data-entry action, not a form field silently saved alongside everything else on the main Save button — it does not require the operator to also click "Save Invoice" separately (matching the Quote-acceptance precedent's single-save behavior, but via its own modal since it isn't gated by a status-dropdown value).

If the Invoice already has `buyerApprovedAt` set (i.e. re-opening this action on an already-approved Invoice, before any line-item edit has cleared it — see REQ-INTEG-001j), the modal pre-fills the existing values and re-confirming overwrites them with a new timestamp and a new `logEv()` entry — approval can be corrected/re-recorded without first triggering a line-item edit.

### REQ-INTEG-001j — Approval is cleared by a line-item edit (fixes the stale-approval risk named in the brief)
Inside `saveInv()`'s existing-record branch (`5469-5488`), compare the invoice's **line items only** (`rid`/`lid`/`qty`/`up`/`desc` — the same fields already compared for the unrelated G-06 edit-delta at `5545-5553`, reused here rather than inventing a second comparison) between `existing.lineItems` and the freshly-built `inv.lineItems` for this save. If they differ **and** `existing.buyerApprovedAt` was set, clear all four approval fields (`buyerApprovedAt`, `buyerApprovedBy`, `approvalMethod`, `approvalNote`) on the record being saved, and log `logEv('invoice', inv.id, 'approval_cleared', 'Buyer approval cleared — line items changed after approval', 'operator')`.

This must be a genuine line-item comparison, not a timestamp/`updAt` check — the same principle Phase 1's §1.2 design decision established for PO/Quote staleness, applied here to the approval fields. An edit that touches only header fields (Incoterm, payment terms, shipping notes, etc.) with no line-item change must **not** clear an existing approval — this is the explicit "no warn-but-allow, but also no false-positive clearing on unrelated edits" balance the user's brief requires.

If the Invoice was not previously approved (`existing.buyerApprovedAt` is empty), this check is a no-op — nothing to clear, no log entry.

### REQ-INTEG-001k — "Progress to Invoicing" action (manual Quote-link, no status change)
A dedicated action, available only when the Invoice's current status is `Pro-forma` **and** `buyerApprovedAt` is set (approval must be recorded first — the business sequence per the user's own example is Quote → PO → buyer approval → Progress to Invoicing, in that order). Opens a small modal offering:
- An optional Quote-selection dropdown, listing Quotes from `DB.qt` (most recent first), best-effort pre-filtered to those whose `client` text matches the Invoice's `buyer` name where a match exists, but never restricted to only matches — the full list is always reachable, and a "— none / not applicable —" option is always the default (§1.1's last bullet: this is a manual, non-authoritative aid, not a hard filter).
- A "Progress to Invoicing" confirm button. Selecting a Quote is optional; the action proceeds identically whether one is selected or not.

On confirm: if a Quote was selected, sets `linkedQuoteId`/`linkedQuoteNum` on the Invoice (new fields, added alongside REQ-INTEG-001h in `saveInv()`'s literal and preserve block, defaulting to `''`/unset); regardless of whether a Quote was selected, logs `logEv('invoice', inv.id, 'progressed_to_invoicing', <summary noting the linked Quote num, or "no Quote linked" if none selected>, 'operator')`. **No Invoice status field changes** (§1.2 item 2). This action can be re-run (e.g. to correct a wrongly-selected Quote or add a link that was skipped the first time) — each run logs its own event and the stored `linkedQuoteId`/`linkedQuoteNum` reflect the most recent selection.

This action does **not** advance any Order Request's `stage`, does not touch `ordCanTransition()`/`ORD_TRANSITIONS`, and does not require or check that the selected Quote has any particular status — it is an audit-trail annotation only, never a workflow gate.

### REQ-INTEG-001l — FM-1 compliance confirmation
All six new fields (`buyerApprovedAt`, `buyerApprovedBy`, `approvalMethod`, `approvalNote`, `linkedQuoteId`, `linkedQuoteNum`) are new fields on the existing Invoice entity, with no new Sheets sync mapping. `FIELD_MAPS.inv` (`index.html:3799`) already omits other local-only Invoice fields with no precedent issue (Phase 1's now-removed `sourceQuoteId` was itself an example; `pos` is another, `index.html:5473`). **Confirmed: this phase requires no `FIELD_MAPS` change, no new Apps Script tab, no new `syncEnt` key** — the same FM-1 exception category Phase 1 already established (REQ-INTEG-001-v2.md §2, REQ-INTEG-001d) applies unchanged.

---

## 3. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A brand-new Invoice | Saved | All six new fields are present and empty/falsy |
| AC-2 | An Invoice at `Pro-forma` status, not yet approved | "Mark Buyer Approved" is used with Method=`Email`, Approved By="J. Smith" | `buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod` are set correctly, `approvalNote` is empty, a `buyer_approved` event is logged |
| AC-3 | The same as AC-2, but Method=`Other` and no note entered | The confirm button is clicked | Blocked — Approval Note is required when Method is `Other` |
| AC-4 | An Invoice at `Draft` or `Sent` status | The Invoice modal is open | "Mark Buyer Approved" is not available |
| AC-5 | An already-approved Invoice (per AC-2) | Its header fields (e.g. Incoterm) are edited and saved, with no line-item change | All four approval fields are unchanged, no `approval_cleared` event is logged |
| AC-6 | An already-approved Invoice | A line item's quantity or unit price is changed and saved | All four approval fields are cleared to empty, an `approval_cleared` event is logged |
| AC-7 | An already-approved Invoice | A line item is added or removed and saved | Same as AC-6 — approval is cleared |
| AC-8 | An Invoice that was never approved | Its line items are edited and saved | No `approval_cleared` event is logged (nothing to clear — no-op per REQ-INTEG-001j's last paragraph) |
| AC-9 | An approved Invoice at `Pro-forma` status | "Progress to Invoicing" is used with no Quote selected | `linkedQuoteId`/`linkedQuoteNum` remain empty, a `progressed_to_invoicing` event is logged noting no Quote was linked, Invoice status is unchanged |
| AC-10 | The same, but a Quote is selected | "Progress to Invoicing" is used | `linkedQuoteId`/`linkedQuoteNum` are set to the selected Quote, the event log reflects it, Invoice status is unchanged |
| AC-11 | An Invoice not yet approved (`buyerApprovedAt` empty) | The Invoice modal is open | "Progress to Invoicing" is not available |
| AC-12 | An Invoice already progressed to invoicing with a linked Quote (AC-10) | "Progress to Invoicing" is run again with a *different* Quote selected | `linkedQuoteId`/`linkedQuoteNum` update to the new selection, a second `progressed_to_invoicing` event is logged (the first is not deleted/overwritten in the log) |
| AC-13 | The full existing test suite (538/538 as of this REQ's check-first pass — re-confirm the actual count at build time) | This phase is built | All pre-existing tests still pass unchanged — no regression to `saveInv()`, `autoPos()`, or the G-05/G-06 event-logging paths this phase touches |
| AC-14 | A Quote-link dropdown opened for an Invoice whose `buyer` text matches no Quote's `client` text | "Progress to Invoicing" modal is opened | The dropdown still lists all Quotes (no false-empty state), with the "— none —" option as default |

---

## 4. Explicitly out of scope

- Any Invoice status change of any kind from either new action (§1.2 item 2).
- A payment-request entity or action (Phase 3).
- Any automation, email, or AI action-block work referencing these new fields (Phase 4). The AI Assistant's `create_invoice` action is not modified in this phase.
- A warn-but-allow variant of REQ-INTEG-001j — clearing on edit is mandatory, not optional, per explicit user instruction.
- Advancing any Order Request `stage` or touching `ordCanTransition()`/`ORD_TRANSITIONS` from either new action.
- Building a per-Invoice Activity-tab viewer for the new `logEv()` entries (§1.1) — the events are captured, consistent with all other Invoice lifecycle events, but no new UI surface renders them in this phase.
- Retroactive backfill of any of the six new fields onto Invoices created before this phase ships — they simply read empty, as with every prior phase's new fields.
- Enforcing that a Quote selected in REQ-INTEG-001k actually belongs to the same buyer, or has any particular status — the dropdown is convenience-filtered, never hard-constrained, and no validation blocks an "unrelated" selection; this is a deliberately non-authoritative audit annotation.

---

## 5. Open questions for spec-gate (and one for the user)

1. **For the user, ahead of/at spec-gate:** confirm or correct the §1.2 item 4 reading — a real `linkedQuoteId` field with a dropdown (as specified in REQ-INTEG-001k), or the narrower log-line-only alternative. This REQ proceeds on the broader reading unless corrected.
2. Exact modal styling/placement for `ov-inv-approve` and the Progress-to-Invoicing modal — left to spec-gate, this REQ mandates the fields and validation, not pixel-level layout.
3. Exact wording of the `logEv()` summaries for `buyer_approved`, `approval_cleared`, and `progressed_to_invoicing` — left to spec-gate, consistent with existing event-summary phrasing style (`5556`, `5561-5562`).
4. Whether the "Mark Buyer Approved" and "Progress to Invoicing" buttons live in the main Invoice modal's action row (alongside Save/Preview) or in a separate location (e.g. an overflow menu) — left to spec-gate as a UI-placement decision, not a requirements question.

---

## 6. Test plan (maps to §3)

New tests required, at minimum, one per acceptance criterion (AC-1 through AC-14). Existing tests covering `saveInv()`, `autoPos()`, and the G-05/G-06 event-logging call sites must be re-run and confirmed unaffected, not merely assumed unaffected.
