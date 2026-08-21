# REQ-CON-004-v1: AI-Assisted Enquiry Intake Check

## Business Context

Extends an already-shipped, already-proven pattern to an earlier stage of the pipeline, rather than inventing a new AI-usage shape. `ordCheckLineGapsSemantic()` (`index.html:2684` onward, `REQ-ORD-005`, shipped v2.9.50) already does exactly this kind of check — a single-shot, non-conversational, tightly-scoped Anthropic API call that flags ambiguous/incomplete text and phrases a specific clarifying question — but only at the Order Request *line* stage, after an enquiry has already been structured into `category`/`itemSpec`/`baseUom` fields.

The actual point of failure is earlier: a raw enquiry is first captured as free text in `Contact.enquiries[]`, via the `ct-enq-summary` textarea in `saveCon()` (`index.html:9477-9509`, specifically `enqSummary`/`enqs.push(...)`). Nothing checks that text for ambiguity or missing detail *at intake* — by the time `REQ-ORD-005`'s check can run, the enquiry has already been manually restructured into an Order Request, and any vagueness in the original ask has either been resolved by the operator already or silently carried forward unexamined.

This REQ adds the same class of check one stage earlier: at the point an enquiry is first typed in, not after it's already been turned into structured Order Request lines.

## FM-1 Assessment

No new `K`/`DB` entity, no new field — `Contact.enquiries[]` already exists and already stores exactly what this REQ reads (the `summary` text). No new Sheets sync mapping — this check is transient (rendered on trigger, not persisted), the same non-persistence property `REQ-ORD-005` already established for its own gap-check output. FM-1 category-1, same precedent as `REQ-ORD-005` itself. No council decision required.

## Requirements

**REQ-CON-004a (manual trigger, not automatic):** A "Check enquiry" button appears next to the `ct-enq-summary` textarea in the Contact modal (`saveCon()`'s form, `index.html` — the same modal, not a new one). Never runs automatically on save, on typing, or on a timer — matching `REQ-ORD-005b`'s explicit manual-trigger requirement and rationale (a live-as-you-type check would be noisy and costly; a deliberate check-before-send action is the correct shape here too).

**REQ-CON-004b (semantic check only — no structural check, unlike `REQ-ORD-005`):** Unlike the Order Request line check, there is no equivalent "structural" gap check here — `enquirySummary` is a single free-text field, not a set of named fields that can individually be present/absent. This REQ is semantic-only: a single-shot Anthropic API call, using a new bespoke prompt (`CON_ENQUIRY_CHECK_PROMPT`, not `AI_SYSTEM_PROMPT`/`AI_COMPLIANCE_PROMPT`/`ORD_GAP_CHECK_PROMPT`), flagging vagueness or missing commercial detail (e.g. no quantity mentioned, no indication of destination market, a product description too generic to source against) and phrasing each as a specific question the operator could send back to the prospect.

**REQ-CON-004c (GDPR payload scoping — reusing the exact precedent, not a new decision):** The API payload contains **only** the enquiry summary text itself (and, where useful for context, `company` if already typed in the same form) — never `name`, `email`, or `phone`, even though they're on the same form and already filled in when this button is likely to be clicked. This is the identical minimization rule `ORD_GAP_CHECK_PROMPT` already established (`index.html:2684`, excluding `contactId` and resolved Contact PII) — not a new judgment call, a direct reuse of an already-reviewed precedent.

**REQ-CON-004d (fallback on AI failure, identical to `REQ-ORD-005d`):** If the call fails (missing `AI.key`, network error, non-200, malformed response), the UI shows "unavailable" — never blocks the operator from saving the Contact/enquiry regardless of whether the check ran, succeeded, or failed. This check is advisory only, exactly like its Order Request precedent.

**REQ-CON-004e (no persistence, no field mutation):** The check's output is rendered transiently near the button on trigger — never written to `Contact.enquiries[]`, never saved, never synced. Re-triggering (e.g. after the operator edits the summary text in response to a flagged issue) replaces the prior output; nothing accumulates. Matches `REQ-ORD-005e`'s identical requirement for its own output.

**REQ-CON-004f (no change to existing dedup/merge behavior):** `saveCon()`'s existing duplicate-email merge-or-create-separate flow (`index.html:9487-9502`) is unchanged — this REQ adds a pre-save advisory check, it does not alter what happens when the operator actually clicks Save.

## GDPR Assessment

Favorable, directly inherited from `REQ-ORD-005`'s already-reviewed pattern, not reassessed from scratch: the API payload is scoped to the enquiry text (and optionally company name), explicitly excluding the personal-data fields (`name`/`email`/`phone`) present on the very same form. No new field, no new persistence, no new external data flow beyond the same Anthropic API call pattern this app already makes elsewhere with the operator's own configured key (`SEC-GAP-003`, an accepted, unchanged constraint).

## Acceptance Criteria

- AC-001: Clicking "Check enquiry" on a deliberately vague summary (e.g. "interested in fridges") returns at least one flagged issue with a specific suggested question, when `AI.key` is configured.
- AC-002: Clicking "Check enquiry" on a detailed, unambiguous summary (product, quantity, destination all present) returns an empty/no-issues result.
- AC-003: With no `AI.key` configured, or a simulated fetch failure, the UI shows "unavailable" — no thrown error, Save remains fully usable regardless.
- AC-004: The captured request payload (asserted via a mocked `fetch` call, same technique used for `REQ-ORD-005`'s equivalent test) contains only the enquiry summary text and optionally `company` — never `name`, `email`, or `phone`, even when all three are already filled in on the same form at trigger time.
- AC-005: Triggering the check does not mutate `DB.con` — confirmed via a before/after snapshot assertion, matching `REQ-ORD-005`'s equivalent AC-005.
- AC-006: Re-triggering after editing the summary text reflects only the current text — no stale prior output carried over.
- AC-007: The existing duplicate-email merge/create-separate confirm flow in `saveCon()` is unaffected — a regression test confirming this REQ's addition doesn't alter that path's behavior.

## Open Questions for Spec-Gate

1. Should the check also run (or be offered) on the `enquirySummary` captured via the CSV/webform intake paths (`processImport()`'s `co`/`ord` branches, `REQ-ORD-003`/`REQ-CON-002`), or is this REQ's scope limited to the manual single-Contact modal entry point only? Recommend limiting to the manual entry point for this REQ — batch-checking every row of a CSV import against a live API call is a different cost/UX shape, worth its own REQ if wanted later, not assumed in scope here.
2. Whether flagged issues should be linkable directly into a "send this question" action (email/reminder) or remain purely informational text the operator copies manually — this REQ specifies informational only, matching `REQ-ORD-005`'s same choice for its own output; escalating to an action is a larger scope decision for a future REQ if wanted.
