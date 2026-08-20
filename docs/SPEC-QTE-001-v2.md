# SPEC-QTE-001-v2: Per-Line Quote Margin (Part A only)

**Supersedes:** SPEC-QTE-001-v1 (independent spec-gate CONDITIONAL PASS — the calculation-engine logic itself was verified correct with no blocking bugs: `lines[i]`/`lineCalcs[i]` correspondence traced by hand through all three call sites, sentinel handling confirmed correct, FM-1/GDPR claims rechecked and held. Four minor items required correction before build-gate: (1) §1's placement citation was off by one line; (2) §5's `rQLT()` citation range was wrong (actual 9069-9110, not 9069-9101); (3) `qlEffectiveMarkupInput()` carried a dead branch — `qlFld()` verified to never actually return `undefined`; (4) two test-plan gaps, AC-004 had no dedicated test and AC-002's test didn't assert per-line values were unchanged. All four resolved below — no logic changes from v1.)

**Implements:** REQ-QTE-001-v3, Part A only (REQ-QTE-001a–f, AC-001–004/010/014).

**Part B (RFQ supplier comparison & commit) remains out of scope**, unchanged from v1.

## 0. Design note: one shared calc path, not three duplicated ones

Unchanged from v1. Three existing call sites (`cQte()`, `calcQte()`, `saveQte()`) each independently compute quote sell totals today; this spec introduces two small shared helpers and routes all three through them rather than duplicating the new per-line-margin logic a third time.

## 1. `qteEffectiveMargin(line, quoteMarkup)` — new, pure function

Placed immediately after `cQteLine()`'s closing brace (`index.html:8948`) — **corrected citation:** the blank separator line is `8949`, not `8948` as v1 stated; `8948` is the closing `}` itself.

```js
function qteEffectiveMargin(line, quoteMarkup) {
  var lm = line.markup;
  return (lm !== undefined && lm !== null && lm !== '') ? +lm : +quoteMarkup;
}
```

Unchanged logic from v1 — independently verified correct (explicit `0` returns `0`, not the quote default).

## 2. `qteSellTotals(lines, lineCalcs, quoteMarkup, qr)` — new, pure function

Unchanged from v1.

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

Independently verified: `lines[i]`/`lineCalcs[i]` correspondence holds at every call site (all three build both arrays via a single `.map()` over the same source array, same order, no reorder/filter between build and this call).

## 3. `cQte(qt)` — modified (`index.html:8950-8963`)

Unchanged from v1.

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

`rQte()` (`index.html:8971`) and `prevQteDoc()` (`index.html:9602`) both call `cQte(q)` — independently verified both continue to work unchanged against this return shape. **No changes needed to `rQte()` or `prevQteDoc()` themselves.**

## 4. `calcQte()` — modified (`index.html:9150-9173`)

Unchanged from v1.

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

Independently verified the early-return for `!cQL.length` (an empty quote) is preserved unchanged from current code, and `calcFeasibility()` is unaffected.

## 5. `rQLT()` — modified — **corrected citation: `index.html:9069-9110`** (v1 said `9069-9101`, wrong by 9 lines — the function's real end, including the history-row `<tr>` and closing tags, was cut off in v1's citation)

Two changes to the row template, unchanged from v1: a new Margin input cell (blank when `l.markup` is unset) after the Duty % cell, and a new Sell cell.

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

Independently verified `quoteMarkup`'s read is safe for a brand-new quote (`openQte()`/`editQte()` both set `qf-mkp` before calling `rQLT()`), and the `colspan` bump `11`→`13` is arithmetically correct against the two new columns.

## 6. `qlEffectiveMarkupInput(rid)` — new function (**dead branch removed**)

Placed immediately after `qlFld()` (`index.html:9052-9056`).

```js
function qlEffectiveMarkupInput(rid) {
  var raw = qlFld(rid, 'mkp');
  return raw === '' ? undefined : +raw;
}
```

**Corrected from v1:** independently verified `qlFld()`'s real implementation (`index.html:9052-9056`) — it returns `''` for a blank/present input **and** `''` for a missing element (`if (!el) return '';`), and never returns `undefined` at all. v1's `raw === '' || raw === undefined` check therefore carried a dead second branch; removed. Behavior is identical (the branch was never reachable), this is a cleanliness fix only, not a logic change.

Still correctly distinct from `dutyPct`'s own collapsing read (`+qlFld(l.rid,'dutyPct')||0`, `index.html:9244`) — `''` → `undefined` (inherit), `'0'` → `0` (explicit override), per REQ-QTE-001a/AC-004/AC-014.

## 7. `saveQte()` — modified (`index.html:9231-9297`, the section from the `lines` map through the totals block)

Unchanged from v1.

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

Independently verified: no index-misalignment, no double-computation, no ordering bug — the `forEach` mutating `l.priceHistory` doesn't disturb the `lines`/`lineCalcs` correspondence `qteSellTotals()` relies on afterward, since only `l.priceHistory` is touched, not `l.markup` or array order.

**Note for build-gate (carried forward from spec-gate, not a defect):** this change recomputes `calc_sellUSD`/`calc_sellGBP` on every existing quote once resaved, not just quotes using the new per-line field — because `overhead` stops being marked up universally. This is REQ-QTE-001c's explicit, already-decided behavior change (documented and tested via AC-002), but build-gate should be aware it's a global recompute on next save, not purely additive.

## 8. `addQteLine()`, `editQte()` — unchanged

Unchanged from v1.

## GDPR Data Flow

Unchanged from v1. No new PII, no new external transmission — `Quote.lines[].markup` is a numeric field on an already-local-only entity.

## Test Plan (`tests/run.js`)

New suite `Per-line quote margin (SPEC-QTE-001)` — all v1 bullets retained, two gaps closed:

- `qteEffectiveMargin()` — line with no `markup` key → returns the passed quote markup, unchanged.
- `qteEffectiveMargin()` — line with `markup: 0` → returns `0`, not the quote markup (AC-001/AC-004 boundary case).
- `qteEffectiveMargin()` — line with `markup: 12.5` → returns `12.5` regardless of quote markup.
- `qlEffectiveMarkupInput()` — mocked `qlFld` returning `''` → returns `undefined`.
- `qlEffectiveMarkupInput()` — mocked `qlFld` returning `'0'` → returns the number `0`, not `undefined` (AC-014).
- **(new, closes v1's AC-004 gap)** `qlEffectiveMarkupInput()`/`saveQte()` round-trip — a line saved with an explicit `markup: 5` override, then re-saved after the operator clears the field back to blank in the UI, persists with no `markup` key (or `undefined`) on the next save — not `0`, not the stale `5` — confirming REQ-QTE-001a/AC-004's "clearing reverts to quote default" behavior specifically, as its own labeled test rather than only inferred from the two bullets above.
- `qteSellTotals()` — two lines, one `markup: 0` (pass-through) and one inheriting a non-zero quote markup, asserts the `0`-margin line's contribution to `sellUSD` equals its landed cost exactly, and the inheriting line's contribution reflects the quote markup (AC-001).
- `qteSellTotals()` — asserts `overhead` is added to `sellUSD` exactly once, unscaled by any margin (AC-010).
- `saveQte()` integration, two fixtures for AC-003: (1) only a line's own `markup` changes (quote-level unchanged) — that line gets a new `priceHistory` version, a sibling line with its own unrelated, unchanged override does not. (2) the quote-level default itself changes — a line with no override correctly gets a new version (its effective margin genuinely changed), while a sibling line with its own override does not.
- **(strengthened, closes v1's AC-002 gap)** `saveQte()` integration — pre-existing quote (fixture with no line ever having a `markup` key) loads via `editQte()` and resaves via `saveQte()` unchanged, asserting **both**: `calc_sellUSD` differs from the pre-REQ-QTE-001 value by exactly the expected `overhead`-unmarked-up delta (an explicit computed number in the fixture, not "some difference"), **and** every line's own `landed`/`sellPrice` values in the resulting `priceHistory` entry are byte-identical to what they'd have been pre-REQ-QTE-001 (per-line figures are unaffected by the overhead change — only the quote-wide total should move).
- `cQte()` — asserts `rQte()`'s and `prevQteDoc()`'s consumption of `.sellUSD`/`.sellGBP`/`.lineCalcs` still works against the modified return shape.
- DOM/UI: `rQLT()` renders the new Margin input's `value` attribute as `''` (not `'0'`) for a line with no `markup` key, and as `'0'` for a line with `markup: 0` (AC-014).

## Changelog

- v1: Initial spec implementing REQ-QTE-001-v3, Part A only.
- v2: Independent spec-gate CONDITIONAL PASS on v1 (no blocking logic bugs) resolved — two citation corrections, one dead-code removal, two test-plan additions (dedicated AC-004 test, strengthened AC-002 test). No calculation logic changed from v1.
