# SPEC-LI-003: Line Item Cost & Margin History modal (reorder decision view)

**Status:** v1 DRAFT — written from the gate-passed `docs/REQ-LI-003-v4.md` (requirements-gate round 4 PASS). Not yet through the spec-gate.
**Version target:** v2.9.104. **Files touched:** `index.html` (render, helpers, one new overlay, AI prompt, changelog, version strings), `tests/run.js`, docs.
**Schema impact: none.** No new `K` key, no new Line Item or history-entry field, no Supabase migration, no Sheets-sync change, so no `schema-migration-reviewer` pass is needed (REQ §4, §7). Everything below is derived on render from each entry's own `cost` and `price`; nothing is stored.
**Pre-conditions carried from the REQ gate (STACKD_CONTEXT backlog) — each is closed in this SPEC:** (1) staleness is compared on integer thousandths (§4.4); (2) AC-21's fifth case has live values (§9, T-21e/f); (3) one AC-32 test per entry position (§9, T-32a/b); (4) a negative AC for no-history items (§9, T-1c).
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
- **Delete** `togglePH()` (`8184-8187`). Grep-verified: no test and no other code references it.
- A Line Item with an empty/absent `priceHistory` still renders no badge (`ph.length` falsy) — **unchanged**, which is REQ §3.1's no-history rule. `openLIHist()` is defensive (§2.2) but the badge never routes there.

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
Close uses the existing `closeM('ov-lih')` (`index.html:5549`); no `closeM` change is needed. `_lihId` is session-scoped UI state, not part of `DB`; `resetDB()` does not clear it, so tests must reset it (`ctx._lihId = null`) or drive `openLIHist()` fresh each time.

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
// Numeric (finite) value or null — used only to let a previous value of exactly 0 still produce an absolute shift (AC-10).
function liHistNum(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = +v;
  return isFinite(n) ? n : null;
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
// Integer thousandths — the same 0.001 tolerance saveInv() uses (index.html:8938), but compared on integers so the
// boundary is float-safe (10.001 vs 10 → 10001 vs 10000 → differs; subtraction of the raw floats gives 0.00099999…).
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

### 3.2 Shift calculation (REQ §3.5, §3.5a, AC-4, AC-9, AC-10)
```js
// Shift of `cur` against `prev` (both raw stored values). kind 'amt' = cost/price, 'pp' = margin points.
// Returns null when no shift can be shown; otherwise {abs, pct|null}.
function liHistShift(prev, cur, kind) {
  var c = (kind === 'pp') ? cur  : liHistPos(cur);       // current must be usable (margin: a number, not null)
  if (c === null || c === undefined) return null;
  var p = (kind === 'pp') ? prev : liHistNum(prev);       // previous may be exactly 0 (AC-10) but not unparseable
  if (p === null || p === undefined) return null;
  var out = { abs: c - p, pct: null };
  if (kind !== 'pp' && p > 0) out.pct = (c - p) / p * 100;   // percent n/a when previous is 0 (or unusable)
  return out;
}
```
- Cost/price: current must be usable (`> 0`, finite) or the entry shows `–` and no shift (AC-9). Previous may be `0` — the absolute change is still shown and the percent is "n/a" (AC-10). A previous value that is non-numeric yields no shift.
- Margin shift is in **percentage points** only (`pct` is never computed); both margins must be non-null.
- "Previous" is always the **immediately preceding catalogue entry** in the §3.1 order — order entries never participate (AC-5).

### 3.3 The model
```js
function liHistModel(li) {
  var cur = li.cur || 'USD';
  var sp = liHistSplit(li);
  var price = liHistPos(li.price);                       // today's sell price (null ⇒ margins n/a, AC-3)
  var rows = sp.cat.map(function(w, k){                   // oldest → newest
    var h = w.h, prev = k ? sp.cat[k-1].h : null;
    var m = liHistMargin(h.cost, h.price);
    var pm = prev ? liHistMargin(prev.cost, prev.price) : null;
    return {
      h: h, i: w.i, margin: m,
      costOK: liHistPos(h.cost), priceOK: liHistPos(h.price),
      dCost:   prev ? liHistShift(prev.cost,  h.cost,  'amt') : null,
      dPrice:  prev ? liHistShift(prev.price, h.price, 'amt') : null,
      dMargin: (prev && m !== null && pm !== null) ? liHistShift(pm, m, 'pp') : null
    };
  });
  var usable = rows.filter(function(r){ return r.costOK !== null; });   // "usable catalogue entry" = usable cost
  var model = { li: li, cur: cur, rows: rows, order: sp.ord, usable: usable, price: price, … };
  // §3.4 range, §3.5 trend, §3.6 staleness, §3.7 last-charged are attached below
  return model;
}
```

### 3.4 Range summary (REQ §3.3) and staleness (integer thousandths)
Over `usable` (catalogue entries with usable cost):
- `lowest` = entry with the minimum usable cost; `highest` = maximum; `latest` = the newest entry in the §3.1 order (the last element of `usable`). **Ties:** the most recent entry among equal costs is reported (the date a reorder-relevant price last applied).
- Each carries `margin = price !== null ? (price − cost)/price × 100 : null` — the margin **at today's sell price `li.price`**, not at the entry's own price (REQ §3.3). A separate always-present **Current catalogue cost** row uses `li.cost` (shown `–`, margin n/a when `li.cost` is not usable).
- `collapsed` = true when every usable cost is equal (one row "Lowest = Highest = Latest"); `single` = exactly one catalogue entry **overall** (any usability) → message "Only one price on record — no trend yet".
- **Staleness** uses the newest catalogue entry **regardless of usability** (`sp.cat[sp.cat.length-1]`), each field compared only when that entry's own value is usable (AC-21's "no cost-based notice" case):
```js
function liHistStale(li, latestEntry) {          // latestEntry = newest catalogue entry or null
  if (!latestEntry) return false;                // no catalogue entry → nothing to compare (AC-20)
  var h = latestEntry.h, stale = false;
  if (liHistPos(h.cost)  !== null && Math.abs(liHistMilli(li.cost)  - liHistMilli(h.cost))  >= 1) stale = true;
  if (liHistPos(h.price) !== null && Math.abs(liHistMilli(li.price) - liHistMilli(h.price)) >= 1) stale = true;
  return stale;
}
```
Rounding to a thousandth first is what REQ §3.3 specifies ("each rounded to 3 decimals … differs by 0.001 or more"), so values that straddle a rounding boundary can notify at a true difference slightly under 0.001 (e.g. 10.0006 vs 10.0000 → 10001 vs 10000). This is the REQ's accepted behavior, not an extra tolerance.
- Notice text, verbatim: "The catalogue cost/price has changed since the last history entry (for example by a Sheets pull or an import) — history may be incomplete."

### 3.5 Trend (REQ §3.6, AC-7, AC-32)
Defined only when `usable.length >= 2`; first = `usable[0]`, last = `usable[usable.length-1]`:
- **Cost %** = `(last.costOK − first.costOK) / first.costOK × 100`.
- **Price %** = `(last.priceOK − first.priceOK) / first.priceOK × 100`, `"n/a"` if either `priceOK` is null. **This is the AC-32 mechanism:** a zero price on the *first* usable entry and a zero price on the *last* usable entry each produce `"n/a"` for the Price part only, and Cost/Margin parts are unaffected.
- **Margin pp** = `last.margin − first.margin`, `"n/a"` if either margin is null (null whenever the entry's cost or price is unusable).
Hidden entirely when `usable.length < 2`.

### 3.6 Margin health band (REQ §3.7)
For a margin value `m`: `|cost − price| < 0.001` (use `liHistMilli` on both → difference `< 1`) → neutral **"At cost"** badge (checked **before** the banding); otherwise `m >= 20` good, `m >= 10` medium, else low — the exact bands of the existing catalogue pill (`index.html:8149-8150`: `m>=20?'phi':m>=10?'pmi':'plo'`); negative margins show their sign and take `plo` (AC-12). The badge shown in the header summary is for **today's** `li.cost`/`li.price` margin. (AC-11 uses margins 25 / 15 / 5.)

### 3.7 Order entries (REQ §3.4, AC-14, AC-22, AC-30, AC-31)
For each `sp.ord` wrapper `{h,i}`:
- **Invoice lookup:** `DB.inv.filter(function(x){ return x.num === h.invoiceRef; })[0]` — exact match on the stored `invoiceRef`, **first match wins** (AC-31); none ⇒ "not found" (missing, renumbered or deleted).
- **Currency:** `invCur = inv ? String(inv.cur || 'USD').trim().toUpperCase() : null` (blank invoice currency follows the app-wide `inv.cur || 'USD'` default). `lineCur = String(li.cur || 'USD').trim().toUpperCase()`.
- **Price label:** `fmtN(h.price, invCur, 3)` when found; otherwise `fmtN(h.price, '', 3)` is **not** used — render the bare 3-dp number followed by the text `currency unknown` (never silently labelled with the Line Item currency).
- **Margin:** shown (`liHistMargin(h.cost, h.price)`, `fp()`) only when `inv` found **and** `invCur === lineCur`; otherwise the literal text `n/a (different or unknown currency)` (AC-14).
- Order entries carry **no** shift badges, appear in no range/trend/last-price-change calculation.
- **Last charged on:** among order entries with a found invoice and `invCur === lineCur`, the **last in the §3.1 order** (latest date, array position as tie-break) → `Last charged on <invoice num> at <fmtN(price, lineCur, 3)>`; omitted when none qualifies (AC-30).

---

## 4. Rendering (`rLIHist(li)`)

`rLIHist` builds one HTML string from `liHistModel(li)` and sets `G('lih-title')`, `G('lih-sub')`, `G('lih-body')`. Every free-text value goes through `san()` (SKU, description, supplier name, notes, invoice reference, currency codes) — AC-16. Numbers go through the existing `fmtN(value, cur, 3)` / `fp()` formatters.

### 4.1 Header (REQ §3.2, AC-17)
- `lih-title`: `Cost & Margin History — <SKU> <Description>` (` <SKU>` omitted when `li.sku` is blank).
- `lih-sub`: supplier + currency. Supplier text: `li.supId` blank → `No supplier`; `DB.sup` has no record with that id → `Unknown supplier`; else the supplier name. Then `· Currency <cur>`.
- Below the sub line (inside `lih-body`): **Last price change: <date>** = the date of the newest catalogue entry (`sp.cat` last element's `date`, `–` when blank), omitted when there are no catalogue entries. No actor is shown (REQ §8).

### 4.2 Body order
1. **Staleness notice** (when `liHistStale`) — amber box, text per §3.4. Rendered **first** (REQ: the operator's most important signal).
2. **No-catalogue message** when `sp.cat` is empty (AC-20): "No catalogue price history — only prices charged on orders are recorded". In this state hide Lowest/Highest/Latest, Last price change and the trend; still show **Current catalogue cost** and the order section.
3. **Cost range summary** (when `usable.length >= 1`): rows Lowest / Highest / Latest (or the single collapsed row), each `<fmtN cost> · <date> · margin at today's price <fp()>` (`n/a` when `li.price` is not usable — AC-3); plus the **Current catalogue cost** row: `<fmtN li.cost>` · margin `fp()` or `n/a`, with the §3.6 health badge ("At cost" / Low margin / Medium / Healthy margin wording: **Low margin** (<10), **Medium margin** (10–<20), **Healthy margin** (≥20) — the REQ names "Low margin"/"Healthy margin" only for its own bands; medium is labelled by the existing pill band).
4. **Last charged on …** line (§3.7), when present.
5. **"Only one price on record — no trend yet"** when exactly one catalogue entry (AC-8) — otherwise the **Trend line** (§3.5) when `usable.length >= 2`: `Cost ↑ 8.5% | Price ↑ 3.2% | Margin ↓ 4.1 pp`, each part `n/a` per §3.5, arrow ↑/↓ and the neutral `→` for an exactly-zero change.
6. **Timeline table** (catalogue entries, **newest first**): `Date · Unit Cost · Unit Price · Margin % · Notes`. Beside Cost and Price the shift, formatted `↑ USD 2.500 (+20.0%)` / `↓ USD 1.200 (-9.1%)`: arrow, `fmtN(abs, cur, 3)` of the **absolute value**, then `(±x.x%)` — or `(n/a)` when `pct` is null; green (`var(--gn,#1a7a4a)`) for increases, red (`var(--cr)`) for decreases, `no change` (muted) when zero. Margin shift `↑ 2.3 pp` / `↓ 2.3 pp`. The oldest entry shows no shift. Each shift badge carries a `title` in words ("Cost increased USD 2.500 (+20.0%) from previous version"), `san()`-wrapped. A `0`/unusable cost renders `–` (AC-9); an unusable price renders `–` and its margin `n/a`. The table body scrolls (`max-height:260px;overflow-y:auto`); no entry cap.
7. **Order-entry section** titled "Prices charged that differed from the catalogue" (when `sp.ord.length`), newest first: `Date · Invoice · Price charged · Margin`, per §3.7. Not shown when empty.

### 4.3 Colours/tokens
Use existing CSS variables only (`--cr` red, `--m` muted, `--bl`, `--ln`, `--card`); the existing green used in `rLI()` (`#1a7a4a`) for increases. No new CSS rules are added to the stylesheet; inline styles only (matches the old inline row).

---

## 5. Per-item CSV (`liHistCsv()`, REQ §3.8, AC-18)

```js
function liHistCsv() {
  var li = DB.li.find(function(x){ return x.id === _lihId; });
  if (!li) return;
  var m = liHistModel(li);
  var h = ['Date','Type','Unit Cost','Unit Price','Margin %','Cost shift','Price shift','Margin shift (pp)','Invoice Ref','Notes','Price Currency'];
  …rows: every catalogue entry (oldest→newest) then every order entry (oldest→newest)…
  dlText('Stackd-LineItemHistory-' + safeName + '-' + today() + '.csv', [csvRow(h)].concat(rows.map(csvRow)).join('\n'), 'text/csv');
  toast('Cost history exported');
}
```
- **Written through `csvRow()`** (`index.html:13587`), which already calls `csvSafe()` (SEC-GAP-026) and quotes commas, double quotes and newlines. `safeName` = SKU or description reduced to `[A-Za-z0-9._-]` (other characters → `-`), never empty (falls back to the Line Item id).
- `Type` is the literal `catalogue` or `order`. Numeric columns are written as plain numbers (3 dp costs/prices, 1 dp margin, empty cell for n/a).
- **Shift text begins with an arrow** (`↑ 2.500 (+20.0%)`), never a leading `+`/`-`, because `csvSafe()` would prefix an apostrophe to a string like `+2.500 (+20.0%)` (it only exempts bare numerics) — covered by test T-18d.
- Order rows: `Cost shift`/`Price shift`/`Margin shift` empty; `Margin %` per the §3.7 currency rule (empty when n/a); `Invoice Ref` set.
- **`Price Currency` (a SPEC addition, flagged for the gate):** the REQ lists ten columns; a CSV row for an order entry would otherwise present an invoice-currency price indistinguishable from a Line-Item-currency one, contradicting REQ §3.4 ("never silently with the Line Item currency"). The column is appended last (the REQ's ten columns keep their order): catalogue rows carry `li.cur || 'USD'`, order rows carry the invoice currency or `unknown`.
- The toolbar "Price History CSV" (`13545`) is untouched and still byte-identical (AC-24). No demo filtering is added (REQ §3.8).

---

## 6. Behavioral rules recap (cross-checks to REQ §3.5a)
- Cost `≤ 0`/non-numeric → `–`, excluded from range, shifts and trend; price `≤ 0` → margin `n/a`, excluded from price shift (§3.2).
- Percent change `n/a` when the previous value is `0` (absolute still shown) (AC-10).
- Currency edits between entries are not detected (accepted limitation, REQ §9.3) — documented in the user guide.
- Nothing is persisted; opening/closing the modal changes no record (AC-19).

---

## 7. Cloud Data / Sheets / import (no change)
No Cloud Data touchpoint is modified: `priceHistory` already round-trips inside the existing `price_history` jsonb (`refreshLIFromSupabase()` `6442-6449`, `migrateLineItemsToSupabase()` `7056`). The modal reads whatever `DB.li` currently holds, so it works across a Cloud Data refresh, a restored pre-feature backup and an ordinary Sheets pull (`mergePulledWithLocal()` keeps `priceHistory`, `5188-5196`) with no migration step (AC-23). `LI-GAP-007` (import data loss) stays a separate REQ; an item whose history an import erased simply shows fewer or no entries (REQ §3.10).

---

## 8. Documentation and housekeeping (AC-25 to AC-28)

1. **`AI_SYSTEM_PROMPT`** (`index.html`, `Price versioning:` line at `12576` and the troubleshooting bullet at `12737`): both lines currently say Line Item/quote history is opened with "the clock icon" and versions "when cost, duty %, or markup % changes". Rewrite to distinguish the two features: **Quote-line** history (clock icon in the quote grid; versions on cost/duty %/markup/insurance change) vs **Line Item** history (click the "N pt(s)" badge next to the Unit Price on the Line Items tab to open a read-only Cost & Margin History modal; entries are written on creation and when Unit Cost or Unit Price changes on save, and by saving an invoice at a price different from the catalogue; the modal shows lowest/highest/latest cost with the margin at today's sell price, trend, a stale-catalogue notice and a per-item CSV). **No apostrophes inside the single-quoted JS strings** (known harness trap — CLAUDE.md; reword rather than escape).
2. **`docs/user-guide.md`**: add a Line Items → "Cost & Margin History" subsection (add, not update — none exists): how to open it, the range summary, the stale-catalogue notice, catalogue vs order entries, the CSV export, the "history is only as complete as the catalogue" caveat, and the import warning (do not import Line Items over items whose history you want to keep, `LI-GAP-007`).
3. **In-app changelog**: prepend a v2.9.104 block; **three hardcoded version strings** (`<title>` `index.html:9`, the nav badge button, the `AI_SYSTEM_PROMPT` self-description line) all become v2.9.104 — verify with `grep -n "v2\.9\.103" index.html` (only the changelog entry and feature-label mentions may remain).
4. `docs/version-history.md` (new row), `CLAUDE.md` (version, test count, branch if changed), `docs/known-gaps.md` (new gap: `getSupplierPriceHistory()` treats order-entry costs as supplier price points, REQ §7/§9; `LI-GAP-007` already logged), `STACKD_CONTEXT.md` backlog (mark REQ-LI-003 shipped, add the gap), `docs/requirements-tracker.md`, Notion rows (aggregate wording only).
5. PR from the working branch per the delivery checklist.

---

## 9. Test plan (`tests/run.js`; one new section "Line Item cost & margin history (SPEC-LI-003)")

Harness hazards respected: `mockElements` is module-level and never cleared — every test sets `mockEl('lih-body')`/`('lih-title')`/`('lih-sub')` content only through the code under test and reads `.innerHTML`; `resetDB()` then `ctx._lihId = null` before each group; any test that sets `mockEl('li-q')`/`('li-sf')` leaves them `''`. `.classList` is a real `makeClassList()` in the mock, so `G('ov-lih').classList.contains('on')` is assertable. Async functions are not involved (everything here is synchronous).

| Test | AC | Assertion |
|---|---|---|
| T-1a | AC-1 | `rLI()` HTML contains `openLIHist('l1')` and **not** `togglePH` or `id="ph-l1"`; `typeof ctx.togglePH === 'undefined'` |
| T-1b | AC-1 | `openLIHist('l1')` adds `on` to `ov-lih`; `lih-title` contains SKU and description |
| T-1c | AC-1 (negative) | Line Item with `priceHistory: []` and with the key absent → `rLI()` row has no `openLIHist` badge; calling `openLIHist(id)` directly leaves `ov-lih` without `on` |
| T-2 | AC-2 | catalogue costs 10/12/11, `li.price` 20, `li.cost` 11 → body contains Lowest `10.000` margin `50.0%`, Highest `12.000` `40.0%`, Latest `11.000` `45.0%`, Current row `45.0%`; **no** stale notice text |
| T-3 | AC-3 | `li.price` 0 and `''` → margins `n/a`; body contains no `NaN`/`Infinity` |
| T-4 | AC-4 | costs 10 → 12 USD → `↑ USD 2.000 (+20.0%)`; margin shift in `pp`; oldest entry has no shift markup |
| T-5 | AC-5 | cost 10, an order entry (invoiceRef `INV-1`) at a discounted price, cost 12 → cost-12 shift is `↑ USD 2.000 (+20.0%)` (vs 10, not vs the order entry's cost); order entry appears only in the order section; range/trend exclude it |
| T-6a/b | AC-6 | array order ≠ date order → shifts, trend, range, Last price change follow date order; two same-date entries keep array order |
| T-7 | AC-7 | ≥2 usable entries → trend `Cost ↑ … \| Price ↑ … \| Margin ↓ … pp` with first→latest values asserted numerically |
| T-8 | AC-8 | single catalogue entry → "Only one price on record — no trend yet"; no trend line |
| T-9 | AC-9 | entry cost `0`, `''`, `'abc'`, `null` → cost rendered `–`, excluded from range and shifts; no `NaN` |
| T-10 | AC-10 | previous cost `0` → absolute shown, `(n/a)` percent |
| T-11 | AC-11 | margins 25/15/5 → bands `phi`/`pmi`/`plo` classes or labels Healthy/Medium/Low |
| T-12a/b | AC-12 | `|cost−price| < 0.001` (e.g. 10 / 10.0004) → "At cost", not "Low margin"; cost 12 price 10 → `-20.0%` with low band |
| T-13 | AC-13 | latest catalogue cost 10, `li.cost` 11 → stale notice present; Current catalogue cost row shows `11.000` |
| T-14a/b/c | AC-14 | invoice found same currency → margin shown; found different currency → `n/a (different or unknown currency)`; invoice deleted → same text |
| T-15 | AC-15 | `invoiceRef` `''`, `'   '`, `null`, key absent → catalogue entries (in shifts); non-blank string and a number → order entries |
| T-16 | AC-16 | notes/SKU/description/supplier name containing `<img src=x onerror=…>` → output contains `&lt;img` and no raw `<img` |
| T-17a/b/c | AC-17 | blank SKU → title without a double space/SKU; `supId` blank → `No supplier`; `supId` of a deleted supplier → `Unknown supplier` |
| T-18a–d | AC-18 | `liHistCsv()` via a captured `createElement` anchor: comma/quote/newline note correctly quoted; note starting `=cmd` → `'=cmd`; one row per entry, both kinds with `Type`; **shift cells start with an arrow, not `'`+`+`** |
| T-19 | AC-19 | deep-copy `DB.li` + capture writes via a wrapped `sv`; open then close → identical records, zero `sv`/`saveAll`/`logEv` calls |
| T-20 | AC-20 | no catalogue entries, one order entry → badge present; message text; Current row + order section; no Lowest/Highest/Latest/Last price change/trend; no `NaN` |
| T-21a–f | AC-21 | latest entry cost 10 price 20: live `10.0004/20` → no notice; `10.01/20` → notice; `10/20.01` → notice; `10.01/20.01` → notice; **(e)** latest entry cost `0` price 20 with live `5/20` → no notice (cost skipped); **(f)** same entry with live `5/20.01` → notice (price only); **(g) boundary**: live `10.001/20` vs latest `10/20` → notice (integer thousandths; fails under rounded-float subtraction) |
| T-22a/b | AC-22 | order price labelled with the invoice currency (`EUR 9.500`) when found; `9.500 currency unknown` when not |
| T-23a/b/c | AC-23 | an entry set lacking the `invoiceRef` key (old backup shape); after simulated `refreshLIFromSupabase`-shaped record (no new field); after `mergePulledWithLocal` — modal renders |
| T-24 | AC-24 | `expPriceHistoryCSV()` output captured before/after the change is byte-identical for a fixed fixture (the fixture's expected string is committed as a literal) |
| T-25 | AC-25 | `AI_SYSTEM_PROMPT` contains the history-badge sentence and no longer contains the old "cost, duty %, or markup %" Line Item claim; contains a clock-icon sentence scoped to quotes |
| T-27 | AC-27 | `grep`-style test: `index.html` contains no `v2.9.103` outside the changelog block and known feature-label mentions (follows the existing version-string test pattern if present; otherwise a manual verification step recorded in the PR) |
| T-30a/b | AC-30 | two matching-currency order entries → latest-dated shown; none matching → line omitted |
| T-31a/b | AC-31 | `invoiceRef` matching two invoices → first match's currency used; renumbered/deleted → `currency unknown` |
| **T-32a** | AC-32 | catalogue entries (usable cost): **first** entry price `0`, latest price 25 → trend Price part `n/a`, Cost and Margin parts numeric/`n/a` per the null-margin rule |
| **T-32b** | AC-32 | **latest** entry price `0`, first price 20 → Price part `n/a`; Cost part still computed |
| T-33 | §3.2 | a catalogue entry with `date` blank sorts first; entries `null` in the array are skipped without throwing |
| T-34 | §3.4 | tie costs → Lowest reports the **most recent** equal-cost entry; all-equal → single collapsed row |

**Mutation tests (revert in a scratch copy of `index.html`, confirm the exact test fails, restore):**
1. Make `liHistIsOrder()` always `false` → T-5, T-14, T-15, T-20 fail (order entries leak into shifts).
2. Replace `liHistMilli()` comparison with `Math.abs(li.cost - h.cost) >= 0.001` on raw floats → **T-21g** fails.
3. Remove `san()` on `h.notes` in the order/timeline renderers → T-16 fails.
4. Drop the `i` tie-break from `liHistSplit()` comparator (or sort the original array in place) → T-6b / T-19 fail.
5. Use `li.cur` for order-entry price labels regardless of invoice → T-22b / T-14b fail.
6. Replace `csvRow(...)` with a raw `join(',')` → T-18a–c fail.

**Existing tests:** `togglePH` and `ph-` are referenced by no test (grep-verified); the ~111 `priceHistory` references in `tests/run.js` are fixtures and assertions about history *data*, not the inline row — each is reviewed, none bulk-edited. Expected suite delta: roughly +45 tests (1194 → ~1239); exact count recorded at build.

---

## 10. Explicitly out of scope / unchanged (confirms REQ §8)
Stored `lastUpdatedAt`/`lastUpdatedBy` (v3.0 audit trail), volatility flag, PO-line cost cross-check, any change to `getSupplierPriceHistory()` or the toolbar "Price History CSV", writing history entries for Sheets-pull cost changes, the import data-loss fix (`LI-GAP-007`).

## 11. Open points for the spec-gate to rule on
1. **AC-9 vs AC-10 reading** (§3.2): a cost of `0` is excluded as a *current* value but a *previous* value of exactly `0` still yields an absolute shift with percent `n/a` — the literal reading of AC-10. If the gate prefers "no shift at all when the previous is unusable," it is a one-line change in `liHistShift()` and AC-10/T-10 change together.
2. **Margin when cost is unusable** (§3.2): `n/a`, not 100% — a SPEC decision (REQ §3.5a is silent on margin for a cost-0 entry); the existing catalogue pill would show 100%.
3. **Non-string `invoiceRef`** (§3.1): classed as an order entry (REQ defines only the string case).
4. **`Price Currency` CSV column** (§5): an addition beyond the REQ's ten columns.
5. **"Medium margin" label** (§4.2): the REQ names Low/Healthy only; the existing pill has three bands.
