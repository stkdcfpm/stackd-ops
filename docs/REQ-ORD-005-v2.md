# REQ-ORD-005-v2: Manual per-line gap detection for Order Request lines

**Supersedes:** REQ-ORD-005-v1 (requirements-gate FAIL — missing GDPR data-flow statement for the semantic-check API call, and unspecified system-prompt source for that call)

## Business Context

Order Request lines (`ord.lines[]`, added in v2.9.45 per `SPEC-ORD-002`, fields defined at `index.html:2596-2601`) frequently arrive incomplete at intake — via CSV import (`index.html:6573-6586`) or manual entry (`ordAddLine()`, `index.html:2587-2604`). Today, the only signal that a line is under-qualified is `qtyStatus === 'Unknown'`, and the only place that's surfaced is a non-blocking warning when advancing the whole Order Request to `Quoted` (`index.html:2521`, `AI_SYSTEM_PROMPT` line ~7176). There is no per-line, per-field view of what's actually missing, and no help articulating what to ask the buyer/supplier to close it.

The user wants a manual, per-line "check gaps" action that:
1. Highlights what's missing on that specific line (structural — deterministic, no AI).
2. Where fields are populated but ambiguous/inconsistent, uses the AI to phrase a specific, actionable question the operator can send to close it (semantic — AI-assisted).
3. Never changes any live field itself — purely diagnostic/informational, output for the operator to act on.
4. Does not alter the existing stage-transition gating: `qtyStatus: Unknown` remains a soft warning at the `Quoted` transition (`index.html:2521`), never a hard block. Gap findings are visibility, not a new enforcement mechanism.

## FM-1 Assessment

No new `K`/`DB` entity. No new Sheets sync mapping (`FIELD_MAPS`) — gap-check output is ephemeral (computed and rendered on trigger, not persisted to `DB.ord`). Falls under FM-1's category-1 exception (UI/AI feature, no new localStorage entity) — same precedent cited in `docs/REQ-MTD-001-v2.md:167` for a comparable UI/AI-only feature; the different category-2 exception used for `SPEC-ORD-002`'s `lines[]` field addition does not apply here since no field is added to the schema. No separate council decision required.

## GDPR Data Flow (new in v2 — resolves requirements-gate v1 finding)

The semantic gap-check (REQ-ORD-005c) sends line data to the Anthropic API, external to the browser/localStorage boundary, same as every other AI feature in the app (`sendAIMsg()`, existing AI actions). This REQ scopes that payload explicitly rather than relying on the general AI-chat pattern, since a gap-check is triggered without the operator typing a message and could otherwise silently include more than they intended:

- **Included in payload:** `category`, `itemSpec`, `orderVolumeQty`, `orderVolumeUnit`, `packingSpec`, `baseUom`, `baseQty`, `sourceCountry`, `variantOption`, `qtyStatus` — all product/order-attribute fields, none of which are personal data.
- **Explicitly excluded:** `ord.contactId` and anything resolved from it (buyer/contact name, email, phone — via `DB.con.find(...)`, e.g. as used at `index.html:2643-2645`), the Order Request's own `id`/`num`, and any `lineUpdates[]` history (which can contain freeform operator/buyer notes). The semantic-check payload is line-fields-only — no lookups into `DB.con` or any other entity, and no freeform note fields.
- This is a stricter scope than the existing accepted pattern (`SEC-GAP-002`/`SEC-GAP-003` cover Sheets-sync PII transmission and API-key storage, but no existing gap entry covers general chat-content transmission to Anthropic in `sendAIMsg()`, which is unscoped by design since it's a free-text conversation). No new known-gap entry is needed for this feature specifically, since the payload is defined to categorically exclude PII rather than accepting a residual risk.

## Requirements

**REQ-ORD-005a (structural gap check — deterministic, no AI):** A per-line function computes which of the following fields are unset/empty, independent of any AI call: `packingSpec`, `baseUom`, `baseQty` (null/blank), `sourceCountry`, and `qtyStatus === 'Unknown'`. This check runs synchronously, always available, and costs no API call.

**REQ-ORD-005b (manual trigger, per line):** A new "Check gaps" button/action appears on each rendered line in `rOrdLines()` (`index.html:2569-2586`), alongside the existing inline-edit fields. It never runs automatically on save, import, or a timer — only on explicit operator click, one line at a time (per the user's stated preference: manual trigger, not dynamic/on-save).

**REQ-ORD-005c (semantic gap check — AI-assisted, additive to structural):** On trigger, in addition to the structural list, the app makes a single-shot Anthropic API call (following the existing direct-browser-call pattern in `sendAIMsg()`, `index.html:7764-7781`, using the stored `AI.key`) with a payload restricted exactly as scoped in the GDPR Data Flow section above. The call uses a new, bespoke, short system prompt written specifically for this task (not `AI_SYSTEM_PROMPT` or `AI_COMPLIANCE_PROMPT`, both of which are conversational assistant prompts unrelated to this single-purpose task) — instructing the model to flag ambiguous/inconsistent values (e.g. a vague `itemSpec`, an `orderVolumeQty`/`orderVolumeUnit` that doesn't reconcile with `baseUom`/`baseQty`, a `category` that doesn't match the described item) and phrase each as a specific, actionable question suitable for sending to the buyer or supplier. This call does not use `AI_TOOLS` or the action-block/tool-loop machinery — it is a plain single-turn request/response, not a conversation, and is not logged to `_aiHistory` or the chat modal.

**REQ-ORD-005d (fallback on AI failure):** If the AI call fails (network error, missing `AI.key`, non-200 response) or returns nothing usable, the structural gap list is still shown in full — the semantic layer degrades silently to "unavailable," never blocking or hiding the structural results. Mirrors the documented unreliability already logged as `AI-GAP-007`; by the same LLM-output-variability nature, the semantic pass's *content* (which ambiguities it flags, how many) is inherently non-deterministic between calls even on identical input — acceptance testing (AC-003) checks that the mechanism works end-to-end (a well-formed response is returned and rendered), not that the model flags a specific expected ambiguity every time.

**REQ-ORD-005e (no persistence, no live-field mutation):** Gap-check output (both structural and semantic) is rendered transiently in the line's UI on trigger — not written to `ord.lines[].lineUpdates[]`, not saved to `DB.ord`, not synced. It does not create a pending update entry (unlike `update_order_line`, `index.html:7575-7581`, which explicitly does log a pending entry) — a gap-check is a read-only diagnostic, not a proposed change. Re-triggering re-computes and replaces the prior output; nothing accumulates.

**REQ-ORD-005f (no change to stage gating):** The existing `Quoted`-transition warning for `qtyStatus: Unknown` lines (`index.html:2521`) and all other Order Request stage-transition logic (`ORD_TRANSITIONS`, `index.html:2396-2405`) are unchanged. This feature adds visibility only; it does not add a new gate, block, or required-field enforcement anywhere in the pipeline.

**REQ-ORD-005g (repeated-trigger cost — accepted, out of scope):** An operator can click "Check gaps" repeatedly across many lines, each firing a separate API call against the operator's own configured `AI.key`. No rate-limiting or debounce is added by this REQ — same accepted-cost model as every existing manual AI action in the app (e.g. `sendAIMsg()` has no rate limit either). Not a defect; explicitly out of scope.

## Acceptance Criteria

- AC-001: Clicking "Check gaps" on a line with `packingSpec: ''`, `baseUom: ''`, `baseQty: null`, `sourceCountry: ''`, `qtyStatus: 'Unknown'` shows all five as missing, with no AI call required to see this list.
- AC-002: Clicking "Check gaps" on a fully-populated, unambiguous line shows an empty/clear structural list.
- AC-003: With `AI.key` configured, the semantic pass returns a well-formed response (at least one flagged item, or an explicit "no ambiguities found" result) for a line with a deliberately vague `itemSpec` (e.g. "assorted goods") — the specific wording/count of flagged ambiguities is not asserted, per REQ-ORD-005d's non-determinism note.
- AC-004: With no `AI.key` configured, or a simulated fetch failure, the structural list still renders correctly and the UI shows the semantic section as unavailable — no thrown error, no blocked rendering.
- AC-005: Triggering "Check gaps" does not create any entry in `line.lineUpdates[]` and does not call `sv(K.ord, DB.ord)` — confirmed via test asserting `DB.ord` is byte-identical before/after trigger (aside from the transient render).
- AC-006: The `Quoted`-transition warning behavior for `qtyStatus: Unknown` (`index.html:2521`) is unchanged — verified this REQ introduces no new call sites touching `ORD_TRANSITIONS` or the existing warning condition.
- AC-007: Re-triggering "Check gaps" on the same line after editing a field reflects only the current field state — no stale results carried over from a prior trigger.
- AC-008: The semantic-check API payload, when inspected (e.g. via a test that captures the `fetch` call body), contains only the fields listed in the GDPR Data Flow section's "Included" list — never `contactId`, resolved contact name/email/phone, `ord.id`/`num`, or any `lineUpdates[]` content.

## Changelog

- v2: Added an explicit GDPR Data Flow section scoping the semantic-check payload to exclude all contact/PII fields (requirements-gate v1 finding). Specified that REQ-ORD-005c uses a new bespoke system prompt, not `AI_SYSTEM_PROMPT`/`AI_COMPLIANCE_PROMPT` (requirements-gate v1 finding). Added REQ-ORD-005g explicitly accepting repeated-trigger API cost as out of scope. Softened AC-003 to check mechanism correctness rather than a specific non-deterministic LLM output, with a note in REQ-ORD-005d explaining why. Added AC-008 to make the new payload-scoping requirement independently testable.
- v1: Initial requirements draft (requirements-gate FAIL — see above).
