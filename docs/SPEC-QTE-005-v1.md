# SPEC-QTE-005: Customer-facing Quote document (Phase 1) and the internal costing sheet relabel

**Status:** v1 DRAFT — written from `docs/REQ-QTE-005-v7.md` (requirements-gate: round 3 CONDITIONAL PASS, the operator-terms review folded in; **operator OK'd v7 on 2026-11-28**: currency USD, `Shipping:` line yes, quote terms to be supplied by the operator later and entered in Settings). Not yet through the spec-gate.
**Version target:** v2.9.106. **Files touched:** `index.html`, `tests/run.js`, docs.
**Schema impact: none.** Everything renders from existing quote fields; the two new values (`AS.priceBasis`, `AS.quoteTerms`) live in the local `AS` settings object (`K.as`), never on the quote, never Cloud-synced (`AS` is local — absent from `pullAll()`/`pushAll()` entity lists), so no `schema-migration-reviewer` pass. **No terms text exists anywhere in code, tests or shipped docs (REQ-QTE5-011a).**
**GDPR / data flow:** no personal data added; the document is an in-memory blob like the other previews; the two Settings fields are business text in local storage and the backup JSON. Phase 2 (stored copies) is out of scope here.
Citations measured at the current commit (main at 873d3c0 + docs) and checked with `node scripts/check-req-citations.js`.

---

## 1. Summary

| # | Change | Where |
|---|---|---|
| 1 | Pure price model `qteCustomerModel(q)` (live `cQte()`, unit price 4 dp, line total from printed unit price) | new, before `prevQteDoc()` (`index.html:16155`) |
| 2 | Pure document builder `qteCustomerDocHtml(q, opt)` | new |
| 3 | Pre-send dialog `#ov-qdoc` + unsaved-changes dialog `#ov-qunsaved` (both **after** `#ov-qt`) | new overlays |
| 4 | Entry points: modal button `#qt-cust-btn`, list-row control | `3037`, `rQte()` row `~15016` |
| 5 | Form snapshot for the unsaved-changes guard | `openQte()` `15033`, `editQte()` `15061`, `saveQte()` close `15752`, `closeQteDlg()` `15794` |
| 6 | Settings: two new fields wired end to end (HTML, `rCfg()`, `saveCfg()`, restore) | `rCfg()` `13641`, `saveCfg()` `13747`, restore `14202`, form `~644` |
| 7 | Internal sheet: INTERNAL title + banner + relabelled/tooltipped buttons | `prevQteDoc()` `16155`, buttons `3037`/`15016` |
| 8 | Docs, `AI_SYSTEM_PROMPT`, changelog, version strings, tests | §10, §11 |

**Unchanged (confirmed):** the quote engine (`cQteLine`, `qteSellTotals`, `cQte` `14981`), `saveQte()`'s persistence, `buildPdfHeader()` (`11003`, shared with invoices/POs), `buildPdfFooter()` (`11020`), `fmtBankHtml()` (`11038`), `getCoBrand()` (`4684`), the invoice and PO documents, Cloud Data / Sheets.

---

## 2. Pure price model (REQ-QTE5-004, -003)

```js
function qteRound2(x) { return Math.round(x * 100) / 100; }
function qteFmtUnit(u) {                                  // 4 dp, trailing zeros trimmed to a minimum of 2 decimals; thousands separators
  var s = Number(u).toFixed(4);
  while (s.charAt(s.length - 1) === '0' && s.split('.')[1].length > 2) s = s.slice(0, -1);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, function(m, off){ return off < s.indexOf('.') ? ',' : ''; });
}
function qteFmtMoney(x) { return 'USD ' + qteRound2(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, function(m, off, str){ return off < str.indexOf('.') ? ',' : ''; }); }
function qteFmtQty(q) { return String(+Number(q).toFixed(6)); }          // 5, 2.5, 0.001 — trailing zeros trimmed

// Everything the buyer document needs, from the LIVE engine (never the stored calc_* fields, fixed at save time).
function qteCustomerModel(q) {
  var c = cQte(q), markup = +q.markup || 0, oh = c.overheadBreakdown;
  var rows = (q.lines || []).map(function(l, i) {
    var qty = (+l.qty > 0) ? +l.qty : 1;                                  // the Qty USED is the Qty PRINTED
    var S = c.lineCalcs[i].landed * (1 + qteEffectiveMargin(l, markup) / 100);
    var U = Number((S / qty).toFixed(4));
    return { l: l, desc: l.desc || '', uom: l.uom || 'pcs', qty: qty, S: S, U: U, total: qteRound2(U * qty), noCost: !(+l.cost > 0), zeroPrice: !(S > 0) };
  });
  var charges = [
    { key: 'origin', label: 'Origin charges',                              amount: qteRound2(oh.origin) },
    { key: 'dest',   label: 'Destination charges (local freight & taxes)', amount: qteRound2(oh.dest) },
    { key: 'admin',  label: 'Handling & admin',                             amount: qteRound2(oh.admin) }
  ].filter(function(x){ return x.amount > 0; });
  var total = qteRound2(rows.reduce(function(s, r){ return s + r.total; }, 0) + charges.reduce(function(s, x){ return s + x.amount; }, 0));
  return { rows: rows, charges: charges, total: total, engineTotal: c.sellUSD };
}
```
- **Reconciliation (AC-3):** `U` is the printed unit price, `total = round2(U × qty)`, so unit × qty = line total ±0.005; **Total = the sum of the printed lines and printed charges**. The bound versus the engine's unrounded `sellUSD` is `Σ(0.00005 × qty + 0.005) + 0.005 × charges`; tests assert it with an epsilon of 1e-9.
- International freight, insurance and duty are inside `S` (via `landed`) and never appear as rows; the three overhead components are the only charge rows, shown only when non-zero (`c.overheadBreakdown` is the resolved per-quote override-or-default, `qteEffectiveOverhead()`).
- No internal value (`cost`, `supId`, `lid`, SKU, `note`, `priceHistory`, DG surcharge) is read into `rows` except through `S`; `rows[i].l` is kept only for the warning checks of §4.3 and is **never rendered**.

---

## 3. Document builder (REQ-QTE5-003, -007, -008, -010)

```js
// Pure: returns the HTML string. opt = { priceBasis, terms, includeNotes }. Every free-text value goes through san().
function qteCustomerDocHtml(q, opt) {
  var m = qteCustomerModel(q), b = getCoBrand(), colour = b.colour || '#B8283A';
  var pageRef = String(q.num || '').replace(/[^A-Za-z0-9 ._-]/g, '');
  var docTitle = san(q.num || '') + ' — Quotation';
  var pb = String(opt.priceBasis || '').replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 300);
  var terms = String(opt.terms || '').slice(0, 6000);
  var rowsHtml = m.rows.map(function(r){ return '<tr><td>' + san(r.desc) + '</td><td class="n">' + san(qteFmtQty(r.qty)) + '</td><td>' + san(r.uom)
      + '</td><td class="n">' + san(qteFmtUnit(r.U)) + '</td><td class="n">' + san(qteFmtMoney(r.total).slice(4)) + '</td></tr>'; }).join('');
  ...
}
```
Structure (all inside `.doc`, using the **same shell and print CSS as `buildInvDocHtml()`** `11125-11150`: DM Mono/Bebas fonts link, `.topbar` with the Print / Save PDF button, `@page{size:A4;margin:12mm;@bottom-right{content:"<pageRef> · Page x of y"}}`, `tr{break-inside:avoid}`, `thead{display:table-header-group}`):
1. `buildPdfHeader(colour)` — **unmodified**; no `AS.email` fallback.
2. Title **QUOTATION** (Bebas, colour); meta table: **Quote #**, **Date** (`fmtDate(q.dt)`), **Valid until** row **only when `q.validUntil`**.
3. Client block: `<strong>client</strong>` and the line `Shipping: <freight mode>` (`LCL` / `FCL 20GP` / `FCL 40HQ`).
4. Product table: **Description, Qty, UOM, Unit price (USD), Line total (USD)**; then the charge rows (label + amount, right-aligned under Line total) when any; then **Total** `qteFmtMoney(m.total)` (bold).
5. **Price basis:** line `Price basis: <san(pb)>` only when `pb` is non-empty.
6. **Notes** — only when `opt.includeNotes && q.notes`: heading "Notes", body `san(q.notes).replace(/\n/g,'<br>')`, placed immediately after the Total/Price basis.
7. **Terms & conditions** — only when `terms.trim()`: heading, body `san(terms).replace(/\n/g,'<br>')` at 7pt in an `.avoid`-free block (a long block may flow across pages; heading kept with the first lines by `break-after:avoid`).
8. **Payment details** (`fmtBankHtml(AS.bank)`) only when `AS.bank` is non-empty — **no "pending" placeholder text**.
9. `buildPdfFooter()`.
Nothing else prints. The Print button uses the invoice's `setTimeout(print, 200)` handler.

---

## 4. Pre-send dialog `#ov-qdoc` (REQ-QTE5-006, -011)

### 4.1 Markup (placed after `#ov-qt`, before `<!-- AI CHAT FLOATING BUTTON -->` at `index.html:3067`; all `.ov` share one z-index, so an overlay placed before `#ov-qt` would render under the Quote modal)
```html
<div class="ov" id="ov-qdoc" onclick="if(event.target===this)qteCustClose()">
  <div class="modal" style="max-width:680px;">
    <div class="mh"><h2 id="qdoc-title">Customer quote</h2><button class="mx" onclick="qteCustClose()">&#215;</button></div>
    <div class="mb">
      <div id="qdoc-total" style="font-size:.8rem;font-weight:600;margin-bottom:6px;"></div>
      <div id="qdoc-header" style="font-size:.52rem;color:var(--m);margin-bottom:10px;"></div>
      <div id="qdoc-warns" style="margin-bottom:10px;"></div>
      <label class="fld"><span>Price basis <small>(this document only; blank = no line)</small></span><input type="text" id="qdoc-pb" maxlength="300" oninput="qteCustRefresh()"></label>
      <label class="fld"><span>Terms &amp; conditions <small>(this document only)</small></span><textarea id="qdoc-terms" rows="8" maxlength="6000" oninput="qteCustRefresh()"></textarea></label>
      <label id="qdoc-notes-row" style="display:none;"><input type="checkbox" id="qdoc-notes"> Include the quote Notes on the customer quote</label>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;"><button class="btn btn-g" onclick="qteCustClose()">Cancel</button><button class="btn btn-s" id="qdoc-go" onclick="qteCustGenerate()">Generate</button></div>
    </div>
  </div>
</div>
<div class="ov" id="ov-qunsaved"> … three buttons: Save and continue / Continue with saved version / Cancel … </div>
```
State (module-level UI state; `resetDB()` clears none — tests reset): `var _qdocId = null, _qOpenSnap = null;`

### 4.2 Flow
```js
function qteCustFromList(id) { qteOpenCustDialog(id); }                       // modal closed: never compares, never prompts
function qteCustFromModal() {                                                 // the modal's own button (saved quotes only, same visibility as Preview)
  var id = EI.qt; if (!id) return;
  if (_qOpenSnap !== null && qteFormSnapshot() !== _qOpenSnap) { _qunsavedId = id; G('ov-qunsaved').classList.add('on'); return; }
  qteOpenCustDialog(id);
}
async function qteUnsavedSave() {                                             // "Save and continue"
  G('ov-qunsaved').classList.remove('on'); var id = _qunsavedId;
  await saveQte();
  if (G('ov-qt').classList.contains('on')) return;                            // saveQte() closes #ov-qt ONLY after a completed save (index.html:15752); vQte() failure, a cancelled Cloud login and a Supabase error all return early with the modal open → NO document
  qteOpenCustDialog(id);
}
function qteUnsavedContinue() { G('ov-qunsaved').classList.remove('on'); qteOpenCustDialog(_qunsavedId); }
```
- *Save and continue is the operator's own explicit save*: it may create price-history versions and queue catalogue promotions exactly as the normal Save button; generating the document itself writes nothing (AC-8).
- Accepted limitation (REQ): the operator pressing Cancel in the modal while `saveQte()` is awaiting a Cloud call also closes the modal; the document is then built from whatever `DB.qt` holds and the dialog's total/drift warning stay visible.
- `qteOpenCustDialog(id)`: `var q = DB.qt.find(id)`; abort with a toast if missing; `_qdocId = id`; `var m = qteCustomerModel(q)`; fills `qdoc-total` ("Total that will print: USD x"), `qdoc-header` (§4.4), `qdoc-pb.value = AS.priceBasis||''`, `qdoc-terms.value = AS.quoteTerms||''`, the Notes checkbox row shown **only when `q.notes`** and unchecked; `qteCustRefresh()`; opens the overlay.

### 4.3 Warnings — one vocabulary: **warn** (listed, no gate), **ack** (Generate stays disabled until its tick-box is ticked), **block** (Generate disabled)
```js
function qteCustWarnings(q, m, pbText, termsText) {
  var out = [];
  m.rows.forEach(function(r, i) {
    var dl = r.desc.toLowerCase();
    DB.sup.forEach(function(s){ if (s.name && s.name.length >= 3 && dl.indexOf(String(s.name).toLowerCase()) !== -1) out.push({ k: 'sup' + i + s.id, lvl: 'warn', t: 'Line ' + (i+1) + ' description mentions supplier ‘' + s.name + '’ — edit it before sending' }); });
    if (qteIsLinked(r.l)) { var li = DB.li.find(function(x){ return x.id === r.l.lid; }); if (li && li.sku && String(li.sku).length >= 4 && dl.indexOf(String(li.sku).toLowerCase()) !== -1) out.push({ k: 'sku' + i, lvl: 'warn', t: 'Line ' + (i+1) + ' description contains the catalogue SKU ‘' + li.sku + '’' }); }
    if (r.noCost)    out.push({ k: 'nc' + i, lvl: 'warn', t: 'Line ' + (i+1) + ' has no cost basis — its selling price may be wrong' });
    if (r.zeroPrice) out.push({ k: 'zp' + i, lvl: 'warn', t: 'Line ' + (i+1) + ' has a selling price of 0' });
  });
  if (!q.validUntil) out.push({ k: 'val', lvl: 'warn', t: 'No validity date is set — this quote would be open-ended' });
  if (q.status === 'Declined' || q.status === 'Expired') out.push({ k: 'st', lvl: 'warn', t: 'This quote is marked ' + q.status });
  if (qteNormCur(q.currency || 'USD') !== 'USD') out.push({ k: 'cur', lvl: 'ack', t: 'This quote’s currency is ' + (q.currency || '?') + '. The engine prices in USD, so these amounts may not be USD — check the line costs before sending.' });
  var saved = q.calc_sellUSD; if (saved !== undefined && saved !== null && saved !== '' && isFinite(+saved) && Math.abs(m.engineTotal - +saved) > 0.01) out.push({ k: 'drift', lvl: 'ack', t: 'Rates or catalogue changed since this quote was saved: saved total USD ' + (+saved).toFixed(2) + ', now USD ' + m.engineTotal.toFixed(2) });
  var ph = /\[[^\]]*\]/.exec(pbText + '\n' + termsText); if (ph) out.push({ k: 'ph', lvl: 'ack', t: 'Bracketed placeholder still present: ' + ph[0] + ' — I have replaced or accept these' });
  if (!getCoBrand().email) out.push({ k: 'mail', lvl: 'warn', t: 'No email or phone will print — set an email in Settings → Company Branding' });
  if (!(m.total > 0)) out.push({ k: 'zero', lvl: 'block', t: 'The total is 0 — nothing to send' });
  return out;
}
```
- `qteCustRefresh()` recomputes the warnings from the **live dialog fields** (so the placeholder check sees edited text), re-renders `qdoc-warns` (`ack` items as `<label><input type="checkbox" data-k=…> text</label>`; ticks are preserved across refreshes by key), and sets `qdoc-go.disabled = hasBlock || anyUnticked(ack)`. Every warning text is `san()`'d (supplier names, SKUs, placeholder snippets are untrusted).
- The leak check is a **backstop, not a guarantee** (no abbreviations/brand names); the user guide says so.

### 4.4 Effective header shown in the dialog (mirrors `buildPdfHeader()` `11003-11018`)
`name = b.name || AS.name || 'FPM International Ltd'`; `address = b.addr || AS.addr` (`rCfg()` defaults `AS.addr` to "Brighton, UK", `13644` — shown so the operator sees it); `email/phone` printed **only when `b.email`** (phone is concatenated inside the email conditional); `Reg/VAT` as branding holds them. Rendered as one `san()`'d text block.

### 4.5 Generate
```js
function qteCustGenerate() {
  var q = DB.qt.find(function(x){ return x.id === _qdocId; }); if (!q) return;
  var opt = { priceBasis: G('qdoc-pb').value, terms: G('qdoc-terms').value, includeNotes: !!G('qdoc-notes').checked && !!q.notes };
  var html = qteCustomerDocHtml(q, opt);
  var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  var w = window.open(url, '_blank');
  if (!w) { URL.revokeObjectURL(url); toast('Pop-ups are blocked — allow pop-ups for this page, then click Generate again'); return; }   // dialog stays open
  qteCustClose(); toast('Customer quote opened — set the quote status to Sent when you send it. Keep a copy of the PDF you send.');
}
```
Read-only: `qteCustomerModel`, `qteCustomerDocHtml`, `qteCustWarnings`, `qteCustGenerate` never call `sv()`, `saveAll()`, `logEv()`, a Supabase client, or mutate `q`/`DB` (asserted by T-8). Called from `onclick` without async — `qteUnsavedSave()` is the only async handler and its inline caller chains `.catch(function(){})`.

---

## 5. Form snapshot — unsaved-changes guard (REQ-QTE5-002)
```js
function qteFormSnapshot() {
  var n6 = function(x){ return Math.round((+x || 0) * 1e6) / 1e6; }, nb = function(v){ return (v === '' || v === undefined || v === null) ? '' : n6(v); };
  var hdr = ['qf-num','qf-client','qf-dt','qf-valid','qf-cur','qf-mode','qf-st','qf-approved-by','qf-approved-note'].map(function(k){ return String(G(k) ? G(k).value : '').trim(); });
  hdr.push(nb(G('qf-mkp').value));
  ['qf-origOv','qf-destOv','qf-admOv','qf-insRate'].forEach(function(k){ hdr.push(String(G(k).value).trim()); });
  hdr.push(String(G('qf-nt').value).trim());
  var ls = cQL.map(function(l){ var r = l.rid; return [ qlFld(r,'supId'), String(qlFld(r,'desc')).trim(), n6(qlFld(r,'qty')), String(qlFld(r,'uom')), n6(qlFld(r,'cost')), n6(qlFld(r,'cbm')), !!qlFld(r,'dg'), n6(qlFld(r,'dutyPct')), nb(qlFld(r,'mkp')), nb(qlFld(r,'insRate')), l.lid || '', !!l.costManual, !!l.cbmManual ]; });
  return JSON.stringify([hdr, ls]);
}
```
- **Blank vs 0 markup are distinct** (`nb('')` → `''`, `nb('0')` → `0`): changing inherit → explicit 0 differs the snapshot (AC-6).
- The transient version note is excluded. `lid`/`costManual`/`cbmManual` come from `cQL`, not the DOM.
- **Capture points:** `_qOpenSnap = qteFormSnapshot();` as the **last statement of `openQte()` (before `G('ov-qt').classList.add('on')`) and `editQte()`**, i.e. after `rQLT()`/`calcQte()` so the line inputs exist. **Cleared** (`_qOpenSnap = null`) in `closeQteDlg()` (`15794`) and at the `closeM('ov-qt')` in `saveQte()` (`15752`), and wherever else `#ov-qt` is closed (`16141`) — so a list-row click can never see a stale snapshot.
- **Scope:** only `qteCustFromModal()` compares; `qteCustFromList()` never does.

---

## 6. Settings — two fields, end to end (REQ-QTE5-010)
- **Form** (next to the Default Invoice Terms field, `index.html:~645`): `<input id="c-pbasis" maxlength="300" placeholder="Line prices include international freight, insurance and import duty. Origin, destination and handling charges are itemised separately.">` and `<textarea id="c-qterms" maxlength="6000" placeholder="">` (**the terms field has no placeholder text and no default — nothing shipped**).
- **`rCfg()` (`13641`):** `G('c-pbasis').value = AS.priceBasis || ''; G('c-qterms').value = AS.quoteTerms || '';` (no `||'default'` fallbacks).
- **`saveCfg()` (`13747`):** carry both: `priceBasis: qteLimitText(G('c-pbasis').value, 300, 'Price basis', true), quoteTerms: qteLimitText(G('c-qterms').value, 6000, 'Quote terms', false)`:
```js
function qteLimitText(v, max, label, oneLine) {
  v = String(v == null ? '' : v); if (oneLine) v = v.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (v.length > max) { toast(label + ' was longer than ' + max + ' characters and was cut — check the end'); v = v.slice(0, max); }   // never silent
  return v;
}
```
- **Backup (`14153`)** already writes `company: AS`; **restore (`14202`)** becomes `AS = data.company; AS.priceBasis = qteLimitText(AS.priceBasis, 300, 'Price basis', true); AS.quoteTerms = qteLimitText(AS.quoteTerms, 6000, 'Quote terms', false); sv(K.as, AS);` — an old backup without the keys leaves `''` (`qteLimitText` maps absent/`null` to `''`), never the text "undefined".
- The document builder (§3) applies the same slice only as a final guard; it never needs to (the inputs and save/restore already enforce it).

---

## 7. Internal costing sheet and buttons (REQ-QTE5-001)
- `prevQteDoc()` (`16155`): `<title>` becomes `<num> — Quote (INTERNAL)`; a banner `<div style="background:#B8283A;color:#fff;padding:6px 10px;font-weight:700;margin-bottom:10px;">INTERNAL — contains supplier and cost information. Do not send to the client.</div>` is inserted at the top of `<body>` and is **print-visible** (no `@media print` hiding). All other content unchanged.
- Modal: `#qt-prev-btn` (`3037`) label → "Internal costing sheet"; new `<button id="qt-cust-btn" onclick="qteCustFromModal()">Customer quote</button>` beside it; `openQte()` hides it (`15052`-area) and `editQte()` shows it (`15083`-area) — **the same visibility rule as Preview**.
- List row (`~15016`): the existing icon gets `title="Internal costing sheet (not for the client)"`; a second button `Customer quote` → `qteCustFromList('<id>')` (`id` is an app-generated uid/UUID, as for the existing `prevQte('<id>')`).
- `prevQteId()` (`16147`) / `prevQte()` (`16149`) unchanged.

---

## 8. Phase boundaries
No stored copy, no free-form charge lines, no Incoterm field, no e-mailing, no Quote → Invoice conversion (REQ §5). A reprint reflects today's Settings, rates and catalogue (REQ-QTE5-011d: the dialog/toast and user guide tell the operator to keep a copy of each PDF sent).

---

## 9. Documentation, assistant, versioning
1. `AI_SYSTEM_PROMPT` `## Quotes` section — add (no apostrophes in the single-quoted string): `'Customer quote: in Quotes, the Customer quote button (modal or list row) opens a pre-send dialog and then a buyer-facing QUOTATION with a selling price per line, any origin / destination / handling charges as separate lines, a total, an optional price basis line and optional terms. International freight, insurance and import duty are inside the line prices. It never shows supplier, cost, freight, duty or markup. The older Preview is now the Internal costing sheet and must not be sent to a client. Quote terms and price basis are set in Settings; the dialog lets you edit them for one document. The document is generated from the saved quote and is not stored, so keep a copy of each PDF you send.'`
2. `docs/user-guide.md` Quotes section: the two documents, the warnings (supplier names are a backstop only), charge lines, rounding rule, price basis/terms and the placeholder acknowledgement, the unsaved-changes prompt, keep-a-copy advice, that terms need solicitor approval and ship blank.
3. In-app changelog v2.9.106; **three hardcoded version strings** (`<title>` `index.html:9`, the nav badge, `AI_SYSTEM_PROMPT` self-description) → v2.9.106 (`grep -n "v2\.9\.105"`: only the changelog entry and comments remain — recorded in the PR).
4. `docs/version-history.md`, `CLAUDE.md` (version, test count, a design-rules paragraph), `docs/known-gaps.md` (new `QTE-GAP-006`: no stored copy of a sent quote — Phase 2), `STACKD_CONTEXT.md` backlog, `docs/requirements-tracker.md`, Notion rows.

---

## 10. Test plan (`tests/run.js`)

**Harness:** `ctx.open`/`ctx.Blob`/`ctx.URL` stubs as at `tests/run.js:2700-2720`; `makePreviewMock()` for the internal sheet; `mockElements` never cleared → each group resets `qdoc-*`, `qf-*`, `ov-qdoc`, `ov-qunsaved`, `_qdocId`, `_qOpenSnap`; the unsaved-guard tests mirror `cQL` into the mock inputs (`qtMirror()`-style, `dg` via `.value`); `makeClassList()` provides `.classList.contains('on')`.
**Fixtures:** supplier "Qingdao Supplies" (`s1`); item `u1` SKU `CAM-4K`; quotes built directly in `DB.qt` with unique **sentinel** strings in every internal field (supplier name, `lid`, SKU, line `note`, version note, `priceHistory`, `cost`).

| Test | AC | Assertion |
|---|---|---|
| T-1 | 1 | `qteCustomerDocHtml` for a 2-line quote: headers Description/Qty/UOM/Unit price/Line total; S = landed × (1+markup); a per-line markup override changes only that line |
| T-2a/b | 2 | sentinel quote: none of {supplier name, SKU, line note, version note, `cost`, freight/insurance/duty/landed figures, "markup", DG} appears; the **printable description sentinel appears**; Notes appear only with `includeNotes` |
| T-3a–d | 3 | reconciliation: qty 5, 5000, 2.5, 0.001 and stored qty 0 (prints 1): printed unit × printed qty = printed line total ±(0.005+1e-9); Total = sum of printed lines+charges; \|Total − engine\| ≤ the REQ bound |
| T-3e | 3 | `qteFmtUnit` cases: 12.7→`12.70`, 12.7143→`12.7143`, 12.71→`12.71`, 1234.5→`1,234.50` |
| T-4 | 4 | charge rows only when non-zero with the buyer labels; no international freight/insurance/duty row |
| T-5a/b/c | 5 | modal button relabelled + `qt-cust-btn` shown for saved quotes, hidden for a new one; list row control present with the tooltip; internal sheet title/banner (print-visible) |
| T-6a–f | 6 | guard: no change → no prompt; change a line / change only status / change only `costManual` / markup blank→0 → prompt; list-row click never prompts; Cancel generates nothing; "Continue with saved version" shows the **saved** values; Save-and-continue with a failing `vQte()` (and with a cancelled `ensureSbAuth`) opens **no** dialog and leaves `ov-qt` open; a successful save opens the dialog for the captured id |
| T-7a–j | 7 | each warning on its condition (supplier name, SKU ≥4 chars, short SKU ignored, missing `lid` record skipped, no validity, cost 0, price 0, non-USD, Declined/Expired, drift, placeholder in price basis / in terms); `ack` items keep Generate disabled until ticked; absent/non-finite `calc_sellUSD` → no drift warning; Total 0 → Generate disabled; dialog shows the printing Total and the effective header (name/address fallbacks, email-gated phone); `window.open` → null shows the pop-up message and keeps the dialog open |
| T-8 | 8 | generating either document: every `DB` array and `localStorage` byte-identical before/after (spy on `sv`/`saveAll`/`logEv`) |
| T-9 | 9 | `<img onerror>` in client, description, notes, price basis, terms and a supplier name → all escaped (case-insensitive); warning texts escaped |
| T-10a–d | 10 | price basis prints / omitted when blank / newline-collapsed and ≤300; quote terms print only from `AS.quoteTerms` (never `AS.terms`) and are omitted when blank; the dialog edit is not stored and not remembered for the next document |
| T-11a–e | 11 | `saveCfg()` keeps both fields; `rCfg()` loads them with **no default text**; backup→restore carries them; an old backup without them yields `''` (never "undefined"); an over-long value is cut **with** a toast (price basis 300, terms 6000) |
| T-12 | 12 | no `AS.email` fallback: with branding email blank the header has no email; `buildPdfHeader()` output unchanged for invoices |
| T-13 | 14 | a static scan: no terms text and no `quoteTerms` default string exists in `index.html`, `tests/run.js` fixtures or `docs/user-guide.md` (the field is blank by default) |
| T-14a/b | placement | `#ov-qdoc`/`#ov-qunsaved` come after `#ov-qt` and before the AI chat block |
| T-15 | prompt | `AI_SYSTEM_PROMPT` contains the §9.1 passage |
| T-16 | existing | the four existing `prevQteDoc` tests (`tests/run.js:1319`, `2673`, `2712`, + the AC-6 test) still pass; only exact-`<title>` assertions, if any, are adjusted and listed in the PR |

**Mutation tests** (scratch copy; the exact predicted test must fail; restore): (1) a supplier column added back to the customer table → T-2; (2) `cost`/`landed` printed → T-2; (3) line total computed from the engine instead of the printed unit → T-3; (4) notes default-on → T-2b; (5) unsaved-guard compare removed → T-6; (6) Save-and-continue ignores `ov-qt` still open → T-6; (7) Total-0 block removed → T-7; (8) `saveCfg()` drops `priceBasis` → T-11; (9) `AS.terms` used instead of `AS.quoteTerms` → T-10; (10) placeholder check removed → T-7; (11) restore without `qteLimitText` leaves "undefined" → T-11; (12) a generate path that writes (`sv`) → T-8; (13) `san()` removed on the terms → T-9. Expected delta ≈ +45 tests (1258 → ~1303).

---

## 11. Open points for the spec-gate
1. `qteFmtUnit`'s thousands-separator regex (§2) is written for clarity, not brevity — the gate should check it for the edge cases in T-3e (negative values cannot occur; ≥ 1,000,000).
2. The leak-check substring match can false-positive on short supplier names (≥3 chars, REQ); it is a *warn*, so the cost is an extra line in the dialog.
3. `qteFormSnapshot()` reads `qlFld()` (the DOM) — correct in the real DOM after `rQLT()`; the mock harness needs mirrored inputs (§10).
4. `qteUnsavedSave()`'s success signal is the closed modal (REQ-accepted limitation).
5. The dialog's terms/price-basis edits are never stored (REQ-QTE5-011b).
