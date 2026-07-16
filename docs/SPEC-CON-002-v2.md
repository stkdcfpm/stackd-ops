# SPEC-CON-002-v2: Contacts CSV upload button

**Implements:** REQ-CON-002-v2 (requirements-gate PASS)

**Supersedes:** SPEC-CON-002-v1 (spec-gate FAIL — the proposed `co` branch silently dropped the `r['Created At']`/`r['Last Contacted']` CSV-column fallbacks present in `processImportRecords()`'s `co` branch, contradicting the spec's own "field-for-field"/"verbatim" claim and REQ-CON-002b's literal wording; and AC-008's test-plan bullet asserted coverage without a concrete test line)

## 1. `TEMPLATES.co` entry (`index.html:6398-6419`)

```js
var TEMPLATES = {
  sup: { ... },
  li: { ... },
  inv: { ... },
  po: { ... },
  ord: { ... },
  co: {
    headers: ['Name','Email','Phone','Company','Status','Source','Enquiry Summary','Notes'],
    example: ['Jane Buyer','jane@example.com','+1 246 555 0100','Island Fresh Imports Ltd','lead','manual','Interested in Q3 restock of frozen produce','Follow up after site visit']
  }
};
```

`dlTemplate()`'s `names` map (`index.html:6424`) gains `co:'contacts'`:

```js
var names = { sup:'suppliers', li:'line-items', inv:'invoices', po:'purchase-orders', ord:'order-requests', co:'contacts' };
```

Note: `TEMPLATES.co.headers` intentionally does not include `Created At`/`Last Contacted` columns — this is a downloadable-template UX decision (these are system-managed timestamps, not something an operator typically has hand ready to type into a CSV), not a signal to drop the corresponding read-keys from the `co` branch itself. See §2's corrected code, which retains both fallback reads verbatim — they simply evaluate to `undefined`/falsy on this path today since the template doesn't populate them, exactly as they would for any other CSV missing those optional columns.

## 2. `co` branch in `processImport()` — new, placed immediately before the `ord` branch (`index.html:6637`)

Field logic and validation copied **field-for-field, with no omissions**, from `processImportRecords()`'s existing `co` branch (`index.html:6945-6975`), adapted only for CSV-row keys (`processImport()`'s branches read straight from parsed CSV row objects, no `entity`/`callback` wrapper):

```js
else if (entity === 'co') {
  rows.forEach(function(r) {
    var email = String(r['Email']||r['email']||'').trim().toLowerCase();
    var name  = String(r['Name']||r['name']||'').trim();
    if (!name && !email) { skipped++; return; }
    var existing = email ? DB.con.find(function(c){ return (c.email||'').toLowerCase()===email; })
                         : DB.con.find(function(c){ return c.name===name; });
    var validStatuses = ['lead','qualified','converted','closed'];
    var status = validStatuses.indexOf(String(r['Status']||'').toLowerCase()) >= 0
      ? String(r['Status']).toLowerCase() : 'lead';
    var gdprBasis = (status === 'lead' || status === 'qualified') ? 'pre_contract' : 'legitimate_interests';
    var rec = {
      id: existing ? existing.id : uid(),
      name: name || (existing ? existing.name : ''),
      email: email || (existing ? existing.email : ''),
      phone: String(r['Phone']||r['phone']||existing&&existing.phone||''),
      company: String(r['Company']||r['company']||existing&&existing.company||''),
      status: status,
      source: String(r['Source']||r['source']||existing&&existing.source||'manual'),
      enquirySummary: String(r['Enquiry Summary']||r['enquirySummary']||existing&&existing.enquirySummary||''),
      notes: String(r['Notes']||r['notes']||existing&&existing.notes||''),
      createdAt: existing ? existing.createdAt : (r['Created At']||now),
      lastContactedAt: r['Last Contacted']||existing&&existing.lastContactedAt||now,
      gdprBasis: gdprBasis,
      enquiries: existing ? existing.enquiries : []
    };
    if (existing) { var i=DB.con.findIndex(function(c){return c.id===existing.id;}); DB.con[i]=rec; updated++; impLog('Updated contact: '+(name||email)); }
    else { DB.con.push(rec); added++; }
  });
  sv(K.co, DB.con);
  var msg = 'Contacts: '+added+' added, '+updated+' updated, '+skipped+' skipped';
  G('imp-co-result').textContent = msg; impLog(msg); rCon();
}
```

Notes tying this to REQ-CON-002b/d:
- Email-priority dedup, `validStatuses` list, `gdprBasis` derivation, the `existing&&existing.field||''` field-preservation pattern, and now the `createdAt`/`lastContactedAt` fallback reads are copied verbatim from `processImportRecords()`'s `co` branch — no new rule invented, no field silently dropped (corrects SPEC-CON-002-v1's drift).
- `source` defaults to `'manual'` (matching `processImportRecords()`'s own default), distinguishing this path from `'webform'` (Order Request CSV auto-created contacts, `index.html:6657`) and whatever a Sheets-pulled record's `Source` column supplies.
- `sv(K.co, DB.con)`, the `'Contacts: N added, N updated, N skipped'` message format, `impLog()`, and `rCon()` match every other branch's pattern exactly (REQ-CON-002d).
- Placed as its own `else if` block before `ord`'s (which already ends the `if/else if` chain) — no changes to any existing branch's code.

## 3. Import Data tab — new "Contacts" step card

Added after the existing Step 5 (Order Requests) card, before the Import Log card (`index.html`, right after the `<div id="imp-ord-result">` closing block at `index.html:544`):

```html
<!-- Step 6: Contacts -->
<div class="card">
  <div class="ct"><span style="background:var(--bl);color:white;font-family:'Bebas Neue',sans-serif;font-size:.9rem;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">6</span>Contacts</div>
  <p style="font-size:.6rem;color:var(--m);margin-bottom:12px;line-height:1.7;">Upload a list of buyer/prospect contacts. Matched by email if present, else by exact name. Existing contacts are updated, not duplicated — columns left blank on a re-upload keep their previously-saved value.</p>
  <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
    <button class="btn btn-g" onclick="dlTemplate('co')">&#8595; Download Template</button>
    <button class="btn btn-s" onclick="G('ul-co').click()">&#8593; Upload Contacts CSV</button>
    <input type="file" id="ul-co" accept=".csv" style="display:none" onchange="bulkUpload('co',this)">
  </div>
  <div id="imp-co-result" style="font-size:.58rem;color:var(--m);min-height:16px;"></div>
</div>
```

Follows the exact markup pattern of Steps 1-5 (`card` div, numbered badge, `btn btn-g`/`btn btn-s` buttons, hidden file input, result div) — no deviation, no new CSS.

## 4. Test plan (`tests/run.js`)

New suite `Contacts CSV upload (SPEC-CON-002)`, following the existing pattern for other `processImport()` entity suites (e.g. the Order Request CSV import tests):

- `processImport('co', ...)` with a fresh contact row (new email) → 1 added, `DB.con` has the new record with all fields mapped correctly (AC-001).
- Re-running the same CSV (same email) → 0 added, 1 updated, no duplicate record created (AC-002).
- A row whose email doesn't match any existing contact, but whose name happens to match a different existing contact by exact string → treated as a fresh/separate match via email-priority (not accidentally merged into the name-matching contact) (AC-003).
- A row with both `Name` and `Email` blank → skipped, `DB.con` unchanged (AC-004).
- A row with `Status: "Prospect"` (not in `validStatuses`) → saved with `status: 'lead'` (AC-005).
- Re-uploading a CSV that omits the `Notes` column for an existing contact → existing `notes` value preserved, not blanked (AC-006).
- `TEMPLATES.co.headers` array, when passed through the same key names the `co` branch reads (`Name`,`Email`,`Phone`,`Company`,`Status`,`Source`,`Enquiry Summary`,`Notes`), round-trips correctly — asserts no header is ignored and no read key is missing from the template (AC-007, a direct array-equality check rather than a full CSV round-trip since `dlTemplate()` itself is a pure string-formatting/download function with no DB interaction to test against).
- After `processImport('co', ...)`, `mockEl('imp-co-result').textContent` matches the `'Contacts: N added, N updated, N skipped'` format (AC-009).
- **AC-008 (corrected — concrete spy assertion, following the `prevCNDoc`/`prevInvDoc` precedent at `tests/run.js:2057-2084`):**
  ```js
  test('processImport co branch calls rCon() to refresh the live view', () => {
    resetDB();
    var called = false;
    var origRCon = ctx.rCon;
    ctx.rCon = function(){ called = true; };
    ctx.processImport('co', 'Name,Email\nTest Contact,test@example.com\n');
    assert(called, 'rCon() invoked after a co import');
    ctx.rCon = origRCon;
  });
  ```
  This replaces v1's unstated "already covered structurally" claim with an actual test, restoring `ctx.rCon` to its prior stub afterward so later tests in the suite are unaffected.
- A new test also confirms the `createdAt`/`lastContactedAt` fallback fix (regression coverage for the v1→v2 correction): a row supplying `Created At`/`Last Contacted` columns on a brand-new contact populates those exact values rather than defaulting to `now` for `createdAt` or blank for `lastContactedAt`.

## Changelog

- v2: Restored the `createdAt`/`lastContactedAt` CSV-column fallback reads (`r['Created At']`, `r['Last Contacted']`) that v1 silently dropped, contradicting its own "field-for-field" claim and REQ-CON-002b (spec-gate v1 finding). Added an explicit note in §1 clarifying that `TEMPLATES.co.headers`' omission of these two columns is a template-UX choice, not a signal to drop the corresponding reads. Replaced AC-008's unstated "already covered" claim with a concrete spy-based test following the `prevCNDoc`/`prevInvDoc` precedent (spec-gate v1 finding). Added a regression test for the restored `createdAt`/`lastContactedAt` fallbacks.
- v1: Initial spec implementing REQ-CON-002-v2 (spec-gate FAIL — see above).
