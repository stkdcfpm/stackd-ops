# SPEC-V3-GAP-006 v2 — Supplier → Contact Sub-panel

**Requirement:** REQ-V3-GAP-006-v3.md  
**Version target:** v2.9.29  
**Status:** Awaiting spec-gate
**Supersedes:** SPEC-V3-GAP-006-v1.md

---

## Overview

Add `supplierId` (string | null) and `role` (`'buyer_contact' | 'supplier_contact' | ''`) fields to `DB.con` records. Add a Contacts sub-panel to the Supplier edit modal, a Supplier dropdown to the Contact modal, and a Supplier column to the Contacts list table.

No new `K` key, no new `DB` entity, no `FIELD_MAPS` change — the two new fields are omitted from sync by the existing `mapRec()` mechanism.

---

## §1 — `tests/run.js` harness: add `prompt` to VM context

### 1.1 Add `prompt` to VM context

In `tests/run.js`, in the `vm.createContext({...})` block (around line 52), add a `prompt` entry alongside `confirm`:

**BEFORE:**
```js
  confirm:         () => false,
```

**AFTER:**
```js
  confirm:         () => false,
  prompt:          () => null,
```

This makes `prompt` available in the VM sandbox. Individual tests override it in-place: `ctx.prompt = function(){ return '1'; };` and reset after: `ctx.prompt = function(){ return null; };`.

---

## §2 — Contact record schema changes

### 2.1 `saveCon()` — persist new fields

`saveCon()` builds the `con` object literal. Add `supplierId` and `role` as the last two properties:

**BEFORE (end of con object literal):**
```js
    notes:           G('ct-notes').value.trim()
  };
```

**AFTER:**
```js
    notes:           G('ct-notes').value.trim(),
    supplierId:      G('ct-sup').value || null,
    role:            G('ct-sup').value ? 'supplier_contact' : ''
  };
```

`G('ct-sup').value` is the new Supplier dropdown (§3.1). Empty string → `null` / `''`.

### 2.2 `editCon()` — populate Supplier dropdown

After the last existing field assignment (`G('ct-enq-summary').value = ''`), add:

```js
  populateConSupDrop();
  G('ct-sup').value = c.supplierId || '';
```

### 2.3 `openCon()` — authoritative replacement

Replace the entire `openCon()` function with the following. This is the single authoritative body resolving the reconciliation between the prefill parameter, dropdown population, and accordion reset (spec-gate v1 Gap 6):

```js
function openCon(prefillSupplierId) {
  EI.co = null;
  G('con-title').textContent = 'New Contact';
  ['ct-name','ct-email','ct-phone','ct-company','ct-notes','ct-enq-summary'].forEach(function(id){ G(id).value = ''; });
  G('ct-status').value = 'lead';
  G('ct-source').value = 'manual';
  populateConSupDrop();
  G('ct-sup').value = prefillSupplierId || '';
  vClr('ct-name');
  vClr('ct-email');
  var ab = G('con-activity-body'); if (ab) ab.style.display = 'none';
  var al = G('con-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
  G('ov-con').classList.add('on');
}
```

Call order: reset fields → populate options → set prefill value → show modal. Options must exist before setting value so the `<select>` retains the selection.

---

## §3 — Contact modal HTML changes

### 3.1 Add Supplier dropdown to `ov-con`

In the Contact modal HTML, insert between the `<select id="ct-source">` block and `<label>New enquiry note</label>`:

**BEFORE:**
```html
    <label>Source</label>
    <select id="ct-source">
      <option value="manual">Manual</option>
      <option value="chat">Chat</option>
    </select>
    <label>New enquiry note</label>
```

**AFTER:**
```html
    <label>Source</label>
    <select id="ct-source">
      <option value="manual">Manual</option>
      <option value="chat">Chat</option>
    </select>
    <label>Supplier</label>
    <select id="ct-sup">
      <option value="">None</option>
    </select>
    <label>New enquiry note</label>
```

### 3.2 `populateConSupDrop()` helper

Add this function before `openCon()`:

```js
function populateConSupDrop() {
  var el = G('ct-sup'); if (!el) return;
  var cur = el.value;
  el.innerHTML = '<option value="">None</option>' +
    DB.sup.map(function(s){ return '<option value="' + s.id + '">' + san(s.name) + '</option>'; }).join('');
  el.value = cur;
}
```

Preserves the currently selected value when rebuilding options. Also call `populateConSupDrop()` at the end of `rSup()`, after the existing options rebuild for `['lf-sup','pf-sup']` and `li-sf`.

---

## §4 — Contacts list table: Supplier column

### 4.1 Table header

**BEFORE (verbatim — use this as the Edit old_string):**
```html
    <thead><tr>
      <th>Name</th><th>Company</th><th>Email</th>
      <th>Status</th><th>Source</th><th>Last Contact</th><th>Enquiries</th><th></th>
    </tr></thead>
```

**AFTER:**
```html
    <thead><tr>
      <th>Name</th><th>Company</th><th>Email</th>
      <th>Status</th><th>Source</th><th>Supplier</th><th>Last Contact</th><th>Enquiries</th><th></th>
    </tr></thead>
```

### 4.2 `rCon()` — add Supplier cell

**BEFORE (in rCon row template):**
```js
      '<td>' + san(c.source||'—') + '</td>' +
      '<td>' + lastDate + '</td>' +
```

**AFTER:**
```js
      '<td>' + san(c.source||'—') + '</td>' +
      '<td>' + (c.supplierId ? san(gsn(c.supplierId)) : '—') + '</td>' +
      '<td>' + lastDate + '</td>' +
```

---

## §5 — Supplier modal: Contacts sub-panel

The Contacts sub-panel is shown only when `EI.s` is set (editing an existing supplier). It is hidden on new-supplier form.

### 5.1 HTML — add sub-panel to `ov-sup`

Insert immediately before the closing `</div>` of the `.fg.fg3` grid (i.e., before the `<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">` button row):

**BEFORE:**
```html
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
    <button class="btn btn-g" onclick="closeM('ov-sup')">Cancel</button>
    <button class="btn btn-s" onclick="saveSup()">Save Supplier</button>
  </div>
```

**AFTER:**
```html
    <div id="sup-con-panel" style="grid-column:1/-1;margin-top:14px;border-top:1px solid var(--ln);padding-top:10px;display:none;">
      <div style="font-size:.52rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--m);margin-bottom:8px;">Contacts</div>
      <div id="sup-con-list" style="font-size:.5rem;margin-bottom:10px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-s" style="font-size:.48rem;" onclick="openSupConPicker()">+ Link Contact</button>
        <button class="btn btn-g" style="font-size:.48rem;" onclick="openCon(EI.s)">+ New Contact</button>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
    <button class="btn btn-g" onclick="closeM('ov-sup')">Cancel</button>
    <button class="btn btn-s" onclick="saveSup()">Save Supplier</button>
  </div>
```

### 5.2 `renderSupContacts()` — render linked contacts

Add this function before `openSup()`:

```js
function renderSupContacts() {
  var el = G('sup-con-list'); if (!el) return;
  var linked = DB.con.filter(function(c){ return c.supplierId === EI.s; });
  if (!linked.length) { el.innerHTML = '<span style="color:var(--m);">No contacts linked.</span>'; return; }
  el.innerHTML = '<table class="tbl" style="font-size:.5rem;width:100%;"><thead><tr><th>Name</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>' +
    linked.map(function(c){
      return '<tr><td>' + san(c.name) + '</td><td>' + san(c.email) + '</td>' +
        '<td><span class="tag s-' + c.status + '">' + san(c.status) + '</span></td>' +
        '<td><button class="ab" onclick="unlinkSupCon(\'' + c.id + '\')">Unlink</button></td></tr>';
    }).join('') + '</tbody></table>';
}
```

### 5.3 `openSup()` — hide panel explicitly

In `openSup()`, after the existing accordion reset lines and before `G('ov-sup').classList.add('on')`, add:

```js
  var panel = G('sup-con-panel'); if (panel) panel.style.display = 'none';
```

This guarantees the panel is hidden when opening a new-supplier form, even if a previous `editSup()` left it visible (spec-gate v1 Gap 3).

### 5.4 `editSup()` — show panel and render contacts

In `editSup(id)`, after the existing accordion reset lines and before `G('ov-sup').classList.add('on')`, add:

```js
  var panel = G('sup-con-panel'); if (panel) panel.style.display = '';
  renderSupContacts();
```

### 5.5 `unlinkSupCon(contactId)` — unlink a contact

Add before `openSup()`:

```js
function unlinkSupCon(contactId) {
  var c = DB.con.find(function(x){ return x.id === contactId; }); if (!c) return;
  c.supplierId = null;
  c.role = '';
  sv(K.co, DB.con);
  renderSupContacts();
  rCon();
  toast('Contact unlinked');
}
```

### 5.6 `openSupConPicker()` — link existing contact

Add before `openSup()`:

```js
function openSupConPicker() {
  var eligible = DB.con.filter(function(c){
    return !c.supplierId || c.supplierId === EI.s;
  });
  if (!eligible.length) { toast('No eligible contacts to link.'); return; }
  var list = eligible.map(function(c, i){ return (i+1) + '. ' + c.name + ' <' + c.email + '>'; }).join('\n');
  var input = prompt('Link a contact to this supplier.\nEnter the number:\n\n' + list);
  if (!input) return;
  var idx = parseInt(input, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= eligible.length) { toast('Invalid selection.'); return; }
  var c = eligible[idx];
  c.supplierId = EI.s;
  c.role = 'supplier_contact';
  sv(K.co, DB.con);
  renderSupContacts();
  rCon();
  toast('Contact linked');
}
```

---

## §6 — `delSup()` — null FK on contacts (ordering explicit)

All three operations are synchronous before the `await`. The `sv(K.co, DB.con)` call must precede `await delEnt(...)` to guarantee contacts are persisted even if the async network call fails. Replace the existing `DB.sup = DB.sup.filter(...); sv(K.s,DB.sup); rSup(); toast(...); await delEnt(...)` line:

**BEFORE:**
```js
  DB.sup = DB.sup.filter(function(s){ return s.id!==id; });
  sv(K.s,DB.sup); rSup(); toast('Deleted'); await delEnt('sup',id).catch(function(){});
```

**AFTER:**
```js
  DB.sup = DB.sup.filter(function(s){ return s.id!==id; });
  DB.con.forEach(function(c){ if (c.supplierId === id) { c.supplierId = null; c.role = ''; } });
  sv(K.co, DB.con);
  sv(K.s,DB.sup); rSup(); toast('Deleted'); await delEnt('sup',id).catch(function(){});
```

Order of operations: filter supplier → null FK on contacts → persist contacts → persist suppliers → render → async delete.

---

## §7 — `doImport()` — no change required

`supplierId` and `role` are optional fields. `DB.con = Array.isArray(data.con) ? data.con : []` already handles old backups — records without these fields have them as `undefined`, which is treated as falsy throughout (safe).

---

## §8 — `tests/run.js` new test cases

Append after existing Contacts test block. Note: `rCon` is already stubbed as a no-op in the test file (`ctx.rCon = function(){}`); this stub is compatible with these tests. Each test uses `ctx.confirm = function(){ return true; }` per the established harness pattern (not a named `confirm_override` property).

```js
// ── REQ-V3-GAP-006: Supplier→Contact sub-panel ──────────────────────────────

test('AC-1: supplierId and role set when saved with supplier selected', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Alice';
  mockEl('ct-email').value = 'alice@example.com';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-enq-summary').value = '';
  mockEl('ct-notes').value = '';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-sup').value = 'S1';
  ctx.saveCon();
  assert.strictEqual(ctx.DB.con.length, 1, 'contact created');
  assert.strictEqual(ctx.DB.con[0].supplierId, 'S1', 'supplierId set');
  assert.strictEqual(ctx.DB.con[0].role, 'supplier_contact', 'role set');
});

test('AC-4: supplierId null and role empty for independently created contact', function() {
  ctx.resetDB();
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Bob';
  mockEl('ct-email').value = 'bob@example.com';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-enq-summary').value = '';
  mockEl('ct-notes').value = '';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-sup').value = '';
  ctx.saveCon();
  assert.strictEqual(ctx.DB.con[0].supplierId, null, 'supplierId null');
  assert.strictEqual(ctx.DB.con[0].role, '', 'role empty string');
});

test('AC-2: unlinkSupCon nulls supplierId and clears role, contact preserved', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.unlinkSupCon('C1');
  assert.strictEqual(ctx.DB.con[0].supplierId, null, 'supplierId nulled');
  assert.strictEqual(ctx.DB.con[0].role, '', 'role cleared');
  assert.strictEqual(ctx.DB.con.length, 1, 'contact preserved');
});

test('AC-5: delSup nulls supplierId on linked contacts and preserves them', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.DB.con.push({ id: 'C2', name: 'Bob', email: 'bob@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.confirm = function(){ return true; };
  ctx.delSup('S1');
  assert.strictEqual(ctx.DB.con.length, 2, 'both contacts preserved');
  assert.strictEqual(ctx.DB.con[0].supplierId, null, 'C1 supplierId nulled');
  assert.strictEqual(ctx.DB.con[0].role, '', 'C1 role cleared');
  assert.strictEqual(ctx.DB.con[1].supplierId, null, 'C2 unaffected');
  assert.strictEqual(ctx.DB.sup.length, 0, 'supplier deleted');
  ctx.confirm = function(){ return false; };
});

test('AC-6: openSupConPicker links contact — supplierId and role set', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.prompt = function(){ return '1'; };
  ctx.openSupConPicker();
  ctx.prompt = function(){ return null; };
  assert.strictEqual(ctx.DB.con[0].supplierId, 'S1', 'supplierId set');
  assert.strictEqual(ctx.DB.con[0].role, 'supplier_contact', 'role set');
});

test('AC-3: contact linked to Supplier X excluded from picker for Supplier Y', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'SX', name: 'ACME' });
  ctx.DB.sup.push({ id: 'SY', name: 'Globex' });
  ctx.DB.con.push({ id: 'CB', name: 'Bob', email: 'bob@example.com', supplierId: 'SX', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'SY';
  var eligible = ctx.DB.con.filter(function(c){ return !c.supplierId || c.supplierId === ctx.EI.s; });
  assert.strictEqual(eligible.length, 0, 'Contact B absent from picker for Supplier Y');
});

test('AC-7: rCon renders Supplier column with gsn() name for linked contact', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME Goods' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  var html = ctx.DB.con.map(function(c){
    return (c.supplierId ? ctx.gsn(c.supplierId) : '—');
  }).join('');
  assert.ok(html.indexOf('ACME Goods') >= 0, 'supplier name rendered via gsn()');
});

test('AC-8: clearing Supplier dropdown before save sets supplierId null and role empty', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Carol';
  mockEl('ct-email').value = 'carol@example.com';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-enq-summary').value = '';
  mockEl('ct-notes').value = '';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-sup').value = '';
  ctx.saveCon();
  assert.strictEqual(ctx.DB.con[0].supplierId, null, 'supplierId null when dropdown cleared');
  assert.strictEqual(ctx.DB.con[0].role, '', 'role empty when dropdown cleared');
});
```

**Note on AC-7 test approach:** `rCon()` is stubbed as a no-op in the test harness. The test validates the logic directly — `gsn(c.supplierId)` returning the supplier name — which is the observable behaviour the AC requires. The HTML rendering of that value in the table cell is verified by manual QA checklist item AC-7.

---

## §9 — CLAUDE.md and version delivery

On completion:
- CLAUDE.md: bump to `v2.9.29`, update Test count
- `docs/version-history.md`: prepend v2.9.29 row
- `docs/known-gaps.md`: no new gaps
- `AI_SYSTEM_PROMPT`: update to mention supplierId/role on contacts, Supplier sub-panel in supplier modal (edit mode only), Supplier column in contacts list, contacts may be linked to one supplier at a time
- In-app changelog: prepend v2.9.29 block
- Raise PR to `claude/amazing-galileo-4hhygo`

---

## Scope boundaries

| In scope | Out of scope |
|---|---|
| supplierId + role fields on DB.con | Sheets sync of supplierId/role (mapRec() silently omits) |
| Contacts sub-panel in Supplier edit modal | Event log emissions on delCon (deferred per REQ-006 §9) |
| Supplier column in Contacts list | Event log emissions for link/unlink (deferred) |
| Supplier dropdown in Contact modal | New DB entity or K key |
| delSup() nulls FKs before async call | Full agentic picker UI (prompt() is sufficient) |
| prompt added to VM context in harness | |

---

## Manual QA checklist

- [ ] AC-1: Create contact with Supplier selected → supplierId and role='supplier_contact' in record
- [ ] AC-2: Unlink contact from Supplier sub-panel → contact survives, supplierId null, role ''
- [ ] AC-3: Open link picker on Supplier Y → contact already linked to Supplier X is absent
- [ ] AC-4: Create contact with no supplier → supplierId null, role ''
- [ ] AC-5: Delete Supplier X → contacts previously linked to X survive with supplierId null
- [ ] AC-6: Link contact via picker → supplierId and role set
- [ ] AC-7: Contacts list table shows Supplier column with linked supplier name via gsn()
- [ ] AC-8: Open New Contact from Supplier sub-panel, clear Supplier dropdown, save → supplierId null
- [ ] Supplier sub-panel hidden on new-supplier form (openSup()), visible on editSup()
- [ ] openSup() after editSup() correctly hides the panel (no state leak)
