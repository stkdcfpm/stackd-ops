# SPEC-CON-001 v5 — Contacts / Leads Entity

**Requirement:** REQ-CON-001 v2  
**Status:** Draft — submitted to spec-gate  
**Date:** 2026-06-19  

---

## 1. Overview

Add a Contacts entity to Stackd Ops (`index.html`). Contacts are trade leads captured from the FPM chat widget or created manually. They are referenced from Quotes (sourceContactId). The entity is read-only to the Sheets sync layer (no syncEnt calls).

---

## 2. State layer additions

### 2.1 localStorage key

Add to the existing `const K` on line 1685:

```js
const K = {
  s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
  sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai',
  co:'st_co'   // ← ADD: Contacts
};
```

`K.co = 'st_co'`. Do NOT use 'st_cn' — 'cn' is the credit-note abbreviation.

### 2.2 DB entity

Add `con` to `DB` initialisation:

```js
let DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
```

Load on startup:

```js
DB.con = ldArr(K.co);
```

### 2.3 EI key

Add `co` to `EI`. Do NOT use `cn` — `EI.cn` is already used for Credit Notes (confirmed in `openEditCN` / `openNewCN`):

```js
let EI = { s:null, l:null, i:null, cn:null, p:null, sh:null, qt:null, co:null };
```

### 2.4 saveAll

Update `saveAll` (line 1733) to also persist contacts:

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
  id:            string,   // uid()
  name:          string,   // required — dedup key is email (case-insensitive)
  email:         string,   // required — unique identifier for dedup
  phone:         string,   // optional
  company:       string,   // optional
  status:        string,   // 'lead' | 'qualified' | 'converted' | 'closed'
  source:        string,   // 'chat' | 'manual'
  gdprBasis:     string,   // 'pre_contract' | 'legitimate_interests'
  createdAt:     string,   // ISO datetime
  lastContactedAt: string, // ISO datetime or ''
  enquiries:     [         // append-only — one entry per inbound chat or manual note
    {
      id:        string,   // uid()
      ts:        string,   // ISO datetime
      summary:   string,   // free text
      source:    string    // 'chat' | 'manual'
    }
  ],
  notes:         string    // free-form internal notes
}
```

---

## 4. GDPR retention

Function `isStale(contact)`:

```js
function isStale(c) {
  var ref = c.lastContactedAt || c.createdAt;
  if (!ref) return false;
  var days = (Date.now() - new Date(ref).getTime()) / 86400000;
  return days > 700;
}
```

- `status === 'lead' | 'qualified'` → Art.6(1)(b) pre-contractual: `gdprBasis = 'pre_contract'`
- `status === 'converted' | 'closed'` → Art.6(1)(f) legitimate interests: `gdprBasis = 'legitimate_interests'`
- Stale contacts (>700 days) are flagged in the list view with a warning badge. No automatic deletion.

---

## 5. Deduplication

When saving a new contact (`EI.co === null`), check for an existing record with the same email (case-insensitive):

```js
var dup = DB.con.find(function(c){
  return c.email.toLowerCase() === email.toLowerCase();
});
```

If a duplicate is found, `confirm()`:

> "A contact with this email already exists (Name). Merge this enquiry into the existing record?"

- **OK**: append a new enquiry entry to `dup.enquiries`, update `dup.lastContactedAt`, persist, close modal.
- **Cancel**: keep modal open with data intact, no change to DB.

No duplicate is created. The merge path does not change `dup.status` or any other field — only `enquiries` and `lastContactedAt`.

---

## 6. saveConForceNew()

When the user explicitly wants to create a second record for the same email despite the merge prompt (e.g. different legal entity), provide:

```js
function saveConForceNew() {
  // Called only from a "Save Anyway" confirm path inside saveCon()
  // Pushes a new contact record to DB.con ignoring email dedup
  // Must call saveAll() to persist contacts alongside all other DB entities
  DB.con.push(newContact);
  saveAll();
  closeM('ov-con');
  rCon();
  toast('Contact saved');
}
```

`saveConForceNew()` must call `saveAll()` (not just `sv(K.co, DB.con)`) so other entities remain in sync.

---

## 7. View routing

### 7.1 showV fns map (line 2522)

Add `con` to the `fns` map in `showV`:

```js
var fns = { dash:rDash, sup:rSup, li:rLI, inv:rInv, po:rPO, sh:rShp, qt:rQte, con:rCon, import:function(){}, cfg:rCfg };
```

`rCon` takes no parameters — `fns[v]()` is called with no args, consistent with all other renderers.

### 7.2 renderAll (line 2525)

```js
function renderAll() { rDash(); rSup(); rLI(); rInv(); rPO(); rShp(); rQte(); rCon(); }
```

### 7.3 Nav tab HTML

The live nav uses `<button>` tags with class `tab`, attribute `data-v`, and `onclick="showV('contacts',this)"`. The Contacts nav entry must follow this exact pattern:

```html
<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>
```

**Not** `<li onclick="showV('contacts')">`.

---

## 8. rCon() — render contacts list

```js
function rCon() {
  var rows = DB.con.map(function(c) {
    var stale = isStale(c) ? ' <span class="badge badge-warn">Stale</span>' : '';
    return '<tr>' +
      '<td>' + san(c.name) + stale + '</td>' +
      '<td>' + san(c.email) + '</td>' +
      '<td>' + san(c.company||'') + '</td>' +
      '<td><span class="s-badge s-' + c.status + '">' + san(c.status) + '</span></td>' +
      '<td>' + san(c.source||'') + '</td>' +
      '<td>' + (c.enquiries||[]).length + '</td>' +
      '<td><button onclick="editCon(\'' + c.id + '\')">Edit</button> ' +
           '<button onclick="delCon(\'' + c.id + '\')">Del</button></td>' +
    '</tr>';
  }).join('');
  G('con-tbody').innerHTML = rows || '<tr><td colspan="7">No contacts yet.</td></tr>';
}
```

All user-supplied strings passed through `san()` before insertion into `innerHTML`.

---

## 9. openCon() / editCon(id)

```js
function openCon() {
  EI.co = null;
  G('con-title').textContent = 'New Contact';
  G('co-name').value = '';
  G('co-email').value = '';
  G('co-phone').value = '';
  G('co-company').value = '';
  G('co-status').value = 'lead';
  G('co-source').value = 'manual';
  G('co-notes').value = '';
  G('co-enq-summary').value = '';
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
  var name  = G('co-name').value.trim();
  var email = G('co-email').value.trim();
  if (!name)  { vErr('co-name',  'Name is required');  return; }
  if (!email) { vErr('co-email', 'Email is required'); return; }
  vOk('co-name'); vOk('co-email');

  var enqSummary = G('co-enq-summary').value.trim();

  if (!EI.co) {
    // New contact — check dedup
    var dup = DB.con.find(function(c){
      return c.email.toLowerCase() === email.toLowerCase();
    });
    if (dup) {
      var merge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
      if (merge) {
        if (enqSummary) {
          dup.enquiries.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });
        }
        dup.lastContactedAt = new Date().toISOString();
        sv(K.co, DB.con);
        closeM('ov-con');
        rCon();
        toast('Enquiry merged into existing contact');
        return;
      }
      // Cancel — stay in modal
      return;
    }
  }

  var gdprBasis = (['lead','qualified'].indexOf(G('co-status').value) >= 0)
    ? 'pre_contract' : 'legitimate_interests';

  var enqs = [];
  if (EI.co) {
    var existC = DB.con.find(function(x){ return x.id === EI.co; });
    enqs = existC ? (existC.enquiries || []).slice() : [];
  }
  if (enqSummary) {
    enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });
  }

  var con = {
    id:              EI.co || uid(),
    name:            name,
    email:           email,
    phone:           G('co-phone').value.trim(),
    company:         G('co-company').value.trim(),
    status:          G('co-status').value,
    source:          G('co-source').value,
    gdprBasis:       gdprBasis,
    createdAt:       EI.co ? (DB.con.find(function(x){return x.id===EI.co;})||{}).createdAt || new Date().toISOString() : new Date().toISOString(),
    lastContactedAt: enqSummary ? new Date().toISOString() : (EI.co ? (DB.con.find(function(x){return x.id===EI.co;})||{}).lastContactedAt || '' : ''),
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

---

## 12. Quote integration — sourceContactId

### 12.1 Module-level variable

```js
var cConvertId = null;  // carries contactId from openConvertToQuote() into saveQte()
```

### 12.2 openConvertToQuote(contactId)

Called from the Contacts list/edit view "Convert to Quote" button:

```js
function openConvertToQuote(contactId) {
  cConvertId = contactId;
  openQte();   // resets all fields including qf-client and qf-nt to empty strings
  // Pre-populate AFTER openQte() returns, by direct DOM assignment:
  var c = DB.con.find(function(x){ return x.id === contactId; });
  if (c) {
    G('qf-client').value = san(c.name);
    G('qf-nt').value = 'Contact: ' + san(c.email);
  }
}
```

**Critical sequence**: `openQte()` clears `qf-client` and `qf-nt` to empty strings during its execution (confirmed line 6496, 6503). Pre-population must happen AFTER `openQte()` returns.

### 12.3 saveQte() — injection point for sourceContactId

In `saveQte()`, the `qt` object is built and DB is updated. The contact mutation block must be inserted AFTER `sv(K.qt, DB.qt)` (line 6772) and BEFORE `closeM('ov-qt')` (line 6773):

```
// line 6772:
sv(K.qt, DB.qt);
// ← INSERT HERE:
if (cConvertId) {
  var convC = DB.con.find(function(x){ return x.id === cConvertId; });
  if (convC && convC.status !== 'converted') {
    convC.status = 'converted';
    convC.lastContactedAt = new Date().toISOString();
    sv(K.co, DB.con);  // persist contact status change
  }
  cConvertId = null;
}
// line 6773:
closeM('ov-qt');
```

`sv(K.co, DB.con)` must be called here to persist the status change. `saveQte()` does not call `saveAll()`.

### 12.4 sourceContactId field on Quote

The `qt` object built in `saveQte()` gains:

```js
var qt = {
  // ... existing fields ...
  linkedPOId:      existQ ? (existQ.linkedPOId||'') : '',
  sourceContactId: cConvertId || (existQ ? (existQ.sourceContactId||'') : '')
};
```

`sourceContactId` is set using `cConvertId` (the module-level variable, populated before `saveQte()` is called) with fallback to the existing quote's value (for edits). This line is placed BEFORE the `cConvertId = null` reset in the contact mutation block above.

### 12.5 delQte() — status reversal

When a quote is deleted and it has a `sourceContactId`, revert the contact status:

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
      sv(K.co, DB.con);  // persist the status reversal
    }
  }
  rQte();
  toast('Quote deleted');
}
```

`sv(K.co, DB.con)` is required here — `delQte()` does not call `saveAll()`.

---

## 13. Export / Import

### 13.1 expAll() — add con to snapshot

```js
var snap = {
  // ... existing fields ...
  qt: DB.qt,
  con: DB.con,   // ← ADD
  // ... settings etc ...
};
```

### 13.2 doImport() — standalone guard (NOT in entities array)

`'con'` must NOT be added to the `entities` array (lines 5984–6001). That array is used for `structOk` validation and for the `entities.forEach` restore loop — adding 'con' to it would zero `DB.con` when restoring a v2 backup that has no `con` key.

Instead, add a standalone guard immediately after the `entities.forEach` loop, following the pattern of `data.settings`, `data.company`, etc.:

```js
entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; });
if (Array.isArray(data.con)) DB.con = data.con;   // ← ADD — outside entities loop
if (data.settings) { SS = data.settings; sv(K.ss, SS); }
// ... rest of existing guards ...
```

### 13.3 doImport() confirm dialog — contacts count line

The existing confirm message string is (lines 5994–5999):

```
'Suppliers: '  + counts[0] + '  |  Line Items: ' + counts[1] + '\n' +
'Invoices: '   + counts[2] + '  |  POs: ' + counts[3] + '\n' +
'Payments: '   + counts[4] + '  |  Shipments: ' + counts[5] + '\n' +
'Quotes: '     + counts[6] + '\n\n' +
```

Add contacts count after Quotes:

```
'Quotes: '     + counts[6] + '  |  Contacts: ' + (data.con ? data.con.length : 0) + '\n\n' +
```

---

## 14. Contact modal HTML (ov-con)

Modal structure follows the established pattern (see `ov-sup`, `ov-qt`):

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

The Contacts view (`id="v-contacts"`) follows the tab-panel pattern. The table has columns: Name, Email, Company, Status, Source, Enquiries, Actions.

```html
<div id="v-contacts" class="v">
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

New test file `tests/contacts.test.js` (or additions to `tests/run.js`) covering:

1. `saveCon()` creates a new contact in `DB.con`
2. `saveCon()` dedup merge appends enquiry, does not create duplicate
3. `saveCon()` sets `gdprBasis = 'pre_contract'` for status 'lead'
4. `saveCon()` sets `gdprBasis = 'legitimate_interests'` for status 'converted'
5. `openConvertToQuote()` sets `cConvertId` and calls `openQte()`
6. `saveQte()` sets `sourceContactId` and updates contact status to 'converted'
7. `delQte()` reverts contact status to 'qualified' when `sourceContactId` matches
8. `isStale()` returns true for contact with `lastContactedAt` > 700 days ago
9. `delCon()` removes contact from `DB.con`
10. `doImport()` restores `DB.con` from backup without zeroing on v2 format

---

## 17. Data model ERD (for docs/data-model.md)

```
Contact (DB.con / st_co)
  id             PK
  name
  email          UNIQUE (dedup key, case-insensitive)
  phone
  company
  status         lead | qualified | converted | closed
  source         chat | manual
  gdprBasis      pre_contract | legitimate_interests
  createdAt
  lastContactedAt
  enquiries[]    id, ts, summary, source
  notes

Quote (DB.qt / st_qt)
  id             PK
  sourceContactId  FK → Contact.id  (optional)
  linkedPOId       FK → PO.id       (optional)
  ...

Contact ─── (0..n) ──→ Quote   via Quote.sourceContactId
```

---

## 18. GDPR data flow

| Data | Basis | Retention | Action |
|---|---|---|---|
| Name, Email, Phone, Company | Art.6(1)(b) pre-contractual (lead/qualified) | Until request withdrawn or stale 700d | Flag in UI |
| Same fields post-conversion | Art.6(1)(f) legitimate interests | 700d from last contact | Flag in UI |
| Enquiry transcript (imported from chat) | Art.6(1)(b) | Same as contact | Stored in enquiries[] |

No data transmitted externally. No Sheets sync for Contacts entity.

---

## 19. AI_SYSTEM_PROMPT update (mandatory)

The `AI_SYSTEM_PROMPT` in `index.html` must be updated to describe the Contacts entity:
- What it is (trade leads / contacts database)
- Fields (name, email, phone, company, status, source, enquiries, notes)
- Status values and GDPR basis per status
- Dedup via email merge
- Quote link via sourceContactId
- No Sheets sync

---

## 20. Version delivery checklist

- [ ] `K.co = 'st_co'` added to `const K`
- [ ] `DB.con` added to `let DB`, loaded with `ldArr(K.co)`
- [ ] `EI.co` added (not `EI.cn`)
- [ ] `saveAll()` updated to include `sv(K.co, DB.con)`
- [ ] `renderAll()` updated to call `rCon()`
- [ ] `fns` map in `showV` updated with `con: rCon`
- [ ] Nav `<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>` added
- [ ] `v-contacts` view panel HTML added
- [ ] `ov-con` modal HTML added
- [ ] `rCon()`, `openCon()`, `editCon()`, `saveCon()`, `delCon()` implemented
- [ ] `isStale()` implemented
- [ ] `openConvertToQuote(contactId)` — pre-populates AFTER `openQte()` returns
- [ ] `saveQte()` — `sourceContactId` on qt object, contact mutation block before `closeM`
- [ ] `delQte()` — status reversal with `sv(K.co, DB.con)` persist
- [ ] `expAll()` — `con: DB.con` in snapshot
- [ ] `doImport()` — standalone `if (Array.isArray(data.con))` guard outside entities loop
- [ ] `doImport()` confirm dialog updated with Contacts count
- [ ] Tests passing
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` created
- [ ] `docs/known-gaps.md` updated
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` version bumped
- [ ] In-app changelog updated
