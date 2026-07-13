# SPEC-ORD-003-v2: CSV Import → Order Request wiring + Quote approval audit trail

**Supersedes:** SPEC-ORD-003-v1
**Implements:** REQ-ORD-003-v2 (requirements-gate PASS)

## Corrections from v1 (spec-gate FAIL)

1. **`added`/`updated` counting bug, fixed.** `saveOrd()` (`index.html:2478-2507`) returns `existing || ord` on success — both truthy — and `false` only on validation failure. v1's code branched on `saved ? updated++ : added++`, which can never correctly distinguish "created" from "updated" since both success paths return a truthy value. Fixed: branch on the already-captured `existingOrd` variable (truthy = this Submission ID already existed = `updated++`; falsy = brand new = `added++`), captured *before* calling `saveOrd()`, not on `saveOrd()`'s return value.
2. **`openQte()` (new quote) explicitly addressed.** Spec-gate found `openQte()` (`index.html:8723-8741`) doesn't call `updQtePoBtn()` on open, unlike `editQte()` (`index.html:8743`, which does at line 8760). Confirmed harmless in practice (new quotes default `qf-st` to `'Draft'`, and the new approval fields default to `display:none` in HTML) — but this spec now states that explicitly rather than leaving it implicit, and adds `updQtePoBtn()` to `openQte()` too, for consistency and defense against a future default-status change.
3. **New test added** asserting the reported `added`/`updated` counts in the import result message directly (not just the resulting record/line counts), closing the coverage gap tied to fix #1.

## Part A — CSV Import → Order Request

### 1. `TEMPLATES.ord` — unchanged from v1

```js
ord: {
  headers: ['Submission ID','Contact Name','Contact Email','Order Description','Category','Item/Spec','Order Volume Qty','Order Volume Unit','Packing Spec','Base UOM','Base Qty','Qty Status','Source Country','Variant/Option'],
  example: ['WEB-0001','Thorpes Produce Inc','buyer@thorpes.example','Q3 restock','Fresh produce','Red seedless grapes','3','pallets','','','', 'Estimated','Chile','']
}
```
`dlTemplate()`'s `names` map (`index.html:6285`) gains `ord:'order-requests'`.

### 2. `processImport()` new `ord` branch (`index.html:6360` onward) — corrected

```js
else if (entity === 'ord') {
  var bySubmission = {};
  rows.forEach(function(r) {
    var sid = String(r['Submission ID']||'').trim();
    if (!sid) { skipped++; return; }
    (bySubmission[sid] = bySubmission[sid] || []).push(r);
  });

  Object.keys(bySubmission).forEach(function(sid) {
    var submissionRows = bySubmission[sid];
    var first = submissionRows[0];
    var email = String(first['Contact Email']||'').trim().toLowerCase();
    var name  = String(first['Contact Name']||'').trim();
    if (!email) { skipped += submissionRows.length; errors.push('Submission ' + sid + ': Contact Email is required, skipped'); return; }

    // Contact match-or-create — adapted from processImportRecords()'s existing `co` branch (index.html:6731-6761)
    var contact = email ? DB.con.find(function(c){ return (c.email||'').toLowerCase()===email; })
                         : DB.con.find(function(c){ return c.name===name; });
    if (!contact) {
      contact = { id: uid(), name: name || email, email: email, phone: '', company: '',
        status: 'lead', source: 'webform', enquirySummary: '', notes: '',
        createdAt: now, lastContactedAt: now, gdprBasis: 'pre_contract', enquiries: [] };
      DB.con.push(contact);
    }

    var existingOrd = DB.ord.find(function(o){ return o.importBatchId === sid; }); // captured BEFORE saveOrd() — this is what added/updated branches on, not saveOrd()'s return value
    var existingLines = existingOrd ? (existingOrd.lines || []) : [];
    var newLines = [];
    submissionRows.forEach(function(r) {
      var category = String(r['Category']||'').trim();
      var itemSpec = String(r['Item/Spec']||'').trim();
      if (!category && !itemSpec) { skipped++; return; }
      var alreadyPresent = existingLines.some(function(l){
        return (l.category||'').toLowerCase()===category.toLowerCase() && (l.itemSpec||'').toLowerCase()===itemSpec.toLowerCase();
      });
      if (alreadyPresent) return; // don't duplicate or overwrite an existing line's operator progress
      var qtyStatusRaw = String(r['Qty Status']||'').trim().toLowerCase();
      var qtyStatus = ['unknown','estimated','confirmed'].indexOf(qtyStatusRaw) >= 0
        ? qtyStatusRaw.charAt(0).toUpperCase() + qtyStatusRaw.slice(1) : 'Unknown';
      newLines.push({
        id: uid(), category: category, itemSpec: itemSpec,
        orderVolumeQty: String(r['Order Volume Qty']||'').trim(),
        orderVolumeUnit: String(r['Order Volume Unit']||'').trim(),
        packingSpec: String(r['Packing Spec']||'').trim(),
        baseUom: String(r['Base UOM']||'').trim(),
        baseQty: r['Base Qty'] ? parseFloat(r['Base Qty']) : null,
        qtyStatus: qtyStatus,
        sourceCountry: String(r['Source Country']||'').trim(),
        variantOption: String(r['Variant/Option']||'').trim(),
        lineUpdates: []
      });
    });
    if (newLines.length === 0 && existingOrd) { return; } // nothing new to add to an existing Order Request — not counted as added or updated
    if (newLines.length === 0 && !existingOrd) { skipped++; return; } // no valid lines at all for a brand-new submission

    var ordObj = {
      id: existingOrd ? existingOrd.id : undefined,
      contactId: contact.id,
      stage: existingOrd ? existingOrd.stage : 'New',
      description: String(first['Order Description']||'').trim() || (existingOrd ? existingOrd.description : ''),
      importBatchId: sid,
      lines: existingLines.concat(newLines),
      actions: existingOrd ? existingOrd.actions : []
    };
    var saved = saveOrd(ordObj);
    if (saved) {
      if (existingOrd) { updated++; } else { added++; } // branch on existingOrd (captured pre-call), never on saveOrd()'s return value — both success paths return a truthy object
    }
  });

  sv(K.co, DB.con); sv(K.ord, DB.ord); rCon(); rOrd(); rDash();
  var msg = 'Order Requests: ' + added + ' added, ' + updated + ' updated, ' + skipped + ' skipped' + (errors.length ? ' | ' + errors.join('; ') : '');
  G('imp-ord-result').textContent = msg; impLog(msg);
}
```

Design notes (unchanged from v1, still verified correct by spec-gate):
- Grouping by Submission ID up front lets multiple rows become one multi-line Order Request.
- Line-level dedup on re-import (`alreadyPresent`, matched on `category`+`itemSpec`) is what satisfies REQ-ORD-006/AC-003 without wholesale-replacing `lines[]` — preserving any operator progress made via `ordLogLineUpdate()`.
- Reuses `saveOrd()` for validation/`num` assignment/stage handling, exactly as every other Order Request creation path.
- `saveOrd()` returning `false` (contact validation failure) is not reachable in this call path, since `contact.id` is always either freshly created via `uid()` or matched against an existing `DB.con` record — this dead branch is intentional, not a gap; `saved` is still checked defensively in case that invariant ever changes.

### 3. Import Data tab — new step card — unchanged from v1

```html
<div class="card">
  <div class="ct"><span style="background:var(--cr);color:white;font-family:'Bebas Neue',sans-serif;font-size:.9rem;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">5</span>Order Requests</div>
  <p style="font-size:.6rem;color:var(--m);margin-bottom:12px;line-height:1.7;">Upload structured purchase requirements collected from a webform or similar intake source. Rows sharing a Submission ID become one Order Request with multiple lines. Contacts are matched by email or created automatically.</p>
  <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="dlTemplate('ord')">&#8595; Download Template</button>
    <button class="btn btn-s" onclick="G('ul-ord').click()">&#8593; Upload Order Requests CSV</button>
    <input type="file" id="ul-ord" accept=".csv" style="display:none" onchange="bulkUpload('ord',this)">
  </div>
  <div id="imp-ord-result" style="font-size:.58rem;color:var(--m);min-height:16px;"></div>
</div>
```

## Part B — Quote approval audit trail

### 4. Quote modal — new conditional fields — unchanged from v1

```html
<div class="fld" id="qf-approved-by-wrap" style="display:none;">
  <label>Approved By</label>
  <input type="text" id="qf-approved-by">
</div>
<div class="fld" id="qf-approved-note-wrap" style="display:none;">
  <label>Approval Note</label>
  <input type="text" id="qf-approved-note">
</div>
```
Placed immediately after the existing Status field (`index.html:2152-2157`). Default HTML `display:none` means both `openQte()` (new quote) and `editQte()` (edit existing) are safe by default even without an explicit `updQtePoBtn()` call — but both now call it explicitly anyway (see below), so the fields' visibility is always driven by the actual current `qf-st` value, not just an untouched default.

`updQtePoBtn()` gains the show/hide toggle:
```js
function updQtePoBtn() {
  // ...existing logic...
  var showApproval = G('qf-st').value === 'Accepted';
  G('qf-approved-by-wrap').style.display = showApproval ? '' : 'none';
  G('qf-approved-note-wrap').style.display = showApproval ? '' : 'none';
}
```

**New in v2**: both `openQte()` (`index.html:8723-8741`) and `editQte()` (`index.html:8743`, which already calls `updQtePoBtn()` at line 8760) call `updQtePoBtn()` on open. `openQte()` currently does not (spec-gate finding #2) — add the call there too, alongside setting `qf-approved-by`/`qf-approved-note` to `''` for a brand-new quote (consistent with every other field being reset to blank/default on `openQte()`).

`editQte()`'s existing field-population block also sets:
```js
G('qf-approved-by').value = qt.approvedBy||'';
G('qf-approved-note').value = qt.approvedReason||'';
```
immediately alongside its existing `qf-st` population, before its existing `updQtePoBtn()` call at line 8760 (so the toggle reflects the freshly-populated status).

### 5. `vQte()` (`index.html:8934-8942`) — unchanged from v1

```js
function vQte() {
  var errs = [];
  if (!G('qf-client').value.trim()) errs.push('Client name is required');
  if (!G('qf-dt').value)            errs.push('Quote date is required');
  if (!cQL.length)                  errs.push('Add at least one line item');
  if (G('qf-st').value === 'Accepted' && !G('qf-approved-by').value.trim())
    errs.push('Approved By is required when status is Accepted');
  if (errs.length) { G('qt-verr').textContent = errs.join(' · '); return false; }
  G('qt-verr').textContent = '';
  return true;
}
```

### 6. `saveQte()` (`index.html:8944` onward) — unchanged from v1, confirmed `existQ` in scope by spec-gate

```js
var wasAccepted = existQ && existQ.status === 'Accepted';
var isAccepted  = G('qf-st').value === 'Accepted';
var qt = {
  // ...existing fields unchanged...
  approvedBy: isAccepted ? G('qf-approved-by').value.trim() : (existQ ? existQ.approvedBy||'' : ''),
  approvedReason: isAccepted ? G('qf-approved-note').value.trim() : (existQ ? existQ.approvedReason||'' : ''),
  approvedAt: isAccepted
    ? (wasAccepted ? (existQ.approvedAt||new Date().toISOString()) : new Date().toISOString())
    : (existQ ? existQ.approvedAt||'' : '')
};
```

## Explicitly untouched

`processImportRecords()`, `importFromSheets()`, `qteToPoConvert()`'s `Accepted`-status gate logic, `Code.gs`/`FIELD_MAPS`.

## Tests (`tests/run.js`)

Same as v1, plus (new in v2, closes the spec-gate coverage gap):
- **New**: import 3 rows under one new Submission ID → assert the reported message shows `1 added, 0 updated`; then re-import with a 4th row under the same Submission ID → assert `0 added, 1 updated` on the second call — directly exercises the fixed `existingOrd`-based branch, not just the resulting line/record counts.

All other v1 test items unchanged: AC-001 through AC-010 coverage as previously specified.

## Changelog

- v2: Fixed the `added`/`updated` counting logic to branch on the pre-captured `existingOrd` variable instead of `saveOrd()`'s return value (both success paths return truthy, making the v1 code unable to distinguish create from update); added `updQtePoBtn()` to `openQte()` for consistency with `editQte()`; added an explicit test asserting the reported added/updated counts.
- v1: Initial spec (superseded — counting bug).
