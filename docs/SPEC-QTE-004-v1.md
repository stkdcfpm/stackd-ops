# SPEC-QTE-004: Link Quote lines to existing Line Items (catalogue-assisted line entry)

**Status:** v1 DRAFT — written from the gate-passed `docs/REQ-QTE-004-v5.md` (requirements-gate PASS, round 5). Not yet through the spec-gate.
**Version target:** v2.9.105. **Files touched:** `index.html` (quote grid, two new overlays, helpers, `saveQte()`, `qteToPoConvert()`, `delLI()`, one integrity check, comments, AI prompt, changelog, version strings), `tests/run.js`, docs.
**Schema impact: none.** `lid`, the snapshot and the two flags ride inside the existing `quotes.lines` jsonb (REQ §5; the `lines` column is opaque to Cloud Data). No new `K` key, no migration, no Sheets mapping change (`FIELD_MAPS.qt` carries no lines, `index.html:5146`), so no `schema-migration-reviewer` pass is needed.
**Urgency:** the operator needs this to raise a real container-load quote; the spec is written so the build can start the moment it passes the gate.
Citations were measured at the current commit (main at e5d3249) and checked with `node scripts/check-req-citations.js`.

---

## 1. Summary

| # | Change | Where |
|---|---|---|
| 1 | Fix the grid re-render data loss: `syncQLFromDOM()` before every re-render; note input gets a `value` | `addQteLine()` `15066`, `removeQteLine()` `15071`, `rQLT()` `15077` |
| 2 | "Add from Catalogue" picker (multi-select), per-line "Link to catalogue" (single) and "Unlink" | new overlay `#ov-qpick`, quote grid |
| 3 | Manual-rate prompt for non-USD/GBP/BBD currencies | new overlay `#ov-qrate`, `qteAskRate()` |
| 4 | Linked-line fields, cost-as-line-total, CBM from dims, manual flags, qty rescale | helpers §2, handlers §3 |
| 5 | Drift badge + Refresh | §5 |
| 6 | `saveQte()` carries the link keys forward; promotion queue matches by link | `saveQte()` `15264`, promotion block |
| 7 | PO conversion carries `lid`/`sku` and converts cost to per-unit for linked lines | `qteToPoConvert()` `15763` |
| 8 | `delLI()` warns about quotes; integrity check exempts quote-line `lid`; stale comments/tests | `delLI()` `8512`, `verifyFkIntegrityAfterCleanup()` `12408` |
| 9 | Grid header "Cost (USD, line total)" | `rQLT()` |
| 10 | Docs, `AI_SYSTEM_PROMPT`, changelog, version strings, tests | §9, §10 |

**Unchanged (confirmed):** `cQteLine()`/`cQte()`/`qteSellTotals()` and the pricing chain; the invoice picker (`openPicker()` `8892`, `rPickList()`, `doPick()`) and its tests; `prevQteDoc()` `15844`; `renderQteSourceDriftWarn()` `15963`; the Quote-level Currency field (`qf-cur`) stays a label; Cloud Data refresh/insert paths; `migrateLineItemsToSupabase()`'s `lid` sweep (`7104`).

---

## 2. Pure helper layer (REQ §3 "linked line", REQ-QTE4-003/004/005)

Placed together immediately before `addQteLine()` (`index.html:15066`). None of these touches the DOM, `DB` or storage.

```js
function qteNormCur(c) { return String(c == null ? '' : c).trim().toUpperCase(); }   // 'gbp ' -> 'GBP'; blank stays ''
function qteR4(x) { return Math.round(x * 10000) / 10000; }                            // computed line cost
function qteR6(x) { return Math.round(x * 1000000) / 1000000; }                        // computed CBM (matches calcLICBM's toFixed(6))
// One definition of "linked" for the whole feature (REQ "Definition — linked line").
function qteIsLinked(l) {
  return !!(l && l.lid) && isFinite(+l.lidUnitUSD) && l.lidUnitUSD !== '' && l.lidUnitUSD !== null
      && isFinite(+l.lidRate) && +l.lidRate > 0;
}
// USD per 1 unit of the catalogue currency from STORED rates, or null if not convertible from them.
// Zero/unset stored rates fall back to QR_DEFAULTS exactly as toGBP()/fromGBP() do (index.html:5620-5638).
function qteStoredRate(cur) {
  var gbpusd = QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD, gbpbbd = QR.fxGBPBBD || QR_DEFAULTS.fxGBPBBD;
  var c = qteNormCur(cur);
  return c === 'USD' ? 1 : c === 'GBP' ? gbpusd : c === 'BBD' ? gbpusd / gbpbbd : null;
}
// Prompt group key: RMB and CNY are one group; blank stays its own ('') group.
function qteRateGroup(cur) { var c = qteNormCur(cur); return c === 'CNY' ? 'RMB' : c; }
// A pre-fill suggestion for the manual-rate prompt (RMB only); the operator must still confirm it.
function qteRateSuggestion(group) {
  return group === 'RMB' ? (QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD) / (QR.fxGBPRMB || QR_DEFAULTS.fxGBPRMB) : null;
}
// Per-unit CBM from the catalogue dims (cm), or null when any dimension is missing/non-positive.
function qteUnitCbm(li) {
  var d = li && li.dims;
  return (d && +d.l > 0 && +d.w > 0 && +d.h > 0) ? (+d.l * +d.w * +d.h) / 1000000 : null;
}
// Applies a link to a quote line IN PLACE (a cQL entry): fills the catalogue-derived fields for `qty`
// and writes the snapshot. Never touches rid, dutyPct, markup, insRate, note, priceHistory or sourceOrd* keys.
function qteApplyLink(l, li, qty, rate, src) {
  var q = (+qty > 0) ? +qty : 1;
  var unitUSD = (+li.cost || 0) * rate;
  var unitCbm = qteUnitCbm(li);
  l.supId = DB.sup.some(function(s){ return s.id === li.supId; }) ? li.supId : '';   // never write an unresolvable id (REQ-QTE4-012a)
  l.desc = li.desc || ''; l.uom = li.uom || 'pcs'; l.dg = !!li.dg; l.qty = q;
  l.cost = qteR4(unitUSD * q);
  l.cbm = unitCbm !== null ? qteR6(unitCbm * q) : 0;
  l.lid = li.id; l.lidCost = +li.cost || 0; l.lidCur = qteNormCur(li.cur);
  l.lidRate = rate; l.lidRateSrc = src; l.lidUnitUSD = unitUSD; l.lidAt = new Date().toISOString();
  if (unitCbm !== null) l.lidUnitCBM = unitCbm; else delete l.lidUnitCBM;
  delete l.costManual; delete l.cbmManual;
  return l;
}
var QTE_LINK_KEYS = ['lid','lidCost','lidCur','lidRate','lidRateSrc','lidUnitUSD','lidAt','lidUnitCBM','costManual','cbmManual'];
```
- `qteIsLinked()` is the single predicate used by the qty rescale (§3.3), the Link/Unlink toggle (§5.3), the drift badge (§5.1), promotion (§6.2), `delLI()`'s count (§8.1) and PO conversion (§7). A `lid` with a missing/garbage snapshot is *unlinked* in all of them.
- `qteApplyLink()` resets `costManual`/`cbmManual` (REQ-QTE4-011/007) and clears a stale `lidUnitCBM`. Computed values are rounded (`qteR4`/`qteR6`); an operator-typed Cost is never rounded (REQ-QTE4-003).
- `lidUnitUSD` is stored unrounded (REQ-QTE4-003).

---

## 3. Grid state — the re-render fix and the linked-line handlers (REQ-QTE4-010, REQ-QTE4-003/005)

### 3.1 `syncQLFromDOM()`
```js
// Writes the live grid inputs back into cQL (they are otherwise only ever READ through qlFld()), so a re-render
// built from cQL cannot discard typing. Link keys and the manual flags are line STATE and are never touched here.
function syncQLFromDOM() {
  cQL.forEach(function(l) {
    var rid = l.rid;
    l.supId = qlFld(rid, 'supId');   l.desc = qlFld(rid, 'desc');
    l.qty = +qlFld(rid, 'qty') || 1; l.uom = qlFld(rid, 'uom') || 'pcs';
    l.cost = +qlFld(rid, 'cost') || 0; l.cbm = +qlFld(rid, 'cbm') || 0;
    l.dg = !!qlFld(rid, 'dg');       l.dutyPct = +qlFld(rid, 'dutyPct') || 0;
    var mk = qlFld(rid, 'mkp');      if (mk === '') delete l.markup;  else l.markup = +mk;
    var ir = qlFld(rid, 'insRate');  if (ir === '') delete l.insRate; else l.insRate = +ir;
    l.note = qlFld(rid, 'note');     // transient version note; never persisted (saveQte()'s literal does not carry it)
  });
}
```
- **`qlFld()` returns `''` when the element is missing** (`index.html:15050-15054`), which would blank every field if called with no rendered grid. Therefore `syncQLFromDOM()` returns immediately when `G('qt-lines')` has no `ql-*` inputs: `if (!G('qt-lines') || !cQL.length) return;`. (In the real DOM after `rQLT()` every input exists and holds the `cQL` value, so a sync is a no-op until the operator types.)
- **Called first** in `addQteLine()`, `removeQteLine()`, `qteAddFromCatalogue()` (and again *after* its awaits — §5.2), `qteLinkExisting()`, `qteUnlink()`, `qteRefreshLine()`.

### 3.2 `addQteLine()` / `removeQteLine()` / `rQLT()` edits
```js
function addQteLine() {
  syncQLFromDOM();
  cQL.push({ rid: uid(), supId:'', desc:'', qty:1, uom:'pcs', cost:0, cbm:0, dg:false, dutyPct:0 });
  rQLT(); calcQte();                       // calcQte() added (REQ §2: addQteLine never recalculated after re-rendering)
}
function removeQteLine(rid) { syncQLFromDOM(); cQL = cQL.filter(...); rQLT(); calcQte(); }
```
`rQLT()` (`15077`) changes:
1. Header `Cost (USD)` → `Cost (USD, line total)` (visible on every line, linked or not — REQ-QTE4-003; to be called out in the user guide/changelog). No existing test asserts the old header text (REQ-gate round 4).
2. The note input renders its value: `... id="ql-note-RID" value="' + san(l.note||'') + '" ...` (it currently has none, `index.html:15114`-area).
3. Cost input: `oninput="qlCostTyped('RID')"` (was `calcQte()`); CBM input: `oninput="qlCbmTyped('RID')"`; Qty input: `oninput="qlQtyChanged('RID')"`.
4. **Description cell** gains a second line under the text input, only when applicable:
   - Linked line (`qteIsLinked(l)`): `<div class="qte-lnk">🔗 <SKU or desc of the live item, san'd> ...</div>` plus the drift state of §5.1.
   - Linked line with catalogue cost `0`: "No cost basis in catalogue".
   - Linked line whose `supId` is blank: "Catalogue item has no valid supplier — select one".
   - No new table column (the history row's `colspan="15"` is unchanged).
5. **Actions cell** gains `Link` (unlinked lines → `qteOpenPicker('single','RID')`) or `Unlink` (linked lines → `qteUnlink('RID')`), beside the existing history/× buttons.
6. A new button beside "+ Add Line" (`index.html:3003`): `Add from Catalogue` → `qteOpenPicker('multi')`.

### 3.3 Typed-input handlers and the qty rescale (REQ-QTE4-009a)
```js
function qlLine(rid) { return cQL.find(function(l){ return l.rid === rid; }); }
function qlCostTyped(rid) { var l = qlLine(rid); if (l && qteIsLinked(l)) l.costManual = true; calcQte(); }   // operator typing only
function qlCbmTyped(rid)  { var l = qlLine(rid); if (l && qteIsLinked(l)) l.cbmManual  = true; calcQte(); }
function qlQtyChanged(rid) {
  var l = qlLine(rid), q = +qlFld(rid, 'qty');
  if (l && qteIsLinked(l) && q > 0) {                     // blank/zero/negative qty leaves cost and CBM unchanged
    if (!l.costManual) { l.cost = qteR4(l.lidUnitUSD * q); G('ql-cost-' + rid).value = l.cost; }
    if (!l.cbmManual && l.lidUnitCBM != null) { l.cbm = qteR6(l.lidUnitCBM * q); G('ql-cbm-' + rid).value = l.cbm; }
  }
  calcQte();
}
```
- The rescale writes `input.value` **directly** (a programmatic write fires no `input` event), so it can never set a manual flag; only `qlCostTyped`/`qlCbmTyped`, which are bound to real `oninput`, do. Typing a value equal to the auto value still sets the flag (conservative, per REQ).
- `l.costManual`/`l.cbmManual` live on the `cQL` entry; `saveQte()` reads them from `cQL`, never from the DOM, and `syncQLFromDOM()` never clears them.
- A manually typed Cost is a **line total** (REQ §1.1): after typing 42 and raising Qty 1 → 6 the line's unit cost is 7; that figure feeds promotion (§6.2) and the PO per-unit conversion (§7).

---

## 4. Overlays (REQ-QTE4-002, REQ-QTE4-004)

Both overlays are placed in the static HTML **after the `#ov-qt` block, before `<!-- AI CHAT FLOATING BUTTON -->` (`index.html:3028`)** — `#ov-pick` (`2749`) precedes `#ov-qt` (`2955`) and all `.ov` elements share the same fixed z-index, so reusing `#ov-pick` or placing a new overlay before `#ov-qt` would render it **under** the Quote modal. The mock harness cannot see stacking, so acceptance is a DOM-order assertion (T-13) plus a manual-test note in the PR.

### 4.1 Quote catalogue picker `#ov-qpick`
```html
<div class="ov" id="ov-qpick" onclick="if(event.target===this)qteClosePicker()">
  <div class="modal" style="max-width:640px;">
    <div class="mh"><h2 id="qpick-title">Add from Catalogue</h2><button class="mx" onclick="qteClosePicker()">&#215;</button></div>
    <div class="mb">
      <input class="sb" type="text" placeholder="Search items..." id="qpick-q" oninput="rQPickList()" style="width:100%;margin-bottom:8px;box-sizing:border-box;">
      <div id="qpick-list"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;"><button class="btn btn-g" onclick="qteClosePicker()">Cancel</button><button class="btn btn-s" id="qpick-ok" onclick="qtePickConfirm()">Add Selected</button></div>
    </div>
  </div>
</div>
```
State (module-level UI state, not `DB`; `resetDB()` clears none of it — tests reset explicitly): `var _qpickMode = 'multi', _qpickRid = null, _qpickChecked = {};`
- `qteOpenPicker(mode, rid)`: if `!DB.li.length` → `toast('No items in the catalogue yet.')` and return; sets state; clears `qpick-q`; `rQPickList()`; `G('ov-qpick').classList.add('on')`. In `'single'` mode the title reads "Link to catalogue item" and the button "Link".
- `rQPickList()`: **list rendering mirrors `rPickList()` (`8899`)** — search by desc/SKU (case-insensitive), grouped by supplier (`gsn(a).localeCompare(gsn(b))`, blank group last, header "No Supplier"), each row `san()`'d, showing desc, supplier, UOM, `fmtN(li.cost, li.cur, 3)` and the catalogue sell price **for reference only**. Marks "✓ already on this quote" when any `cQL` line has `lid === li.id` (adding the same item twice is allowed). Rows with a catalogue cost of 0 show "no cost basis". Rows in multi mode have a checkbox bound to `_qpickChecked`; in single mode a click selects exactly one.
- The invoice picker functions are **not modified**; a small shared renderer is *not* extracted (the two lists differ in their per-row annotations and bindings; duplicating ~20 lines is the lower-risk choice for AC-13).
- `qtePickConfirm()`: closes the picker (`qteClosePicker()` clears `on`), then `multi` → `qteAddFromCatalogue(ids).catch(function(){})`; `single` → `qteLinkExisting(_qpickRid, id).catch(function(){})`.

### 4.2 Manual-rate modal `#ov-qrate`
```html
<div class="ov" id="ov-qrate" onclick="if(event.target===this)qteRateCancel()">
  <div class="modal" style="max-width:440px;">
    <div class="mh"><h2>USD rate needed</h2><button class="mx" onclick="qteRateCancel()">&#215;</button></div>
    <div class="mb">
      <p id="qrate-msg" style="font-size:.6rem;color:var(--m);margin-bottom:10px;"></p>
      <input type="number" id="qrate-in" step="any" min="0" style="width:100%;box-sizing:border-box;">
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;"><button class="btn btn-g" onclick="qteRateCancel()">Cancel</button><button class="btn btn-s" onclick="qteRateOk()">Use this rate</button></div>
    </div>
  </div>
</div>
```
```js
var _qrateResolve = null;
function qteAskRate(group, suggestion) {          // the ONE function tests replace; resolves a positive number or null
  return new Promise(function(resolve) {
    if (_qrateResolve) _qrateResolve(null);          // never leave an earlier prompt hanging
    _qrateResolve = resolve;
    G('qrate-msg').textContent = group === ''
      ? 'Catalogue currency is blank — enter the USD value of one unit of the currency this cost is actually in.'
      : 'Enter the USD value of 1 ' + group + ' (for example ' + (suggestion ? suggestion.toFixed(4) : '1.0800') + '). This rate is recorded on the quote line.';
    G('qrate-in').value = suggestion ? String(+suggestion.toFixed(6)) : '';
    G('ov-qrate').classList.add('on');
  });
}
function qteRateOk() { var v = +G('qrate-in').value; qteRateDone((isFinite(v) && v > 0) ? v : null); }
function qteRateCancel() { qteRateDone(null); }
function qteRateDone(v) { G('ov-qrate').classList.remove('on'); var r = _qrateResolve; _qrateResolve = null; if (r) r(v); }
```
- `qrate-msg` is set with `textContent` (the `group` is the normalised catalogue currency text — untrusted — so it is never put through `innerHTML`).
- Blank/zero/negative/non-numeric entry → `null` (cancel); no unconverted number is ever used (AC-3).

---

## 5. Link flows (REQ-QTE4-001/003/004/007/011/012)

### 5.1 Drift state (pure) and badge
```js
// null when not linked or no drift; otherwise {kind:'removed'|'cur'|'cost', li, was, now, cur}
function qteDrift(l) {
  if (!qteIsLinked(l)) return null;
  var li = DB.li.find(function(x){ return x.id === l.lid; });
  if (!li) return { kind: 'removed' };
  if (qteNormCur(li.cur) !== qteNormCur(l.lidCur)) return { kind: 'cur', li: li, now: qteNormCur(li.cur) };
  if (Math.abs(liHistMilli(li.cost) - liHistMilli(l.lidCost)) >= 1)         // native currency, integer thousandths (helper from v2.9.104)
    return { kind: 'cost', li: li, was: +l.lidCost || 0, now: +li.cost || 0, cur: qteNormCur(li.cur) || 'USD' };
  return null;
}
```
Comparison is in the **catalogue's own currency** so an FX-rate change alone never triggers it. Badge text (all `san()`'d): `cost` → "Catalogue cost changed since quoted: was `<fmtN(was,cur,3)>`, now `<fmtN(now,cur,3)>` [Refresh cost]"; `cur` → "Catalogue currency changed to `<cur>` — review manually [Refresh cost]"; `removed` → "Catalogue item removed". The badge never changes the quote's cost.

### 5.2 `qteAddFromCatalogue(ids)` (multi-select)
```js
async function qteAddFromCatalogue(ids) {
  var items = ids.map(function(id){ return DB.li.find(function(x){ return x.id === id; }); }).filter(Boolean);
  var rates = {};                                       // group -> {rate, src} | null (cancelled)
  for (var i = 0; i < items.length; i++) {
    var g = qteRateGroup(items[i].cur);
    if (g in rates) continue;
    var st = qteStoredRate(g);
    if (st !== null) { rates[g] = { rate: st, src: 'stored' }; continue; }
    var v = await qteAskRate(g, qteRateSuggestion(g));          // ONE prompt per distinct group in the batch
    rates[g] = (v > 0) ? { rate: v, src: 'manual' } : null;
  }
  syncQLFromDOM();                                       // AGAIN after the awaits — the grid may have changed while a prompt was open
  var skipped = [];
  items.forEach(function(li) {
    var r = rates[qteRateGroup(li.cur)];
    if (!r) { skipped.push(li.sku || li.desc || li.id); return; }
    var l = { rid: uid(), dutyPct: 0 };
    qteApplyLink(l, li, 1, r.rate, r.src);
    cQL.push(l);
  });
  rQLT(); calcQte();
  toast(skipped.length ? ('Skipped (no rate entered): ' + skipped.join(', ')) : (items.length + ' item' + (items.length !== 1 ? 's' : '') + ' added'));
}
```
- GBP/BBD/USD never prompt; RMB and CNY are one group; all blank-currency items are one group `''`; cancelling a group skips only that group's items; cancelling every prompt appends nothing (AC-3).
- A line gets `qty` 1; the operator edits qty in the grid and the §3.3 rescale applies. A catalogue cost of 0 links with cost 0 (the grid shows "No cost basis in catalogue").

### 5.3 `qteLinkExisting(rid, liId)` and `qteUnlink(rid)`
```js
async function qteLinkExisting(rid, liId) {
  syncQLFromDOM();
  var l = qlLine(rid), li = DB.li.find(function(x){ return x.id === liId; });
  if (!l || !li) return;
  var nonDefault = (l.desc||'').trim() !== '' || (l.supId||'') !== '' || (+l.cost||0) > 0 || (+l.cbm||0) > 0 || !!l.dg;
  if (nonDefault && !confirm('Linking replaces this line\'s supplier, description, UOM, cost, DG and CBM with the catalogue values (Qty, Duty %, markup and insurance overrides are kept). Continue?')) return;
  var g = qteRateGroup(li.cur), st = qteStoredRate(g), r;
  if (st !== null) r = { rate: st, src: 'stored' };
  else { var v = await qteAskRate(g, qteRateSuggestion(g)); if (!(v > 0)) return; r = { rate: v, src: 'manual' }; }
  syncQLFromDOM();
  qteApplyLink(l, li, +qlFld(rid, 'qty') || l.qty, r.rate, r.src);       // typed Qty is kept; flags reset by qteApplyLink
  rQLT(); calcQte();
}
function qteUnlink(rid) {
  syncQLFromDOM(); var l = qlLine(rid); if (!l) return;
  QTE_LINK_KEYS.forEach(function(k){ delete l[k]; });                    // values unchanged; BOTH manual flags removed
  rQLT(); calcQte();
}
```
**Quote status:** Accepted/Rejected quotes get no new lock — linking is an ordinary line edit (REQ-QTE4-012d); `vQte()`/`saveQte()` have none (`index.html:15252-15262`).

### 5.4 `qteRefreshLine(rid)` (REQ-QTE4-007)
```js
async function qteRefreshLine(rid) {
  syncQLFromDOM();
  var l = qlLine(rid); if (!l || !qteIsLinked(l)) return;
  var li = DB.li.find(function(x){ return x.id === l.lid; });
  if (!li) { toast('Catalogue item removed — nothing to refresh from'); return; }
  var exist = EI.qt ? DB.qt.find(function(x){ return x.id === EI.qt; }) : null;
  if ((G('qf-st').value === 'Accepted' || (exist && exist.linkedPOIds && exist.linkedPOIds.length)) &&
      !confirm('This quote is already Accepted / has Purchase Orders — changing its prices will not update them. Continue?')) return;
  if (l.costManual && !confirm('You overrode this line\'s cost — Refresh will replace it. Continue?')) return;
  var g = qteRateGroup(li.cur), st = qteStoredRate(g), r;
  if (st !== null) r = { rate: st, src: 'stored' };
  else { var v = await qteAskRate(g, +l.lidRate || qteRateSuggestion(g)); if (!(v > 0)) return; r = { rate: v, src: 'manual' }; }   // previous rate pre-filled
  syncQLFromDOM();
  var keepCbm = l.cbmManual ? l.cbm : null;
  qteApplyLink(l, li, +qlFld(rid, 'qty') || l.qty, r.rate, r.src);                  // resets costManual; recomputes cost and CBM
  if (keepCbm !== null) { l.cbm = keepCbm; l.cbmManual = true; }                  // a manual CBM wins (REQ-QTE4-005)
  rQLT(); calcQte();
}
```
Refresh only edits the in-memory grid — nothing persists until **Save Quote**, which versions the line exactly like a manual cost edit (the `saveQte()` trigger `lastV.cost !== l.cost`, `index.html:15310`).

---

## 6. `saveQte()` (REQ-QTE4-006, REQ-QTE4-009)

### 6.1 Carry-forward
In the line-literal builder (`index.html:15267-15285`), after the existing `sourceOrd*` block add:
```js
QTE_LINK_KEYS.forEach(function(k){ if (l[k] !== undefined) out[k] = l[k]; });   // conditional: absent on unlinked lines, never `undefined`
```
- `l` is the `cQL` entry, so the keys (including the flags) are read from `cQL`, not from `qlFld()`. A non-blank `lid` with no snapshot (restored/hand-edited data) is **preserved as data** (not stripped) and treated as unlinked by `qteIsLinked()`; a blank `lid` (`''`, as the AI `create_quote` path writes, `index.html:12979`-area) is carried only if present and means unlinked — the assertion in AC-6 is `'lid' in line === false` for a line that never had one.
- The literal already writes `markup: undefined`/`insRate: undefined` (REQ-gate advisory); that is unchanged and the "absent key" rule applies to the new keys only.
- `editQte()` (`15019`) already copies unknown keys into `cQL` (`Object.assign`, `15024`); no change.

### 6.2 Promotion queue (the Accepted-transition block, `index.html:~15395-15430`)
Inside `lines.forEach(function(l){ ... })`, before the existing `if (!l.supId) return;`, add the linked branch; the existing code is the fallback and is **otherwise unchanged**:
```js
var linkedLi = qteIsLinked(l) ? DB.li.find(function(x){ return x.id === l.lid; }) : null;
if (linkedLi) {
  if (!l.supId) return;                                   // blank supplier: skipped, as for unlinked lines
  if (l.supId !== linkedLi.supId) return;                 // supplier diverged (operator changed it, or the item's was blank/orphaned): no update
  if (!l.costManual) return;                              // only a DELIBERATE cost override queues an update; catalogue drift is the badge's job
  var qn = (+l.qty > 0) ? +l.qty : 1;
  var unitUSD = (+l.cost || 0) / qn;
  if (Math.abs(unitUSD - (+l.lidUnitUSD)) <= 0.001) return;               // no deliberate change from what was linked
  var nativeCost = unitUSD / (+l.lidRate);
  if (liHistMilli(nativeCost) === liHistMilli(linkedLi.cost)) return;     // already equals the live catalogue cost
  var dupU = DB.liPending.some(function(p){ return p.status === 'pending' && p.kind === 'update' && p.matchedLiId === linkedLi.id; });
  if (dupU) return;
  DB.liPending.push({ id: uid(), status: 'pending', kind: 'update', matchedLiId: linkedLi.id, quoteId: qt.id, quoteNum: qt.num,
    supId: l.supId, desc: l.desc, uom: l.uom, cost: nativeCost,
    suggestedPrice: (sellPByRid[l.rid] / qn) / (+l.lidRate),       // indicative DELIVERED per-unit price, in the catalogue's currency — a suggestion only
    currency: linkedLi.cur, createdAt: new Date().toISOString() });
  return;                                                  // a linked line NEVER also queues a 'new' candidate
}
```
- **Currency basis:** `cost` and `suggestedPrice` are per unit and in the catalogue's own currency; `currency` is `linkedLi.cur` **verbatim** (a blank stays blank; `approveLIPending()` already falls back with `c.currency || 'USD'`, `index.html:8602`-area), never the quote's label currency and never a USD number under a native label.
- **A price-only difference never queues an update** for a linked line (REQ-QTE4-009): the quote's sell price is a line-total landed-plus-markup figure and is not a like-for-like catalogue price.
- A **linked line with a deleted item** (`linkedLi` undefined) and any **unlinked line** fall through to the existing desc+supId matching with its existing comparison, unchanged.
- The existing `isAccepted && !wasAccepted` guard and the `sv(K.lip, …)`/`rLIPending()` tail are untouched.

---

## 7. `qteToPoConvert()` (REQ-QTE4-013a)

In the PO line builder (`index.html:~15796`), replace the literal
`return { rid:uid(), lid:'', desc:l.desc, sku:'', uom:l.uom||'pcs', qty:l.qty||1, cost:l.cost };` with:
```js
var lk = qteIsLinked(l);
var liP = lk ? DB.li.find(function(x){ return x.id === l.lid; }) : null;       // live item at conversion time (blank if since deleted)
var qn = (+l.qty > 0) ? +l.qty : 1;
return { rid: uid(), lid: liP ? liP.id : '', desc: l.desc, sku: liP ? (liP.sku || '') : '', uom: l.uom || 'pcs',
         qty: l.qty || 1, cost: lk ? qteR4((+l.cost || 0) / qn) : l.cost };
```
- For a **linked** line the PO `cost` is `cost ÷ qty` rounded to 4 dp (a linked line's cost is a line total by construction; PO lines are per-unit). `qty × cost` can differ from the quote line cost by ±0.0001×qty for non-terminating divisions (100 ÷ 3 → 33.3333 → 99.9999) — accepted (REQ-QTE4-003).
- **Unlinked lines are unchanged** (the pre-existing line-total-vs-per-unit mismatch is `QTE-GAP-002`). The Cloud Data PO insert reads `newPOs[i].lineItems` (`index.html:~15813`) so it inherits the change with no edit.
- `renderPoSourceDriftWarn()` returns early for blank `po.invId` (`9452`-area), so a quote-created PO gains no drift checking from this; the only effect is a real catalogue link for `delLI()`'s PO scan.

---

## 8. Delete protection, integrity check, stale comments (REQ-QTE4-008)

### 8.1 `delLI()` (`index.html:8512`)
Add beside `invRefs`/`poRefs`:
```js
var qtRefs = DB.qt.filter(function(q){ return (q.lines||[]).some(function(l){ return l.lid === id; }); });   // any non-blank match, conservative: never crashes on a snapshot-less lid
...
if (qtRefs.length) warns.push(qtRefs.length + ' quote' + (qtRefs.length>1?'s':'') + ' (' + qtRefs.map(function(q){return q.num||q.id;}).join(', ') + ')');
```
`warns` is built **before** the local/Cloud branch split, so both branches carry the count with no further edit; a Cloud-Data soft-delete (`deleted_at`, `8527`) is treated identically. The existing confirm tail ("catalogue link will be broken") already reads correctly. Delete proceeds as today and **leaves `lid` on those quote lines** as a historical reference.

### 8.2 `verifyFkIntegrityAfterCleanup()` (`index.html:12408`)
Delete the line `if (l.lid && !liIds[l.lid]) dangling.push('Quote ' + q.id + ' line lid');` (`~12430`) and replace its explanatory comment with: "Quote.lines[].lid is a historical reference since REQ-QTE-004 (v2.9.105): a catalogue item may legitimately be deleted after a quote was built from it, so a dangling quote-line lid is NOT a data-integrity defect. Accepted trade-off: this also removes the check's ability to catch a genuinely failed lid remap after Line Item migration — the migration tests cover the remap directly (§9). The PO-line lid check beside it is unchanged and will report dangling lids on POs created from quotes whose item is later deleted (the same accepted historical-reference behavior)."

### 8.3 Stale artefacts updated in the same change
- Comments: `index.html:7101-7103` ("Quote.lines[].lid is confirmed dead…") and `12426-12429` (the integrity-check comment above); the sweep itself (`7104`) is unchanged.
- Tests: `tests/run.js:8971` (comment "Quote.lines[].lid is dead") and `9001` (assertion message "dead Quote.lines[].lid left as-is") — comments/messages reworded, assertions unchanged (they still pass: a line with no `lid` key stays without one). Test names at `8966`/`8971` that say "dead" are renamed to "lid-less quote line".
- Docs: `docs/known-gaps.md`/`STACKD_CONTEXT.md` statements that Quote `lid` is unused (grep `dead`/`never populated`); the historical SPEC/REQ files that say so are left as the record they are.

---

## 9. Cloud Data / Sheets / backup (REQ-QTE4-014)
No code change. Confirmed by citation: `refreshQteFromSupabase()` maps `lines: row.lines || []` unmodified (`index.html:~6535`); `saveQte()`'s Cloud branch writes `lines: qt.lines || []` (`~15350`); `FIELD_MAPS.qt` (`5146`) maps no line data; `mergePulledWithLocal()` is `Object.assign({}, local, pulled)` (`5203`), so unmapped `lines` survive a Sheets pull; the AI assistant has no Quote read tool, so the snapshot cannot reach it. Local backup/restore carries `DB.qt` as-is. The LI-migration sweep (`7104`) rewrites only `ql.lid` and so leaves every snapshot/flag key untouched (T-14a).

---

## 10. Documentation, assistant, versioning
1. **`AI_SYSTEM_PROMPT`** `## Quotes` section (`index.html:12800`): add — `'Quote lines from the catalogue: on the Quotes tab, click Add from Catalogue (or Link on an existing line) to pull in a Line Item. Supplier, description, UOM, DG, cost and CBM fill in automatically. Cost is converted to USD and treated as a line total, so it scales with quantity until you type a cost yourself; CBM scales the same way from the item dimensions. USD, GBP and BBD items convert at the stored rates; any other currency asks you for a USD rate, which is recorded on the line. A cost snapshot is kept, and an amber badge shows when the catalogue cost has changed since the quote was built; Refresh cost re-applies it. Duty % stays manual. Unlink returns a line to a plain typed line.'` — **no apostrophes** inside the single-quoted string (known harness trap: reword, never escape).
2. **`docs/user-guide.md`** Quotes section: Add from Catalogue, Link/Unlink, the three stored-rate currencies and the manual-rate prompt, cost-is-a-line-total, the CBM rule, the drift badge and Refresh, the relabelled "Cost (USD, line total)" column, and that the history modal / old quotes are unchanged.
3. **In-app changelog** v2.9.105 block; the **three hardcoded version strings** (`<title>` `index.html:9`, the nav badge, the `AI_SYSTEM_PROMPT` self-description line) → v2.9.105 (`grep -n "v2\.9\.104"`; only the changelog entry and comments may remain — a build-time manual step recorded in the PR).
4. `docs/version-history.md`, `CLAUDE.md` (version, test count, a short entry for the design rules in §11), `docs/known-gaps.md` (QTE-GAP-002..005 already logged — update status text where this REQ addresses linked lines), `STACKD_CONTEXT.md` backlog, `docs/requirements-tracker.md`, Notion rows (aggregate wording only).

---

## 11. Test plan (`tests/run.js`)

**Harness hazards respected.**
- `mockElements` is module-level and never cleared: every group begins `resetDB(); ctx.cQL = []; ctx._qpickChecked = {}; ctx.closeM('ov-qpick'); ctx.closeM('ov-qrate');` and resets `qf-st`, `qf-insRate`, `qf-cur`, `qf-mkp` to defaults (the `saveQteSetup()` helper already resets `qf-insRate`).
- **`syncQLFromDOM()` reads mock inputs, which the mock never populates from `cQL`.** A `qtMirror()` test helper copies every `cQL` line's fields into `mockEl('ql-<field>-<rid>').value`/`.checked` (simulating a real render) **before** any call that syncs; tests that exercise typing set the mock value directly and then call the handler.
- `qteAskRate` is replaced per test (`ctx.qteAskRate = (g, s) => Promise.resolve(1.08)`); `confirm` is stubbed. Async functions that never await (stored-rate paths) complete synchronously; tests use `testAsync` and `await` anyway.
- Any test that calls a `migrate*ToSupabase()`/`refresh*FromSupabase()` function removes the marker it self-sets (`localStorage.removeItem(...)`) in a `finally`.
- Fixtures: `FXI` = items `u1` (USD 10, dims 50×40×30, `s1`), `g1` (GBP 10), `b1` (BBD 20), `e1` (EUR 8), `n1` (blank cur), `z1` (USD 0), `nd1` (USD 10, no dims); `QR.fxGBPUSD = 1.27`, `QR.fxGBPBBD = 2.54`, `QR.fxGBPRMB = 9.20`.

| Test | AC | Exact assertion |
|---|---|---|
| T-1 | 1 | `qteAddFromCatalogue(['u1'])` → one `cQL` line: `supId` `s1`, `desc`, `uom`, `dg`, `qty` 1, `cost` 10, `cbm` 0.06, `lid` `u1`, `lidCost` 10, `lidCur` `USD`, `lidRate` 1, `lidRateSrc` `stored`, `lidUnitUSD` 10, `lidAt` set |
| T-2a/b/c/d | 2 | GBP: `lidRate` 1.27, `lidUnitUSD` 12.7, `cost` 12.7; BBD: `lidRate` 0.5, `lidUnitUSD` 10; `cur:'gbp '` behaves as GBP; `QR.fxGBPUSD = 0` falls back to `QR_DEFAULTS.fxGBPUSD` (never 0) |
| T-3a/b/c/d | 3 | EUR/blank → `qteAskRate` called once per group; value 1.08 → `lidRate` 1.08, `lidRateSrc` `manual`; `null`/0/-1/'abc' (stub) → nothing appended; batch of 2 EUR + 1 NGN asks twice, cancelling NGN adds both EUR items and skips NGN with a toast; RMB+CNY items ask once and the RMB suggestion is `1.27/9.20` |
| T-4a/b/c/d | 4 | USD item unit 10: qty 1 → cost 10; qty→5 (cost untouched) → cost 50; type 42 in cost (`qlCostTyped`) then qty→6 → cost stays 42; `costManual` persisted through `saveQte()` + `editQte()` and still honoured; blank/zero qty leaves cost/CBM unchanged |
| T-5a/b/c/d | 5 | dims 50×40×30: qty 10 → cbm 0.6; qty 20 → 1.2; type 0.9 (`qlCbmTyped`) then qty 30 → 0.9; `cbmManual` persisted; value rounded to 6 dp (a 7-digit dimension product); no dims → `cbm` 0 and no `lidUnitCBM` key; deleting/changing the item's dims after linking does not change the line's recompute |
| T-6a/b/c | 6 | `saveQte()` + reopen: every link key survives (`lid`, `lidCost`, `lidCur`, `lidRate`, `lidRateSrc`, `lidUnitUSD`, `lidAt`, `lidUnitCBM` when set, `costManual`/`cbmManual` when true); an unlinked line has none (`'lid' in line === false`, same for each key); a line with `lid:''` is treated as unlinked by `qteIsLinked`, rescale, badge, Link/Unlink toggle |
| T-7a–f | 7 | drift: catalogue cost 10→11 → badge "was USD 10.000, now USD 11.000"; `QR.fxGBPUSD` changed only (GBP item) → **no** badge; native difference < 0.001 → no badge; currency GBP→EUR → currency-changed badge; deleted item → "Catalogue item removed"; without Refresh the line cost never changes |
| T-7g/h/i | 7 | Refresh with `costManual` true → `confirm` asked (decline = no change); Refresh on an Accepted quote → second `confirm`; Refresh edits `cQL` only (DB unchanged until `saveQte()`), then saving versions the line (`priceHistory` gains an entry) |
| T-8a/b/c | 8 | `delLI()` confirm text contains the quote count and numbers (local and Cloud-migrated branch, via a captured `confirm`); after delete the quote line keeps `lid` and still saves; `verifyFkIntegrityAfterCleanup()` does not report the dangling quote-line `lid` |
| T-9a–h | 9 | promotion (Accepted transition): (a) description edited on a linked line → no `'new'` candidate, an unlinked line with the same edit still queues one; (b) linked GBP item, cost untouched → no update; (c) catalogue cost later changed, line untouched → no update; (d) `costManual` + unit USD differing from `lidUnitUSD` by >0.001 → exactly one `'update'` with native per-unit `cost`, `currency` `GBP`, `suggestedPrice = (sellP/qty)/lidRate`; (e) price-only difference → none; (f) supplier changed away from `li.supId` → none; (g) dangling `lid` → falls back to the desc+supId path with its legacy comparison; (h) `approveLIPending()` on the (d) candidate pre-fills `lf-cur` `GBP` and the native cost (never a USD figure under a GBP label) |
| T-10a–e | 10 | re-render: type into line A (desc, supplier, qty, cost, dg, markup, insRate, note) then `addQteLine()` / `removeQteLine(B)` / link an item / `qteUnlink` / `qteRefreshLine` → `G('qt-lines').innerHTML` **and** `cQL[A]` both contain A's typed values (asserted on the rendered string and `cQL`, not on the mock `.value`); the note input renders `value="…"`; `addQteLine()` calls `calcQte()`; **red-first:** reverting the `syncQLFromDOM()` call in `addQteLine()` fails exactly this test |
| T-11a–d | 11 | PO conversion: linked line cost 50, qty 5 → PO line `lid`, live `sku`, `cost` 10, `qty` 5; `100 ÷ 3` → `33.3333`; unlinked line → `lid:''`, `sku:''`, `cost` as typed; deleted item → blank `lid`/`sku` but cost still per-unit |
| T-12 | 12 | `prevQteDoc()` for a drifted linked line contains none of `lid`, `Catalogue`, `snapshot`, `lidRate`, the rate figure or "Refresh" (it already prints supplier and line cost) |
| T-13a/b/c | 13 | all existing invoice-picker tests pass unmodified (run as part of the suite); `html.indexOf('id="ov-qpick"') > html.indexOf('id="ov-qt"')` and the same for `id="ov-qrate"`; both overlays precede `<!-- AI CHAT FLOATING BUTTON -->` |
| T-14a/b/c | 14 | LI-migration sweep remaps `lid` and leaves a full snapshot byte-identical (extends the existing test at `tests/run.js:~10244`); a post-migration link with a UUID `lid` round-trips insert → real `refreshQteFromSupabase()` with a mocked `_sb` (marker cleaned in `finally`); unlinked lines gain no keys through the refresh |
| T-15a–e | 15 | blank/unresolvable `li.supId` → line `supId` `''` + visible warning, no unknown id written; same item added twice allowed and the picker marks it; `qteLinkExisting` on a non-default line asks `confirm` (decline = no change), keeps typed qty, resets both flags, keeps duty/markup/insRate/note; `qteUnlink` removes every link key **and** both flags and leaves values; header reads "Cost (USD, line total)" |
| T-16 | 16 | full suite green; the touched/renamed tests of §8.3 listed in the PR |
| T-17a/b | prompt | `AI_SYSTEM_PROMPT` contains the §10.1 passage; contains no new unescaped apostrophe (the whole suite still parses) |

**Mutation tests** (revert in a scratch copy of `index.html`; the exact predicted test must fail; restore):
1. `QTE_LINK_KEYS` carry-forward removed from `saveQte()` → T-6a/b/c fail.
2. `qteAskRate` result not checked (add the line with the raw typed value / skip the `> 0` test) → T-3 fails.
3. `qteApplyLink()` cost not multiplied by qty / qty rescale removed → T-4 fails.
4. `costManual` guard removed from `qlQtyChanged()` → T-4c fails; `cbmManual` guard removed → T-5c fails.
5. Drift compares USD (`lidUnitUSD` vs `li.cost × current rate`) instead of native → T-7b fails.
6. Promotion branch compares price / ignores `costManual` → T-9b/c/e fail.
7. `syncQLFromDOM()` removed from `addQteLine()` → T-10a fails.
8. PO per-unit division removed → T-11a/b fail.
9. `qtRefs` removed from `delLI()` → T-8a fails.
10. `qteIsLinked()` ignores the snapshot (lid-only counts as linked) → T-6c fails (NaN rescale case).

**Existing tests:** `tests/run.js:8966/8971/9001` renamed/reworded (§8.3, assertions unchanged); no other existing test touches quote-line link keys. Expected delta: roughly +55 tests (1231 → ~1286); exact count recorded at build.

---

## 12. Open points for the spec-gate to rule on
1. **`qteIsLinked()` requires a finite `lidUnitUSD` and `lidRate > 0`** — `''`/`null` are rejected explicitly (a bare `isFinite('')` is true). Confirm this matches the REQ's "finite numbers, `lidRate` > 0".
2. **No shared renderer with the invoice picker** (§4.1): chosen to keep AC-13 trivially true. A reviewer may prefer extraction.
3. **`delLI()` counts any non-blank `lid` match, including a snapshot-less one** (REQ left this to the SPEC).
4. **Promotion `currency`** is `linkedLi.cur` verbatim, including blank (REQ-QTE4-009); the approve form's own fallback handles it.
5. **Refresh keeps a manual CBM** (REQ-QTE4-005 "manual wins") while resetting `costManual` (REQ-QTE4-007).
6. **`syncQLFromDOM()` early-returns when there is no rendered grid** — a defensive addition for the mock harness and for a call before the first render.
