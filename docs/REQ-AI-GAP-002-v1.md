# REQ-AI-GAP-002-v1: AI-Assisted Invoice/Line Item/Credit Note Creation + Supplier/Buyer Read Tools

## Business Context

Closes two already-logged, still-open gaps rather than proposing something new: `AI-GAP-006` ("Three of nine creatable entities still not supported by `handleAIAction()` pre-fill") and `AI-GAP-008` ("`create_po` requires an internal `supId`; AI cannot resolve a newly-created (unsaved) supplier by name"). Both were re-verified directly against the current code (`index.html`, post-`v2.9.52`) while scoping this REQ, not assumed from the gap log alone:

- `handleAIAction()` (`index.html:7685-7758`) has exactly seven branches today: `create_po`, `create_quote`, `create_shipment`, `create_contact`, `create_supplier`, `create_buyer`, `update_order_line`. No `create_invoice`, `create_line_item`, or `create_credit_note` branch exists — `AI-GAP-006` is confirmed still open, unchanged since it was logged.
- `create_po`'s handler reads `p.supId` directly (`index.html:7688-7689`) — a raw internal ID, with no lookup mechanism anywhere in `AI_TOOLS` (`index.html:7761-7802`) to resolve a supplier name to that ID. `AI-GAP-008`'s dead-end is confirmed live: today, if an operator says "create a supplier, then a PO for them" in one conversation, the AI has no way to discover the new supplier's `id` after the human saves it.
- A related, previously-logged-but-still-unfixed defect found while re-verifying this area: `AI-GAP-009` ("`AI_SYSTEM_PROMPT`'s PO status vocabulary does not match the live dropdown") is not just a prose problem in `AI_SYSTEM_PROMPT` — the `get_pos` tool's own `description` field (`index.html:7796`, sent to the model exactly like system-prompt text) still says PO status is `"Draft, Sent, Confirmed, In Production, Shipped, Completed"`. The real, live `#po-sm` dropdown values are `Draft, Sent, Deposit Paid, Settled, Cancelled` (per `AI-GAP-009`'s original finding, re-confirmed here). Folded into this REQ since it's in the exact same code region being touched.

This REQ addresses the requested "account creation" clarification directly: Buyer and Contact (business-record) creation are **already built** (`create_buyer`, `create_contact`) and functioning — the requested enhancement is not a new action type there, it's making Buyer/Supplier creation-and-reference *robust* by closing the same name-resolution gap that currently blocks `create_po`, so a conversational flow like "create this buyer, then quote them" or "create this supplier, then add their product to the catalogue" doesn't dead-end.

## FM-1 Assessment

No new `K`/`DB` entity, no new field on any existing entity, no new Sheets sync mapping. New `AI_TOOLS` entries and new `handleAIAction()` branches are UI/AI-layer additions only, reusing entities and validation that already exist — the same category as the original `create_supplier`/`create_buyer` additions (`AI-GAP-006`, shipped v2.9.41). FM-1 category-1. No council decision required.

## Requirements

**REQ-AI-GAP-002a (`get_suppliers` read tool):** A new `AI_TOOLS` entry, filterable by name (partial, case-insensitive) — mirroring `get_pos`'s existing `supplier` filter pattern (`index.html:7794-7801`). Returns `id`, `num`, `name`, `country`, `currency` per match — enough to resolve a name to an `id`, deliberately not `contact`/`email`/`phone` (payload minimization, matching this REQ's own GDPR posture below).

**REQ-AI-GAP-002b (`get_buyers` read tool):** Same shape as REQ-AI-GAP-002a, for `DB.buy`. Returns `id`, `num`, `name`, `currency` — deliberately excludes `contactName`/`email`/`phone`/`creditLimit` from the tool result for the same minimization reason.

**REQ-AI-GAP-002c (`create_invoice` action, with its documented blockers explicitly handled, not waved past):** New `handleAIAction()` branch and `AI_TOOLS`/action-block prompt entry. Must resolve `buyId` via a name lookup against `get_buyers` (REQ-AI-GAP-002b) — the AI is instructed to call `get_buyers` first if the payload would otherwise need a raw `buyId` the conversation hasn't established, falling back to a clarifying question if no match is found (never inventing a `buyId`). Per `AI-GAP-006`'s own documented blockers, all reconfirmed against current code before being carried into this requirement:
  - Must **not** set `#if-n` (invoice number) — `nextInvNum()` already auto-generates it on modal open; the payload must omit it entirely.
  - Incoterm and Payment Terms are hard-required fields with no natural AI default — if the conversation hasn't specified them, the AI must ask, not guess.
  - At least one line item is required — an empty `lineItems[]` payload is rejected before opening the modal (a clarifying question instead), not silently pre-filled empty.
  - The invoice modal also handles Credit Notes via its `isCN(num)` branch — `create_invoice`'s payload/handler must not collide with that path (verified distinct from REQ-AI-GAP-002e below).

**REQ-AI-GAP-002d (`create_line_item` action):** New branch, resolving `supId` via `get_suppliers` (REQ-AI-GAP-002a) the same way REQ-AI-GAP-002c resolves `buyId` — this is the concrete fix `AI-GAP-006`'s own text already anticipated ("now that `create_supplier` exists, the AI could in principle create the missing supplier first... then the line item" — this REQ is what makes that actually work, by giving the AI a way to look up the ID afterward). Description, Supplier, UOM, Cost required at minimum, matching `vLI()`'s existing validation.

**REQ-AI-GAP-002e (`create_credit_note` action, distinct action type, not a `create_invoice` variant):** Per `AI-GAP-006`'s existing analysis, a Credit Note requires either (a) a positive credit amount + a linked, existing invoice number, or (b) the goodwill checkbox — a materially different validation shape from a standard invoice, sharing the same modal but not the same rules. This REQ implements it as its own `handleAIAction()` branch and action key, not an overloaded `create_invoice` payload variant.

**REQ-AI-GAP-002f (fix the live `AI-GAP-009` vocabulary bug in `get_pos`):** `get_pos`'s tool `description` (`index.html:7796`) is corrected to state the real PO status vocabulary — `Draft, Sent, Deposit Paid, Settled, Cancelled` — replacing the stale `Confirmed, In Production, Shipped, Completed` list that doesn't exist in the live `#po-sm` dropdown. Small, but explicitly in scope since this REQ is already touching this exact code region and the defect is confirmed still live.

## GDPR Assessment

Favorable, by design. The two new read tools (REQ-AI-GAP-002a/b) deliberately return only enough fields to resolve a name to an ID (`id`, `num`, `name`, `country`/`currency`) — not `email`/`phone`/`contactName`, even though those fields exist on the underlying records and are already visible to the same authenticated operator elsewhere in the app. This mirrors the exact minimization precedent already established for `ORD_GAP_CHECK_PROMPT` (`index.html:2684`, scoped to 10 named fields, explicitly excluding `contactId` and resolved Contact PII). No new field is introduced anywhere; every entity these actions create already exists and is already reachable by the same operator through the ordinary UI.

## Acceptance Criteria

- AC-001: `get_suppliers({name: "Jinbao"})` against a fixture containing a matching supplier returns exactly `id`/`num`/`name`/`country`/`currency` — no `contact`, `email`, or `phone` field present in the tool result.
- AC-002: `get_buyers({name: "Apex"})` returns exactly `id`/`num`/`name`/`currency` — no `contactName`, `email`, `phone`, or `creditLimit`.
- AC-003: A `create_invoice` payload with no `buyId` but a `buyer` name matching an existing Buyer resolves correctly when the AI has called `get_buyers` in the same turn sequence (integration test simulating the tool-call → action-block flow).
- AC-004: A `create_invoice` payload is rejected (surfaces a clarifying-question path, not a pre-filled-empty modal) when `lineItems` is missing or empty.
- AC-005: `create_invoice`'s handler never writes to `#if-n` — confirmed the invoice number field is left for `nextInvNum()`'s existing auto-generation, not overwritten by any payload value even if one is present (defensive — the payload contract omits it, but the handler must not honor it if a malformed/adversarial payload includes one anyway).
- AC-006: `create_line_item`'s handler resolves `supId` via a `get_suppliers`-style lookup exactly as `create_invoice` resolves `buyId` — same resolution mechanism, not two different implementations.
- AC-007: `create_credit_note` and `create_invoice` are distinct action keys with distinct handler branches — a credit-note payload cannot be routed through `create_invoice`'s validation path or vice versa.
- AC-008: `get_pos`'s tool description string, post-fix, contains `Deposit Paid` and `Settled` and does **not** contain `Confirmed`, `In Production`, or `Shipped` — a direct string assertion against the live `AI_TOOLS` definition, not the (already-corrected-elsewhere) `AI_SYSTEM_PROMPT` prose.

## Open Questions for Spec-Gate

1. Exact clarifying-question phrasing/UX when a name lookup in REQ-AI-GAP-002c/d finds zero matches vs. multiple ambiguous matches (e.g. two suppliers with similar names) — this REQ requires the fallback exist, not its exact wording.
2. Whether `create_line_item`'s Description/Supplier/UOM/Cost minimum should also require an HS code up front, or allow it to be added later — matches an existing operator workflow question, not an AI-specific one, worth confirming against how operators actually use quick-add today.
