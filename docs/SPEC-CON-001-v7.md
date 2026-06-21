# SPEC-CON-001 v7 — Contacts / Leads Entity

**Requirement:** REQ-CON-001 v2  
**Status:** Draft — submitted to spec-gate  
**Date:** 2026-06-19  
**Changes from v6:** Resolve 6 blocking gaps: (1) _version stays 2, explicit rationale; (2) malformed data.con silently ignored — specified as intentional; (3) cConvertId declaration anchor — after line 1704; (4) cConvertId nulled on cancel via closeQteDlg(); (5) dup.enquiries guard before push; (6) delQte() exact call order. Also resolves advisories A, B, E.

This spec supersedes v6. Only differences from v6 are noted where applicable.

---

## 1. Overview

Add a Contacts entity to Stackd Ops (`index.html`). Contacts are trade leads captured from the FPM chat widget or created manually. They are referenced from Quotes (sourceContactId). The entity is read-only to the Sheets sync layer (no syncEnt calls).

---

## 2. State layer additions

### 2.1 localStorage key

Add `co` to the existing `const K` on line 1685:

```js
const K = {
  s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
  sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai',
  co:'st_co'   // ← ADD: Contacts
};
```

`K.co = 'st_co'`. Do NOT use 'st_cn' — 'cn' is the credit-note abbreviation already in use.

### 2.2 DB entity

Add `con` to `DB` initialisation:

```js
let DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
```

Load on startup immediately after other `ldArr` calls:

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
  id:              string,   // uid()
  name:            string,   // required
  email:           string,   // required — dedup key (case-insensitive)
  phone:           string,   // optional, default ''
  company:         string,   // optional, default ''
  status:          string,   // 'lead' | 'qualified' | 'converted' | 'closed'
  source:          string,   // 'chat' | 'manual'
  gdprBasis:       string,   // 'pre_contract' | 'legitimate_interests'
  createdAt:       string,   // ISO datetime
  lastContactedAt: string,   // ISO datetime or ''
  enquiries:       Array,    // append-only — each entry: { id, ts, summary, source }
  notes:           string    // free-form internal notes, default ''
}
```

`gdprBasis` is derived on every `saveCon()` call from the already-read `status` variable (not via a second DOM read — see §10). It is not stored or editable independently by the user:
- `status === 'lead' | 'qualified'` → `gdprBasis = 'pre_contract'`  (Art.6(1)(b))
- `status === 'converted' | 'closed'` → `gdprBasis = 'legitimate_interests'`  (Art.6(1)(f))

The `enquiries[]` array is append-only. Existing enquiry entries are never shown in the edit modal — only the count is shown in the list view table. The new-enquiry input (`co-enq-summary`) captures a new entry to append on save; it is always cleared when the modal opens.

---

## 4. GDPR retention

Function `isConStale(contact)` — name `isConStale` verified as unused in `index.html`:

```js
function isConStale(c) {
  var ref = c.lastContactedAt || c.createdAt;
  if (!ref) return false;
  var days = (Date.now() - new Date(ref).getTime()) / 86400000;
  return days > 700;
}
```

Stale contacts are flagged in the list view with a warning badge. No automatic deletion — deletion requires a deliberate manual action so there is an audit trail.

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

- **OK**: append a new enquiry entry to `dup.enquiries` (defensive init first — see §10), update `dup.lastContactedAt`, call `sv(K.co, DB.con)`, close modal, return.
- **Cancel**: second `confirm()` — "Create a separate contact record for this email anyway?" → OK: fall through to create new record. Cancel: keep modal open, return with no DB change.

No duplicate contact record is created by the merge path.

---

## 6. View routing

### 6.1 showV fns map (line 2522)

Add `contacts` to the `fns` map in `showV`. The key must be `'contacts'` because `showV` is called with `showV('contacts', this)` from the nav button:

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

### 6.4 View panel id

`showV` displays panels via `G('v-' + v)` where `v = 'contacts'`. The panel id must be `v-contacts`:

```html
<div id="v-contacts" class="v">
```

---

## 7. rCon() — render contacts list

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

---

## 8. openCon() / editCon(id)

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
  G('co-enq-summary').value = '';  // always cleared — enquiries[] are append-only, not shown in modal
  G('ov-con').classList.add('on');
}
```

---

## 9. saveCon()

```js
function saveCon() {
  var name   = G('co-name').value.trim();
  var email  = G('co-email').value.trim();
  var status = G('co-status').value;   // read once — used for gdprBasis derivation (no second DOM read)
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
      var doMerge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
      if (doMerge) {
        dup.enquiries = dup.enquiries || [];   // defensive — older records may lack this field
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
      // Not merging — offer force-new
      var forceNew = confirm('Create a separate contact record for this email address anyway?');
      if (!forceNew) return;   // cancel — stay in modal, no DB change
      // fall through — create new record below
    }
  }

  // gdprBasis derived from already-read `status` variable, not from a second DOM read:
  var gdprBasis = (['lead','qualified'].indexOf(status) >= 0)
    ? 'pre_contract' : 'legitimate_interests';

  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? ((existC.enquiries || []).slice()) : [];
  if (enqSummary) {
    enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });
  }

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

## 10. delCon(id)

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

## 11. Quote integration — sourceContactId

### 11.1 Module-level variable — declaration anchor

Declare `cConvertId` after line 1704 (the line `let cIL = [], cPL = [], cQL = [], cCNL = [];`), at module level, not inside any function:

```js
var cConvertId = null;   // carries contactId from openConvertToQuote() into saveQte()
```

### 11.2 closeQteDlg() — cancel wrapper

The quote modal cancel button currently calls `closeM('ov-qt')` directly. To handle the dangling `cConvertId` problem, introduce a thin wrapper function and update the cancel button to call it:

```js
function closeQteDlg() {
  cConvertId = null;   // null on any cancel — prevents dangling reference on next saveQte()
  closeM('ov-qt');
}
```

Update the cancel button in the `ov-qt` modal HTML:

```html
<!-- Change FROM: -->
<button class="btn-sec" onclick="closeM('ov-qt')">Cancel</button>
<!-- Change TO: -->
<button class="btn-sec" onclick="closeQteDlg()">Cancel</button>
```

Any other `closeM('ov-qt')` calls in the codebase (e.g. from outside the modal flow) do NOT need to be changed — they do not involve a convert flow. Only the user-facing cancel button must use `closeQteDlg()`. `saveQte()` itself nulls `cConvertId` after the contact mutation (§11.4), so the save path is correct.

### 11.3 openConvertToQuote(contactId)

```js
function openConvertToQuote(contactId) {
  cConvertId = contactId;
  openQte();   // clears qf-client (line 6496) and qf-nt (line 6503) to ''
  // Pre-populate AFTER openQte() returns — openQte() clears these fields during execution:
  var c = DB.con.find(function(x){ return x.id === contactId; });
  if (c) {
    G('qf-client').value = c.name;
    G('qf-nt').value = 'Contact: ' + c.email;
  }
  // If c is null (stale/deleted id), the modal opens empty. cConvertId holds a dangling
  // reference but saveQte()'s convC guard will silently no-op and null cConvertId.
}
```

`c.name` and `c.email` come from `DB.con` (trusted internal data), so `san()` is not required for DOM value assignment.

### 11.4 saveQte() changes — FULL SEQUENCE

Add `sourceContactId` to the `qt` object literal at construction time (lines 6749–6765), before the post-save mutation block. `cConvertId` is still set at this point:

```js
var qt = {
  id:               EI.qt || uid(),
  num:              G('qf-num').value.trim() || nextQteNum(),
  client:           G('qf-client').value.trim(),
  dt:               G('qf-dt').value,
  validUntil:       G('qf-valid').value,
  currency:         G('qf-cur').value,
  freightMode:      mode,
  markup:           markup,
  status:           G('qf-st').value,
  notes:            G('qf-nt').value.trim(),
  lines:            lines,
  linkedPOId:       existQ ? (existQ.linkedPOId||'') : '',
  sourceContactId:  cConvertId || (existQ ? (existQ.sourceContactId||'') : ''),  // ← ADD
  calc_totalLanded: +fn(totalLanded,2),
  calc_sellUSD:     +fn(sellUSD,2),
  calc_sellGBP:     +fn(sellGBP,2)
};
```

After the DB array update and `sv(K.qt, DB.qt)` (current line 6772), insert the contact mutation block BEFORE `closeM('ov-qt')` (current line 6773):

```
sv(K.qt, DB.qt);   // existing line 6772

// ← INSERT contact mutation block:
if (cConvertId) {
  var convC = DB.con.find(function(x){ return x.id === cConvertId; });
  if (convC && convC.status !== 'converted') {
    convC.status = 'converted';
    convC.lastContactedAt = new Date().toISOString();
    sv(K.co, DB.con);   // persist contact status change — saveQte() does not call saveAll()
  }
  cConvertId = null;   // always null after save regardless of whether contact was found
}

closeM('ov-qt');   // existing line 6773
rQte();            // existing line 6774
toast('Quote ' + qt.num + ' saved');   // existing line 6775
```

### 11.5 delQte() — status reversal with persist

Replace the existing `delQte()` (lines 6778–6784). Exact call order:

1. Confirm dialog
2. Find quote record (before filtering it out)
3. Filter DB.qt
4. `sv(K.qt, DB.qt)` — persist quote deletion
5. Contact status reversal if applicable
6. `sv(K.co, DB.con)` — persist contact change (only if mutation occurred)
7. `rQte()` — re-render
8. `toast('Quote deleted')`

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
      sv(K.co, DB.con);   // persist reversal — delQte() does not call saveAll()
    }
  }
  rQte();
  toast('Quote deleted');
}
```

---

## 12. Export / Import

### 12.1 expAll() — add con to snapshot

`_version` remains `2`. Rationale: the standalone guard in `doImport()` (`if (Array.isArray(data.con)) DB.con = data.con`) handles the presence/absence of `con` in any backup regardless of `_version`. Bumping `_version` would cause existing v2 backups to fail the (unused) version check and provides no benefit since no code branches on `_version`. The version is incremented only if the import logic changes in a way that makes v2 backups incompatible — adding a new optional key does not meet this bar.

```js
var snap = {
  _version: 2,              // stays 2 — see rationale above
  _exported: new Date().toISOString(),
  _app: 'Stackd Ops',
  sup: DB.sup,
  li: DB.li,
  inv: DB.inv,
  po: DB.po,
  payments: DB.payments,
  sh: DB.sh,
  qt: DB.qt,
  con: DB.con,   // ← ADD
  settings: SS,
  company: AS,
  branding: getCoBrand(),
  qr: ld('st_qr'),
  customPorts: ldArr('stackd_custom_ports'),
  customPaymentTerms: ld('rd_pt_cust'),
  customUOM: ld('rd_uom_cust'),
  fpmRepairDone: localStorage.getItem('st_fpm_repair_v1') || null
};
```

### 12.2 doImport() — standalone guard OUTSIDE entities array

`'con'` must NOT be added to the `entities` array (line 5984). Add a standalone guard immediately after the `entities.forEach` loop (after line 6001):

```js
entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; });
if (Array.isArray(data.con)) DB.con = data.con;   // ← ADD
// If data.con is present but not an array (corrupted backup), it is silently ignored —
// DB.con retains its current value (set by ldArr at startup). This is the intended behaviour:
// a malformed con key does not block restore of the other valid entities.
if (data.settings) { SS = data.settings; sv(K.ss, SS); }
```

No separate `sv(K.co, DB.con)` is needed in the import block — the existing `saveAll()` call at line 6010 will persist `DB.con` (because `saveAll` was updated in §2.4 to include `sv(K.co, DB.con)`).

### 12.3 doImport() confirm dialog

Update the Quotes line (line 5998) to include Contacts count:

```js
'Quotes: '     + counts[6] + '  |  Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0) + '\n\n' +
'WARNING: This will replace ALL current local data.'
```

---

## 13. Contact modal HTML (ov-con)

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

## 14. Contacts list view HTML

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

## 15. Quote modal cancel button update

The existing `ov-qt` modal cancel button must be changed from `closeM('ov-qt')` to `closeQteDlg()`:

```html
<!-- Locate in ov-qt modal HTML, change: -->
<button class="btn-sec" onclick="closeM('ov-qt')">Cancel</button>
<!-- to: -->
<button class="btn-sec" onclick="closeQteDlg()">Cancel</button>
```

---

## 16. Tests — resetDB() update required

The test harness `resetDB()` in `tests/run.js` must be updated to include `con:[]`:

```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
}
```

For the two-confirm dedup path (merge prompt then force-new prompt), tests must mock `ctx.confirm` (the `confirm` function in the VM context) to return the appropriate value for each call. Test authoring pattern:

```js
// Test: dedup cancel — first confirm returns false (decline merge), second returns false (decline force-new)
var callCount = 0;
ctx.confirm = function() { return false; };   // both confirms return false
// call saveCon() — expect DB.con unchanged, modal stays open
```

New test cases:

1. `saveCon()` creates a new contact in `DB.con` with correct fields including `gdprBasis`
2. `saveCon()` dedup merge — `confirm` returns true: enquiry appended, no duplicate, `sv(K.co)` called
3. `saveCon()` dedup cancel both — `confirm` returns false twice: no DB change
4. `saveCon()` sets `gdprBasis = 'pre_contract'` for status 'lead'
5. `saveCon()` sets `gdprBasis = 'legitimate_interests'` for status 'converted'
6. `openConvertToQuote()` sets `cConvertId` then calls `openQte()`
7. `saveQte()` with `cConvertId` set: `qt.sourceContactId` populated, contact status → 'converted', `sv(K.co)` called, `cConvertId` nulled
8. `delQte()` with `sourceContactId`: contact status → 'qualified', `sv(K.co)` called, then `rQte()` then `toast()`
9. `isConStale()` returns true for contact with `lastContactedAt` > 700 days ago
10. `delCon()` removes contact from `DB.con`, calls `sv(K.co)`
11. `doImport()` with `data.con` present as array: `DB.con` set correctly
12. `doImport()` with `data.con` absent (v2 backup): `DB.con` remains `[]` (not zeroed)
13. `doImport()` with `data.con` as non-array (corrupted): `DB.con` remains `[]` (silently ignored)
14. `closeQteDlg()` nulls `cConvertId` then calls `closeM`

---

## 17. Data model ERD (for docs/data-model.md)

```
Contact (DB.con / K.co = 'st_co')
  id              PK
  name
  email           Soft-unique dedup key (case-insensitive; force-new allowed)
  phone
  company
  status          lead | qualified | converted | closed
  source          chat | manual
  gdprBasis       pre_contract | legitimate_interests (derived from status on save)
  createdAt
  lastContactedAt
  enquiries[]     { id, ts, summary, source }   -- append-only
  notes

Quote (DB.qt / K.qt = 'st_qt')
  id              PK
  sourceContactId FK → Contact.id  (optional, '' if none)
  linkedPOId      FK → PO.id       (optional, '' if none)
  ...

Contact ─── (0..n) ──→ Quote   via Quote.sourceContactId
```

---

## 18. GDPR data flow

| Data | Basis | Retention | Action |
|---|---|---|---|
| Name, Email, Phone, Company | Art.6(1)(b) pre-contractual (lead/qualified) | Until withdrawn or stale 700d | Flag in UI |
| Same fields post-conversion | Art.6(1)(f) legitimate interests | 700d from last contact | Flag in UI |
| Enquiry summaries | Art.6(1)(b) | Same as contact | Stored in enquiries[] |

No data transmitted externally. No Sheets sync for Contacts entity.

---

## 19. AI_SYSTEM_PROMPT update (mandatory)

The `AI_SYSTEM_PROMPT` in `index.html` must be updated to describe the Contacts entity:
- What it is (trade leads / contacts database)
- Fields: name, email, phone, company, status, source, enquiries[], notes
- gdprBasis: derived from status on every save, not user-editable
- Status values: lead | qualified | converted | closed
- Dedup: email (case-insensitive), merge prompt on duplicate, force-new allowed
- Quote link: `sourceContactId` on Quote; "→ Quote" button in Contacts list opens quote modal pre-populated
- Status auto-updates: saving a quote from convert flow → contact 'converted'; deleting that quote → contact reverts to 'qualified'
- enquiries[] is append-only; history not shown in modal, only count in list
- No Sheets sync

---

## 20. CLAUDE.md updates (mandatory)

- Bump version to v2.9.27
- Add `co | st_co | Contacts` to the Entities table
- Update EI line to show `co` key
- Add sprint item 16: Contacts/Leads entity
- Update Test count after tests pass

---

## 21. Version delivery checklist

- [ ] `K.co = 'st_co'` added to `const K`
- [ ] `DB.con = []` added to `let DB`; `DB.con = ldArr(K.co)` on startup
- [ ] `EI.co` added (not `EI.cn`)
- [ ] `saveAll()` updated to include `sv(K.co, DB.con)`
- [ ] `renderAll()` updated to call `rCon()`
- [ ] `var cConvertId = null` declared after line 1704 at module level
- [ ] `fns` map in `showV` updated with `contacts: rCon`
- [ ] Nav `<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>` added
- [ ] `<div id="v-contacts" class="v">` view panel HTML added
- [ ] `ov-con` modal HTML added
- [ ] `closeQteDlg()` function added; quote modal cancel button updated to use it
- [ ] `isConStale()` implemented
- [ ] `rCon()` implemented
- [ ] `openCon()`, `editCon()`, `saveCon()`, `delCon()` implemented
- [ ] `openConvertToQuote(contactId)` implemented (pre-populates after `openQte()` returns)
- [ ] `saveQte()` — `sourceContactId` in qt object literal; contact mutation block between sv(K.qt) and closeM
- [ ] `delQte()` replaced — status reversal with sv(K.co) before rQte()
- [ ] `expAll()` — `con: DB.con` added to snapshot; `_version` stays 2
- [ ] `doImport()` — standalone `if (Array.isArray(data.con)) DB.con = data.con` outside entities loop
- [ ] `doImport()` confirm dialog updated with Contacts count
- [ ] `resetDB()` in `tests/run.js` updated to include `con:[]`
- [ ] All 14 new test cases passing; total test count updated
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` created with ERD (in scope for this delivery)
- [ ] `docs/known-gaps.md` updated with CON-GAP entries
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` entities table, EI line, version, sprint item updated
- [ ] In-app changelog updated
