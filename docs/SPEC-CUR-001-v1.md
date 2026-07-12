# SPEC-CUR-001-v1: Global Display-Currency Toggle

**Implements:** REQ-CUR-001-v4 (requirements-gate PASS)

## 1. New state

`QR_DEFAULTS` (index.html:2681-ish) gains one key:
```js
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin, displayCurrency: 'GBP' };
```
`var QR = {...QR_DEFAULTS, ...ld('st_qr')}` already merges it — no other change needed for load. `expAll()`/`doImport()` already round-trip `QR` wholesale (`8007`, `8056`) — no change needed there.

## 2. New helper

Add near `toGBP`/`fromGBP` (index.html:3552-3570):
```js
function toDisp(amount, cur) {
  return fromGBP(toGBP(amount, cur), QR.displayCurrency || 'GBP');
}
```
Single composition point — every in-scope call site replaces `toGBP(x, cur)` with `toDisp(x, cur)`, and every hardcoded `'GBP'` literal passed to `fmt()` for an in-scope figure becomes `QR.displayCurrency`.

## 3. `rDash()` changes (index.html:3634-3713)

Replace every `toGBP(..., i.cur||'USD')` / `toGBP(..., p.cur||'USD')` at lines 3642, 3643, 3646, 3651, 3657, 3659, 3661, 3697, 3699, 3706 with `toDisp(..., i.cur||'USD')` / `toDisp(..., p.cur||'USD')` (same arguments, just swap the function name).

Replace every `fmt(x, 'GBP')` used for these aggregates (lines 3671-3676, 3702, 3703, 3709) with `fmt(x, QR.displayCurrency||'GBP')`.

Replace the `&asymp;&thinsp;GBP` label text (3671-3676) with `&asymp;&thinsp;' + (QR.displayCurrency||'GBP') + '`.

Add a `<select>` currency picker to the Dashboard, e.g. immediately above `#kpis` in the HTML (`id="disp-cur-sel"`, options GBP/USD/RMB/BBD), wired via `onchange="setDisplayCurrency(this.value)"`.

New function:
```js
function setDisplayCurrency(cur) {
  QR.displayCurrency = cur;
  sv(K.qr, QR);
  rDash();
  renderBuyers();
}
```
`rDash()`'s own render must set `G('disp-cur-sel').value = QR.displayCurrency||'GBP'` at the top so the selector reflects state on every render (page load, tab switch back to Dashboard).

Staleness banner (REQ-CUR-007): add `renderDispCurWarn('dash-fx-warn')` call inside `rDash()`, new shared function:
```js
function renderDispCurWarn(elId) {
  var el = G(elId); if (!el) return;
  if ((QR.displayCurrency||'GBP') === 'GBP') { el.innerHTML = ''; return; }
  var ts = localStorage.getItem('st_qr_ts');
  var ageMs = ts ? Date.now() - new Date(ts).getTime() : Infinity;
  if (ageMs < 86400000) { el.innerHTML = ''; return; }
  var ageH = isFinite(ageMs) ? Math.floor(ageMs/3600000) : null;
  var msg = ageH !== null
    ? 'FX rates were last refreshed ' + ageH + 'h ago — converted figures may be stale. Update in Settings → Rates & FX.'
    : 'FX rates have never been refreshed from live data. Update in Settings → Rates & FX.';
  el.innerHTML = '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;margin-bottom:8px;">&#9888; ' + msg + '</div>';
}
```
(Extracted so it's reused, not duplicated, at both Dashboard and Buyers call sites — `renderQteRatesWarn()` at 9299 stays untouched, separate concern for the quote modal.)

Add `<div id="dash-fx-warn"></div>` to the Dashboard HTML, near the selector.

## 4. `renderBuyers()` changes (index.html:5083-5103)

Line 5087: `i.currency||'USD'` → `i.cur||'USD'` (dead-field fix, folded per REQ-CUR-003/AC-009).
Line 5086-87: `toGBP(...)` → `toDisp(...)`.
Line 5096: `'£' + outGBP.toFixed(2)` → `fmt(outGBP, QR.displayCurrency||'GBP')` (reuses existing `fmt()` for correct symbol per REQ-CUR-004, replacing the hardcoded `£`).
Add `<div id="buy-fx-warn"></div>` to the Buyers list HTML above the table; add `renderDispCurWarn('buy-fx-warn')` call at the top of `renderBuyers()`.

## 5. `openBuy()` Summary panel changes (index.html:5128-5144)

Lines 5132-5133: `i.currency||'USD'` → `i.cur||'USD'` (same dead-field fix); `toGBP(...)` → `toDisp(...)`.
Line 5141 ("Total invoiced"): `'£' + totalGBP.toFixed(2) + ' GBP'` → `fmt(totalGBP, QR.displayCurrency||'GBP') + ' ' + (QR.displayCurrency||'GBP')`.
Line 5142 ("Outstanding") — **unchanged**, still computed from the un-renamed `outstandGBP` var (which itself must still use `i.cur` per the dead-field fix, but stays converted to `buyer.currency` via `fromGBP`, never `QR.displayCurrency` — per REQ-CUR-006/AC-007).
Add `renderDispCurWarn('buy-summ-fx-warn')` call inside the `if (id && buyer)` block, with a corresponding `<div id="buy-summ-fx-warn"></div>` placed in the Summary panel HTML above the two figures.

## 6. Quote engine guardrail (REQ-CUR-008)

No code change required — `cQteLine`/`cQte` (8544-8575) already don't reference `displayCurrency`. Build-gate check: `grep -n displayCurrency index.html` and confirm no match falls inside those two functions' bodies or their call graph (`cQte` calls `cQteLine`; neither calls `toDisp`).

## 7. Explicitly untouched

`calcVATReturn` (4602-4645), `openAgingReport`/`renderAgingReport` (4799-4883), `renderStatement`/`openStatement` (5201-5239+) — no edits, per REQ-CUR-005 and CUR-GAP-001/002.

## 8. Tests (`tests/run.js`)

New suite `displayCurrency`:
- `toDisp()` composes `toGBP`+`fromGBP` correctly for USD/RMB/BBD/GBP (mirrors existing `toGBP`/`fromGBP` unit tests).
- `setDisplayCurrency()` persists `QR.displayCurrency` via `sv(K.qr, QR)` and is readable back via `ld(K.qr)`.
- AC-004 fixture: 3 invoices (GBP/USD/RMB as specified in REQ-CUR-001-v4) → `calcVATReturn(...).box1 === 600.00` and `.box6 === 2400.00`, asserted with `QR.displayCurrency` set to each of `'GBP'`/`'USD'`/`'RMB'` in turn (3 assertions, same expected values every time).
- AC-009: fixture invoice with `cur:'RMB'`, no `currency` field — `renderBuyers()`'s row (or the underlying aggregate function extracted for testability) converts from RMB, not defaulting to USD.
- AC-007: Summary panel "Outstanding" value identical across `QR.displayCurrency` = `'GBP'` vs `'USD'` for the same fixture buyer/invoices.
- AC-005: `st_qr_ts` set to >24h ago + `QR.displayCurrency='USD'` → `renderDispCurWarn()` populates the target element; `='GBP'` → element stays empty regardless of age; age <24h → element stays empty regardless of currency.
- AC-008: static grep assertion (can be a plain Node `fs.readFileSync` + regex check within the same in the test file, or a documented manual build-gate step — spec leaves this as a build-gate checklist item, not a `tests/run.js` unit test, since it's a codebase-wide static check rather than a runtime behavior).

## Changelog

- v1: Initial spec, translating REQ-CUR-001-v4 into concrete line-level edits across `rDash()`, `renderBuyers()`, `openBuy()`, plus the new `toDisp()`/`setDisplayCurrency()`/`renderDispCurWarn()` functions and the `QR_DEFAULTS.displayCurrency` field.
