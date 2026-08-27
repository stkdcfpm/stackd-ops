# SPEC-INTEG-002 (Sub-phase 2a) — Implementation Spec

**Implements:** `docs/REQ-INTEG-002-v2.md` (requirements-gate: CONDITIONAL PASS v1 → PASS v2, confirmatory re-review)
**Status:** v2 — supersedes v1. Independent spec-gate review of v1 returned CONDITIONAL PASS (3 blocking findings, 3 advisory) — all six addressed below; see §8 for the full review-resolution log.

All line numbers below are cited against `main` @ `0446b7c` (563/563 tests passing). Re-verify against current `main` before build if any time has passed.

---

## 1. New entity plumbing: `K.spm`, `DB.supPayments`

**File:** `index.html:2604` (the `K` object literal):

```diff
-const K = {s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm', sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai', co:'st_co', ev:'st_ev', bu:'st_buy', ord:'st_ord'};
+const K = {s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm', sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai', co:'st_co', ev:'st_ev', bu:'st_buy', ord:'st_ord', spm:'st_spm'};
```

**File:** `index.html:2617` (the `let DB = {...}` initialization):

```diff
-let DB = { sup: ldArr(K.s), li: ldArr(K.l), inv: ldArr(K.i), po: ldArr(K.p), payments: ldArr(K.pm), sh: ldArr(K.sh), qt: ldArr(K.qt), con: ldArr(K.co), events: ldArr(K.ev), buy: ldArr(K.bu), ord: ldArr(K.ord) };
+let DB = { sup: ldArr(K.s), li: ldArr(K.l), inv: ldArr(K.i), po: ldArr(K.p), payments: ldArr(K.pm), sh: ldArr(K.sh), qt: ldArr(K.qt), con: ldArr(K.co), events: ldArr(K.ev), buy: ldArr(K.bu), ord: ldArr(K.ord), supPayments: ldArr(K.spm) };
```

**Confirmed per REQ-INTEG-002g:** no change to `FIELD_MAPS` (`index.html:3879-3889`), `syncAll()`'s entity list (`index.html:3942`), `pullAll()`'s `simpleEnts`/`idKeyedEnts` (`index.html:4054-4055`, `4061`), or `pushAll()`'s `ents` (`index.html:4136`). `supPayments` *is* added to `saveAll()` below — see §6 for why that's not a contradiction: `saveAll()` is local `localStorage` persistence, entirely distinct from the Sheets-sync surfaces REQ-INTEG-002g governs, and every existing entity array (including `ord`/`buy`, which also have zero sync footprint) is already listed there for the same reason. (Corrected framing from v1 — see §8, A-1.)

**File:** `index.html:3322` (`saveAll()` — corrected citation, see §8, B-2; v1 mis-cited this as `3313`, which is a line inside the unrelated `sv()` function):

```diff
-const saveAll = () => { sv(K.s,DB.sup); sv(K.l,DB.li); sv(K.i,DB.inv); sv(K.p,DB.po); sv(K.pm,DB.payments); sv(K.sh,DB.sh); sv(K.qt,DB.qt); sv(K.co,DB.con); sv(K.ev,DB.events); sv(K.bu,DB.buy); sv(K.ord,DB.ord); };
+const saveAll = () => { sv(K.s,DB.sup); sv(K.l,DB.li); sv(K.i,DB.inv); sv(K.p,DB.po); sv(K.pm,DB.payments); sv(K.sh,DB.sh); sv(K.qt,DB.qt); sv(K.co,DB.con); sv(K.ev,DB.events); sv(K.bu,DB.buy); sv(K.ord,DB.ord); sv(K.spm,DB.supPayments); };
```

**New in v2 (see §8, B-1) — `expAll()`/`doImport()`, the local JSON backup/restore path.** Since `supPayments` has no Sheets-sync path by design, the "Download Backup" JSON file is its *only* portable backup mechanism — worse off than every other entity, which at least has Sheets as a second copy. `buy`/`ord`, the two most recently added top-level entities, both were added to this backup/restore path when they shipped; omitting `supPayments` here would silently make it the first entity to lose data on a restore/device-migration, directly undermining the reason this ledger is being built.

**File:** `index.html:9717-9731` (`expAll()`'s `snap` literal):

```diff
     buy: DB.buy,
     ord: DB.ord,
+    supPayments: DB.supPayments,
     settings: { url: SS.url, auto: SS.auto, pol: SS.pol }, // token excluded — credential, not config
```

**File:** `index.html:9789-9790` (`doImport()`'s ad-hoc `buy`/`ord` restore block — `supPayments` follows the exact same pattern, not the earlier `entities`/`structOk` array at `9758`, since that array only covers the older, originally-shipped entity set and `buy`/`ord` were correctly added the same way, as their own explicit `if` blocks, not by extending that array):

```diff
     if (data.buy && Array.isArray(data.buy)) { DB.buy = data.buy; sv(K.bu, DB.buy); }
     if (data.ord && Array.isArray(data.ord)) { DB.ord = data.ord; sv(K.ord, DB.ord); }
+    if (data.supPayments && Array.isArray(data.supPayments)) { DB.supPayments = data.supPayments; sv(K.spm, DB.supPayments); }
```

**Not addressed in this phase, disclosed (see §8, A-2):** `loadDemoData()`'s idempotency array (`index.html:4335`) and `clearDemoData()`'s per-entity filter list (`index.html:4442-4451`) are not extended, since this phase adds no demo `_demo:true` Supplier Payment records. If a future phase adds Demo Mode coverage for this feature (mirroring the precedent already set for `ord`/`li` in v2.9.61), both lists must be extended at that time.

---

## 2. `lockFxRate(amount, currency)` (REQ-INTEG-002b)

**File:** immediately after `fromGBP()` (`index.html:4276-4284`):

```js
function lockFxRate(amount, currency) {
  var cur = (currency || 'USD').toUpperCase();
  var ratesUsed = {};
  if (cur === 'USD') ratesUsed.fxGBPUSD = QR.fxGBPUSD || QR_DEFAULTS.fxGBPUSD;
  else if (cur === 'RMB' || cur === 'CNY') ratesUsed.fxGBPRMB = QR.fxGBPRMB || QR_DEFAULTS.fxGBPRMB;
  else if (cur === 'BBD') ratesUsed.fxGBPBBD = QR.fxGBPBBD || QR_DEFAULTS.fxGBPBBD;
  // GBP, or any unrecognized currency string: no rate applied, ratesUsed stays {} —
  // matches toGBP()'s own fall-through branch (index.html:4269, 4273) identically.
  return {
    amount: +amount || 0,
    currency: cur,
    gbpEquiv: toGBP(amount, cur),
    ratesUsed: ratesUsed,
    ts: new Date().toISOString()
  };
}
```

This branches on `cur` identically to `toGBP()` itself (`index.html:4266-4274`) so `ratesUsed` always reflects the exact rate `toGBP()` actually applied, fallback included — deliberately not a single shared helper with `toGBP()`, since `toGBP()` returns a number and this needs the rate *value* alongside it; duplicating the four-way branch here is simpler and safer than trying to make `toGBP()` itself report which rate it used. Independently verified (spec-gate) against all four recognized currencies plus an unrecognized string: no case exists where this branching and `toGBP()`'s own branching diverge.

---

## 3. `getPOPayments(poId)`, `getPOTotalPaid(poId)`, `saveSupPayment()`, `deleteSupPayment()`, `vSupPay()` (REQ-INTEG-002c)

**File:** immediately after `addPaymentFromForm()` (`index.html:11394-11419`):

```js
function getPOPayments(poId) {
  return DB.supPayments.filter(function(p){ return p.poId === poId; })
    .sort(function(a,b){ return a.date < b.date ? -1 : 1; });
}

function getPOTotalPaid(poId) {
  return getPOPayments(poId).reduce(function(s,p){ return s + (+(p.rateLock && p.rateLock.gbpEquiv) || 0); }, 0);
}

function vSupPay(date, amount, purpose) {
  var dateEl = G('spm-date'), amtEl = G('spm-amount');
  if (!amount || +amount <= 0) {
    if (amtEl) { amtEl.style.borderBottomColor='#f87171'; amtEl.focus(); }
    toast('⚠ Payment amount must be greater than zero'); return false;
  }
  if (!RX.currency(String(amount))) {
    if (amtEl) amtEl.style.borderBottomColor='#f87171';
    toast('⚠ Payment amount must be a valid number with at most 2 decimal places'); return false;
  }
  if (amtEl) amtEl.style.borderBottomColor='var(--gn)';
  if (!date || !RX.date.test(date) || isNaN(new Date(date).getTime())) {
    if (dateEl) { dateEl.style.borderBottomColor='#f87171'; dateEl.focus(); }
    toast('⚠ Payment date is required and must be a valid date'); return false;
  }
  if (dateEl) dateEl.style.borderBottomColor='var(--gn)';
  if (!purpose) {
    toast('⚠ Purpose is required'); return false;
  }
  return true;
}

function saveSupPayment(payment) {
  var existing = DB.supPayments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.supPayments[existing] = payment; }
  else { DB.supPayments.push(payment); }
  sv(K.spm, DB.supPayments);
  audit('SAVE', 'sup_payment', payment.id, payment);
  logEv('sup_payment', payment.id, 'created', 'Supplier payment ' + payment.currency + ' ' + (+payment.amount||0).toFixed(2) + ' recorded — ' + (payment.poNum||payment.poId||''), 'operator');
}

function deleteSupPayment(id) {
  var pm = DB.supPayments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this supplier payment record?')) return;
  logEv('sup_payment', pm.id, 'deleted', 'Supplier payment deleted — ' + (pm.poNum||pm.poId||''), 'operator');
  DB.supPayments = DB.supPayments.filter(function(p){ return p.id !== id; });
  sv(K.spm, DB.supPayments);
  audit('DELETE', 'sup_payment', id, pm);
  renderPOPaymentsTab(pm.poId);
}
```

`getPOTotalPaid()` sums `rateLock.gbpEquiv`, not raw `amount` — a deliberate departure from `getInvTotalPaid()`'s (`index.html:11258-11260`) literal raw-`amount` sum, which is safe there only because a buyer Payment record (`addPaymentFromForm()`, `index.html:11394-11419`) carries no per-record `currency` field at all (it implicitly inherits the single Invoice `cur`); a Supplier Payment record's `currency` genuinely varies per record for the same PO, so raw summation would silently produce a meaningless mixed-currency figure.

`vSupPay()` deliberately does **not** replicate `vPay()`'s (`index.html:7499-7523`) two date-adjacent checks — and those two are not equivalent to each other: the future-date check (`7514-7516`) is a hard *block* (`return false`), while the "before invoice date" check (`7518-7519`) is a non-blocking warning toast only. Neither is asked for in REQ-INTEG-002 (its only date-adjacent acceptance criterion, AC-5, requires just that `purpose` is required), so omitting both — the blocking one and the warning-only one alike — is a disclosed, defensible scope choice, not scope creep. (Clarified from v1 — see §8, A-3.)

`saveSupPayment()` deliberately does **not** replicate any of `savePayment()`'s (`index.html:11262-11311`) Invoice-side side effects, and does **not** write to `po.dep`/`po.fpmFunded`/`po.fpmRecovered` — per REQ-INTEG-002c/§5, this is a ledger that coexists with those fields, not one that updates them.

---

## 4. "Record Supplier Payment" UI (REQ-INTEG-002d, REQ-INTEG-002e)

### 4.1 New modal HTML

**File:** immediately after the `ov-payments` modal's closing `</div>` (`index.html:1245`):

```diff
     </div>
   </div>
 </div>
+
+<!-- SUPPLIER PAYMENT SECTION — mirrors ov-payments, opened per-PO -->
+<div class="ov" id="ov-po-payments" onclick="if(event.target===this)closeM('ov-po-payments')" style="display:none;">
+  <div class="modal" style="max-width:700px;">
+    <div class="mh">
+      <h2 id="spm-title">Supplier Payment History</h2>
+      <button class="mx" onclick="G('ov-po-payments').style.display='none'">&#215;</button>
+    </div>
+    <div class="mb">
+      <div id="po-payments-tab"></div>
+    </div>
+  </div>
+</div>
```

Confirmed no DOM id collision anywhere else in `index.html` for `ov-po-payments`, `spm-title`, `po-payments-tab`, or any `spm-*` id introduced in §4.4 below.

### 4.2 `openPOPayments(poId, poNum)`

**File:** immediately after `openPayments()` (`index.html:8157-8162`):

```js
function openPOPayments(poId, poNum) {
  var title = G('spm-title');
  if (title) title.textContent = 'Supplier Payments — ' + poNum;
  renderPOPaymentsTab(poId);
  G('ov-po-payments').style.display = 'flex';
}
```

### 4.3 Trigger button on the PO list

**File:** `index.html:6848-6852` (inside `rPO()`):

```diff
       '<td style="white-space:nowrap;">' +
         '<button class="ab" onclick="editPO(\'' + po.id + '\')">&#9998;</button>' +
+        '<button class="ab" onclick="openPOPayments(\'' + po.id + '\',\'' + po.num + '\')" title="Supplier Payments" style="color:var(--gn);">$</button>' +
         '<button class="ab" onclick="prevPOId(\'' + po.id + '\')" style="color:var(--bl);">&#128065;</button>' +
         '<button class="ab" onclick="delPO(\'' + po.id + '\')">&#10005;</button>' +
       '</td></tr>';
```

### 4.4 `renderPOPaymentsTab(poId)`

**File:** immediately after `deleteSupPayment()` (§3 above), mirroring `renderPaymentsTab()` (`index.html:11334-11392`) with `purpose` added as an extra column and form field, and GBP-equivalent shown per row (§2's `rateLock.gbpEquiv`, never recomputed):

```js
function renderPOPaymentsTab(poId) {
  var container = G('po-payments-tab');
  if (!container) return;
  var payments = getPOPayments(poId);
  var totalPaidGBP = getPOTotalPaid(poId);

  var html = '<div style="margin-bottom:12px;display:flex;gap:16px;padding:10px 12px;background:var(--bg);">' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Total Paid (GBP equiv.)</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;color:var(--gn);">' + fmt(totalPaidGBP,'GBP') + '</div></div>' +
    '</div>';

  if (payments.length) {
    html += '<table class="tbl"><thead><tr>' +
      '<th>Date</th><th>Amount</th><th>GBP Equiv.</th><th>Purpose</th><th>Method</th><th>Reference</th><th>Notes</th><th></th>' +
      '</tr></thead><tbody>';
    payments.forEach(function(pm) {
      html += '<tr>' +
        '<td style="white-space:nowrap;">' + san(pm.date||'-') + '</td>' +
        '<td class="num" style="color:var(--gn);font-weight:600;">' + fmt(pm.amount, pm.currency) + '</td>' +
        '<td class="num" style="color:var(--m);">' + fmt((pm.rateLock&&pm.rateLock.gbpEquiv)||0,'GBP') + '</td>' +
        '<td>' + san(pm.purpose||'-') + '</td>' +
        '<td>' + san(pm.method||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.reference||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.notes||'-') + '</td>' +
        '<td><button class="btn btn-g" style="font-size:.5rem;padding:2px 7px;" onclick="deleteSupPayment(\'' + pm.id + '\')">×</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<div class="empty"><div class="ei">💳</div><p>No supplier payments recorded yet.</p></div>';
  }

  html += '<div style="margin-top:12px;padding:12px;background:var(--bg);border-top:2px solid var(--gold);">' +
    '<div style="font-size:.56rem;font-weight:600;color:var(--ink);margin-bottom:8px;letter-spacing:.06em;">RECORD SUPPLIER PAYMENT</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;">' +
    '<div class="fld"><label>Date</label><input type="date" id="spm-date" value="' + today() + '"></div>' +
    '<div class="fld"><label>Amount</label><input type="number" id="spm-amount" placeholder="0.00" step="0.01" style="border-bottom-color:var(--gn);"></div>' +
    '<div class="fld"><label>Currency</label><select id="spm-cur">' +
    ['USD','GBP','RMB','BBD'].map(function(c){ return '<option>' + c + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="fld"><label>Purpose</label><select id="spm-purpose"><option value="">Select...</option><option>Deposit</option><option>Balance</option><option>Other</option></select></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">' +
    '<div class="fld"><label>Method</label><select id="spm-method">' +
    PAYMENT_METHODS.map(function(m){ return '<option>' + m + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="fld"><label>Reference / Transaction ID</label><input type="text" id="spm-ref" placeholder="Bank ref, transaction ID..."></div>' +
    '<div class="fld"><label>Notes</label><input type="text" id="spm-notes" placeholder="Optional notes..."></div>' +
    '</div>' +
    '<button class="btn btn-s" style="margin-top:10px;" onclick="addSupPaymentFromForm(\'' + poId + '\')">✓ Save Payment</button>' +
    '</div>';

  container.innerHTML = html;
}

function addSupPaymentFromForm(poId) {
  var date = G('spm-date') ? G('spm-date').value : today();
  var amount = G('spm-amount') ? +G('spm-amount').value : 0;
  var currency = G('spm-cur') ? G('spm-cur').value : 'USD';
  var purpose = G('spm-purpose') ? G('spm-purpose').value : '';
  var method = G('spm-method') ? G('spm-method').value : 'Bank Transfer';
  var ref = G('spm-ref') ? G('spm-ref').value.trim() : '';
  var notes = G('spm-notes') ? G('spm-notes').value.trim() : '';

  if (!vSupPay(date, amount, purpose)) return;

  var po = DB.po.find(function(p){ return p.id === poId; });
  var pm = {
    id: uid(),
    poId: poId,
    poNum: po ? po.num : '',
    date: date,
    amount: amount,
    currency: currency,
    purpose: purpose,
    method: method,
    reference: ref,
    notes: notes,
    rateLock: lockFxRate(amount, currency),
    type: 'supplier_payment',
    creAt: new Date().toISOString()
  };

  saveSupPayment(pm);
  renderPOPaymentsTab(poId);
}
```

`fmt(amount, cur)` is the existing, already-used currency-formatting helper (used throughout `rPO()`/`renderPaymentsTab()` etc.) — no new formatting function is introduced.

---

## 5. PO deletion/edit — no change required (REQ-INTEG-002f)

No diff in this section. `delPO()` (`index.html:6855-6862`) is unchanged — per REQ-INTEG-002f, orphaning `DB.supPayments` records on PO deletion is the intended, precedent-matching behavior, not a defect to guard against. `savePO()` (`index.html:6819-6829`) is unchanged — `poNum` staleness on existing Supplier Payment records after a PO rename is the intended, precedent-matching characteristic (matches buyer Payments' `invNum` staleness exactly, per REQ-INTEG-002a).

---

## 6. FM-1 / sync-mapping confirmation (REQ-INTEG-002g)

No change to `FIELD_MAPS` (`index.html:3879-3889`), `mapRec()`, `unmapRec()`, `apps-script/Code.gs`, `syncAll()`'s entity list (`index.html:3942`), `pullAll()`'s `simpleEnts`/`idKeyedEnts` (`index.html:4054-4055`, `4061`), or `pushAll()`'s `ents` (`index.html:4136`). `supPayments` is genuinely local-only, matching the true no-sync precedent (`ord`/`buy`) confirmed in `REQ-INTEG-002-v2.md` §1.1/§7 (B-1). The only places `supPayments` is touched outside its own dedicated functions are `saveAll()` and the local JSON backup/restore path (`expAll()`/`doImport()`, §1 above) — both are local `localStorage`/file-based persistence, entirely unrelated to Sheets sync, and every other entity array (including the genuinely-unsynced `ord`/`buy`) is already handled by both for the same reason.

---

## 7. Test plan (maps to `docs/REQ-INTEG-002-v2.md` §3)

- **AC-1** — call `addSupPaymentFromForm(poId)` with valid mocked form fields, assert `DB.supPayments[0]` has `poId`/`poNum` correctly set and a `rateLock` object present.
- **AC-2** — set `ctx.QR.fxGBPRMB = 9.20` (or confirm default), call `lockFxRate(920, 'RMB')` directly, assert `ratesUsed` deep-equals `{ fxGBPRMB: 9.20 }` and `gbpEquiv === 100`.
- **AC-3** — save a payment, capture its `rateLock`, mutate `ctx.QR.fxGBPRMB` to a different value, re-fetch the same record from `DB.supPayments`, assert `rateLock` is byte-identical to what was captured at save time.
- **AC-4** — build 3 `DB.supPayments` records for one `poId` with `rateLock.gbpEquiv` values e.g. `10, 20, 30` (RMB/USD/GBP native currencies, values irrelevant to the sum itself since `getPOTotalPaid()` only reads the pre-computed `gbpEquiv`), assert `getPOTotalPaid(poId) === 60`.
- **AC-4b** — call `lockFxRate(50, 'GBP')` directly, assert `ratesUsed` deep-equals `{}` and `gbpEquiv === 50`.
- **AC-5** — call `vSupPay('2026-01-01', 100, '')` directly, assert it returns `false` and a toast fires naming Purpose.
- **AC-6** — inspect `addSupPaymentFromForm()`'s signature and `openPOPayments()`'s call site: no code path constructs a Supplier Payment without a `poId` already known at call time — assert this by confirming `renderPOPaymentsTab()`'s "RECORD SUPPLIER PAYMENT" form's save button always calls `addSupPaymentFromForm(poId)` with the modal's bound `poId`, never a blank one.
- **AC-7** — build a PO with 2 linked `DB.supPayments` records, call `delPO(po.id)` (with `ctx.confirm` stubbed `true`), assert the PO is removed from `DB.po` and both Supplier Payment records remain in `DB.supPayments` unchanged.
- **AC-8** — build a PO with 1 linked Supplier Payment record, edit and re-save the PO with a new `num` via `savePO()`, assert the existing Supplier Payment record's `poId` still matches and its `poNum` is unchanged (still the old number).
- **AC-9** — full-suite regression covers this: no test targeting `saveInv()`'s or `savePayment()`'s `fpmRecovered` blocks should change behavior.
- **AC-10** — full suite re-run, confirm the pre-existing count (re-verify at build time, do not hardcode `563`) plus all new tests pass.
- **AC-11** — build a PO with 2 Supplier Payment records (different currencies/purposes), call `renderPOPaymentsTab(poId)`, assert the resulting `po-payments-tab` HTML contains each record's date, native amount+currency, GBP-equivalent, and purpose text.
- **AC-12** — corrected test design from v1 (see §8, B-3). Two checks: (a) `ctx.FIELD_MAPS.hasOwnProperty('supPayments')` is `false`; (b) for each of the three bulk-sync entity-list arrays, extract the array literal directly by variable name via an anchored regex against `tests/run.js`'s own `html` variable (the raw source, loaded via `fs.readFileSync`, `tests/run.js:94`) — `/var\s+synEnts\s*=\s*\[([^\]]*)\]/` for `syncAll()`'s list (`index.html:3942`), `/var\s+simpleEnts\s*=\s*\[([^\]]*)\]/` and `/var\s+idKeyedEnts\s*=\s*\[([^\]]*)\]/` for `pullAll()`'s lists (`index.html:4055`, `4061`), and `/var\s+ents\s*=\s*\[([^\]]*)\]/` for `pushAll()`'s list (`index.html:4136`) — then assert none of the four captured groups contain the substring `supPayments`. This is unambiguous and doesn't depend on any new test-harness helper. (A naive whole-file `html.includes('supPayments')` was v1's proposal and is explicitly rejected — it would always return `true` once the feature is built, since `supPayments` legitimately appears elsewhere in the file, e.g. `saveAll()`.) **New AC-13** below separately covers `expAll()`/`doImport()`.
- **AC-13** (new in v2 — covers B-1) — call `expAll()`-equivalent snapshot construction (or directly inspect that `DB.supPayments` is included in the object `expAll()` builds) with at least one `DB.supPayments` record present, assert the record round-trips: build a backup-shaped object containing a `supPayments` array, run it through `doImport()`'s restore logic (or the equivalent `if (data.supPayments...)` branch directly), assert `DB.supPayments` matches the imported array afterward.

---

## 8. Spec-gate review resolution log (v1 → v2)

An independent spec-gate review of v1 returned **CONDITIONAL PASS** with 3 blocking findings and 3 advisory findings, all addressed in this v2:

- **B-1 (blocking):** v1 never extended `expAll()`'s backup snapshot or `doImport()`'s restore logic to include `supPayments`, unlike the precedent set by both `buy` and `ord` when they were added. Since this entity has no Sheets-sync path at all (by design, REQ-INTEG-002g), the JSON backup file is its *only* portable backup — worse off than any other entity in the app. As specified, a device migration or storage-clear would have silently destroyed every Supplier Payment record. **Fixed:** §1 adds the missing `expAll()`/`doImport()` diffs, mirroring the exact `buy`/`ord` pattern; new AC-13 tests the round-trip.
- **B-2 (blocking):** `saveAll()` was mis-cited as `index.html:3313`, which is actually a line inside the unrelated `sv()` function; the real `saveAll()` definition is at `3322`. **Fixed:** citation corrected throughout §1.
- **B-3 (blocking):** v1's AC-12(b) test design ("a regex/substring check confirming `'supPayments'` does not appear anywhere inside those three function bodies") specified no mechanism for isolating the three function bodies from the rest of an ~11,700-line file, and a naive whole-file substring check would immediately false-fail once the feature ships (since `supPayments` legitimately appears elsewhere, e.g. `saveAll()`). **Fixed:** §7's AC-12 now specifies four precise, anchored regexes extracting each named array literal by variable name and location, with no ambiguity about what's being tested.
- **A-1 (advisory):** §1's prose read as an unedited correction-in-place ("...is not added to `saveAll()`... — wait, it **is** added there...") and pointed to the wrong section (§7 instead of §6) for the local-persistence-vs-sync distinction. **Fixed:** reworded cleanly, corrected cross-reference to §6.
- **A-2 (advisory):** `loadDemoData()`/`clearDemoData()` (`index.html:4335`, `4442-4451`) are not extended to cover the new entity, a class of gap previously found and fixed for `ord`/`li` in this same codebase (v2.9.61). **Fixed:** §1 now explicitly discloses this as a non-issue for this phase (no demo records are added) with a note for whoever adds Demo Mode coverage in a future phase.
- **A-3 (advisory):** v1's framing of `vSupPay()`'s omissions didn't distinguish that `vPay()`'s two date-adjacent checks are of different severity (one blocks the save, one is a non-blocking warning). **Fixed:** §3 now states both explicitly and confirms omitting both is still within REQ-INTEG-002's actual acceptance criteria (only `purpose` is required, per AC-5).
