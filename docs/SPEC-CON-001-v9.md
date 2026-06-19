# SPEC-CON-001 v9 — Contacts / Leads Entity

**Requirement:** REQ-CON-001 v2  
**Status:** Draft — submitted to spec-gate  
**Date:** 2026-06-19  
**Changes from v8:** Resolve B1 (panel class="view"), B3 (doImport abort leaves DB.con unchanged), B5 (test case 13 precondition), B6 (CON-GAP-004 for dangling sourceContactId on delCon), A5 (CSS badge classes for contact statuses).

---

## 1. Overview

Add a Contacts entity to Stackd Ops (`index.html`). Contacts are trade leads captured from the FPM chat widget or created manually. They are referenced from Quotes (sourceContactId). The entity is read-only to the Sheets sync layer (no syncEnt calls).

---

## 2. State layer additions

### 2.1 localStorage key

Add `co` to `const K` on line 1685:

```js
const K = {
  s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
  sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai',
  co:'st_co'
};
```

### 2.2 DB entity

```js
let DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
// startup:
DB.con = ldArr(K.co);
```

### 2.3 EI key

```js
let EI = { s:null, l:null, i:null, cn:null, p:null, sh:null, qt:null, co:null };
```

`EI.co` — do NOT use `cn` (already used for Credit Notes).

### 2.4 saveAll

```js
const saveAll = () => {
  sv(K.s,DB.sup); sv(K.l,DB.li); sv(K.i,DB.inv); sv(K.p,DB.po);
  sv(K.pm,DB.payments); sv(K.sh,DB.sh); sv(K.qt,DB.qt); sv(K.co,DB.con);
};
```

---

## 3. Contact schema

```js
{
  id:              string,   // uid()
  name:            string,   // required
  email:           string,   // required — dedup key (case-insensitive)
  phone:           string,   // optional, default ''
  company:         string,   // optional, default ''
  status:          string,   // 'lead' | 'qualified' | 'converted' | 'closed'
  source:          string,   // 'chat' | 'manual'
  gdprBasis:       string,   // 'pre_contract' | 'legitimate_interests' — derived on save
  createdAt:       string,   // ISO datetime
  lastContactedAt: string,   // ISO datetime or ''
  enquiries:       Array,    // append-only: [{ id, ts, summary, source }]
  notes:           string    // free-form internal notes
}
```

`gdprBasis` derived from already-read `status` variable on every `saveCon()` call:
- `status in ['lead','qualified']` → `'pre_contract'` (Art.6(1)(b))
- `status in ['converted','closed']` → `'legitimate_interests'` (Art.6(1)(f))

`enquiries[]` is append-only. Existing entries are not shown in the edit modal — only the count appears in the list view.

---

## 4. GDPR retention

Function `isConStale(c)` — verified unused in index.html:

```js
function isConStale(c) {
  var ref = c.lastContactedAt || c.createdAt;
  if (!ref) return false;
  return (Date.now() - new Date(ref).getTime()) / 86400000 > 700;
}
```

Stale contacts flagged in list view. No automatic deletion.

---

## 5. Deduplication

New contact (`EI.co === null`): case-insensitive email match against `DB.con`.

If duplicate found:
1. `confirm('A contact with this email already exists (Name). Merge this enquiry into the existing record?')`
   - **OK**: `dup.enquiries = dup.enquiries || []`, push enquiry if summary provided, update `lastContactedAt`, `sv(K.co, DB.con)`, close modal, return.
   - **Cancel**: second `confirm('Create a separate contact record for this email address anyway?')` → OK: fall through to new record. Cancel: return, no DB change.

---

## 6. View routing

### 6.1 showV fns map (line 2522)

Key must be `'contacts'` to match `showV('contacts', this)`:

```js
var fns = { dash:rDash, sup:rSup, li:rLI, inv:rInv, po:rPO, sh:rShp, qt:rQte, contacts:rCon, import:function(){}, cfg:rCfg };
```

### 6.2 renderAll (line 2525)

```js
function renderAll() { rDash(); rSup(); rLI(); rInv(); rPO(); rShp(); rQte(); rCon(); }
```

### 6.3 Nav tab HTML

```html
<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>
```

### 6.4 View panel

`showV` uses `G('v-' + v)` and toggles class on `.view` elements via `querySelectorAll('.view')`. Panel must use `class="view"` (confirmed by examining live panels at lines 257, 266, 277, 304, 315 which all use `class="view"`):

```html
<div class="view" id="v-contacts">
```

**Not** `class="v"` — panels using any other class will not be hidden when the tab changes.

---

## 7. CSS additions

The existing status badge classes (`s-draft`, `s-sent`, `s-paid`, etc.) do not cover contact status values. Add four new rules in the `<style>` block near line 61–64:

```css
.s-lead{background:#e8f4ff;color:#1d4ed8;}
.s-qualified{background:#f0fdf4;color:#15803d;}
.s-converted{background:var(--gnf);color:var(--gn);font-weight:600;}
.s-closed{background:#f5f5f5;color:#666;}
```

`s-converted` reuses the existing green palette (same as `s-paid`/`s-confirmed`). `s-closed` reuses `s-draft` palette.

---

## 8. rCon()

```js
function rCon() {
  var rows = DB.con.map(function(c) {
    var stale = isConStale(c) ? ' <span class="badge badge-warn">Stale</span>' : '';
    return '<tr>' +
      '<td>' + san(c.name) + stale + '</td>' +
      '<td>' + san(c.email) + '</td>' +
      '<td>' + san(c.company||'') + '</td>' +
      '<td><span class="s-badge s-' + c.status + '">' + san(c.status) + '</span></td>' +
      '<td>' + san(c.source||'') + '</td>' +
      '<td>' + (c.enquiries||[]).length + '</td>' +
      '<td><button onclick="editCon(\'' + c.id + '\')">Edit</button> ' +
           '<button onclick="delCon(\'' + c.id + '\')">Del</button> ' +
           '<button onclick="openConvertToQuote(\'' + c.id + '\')">→ Quote</button></td>' +
    '</tr>';
  }).join('');
  G('con-tbody').innerHTML = rows || '<tr><td colspan="7">No contacts yet.</td></tr>';
}
```

`c.id` is generated by `uid()` (alphanumeric only) — no XSS risk in the inline `onclick` string interpolation.

---

## 9. openCon() / editCon(id)

```js
function openCon() {
  EI.co = null;
  G('con-title').textContent = 'New Contact';
  ['co-name','co-email','co-phone','co-company','co-notes','co-enq-summary'].forEach(function(id){ G(id).value = ''; });
  G('co-status').value = 'lead';
  G('co-source').value = 'manual';
  G('ov-con').classList.add('on');
}

function editCon(id) {
  var c = DB.con.find(function(x){ return x.id === id; });
  if (!c) return;
  EI.co = id;
  G('con-title').textContent = 'Edit Contact';
  G('co-name').value = c.name || '';
  G('co-email').value = c.email || '';
  G('co-phone').value = c.phone || '';
  G('co-company').value = c.company || '';
  G('co-status').value = c.status || 'lead';
  G('co-source').value = c.source || 'manual';
  G('co-notes').value = c.notes || '';
  G('co-enq-summary').value = '';
  G('ov-con').classList.add('on');
}
```

---

## 10. saveCon()

```js
function saveCon() {
  var name   = G('co-name').value.trim();
  var email  = G('co-email').value.trim();
  var status = G('co-status').value;
  if (!name)  { vErr('co-name',  'Name is required');  return; }
  if (!email) { vErr('co-email', 'Email is required'); return; }
  vOk('co-name'); vOk('co-email');

  var enqSummary = G('co-enq-summary').value.trim();

  if (!EI.co) {
    var dup = DB.con.find(function(c){
      return c.email.toLowerCase() === email.toLowerCase();
    });
    if (dup) {
      var doMerge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
      if (doMerge) {
        dup.enquiries = dup.enquiries || [];
        if (enqSummary) dup.enquiries.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });
        dup.lastContactedAt = new Date().toISOString();
        sv(K.co, DB.con);
        closeM('ov-con');
        rCon();
        toast('Enquiry merged into existing contact');
        return;
      }
      if (!confirm('Create a separate contact record for this email address anyway?')) return;
    }
  }

  var gdprBasis = (['lead','qualified'].indexOf(status) >= 0) ? 'pre_contract' : 'legitimate_interests';
  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? ((existC.enquiries || []).slice()) : [];
  if (enqSummary) enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });

  var con = {
    id:              EI.co || uid(),
    name:            name,
    email:           email,
    phone:           G('co-phone').value.trim(),
    company:         G('co-company').value.trim(),
    status:          status,
    source:          G('co-source').value,
    gdprBasis:       gdprBasis,
    createdAt:       existC ? (existC.createdAt || new Date().toISOString()) : new Date().toISOString(),
    lastContactedAt: enqSummary ? new Date().toISOString() : (existC ? (existC.lastContactedAt || '') : ''),
    enquiries:       enqs,
    notes:           G('co-notes').value.trim()
  };

  if (EI.co) {
    var idx = DB.con.findIndex(function(x){ return x.id === EI.co; });
    if (idx >= 0) DB.con[idx] = con; else DB.con.push(con);
  } else {
    DB.con.push(con);
  }
  sv(K.co, DB.con);
  closeM('ov-con');
  rCon();
  toast('Contact saved');
}
```

---

## 11. delCon(id)

```js
function delCon(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  DB.con = DB.con.filter(function(c){ return c.id !== id; });
  sv(K.co, DB.con);
  rCon();
  toast('Contact deleted');
}
```

Note: quotes referencing this contact via `sourceContactId` will have a dangling reference. This is an accepted known gap (CON-GAP-004). `saveQte()` and `delQte()` both guard with `if (convC && ...)` / `if (relC && ...)` which no-op safely when the contact is not found.

---

## 12. Quote integration

### 12.1 cConvertId declaration

Declare after line 1704 (`let cIL = [], cPL = [], cQL = [], cCNL = [];`) at module level:

```js
var cConvertId = null;
```

### 12.2 closeQteDlg()

Introduce a wrapper to null `cConvertId` on any user-facing close of the quote modal:

```js
function closeQteDlg() {
  cConvertId = null;
  closeM('ov-qt');
}
```

Update three HTML close paths on `ov-qt`:

```html
<!-- Line 1545 — backdrop -->
<div class="ov" id="ov-qt" onclick="if(event.target===this)closeQteDlg()">

<!-- Line 1549 — X button -->
<button class="mx" onclick="closeQteDlg()">&#215;</button>

<!-- Line 1596 — Cancel button -->
<button class="btn btn-g" onclick="closeQteDlg()">Cancel</button>
```

Programmatic `closeM('ov-qt')` calls in `saveQte()` (line 6773) and `qteToPoConvert()` (line 6810) do NOT change — in `saveQte()`, `cConvertId` is nulled in the mutation block before `closeM` is called; `qteToPoConvert()` never sets `cConvertId`.

### 12.3 openConvertToQuote(contactId)

```js
function openConvertToQuote(contactId) {
  cConvertId = contactId;
  openQte();   // clears qf-client and qf-nt to ''
  var c = DB.con.find(function(x){ return x.id === contactId; });
  if (c) {
    G('qf-client').value = c.name;
    G('qf-nt').value = 'Contact: ' + c.email;
  }
}
```

### 12.4 saveQte() — sourceContactId in qt object literal

Add `sourceContactId` to the `qt` object literal at construction time (lines 6749–6765), before the post-save mutation block. `cConvertId` is still set at this point:

```js
var qt = {
  // ... all existing fields ...
  linkedPOId:       existQ ? (existQ.linkedPOId||'') : '',
  sourceContactId:  cConvertId || (existQ ? (existQ.sourceContactId||'') : ''),  // ← ADD
  calc_totalLanded: +fn(totalLanded,2),
  calc_sellUSD:     +fn(sellUSD,2),
  calc_sellGBP:     +fn(sellGBP,2)
};
```

After `sv(K.qt, DB.qt)` (line 6772), insert contact mutation block BEFORE `closeM('ov-qt')` (line 6773):

```
sv(K.qt, DB.qt);   // line 6772

if (cConvertId) {
  var convC = DB.con.find(function(x){ return x.id === cConvertId; });
  if (convC && convC.status !== 'converted') {
    convC.status = 'converted';
    convC.lastContactedAt = new Date().toISOString();
    sv(K.co, DB.con);
  }
  cConvertId = null;   // always null after save regardless of whether convC found
}

closeM('ov-qt');   // line 6773
rQte();            // line 6774
toast('Quote ' + qt.num + ' saved');   // line 6775
```

### 12.5 delQte() — full replacement

Exact call order: find record → filter → sv(K.qt) → [contact mutation + sv(K.co) if applicable] → rQte() → toast():

```js
function delQte(id) {
  if (!confirm('Delete this quote?')) return;
  var q = DB.qt.find(function(x){ return x.id === id; });
  DB.qt = DB.qt.filter(function(x){ return x.id !== id; });
  sv(K.qt, DB.qt);
  if (q && q.sourceContactId) {
    var relC = DB.con.find(function(x){ return x.id === q.sourceContactId; });
    if (relC && relC.status === 'converted') {
      relC.status = 'qualified';
      sv(K.co, DB.con);
    }
  }
  rQte();
  toast('Quote deleted');
}
```

---

## 13. Export / Import

### 13.1 expAll() — add con to snapshot

`_version` remains `2`. No import code branches on `_version`; the standalone guard handles old/new backups without version differentiation.

```js
var snap = {
  _version: 2,
  _exported: new Date().toISOString(),
  _app: 'Stackd Ops',
  sup: DB.sup, li: DB.li, inv: DB.inv, po: DB.po,
  payments: DB.payments, sh: DB.sh, qt: DB.qt,
  con: DB.con,   // ← ADD
  settings: SS, company: AS, branding: getCoBrand(),
  qr: ld('st_qr'), customPorts: ldArr('stackd_custom_ports'),
  customPaymentTerms: ld('rd_pt_cust'), customUOM: ld('rd_uom_cust'),
  fpmRepairDone: localStorage.getItem('st_fpm_repair_v1') || null
};
```

### 13.2 doImport() — standalone guard

`'con'` is NOT added to the `entities` array. Add standalone guard after `entities.forEach` (after line 6001), before `data.settings`:

```js
entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; });

// Contacts restore — outside entities loop (v2 backup compat):
if (data.con !== undefined) {
  DB.con = Array.isArray(data.con) ? data.con : [];
  // If data.con is present but not an array, DB.con is reset to [] (same behaviour as
  // entities.forEach for missing/corrupt keys — consistent, predictable post-restore state)
}
// If data.con is absent (v2 backup), this block does not execute and DB.con retains the
// value set by entities.forEach. Because 'con' is not in entities, entities.forEach does
// NOT touch DB.con. DB.con therefore retains its pre-import value (from ldArr at startup).
// This preserves live contact data when restoring old backups — see CON-GAP-005.

if (data.settings) { SS = data.settings; sv(K.ss, SS); }
```

If `doImport()` aborts at the `structOk` or `_app` check (lines 5988–5991) before the standalone guard is reached, `DB.con` is not modified and retains whatever was loaded at startup by `ldArr(K.co)`.

No separate `sv(K.co, DB.con)` is needed — the existing `saveAll()` at line 6010 persists `DB.con`.

### 13.3 doImport() confirm dialog

Update the Quotes line (line 5998):

```js
'Quotes: ' + counts[6] + '  |  Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0) + '\n\n' +
'WARNING: This will replace ALL current local data.'
```

---

## 14. Contact modal HTML (ov-con)

```html
<div id="ov-con" class="ov">
  <div class="card modal-card">
    <h2 id="con-title">Contact</h2>
    <label>Name*</label>
    <input id="co-name" type="text" placeholder="Full name">
    <span id="co-name-err" class="verr"></span>
    <label>Email*</label>
    <input id="co-email" type="email" placeholder="email@example.com">
    <span id="co-email-err" class="verr"></span>
    <label>Phone</label>
    <input id="co-phone" type="tel" placeholder="+44...">
    <label>Company</label>
    <input id="co-company" type="text" placeholder="Company name">
    <label>Status</label>
    <select id="co-status">
      <option value="lead">Lead</option>
      <option value="qualified">Qualified</option>
      <option value="converted">Converted</option>
      <option value="closed">Closed</option>
    </select>
    <label>Source</label>
    <select id="co-source">
      <option value="manual">Manual</option>
      <option value="chat">Chat</option>
    </select>
    <label>New enquiry note</label>
    <input id="co-enq-summary" type="text" placeholder="What did they enquire about?">
    <label>Internal notes</label>
    <textarea id="co-notes" rows="3" placeholder="Internal notes..."></textarea>
    <div class="btn-row">
      <button onclick="saveCon()">Save</button>
      <button class="btn-sec" onclick="closeM('ov-con')">Cancel</button>
    </div>
  </div>
</div>
```

---

## 15. Contacts list view HTML

```html
<div class="view" id="v-contacts">
  <div class="v-hdr">
    <h1>Contacts</h1>
    <button onclick="openCon()">+ New Contact</button>
  </div>
  <table>
    <thead>
      <tr>
        <th>Name</th><th>Email</th><th>Company</th>
        <th>Status</th><th>Source</th><th>Enquiries</th><th>Actions</th>
      </tr>
    </thead>
    <tbody id="con-tbody"></tbody>
  </table>
</div>
```

---

## 16. Tests

`resetDB()` in `tests/run.js` must include `con:[]`:

```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
}
```

For multi-confirm paths, mock `ctx.confirm` with a call counter:

```js
var n = 0; ctx.confirm = function(){ return [true, false][n++]; };
```

Test cases (15 new):

1. `saveCon()` creates new contact with correct fields and `gdprBasis`
2. Dedup merge (confirm OK): enquiry appended, no duplicate, `sv(K.co)` called
3. Dedup cancel both confirms: no DB change
4. `gdprBasis = 'pre_contract'` for status 'lead'
5. `gdprBasis = 'legitimate_interests'` for status 'converted'
6. `openConvertToQuote()` sets `cConvertId`, calls `openQte()`, EI.qt === null
7. `saveQte()` with cConvertId: qt.sourceContactId populated, contact → 'converted', sv(K.co) called, cConvertId === null after
8. `closeQteDlg()`: cConvertId nulled, closeM called
9. `delQte()` with sourceContactId: contact → 'qualified', sv(K.co) called; rQte() then toast() after
10. `isConStale()` returns true for >700 days
11. `delCon()` removes contact, calls sv(K.co)
12. `doImport()` with data.con array: DB.con set correctly
13. `doImport()` with data.con absent (v2 backup): precondition — pre-populate DB.con with 1 record before import; after import with backup lacking `con` key, DB.con still has 1 record (standalone guard does not fire, pre-import data preserved)
14. `doImport()` with data.con non-array: DB.con reset to []
15. `editCon()` — enquiries[] not cleared on edit; co-enq-summary cleared to ''

---

## 17. Data model ERD (docs/data-model.md)

```
Contact (DB.con / K.co = 'st_co')
  id              PK
  name
  email           Soft-unique dedup key (case-insensitive)
  phone
  company
  status          lead | qualified | converted | closed
  source          chat | manual
  gdprBasis       pre_contract | legitimate_interests (derived from status on save)
  createdAt
  lastContactedAt
  enquiries[]     { id, ts, summary, source }  append-only
  notes

Quote (DB.qt / K.qt = 'st_qt')
  id              PK
  sourceContactId FK → Contact.id  (optional, '' if none)
  linkedPOId      FK → PO.id       (optional, '' if none)

Contact ─── (0..n) ──→ Quote   via Quote.sourceContactId
```

---

## 18. GDPR data flow

| Data | Basis | Retention | Action |
|---|---|---|---|
| Name, Email, Phone, Company | Art.6(1)(b) pre-contractual (lead/qualified) | Until withdrawn or stale 700d | Flag in UI |
| Same fields post-conversion | Art.6(1)(f) legitimate interests | 700d from last contact | Flag in UI |
| Enquiry summaries | Art.6(1)(b) | Same as contact | In enquiries[] |

No external transmission. No Sheets sync.

---

## 19. Known gaps to add to docs/known-gaps.md

| ID | Area | Summary |
|---|---|---|
| CON-GAP-001 | Contacts / GDPR | No automated purge of stale contacts — manual deletion only; UI flags >700d |
| CON-GAP-002 | Contacts / dedup | Email dedup is soft (force-new allowed); no enforcement of true uniqueness |
| CON-GAP-003 | Contacts / Sheets sync | Contacts entity not synced to Google Sheets — localStorage only |
| CON-GAP-004 | Contacts / data integrity | Deleting a contact leaves dangling sourceContactId on associated quotes; saveQte/delQte guard safely (no-op), but the reference is stale |
| CON-GAP-005 | Contacts / import | Restoring a v2 backup (no con key) preserves live contacts rather than clearing them — contacts are not part of the backup payload |

---

## 20. AI_SYSTEM_PROMPT update (mandatory)

Update `AI_SYSTEM_PROMPT` in `index.html`:
- Contacts tab: trade leads/contacts; fields: name, email, phone, company, status, source, enquiries[], notes
- Status values: lead | qualified | converted | closed
- gdprBasis: derived from status on every save (not user-editable)
- Dedup: email case-insensitive; merge prompt on duplicate; force-new allowed
- "→ Quote" button opens quote modal pre-populated with contact name and email note
- Saving that quote auto-sets contact status to 'converted'
- Deleting the quote reverts contact status to 'qualified'
- enquiries[] is append-only; count shown in list; history not visible in modal
- No Sheets sync for Contacts

---

## 21. CLAUDE.md updates

- Bump version to v2.9.27
- Add `co | st_co | Contacts` to Entities table
- Update EI line to include `co`
- Add sprint item 16: Contacts/Leads entity
- Update Test count after tests pass

---

## 22. Version delivery checklist

- [ ] CSS rules added: `.s-lead`, `.s-qualified`, `.s-converted`, `.s-closed`
- [ ] `K.co = 'st_co'` added to `const K`
- [ ] `DB.con = []` in `let DB`; `DB.con = ldArr(K.co)` on startup
- [ ] `EI.co` added (not `EI.cn`)
- [ ] `saveAll()` includes `sv(K.co, DB.con)`
- [ ] `renderAll()` calls `rCon()`
- [ ] `var cConvertId = null` declared after line 1704 at module level
- [ ] `closeQteDlg()` function added
- [ ] `ov-qt` backdrop (line 1545) → `closeQteDlg()`
- [ ] `ov-qt` X button (line 1549) → `closeQteDlg()`
- [ ] `ov-qt` Cancel button (line 1596) → `closeQteDlg()`
- [ ] `fns` map: `contacts: rCon`
- [ ] Nav Contacts button (`data-v="contacts"`, `showV('contacts',this)`)
- [ ] `<div class="view" id="v-contacts">` panel added
- [ ] `ov-con` modal HTML added
- [ ] `isConStale()` implemented
- [ ] `rCon()`, `openCon()`, `editCon()`, `saveCon()`, `delCon()` implemented
- [ ] `openConvertToQuote(contactId)` implemented
- [ ] `saveQte()` — `sourceContactId` in qt object literal; mutation block before closeM; cConvertId nulled
- [ ] `delQte()` replaced — reversal + sv(K.co) before rQte()
- [ ] `expAll()` — `con: DB.con` in snap; `_version` stays 2
- [ ] `doImport()` — standalone `if (data.con !== undefined)` guard outside entities loop
- [ ] `doImport()` confirm dialog updated with Contacts count
- [ ] `resetDB()` in tests/run.js includes `con:[]`
- [ ] 15 new tests passing; total test count updated
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` created with ERD
- [ ] `docs/known-gaps.md` updated with CON-GAP-001 through CON-GAP-005
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` updated (entities, EI, version, sprint, test count)
- [ ] In-app changelog updated
