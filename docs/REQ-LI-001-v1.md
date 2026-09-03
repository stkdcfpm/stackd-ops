# REQ-LI-001 — Line Item unit cost/price: 3-decimal-place precision

**Status:** v1 — drafted. Requirements-gate round 1: CONDITIONAL PASS (3 blocking, 2 advisory), fixed. Round 2: CONDITIONAL PASS (2 blocking), fixed. Round 3: CONDITIONAL PASS (1 blocking — a stale render-path count), fixed. Round 4: **PASS** — clean, no findings. Requirements-gate complete; proceeding to SPEC. See §8.
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

**Only two of these ten call sites — `lf-c` and `lf-p` — are in scope for this REQ.** Counted by distinct *field* rather than call site (since the `vBlurCurrency()` row above and the 5-charge submit-time loop each cover several fields through one shared code path), `RX.currency` governs **11 other fields** besides `lf-c`/`lf-p`: `if-dep`, `if-lf`, `if-ins`, `if-leg`, `if-isp`, `if-oth`, `pf-dep`, `pf-fpm`, `pf-oth`, `pm-amount`, `spm-amount` (corrected per requirements-gate round 1 — an earlier draft undercounted this as 8, and separately omitted `pf-oth` from AC-2's test list entirely, since `pf-oth` has no dedicated submit-time `RX.currency` check of its own in `vPO()` — only the shared `vBlurCurrency()` wiring at `index.html:8915` — unlike `pf-dep`/`pf-fpm`, which also have one at `index.html:9021,9024`). A global edit to `RX.currency` itself (e.g. widening `\.\d{3,}` to `\.\d{4,}`) would silently loosen precision on all 11, which is out of scope and was never asked for (§3).

### 1.2 Where cost/price precision is lost again on the *display* side

Loosening validation alone is not sufficient — eight render paths currently truncate cost/price below 2 decimals, or below whatever precision is entered, and would hide a 3rd decimal even after it's allowed to be typed and saved (requirements-gate round 1 broadened this from an initial, incomplete count of three; round 2 found an eighth; round 3 found the running count itself had drifted to an inconsistent "seven" by under-splitting two of these into one bullet — corrected here to one bullet per distinct render location, matching AC-3's 3 + AC-4's 5 — see §8):

- **Line Items Library main table** (`index.html:6584-6585`): `fmt(li.cost,li.cur||'USD')` / `fmt(li.price,li.cur||'USD')`. `fmt()` (`index.html:3890-3895`) uses `Intl.NumberFormat` with `maximumFractionDigits: 0` — it renders **whole currency units only**, e.g. `$12`, not `$12.34`. This is a pre-existing gap: even today's 2-decimal values are rounded away here. `fmt()` is used 92 times across the app for general currency display (totals, invoice/PO amounts, etc.), so it must not be changed globally — only the five `fmt()` call sites below need a decimal-aware alternative.
- **Line Item price-history sub-table** (`index.html:6575-6576`): same `fmt(h.cost,...)` / `fmt(h.price,...)` pattern, same gap.
- **"Import from Library" picker** (`index.html:6937`, `openPicker()`): `fmt(li.price,li.cur)` in the picker's per-item subtitle line — a fifth `fmt()` site rendering `li.price` directly, missed in an earlier draft's count of four (requirements-gate round 1).
- **Invoice PDF line-item table** (`index.html:8498`, `prevInvDoc()`, not "Quote" as an earlier draft mislabeled it — requirements-gate round 1): `fn(li.up)`. `fn(n,d)` (`index.html:3896`) is `(+n).toFixed(d||2)` — it already renders real decimals (unlike `fmt()`), but defaults to 2 when no `d` is passed (or when `d` is passed as the falsy literal `0` — see the two version-history sites below), so a stored 3rd decimal would still round away silently unless these calls pass `d=3` explicitly.
- **PO PDF line-item table** (`index.html:8637`, `prevPODoc()` — split out as its own render path, requirements-gate round 3, having previously been bundled into one bullet with the Invoice PDF site above despite being a separate function producing a separate document): `fn(li.cost)`, same gap.
- **Quote PDF line-item table** (`index.html:12758`, `prevQteDoc()`, independently found — requirements-gate round 1, an earlier draft missed this entirely and mislabeled the Invoice site above as the "Quote" site instead): `fn(l.cost,0)`. Because `fn()`'s own `d=d||2` treats the literal `0` argument as falsy, this line actually renders at 2 decimals today, not 0 — but still truncates a stored 3rd decimal the same way the other `fn()` sites do.
- **Quote line version-history panel** (`index.html:12123`, `renderQteLineHistory()`, independently found — requirements-gate round 2): `fn(v.cost,0)` — the same falsy-zero pattern as the Quote PDF site above, reading a Quote line's own saved-version cost (`cQL[].priceHistory[].cost`, the same `{cost,dutyPct,markup,landed,sellPrice,note}` version-snapshot shape saved at `index.html:12255-12264`) — a second, independent render of this version data the Quote PDF fix does not reach. (This panel's other columns — `dutyPct`, `markup`, `landed`, `sellPrice` — are derived quote-calculation figures, not a Line Item's own cost/price, and are correctly left at their existing precision.)
- **Supplier Price History table** (`index.html:5468`, `renderSupPriceHistory()`, independently found — requirements-gate round 1): `fn(p.price,2)`, hardcoded to 2 decimals. This table's rows are sourced from three places, not two as an earlier draft said (requirements-gate round 2): the exact same `li.priceHistory[].cost` data as the price-history sub-table above, separate Quote-line price points, and PO line-item cost points (`getSupplierPriceHistory()`, `index.html:5387-5417`, drawing from `DB.li[].priceHistory[]` at `5391`, Quote lines at `5401`, and `DB.po[].lineItems[].cost` at `5410-5416`) — a further, independent rendering of price-history-shaped data that neither the price-history sub-table's nor the Quote line version-history panel's own fix reaches.

Nothing else needs a display change: `liMgn()`'s margin calculation and `fp()`'s percentage display (`index.html:6598-6603,3897`) operate on the raw numeric values already (not on a rounded display string), so margin accuracy actually *improves* once the 3rd decimal is captured at all — no code change needed there.

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

### REQ-LI-001-d — Display: Line Items Library table, price-history sub-table, and Library picker
Add a small decimal-aware currency formatter for use at these five call sites only (not a change to `fmt()` itself, which stays at its existing `maximumFractionDigits:0` behavior for its other 87 call sites — corrected per requirements-gate round 1, which found a fifth site an earlier draft missed):
```js
function fmtN(n, c, d) { d = d==null?2:d; if (n===null||isNaN(+n)) return '-'; return (c||'USD') + ' ' + (+n).toFixed(d); }
```
Use `fmtN(li.cost, li.cur, 3)` / `fmtN(li.price, li.cur, 3)` at `index.html:6584-6585` (main table), `fmtN(h.cost, li.cur, 3)` / `fmtN(h.price, li.cur, 3)` at `index.html:6575-6576` (price-history sub-table), and `fmtN(li.price, li.cur, 3)` at `index.html:6937` (`openPicker()`'s per-item subtitle) — replacing the five existing `fmt(...)` calls at those exact sites. `toFixed(3)` always shows exactly 3 digits (e.g. `$12.500`) rather than trimming trailing zeros — accepted as correct: consistent fixed-width columns are preferable to variable-width ones in a data table, and this matches the fixed-2-decimal convention `fn()` already uses elsewhere in the app.

### REQ-LI-001-e — Display: Invoice/PO/Quote PDF line-item tables, Quote line version history, and Supplier Price History
At `index.html:8498` (`prevInvDoc()`) and `8637` (`prevPODoc()`), change `fn(li.up)` → `fn(li.up,3)` and `fn(li.cost)` → `fn(li.cost,3)` so a stored 3rd decimal is shown rather than silently rounded to 2 (corrected per requirements-gate round 1 — an earlier draft mislabeled `8498` as a Quote render site; it is Invoice). At `index.html:12758` (`prevQteDoc()`, the actual Quote PDF, independently found — requirements-gate round 1), change `fn(l.cost,0)` → `fn(l.cost,3)`. At `index.html:12123` (`renderQteLineHistory()`, independently found — requirements-gate round 2), change `fn(v.cost,0)` → `fn(v.cost,3)`. At `index.html:5468` (`renderSupPriceHistory()`, independently found — requirements-gate round 1), change the hardcoded `fn(p.price,2)` → `fn(p.price,3)`.

---

## 3. Out of scope

- Any change to `RX.currency` itself, or to any of the other 11 fields that share it (Invoice/PO deposits and charges, buyer/supplier payment amounts) — these keep today's 2-decimal cap exactly as-is.
- Any change to `fmt()`'s own behavior or its other 87 call sites (invoice/PO/payment totals, statements, dashboards, exports) — these continue to render whole-currency-unit amounts exactly as today.
- Quote-level or PO-level totals/grand-totals precision — only the per-unit `cost`/`price` fields themselves gain a 3rd decimal; roll-up totals (`calc_grandTotal`, `liT`, etc.) are computed from the more-precise raw values automatically and displayed via their existing (unchanged) formatters, so a total like `$1,234.5678` still displays as `$1,235` via `fmt()`, matching today's whole-currency-unit convention for totals.
- CSV/JSON exports and AI-tool (`_aiExecTool`) read paths for Line Item cost/price — these were not found to apply any additional rounding (they either omit unit cost/price entirely or pass the raw stored value straight through, unlike a PDF template's own hardcoded-decimal render calls, which REQ-LI-001-e already covers), so no further site needs a code change there. (If a gate review finds one, it will be added here.)
- Any new decimal-precision option/setting (e.g. per-supplier or per-currency-configurable decimal counts) — 3 decimals fixed is sufficient for the stated need (sub-cent visibility on high-volume, low-unit-price items); this is not a general-purpose arbitrary-precision feature.
- The dead, unwired `vBlurCurrencyPos()` helper (`index.html:8824-8830`) — confirmed unused by any field, left untouched.

---

## 4. Acceptance criteria

- **AC-1**: A Line Item can be saved with a `cost` or `price` value carrying up to 3 decimal places (e.g. `0.125`); a 4th decimal digit is still rejected with a clear inline error, both on blur and on submit.
- **AC-2**: Every other money field in the app — Invoice buyer deposit and 5 charge fields, PO supplier deposit, FPM funded amount, and other charges (`pf-oth`, corrected per requirements-gate round 1 — an earlier draft's AC-2 omitted it, the one field among the 11 with no dedicated submit-time `RX.currency` check outside `vBlurCurrency()`'s shared wiring), buyer payment amount, supplier payment amount — still rejects a 3rd decimal digit exactly as today — verified by an explicit regression test per field (all 11), not just by code inspection.
- **AC-3**: The Line Items Library main table, its price-history sub-table, and the "Import from Library" picker (`openPicker()`, `index.html:6937`, independently found — requirements-gate round 1) all display Line Item cost/price to 3 decimal places.
- **AC-4**: Invoice, PO, and Quote PDF line-item tables (`prevInvDoc()`, `prevPODoc()`, `prevQteDoc()`), the Quote line version-history panel (`renderQteLineHistory()`, independently found — requirements-gate round 2), and the Supplier Price History table (`renderSupPriceHistory()`, independently found — requirements-gate round 1) all display a Line Item's unit cost/price to 3 decimal places when the underlying value carries one (e.g. `0.125` displays as `0.125`, not `0.13` or `0.12`) — 5 sites in total.
- **AC-5**: Margin calculation (`liMgn()`, `index.html:6598-6603` — corrected citation, requirements-gate round 1) and its percentage display are unaffected in code (no change made), and are confirmed by test to reflect the added precision correctly (a 3-decimal cost/price pair produces a materially different, more accurate margin percentage than the same values rounded to 2 decimals).
- **AC-6**: The `lf-c`/`lf-p` input spinner step matches the new precision (`step="0.001"`).
- **AC-7**: No other numeric field's validation, display, or input step attribute changes as a result of this REQ (regression-checked against §1.1's full 10-site table and §1.2/§1.3's other fields).

---

## 5. Testing approach

Following this codebase's established pattern (`tests/run.js`): add explicit new tests for AC-1 (3-decimal accept, 4-decimal reject, both `lf-c` and `lf-p`) and AC-2 (one regression test per each of the other 11 shared-`RX.currency` fields, including `pf-oth`, confirming each still rejects a 3-decimal value) — the AC-2 tests are the ones that actually prove `RX.currency` itself was left untouched, not just an inspection claim. Add a display-formatting test per AC-3/AC-4 site (5 in AC-3, 5 in AC-4 — corrected per requirements-gate round 2, which found this figure stale at "4 and 4") asserting the exact rendered string for a known 3-decimal cost/price value. Full existing suite must remain green (currently 712/712 per the last shipped REQ).

## 6. Gate process

Standard pipeline: this REQ → independent requirements-gate review → SPEC-LI-001 (exact diffs) → independent spec-gate review (applies diffs to a scratch copy, runs the real suite) → implementation → mutation testing (revert each of REQ-LI-001-a/b's guard changes individually, confirm the predicted single test failure, restore) → independent build-gate review → PR → CI green → merge.

## 7. Tracker updates (post-ship)

- `docs/requirements-tracker.md`: new row for `REQ-LI-001`.
- `docs/version-history.md` / `STACKD_CONTEXT.md` / `CLAUDE.md`: version bump entry.
- No `docs/known-gaps.md` entry expected — this REQ closes a precision limitation, it does not knowingly leave a new gap open (barring a gate review finding otherwise, per §3's PDF/export caveat).

## 8. Review-resolution log

**Round 1: CONDITIONAL PASS — 3 blocking, 2 advisory, all fixed in place.** The core validation-layer analysis (§1.1, REQ-LI-001-a/b/c: `RX.currency`'s definition/regex, all 10 call sites, `vBlurCurrency()`'s body/wiring, `fmt()`/`fn()`'s definitions, the `lf-c`/`lf-p` `step` attribute) was independently verified accurate on first pass. The gaps were in an initial draft's display-site inventory (§1.2) and its own internal arithmetic.

Blocking:
- **Mislabeled and incomplete display-site inventory.** An earlier draft's REQ-LI-001-e cited `index.html:8498` as a "Quote" render site; it is actually `prevInvDoc()` (Invoice). The real Quote PDF, `prevQteDoc()` (`index.html:12758`), renders `fn(l.cost,0)` — untouched by that draft and still truncating to 2 decimals (`fn()`'s `d=d||2` treats the literal `0` as falsy) — which would have left AC-4's "Quote... tables display to 3 decimal places" claim false. Fixed by correcting the label on `8498`/`8637` (Invoice/PO respectively) and adding `12758` as its own site.
- **§3's blanket "no other display path needs a change" claim was false.** `renderSupPriceHistory()` (`index.html:5468`) independently renders the same `li.priceHistory[].cost` data as the price-history sub-table via a hardcoded `fn(p.price,2)`, entirely unaddressed by the original four-site plan. Fixed by adding it as a fifth REQ-LI-001-e site.
- **Internal field-count inconsistency created an untested field.** §3/§5 both claimed "8 other fields" share `RX.currency`; the real count is 11 (`if-dep`,`if-lf`,`if-ins`,`if-leg`,`if-isp`,`if-oth`,`pf-dep`,`pf-fpm`,`pf-oth`,`pm-amount`,`spm-amount`). Because AC-2's test list was built from the wrong count, it omitted `pf-oth` specifically — the one field with no dedicated submit-time `RX.currency` check outside the shared `vBlurCurrency()` wiring, so it would have shipped with no explicit regression test proving it still rejects a 3rd decimal. Fixed by correcting the count everywhere (§1.1, §3, §5) and adding `pf-oth` to AC-2.

Advisory:
- A fifth `fmt(li.price,...)` site, `openPicker()`'s per-item subtitle (`index.html:6937`), was missed by REQ-LI-001-d's "four call sites only" claim — added as a fifth site, with `fmt()`'s "other N call sites" count corrected from 88 to 87 throughout.
- AC-5 cited `liMgn()` at `index.html:6561`; the real function is at `6598-6603` (`6561` is a separate, inline margin calculation inside `rLI()` with the same raw-value property) — citation corrected.

Ready for SPEC, pending independent re-verification in a future round if one is dispatched.

**Round 2: CONDITIONAL PASS — 2 blocking, fixed in place.** Every fix from round 1 was independently re-verified against the live code — line numbers, function names, the `fn()` falsy-zero behavior, the field count of 11, and both advisory citation corrections all confirmed exactly accurate. No regressions from round 1's own changes.

Blocking:
- **A seventh display-truncation site, independently found.** `renderQteLineHistory()` (`index.html:12123`) renders a Quote line's saved-version cost via the identical falsy-zero pattern round 1 caught at `prevQteDoc()` (`fn(v.cost,0)`, rendering at 2 decimals despite the literal `0`) — reading the same version-snapshot shape (`cQL[].priceHistory[]`) as the Quote PDF site, but a wholly separate render path the round-1 fix didn't reach. Fixed by adding it as a fifth `fn()` site in REQ-LI-001-e/AC-4. Also corrected `renderSupPriceHistory()`'s data-lineage description (§1.2), which round 1 said drew from two sources (Line Item + Quote-line price history) but actually draws from three (adding `DB.po[].lineItems[].cost`) — doesn't change the required fix, but the earlier characterization was incomplete.
- **Stale site count in §5.** Testing approach said "4 in AC-3, 4 in AC-4," left over from before round 1 added the picker (AC-3's 3rd location) and before round 2 added `renderQteLineHistory()` (AC-4's 5th site) — corrected to 5 and 5, so neither set of tests is silently under-specified.

Ready for SPEC, pending independent re-verification in a future round if one is dispatched.

**Round 3: CONDITIONAL PASS — 1 blocking, fixed in place.** Independently re-verified all 5 REQ-LI-001-e/AC-4 sites byte-accurate against the live file, re-confirmed every count in §1.1/REQ-LI-001-d/e/§3/AC-3/AC-4/§5 self-consistent except the one below, ran a fresh independent hunt (grepping every `.cost`/`.price`/`.up`/`sellPrice` occurrence combined with `fn(`/`fmt(`/`toFixed(`, deliberately using a different method than rounds 1-2) for an 8th display-truncation site and found none — including explicitly checking the Invoice/PO/Quote edit-form line-item tables (`rILT()`, `rPLT()`, `rQLT()`), which bind raw values to `<input>` elements with no truncating formatter at all. Re-verified REQ-LI-001-a/b/c and `renderSupPriceHistory()`'s three-source lineage as accurate.

Blocking:
- **§1.2's "seven render paths" summary undercounted relative to the document's own detailed site list.** One bullet ("Invoice and PO PDF line-item tables") bundled two genuinely distinct render functions/documents (`prevInvDoc()`/`8498` and `prevPODoc()`/`8637`) into a single counted "path," while every other bullet represented exactly one render location — inconsistent with AC-3's "3 locations" + AC-4's "5 sites," which already counted both `8498` and `8637` separately and implicitly total 8, not 7. Fixed by splitting that bullet into two (Invoice PDF, PO PDF) and correcting "seven" to "eight" throughout §1.2/§8, matching the convention used everywhere else in the list.

Ready for SPEC, pending independent re-verification in a future round if one is dispatched.

**Round 4: PASS — no findings.** A full front-to-back read independently re-derived every count in the document (§1.1's 11 fields, §1.2's 8 render paths, REQ-LI-001-d's 5 `fmt()` sites, REQ-LI-001-e's 5 `fn()` sites, §3's 87 unaffected `fmt()` sites, AC-2's 11-field list, AC-3's 3-locations/5-sites, AC-4's 5 sites, §5's 5-and-5 test counts) rather than trusting round 3's arithmetic, and all were confirmed self-consistent and accurate against the live file. A fresh, differently-targeted hunt for a 9th display-truncation site (currency-pair greps, `_aiExecTool()`, CSV export, `prevCNDoc()`/`prevStmtPdf()`, the RFQ-response cost field) found nothing further — the RFQ-response `cost` field was confirmed to be a distinct entity (`ord.lines[].rfqResponses[].cost`) with its own separate validation, correctly outside this REQ's scope. REQ-LI-001-a/b/c were spot-checked once more with no issues. Requirements-gate is complete for this REQ.
