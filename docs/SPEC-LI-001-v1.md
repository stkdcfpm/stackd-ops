# SPEC-LI-001 — Line Item unit cost/price: 3-decimal-place precision

**Status:** v1 — implements `docs/REQ-LI-001-v1.md` (requirements-gate: 3 rounds CONDITIONAL PASS, round 4 clean PASS — see REQ §8).
**Build baseline:** `main` @ `6935caf`, 775/775 tests passing (corrects the REQ's own stale "712/712" figure, per REQ §5).

---

## 1. Validation layer

### 1.1 `RX` — new `currency3` regex helper (`index.html:8728-8737`)

Current:
```js
var RX = {
  email:   /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  invNum:  /^(INV|CN)\d{4,6}(-D\d+)?$/i,
  poNum:   /^PO[\w\-]{2,20}$/i,
  shpRef:  /^[A-Z0-9][\w\-]{1,29}$/i,
  hsCode:  /^\d{2,10}(\.\d{1,4})?$/,
  date:    /^\d{4}-\d{2}-\d{2}$/,
  taxRate: function(v){ return v >= 0 && v <= 1; },
  currency: function(v){ return !isNaN(+v) && +v >= 0 && !/\.\d{3,}/.test(String(v)); }
};
```
becomes:
```js
var RX = {
  email:   /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  invNum:  /^(INV|CN)\d{4,6}(-D\d+)?$/i,
  poNum:   /^PO[\w\-]{2,20}$/i,
  shpRef:  /^[A-Z0-9][\w\-]{1,29}$/i,
  hsCode:  /^\d{2,10}(\.\d{1,4})?$/,
  date:    /^\d{4}-\d{2}-\d{2}$/,
  taxRate: function(v){ return v >= 0 && v <= 1; },
  currency: function(v){ return !isNaN(+v) && +v >= 0 && !/\.\d{3,}/.test(String(v)); },
  currency3: function(v){ return !isNaN(+v) && +v >= 0 && !/\.\d{4,}/.test(String(v)); }
};
```
(`RX.currency` itself is byte-for-byte unchanged — every field listed in REQ §1.1 other than `lf-c`/`lf-p` keeps validating against it, with zero behavior change.)

### 1.2 `vBlurCurrency()` — optional 3rd parameter (`index.html:8816-8823`)

Current:
```js
function vBlurCurrency(id, label) {
  var v = G(id); if (!v) return;
  var val = v.value;
  if (val === '' || val === null) { vOk(id); return; }
  if (!RX.currency(val)) vErr(id, label + ' must be a non-negative number with at most 2 decimal places');
  else if (+val < 0) vErr(id, label + ' cannot be negative');
  else vOk(id);
}
```
becomes:
```js
function vBlurCurrency(id, label, rx, decLabel) {
  rx = rx || RX.currency;
  decLabel = decLabel || '2';
  var v = G(id); if (!v) return;
  var val = v.value;
  if (val === '' || val === null) { vOk(id); return; }
  if (!rx(val)) vErr(id, label + ' must be a non-negative number with at most ' + decLabel + ' decimal places');
  else if (+val < 0) vErr(id, label + ' cannot be negative');
  else vOk(id);
}
```
Every existing 2-argument call site (`if-dep`, `if-lf`, `if-ins`, `if-leg`, `if-isp`, `if-oth`, `pf-dep`, `pf-fpm`, `pf-oth` — `index.html:8899-8915`, unchanged in this SPEC) defaults `rx` to `RX.currency` and `decLabel` to `'2'`, reproducing today's exact behavior and exact error message text with no code change needed at those 9 wiring lines.

### 1.3 On-blur wiring for `lf-c`/`lf-p` (`index.html:8897-8898`)

Current:
```js
    'lf-c':    function(){ vBlurCurrency('lf-c','Unit cost'); },
    'lf-p':    function(){ vBlurCurrency('lf-p','Unit price'); },
```
becomes:
```js
    'lf-c':    function(){ vBlurCurrency('lf-c','Unit cost',RX.currency3,'3'); },
    'lf-p':    function(){ vBlurCurrency('lf-p','Unit price',RX.currency3,'3'); },
```

### 1.4 `vLI()` submit validation (`index.html:8947,8950`)

Current:
```js
  if (cost !== '' && !RX.currency(cost))   return vErr('lf-c', 'Unit cost must be a non-negative number with at most 2 decimal places');
  else if (+cost < 0)         return vErr('lf-c', 'Unit cost cannot be negative');
  else                        vOk('lf-c');
  if (price !== '' && !RX.currency(price)) return vErr('lf-p', 'Unit price must be a non-negative number with at most 2 decimal places');
  else if (+price < 0)        return vErr('lf-p', 'Unit price cannot be negative');
  else                        vOk('lf-p');
```
becomes:
```js
  if (cost !== '' && !RX.currency3(cost))   return vErr('lf-c', 'Unit cost must be a non-negative number with at most 3 decimal places');
  else if (+cost < 0)         return vErr('lf-c', 'Unit cost cannot be negative');
  else                        vOk('lf-c');
  if (price !== '' && !RX.currency3(price)) return vErr('lf-p', 'Unit price must be a non-negative number with at most 3 decimal places');
  else if (+price < 0)        return vErr('lf-p', 'Unit price cannot be negative');
  else                        vOk('lf-p');
```

### 1.5 Input `step` attribute (`index.html:1071-1072`)

Current:
```html
      <div class="fld"><label id="lbl-li-cost">Unit Cost (supplier price)</label><input type="number" id="lf-c" placeholder="0.00" step="0.01" oninput="liMgn()"></div>
      <div class="fld"><label id="lbl-li-price">Unit Price (buyer price)</label><input type="number" id="lf-p" placeholder="0.00" step="0.01" oninput="liMgn()"></div>
```
becomes:
```html
      <div class="fld"><label id="lbl-li-cost">Unit Cost (supplier price)</label><input type="number" id="lf-c" placeholder="0.00" step="0.001" oninput="liMgn()"></div>
      <div class="fld"><label id="lbl-li-price">Unit Price (buyer price)</label><input type="number" id="lf-p" placeholder="0.00" step="0.001" oninput="liMgn()"></div>
```

---

## 2. Display layer — new `fmtN()` helper (`index.html:3896`, immediately after `fn()`)

Current:
```js
function fn(n, d) { d = d||2; return isNaN(+n) ? '0.00' : (+n).toFixed(d); }
function fp(n) { return (n === null || isNaN(+n)) ? '-' : (+n).toFixed(1) + '%'; }
```
becomes:
```js
function fn(n, d) { d = d||2; return isNaN(+n) ? '0.00' : (+n).toFixed(d); }
function fmtN(n, c, d) { d = d==null?2:d; if (n===null||isNaN(+n)) return '-'; return (c||'USD') + ' ' + (+n).toFixed(d); }
function fp(n) { return (n === null || isNaN(+n)) ? '-' : (+n).toFixed(1) + '%'; }
```
`fmt()` itself (`index.html:3890-3895`) is untouched — its other 87 call sites keep today's `maximumFractionDigits:0` whole-currency-unit rendering with zero behavior change.

### 2.1 Line Items Library price-history sub-table (`index.html:6575-6576`)

Current:
```js
              '<td style="padding:3px 8px;text-align:right;">' + fmt(h.cost, li.cur||'USD') + '</td>' +
              '<td style="padding:3px 8px;text-align:right;">' + fmt(h.price, li.cur||'USD') + '</td>' +
```
becomes:
```js
              '<td style="padding:3px 8px;text-align:right;">' + fmtN(h.cost, li.cur||'USD', 3) + '</td>' +
              '<td style="padding:3px 8px;text-align:right;">' + fmtN(h.price, li.cur||'USD', 3) + '</td>' +
```

### 2.2 Line Items Library main table (`index.html:6584-6585`)

Current:
```js
      '<td class="num">' + fmt(li.cost,li.cur||'USD') + '</td>' +
      '<td class="num">' + fmt(li.price,li.cur||'USD') + phBadge + '</td>' +
```
becomes:
```js
      '<td class="num">' + fmtN(li.cost,li.cur||'USD',3) + '</td>' +
      '<td class="num">' + fmtN(li.price,li.cur||'USD',3) + phBadge + '</td>' +
```

### 2.3 "Import from Library" picker (`index.html:6937`, `openPicker()`)

Current:
```js
      '<div style="color:var(--m);font-size:.54rem;">' + gsn(li.supId) + ' - ' + (li.uom||'-') + ' - ' + fmt(li.price,li.cur) + (refCount ? ' &nbsp;&middot;&nbsp; used on ' + refCount + ' invoice(s)' : '') + '</div></div></label>';
```
becomes:
```js
      '<div style="color:var(--m);font-size:.54rem;">' + gsn(li.supId) + ' - ' + (li.uom||'-') + ' - ' + fmtN(li.price,li.cur,3) + (refCount ? ' &nbsp;&middot;&nbsp; used on ' + refCount + ' invoice(s)' : '') + '</div></div></label>';
```

### 2.4 Invoice PDF line-item table (`index.html:8498`, `prevInvDoc()`)

Current:
```js
      +'<td style="padding:7px;border-bottom:1px solid #eee;text-align:right;">'+fn(li.up)+'</td>'
```
becomes:
```js
      +'<td style="padding:7px;border-bottom:1px solid #eee;text-align:right;">'+fn(li.up,3)+'</td>'
```

### 2.5 PO PDF line-item table (`index.html:8637`, `prevPODoc()`)

Current:
```js
      +'<td style="padding:7px;border-bottom:1px solid #eee;text-align:right;">'+fn(li.cost)+'</td>'
```
becomes:
```js
      +'<td style="padding:7px;border-bottom:1px solid #eee;text-align:right;">'+fn(li.cost,3)+'</td>'
```

### 2.6 Quote PDF line-item table (`index.html:12758`, `prevQteDoc()`)

Current:
```js
      + '<td style="padding:4px 8px;font-size:11px;text-align:right;">$' + fn(l.cost,0) + '</td>'
```
becomes:
```js
      + '<td style="padding:4px 8px;font-size:11px;text-align:right;">$' + fn(l.cost,3) + '</td>'
```

### 2.7 Quote line version-history panel (`index.html:12123`, `renderQteLineHistory()`)

Current:
```js
          + '<td>$' + fn(v.cost,0) + '</td>'
```
becomes:
```js
          + '<td>$' + fn(v.cost,3) + '</td>'
```
(The row's other columns — `dutyPct`, `markup`, `landed`, `sellPrice`, at the following lines — are unchanged; they are derived quote-calculation figures, not a Line Item's own cost/price, per REQ §1.2.)

### 2.8 Supplier Price History table (`index.html:5468`, `renderSupPriceHistory()`)

Current:
```js
        + '<td style="font-weight:600;">' + san(p.currency) + ' ' + fn(p.price,2) + '</td>'
```
becomes:
```js
        + '<td style="font-weight:600;">' + san(p.currency) + ' ' + fn(p.price,3) + '</td>'
```

---

## 3. Out of scope (unchanged from REQ §3)

No change to `RX.currency` itself or any of the 11 other fields sharing it; no change to `fmt()`'s own behavior or its other 87 call sites; no change to roll-up totals/grand-totals precision; no change to CSV/JSON exports or `_aiExecTool` read paths (confirmed unaffected — they pass raw values through with no rounding); no new decimal-precision setting; the dead `vBlurCurrencyPos()` helper is untouched.

---

## 4. New tests (`tests/run.js`)

Mirrors REQ §5's test plan exactly:

- **AC-1** (4 tests): `lf-c`/`lf-p` each accept a 3-decimal value (e.g. `0.125`) via `vLI()` and reject a 4-decimal value (e.g. `0.1255`), both via the submit path (`vLI()`) and the on-blur path (`vBlurCurrency` wired at `8897-8898`).
- **AC-2** (11 tests, one per field): `if-dep`, `if-lf`, `if-ins`, `if-leg`, `if-isp`, `if-oth`, `pf-dep`, `pf-fpm`, `pf-oth`, `pm-amount` (via `vPay()`), `spm-amount` (via `vSupPay()`) — each still rejects a 3-decimal value exactly as before this SPEC. `pf-oth` is tested via its on-blur wiring (`vBlurCurrency('pf-oth',...)`, defaulting to `RX.currency`), since it has no dedicated submit-time check in `vPO()`.
- **AC-3** (5 tests, one per site): `fmtN()`'s exact rendered string at each of the 5 sites in §2.1-2.3 for a known 3-decimal value (e.g. `li.cost=0.125` → `"USD 0.125"`).
- **AC-4** (5 tests, one per site): `fn(...,3)`'s exact rendered string at each of the 5 sites in §2.4-2.8 for a known 3-decimal value.
- **AC-5** (1 test): a 3-decimal cost/price pair fed through `liMgn()` produces a margin percentage that differs measurably from the same pair rounded to 2 decimals first — proving the added precision actually improves margin accuracy, not just display.
- **AC-6** (1 test, HTML-level): `lf-c`/`lf-p`'s `step` attribute reads `"0.001"`.
- **AC-7** (regression, folded into AC-2's 11 tests plus a `fmt()` call-count sanity check): no other field's validation/display/step attribute changes.

Expected new-test count: 4+11+5+5+1+1 = 27. Full suite expected: 775+27 = **802/802**.

---

## 5. Gate process

Per REQ §6: this SPEC → independent spec-gate review (apply diffs to a scratch copy, run the real suite) → implementation → mutation testing (revert each of §1.1/§1.4's guard changes individually, confirm the predicted single test failure, restore) → independent build-gate review → PR → CI green → merge.
