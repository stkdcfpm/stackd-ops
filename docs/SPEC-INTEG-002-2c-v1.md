# SPEC-INTEG-002-2c — Buyer payment tranches

**Status:** v1. Implements `docs/REQ-INTEG-002-2c-v1.md` (requirements-gate: 11 rounds, round 11 **PASS**, clean). Structural/depth template: `docs/SPEC-INTEG-002-2b-v4.md` (the immediately-prior sub-phase, explicitly cited by the REQ as its own precedent for the `invId`/`invNum`-preference pattern). **Spec-gate round 1: CONDITIONAL PASS — 1 blocking, 2 advisory, fixed in place.** The reviewer actually applied all 12 code diffs and all 31 §13 tests to a scratch worktree and ran the real suite (baseline 775/775 → 775/775 after code diffs alone, zero regressions → 806/806 after fixing the 2 failing tests below). Blocking: 2 of the 31 new tests (`renderStatement()` AC-5, `renderPaymentsTab()` AC-8a) asserted a hardcoded `.toFixed(2)`-style substring (`'600.00'`/`'100.00'`) the pre-existing zero-decimal `fmt()` helper can never produce — fixed to `'$600'`/`'£100'` in §13; confirmed by the reviewer's own experiment that this alone (no code-diff change) yields 806/806. Advisory: §17's test-count self-inconsistency ("29"/"804/804" vs. §13's actual 31 tests) corrected to 31/806/806; the tracker row-append-vs-new-row judgment call (§15) confirmed and settled in the SPEC's favor. **Spec-gate round 2: PASS — clean.** Independently redid the entire verification from scratch with no memory of round 1's own investigation: applied all 12 diffs and 31 tests by hand, confirmed 775/775 baseline → 806/806 final, all 31 new tests individually confirmed passing; independently verified `fmt(600,'USD')==='$600'`/`fmt(100,'GBP')==='£100'` by running the actual `Intl.NumberFormat` call in plain Node, not by trusting round 1's claim; traced both fixtures end-to-end through their real code paths to confirm the corrected assertions are factually right, not just self-consistent; re-verified §17/§15's internal consistency and 10 further citations, all clean. One trivial, non-blocking documentation inaccuracy found and fixed directly in §13 (a stale "before CN Modal Separation" placement note — that section is actually earlier in `tests/run.js`, unrelated to this insertion point; zero functional effect, confirmed the actual named insertion point works correctly). Ready for implementation.
**Build baseline:** `claude/integ-002-2c-buyer-payments` @ `e0dcd2c`, 775/775 tests passing. Every code citation in this SPEC was independently re-verified against this exact commit (see the note at the end of each section; no citation drift found — see the "Citation accuracy" summary at the end of this document).

---

## 0. Summary of changes

1. `getInvPayments(invId)` → `getInvPayments(inv)` — the matching-rule rewrite REQ §2c-c specifies verbatim (`invId` authoritative when it resolves to a current invoice; `invNum` consulted only when `invId` is blank/dangling).
2. `getInvTotalPaid(invId)` is **removed** and replaced by two new functions, `getInvTotalPaidNative(inv)`/`getInvEffectiveDepInfo(inv)`, mirroring `getPOTotalPaidNative(po)`/`getPOEffectiveDepInfo(po)`'s contracts with one deliberate difference (the legacy-currency default is `inv.cur`, not `'USD', per REQ §1.2/B1).
3. Seven consumer sites are switched onto the new functions: `cInv()`, `editInv()`, `renderStatement()`, `prevStmtPdf()`, `saveCN()`, `renderPaymentsTab()` (all via `getInvEffectiveDepInfo(inv).value`), and `savePayment()`/`deletePayment()` (direct `getInvTotalPaidNative(inv)` calls, per REQ's explicit exception).
4. `vPay()` gains a `purpose` parameter/check; `addPaymentFromForm()` gains `purpose`/`currency`/`rateLock` on the built record, with the EUR/NGN/GHS invoice-currency gate from REQ §2c-b (AC-2a).
5. `deletePayment()` gains the narrow backward status re-derivation from REQ §2c-d (AC-6).
6. `renderPaymentsTab()` gets the three REQ §2c-e changes: summary box via `getInvEffectiveDepInfo`, per-row resolved-currency Amount column, and a conditionally-shown Purpose/Currency/GBP-equivalent column set.
7. `acctPmtCSV()`/`acctFACSV()` repoint their Currency column to `pm.currency` (fallback `inv.cur`) and gain a Purpose column; `_aiExecTool('get_payments')` gains `purpose`/`currency` fields. `acctPmtJSON()` needs no change (confirmed, REQ §2c-f).
8. Tests, `docs/known-gaps.md`, `docs/requirements-tracker.md`, `docs/version-history.md`, `STACKD_CONTEXT.md`, `CLAUDE.md`, `docs/user-guide.md` — all per REQ §7.

**Not touched:** `Invoice.pos[]`/`getInvoicePOs()`, the FPM-funded-deposit auto-recovery block's trigger condition/Cloud-Data branch (REQ §1.5, AC-7), `getPOTotalPaidNative`/`getPOEffectiveDepInfo` (PO side, deliberately left alone per REQ §2c-c), `acctPmtCSV`/`acctFACSV`'s own invoice-resolution mechanism (still `DB.inv.find(i.id===pm.invId)`, no `invNum` fallback — pre-existing, out of scope, REQ round-11 observation, restated in §8 below).

---

## 1. `getInvPayments(inv)` — matching-rule rewrite

Current (`index.html:13021-13028`):
```js
function getInvPayments(invId) {
  return DB.payments.filter(function(p){ return p.invId === invId; })
    .sort(function(a,b){ return a.date < b.date ? -1 : 1; });
}

function getInvTotalPaid(invId) {
  return getInvPayments(invId).reduce(function(s,p){ return s + (+p.amount||0); }, 0);
}
```
becomes:
```js
function getInvPayments(inv) {
  return DB.payments.filter(function(p){
    var idResolves = p.invId && DB.inv.some(function(i){ return i.id === p.invId; });
    if (idResolves) return p.invId === inv.id;
    return p.invNum === inv.num;
  }).sort(function(a,b){ return a.date < b.date ? -1 : 1; });
}

// Currencies getInvTotalPaidNative()/getInvEffectiveDepInfo() below can safely reconcile
// an invoice's ledger against. Reuses the PO-side allow-list as-is (REQ §1.2) — an
// invoice in any OTHER currency (today, EUR/NGN/GHS via if-cur) falls back to the legacy
// inv.dep figure rather than risk a silently wrong/mislabeled conversion.
//
// Sums an invoice's linked buyer payment records DENOMINATED IN THE INVOICE'S OWN
// CURRENCY (inv.cur), not GBP. Unlike getPOTotalPaidNative(), the unsupported-currency
// gate lives INSIDE this function (not only in getInvEffectiveDepInfo() below) because
// savePayment()/deletePayment() call this function directly, bypassing the outer gate —
// see REQ §2c-c / round-3 finding B3-follow-up-2.
function getInvTotalPaidNative(inv) {
  var invCur = (inv.cur || 'USD').toUpperCase();
  if (invCur === 'CNY') invCur = 'RMB';
  var supported = PO_DEP_RECONCILE_CURS.indexOf(invCur) !== -1;
  return getInvPayments(inv).reduce(function(sum, p) {
    if (!supported) {
      // Unsupported invoice currency (EUR/NGN/GHS): every payment against it carries
      // this same currency by construction (REQ §2c-b/AC-2a) — sum raw, never pivot.
      return sum + (+p.amount || 0);
    }
    // Legacy record with no currency field at all: read as paid in the invoice's own
    // currency (REQ §1.2/B1) — NEVER defaulted to 'USD' like getPOTotalPaidNative()
    // does, since DB.supPayments was always currency-aware but DB.payments has years
    // of real pre-this-REQ records with no currency field, in every invoice currency.
    var pCur = (p.currency || invCur).toUpperCase();
    if (pCur === 'CNY') pCur = 'RMB';
    if (pCur === invCur) {
      return sum + (+p.amount || 0);
    }
    var gbp = (p.rateLock && p.rateLock.gbpEquiv) || 0;
    var ratesUsed = (p.rateLock && p.rateLock.ratesUsed) || {};
    return sum + fromGBPLocked(gbp, inv.cur, ratesUsed);
  }, 0);
}

// Single point of truth for "what should this invoice's paid-to-date figure show."
// Returns { value, source } — mirrors getPOEffectiveDepInfo()'s contract exactly.
//   'ledger'                      — reconciled from DB.payments via getInvTotalPaidNative()
//   'legacy-no-records'           — no payment records exist yet; raw inv.dep
//   'legacy-unsupported-currency' — records exist, but inv.cur isn't in PO_DEP_RECONCILE_CURS; raw inv.dep
// Never mutates inv.dep. Safe to call from any read-only render context.
function getInvEffectiveDepInfo(inv) {
  var payments = getInvPayments(inv);
  if (!payments.length) {
    return { value: +inv.dep || 0, source: 'legacy-no-records' };
  }
  var invCur = (inv.cur || 'USD').toUpperCase();
  if (invCur === 'CNY') invCur = 'RMB';
  if (PO_DEP_RECONCILE_CURS.indexOf(invCur) === -1) {
    return { value: +inv.dep || 0, source: 'legacy-unsupported-currency' };
  }
  return { value: getInvTotalPaidNative(inv), source: 'ledger' };
}
```

**Notes:**
- `PO_DEP_RECONCILE_CURS` (`index.html:13219`, `['USD','GBP','RMB','CNY','BBD']`) is a top-level `var`, textually defined later in the file (line 13219) than this new code (line ~13026). This is not a forward-reference bug: `getInvTotalPaidNative`/`getInvEffectiveDepInfo` are plain `function` declarations (hoisted), and by the time either is actually *called* (only ever from later user/render-triggered code, never during the top-level script's own synchronous run), every top-level `var` has already been assigned. This is the identical situation `getPOTotalPaidNative`/`getPOEffectiveDepInfo` are already in relative to their own later-file callers, so it carries no new risk.
- **Placement judgment call (not dictated by the REQ):** the REQ specifies the new functions' signatures/contracts but not where in the file they live. This SPEC places them immediately after `getInvPayments(inv)` — i.e., exactly where `getInvTotalPaid(invId)` used to be — grouping "invoice payment ledger" logic together, the same way the PO-side trio (`getPOPayments`/`getPOTotalPaidNative`/`getPOEffectiveDepInfo`) is grouped later in the file. An equally defensible alternative is placing them adjacent to the PO-side functions instead (since `getInvTotalPaidNative` reuses `PO_DEP_RECONCILE_CURS`/`fromGBPLocked` from that neighborhood). **Flagged for spec-gate**, though it has zero behavioral effect either way.
- `getInvTotalPaid(invId)` is deleted outright, not kept as a compatibility shim — confirmed via repo-wide grep that no call site outside the ones this SPEC updates exists anywhere, including `tests/run.js`/`tests/fixtures.js` (REQ §2c-c, final paragraph).

---

## 2. `vPay()` — `purpose` parameter and check

Current (`index.html:9046-9070`):
```js
function vPay(date, amount, invId) {
  var dateEl = G('pm-date'), amtEl = G('pm-amount');
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
  if (new Date(date) > new Date(today() + 'T23:59:59')) {
    toast('⚠ Payment date is in the future — please confirm'); return false;
  }
  var inv = invId ? DB.inv.find(function(i){ return i.id===invId; }) : null;
  if (inv && inv.date && new Date(date) < new Date(inv.date)) {
    toast('⚠ Payment date is before invoice date (' + inv.date + ') — please confirm');
  }
  if (dateEl) dateEl.style.borderBottomColor='var(--gn)';
  return true;
}
```
becomes:
```js
function vPay(date, amount, invId, purpose) {
  var dateEl = G('pm-date'), amtEl = G('pm-amount');
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
  if (new Date(date) > new Date(today() + 'T23:59:59')) {
    toast('⚠ Payment date is in the future — please confirm'); return false;
  }
  var inv = invId ? DB.inv.find(function(i){ return i.id===invId; }) : null;
  if (inv && inv.date && new Date(date) < new Date(inv.date)) {
    toast('⚠ Payment date is before invoice date (' + inv.date + ') — please confirm');
  }
  if (dateEl) dateEl.style.borderBottomColor='var(--gn)';
  if (!purpose) {
    toast('⚠ Purpose is required'); return false;
  }
  return true;
}
```
Mirrors `vSupPay()`'s own purpose check (`index.html:13284-13286`) exactly, placed last, after every date-related check — matching `vSupPay()`'s own check order (amount → currency-format → date → purpose).

---

## 3. `renderPaymentsTab(invId)` — three changes (REQ §2c-e)

Current (`index.html:13112-13204`, includes `addPaymentFromForm` since both need to change together):
```js
function renderPaymentsTab(invId) {
  var container = G('payments-tab');
  if (!container) return;
  var payments = getInvPayments(invId);
  var inv = DB.inv.find(function(i){ return i.id === invId; });
  var grand = inv ? (+inv.calc_grandTotal || cInv(inv).grand) : 0;
  var totalPaid = payments.reduce(function(s,p){ return s+(+p.amount||0); }, 0);
  var balance = grand - totalPaid;
  var cur = inv ? inv.cur : 'USD';

  var html = '<div style="margin-bottom:12px;display:flex;gap:16px;padding:10px 12px;background:var(--bg);">' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Invoice Total</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;">' + fmt(grand,cur) + '</div></div>' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Total Received</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;color:var(--gn);">' + fmt(totalPaid,cur) + '</div></div>' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Balance Due</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;color:' + (balance>0?'var(--cr)':'var(--gn)') + ';">' +
    (balance > 0 ? fmt(balance,cur) : '✓ Settled') + '</div></div>' +
    '<div style="margin-left:auto;align-self:center;"><button class="btn btn-g" style="font-size:.5rem;" onclick="openAcctExport(\'pmt\')">&#8595; Export</button></div>' +
    '</div>';

  if (payments.length) {
    html += '<table class="tbl"><thead><tr>' +
      '<th>Date</th><th>Amount</th><th>Method</th><th>Reference</th><th>Notes</th><th></th>' +
      '</tr></thead><tbody>';
    payments.forEach(function(pm) {
      html += '<tr>' +
        '<td style="white-space:nowrap;">' + san(pm.date||'-') + '</td>' +
        '<td class="num" style="color:var(--gn);font-weight:600;">' + fmt(pm.amount,cur) + '</td>' +
        '<td>' + san(pm.method||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.reference||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.notes||'-') + '</td>' +
        '<td><button class="btn btn-g" style="font-size:.5rem;padding:2px 7px;" onclick="deletePayment(\'' + pm.id + '\')">×</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<div class="empty"><div class="ei">💳</div><p>No payments recorded yet.</p></div>';
  }

  // Add payment form
  html += '<div style="margin-top:12px;padding:12px;background:var(--bg);border-top:2px solid var(--gold);">' +
    '<div style="font-size:.56rem;font-weight:600;color:var(--ink);margin-bottom:8px;letter-spacing:.06em;">RECORD PAYMENT</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
    '<div class="fld"><label>Date</label><input type="date" id="pm-date" value="' + today() + '"></div>' +
    '<div class="fld"><label>Amount</label><input type="number" id="pm-amount" placeholder="0.00" step="0.01" style="border-bottom-color:var(--gn);"></div>' +
    '<div class="fld"><label>Method</label><select id="pm-method">' +
    PAYMENT_METHODS.map(function(m){ return '<option>' + m + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">' +
    '<div class="fld"><label>Reference / Transaction ID</label><input type="text" id="pm-ref" placeholder="Bank ref, transaction ID..."></div>' +
    '<div class="fld"><label>Notes</label><input type="text" id="pm-notes" placeholder="Optional notes..."></div>' +
    '</div>' +
    '<button class="btn btn-s" style="margin-top:10px;" onclick="addPaymentFromForm(\'' + invId + '\')">✓ Save Payment</button>' +
    '</div>';

  container.innerHTML = html;
}

function addPaymentFromForm(invId) {
  var date = G('pm-date') ? G('pm-date').value : today();
  var amount = G('pm-amount') ? +G('pm-amount').value : 0;
  var method = G('pm-method') ? G('pm-method').value : 'Bank Transfer';
  var ref = G('pm-ref') ? G('pm-ref').value.trim() : '';
  var notes = G('pm-notes') ? G('pm-notes').value.trim() : '';

  if (!vPay(date, amount, invId)) return;

  var inv = DB.inv.find(function(i){ return i.id === invId; });
  var pm = {
    id: uid(),
    invId: invId,
    invNum: inv ? inv.num : '',
    date: date,
    amount: amount,
    method: method,
    reference: ref,
    notes: notes,
    type: 'buyer_payment',
    creAt: new Date().toISOString()
  };

  savePayment(pm);
  renderPaymentsTab(invId);

  // Clear form
  if (G('pm-amount')) G('pm-amount').value = '';
  if (G('pm-ref')) G('pm-ref').value = '';
  if (G('pm-notes')) G('pm-notes').value = '';

  toast('✓ Payment of ' + fmt(amount, inv ? inv.cur : 'USD') + ' recorded');
}
```
becomes:
```js
function renderPaymentsTab(invId) {
  var container = G('payments-tab');
  if (!container) return;
  var inv = DB.inv.find(function(i){ return i.id === invId; });
  var payments = getInvPayments(inv || { id: invId, num: '' });
  var grand = inv ? (+inv.calc_grandTotal || cInv(inv).grand) : 0;
  var totalPaid = inv ? getInvEffectiveDepInfo(inv).value : 0;
  var balance = grand - totalPaid;
  var cur = inv ? inv.cur : 'USD';

  // Currency/GBP-equivalent columns appear only when at least one row's resolved
  // effective currency (pm.currency||inv.cur) differs from the invoice's own — an
  // all-same-currency invoice's table stays as uncluttered as it is today (REQ §2c-e.3).
  var showCurCols = inv ? payments.some(function(pm){ return (pm.currency || cur) !== cur; }) : false;

  var invCurUC = (cur || 'USD').toUpperCase();
  var pmCurOpts = ['USD','GBP','RMB','BBD'];
  var pmCurDefault = pmCurOpts.indexOf(invCurUC) !== -1 ? invCurUC : pmCurOpts[0];
  var pmCurNorm = invCurUC === 'CNY' ? 'RMB' : invCurUC;
  var pmCurUnsupported = PO_DEP_RECONCILE_CURS.indexOf(pmCurNorm) === -1;

  var html = '<div style="margin-bottom:12px;display:flex;gap:16px;padding:10px 12px;background:var(--bg);">' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Invoice Total</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;">' + fmt(grand,cur) + '</div></div>' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Total Received</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;color:var(--gn);">' + fmt(totalPaid,cur) + '</div></div>' +
    '<div><div style="font-size:.46rem;letter-spacing:.1em;text-transform:uppercase;color:var(--m);">Balance Due</div>' +
    '<div style="font-family:Bebas Neue,sans-serif;font-size:1.1rem;color:' + (balance>0?'var(--cr)':'var(--gn)') + ';">' +
    (balance > 0 ? fmt(balance,cur) : '✓ Settled') + '</div></div>' +
    '<div style="margin-left:auto;align-self:center;"><button class="btn btn-g" style="font-size:.5rem;" onclick="openAcctExport(\'pmt\')">&#8595; Export</button></div>' +
    '</div>';

  if (payments.length) {
    html += '<table class="tbl"><thead><tr>' +
      '<th>Date</th><th>Amount</th><th>Purpose</th>' +
      (showCurCols ? '<th>Currency</th><th>GBP Equiv.</th>' : '') +
      '<th>Method</th><th>Reference</th><th>Notes</th><th></th>' +
      '</tr></thead><tbody>';
    payments.forEach(function(pm) {
      var pmCur = pm.currency || cur;
      html += '<tr>' +
        '<td style="white-space:nowrap;">' + san(pm.date||'-') + '</td>' +
        '<td class="num" style="color:var(--gn);font-weight:600;">' + fmt(pm.amount,pmCur) + '</td>' +
        '<td>' + san(pm.purpose||'-') + '</td>' +
        (showCurCols ? (
          '<td>' + san(pmCur) + '</td>' +
          '<td class="num" style="color:var(--m);">' + fmt((pm.rateLock&&pm.rateLock.gbpEquiv)||toGBP(pm.amount,pmCur),'GBP') + '</td>'
        ) : '') +
        '<td>' + san(pm.method||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.reference||'-') + '</td>' +
        '<td style="font-size:.54rem;color:var(--m);">' + san(pm.notes||'-') + '</td>' +
        '<td><button class="btn btn-g" style="font-size:.5rem;padding:2px 7px;" onclick="deletePayment(\'' + pm.id + '\')">×</button></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<div class="empty"><div class="ei">💳</div><p>No payments recorded yet.</p></div>';
  }

  // Add payment form
  html += '<div style="margin-top:12px;padding:12px;background:var(--bg);border-top:2px solid var(--gold);">' +
    '<div style="font-size:.56rem;font-weight:600;color:var(--ink);margin-bottom:8px;letter-spacing:.06em;">RECORD PAYMENT</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
    '<div class="fld"><label>Date</label><input type="date" id="pm-date" value="' + today() + '"></div>' +
    '<div class="fld"><label>Amount</label><input type="number" id="pm-amount" placeholder="0.00" step="0.01" style="border-bottom-color:var(--gn);"></div>' +
    '<div class="fld"><label>Method</label><select id="pm-method">' +
    PAYMENT_METHODS.map(function(m){ return '<option>' + m + '</option>'; }).join('') +
    '</select></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;">' +
    '<div class="fld"><label>Currency</label><select id="pm-cur"' + (pmCurUnsupported ? ' disabled' : '') + '>' +
    pmCurOpts.map(function(c){ return '<option' + (c===pmCurDefault?' selected':'') + '>' + c + '</option>'; }).join('') +
    '</select></div>' +
    '<div class="fld"><label>Purpose</label><select id="pm-purpose"><option value="">Select...</option><option>Deposit</option><option>Balance</option><option>Other</option></select></div>' +
    '<div></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">' +
    '<div class="fld"><label>Reference / Transaction ID</label><input type="text" id="pm-ref" placeholder="Bank ref, transaction ID..."></div>' +
    '<div class="fld"><label>Notes</label><input type="text" id="pm-notes" placeholder="Optional notes..."></div>' +
    '</div>' +
    '<button class="btn btn-s" style="margin-top:10px;" onclick="addPaymentFromForm(\'' + invId + '\')">✓ Save Payment</button>' +
    '</div>';

  container.innerHTML = html;
}

function addPaymentFromForm(invId) {
  var date = G('pm-date') ? G('pm-date').value : today();
  var amount = G('pm-amount') ? +G('pm-amount').value : 0;
  var method = G('pm-method') ? G('pm-method').value : 'Bank Transfer';
  var purpose = G('pm-purpose') ? G('pm-purpose').value : '';
  var ref = G('pm-ref') ? G('pm-ref').value.trim() : '';
  var notes = G('pm-notes') ? G('pm-notes').value.trim() : '';

  if (!vPay(date, amount, invId, purpose)) return;

  var inv = DB.inv.find(function(i){ return i.id === invId; });
  var invCurUC = (inv && inv.cur || 'USD').toUpperCase();
  var invCurNorm = invCurUC === 'CNY' ? 'RMB' : invCurUC;
  var curSupported = PO_DEP_RECONCILE_CURS.indexOf(invCurNorm) !== -1;
  var currency, rateLock;
  if (curSupported) {
    currency = G('pm-cur') ? G('pm-cur').value : invCurUC;
    rateLock = lockFxRate(amount, currency);
  } else {
    // Invoice currency isn't one lockFxRate()/toGBP() can meaningfully pivot (EUR/NGN/GHS)
    // — every payment against it carries inv.cur itself, true by construction, never a
    // substitute currency from the pm-cur list (REQ §2c-b, AC-2a).
    currency = inv ? inv.cur : 'USD';
    rateLock = null;
  }

  var pm = {
    id: uid(),
    invId: invId,
    invNum: inv ? inv.num : '',
    date: date,
    amount: amount,
    method: method,
    purpose: purpose,
    currency: currency,
    rateLock: rateLock,
    reference: ref,
    notes: notes,
    type: 'buyer_payment',
    creAt: new Date().toISOString()
  };

  savePayment(pm);
  renderPaymentsTab(invId);

  // Clear form
  if (G('pm-amount')) G('pm-amount').value = '';
  if (G('pm-ref')) G('pm-ref').value = '';
  if (G('pm-notes')) G('pm-notes').value = '';
  if (G('pm-purpose')) G('pm-purpose').value = '';

  toast('✓ Payment of ' + fmt(amount, currency) + ' recorded');
}
```

**Notes / judgment calls:**
- `rateLock: null` (rather than omitting the key) for the unsupported-currency case — AC-2a only requires "no `rateLock` is generated"; `null` and an omitted key are behaviorally identical everywhere `pm.rateLock && ...` is read (`getInvTotalPaidNative`, the render layer). **Flagged for spec-gate** as a stylistic choice, not a behavioral one.
- The closing toast now reads `fmt(amount, currency)` (the payment's own resolved currency) instead of the old `fmt(amount, inv ? inv.cur : 'USD')`. In the common case (no cross-currency override) these are identical; they only differ for a genuine cross-currency payment, where showing the payment's actual currency is strictly more correct. **Not explicitly dictated by the REQ text — flagged for spec-gate** as a small, low-risk corollary of the currency-awareness theme.
- `renderPaymentsTab(inv || { id: invId, num: '' })` defensively handles a not-found `invId` (should not occur via the real UI, which always opens this tab for an existing invoice) the same way the original code's `cur = inv ? inv.cur : 'USD'` guard did — this fallback object never resolves any real payment (its synthetic `id` cannot equal a stored `p.invId` for a currently-existing invoice, and its blank `num` cannot equal a real `p.invNum`), so it degrades to an empty table, matching prior behavior.

---

## 4. `savePayment()` — switch to `getInvTotalPaidNative(inv)`

Current (`index.html:13030-13041`, only the cited clause changes):
```js
async function savePayment(payment) {
  var existing = DB.payments.findIndex(function(p){ return p.id === payment.id; });
  if (existing >= 0) { DB.payments[existing] = payment; }
  else { DB.payments.push(payment); }
  sv(K.pm, DB.payments);
  audit('SAVE', 'payment', payment.id, payment);
  logEv('payment', payment.id, 'created', 'Payment $' + (+payment.amount||0).toFixed(2) + ' received — ' + (payment.invNum||payment.invId||''), 'operator');

  // Update invoice dep field to match total paid
  var inv = DB.inv.find(function(i){ return i.id === payment.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaid(inv.id);
```
becomes (only the cited line changes; everything else in `savePayment()`, including the FPM-recovery block at `13059-13083`, is byte-for-byte untouched per REQ §1.5/AC-7):
```js
    var totalPaid = getInvTotalPaidNative(inv);
```

---

## 5. `deletePayment()` — switch + status re-derivation (REQ §2c-d, AC-6)

Current (`index.html:13091-13110`):
```js
function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  sv(K.pm, DB.payments);
  audit('DELETE', 'payment', id, pm);

  // Recalculate invoice dep
  var inv = DB.inv.find(function(i){ return i.id === pm.invId; });
  if (inv) {
    inv.dep = getInvTotalPaid(inv.id);
    inv.updAt = new Date().toISOString();
    sv(K.i, DB.inv);
    syncEnt('inv', inv).catch(function(){});
    rInv(); rDash();
  }
  renderPaymentsTab(pm.invId);
}
```
becomes:
```js
function deletePayment(id) {
  var pm = DB.payments.find(function(p){ return p.id === id; });
  if (!pm) return;
  if (!confirm('Delete this payment record?')) return;
  logEv('payment', pm.id, 'deleted', 'Payment deleted — ' + (pm.invNum||pm.invId||''), 'operator');
  DB.payments = DB.payments.filter(function(p){ return p.id !== id; });
  sv(K.pm, DB.payments);
  audit('DELETE', 'payment', id, pm);

  // Recalculate invoice dep
  var inv = DB.inv.find(function(i){ return i.id === pm.invId; });
  if (inv) {
    var totalPaid = getInvTotalPaidNative(inv);
    inv.dep = totalPaid;
    inv.updAt = new Date().toISOString();

    // Re-derive inv.status, narrowly — only when the CURRENT status is one this exact
    // auto-status logic (savePayment()'s own, mirrored here) could itself have produced.
    // Never touch Draft/Pro-forma/Sent/Cancelled (REQ §1.3/§2c-d, AC-6).
    if (inv.status === 'Partially Paid' || inv.status === 'Paid') {
      var grand = Math.round((+inv.calc_grandTotal || cInv(inv).grand) * 100) / 100;
      var paid  = Math.round(totalPaid * 100) / 100;
      if (paid >= grand && grand > 0) {
        inv.status = 'Paid';
      } else if (paid > 0 && paid < grand) {
        inv.status = 'Partially Paid';
      } else {
        inv.status = 'Sent';
      }
    }

    sv(K.i, DB.inv);
    syncEnt('inv', inv).catch(function(){});
    rInv(); rDash();
  }
  renderPaymentsTab(pm.invId);
}
```
Uses the identical grand-total fallback expression `savePayment()` already uses (`(+inv.calc_grandTotal || cInv(inv).grand)`, `index.html:13047`) — REQ §2c-d/B2. `else { inv.status = 'Sent'; }` is the new backward-transition branch `savePayment()` itself never needs (it only ever moves forward from an already-unpaid state) — this is exactly what REQ §2c-d asks for: "When the recomputed total drops to 0, the status reverts to Sent."

---

## 6. `editInv()` — switch line 6822

Current (`index.html:6822`, one clause of a three-clause compound statement — the other two clauses and the surrounding badge/readOnly-toggle code at `6814-6821`/`6823-6826` are untouched, per REQ round-1 B4/A6):
```js
    if (depField) { depField.value = getInvTotalPaid(inv.id).toFixed(2); depField.readOnly = true; depField.style.opacity = '0.6'; }
```
becomes:
```js
    if (depField) { depField.value = getInvEffectiveDepInfo(inv).value.toFixed(2); depField.readOnly = true; depField.style.opacity = '0.6'; }
```

---

## 7. `cInv(inv)` — switch dep computation

Current (`index.html:4763-4768`):
```js
  // Use payment ledger total if payments exist, else use stored dep
  var ledgerTotal = DB.payments
    ? DB.payments.filter(function(p){ return p.invId === inv.id; })
        .reduce(function(s,p){ return s+(+p.amount||0); }, 0)
    : 0;
  var dep = ledgerTotal > 0 ? Math.round(ledgerTotal*100)/100 : (+inv.dep||0);
```
becomes:
```js
  // Use the reconciled payment ledger total if payments exist, else the stored dep —
  // single point of truth shared with editInv()/renderStatement()/prevStmtPdf()/
  // saveCN()/renderPaymentsTab() (REQ-INTEG-002-2c §2c-c/AC-5).
  var dep = getInvEffectiveDepInfo(inv).value;
```

**Judgment call / subtle behavior difference — flagged for spec-gate:** the old code forked on `ledgerTotal > 0` (a payments-*sum* test); the new code forks (inside `getInvEffectiveDepInfo`) on `payments.length` (a payments-*existence* test). These differ only in the pathological case of an invoice whose payment records exist but sum to exactly `0` (e.g., every recorded payment is `0` or a positive/negative pair that cancels) — old code would fall back to raw `inv.dep`; new code returns the ledger's own `0`. This is not a hypothetical the REQ discusses, but it *is* the exact contract `getInvEffectiveDepInfo`/`getPOEffectiveDepInfo` already use everywhere else (`'legacy-no-records'` is defined by REQ §2c-c/AC-4 as "no payments exist," not "payments sum to a non-positive number"), so this SPEC keeps `cInv()` consistent with that established contract rather than inventing a special case for it. No existing fixture in `tests/run.js`/`tests/fixtures.js` has a payment set summing to `≤0` against an invoice also read by `cInv()`, so no existing test's expected value changes — confirmed by direct read of every `ctx.cInv(...)`/`ctx.iCalc(...)` test in the suite.

---

## 8. `renderStatement(buyer)` — switch lines 8099-8100

Current (`index.html:8097-8100`):
```js
  var invRows = invRecs.map(function(inv) {
    var c = iCalc(inv);
    var paid = DB.payments.filter(function(p){ return p.invId===inv.id||p.invNum===inv.num; })
                          .reduce(function(s,p){ return s+(+p.amount||0); }, 0);
```
becomes:
```js
  var invRows = invRecs.map(function(inv) {
    var c = iCalc(inv);
    var paid = getInvEffectiveDepInfo(inv).value;
```
No other line in `renderStatement()` changes — `credits`/`balDue`/`totalGrand`/`totalPaid`/`totalCredits`/`totalOut` are all computed exactly as before, just now fed a currency-correct `paid`.

---

## 9. `prevStmtPdf()` — switch line 8166

Current (`index.html:8164-8166`):
```js
  var invRows = invRecs.map(function(inv){
    var c=iCalc(inv);
    var paid=DB.payments.filter(function(p){return p.invId===inv.id||p.invNum===inv.num;}).reduce(function(s,p){return s+(+p.amount||0);},0);
```
becomes:
```js
  var invRows = invRecs.map(function(inv){
    var c=iCalc(inv);
    var paid=getInvEffectiveDepInfo(inv).value;
```
Byte-for-byte the same transformation as §8 above (`renderStatement()`), on the PDF-preview twin of that function.

---

## 10. `saveCN()` — switch lines 10039-10042

Current (`index.html:10032-10043`):
```js
  // When a CN is Applied and linked to an invoice, recalculate that invoice's balance due
  if (cn.status === 'CN Applied' && cn.linkedInvNum) {
    var linkedInv = DB.inv.find(function(x){ return x.num === cn.linkedInvNum; });
    if (linkedInv) {
      var totalCredits = DB.inv
        .filter(function(x){ return (x.type === 'credit_note' || x.type === 'goodwill_credit') && x.linkedInvNum === cn.linkedInvNum && x.status === 'CN Applied'; })
        .reduce(function(sum, c){ return sum + Math.abs(parseFloat(c.cnAmount||0)); }, 0);
      var totalPayments = DB.payments
        .filter(function(p){ return p.invId === linkedInv.id || p.invNum === linkedInv.num; })
        .reduce(function(sum, p){ return sum + parseFloat(p.amount||0); }, 0);
      linkedInv.calc_balanceDue = (parseFloat(linkedInv.calc_grandTotal||0) - totalPayments - totalCredits).toFixed(2);
    }
  }
```
becomes:
```js
  // When a CN is Applied and linked to an invoice, recalculate that invoice's balance due
  if (cn.status === 'CN Applied' && cn.linkedInvNum) {
    var linkedInv = DB.inv.find(function(x){ return x.num === cn.linkedInvNum; });
    if (linkedInv) {
      var totalCredits = DB.inv
        .filter(function(x){ return (x.type === 'credit_note' || x.type === 'goodwill_credit') && x.linkedInvNum === cn.linkedInvNum && x.status === 'CN Applied'; })
        .reduce(function(sum, c){ return sum + Math.abs(parseFloat(c.cnAmount||0)); }, 0);
      var totalPayments = getInvEffectiveDepInfo(linkedInv).value;
      linkedInv.calc_balanceDue = (parseFloat(linkedInv.calc_grandTotal||0) - totalPayments - totalCredits).toFixed(2);
    }
  }
```

---

## 11. `acctPmtCSV()`/`acctFACSV()` — Currency repoint + Purpose column (REQ §2c-f, AC-9)

Current (`index.html:11172-11184`):
```js
function acctPmtCSV(payments) {
  var h = ['Payment ID','Invoice #','Date','Amount','Method','Reference','Notes','Currency'];
  var rows = [csvRow(h)];
  payments.forEach(function(pm) {
    var inv = DB.inv.find(function(i) { return i.id === pm.invId; });
    rows.push(csvRow([
      pm.id || '', inv ? inv.num : (pm.invId || ''), pm.date || '',
      +(pm.amount || 0), pm.method || '', pm.reference || '', pm.notes || '',
      inv ? inv.cur : ''
    ]));
  });
  return '﻿' + rows.join('\n');
}
```
becomes:
```js
function acctPmtCSV(payments) {
  var h = ['Payment ID','Invoice #','Date','Amount','Method','Reference','Notes','Currency','Purpose'];
  var rows = [csvRow(h)];
  payments.forEach(function(pm) {
    var inv = DB.inv.find(function(i) { return i.id === pm.invId; });
    rows.push(csvRow([
      pm.id || '', inv ? inv.num : (pm.invId || ''), pm.date || '',
      +(pm.amount || 0), pm.method || '', pm.reference || '', pm.notes || '',
      pm.currency || (inv ? inv.cur : ''), pm.purpose || ''
    ]));
  });
  return '﻿' + rows.join('\n');
}
```

Current (`index.html:11235-11248`):
```js
function acctFACSV(payments) {
  var h = ['Date','Payee','Description','Net Amount','Tax Rate','Currency','Reference'];
  var rows = [csvRow(h)];
  payments.forEach(function(pm) {
    var inv = DB.inv.find(function(i) { return i.id === pm.invId; });
    rows.push(csvRow([
      pm.date || '', inv ? inv.buyer : '',
      pm.notes || pm.method || '',
      +(pm.amount || 0), '', inv ? inv.cur : '',
      pm.reference || ''
    ]));
  });
  return '﻿' + rows.join('\n');
}
```
becomes:
```js
function acctFACSV(payments) {
  var h = ['Date','Payee','Description','Net Amount','Tax Rate','Currency','Reference','Purpose'];
  var rows = [csvRow(h)];
  payments.forEach(function(pm) {
    var inv = DB.inv.find(function(i) { return i.id === pm.invId; });
    rows.push(csvRow([
      pm.date || '', inv ? inv.buyer : '',
      pm.notes || pm.method || '',
      +(pm.amount || 0), '', pm.currency || (inv ? inv.cur : ''),
      pm.reference || '', pm.purpose || ''
    ]));
  });
  return '﻿' + rows.join('\n');
}
```
`acctPmtJSON()` (`index.html:11190-11192`) needs **no code change** — confirmed a raw `JSON.stringify({...,payments})` pass-through; `purpose`/`currency`/`rateLock` on a `DB.payments` record already flow through automatically (REQ §2c-f, corrected per round-1 A2).

**Out-of-scope note carried forward (REQ round-11 observation, restated here per the task's request):** both functions resolve a payment's invoice via `DB.inv.find(i.id===pm.invId)` (`11176`, `11239`) — a strict `invId`-only lookup with **no `invNum` fallback**, unlike the shared `getInvPayments(inv)` matching rule this REQ builds. This is pre-existing, untouched by this REQ, and — per the REQ's own text — not one of the enumerated `getInvPayments(inv)` consumer sites, so it is **not** a regression. Left unfixed here, matching the REQ's own scoping.

---

## 12. `_aiExecTool('get_payments')` — `purpose`/`currency` fields (REQ §2c-f, AC-9)

Current (`index.html:10726-10740`):
```js
    if (name === 'get_payments') {
      var pmts = DB.payments.filter(function(p) {
        if (inp.buyer) {
          var inv = DB.inv.find(function(i){ return i.id===p.invId||i.num===p.invNum; });
          if (!inv || (inv.buyer||'').toLowerCase().indexOf(inp.buyer.toLowerCase()) === -1) return false;
        }
        if (inp.inv_num   && (p.invNum||'').toLowerCase().indexOf(inp.inv_num.toLowerCase()) === -1) return false;
        if (inp.date_from && p.date < inp.date_from) return false;
        if (inp.date_to   && p.date > inp.date_to)   return false;
        return true;
      });
      return JSON.stringify(pmts.map(function(p) {
        return { invNum: p.invNum, date: p.date, amount: +p.amount, method: p.method, reference: p.reference };
      }));
    }
```
becomes:
```js
    if (name === 'get_payments') {
      var pmts = DB.payments.filter(function(p) {
        if (inp.buyer) {
          var inv = DB.inv.find(function(i){ return i.id===p.invId||i.num===p.invNum; });
          if (!inv || (inv.buyer||'').toLowerCase().indexOf(inp.buyer.toLowerCase()) === -1) return false;
        }
        if (inp.inv_num   && (p.invNum||'').toLowerCase().indexOf(inp.inv_num.toLowerCase()) === -1) return false;
        if (inp.date_from && p.date < inp.date_from) return false;
        if (inp.date_to   && p.date > inp.date_to)   return false;
        return true;
      });
      return JSON.stringify(pmts.map(function(p) {
        var linkedInv = DB.inv.find(function(i){ return i.id===p.invId||i.num===p.invNum; });
        return { invNum: p.invNum, date: p.date, amount: +p.amount, method: p.method, reference: p.reference,
                 purpose: p.purpose || '', currency: p.currency || (linkedInv ? linkedInv.cur : '') };
      }));
    }
```
**Note:** this `get_payments` tool's own `buyer`-filter invoice lookup (line 10729) already uses a bare `i.id===p.invId||i.num===p.invNum` OR — the same pre-existing shape the REQ's §2c-c narrative discusses for `renderStatement()`/`prevStmtPdf()`/`saveCN()`, but `_aiExecTool('get_payments')` is **not** in the REQ's own enumerated consumer list (§2c-c's parenthetical: "`getInvTotalPaidNative()`, and therefore `getInvEffectiveDepInfo()`, `renderStatement()`, `prevStmtPdf()`, `saveCN()`, `cInv()`, `editInv()`, `renderPaymentsTab()`" — this AI tool is absent from that list). This SPEC reuses the same bare-OR expression only to resolve a currency fallback for display (matching this function's own existing buyer-lookup pattern one line above), not to decide which payments are summed into anything mutating — so it carries none of the double-count/orphan/misassignment risk `getInvPayments(inv)` was built to close. **Flagged for spec-gate:** whether this tool should also be migrated onto `getInvPayments`-style resolution for full consistency is a defensible question, but doing so is outside what REQ §2c-f actually asks for (only `purpose`/`currency` fields), so this SPEC does not widen scope to include it.

---

## 13. Tests — `tests/run.js`

All new tests use the existing `resetDB()`/`test()`/`mockEl()`/`assertEqual()`/`assertApprox()`/`assertContains()` conventions (see `tests/run.js:11-180`). Placed in a new section immediately after the existing "REQ-INTEG-002 (2a): Supplier Payment ledger" block (`tests/run.js:4576` onward) — confirmed spec-gate round 2, "CN Modal Separation" is actually an earlier, unrelated section (`tests/run.js:3071`), not adjacent to this insertion point; the corrected reference is simply "immediately after the 2a block."

```js
// ── REQ-INTEG-002 (2c): Buyer payment tranches ────────────────────────────────
console.log('\nBuyer payment tranches (REQ-INTEG-002 2c)');

// -- getInvPayments(inv) matching rule (AC-3c) --

test('getInvPayments(inv) — invId resolving to the current invoice wins even when invNum is stale (AC-3c scenario 1)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-1', num: 'INV-2C-1-RENAMED', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-1', invId: 'inv-2c-1', invNum: 'INV-2C-1-OLD', date: '2026-01-01', amount: 500 });
  var payments = ctx.getInvPayments(ctx.DB.inv[0]);
  assertEqual(payments.length, 1, 'matched via resolving invId despite a stale invNum');
});

test('getInvPayments(inv) — dangling/blank invId falls back to invNum (AC-3c scenario 2, round 7)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-2', num: 'INV-2C-2', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-2', invId: 'stale-deleted-id', invNum: 'INV-2C-2', date: '2026-01-01', amount: 250 });
  var payments = ctx.getInvPayments(ctx.DB.inv[0]);
  assertEqual(payments.length, 1, 'invId does not resolve to any current invoice — falls back to invNum');
});

test('getInvPayments(inv) — invId resolves to Invoice A while invNum happens to resolve to a different Invoice B: matched to A only, never B (AC-3c scenario 3, round 8)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-3a', num: 'INV-2C-3A', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.inv.push({ id: 'inv-2c-3b', num: 'INV-2C-3B', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-3', invId: 'inv-2c-3a', invNum: 'INV-2C-3B', date: '2026-01-01', amount: 100 });
  var invA = ctx.DB.inv[0], invB = ctx.DB.inv[1];
  assertEqual(ctx.getInvPayments(invA).length, 1, 'matched to A via invId');
  assertEqual(ctx.getInvPayments(invB).length, 0, 'never also matched to B via the invNum collision');
});

test('getInvPayments(inv) — invoice renamed, then a different invoice takes the vacated number: payment stays on the original invoice, never reassigned (AC-3c scenario 4, rounds 9-10)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-4a', num: 'INV100-RENAMED', cur: 'USD', dep: 0, lineItems: [] }); // was INV100, renamed away
  ctx.DB.inv.push({ id: 'inv-2c-4b', num: 'INV100', cur: 'USD', dep: 0, lineItems: [] });          // a different invoice now owns INV100
  ctx.DB.payments.push({ id: 'pm-2c-4', invId: 'inv-2c-4a', invNum: 'INV100', date: '2026-01-01', amount: 750 });
  var invA = ctx.DB.inv[0], invB = ctx.DB.inv[1];
  assertEqual(ctx.getInvPayments(invA).length, 1, 'still counted by A, the invoice its invId actually names');
  assertEqual(ctx.getInvPayments(invB).length, 0, 'never silently reassigned to B, which merely reused the freed-up number');
});

test('getInvPayments(inv) — both invId and invNum blank: matches nothing, no crash (round 11)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-5', num: 'INV-2C-5', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-5', invId: '', invNum: '', date: '2026-01-01', amount: 50 });
  assertEqual(ctx.getInvPayments(ctx.DB.inv[0]).length, 0, 'a payment with both fields blank matches no invoice');
});

// -- getInvTotalPaidNative(inv) (AC-3, AC-3a, AC-3b) --

test('getInvTotalPaidNative(inv) — same-currency payments sum raw, immune to FX rate mutation (AC-3)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-6', num: 'INV-2C-6', cur: 'USD', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-6a', invId: 'inv-2c-6', invNum: 'INV-2C-6', date: '2026-01-01', amount: 100, currency: 'USD' });
  ctx.QR.fxGBPUSD = 0.01; // deliberately wrong — must have zero effect on the same-currency path
  assertEqual(ctx.getInvTotalPaidNative(ctx.DB.inv[0]), 100, 'exact raw sum, FX untouched');
});

test('getInvTotalPaidNative(inv) — cross-currency payment converts via ITS OWN locked rate, not live QR (AC-3)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-7', num: 'INV-2C-7', cur: 'USD', dep: 0, lineItems: [] });
  var ratesUsed = { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 };
  ctx.DB.payments.push({ id: 'pm-2c-7a', invId: 'inv-2c-7', invNum: 'INV-2C-7', date: '2026-01-01', amount: 50, currency: 'USD' });
  ctx.DB.payments.push({ id: 'pm-2c-7b', invId: 'inv-2c-7', invNum: 'INV-2C-7', date: '2026-01-02', amount: 900, currency: 'RMB', rateLock: { gbpEquiv: 100, ratesUsed: ratesUsed } });
  var expected = 50 + ctx.fromGBPLocked(100, 'USD', ratesUsed);
  ctx.QR.fxGBPUSD = 999; ctx.QR.fxGBPRMB = 999; // deliberately wrong live rates
  assertApprox(ctx.getInvTotalPaidNative(ctx.DB.inv[0]), expected, 'cross-currency leg uses the record\'s own locked rates');
});

test('getInvTotalPaidNative(inv) — legacy record with no currency field defaults to the invoice\'s own currency, not USD (AC-3a, B1)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-8', num: 'INV-2C-8', cur: 'GBP', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-8', invId: 'inv-2c-8', invNum: 'INV-2C-8', date: '2026-01-01', amount: 1000 }); // no currency field at all
  assertEqual(ctx.getInvTotalPaidNative(ctx.DB.inv[0]), 1000, 'legacy record read as GBP (inv.cur), summed raw — not defaulted to USD and wrongly pivoted');
});

test('getInvTotalPaidNative(inv) — EUR invoice never pivots: legacy (no currency) and new (currency=inv.cur) payments both sum raw and agree (AC-3b, AC-2a)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-9', num: 'INV-2C-9', cur: 'EUR', dep: 0, lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-9a', invId: 'inv-2c-9', invNum: 'INV-2C-9', date: '2026-01-01', amount: 300 }); // legacy, no currency
  ctx.DB.payments.push({ id: 'pm-2c-9b', invId: 'inv-2c-9', invNum: 'INV-2C-9', date: '2026-01-02', amount: 200, currency: 'EUR' }); // new, per AC-2a
  assertEqual(ctx.getInvTotalPaidNative(ctx.DB.inv[0]), 500, 'both records share the same effective currency (EUR) by construction — raw sum, fromGBPLocked() never reached');
});

// -- getInvEffectiveDepInfo(inv) (AC-4) --

test('getInvEffectiveDepInfo(inv) — zero payment records falls back to legacy inv.dep (AC-4)', function() {
  resetDB();
  var inv = { id: 'inv-2c-10', num: 'INV-2C-10', cur: 'USD', dep: 4200, lineItems: [] };
  ctx.DB.inv.push(inv);
  var info = ctx.getInvEffectiveDepInfo(inv);
  assertEqual(info.value, 4200, 'raw inv.dep returned unchanged');
  assertEqual(info.source, 'legacy-no-records');
});

test('getInvEffectiveDepInfo(inv) — unsupported invoice currency (EUR/NGN/GHS) with payment records falls back to legacy inv.dep (AC-4)', function() {
  resetDB();
  var inv = { id: 'inv-2c-11', num: 'INV-2C-11', cur: 'NGN', dep: 900, lineItems: [] };
  ctx.DB.inv.push(inv);
  ctx.DB.payments.push({ id: 'pm-2c-11', invId: 'inv-2c-11', invNum: 'INV-2C-11', date: '2026-01-01', amount: 100, currency: 'NGN' });
  var info = ctx.getInvEffectiveDepInfo(inv);
  assertEqual(info.value, 900, 'legacy inv.dep returned — never a mislabeled/wrongly-pivoted figure');
  assertEqual(info.source, 'legacy-unsupported-currency');
});

test('getInvEffectiveDepInfo(inv) — supported currency with payment records reconciles from the ledger (AC-4)', function() {
  resetDB();
  var inv = { id: 'inv-2c-12', num: 'INV-2C-12', cur: 'USD', dep: 999, lineItems: [] };
  ctx.DB.inv.push(inv);
  ctx.DB.payments.push({ id: 'pm-2c-12', invId: 'inv-2c-12', invNum: 'INV-2C-12', date: '2026-01-01', amount: 250, currency: 'USD' });
  var info = ctx.getInvEffectiveDepInfo(inv);
  assertEqual(info.value, 250, 'reconciled ledger total, not the stale raw inv.dep');
  assertEqual(info.source, 'ledger');
});

// -- Consumer sites (AC-5) --

test('cInv(inv) — dep resolves via getInvEffectiveDepInfo(), not the old raw currency-blind sum (AC-5)', function() {
  resetDB();
  var inv = { id: 'inv-2c-13', num: 'INV-2C-13', cur: 'GBP', dep: 999, lineItems: [{qty:1,up:1000}], taxRate: 0, chargesIncluded: true };
  ctx.DB.inv.push(inv);
  ctx.DB.payments.push({ id: 'pm-2c-13', invId: 'inv-2c-13', invNum: 'INV-2C-13', date: '2026-01-01', amount: 250, currency: 'GBP' });
  assertEqual(ctx.cInv(inv).dep, 250, 'reconciled ledger total, not the stale raw inv.dep');
});

test('editInv() — dep field displays getInvEffectiveDepInfo(inv).value, not the removed getInvTotalPaid() (AC-5)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-14', num: 'INV-2C-14', buyer: 'Test Buyer', status: 'Draft', type: 'invoice', cur: 'GBP',
    date: '2026-01-01', dep: 999, taxRate: 0, chargesIncluded: true,
    lineItems: [{ desc: 'Widget', sku: '', uom: 'pcs', qty: 1, up: 1000 }] });
  ctx.DB.payments.push({ id: 'pm-2c-14', invId: 'inv-2c-14', invNum: 'INV-2C-14', date: '2026-01-01', amount: 400, currency: 'GBP' });
  ctx.editInv('inv-2c-14');
  assertEqual(mockEl('if-dep').value, '400.00', 'dep field shows the reconciled ledger total, not the stale raw inv.dep');
});

test('renderStatement() — per-invoice Payments column reads getInvEffectiveDepInfo(inv).value (AC-5)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-15', num: 'INV-2C-15', buyer: 'Stmt Buyer', status: 'Sent', type: 'invoice', cur: 'USD',
    date: '2026-01-01', dep: 0, taxRate: 0, chargesIncluded: true, calc_grandTotal: '1000',
    lineItems: [{ qty: 1, up: 1000 }] });
  ctx.DB.payments.push({ id: 'pm-2c-15', invId: 'inv-2c-15', invNum: 'INV-2C-15', date: '2026-01-01', amount: 600, currency: 'USD' });
  ctx.renderStatement('Stmt Buyer');
  assertContains(mockEl('stmt-body').innerHTML, '$600', 'statement shows the reconciled ledger total for the invoice\'s Payments column (fmt() is zero-decimal, corrected spec-gate round 1)');
});

test('saveCN() — linkedInv.calc_balanceDue is computed from getInvEffectiveDepInfo(), not a raw currency-blind sum (AC-5)', function() {
  resetDB();
  ctx.DB.inv = [
    { id: 'inv-2c-16', num: 'INV-2C-16', buyer: 'CN Buyer', status: 'Sent', type: 'invoice', cur: 'USD',
      calc_grandTotal: '5000', calc_balanceDue: '5000' }
  ];
  ctx.DB.payments = [{ id: 'pm-2c-16', invId: 'inv-2c-16', invNum: 'INV-2C-16', date: '2026-01-01', amount: 1000, currency: 'USD' }];
  mockEl('cnf-n').value = 'CN-2C-16';
  mockEl('cnf-amount').value = '300';
  mockEl('cnf-type').value = 'credit_note';
  mockEl('cnf-linked').value = 'INV-2C-16';
  mockEl('cnf-b').value = '';
  mockEl('cnf-cur').value = 'USD';
  mockEl('cnf-dt').value = '2026-01-01';
  mockEl('cn-sm').value = 'CN Applied';
  mockEl('cnf-reason').value = '';
  mockEl('cnf-nt').value = '';
  ctx.EI.cn = null;
  ctx.saveCN();
  var linkedInv = ctx.DB.inv.find(function(i){ return i.num === 'INV-2C-16'; });
  assertEqual(linkedInv.calc_balanceDue, '3700.00', 'balanceDue = 5000 - 1000 (ledger, not a raw payments sum) - 300 (credit)');
});

// -- vPay() / addPaymentFromForm() (AC-1, AC-2, AC-2a) --

test('vPay() blocks without a purpose, mirroring vSupPay() (AC-1)', function() {
  assertEqual(ctx.vPay('2026-01-01', 100, null, ''), false, 'vPay returns false with no purpose');
  assertEqual(ctx.vPay('2026-01-01', 100, null, 'Deposit'), true, 'vPay returns true once purpose is set');
});

test('addPaymentFromForm() blocks the save entirely without a purpose (AC-1)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-17', num: 'INV-2C-17', cur: 'USD', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  mockEl('pm-date').value = '2026-01-01'; mockEl('pm-amount').value = '100'; mockEl('pm-cur').value = 'USD';
  mockEl('pm-purpose').value = ''; mockEl('pm-method').value = 'Bank Transfer'; mockEl('pm-ref').value = ''; mockEl('pm-notes').value = '';
  ctx.addPaymentFromForm('inv-2c-17');
  assertEqual(ctx.DB.payments.length, 0, 'vPay() blocks the save — no purpose selected');
});

test('addPaymentFromForm() creates a record with purpose/currency/rateLock (AC-1, AC-2)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-18', num: 'INV-2C-18', cur: 'GBP', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  mockEl('pm-date').value = '2026-01-01'; mockEl('pm-amount').value = '400'; mockEl('pm-cur').value = 'GBP';
  mockEl('pm-purpose').value = 'Deposit'; mockEl('pm-method').value = 'Bank Transfer'; mockEl('pm-ref').value = 'REF-18'; mockEl('pm-notes').value = '';
  ctx.addPaymentFromForm('inv-2c-18');
  assertEqual(ctx.DB.payments.length, 1, 'one record created');
  var pm = ctx.DB.payments[0];
  assertEqual(pm.purpose, 'Deposit');
  assertEqual(pm.currency, 'GBP');
  assert(!!pm.rateLock, 'rateLock present for a supported-currency payment');
  assertEqual(pm.rateLock.currency, 'GBP');
});

test('addPaymentFromForm() on an unsupported-currency invoice (EUR/NGN/GHS): currency forced to inv.cur, no rateLock generated (AC-2a)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-19', num: 'INV-2C-19', cur: 'EUR', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  mockEl('pm-date').value = '2026-01-01'; mockEl('pm-amount').value = '300'; mockEl('pm-cur').value = 'USD'; // even if a stale/disabled value is read
  mockEl('pm-purpose').value = 'Balance'; mockEl('pm-method').value = 'Bank Transfer'; mockEl('pm-ref').value = ''; mockEl('pm-notes').value = '';
  ctx.addPaymentFromForm('inv-2c-19');
  var pm = ctx.DB.payments[0];
  assertEqual(pm.currency, 'EUR', 'currency forced to inv.cur itself, never a substitute from the 4-option list');
  assert(!pm.rateLock, 'no rateLock generated — nothing to lock a rate for');
});

test('addPaymentFromForm() legacy-plus-new payment on the same EUR invoice share the identical currency value and reconcile correctly (AC-2a)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-20', num: 'INV-2C-20', cur: 'EUR', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-20-legacy', invId: 'inv-2c-20', invNum: 'INV-2C-20', date: '2026-01-01', amount: 200 }); // legacy, no currency
  mockEl('pm-date').value = '2026-01-02'; mockEl('pm-amount').value = '150'; mockEl('pm-cur').value = 'USD';
  mockEl('pm-purpose').value = 'Balance'; mockEl('pm-method').value = 'Bank Transfer'; mockEl('pm-ref').value = ''; mockEl('pm-notes').value = '';
  ctx.addPaymentFromForm('inv-2c-20');
  var inv = ctx.DB.inv[0];
  assertEqual(ctx.getInvTotalPaidNative(inv), 350, 'legacy (defaults to inv.cur) and new (forced to inv.cur) payments combine correctly');
  assertEqual(inv.dep, 350, 'inv.dep reflects the correct combined raw sum after save');
});

test('savePayment()/deletePayment() on a EUR invoice: raw sum survives a full save-then-delete cycle, never mis-pivoted (AC-3b)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  ctx.DB.inv.push({ id: 'inv-2c-21', num: 'INV-2C-21', cur: 'EUR', dep: 0, status: 'Sent', calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-21-legacy', invId: 'inv-2c-21', invNum: 'INV-2C-21', date: '2026-01-01', amount: 400 }); // legacy
  ctx.savePayment({ id: 'pm-2c-21-new', invId: 'inv-2c-21', invNum: 'INV-2C-21', date: '2026-01-02', amount: 300, currency: 'EUR' });
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2c-21'; });
  assertEqual(inv.dep, 700, 'combined raw sum after save — no mis-pivot');
  ctx.deletePayment('pm-2c-21-new');
  assertEqual(inv.dep, 400, 'combined raw sum after delete — still correct, no mis-pivot');
});

// -- deletePayment() status re-derivation (AC-6) --

test('deletePayment() — Paid invoice reverts to Partially Paid once the recomputed total drops below grand total (AC-6)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  ctx.DB.inv.push({ id: 'inv-2c-22', num: 'INV-2C-22', cur: 'USD', dep: 1000, status: 'Paid', calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-22a', invId: 'inv-2c-22', invNum: 'INV-2C-22', date: '2026-01-01', amount: 600, currency: 'USD' });
  ctx.DB.payments.push({ id: 'pm-2c-22b', invId: 'inv-2c-22', invNum: 'INV-2C-22', date: '2026-01-02', amount: 400, currency: 'USD' });
  ctx.deletePayment('pm-2c-22b');
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2c-22'; });
  assertEqual(inv.status, 'Partially Paid', 'status re-derives down from Paid');
  assertEqual(inv.dep, 600, 'dep reflects the remaining payment only');
});

test('deletePayment() — Paid invoice reverts all the way to Sent once its only payment is deleted (AC-6)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  ctx.DB.inv.push({ id: 'inv-2c-23', num: 'INV-2C-23', cur: 'USD', dep: 1000, status: 'Paid', calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-23', invId: 'inv-2c-23', invNum: 'INV-2C-23', date: '2026-01-01', amount: 1000, currency: 'USD' });
  ctx.deletePayment('pm-2c-23');
  var inv = ctx.DB.inv.find(function(i){ return i.id === 'inv-2c-23'; });
  assertEqual(inv.status, 'Sent', 'status reverts to Sent, the last pre-Partially-Paid status in STATUS_ORDER');
  assertEqual(inv.dep, 0, 'dep reflects zero remaining payments');
});

test('deletePayment() — Draft/Pro-forma/Cancelled invoice status is left completely untouched (AC-6)', function() {
  resetDB();
  ctx.confirm = function(){ return true; };
  ['Draft', 'Pro-forma', 'Cancelled'].forEach(function(status, i) {
    var invId = 'inv-2c-24-' + i, pmId = 'pm-2c-24-' + i;
    ctx.DB.inv.push({ id: invId, num: 'INV-2C-24-' + i, cur: 'USD', dep: 100, status: status, calc_grandTotal: '1000', lineItems: [] });
    ctx.DB.payments.push({ id: pmId, invId: invId, invNum: 'INV-2C-24-' + i, date: '2026-01-01', amount: 100, currency: 'USD' });
    ctx.deletePayment(pmId);
    var inv = ctx.DB.inv.find(function(x){ return x.id === invId; });
    assertEqual(inv.status, status, 'status ' + status + ' is never auto-derived by this logic');
  });
});

// -- renderPaymentsTab() (AC-8, AC-8a) --

test('renderPaymentsTab() — Purpose column always renders; Currency/GBP-equivalent columns hidden when every payment shares the invoice\'s own currency (AC-8)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-25', num: 'INV-2C-25', cur: 'USD', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-25', invId: 'inv-2c-25', invNum: 'INV-2C-25', date: '2026-01-01', amount: 200, currency: 'USD', purpose: 'Deposit' });
  ctx.renderPaymentsTab('inv-2c-25');
  var html = mockEl('payments-tab').innerHTML;
  assertContains(html, '<th>Purpose</th>', 'Purpose column always present');
  assertNotContains(html, '<th>Currency</th>', 'Currency column hidden — every payment matches the invoice\'s own currency');
});

test('renderPaymentsTab() — EUR invoice never shows the Currency/GBP-equivalent column pair, even after recording a payment (AC-8)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-26', num: 'INV-2C-26', cur: 'EUR', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-26', invId: 'inv-2c-26', invNum: 'INV-2C-26', date: '2026-01-01', amount: 300, currency: 'EUR', purpose: 'Balance' });
  ctx.renderPaymentsTab('inv-2c-26');
  assertNotContains(mockEl('payments-tab').innerHTML, '<th>Currency</th>', 'never shown — every payment\'s resolved currency is inv.cur itself, never differing');
});

test('renderPaymentsTab() — legacy (no currency/rateLock) row and a genuine cross-currency row coexist on a supported-currency invoice without crashing (AC-8a)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-27', num: 'INV-2C-27', cur: 'USD', dep: 0, calc_grandTotal: '1000', lineItems: [] });
  ctx.DB.payments.push({ id: 'pm-2c-27-legacy', invId: 'inv-2c-27', invNum: 'INV-2C-27', date: '2026-01-01', amount: 500 }); // legacy: no currency, no rateLock
  ctx.DB.payments.push({ id: 'pm-2c-27-gbp', invId: 'inv-2c-27', invNum: 'INV-2C-27', date: '2026-01-02', amount: 100, currency: 'GBP',
    rateLock: { gbpEquiv: 100, ratesUsed: { fxGBPUSD: 1.25, fxGBPRMB: 9.0, fxGBPBBD: 2.5 } } });
  var result; try { ctx.renderPaymentsTab('inv-2c-27'); result = 'ok'; } catch (e) { result = e.message; }
  assertEqual(result, 'ok', 'renders without error for a legacy+cross-currency mix');
  var html = mockEl('payments-tab').innerHTML;
  assertContains(html, '<th>Currency</th>', 'Currency/GBP columns appear — the GBP row differs from the invoice\'s own currency');
  assertContains(html, '£100', 'locked rateLock.gbpEquiv shown for the cross-currency row, not a live-recomputed value (fmt() is zero-decimal, corrected spec-gate round 1)');
});

// -- Exports / AI tool (AC-9) --

test('acctPmtCSV() — Currency column reads pm.currency (fallback inv.cur for a legacy record), gains a Purpose column (AC-9)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-28', num: 'INV-2C-28', cur: 'USD', buyer: 'X' });
  var csv = ctx.acctPmtCSV([
    { id: 'pm-a', invId: 'inv-2c-28', date: '2026-01-01', amount: 100, method: 'Bank Transfer', reference: '', notes: '', currency: 'GBP', purpose: 'Deposit' },
    { id: 'pm-b', invId: 'inv-2c-28', date: '2026-01-02', amount: 50,  method: 'Bank Transfer', reference: '', notes: '' } // legacy, no currency/purpose
  ]);
  assertContains(csv, 'Purpose', 'header gains a Purpose column');
  assertContains(csv, 'GBP', 'a payment-level currency wins over the invoice\'s own (USD)');
  assertContains(csv, 'Deposit', 'purpose value present');
});

test('acctFACSV() — Currency column reads pm.currency (fallback inv.cur), gains a Purpose column (AC-9)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-29', num: 'INV-2C-29', cur: 'USD', buyer: 'Y' });
  var csv = ctx.acctFACSV([
    { id: 'pm-c', invId: 'inv-2c-29', date: '2026-01-01', amount: 75, method: 'Cash', reference: '', notes: '', currency: 'BBD', purpose: 'Other' }
  ]);
  assertContains(csv, 'Purpose', 'header gains a Purpose column');
  assertContains(csv, 'BBD', 'payment-level currency used');
});

test('_aiExecTool(\'get_payments\') includes purpose/currency in its per-payment field list (AC-9)', function() {
  resetDB();
  ctx.DB.inv.push({ id: 'inv-2c-30', num: 'INV-2C-30', cur: 'USD', buyer: 'Z' });
  ctx.DB.payments.push({ id: 'pm-2c-30', invId: 'inv-2c-30', invNum: 'INV-2C-30', date: '2026-01-01', amount: 500, method: 'Bank Transfer', currency: 'GBP', purpose: 'Deposit' });
  var result = JSON.parse(ctx._aiExecTool('get_payments', {}));
  assertEqual(result[0].purpose, 'Deposit');
  assertEqual(result[0].currency, 'GBP');
});
```

**AC-10 — full pre-existing-test-suite audit (documented here, no code change):** grepped every direct call of `savePayment(`/`deletePayment(`/`getInvTotalPaid(`/`getInvPayments(` in `tests/run.js`. Findings:
- `tests/run.js:5263` (`savePayment() FPM-recovery block...`, AC-8 of REQ-INTEG-002-2b) and `tests/run.js:9155` (the `persistPOChange` regression test) both call `savePayment()` with a hand-built record carrying `amount`/no `currency` field, against an invoice with `cur:'USD'`. Under the new `getInvTotalPaidNative(inv)`, a currency-less record on a USD invoice defaults to `'USD'` (B1) and takes the same-currency raw-sum path — **identical numeric result** to the old `getInvTotalPaid(inv.id)`. Both tests remain green, unmodified.
- `tests/run.js:5731` (`savePayment creates payment_created event`) and `tests/run.js:5736-5745` (`deletePayment creates payment_deleted event`) both reference an invoice id (`'i1'`) that is **never pushed into `DB.inv`** — the `if (inv) {...}` block in both `savePayment()`/`deletePayment()` never executes, so neither `getInvTotalPaid`/`getInvTotalPaidNative` is ever reached. Both tests remain green, unmodified.
- No test anywhere calls `getInvTotalPaid(` or `getInvPayments(` directly (confirmed by grep) — the removed function has no direct test to update.
- No existing test calls `renderPaymentsTab(`, `addPaymentFromForm(`, `vPay(`, or references `pm-cur`/`pm-purpose` — these are new-in-this-REQ surfaces with no pre-existing coverage to break.

**Testability note — flagged for spec-gate, not a defect in the REQ itself:** `renderStatement()` and `renderPaymentsTab()` (tested above) and `editInv()`/`saveCN()` (also tested above) had **zero pre-existing direct test-call precedent** in `tests/run.js` before this REQ — this SPEC's tests for them are the first ever written, not adaptations of an existing pattern (unlike, say, `getPOTotalPaidNative`/`getPOEffectiveDepInfo`, which had a direct, provably-working precedent to mirror). They were written from a careful direct read of each function's full body and the mock-DOM harness's actual behavior (`tests/run.js:11-33`: `G()`/`document.getElementById` auto-vivifies any element id on first access, so an un-pre-mocked element degrades to a harmless default rather than throwing) — but since this SPEC cannot execute the suite, **these four tests carry materially higher risk of needing a small correction at spec-gate or build-time than the rest of this test list**, which mostly mirrors an already-proven pattern (the PO-side ledger tests). `prevStmtPdf()` was deliberately **not** given a test: it calls `window.open()`/`Blob`/`URL.createObjectURL()`, none of which are mocked in the harness (`tests/run.js:91-108`), and no pre-existing test exercises it either — its `paid` computation is a byte-for-byte identical one-line change to `renderStatement()`'s own (already tested), which is offered as the confidence argument in its place.

---

## 14. `docs/known-gaps.md` — new NGN/GHS entry (REQ §3)

Current (`docs/known-gaps.md:432-434`):
```
**Note:** Discovered while building `getPOEffectiveDep()`'s currency reconciliation for the Supplier Payment ledger fix (REQ-INTEG-002-2a-fix). That fix does **not** solve this gap — it explicitly guards against it (a currency allow-list, `PO_DEP_RECONCILE_CURS`, excludes EUR, so a EUR-denominated PO simply falls back to its legacy, unreconciled `PO.dep` figure rather than risk a silently wrong converted number). Fixing the underlying gap would mean adding a real `QR.fxGBPEUR` rate, wiring it into `toGBP()`/`fromGBP()`, and extending every currency dropdown that should offer EUR consistently — a change to the shared FX mechanism used everywhere, not a scoped fix, and out of scope for the Supplier Payment ledger work. Revisit if/when EUR-denominated transactions become operationally significant enough to justify the shared-mechanism change.

---
```
becomes:
```
**Note:** Discovered while building `getPOEffectiveDep()`'s currency reconciliation for the Supplier Payment ledger fix (REQ-INTEG-002-2a-fix). That fix does **not** solve this gap — it explicitly guards against it (a currency allow-list, `PO_DEP_RECONCILE_CURS`, excludes EUR, so a EUR-denominated PO simply falls back to its legacy, unreconciled `PO.dep` figure rather than risk a silently wrong converted number). Fixing the underlying gap would mean adding a real `QR.fxGBPEUR` rate, wiring it into `toGBP()`/`fromGBP()`, and extending every currency dropdown that should offer EUR consistently — a change to the shared FX mechanism used everywhere, not a scoped fix, and out of scope for the Supplier Payment ledger work. Revisit if/when EUR-denominated transactions become operationally significant enough to justify the shared-mechanism change.

---

### PROC-GAP-003 — NGN/GHS have the identical unlogged FX-conversion gap as EUR (`PROC-GAP-002`)

**Area:** Shared currency-conversion mechanism (`toGBP()`, `fromGBP()`), used by Invoices, Purchase Orders, and both Payment ledgers.
**Logged:** v[NEXT] (REQ-INTEG-002-2c, found during requirements-gate research into the Invoice currency dropdown's full option list).
**Detail:** The Invoice currency dropdown (`if-cur`, `index.html:1150`) offers six options — USD/GBP/EUR/BBD/NGN/GHS — but `toGBP()`/`fromGBP()` only have branches for USD/RMB-or-CNY/BBD (identical to `PROC-GAP-002`'s own description for EUR). An NGN or GHS amount passed to either function silently falls through to the final `return n;` — treated as numerically equal to GBP, with no rate applied. This is the same defect class as `PROC-GAP-002`, just against two more currencies that were never previously named in this gap log.
**Status:** Open — Backlog, not scheduled. Same disposition as `PROC-GAP-002`: REQ-INTEG-002-2c explicitly guards against it rather than fixing it — `pm-cur` (the buyer-payment currency select) never offers NGN/GHS as options, and an NGN/GHS invoice's own payments are forced to carry `inv.cur` itself (never a substitute currency), so the gap is never silently triggered by anything this REQ ships; it is inherited, unfixed, from the pre-existing `toGBP()`/`fromGBP()` mechanism.
**Note:** Fixing this (like `PROC-GAP-002`) means extending the shared FX mechanism used everywhere — out of scope for a buyer-payments REQ. Revisit alongside `PROC-GAP-002` if/when EUR/NGN/GHS-denominated transactions become operationally significant enough to justify the shared-mechanism change.

---
```
**Judgment call:** `v[NEXT]` is a placeholder for the actual shipped version number, unknowable until ship time (see §17 below) — consistent with REQ §7's own heading, "Tracker updates (**at ship time**)."

---

## 15. `docs/requirements-tracker.md` — tracker update

**Judgment call flagged for spec-gate — a real discrepancy, not a stylistic choice:** REQ §7 literally says *"docs/requirements-tracker.md — new `REQ-INTEG-002 (2c)` row."* But the tracker's own **established, demonstrated practice** for this exact multi-sub-phase initiative is the opposite: sub-phases 2a, its two fix-forwards, and 2b were all appended as new paragraphs inside the **same single row**, `| REQ-INTEG-002 (Sub-phase 2a) | ... |` (`docs/requirements-tracker.md:29`) — its "Build" cell already reads "...**Sub-phase 2b (v2.9.66, REQ-INTEG-002-2b, Invoice→PO enumeration fix):** ..." appended after the 2a/fix/fix-2 narrative, and its "PR" cell already reads "#100 (2a); #102 (fix); #105 (fix-2); #110 (2b)". Creating a brand-new row for 2c would break that established pattern and scatter one initiative's history across multiple rows. **This SPEC follows the demonstrated row-append convention, not the REQ's literal "new row" phrasing — confirmed and accepted at spec-gate round 1**, which independently re-verified the tracker's row-29 structure directly and concluded a new row would fragment one initiative's already-established one-row history against demonstrated practice, while REQ §7's "new row" phrasing reads as generic ship-time guidance rather than a considered override. Settled; not open for build-gate to revisit.

Current (`docs/requirements-tracker.md:29`, only the tail of the Build/PR cells is shown — the full row is one very long line):
```
...(deal pipeline: Order Request, Quote, Purchase Order) is now fully Cloud-Data-eligible; Phase 3 (Invoice, Credit Note, Shipment, and the Payment ledgers) remains explicitly future, unscoped work, not to be started without further explicit instruction. 23 new tests, 775/775 pass. | #100 (2a); #102 (fix); #105 (fix-2); #110 (2b) |
```
becomes (Build cell gains a new trailing paragraph; PR cell gains a new trailing entry — exact final wording of the Build paragraph is written at ship time, per this tracker's own established practice of writing each sub-phase's summary only once its real build-gate outcome is known; the text below is a structural placeholder for spec-gate to sanity-check the *shape*, not the final prose):
```
...(deal pipeline: Order Request, Quote, Purchase Order) is now fully Cloud-Data-eligible; Phase 3 (Invoice, Credit Note, Shipment, and the Payment ledgers) remains explicitly future, unscoped work, not to be started without further explicit instruction. 23 new tests, 775/775 pass. **Sub-phase 2c (v[NEXT], REQ-INTEG-002-2c, Buyer payment tranches):** check-first found buyer payments already support multiple partial payments per invoice (predates 2a) — this sub-phase instead closes the parity gap against the now-more-mature Supplier Payment ledger (`purpose`/`currency`/`rateLock` fields, new `getInvTotalPaidNative(inv)`/`getInvEffectiveDepInfo(inv)` mirroring the PO-side pair) and fixes a confirmed-live bug (`deletePayment()` never reversed `inv.status`). Went through an unusually long requirements-gate cycle — 11 rounds, the longest in this series — the last four rounds (7-10) each finding a genuine defect in the shared `getInvPayments(inv)` matching-rule's field-preference order before round 11 passed clean; round 10's final rule inverts `REQ-INTEG-002-2b`'s own "`prefer invNum`" precedent, since payments (unlike POs) never have their `invId`/`invNum` deliberately re-edited after creation, making the direct, immutable `invId` reference more trustworthy than the rename-vulnerable denormalized `invNum` copy. [build/PR outcome — filled in at ship time]. | #100 (2a); #102 (fix); #105 (fix-2); #110 (2b); [PR] (2c) |
```

---

## 16. `docs/version-history.md` — new entry

Current (`docs/version-history.md:4-5`):
```
| Version | Highlights |
|---|---|
| v2.9.76 | New: **Cloud Data (Supabase) extended to Purchase Order** ...
```
becomes (new row prepended; `v[NEXT]` per the same placeholder rationale as §14/§15 above — this SPEC assumes `v2.9.77` if no other REQ ships first, but does not hard-code that assumption into the doc diff itself):
```
| Version | Highlights |
|---|---|
| v[NEXT] | New: **Buyer payment tranches** (REQ/SPEC-INTEG-002-2c, `docs/REQ-INTEG-002-2c-v1.md`/`docs/SPEC-INTEG-002-2c-v1.md`). Sub-phase 2c of the Payment Allocation build (2a Supplier ledger → 2b Invoice→PO enumeration fix → **2c, this version** → 2d full allocation link, still unscoped). Check-first found buyer payments already support multiple partial payments per invoice — this predates 2a — so "tranches" is scoped instead to closing the real parity gaps against the now-more-mature Supplier Payment ledger: buyer payment records gain a required `purpose` field (`Deposit`/`Balance`/`Other`, mirroring `vSupPay()`) and `currency`/`rateLock` fields (reusing `lockFxRate()` verbatim), with a legacy-record currency default of `inv.cur` — not `'USD'` — since years of real pre-this-REQ production records across every invoice currency have no `currency` field at all. New `getInvTotalPaidNative(inv)`/`getInvEffectiveDepInfo(inv)` mirror the PO-side `getPOTotalPaidNative`/`getPOEffectiveDepInfo` pair, built on a rewritten, now-shared `getInvPayments(inv)` — the REQ's requirements-gate went through 11 rounds, the last four (7-10) each correcting a real defect in this matching rule's `invId`/`invNum` field-preference order, concluding that (unlike `REQ-INTEG-002-2b`'s PO-side precedent, where a real re-link deliberately rewrites `invNum`) a payment's `invId` is the more trustworthy field, since neither field is ever re-edited after a payment is created and only `invNum` can be silently invalidated later by an unrelated invoice rename. Six total currency-blind/matching-inconsistent read sites (`cInv()`, `editInv()`, `renderStatement()`, `prevStmtPdf()`, `saveCN()`'s balance-due recompute, and `renderPaymentsTab()`'s own summary box) now share one correct reconciliation path. Also fixes a confirmed-live bug: `deletePayment()` never reversed `inv.status`, permanently stranding a corrected invoice at `Paid`/`Partially Paid` — now re-derives status narrowly, only when the current status is one this same logic could have produced. `renderPaymentsTab()` gains a Purpose column (always) and a Currency/GBP-equivalent column pair (only when a row's resolved currency differs from the invoice's own). Logs `PROC-GAP-003` (NGN/GHS share EUR's pre-existing, unlogged `toGBP()`/`fromGBP()` gap, `PROC-GAP-002`'s same defect class) — guarded against, not fixed, exactly as `PROC-GAP-002` already was. [test count / pass count — filled in at ship time]. |
| v2.9.76 | New: **Cloud Data (Supabase) extended to Purchase Order** ...
```

---

## 17. `STACKD_CONTEXT.md` / `CLAUDE.md` — version bump

Current (`STACKD_CONTEXT.md:14`):
```
| Current version | v2.9.76 |
```
becomes:
```
| Current version | v[NEXT] |
```

Current (`CLAUDE.md:10-11`):
```
**Current version: v2.9.76**  
**Test count: 775/775 PASS** (`node tests/run.js`)
```
becomes:
```
**Current version: v[NEXT]**  
**Test count: [775+N]/[775+N] PASS** (`node tests/run.js`)
```
where `N` is the actual number of new tests once the SPEC's test list (§13) is applied and any spec-gate/build-gate corrections are folded in — this SPEC's own test list (§13) contains 31 new tests. Spec-gate round 1 applied all 12 code diffs and all 31 tests verbatim against the real suite (baseline 775/775): 2 of the 31 failed on a hardcoded `.toFixed(2)`-style expected substring that the pre-existing zero-decimal `fmt()` helper can never produce (fixed in place in §13, see the Status line); with those two one-line assertion fixes applied, `N=31`/`806/806`, confirmed by actually running the suite, not asserted from the SPEC alone.

`STACKD_CONTEXT.md`'s "Version history" section header (`STACKD_CONTEXT.md:148`, `## Version history (v2.9.32 → v2.9.76 — everything shipped since this file was last updated)`) and its per-version table also need a new row mirroring the `v2.9.76` row's own shape (`STACKD_CONTEXT.md:152` area) — left as a ship-time prose task per this file's own stated update discipline ("Updated by Claude Code on every version delivery"), not spelled out here to avoid duplicating the version-history.md content twice.

---

## 18. `docs/user-guide.md` — Payments paragraph

Current (`docs/user-guide.md:107-109`):
```
**Credit Notes** are issued from the same modal — either linked to a specific existing invoice (standard credit) or marked as a standalone goodwill credit. A credit note reduces the linked invoice's balance due automatically.

**Buyer approval.** While an invoice is at Pro-forma status, use **Mark Buyer Approved** to record that the buyer confirmed approval — by email, WhatsApp, WeChat, phone/verbal, or another method — along with who confirmed it and an optional note. This does not change the invoice's status; it's a record of authorization. Editing any line item afterward (price, quantity, or adding/removing a line) automatically clears the approval, so you're never invoicing off stale-approved numbers — editing an unrelated header field (Incoterm, payment terms, etc.) does not. Once approved, **Progress to Invoicing** becomes available: it logs that you're proceeding, and optionally lets you record which Quote this invoice corresponds to, purely for your own audit trail — it doesn't require or enforce any particular process, and it never changes the invoice's status either.
```
becomes:
```
**Credit Notes** are issued from the same modal — either linked to a specific existing invoice (standard credit) or marked as a standalone goodwill credit. A credit note reduces the linked invoice's balance due automatically.

**Recording payments.** The "$" action on an invoice's row opens its Payments tab, where you can record as many partial payments as needed — each with a Date, Amount, Currency, Purpose (Deposit/Balance/Other — required), Method, Reference, and Notes. Currency defaults to the invoice's own currency and normally doesn't need changing; it can be set to a different supported currency (USD/GBP/RMB/BBD) for the rarer case of a buyer paying in a different one — the Currency and £-equivalent columns only appear on the payment table once at least one row actually differs from the invoice's own currency, so a normal, single-currency invoice's table stays uncluttered. Invoices in EUR/NGN/GHS can't offer this choice yet (the app has no live FX rate for those three) — the Currency field is disabled and every payment against such an invoice is simply recorded in that same currency. The invoice's status automatically advances to Partially Paid/Paid as payments are recorded, and correctly reverts (down to Partially Paid, or back to Sent) if a payment is deleted — it never touches a Draft, Pro-forma, or Cancelled invoice's status.

**Buyer approval.** While an invoice is at Pro-forma status, use **Mark Buyer Approved** to record that the buyer confirmed approval — by email, WhatsApp, WeChat, phone/verbal, or another method — along with who confirmed it and an optional note. This does not change the invoice's status; it's a record of authorization. Editing any line item afterward (price, quantity, or adding/removing a line) automatically clears the approval, so you're never invoicing off stale-approved numbers — editing an unrelated header field (Incoterm, payment terms, etc.) does not. Once approved, **Progress to Invoicing** becomes available: it logs that you're proceeding, and optionally lets you record which Quote this invoice corresponds to, purely for your own audit trail — it doesn't require or enforce any particular process, and it never changes the invoice's status either.
```

---

## 19. `index.html` housekeeping (version string, changelog, AI prompt) — judgment call

**Flagged for spec-gate:** REQ §7 does not explicitly list these three, but `CLAUDE.md`'s own "On version delivery" checklist (`CLAUDE.md:128-138`) makes them mandatory for every version, and this REQ specifically changes `_aiExecTool('get_payments')`'s own output shape, which is exactly the kind of change that checklist's `AI_SYSTEM_PROMPT` item exists to catch ("If the user asked the AI about this feature, would the answer be accurate?"). Included here for completeness; a reasonable alternative is to treat this purely as build-time housekeeping outside the SPEC's own scope, since REQ §7 doesn't name it.

- `index.html:8` (`<title>Stackd Ops v2.9.76</title>`) and `index.html:10111` (`'...browser-based trade operations portal (v2.9.76).'`) — both bump to `v[NEXT]`.
- `index.html:10653-10654` — `get_payments`'s tool `description` gains a mention that results now include purpose/currency: `'Query payment ledger entries. Filter by buyer name, invoice number, or date range. Returns payment date, amount, method, reference, purpose, and currency.'`
- A new changelog entry block, mirroring the exact structure at `index.html:1311-1320` (the current `v2.9.76` block), inserted immediately above it — final bullet-point prose written at ship time from the real build outcome, per this file's own established convention (every existing block was written post-build, describing what actually shipped and what each gate round actually found — never pre-written from a SPEC).

---

## 20. Out of scope (mirrors REQ §3, restated for the implementer)

- A scheduled/expected-payment-plan feature ("30% deposit due on order, 70% on shipment") — not what "tranches" means here (REQ §0/§3).
- 2d (full allocation link) — next, still-unscoped phase.
- `PROC-GAP-002`/`PROC-GAP-003` (EUR/NGN/GHS FX-conversion gap) — logged (§14), not fixed.
- Real-time per-save Sheets sync for `DB.payments` — deferred to v3.0.0, unaffected by this REQ. **Note (not in REQ text, worth a one-line spec-gate awareness item):** `FIELD_MAPS.payments` (`index.html:4388`) still maps a `cur` key, not `currency` — the new field name this REQ introduces — so bulk Sheets sync will not push/pull the new `purpose`/`currency`/`rateLock` fields even once wired. This is consistent with, not contrary to, this REQ's own explicit "bulk sync already covers `DB.payments` today... unaffected by this REQ" scoping (REQ §3) — flagged only so a future Sheets-sync REQ isn't surprised by it.
- Cloud Data migration for `DB.payments` — Phase 3, unbriefed.
- Backfilling `purpose`/`currency` onto pre-existing payment records — no migration script.
- The duplicated `fpmRecovered` auto-set logic between `saveInv()`/`savePayment()` — untouched (REQ §1.5).
- Giving `saveInv()`'s/`saveCN()`'s goodwill-credit `DB.payments` push sites (`index.html:7075-7079`, `10022-10025`) a `purpose`/`currency`/`type` — these represent an internal accounting entry, not an operator-recorded payment, and correctly default to `inv.cur` via the same B1 rule.
- `acctPmtCSV`/`acctFACSV`'s own `invId`-only invoice lookup (no `invNum` fallback) — pre-existing, not part of the `getInvPayments(inv)` consumer list, restated in §11 above per the task's specific request to check this.
- `_aiExecTool('get_payments')`'s buyer-filter invoice lookup (bare `invId||invNum` OR) — pre-existing, read-only, not part of the enumerated consumer list either (§12).

---

## 21. Summary of judgment calls for spec-gate (collected from above)

1. **Placement of `getInvTotalPaidNative`/`getInvEffectiveDepInfo`** (§1) — grouped with `getInvPayments` rather than with the PO-side functions. Zero behavioral effect; purely a code-organization choice.
2. **`rateLock: null` vs. omitting the key** for an unsupported-currency payment (§3) — behaviorally identical everywhere it's read.
3. **Toast message now shows the payment's own resolved currency**, not always `inv.cur` (§3) — a small, REQ-consistent corollary not explicitly spelled out in the REQ text.
4. **`cInv()`'s dep-fallback fork condition changes from `ledgerTotal > 0` to `payments.length > 0`** (§7) — a genuine, if narrow (`sum ≤ 0` with real records), behavior difference, forced by keeping `cInv()` consistent with the `getInvEffectiveDepInfo()` contract every other consumer now shares. No existing test's expected value is affected.
5. **`requirements-tracker.md`: row-append vs. brand-new row** (§15) — REQ §7 literally says "new row"; this SPEC follows the tracker's own demonstrated append-to-existing-row practice for this initiative instead. Needs an explicit spec-gate decision.
6. **`index.html` version-string/changelog/`AI_SYSTEM_PROMPT` housekeeping** (§19) — not named in REQ §7, included per `CLAUDE.md`'s own mandatory-every-version process instead.
7. **Test-coverage risk asymmetry** (§13, final note) — `renderStatement()`/`renderPaymentsTab()`/`editInv()`/`saveCN()` tests are first-ever-written for these functions in this harness (no precedent to mirror), unlike the ledger-math tests which mirror an already-proven PO-side pattern; `prevStmtPdf()` has no test at all (harness has no `window.open`/`Blob`/`URL` mocks). Recommend running the real suite at spec-gate before treating these four render-layer tests as final.
8. **`_aiExecTool('get_payments')`'s pre-existing bare-OR invoice lookup and `acctPmtCSV`/`acctFACSV`'s `invId`-only lookup** (§11, §12) — confirmed pre-existing, confirmed out of the REQ's own enumerated consumer list, left unfixed; flagged in case spec-gate reads REQ §2c-c's "every consumer... shares one single, correct matching rule" language as intending otherwise (round 11 itself already flagged this exact sentence as "very slightly overbroad" if read that way).

---

## 22. Citation accuracy — independently re-verified against `e0dcd2c`

Every `index.html` line citation in this SPEC (both those inherited from the REQ and the ones added here) was checked directly against the file at commit `e0dcd2c` before being used. **No drift was found** — every citation this SPEC relies on matches the real file exactly, including the ones round 11's own spot-check already covered (`getInvPayments`/`getInvTotalPaid` at `13021-13028`, `savePayment` at `13030-13089` with the grand-total fallback at `13047` and the `totalPaid` read at `13041`, `deletePayment` at `13091-13110` with its `inv`-resolve at `13101`, `renderPaymentsTab` at `13112-13170`, `editInv`'s single clause at `6822`, `cInv`'s inline sum at `4763-4768`, `renderStatement`'s `paid` at `8099-8100`, `prevStmtPdf`'s `paid` at `8166`, `saveCN`'s `totalPayments` at `10039-10042`, `FIELD_MAPS.payments` at `4388`, `LOCKED_STATUSES`/`STATUS_ORDER` at `2850-2851`, `vInv`'s duplicate guard at `8967`, `mergePulledWithLocal`'s `id`-preservation line at `4427`) plus every citation this SPEC newly needed and the REQ did not itself cite line-for-line (`vPay` at `9046-9070`, `vSupPay`'s purpose check at `13284-13286`, `getPOTotalPaidNative`/`getPOEffectiveDepInfo` at `13225-13262`, `PO_DEP_RECONCILE_CURS` at `13219`, `toGBP`/`fromGBP`/`lockFxRate`/`fromGBPLocked` at `4827-4884`, `acctPmtCSV`/`acctPmtJSON`/`acctFACSV` at `11172-11248`, `_aiExecTool('get_payments')`'s body at `10726-10740`, the demo-seed `invId` assignments at `4950`/`7077`/`10023`, `unlockInv`'s `_unlockedInvIds[inv.id]=true` at `11722`).
