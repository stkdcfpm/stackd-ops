# SPEC-QTE-001-partB-v1: RFQ Supplier Comparison & Commit

**Implements:** REQ-QTE-001-v3, Part B only (REQ-QTE-001g–q, AC-005–009/011–013/015–017).

**Part A (per-line quote margin) is already shipped** (v2.9.52, `SPEC-QTE-001-v2.md`) and is out of scope here except where Part B's commit hand-off interacts with it (§7, REQ-QTE-001q).

All line citations below were re-verified against the current `index.html` at v2.9.55 (492/492 tests passing) — the REQ's own citations (written against an earlier version of the file) have drifted and are not reused here.

---

## 0. Design notes — two points the REQ leaves for spec-gate to resolve

**0.1 — RFQ response field set must be larger than REQ-QTE-001h's literal list, to satisfy REQ-QTE-001j.**
REQ-QTE-001h lists a response's captured fields as `supId, unit price, currency, MOQ, lead time, payment terms, notes`. REQ-QTE-001j separately *requires* landed cost to be computed via the existing `cQteLine()` rate engine "same freight/duty/insurance calculation used for Quotes." `cQteLine(line, qr, freightMode, totalCBM)` (current body at `index.html:9538-9554`) reads `line.cost`, `line.cbm`, `line.dg`, `line.dutyPct` — none of which are in REQ-QTE-001h's list. Without them, "the same rate engine" cannot actually run (freight/duty/DG-surcharge would silently compute as zero for every response, which is not "the same calculation," it's a different, degraded one).

**Resolution:** the RFQ response object gains three additional fields beyond REQ-QTE-001h's list — `cbm`, `dutyPct`, `dg` (booleans/numbers, all optional, default `0`/`0`/`false`) — using the *same field names* Quote lines already use, so `cQteLine()` can be called directly with a response object as its `line` argument with no adapter/mapping code. The unit-price field is named `cost` (not `price`), again matching Quote line's own field name (confirmed at `index.html:9684`, `addQteLine()`: `cQL.push({ rid: uid(), supId:'', desc:'', qty:1, uom:'pcs', cost:0, cbm:0, dg:false, dutyPct:0 });`) so `cQteLine()` needs zero adaptation. UI labels still say "Unit Cost" / "CBM" / "Duty %" / "Dangerous Goods" to the operator — only the internal field names are dictated by reuse.

**0.2 — Freight basis for a standalone RFQ comparison (no Quote/freight-mode context exists yet).**
`cQteLine()`'s FCL branches (`freightMode === 'FCL 20GP'`/`'FCL 40HQ'`) allocate a *share* of a whole container's flat cost based on `cbm / totalCBM` — a ratio that only makes sense across every line sharing one container in one Quote. At RFQ-comparison time, no Quote or freight-mode decision exists yet — comparing responses is explicitly *prospective*, before commit (REQ-QTE-001o). Forcing an FCL ratio here would require inventing a fictitious "total CBM" with no real meaning.

**Resolution:** RFQ landed-cost ranking always calls `cQteLine(response, QR, 'LCL', response.cbm)` — i.e. treats every response as if it were the sole line in its own LCL shipment (`totalCBM` = its own `cbm`, which only matters for the FCL branches and is therefore inert here). LCL's per-CBM rate (`cbm * qr.lclPerCBM`) is the one freight basis in `cQteLine()` that is unit-comparable across suppliers independent of what else eventually ships alongside it. This is a deliberate simplification, not a defect: it means RFQ ranking is not a prediction of the exact freight cost after a real container/consolidation decision is made — it is a consistent, apples-to-apples comparison of suppliers for one line item, which is what REQ-QTE-001j actually asks for ("ranks responses by landed cost... not raw quoted price"). This does **not** change once the response is committed and converted to a Quote line (§7) — at that point the Quote's own `freightMode`/`totalCBM` (spanning all of that Quote's lines) takes over, exactly as today.

---

## 1. New fields on `DB.ord[].lines[]`

`ordAddLine()` (`index.html:2887-2904`) constructs a new line's field set at the `ord.lines.push({...})` call (lines 2896-2901). Add two fields to that literal:

```js
  ord.lines.push({
    id: uid(), category: category.trim(), itemSpec: itemSpec.trim(),
    orderVolumeQty: orderVolumeQty.trim(), orderVolumeUnit: orderVolumeUnit.trim(),
    packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown',
    sourceCountry: '', variantOption: '', lineUpdates: [],
    rfqResponses: [], committedResponseId: null
  });
```

**Backward compatibility:** every pre-existing `DB.ord[].lines[]` entry (created before this ships) has neither field. Every read of `line.rfqResponses` elsewhere in this spec **must** guard with `(line.rfqResponses || [])`, never assume the array exists — this mirrors the existing defensive-guard convention already used for `line.lineUpdates` in `rOrdLines()` (`(l.lineUpdates||[])`, `index.html:2749`). No migration/backfill function is needed: an absent array reads identically to an empty one under this guard, and the first `openRfqResponse()` save on an old line lazily creates it (§3.3).

A new RFQ response object has this shape (all fields present on every response, id/supId/cost/currency mandatory, the rest default to falsy/empty):

```js
{
  id: <uid>, supId: <DB.sup id, required>, cost: <number, required>, currency: <'USD'|'GBP'|'RMB'|'BBD'>,
  cbm: <number, default 0>, dutyPct: <number, default 0>, dg: <boolean, default false>,
  moq: <string>, leadTime: <string>, paymentTerms: <string>, notes: <string>,
  contactId: <DB.con id, or null>, ts: <ISO timestamp>
}
```

Responses are **append-only** — there is no delete function in this spec (REQ-QTE-001k: "all remain visible as a record of what was compared"). Editing a previously-recorded response is also out of scope; recording a corrected response is simply a new entry.

---

## 2. New modal — `ov-rfq`

Insert immediately after `index.html:436` (the closing `</div>` of the `ov-ord` modal) and before `index.html:438` (`<div class="view" id="v-buy">`), following the existing `.ov`/`.modal`/`.mh`/`.mb`/`.mf`/`.fld` structure used by every other modal in the file (e.g. `ov-ord` itself, lines 401-436):

```html
<div class="ov" id="ov-rfq" onclick="if(event.target===this)closeM('ov-rfq')">
  <div class="modal">
    <div class="mh"><h2 id="rfq-title">RFQ Response</h2><button class="mx" onclick="closeM('ov-rfq')">&#215;</button></div>
    <div class="mb">
      <div class="fld"><label>Supplier</label><select id="rfq-sup"></select></div>
      <div class="fld"><label>Unit Cost</label><input type="number" id="rfq-cost" min="0" step="any"></div>
      <div class="fld"><label>Currency</label><select id="rfq-cur"><option>USD</option><option>GBP</option><option>RMB</option><option>BBD</option></select></div>
      <div class="fld"><label>CBM (per unit, for freight comparison)</label><input type="number" id="rfq-cbm" min="0" step="0.001"></div>
      <div class="fld"><label>Duty %</label><input type="number" id="rfq-dutypct" min="0" max="100" step="0.5"></div>
      <div class="fld"><label><input type="checkbox" id="rfq-dg"> Dangerous Goods</label></div>
      <div class="fld"><label>MOQ</label><input type="text" id="rfq-moq"></div>
      <div class="fld"><label>Lead Time</label><input type="text" id="rfq-leadtime"></div>
      <div class="fld"><label>Payment Terms</label><input type="text" id="rfq-payterms"></div>
      <div class="fld"><label>Supplier Contact (optional)</label><select id="rfq-con"></select></div>
      <div class="fld"><label>Notes</label><textarea id="rfq-notes" rows="2"></textarea></div>
    </div>
    <div class="mf">
      <button class="btn btn-g" onclick="closeM('ov-rfq')">Cancel</button>
      <button class="btn btn-s" onclick="saveRfqResponse()">Save Response</button>
    </div>
  </div>
</div>
```

`#rfq-con` deliberately has no free-text input anywhere in this modal — it is populated exclusively from `DB.con` (§3.1), satisfying REQ-QTE-001i's explicit instruction ("resolves `contactId` to an existing Contact via lookup/select, never a free-text name/email input").

---

## 3. New module-level state and functions

### 3.1 New module-level vars

Add alongside the existing `cConvertId`/`cConvertOrdId` declarations (`index.html:2474-2475`):

```js
var cRfqOrdId = null;
var cRfqLineId = null;
```

Tracks which Order Request + line the `ov-rfq` modal is currently recording a response against (mirroring exactly how `cConvertId`/`cConvertOrdId` track in-progress state for the Quote-conversion modal).

### 3.2 `openRfqResponse(lineId)` — new

```js
function openRfqResponse(lineId) {
  if (!EI.ord) return;
  cRfqOrdId = EI.ord;
  cRfqLineId = lineId;
  G('rfq-sup').innerHTML = '<option value="">— Supplier —</option>' +
    DB.sup.map(function(s){ return '<option value="' + san(s.id) + '">' + san(s.name) + '</option>'; }).join('');
  G('rfq-con').innerHTML = '<option value="">— none —</option>' +
    DB.con.map(function(c){ return '<option value="' + san(c.id) + '">' + san(c.name) + '</option>'; }).join('');
  G('rfq-cost').value = '';
  G('rfq-cur').value = 'USD';
  G('rfq-cbm').value = '';
  G('rfq-dutypct').value = '';
  G('rfq-dg').checked = false;
  G('rfq-moq').value = '';
  G('rfq-leadtime').value = '';
  G('rfq-payterms').value = '';
  G('rfq-con').value = '';
  G('rfq-notes').value = '';
  vClr('rfq-sup'); vClr('rfq-cost');
  G('ov-rfq').classList.add('on');
}
```

### 3.3 `saveRfqResponse()` — new

Follows the exact `if (!x) { vErr(id, msg); return; }` early-validation idiom already used by `saveBuy()` (`index.html:5916-5920`):

```js
function saveRfqResponse() {
  var ord = DB.ord.find(function(o){ return o.id === cRfqOrdId; });
  if (!ord) { closeM('ov-rfq'); return; }
  var line = (ord.lines || []).find(function(l){ return l.id === cRfqLineId; });
  if (!line) { closeM('ov-rfq'); return; }
  var supId = G('rfq-sup').value;
  if (!supId) { vErr('rfq-sup', 'Supplier is required'); return; }
  var costStr = G('rfq-cost').value;
  if (costStr === '' || isNaN(+costStr) || +costStr < 0) { vErr('rfq-cost', 'A valid unit cost is required'); return; }
  vOk('rfq-sup'); vOk('rfq-cost');
  if (!line.rfqResponses) line.rfqResponses = [];
  line.rfqResponses.push({
    id: uid(), supId: supId, cost: +costStr, currency: G('rfq-cur').value,
    cbm: +G('rfq-cbm').value || 0, dutyPct: +G('rfq-dutypct').value || 0, dg: G('rfq-dg').checked,
    moq: G('rfq-moq').value.trim(), leadTime: G('rfq-leadtime').value.trim(),
    paymentTerms: G('rfq-payterms').value.trim(), notes: G('rfq-notes').value.trim(),
    contactId: G('rfq-con').value || null, ts: new Date().toISOString()
  });
  sv(K.ord, DB.ord);
  closeM('ov-rfq');
  renderRfqComparison(cRfqLineId);
  toast('RFQ response recorded');
}
```

Note: `saveRfqResponse()` never writes to `FIELD_MAPS` or calls `syncEnt()`/`delEnt()` — satisfies AC-008/REQ-QTE-001n directly by omission (there is no sync call to remove).

### 3.4 `rfqLandedGBP(r)` — new, pure helper

Implements the §0.2 freight-basis decision:

```js
function rfqLandedGBP(r) {
  var calc = cQteLine(r, QR, 'LCL', +r.cbm || 0);
  return toGBP(calc.landed, r.currency);
}
```

### 3.5 `rfqStalenessWarn(responses)` — new

Implements REQ-QTE-001j's corrected staleness trigger — deliberately **not** a call to `renderDispCurWarn()` (`index.html:3991-4002`), whose early-exit on `QR.displayCurrency === 'GBP'` (line 3993) is exactly backwards for this feature (see REQ-QTE-001j's own analysis). This new function reuses only the visual banner markup and the `st_qr_ts`/24h staleness mechanics, with an independent trigger condition:

```js
function rfqStalenessWarn(responses) {
  var anyNonGBP = responses.some(function(r){ return (r.currency||'USD').toUpperCase() !== 'GBP'; });
  if (!anyNonGBP) return '';
  var ts = localStorage.getItem('st_qr_ts');
  var ageMs = ts ? Date.now() - new Date(ts).getTime() : Infinity;
  if (ageMs < 86400000) return '';
  return '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;margin-bottom:8px;">&#9888; FX rates are stale — GBP-converted landed costs below may not reflect current rates. Update in Settings &rarr; Rates &amp; FX.</div>';
}
```

Trigger is `anyNonGBP && stale`, evaluated **independent of `QR.displayCurrency`** — satisfies AC-013 exactly, including the specific case AC-013 calls out (`QR.displayCurrency` left at its default `'GBP'`, at least one *response's own* currency non-GBP, stale rates → warning still fires).

### 3.6 `ordCommitRfqResponse(lineId, responseId)` — new

Implements REQ-QTE-001k. A second click on an already-committed response's Commit button un-commits it (satisfies AC-007's "un-committing" without a separate button/action type); clicking a different response's Commit button replaces the prior selection (AC-006); no response is ever removed from `rfqResponses[]` by this function.

```js
function ordCommitRfqResponse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  line.committedResponseId = (line.committedResponseId === responseId) ? null : responseId;
  sv(K.ord, DB.ord);
  renderRfqComparison(lineId);
}
```

### 3.7 `renderRfqComparison(lineId)` — new

Mirrors the existing `ordCheckLineGaps()` toggle-panel convention (`index.html:2764-2795` — always sets `panel.style.display = 'block'` then repopulates `innerHTML`, rather than an open/closed toggle):

```js
function renderRfqComparison(lineId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var panel = G('ord-rfq-' + lineId);
  if (!panel) return;
  panel.style.display = 'block';
  var responses = line.rfqResponses || [];
  if (!responses.length) {
    panel.innerHTML = '<div style="color:var(--m);">No RFQ responses recorded yet.</div>' +
      '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;margin-top:4px;" onclick="openRfqResponse(\'' + lineId + '\')">+ Add Response</button>';
    return;
  }
  var ranked = responses.map(function(r){ return { r: r, gbp: rfqLandedGBP(r) }; })
    .sort(function(a,b){ return a.gbp - b.gbp; });
  var rows = ranked.map(function(x){
    var r = x.r;
    var sup = DB.sup.find(function(s){ return s.id === r.supId; });
    var supName = sup ? san(sup.name) : '<em>(supplier deleted)</em>';
    var committed = line.committedResponseId === r.id;
    return '<tr' + (committed ? ' style="background:rgba(74,222,128,.08);"' : '') + '>' +
      '<td>' + supName + (committed ? ' &#10003;' : '') + '</td>' +
      '<td>' + san(String(r.cost)) + ' ' + san(r.currency) + '</td>' +
      '<td>&pound;' + fn(x.gbp,2) + '</td>' +
      '<td>' + san(r.moq||'-') + '</td>' +
      '<td>' + san(r.leadTime||'-') + '</td>' +
      '<td>' + san(r.paymentTerms||'-') + '</td>' +
      '<td><button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="ordCommitRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">' + (committed ? 'Uncommit' : 'Commit') + '</button></td>' +
      '</tr>';
  }).join('');
  panel.innerHTML = rfqStalenessWarn(responses) +
    '<table class="tbl" style="font-size:.5rem;width:100%;"><thead><tr><th>Supplier</th><th>Unit Cost</th><th>Landed (GBP)</th><th>MOQ</th><th>Lead Time</th><th>Payment Terms</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;margin-top:4px;" onclick="openRfqResponse(\'' + lineId + '\')">+ Add Response</button>';
}
```

`sup` resolving to `undefined` (deleted supplier) renders `(supplier deleted)` in place of a crash — this is the "degrades gracefully" behavior REQ-QTE-001m requires (§5) rather than nulling the historical `supId`.

---

## 4. Wiring into `rOrdLines()`

`rOrdLines(ord)` (`index.html:2744-2763`) renders one `<div>` per line. Insert a "Compare RFQs" button and its sibling panel immediately after the existing "Check gaps" button/panel (lines 2759-2760), following the identical `'ord-gapchk-' + l.id` id-templating convention:

```js
      '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.4rem;padding:1px 4px;" onclick="ordCheckLineGaps(\'' + l.id + '\')">Check gaps</button></div>' +
      '<div id="ord-gapchk-' + l.id + '" style="display:none;margin-top:4px;"></div>' +
      '<div style="margin-top:4px;"><button class="btn btn-g" style="font-size:.4rem;padding:1px 4px;" onclick="renderRfqComparison(\'' + l.id + '\')">Compare RFQs (' + (l.rfqResponses||[]).length + ')</button></div>' +
      '<div id="ord-rfq-' + l.id + '" style="display:none;margin-top:4px;"></div>' +
```

The response count in the button label (`(l.rfqResponses||[]).length`) gives the operator an at-a-glance signal of how many responses exist without opening the panel — zero when the array is absent/empty, per the §1 backward-compatibility guard.

---

## 5. `delSup()` extension — REQ-QTE-001m

Current body: `index.html:4747-4777` (reproduced in full in the discovery notes; key lines below). Add a new warn-count check alongside the existing `poCount`/`invRef` checks (after line 4752, before `var warns = []` at line 4753):

```js
  var ordRfqCount = DB.ord.reduce(function(sum, o){
    return sum + (o.lines||[]).filter(function(l){
      return (l.rfqResponses||[]).some(function(r){ return r.supId === id; });
    }).length;
  }, 0);
```

Add the corresponding push alongside the existing two (after line 4755):

```js
  if (ordRfqCount > 0) warns.push(ordRfqCount + ' Order Request line' + (ordRfqCount>1?'s':'') + ' reference RFQ responses from this supplier');
```

Update the existing warning message (line 4757) to mention the new reference class generically:

```js
  if (warns.length) msg += '\n\nWarning: ' + warns.join('\n') + '\n\nThe POs, invoices, and Order Request RFQ responses will remain but will show a missing supplier reference.';
```

**No null-out of `supId` on any `rfqResponses[]` entry, in either the Supabase or local delete branch** — per REQ-QTE-001m's explicit instruction, an orphaned `supId` on a historical response is a record of what was actually compared, not an active reference; §3.7's `renderRfqComparison()` already renders `(supplier deleted)` gracefully instead of crashing when `DB.sup.find()` returns `undefined`. This is the one place this spec deliberately does **not** mirror `delSup()`'s existing `Contact.supplierId = null` treatment — the two references have different semantics (an active FK vs. a historical record) and REQ-QTE-001m calls this out explicitly.

---

## 6. `delCon()` extension — REQ-QTE-001p

Current body: `index.html:10151-10160`. Replace the single top-level null-out (line 10154) with a version that also walks every line's `rfqResponses[]`:

```js
function delCon(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  DB.con = DB.con.filter(function(c){ return c.id !== id; });
  DB.ord.forEach(function(o){
    if (o.contactId === id) o.contactId = null;
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){ if (r.contactId === id) r.contactId = null; });
    });
  });
  sv(K.co, DB.con);
  sv(K.ord, DB.ord);
  logEv('contact', id, 'deleted', 'Contact deleted', 'user');
  rCon();
  toast('Contact deleted');
}
```

No new persistence call is needed — the existing `sv(K.ord, DB.ord)` (unchanged, still present) covers the nested mutation too, exactly as REQ-QTE-001p specifies. No new warning dialog is added, matching this function's existing silent-null convention for the top-level field (REQ-QTE-001p is explicit that this REQ does not introduce an inconsistency by making RFQ responses the one exception).

---

## 7. `ordConvertToQuote()` extension — REQ-QTE-001l, REQ-QTE-001q

Current body: `index.html:2709-2714`. `openConvertToQuote()` (called from within) resets `cQL = []` via `openQte()` (`index.html:9623-9644`, reset at line 9624) — so any hand-off seeding must happen **after** `openConvertToQuote()` returns, not before:

```js
function ordConvertToQuote(ordId) {
  var ord = DB.ord.find(function(o){ return o.id === ordId; });
  if (!ord) return;
  cConvertOrdId = ordId;
  openConvertToQuote(ord.contactId);
  var committedLines = (ord.lines || []).filter(function(l){ return l.committedResponseId; });
  committedLines.forEach(function(l){
    var resp = (l.rfqResponses || []).find(function(r){ return r.id === l.committedResponseId; });
    if (!resp) return;
    cQL.push({
      rid: uid(), supId: resp.supId, desc: l.itemSpec, qty: 1, uom: 'pcs',
      cost: resp.cost, cbm: resp.cbm || 0, dg: !!resp.dg, dutyPct: resp.dutyPct || 0
    });
  });
  if (committedLines.length) rQLT();
}
```

Field-for-field, this matches the exact shape `addQteLine()` already pushes onto `cQL` (`index.html:9684`) and that `rQLT()` (`index.html:9684` onward) already knows how to render into editable DOM inputs (`ql-supId-<rid>`, `ql-desc-<rid>`, etc.) — **no new rendering code is needed**, `rQLT()` handles a programmatically-seeded `cQL` entry identically to a manually-added one. `qty` defaults to `1` since neither an Order Request line nor an RFQ response records a quantity in this REQ's scope (out of scope per REQ-QTE-001h's field list) — the operator adjusts it in the Quote form like any other line.

**Deliberately omitted field: `markup`.** Per REQ-QTE-001q, a hand-off-created line does not set `markup` at all (leaves it `undefined`), so it inherits the new quote's quote-level default margin exactly like a manually-added line with no override — `qteEffectiveMargin()` (`index.html:9556-9559`) already treats an absent `markup` this way with no code change needed here. This satisfies AC-016 by construction (there is no code path that could set it).

If `ord.contactId` is falsy (no linked Contact), `openConvertToQuote(undefined)` behaves exactly as it does today for that case (unaffected by this change) — this spec only adds behavior after that call returns, it does not alter `openConvertToQuote()` itself.

---

## 8. `AI_SYSTEM_PROMPT` update (mandatory per `CLAUDE.md`)

Insert a new paragraph immediately after the existing "Per-line gap check (v2.9.50)" paragraph (`index.html:7860`) and before the `get_suppliers`/`get_buyers` guidance paragraph (`index.html:7861`), in the same array-of-strings format:

```js
  'RFQ supplier comparison (v2.9.5x): each Order Request line can record multiple suppliers\' RFQ responses (unit cost, currency, CBM, duty %, DG flag, MOQ, lead time, payment terms, optional linked Contact, notes) via "Compare RFQs" → "+ Add Response". Responses are ranked by landed cost converted to GBP (same rate engine as Quotes, LCL basis) — the nominal cheapest quoted price is not always the landed-cheapest once freight/duty/DG are factored in and currencies are converted. Exactly one response per line can be marked Committed at a time; committing again on a different response replaces the prior choice, and no response is ever deleted — all remain visible as a record of what was compared. Converting a Contact\'s Order Request to a Quote ("Create Quote") pre-fills one Quote line per line that has a committed response, carrying over that response\'s supplier and unit cost — the operator never has to retype them. A committed line\'s new Quote line has no per-line margin override set; it uses the quote\'s own default margin like any manually-added line.',
```

---

## 9. FM-1 / GDPR re-confirmation

Re-verified against the current file (not merely re-asserted from the REQ): `FIELD_MAPS` (`index.html:3583-3593`) has 9 keys — `sup, li, inv, cn, po, payments, sh, qt, co` — no `ord` key exists, and `FIELD_MAPS.qt` does not include `lines`. `rfqResponses`/`committedResponseId` are added only to `DB.ord[].lines[]`, which has no sync mapping. No new `syncEnt()`/`delEnt()` call is added anywhere in this spec. **FM-1 category-3 precedent holds, unchanged from the REQ's own assessment; no council decision required.**

GDPR: the only field on a new RFQ response capable of referencing a person is `contactId`, a FK into the already-governed `DB.con` entity (REQ-QTE-001i) — populated exclusively via the `#rfq-con` `<select>` in §2/§3.1/§3.2, with no free-text name/email/phone field anywhere in the `ov-rfq` modal or the response object shape in §1. `delCon()`'s extension (§6) ensures a deleted Contact's id cannot be left dangling inside a nested `rfqResponses[]` entry, closing the exact gap class already logged for the top-level field.

---

## 10. Test plan

| AC | Test |
|---|---|
| AC-005 | Two responses on one line, different currencies, where the raw-cheapest-in-its-own-currency response is not the GBP-landed-cheapest once converted — assert `renderRfqComparison()`'s ranked order (or the underlying sort) puts the true landed-cheapest first. |
| AC-006 | `ordCommitRfqResponse(lineId, respA)` then `ordCommitRfqResponse(lineId, respB)` — assert `line.committedResponseId === respB.id`, never both. |
| AC-007 | After committing then un-committing (`ordCommitRfqResponse(lineId, sameId)` called twice), assert `line.rfqResponses.length` is unchanged and `committedResponseId === null`. |
| AC-008 | Assert `saveRfqResponse()` and `ordCommitRfqResponse()` never call `syncEnt`/`delEnt` (spy/stub check) and that `FIELD_MAPS.ord` remains undefined. |
| AC-009 / AC-015 | Commit responses on two lines of one Order Request; call `ordConvertToQuote(ordId)`; assert the resulting `cQL` has two entries, each with the committed response's `supId` and `cost`, and the operator did not need to re-enter either. |
| AC-011 | Record an RFQ response referencing Supplier X; call `delSup(X.id)` with `confirm` stubbed to auto-return true after capturing the message; assert the confirm message includes the Order-Request-RFQ warning count, and afterward `renderRfqComparison()` on that line renders without throwing and shows "(supplier deleted)". |
| AC-012 | Assert a saved RFQ response object's keys are exactly `{id,supId,cost,currency,cbm,dutyPct,dg,moq,leadTime,paymentTerms,notes,contactId,ts}` — no `name`/`email`/`phone` key exists on the object under any code path. |
| AC-013 | Two variants: (a) one response with `currency:'USD'`, `QR.displayCurrency` left at default `'GBP'`, `st_qr_ts` unset/stale — assert `rfqStalenessWarn()` returns non-empty; (b) all responses `currency:'GBP'` — assert it returns `''` regardless of `st_qr_ts`. |
| AC-016 | After `ordConvertToQuote()`, assert every seeded `cQL` entry has no `markup` key (`'markup' in entry === false`, or `entry.markup === undefined`). |
| AC-017 | Record an RFQ response with a `contactId`; call `delCon(contactId)`; assert the *nested* `line.rfqResponses[].contactId` is `null` post-delete, not merely the top-level `DB.ord[].contactId`. |

All tests use `mockSb`-free, synchronous `DB`/`sv` state — no async/`testAsync()` conversion is needed anywhere in this spec (every new function here is synchronous; `_sb`/Supabase is untouched by this feature, consistent with REQ-QTE-001n).

---

## 11. Explicitly out of scope (unchanged from the REQ)

- Blending supplier reliability/performance signals into ranking (Open Question 1 — deferred to `REQ-RPT-001 G-09`).
- Editing or deleting a previously-recorded RFQ response.
- A new Sheets/CSV sync surface for RFQ data.
- Any change to `openConvertToQuote()`'s existing Contact-only behavior, or to `saveQte()`'s persistence logic — the hand-off in §7 only pushes onto `cQL` before the operator reviews and saves the Quote form normally, it does not bypass any existing validation.
