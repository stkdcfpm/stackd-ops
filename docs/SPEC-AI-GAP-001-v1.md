# SPEC-AI-GAP-001 v1 — AI Order Flow Actions

**Requirement:** REQ-AI-GAP-001-v1.md  
**Version target:** v2.9.30  
**Status:** Awaiting spec-gate

---

## Overview

Parse the AI assistant's streamed response for an embedded `@@ACTION...@@END` block. Strip it from the displayed text. Render a pre-fill button below the reply that opens the target modal with fields pre-populated. No record is created without explicit operator Save. No new `K` key, no new `DB` entity, no test harness changes required.

---

## §1 — Action block format

The block is embedded in the AI reply text as follows:

```
@@ACTION
{"action":"create_po","payload":{...}}
@@END
```

- `@@ACTION` and `@@END` are literal sentinel strings on their own lines.
- Everything between them is a single JSON object.
- The block may appear anywhere in the reply (beginning, middle, or end).
- The block is stripped from displayed text and the button is rendered separately.
- If the JSON between the sentinels is malformed, the block is stripped but no button is rendered and no error is thrown (AC-8).

---

## §2 — `parseAIAction(text)` helper

Add before `sendAIMsg()`:

```js
function parseAIAction(text) {
  var start = text.indexOf('@@ACTION');
  var end = text.indexOf('@@END');
  if (start === -1 || end === -1 || end <= start) return { clean: text, action: null };
  var jsonStr = text.slice(start + 8, end).trim();
  var clean = (text.slice(0, start) + text.slice(end + 5)).replace(/\n{3,}/g, '\n\n').trim();
  try {
    var parsed = JSON.parse(jsonStr);
    if (parsed && parsed.action && parsed.payload) {
      return { clean: clean, action: parsed };
    }
    return { clean: clean, action: null };
  } catch(e) {
    return { clean: clean, action: null };
  }
}
```

Returns `{ clean: string, action: object|null }`.
- `clean` — reply text with action block removed (shown to operator).
- `action` — parsed `{ action, payload }` object, or `null` if absent/malformed.

---

## §3 — `handleAIAction(action)` function

Add before `sendAIMsg()`:

```js
function handleAIAction(action) {
  var p = action.payload || {};
  if (action.action === 'create_po') {
    openPO();
    if (p.supId)  G('pf-sup').value = p.supId;
    if (p.cur)    G('pf-cur').value = p.cur;
    if (p.notes)  G('pf-nt').value  = p.notes;
    if (Array.isArray(p.lineItems)) {
      cPL = p.lineItems.map(function(li){
        return { rid: uid(), lid: '', desc: li.desc||'', sku: li.sku||'', uom: li.uom||'', qty: +li.qty||1, cost: +li.cost||0 };
      });
      rPLT(); calcPO();
    }
  } else if (action.action === 'create_quote') {
    openQte();
    if (p.client)       G('qf-client').value = p.client;
    if (p.freightMode)  G('qf-mode').value   = p.freightMode;
    if (p.currency)     G('qf-cur').value    = p.currency;
    if (p.notes)        G('qf-nt').value     = p.notes;
    if (Array.isArray(p.lineItems)) {
      cQL = p.lineItems.map(function(li){
        return { rid: uid(), lid: '', desc: li.desc||'', sku: li.sku||'', uom: li.uom||'pcs', qty: +li.qty||1, cost: +li.cost||0, dutyPct: +li.dutyPct||0, hsCode: li.hsCode||'' };
      });
      rQLT(); calcQte();
    }
  } else if (action.action === 'create_shipment') {
    openShp();
    if (p.ref)         G('shf-ref').value = p.ref;
    if (p.originPort)  G('shf-op').value  = p.originPort;
    if (p.destPort)    G('shf-dp').value  = p.destPort;
    if (p.etd)         G('shf-etd').value = p.etd;
    if (p.eta)         G('shf-eta').value = p.eta;
    if (p.notes)       G('shf-nt').value  = p.notes;
  } else if (action.action === 'create_contact') {
    openCon();
    if (p.name)    G('ct-name').value    = p.name;
    if (p.email)   G('ct-email').value   = p.email;
    if (p.phone)   G('ct-phone').value   = p.phone;
    if (p.company) G('ct-company').value = p.company;
    if (p.status)  G('ct-status').value  = p.status;
    if (p.source)  G('ct-source').value  = p.source;
  } else {
    toast('Unsupported action type');
  }
}
```

Key implementation notes:
- All field assignments are guarded by truthiness checks — falsy/missing payload fields are silently ignored.
- `openPO()` resets `cPL = []` before we set it, so line item injection must happen **after** `openPO()`.
- `openQte()` resets `cQL = []` likewise — same pattern.
- Quote pre-fill does not trigger versioning — versioning only fires on `saveQte()`, not on `openQte()` or field mutation.
- `openCon()` now accepts an optional `prefillSupplierId` parameter (v2.9.29) — calling it with no argument is safe.

---

## §4 — `sendAIMsg()` changes

### 4.1 Post-stream processing

After the stream completes (after `replyEl.textContent = fullText` has been set and before `_aiHistory.push(...)`) in the streaming loop, replace:

**BEFORE (end of streaming while-loop, just before `_aiHistory.push`):**
```js
    _aiHistory.push({ role: 'assistant', content: fullText });
```

**AFTER:**
```js
    var parsed = parseAIAction(fullText);
    replyEl.textContent = parsed.clean;
    if (parsed.action) {
      var actionLabels = { create_po: 'PO', create_quote: 'Quote', create_shipment: 'Shipment', create_contact: 'Contact' };
      var label = actionLabels[parsed.action.action] || parsed.action.action;
      var btn = document.createElement('button');
      btn.className = 'btn btn-s';
      btn.style.cssText = 'font-size:.5rem;margin-top:8px;display:block;';
      btn.textContent = '▶ Review in ' + label + ' form';
      (function(a){ btn.onclick = function(){ handleAIAction(a); }; })(parsed.action);
      replyEl.appendChild(btn);
    }
    _aiHistory.push({ role: 'assistant', content: parsed.clean });
```

The `_aiHistory` is updated with `parsed.clean` (action block stripped) so the AI does not re-receive the `@@ACTION` sentinel in subsequent turns.

### 4.2 Error handler — no change

The existing `catch(e)` block is unchanged. If the stream fails, `fullText` is never processed by `parseAIAction`.

---

## §5 — `AI_SYSTEM_PROMPT` update

Append the following to `AI_SYSTEM_PROMPT` (as a new array entry, after the last existing entry):

```js
'ACTION BLOCKS: When the user clearly requests creation of a PO, Quote, Shipment, or Contact and sufficient detail is present, embed an action block in your reply — on its own lines, AFTER your conversational text:\n@@ACTION\n{"action":"<key>","payload":{<fields>}}\n@@END\n\nSupported keys and payload fields:\ncreate_po → { supId, cur, notes, lineItems:[{desc,qty,cost,uom}] }\ncreate_quote → { client, freightMode, currency, notes, lineItems:[{desc,qty,cost,uom,hsCode,dutyPct}] }\ncreate_shipment → { ref, originPort, destPort, etd, eta, notes }\ncreate_contact → { name, email, phone, company, status, source }\n\nOnly emit a block when the request is unambiguous and key fields are present. If detail is missing, ask a clarifying question instead. Never emit a block for edit/delete operations. The user reviews and confirms before anything is saved.',
```

---

## §6 — Tests

No `tests/run.js` changes required for the streaming flow (cannot be unit-tested in the VM sandbox as `fetch` is mocked). The `parseAIAction` and `handleAIAction` functions can be tested:

### 6.1 `parseAIAction` tests

Append after the existing AI or Contacts test blocks in `tests/run.js`:

```js
// ── REQ-AI-GAP-001: AI action block parsing ──────────────────────────────

test('parseAIAction: strips block and returns action from valid response', function() {
  var text = 'Sure, here is the PO.\n@@ACTION\n{"action":"create_po","payload":{"cur":"USD","notes":"Test"}}\n@@END\nPlease review.';
  var result = ctx.parseAIAction(text);
  assert.ok(result.action !== null, 'action parsed');
  assert.strictEqual(result.action.action, 'create_po', 'action key correct');
  assert.ok(result.clean.indexOf('@@ACTION') === -1, 'block stripped from clean');
  assert.ok(result.clean.indexOf('@@END') === -1, '@@END stripped');
  assert.ok(result.clean.indexOf('Sure, here is the PO') >= 0, 'surrounding text preserved');
});

test('parseAIAction: returns null action when no block present', function() {
  var text = 'Here is some info about POs.';
  var result = ctx.parseAIAction(text);
  assert.strictEqual(result.action, null, 'no action');
  assert.strictEqual(result.clean, text, 'text unchanged');
});

test('parseAIAction: returns null action and strips block on malformed JSON (AC-8)', function() {
  var text = 'OK.\n@@ACTION\nnot-valid-json\n@@END\nDone.';
  var result = ctx.parseAIAction(text);
  assert.strictEqual(result.action, null, 'action null on bad JSON');
  assert.ok(result.clean.indexOf('@@ACTION') === -1, 'block stripped');
  assert.ok(result.clean.indexOf('not-valid-json') === -1, 'bad JSON not in clean text');
});

test('parseAIAction: returns null action when JSON missing action key', function() {
  var text = '@@ACTION\n{"payload":{"cur":"USD"}}\n@@END';
  var result = ctx.parseAIAction(text);
  assert.strictEqual(result.action, null, 'null when action key absent');
});

test('handleAIAction: create_po pre-fills cPL and fields', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.p = null;
  ctx.cPL = [];
  var action = { action: 'create_po', payload: { supId: 'S1', cur: 'CNY', notes: 'Rush order', lineItems: [{ desc: 'Widget A', qty: 100, cost: 5.5, uom: 'pcs' }] } };
  ctx.handleAIAction(action);
  assert.strictEqual(mockEl('pf-cur').value, 'CNY', 'currency pre-filled');
  assert.strictEqual(mockEl('pf-nt').value, 'Rush order', 'notes pre-filled');
  assert.strictEqual(ctx.cPL.length, 1, 'line item added to cPL');
  assert.strictEqual(ctx.cPL[0].desc, 'Widget A', 'line item desc correct');
  assert.strictEqual(ctx.cPL[0].qty, 100, 'line item qty correct');
});

test('handleAIAction: unknown action shows toast, no modal (AC-9)', function() {
  ctx.resetDB();
  var toasted = '';
  var origToast = ctx.toast;
  ctx.toast = function(m){ toasted = m; };
  ctx.handleAIAction({ action: 'delete_everything', payload: {} });
  ctx.toast = origToast;
  assert.ok(toasted.indexOf('Unsupported') >= 0, 'unsupported toast shown');
});

test('handleAIAction: create_contact pre-fills contact modal fields', function() {
  ctx.resetDB();
  var action = { action: 'create_contact', payload: { name: 'Jane Smith', email: 'jane@example.com', phone: '+44 7700 000000', company: 'Acme', status: 'lead', source: 'chat' } };
  ctx.handleAIAction(action);
  assert.strictEqual(mockEl('ct-name').value, 'Jane Smith', 'name pre-filled');
  assert.strictEqual(mockEl('ct-email').value, 'jane@example.com', 'email pre-filled');
  assert.strictEqual(mockEl('ct-status').value, 'lead', 'status pre-filled');
});
```

---

## §7 — Version delivery

On completion:
- CLAUDE.md: bump to `v2.9.30`, update Test count
- `docs/version-history.md`: prepend v2.9.30 row
- `docs/known-gaps.md`: close AI-GAP-001 (resolved v2.9.30, narrow scope delivered)
- `AI_SYSTEM_PROMPT`: already updated in §5
- In-app changelog: prepend v2.9.30 block
- Raise PR to `claude/amazing-galileo-4hhygo`

---

## Scope boundaries

| In scope | Out of scope |
|---|---|
| `parseAIAction()` — block detection and stripping | Edit/delete/multi-step agentic flows (v3.0.x) |
| `handleAIAction()` — 4 modal pre-fill actions | Server-side AI proxy (v3.0.x) |
| Pre-fill button in chat pane | Automatic form submission |
| AI_SYSTEM_PROMPT action block instructions | New localStorage entity or K key |
| 7 unit tests for parse/handle functions | Streaming fetch test (VM-untestable) |

---

## Manual QA checklist

- [ ] AC-1: Ask AI "Create a PO for 100 pcs Widget A from ACME at $5 each" — action block stripped, "Review in PO form" button appears
- [ ] AC-2: Ask AI a general Q&A question — no button appears
- [ ] AC-3: Click PO button — PO modal opens with line items and fields pre-filled; Cancel → no record created
- [ ] AC-4: Click Quote button — Quote modal opens with line items pre-filled; Cancel → no record
- [ ] AC-5: Click Shipment button — Shipment modal opens with ports/dates pre-filled
- [ ] AC-6: Click Contact button — Contact modal opens with name/email pre-filled
- [ ] AC-7: Pre-fill any modal, click Cancel — DB.con/DB.po/DB.qt/DB.sh unchanged
- [ ] AC-8: Manually inject malformed `@@ACTION` block in a test message — text shown without block, no button, no error
- [ ] AC-9: Manually inject unknown action key — "Unsupported action type" toast shown
