# SPEC-ORD-003-v1: CSV Import → Order Request wiring + Quote approval audit trail

**Implements:** REQ-ORD-003-v2 (requirements-gate PASS)

## Part A — CSV Import → Order Request

### 1. `TEMPLATES.ord` (`index.html:6263-6280`)

```js
ord: {
  headers: ['Submission ID','Contact Name','Contact Email','Order Description','Category','Item/Spec','Order Volume Qty','Order Volume Unit','Packing Spec','Base UOM','Base Qty','Qty Status','Source Country','Variant/Option'],
  example: ['WEB-0001','Thorpes Produce Inc','buyer@thorpes.example','Q3 restock','Fresh produce','Red seedless grapes','3','pallets','','','', 'Estimated','Chile','']
}
```
`dlTemplate()`'s `names` map (`index.html:6285`) gains `ord:'order-requests'`.

### 2. `processImport()` new `ord` branch (`index.html:6360` onward)

Inserted as a new `else if (entity === 'ord')` branch, following the existing structure of the `sup`/`li`/`inv`/`po` branches in the same function:

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

    var existingOrd = DB.ord.find(function(o){ return o.importBatchId === sid; });
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
    if (newLines.length === 0 && existingOrd) { return; } // nothing new to add to an existing Order Request
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
    if (saved) { existingOrd ? updated++ : added++; }
  });

  sv(K.co, DB.con); sv(K.ord, DB.ord); rCon(); rOrd(); rDash();
  var msg = 'Order Requests: ' + added + ' added, ' + updated + ' updated, ' + skipped + ' skipped' + (errors.length ? ' | ' + errors.join('; ') : '');
  G('imp-ord-result').textContent = msg; impLog(msg);
}
```

Design notes:
- **Grouping by Submission ID happens once, up front** (`bySubmission`), then each group is processed as a unit — this is what lets multiple CSV rows become one Order Request with multiple lines (REQ-ORD-004).
- **Line-level dedup on re-import** (`alreadyPresent` check, matched on `category`+`itemSpec` case-insensitive) is the mechanism satisfying REQ-ORD-006/AC-003: re-importing an existing Submission ID with one new row appends only that row, leaving the 3 already-present lines — and any operator edits already made to them via `ordLogLineUpdate()` — completely untouched. This deliberately does **not** wholesale-replace `lines[]`, since `SPEC-ORD-002`'s append-only provenance model treats a line's confirmed fields as something that should never be silently overwritten — a wholesale replace on every re-import would violate that existing design principle.
- **Reuses `saveOrd()`** (`index.html:2478` onward) rather than pushing directly to `DB.ord` — this gets the existing `contactId` validation, `num` assignment via `nextRefNum()`, and stage-transition guard for free, exactly as every other way an Order Request is created/updated already works.
- **Contact creation is a direct adaptation of `processImportRecords()`'s `co` branch** (`index.html:6731-6761`), not a new implementation — same field defaults, same `gdprBasis` derivation (`'pre_contract'` for `lead` status, which is always the status for a brand-new webform-sourced contact).

### 3. Import Data tab — new step card (`index.html:484-506` pattern)

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
Placed after the existing Purchase Orders step card, numbered `5` (following whatever the existing highest step number is — confirm exact placement/number against the live numbered sequence at build time).

## Part B — Quote approval audit trail

### 4. Quote modal — new conditional fields (`index.html:2152-2157` area)

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
Placed immediately after the existing Status field (`index.html:2152-2157`).

`updQtePoBtn()` (already called `onchange` on `qf-st`, `index.html:2153`) gains the show/hide toggle:
```js
function updQtePoBtn() {
  // ...existing logic...
  var showApproval = G('qf-st').value === 'Accepted';
  G('qf-approved-by-wrap').style.display = showApproval ? '' : 'none';
  G('qf-approved-note-wrap').style.display = showApproval ? '' : 'none';
}
```

`openQte()`/edit-populate path (wherever the Quote modal's fields are populated from an existing record — mirrors how `qf-st` itself is populated) also sets `G('qf-approved-by').value = qt.approvedBy||''` and `G('qf-approved-note').value = qt.approvedReason||''`, and calls `updQtePoBtn()` once on open so the fields show/hide correctly for an already-Accepted Quote.

### 5. `vQte()` (`index.html:8934-8942`)

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

### 6. `saveQte()` (`index.html:8944` onward)

Inside the `qt` object construction (`index.html:8980-8997`), add:
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
`wasAccepted`/`isAccepted` implement REQ-ORD-012 exactly: `approvedAt` only gets a fresh timestamp on the transition *into* `Accepted` (`!wasAccepted && isAccepted`); an already-`Accepted` Quote being re-saved keeps its original `approvedAt`.

## Explicitly untouched

`processImportRecords()`, `importFromSheets()`, `qteToPoConvert()`'s `Accepted`-status gate logic, `Code.gs`/`FIELD_MAPS` (no Sheets sync changes anywhere in this spec) — per REQ-ORD-003-v2's scope.

## Tests (`tests/run.js`)

New suite `Order Request CSV import (SPEC-ORD-003)`:
- 3 rows, same Submission ID, email matching an existing Contact → 1 Order Request, 3 lines, linked to existing contact, not a new one (AC-001).
- 1 row, Submission ID new, email matching no Contact → new Contact created (`status:'lead'`, `source:'webform'`, `gdprBasis:'pre_contract'`), Order Request linked to it (AC-002).
- Re-import same Submission ID with 1 new row + the original 3 → resulting Order Request has 4 lines, still exactly 1 Order Request record (AC-003).
- Re-import same Submission ID with only the original 3 rows again (no new content) → still exactly 3 lines, no duplicates (regression for the `alreadyPresent` guard).
- Row with blank Category and blank Item/Spec → skipped, sibling rows in the same submission still import (AC-004).
- Row with blank Contact Email → entire submission skipped (AC-005).
- `Qty Status` values `"confirmed"`, `"CONFIRMED"`, `""`, `"garbage"` → `Confirmed`, `Confirmed`, `Unknown`, `Unknown` (AC-006).

New suite `Quote approval audit trail (SPEC-ORD-003)`:
- Save with status `Accepted`, blank Approved By → blocked, `vt-verr` shows the message (AC-007).
- Save with status `Accepted`, populated Approved By → succeeds, `approvedAt` set to current time (AC-008).
- Re-save an already-`Accepted` quote, only changing Approval Note → `approvedAt` unchanged from its original value (AC-009).
- Quote never set to `Accepted` (stays Draft/Sent/Declined/Expired throughout) → `approvedBy`/`approvedReason`/`approvedAt` all blank, no regression to existing status-flow tests (AC-010).

## Changelog

- v1: Initial spec, translating REQ-ORD-003-v2 into concrete `processImport()`/`TEMPLATES`/Import Data tab changes for Order Request CSV import, and `vQte()`/`saveQte()`/Quote modal changes for the approval audit trail.
