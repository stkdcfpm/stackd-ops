# REQ-AI-GAP-011 — AI-assisted RFQ response update from a pasted supplier email

**Status:** v1 — requirements-gate CONDITIONAL PASS, no blocking findings. Five advisories, all fixed in place (see §8).
**Type:** Small, additive AI feature. **Hard dependency: `REQ-ORD-006` must ship first** — this REQ's "Apply" action calls directly into REQ-ORD-006b's edit-in-place mechanism, which does not exist yet. Do not spec or build this REQ ahead of REQ-ORD-006. Touches `index.html` only.

---

## 1. Business context

### 1.1 The question and the diagnosis (from check-first, this session)

User asked, in the same conversation that produced `REQ-ORD-006`: is there an AI capability to submit a supplier's email content and have it update an existing quote/RFQ response automatically?

Found by direct code read: no. The AI assistant's chat action-block system (`index.html:9002` onward, `@@ACTION\n{"action":...}\n@@END`) supports a fixed list of `create_*` actions plus one narrow `update_order_line` action — and that one only touches Order Request line **metadata** (packing spec, quantity notes, etc. — never pricing), and is always logged as an unconfirmed pending proposal requiring an explicit operator click before it changes anything (`ordLogLineUpdate()`/`ordConfirmLineUpdate()`, `index.html:2875-2903`). There is no action, tool, or button anywhere that takes free-text email content and updates a Quote or RFQ response.

### 1.2 The chosen architecture — reusing an existing, proven pattern, not the chat/action-block system

Two established AI-integration patterns already exist in this codebase for very different purposes:

1. **The general chat assistant + action-block system** — open-ended conversation, the AI decides what to do and proposes an action block, requires the AI to correctly identify *which* record the operator means from conversational context (aided by read-tools like `get_buyers`, `get_suppliers` when ambiguous).
2. **Scoped, single-shot, button-triggered AI calls** — `ordCheckLineGapsSemantic()` (`index.html:3083-3117`) and `conCheckEnquirySemantic()` (similar, for Contact enquiries): a specific button in a specific, already-known context (a specific Order Request line, a specific Contact) makes one direct `fetch()` call to `https://api.anthropic.com/v1/messages` with a narrow, single-purpose system prompt, gets back structured JSON, and displays it — no chat, no multi-turn conversation, no ambiguity about which record is involved because the button itself is already anchored to it.

**This REQ uses pattern 2, not pattern 1.** Updating a specific RFQ response's pricing is exactly analogous to `ordCheckLineGapsSemantic()`'s "check this one already-known line" shape, not to the general chat assistant's "figure out what the operator means from a conversation" shape. **Considered and rejected (reasoning corrected at requirements-gate, §8):** extending the chat/action-block system instead would require a new `get_rfq_responses` read-tool and would put the burden of disambiguating *which* response is meant on the AI. This is **not** framed as a likely-to-fail NLU risk — this codebase already has a working, shipped precedent for exactly this shape of ambiguous-lookup problem (`create_invoice`'s prompt entry, `index.html:9002` onward: "call get_buyers first if the buyer's id isn't already known... if zero or multiple ambiguous matches, ask a clarifying question instead of guessing"), and a similarly-built `get_rfq_responses` + clarifying-question pattern would likely work about as reliably. The real reason to reject it is **unnecessary complexity and friction, not unreliability**: RFQ-response identification is a two-level lookup (which Order Request line, then which response within it) rather than the existing precedent's flat one-level name→id lookup, requiring a new read-tool and at least one extra conversational round-trip (the clarifying question) for a task a single button click already resolves with zero ambiguity and zero extra AI call. The scoped-button design wins on directness and UX friction, not because the alternative would likely misfire.

---

## 2. Requirements

### REQ-AI-GAP-011a — New button per RFQ response row: "Parse update from email"
Added to `renderRfqComparison()`'s per-response row (`index.html:3190-3226`), alongside REQ-ORD-006d's Edit/Delete buttons. Opens a small inline textarea (or a lightweight modal, implementer's call on exact placement) for the operator to paste the raw supplier email text. No AI call happens until the operator submits the pasted text — nothing is sent automatically.

**Layout note (requirements-gate, §8):** the response row's action cell currently holds exactly one button (Commit/Uncommit, `index.html:3220`) at `font-size:.44rem`. Between REQ-ORD-006d (Edit, Delete) and this REQ (Parse update from email), that cell grows to four buttons plus the row's six other data columns. Fitting four sub-half-rem-font buttons legibly in one table cell is a real layout constraint, not just a styling detail — implementer should verify at build time whether they fit acceptably as inline buttons or need wrapping, a dropdown/overflow menu, or a second row within the cell. Not resolved here; flagged so spec-gate makes a deliberate call rather than discovering it during build.

### REQ-AI-GAP-011b — New function: `rfqParseUpdateFromEmail(emailText, currentResponse)`
Mirrors `ordCheckLineGapsSemantic()`'s exact architecture: `AI.key`-gated (returns `null` immediately if not configured, matching the existing graceful-degradation convention), single `fetch()` call to the Anthropic Messages API, `model: 'claude-haiku-4-5-20251001'`, `temperature: 0.2`, a narrow system prompt, `try/catch` returning `null` on any failure (network error, non-200, malformed JSON) — never throws.

**Payload sent to the AI:** the pasted email text, plus the response's current known values (`cost`, `currency`, `moq`, `leadTime`, `paymentTerms`) as context — this lets the prompt extract only what's *changed*, not force it to guess values for fields the email doesn't mention. **Payload scope, PII-adjacent note (revised at requirements-gate, §8):** `CON-004`'s buyer-enquiry check minimizes what goes **into** the request — name/email/phone never reach the `fetch` body at all (`index.html:3230-3233`, payload is `{summary, company}` only). This REQ's design cannot make the same claim on the input side: the **entire raw pasted email text** is necessarily sent as-is, since the extraction needs full context, and that text may incidentally contain a supplier contact's own signature block, or — less controllably — a CC'd colleague's details or a forwarded thread from a third party. Restricting the **response schema** to commercial fields only (unchanged from the original design) reduces what comes *back* and gets stored, but does nothing to reduce what's *sent*. This is a real, accepted residual risk, not a non-issue: **accepted because** this is an internal, single-operator B2B tool handling business-to-business commercial correspondence the operator already holds and is choosing to paste (not data collected or exposed without their knowledge), the same trust boundary already implicit in the operator being able to read/store/forward that email themselves. **Mitigation:** the paste-email UI (§2a) should carry a short inline note — "Paste only the pricing-relevant portion of the email" — nudging the operator toward trimming signature blocks/forwarded chains before pasting, without making it a hard requirement.

**Prompt design:** "Given this email text and the current known values for one supplier's quote, identify any of {cost, currency, moq, leadTime, paymentTerms, notes} that the email explicitly states a new/changed value for. Respond with ONLY a JSON object containing just the fields you found evidence for (omit fields the email doesn't address) — no prose, no markdown fences. Respond with an empty object {} if the email doesn't specify any new commercial terms." — matching the exact "empty result on nothing found" graceful style already used by both `ORD_GAP_CHECK_PROMPT` and `CON_ENQUIRY_CHECK_PROMPT`.

**Response-shape validation differs from the two precedent functions (flagged at requirements-gate, §8).** `ordCheckLineGapsSemantic()`/`conCheckEnquirySemantic()` both validate their parsed response with `if (!Array.isArray(parsed)) return null;`, since their contract is an array. This function's contract is an **object**, not an array — the equivalent guard must reject anything that isn't a plain object (including rejecting an array, which `typeof` alone wouldn't catch — implementer should use something like `if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;`). Called out explicitly here so spec-gate doesn't have to rediscover it.

### REQ-AI-GAP-011c — Proposed-changes review UI, never auto-applied
The parsed result (a partial object of only the fields the AI found evidence for) is displayed as a diff — old value → proposed new value, one row per field — **not applied to the response record automatically**. The operator reviews and clicks **Apply** (which calls REQ-ORD-006's `editRfqResponse()`/`saveRfqResponse()` edit path with the merged field values — old values for anything the AI didn't address, proposed values for what it did) or **Discard** (closes the panel, changes nothing). This mirrors `update_order_line`'s "always pending, requires an explicit operator confirm" trust model (§1.1) in the sense that matters most: **AI output never silently changes a live value.**

**One real difference from that precedent, called out explicitly (requirements-gate, §8), not glossed over as mere "UI shape":** `ordLogLineUpdate()` persists the pending proposal to `DB.ord` immediately (`sv(K.ord, DB.ord)`, `index.html:2890`) — it survives a page reload or the operator navigating away, and can be confirmed or left pending indefinitely. This REQ's diff review is deliberately **not** persisted anywhere (per §3's scope decision, no RFQ-response update-history mechanism exists or is being added) — it lives only in transient front-end state for the current view. If the operator navigates away, refreshes, or closes the tab before clicking Apply or Discard, the proposal is gone with no trace, and re-parsing requires re-pasting the email and re-invoking the AI call. **Accepted trade-off:** the simplicity of not building a second persisted-proposal mechanism (mirroring REQ-ORD-006 §3's own decision not to add RFQ-response version history) is judged worth the loss of that resilience property for what is expected to be an immediate, single-sitting review action, not a multi-day pending queue like Order Request line updates can be. If this turns out to be a real operator friction point in practice, promoting it to a persisted proposal (mirroring `lineUpdates[]`) is the natural follow-up, not assumed here.

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

---

## 8. Review-resolution log

**Requirements-gate independent review: CONDITIONAL PASS, no blocking findings.** Every citation of *existing* code this REQ's design leans on — `ordCheckLineGapsSemantic()`'s architecture, `conCheckEnquirySemantic()`'s PII-minimization approach, `update_order_line`'s trust model, the absence of any `get_rfq_responses`/RFQ-related AI tool today, and the real dependency on REQ-ORD-006 (confirmed: no `editRfqResponse`/`delRfqResponse` exist anywhere in `index.html`, `saveRfqResponse()` is unconditionally push-only) — was independently verified accurate against the real code. Five advisories, all fixed:

1. **Citation drift:** the chat action-block system was cited at `index.html:8992`; the real `@@ACTION` block is at line 9002. **Fixed:** citation corrected.
2. **Missing note on response-shape validation:** the two precedent functions validate with `Array.isArray()`; this REQ's contract is an object, requiring a different (and array-excluding) guard. **Fixed:** added an explicit note in REQ-AI-GAP-011b spelling out the correct guard shape, so spec-gate doesn't have to rediscover it.
3. **PII input-scoping under-argued:** the original text only addressed output-schema scoping and conflated it with input-payload scoping; CON-004 minimizes what's *sent*, this REQ's design cannot make the same claim since the full raw email text is necessarily transmitted. **Fixed:** §2b now explicitly names this as a real, accepted residual risk with a stated rationale (internal B2B tool, operator-held correspondence, existing trust boundary) and a concrete mitigation (inline UI copy nudging the operator to paste only the relevant portion).
4. **`update_order_line` precedent comparison overstated as "UI shape only":** the original text didn't acknowledge that the cited precedent's pending-proposal state is durably persisted and survives navigation, while this REQ's diff-review is deliberately transient. **Fixed:** §2c now explicitly names this difference and states it as a conscious accepted trade-off (simplicity now, promotable to a persisted mechanism later if it proves to be real friction), not a cosmetic detail.
5. **Rejected-alternative risk framing overstated:** the original text framed chat-extension as carrying "a real, avoidable NLU risk," when this codebase already has a shipped, working precedent (`create_invoice`'s get_buyers-then-clarify pattern) for exactly this class of ambiguous lookup — meaning the alternative would likely work, just with more complexity and friction than the button design. **Fixed:** §1.2 rewritten to reject the alternative on complexity/friction grounds, not overstated reliability grounds.

One additional advisory, not a citation-accuracy issue: **UI real estate** — REQ-ORD-006d (Edit, Delete) and this REQ (Parse update from email) together add three new buttons to a response row that already has one (Commit/Uncommit), inside a table with six other data columns, at sub-half-rem font. **Fixed:** added a layout note to REQ-AI-GAP-011a flagging this as a real constraint for the implementer to resolve deliberately at build time (wrap, overflow menu, or second row), not silently discover.

Proceeding — held pending `REQ-ORD-006` actually shipping, per this REQ's own stated dependency.
