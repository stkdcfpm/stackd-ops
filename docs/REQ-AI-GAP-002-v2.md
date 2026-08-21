# REQ-AI-GAP-002-v2: AI-Assisted Invoice/Line Item/Credit Note Creation + Supplier/Buyer Read Tools

**Supersedes:** REQ-AI-GAP-002-v1 (independent requirements-gate CONDITIONAL PASS — one blocking finding: REQ-AI-GAP-002d claimed "Description, Supplier, UOM, Cost required at minimum, matching `vLI()`'s existing validation," but `vLI()` (`index.html:6294-6311`) only hard-requires Description and Supplier — Cost is format-checked only if non-empty (empty passes), and UOM has no validation at all anywhere in the function. The requirement was built on a factual error about its own reference implementation. Two advisory items also addressed: the `get_pos` vocabulary-bug citation was off by five lines (content correct, line number wrong), and a genuine but non-blocking capability-gap tension — `get_suppliers`/`get_buyers` deliberately omitting email/phone means the AI can't fulfil a request like "email this supplier" using these tools — is now noted explicitly rather than left implicit. Resolved below.)

## Business Context

Unchanged from v1. Closes `AI-GAP-006` and `AI-GAP-008`, both re-verified against current code: `handleAIAction()` (`index.html:7685-7758`) confirmed to have exactly the seven branches claimed, `create_po`'s `supId` dead-end confirmed live, and the `get_pos` vocabulary bug confirmed live and real (independently re-verified this round too — see REQ-AI-GAP-002f below).

## FM-1 Assessment

Unchanged from v1. FM-1 category-1, no council decision required.

## Requirements

**REQ-AI-GAP-002a, REQ-AI-GAP-002b:** Unchanged from v1 (`get_suppliers`/`get_buyers` read tools, minimization to `id`/`num`/`name`/`country`-or-`currency`).

**REQ-AI-GAP-002c:** Unchanged from v1 (`create_invoice`, all four documented blockers — `#if-n`, Incoterm/Payment Terms, ≥1 line item, `isCN(num)` distinctness — independently re-verified this round as accurate, not invented or mischaracterized).

**REQ-AI-GAP-002d (corrected — accurate minimum field set):** New branch, resolving `supId` via `get_suppliers` (REQ-AI-GAP-002a) the same way REQ-AI-GAP-002c resolves `buyId`. **Corrected minimum field set, matching `vLI()`'s actual current validation (`index.html:6294-6311`), not the v1 REQ's mistaken claim:** only **Description** (`index.html:6300`) and **Supplier** (`index.html:6302`) are hard-required — the AI action must not treat Cost or UOM as blocking. Cost, if provided, must be format-valid (non-negative, ≤2 decimal places) but an omitted Cost is valid and must pass through unchanged (`index.html:6303-6305` — the check is skipped entirely when the field is empty). UOM has no validation in `vLI()` at all and the action must not invent a requirement for it. This is a deliberate correction, not a loosening for convenience — the action's validation must match the form it pre-fills, not a stricter standard the REQ mistakenly assumed existed.

**REQ-AI-GAP-002e:** Unchanged from v1 (`create_credit_note`, distinct action type).

**REQ-AI-GAP-002f (corrected citation only, fix unchanged):** `get_pos`'s tool vocabulary string is at `index.html:7801` (corrected from v1's `index.html:7796`, which is the tool's general `description` opening line, not the field containing the stale status list). Fix unchanged: replace `Confirmed, In Production, Shipped, Completed` with the real `Deposit Paid, Settled` values matching the live `#po-sm` dropdown (`index.html:1983`).

## GDPR Assessment

Unchanged in substance, one tension made explicit rather than left implicit: REQ-AI-GAP-002a/b's minimization (excluding `email`/`phone`/`contactName` from tool results, even though those fields exist — `index.html:934` for Supplier email, `index.html:2177` for Buyer email) is the correct choice for these tools' stated purpose (resolving a name to an ID for action payloads), but it does mean the AI **cannot** use `get_suppliers`/`get_buyers` to fulfil a request like "what's this supplier's email" or "email this buyer" — those fields simply aren't in the tool result. This is not a defect in this REQ's scope (which is ID resolution, not contact lookup), but it should be understood as a real capability boundary, not silently discovered later when an operator asks and the AI can't answer. If contact-lookup capability is wanted, that's a separate, explicitly-scoped REQ with its own GDPR assessment for why returning PII through a tool call is justified there — not assumed here.

## Acceptance Criteria

- AC-001 through AC-005, AC-007: unchanged from v1.
- AC-006 (corrected): `create_line_item`'s handler resolves `supId` via a `get_suppliers`-style lookup exactly as `create_invoice` resolves `buyId`. **Additionally** (new, closing the v1 gap): a `create_line_item` payload with Description and Supplier only (no Cost, no UOM) is accepted and pre-fills the modal correctly — not rejected, not silently defaulted to invented values. A payload missing Description or Supplier is rejected (clarifying question), matching `vLI()`'s actual required-field set exactly.
- AC-008: unchanged from v1, citation corrected to `index.html:7801`.

## Open Questions for Spec-Gate

1. Unchanged from v1 — clarifying-question phrasing/UX for zero/multiple name-lookup matches.
2. **Corrected from v1** (v1's question assumed UOM/Cost were required minimums, which this version corrects): whether `create_line_item` should proactively prompt for HS code even though it's optional in `vLI()`, given HS code matters for duty calculation elsewhere in the app — a UX judgment call for spec-gate, not a validation requirement.
