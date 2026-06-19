# SPEC-CON-001 v6 — Contacts / Leads Entity

**Requirement:** REQ-CON-001 v2  
**Status:** Draft — submitted to spec-gate  
**Date:** 2026-06-19  
**Changes from v5:** Fix 4 blocking gaps: (1) fns key 'contacts' not 'con'; (2) sourceContactId in qt object literal before cConvertId nulled; (3) resetDB() must include con:[]; (4) saveAll() already covers con persist in doImport — no extra sv() call needed. Fix advisory: saveConForceNew stub clarified as inline confirm path. isStale verified unused.

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
  phone:           string,   // optional
  company:         string,   // optional
  status:          string,   // 'lead' | 'qualified' | 'converted' | 'closed'
  source:          string,   // 'chat' | 'manual'
  gdprBasis:       string,   // 'pre_contract' | 'legitimate_interests' — derived on every save from status
  createdAt:       string,   // ISO datetime
  lastContactedAt: string,   // ISO datetime or ''
  enquiries:       Array,    // append-only — one entry per inbound chat or manual note
                             // each entry: { id, ts, summary, source }
  notes:           string    // free-form internal notes
}
```

`gdprBasis` is derived on every `saveCon()` call from the current status value — it is not stored or editable independently by the user:
- `status === 'lead' | 'qualified'` → `gdprBasis = 'pre_contract'`  (Art.6(1)(b))
- `status === 'converted' | 'closed'` → `gdprBasis = 'legitimate_interests'`  (Art.6(1)(f))

---

## 4. GDPR retention

Function `isConStale(contact)` — name verified as unused in `index.html`:

```js
function isConStale(c) {
  var ref = c.lastContactedAt || c.createdAt;
  if (!ref) return false;
  var days = (Date.now() - new Date(ref).getTime()) / 86400000;
  return days > 700;
}
```

Stale contacts are flagged in the list view with a warning badge. No automatic deletion. This is intentional — deletion requires a deliberate manual action by the user so there is an audit trail.

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

- **OK**: append a new enquiry entry to `dup.enquiries`, update `dup.lastContactedAt`, call `sv(K.co, DB.con)`, close modal, return.
- **Cancel**: keep modal open with data intact, no change to DB, return.

No duplicate contact record is created by the merge path.

---

## 6. saveConForceNew — not a separate function

There is no separate `saveConForceNew()` function. The "save anyway" path (user declines the merge and explicitly wants a new record despite same email) is handled inline within `saveCon()` using a second `confirm()`:

```js
if (dup) {
  var merge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
  if (merge) {
    // merge path — append enquiry, persist, close
    ...
    return;
  }
  // Not merging — offer force-new
  var forceNew = confirm('Create a separate contact record for this email address anyway?');
  if (!forceNew) return;  // cancel — stay in modal
  // fall through to create new record below
}
```

If the user confirms force-new, execution falls through to the standard new-record creation path. `saveAll()` is called at the end of `saveCon()` for new records to ensure all entities persist together.

Actually, for consistency with other save functions (which call `sv(K.xx, DB.xx)` directly rather than `saveAll()`), `saveCon()` calls `sv(K.co, DB.con)` directly and does NOT call `saveAll()`. This is consistent with `saveQte()`, `saveSup()`, etc.

---

## 7. View routing

### 7.1 showV fns map (line 2522)

Add `contacts` to the `fns` map in `showV`. The key must be `'contacts'` (not `'con'`) because `showV` is called with `showV('contacts', this)` from the nav button, and `fns[v]` where `v = 'contacts'` must resolve to `rCon`:

```js
var fns = { dash:rDash, sup:rSup, li:rLI, inv:rInv, po:rPO, sh:rShp, qt:rQte, contacts:rCon, import:function(){}, cfg:rCfg };
```

**Not** `con:rCon` — using 'con' would mean `fns['contacts']` is `undefined` and `rCon` is never called from the nav.

### 7.2 renderAll (line 2525)

```js
function renderAll() { rDash(); rSup(); rLI(); rInv(); rPO(); rShp(); rQte(); rCon(); }
```

### 7.3 Nav tab HTML

The live nav uses `<button>` tags with class `tab`, attribute `data-v`, and `onclick="showV('...',this)"`. The Contacts nav entry must follow this exact pattern, with `data-v="contacts"` and `showV('contacts',this)`:

```html
<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>
```

### 7.4 View panel id

The view panel id must match the `showV` convention (which uses `G('v-' + v)` to show/hide panels). The panel id must be `v-contacts` (not `v-con`):

```html
<div id="v-contacts" class="v">
```

---

## 8. rCon() — render contacts list

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
      var doMerge = confirm('A contact with this email already exists (' + dup.name + '). Merge this enquiry into the existing record?');
      if (doMerge) {
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
      var forceNew = confirm('Create a separate contact record for this email address anyway?');
      if (!forceNew) return;
      // fall through — create new record
    }
  }

  var gdprBasis = (['lead','qualified'].indexOf(G('co-status').value) >= 0)
    ? 'pre_contract' : 'legitimate_interests';

  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? (existC.enquiries || []).slice() : [];
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

---

## 12. Quote integration — sourceContactId

### 12.1 Module-level variable

Declare alongside other module-level variables:

```js
var cConvertId = null;  // carries contactId from openConvertToQuote() into saveQte()
```

### 12.2 openConvertToQuote(contactId)

```js
function openConvertToQuote(contactId) {
  cConvertId = contactId;
  openQte();   // clears qf-client (line 6496) and qf-nt (line 6503) to ''
  // Pre-populate AFTER openQte() returns — openQte() clears these fields:
  var c = DB.con.find(function(x){ return x.id === contactId; });
  if (c) {
    G('qf-client').value = c.name;
    G('qf-nt').value = 'Contact: ' + c.email;
  }
  // If c is null (stale/deleted id), cConvertId holds a dangling reference.
  // saveQte() will silently no-op the contact mutation (convC guard fails) and null cConvertId.
}
```

`c.name` and `c.email` come from `DB.con` (trusted internal data), so `san()` is not required for DOM value assignment (only for innerHTML).

### 12.3 saveQte() changes — FULL SEQUENCE

The `qt` object is built at lines 6749–6765. `sourceContactId` is added to the object literal at construction time, before the post-save mutation block, using `cConvertId` before it is nulled:

```js
var qt = {
  id:              EI.qt || uid(),
  num:             G('qf-num').value.trim() || nextQteNum(),
  client:          G('qf-client').value.trim(),
  dt:              G('qf-dt').value,
  validUntil:      G('qf-valid').value,
  currency:        G('qf-cur').value,
  freightMode:     mode,
  markup:          markup,
  status:          G('qf-st').value,
  notes:           G('qf-nt').value.trim(),
  lines:           lines,
  linkedPOId:      existQ ? (existQ.linkedPOId||'') : '',
  sourceContactId: cConvertId || (existQ ? (existQ.sourceContactId||'') : ''),  // ← ADD
  calc_totalLanded: +fn(totalLanded,2),
  calc_sellUSD:     +fn(sellUSD,2),
  calc_sellGBP:     +fn(sellGBP,2)
};
```

`cConvertId` is read here (during object construction), while it still holds the value set in `openConvertToQuote()`. It is nulled in the post-save mutation block below.

After the DB array update and `sv(K.qt, DB.qt)` (current line 6772), insert the contact mutation block BEFORE `closeM('ov-qt')` (current line 6773):

```
// line 6772: existing
sv(K.qt, DB.qt);

// ← INSERT: contact status mutation block
if (cConvertId) {
  var convC = DB.con.find(function(x){ return x.id === cConvertId; });
  if (convC && convC.status !== 'converted') {
    convC.status = 'converted';
    convC.lastContactedAt = new Date().toISOString();
    sv(K.co, DB.con);   // persist contact status change — saveQte() does not call saveAll()
  }
  cConvertId = null;
}

// line 6773: existing
closeM('ov-qt');
// line 6774: existing
rQte();
// line 6775: existing
toast('Quote ' + qt.num + ' saved');
```

### 12.4 delQte() — status reversal with persist

Replace the existing `delQte()` (lines 6778–6784):

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

`sv(K.co, DB.con)` is required here because `delQte()` does not call `saveAll()`.

---

## 13. Export / Import

### 13.1 expAll() — add con to snapshot

In the `snap` object (line 5947), add `con: DB.con` after `qt: DB.qt`:

```js
var snap = {
  _version: 2,
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
  // ... rest unchanged
};
```

### 13.2 doImport() — standalone guard OUTSIDE entities array

`'con'` must NOT be added to the `entities` array (line 5984). That array drives both `structOk` validation and the `entities.forEach` restore loop — adding 'con' would zero `DB.con` on v2 backups that lack the key (`Array.isArray(undefined) ? undefined : []` → `[]`).

Add a standalone guard immediately after the `entities.forEach` loop (after line 6001), following the same pattern as `data.settings`, `data.company` etc.:

```js
entities.forEach(function(k) { DB[k] = Array.isArray(data[k]) ? data[k] : []; });
if (Array.isArray(data.con)) DB.con = data.con;   // ← ADD — outside entities loop
if (data.settings) { SS = data.settings; sv(K.ss, SS); }
// ... rest of existing guards unchanged ...
```

No separate `sv(K.co, DB.con)` call is needed here. The existing `saveAll()` call at line 6010 already includes `sv(K.co, DB.con)` (after the `saveAll` update in §2.4) and runs after all guards. The standalone guard sets `DB.con` in memory; `saveAll()` then persists it. This is the same pattern used by all other entities in the `entities.forEach` loop.

### 13.3 doImport() confirm dialog — contacts count line

The existing confirm message (lines 5994–5999):

```js
'Suppliers: '  + counts[0] + '  |  Line Items: ' + counts[1] + '\n' +
'Invoices: '   + counts[2] + '  |  POs: ' + counts[3] + '\n' +
'Payments: '   + counts[4] + '  |  Shipments: ' + counts[5] + '\n' +
'Quotes: '     + counts[6] + '\n\n' +
'WARNING: This will replace ALL current local data.'
```

Update the Quotes line to include Contacts:

```js
'Quotes: '     + counts[6] + '  |  Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0) + '\n\n' +
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

## 16. Tests — resetDB() update required

The test harness `resetDB()` in `tests/run.js` must be updated to include `con:[]`:

```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
}
```

Without this update, tests that access `DB.con` will throw because the property does not exist after `resetDB()`.

New test cases covering:

1. `saveCon()` creates a new contact in `DB.con` with correct fields
2. `saveCon()` dedup — confirms and merges enquiry into existing, does not create duplicate
3. `saveCon()` dedup — cancel keeps modal open, no DB change
4. `saveCon()` sets `gdprBasis = 'pre_contract'` for status 'lead'
5. `saveCon()` sets `gdprBasis = 'legitimate_interests'` for status 'converted'
6. `openConvertToQuote()` sets `cConvertId` before calling `openQte()`
7. `saveQte()` with `cConvertId` set: `qt.sourceContactId` populated, contact status → 'converted', `cConvertId` nulled after
8. `delQte()` with `sourceContactId`: contact status reverts to 'qualified', `sv(K.co, DB.con)` called
9. `isConStale()` returns true for contact with `lastContactedAt` > 700 days ago
10. `delCon()` removes contact from `DB.con`
11. `doImport()` with v3 backup: restores `DB.con` correctly
12. `doImport()` with v2 backup (no `con` key): `DB.con` remains as existing value (empty array), not zeroed

---

## 17. Data model ERD (for docs/data-model.md)

```
Contact (DB.con / K.co = 'st_co')
  id              PK
  name
  email           UNIQUE dedup key (case-insensitive, soft — force-new allowed)
  phone
  company
  status          lead | qualified | converted | closed
  source          chat | manual
  gdprBasis       pre_contract | legitimate_interests (derived from status on save)
  createdAt
  lastContactedAt
  enquiries[]     { id, ts, summary, source }
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

No data transmitted externally. No Sheets sync for Contacts entity. `enquiries[].source` records whether each enquiry came from chat or manual entry; this is separate from the contact-level `source` field which records how the contact was originally created.

---

## 19. AI_SYSTEM_PROMPT update (mandatory)

The `AI_SYSTEM_PROMPT` in `index.html` must be updated to describe the Contacts entity:
- What it is (trade leads / contacts database)
- Fields: name, email, phone, company, status (lead/qualified/converted/closed), source, enquiries[], notes
- gdprBasis: derived from status on every save, not user-editable
- Dedup: email (case-insensitive), merge prompt on duplicate
- Quote link: `sourceContactId` on Quote, set via "Convert to Quote" action
- Status progression: lead → qualified → converted (via quote) → closed
- Status reversal: deleting a quote reverts contact from 'converted' to 'qualified'
- No Sheets sync

---

## 20. CLAUDE.md updates (mandatory)

Update CLAUDE.md:
- Bump version to v2.9.27
- Add `con | st_co | Contacts` to the Entities table
- Update EI line: `let EI = { s, l, i, cn, p, sh, qt, co }`
- Add sprint item 16: Contacts/Leads entity
- Update Test count after tests pass

---

## 21. Version delivery checklist

- [ ] `K.co = 'st_co'` added to `const K`
- [ ] `DB.con` added to `let DB`, loaded with `ldArr(K.co)`
- [ ] `EI.co` added (not `EI.cn`)
- [ ] `saveAll()` updated to include `sv(K.co, DB.con)`
- [ ] `renderAll()` updated to call `rCon()`
- [ ] `fns` map in `showV` updated with `contacts: rCon` (key is 'contacts', not 'con')
- [ ] Nav `<button class="tab" data-v="contacts" onclick="showV('contacts',this)">Contacts</button>` added
- [ ] `<div id="v-contacts" class="v">` view panel HTML added
- [ ] `ov-con` modal HTML added
- [ ] `isConStale()` implemented
- [ ] `rCon()`, `openCon()`, `editCon()`, `saveCon()`, `delCon()` implemented
- [ ] `openConvertToQuote(contactId)` — pre-populates AFTER `openQte()` returns
- [ ] `saveQte()` — `sourceContactId` in qt object literal (uses `cConvertId` before it is nulled)
- [ ] `saveQte()` — contact mutation block inserted between `sv(K.qt, DB.qt)` and `closeM('ov-qt')`
- [ ] `delQte()` — status reversal with `sv(K.co, DB.con)` persist
- [ ] `expAll()` — `con: DB.con` in snapshot
- [ ] `doImport()` — standalone `if (Array.isArray(data.con)) DB.con = data.con;` outside entities loop
- [ ] `doImport()` confirm dialog updated with Contacts count
- [ ] `resetDB()` in `tests/run.js` updated to include `con:[]`
- [ ] All new tests passing, total test count updated
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` created with ERD
- [ ] `docs/known-gaps.md` updated with CON-GAP entries
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` entities table updated, version bumped, sprint item added
- [ ] In-app changelog updated
