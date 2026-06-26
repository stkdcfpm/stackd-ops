# SPEC-BUY-001-v2 — Buyers / Customers Entity

**Requirement:** REQ-BUY-001-v1  
**Target version:** v2.9.37  
**Status:** Submitted for spec gate (v2 — addresses all v1 gaps)

**Changes from v1:**
- GAP-1: Added `resetDB()` update requirement in tests
- GAP-2: Specified `openStatement(buyerName)` signature extension with pre-select behaviour
- GAP-3: Added T-BUY-09 for `expAll` backup; count corrected to +9 → 298/298
- GAP-4: `doImport` uses `Array.isArray()` guard consistent with `con` pattern
- GAP-5: `logEv()` calls specified for `saveBuy` and `delBuy`
- GAP-6: All code blocks use `function()` syntax, no arrow functions
- GAP-7: `seedAdHocBuyer()` init placement specified precisely

---

## 1. State layer changes

### 1.1 New K key
Add `bu: 'st_buy'` to the `K` object declaration.

### 1.2 New DB key
Add `buy: ldArr('st_buy')` to the `DB` object initialisation (alongside `con`, `events`).

### 1.3 New EI key
Add `bu: null` to the `EI` object.

### 1.4 saveAll()
Add `sv(K.bu, DB.buy)` to `saveAll()`.

### 1.5 Buyer record shape
```js
{
  id: 'BUY' + Date.now(),
  name: '',           // required, unique (case-insensitive)
  contactName: '',
  email: '',
  phone: '',
  address: '',
  currency: 'GBP',   // USD | GBP | RMB | BBD
  paymentTerms: '',
  creditLimit: null,  // number or null; display only
  notes: '',
  createdAt: new Date().toISOString()
}
```

### 1.6 Invoice record additions
- New field `buyerId` (string | null) — FK to `buyer.id`
- Existing `buyer` string field retained as display fallback; never removed

---

## 2. New functions

### 2.1 `fromGBP(gbp, cur)`
Module-level helper. Place immediately after the existing `toGBP()` function.

```js
function fromGBP(gbp, cur) {
  if (!gbp) return 0;
  if (cur === 'GBP' || !cur) return gbp;
  if (cur === 'USD') return gbp * QR.fxGBPUSD;
  if (cur === 'RMB') return gbp * QR.fxGBPRMB;
  if (cur === 'BBD') return gbp * QR.fxGBPBBD;
  return gbp;
}
```

### 2.2 `seedAdHocBuyer()`
Idempotent. Fixed id `'BUY-ADHOC'` for reliable guard checks.

```js
function seedAdHocBuyer() {
  if (!DB.buy) DB.buy = [];
  if (DB.buy.find(function(b){ return b.id === 'BUY-ADHOC'; })) return;
  DB.buy.unshift({
    id: 'BUY-ADHOC',
    name: 'Ad-Hoc',
    contactName: '', email: '', phone: '', address: '',
    currency: 'GBP', paymentTerms: '', creditLimit: null, notes: '',
    createdAt: new Date().toISOString()
  });
  sv(K.bu, DB.buy);
}
```

**Init placement:** Call `seedAdHocBuyer()` at the end of the existing `init()` function, after `ldArr` loading and `repairCalcFields()` but before `renderAll()`. If there is no named `init()`, place the call in the same script block immediately after `DB.buy = ldArr(K.bu)` is assigned.

### 2.3 `renderBuyers()`
Renders the Buyers list table. Called by `showV('buy')`.

For each buyer row, outstanding GBP balance:
```js
var outstandGBP = DB.inv.filter(function(i){ return i.buyerId === b.id; })
  .reduce(function(s, i){ return s + toGBP(iCalc(i).bal, i.currency); }, 0);
```

Table columns: Name | Contact | Email | Currency | Payment Terms | Credit Limit | Outstanding (GBP equiv.)  
"Add Buyer" button calls `openBuy(null)`.  
Each row: edit icon → `openBuy(b.id)`, delete icon → `delBuy(b.id)`.

### 2.4 `openBuy(id)`
Opens `ov-buy` modal.

- `id === null`: new buyer mode — clear all fields, set `EI.bu = null`, hide delete button, hide summary panel
- `id` is a string: populate fields from `DB.buy.find(function(b){ return b.id === id; })`, set `EI.bu = id`
  - If `id === 'BUY-ADHOC'`: hide delete button; show summary panel
  - Otherwise: show delete button; show summary panel
- Call `populateBuyPayTerms()` to populate the payment terms select
- Render summary sub-panel (section 2.7)

### 2.5 `saveBuy()`
Reads fields. Validates. Saves.

**Validation:**
1. `name = G('buy-name').value.trim()` — if empty: `vErr('buy-name', 'Company name is required'); return;`
2. Uniqueness (case-insensitive, excluding current record on edit):
```js
var dup = DB.buy.find(function(b){
  return b.name.trim().toLowerCase() === name.toLowerCase() && b.id !== EI.bu;
});
if (dup) { vErr('buy-name', 'A buyer with this name already exists'); return; }
```

**On new (`EI.bu === null`):**
```js
var rec = { id: 'BUY' + Date.now(), name: name, contactName: ..., ..., createdAt: new Date().toISOString() };
DB.buy.push(rec);
logEv('buyer', rec.id, 'created', 'Buyer created: ' + rec.name, 'operator');
```

**On edit:**
```js
var rec = DB.buy.find(function(b){ return b.id === EI.bu; });
// update fields in-place
logEv('buyer', rec.id, 'updated', 'Buyer updated: ' + rec.name, 'operator');
```

Call `sv(K.bu, DB.buy)`. Call `closeM('ov-buy')`. Call `renderBuyers()`.

### 2.6 `delBuy(id)`
```js
function delBuy(id) {
  if (id === 'BUY-ADHOC') return;
  var linked = DB.inv.find(function(i){ return i.buyerId === id; });
  if (linked) { alert('Cannot delete: this buyer has linked invoices.'); return; }
  if (!confirm('Delete buyer? This cannot be undone.')) return;
  var rec = DB.buy.find(function(b){ return b.id === id; });
  if (rec) logEv('buyer', rec.id, 'deleted', 'Buyer deleted: ' + rec.name, 'operator');
  DB.buy = DB.buy.filter(function(b){ return b.id !== id; });
  sv(K.bu, DB.buy);
  renderBuyers();
}
```

### 2.7 Buyer summary sub-panel (rendered inside `openBuy`)
```js
var buyInvs = DB.inv.filter(function(i){ return i.buyerId === id; });
var totalGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).grandTotal || iCalc(i).total || 0, i.currency); }, 0);
var outstandGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).bal, i.currency); }, 0);
var outstandBuyerCur = fromGBP(outstandGBP, buyer.currency);
var recent5 = buyInvs.slice().sort(function(a,b){ return (b.date||'') > (a.date||'') ? 1 : -1; }).slice(0,5);
var lastDate = recent5.length ? recent5[0].date : null;
```

Render into `#buy-summary` div:
- Total invoiced (all time): `£X,XXX GBP`
- Outstanding: formatted `outstandBuyerCur` in `buyer.currency`
- Last invoice date or "None"
- Table of recent 5: Inv # | Date | Status | Amount
- Buyer Statement button: `onclick="openStatement(buyer.name)"` — `style="display:none"` if `buyInvs.length === 0`

Show `#buy-summary` div; hide it when `id === null`.

### 2.8 `openStatement(preSelectName)` — signature extension
The existing `openStatement()` function is extended to accept an optional `preSelectName` argument. After the existing buyer options are rendered into the dropdown, add:
```js
if (preSelectName) {
  var sel = G('stmt-buyer'); // existing buyer select element id
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value === preSelectName) { sel.selectedIndex = i; break; }
  }
  // trigger the existing onChange/render handler to populate the statement immediately
}
```
If the exact id of the buyer select inside `ov-stmt` differs, use the select element rendered in the innerHTML block. No other changes to `openStatement`.

### 2.9 `populateBuyDropdown(selId, selectedBuyerId)`
Populates a buyer `<select>` element for the invoice modal.

```js
function populateBuyDropdown(selId, selectedId) {
  var el = G(selId);
  if (!el) return;
  var sorted = DB.buy.slice().sort(function(a,b){ return a.name > b.name ? 1 : -1; });
  el.innerHTML = '<option value="">-- Select Buyer --</option>'
    + '<option value="__new__">＋ New Buyer…</option>'
    + sorted.map(function(b){
        return '<option value="' + san(b.id) + '"'
          + (b.id === selectedId ? ' selected' : '') + '>'
          + san(b.name) + '</option>';
      }).join('');
}
```

### 2.10 `quickAddBuyer()`
Called when `if-b` dropdown value is `'__new__'`.

```js
function quickAddBuyer() {
  var qName = prompt('New buyer name:');
  if (!qName || !qName.trim()) { populateBuyDropdown('if-b', EI.i ? (DB.inv.find(function(x){ return x.id === EI.i; })||{}).buyerId : 'BUY-ADHOC'); return; }
  qName = qName.trim();
  var dup = DB.buy.find(function(b){ return b.name.toLowerCase() === qName.toLowerCase(); });
  if (dup) { alert('A buyer with this name already exists.'); populateBuyDropdown('if-b', dup.id); return; }
  var nb = { id: 'BUY' + Date.now(), name: qName, contactName: '', email: '', phone: '', address: '', currency: 'GBP', paymentTerms: '', creditLimit: null, notes: '', createdAt: new Date().toISOString() };
  DB.buy.push(nb);
  sv(K.bu, DB.buy);
  logEv('buyer', nb.id, 'created', 'Buyer quick-created: ' + nb.name, 'operator');
  populateBuyDropdown('if-b', nb.id);
}
```

---

## 3. Invoice modal changes

### 3.1 Buyer field HTML
Replace `<input id="if-b" ...>` with:
```html
<select id="if-b" onchange="if(this.value==='__new__') quickAddBuyer()"></select>
```

### 3.2 `openInv()` / `editInv()` changes
- After other field population, call `populateBuyDropdown('if-b', inv.buyerId || 'BUY-ADHOC')`
- On new invoice: `populateBuyDropdown('if-b', 'BUY-ADHOC')`

### 3.3 `saveInv()` validation addition
After existing validation, before building the `inv` object:
```js
var buyerId = G('if-b') ? G('if-b').value : '';
if (!buyerId || buyerId === '' || buyerId === '__new__') { vErr('if-b', 'Select a buyer'); return; }
```

On the `inv` object set:
```js
inv.buyerId = buyerId;
inv.buyer = (DB.buy.find(function(b){ return b.id === buyerId; }) || {}).name || inv.buyer || '';
```

### 3.4 Backward compatibility
- Existing invoices with no `buyerId`: display raw `buyer` string in all list tables and PDFs — no change
- When such an invoice is opened for edit: dropdown defaults to `'BUY-ADHOC'`; if `inv.buyer` matches a named buyer exactly (case-insensitive), pre-select that buyer instead
- No forced migration; no data repair script

---

## 4. AI tool change

In `_aiExecTool`, for `get_invoices` result mapping, add:
```js
buyerName: (DB.buy.find(function(b){ return b.id === inv.buyerId; }) || {}).name || inv.buyer || ''
```

---

## 5. Navigation and routing

Add `Buyers` button to main nav:
```html
<button onclick="showV('buy')" id="nav-buy">Buyers</button>
```

Add to `showV` `fns` map:
```js
buy: renderBuyers
```

Add to `renderAll()`:
```js
if (cv === 'buy') renderBuyers();
```

---

## 6. Modal HTML: `ov-buy`

Place after the existing Contact modal (`ov-con`).

```html
<div id="ov-buy" class="ov">
  <div class="modal">
    <h2 id="buy-modal-title">Buyer</h2>
    <div class="form-row">
      <label>Company Name *</label>
      <input id="buy-name" type="text" placeholder="Company name">
      <span id="buy-name-err" class="verr"></span>
    </div>
    <div class="form-row">
      <label>Contact Name</label>
      <input id="buy-cname" type="text">
    </div>
    <div class="form-row">
      <label>Email</label>
      <input id="buy-email" type="email">
    </div>
    <div class="form-row">
      <label>Phone</label>
      <input id="buy-phone" type="text">
    </div>
    <div class="form-row">
      <label>Address</label>
      <textarea id="buy-addr" rows="3"></textarea>
    </div>
    <div class="form-row">
      <label>Default Currency</label>
      <select id="buy-cur">
        <option value="GBP">GBP</option>
        <option value="USD">USD</option>
        <option value="RMB">RMB</option>
        <option value="BBD">BBD</option>
      </select>
    </div>
    <div class="form-row">
      <label>Payment Terms</label>
      <select id="buy-pt"></select>
    </div>
    <div class="form-row">
      <label>Credit Limit</label>
      <input id="buy-cl" type="number" min="0" placeholder="Optional">
    </div>
    <div class="form-row">
      <label>Notes</label>
      <textarea id="buy-notes" rows="2"></textarea>
    </div>
    <div id="buy-summary" style="display:none"></div>
    <div class="modal-actions">
      <button onclick="saveBuy()">Save</button>
      <button id="buy-del-btn" onclick="delBuy(EI.bu)" class="btn-danger" style="display:none">Delete</button>
      <button onclick="closeM('ov-buy')">Cancel</button>
    </div>
  </div>
</div>
```

---

## 7. Backup / restore

### 7.1 `expAll()`
Add `buy: DB.buy` to the snapshot object.

### 7.2 `doImport()`
Add (consistent with `con` pattern):
```js
if (snap.buy && Array.isArray(snap.buy)) { DB.buy = snap.buy; sv(K.bu, DB.buy); }
```
After all entities are restored, call `seedAdHocBuyer()` to ensure the Ad-Hoc record exists.

---

## 8. GDPR Settings card

Add a **Buyers Data** card to the Settings tab (after the Contacts GDPR card):

> **Buyers Data — GDPR Disclosure**  
> Buyer records (company name, contact name, email, phone, address) are stored locally in your browser's localStorage. **Legal basis:** UK GDPR Art. 6(1)(b) — processing necessary for the performance of a contract (invoicing and trade operations); Art. 6(1)(c) — legal obligation under HMRC requirements to retain financial records for a minimum of 6 years (Companies Act 2006 s.388, VAT Notice 700/21 s.19). **Retention:** No automated expiry. Records should be retained for the duration of the business relationship and a minimum of 6 years thereafter. **Backup exports** include buyer data in plaintext — the operator is responsible for securing exported files. **No external transmission** — buyer data is not synced to Google Sheets or any third party in this version.

---

## 9. Known gaps to log in `docs/known-gaps.md`

| ID | Area | Summary |
|---|---|---|
| BUY-GAP-001 | Buyers / sync | Sheets sync deferred to v3.0 (FM-1 freeze on v2.9.x) |
| BUY-GAP-002 | Buyers / FX | `fromGBP()` uses QR rates at render time, not historic invoice rates — same caveat as MTD-GAP-002 |
| BUY-GAP-003 | Buyers / data integrity | Ad-Hoc buyer accumulates all unlinked legacy invoices; operator should periodically reassign to named buyers |

---

## 10. Tests (additions to `tests/run.js`)

### 10.1 `resetDB()` update
Add `buy: []` to the `resetDB()` function in `tests/run.js`:
```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[], events:[], buy:[] };
}
```

### 10.2 Test cases
Target: **+9 tests** → **298/298** (from 289).

```
T-BUY-01  saveBuy() creates a record — DB.buy.length === 1, record.name matches input
T-BUY-02  saveBuy() hard-blocks duplicate name (case-insensitive) — second call with same name (different case) does not add record; DB.buy.length remains 1
T-BUY-03  delBuy() blocked when an invoice has buyerId matching the buyer — DB.buy.length unchanged
T-BUY-04  delBuy() succeeds when no invoices link to buyer — DB.buy.length === 0
T-BUY-05  delBuy() blocked for 'BUY-ADHOC' buyer regardless of invoices
T-BUY-06  fromGBP(100, 'USD') === 100 * QR.fxGBPUSD (within floating point tolerance)
T-BUY-07  seedAdHocBuyer() called twice → exactly one record with id 'BUY-ADHOC' in DB.buy
T-BUY-08  _aiExecTool get_invoices returns buyerName resolved from DB.buy when buyerId is set
T-BUY-09  expAll snapshot includes buy array with correct length
```

Each test must call `resetDB()` at the start and set `ctx.confirm = function(){ return true; }` for delete tests.

---

## 11. Version delivery checklist

- [ ] `K.bu`, `DB.buy`, `EI.bu` added to state declarations
- [ ] `saveAll()` includes `sv(K.bu, DB.buy)`
- [ ] `fromGBP()` added immediately after `toGBP()`
- [ ] `seedAdHocBuyer()` defined and called in init (after DB load, before renderAll)
- [ ] `renderBuyers()` implemented
- [ ] `openBuy()` / `saveBuy()` / `delBuy()` implemented with `logEv()` calls
- [ ] Buyer summary sub-panel in `openBuy()`
- [ ] `populateBuyDropdown()` and `quickAddBuyer()` implemented
- [ ] Invoice modal `if-b` converted to `<select>` with `__new__` option and `onchange` handler
- [ ] `saveInv()` reads and stores `buyerId` and `buyer` string
- [ ] `openInv()` / `editInv()` call `populateBuyDropdown()`
- [ ] `openStatement()` extended with optional `preSelectName` arg
- [ ] `ov-buy` modal HTML added
- [ ] Buyers nav tab and `showV` routing added
- [ ] `expAll` + `doImport` updated with `Array.isArray()` guard
- [ ] GDPR Settings card added
- [ ] `get_invoices` AI tool returns `buyerName`
- [ ] `AI_SYSTEM_PROMPT` updated with Buyers entity description
- [ ] In-app changelog updated
- [ ] `resetDB()` in `tests/run.js` updated with `buy: []`
- [ ] 9 new tests added; all 298/298 pass
- [ ] `docs/known-gaps.md` updated (BUY-GAP-001/002/003)
- [ ] `docs/version-history.md` prepended
- [ ] `CLAUDE.md` version bumped to v2.9.37, test count updated to 298/298
