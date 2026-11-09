# SPEC-RPT-003 v1 — Accounting Export reads real invoice line shape

**Requirement:** `docs/REQ-RPT-003-v13.md` (FINAL; operator-accepted after a single confirmatory round, a deliberate departure from the three-clean-rounds rule, recorded in the delivery report).
**Baseline:** `main` @ `ecfa6cb`, v2.9.95, 1111/1111 tests. **Target:** v2.9.96. **Files touched:** `index.html`, `tests/run.js`, `.gitignore`, `CLAUDE.md`, `docs/*`. No `localStorage`/Cloud Data/schema change (REQ-9), so `schema-migration-reviewer` is N/A and this is stated, not skipped silently.

## 0. Citation note
Run `node scripts/check-req-citations.js docs/SPEC-RPT-003-v1.md` before each gate submission. All `index.html:NNN` below are on the baseline and will move after the edit; the build uses function names, not line numbers.

## 1. Overview of changes (all in `index.html` unless stated)

| # | Change | REQ |
|---|---|---|
| 1 | `openAcctExport()` opens via `classList.add('on')`, resets format, calls `acctExpEntityChanged()` | 1, 2 |
| 2 | Modal markup: radio ids/`name`/`value`, label ids, `onchange` handlers, `acct-exp-cancel-note` | 2, 7.3 |
| 3 | New helpers: `acctIsCnRec`, `acctIsDemo`, `acctExportSets`, `acctInvLines`, `acctNum`, `acctLineCalc`, `acctExpEntity`, `acctExpSelectedFmt`, `acctExpApplyFormatState`, `acctExpRefreshWarnings`, `acctExpFormatChanged`, `acctExpEntityChanged` | 2, 3-7 |
| 4 | `acctInvCSV`, `acctXeroCSV`, `acctQBCSV`, `acctQualityCheck` rewritten on `acctInvLines`/`acctLineCalc` | 3-7 |
| 5 | `doAcctExport()` uses `acctExportSets()`, ordered toasts, REQ-7.6a | 7 |
| 6 | `.gitignore` +7 patterns; `CLAUDE.md` public-repo row rewritten | 10 |
| 7 | Tests, docs, version delivery | AC1-AC26 |

Unchanged: `csvRow`, `dlText`, `acctPmtCSV`, `acctFACSV`, `acctInvJSON`, `acctPmtJSON` (they receive filtered arrays), `cInv`, `iCalc`, `repairCalcFields`, `saveInv`, all storage.

## 2. Helpers (insert immediately above `acctInvCSV`)

```js
// ── ACCOUNTING EXPORT HELPERS (REQ/SPEC-RPT-003) ───────────────
function acctNum(x) { return +x || 0; }                       // REQ-5.1 coercion, same as cInv()
function acctIsFiniteNum(x) { return typeof x === 'number' && isFinite(x); }
function acctIsCnRec(r) {                                      // same predicate as rInv()/cInv()
  return !!(r && (r.type === 'credit_note' || r.type === 'goodwill_credit' || (!r.type && isCN(r.num))));
}
function acctIsDemo(r) {                                       // REQ-7.2
  return !!(r && (r._demo || (typeof r.id === 'string' && r.id.indexOf('demo-') === 0)));
}
function acctExportSets() {                                    // side-effect-free; reads global DB
  return {
    invoices: (DB.inv || []).filter(function(i) { return !acctIsDemo(i); }),
    payments: (DB.payments || []).filter(function(p) { return !acctIsDemo(p); })
  };
}
function acctInvLines(inv) {                                   // REQ-3 single line-source rule
  if (Array.isArray(inv.lineItems) && inv.lineItems.length) return { lines: inv.lineItems, legacy: false };
  if (Array.isArray(inv.lines) && inv.lines.length)         return { lines: inv.lines,     legacy: true  };
  return { lines: [], legacy: false };
}
function acctSupName(id) {                                     // '' when unresolved or blank name (REQ-6)
  if (!id) return '';
  var s = DB.sup.find(function(x) { return x.id === id; });
  return (s && s.name) ? s.name : '';
}
function acctLineCalc(l, legacy) {                             // one line -> every exported value
  var cat = (!legacy && l.lid) ? DB.li.find(function(x) { return x.id === l.lid; }) : undefined; // blank lid never resolves; first match, as cInv()
  var qty = acctNum(l.qty), up = acctNum(l.up);
  var storedRaw = legacy ? l.cu : l.unitCost;
  var cost = cat ? acctNum(cat.cost) : acctNum(storedRaw);     // REQ-5.1: catalogue cost when lid resolves, else stored; legacy uses cu
  var sku = (cat && cat.sku) ? cat.sku : ((legacy && l.sku) ? l.sku : '');   // REQ-4
  var supplier = acctSupName(l.supId) || (cat ? acctSupName(cat.supId) : '');  // REQ-6
  return {
    qty: qty, up: up, cost: cost, sku: sku, supplier: supplier,
    lineType: l.lineType || 'product',
    storedCol: acctIsFiniteNum(storedRaw) ? storedRaw : '',     // REQ-5.2 raw, no toFixed
    catalogueCol: (cat && acctIsFiniteNum(cat.cost)) ? cat.cost : '',
    total: qty * up, cogs: qty * cost
  };
}
```

Notes: `legacy` lines never consult the catalogue (REQ-5.1: they use `cu`); the REQ-4 legacy-SKU fallback therefore reduces to "legacy line's own `sku`". If this is judged wrong at build-gate, the REQ text governs. A numeric-string `unitCost`/`cost` is coerced for COGS by `acctNum` but yields an empty display column because `acctIsFiniteNum` requires a real number (accepted edge, REQ-5.1).

## 3. Exporters (rewrite bodies; signatures unchanged)

`acctInvCSV(invoices)`: header = the existing 19 names followed by `'Unit Cost (stored on line)','Unit Cost (catalogue now)','Line Type','Supplier'`. For each invoice: `if (acctIsCnRec(inv)) return;` (REQ-7.4); `var src = acctInvLines(inv);` for each `l, idx` of `src.lines`: `var c = acctLineCalc(l, src.legacy); var taxRate = +(inv.taxRate||0);` row = existing 19 values with `qty=c.qty`, `up=c.up`, `Line Total=c.total.toFixed(2)`, `COGS=c.cogs.toFixed(2)`, `Gross Profit=(c.total-c.cogs).toFixed(2)`, `Tax Amount=(c.total*taxRate).toFixed(2)`, `SKU=c.sku`, then `c.storedCol, c.catalogueCol, c.lineType, c.supplier`.

`acctXeroCSV(invoices)` / `acctQBCSV(invoices)`: same skip and `acctInvLines` source; `qty=acctNum(l.qty)`, `up=acctNum(l.up)`; columns and tax logic otherwise exactly as today (no new columns, REQ-6). Xero `TaxAmount = +(qty*up*taxRate).toFixed(2)`.

`acctQualityCheck(invoices, payments)`: for each invoice: skip `acctIsCnRec`; keep Incoterm and Payment Terms warnings; `var src = acctInvLines(inv); if (!src.lines.length) warns.push('Invoice ' + inv.num + ': no line items, not included in line-level CSV exports');` else for each line `if (!(acctNum(l.qty) * acctNum(l.up))) warns.push('Invoice ' + inv.num + ' line ' + (i+1) + ': zero-value line item');`; keep the `invId`-only payment match (§4 of REQ).

## 4. `doAcctExport()`

```js
function doAcctExport() {
  var entity = acctExpEntity();
  var fmt = acctExpSelectedFmt();
  if (!fmt) { toast('Select a format'); return; }
  var sets = acctExportSets();
  var list = entity === 'inv' ? sets.invoices : sets.payments;
  if (!list.length) { toast(entity === 'inv' ? 'No invoices to export' : 'No payments to export'); return; }   // empty-set first (AC23)
  var okFmts = entity === 'inv' ? ['generic-csv','generic-json','xero','qb'] : ['generic-csv','generic-json','fa'];
  if (okFmts.indexOf(fmt) < 0) { toast('Unsupported format for this entity'); return; }
  var content, filename, mime;
  if (entity === 'inv') {
    var lineFmt = (fmt === 'generic-csv' || fmt === 'xero' || fmt === 'qb');
    if (lineFmt && !sets.invoices.some(function(i) { return !acctIsCnRec(i) && acctInvLines(i).lines.length; })) {
      toast('No invoice lines to export (see warnings)'); return;                                   // REQ-7.6a: stays open, no download
    }
    if      (fmt === 'generic-csv')  { content = acctInvCSV(list);  filename = 'Stackd-Acct-Invoices-' + today() + '.csv';  mime = 'text/csv'; }
    else if (fmt === 'generic-json') { content = acctInvJSON(list); filename = 'Stackd-Acct-Invoices-' + today() + '.json'; mime = 'application/json'; }
    else if (fmt === 'xero')         { content = acctXeroCSV(list); filename = 'Stackd-Xero-Invoices-'  + today() + '.csv';  mime = 'text/csv'; }
    else                             { content = acctQBCSV(list);   filename = 'Stackd-QB-Invoices-'    + today() + '.csv';  mime = 'text/csv'; }
  } else {
    if      (fmt === 'generic-csv')  { content = acctPmtCSV(list);  filename = 'Stackd-Acct-Payments-'      + today() + '.csv';  mime = 'text/csv'; }
    else if (fmt === 'generic-json') { content = acctPmtJSON(list); filename = 'Stackd-Acct-Payments-'      + today() + '.json'; mime = 'application/json'; }
    else                             { content = acctFACSV(list);   filename = 'Stackd-FreeAgent-Payments-' + today() + '.csv';  mime = 'text/csv'; }
  }
  dlText(filename, content, mime);
  toast('Export downloaded');
  closeM('ov-acct-exp');
}
```
The old `if (!content)` backstop is replaced by the explicit `okFmts` check, which is what AC20 exercises. Filenames are unchanged from the baseline (REQ-10 depends on them).

## 5. Modal UI

**Markup** (replace the Entity select and Format block, keep everything else):
- `<select id="acct-exp-entity" onchange="acctExpEntityChanged()">` with the two existing options.
- Each radio: `<label id="acct-fmt-label-<v>" ...><input type="radio" id="acct-fmt-<v>" name="acct-fmt" value="<v>" onchange="acctExpFormatChanged()"> <existing text></label>`, for `<v>` in `generic-csv`, `generic-json`, `xero`, `qb`, `fa`. Label texts unchanged ("Generic CSV", "Generic JSON", "Xero (Invoices only)", "QuickBooks (Invoices only)", "FreeAgent Bills (Payments only)").
- After the format block: `<div id="acct-exp-cancel-note" style="display:none;margin-top:10px;background:var(--gold);padding:6px 8px;border-radius:4px;font-size:.5rem;">Cancelled invoices are included in this export. Xero and QuickBooks have no status column, so exclude them in your accounting package.</div>`.
- Download button keeps `onclick="doAcctExport()"`; close buttons keep `closeM('ov-acct-exp')`.

**Functions**
```js
var ACCT_FMT_ENTITIES = { 'generic-csv':['inv','pmt'], 'generic-json':['inv','pmt'], 'xero':['inv'], 'qb':['inv'], 'fa':['pmt'] };
function acctExpEntity() { var e = G('acct-exp-entity'); return (e && e.value === 'pmt') ? 'pmt' : 'inv'; }
function acctExpSelectedFmt() { var f = ''; document.querySelectorAll('input[name="acct-fmt"]').forEach(function(r) { if (r.checked) f = r.value; }); return f; }
function acctExpSetFmt(v) { Object.keys(ACCT_FMT_ENTITIES).forEach(function(k) { var r = G('acct-fmt-' + k); if (r) r.checked = (k === v); }); }
function acctExpApplyFormatState() {
  var entity = acctExpEntity();
  Object.keys(ACCT_FMT_ENTITIES).forEach(function(v) {
    var ok = ACCT_FMT_ENTITIES[v].indexOf(entity) >= 0, r = G('acct-fmt-' + v), lbl = G('acct-fmt-label-' + v);
    if (r) r.disabled = !ok;
    if (lbl) { lbl.title = ok ? '' : (ACCT_FMT_ENTITIES[v][0] === 'inv' ? 'Invoices only' : 'Payments only'); lbl.style.opacity = ok ? '1' : '0.5'; }
  });
  var cur = acctExpSelectedFmt();
  if (!cur || ACCT_FMT_ENTITIES[cur].indexOf(entity) < 0) acctExpSetFmt('generic-csv');   // fallback (REQ-2.2b)
}
function acctExpRefreshWarnings() {
  var el = G('acct-exp-warnings'); if (!el) return;
  var warns = [];
  if (acctExpEntity() === 'inv') { var sets = acctExportSets(); warns = acctQualityCheck(sets.invoices, sets.payments); }   // REQ-7.7
  el.innerHTML = warns.length ? ('<div style="background:var(--gold);padding:8px 10px;border-radius:4px;font-size:.5rem;margin-bottom:10px;"><strong style="font-size:.52rem;">&#9888; Data Quality Warnings</strong><ul style="margin:4px 0 0;padding-left:16px;">' + warns.map(function(w) { return '<li>' + san(w) + '</li>'; }).join('') + '</ul></div>') : '';
}
function acctExpFormatChanged() {
  var n = G('acct-exp-cancel-note'); if (!n) return;
  var f = acctExpSelectedFmt();
  n.style.display = (acctExpEntity() === 'inv' && (f === 'xero' || f === 'qb')) ? 'block' : 'none';
}
function acctExpEntityChanged() { acctExpApplyFormatState(); acctExpRefreshWarnings(); acctExpFormatChanged(); }
function openAcctExport(entity) {
  var entEl = G('acct-exp-entity'); if (entEl) entEl.value = (entity === 'pmt') ? 'pmt' : 'inv';
  acctExpSetFmt('generic-csv');            // REQ-2.1 always reset on open
  acctExpEntityChanged();
  G('ov-acct-exp').classList.add('on');   // REQ-1: the pattern of the other report modals; no openM helper
}
```
`san()` escapes warning text (all warnings include invoice numbers, user data). The warnings HTML wrapper matches the pre-existing markup.

## 6. `.gitignore` and `CLAUDE.md` (REQ-10)

Append to `.gitignore` under a comment `# App-generated exports and triage downloads — public repo, never commit (SEC-GAP-020)`:
```
Stackd-*.csv
Stackd-*.json
VAT-*.csv
aging-report-*.csv
pl-report-*.csv
stackd-load-summary-*.txt
triage-order-request-*.csv
```
`CLAUDE.md` Public-repo-policy row: replace "`.gitignore` blocks `Test-data/` and `Stackd-*.json`" with "`.gitignore` blocks `Test-data/`, `*.backup.json`, `.DS_Store` and the export patterns `Stackd-*.csv`, `Stackd-*.json`, `VAT-*.csv`, `aging-report-*.csv`, `pl-report-*.csv`, `stackd-load-summary-*.txt`, `triage-order-request-*.csv`; this is a guard against accidentally committing a downloaded file, not a transmission control."

## 7. Tests (`tests/run.js`) — mapping to AC

**Harness changes (AC14).** (a) A `makeRadioGroup()` mock: five radio objects `{id,value,checked,disabled}` where setting `.checked = true` on one clears the others; `document.querySelectorAll('input[name="acct-fmt"]')` returns them (a `forEach` over the array) — installed by swapping `ctx.document.querySelectorAll` inside each test and restored in a `finally`, never globally. (b) Label mocks via `mockEl('acct-fmt-label-<v>')` (plain objects, `title`, `style`); `acct-exp-cancel-note` via `mockEl`. (c) Download capture via the `createElement` swap used at `tests/run.js:15272`, recording `a.download` and the decoded `a.href` payload. (d) Reset in a new `acctTestCleanup()` helper any `mockEl` value the tests touched (`acct-exp-entity`, warnings innerHTML, notice display), per the module-level-`mockEl` leak documented in `CLAUDE.md`.

| AC | Test(s) |
|---|---|
| AC1 | `openAcctExport('inv')`/`('pmt')` do not throw; `mockEl('ov-acct-exp').classList.contains('on')` (fails on baseline: `ReferenceError`). |
| AC2, AC15 | reset to Generic CSV on open after a non-default selection; Entity change disables/enables, titles `Invoices only`/`Payments only`, opacity `'0.5'`/`'1'`, title `''` on re-enable; fallback; notice `style.display` rules incl. JSON hidden; open-with-`'pmt'` applies disabled state; warnings innerHTML empty for Payments. |
| AC3, AC4, AC8 | `doAcctExport()` default format downloads; real-shape and `saveInv()`-built invoice give one row per line in Generic CSV/Xero/QB; JSON holds `lineItems`; payments `fa` and `generic-csv` download. |
| AC5-AC7, AC22, AC24 | SKU/legacy/stray `sku`/`cu`; cost columns raw/empty rules; `(+x||0)` with `"abc"`; Gross Profit/Tax/Line Total by value; both legacy fixtures (`lineItems` absent and `[]`). |
| AC6 | exact raw first-line header (19 + 4) and Line Type/Supplier values; Xero/QB headers unchanged. |
| AC9, AC25 | demo by flag, by `demo-` id (flag stripped), absent/non-string `id`, negative ids `my-demo-1`/`demo1`/`Demo-x`; cancelled retained; CN in JSON only; CN-only/no-line dataset toast and no download, modal stays open. |
| AC10 | test-local parity helper (`parseImportCSV` on `acctInvCSV([inv])`, sum `COGS` column): fixtures per class incl. `calc_cogs` 0/absent control, `unitCost:null` control; displayed-vs-live difference fixture. |
| AC11 | mutation list from REQ (see §9). |
| AC12 | existing `acctInvCSV`/Xero/QB/`acctQualityCheck` tests rewritten to real shape, every assertion kept; one legacy-shape test per exporter retained. |
| AC17 | static markup/wiring test: isolate the `ov-acct-exp` overlay by counting `<div`/`</div>` from `id="ov-acct-exp"` in `index.html` read at `tests/run.js:142`; assert found; regex checks (b)-(g) of the AC; handler regex tolerates the `\'` escape in the Payments button inside `renderPaymentsTab` (`openAcctExport\(\\?'pmt\\?'\)`); call-expression extraction = `/([A-Za-z_$][\w$]*)\s*\(/g` over each inline handler attribute minus the keyword/`event`/`this` allowlist, each checked with `typeof ctx[name] === 'function'`. |
| AC18, AC26 | docs deliverable checks (known-gaps/tracker/CLAUDE.md rows, user-guide caveat) — string assertions on the files. |
| AC19 | snapshot `JSON.stringify(DB)` and all `localStorage` keys before/after each export call: unchanged. |
| AC20, AC23 | backstop and precedence: Payments+Xero, Invoices+FreeAgent, both with empty and non-empty sets. |
| AC21 | `child_process.execSync('git check-ignore -q <name>')` per sample (seven families incl. `triage-order-request-SUB123.csv`) plus negative `stackd-compliance-reviewer-prompt.md` and `index.html`; captured real filenames from AC25 export; `CLAUDE.md` row contains the seven patterns, not the old string; NOT RUN reporting if `git` is absent. |

Expected test count: baseline 1111 plus roughly 55-70 new tests; the final number is reported against the baseline in the delivery report.

## 8. Recipe (post-deploy, definition for REQ-8; not shipped code)
After deploy the operator runs, in the console of their real profile, a loop over `acctExportSets().invoices` that for each invoice prints only: ordinal index, class (1 CN / 2 no-line / 3 legacy / 4 stored-COGS / 5 parity-tested), `sumCOGS` (parsed from `acctInvCSV([inv])` with `parseImportCSV`), `cInv(inv).cogs`, `iCalc(inv).cogs`, and the count of drift lines (`lid` resolves, stored `unitCost` and catalogue `cost` both `typeof 'number' && isFinite`, `abs diff > 0.005`). The author first runs the same loop against the AC10 fixtures in the harness to prove it executes. Output is relayed to the session only (REQ-8 disclosure channel).

## 9. Mutation plan (revert in a scratch copy, confirm the predicted test fails, restore)
1. `openAcctExport` back to `openM` → AC1, AC17 fail. 2. `acctInvLines` reading only `lines` → AC4/AC8/AC7 (legacy kept) fail for the real-shape tests. 3. Remove `acctIsCnRec` skip in one exporter → AC9. 4. Remove `acctIsDemo` id route → AC9 (flag-stripped case). 5. Drop the flag route → AC9. 6. Gross Profit from stored `unitCost` → AC24. 7. `(+x||0)` → `+(x||0)` in Xero → AC24. 8. Remove `acct-exp-warnings` div / rename `<option value>` / point Download at `closeM` → AC17. 9. Delete one `.gitignore` pattern incl. triage → AC21. 10. Remove the `okFmts` check → AC20/AC23. 11. Remove 7.6a guard → AC25.

## 10. Documentation and version delivery (v2.9.96)
- Version strings: `<title>`, nav badge, `AI_SYSTEM_PROMPT` self-description (grep `v2.9.95`; leave historical changelog mentions).
- `AI_SYSTEM_PROMPT`: add a short Accounting Export paragraph (opens from Invoices tab / Payments view; formats; demo excluded; cancelled included; line-level CSV caveats; new Generic CSV columns).
- In-app changelog block v2.9.96 and `docs/version-history.md` row: aggregate wording only; include the Xero/QB cancelled caveat and ACCT-GAP-005.
- `docs/user-guide.md`: new "Accounting Export" section (opening, default format, disabled options, new columns, demo/cancelled/credit-note/no-line behaviour, Xero/QB cancelled caveat, ACCT-GAP-005 caveat, never commit exports).
- `docs/known-gaps.md`: ACCT-GAP-002, 003 (Fixed v2.9.96; note no test covered the entry point), ACCT-GAP-004 (Open, description "undetermined, pending post-deploy run"), ACCT-GAP-005 (Open), RPT-GAP-001 (Open). `docs/requirements-tracker.md`: REQ-RPT-003/SPEC-RPT-003 rows (status, version, gate results incl. the accepted departure, test-count delta). The external Sheet rows are handed to Carms in the delivery report.
- `CLAUDE.md`: current version, test count, branch row, known-gaps rows, public-repo row (§6). `STACKD_CONTEXT.md` backlog: the durable post-deploy-recipe row, ACCT-GAP-004/005/RPT-GAP-001 rows.
- PR against `main` with the user-visible manual-check procedure (REQ AC13) in the description; aggregate counts only.

## 11. Risks / open points for spec-gate
- Legacy lines deliberately skip the catalogue (REQ-5.1/REQ-4): confirm this reading.
- `acctQualityCheck` still matches payments by `invId` only (REQ §4); the pre-existing "no payments recorded" warning can therefore be wrong for `invNum`-only payments.
- The `child_process` call in AC21 runs only under Node; it must not break the browser-global harness (guard `typeof require`).
- ACCT-GAP-005 (charges/deposit/tax-on-charges) is knowingly not fixed here.
