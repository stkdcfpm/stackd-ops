# SPEC-QTE-001-v1: Per-Line Quote Margin (Part A only)

**Implements:** REQ-QTE-001-v3, Part A only (REQ-QTE-001a–f, AC-001–004/010/014). Requirements-gate history: v1 CONDITIONAL PASS → v2 CONDITIONAL PASS (independent round) → v3, not re-gated a third time — proceeding to spec-gate on v3 by explicit product decision, not a self-certified PASS.

**Part B (RFQ supplier comparison & commit) is deliberately out of scope for this spec** — REQ-QTE-001 itself recommends gating/building Part A first, and Part B is substantially larger (new sub-entity, new UI surface, `delSup()`/`delCon()` guard extensions, an `ordConvertToQuote()` extension). A separate `SPEC-QTE-001-partB-v1.md` should follow once Part A ships, per the REQ's own staged-build recommendation — not attempted here.

## 0. Design note: one shared calc path, not three duplicated ones

Three existing call sites each independently compute quote sell totals from the same inputs: `cQte(qt)` (`index.html:8950-8963`, used by `rQte()`'s list view and `prevQteDoc()`'s PDF/preview), `calcQte()` (`index.html:9150-9173`, the live in-modal preview), and `saveQte()` (`index.html:9231` onward, the actual persist path). Today all three apply one flat `markup` uniformly and would independently need the same per-line-effective-margin change — a real risk of drift if patched separately (exactly the kind of triplication that let today's uniform-overhead-markup behavior go unnoticed as an implicit assumption). This spec introduces two small shared helpers and routes all three existing call sites through them, rather than duplicating the new logic a third time.

## 1. `qteEffectiveMargin(line, quoteMarkup)` — new, pure function

Placed immediately after `cQteLine()` (`index.html:8948`, the blank line after its closing brace):

```js
function qteEffectiveMargin(line, quoteMarkup) {
  var lm = line.markup;
  return (lm !== undefined && lm !== null && lm !== '') ? +lm : +quoteMarkup;
}
```

Directly implements REQ-QTE-001a's sentinel rule: only `undefined`/`null`/`''` count as "unset" (inherit); an explicit `0` returns `0`, not the quote-level default.

## 2. `qteSellTotals(lines, lineCalcs, quoteMarkup, qr)` — new, pure function

Placed immediately after `qteEffectiveMargin()`:

```js
function qteSellTotals(lines, lineCalcs, quoteMarkup, qr) {
  var sellUSD = lines.reduce(function(sum, l, i) {
    var m = qteEffectiveMargin(l, quoteMarkup);
    return sum + lineCalcs[i].landed * (1 + m / 100);
  }, 0);
  var overhead = qr.originCharges + qr.destCharges + qr.fpmAdmin;
  sellUSD += overhead; // REQ-QTE-001c: overhead is never marked up, added at cost
  var sellGBP = sellUSD / qr.fxGBPUSD;
  return { sellUSD: sellUSD, sellGBP: sellGBP, overhead: overhead };
}
```

Implements REQ-QTE-001c/d exactly: `overhead` added once, unmarked-up, after per-line sell prices (each at that line's own effective margin) are summed. This is the single source of truth for "Grand Total" — `cQte()`, `calcQte()`, and `saveQte()` all call this instead of each computing it inline.

## 3. `cQte(qt)` — modified (`index.html:8950-8963`)

Full replacement:

```js
function cQte(qt) {
  var qr = QR;
  var mode = qt.freightMode || 'LCL';
  var lines = qt.lines || [];
  var totalCBM = lines.reduce(function(s,l){ return s + (+l.cbm||0); }, 0);
  var lineCalcs = lines.map(function(l){ return cQteLine(l, qr, mode, totalCBM); });
  var totalLanded = lineCalcs.reduce(function(s,c){ return s + c.landed; }, 0);
  var markup = +qt.markup || 0;
  var totals = qteSellTotals(lines, lineCalcs, markup, qr);
  var quotedTotal = totalLanded + totals.overhead;
  return { totalLanded: totalLanded, overhead: totals.overhead, quotedTotal: quotedTotal, sellUSD: totals.sellUSD, sellGBP: totals.sellGBP, lineCalcs: lineCalcs };
}
```

Return shape unchanged (verified no other code reads `.quotedTotal`/`.totalLanded` outside this function — grep confirms zero external references — so this is safe to keep as-is for any future caller, at no cost). `rQte()` (`index.html:8971`) and `prevQteDoc()` (`index.html:9602`) both call `cQte(q)` and read `.sellUSD`/`.sellGBP`/`.lineCalcs` — all three continue to work unchanged, now reflecting per-line effective margins automatically. **No changes needed to `rQte()` or `prevQteDoc()` themselves.**

## 4. `calcQte()` — modified (`index.html:9150-9173`)

Full replacement:

```js
function calcQte() {
  if (!cQL.length) {
    ['qt-orig','qt-dest','qt-adm','qt-landed','qt-mkp-disp','qt-sell-usd','qt-sell-gbp'].forEach(function(f){ var el=G(f); if(el) el.textContent='-'; });
    return;
  }
  var mode = G('qf-mode') ? G('qf-mode').value : 'LCL';
  var markup = G('qf-mkp') ? +G('qf-mkp').value : 15;
  var totalCBM = cQL.reduce(function(s,l){ return s+(+qlFld(l.rid,'cbm')||0); }, 0);
  var lines = cQL.map(function(l){
    return { cost:+qlFld(l.rid,'cost')||0, cbm:+qlFld(l.rid,'cbm')||0, dg:qlFld(l.rid,'dg'), dutyPct:+qlFld(l.rid,'dutyPct')||0, markup: qlEffectiveMarkupInput(l.rid) };
  });
  var lineCalcs = lines.map(function(l){ return cQteLine(l, QR, mode, totalCBM); });
  var totalLanded = lineCalcs.reduce(function(s,c){ return s + c.landed; }, 0);
  var totals = qteSellTotals(lines, lineCalcs, markup, QR);
  if (G('qt-orig'))     G('qt-orig').textContent     = '$' + fn(QR.originCharges,0);
  if (G('qt-dest'))     G('qt-dest').textContent     = '$' + fn(QR.destCharges,0);
  if (G('qt-adm'))      G('qt-adm').textContent      = '$' + fn(QR.fpmAdmin,0);
  if (G('qt-landed'))   G('qt-landed').textContent   = '$' + fn(totalLanded,0);
  if (G('qt-mkp-disp')) G('qt-mkp-disp').textContent = markup + '%';
  if (G('qt-sell-usd')) G('qt-sell-usd').textContent = fmt(totals.sellUSD,'USD');
  if (G('qt-sell-gbp')) G('qt-sell-gbp').textContent = '£' + fn(totals.sellGBP,0);
  calcFeasibility();
}
```

Changes from current: `totalLanded`'s per-line calc now builds a `lines` array once (each with `markup` read via the new `qlEffectiveMarkupInput()`, §6) and reuses it for both `lineCalcs` and `qteSellTotals()`, instead of the old single-pass `reduce` that only produced a landed-cost sum. `qt-orig`/`qt-dest`/`qt-adm`/`qt-landed` display lines are unchanged. `qt-sell-usd`/`qt-sell-gbp` now come from `qteSellTotals()`. `calcFeasibility()` call unchanged — it doesn't touch margin.

## 5. `rQLT()` — modified (`index.html:9069-9101`)

Two changes to the row template: a new Margin input cell (blank when `l.markup` is unset — must not default to `0`, per REQ-QTE-001a) inserted after the Duty % cell, and the Landed cell's label clarified since it's no longer the same as "Sell":

```js
function rQLT() {
  var el = G('qt-lines');
  if (!el) return;
  if (!cQL.length) {
    el.innerHTML = '<p style="font-size:.54rem;color:var(--m);padding:8px 0;">No lines yet — click + Add Line below.</p>';
    return;
  }
  var mode = G('qf-mode') ? G('qf-mode').value : 'LCL';
  var quoteMarkup = G('qf-mkp') ? +G('qf-mkp').value : 15;
  var totalCBM = cQL.reduce(function(s,l){ return s+(+l.cbm||0); }, 0);
  el.innerHTML = '<table class="tbl" style="font-size:.52rem;width:100%;min-width:980px;">'
    + '<thead><tr><th>Supplier</th><th>Description</th><th>Qty</th><th>UOM</th><th>Cost (USD)</th><th>CBM</th><th>DG</th><th>Duty %</th><th>Margin %</th><th>Landed</th><th>Sell</th><th>Note</th><th></th></tr></thead>'
    + '<tbody>'
    + cQL.map(function(l){
        var calcR = cQteLine(l, QR, mode, totalCBM);
        var effM = qteEffectiveMargin(l, quoteMarkup);
        var sellP = calcR.landed * (1 + effM / 100);
        var hCount = l.priceHistory ? l.priceHistory.length : 0;
        var mkpVal = (l.markup !== undefined && l.markup !== null) ? l.markup : '';
        return '<tr>'
          + '<td><select id="ql-supId-' + l.rid + '" style="font-size:.5rem;width:110px;" onchange="calcQte()">'
            + '<option value="">— Supplier —</option>'
            + DB.sup.map(function(s){ return '<option value="' + san(s.id) + '"' + (l.supId===s.id?' selected':'') + '>' + san(s.name) + '</option>'; }).join('')
            + '</select></td>'
          + '<td><input type="text" id="ql-desc-' + l.rid + '" value="' + san(l.desc||'') + '" placeholder="Description" style="font-size:.5rem;width:120px;"></td>'
          + '<td><input type="number" id="ql-qty-' + l.rid + '" value="' + (+l.qty||1) + '" min="0.001" step="any" style="font-size:.5rem;width:50px;" oninput="calcQte()"></td>'
          + '<td><input type="text" id="ql-uom-' + l.rid + '" value="' + san(l.uom||'pcs') + '" list="dl-uom" style="font-size:.5rem;width:46px;"></td>'
          + '<td><input type="number" id="ql-cost-' + l.rid + '" value="' + (+l.cost||0) + '" min="0" step="any" style="font-size:.5rem;width:72px;" oninput="calcQte()"></td>'
          + '<td><input type="number" id="ql-cbm-' + l.rid + '" value="' + (+l.cbm||0) + '" min="0" step="0.001" style="font-size:.5rem;width:50px;" oninput="calcQte()"></td>'
          + '<td style="text-align:center;"><input type="checkbox" id="ql-dg-' + l.rid + '"' + (l.dg?' checked':'') + ' onchange="calcQte()"></td>'
          + '<td><input type="number" id="ql-dutyPct-' + l.rid + '" value="' + (+l.dutyPct||0) + '" min="0" max="100" step="0.5" style="font-size:.5rem;width:46px;" oninput="calcQte()"></td>'
          + '<td><input type="number" id="ql-mkp-' + l.rid + '" value="' + mkpVal + '" placeholder="' + quoteMarkup + '" min="0" max="500" step="0.5" style="font-size:.5rem;width:50px;" oninput="calcQte()" title="Blank = inherit quote-level ' + quoteMarkup + '%"></td>'
          + '<td style="font-weight:600;">$' + fn(calcR.landed,0) + '</td>'
          + '<td style="font-weight:600;color:var(--cr);">$' + fn(sellP,0) + '</td>'
          + '<td><input type="text" id="ql-note-' + l.rid + '" placeholder="Version note…" style="font-size:.46rem;width:88px;border:none;border-bottom:1px solid var(--ln);outline:none;"></td>'
          + '<td style="white-space:nowrap;">'
            + '<button onclick="toggleQteLineHistory(\'' + l.rid + '\')" style="font-size:.44rem;background:transparent;border:1px solid var(--ln);color:var(--m);padding:1px 5px;cursor:pointer;margin-right:2px;" title="Price history">&#128336;' + (hCount ? '&nbsp;' + hCount : '') + '</button>'
            + '<button onclick="removeQteLine(\'' + l.rid + '\')" style="font-size:.44rem;background:transparent;border:1px solid var(--cr);color:var(--cr);padding:1px 6px;cursor:pointer;">×</button>'
          + '</td>'
          + '</tr>'
          + '<tr id="ql-hist-row-' + l.rid + '" style="display:none;">'
          + '<td colspan="13" style="padding:4px 8px 8px;background:#fafafa;">'
            + '<div id="ql-hist-' + l.rid + '"></div>'
          + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table>';
}
```

Changes: `quoteMarkup` read once at the top (needed for both the new Margin column's placeholder and the new Sell column). New `<th>Margin %</th>` and `<th>Sell</th>` headers. New Margin input cell — `value` is `''` when `l.markup` is unset (never `0` as a false default), `placeholder` shows the quote-level default so the operator sees what it'll inherit. New Sell cell showing `landed × (1 + effective margin)`, using the exact same `qteEffectiveMargin()` helper the persist path uses, so the live table and the eventual saved value can never disagree. `colspan` on the history row bumped from `11` to `13` (two new columns). Table `min-width` bumped from `900px` to `980px` to fit.

## 6. `qlEffectiveMarkupInput(rid)` — new function

Placed immediately after `qlFld()` (`index.html:9056`):

```js
function qlEffectiveMarkupInput(rid) {
  var raw = qlFld(rid, 'mkp');
  return (raw === '' || raw === undefined) ? undefined : +raw;
}
```

**This is the fix for the v2/v3-flagged pattern-conflict finding.** `qlFld()` returns the raw DOM input's string `value` (or `''` if the element is missing). Unlike `dutyPct`'s own read (`+qlFld(l.rid,'dutyPct')||0`, `index.html:9244` — which collapses a genuinely blank field and an explicit `"0"` to the same value via `||`), this function checks the raw string for emptiness *before* converting to a number, so `''` → `undefined` (inherit) and `'0'` → `0` (explicit override) are kept distinct, satisfying REQ-QTE-001a/AC-004/AC-014.

## 7. `saveQte()` — modified (`index.html:9231-9297`, the section from the `lines` map through the totals block)

```js
function saveQte() {
  if (!vQte()) return;
  var mode = G('qf-mode').value;
  var lines = cQL.map(function(l){
    return {
      rid: l.rid,
      supId: qlFld(l.rid,'supId'),
      desc: qlFld(l.rid,'desc'),
      qty: +qlFld(l.rid,'qty')||1,
      uom: qlFld(l.rid,'uom')||'pcs',
      cost: +qlFld(l.rid,'cost')||0,
      cbm: +qlFld(l.rid,'cbm')||0,
      dg: qlFld(l.rid,'dg'),
      dutyPct: +qlFld(l.rid,'dutyPct')||0,
      markup: qlEffectiveMarkupInput(l.rid)
    };
  });
  var totalCBM = lines.reduce(function(s,l){ return s+(l.cbm||0); }, 0);
  var lineCalcs = lines.map(function(l){ return cQteLine(l, QR, mode, totalCBM); });
  var totalLanded = lineCalcs.reduce(function(s,c){ return s+c.landed; }, 0);
  var markup = +G('qf-mkp').value||0;
  var existQ = EI.qt ? DB.qt.find(function(x){ return x.id===EI.qt; }) : null;
  lines.forEach(function(l, i) {
    var existLine = existQ ? (existQ.lines||[]).find(function(x){ return x.rid===l.rid; }) : null;
    var history = existLine && existLine.priceHistory ? existLine.priceHistory.slice() : [];
    var lastV = history.length ? history[history.length-1] : null;
    var calcR = lineCalcs[i];
    var effM = qteEffectiveMargin(l, markup);
    var sellP = +(calcR.landed * (1 + effM/100)).toFixed(2);
    var changed = !lastV || lastV.cost !== l.cost || lastV.dutyPct !== l.dutyPct || lastV.markup !== effM;
    if (changed) {
      history.push({ v: lastV ? lastV.v+1 : 1, ts: new Date().toISOString(), cost: l.cost, dutyPct: l.dutyPct, markup: effM, landed: +fn(calcR.landed,2), sellPrice: sellP, note: qlFld(l.rid,'note') });
    }
    l.priceHistory = history;
  });
  var totals = qteSellTotals(lines, lineCalcs, markup, QR);
  var sellUSD = totals.sellUSD;
  var sellGBP = totals.sellGBP;
  var wasAccepted = existQ && existQ.status === 'Accepted';
  var isAccepted  = G('qf-st').value === 'Accepted';
  var qt = {
    id: EI.qt || uid(),
    num: G('qf-num').value.trim() || nextQteNum(),
    client: G('qf-client').value.trim(),
    dt: G('qf-dt').value,
    validUntil: G('qf-valid').value,
    currency: G('qf-cur').value,
    freightMode: mode,
    markup: markup,
    status: G('qf-st').value,
    notes: G('qf-nt').value.trim(),
    lines: lines,
    linkedPOIds: existQ ? (existQ.linkedPOIds||[]) : [],
    sourceContactId:  cConvertId || (existQ ? (existQ.sourceContactId||'') : ''),
    calc_totalLanded: +fn(totalLanded,2),
    calc_sellUSD: +fn(sellUSD,2),
    calc_sellGBP: +fn(sellGBP,2),
    approvedBy: isAccepted ? G('qf-approved-by').value.trim() : (existQ ? existQ.approvedBy||'' : ''),
    approvedReason: isAccepted ? G('qf-approved-note').value.trim() : (existQ ? existQ.approvedReason||'' : ''),
    approvedAt: isAccepted
      ? (wasAccepted ? (existQ.approvedAt||new Date().toISOString()) : new Date().toISOString())
      : (existQ ? existQ.approvedAt||'' : '')
  };
  // ...unchanged from here (persist block, cConvertId handling)
}
```

Exactly three changes from current `saveQte()`: (1) `lines` map gains `markup: qlEffectiveMarkupInput(l.rid)`; (2) the per-line history block computes `effM` via `qteEffectiveMargin(l, markup)` and uses it everywhere the old code used the raw `markup` (both in `changed` comparison and the pushed history entry's `markup`/`sellPrice`); (3) the final totals block calls `qteSellTotals()` instead of the old inline `overhead`/`sellUSD`/`sellGBP` computation. Nothing after the `qt = {...}` object literal changes — persistence, `cConvertId` linking, etc. all continue as today.

## 8. `addQteLine()`, `editQte()` — unchanged

`addQteLine()` (`index.html:9058-9061`) needs no change — a new line simply has no `markup` key, which `qteEffectiveMargin()` already treats as "inherit." `editQte()`'s `cQL = (q.lines||[]).map(function(l){ return Object.assign({}, l); })` already deep-copies whatever `markup` field (or lack of one) exists on the saved line — verified this generically copies every field, no per-field allowlist to update.

## GDPR Data Flow

None. This spec adds one numeric field (`Quote.lines[].markup`) to an entity that is already local-only (not in `FIELD_MAPS.qt`, `index.html:3413`) and already commercially-sensitive-but-not-personal-data (per `docs/data-model.md`'s existing classification of Quote pricing). No new external transmission, no new field capable of holding personal data, no change to any existing PII flow.

## Test Plan (`tests/run.js`)

New suite `Per-line quote margin (SPEC-QTE-001)`:

- `qteEffectiveMargin()` — line with no `markup` key → returns the passed quote markup, unchanged.
- `qteEffectiveMargin()` — line with `markup: 0` → returns `0`, not the quote markup (AC-001/AC-004 boundary case — the one a `||`-style implementation would get wrong).
- `qteEffectiveMargin()` — line with `markup: 12.5` → returns `12.5` regardless of quote markup.
- `qlEffectiveMarkupInput()` — mocked `qlFld` returning `''` → returns `undefined`.
- `qlEffectiveMarkupInput()` — mocked `qlFld` returning `'0'` → returns the number `0`, not `undefined` (AC-014).
- `qteSellTotals()` — two lines, one `markup: 0` (pass-through) and one inheriting a non-zero quote markup, asserts the `0`-margin line's contribution to `sellUSD` equals its landed cost exactly, and the inheriting line's contribution reflects the quote markup (AC-001).
- `qteSellTotals()` — asserts `overhead` is added to `sellUSD` exactly once, unscaled by any margin — fixture with a non-zero quote markup, asserting the `overhead` component of the returned total is the raw `QR.originCharges+destCharges+fpmAdmin` sum, not that sum times any factor (AC-010).
- `saveQte()` integration, two fixtures for AC-003: (1) a quote with a line-level override changes only that line's own `markup` (quote-level unchanged) — that line gets a new `priceHistory` version, a sibling line with its own *unrelated, unchanged* override does not. (2) the quote-level default itself changes — per REQ-QTE-001e a line with **no** override correctly gets a new version too (its effective margin genuinely changed), while a sibling line with its own override (therefore unaffected by the quote-level change) does not. Both fixtures are needed since they exercise opposite directions of "effective margin changed vs. didn't."
- `saveQte()` integration — pre-existing quote (fixture with no line ever having a `markup` key, matching a v2.9.51-era saved quote) loads via `editQte()` and resaves via `saveQte()` unchanged, asserting `calc_sellUSD` differs from the pre-REQ-QTE-001 value by exactly the amount `overhead` was previously marked up by — computed and asserted as an explicit expected number in the fixture, not merely "some difference" (AC-002).
- `cQte()` — asserts `rQte()`'s and `prevQteDoc()`'s consumption of `.sellUSD`/`.sellGBP`/`.lineCalcs` still works against the modified return shape (regression, since both are unchanged call sites relying on the same keys existing with the same meaning).
- DOM/UI: `rQLT()` renders the new Margin input's `value` attribute as `''` (not `'0'`) for a line with no `markup` key, and as `'0'` for a line with `markup: 0` — the exact DOM-level assertion of the blank-vs-zero distinction (AC-014, matches the `mockEl` pattern already used elsewhere in `tests/run.js` for other `rQLT()`/`rOrdLines()` DOM checks).

## Changelog

- v1: Initial spec implementing REQ-QTE-001-v3, Part A only. Part B deferred to a separate spec pass per the REQ's own staged-build recommendation.
