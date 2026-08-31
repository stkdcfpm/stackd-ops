# SPEC-QTE-002 — Per-quote overhead charge overrides

**Status:** v1 — draft, pending spec-gate review.
**Build baseline:** `main` @ current HEAD, 630/630 tests passing.
**Implements:** `docs/REQ-QTE-002-v1.md` (REQ-QTE-002a through REQ-QTE-002f, ACs 1-7).

---

## 1. New helper: `qteEffectiveOverhead()` (REQ-QTE-002a)

Insert immediately after `qteEffectiveMargin()` (`index.html:10537-10540`), before `qteSellTotals()`:

```js
function qteEffectiveOverhead(originVal, destVal, adminVal, qr) {
  var eff = function(v, d) { return (v === undefined || v === null || v === '') ? d : +v; };
  var origin = eff(originVal, qr.originCharges);
  var dest   = eff(destVal,   qr.destCharges);
  var admin  = eff(adminVal,  qr.fpmAdmin);
  return { origin: origin, dest: dest, admin: admin, total: origin + dest + admin };
}
```

Same three-way blank check as `qteEffectiveMargin()` (`lm !== undefined && lm !== null && lm !== ''`), just inverted into a small local `eff()` closure since there are three fields to resolve instead of one.

---

## 2. `qteSellTotals()` — takes a resolved overhead total, not raw `qr` fields (REQ-QTE-002b)

Replace (`index.html:10542-10551`):

```js
function qteSellTotals(lines, lineCalcs, quoteMarkup, qr) {
  var sellUSD = lines.reduce(function(sum, l, i) {
    var m = qteEffectiveMargin(l, quoteMarkup);
    return sum + lineCalcs[i].landed * (1 + m / 100);
  }, 0);
  var overhead = qr.originCharges + qr.destCharges + qr.fpmAdmin;
  sellUSD += overhead; // SPEC-QTE-001: overhead is never marked up, added at cost
  var sellGBP = sellUSD / qr.fxGBPUSD;
  return { sellUSD: sellUSD, sellGBP: sellGBP, overhead: overhead };
}
```

with:

```js
function qteSellTotals(lines, lineCalcs, quoteMarkup, overheadTotal, fxGBPUSD) {
  var sellUSD = lines.reduce(function(sum, l, i) {
    var m = qteEffectiveMargin(l, quoteMarkup);
    return sum + lineCalcs[i].landed * (1 + m / 100);
  }, 0);
  sellUSD += overheadTotal; // SPEC-QTE-001: overhead is never marked up, added at cost
  var sellGBP = sellUSD / fxGBPUSD;
  return { sellUSD: sellUSD, sellGBP: sellGBP, overhead: overheadTotal };
}
```

Only the per-line markup logic (unchanged) and the source of `overhead`/`fxGBPUSD` differ. All three call sites updated below.

---

## 3. `cQte(qt)` — resolves overhead from the saved quote (REQ-QTE-002c), returns the breakdown (REQ-QTE-002d)

Replace (`index.html:10553-10564`):

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

with:

```js
function cQte(qt) {
  var qr = QR;
  var mode = qt.freightMode || 'LCL';
  var lines = qt.lines || [];
  var totalCBM = lines.reduce(function(s,l){ return s + (+l.cbm||0); }, 0);
  var lineCalcs = lines.map(function(l){ return cQteLine(l, qr, mode, totalCBM); });
  var totalLanded = lineCalcs.reduce(function(s,c){ return s + c.landed; }, 0);
  var markup = +qt.markup || 0;
  var overheadEff = qteEffectiveOverhead(qt.originCharges, qt.destCharges, qt.fpmAdmin, qr);
  var totals = qteSellTotals(lines, lineCalcs, markup, overheadEff.total, qr.fxGBPUSD);
  var quotedTotal = totalLanded + totals.overhead;
  return { totalLanded: totalLanded, overhead: totals.overhead, overheadBreakdown: overheadEff, quotedTotal: quotedTotal, sellUSD: totals.sellUSD, sellGBP: totals.sellGBP, lineCalcs: lineCalcs };
}
```

`qt.originCharges`/`qt.destCharges`/`qt.fpmAdmin` are `undefined` for every quote saved before this ships (confirmed at requirements-gate — `saveQte()` today never sets these), so `qteEffectiveOverhead()` falls back to `qr`'s current values for every existing quote, producing byte-identical output to today (AC-1, AC-5). `rQte()` (`index.html:10572`, the list view) needs no change — it already calls `cQte(q)` and only reads `.sellUSD`/`.sellGBP`, both still correct.

---

## 4. `prevQteDoc()` — PDF breakdown reads the resolved values, not raw `QR` (REQ-QTE-002d, fixes AC-6)

Replace (`index.html:11259-11261`):

```js
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Origin Charges</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(QR.originCharges,0) + '</td></tr>'
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Destination Charges</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(QR.destCharges,0) + '</td></tr>'
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Admin</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(QR.fpmAdmin,0) + '</td></tr>'
```

with:

```js
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Origin Charges</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(c.overheadBreakdown.origin,0) + '</td></tr>'
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Destination Charges</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(c.overheadBreakdown.dest,0) + '</td></tr>'
    + '<tr><td style="padding:3px 8px;color:#666;font-size:11px;">Admin</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$' + fn(c.overheadBreakdown.admin,0) + '</td></tr>'
```

`c` is already `cQte(q)`, called at `index.html:11229` — no new variable needed, just reading a field `cQte()` now provides.

---

## 5. Quote modal HTML — three new override inputs (REQ-QTE-002e)

Add three new fields immediately after the Markup % field (`index.html:2470`), inside the same top fields grid:

```html
<div class="fld"><label>Origin Charges Override ($)</label><input type="number" id="qf-origOv" min="0" step="5" oninput="calcQte()"></div>
<div class="fld"><label>Dest Charges Override ($)</label><input type="number" id="qf-destOv" min="0" step="5" oninput="calcQte()"></div>
<div class="fld"><label>FPM Admin Override ($)</label><input type="number" id="qf-admOv" min="0" step="5" oninput="calcQte()"></div>
```

("FPM Admin Override" rather than "Admin Override" — matches the existing "FPM Admin" label in the summary grid and avoids any visual confusion with the unrelated Order Request "Admin Override (stage)" control, `index.html:424`, a different modal entirely.)

The existing read-only summary divs (`qt-orig`/`qt-dest`/`qt-adm`, `index.html:2497-2499`) are **not** changed in HTML — they stay read-only outputs, now showing the *effective* (possibly overridden) value instead of always the raw global default. This keeps "input" (the three new fields) and "output" (the existing summary grid, alongside Total Landed/Markup/Sell Price) visually and semantically distinct, rather than repurposing a display div as an editable field.

---

## 6. `calcQte()` — reads the three new inputs, shows effective values with an override indicator (REQ-QTE-002e)

New helper, placed directly above `calcQte()`:

```js
function updQteOverheadPlaceholders() {
  if (G('qf-origOv')) G('qf-origOv').placeholder = 'Default: $' + fn(QR.originCharges,0);
  if (G('qf-destOv')) G('qf-destOv').placeholder = 'Default: $' + fn(QR.destCharges,0);
  if (G('qf-admOv'))  G('qf-admOv').placeholder  = 'Default: $' + fn(QR.fpmAdmin,0);
}
```

Replace `calcQte()` (`index.html:10763-10785`):

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

with:

```js
function calcQte() {
  updQteOverheadPlaceholders();
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
  var origOvRaw = G('qf-origOv') ? G('qf-origOv').value : '';
  var destOvRaw = G('qf-destOv') ? G('qf-destOv').value : '';
  var admOvRaw  = G('qf-admOv')  ? G('qf-admOv').value  : '';
  var overheadEff = qteEffectiveOverhead(origOvRaw, destOvRaw, admOvRaw, QR);
  var totals = qteSellTotals(lines, lineCalcs, markup, overheadEff.total, QR.fxGBPUSD);
  if (G('qt-orig'))     G('qt-orig').textContent     = '$' + fn(overheadEff.origin,0) + (overheadEff.origin !== QR.originCharges ? ' (override)' : '');
  if (G('qt-dest'))     G('qt-dest').textContent     = '$' + fn(overheadEff.dest,0)   + (overheadEff.dest   !== QR.destCharges   ? ' (override)' : '');
  if (G('qt-adm'))      G('qt-adm').textContent      = '$' + fn(overheadEff.admin,0)  + (overheadEff.admin  !== QR.fpmAdmin     ? ' (override)' : '');
  if (G('qt-landed'))   G('qt-landed').textContent   = '$' + fn(totalLanded,0);
  if (G('qt-mkp-disp')) G('qt-mkp-disp').textContent = markup + '%';
  if (G('qt-sell-usd')) G('qt-sell-usd').textContent = fmt(totals.sellUSD,'USD');
  if (G('qt-sell-gbp')) G('qt-sell-gbp').textContent = '£' + fn(totals.sellGBP,0);
  calcFeasibility();
}
```

`updQteOverheadPlaceholders()` runs unconditionally at the top (before the `!cQL.length` early return) so the three override fields always show the current default, even before any line item is added.

---

## 7. `openQte()`/`editQte()` — reset/load the three override fields, and placeholders (REQ-QTE-002f)

`openQte()` (`index.html:10604-10625`) — add, alongside the other `G('qf-...').value = ...` resets:

```js
  G('qf-origOv').value = '';
  G('qf-destOv').value = '';
  G('qf-admOv').value = '';
```

and add `updQteOverheadPlaceholders();` right before `G('ov-qt').classList.add('on');` at the end.

`editQte(id)` (`index.html:10627-10652`) — add, alongside the other `G('qf-...').value = q....` loads:

```js
  G('qf-origOv').value = q.originCharges !== undefined ? String(q.originCharges) : '';
  G('qf-destOv').value = q.destCharges   !== undefined ? String(q.destCharges)   : '';
  G('qf-admOv').value  = q.fpmAdmin      !== undefined ? String(q.fpmAdmin)      : '';
```

No separate `updQteOverheadPlaceholders()` call needed here — `editQte()` already ends with `calcQte();`, which now calls it internally.

---

## 8. `saveQte()` — persist the override fields (REQ-QTE-002f)

In `saveQte()` (`index.html:10843` onward), replace:

```js
  var totals = qteSellTotals(lines, lineCalcs, markup, QR);
  var sellUSD = totals.sellUSD;
  var sellGBP = totals.sellGBP;
```

with:

```js
  var origOvRaw = G('qf-origOv').value;
  var destOvRaw = G('qf-destOv').value;
  var admOvRaw  = G('qf-admOv').value;
  var overheadEff = qteEffectiveOverhead(origOvRaw, destOvRaw, admOvRaw, QR);
  var totals = qteSellTotals(lines, lineCalcs, markup, overheadEff.total, QR.fxGBPUSD);
  var sellUSD = totals.sellUSD;
  var sellGBP = totals.sellGBP;
```

Then, immediately after the `var qt = { ... };` object literal closes (`index.html:10911`, the line with `approvedAt: ...`), add:

```js
  if (origOvRaw !== '') qt.originCharges = +origOvRaw;
  if (destOvRaw !== '') qt.destCharges = +destOvRaw;
  if (admOvRaw  !== '') qt.fpmAdmin = +admOvRaw;
```

A blank field means the property is never added to the freshly-built `qt` object at all (not `undefined`-valued, simply absent) — matching the existing conditional-field pattern already used a few lines earlier in the same function for `sourceOrdId`/`sourceOrdLineId`/`sourceRfqResponseId` (`index.html:10859-10863`). Because `saveQte()` always builds `qt` from scratch (never `Object.assign({}, existQ, {...})`), clearing a previously-set override back to blank and re-saving correctly removes it — no separate "delete this field" logic needed.

---

## 9. Test plan (`tests/run.js`)

Extend the existing Quote test coverage — no new mocking mechanism needed, everything here is pure calculation/DOM-mock logic already exercised by the existing `saveQteSetup()`/`makePreviewMock()` helpers.

- **`qteEffectiveOverhead()` direct unit tests** (mirroring the existing style, if any exists for `qteEffectiveMargin`; otherwise a fresh small block): blank/`undefined`/`null` for all three → returns `qr`'s defaults; `'0'` for one → returns `0` for that one, defaults for the others; a full override on all three → returns exactly those three values and their sum as `.total`.
- **`cQte()` — override changes total, unset quote doesn't (AC-1, AC-2, AC-4):** two quote fixtures, one with `originCharges: 0` set, one without — assert the overridden one's `.overhead`/`.overheadBreakdown.origin`/`.quotedTotal` reflect the override, the other's reflect `QR.originCharges` unchanged, with both quotes checked in the same test run against the same `QR` (proves no cross-contamination, AC-4).
- **`cQte()` — global Settings change after a quote has a partial override (AC-3):** a quote with only `destCharges` overridden; change `QR.originCharges`/`QR.fpmAdmin` afterward; assert the quote's `overheadBreakdown.origin`/`.admin` track the new global values while `.dest` stays at the quote's own override.
- **`saveQte()` — persistence (AC-1, REQ-QTE-002f):** using `saveQteSetup()` plus setting `mockEl('qf-origOv').value = '0'` (others left blank per `mockEl()`'s default `''`) — assert the saved quote has `originCharges === 0` but no `destCharges`/`fpmAdmin` property at all (`'destCharges' in savedQt === false`), confirming blank truly omits the key rather than storing `undefined`.
- **`saveQte()` — clearing an override (REQ-QTE-002f):** save a quote with an override set, reopen (`editQte`), clear the field, re-save — assert the property is gone from the re-saved record.
- **`saveQte()` — existing quotes unaffected (AC-1, AC-5):** confirm an existing `saveQteSetup()`-based test (unmodified) still produces the same `calc_sellUSD`/`calc_sellGBP` as before this REQ, since `mockEl()` defaults every untouched field to `''` automatically — this is a regression-safety check, not new behavioral coverage.
- **AC-7 (combined overrides):** a quote with `originCharges` overridden to `0` and one line's markup overridden — assert the per-line sell price only reflects that line's own markup (unaffected by the overhead override) and the quote total only reflects the reduced overhead (unaffected by the per-line markup override) — i.e. the two adjust independently, matching `qteSellTotals()`'s summed-after-markup structure.
- **`prevQteDoc()` — breakdown/total consistency (AC-6):** using `makePreviewMock()` (the existing pattern, `tests/run.js:1313-1319`), call `prevQteDoc()` with a quote carrying `originCharges: 0` while `QR.originCharges` is non-zero (set `ctx.QR.originCharges` to a distinct value in the test, restore after) — assert the captured HTML shows `$0` for Origin Charges (not the `QR` value) via `assertContains`, and that the Sell Price figure matches a hand-computed expectation consistent with that same `$0`, not the un-overridden default — this is the test that would have caught the REQ-QTE-002d bug and must fail if `c.overheadBreakdown.origin` were reverted back to `QR.originCharges` in `prevQteDoc()`.

---

## 10. Manual verification (no external dependency — unlike REQ-SYNC-002)

Everything in this SPEC is client-side `index.html` logic with no Apps Script/network component, fully covered by the Node test harness. No manual redeploy step is needed; this ships and takes effect the moment the built `index.html` is deployed.

---

## 11. `docs/requirements-tracker.md` / `STACKD_CONTEXT.md`/`CLAUDE.md` updates required on completion

Per `REQ-QTE-002` §7 — new tracker row, and the `QR`/`cQte()` data-model reference in `CLAUDE.md`/`STACKD_CONTEXT.md` updated to mention the new optional per-quote fields (`originCharges`/`destCharges`/`fpmAdmin`) and `cQte()`'s new `overheadBreakdown` return field.
