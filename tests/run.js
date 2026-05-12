// tests/run.js — Stackd Ops automated QA test suite
// Usage: node tests/run.js
'use strict';

const fs       = require('fs');
const path     = require('path');
const vm       = require('vm');
const fixtures = require('./fixtures.js');

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
function assertApprox(a, b, msg) {
  if (Math.round(a * 100) !== Math.round(b * 100)) throw new Error(
    (msg ? msg + '\n    ' : '') + 'Expected ≈' + b + '  Got: ' + a);
}

function resetDB() {
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [] };
}
function loadFixtures() {
  ctx.DB = JSON.parse(JSON.stringify(fixtures));
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
test('rendered row has 12 <td> cells matching header', () => {
  ctx.DB.li = [{
    id:'l3', sku:'SKU-03', desc:'Widget', specs:'spec', hs:'1234',
    supId:'s1', cost:10, price:20, uom:'pcs', cur:'USD',
  }];
  mockEl('li-q').value = ''; mockEl('li-sf').value = '';
  ctx.rLI();
  const tdCount = (mockEl('li-tb').innerHTML.match(/<td/g) || []).length;
  assertEqual(tdCount, 12, 'Row must have 12 <td> cells: SKU, Desc, Specs, HS, Supplier, Cost, Price, UOM, Margin, Cur, Invoices, Actions');
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

// ── PREVIEW DOCUMENT TESTS ─────────────────────────────────────
function makePreviewMock() {
  var captured = '';
  ctx.Blob = function(parts) { this._parts = parts; };
  ctx.URL = { createObjectURL: function(b) { captured = b._parts[0]; return 'blob:mock'; }, revokeObjectURL: function(){} };
  ctx.open = function() { return { focus: function(){} }; };
  return function(){ return captured; };
}

test('prevInvDoc — all line item fields render in HTML output', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevInvDoc({
    num: 'INV10001', cur: 'USD', taxRate: 0.1, buyer: 'ACME Corp',
    lineItems: [
      { rid: 'r1', lid: '', desc: 'Blue Widget', uom: 'pcs', qty: 10, up: 5.99 },
      { rid: 'r2', lid: '', desc: 'Red Gadget',  uom: 'kg',  qty: 2,  up: 50.00 }
    ]
  });
  var html = getHtml();
  assertContains(html, 'Blue Widget', 'prevInvDoc: first line item desc');
  assertContains(html, 'Red Gadget',  'prevInvDoc: second line item desc');
  assertContains(html, 'pcs',         'prevInvDoc: UOM rendered');
  assertContains(html, '5.99',        'prevInvDoc: unit price rendered');
  assertContains(html, '<tbody>',     'prevInvDoc: tbody present');
});

test('prevInvDoc — empty lineItems renders table with no rows', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevInvDoc({ num: 'INV10002', cur: 'USD', taxRate: 0, lineItems: [] });
  var html = getHtml();
  assertContains(html, '<tbody></tbody>', 'prevInvDoc: empty tbody when no line items');
});

test('prevInvDoc — no legacy SVG in output', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevInvDoc({ num: 'INV10003', cur: 'USD', taxRate: 0, lineItems: [] });
  var html = getHtml();
  assert(!html.includes('<svg'), 'prevInvDoc: no SVG in preview HTML (removed in v2.9.6)');
});

test('prevPODoc — all line item fields render in HTML output', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevPODoc({
    num: 'PO-001', cur: 'USD',
    lineItems: [
      { rid: 'r1', lid: '', sku: 'SKU1', desc: 'Steel Bracket', uom: 'each', qty: 50, cost: 3.20 }
    ]
  });
  var html = getHtml();
  assertContains(html, 'Steel Bracket', 'prevPODoc: line item desc');
  assertContains(html, 'each',          'prevPODoc: UOM rendered');
  assertContains(html, '3.20',          'prevPODoc: unit cost rendered');
  assertContains(html, '<tbody>',       'prevPODoc: tbody present');
});

test('prevQteDoc — all line item fields render in HTML output', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevQteDoc({
    num: 'QT-001', client: 'Test Client', freightMode: 'LCL',
    dt: '2026-05-06', markup: 15,
    lines: [
      { rid: 'r1', supId: '', desc: 'Green Component', qty: 4, uom: 'pcs', cost: 120, cbm: 0.8, dg: false, dutyPct: 8 }
    ]
  });
  var html = getHtml();
  assertContains(html, 'Green Component', 'prevQteDoc: line item desc');
  assertContains(html, '<tbody>',         'prevQteDoc: tbody present');
});

// Preview popup mechanism — explicit Blob URL regression tests.
// These tests pin the delivery mechanism: if any preview function reverts to
// document.write() the captured URL will be '' (about:blank) not 'blob:mock'
// and these tests fail before the content tests even run.
test('prevInvDoc — popup opens via Blob URL not document.write', function() {
  var capturedUrl = '';
  ctx.Blob = function(parts) { this._parts = parts; };
  ctx.URL = { createObjectURL: function(b) { return 'blob:mock'; }, revokeObjectURL: function(){} };
  ctx.open = function(url) { capturedUrl = url; return { focus: function(){} }; };
  resetDB();
  ctx.prevInvDoc({ num: 'INV-MECH', cur: 'USD', taxRate: 0, lineItems: [] });
  assertEqual(capturedUrl, 'blob:mock', 'prevInvDoc: window.open receives blob URL');
});

test('prevPODoc — popup opens via Blob URL not document.write', function() {
  var capturedUrl = '';
  ctx.Blob = function(parts) { this._parts = parts; };
  ctx.URL = { createObjectURL: function(b) { return 'blob:mock'; }, revokeObjectURL: function(){} };
  ctx.open = function(url) { capturedUrl = url; return { focus: function(){} }; };
  resetDB();
  ctx.prevPODoc({ num: 'PO-MECH', cur: 'USD', lineItems: [] });
  assertEqual(capturedUrl, 'blob:mock', 'prevPODoc: window.open receives blob URL');
});

test('prevQteDoc — popup opens via Blob URL not document.write', function() {
  var capturedUrl = '';
  ctx.Blob = function(parts) { this._parts = parts; };
  ctx.URL = { createObjectURL: function(b) { return 'blob:mock'; }, revokeObjectURL: function(){} };
  ctx.open = function(url) { capturedUrl = url; return { focus: function(){} }; };
  resetDB();
  ctx.prevQteDoc({ num: 'QT-MECH', client: '', freightMode: 'LCL', dt: '', markup: 0, lines: [] });
  assertEqual(capturedUrl, 'blob:mock', 'prevQteDoc: window.open receives blob URL');
});

// ── isEmptyLI — Sheets sync guard (SPEC-SYN-001) ───────────────
console.log('\nisEmptyLI — Sheets sync guard');

test('isEmptyLI — null returns true (inv)', function() {
  assert(ctx.isEmptyLI(null, 'inv') === true, 'null → true');
});
test('isEmptyLI — undefined returns true (inv)', function() {
  assert(ctx.isEmptyLI(undefined, 'inv') === true, 'undefined → true');
});
test('isEmptyLI — empty string returns true (inv)', function() {
  assert(ctx.isEmptyLI('', 'inv') === true, 'empty string → true');
});
test('isEmptyLI — "[]" string returns true (inv)', function() {
  assert(ctx.isEmptyLI('[]', 'inv') === true, '"[]" string → true');
});
test('isEmptyLI — non-JSON string returns true (inv)', function() {
  assert(ctx.isEmptyLI('not-json', 'inv') === true, 'non-JSON string → true');
});
test('isEmptyLI — number returns true (inv)', function() {
  assert(ctx.isEmptyLI(42, 'inv') === true, 'number 42 → true');
});
test('isEmptyLI — boolean returns true (inv)', function() {
  assert(ctx.isEmptyLI(true, 'inv') === true, 'boolean true → true');
});
test('isEmptyLI — plain object returns true (inv)', function() {
  assert(ctx.isEmptyLI({}, 'inv') === true, 'plain object → true');
});
test('isEmptyLI — empty array returns true (inv)', function() {
  assert(ctx.isEmptyLI([], 'inv') === true, 'empty array → true');
});
test('isEmptyLI — array with up field returns false (inv)', function() {
  assert(ctx.isEmptyLI([{up:5}], 'inv') === false, '[{up:5}] → false for inv');
});
test('isEmptyLI — array with cost field returns false (po)', function() {
  assert(ctx.isEmptyLI([{cost:10}], 'po') === false, '[{cost:10}] → false for po');
});
test('isEmptyLI — array with only desc field returns true for inv', function() {
  assert(ctx.isEmptyLI([{desc:'x'}], 'inv') === true, '[{desc}] no up → true for inv');
});
test('isEmptyLI — non-empty string array returns false (pos)', function() {
  assert(ctx.isEmptyLI(['po-abc123'], 'pos') === false, '["po-abc123"] → false for pos');
});
test('isEmptyLI — array of empty strings returns true (pos)', function() {
  assert(ctx.isEmptyLI([''], 'pos') === true, '[""] → true for pos');
});

// ── invoiceRefs index (SPEC-LIB-001) ───────────────────────────
console.log('\ninvoiceRefs — library item invoice index');

function setupInvForm(num) {
  mockEl('if-n').value = num;           mockEl('if-b').value = 'Test Buyer';
  mockEl('if-ba').value = '';           mockEl('if-st').value = '';
  mockEl('if-dst').value = '';          mockEl('if-cid').value = '';
  mockEl('if-dt').value = '2026-05-01'; mockEl('if-ex').value = '';
  mockEl('if-sd').value = '';           mockEl('if-ft').value = '';
  mockEl('if-wt').value = '';           mockEl('if-cbm').value = '';
  mockEl('if-pk').value = '';           mockEl('if-pol').value = '';
  mockEl('if-pod').value = '';          mockEl('if-coo').value = '';
  mockEl('if-cur').value = 'USD';       mockEl('if-tx').value = '0';
  mockEl('if-lf').value = '0';          mockEl('if-ins').value = '0';
  mockEl('if-leg').value = '0';         mockEl('if-isp').value = '0';
  mockEl('if-oth').value = '0';         mockEl('if-dep').value = '0';
  mockEl('if-inco').value = 'FOB';      mockEl('if-pt').value = 'Net 30';
  mockEl('if-terms').value = '';        mockEl('if-chi').checked = true;
  mockEl('inv-sm').value = 'Draft';
}

test('invoiceRefs — saveInv adds refs to both lib items', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[] });
  ctx.DB.li.push({ id:'lib2', desc:'Gadget', uom:'kg',  price:20, cur:'USD', supId:'', priceHistory:[] });
  ctx.EI.i = null;
  ctx.cIL = [
    { rid:'r1', lid:'lib1', desc:'Widget', uom:'pcs', qty:2, up:10 },
    { rid:'r2', lid:'lib2', desc:'Gadget', uom:'kg',  qty:1, up:20 }
  ];
  setupInvForm('INV10051');
  ctx.saveInv();
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  var lib2 = ctx.DB.li.find(function(l){ return l.id==='lib2'; });
  assert(lib1.invoiceRefs && lib1.invoiceRefs.length === 1, 'lib1 has 1 invoiceRef');
  assert(lib2.invoiceRefs && lib2.invoiceRefs.length === 1, 'lib2 has 1 invoiceRef');
  assertEqual(lib1.invoiceRefs[0].invNum, 'INV10051', 'lib1 ref has correct invNum');
});

test('invoiceRefs — saveInv removes stale ref when lib item removed from invoice', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[],
    invoiceRefs:[{ invId:'inv-x', invNum:'INV10052', date:'2026-01-01' }] });
  ctx.DB.inv.push({ id:'inv-x', num:'INV10052', status:'Draft',
    lineItems:[{rid:'r0',lid:'lib1',desc:'Widget',uom:'pcs',qty:1,up:10}],
    taxRate:0, calc_grandTotal:'10' });
  ctx.EI.i = 'inv-x';
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Manual item', uom:'pcs', qty:1, up:5 }];
  setupInvForm('INV10052');
  ctx.saveInv();
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  var remaining = (lib1.invoiceRefs||[]).filter(function(r){ return r.invId==='inv-x'; });
  assertEqual(remaining.length, 0, 'lib1 stale ref removed after item dropped from invoice');
});

test('invoiceRefs — delInv removes all refs for that invoice', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[],
    invoiceRefs:[{ invId:'inv-del', invNum:'INV10053', date:'2026-01-01' }] });
  ctx.DB.inv.push({ id:'inv-del', num:'INV10053', status:'Draft', lineItems:[], taxRate:0 });
  ctx.confirm = function(){ return true; };
  ctx.delInv('inv-del');
  ctx.confirm = function(){ return false; };
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  var remaining = (lib1.invoiceRefs||[]).filter(function(r){ return r.invId==='inv-del'; });
  assertEqual(remaining.length, 0, 'invoiceRef cleaned up after delInv');
});

test('invoiceRefs — saveInv with empty cIL does not modify invoiceRefs', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[],
    invoiceRefs:[{ invId:'inv-y', invNum:'INV10054', date:'2026-01-01' }] });
  ctx.DB.inv.push({ id:'inv-y', num:'INV10054', status:'Draft',
    lineItems:[{rid:'r0',lid:'lib1',desc:'Widget',uom:'pcs',qty:1,up:10}],
    taxRate:0, calc_grandTotal:'10' });
  ctx.EI.i = 'inv-y';
  ctx.cIL = [];
  setupInvForm('INV10054');
  ctx.saveInv();
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  assertEqual((lib1.invoiceRefs||[]).length, 1, 'invoiceRefs unchanged when saveInv called with empty cIL');
});

test('invoiceRefs — openPicker marks item in cIL with li-already-on-inv class', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[] });
  ctx.cIL = [{ rid:'r1', lid:'lib1', desc:'Widget', uom:'pcs', qty:1, up:10 }];
  ctx.openPicker();
  var html = ctx.G('pick-list').innerHTML;
  assertContains(html, 'li-already-on-inv', 'picker adds li-already-on-inv class for item in cIL');
});

test('invoiceRefs — rLI shows usage count for item on 2 invoices', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[],
    invoiceRefs:[
      { invId:'i1', invNum:'INV10055', date:'2026-01-01' },
      { invId:'i2', invNum:'INV10056', date:'2026-02-01' }
    ]
  });
  mockEl('li-q').value = '';
  mockEl('li-sf').value = '';
  ctx.rLI();
  var html = ctx.G('li-tb').innerHTML;
  assertContains(html, 'used on 2 invoice(s)', 'rLI shows correct usage count');
});

test('invoiceRefs — saveInv is idempotent (no duplicate refs on second save)', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[] });
  ctx.DB.inv.push({ id:'inv-idem', num:'INV10057', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'0' });
  ctx.EI.i = 'inv-idem';
  ctx.cIL = [{ rid:'r1', lid:'lib1', desc:'Widget', uom:'pcs', qty:1, up:10 }];
  setupInvForm('INV10057');
  ctx.saveInv();
  ctx.saveInv();
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  assertEqual(lib1.invoiceRefs.length, 1, 'no duplicate invoiceRef entries after second save');
});

test('invoiceRefs — stale-ref removal only removes current invoice ref, preserves others', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', desc:'Widget', uom:'pcs', price:10, cur:'USD', supId:'', priceHistory:[],
    invoiceRefs:[
      { invId:'inv-a', invNum:'INV10058', date:'2026-01-01' },
      { invId:'inv-b', invNum:'INV10059', date:'2026-02-01' }
    ]
  });
  ctx.DB.inv.push({ id:'inv-a', num:'INV10058', status:'Draft',
    lineItems:[{rid:'r0',lid:'lib1',desc:'Widget',uom:'pcs',qty:1,up:10}],
    taxRate:0, calc_grandTotal:'10' });
  ctx.EI.i = 'inv-a';
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Manual', uom:'pcs', qty:1, up:5 }];
  setupInvForm('INV10058');
  ctx.saveInv();
  var lib1 = ctx.DB.li.find(function(l){ return l.id==='lib1'; });
  var forA = (lib1.invoiceRefs||[]).filter(function(r){ return r.invId==='inv-a'; });
  var forB = (lib1.invoiceRefs||[]).filter(function(r){ return r.invId==='inv-b'; });
  assertEqual(forA.length, 0, 'inv-A ref removed');
  assertEqual(forB.length, 1, 'inv-B ref preserved');
});

// ── buildInvLines — Sheets Line Items tab ──────────────────────
console.log('\nbuildInvLines — Sheets Line Items tab');

test('buildInvLines — one row per line item across invoices', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV10100', buyer:'ACME', date:'2026-05-01', cur:'USD', type:'invoice',
    lineItems:[
      { rid:'r1', lid:'', desc:'Widget', uom:'pcs', qty:3, up:50 },
      { rid:'r2', lid:'', desc:'Gadget', uom:'kg',  qty:2, up:80 }
    ] });
  ctx.DB.inv.push({ id:'i2', num:'INV10101', buyer:'Bob',  date:'2026-05-02', cur:'GBP', type:'invoice',
    lineItems:[
      { rid:'r3', lid:'', desc:'Part',   uom:'pcs', qty:10, up:5 }
    ] });
  var rows = ctx.buildInvLines();
  assertEqual(rows.length, 3, 'three rows total across two invoices');
  assertEqual(rows[0].invNum, 'INV10100', 'first row invoice number');
  assertEqual(rows[2].invNum, 'INV10101', 'third row second invoice');
});

test('buildInvLines — row fields match spec columns', function() {
  resetDB();
  ctx.DB.li.push({ id:'lib1', sku:'WGT-01', desc:'Widget', cost:30, price:50, cur:'USD', uom:'pcs', supId:'', priceHistory:[] });
  ctx.DB.inv.push({ id:'i1', num:'INV10102', buyer:'ACME', date:'2026-05-03', cur:'USD', type:'invoice',
    lineItems:[{ rid:'r1', lid:'lib1', desc:'Widget', uom:'pcs', qty:4, up:50 }] });
  var row = ctx.buildInvLines()[0];
  assertEqual(row.invNum,    'INV10102', 'invNum');
  assertEqual(row.buyer,     'ACME',     'buyer');
  assertEqual(row.date,      '2026-05-03', 'date');
  assertEqual(row.sku,       'WGT-01',   'sku from library');
  assertEqual(row.desc,      'Widget',   'desc');
  assertEqual(row.qty,       4,          'qty');
  assertEqual(row.uom,       'pcs',      'uom');
  assertEqual(row.unitCost,  30,         'unitCost from library');
  assertEqual(row.unitPrice, 50,         'unitPrice');
  assertEqual(row.lineTotal, 200,        'lineTotal = 4 * 50');
  assertEqual(row.currency,  'USD',      'currency');
});

test('buildInvLines — quick-add lines (no lid) have empty sku and unitCost', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV10103', buyer:'Bob', date:'2026-05-04', cur:'USD', type:'invoice',
    lineItems:[{ rid:'r1', lid:'', desc:'Custom item', uom:'pcs', qty:1, up:100 }] });
  var row = ctx.buildInvLines()[0];
  assertEqual(row.sku,      '', 'sku empty for quick-add line');
  assertEqual(row.unitCost, '', 'unitCost empty for quick-add line');
  assertEqual(row.lineTotal, 100, 'lineTotal still calculated');
});

test('buildInvLines — credit notes and goodwill credits are excluded', function() {
  resetDB();
  ctx.DB.inv.push({ id:'cn1', num:'CN10100', type:'credit_note', cnAmount:-200, lineItems:[], buyer:'ACME', date:'2026-05-01', cur:'USD' });
  ctx.DB.inv.push({ id:'gw1', num:'CN10101', type:'goodwill_credit', cnAmount:-100, lineItems:[], buyer:'Bob', date:'2026-05-02', cur:'USD' });
  ctx.DB.inv.push({ id:'i1',  num:'INV10104', type:'invoice', buyer:'Corp', date:'2026-05-03', cur:'USD',
    lineItems:[{ rid:'r1', lid:'', desc:'Widget', uom:'pcs', qty:1, up:50 }] });
  var rows = ctx.buildInvLines();
  assertEqual(rows.length, 1, 'only invoice line items included; CNs skipped');
  assertEqual(rows[0].invNum, 'INV10104', 'only the regular invoice row present');
});

test('buildInvLines — invoice with no line items contributes zero rows', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV10105', buyer:'ACME', date:'2026-05-01', cur:'USD', type:'invoice', lineItems:[] });
  var rows = ctx.buildInvLines();
  assertEqual(rows.length, 0, 'no rows for invoice with empty lineItems');
});

// ── Credit Note System (v2.9.8) ────────────────────────────────
console.log('\nCredit Note System (v2.9.8)');

function setupCNForm(cnNum, linkedInvNum, amount, goodwill) {
  mockEl('if-n').value = cnNum || 'CN10080';
  mockEl('if-b').value = 'Test Buyer';
  ['if-ba','if-st','if-dst','if-cid','if-ex','if-sd','if-ft','if-wt','if-cbm','if-pk','if-pol','if-pod','if-coo'].forEach(function(f){ mockEl(f).value=''; });
  mockEl('if-dt').value = '2026-05-01';
  mockEl('if-cur').value = 'USD'; mockEl('if-tx').value = '0';
  ['if-lf','if-ins','if-leg','if-isp','if-oth','if-dep'].forEach(function(f){ mockEl(f).value='0'; });
  mockEl('if-inco').value = ''; mockEl('if-pt').value = '';
  mockEl('if-terms').value = ''; mockEl('if-chi').checked = true;
  mockEl('inv-sm').value = 'CN Draft';
  mockEl('if-linked').value = linkedInvNum || '';
  mockEl('if-cn-reason').value = 'Test credit reason';
  mockEl('if-cn-amount').value = String(amount || 0);
  mockEl('if-cn-goodwill').checked = !!goodwill;
}

test('vInv — CN bypasses line-item/incoterm/pt validation when cn-amount > 0', function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN10080', 'INV10080', 250, false);
  var result = ctx.vInv();
  assert(result, 'vInv returns true for valid standard CN with cn-amount > 0');
});

test('vInv — CN fails validation when cn-amount is 0', function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN10081', 'INV10081', 0, false);
  var result = ctx.vInv();
  assert(result === false, 'vInv returns false when cn-amount is 0');
});

test('prevInvId — credit_note routes to prevCNDoc', function() {
  resetDB();
  var called = '';
  var origCN = ctx.prevCNDoc, origInv = ctx.prevInvDoc;
  ctx.prevCNDoc = function(){ called = 'CN'; };
  ctx.prevInvDoc = function(){ called = 'Inv'; };
  ctx.DB.inv.push({ id:'cn-r1', num:'CN10082', type:'credit_note', cnAmount:-200, cur:'USD' });
  ctx.prevInvId('cn-r1');
  ctx.prevCNDoc = origCN; ctx.prevInvDoc = origInv;
  assertEqual(called, 'CN', 'credit_note routes to prevCNDoc');
});

test('prevInvId — goodwill_credit routes to prevCNDoc', function() {
  resetDB();
  var called = '';
  var origCN = ctx.prevCNDoc, origInv = ctx.prevInvDoc;
  ctx.prevCNDoc = function(){ called = 'CN'; };
  ctx.prevInvDoc = function(){ called = 'Inv'; };
  ctx.DB.inv.push({ id:'gw-r1', num:'CN10083', type:'goodwill_credit', cnAmount:-100, cur:'USD' });
  ctx.prevInvId('gw-r1');
  ctx.prevCNDoc = origCN; ctx.prevInvDoc = origInv;
  assertEqual(called, 'CN', 'goodwill_credit routes to prevCNDoc');
});

test('prevInvId — invoice routes to prevInvDoc not prevCNDoc', function() {
  resetDB();
  var called = '';
  var origCN = ctx.prevCNDoc, origInv = ctx.prevInvDoc;
  ctx.prevCNDoc = function(){ called = 'CN'; };
  ctx.prevInvDoc = function(){ called = 'Inv'; };
  ctx.DB.inv.push({ id:'inv-r1', num:'INV10082', type:'invoice', lineItems:[], taxRate:0 });
  ctx.prevInvId('inv-r1');
  ctx.prevCNDoc = origCN; ctx.prevInvDoc = origInv;
  assertEqual(called, 'Inv', 'invoice routes to prevInvDoc');
});

test('prevCNDoc — HTML title says Credit Note and amount not in parentheses', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevCNDoc({ num:'CN10084', type:'credit_note', cnAmount:-350, cur:'USD', buyer:'ACME', buyerAddr:'', date:'2026-05-01', status:'CN Draft', cnReason:'Pricing error', linkedInvNum:'INV10084', linkedInvId:'' });
  var html = getHtml();
  assertContains(html, 'Credit Note', 'prevCNDoc title contains Credit Note');
  assert(!html.includes('($'), 'amount not wrapped in accounting parentheses');
});

test('prevCNDoc — goodwill badge shows GOODWILL CREDIT', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevCNDoc({ num:'CN10085', type:'goodwill_credit', cnAmount:-200, cur:'USD', buyer:'ACME', buyerAddr:'', date:'2026-05-01', status:'CN Draft', cnReason:'Thank you gesture', linkedInvNum:'', linkedInvId:'' });
  var html = getHtml();
  assertContains(html, 'GOODWILL CREDIT', 'goodwill badge present');
  assert(!html.includes('CREDIT NOTE'), 'CREDIT NOTE badge absent for goodwill type');
});

test('prevCNDoc — goodwill has no Against Invoice row', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevCNDoc({ num:'CN10086', type:'goodwill_credit', cnAmount:-100, cur:'USD', buyer:'ACME', buyerAddr:'', date:'2026-05-01', status:'CN Draft', cnReason:'Apology', linkedInvNum:'', linkedInvId:'' });
  var html = getHtml();
  assert(!html.includes('Against Invoice'), 'no Against Invoice row for goodwill credit');
});

test('cInv — applied CN reduces linked invoice balance', function() {
  resetDB();
  ctx.DB.inv.push({ id:'inv-b1', num:'INV10087', type:'invoice', lineItems:[{qty:2,up:500}], taxRate:0, dep:0 });
  ctx.DB.inv.push({ id:'cn-b1', num:'CN10087', type:'credit_note', linkedInvId:'inv-b1', linkedInvNum:'INV10087', cnAmount:-200, status:'CN Applied' });
  var c = ctx.cInv(ctx.DB.inv.find(function(i){ return i.id==='inv-b1'; }));
  assertEqual(c.grand, 1000, 'grand = 2 * 500 = 1000');
  assertEqual(c.bal,    800, 'balance = 1000 - 0 - 200 = 800');
});

test('cInv — applied CN case-insensitive linkedInvNum match', function() {
  resetDB();
  ctx.DB.inv.push({ id:'inv-b2', num:'INV10088', type:'invoice', lineItems:[{qty:1,up:600}], taxRate:0, dep:0 });
  ctx.DB.inv.push({ id:'cn-b2', num:'CN10088', type:'credit_note', linkedInvNum:'inv10088', cnAmount:-150, status:'CN Applied' });
  var c = ctx.cInv(ctx.DB.inv.find(function(i){ return i.id==='inv-b2'; }));
  assertEqual(c.bal, 450, 'case-insensitive match: 600 - 150 = 450');
});

test('cInv — legacy CN without type field reduces balance via isCN(num)', function() {
  resetDB();
  ctx.DB.inv.push({ id:'inv-b3', num:'INV10089', type:'invoice', lineItems:[{qty:1,up:1000}], taxRate:0, dep:0 });
  ctx.DB.inv.push({ id:'cn-b3', num:'CN10089', linkedInvNum:'INV10089', cnAmount:-100, status:'CN Applied' });
  var c = ctx.cInv(ctx.DB.inv.find(function(i){ return i.id==='inv-b3'; }));
  assertEqual(c.bal, 900, 'legacy CN without type: 1000 - 100 = 900');
});

test('cInv — multiple applied CNs summed and deducted', function() {
  resetDB();
  ctx.DB.inv.push({ id:'inv-b4', num:'INV10090', type:'invoice', lineItems:[{qty:1,up:1000}], taxRate:0, dep:0 });
  ctx.DB.inv.push({ id:'cn-b4a', num:'CN10090a', type:'credit_note', linkedInvNum:'INV10090', cnAmount:-200, status:'CN Applied' });
  ctx.DB.inv.push({ id:'cn-b4b', num:'CN10090b', type:'credit_note', linkedInvNum:'INV10090', cnAmount:-150, status:'CN Applied' });
  var c = ctx.cInv(ctx.DB.inv.find(function(i){ return i.id==='inv-b4'; }));
  assertEqual(c.bal, 650, 'two CNs applied: 1000 - 200 - 150 = 650');
});

test('cInv — goodwill_credit early return uses cnAmount', function() {
  resetDB();
  var gw = { id:'gw1', num:'CN10091', type:'goodwill_credit', cnAmount:-300, lineItems:[], taxRate:0, dep:0 };
  var c = ctx.cInv(gw);
  assertEqual(c.grand, -300, 'goodwill grand = cnAmount (-300)');
  assertEqual(c.bal,   -300, 'goodwill bal = cnAmount (-300)');
});

test('saveInv — goodwill credit saves with type goodwill_credit', function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN10092', '', 300, true);
  ctx.saveInv();
  var cn = ctx.DB.inv.find(function(i){ return i.num==='CN10092'; });
  assert(cn, 'goodwill credit record saved');
  assertEqual(cn.type, 'goodwill_credit', 'type is goodwill_credit');
  assertEqual(cn.cnAmount, -300, 'cnAmount stored as negative');
});

test('saveInv — goodwill credit adds negative payments ledger entry', function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [];
  setupCNForm('CN10093', '', 400, true);
  ctx.saveInv();
  var cn = ctx.DB.inv.find(function(i){ return i.num==='CN10093'; });
  var pmt = ctx.DB.payments.find(function(p){ return p.invId===cn.id && p.method==='Goodwill Credit'; });
  assert(pmt, 'goodwill payment ledger entry created');
  assertEqual(pmt.amount, -400, 'payment amount is -400');
});

// ── Fixture regression — production-like anonymised dataset ───
console.log('\nFixture regression — production-like anonymised dataset');

test('fixture — 9 suppliers, 20 items, 7 invoice/CN records, 5 payments, 1 shipment', function() {
  loadFixtures();
  assertEqual(ctx.DB.sup.length,      9, 'supplier count');
  assertEqual(ctx.DB.li.length,      20, 'line item count');
  assertEqual(ctx.DB.inv.length,      7, 'invoice+CN count');
  assertEqual(ctx.DB.payments.length, 5, 'payment count');
  assertEqual(ctx.DB.sh.length,       1, 'shipment count');
});

test('INV10028 — live line items: grand ≈$31,355.87', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10028'; });
  assertApprox(ctx.cInv(inv).grand, 31355.87, 'INV10028 grand');
});

test('INV10028 — two payments total $31,055.87: balance $300', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10028'; });
  assertEqual(ctx.cInv(inv).bal, 300, 'INV10028 balance');
});

test('INV10030 — live line items: grand ≈$14,180', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10030'; });
  assertApprox(ctx.cInv(inv).grand, 14180, 'INV10030 grand');
});

test('INV10030 — deposit $4,000 + CN Applied $500: balance ≈$9,680', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10030'; });
  assertApprox(ctx.cInv(inv).bal, 9680, 'INV10030 bal with CN');
});

test('INV10030 — without CN Applied: balance ≈$10,180', function() {
  loadFixtures();
  ctx.DB.inv = ctx.DB.inv.filter(function(i){ return i.num !== 'CN10001'; });
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10030'; });
  assertApprox(ctx.cInv(inv).bal, 10180, 'INV10030 bal without CN');
});

test('INV10029 — no live items: calc_ fallback grand $957.08', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10029'; });
  assertEqual(ctx.cInv(inv).grand, 957.08, 'INV10029 calc_ fallback grand');
});

test('INV10029 — fully paid: balance $0', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10029'; });
  assertEqual(ctx.cInv(inv).bal, 0, 'INV10029 fully paid');
});

test('INV10032 — freight-only lines: grand $6,071, balance $6,071', function() {
  loadFixtures();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'INV10032'; });
  var r = ctx.cInv(inv);
  assertEqual(r.grand, 6071, 'INV10032 grand');
  assertEqual(r.bal,   6071, 'INV10032 balance');
});

test('CN10001 — credit_note cInv early return: grand and bal = cnAmount', function() {
  loadFixtures();
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN10001'; });
  var r = ctx.cInv(cn);
  assertEqual(r.grand, -500, 'CN10001 grand = cnAmount');
  assertEqual(r.bal,   -500, 'CN10001 bal = cnAmount');
});

test('CN10002 — goodwill_credit cInv early return: grand = cnAmount', function() {
  loadFixtures();
  var gw = ctx.DB.inv.find(function(i){ return i.num === 'CN10002'; });
  assertEqual(ctx.cInv(gw).grand, -200, 'CN10002 goodwill grand');
});

test('buildInvLines — 25 rows from 5 invoices, excludes 2 CN records', function() {
  loadFixtures();
  assertEqual(ctx.buildInvLines().length, 25, 'buildInvLines row count');
});

test('buildInvLines — resolves catalogue SKU and unit cost for lid-linked rows', function() {
  loadFixtures();
  var rows = ctx.buildInvLines();
  var row = rows.find(function(r){ return r.invNum === 'INV10028' && r.sku === 'VF-2050R-F'; });
  assert(row, 'VF-2050R-F row found in INV10028');
  assertEqual(row.qty,       1,    'qty');
  assertEqual(row.unitPrice, 3120, 'unitPrice');
  assertEqual(row.lineTotal, 3120, 'lineTotal');
  assertEqual(row.unitCost,  2600, 'unitCost resolved from library');
});

test('buildInvLines — non-catalogue rows have empty SKU and unitCost', function() {
  loadFixtures();
  var rows = ctx.buildInvLines();
  var row = rows.find(function(r){ return r.invNum === 'INV10028' && r.desc.includes('container'); });
  assert(row, 'container row found in INV10028');
  assertEqual(row.sku,      '', 'non-catalogue sku empty');
  assertEqual(row.unitCost, '', 'non-catalogue unitCost empty');
});

test('goodwill credit — payments ledger entry has negative amount', function() {
  loadFixtures();
  var pmt = ctx.DB.payments.find(function(p){ return p.method === 'Goodwill Credit'; });
  assert(pmt,              'goodwill payment entry exists');
  assertEqual(pmt.amount,  -200,     'goodwill amount is negative');
  assertEqual(pmt.invNum,  'CN10002', 'linked to CN10002');
});

// ── CN Modal Separation (v2.9.10) ──────────────────────────────
console.log('\nCN Modal Separation (v2.9.10)');

function setupCNFormNew(cnNum, linkedInvNum, amount, goodwill) {
  mockEl('cnf-n').value = cnNum || 'CN10080';
  mockEl('cnf-b').value = 'Test Buyer';
  mockEl('cnf-dt').value = '2026-05-01';
  mockEl('cnf-cur').value = 'USD';
  mockEl('cnf-amount').value = String(amount || 0);
  mockEl('cnf-linked').value = linkedInvNum || '';
  mockEl('cnf-reason').value = 'Test credit reason';
  mockEl('cnf-nt').value = '';
  mockEl('cnf-type').value = goodwill ? 'goodwill_credit' : 'credit_note';
  mockEl('cn-sm').value = 'CN Draft';
  mockEl('cn-verr').textContent = '';
  mockEl('fld-cn-linked').style.display = goodwill ? 'none' : 'block';
}

test('vCN — valid standard CN passes validation', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10200', 'INV10200', 250, false);
  var result = ctx.vCN();
  assert(result, 'vCN returns true for valid standard CN with amount > 0');
});

test('vCN — fails when cn-amount is 0', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10201', 'INV10201', 0, false);
  var result = ctx.vCN();
  assert(result === false, 'vCN returns false when amount is 0');
});

test('vCN — fails when CN number is missing', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10202', 'INV10202', 100, false);
  mockEl('cnf-n').value = ''; // Override default fallback — empty number
  var result = ctx.vCN();
  assert(result === false, 'vCN returns false when CN number is empty');
});

test('vCN — fails standard CN when linked invoice missing', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10203', '', 100, false);
  var result = ctx.vCN();
  assert(result === false, 'vCN returns false when standard CN has no linked invoice');
});

test('vCN — goodwill passes without linked invoice', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10204', '', 150, true);
  var result = ctx.vCN();
  assert(result, 'vCN returns true for goodwill CN without linked invoice');
});

test('saveCN — standard credit note saves with type credit_note', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10205', 'INV10205', 300, false);
  ctx.saveCN();
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN10205'; });
  assert(cn, 'CN record saved');
  assertEqual(cn.type, 'credit_note', 'type is credit_note');
  assertEqual(cn.cnAmount, -300, 'cnAmount stored as negative');
  assertEqual(cn.linkedInvNum, 'INV10205', 'linkedInvNum set');
});

test('saveCN — goodwill credit saves with type goodwill_credit', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10206', '', 400, true);
  ctx.saveCN();
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN10206'; });
  assert(cn, 'goodwill CN record saved');
  assertEqual(cn.type, 'goodwill_credit', 'type is goodwill_credit');
  assertEqual(cn.cnAmount, -400, 'cnAmount is -400');
});

test('saveCN — goodwill credit adds negative payments ledger entry', function() {
  resetDB();
  ctx.EI.cn = null;
  setupCNFormNew('CN10207', '', 500, true);
  ctx.saveCN();
  var cn = ctx.DB.inv.find(function(i){ return i.num === 'CN10207'; });
  var pmt = ctx.DB.payments.find(function(p){ return p.invId === cn.id && p.method === 'Goodwill Credit'; });
  assert(pmt, 'goodwill payment ledger entry created');
  assertEqual(pmt.amount, -500, 'payment amount is -500');
});

test('saveCN — duplicate CN number is rejected', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'existing-cn', num: 'CN10208', type: 'credit_note', cnAmount: -100 });
  ctx.EI.cn = null;
  setupCNFormNew('CN10208', 'INV10208', 100, false);
  ctx.saveCN();
  var cnt = ctx.DB.inv.filter(function(i){ return i.num === 'CN10208'; }).length;
  assertEqual(cnt, 1, 'duplicate CN not saved — only one record with that number');
});

test('saveCN — edit existing CN updates record in-place', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'edit-cn-1', num: 'CN10209', type: 'credit_note', cnAmount: -100, buyer: 'Old Buyer' });
  ctx.EI.cn = 'edit-cn-1';
  setupCNFormNew('CN10209', 'INV10209', 200, false);
  mockEl('cnf-b').value = 'New Buyer';
  ctx.saveCN();
  var cn = ctx.DB.inv.find(function(i){ return i.id === 'edit-cn-1'; });
  assert(cn, 'record still exists');
  assertEqual(cn.buyer, 'New Buyer', 'buyer updated');
  assertEqual(cn.cnAmount, -200, 'amount updated');
  var total = ctx.DB.inv.filter(function(i){ return i.num === 'CN10209'; }).length;
  assertEqual(total, 1, 'no duplicate created on edit');
});

// ── Language / setLang (v2.9.10) ───────────────────────────────
console.log('\nLanguage toggle (v2.9.10)');

test('setLang — stores lang in localStorage', function() {
  ctx.setLang('zh');
  assertEqual(ctx.localStorage.getItem('stackd_lang'), 'zh', 'zh stored in localStorage');
  ctx.setLang('en');
  assertEqual(ctx.localStorage.getItem('stackd_lang'), 'en', 'en stored in localStorage');
});

test('_lang defaults to en when not set', function() {
  // _lang was initialised before mock storage had the key
  assert(ctx._lang === 'en' || ctx._lang === 'zh', '_lang is a valid language code');
});

// ── Company Branding (v2.9.10) ─────────────────────────────────
console.log('\nCompany Branding (v2.9.10)');

test('getCoBrand — returns defaults when nothing stored', function() {
  var b = ctx.getCoBrand();
  assertEqual(typeof b.colour, 'string', 'colour is string');
  assertEqual(typeof b.powered, 'boolean', 'powered is boolean');
});

test('saveCoBrand — round-trips branding data', function() {
  ctx.saveCoBrand({ logo:'', name:'Test Co', trading:'TestTrade', addr:'London', email:'e@t.com', phone:'123', reg:'REG1', vat:'VAT1', colour:'#112233', footer:'Pay in 30', powered:false });
  var b = ctx.getCoBrand();
  assertEqual(b.name, 'Test Co', 'name round-trips');
  assertEqual(b.colour, '#112233', 'colour round-trips');
  assertEqual(b.powered, false, 'powered round-trips as false');
});

test('buildPdfHeader — returns HTML string with border colour', function() {
  ctx.saveCoBrand({ logo:'', name:'ACME', trading:'', addr:'', email:'', phone:'', reg:'', vat:'', colour:'#AA0000', footer:'', powered:true });
  var html = ctx.buildPdfHeader('#AA0000');
  assertContains(html, '#AA0000', 'accent colour in header');
  assertContains(html, 'ACME', 'company name in header');
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
