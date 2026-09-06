# SPEC-AI-GAP-012 — AI-assisted RFQ response update from an uploaded supplier quote file (CSV)

**Status:** v1 — drafted, not yet independently spec-gate reviewed.
**Implements:** `docs/REQ-AI-GAP-012-v1.md` (requirements-gate complete: self-review §8 + independent second review §8b, CONDITIONAL PASS with all findings addressed).
**Touches:** `index.html` only. No `Code.gs`, no schema change, no `FIELD_MAPS` entry (matches REQ §3).

All line citations below were re-verified directly against the current `index.html` at spec-drafting time (line numbers have moved since the REQ was drafted, due to unrelated fixes shipped earlier the same session — do not trust the REQ document's own citations without re-checking).

---

## 1. New module-level state

**File:** `index.html:2920-2927` (immediately after the existing `cRfqEmailParseLineId`/`cRfqEmailParseRespId`/`cRfqEmailParseProposed` trio, which this feature's state deliberately parallels rather than duplicates in shape).

**Current:**
```js
var cRfqOrdId = null;
var cRfqLineId = null;
var cRfqEditId = null;
var cRfqEmailParseLineId = null;
var cRfqEmailParseRespId = null;
var cRfqEmailParseProposed = null;
```

**New (insert after line 2927):**
```js
var cRfqFileImportOrdId = null;
var cRfqFileImportPendingRows = null;
var cRfqFileImportProposals = {};
var cRfqFileImportApplyInFlight = false;
```

- **`cRfqFileImportOrdId`** records which Order Request the currently-open import panel and any live proposals belong to — mirrors `cRfqEmailParseLineId`'s staleness-guard role (§1 of `REQ-AI-GAP-012`, addendum), except keyed at the Order Request level rather than the line level, since one file-import run always targets exactly one Order Request (REQ Decision 2: the control lives once per Order Request, not per line).
- **`cRfqFileImportPendingRows`** holds the tokenized CSV rows between the Parse step and the operator's explicit Send-to-AI confirmation (REQ-AI-GAP-012c / AC-9) — transient only, never touching `DB`, cleared the moment Send-to-AI or Cancel is clicked.
- **`cRfqFileImportProposals`** is the multi-line generalization REQ-AI-GAP-012e calls for explicitly: an **object keyed by `lineId`**, not a flat var — `{ [lineId]: { supId, fields: {cost?, currency?, moq?, leadTime?, paymentTerms?, notes?} } }`. Each entry is one line's pending, unapplied proposal. Applying or discarding one key must never touch any other key — this is the direct mechanism behind AC-7.
- **`cRfqFileImportApplyInFlight`** is new state this feature specifically needs that the email-parse precedent never did — see §6 for why.

None of these four are persisted to `DB`; all are transient front-end state, gone on navigation/refresh (REQ §1.3's persistence guarantee, AC-9's Cancel semantics).

**Test-isolation requirement**, mirroring the identical, already-documented `cRfqEmailParseLineId` gotcha (`CLAUDE.md`'s RFQ email-parse section, `SPEC-AI-GAP-011-v1.md §2`): `resetDB()` does not touch these four vars. Every test exercising this feature must either drive the flow to a natural clearing point (`rfqCloseFileImport()` or a completed `rfqApplyFileProposal()` for every proposal) or explicitly reset all four in setup (`ctx.cRfqFileImportOrdId = null; ctx.cRfqFileImportPendingRows = null; ctx.cRfqFileImportProposals = {}; ctx.cRfqFileImportApplyInFlight = false;`).

---

## 2. New control: "Import Supplier Quote File" — once per Order Request

**File:** `rOrdLines(ord)`, `index.html:3332-3353`.

**Current:**
```js
function rOrdLines(ord) {
  var el = G('of-lines-list'); if (!el) return;
  if (!ord) { el.innerHTML = '<div style="font-size:.55rem;color:var(--m);">Save the Order Request first, then add line items.</div>'; return; }
  var lines = ord.lines || [];
  el.innerHTML = lines.map(function(l){
    ...
  }).join('') || '<div style="font-size:.55rem;color:var(--m);">No line items yet</div>';
}
```

**New:**
```js
function rOrdLines(ord) {
  var el = G('of-lines-list'); if (!el) return;
  if (!ord) { el.innerHTML = '<div style="font-size:.55rem;color:var(--m);">Save the Order Request first, then add line items.</div>'; return; }
  var lines = ord.lines || [];
  var linesHtml = lines.map(function(l){
    ... // unchanged
  }).join('') || '<div style="font-size:.55rem;color:var(--m);">No line items yet</div>';
  var importControl = lines.length ? (
    '<div style="margin-bottom:8px;">' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:2px 6px;" onclick="rfqOpenFileImport(\'' + ord.id + '\')">Import Supplier Quote File</button>' +
    '</div>' +
    '<div id="ord-fileimport-' + ord.id + '" style="display:none;margin-bottom:8px;"></div>'
  ) : '';
  el.innerHTML = importControl + linesHtml;
}
```

**Placement rationale:** the control is gated on `lines.length` — an Order Request with zero lines has nothing for a supplier's quote file to match against, and showing the button in that state would just produce "no confident matches" on every use. Placed *above* the per-line cards (`importControl + linesHtml`, not appended after) since it's an Order-Request-level action, visually distinct from the per-line cards below it — matching how `rOrdLines()`'s own per-line cards already sit below other Order-Request-level controls elsewhere in the modal (not shown in this excerpt; outside this spec's scope to change).

The shared panel div (`ord-fileimport-<ordId>`) follows the exact same "hidden div, populated and shown on demand" convention already established by `ord-gapchk-<lineId>` (`index.html:3348`) and `ord-rfq-emailparse-<lineId>` (`index.html:3598`) — never a modal overlay, an inline panel that appears in place.

**Deliberate consequence, noted so build-gate doesn't mistake it for a bug:** `rOrdLines()` rebuilds its entire `innerHTML` (both the import control's div and every per-line card) on every call. Any open, in-progress file-import panel — including a populated proposal-review view — is silently wiped back to `display:none`/empty whenever `rOrdLines()` re-renders for an unrelated reason (adding a line, editing a line field). This mirrors `renderRfqComparison()`'s own identical, already-accepted behavior for the email-parse panel (`SPEC-AI-GAP-011-v1.md §3`) and is the right behavior for the identical reason: it prevents a stale review UI, referencing proposals that may no longer make sense against a just-changed line set, from lingering. `cRfqFileImportOrdId`/`cRfqFileImportProposals`/etc. are **not** cleared by this re-render alone — only by `rfqCloseFileImport()` or a fully-applied/discarded proposal — which is exactly why §6/§8's guards check staleness explicitly rather than assuming a re-render implies anything about the tracked state.

---

## 3. New function: `rfqOpenFileImport(ordId)`

**File:** insert immediately after `rOrdLines()` closes (after `index.html:3353`, before `ordCheckLineGaps` at `3354`).

```js
function rfqOpenFileImport(ordId) {
  if (!EI.ord || EI.ord !== ordId) return;
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  var panel = G('ord-fileimport-' + ordId);
  if (!panel) return;
  cRfqFileImportOrdId = ordId;
  cRfqFileImportPendingRows = null;
  cRfqFileImportProposals = {};
  panel.style.display = 'block';
  panel.innerHTML = '<div style="border:1px solid var(--ln);border-radius:4px;padding:6px;">' +
    '<div style="font-size:.5rem;margin-bottom:4px;">Import Supplier Quote File</div>' +
    '<div class="fld"><label>Supplier</label><select id="rfq-fileimport-sup-' + ordId + '">' +
      '<option value="">— Supplier —</option>' +
      DB.sup.map(function(s){ return '<option value="' + san(s.id) + '">' + san(s.name) + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="fld" style="margin-top:4px;"><label>Quote File (CSV)</label><input type="file" id="rfq-fileimport-file-' + ordId + '" accept=".csv"></div>' +
    '<div style="margin-top:4px;">' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqRunFileImport(\'' + ordId + '\')">Parse</button> ' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseFileImport(\'' + ordId + '\')">Cancel</button>' +
    '</div>' +
  '</div>';
}
```

Existence guards mirror `rfqOpenEmailParse()`'s exact style (`index.html:3602-3611`) — same silent-return-on-miss convention. The `EI.ord !== ordId` check (stricter than `rfqOpenEmailParse()`'s bare `!EI.ord`, since this function takes an `ordId` argument that `rfqOpenEmailParse()`'s line-scoped equivalent doesn't need to cross-check) guards against a stale button click from a different, previously-open Order Request modal.

The supplier `<select>` markup matches `openRfqResponse()`'s own dropdown-population pattern exactly (`index.html:3429-3430`) — same options list, same `san()` usage, no new dropdown-building logic invented.

---

## 4. New function: `rfqCloseFileImport(ordId)`

```js
function rfqCloseFileImport(ordId) {
  if (ordId === cRfqFileImportOrdId) {
    cRfqFileImportOrdId = null;
    cRfqFileImportPendingRows = null;
    cRfqFileImportProposals = {};
  }
  var panel = G('ord-fileimport-' + ordId);
  if (panel) { panel.style.display = 'none'; panel.innerHTML = ''; }
}
```

Serves Cancel (before any parse), Cancel-at-confirmation (AC-9's "choosing Cancel... discards the parsed state and sends nothing"), and the final "Close" button shown after all proposals in a run have been Applied/Discarded — all three are "tidy up and stop," matching `rfqCloseEmailParse()`'s own one-function-serves-several-callers precedent (`index.html:3629-3637`, `SPEC-AI-GAP-011-v1.md §5`).

The `ordId === cRfqFileImportOrdId` guard before clearing state exists for the same reason `rfqCloseEmailParse()`'s line-level equivalent does: if this panel's own tracked state has already been superseded (not reachable in the single-panel-per-Order-Request-modal design this spec uses, since only one Order Request modal is ever open at a time — but included for defense-in-depth and consistency with the established pattern, at zero cost). The panel-hide/clear on the last two lines runs unconditionally regardless, since hiding a stale panel is always safe.

---

## 5. New function: `rfqRunFileImport(ordId)` — validate, read, tokenize, then confirm (AC-4, AC-9, AC-11)

```js
function rfqRunFileImport(ordId) {
  if (!EI.ord || EI.ord !== ordId) return;
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  var panel = G('ord-fileimport-' + ordId);
  if (!panel) return;
  var supId = G('rfq-fileimport-sup-' + ordId).value;
  if (!supId) { toast('Select a supplier first.'); return; }
  var fileInput = G('rfq-fileimport-file-' + ordId);
  var file = fileInput && fileInput.files[0];
  if (!file) { toast('Select a file first.'); return; }
  if (!/\.csv$/i.test(file.name)) { toast('Only .csv files are supported.'); return; }
  var reader = new FileReader();
  reader.onload = function(e) {
    if (G('ord-fileimport-' + ordId) !== panel) return;
    var parsed = parseImportCSV(e.target.result);
    if (!parsed.rows.length) { toast('No data rows found in that file.'); return; }
    rfqShowFileImportConfirm(ordId, supId, parsed);
  };
  reader.readAsText(file);
}
```

**Extension rejection (AC-4):** the `/\.csv$/i.test(file.name)` check runs *before* `FileReader` ever touches the file's contents — a `quote.xlsx` is rejected by name alone, never read as text, never handed to `parseImportCSV()`. This is the exact behavior REQ Decision 1 requires: "never attempts to parse binary `.xlsx` content as a text stream, which would silently produce garbage rather than a clear error."

**`FileReader.readAsText()` pattern copied directly from `bulkUpload()`** (`index.html:10152-10167`) — same `reader.onload`/`reader.readAsText(file)` shape, same "do the real work inside `onload`" structure. Not reusing `bulkUpload()` itself, since it's hardcoded to call `processImport(entity, ...)` (`index.html:10158`) — a different write pipeline this feature deliberately does not use (REQ §1.1/§3).

**Empty-parse contract (AC-11):** `parseImportCSV()`'s own existing contract (`index.html:10169-10220`) returns `{ headers: [], rows: [] }` whenever the tokenized input has fewer than 2 total rows (a header-only or genuinely empty file) — confirmed by reading the function directly (`index.html:10195`: `if (allRows.length < 2) return { headers: [], rows: [] };`). `parsed.rows.length` being `0` is therefore the correct, already-proven check; this mirrors `processImport()`'s own identical guard (`index.html:10225`: `if (!rows.length) { impLog(...); return; }`) rather than inventing a new empty-check convention. No AI call is reachable past this point on an empty file.

**The `G(id) !== panel` staleness guard inside `reader.onload`** — copied from the same precedent pattern `rfqRunEmailParse()` already uses for its own async boundary (`index.html:3655`) — guards against the panel having been closed (e.g. operator clicked Cancel) while the file was still being read, which is a real async gap `FileReader` introduces that a purely synchronous flow wouldn't have.

---

## 6. New function: `rfqShowFileImportConfirm(ordId, supId, parsed)` — mandatory pre-send confirmation (REQ-AI-GAP-012c / AC-9)

```js
function rfqShowFileImportConfirm(ordId, supId, parsed) {
  var panel = G('ord-fileimport-' + ordId);
  if (!panel) return;
  cRfqFileImportPendingRows = { rows: parsed.rows, supId: supId };
  var preview = '<div style="max-height:200px;overflow-y:auto;"><table class="tbl" style="font-size:.46rem;"><thead><tr>' +
    parsed.headers.map(function(h){ return '<th>' + san(h) + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    parsed.rows.map(function(r){
      return '<tr>' + parsed.headers.map(function(h){ return '<td>' + san(r[h]||'') + '</td>'; }).join('') + '</tr>';
    }).join('') +
    '</tbody></table></div>';
  panel.innerHTML = '<div style="font-size:.5rem;margin-bottom:4px;">Review parsed rows before sending to AI — nothing is sent yet:</div>' +
    preview +
    '<div style="margin-top:4px;">' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqSendFileToAI(\'' + ordId + '\')">Send to AI</button> ' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseFileImport(\'' + ordId + '\')">Cancel</button>' +
    '</div>';
}
```

This is the entire implementation of REQ-AI-GAP-012c and AC-9 — the parsed rows/columns rendered as a plain HTML table (every cell `san()`'d, since it is, after all, arbitrary externally-supplied text about to be shown in the DOM), with an explicit binary choice. **Cancel here routes through the same `rfqCloseFileImport()` as every other Cancel** (§4), which clears `cRfqFileImportPendingRows` — satisfying REQ §1.3's "canceling at this step discards the parsed file state and sends nothing" exactly, with no separate discard path to maintain.

`cRfqFileImportPendingRows` is stored as `{ rows, supId }` (not just the bare rows array) so `rfqSendFileToAI()` doesn't need a second parameter threaded through the button's `onclick` — the supplier was already fixed at file-select time and doesn't change at this step.

---

## 7. New function: `rfqSendFileToAI(ordId)` — builds line context, calls the AI, renders results or unmatched

```js
function rfqSendFileToAI(ordId) {
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  var panel = G('ord-fileimport-' + ordId);
  if (!panel) return;
  var pending = cRfqFileImportPendingRows;
  if (!pending) return;
  cRfqFileImportPendingRows = null;
  var supId = pending.supId;
  var lineContexts = (ord.lines || []).map(function(l){
    var ctx = { id: l.id, category: l.category, itemSpec: l.itemSpec, orderVolumeQty: l.orderVolumeQty, orderVolumeUnit: l.orderVolumeUnit };
    var existingResp = (l.rfqResponses || []).find(function(r){ return r.supId === supId; });
    if (existingResp) {
      ctx.currentValues = { cost: existingResp.cost, currency: existingResp.currency, moq: existingResp.moq, leadTime: existingResp.leadTime, paymentTerms: existingResp.paymentTerms };
    }
    return ctx;
  });
  panel.innerHTML = '<div style="color:var(--m);">Parsing…</div>';
  rfqParseUpdateFromFile(pending.rows, supId, lineContexts).then(function(result){
    if (G('ord-fileimport-' + ordId) !== panel) return;
    if (result === null) {
      panel.innerHTML = '<div style="color:var(--m);">AI parse unavailable.</div>' +
        '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseFileImport(\'' + ordId + '\')">Close</button></div>';
      return;
    }
    rfqRenderFileImportResults(ordId, supId, result, ord);
  });
}
```

**`lineContexts`'s `currentValues` field is only set when this supplier already has a response on that line** — this is exactly the piece of information `rfqParseUpdateFromFile()` (§8) needs to eventually let the diff panel (§9) show "old → new" for an update, versus "(unset) → new" for a brand-new response (REQ Decision 2's create-new-response case, AC-5). Mirrors `rfqParseUpdateFromEmail()`'s own `currentValues` payload shape (`index.html:3706-3743`) at the per-line level, generalized to N lines.

**The `G(id) !== panel` staleness guard** — same pattern as §5/`rfqRunEmailParse()` — guards the async `fetch()` round-trip exactly as the email-parse precedent already does.

---

## 8. New function: `rfqParseUpdateFromFile(rows, supId, lineContexts)`

**File:** insert after `rfqParseUpdateFromEmail()` closes (after `index.html:3743`ish — alongside the other single-shot AI-extraction functions, matching `SPEC-AI-GAP-011-v1.md §8`'s own placement rationale).

```js
var RFQ_FILE_IMPORT_PROMPT = 'Given these supplier quote spreadsheet rows and a list of this Order Request\'s own line items, match each row to at most one line item using its description/spec. For each row you can confidently match to exactly one line, extract any of {cost, currency, moq, leadTime, paymentTerms, notes} the row states a value for. If you cannot confidently match a row to exactly one line item, do not guess — return it as unmatched with a brief reason. Respond with ONLY a JSON object of the exact shape {"matches":[{"lineId":"<id>","fields":{...}}],"unmatched":[{"row":{...},"reason":"<brief reason>"}]} — no prose, no markdown fences.';
async function rfqParseUpdateFromFile(rows, supId, lineContexts) {
  if (!AI.key) return null;
  var payload = { rows: rows, lines: lineContexts };
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
        max_tokens: 2048,
        temperature: 0.2,
        system: RFQ_FILE_IMPORT_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    var text = (data.content || []).map(function(b){ return b.text || ''; }).join('');
    var parsed = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (!Array.isArray(parsed.matches) || !Array.isArray(parsed.unmatched)) return null;
    var allowed = ['cost', 'currency', 'moq', 'leadTime', 'paymentTerms', 'notes'];
    var knownLineIds = {};
    lineContexts.forEach(function(l){ knownLineIds[l.id] = true; });
    var matches = [];
    var unmatched = parsed.unmatched.slice();
    parsed.matches.forEach(function(m){
      if (!m || typeof m.lineId !== 'string' || !knownLineIds[m.lineId]) {
        unmatched.push({ row: (m && m.fields) || {}, reason: 'Could not verify this match against a real line item.' });
        return;
      }
      var filtered = {};
      if (m.fields && typeof m.fields === 'object' && !Array.isArray(m.fields)) {
        allowed.forEach(function(k){ if (m.fields[k] !== undefined) filtered[k] = m.fields[k]; });
      }
      matches.push({ lineId: m.lineId, fields: filtered });
    });
    return { matches: matches, unmatched: unmatched };
  } catch (e) {
    return null;
  }
}
```

**`max_tokens: 2048`, not `512`** (the value `rfqParseUpdateFromEmail()`/`ordCheckLineGapsSemantic()` use) — a deliberate departure, since this function's response can contain proposals for every line in an Order Request plus every unmatched row, not a single response's worth of fields; 512 tokens would risk truncating a genuinely multi-line, confidently-matched result. Not scientifically tuned — a reasonable ceiling given the payload shape, adjustable at build-gate if real usage shows it's wrong in either direction.

**Response-shape validation, three layers, each closing a distinct gap:**
1. `!parsed || typeof parsed !== 'object' || Array.isArray(parsed)` — the exact three-part guard `rfqParseUpdateFromEmail()` already uses (`index.html:3736`ish, per `SPEC-AI-GAP-011-v1.md §8`'s own rationale for why a bare `typeof` check isn't enough), applied at the top-level object.
2. `!Array.isArray(parsed.matches) || !Array.isArray(parsed.unmatched)` — new here, since this function's contract is a two-key object where **both** values must themselves be arrays; a model response with `matches` as a bare object instead of an array (a plausible hallucination shape) is rejected wholesale rather than partially processed.
3. **The hallucinated-`lineId` guard (AC-10):** `parsed.matches.forEach(...)` checks every claimed match's `lineId` against `knownLineIds`, built from the `lineContexts` this function was actually given (never trusting the model to only reference real ids). A match naming a `lineId` that doesn't exist is **moved into `unmatched`** with a generic, honest reason ("Could not verify this match against a real line item") — never silently dropped, never applied. This is what makes AC-10 concretely enforceable rather than aspirational: the check happens inside the one function that owns response validation, not left to a caller's discipline.

**Per-match field whitelist**, same rationale as `rfqParseUpdateFromEmail()`'s own whitelist (`SPEC-AI-GAP-011-v1.md §8`, point 2) — a hallucinated or off-schema key inside one match's `fields` object is silently dropped rather than passed through, so the function's own return value honors "only commercial fields are extracted" as a fact about the data, not an accident of what a downstream caller happens to read.

**Payload never includes `notes` in `currentValues`** (built by the caller, §7) — same asymmetry, same rationale, as `REQ-AI-GAP-011`'s own accepted design (`SPEC-AI-GAP-011-v1.md §8`'s "Payload shape matches REQ §2b's literal wording exactly" note): the diff view reads the old `notes` value directly from the local record, never from what was sent to the model.

---

## 9. Shared diff-row helper — factored out of `rfqRunEmailParse()`'s success branch, reused here

**Current** (`rfqRunEmailParse()`, `index.html:3668-3671`):
```js
    var rows = fields.map(function(f){
      var oldVal = resp[f] != null && resp[f] !== '' ? String(resp[f]) : '(unset)';
      return '<div>' + san(f) + ': ' + san(oldVal) + ' &rarr; <strong>' + san(String(result[f])) + '</strong></div>';
    }).join('');
```

**New shared function**, inserted immediately before `rfqRunEmailParse()` (before `index.html:3639`):
```js
function rfqDiffRowsHtml(baseline, proposed) {
  return Object.keys(proposed).map(function(f){
    var oldVal = baseline[f] != null && baseline[f] !== '' ? String(baseline[f]) : '(unset)';
    return '<div>' + san(f) + ': ' + san(oldVal) + ' &rarr; <strong>' + san(String(proposed[f])) + '</strong></div>';
  }).join('');
}
```

**`rfqRunEmailParse()`'s own body changes from:**
```js
    var rows = fields.map(function(f){
      var oldVal = resp[f] != null && resp[f] !== '' ? String(resp[f]) : '(unset)';
      return '<div>' + san(f) + ': ' + san(oldVal) + ' &rarr; <strong>' + san(String(result[f])) + '</strong></div>';
    }).join('');
```
**to:**
```js
    var rows = rfqDiffRowsHtml(resp, result);
```

**Why this factoring is safe and behavior-preserving:** `rfqDiffRowsHtml(baseline, proposed)` is byte-identical logic, generalized only in naming (`resp`→`baseline`, `result`→`proposed`) and in iterating `Object.keys(proposed)` inline rather than a separately-computed `fields` var (the caller's own `fields.length` check for the "no new commercial terms found" empty-state, `index.html:3661-3666`, stays in `rfqRunEmailParse()` unchanged — it still needs `fields` for that check, computed once, then handed to the shared function). **Reused here (§10) for both the update case** (`baseline` = the existing response's real field values) **and the new-response case** (`baseline` = `{}`, so every field's "old" side reads `(unset)` automatically via the existing `baseline[f] != null` check — no special-casing needed for "no existing response," it falls out of the same code path for free).

This is the "factor into a shared helper and reused, not duplicated a third time" refactor REQ-AI-GAP-012f explicitly calls for.

---

## 10. Multi-line results rendering, per-line Apply/Discard, and the mandatory serialization guard

### 10a. `rfqRenderFileImportResults(ordId, supId, result, ord)`

```js
function rfqRenderFileImportResults(ordId, supId, result, ord) {
  var panel = G('ord-fileimport-' + ordId);
  if (!panel) return;
  cRfqFileImportOrdId = ordId;
  cRfqFileImportProposals = {};
  result.matches.forEach(function(m){
    cRfqFileImportProposals[m.lineId] = { supId: supId, fields: m.fields };
  });
  var panelsHtml = result.matches.map(function(m){
    var line = (ord.lines || []).find(function(l){ return l.id === m.lineId; });
    var existingResp = line ? (line.rfqResponses || []).find(function(r){ return r.supId === supId; }) : null;
    var diffRows = rfqDiffRowsHtml(existingResp || {}, m.fields);
    var label = line ? (san(line.category||'-') + ' — ' + san(line.itemSpec||'-')) : san(m.lineId);
    return '<div id="rfq-fileimport-panel-' + m.lineId + '" style="border:1px solid var(--ln);border-radius:4px;padding:6px;margin-top:4px;">' +
      '<div style="font-size:.5rem;font-weight:600;">' + label + (existingResp ? '' : ' <em style="font-weight:400;color:var(--m);">(new response)</em>') + '</div>' +
      '<div style="font-size:.5rem;">' + diffRows + '</div>' +
      '<div style="margin-top:4px;">' +
        '<button class="btn btn-g" id="rfq-fileimport-apply-' + m.lineId + '" style="font-size:.44rem;padding:1px 6px;" onclick="rfqApplyFileProposal(\'' + ordId + '\',\'' + m.lineId + '\')">Apply</button> ' +
        '<button class="btn btn-g" id="rfq-fileimport-discard-' + m.lineId + '" style="font-size:.44rem;padding:1px 6px;" onclick="rfqDiscardFileProposal(\'' + ordId + '\',\'' + m.lineId + '\')">Discard</button>' +
      '</div>' +
    '</div>';
  }).join('');
  var unmatchedHtml = result.unmatched.length ? (
    '<div style="margin-top:6px;font-size:.5rem;color:var(--m);">Needs manual review — could not confidently match to a line item:</div>' +
    result.unmatched.map(function(u){
      return '<div style="font-size:.46rem;color:var(--m);margin-top:2px;">' + san(JSON.stringify(u.row)) + ' — ' + san(u.reason) + '</div>';
    }).join('')
  ) : '';
  panel.innerHTML = (panelsHtml || '<div style="font-size:.5rem;color:var(--m);">No confident matches found in this file.</div>') +
    unmatchedHtml +
    '<div style="margin-top:6px;"><button class="btn btn-g" style="font-size:.44rem;padding:1px 6px;" onclick="rfqCloseFileImport(\'' + ordId + '\')">Close</button></div>';
}
```

**One panel per matched line, N independent Apply/Discard button pairs on screen at once** — exactly REQ-AI-GAP-012f's design. **No bulk "Apply All"** — there is deliberately no button that iterates `cRfqFileImportProposals` and applies every entry; each panel's Apply targets exactly its own `lineId` (REQ §3's explicit out-of-scope item).

**Unmatched rows are rendered as read-only text with no Apply/Discard of their own** (`u.row`/`u.reason`, `san()`'d) — matching REQ Decision 3 exactly. `JSON.stringify(u.row)` is a blunt but honest way to show "whatever the model couldn't place" without inventing a second table-rendering code path for a case that, by definition, has no known column-to-field mapping to render nicely.

### 10b. `rfqDiscardFileProposal(ordId, lineId)`

```js
function rfqDiscardFileProposal(ordId, lineId) {
  if (ordId !== cRfqFileImportOrdId) return;
  delete cRfqFileImportProposals[lineId];
  var el = G('rfq-fileimport-panel-' + lineId);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}
```

Removes only that line's own panel element and its own proposal-map entry — every other line's panel, and the shared `cRfqFileImportProposals` entries for other lines, are untouched (AC-7). **Discard is exempt from the serialization guard** (§10c) — it is synchronous, local-only state removal with no network round-trip, so there is no in-flight window for it to race against; per REQ-AI-GAP-012f's own text, "Discard... is not subject to this restriction and may proceed at any time for any line" — including, by design, while a *different* line's Apply is mid-flight, since removing an unrelated line's own proposal entry from the map cannot corrupt or interfere with another key's already-in-progress `saveRfqResponse()` call.

### 10c. `rfqApplyFileProposal(ordId, lineId)` — the safety-critical function (REQ-AI-GAP-012f addendum, AC-7b)

```js
async function rfqApplyFileProposal(ordId, lineId) {
  if (ordId !== cRfqFileImportOrdId) return;
  if (cRfqFileImportApplyInFlight) return;
  var proposal = cRfqFileImportProposals[lineId];
  if (!proposal) return;
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;

  cRfqFileImportApplyInFlight = true;
  rfqSetOtherFileImportPanelsDisabled(lineId, true);

  var existingResp = (line.rfqResponses || []).find(function(r){ return r.supId === proposal.supId; });
  if (existingResp) {
    editRfqResponse(lineId, existingResp.id);
    if (cRfqEditId === existingResp.id) {
      rfqFillRfqFormFields(proposal.fields);
      await saveRfqResponse();
    }
  } else {
    openRfqResponse(lineId);
    G('rfq-sup').value = proposal.supId;
    rfqFillRfqFormFields(proposal.fields);
    await saveRfqResponse();
  }

  delete cRfqFileImportProposals[lineId];
  var el = G('rfq-fileimport-panel-' + lineId);
  if (el && el.parentNode) el.parentNode.removeChild(el);

  cRfqFileImportApplyInFlight = false;
  rfqSetOtherFileImportPanelsDisabled(lineId, false);
}

function rfqFillRfqFormFields(fields) {
  if (fields.cost !== undefined) G('rfq-cost').value = fields.cost;
  if (fields.currency !== undefined) G('rfq-cur').value = fields.currency;
  if (fields.moq !== undefined) G('rfq-moq').value = fields.moq;
  if (fields.leadTime !== undefined) G('rfq-leadtime').value = fields.leadTime;
  if (fields.paymentTerms !== undefined) G('rfq-payterms').value = fields.paymentTerms;
  if (fields.notes !== undefined) G('rfq-notes').value = fields.notes;
}

function rfqSetOtherFileImportPanelsDisabled(excludeLineId, disabled) {
  Object.keys(cRfqFileImportProposals).forEach(function(otherLineId){
    if (otherLineId === excludeLineId) return;
    var applyBtn = G('rfq-fileimport-apply-' + otherLineId);
    var discardBtn = G('rfq-fileimport-discard-' + otherLineId);
    if (applyBtn) applyBtn.disabled = disabled;
    if (discardBtn) discardBtn.disabled = disabled;
  });
}
```

**This is the direct implementation of REQ-AI-GAP-012f's serialization requirement and AC-7b.** Walking through why it actually closes the gap the independent REQ review found (REQ §8b, finding B1), not just gestures at it:

1. **The lock (`cRfqFileImportApplyInFlight`) is a single shared boolean, checked synchronously at the very top of the function, before anything else happens.** Because JavaScript is single-threaded, the *first* Apply click to run sets this flag to `true` and disables every other panel's buttons — both of these happen synchronously, before this function's own first `await`. A second Apply click, on a *different* line, dispatched as its own separate event, cannot begin executing until the first click's synchronous portion has already run to completion (or reached its own `await`) — by which point the lock is already `true` and the second click's own invocation of `rfqApplyFileProposal()` returns immediately at the `if (cRfqFileImportApplyInFlight) return;` guard, doing nothing. There is no window in which two `saveRfqResponse()` calls can be in flight at once, because the guard that prevents the second one from *starting* is itself set synchronously, not behind an await.
2. **Disabling the other panels' actual DOM buttons (`el.disabled = true`)** is not merely cosmetic — it prevents the operator from generating a second click event in the first place during the in-flight window, which is the simplest way to close the race at the UI layer as well as the state layer (belt-and-braces: the lock alone is already sufficient per point 1, but a disabled button is also honest, visible feedback to the operator about why nothing happens if they try).
3. **The lock is released, and every other panel's buttons re-enabled, only after `await saveRfqResponse()` resolves** — whether it actually persisted (the common case) or hit its own internal validation failure and left `ov-rfq` open without saving (the known, accepted edge case `SPEC-AI-GAP-011-v1.md §7`'s own final paragraph already documents for the single-line case, carried through unchanged here). Either way, the *next* Apply click, on any line, is only ever able to begin after this one's entire async chain — including `saveRfqResponse()`'s own internal `await persistOrdChange(ord)` under Cloud Data — has fully settled.
4. **This function `await`s `saveRfqResponse()` directly, a deliberate, necessary departure from this codebase's own stated "async save functions are called fire-and-forget from onclick" convention** (`CLAUDE.md`, Key coding conventions). `saveRfqResponse()` is already `async function saveRfqResponse()` (`index.html:3478`) and already returns a promise that resolves once its own work (including the `persistOrdChange()` Supabase round-trip) completes — nothing about it needs to change for this function to await it. The fire-and-forget convention exists for the *ordinary*, single-operation case, where nothing else needs to know when the save finishes; this feature is exactly the exception the convention doesn't anticipate, because knowing precisely when the save finishes is the entire mechanism the safety requirement depends on. This divergence is deliberate and load-bearing, not an oversight — call this out explicitly at build-gate review so it isn't "corrected" back to fire-and-forget.

**Two additional guards, matching the email-parse precedent's own two-guard pattern (`SPEC-AI-GAP-011-v1.md §7`) for the narrower edge cases the serialization lock alone doesn't cover:**
- `if (ordId !== cRfqFileImportOrdId) return;` — a stale button from a closed-and-reopened-on-a-different-order panel (not reachable given the single-modal-at-a-time UI this spec builds, but zero-cost defense-in-depth, consistent with §4's identical guard).
- `if (cRfqEditId === existingResp.id)` before writing form fields — the same "did `editRfqResponse()` actually succeed" check `rfqApplyEmailParse()` already uses (`index.html:3686`), covering the case where the response was deleted by some other action between the proposal being generated and Apply being clicked.

---

## 11. `AI_SYSTEM_PROMPT` update (REQ-AI-GAP-012g)

**File:** `index.html:11261` — the entry `REQ/SPEC-AI-GAP-011` already added; extend it again, same continuation-not-new-line approach `SPEC-AI-GAP-011-v1.md §9` itself used when extending `REQ/SPEC-ORD-006`'s own entry.

**Current (last sentence of the existing string):**
```
...If asked whether the chat assistant itself can do this from a pasted email, say no — direct the operator to this button on the specific response instead, since that is the only place this capability exists.
```

**New (appended to the same string):**
```
 A separate "Import Supplier Quote File" button (v2.9.8X, REQ/SPEC-AI-GAP-012, CSV only — .xlsx is not supported) lives once per Order Request, above its line items — the operator selects the supplier the file is from and uploads a comma-delimited .csv, reviews the parsed rows before anything is sent (a mandatory confirmation step), and the AI attempts to match each row to one of the Order Request's own line items, proposing a diff per confidently-matched line for individual Apply or Discard, exactly as the single-response email version does; any row it can't confidently match is listed separately for manual review, never guessed at or silently dropped. If asked whether this same button can accept an Excel (.xlsx) file, say no — only .csv is supported today.
```

**Rationale:** matches `SPEC-AI-GAP-011-v1.md §9`'s own stated reason for its analogous update — an operator (or the chat assistant reasoning about the app on their behalf) asking "can I upload a supplier's spreadsheet" needs an answer synthesized from an *accurate* description of this feature, including its CSV-only limitation, not a guess extrapolated from the pasted-email feature's own description.

---

## 12. Explicitly unchanged (confirmed by this spec, not just asserted by the REQ)

- `editRfqResponse()` (`index.html:3447-3477`), `saveRfqResponse()` (`index.html:3478-3511`), `delRfqResponse()` (`index.html:3513-3531`) — zero modifications. Every AC-5/AC-6 guarantee is inherited by calling these exactly as they exist today, not by re-deriving their behavior. (§10c's `await` of `saveRfqResponse()` is a change in how it's *called*, not to the function itself.)
- `parseImportCSV()` (`index.html:10169-10220`), `processImport()` (`index.html:10222` onward) — zero modifications. This spec is a new, independent caller of `parseImportCSV()` only; `processImport()` is never called by this feature at all (§5's rationale).
- `rfqOpenEmailParse`/`rfqCloseEmailParse`/`rfqRunEmailParse`/`rfqApplyEmailParse`/`rfqParseUpdateFromEmail` (`index.html:3602-3743`) — zero modifications, except that `rfqRunEmailParse()`'s own diff-row-building lines are replaced with a call to the new shared `rfqDiffRowsHtml()` (§9) — a refactor that preserves its exact existing behavior byte-for-byte, confirmed by the "why this factoring is safe" argument in §9.
- `renderQteSourceDriftWarn()` — zero modifications; this feature never touches Quotes, only RFQ responses, and inherits the staleness-banner behavior transitively through `saveRfqResponse()`'s own unmodified internals (same inheritance argument as `SPEC-AI-GAP-011-v1.md §10`).
- `AI_TOOLS` (the chat-assistant tool schema array) — unchanged; this feature adds no new AI tool, only a new UI-triggered single-shot extraction call, matching REQ §3's explicit non-goal for the email-parse precedent.
- No `FIELD_MAPS`/Sheets-sync footprint added — `rfqResponses[]` already has none, and this feature adds no new persisted field, only transient front-end state (§1).

---

## 13. Test plan

Follows `SPEC-AI-GAP-011-v1.md §11`'s established pattern and `REQ-AI-GAP-012 §5` exactly, extended for this feature's own new risk surface (multi-line fan-out, file parsing, serialization).

**AC-1, AC-8 (`rfqParseUpdateFromFile()` gating and failure modes)** — reuse the existing `_mockAnthropic`/mocked-`fetch` harness (`tests/run.js:59-70`), the same one `rfqParseUpdateFromEmail()`'s own tests use:
- AC-1: `AI.key` unset → resolves `null`, no `fetch` call (mirror the existing `rfqParseUpdateFromEmail()`-no-key test's exact assertion style).
- AC-8: mock a network-throwing `fetch` and, separately, a non-`ok` response, and, separately, a non-JSON-object response and a JSON *array* response (the same three-part-guard case `SPEC-AI-GAP-011-v1.md §11` already tests for the email version) — all resolve `null`.

**AC-2, AC-3, AC-10, AC-11 (matching/unmatched/hallucination/empty-file logic)** — new fixtures needed here, since these are genuinely new behaviors the email-parse precedent's tests never exercised:
- AC-2: seed an Order Request with 2+ lines with genuinely distinct `category`/`itemSpec` text (not a trivially-distinct pair — reuse `REQ-AI-GAP-012 §5`'s own stated adversarial-fixture requirement even for this non-isolation test, so the fixture is reusable for AC-7/AC-7b below too), mock a `matches[]` response naming both real `lineId`s, confirm `rfqParseUpdateFromFile()` returns both in `matches[]` with `unmatched: []`.
- AC-3: mock a response where `unmatched[]` contains one entry alongside a valid `matches[]` entry for the other line — confirm both are present and correctly separated in the return value; separately, confirm `parseImportCSV()`'s own zero-data-row behavior is **not** re-tested here (already covered by its own `SPEC-DATA-003` tests) — this spec's own test only exercises `rfqRunFileImport()`'s handling of that zero-rows *result*.
- AC-10: mock a `matches[]` entry naming a `lineId` that doesn't correspond to any id in the `lineContexts` passed in — confirm that entry ends up in the returned `unmatched[]`, not `matches[]`, and that the file's other, validly-matched entries are unaffected.
- AC-11: call `rfqRunFileImport()` with a mocked `FileReader`/file input whose content tokenizes (via the real, untouched `parseImportCSV()`) to zero rows — confirm `rfqParseUpdateFromFile()`/the AI `fetch` mock is never invoked (assert on the mock's own call log), and the panel shows the "No data rows found" message.

**AC-4 (extension rejection):** call `rfqRunFileImport()` with a mocked file object whose `.name` is `quote.xlsx` — confirm no `FileReader` is ever constructed/no read is attempted (the simplest way to assert this in the test harness is to spy on whether the parse/AI-call path was reached at all) and a clear message is shown.

**AC-5, AC-6 (Apply — new-response and update cases):** reuse `mkOrdWithLine()`-style fixtures (`tests/run.js`, find current line numbers at implementation time — cited ranges in this document are pre-implementation and will shift once this spec's own code lands, exactly as happened between REQ and this spec):
- AC-5: a line with no existing response from the target supplier; directly populate `cRfqFileImportProposals[lineId]` (bypassing the mocked-AI round trip, mirroring `SPEC-AI-GAP-011-v1.md §11`'s own AC-5 technique for the same reason — this AC is about the add-path mechanism, not extraction correctness); call `rfqApplyFileProposal()`; assert `line.rfqResponses` gains exactly one new entry with the proposed fields and a fresh `id`.
- AC-6: a line with an existing response from the target supplier; same technique; call `rfqApplyFileProposal()`; assert the response is replaced in place with a new `id` (mirroring `SPEC-ORD-006`'s and `SPEC-AI-GAP-011-v1.md §11`'s own "edit mode replaces the entry in place with a new id" test structure), and — using `mkOrdWithCommittedResponse()`-style setup if that response was committed — that `committedResponseId` repoints and `renderQteSourceDriftWarn()` subsequently shows the staleness banner, exactly as `SPEC-AI-GAP-011-v1.md §11`'s own highest-value test already proves for the single-response case.

**AC-7 (cross-line proposal-state isolation, non-async):** seed two lines, populate `cRfqFileImportProposals` with entries for both, discard one line's proposal — assert the other line's own `cRfqFileImportProposals` entry and its own DOM panel are completely untouched. This is a synchronous-only test and, per the independent REQ review's own finding, is **not sufficient on its own** to prove serialization — it proves the *state map* is correctly isolated, which AC-7b then builds on to prove the *persistence pipeline* is too.

**AC-7b (serialization — the highest-value test in this spec, required per REQ §8b):** synchronous calls cannot reach the actual risk window (the `await saveRfqResponse()` line inside `rfqApplyFileProposal()`), so this test needs a genuinely controllable, not-yet-resolved promise at that exact point. **No existing harness in `tests/run.js` provides this today** (`mockSb()`, `tests/run.js:61-74`, resolves every call immediately) — rather than modifying that shared harness (used by many unrelated tests) to add a general-purpose deferred-resolution mode, this spec specifies a minimal, test-local technique: temporarily replace `ctx.persistOrdChange` with a stub the test controls directly, for the duration of this one test only, restoring the original immediately after:
```js
test('rfqApplyFileProposal() serializes against concurrent saveRfqResponse() calls (AC-7b)', async function() {
  resetDB();
  // seed an Order Request with two lines, adversarially similar itemSpec text (per §5's fixture note)
  // ... ord/line A ("R1") / line B ("R2") setup ...
  ctx.cRfqFileImportOrdId = ord.id;
  ctx.cRfqFileImportProposals = { A: { supId: 'sup1', fields: { cost: 10 } }, B: { supId: 'sup1', fields: { cost: 20 } } };

  var resolveFirst;
  var firstCallSeen = false, secondCallStartedWhileFirstPending = false;
  var originalPersist = ctx.persistOrdChange;
  ctx.persistOrdChange = function(ord, skipRefresh) {
    if (!firstCallSeen) {
      firstCallSeen = true;
      return new Promise(function(resolve){ resolveFirst = resolve; }); // deliberately never resolves until the test says so
    }
    return originalPersist(ord, skipRefresh); // second real call, once released
  };

  var applyA = ctx.rfqApplyFileProposal(ord.id, 'A'); // starts, hits the unresolved persistOrdChange, awaits
  var applyB = ctx.rfqApplyFileProposal(ord.id, 'B'); // must be a same-tick no-op — the lock is already set

  assertEqual(ctx.cRfqFileImportApplyInFlight, true, 'lock is held while A is still in flight');
  assert(!!ctx.cRfqFileImportProposals['B'], 'B\'s own proposal is untouched — the second call returned immediately, never even reaching B\'s own logic');

  resolveFirst({ error: null }); // release A
  await applyA;
  await applyB; // B's own call already returned early and resolved; awaiting it here is just for cleanliness

  assertEqual(ctx.cRfqFileImportApplyInFlight, false, 'lock released after A completes');
  assert(!ctx.cRfqFileImportProposals['A'], 'A applied and cleared');
  assert(!!ctx.cRfqFileImportProposals['B'], 'B was never applied by the blocked call — still pending, exactly as before');

  ctx.persistOrdChange = originalPersist;
});
```
This technique (a temporary, test-local function-reference swap, restored immediately after) is minimal-footprint by design — it touches no shared test infrastructure other function tests rely on, mirroring how this codebase already tolerates a test temporarily overriding `ctx.confirm` for the duration of one test (`tests/run.js`, dozens of existing precedents) rather than adding a global confirm-mocking mode. **This is the test that actually proves REQ finding B1 is fixed** — everything else in this plan proves correctness of individual pieces; this one proves they don't race.

**Layout/UI test:** confirm `rOrdLines()`'s output contains the new "Import Supplier Quote File" button wired to `rfqOpenFileImport('<ordId>')` when `lines.length > 0`, and is absent when a line-less Order Request is rendered — mirroring `SPEC-AI-GAP-011-v1.md §11`'s own button-presence test pattern. Also confirm the shared `ord-fileimport-<ordId>` div exists (present, `display:none`).

---

## 14. Version-ship housekeeping (on completion)

Per `CLAUDE.md`'s standing checklist and `REQ-AI-GAP-012 §7`:
- Version bump (next available version number at implementation time), test count, in-app changelog, `docs/version-history.md`.
- `docs/requirements-tracker.md`: new row, noting this as a `REQ-AI-GAP-011` extension (file-upload input path), per `REQ-AI-GAP-012 §7`.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `AI_SYSTEM_PROMPT`: done in §11 above, as part of this spec's own diff, not deferred to a separate housekeeping pass — matching how `SPEC-AI-GAP-011` handled its own mandatory prompt update.
- `docs/user-guide.md`: add a short paragraph to the existing "Comparing supplier quotes (RFQ comparison)" section describing the new button, its CSV-only limitation, and the mandatory pre-send confirmation step — mirroring how `SPEC-AI-GAP-011`'s own housekeeping extended that same section for the envelope button.
