# REQ-ORD-005-v1: Manual per-line gap detection for Order Request lines

## Business Context

Order Request lines (`ord.lines[]`, added in v2.9.45 per `SPEC-ORD-002`, fields defined at `index.html:2596-2601`) frequently arrive incomplete at intake — via CSV import (`index.html:6573-6586`) or manual entry (`ordAddLine()`, `index.html:2587-2604`). Today, the only signal that a line is under-qualified is `qtyStatus === 'Unknown'`, and the only place that's surfaced is a non-blocking warning when advancing the whole Order Request to `Quoted` (`index.html:2521`, `AI_SYSTEM_PROMPT` line ~7176). There is no per-line, per-field view of what's actually missing, and no help articulating what to ask the buyer/supplier to close it.

The user wants a manual, per-line "check gaps" action that:
1. Highlights what's missing on that specific line (structural — deterministic, no AI).
2. Where fields are populated but ambiguous/inconsistent, uses the AI to phrase a specific, actionable question the operator can send to close it (semantic — AI-assisted).
3. Never changes any live field itself — purely diagnostic/informational, output for the operator to act on.
4. Does not alter the existing stage-transition gating: `qtyStatus: Unknown` remains a soft warning at the `Quoted` transition (`index.html:2521`), never a hard block. Gap findings are visibility, not a new enforcement mechanism.

## FM-1 Assessment

No new `K`/`DB` entity. No new Sheets sync mapping (`FIELD_MAPS`) — gap-check output is ephemeral (computed and rendered on trigger, not persisted to `DB.ord`). Falls under FM-1's category-1 exception (UI/AI feature, no new localStorage entity) — same category as the existing `update_order_line` AI action. No separate council decision required.

## Requirements

**REQ-ORD-005a (structural gap check — deterministic, no AI):** A per-line function computes which of the following fields are unset/empty, independent of any AI call: `packingSpec`, `baseUom`, `baseQty` (null/blank), `sourceCountry`, and `qtyStatus === 'Unknown'`. This check runs synchronously, always available, and costs no API call.

**REQ-ORD-005b (manual trigger, per line):** A new "Check gaps" button/action appears on each rendered line in `rOrdLines()` (`index.html:2569-2586`), alongside the existing inline-edit fields. It never runs automatically on save, import, or a timer — only on explicit operator click, one line at a time (per the user's stated preference: manual trigger, not dynamic/on-save).

**REQ-ORD-005c (semantic gap check — AI-assisted, additive to structural):** On trigger, in addition to the structural list, the app makes a single-shot Anthropic API call (following the existing direct-browser-call pattern in `sendAIMsg()`, `index.html:7764-7781`, using the stored `AI.key`) with the line's current field values, asking it to flag ambiguous/inconsistent values (e.g. a vague `itemSpec`, an `orderVolumeQty`/`orderVolumeUnit` that doesn't reconcile with `baseUom`/`baseQty`, a `category` that doesn't match the described item) and phrase each as a specific, actionable question suitable for sending to the buyer or supplier. This call does not use `AI_TOOLS` or the action-block/tool-loop machinery — it is a plain single-turn request/response, not a conversation, and is not logged to `_aiHistory` or the chat modal.

**REQ-ORD-005d (fallback on AI failure):** If the AI call fails (network error, missing `AI.key`, non-200 response) or returns nothing usable, the structural gap list is still shown in full — the semantic layer degrades silently to "unavailable," never blocking or hiding the structural results. Mirrors the documented unreliability already logged as `AI-GAP-007`.

**REQ-ORD-005e (no persistence, no live-field mutation):** Gap-check output (both structural and semantic) is rendered transiently in the line's UI on trigger — not written to `ord.lines[].lineUpdates[]`, not saved to `DB.ord`, not synced. It does not create a pending update entry (unlike `update_order_line`, `index.html:7575-7581`, which explicitly does log a pending entry) — a gap-check is a read-only diagnostic, not a proposed change. Re-triggering re-computes and replaces the prior output; nothing accumulates.

**REQ-ORD-005f (no change to stage gating):** The existing `Quoted`-transition warning for `qtyStatus: Unknown` lines (`index.html:2521`) and all other Order Request stage-transition logic (`ORD_TRANSITIONS`) are unchanged. This feature adds visibility only; it does not add a new gate, block, or required-field enforcement anywhere in the pipeline.

## Acceptance Criteria

- AC-001: Clicking "Check gaps" on a line with `packingSpec: ''`, `baseUom: ''`, `baseQty: null`, `sourceCountry: ''`, `qtyStatus: 'Unknown'` shows all five as missing, with no AI call required to see this list.
- AC-002: Clicking "Check gaps" on a fully-populated, unambiguous line shows an empty/clear structural list.
- AC-003: With `AI.key` configured, the semantic pass returns at least one flagged ambiguity with a suggested question, for a line with a deliberately vague `itemSpec` (e.g. "assorted goods").
- AC-004: With no `AI.key` configured, or a simulated fetch failure, the structural list still renders correctly and the UI shows the semantic section as unavailable — no thrown error, no blocked rendering.
- AC-005: Triggering "Check gaps" does not create any entry in `line.lineUpdates[]` and does not call `sv(K.ord, DB.ord)` — confirmed via test asserting `DB.ord` is byte-identical before/after trigger (aside from the transient render).
- AC-006: The `Quoted`-transition warning behavior for `qtyStatus: Unknown` (`index.html:2521`) is unchanged — verified this REQ introduces no new call sites touching `ORD_TRANSITIONS` or the existing warning condition.
- AC-007: Re-triggering "Check gaps" on the same line after editing a field reflects only the current field state — no stale results carried over from a prior trigger.
