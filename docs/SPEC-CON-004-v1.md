# SPEC-CON-004-v1: AI-Assisted Enquiry Intake Check

**Implements:** REQ-CON-004-v2 (requirements-gate CONDITIONAL PASS on v1, resolved in v2).

All line citations below independently re-verified against live `index.html` on `main` at spec-drafting time.

## 0. Design decisions this spec has to make that the REQ left open

1. **Exact placement of the button/output panel.** The REQ specifies the button appears "next to the `ct-enq-summary` textarea" (a plain `<input type="text">` in the live code, not a textarea — confirmed at `index.html:2167`, `<input id="ct-enq-summary" type="text" placeholder="What did they enquire about?">`) but leaves exact markup to spec-gate. **Decision: placed immediately below the input, mirroring the precise structural pattern already used for `ordCheckLineGaps()`'s button** (`index.html:2654`: `class="btn btn-g" style="font-size:.4rem;padding:1px 4px;"`, plus a sibling output `<div>` toggled from `display:none`) — not a new visual language invented for this REQ.
2. **Payload construction — the REQ's own corrected requirement (REQ-CON-004c) mandates the technique, not just the outcome.** The new function reads `G('ct-enq-summary').value`/`G('ct-company').value` directly off the form and builds `{ summary, company }` as its own object literal — it never touches, references, or is placed near `saveCon()`'s `con = {...}` construction (`index.html:9622-9638`). This is a structural choice, not a comment-level promise: the check function and `saveCon()` share no code, no helper, and no variable.

## 1. `CON_ENQUIRY_CHECK_PROMPT` — new bespoke prompt (REQ-CON-004b)

Added near the existing `ORD_GAP_CHECK_PROMPT` (`index.html:2712`), not reusing it — a genuinely different prompt for a genuinely different input shape (free text vs. structured fields):

```js
var CON_ENQUIRY_CHECK_PROMPT = 'You review a raw sales enquiry summary for vagueness or missing commercial detail before it is turned into a sourcing request. Given the enquiry text (and optionally the company name) as JSON, identify up to 3 issues where the text is too vague to act on — e.g. no quantity mentioned, no indication of destination market, a product description too generic to source against. For each issue, phrase a specific, concrete question the operator could send back to the prospect. Respond with ONLY a JSON array (no prose, no markdown fences): [{"issue":"<short description>","question":"<specific question to send>"}]. Respond with an empty array [] if nothing is ambiguous.';
```

## 2. `conCheckEnquirySemantic(summary, company)` — new function, mirrors `ordCheckLineGapsSemantic()`'s contract exactly

Placed immediately after `CON_ENQUIRY_CHECK_PROMPT`:

```js
async function conCheckEnquirySemantic(summary, company) {
  if (!AI.key) return null;
  var payload = { summary: summary };
  if (company) payload.company = company;
  try {
    var resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': AI.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        temperature: 0.2,
        system: CON_ENQUIRY_CHECK_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var text = (data.content || []).map(function(b){ return b.text || ''; }).join('');
    var parsed = JSON.parse(text.trim());
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(function(x){ return x && typeof x.issue === 'string' && typeof x.question === 'string'; });
  } catch (e) {
    return null;
  }
}
```

Byte-for-byte the same shape as `ordCheckLineGapsSemantic()` (`index.html:2713-2743`): same `!AI.key` early-return, same model/`max_tokens`/`temperature`, same non-OK→`null`, same catch-all→`null`, same result-shape filter. **The payload construction (line 3 above) is the one deliberate difference REQ-CON-004c requires**: `{ summary: summary }` with `company` added only if present — built fresh from the two function parameters, never from a shared object, never importing/spreading/trimming `saveCon()`'s `con` literal. `name`/`email`/`phone` have no code path into this object at all — there is no field to accidentally include, since the function never receives those values as parameters in the first place.

## 3. `conCheckEnquiry()` — new function, wires the button to the panel (REQ-CON-004a, d, e)

```js
function conCheckEnquiry() {
  var panel = G('con-enqchk'); if (!panel) return;
  var summary = G('ct-enq-summary').value.trim();
  if (!summary) { panel.style.display = 'block'; panel.innerHTML = '<div style="color:var(--m);">Enter an enquiry note first.</div>'; return; }
  var company = G('ct-company') ? G('ct-company').value.trim() : '';
  panel.style.display = 'block';
  panel.innerHTML = '<div style="color:var(--m);">Checking for ambiguities…</div>';
  conCheckEnquirySemantic(summary, company).then(function(result){
    if (G('con-enqchk') !== panel) return;
    if (result === null) {
      panel.innerHTML = '<div style="color:var(--m);">AI ambiguity check unavailable.</div>';
    } else if (!result.length) {
      panel.innerHTML = '<div style="color:var(--gn);">No ambiguities flagged.</div>';
    } else {
      panel.innerHTML = '<div>' + result.map(function(item){
        return '<div style="margin-top:2px;">⚠ ' + san(item.issue) + ' — <em>' + san(item.question) + '</em></div>';
      }).join('') + '</div>';
    }
  });
}
```

- **REQ-CON-004a (manual trigger only):** the function only runs when called — no `onchange`/`onkeyup` wiring is added to `ct-enq-summary`, no timer, no auto-run on save. `saveCon()` (`index.html:9587-9661`) is not modified at all.
- **REQ-CON-004d (fallback on failure, never blocks Save):** `result === null` renders "unavailable" text, exactly mirroring `ordCheckLineGaps()`'s own null-handling (`index.html:2697-2699`). Save is a structurally separate button (`onclick="saveCon()"` on the modal's Save button, untouched) — nothing in this function can block it, since this function never calls or gates `saveCon()`.
- **REQ-CON-004e (transient, no persistence, replaces on re-trigger):** the panel's `innerHTML` is fully overwritten on every call; `summary`/`company` are re-read fresh from the form each click. Nothing is written to `DB.con`, `enquiries[]`, or any `sv()`/`localStorage` call — this function contains no persistence call at all.
- The staleness guard (`if (G('con-enqchk') !== panel) return;`) mirrors `ordCheckLineGaps()`'s identical guard (`index.html:2699`) protecting against a modal close/reopen replacing the DOM node while the fetch is in flight.

## 4. HTML — new button + output panel (REQ-CON-004a)

Added immediately after the existing `ct-enq-summary` input (`index.html:2167`):

```html
<input id="ct-enq-summary" type="text" placeholder="What did they enquire about?">
<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.4rem;padding:1px 4px;" onclick="conCheckEnquiry()">Check enquiry</button></div>
<div id="con-enqchk" style="display:none;margin-top:4px;"></div>
```

Exact class/style values copied from `ordCheckLineGaps()`'s button (`index.html:2654`) and its output div (`index.html:2655`), per §0 decision 1 — no new visual pattern introduced.

**Reset whenever the Contact modal opens.** Both entry points into `ov-con` already reset `ct-enq-summary` today and need the identical one-line addition: `openCon()`'s field-clearing loop (`index.html:9527`, `['ct-name','ct-email','ct-phone','ct-company','ct-notes','ct-enq-summary'].forEach(...)`, for a new Contact) and `editCon(id)`'s explicit `G('ct-enq-summary').value = '';` (`index.html:9551`, for an existing Contact — the enquiry-note field is deliberately always blanked on edit, since it represents a *new* enquiry to log, not the last one shown). Neither function is otherwise modified — this spec adds one line to each, clearing the check panel alongside the fields they already reset:

```js
var enqChk = G('con-enqchk'); if (enqChk) { enqChk.style.display = 'none'; enqChk.innerHTML = ''; }
```

This prevents a stale check result from a previously-open Contact bleeding into a freshly-opened one — not explicitly named as an AC, but a direct consequence of REQ-CON-004e's "nothing accumulates" intent applied to the modal-reopen case, which the REQ's own AC-006 (re-triggering reflects current text) implies but doesn't spell out for the open/close case specifically.

## GDPR Data Flow

Directly implements REQ-CON-004c/REQ-CON-004's GDPR Assessment: the payload sent to Anthropic (`{summary, company}`) has no code path capable of including `name`/`email`/`phone` — those values are never read into `conCheckEnquirySemantic()`'s scope at all (the function's only parameters are `summary`/`company`). This is a structural guarantee, not a policy applied after construction — there is no object to redact from, because the excluded fields were never assembled into one in the first place. No new field, no new persistence, no new external data flow beyond the same Anthropic API call pattern `ordCheckLineGapsSemantic()` already established.

## Test Plan (`tests/run.js`)

New suite `AI-assisted enquiry intake check (SPEC-CON-004)`, using the existing `_mockAnthropic`/`_lastAnthropicBody` harness (`tests/run.js:48-52`, already proven for `ordCheckLineGapsSemantic()`'s tests):

- `conCheckEnquirySemantic()` — no `AI.key` configured → resolves `null`, no fetch call made (assert `_lastAnthropicBody` unset/unchanged).
- `conCheckEnquirySemantic()` — network error (`_mockAnthropic = 'reject'`) → resolves `null`, no thrown exception.
- `conCheckEnquirySemantic()` — non-200 response → resolves `null`.
- `conCheckEnquirySemantic()` — malformed (non-JSON-array) response text → resolves `null`.
- `conCheckEnquirySemantic()` — well-formed response (`_mockAnthropic = {status:200, text:'[{"issue":"...","question":"..."}]'}`) → resolves the parsed array.
- **AC-004 (the core payload-scoping test):** with `ct-name`, `ct-email`, `ct-phone` all populated on the mock form alongside `ct-enq-summary`/`ct-company`, call `conCheckEnquiry()` and inspect `_lastAnthropicBody.messages[0].content` (parsed back to JSON) — assert it contains only `summary`/`company` keys, and explicitly assert `name`/`email`/`phone` keys are **absent** (not merely falsy) from the parsed payload object.
- `conCheckEnquiry()` — vague summary (AC-001 scenario, mocked response with 1+ issues) renders each issue+question in `#con-enqchk`.
- `conCheckEnquiry()` — detailed summary (AC-002 scenario, mocked empty-array response) renders "No ambiguities flagged."
- `conCheckEnquiry()` — no `AI.key` (AC-003) renders "AI ambiguity check unavailable." — confirm `saveCon()` remains callable immediately after (Save is never blocked; call `ctx.saveCon()` in the same test with valid required fields and assert it completes normally).
- `conCheckEnquiry()` — triggering does not mutate `DB.con` (AC-005): snapshot `DB.con` before/after, assert deep-equal.
- `conCheckEnquiry()` — re-triggering after editing `ct-enq-summary`'s value reflects only the current text (AC-006): first call with summary A and a mocked response distinct from a second call's summary B and its own mocked response; assert the second render fully replaced the first, and `_lastAnthropicBody` on the second call reflects summary B, not A.
- Regression (AC-007): `saveCon()`'s existing duplicate-email merge-vs-create-separate `confirm()` flow (`index.html:9597-9615`) is unaffected — run the existing dup-email test scenario unchanged and confirm identical behavior with this spec's code present.
- `openCon()` — opening a fresh Contact modal after a prior Contact's check left `#con-enqchk` populated: assert the panel is hidden and empty on open (new regression test for the reset-on-open behavior in §4).

## Changelog

- v1: Initial spec implementing REQ-CON-004-v2.
