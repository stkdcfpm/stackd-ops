// tests/run.js — Stackd Ops automated QA test suite
// Usage: node tests/run.js
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

// ── MOCK BROWSER ENVIRONMENT ───────────────────────────────────
const mockElements = {};
function mockEl(id) {
  if (!mockElements[id]) {
    mockElements[id] = {
      value: '', innerHTML: '', textContent: '',
      style: { display: '', borderBottomColor: '', background: '' },
      classList: { add() {}, remove() {}, contains: () => false },
      options: { length: 0 },
      checked: false,
    };
  }
  return mockElements[id];
}

const mockDoc = {
  getElementById:    mockEl,
  querySelector:     () => null,
  querySelectorAll:  () => ({ forEach() {} }),
  addEventListener:  () => {},
  createElement:     () => ({ click() {}, href: '', download: '', style: {}, classList: { add() {}, remove() {} } }),
  title: '',
};

const mockStorage = {};
const mockLocal = {
  getItem:    (k) => mockStorage[k] || null,
  setItem:    (k, v) => { mockStorage[k] = v; },
  removeItem: (k) => { delete mockStorage[k]; },
};
const mockSession = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

// ── BUILD VM CONTEXT ───────────────────────────────────────────
const ctx = vm.createContext({
  document:        mockDoc,
  localStorage:    mockLocal,
  sessionStorage:  mockSession,
  location:        { reload() {} },
  setTimeout:      () => {},
  clearTimeout:    () => {},
  setInterval:     () => {},
  clearInterval:   () => {},
  confirm:         () => false,
  alert:           () => {},
  fetch:           () => Promise.resolve({ text: () => Promise.resolve('{"status":"ok","records":[]}') }),
  console, Date, Math, JSON, Intl,
  Array, Object, String, Number, Boolean, RegExp, Error,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent,
  Promise,
});
ctx.window = ctx;

// ── LOAD & PREP APP SCRIPT ─────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

const scriptBlocks = [];
const re = /<script>([\s\S]*?)<\/script>/gi;
let m;
while ((m = re.exec(html)) !== null) scriptBlocks.push(m[1]);
const rawScript = scriptBlocks.join('\n');

// Promote module-level let/const → var so vm context exposes them as sandbox properties
const script = rawScript.replace(/^([ \t]*)(let|const)\b/gm, '$1var');

try {
  vm.runInContext(script, ctx, { filename: 'index.html' });
} catch (e) {
  // Suppress DOM errors from IIFE auth check on load — functions are still defined
  if (process.env.VERBOSE) console.error('[vm eval]', e.message);
}

// ── TEST FRAMEWORK ─────────────────────────────────────────────
let _pass = 0, _fail = 0;
const _results = [];

function test(name, fn) {
  try {
    fn();
    _pass++;
    _results.push({ ok: true, name });
  } catch (e) {
    _fail++;
    _results.push({ ok: false, name, msg: e.message });
  }
}

function assert(cond, msg)        { if (!cond)   throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg)   {
  if (a !== b) throw new Error((msg ? msg + '\n    ' : '') +
    'Expected: ' + JSON.stringify(b) + '\n    Got:      ' + JSON.stringify(a));
}
function assertContains(str, sub, msg) {
  if (!String(str).includes(sub)) throw new Error(
    (msg || 'Expected to contain: ' + sub) + '\n    In: ' + String(str).slice(0, 300));
}
function assertNotContains(str, sub, msg) {
  if (String(str).includes(sub)) throw new Error(
    (msg || 'Expected NOT to contain: ' + sub) + '\n    In: ' + String(str).slice(0, 300));
}

function resetDB() {
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [] };
}

// ── TEST SUITE ─────────────────────────────────────────────────

console.log('\nStackd Ops — QA Test Suite\n');

// ── san() ──────────────────────────────────────────────────────
console.log('san() — XSS sanitisation');

test('escapes <script> tag', () => {
  assertNotContains(ctx.san('<script>alert(1)</script>'), '<script', 'raw <script> must be escaped');
});
test('escapes & character', () => {
  assertEqual(ctx.san('A & B'), 'A &amp; B');
});
test('escapes double quotes', () => {
  assertEqual(ctx.san('"quoted"'), '&quot;quoted&quot;');
});
test('escapes single quotes', () => {
  assertEqual(ctx.san("it's"), 'it&#x27;s');
});
test('handles null input', () => {
  assertEqual(ctx.san(null), '');
});
test('handles undefined input', () => {
  assertEqual(ctx.san(undefined), '');
});
test('handles numeric input', () => {
  assertEqual(ctx.san(42), '42');
});
test('<img onerror> payload neutralised', () => {
  assertNotContains(ctx.san('<img src=x onerror=alert(1)>'), '<img', 'onerror payload must be escaped');
});

// ── fmt() ──────────────────────────────────────────────────────
console.log('\nfmt() — currency formatting');

test('formats USD with comma separator', () => {
  assertContains(ctx.fmt(1234), '1,234');
});
test('returns hyphen for null', () => {
  assertEqual(ctx.fmt(null), '-');
});
test('returns hyphen for NaN', () => {
  assertEqual(ctx.fmt(NaN), '-');
});
test('does not throw for unknown currency code', () => {
  let result;
  try { result = ctx.fmt(100, 'XYZ'); } catch (e) { result = null; }
  assert(result !== null, 'Should not throw for unknown currency code');
});

// ── cInv() ─────────────────────────────────────────────────────
console.log('\ncInv() — invoice calculation');

resetDB();

test('calculates grand from live line items', () => {
  const inv = { id:'t1', lineItems:[{qty:2,up:100}], taxRate:0, dep:0, chargesIncluded:true };
  const c = ctx.cInv(inv);
  assertEqual(c.liT, 200, 'liT'); assertEqual(c.grand, 200, 'grand');
});
test('applies 20% tax to line item subtotal', () => {
  const inv = { id:'t2', lineItems:[{qty:1,up:1000}], taxRate:0.20, dep:0, chargesIncluded:true };
  const c = ctx.cInv(inv);
  assertEqual(c.tax, 200, 'tax'); assertEqual(c.grand, 1200, 'grand = liT + tax');
});
test('deducts deposit from balance due', () => {
  const inv = { id:'t3', lineItems:[{qty:1,up:1000}], taxRate:0, dep:300, chargesIncluded:true };
  assertEqual(ctx.cInv(inv).bal, 700, 'bal = grand - dep');
});
test('balance floor is zero (overpayment reports 0)', () => {
  const inv = { id:'t4', lineItems:[{qty:1,up:1000}], taxRate:0, dep:1500, chargesIncluded:true };
  assertEqual(ctx.cInv(inv).bal, 0, 'bal must not go negative');
});
test('falls back to calc_grandTotal when no live line items', () => {
  const inv = { id:'t5', lineItems:[], taxRate:0, dep:0, chargesIncluded:true,
    calc_grandTotal:'5000', calc_cogs:'3000' };
  assertEqual(ctx.cInv(inv).grand, 5000, 'grand from calc_grandTotal');
});
test('credit note returns cnAmount as grand total', () => {
  const inv = { id:'t6', type:'credit_note', cnAmount:250, lineItems:[], taxRate:0, dep:0 };
  const c = ctx.cInv(inv);
  assertEqual(c.grand, 250, 'CN grand'); assertEqual(c.bal, 250, 'CN bal');
});
test('chargesIncluded=true: np = grand - tax - cogs', () => {
  ctx.DB.li = [{ id:'l1', cost:600 }];
  const inv = { id:'t7', lineItems:[{qty:1,up:1000,lid:'l1'}],
    taxRate:0, dep:0, lf:100, chargesIncluded:true };
  // liT=1000, tax=0, chgs=100, grand=1100, cogs=600 → np=500
  assertEqual(ctx.cInv(inv).np, 500, 'np = 1100 - 0 - 600 = 500');
  ctx.DB.li = [];
});
test('chargesIncluded=false: np = grand - tax - charges - cogs', () => {
  const inv = { id:'t8', lineItems:[{qty:1,up:1000}],
    taxRate:0, dep:0, lf:100, chargesIncluded:false, calc_cogs:'600' };
  // liT=1000, tax=0, chgs=100, grand=1100, cogs=600 → np=400
  assertEqual(ctx.cInv(inv).np, 400, 'np = 1100 - 0 - 100 - 600 = 400');
});
test('tax is excluded from net profit — buyer pass-through not seller income', () => {
  const inv = { id:'t9', lineItems:[{qty:1,up:1000}],
    taxRate:0.20, dep:0, chargesIncluded:true };
  const c = ctx.cInv(inv);
  // liT=1000, tax=200, grand=1200, cogs=0
  assertEqual(c.grand, 1200, 'grand includes tax');
  assertEqual(c.np,    1000, 'np must exclude the £200 tax (it goes to HMRC, not Stackd)');
});

// ── nextInvNum() ───────────────────────────────────────────────
console.log('\nnextInvNum() — invoice numbering');

test('starts at INV10001 with empty DB', () => {
  ctx.DB.inv = [];
  assertEqual(ctx.nextInvNum(), 'INV10001');
});
test('increments from highest existing number', () => {
  ctx.DB.inv = [{ num:'INV10005' }, { num:'INV10003' }];
  assertEqual(ctx.nextInvNum(), 'INV10006');
});
test('ignores non-INV prefixed entries (CN, PO)', () => {
  ctx.DB.inv = [{ num:'CN10005' }, { num:'PO-001' }];
  assertEqual(ctx.nextInvNum(), 'INV10001');
});

// ── rLI() — column structure & XSS ────────────────────────────
console.log('\nrLI() — table column structure and XSS');

resetDB();
ctx.DB.sup = [{ id:'s1', name:'Test Supplier' }];

test('HS Code column appears in rendered row', () => {
  ctx.DB.li = [{
    id:'l1', sku:'SKU-01', desc:'Widget', specs:'220V', hs:'8418.50',
    supId:'s1', cost:10, price:20, uom:'pcs', cur:'USD',
  }];
  mockEl('li-q').value = ''; mockEl('li-sf').value = '';
  ctx.rLI();
  assertContains(mockEl('li-tb').innerHTML, '8418.50', 'HS code must appear in rendered row');
});
test('li.specs is HTML-escaped in rendered row', () => {
  ctx.DB.li = [{
    id:'l2', sku:'SKU-02', desc:'Widget', specs:'<script>alert(1)</script>',
    hs:'1234', supId:'s1', cost:10, price:20, uom:'pcs', cur:'USD',
  }];
  mockEl('li-q').value = ''; mockEl('li-sf').value = '';
  ctx.rLI();
  assertNotContains(mockEl('li-tb').innerHTML, '<script>', 'li.specs XSS must be escaped');
});
test('rendered row has 11 <td> cells matching header', () => {
  ctx.DB.li = [{
    id:'l3', sku:'SKU-03', desc:'Widget', specs:'spec', hs:'1234',
    supId:'s1', cost:10, price:20, uom:'pcs', cur:'USD',
  }];
  mockEl('li-q').value = ''; mockEl('li-sf').value = '';
  ctx.rLI();
  const tdCount = (mockEl('li-tb').innerHTML.match(/<td/g) || []).length;
  assertEqual(tdCount, 11, 'Row must have 11 <td> cells: SKU, Desc, Specs, HS, Supplier, Cost, Price, UOM, Margin, Cur, Actions');
});

// ── PO → Invoice linking ───────────────────────────────────────
console.log('\nPO → Invoice linking');

test('savePO stores invId resolved from invNum', () => {
  resetDB();
  ctx.DB.inv = [{ id:'inv-abc', num:'INV10029', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.DB.sup = [{ id:'sup-1', name:'Supplier A', cur:'USD' }];
  ctx.EI.p   = null;
  ctx.cPL    = [];

  mockEl('pf-n').value   = 'PO-TEST-001';
  mockEl('pf-sup').value = 'sup-1';
  mockEl('pf-inv').value = 'INV10029';
  mockEl('pf-dt').value  = '2026-01-01';
  mockEl('pf-del').value = '';
  mockEl('pf-cur').value = 'USD';
  mockEl('pf-dep').value = '0';
  mockEl('pf-fpm').value = '0';
  mockEl('pf-rec').checked = false;
  mockEl('pf-oth').value = '0';
  mockEl('pf-pt').value  = 'Net 30';
  mockEl('pf-nt').value  = '';
  mockEl('po-sm').value  = 'Draft';

  ctx.savePO(); // async — DB mutation happens before first await

  const saved = ctx.DB.po[0];
  assert(saved, 'PO should be saved to DB');
  assertEqual(saved.invNum, 'INV10029', 'invNum stored');
  assertEqual(saved.invId,  'inv-abc',  'invId resolved from invNum');
});

test('savePO stores empty invId when invNum does not match any invoice', () => {
  resetDB();
  ctx.DB.sup = [{ id:'sup-1', name:'Supplier A', cur:'USD' }];
  ctx.EI.p   = null;
  ctx.cPL    = [];

  mockEl('pf-n').value   = 'PO-TEST-002';
  mockEl('pf-sup').value = 'sup-1';
  mockEl('pf-inv').value = 'INV99999'; // no match
  mockEl('pf-dt').value  = '2026-01-01';
  mockEl('pf-del').value = '';
  mockEl('pf-cur').value = 'USD';
  mockEl('pf-dep').value = '0';
  mockEl('pf-fpm').value = '0';
  mockEl('pf-rec').checked = false;
  mockEl('pf-oth').value = '0';
  mockEl('pf-pt').value  = '';
  mockEl('pf-nt').value  = '';
  mockEl('po-sm').value  = 'Draft';

  ctx.savePO();

  const saved = ctx.DB.po[0];
  assert(saved, 'PO should be saved');
  assertEqual(saved.invId, '', 'invId should be empty string when no match found');
});

// ── Shipment CRUD ──────────────────────────────────────────────
console.log('\nShipment CRUD');

test('saveShp stores a new shipment in DB.sh', () => {
  resetDB();
  ctx.DB.sh = [];
  ctx.EI.sh = null;

  mockEl('shf-ref').value    = 'SHP-001';
  mockEl('shf-bl').value     = 'MEDU1234567';
  mockEl('shf-vessel').value = 'MSC Mara';
  mockEl('shf-carrier').value= 'MSC';
  mockEl('shf-op').value     = 'Qingdao';
  mockEl('shf-dp').value     = 'Bridgetown';
  mockEl('shf-etd').value    = '2026-05-01';
  mockEl('shf-eta').value    = '2026-06-01';
  mockEl('shf-ctype').value  = '40HQ';
  mockEl('shf-cnum').value   = 'MSCU1234567';
  mockEl('shf-dg').checked   = false;
  mockEl('shf-docs').value   = 'Pending';
  mockEl('shf-st').value     = 'Booked';
  mockEl('shf-invs').value   = 'INV10030, INV10031';
  mockEl('shf-nt').value     = '';

  ctx.saveShp();

  const saved = ctx.DB.sh[0];
  assert(saved, 'Shipment should be saved to DB.sh');
  assertEqual(saved.ref, 'SHP-001', 'ref stored');
  assertEqual(saved.status, 'Booked', 'status stored');
  assertEqual(saved.containerType, '40HQ', 'containerType stored');
  assert(Array.isArray(saved.linkedInvs), 'linkedInvs is array');
  assertEqual(saved.linkedInvs.length, 2, 'two linked invoices parsed');
  assertEqual(saved.linkedInvs[0], 'INV10030', 'first linked invoice');
});

test('saveShp parses DG flag correctly', () => {
  resetDB();
  ctx.DB.sh = [];
  ctx.EI.sh = null;

  mockEl('shf-ref').value    = 'SHP-DG';
  mockEl('shf-bl').value     = '';
  mockEl('shf-vessel').value = '';
  mockEl('shf-carrier').value= '';
  mockEl('shf-op').value     = '';
  mockEl('shf-dp').value     = '';
  mockEl('shf-etd').value    = '';
  mockEl('shf-eta').value    = '';
  mockEl('shf-ctype').value  = '20GP';
  mockEl('shf-cnum').value   = '';
  mockEl('shf-dg').checked   = true;
  mockEl('shf-docs').value   = 'In Progress';
  mockEl('shf-st').value     = 'In Transit';
  mockEl('shf-invs').value   = '';
  mockEl('shf-nt').value     = '';

  ctx.saveShp();

  const saved = ctx.DB.sh[0];
  assert(saved.dg === true, 'dg flag must be true');
  assertEqual(saved.status, 'In Transit', 'In Transit status stored');
  assertEqual(saved.linkedInvs.length, 0, 'empty linkedInvs when field is blank');
});

test('delShp removes shipment from DB.sh', () => {
  resetDB();
  ctx.DB.sh = [{ id:'sh-1', ref:'SHP-DEL', status:'Pending', linkedInvs:[], dg:false }];
  ctx.confirm = () => true;

  ctx.delShp('sh-1');

  assertEqual(ctx.DB.sh.length, 0, 'DB.sh should be empty after delete');
});

test('shpStatusClass returns correct CSS class for each status', () => {
  assertEqual(ctx.shpStatusClass('Pending'),    's-draft',         'Pending → s-draft');
  assertEqual(ctx.shpStatusClass('Booked'),     's-sent',          'Booked → s-sent');
  assertEqual(ctx.shpStatusClass('In Transit'), 's-partially-paid','In Transit → s-partially-paid');
  assertEqual(ctx.shpStatusClass('Arrived'),    's-confirmed',     'Arrived → s-confirmed');
  assertEqual(ctx.shpStatusClass('Delivered'),  's-paid',          'Delivered → s-paid');
});

test('In Transit KPI counts only In Transit shipments', () => {
  ctx.DB.sh = [
    { id:'s1', status:'In Transit' },
    { id:'s2', status:'In Transit' },
    { id:'s3', status:'Booked'     },
    { id:'s4', status:'Delivered'  }
  ];
  const count = ctx.DB.sh.filter(function(s){ return s.status === 'In Transit'; }).length;
  assertEqual(count, 2, 'should count only In Transit shipments');
  ctx.DB.sh = [];
});

// ── Price History ──────────────────────────────────────────────
console.log('\nPrice History — priceHistory versioning');

test('saveLI seeds priceHistory on new item creation', () => {
  resetDB();
  ctx.DB.sup = [{ id:'sup-ph', name:'PH Supplier' }];
  ctx.EI.l = null;
  mockEl('lf-s').value  = 'SKU-PH';
  mockEl('lf-d').value  = 'Price History Test';
  mockEl('lf-sp').value = '';
  mockEl('lf-hs').value = '';
  mockEl('lf-sup').value= 'sup-ph';
  mockEl('lf-u').value  = 'pcs';
  mockEl('lf-c').value  = '100';
  mockEl('lf-p').value  = '150';
  mockEl('lf-cur').value= 'USD';
  mockEl('lf-nt').value = '';

  ctx.saveLI();

  const li = ctx.DB.li[0];
  assert(li, 'line item saved');
  assert(Array.isArray(li.priceHistory), 'priceHistory is array');
  assertEqual(li.priceHistory.length, 1, 'one history entry on creation');
  assertEqual(li.priceHistory[0].cost,  100, 'history cost = 100');
  assertEqual(li.priceHistory[0].price, 150, 'history price = 150');
  assertEqual(li.priceHistory[0].invoiceRef, '', 'invoiceRef empty for catalogue entry');
});

test('saveLI appends history when price changes on edit', () => {
  resetDB();
  ctx.DB.sup = [{ id:'sup-ph', name:'PH Supplier' }];
  ctx.DB.li = [{ id:'li-edit', sku:'SKU-EDIT', desc:'Edit Test', cost:100, price:150, priceHistory:[{ date:'2026-01-01', cost:100, price:150, invoiceRef:'', notes:'Initial catalogue price' }], uom:'pcs', cur:'USD', supId:'sup-ph' }];
  ctx.EI.l = 'li-edit';
  mockEl('lf-s').value  = 'SKU-EDIT';
  mockEl('lf-d').value  = 'Edit Test';
  mockEl('lf-sp').value = '';
  mockEl('lf-hs').value = '';
  mockEl('lf-sup').value= 'sup-ph';
  mockEl('lf-u').value  = 'pcs';
  mockEl('lf-c').value  = '100';
  mockEl('lf-p').value  = '180'; // changed
  mockEl('lf-cur').value= 'USD';
  mockEl('lf-nt').value = '';

  ctx.saveLI();

  const li = ctx.DB.li.find(x => x.id === 'li-edit');
  assert(li, 'line item still exists');
  assertEqual(li.priceHistory.length, 2, 'history appended on price change');
  assertEqual(li.priceHistory[1].price, 180, 'new history entry has updated price');
  assertEqual(li.price, 180, 'catalogue price updated to 180');
});

test('saveLI does not append history when price unchanged on edit', () => {
  resetDB();
  ctx.DB.sup = [{ id:'sup-ph', name:'PH Supplier' }];
  ctx.DB.li = [{ id:'li-same', sku:'SKU-SAME', desc:'No Change', cost:100, price:150, priceHistory:[{ date:'2026-01-01', cost:100, price:150, invoiceRef:'', notes:'Initial catalogue price' }], uom:'pcs', cur:'USD', supId:'sup-ph' }];
  ctx.EI.l = 'li-same';
  mockEl('lf-s').value  = 'SKU-SAME';
  mockEl('lf-d').value  = 'No Change';
  mockEl('lf-sp').value = '';
  mockEl('lf-hs').value = '';
  mockEl('lf-sup').value= 'sup-ph';
  mockEl('lf-u').value  = 'pcs';
  mockEl('lf-c').value  = '100'; // same
  mockEl('lf-p').value  = '150'; // same
  mockEl('lf-cur').value= 'USD';
  mockEl('lf-nt').value = '';

  ctx.saveLI();

  const li = ctx.DB.li.find(x => x.id === 'li-same');
  assertEqual(li.priceHistory.length, 1, 'history unchanged when price not modified');
});

test('saveInv records price history when invoice price deviates from catalogue', () => {
  resetDB();
  ctx.DB.li  = [{ id:'li-dev', sku:'SKU-DEV', desc:'Deviation Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.DB.inv = [{ id:'inv-base', num:'INV10001', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-dev', desc:'Deviation Test', uom:'pcs', qty:1, up:120 }]; // 120 ≠ 150

  mockEl('if-n').value   = 'INV10002';
  mockEl('if-b').value   = 'Test Buyer';
  mockEl('if-ba').value  = '';
  mockEl('if-st').value  = '';
  mockEl('if-dst').value = 'Barbados';
  mockEl('if-cid').value = '';
  mockEl('if-dt').value  = '2026-05-01';
  mockEl('if-ex').value  = '';
  mockEl('if-sd').value  = '';
  mockEl('if-ft').value  = '';
  mockEl('if-wt').value  = '';
  mockEl('if-cbm').value = '';
  mockEl('if-pk').value  = '';
  mockEl('if-pol').value = '';
  mockEl('if-pod').value = '';
  mockEl('if-coo').value = '';
  mockEl('if-cur').value = 'USD';
  mockEl('if-tx').value  = '0';
  mockEl('if-lf').value  = '0';
  mockEl('if-ins').value = '0';
  mockEl('if-leg').value = '0';
  mockEl('if-isp').value = '0';
  mockEl('if-oth').value = '0';
  mockEl('if-dep').value = '0';
  mockEl('if-inco').value = 'CIF';
  mockEl('if-pt').value = 'Net 30';
  mockEl('if-terms').value = '';
  mockEl('if-chi').checked = true;
  mockEl('inv-sm').value = 'Draft';

  ctx.saveInv();

  const cat = ctx.DB.li.find(x => x.id === 'li-dev');
  assert(cat.priceHistory.length > 0, 'history entry added to catalogue item');
  const entry = cat.priceHistory[cat.priceHistory.length - 1];
  assertEqual(entry.price,      120,        'history records invoice price (120)');
  assertEqual(entry.invoiceRef, 'INV10002', 'history records invoice number');
  assertEqual(entry.notes, 'Price at time of order', 'history notes set');
});

test('saveInv does not record history when price matches catalogue', () => {
  resetDB();
  ctx.DB.li  = [{ id:'li-match', sku:'SKU-MATCH', desc:'Match Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-match', desc:'Match Test', uom:'pcs', qty:1, up:150 }]; // exactly matches catalogue

  mockEl('if-n').value   = 'INV10003';
  mockEl('if-b').value   = 'Buyer';
  mockEl('if-ba').value  = ''; mockEl('if-st').value  = ''; mockEl('if-dst').value = '';
  mockEl('if-cid').value = ''; mockEl('if-dt').value  = '2026-05-01'; mockEl('if-ex').value  = '';
  mockEl('if-sd').value  = ''; mockEl('if-ft').value  = ''; mockEl('if-wt').value  = '';
  mockEl('if-cbm').value = ''; mockEl('if-pk').value  = ''; mockEl('if-pol').value = '';
  mockEl('if-pod').value = ''; mockEl('if-coo').value = ''; mockEl('if-cur').value = 'USD';
  mockEl('if-tx').value  = '0'; mockEl('if-lf').value  = '0'; mockEl('if-ins').value = '0';
  mockEl('if-leg').value = '0'; mockEl('if-isp').value = '0'; mockEl('if-oth').value = '0';
  mockEl('if-dep').value = '0'; mockEl('if-inco').value = 'FOB'; mockEl('if-pt').value = 'Net 60';
  mockEl('if-terms').value = ''; mockEl('if-chi').checked = true;
  mockEl('inv-sm').value = 'Draft';

  ctx.saveInv();

  const cat = ctx.DB.li.find(x => x.id === 'li-match');
  assertEqual(cat.priceHistory.length, 0, 'no history added when price matches catalogue');
});

// ── Incoterms + Payment Terms ──────────────────────────────────
console.log('\nIncoterms + Payment Terms');

test('saveInv stores incoterm and paymentTerms on record', () => {
  resetDB();
  ctx.DB.li  = [{ id:'li-ipt', sku:'SKU-IPT', desc:'IPT Test', cost:50, price:100, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-ipt', desc:'IPT Test', uom:'pcs', qty:1, up:100 }];

  mockEl('if-n').value   = 'INV10010';
  mockEl('if-b').value   = 'Test Buyer';
  mockEl('if-ba').value  = ''; mockEl('if-st').value  = ''; mockEl('if-dst').value = 'Jamaica';
  mockEl('if-cid').value = ''; mockEl('if-dt').value  = '2026-05-01'; mockEl('if-ex').value  = '';
  mockEl('if-sd').value  = ''; mockEl('if-ft').value  = ''; mockEl('if-wt').value  = '';
  mockEl('if-cbm').value = ''; mockEl('if-pk').value  = ''; mockEl('if-pol').value = '';
  mockEl('if-pod').value = ''; mockEl('if-coo').value = ''; mockEl('if-cur').value = 'USD';
  mockEl('if-tx').value  = '0'; mockEl('if-lf').value  = '0'; mockEl('if-ins').value = '0';
  mockEl('if-leg').value = '0'; mockEl('if-isp').value = '0'; mockEl('if-oth').value = '0';
  mockEl('if-dep').value = '0'; mockEl('if-inco').value = 'CIF'; mockEl('if-pt').value = 'LC at sight';
  mockEl('if-terms').value = ''; mockEl('if-chi').checked = true;
  mockEl('inv-sm').value = 'Draft';

  ctx.saveInv();

  const inv = ctx.DB.inv[0];
  assert(inv, 'invoice saved');
  assertEqual(inv.incoterm, 'CIF', 'incoterm stored');
  assertEqual(inv.paymentTerms, 'LC at sight', 'paymentTerms stored');
});

test('savePO stores paymentTerms on record', () => {
  resetDB();
  ctx.DB.sup = [{ id:'sup-pt', name:'PT Supplier', cur:'USD' }];
  ctx.EI.p   = null;
  ctx.cPL    = [];

  mockEl('pf-n').value   = 'PO-PT-001';
  mockEl('pf-sup').value = 'sup-pt';
  mockEl('pf-inv').value = '';
  mockEl('pf-dt').value  = '2026-01-01';
  mockEl('pf-del').value = '';
  mockEl('pf-cur').value = 'USD';
  mockEl('pf-dep').value = '0';
  mockEl('pf-fpm').value = '0';
  mockEl('pf-rec').checked = false;
  mockEl('pf-oth').value = '0';
  mockEl('pf-pt').value  = 'TT in advance';
  mockEl('pf-nt').value  = '';
  mockEl('po-sm').value  = 'Draft';

  ctx.savePO();

  const po = ctx.DB.po[0];
  assert(po, 'PO saved');
  assertEqual(po.paymentTerms, 'TT in advance', 'paymentTerms stored on PO');
});

// ── Quote Engine ───────────────────────────────────────────────
console.log('\nQuote Engine — nextQteNum / cQteLine / cQte');

test('nextQteNum returns QTE-0001 with empty DB', () => {
  ctx.DB.qt = [];
  assertEqual(ctx.nextQteNum(), 'QTE-0001');
});

test('nextQteNum increments from highest existing number', () => {
  ctx.DB.qt = [{ num:'QTE-0003' }, { num:'QTE-0001' }];
  assertEqual(ctx.nextQteNum(), 'QTE-0004');
  ctx.DB.qt = [];
});

test('cQteLine calculates landed cost correctly (LCL)', () => {
  var qr = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005 };
  var line = { cost:500, cbm:2, dg:false, dutyPct:10 };
  // freight = 2*85=170, ins=(500+170)*0.005=3.35, duty=500*10/100=50, landed=723.35
  var r = ctx.cQteLine(line, qr, 'LCL', 2);
  assertEqual(r.freight, 170, 'freight = cbm * lclPerCBM');
  assertEqual(r.dgAmt, 0, 'no DG charge');
  assert(Math.abs(r.ins - 3.35) < 0.001, 'ins = (cost+freight)*insRate');
  assertEqual(r.duty, 50, 'duty = cost * dutyPct/100');
  assert(Math.abs(r.landed - 723.35) < 0.001, 'landed total correct');
});

test('cQte sums lines and adds overheads correctly', () => {
  var savedQR = ctx.QR;
  ctx.QR = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005, originCharges:250, destCharges:350, fpmAdmin:75, fxGBPUSD:1.27 };
  var qt = { freightMode:'LCL', markup:20, lines:[{ cost:500, cbm:2, dg:false, dutyPct:10 }] };
  // line landed=723.35, overhead=675, quotedTotal=1398.35, sellUSD=1678.02
  var c = ctx.cQte(qt);
  assert(Math.abs(c.totalLanded - 723.35) < 0.01, 'totalLanded ≈ 723.35');
  assertEqual(c.overhead, 675, 'overhead = originCharges+destCharges+fpmAdmin');
  assert(Math.abs(c.quotedTotal - 1398.35) < 0.01, 'quotedTotal = landed+overhead');
  assert(Math.abs(c.sellUSD - 1678.02) < 0.01, 'sellUSD = quotedTotal*(1+markup/100)');
  assert(Math.abs(c.sellGBP - (1678.02/1.27)) < 0.5, 'sellGBP = sellUSD/fxGBPUSD');
  ctx.QR = savedQR;
});

// ── Quote Line Price Versioning ────────────────────────────────
console.log('\nQuote line price versioning');

function saveQteSetup(rid, cost, dutyPct, markup, note) {
  mockEl('qf-num').value = 'QTE-0001';
  mockEl('qf-client').value = 'Versioning Client';
  mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = '';
  mockEl('qf-cur').value = 'USD';
  mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = String(markup);
  mockEl('qf-st').value = 'Draft';
  mockEl('qf-nt').value = '';
  mockEl('qt-verr').textContent = '';
  mockEl('ql-supId-' + rid).value = '';
  mockEl('ql-desc-' + rid).value = 'Test item';
  mockEl('ql-qty-' + rid).value = '1';
  mockEl('ql-uom-' + rid).value = 'pcs';
  mockEl('ql-cost-' + rid).value = String(cost);
  mockEl('ql-cbm-' + rid).value = '2';
  mockEl('ql-dg-' + rid).checked = false;
  mockEl('ql-dutyPct-' + rid).value = String(dutyPct);
  mockEl('ql-note-' + rid).value = note || '';
}

test('saveQte creates version 1 on first save with correct fields', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv1', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('rv1', 500, 10, 15, 'Initial price');

  ctx.saveQte();

  const line = ctx.DB.qt[0].lines[0];
  assert(Array.isArray(line.priceHistory), 'priceHistory is array');
  assertEqual(line.priceHistory.length, 1, 'version 1 created on first save');
  const v = line.priceHistory[0];
  assertEqual(v.v, 1, 'version number is 1');
  assertEqual(v.cost, 500, 'cost stored');
  assertEqual(v.dutyPct, 10, 'dutyPct stored');
  assertEqual(v.markup, 15, 'markup stored');
  assertEqual(v.note, 'Initial price', 'note stored');
  assert(v.ts && v.ts.length > 10, 'timestamp present');
  assert(v.landed > 0, 'landed > 0');
  assert(v.sellPrice > 0, 'sellPrice > 0');
  assertEqual(v.sellPrice, +(v.landed * 1.15).toFixed(2), 'sellPrice = landed * (1 + markup/100)');
});

test('saveQte appends version 2 when cost changes on re-save', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv2', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:10 }];
  saveQteSetup('rv2', 500, 10, 15, '');
  ctx.saveQte();

  const qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  saveQteSetup('rv2', 600, 10, 15, 'Price increase from supplier');  // cost changed 500→600
  ctx.saveQte();

  const line = ctx.DB.qt[0].lines[0];
  assertEqual(line.priceHistory.length, 2, 'version 2 appended on cost change');
  assertEqual(line.priceHistory[1].v, 2, 'v=2');
  assertEqual(line.priceHistory[1].cost, 600, 'cost updated to 600');
  assertEqual(line.priceHistory[1].note, 'Price increase from supplier', 'note captured');
});

test('saveQte appends new version when dutyPct changes', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv3', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('rv3', 500, 10, 15, '');
  ctx.saveQte();

  const qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  saveQteSetup('rv3', 500, 20, 15, 'Duty rate revised');  // dutyPct changed 10→20
  ctx.saveQte();

  const line = ctx.DB.qt[0].lines[0];
  assertEqual(line.priceHistory.length, 2, 'version 2 appended on dutyPct change');
  assertEqual(line.priceHistory[1].dutyPct, 20, 'dutyPct updated to 20');
});

test('saveQte appends new version when markup changes', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv4', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('rv4', 500, 10, 15, '');
  ctx.saveQte();

  const qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  saveQteSetup('rv4', 500, 10, 20, 'Markup raised');  // markup changed 15→20
  ctx.saveQte();

  const line = ctx.DB.qt[0].lines[0];
  assertEqual(line.priceHistory.length, 2, 'version 2 appended on markup change');
  assertEqual(line.priceHistory[1].markup, 20, 'markup updated to 20');
});

test('saveQte does not append version when no tracked field changes', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv5', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('rv5', 500, 10, 15, '');
  ctx.saveQte();

  const qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  saveQteSetup('rv5', 500, 10, 15, 'No change note');  // cost/dutyPct/markup unchanged
  ctx.saveQte();

  const line = ctx.DB.qt[0].lines[0];
  assertEqual(line.priceHistory.length, 1, 'no new version when tracked fields unchanged');
});

test('version sellPrice equals landed * (1 + markup/100)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'rv6', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('rv6', 400, 5, 25, '');
  ctx.saveQte();

  const v = ctx.DB.qt[0].lines[0].priceHistory[0];
  const expected = +(v.landed * 1.25).toFixed(2);
  assertEqual(v.sellPrice, expected, 'sellPrice = landed * (1 + 0.25)');
  assert(v.landed > 0, 'landed is positive');
});

// ── Accounting Export ──────────────────────────────────────────
console.log('\nAccounting Export');

test('csvRow escapes values containing commas', () => {
  const out = ctx.csvRow(['hello', 'world,comma', 'plain']);
  assertContains(out, '"world,comma"', 'field with comma must be quoted');
});

test('csvRow escapes values containing double quotes', () => {
  const out = ctx.csvRow(['say "hello"']);
  assertContains(out, '"say ""hello"""', 'inner quotes must be doubled');
});

test('csvRow does not quote plain values', () => {
  const out = ctx.csvRow(['foo', 'bar', '123']);
  assertEqual(out, 'foo,bar,123', 'plain values need no quoting');
});

test('acctInvCSV includes expected header columns', () => {
  const out = ctx.acctInvCSV([]);
  assertContains(out, 'Invoice #', 'header must include Invoice #');
  assertContains(out, 'Line Total', 'header must include Line Total');
  assertContains(out, 'Tax Amount', 'header must include Tax Amount');
});

test('acctInvCSV emits one row per line item with invoice fields repeated', () => {
  const inv = {
    id: 'i1', num: 'INV-001', date: '2026-01-01', status: 'Sent', cur: 'USD',
    buyer: 'Acme', dst: 'UK', incoterm: 'FOB', paymentTerms: 'Net 30', taxRate: 0,
    lines: [
      { desc: 'Widget A', sku: 'WA1', qty: 2, up: 10, cu: 6, uom: 'pcs' },
      { desc: 'Widget B', sku: 'WB1', qty: 5, up: 4,  cu: 2, uom: 'pcs' },
    ]
  };
  const out = ctx.acctInvCSV([inv]);
  const lines = out.split('\n');
  // BOM line + header + 2 data rows = 3 lines (BOM is prepended to header row)
  assertEqual(lines.length, 3, 'one header + two data rows');
  assertContains(lines[1], 'INV-001', 'first data row has invoice number');
  assertContains(lines[2], 'INV-001', 'second data row has invoice number repeated');
  assertContains(lines[1], 'Widget A', 'first row has first line desc');
  assertContains(lines[2], 'Widget B', 'second row has second line desc');
});

test('acctInvCSV calculates line total correctly', () => {
  const inv = {
    id: 'i2', num: 'INV-002', date: '2026-01-02', status: 'Draft', cur: 'GBP',
    buyer: 'Bob', dst: 'US', incoterm: '', paymentTerms: '', taxRate: 0.2,
    lines: [{ desc: 'Item', sku: '', qty: 3, up: 50, cu: 30, uom: 'pcs' }]
  };
  const out = ctx.acctInvCSV([inv]);
  assertContains(out, '150.00', 'line total = 3 * 50 = 150');
  assertContains(out, '30.00',  'tax = 150 * 0.2 = 30');
});

test('acctPmtCSV includes expected header and a data row', () => {
  resetDB();
  ctx.DB.inv = [{ id: 'xi1', num: 'INV-100', cur: 'USD', buyer: 'Client Co' }];
  ctx.DB.payments = [{ id: 'p1', invId: 'xi1', date: '2026-02-01', amount: 500, method: 'Bank Transfer', reference: 'REF123', notes: 'deposit' }];
  const out = ctx.acctPmtCSV(ctx.DB.payments);
  assertContains(out, 'Payment ID', 'header has Payment ID');
  assertContains(out, 'INV-100',    'data row has invoice number');
  assertContains(out, 'REF123',     'data row has reference');
  assertContains(out, 'USD',        'currency resolved from linked invoice');
});

test('acctInvJSON returns parseable JSON with invoices array', () => {
  const inv = { id: 'j1', num: 'INV-200', lines: [] };
  const json = ctx.acctInvJSON([inv]);
  const parsed = JSON.parse(json);
  assert(Array.isArray(parsed.invoices), 'invoices must be an array');
  assertEqual(parsed.invoices[0].num, 'INV-200', 'invoice preserved in JSON');
  assert(parsed._exported, '_exported timestamp present');
});

test('acctXeroCSV maps ContactName from inv.buyer', () => {
  const inv = {
    id: 'x1', num: 'XINV-001', date: '2026-03-01', cur: 'GBP', buyer: 'Xero Client',
    buyerAddr: '1 High St', taxRate: 0,
    lines: [{ desc: 'Product X', qty: 1, up: 100 }]
  };
  const out = ctx.acctXeroCSV([inv]);
  assertContains(out, 'Xero Client', 'ContactName must be inv.buyer');
  assertContains(out, 'XINV-001',    'InvoiceNumber must be inv.num');
});

test('acctXeroCSV sets TaxType NONE when taxRate is 0', () => {
  const inv = {
    id: 'x2', num: 'XINV-002', date: '2026-03-01', cur: 'USD', buyer: 'Co',
    taxRate: 0, lines: [{ desc: 'A', qty: 2, up: 50 }]
  };
  assertContains(ctx.acctXeroCSV([inv]), 'NONE', 'TaxType NONE when taxRate=0');
});

test('acctXeroCSV sets TaxType TAX001 when taxRate is greater than 0', () => {
  const inv = {
    id: 'x3', num: 'XINV-003', date: '2026-03-01', cur: 'USD', buyer: 'Co',
    taxRate: 0.2, lines: [{ desc: 'A', qty: 1, up: 100 }]
  };
  assertContains(ctx.acctXeroCSV([inv]), 'TAX001', 'TaxType TAX001 when taxRate>0');
});

test('acctQBCSV maps Customer and Amount correctly', () => {
  const inv = {
    id: 'q1', num: 'QB-001', date: '2026-04-01', cur: 'USD', buyer: 'QB Customer',
    lines: [{ desc: 'Service', qty: 4, up: 25 }]
  };
  const out = ctx.acctQBCSV([inv]);
  assertContains(out, 'QB Customer', 'Customer must be inv.buyer');
  assertContains(out, '100.00',      'Amount = 4 * 25 = 100');
});

test('acctQualityCheck flags missing Incoterm', () => {
  const inv = { id: 'c1', num: 'C-001', incoterm: '', paymentTerms: 'Net 30', lines: [{ qty: 1, up: 10 }] };
  const warns = ctx.acctQualityCheck([inv], [{ invId: 'c1' }]);
  assert(warns.some(function(w) { return w.includes('Incoterm'); }), 'should warn missing Incoterm');
});

test('acctQualityCheck flags missing Payment Terms', () => {
  const inv = { id: 'c2', num: 'C-002', incoterm: 'FOB', paymentTerms: '', lines: [{ qty: 1, up: 10 }] };
  const warns = ctx.acctQualityCheck([inv], [{ invId: 'c2' }]);
  assert(warns.some(function(w) { return w.includes('Payment Terms'); }), 'should warn missing Payment Terms');
});

test('acctQualityCheck flags zero-value line items', () => {
  const inv = { id: 'c3', num: 'C-003', incoterm: 'FOB', paymentTerms: 'Net 30', lines: [{ qty: 0, up: 0 }] };
  const warns = ctx.acctQualityCheck([inv], [{ invId: 'c3' }]);
  assert(warns.some(function(w) { return w.includes('zero-value'); }), 'should warn zero-value line');
});

test('acctQualityCheck flags invoice with no payments', () => {
  const inv = { id: 'c4', num: 'C-004', incoterm: 'FOB', paymentTerms: 'Net 30', lines: [{ qty: 1, up: 50 }] };
  const warns = ctx.acctQualityCheck([inv], []);
  assert(warns.some(function(w) { return w.includes('no payments'); }), 'should warn no payments recorded');
});

test('acctQualityCheck returns no warnings when data is complete', () => {
  const inv = { id: 'c5', num: 'C-005', incoterm: 'FOB', paymentTerms: 'Net 30', lines: [{ qty: 2, up: 25 }] };
  const warns = ctx.acctQualityCheck([inv], [{ invId: 'c5' }]);
  assertEqual(warns.length, 0, 'no warnings when all fields present');
});

// ── SUMMARY ────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(48));
_results.forEach(r => {
  console.log(r.ok ? '  ✓  ' + r.name : '  ✗  ' + r.name);
  if (!r.ok) console.log('       ' + r.msg.replace(/\n/g, '\n       '));
});
console.log('\n' + _pass + '/' + (_pass + _fail) + ' tests passed');
if (_fail > 0) { console.log('\nFAIL'); process.exit(1); }
else            { console.log('\nPASS'); process.exit(0); }
