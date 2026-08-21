# REQ-CON-004-v2: AI-Assisted Enquiry Intake Check

**Supersedes:** REQ-CON-004-v1 (independent requirements-gate CONDITIONAL PASS — no factual errors found, but one reasoning gap: REQ-CON-004c asserted the `ORD_GAP_CHECK_PROMPT` minimization precedent transfers "not a new judgment call, a direct reuse" — but that precedent is safe *by construction*: Order Request lines structurally never contain name/email/phone fields, so there was nothing to accidentally leak. The Contact modal is qualitatively different — `ct-name`/`ct-email`/`ct-phone` sit directly adjacent to `ct-enq-summary` in the same form, and `saveCon()`'s own nearby object-construction code freely includes them, an easy pattern for a careless implementation of this REQ to copy by habit. v1's AC-004 (payload assertion test) partially mitigates this at merge time, but the requirement text itself should mandate the *implementation technique* that prevents the mistake, not just assert the outcome. Corrected below.)

## Business Context

Unchanged from v1. Extends `REQ-ORD-005`'s already-shipped semantic gap-check pattern one stage earlier, to raw enquiry text at Contact intake. `ct-enq-summary` and its `saveCon()` behavior independently re-verified this round as accurately described (field exists, feeds `Contact.enquiries[]` on both the dup-merge and normal save paths).

## FM-1 Assessment

Unchanged from v1. FM-1 category-1, no council decision required.

## Requirements

**REQ-CON-004a, REQ-CON-004b:** Unchanged from v1 (manual trigger, semantic-only check).

**REQ-CON-004c (corrected — mandates the technique, not just the outcome):** The API payload contains only the enquiry summary text (and, where useful, `company`) — this requirement is unchanged in *substance*, but is now explicit about *how* it must be implemented: **the payload object must be built as an explicit, minimal object literal listing only the fields being sent** (e.g. `{ summary: ..., company: ... }`), constructed independently of, and never by copying or trimming, the nearby full-Contact object literal `saveCon()` already builds for its own save path (`index.html`'s `con = { ..., name, email, phone, ... }` construction). **The `ORD_GAP_CHECK_PROMPT` precedent is a precedent for the *practice* of minimal, explicit payload construction — not evidence that this specific payload is automatically safe.** The Contact form's PII fields sit directly adjacent to the enquiry field being read, unlike Order Request lines, which never had PII fields to accidentally include in the first place; this REQ's implementer must treat that adjacency as a real risk to design against, not a solved problem inherited for free.

**REQ-CON-004d, REQ-CON-004e, REQ-CON-004f:** Unchanged from v1.

## GDPR Assessment

Corrected from v1's "not a new judgment call" framing: the minimization *goal* is identical to `REQ-ORD-005`'s, but achieving it here is not automatic the way it was there, precisely because this form has PII fields the Order Request line form never did. The requirement (REQ-CON-004c, above) is written to make the implementer construct the payload defensively rather than assume safety by analogy. AC-004 (below) remains the enforcement mechanism, now paired with a requirement that actually mandates the safe construction pattern rather than only testing its outcome after the fact.

## Acceptance Criteria

- AC-001 through AC-003, AC-005 through AC-007: unchanged from v1.
- AC-004 (unchanged assertion, now explicitly tied to REQ-CON-004c's corrected requirement): the captured request payload contains only the enquiry summary text and optionally `company` — never `name`, `email`, or `phone`, even when all three are already filled in on the same form at trigger time. This test is the enforcement backstop for REQ-CON-004c's construction-technique requirement, not a substitute for it.

## Open Questions for Spec-Gate

1, 2: unchanged from v1.
