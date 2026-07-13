# SPEC-ORD-004-v1: Triage tool → Order Request CSV export

**Implements:** REQ-ORD-004-v2 (requirements-gate PASS)

Target file: the standalone triage tool (currently at `/tmp/claude-0/-home-user/0aa82536-4c70-51c8-b59f-406ba2616ba7/scratchpad/order-request-triage.html`, recolored to Stackd Ops' brand palette earlier this session — not yet committed to the `stackd-ops` repo).

## 1. New `.meta` field (REQ-ORD-014)

Add alongside the existing `mProduct`/`mBuyer`/`mDest` inputs:
```html
<input id="mEmail" type="email" placeholder="Contact email">
```
Add to the `['mProduct','mBuyer','mDest']` array (the block that wires `input` → `evaluate()`) so typing into it also re-runs `evaluate()`/button-state updates:
```js
['mProduct','mBuyer','mDest','mEmail'].forEach(id=>
  document.getElementById(id).addEventListener('input', evaluate)
);
```

## 2. Export button (REQ-ORD-015)

Add to the `.actions` div (alongside the existing Copy actions / Clear screen buttons):
```html
<button class="btn primary" id="exportOrd" style="display:none;">Download Order Request CSV</button>
```

## 3. Track current verdict (needed for button visibility)

`evaluate()` currently computes `verdict` as a local variable and never exposes it outside the function. Add a module-level variable, set at the top of each branch alongside the existing `stamp.classList.add(...)` calls:
```js
let currentVerdict = 'idle';
```
Inside `evaluate()`, wherever `verdict = 'kill'|'ask'|'part'|'go'` is already assigned, also set `currentVerdict = verdict;` (same lines, e.g. `verdict = 'go'; currentVerdict = 'go';`). For the `answered.length===0` early-return branch, set `currentVerdict = 'idle';` there too (mirrors the existing `stamp.classList.add('idle')` line).

## 4. Button visibility + email validation (REQ-ORD-015, AC-002, AC-003)

Add a call at the end of `evaluate()` (after `buildOutput(...)` is called):
```js
updateExportButton();
```
New function:
```js
function updateExportButton() {
  const btn = document.getElementById('exportOrd');
  const email = document.getElementById('mEmail').value.trim();
  if (currentVerdict !== 'go') { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.disabled = !email;
  btn.title = email ? '' : 'Enter a Contact Email above before exporting';
}
```

## 5. CSV generation (REQ-ORD-016, REQ-ORD-017, REQ-ORD-018)

```js
const ORD_HEADERS = ['Submission ID','Contact Name','Contact Email','Order Description','Category','Item/Spec','Order Volume Qty','Order Volume Unit','Packing Spec','Base UOM','Base Qty','Qty Status','Source Country','Variant/Option'];

function stripQuotes(v) { return String(v||'').replace(/"/g, ''); } // REQ-ORD-017 — guards parseImportCSV()'s inQuote-toggle-on-every-quote-char behavior against an odd embedded-quote count

function genSubmissionId() {
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  const suffix = Math.random().toString(36).slice(2,6);
  return 'TRI-' + ymd + '-' + suffix;
}

function buildOrdCsvRow(risks) {
  const product = document.getElementById('mProduct').value.trim() || '[product]';
  const buyer   = document.getElementById('mBuyer').value.trim() || '[buyer]';
  const dest    = document.getElementById('mDest').value.trim() || '[destination]';
  const email   = document.getElementById('mEmail').value.trim();

  let desc = 'Destination: ' + dest + '. Cleared via 10-Minute Triage Screen.';
  if (risks && risks.length) {
    desc += ' Open risks: ' + risks.map(function(r){ return r.t; }).join('; ') + '.';
  }

  const row = {
    'Submission ID': genSubmissionId(),
    'Contact Name': buyer,
    'Contact Email': email,
    'Order Description': desc,
    'Category': product,
    'Item/Spec': product,
    'Order Volume Qty': '', 'Order Volume Unit': '', 'Packing Spec': '',
    'Base UOM': '', 'Base Qty': '', 'Qty Status': '',
    'Source Country': '', 'Variant/Option': ''
  };
  return ORD_HEADERS.map(function(h){ return stripQuotes(row[h]); });
}

function downloadOrdCsv(risks) {
  const dataRow = buildOrdCsvRow(risks);
  const csv = ORD_HEADERS.join(',') + '\n' + dataRow.map(function(v){ return '"' + v + '"'; }).join(',');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'triage-order-request-' + dataRow[0] + '.csv'; // dataRow[0] === Submission ID
  a.click();
}
```

`evaluate()` already computes `risks` as a local array in the `go` branch — pass it through to the button's click handler via a module-level `let lastRisks = [];` set at the same point `currentVerdict = 'go'` is set (`lastRisks = risks;`), so the click handler (registered once, outside `evaluate()`) has access to the current risk list at click time:

```js
document.getElementById('exportOrd').addEventListener('click', function() {
  downloadOrdCsv(lastRisks);
});
```

## 6. Explicitly untouched

`index.html`'s `TEMPLATES.ord`, `processImport()`, `Code.gs`/`FIELD_MAPS` — this spec is confined entirely to the standalone triage tool file. `ORD_HEADERS` in this file is a **duplicated literal** of `TEMPLATES.ord.headers` (`index.html:6312`), not an import/reference (the two files have no build step connecting them) — this is the drift risk already logged as a residual risk in `REQ-ORD-004-v2`.

## Tests

Since this is a standalone HTML file outside the `stackd-ops` test harness (`tests/run.js` loads and tests `index.html`'s script blocks specifically), this spec's verification is manual/scripted separately rather than added to the existing suite:

- AC-001/AC-004/AC-006: inspect a generated CSV's header row and one data row directly (e.g. via a quick Node script reading the generated `data:` URI content, or manual download+open).
- AC-002/AC-003: exercise the tool in a browser (or headless DOM harness) across each verdict state and the email-blank/populated states, confirming `exportOrd`'s `style.display`/`disabled`.
- **AC-005 (the corrected parser-defect case) and AC-007**: the strongest verification path is copying the exact generated CSV string into a one-off Node script that loads `stackd-ops/index.html`'s script blocks the same way `tests/run.js` already does (see its VM-context setup, `tests/run.js:1-90`ish) and calls the real `parseImportCSV()`/`processImport('ord', ...)` against it — proving real cross-file compatibility, not an assumption. Recommend building this as a one-off verification script at build time, run once, rather than a permanent addition to `tests/run.js` (which tests `index.html`, not this separate file) — but the check itself must actually be run before this is considered done, not left as an assertion in the spec.

## Changelog

- v1: Initial spec, translating REQ-ORD-004-v2 into concrete changes to the standalone triage tool file.
