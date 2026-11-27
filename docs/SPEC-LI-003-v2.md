# SPEC-LI-003: Line Item Cost & Margin History modal (reorder decision view)

**Status:** v2 — resubmission after spec-gate round 1 (FAIL: 1 blocking, 9 should-fix, 9 advisory; every finding mapped in §12). Written against `docs/REQ-LI-003-v5.md`, a narrow amendment of the gate-passed v4 made on the operator's rulings (shift baseline skips unusable entries; one tolerance rule; extra CSV column) — those three points need a short requirements-gate confirmation alongside this SPEC's next round.
**Version target:** v2.9.104. **Files touched:** `index.html` (render, helpers, one new overlay, AI prompt, changelog, version strings), `tests/run.js`, docs.
**Schema impact: none.** No new `K` key, no new Line Item or history-entry field, no Supabase migration, no Sheets-sync change, so no `schema-migration-reviewer` pass is needed (REQ §4, §7). Everything is derived on render from each entry's own `cost` and `price`; nothing is stored.
**REQ-gate pre-conditions — all closed:** (1) staleness and the "At cost" test both compare integer thousandths (§3.4, §3.6); (2) AC-21's fifth case has live values (T-21e/f); (3) one AC-32 test per entry position (T-32a/b, exact strings); (4) a negative AC for no-history items (T-1c).
**Data flow / GDPR:** no new stored fields, no personal data, no external transmission; the per-item CSV is a local `data:` download (REQ §6) — nothing to add.
Citations were measured at the current commit and checked with `node scripts/check-req-citations.js`.

---

## 1. Summary of changes

| # | Change | Where |
|---|---|---|
| 1 | Replace the inline expandable history row with a read-only **modal** | `rLI()` badge/phRow (`index.html:8152-8170`), `togglePH()` (`8184`), new overlay `#ov-lih` |
| 2 | New pure helper layer that builds a history **model** from a Line Item | new functions after `togglePH` position (§3) |
| 3 | New render function for the modal (header, range summary, staleness notice, timeline, trend, health badge, order-entry section) | §5 |
| 4 | New per-item CSV export through `csvRow()` | §6 |
| 5 | Documentation: `AI_SYSTEM_PROMPT` corrections + new passage, user guide, changelog, version strings | §8 |
| 6 | Tests | §9 |

Unchanged (confirmed, not just asserted): `saveLI()`, `saveInv()`'s history auto-recording (`index.html:8938-8942`), `getSupplierPriceHistory()` (`6190`), `expPriceHistoryCSV()` and the toolbar "Price History CSV" button (`13545`, `302`), Cloud Data `refreshLIFromSupabase()`/`migrateLineItemsToSupabase()`, `FIELD_MAPS` (`5138`), both Line Item import paths (`LI-GAP-007`, separate REQ).

---

## 2. Entry point (REQ §3.1)

### 2.1 `rLI()` changes
In the row builder (`index.html:8124` onward):

- The badge keeps its position and look; `onclick` changes from `togglePH('<id>')` to `openLIHist('<id>')`, and its `title` from "Show price history" to "Show cost & margin history". The `N pt(s)` label is unchanged. `li.id` is interpolated into the `onclick` exactly as today (DATA-GAP-004 is pre-existing and unchanged).
- **Delete** the `phRow` variable (`var phRow`, whose `<tr id="ph-<id>">` block spans `8155-8170`) and the trailing `+ phRow` in the returned row string. Nothing else references `ph-<id>` (grep-verified: only `rLI()` and `togglePH()` itself).
- **Delete** `togglePH()` (`8184-8187`). Grep-verified: no other code and no test references the *name*. **But two existing tests depend on the inline row's content** (spec-gate finding 1): `tests/run.js:14670-14676` ("AC-3: price-history sub-table shows 3-decimal cost") and `14678-14684` ("…shows 3-decimal price") assert `li-tb` contains `USD 0.125`, a value present only in the inline history row (the fixtures put 0.125 solely in `priceHistory`). Both are **rewritten** to call `ctx.openLIHist('li-d3')` / `('li-d4')` and assert `mockEl('lih-body').innerHTML` contains `USD 0.125`; their test names change to "…history modal shows 3-decimal cost/price". The first AC-3 test at `14660-14668` (main-table price column) is unaffected. Both rewrites are counted in the suite delta (REQ AC-29).
- A Line Item with an empty/absent `priceHistory` still renders no badge (`ph.length` falsy) — **unchanged**, which is REQ §3.1's no-history rule. `openLIHist()` is defensive (§2.2) but the badge never routes there.
- The `li-tb` main table is otherwise unchanged (the `colspan="12"` supplier-group header rows stay as they are).

### 2.2 `openLIHist(id)`
```js
var _lihId = null;   // module-level: id of the Line Item currently shown in #ov-lih (CSV button reads it)
function openLIHist(id) {
  var li = DB.li.find(function(x){ return x.id === id; });
  if (!li) return;
  if (!(li.priceHistory && li.priceHistory.length)) return;  // defensive: no history → no modal
  _lihId = id;
  rLIHist(li);
  G('ov-lih').classList.add('on');
}
```
Close uses the existing `closeM('ov-lih')` (`index.html:5549`); no `closeM` change is needed. `_lihId` and the `on` class on `#ov-lih` are session-scoped UI state, not part of `DB`; `resetDB()` clears neither, and the mock `classList` persists across tests (`mockElements` is module-level, tests/run.js:26-37). **Every test group in §9 therefore begins with `ctx._lihId = null; ctx.closeM('ov-lih');`** (spec-gate finding 8), or a later test asserting "`ov-lih` does not have `on`" (T-1c) would inherit an open state from T-1b.

**Read-only guarantee (AC-19):** none of `openLIHist`, `rLIHist`, `liHistModel`, `liHistCsv` or any helper below calls `sv()`, `saveAll()`, `logEv()`, a Supabase client, or mutates `li`, `li.priceHistory`, an entry or `DB.*`. `liHistModel()` works on copies (`slice()`/new objects); `Array.prototype.sort` is applied only to those copies, never to `li.priceHistory`.

### 2.3 New overlay markup
Add one overlay in the static HTML immediately before `<!-- PICKER MODAL -->` (`index.html:2719`) — it is opened only from the Line Items tab, never from inside another modal, so there is no overlay stacking hazard (cf. REQ-QTE-004 §REQ-QTE4-002, which concerns a quote-modal-launched picker):
```html
<div class="ov" id="ov-lih" onclick="if(event.target===this)closeM('ov-lih')">
  <div class="modal" style="max-width:760px;">
    <div class="mh"><h2 id="lih-title">Cost &amp; Margin History</h2><button class="mx" onclick="closeM('ov-lih')">&#215;</button></div>
    <div class="mb">
      <div id="lih-sub" style="font-size:.56rem;color:var(--m);margin-bottom:10px;"></div>
      <div id="lih-body"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button class="btn btn-g" onclick="liHistCsv()">Export as CSV</button>
        <button class="btn btn-s" onclick="closeM('ov-lih')">Close</button>
      </div>
    </div>
  </div>
</div>
```

---

## 3. Pure helper layer (REQ §3.4, §3.5a)

All helpers are plain functions placed together immediately after `liMgn()` (`index.html:8189`). They take data and return data; none touches the DOM, `DB` mutation or storage.

```js
// Finite positive number or null. cost ≤ 0, blank, NaN, non-numeric → null ("no value recorded").
function liHistPos(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = +v;
  return (isFinite(n) && n > 0) ? n : null;
}
// REQ §3.4: order entry ⇔ invoiceRef is non-null and non-blank after trim. A non-string non-null value
// (e.g. a number) is coerced and therefore classed as an ORDER entry — conservative, so an invoice-sourced
// entry can never leak into catalogue maths. Absent key / null / '' / whitespace → catalogue entry.
function liHistIsOrder(h) {
  var r = h ? h.invoiceRef : null;
  return r !== null && r !== undefined && String(r).trim() !== '';
}
// Margin % on price; null unless BOTH cost and price are usable (cost ≤ 0 means "not entered", so a 100% margin would mislead).
function liHistMargin(cost, price) {
  var c = liHistPos(cost), p = liHistPos(price);
  return (c !== null && p !== null) ? (p - c) / p * 100 : null;
}
// Integer thousandths — the same 0.001 tolerance saveInv() uses (index.html:8938), compared on integers so the
// boundary is float-safe for exact-thousandth differences (10.001 vs 10 → 10001 vs 10000 → differs; raw subtraction
// gives 0.00099999…). Used by BOTH the staleness check (§3.4) and the "At cost" test (§3.6) — one rule for the modal.
function liHistMilli(v) { return Math.round((+v || 0) * 1000); }
```

### 3.1 Splitting and ordering (REQ §3.4)
```js
// Returns {cat:[…], ord:[…]} of {h, i} wrappers (i = original array position), each sorted ascending by
// date string then i. Works on a copy; li.priceHistory is never reordered.
function liHistSplit(li) {
  var all = (li.priceHistory || []).map(function(h, i){ return { h: h, i: i }; });
  function key(w){ return String((w.h && w.h.date) || ''); }
  function cmp(a, b){ var ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : a.i - b.i; }
  return {
    cat: all.filter(function(w){ return w.h && !liHistIsOrder(w.h); }).sort(cmp),
    ord: all.filter(function(w){ return w.h &&  liHistIsOrder(w.h); }).sort(cmp)
  };
}
```
- Dates are the strings the app writes (`today()` / `inv.date`, ISO `YYYY-MM-DD`), so string comparison is date comparison. A missing/blank date sorts **first**. `null`/non-object entries in the array are skipped (defensive; none is written today).
- Same-day edits (normal — `today()`) keep array order via the `i` tie-break (AC-6). The explicit tie-break does not rely on `Array.prototype.sort` stability.

### 3.2 Shift calculation (REQ §3.5, §3.5a v5, AC-4, AC-9, AC-10)
```js
// The "previous" baseline for a field = the nearest EARLIER catalogue entry with a usable value for that same field.
// rows are the §3.1-ordered catalogue wrappers {h,i}. kind: 'cost' | 'price' | 'margin'.
function liHistBase(rows, k, kind) {
  for (var j = k - 1; j >= 0; j--) {
    var v = (kind === 'cost')  ? liHistPos(rows[j].h.cost)
          : (kind === 'price') ? liHistPos(rows[j].h.price)
          :                      liHistMargin(rows[j].h.cost, rows[j].h.price);
    if (v !== null) return v;
  }
  return null;
}
// Shift of `cur` against `base`; null when either is unusable (→ rendered `–`, no badge).
// 'amt' (cost/price): {abs, pct}, pct always finite because base > 0. 'pp' (margin): {abs, pct:null}.
function liHistShift(base, cur, kind) {
  if (base === null || cur === null) return null;
  return { abs: cur - base, pct: (kind === 'pp') ? null : (cur - base) / base * 100 };
}
```
- Cost/price: if the entry's own value is unusable, or no earlier entry has a usable value, **no shift** (AC-9; AC-10 sequences `10, 0, 12` → 12 vs 10 `↑ 2.000 (+20.0%)`; `0, 12` → no shift on 12). The percent is therefore never `n/a` for cost/price (base is always `> 0`); the `(n/a)` percent string of v1 is gone.
- Margin shift is in **percentage points** only; both the entry's margin and a nearest-earlier defined margin must exist.
- Order entries never participate (AC-5). Open point 1 of the v1 SPEC is **resolved** by the operator's ruling (REQ v5 §3.5a).

### 3.3 The model — contract
`liHistModel(li)` returns exactly this shape (every key always present; absent values are `null`/`[]`/`false`, never `undefined`):
```js
{
  li: li, cur: String(li.cur || 'USD'),               // display currency code (san()'d when rendered)
  price: liHistPos(li.price),                          // today's sell price or null  → margins n/a (AC-3)
  rows:   [ {h, i, costOK, priceOK, margin, dCost, dPrice, dMargin} … ],   // catalogue entries, oldest → newest
  usable: [ …the rows with costOK !== null… ],        // "usable catalogue entry" = usable cost
  order:  [ {h, i, inv, invCur, priceTxt, margin, marginTxt} … ],          // order entries, oldest → newest (§3.7)
  noCat: sp.cat.length === 0,
  single: usable.length === 1,                         // exactly one usable catalogue entry
  lowest: row|null, highest: row|null, latest: row|null,   // §3.4 ({…row, mAtToday}) over `usable`
  collapsed: usable.length >= 1 && every usable cost equal,
  current: { cost: liHistPos(li.cost), mAtToday: …|null, atCost: bool },
  trend: usable.length >= 2 ? { cost: number|null, price: number|null, margin: number|null } : null,   // §3.5
  stale: bool,                                         // §3.4
  lastPriceChange: sp.cat.length ? (newest cat entry's date || null) : null,
  lastCharged: { num, priceTxt } | null                // §3.7
}
```
Row fields: `costOK`/`priceOK` = `liHistPos(h.cost/price)`; `margin = liHistMargin(h.cost, h.price)`; `dCost = liHistShift(liHistBase(rows,k,'cost'), costOK, 'amt')`, `dPrice` likewise with `'price'`; `dMargin = liHistShift(liHistBase(rows,k,'margin'), margin, 'pp')`. The rows array must be built first (bases read earlier raw entries from `sp.cat`, not from the row objects being built).

### 3.4 Range summary, staleness, at-cost
Over `usable`:
- `lowest` = the entry with the minimum `costOK`; `highest` = the maximum; `latest` = the last element of `usable` (newest in §3.1 order). **Ties:** the most recent entry among equal costs is reported.
- Each carries `mAtToday = price !== null ? (price − costOK)/price × 100 : null` — the margin **at today's sell price `li.price`** (REQ §3.3). `current.mAtToday` uses `li.cost` the same way (`null` when `li.cost` is not usable).
- `collapsed` → one row "Lowest = Highest = Latest".
- **Staleness** uses the newest catalogue entry **regardless of usability**, each field compared only when that entry's own value is usable (so an unusable latest cost skips the cost comparison, AC-21e):
```js
function liHistStale(li, newest) {              // newest = sp.cat[last] or null
  if (!newest) return false;                      // no catalogue entry → nothing to compare (AC-20)
  var h = newest.h;
  return (liHistPos(h.cost)  !== null && Math.abs(liHistMilli(li.cost)  - liHistMilli(h.cost))  >= 1)
      || (liHistPos(h.price) !== null && Math.abs(liHistMilli(li.price) - liHistMilli(h.price)) >= 1);
}
```
Rounding to a thousandth first is what REQ §3.3 specifies. `Math.round` half-up on a binary float is **not** exact at a half-thousandth (e.g. a value like 10.0005 may round either way); this is accepted — the guarantee is only that exact-thousandth differences such as 10.001 vs 10 are detected (they are, where raw subtraction `0.00099999…` would miss them — T-21g).
- Notice text, verbatim: "The catalogue cost/price has changed since the last history entry (for example by a Sheets pull or an import) — history may be incomplete."

### 3.5 Trend (REQ §3.6, AC-7, AC-32)
Defined only when `usable.length >= 2`; `first = usable[0]`, `last = usable[usable.length-1]`:
- `cost` = `(last.costOK − first.costOK)/first.costOK × 100`.
- `price` = `(last.priceOK − first.priceOK)/first.priceOK × 100`, `null` (rendered `n/a`) if either `priceOK` is `null`. **AC-32 mechanism:** a zero/unusable price on the first usable entry, or on the last, nulls only this part.
- `margin` = `last.margin − first.margin` (pp), `null` if either margin is `null`.
Hidden (`trend: null`) when `usable.length < 2`. Rendered `Cost ↑ 8.5% | Price ↑ 3.2% | Margin ↓ 4.1 pp`; each part `n/a` when `null`; `↑`/`↓` by sign, `→` when exactly 0.

### 3.6 Health band and "At cost"
For the header summary (today's `li.cost`/`li.price`): **"At cost" first** — both usable and `liHistMilli(cost) === liHistMilli(price)` (REQ v5: integer-thousandths equality; 10/10.0004 → at cost, 10.001/10 → not at cost; T-12a/b/c). Otherwise `m >= 20` → **Healthy margin** (class `phi`), `m >= 10` → **Medium margin** (`pmi`), else **Low margin** (`plo`) — the existing pill bands (`index.html:8149-8150`); negative margins show their sign and take `plo` (AC-12). When `li.cost` or `li.price` is unusable, no band is shown (margin `n/a`). The rendered markup uses the pill class **and** the label text; T-11 asserts both (spec-gate finding 9).

### 3.7 Order entries (REQ §3.4, AC-14, AC-22, AC-30, AC-31)
For each `sp.ord` wrapper `{h,i}`:
- **Invoice lookup:** `DB.inv.filter(function(x){ return x.num === h.invoiceRef; })[0]` — first match wins (AC-31); none ⇒ not found.
- `invCur = inv ? String(inv.cur || 'USD').trim().toUpperCase() : null`; `lineCur = String(li.cur || 'USD').trim().toUpperCase()`.
- **`priceTxt` (NaN-safe, spec-gate finding 6):** `var pn = liHistPos(h.price)`; if `pn === null` → the literal `–`; else found → `fmtN(pn, invCur, 3)`; not found → `pn.toFixed(3) + ' currency unknown'` (never silently labelled with the Line Item currency, never `NaN`).
- **Margin:** computed only when `inv` is found **and** `invCur === lineCur` → `margin = liHistMargin(h.cost, h.price)`, `marginTxt = fp(margin)` or `n/a` when `null`; otherwise `marginTxt = 'n/a (different or unknown currency)'`.
- Order entries carry no shift badges and appear in no range/trend/last-price-change calculation.
- **Last charged on:** among order wrappers with a found invoice and `invCur === lineCur` and a usable price, the **last in §3.1 order** → `Last charged on <inv.num> at <fmtN(price, lineCur, 3)>`; `null` when none qualifies (AC-30).
- **Date ordering assumption (advisory 14):** §3.1 compares `String(h.date)` lexicographically, which equals date order for the ISO `YYYY-MM-DD` strings the app writes (`today()`; `inv.date` from the invoice form). A non-ISO `inv.date` from a CSV import sorts by its string; this is accepted and noted in the user guide, not normalised here.

## 4. Rendering (`rLIHist(li)`)

`rLIHist` builds one HTML string from `liHistModel(li)` and sets `G('lih-title')`, `G('lih-sub')`, `G('lih-body')`. Every free-text value goes through `san()` (SKU, description, supplier name, notes, invoice reference, currency codes) — AC-16. Numbers go through the existing `fmtN(value, cur, 3)` / `fp()` formatters.

### 4.1 Header (REQ §3.2, AC-17)
- `lih-title`: `Cost & Margin History — <SKU> <Description>` (` <SKU>` omitted when `li.sku` is blank).
- `lih-sub`: supplier + currency. Supplier text: `li.supId` blank → `No supplier`; `DB.sup` has no record with that id → `Unknown supplier`; else the supplier name. Then `· Currency <cur>`.
- Below the sub line (inside `lih-body`): **Last price change: <date>** = the date of the newest catalogue entry (`sp.cat` last element's `date`, `–` when blank), omitted when there are no catalogue entries. No actor is shown (REQ §8).

### 4.2 Body order and state table
`lih-title` and `lih-sub` are written with `innerHTML` from `san()`-wrapped values (not `textContent`) so T-16/T-17 assertions on `&lt;img` hold. The body is assembled in this order; the **state** decides which blocks appear (spec-gate finding 3):

| State | Condition | Blocks shown |
|---|---|---|
| **S-normal** | `usable.length >= 2` | Stale notice (if stale) · Lowest/Highest/Latest (or collapsed row) · Current row · Last charged (if any) · Trend · Timeline · Order section (if any) |
| **S-one** | `usable.length === 1` | Stale notice · the single collapsed range row · Current row · Last charged · message "Only one price on record — no trend yet" · Timeline · Order section |
| **S-unusable** | `sp.cat.length >= 1` and `usable.length === 0` | Stale notice (price comparison only, §3.4) · message "No usable cost recorded in the catalogue history" · **Current row** · Last charged · Timeline (all costs `–`) · Order section · **no** range, trend or "Only one" message |
| **S-noCat** | `sp.cat.length === 0` (`ord` non-empty — the only way the modal opens) | message "No catalogue price history — only prices charged on orders are recorded" · **Current row** · Last charged · Order section · no Lowest/Highest/Latest, Last price change, Timeline or trend (AC-20) |

The **Current catalogue cost** row is shown in every state (REQ §3.3 "always-present"): `fmtN(li.cost, cur, 3)` or `–`, margin `fp()` or `n/a`, with the §3.6 band. **Last price change** appears in the header area when `sp.cat.length >= 1`.

Block details:
- **Stale notice:** amber box, §3.4 text, first in the body.
- **Range rows:** `<fmtN cost> · <date> · margin at today's price <fp()|n/a>`.
- **Timeline table** (newest first): `Date · Unit Cost · Unit Price · Margin % · Notes`, wrapped in `<div style="max-height:260px;overflow-y:auto;"><table>…</table></div>` (the wrapper carries the scroll, spec-gate advisory 18; no entry cap). Beside Cost and Price the shift: `↑ USD 2.000 (+20.0%)` / `↓ USD 1.200 (-9.1%)` — arrow, `fmtN(Math.abs(abs), cur, 3)`, then `(` + signed one-decimal percent + `%)`; an exactly-zero change renders `no change` (muted, no arrow). Green (`#1a7a4a`) for increases, `var(--cr)` for decreases. **Sign rule:** the percent keeps an explicit leading `+` for increases (`+20.0%`) and `-` for decreases. Margin shift `↑ 2.3 pp` / `↓ 2.3 pp`. Each badge has a `title` in words (`san()`'d), e.g. "Cost increased USD 2.000 (+20.0%) from the previous recorded cost". Unusable cost → `–`; unusable price → `–` with margin `n/a`; the oldest entry, or one with no usable baseline, shows no badge.
- **Order section** ("Prices charged that differed from the catalogue", newest first): `Date · Invoice · Price charged · Margin` from §3.7. There is **no notes column** (so no notes escaping is needed there); `Invoice` and the currency text are `san()`'d.

### 4.3 Colours/tokens
Use existing CSS variables only (`--cr` red, `--m` muted, `--bl`, `--ln`, `--card`); the existing green used in `rLI()` (`#1a7a4a`) for increases. No new CSS rules are added to the stylesheet; inline styles only (matches the old inline row).

---

## 5. Per-item CSV (`liHistCsv()`, REQ §3.8 v5, AC-18)

```js
function liHistCsv() {
  var li = DB.li.find(function(x){ return x.id === _lihId; });
  if (!li) return;
  var m = liHistModel(li);
  var shiftTxt = function(sh, unit) {            // '' when no shift; arrow-led text otherwise (never a leading +/-)
    if (!sh) return '';
    var arrow = sh.abs > 0 ? '↑' : sh.abs < 0 ? '↓' : '→';
    var amt = unit === 'pp' ? Math.abs(sh.abs).toFixed(1) + ' pp' : Math.abs(sh.abs).toFixed(3);
    var pct = sh.pct === null ? '' : ' (' + (sh.pct > 0 ? '+' : '') + sh.pct.toFixed(1) + '%)';
    return arrow + ' ' + amt + pct;
  };
  var h = ['Date','Type','Unit Cost','Unit Price','Margin %','Cost shift','Price shift','Margin shift (pp)','Invoice Ref','Notes','Price Currency'];
  var rows = m.rows.map(function(r){ return [ r.h.date || '', 'catalogue',
      r.costOK === null ? '' : r.costOK.toFixed(3), r.priceOK === null ? '' : r.priceOK.toFixed(3),
      r.margin === null ? '' : r.margin.toFixed(1),
      shiftTxt(r.dCost), shiftTxt(r.dPrice), shiftTxt(r.dMargin, 'pp'),
      '', r.h.notes || '', m.cur ]; })
    .concat(m.order.map(function(o){ return [ o.h.date || '', 'order',
      (liHistPos(o.h.cost)  === null ? '' : liHistPos(o.h.cost).toFixed(3)),
      (liHistPos(o.h.price) === null ? '' : liHistPos(o.h.price).toFixed(3)),
      o.margin === null ? '' : o.margin.toFixed(1),
      '', '', '', String(o.h.invoiceRef), o.h.notes || '', o.invCur || 'unknown' ]; }));
  var safeName = String(li.sku || li.desc || li.id).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || String(li.id);
  dlText('Stackd-LineItemHistory-' + safeName + '-' + today() + '.csv',
         '\uFEFF' + [csvRow(h)].concat(rows.map(csvRow)).join('\n'), 'text/csv');
  toast('Cost history exported');
}
```
(Order rows use the same usable-or-blank discipline as catalogue rows for the two numeric cells; `o.margin` is the §3.7 currency-gated value, `null` when n/a.)
- **Written through `csvRow()`** (`index.html:13587`, which calls `csvSafe()` — SEC-GAP-026 — and quotes commas, double quotes and newlines).
- **BOM (advisory 11, decided):** the content is prefixed with a UTF-8 BOM (`\uFEFF`) so Excel decodes the arrow characters correctly; `dlText()` (`13595`) itself is unchanged and no other export is affected. T-18e asserts the BOM and that the arrow cells round-trip unmangled.
- Numeric cells are plain numbers (3 dp costs/prices, 1 dp margin, empty for unusable/n/a). **Shift text begins with an arrow**, never `+`/`-`, because `csvSafe()` (`13582`) would prefix an apostrophe to `+2.500 (+20.0%)` (T-18d).
- `Type` ∈ `catalogue`/`order`. Order rows: shift columns empty; `Margin %` per the §3.7 currency rule (empty when n/a); `Invoice Ref` set. **`Price Currency`** (REQ v5, operator-approved): catalogue rows `li.cur || 'USD'`; order rows the invoice currency or the literal `unknown`.
- The toolbar "Price History CSV" (`13545`) is untouched and byte-identical (AC-24). No demo filtering is added (REQ §3.8).

---

## 6. Behavioral rules recap (cross-checks to REQ §3.5a)
- Cost `≤ 0`/non-numeric → `–`, excluded from range, shifts and trend; price `≤ 0` → margin `n/a`, excluded from price shift (§3.2).
- A shift is measured against the nearest earlier catalogue entry with a usable value for that field; none → no shift (REQ v5 §3.5a, AC-10).
- Currency edits between entries are not detected (accepted limitation, REQ §9.3) — documented in the user guide.
- Nothing is persisted; opening/closing the modal changes no record (AC-19).

---

## 7. Cloud Data / Sheets / import (no change)
No Cloud Data touchpoint is modified: `priceHistory` already round-trips inside the existing `price_history` jsonb (`refreshLIFromSupabase()` `6442-6449`, `migrateLineItemsToSupabase()` `7056`). The modal reads whatever `DB.li` currently holds, so it works across a Cloud Data refresh, a restored pre-feature backup and an ordinary Sheets pull (`mergePulledWithLocal()` keeps `priceHistory`, `5188-5196`) with no migration step (AC-23). `LI-GAP-007` (import data loss) stays a separate REQ; an item whose history an import erased simply shows fewer or no entries (REQ §3.10).

---

## 8. Documentation and housekeeping (AC-25 to AC-28)

1. **`AI_SYSTEM_PROMPT`** — two existing lines are Quote-line statements wrongly worded as general ones; one new passage covers Line Items. **Exact new strings** (T-25 asserts these substrings; no apostrophes anywhere in them — known harness trap, reworded not escaped):
   - `index.html:12576` becomes: `'Quote line price versioning: each quote line retains its price history. Click the clock icon on a quote line to view previous versions. A new version is created on save only when cost, duty %, insurance % or markup % has changed.'`
   - New passage added immediately after it: `'Line Item cost history: on the Line Items tab, click the N pt badge next to the Unit Price to open a read-only Cost and Margin History modal. History entries are written when a Line Item is created, when its Unit Cost or Unit Price changes on save, and when an invoice is saved at a price different from the catalogue price. The modal shows the lowest, highest and latest cost with the margin at the current sell price, a stale-catalogue notice, a trend line, the prices charged on orders, and an Export as CSV button.'`
   - `index.html:12737` (the troubleshooting bullet — **this** line has no clock-icon wording; the "clock icon" mention is only at 12576) becomes: `'- Quote line price history not showing → versioning only triggers when cost, duty %, insurance % or markup % changes on save'`, followed by a new bullet `'- Line Item history badge missing → that item has no history yet; an entry is written when it is created and whenever its Unit Cost or Unit Price changes on save'`.
   - T-25 asserts presence of the three new strings and absence of the exact old Line-Item-scoped sentence "Click the clock icon on any line to view previous versions"; it does **not** assert absence of "cost, duty %, or markup %" generally (the Quote claim legitimately retains similar wording).
2. **`docs/user-guide.md`**: add a Line Items → "Cost & Margin History" subsection (none exists): how to open it, the range summary, the stale-catalogue notice, catalogue vs order entries, shift baseline (zero-cost entries are skipped), the CSV export (UTF-8 with BOM), the "history is only as complete as the catalogue" caveat, the non-ISO-date note, and the import warning (do not import Line Items over items whose history you want to keep — `LI-GAP-007`).
3. **In-app changelog:** prepend a v2.9.104 block; the **three hardcoded version strings** (`<title>` `index.html:9`, the nav badge button, the `AI_SYSTEM_PROMPT` self-description line) become v2.9.104. **Verification is a build-time manual step**, not a test (spec-gate advisory 12): `grep -n "v2\.9\.103" index.html` must show only the changelog entry, feature-label mentions and the `10454`/`10563` code comments; the result is recorded in the PR description. No automated version-string test exists in `tests/run.js` and none is added.
4. `docs/version-history.md` (new row), `CLAUDE.md` (version, test count), `docs/known-gaps.md` — new gap **`LI-GAP-008`**: `getSupplierPriceHistory()` (`6190`) treats order-entry costs as supplier price points (REQ §7/§9); `LI-GAP-007` is already logged — `STACKD_CONTEXT.md` backlog (mark REQ-LI-003 shipped, add LI-GAP-008), `docs/requirements-tracker.md`, Notion rows (aggregate wording only).
5. Raise the PR from the working branch per the delivery checklist.

---

## 9. Test plan (`tests/run.js`; new section "Line Item cost & margin history (SPEC-LI-003)")

**Harness hazards respected:** `mockElements` is module-level and never cleared (tests/run.js:26-37) — **every group begins with `resetDB(); ctx._lihId = null; ctx.closeM('ov-lih');`** and `mockEl('li-q').value = ''; mockEl('li-sf').value = '';`; assertions read `mockEl('lih-body'|'lih-title'|'lih-sub').innerHTML` set by the code under test. The mock `classList` is a real `makeClassList()` (add/remove/contains), so `mockEl('ov-lih').classList.contains('on')` is assertable. `csvCapture()` (tests/run.js:2378) and the `ctx.sv` wrapping pattern (tests/run.js:5102) are reused for the CSV and read-only tests. Everything is synchronous.

**Fixtures:** `FX-A` = catalogue entries (dates ascending) costs 10, 12, 11, price 20 each, `li.cost` 11, `li.price` 20, cur USD. `FX-ORD` = FX-A plus order entries `invoiceRef 'INV-1'` price 9.5 (cost 11) and `'INV-2'` price 8 with matching `DB.inv` records (`cur` USD / EUR). `FX-NODATE` = same entries stored **out of date order** in the array (used by T-6 and T-19 so the in-place-sort mutation is observable).

| Test | AC | Exact assertion |
|---|---|---|
| T-1a | 1 | `rLI()` HTML contains `openLIHist('l1')`, does **not** contain `togglePH` or `id="ph-l1"`; `typeof ctx.togglePH === 'undefined'` |
| T-1b | 1 | `openLIHist('l1')` → `ov-lih` has class `on`; `lih-title` contains SKU and description |
| T-1c | 1 (neg) | `priceHistory: []` and key-absent items → `rLI()` row contains no `openLIHist`; `openLIHist(id)` called directly leaves `ov-lih` **without** `on` (group reset guarantees a clean start) |
| T-2 | 2 | FX-A → body contains `Lowest`… `10.000` `50.0%`, `Highest` `12.000` `40.0%`, `Latest` `11.000` `45.0%`, Current row `11.000` `45.0%`; no stale-notice text |
| T-3 | 3 | `li.price` `0` and `''` → margins `n/a`; body has no `NaN`/`Infinity` |
| T-4 | 4 | costs 10→12 USD → body contains `↑ USD 2.000 (+20.0%)`; margin shift string contains `pp`; the oldest entry row contains no `↑`/`↓` |
| T-5 | 5 | cost 10, order entry at discounted price, cost 12 → cost-12 shift is `↑ USD 2.000 (+20.0%)`; order entry appears only in the order section; range/trend unchanged by it |
| T-6a/b | 6 | `FX-NODATE` → shifts, trend, range, Last price change follow date order; two same-date entries keep array order |
| T-7 | 7 | trend string equals `Cost ↑ 10.0% | Price → 0.0% | Margin ↓ …` computed numerically for a fixture with known first/latest values |
| T-8 | 8 | one catalogue entry with usable cost → text "Only one price on record — no trend yet" present; no `Trend` line |
| T-9a | 9 | entry cost `0`, `''`, `'abc'`, `null` → cost cell `–`; excluded from Lowest/Highest/Latest; no `NaN` |
| **T-9b** | 9/10 | costs `10, 0, 12` → the 12 row contains `↑ USD 2.000 (+20.0%)` (baseline skips the 0) |
| **T-10a/b/c/d** | 10 | costs `0, 12` → no shift badge on 12; prices `10, 0, 12` → `↑ USD 2.000 (+20.0%)`; prices `0, 12` → no price shift; **margin** across a zero-cost middle entry measured against the nearest earlier defined margin |
| T-11 | 11 | margins 25/15/5 → markup contains class `phi`+`Healthy margin`, `pmi`+`Medium margin`, `plo`+`Low margin` respectively |
| T-12a/b/c | 12 | 10/10.0004 → `At cost` and not `Low margin`; cost 12/price 10 → `-20.0%` and `plo`; **10.001/10 → not "At cost"** (integer thousandths) |
| T-13 | 13 | latest catalogue cost 10, `li.cost` 11 → stale notice text present; Current row `11.000` |
| T-14a/b/c | 14 | invoice found same currency → order margin `fp()`; found different currency → `n/a (different or unknown currency)`; invoice deleted → same text |
| T-15 | 15 | `invoiceRef` `''`, `'   '`, `null`, key absent → catalogue (appear in timeline/shifts); `'INV-1'` and the number `123` → order section only |
| T-16a/b/c | 16 | `<img src=x onerror=1>` in notes (timeline) / `invoiceRef` + `inv.cur` + `title=` hover text (order section and shift badges) / supplier name + SKU + description (header) → each contains `&lt;img`, none contains raw `<img` |
| T-17a/b/c | 17 | blank SKU → title has no double space and no `undefined`; blank `supId` → `No supplier`; deleted supplier id → `Unknown supplier` |
| T-18a–e | 18 | via `csvCapture`: comma/quote/newline note correctly quoted; note starting `=cmd` → `'=cmd`; one row per entry with `Type`; **(d)** shift cells start with `↑`/`↓`, never `'+`; **(e)** content starts with `\uFEFF` and the arrow cells are intact; 11th column `Price Currency` = `USD` on catalogue rows, `EUR` on an EUR-invoice order row, `unknown` for a missing invoice |
| T-19 | 19 | `FX-NODATE` deep-copied; open then close; `ctx.sv`/`saveAll`/`logEv` wrapped with counters → zero calls; every record and `priceHistory` array identical **including original order** |
| T-20 | 20 | no catalogue entries, one order entry → S-noCat: badge present; exact message; Current row + order section present; no Lowest/Highest/Latest/Last price change/trend/timeline; no `NaN` |
| **T-20b** | 3 state S-unusable | catalogue entries all cost `0` (and one with 2 entries but 1 usable → S-one) → exact S-unusable message, Current row present, no range/trend/"Only one" message; the 2-entry/1-usable case shows "Only one price on record" and no trend |
| T-21a–g | 21 | latest entry cost 10/price 20, live `li.cost`/`li.price`: **(a)** 10.0004/20 → no notice; **(b)** 10.01/20 → notice; **(c)** 10/20.01 → notice; **(d)** 10.01/20.01 → notice; **(e)** newest entry cost `0`, price 20, live 5/20 → no notice; **(f)** same entry, live 5/20.01 → notice; **(g)** live 10.001/20 vs entry 10/20 → notice |
| T-22a/b | 22 | order price found → `EUR 9.500`; not found → `9.500 currency unknown`; **(c)** non-numeric order price → `–`, no `NaN` |
| T-23a/b/c | 23 | (a) fixture with no `invoiceRef` key renders; (b) a record round-tripped through the **real** `ctx.mergePulledWithLocal(local, pulled)` (5188) keeps history and the modal renders; (c) a record shaped by the **real** Cloud-Data-refresh field list (copy of the literal at 6442-6449, run on a mock row) keeps `priceHistory` and the modal renders |
| T-24 | 24 | `expPriceHistoryCSV()` output captured for fixture `FX-A`; compared to a literal expected string committed in the test (generated once from the pre-change code before the edit) |
| T-25 | 25 | `AI_SYSTEM_PROMPT` contains the three exact new strings of §8.1; does not contain "Click the clock icon on any line to view previous versions" |
| T-30a/b | 30 | two same-currency order entries → the later-dated is shown; none matching currency / invoice missing → `Last charged on` absent |
| T-31a/b | 31 | `invoiceRef` matching two invoices (EUR first, USD second) → treated as EUR (first match); renumbered → `currency unknown` |
| **T-32a** | 32 | first usable entry cost 10 price **0**, latest cost 12 price 25 → trend Price part exactly `Price n/a`; Cost part `Cost ↑ 20.0%`; Margin part `Margin n/a` (first margin null) |
| **T-32b** | 32 | first cost 10 price 20, **latest** cost 12 price **0** → `Price n/a`; `Cost ↑ 20.0%`; `Margin n/a` |
| T-33 | §3.1 | blank-date entry sorts first; `null` array element skipped without throwing |
| T-34 | §3.4 | equal-cost ties → Lowest reports the most recent equal-cost entry; all-equal → one collapsed row |
| **T-35a/b** | 29 | the two **rewritten existing tests** (`tests/run.js:14670-14684`): after `openLIHist('li-d3')`/`('li-d4')`, `lih-body` contains `USD 0.125` |

**Mutation tests** (revert in a scratch copy of `index.html`, confirm exactly the predicted tests fail, restore):
1. `liHistIsOrder()` → always `false` → T-5, T-14, T-15, T-20 fail.
2. Staleness via raw `Math.abs(li.cost - h.cost) >= 0.001` → **T-21g** fails. "At cost" via raw subtraction `< 0.001` → **T-12c** fails.
3. Remove `san()` on `h.notes` in the timeline → T-16a fails; on `invoiceRef`/`invCur` in the order section → T-16b fails; on the supplier name/SKU in the header → T-16c fails.
4. Sort `li.priceHistory` in place instead of the copy → **T-19** (out-of-order fixture) and T-6 fail. *(The `i` tie-break itself is defensive — V8's sort is stable — so no mutation is claimed for it; T-6b still asserts the same-date order.)*
5. Label order prices with `li.cur` regardless of the invoice → **T-22a/b** fail (T-14b is margin-only and is not claimed).
6. Replace `csvRow(...)` with a raw `join(',')` → T-18a–c fail.
7. Compare the cost staleness even when the newest entry's cost is unusable → **T-21e** fails.
8. Trend price part computed without the null guard → **T-32a/b** fail.
9. Remove the currency-equality filter from "Last charged on" → **T-30b** fails.
10. `liHistBase()` returns the immediately preceding entry instead of the nearest usable → **T-9b, T-10a** fail.

**Existing tests:** the ~111 `priceHistory` references in `tests/run.js` are fixtures and assertions about history *data*, each reviewed; the **two** that assert the inline row's content are rewritten (T-35a/b, §2.1) — no other test depends on the inline row. Expected suite delta: roughly +50 tests, no tests removed (1194 → ~1244); exact count recorded at build.

---

## 10. Explicitly out of scope / unchanged (confirms REQ §8)
Stored `lastUpdatedAt`/`lastUpdatedBy` (v3.0 audit trail), volatility flag, PO-line cost cross-check, any change to `getSupplierPriceHistory()` or the toolbar "Price History CSV", writing history entries for Sheets-pull cost changes, the import data-loss fix (`LI-GAP-007`).

## 11. Rulings on the v1 open points
1. **Previous-entry semantics — resolved by the operator (2026-11-27, "defaults"):** skip unusable baselines (REQ v5 §3.5a; §3.2 here).
2. **Margin when cost is unusable:** `n/a` (SPEC decision, retained). The catalogue-table pill still shows 100% for a cost-0 item (`index.html:8149`); that existing mismatch is disclosed in the user guide, not changed here.
3. **Non-string `invoiceRef`:** classed as an order entry (T-15).
4. **`Price Currency` CSV column — resolved by the operator:** kept as the 11th column (REQ v5 §3.8).
5. **"Medium margin" label:** retained for the 10–<20 band (T-11).
6. **At-cost tolerance — resolved:** integer-thousandths equality, one rule for the modal (REQ v5 §3.5a).

## 12. Spec-gate round 1 → v2 map

| Finding | Addressed by |
|---|---|
| 1 (blocking: two existing tests assert `USD 0.125` in the inline row) | §2.1 names both (`14670-14684`), rewrites them; T-35a/b; suite delta |
| 2 (At-cost tolerance) | §3.6, T-12c, REQ v5 §3.5a/AC-12, mutation 2 |
| 3 (body gating / always-present Current row) | §4.2 state table (S-normal/S-one/S-unusable/S-noCat), T-20b |
| 4 (previous-entry semantics) | §3.2 `liHistBase`, T-9b, T-10a–d, mutation 10, REQ v5 AC-10 |
| 5 (incomplete contract) | §3.3 model contract, §4.2 sign/zero rule, §5 full CSV body, `innerHTML` for title/sub |
| 6 (NaN path) | §3.7 `priceTxt`, T-22c |
| 7 (mutations that cannot fail) | §9 mutations 3, 4, 5 corrected; new 7, 8, 9, 10; tie-break explicitly not claimed |
| 8 (harness hazard) | §2.2 and §9 per-group `closeM('ov-lih')` + `_lihId` reset |
| 9 (vague assertions) | T-11, T-32a/b exact strings, T-23b/c use the real functions |
| 10 (11th CSV column scope) | operator ruling + REQ v5 §3.8 |
| 11 (arrow mojibake) | §5 BOM, T-18e |
| 12 (T-27 not testable) | §8.3 manual build step; T-27 removed |
| 13 (§8.1 wording, 12737 has no clock icon) | §8.1 exact strings, no apostrophes, correct line attribution |
| 14 (non-ISO dates) | §3.7 note + user guide |
| 15 (half-thousandth rounding) | §3.4 states the guarantee precisely |
| 16 (GDPR statement, gap ID) | header GDPR line; `LI-GAP-008` named in §8.4 |
| 17 (cost-0 pill 100%) | §11 ruling 2 |
| 18 (`max-height` wrapper) | §4.2 wrapper div |
| 19 (acceptable) | §11 rulings 3, 5 |
