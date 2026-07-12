# SPEC-CUR-001-v3: Global Display-Currency Toggle

**Supersedes:** SPEC-CUR-001-v2
**Implements:** REQ-CUR-001-v4 (requirements-gate PASS)

## Correction from v2 (schema-migration-reviewer FAIL)

**CRITICAL, confirmed against code**: `saveRates()` (index.html:9258-9264) runs `Object.assign(QR, QR_DEFAULTS, ratesFromForm())`. Since `QR_DEFAULTS` is a *source* argument here (not the target), every key it defines — including the new `displayCurrency: 'GBP'` — overwrites the live `QR.displayCurrency` first, and `ratesFromForm()` (9250-9256, only reads FX/margin form fields) never re-supplies it. Result: any routine Settings → Rates & FX save silently resets a user's chosen display currency back to `'GBP'` and persists that reset to `st_qr` — a live data-loss path, not just a cold-import edge case. This was invisible before this feature because every other `QR_DEFAULTS` key was always also present in `ratesFromForm()`'s output, making the overwrite-then-reapply a no-op; `displayCurrency` breaks that invariant.

**Fix**: `saveRates()` must capture and restore `displayCurrency` around the `Object.assign`, since the Rates & FX form has no control for it and shouldn't gain one (it's a Dashboard-level preference, not a rate):

```js
function saveRates() {
  var keepDisplayCurrency = QR.displayCurrency;
  Object.assign(QR, QR_DEFAULTS, ratesFromForm());
  QR.displayCurrency = keepDisplayCurrency;
  sv('st_qr', QR);
  localStorage.removeItem('st_qr_ts');
  renderFxStatus();
  toast('Rates saved');
}
```

This is the only change from v2; all other sections (§1-§7 below) are unchanged and already spec-gate-PASSED.

## 1. New state

`QR_DEFAULTS` (index.html:2681-ish) gains one key:
```js
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin, displayCurrency: 'GBP' };
```
`QR` init (index.html:2682, actual IIFE form) already merges defaults with any saved `st_qr` value — old backups lacking the field correctly default to `'GBP'`. `expAll()`/`doImport()` already round-trip the whole `st_qr` object (8007, 8056) — no change needed there.

## 2. New helper

Add near `toGBP`/`fromGBP` (index.html:3552-3570):
```js
function toDisp(amount, cur) {
  return fromGBP(toGBP(amount, cur), QR.displayCurrency || 'GBP');
}
```

## 3. `rDash()` changes (index.html:3634-3713)

`toGBP(..., cur)` → `toDisp(..., cur)` at exactly: **3642, 3643, 3646, 3651, 3657, 3659, 3661, 3697, 3699, 3706**.

`fmt(x, 'GBP')` → `fmt(x, QR.displayCurrency||'GBP')` at exactly: **3671, 3672, 3674, 3675, 3676, 3702, 3709**.

`&asymp;&thinsp;GBP` label text → `&asymp;&thinsp;' + (QR.displayCurrency||'GBP') + '` at exactly: **3671, 3672, 3674, 3675**.

Add a `<select id="disp-cur-sel">` (options GBP/USD/RMB/BBD) above `#kpis`, `onchange="setDisplayCurrency(this.value)"`.

```js
function setDisplayCurrency(cur) {
  QR.displayCurrency = cur;
  sv('st_qr', QR);
  rDash();
  renderBuyers();
}
```
`rDash()` sets `G('disp-cur-sel').value = QR.displayCurrency||'GBP'` at the top of its own body.

Staleness banner (REQ-CUR-007): call `renderDispCurWarn('dash-fx-warn')` inside `rDash()`; add `<div id="dash-fx-warn"></div>` above `#kpis`.

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

## 4. `renderBuyers()` changes (index.html:5083-5103)

Line 5087: `i.currency||'USD'` → `i.cur||'USD'`.
Lines 5086-87: `toGBP(...)` → `toDisp(...)`.
Line 5096: `'£' + outGBP.toFixed(2)` → `fmt(outGBP, QR.displayCurrency||'GBP')`.
Add `<div id="buy-fx-warn"></div>` above the Buyers table; call `renderDispCurWarn('buy-fx-warn')` at the top of `renderBuyers()`.

## 5. `openBuy()` Summary panel changes (index.html:5128-5149)

Lines 5132-5133: `i.currency||'USD'` → `i.cur||'USD'`; `toGBP(...)` → `toDisp(...)`.
Line 5141 ("Total invoiced"): `'£' + totalGBP.toFixed(2) + ' GBP'` → `fmt(totalGBP, QR.displayCurrency||'GBP') + ' ' + (QR.displayCurrency||'GBP')`.
Line 5142 ("Outstanding") — **unchanged**: stays `buyer.currency`-native via `fromGBP` (upstream `i.cur` fix still applies to source currency read).
Line 5147: `inv.currency||'USD'` → `inv.cur||'USD'` — dead-field fix only, native display unchanged, out of conversion scope (single-invoice figure, not an aggregate).
Add `renderDispCurWarn('buy-summ-fx-warn')` inside the `if (id && buyer)` block; add `<div id="buy-summ-fx-warn"></div>` above the two aggregate figures.

## 6. Quote engine guardrail (REQ-CUR-008)

No code change — `cQteLine`/`cQte` (8544-8575) don't reference `displayCurrency`. Build-gate check: `grep -n displayCurrency index.html`, confirm no match inside those functions or their call graph.

## 7. Explicitly untouched

`calcVATReturn` (4602-4645), `openAgingReport`/`renderAgingReport` (4799-4883), `renderStatement`/`openStatement` (5201-5239+).

## 8. Tests (`tests/run.js`)

New suite `displayCurrency`:
- `toDisp()` composes `toGBP`+`fromGBP` correctly for USD/RMB/BBD/GBP.
- `setDisplayCurrency()` persists via `sv('st_qr', QR)`, readable back via `ld('st_qr')`.
- **New (v3): `saveRates()` preserves `displayCurrency`** — set `QR.displayCurrency='USD'`, populate form fields, call `saveRates()`, assert `QR.displayCurrency==='USD'` (must fail against v2's code, pass after the fix).
- AC-004 fixture: 3 invoices (GBP/USD/RMB per REQ-CUR-001-v4) → `calcVATReturn(...).box1 === 600.00`, `.box6 === 2400.00`, asserted with `QR.displayCurrency` set to each of `'GBP'`/`'USD'`/`'RMB'` in turn.
- AC-009: fixture invoice with `cur:'RMB'`, no `currency` field — `renderBuyers()`'s aggregate converts from RMB, not defaulting to USD.
- Regression test for §5's line-5147 fix: fixture invoice `cur:'RMB'`, no `currency` field, in a buyer's `recent5` — Amount column renders in RMB, not USD.
- AC-007: Summary panel "Outstanding" identical across `QR.displayCurrency` = `'GBP'` vs `'USD'`.
- AC-005: `st_qr_ts` >24h ago + `displayCurrency='USD'` → warning shown; `='GBP'` → never shown; age <24h → never shown.
- AC-008: build-gate checklist item (static grep), not a `tests/run.js` unit test.

## Changelog

- v3: Fixed `saveRates()`'s `Object.assign(QR, QR_DEFAULTS, ...)` silently resetting `displayCurrency` to `'GBP'` on every Rates & FX save (schema-migration-reviewer CRITICAL finding) — added capture/restore around the assign, plus a regression test.
- v2: Fixed nonexistent `K.qr` → literal `'st_qr'` key; corrected `rDash()` line citations; added line-5147 dead-field fix.
- v1: Initial spec (superseded).
