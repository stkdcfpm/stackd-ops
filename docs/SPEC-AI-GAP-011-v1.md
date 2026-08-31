# SPEC-AI-GAP-011 — AI-assisted RFQ response update from a pasted supplier email

**Status:** v1 — draft, pending spec-gate.
**Implements:** `docs/REQ-AI-GAP-011-v1.md` (requirements-gate CONDITIONAL PASS, 5 advisories fixed). Dependency confirmed satisfied: `REQ-ORD-006` shipped and merged to `main` in PR #119 (`editRfqResponse()`/`saveRfqResponse()`/`delRfqResponse()` all present and unmodified by this spec).
**Touches:** `index.html` only (no `Code.gs`, no schema change, no `FIELD_MAPS` entry — matches REQ §3).

---

## 1. Design decision not fully settled by the REQ: response-row layout (resolves REQ-AI-GAP-011a's flagged real-estate concern)

The REQ explicitly flagged this for spec-gate rather than resolving it (§2a's layout note). Current state, verified against the real code (`index.html:3294-3298`): each response row's action `<td>` already holds three buttons — Commit/Uncommit, Edit, Del — at `font-size:.44rem`, `white-space:nowrap`, alongside six data columns (Supplier, Unit Cost, Landed GBP, MOQ, Lead Time, Payment Terms).

**Decision: do not add a fourth full-text button to the row.** Instead:

- Add one small **icon-only** button to the row (`&#9993;` — envelope glyph, `title="Parse update from email"`), costing minimal width — not a text label, so it doesn't compound the fit problem the REQ flagged.
- The actual paste-textarea / proposed-diff / Apply-Discard UI lives in **one shared panel below the table**, not duplicated per-row — a new `<div id="ord-rfq-emailparse-<lineId>">`, sibling to the existing `<table>` and the existing `+ Add Response` button, following the exact same "hidden div, populated and shown on demand" pattern already used for `ord-gapchk-<lineId>` (`index.html:3054`) and `ord-rfq-<lineId>` itself.
- Clicking the icon button on a given row targets that row's response (tracked in a new module-level var, mirroring `cRfqEditId`'s pattern exactly) and opens/repopulates the one shared panel — never more than one row's parse-in-progress state exists at a time, by construction (opening a second row's parser overwrites the tracked target and repopulates the same shared div).

This keeps the row itself compact (one small icon, not a fourth text button) while giving the heavier review UI as much width as the whole panel, not one table cell.

---

## 2. New module-level state (§1, after existing `cRfqEditId`)

**File:** `index.html:2712-2714`

**Current:**
```js
var cRfqOrdId = null;
var cRfqLineId = null;
var cRfqEditId = null;
```

**New (insert after line 2714):**
```js
var cRfqEmailParseRespId = null;
var cRfqEmailParseProposed = null;
```

`cRfqEmailParseRespId` tracks which response the open parse panel targets (mirrors `cRfqEditId`). `cRfqEmailParseProposed` holds the last successfully parsed proposal object (the partial `{field: newValue}` object), so the Apply button has something to act on without re-parsing. Neither is persisted to `DB` — per REQ-AI-GAP-011c's explicit scope decision, the proposal is transient front-end state only, gone on navigation/refresh.

**Test-isolation requirement (mirrors the `cRfqEditId` gotcha SPEC-ORD-006 §7 already documented):** `resetDB()` does not touch these two module-level vars. A test that leaves `cRfqEmailParseRespId`/`cRfqEmailParseProposed` set from a prior test could cause `rfqApplyEmailParse()` in a later, unrelated test to silently act on a stale target. Every test exercising the Apply/Discard path must either drive the full open→parse→apply/discard sequence (which clears both vars as its last step, same discipline as `saveRfqResponse()` clearing `cRfqEditId`) or explicitly reset both to `null` in its setup.

---

## 3. New function: `renderRfqComparison()` — row markup + shared panel div

**File:** `index.html:3264-3304` (full current function body already read and confirmed current)

**Current row-building tail (`index.html:3294-3298`):**
```js
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="ordCommitRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">' + (committed ? 'Uncommit' : 'Commit') + '</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="editRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Edit</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;border-color:var(--cr);color:var(--cr);" onclick="delRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Del</button>' +
      '</td>' +
      '</tr>';
```

**New:**
```js
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="ordCommitRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">' + (committed ? 'Uncommit' : 'Commit') + '</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="editRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Edit</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;border-color:var(--cr);color:var(--cr);" onclick="delRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Del</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 4px;" onclick="rfqOpenEmailParse(\'' + lineId + '\',\'' + r.id + '\')" title="Parse update from email">&#9993;</button>' +
      '</td>' +
      '</tr>';
```

**Current panel tail (`index.html:3301-3303`):**
```js
  panel.innerHTML = rfqStalenessWarn(responses) +
    '<table class="tbl" style="font-size:.5rem;width:100%;"><thead><tr><th>Supplier</th><th>Unit Cost</th><th>Landed (GBP)</th><th>MOQ</th><th>Lead Time</th><th>Payment Terms</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;margin-top:4px;" onclick="openRfqResponse(\'' + lineId + '\')">+ Add Response</button>';
```

**New:**
```js
  panel.innerHTML = rfqStalenessWarn(responses) +
    '<table class="tbl" style="font-size:.5rem;width:100%;"><thead><tr><th>Supplier</th><th>Unit Cost</th><th>Landed (GBP)</th><th>MOQ</th><th>Lead Time</th><th>Payment Terms</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<div id="ord-rfq-emailparse-' + lineId + '" style="display:none;margin-top:6px;"></div>' +
    '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;margin-top:4px;" onclick="openRfqResponse(\'' + lineId + '\')">+ Add Response</button>';
```

**Deliberate consequence, noted so build-gate doesn't mistake it for a bug:** because `renderRfqComparison()` rebuilds the entire panel (including this new div) on every call — after Commit/Uncommit, after an Edit/Del save, after `+ Add Response` — any open, in-progress email-parse panel is silently wiped (reset to `display:none`, empty) whenever the comparison panel re-renders for an unrelated reason. This is the same "no early exit" characteristic the panel already has for the table itself, and it's the right behavior here: it prevents a stale parse-in-progress UI (referencing a response that may have just been edited/deleted by the very re-render that triggered it) from lingering. `cRfqEmailParseRespId`/`cRfqEmailParseProposed`, however, are **not** cleared by a re-render alone (only by `rfqCloseEmailParse()`/a completed Apply) — see §6's note on why this is harmless.

---

## 4. New function: `rfqOpenEmailParse(lineId, responseId)`

**File:** insert immediately after `renderRfqComparison()` closes (after `index.html:3304`).

```js
function rfqOpenEmailParse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var resp = (line.rfqResponses || []).find(function(r){ return r.id === responseId; });
  if (!resp) return;
  var panel = G('ord-rfq-emailparse-' + lineId);
  if (!panel) return;
  cRfqEmailParseRespId = responseId;
  cRfqEmailParseProposed = null;
  var sup = DB.sup.find(function(s){ return s.id === resp.supId; });
  var supName = sup ? san(sup.name) : '(supplier deleted)';
  panel.style.display = 'block';
  panel.innerHTML = '<div style="border:1px solid var(--ln);border-radius:4px;padding:6px;">' +
    '<div style="font-size:.5rem;margin-bottom:4px;">Parse update from email — ' + supName + '</div>' +
    '<div style="font-size:.46rem;color:var(--m);margin-bottom:4px;">Paste only the pricing-relevant portion of the email.</div>' +
    '<textarea id="rfq-emailparse-text-' + lineId + '" rows="4" style="width:100%;font-size:.5rem;"></textarea>' +
    '<div style="margin-top:4px;">' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqRunEmailParse(\'' + lineId + '\')">Parse</button> ' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseEmailParse(\'' + lineId + '\')">Cancel</button>' +
    '</div>' +
  '</div>';
}
```

Existence guards mirror `editRfqResponse()`/`delRfqResponse()`'s exact style (`index.html:3153-3163`, `3219-3227`) — same order of checks (`EI.ord` → ord → line → response), same silent-return-on-miss convention.

**Note on the inline copy:** "Paste only the pricing-relevant portion of the email" is the exact mitigation copy REQ-AI-GAP-011b's §8-revised text specifies for the PII input-scoping residual risk — implemented verbatim, not paraphrased, so a future reader comparing REQ to code sees the same words.

---

## 5. New function: `rfqCloseEmailParse(lineId)`

```js
function rfqCloseEmailParse(lineId) {
  cRfqEmailParseRespId = null;
  cRfqEmailParseProposed = null;
  var panel = G('ord-rfq-emailparse-' + lineId);
  if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
}
```

Serves both **Cancel** (before a parse has run) and **Discard** (after a parse produced a proposal) — both are "abandon whatever's in progress, change nothing" and need no different behavior, matching AC-7's requirement exactly (nothing on the response or panel changes beyond hiding the parse UI).

---

## 6. New function: `rfqRunEmailParse(lineId)`

```js
function rfqRunEmailParse(lineId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var responseId = cRfqEmailParseRespId;
  var resp = (line.rfqResponses || []).find(function(r){ return r.id === responseId; });
  if (!resp) return;
  var panel = G('ord-rfq-emailparse-' + lineId);
  if (!panel) return;
  var textEl = G('rfq-emailparse-text-' + lineId);
  var emailText = (textEl && textEl.value || '').trim();
  if (!emailText) { toast('Paste the email text first.'); return; }
  panel.innerHTML = '<div style="color:var(--m);">Parsing…</div>';
  rfqParseUpdateFromEmail(emailText, resp).then(function(result){
    if (G('ord-rfq-emailparse-' + lineId) !== panel) return;
    if (result === null) {
      panel.innerHTML = '<div style="color:var(--m);">AI parse unavailable.</div>' +
        '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseEmailParse(\'' + lineId + '\')">Close</button></div>';
      return;
    }
    var fields = Object.keys(result);
    if (!fields.length) {
      panel.innerHTML = '<div style="color:var(--m);">No new commercial terms found in that email.</div>' +
        '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseEmailParse(\'' + lineId + '\')">Close</button></div>';
      return;
    }
    cRfqEmailParseProposed = result;
    var rows = fields.map(function(f){
      var oldVal = resp[f] != null && resp[f] !== '' ? String(resp[f]) : '(unset)';
      return '<div>' + san(f) + ': ' + san(oldVal) + ' &rarr; <strong>' + san(String(result[f])) + '</strong></div>';
    }).join('');
    panel.innerHTML = '<div style="font-size:.5rem;">' + rows + '</div>' +
      '<div style="margin-top:4px;">' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqApplyEmailParse(\'' + lineId + '\')">Apply</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseEmailParse(\'' + lineId + '\')">Discard</button>' +
      '</div>';
  });
}
```

**Design note on the `G(id) !== panel` staleness guard:** copied directly from `ordCheckLineGaps()`'s exact pattern (`index.html:3078`) — if the comparison panel re-renders (e.g. the operator clicks Commit on a different row) while a parse `fetch()` is still in flight, the async callback's `panel` reference is now a detached/replaced element; without this guard, the stale result would be written into a DOM node the user can no longer see or interact with, and — worse — silently repopulate a since-closed panel with an outdated review. This is exactly the async-staleness class of bug the two precedent functions already guard against, applied identically here.

---

## 7. New function: `rfqApplyEmailParse(lineId)`

```js
function rfqApplyEmailParse(lineId) {
  var responseId = cRfqEmailParseRespId;
  var proposed = cRfqEmailParseProposed;
  if (!responseId || !proposed) return;
  editRfqResponse(lineId, responseId);
  if (proposed.cost !== undefined) G('rfq-cost').value = proposed.cost;
  if (proposed.currency !== undefined) G('rfq-cur').value = proposed.currency;
  if (proposed.moq !== undefined) G('rfq-moq').value = proposed.moq;
  if (proposed.leadTime !== undefined) G('rfq-leadtime').value = proposed.leadTime;
  if (proposed.paymentTerms !== undefined) G('rfq-payterms').value = proposed.paymentTerms;
  if (proposed.notes !== undefined) G('rfq-notes').value = proposed.notes;
  saveRfqResponse();
  cRfqEmailParseRespId = null;
  cRfqEmailParseProposed = null;
}
```

**This is the load-bearing reuse the REQ specifically calls for (§2c: "calls REQ-ORD-006's `editRfqResponse()`/`saveRfqResponse()` edit path with the merged field values").** Walking through why this satisfies AC-6 exactly, not just approximately:

1. `editRfqResponse(lineId, responseId)` (unmodified, `index.html:3153-3163`) opens the edit modal, sets `cRfqEditId = responseId`, and pre-fills every form field — including the six fields the AI proposal might overwrite — from the response's **current** values.
2. This function then overwrites only the fields present in `proposed` (the AI found evidence for), leaving every other field exactly as `editRfqResponse()` already set it — this is what "merged field values: old values for anything the AI didn't address, proposed values for what it did" (REQ §2c) means in practice, and it falls out for free from calling the real pre-fill function first rather than constructing a merged object by hand.
3. `saveRfqResponse()` (unmodified, `index.html:3184-3216`) then runs its real edit path: `wasEditing` is true (since `cRfqEditId` is set), so it replaces the response in place with a **new `uid()`**, repoints `line.committedResponseId` if this was the committed response, persists, and re-renders the comparison panel — identically to a human manually editing the same fields and clicking Save. AC-6's "including REQ-ORD-006's new-id-and-repoint behavior if the response is committed" is therefore not something this function has to reimplement or even know about — it's inherited automatically by calling the real function.
4. `renderRfqComparison(cRfqLineId)` (called inside `saveRfqResponse()`) rebuilds the panel, which per §3 already wipes the `ord-rfq-emailparse-<lineId>` div back to hidden/empty — so no separate call to close the parse panel is needed here; the state vars are cleared explicitly for cleanliness (so a stray unrelated later click on a leftover reference can't act on a stale target), but the DOM cleanup is already handled by the re-render.

**No existence guard duplicated here on purpose:** `editRfqResponse()`/`saveRfqResponse()` already carry their own full guard chains (`EI.ord`, ord, line, response existence for the former; ord/line existence for the latter). Re-guarding in this function before delegating to them would be redundant, not defensive — if `responseId` no longer resolves to a real response (e.g. it was deleted by another tab/panel action between parse and Apply, an edge case with no realistic reproduction path in a single-operator, single-tab tool but worth naming), `editRfqResponse()` itself silently returns and the modal never opens; the two `G('rfq-cost')`-style field-sets that follow would then be writing into stale/nonexistent form-field references from a previous open, which `saveRfqResponse()` immediately overwrites into a real state on its own guard (`ord`/`line` lookups fail there too, since `cRfqOrdId`/`cRfqLineId` were never reset by the failed `editRfqResponse()` call and could be stale) — resolving to `saveRfqResponse()`'s own `if (!line) { closeM('ov-rfq'); return; }` early-out. Net effect: a no-op, not a crash or silent corruption. Acceptable for the same reason REQ-ORD-006 accepted its own analogous theoretical race (SPEC-ORD-006's build-gate review, advisory 2) — vanishingly unlikely in this app's actual single-operator usage pattern, and fails safe rather than silently.

---

## 8. New function: `rfqParseUpdateFromEmail(emailText, currentResponse)`

**File:** insert after `rfqApplyEmailParse()`, alongside the other two single-shot semantic-check functions (`ordCheckLineGapsSemantic()` at `index.html:3093`, `conCheckEnquirySemantic()` at `index.html:3308`) — placing it near `conCheckEnquirySemantic()` keeps all three "scoped single-shot AI extraction" functions grouped, matching the codebase's existing informal grouping-by-purpose convention.

```js
var RFQ_EMAIL_PARSE_PROMPT = 'Given this email text and the current known values for one supplier\'s RFQ response, identify any of {cost, currency, moq, leadTime, paymentTerms, notes} that the email explicitly states a new/changed value for. Respond with ONLY a JSON object containing just the fields you found evidence for (omit fields the email doesn\'t address) — no prose, no markdown fences. Respond with an empty object {} if the email doesn\'t specify any new commercial terms.';
async function rfqParseUpdateFromEmail(emailText, currentResponse) {
  if (!AI.key) return null;
  var payload = {
    emailText: emailText,
    currentValues: {
      cost: currentResponse.cost, currency: currentResponse.currency,
      moq: currentResponse.moq, leadTime: currentResponse.leadTime, paymentTerms: currentResponse.paymentTerms
    }
  };
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
        system: RFQ_EMAIL_PARSE_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var text = (data.content || []).map(function(b){ return b.text || ''; }).join('');
    var parsed = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    var allowed = ['cost', 'currency', 'moq', 'leadTime', 'paymentTerms', 'notes'];
    var filtered = {};
    allowed.forEach(function(k){ if (parsed[k] !== undefined) filtered[k] = parsed[k]; });
    return filtered;
  } catch (e) {
    return null;
  }
}
```

**Two deliberate departures from a literal copy of the two precedent functions, both required by this REQ's own stated design, called out so they don't read as accidental drift at build-gate:**

1. **The `!Array.isArray(parsed)` guard becomes `!parsed || typeof parsed !== 'object' || Array.isArray(parsed)`.** REQ-AI-GAP-011b flags this explicitly (§2b, "Response-shape validation differs from the two precedent functions") — the contract here is an object, not an array, and `typeof [] === 'object'` in JS means a bare `typeof` check alone would wrongly accept an array. This exact three-part guard is what the REQ's own text prescribes; implemented verbatim.
2. **A whitelist-filter step the two precedent functions don't have** (`allowed`/`filtered`). Neither `ordCheckLineGapsSemantic()` nor `conCheckEnquirySemantic()` needs this because their `.filter()` over an array already discards any malformed array *item*; but a bare object has no equivalent per-item filtering by default — without this step, a hallucinated or off-schema key from the model (e.g. `notes2`, or a key matching some other Quote/RFQ field name the model conflates from context) would pass straight through to `rfqApplyEmailParse()`'s field-by-field `G(...).value = proposed[f]` writes... except it wouldn't, actually, because `rfqApplyEmailParse()` only reads six named keys off `proposed` by name, ignoring anything else present. **So this filter is not strictly load-bearing for correctness given `rfqApplyEmailParse()`'s current implementation — but it is load-bearing for the REQ's own explicit claim** (§2b: "Restricting the response schema to commercial fields only... reduces what comes back and gets stored") to actually be true of the *data*, not merely true of what one caller happens to read from it. Implemented so the function's own return value honors that claim directly, rather than relying on a downstream caller's incidental behavior to make it true — a latent trap if `rfqApplyEmailParse()` or a future caller were ever changed to iterate `Object.keys(proposed)` generically instead of naming fields explicitly.

**Payload shape matches REQ §2b's literal wording exactly** — `currentValues` carries `{cost, currency, moq, leadTime, paymentTerms}`, deliberately **not** `notes`, even though `notes` is one of the six fields the prompt asks the model to extract. This is not an oversight: the REQ's own §2b text lists exactly these five as "the response's current known values... as context," and the diff-review UI (§6 above) never needs the AI to have known the old `notes` value — it reads `resp.notes` directly from the local record for the "old value" side of the diff, independent of what was sent to the model. Preserved as specified rather than "fixed" to look more symmetric.

---

## 9. `AI_SYSTEM_PROMPT` update (REQ-AI-GAP-011d)

**File:** `index.html:8919` — the entry REQ-ORD-006 added, extend it (do not add a fully separate new prompt line; this is a continuation of the same feature-area description a fresh reader would look at first).

**Current:**
```js
  'Edit and delete RFQ responses (v2.9.69, REQ/SPEC-ORD-006): each response row in "Compare RFQs" now has Edit and Delete buttons alongside Commit/Uncommit. Edit reopens the same "+ Add Response" modal pre-filled with that response\'s values; saving replaces it in place (same position, same count of responses) rather than adding a new one. Delete removes a response outright; if it is the line\'s currently committed response, the operator sees an explicit warning before confirming that this will un-commit the line and may trigger the staleness banner described above on any Quote already converted from it — deleting or editing the specific response a Quote was sourced from re-triggers that same staleness banner, exactly as committing a different response already did.',
```

**New (appended sentence, same line):**
```js
  'Edit and delete RFQ responses (v2.9.69, REQ/SPEC-ORD-006): each response row in "Compare RFQs" now has Edit and Delete buttons alongside Commit/Uncommit. Edit reopens the same "+ Add Response" modal pre-filled with that response\'s values; saving replaces it in place (same position, same count of responses) rather than adding a new one. Delete removes a response outright; if it is the line\'s currently committed response, the operator sees an explicit warning before confirming that this will un-commit the line and may trigger the staleness banner described above on any Quote already converted from it — deleting or editing the specific response a Quote was sourced from re-triggers that same staleness banner, exactly as committing a different response already did. Each response row also has an envelope (✉) button (v2.9.70, REQ/SPEC-AI-GAP-011, only functional if a Claude API key is configured) — the operator pastes a supplier\'s email text, and a single AI call extracts any of cost/currency/MOQ/lead time/payment terms/notes the email explicitly states a new value for, shown as a before/after diff for the operator to Apply or Discard; nothing is applied automatically, and Apply goes through the exact same edit mechanism described above, including the id-rotation/staleness-banner behavior if the response is committed. If asked whether the chat assistant itself can do this from a pasted email, say no — direct the operator to this button on the specific response instead, since that is the only place this capability exists.',
```

**Rationale for the "if asked... say no" sentence:** this is the exact scenario REQ-AI-GAP-011d names as the reason for this update at all — the operator's original question that produced this REQ was asked to the general chat assistant's mental model of the app, not this feature. Without this sentence, a future operator asking the chat "can you read this email and update the quote" would get an answer synthesized from the rest of the prompt with no way to know a dedicated, non-conversational button already does exactly that — reproducing the same gap in a different form.

---

## 10. Explicitly unchanged (confirmed by this spec, not just asserted by the REQ)

- `editRfqResponse()`, `saveRfqResponse()`, `delRfqResponse()` (`index.html:3153-3227`) — zero modifications. Every AC-6 guarantee is inherited by calling these functions exactly as they exist post-REQ-ORD-006, not by re-deriving their behavior.
- `renderQteSourceDriftWarn()` — zero modifications; this REQ never touches Quotes directly, only RFQ responses, and inherits REQ-ORD-006's staleness-banner behavior transitively through §7's reuse.
- No `FIELD_MAPS`/Sheets-sync footprint added — `rfqResponses[]` already has none (per REQ-ORD-006/QTE-001 Part B precedent), and this REQ adds no new persisted field, only transient front-end state.
- `AI_TOOLS` (the chat-assistant tool-call schema array) — unchanged. Confirmed by direct search: no `get_rfq_responses` or similar entry exists anywhere in `index.html`, matching REQ §3's explicit non-goal.

---

## 11. Test plan

Follows `SPEC-ORD-006-v1.md §7`'s established pattern and REQ-AI-GAP-011 §5 exactly.

**AC-1 through AC-4 (`rfqParseUpdateFromEmail()` itself)** — reuse the existing `_mockAnthropic`/mock-`fetch` harness already present in `tests/run.js` (the same one `ordCheckLineGapsSemantic()`'s and `conCheckEnquirySemantic()`'s tests use), do not build a second mocking mechanism:
- AC-1: `AI.key` unset → resolves `null`, confirm no `fetch` call was made (same assertion style as the existing `ordCheckLineGapsSemantic(): no AI.key configured → resolves null, no fetch call` test).
- AC-2: mock a response naming only `cost`/`currency` → confirm the returned object has exactly those two keys (`Object.keys(result).sort()`), nothing else — this is also the test that exercises the whitelist-filter's actual necessity, so additionally mock a response that includes an out-of-schema key (e.g. `foo`) alongside `cost` and assert the returned object never contains `foo` — proving §8's filter is real, not vestigial.
- AC-3: mock an empty-object response `{}` → confirm `rfqParseUpdateFromEmail()` resolves to `{}`, not `null`.
- AC-4: mock a network-throwing `fetch` and, separately, a non-`ok` response → both resolve `null` (two tests, mirroring the existing precedent's own two-test split for this case).
- Additional non-REQ-numbered but necessary case: mock a response that is a JSON **array** (not an object) → confirm `null` (this is the specific case the three-part guard in §8 exists to catch that a bare `Array.isArray` check would miss).

**AC-5 through AC-7 (DOM/DB-state, no AI dependency)** — reuse `mkOrdWithLine()` (`tests/run.js:7315-7325`) for the base fixture, and `mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()` (`tests/run.js:7929-7952`, current post-merge line numbers) for the AC-6 committed-response/staleness-banner case, exactly as `SPEC-ORD-006`'s own AC-4/AC-5 tests did — do not build new fixtures for either half:
- AC-5: seed a line with one response, call `rfqOpenEmailParse()`, directly set `cRfqEmailParseProposed` (bypassing the mocked-AI round trip, since this AC is about persistence timing, not extraction correctness) to a proposed change, and assert `line.rfqResponses` is byte-identical before and after, up until `rfqApplyEmailParse()` is actually called.
- AC-6 (two variants, both required): (a) non-committed response — Apply → response replaced in place with a new id and the proposed fields applied, mirroring `SPEC-ORD-006`'s own "edit mode replaces the entry in place with a new id" test structure exactly; (b) committed response, with a Quote already converted from it via `mkOrdWithCommittedResponse()`/`ordConvertToQuote()`/`saveQte()` — Apply → `committedResponseId` repoints to the new id, and calling `renderQteSourceDriftWarn(qt)` afterward now shows the "Source pricing has changed" banner, mirroring `SPEC-ORD-006`'s own AC-4 mutation-verified test. This is the single highest-value test in this spec: it is the concrete proof that this REQ's Apply path genuinely inherits REQ-ORD-006's staleness mechanism rather than merely being designed to.
- AC-7: after a successful parse (proposal populated), call `rfqCloseEmailParse()` (Discard) → assert `line.rfqResponses` unchanged and the panel `innerHTML` is empty/hidden; separately, calling `rfqCloseEmailParse()` from the pre-parse state (Cancel) → same assertions, proving one function correctly serves both cases as designed in §5.

**Test-isolation requirement (§2):** every test above must either drive the full flow to its natural clearing point (`rfqApplyEmailParse()` or `rfqCloseEmailParse()`, both of which null both module vars) or explicitly reset `ctx.cRfqEmailParseRespId = null; ctx.cRfqEmailParseProposed = null;` in `resetDB()`-adjacent setup — mirroring the exact discipline `SPEC-ORD-006`'s test plan already established for `cRfqEditId`.

**Layout/UI test:** confirm `renderRfqComparison()`'s row HTML contains the new envelope button wired to `rfqOpenEmailParse('<lineId>','<respId>')` for each response — mirroring `SPEC-ORD-006`'s own AC-7 button-presence test pattern (`tests/run.js`, "each response row shows Edit and Delete buttons..."). Also confirm the shared `ord-rfq-emailparse-<lineId>` div exists in the panel's rendered output (present, `display:none`) so `rfqOpenEmailParse()` has somewhere real to populate.

---

## 12. Version-ship housekeeping (on completion)

Per `CLAUDE.md`'s standing checklist and REQ-AI-GAP-011 §7:
- Version bump (next: v2.9.70), test count, in-app changelog, `docs/version-history.md`.
- `docs/requirements-tracker.md`: move the REQ-AI-GAP-011 backlog row (currently under "Backlog / unscoped," added when REQ-ORD-006 shipped) into the Active requirements table with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates; remove the now-resolved "next step" backlog row for REQ-AI-GAP-011 added in the previous delivery.
- `AI_SYSTEM_PROMPT`: done in §9 above, as part of this spec's own diff, not deferred to a separate housekeeping pass — matching how REQ-ORD-006 handled its own mandatory prompt update.
- `docs/user-guide.md`: add a short paragraph to the existing "Comparing supplier quotes (RFQ comparison)" section (`docs/user-guide.md:43-51`) describing the envelope button, mirroring how REQ-ORD-006's own housekeeping extended that same section for Edit/Delete.
