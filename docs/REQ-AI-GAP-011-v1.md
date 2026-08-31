# REQ-AI-GAP-011 — AI-assisted RFQ response update from a pasted supplier email

**Status:** v1 — pre-review draft.
**Type:** Small, additive AI feature. **Hard dependency: `REQ-ORD-006` must ship first** — this REQ's "Apply" action calls directly into REQ-ORD-006b's edit-in-place mechanism, which does not exist yet. Do not spec or build this REQ ahead of REQ-ORD-006. Touches `index.html` only.

---

## 1. Business context

### 1.1 The question and the diagnosis (from check-first, this session)

User asked, in the same conversation that produced `REQ-ORD-006`: is there an AI capability to submit a supplier's email content and have it update an existing quote/RFQ response automatically?

Found by direct code read: no. The AI assistant's chat action-block system (`index.html:8992` onward, `@@ACTION\n{"action":...}\n@@END`) supports a fixed list of `create_*` actions plus one narrow `update_order_line` action — and that one only touches Order Request line **metadata** (packing spec, quantity notes, etc. — never pricing), and is always logged as an unconfirmed pending proposal requiring an explicit operator click before it changes anything (`ordLogLineUpdate()`/`ordConfirmLineUpdate()`, `index.html:2875-2903`). There is no action, tool, or button anywhere that takes free-text email content and updates a Quote or RFQ response.

### 1.2 The chosen architecture — reusing an existing, proven pattern, not the chat/action-block system

Two established AI-integration patterns already exist in this codebase for very different purposes:

1. **The general chat assistant + action-block system** — open-ended conversation, the AI decides what to do and proposes an action block, requires the AI to correctly identify *which* record the operator means from conversational context (aided by read-tools like `get_buyers`, `get_suppliers` when ambiguous).
2. **Scoped, single-shot, button-triggered AI calls** — `ordCheckLineGapsSemantic()` (`index.html:3083-3117`) and `conCheckEnquirySemantic()` (similar, for Contact enquiries): a specific button in a specific, already-known context (a specific Order Request line, a specific Contact) makes one direct `fetch()` call to `https://api.anthropic.com/v1/messages` with a narrow, single-purpose system prompt, gets back structured JSON, and displays it — no chat, no multi-turn conversation, no ambiguity about which record is involved because the button itself is already anchored to it.

**This REQ uses pattern 2, not pattern 1.** Updating a specific RFQ response's pricing is exactly analogous to `ordCheckLineGapsSemantic()`'s "check this one already-known line" shape, not to the general chat assistant's "figure out what the operator means from a conversation" shape. Extending the chat/action-block system instead would require a new `get_rfq_responses` read-tool and would put the burden of correctly disambiguating *which* response (by supplier name + order reference, parsed from free text) on the AI — a real, avoidable NLU risk this REQ sidesteps entirely by anchoring the AI call to a response the operator has already selected by clicking a button on its own row. **Considered and rejected** for that reason.

---

## 2. Requirements

### REQ-AI-GAP-011a — New button per RFQ response row: "Parse update from email"
Added to `renderRfqComparison()`'s per-response row (`index.html:3190-3226`), alongside REQ-ORD-006d's Edit/Delete buttons. Opens a small inline textarea (or a lightweight modal, implementer's call on exact placement) for the operator to paste the raw supplier email text. No AI call happens until the operator submits the pasted text — nothing is sent automatically.

### REQ-AI-GAP-011b — New function: `rfqParseUpdateFromEmail(emailText, currentResponse)`
Mirrors `ordCheckLineGapsSemantic()`'s exact architecture: `AI.key`-gated (returns `null` immediately if not configured, matching the existing graceful-degradation convention), single `fetch()` call to the Anthropic Messages API, `model: 'claude-haiku-4-5-20251001'`, `temperature: 0.2`, a narrow system prompt, `try/catch` returning `null` on any failure (network error, non-200, malformed JSON) — never throws.

**Payload sent to the AI:** the pasted email text, plus the response's current known values (`cost`, `currency`, `moq`, `leadTime`, `paymentTerms`) as context — this lets the prompt extract only what's *changed*, not force it to guess values for fields the email doesn't mention. **Payload scope, PII-adjacent note:** unlike `CON-004`'s buyer-enquiry check (which deliberately excludes name/email/phone before sending to the AI, since that data reaches the AI automatically as a side effect of triggering a check), here the operator is the one choosing to paste supplier correspondence they received — a deliberate, visible action, not automatic exposure. No special PII-stripping of the pasted text itself is required for that reason. The **response schema is still scoped strictly to commercial fields** (§2c) — the AI is not asked to extract or echo back anything else (e.g. a supplier contact's signature block), even if present in the pasted text.

**Prompt design:** "Given this email text and the current known values for one supplier's quote, identify any of {cost, currency, moq, leadTime, paymentTerms, notes} that the email explicitly states a new/changed value for. Respond with ONLY a JSON object containing just the fields you found evidence for (omit fields the email doesn't address) — no prose, no markdown fences. Respond with an empty object {} if the email doesn't specify any new commercial terms." — matching the exact "empty result on nothing found" graceful style already used by both `ORD_GAP_CHECK_PROMPT` and `CON_ENQUIRY_CHECK_PROMPT`.

### REQ-AI-GAP-011c — Proposed-changes review UI, never auto-applied
The parsed result (a partial object of only the fields the AI found evidence for) is displayed as a diff — old value → proposed new value, one row per field — **not applied to the response record automatically**. The operator reviews and clicks **Apply** (which calls REQ-ORD-006's `editRfqResponse()`/`saveRfqResponse()` edit path with the merged field values — old values for anything the AI didn't address, proposed values for what it did) or **Discard** (closes the panel, changes nothing). This mirrors `update_order_line`'s "always pending, requires an explicit operator confirm" trust model (§1.1) — the specific UI shape differs (an inline one-time diff review, not a persisted `lineUpdates[]`-style log, since RFQ responses have no per-field update history mechanism per REQ-ORD-006 §3's explicit scope decision) but the underlying rule is identical: **AI output never silently changes a live value.**

### REQ-AI-GAP-011d — `AI_SYSTEM_PROMPT` update
Per the standing "mandatory on every version" rule (`CLAUDE.md`) — the RFQ-comparison description in `AI_SYSTEM_PROMPT` (`index.html`, the same section REQ-ORD-006 §7 flags for its edit/delete update) should also mention this button exists, so the AI chat assistant can accurately answer "can I update a quote from a supplier email" if asked directly — pointing the operator at the actual feature (a button on the response row) rather than incorrectly implying the chat itself can do it via conversation.

---

## 3. Explicitly out of scope

- **No new AI read-tool** (`get_rfq_responses` or similar) — the scoped-button architecture (§1.2) means the AI never needs to look up which record is involved; it's already given directly. Confirmed no existing `AI_TOOLS` entry does anything RFQ-related, so this is a clean non-addition, not a removal.
- **No extension of the general chat/action-block system.** No new `action` key, no `update_order_line`-style pending-log entry — considered and rejected in §1.2.
- **No persisted history of what the AI proposed** (accepted or discarded) — this is a one-time, in-session review, not a logged audit trail. If a "what did the AI suggest and did the operator take it" record is ever wanted, that's a separate REQ.
- **Requires `REQ-ORD-006` to ship first** — REQ-AI-GAP-011c's "Apply" action has nothing to call into otherwise. This REQ should not proceed past this draft until REQ-ORD-006 is built and merged.
- **No change to `conCheckEnquirySemantic()`/`ordCheckLineGapsSemantic()`** — this REQ adds a third, sibling function following the same pattern, not a shared/generalized helper. (A future refactor consolidating all three into one parameterized "single-shot AI extraction" helper could be considered separately, but isn't assumed here — avoiding speculative abstraction per this project's stated conventions.)

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `AI.key` configured | "Parse update from email" is used | Returns `null` immediately, no fetch call made — matching `ordCheckLineGapsSemantic()`'s existing convention exactly |
| AC-2 | A pasted email that clearly states a new unit cost only | Parsed | The returned object contains only `cost` (and/or `currency` if a currency change is also stated) — no other fields fabricated |
| AC-3 | A pasted email with no discernible commercial terms (e.g. a shipping-schedule-only email) | Parsed | Returns `{}` — an empty object, not `null` and not an error |
| AC-4 | A network error or non-200 response from the Anthropic API | Parsed | Returns `null`, matching the existing `ordCheckLineGapsSemantic()`/`conCheckEnquirySemantic()` fail-soft convention — never throws, never shows a raw error to the operator |
| AC-5 | A proposed change from a successful parse | The operator reviews it | Nothing on the actual RFQ response record changes until **Apply** is explicitly clicked — confirmed by checking `line.rfqResponses` is unmodified between parse and Apply |
| AC-6 | The operator clicks **Apply** | | The response is updated via REQ-ORD-006's edit mechanism exactly as if the operator had manually retyped the same values into the Edit form — including REQ-ORD-006's new-id-and-repoint behavior if the response is committed (REQ-ORD-006 AC-3/AC-4) |
| AC-7 | The operator clicks **Discard** | | The RFQ response and the comparison panel are unchanged; no partial state is left behind |

---

## 5. Testing approach

Follows the exact existing test pattern for `ordCheckLineGapsSemantic()`/`conCheckEnquirySemantic()` (mocked `fetch`, `_mockAnthropic` harness variable already present in `tests/run.js` — reuse it, don't build a second mocking mechanism) for AC-1 through AC-4. AC-5 through AC-7 are pure DOM/DB-state tests with no AI dependency, following the same style as REQ-ORD-006's own test plan.

---

## 6. Gate process

Standard requirements-gate → spec-gate → build-gate cycle. Do not begin spec-gate until `REQ-ORD-006` has actually shipped (not just been drafted) — this REQ's Apply action has no real target to call into before then.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: no existing gap to mark fixed — new feature, not a defect fix.
- `docs/requirements-tracker.md`: new row, explicitly noting the `REQ-ORD-006` dependency in the title/notes column so a future reader doesn't try to sequence it independently.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist; `AI_SYSTEM_PROMPT` update per REQ-AI-GAP-011d.
