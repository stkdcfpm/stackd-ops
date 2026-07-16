# SPEC-ORD-005-v1: Manual per-line gap detection for Order Request lines

**Implements:** REQ-ORD-005-v4 (requirements-gate PASS)

## 1. Structural gap check (`ordLineGaps()`, new, pure function)

Placed near the other `ord*` helpers, e.g. immediately before `rOrdLines()` (`index.html:2569`):

```js
function ordLineGaps(line) {
  var gaps = [];
  if (!line.packingSpec) gaps.push({ field: 'packingSpec', label: 'Packing spec' });
  if (!line.baseUom) gaps.push({ field: 'baseUom', label: 'Base UOM' });
  if (line.baseQty === null || line.baseQty === undefined || line.baseQty === '') gaps.push({ field: 'baseQty', label: 'Base qty' });
  if (!line.sourceCountry) gaps.push({ field: 'sourceCountry', label: 'Source country' });
  if (line.qtyStatus === 'Unknown') gaps.push({ field: 'qtyStatus', label: 'Qty status (Unknown)' });
  return gaps;
}
```

Pure, synchronous, no DOM/AI access — directly satisfies REQ-ORD-005a and is independently testable (AC-001/AC-002).

## 2. UI: "Check gaps" trigger and result panel (`rOrdLines()`, `index.html:2569-2586`)

Add a button per line and an empty result container (`ord-gapchk-<lineId>`), rendered but hidden until triggered:

```js
function rOrdLines(ord) {
  var el = G('of-lines-list'); if (!el) return;
  if (!ord) { el.innerHTML = '<div style="font-size:.55rem;color:var(--m);">Save the Order Request first, then add line items.</div>'; return; }
  var lines = ord.lines || [];
  el.innerHTML = lines.map(function(l){
    var pending = (l.lineUpdates||[]).filter(function(u){ return !u.confirmedBy; });
    return '<div style="border:1px solid var(--ln);border-radius:4px;padding:6px;margin-bottom:6px;font-size:.55rem;">' +
      '<div><strong>' + san(l.category||'-') + '</strong> — ' + san(l.itemSpec||'-') + '</div>' +
      '<div>Order Volume: ' + san(String(l.orderVolumeQty||'')) + ' ' + san(l.orderVolumeUnit||'') + '</div>' +
      '<div>Packing: <span onclick="ordEditLineField(\'' + l.id + '\',\'packingSpec\')" style="cursor:pointer;text-decoration:underline;">' + san(l.packingSpec || '(unset)') + '</span></div>' +
      '<div>Base: <span onclick="ordEditLineField(\'' + l.id + '\',\'baseQty\')" style="cursor:pointer;text-decoration:underline;">' + san(l.baseQty != null ? String(l.baseQty) : '(unset)') + '</span> <span onclick="ordEditLineField(\'' + l.id + '\',\'baseUom\')" style="cursor:pointer;text-decoration:underline;">' + san(l.baseUom || '(unset)') + '</span></div>' +
      '<div>Status: <select onchange="ordSetLineStatus(\'' + l.id + '\', this.value)">' + ['Unknown','Estimated','Confirmed'].map(function(s){ return '<option value="' + s + '"' + (l.qtyStatus === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>' +
      (pending.length ? '<div style="color:var(--gold);">' + pending.length + ' pending update(s): ' + pending.map(function(u){
        return san(u.field) + ' → ' + san(String(u.newValue)) + ' (' + san(u.source) + ') <button class="btn btn-g" style="font-size:.4rem;padding:1px 4px;" onclick="ordConfirmLineUpdateUI(\'' + l.id + '\',\'' + u.id + '\')">Confirm</button>';
      }).join(' ') + '</div>' : '') +
      '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.4rem;padding:1px 4px;" onclick="ordCheckLineGaps(\'' + l.id + '\')">Check gaps</button></div>' +
      '<div id="ord-gapchk-' + l.id + '" style="display:none;margin-top:4px;"></div>' +
      '</div>';
  }).join('') || '<div style="font-size:.55rem;color:var(--m);">No line items yet</div>';
}
```

Only change to the existing function: one new button `<div>` and one new empty result `<div>` appended per line. Nothing else in the function changes (REQ-ORD-005b).

## 3. `ordCheckLineGaps(lineId)` — trigger handler

Placed after `rOrdLines()`:

```js
function ordCheckLineGaps(lineId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;

  var panel = G('ord-gapchk-' + lineId);
  if (!panel) return;
  panel.style.display = 'block';

  var structuralGaps = ordLineGaps(line);
  var structuralHtml = structuralGaps.length
    ? '<div style="color:var(--gold);">Missing: ' + structuralGaps.map(function(g){ return san(g.label); }).join(', ') + '</div>'
    : '<div style="color:var(--gn);">No structural gaps.</div>';
  panel.innerHTML = structuralHtml + '<div style="color:var(--m);">Checking for ambiguities…</div>';

  ordCheckLineGapsSemantic(line).then(function(result){
    if (G('ord-gapchk-' + lineId) !== panel) return; // panel replaced by a re-render/re-trigger meanwhile
    var semanticHtml;
    if (result === null) {
      semanticHtml = '<div style="color:var(--m);">AI ambiguity check unavailable.</div>';
    } else if (!result.length) {
      semanticHtml = '<div style="color:var(--gn);">No ambiguities flagged.</div>';
    } else {
      semanticHtml = '<div>' + result.map(function(item){
        return '<div style="margin-top:2px;">⚠ ' + san(item.issue) + ' — <em>' + san(item.question) + '</em></div>';
      }).join('') + '</div>';
    }
    panel.innerHTML = structuralHtml + semanticHtml;
  });
}
```

Re-triggering replaces `panel.innerHTML` outright each call (REQ-ORD-005e "nothing accumulates", AC-007); the `G('ord-gapchk-'+lineId) !== panel` guard is defensive only for the case where the Order Request modal is closed/re-rendered mid-flight (an already-established pattern for the app's other async DOM updates, and moot in `resetDB()`-based tests where `G()` returns a fresh mock per call — see Test Plan §5's approach of testing `ordCheckLineGapsSemantic()` directly rather than through DOM timing).

## 4. `ordCheckLineGapsSemantic(line)` — the scoped AI call (REQ-ORD-005c)

```js
var ORD_GAP_CHECK_PROMPT = 'You review a single trade order line for ambiguity or internal inconsistency (not for missing fields — that is handled separately). Given the line\'s fields as JSON, identify up to 3 issues where a value is present but vague, unclear, or does not reconcile with another field on the same line (e.g. a generic item description, a stated order volume that doesn\'t reconcile with the base unit/quantity, a category that doesn\'t match the described item). For each issue, phrase a specific, concrete question an operator could send to the buyer or supplier to resolve it. Respond with ONLY a JSON array (no prose, no markdown fences): [{"issue":"<short description>","question":"<specific question to send>"}]. Respond with an empty array [] if nothing is ambiguous.';

async function ordCheckLineGapsSemantic(line) {
  if (!AI.key) return null;
  var payload = {
    category: line.category, itemSpec: line.itemSpec,
    orderVolumeQty: line.orderVolumeQty, orderVolumeUnit: line.orderVolumeUnit,
    packingSpec: line.packingSpec, baseUom: line.baseUom, baseQty: line.baseQty,
    sourceCountry: line.sourceCountry, variantOption: line.variantOption, qtyStatus: line.qtyStatus
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
        system: ORD_GAP_CHECK_PROMPT,
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

Notes tying this to REQ:
- Payload is exactly the field list in REQ-ORD-005's GDPR Data Flow section — no `contactId`, no `DB.con` lookup, no `ord.id`/`num`, no `lineUpdates[]` (AC-008).
- No `AI_TOOLS`, no `tools:` param, no loop, no `_aiHistory` push, no chat modal interaction (REQ-ORD-005c).
- Bespoke `ORD_GAP_CHECK_PROMPT`, not `AI_SYSTEM_PROMPT`/`AI_COMPLIANCE_PROMPT` (REQ-ORD-005c).
- Any failure mode (`!AI.key`, non-200, malformed/non-JSON response, non-array response) resolves to `null`, uniformly handled by the caller as "unavailable" (REQ-ORD-005d, AC-004). No exception escapes this function.
- No `sv(K.ord, DB.ord)` call anywhere in this path — nothing is persisted (REQ-ORD-005e, AC-005).
- No new call site touches `ORD_TRANSITIONS` or the `index.html:2521` warning (REQ-ORD-005f, AC-006).
- No debounce/rate-limit added, matching REQ-ORD-005g.

## 5. Test plan (`tests/run.js`)

New suite `Order Request line gap detection (SPEC-ORD-005)`:

- `ordLineGaps()` — all 5 fields unset → all 5 gaps returned (AC-001).
- `ordLineGaps()` — all fields populated, `qtyStatus: 'Confirmed'` → empty array (AC-002).
- `ordLineGaps()` — `baseQty: 0` is a valid quantity, not a gap (only `null`/`undefined`/`''` count) — a boundary case the structural check must get right, since `0` is falsy but not "unset."
- `ordCheckLineGapsSemantic()` — `AI.key` unset → resolves `null`, no `fetch` call made (AC-004).
- `ordCheckLineGapsSemantic()` — `fetch` mocked to reject/network-error → resolves `null`, not a thrown exception (AC-004).
- `ordCheckLineGapsSemantic()` — `fetch` mocked to return a non-200 → resolves `null`.
- `ordCheckLineGapsSemantic()` — `fetch` mocked to return malformed (non-JSON-array) content text → resolves `null`.
- `ordCheckLineGapsSemantic()` — `fetch` mocked to return a well-formed `[{"issue":"...","question":"..."}]` payload → resolves the parsed array (AC-003, mechanism-only per REQ-ORD-005d).
- `ordCheckLineGapsSemantic()` — asserts the captured `fetch` call body's `messages[0].content` (JSON-parsed) contains only the 10 scoped fields — never `contactId`, `id`, `num`, or `lineUpdates` (AC-008, GDPR payload scoping).
- `ordCheckLineGaps()` DOM integration — asserts `DB.ord` is byte-identical (via `JSON.stringify` snapshot) before and after a full trigger + resolved promise, confirming no persistence (AC-005).
- `ordCheckLineGaps()` — triggering twice in a row on the same line with different mocked structural state (line edited between calls) reflects only current state, not stale first-call output (AC-007).

Existing `mockEl()` (`mockEl(id)` returns `{ value:'', checked:false, style:{}, classList:{} }`) needs `innerHTML` and `style.display` to already be settable plain properties — confirmed compatible with existing test patterns used for `rOrdLines()`'s own DOM assertions elsewhere in the suite; no harness change needed since these are plain object property writes, not method calls.

## Changelog

- v1: Initial spec implementing REQ-ORD-005-v4.
