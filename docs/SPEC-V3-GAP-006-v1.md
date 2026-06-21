# SPEC-V3-GAP-006 v1 — Supplier → Contact Sub-panel

**Requirement:** REQ-V3-GAP-006-v3.md  
**Version target:** v2.9.29  
**Status:** Awaiting spec-gate

---

## Overview

Add `supplierId` (string | null) and `role` (`'buyer_contact' | 'supplier_contact' | ''`) fields to `DB.con` records. Add a Contacts sub-panel to the Supplier edit modal, a Supplier dropdown to the Contact modal, and a Supplier column to the Contacts list table.

No new `K` key, no new `DB` entity, no `FIELD_MAPS` change — the two new fields are omitted from sync by the existing `mapRec()` mechanism.

---

## §1 — Contact record schema changes

### 1.1 `saveCon()` — persist new fields

`saveCon()` currently builds the `con` object (lines ~7136–7147). Add `supplierId` and `role` to the object literal:

**BEFORE (inside the `con = { ... }` object literal):**
```js
    notes:           G('ct-notes').value.trim()
```

**AFTER:**
```js
    notes:           G('ct-notes').value.trim(),
    supplierId:      G('ct-sup').value || null,
    role:            G('ct-sup').value ? 'supplier_contact' : ''
```

`G('ct-sup').value` is the new Supplier dropdown (§3.1). Empty string maps to `null` / `''`.

### 1.2 `saveCon()` — carry forward on edit

When editing, `existC` already preserves all unrendered fields because the new `con` object is built from form values. `supplierId`/`role` are now explicitly set from the dropdown, so no carry-forward special case is needed.

### 1.3 `editCon()` — populate Supplier dropdown

After the existing field population block, add:

```js
  G('ct-sup').value = c.supplierId || '';
```

### 1.4 `openCon()` — reset Supplier dropdown

After the existing field reset block, add:

```js
  G('ct-sup').value = '';
```

### 1.5 `openCon()` — pre-fill from supplier context

`openCon()` gains an optional parameter `prefillSupplierId` (default `undefined`). When supplied, set the dropdown after reset:

```js
function openCon(prefillSupplierId) {
  EI.co = null;
  G('con-title').textContent = 'New Contact';
  ['ct-name','ct-email','ct-phone','ct-company','ct-notes','ct-enq-summary'].forEach(function(id){ G(id).value = ''; });
  G('ct-status').value = 'lead';
  G('ct-source').value = 'manual';
  G('ct-sup').value = prefillSupplierId || '';
  vClr('ct-name');
  vClr('ct-email');
  var ab = G('con-activity-body'); if (ab) ab.style.display = 'none';
  var al = G('con-activity-list'); if (al) al.innerHTML = 'No activity recorded.';
  G('ov-con').classList.add('on');
}
```

---

## §2 — Contact modal HTML changes

### 2.1 Add Supplier dropdown to `ov-con`

Insert after `<select id="ct-source">...</select>` block and before the `<label>New enquiry note</label>` line:

```html
    <label>Supplier</label>
    <select id="ct-sup">
      <option value="">None</option>
    </select>
```

### 2.2 Populate Supplier dropdown on render

Add a helper `populateConSupDrop()` that rebuilds `#ct-sup` options (keeping current value):

```js
function populateConSupDrop() {
  var el = G('ct-sup'); if (!el) return;
  var cur = el.value;
  el.innerHTML = '<option value="">None</option>' +
    DB.sup.map(function(s){ return '<option value="' + s.id + '">' + san(s.name) + '</option>'; }).join('');
  el.value = cur;
}
```

Call `populateConSupDrop()` at the end of `openCon()` and `editCon()` (after the accordion reset lines, before `G('ov-con').classList.add('on')`).

Also call `populateConSupDrop()` at the end of `rSup()` to keep the dropdown fresh when suppliers are added/deleted. Append after the existing `['lf-sup','pf-sup','li-sf']` option-rebuild block in `rSup()`.

---

## §3 — Contacts list table: Supplier column

### 3.1 Table header

Current header in `ov-con` view (line ~363):
```html
<th>Name</th><th>Company</th><th>Email</th>
<th>Status</th><th>Source</th><th>Last Contact</th><th>Enquiries</th><th></th>
```

Replace with:
```html
<th>Name</th><th>Company</th><th>Email</th>
<th>Status</th><th>Source</th><th>Supplier</th><th>Last Contact</th><th>Enquiries</th><th></th>
```

### 3.2 `rCon()` — add Supplier cell

In `rCon()`, each row currently renders 8 `<td>` cells. Add a Supplier cell after Source:

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

## §4 — Supplier modal: Contacts sub-panel

The Contacts sub-panel is shown only when `EI.s` is set (editing an existing supplier). It is hidden on new-supplier form.

### 4.1 HTML — add sub-panel to `ov-sup`

Insert after the Activity accordion `</div>` block (which closes after `</div>` of `sup-activity-body`) and before the close of `</div>` that ends the `.fg.fg3` grid, i.e. immediately before:

```html
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
```

Insert:

```html
    <div id="sup-con-panel" style="grid-column:1/-1;margin-top:14px;border-top:1px solid var(--ln);padding-top:10px;display:none;">
      <div style="font-size:.52rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--m);margin-bottom:8px;">Contacts</div>
      <div id="sup-con-list" style="font-size:.5rem;margin-bottom:10px;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-s" style="font-size:.48rem;" onclick="openSupConPicker()">+ Link Contact</button>
        <button class="btn btn-g" style="font-size:.48rem;" onclick="openCon(EI.s)">+ New Contact</button>
      </div>
    </div>
```

### 4.2 `renderSupContacts()` — render linked contacts

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

### 4.3 Show/hide sub-panel

In `openSup()`: panel stays hidden (default `display:none`).  
In `editSup(id)`: show panel and call `renderSupContacts()` after setting `EI.s`:

```js
  var panel = G('sup-con-panel'); if (panel) panel.style.display = '';
  renderSupContacts();
```

### 4.4 `unlinkSupCon(contactId)` — unlink a contact

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

### 4.5 `openSupConPicker()` — link existing contact

Show a `prompt()`-based picker listing eligible contacts (supplierId is null or already equals current supplier). If the operator cancels, do nothing. If they select, set FK and save.

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

## §5 — `delSup()` — null FK on contacts

In `delSup(id)`, after `DB.sup = DB.sup.filter(...)` and before `sv(K.s, DB.sup)`:

```js
  DB.con.forEach(function(c){ if (c.supplierId === id) { c.supplierId = null; c.role = ''; } });
  sv(K.co, DB.con);
```

Full updated `delSup` block (replacing the existing `DB.sup = ...` + `sv(K.s,DB.sup)` line):

```js
  DB.sup = DB.sup.filter(function(s){ return s.id!==id; });
  DB.con.forEach(function(c){ if (c.supplierId === id) { c.supplierId = null; c.role = ''; } });
  sv(K.co, DB.con);
  sv(K.s,DB.sup); rSup(); toast('Deleted'); await delEnt('sup',id).catch(function(){});
```

---

## §6 — `doImport()` — backwards compatibility

`supplierId` and `role` are optional fields on contact records. Existing import logic (`DB.con = Array.isArray(data.con) ? data.con : []`) already handles old backups without these fields — records will simply have them as `undefined`, which is safe (treated as falsy throughout). No change to `doImport()` required.

---

## §7 — `tests/run.js` changes

### 7.1 Existing `resetDB()`

No change required — `con: []` is already present. New tests use contacts with `supplierId`/`role` fields added inline.

### 7.2 New test cases

Append after existing Contacts test block:

```js
// ── REQ-V3-GAP-006: Supplier→Contact sub-panel ──────────────────

t('AC-1: supplierId and role set when saved with supplier selected', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.co = null;
  ctx.G('ct-name').value = 'Alice';
  ctx.G('ct-email').value = 'alice@example.com';
  ctx.G('ct-status').value = 'lead';
  ctx.G('ct-source').value = 'manual';
  ctx.G('ct-enq-summary').value = '';
  ctx.G('ct-notes').value = '';
  ctx.G('ct-phone').value = '';
  ctx.G('ct-company').value = '';
  ctx.G('ct-sup').value = 'S1';
  ctx.saveCon();
  assert(ctx.DB.con.length === 1, 'contact created');
  assert(ctx.DB.con[0].supplierId === 'S1', 'supplierId set');
  assert(ctx.DB.con[0].role === 'supplier_contact', 'role set');
});

t('AC-4: supplierId null and role empty for independently created contact', function() {
  ctx.resetDB();
  ctx.EI.co = null;
  ctx.G('ct-name').value = 'Bob';
  ctx.G('ct-email').value = 'bob@example.com';
  ctx.G('ct-status').value = 'lead';
  ctx.G('ct-source').value = 'manual';
  ctx.G('ct-enq-summary').value = '';
  ctx.G('ct-notes').value = '';
  ctx.G('ct-phone').value = '';
  ctx.G('ct-company').value = '';
  ctx.G('ct-sup').value = '';
  ctx.saveCon();
  assert(ctx.DB.con[0].supplierId === null, 'supplierId null');
  assert(ctx.DB.con[0].role === '', 'role empty string');
});

t('AC-2: unlinkSupCon nulls supplierId and clears role', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.unlinkSupCon('C1');
  assert(ctx.DB.con[0].supplierId === null, 'supplierId nulled');
  assert(ctx.DB.con[0].role === '', 'role cleared');
  assert(ctx.DB.con.length === 1, 'contact preserved');
});

t('AC-5: delSup nulls supplierId on linked contacts and preserves them', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.DB.con.push({ id: 'C2', name: 'Bob', email: 'bob@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.confirm_override = true;
  ctx.delSup('S1');
  assert(ctx.DB.con.length === 2, 'both contacts preserved');
  assert(ctx.DB.con[0].supplierId === null, 'C1 supplierId nulled');
  assert(ctx.DB.con[0].role === '', 'C1 role cleared');
  assert(ctx.DB.con[1].supplierId === null, 'C2 unaffected');
  assert(ctx.DB.sup.length === 0, 'supplier deleted');
});

t('AC-6: link via openSupConPicker sets supplierId and role', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.prompt_override = '1';
  ctx.openSupConPicker();
  assert(ctx.DB.con[0].supplierId === 'S1', 'supplierId set');
  assert(ctx.DB.con[0].role === 'supplier_contact', 'role set');
});

t('AC-3: contact linked to Supplier X excluded from picker for Supplier Y', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'SX', name: 'ACME' });
  ctx.DB.sup.push({ id: 'SY', name: 'Globex' });
  ctx.DB.con.push({ id: 'CB', name: 'Bob', email: 'bob@example.com', supplierId: 'SX', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'SY';
  var eligible = ctx.DB.con.filter(function(c){ return !c.supplierId || c.supplierId === ctx.EI.s; });
  assert(eligible.length === 0, 'Contact B absent from picker for Supplier Y');
});

t('AC-8: clearing Supplier dropdown before save sets supplierId null and role empty', function() {
  ctx.resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.co = null;
  ctx.G('ct-name').value = 'Carol';
  ctx.G('ct-email').value = 'carol@example.com';
  ctx.G('ct-status').value = 'lead';
  ctx.G('ct-source').value = 'manual';
  ctx.G('ct-enq-summary').value = '';
  ctx.G('ct-notes').value = '';
  ctx.G('ct-phone').value = '';
  ctx.G('ct-company').value = '';
  ctx.G('ct-sup').value = '';
  ctx.saveCon();
  assert(ctx.DB.con[0].supplierId === null, 'supplierId null when dropdown cleared');
  assert(ctx.DB.con[0].role === '', 'role empty when dropdown cleared');
});
```

### 7.3 Test harness additions

The test harness needs `prompt_override` and `confirm_override` support (similar to existing `confirm_override` pattern if present). Check `tests/run.js` for existing override pattern and apply consistently:

- `ctx.prompt_override` — if set, `prompt()` returns this value and resets to `undefined`
- `ctx.confirm_override = true` — `confirm()` returns `true` (already used in existing delCon tests)

---

## §8 — CLAUDE.md and version delivery

On completion:
- CLAUDE.md: bump to `v2.9.29`, update Test count
- `docs/version-history.md`: prepend v2.9.29 row
- `docs/known-gaps.md`: no new gaps added by this feature
- `AI_SYSTEM_PROMPT`: update to mention supplierId/role fields on contacts, Supplier sub-panel in supplier modal, Supplier column in contacts list, and that contacts may be linked to a single supplier
- In-app changelog: prepend v2.9.29 block
- Raise PR to `claude/amazing-galileo-4hhygo`

---

## Scope boundaries

| In scope | Out of scope |
|---|---|
| supplierId + role fields on DB.con | Sheets sync of supplierId/role (mapRec() silently omits) |
| Contacts sub-panel in Supplier edit modal | Event log emissions on delCon (deferred per REQ-006 §9) |
| Supplier column in Contacts list | Event log emissions for link/unlink (deferred to v2.9.29+ scope) |
| Supplier dropdown in Contact modal | New DB entity or K key |
| delSup() nulls FKs | Full agentic picker UI (prompt() is sufficient) |

---

## Manual QA checklist

- [ ] AC-1: Create new contact with Supplier selected → contact record has supplierId and role='supplier_contact'
- [ ] AC-2: Unlink contact from Supplier sub-panel → contact remains, supplierId null, role ''
- [ ] AC-3: Open link picker on Supplier Y → contact already linked to Supplier X is absent
- [ ] AC-4: Create contact with no supplier → supplierId null, role ''
- [ ] AC-5: Delete Supplier X → contacts previously linked to X survive with supplierId null
- [ ] AC-6: Link contact via picker → supplierId and role set
- [ ] AC-7: Contacts list renders Supplier column with linked supplier name
- [ ] AC-8: Open New Contact from Supplier sub-panel, clear Supplier dropdown, save → supplierId null
- [ ] Supplier sub-panel hidden on new-supplier form (EI.s null), visible on edit
