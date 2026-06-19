# SPEC-CON-001 v10 — Contacts / Leads Entity

**Requirement:** REQ-CON-001 v2  
**Status:** Draft — submitted to spec-gate  
**Date:** 2026-06-19  
**Changes from v9:** Resolve B1 (prove qteToPoConvert cannot execute with cConvertId set), B2 (full confirm dialog replacement string), B3 (vClr calls in openCon), B4 (storageHealth K-scan is intentional). Fix A5 (use existing `tag` class pattern, not non-existent `s-badge`).

---

## 1. Overview

Add a Contacts entity to Stackd Ops (`index.html`). Contacts are trade leads. Referenced from Quotes (sourceContactId). No Sheets sync.

---

## 2. State layer additions

### 2.1 localStorage key

Add `co` to `const K` (line 1685):

```js
const K = {
  s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
  sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai',
  co:'st_co'
};
```

**storageHealth() side-effect**: `storageHealth()` at line 5937 calls `Object.values(K).forEach(...)` to sum all key sizes. Adding `K.co` automatically includes `st_co` in the storage health metric. This is intentional — contacts data is local storage and should be counted in the health check.

### 2.2 DB entity

```js
let DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
DB.con = ldArr(K.co);   // on startup
```

### 2.3 EI key

```js
let EI = { s:null, l:null, i:null, cn:null, p:null, sh:null, qt:null, co:null };
```

`EI.co` — do NOT use `cn` (Credit Notes).

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
  notes:           string
}
```

`gdprBasis` derived from already-read `status` variable on every `saveCon()`:
- `status in ['lead','qualified']` → `'pre_contract'` (Art.6(1)(b))
- `status in ['converted','closed']` → `'legitimate_interests'` (Art.6(1)(f))

`enquiries[]` is append-only. Not shown in edit modal — only count in list view. All status values are freely editable by the user (no transitions locked).

---

## 4. GDPR retention

`isConStale(c)` — verified unused in index.html:

```js
function isConStale(c) {
  var ref = c.lastContactedAt || c.createdAt;
  if (!ref) return false;
  return (Date.now() - new Date(ref).getTime()) / 86400000 > 700;
}
```

---

## 5. Deduplication (new contact only)

New contact (`EI.co === null`): case-insensitive email match. Edit-path email changes are not deduped (CON-GAP-002 covers soft-dedup limitation).

If duplicate found:
1. Merge confirm → OK: `dup.enquiries = dup.enquiries || []`, push enquiry, update `lastContactedAt`, `sv(K.co)`, close, return.
2. Merge confirm → Cancel → force-new confirm → OK: fall through to new record.
3. Force-new confirm → Cancel: return, no DB change.

---

## 6. View routing

### 6.1 showV fns map (line 2522)

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

`showV` uses `querySelectorAll('.view')` to toggle panels. Panel class must be `'view'`:

```html
<div class="view" id="v-contacts">
```

---

## 7. CSS additions

The badge pattern in the live codebase is `class="tag s-{status}"` (confirmed at lines 2679, 2823, 3794, etc.). Add four new rules near lines 61–64:

```css
.s-lead{background:#e8f4ff;color:#1d4ed8;}
.s-qualified{background:#f0fdf4;color:#15803d;}
.s-converted{background:var(--gnf);color:var(--gn);font-weight:600;}
.s-closed{background:#f5f5f5;color:#666;}
```

`s-converted` reuses the green palette (same as `s-paid`/`s-confirmed`). `s-closed` reuses `s-draft` palette. No `.s-badge` base class is defined or needed — the existing `.tag` class provides the base styling.

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
      '<td><span class="tag s-' + c.status + '">' + san(c.status) + '</span></td>' +
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

`c.id` from `uid()` is alphanumeric only — no XSS risk in inline onclick.

---

## 9. openCon() / editCon(id)

```js
function openCon() {
  EI.co = null;
  G('con-title').textContent = 'New Contact';
  ['co-name','co-email','co-phone','co-company','co-notes','co-enq-summary'].forEach(function(id){ G(id).value = ''; });
  G('co-status').value = 'lead';
  G('co-source').value = 'manual';
  vClr('co-name');    // clear any stale validation state from previous saveCon() call
  vClr('co-email');
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
  vClr('co-name');
  vClr('co-email');
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

Quotes referencing this contact via `sourceContactId` will have a dangling reference (CON-GAP-004). `saveQte()` and `delQte()` both guard with `if (convC && ...)` / `if (relC && ...)` — safe no-op if contact not found.

---

## 12. Quote integration

### 12.1 cConvertId declaration

After line 1704 (`let cIL = [], cPL = [], cQL = [], cCNL = [];`), at module level:

```js
var cConvertId = null;
```

### 12.2 closeQteDlg() and close path updates

```js
function closeQteDlg() {
  cConvertId = null;
  closeM('ov-qt');
}
```

Update three user-facing close paths on `ov-qt`:

- **Line 1545** (backdrop): `onclick="if(event.target===this)closeQteDlg()"`
- **Line 1549** (X button): `onclick="closeQteDlg()"`
- **Line 1596** (Cancel button): `onclick="closeQteDlg()"`

**qteToPoConvert() does NOT need to change.** Proof: `qteToPoConvert()` (line 6786) begins with `var id = EI.qt; if (!id) return;`. `openConvertToQuote()` calls `openQte()` which sets `EI.qt = null` (line 6493). Therefore whenever `cConvertId` is set (i.e. after `openConvertToQuote()` is called), `EI.qt === null` and `qteToPoConvert()` returns immediately on its first guard. The two paths are mutually exclusive: `cConvertId !== null` implies `EI.qt === null`. No dangling reference is possible through the `qteToPoConvert()` path.

The bare `closeM('ov-qt')` at line 6773 in `saveQte()` is also safe: `cConvertId` is always nulled in the mutation block that immediately precedes it. The mutation block runs unconditionally when `cConvertId` is truthy, and sets `cConvertId = null` at the end regardless of whether `convC` was found.

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

Add `sourceContactId` to the `qt` object literal (lines 6749–6765):

```js
var qt = {
  // ... all existing fields unchanged ...
  linkedPOId:       existQ ? (existQ.linkedPOId||'') : '',
  sourceContactId:  cConvertId || (existQ ? (existQ.sourceContactId||'') : ''),  // ← ADD
  calc_totalLanded: +fn(totalLanded,2),
  calc_sellUSD:     +fn(sellUSD,2),
  calc_sellGBP:     +fn(sellGBP,2)
};
```

After `sv(K.qt, DB.qt)` (line 6772), insert before `closeM('ov-qt')` (line 6773):

```js
if (cConvertId) {
  var convC = DB.con.find(function(x){ return x.id === cConvertId; });
  if (convC && convC.status !== 'converted') {
    convC.status = 'converted';
    convC.lastContactedAt = new Date().toISOString();
    sv(K.co, DB.con);
  }
  cConvertId = null;
}
```

### 12.5 delQte() — full replacement

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

### 13.1 expAll() — add con

Add `con: DB.con` after `qt: DB.qt` in the `snap` object. `_version` stays `2`.

### 13.2 doImport() — standalone guard

Add after `entities.forEach` (after line 6001), before `if (data.settings)`:

```js
if (data.con !== undefined) {
  DB.con = Array.isArray(data.con) ? data.con : [];
}
```

If `data.con` is present but not an array, `DB.con` is reset to `[]` (consistent with `entities.forEach` behaviour for corrupted keys).

If `data.con` is absent (v2 backup), this block does not execute. `DB.con` retains its value from startup (`ldArr(K.co)`), because `'con'` is not in `entities` and `entities.forEach` does not touch it.

If `doImport()` aborts at `structOk`/`_app` check before reaching this guard, `DB.con` is not modified.

No separate `sv(K.co, DB.con)` needed — the existing `saveAll()` at line 6010 covers it.

### 13.3 doImport() confirm dialog — exact replacement

Replace line 5998 (`'Quotes: ' + counts[6] + '\n\n' +`) with:

```js
'Quotes: '     + counts[6] + '  |  Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0) + '\n\n' +
```

Full message string context for clarity (lines 5994–5999 after change):

```js
var msg = 'Restore backup from ' + (data._exported ? data._exported.slice(0,10) : 'unknown date') + '?\n\n' +
  'Suppliers: '  + counts[0] + '  |  Line Items: ' + counts[1] + '\n' +
  'Invoices: '   + counts[2] + '  |  POs: ' + counts[3] + '\n' +
  'Payments: '   + counts[4] + '  |  Shipments: ' + counts[5] + '\n' +
  'Quotes: '     + counts[6] + '  |  Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0) + '\n\n' +
  'WARNING: This will replace ALL current local data.';
```

The dialog WARNING text remains unchanged. CON-GAP-005 acknowledges that contacts from v2 backups are not replaced, which is an accepted known inconsistency with the WARNING text.

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

`resetDB()` in `tests/run.js` — add `con:[]`:

```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[] };
}
```

Multi-confirm mocking:

```js
var n = 0; ctx.confirm = function(){ return [true, false][n++]; };
```

Test cases (15 new):

1. `saveCon()` creates new contact with correct fields and `gdprBasis`
2. Dedup merge (confirm OK): enquiry appended, no duplicate, `sv(K.co)` called
3. Dedup cancel both confirms: no DB change
4. `gdprBasis = 'pre_contract'` for status 'lead'
5. `gdprBasis = 'legitimate_interests'` for status 'converted'
6. `openConvertToQuote()`: sets `cConvertId`, EI.qt === null, qf-client === c.name, qf-nt === 'Contact: ' + c.email
7. `saveQte()` with cConvertId: qt.sourceContactId populated, contact → 'converted', sv(K.co) called, cConvertId === null after
8. `closeQteDlg()`: cConvertId nulled, closeM called
9. `delQte()` with sourceContactId: contact → 'qualified', sv(K.co) called; rQte() called after sv
10. `isConStale()` returns true for contact >700 days old
11. `delCon()` removes contact from DB.con, calls sv(K.co)
12. `doImport()` with data.con array: DB.con set correctly
13. `doImport()` with data.con absent — precondition: DB.con has 1 record before import; after import with backup lacking `con` key, DB.con still has 1 record
14. `doImport()` with data.con non-array: DB.con reset to []
15. `openCon()`: co-name-err and co-email-err validation state cleared (vClr called)

---

## 17. Data model ERD (docs/data-model.md)

```
Contact (DB.con / K.co = 'st_co')
  id              PK
  name
  email           Soft-unique dedup key (case-insensitive)
  phone, company, status, source, gdprBasis, createdAt, lastContactedAt, notes
  enquiries[]     { id, ts, summary, source }  append-only

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
| Name, Email, Phone, Company | Art.6(1)(b) (lead/qualified) | Until withdrawn or stale 700d | Flag in UI |
| Same post-conversion | Art.6(1)(f) (converted/closed) | 700d from last contact | Flag in UI |
| Enquiry summaries | Art.6(1)(b) | Same | In enquiries[] |

No external transmission. No Sheets sync.

---

## 19. Known gaps to add to docs/known-gaps.md

| ID | Area | Summary |
|---|---|---|
| CON-GAP-001 | Contacts / GDPR | No automated purge of stale contacts — manual deletion only; UI flags >700d |
| CON-GAP-002 | Contacts / dedup | Email dedup is soft (force-new allowed); no enforcement of true uniqueness; edit-path email changes not deduped |
| CON-GAP-003 | Contacts / Sheets sync | Contacts entity not synced to Google Sheets — localStorage only |
| CON-GAP-004 | Contacts / data integrity | Deleting a contact leaves dangling sourceContactId on associated quotes; runtime guards no-op safely |
| CON-GAP-005 | Contacts / import | Restoring a v2 backup (no con key) preserves live contacts rather than clearing them; WARNING dialog text is not updated to reflect this |

---

## 20. AI_SYSTEM_PROMPT update (mandatory)

Update `AI_SYSTEM_PROMPT` to cover:
- Contacts tab: name, email, phone, company, status (lead/qualified/converted/closed), source, enquiries[], notes
- gdprBasis: derived from status on save (not user-editable)
- Dedup: email case-insensitive; merge prompt; force-new allowed
- "→ Quote" pre-populates quote modal; saving sets contact to 'converted'
- Deleting the quote reverts to 'qualified'
- enquiries[] append-only; count in list; history not in modal
- No Sheets sync

---

## 21. CLAUDE.md updates

- Bump to v2.9.27
- Add `co | st_co | Contacts` to Entities table
- Add `co` to EI line
- Add sprint item 16: Contacts/Leads entity
- Update Test count

---

## 22. Version delivery checklist

- [ ] CSS: `.s-lead`, `.s-qualified`, `.s-converted`, `.s-closed` added
- [ ] `K.co = 'st_co'` in `const K` (storageHealth coverage intentional)
- [ ] `DB.con = []` in `let DB`; `DB.con = ldArr(K.co)` on startup
- [ ] `EI.co` added
- [ ] `saveAll()` includes `sv(K.co, DB.con)`
- [ ] `renderAll()` calls `rCon()`
- [ ] `var cConvertId = null` after line 1704
- [ ] `closeQteDlg()` added
- [ ] Line 1545 backdrop → `closeQteDlg()`
- [ ] Line 1549 X button → `closeQteDlg()`
- [ ] Line 1596 Cancel button → `closeQteDlg()`
- [ ] `fns` map: `contacts: rCon`
- [ ] Nav Contacts button
- [ ] `<div class="view" id="v-contacts">` panel
- [ ] `ov-con` modal HTML
- [ ] `isConStale()` implemented
- [ ] `rCon()`, `openCon()` (with vClr), `editCon()` (with vClr), `saveCon()`, `delCon()` implemented
- [ ] `openConvertToQuote(contactId)` implemented
- [ ] `saveQte()` — `sourceContactId` in qt literal; mutation block before closeM
- [ ] `delQte()` replaced
- [ ] `expAll()` — `con: DB.con`
- [ ] `doImport()` — standalone `if (data.con !== undefined)` guard; confirm dialog updated
- [ ] `resetDB()` includes `con:[]`
- [ ] 15 new tests passing; test count updated
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] `docs/data-model.md` created
- [ ] `docs/known-gaps.md` updated (CON-GAP-001 through CON-GAP-005)
- [ ] `docs/version-history.md` updated
- [ ] `CLAUDE.md` updated
- [ ] In-app changelog updated
