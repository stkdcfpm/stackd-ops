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
  ctx.DB = { sup: [], li: [], inv: [], po: [], payments: [] };
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
test('chargesIncluded=true: np = grand - cogs', () => {
  ctx.DB.li = [{ id:'l1', cost:600 }];
  const inv = { id:'t7', lineItems:[{qty:1,up:1000,lid:'l1'}],
    taxRate:0, dep:0, lf:100, chargesIncluded:true };
  assertEqual(ctx.cInv(inv).np, 500, 'np = 1100 - 600 = 500');
  ctx.DB.li = [];
});
test('chargesIncluded=false: np = grand - cogs - charges', () => {
  const inv = { id:'t8', lineItems:[{qty:1,up:1000}],
    taxRate:0, dep:0, lf:100, chargesIncluded:false, calc_cogs:'600' };
  assertEqual(ctx.cInv(inv).np, 400, 'np = 1100 - 600 - 100 = 400');
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
  mockEl('pf-nt').value  = '';
  mockEl('po-sm').value  = 'Draft';

  ctx.savePO();

  const saved = ctx.DB.po[0];
  assert(saved, 'PO should be saved');
  assertEqual(saved.invId, '', 'invId should be empty string when no match found');
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
