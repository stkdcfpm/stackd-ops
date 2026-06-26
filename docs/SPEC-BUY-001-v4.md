# SPEC-BUY-001-v4 — Buyers / Customers Entity

**Requirement:** REQ-BUY-001-v1  
**Target version:** v2.9.37  
**Status:** Final — spec gate v3 CONDITIONAL PASS; v4 closes final gap

**All sections are identical to SPEC-BUY-001-v3 except section 2.8 below.**

**Change from v3:**
- Section 2.8 — `openStatement` no-match path: added match-found boolean guard before `renderStatement` call to prevent rendering wrong statement when `preSelectName` finds no option in the dropdown.

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

- `id === null`: new buyer mode — clear all fields, set `EI.bu = null`, hide delete button, hide summary panel (`G('buy-summary').style.display='none'`)
- `id` is a string: populate fields from `DB.buy.find(function(b){ return b.id === id; })`, set `EI.bu = id`
  - If `id === 'BUY-ADHOC'`: hide delete button; show summary panel
  - Otherwise: show delete button; show summary panel

**Payment terms select population:**
```js
var ptSel = G('buy-pt');
ptSel.innerHTML = '<option value="">Select payment terms...</option>'
  + getPaymentTerms().map(function(t){
      return '<option value="' + san(t) + '"' + (buyer && buyer.paymentTerms === t ? ' selected' : '') + '>'
        + san(t) + '</option>';
    }).join('');
```

Render summary sub-panel (section 2.7) when `id` is not null.

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
var rec = { id: 'BUY' + Date.now(), name: name, contactName: G('buy-cname').value.trim(),
  email: G('buy-email').value.trim(), phone: G('buy-phone').value.trim(),
  address: G('buy-addr').value.trim(), currency: G('buy-cur').value,
  paymentTerms: G('buy-pt').value, creditLimit: G('buy-cl').value ? parseFloat(G('buy-cl').value) : null,
  notes: G('buy-notes').value.trim(), createdAt: new Date().toISOString() };
DB.buy.push(rec);
logEv('buyer', rec.id, 'created', 'Buyer created: ' + rec.name, 'operator');
```

**On edit:**
```js
var rec = DB.buy.find(function(b){ return b.id === EI.bu; });
rec.name = name;
rec.contactName = G('buy-cname').value.trim();
rec.email = G('buy-email').value.trim();
rec.phone = G('buy-phone').value.trim();
rec.address = G('buy-addr').value.trim();
rec.currency = G('buy-cur').value;
rec.paymentTerms = G('buy-pt').value;
rec.creditLimit = G('buy-cl').value ? parseFloat(G('buy-cl').value) : null;
rec.notes = G('buy-notes').value.trim();
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
var totalGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).grand, i.currency); }, 0);
var outstandGBP = buyInvs.reduce(function(s,i){ return s + toGBP(iCalc(i).bal, i.currency); }, 0);
var outstandBuyerCur = fromGBP(outstandGBP, buyer.currency);
var recent5 = buyInvs.slice().sort(function(a,b){ return (b.date||'') > (a.date||'') ? 1 : -1; }).slice(0,5);
var lastDate = recent5.length ? recent5[0].date : null;
```

`iCalc(inv)` returns `{ grand, cogs, gp, np, mgn, liT, tax, taxRate, dep, bal }`. Use `.grand` for total invoiced, `.bal` for outstanding. Do **not** use `grandTotal` or `total`.

Render into `#buy-summary` div:
- Total invoiced (all time): `£X,XXX GBP`
- Outstanding: formatted `outstandBuyerCur` in `buyer.currency`
- Last invoice date or "None"
- Table of recent 5: Inv # | Date | Status | Amount
- Buyer Statement button: `onclick="openStatement(buyer.name)"` — `style="display:none"` if `buyInvs.length === 0`

Show `#buy-summary` div; hide when `id === null`.

### 2.8 `openStatement(preSelectName)` — signature extension — FINAL
The existing `openStatement()` function is extended to accept an optional `preSelectName` argument.

After the existing buyer options are rendered into the `stmt-buyer` dropdown, add:
```js
if (preSelectName) {
  var sel = G('stmt-buyer');
  var matchIdx = -1;
  for (var oi = 0; oi < sel.options.length; oi++) {
    if (sel.options[oi].value === preSelectName) { matchIdx = oi; break; }
  }
  if (matchIdx >= 0) {
    sel.selectedIndex = matchIdx;
    renderStatement(sel.options[matchIdx].value);
  }
}
```

If `preSelectName` finds no matching option (e.g. the buyer's name differs from the raw `buyer` strings on any invoice), the statement opens with the dropdown at its default position and no auto-render is triggered — the user selects manually. This is the accepted behaviour for the no-match case and requires no gap entry.

**Note:** Section 3.3 ensures `inv.buyer` is always written or preserved on save, so buyers created after v2.9.37 ships will always appear in the statement dropdown. Legacy invoice `buyer` strings that differ from the `DB.buy` name (capitalisation, punctuation) will not auto-select; the operator can select manually.

### 2.9 `populateBuyDropdown(selId, selectedBuyerId)`
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
```js
function quickAddBuyer() {
  var prevId = EI.i ? ((DB.inv.find(function(x){ return x.id === EI.i; }) || {}).buyerId || 'BUY-ADHOC') : 'BUY-ADHOC';
  var qName = prompt('New buyer name:');
  if (!qName || !qName.trim()) { populateBuyDropdown('if-b', prevId); return; }
  qName = qName.trim();
  var dup = DB.buy.find(function(b){ return b.name.toLowerCase() === qName.toLowerCase(); });
  if (dup) { alert('A buyer with this name already exists.'); populateBuyDropdown('if-b', dup.id); return; }
  var nb = { id: 'BUY' + Date.now(), name: qName, contactName: '', email: '', phone: '',
    address: '', currency: 'GBP', paymentTerms: '', creditLimit: null, notes: '',
    createdAt: new Date().toISOString() };
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
- On new invoice: `populateBuyDropdown('if-b', 'BUY-ADHOC')`
- On edit existing invoice with `buyerId`: `populateBuyDropdown('if-b', inv.buyerId)`
- On edit legacy invoice (no `buyerId`):
  ```js
  var match = DB.buy.find(function(b){ return b.name.toLowerCase() === (inv.buyer||'').toLowerCase(); });
  populateBuyDropdown('if-b', match ? match.id : 'BUY-ADHOC');
  ```

### 3.3 `saveInv()` validation addition
```js
var buyerId = G('if-b') ? G('if-b').value : '';
if (!buyerId || buyerId === '' || buyerId === '__new__') { vErr('if-b', 'Select a buyer'); return; }
```

On `inv` object:
```js
inv.buyerId = buyerId;
inv.buyer = (DB.buy.find(function(b){ return b.id === buyerId; }) || {}).name || inv.buyer || '';
```

### 3.4 Backward compatibility
- Existing invoices with no `buyerId`: display raw `buyer` string in all list tables and PDFs — no change
- When opened for edit: defaults per section 3.2
- No forced migration; no data repair script

---

## 4. AI tool change

In `_aiExecTool`, for `get_invoices` result mapping, add:
```js
buyerName: (DB.buy.find(function(b){ return b.id === inv.buyerId; }) || {}).name || inv.buyer || ''
```

---

## 5. Navigation and routing

```html
<button onclick="showV('buy')" id="nav-buy">Buyers</button>
```

Add to `showV` `fns` map: `buy: renderBuyers`  
Add to `renderAll()`: `if (cv === 'buy') renderBuyers();`

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
```js
if (snap.buy && Array.isArray(snap.buy)) { DB.buy = snap.buy; sv(K.bu, DB.buy); }
```
After all entities restored, call `seedAdHocBuyer()`.

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
| BUY-GAP-003 | Buyers / data integrity | Ad-Hoc buyer accumulates all unlinked legacy invoices; operator should periodically reassign |

---

## 10. Tests (additions to `tests/run.js`)

### 10.1 `resetDB()` update
```js
function resetDB() {
  ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[], con:[], events:[], buy:[] };
}
```

### 10.2 Test cases
Target: **+9 tests** → **298/298** (from 289).

```
T-BUY-01  saveBuy() creates a record — DB.buy.length === 1, record.name matches input
T-BUY-02  saveBuy() hard-blocks duplicate name (case-insensitive) — DB.buy.length remains 1
T-BUY-03  delBuy() blocked when invoice has buyerId matching the buyer — DB.buy.length unchanged
T-BUY-04  delBuy() succeeds when no invoices link to buyer — DB.buy.length === 0
T-BUY-05  delBuy() blocked for 'BUY-ADHOC' regardless of invoices
T-BUY-06  fromGBP(100, 'USD') === 100 * QR.fxGBPUSD
T-BUY-07  seedAdHocBuyer() called twice → exactly one record with id 'BUY-ADHOC' in DB.buy
T-BUY-08  _aiExecTool get_invoices returns buyerName resolved from DB.buy when buyerId is set
T-BUY-09  expAll snapshot includes buy array with correct length
```

Each test: call `resetDB()` at start. Delete tests: `ctx.confirm = function(){ return true; }`.

---

## 11. Version delivery checklist

- [ ] `K.bu`, `DB.buy`, `EI.bu` added to state declarations
- [ ] `saveAll()` includes `sv(K.bu, DB.buy)`
- [ ] `fromGBP()` added immediately after `toGBP()`
- [ ] `seedAdHocBuyer()` defined and called in init (after DB load / repairCalcFields, before renderAll)
- [ ] `renderBuyers()` implemented
- [ ] `openBuy()` / `saveBuy()` / `delBuy()` implemented with `logEv()` calls
- [ ] Payment terms select in `openBuy()` uses `getPaymentTerms()` inline loop
- [ ] Buyer summary sub-panel uses `iCalc(i).grand` and `iCalc(i).bal`
- [ ] `openStatement()` extended with `preSelectName` arg, match-found guard, `renderStatement()` trigger
- [ ] `populateBuyDropdown()` and `quickAddBuyer()` implemented
- [ ] Invoice modal `if-b` converted to `<select>` with `__new__` option and `onchange` handler
- [ ] `saveInv()` reads and stores `buyerId` and `buyer` string
- [ ] `openInv()` / `editInv()` call `populateBuyDropdown()` with legacy fallback
- [ ] `ov-buy` modal HTML added (after `ov-con`)
- [ ] Buyers nav tab and `showV` routing added
- [ ] `expAll` + `doImport` updated with `Array.isArray()` guard
- [ ] `doImport` calls `seedAdHocBuyer()` after restore
- [ ] GDPR Settings card added
- [ ] `get_invoices` AI tool returns `buyerName`
- [ ] `AI_SYSTEM_PROMPT` updated with Buyers entity description
- [ ] In-app changelog updated
- [ ] `resetDB()` in `tests/run.js` updated with `buy: []`
- [ ] 9 new tests added; all 298/298 pass
- [ ] `docs/known-gaps.md` updated (BUY-GAP-001/002/003)
- [ ] `docs/version-history.md` prepended
- [ ] `CLAUDE.md` version bumped to v2.9.37, test count updated to 298/298
