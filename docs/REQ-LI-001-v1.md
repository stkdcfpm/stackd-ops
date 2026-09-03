# REQ-LI-001 — Line Item unit cost/price: 3-decimal-place precision

**Status:** v1 — drafted, awaiting requirements-gate review.
**Type:** Small, self-contained precision uplift. No schema change, no Cloud Data/reconciliation impact, no new entity or field.
**Scope:** Line Item's `cost` and `price` fields only (the `lf-c`/`lf-p` form inputs and the underlying `DB.li[].cost`/`DB.li[].price` values). Every other money field in the app (Invoice/PO deposits and charges, buyer/supplier payment amounts) is explicitly unchanged — see §3.

**Origin:** User-requested — high-volume, low-unit-price line items (e.g. small hardware/components bought and sold by the thousand) currently lose real precision because unit cost/price is capped at 2 decimal places. A unit price like `$0.0125` cannot be entered at all today; it must be rounded to `$0.01` or `$0.02`, which measurably distorts margin (`liMgn()`) and COGS (`+r.cost*+li.qty` roll-ups, e.g. `index.html:4804,5072,5145,5240,5302,6953`) at volume.

---

## 1. Business context

### 1.1 What caps precision today

`RX.currency`, the shared validation helper (`index.html:8736`):
```js
currency: function(v){ return !isNaN(+v) && +v >= 0 && !/\.\d{3,}/.test(String(v)); }
```
rejects any value with 3 or more digits after the decimal point. This one helper is called from **10 distinct validation sites** across the app, not just Line Item's:

| Site | Field(s) | Code |
|---|---|---|
| `vBlurCurrency()` (on-blur) | `lf-c`, `lf-p`, `if-dep`, `if-lf`, `if-ins`, `if-leg`, `if-isp`, `if-oth`, `pf-dep`, `pf-fpm`, `pf-oth` | `index.html:8816-8823`, wired at `8897-8915` |
| `vBlurCurrencyPos()` (on-blur) | defined but **never wired to any field** — confirmed by grep, dead code, unaffected either way | `index.html:8824-8830` |
| Line Item submit validation | `lf-c` (cost), `lf-p` (price) | `index.html:8947,8950` |
| Invoice submit validation | `if-dep` (buyer deposit) | `index.html:8993` |
| Invoice submit validation | `if-lf`,`if-ins`,`if-leg`,`if-isp`,`if-oth` (freight/insurance/legal/inspection/other charges) | `index.html:8997-9000` |
| PO submit validation | `pf-dep` (supplier deposit), `pf-fpm` (FPM funded amount) | `index.html:9021,9024` |
| Buyer payment submit validation | `pm-amount`, via `vPay()` | `index.html:9052` |
| Supplier payment submit validation | `spm-amount`, via `vSupPay()` | `index.html:13274` |

**Only two of these ten sites — `lf-c` and `lf-p` — are in scope for this REQ.** A global edit to `RX.currency` itself (e.g. widening `\.\d{3,}` to `\.\d{4,}`) would silently loosen precision on deposits, freight charges, and payment amounts too, which is out of scope and was never asked for (§3).

### 1.2 Where cost/price precision is lost again on the *display* side

Loosening validation alone is not sufficient — three render paths currently truncate cost/price below 2 decimals, or below whatever precision is entered, and would hide a 3rd decimal even after it's allowed to be typed and saved:

- **Line Items Library main table** (`index.html:6584-6585`): `fmt(li.cost,li.cur||'USD')` / `fmt(li.price,li.cur||'USD')`. `fmt()` (`index.html:3890-3895`) uses `Intl.NumberFormat` with `maximumFractionDigits: 0` — it renders **whole currency units only**, e.g. `$12`, not `$12.34`. This is a pre-existing gap: even today's 2-decimal values are rounded away here. `fmt()` is used 92 times across the app for general currency display (totals, invoice/PO amounts, etc.), so it must not be changed globally — only these two Line Item call sites need a decimal-aware alternative.
- **Line Item price-history sub-table** (`index.html:6575-6576`): same `fmt(h.cost,...)` / `fmt(h.price,...)` pattern, same gap.
- **Quote/PO line-item render tables** (`index.html:8498,8637`): `fn(li.up)` / `fn(li.cost)`. `fn(n,d)` (`index.html:3896`) is `(+n).toFixed(d||2)` — it already renders real decimals (unlike `fmt()`), but defaults to 2 when no `d` is passed, so a stored 3rd decimal would still round away silently unless these two calls pass `d=3` explicitly.

Nothing else needs a display change: `liMgn()`'s margin calculation and `fp()`'s percentage display (`index.html:6561,3897`) operate on the raw numeric values already (not on a rounded display string), so margin accuracy actually *improves* once the 3rd decimal is captured at all — no code change needed there.

### 1.3 Input affordance

The `lf-c`/`lf-p` HTML inputs are `type="number" step="0.01"` (`index.html:1071-1072`). `step` does not block manual typing or paste of a 3-decimal value in any current browser (no `required`/native-submit validity is enforced on this form), so today's cap is enforced entirely by `vLI()`'s `RX.currency()` check, not by the input itself. Still, `step="0.01"` should be updated to `step="0.001"` so the native up/down spinner arrows and any browser-native validity styling agree with the new precision — a UI-affordance fix, not a functional blocker on its own.

---

## 2. Requirements

### REQ-LI-001-a — New validation helper: `RX.currency3`
Add a sibling regex helper next to `RX.currency` (`index.html:8736`), scoped only to 3-decimal money fields:
```js
currency3: function(v){ return !isNaN(+v) && +v >= 0 && !/\.\d{4,}/.test(String(v)); }
```
`RX.currency` itself is left byte-for-byte unchanged — every other field listed in §1.1's table keeps today's 2-decimal cap with zero behavior change.

### REQ-LI-001-b — Wire `RX.currency3` at the two Line Item validation sites
- `vLI()` submit validation (`index.html:8947,8950`): replace `RX.currency(cost)` / `RX.currency(price)` with `RX.currency3(cost)` / `RX.currency3(price)`. Update both error messages from "at most 2 decimal places" to "at most 3 decimal places".
- On-blur validation (`index.html:8897-8898`): these currently call the shared `vBlurCurrency('lf-c','Unit cost')` / `vBlurCurrency('lf-p','Unit price')`. Since `vBlurCurrency()` is also wired to 9 other fields that must stay on `RX.currency` (§1.1), it must not be changed globally. Add an optional third parameter to `vBlurCurrency(id, label, rx)` defaulting to `RX.currency` (`index.html:8816-8823`, `if (!rx(val)) vErr(...)`, message text parameterized on which regex was passed), and update only the two Line Item wiring lines (`8897-8898`) to pass `RX.currency3`. Every other call site of `vBlurCurrency()` (`if-dep`, `if-lf`, `if-ins`, `if-leg`, `if-isp`, `if-oth`, `pf-dep`, `pf-fpm`, `pf-oth`) is left as a 2-argument call, unchanged, so it keeps using the default `RX.currency`.

### REQ-LI-001-c — Input affordance
Update `step="0.01"` → `step="0.001"` on both `lf-c` and `lf-p` inputs (`index.html:1071-1072`).

### REQ-LI-001-d — Display: Line Items Library table and price-history sub-table
Add a small decimal-aware currency formatter for use at these four call sites only (not a change to `fmt()` itself, which stays at its existing `maximumFractionDigits:0` behavior for its other 88 call sites):
```js
function fmtN(n, c, d) { d = d==null?2:d; if (n===null||isNaN(+n)) return '-'; return (c||'USD') + ' ' + (+n).toFixed(d); }
```
Use `fmtN(li.cost, li.cur, 3)` / `fmtN(li.price, li.cur, 3)` at `index.html:6584-6585` (main table) and `fmtN(h.cost, li.cur, 3)` / `fmtN(h.price, li.cur, 3)` at `index.html:6575-6576` (price-history sub-table), replacing the four existing `fmt(...)` calls at those exact sites. `toFixed(3)` always shows exactly 3 digits (e.g. `$12.500`) rather than trimming trailing zeros — accepted as correct: consistent fixed-width columns are preferable to variable-width ones in a data table, and this matches the fixed-2-decimal convention `fn()` already uses elsewhere in the app.

### REQ-LI-001-e — Display: Quote/PO line-item render tables
At `index.html:8498` and `8637`, change `fn(li.up)` → `fn(li.up,3)` and `fn(li.cost)` → `fn(li.cost,3)` so a stored 3rd decimal is shown rather than silently rounded to 2.

---

## 3. Out of scope

- Any change to `RX.currency` itself, or to any of the other 8 fields that share it (Invoice/PO deposits and charges, buyer/supplier payment amounts) — these keep today's 2-decimal cap exactly as-is.
- Any change to `fmt()`'s own behavior or its other 88 call sites (invoice/PO/payment totals, statements, dashboards, exports) — these continue to render whole-currency-unit amounts exactly as today.
- Quote-level or PO-level totals/grand-totals precision — only the per-unit `cost`/`price` fields themselves gain a 3rd decimal; roll-up totals (`calc_grandTotal`, `liT`, etc.) are computed from the more-precise raw values automatically and displayed via their existing (unchanged) formatters, so a total like `$1,234.5678` still displays as `$1,235` via `fmt()`, matching today's whole-currency-unit convention for totals.
- PDF/statement export templates, CSV/JSON exports, and AI-tool (`_aiExecTool`) read paths for Line Item cost/price — these were not found to apply any additional rounding beyond what's already covered by §2's fixes (they either omit unit cost/price entirely or pass the raw stored value straight through), so no further site needs a code change. (If a gate review finds one, it will be added here.)
- Any new decimal-precision option/setting (e.g. per-supplier or per-currency-configurable decimal counts) — 3 decimals fixed is sufficient for the stated need (sub-cent visibility on high-volume, low-unit-price items); this is not a general-purpose arbitrary-precision feature.
- The dead, unwired `vBlurCurrencyPos()` helper (`index.html:8824-8830`) — confirmed unused by any field, left untouched.

---

## 4. Acceptance criteria

- **AC-1**: A Line Item can be saved with a `cost` or `price` value carrying up to 3 decimal places (e.g. `0.125`); a 4th decimal digit is still rejected with a clear inline error, both on blur and on submit.
- **AC-2**: Every other money field in the app (Invoice buyer deposit and 5 charge fields, PO supplier deposit and FPM funded amount, buyer payment amount, supplier payment amount) still rejects a 3rd decimal digit exactly as today — verified by an explicit regression test per field, not just by code inspection.
- **AC-3**: The Line Items Library main table and its price-history sub-table both display Line Item cost/price to 3 decimal places.
- **AC-4**: Quote and PO line-item render tables display a Line Item's unit cost/price to 3 decimal places when the underlying value carries one (e.g. `0.125` displays as `0.125`, not `0.13` or `0.12`).
- **AC-5**: Margin calculation (`liMgn()`) and its percentage display are unaffected in code (no change made), and are confirmed by test to reflect the added precision correctly (a 3-decimal cost/price pair produces a materially different, more accurate margin percentage than the same values rounded to 2 decimals).
- **AC-6**: The `lf-c`/`lf-p` input spinner step matches the new precision (`step="0.001"`).
- **AC-7**: No other numeric field's validation, display, or input step attribute changes as a result of this REQ (regression-checked against §1.1's full 10-site table and §1.2/§1.3's other fields).

---

## 5. Testing approach

Following this codebase's established pattern (`tests/run.js`): add explicit new tests for AC-1 (3-decimal accept, 4-decimal reject, both `lf-c` and `lf-p`) and AC-2 (one regression test per one of the other 8 shared-`RX.currency` fields, confirming each still rejects a 3-decimal value) — the AC-2 tests are the ones that actually prove `RX.currency` itself was left untouched, not just an inspection claim. Add a display-formatting test for AC-3/AC-4 asserting the exact rendered string for a known 3-decimal cost/price value. Full existing suite must remain green (currently 712/712 per the last shipped REQ).

## 6. Gate process

Standard pipeline: this REQ → independent requirements-gate review → SPEC-LI-001 (exact diffs) → independent spec-gate review (applies diffs to a scratch copy, runs the real suite) → implementation → mutation testing (revert each of REQ-LI-001-a/b's guard changes individually, confirm the predicted single test failure, restore) → independent build-gate review → PR → CI green → merge.

## 7. Tracker updates (post-ship)

- `docs/requirements-tracker.md`: new row for `REQ-LI-001`.
- `docs/version-history.md` / `STACKD_CONTEXT.md` / `CLAUDE.md`: version bump entry.
- No `docs/known-gaps.md` entry expected — this REQ closes a precision limitation, it does not knowingly leave a new gap open (barring a gate review finding otherwise, per §3's PDF/export caveat).

## 8. Review-resolution log

_None yet — v1 has not been through requirements-gate review._
