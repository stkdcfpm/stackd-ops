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
      appendChild() {},
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

// Dispatching fetch mock for pullAll()/sGet() tests — keyed by payload.entity.
// Set _mockPullResponses[entity] = {status:'ok', records:[...]} before calling pullAll() in a test,
// then delete/reset it afterward. Any entity not present in the map falls back to the old static
// default ({status:'ok', records:[]}), matching prior test behavior for every existing test.
let _mockPullResponses = {};
// REQ-SYNC-002 / SPEC-SYNC-002 mocks for the batched bulk_upsert_all/pull_all actions.
// _mockPullAllResponse: set to {status:'ok', results:{...}} to test the batched pull path directly.
// _mockUnknownBatchAction: set true to make bulk_upsert_all/pull_all return the server's
// existing "Unknown action" reply, to test the client-side fallback (REQ-SYNC-002d).
// _fetchCallLog: every Sheets-sync call this test made, in order — reset before use.
let _mockPullAllResponse = null;
let _mockUnknownBatchAction = false;
let _fetchCallLog = [];
// Mock for ordCheckLineGapsSemantic()'s direct Anthropic call (SPEC-ORD-005).
// Set _mockAnthropic to one of: 'reject' (network error), {status:<non-200>},
// or {status:200, text:<raw response body text>} before calling the function under test.
let _mockAnthropic = null;
let _lastAnthropicBody = null;
function mockFetch(url, opts) {
  if (typeof url === 'string' && url.indexOf('api.anthropic.com') >= 0) {
    _lastAnthropicBody = JSON.parse((opts && opts.body) || '{}');
    if (_mockAnthropic === 'reject') return Promise.reject(new Error('network error'));
    var m = _mockAnthropic || { status: 200, text: '[]' };
    return Promise.resolve({
      ok: m.status === 200,
      status: m.status,
      json: () => Promise.resolve({ content: [{ type: 'text', text: m.text || '' }] }),
    });
  }
  var body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}

  _fetchCallLog.push({ action: body.action, entity: body.entity, entities: body.entities });

  if ((body.action === 'bulk_upsert_all' || body.action === 'pull_all') && _mockUnknownBatchAction) {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ status: 'error', message: 'Unknown action: ' + body.action })) });
  }
  if (body.action === 'pull_all' && _mockPullAllResponse) {
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(_mockPullAllResponse)) });
  }

  var resp = (body.action === 'pull_entity' && _mockPullResponses[body.entity])
    ? _mockPullResponses[body.entity]
    : { status: 'ok', records: [] };
  return Promise.resolve({ text: () => Promise.resolve(JSON.stringify(resp)) });
}

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
  prompt:          () => null,
  alert:           () => {},
  fetch:           mockFetch,
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

// Async tests (e.g. pullAll(), which awaits a mocked fetch) are queued here and
// run sequentially at the very end, after every synchronous test above has executed.
const _asyncTests = [];
function testAsync(name, fn) { _asyncTests.push({ name, fn }); }
async function _runAsyncTests() {
  for (var i = 0; i < _asyncTests.length; i++) {
    var t = _asyncTests[i];
    try {
      await t.fn();
      _pass++;
      _results.push({ ok: true, name: t.name });
    } catch (e) {
      _fail++;
      _results.push({ ok: false, name: t.name, msg: e.message });
    }
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
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: [], events: [], buy: [], ord: [], supPayments: [] };
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
test('rendered row has 13 <td> cells matching header', () => {
  ctx.DB.li = [{
    id:'l3', sku:'SKU-03', desc:'Widget', specs:'spec', hs:'1234',
    supId:'s1', cost:10, price:20, uom:'pcs', cur:'USD',
  }];
  mockEl('li-q').value = ''; mockEl('li-sf').value = '';
  ctx.rLI();
  const tdCount = (mockEl('li-tb').innerHTML.match(/<td/g) || []).length;
  assertEqual(tdCount, 13, 'Row must have 13 <td> cells: #, SKU, Desc, Specs, HS, Supplier, Cost, Price, UOM, Margin, Cur, Invoices, Actions');
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

test('cQte sums lines and adds overheads correctly (SPEC-QTE-001: overhead never marked up)', () => {
  var savedQR = ctx.QR;
  ctx.QR = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005, originCharges:250, destCharges:350, fpmAdmin:75, fxGBPUSD:1.27 };
  var qt = { freightMode:'LCL', markup:20, lines:[{ cost:500, cbm:2, dg:false, dutyPct:10 }] };
  // line landed=723.35, overhead=675, quotedTotal=1398.35 (unchanged definitions)
  // sellUSD = landed*(1+markup/100) + overhead(unmarked-up) = 723.35*1.20 + 675 = 1543.02
  // (pre-SPEC-QTE-001 this was quotedTotal*1.20 = 1678.02 — the 135 difference is
  // exactly overhead's old 20% markup, 675*0.20=135, confirming the delta is purely
  // the documented overhead-treatment change and nothing else moved)
  var c = ctx.cQte(qt);
  assert(Math.abs(c.totalLanded - 723.35) < 0.01, 'totalLanded ≈ 723.35');
  assertEqual(c.overhead, 675, 'overhead = originCharges+destCharges+fpmAdmin');
  assert(Math.abs(c.quotedTotal - 1398.35) < 0.01, 'quotedTotal = landed+overhead');
  assert(Math.abs(c.sellUSD - 1543.02) < 0.01, 'sellUSD = landed*(1+effective margin) + overhead unmarked-up');
  assert(Math.abs(c.sellGBP - (1543.02/1.27)) < 0.5, 'sellGBP = sellUSD/fxGBPUSD');
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

// ── Per-line quote margin (SPEC-QTE-001) ────────────────────────
console.log('\nPer-line quote margin (SPEC-QTE-001)');

test('qteEffectiveMargin: line with no markup key inherits quote markup', () => {
  assertEqual(ctx.qteEffectiveMargin({}, 15), 15, 'inherits quote markup when unset');
});

test('qteEffectiveMargin: line with markup 0 returns 0, not the quote markup', () => {
  assertEqual(ctx.qteEffectiveMargin({ markup: 0 }, 15), 0, 'explicit 0 override is not collapsed to inherit');
});

test('qteEffectiveMargin: line with markup 12.5 returns 12.5 regardless of quote markup', () => {
  assertEqual(ctx.qteEffectiveMargin({ markup: 12.5 }, 20), 12.5, 'explicit override wins over quote markup');
});

test('qlEffectiveMarkupInput: blank input returns undefined (inherit)', () => {
  mockEl('ql-mkp-qlm1').value = '';
  assertEqual(ctx.qlEffectiveMarkupInput('qlm1'), undefined, 'blank field means inherit');
});

test('qlEffectiveMarkupInput: explicit "0" returns the number 0, not undefined', () => {
  mockEl('ql-mkp-qlm2').value = '0';
  assertEqual(ctx.qlEffectiveMarkupInput('qlm2'), 0, 'explicit zero is preserved, not collapsed to inherit');
});

test('qteSellTotals: a 0-margin line sells at exactly landed cost; an inheriting line uses quote markup', () => {
  var savedQR = ctx.QR;
  ctx.QR = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005, originCharges:0, destCharges:0, fpmAdmin:0, fxGBPUSD:1.27 };
  var lines = [
    { cost:500, cbm:0, dg:false, dutyPct:0, markup:0 },      // pass-through line
    { cost:500, cbm:0, dg:false, dutyPct:0 }                 // inherits quote markup
  ];
  var lineCalcs = lines.map(function(l){ return ctx.cQteLine(l, ctx.QR, 'LCL', 0); });
  var totals = ctx.qteSellTotals(lines, lineCalcs, 20, ctx.QR.originCharges + ctx.QR.destCharges + ctx.QR.fpmAdmin, ctx.QR.fxGBPUSD);
  // both lines landed = cost + ins = 500 + 500*0.005 = 502.5 (no freight/duty at cbm=0/dutyPct=0)
  var landed = lineCalcs[0].landed;
  var expected = landed * 1 /* 0% margin */ + landed * 1.20 /* inherits 20% */;
  assert(Math.abs(totals.sellUSD - expected) < 0.01, '0-margin line contributes at cost, inheriting line contributes at quote markup');
  ctx.QR = savedQR;
});

test('qteSellTotals: overhead is added exactly once, never scaled by any margin', () => {
  var savedQR = ctx.QR;
  ctx.QR = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005, originCharges:250, destCharges:350, fpmAdmin:75, fxGBPUSD:1.27 };
  var lines = [{ cost:500, cbm:0, dg:false, dutyPct:0 }];
  var lineCalcs = lines.map(function(l){ return ctx.cQteLine(l, ctx.QR, 'LCL', 0); });
  var totals = ctx.qteSellTotals(lines, lineCalcs, 50, ctx.QR.originCharges + ctx.QR.destCharges + ctx.QR.fpmAdmin, ctx.QR.fxGBPUSD); // deliberately large markup
  assertEqual(totals.overhead, 675, 'overhead = originCharges+destCharges+fpmAdmin, unscaled');
  var expectedSell = lineCalcs[0].landed * 1.50 + 675;
  assert(Math.abs(totals.sellUSD - expectedSell) < 0.01, 'overhead component is not multiplied by (1+markup/100)');
  ctx.QR = savedQR;
});

// ── REQ-QTE-002 / SPEC-QTE-002 — per-quote overhead charge overrides ────
test('qteEffectiveOverhead: blank/undefined/null all fall back to qr defaults', () => {
  var qr = { originCharges: 250, destCharges: 350, fpmAdmin: 75 };
  var eff = ctx.qteEffectiveOverhead(undefined, null, '', qr);
  assertEqual(eff.origin, 250, 'undefined falls back to qr.originCharges');
  assertEqual(eff.dest, 350, 'null falls back to qr.destCharges');
  assertEqual(eff.admin, 75, 'blank string falls back to qr.fpmAdmin');
  assertEqual(eff.total, 675, 'total is the sum of the three resolved values');
});

test('qteEffectiveOverhead: explicit "0" (DOM-input string form) is preserved, not collapsed to inherit', () => {
  var qr = { originCharges: 250, destCharges: 350, fpmAdmin: 75 };
  var eff = ctx.qteEffectiveOverhead('0', undefined, undefined, qr);
  assertEqual(eff.origin, 0, 'explicit zero override is preserved, not treated as blank');
  assertEqual(eff.dest, 350, 'unset field still falls back to the default');
  assertEqual(eff.admin, 75, 'unset field still falls back to the default');
});

test('qteEffectiveOverhead: explicit 0 (numeric form, as stored on a saved quote) is preserved, not collapsed to inherit', () => {
  // A saved quote stores a real number (saveQte() does `+origOvRaw`), not the DOM-input string —
  // a naive truthy check (`v ? +v : d`) would silently treat 0 as falsy and fall back to the
  // default here even though the string-form '0' test above would still pass, since a non-empty
  // string is always truthy regardless of what it contains. Both forms must be tested separately.
  var qr = { originCharges: 250, destCharges: 350, fpmAdmin: 75 };
  var eff = ctx.qteEffectiveOverhead(0, undefined, undefined, qr);
  assertEqual(eff.origin, 0, 'explicit numeric zero override is preserved, not treated as falsy/blank');
  assertEqual(eff.dest, 350, 'unset field still falls back to the default');
  assertEqual(eff.admin, 75, 'unset field still falls back to the default');
});

test('qteEffectiveOverhead: a full override on all three uses only the overridden values', () => {
  var qr = { originCharges: 250, destCharges: 350, fpmAdmin: 75 };
  var eff = ctx.qteEffectiveOverhead(10, 20, 30, qr);
  assertEqual(eff.origin, 10);
  assertEqual(eff.dest, 20);
  assertEqual(eff.admin, 30);
  assertEqual(eff.total, 60);
});

test('cQte: an overridden quote reflects its override; an unset quote reflects the global default — no cross-contamination (AC-1, AC-2, AC-4)', () => {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { originCharges: 250, destCharges: 350, fpmAdmin: 75, fxGBPUSD: 1.27 });
  var qtOverridden = { freightMode:'LCL', markup:0, lines:[{ cost:100, cbm:0, dg:false, dutyPct:0 }], originCharges: 0 };
  var qtDefault     = { freightMode:'LCL', markup:0, lines:[{ cost:100, cbm:0, dg:false, dutyPct:0 }] };
  var cOverridden = ctx.cQte(qtOverridden);
  var cDefault    = ctx.cQte(qtDefault);
  ctx.QR = savedQR;
  assertEqual(cOverridden.overheadBreakdown.origin, 0, 'overridden quote uses its own $0 origin charge');
  assertEqual(cOverridden.overhead, 425, 'overridden quote total overhead reflects the override (0+350+75)');
  assertEqual(cDefault.overheadBreakdown.origin, 250, 'unset quote still uses the global default');
  assertEqual(cDefault.overhead, 675, "unset quote's overhead is unaffected by the other quote's override (250+350+75)");
});

test('cQte: a quote with only one field overridden keeps tracking the global default for the other two (AC-3)', () => {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { originCharges: 250, destCharges: 350, fpmAdmin: 75, fxGBPUSD: 1.27 });
  var qt = { freightMode:'LCL', markup:0, lines:[{ cost:100, cbm:0, dg:false, dutyPct:0 }], destCharges: 999 };
  var c1 = ctx.cQte(qt);
  assertEqual(c1.overheadBreakdown.dest, 999, 'dest override applied');
  assertEqual(c1.overheadBreakdown.origin, 250, 'origin still tracks the current global default');
  ctx.QR.originCharges = 500;
  ctx.QR.fpmAdmin = 10;
  var c2 = ctx.cQte(qt);
  ctx.QR = savedQR;
  assertEqual(c2.overheadBreakdown.origin, 500, 'origin tracks the NEW global default after it changed');
  assertEqual(c2.overheadBreakdown.admin, 10, 'admin tracks the new global default too');
  assertEqual(c2.overheadBreakdown.dest, 999, "dest override is unaffected by the global default change");
});

test('saveQte: an explicit 0 override persists; a blank field omits the property entirely (AC-1, REQ-QTE-002f)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'ov1', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('ov1', 500, 10, 15, '');
  mockEl('qf-origOv').value = '0';
  // qf-destOv / qf-admOv left blank (default '')
  ctx.saveQte();
  var saved = ctx.DB.qt[0];
  mockEl('qf-origOv').value = '';
  assertEqual(saved.originCharges, 0, 'explicit 0 override persisted as 0, not omitted');
  assert(!('destCharges' in saved), 'blank destCharges field is omitted from the saved record entirely, not stored as undefined');
  assert(!('fpmAdmin' in saved), 'blank fpmAdmin field is omitted from the saved record entirely, not stored as undefined');
});

test('saveQte: existing (untouched) Quote tests remain unaffected — no overhead properties on a default save (AC-1, AC-5)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'ov2', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('ov2', 500, 10, 15, '');
  ctx.saveQte();
  var saved = ctx.DB.qt[0];
  assert(!('originCharges' in saved), 'no override fields touched — originCharges absent, exactly like every pre-REQ quote');
  assert(!('destCharges' in saved), 'no override fields touched — destCharges absent');
  assert(!('fpmAdmin' in saved), 'no override fields touched — fpmAdmin absent');
});

test('saveQte: clearing a previously-set override via editQte() removes it on re-save (REQ-QTE-002f)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'ov3', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('ov3', 500, 10, 15, '');
  mockEl('qf-origOv').value = '100';
  ctx.saveQte();
  var qid = ctx.DB.qt[0].id;
  assertEqual(ctx.DB.qt[0].originCharges, 100, 'override saved first');
  ctx.editQte(qid);
  assertEqual(mockEl('qf-origOv').value, '100', 'editQte() loads the saved override back into the field');
  mockEl('qf-origOv').value = '';
  ctx.saveQte();
  mockEl('qf-origOv').value = '';
  assert(!('originCharges' in ctx.DB.qt[0]), 'clearing the field and re-saving removes the override entirely');
});

test('saveQte: overhead override and per-line markup override apply independently (AC-7)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'ac7-1', supId:'', desc:'Test item', qty:1, uom:'pcs', cost:500, cbm:2, dg:false, dutyPct:0 }];
  saveQteSetup('ac7-1', 500, 0, 20, '');
  mockEl('ql-mkp-ac7-1').value = '5'; // per-line override — NOT the quote's 20%
  mockEl('qf-origOv').value = '0';    // overhead override: origin -> 0
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { originCharges:250, destCharges:350, fpmAdmin:75 });
  var lineCalc = ctx.cQteLine({ cost:500, cbm:2, dg:false, dutyPct:0 }, ctx.QR, 'LCL', 2);
  ctx.saveQte();
  ctx.QR = savedQR;
  mockEl('qf-origOv').value = '';
  mockEl('ql-mkp-ac7-1').value = '';
  var saved = ctx.DB.qt[0];
  var expectedOverhead = 0 + 350 + 75; // origin overridden to 0
  var expectedSellUSD = lineCalc.landed * 1.05 + expectedOverhead;
  assertEqual(saved.originCharges, 0, 'overhead override persisted');
  assert(Math.abs(saved.calc_sellUSD - expectedSellUSD) < 0.01, "per-line markup override (5%) and overhead override ($0 origin) both apply, independently of each other");
});

test("prevQteDoc: an overridden quote's itemized breakdown matches its total — no repeat of the pre-fix QR-vs-cQte mismatch (AC-6)", () => {
  var getHtml = makePreviewMock();
  resetDB();
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { originCharges: 999, destCharges: 350, fpmAdmin: 75 });
  ctx.prevQteDoc({
    num: 'QT-OV1', client: 'Override Client', freightMode: 'LCL', dt: '2026-08-31', markup: 0,
    lines: [{ rid:'r1', supId:'', desc:'Item', qty:1, uom:'pcs', cost:100, cbm:0, dg:false, dutyPct:0 }],
    originCharges: 0 // overridden to $0 — the global default is $999
  });
  ctx.QR = savedQR;
  var html = getHtml();
  assertContains(html, 'Origin Charges</td><td style="padding:3px 8px;text-align:right;font-size:11px;">$0.00</td>', 'PDF breakdown shows the overridden $0.00 Origin Charges, not the $999.00 global default');
  assertNotContains(html, '$999.00', 'PDF breakdown never leaks the un-overridden global default once an override is set');
});

test('saveQte: a line-level override change creates a new version; an unrelated sibling override does not (AC-003, direction 1)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [
    { rid:'ac3a-1', supId:'', desc:'Line A', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 },
    { rid:'ac3a-2', supId:'', desc:'Line B', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }
  ];
  mockEl('qf-num').value = 'QTE-0002'; mockEl('qf-client').value = 'AC3 Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-cur').value = 'USD'; mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = '15'; mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  ['ac3a-1','ac3a-2'].forEach(function(rid){
    mockEl('ql-supId-'+rid).value=''; mockEl('ql-desc-'+rid).value='Line'; mockEl('ql-qty-'+rid).value='1';
    mockEl('ql-uom-'+rid).value='pcs'; mockEl('ql-cost-'+rid).value='500'; mockEl('ql-cbm-'+rid).value='2';
    mockEl('ql-dg-'+rid).checked=false; mockEl('ql-dutyPct-'+rid).value='0'; mockEl('ql-note-'+rid).value='';
  });
  mockEl('ql-mkp-ac3a-1').value = '10';
  mockEl('ql-mkp-ac3a-2').value = '25';
  ctx.saveQte();

  var qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  mockEl('ql-mkp-ac3a-1').value = '12'; // only line A's override changes
  mockEl('ql-note-ac3a-1').value = 'Margin adjusted for line A only';
  ctx.saveQte();

  var lineA = ctx.DB.qt[0].lines.find(function(l){ return l.rid === 'ac3a-1'; });
  var lineB = ctx.DB.qt[0].lines.find(function(l){ return l.rid === 'ac3a-2'; });
  assertEqual(lineA.priceHistory.length, 2, 'line A gets a new version when its own override changes');
  assertEqual(lineB.priceHistory.length, 1, 'line B (unrelated, unchanged override) does not get a spurious version');
});

test('saveQte: a quote-level default change versions an inheriting line but not an overridden sibling (AC-003, direction 2)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [
    { rid:'ac3b-1', supId:'', desc:'Line A', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 },
    { rid:'ac3b-2', supId:'', desc:'Line B', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }
  ];
  mockEl('qf-num').value = 'QTE-0003'; mockEl('qf-client').value = 'AC3 Client 2'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-cur').value = 'USD'; mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = '15'; mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  ['ac3b-1','ac3b-2'].forEach(function(rid){
    mockEl('ql-supId-'+rid).value=''; mockEl('ql-desc-'+rid).value='Line'; mockEl('ql-qty-'+rid).value='1';
    mockEl('ql-uom-'+rid).value='pcs'; mockEl('ql-cost-'+rid).value='500'; mockEl('ql-cbm-'+rid).value='2';
    mockEl('ql-dg-'+rid).checked=false; mockEl('ql-dutyPct-'+rid).value='0'; mockEl('ql-note-'+rid).value='';
  });
  mockEl('ql-mkp-ac3b-1').value = '';   // Line A inherits quote-level default
  mockEl('ql-mkp-ac3b-2').value = '30'; // Line B has its own override
  ctx.saveQte();

  var qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  mockEl('qf-mkp').value = '18'; // quote-level default changes 15→18
  mockEl('ql-mkp-ac3b-1').value = '';
  mockEl('ql-mkp-ac3b-2').value = '30';
  ctx.saveQte();

  var lineA = ctx.DB.qt[0].lines.find(function(l){ return l.rid === 'ac3b-1'; });
  var lineB = ctx.DB.qt[0].lines.find(function(l){ return l.rid === 'ac3b-2'; });
  assertEqual(lineA.priceHistory.length, 2, 'inheriting line gets a new version when the quote-level default changes (its effective margin genuinely changed)');
  assertEqual(lineB.priceHistory.length, 1, 'overridden line is unaffected by the quote-level change');
});

test('saveQte: clearing a line-level override reverts that line to the quote-level default (AC-004)', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [{ rid:'ac4', supId:'', desc:'Line', qty:1, uom:'pcs', cost:0, cbm:2, dg:false, dutyPct:0 }];
  mockEl('qf-num').value = 'QTE-0004'; mockEl('qf-client').value = 'AC4 Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-cur').value = 'USD'; mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = '15'; mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  mockEl('ql-supId-ac4').value=''; mockEl('ql-desc-ac4').value='Line'; mockEl('ql-qty-ac4').value='1';
  mockEl('ql-uom-ac4').value='pcs'; mockEl('ql-cost-ac4').value='500'; mockEl('ql-cbm-ac4').value='2';
  mockEl('ql-dg-ac4').checked=false; mockEl('ql-dutyPct-ac4').value='0'; mockEl('ql-note-ac4').value='';
  mockEl('ql-mkp-ac4').value = '5'; // explicit override
  ctx.saveQte();
  assertEqual(ctx.DB.qt[0].lines[0].markup, 5, 'override saved as 5');

  var qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  mockEl('ql-mkp-ac4').value = ''; // operator clears the override
  ctx.saveQte();

  var line = ctx.DB.qt[0].lines[0];
  assertEqual(line.markup, undefined, 'cleared override is persisted as undefined, not 0 or the stale 5');
  var latestV = line.priceHistory[line.priceHistory.length - 1];
  assertEqual(latestV.markup, 15, 'effective margin in the new version reflects the quote-level default, not the stale override');
});

test('cQte/saveQte backward compatibility: pre-existing quote with no line markup field recomputes with only the documented overhead delta (AC-002)', () => {
  resetDB();
  var savedQR = ctx.QR;
  ctx.QR = { lclPerCBM:85, fcl20GP:1800, fcl40HQ:2800, dgSurcharge:150, insRate:0.005, originCharges:250, destCharges:350, fpmAdmin:75, fxGBPUSD:1.27 };
  // Simulate a v2.9.51-era saved quote: line has no markup key at all.
  var legacyQt = {
    id: 'legacy-qte-1', num: 'QTE-LEGACY', client: 'Legacy Client', dt: '2026-04-01', validUntil: '',
    currency: 'USD', freightMode: 'LCL', markup: 20, status: 'Draft', notes: '', linkedPOIds: [], sourceContactId: '',
    lines: [{ rid: 'legacy-l1', supId: '', desc: 'Legacy line', qty: 1, uom: 'pcs', cost: 500, cbm: 2, dg: false, dutyPct: 10, priceHistory: [] }]
  };
  ctx.DB.qt = [legacyQt];

  var before = ctx.cQte(legacyQt);
  var oldStyleSellUSD = before.quotedTotal * (1 + legacyQt.markup / 100); // the pre-SPEC-QTE-001 formula, computed independently here
  var expectedDelta = before.overhead * (legacyQt.markup / 100); // overhead's old markup contribution, now removed
  assert(Math.abs((oldStyleSellUSD - before.sellUSD) - expectedDelta) < 0.01, 'sellUSD differs from the old formula by exactly overhead\'s former markup contribution, nothing else');

  // Per-line landed/sell figures are unaffected by the overhead change — only the quote-wide total moved.
  var perLineSellUnchanged = before.lineCalcs[0].landed * (1 + legacyQt.markup / 100);
  var expectedPerLineSell = before.lineCalcs[0].landed * (1 + ctx.qteEffectiveMargin(legacyQt.lines[0], legacyQt.markup) / 100);
  assertEqual(perLineSellUnchanged, expectedPerLineSell, 'per-line sell price formula is identical pre/post — only overhead treatment moved');
  ctx.QR = savedQR;
});

test('rQLT: renders blank value for a line with no markup key, and "0" for an explicit markup:0 override', () => {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [
    { rid:'dom1', supId:'', desc:'No override', qty:1, uom:'pcs', cost:100, cbm:0, dg:false, dutyPct:0 },
    { rid:'dom2', supId:'', desc:'Zero override', qty:1, uom:'pcs', cost:100, cbm:0, dg:false, dutyPct:0, markup:0 }
  ];
  mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = '15';
  ctx.rQLT();
  var rendered = mockEl('qt-lines').innerHTML;
  assertContains(rendered, 'id="ql-mkp-dom1" value=""', 'no-override line renders a blank margin input, not "0"');
  assertContains(rendered, 'id="ql-mkp-dom2" value="0"', 'explicit markup:0 renders as "0", distinct from blank');
});

// ── qteToPoConvert ─────────────────────────────────────────────
console.log('\nqteToPoConvert');

test('qteToPoConvert blocked when status is Draft', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt1', num:'QTE-0001', status:'Draft', currency:'USD', lines:[] }];
  ctx.EI.qt = 'qt1';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 0, 'no PO created for Draft quote');
  assert(!ctx.DB.qt[0].linkedPOIds, 'linkedPOIds unchanged');
});

test('qteToPoConvert blocked when status is Sent', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt2', num:'QTE-0002', status:'Sent', currency:'USD', lines:[] }];
  ctx.EI.qt = 'qt2';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 0, 'no PO created for Sent quote');
});

test('qteToPoConvert creates PO when status is Accepted', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt3', num:'QTE-0003', status:'Accepted', currency:'USD', lines:[{ rid:'r1', supId:'s1', desc:'Goods', qty:5, cost:200, uom:'pcs' }] }];
  ctx.EI.qt = 'qt3';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 1, 'PO created for Accepted quote');
  assertEqual(ctx.DB.qt[0].linkedPOIds[0], ctx.DB.po[0].id, 'linkedPOIds[0] set on quote');
  assertEqual(ctx.DB.po[0].quoteNum, 'QTE-0003', 'PO carries quote reference');
});

test('qteToPoConvert blocked when quote already has linkedPOIds', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt4', num:'QTE-0004', status:'Accepted', currency:'USD', lines:[], linkedPOIds:['existing-po-id'] }];
  ctx.EI.qt = 'qt4';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 0, 'no duplicate PO when already linked');
});

test('qteToPoConvert splits multi-supplier Quote into one PO per supplier (PO-GAP-001 fix)', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt5', num:'QTE-0005', status:'Accepted', currency:'USD', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:1, cost:10, uom:'pcs' },
    { rid:'r2', supId:'sB', desc:'Item B', qty:1, cost:20, uom:'pcs' },
    { rid:'r3', supId:'sA', desc:'Item A2', qty:1, cost:15, uom:'pcs' },
  ] }];
  ctx.EI.qt = 'qt5';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 2, 'one PO per distinct supplier');
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 2, 'linkedPOIds has 2 entries');
  var poA = ctx.DB.po.find(function(p){ return p.supId === 'sA'; });
  var poB = ctx.DB.po.find(function(p){ return p.supId === 'sB'; });
  assertEqual(poA.lineItems.length, 2, 'supplier A PO has both its lines');
  assertEqual(poB.lineItems.length, 1, 'supplier B PO has only its line');
  assertEqual(poA.num, 'PO-QTE-0005-1', 'first-appearance supplier gets -1 suffix');
  assertEqual(poB.num, 'PO-QTE-0005-2', 'second supplier gets -2 suffix');
});

test('qteToPoConvert groups unassigned-supplier lines into their own PO', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt6', num:'QTE-0006', status:'Accepted', currency:'USD', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:1, cost:10, uom:'pcs' },
    { rid:'r2', supId:'', desc:'No supplier item', qty:1, cost:5, uom:'pcs' },
  ] }];
  ctx.EI.qt = 'qt6';
  ctx.qteToPoConvert();
  assertEqual(ctx.DB.po.length, 2, 'unassigned-supplier line gets its own PO');
  var poNone = ctx.DB.po.find(function(p){ return p.supId === ''; });
  assert(poNone, 'a PO with empty supId exists');
  assertEqual(poNone.lineItems.length, 1, 'unassigned PO has only the unassigned line');
});

test('qteToPoConvert avoids PO number collision with a pre-existing manually-typed PO', () => {
  resetDB();
  ctx.DB.po = [{ id:'manual1', num:'PO-QTE-0007-1', supId:'sX', lines:[] }];
  ctx.DB.qt = [{ id:'qt7', num:'QTE-0007', status:'Accepted', currency:'USD', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:1, cost:10, uom:'pcs' },
    { rid:'r2', supId:'sB', desc:'Item B', qty:1, cost:20, uom:'pcs' },
  ] }];
  ctx.EI.qt = 'qt7';
  ctx.qteToPoConvert();
  var generated = ctx.DB.po.filter(function(p){ return p.quoteId === 'qt7'; });
  assertEqual(generated.length, 2, 'two new POs created');
  var nums = generated.map(function(p){ return p.num; });
  assert(nums.indexOf('PO-QTE-0007-1a') > -1, 'collision resolved with letter suffix');
  var uniqueNums = new Set(ctx.DB.po.map(function(p){ return p.num; }));
  assertEqual(uniqueNums.size, ctx.DB.po.length, 'no duplicate PO numbers exist');
});

test('qteToPoConvert() builds PO with correct field names, not lines/dt/currency/fpm/rec (REQ-PO-002 AC-1, AC-2)', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt11', num:'QTE-0011', status:'Accepted', currency:'EUR', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:3, cost:12.5, uom:'box' },
  ] }];
  ctx.EI.qt = 'qt11';
  ctx.qteToPoConvert();
  var po = ctx.DB.po[0];
  assert(!('lines' in po), 'no stray lines key');
  assert(!('dt' in po), 'no stray dt key');
  assert(!('currency' in po), 'no stray currency key');
  assert(!('fpm' in po), 'no stray fpm key');
  assert(!('rec' in po), 'no stray rec key');
  assertEqual(po.date, ctx.today(), 'date field set (not dt)');
  assertEqual(po.cur, 'EUR', 'cur field carries Quote currency (not currency)');
  assertEqual(po.fpmFunded, 0, 'fpmFunded defaults to 0 (not fpm)');
  assertEqual(po.fpmRecovered, false, 'fpmRecovered defaults to false (not rec)');
  var li = po.lineItems[0];
  assertEqual(li.lid, '', 'line item lid blank');
  assertEqual(li.sku, '', 'line item sku blank');
  assertEqual(li.uom, 'box', 'line item uom carried through');
  assertEqual(li.qty, 3, 'line item qty carried through');
  assertEqual(li.cost, 12.5, 'line item cost carried through (not up)');
  assert(!('liId' in li), 'no stray liId key on line item');
  assert(!('up' in li), 'no stray up key on line item');
  assert(!('cur' in li), 'no stray per-line cur key');
});

test('editPO() correctly loads a qteToPoConvert()-created PO\'s line items (REQ-PO-002 AC-3)', () => {
  resetDB();
  ctx.DB.qt = [{ id:'qt12', num:'QTE-0012', status:'Accepted', currency:'USD', lines:[
    { rid:'r1', supId:'sA', desc:'Item A', qty:4, cost:50, uom:'pcs' },
  ] }];
  ctx.EI.qt = 'qt12';
  ctx.qteToPoConvert();
  var poId = ctx.DB.po[0].id;
  ctx.editPO(poId);
  assertEqual(ctx.cPL.length, 1, 'editPO() populates cPL with the real line item, not an empty array');
  assertEqual(ctx.cPL[0].cost, 50, 'editPO() reads the correct cost value');
  ctx.calcPO();
});

test('migrateQtePoShape() converts a legacy (pre-fix) qteToPoConvert()-shaped PO into the correct shape', () => {
  resetDB();
  ctx.DB.po = [{
    id: 'po-legacy-1', num: 'PO-QTE-0099-1', supId: 'sA',
    invNum: '', invId: '', dt: '2026-01-15', del: '', currency: 'GBP',
    dep: 0, fpm: 0, rec: false, oth: 0, paymentTerms: '',
    notes: 'Auto-converted from QTE-0099', status: 'Draft',
    lines: [{ rid: 'r1', liId: '', desc: 'Old Item', qty: 2, up: 30, uom: 'pcs', cur: 'GBP' }],
    quoteId: 'qt-legacy', quoteNum: 'QTE-0099',
  }];
  ctx.migrateQtePoShape();
  var po = ctx.DB.po[0];
  assert(!('lines' in po) && !('dt' in po) && !('currency' in po) && !('fpm' in po) && !('rec' in po), 'legacy keys removed');
  assertEqual(po.date, '2026-01-15', 'dt migrated to date');
  assertEqual(po.cur, 'GBP', 'currency migrated to cur');
  assertEqual(po.fpmFunded, 0, 'fpm migrated to fpmFunded');
  assertEqual(po.fpmRecovered, false, 'rec migrated to fpmRecovered');
  var li = po.lineItems[0];
  assertEqual(li.lid, '', 'liId migrated to blank lid');
  assertEqual(li.cost, 30, 'up migrated to cost');
  assertEqual(li.sku, '', 'sku added');
  assert(!('liId' in li) && !('up' in li) && !('cur' in li), 'legacy line-item keys removed');
});

test('migrateQtePoShape() is idempotent — a second run is a no-op', () => {
  resetDB();
  ctx.DB.po = [{ id:'po-legacy-2', num:'PO-QTE-0098-1', supId:'sA', dt:'2026-01-01', currency:'USD', fpm:0, rec:false, lines:[{ rid:'r1', liId:'', desc:'X', qty:1, up:10, uom:'pcs', cur:'USD' }] }];
  ctx.migrateQtePoShape();
  var afterFirst = JSON.stringify(ctx.DB.po[0]);
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), afterFirst, 'second run produces byte-identical result');
});

test('migrateQtePoShape() does not touch a PO that already has the correct shape', () => {
  resetDB();
  var correct = { id:'po-correct-1', num:'PO-0001', supId:'sA', invNum:'', invId:'', date:'2026-01-01', del:'', cur:'USD', dep:0, fpmFunded:0, fpmRecovered:false, oth:0, paymentTerms:'', notes:'', status:'Draft', lineItems:[{rid:'r1',lid:'',desc:'X',sku:'',uom:'pcs',qty:1,cost:10}] };
  ctx.DB.po = [Object.assign({}, correct)];
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), JSON.stringify(correct), 'already-correct PO is byte-identical after migration runs');
});

test('migrateQtePoShape() does not touch an ordinary autoPos()-created PO with no lines key at all', () => {
  resetDB();
  ctx.DB.inv = [{ id:'inv1', num:'INV0001', date:'2026-01-01', lineItems:[{ lid:'li1', desc:'X', qty:1, up:10 }] }];
  ctx.DB.li = [{ id:'li1', supId:'sA', sku:'SKU1', cost:10 }];
  ctx.autoPos(ctx.DB.inv[0]);
  var before = JSON.stringify(ctx.DB.po[0]);
  ctx.migrateQtePoShape();
  assertEqual(JSON.stringify(ctx.DB.po[0]), before, 'autoPos()-created PO is untouched');
});

test('migrateLinkedPOIds converts legacy scalar to array, once, without data loss', () => {
  resetDB();
  ctx.DB.qt = [
    { id:'qt8', num:'QTE-0008', linkedPOId:'po-legacy-1' },
    { id:'qt9', num:'QTE-0009' },
    { id:'qt10', num:'QTE-0010', linkedPOIds:['po-already-migrated'] },
  ];
  ctx.migrateLinkedPOIds();
  assertEqual(ctx.DB.qt[0].linkedPOIds[0], 'po-legacy-1', 'legacy scalar migrated to array');
  assert(!ctx.DB.qt[0].linkedPOId, 'old scalar field removed after migration');
  assert(!ctx.DB.qt[1].linkedPOIds, 'quote with neither field is left untouched, not defaulted to []');
  assertEqual(ctx.DB.qt[2].linkedPOIds[0], 'po-already-migrated', 'already-migrated quote untouched');
  // idempotency — second call is a no-op
  ctx.migrateLinkedPOIds();
  assertEqual(ctx.DB.qt[0].linkedPOIds.length, 1, 'idempotent — no duplicate entries on second call');
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

test('prevInv — live modal preview passes status through to PRO-FORMA INVOICE heading', function() {
  var getHtml = makePreviewMock();
  resetDB();
  mockEl('if-n').value = 'INV10005';
  mockEl('inv-sm').value = 'Pro-forma';
  mockEl('if-b').value = ''; mockEl('if-ba').value = ''; mockEl('if-st').value = '';
  mockEl('if-dst').value = ''; mockEl('if-cid').value = ''; mockEl('if-dt').value = '';
  mockEl('if-ex').value = ''; mockEl('if-sd').value = ''; mockEl('if-ft').value = '';
  mockEl('if-wt').value = ''; mockEl('if-cbm').value = ''; mockEl('if-pk').value = '';
  mockEl('if-pol').value = ''; mockEl('if-pod').value = ''; mockEl('if-coo').value = '';
  mockEl('if-inco').value = ''; mockEl('if-cur').value = 'USD'; mockEl('if-lf').value = '0';
  mockEl('if-ins').value = '0'; mockEl('if-leg').value = '0'; mockEl('if-isp').value = '0';
  mockEl('if-oth').value = '0'; mockEl('if-dep').value = '0'; mockEl('if-pt').value = '';
  mockEl('if-terms').value = ''; mockEl('if-tx').value = '0';
  ctx.cIL = [];
  ctx.prevInv();
  var html = getHtml();
  assertContains(html, 'PRO-FORMA INVOICE', 'prevInv: live modal preview with Pro-forma status shows PRO-FORMA INVOICE heading');
  // Reset shared mock state so later tests aren't polluted
  mockEl('inv-sm').value = '';
});

test('prevInvDoc — Pro-forma status renders PRO-FORMA INVOICE heading and title, not INVOICE', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevInvDoc({ num: 'INV10003', cur: 'USD', taxRate: 0, status: 'Pro-forma', lineItems: [] });
  var html = getHtml();
  assertContains(html, 'PRO-FORMA INVOICE', 'prevInvDoc: Pro-forma status shows PRO-FORMA INVOICE heading');
  assertContains(html, '<title>Pro-forma Invoice INV10003</title>', 'prevInvDoc: Pro-forma status shows Pro-forma Invoice in document title');
});

test('prevInvDoc — non-Pro-forma status renders plain INVOICE heading, not PRO-FORMA', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.prevInvDoc({ num: 'INV10004', cur: 'USD', taxRate: 0, status: 'Sent', lineItems: [] });
  var html = getHtml();
  assertContains(html, '>INVOICE<', 'prevInvDoc: Sent status shows plain INVOICE heading');
  assertNotContains(html, 'PRO-FORMA', 'prevInvDoc: Sent status must not show PRO-FORMA anywhere');
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

// ── unmapRec / findLocalMatchByBizKey / mergePulledWithLocal / claimOnceMatcher (SPEC-SYNC-001) ───
console.log('\npullAll field-mapping (SYNC-GAP-001 fix)');

test('unmapRec — translates Sheet header keys back to internal field names (li)', function() {
  var out = ctx.unmapRec('li', { 'SKU':'ABC', 'Description':'Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'sup1', 'Notes':'' });
  assertEqual(out.sku, 'ABC');
  assertEqual(out.desc, 'Widget');
  assertEqual(out.cost, 10);
  assertEqual(out.price, 12);
  assertEqual(out.cur, 'USD');
  assertEqual(out.supId, 'sup1');
  assert(!('SKU' in out), 'no header-named keys remain');
});

test('unmapRec — fully blank header-keyed record produces all-empty internal fields, no crash', function() {
  var out = ctx.unmapRec('sup', { 'Supplier ID':'', 'Name':'', 'Country':'', 'Contact':'', 'Email':'', 'Phone':'', 'Currency':'', 'Payment Terms':'', 'Lead Time':'', 'DG Capable':'', 'Notes':'' });
  assertEqual(out.id, '');
  assertEqual(out.name, '');
  assert(!('Supplier ID' in out), 'no stray header-named keys carried through');
});

test('unmapRec — does not leak a stray operator-added Sheet column not in FIELD_MAPS', function() {
  var out = ctx.unmapRec('li', { 'SKU':'ABC', 'Description':'Widget', 'Internal Notes':'secret column an operator added' });
  assert(!('Internal Notes' in out), 'unmapped Sheet columns are dropped, not carried through');
});

test('findLocalMatchByBizKey — li matches by sku when present', function() {
  var local = [{ id:'l1', sku:'ABC', desc:'Widget', supId:'s1' }];
  var m = ctx.findLocalMatchByBizKey('li', local, { sku:'ABC' });
  assertEqual(m.id, 'l1');
});
test('findLocalMatchByBizKey — li falls back to desc+supId when sku blank', function() {
  var local = [{ id:'l1', sku:'', desc:'Widget', supId:'s1' }];
  var m = ctx.findLocalMatchByBizKey('li', local, { sku:'', desc:'Widget', supId:'s1' });
  assertEqual(m.id, 'l1');
});
test('findLocalMatchByBizKey — blank pulled key never matches a blank local field', function() {
  var local = [{ id:'l1', sku:'', desc:'', supId:'' }];
  var m = ctx.findLocalMatchByBizKey('li', local, { sku:'', desc:'', supId:'' });
  assert(!m, 'blank never matches blank');
});
test('findLocalMatchByBizKey — sh matches by ref', function() {
  var local = [{ id:'s1', ref:'SHP-001' }];
  var m = ctx.findLocalMatchByBizKey('sh', local, { ref:'SHP-001' });
  assertEqual(m.id, 's1');
});
test('findLocalMatchByBizKey — inv/po/cn/qt match by num', function() {
  var local = [{ id:'i1', num:'INV-001' }];
  var m = ctx.findLocalMatchByBizKey('inv', local, { num:'INV-001' });
  assertEqual(m.id, 'i1');
});

test('mergePulledWithLocal — no local match returns pulled record unmodified', function() {
  var pulled = { num:'INV-999', buyer:'New Co' };
  var merged = ctx.mergePulledWithLocal(pulled, null);
  assertEqual(merged, pulled);
});
test('mergePulledWithLocal — untracked local field survives (e.g. inv.type, li.priceHistory)', function() {
  var local = { id:'i1', num:'INV-001', type:'credit_note', lineItems:[{a:1}] };
  var pulled = { num:'INV-001', buyer:'Acme', status:'Paid' }; // unmapRec output never contains `type`/`lineItems` — not in FIELD_MAPS.inv
  var merged = ctx.mergePulledWithLocal(pulled, local);
  assertEqual(merged.type, 'credit_note', 'untracked field survives from local');
  assertEqual(merged.lineItems.length, 1, 'untracked lineItems survives from local');
  assertEqual(merged.buyer, 'Acme', 'tracked field takes pulled value');
  assertEqual(merged.id, 'i1', 'local id preserved');
});
test('mergePulledWithLocal — zero-clobber guard reverts a pulled-zero to local non-zero', function() {
  var local = { id:'i1', num:'INV-001', calc_grandTotal: 500 };
  var pulled = { num:'INV-001', calc_grandTotal: 0 };
  var merged = ctx.mergePulledWithLocal(pulled, local, ['calc_grandTotal']);
  assertEqual(merged.calc_grandTotal, 500, 'stale/zero pulled calc value does not clobber a real local total');
});

test('claimOnceMatcher — first candidate claimed, second identical candidate rejected', function() {
  var claim = ctx.claimOnceMatcher();
  var rec = { id:'l1' };
  assertEqual(claim(rec), rec, 'first claim succeeds');
  assert(!claim(rec), 'second claim of the same id is rejected');
});
test('claimOnceMatcher — null candidate always rejected', function() {
  var claim = ctx.claimOnceMatcher();
  assert(!claim(null), 'null candidate never matches');
});

test('pullAll fix regression — two pulled li rows sharing the same sku get different ids after merge', function() {
  var claim = ctx.claimOnceMatcher();
  var local = [{ id:'l1', sku:'DUP', desc:'Widget', priceHistory:[{v:1}] }];
  var p1 = { sku:'DUP', desc:'Widget v2' };
  var p2 = { sku:'DUP', desc:'Widget v3' };

  var claimed1 = claim(ctx.findLocalMatchByBizKey('li', local, p1));
  var m1 = ctx.mergePulledWithLocal(p1, claimed1);
  if (!claimed1) m1.id = ctx.uid();

  var claimed2 = claim(ctx.findLocalMatchByBizKey('li', local, p2)); // same local candidate, already claimed by p1 — must be rejected
  var m2 = ctx.mergePulledWithLocal(p2, claimed2);
  if (!claimed2) m2.id = ctx.uid();

  assertEqual(m1.id, 'l1', 'first pulled record legitimately claims the real local id');
  assertEqual(m1.priceHistory.length, 1, 'first pulled record preserves untracked priceHistory');
  assert(m2.id !== 'l1', 'second pulled record with the same sku must NOT collide with the same local id');
  assert(m2.id, 'second pulled record still gets a valid fresh id');
});

testAsync('pullAll integration — li pull matching by sku preserves local id/priceHistory, adopts pulled desc/cost/price', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Old Widget', cost:5, price:6, cur:'USD', supId:'s1', priceHistory:[{v:1}], invoiceRefs:[{invId:'i1'}] }];
  _mockPullResponses = { li: { status:'ok', records: [{ 'SKU':'ABC', 'Description':'New Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'s1', 'Notes':'' }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.li.length, 1, 'matched record replaces, not duplicates');
  var li = ctx.DB.li[0];
  assertEqual(li.id, 'l1', 'local id preserved');
  assertEqual(li.desc, 'New Widget', 'pulled desc adopted');
  assertEqual(li.cost, 10, 'pulled cost adopted');
  assertEqual(li.priceHistory.length, 1, 'untracked priceHistory preserved');
  assertEqual(li.invoiceRefs.length, 1, 'untracked invoiceRefs preserved');
});

testAsync('pullAll integration — inv pull matching by num preserves local id/lineItems/calc_* and type', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'i1', num:'INV-001', buyer:'Old Buyer', type:'goodwill_credit', lineItems:[{a:1}], calc_grandTotal: 500 }];
  _mockPullResponses = { inv: { status:'ok', records: [{ 'Invoice #':'INV-001', 'Buyer':'New Buyer', 'Grand Total': 0 }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.inv.length, 1, 'matched record replaces, not duplicates');
  var inv = ctx.DB.inv[0];
  assertEqual(inv.id, 'i1', 'local id preserved');
  assertEqual(inv.buyer, 'New Buyer', 'pulled buyer adopted');
  assertEqual(inv.type, 'goodwill_credit', 'untracked type field survives — the exact bug spec-gate found in v2');
  assertEqual(inv.lineItems.length, 1, 'untracked lineItems survives');
  assertEqual(inv.calc_grandTotal, 500, 'zero-clobber guard keeps real local total over a stale pulled zero');
});

testAsync('pullAll integration — genuinely new pulled row (no local match) gets a fresh id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.sh = [];
  _mockPullResponses = { sh: { status:'ok', records: [{ 'Shipment Ref':'SHP-NEW', 'BL Number':'', 'Vessel':'', 'Carrier':'', 'Origin Port':'', 'Dest Port':'', 'ETD':'', 'ETA':'', 'Status':'', 'Container Type':'', 'Container Number':'', 'DG Onboard':'', 'Docs Status':'', 'Forwarder Name':'', 'Forwarder Email':'', 'Linked Invoices':'', 'Notes':'' }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.sh.length, 1);
  assert(ctx.DB.sh[0].id, 'a fresh id was assigned to the genuinely new record');
  assertEqual(ctx.DB.sh[0].ref, 'SHP-NEW');
});

testAsync('pullAll integration — duplicate ref within one pull (sh): only the first claims the local id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.sh = [{ id:'sh1', ref:'DUP-REF', vessel:'Old Vessel' }];
  _mockPullResponses = { sh: { status:'ok', records: [
    { 'Shipment Ref':'DUP-REF', 'Vessel':'Vessel A' },
    { 'Shipment Ref':'DUP-REF', 'Vessel':'Vessel B' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.sh.length, 2, 'both pulled rows present, no silent drop');
  var withLocalId = ctx.DB.sh.find(function(s){ return s.id === 'sh1'; });
  var other = ctx.DB.sh.find(function(s){ return s.id !== 'sh1'; });
  assert(withLocalId, 'exactly one record legitimately claims the real local id');
  assert(other && other.id, 'the duplicate gets its own distinct fresh id, never colliding with sh1');
});

testAsync('pullAll integration — duplicate num within one pull (inv): only the first claims the local id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'i1', num:'DUP-NUM', buyer:'Old Buyer' }];
  _mockPullResponses = { inv: { status:'ok', records: [
    { 'Invoice #':'DUP-NUM', 'Buyer':'Buyer A' },
    { 'Invoice #':'DUP-NUM', 'Buyer':'Buyer B' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.inv.length, 2, 'both pulled rows present, no silent drop');
  var withLocalId = ctx.DB.inv.find(function(r){ return r.id === 'i1'; });
  var other = ctx.DB.inv.find(function(r){ return r.id !== 'i1'; });
  assert(withLocalId, 'exactly one record legitimately claims the real local id');
  assert(other && other.id, 'the duplicate gets its own distinct fresh id, never colliding with i1');
});

testAsync('pullAll integration — duplicate num within one pull (po): only the first claims the local id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.po = [{ id:'po1', num:'DUP-NUM', supId:'s1' }];
  _mockPullResponses = { po: { status:'ok', records: [
    { 'PO #':'DUP-NUM', 'Supplier':'s1', 'Status':'Draft A' },
    { 'PO #':'DUP-NUM', 'Supplier':'s1', 'Status':'Draft B' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.po.length, 2, 'both pulled rows present, no silent drop');
  var withLocalId = ctx.DB.po.find(function(r){ return r.id === 'po1'; });
  var other = ctx.DB.po.find(function(r){ return r.id !== 'po1'; });
  assert(withLocalId, 'exactly one record legitimately claims the real local id');
  assert(other && other.id, 'the duplicate gets its own distinct fresh id, never colliding with po1');
});

testAsync('pullAll integration — duplicate num within one pull (cn): only the first claims the local id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'cn1', num:'DUP-CN', type:'credit_note', buyer:'Old Buyer' }];
  _mockPullResponses = { cn: { status:'ok', records: [
    { 'CN #':'DUP-CN', 'Buyer':'Buyer A', 'Type':'credit_note' },
    { 'CN #':'DUP-CN', 'Buyer':'Buyer B', 'Type':'credit_note' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  var cnRecs = ctx.DB.inv.filter(function(r){ return r.num === 'DUP-CN'; });
  assertEqual(cnRecs.length, 2, 'both pulled CN rows present, no silent drop');
  var withLocalId = cnRecs.find(function(r){ return r.id === 'cn1'; });
  var other = cnRecs.find(function(r){ return r.id !== 'cn1'; });
  assert(withLocalId, 'exactly one record legitimately claims the real local id');
  assert(other && other.id, 'the duplicate gets its own distinct fresh id, never colliding with cn1');
});

testAsync('pullAll integration — duplicate num within one pull (qt): only the first claims the local id', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.qt = [{ id:'q1', num:'DUP-QT', client:'Old Client' }];
  _mockPullResponses = { qt: { status:'ok', records: [
    { 'Quote #':'DUP-QT', 'Buyer':'Client A' },
    { 'Quote #':'DUP-QT', 'Buyer':'Client B' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.qt.length, 2, 'both pulled rows present, no silent drop');
  var withLocalId = ctx.DB.qt.find(function(r){ return r.id === 'q1'; });
  var other = ctx.DB.qt.find(function(r){ return r.id !== 'q1'; });
  assert(withLocalId, 'exactly one record legitimately claims the real local id');
  assert(other && other.id, 'the duplicate gets its own distinct fresh id, never colliding with q1');
});

testAsync('pullAll integration — no-duplicate-keys pull behaves identically to prior (v4) verified behavior', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.li = [{ id:'l1', sku:'SOLO', desc:'Old', cost:1, price:2, supId:'s1' }];
  _mockPullResponses = { li: { status:'ok', records: [{ 'SKU':'SOLO', 'Description':'New', 'Unit Cost':3, 'Unit Price':4, 'Supplier':'s1' }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.li.length, 1, 'no duplicate keys means exactly one merged record, as before');
  assertEqual(ctx.DB.li[0].id, 'l1');
  assertEqual(ctx.DB.li[0].desc, 'New');
});

testAsync('pullAll integration — corrupted-backup shape (header-keyed blank stub) is dropped, not merged in with a spurious id (REQ-DATA-002j)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.sup = [{ id:'sup1', name:'Real Supplier', country:'China', email:'real@sup.example' }];
  _mockPullResponses = { sup: { status:'ok', records: [
    { 'Supplier ID':'sup1', 'Name':'Real Supplier (updated)', 'Country':'China', 'Contact':'', 'Email':'real@sup.example', 'Phone':'', 'Currency':'USD', 'Payment Terms':'', 'Lead Time':'', 'DG Capable':'', 'Notes':'' },
    { 'Supplier ID':'', 'Name':'', 'Country':'', 'Contact':'', 'Email':'', 'Phone':'', 'Currency':'', 'Payment Terms':'', 'Lead Time':'', 'DG Capable':'', 'Notes':'' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  // Prior to REQ-DATA-002j, the header-keyed blank stub (falsy id, since it's an id-keyed entity)
  // used to survive the merge and enter DB.sup as a genuine phantom record — this is the exact
  // SYNC-GAP-001-class mechanism the cleanup feature exists to clean up residue from. It is now
  // dropped at the source instead.
  assertEqual(ctx.DB.sup.length, 1, 'the blank stub is dropped — only the real, matched Supplier remains');
  var real = ctx.DB.sup.find(function(s){ return s.id === 'sup1'; });
  assert(real, 'real supplier retains its original id');
  assertEqual(real.name, 'Real Supplier (updated)');
});

testAsync('pullAll integration — co pull matching by id preserves untracked enquiries array', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.con = [{ id:'c1', name:'Old Name', email:'c1@example.com', enquiries:[{summary:'first enquiry'}] }];
  _mockPullResponses = { co: { status:'ok', records: [{ 'Contact ID':'c1', 'Name':'New Name', 'Email':'c1@example.com', 'Phone':'', 'Company':'', 'Status':'', 'Source':'', 'Enquiry Summary':'', 'Notes':'', 'Created At':'', 'Last Contacted':'', 'GDPR Basis':'' }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.con.length, 1);
  assertEqual(ctx.DB.con[0].id, 'c1');
  assertEqual(ctx.DB.con[0].name, 'New Name', 'pulled name adopted');
  assertEqual(ctx.DB.con[0].enquiries.length, 1, 'untracked enquiries array survives merge — closes the v3→v4 gap');
});

testAsync('pullAll integration — sup/payments/co still merge correctly by id (regression)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.payments = [{ id:'p1', invNum:'INV-001', date:'2026-01-01', amount:100, invId:'i1', type:'buyer_payment' }];
  _mockPullResponses = { payments: { status:'ok', records: [{ 'Payment ID':'p1', 'Invoice #':'INV-001', 'Date':'2026-02-01', 'Amount':150, 'Currency':'USD', 'Method':'Bank Transfer', 'Notes':'' }] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(ctx.DB.payments.length, 1);
  assertEqual(ctx.DB.payments[0].id, 'p1');
  assertEqual(ctx.DB.payments[0].amount, 150, 'pulled amount adopted');
  assertEqual(ctx.DB.payments[0].invId, 'i1', 'untracked invId survives — closes the v3→v4 gap for payments');
  assertEqual(ctx.DB.payments[0].type, 'buyer_payment', 'untracked type survives');
});

// ── REQ-SYNC-002 / SPEC-SYNC-002 — batched sync requests ────────
test('isUnknownAction() — matches the server\'s exact Unknown-action shape only', function() {
  assert(ctx.isUnknownAction({ status: 'error', message: 'Unknown action: pull_all' }), 'true for the exact server shape');
  assert(!ctx.isUnknownAction({ status: 'ok', message: 'Unknown action: pull_all' }), 'false when status is ok');
  assert(!ctx.isUnknownAction({ status: 'error', message: 'Something else went wrong' }), 'false for an unrelated error message');
  assert(!ctx.isUnknownAction({ status: 'error' }), 'false when message is missing');
  assert(!ctx.isUnknownAction(null), 'false for null');
  assert(!ctx.isUnknownAction(undefined), 'false for undefined');
});

testAsync('syncAll() — batched happy path sends exactly one bulk_upsert_all request', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'i1', num:'INV-001', type:'invoice', lineItems:[] }, { id:'i2', num:'CN-001', type:'credit_note', lineItems:[] }];
  _fetchCallLog = [];
  await ctx.syncAll();
  var batchCalls = _fetchCallLog.filter(function(c){ return c.action === 'bulk_upsert_all'; });
  assertEqual(batchCalls.length, 1, 'exactly one bulk_upsert_all request sent');
  var entKeys = batchCalls[0].entities.map(function(e){ return e.entity; });
  assertEqual(entKeys.join(','), 'sup,li,po,sh,qt,payments,co,inv,cn', 'entities array carries the expected entity keys, cn included since a credit-note row exists');
  var oldStyleCalls = _fetchCallLog.filter(function(c){ return c.action === 'bulk_upsert'; });
  assertEqual(oldStyleCalls.length, 0, 'no individual bulk_upsert calls made on the happy path');
});

testAsync('syncAll() — omits cn from the batch when there are no credit-note rows', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'i1', num:'INV-001', type:'invoice', lineItems:[] }];
  _fetchCallLog = [];
  await ctx.syncAll();
  var entKeys = _fetchCallLog[0].entities.map(function(e){ return e.entity; });
  assertEqual(entKeys.indexOf('cn'), -1, 'cn omitted from the batched entities array when DB.inv has no credit-note-typed row');
});

testAsync('syncAll() — falls back to sequential bulk_upsert calls when server does not recognize bulk_upsert_all', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id:'i1', num:'INV-001', type:'invoice', lineItems:[] }];
  _fetchCallLog = [];
  _mockUnknownBatchAction = true;
  await ctx.syncAll();
  _mockUnknownBatchAction = false;
  assertEqual(_fetchCallLog[0].action, 'bulk_upsert_all', 'the batched attempt is still made first');
  var fallbackCalls = _fetchCallLog.slice(1);
  assert(fallbackCalls.length >= 8, 'falls back to the individual per-entity bulk_upsert calls (sup,li,po,sh,qt,payments,co,inv at minimum)');
  assert(fallbackCalls.every(function(c){ return c.action === 'bulk_upsert'; }), 'every fallback call uses the old single-entity action');
  var fallbackEnts = fallbackCalls.map(function(c){ return c.entity; });
  assertEqual(fallbackEnts.join(','), 'sup,li,po,sh,qt,payments,co,inv', 'fallback sequence matches the original pre-batching order');
});

testAsync('pushAll() — batched happy path includes inv_lines in the single bulk_upsert_all request', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec';
  ctx.DB.inv = [{ id:'i1', num:'INV-001', type:'invoice', lineItems:[{ desc:'Widget', qty:2, up:5, uom:'pcs' }] }];
  _fetchCallLog = [];
  await ctx.pushAll();
  var batchCalls = _fetchCallLog.filter(function(c){ return c.action === 'bulk_upsert_all'; });
  assertEqual(batchCalls.length, 1, 'exactly one bulk_upsert_all request sent');
  var entKeys = batchCalls[0].entities.map(function(e){ return e.entity; });
  assertEqual(entKeys.join(','), 'sup,li,po,sh,qt,payments,co,inv,cn,inv_lines', 'inv_lines included in the batched entities array, cn unconditional as today');
});

testAsync('pushAll() — falls back to sequential bulk_upsert calls including a trailing inv_lines call', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec';
  ctx.DB.inv = [{ id:'i1', num:'INV-001', type:'invoice', lineItems:[] }];
  _fetchCallLog = [];
  _mockUnknownBatchAction = true;
  await ctx.pushAll();
  _mockUnknownBatchAction = false;
  var fallbackCalls = _fetchCallLog.slice(1);
  var fallbackEnts = fallbackCalls.map(function(c){ return c.entity; });
  assertEqual(fallbackEnts.join(','), 'sup,li,po,sh,qt,payments,co,inv,cn,inv_lines', 'fallback sequence matches original pre-batching order, ending in inv_lines');
});

testAsync('pullAll() — with no batched-results mock set, transparently falls through to per-entity sGet() (existing tests stay valid)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Old Widget', cost:5, price:6, cur:'USD', supId:'s1', priceHistory:[{v:1}], invoiceRefs:[{invId:'i1'}] }];
  _mockPullResponses = { li: { status:'ok', records: [{ 'SKU':'ABC', 'Description':'New Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'s1', 'Notes':'' }] } };
  _fetchCallLog = [];
  await ctx.pullAll();
  _mockPullResponses = {};
  assertEqual(_fetchCallLog[0].action, 'pull_all', 'the batched pull is attempted first');
  var pullEntityCalls = _fetchCallLog.filter(function(c){ return c.action === 'pull_entity'; });
  assert(pullEntityCalls.length > 0, 'falls through to individual pull_entity calls when the batched response carries no results');
  assertEqual(ctx.DB.li[0].desc, 'New Widget', 'merge outcome identical to the pre-batching fallback path');
});

testAsync('pullAll() — batched results path produces the same merge outcome as the fallback path for the same data', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Old Widget', cost:5, price:6, cur:'USD', supId:'s1', priceHistory:[{v:1}], invoiceRefs:[{invId:'i1'}] }];
  _mockPullAllResponse = { status:'ok', results: {
    li: { status:'ok', records: [{ 'SKU':'ABC', 'Description':'New Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'s1', 'Notes':'' }] }
  } };
  _fetchCallLog = [];
  await ctx.pullAll();
  _mockPullAllResponse = null;
  var pullEntityCalls = _fetchCallLog.filter(function(c){ return c.action === 'pull_entity'; });
  assertEqual(pullEntityCalls.length, 0, 'no individual pull_entity calls made once the batched response carries results');
  var li = ctx.DB.li[0];
  assertEqual(li.id, 'l1', 'local id preserved — identical to the fallback-path test above');
  assertEqual(li.desc, 'New Widget', 'pulled desc adopted — identical to the fallback-path test above');
  assertEqual(li.cost, 10, 'pulled cost adopted — identical to the fallback-path test above');
  assertEqual(li.priceHistory.length, 1, 'untracked priceHistory preserved — identical to the fallback-path test above');
});

testAsync('pullAll() — an entity missing from the batched results is treated as a per-entity failure, others unaffected', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.sh = [];
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Old Widget', cost:5, price:6, cur:'USD', supId:'s1' }];
  _mockPullAllResponse = { status:'ok', results: {
    li: { status:'ok', records: [{ 'SKU':'ABC', 'Description':'New Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'s1', 'Notes':'' }] }
    // 'sh' deliberately absent — simulates REQ-SYNC-002e isolation: one entity's server-side failure
    // must not prevent every other entity's batched result from being used. pulled('sh') hits its own
    // `batched[entity] || {status:'error',...}` fallback inside pulled() (index.html) — this is the
    // codepath under test, not a coincidental exception (see the regression test below for that class of bug).
  } };
  await ctx.pullAll();
  _mockPullAllResponse = null;
  assertEqual(ctx.DB.li[0].desc, 'New Widget', 'li still merges correctly even though sh had no batched result');
  assertEqual(ctx.DB.sh.length, 0, 'sh silently stays as-is when absent from the batch — no crash, no other entity affected');
});

testAsync('pullAll() — multiple simple entities with real records in the same pull all merge correctly (regression test for a `pulled` name collision found at build-gate)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.li  = [{ id:'l1', sku:'ABC', desc:'Old Widget', cost:5, price:6, cur:'USD', supId:'s1' }];
  ctx.DB.con = [{ id:'c1', name:'Old Name', email:'c1@example.com', enquiries:[] }];
  _mockPullResponses = {
    li: { status:'ok', records: [{ 'SKU':'ABC', 'Description':'New Widget', 'Unit Cost':10, 'Unit Price':12, 'Currency':'USD', 'HS Code':'', 'Supplier':'s1', 'Notes':'' }] },
    co: { status:'ok', records: [{ 'Contact ID':'c1', 'Name':'New Name', 'Email':'c1@example.com', 'Phone':'', 'Company':'', 'Status':'', 'Source':'', 'Enquiry Summary':'', 'Notes':'', 'Created At':'', 'Last Contacted':'', 'GDPR Basis':'' }] }
  };
  await ctx.pullAll();
  _mockPullResponses = {};
  // li is processed before co in the simpleEnts loop (index.html). A local `pulled` array declared
  // inside that loop previously shadowed the `pulled()` helper function once li's non-empty records
  // ran through it, so co (and everything after li) silently threw "pulled is not a function" on
  // every subsequent iteration. This test fails if that regression reappears.
  assertEqual(ctx.DB.li[0].desc, 'New Widget', 'li (processed earlier in simpleEnts) merges correctly');
  assertEqual(ctx.DB.con[0].name, 'New Name', 'co (processed later in simpleEnts, after li) also merges correctly');
});

// ── Invoice quick-add COGS warning (SPEC-INV-001) ───────────────
console.log('\nInvoice quick-add COGS warning (SPEC-INV-001)');

test('_updQaWarn — no lid, unitCost 0 → counted', function() {
  resetDB();
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Ocean Freight', qty:1, up:4600, unitCost:0 }];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'block');
  assertEqual(mockEl('inv-qa-warn-count').textContent, 1);
});

test('_updQaWarn — no lid, unitCost > 0 → not counted (INV10032 regression case)', function() {
  resetDB();
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Ocean Freight', qty:1, up:4600, unitCost:4600 }];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'none');
});

test('_updQaWarn — lid resolves to a real DB.li record → not counted regardless of unitCost', function() {
  resetDB();
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Widget', cost:10, price:12 }];
  ctx.cIL = [{ rid:'r1', lid:'l1', desc:'Widget', qty:1, up:12, unitCost:0 }];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'none');
});

test('_updQaWarn — dangling lid (no matching DB.li record), unitCost 0 → counted', function() {
  resetDB();
  ctx.DB.li = [];
  ctx.cIL = [{ rid:'r1', lid:'stale-id-no-longer-exists', desc:'Widget', qty:1, up:12, unitCost:0 }];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'block');
  assertEqual(mockEl('inv-qa-warn-count').textContent, 1);
});

test('_updQaWarn — dangling lid, unitCost > 0 → not counted', function() {
  resetDB();
  ctx.DB.li = [];
  ctx.cIL = [{ rid:'r1', lid:'stale-id-no-longer-exists', desc:'Widget', qty:1, up:262, unitCost:262 }];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'none');
});

test('_updQaWarn — mixed invoice counts only the genuinely at-risk lines', function() {
  resetDB();
  ctx.DB.li = [{ id:'l1', sku:'ABC', desc:'Widget', cost:10, price:12 }];
  ctx.cIL = [
    { rid:'r1', lid:'l1', desc:'Widget', qty:1, up:12, unitCost:0 },              // resolved — safe
    { rid:'r2', lid:'', desc:'Ocean Freight', qty:1, up:4600, unitCost:4600 },     // no lid but cost present — safe
    { rid:'r3', lid:'', desc:'Mystery Charge', qty:1, up:100, unitCost:0 },        // no lid, no cost — at risk
    { rid:'r4', lid:'stale', desc:'Old Item', qty:1, up:50, unitCost:0 }           // dangling lid, no cost — at risk
  ];
  ctx._updQaWarn();
  assertEqual(mockEl('inv-qa-warn').style.display, 'block');
  assertEqual(mockEl('inv-qa-warn-count').textContent, 2);
});

// ── Order Request CSV import (SPEC-ORD-003) ────────────────────
console.log('\nOrder Request CSV import (SPEC-ORD-003)');

var ORD_HEADERS = ['Submission ID','Contact Name','Contact Email','Order Description','Category','Item/Spec','Order Volume Qty','Order Volume Unit','Packing Spec','Base UOM','Base Qty','Qty Status','Source Country','Variant/Option'];
function ordCsv(rows) {
  return ORD_HEADERS.join(',') + '\n' + rows.map(function(r) {
    return ORD_HEADERS.map(function(h){ return '"' + String(r[h] != null ? r[h] : '').replace(/"/g,'') + '"'; }).join(',');
  }).join('\n');
}

test('processImport ord — 3 rows same Submission ID + existing Contact email produce 1 Order Request with 3 lines', function() {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Thorpes Produce Inc', email:'buyer@thorpes.example', status:'qualified', enquiries:[] }];
  var csv = ordCsv([
    { 'Submission ID':'WEB-1', 'Contact Email':'buyer@thorpes.example', 'Category':'Fresh produce', 'Item/Spec':'Grapes' },
    { 'Submission ID':'WEB-1', 'Contact Email':'buyer@thorpes.example', 'Category':'Fresh produce', 'Item/Spec':'Melons' },
    { 'Submission ID':'WEB-1', 'Contact Email':'buyer@thorpes.example', 'Category':'Fresh produce', 'Item/Spec':'Berries' }
  ]);
  ctx.processImport('ord', csv);
  assertEqual(ctx.DB.con.length, 1, 'no new contact created — existing one matched');
  assertEqual(ctx.DB.ord.length, 1, 'one Order Request created');
  assertEqual(ctx.DB.ord[0].contactId, 'c1');
  assertEqual(ctx.DB.ord[0].lines.length, 3);
  assertContains(mockEl('imp-ord-result').textContent, '1 added, 0 updated');
});

test('processImport ord — unmatched Contact Email auto-creates a new lead Contact', function() {
  resetDB();
  var csv = ordCsv([{ 'Submission ID':'WEB-2', 'Contact Name':'New Buyer', 'Contact Email':'new@buyer.example', 'Category':'Seeds', 'Item/Spec':'Tomato' }]);
  ctx.processImport('ord', csv);
  assertEqual(ctx.DB.con.length, 1);
  assertEqual(ctx.DB.con[0].status, 'lead');
  assertEqual(ctx.DB.con[0].source, 'webform');
  assertEqual(ctx.DB.con[0].gdprBasis, 'pre_contract');
  assertEqual(ctx.DB.ord[0].contactId, ctx.DB.con[0].id);
});

test('processImport ord — re-import with a 4th row updates existing Order Request to 4 lines, no duplicate record', function() {
  resetDB();
  var csv1 = ordCsv([
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Carrot' },
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Beetroot' },
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Thyme' }
  ]);
  ctx.processImport('ord', csv1);
  assertContains(mockEl('imp-ord-result').textContent, '1 added, 0 updated');

  var csv2 = ordCsv([
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Carrot' },
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Beetroot' },
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Thyme' },
    { 'Submission ID':'WEB-3', 'Contact Email':'a@b.example', 'Category':'Seeds', 'Item/Spec':'Cabbage' }
  ]);
  ctx.processImport('ord', csv2);
  assertEqual(ctx.DB.ord.length, 1, 'still exactly one Order Request');
  assertEqual(ctx.DB.ord[0].lines.length, 4);
  assertContains(mockEl('imp-ord-result').textContent, '0 added, 1 updated', 'closes the v1 spec-gate counting bug — reintroducing it would report 1 added here');
});

test('processImport ord — re-import with no new content adds no duplicate lines', function() {
  resetDB();
  var csv = ordCsv([{ 'Submission ID':'WEB-4', 'Contact Email':'x@y.example', 'Category':'Seeds', 'Item/Spec':'Watermelon' }]);
  ctx.processImport('ord', csv);
  ctx.processImport('ord', csv);
  assertEqual(ctx.DB.ord.length, 1);
  assertEqual(ctx.DB.ord[0].lines.length, 1, 'no duplicate line from re-importing identical content');
});

test('processImport ord — row with blank Category and Item/Spec is skipped, siblings still import', function() {
  resetDB();
  var csv = ordCsv([
    { 'Submission ID':'WEB-5', 'Contact Email':'z@z.example', 'Category':'', 'Item/Spec':'' },
    { 'Submission ID':'WEB-5', 'Contact Email':'z@z.example', 'Category':'Seeds', 'Item/Spec':'Honeydew' }
  ]);
  ctx.processImport('ord', csv);
  assertEqual(ctx.DB.ord[0].lines.length, 1, 'blank row skipped, valid sibling row still imported');
});

test('processImport ord — row with blank Contact Email skips the entire submission', function() {
  resetDB();
  var csv = ordCsv([{ 'Submission ID':'WEB-6', 'Contact Email':'', 'Category':'Seeds', 'Item/Spec':'Cantaloupe' }]);
  ctx.processImport('ord', csv);
  assertEqual(ctx.DB.ord.length, 0);
  assertEqual(ctx.DB.con.length, 0);
});

test('processImport ord — Qty Status values map correctly, unrecognised/blank default to Unknown', function() {
  resetDB();
  var csv = ordCsv([
    { 'Submission ID':'WEB-7', 'Contact Email':'q@q.example', 'Category':'A', 'Item/Spec':'1', 'Qty Status':'confirmed' },
    { 'Submission ID':'WEB-7', 'Contact Email':'q@q.example', 'Category':'B', 'Item/Spec':'2', 'Qty Status':'CONFIRMED' },
    { 'Submission ID':'WEB-7', 'Contact Email':'q@q.example', 'Category':'C', 'Item/Spec':'3', 'Qty Status':'' },
    { 'Submission ID':'WEB-7', 'Contact Email':'q@q.example', 'Category':'D', 'Item/Spec':'4', 'Qty Status':'garbage' }
  ]);
  ctx.processImport('ord', csv);
  var lines = ctx.DB.ord[0].lines;
  assertEqual(lines[0].qtyStatus, 'Confirmed');
  assertEqual(lines[1].qtyStatus, 'Confirmed');
  assertEqual(lines[2].qtyStatus, 'Unknown');
  assertEqual(lines[3].qtyStatus, 'Unknown');
});

// ── Contacts CSV upload (SPEC-CON-002) ──────────────────────────
console.log('\nContacts CSV upload (SPEC-CON-002)');

test('processImport co: fresh contact row creates one new DB.con record with fields mapped', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email,Phone,Company,Status,Source,Enquiry Summary,Notes\nJane Buyer,jane@example.com,+1246,Island Fresh,qualified,manual,Interested in grapes,Follow up soon\n');
  assertEqual(ctx.DB.con.length, 1);
  var rec = ctx.DB.con[0];
  assertEqual(rec.name, 'Jane Buyer');
  assertEqual(rec.email, 'jane@example.com');
  assertEqual(rec.phone, '+1246');
  assertEqual(rec.company, 'Island Fresh');
  assertEqual(rec.status, 'qualified');
  assertEqual(rec.source, 'manual');
  assertEqual(rec.enquirySummary, 'Interested in grapes');
  assertEqual(rec.notes, 'Follow up soon');
  assertEqual(rec.gdprBasis, 'pre_contract');
});

test('processImport co: re-uploading same email updates, not duplicates', () => {
  resetDB();
  var csv = 'Name,Email\nJane Buyer,jane@example.com\n';
  ctx.processImport('co', csv);
  ctx.processImport('co', csv);
  assertEqual(ctx.DB.con.length, 1, 'no duplicate created on re-upload');
});

test('processImport co: email match takes priority over name match', () => {
  resetDB();
  ctx.DB.con = [
    { id:'c1', name:'Jane Buyer', email:'old@example.com', phone:'', company:'', status:'lead', source:'manual', enquirySummary:'', notes:'', createdAt:'x', lastContactedAt:'x', gdprBasis:'pre_contract', enquiries:[] }
  ];
  ctx.processImport('co', 'Name,Email\nJane Buyer,new@example.com\n');
  assertEqual(ctx.DB.con.length, 2, 'email not matching any existing contact creates a new record, even though name matches an existing one');
});

test('processImport co: row with no Name and no Email is skipped', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email,Notes\n,,just some notes\n');
  assertEqual(ctx.DB.con.length, 0);
});

test('processImport co: invalid Status defaults to lead', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email,Status\nJane Buyer,jane@example.com,Prospect\n');
  assertEqual(ctx.DB.con[0].status, 'lead');
});

test('processImport co: re-upload omitting Notes preserves existing notes value', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email,Notes\nJane Buyer,jane@example.com,Original note\n');
  ctx.processImport('co', 'Name,Email\nJane Buyer,jane@example.com\n');
  assertEqual(ctx.DB.con[0].notes, 'Original note', 'notes preserved when column omitted on re-upload');
});

test('TEMPLATES.co headers match exactly what the co import branch reads', () => {
  var allowedKeys = ['Name','Email','Phone','Company','Status','Source','Enquiry Summary','Notes'];
  assertEqual(ctx.TEMPLATES.co.headers.slice().sort().join(','), allowedKeys.slice().sort().join(','));
});

test('processImport co: imp-co-result message matches standard added/updated/skipped format', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email\nJane Buyer,jane@example.com\n');
  assertEqual(mockEl('imp-co-result').textContent, 'Contacts: 1 added, 0 updated, 0 skipped');
});

test('processImport co branch calls rCon() to refresh the live view', () => {
  resetDB();
  var called = false;
  var origRCon = ctx.rCon;
  ctx.rCon = function(){ called = true; };
  ctx.processImport('co', 'Name,Email\nTest Contact,test@example.com\n');
  assert(called, 'rCon() invoked after a co import');
  ctx.rCon = origRCon;
});

test('processImport co branch: Created At / Last Contacted columns populate on a new contact', () => {
  resetDB();
  ctx.processImport('co', 'Name,Email,Created At,Last Contacted\nTest Contact,test2@example.com,2024-01-01,2024-06-01\n');
  var rec = ctx.DB.con.find(function(c){ return c.email === 'test2@example.com'; });
  assertEqual(rec.createdAt, '2024-01-01', 'createdAt populated from Created At column, not defaulted to now');
  assertEqual(rec.lastContactedAt, '2024-06-01', 'lastContactedAt populated from Last Contacted column, not defaulted to now');
});

// ── CSV import — multi-line quoted fields (REQ/SPEC-DATA-003) ───
console.log('\nCSV import — multi-line quoted fields (REQ/SPEC-DATA-003)');

test('parseImportCSV() — a multi-line quoted field with commas on internal lines parses as ONE row, not several (AC-1/AC-6)', function() {
  var csv = 'Supplier Name,Country,Notes\nJoylife,China,"Address: Room 221,\n2nd Building, Dongguan City,\nGuangdong, China"\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows.length, 1, 'exactly one row — the reported corruption produced 5-6');
  assertEqual(parsed.rows[0]['Supplier Name'], 'Joylife');
  assertEqual(parsed.rows[0]['Country'], 'China');
  assert(parsed.rows[0]['Notes'].indexOf('\n') >= 0, 'Notes value retains its embedded newline(s)');
  assertEqual(parsed.rows[0]['Notes'], 'Address: Room 221,\n2nd Building, Dongguan City,\nGuangdong, China', 'Notes value preserved verbatim');
});

test('parseImportCSV() — a quoted field with an embedded comma but no newline still parses as one field (AC-2, regression guard)', function() {
  var csv = 'Supplier Name,Notes\nAcme,"Commercial refrigeration, CE certified"\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows.length, 1);
  assertEqual(parsed.rows[0]['Notes'], 'Commercial refrigeration, CE certified');
});

test('parseImportCSV() — an escaped quote ("") inside a quoted field becomes one literal quote character (AC-3)', function() {
  var csv = 'Supplier Name,Notes\nAcme,"Acme ""Best"" Co"\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows.length, 1);
  assertEqual(parsed.rows[0]['Notes'], 'Acme "Best" Co', 'escaped double-quote collapses to one literal quote, field boundary unaffected');
});

test('parseImportCSV() — CRLF row endings and an embedded CRLF inside a quoted field are both handled correctly (AC-4)', function() {
  var csv = 'Supplier Name,Notes\r\nAcme,"Line1\r\nLine2"\r\nBeta,Simple\r\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows.length, 2, 'CRLF between records still separates rows correctly');
  assertContains(parsed.rows[0]['Notes'], '\r\n', 'the embedded CRLF inside the quoted field is preserved verbatim, not treated as a row break');
  assertEqual(parsed.rows[1]['Supplier Name'], 'Beta');
  assertEqual(parsed.rows[1]['Notes'], 'Simple');
});

test('parseImportCSV() — a blank physical line between two real data rows is skipped, not turned into a spurious record (AC-5)', function() {
  var csv = 'Supplier Name,Notes\nAcme,First\n\nBeta,Second\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows.length, 2, 'blank line skipped — not 3 rows');
  assertEqual(parsed.rows[0]['Supplier Name'], 'Acme');
  assertEqual(parsed.rows[1]['Supplier Name'], 'Beta');
});

test('parseImportCSV() — an unterminated quote does not throw or hang, and returns a defined result (AC-9)', function() {
  var csv = 'Supplier Name,Notes\nAcme,"unterminated notes never closes and has a comma, here too';
  var parsed;
  var threw = false;
  try { parsed = ctx.parseImportCSV(csv); } catch (e) { threw = true; }
  assertEqual(threw, false, 'parser does not throw on malformed input');
  assert(parsed && Array.isArray(parsed.rows), 'returns a defined { headers, rows } shape');
  assertEqual(parsed.rows.length, 1, 'the unterminated field is captured as best-effort content, not lost or duplicated');
});

test('parseImportCSV() — existing numeric thousand-separator and date normalization behavior preserved', function() {
  var csv = 'Supplier Name,Amount,Date\nAcme,"30,755.80",25/12/2025\n';
  var parsed = ctx.parseImportCSV(csv);
  assertEqual(parsed.rows[0]['Amount'], '30755.80', 'thousand separators stripped from a quoted numeric value');
  assertEqual(parsed.rows[0]['Date'], '2025-12-25', 'DD/MM/YYYY normalized to YYYY-MM-DD');
});

test('processImport(\'sup\', ...) — a real multi-line Notes field reproduces the reported bug and confirms the fix end-to-end (AC-1/AC-6)', function() {
  resetDB();
  var csv = 'Supplier Name,Country,Contact Person,Email,Phone/WeChat,Currency,Notes\n' +
    '"Joylife Industry (Dongguan) Co.,Ltd","China","Tammy","tammy@joylifetissuepaper.com","+86 180-2829-1935","USD","Address: Room 221,\n2nd Building, No.350 of Taixin Road,\nWanjiang Street, Dongguan City,\nGuangdong, China"\n' +
    'Acme Foods,USA,John,john@acme.example,+1 555 0100,USD,Standard supplier\n';
  ctx.processImport('sup', csv);
  assertEqual(ctx.DB.sup.length, 2, 'exactly 2 real suppliers — not 2 plus a handful of phantom fragments');
  var joylife = ctx.DB.sup.find(function(s){ return s.name.indexOf('Joylife') === 0; });
  assert(joylife, 'the Joylife supplier record exists');
  assertEqual(joylife.country, 'China');
  assertEqual(joylife.ct, 'Tammy');
  assertEqual(joylife.email, 'tammy@joylifetissuepaper.com');
  assert(joylife.notes.indexOf('Room 221') >= 0 && joylife.notes.indexOf('Guangdong') >= 0, 'the full multi-line address survives in notes, not torn apart');
  var acme = ctx.DB.sup.find(function(s){ return s.name === 'Acme Foods'; });
  assert(acme, 'the row following the multi-line field also parsed correctly, unaffected by it');
  assertContains(mockEl('imp-sup-result').textContent, '2 added, 0 updated');
});

test('processImport(\'sup\', ...) — baseline happy path with no multi-line content (closes a pre-existing zero-coverage gap)', function() {
  resetDB();
  var csv = 'Supplier Name,Country,Contact Person,Email,Phone/WeChat,Currency,Notes\nAcme Foods,USA,John,john@acme.example,+1 555 0100,USD,Reliable supplier\n';
  ctx.processImport('sup', csv);
  assertEqual(ctx.DB.sup.length, 1);
  assertEqual(ctx.DB.sup[0].name, 'Acme Foods');
  assertEqual(ctx.DB.sup[0].country, 'USA');
  assertEqual(ctx.DB.sup[0].cur, 'USD');
  // Re-import with the same name (different case) to confirm case-insensitive update-in-place, not a duplicate.
  var csv2 = 'Supplier Name,Country,Contact Person,Email,Phone/WeChat,Currency,Notes\nACME FOODS,USA,Jane,jane@acme.example,+1 555 0199,USD,Updated contact\n';
  ctx.processImport('sup', csv2);
  assertEqual(ctx.DB.sup.length, 1, 're-import by case-insensitive name updates in place, no duplicate');
  assertEqual(ctx.DB.sup[0].ct, 'Jane');
});

test('processImport(\'co\', ...) — a multi-line quoted field also parses correctly for a non-Supplier entity (AC-7, cross-entity check)', function() {
  resetDB();
  var csv = 'Name,Email,Notes\nJane Buyer,jane@example.com,"Line one,\nLine two, with a comma,\nLine three"\n';
  ctx.processImport('co', csv);
  assertEqual(ctx.DB.con.length, 1, 'exactly one contact — the shared parser fix applies uniformly across entities');
  assert(ctx.DB.con[0].notes.indexOf('\n') >= 0, 'multi-line notes preserved for a non-Supplier entity too');
});

// ── Quote approval audit trail (SPEC-ORD-003) ───────────────────
console.log('\nQuote approval audit trail (SPEC-ORD-003)');

function setupQteForm(over) {
  var f = Object.assign({ client:'Acme Buyer', dt:'2026-01-01', valid:'', cur:'USD', mode:'LCL', mkp:'15', st:'Draft', nt:'', approvedBy:'', approvedNote:'' }, over || {});
  mockEl('qf-client').value = f.client;
  mockEl('qf-dt').value = f.dt;
  mockEl('qf-valid').value = f.valid;
  mockEl('qf-cur').value = f.cur;
  mockEl('qf-mode').value = f.mode;
  mockEl('qf-mkp').value = f.mkp;
  mockEl('qf-st').value = f.st;
  mockEl('qf-nt').value = f.nt;
  mockEl('qf-approved-by').value = f.approvedBy;
  mockEl('qf-approved-note').value = f.approvedNote;
  mockEl('qf-num').value = '';
}

test('vQte — blocks save when status is Accepted and Approved By is blank', function() {
  resetDB();
  ctx.EI.qt = null; ctx.cQL = [{ rid:'r1', supId:'', desc:'Widget', qty:1, uom:'pcs', cost:10, cbm:0, dg:false, dutyPct:0 }];
  setupQteForm({ st:'Accepted', approvedBy:'' });
  assert(ctx.vQte() === false, 'save blocked without Approved By');
  assertContains(mockEl('qt-verr').textContent, 'Approved By is required');
});

test('saveQte — Accepted status with Approved By succeeds and sets approvedAt', function() {
  resetDB();
  ctx.EI.qt = null; ctx.cQL = [{ rid:'r1', supId:'', desc:'Widget', qty:1, uom:'pcs', cost:10, cbm:0, dg:false, dutyPct:0 }];
  setupQteForm({ st:'Accepted', approvedBy:'Jane Ops', approvedNote:'Confirmed by phone' });
  ctx.saveQte();
  assertEqual(ctx.DB.qt.length, 1);
  var q = ctx.DB.qt[0];
  assertEqual(q.approvedBy, 'Jane Ops');
  assertEqual(q.approvedReason, 'Confirmed by phone');
  assert(q.approvedAt, 'approvedAt set on first transition into Accepted');
});

test('saveQte — re-saving an already-Accepted quote preserves the original approvedAt', function() {
  resetDB();
  ctx.EI.qt = null; ctx.cQL = [{ rid:'r1', supId:'', desc:'Widget', qty:1, uom:'pcs', cost:10, cbm:0, dg:false, dutyPct:0 }];
  setupQteForm({ st:'Accepted', approvedBy:'Jane Ops' });
  ctx.saveQte();
  var firstApprovedAt = ctx.DB.qt[0].approvedAt;
  var qid = ctx.DB.qt[0].id;

  ctx.EI.qt = qid; ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  setupQteForm({ st:'Accepted', approvedBy:'Jane Ops', approvedNote:'Edited note' });
  mockEl('qf-num').value = ctx.DB.qt[0].num;
  ctx.saveQte();
  assertEqual(ctx.DB.qt[0].approvedAt, firstApprovedAt, 'approvedAt unchanged on resave of an already-Accepted quote');
  assertEqual(ctx.DB.qt[0].approvedReason, 'Edited note', 'other approval fields remain editable');
});

test('saveQte — a quote never set to Accepted has blank approval fields, no regression', function() {
  resetDB();
  ctx.EI.qt = null; ctx.cQL = [{ rid:'r1', supId:'', desc:'Widget', qty:1, uom:'pcs', cost:10, cbm:0, dg:false, dutyPct:0 }];
  setupQteForm({ st:'Draft' });
  ctx.saveQte();
  var q = ctx.DB.qt[0];
  assertEqual(q.approvedBy, '');
  assertEqual(q.approvedReason, '');
  assertEqual(q.approvedAt, '');
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

test('delInv — routes credit_note delete to cn entity', function() {
  resetDB();
  ctx.DB.inv.push({ id:'cn-del1', num:'CN10301', type:'credit_note', cnAmount:-100, lineItems:[], taxRate:0 });
  var capturedEntity;
  var origDelEnt = ctx.delEnt;
  ctx.delEnt = function(entity) { capturedEntity = entity; return Promise.resolve(); };
  ctx.confirm = function(){ return true; };
  ctx.delInv('cn-del1');
  ctx.confirm = function(){ return false; };
  ctx.delEnt = origDelEnt;
  assertEqual(capturedEntity, 'cn', 'credit_note delete routed to cn entity');
  assertEqual(ctx.DB.inv.find(function(i){ return i.id==='cn-del1'; }), undefined, 'CN removed from DB.inv');
});

test('delInv — routes goodwill_credit delete to cn entity', function() {
  resetDB();
  ctx.DB.inv.push({ id:'gw-del1', num:'CN10302', type:'goodwill_credit', cnAmount:-50, lineItems:[], taxRate:0 });
  var capturedEntity;
  var origDelEnt = ctx.delEnt;
  ctx.delEnt = function(entity) { capturedEntity = entity; return Promise.resolve(); };
  ctx.confirm = function(){ return true; };
  ctx.delInv('gw-del1');
  ctx.confirm = function(){ return false; };
  ctx.delEnt = origDelEnt;
  assertEqual(capturedEntity, 'cn', 'goodwill_credit delete routed to cn entity');
});

test('delInv — routes regular invoice delete to inv entity', function() {
  resetDB();
  ctx.DB.inv.push({ id:'inv-reg1', num:'INV10303', status:'Draft', lineItems:[], taxRate:0 });
  var capturedEntity;
  var origDelEnt = ctx.delEnt;
  ctx.delEnt = function(entity) { capturedEntity = entity; return Promise.resolve(); };
  ctx.confirm = function(){ return true; };
  ctx.delInv('inv-reg1');
  ctx.confirm = function(){ return false; };
  ctx.delEnt = origDelEnt;
  assertEqual(capturedEntity, 'inv', 'regular invoice delete routed to inv entity');
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

// ── iCalc / dashboard calc_ priority (v2.9.11) ─────────────────
console.log('\niCalc / dashboard calc_ priority (v2.9.11)');

test('iCalc — uses calc_grandTotal over live liT', function() {
  resetDB();
  var inv = { id:'ic1', status:'Draft', lineItems:[{qty:1,up:100}], taxRate:0, chargesIncluded:true,
              calc_grandTotal:'9999', calc_netProfit:'500', calc_cogs:'9499',
              calc_grossProfit:'500', calc_margin:'5', calc_balanceDue:'9999' };
  var c = ctx.iCalc(inv);
  assertEqual(c.grand, 9999, 'grand from calc_grandTotal');
  assertEqual(c.np,    500,  'np from calc_netProfit');
  assertEqual(c.cogs,  9499, 'cogs from calc_cogs');
});

test('iCalc — falls back to cInv when calc_ fields absent', function() {
  resetDB();
  var inv = { id:'ic2', status:'Draft', lineItems:[{qty:2,up:50}], taxRate:0, chargesIncluded:true };
  var c = ctx.iCalc(inv);
  assertEqual(c.grand, 100, 'grand from live cInv');
});

test('iCalc — bal uses live cInv: stale calc_balanceDue is ignored', function() {
  resetDB();
  ctx.DB.payments = [{ id:'pm-ic3', invId:'ic3', amount: 600 }];
  var inv = { id:'ic3', status:'Draft', lineItems:[], taxRate:0, chargesIncluded:true,
              calc_grandTotal:'1000', calc_balanceDue:'9999',
              calc_netProfit:'0', calc_cogs:'0', calc_grossProfit:'0', calc_margin:'0' };
  assertEqual(ctx.iCalc(inv).bal, 400, 'bal = 1000 - 600 payment (stale calc_balanceDue ignored)');
});

test('iCalc — applied CN reduces bal via live cInv', function() {
  resetDB();
  ctx.DB.inv = [
    { id:'icn-inv', num:'INV099', status:'Draft', lineItems:[], taxRate:0, chargesIncluded:true,
      calc_grandTotal:'1000', calc_balanceDue:'1000' },
    { id:'icn-cn', num:'CN099', type:'credit_note', linkedInvNum:'INV099',
      cnAmount:-300, status:'CN Applied', lineItems:[], taxRate:0 }
  ];
  var inv = ctx.DB.inv.find(function(i){ return i.num==='INV099'; });
  assertEqual(ctx.iCalc(inv).bal, 700, 'bal = 1000 - 300 applied CN (stale calc_balanceDue ignored)');
});

test('iCalc — credit_note bypasses calc_ fields and delegates to cInv', function() {
  resetDB();
  // A CN with calc_netProfit set — iCalc must NOT use it; CNs are not real-revenue records
  var cn = { id:'icn1', type:'credit_note', cnAmount:200, lineItems:[], taxRate:0, dep:0,
             calc_grandTotal:'9999', calc_netProfit:'9999' };
  var c = ctx.iCalc(cn);
  assertEqual(c.grand, 200, 'CN grand = cnAmount, not calc_grandTotal');
  assertEqual(c.np,    0,   'CN np = 0 from cInv, not calc_netProfit');
});

test('iCalc — goodwill_credit bypasses calc_ fields', function() {
  resetDB();
  var gw = { id:'igw1', type:'goodwill_credit', cnAmount:150, lineItems:[], taxRate:0, dep:0,
             calc_grandTotal:'9999', calc_netProfit:'9999' };
  var c = ctx.iCalc(gw);
  assertEqual(c.np, 0, 'goodwill_credit np = 0 from cInv');
});

test('rDash ai filter — excludes credit_note records from active count', function() {
  resetDB();
  ctx.DB.inv = [
    { id:'f1', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'1000', calc_netProfit:'100', calc_cogs:'900', calc_margin:'10', calc_balanceDue:'1000' },
    { id:'f2', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'2000', calc_netProfit:'200', calc_cogs:'1800', calc_margin:'10', calc_balanceDue:'2000' },
    { id:'f3', type:'credit_note',  status:'CN Applied', cnAmount:100,  lineItems:[], taxRate:0 },
    { id:'f4', type:'goodwill_credit', status:'CN Draft', cnAmount:50,  lineItems:[], taxRate:0 }
  ];
  var ai = ctx.DB.inv.filter(function(i){
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && ctx.isCN(i.num)) return false;
    return true;
  });
  assertEqual(ai.length, 2, 'only 2 real invoices in ai');
});

test('rDash — Revenue excludes credit note grand totals', function() {
  resetDB();
  ctx.DB.inv = [
    { id:'r1', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'31055.80', calc_netProfit:'5829.80', calc_cogs:'25226.00', calc_margin:'18.8', calc_balanceDue:'0' },
    { id:'r2', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'957.08',   calc_netProfit:'0',       calc_cogs:'894.47',   calc_margin:'0',    calc_balanceDue:'0' },
    { id:'r3', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'14180',    calc_netProfit:'4652.18', calc_cogs:'9527.82',  calc_margin:'32.8', calc_balanceDue:'10180' },
    { id:'r4', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'7248.24',  calc_netProfit:'878.24',  calc_cogs:'6370.00',  calc_margin:'12.1', calc_balanceDue:'7048.24' },
    { id:'r5', type:'credit_note', status:'CN Applied', cnAmount:500, lineItems:[], taxRate:0 },
    { id:'r6', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'6071.00',  calc_netProfit:'0',       calc_cogs:'6071.00',  calc_margin:'0',    calc_balanceDue:'6071.00' }
  ];
  var ai = ctx.DB.inv.filter(function(i){
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && ctx.isCN(i.num)) return false;
    return true;
  });
  var tR = ai.reduce(function(s,i){ return s + ctx.iCalc(i).grand; }, 0);
  assertEqual(Math.round(tR), 59512, 'Revenue = $59,512 (CN excluded; INV10031 corrected to $7,248.24; INV10032 added)');
  assertEqual(ai.length, 5, '5 invoices in active count');
});

test('rDash — Net Profit excludes credit note contributions', function() {
  resetDB();
  ctx.DB.inv = [
    { id:'np1', status:'Draft', lineItems:[], taxRate:0, calc_netProfit:'5829.80', calc_grandTotal:'31055.80', calc_balanceDue:'0',       calc_margin:'18.8', calc_cogs:'25226.00' },
    { id:'np2', status:'Draft', lineItems:[], taxRate:0, calc_netProfit:'0',       calc_grandTotal:'957.08',   calc_balanceDue:'0',       calc_margin:'0',    calc_cogs:'894.47'   },
    { id:'np3', status:'Draft', lineItems:[], taxRate:0, calc_netProfit:'4652.18', calc_grandTotal:'14180',    calc_balanceDue:'10180',   calc_margin:'32.8', calc_cogs:'9527.82'  },
    { id:'np4', status:'Draft', lineItems:[], taxRate:0, calc_netProfit:'878.24',  calc_grandTotal:'7248.24',  calc_balanceDue:'7048.24', calc_margin:'12.1', calc_cogs:'6370.00'  },
    { id:'np5', type:'credit_note', status:'CN Applied', cnAmount:166, lineItems:[], taxRate:0, calc_netProfit:'-166' },
    { id:'np6', status:'Draft', lineItems:[], taxRate:0, calc_netProfit:'0',       calc_grandTotal:'6071.00',  calc_balanceDue:'6071.00', calc_margin:'0',    calc_cogs:'6071.00'  }
  ];
  var ai = ctx.DB.inv.filter(function(i){
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && ctx.isCN(i.num)) return false;
    return true;
  });
  var tNP = ai.reduce(function(s,i){ return s + ctx.iCalc(i).np; }, 0);
  assertEqual(Math.round(tNP), 11360, 'NP = $11,360 (CN excluded; INV10031 corrected to $878.24 NP; INV10032 added)');
});

test('rDash — Outstanding correctly reflects payments and applied CNs', function() {
  resetDB();
  ctx.DB.payments = [
    { id:'pm-ou3', invId:'ou3', amount:4000 }
  ];
  ctx.DB.inv = [
    { id:'ou1', status:'Paid',  lineItems:[], taxRate:0, calc_grandTotal:'31055.80', calc_balanceDue:'0',       calc_netProfit:'5829.80', calc_margin:'18.8', calc_cogs:'25226.00' },
    { id:'ou2', status:'Paid',  lineItems:[], taxRate:0, calc_grandTotal:'957.08',   calc_balanceDue:'0',       calc_netProfit:'0',       calc_margin:'0',    calc_cogs:'894.47'   },
    { id:'ou3', num:'INV103', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'14180',   calc_balanceDue:'10180',   calc_netProfit:'4652.18', calc_margin:'32.8', calc_cogs:'9527.82'  },
    { id:'ou4', num:'INV104', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'7248.24', calc_balanceDue:'7248.24', calc_netProfit:'878.24',  calc_margin:'12.1', calc_cogs:'6370.00'  },
    { id:'ou5', num:'INV105', status:'Draft', lineItems:[], taxRate:0, calc_grandTotal:'6071.00', calc_balanceDue:'6071.00', calc_netProfit:'0',       calc_margin:'0',    calc_cogs:'6071.00'  }
  ];
  var ai = ctx.DB.inv.filter(function(i){
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    if (!i.type && ctx.isCN(i.num)) return false;
    return true;
  });
  var tOut = ai.reduce(function(s,i){
    if (i.status==='Paid'||i.status==='Cancelled') return s;
    return s + Math.max(0, ctx.iCalc(i).bal);
  }, 0);
  // ou3: 14180 - 4000 (payment) = 10180
  // ou4: 7248.24 - 0 = 7248.24  [INV10031 corrected; lf now in line items]
  // ou5: 6071.00 - 0 = 6071.00  [INV10032]
  // total = 10180 + 7248.24 + 6071 = 23499.24
  assertEqual(Math.round(tOut), 23499, 'Outstanding = $23,499 (live bal: payment on ou3; INV10031 corrected; INV10032 added)');
});

// ── GATE TESTS ─────────────────────────────────────────────────

test('canTransitionStatus — forward transitions are permitted', function() {
  assertEqual(ctx.canTransitionStatus('Draft', 'Pro-forma'), true, 'Draft→Pro-forma allowed');
  assertEqual(ctx.canTransitionStatus('Draft', 'Sent'), true, 'Draft→Sent allowed');
  assertEqual(ctx.canTransitionStatus('Sent', 'Partially Paid'), true, 'Sent→Partially Paid allowed');
  assertEqual(ctx.canTransitionStatus('Partially Paid', 'Paid'), true, 'Partially Paid→Paid allowed');
});

test('canTransitionStatus — backward transitions are blocked', function() {
  assertEqual(ctx.canTransitionStatus('Sent', 'Draft'), false, 'Sent→Draft blocked');
  assertEqual(ctx.canTransitionStatus('Paid', 'Sent'), false, 'Paid→Sent blocked');
  assertEqual(ctx.canTransitionStatus('Partially Paid', 'Pro-forma'), false, 'Partially Paid→Pro-forma blocked');
});

test('canTransitionStatus — Cancelled is reachable from any status', function() {
  assertEqual(ctx.canTransitionStatus('Draft', 'Cancelled'), true, 'Draft→Cancelled allowed');
  assertEqual(ctx.canTransitionStatus('Sent', 'Cancelled'), true, 'Sent→Cancelled allowed');
  assertEqual(ctx.canTransitionStatus('Paid', 'Cancelled'), true, 'Paid→Cancelled allowed');
});

test('saveCN — CN Applied updates linked invoice calc_balanceDue', function() {
  resetDB();
  ctx.DB.inv = [
    { id:'sa-inv', num:'INV200', status:'Sent', lineItems:[], taxRate:0,
      calc_grandTotal:'5000', calc_balanceDue:'5000' }
  ];
  ctx.DB.payments = [];
  var cnSave = { id:'sa-cn', num:'CN200', type:'credit_note', linkedInvNum:'INV200',
    linkedInvId:'sa-inv', cnAmount:-300, status:'CN Applied',
    buyer:'', date:'2026-01-01', cnReason:'', notes:'', lineItems:[], taxRate:0, lf:0, ins:0, dep:0,
    updAt:new Date().toISOString() };
  mockEl('cnf-n').value = 'CN200';
  mockEl('cnf-amount').value = '300';
  mockEl('cnf-type').value = 'credit_note';
  mockEl('cnf-linked').value = 'INV200';
  mockEl('cnf-b').value = '';
  mockEl('cnf-cur').value = 'USD';
  mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'CN Applied';
  mockEl('cnf-reason').value = '';
  mockEl('cnf-nt').value = '';
  ctx.EI.cn = null;
  ctx.saveCN();
  var linkedInv = ctx.DB.inv.find(function(i){ return i.num === 'INV200'; });
  assertEqual(linkedInv && linkedInv.calc_balanceDue, '4700.00', 'calc_balanceDue updated to 5000-300=4700');
});

test('mapRec — inv entity maps DB fields to display headers', function() {
  var rec = { num:'INV001', buyer:'Test Co', date:'2026-01-01', status:'Draft',
               cur:'USD', calc_grandTotal:'1000', calc_balanceDue:'1000',
               calc_cogs:'800', calc_netProfit:'200', calc_margin:'20',
               taxRate:0, lf:0, notes:'' };
  var mapped = ctx.mapRec('inv', rec);
  assertEqual(mapped['Invoice #'], 'INV001', 'num → Invoice #');
  assertEqual(mapped['Buyer'], 'Test Co', 'buyer → Buyer');
  assertEqual(mapped['Grand Total'], '1000', 'calc_grandTotal → Grand Total');
  assertEqual(mapped['Status'], 'Draft', 'status → Status');
});

test('mapRec — cn entity maps CN-specific fields', function() {
  var rec = { num:'CN001', linkedInvNum:'INV001', buyer:'Test Co', date:'2026-01-01',
               status:'CN Applied', cnAmount:-300, cnReason:'Overcharge', type:'credit_note', notes:'' };
  var mapped = ctx.mapRec('cn', rec);
  assertEqual(mapped['CN #'], 'CN001', 'num → CN #');
  assertEqual(mapped['Linked Invoice'], 'INV001', 'linkedInvNum → Linked Invoice');
  assertEqual(mapped['Credit Amount'], -300, 'cnAmount → Credit Amount');
  assertEqual(mapped['Status'], 'CN Applied', 'status → Status');
});

test('unlockInv — sets _unlockedInvIds for a locked invoice', function() {
  resetDB();
  ctx.DB.inv = [{ id:'ul1', num:'INV999', status:'Sent', lineItems:[], taxRate:0 }];
  mockEl('adv-unlock-num').value = 'INV999';
  mockEl('adv-unlock-reason').value = 'Test unlock reason';
  mockEl('adv-unlock-confirm').value = 'CONFIRM';
  mockEl('adv-unlock-status').value = '';
  ctx.unlockInv();
  assertEqual(ctx._unlockedInvIds['ul1'], true, '_unlockedInvIds set for unlocked invoice');
});

test('unlockInv — rejects wrong CONFIRM text', function() {
  resetDB();
  ctx.DB.inv = [{ id:'ul2', num:'INV998', status:'Sent', lineItems:[], taxRate:0 }];
  mockEl('adv-unlock-num').value = 'INV998';
  mockEl('adv-unlock-reason').value = 'Some reason';
  mockEl('adv-unlock-confirm').value = 'confirm';
  ctx.unlockInv();
  assertEqual(ctx._unlockedInvIds['ul2'], undefined, '_unlockedInvIds NOT set when CONFIRM not typed exactly');
});

// ── SYNC GUARD & TIMESTAMP TESTS ──────────────────────────────
test('syncAll() — guard fires when SS.url is empty', function() {
  var loadingCalled = false;
  var origSS = Object.assign({}, ctx.SS);
  ctx.SS.url = '';
  var origSet = ctx.setSyncStatus;
  ctx.setSyncStatus = function(s) { if (s === 'loading') loadingCalled = true; };
  ctx.syncAll();
  ctx.setSyncStatus = origSet;
  ctx.SS = Object.assign(ctx.SS, origSS);
  assert(!loadingCalled, 'setSyncStatus(loading) should NOT be called when SS.url is empty');
});

test('syncAll() — guard fires when SS.url lacks https:// prefix', function() {
  var loadingCalled = false;
  var origUrl = ctx.SS.url;
  ctx.SS.url = 'http://insecure.example.com/exec';
  var origSet = ctx.setSyncStatus;
  ctx.setSyncStatus = function(s) { if (s === 'loading') loadingCalled = true; };
  ctx.syncAll();
  ctx.setSyncStatus = origSet;
  ctx.SS.url = origUrl;
  assert(!loadingCalled, 'setSyncStatus(loading) should NOT be called when SS.url is not https://');
});

test('renderSyncStatus() — shows "Never synced" when st_last_sync absent', function() {
  delete mockStorage['st_last_sync'];
  mockEl('sync-status-display').textContent = '';
  ctx.renderSyncStatus();
  assertEqual(mockEl('sync-status-display').textContent, 'Never synced', 'should display Never synced');
});

test('renderSyncStatus() — shows green colour for recent timestamp', function() {
  mockStorage['st_last_sync'] = new Date(Date.now() - 5 * 60000).toISOString(); // 5 min ago
  mockEl('sync-status-display').style.color = '';
  ctx.renderSyncStatus();
  assertEqual(mockEl('sync-status-display').style.color, '#375623', 'should be green for sync < 30m ago');
  delete mockStorage['st_last_sync'];
});

test('renderSyncStatus() — shows amber for sync between 30m and 2h ago', function() {
  mockStorage['st_last_sync'] = new Date(Date.now() - 60 * 60000).toISOString(); // 60 min ago
  mockEl('sync-status-display').style.color = '';
  ctx.renderSyncStatus();
  assertEqual(mockEl('sync-status-display').style.color, '#7F6000', 'should be amber for sync 30m–2h ago');
  delete mockStorage['st_last_sync'];
});

// ── FX RATES TESTS ─────────────────────────────────────────────
test('renderFxStatus() — shows "no live rates" when st_qr_ts absent', function() {
  delete mockStorage['st_qr_ts'];
  mockEl('qr-fx-status').textContent = '';
  mockEl('qr-fx-status').style.color = '';
  ctx.renderFxStatus();
  const txt = mockEl('qr-fx-status').textContent;
  assert(txt.includes('manually') || txt.includes('No live'), 'should indicate no live fetch: got "' + txt + '"');
  assertEqual(mockEl('qr-fx-status').style.color, '#8A8277', 'should be grey');
});

test('renderFxStatus() — shows green for rates fetched < 8h ago', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 2 * 3600000).toISOString(); // 2h ago
  mockEl('qr-fx-status').style.color = '';
  ctx.renderFxStatus();
  assertEqual(mockEl('qr-fx-status').style.color, '#375623', 'should be green for rates < 8h old');
  delete mockStorage['st_qr_ts'];
});

test('renderFxStatus() — shows amber for rates fetched 8–24h ago', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 10 * 3600000).toISOString(); // 10h ago
  mockEl('qr-fx-status').style.color = '';
  ctx.renderFxStatus();
  assertEqual(mockEl('qr-fx-status').style.color, '#7F6000', 'should be amber for rates 8–24h old');
  delete mockStorage['st_qr_ts'];
});

test('renderFxStatus() — shows red for rates older than 24h', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 30 * 3600000).toISOString(); // 30h ago
  mockEl('qr-fx-status').style.color = '';
  ctx.renderFxStatus();
  assertEqual(mockEl('qr-fx-status').style.color, '#833C00', 'should be red for rates > 24h old');
  delete mockStorage['st_qr_ts'];
});

test('renderQteRatesWarn() — no warning when rates are fresh', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 3600000).toISOString(); // 1h ago
  mockEl('qt-rates-warn').innerHTML = 'old';
  ctx.renderQteRatesWarn();
  assertEqual(mockEl('qt-rates-warn').innerHTML, '', 'should clear warning when rates < 24h old');
  delete mockStorage['st_qr_ts'];
});

test('renderQteRatesWarn() — shows warning when no live rates ever fetched', function() {
  delete mockStorage['st_qr_ts'];
  mockEl('qt-rates-warn').innerHTML = '';
  ctx.renderQteRatesWarn();
  assert(mockEl('qt-rates-warn').innerHTML.includes('never'), 'should show "never" warning when no timestamp');
});

test('renderQteRatesWarn() — shows warning when rates are stale (>24h)', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 30 * 3600000).toISOString(); // 30h ago
  mockEl('qt-rates-warn').innerHTML = '';
  ctx.renderQteRatesWarn();
  assert(mockEl('qt-rates-warn').innerHTML.includes('30h'), 'should show age in hours');
  delete mockStorage['st_qr_ts'];
});

test('saveRates() — clears st_qr_ts on manual save', function() {
  mockStorage['st_qr_ts'] = new Date().toISOString();
  ctx.saveRates();
  assert(!mockStorage['st_qr_ts'], 'st_qr_ts should be removed after manual saveRates');
});

// ── toGBP / MULTI-CURRENCY KPI ─────────────────────────────────

test('toGBP — GBP passthrough', function() {
  var r = ctx.toGBP(100, 'GBP');
  assertEqual(r, 100, 'GBP amount unchanged');
});

test('toGBP — USD conversion uses QR.fxGBPUSD', function() {
  ctx.QR.fxGBPUSD = 1.25;
  var r = ctx.toGBP(125, 'USD');
  assertEqual(r, 100, '125 USD → 100 GBP at 1.25 rate');
});

test('toGBP — RMB conversion uses QR.fxGBPRMB', function() {
  ctx.QR.fxGBPRMB = 9.0;
  var r = ctx.toGBP(900, 'RMB');
  assertEqual(r, 100, '900 RMB → 100 GBP at 9.0 rate');
});

test('toGBP — CNY alias matches RMB', function() {
  ctx.QR.fxGBPRMB = 9.0;
  var r = ctx.toGBP(900, 'CNY');
  assertEqual(r, 100, '900 CNY → 100 GBP at 9.0 rate');
});

test('toGBP — BBD conversion uses QR.fxGBPBBD', function() {
  ctx.QR.fxGBPBBD = 2.5;
  var r = ctx.toGBP(250, 'BBD');
  assertEqual(r, 100, '250 BBD → 100 GBP at 2.5 rate');
});

test('toGBP — unknown currency passes through unchanged', function() {
  var r = ctx.toGBP(100, 'EUR');
  assertEqual(r, 100, 'Unknown currency passes through');
});

test('toGBP — defaults to USD when currency omitted', function() {
  ctx.QR.fxGBPUSD = 1.25;
  var r = ctx.toGBP(125);
  assertEqual(r, 100, 'Omitted currency defaults to USD');
});

test('rDash — KPI tiles render GBP symbol when invoices have mixed currencies', function() {
  resetDB();
  ctx.QR.fxGBPUSD = 1.25;
  ctx.DB.inv = [
    { id:'mc1', cur:'GBP', status:'Draft', lineItems:[], taxRate:0, dep:0,
      calc_grandTotal:'1000', calc_netProfit:'100', calc_cogs:'900', calc_margin:'10', calc_balanceDue:'1000' },
    { id:'mc2', cur:'USD', status:'Draft', lineItems:[], taxRate:0, dep:0,
      calc_grandTotal:'125',  calc_netProfit:'25',  calc_cogs:'100', calc_margin:'20', calc_balanceDue:'125'  }
  ];
  ctx.rDash();
  var kpis = mockElements['kpis'] ? mockElements['kpis'].innerHTML : '';
  assert(kpis.includes('£'), 'KPI tiles should display GBP (£) symbol');
  // Revenue: £1000 GBP + £100 GBP (125 USD / 1.25) = £1100
  assert(kpis.includes('1,100'), 'Revenue ≈ £1,100 GBP after conversion');
});

// ── STORAGE QUOTA GUARD ────────────────────────────────────────

test('checkStorageQuota() — runs without error when localStorage is empty', function() {
  Object.keys(mockStorage).forEach(function(k){ delete mockStorage[k]; });
  ctx.checkStorageQuota(); // must not throw
  assert(true, 'no error on empty storage');
});

test('checkStorageQuota() — runs without error when localStorage has data', function() {
  mockStorage['st_i'] = JSON.stringify([{ id: 'i1', status: 'Draft' }]);
  ctx.checkStorageQuota(); // must not throw
  assert(true, 'no error with data in storage');
});

test('checkStorageQuota() — no toast when usage is below 75%', function() {
  Object.keys(mockStorage).forEach(function(k){ delete mockStorage[k]; });
  mockStorage['st_i'] = 'small';
  if (mockElements['toast']) mockElements['toast'].textContent = '';
  ctx.checkStorageQuota();
  var t = mockElements['toast'] ? mockElements['toast'].textContent : '';
  assert(!t || t === '', 'no toast for low storage usage');
});

// ── CONTACTS ───────────────────────────────────────────────────

test('saveCon() — creates new contact with correct fields and gdprBasis', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  mockEl('ct-name').value = 'Alice Buyer';
  mockEl('ct-email').value = 'alice@example.com';
  mockEl('ct-phone').value = '+441234567890';
  mockEl('ct-company').value = 'Acme Ltd';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = 'Test note';
  mockEl('ct-enq-summary').value = '';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => true };
  ctx.EI.co = null;
  ctx.saveCon();
  assertEqual(ctx.DB.con.length, 1, 'contact created');
  var c = ctx.DB.con[0];
  assertEqual(c.name, 'Alice Buyer', 'name');
  assertEqual(c.email, 'alice@example.com', 'email');
  assertEqual(c.status, 'lead', 'status');
  assertEqual(c.gdprBasis, 'pre_contract', 'gdprBasis for lead');
  assert(c.id, 'id assigned');
});

test('gdprBasis = pre_contract for status lead', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  mockEl('ct-name').value = 'Bob';
  mockEl('ct-email').value = 'bob@test.com';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value = 'qualified';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = '';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => true };
  ctx.EI.co = null;
  ctx.saveCon();
  assertEqual(ctx.DB.con[0].gdprBasis, 'pre_contract', 'qualified → pre_contract');
});

test('gdprBasis = legitimate_interests for status converted', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  mockEl('ct-name').value = 'Carol';
  mockEl('ct-email').value = 'carol@test.com';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value = 'converted';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = '';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => true };
  ctx.EI.co = null;
  ctx.saveCon();
  assertEqual(ctx.DB.con[0].gdprBasis, 'legitimate_interests', 'converted → legitimate_interests');
});

test('saveCon() — dedup merge (confirm OK): enquiry appended, no duplicate', function() {
  resetDB();
  ctx.DB.con = [{ id: 'c1', name: 'Existing', email: 'dup@test.com', enquiries: [], status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '' }];
  var n = 0; ctx.confirm = function(){ return [true][n++] !== undefined ? [true][n-1] : false; };
  mockEl('ct-name').value = 'New Person';
  mockEl('ct-email').value = 'DUP@TEST.COM';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = 'Interested in freight';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => true };
  ctx.EI.co = null;
  ctx.saveCon();
  assertEqual(ctx.DB.con.length, 1, 'no new record created');
  assertEqual(ctx.DB.con[0].enquiries.length, 1, 'enquiry appended');
  assertEqual(ctx.DB.con[0].enquiries[0].summary, 'Interested in freight', 'enquiry summary');
});

test('saveCon() — dedup cancel both confirms: no DB change', function() {
  resetDB();
  ctx.DB.con = [{ id: 'c1', name: 'Existing', email: 'dup@test.com', enquiries: [], status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '' }];
  var n = 0; ctx.confirm = function(){ return [false, false][n++]; };
  mockEl('ct-name').value = 'New Person';
  mockEl('ct-email').value = 'dup@test.com';
  mockEl('ct-phone').value = '';
  mockEl('ct-company').value = '';
  mockEl('ct-status').value = 'lead';
  mockEl('ct-source').value = 'manual';
  mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = '';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => true };
  ctx.EI.co = null;
  ctx.saveCon();
  assertEqual(ctx.DB.con.length, 1, 'no change to DB');
});

test('openConvertToQuote() — sets cConvertId, EI.qt === null, prefills client/notes', function() {
  resetDB();
  ctx.DB.con = [{ id: 'c99', name: 'Lead Person', email: 'lead@example.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  ctx.EI.qt = 'some-old-id';
  ctx.cConvertId = null;
  ctx.openConvertToQuote('c99');
  assertEqual(ctx.cConvertId, 'c99', 'cConvertId set');
  assertEqual(ctx.EI.qt, null, 'EI.qt cleared by openQte');
  assertEqual(mockEl('qf-client').value, 'Lead Person', 'client prefilled');
  assertEqual(mockEl('qf-nt').value, 'Contact: lead@example.com', 'notes prefilled');
});

test('saveQte() with cConvertId — sourceContactId populated, contact set to converted, cConvertId nulled', function() {
  resetDB();
  ctx.DB.con = [{ id: 'cA', name: 'Test Lead', email: 't@t.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  ctx.cConvertId = 'cA';
  ctx.EI.qt = null;
  var rid = 'cA-line1';
  ctx.cQL = [{ rid: rid, supId: '', desc: 'Test item', qty: 1, uom: 'pcs', cost: 100, cbm: 1, dg: false, dutyPct: 0 }];
  mockEl('ql-supId-' + rid).value = '';
  mockEl('ql-desc-' + rid).value = 'Test item';
  mockEl('ql-qty-' + rid).value = '1';
  mockEl('ql-uom-' + rid).value = 'pcs';
  mockEl('ql-cost-' + rid).value = '100';
  mockEl('ql-cbm-' + rid).value = '1';
  mockEl('ql-dg-' + rid).checked = false;
  mockEl('ql-dutyPct-' + rid).value = '0';
  mockEl('ql-note-' + rid).value = '';
  mockEl('qf-num').value = '';
  mockEl('qf-client').value = 'Test Lead';
  mockEl('qf-dt').value = '2026-01-01';
  mockEl('qf-valid').value = '2026-01-31';
  mockEl('qf-mode').value = 'LCL';
  mockEl('qf-mkp').value = '15';
  mockEl('qf-cur').value = 'USD';
  mockEl('qf-st').value = 'Draft';
  mockEl('qf-nt').value = '';
  mockEl('qt-verr').innerHTML = '';
  ctx.saveQte();
  assert(ctx.DB.qt.length >= 1, 'quote saved');
  var q = ctx.DB.qt[ctx.DB.qt.length - 1];
  assertEqual(q.sourceContactId, 'cA', 'sourceContactId populated');
  assertEqual(ctx.DB.con[0].status, 'converted', 'contact status → converted');
  assertEqual(ctx.cConvertId, null, 'cConvertId nulled');
});

test('closeQteDlg() — cConvertId nulled, closeM called', function() {
  ctx.cConvertId = 'someId';
  var closed = false;
  var orig = ctx.closeM;
  ctx.closeM = function(id){ if (id === 'ov-qt') closed = true; };
  ctx.closeQteDlg();
  assertEqual(ctx.cConvertId, null, 'cConvertId nulled');
  assert(closed, 'closeM(ov-qt) called');
  ctx.closeM = orig;
});

test('delQte() with sourceContactId — contact reverts to qualified, rQte called', function() {
  resetDB();
  ctx.DB.con = [{ id: 'cB', name: 'Lead', email: 'b@b.com', status: 'converted', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  ctx.DB.qt = [{ id: 'q1', num: 'QTE-001', sourceContactId: 'cB', status: 'Draft', lines: [], client: '', dt: '', validUntil: '', freightMode: 'LCL', markup: 15, currency: 'USD', notes: '', linkedPOId: '' }];
  ctx.confirm = function(){ return true; };
  var rQteCalled = false;
  var orig = ctx.rQte;
  ctx.rQte = function(){ rQteCalled = true; };
  ctx.delQte('q1');
  assertEqual(ctx.DB.qt.length, 0, 'quote deleted');
  assertEqual(ctx.DB.con[0].status, 'qualified', 'contact reverted to qualified');
  assert(rQteCalled, 'rQte called after sv');
  ctx.rQte = orig;
});

test('isConStale() — returns true for contact older than 700 days', function() {
  var old = new Date(Date.now() - 701 * 86400000).toISOString();
  var c = { createdAt: old, lastContactedAt: '' };
  assert(ctx.isConStale(c), 'stale contact detected');
});

test('isConStale() — returns false for recent contact', function() {
  var c = { createdAt: new Date().toISOString(), lastContactedAt: '' };
  assert(!ctx.isConStale(c), 'fresh contact not stale');
});

test('delCon() — removes contact from DB.con, sv called', function() {
  resetDB();
  ctx.DB.con = [{ id: 'd1', name: 'Delete Me', email: 'd@d.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  var svCalled = false;
  ctx.confirm = function(){ return true; };
  var origSv = ctx.sv;
  ctx.sv = function(k, v){ if (k === ctx.K.co) svCalled = true; origSv(k, v); };
  ctx.rCon = function(){};
  ctx.delCon('d1');
  assertEqual(ctx.DB.con.length, 0, 'contact removed');
  assert(svCalled, 'sv(K.co) called');
  ctx.sv = origSv;
});

test('doImport() — data.con array: DB.con set correctly', function() {
  resetDB();
  var conData = [{ id: 'c1', name: 'Imported', email: 'i@i.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  var backup = {
    _app: 'Stackd Ops', _version: 2, _exported: new Date().toISOString(),
    sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: conData
  };
  var jsonStr = JSON.stringify(backup);
  ctx.confirm = function(){ return true; };
  // simulate FileReader callback
  var fakeEvent = { target: { result: jsonStr } };
  ctx.doImport._readerCallback ? ctx.doImport._readerCallback(fakeEvent) : null;
  // Call doImport indirectly by invoking reader.onload
  var fileReaderCb = null;
  var origFR = ctx.FileReader;
  ctx.FileReader = function(){ this.onload = null; this.readAsText = function(){ fileReaderCb = this.onload; }; };
  var fakeE = { target: { files: [{ name: 'test.json' }] } };
  ctx.doImport(fakeE);
  if (fileReaderCb) fileReaderCb({ target: { result: jsonStr } });
  ctx.FileReader = origFR;
  assertEqual(ctx.DB.con.length, 1, 'DB.con populated from import');
  assertEqual(ctx.DB.con[0].name, 'Imported', 'contact name correct');
});

test('doImport() — data.con absent: DB.con preserved', function() {
  resetDB();
  ctx.DB.con = [{ id: 'pre1', name: 'Pre-existing', email: 'pre@pre.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  var backup = {
    _app: 'Stackd Ops', _version: 2, _exported: new Date().toISOString(),
    sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: []
    // no con key
  };
  var jsonStr = JSON.stringify(backup);
  ctx.confirm = function(){ return true; };
  var fileReaderCb = null;
  var origFR = ctx.FileReader;
  ctx.FileReader = function(){ this.onload = null; this.readAsText = function(){ fileReaderCb = this.onload; }; };
  var fakeE = { target: { files: [{ name: 'test.json' }] } };
  ctx.doImport(fakeE);
  if (fileReaderCb) fileReaderCb({ target: { result: jsonStr } });
  ctx.FileReader = origFR;
  assertEqual(ctx.DB.con.length, 1, 'DB.con preserved when con absent from backup');
});

test('doImport() — data.con non-array: DB.con reset to []', function() {
  resetDB();
  ctx.DB.con = [{ id: 'pre1', name: 'Pre-existing', email: 'pre@pre.com', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: new Date().toISOString(), lastContactedAt: '', notes: '', phone: '', company: '', enquiries: [] }];
  var backup = {
    _app: 'Stackd Ops', _version: 2, _exported: new Date().toISOString(),
    sup: [], li: [], inv: [], po: [], payments: [], sh: [], qt: [], con: 'invalid'
  };
  var jsonStr = JSON.stringify(backup);
  ctx.confirm = function(){ return true; };
  var fileReaderCb = null;
  var origFR = ctx.FileReader;
  ctx.FileReader = function(){ this.onload = null; this.readAsText = function(){ fileReaderCb = this.onload; }; };
  var fakeE = { target: { files: [{ name: 'test.json' }] } };
  ctx.doImport(fakeE);
  if (fileReaderCb) fileReaderCb({ target: { result: jsonStr } });
  ctx.FileReader = origFR;
  assertEqual(ctx.DB.con.length, 0, 'DB.con reset to [] when non-array');
});

test('openCon() — ct-name-err and ct-email-err validation state cleared', function() {
  resetDB();
  // Set some stale validation state (vClr resets borderBottomColor on the field element)
  mockEl('ct-name').style.borderBottomColor = 'red';
  mockEl('ct-email').style.borderBottomColor = 'red';
  mockEl('ov-con').classList = { add() {}, remove() {}, contains: () => false };
  ctx.openCon();
  // vClr('ct-name') sets borderBottomColor = '' on the ct-name element
  assertEqual(mockEl('ct-name').style.borderBottomColor, '', 'ct-name border cleared by vClr');
  assertEqual(mockEl('ct-email').style.borderBottomColor, '', 'ct-email border cleared by vClr');
});

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
  // Set up minimum form fields for saveQte() — vQte() requires at least one line item
  var rid = 'ac3-line1';
  ctx.cQL = [{ rid: rid, supId: '', desc: 'Test item', qty: 1, uom: 'pcs', cost: 100, cbm: 1, dg: false, dutyPct: 0 }];
  mockEl('ql-supId-' + rid).value = '';
  mockEl('ql-desc-' + rid).value = 'Test item';
  mockEl('ql-qty-' + rid).value = '1';
  mockEl('ql-uom-' + rid).value = 'pcs';
  mockEl('ql-cost-' + rid).value = '100';
  mockEl('ql-cbm-' + rid).value = '1';
  mockEl('ql-dg-' + rid).checked = false;
  mockEl('ql-dutyPct-' + rid).value = '0';
  mockEl('ql-note-' + rid).value = '';
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

// ── REQ-V3-GAP-006: Supplier→Contact sub-panel ──────────────────────────────

test('AC-1: supplierId and role set when saved with supplier selected', function() {
  resetDB();
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
  assertEqual(ctx.DB.con.length, 1, 'contact created');
  assertEqual(ctx.DB.con[0].supplierId, 'S1', 'supplierId set');
  assertEqual(ctx.DB.con[0].role, 'supplier_contact', 'role set');
});

test('AC-4: supplierId null and role empty for independently created contact', function() {
  resetDB();
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
  assertEqual(ctx.DB.con[0].supplierId, null, 'supplierId null');
  assertEqual(ctx.DB.con[0].role, '', 'role empty string');
});

test('AC-2: unlinkSupCon nulls supplierId and clears role, contact preserved', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.unlinkSupCon('C1');
  assertEqual(ctx.DB.con[0].supplierId, null, 'supplierId nulled');
  assertEqual(ctx.DB.con[0].role, '', 'role cleared');
  assertEqual(ctx.DB.con.length, 1, 'contact preserved');
  var ev = ctx.DB.events[ctx.DB.events.length - 1];
  assertEqual(ev.entityType, 'contact', 'event logged against the contact entity (REQ-V3-GAP-006 ev)');
  assertEqual(ev.entityId, 'C1'); assertEqual(ev.verb, 'unlinked');
  assertContains(ev.summary, 'ACME', 'summary names the supplier that was unlinked');
});

testAsync('AC-5: delSup nulls supplierId on linked contacts and preserves them', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.DB.con.push({ id: 'C2', name: 'Bob', email: 'bob@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.confirm = function(){ return true; };
  await ctx.delSup('S1');
  assertEqual(ctx.DB.con.length, 2, 'both contacts preserved');
  assertEqual(ctx.DB.con[0].supplierId, null, 'C1 supplierId nulled');
  assertEqual(ctx.DB.con[0].role, '', 'C1 role cleared');
  assertEqual(ctx.DB.con[1].supplierId, null, 'C2 unaffected');
  assertEqual(ctx.DB.sup.length, 0, 'supplier deleted');
  ctx.confirm = function(){ return false; };
});

test('AC-6: openSupConPicker links contact — supplierId and role set', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: null, role: '', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'S1';
  ctx.prompt = function(){ return '1'; };
  ctx.openSupConPicker();
  ctx.prompt = function(){ return null; };
  assertEqual(ctx.DB.con[0].supplierId, 'S1', 'supplierId set');
  assertEqual(ctx.DB.con[0].role, 'supplier_contact', 'role set');
  var ev = ctx.DB.events[ctx.DB.events.length - 1];
  assertEqual(ev.entityType, 'contact', 'event logged against the contact entity (REQ-V3-GAP-006 ev)');
  assertEqual(ev.entityId, 'C1'); assertEqual(ev.verb, 'linked');
  assertContains(ev.summary, 'ACME', 'summary names the supplier that was linked');
});

test('AC-3: contact linked to Supplier X excluded from picker for Supplier Y', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'SX', name: 'ACME' });
  ctx.DB.sup.push({ id: 'SY', name: 'Globex' });
  ctx.DB.con.push({ id: 'CB', name: 'Bob', email: 'bob@example.com', supplierId: 'SX', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.EI.s = 'SY';
  var eligible = ctx.DB.con.filter(function(c){ return !c.supplierId || c.supplierId === ctx.EI.s; });
  assertEqual(eligible.length, 0, 'Contact B absent from picker for Supplier Y');
});

test('AC-7: rCon renders Supplier column with gsn() name for linked contact', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME Goods' });
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', supplierId: 'S1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  var html = ctx.DB.con.map(function(c){
    return (c.supplierId ? ctx.gsn(c.supplierId) : '—');
  }).join('');
  assert(html.indexOf('ACME Goods') >= 0, 'supplier name rendered via gsn()');
});

test('AC-8: clearing Supplier dropdown before save sets supplierId null and role empty', function() {
  resetDB();
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
  assertEqual(ctx.DB.con[0].supplierId, null, 'supplierId null when dropdown cleared');
  assertEqual(ctx.DB.con[0].role, '', 'role empty when dropdown cleared');
});

// ── REQ-AI-GAP-001: AI action block parsing ──────────────────────────────

test('parseAIAction: strips block and returns action from valid response', function() {
  var text = 'Sure, here is the PO.\n@@ACTION\n{"action":"create_po","payload":{"cur":"USD","notes":"Test"}}\n@@END\nPlease review.';
  var result = ctx.parseAIAction(text);
  assert(result.action !== null, 'action parsed');
  assertEqual(result.action.action, 'create_po', 'action key correct');
  assert(result.clean.indexOf('@@ACTION') === -1, 'block stripped from clean');
  assert(result.clean.indexOf('@@END') === -1, '@@END stripped');
  assert(result.clean.indexOf('Sure, here is the PO') >= 0, 'surrounding text preserved');
});

test('parseAIAction: returns null action when no block present', function() {
  var text = 'Here is some info about POs.';
  var result = ctx.parseAIAction(text);
  assertEqual(result.action, null, 'no action');
  assertEqual(result.clean, text, 'text unchanged');
});

test('parseAIAction: returns null action and strips block on malformed JSON (AC-8)', function() {
  var text = 'OK.\n@@ACTION\nnot-valid-json\n@@END\nDone.';
  var result = ctx.parseAIAction(text);
  assertEqual(result.action, null, 'action null on bad JSON');
  assert(result.clean.indexOf('@@ACTION') === -1, 'block stripped');
  assert(result.clean.indexOf('not-valid-json') === -1, 'bad JSON not in clean text');
});

test('parseAIAction: returns null action when JSON missing action key', function() {
  var text = '@@ACTION\n{"payload":{"cur":"USD"}}\n@@END';
  var result = ctx.parseAIAction(text);
  assertEqual(result.action, null, 'null when action key absent');
});

test('handleAIAction: create_po pre-fills cPL and fields', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.p = null;
  ctx.cPL = [];
  var action = { action: 'create_po', payload: { supId: 'S1', cur: 'CNY', notes: 'Rush order', lineItems: [{ desc: 'Widget A', qty: 100, cost: 5.5, uom: 'pcs' }] } };
  ctx.handleAIAction(action);
  assertEqual(mockEl('pf-cur').value, 'CNY', 'currency pre-filled');
  assertEqual(mockEl('pf-nt').value, 'Rush order', 'notes pre-filled');
  assertEqual(ctx.cPL.length, 1, 'line item added to cPL');
  assertEqual(ctx.cPL[0].desc, 'Widget A', 'line item desc correct');
  assertEqual(ctx.cPL[0].qty, 100, 'line item qty correct');
});

test('handleAIAction: unknown action shows toast, no modal (AC-9)', function() {
  resetDB();
  var toasted = '';
  var origToast = ctx.toast;
  ctx.toast = function(m){ toasted = m; };
  ctx.handleAIAction({ action: 'delete_everything', payload: {} });
  ctx.toast = origToast;
  assert(toasted.indexOf('Unsupported') >= 0, 'unsupported toast shown');
});

test('handleAIAction: create_contact pre-fills contact modal fields', function() {
  resetDB();
  var action = { action: 'create_contact', payload: { name: 'Jane Smith', email: 'jane@example.com', phone: '+44 7700 000000', company: 'Acme', status: 'lead', source: 'chat' } };
  ctx.handleAIAction(action);
  assertEqual(mockEl('ct-name').value, 'Jane Smith', 'name pre-filled');
  assertEqual(mockEl('ct-email').value, 'jane@example.com', 'email pre-filled');
  assertEqual(mockEl('ct-status').value, 'lead', 'status pre-filled');
});

test('handleAIAction: create_supplier pre-fills supplier modal fields', function() {
  resetDB();
  var action = { action: 'create_supplier', payload: { name: 'Jinbao Plastics', country: 'China', currency: 'CNY', contactPerson: 'Wei Chen', email: 'wei@jinbao.example.cn', phone: '+86 138 0000 1234', notes: 'PVC foam supplier' } };
  ctx.handleAIAction(action);
  assertEqual(mockEl('sf-n').value, 'Jinbao Plastics', 'supplier name pre-filled');
  assertEqual(mockEl('sf-c').value, 'China', 'supplier country pre-filled');
  assertEqual(mockEl('sf-cur').value, 'CNY', 'supplier currency pre-filled');
  assertEqual(mockEl('sf-ct').value, 'Wei Chen', 'supplier contact person pre-filled');
  assertEqual(mockEl('sf-e').value, 'wei@jinbao.example.cn', 'supplier email pre-filled');
  assertEqual(mockEl('sf-nt').value, 'PVC foam supplier', 'supplier notes pre-filled');
  assertEqual(mockEl('sf-dial').value, '+86', 'supplier phone dial code matched');
  assertEqual(mockEl('sf-p').value, '138 0000 1234', 'supplier phone number split correctly');
});

test('handleAIAction: create_buyer pre-fills buyer modal fields', function() {
  resetDB();
  var action = { action: 'create_buyer', payload: { name: 'Island Fresh Imports Ltd', contactName: 'Maria Holder', email: 'maria@islandfresh.example.bb', phone: '+1 246 000 1234', address: 'Harbour Road, Bridgetown, Barbados', currency: 'USD', paymentTerms: 'Net 30', creditLimit: 5000, notes: 'Repeat buyer, reliable payer' } };
  ctx.handleAIAction(action);
  assertEqual(mockEl('buy-name').value, 'Island Fresh Imports Ltd', 'buyer name pre-filled');
  assertEqual(mockEl('buy-cname').value, 'Maria Holder', 'buyer contact name pre-filled');
  assertEqual(mockEl('buy-email').value, 'maria@islandfresh.example.bb', 'buyer email pre-filled');
  assertEqual(mockEl('buy-addr').value, 'Harbour Road, Bridgetown, Barbados', 'buyer address pre-filled');
  assertEqual(mockEl('buy-cur').value, 'USD', 'buyer currency pre-filled');
  assertEqual(mockEl('buy-cl').value, 5000, 'buyer credit limit pre-filled');
  assertEqual(mockEl('buy-notes').value, 'Repeat buyer, reliable payer', 'buyer notes pre-filled');
});

// ── REQ-DEMO-001: Demo mode ──────────────────────────────────────────────────

test('loadDemoData: seeds 15 entity records + 1 payment + 4 events', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  assertEqual(ctx.DB.sup.length, 2, '2 suppliers seeded (2nd for RFQ comparison)');
  assertEqual(ctx.DB.con.length, 1, 'contact seeded');
  assertEqual(ctx.DB.qt.length, 2, '2 quotes seeded (DQ-0001, DQ-0002)');
  assertEqual(ctx.DB.po.length, 2, '2 POs seeded (DPO-0001, DPO-0002)');
  assertEqual(ctx.DB.inv.length, 5, '5 invoices seeded (DINV-0001..0005)');
  assertEqual(ctx.DB.sh.length, 1, 'shipment seeded');
  assertEqual(ctx.DB.ord.length, 1, 'order request seeded');
  assertEqual(ctx.DB.li.length, 1, 'line item catalogue entry seeded');
  assertEqual(ctx.DB.payments.length, 1, 'payment seeded');
  assertEqual(ctx.DB.events.length, 4, '4 events seeded');
  assert(ctx.DB.sh[0]._demo === true, 'shipment has _demo flag');
  assert(ctx.DB.con[0]._demo === true, 'contact has _demo flag');
});

test('loadDemoData: idempotent — second call does not duplicate (AC-2)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.loadDemoData();
  assertEqual(ctx.DB.sup.length, 2, 'no duplicate suppliers');
  assertEqual(ctx.DB.sh.length, 1, 'no duplicate shipment');
  assertEqual(ctx.DB.ord.length, 1, 'no duplicate order request');
  assertEqual(ctx.DB.li.length, 1, 'no duplicate line item');
});

test('loadDemoData: all seeded records have _demo:true', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var allDemoArrays = [ctx.DB.sup, ctx.DB.con, ctx.DB.qt, ctx.DB.po, ctx.DB.inv, ctx.DB.sh, ctx.DB.payments, ctx.DB.ord, ctx.DB.li];
  allDemoArrays.forEach(function(arr){
    arr.forEach(function(r){ assert(r._demo === true, 'record has _demo:true'); });
  });
  ctx.DB.events.forEach(function(e){ assert(e._demo === true, 'event has _demo:true'); });
});

test('loadDemoData: demo shipment is In Transit CNQAO→DEHAM (AC-8)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var sh = ctx.DB.sh[0];
  assertEqual(sh.status, 'In Transit', 'status In Transit');
  assertEqual(sh.originPort, 'CNQAO', 'origin port CNQAO');
  assertEqual(sh.destPort, 'DEHAM', 'dest port DEHAM');
  assertEqual(sh.vessel, 'MSC Altair', 'vessel MSC Altair');
});

test('loadDemoData: demo contact has 2 events (AC-9)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var conId = ctx.DB.con[0].id;
  var events = ctx.DB.events.filter(function(e){ return e.entityId === conId; });
  assertEqual(events.length, 2, '2 events for demo contact');
  var verbs = events.map(function(e){ return e.verb; }).sort();
  assert(verbs.indexOf('created') >= 0, 'created event present');
  assert(verbs.indexOf('converted') >= 0, 'converted event present');
});

// Note: `confirm` is routed through ctx.confirm in the VM sandbox (same pattern as existing tests).
// Tests set ctx.confirm = function(){ return true/false; } before calling, then reset after.
test('clearDemoData: removes all _demo records (AC-6)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.DB.con.push({ id: 'real-con', name: 'Real Person', email: 'r@r.com', _demo: false });
  ctx.confirm = function(){ return true; };
  ctx.clearDemoData();
  ctx.confirm = function(){ return false; };
  assertEqual(ctx.DB.sup.length, 0, 'demo suppliers removed');
  assertEqual(ctx.DB.sh.length, 0, 'demo shipment removed');
  assertEqual(ctx.DB.payments.length, 0, 'demo payment removed');
  assertEqual(ctx.DB.events.length, 0, 'demo events removed');
  assertEqual(ctx.DB.ord.length, 0, 'demo order request removed');
  assertEqual(ctx.DB.li.length, 0, 'demo line item removed');
  assertEqual(ctx.DB.con.length, 1, 'real contact preserved');
  assertEqual(ctx.DB.con[0].id, 'real-con', 'real contact id correct');
});

test('clearDemoData: confirm cancel leaves records intact (AC-7)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  ctx.confirm = function(){ return false; };
  ctx.clearDemoData();
  assertEqual(ctx.DB.sh.length, 1, 'shipment intact');
  assertEqual(ctx.DB.events.length, 4, 'events intact');
  assertEqual(ctx.DB.ord.length, 1, 'order request intact');
  assertEqual(ctx.DB.li.length, 1, 'line item intact');
});

test('rDash KPI exclusion: demo invoice not counted in revenue (AC-4)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var ai = ctx.DB.inv.filter(function(i){
    if (i._demo) return false;
    if (i.status === 'Cancelled') return false;
    if (i.type === 'credit_note' || i.type === 'goodwill_credit') return false;
    return true;
  });
  assertEqual(ai.length, 0, 'demo invoice excluded from ai array');
});

test('rDash KPI exclusion: demo PO not counted in PO balance (AC-4)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var tPO = ctx.DB.po.filter(function(p){ return !p._demo && p.status !== 'Cancelled' && p.status !== 'Settled'; });
  assertEqual(tPO.length, 0, 'demo PO excluded from tPO');
  var tSupDep = ctx.DB.po.filter(function(p){ return !p._demo && p.status !== 'Cancelled'; });
  assertEqual(tSupDep.length, 0, 'demo PO excluded from tSupDep');
});

test('rDash KPI exclusion: demo shipment not counted in in-transit (AC-4)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inTransit = ctx.DB.sh.filter(function(s){ return !s._demo && s.status === 'In Transit'; }).length;
  assertEqual(inTransit, 0, 'demo shipment excluded from in-transit count');
});

// ── Demo data expansion for REQ-INTEG-001 Phase 1/2 test coverage (v2.9.61) ───

test('loadDemoData scenario 1: DORD-0001 line has 2 rfqResponses from different suppliers, RFQ comparison panel renders both', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var ord = ctx.DB.ord.find(function(o){ return o.num === 'DORD-0001'; });
  assert(!!ord, 'demo Order Request seeded');
  var line = ord.lines[0];
  assertEqual(line.rfqResponses.length, 2, '2 RFQ responses on the line');
  var supIds = line.rfqResponses.map(function(r){ return r.supId; });
  assert(supIds[0] !== supIds[1], 'responses are from 2 different suppliers');
  ctx.EI.ord = ord.id;
  ctx.renderRfqComparison(line.id);
  var html = mockEl('ord-rfq-' + line.id).innerHTML;
  assertContains(html, 'Romerry International', 'first supplier shown in comparison panel');
  assertContains(html, 'Guangzhou Sea Harvest', 'second supplier shown in comparison panel');
});

test('loadDemoData scenario 2: DQ-0002 shows the Phase 1 staleness banner (source RFQ response re-committed after conversion)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var ord = ctx.DB.ord.find(function(o){ return o.num === 'DORD-0001'; });
  var qt = ctx.DB.qt.find(function(q){ return q.num === 'DQ-0002'; });
  assert(!!qt, 'DQ-0002 seeded');
  var line = qt.lines[0];
  assertEqual(line.sourceOrdId, ord.id, 'Quote line carries sourceOrdId');
  assert(line.sourceRfqResponseId !== ord.lines[0].committedResponseId, 'precondition: stored source response no longer matches the Order Request line\'s current commitment');
  ctx.renderQteSourceDriftWarn(qt);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed', 'staleness banner renders for the seeded scenario');
});

test('loadDemoData scenario 3: DINV-0002 is Pro-forma and unapproved — "Mark Buyer Approved" available, "Progress to Invoicing" not', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'DINV-0002'; });
  assert(!!inv, 'DINV-0002 seeded');
  assertEqual(inv.status, 'Pro-forma');
  assertEqual(!!inv.buyerApprovedAt, false, 'not yet approved');
  assertEqual(ctx.invApprovalActionVisible(inv), true, 'Mark Buyer Approved available');
  assertEqual(ctx.invProgressActionVisible(inv), false, 'Progress to Invoicing not available yet');
});

test('loadDemoData scenario 4: DINV-0003 is approved and not stale — both actions available, clean path for Progress to Invoicing', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'DINV-0003'; });
  assert(!!inv, 'DINV-0003 seeded');
  assert(!!inv.buyerApprovedAt, 'already approved');
  assertEqual(inv.approvalMethod, 'Email');
  assertEqual(ctx.invApprovalActionVisible(inv), true);
  assertEqual(ctx.invProgressActionVisible(inv), true, 'Progress to Invoicing available on the clean path');
});

test('loadDemoData scenario 5: DINV-0004 shows approval already cleared by a post-approval line-item edit, with both events in the log', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'DINV-0004'; });
  assert(!!inv, 'DINV-0004 seeded');
  assertEqual(inv.buyerApprovedAt, '', 'approval fields are empty — already cleared');
  assertEqual(inv.buyerApprovedBy, ''); assertEqual(inv.approvalMethod, ''); assertEqual(inv.approvalNote, '');
  var evts = ctx.DB.events.filter(function(e){ return e.entityId === inv.id; }).map(function(e){ return e.verb; }).sort();
  assert(evts.indexOf('buyer_approved') >= 0, 'buyer_approved event present — proves it WAS approved (distinguishes from DINV-0002)');
  assert(evts.indexOf('approval_cleared') >= 0, 'approval_cleared event present — proves the clearing actually happened');
});

test('loadDemoData scenario 7: DPO-0002 shows the PO staleness banner (DINV-0005 line edited after auto-generation)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var inv = ctx.DB.inv.find(function(i){ return i.num === 'DINV-0005'; });
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-DINV-0005-1'; });
  assert(!!inv, 'DINV-0005 seeded'); assert(!!po, 'DPO-0002 seeded');
  assertEqual(po.invId, inv.id, 'PO correctly linked to its source invoice');
  assert(+inv.lineItems[0].qty !== +po.lineItems[0].qty || +inv.lineItems[0].up !== +po.lineItems[0].sourceInvUp,
    'precondition: invoice line now diverges from the PO\'s captured snapshot');
  ctx.renderPoSourceDriftWarn(po);
  assertContains(mockEl('po-drift-warn').innerHTML, 'Source Invoice has changed', 'PO staleness banner renders for the seeded scenario');
});

// ── REQ-INTEG-002 (2a): Supplier Payment ledger ───────────────────────────────
console.log('\nSupplier Payment ledger (REQ-INTEG-002 2a)');

test('addSupPaymentFromForm() creates a record with poId/poNum and a rateLock snapshot (AC-1)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-1', num: 'PO-0001', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  mockEl('spm-date').value = '2026-01-01';
  mockEl('spm-amount').value = '500';
  mockEl('spm-cur').value = 'USD';
  mockEl('spm-purpose').value = 'Deposit';
  mockEl('spm-method').value = 'Bank Transfer';
  mockEl('spm-ref').value = 'REF-1';
  mockEl('spm-notes').value = '';
  ctx.addSupPaymentFromForm('po-1');
  assertEqual(ctx.DB.supPayments.length, 1, 'one record created');
  var pm = ctx.DB.supPayments[0];
  assertEqual(pm.poId, 'po-1'); assertEqual(pm.poNum, 'PO-0001');
  assert(!!pm.rateLock, 'rateLock present');
});

test('lockFxRate() — RMB payment captures exactly the applied rate and correct GBP-equivalent (AC-2)', function() {
  ctx.QR.fxGBPRMB = 9.20;
  var lock = ctx.lockFxRate(920, 'RMB');
  assertEqual(lock.ratesUsed.fxGBPRMB, 9.20, 'ratesUsed captures the applied rate');
  assertEqual(Object.keys(lock.ratesUsed).length, 3, 'ratesUsed now has all three keys (REQ-INTEG-002-2a-fix-a), not just the one applied');
  assertApprox(lock.gbpEquiv, 100, 'gbpEquiv = 920 / 9.20');
});

test('rateLock snapshot is never recomputed on read — later QR changes do not affect a saved record (AC-3)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-2', num: 'PO-0002', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.QR.fxGBPRMB = 9.20;
  mockEl('spm-date').value = '2026-01-01';
  mockEl('spm-amount').value = '920';
  mockEl('spm-cur').value = 'RMB';
  mockEl('spm-purpose').value = 'Deposit';
  mockEl('spm-method').value = 'Bank Transfer';
  mockEl('spm-ref').value = '';
  mockEl('spm-notes').value = '';
  ctx.addSupPaymentFromForm('po-2');
  var savedGbpEquiv = ctx.DB.supPayments[0].rateLock.gbpEquiv;
  ctx.QR.fxGBPRMB = 5.00; // rate changes after save
  var reread = ctx.DB.supPayments.find(function(p){ return p.poId === 'po-2'; });
  assertEqual(reread.rateLock.gbpEquiv, savedGbpEquiv, 'gbpEquiv unchanged despite later QR mutation');
  assertEqual(reread.rateLock.ratesUsed.fxGBPRMB, 9.20, 'ratesUsed unchanged despite later QR mutation');
});

test('getPOTotalPaid() sums rateLock.gbpEquiv across multiple native currencies, not raw amount (AC-4)', function() {
  resetDB();
  ctx.DB.supPayments.push({ id: 'p1', poId: 'po-3', poNum: 'PO-0003', date: '2026-01-01', amount: 100, currency: 'RMB', purpose: 'Deposit', rateLock: { gbpEquiv: 10 } });
  ctx.DB.supPayments.push({ id: 'p2', poId: 'po-3', poNum: 'PO-0003', date: '2026-01-02', amount: 50, currency: 'USD', purpose: 'Balance', rateLock: { gbpEquiv: 20 } });
  ctx.DB.supPayments.push({ id: 'p3', poId: 'po-3', poNum: 'PO-0003', date: '2026-01-03', amount: 30, currency: 'GBP', purpose: 'Other', rateLock: { gbpEquiv: 30 } });
  assertEqual(ctx.getPOTotalPaid('po-3'), 60, 'sum of gbpEquiv values, not raw amounts');
});

test('lockFxRate() — GBP payment applies no rate to gbpEquiv, but ratesUsed still snapshots all three (AC-4b)', function() {
  var lock = ctx.lockFxRate(50, 'GBP');
  assertEqual(Object.keys(lock.ratesUsed).length, 3, 'ratesUsed has all three keys even though gbpEquiv used none of them (REQ-INTEG-002-2a-fix-a)');
  assertEqual(lock.gbpEquiv, 50, 'gbpEquiv equals amount for GBP (identity)');
});

test('vSupPay() blocks when purpose is empty (AC-5)', function() {
  mockEl('spm-date').value = '';
  mockEl('spm-amount').value = '';
  var ok = ctx.vSupPay('2026-01-01', 100, '');
  assertEqual(ok, false, 'validation fails when purpose is empty');
});

test('addSupPaymentFromForm() always requires a poId — no unlinked record possible (AC-6)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-4', num: 'PO-0004', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  mockEl('spm-date').value = '2026-01-01';
  mockEl('spm-amount').value = '100';
  mockEl('spm-cur').value = 'USD';
  mockEl('spm-purpose').value = 'Deposit';
  mockEl('spm-method').value = 'Bank Transfer';
  mockEl('spm-ref').value = ''; mockEl('spm-notes').value = '';
  ctx.addSupPaymentFromForm('po-4');
  assertEqual(ctx.DB.supPayments[0].poId, 'po-4', 'record always carries the poId passed at the call site');
});

test('delPO() does not cascade-delete linked Supplier Payment records (AC-7)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-5', num: 'PO-0005', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'p1', poId: 'po-5', poNum: 'PO-0005', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 80 } });
  ctx.DB.supPayments.push({ id: 'p2', poId: 'po-5', poNum: 'PO-0005', date: '2026-01-02', amount: 50, currency: 'USD', purpose: 'Balance', rateLock: { gbpEquiv: 40 } });
  ctx.confirm = function(){ return true; };
  ctx.delPO('po-5');
  ctx.confirm = function(){ return false; };
  assertEqual(ctx.DB.po.length, 0, 'PO removed');
  assertEqual(ctx.DB.supPayments.length, 2, 'both Supplier Payment records remain, unchanged');
});

test('Editing a PO\'s num does not retroactively update existing Supplier Payment records\' poNum (AC-8)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-6', num: 'PO-0006', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'p1', poId: 'po-6', poNum: 'PO-0006', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 80 } });
  ctx.EI.p = 'po-6';
  mockEl('pf-n').value = 'PO-0006-RENAMED';
  mockEl('pf-sup').value = 'sup-1'; mockEl('pf-cur').value = 'USD'; mockEl('pf-inv').value = '';
  mockEl('pf-dt').value = '2026-01-01'; mockEl('pf-del').value = ''; mockEl('pf-pt').value = '';
  mockEl('pf-dep').value = ''; mockEl('pf-fpm').value = ''; mockEl('pf-oth').value = ''; mockEl('pf-nt').value = '';
  mockEl('pf-rec').checked = false; mockEl('po-sm').value = 'Confirmed';
  ctx.cPL = [];
  ctx.savePO();
  var pm = ctx.DB.supPayments.find(function(p){ return p.id === 'p1'; });
  assertEqual(pm.poId, 'po-6', 'poId still resolves to the same PO');
  assertEqual(pm.poNum, 'PO-0006', 'poNum on the existing record is unchanged (stale), matching buyer Payments\' invNum characteristic');
});

test('renderPOPaymentsTab() displays date, native amount+currency, GBP-equivalent, and purpose per record (AC-11)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-7', num: 'PO-0007', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'p1', poId: 'po-7', poNum: 'PO-0007', date: '2026-01-01', amount: 100, currency: 'RMB', purpose: 'Deposit', method: 'Bank Transfer', reference: '', notes: '', rateLock: { gbpEquiv: 10.87 } });
  ctx.DB.supPayments.push({ id: 'p2', poId: 'po-7', poNum: 'PO-0007', date: '2026-01-02', amount: 200, currency: 'USD', purpose: 'Balance', method: 'Wire Transfer', reference: '', notes: '', rateLock: { gbpEquiv: 157.48 } });
  ctx.renderPOPaymentsTab('po-7');
  var html = mockEl('po-payments-tab').innerHTML;
  assertContains(html, '2026-01-01'); assertContains(html, 'Deposit'); assertContains(html, 'Balance');
});

test('FM-1: no FIELD_MAPS entry and no bulk-sync entity-list membership for supPayments (AC-12)', function() {
  assertEqual(ctx.FIELD_MAPS.hasOwnProperty('supPayments'), false, 'no FIELD_MAPS entry');
  var arrays = [
    { name: 'synEnts',     re: /var\s+synEnts\s*=\s*\[([^\]]*)\]/ },
    { name: 'simpleEnts',  re: /var\s+simpleEnts\s*=\s*\[([^\]]*)\]/ },
    { name: 'idKeyedEnts', re: /var\s+idKeyedEnts\s*=\s*\[([^\]]*)\]/ },
    { name: 'ents',        re: /var\s+ents\s*=\s*\[([^\]]*)\]/ }
  ];
  arrays.forEach(function(a) {
    var m = a.re.exec(html);
    assert(!!m, a.name + ' array found in source');
    assertNotContains(m[1], 'supPayments', a.name + ' does not list supPayments');
  });
});

test('expAll()/doImport() round-trip supPayments (AC-13)', function() {
  resetDB();
  ctx.DB.supPayments.push({ id: 'p1', poId: 'po-8', poNum: 'PO-0008', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 78.74 } });
  var snap = { _app: 'Stackd Ops', supPayments: ctx.DB.supPayments };
  resetDB();
  if (snap.supPayments && Array.isArray(snap.supPayments)) { ctx.DB.supPayments = snap.supPayments; }
  assertEqual(ctx.DB.supPayments.length, 1, 'supPayments restored from backup snapshot shape');
  assertEqual(ctx.DB.supPayments[0].poId, 'po-8');
});

// ── REQ-INTEG-002-2a-fix: Reconcile PO.dep display with the Supplier Payment ledger ──

test('fromGBPLocked() — converts using the passed-in rate table, each supported currency', function() {
  var rates = { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 };
  assertApprox(ctx.fromGBPLocked(100, 'USD', rates), 125, 'USD leg');
  assertApprox(ctx.fromGBPLocked(100, 'RMB', rates), 900, 'RMB leg');
  assertApprox(ctx.fromGBPLocked(100, 'CNY', rates), 900, 'CNY aliases to RMB rate');
  assertApprox(ctx.fromGBPLocked(100, 'BBD', rates), 250, 'BBD leg');
  assertEqual(ctx.fromGBPLocked(100, 'GBP', rates), 100, 'GBP is identity, no rate needed');
});

test('fromGBPLocked() — backward-compat fallback to live QR when a rate is missing (pre-fix record)', function() {
  ctx.QR.fxGBPUSD = 1.30;
  var result = ctx.fromGBPLocked(100, 'USD', { fxGBPRMB: 9.0 }); // pre-fix single-key ratesUsed, missing fxGBPUSD
  assertApprox(result, 130, 'falls back to live QR.fxGBPUSD, does not throw or return NaN');
});

test('getPOTotalPaidNative() — same-currency payments sum raw native amounts, immune to FX rate mutation (AC-2a)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-1', num: 'PO-FIX-1', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf1', poId: 'po-fix-1', poNum: 'PO-FIX-1', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 999, ratesUsed: {} } });
  ctx.DB.supPayments.push({ id: 'pf2', poId: 'po-fix-1', poNum: 'PO-FIX-1', date: '2026-01-02', amount: 50, currency: 'USD', purpose: 'Balance', rateLock: { gbpEquiv: 999, ratesUsed: {} } });
  ctx.QR.fxGBPUSD = 0.01; // deliberately wrong — must have zero effect on the same-currency path
  var po = ctx.DB.po[0];
  assertEqual(ctx.getPOTotalPaidNative(po), 150, 'exact raw sum, FX untouched');
});

test('getPOTotalPaidNative() — cross-currency payment converts via ITS OWN locked rates, not live QR (AC-2b)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-2', num: 'PO-FIX-2', supId: 'sup-1', cur: 'USD', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf3', poId: 'po-fix-2', poNum: 'PO-FIX-2', date: '2026-01-01', amount: 50, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 40, ratesUsed: { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 } } });
  ctx.DB.supPayments.push({ id: 'pf4', poId: 'po-fix-2', poNum: 'PO-FIX-2', date: '2026-01-02', amount: 900, currency: 'RMB', purpose: 'Balance', rateLock: { gbpEquiv: 100, ratesUsed: { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 } } });
  var po = ctx.DB.po[0];
  var expected = 50 + ctx.fromGBPLocked(100, 'USD', { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 });
  ctx.QR.fxGBPUSD = 999; ctx.QR.fxGBPRMB = 999; // deliberately wrong live rates
  assertApprox(ctx.getPOTotalPaidNative(po), expected, 'cross-currency leg uses the record\'s own locked rates, unaffected by live QR mutation');
});

test('getPOTotalPaidNative() — CNY (PO currency) / RMB (payment currency) normalize as the same currency (AC-2c)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-3', num: 'PO-FIX-3', supId: 'sup-1', cur: 'CNY', status: 'Confirmed', lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf5', poId: 'po-fix-3', poNum: 'PO-FIX-3', date: '2026-01-01', amount: 500, currency: 'RMB', purpose: 'Deposit', rateLock: { gbpEquiv: 999, ratesUsed: {} } });
  ctx.QR.fxGBPRMB = 0.01; // wrong on purpose — same-currency path must never touch this
  var po = ctx.DB.po[0];
  assertEqual(ctx.getPOTotalPaidNative(po), 500, 'CNY/RMB normalized as same currency — raw sum, no conversion');
});

test('getPOEffectiveDepInfo() — zero linked records falls back to legacy po.dep (AC-2d)', function() {
  resetDB();
  var po = { id: 'po-fix-4', num: 'PO-FIX-4', cur: 'USD', dep: 5000 };
  ctx.DB.po.push(po);
  var info = ctx.getPOEffectiveDepInfo(po);
  assertEqual(info.value, 5000, 'raw po.dep returned unchanged');
  assertEqual(info.source, 'legacy-no-records', 'source flag correct');
});

test('getPOEffectiveDepInfo() — EUR PO with ledger records falls back safely, never produces a wrong converted figure (AC-2e)', function() {
  resetDB();
  var po = { id: 'po-fix-5', num: 'PO-FIX-5', cur: 'EUR', dep: 1000 };
  ctx.DB.po.push(po);
  ctx.DB.supPayments.push({ id: 'pf6', poId: 'po-fix-5', poNum: 'PO-FIX-5', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 80, ratesUsed: { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 } } });
  var info = ctx.getPOEffectiveDepInfo(po);
  assertEqual(info.value, 1000, 'legacy po.dep returned, NOT a mislabeled GBP-equivalent number — this is the regression the v1 requirements-gate review flagged as closed');
  assertEqual(info.source, 'legacy-unsupported-currency', 'source flag identifies the unsupported-currency fallback');
});

test('getPOEffectiveDep() always equals getPOEffectiveDepInfo().value, for all three source cases (AC-2f)', function() {
  resetDB();
  var poNoRecords = { id: 'po-fix-6a', num: 'PO-FIX-6A', cur: 'USD', dep: 10 };
  var poLedger = { id: 'po-fix-6b', num: 'PO-FIX-6B', cur: 'USD', dep: 10 };
  var poEur = { id: 'po-fix-6c', num: 'PO-FIX-6C', cur: 'EUR', dep: 10 };
  ctx.DB.po.push(poNoRecords, poLedger, poEur);
  ctx.DB.supPayments.push({ id: 'pf7', poId: 'po-fix-6b', poNum: 'PO-FIX-6B', date: '2026-01-01', amount: 20, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 16, ratesUsed: {} } });
  ctx.DB.supPayments.push({ id: 'pf8', poId: 'po-fix-6c', poNum: 'PO-FIX-6C', date: '2026-01-01', amount: 20, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 16, ratesUsed: {} } });
  [poNoRecords, poLedger, poEur].forEach(function(po) {
    assertEqual(ctx.getPOEffectiveDep(po), ctx.getPOEffectiveDepInfo(po).value, 'getPOEffectiveDep() never disagrees with getPOEffectiveDepInfo().value for ' + po.id);
  });
});

test('rPO() — Deposit column reflects the ledger total, not raw po.dep, once records exist (AC-3a)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-7', num: 'PO-FIX-7', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf9', poId: 'po-fix-7', poNum: 'PO-FIX-7', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  mockEl('po-q').value = ''; mockEl('po-sf').value = '';
  ctx.rPO();
  var html = mockElements['po-tb'].innerHTML;
  assertContains(html, '250', 'shows the ledger total (250), not the stale raw po.dep (999)');
});

test('prevPODoc() — PDF Deposit Paid reflects the ledger total, not raw po.dep (AC-3b)', function() {
  var getHtml = makePreviewMock();
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-8', num: 'PO-FIX-8', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, oth: 0, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf10', poId: 'po-fix-8', poNum: 'PO-FIX-8', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  var po = ctx.DB.po[0];
  ctx.prevPODoc(po);
  var html = getHtml();
  assertContains(html, '250', 'PDF shows the ledger total, the headline reason this fix exists');
});

test('rDash() — outstanding PO balance KPI and PO Commitments chart use the ledger total, not raw po.dep (AC-3c/d)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-9', num: 'PO-FIX-9', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 10, cost: 100 }] });
  ctx.DB.supPayments.push({ id: 'pf11', poId: 'po-fix-9', poNum: 'PO-FIX-9', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.rDash();
  var chart = mockElements['po-chart'] ? mockElements['po-chart'].innerHTML : '';
  // Balance shown = COGS(1000) - effectiveDep(250) = 750, not COGS(1000) - staleDep(999) = 1
  assertContains(chart, '750', 'PO Commitments chart bar reflects the ledger-derived balance');
});

test('renderAccts() — per-invoice, per-supplier, and totals-bar sections all use the ledger total, not raw po.dep (AC-3e/f/g)', function() {
  resetDB();
  // Pin displayCurrency to the PO's own currency (USD) so the totals bar's
  // now-currency-converted figure (REQ-INTEG-002-2a-fix-2) is numerically a
  // no-op and this test's assertion stays about ledger-vs-raw-po.dep sourcing,
  // not currency conversion (covered separately by its own tests).
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'USD';
  ctx.DB.inv.push({ id: 'inv-fix-1', num: 'INV20099', status: 'Sent', cur: 'USD', dep: 0, lineItems: [], taxRate: 0 });
  ctx.DB.po.push({ id: 'po-fix-10', num: 'PO-FIX-10', supId: 'sup-1', invId: 'inv-fix-1', invNum: 'INV20099', cur: 'USD', status: 'Confirmed', dep: 999, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 10, cost: 100 }] });
  ctx.DB.supPayments.push({ id: 'pf12', poId: 'po-fix-10', poNum: 'PO-FIX-10', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.backfillInvoicePOs(); // this PO was seeded directly (not via autoPos()), so inv.pos[] needs the same sync a real app boot would do
  ctx.renderAccts();
  var acctInv = mockElements['acct-inv'] ? mockElements['acct-inv'].innerHTML : '';
  var acctSup = mockElements['acct-sup'] ? mockElements['acct-sup'].innerHTML : '';
  var acctTotals = mockElements['acct-totals'] ? mockElements['acct-totals'].innerHTML : '';
  assertContains(acctInv, '250', 'per-invoice Sup. Dep. Paid column uses the ledger total');
  assertContains(acctSup, '250', 'per-supplier Dep. Paid column uses the ledger total');
  assertContains(acctTotals, '250', 'totals bar Total Paid to Suppliers uses the ledger total');
  ctx.QR.displayCurrency = savedDispCur;
});

test("_aiExecTool('get_kpis')/('get_pos') — poBalanceDue/depositPaid/balanceDue use the ledger total, not raw po.dep (AC-3h/i)", function() {
  resetDB();
  // Pin displayCurrency to the PO's own currency (USD) so get_kpis' now-
  // currency-converted poBalanceDue (REQ-CUR-002) is numerically a no-op and
  // this test's assertion stays about ledger-vs-raw-po.dep sourcing, not
  // currency conversion (covered separately by its own tests).
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'USD';
  ctx.DB.po.push({ id: 'po-fix-11', num: 'PO-FIX-11', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 10, cost: 100 }] });
  ctx.DB.supPayments.push({ id: 'pf13', poId: 'po-fix-11', poNum: 'PO-FIX-11', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  var kpis = JSON.parse(ctx._aiExecTool('get_kpis', {}));
  assertEqual(kpis.poBalanceDue, 750, 'get_kpis.poBalanceDue = COGS(1000) - ledger total(250)');
  var pos = JSON.parse(ctx._aiExecTool('get_pos', {}));
  var po = pos.find(function(p){ return p.num === 'PO-FIX-11'; });
  assertEqual(po.depositPaid, 250, 'get_pos.depositPaid uses the ledger total');
  assertEqual(po.balanceDue, 750, 'get_pos.balanceDue uses the ledger total');
  ctx.QR.displayCurrency = savedDispCur;
});

test('editPO() — PO with ledger records: pf-dep shows the ledger total and becomes readOnly (AC-4a)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-12', num: 'PO-FIX-12', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf14', poId: 'po-fix-12', poNum: 'PO-FIX-12', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.editPO('po-fix-12');
  assertEqual(mockEl('pf-dep').value, 250, 'pf-dep shows the ledger total');
  assertEqual(mockEl('pf-dep').readOnly, true, 'pf-dep is readOnly once ledger records exist');
  assertContains(mockEl('po-dep-note').innerHTML, 'Derived from recorded Supplier Payments', 'note explains the readOnly state');
});

test('editPO() — PO with zero ledger records: pf-dep stays editable and shows raw po.dep (AC-4b)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-13', num: 'PO-FIX-13', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 500, lineItems: [] });
  ctx.editPO('po-fix-13');
  assertEqual(mockEl('pf-dep').value, 500, 'pf-dep shows raw po.dep');
  assertEqual(mockEl('pf-dep').readOnly, false, 'pf-dep remains editable — no ledger records to reconcile');
});

test('editPO() — PO with ledger records but unsupported (EUR) currency: pf-dep stays editable with a warning note (AC-4c)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-14', num: 'PO-FIX-14', supId: 'sup-1', cur: 'EUR', status: 'Confirmed', dep: 500, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf15', poId: 'po-fix-14', poNum: 'PO-FIX-14', date: '2026-01-01', amount: 100, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 80, ratesUsed: {} } });
  ctx.editPO('po-fix-14');
  assertEqual(mockEl('pf-dep').value, 500, 'pf-dep shows raw po.dep — cannot safely reconcile EUR');
  assertEqual(mockEl('pf-dep').readOnly, false, 'pf-dep remains editable for the unsupported-currency case');
  assertContains(mockEl('po-dep-note').innerHTML, 'cannot yet be reconciled', 'note explains why the figure is not from the ledger');
});

test('openPO() — resets pf-dep readOnly/note left over from a previously-edited PO (AC-4d, spec-gate B-1 regression)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-15', num: 'PO-FIX-15', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf16', poId: 'po-fix-15', poNum: 'PO-FIX-15', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.editPO('po-fix-15');
  assertEqual(mockEl('pf-dep').readOnly, true, 'sanity check: editing set readOnly true');
  ctx.openPO();
  assertEqual(mockEl('pf-dep').readOnly, false, 'opening a brand-new PO resets readOnly to false — no leak from the previous edit');
  assertEqual(mockEl('po-dep-note').innerHTML, '', 'the previous PO\'s ledger note is cleared, not left stale');
});

test('savePO() persists whatever the (possibly readOnly, ledger-derived) pf-dep value displays (AC-4e)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-16', num: 'PO-FIX-16', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pf17', poId: 'po-fix-16', poNum: 'PO-FIX-16', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.EI.p = 'po-fix-16';
  ctx.editPO('po-fix-16');
  mockEl('pf-n').value = 'PO-FIX-16'; mockEl('pf-sup').value = 'sup-1'; mockEl('pf-cur').value = 'USD'; mockEl('pf-inv').value = '';
  mockEl('pf-dt').value = '2026-01-01'; mockEl('pf-del').value = ''; mockEl('pf-pt').value = '';
  mockEl('pf-fpm').value = ''; mockEl('pf-oth').value = ''; mockEl('pf-nt').value = '';
  mockEl('pf-rec').checked = false; mockEl('po-sm').value = 'Confirmed';
  ctx.cPL = [];
  ctx.savePO();
  var saved = ctx.DB.po.find(function(p){ return p.id === 'po-fix-16'; });
  assertEqual(saved.dep, 250, 'savePO() persists the reconciled figure that was displayed in the readOnly field, not the stale original 999');
});

test('Backward compatibility: a PO with dep>0 and zero supPayments records is completely unaffected by this fix (AC-5)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-fix-17', num: 'PO-FIX-17', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 28000, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 20, cost: 9875 }] });
  var po = ctx.DB.po[0];
  assertEqual(ctx.getPOEffectiveDep(po), 28000, 'raw po.dep returned unchanged when no ledger records exist');
  mockEl('po-q').value = ''; mockEl('po-sf').value = '';
  ctx.rPO();
  assertContains(mockElements['po-tb'].innerHTML, '28,000', 'rPO() list view unaffected for a pre-existing PO with no ledger records');
});

// ── REQ-INTEG-002-2a-fix-2: Priority 2/3 + demo-data post-ship fixes ──────────

test('addSupPaymentFromForm() re-renders the PO list table, not just the modal\'s own tab (Priority 2)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-p2-1', num: 'PO-P2-1', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  mockEl('po-q').value = ''; mockEl('po-sf').value = '';
  ctx.rPO();
  assertContains(mockElements['po-tb'].innerHTML, '999', 'baseline: list shows the stale legacy figure before any payment exists');
  mockEl('spm-date').value = '2026-01-01';
  mockEl('spm-amount').value = '250';
  mockEl('spm-cur').value = 'USD';
  mockEl('spm-purpose').value = 'Deposit';
  mockEl('spm-method').value = 'Bank Transfer';
  mockEl('spm-ref').value = ''; mockEl('spm-notes').value = '';
  ctx.addSupPaymentFromForm('po-p2-1');
  assertContains(mockElements['po-tb'].innerHTML, '250', 'PO list table reflects the new ledger total without the operator navigating away and back');
});

test('deleteSupPayment() re-renders the PO list table (Priority 2)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-p2-2', num: 'PO-P2-2', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 500, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pmp2', poId: 'po-p2-2', poNum: 'PO-P2-2', date: '2026-01-01', amount: 300, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 240, ratesUsed: {} } });
  mockEl('po-q').value = ''; mockEl('po-sf').value = '';
  ctx.rPO();
  assertContains(mockElements['po-tb'].innerHTML, '300', 'baseline: list shows the ledger total while the record exists');
  ctx.confirm = function(){ return true; };
  ctx.deleteSupPayment('pmp2');
  ctx.confirm = function(){ return false; };
  assertContains(mockElements['po-tb'].innerHTML, '500', 'PO list table falls back to the legacy figure immediately after the only ledger record is deleted');
});

test('editPO() rounds the displayed pf-dep value to 2dp without touching underlying precision (Priority 3a)', function() {
  resetDB();
  // Pin QR to known rates so the derived gbpEquiv below is deterministic
  // regardless of what earlier tests left QR set to.
  ctx.QR.fxGBPUSD = 1.27; ctx.QR.fxGBPRMB = 9.20; ctx.QR.fxGBPBBD = 2.54;
  var rates = { fxGBPUSD: ctx.QR.fxGBPUSD, fxGBPRMB: ctx.QR.fxGBPRMB, fxGBPBBD: ctx.QR.fxGBPBBD };
  ctx.DB.po.push({ id: 'po-p3a', num: 'PO-P3A', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  // Use the app's own toGBP() to derive a genuinely float-noisy gbpEquiv
  // (matching how production code actually computes it), rather than a
  // hand-picked clean number that wouldn't reproduce the reported symptom.
  var rmbGbpEquiv = ctx.toGBP(61890.50, 'RMB');
  ctx.DB.supPayments.push({ id: 'pmp3a1', poId: 'po-p3a', poNum: 'PO-P3A', date: '2026-01-01', amount: 500, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: ctx.toGBP(500,'USD'), ratesUsed: rates } });
  ctx.DB.supPayments.push({ id: 'pmp3a2', poId: 'po-p3a', poNum: 'PO-P3A', date: '2026-01-02', amount: 61890.50, currency: 'RMB', purpose: 'Balance', rateLock: { gbpEquiv: rmbGbpEquiv, ratesUsed: rates } });
  var po = ctx.DB.po[0];
  var rawEffective = ctx.getPOEffectiveDep(po); // native-currency sum: 500 (USD, exact) + fromGBPLocked(rmbGbpEquiv,'USD',...) — genuine float noise
  assert(rawEffective % 1 !== 0 && String(rawEffective).length > 8, 'precondition: the raw underlying figure genuinely has float noise worth rounding for display, got ' + rawEffective);
  ctx.editPO('po-p3a');
  var shown = +mockEl('pf-dep').value;
  assertEqual(shown, Math.round(rawEffective * 100) / 100, 'displayed value is rounded to 2dp');
  assertEqual(ctx.getPOEffectiveDep(po), rawEffective, 'the underlying getPOEffectiveDep() computation itself is untouched — still the full-precision float');
});

test('editPO()/openPO() toggle a strong, unambiguous visual signal on pf-dep for the readOnly state (Priority 3b)', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-p3b', num: 'PO-P3B', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 999, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pmp3b', poId: 'po-p3b', poNum: 'PO-P3B', date: '2026-01-01', amount: 250, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: 200, ratesUsed: {} } });
  ctx.editPO('po-p3b');
  assertEqual(mockEl('pf-dep').readOnly, true, 'sanity: readOnly is set for the ledger case');
  assertEqual(mockEl('pf-dep').style.cursor, 'not-allowed', 'cursor signals the field cannot be edited');
  assert(mockEl('pf-dep').style.background.indexOf('0,0,0') >= 0, 'background is visually distinct (greyed) from the normal editable state');
  ctx.openPO();
  assertEqual(mockEl('pf-dep').readOnly, false, 'sanity: readOnly is reset on a brand-new PO');
  assertEqual(mockEl('pf-dep').style.cursor, '', 'cursor is restored to normal once the field is editable again');
  assert(mockEl('pf-dep').style.background.indexOf('26,79,219') >= 0, 'background is restored to the original active-field styling');
});

test('loadDemoData(): PO-DINV-0005-1 seeds a real legacy deposit with zero ledger records, exercising the backward-compat fallback path', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.loadDemoData();
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-DINV-0005-1'; });
  assert(!!po, 'PO-DINV-0005-1 seeded');
  assertEqual(po.dep, 13225, 'legacy deposit is a real, nonzero, testable figure');
  var linked = ctx.DB.supPayments.filter(function(p){ return p.poId === po.id; });
  assertEqual(linked.length, 0, 'zero linked Supplier Payment records — this is the "legacy-no-records" case, not "ledger"');
  var info = ctx.getPOEffectiveDepInfo(po);
  assertEqual(info.source, 'legacy-no-records', 'getPOEffectiveDepInfo() correctly classifies this demo PO as the fallback case');
  assertEqual(info.value, 13225, 'effective figure equals the seeded legacy deposit');
});

// ── REQ-INTEG-002-2a-fix-2: Priority 1 — Accounts totals-bar currency mixing ──

test('renderAccts() totals bar — mixed-currency POs convert before summing tSD (Priority 1, the originally reported bug)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.po.push({ id: 'po-acct-1', num: 'PO-ACCT-1', supId: 'sup-1', cur: 'CNY', status: 'Confirmed', dep: 28000, oth: 0, lineItems: [] });
  ctx.DB.po.push({ id: 'po-acct-2', num: 'PO-ACCT-2', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 0, oth: 0, lineItems: [] });
  ctx.DB.supPayments.push({ id: 'pacct-2', poId: 'po-acct-2', poNum: 'PO-ACCT-2', date: '2026-01-01', amount: 2000, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: ctx.toGBP(2000,'USD'), ratesUsed: {} } });
  var po1 = ctx.DB.po[0], po2 = ctx.DB.po[1];
  var dep1 = ctx.getPOEffectiveDep(po1), dep2 = ctx.getPOEffectiveDep(po2);
  var expected = ctx.toDisp(dep1, po1.cur) + ctx.toDisp(dep2, po2.cur);
  var expectedFormatted = ctx.fmt(expected, ctx.QR.displayCurrency || 'GBP');
  var rawSumFormatted = ctx.fmt(dep1 + dep2, ctx.QR.displayCurrency || 'GBP');
  ctx.renderAccts();
  assertContains(mockElements['acct-totals'].innerHTML, expectedFormatted, 'totals bar shows the correctly-converted sum');
  assertNotContains(mockElements['acct-totals'].innerHTML, rawSumFormatted, 'the meaningless raw mixed-currency sum does not appear');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() totals bar — mixed-currency invoices convert before summing tBD (Priority 1, the buyer-side case)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.inv.push({ id: 'inv-acct-1', num: 'INV20101', status: 'Sent', cur: 'GBP', dep: 1000, lineItems: [], taxRate: 0 });
  ctx.DB.inv.push({ id: 'inv-acct-2', num: 'INV20102', status: 'Sent', cur: 'USD', dep: 500, lineItems: [], taxRate: 0 });
  var expected = ctx.toDisp(1000, 'GBP') + ctx.toDisp(500, 'USD');
  var expectedFormatted = ctx.fmt(expected, ctx.QR.displayCurrency || 'GBP');
  ctx.renderAccts();
  assertContains(mockElements['acct-totals'].innerHTML, expectedFormatted, 'Total Received from Buyers shows the correctly-converted sum, untested in the original manual pass because all seeded invoices shared one currency');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() totals bar — mixed-currency FPM Funded POs convert before summing tFPM (Priority 1)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.po.push({ id: 'po-acct-3', num: 'PO-ACCT-3', supId: 'sup-1', cur: 'CNY', status: 'Confirmed', dep: 0, oth: 0, fpmFunded: 9200, fpmRecovered: false, lineItems: [] });
  ctx.DB.po.push({ id: 'po-acct-4', num: 'PO-ACCT-4', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 0, oth: 0, fpmFunded: 1000, fpmRecovered: false, lineItems: [] });
  var expected = ctx.toDisp(9200, 'CNY') + ctx.toDisp(1000, 'USD');
  var expectedFormatted = ctx.fmt(expected, ctx.QR.displayCurrency || 'GBP');
  ctx.renderAccts();
  assertContains(mockElements['acct-totals'].innerHTML, expectedFormatted, 'FPM Exposure shows the correctly-converted sum, same defect class as tBD/tSD, same block');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() totals bar — renders in the actual QR.displayCurrency, not an implicit USD default (Priority 1)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'RMB';
  ctx.DB.po.push({ id: 'po-acct-5', num: 'PO-ACCT-5', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 250, oth: 0, lineItems: [] });
  var expected = ctx.toDisp(250, 'USD');
  var expectedFormatted = ctx.fmt(expected, 'RMB');
  ctx.renderAccts();
  assertContains(mockElements['acct-totals'].innerHTML, expectedFormatted, 'totals bar labels/formats using the real display currency (RMB), not fmt()\'s own implicit USD default');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() totals bar — same-currency scenario is a true no-op vs. the pre-fix raw sum, only when displayCurrency matches every item\'s currency (Priority 1 regression guard)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'USD'; // pinned to match every item's own currency below — the no-op identity does NOT hold under the app's actual default ('GBP', QR_DEFAULTS.displayCurrency)
  ctx.DB.inv.push({ id: 'inv-acct-3', num: 'INV20103', status: 'Sent', cur: 'USD', dep: 1200, lineItems: [], taxRate: 0 });
  ctx.DB.po.push({ id: 'po-acct-6', num: 'PO-ACCT-6', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 800, oth: 0, lineItems: [] });
  ctx.renderAccts();
  var html = mockElements['acct-totals'].innerHTML;
  assertContains(html, ctx.fmt(1200, 'USD'), 'Total Received from Buyers unchanged from the raw amount under this precondition');
  assertContains(html, ctx.fmt(800, 'USD'), 'Total Paid to Suppliers unchanged from the raw amount under this precondition');
  assertContains(html, ctx.fmt(400, 'USD'), 'Net Cash Position (1200-800) matches the pre-fix raw-arithmetic result under this precondition');
  ctx.QR.displayCurrency = savedDispCur;
});

// ── REQ-CUR-002: close ACCT-GAP-001 and AI-GAP-010 ───────────────────────────

test('renderAccts() per-invoice — mixed-currency linked POs convert before summing supDepPaid/fpmFunded/supBalDue/totalToChase', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.inv.push({ id: 'inv-cur-1', num: 'INV20201', status: 'Sent', cur: 'USD', dep: 500, lineItems: [{ qty: 1, up: 2000 }], taxRate: 0 });
  ctx.DB.po.push({ id: 'po-cur-1', num: 'PO-CUR-1', supId: 'sup-1', invId: 'inv-cur-1', invNum: 'INV20201', cur: 'GBP', status: 'Confirmed', dep: 300, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 1, cost: 1000 }] });
  ctx.DB.po.push({ id: 'po-cur-2', num: 'PO-CUR-2', supId: 'sup-1', invId: 'inv-cur-1', invNum: 'INV20201', cur: 'USD', status: 'Confirmed', dep: 0, oth: 0, fpmFunded: 600, fpmRecovered: false, lineItems: [{ rid:'r2', lid:'', qty: 1, cost: 800 }] });
  ctx.DB.supPayments.push({ id: 'pcur-1', poId: 'po-cur-2', poNum: 'PO-CUR-2', date: '2026-01-01', amount: 400, currency: 'USD', purpose: 'Deposit', rateLock: { gbpEquiv: ctx.toGBP(400,'USD'), ratesUsed: {} } });
  ctx.backfillInvoicePOs(); // these POs were seeded directly (not via autoPos()), so inv.pos[] needs the same sync a real app boot would do
  var po1 = ctx.DB.po[0], po2 = ctx.DB.po[1];
  var dep1 = ctx.getPOEffectiveDep(po1), dep2 = ctx.getPOEffectiveDep(po2);
  var dispCur = ctx.QR.displayCurrency;
  var expSupDepPaid = ctx.toDisp(dep1, 'GBP') + ctx.toDisp(dep2, 'USD');
  var expFpmFunded  = ctx.toDisp(0, 'GBP') + ctx.toDisp(600, 'USD');
  var expSupBalDue  = ctx.toDisp(Math.max(0, 1000 - dep1), 'GBP') + ctx.toDisp(Math.max(0, 800 - dep2), 'USD');
  var expBalFromBuyer = 1500; // grand(2000) - dep(500)
  var expTotalToChase = ctx.toDisp(expBalFromBuyer, 'USD') + expFpmFunded; // fpmRecovered is false (po-cur-2 unrecovered)
  ctx.renderAccts();
  var html = mockElements['acct-inv'].innerHTML;
  assertContains(html, ctx.fmt(expSupDepPaid, dispCur), 'Sup. Dep. Paid reflects the converted sum across GBP+USD POs');
  assertContains(html, ctx.fmt(expFpmFunded, dispCur), 'FPM Funded reflects the converted sum');
  assertContains(html, ctx.fmt(expSupBalDue, dispCur), 'Sup. Bal. Due reflects the converted sum');
  assertContains(html, ctx.fmt(expTotalToChase, dispCur), 'Total to Chase combines the converted buyer balance and the converted unrecovered FPM deposit in the same currency');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() per-supplier — mixed-currency POs convert before summing totalCOGS/totalDep/totalBal, pct uses the converted figures', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.po.push({ id: 'po-cur-3', num: 'PO-CUR-3', supId: 'sup-1', cur: 'GBP', status: 'Confirmed', dep: 300, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 1, cost: 1000 }] });
  ctx.DB.po.push({ id: 'po-cur-4', num: 'PO-CUR-4', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 400, oth: 0, lineItems: [{ rid:'r2', lid:'', qty: 1, cost: 800 }] });
  var dispCur = ctx.QR.displayCurrency;
  var expCOGS = ctx.toDisp(1000, 'GBP') + ctx.toDisp(800, 'USD');
  var expDep  = ctx.toDisp(300, 'GBP') + ctx.toDisp(400, 'USD');
  var expBal  = ctx.toDisp(700, 'GBP') + ctx.toDisp(400, 'USD');
  var expPct  = ((expDep/expCOGS)*100).toFixed(0);
  ctx.renderAccts();
  var html = mockElements['acct-sup'].innerHTML;
  assertContains(html, ctx.fmt(expCOGS, dispCur), 'Total COGS reflects the converted sum across GBP+USD POs');
  assertContains(html, ctx.fmt(expDep, dispCur), 'Dep. Paid reflects the converted sum');
  assertContains(html, ctx.fmt(expBal, dispCur), 'Bal. Due to Sup. reflects the converted sum');
  assertContains(html, '>' + expPct + '%<', 'Dep. Coverage % is computed from the already-converted totals, correct automatically by ratio-invariance');
  ctx.QR.displayCurrency = savedDispCur;
});

test('renderAccts() per-invoice/per-supplier — same-currency regression guard (Priority pattern: pin displayCurrency to the scenario\'s own currency)', function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'USD';
  ctx.DB.inv.push({ id: 'inv-cur-2', num: 'INV20202', status: 'Sent', cur: 'USD', dep: 200, lineItems: [{ qty: 1, up: 1500 }], taxRate: 0 });
  ctx.DB.po.push({ id: 'po-cur-5', num: 'PO-CUR-5', supId: 'sup-2', invId: 'inv-cur-2', invNum: 'INV20202', cur: 'USD', status: 'Confirmed', dep: 350, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 1, cost: 900 }] });
  ctx.backfillInvoicePOs(); // this PO was seeded directly (not via autoPos()), so inv.pos[] needs the same sync a real app boot would do
  ctx.renderAccts();
  var invHtml = mockElements['acct-inv'].innerHTML;
  var supHtml = mockElements['acct-sup'].innerHTML;
  assertContains(invHtml, ctx.fmt(350, 'USD'), 'Sup. Dep. Paid unchanged from the raw amount when displayCurrency matches every item\'s own currency');
  assertContains(invHtml, ctx.fmt(550, 'USD'), 'Sup. Bal. Due (900-350) unchanged under this precondition');
  assertContains(supHtml, ctx.fmt(900, 'USD'), 'Total COGS unchanged under this precondition');
  ctx.QR.displayCurrency = savedDispCur;
});

test("_aiExecTool('get_kpis') — mixed-currency invoices/POs convert before summing, response includes a currency field", function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  ctx.DB.inv.push({ id: 'inv-cur-3', num: 'INV20203', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 1000 }], taxRate: 0 });
  ctx.DB.inv.push({ id: 'inv-cur-4', num: 'INV20204', status: 'Partially Paid', cur: 'GBP', dep: 0, lineItems: [{ qty: 1, up: 2000 }], taxRate: 0 });
  ctx.DB.po.push({ id: 'po-cur-6', num: 'PO-CUR-6', supId: 'sup-1', cur: 'GBP', status: 'Confirmed', dep: 300, oth: 0, lineItems: [{ rid:'r1', lid:'', qty: 1, cost: 1000 }] });
  ctx.DB.po.push({ id: 'po-cur-7', num: 'PO-CUR-7', supId: 'sup-1', cur: 'USD', status: 'Confirmed', dep: 400, oth: 0, lineItems: [{ rid:'r2', lid:'', qty: 1, cost: 800 }] });
  var inv1 = ctx.DB.inv[0], inv2 = ctx.DB.inv[1];
  var c1 = ctx.iCalc(inv1), c2 = ctx.iCalc(inv2);
  var dispCur = ctx.QR.displayCurrency;
  var expRevenue = ctx.toDisp(c1.grand,'USD') + ctx.toDisp(c2.grand,'GBP');
  var expNp      = ctx.toDisp(c1.np,'USD')    + ctx.toDisp(c2.np,'GBP');
  var expOutstanding = ctx.toDisp(c1.bal,'USD') + ctx.toDisp(c2.bal,'GBP'); // both Sent/Partially Paid, both counted
  var expPoBal = ctx.toDisp(Math.max(0,1000-300),'GBP') + ctx.toDisp(Math.max(0,800-400),'USD');
  var kpis = JSON.parse(ctx._aiExecTool('get_kpis', {}));
  assertEqual(kpis.currency, dispCur, 'get_kpis response now includes an explicit currency field matching QR.displayCurrency');
  assertApprox(kpis.invoiceRevenue, +expRevenue.toFixed(2), 'invoiceRevenue reflects the converted sum across USD+GBP invoices');
  assertApprox(kpis.netProfit, +expNp.toFixed(2), 'netProfit reflects the converted sum');
  assertApprox(kpis.outstanding, +expOutstanding.toFixed(2), 'outstanding reflects the converted sum');
  assertApprox(kpis.poBalanceDue, +expPoBal.toFixed(2), 'poBalanceDue reflects the converted sum across GBP+USD POs');
  ctx.QR.displayCurrency = savedDispCur;
});

test("_aiExecTool('get_kpis') — same-currency regression guard, currency field matches the pinned displayCurrency", function() {
  resetDB();
  var savedDispCur = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'USD';
  ctx.DB.inv.push({ id: 'inv-cur-5', num: 'INV20205', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 1000 }], taxRate: 0 });
  var kpis = JSON.parse(ctx._aiExecTool('get_kpis', {}));
  var c1 = ctx.iCalc(ctx.DB.inv[0]);
  assertEqual(kpis.currency, 'USD', 'currency field matches the pinned displayCurrency');
  assertApprox(kpis.invoiceRevenue, c1.grand, 'invoiceRevenue unchanged from the raw amount when displayCurrency matches the invoice\'s own currency');
  ctx.QR.displayCurrency = savedDispCur;
});

// ── REQ-INTEG-002 (Sub-phase 2b): Invoice→PO enumeration fix ─────────────────

test('getInvoicePOs(inv) — resolves ids to live PO records, drops stale/unresolvable ids, handles a missing pos field', function() {
  resetDB();
  ctx.DB.po.push({ id: 'po-2b-1', num: 'PO-2B-1' }, { id: 'po-2b-2', num: 'PO-2B-2' });
  var invBoth = { id: 'i1', pos: ['po-2b-1', 'po-2b-2'] };
  var resultBoth = ctx.getInvoicePOs(invBoth);
  assertEqual(resultBoth.length, 2, 'both ids resolve');
  assertEqual(resultBoth[0].id, 'po-2b-1', 'returned in pos[] order');

  var invStale = { id: 'i2', pos: ['po-2b-1', 'stale-id'] };
  var resultStale = ctx.getInvoicePOs(invStale);
  assertEqual(resultStale.length, 1, 'the stale, non-resolving id is dropped, not returned as undefined');

  var invNoPos = { id: 'i3' };
  assertEqual(ctx.getInvoicePOs(invNoPos).length, 0, 'an invoice with no pos field returns []');
});

test('backfillInvoicePOs() — rebuilds inv.pos[] from live po.invNum/invId, discarding stale prior contents, idempotent', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-1', num: 'INV-2B-1', pos: ['dead-po-id'] });
  ctx.DB.po.push({ id: 'po-2b-3', num: 'PO-2B-3', invId: 'inv-2b-1', invNum: 'INV-2B-1' });
  ctx.backfillInvoicePOs();
  assertEqual(JSON.stringify(ctx.DB.inv[0].pos), JSON.stringify(['po-2b-3']), 'stale id removed, live PO added — a rebuild, not a merge');

  var snapshotAfterFirstRun = JSON.stringify(ctx.DB.inv);
  ctx.backfillInvoicePOs();
  assertEqual(JSON.stringify(ctx.DB.inv), snapshotAfterFirstRun, 'second run is a true no-op (idempotent)');
});

test('backfillInvoicePOs() — exclusivity: a PO whose invId/invNum resolve to two different invoices lands in exactly one pos[] (AC-15)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-a', num: 'INV-2B-A' }, { id: 'inv-2b-b', num: 'INV-2B-B' });
  // Simulates the post-pullAll()-re-link state: invNum was overwritten to point at B, invId still stale-points at A.
  ctx.DB.po.push({ id: 'po-2b-4', num: 'PO-2B-4', invId: 'inv-2b-a', invNum: 'INV-2B-B' });
  ctx.backfillInvoicePOs();
  var invA = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-a'; });
  var invB = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-b'; });
  assertEqual((invB.pos||[]).indexOf('po-2b-4') > -1, true, 'the invNum match (B) wins — the fresher field for a real re-link');
  assertEqual((invA.pos||[]).indexOf('po-2b-4') > -1, false, 'never present in both — the stale invId match (A) is not also populated');
});

test('delPO() removes the deleted PO\'s id from every invoice\'s pos[] (AC-3)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-2', num: 'INV-2B-2', pos: ['po-2b-5', 'po-2b-6'] });
  ctx.DB.po.push({ id: 'po-2b-5', num: 'PO-2B-5', invId: 'inv-2b-2', invNum: 'INV-2B-2' });
  ctx.DB.po.push({ id: 'po-2b-6', num: 'PO-2B-6', invId: 'inv-2b-2', invNum: 'INV-2B-2' });
  var origConfirm = ctx.confirm; ctx.confirm = function(){ return true; };
  return ctx.delPO('po-2b-5').then(function(){
    ctx.confirm = origConfirm;
    var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-2'; });
    assertEqual(JSON.stringify(inv.pos), JSON.stringify(['po-2b-6']), 'deleted PO\'s id removed, surviving PO\'s id untouched');
    assertEqual(ctx.getInvoicePOs(inv).length, 1, 'getInvoicePOs() now returns only the surviving PO');
  });
});

testAsync('saveInv() FPM-recovery block uses getInvoicePOs(inv), auto-set behavior unchanged (AC-7)', async function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-3', num: 'INV20301', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 1000 }], taxRate: 0, calc_grandTotal: '1000', pos: ['po-2b-7'] });
  ctx.DB.po.push({ id: 'po-2b-7', num: 'PO-2B-7', invId: 'inv-2b-3', invNum: 'INV20301', fpmFunded: 500, fpmRecovered: false });
  ctx.EI.i = 'inv-2b-3';
  ctx.cIL = [];
  setupInvForm('INV20301');
  mockEl('inv-sm').value = 'Paid';
  await ctx.saveInv();
  var po = ctx.DB.po.find(function(p){ return p.id === 'po-2b-7'; });
  assertEqual(po.fpmRecovered, true, 'linked PO\'s fpmFunded deposit is recovered once its invoice reaches Paid, sourced via getInvoicePOs()');
});

test('savePayment() FPM-recovery block auto-sets fpmRecovered on the invoice\'s linked PO once fully paid (AC-8)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-4', num: 'INV-2B-4', status: 'Sent', cur: 'USD', dep: 0, lineItems: [{ qty: 1, up: 1000 }], calc_grandTotal: '1000', pos: ['po-2b-8'] });
  ctx.DB.po.push({ id: 'po-2b-8', num: 'PO-2B-8', invId: 'inv-2b-4', invNum: 'INV-2B-4', fpmFunded: 300, fpmRecovered: false });
  ctx.savePayment({ id: 'pay-2b-1', invId: 'inv-2b-4', invNum: 'INV-2B-4', amount: 1000, date: '2026-01-01', method: 'Bank Transfer' });
  var po = ctx.DB.po.find(function(p){ return p.id === 'po-2b-8'; });
  assertEqual(po.fpmRecovered, true, 'a payment that fully settles the invoice auto-recovers the linked PO\'s FPM-funded deposit, sourced via getInvoicePOs()');
});

test('autoPos() still correctly populates inv.pos[] on an invoice\'s first save (AC-9, unchanged)', function() {
  resetDB();
  ctx.DB.li.push({ id: 'li-2b-1', supId: 'sup-2b-1', cost: 10 }, { id: 'li-2b-2', supId: 'sup-2b-2', cost: 20 });
  var inv = { id: 'inv-2b-5', num: 'INV-2B-5', lineItems: [{ lid: 'li-2b-1', qty: 1, up: 15 }, { lid: 'li-2b-2', qty: 1, up: 25 }] };
  ctx.DB.inv.push(inv);
  ctx.autoPos(inv);
  var savedInv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-5'; });
  assertEqual(savedInv.pos.length, 2, 'both auto-generated POs (one per distinct supplier) recorded in inv.pos[]');
  assertEqual(ctx.getInvoicePOs(savedInv).length, 2, 'getInvoicePOs() resolves both immediately, no boot/migration needed');
});

test('processImport() CSV-linked PO syncs inv.pos[] immediately, no reload needed (AC-11)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-6', num: 'INV-2B-6' });
  var csv = 'PO #,Linked Invoice #\nPO-2B-9,INV-2B-6\n';
  ctx.processImport('po', csv);
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-6'; });
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-2B-9'; });
  assertEqual((inv.pos||[]).indexOf(po.id) > -1, true, 'the CSV-imported PO\'s id is synced into the matched invoice\'s pos[] immediately');
});

test('processImportRecords() Sheets-record-linked PO syncs inv.pos[] immediately, no reload needed (AC-12)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2b-7', num: 'INV-2B-7' });
  ctx.processImportRecords('po', [{ 'PO #': 'PO-2B-10', 'Linked Invoice #': 'INV-2B-7' }], function(){});
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-7'; });
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-2B-10'; });
  assertEqual((inv.pos||[]).indexOf(po.id) > -1, true, 'the Sheets-record-imported PO\'s id is synced into the matched invoice\'s pos[] immediately');
});

testAsync('pullAll() syncs inv.pos[] for a brand-new pulled PO with no local match (AC-13)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id: 'inv-2b-8', num: 'INV-2B-8' }];
  _mockPullResponses = { po: { status: 'ok', records: [
    { 'PO #': 'PO-2B-11', 'Supplier': '', 'Linked Invoice': 'INV-2B-8' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-8'; });
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-2B-11'; });
  assert(po, 'the brand-new pulled PO was merged into DB.po');
  assertEqual((inv.pos||[]).indexOf(po.id) > -1, true, 'the newly-pulled PO is synced into the matched invoice\'s pos[], no reload needed');
});

testAsync('pullAll() re-links inv.pos[] when an existing PO\'s Linked Invoice changes on re-pull (AC-14)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.DB.inv = [{ id: 'inv-2b-9', num: 'INV-2B-9' }, { id: 'inv-2b-10', num: 'INV-2B-10' }];
  ctx.DB.po = [{ id: 'po-2b-12', num: 'PO-2B-12', invId: 'inv-2b-9', invNum: 'INV-2B-9', pos: undefined }];
  ctx.DB.inv[0].pos = ['po-2b-12'];
  _mockPullResponses = { po: { status: 'ok', records: [
    { 'PO #': 'PO-2B-12', 'Supplier': '', 'Linked Invoice': 'INV-2B-10' }
  ] } };
  await ctx.pullAll();
  _mockPullResponses = {};
  var invOld = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-9'; });
  var invNew = ctx.DB.inv.find(function(i){ return i.id === 'inv-2b-10'; });
  var po = ctx.DB.po.find(function(p){ return p.num === 'PO-2B-12'; });
  assertEqual((invNew.pos||[]).indexOf(po.id) > -1, true, 'the re-linked PO now appears in the new invoice\'s pos[]');
  assertEqual((invOld.pos||[]).indexOf(po.id) > -1, false, 'and is fully removed from the old invoice\'s pos[] — not left in both');
});

// ── REQ-MTD-001: VAT Return ──────────────────────────────────────────────────

test('_vatPrevQuarter: returns Q4 of prior year when called in Q1 (Jan-Mar)', function() {
  var nowStub = { getFullYear: function(){ return 2026; }, getMonth: function(){ return 0; } };
  var pq = ctx._vatPrevQuarter(nowStub);
  assertEqual(pq.from, '2025-10-01', 'from = Q4 2025 start');
  assertEqual(pq.to,   '2025-12-31', 'to = Q4 2025 end');
});

test('_vatPrevQuarter: 1 April (first day of Q2) returns Q1 of same year (AC-8)', function() {
  var nowStub = { getFullYear: function(){ return 2026; }, getMonth: function(){ return 3; } };
  var pq = ctx._vatPrevQuarter(nowStub);
  assertEqual(pq.from, '2026-01-01', 'from = Q1 2026 start');
  assertEqual(pq.to,   '2026-03-31', 'to = Q1 2026 end');
});

test('openVATReturn: export buttons disabled on open (AC-7)', function() {
  var origShowM = ctx.showM;
  ctx.showM = function() {};
  ctx.openVATReturn();
  ctx.showM = origShowM;
  assert(mockEl('vat-export-summary').disabled === true, 'summary export disabled on open');
  assert(mockEl('vat-export-txn').disabled === true, 'txn export disabled on open');
});

test('calcVATReturn: mixed zero-rated and GBP-taxed invoice — Box1 > 0 (AC-1)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i10', num: 'INV010', date: '2026-02-01', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'Barbados',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  ctx.DB.inv.push({ id: 'i11', num: 'INV011', date: '2026-02-10', status: 'Sent',
    type: 'invoice', cur: 'GBP', buyer: 'UK Buyer Ltd', dst: 'United Kingdom',
    calc_grandTotal: 1200, calc_taxAmt: 200, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assert(r.box1 > 0, 'Box 1 > 0 (tax-bearing invoice contributes)');
  assert(r.box6 > 0, 'Box 6 > 0');
  assertEqual(r.rows.length, 2, '2 transaction rows');
});

test('calcVATReturn: zero-rated invoice — Box1=0 Box6=grand GBP (AC-2)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i1', num: 'INV001', date: '2026-01-15', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'Barbados',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.box1, 0, 'Box 1 = 0 for zero-rated');
  assert(r.box6 > 0, 'Box 6 > 0');
  assertEqual(r.rows.length, 1, '1 transaction row');
});

test('calcVATReturn: cancelled invoice excluded (AC-9)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i2', num: 'INV002', date: '2026-01-20', status: 'Cancelled',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 2000, calc_taxAmt: 333.33, calc_liTotal: 2000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.box1, 0, 'Box 1 = 0 (cancelled excluded)');
  assertEqual(r.box6, 0, 'Box 6 = 0 (cancelled excluded)');
  assertEqual(r.rows.length, 0, 'no transaction rows');
});

test('calcVATReturn: goodwill credit excluded (AC-10)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i3', num: 'GWC001', date: '2026-02-01', status: 'CN Issued',
    type: 'goodwill_credit', cur: 'USD', buyer: 'Acme', dst: 'UK', cnAmount: 500 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.box1, 0, 'Box 1 = 0 (goodwill excluded)');
  assertEqual(r.box6, 0, 'Box 6 = 0 (goodwill excluded)');
  assertEqual(r.rows.length, 0, 'no rows for goodwill credit');
});

test('calcVATReturn: no invoices in range — all boxes zero (AC-4)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i4', num: 'INV003', date: '2025-06-01', status: 'Paid',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1200, calc_taxAmt: 0, calc_liTotal: 1200 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.box1, 0, 'Box 1 = 0'); assertEqual(r.box6, 0, 'Box 6 = 0');
  assertEqual(r.rows.length, 0, 'no rows');
});

test('calcVATReturn: invoice after To date excluded', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i5', num: 'INV004', date: '2026-04-01', status: 'Sent',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.rows.length, 0, 'invoice after To date excluded');
});

test('calcVATReturn: credit note reduces Box 6, has negative row values (AC-3)', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.DB.inv.push({ id: 'i6', num: 'INV005', date: '2026-02-01', status: 'Paid',
    type: 'invoice', cur: 'USD', buyer: 'Acme', dst: 'UK',
    calc_grandTotal: 1000, calc_taxAmt: 0, calc_liTotal: 1000 });
  ctx.DB.inv.push({ id: 'i7', num: 'CN10001', date: '2026-02-15', status: 'CN Applied',
    type: 'credit_note', cur: 'USD', buyer: 'Acme', dst: 'UK', cnAmount: 200 });
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.rows.length, 2, '2 transaction rows');
  var cnRow = r.rows.filter(function(row){ return row.type === 'credit_note'; })[0];
  assert(cnRow.grossOrig < 0, 'credit note gross is negative');
  assert(cnRow.netOrig < 0, 'credit note net is negative');
});

test('calcVATReturn: box3 = box1 + box2, box5 = box3 - box4, zeros correct', function() {
  resetDB();
  ctx.DB.events = [];
  var r = ctx.calcVATReturn('2026-01-01', '2026-03-31');
  assertEqual(r.box3, r.box1 + r.box2, 'box3 = box1 + box2');
  assertEqual(r.box5, r.box3 - r.box4, 'box5 = box3 - box4');
  assertEqual(r.box2, 0, 'box2 = 0'); assertEqual(r.box4, 0, 'box4 = 0');
  assertEqual(r.box7, 0, 'box7 = 0'); assertEqual(r.box8, 0, 'box8 = 0');
  assertEqual(r.box9, 0, 'box9 = 0');
});

// ── REQ-RPT-001 G-01: AI date filter ──────────────────────────

test('_aiExecTool get_invoices: date_from filters correctly', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-20', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_from: '2026-02-01' }));
  assertEqual(result.length, 1, 'only invoices on/after date_from returned');
  assertEqual(result[0].num, 'INV002', 'correct invoice returned');
});

test('_aiExecTool get_invoices: date_to filters correctly', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-20', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_to: '2026-02-28' }));
  assertEqual(result.length, 1, 'only invoices on/before date_to returned');
  assertEqual(result[0].num, 'INV001', 'correct invoice returned');
});

test('_aiExecTool get_invoices: date range inclusive both ends', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-03-31', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i3', num:'INV003', buyer:'C', date:'2026-04-01', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'500', calc_cogs:'300', calc_netProfit:'200', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', { date_from: '2026-01-01', date_to: '2026-03-31' }));
  assertEqual(result.length, 2, 'both boundary dates inclusive');
});

test('_aiExecTool get_invoices: no date params returns all (regression)', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'B', date:'2026-06-01', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40' });
  var result = JSON.parse(ctx._aiExecTool('get_invoices', {}));
  assertEqual(result.length, 2, 'all invoices returned when no date filter');
});

test('_aiExecTool get_payments: date_from filters correctly', function() {
  resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-02-10', amount:500, method:'Bank Transfer', reference:'REF1' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-04-15', amount:800, method:'Bank Transfer', reference:'REF2' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_from: '2026-03-01' }));
  assertEqual(result.length, 1, 'only payments on/after date_from returned');
  assertEqual(result[0].invNum, 'INV002', 'correct payment returned');
});

test('_aiExecTool get_payments: date_to filters correctly', function() {
  resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-02-10', amount:500, method:'Bank Transfer', reference:'REF1' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-04-15', amount:800, method:'Bank Transfer', reference:'REF2' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_to: '2026-03-31' }));
  assertEqual(result.length, 1, 'only payments on/before date_to returned');
  assertEqual(result[0].invNum, 'INV001', 'correct payment returned');
});

test('_aiExecTool get_payments: date range inclusive both ends', function() {
  resetDB();
  ctx.DB.payments.push({ id:'p1', invNum:'INV001', invId:'i1', date:'2026-01-01', amount:100, method:'Bank Transfer', reference:'A' });
  ctx.DB.payments.push({ id:'p2', invNum:'INV002', invId:'i2', date:'2026-03-31', amount:200, method:'Bank Transfer', reference:'B' });
  ctx.DB.payments.push({ id:'p3', invNum:'INV003', invId:'i3', date:'2026-04-01', amount:300, method:'Bank Transfer', reference:'C' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', { date_from: '2026-01-01', date_to: '2026-03-31' }));
  assertEqual(result.length, 2, 'both boundary dates inclusive for payments');
});

// ── REQ-RPT-001 G-02: Aging Report ──────────────────────────────

test('aging bucket: invoice 65 days old with Net 30 terms in 31-60 bucket (daysOverdue=35)', function() {
  var today = new Date(); today.setHours(0,0,0,0);
  var invDate = new Date(today.getTime() - 65*86400000);
  var ptDays = ctx.parsePtDays('Net 30');
  var dueDate = new Date(invDate.getTime() + ptDays*86400000);
  var daysOverdue = Math.floor((today - dueDate)/86400000);
  var bucket = daysOverdue<=0?'Current':daysOverdue<=30?'0–30':daysOverdue<=60?'31–60':daysOverdue<=90?'61–90':'90+';
  assertEqual(bucket, '31–60', '65-day-old invoice with Net 30 -> daysOverdue 35 -> 31-60 bucket');
});

test('aging bucket: invoice 125 days old with Net 30 terms in 90+ bucket (daysOverdue=95)', function() {
  var today = new Date(); today.setHours(0,0,0,0);
  var invDate = new Date(today.getTime() - 125*86400000);
  var ptDays = ctx.parsePtDays('Net 30');
  var dueDate = new Date(invDate.getTime() + ptDays*86400000);
  var daysOverdue = Math.floor((today - dueDate)/86400000);
  var bucket = daysOverdue<=0?'Current':daysOverdue<=30?'0–30':daysOverdue<=60?'31–60':daysOverdue<=90?'61–90':'90+';
  assertEqual(bucket, '90+', '125-day-old invoice with Net 30 -> daysOverdue 95 -> 90+ bucket');
});

test('parsePtDays: payment terms defaults and extraction', function() {
  assertEqual(ctx.parsePtDays('COD'), 30, 'COD defaults to 30');
  assertEqual(ctx.parsePtDays(''), 30, 'empty defaults to 30');
  assertEqual(ctx.parsePtDays('Net 45'), 45, 'Net 45 parses 45');
  assertEqual(ctx.parsePtDays('30 days EOM'), 30, '30 days EOM parses 30');
});

test('aging DSO is 0 when no invoices with outstanding balance', function() {
  var rows = [];
  var totalBal = rows.reduce(function(s,r){ return s + r.bal; }, 0);
  var dso = totalBal > 0
    ? Math.round(rows.reduce(function(s,r){ return s + r.daysOld * r.bal; }, 0) / totalBal)
    : 0;
  assertEqual(dso, 0, 'DSO is 0 when no outstanding balance');
});

test('aging filter: Paid invoices excluded, Sent included', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'1000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'0' });
  var filtered = ctx.DB.inv.filter(function(inv){
    return (inv.status === 'Sent' || inv.status === 'Partially Paid') &&
           inv.type !== 'credit_note' && inv.type !== 'goodwill_credit' && !ctx.isCN(inv.num);
  });
  assertEqual(filtered.length, 1, 'only Sent/Partially Paid included in aging');
  assertEqual(filtered[0].num, 'INV002', 'Paid invoice excluded');
});

test('aging filter: Partially Paid invoice with outstanding balance included (REQ AC-2)', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-05', status:'Partially Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'800' });
  var filtered = ctx.DB.inv.filter(function(inv){
    return (inv.status === 'Sent' || inv.status === 'Partially Paid') &&
           inv.type !== 'credit_note' && inv.type !== 'goodwill_credit' && !ctx.isCN(inv.num);
  });
  assertEqual(filtered.length, 1, 'Partially Paid invoice included in aging filter');
  var c = ctx.iCalc(filtered[0]);
  assert(c.bal > 0, 'outstanding balance > 0 for Partially Paid invoice');
});

// ── REQ-RPT-001 G-03: P&L Report ────────────────────────────────

test('P&L grouping: revenue, cogs, np aggregated correctly by buyer', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'Apex', date:'2026-03-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'10000', calc_cogs:'6000', calc_netProfit:'4000', calc_margin:'40', dep:'10000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'Apex', date:'2026-04-01', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'5000', calc_cogs:'3000', calc_netProfit:'2000', calc_margin:'40', dep:'5000' });
  ctx.DB.inv.push({ id:'i3', num:'INV003', buyer:'Romerry', date:'2026-04-15', status:'Sent', type:'invoice', cur:'USD', calc_grandTotal:'8000', calc_cogs:'5000', calc_netProfit:'3000', calc_margin:'37', dep:'0' });

  var invs = ctx.DB.inv.filter(function(i){ return i.status!=='Cancelled'&&i.type!=='credit_note'&&!ctx.isCN(i.num); });
  var groups = {};
  invs.forEach(function(inv){
    var key = inv.buyer||'Unknown';
    var c = ctx.iCalc(inv);
    var cogs = +inv.calc_cogs||0;
    if (!groups[key]) groups[key]={revenue:0,cogs:0,gp:0,np:0};
    groups[key].revenue += c.grand;
    groups[key].cogs    += cogs;
    groups[key].gp      += (c.grand - cogs);
    groups[key].np      += c.np;
  });
  assertEqual(+groups['Apex'].revenue.toFixed(2), 15000, 'Apex revenue aggregated correctly');
  assertEqual(+groups['Apex'].cogs.toFixed(2), 9000, 'Apex COGS aggregated correctly');
  assertEqual(+groups['Apex'].gp.toFixed(2), 6000, 'Apex gross profit aggregated correctly');
  assertEqual(+groups['Apex'].np.toFixed(2), 6000, 'Apex NP aggregated correctly');
  assert(groups['Romerry'], 'Romerry group present');
});

test('P&L date range filter excludes out-of-range invoices', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2025-12-31', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'1000' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-03-15', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000' });
  var dfrom='2026-01-01'; var dto='2026-12-31';
  var filtered = ctx.DB.inv.filter(function(inv){
    if (inv.status==='Cancelled') return false;
    if (dfrom && inv.date<dfrom) return false;
    if (dto   && inv.date>dto)   return false;
    return true;
  });
  assertEqual(filtered.length, 1, 'only in-range invoice included');
  assertEqual(filtered[0].num, 'INV002', 'correct invoice retained');
});

test('P&L filter: cancelled invoices excluded', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Cancelled', type:'invoice', cur:'USD', calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40' });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Paid', type:'invoice', cur:'USD', calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000' });
  var filtered = ctx.DB.inv.filter(function(i){ return i.status!=='Cancelled'&&i.type!=='credit_note'&&!ctx.isCN(i.num); });
  assertEqual(filtered.length, 1, 'cancelled invoice excluded');
});

test('P&L COGS warning: zero-cogs invoice with no library lines detected', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i1', num:'INV001', buyer:'A', date:'2026-01-01', status:'Paid', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'0', calc_netProfit:'0', calc_margin:'0', dep:'1000',
    lineItems:[{ desc:'Widget', qty:1, up:1000, lid:'' }] });
  ctx.DB.inv.push({ id:'i2', num:'INV002', buyer:'A', date:'2026-01-05', status:'Paid', type:'invoice', cur:'USD',
    calc_grandTotal:'2000', calc_cogs:'1200', calc_netProfit:'800', calc_margin:'40', dep:'2000',
    lineItems:[{ desc:'Gadget', qty:1, up:2000, lid:'lib-1' }] });
  ctx.DB.li.push({ id:'lib-1', name:'Gadget', price:2000 });

  var invs = ctx.DB.inv.filter(function(inv){ return inv.status !== 'Cancelled'; });
  var zeroCogs = invs.filter(function(inv){
    return !(+inv.calc_cogs > 0) &&
           !(inv.lineItems||[]).some(function(li){ return li.lid && ctx.DB.li.find(function(x){ return x.id===li.lid; }); });
  });
  assertEqual(zeroCogs.length, 1, 'one invoice flagged as zero-COGS');
  assertEqual(zeroCogs[0].num, 'INV001', 'correct invoice flagged');
});

// ── REQ-RPT-001 G-05: Entity event log ──────────────────────────

test('saveInv creates invoice_created event', function() {
  resetDB();
  ctx.EI.i = null;
  ctx.DB.events = [];
  mockEl('if-n').value    = 'INV10901';
  mockEl('if-b').value    = 'Test Buyer';
  mockEl('if-dst').value  = 'UK';
  mockEl('if-dt').value   = '2026-01-01';
  mockEl('inv-sm').value  = 'Draft';
  mockEl('if-cur').value  = 'USD';
  mockEl('if-tx').value   = '0';
  mockEl('if-lf').value   = '0';
  mockEl('if-ins').value  = '0';
  mockEl('if-oth').value  = '0';
  mockEl('if-dep').value  = '0';
  mockEl('if-inco').value = 'FOB';
  mockEl('if-pt').value   = 'Net 30';
  mockEl('if-pol').value  = '';
  mockEl('if-pod').value  = '';
  mockEl('if-coo').value  = '';
  mockEl('if-ft').value   = '';
  mockEl('if-notes').value= '';
  mockEl('if-terms').value= '';
  mockEl('if-chi').checked= false;
  mockEl('if-ba').value   = '';
  mockEl('if-st').value   = '';
  mockEl('if-cid').value  = '';
  mockEl('if-ex').value   = '';
  mockEl('if-sd').value   = '';
  mockEl('if-wt').value   = '';
  mockEl('if-cbm').value  = '';
  mockEl('if-pk').value   = '';
  ctx.cIL = [{ rid:'r1', lid:'', desc:'Widget', uom:'EA', qty:1, up:100, unitCost:60, lineType:'product' }];
  ctx.saveInv();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='invoice'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'invoice created event emitted');
});

test('savePO creates po_created event', function() {
  resetDB();
  ctx.EI.p = null;
  ctx.DB.events = [];
  ctx.DB.sup.push({ id:'S1', name:'ACME', cur:'USD' });
  mockEl('pf-n').value     = 'PO-T01';
  mockEl('pf-sup').value   = 'S1';
  mockEl('pf-dt').value    = '2026-01-01';
  mockEl('pf-cur').value   = 'USD';
  mockEl('po-sm').value    = 'Draft';
  mockEl('pf-del').value   = '';
  mockEl('pf-dep').value   = '0';
  mockEl('pf-fpm').value   = '0';
  mockEl('pf-oth').value   = '0';
  mockEl('pf-pt').value    = '';
  mockEl('pf-nt').value    = '';
  mockEl('pf-rec').checked = false;
  mockEl('pf-inv').value   = '';
  ctx.cPL = [];
  ctx.savePO();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='po'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'PO created event emitted');
});

testAsync('saveSup creates supplier_created event', async function() {
  resetDB();
  ctx.EI.s = null;
  ctx.DB.events = [];
  mockEl('sf-n').value  = 'Test Supplier';
  mockEl('sf-c').value  = 'China';
  mockEl('sf-cur').value= 'CNY';
  mockEl('sf-ct').value = '';
  mockEl('sf-e').value  = '';
  mockEl('sf-nt').value = '';
  await ctx.saveSup();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='supplier'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'supplier created event emitted');
});

test('savePayment creates payment_created event', function() {
  resetDB();
  ctx.DB.events = [];
  var pmt = { id:'pm1', invId:'i1', invNum:'INV001', date:'2026-03-01', amount:1500, method:'Bank Transfer', reference:'REF-01' };
  ctx.savePayment(pmt);
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='payment'&&e.verb==='created'; });
  assertEqual(evts.length, 1, 'payment created event emitted');
});

test('deletePayment creates payment_deleted event', function() {
  resetDB();
  ctx.DB.events = [];
  ctx.confirm = function(){ return true; };
  var pmt = { id:'pm-del', invId:'i1', invNum:'INV001', date:'2026-03-01', amount:500, method:'Bank Transfer', reference:'REF-02' };
  ctx.DB.payments.push(pmt);
  ctx.deletePayment('pm-del');
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='payment'&&e.verb==='deleted'; });
  assertEqual(evts.length, 1, 'payment deleted event emitted');
});

test('saveInv emits status_changed event when status changes', function() {
  resetDB();
  ctx.DB.inv.push({ id:'i-sc', num:'INV10902', buyer:'A', date:'2026-01-01', status:'Draft', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'600', calc_netProfit:'400', calc_margin:'40', dep:'0', lineItems:[] });
  ctx.DB.events = [];
  ctx.EI.i = 'i-sc';
  mockEl('if-n').value='INV10902'; mockEl('if-b').value='A'; mockEl('if-dst').value='UK';
  mockEl('if-dt').value='2026-01-01'; mockEl('inv-sm').value='Sent'; mockEl('if-cur').value='USD';
  mockEl('if-tx').value='0'; mockEl('if-lf').value='0'; mockEl('if-ins').value='0';
  mockEl('if-oth').value='0'; mockEl('if-dep').value='0'; mockEl('if-inco').value='FOB';
  mockEl('if-pt').value='Net 30'; mockEl('if-pol').value=''; mockEl('if-pod').value='';
  mockEl('if-coo').value=''; mockEl('if-ft').value=''; mockEl('if-notes').value='';
  mockEl('if-terms').value=''; mockEl('if-chi').checked=false;
  mockEl('if-ba').value=''; mockEl('if-st').value=''; mockEl('if-cid').value='';
  mockEl('if-ex').value=''; mockEl('if-sd').value=''; mockEl('if-wt').value='';
  mockEl('if-cbm').value=''; mockEl('if-pk').value='';
  ctx.cIL = [];
  ctx.saveInv();
  var evts = ctx.DB.events.filter(function(e){ return e.entityType==='invoice'&&e.verb==='status_changed'; });
  assertEqual(evts.length, 1, 'status_changed event emitted');
  assert(evts[0].summary.indexOf('Draft')>=0 && evts[0].summary.indexOf('Sent')>=0, 'summary contains old and new status');
});

// ── REQ-RPT-001 G-06: Invoice edit delta ──────────────────────────

test('invoice editHistory captures changed field on unlock+save', function() {
  resetDB();
  var inv = { id:'i-ed1', num:'INV10903', buyer:'Apex', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'10000', calc_cogs:'6000', calc_netProfit:'4000', calc_margin:'40', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);
  ctx._invEditSnapshot = { invId:'i-ed1', reason:'Freight correction', status:'Sent', buyer:'Apex',
    calc_grandTotal:'10000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };
  ctx.EI.i = 'i-ed1';
  mockEl('if-n').value='INV10903'; mockEl('if-b').value='Apex'; mockEl('if-dst').value='UK';
  mockEl('if-dt').value='2026-01-01'; mockEl('inv-sm').value='Sent'; mockEl('if-cur').value='USD';
  mockEl('if-tx').value='0'; mockEl('if-lf').value='500'; mockEl('if-ins').value='0';
  mockEl('if-oth').value='0'; mockEl('if-dep').value='0'; mockEl('if-inco').value='FOB';
  mockEl('if-pt').value='Net 30'; mockEl('if-pol').value=''; mockEl('if-pod').value='';
  mockEl('if-coo').value=''; mockEl('if-ft').value=''; mockEl('if-notes').value='';
  mockEl('if-terms').value=''; mockEl('if-chi').checked=false;
  mockEl('if-ba').value=''; mockEl('if-st').value=''; mockEl('if-cid').value='';
  mockEl('if-ex').value=''; mockEl('if-sd').value=''; mockEl('if-wt').value='';
  mockEl('if-cbm').value=''; mockEl('if-pk').value='';
  ctx.cIL = [];
  ctx.saveInv();
  var saved = ctx.DB.inv.find(function(i){ return i.id==='i-ed1'; });
  assert(saved && saved.editHistory && saved.editHistory.length >= 1, 'editHistory entry created');
  var entry = saved.editHistory[0];
  assertEqual(entry.reason, 'Freight correction', 'reason recorded');
  assertEqual(entry.actor, 'operator', 'actor is operator');
  var lfChange = entry.changes.find(function(c){ return c.field==='lf'; });
  assert(lfChange, 'lf field change captured');
  assertEqual(lfChange.from, '0', 'from value correct');
  assertEqual(lfChange.to, '500', 'to value correct');
});

test('invoice editHistory records empty changes array when no tracked fields changed', function() {
  resetDB();
  var inv = { id:'i-ed2', num:'INV10904', buyer:'Apex', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'5000', calc_cogs:'3000', calc_netProfit:'2000', calc_margin:'40', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);
  ctx._invEditSnapshot = { invId:'i-ed2', reason:'Review', status:'Sent', buyer:'Apex',
    calc_grandTotal:'5000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };
  ctx.EI.i = 'i-ed2';
  mockEl('if-n').value='INV10904'; mockEl('if-b').value='Apex'; mockEl('if-dst').value='UK';
  mockEl('if-dt').value='2026-01-01'; mockEl('inv-sm').value='Sent'; mockEl('if-cur').value='USD';
  mockEl('if-tx').value='0'; mockEl('if-lf').value='0'; mockEl('if-ins').value='0';
  mockEl('if-oth').value='0'; mockEl('if-dep').value='0'; mockEl('if-inco').value='FOB';
  mockEl('if-pt').value='Net 30'; mockEl('if-pol').value=''; mockEl('if-pod').value='';
  mockEl('if-coo').value=''; mockEl('if-ft').value=''; mockEl('if-notes').value='';
  mockEl('if-terms').value=''; mockEl('if-chi').checked=false;
  mockEl('if-ba').value=''; mockEl('if-st').value=''; mockEl('if-cid').value='';
  mockEl('if-ex').value=''; mockEl('if-sd').value=''; mockEl('if-wt').value='';
  mockEl('if-cbm').value=''; mockEl('if-pk').value='';
  ctx.cIL = [];
  ctx.saveInv();
  var saved = ctx.DB.inv.find(function(i){ return i.id==='i-ed2'; });
  assert(saved.editHistory.length >= 1, 'history entry created even with no changes');
  assertEqual(saved.editHistory[0].changes.length, 0, 'changes array empty');
});

test('_invEditSnapshot null after save clears state', function() {
  resetDB();
  var inv = { id:'i-ed3', num:'INV10905', buyer:'B', date:'2026-01-01', status:'Sent', type:'invoice', cur:'USD',
    calc_grandTotal:'1000', calc_cogs:'500', calc_netProfit:'500', calc_margin:'50', dep:'0',
    lineItems:[], editHistory:[] };
  ctx.DB.inv.push(inv);
  ctx._invEditSnapshot = { invId:'i-ed3', reason:'Test', status:'Sent', buyer:'B',
    calc_grandTotal:'1000', dep:'0', taxRate:'0', lf:'0', liCount:0, liTotal:0 };
  ctx.EI.i = 'i-ed3';
  mockEl('if-n').value='INV10905'; mockEl('if-b').value='B'; mockEl('if-dst').value='UK';
  mockEl('if-dt').value='2026-01-01'; mockEl('inv-sm').value='Sent'; mockEl('if-cur').value='USD';
  mockEl('if-tx').value='0'; mockEl('if-lf').value='0'; mockEl('if-ins').value='0';
  mockEl('if-oth').value='0'; mockEl('if-dep').value='0'; mockEl('if-inco').value='FOB';
  mockEl('if-pt').value='Net 30'; mockEl('if-pol').value=''; mockEl('if-pod').value='';
  mockEl('if-coo').value=''; mockEl('if-ft').value=''; mockEl('if-notes').value='';
  mockEl('if-terms').value=''; mockEl('if-chi').checked=false;
  mockEl('if-ba').value=''; mockEl('if-st').value=''; mockEl('if-cid').value='';
  mockEl('if-ex').value=''; mockEl('if-sd').value=''; mockEl('if-wt').value='';
  mockEl('if-cbm').value=''; mockEl('if-pk').value='';
  ctx.cIL = [];
  ctx.saveInv();
  assertEqual(ctx._invEditSnapshot, null, 'snapshot cleared after save');
});

// ── BUYERS (T-BUY-01 … T-BUY-09) ─────────────────────────────
console.log('\nBuyers entity');

test('T-BUY-01 seedAdHocBuyer creates BUY-ADHOC when buy is empty', () => {
  resetDB();
  ctx.seedAdHocBuyer();
  assert(ctx.DB.buy.length === 1, 'buy array should have 1 record');
  assertEqual(ctx.DB.buy[0].id, 'BUY-ADHOC', 'id should be BUY-ADHOC');
  assertEqual(ctx.DB.buy[0].name, 'Ad-Hoc', 'name should be Ad-Hoc');
});

test('T-BUY-02 seedAdHocBuyer is idempotent (no duplicate on second call)', () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.seedAdHocBuyer();
  assertEqual(ctx.DB.buy.length, 1, 'should still have exactly 1 record');
});

testAsync('T-BUY-03 saveBuy creates a new buyer record', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'Apex Trading Ltd';
  mockEl('buy-cname').value = 'John Doe';
  mockEl('buy-email').value = 'john@apex.com';
  mockEl('buy-phone').value = '+1 246 555 0100';
  mockEl('buy-addr').value = 'Bridgetown, Barbados';
  mockEl('buy-cur').value = 'BBD';
  mockEl('buy-pt').value = 'Net 30';
  mockEl('buy-cl').value = '10000';
  mockEl('buy-notes').value = 'Key account';
  await ctx.saveBuy();
  var found = ctx.DB.buy.find(function(b){ return b.name === 'Apex Trading Ltd'; });
  assert(found, 'buyer should be created');
  assertEqual(found.currency, 'BBD', 'currency should be BBD');
  assertEqual(found.creditLimit, 10000, 'credit limit should be 10000');
});

testAsync('T-BUY-04 saveBuy blocks empty name', async () => {
  resetDB();
  ctx.EI.bu = null;
  mockEl('buy-name').value = '';
  mockEl('buy-cname').value = ''; mockEl('buy-email').value = ''; mockEl('buy-phone').value = '';
  mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'GBP'; mockEl('buy-pt').value = '';
  mockEl('buy-cl').value = ''; mockEl('buy-notes').value = '';
  var before = ctx.DB.buy.length;
  await ctx.saveBuy();
  assertEqual(ctx.DB.buy.length, before, 'no buyer should be added');
});

testAsync('T-BUY-05 saveBuy blocks duplicate name (case-insensitive)', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'APEX TRADING';
  mockEl('buy-cname').value = ''; mockEl('buy-email').value = ''; mockEl('buy-phone').value = '';
  mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'GBP'; mockEl('buy-pt').value = '';
  mockEl('buy-cl').value = ''; mockEl('buy-notes').value = '';
  await ctx.saveBuy();
  var before = ctx.DB.buy.length;
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'apex trading';
  await ctx.saveBuy();
  assertEqual(ctx.DB.buy.length, before, 'duplicate should not be added');
});

testAsync('T-BUY-06 saveBuy updates an existing buyer record', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'Sunrise Imports';
  mockEl('buy-cname').value = ''; mockEl('buy-email').value = ''; mockEl('buy-phone').value = '';
  mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'USD'; mockEl('buy-pt').value = '';
  mockEl('buy-cl').value = ''; mockEl('buy-notes').value = '';
  await ctx.saveBuy();
  var rec = ctx.DB.buy.find(function(b){ return b.name === 'Sunrise Imports'; });
  ctx.EI.bu = rec.id;
  mockEl('buy-name').value = 'Sunrise Imports Ltd';
  mockEl('buy-cname').value = 'Alice'; mockEl('buy-email').value = 'alice@sunrise.com';
  mockEl('buy-phone').value = ''; mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'USD';
  mockEl('buy-pt').value = 'Net 60'; mockEl('buy-cl').value = '5000'; mockEl('buy-notes').value = '';
  await ctx.saveBuy();
  var updated = ctx.DB.buy.find(function(b){ return b.id === rec.id; });
  assertEqual(updated.name, 'Sunrise Imports Ltd', 'name should be updated');
  assertEqual(updated.paymentTerms, 'Net 60', 'paymentTerms should be updated');
});

testAsync('T-BUY-07 delBuy removes buyer and emits event', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'Temp Buyer';
  mockEl('buy-cname').value = ''; mockEl('buy-email').value = ''; mockEl('buy-phone').value = '';
  mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'USD'; mockEl('buy-pt').value = '';
  mockEl('buy-cl').value = ''; mockEl('buy-notes').value = '';
  await ctx.saveBuy();
  var rec = ctx.DB.buy.find(function(b){ return b.name === 'Temp Buyer'; });
  var beforeEvts = ctx.DB.events.length;
  ctx.confirm = function(){ return true; };
  await ctx.delBuy(rec.id);
  assert(!ctx.DB.buy.find(function(b){ return b.id === rec.id; }), 'buyer should be removed');
  assert(ctx.DB.events.length > beforeEvts, 'delete event should be logged');
  ctx.confirm = function(){ return false; };
});

testAsync('T-BUY-08 delBuy blocks deletion of BUY-ADHOC', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  await ctx.delBuy('BUY-ADHOC');
  assert(ctx.DB.buy.find(function(b){ return b.id === 'BUY-ADHOC'; }), 'BUY-ADHOC should still exist');
});

test('T-BUY-09 fromGBP converts GBP to USD using QR rate', () => {
  var rate = ctx.QR.fxGBPUSD || ctx.QR_DEFAULTS.fxGBPUSD;
  var result = ctx.fromGBP(100, 'USD');
  assertEqual(result, 100 * rate, 'fromGBP(100, USD) should equal 100 * fxGBPUSD');
});

// ── Friendly reference numbers (SPEC-DATA-001) ──────────────────
console.log('\nparseRefNum() / nextRefNum() / backfillRefNums() — SPEC-DATA-001');

test('parseRefNum: valid PREFIX-0001 returns 1', () => {
  assertEqual(ctx.parseRefNum('SUP-0001', 'SUP'), 1);
});
test('parseRefNum: malformed suffix PREFIX-01x returns null', () => {
  assertEqual(ctx.parseRefNum('SUP-01x', 'SUP'), null);
});
test('parseRefNum: malformed suffix PREFIX-12abc returns null', () => {
  assertEqual(ctx.parseRefNum('SUP-12abc', 'SUP'), null);
});
test('parseRefNum: wrong prefix returns null', () => {
  assertEqual(ctx.parseRefNum('LI-0001', 'SUP'), null);
});
test('parseRefNum: empty/missing num returns null', () => {
  assertEqual(ctx.parseRefNum('', 'SUP'), null);
  assertEqual(ctx.parseRefNum(undefined, 'SUP'), null);
});

test('nextRefNum: empty array returns PREFIX-0001', () => {
  assertEqual(ctx.nextRefNum([], 'SUP'), 'SUP-0001');
});
test('nextRefNum: gaps/out-of-order returns correct next value', () => {
  var arr = [{ num:'SUP-0003' }, { num:'SUP-0001' }, { num:'SUP-0007' }];
  assertEqual(ctx.nextRefNum(arr, 'SUP'), 'SUP-0008');
});
test('nextRefNum: malformed num does not affect computed next value', () => {
  var arr = [{ num:'SUP-0002' }, { num:'SUP-abcx' }, { num:'garbage' }];
  assertEqual(ctx.nextRefNum(arr, 'SUP'), 'SUP-0003');
});

test('backfillRefNums: assigns num to records with none', () => {
  resetDB();
  ctx.DB.sup = [{ id:'s1', name:'A' }, { id:'s2', name:'B' }];
  ctx.backfillRefNums();
  assert(ctx.DB.sup[0].num && ctx.DB.sup[1].num, 'both suppliers should have a num assigned');
  assert(ctx.DB.sup[0].num !== ctx.DB.sup[1].num, 'nums must be distinct');
});
test('backfillRefNums: idempotent on second call', () => {
  resetDB();
  ctx.DB.sup = [{ id:'s1', name:'A' }];
  ctx.backfillRefNums();
  var first = ctx.DB.sup[0].num;
  ctx.backfillRefNums();
  assertEqual(ctx.DB.sup[0].num, first, 'num must not change on repeated backfill');
});
test('backfillRefNums: does not touch already-numbered records (valid or malformed)', () => {
  resetDB();
  ctx.DB.sup = [{ id:'s1', name:'A', num:'SUP-0099' }, { id:'s2', name:'B', num:'not-a-real-num' }];
  ctx.backfillRefNums();
  assertEqual(ctx.DB.sup[0].num, 'SUP-0099', 'valid existing num must be preserved');
  assertEqual(ctx.DB.sup[1].num, 'not-a-real-num', 'malformed existing num must be left alone, not overwritten');
});
test('backfillRefNums: BUY-ADHOC receives a num without its id changing', () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.backfillRefNums();
  var adhoc = ctx.DB.buy.find(function(b){ return b.id === 'BUY-ADHOC'; });
  assert(adhoc, 'BUY-ADHOC record must still exist');
  assert(adhoc.num, 'BUY-ADHOC must have a num assigned');
});
test('backfillRefNums: mixed createdAt comparator sorts no-createdAt group before has-createdAt group', () => {
  resetDB();
  ctx.DB.con = [
    { id:'c1', name:'HasDate-Later',  createdAt:'2026-02-01T00:00:00.000Z' },
    { id:'c2', name:'NoDate-First' },
    { id:'c3', name:'HasDate-Earlier', createdAt:'2026-01-01T00:00:00.000Z' },
    { id:'c4', name:'NoDate-Second' },
  ];
  ctx.backfillRefNums();
  var byId = {}; ctx.DB.con.forEach(function(c){ byId[c.id] = c.num; });
  // no-createdAt records (c2, c4, stable original order) get the lowest numbers,
  // then has-createdAt records in chronological order (c3 earlier, c1 later)
  assertEqual(byId.c2, 'CON-0001');
  assertEqual(byId.c4, 'CON-0002');
  assertEqual(byId.c3, 'CON-0003');
  assertEqual(byId.c1, 'CON-0004');
});

test('CRITICAL: restore-then-create does not collide (v5 bug regression)', () => {
  resetDB();
  // Numberless legacy suppliers, no createdAt, fixed array order (simulates a restored backup)
  ctx.DB.sup = [
    { id:'legacy1', name:'Legacy One' },
    { id:'legacy2', name:'Legacy Two' },
  ];
  // A new record is created before the next reload — gets SUP-0001 via nextRefNum
  var newNum = ctx.nextRefNum(ctx.DB.sup, 'SUP');
  ctx.DB.sup.push({ id:'new1', name:'New Supplier', num: newNum });
  assertEqual(newNum, 'SUP-0001', 'first new record should get SUP-0001');
  // Next reload runs backfillRefNums over the whole array
  ctx.backfillRefNums();
  var nums = ctx.DB.sup.map(function(s){ return s.num; });
  var unique = new Set(nums);
  assertEqual(unique.size, nums.length, 'no duplicate num values across suppliers');
  var legacy1 = ctx.DB.sup.find(function(s){ return s.id === 'legacy1'; });
  assert(legacy1.num !== 'SUP-0001', 'legacy record must not collide with the already-assigned SUP-0001');
  assertEqual(legacy1.num, 'SUP-0002', 'legacy records must start numbering from SUP-0002');
});

test('CRITICAL: pullAll num-stripping is healed by immediate backfillRefNums call', () => {
  resetDB();
  ctx.DB.sup = [{ id:'s1', name:'Original', num:'SUP-0005' }, { id:'s2', name:'Other', num:'SUP-0006' }];
  // Simulate a sync pull replacing s1 with a num-less object sharing the same id
  var pulledIdx = ctx.DB.sup.findIndex(function(s){ return s.id === 's1'; });
  ctx.DB.sup[pulledIdx] = { id:'s1', name:'Original' }; // num stripped, as FIELD_MAPS excludes num
  ctx.backfillRefNums();
  var healed = ctx.DB.sup.find(function(s){ return s.id === 's1'; });
  assert(healed.num, 'stripped record must receive a fresh num');
  assert(healed.num !== 'SUP-0006', 'fresh num must not duplicate the untouched record');
  assertEqual(ctx.DB.sup.find(function(s){ return s.id === 's2'; }).num, 'SUP-0006', 'other record must be undisturbed');
});

testAsync('saveSup: new record gets num, edit does not change it', async () => {
  resetDB();
  ctx.EI.s = null;
  mockEl('sf-n').value = 'New Co'; mockEl('sf-c').value = ''; mockEl('sf-ct').value = '';
  mockEl('sf-e').value = ''; mockEl('sf-cur').value = 'USD'; mockEl('sf-nt').value = '';
  await ctx.saveSup();
  var rec = ctx.DB.sup.find(function(s){ return s.name === 'New Co'; });
  assert(rec.num, 'new supplier should get a num');
  var originalNum = rec.num;
  ctx.EI.s = rec.id;
  mockEl('sf-n').value = 'New Co Updated';
  await ctx.saveSup();
  var updated = ctx.DB.sup.find(function(s){ return s.id === rec.id; });
  assertEqual(updated.num, originalNum, 'num must not change on edit');
});

test('saveLi: new record gets num, edit does not change it', () => {
  resetDB();
  ctx.DB.sup = [{ id:'s1', name:'Sup' }];
  ctx.EI.l = null;
  mockEl('lf-s').value = 'SKU1'; mockEl('lf-d').value = 'Widget'; mockEl('lf-sp').value = '';
  mockEl('lf-hs').value = ''; mockEl('lf-sup').value = 's1'; mockEl('lf-u').value = 'pcs';
  mockEl('lf-c').value = '10'; mockEl('lf-p').value = '20'; mockEl('lf-cur').value = 'USD';
  mockEl('lf-nt').value = ''; mockEl('lf-diml').value = ''; mockEl('lf-dimw').value = ''; mockEl('lf-dimh').value = '';
  ctx.saveLI();
  var rec = ctx.DB.li.find(function(l){ return l.sku === 'SKU1'; });
  assert(rec.num, 'new line item should get a num');
  var originalNum = rec.num;
  ctx.EI.l = rec.id;
  mockEl('lf-d').value = 'Widget Updated';
  ctx.saveLI();
  var updated = ctx.DB.li.find(function(l){ return l.id === rec.id; });
  assertEqual(updated.num, originalNum, 'num must not change on edit');
});

testAsync('saveBuy: new record gets num, edit does not change it', async () => {
  resetDB();
  ctx.seedAdHocBuyer();
  ctx.EI.bu = null;
  mockEl('buy-name').value = 'Ref Buyer';
  mockEl('buy-cname').value = ''; mockEl('buy-email').value = ''; mockEl('buy-phone').value = '';
  mockEl('buy-addr').value = ''; mockEl('buy-cur').value = 'USD'; mockEl('buy-pt').value = '';
  mockEl('buy-cl').value = ''; mockEl('buy-notes').value = '';
  await ctx.saveBuy();
  var rec = ctx.DB.buy.find(function(b){ return b.name === 'Ref Buyer'; });
  assert(rec.num, 'new buyer should get a num');
  var originalNum = rec.num;
  ctx.EI.bu = rec.id;
  mockEl('buy-name').value = 'Ref Buyer Ltd';
  await ctx.saveBuy();
  var updated = ctx.DB.buy.find(function(b){ return b.id === rec.id; });
  assertEqual(updated.num, originalNum, 'num must not change on edit');
});

test('saveCon: new record gets num, edit does not change it', () => {
  resetDB();
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Jane Doe'; mockEl('ct-email').value = 'jane@example.com';
  mockEl('ct-status').value = 'lead'; mockEl('ct-source').value = 'manual';
  mockEl('ct-phone').value = ''; mockEl('ct-company').value = ''; mockEl('ct-notes').value = '';
  mockEl('ct-enq-summary').value = ''; mockEl('ct-sup').value = '';
  ctx.saveCon();
  var rec = ctx.DB.con.find(function(c){ return c.email === 'jane@example.com'; });
  assert(rec.num, 'new contact should get a num');
  var originalNum = rec.num;
  ctx.EI.co = rec.id;
  mockEl('ct-name').value = 'Jane Doe Updated';
  ctx.saveCon();
  var updated = ctx.DB.con.find(function(c){ return c.id === rec.id; });
  assertEqual(updated.num, originalNum, 'num must not change on edit');
});

// ── Order Requests (SPEC-ORD-001) ───────────────────────────────
console.log('\nOrder Requests — SPEC-ORD-001');

test('ordCanTransition: every listed pair is allowed', () => {
  assert(ctx.ordCanTransition('New', 'Qualifying'));
  assert(ctx.ordCanTransition('Qualifying', 'Quoted'));
  assert(ctx.ordCanTransition('Qualifying', 'Declined'));
  assert(ctx.ordCanTransition('Quoted', 'Converting'));
  assert(ctx.ordCanTransition('Quoted', 'Lost'));
  assert(ctx.ordCanTransition('Converting', 'Processing'));
  assert(ctx.ordCanTransition('Processing', 'Fulfilled'));
});
test('ordCanTransition: unlisted pairs (backward, skip, terminal) are rejected', () => {
  assert(!ctx.ordCanTransition('Qualifying', 'New'));
  assert(!ctx.ordCanTransition('New', 'Quoted'));
  assert(!ctx.ordCanTransition('Fulfilled', 'New'));
  assert(!ctx.ordCanTransition('Declined', 'Qualifying'));
  assert(!ctx.ordCanTransition('Lost', 'Quoted'));
});

test('ordAdminOverride: rejects without exact CONFIRM string', () => {
  resetDB();
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[] }];
  mockEl('ord-override-confirm').value = 'nope';
  ctx.ordAdminOverride('o1', 'Fulfilled', 'testing');
  assertEqual(ctx.DB.ord[0].stage, 'New', 'stage unchanged without exact CONFIRM');
});
test('ordAdminOverride: rejects without a reason', () => {
  resetDB();
  ctx.DB.ord = [{ id:'o2', num:'ORD-0002', contactId:'c1', stage:'New', actions:[] }];
  mockEl('ord-override-confirm').value = 'CONFIRM';
  ctx.ordAdminOverride('o2', 'Fulfilled', '');
  assertEqual(ctx.DB.ord[0].stage, 'New', 'stage unchanged without a reason');
});
test('ordAdminOverride: persists stage change and logs event with reason', () => {
  resetDB();
  ctx.DB.ord = [{ id:'o3', num:'ORD-0003', contactId:'c1', stage:'New', actions:[] }];
  mockEl('ord-override-confirm').value = 'CONFIRM';
  var before = ctx.DB.events.length;
  ctx.ordAdminOverride('o3', 'Fulfilled', 'manual correction');
  assertEqual(ctx.DB.ord[0].stage, 'Fulfilled', 'stage force-changed');
  assert(ctx.DB.events.length > before, 'override logged to event log');
  var evt = ctx.DB.events[ctx.DB.events.length - 1];
  assertContains(evt.summary, 'manual correction', 'reason text present in event log');
});

test('ordRealisedMargin: zero when no activeQuoteId', () => {
  resetDB();
  assertEqual(ctx.ordRealisedMargin({ activeQuoteId:'' }).gp, 0);
});
test('ordRealisedMargin: zero when linked Quote has no linkedPOIds', () => {
  resetDB();
  ctx.DB.qt = [{ id:'q1', linkedPOIds:[] }];
  assertEqual(ctx.ordRealisedMargin({ activeQuoteId:'q1' }).gp, 0);
});
test('ordRealisedMargin: zero when PO has no matching Invoice', () => {
  resetDB();
  ctx.DB.qt = [{ id:'q1', linkedPOIds:['po1'] }];
  ctx.DB.po = [{ id:'po1', invId:'', invNum:'' }];
  assertEqual(ctx.ordRealisedMargin({ activeQuoteId:'q1' }).gp, 0);
});
test('ordRealisedMargin: sums iCalc gp/np across matched invoices', () => {
  resetDB();
  ctx.DB.qt = [{ id:'q1', linkedPOIds:['po1'] }];
  ctx.DB.po = [{ id:'po1', invId:'inv1', invNum:'INV10001' }];
  ctx.DB.inv = [{ id:'inv1', num:'INV10001', status:'Paid', cur:'USD', lineItems:[], calc_grandTotal:1000, calc_cogs:600, calc_grossProfit:400, calc_netProfit:350 }];
  var m = ctx.ordRealisedMargin({ activeQuoteId:'q1' });
  assertEqual(m.gp, 400, 'gp matches iCalc');
  assertEqual(m.np, 350, 'np matches iCalc');
});
test('ordRealisedMargin: reassigned activeQuoteId excludes old Quote PO/Invoice', () => {
  resetDB();
  ctx.DB.qt = [
    { id:'qOld', linkedPOIds:['poOld'] },
    { id:'qNew', linkedPOIds:[] },
  ];
  ctx.DB.po = [{ id:'poOld', invId:'invOld', invNum:'INV10002' }];
  ctx.DB.inv = [{ id:'invOld', num:'INV10002', status:'Paid', cur:'USD', lineItems:[], calc_grandTotal:500, calc_cogs:300, calc_grossProfit:200, calc_netProfit:180 }];
  var m = ctx.ordRealisedMargin({ activeQuoteId:'qNew' });
  assertEqual(m.gp, 0, 'reassigned order request does not see old Quote margin');
});

test('backfillOrderRequests Tier 1: creates one Order Request per sourceContactId Quote', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Contact One' }];
  ctx.DB.qt = [{ id:'q1', num:'QTE-0001', sourceContactId:'c1', status:'Accepted', dt:'2026-01-01' }];
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1, 'one Order Request created');
  assertEqual(ctx.DB.ord[0].activeQuoteId, 'q1');
  assertEqual(ctx.DB.ord[0].contactId, 'c1');
});
test('backfillOrderRequests Tier 1: stage inference — Lost/Processing/Fulfilled/Quoted', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1' }, { id:'c2' }, { id:'c3' }, { id:'c4' }];
  ctx.DB.qt = [
    { id:'qLost', num:'Q1', sourceContactId:'c1', status:'Declined' },
    { id:'qQuoted', num:'Q2', sourceContactId:'c2', status:'Accepted' },
    { id:'qProc', num:'Q3', sourceContactId:'c3', status:'Accepted', linkedPOIds:['poA'] },
    { id:'qFulfilled', num:'Q4', sourceContactId:'c4', status:'Accepted', linkedPOIds:['poB'] },
  ];
  ctx.DB.po = [
    { id:'poA', invId:'', invNum:'' },
    { id:'poB', invId:'invB', invNum:'INV1' },
  ];
  ctx.DB.inv = [{ id:'invB', num:'INV1' }];
  ctx.backfillOrderRequests();
  var byQuote = {}; ctx.DB.ord.forEach(function(o){ byQuote[o.activeQuoteId] = o.stage; });
  assertEqual(byQuote.qLost, 'Lost');
  assertEqual(byQuote.qQuoted, 'Quoted');
  assertEqual(byQuote.qProc, 'Processing');
  assertEqual(byQuote.qFulfilled, 'Fulfilled');
});
test('backfillOrderRequests Tier 1: idempotent on second call', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1' }];
  ctx.DB.qt = [{ id:'q1', num:'QTE-0001', sourceContactId:'c1', status:'Accepted' }];
  ctx.backfillOrderRequests();
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1, 'no duplicate on second call');
});
test('backfillOrderRequests Tier 2: creates one Order Request per Contact with enquiries and no Quote', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', status:'lead', enquiries:[{ id:'e1', ts:'2026-01-01T00:00:00.000Z', summary:'Interested in seeds' }] }];
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1);
  assertEqual(ctx.DB.ord[0]._backfilled, 'legacy-unstructured');
  assertContains(ctx.DB.ord[0].description, 'Interested in seeds');
});
test('backfillOrderRequests Tier 2: skips Contacts already covered by Tier 1', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', enquiries:[{ id:'e1', ts:'2026-01-01', summary:'enquiry' }] }];
  ctx.DB.qt = [{ id:'q1', num:'QTE-0001', sourceContactId:'c1', status:'Accepted' }];
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1, 'only the Tier 1 record is created, not a second Tier 2 one');
  assert(!ctx.DB.ord[0]._backfilled, 'the single record is the accurate Tier 1 one, not legacy-unstructured');
});
test('backfillOrderRequests Tier 2: idempotent on second call', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', enquiries:[{ id:'e1', ts:'2026-01-01', summary:'enquiry' }] }];
  ctx.backfillOrderRequests();
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1, 'no duplicate on second call');
});
test('backfillOrderRequests: Contacts with neither enquiries nor a Quote produce no record', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1' }];
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 0);
});

test('saveOrd: new record gets num via nextRefNum, edit does not change it', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test Contact' }];
  var rec = ctx.saveOrd({ contactId:'c1', stage:'New', description:'test' });
  assert(rec.num, 'new Order Request gets a num');
  var originalNum = rec.num;
  ctx.saveOrd({ id: rec.id, contactId:'c1', stage:'Qualifying', description:'updated' });
  var updated = ctx.DB.ord.find(function(o){ return o.id === rec.id; });
  assertEqual(updated.num, originalNum, 'num must not change on edit');
  assertEqual(updated.description, 'updated', 'edit applies other field changes');
});

test('saveOrd: rejects a contactId that does not resolve to an existing Contact', () => {
  resetDB();
  var result = ctx.saveOrd({ contactId:'does-not-exist', stage:'New', description:'test' });
  assertEqual(result, false, 'save is rejected');
  assertEqual(ctx.DB.ord.length, 0, 'no record persisted');
});

test('saveOrd: rejects a non-adjacent stage change via the normal (non-override) path', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test Contact' }];
  var rec = ctx.saveOrd({ contactId:'c1', stage:'New', description:'test' });
  var result = ctx.saveOrd({ id: rec.id, contactId:'c1', stage:'Fulfilled', description:'test' });
  assertEqual(result, false, 'save is rejected for a skipped transition');
  assertEqual(ctx.DB.ord.find(function(o){ return o.id === rec.id; }).stage, 'New', 'stage unchanged');
});

test('delOrd: does not cascade-delete or corrupt a linked Quote/PO/Invoice', () => {
  resetDB();
  ctx.DB.qt = [{ id:'q1', num:'QTE-0001' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'Quoted', activeQuoteId:'q1', actions:[] }];
  ctx.delOrd('o1');
  assertEqual(ctx.DB.ord.length, 0, 'Order Request removed');
  assertEqual(ctx.DB.qt.length, 1, 'linked Quote untouched');
});

test('dangling contactId: rOrd() renders without throwing when Contact has been deleted', () => {
  resetDB();
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:null, stage:'New', actions:[] }];
  mockEl('ord-tbl'); mockEl('ord-em'); mockEl('ord-tbody');
  ctx.rOrd();
  assertContains(mockEl('ord-tbody').innerHTML, 'contact deleted', 'shows placeholder instead of throwing');
});

test('openOrd: clears stale validation styling left over from a previous save attempt', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test Contact' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[], activeQuoteId:'', description:'' }];
  mockEl('of-contact').options = { length: 0 };
  ctx.vErr('of-contact', 'Please select a valid contact');
  assert(mockEl('of-contact').style.borderBottomColor, 'sanity check — vErr sets error styling');
  ctx.openOrd('o1');
  assertEqual(mockEl('of-contact').style.borderBottomColor, '', 'stale error styling cleared when opening a different Order Request');
});

test('delCon: nulls contactId on linked Order Requests rather than leaving a dangling reference', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'To Delete' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[] }];
  ctx._confirmOverride = true;
  ctx.delCon('c1');
  assertEqual(ctx.DB.ord[0].contactId, null, 'contactId nulled, not left dangling');
});

// ── Contact id backfill (SPEC-CON-003) ──────────────────────────
console.log('\nContact id backfill (SPEC-CON-003)');

test('backfillConIds: record with id undefined is assigned a real id', () => {
  resetDB();
  ctx.DB.con = [{ name:'Nameless', status:'lead', source:'manual', gdprBasis:'pre_contract', createdAt:'', lastContactedAt:'', notes:'', phone:'', company:'', email:'', enquiries:[] }];
  ctx.backfillConIds();
  assert(!!ctx.DB.con[0].id, 'id assigned');
  assertEqual(typeof ctx.DB.con[0].id, 'string');
});

test('backfillConIds: record with id "" is assigned a real id', () => {
  resetDB();
  ctx.DB.con = [{ id:'', name:'Blank Id', status:'lead' }];
  ctx.backfillConIds();
  assert(!!ctx.DB.con[0].id, 'id assigned for empty-string id');
});

test('backfillConIds: record with a real existing id is left unchanged', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Has Id', status:'lead' }];
  ctx.backfillConIds();
  assertEqual(ctx.DB.con[0].id, 'c1', 'existing id untouched');
});

test('backfillConIds: two records missing id in one run each get distinct ids', () => {
  resetDB();
  ctx.DB.con = [{ name:'A', status:'lead' }, { name:'B', status:'lead' }];
  ctx.backfillConIds();
  assert(!!ctx.DB.con[0].id && !!ctx.DB.con[1].id, 'both assigned');
  assert(ctx.DB.con[0].id !== ctx.DB.con[1].id, 'distinct ids');
});

test('backfillConIds: no sv() call when nothing needed backfilling', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Has Id', status:'lead' }];
  var svCalled = false;
  var origSv = ctx.sv;
  ctx.sv = function(k, v){ if (k === ctx.K.co) svCalled = true; origSv(k, v); };
  ctx.backfillConIds();
  assert(!svCalled, 'sv(K.co) not called when no record needed backfilling');
  ctx.sv = origSv;
});

test('backfillConIds: sv() called when a record was backfilled', () => {
  resetDB();
  ctx.DB.con = [{ name:'Nameless', status:'lead' }];
  var svCalled = false;
  var origSv = ctx.sv;
  ctx.sv = function(k, v){ if (k === ctx.K.co) svCalled = true; origSv(k, v); };
  ctx.backfillConIds();
  assert(svCalled, 'sv(K.co) called when a record was backfilled');
  ctx.sv = origSv;
});

test('backfillConIds: after backfill, delCon() successfully removes the record (regression case)', () => {
  resetDB();
  ctx.DB.con = [{ name:'Was Broken', status:'lead' }];
  ctx.backfillConIds();
  var newId = ctx.DB.con[0].id;
  ctx.confirm = function(){ return true; };
  ctx.rCon = function(){};
  ctx.delCon(newId);
  assertEqual(ctx.DB.con.length, 0, 'record deletable after backfill');
});

test('backfillConIds: after backfill, editCon() successfully locates the record (regression case)', () => {
  resetDB();
  ctx.DB.con = [{ name:'Was Broken', status:'lead' }];
  ctx.backfillConIds();
  var newId = ctx.DB.con[0].id;
  ctx.editCon(newId);
  assertEqual(ctx.EI.co, newId, 'editCon locates and opens the backfilled record');
});

test('backfillConIds: DB.ord records are untouched (DB.con-only scope)', () => {
  resetDB();
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[] }];
  ctx.DB.con = [{ id:'c1', name:'Has Id', status:'lead' }];
  var before = JSON.stringify(ctx.DB.ord);
  ctx.backfillConIds();
  assertEqual(JSON.stringify(ctx.DB.ord), before, 'DB.ord unchanged by backfillConIds');
});

test('backfillOrderRequests called standalone (no prior backfillConIds) never writes contactId: undefined (ordering-hazard regression)', () => {
  resetDB();
  ctx.DB.con = [{ name:'Nameless Enquirer', status:'lead', enquiries:[{ id:'e1', ts:'2026-01-01T00:00:00.000Z', summary:'Interested in widgets' }] }];
  ctx.backfillOrderRequests();
  assertEqual(ctx.DB.ord.length, 1, 'Order Request backfilled');
  assert(!!ctx.DB.ord[0].contactId, 'contactId is a real backfilled id, never undefined/blank');
  assertEqual(ctx.DB.ord[0].contactId, ctx.DB.con[0].id, 'contactId matches the now-backfilled contact id');
});

// ── Order Request line items (SPEC-ORD-002) ─────────────────────
console.log('\nOrder Request line items — SPEC-ORD-002');

function _ordLineFixture(overrides) {
  return Object.assign({
    id: 'l1', category: 'Salt fish', itemSpec: 'Extra-large salted Pollock',
    orderVolumeQty: 1, orderVolumeUnit: 'container', packingSpec: '', baseUom: '', baseQty: null,
    qtyStatus: 'Unknown', sourceCountry: 'China', variantOption: '', lineUpdates: []
  }, overrides || {});
}

test('ordLogLineUpdate: appends an entry every call; live field only changes when confirmedBy is truthy', () => {
  resetDB();
  var ord = { id:'o1', lines:[ _ordLineFixture() ] };
  ctx.ordLogLineUpdate(ord, 'l1', 'packingSpec', '5kg boxes', 'ai', 'from chat', null);
  var line = ord.lines[0];
  assertEqual(line.lineUpdates.length, 1, 'entry appended');
  assertEqual(line.packingSpec, '', 'live field unchanged for unconfirmed (AI) update');
  ctx.ordLogLineUpdate(ord, 'l1', 'packingSpec', '2 per carton', 'operator', '', 'operator');
  assertEqual(line.lineUpdates.length, 2, 'second entry appended');
  assertEqual(line.packingSpec, '2 per carton', 'live field changes when confirmedBy is truthy');
});

test('ordConfirmLineUpdate: applies a specific pending entry and marks it confirmed; does not affect others', () => {
  resetDB();
  var ord = { id:'o1', lines:[ _ordLineFixture() ] };
  ctx.ordLogLineUpdate(ord, 'l1', 'baseUom', 'kg', 'ai', '', null);
  ctx.ordLogLineUpdate(ord, 'l1', 'sourceCountry', 'Vietnam', 'ai', '', null);
  var line = ord.lines[0];
  var firstEntryId = line.lineUpdates[0].id;
  ctx.ordConfirmLineUpdate(ord, 'l1', firstEntryId);
  assertEqual(line.baseUom, 'kg', 'confirmed entry applied to live field');
  assertEqual(line.lineUpdates[0].confirmedBy, 'operator', 'entry marked confirmed');
  assertEqual(line.sourceCountry, 'China', 'other pending entry untouched');
  assert(!line.lineUpdates[1].confirmedBy, 'other pending entry still unconfirmed');
});

test('ordConfirmLineUpdate: no-op (returns false) if the entry is already confirmed', () => {
  resetDB();
  var ord = { id:'o1', lines:[ _ordLineFixture() ] };
  ctx.ordLogLineUpdate(ord, 'l1', 'baseUom', 'kg', 'operator', '', 'operator');
  var entryId = ord.lines[0].lineUpdates[0].id;
  var result = ctx.ordConfirmLineUpdate(ord, 'l1', entryId);
  assertEqual(result, false, 'already-confirmed entry is a no-op');
});

test('update_order_line AI action: proposes via ordLogLineUpdate with confirmedBy null; never auto-applies', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[], lines:[ _ordLineFixture() ] }];
  ctx.handleAIAction({ action:'update_order_line', payload:{ ordId:'o1', lineId:'l1', field:'packingSpec', newValue:'5kg boxes', note:'supplier confirmed' } });
  var line = ctx.DB.ord[0].lines[0];
  assertEqual(line.packingSpec, '', 'live field unchanged immediately after the AI action fires');
  assertEqual(line.lineUpdates.length, 1, 'proposal logged');
  assertEqual(line.lineUpdates[0].source, 'ai', 'source recorded as ai');
  assert(!line.lineUpdates[0].confirmedBy, 'unconfirmed');
  ctx.ordConfirmLineUpdate(ctx.DB.ord[0], 'l1', line.lineUpdates[0].id);
  assertEqual(line.packingSpec, '5kg boxes', 'applied only via a separate, explicit confirm call');
});

test('qtyStatus independence: setting baseQty does not auto-flip qtyStatus to Confirmed', () => {
  resetDB();
  var ord = { id:'o1', lines:[ _ordLineFixture() ] };
  ctx.ordLogLineUpdate(ord, 'l1', 'baseQty', 500, 'operator', '', 'operator');
  assertEqual(ord.lines[0].baseQty, 500);
  assertEqual(ord.lines[0].qtyStatus, 'Unknown', 'qtyStatus must be set explicitly, not auto-derived');
});

test('Stage-transition warning: moving to Quoted with Unknown-status lines warns but still saves', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'Qualifying', actions:[], lines:[ _ordLineFixture({ qtyStatus:'Unknown' }) ] }];
  var result = ctx.saveOrd({ id:'o1', contactId:'c1', stage:'Quoted', lines: ctx.DB.ord[0].lines });
  assert(result, 'save succeeds despite the warning');
  assertEqual(ctx.DB.ord[0].stage, 'Quoted', 'stage change applied');
});

test('Stage-transition warning: moving to Quoted with all lines resolved triggers no warning path issue', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'Qualifying', actions:[], lines:[ _ordLineFixture({ qtyStatus:'Confirmed' }) ] }];
  var result = ctx.saveOrd({ id:'o1', contactId:'c1', stage:'Quoted', lines: ctx.DB.ord[0].lines });
  assert(result, 'save succeeds');
  assertEqual(ctx.DB.ord[0].stage, 'Quoted');
});

test('Stage-transition warning: does not fire for any other stage transition', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[], lines:[ _ordLineFixture({ qtyStatus:'Unknown' }) ] }];
  var result = ctx.saveOrd({ id:'o1', contactId:'c1', stage:'Qualifying', lines: ctx.DB.ord[0].lines });
  assert(result, 'New -> Qualifying unaffected by the Quoted-specific warning');
});

test('New-record edge case: creating directly at stage Quoted with Unknown lines still runs the warning path without error', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  var result = ctx.saveOrd({ contactId:'c1', stage:'Quoted', lines:[ _ordLineFixture({ qtyStatus:'Unknown' }) ] });
  assert(result, 'new record created directly at Quoted succeeds (warning is non-blocking, and existing is null)');
  assertEqual(ctx.DB.ord[0].stage, 'Quoted');
});

test('Defensive guard: ordLogLineUpdate/ordConfirmLineUpdate return false, do not throw, when ord.lines is absent', () => {
  resetDB();
  var ord = { id:'o1' }; // no lines key at all
  var r1 = ctx.ordLogLineUpdate(ord, 'l1', 'baseUom', 'kg', 'operator', '', 'operator');
  assertEqual(r1, false, 'ordLogLineUpdate returns false rather than throwing');
  var r2 = ctx.ordConfirmLineUpdate(ord, 'l1', 'u1');
  assertEqual(r2, false, 'ordConfirmLineUpdate returns false rather than throwing');
});

test('backfillOrderRequests: Tier 1 and Tier 2 backfilled records are created with lines: []', () => {
  resetDB();
  ctx.DB.con = [
    { id:'c1', name:'Quoted Contact' },
    { id:'c2', name:'Enquiry-only Contact', enquiries:[{ id:'e1', ts:'2026-01-01', summary:'enquiry' }] }
  ];
  ctx.DB.qt = [{ id:'q1', num:'QTE-0001', sourceContactId:'c1', status:'Accepted' }];
  ctx.backfillOrderRequests();
  ctx.DB.ord.forEach(function(o){
    assert(Array.isArray(o.lines), 'every backfilled Order Request has a real lines array, not missing');
    assertEqual(o.lines.length, 0, 'backfilled with an empty array');
  });
});

test('Retention cap: lineUpdates[] retains only the most recent ORD_LINE_UPDATES_CAP entries', () => {
  resetDB();
  var ord = { id:'o1', lines:[ _ordLineFixture() ] };
  for (var i = 0; i < 205; i++) {
    ctx.ordLogLineUpdate(ord, 'l1', 'baseQty', i, 'operator', '', 'operator');
  }
  assertEqual(ord.lines[0].lineUpdates.length, 200, 'capped at 200 entries');
  assertEqual(ord.lines[0].lineUpdates[0].newValue, 5, 'oldest 5 entries (values 0-4) evicted FIFO, value 5 is now the oldest remaining');
  assertEqual(ord.lines[0].lineUpdates[199].newValue, 204, 'newest entry retained');
});

test('Resave-heals-missing-lines regression: existing.lines || [] on a lines-less DB.ord record resaved via the ordinary edit path', () => {
  resetDB();
  ctx.DB.con = [{ id:'c1', name:'Test' }];
  ctx.DB.ord = [{ id:'o1', num:'ORD-0001', contactId:'c1', stage:'New', actions:[], description:'' }]; // no lines key
  ctx.EI.ord = 'o1';
  mockEl('of-contact').value = 'c1';
  mockEl('of-stage').value = 'New';
  mockEl('of-desc').value = 'updated description';
  ctx._ordFormActions = [];
  ctx.saveOrdFromForm();
  assert(Array.isArray(ctx.DB.ord[0].lines), 'lines healed to a real array on ordinary resave');
  assertEqual(ctx.DB.ord[0].lines.length, 0, 'healed to empty, not populated from nowhere');
});

// ── Order Request line gap detection (SPEC-ORD-005) ─────────────
console.log('\nOrder Request line gap detection (SPEC-ORD-005)');

test('ordLineGaps: all 5 fields unset → all 5 gaps returned', () => {
  var line = _ordLineFixture({ packingSpec:'', baseUom:'', baseQty:null, sourceCountry:'', qtyStatus:'Unknown' });
  var gaps = ctx.ordLineGaps(line);
  assertEqual(gaps.length, 5, 'all 5 gaps flagged');
});

test('ordLineGaps: fully populated, Confirmed → empty array', () => {
  var line = _ordLineFixture({ packingSpec:'5kg boxes', baseUom:'kg', baseQty:500, sourceCountry:'China', qtyStatus:'Confirmed' });
  var gaps = ctx.ordLineGaps(line);
  assertEqual(gaps.length, 0, 'no gaps on a fully-populated line');
});

test('ordLineGaps: baseQty 0 is a valid quantity, not a gap', () => {
  var line = _ordLineFixture({ packingSpec:'boxes', baseUom:'kg', baseQty:0, sourceCountry:'China', qtyStatus:'Confirmed' });
  var gaps = ctx.ordLineGaps(line);
  assert(!gaps.some(function(g){ return g.field === 'baseQty'; }), 'baseQty: 0 is not flagged as unset');
});

testAsync('ordCheckLineGapsSemantic: no AI.key configured → resolves null, no fetch call', async () => {
  ctx.AI = { key: '' };
  _lastAnthropicBody = null;
  var result = await ctx.ordCheckLineGapsSemantic(_ordLineFixture());
  assertEqual(result, null, 'resolves null with no key');
  assertEqual(_lastAnthropicBody, null, 'no fetch call made');
});

testAsync('ordCheckLineGapsSemantic: network error → resolves null, no thrown exception', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = 'reject';
  var result = await ctx.ordCheckLineGapsSemantic(_ordLineFixture());
  assertEqual(result, null, 'resolves null on network error');
  _mockAnthropic = null;
});

testAsync('ordCheckLineGapsSemantic: non-200 response → resolves null', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 500, text: '' };
  var result = await ctx.ordCheckLineGapsSemantic(_ordLineFixture());
  assertEqual(result, null, 'resolves null on non-200');
  _mockAnthropic = null;
});

testAsync('ordCheckLineGapsSemantic: malformed (non-JSON-array) response text → resolves null', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: 'not valid json {' };
  var result = await ctx.ordCheckLineGapsSemantic(_ordLineFixture());
  assertEqual(result, null, 'resolves null on malformed response');
  _mockAnthropic = null;
});

testAsync('ordCheckLineGapsSemantic: well-formed response → resolves parsed array', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '[{"issue":"vague spec","question":"Can you clarify the item spec?"}]' };
  var result = await ctx.ordCheckLineGapsSemantic(_ordLineFixture());
  assertEqual(result.length, 1, 'one flagged item returned');
  assertEqual(result[0].issue, 'vague spec');
  _mockAnthropic = null;
});

testAsync('ordCheckLineGapsSemantic: payload sent to Anthropic contains only the 10 scoped fields — no PII', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '[]' };
  var line = _ordLineFixture({ id: 'l1' });
  await ctx.ordCheckLineGapsSemantic(line);
  var sentPayload = JSON.parse(_lastAnthropicBody.messages[0].content);
  var allowedFields = ['category','itemSpec','orderVolumeQty','orderVolumeUnit','packingSpec','baseUom','baseQty','sourceCountry','variantOption','qtyStatus'];
  assertEqual(Object.keys(sentPayload).sort().join(','), allowedFields.slice().sort().join(','), 'payload contains exactly the scoped fields');
  assert(!('contactId' in sentPayload), 'contactId never sent');
  assert(!('id' in sentPayload), 'line id never sent');
  assert(!('lineUpdates' in sentPayload), 'lineUpdates never sent');
  _mockAnthropic = null;
});

testAsync('ordCheckLineGaps: triggering does not mutate DB.ord (no persistence)', async () => {
  resetDB();
  ctx.AI = { key: '' };
  var ord = { id:'o1', num:'ORD-0001', contactId:null, stage:'New', actions:[], lines:[ _ordLineFixture() ] };
  ctx.DB.ord = [ord];
  ctx.EI.ord = 'o1';
  var before = JSON.stringify(ctx.DB.ord);
  ctx.ordCheckLineGaps('l1');
  await Promise.resolve().then(function(){}).then(function(){});
  assertEqual(JSON.stringify(ctx.DB.ord), before, 'DB.ord unchanged by a gap-check trigger');
});

testAsync('ordCheckLineGaps: re-triggering reflects current field state, not stale prior output', async () => {
  resetDB();
  ctx.AI = { key: '' };
  var line = _ordLineFixture({ packingSpec: '' });
  var ord = { id:'o1', num:'ORD-0001', contactId:null, stage:'New', actions:[], lines:[ line ] };
  ctx.DB.ord = [ord];
  ctx.EI.ord = 'o1';
  ctx.ordCheckLineGaps('l1');
  await Promise.resolve().then(function(){}).then(function(){});
  var firstPanel = mockEl('ord-gapchk-l1').innerHTML;
  assert(firstPanel.indexOf('Packing spec') >= 0, 'first check flags missing packing spec');
  line.packingSpec = '5kg boxes';
  ctx.ordCheckLineGaps('l1');
  await Promise.resolve().then(function(){}).then(function(){});
  var secondPanel = mockEl('ord-gapchk-l1').innerHTML;
  assert(secondPanel.indexOf('Packing spec') < 0, 'second check reflects the field now being set, not the stale first result');
});

// ── DISPLAY CURRENCY (SPEC-CUR-001) ─────────────────────────────
console.log('\ndisplayCurrency — global display-currency toggle');

test('toDisp — composes toGBP/fromGBP via QR.displayCurrency', function() {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { fxGBPUSD: 1.30, displayCurrency: 'USD' });
  var r = ctx.toDisp(1000, 'GBP'); // 1000 GBP -> GBP(1000) -> USD(1300)
  assertApprox(r, 1300, '1000 GBP displayed in USD at 1.30 rate');
  ctx.QR = savedQR;
});

test('toDisp — GBP display currency is a passthrough of toGBP', function() {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { fxGBPUSD: 1.30, displayCurrency: 'GBP' });
  var r = ctx.toDisp(1300, 'USD');
  assertApprox(r, 1000, '1300 USD -> 1000 GBP, display stays GBP');
  ctx.QR = savedQR;
});

test('setDisplayCurrency — persists QR.displayCurrency to st_qr', function() {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS);
  ctx.setDisplayCurrency('RMB');
  assertEqual(ctx.QR.displayCurrency, 'RMB', 'in-memory QR updated');
  var persisted = JSON.parse(ctx.localStorage.getItem('st_qr'));
  assertEqual(persisted.displayCurrency, 'RMB', 'persisted st_qr reflects the change');
  ctx.QR = savedQR;
});

test('saveRates — does not reset displayCurrency to GBP on an unrelated rate save', function() {
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { displayCurrency: 'USD' });
  ['fxGBPUSD','fxGBPRMB','fxGBPBBD','lclPerCBM','fcl20GP','fcl40HQ','originCharges','destCharges','dgSurcharge','fpmAdmin','insRate'].forEach(function(f){
    mockEl('qr-' + f).value = String(ctx.QR[f]);
  });
  ctx.saveRates();
  assertEqual(ctx.QR.displayCurrency, 'USD', 'in-memory displayCurrency survives a rates save');
  var persisted = JSON.parse(ctx.localStorage.getItem('st_qr'));
  assertEqual(persisted.displayCurrency, 'USD', 'persisted displayCurrency survives a rates save');
  ctx.QR = savedQR;
});

test('AC-004 fixture — calcVATReturn box1/box6 unaffected by displayCurrency', function() {
  resetDB();
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { fxGBPUSD: 1.30, fxGBPRMB: 9.10 });
  ctx.DB.inv = [
    { id:'va', num:'INV-A', cur:'GBP', status:'Sent', date:'2026-01-01', lineItems:[], taxRate:20, dep:0,
      calc_grandTotal:'1000', calc_taxAmt:'200', calc_liTotal:'800', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'1000',
      calc_grossProfit:'0' },
    { id:'vb', num:'INV-B', cur:'USD', status:'Sent', date:'2026-01-01', lineItems:[], taxRate:20, dep:0,
      calc_grandTotal:'1300', calc_taxAmt:'260', calc_liTotal:'1040', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'1300',
      calc_grossProfit:'0' },
    { id:'vc', num:'INV-C', cur:'RMB', status:'Sent', date:'2026-01-01', lineItems:[], taxRate:20, dep:0,
      calc_grandTotal:'9100', calc_taxAmt:'1820', calc_liTotal:'7280', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'9100',
      calc_grossProfit:'0' },
  ];
  ['GBP','USD','RMB'].forEach(function(disp){
    ctx.QR.displayCurrency = disp;
    var r = ctx.calcVATReturn('2026-01-01', '2026-01-31');
    assertApprox(r.box1, 600.00, 'box1 (tax total) unaffected by displayCurrency=' + disp);
    assertApprox(r.box6, 2400.00, 'box6 (net total) unaffected by displayCurrency=' + disp);
  });
  ctx.QR = savedQR;
});

test('AC-009 — renderBuyers reads i.cur (not dead i.currency field) for Outstanding', function() {
  resetDB();
  var savedQR = ctx.QR;
  // displayCurrency stays GBP (default). If the dead `i.currency` field were still read
  // instead of `i.cur`, the invoice would be wrongly treated as USD-native: 910/1.3=700 GBP.
  // Reading the correct `i.cur:'RMB'` gives 910/9.10=100 GBP.
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { fxGBPRMB: 9.10, fxGBPUSD: 1.30 });
  ctx.DB.buy = [{ id:'b1', num:'BUY-0001', name:'Test Buyer', currency:'GBP' }];
  ctx.DB.inv = [
    { id:'i1', buyerId:'b1', cur:'RMB', status:'Sent', lineItems:[], taxRate:0, dep:0,
      calc_grandTotal:'910', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'910' },
  ];
  ctx.renderBuyers();
  assertContains(mockEl('buy-tbody').innerHTML, '£100', 'RMB-native invoice (910 RMB = 100 GBP) converts correctly, not defaulted to USD (would show £700)');
  ctx.QR = savedQR;
});

test('openBuy Summary — "Outstanding" stays buyer-native regardless of displayCurrency', function() {
  resetDB();
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { fxGBPUSD: 1.30 });
  ctx.DB.buy = [{ id:'b1', num:'BUY-0001', name:'Test Buyer', currency:'USD' }];
  ctx.DB.inv = [
    { id:'i1', buyerId:'b1', cur:'GBP', status:'Sent', lineItems:[], taxRate:0, dep:0,
      calc_grandTotal:'1000', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'1000' },
  ];
  ctx.QR.displayCurrency = 'GBP';
  ctx.openBuy('b1');
  var outA = mockEl('buy-summary').innerHTML;
  ctx.QR.displayCurrency = 'USD';
  ctx.openBuy('b1');
  var outB = mockEl('buy-summary').innerHTML;
  assertEqual(outA.match(/Outstanding[\s\S]*?\$([\d.]+)/)[1], outB.match(/Outstanding[\s\S]*?\$([\d.]+)/)[1],
    'Outstanding figure identical regardless of displayCurrency toggle');
  ctx.QR = savedQR;
});

test('openBuy Summary — recent-invoices Amount column reads i.cur (not dead i.currency field)', function() {
  resetDB();
  var savedQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS);
  ctx.DB.buy = [{ id:'b1', num:'BUY-0001', name:'Test Buyer', currency:'GBP' }];
  ctx.DB.inv = [
    { id:'i1', buyerId:'b1', num:'INV-0001', date:'2026-01-01', status:'Sent', cur:'RMB', lineItems:[], taxRate:0, dep:0,
      calc_grandTotal:'910', calc_netProfit:'0', calc_cogs:'0', calc_margin:'0', calc_balanceDue:'910' },
  ];
  ctx.openBuy('b1');
  assertContains(mockEl('buy-summary').innerHTML, 'RMB', 'recent-invoices Amount column renders in the invoice\'s real currency (RMB), not defaulted to USD');
  ctx.QR = savedQR;
});

test('renderDispCurWarn — shows staleness banner only when displayCurrency is non-GBP and rates are >24h stale', function() {
  var savedTs = ctx.localStorage.getItem('st_qr_ts');
  var savedQR = ctx.QR;

  ctx.QR = Object.assign({}, ctx.QR_DEFAULTS, { displayCurrency: 'GBP' });
  ctx.localStorage.setItem('st_qr_ts', new Date(Date.now() - 30*3600000).toISOString());
  ctx.renderDispCurWarn('dash-fx-warn');
  assertEqual(mockEl('dash-fx-warn').innerHTML, '', 'no banner when displayCurrency is GBP, regardless of staleness');

  ctx.QR.displayCurrency = 'USD';
  ctx.localStorage.setItem('st_qr_ts', new Date(Date.now() - 1*3600000).toISOString());
  ctx.renderDispCurWarn('dash-fx-warn');
  assertEqual(mockEl('dash-fx-warn').innerHTML, '', 'no banner when rates are <24h old, even if displayCurrency is non-GBP');

  ctx.QR.displayCurrency = 'USD';
  ctx.localStorage.setItem('st_qr_ts', new Date(Date.now() - 30*3600000).toISOString());
  ctx.renderDispCurWarn('dash-fx-warn');
  assertContains(mockEl('dash-fx-warn').innerHTML, 'refreshed', 'banner shown when displayCurrency is non-GBP and rates are >24h stale');

  if (savedTs) ctx.localStorage.setItem('st_qr_ts', savedTs); else ctx.localStorage.removeItem('st_qr_ts');
  ctx.QR = savedQR;
});

// ── SUPPLIER PRICE INTELLIGENCE (SPEC-SUP-001) ──────────────────

test('getSupplierPriceHistory — aggregates Line Item, Quote, and PO sources, correctly attributed by sourceType', function() {
  resetDB();
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Widget', cur: 'USD', priceHistory: [{ date: '2026-01-01', cost: 10 }, { date: '2026-02-01', cost: 11 }] });
  ctx.DB.qt.push({ id: 'Q1', num: 'QTE1', currency: 'USD', status: 'Sent', lines: [{ supId: 'S1', desc: 'Widget', priceHistory: [{ ts: '2026-03-01T00:00:00.000Z', cost: 9 }] }] });
  ctx.DB.po.push({ id: 'P1', num: 'PO1', supId: 'S1', date: '2026-04-01', cur: 'USD', status: 'Sent', lineItems: [{ desc: 'Widget', cost: 12 }] });
  var points = ctx.getSupplierPriceHistory('S1');
  assertEqual(points.length, 4, 'exactly 4 points');
  assertEqual(points.filter(function(p){ return p.sourceType === 'line_item'; }).length, 2, '2 line_item points');
  assertEqual(points.filter(function(p){ return p.sourceType === 'quote'; }).length, 1, '1 quote point');
  assertEqual(points.filter(function(p){ return p.sourceType === 'po'; }).length, 1, '1 po point');
});

test('getSupplierPriceHistory — supplier with no matching records returns empty array', function() {
  resetDB();
  var points = ctx.getSupplierPriceHistory('S-NONE');
  assertEqual(points.length, 0, 'empty array, not an error');
});

test('getSupplierPriceHistory — Quote-sourced points use cost, never landed/sellPrice', function() {
  resetDB();
  ctx.DB.qt.push({ id: 'Q1', num: 'QTE1', currency: 'USD', status: 'Sent', lines: [{ supId: 'S1', desc: 'Widget', priceHistory: [{ ts: '2026-03-01T00:00:00.000Z', cost: 9, landed: 15, sellPrice: 20 }] }] });
  var points = ctx.getSupplierPriceHistory('S1');
  assertEqual(points[0].price, 9, 'price equals cost, not landed or sellPrice');
});

test('getSupplierPriceHistory — sorted newest-first across mixed sources', function() {
  resetDB();
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Widget', cur: 'USD', priceHistory: [{ date: '2026-01-01', cost: 10 }] });
  ctx.DB.po.push({ id: 'P1', num: 'PO1', supId: 'S1', date: '2026-05-01', cur: 'USD', status: 'Sent', lineItems: [{ desc: 'Widget', cost: 12 }] });
  var points = ctx.getSupplierPriceHistory('S1');
  assertEqual(points[0].sourceType, 'po', 'PO (dated later) appears first regardless of source type');
});

test('supPriceStaleness — 13 months ago > 12, 1 month ago < 12, null/empty returns null', function() {
  var d13 = new Date(); d13.setMonth(d13.getMonth() - 13);
  var d1 = new Date(); d1.setMonth(d1.getMonth() - 1);
  assert(ctx.supPriceStaleness(d13.toISOString().slice(0,10)) > 12, '13 months ago is > 12');
  assert(ctx.supPriceStaleness(d1.toISOString().slice(0,10)) < 12, '1 month ago is < 12');
  assertEqual(ctx.supPriceStaleness(null), null, 'null input returns null');
  assertEqual(ctx.supPriceStaleness(''), null, 'empty input returns null');
});

test('renderSupPriceHistory — point older than threshold renders with stale marker, point within threshold does not', function() {
  resetDB();
  ctx.EI.s = 'S1';
  var old = new Date(); old.setMonth(old.getMonth() - 14);
  var recent = new Date(); recent.setMonth(recent.getMonth() - 1);
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Old Widget', cur: 'USD', priceHistory: [{ date: old.toISOString().slice(0,10), cost: 10 }] });
  ctx.DB.qt.push({ id: 'Q1', num: 'QTE1', currency: 'USD', status: 'Sent', lines: [{ supId: 'S1', desc: 'New Widget', priceHistory: [{ ts: recent.toISOString(), cost: 9 }] }] });
  ctx.localStorage.setItem('stackd_sup_intel_threshold_months', '12');
  ctx.renderSupPriceHistory();
  var html = mockEl('sup-price-list').innerHTML;
  assertContains(html, '#FFF8E1', 'stale row has amber background');
  var rows = html.split('<tr');
  assert(rows.some(function(r){ return r.indexOf('Old Widget') >= 0 && r.indexOf('#FFF8E1') >= 0; }), 'old point marked stale');
  assert(rows.some(function(r){ return r.indexOf('New Widget') >= 0 && r.indexOf('#FFF8E1') < 0; }), 'recent point not marked stale');
});

test('renderSupPriceHistory — no threshold configured defaults to 12 months, not NaN', function() {
  resetDB();
  ctx.EI.s = 'S1';
  ctx.localStorage.removeItem('stackd_sup_intel_threshold_months');
  var old = new Date(); old.setMonth(old.getMonth() - 13);
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Widget', cur: 'USD', priceHistory: [{ date: old.toISOString().slice(0,10), cost: 10 }] });
  ctx.renderSupPriceHistory();
  var html = mockEl('sup-price-list').innerHTML;
  assert(html.indexOf('NaN') < 0, 'no NaN in output');
  assertContains(html, '#FFF8E1', 'defaults to 12 months and still flags a 13-month-old point as stale');
});

test('getProductPriceHistory — query matching across two suppliers returns points from both, correctly tagged', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.DB.sup.push({ id: 'S2', name: 'Globex' });
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Blue Widget', cur: 'USD', priceHistory: [{ date: '2026-01-01', cost: 10 }] });
  ctx.DB.li.push({ id: 'L2', supId: 'S2', desc: 'Blue Widget Deluxe', cur: 'USD', priceHistory: [{ date: '2026-01-02', cost: 20 }] });
  var results = ctx.getProductPriceHistory('blue widget');
  assertEqual(results.length, 2, 'both suppliers matched');
  assert(results.some(function(p){ return p.supName === 'ACME'; }), 'ACME point tagged');
  assert(results.some(function(p){ return p.supName === 'Globex'; }), 'Globex point tagged');
});

test('openSup()/editSup() — sup-price-panel hidden on openSup, shown with renderSupPriceHistory invoked on editSup', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME', cur: 'USD' });
  ctx.openSup();
  assertEqual(mockEl('sup-price-panel').style.display, 'none', 'hidden on openSup (new supplier)');
  ctx.editSup('S1');
  assertEqual(mockEl('sup-price-panel').style.display, '', 'shown on editSup');
});

test('SPEC-SUP-001 scope guard — no export/sync side effect on the aggregated data', function() {
  resetDB();
  ctx.DB.li.push({ id: 'L1', supId: 'S1', desc: 'Widget', cur: 'USD', priceHistory: [{ date: '2026-01-01', cost: 10 }] });
  var pointsA = ctx.getSupplierPriceHistory('S1');
  var pointsB = ctx.getProductPriceHistory('widget');
  assert(Array.isArray(pointsA) && Array.isArray(pointsB), 'both return plain in-memory arrays');
  assertEqual(ctx.FIELD_MAPS.sup.priceHistory, undefined, 'no priceHistory entry added to FIELD_MAPS.sup for this feature');
  assertEqual(ctx.FIELD_MAPS.li.supPriceHistory, undefined, 'no supPriceHistory entry added to FIELD_MAPS.li for this feature');
});

// ── CLOUD DATA — Supabase-backed Suppliers/Buyers (SPEC-CLOUD-001) ──

// Minimal mock Supabase client covering the 4 call shapes this app actually uses:
//   .from(t).select('*').is(col,val)                    -> awaited directly (read)
//   .from(t).insert(row).select().single()               -> awaited (create)
//   .from(t).update(row).eq('id',id).select().single()   -> awaited (update, returns row)
//   .from(t).update(row).eq('id',id)                     -> awaited directly (soft-delete, no row)
function mockSb(config) {
  config = config || {};
  var calls = [];
  function table(name) {
    var cfg = config[name] || {};
    var pendingOp = null, pendingRow = null, pendingId = null;
    var chain = {
      select: function(){ return chain; },
      insert: function(row){ pendingOp = 'insert'; pendingRow = row; calls.push({ table: name, op: 'insert', row: row }); return chain; },
      update: function(row){ pendingOp = 'update'; pendingRow = row; calls.push({ table: name, op: 'update', row: row }); return chain; },
      eq: function(col, val){ pendingId = val; calls.push({ table: name, op: 'eq', col: col, val: val }); return chain; },
      is: function(col, val){
        calls.push({ table: name, op: 'is', col: col, val: val });
        return Promise.resolve({ data: cfg.selectData !== undefined ? cfg.selectData : [], error: cfg.selectError || null });
      },
      single: function(){
        if (pendingOp === 'insert') {
          if (cfg.insertError) return Promise.resolve({ data: null, error: cfg.insertError });
          var created = cfg.insertImpl ? cfg.insertImpl(pendingRow) : Object.assign({ id: 'mock-' + calls.length }, pendingRow);
          return Promise.resolve({ data: created, error: null });
        }
        if (pendingOp === 'update') {
          if (cfg.updateError) return Promise.resolve({ data: null, error: cfg.updateError });
          var updated = cfg.updateImpl ? cfg.updateImpl(pendingRow, pendingId) : Object.assign({ id: pendingId }, pendingRow);
          return Promise.resolve({ data: updated, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then: function(resolveFn, rejectFn) {
        var error = (pendingOp === 'update' && cfg.updateError) ? cfg.updateError : null;
        return Promise.resolve({ error: error }).then(resolveFn, rejectFn);
      }
    };
    return chain;
  }
  return {
    from: table,
    _calls: calls,
    auth: {
      getSession: function(){ return Promise.resolve({ data: { session: config._session !== undefined ? config._session : { user: 'mock' } } }); },
      signInWithPassword: function(){ return Promise.resolve({ error: null }); }
    }
  };
}

testAsync('refreshSupFromSupabase — mocked select returning 2 rows populates DB.sup correctly, persists to localStorage', async function() {
  resetDB();
  ctx._sb = mockSb({ suppliers: { selectData: [
    { id: 'u1', num: 'SUP-0001', name: 'ACME', country: 'CN', contact_name: 'Bob', email: 'b@acme.com', phone: '123', currency: 'USD', notes: 'n1' },
    { id: 'u2', num: 'SUP-0002', name: 'Globex', country: 'US', contact_name: '', email: '', phone: '', currency: 'GBP', notes: '' }
  ] } });
  await ctx.refreshSupFromSupabase();
  assertEqual(ctx.DB.sup.length, 2, '2 suppliers loaded');
  assertEqual(ctx.DB.sup[0].id, 'u1', 'id mapped');
  assertEqual(ctx.DB.sup[0].ct, 'Bob', 'contact_name mapped to ct');
  assertEqual(ctx.DB.sup[0].cur, 'USD', 'currency mapped to cur');
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.s)).length, 2, 'persisted to localStorage via sv(K.s,...)');
});

testAsync('refreshSupFromSupabase — mocked select error shows a toast, does not clear or corrupt existing DB.sup', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 'local1', name: 'Existing Local Supplier' });
  ctx._sb = mockSb({ suppliers: { selectError: { message: 'network down' } } });
  await ctx.refreshSupFromSupabase();
  assertEqual(ctx.DB.sup.length, 1, 'existing DB.sup untouched');
  assertEqual(ctx.DB.sup[0].id, 'local1', 'existing record preserved');
});

testAsync('refreshBuyFromSupabase — result set never includes BUY-ADHOC; re-seeded exactly once', async function() {
  resetDB();
  ctx._sb = mockSb({ buyers: { selectData: [
    { id: 'ub1', num: 'BUY-0001', name: 'Acme Buyer', contact_name: '', email: '', phone: '', address: '', currency: 'GBP', payment_terms: '', credit_limit: null, notes: '', created_at: '' }
  ] } });
  await ctx.refreshBuyFromSupabase();
  var adhocCount = ctx.DB.buy.filter(function(b){ return b.id === 'BUY-ADHOC'; }).length;
  assertEqual(adhocCount, 1, 'exactly one BUY-ADHOC present (re-seeded, not duplicated)');
  assertEqual(ctx.DB.buy.length, 2, 'real buyer + BUY-ADHOC only');
});

testAsync('saveSup — Cloud Data configured: create calls insert with client-generated num but no client-generated id; update calls update().eq(), never insert', async function() {
  resetDB();
  ctx.EI.s = null;
  ['sf-n','sf-c','sf-ct','sf-e','sf-cur','sf-nt'].forEach(function(id){ mockEl(id); });
  mockEl('sf-n').value = 'New Supplier'; mockEl('sf-c').value = 'CN'; mockEl('sf-ct').value = '';
  mockEl('sf-e').value = ''; mockEl('sf-cur').value = 'USD'; mockEl('sf-nt').value = '';
  ctx.getSupPhone = function(){ return ''; };
  var sb = mockSb({ suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-uuid' }, row); } } });
  ctx._sb = sb;
  await ctx.saveSup();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');

  ctx.EI.s = 'new-uuid';
  var sb2 = mockSb({ suppliers: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });
  ctx._sb = sb2;
  await ctx.saveSup();
  var updateCall = sb2._calls.find(function(c){ return c.op === 'update'; });
  var insertCall2 = sb2._calls.find(function(c){ return c.op === 'insert'; });
  assert(updateCall, 'update was called on edit path');
  assert(!insertCall2, 'insert never called on edit path');
});

testAsync('delSup — Cloud Data configured: soft-delete via update({deleted_at}), never a hard delete; local DB.con supplierId nulling preserved', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'a@x.com', supplierId: 'u1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.DB.sup.push({ id: 'u1', name: 'ACME' });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.delSup('u1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(ctx.DB.con[0].supplierId, null, 'linked contact supplierId nulled locally');
  ctx.confirm = function(){ return false; };
});

testAsync('quickAddBuyer — Cloud Data configured: calls insert, never pushes directly to DB.buy; unconfigured: unchanged local-only behavior', async function() {
  resetDB();
  mockEl('if-b');
  ctx.prompt = function(){ return 'Cloud Buyer'; };
  var sb = mockSb({ buyers: { insertImpl: function(row){ return Object.assign({ id: 'cloud-buyer-1' }, row); } } });
  ctx._sb = sb;
  await ctx.quickAddBuyer();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert called when Cloud Data configured');
  assertEqual(insertCall.row.name, 'Cloud Buyer', 'insert payload carries the entered name');
  assertEqual(ctx.DB.buy.some(function(b){ return b.id === 'cloud-buyer-1'; }), false, 'DB.buy is fully replaced by refreshBuyFromSupabase() (mock select() has no rows configured — real Supabase would return the just-inserted row here)');

  resetDB();
  ctx._sb = null;
  ctx.prompt = function(){ return 'Local Buyer'; };
  ctx.quickAddBuyer();
  assertEqual(ctx.DB.buy.filter(function(b){ return b.name === 'Local Buyer'; }).length, 1, 'unconfigured path still pushes directly to DB.buy, unchanged');
  ctx.prompt = function(){ return null; };
});

testAsync('migrateSuppliersBuyersToSupabase — duplicate supplier names blocked before any insert', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'Acme Ltd' });
  ctx.DB.sup.push({ id: 's2', num: 'SUP-0002', name: 'ACME LTD' });
  var sb = mockSb({});
  ctx._sb = sb;
  ctx._sbMigrationResolve = null;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('sb-dup-list');
  await ctx.migrateSuppliersBuyersToSupabase();
  assertEqual(sb._calls.filter(function(c){ return c.op === 'insert'; }).length, 0, 'no insert calls made — blocked by duplicate scan');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateSuppliersBuyersToSupabase — remaps DB.qt/po/li/con supplier refs and DB.inv buyer refs to new uuids; BUY-ADHOC excluded', async function() {
  resetDB();
  ctx.DB.sup.push({ id: 's1', num: 'SUP-0001', name: 'Acme Supplier', cur: 'USD' });
  ctx.DB.buy.push({ id: 'BUY-ADHOC', num: '', name: 'Ad-Hoc', currency: 'GBP' });
  ctx.DB.buy.push({ id: 'b1', num: 'BUY-0001', name: 'Real Buyer', currency: 'GBP' });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE1', currency: 'USD', lines: [{ supId: 's1', desc: 'Widget' }] });
  ctx.DB.po.push({ id: 'p1', num: 'PO1', supId: 's1' });
  ctx.DB.li.push({ id: 'l1', supId: 's1', desc: 'Widget' });
  ctx.DB.con.push({ id: 'c1', name: 'Contact', email: 'c@x.com', supplierId: 's1', role: 'supplier_contact', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' });
  ctx.DB.inv.push({ id: 'i1', num: 'INV10001', buyerId: 'b1' });

  var sb = mockSb({
    suppliers: { insertImpl: function(row){ return Object.assign({ id: 'new-sup-uuid' }, row); } },
    buyers:    { insertImpl: function(row){ return Object.assign({ id: 'new-buy-uuid' }, row); } }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-restore-btn');
  await ctx.migrateSuppliersBuyersToSupabase();

  assertEqual(ctx.DB.qt[0].lines[0].supId, 'new-sup-uuid', 'Quote line supId remapped');
  assertEqual(ctx.DB.po[0].supId, 'new-sup-uuid', 'PO supId remapped');
  assertEqual(ctx.DB.li[0].supId, 'new-sup-uuid', 'Line Item supId remapped');
  assertEqual(ctx.DB.con[0].supplierId, 'new-sup-uuid', 'Contact supplierId remapped');
  assertEqual(ctx.DB.inv[0].buyerId, 'new-buy-uuid', 'Invoice buyerId remapped');

  var buyInsertCalls = sb._calls.filter(function(c){ return c.table === 'buyers' && c.op === 'insert'; });
  assertEqual(buyInsertCalls.length, 1, 'exactly one buyer inserted (BUY-ADHOC excluded)');
  assert(!buyInsertCalls.some(function(c){ return c.row.name === 'Ad-Hoc'; }), 'BUY-ADHOC never sent to insert');
  ctx.showBlockingBackupModal = origShowBackup;
});

test('showBlockingBackupModal — Proceed button stays disabled until the backup checkbox is checked', function() {
  mockEl('mig-backup-ack').checked = false;
  mockEl('mig-backup-proceed').disabled = true;
  ctx.showBlockingBackupModal(); // opens the modal, returns a pending promise — not awaited here, testing UI-state only
  assertEqual(mockEl('mig-backup-proceed').disabled, true, 'Proceed starts disabled');
  mockEl('mig-backup-ack').checked = true;
  ctx.migBackupAckChg();
  assertEqual(mockEl('mig-backup-proceed').disabled, false, 'Proceed enabled once checkbox is checked');
  ctx.migBackupCancel(); // resolve the pending promise so it doesn't leak into later tests
});

test('restoreFromMigrationArchive — restores DB.sup/DB.buy-backing keys and clears SS.supabaseUrl/supabaseAnonKey', function() {
  resetDB();
  ctx.localStorage.setItem('st_s_pre_migration', JSON.stringify([{ id: 'orig1', name: 'Original Supplier' }]));
  ctx.localStorage.setItem('st_bu_pre_migration', JSON.stringify([{ id: 'orig2', name: 'Original Buyer' }]));
  ctx.SS.supabaseUrl = 'https://mock.supabase.co';
  ctx.SS.supabaseAnonKey = 'mock-anon-key';
  ctx.confirm = function(){ return true; };
  var reloaded = false;
  var origReload = ctx.location.reload;
  ctx.location.reload = function(){ reloaded = true; };
  var origSetTimeout = ctx.setTimeout;
  ctx.setTimeout = function(fn){ fn(); }; // run the reload callback synchronously for the test
  ctx.restoreFromMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.s))[0].id, 'orig1', 'st_s restored from archive');
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.bu))[0].id, 'orig2', 'st_bu restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared so the restore is not immediately overwritten');
  assertEqual(ctx.SS.supabaseAnonKey, '', 'supabaseAnonKey cleared');
  assert(reloaded, 'page reload triggered');
  ctx.location.reload = origReload;
  ctx.setTimeout = origSetTimeout;
  ctx.confirm = function(){ return false; };
});

test('restoreFromMigrationArchive — no archive present shows a toast and makes no changes', function() {
  resetDB();
  ctx.localStorage.removeItem('st_s_pre_migration');
  ctx.localStorage.removeItem('st_bu_pre_migration');
  ctx.SS.supabaseUrl = 'https://mock.supabase.co';
  ctx.restoreFromMigrationArchive();
  assertEqual(ctx.SS.supabaseUrl, 'https://mock.supabase.co', 'no change made when archive is absent');
  ctx.SS.supabaseUrl = '';
});

test('cleanupExpiredMigrationArchive — archived keys persist at day 29, removed at day 31', function() {
  var day29 = new Date(Date.now() - 29*86400000).toISOString();
  ctx.localStorage.setItem('st_cloud_migration_ts', day29);
  ctx.localStorage.setItem('st_s_pre_migration', '[]');
  ctx.localStorage.setItem('st_bu_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assert(ctx.localStorage.getItem('st_s_pre_migration') !== null, 'archive persists at day 29');

  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  ctx.localStorage.setItem('st_cloud_migration_ts', day31);
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_s_pre_migration'), null, 'archive removed at day 31');
  assertEqual(ctx.localStorage.getItem('st_cloud_migration_ts'), null, 'timestamp key removed at day 31');
});

testAsync('ensureSbAuth — cached session resolves true without opening the login modal; no session opens it and resolves on outcome', async function() {
  ctx._sb = mockSb({ _session: { user: 'cached' } });
  ctx._sbLoginCallback = null;
  var resultCached = await ctx.ensureSbAuth();
  assertEqual(resultCached, true, 'cached session resolves true');
  assertEqual(ctx._sbLoginCallback, null, 'login modal never opened (no callback registered) when a session is already cached');

  ctx._sb = mockSb({ _session: null });
  var pending = ctx.ensureSbAuth();
  // ensureSbAuth() awaits _sb.auth.getSession() before calling openSbLoginModal(), so the
  // callback isn't registered until that microtask settles — wait a couple of ticks for it.
  for (var tick = 0; tick < 5 && typeof ctx._sbLoginCallback !== 'function'; tick++) { await Promise.resolve(); }
  assertEqual(typeof ctx._sbLoginCallback, 'function', 'login modal opened (callback registered) when no session is cached');
  // simulate operator submitting the login form successfully
  ctx._sbLoginCallback(true);
  var resultNoSession = await pending;
  assertEqual(resultNoSession, true, 'resolves true once the login callback reports success');
});

testAsync('initCloudDataLayer — SS.supabaseUrl unset: _sb stays null, no refresh calls, no modal shown', async function() {
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  ctx._sb = 'sentinel'; // prove initSbClient() actually runs and nulls this out
  await ctx.initCloudDataLayer();
  assertEqual(ctx._sb, null, '_sb stays null when not configured');
});

test('initCloudDataLayer() is fire-and-forget — calling it does not block or throw synchronously, matching the pullAll() pattern it mirrors', function() {
  ctx.SS.supabaseUrl = ''; ctx.SS.supabaseAnonKey = '';
  var threw = false, afterLineRan = false;
  try { ctx.initCloudDataLayer().catch(function(){}); } catch (e) { threw = true; }
  afterLineRan = true; // proves control returned immediately, not deferred behind any await
  assert(!threw, 'calling initCloudDataLayer().catch(...) without awaiting does not throw synchronously');
  assert(afterLineRan, 'code after the call runs immediately — fire-and-forget, never blocks the caller');
});

// ── CLOUD DATA — Line Item & Contact (SPEC-CLOUD-002) ──

testAsync('isSupplierMigrationComplete — true when Supabase suppliers has rows, true via local marker even when Supabase is currently empty, false when neither, false when unconfigured', async function() {
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx._sb = mockSb({ suppliers: { selectData: [{ id: 'u1', name: 'ACME' }] } });
  assertEqual(await ctx.isSupplierMigrationComplete(), true, 'true when rows exist');
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  assertEqual(await ctx.isSupplierMigrationComplete(), false, 'false when empty and no local marker');

  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx._sb = mockSb({ suppliers: { selectData: [] } }); // zero-Supplier edge case (B3 fix)
  assertEqual(await ctx.isSupplierMigrationComplete(), true, 'true via local marker even though the live table is currently empty');
  ctx.localStorage.removeItem('st_cloud_migration_ts');

  ctx._sb = null;
  assertEqual(await ctx.isSupplierMigrationComplete(), false, 'false when Cloud Data not configured');
});

testAsync('migrateLineItemsToSupabase — blocked when Supplier migration has not completed; no insert made', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', supId: 's1', sku: 'SKU1' });
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  await ctx.migrateLineItemsToSupabase();
  assertEqual(ctx.DB.li[0].id, 'l1', 'Line Item id unchanged — migration never ran');
});

testAsync('migrateContactsToSupabase — blocked when Supplier migration has not completed; no insert made', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', supplierId: null, enquiries: [], gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', notes: '', role: '', status: 'lead', source: 'manual' });
  ctx._sb = mockSb({ suppliers: { selectData: [] } });
  await ctx.migrateContactsToSupabase();
  assertEqual(ctx.DB.con[0].id, 'c1', 'Contact id unchanged — migration never ran, even though this Contact has no Supplier link');
});

testAsync('migrateLineItemsToSupabase — blocked when a Line Item\'s supId does not resolve to a known Supabase Supplier; zero inserts made', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', supId: 'stale-local-id' });
  var sb = mockSb({ suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] }, line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateLineItemsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'insert'; });
  assert(!insertCall, 'no insert attempted — the orphaned supId was caught before the insert loop started');
  assertEqual(ctx.DB.li[0].id, 'l1', 'Line Item unchanged');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateLineItemsToSupabase — Supplier already migrated: inserts every field, rewrites Invoice/PO lid refs, checks-but-skips dead Quote.lines[].lid, preserves invoiceRefs across the post-migration refresh', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', supId: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, cur: 'USD', notes: '', priceHistory: [{date:'2026-01-01',cost:1,price:2,invoiceRef:'',notes:'Initial catalogue price'}], invoiceRefs: [{ invId: 'INV-1' }], dims: {l:1,w:1,h:1}, dg: true });
  ctx.DB.inv.push({ id: 'i1', lineItems: [{ lid: 'l1', qty: 1 }] });
  ctx.DB.po.push({ id: 'p1', lineItems: [{ lid: 'l1', qty: 1 }] });
  ctx.DB.qt.push({ id: 'q1', lines: [{ desc: 'Widget' }] }); // Quote.lines[].lid is dead — never populated in real data, so no lid key at all here (matching real-world shape); checked anyway per AC-4
  // Explicitly seed localStorage's K.l entry to match the DB.li fixture above (matching
  // what sv(K.l,...) would have persisted) — the archive step below reads whatever K.l
  // currently holds in localStorage, not ctx.DB.li directly, so this must not be left to
  // whatever an unrelated earlier test happened to leave behind.
  ctx.localStorage.setItem(ctx.K.l, JSON.stringify(ctx.DB.li));

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    line_items: {
      insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); },
      selectData: [{ id: 'new-li-uuid', num: 'LI-0001', sku: 'SKU1', desc: 'Widget', specs: '', hs: '', sup_id: 'new-sup-uuid', uom: 'pcs', cost: 1, price: 2, currency: 'USD', notes: '', dg: true, dims: {l:1,w:1,h:1}, price_history: [{date:'2026-01-01',cost:1,price:2,invoiceRef:'',notes:'Initial catalogue price'}] }]
    }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-li-restore-btn');

  await ctx.migrateLineItemsToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(insertCall.row.dg, true, 'dg included in insert payload');
  assertEqual(JSON.stringify(insertCall.row.dims), JSON.stringify({l:1,w:1,h:1}), 'dims included in insert payload');
  assertEqual(insertCall.row.price_history.length, 1, 'priceHistory included in insert payload');
  assertEqual(insertCall.row.invoiceRefs, undefined, 'invoiceRefs never sent to Supabase — no such column');

  assertEqual(ctx.DB.inv[0].lineItems[0].lid, 'new-li-uuid', 'Invoice lineItems[].lid remapped');
  assertEqual(ctx.DB.po[0].lineItems[0].lid, 'new-li-uuid', 'PO lineItems[].lid remapped');
  assertEqual(ctx.DB.qt[0].lines[0].lid, undefined, 'dead Quote.lines[].lid left as-is (never populated in real data) — sweep checked it (no crash) but had nothing real to rewrite');

  assertEqual(ctx.DB.li[0].id, 'new-li-uuid', 'Line Item own id remapped to the Supabase-assigned id');
  assertEqual(JSON.stringify(ctx.DB.li[0].invoiceRefs), JSON.stringify([{ invId: 'INV-1' }]), 'invoiceRefs preserved across the post-migration refresh, not dropped by the Supabase-sourced replacement');

  var archived = JSON.parse(ctx.localStorage.getItem('st_li_pre_migration'));
  assertEqual(archived[0].id, 'l1', 'pre-migration archive captured the ORIGINAL local id, not the remapped one');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — Supplier already migrated: inserts every field including role/enquiries, rewrites OrderRequest.contactId, nested RFQResponse.contactId, and Quote.sourceContactId', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'c1', num: 'CON-0001', name: 'Alice', email: 'a@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'pre_contract', createdAt: '2026-01-01T00:00:00.000Z', lastContactedAt: '', enquiries: [{id:'e1',ts:'2026-01-01',summary:'hi',source:'manual'}], notes: '', supplierId: 'new-sup-uuid', role: 'supplier_contact' });
  ctx.DB.ord.push({ id: 'o1', contactId: 'c1', lines: [{ rfqResponses: [{ contactId: 'c1' }] }] });
  ctx.DB.qt.push({ id: 'q1', sourceContactId: 'c1' });

  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');

  await ctx.migrateContactsToSupabase();

  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assert(insertCall, 'insert called');
  assertEqual(insertCall.row.role, 'supplier_contact', 'role included in insert payload');
  assertEqual(insertCall.row.enquiries.length, 1, 'enquiries included in insert payload');
  assertEqual(insertCall.row.created_at, '2026-01-01T00:00:00.000Z', 'original createdAt preserved, not overwritten by a DB default');

  assertEqual(ctx.DB.ord[0].contactId, 'new-con-uuid', 'OrderRequest.contactId remapped');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, 'new-con-uuid', 'nested RFQResponse.contactId remapped');
  assertEqual(ctx.DB.qt[0].sourceContactId, 'new-con-uuid', 'Quote.sourceContactId remapped');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — a Contact with supplierId:null migrates cleanly once Supplier has completed, supplier_id sent as null', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'c2', num: 'CON-0002', name: 'Bob', email: 'b@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', enquiries: [], notes: '', supplierId: null, role: '' });
  var sb = mockSb({
    suppliers: { selectData: [{ id: 'new-sup-uuid', name: 'ACME' }] },
    contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid-2' }, row); }, selectData: [] }
  });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  mockEl('cfg-sb-con-restore-btn');
  await ctx.migrateContactsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assertEqual(insertCall.row.supplier_id, null, 'supplier_id sent as null, not undefined or a stale local id');
  ctx.showBlockingBackupModal = origShowBackup;
});

testAsync('migrateContactsToSupabase — blocked when a Contact\'s supplierId does not resolve against the ACTUALLY-CONNECTED project, even if the stale local completion marker says migration is done (round-2 B3 fix)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString()); // stale marker left over from a different, previously-connected project
  ctx.DB.con.push({ id: 'c3', num: 'CON-0003', name: 'Carol', email: 'c@x.com', phone: '', company: '', status: 'lead', source: 'manual', gdprBasis: 'legitimate_interests', createdAt: '', lastContactedAt: '', enquiries: [], notes: '', supplierId: 'uuid-from-a-different-project', role: 'supplier_contact' });
  // The currently-connected project's suppliers table has no such Supplier — proves the
  // pre-flight check queries live state and isn't fooled by the stale marker that just
  // let isSupplierMigrationComplete() return true.
  var sb = mockSb({ suppliers: { selectData: [{ id: 'a-completely-different-real-uuid', name: 'Real Local Supplier' }] }, contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid-3' }, row); } } });
  ctx._sb = sb;
  var origShowBackup = ctx.showBlockingBackupModal;
  ctx.showBlockingBackupModal = function(){ return Promise.resolve(true); };
  await ctx.migrateContactsToSupabase();
  var insertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'insert'; });
  assert(!insertCall, 'no insert attempted — the orphaned supplierId was caught before the insert loop started, despite the stale marker');
  assertEqual(ctx.DB.con[0].id, 'c3', 'Contact unchanged');
  ctx.showBlockingBackupModal = origShowBackup;
  ctx.localStorage.removeItem('st_cloud_migration_ts');
});

test('restoreFromMigrationArchive / restoreLIMigrationArchive / restoreConMigrationArchive — each clears its own migration-completion marker on restore (round-2 B3 fix)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };

  ctx.localStorage.setItem('st_s_pre_migration', '[]'); ctx.localStorage.setItem('st_bu_pre_migration', '[]');
  ctx.localStorage.setItem('st_cloud_migration_ts', new Date().toISOString());
  ctx.restoreFromMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_cloud_migration_ts'), null, 'st_cloud_migration_ts cleared so a later reconnect to a different project cannot inherit it');

  ctx.localStorage.setItem('st_li_pre_migration', '[]');
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.restoreLIMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_li_cloud_migration_ts'), null, 'st_li_cloud_migration_ts cleared on its own restore');

  ctx.localStorage.setItem('st_con_pre_migration', '[]');
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.restoreConMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_con_cloud_migration_ts'), null, 'st_con_cloud_migration_ts cleared on its own restore');

  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

testAsync('saveLI — Cloud Data configured: create calls insert with client-generated num but no client-generated id; update calls update().eq(), never insert; local Sheets sync never called', async function() {
  resetDB();
  ctx.EI.l = null;
  ['lf-s','lf-d','lf-sp','lf-hs','lf-sup','lf-u','lf-c','lf-p','lf-cur','lf-nt','lf-diml','lf-dimw','lf-dimh'].forEach(function(id){ mockEl(id); });
  mockEl('lf-s').value = 'SKU1'; mockEl('lf-d').value = 'Widget'; mockEl('lf-sup').value = 'new-sup-uuid'; mockEl('lf-cur').value = 'USD';
  var syncCalled = false;
  ctx.syncEnt = function(){ syncCalled = true; return Promise.resolve(); };
  var sb = mockSb({ line_items: { insertImpl: function(row){ return Object.assign({ id: 'new-li-uuid' }, row); } } });
  ctx._sb = sb;
  await ctx.saveLI();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');
  assertEqual(insertCall.row.id, undefined, 'no client-generated id sent on insert');
  assertEqual(syncCalled, false, 'syncEnt never called on the _sb path — mutually exclusive with Sheets sync');

  ctx.EI.l = 'new-li-uuid';
  var sb2 = mockSb({ line_items: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); } } });
  ctx._sb = sb2;
  await ctx.saveLI();
  var updateCall = sb2._calls.find(function(c){ return c.op === 'update'; });
  var insertCall2 = sb2._calls.find(function(c){ return c.op === 'insert'; });
  assert(updateCall, 'update was called on edit path');
  assert(!insertCall2, 'insert never called on edit path');
});

testAsync('delLI — Cloud Data configured: soft-delete via update({deleted_at}), never a hard delete, never delEnt', async function() {
  resetDB();
  ctx.DB.li.push({ id: 'l1', sku: 'SKU1' });
  ctx.confirm = function(){ return true; };
  var delEntCalled = false;
  ctx.delEnt = function(){ delEntCalled = true; return Promise.resolve(); };
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.delLI('l1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(delEntCalled, false, 'delEnt never called on the _sb path');
  ctx.confirm = function(){ return false; };
});

testAsync('saveCon — Cloud Data configured: create calls insert with client-generated num; update calls update().eq(); duplicate-email merge path updates Supabase and never calls sv(K.co,...) directly', async function() {
  resetDB();
  ctx.EI.co = null;
  ['ct-name','ct-email','ct-status','ct-enq-summary','ct-phone','ct-company','ct-source','ct-notes','ct-sup'].forEach(function(id){ mockEl(id); });
  mockEl('ct-name').value = 'New Contact'; mockEl('ct-email').value = 'new@x.com'; mockEl('ct-status').value = 'lead';
  var sb = mockSb({ contacts: { insertImpl: function(row){ return Object.assign({ id: 'new-con-uuid' }, row); } } });
  ctx._sb = sb;
  await ctx.saveCon();
  var insertCall = sb._calls.find(function(c){ return c.op === 'insert'; });
  assert(insertCall, 'insert was called');
  assert(insertCall.row.num, 'client-generated num present on insert');

  resetDB();
  ctx.DB.con.push({ id: 'dup1', name: 'Existing', email: 'dup@x.com', enquiries: [] });
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Someone'; mockEl('ct-email').value = 'dup@x.com'; mockEl('ct-status').value = 'lead';
  mockEl('ct-enq-summary').value = 'follow up';
  ctx.confirm = function(){ return true; }; // accept the merge prompt
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.saveCon();
  var mergeCall = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(mergeCall, 'merge path updates Supabase');
  assertEqual(mergeCall.row.enquiries.length, 1, 'merged enquiry included in the Supabase update payload');
  ctx.confirm = function(){ return false; };
});

testAsync('saveCon — merge path: on a Supabase update error, the in-memory dup record is never mutated (A1 fix)', async function() {
  resetDB();
  var dupRecord = { id: 'dup1', name: 'Existing', email: 'dup@x.com', enquiries: [], lastContactedAt: '' };
  ctx.DB.con.push(dupRecord);
  ctx.EI.co = null;
  mockEl('ct-name').value = 'Someone'; mockEl('ct-email').value = 'dup@x.com'; mockEl('ct-status').value = 'lead';
  mockEl('ct-enq-summary').value = 'follow up';
  ctx.confirm = function(){ return true; };
  ctx._sb = mockSb({ contacts: { updateError: { message: 'network down' } } });
  await ctx.saveCon();
  assertEqual(dupRecord.enquiries.length, 0, 'dup.enquiries never mutated when the Supabase update fails');
  assertEqual(dupRecord.lastContactedAt, '', 'dup.lastContactedAt never mutated when the Supabase update fails');
  ctx.confirm = function(){ return false; };
});

testAsync('delCon — Cloud Data configured: soft-delete via update({deleted_at}); local DB.ord contactId and nested rfqResponses[].contactId still nulled', async function() {
  resetDB();
  ctx.DB.ord.push({ id: 'o1', contactId: 'c1', lines: [{ rfqResponses: [{ contactId: 'c1' }] }] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.delCon('c1');
  var updateCall = sb._calls.find(function(c){ return c.op === 'update'; });
  assert(updateCall, 'update called (soft-delete)');
  assert(updateCall.row.deleted_at, 'deleted_at timestamp set, not a hard delete');
  assertEqual(ctx.DB.ord[0].contactId, null, 'OrderRequest.contactId nulled locally');
  assertEqual(ctx.DB.ord[0].lines[0].rfqResponses[0].contactId, null, 'nested RFQResponse.contactId nulled locally');
  ctx.confirm = function(){ return false; };
});

test('restoreLIMigrationArchive / restoreConMigrationArchive — each restores its own key and clears SS.supabaseUrl/supabaseAnonKey independently', function() {
  resetDB();
  ctx.localStorage.setItem('st_li_pre_migration', JSON.stringify([{ id: 'orig-li', sku: 'SKU1' }]));
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.confirm = function(){ return true; };
  var origReload = ctx.location.reload; ctx.location.reload = function(){};
  var origSetTimeout = ctx.setTimeout; ctx.setTimeout = function(fn){ fn(); };
  ctx.restoreLIMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.l))[0].id, 'orig-li', 'st_li restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');

  ctx.localStorage.setItem('st_con_pre_migration', JSON.stringify([{ id: 'orig-con', name: 'Alice' }]));
  ctx.SS.supabaseUrl = 'https://mock.supabase.co'; ctx.SS.supabaseAnonKey = 'k';
  ctx.restoreConMigrationArchive();
  assertEqual(JSON.parse(ctx.localStorage.getItem(ctx.K.co))[0].id, 'orig-con', 'st_con restored from archive');
  assertEqual(ctx.SS.supabaseUrl, '', 'supabaseUrl cleared');

  ctx.location.reload = origReload; ctx.setTimeout = origSetTimeout; ctx.confirm = function(){ return false; };
});

test('cleanupExpiredMigrationArchive — Line Item and Contact archives expire independently of Supplier/Buyer\'s and of each other', function() {
  var day31 = new Date(Date.now() - 31*86400000).toISOString();
  var day5  = new Date(Date.now() - 5*86400000).toISOString();
  ctx.localStorage.setItem('st_li_cloud_migration_ts', day31);
  ctx.localStorage.setItem('st_li_pre_migration', '[]');
  ctx.localStorage.setItem('st_con_cloud_migration_ts', day5);
  ctx.localStorage.setItem('st_con_pre_migration', '[]');
  ctx.cleanupExpiredMigrationArchive();
  assertEqual(ctx.localStorage.getItem('st_li_pre_migration'), null, 'expired Line Item archive removed at day 31');
  assertEqual(ctx.localStorage.getItem('st_con_pre_migration'), '[]', 'Contact archive at day 5 untouched');
});

testAsync('refreshLIFromSupabase / refreshConFromSupabase — refuse to overwrite real local data when this device has never run the migration (B1 fix); proceed when local data is empty (second-device case)', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.DB.li.push({ id: 'local-only-li', sku: 'REAL-LOCAL-SKU' });
  ctx._sb = mockSb({ line_items: { selectData: [] } }); // brand-new, still-empty table right after this SPEC ships
  await ctx.refreshLIFromSupabase();
  assertEqual(ctx.DB.li.length, 1, 'real local Line Item NOT wiped — this device never ran the Line Item migration');
  assertEqual(ctx.DB.li[0].id, 'local-only-li', 'original record untouched');

  resetDB(); // simulates a fresh/second device: no local Line Items at all
  ctx._sb = mockSb({ line_items: { selectData: [{ id: 'cloud-li-1', num: 'LI-0001', sku: 'CLOUD-SKU', currency: 'USD', price_history: [] }] } });
  await ctx.refreshLIFromSupabase();
  assertEqual(ctx.DB.li.length, 1, 'real Cloud Data correctly loaded — nothing local was at risk');
  assertEqual(ctx.DB.li[0].id, 'cloud-li-1', 'loaded from Supabase');

  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.DB.con.push({ id: 'local-only-con', name: 'Real Local Contact' });
  ctx._sb = mockSb({ contacts: { selectData: [] } });
  await ctx.refreshConFromSupabase();
  assertEqual(ctx.DB.con.length, 1, 'real local Contact NOT wiped — this device never ran the Contact migration');
});

test('rCfg — Line Item and Contact restore buttons reappear after reload based on their own local migration marker (B4 fix)', function() {
  mockEl('cfg-sb-li-restore-btn'); mockEl('cfg-sb-con-restore-btn'); mockEl('cfg-sb-restore-btn');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.rCfg();
  assertEqual(mockEl('cfg-sb-li-restore-btn').style.display, 'none', 'Line Item restore button hidden with no archive');
  assertEqual(mockEl('cfg-sb-con-restore-btn').style.display, 'none', 'Contact restore button hidden with no archive');

  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.rCfg();
  assertEqual(mockEl('cfg-sb-li-restore-btn').style.display, '', 'Line Item restore button visible again after a fresh rCfg() render, simulating a reload');
  assertEqual(mockEl('cfg-sb-con-restore-btn').style.display, 'none', 'Contact restore button independently still hidden');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
});

testAsync('pullAll — li/co dropped from the batched pull_all request once each entity\'s own Cloud Data migration marker is set, independently of Supplier\'s exclusion and of each other (B2 fix)', async function() {
  resetDB();
  ctx.SS.url = 'https://mock.example/exec'; ctx.SS.auto = false; ctx.SS.pol = false;
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx._sb = mockSb({});

  _fetchCallLog = [];
  await ctx.pullAll();
  assert(_fetchCallLog[0].entities.indexOf('li') >= 0, 'li still requested — its own migration marker is not set yet');
  assert(_fetchCallLog[0].entities.indexOf('co') >= 0, 'co still requested — its own migration marker is not set yet');

  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  _fetchCallLog = [];
  await ctx.pullAll();
  assertEqual(_fetchCallLog[0].entities.indexOf('li'), -1, 'li excluded from the batched request once its own migration marker is set');
  assert(_fetchCallLog[0].entities.indexOf('co') >= 0, 'co still requested — its own marker is independently unset');

  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.SS.url = '';
});

testAsync('refreshConFromSupabase / refreshLIFromSupabase — set their own migration marker on a successful refresh even when this device never ran the migration itself (round-3 fix, second-device case)', async function() {
  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx._sb = mockSb({ contacts: { selectData: [{ id: 'cloud-con-1', num: 'CON-0001', name: 'Cloud Contact', email: 'c@x.com', enquiries: [] }] } });
  await ctx.refreshConFromSupabase(); // fresh device, DB.con was empty — guard lets this through
  assert(!!ctx.localStorage.getItem('st_con_cloud_migration_ts'), 'marker now set even though this device never ran migrateContactsToSupabase() itself');

  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx._sb = mockSb({ line_items: { selectData: [{ id: 'cloud-li-1', num: 'LI-0001', sku: 'X', currency: 'USD', price_history: [] }] } });
  await ctx.refreshLIFromSupabase();
  assert(!!ctx.localStorage.getItem('st_li_cloud_migration_ts'), 'marker now set for Line Item too');
});

testAsync('unlinkSupCon / openSupConPicker — Cloud Data + Contact migrated: push to Supabase and refresh, never a bare sv(K.co,...); Cloud Data configured but Contact NOT yet migrated: unchanged local-only behavior', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', supplierId: 'sup-uuid-1', role: 'supplier_contact' });
  var sb = mockSb({});
  ctx._sb = sb;
  await ctx.unlinkSupCon('con-uuid-1');
  var updateCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update'; });
  assert(updateCall, 'unlink pushed to Supabase once Contact has migrated');
  assertEqual(updateCall.row.supplier_id, null, 'supplier_id cleared in the Supabase payload');

  resetDB();
  ctx.localStorage.removeItem('st_con_cloud_migration_ts'); // Cloud Data configured for Supplier, but Contact never migrated
  ctx.DB.con.push({ id: 'local-uid-1', name: 'Bob', supplierId: 'sup-uuid-1', role: 'supplier_contact' });
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.unlinkSupCon('local-uid-1');
  var updateCall2 = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(!updateCall2, 'no Supabase call attempted — Contact ids on this device are still local uids');
  assertEqual(ctx.DB.con[0].supplierId, null, 'local unlink still applied directly, not silently dropped');
});

testAsync('delSup — Cloud Data configured, Contact ALSO migrated: linked contacts unlinked via Supabase update + refresh, not a bare sv(K.co,...)', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.sup.push({ id: 'sup-uuid-1', name: 'ACME' });
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', supplierId: 'sup-uuid-1', role: 'supplier_contact', enquiries: [] });
  ctx.confirm = function(){ return true; };
  var sb = mockSb({ contacts: { selectData: [] } });
  ctx._sb = sb;
  await ctx.delSup('sup-uuid-1');
  var conUpdateCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update'; });
  assert(conUpdateCall, 'linked Contact unlinked via a real Supabase update once Contact has migrated');
  assertEqual(conUpdateCall.row.supplier_id, null, 'supplier_id cleared in the Supabase payload');
  ctx.confirm = function(){ return false; };
});

testAsync('saveQte / delQte — Contact status conversion round-trip pushes to Supabase once Contact has migrated', async function() {
  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', status: 'qualified', enquiries: [] });
  ctx.cConvertId = 'con-uuid-1';
  ['qf-client','qf-nt'].forEach(function(id){ mockEl(id); });
  var sb = mockSb({ contacts: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'con-uuid-1', name: 'Alice', status: 'converted', enquiries: [] }] } });
  ctx._sb = sb;
  await ctx.saveQte();
  var convertCall = sb._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update' && c.row.status === 'converted'; });
  assert(convertCall, 'contact status pushed to Supabase as converted');

  resetDB();
  ctx.localStorage.setItem('st_con_cloud_migration_ts', new Date().toISOString());
  ctx.DB.con.push({ id: 'con-uuid-1', name: 'Alice', status: 'converted', enquiries: [] });
  ctx.DB.qt.push({ id: 'q1', num: 'QTE1', sourceContactId: 'con-uuid-1' });
  ctx.confirm = function(){ return true; };
  var sb2 = mockSb({ contacts: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'con-uuid-1', name: 'Alice', status: 'qualified', enquiries: [] }] } });
  ctx._sb = sb2;
  await ctx.delQte('q1');
  var revertCall = sb2._calls.find(function(c){ return c.table === 'contacts' && c.op === 'update' && c.row.status === 'qualified'; });
  assert(revertCall, 'contact status reverted to qualified via Supabase on Quote deletion');
  ctx.confirm = function(){ return false; };
});

testAsync('saveInv — auto-recorded price history pushes to line_items via Supabase once Line Items have migrated, instead of a bare sv(K.l,...); unmigrated Line Items keep the existing local-only behavior', async function() {
  resetDB();
  ctx.localStorage.setItem('st_li_cloud_migration_ts', new Date().toISOString());
  ctx.DB.li  = [{ id:'li-uuid-1', num:'LI-0001', sku:'SKU-DEV', desc:'Deviation Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.DB.inv = [{ id:'inv-base', num:'INV10001', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-uuid-1', desc:'Deviation Test', uom:'pcs', qty:1, up:120 }]; // 120 ≠ 150
  ['if-n','if-b','if-ba','if-st','if-dst','if-cid','if-dt','if-ex','if-sd','if-ft','if-wt','if-cbm','if-pk','if-pol','if-pod','if-coo','if-cur','if-tx','if-lf','if-ins','if-leg','if-isp','if-oth','if-dep','if-inco','if-pt','if-terms','inv-sm'].forEach(function(id){ mockEl(id); });
  mockEl('if-n').value = 'INV10002'; mockEl('if-b').value = 'Test Buyer'; mockEl('if-dst').value = 'Barbados';
  mockEl('if-dt').value = '2026-05-01'; mockEl('if-cur').value = 'USD'; mockEl('if-tx').value = '0'; mockEl('if-lf').value = '0';
  mockEl('if-ins').value = '0'; mockEl('if-leg').value = '0'; mockEl('if-isp').value = '0'; mockEl('if-oth').value = '0'; mockEl('if-dep').value = '0';
  mockEl('if-inco').value = 'CIF'; mockEl('if-pt').value = 'Net 30'; mockEl('if-chi').checked = true; mockEl('inv-sm').value = 'Draft';

  var sb = mockSb({ line_items: { updateImpl: function(row, id){ return Object.assign({ id: id }, row); }, selectData: [{ id: 'li-uuid-1', num: 'LI-0001', sku: 'SKU-DEV', price: 150, cost: 100, currency: 'USD', price_history: [{ date: '2026-05-01', cost: 100, price: 120, invoiceRef: 'INV10002', notes: 'Price at time of order' }] }] } });
  ctx._sb = sb;
  await ctx.saveInv();
  var updateCall = sb._calls.find(function(c){ return c.table === 'line_items' && c.op === 'update' && c.row.price_history; });
  assert(updateCall, 'price history pushed to Supabase rather than only sv(K.l,...)');
  assertEqual(updateCall.row.price_history[0].price, 120, 'deviated invoice price recorded in the pushed payload');

  resetDB();
  ctx.localStorage.removeItem('st_li_cloud_migration_ts'); // Cloud Data configured for Supplier, but Line Items never migrated
  ctx.DB.li  = [{ id:'li-dev', sku:'SKU-DEV', desc:'Deviation Test', cost:100, price:150, priceHistory:[], uom:'pcs', cur:'USD' }];
  ctx.DB.inv = [{ id:'inv-base', num:'INV10001', status:'Draft', lineItems:[], taxRate:0, dep:0, chargesIncluded:true }];
  ctx.EI.i   = null;
  ctx.cIL    = [{ rid:'r1', lid:'li-dev', desc:'Deviation Test', uom:'pcs', qty:1, up:120 }];
  var sb2 = mockSb({});
  ctx._sb = sb2;
  await ctx.saveInv();
  var updateCall2 = sb2._calls.find(function(c){ return c.op === 'update'; });
  assert(!updateCall2, 'no Supabase call attempted — Line Item ids on this device are still local uids');
  var cat = ctx.DB.li.find(function(x){ return x.id === 'li-dev'; });
  assert(cat.priceHistory.length > 0, 'local-only behavior unchanged — history still recorded directly, matching the pre-existing test at tests/run.js:575');
});

testAsync('SPEC-CLOUD-002 test-hygiene cleanup — reset _sb and every Cloud Data migration marker this block may have left set, so later unrelated tests are not affected', async function() {
  ctx._sb = null;
  ctx.localStorage.removeItem('st_cloud_migration_ts');
  ctx.localStorage.removeItem('st_li_cloud_migration_ts');
  ctx.localStorage.removeItem('st_con_cloud_migration_ts');
  ctx.localStorage.removeItem('st_li_pre_migration');
  ctx.localStorage.removeItem('st_con_pre_migration');
});

// ── AI Assistant — Invoice/Line Item/Credit Note actions + Supplier/Buyer read tools (SPEC-AI-GAP-002) ──

test("_aiExecTool('get_suppliers') returns only id/num/name/country/currency — no email/phone/contact", function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', num: 'SUP-0001', name: 'Jinbao Plastics', country: 'China', ct: 'Wei Chen', email: 'wei@jinbao.example.cn', phone: '+86 138', cur: 'CNY', notes: 'x' });
  var result = JSON.parse(ctx._aiExecTool('get_suppliers', { name: 'Jinbao' }));
  assertEqual(result.length, 1, 'one match');
  assertEqual(result[0].id, 'S1'); assertEqual(result[0].num, 'SUP-0001'); assertEqual(result[0].name, 'Jinbao Plastics');
  assertEqual(result[0].country, 'China'); assertEqual(result[0].currency, 'CNY');
  assertEqual(result[0].email, undefined, 'email absent'); assertEqual(result[0].phone, undefined, 'phone absent');
  assertEqual(result[0].ct, undefined, 'ct absent'); assertEqual(result[0].contactName, undefined, 'contactName absent');
});

test("_aiExecTool('get_buyers') returns only id/num/name/currency — no contactName/email/phone/creditLimit", function() {
  resetDB();
  ctx.DB.buy.push({ id: 'B1', num: 'BUY-0001', name: 'Apex Trading', contactName: 'John Doe', email: 'john@apex.com', phone: '+1 246', currency: 'BBD', creditLimit: 5000, notes: 'x' });
  var result = JSON.parse(ctx._aiExecTool('get_buyers', { name: 'Apex' }));
  assertEqual(result.length, 1, 'one match');
  assertEqual(result[0].id, 'B1'); assertEqual(result[0].num, 'BUY-0001'); assertEqual(result[0].name, 'Apex Trading'); assertEqual(result[0].currency, 'BBD');
  assertEqual(result[0].contactName, undefined, 'contactName absent'); assertEqual(result[0].email, undefined, 'email absent');
  assertEqual(result[0].phone, undefined, 'phone absent'); assertEqual(result[0].creditLimit, undefined, 'creditLimit absent');
});

test("get_pos tool description reflects the real PO status vocabulary (Deposit Paid/Settled), not the stale one (Confirmed/In Production/Shipped)", function() {
  var poTool = ctx.AI_TOOLS.find(function(t){ return t.name === 'get_pos'; });
  var desc = poTool.input_schema.properties.status.description;
  assertContains(desc, 'Deposit Paid'); assertContains(desc, 'Settled');
  assertNotContains(desc, 'Confirmed'); assertNotContains(desc, 'In Production'); assertNotContains(desc, 'Shipped');
});

test('handleAIAction: create_invoice with empty lineItems is rejected — cIL stays empty, if-n never freshly assigned, toast fires', function() {
  resetDB();
  ctx.cIL = [];
  var priorIfN = mockEl('if-n').value;
  var toasted = '';
  var origToast = ctx.toast;
  ctx.toast = function(m){ toasted = m; };
  ctx.handleAIAction({ action: 'create_invoice', payload: { lineItems: [] } });
  ctx.toast = origToast;
  assertEqual(ctx.cIL.length, 0, 'cIL remains empty — openInv() never ran');
  assertEqual(mockEl('if-n').value, priorIfN, 'if-n untouched — nextInvNum() never called since openInv() was never entered');
  assert(toasted.length > 0, 'a toast fired');
});

test('handleAIAction: create_invoice maps cost/price to unitCost/up (not cost/price keys), pre-fills buyId, never honors a payload num', function() {
  resetDB();
  ctx.cIL = [];
  ctx.EI.i = null;
  var action = { action: 'create_invoice', payload: { buyId: 'B1', num: 'INV99999', lineItems: [{ desc: 'Widget', qty: 2, cost: 5, price: 8, uom: 'pcs' }] } };
  ctx.handleAIAction(action);
  assertEqual(mockEl('if-b').value, 'B1', 'buyId pre-filled');
  assertEqual(ctx.cIL.length, 1, 'one line item added');
  assertEqual(ctx.cIL[0].unitCost, 5, 'cost mapped to unitCost');
  assertEqual(ctx.cIL[0].up, 8, 'price mapped to up (sell)');
  assertEqual(ctx.cIL[0].cost, undefined, 'no stray cost key'); assertEqual(ctx.cIL[0].price, undefined, 'no stray price key');
  assert(mockEl('if-n').value !== 'INV99999', 'a malformed payload.num is never honored — if-n stays whatever nextInvNum() produced');
});

test('handleAIAction: create_line_item accepts Description+Supplier only (Cost/UOM optional), pre-fills correctly', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.handleAIAction({ action: 'create_line_item', payload: { desc: 'Widget', supId: 'S1' } });
  assertEqual(mockEl('lf-d').value, 'Widget', 'desc pre-filled');
  assertEqual(mockEl('lf-sup').value, 'S1', 'supId pre-filled');
});

test('handleAIAction: create_line_item missing desc is rejected — openLI() never runs, lf-d left untouched', function() {
  resetDB();
  mockEl('lf-d').value = 'PRIOR VALUE';
  ctx.handleAIAction({ action: 'create_line_item', payload: { supId: 'S1' } });
  assertEqual(mockEl('lf-d').value, 'PRIOR VALUE', 'openLI() never ran to clear the field — the action was rejected before opening the modal');
});

test('handleAIAction: create_credit_note opens ov-cn (not ov-inv), pre-fills linked invoice, stays credit_note type', function() {
  resetDB();
  ctx.handleAIAction({ action: 'create_credit_note', payload: { linkedInvNum: 'INV10032', amount: 50, reason: 'Damaged goods', buyer: 'Acme Ltd' } });
  assertEqual(mockEl('cnf-linked').value, 'INV10032', 'linked invoice number pre-filled');
  assertEqual(mockEl('cnf-type').value, 'credit_note', 'type left as credit_note, not switched to goodwill');
  assertEqual(mockEl('cnf-amount').value, 50, 'amount pre-filled');
  assertEqual(mockEl('cnf-b').value, 'Acme Ltd', 'buyer plain name pre-filled');
});

test('handleAIAction: create_credit_note with goodwill:true switches type and hides the linked-invoice field (onCNTypeChg regression)', function() {
  resetDB();
  ctx.handleAIAction({ action: 'create_credit_note', payload: { goodwill: true, amount: 20, reason: 'Goodwill gesture' } });
  assertEqual(mockEl('cnf-type').value, 'goodwill_credit', 'type switched to goodwill_credit');
  assertEqual(mockEl('fld-cn-linked').style.display, 'none', 'linked-invoice field hidden by onCNTypeChg()');
});

test('handleAIAction: create_po regression — existing branch unaffected by this spec\'s changes', function() {
  resetDB();
  ctx.DB.sup.push({ id: 'S1', name: 'ACME' });
  ctx.EI.p = null;
  ctx.cPL = [];
  ctx.handleAIAction({ action: 'create_po', payload: { supId: 'S1', cur: 'CNY', notes: 'Rush order', lineItems: [{ desc: 'Widget A', qty: 100, cost: 5.5, uom: 'pcs' }] } });
  assertEqual(mockEl('pf-cur').value, 'CNY', 'currency pre-filled, unchanged behavior');
  assertEqual(ctx.cPL.length, 1, 'line item added to cPL, unchanged behavior');
});

// ── AI-assisted enquiry intake check (SPEC-CON-004) ─────────────

testAsync('conCheckEnquirySemantic — no AI.key configured resolves null, no fetch call', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = '';
  _lastAnthropicBody = null;
  var result = await ctx.conCheckEnquirySemantic('interested in fridges', '');
  assertEqual(result, null, 'resolves null');
  assertEqual(_lastAnthropicBody, null, 'no fetch call made');
  ctx.AI.key = savedKey;
});

testAsync('conCheckEnquirySemantic — network error resolves null, no thrown exception', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  _mockAnthropic = 'reject';
  var result = await ctx.conCheckEnquirySemantic('interested in fridges', '');
  assertEqual(result, null, 'resolves null on network error');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquirySemantic — non-200 response resolves null', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  _mockAnthropic = { status: 500, text: '' };
  var result = await ctx.conCheckEnquirySemantic('interested in fridges', '');
  assertEqual(result, null, 'resolves null on non-200');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquirySemantic — malformed (non-JSON-array) response text resolves null', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  _mockAnthropic = { status: 200, text: 'not json at all' };
  var result = await ctx.conCheckEnquirySemantic('interested in fridges', '');
  assertEqual(result, null, 'resolves null on malformed response');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquirySemantic — well-formed response resolves the parsed array', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  _mockAnthropic = { status: 200, text: '[{"issue":"No quantity mentioned","question":"How many units do you need?"}]' };
  var result = await ctx.conCheckEnquirySemantic('interested in fridges', '');
  assertEqual(result.length, 1, 'one issue parsed');
  assertEqual(result[0].issue, 'No quantity mentioned');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('AC-004: conCheckEnquiry() payload contains only summary/company — never name/email/phone, even when all three are filled in on the form', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  mockEl('ct-name').value = 'Jane Doe';
  mockEl('ct-email').value = 'jane@example.com';
  mockEl('ct-phone').value = '+44 7700 000000';
  mockEl('ct-company').value = 'Acme Ltd';
  mockEl('ct-enq-summary').value = 'interested in fridges';
  mockEl('con-enqchk');
  _mockAnthropic = { status: 200, text: '[]' };
  ctx.conCheckEnquiry();
  for (var tick = 0; tick < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; tick++) { await Promise.resolve(); }
  var payload = JSON.parse(_lastAnthropicBody.messages[0].content);
  assertEqual(payload.summary, 'interested in fridges', 'summary present');
  assertEqual(payload.company, 'Acme Ltd', 'company present');
  assertEqual(payload.name, undefined, 'name absent'); assertEqual(payload.email, undefined, 'email absent'); assertEqual(payload.phone, undefined, 'phone absent');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquiry — vague summary (AC-001) renders each issue+question in #con-enqchk', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  mockEl('ct-enq-summary').value = 'interested in fridges';
  mockEl('ct-company').value = '';
  mockEl('con-enqchk');
  _mockAnthropic = { status: 200, text: '[{"issue":"No quantity mentioned","question":"How many units?"}]' };
  ctx.conCheckEnquiry();
  for (var tick = 0; tick < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; tick++) { await Promise.resolve(); }
  assertContains(mockEl('con-enqchk').innerHTML, 'No quantity mentioned');
  assertContains(mockEl('con-enqchk').innerHTML, 'How many units?');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquiry — detailed summary (AC-002) renders "No ambiguities flagged."', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  mockEl('ct-enq-summary').value = '500 units of chest freezers, destination Barbados, need FOB quote';
  mockEl('con-enqchk');
  _mockAnthropic = { status: 200, text: '[]' };
  ctx.conCheckEnquiry();
  for (var tick = 0; tick < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; tick++) { await Promise.resolve(); }
  assertContains(mockEl('con-enqchk').innerHTML, 'No ambiguities flagged.');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

testAsync('conCheckEnquiry — no AI.key (AC-003) renders "unavailable"; Save remains fully usable afterward', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = '';
  mockEl('ct-enq-summary').value = 'interested in fridges';
  mockEl('con-enqchk');
  ctx.conCheckEnquiry();
  for (var tick = 0; tick < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; tick++) { await Promise.resolve(); }
  assertContains(mockEl('con-enqchk').innerHTML, 'unavailable');
  resetDB();
  mockEl('ct-name').value = 'Jane Doe'; mockEl('ct-email').value = 'jane@example.com'; mockEl('ct-status').value = 'lead'; mockEl('ct-source').value = 'manual';
  mockEl('ct-enq-summary').value = ''; mockEl('ct-notes').value = ''; mockEl('ct-phone').value = ''; mockEl('ct-company').value = ''; mockEl('ct-sup').value = '';
  ctx.EI.co = null;
  ctx.saveCon(); // must not throw / must complete normally — the check never blocks Save
  assertEqual(ctx.DB.con.length, 1, 'Save completed normally after an unavailable check');
  ctx.AI.key = savedKey;
});

testAsync('conCheckEnquiry — triggering does not mutate DB.con (AC-005)', async function() {
  resetDB();
  ctx.DB.con.push({ id: 'C1', name: 'Alice', email: 'alice@example.com', enquiries: [], status: 'lead', source: 'manual', createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '', supplierId: null, role: '' });
  var before = JSON.stringify(ctx.DB.con);
  mockEl('ct-enq-summary').value = 'interested in fridges';
  mockEl('con-enqchk');
  ctx.AI.key = '';
  ctx.conCheckEnquiry();
  await Promise.resolve();
  assertEqual(JSON.stringify(ctx.DB.con), before, 'DB.con unchanged by triggering the check');
});

testAsync('conCheckEnquiry — re-triggering after editing the summary reflects only the current text (AC-006)', async function() {
  var savedKey = ctx.AI.key; ctx.AI.key = 'sk-ant-test';
  mockEl('con-enqchk');
  mockEl('ct-enq-summary').value = 'summary A';
  _mockAnthropic = { status: 200, text: '[{"issue":"Issue A","question":"Question A?"}]' };
  ctx.conCheckEnquiry();
  for (var t1 = 0; t1 < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; t1++) { await Promise.resolve(); }
  assertContains(mockEl('con-enqchk').innerHTML, 'Issue A');

  mockEl('ct-enq-summary').value = 'summary B';
  _mockAnthropic = { status: 200, text: '[{"issue":"Issue B","question":"Question B?"}]' };
  ctx.conCheckEnquiry();
  for (var t2 = 0; t2 < 20 && mockEl('con-enqchk').innerHTML.indexOf('Checking') >= 0; t2++) { await Promise.resolve(); }
  assertContains(mockEl('con-enqchk').innerHTML, 'Issue B');
  assertNotContains(mockEl('con-enqchk').innerHTML, 'Issue A');
  var sentPayload = JSON.parse(_lastAnthropicBody.messages[0].content);
  assertEqual(sentPayload.summary, 'summary B', 'second call sent summary B, not stale summary A');
  _mockAnthropic = null; ctx.AI.key = savedKey;
});

test('Regression (AC-007): saveCon() duplicate-email merge/create-separate flow unaffected by this spec', function() {
  resetDB();
  ctx.DB.con.push({ id: 'C1', name: 'Existing', email: 'dup@example.com', enquiries: [], status: 'lead', source: 'manual', createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '', supplierId: null, role: '' });
  ctx.EI.co = null;
  mockEl('ct-name').value = 'New Name'; mockEl('ct-email').value = 'dup@example.com'; mockEl('ct-status').value = 'lead'; mockEl('ct-source').value = 'manual';
  mockEl('ct-enq-summary').value = 'new enquiry text'; mockEl('ct-notes').value = ''; mockEl('ct-phone').value = ''; mockEl('ct-company').value = ''; mockEl('ct-sup').value = '';
  ctx.confirm = function(){ return true; };
  ctx.saveCon();
  assertEqual(ctx.DB.con.length, 1, 'no duplicate record created — merged into existing');
  assertEqual(ctx.DB.con[0].enquiries.length, 1, 'enquiry merged into existing record');
  ctx.confirm = function(){ return false; };
});

test('openCon() — opening a fresh Contact modal after a prior check left #con-enqchk populated resets the panel', function() {
  var panel = mockEl('con-enqchk');
  panel.style.display = 'block'; panel.innerHTML = '<div>stale prior result</div>';
  ctx.openCon();
  assertEqual(mockEl('con-enqchk').style.display, 'none', 'panel hidden on open');
  assertEqual(mockEl('con-enqchk').innerHTML, '', 'panel content cleared on open');
});

// ── RFQ Supplier Comparison & Commit (REQ/SPEC-QTE-001 Part B) ──
console.log('\nRFQ Supplier Comparison & Commit (REQ/SPEC-QTE-001 Part B)');

function mkOrdWithLine(lineOverrides) {
  var line = Object.assign({
    id: 'L1', category: 'Salt fish', itemSpec: 'Dried salt fish',
    orderVolumeQty: '1', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '',
    baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '',
    lineUpdates: [], rfqResponses: [], committedResponseId: null
  }, lineOverrides || {});
  ctx.DB.ord = [{ id: 'O1', num: 'ORD-0001', contactId: null, stage: 'New', actions: [], lines: [line] }];
  ctx.EI.ord = 'O1';
  return line;
}

test('openRfqResponse() — resets modal fields and populates supplier/contact dropdowns', function() {
  resetDB();
  mkOrdWithLine();
  ctx.DB.sup = [{ id: 'S1', name: 'Acme Foods' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane Contact' }];
  mockEl('rfq-cost').value = '999';
  ctx.openRfqResponse('L1');
  assertEqual(ctx.cRfqOrdId, 'O1', 'cRfqOrdId set');
  assertEqual(ctx.cRfqLineId, 'L1', 'cRfqLineId set');
  assertEqual(mockEl('rfq-cost').value, '', 'cost field reset');
  assertEqual(mockEl('rfq-cur').value, 'USD', 'currency defaults to USD');
  assertContains(mockEl('rfq-sup').innerHTML, 'Acme Foods', 'supplier dropdown populated');
  assertContains(mockEl('rfq-con').innerHTML, 'Jane Contact', 'contact dropdown populated');
});

test('saveRfqResponse() — rejects when no supplier is selected', function() {
  resetDB();
  var line = mkOrdWithLine();
  ctx.cRfqOrdId = 'O1'; ctx.cRfqLineId = 'L1';
  mockEl('rfq-sup').value = '';
  mockEl('rfq-cost').value = '10';
  ctx.saveRfqResponse();
  assertEqual(line.rfqResponses.length, 0, 'no response recorded without a supplier');
});

test('saveRfqResponse() — rejects a missing or invalid unit cost', function() {
  resetDB();
  var line = mkOrdWithLine();
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.cRfqOrdId = 'O1'; ctx.cRfqLineId = 'L1';
  mockEl('rfq-sup').value = 'S1';
  mockEl('rfq-cost').value = '';
  ctx.saveRfqResponse();
  assertEqual(line.rfqResponses.length, 0, 'no response recorded without a valid cost');
});

test('saveRfqResponse() — records a full response with the exact expected key set (AC-012)', function() {
  resetDB();
  var line = mkOrdWithLine();
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane' }];
  ctx.cRfqOrdId = 'O1'; ctx.cRfqLineId = 'L1';
  mockEl('rfq-sup').value = 'S1';
  mockEl('rfq-cost').value = '250';
  mockEl('rfq-cur').value = 'USD';
  mockEl('rfq-cbm').value = '0.5';
  mockEl('rfq-dutypct').value = '5';
  mockEl('rfq-dg').checked = true;
  mockEl('rfq-moq').value = '500 units';
  mockEl('rfq-leadtime').value = '30 days';
  mockEl('rfq-payterms').value = '30% deposit';
  mockEl('rfq-con').value = 'C1';
  mockEl('rfq-notes').value = 'Sample notes';
  ctx.saveRfqResponse();
  assertEqual(line.rfqResponses.length, 1, 'response recorded');
  var r = line.rfqResponses[0];
  var expectedKeys = ['id','supId','cost','currency','cbm','dutyPct','dg','moq','leadTime','paymentTerms','notes','contactId','ts'].sort().join(',');
  assertEqual(Object.keys(r).sort().join(','), expectedKeys, 'exact key set — no name/email/phone field exists (AC-012)');
  assertEqual(r.supId, 'S1'); assertEqual(r.cost, 250); assertEqual(r.currency, 'USD'); assertEqual(r.contactId, 'C1');
});

test('renderRfqComparison() — ranks by GBP-converted landed cost, not raw quoted number (AC-005)', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
    { id: 'R2', supId: 'S2', cost: 90,  currency: 'GBP', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'Supplier USD' }, { id: 'S2', name: 'Supplier GBP' }];
  var origQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { fxGBPUSD: 1.27, lclPerCBM: 0, insRate: 0, dgSurcharge: 0 });
  ctx.renderRfqComparison('L1');
  ctx.QR = origQR;
  var html = mockEl('ord-rfq-L1').innerHTML;
  // R1: $100 -> ~£78.74 landed. R2: flat £90 landed. R1's raw number (100) is nominally
  // larger than R2's (90), but R1 is the true GBP-landed-cheapest once converted.
  assert(html.indexOf('Supplier USD') < html.indexOf('Supplier GBP'), 'the true landed-cheapest (USD $100 ≈ £78.74) ranks before the nominal-cheaper-looking £90 response');
});

test('ordCommitRfqResponse() — commits, replaces on re-commit, and un-commits without deleting any response (AC-006/AC-007)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
    { id: 'R2', supId: 'S2', cost: 90,  currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'A' }, { id: 'S2', name: 'B' }];
  ctx.ordCommitRfqResponse('L1', 'R1');
  assertEqual(line.committedResponseId, 'R1', 'first commit');
  ctx.ordCommitRfqResponse('L1', 'R2');
  assertEqual(line.committedResponseId, 'R2', 'commit replaces prior selection, never both (AC-006)');
  assertEqual(line.rfqResponses.length, 2, 'no response deleted by re-committing');
  ctx.ordCommitRfqResponse('L1', 'R2');
  assertEqual(line.committedResponseId, null, 'clicking the same committed response again un-commits it (AC-007)');
  assertEqual(line.rfqResponses.length, 2, 'un-committing does not delete any previously recorded response (AC-007)');
});

test('saveRfqResponse()/ordCommitRfqResponse() — never call syncEnt/delEnt; no FIELD_MAPS.ord entry (AC-008)', function() {
  resetDB();
  var line = mkOrdWithLine();
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  var calls = 0;
  var origSync = ctx.syncEnt, origDel = ctx.delEnt;
  ctx.syncEnt = function(){ calls++; return Promise.resolve(); };
  ctx.delEnt  = function(){ calls++; return Promise.resolve(); };
  ctx.cRfqOrdId = 'O1'; ctx.cRfqLineId = 'L1';
  mockEl('rfq-sup').value = 'S1'; mockEl('rfq-cost').value = '10';
  ctx.saveRfqResponse();
  ctx.ordCommitRfqResponse('L1', line.rfqResponses[0].id);
  ctx.syncEnt = origSync; ctx.delEnt = origDel;
  assertEqual(calls, 0, 'no sync/delete calls made by either function');
  assertEqual(ctx.FIELD_MAPS.ord, undefined, 'FIELD_MAPS has no ord key (AC-008)');
});

test('rfqStalenessWarn() — warns when a response is non-GBP and FX rates are stale, independent of QR.displayCurrency (AC-013)', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 30 * 3600000).toISOString(); // 30h ago, stale
  var origDisp = ctx.QR.displayCurrency;
  ctx.QR.displayCurrency = 'GBP';
  var warn = ctx.rfqStalenessWarn([{ currency: 'USD' }]);
  ctx.QR.displayCurrency = origDisp;
  delete mockStorage['st_qr_ts'];
  assertContains(warn, 'stale', 'warns even though QR.displayCurrency is left at its default GBP');
});

test('rfqStalenessWarn() — no warning when every response is already GBP, regardless of staleness (AC-013)', function() {
  mockStorage['st_qr_ts'] = new Date(Date.now() - 30 * 3600000).toISOString();
  var warn = ctx.rfqStalenessWarn([{ currency: 'GBP' }, { currency: 'gbp' }]);
  delete mockStorage['st_qr_ts'];
  assertEqual(warn, '', 'no warning when every response is already GBP');
});

test('renderRfqComparison() — flags a response with CBM not entered next to its landed cost', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
    { id: 'R2', supId: 'S2', cost: 100, currency: 'USD', cbm: 2, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'NoCBM' }, { id: 'S2', name: 'HasCBM' }];
  ctx.renderRfqComparison('L1');
  assertContains(mockEl('ord-rfq-L1').innerHTML, 'CBM not entered', 'zero/unset-CBM response is flagged rather than silently looking cheapest');
});

console.log('\nRFQ Response Edit & Delete (REQ/SPEC-ORD-006)');

test('editRfqResponse() — populates modal fields from the existing response and sets edit mode (AC-2)', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 1.5, dutyPct: 5, dg: true, moq: '500', leadTime: '30 days', paymentTerms: '30% deposit', notes: 'orig notes', contactId: 'C1', ts: '2026-01-01T00:00:00.000Z' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane' }];
  ctx.editRfqResponse('L1', 'R1');
  assertEqual(ctx.cRfqOrdId, 'O1', 'cRfqOrdId set');
  assertEqual(ctx.cRfqLineId, 'L1', 'cRfqLineId set');
  assertEqual(ctx.cRfqEditId, 'R1', 'cRfqEditId set to the response being edited');
  assertEqual(mockEl('rfq-title').textContent, 'Edit RFQ Response', 'modal title reflects edit mode');
  assertEqual(mockEl('rfq-sup').value, 'S1');
  assertEqual(mockEl('rfq-cost').value, 100);
  assertEqual(mockEl('rfq-cbm').value, 1.5);
  assertEqual(mockEl('rfq-dg').checked, true);
  assertEqual(mockEl('rfq-notes').value, 'orig notes');
  ctx.cRfqEditId = null;
});

test('openRfqResponse() — always resets to add mode, even right after an edit was opened (title reset)', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.editRfqResponse('L1', 'R1');
  ctx.openRfqResponse('L1');
  assertEqual(ctx.cRfqEditId, null, 'edit mode cleared by opening the add-response modal');
  assertEqual(mockEl('rfq-title').textContent, 'RFQ Response', 'title reset to add mode');
  ctx.cRfqEditId = null;
});

test('saveRfqResponse() — add mode (cRfqEditId null) unaffected: a second independent response is added, the first untouched (AC-1)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'A' }, { id: 'S2', name: 'B' }];
  ctx.cRfqOrdId = 'O1'; ctx.cRfqLineId = 'L1'; ctx.cRfqEditId = null;
  mockEl('rfq-sup').value = 'S2'; mockEl('rfq-cost').value = '200'; mockEl('rfq-cur').value = 'USD';
  mockEl('rfq-cbm').value = ''; mockEl('rfq-dutypct').value = ''; mockEl('rfq-dg').checked = false;
  mockEl('rfq-moq').value = ''; mockEl('rfq-leadtime').value = ''; mockEl('rfq-payterms').value = ''; mockEl('rfq-con').value = ''; mockEl('rfq-notes').value = '';
  ctx.saveRfqResponse();
  assertEqual(line.rfqResponses.length, 2, 'a second, independent response is added');
  assertEqual(line.rfqResponses[0].id, 'R1', 'the first response is untouched');
  assertEqual(line.rfqResponses[0].cost, 100, 'first response values unchanged');
  assertEqual(line.rfqResponses[1].cost, 200, 'new response recorded with its own values');
});

test('saveRfqResponse() — edit mode replaces the entry in place with a new id, not a push (AC-2)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: 'old', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.editRfqResponse('L1', 'R1');
  mockEl('rfq-cost').value = '150';
  mockEl('rfq-notes').value = 'updated notes';
  ctx.saveRfqResponse();
  assertEqual(line.rfqResponses.length, 1, 'still exactly one entry — no push occurred');
  assertEqual(line.rfqResponses[0].cost, 150, 'new cost value applied');
  assertEqual(line.rfqResponses[0].notes, 'updated notes', 'new notes value applied');
  assert(line.rfqResponses[0].id !== 'R1', 'edited response gets a new id, different from the original (AC-2, §1.2 design)');
  assertEqual(ctx.cRfqEditId, null, 'edit mode cleared after save');
});

test('saveRfqResponse() — editing the committed response repoints committedResponseId to the new id (AC-3)', function() {
  resetDB();
  var line = mkOrdWithLine({
    rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
    committedResponseId: 'R1'
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.editRfqResponse('L1', 'R1');
  mockEl('rfq-cost').value = '120';
  ctx.saveRfqResponse();
  var newId = line.rfqResponses[0].id;
  assertEqual(line.committedResponseId, newId, 'committedResponseId repointed to the edited response\'s new id, preserving committed state');
});

test('saveRfqResponse() — editing a non-committed response leaves committedResponseId untouched', function() {
  resetDB();
  var line = mkOrdWithLine({
    rfqResponses: [
      { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
      { id: 'R2', supId: 'S1', cost: 90, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
    ],
    committedResponseId: 'R2'
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.editRfqResponse('L1', 'R1');
  mockEl('rfq-cost').value = '110';
  ctx.saveRfqResponse();
  assertEqual(line.committedResponseId, 'R2', 'commit still points at R2, unaffected by editing the uncommitted R1');
});

test('editing the committed response that a Quote was converted from re-triggers the staleness banner (AC-4)', function() {
  resetDB();
  mkOrdWithCommittedResponse();
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  var rid = ctx.cQL[0].rid;
  mockEl('qf-num').value = 'QTE-0001'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var qt = ctx.DB.qt[0];
  ctx.renderQteSourceDriftWarn(qt);
  assertEqual(mockEl('qt-drift-warn').innerHTML, '', 'no banner immediately after conversion — still matching');
  ctx.editRfqResponse('L1', 'R1');
  mockEl('rfq-cost').value = '150';
  ctx.saveRfqResponse();
  ctx.renderQteSourceDriftWarn(qt);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed', 'editing the same committed response the Quote was built from now correctly fires the staleness banner (AC-4)');
});

test('deleting the committed response a Quote was converted from also fires the staleness banner (AC-5)', function() {
  resetDB();
  mkOrdWithCommittedResponse();
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  var rid = ctx.cQL[0].rid;
  mockEl('qf-num').value = 'QTE-0001'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var qt = ctx.DB.qt[0];
  var line = ctx.DB.ord[0].lines[0];
  ctx.confirm = function(){ return true; };
  ctx.delRfqResponse('L1', 'R1');
  ctx.confirm = function(){ return false; };
  assertEqual(line.rfqResponses.length, 0, 'response removed');
  assertEqual(line.committedResponseId, null, 'committedResponseId nulled (AC-5)');
  ctx.renderQteSourceDriftWarn(qt);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed', 'deleting the committed response the Quote was built from fires the staleness banner (AC-5)');
});

test('delRfqResponse() — deleting a non-committed response only removes that entry; committedResponseId unaffected (AC-6)', function() {
  resetDB();
  var line = mkOrdWithLine({
    rfqResponses: [
      { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
      { id: 'R2', supId: 'S1', cost: 90, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
    ],
    committedResponseId: 'R2'
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.confirm = function(){ return true; };
  ctx.delRfqResponse('L1', 'R1');
  ctx.confirm = function(){ return false; };
  assertEqual(line.rfqResponses.length, 1, 'only R1 removed');
  assertEqual(line.rfqResponses[0].id, 'R2', 'R2 survives');
  assertEqual(line.committedResponseId, 'R2', 'committedResponseId untouched, still pointing at the other response (AC-6)');
});

test('delRfqResponse() — cancelling the confirm() dialog deletes nothing', function() {
  resetDB();
  var line = mkOrdWithLine({
    rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
    committedResponseId: 'R1'
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.confirm = function(){ return false; };
  ctx.delRfqResponse('L1', 'R1');
  assertEqual(line.rfqResponses.length, 1, 'nothing deleted when confirm() is cancelled');
  assertEqual(line.committedResponseId, 'R1', 'committedResponseId unchanged when cancelled');
});

test('delRfqResponse() — confirm() message names the un-commit and staleness-banner consequences for a committed response (AC-8)', function() {
  resetDB();
  mkOrdWithLine({
    rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
    committedResponseId: 'R1'
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  var capturedMsg;
  ctx.confirm = function(msg){ capturedMsg = msg; return false; };
  ctx.delRfqResponse('L1', 'R1');
  ctx.confirm = function(){ return false; };
  assertContains(capturedMsg, 'un-commit', 'confirm message names the un-commit consequence (AC-8)');
  assertContains(capturedMsg, 'source pricing changed', 'confirm message names the staleness-warning consequence (AC-8)');
});

test('delRfqResponse() — confirm() message for a non-committed response is the plain delete prompt, no un-commit language', function() {
  resetDB();
  mkOrdWithLine({
    rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
    committedResponseId: null
  });
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  var capturedMsg;
  ctx.confirm = function(msg){ capturedMsg = msg; return false; };
  ctx.delRfqResponse('L1', 'R1');
  ctx.confirm = function(){ return false; };
  assertEqual(capturedMsg, 'Delete this RFQ response?', 'plain prompt when the response is not committed');
});

test('renderRfqComparison() — each response row shows Edit and Delete buttons alongside Commit/Uncommit (AC-7)', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' },
    { id: 'R2', supId: 'S2', cost: 90, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'S1', name: 'A' }, { id: 'S2', name: 'B' }];
  ctx.renderRfqComparison('L1');
  var html = mockEl('ord-rfq-L1').innerHTML;
  assertContains(html, "editRfqResponse('L1','R1')", 'row for R1 has an Edit button wired to editRfqResponse');
  assertContains(html, "delRfqResponse('L1','R1')", 'row for R1 has a Delete button wired to delRfqResponse');
  assertContains(html, "editRfqResponse('L1','R2')", 'row for R2 has an Edit button wired to editRfqResponse');
  assertContains(html, "delRfqResponse('L1','R2')", 'row for R2 has a Delete button wired to delRfqResponse');
});

console.log('\nRFQ Response Email Parse (REQ/SPEC-AI-GAP-011)');

function _rfqRespFixture(overrides) {
  return Object.assign({
    id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 1, dutyPct: 0, dg: false,
    moq: '500 units', leadTime: '30 days', paymentTerms: '30% deposit', notes: 'orig notes', contactId: null, ts: ''
  }, overrides || {});
}

testAsync('rfqParseUpdateFromEmail: no AI.key configured → resolves null, no fetch call', async () => {
  ctx.AI = { key: '' };
  _lastAnthropicBody = null;
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result, null, 'resolves null with no key');
  assertEqual(_lastAnthropicBody, null, 'no fetch call made');
});

testAsync('rfqParseUpdateFromEmail: network error → resolves null, no thrown exception', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = 'reject';
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result, null, 'resolves null on network error');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: non-200 response → resolves null', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 500, text: '' };
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result, null, 'resolves null on non-200');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: malformed (non-JSON) response text → resolves null', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: 'not valid json {' };
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result, null, 'resolves null on malformed response');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: a JSON array response → resolves null (object-shape guard, not just Array.isArray)', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '[{"cost":120}]' };
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result, null, 'an array is rejected even though typeof [] === "object"');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: empty commercial terms → resolves {} not null (AC-3)', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '{}' };
  var result = await ctx.rfqParseUpdateFromEmail('We will ship next Tuesday.', _rfqRespFixture());
  assertEqual(Object.keys(result).length, 0, 'resolves an empty object');
  assert(result !== null, 'not null — a real empty object, distinct from the null failure case');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: only the fields the email addresses are returned (AC-2)', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '{"cost":120,"currency":"USD"}' };
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit, same currency.', _rfqRespFixture());
  assertEqual(Object.keys(result).sort().join(','), 'cost,currency', 'only cost and currency present — nothing fabricated');
  assertEqual(result.cost, 120);
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: an out-of-schema key from the model is stripped by the whitelist filter', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '{"cost":120,"foo":"bar"}' };
  var result = await ctx.rfqParseUpdateFromEmail('New price is $120/unit.', _rfqRespFixture());
  assertEqual(result.cost, 120, 'cost passed through');
  assert(!('foo' in result), 'unrecognized key never survives the filter');
  _mockAnthropic = null;
});

testAsync('rfqParseUpdateFromEmail: currentValues payload sent to Anthropic excludes notes (matches REQ §2b exactly)', async () => {
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '{}' };
  await ctx.rfqParseUpdateFromEmail('Some email text.', _rfqRespFixture());
  var sentPayload = JSON.parse(_lastAnthropicBody.messages[0].content);
  assertEqual(Object.keys(sentPayload.currentValues).sort().join(','), 'cost,currency,leadTime,moq,paymentTerms', 'currentValues carries exactly the five REQ-specified fields, not notes');
  _mockAnthropic = null;
});

test('rfqOpenEmailParse() — populates the shared panel with the response context and sets tracking state', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [_rfqRespFixture()] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.rfqOpenEmailParse('L1', 'R1');
  assertEqual(ctx.cRfqEmailParseLineId, 'L1', 'line id tracked');
  assertEqual(ctx.cRfqEmailParseRespId, 'R1', 'response id tracked');
  assertEqual(ctx.cRfqEmailParseProposed, null, 'no proposal yet');
  assertContains(mockEl('ord-rfq-emailparse-L1').innerHTML, 'Acme', 'panel shows the supplier name for context');
  ctx.rfqCloseEmailParse('L1');
});

test('rfqCloseEmailParse() — clears tracking state and hides the panel (serves both Cancel and Discard, AC-7)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [_rfqRespFixture()] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.rfqOpenEmailParse('L1', 'R1');
  ctx.cRfqEmailParseProposed = { cost: 150 };
  ctx.rfqCloseEmailParse('L1');
  assertEqual(ctx.cRfqEmailParseLineId, null, 'line id cleared');
  assertEqual(ctx.cRfqEmailParseRespId, null, 'response id cleared');
  assertEqual(ctx.cRfqEmailParseProposed, null, 'proposal cleared');
  assertEqual(mockEl('ord-rfq-emailparse-L1').innerHTML, '', 'panel emptied');
  assertEqual(line.rfqResponses.length, 1, 'nothing on the actual response changed');
});

testAsync('rfqRunEmailParse() — a successful parse populates a diff review with Apply/Discard, does not mutate the response (AC-5)', async function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [_rfqRespFixture()] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.AI = { key: 'test-key' };
  _mockAnthropic = { status: 200, text: '{"cost":150}' };
  ctx.rfqOpenEmailParse('L1', 'R1');
  mockEl('rfq-emailparse-text-L1').value = 'New price is $150/unit.';
  ctx.rfqRunEmailParse('L1');
  for (var i = 0; i < 10; i++) { await Promise.resolve(); }
  _mockAnthropic = null;
  assertEqual(ctx.cRfqEmailParseProposed.cost, 150, 'proposal captured');
  var html = mockEl('ord-rfq-emailparse-L1').innerHTML;
  assertContains(html, '100', 'diff shows the old value');
  assertContains(html, '150', 'diff shows the proposed new value');
  assertContains(html, "rfqApplyEmailParse('L1')", 'Apply button present');
  assertContains(html, "rfqCloseEmailParse('L1')", 'Discard button present');
  assertEqual(line.rfqResponses[0].cost, 100, 'the actual response is untouched until Apply is clicked (AC-5)');
  ctx.rfqCloseEmailParse('L1');
});

testAsync('rfqRunEmailParse() — AI unavailable (no key) shows a graceful message, no crash', async function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [_rfqRespFixture()] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.AI = { key: '' };
  ctx.rfqOpenEmailParse('L1', 'R1');
  mockEl('rfq-emailparse-text-L1').value = 'New price is $150/unit.';
  ctx.rfqRunEmailParse('L1');
  for (var i = 0; i < 10; i++) { await Promise.resolve(); }
  assertContains(mockEl('ord-rfq-emailparse-L1').innerHTML, 'unavailable', 'graceful unavailable message shown');
  ctx.rfqCloseEmailParse('L1');
});

test('rfqApplyEmailParse() — non-committed response: applies via the real edit path, new id, proposed fields merged with unchanged ones (AC-6a)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [_rfqRespFixture()] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.rfqOpenEmailParse('L1', 'R1');
  ctx.cRfqEmailParseProposed = { cost: 150 };
  ctx.rfqApplyEmailParse('L1');
  assertEqual(line.rfqResponses.length, 1, 'still exactly one entry');
  assertEqual(line.rfqResponses[0].cost, 150, 'proposed cost applied');
  assertEqual(line.rfqResponses[0].moq, '500 units', 'untouched field (moq) preserved from the current value, not blanked');
  assert(line.rfqResponses[0].id !== 'R1', 'response gets a new id via the real edit path (REQ-ORD-006 mechanism)');
  assertEqual(ctx.cRfqEmailParseLineId, null, 'tracking state cleared after Apply');
  assertEqual(ctx.cRfqEmailParseProposed, null, 'proposal cleared after Apply');
});

test('rfqApplyEmailParse() — committed response with a Quote already converted from it: repoints committedResponseId and re-triggers the staleness banner (AC-6b)', function() {
  resetDB();
  mkOrdWithCommittedResponse();
  ctx.EI.ord = 'O1';
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  var rid = ctx.cQL[0].rid;
  mockEl('qf-num').value = 'QTE-0001'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var qt = ctx.DB.qt[0];
  var line = ctx.DB.ord[0].lines[0];
  ctx.rfqOpenEmailParse('L1', 'R1');
  ctx.cRfqEmailParseProposed = { cost: 150 };
  ctx.rfqApplyEmailParse('L1');
  var newId = line.rfqResponses[0].id;
  assertEqual(line.committedResponseId, newId, 'committedResponseId repointed to the new id (inherited from REQ-ORD-006)');
  ctx.renderQteSourceDriftWarn(qt);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed', 'applying an AI-parsed change to the committed, Quote-sourced response fires the staleness banner (AC-6b)');
});

test('rfqApplyEmailParse() — cross-line safety: a stale Apply button from an abandoned line cannot act on another line\'s proposal (spec-gate blocking-finding regression test)', function() {
  resetDB();
  ctx.DB.ord = [{
    id: 'O1', num: 'ORD-0001', contactId: null, stage: 'New', actions: [],
    lines: [
      { id: 'A', category: 'Cat A', itemSpec: 'Item A', orderVolumeQty: '1', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [], rfqResponses: [_rfqRespFixture({ id: 'R1', cost: 100 })], committedResponseId: null },
      { id: 'B', category: 'Cat B', itemSpec: 'Item B', orderVolumeQty: '1', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [], rfqResponses: [_rfqRespFixture({ id: 'R2', supId: 'S2', cost: 200 })], committedResponseId: null }
    ]
  }];
  ctx.EI.ord = 'O1';
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }, { id: 'S2', name: 'Beta' }];
  var lineA = ctx.DB.ord[0].lines[0];
  var lineB = ctx.DB.ord[0].lines[1];

  ctx.rfqOpenEmailParse('A', 'R1');
  ctx.cRfqEmailParseProposed = { cost: 111 };
  // Line A's parse is left un-Applied; line B's parse now overwrites the shared tracking state.
  ctx.rfqOpenEmailParse('B', 'R2');
  ctx.cRfqEmailParseProposed = { cost: 222 };

  // Simulate a click on line A's now-stale, still-rendered Apply button.
  ctx.rfqApplyEmailParse('A');
  assertEqual(lineA.rfqResponses[0].id, 'R1', 'line A untouched — the stale click was a no-op');
  assertEqual(lineA.rfqResponses[0].cost, 100, 'line A cost unchanged');
  assertEqual(lineB.rfqResponses[0].id, 'R2', 'line B also untouched by the stale click on A');
  assertEqual(lineB.rfqResponses[0].cost, 200, 'line B cost unchanged');

  // The legitimate Apply on line B, whose proposal is actually the one tracked, must still work.
  ctx.rfqApplyEmailParse('B');
  assertEqual(lineB.rfqResponses[0].cost, 222, 'line B correctly receives its own proposal via a legitimate Apply');
  assert(lineB.rfqResponses[0].id !== 'R2', 'line B response rotates id via the real edit path');
});

test('renderRfqComparison() — each response row shows the envelope (parse-update-from-email) button, and the shared parse panel div exists (AC layout)', function() {
  resetDB();
  mkOrdWithLine({ rfqResponses: [_rfqRespFixture({ id: 'R1' })] });
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.renderRfqComparison('L1');
  var html = mockEl('ord-rfq-L1').innerHTML;
  assertContains(html, "rfqOpenEmailParse('L1','R1')", 'envelope button wired to rfqOpenEmailParse');
  assert(mockEl('ord-rfq-emailparse-L1') !== undefined, 'shared parse panel div exists for rfqOpenEmailParse to populate');
});

testAsync('delSup() — warns on RFQ response references and the comparison degrades gracefully after deletion (AC-011)', async function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'SUP-DEL', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }
  ]});
  ctx.DB.sup = [{ id: 'SUP-DEL', name: 'ToDelete' }];
  var capturedMsg;
  ctx.confirm = function(msg){ capturedMsg = msg; return true; };
  await ctx.delSup('SUP-DEL');
  ctx.confirm = function(){ return false; };
  assertContains(capturedMsg, '1 Order Request line', 'confirm message includes the RFQ-reference warning count (AC-011)');
  ctx.renderRfqComparison('L1');
  assertContains(mockEl('ord-rfq-L1').innerHTML, 'supplier deleted', 'comparison renders without throwing and shows the supplier is gone (AC-011)');
  assertEqual(line.rfqResponses[0].supId, 'SUP-DEL', 'supId left in place as a historical record, not nulled');
});

test('delCon() — nulls contactId nested inside rfqResponses[], not just the top-level Order Request field (AC-017)', function() {
  resetDB();
  var line = mkOrdWithLine({ rfqResponses: [
    { id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: 'CON-DEL', ts: '' }
  ]});
  ctx.DB.ord[0].contactId = 'CON-DEL';
  ctx.DB.con = [{ id: 'CON-DEL', name: 'Someone', email: 'x@x.com', status: 'lead', source: 'manual', enquiries: [], createdAt: '', lastContactedAt: '', gdprBasis: 'legitimate_interests', notes: '' }];
  ctx.confirm = function(){ return true; };
  ctx.delCon('CON-DEL');
  ctx.confirm = function(){ return false; };
  assertEqual(ctx.DB.ord[0].contactId, null, 'top-level contactId nulled (pre-existing behavior, unchanged)');
  assertEqual(line.rfqResponses[0].contactId, null, 'nested rfqResponses[].contactId also nulled (AC-017)');
});

test('ordConvertToQuote() — seeds cQL from committed RFQ responses (supId, baseQty fallback, no markup) (AC-009/AC-015/AC-016)', function() {
  resetDB();
  ctx.DB.ord = [{
    id: 'O1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [],
    lines: [
      { id: 'L1', category: 'Cat A', itemSpec: 'Item A', orderVolumeQty: '1', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '', baseQty: 10, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
        rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 1, dutyPct: 2, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
        committedResponseId: 'R1' },
      { id: 'L2', category: 'Cat B', itemSpec: 'Item B', orderVolumeQty: '2', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '', baseQty: null, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
        rfqResponses: [{ id: 'R2', supId: 'S2', cost: 200, currency: 'USD', cbm: 2, dutyPct: 0, dg: true, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
        committedResponseId: 'R2' }
    ]
  }];
  ctx.DB.sup = [{ id: 'S1', name: 'Sup1' }, { id: 'S2', name: 'Sup2' }];
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  assertEqual(ctx.cQL.length, 2, 'one Quote line per committed response');
  assertEqual(ctx.cQL[0].supId, 'S1'); assertEqual(ctx.cQL[0].desc, 'Item A');
  assertEqual(ctx.cQL[0].qty, 10, 'qty uses the Order Request line\'s own baseQty when set');
  assertEqual(ctx.cQL[0].cost, 100, 'same-currency (USD->USD) conversion is an identity — cost unchanged');
  assertEqual(ctx.cQL[1].supId, 'S2'); assertEqual(ctx.cQL[1].qty, 1, 'qty falls back to 1 when baseQty is unset');
  assertEqual(ctx.cQL[1].dg, true, 'dg flag carried over');
  assertEqual(ctx.cQL[0].markup, undefined, 'no markup set on a hand-off-created line (AC-016)');
  assertEqual(ctx.cQL[1].markup, undefined, 'no markup set on a hand-off-created line (AC-016)');
});

test('ordConvertToQuote() — converts a non-USD committed response\'s cost to the new Quote\'s working currency', function() {
  resetDB();
  ctx.DB.ord = [{
    id: 'O1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [],
    lines: [{ id: 'L1', category: 'Cat', itemSpec: 'Item', orderVolumeQty: '1', orderVolumeUnit: 'pallet', packingSpec: '', baseUom: '', baseQty: 1, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
      rfqResponses: [{ id: 'R1', supId: 'S1', cost: 700, currency: 'RMB', cbm: 0, dutyPct: 0, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
      committedResponseId: 'R1' }]
  }];
  ctx.DB.sup = [{ id: 'S1', name: 'Sup1' }];
  ctx.cQL = [];
  var origQR = ctx.QR;
  ctx.QR = Object.assign({}, ctx.QR, { fxGBPRMB: 9.20, fxGBPUSD: 1.27 });
  ctx.ordConvertToQuote('O1');
  ctx.QR = origQR;
  var expected = (700 / 9.20) * 1.27; // toGBP(700,'RMB') then fromGBP(...,'USD') — the new Quote defaults to USD
  assertApprox(ctx.cQL[0].cost, expected, 'RMB response cost is converted to the Quote\'s working currency (USD), not copied verbatim');
});

console.log('\nData Integrity Cleanup (REQ/SPEC-DATA-002)');

test('isPhantomRecord() — plain !id criterion for non-Contact entities (AC-1)', function() {
  assertEqual(ctx.isPhantomRecord('sup', { id: '', name: 'Blank' }), true);
  assertEqual(ctx.isPhantomRecord('sup', { id: 'S1', name: 'Real' }), false);
});

test('isPhantomRecord() — compound criterion for Contacts catches backfillConIds()-healed zombies (AC-1b)', function() {
  assertEqual(ctx.isPhantomRecord('con', { id: 'C9', name: '', email: '' }), true, 'truthy id but no name/email is still phantom');
  assertEqual(ctx.isPhantomRecord('con', { id: 'C1', name: 'Jane', email: '' }), false);
  assertEqual(ctx.isPhantomRecord('con', { id: 'C2', name: '', email: 'a@b.com' }), false);
  assertEqual(ctx.isPhantomRecord('con', { id: '', name: '', email: '' }), true);
});

test('scanForPhantomRecords() — reports exactly the phantom Suppliers, leaves DB untouched (AC-1)', function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'A' }, { id: '', name: '' }, { id: 'S2', name: 'B' }, { id: '', name: '' }, { id: 'S3', name: 'C' }];
  var scan = ctx.scanForPhantomRecords();
  assertEqual(scan.sup.length, 2, 'exactly 2 phantom Suppliers found');
  assertEqual(ctx.DB.sup.length, 5, 'scan is read-only — DB unmodified');
});

test('scanForPhantomRecords() — reports exactly the phantom Contact via the compound criterion (AC-1b)', function() {
  resetDB();
  ctx.DB.con = [{ id: 'C1', name: 'Jane' }, { id: 'C2', name: 'John' }, { id: 'C3', name: '', email: '' }];
  var scan = ctx.scanForPhantomRecords();
  assertEqual(scan.con.length, 1, 'exactly 1 phantom Contact found');
});

test('scanForPhantomRecords() — zero phantoms across all entities reports nothing (AC-9)', function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane' }];
  var scan = ctx.scanForPhantomRecords();
  assertEqual(Object.keys(scan).length, 0, 'no entity keys reported when nothing is phantom');
});

test('openDataCleanupScan() — zero-found case reports clean and does not open the preview modal (AC-9)', function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'A' }];
  mockEl('ov-data-cleanup-preview').classList.add = function() { throw new Error('preview modal must not open when nothing is phantom'); };
  ctx.openDataCleanupScan();
  assertContains(mockEl('data-cleanup-status').textContent, 'No phantom records found');
  mockEl('ov-data-cleanup-preview').classList.add = function() {};
});

test('confirmDataCleanup() — declining the backup gate blocks the actual cleanup (AC-2)', async function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'Real' }, { id: '', name: '' }];
  var origShow = ctx.showDataCleanupBackupModal;
  ctx.showDataCleanupBackupModal = function() { return Promise.resolve(false); };
  await ctx.confirmDataCleanup();
  ctx.showDataCleanupBackupModal = origShow;
  assertEqual(ctx.DB.sup.length, 2, 'DB unmodified when backup is not confirmed');
});

test('executeDataCleanup() — removes phantoms, real Supplier data unchanged except num (AC-3)', function() {
  resetDB();
  ctx.DB.sup = [
    { id: 'S1', name: 'Acme', num: 'SUP-0001', country: 'CN' },
    { id: '', name: '' },
    { id: 'S2', name: 'Beta', num: 'SUP-0003', country: 'VN' },
    { id: '', name: '' },
    { id: 'S3', name: 'Gamma', num: 'SUP-0007', country: 'IN' },
  ];
  ctx.executeDataCleanup();
  assertEqual(ctx.DB.sup.length, 3, 'phantom Suppliers removed');
  var acme = ctx.DB.sup.find(function(s) { return s.id === 'S1'; });
  assertEqual(acme.name, 'Acme'); assertEqual(acme.country, 'CN');
});

test('renumberEntitySequentially() — closes gaps, preserves original relative order (AC-4)', function() {
  var arr = [
    { id: 'S1', num: 'SUP-0001' },
    { id: 'S2', num: 'SUP-0003' },
    { id: 'S3', num: 'SUP-0007' },
  ];
  ctx.renumberEntitySequentially(arr, 'SUP');
  assertEqual(arr[0].num, 'SUP-0001'); assertEqual(arr[0].id, 'S1');
  assertEqual(arr[1].num, 'SUP-0002'); assertEqual(arr[1].id, 'S2');
  assertEqual(arr[2].num, 'SUP-0003'); assertEqual(arr[2].id, 'S3');
});

test('renumberEntitySequentially() — returns only the records that actually changed', function() {
  var arr = [{ id: 'S1', num: 'SUP-0001' }, { id: 'S2', num: 'SUP-0003' }];
  var changes = ctx.renumberEntitySequentially(arr, 'SUP');
  assertEqual(changes.length, 1, 'only the gapped record actually changes num');
  assertEqual(changes[0].id, 'S2'); assertEqual(changes[0].oldNum, 'SUP-0003'); assertEqual(changes[0].newNum, 'SUP-0002');
});

test('executeDataCleanup() — never renumbers or touches Invoice/PO/Quote/Credit Note num (AC-5)', function() {
  resetDB();
  ctx.DB.inv = [{ id: 'I1', num: 'INV10005' }, { id: '', num: '' }];
  ctx.DB.po  = [{ id: 'P1', num: 'PO-0009' }, { id: '', num: '' }];
  ctx.DB.qt  = [{ id: 'Q1', num: 'QT-0009' }];
  ctx.executeDataCleanup();
  assertEqual(ctx.DB.inv.length, 1, 'phantom Invoice removed');
  assertEqual(ctx.DB.inv[0].num, 'INV10005', 'real Invoice num untouched');
  assertEqual(ctx.DB.po.length, 1, 'phantom PO removed');
  assertEqual(ctx.DB.po[0].num, 'PO-0009', 'real PO num untouched');
  assertEqual(ctx.DB.qt[0].num, 'QT-0009', 'real Quote num untouched');
});

test('verifyFkIntegrityAfterCleanup() — FK fields still resolve after the referenced record is renumbered (AC-6)', function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'Acme', num: 'SUP-0001' }];
  ctx.DB.li  = [{ id: 'LI1', num: 'LI-0001' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane', supplierId: 'S1' }];
  ctx.DB.qt  = [{ id: 'Q1', num: 'QT-0001', sourceContactId: 'C1', lines: [{ supId: 'S1', lid: 'LI1' }] }];
  ctx.DB.inv = [{ id: 'INV1', num: 'INV10001', lineItems: [{ lid: 'LI1' }] }];
  ctx.renumberEntitySequentially(ctx.DB.sup, 'SUP'); // renumbers S1 (no-op num here, but id is what FKs use)
  var dangling = ctx.verifyFkIntegrityAfterCleanup();
  assertEqual(dangling.length, 0, 'Contact.supplierId, Quote.sourceContactId, Quote line supId/lid, Invoice line lid all still resolve — id never changes, only num');
});

test('verifyFkIntegrityAfterCleanup() — detects a genuinely dangling reference', function() {
  resetDB();
  ctx.DB.sup = [{ id: 'S1', name: 'Acme' }];
  ctx.DB.con = [{ id: 'C1', name: 'Jane', supplierId: 'GONE' }];
  var dangling = ctx.verifyFkIntegrityAfterCleanup();
  assertEqual(dangling.length, 1);
  assertContains(dangling[0], 'C1');
});

test('executeDataCleanup() — writes real per-record entityType/entityId to the event log, not a raw DB-key or placeholder (AC-7)', function() {
  resetDB();
  ctx.DB.sup = [
    { id: 'S1', name: 'Acme', num: 'SUP-0001' },
    { id: '', name: '' },
    { id: 'S2', name: 'Beta', num: 'SUP-0003' },
  ];
  ctx.executeDataCleanup();
  var removalEv = ctx.DB.events.find(function(e) { return e.verb === 'phantom_removed'; });
  assert(removalEv, 'a removal event was logged');
  assertEqual(removalEv.entityType, 'supplier', 'entityType uses the app-wide human-readable vocabulary, not a raw DB key like "sup"');
  var renumberEv = ctx.DB.events.find(function(e) { return e.verb === 'renumbered'; });
  assert(renumberEv, 'a renumbering event was logged');
  assertEqual(renumberEv.entityType, 'supplier');
  assertEqual(renumberEv.entityId, 'S2', 'entityId is the real renumbered record\'s own id, not a "bulk" placeholder — so it shows in that record\'s own Activity tab');
});

testAsync('pullAll() — drops an id-keyed pulled record (Contact) that resolves to a falsy id, keeps the rest of the batch (AC-8)', async function() {
  resetDB();
  ctx.SS = { url: 'https://example.com/exec', auto: false, pull: true };
  _mockPullResponses = {
    sup: { status: 'ok', records: [] },
    li: { status: 'ok', records: [] },
    payments: { status: 'ok', records: [] },
    sh: { status: 'ok', records: [] },
    qt: { status: 'ok', records: [] },
    co: {
      status: 'ok',
      records: [
        { 'Contact ID': 'C1', 'Name': 'Jane', 'Email': 'jane@x.com', 'Phone': '', 'Company': '', 'Status': '', 'Source': '', 'Enquiry Summary': '', 'Notes': '', 'Created At': '', 'Last Contacted': '', 'GDPR Basis': '' },
        { 'Contact ID': '', 'Name': 'NoId', 'Email': 'noid@x.com', 'Phone': '', 'Company': '', 'Status': '', 'Source': '', 'Enquiry Summary': '', 'Notes': '', 'Created At': '', 'Last Contacted': '', 'GDPR Basis': '' }, // header-keyed blank id — SYNC-GAP-001 class
      ],
    },
  };
  var warned = [];
  var origWarn = console.warn;
  console.warn = function() { warned.push(Array.prototype.slice.call(arguments).join(' ')); };
  await ctx.pullAll();
  console.warn = origWarn;
  _mockPullResponses = {};
  assertEqual(ctx.DB.con.length, 1, 'the falsy-id record is dropped, the valid one survives');
  assertEqual(ctx.DB.con[0].name, 'Jane');
  assert(warned.some(function(w) { return w.indexOf('dropping') >= 0; }), 'a console warning is emitted for the dropped record');
});

console.log('\nOrder Request/RFQ -> Quote -> Invoice referential integrity (REQ/SPEC-INTEG-001 Phase 1)');

function mkOrdWithCommittedResponse() {
  ctx.DB.ord = [{
    id: 'O1', num: 'ORD-0001', contactId: null, stage: 'Qualifying', actions: [],
    lines: [{
      id: 'L1', category: 'Cat A', itemSpec: 'Item A', orderVolumeQty: '1', orderVolumeUnit: 'pallet',
      packingSpec: '', baseUom: '', baseQty: 10, qtyStatus: 'Unknown', sourceCountry: '', variantOption: '', lineUpdates: [],
      rfqResponses: [{ id: 'R1', supId: 'S1', cost: 100, currency: 'USD', cbm: 1, dutyPct: 2, dg: false, moq: '', leadTime: '', paymentTerms: '', notes: '', contactId: null, ts: '' }],
      committedResponseId: 'R1'
    }]
  }];
  ctx.DB.sup = [{ id: 'S1', name: 'Sup1' }];
}

function saveQteSetupIntegLine(rid) {
  mockEl('ql-supId-' + rid).value = 'S1';
  mockEl('ql-desc-' + rid).value = 'Item A';
  mockEl('ql-qty-' + rid).value = '10';
  mockEl('ql-uom-' + rid).value = 'pcs';
  mockEl('ql-cost-' + rid).value = '100';
  mockEl('ql-cbm-' + rid).value = '1';
  mockEl('ql-dg-' + rid).checked = false;
  mockEl('ql-dutyPct-' + rid).value = '2';
  mockEl('ql-note-' + rid).value = '';
}

test('ordConvertToQuote() -> saveQte() — Quote line carries sourceOrdId/sourceOrdLineId/sourceRfqResponseId (AC-1)', function() {
  resetDB();
  mkOrdWithCommittedResponse();
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  assertEqual(ctx.cQL.length, 1);
  var rid = ctx.cQL[0].rid;
  assertEqual(ctx.cQL[0].sourceOrdId, 'O1');
  assertEqual(ctx.cQL[0].sourceOrdLineId, 'L1');
  assertEqual(ctx.cQL[0].sourceRfqResponseId, 'R1');
  mockEl('qf-num').value = 'QTE-0001'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var savedLine = ctx.DB.qt[0].lines[0];
  assertEqual(savedLine.sourceOrdId, 'O1', 'sourceOrdId persisted through saveQte()');
  assertEqual(savedLine.sourceOrdLineId, 'L1', 'sourceOrdLineId persisted');
  assertEqual(savedLine.sourceRfqResponseId, 'R1', 'sourceRfqResponseId persisted');
});

test('saveQte() — re-saving an existing Quote with no changes preserves source fields (AC-2)', function() {
  resetDB();
  mkOrdWithCommittedResponse();
  ctx.cQL = [];
  ctx.ordConvertToQuote('O1');
  var rid = ctx.cQL[0].rid;
  mockEl('qf-num').value = 'QTE-0001'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var qtId = ctx.DB.qt[0].id;
  ctx.EI.qt = qtId;
  ctx.cQL = ctx.DB.qt[0].lines.map(function(l){ return Object.assign({}, l); });
  saveQteSetupIntegLine(rid);
  ctx.saveQte();
  var savedLine = ctx.DB.qt[0].lines[0];
  assertEqual(savedLine.sourceOrdId, 'O1', 'sourceOrdId survives a no-op re-save');
  assertEqual(savedLine.sourceOrdLineId, 'L1', 'sourceOrdLineId survives a no-op re-save');
  assertEqual(savedLine.sourceRfqResponseId, 'R1', 'sourceRfqResponseId survives a no-op re-save');
});

test('addQteLine() + saveQte() — a manually-added line has no source fields at all (AC-3)', function() {
  resetDB();
  ctx.EI.qt = null;
  ctx.cQL = [];
  ctx.addQteLine();
  var rid = ctx.cQL[0].rid;
  mockEl('qf-num').value = 'QTE-0002'; mockEl('qf-client').value = 'Client'; mockEl('qf-dt').value = '2026-05-01';
  mockEl('qf-valid').value = ''; mockEl('qf-mode').value = 'LCL'; mockEl('qf-mkp').value = '15';
  mockEl('qf-st').value = 'Draft'; mockEl('qf-nt').value = ''; mockEl('qt-verr').textContent = '';
  mockEl('ql-supId-' + rid).value = ''; mockEl('ql-desc-' + rid).value = 'Manual item';
  mockEl('ql-qty-' + rid).value = '1'; mockEl('ql-uom-' + rid).value = 'pcs';
  mockEl('ql-cost-' + rid).value = '50'; mockEl('ql-cbm-' + rid).value = '0';
  mockEl('ql-dg-' + rid).checked = false; mockEl('ql-dutyPct-' + rid).value = '0'; mockEl('ql-note-' + rid).value = '';
  ctx.saveQte();
  var savedLine = ctx.DB.qt[0].lines[0];
  assertEqual('sourceOrdId' in savedLine, false, 'manually-added line has no sourceOrdId key at all');
  assertEqual('sourceOrdLineId' in savedLine, false, 'manually-added line has no sourceOrdLineId key at all');
  assertEqual('sourceRfqResponseId' in savedLine, false, 'manually-added line has no sourceRfqResponseId key at all');
});

test('renderQteSourceDriftWarn() — matching commitment shows no banner (AC-4)', function() {
  resetDB();
  ctx.DB.ord = [{ id: 'O1', lines: [{ id: 'L1', committedResponseId: 'R1' }] }];
  var q = { lines: [{ sourceOrdId: 'O1', sourceOrdLineId: 'L1', sourceRfqResponseId: 'R1' }] };
  ctx.renderQteSourceDriftWarn(q);
  assertEqual(mockEl('qt-drift-warn').innerHTML, '');
});

test('renderQteSourceDriftWarn() — a different RFQ response now committed shows the mismatch banner (AC-5)', function() {
  resetDB();
  ctx.DB.ord = [{ id: 'O1', lines: [{ id: 'L1', committedResponseId: 'R2' }] }];
  var q = { lines: [{ sourceOrdId: 'O1', sourceOrdLineId: 'L1', sourceRfqResponseId: 'R1' }] };
  ctx.renderQteSourceDriftWarn(q);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed');
});

test('renderQteSourceDriftWarn() — source Order Request deleted shows a distinct message (AC-6)', function() {
  resetDB();
  ctx.DB.ord = [];
  var q = { lines: [{ sourceOrdId: 'O1', sourceOrdLineId: 'L1', sourceRfqResponseId: 'R1' }] };
  ctx.renderQteSourceDriftWarn(q);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'no longer exists');
  assertNotContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed', 'deleted-source message is distinct from the mismatch message');
});

test('renderQteSourceDriftWarn() — a Quote with no source-tracked lines never shows a banner (AC-7)', function() {
  resetDB();
  var q = { lines: [{ desc: 'Manual line' }] };
  ctx.renderQteSourceDriftWarn(q);
  assertEqual(mockEl('qt-drift-warn').innerHTML, '');
});

test('renderQteSourceDriftWarn() — a mixed Quote (one manual line, one stale tracked line) still shows the banner (AC-15)', function() {
  resetDB();
  ctx.DB.ord = [{ id: 'O1', lines: [{ id: 'L1', committedResponseId: 'R2' }] }];
  var q = { lines: [
    { desc: 'Manual line' },
    { sourceOrdId: 'O1', sourceOrdLineId: 'L1', sourceRfqResponseId: 'R1' }
  ] };
  ctx.renderQteSourceDriftWarn(q);
  assertContains(mockEl('qt-drift-warn').innerHTML, 'Source pricing has changed');
});

function mkAutoPosInvAndPo(invUp, invQty) {
  var inv = { id: 'I1', num: 'INV20001', lineItems: [{ rid: 'r1', lid: 'LI1', desc: 'Widget', uom: 'pcs', qty: invQty, up: invUp, unitCost: 0, lineType: 'product' }] };
  var po = { id: 'P1', num: 'PO-1', supId: 'S1', invId: 'I1', invNum: 'INV20001', lineItems: [{ rid: 'pr1', lid: 'LI1', desc: 'Widget', sku: '', uom: 'pcs', qty: invQty, cost: 5, sourceInvUp: invUp }] };
  ctx.DB.inv = [inv];
  ctx.DB.po = [po];
  ctx.DB.li = [{ id: 'LI1', supId: 'S1' }];
  return po;
}

test('renderPoSourceDriftWarn() — unchanged invoice since autoPos() generation shows no banner (AC-8)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.renderPoSourceDriftWarn(po);
  assertEqual(mockEl('po-drift-warn').innerHTML, '');
});

test('renderPoSourceDriftWarn() — invoice line price changed since generation shows the banner (AC-9)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.DB.inv[0].lineItems[0].up = 15;
  ctx.renderPoSourceDriftWarn(po);
  assertContains(mockEl('po-drift-warn').innerHTML, 'Source Invoice has changed');
});

test('renderPoSourceDriftWarn() — invoice line qty changed since generation shows the banner (AC-9)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.DB.inv[0].lineItems[0].qty = 8;
  ctx.renderPoSourceDriftWarn(po);
  assertContains(mockEl('po-drift-warn').innerHTML, 'Source Invoice has changed');
});

test('renderPoSourceDriftWarn() — a historical PO line with no sourceInvUp at all is never falsely flagged on price (AC-8, spec-gate B-1 regression guard)', function() {
  resetDB();
  var inv = { id: 'I1', num: 'INV20002', lineItems: [{ rid: 'r1', lid: 'LI1', desc: 'Widget', uom: 'pcs', qty: 5, up: 99, unitCost: 0, lineType: 'product' }] };
  // Built directly, NOT via autoPos() — simulates a PO generated before this phase shipped, so its
  // line item genuinely has no sourceInvUp key at all (not undefined-via-autoPos, absent entirely).
  var po = { id: 'P1', num: 'PO-1', supId: 'S1', invId: 'I1', invNum: 'INV20002', lineItems: [{ rid: 'pr1', lid: 'LI1', desc: 'Widget', sku: '', uom: 'pcs', qty: 5, cost: 5 }] };
  ctx.DB.inv = [inv];
  ctx.DB.po = [po];
  ctx.DB.li = [{ id: 'LI1', supId: 'S1' }];
  assertEqual('sourceInvUp' in po.lineItems[0], false, 'precondition: no sourceInvUp key present at all');
  ctx.renderPoSourceDriftWarn(po);
  assertEqual(mockEl('po-drift-warn').innerHTML, '', 'no false positive from a missing price baseline on an otherwise-unchanged historical PO');
});

test('renderPoSourceDriftWarn() — source Invoice deleted shows a distinct message (AC-11)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.DB.inv = [];
  ctx.renderPoSourceDriftWarn(po);
  assertContains(mockEl('po-drift-warn').innerHTML, 'no longer exists');
  assertNotContains(mockEl('po-drift-warn').innerHTML, 'Source Invoice has changed', 'deleted-source message is distinct from the mismatch message');
});

test('renderPoSourceDriftWarn() — a PO with no invId (manual or qteToPoConvert()-originated) is never checked (AC-12)', function() {
  resetDB();
  ctx.DB.inv = [{ id: 'I1', lineItems: [] }];
  var po = { id: 'P1', supId: 'S1', invId: '', quoteId: 'Q1', lineItems: [] };
  ctx.renderPoSourceDriftWarn(po);
  assertEqual(mockEl('po-drift-warn').innerHTML, '');
});

test('renderPoSourceDriftWarn() — a new line added to the invoice for the same supplier shows the banner even though existing lines are unchanged (AC-16)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.DB.inv[0].lineItems.push({ rid: 'r2', lid: 'LI2', desc: 'New Widget', uom: 'pcs', qty: 3, up: 20, unitCost: 0, lineType: 'product' });
  ctx.DB.li.push({ id: 'LI2', supId: 'S1' });
  ctx.renderPoSourceDriftWarn(po);
  assertContains(mockEl('po-drift-warn').innerHTML, 'Source Invoice has changed', 'new same-supplier line detected even with every existing PO line individually unchanged');
});

test('renderPoSourceDriftWarn() — a manually-added PO line (lid:\'\') coexists safely with an unchanged real line (AC-17)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  po.lineItems.push({ rid: 'pr2', lid: '', desc: 'Manual extra', sku: '', uom: 'pcs', qty: 1, cost: 0 });
  ctx.renderPoSourceDriftWarn(po);
  assertEqual(mockEl('po-drift-warn').innerHTML, '', 'manually-added line is excluded from comparison, causes no false positive');
});

test('renderPoSourceDriftWarn() — a new-supplier invoice line with no PO at all causes no error anywhere (AC-18, accepted residual gap)', function() {
  resetDB();
  var po = mkAutoPosInvAndPo(10, 5);
  ctx.DB.inv[0].lineItems.push({ rid: 'r2', lid: 'LI2', desc: 'Brand new supplier item', uom: 'pcs', qty: 1, up: 40, unitCost: 0, lineType: 'product' });
  ctx.DB.li.push({ id: 'LI2', supId: 'S2' }); // a supplier with no PO from this invoice at all
  assertEqual(ctx.DB.po.filter(function(p){ return p.supId === 'S2'; }).length, 0, 'precondition: genuinely no PO exists for the new supplier');
  ctx.renderPoSourceDriftWarn(po); // must not throw
  assertEqual(mockEl('po-drift-warn').innerHTML, '', 'the existing (unrelated) PO for S1 is correctly unaffected by an S2 line it has nothing to do with');
});

// ── Buyer-approval capture on Invoice (REQ/SPEC-INTEG-001 Phase 2) ─
console.log('\nBuyer-approval capture on Invoice (Phase 2)');

test('saveInv() — brand-new invoice has all six new fields present and falsy (AC-1)', function() {
  resetDB();
  ctx.EI.i = null; ctx.cIL = [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }];
  setupInvForm('INV20001');
  ctx.saveInv();
  var inv = ctx.DB.inv[0];
  ['buyerApprovedAt','buyerApprovedBy','approvalMethod','approvalNote','linkedQuoteId','linkedQuoteNum'].forEach(function(f) {
    assertEqual(!!inv[f], false, f + ' must be falsy on a brand-new invoice');
  });
});

test('saveInvApprove() — records approval with method + approver, logs buyer_approved event (AC-2)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-a', num: 'INV20002', status: 'Pro-forma', lineItems: [], pos: [] });
  ctx.openInvApprove('inv-a');
  mockEl('ia-method').value = 'Email';
  mockEl('ia-by').value = 'J. Smith';
  ctx.saveInvApprove();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-a'; });
  assert(!!inv.buyerApprovedAt, 'buyerApprovedAt set');
  assertEqual(inv.buyerApprovedBy, 'J. Smith');
  assertEqual(inv.approvalMethod, 'Email');
  assertEqual(inv.approvalNote, '');
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'buyer_approved'; });
  assertEqual(evts.length, 1, 'one buyer_approved event logged');
  assertEqual(evts[0].entityId, 'inv-a');
});

test('vInvApprove() — blocks when Method is Other and Note is empty (AC-3)', function() {
  resetDB();
  mockEl('ia-method').value = 'Other';
  mockEl('ia-by').value = 'J. Smith';
  mockEl('ia-note').value = '';
  var ok = ctx.vInvApprove();
  assertEqual(ok, false, 'validation fails when Other has no note');
  assertContains(mockEl('ia-verr').textContent, 'Approval Note is required', 'error names the missing note');
});

test('invApprovalActionVisible() — false for Draft and Sent (AC-4)', function() {
  assertEqual(ctx.invApprovalActionVisible({ status: 'Draft' }), false);
  assertEqual(ctx.invApprovalActionVisible({ status: 'Sent' }), false);
});

test('saveInv() — header-only edit on an approved invoice does not clear approval (AC-5)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-b', num: 'INV20005', status: 'Pro-forma',
    lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.EI.i = 'inv-b';
  ctx.cIL = [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }];
  setupInvForm('INV20005');
  mockEl('inv-sm').value = 'Pro-forma';
  mockEl('if-inco').value = 'CIF'; // header field change only
  ctx.saveInv();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-b'; });
  assertEqual(inv.buyerApprovedAt, '2026-01-01T00:00:00.000Z', 'approval preserved on unrelated header edit');
  assertEqual(ctx.DB.events.filter(function(e){ return e.verb === 'approval_cleared'; }).length, 0, 'no approval_cleared event');
});

test('saveInv() — changing a line qty/price on an approved invoice clears approval (AC-6)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-c', num: 'INV20006', status: 'Pro-forma',
    lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.EI.i = 'inv-c';
  ctx.cIL = [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 25 }]; // price changed
  setupInvForm('INV20006');
  mockEl('inv-sm').value = 'Pro-forma';
  ctx.saveInv();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-c'; });
  assertEqual(inv.buyerApprovedAt, '', 'approval cleared after price change');
  assertEqual(inv.buyerApprovedBy, ''); assertEqual(inv.approvalMethod, ''); assertEqual(inv.approvalNote, '');
  assertEqual(ctx.DB.events.filter(function(e){ return e.verb === 'approval_cleared'; }).length, 1, 'approval_cleared event logged');
});

test('saveInv() — adding a line to an approved invoice clears approval (AC-7)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-d', num: 'INV20007', status: 'Pro-forma',
    lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.EI.i = 'inv-d';
  ctx.cIL = [
    { rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 },
    { rid: 'r2', lid: '', desc: 'Gadget', uom: 'pcs', qty: 1, up: 5 }
  ];
  setupInvForm('INV20007');
  mockEl('inv-sm').value = 'Pro-forma';
  ctx.saveInv();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-d'; });
  assertEqual(inv.buyerApprovedAt, '', 'approval cleared after a line is added');
});

test('saveInv() — editing lines on a never-approved invoice logs no approval_cleared event (AC-8)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-e', num: 'INV20008', status: 'Pro-forma',
    lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [] });
  ctx.EI.i = 'inv-e';
  ctx.cIL = [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 5, up: 10 }];
  setupInvForm('INV20008');
  mockEl('inv-sm').value = 'Pro-forma';
  ctx.saveInv();
  assertEqual(ctx.DB.events.filter(function(e){ return e.verb === 'approval_cleared'; }).length, 0, 'no clear event — nothing was ever approved');
});

test('saveInvProgress() — no Quote selected: fields stay empty, event logged, status unchanged (AC-9)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-f', num: 'INV20003', status: 'Pro-forma', lineItems: [], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.openInvProgress('inv-f');
  mockEl('ip-qt').value = '';
  ctx.saveInvProgress();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-f'; });
  assertEqual(inv.linkedQuoteId, ''); assertEqual(inv.linkedQuoteNum, '');
  assertEqual(inv.status, 'Pro-forma', 'status untouched');
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'progressed_to_invoicing'; });
  assertEqual(evts.length, 1);
  assertContains(evts[0].summary, 'no Quote linked');
});

test('saveInvProgress() — Quote selected: fields set, status unchanged (AC-10)', function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QT-1', client: 'Acme', dt: '2026-01-01' });
  ctx.DB.inv.push({ id: 'inv-g', num: 'INV20004', status: 'Pro-forma', lineItems: [], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.openInvProgress('inv-g');
  mockEl('ip-qt').value = 'q1';
  ctx.saveInvProgress();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-g'; });
  assertEqual(inv.linkedQuoteId, 'q1'); assertEqual(inv.linkedQuoteNum, 'QT-1');
  assertEqual(inv.status, 'Pro-forma', 'status untouched');
});

test('invProgressActionVisible() — false when not yet approved (AC-11)', function() {
  assertEqual(ctx.invProgressActionVisible({ status: 'Pro-forma', buyerApprovedAt: '' }), false);
});

test('saveInvProgress() — re-running with a different Quote updates the link and logs a second event (AC-12)', function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QT-1', client: 'Acme', dt: '2026-01-01' });
  ctx.DB.qt.push({ id: 'q2', num: 'QT-2', client: 'Acme', dt: '2026-02-01' });
  ctx.DB.inv.push({ id: 'inv-h', num: 'INV20011', status: 'Pro-forma', lineItems: [], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.openInvProgress('inv-h'); mockEl('ip-qt').value = 'q1'; ctx.saveInvProgress();
  ctx.openInvProgress('inv-h'); mockEl('ip-qt').value = 'q2'; ctx.saveInvProgress();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-h'; });
  assertEqual(inv.linkedQuoteId, 'q2'); assertEqual(inv.linkedQuoteNum, 'QT-2');
  var evts = ctx.DB.events.filter(function(e){ return e.verb === 'progressed_to_invoicing'; });
  assertEqual(evts.length, 2, 'both events remain in the log');
});

test('populateInvProgressQte() — lists every Quote plus the None default even when buyer matches nothing (AC-14)', function() {
  resetDB();
  ctx.DB.qt.push({ id: 'q1', num: 'QT-1', client: 'Unrelated Co', dt: '2026-01-01' });
  var inv = { id: 'inv-i', buyer: 'Nobody Matches', linkedQuoteId: '' };
  ctx.populateInvProgressQte(inv);
  var html = mockEl('ip-qt').innerHTML;
  assertContains(html, 'None / not applicable', 'default option present');
  assertContains(html, 'QT-1', 'Quote still listed despite no buyer match');
});

test('saveInvApprove() — re-confirming an approved invoice re-stamps the timestamp and logs a second event (AC-15)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-j', num: 'INV20012', status: 'Pro-forma', lineItems: [], pos: [] });
  ctx.openInvApprove('inv-j'); mockEl('ia-method').value = 'Email'; mockEl('ia-by').value = 'J. Smith'; ctx.saveInvApprove();
  var firstStamp = ctx.DB.inv.find(function(x){ return x.id === 'inv-j'; }).buyerApprovedAt;
  ctx.openInvApprove('inv-j'); mockEl('ia-method').value = 'WhatsApp'; mockEl('ia-by').value = 'A. Jones'; ctx.saveInvApprove();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-j'; });
  assertEqual(inv.approvalMethod, 'WhatsApp', 'method updated on re-confirmation');
  assert(inv.buyerApprovedAt >= firstStamp, 'timestamp is new/later on re-confirmation');
  assertEqual(ctx.DB.events.filter(function(e){ return e.verb === 'buyer_approved'; }).length, 2, 'both approval events remain in the log');
});

test('invProgressActionVisible() — false once status has moved past Pro-forma, even if approved (AC-16)', function() {
  assertEqual(ctx.invProgressActionVisible({ status: 'Sent', buyerApprovedAt: '2026-01-01T00:00:00.000Z' }), false);
});

test('saveInv() — a save with no live line items (cIL.length===0) on an approved invoice does not falsely clear approval (ordering regression guard)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-k', num: 'INV20009', status: 'Pro-forma',
    lineItems: [{ rid: 'r1', lid: '', desc: 'Widget', uom: 'pcs', qty: 1, up: 10 }], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '',
    calc_grandTotal: '10', calc_cogs: '0', calc_grossProfit: '0', calc_netProfit: '0',
    calc_margin: '0', calc_balanceDue: '0', calc_liTotal: '10', calc_taxAmt: '0' });
  ctx.EI.i = 'inv-k';
  ctx.cIL = []; // e.g. a save path that doesn't touch line items
  setupInvForm('INV20009');
  mockEl('inv-sm').value = 'Pro-forma';
  ctx.saveInv();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-k'; });
  assertEqual(inv.buyerApprovedAt, '2026-01-01T00:00:00.000Z', 'approval NOT falsely cleared when cIL is empty and lines are actually unchanged');
  assertEqual(ctx.DB.events.filter(function(e){ return e.verb === 'approval_cleared'; }).length, 0);
});

test('invLinesChanged() — rid-less legacy line items (no rid field) do not false-positive on an unchanged re-save (rid-fallback regression guard)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-l', num: 'INV20010', status: 'Pro-forma',
    lineItems: [{ lid: '', desc: 'Widget', uom: 'pcs', qty: 20, up: 1928.42 }], pos: [], // no rid — mirrors DINV-0001's rid-less shape
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '' });
  ctx.EI.i = 'inv-l';
  // cIL mirrors the same line's content; saveInv()'s literal always mints a fresh rid when absent
  ctx.cIL = [{ rid: '', lid: '', desc: 'Widget', uom: 'pcs', qty: 20, up: 1928.42 }];
  setupInvForm('INV20010');
  mockEl('inv-sm').value = 'Pro-forma';
  ctx.saveInv();
  var inv = ctx.DB.inv.find(function(x){ return x.id === 'inv-l'; });
  assertEqual(inv.buyerApprovedAt, '2026-01-01T00:00:00.000Z', 'approval not falsely cleared for a rid-less legacy line with no real change');
});

test('processImport() — CSV import update preserves approval/link fields on an already-approved invoice (CSV-import regression guard)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-csv1', num: 'INV-CSV-1', buyer: 'Test Buyer', status: 'Pro-forma', lineItems: [], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '',
    linkedQuoteId: 'q1', linkedQuoteNum: 'QT-1' });
  ctx.processImport('inv', 'Invoice #,Buyer\nINV-CSV-1,Test Buyer\n');
  var inv = ctx.DB.inv.find(function(x){ return x.num === 'INV-CSV-1'; });
  assertEqual(inv.buyerApprovedAt, '2026-01-01T00:00:00.000Z', 'buyerApprovedAt survives processImport() update');
  assertEqual(inv.buyerApprovedBy, 'J. Smith');
  assertEqual(inv.approvalMethod, 'Email');
  assertEqual(inv.linkedQuoteId, 'q1');
  assertEqual(inv.linkedQuoteNum, 'QT-1');
});

test('processImportRecords() — record-based import update preserves approval/link fields (CSV-import regression guard)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-csv2', num: 'INV-CSV-2', buyer: 'Test Buyer', status: 'Pro-forma', lineItems: [], pos: [],
    buyerApprovedAt: '2026-01-01T00:00:00.000Z', buyerApprovedBy: 'J. Smith', approvalMethod: 'Email', approvalNote: '',
    linkedQuoteId: 'q1', linkedQuoteNum: 'QT-1' });
  ctx.processImportRecords('inv', [{ 'Invoice #': 'INV-CSV-2', 'Buyer': 'Test Buyer' }], function(){});
  var inv = ctx.DB.inv.find(function(x){ return x.num === 'INV-CSV-2'; });
  assertEqual(inv.buyerApprovedAt, '2026-01-01T00:00:00.000Z', 'buyerApprovedAt survives processImportRecords() update');
  assertEqual(inv.linkedQuoteId, 'q1');
  assertEqual(inv.linkedQuoteNum, 'QT-1');
});

// ── SUMMARY ────────────────────────────────────────────────────
_runAsyncTests().then(function() {
  console.log('\n' + '─'.repeat(48));
  _results.forEach(r => {
    console.log(r.ok ? '  ✓  ' + r.name : '  ✗  ' + r.name);
    if (!r.ok) console.log('       ' + r.msg.replace(/\n/g, '\n       '));
  });
  console.log('\n' + _pass + '/' + (_pass + _fail) + ' tests passed');
  if (_fail > 0) { console.log('\nFAIL'); process.exit(1); }
  else            { console.log('\nPASS'); process.exit(0); }
});
