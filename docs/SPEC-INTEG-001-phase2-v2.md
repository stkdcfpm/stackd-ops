# SPEC-INTEG-001 (Phase 2) — Implementation Spec

**Implements:** `docs/REQ-INTEG-001-phase2-v2.md` (requirements-gate: CONDITIONAL PASS v1 → PASS v2, confirmatory re-review — one advisory note, A-5, carried into this spec's §5 design)
**Status:** v2 — supersedes v1. Independent spec-gate review of v1 returned CONDITIONAL PASS (2 blocking findings, 5 advisory) — all seven addressed below; see §10 for the full review-resolution log.

All line numbers below are cited against `main` @ `df06bb6` (538/538 tests passing). Re-verify against current `main` before build if any time has passed.

**Design note carried forward from the confirmatory re-review's A-5 finding:** `editInv()` (`index.html:5230-5235`) redirects any invoice whose status is in `LOCKED_STATUSES` straight to `showInvReadOnly()` **before** the real edit modal (`ov-inv`) ever opens. Since the only two non-locked statuses are `Draft` and `Pro-forma`, the real modal — where this phase's new buttons live — can only ever be showing an invoice at one of those two statuses. This means REQ-INTEG-001i/k's `Pro-forma`-status gate cannot be meaningfully tested by "open the modal and check button visibility" for a `Sent`/locked invoice, because that invoice never reaches this modal at all via normal navigation. **Fix, applied throughout this spec:** the gating logic is factored into two small, pure, directly-callable functions (§5) — the same fix pattern already used for REQ-INTEG-001i's `Other`-method validation (§2.2) — so both the UI wiring and the test suite call the same testable logic, rather than relying on simulating navigation through a locked-status redirect. Independently confirmed by spec-gate: only `openInv()` and `editInv()` ever open `ov-inv`, and `editInv()`'s redirect is real.

---

## 1. `saveInv()` — six new fields (schema, REQ-INTEG-001h)

**File:** `index.html:5439-5488`.

**1.1 — defaults on the initial object literal:**

```diff
     incoterm:G('if-inco').value, paymentTerms:G('if-pt').value.trim(),
     terms:G('if-terms').value.trim(), chargesIncluded:G('if-chi').checked, status:G('inv-sm').value,
     lineItems:cIL.map(function(li){ return {rid:li.rid||uid(),lid:li.lid||'',desc:li.desc||'',uom:li.uom||'',qty:+li.qty||0,up:+li.up||0,unitCost:+li.unitCost||0,lineType:li.lineType||'product'}; }), pos:[],
+    buyerApprovedAt: '', buyerApprovedBy: '', approvalMethod: '', approvalNote: '',
+    linkedQuoteId: '', linkedQuoteNum: '',
     type:(function(){ if(!isCN(G('if-n').value.trim())) return 'invoice'; return (G('if-cn-goodwill')&&G('if-cn-goodwill').checked)?'goodwill_credit':'credit_note'; })(),
```

**1.2 — preserve on every edit-save**, alongside the existing `inv.pos=existing.pos||[];` line:

```diff
   if(EI.i){
     var idx=DB.inv.findIndex(function(x){return x.id===EI.i;});
     if(idx>-1){
       var existing=DB.inv[idx];
       inv.pos=existing.pos||[];
+      inv.buyerApprovedAt=existing.buyerApprovedAt||'';
+      inv.buyerApprovedBy=existing.buyerApprovedBy||'';
+      inv.approvalMethod=existing.approvalMethod||'';
+      inv.approvalNote=existing.approvalNote||'';
+      inv.linkedQuoteId=existing.linkedQuoteId||'';
+      inv.linkedQuoteNum=existing.linkedQuoteNum||'';
       // If no live line items in this save, preserve existing calc_ fields and lineItems
       if(cIL.length===0) {
         inv.calc_grandTotal = existing.calc_grandTotal||inv.calc_grandTotal||'0';
         inv.calc_cogs       = existing.calc_cogs||'0';
         inv.calc_grossProfit= existing.calc_grossProfit||'0';
         inv.calc_netProfit  = existing.calc_netProfit||'0';
         inv.calc_margin     = existing.calc_margin||'0';
         inv.calc_balanceDue = existing.calc_balanceDue||'0';
         inv.calc_liTotal    = existing.calc_liTotal||'0';
         inv.calc_taxAmt     = existing.calc_taxAmt||'0';
         inv.lineItems       = existing.lineItems||[];
       }
+      // REQ-INTEG-001j — see §3. Placed HERE, after the cIL.length===0 block above has
+      // resolved inv.lineItems to its final value for this save, and immediately before
+      // DB.inv[idx]=inv below — never earlier. See §3 for why the ordering matters.
+      if (existing.buyerApprovedAt && invLinesChanged(existing.lineItems||[], inv.lineItems)) {
+        inv.buyerApprovedAt=''; inv.buyerApprovedBy=''; inv.approvalMethod=''; inv.approvalNote='';
+        logEv('invoice', inv.id, 'approval_cleared', 'Buyer approval cleared — line items changed after approval', 'operator');
+      }
       DB.inv[idx]=inv;
     }
   }
```

This preserve step runs unconditionally for every ordinary Save. The new block right before `DB.inv[idx]=inv;` is the one deliberate exception (clearing on a line-item change) — see §3 for the full design and the correctness-critical reason it must sit exactly there.

`buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod`/`approvalNote` are never set to a real value by this ordinary Save path — only by the dedicated `saveInvApprove()` action (§2), which writes directly to the `DB.inv` record and does not go through `saveInv()`'s form-rebuild at all (see §2.3 for why). Likewise `linkedQuoteId`/`linkedQuoteNum` are only ever set by `saveInvProgress()` (§4).

---

## 2. "Mark Buyer Approved" action (REQ-INTEG-001i)

### 2.1 New HTML — confirmation modal

**File:** append after the existing `</div>` closing the Invoice modal (`index.html:1153`):

```diff
   </div>
 </div>
+
+<div class="ov" id="ov-inv-approve" onclick="if(event.target===this)closeM('ov-inv-approve')">
+  <div class="modal" style="max-width:460px;">
+    <div class="mh"><h2 style="font-size:.75rem;">Mark Buyer Approved</h2><button class="mx" onclick="closeM('ov-inv-approve')">&#215;</button></div>
+    <div class="mb">
+      <div class="fld"><label>Approval Method</label>
+        <select id="ia-method" onchange="updInvApproveNoteReq()">
+          <option value="">Select method...</option>
+          <option>Email</option><option>WhatsApp</option><option>WeChat</option>
+          <option>Phone / Verbal</option><option>Other</option>
+        </select>
+      </div>
+      <div class="fld"><label>Approved By</label><input type="text" id="ia-by" placeholder="Name of person who confirmed"></div>
+      <div class="fld"><label id="ia-note-lbl">Approval Note</label><textarea id="ia-note"></textarea></div>
+      <div id="ia-verr" class="verr" style="margin-bottom:8px;"></div>
+      <div style="display:flex;gap:8px;justify-content:flex-end;">
+        <button class="btn btn-g" onclick="closeM('ov-inv-approve')">Cancel</button>
+        <button class="btn btn-s" onclick="saveInvApprove()">Mark Buyer Approved</button>
+      </div>
+    </div>
+  </div>
+</div>
```

Per REQ-INTEG-001i, the confirm button should be disabled until required fields are filled. Rather than a separate always-on `oninput` disabled-toggle (a second, parallel copy of the validation logic), this spec uses a single validation function (§2.2) invoked both on save and exposed for direct testing. Wiring an `oninput` listener that calls the same validation function to toggle `disabled` live is encouraged for UX but not required to satisfy the REQ, since `vInvApprove()` (§2.2) blocks the save regardless.

### 2.2 New function — validation

Mirrors `vQte()`'s pattern (`index.html:10304-10314`, corrected from v1's `10306-10312` citation), including the conditional-required rule:

```js
function vInvApprove() {
  var errs = [];
  if (!G('ia-method').value) errs.push('Approval Method is required');
  if (!G('ia-by').value.trim()) errs.push('Approved By is required');
  if (G('ia-method').value === 'Other' && !G('ia-note').value.trim()) errs.push('Approval Note is required when Method is Other');
  G('ia-verr').textContent = errs.join(' · ');
  return errs.length === 0;
}
function updInvApproveNoteReq() {
  var lbl = G('ia-note-lbl');
  if (lbl) lbl.textContent = G('ia-method').value === 'Other' ? 'Approval Note (required)' : 'Approval Note';
}
```

This directly resolves the confirmatory re-review's A-3-derived open question (§5 item 5 of the REQ): `vInvApprove()` is callable in isolation, exactly like `vQte()`, giving AC-3 a real, direct test surface.

### 2.3 New function — save action (direct mutation, not via `saveInv()`)

```js
var _apprInvId = null;

function openInvApprove(id) {
  var inv = DB.inv.find(function(x){ return x.id === id; });
  if (!inv || !invApprovalActionVisible(inv)) return; // §5 — Pro-forma only
  _apprInvId = id;
  G('ia-method').value = inv.approvalMethod || '';
  G('ia-by').value = inv.buyerApprovedBy || '';
  G('ia-note').value = inv.approvalNote || '';
  G('ia-verr').textContent = '';
  updInvApproveNoteReq();
  G('ov-inv-approve').classList.add('on');
}

function saveInvApprove() {
  if (!vInvApprove()) return;
  var inv = DB.inv.find(function(x){ return x.id === _apprInvId; });
  if (!inv) return;
  inv.buyerApprovedAt = new Date().toISOString();
  inv.buyerApprovedBy = G('ia-by').value.trim();
  inv.approvalMethod = G('ia-method').value;
  inv.approvalNote = G('ia-note').value.trim();
  inv.updAt = new Date().toISOString();
  sv(K.i, DB.inv);
  logEv('invoice', inv.id, 'buyer_approved', 'Buyer approval recorded — ' + inv.approvalMethod + ' (by ' + inv.buyerApprovedBy + ')', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-approve');
  toast('Buyer approval recorded');
  rInv();
  // Refresh only the two button visibilities if the main modal is open on this record —
  // NOT a full editInv() call, which would reset cIL and discard any unsaved, in-progress
  // line-item edits (corrected from v1 — see §10, A-3).
  if (G('ov-inv').classList.contains('on') && EI.i === inv.id) {
    G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
    G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
  }
}
```

**Design rationale for bypassing `saveInv()`'s form-rebuild:** `saveInv()` reconstructs the entire Invoice from the main edit form's current field values (§1.1's finding). Routing "Mark Buyer Approved" through it would require the main form to be open, fully valid, and unmodified with respect to line items — an unnecessary coupling for what is otherwise a small, independent state change. Direct mutation of the `DB.inv` record, followed by the same `sv(K.i, DB.inv)` call `saveInv()` itself uses (`index.html:5559`, confirmed identical persistence — `K.i` is `'st_i'`, `index.html:2548`; `sv()` at `3249-3259`), is simpler and cannot be tripped up by unrelated in-progress edits in the main form. (Corrected from v1 — see §10, A-1: `unlockInv()`, `index.html:9827-9853`, was cited as precedent for this pattern in v1, but on closer inspection it never mutates a persisted field or calls `sv()` itself — it only sets a transient in-memory override flag. It is not real precedent for "mutate + persist outside `saveInv()`"; the direct-mutation design here is new, but verified safe on its own terms via the `sv()`/`K.i` check above, not via that citation.)

**Accepted gap — no `syncEnt()` call (see §10, A-2):** unlike `saveInv()` (`index.html:5565`, `await syncEnt('inv',inv)`), neither `saveInvApprove()` nor `saveInvProgress()` (§4) pushes the updated record to Sheets sync. Since `FIELD_MAPS.inv` (`index.html:3820`) tracks none of the six new fields, and neither function changes any field it does track, there is no observable sync-content gap today. This is called out explicitly so it is not silently forgotten if any of these six fields is ever added to `FIELD_MAPS.inv` in a future phase — at that point this gap would need a `syncEnt()` call added to both functions.

**Re-confirmation (AC-15):** since `saveInvApprove()` unconditionally overwrites `buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod`/`approvalNote` every time it runs, re-opening `openInvApprove()` on an already-approved invoice (pre-filling from the existing values per the code above) and re-confirming naturally produces a new timestamp and a new `logEv()` entry, exactly as REQ-INTEG-001i/§1.2 item 5 require — no extra "is this a re-approval" branching is needed.

---

## 3. Approval cleared by a line-item edit (REQ-INTEG-001j)

**File:** the actual insertion is shown in place, in context, in §1.2 above — right before `DB.inv[idx]=inv;` (current `index.html:5486`), **after** the entire `if(cIL.length===0){...}` block (current `index.html:5475-5485`) has finished resolving `inv.lineItems` to its final value for this save. This is a correction from v1, which drew the diff in the wrong position and relied on a follow-up paragraph to redirect the reader — spec-gate flagged that as too risky for a change that touches financial-approval data (see §10, B-1). §1.2 above is now the single, correct source of truth for placement; do not use any other line-order shown elsewhere in this document.

Per the requirements-gate's own correction (`REQ-INTEG-001-phase2-v2.md` §7, B-1), this is new, standalone logic — it does **not** reuse the existing G-06 mechanism (`index.html:5545-5553`, which only compares header fields and aggregate line-count/dollar-total).

New standalone helper (placed near `saveInv()`, e.g. immediately above it):

```js
function invLinesChanged(before, after) {
  if (before.length !== after.length) return true;
  var byKey = {};
  before.forEach(function(l, i){ byKey[l.rid || ('_idx'+i)] = l; });
  return after.some(function(l, i){
    var b = byKey[l.rid || ('_idx'+i)];
    if (!b) return true; // no matching prior line — a line was added
    return b.lid !== l.lid || +b.qty !== +l.qty || +b.up !== +l.up || b.desc !== l.desc;
  });
}
```

**Why the `rid`-or-index fallback (corrected from v1 — see §10, A-4):** v1 keyed purely by `rid`, which is stable for every line added or edited through the normal Invoice-modal UI (`quickAddLine()`/`addILI()` mint a fresh `uid()` rid on add, `rILT()`'s inline edits mutate fields in place without touching `rid`, `remILI()` removes by `rid`). But at least one seeded demo record (`DINV-0001`, `index.html:4287`) has `lineItems` with **no `rid` field at all** — a real, concrete case, not hypothetical. Without the fallback, re-saving such an invoice (with genuinely no line-item change) would have every line register as "no rid match" on both sides, since `saveInv()`'s literal always mints a fresh `rid:li.rid||uid()` (`index.html:5451`) for a line that had none, while `existing.lineItems` still has none — a false "everything changed" reading that would incorrectly clear approval on an unrelated save. Falling back to the array index as the match key when `rid` is absent closes this: the line counts are already confirmed equal (the length check above), so positional matching is a safe, deterministic fallback exactly for this legacy-data case, while remaining dormant (never triggered) for any line that already has a real `rid`.

**Guard against the `cIL.length===0` preserve branch producing a false clear:** this is precisely why §1.2 places the check after, not before, that block resolves `inv.lineItems`. Before the fix, a save with `cIL.length===0` would see `inv.lineItems` still as the freshly-built empty array from the main literal (`index.html:5451`), making `invLinesChanged()` see `after=[]` against a non-empty `before` — a false "all lines removed." §1.2's placement, after `inv.lineItems=existing.lineItems||[];` (`index.html:5484`) has already run, ensures `inv.lineItems` is always the real, final line-item set for this save before `invLinesChanged()` runs, so this scenario correctly reads as "unchanged."

---

## 4. "Progress to Invoicing" action (REQ-INTEG-001k)

### 4.1 New HTML — confirmation modal

**File:** append after the `ov-inv-approve` modal from §2.1:

```diff
+<div class="ov" id="ov-inv-progress" onclick="if(event.target===this)closeM('ov-inv-progress')">
+  <div class="modal" style="max-width:460px;">
+    <div class="mh"><h2 style="font-size:.75rem;">Progress to Invoicing</h2><button class="mx" onclick="closeM('ov-inv-progress')">&#215;</button></div>
+    <div class="mb">
+      <p style="font-size:.55rem;margin-bottom:10px;color:var(--m);">Optionally record which Quote this Invoice corresponds to, for audit trail. This does not change the Invoice's status.</p>
+      <div class="fld"><label>Linked Quote (optional)</label><select id="ip-qt"></select></div>
+      <div style="display:flex;gap:8px;justify-content:flex-end;">
+        <button class="btn btn-g" onclick="closeM('ov-inv-progress')">Cancel</button>
+        <button class="btn btn-s" onclick="saveInvProgress()">Progress to Invoicing</button>
+      </div>
+    </div>
+  </div>
+</div>
```

### 4.2 New functions

```js
var _progInvId = null;

function populateInvProgressQte(inv) {
  var el = G('ip-qt');
  if (!el) return;
  var sorted = DB.qt.slice().sort(function(a,b){ return (b.dt||'') > (a.dt||'') ? 1 : -1; });
  var buyerLc = (inv.buyer||'').toLowerCase();
  var matched = sorted.filter(function(q){ return buyerLc && (q.client||'').toLowerCase() === buyerLc; });
  var rest = matched.length ? sorted.filter(function(q){ return matched.indexOf(q) === -1; }) : sorted;
  var opt = function(q){ return '<option value="' + san(q.id) + '"' + (q.id === inv.linkedQuoteId ? ' selected' : '') + '>' + san(q.num) + ' — ' + san(q.client) + '</option>'; };
  el.innerHTML = '<option value="">-- None / not applicable --</option>'
    + matched.map(opt).join('')
    + rest.map(opt).join('');
}

function openInvProgress(id) {
  var inv = DB.inv.find(function(x){ return x.id === id; });
  if (!inv || !invProgressActionVisible(inv)) return; // §5 — Pro-forma + already approved
  _progInvId = id;
  populateInvProgressQte(inv);
  G('ov-inv-progress').classList.add('on');
}

function saveInvProgress() {
  var inv = DB.inv.find(function(x){ return x.id === _progInvId; });
  if (!inv) return;
  var qId = G('ip-qt').value;
  var q = qId ? DB.qt.find(function(x){ return x.id === qId; }) : null;
  inv.linkedQuoteId = q ? q.id : '';
  inv.linkedQuoteNum = q ? q.num : '';
  inv.updAt = new Date().toISOString();
  sv(K.i, DB.inv);
  logEv('invoice', inv.id, 'progressed_to_invoicing', q ? ('Progressed to invoicing — linked Quote ' + q.num) : 'Progressed to invoicing — no Quote linked', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-progress');
  toast('Progressed to invoicing');
  rInv();
}
```

Per REQ-INTEG-001k, this action never touches `inv.status`, never touches any `DB.ord` record's `stage`, and does not call `ordCanTransition()`. Re-running it (AC-12) is naturally supported — `saveInvProgress()` simply overwrites `linkedQuoteId`/`linkedQuoteNum` again and logs a fresh event, exactly as `saveInvApprove()` does for re-approval. Same accepted `syncEnt()` gap as §2.3 above applies here too.

---

## 5. Visibility/availability gating (resolves confirmatory re-review's A-5)

New pure functions, placed near `canTransitionStatus()`/`ordCanTransition()` (`index.html:2580-2683`):

```js
function invApprovalActionVisible(inv) {
  return !!inv && inv.status === 'Pro-forma';
}
function invProgressActionVisible(inv) {
  return !!inv && inv.status === 'Pro-forma' && !!inv.buyerApprovedAt;
}
```

These satisfy REQ-INTEG-001i's "available only when `Pro-forma`" and REQ-INTEG-001k's "available only when `Pro-forma` **and** `buyerApprovedAt` is set" requirements as directly-testable, pure functions — callable with a plain object literal in a test, with no need to drive `editInv()`'s locked-status redirect. AC-4/AC-16 are satisfied by calling these functions directly with `{status:'Draft'}`, `{status:'Sent'}`, `{status:'Pro-forma', buyerApprovedAt:''}`, etc. — not by attempting to open a locked invoice's edit modal, which never reaches `ov-inv` at all.

### 5.1 Wiring into the Invoice modal footer

**File:** `index.html:1146-1150`:

```diff
       <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;">
         <button class="btn btn-g" onclick="closeM('ov-inv')">Cancel</button>
+        <button class="btn btn-o" id="inv-approve-btn" style="display:none;" onclick="openInvApprove(EI.i)">Mark Buyer Approved</button>
+        <button class="btn btn-o" id="inv-progress-btn" style="display:none;" onclick="openInvProgress(EI.i)">Progress to Invoicing</button>
         <button class="btn btn-o" id="inv-prev-btn" onclick="prevInv()">Preview Invoice</button>
         <button class="btn btn-s" id="inv-save-btn" onclick="saveInv()">Save Invoice</button>
       </div>
```

### 5.2 Wiring into `editInv()` and `openInv()`

**File:** `index.html:5230-5237`, after the existing status-dropdown line:

```diff
   G('inv-mt').textContent='Edit Invoice'; G('inv-sm').value=inv.status||'Draft';
+  G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
+  G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
   G('if-n').value=inv.num||'';
```

`openInv()` (brand-new Invoice, `index.html:5175-5192`) needs an explicit `style.display='none'` for both buttons too, since a brand-new Invoice has no `id` yet:

```diff
   G('inv-mt').textContent='New Invoice'; G('inv-sm').value='Draft';
+  G('inv-approve-btn').style.display='none'; G('inv-progress-btn').style.display='none';
```

Confirmed by spec-gate: `openInv()` and `editInv()` are the only two code paths that ever open `ov-inv` — no other function needs equivalent wiring.

---

## 6. FM-1 / sync-mapping confirmation (implementation-level, matches REQ-INTEG-001l)

No change to `FIELD_MAPS` (`index.html:3817`, `inv:` at `3820`), `mapRec()`, `unmapRec()`, `apps-script/Code.gs`, or any `pullAll`/`pushAll` entity list. All six new fields are local-only additions on the already-synced Invoice entity, consistent with the existing `pos` precedent and Phase 1's `sourceInvUp`/`sourceOrdId` precedents. See §2.3's accepted-gap note for the one related, explicitly-disclosed caveat (`syncEnt()` is not called by the two new direct-mutation actions).

---

## 7. CSV import — preserve the six new fields (REQ-INTEG-001h, extended scope — new in v2, see §10 B-2)

Spec-gate found a real, concretely-demonstrated gap: two CSV-import code paths replace an existing `DB.inv` record wholesale, entirely bypassing `saveInv()` and its §1.2 preserve block. Both already preserve `pos` using the exact pattern this REQ requires extending to the six new fields — they simply weren't touched in v1.

**7.1 — `processImport()`, `entity==='inv'` branch.** **File:** `index.html:7445`:

```diff
-        lineItems:existing?existing.lineItems:[], pos:existing?existing.pos:[],
+        lineItems:existing?existing.lineItems:[], pos:existing?existing.pos:[],
+        buyerApprovedAt:existing?existing.buyerApprovedAt:'', buyerApprovedBy:existing?existing.buyerApprovedBy:'',
+        approvalMethod:existing?existing.approvalMethod:'', approvalNote:existing?existing.approvalNote:'',
+        linkedQuoteId:existing?existing.linkedQuoteId:'', linkedQuoteNum:existing?existing.linkedQuoteNum:'',
```

**7.2 — `processImportRecords()`, the analogous branch.** **File:** `index.html:7776-7777`:

```diff
         lineItems:existing?existing.lineItems:[],
         pos:existing?existing.pos:[],
+        buyerApprovedAt:existing?existing.buyerApprovedAt:'', buyerApprovedBy:existing?existing.buyerApprovedBy:'',
+        approvalMethod:existing?existing.approvalMethod:'', approvalNote:existing?existing.approvalNote:'',
+        linkedQuoteId:existing?existing.linkedQuoteId:'', linkedQuoteNum:existing?existing.linkedQuoteNum:'',
```

Both branches match an existing invoice by `num` (`DB.inv.findIndex(function(x){return x.num===num;})`, `index.html:7451`/`7783`) and replace it wholesale (`DB.inv[i]=rec;`). Without this fix, re-importing or updating an already-approved invoice via either importer would silently drop all six new fields with no error and no log entry — exactly the class of bug this initiative exists to prevent. This fix does **not** apply REQ-INTEG-001j's line-item-change clearing logic to the import path (out of scope — imports are a distinct, bulk, operator-initiated action, and the REQ's clearing rule is specifically about the ordinary single-record `saveInv()` edit flow); it only ensures the fields survive an import the same way `pos` already does.

---

## 8. Test plan (maps to `docs/REQ-INTEG-001-phase2-v2.md` §3)

One test per acceptance criterion at minimum, mirroring `tests/run.js` conventions:

- **AC-1** — call `saveInv()` on a brand-new invoice, assert all six new fields are present and falsy.
- **AC-2** — build an invoice at `Pro-forma`, call `openInvApprove(id)` then `saveInvApprove()` with `G('ia-method').value='Email'`, `G('ia-by').value='J. Smith'`; assert the four fields and a `buyer_approved` `logEv()` entry.
- **AC-3** — call `vInvApprove()` directly with `ia-method='Other'` and `ia-note=''`; assert it returns `false` and `ia-verr` contains the expected message.
- **AC-4** — call `invApprovalActionVisible({status:'Draft'})` and `invApprovalActionVisible({status:'Sent'})`; assert both return `false`.
- **AC-5** — approve an invoice (AC-2), then `saveInv()` with only a header field changed (same `cIL` as before); assert all four approval fields unchanged and no new `approval_cleared` event.
- **AC-6** — approve an invoice, then change a line's `qty` or `up` in `cIL` and `saveInv()`; assert all four approval fields cleared and an `approval_cleared` event logged.
- **AC-7** — approve an invoice, then add or remove a line in `cIL` and `saveInv()`; assert the same clearing behavior as AC-6.
- **AC-8** — an invoice never approved (`buyerApprovedAt` falsy); edit its lines and `saveInv()`; assert no `approval_cleared` event is logged.
- **AC-9** — approve an invoice, `openInvProgress(id)` then `saveInvProgress()` with `G('ip-qt').value=''`; assert `linkedQuoteId`/`linkedQuoteNum` remain empty, a `progressed_to_invoicing` event is logged noting no link, and `inv.status` is unchanged.
- **AC-10** — same, but `G('ip-qt').value` set to a real Quote's id; assert `linkedQuoteId`/`linkedQuoteNum` are set and `inv.status` is unchanged.
- **AC-11** — call `invProgressActionVisible({status:'Pro-forma', buyerApprovedAt:''})`; assert `false`.
- **AC-12** — after AC-10, call `saveInvProgress()` again with a different Quote selected; assert the fields update to the new selection and a second, distinct `progressed_to_invoicing` event exists in the log (the first is still present).
- **AC-13** — full suite regression: re-run `node tests/run.js`, confirm the pre-existing count (re-verify the exact number at build time — do not hardcode `538`) plus all new tests pass.
- **AC-14** — build an invoice with `buyer` matching no Quote's `client`; call `populateInvProgressQte(inv)`; assert the resulting `<select>` still lists every Quote plus the "-- None --" default.
- **AC-15** — approve an invoice (AC-2), capture `buyerApprovedAt`, then `openInvApprove(id)` again with a different Method and `saveInvApprove()` again; assert `buyerApprovedAt` is a **new**, later timestamp, `approvalMethod` reflects the new value, and a second, distinct `buyer_approved` event exists in the log (the first is still present).
- **AC-16** — call `invProgressActionVisible({status:'Sent', buyerApprovedAt:'2026-01-01T00:00:00.000Z'})`; assert `false`, even though `buyerApprovedAt` is set.
- **Regression guard for §1.2/§3's ordering (unchanged from v1):** a dedicated test that saves an invoice with `cIL.length===0` on an already-approved invoice with no actual line-item change intended, asserting approval is **not** incorrectly cleared.
- **New regression guard (§3, rid-fallback):** build an invoice whose `lineItems` have no `rid` field at all (mirroring `DINV-0001`'s shape), approve it, then re-save with `cIL` reflecting the exact same lines (freshly `uid()`-assigned `rid`s, since the literal always mints one when absent); assert approval is **not** cleared — proves the index-fallback fix in §3.
- **New regression guard (§7, CSV import):** import-update an already-approved invoice (matched by `num`) via both `processImport()` and `processImportRecords()`; assert all six fields survive unchanged on the resulting record — proves the B-2 fix.

---

## 9. Open items carried to build (not blocking, per REQ §5)

- Exact button placement (§5.1 places them in the footer row; REQ §5 item 4 left this to spec-gate/implementer discretion — this spec's placement is the concrete decision, adjustable if it reads poorly in the actual modal).
- Exact `logEv()` summary wording (§2.3/§4.2 above are this spec's concrete proposal, satisfying REQ §5 item 3).

---

## 10. Spec-gate review resolution log (v1 → v2)

An independent spec-gate review of v1 returned **CONDITIONAL PASS** with 2 blocking findings and 5 advisory findings, all addressed in this v2:

- **B-1 (blocking):** v1's §3 drew the `invLinesChanged()` insertion diff in the *wrong* position (right after the six-field preserve block, before the `cIL.length===0` block resolves `inv.lineItems`), then relied on a follow-up paragraph telling the reader to move it — a real risk for a change that could silently clear financial-approval data if built as literally diagrammed. **Fixed:** §1.2 now shows the single, correct, final placement in context (immediately before `DB.inv[idx]=inv;`, after the `cIL.length===0` block) with no separate "wrong version, please fix" diagram anywhere in the document; §3 points back to §1.2 as the sole source of truth. The `5484`/`5485` line-content mislabel from v1's prose is also corrected.
- **B-2 (blocking):** v1 never extended the six-field preserve pattern to `processImport()` (`index.html:7445`) or `processImportRecords()` (`index.html:7776-7777`), both of which replace an existing `DB.inv` record wholesale, bypassing `saveInv()` entirely — both already preserve `pos` with the exact pattern this REQ needed extended, just not to the six new fields. **Fixed:** new §7 adds the identical preserve pattern to both import branches, plus a new regression-guard test.
- **A-1 (advisory):** v1 cited `unlockInv()` as precedent for "mutate + persist outside `saveInv()`," but `unlockInv()` never mutates a persisted field or calls `sv()` — it only sets a transient override flag. **Fixed:** §2.3 no longer relies on that citation as precedent; the design is instead verified safe directly via `sv()`/`K.i`'s persistence behavior, confirmed identical to `saveInv()`'s own call.
- **A-2 (advisory):** neither new action calls `syncEnt('inv', inv)`, unlike `saveInv()`. **Fixed:** §2.3 now explicitly discloses this as an accepted gap with no current observable effect (none of the six fields are in `FIELD_MAPS.inv`), flagged for revisiting if that ever changes.
- **A-3 (advisory):** v1's `saveInvApprove()` refreshed an open main modal via a full `editInv(inv.id)` call, which resets `cIL` and would silently discard any unsaved, in-progress line-item edits. **Fixed:** §2.3 now only re-toggles the two button visibilities directly, using the same pure gating functions, with no side effect on `cIL`.
- **A-4 (advisory):** v1's `invLinesChanged()` matched lines by `rid` only, which fails for at least one real seeded record (`DINV-0001`, `index.html:4287`) whose `lineItems` have no `rid` at all — a concrete, demonstrated false-clear risk, not hypothetical. **Fixed:** §3's comparison now falls back to array-index matching when `rid` is absent, with a new regression-guard test.
- **A-5 (advisory):** v1 cited `vQte()`'s pattern as `index.html:10306-10312`; the function itself starts at `10304`. **Fixed:** citation corrected in §2.2.
