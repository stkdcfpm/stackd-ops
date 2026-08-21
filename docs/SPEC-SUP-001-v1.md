# SPEC-SUP-001-v1: Supplier Price Intelligence Retention & Reference View

**Implements:** REQ-SUP-001-v2 (requirements-gate CONDITIONAL PASS on v1, resolved in v2 — not independently re-gated a third time; proceeding to spec-gate on v2 per this REQ's own precedent set by REQ-QTE-001).

## 0. Design decisions this spec has to make that the REQ left open

The REQ specifies *what* to aggregate but not every detail of *how*. Two decisions, made explicit here rather than left implicit in the code:

1. **Which price figure represents "price" across three differently-shaped sources.** `DB.li[].priceHistory[]` entries carry `cost`/`price` (cost = what we pay, price = what we sell for); `DB.qt[].lines[].priceHistory[]` entries carry `cost`/`landed`/`sellPrice`; `DB.po[].lineItems[]` entries carry only `cost`. **Decision: use `cost` uniformly across all three.** `cost` is the one figure that's genuinely comparable across sources — it's what the supplier actually charges, before this app's own freight/duty/margin math is layered on top. Using `landed` or `sellPrice` for Quote lines would bake in this app's own freight assumptions (which vary by destination/quantity, nothing to do with the supplier), making cross-source and cross-supplier comparison meaningless.
2. **No currency conversion in this version.** Each point is shown in its own recorded currency, unconverted. REQ-SUP-001a's field list includes `currency` as a *displayed* field, not a conversion target — introducing FX conversion here would be new scope (and a new place to reproduce `CUR-GAP-001`/`002`-style mixing if done carelessly), not something REQ-SUP-001 asked for. If cross-currency comparison is wanted later, that's a follow-up REQ reusing the existing `toGBP()`/`toDisp()` helpers deliberately, not bolted on here.

## 1. `getSupplierPriceHistory(supId)` — new aggregation function

Placed near the other `sup*` helpers, e.g. immediately before `renderSupContacts()` (`index.html:4225`):

```js
function getSupplierPriceHistory(supId) {
  var points = [];

  DB.li.filter(function(l){ return l.supId === supId; }).forEach(function(l){
    (l.priceHistory || []).forEach(function(h){
      points.push({
        date: h.date || '', sourceType: 'line_item', sourceRef: l.num || l.sku || l.desc,
        desc: l.desc || '', price: +h.cost || 0, currency: l.cur || 'USD', status: ''
      });
    });
  });

  DB.qt.forEach(function(q){
    (q.lines || []).filter(function(l){ return l.supId === supId; }).forEach(function(l){
      (l.priceHistory || []).forEach(function(h){
        points.push({
          date: h.ts ? h.ts.slice(0,10) : '', sourceType: 'quote', sourceRef: q.num || '',
          desc: l.desc || '', price: +h.cost || 0, currency: q.currency || 'USD', status: q.status || ''
        });
      });
    });
  });

  DB.po.filter(function(p){ return p.supId === supId; }).forEach(function(p){
    (p.lineItems || []).forEach(function(li){
      points.push({
        date: p.date || '', sourceType: 'po', sourceRef: p.num || '',
        desc: li.desc || '', price: +li.cost || 0, currency: p.cur || 'USD', status: p.status || ''
      });
    });
  });

  points.sort(function(a,b){ return (b.date||'') < (a.date||'') ? -1 : 1; });
  return points;
}
```

Pure, synchronous, no DOM/AI access — directly satisfies REQ-SUP-001a. `date` strings compare correctly with plain `<`/`>` since both `li.priceHistory[].date` (`today()`-format `YYYY-MM-DD`) and `q.lines[].priceHistory[].ts.slice(0,10)` (ISO timestamp sliced to date) and `po.date` (also `YYYY-MM-DD` per the existing date-input field) are all in the same `YYYY-MM-DD` sortable form.

## 2. `supPriceStaleness(dateStr)` — staleness helper

```js
function supPriceStaleness(dateStr) {
  if (!dateStr) return null;
  var months = (Date.now() - new Date(dateStr).getTime()) / (30.44 * 86400000);
  return months;
}
```

Returns `null` for a missing/unparseable date (defensive — a point with no date can't be judged stale, and must not be silently treated as either fresh or stale). Returns months elapsed otherwise, compared against the configurable threshold at render time (§4), not baked into this helper.

## 3. `renderSupPriceHistory()` — render function, mirrors `renderSupContacts()` exactly

Placed immediately after `renderSupContacts()` (`index.html:4225-4235`):

```js
function renderSupPriceHistory() {
  var el = G('sup-price-list'); if (!el) return;
  var points = getSupplierPriceHistory(EI.s);
  if (!points.length) { el.innerHTML = '<span style="color:var(--m);">No price history yet.</span>'; return; }
  var thresholdMonths = +localStorage.getItem('stackd_sup_intel_threshold_months') || 12;
  var typeLabels = { line_item: 'Line Item', quote: 'Quote', po: 'PO' };
  el.innerHTML = '<table class="tbl" style="font-size:.5rem;width:100%;"><thead><tr><th>Date</th><th>Source</th><th>Ref</th><th>Product</th><th>Price</th><th>Status</th></tr></thead><tbody>' +
    points.map(function(p){
      var age = supPriceStaleness(p.date);
      var stale = age !== null && age > thresholdMonths;
      var ageLabel = age === null ? '' : (age < 1 ? 'this month' : Math.round(age) + ' mo ago');
      return '<tr' + (stale ? ' style="background:#FFF8E1;"' : '') + '>'
        + '<td>' + san(p.date || '-') + (ageLabel ? ' <span style="color:' + (stale ? '#B8860B' : 'var(--m)') + ';">(' + ageLabel + (stale ? ' ⚠' : '') + ')</span>' : '') + '</td>'
        + '<td><span class="tag">' + san(typeLabels[p.sourceType] || p.sourceType) + '</span></td>'
        + '<td>' + san(p.sourceRef || '-') + '</td>'
        + '<td>' + san(p.desc || '-') + '</td>'
        + '<td style="font-weight:600;">' + san(p.currency) + ' ' + fn(p.price,2) + '</td>'
        + '<td>' + san(p.status || '-') + '</td>'
        + '</tr>';
    }).join('') + '</tbody></table>';
}
```

Staleness visual treatment reuses `renderDispCurWarn()`'s established amber palette (`index.html:3807-3818`: background `#FFF8E1`, accent `#F9A825`/`#B8860B`-range) rather than inventing a new one — directly implements REQ-SUP-001c's mandatory staleness signal.

## 4. Staleness threshold setting — dedicated key, not `QR`

New Settings control, modeled directly on the existing language-select pattern (`index.html:576`, `localStorage.getItem('stackd_lang')`) rather than the `QR`/rate-calculation object:

```js
function setSupIntelThreshold(months) {
  localStorage.setItem('stackd_sup_intel_threshold_months', String(+months || 12));
}
```

A corresponding `<input type="number" id="cfg-sup-intel-threshold" min="1" ... onchange="setSupIntelThreshold(this.value)">` is added to the Settings tab (exact placement — e.g. alongside other display-preference controls — is a minor layout decision for build, not fixed here). Default `12`, read directly in `renderSupPriceHistory()` (§3) via `localStorage.getItem(...)` — no new `K` key, no new `DB` field, matching REQ-SUP-001c/FM-1's requirement exactly.

## 5. Supplier modal wiring — mirrors the existing Contacts sub-panel precedent exactly

**New HTML panel**, placed immediately after the existing `sup-con-panel` (`index.html:950-957`), same structural pattern:

```html
<div id="sup-price-panel" style="grid-column:1/-1;margin-top:14px;border-top:1px solid var(--ln);padding-top:10px;display:none;">
  <div style="font-size:.52rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--m);margin-bottom:8px;">Price History</div>
  <div id="sup-price-list" style="font-size:.5rem;margin-bottom:10px;"></div>
</div>
```

**`openSup()`** (`index.html:4263-4272`) — one new line, mirroring its existing `sup-con-panel` hide:

```js
var pricePanel = G('sup-price-panel'); if (pricePanel) pricePanel.style.display = 'none';
```

**`editSup(id)`** (`index.html:4273-4284`) — two new lines, mirroring its existing `sup-con-panel` show + render call:

```js
var pricePanel = G('sup-price-panel'); if (pricePanel) pricePanel.style.display = '';
renderSupPriceHistory();
```

No other change to either function — both already have the exact hide/show/render triple for Contacts; this is the same triple, for the new panel.

## 6. Cross-supplier product view (REQ-SUP-001d) — new report entry point

```js
function getProductPriceHistory(query) {
  var q = (query || '').toLowerCase();
  var all = [];
  DB.sup.forEach(function(s){
    getSupplierPriceHistory(s.id).forEach(function(p){
      if (!q || p.desc.toLowerCase().indexOf(q) !== -1) all.push(Object.assign({ supName: s.name, supId: s.id }, p));
    });
  });
  all.sort(function(a,b){ return (b.date||'') < (a.date||'') ? -1 : 1; });
  return all;
}
```

Reuses §1's per-supplier aggregation rather than a separate query path — every supplier's history is computed once via the existing function and simply filtered/re-tagged with `supName`, not recomputed with different logic. A UI entry point (e.g. a search box on a new "Supplier Intelligence" report accessible from the Suppliers tab) renders this the same way §3 renders the per-supplier table, with an added Supplier column — exact placement is a build-level UI decision, the data function is what this spec fixes.

## 7. REQ-SUP-001e (forward-compat only, not built) — reserved shape, no code yet

No code in this version. When `REQ-QTE-001` Part B ships, `getSupplierPriceHistory()` (§1) gains a fourth `.forEach` block reading `DB.ord[].lines[].rfqResponses[]`, filtered by `supId`, contributing `{ date, sourceType: 'rfq', sourceRef: <ord num>, desc, price: response.cost or price field, currency, status: '' }` — **explicitly never including `response.contactId`** in the pushed object, per REQ-SUP-001e's GDPR exclusion requirement. This is documented here as the shape the future integration must follow; no `rfqResponses[]` field exists yet, so nothing is added to `getSupplierPriceHistory()` in this spec.

## GDPR Data Flow

None beyond what's already reviewed. This spec adds two pure functions computing over already-existing, already-retained data (`DB.li`, `DB.qt`, `DB.po`) and one small render function — no new field, no new entity, no external transmission. The aggregated view attributes every point to a Supplier and a source record, never to a Contact — consistent with REQ-SUP-001's GDPR Assessment.

## Test Plan (`tests/run.js`)

New suite `Supplier price intelligence (SPEC-SUP-001)`:

- `getSupplierPriceHistory()` — a Supplier with one Line Item (2 price-history entries), one Quote line (1 version), one PO (1 line item) returns exactly 4 points, correctly attributed by `sourceType`.
- `getSupplierPriceHistory()` — a Supplier with no matching records in any of the three sources returns `[]`, not an error.
- `getSupplierPriceHistory()` — points use `cost`, never `landed`/`sellPrice`/`price` (sell), for the Quote-sourced point — a fixture where `cost` and `landed` differ asserts the returned `price` equals `cost`.
- `getSupplierPriceHistory()` — points are sorted newest-first across mixed sources (a PO dated after a Quote line's version date appears first, regardless of source type).
- `supPriceStaleness()` — a date 13 months ago returns a value `> 12`; a date 1 month ago returns `< 12`; `null`/empty input returns `null`, not `NaN` or a thrown error.
- `renderSupPriceHistory()` DOM test — a point older than the configured threshold renders with the stale visual marker (amber background / warning glyph); a point within the threshold does not.
- `renderSupPriceHistory()` — with no threshold ever configured (`localStorage` key absent), defaults to 12 months, not `NaN` or unstyled.
- `getProductPriceHistory()` — a query matching a product description across two different suppliers returns points from both, each correctly tagged with its own `supName`/`supId`.
- `openSup()`/`editSup()` DOM integration — `sup-price-panel` is hidden on `openSup()` (new supplier, nothing to show) and shown with `renderSupPriceHistory()` invoked on `editSup(id)` — mirrors the existing `sup-con-panel` test pattern already in the suite for the Contacts sub-panel.

## Changelog

- v1: Initial spec implementing REQ-SUP-001-v2.
