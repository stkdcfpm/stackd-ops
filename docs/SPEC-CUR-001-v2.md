# SPEC-CUR-001-v2: Global Display-Currency Toggle

**Supersedes:** SPEC-CUR-001-v1
**Implements:** REQ-CUR-001-v4 (requirements-gate PASS)

## Corrections from v1 (spec-gate FAIL)

1. **`K.qr` does not exist — CRITICAL.** `K` (index.html:2230) has no `qr` property; every real persistence call for `QR` uses the literal string `'st_qr'` (lines 2682, 8007, 8056, 9260, 9277). v1's `sv(K.qr, QR)` would silently write to `sv(undefined, QR)`. All persistence calls below now use `sv('st_qr', QR)` / `ld('st_qr')` directly, matching existing code.
2. **Imprecise `rDash()` line ranges.** v1 cited "3671-3676" as a uniform block for both the `fmt(x,'GBP')` swap and the GBP label swap; not every line in that range contains either pattern (3673 is a percentage via `fp()`, 3676 has no GBP label). v2 lists exact lines per pattern.
3. **Missed dead-field site at line 5147** (`fmt(c.grand, inv.currency||'USD')`, in the same Summary panel's "recent invoices" table). Same nonexistent-`currency`-defaults-to-USD bug as 5132-5133. This is a genuinely separate figure (a single invoice's own amount, not an aggregate) — it is **not** a `QR.displayCurrency`-in-scope figure per REQ-CUR-001-v4 (which only scopes aggregates: Dashboard KPIs, Buyers Outstanding column, Summary "Total invoiced"), but the dead-field bug itself should still be fixed here since it's trivial and directly adjacent. v2 adds it as an explicit, narrow fix: `inv.currency` → `inv.cur`, display stays in that invoice's own native currency (unchanged behavior otherwise, just reading the correct field).

## 1. New state

`QR_DEFAULTS` (index.html:2681-ish) gains one key:
```js
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin, displayCurrency: 'GBP' };
```
`var QR = {...QR_DEFAULTS, ...ld('st_qr')}` already merges it. `expAll()`/`doImport()` already round-trip the whole `st_qr` object (`8007`, `8056`) — no change needed there.

## 2. New helper

Add near `toGBP`/`fromGBP` (index.html:3552-3570):
```js
function toDisp(amount, cur) {
  return fromGBP(toGBP(amount, cur), QR.displayCurrency || 'GBP');
}
```

## 3. `rDash()` changes (index.html:3634-3713)

`toGBP(..., cur)` → `toDisp(..., cur)` at exactly: **3642, 3643, 3646, 3651, 3657, 3659, 3661, 3697, 3699, 3706** (verified, unchanged from v1 — these were correct).

`fmt(x, 'GBP')` → `fmt(x, QR.displayCurrency||'GBP')` at exactly: **3671, 3672, 3674, 3675, 3676, 3702** (corrected list — 3673 is `fp(aM)`, a percentage, not touched; 3703 has no `fmt` call, not touched; 3709 also contains `fmt(e[1],'GBP')` — add to this list, verified present).

`&asymp;&thinsp;GBP` label text → `&asymp;&thinsp;' + (QR.displayCurrency||'GBP') + '` at exactly: **3671, 3672, 3674, 3675** (corrected — 3673/3676 have no such label).

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

Staleness banner (REQ-CUR-007): call `renderDispCurWarn('dash-fx-warn')` inside `rDash()`; add `<div id="dash-fx-warn"></div>` to the Dashboard HTML above `#kpis`.

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
Line 5142 ("Outstanding") — **unchanged**: stays `buyer.currency`-native via `fromGBP`, never follows `QR.displayCurrency`, per REQ-CUR-006/AC-007. (`outstandGBP`'s own upstream `i.cur` fix above still applies — it must read the correct source currency even though its *destination* currency stays buyer-native.)
Line 5147 (recent-invoices "Amount" column, **new in v2**): `inv.currency||'USD'` → `inv.cur||'USD'` — dead-field fix only; this figure remains that invoice's own native currency, not affected by `QR.displayCurrency` (it's a single-invoice amount, not an aggregate, so out of REQ-CUR-001-v4's scope for conversion — only the wrong-field bug is fixed here).
Add `renderDispCurWarn('buy-summ-fx-warn')` inside the `if (id && buyer)` block; add `<div id="buy-summ-fx-warn"></div>` in the Summary panel HTML above the two aggregate figures.

## 6. Quote engine guardrail (REQ-CUR-008)

No code change — `cQteLine`/`cQte` (8544-8575) already don't reference `displayCurrency`. Build-gate check: `grep -n displayCurrency index.html`, confirm no match inside those two functions or their call graph.

## 7. Explicitly untouched

`calcVATReturn` (4602-4645), `openAgingReport`/`renderAgingReport` (4799-4883), `renderStatement`/`openStatement` (5201-5239+) — per REQ-CUR-005 and CUR-GAP-001/002.

## 8. Tests (`tests/run.js`)

New suite `displayCurrency`:
- `toDisp()` composes `toGBP`+`fromGBP` correctly for USD/RMB/BBD/GBP.
- `setDisplayCurrency()` persists via `sv('st_qr', QR)`, readable back via `ld('st_qr')`.
- AC-004 fixture: 3 invoices (GBP/USD/RMB per REQ-CUR-001-v4) → `calcVATReturn(...).box1 === 600.00`, `.box6 === 2400.00`, asserted with `QR.displayCurrency` set to each of `'GBP'`/`'USD'`/`'RMB'` in turn.
- AC-009: fixture invoice with `cur:'RMB'`, no `currency` field — `renderBuyers()`'s aggregate converts from RMB, not defaulting to USD.
- New regression test (v2, covers §5's 5147 fix): fixture invoice with `cur:'RMB'`, no `currency` field, appears in a buyer's `recent5` list — the recent-invoices Amount column renders in RMB, not defaulting to USD.
- AC-007: Summary panel "Outstanding" identical across `QR.displayCurrency` = `'GBP'` vs `'USD'` for the same fixture.
- AC-005: `st_qr_ts` >24h ago + `displayCurrency='USD'` → warning shown; `='GBP'` → never shown regardless of age; age <24h → never shown regardless of currency.
- AC-008: build-gate checklist item (static grep), not a `tests/run.js` unit test.

## Changelog

- v2: Fixed `K.qr` (nonexistent) → literal `'st_qr'` key throughout; corrected `rDash()`'s `fmt`/label line citations to the exact lines that contain each pattern (dropped 3673/3676 label claim, added 3709 fmt claim); added the line-5147 dead-field fix (scoped narrowly — bug fix only, no currency-toggle conversion, since it's a single-invoice figure not an aggregate) plus its regression test.
- v1: Initial spec (superseded — broken persistence key, imprecise citations, missed 5147).
