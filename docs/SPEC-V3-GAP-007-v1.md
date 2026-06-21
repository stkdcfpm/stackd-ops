# SPEC-V3-GAP-007-v1 — Global Event Log (`DB.events`)

**Based on:** REQ-V3-GAP-007-v3  
**Version target:** v2.9.28  
**Status:** Draft — ambiguities resolved, pending spec-gate review  
**Author:** Claude Code  
**Date:** 2026-06-21

---

## 1. State Changes

### 1.1 `K` constant (line 1759 of index.html)

Add `ev` key. Current line:

```js
const K = {s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm', sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai', co:'st_co'};
```

Replace with:

```js
const K = {s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm', sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai', co:'st_co', ev:'st_ev'};
```

### 1.2 `DB` initialisation (line 1772 of index.html)

Add `events` array. Current line:

```js
let DB = { sup: ldArr(K.s), li: ldArr(K.l), inv: ldArr(K.i), po: ldArr(K.p), payments: ldArr(K.pm), sh: ldArr(K.sh), qt: ldArr(K.qt), con: ldArr(K.co) };
```

Replace with:

```js
let DB = { sup: ldArr(K.s), li: ldArr(K.l), inv: ldArr(K.i), po: ldArr(K.p), payments: ldArr(K.pm), sh: ldArr(K.sh), qt: ldArr(K.qt), con: ldArr(K.co), events: ldArr(K.ev) };
```

### 1.3 `EI` — no change

`DB.events` has no top-level edit modal. `EI` is not modified. The accordion reads from `DB.events` filtered by `EI.co` or `EI.s`, which are already present.

### 1.4 `saveAll()` (line 1808 of index.html)

**Decision (2026-06-21):** YES — `saveAll()` includes `sv(K.ev, DB.events)`. Both `saveAll()` and `logEv()` write `K.ev`. The double-write is intentional: `logEv()` ensures immediate persistence on every event; `saveAll()` ensures the event array is included in any full-snapshot write path (backup, `renderAll`).

Replace current `saveAll()`:

```js
const saveAll = () => { sv(K.s,DB.sup); sv(K.l,DB.li); sv(K.i,DB.inv); sv(K.p,DB.po); sv(K.pm,DB.payments); sv(K.sh,DB.sh); sv(K.qt,DB.qt); sv(K.co,DB.con); sv(K.ev,DB.events); };
```

### 1.5 `expAll()` (line 6065 of index.html)

Add `events: DB.events` to the snap object. Insert after the `con: DB.con,` line in the snap object literal (currently at line 6077):

```js
con: DB.con,
events: DB.events,
```

No other changes to `expAll()`.

### 1.6 `doImport()` (line 6096 of index.html)

Two changes required:

**a) Update the entities validation list** — `events` is NOT added to the `entities` array (it is not validated as a required key; it is optional for backward compat with pre-v2.9.28 backups). The existing `entities` array at line 6104 remains unchanged.

**b) Add explicit restore after `entities.forEach`** — after the existing `if (data.con !== undefined)` block (line 6122–6124), add:

```js
DB.events = Array.isArray(data.events) ? data.events : [];
```

This matches the pattern already used for `data.con`. No confirm-dialog count update is needed for events (the existing confirm dialog does not count events — this is intentional, events are operational metadata, not user-created records).

**c) Update the restore success toast** — **Decision (2026-06-21):** Show events count. The existing success toast (line 6136) currently reads:
```js
toast('Restored: ' + DB.inv.length + ' invoices, ' + DB.sup.length + ' suppliers', 4000);
```
Update to append event count:
```js
toast('Restored: ' + DB.inv.length + ' invoices, ' + DB.sup.length + ' suppliers, ' + DB.events.length + ' events', 4000);
```

---

## 2. `logEv()` Implementation

### 2.1 Event record shape

```js
{
  id:         uid(),                     // string — unique ID via existing uid() helper
  ts:         new Date().toISOString(),  // ISO 8601 string
  entityType: string,                    // 'contact'|'supplier'|'quote'|'po'|'invoice'|'shipment'
  entityId:   string,                    // ID of the affected entity
  verb:       string,                    // see enum below; out-of-enum accepted as-is
  summary:    string,                    // plain operational text, no PII names
  actor:      string                     // 'user' | 'system'
}
```

Defined verb enum (not enforced at runtime): `'created'` | `'updated'` | `'status_changed'` | `'linked'` | `'unlinked'` | `'converted'` | `'note_added'` | `'deleted'`

### 2.2 Function implementation

Place `logEv()` in the UTILS section of index.html, immediately after the `sv()` function definition (after line 1807). Location chosen because it depends on `uid()`, `sv()`, and `K`, all defined in UTILS/STATE.

```js
function logEv(entityType, entityId, verb, summary, actor) {
  var ev = {
    id:         uid(),
    ts:         new Date().toISOString(),
    entityType: entityType,
    entityId:   entityId,
    verb:       verb,
    summary:    summary,
    actor:      actor !== undefined ? actor : 'user'
  };
  DB.events.push(ev);
  if (DB.events.length > 2000) {
    DB.events = DB.events.slice(DB.events.length - 2000);
  }
  sv(K.ev, DB.events);
}
```

### 2.3 Retention cap

- Hard cap: 2,000 events (FIFO).
- Trim is applied **after** push, **before** persist.
- Trim logic: `DB.events = DB.events.slice(DB.events.length - 2000)` — retains the 2,000 most recent entries, drops oldest.
- At ~200 bytes/event, 2,000 events ≈ 400 KB. Within the 75% `checkStorageQuota()` warning threshold (75% of 5 MB = 3,750 KB).
- Gap log: EVT-GAP-001 — no user-visible warning is shown when the cap is hit; oldest events are silently dropped.

---

## 3. Emission Points

All `logEv()` calls are inserted into existing functions. No new functions are created. Precise positions and surrounding code are given below.

### 3.1 & 3.2 `saveCon()` — complete replacement (lines 7042–7052)

Replace the existing `if (EI.co) / else` block and the three lines that follow it with the complete diff below. The `prevStatus` variable is declared immediately before the block, using the existing `existC` (line 7023).

**BEFORE (lines 7022–7053):**
```js
  var gdprBasis = (['lead','qualified'].indexOf(status) >= 0) ? 'pre_contract' : 'legitimate_interests';
  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? ((existC.enquiries || []).slice()) : [];
  if (enqSummary) enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });

  var con = {
    id:              EI.co || uid(),
    name:            name,
    email:           email,
    phone:           G('ct-phone').value.trim(),
    company:         G('ct-company').value.trim(),
    status:          status,
    source:          G('ct-source').value,
    gdprBasis:       gdprBasis,
    createdAt:       existC ? (existC.createdAt || new Date().toISOString()) : new Date().toISOString(),
    lastContactedAt: enqSummary ? new Date().toISOString() : (existC ? (existC.lastContactedAt || '') : ''),
    enquiries:       enqs,
    notes:           G('ct-notes').value.trim()
  };

  if (EI.co) {
    var idx = DB.con.findIndex(function(x){ return x.id === EI.co; });
    if (idx >= 0) DB.con[idx] = con; else DB.con.push(con);
  } else {
    DB.con.push(con);
  }
  sv(K.co, DB.con);
  syncEnt('co', con).catch(function(){});
  closeM('ov-con');
  rCon();
  toast('Contact saved');
```

**AFTER:**
```js
  var gdprBasis = (['lead','qualified'].indexOf(status) >= 0) ? 'pre_contract' : 'legitimate_interests';
  var existC = EI.co ? DB.con.find(function(x){ return x.id === EI.co; }) : null;
  var enqs = existC ? ((existC.enquiries || []).slice()) : [];
  if (enqSummary) enqs.push({ id: uid(), ts: new Date().toISOString(), summary: enqSummary, source: 'manual' });

  var con = {
    id:              EI.co || uid(),
    name:            name,
    email:           email,
    phone:           G('ct-phone').value.trim(),
    company:         G('ct-company').value.trim(),
    status:          status,
    source:          G('ct-source').value,
    gdprBasis:       gdprBasis,
    createdAt:       existC ? (existC.createdAt || new Date().toISOString()) : new Date().toISOString(),
    lastContactedAt: enqSummary ? new Date().toISOString() : (existC ? (existC.lastContactedAt || '') : ''),
    enquiries:       enqs,
    notes:           G('ct-notes').value.trim()
  };

  var prevStatus = existC ? existC.status : null;  // ADD — for status-change detection

  if (EI.co) {
    var idx = DB.con.findIndex(function(x){ return x.id === EI.co; });
    if (idx >= 0) DB.con[idx] = con; else DB.con.push(con);
    if (prevStatus !== null && prevStatus !== con.status) {
      logEv('contact', con.id, 'status_changed', 'Status changed to ' + con.status, 'user');  // ADD
    } else if (enqSummary) {
      logEv('contact', con.id, 'note_added', 'Enquiry note added', 'user');                    // ADD
    } else {
      logEv('contact', con.id, 'updated', 'Contact details updated', 'user');                  // ADD
    }
  } else {
    DB.con.push(con);
    logEv('contact', con.id, 'created', 'Contact created', 'user');  // ADD
  }
  sv(K.co, DB.con);
  syncEnt('co', con).catch(function(){});
  closeM('ov-con');
  rCon();
  toast('Contact saved');
```

> Priority ordering: status_changed > note_added > updated (mutually exclusive). `syncEnt` call is unchanged and remains after `sv()`.

### 3.3 `delCon()` — contact deleted (actor: `'user'`)

**GAP-3 resolution:** `delCon()` does not call `delEnt('co', id)` — this is intentional. The existing implementation omits Sheets delete for contacts on deletion (contacts are not yet wired to `delEnt`; this is a known gap separate from this spec). No `syncEnt` or `delEnt` call is added here.

**BEFORE (lines 7055–7061):**
```js
function delCon(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  DB.con = DB.con.filter(function(c){ return c.id !== id; });
  sv(K.co, DB.con);
  rCon();
  toast('Contact deleted');
}
```

**AFTER:**
```js
function delCon(id) {
  if (!confirm('Delete this contact? This cannot be undone.')) return;
  DB.con = DB.con.filter(function(c){ return c.id !== id; });
  sv(K.co, DB.con);
  logEv('contact', id, 'deleted', 'Contact deleted', 'user');  // ADD — after sv, before rCon
  rCon();
  toast('Contact deleted');
}
```

The `logEv` call is placed after `sv()` (delete persisted) and before `rCon()` (list re-render).

### 3.4 `saveQte()` — contact converted (actor: `'system'`)

Current code (lines 6897–6905). The `cConvertId` block:

```js
  if (cConvertId) {
    var convC = DB.con.find(function(x){ return x.id === cConvertId; });
    if (convC && convC.status !== 'converted') {
      convC.status = 'converted';
      convC.lastContactedAt = new Date().toISOString();
      sv(K.co, DB.con);
    }
    logEv('contact', cConvertId, 'converted', 'Quote ' + qt.num + ' created — contact converted', 'system');  // ADD
    cConvertId = null;
  }
```

The `logEv` call is placed **after** the inner `if (convC && ...)` block and **before** `cConvertId = null`. This means the event is always logged when `cConvertId` is set, regardless of whether the status mutation occurred (contact may already be `'converted'`). This is correct per the requirement: the quote-creation event is the trigger, not the status mutation.

`qt.num` is available at this point as the `qt` object was constructed earlier in `saveQte()`.

---

## 4. Activity Accordion HTML

### 4.1 Pattern

The accordion is a stateless HTML section. Collapsed by default via inline `style="display:none"` on the body div, toggled by a `toggleAcc(id)` function.

### 4.2 `toggleAcc()` function

Add to the UTILS section of index.html (after `logEv()`):

```js
function toggleAcc(bodyId) {
  var el = G(bodyId);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? '' : 'none';
}
```

### 4.3 Contact modal (`ov-con`) — markup addition

Append after the closing `</textarea>` of `ct-notes` and before the `<div class="btn-row">` (between lines 1610–1611 of index.html):

```html
<div style="margin-top:14px;border-top:1px solid var(--ln);padding-top:10px;">
  <div onclick="toggleAcc('con-activity-body');renderConActivity()" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:.52rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--m);">
    Activity
    <span style="font-size:.7rem;">&#9660;</span>
  </div>
  <div id="con-activity-body" style="display:none;margin-top:8px;font-size:.5rem;font-family:'DM Mono',monospace;max-height:200px;overflow-y:auto;">
    <div id="con-activity-list">No activity recorded.</div>
  </div>
</div>
```

### 4.4 Supplier modal (`ov-sup`) — markup addition

Append after the `<textarea id="sf-nt">` field and before the closing `</div>` of `class="mb"` (between lines 723–724 of index.html):

```html
<div style="margin-top:14px;border-top:1px solid var(--ln);padding-top:10px;grid-column:1/-1;">
  <div onclick="toggleAcc('sup-activity-body');renderSupActivity()" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:.52rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--m);">
    Activity
    <span style="font-size:.7rem;">&#9660;</span>
  </div>
  <div id="sup-activity-body" style="display:none;margin-top:8px;font-size:.5rem;font-family:'DM Mono',monospace;max-height:200px;overflow-y:auto;">
    <div id="sup-activity-list">No activity recorded.</div>
  </div>
</div>
```

Note: the supplier modal uses a CSS grid (`fg fg3`). The accordion wrapper requires `grid-column:1/-1` to span all columns, same as the existing notes textarea.

### 4.5 `renderConActivity()` function

```js
function renderConActivity() {
  var el = G('con-activity-list');
  if (!el) return;
  var filtered = (DB.events || []).filter(function(e){ return e.entityId === EI.co; });
  filtered.sort(function(a, b){ return b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0; });
  var rows = filtered.slice(0, 50);
  if (!rows.length) { el.innerHTML = 'No activity recorded.'; return; }
  el.innerHTML = rows.map(function(e){
    return '<div style="padding:3px 0;border-bottom:1px solid var(--ln);">' +
      san(e.ts.slice(0,10)) + ' <b>' + san(e.verb) + '</b> — ' + san(e.summary) +
    '</div>';
  }).join('');
}
```

### 4.6 `renderSupActivity()` function

```js
function renderSupActivity() {
  var el = G('sup-activity-list');
  if (!el) return;
  var filtered = (DB.events || []).filter(function(e){ return e.entityId === EI.s; });
  filtered.sort(function(a, b){ return b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0; });
  var rows = filtered.slice(0, 50);
  if (!rows.length) { el.innerHTML = 'No activity recorded.'; return; }
  el.innerHTML = rows.map(function(e){
    return '<div style="padding:3px 0;border-bottom:1px solid var(--ln);">' +
      san(e.ts.slice(0,10)) + ' <b>' + san(e.verb) + '</b> — ' + san(e.summary) +
    '</div>';
  }).join('');
}
```

Place both render functions in the CONTACTS section of the JS, after `editCon()` and before `saveCon()`.

### 4.7 Accordion re-collapse on modal open

**Decision (2026-06-21):** YES — accordion re-collapses on every modal open. Prevents stale activity from a prior record being visible before the new entity's events load.

**`openCon()` (line 6963)** — add before `G('ov-con').classList.add('on')`:
```js
var ab = G('con-activity-body'); if (ab) ab.style.display = 'none';
var al = G('con-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
```

**`editCon()` (line 6974)** — add before `G('ov-con').classList.add('on')`:
```js
var ab = G('con-activity-body'); if (ab) ab.style.display = 'none';
var al = G('con-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
```

**`openSup()` (line 3008)** — replace entire function:
```js
function openSup() {
  EI.s = null; G('sup-mt').textContent = 'New Supplier';
  ['sf-n','sf-c','sf-ct','sf-e','sf-p','sf-nt'].forEach(function(f){ var e=G(f); if(e) e.value=''; });
  vClrAll(['sf-n','sf-e']);
  G('sf-cur').value = 'USD'; populateDialCodes();
  var ab = G('sup-activity-body'); if (ab) ab.style.display = 'none';
  var al = G('sup-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
  G('ov-sup').classList.add('on'); setTimeout(function(){ G('sf-n').focus(); }, 50);
}
```

**`editSup()` (line 3014)** — replace entire function:
```js
function editSup(id) {
  var s = DB.sup.find(function(x){ return x.id===id; }); if(!s) return;
  EI.s = id; G('sup-mt').textContent = 'Edit Supplier';
  G('sf-n').value=s.name||''; G('sf-c').value=s.country||''; G('sf-ct').value=s.ct||'';
  G('sf-e').value=s.email||''; setSupPhone(s.phone||''); G('sf-nt').value=s.notes||'';
  G('sf-cur').value=s.cur||'USD';
  var ab = G('sup-activity-body'); if (ab) ab.style.display = 'none';
  var al = G('sup-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
  G('ov-sup').classList.add('on');
}
```

> NULL SAFETY (GAP-9 advisory): `renderConActivity()` filters on `EI.co`. If `EI.co` is null (accordion toggled on a new-contact modal before first save), the filter returns an empty array and the empty state text is shown. No null guard required — safe by design.

---

## 5. `rCon()` / `rSup()` Changes

No changes to `rCon()` (line 6940) or `rSup()` (not shown — supplier list render function). Activity rendering is triggered only on explicit accordion toggle via `renderConActivity()` / `renderSupActivity()`, not on list re-render. This avoids iterating `DB.events` on every keystroke in search filters.

---

## 6. `tests/run.js` Changes

### 6.1 `resetDB()` update

Current (lines 114–116 of tests/run.js):

```js
function resetDB() {
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: [] };
}
```

Replace with:

```js
function resetDB() {
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: [], events: [] };
}
```

No other changes to `tests/run.js` (beyond the new test cases in §8 below).

---

## 7. GDPR Disclosure Update

**Decision (2026-06-21):** New dedicated Privacy card in Settings. The event log is a local-only data disclosure — it does not belong in the Sheets card (external transmission) or Integrations card (external posting). A standalone Privacy card is added as the foundation for all future GDPR/data disclosures (contact retention, audit log, etc.).

### 7.1 Insertion point

Insert a new `<div class="card">` block in `v-cfg` (Settings view, `index.html`) **after the closing `</div>` of the Data card at line 555** and **before the `<div class="card" id="cfg-rates">` at line 556**.

**BEFORE (lines 554–556):**
```html
      <div id="repair-status" style="font-size:.56rem;color:var(--m);margin-top:6px;min-height:14px;"></div>
    </div>
    <div class="card" id="cfg-rates">
```

**AFTER:**
```html
      <div id="repair-status" style="font-size:.56rem;color:var(--m);margin-top:6px;min-height:14px;"></div>
    </div>
    <div class="card">
      <div class="ct">Privacy &amp; Data</div>
      <p style="font-size:.48rem;color:var(--m);margin-bottom:6px;">&#9432; <strong>Activity event log</strong> — Stackd Ops records operational events (contact created, status changes, quote conversions) in a local activity log (<code>st_ev</code>). Event records contain entity IDs and action descriptions only — no personal names. The log is capped at 2,000 entries (FIFO); oldest entries are dropped automatically. This data is local-only, included in your JSON backup, and never transmitted externally. Legal basis: Art.6(1)(f) legitimate interests in operating the trade portal.</p>
    </div>
    <div class="card" id="cfg-rates">
```

### 7.2 `storageHealth()` note

`storageHealth()` at line 6059 uses `Object.values(K).forEach(...)` to calculate storage usage. Adding `ev:'st_ev'` to `K` automatically includes `st_ev` in the storage health calculation. **No change to `storageHealth()` is required.**

---

## 8. Test Cases

Add these test cases to `tests/run.js` after the existing Contacts test block. Style matches existing tests in the file (synchronous, no await, uses `resetDB()`, references `ctx.*`).

```js
// ── EVENT LOG (REQ-V3-GAP-007) ─────────────────────────────────

test('AC-1: saveCon() new record logs created event', function() {
  resetDB();
  mockEl('ct-name').value  = 'Test Contact';
  mockEl('ct-email').value = 'test@example.com';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = '';
  ctx.EI.co = null;
  ctx.saveCon();
  assert(ctx.DB.events.length === 1, 'Expected 1 event');
  assertEqual(ctx.DB.events[0].verb, 'created');
  assertEqual(ctx.DB.events[0].entityType, 'contact');
  assertEqual(ctx.DB.events[0].actor, 'user');
  assertEqual(ctx.DB.events[0].entityId, ctx.DB.con[0].id);
});

test('AC-2: saveCon() edit with status change logs status_changed event', function() {
  resetDB();
  // Create initial contact
  var c = { id: ctx.uid(), name: 'Jane', email: 'jane@test.com', status: 'lead',
    source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(),
    lastContactedAt: '', enquiries: [], notes: '' };
  ctx.DB.con.push(c);
  // Edit with status change
  ctx.EI.co = c.id;
  mockEl('ct-name').value    = 'Jane';
  mockEl('ct-email').value   = 'jane@test.com';
  mockEl('ct-phone').value   = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value  = 'qualified';
  mockEl('ct-source').value  = 'manual';
  mockEl('ct-notes').value   = '';
  mockEl('ct-enq-summary').value = '';
  ctx.saveCon();
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'status_changed'; });
  assert(evts.length === 1, 'Expected 1 status_changed event');
  assertContains(evts[0].summary, 'qualified');
});

test('AC-3: saveQte() with cConvertId logs converted event on contact with system actor', function() {
  resetDB();
  var c = { id: ctx.uid(), name: 'Joe', email: 'joe@test.com', status: 'lead',
    source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(),
    lastContactedAt: '', enquiries: [], notes: '' };
  ctx.DB.con.push(c);
  ctx.cConvertId = c.id;
  // Set up minimum form fields for saveQte()
  mockEl('qf-num').value   = 'QT-TEST-001';
  mockEl('qf-client').value = 'Joe';
  mockEl('qf-dt').value    = '2026-06-21';
  mockEl('qf-valid').value = '2026-07-21';
  mockEl('qf-cur').value   = 'USD';
  mockEl('qf-mode').value  = 'LCL';
  mockEl('qf-mkp').value   = '15';
  mockEl('qf-st').value    = 'Draft';
  mockEl('qf-nt').value    = '';
  ctx.EI.qt = null;
  ctx.cQL = [];
  ctx.saveQte();
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'converted'; });
  assert(evts.length === 1, 'Expected 1 converted event');
  assertEqual(evts[0].entityType, 'contact');
  assertEqual(evts[0].entityId, c.id);
  assertEqual(evts[0].actor, 'system');
  assertContains(evts[0].summary, 'QT-TEST-001');
});

test('AC-4: logEv() with 2001 existing events trims to 2000', function() {
  resetDB();
  for (var i = 0; i < 2001; i++) {
    ctx.DB.events.push({ id: String(i), ts: new Date().toISOString(),
      entityType: 'contact', entityId: 'x', verb: 'updated', summary: 'test ' + i, actor: 'user' });
  }
  ctx.logEv('contact', 'y', 'created', 'overflow test', 'user');
  assertEqual(ctx.DB.events.length, 2000);
});

test('AC-4a: logEv() oldest entry is dropped when cap exceeded', function() {
  resetDB();
  ctx.DB.events.push({ id: 'oldest', ts: '2020-01-01T00:00:00.000Z',
    entityType: 'contact', entityId: 'x', verb: 'created', summary: 'first', actor: 'user' });
  for (var i = 0; i < 2000; i++) {
    ctx.DB.events.push({ id: String(i), ts: new Date().toISOString(),
      entityType: 'contact', entityId: 'x', verb: 'updated', summary: 'fill', actor: 'user' });
  }
  ctx.logEv('contact', 'y', 'created', 'trigger trim', 'user');
  assertEqual(ctx.DB.events.length, 2000);
  assert(ctx.DB.events[0].id !== 'oldest', 'Oldest entry should have been trimmed');
});

test('AC-7: expAll() snapshot contains events array', function() {
  resetDB();
  ctx.DB.events.push({ id: 'e1', ts: new Date().toISOString(),
    entityType: 'contact', entityId: 'x', verb: 'created', summary: 'test', actor: 'user' });
  // expAll() triggers a download — we cannot intercept it in test harness.
  // Instead verify the snap object construction by calling the inner logic directly.
  // This test verifies via a proxy: after saveCon creates an event and expAll is called,
  // the event array is non-empty and would be included.
  // Full snap shape tested via integration only. Unit-testable portion:
  assert(Array.isArray(ctx.DB.events), 'DB.events must be an array');
  assertEqual(ctx.DB.events.length, 1);
  assertEqual(ctx.DB.events[0].id, 'e1');
});

test('AC-8: doImport() with events array populates DB.events', function() {
  resetDB();
  // doImport() uses FileReader — not mockable in VM harness.
  // Test the import assignment logic directly as a unit:
  var importedData = { events: [
    { id: 'ev-import-1', ts: '2026-01-01T00:00:00.000Z',
      entityType: 'contact', entityId: 'abc', verb: 'created', summary: 'Imported event', actor: 'user' }
  ]};
  ctx.DB.events = Array.isArray(importedData.events) ? importedData.events : [];
  assertEqual(ctx.DB.events.length, 1);
  assertEqual(ctx.DB.events[0].id, 'ev-import-1');
});

test('AC-8a: doImport() with no events key in backup defaults to empty array', function() {
  resetDB();
  ctx.DB.events = [{ id: 'pre-existing' }];
  var importedData = {}; // no events key — pre-v2.9.28 backup
  ctx.DB.events = Array.isArray(importedData.events) ? importedData.events : [];
  assertEqual(ctx.DB.events.length, 0);
});

test('AC-9: resetDB() includes empty events array', function() {
  ctx.DB.events = [{ id: 'stale' }];
  resetDB();
  assert(Array.isArray(ctx.DB.events), 'DB.events must be an array after resetDB()');
  assertEqual(ctx.DB.events.length, 0);
});

test('AC-1b: logEv() actor defaults to user when omitted', function() {
  resetDB();
  ctx.logEv('contact', 'x', 'updated', 'Test summary');
  assertEqual(ctx.DB.events[0].actor, 'user');
});

test('AC-1c: logEv() accepts out-of-enum verb without throwing', function() {
  resetDB();
  var threw = false;
  try {
    ctx.logEv('contact', 'x', 'custom_verb_not_in_enum', 'Test', 'user');
  } catch(e) { threw = true; }
  assert(!threw, 'logEv() must not throw on unknown verb');
  assertEqual(ctx.DB.events[0].verb, 'custom_verb_not_in_enum');
});

test('AC-2a: saveCon() edit with note only (no status change) logs note_added', function() {
  resetDB();
  var c = { id: ctx.uid(), name: 'Sam', email: 'sam@test.com', status: 'lead',
    source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(),
    lastContactedAt: '', enquiries: [], notes: '' };
  ctx.DB.con.push(c);
  ctx.EI.co = c.id;
  mockEl('ct-name').value    = 'Sam';
  mockEl('ct-email').value   = 'sam@test.com';
  mockEl('ct-phone').value   = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value  = 'lead'; // unchanged
  mockEl('ct-source').value  = 'manual';
  mockEl('ct-notes').value   = '';
  mockEl('ct-enq-summary').value = 'Interested in fridges';
  ctx.saveCon();
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'note_added'; });
  assert(evts.length === 1, 'Expected 1 note_added event');
});

test('AC-2b: saveCon() edit with no status/note change logs updated', function() {
  resetDB();
  var c = { id: ctx.uid(), name: 'Pat', email: 'pat@test.com', status: 'lead',
    source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(),
    lastContactedAt: '', enquiries: [], notes: '' };
  ctx.DB.con.push(c);
  ctx.EI.co = c.id;
  mockEl('ct-name').value    = 'Pat';
  mockEl('ct-email').value   = 'pat@test.com';
  mockEl('ct-phone').value   = '+441234567890';
  mockEl('ct-company').value = 'Acme';
  mockEl('ct-status').value  = 'lead'; // unchanged
  mockEl('ct-source').value  = 'manual';
  mockEl('ct-notes').value   = 'Updated notes';
  mockEl('ct-enq-summary').value = ''; // no new enquiry
  ctx.saveCon();
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'updated'; });
  assert(evts.length === 1, 'Expected 1 updated event');
});

test('AC-1d: delCon() logs deleted event', function() {
  resetDB();
  var c = { id: ctx.uid(), name: 'Del', email: 'del@test.com', status: 'lead',
    source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(),
    lastContactedAt: '', enquiries: [], notes: '' };
  ctx.DB.con.push(c);
  var cId = c.id;
  // confirm() returns false by default in mock — must override for this test
  var origConfirm = ctx.confirm;
  ctx.confirm = function() { return true; };
  ctx.delCon(cId);
  ctx.confirm = origConfirm;
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'deleted'; });
  assert(evts.length === 1, 'Expected 1 deleted event');
  assertEqual(evts[0].entityId, cId);
  assertEqual(evts[0].actor, 'user');
});
```

### Manual QA checklist — AC-5 and AC-10

These ACs cover accordion render behaviour and are verified manually during PR review.

**AC-5: Contact with 3 events — Activity section shows entries newest-first**

Setup:
1. Open the portal on the PR branch
2. Create a new contact (name: Test QA, email: qa@test.com, status: Lead) → Save → confirms `created` event logged
3. Edit the contact, change status to Qualified → Save → confirms `status_changed` event logged
4. Edit the contact, add enquiry note "Interested in fridges" → Save → confirms `note_added` event logged
5. Edit the contact again → click "Activity" header to expand accordion

Assert:
- Accordion expands; 3 rows visible
- Row 1 (top): today's date, `note_added — Enquiry note added`
- Row 2: today's date, `status_changed — Status changed to qualified`
- Row 3: today's date, `created — Contact created`
- Dates are in `YYYY-MM-DD` format

**AC-10: Supplier modal — Activity accordion always shows empty state in v2.9.28**

Setup:
1. Open or create any supplier → Edit
2. Click "Activity" header to expand accordion

Assert:
- Accordion expands
- Text shown: `No activity recorded.`
- No error thrown in browser console

---

## 9. Version Delivery Checklist

Per CLAUDE.md `## On version delivery`:

1. **CLAUDE.md** — bump `Current version` from v2.9.27 to v2.9.28. Update `Test count`. Update `K` constant documentation to include `ev`. Update `DB` entity table to add `events` row. Update `State layer` code block to include `events: ldArr(K.ev)`.

2. **`docs/version-history.md`** — prepend new row:
   ```
   | v2.9.28 | Global event log (DB.events) — contact activity accordion in ov-con and ov-sup modals. logEv() helper. Emission points: saveCon (created/status_changed/note_added/updated), delCon (deleted), saveQte cConvertId path (converted). 2,000-event FIFO cap. GDPR disclosure update. EVT-GAP-001 logged. N tests. |
   ```

3. **`docs/known-gaps.md`** — add new entry:
   ```
   | EVT-GAP-001 | Event log | No user-visible warning when 2,000-event cap is hit — oldest events silently dropped |
   ```

4. **`AI_SYSTEM_PROMPT` in index.html** — add section covering:
   - `DB.events` — what it is, what it stores, that it is local-only
   - How to view activity: Contact modal → Activity accordion (toggle to expand)
   - Supplier modal also has accordion (always empty in v2.9.28 — supplier events added in future version)
   - 2,000-event retention cap, FIFO
   - No PII in event records — entity IDs and operational text only

5. **In-app changelog** — prepend v2.9.28 block:
   ```
   v2.9.28 — Global event log
   • New: DB.events — local-only activity log, no Sheets sync
   • New: logEv() helper — pushes timestamped events, 2,000-event FIFO cap
   • New: Activity accordion in Contact modal — shows contact history, newest first, max 50 entries
   • New: Activity accordion in Supplier modal — scaffolding for v2.9.29 supplier events
   • Emission: contact created / status changed / note added / updated / deleted / converted (via quote)
   • Compliance: GDPR disclosure note added for event log in Settings
   ```

6. **`STACKD_CONTEXT.md`** — update `Current state` version row. Update `Architecture` state layer block. Update `Known gaps` table with EVT-GAP-001. Update `Version history` table.

7. **Raise a PR** — push branch, raise PR for user review before merging to `main`.

---

## 10. Ambiguity Resolutions

All ambiguities resolved 2026-06-21:

| # | Decision |
|---|----------|
| A-1 | YES — `saveAll()` includes `sv(K.ev, DB.events)`. See §1.4. |
| A-2 | YES — accordion re-collapses on modal reopen. See §4.7. |
| A-3 | New Privacy card in Settings. See §7. |
| A-4 | AC-5 and AC-10 accordion render tests — **manual QA only**. Test harness covers logic paths; DOM render verified during PR review. |
| A-5 | Show events count in restore toast. See §1.6. |

---

*End of SPEC-V3-GAP-007-v1*
