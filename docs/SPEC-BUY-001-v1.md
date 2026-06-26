# SPEC-BUY-001-v1 — Buyers / Customers Entity

**Requirement:** REQ-BUY-001-v1  
**Target version:** v2.9.37  
**Status:** Draft — pending spec gate

---

## 1. State layer changes

### 1.1 New K key
```js
// Add to K object
bu: 'st_buy'
```

### 1.2 New DB key
```js
// Add to DB object initialisation
buy: ldArr('st_buy')
```

### 1.3 New EI key
```js
// Add to EI object
bu: null
```

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
  creditLimit: null,  // number or null
  notes: '',
  createdAt: new Date().toISOString()
}
```

### 1.6 Invoice record additions
- New field `buyerId` (string | null) — FK to `buyer.id`
- Existing `buyer` string field retained as display fallback

---

## 2. New functions

### 2.1 `fromGBP(gbp, currency)`
Module-level helper, placed near `toGBP()`.

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
Called once in init sequence (after `DB` is loaded). Idempotent.

```js
function seedAdHocBuyer() {
  if (!DB.buy) DB.buy = [];
  if (DB.buy.find(function(b){ return b.name === 'Ad-Hoc'; })) return;
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

Fixed id `'BUY-ADHOC'` makes it easy to guard against deletion.

### 2.3 `renderBuyers()`
Renders the Buyers list table. Called by `showV('buy')`.

- Iterates `DB.buy`
- Per row outstanding: `DB.inv.filter(i => i.buyerId === b.id).reduce((s,i) => s + toGBP(iCalc(i).bal, i.currency), 0)`
- Formats outstanding as `£` GBP equiv
- "Add Buyer" button calls `openBuy(null)`
- Each row edit icon calls `openBuy(b.id)`
- Each row delete icon calls `delBuy(b.id)`

### 2.4 `openBuy(id)`
Opens `ov-buy` modal.

- If `id` is null: new buyer mode, clear all fields, `EI.bu = null`
- If `id` is a string: populate fields from `DB.buy.find(b => b.id === id)`, `EI.bu = id`
- If editing and `id !== 'BUY-ADHOC'`: show summary sub-panel (see 2.6)
- If `id === 'BUY-ADHOC'`: hide delete button; show summary sub-panel

### 2.5 `saveBuy()`
Validates and saves a buyer record.

Validation:
1. `name` required — `vErr('buy-name', 'Company name is required')`
2. Name uniqueness (case-insensitive, excluding current record on edit):
   ```js
   var dup = DB.buy.find(function(b){
     return b.name.toLowerCase() === name.toLowerCase() && b.id !== EI.bu;
   });
   if (dup) { vErr('buy-name', 'A buyer with this name already exists'); return; }
   ```

On new (`EI.bu === null`): push new record to `DB.buy`.  
On edit: find record by `EI.bu`, update fields in-place.  
Call `sv(K.bu, DB.buy)`. Call `closeM('ov-buy')`. Call `renderBuyers()`.

### 2.6 `delBuy(id)`
- Guard: `if (id === 'BUY-ADHOC') return;`
- Guard: if any `DB.inv` has `buyerId === id`, show `alert('Cannot delete: this buyer has linked invoices.')` and return
- `confirm('Delete buyer?')` — return if false
- Splice from `DB.buy`. `sv(K.bu, DB.buy)`. `renderBuyers()`.

### 2.7 Buyer summary sub-panel (inside `openBuy`)
Computed when modal opens for an existing buyer:

```js
var buyInvs = DB.inv.filter(function(i){ return i.buyerId === id; });
var totalGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).grandTotal, i.currency); }, 0);
var outstandGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).bal, i.currency); }, 0);
var outstandBuyerCur = fromGBP(outstandGBP, buyer.currency);
var lastInv = buyInvs.sort(function(a,b){ return b.date > a.date ? 1 : -1; })[0];
var recent5 = buyInvs.slice().sort(function(a,b){ return b.date > a.date ? 1 : -1; }).slice(0,5);
```

Render into `#buy-summary` div inside modal:
- Total invoiced: `£X,XXX` GBP
- Outstanding: `{sym}X,XXX {cur}` using buyer's currency symbol
- Last invoice: date string or "None"
- Table of recent 5: number | date | status | amount
- Buyer Statement button: `onclick="openStatement(buyer.name)"` — `style="display:none"` if `buyInvs.length === 0`

### 2.8 `populateBuyDropdown(selectId, selectedBuyerId)`
Populates a buyer `<select>` element. Called from `openInv()` / `editInv()`.

```js
function populateBuyDropdown(selId, selectedId) {
  var el = G(selId);
  if (!el) return;
  el.innerHTML = '<option value="">-- Select Buyer --</option>'
    + '<option value="__new__">＋ New Buyer…</option>'
    + DB.buy.slice().sort(function(a,b){ return a.name > b.name ? 1 : -1; })
        .map(function(b){ 
          return '<option value="' + san(b.id) + '"' 
            + (b.id === selectedId ? ' selected' : '') + '>' 
            + san(b.name) + '</option>'; 
        }).join('');
}
```

On `change` event: if `value === '__new__'` → open quick-create flow (see 2.9).

### 2.9 Quick-create buyer from invoice dropdown
When `__new__` is selected in the invoice buyer dropdown:

1. `var qName = prompt('New buyer name:');`
2. If blank/null: reset dropdown to previous value; return
3. Check uniqueness (case-insensitive): if duplicate, `alert('A buyer with this name already exists.')` and return
4. Create record with `name = qName`, all other fields empty, `currency = 'GBP'`
5. Push to `DB.buy`, `sv(K.bu, DB.buy)`
6. Call `populateBuyDropdown('if-b', newBuyer.id)` to refresh and auto-select

---

## 3. Invoice modal changes

### 3.1 Buyer field
Replace `<input id="if-b">` with:
```html
<select id="if-b" onchange="onBuyDropChange()"></select>
```

`onBuyDropChange()`:
```js
function onBuyDropChange() {
  if (G('if-b').value === '__new__') quickAddBuyer();
}
```

`quickAddBuyer()` implements section 2.9.

### 3.2 `openInv()` / `editInv()` changes
- Call `populateBuyDropdown('if-b', inv.buyerId || 'BUY-ADHOC')` when opening modal
- On new invoice: select `'BUY-ADHOC'` by default

### 3.3 `saveInv()` changes
- Read `buyerId = G('if-b').value`
- If `buyerId === '' || buyerId === '__new__'`: `vErr('if-b', 'Select a buyer'); return;`
- Set `inv.buyerId = buyerId`
- Set `inv.buyer = (DB.buy.find(b => b.id === buyerId) || {}).name || inv.buyer`

### 3.4 Backward compatibility
- Existing invoices with no `buyerId` render their raw `buyer` string in all list tables and PDFs
- When such an invoice is opened for edit, dropdown defaults to `BUY-ADHOC` (user can change)
- No forced migration; no data repair script

---

## 4. AI tool change

In `_aiExecTool`, for `get_invoices`, add `buyerName` to each result object:
```js
buyerName: (DB.buy.find(function(b){ return b.id === inv.buyerId; }) || {}).name || inv.buyer || ''
```

---

## 5. Navigation

Add `Buyers` tab to main nav:
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

```html
<div id="ov-buy" class="modal">
  <div class="modal-box">
    <h2 id="buy-modal-title">Buyer</h2>
    <div class="form-row">
      <label>Company Name *</label>
      <input id="buy-name" type="text">
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
      <textarea id="buy-addr"></textarea>
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
      <input id="buy-cl" type="number" min="0">
    </div>
    <div class="form-row">
      <label>Notes</label>
      <textarea id="buy-notes"></textarea>
    </div>
    <div id="buy-summary" style="display:none"><!-- populated by openBuy() --></div>
    <div class="modal-actions">
      <button onclick="saveBuy()">Save</button>
      <button id="buy-del-btn" onclick="delBuy(EI.bu)" class="btn-danger">Delete</button>
      <button onclick="closeM('ov-buy')">Cancel</button>
    </div>
  </div>
</div>
```

---

## 7. Backup / restore

### 7.1 `expAll()`
Add `buy: DB.buy` to snapshot object.

### 7.2 `doImport()`
Add restore line:
```js
if (snap.buy) { DB.buy = snap.buy; sv(K.bu, DB.buy); }
```
After restore, call `seedAdHocBuyer()` to ensure Ad-Hoc record exists.

---

## 8. GDPR Settings card

Add a **Buyers Data** card to the Settings tab:

> **Buyers Data — GDPR Disclosure**  
> Buyer records (company name, contact name, email, phone, address) are stored locally in your browser. Legal basis: UK GDPR Art. 6(1)(b) — contract performance; Art. 6(1)(c) — legal obligation (HMRC 6-year financial record retention). No expiry applied; records should be retained for the duration of the business relationship and a minimum of 6 years thereafter. Buyer data is included in backup exports (see Backup & Restore above). No buyer data is transmitted externally.

---

## 9. Known gaps to log in `docs/known-gaps.md`

| ID | Summary |
|---|---|
| BUY-GAP-001 | Sheets sync deferred to v3.0 (FM-1 freeze on v2.9.x) |
| BUY-GAP-002 | `fromGBP()` uses QR rates at render time, not historic invoice rates |
| BUY-GAP-003 | Ad-Hoc buyer accumulates all unlinked legacy invoices — operator should periodically reassign |

---

## 10. Tests (additions to `tests/run.js`)

Target: +8 tests → total 297/297 (from 289).

```
T-BUY-01  saveBuy() creates a record — DB.buy length increases, name matches
T-BUY-02  saveBuy() hard-blocks duplicate name (case-insensitive)
T-BUY-03  delBuy() blocked when invoice has matching buyerId
T-BUY-04  delBuy() succeeds when no invoices link to buyer
T-BUY-05  delBuy() blocked for Ad-Hoc buyer (id === 'BUY-ADHOC')
T-BUY-06  fromGBP(100, 'USD') === 100 * QR.fxGBPUSD
T-BUY-07  seedAdHocBuyer() called twice → exactly one Ad-Hoc record
T-BUY-08  _aiExecTool get_invoices includes buyerName resolved from DB.buy
```

---

## 11. Version delivery checklist

- [ ] `K.bu`, `DB.buy`, `EI.bu` added
- [ ] `saveAll()` includes `sv(K.bu, DB.buy)`
- [ ] `seedAdHocBuyer()` called in init
- [ ] `fromGBP()` added near `toGBP()`
- [ ] `renderBuyers()` implemented
- [ ] `openBuy()` / `saveBuy()` / `delBuy()` implemented
- [ ] Buyer summary sub-panel in `openBuy()`
- [ ] Invoice modal `if-b` converted to `<select>` with `__new__` option
- [ ] `saveInv()` reads and stores `buyerId`
- [ ] `populateBuyDropdown()` called from `openInv()` / `editInv()`
- [ ] Buyers nav tab and `showV` routing
- [ ] `expAll` + `doImport` updated
- [ ] GDPR Settings card added
- [ ] `get_invoices` AI tool returns `buyerName`
- [ ] `AI_SYSTEM_PROMPT` updated
- [ ] In-app changelog updated
- [ ] `docs/known-gaps.md` updated (BUY-GAP-001/002/003)
- [ ] `docs/version-history.md` prepended
- [ ] `CLAUDE.md` version bumped, test count updated
- [ ] 8 new tests pass → 297/297
