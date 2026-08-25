# SPEC-INTEG-001 (Phase 2) — Implementation Spec

**Implements:** `docs/REQ-INTEG-001-phase2-v2.md` (requirements-gate: CONDITIONAL PASS v1 → PASS v2, confirmatory re-review — one advisory note, A-5, carried into this spec's §5 design)
**Status:** v1

All line numbers below are cited against `main` @ `93f71e6` (538/538 tests passing). Re-verify against current `main` before build if any time has passed.

**Design note carried forward from the confirmatory re-review's new A-5 finding:** `editInv()` (`index.html:5230-5235`) redirects any invoice whose status is in `LOCKED_STATUSES` straight to `showInvReadOnly()` **before** the real edit modal (`ov-inv`) ever opens. Since the only two non-locked statuses are `Draft` and `Pro-forma`, the real modal — where this phase's new buttons live — can only ever be showing an invoice at one of those two statuses. This means REQ-INTEG-001i/k's `Pro-forma`-status gate cannot be meaningfully tested by "open the modal and check button visibility" for a `Sent`/locked invoice, because that invoice never reaches this modal at all via normal navigation (exactly what the re-review's A-5 finding identified). **Fix, applied throughout this spec:** the gating logic is factored into two small, pure, directly-callable functions (§5) — the same fix pattern already used for REQ-INTEG-001i's `Other`-method validation (§2.2) — so both the UI wiring and the test suite call the same testable logic, rather than relying on simulating navigation through a locked-status redirect.

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
```

This preserve step runs unconditionally for every ordinary Save. §3 below adds the one deliberate exception (clearing on a line-item change) immediately after this block, inside the same `if(EI.i){...}` scope, using the values just preserved here as its "before" state.

`buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod`/`approvalNote` are never set to a real value by this ordinary Save path — only by the dedicated `saveInvApprove()` action (§2), which writes directly to the `DB.inv` record and does not go through `saveInv()`'s form-rebuild at all (see §2.3 for why). Likewise `linkedQuoteId`/`linkedQuoteNum` are only ever set by `saveInvProgress()` (§4).

---

## 2. "Mark Buyer Approved" action (REQ-INTEG-001i)

### 2.1 New HTML — confirmation modal

**File:** append after the existing `</div>` closing the Invoice modal (`index.html:1153`), following the same small-modal structure as `ov-migration-backup` (`2440-2453`):

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

Per REQ-INTEG-001i, the confirm button should be disabled until required fields are filled. Rather than a separate always-on `oninput` disabled-toggle (a second, parallel copy of the validation logic), this spec uses a single validation function (§2.2) invoked both on save and — per the fix in this spec's header note — exposed for direct testing. Spec-gate/implementer discretion: wiring an `oninput` listener that calls the same validation function to toggle `disabled` live is encouraged for UX but not required to satisfy the REQ, since `vInvApprove()` (§2.2) blocks the save regardless.

### 2.2 New function — validation

Mirrors `vQte()`'s pattern (`index.html:10306-10312`) exactly, including the conditional-required rule:

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
  if (G('ov-inv').classList.contains('on') && EI.i === inv.id) editInv(inv.id); // refresh button visibility if the main modal is open on this record
}
```

**Design rationale for bypassing `saveInv()`'s form-rebuild:** `saveInv()` reconstructs the entire Invoice from the main edit form's current field values (§1.1's finding). Routing "Mark Buyer Approved" through it would require the main form to be open, fully valid, and unmodified with respect to line items — an unnecessary coupling for what is otherwise a small, independent state change. Direct mutation of the `DB.inv` record (the same style already used by `unlockInv()`, `index.html:9827-9853`, for a comparable small/independent Invoice-record change) is simpler and cannot be tripped up by unrelated in-progress edits in the main form. If the main Invoice modal happens to be open on this same record, it is refreshed via `editInv(inv.id)` so the visible status/fields stay in sync (this does not lose any unsaved line-item edits materially differently than any other external change would — no different from, e.g., a sync pull updating the same record while the modal is open, which this codebase does not specially guard against elsewhere either).

**Re-confirmation (AC-15):** since `saveInvApprove()` unconditionally overwrites `buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod`/`approvalNote` every time it runs, re-opening `openInvApprove()` on an already-approved invoice (pre-filling from the existing values per the code above) and re-confirming naturally produces a new timestamp and a new `logEv()` entry, exactly as REQ-INTEG-001i/§1.2 item 5 require — no extra "is this a re-approval" branching is needed.

---

## 3. Approval cleared by a line-item edit (REQ-INTEG-001j)

**File:** `index.html:5469-5488`, immediately after the six-field preserve block added in §1.2, still inside `if(EI.i){...}`.

Per this REQ's correction (requirements-gate B-1 — see `REQ-INTEG-001-phase2-v2.md` §7), this is new, standalone logic — it does **not** reuse the existing G-06 mechanism (`5545-5553`, which only compares header fields and aggregate line-count/dollar-total).

```diff
       inv.linkedQuoteId=existing.linkedQuoteId||'';
       inv.linkedQuoteNum=existing.linkedQuoteNum||'';
+      // REQ-INTEG-001j: a genuine per-line comparison — added/removed lines, or any
+      // surviving line's lid/qty/up/desc changed. Deliberately NOT the G-06 mechanism
+      // (5545-5553), which only diffs header fields + aggregate count/total and would
+      // miss e.g. two lines' price changes netting to the same aggregate.
+      if (existing.buyerApprovedAt && invLinesChanged(existing.lineItems||[], inv.lineItems)) {
+        inv.buyerApprovedAt=''; inv.buyerApprovedBy=''; inv.approvalMethod=''; inv.approvalNote='';
+        logEv('invoice', inv.id, 'approval_cleared', 'Buyer approval cleared — line items changed after approval', 'operator');
+      }
       // If no live line items in this save, preserve existing calc_ fields and lineItems
       if(cIL.length===0) {
```

New standalone helper (placed near `saveInv()`, e.g. immediately above it):

```js
function invLinesChanged(before, after) {
  if (before.length !== after.length) return true;
  var byRid = {};
  before.forEach(function(l){ byRid[l.rid] = l; });
  return after.some(function(l){
    var b = byRid[l.rid];
    if (!b) return true; // new rid — a line was added (or an existing one's rid is not in `before`, which cannot happen for a genuinely-surviving line)
    return b.lid !== l.lid || +b.qty !== +l.qty || +b.up !== +l.up || b.desc !== l.desc;
  });
}
```

**Guard against the `cIL.length===0` preserve branch producing a false clear:** when `cIL.length===0`, `inv.lineItems` at the point this check runs is still the *freshly-built empty array* from the main literal (`5451`) — the preserve-onto-`inv.lineItems` reassignment happens a few lines further down (`5484`, inside the `if(cIL.length===0)` block), i.e. **after** this new check per the diff above. An empty `cIL` save would therefore make `invLinesChanged()` see `after=[]` against a non-empty `before`, incorrectly detecting "all lines removed" and clearing approval on a save that isn't actually touching line items at all (the classic "no live line items in this save" case `saveInv()`'s own comment already documents, e.g. a save triggered by a code path that doesn't touch `cIL`). **This must be placed after** the existing `if(cIL.length===0){ ...; inv.lineItems=existing.lineItems||[]; }` block resolves `inv.lineItems` to its final value for this save, not before it as drawn in the diff skeleton above — the diff placement shown is illustrative of *which fields it depends on*, not the final line order; the implementer must move this block to after `5485` (`inv.lineItems = existing.lineItems||[];`) so `inv.lineItems` is always the real, final line-item set for this save before `invLinesChanged()` runs. This ordering requirement is called out explicitly here because getting it wrong produces a subtle, hard-to-notice false-positive clear.

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

Per REQ-INTEG-001k, this action never touches `inv.status`, never touches any `DB.ord` record's `stage`, and does not call `ordCanTransition()`. Re-running it (AC-12) is naturally supported — `saveInvProgress()` simply overwrites `linkedQuoteId`/`linkedQuoteNum` again and logs a fresh event, exactly as `saveInvApprove()` does for re-approval.

---

## 5. Visibility/availability gating (resolves confirmatory re-review's A-5)

New pure functions, placed near `canTransitionStatus()`/`ordCanTransition()` (`index.html:2580-2683`) since they are the same category of "is this action currently legal" logic, just for Invoice's two new actions rather than a status transition:

```js
function invApprovalActionVisible(inv) {
  return !!inv && inv.status === 'Pro-forma';
}
function invProgressActionVisible(inv) {
  return !!inv && inv.status === 'Pro-forma' && !!inv.buyerApprovedAt;
}
```

These satisfy REQ-INTEG-001i's "available only when `Pro-forma`" and REQ-INTEG-001k's "available only when `Pro-forma` **and** `buyerApprovedAt` is set" requirements as directly-testable, pure functions — callable with a plain object literal in a test, with no need to drive `editInv()`'s locked-status redirect (per this spec's opening design note). AC-4/AC-16 (and the pre-existing gap the re-review noted in AC-4's own original phrasing) are satisfied by calling these functions directly with `{status:'Draft'}`, `{status:'Sent'}`, `{status:'Pro-forma', buyerApprovedAt:''}`, etc. — not by attempting to open a locked invoice's edit modal, which (per §0's design note) never reaches `ov-inv` at all.

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

### 5.2 Wiring into `editInv()`

**File:** `index.html:5230-5237`, after the existing status-dropdown line:

```diff
   G('inv-mt').textContent='Edit Invoice'; G('inv-sm').value=inv.status||'Draft';
+  G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
+  G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
   G('if-n').value=inv.num||'';
```

`openInv()` (brand-new Invoice, `index.html:5175-5192`) needs an explicit `style.display='none'` for both buttons too, since a brand-new Invoice has no `id` yet and both actions require an existing record:

```diff
   G('inv-mt').textContent='New Invoice'; G('inv-sm').value='Draft';
+  G('inv-approve-btn').style.display='none'; G('inv-progress-btn').style.display='none';
```

---

## 6. FM-1 / sync-mapping confirmation (implementation-level, matches REQ-INTEG-001l)

No change to `FIELD_MAPS` (`index.html:3817-3831`ish, `inv:` at `3820`), `mapRec()`, `unmapRec()`, `apps-script/Code.gs`, or any `syncEnt`/`pullAll`/`pushAll` entity list. All six new fields are local-only additions on the already-synced Invoice entity, consistent with the existing `pos` precedent and Phase 1's `sourceInvUp`/`sourceOrdId` precedents.

---

## 7. Test plan (maps to `docs/REQ-INTEG-001-phase2-v2.md` §3)

One test per acceptance criterion at minimum, mirroring `tests/run.js` conventions:

- **AC-1** — call `saveInv()` on a brand-new invoice, assert all six new fields are present and falsy.
- **AC-2** — build an invoice at `Pro-forma`, call `openInvApprove(id)` then `saveInvApprove()` with `G('ia-method').value='Email'`, `G('ia-by').value='J. Smith'`; assert the four fields and a `buyer_approved` `logEv()` entry.
- **AC-3** — call `vInvApprove()` directly with `ia-method='Other'` and `ia-note=''`; assert it returns `false` and `ia-verr` contains the expected message (the direct-function-call fix from §2.2, resolving the REQ's open question 5).
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
- **AC-14** — build an invoice with `buyer` matching no Quote's `client`; call `populateInvProgressQte(inv)`; assert the resulting `<select>` still lists every Quote plus the "-- None --" default (no false-empty list).
- **AC-15** — approve an invoice (AC-2), capture `buyerApprovedAt`, then `openInvApprove(id)` again with a different Method and `saveInvApprove()` again; assert `buyerApprovedAt` is a **new**, later timestamp, `approvalMethod` reflects the new value, and a second, distinct `buyer_approved` event exists in the log (the first is still present) — proves the deliberate re-stamp exception (REQ-INTEG-001i/§1.2 item 5).
- **AC-16** — call `invProgressActionVisible({status:'Sent', buyerApprovedAt:'2026-01-01T00:00:00.000Z'})`; assert `false`, even though `buyerApprovedAt` is set — proves the `Pro-forma`-status gate is independent of the approval gate (this resolves the confirmatory re-review's A-5 finding: tested via the pure gating function directly, not via a locked-status modal-navigation path that can never reach `ov-inv`).
- **Regression guard for §3's ordering requirement:** a dedicated test that saves an invoice with `cIL.length===0` (the "preserve existing lineItems" branch) on an already-approved invoice with **no actual line-item change** intended, asserting approval is **not** incorrectly cleared — this is the exact false-positive scenario §3 calls out and must be caught if the ordering is implemented wrong.

---

## 8. Open items carried to build (not blocking, per REQ §5)

- Exact button placement (§5.1 places them in the footer row; REQ §5 item 4 left this to spec-gate/implementer discretion — this spec's placement is the concrete decision, adjustable if it reads poorly in the actual modal).
- Exact `logEv()` summary wording (§2.3/§4.2 above are this spec's concrete proposal, satisfying REQ §5 item 3).
