# SPEC-WEBHOOK-001: Generic outbound-webhook automation rules, first rule: Invoice buyer-approval → Make.com email with invoice PDF

**Status:** v1 — drafted from the fully-resolved `docs/REQ-WEBHOOK-001-v1.md` (requirements-gate complete, 6 rounds, final PASS). Every `index.html:NNN` citation in this document verified via `node scripts/check-req-citations.js docs/SPEC-WEBHOOK-001-v1.md` before submission, per `CLAUDE.md`'s standing pre-gate step.

This SPEC touches only `SS.*` (a plain, already-`sv(K.ss,...)`-persisted local settings object) and `index.html`'s UI/logic. **No Supabase schema change, no new `K`/`DB` entity, no Cloud Data migration** — `SS.webhookRules` is confirmed local-only by design (REQ Decision 7), so this is the first REQ in the recent Cloud Data series that needs no `schema-migration-reviewer` pass.

---

## 1. New module-level constant + `SS` shape (REQ-WEBHOOK-001a)

Add immediately after `STATUS_ORDER` (`index.html:2988`), a natural home alongside other module-level constant arrays:

```js
var WEBHOOK_TRIGGERS = [
  { key: 'inv_buyer_approved', label: 'Invoice: Buyer Approved' }
];
```

No new `K` key. `SS.webhookRules` is a plain array field on the existing `SS` object (same object `SS.fwdWebhook`/`SS.autoCreateShipmentOnPaid` already live on), defaulting to `undefined`/absent until a rule is added — every read site must treat it as `SS.webhookRules || []`, never assume it exists. Each entry:

```js
{ id: uid(), trigger: 'inv_buyer_approved', url: 'https://...', enabled: true, createdAt: new Date().toISOString() }
```

No migration needed for existing installs — `SS.webhookRules || []` resolving to `[]` on every operator's first load after this ships is the correct, zero-effect default (AC-1).

---

## 2. `buildInvDocHtml(inv)` — extracted from `prevInvDoc()` (REQ-WEBHOOK-001d)

Current `prevInvDoc()` (`index.html:10011-10154`):

```js
function prevInvDoc(inv) {
  window._lastInv = inv;
  window._lastPO  = null;
  var cur = inv.cur||'USD';
  ... [10014-10148: the entire HTML-string build, ending with] ...
    +'</div>'
    +'</body></html>';

  var blob = new Blob([html], {type:'text/html'});
  var url = URL.createObjectURL(blob);
  var w = window.open(url, '_blank');
  if (!w) { URL.revokeObjectURL(url); alert('Allow pop-ups for this page then try again.'); return; }
  w.focus();
}
```

**Exact change** — split into two functions. `buildInvDocHtml(inv)` is everything from `var cur = inv.cur||'USD';` (line 10014) through the `var html = '...' + '</body></html>';` assignment (ending line 10148), unchanged, **except its return value**: instead of `return html;`, it ends with `return { html: html, grand: grand, bal: bal };` — reusing the exact same local `grand`/`bal` variables the HTML body itself already computes and prints (`index.html:10020`/`10024`, the "BALANCE DUE"/total figures). The `function prevInvDoc(inv) {` wrapper/closing brace is removed. `prevInvDoc(inv)` becomes:

```js
function prevInvDoc(inv) {
  window._lastInv = inv;
  window._lastPO  = null;
  var built = buildInvDocHtml(inv);
  var blob = new Blob([built.html], {type:'text/html'});
  var url = URL.createObjectURL(blob);
  var w = window.open(url, '_blank');
  if (!w) { URL.revokeObjectURL(url); alert('Allow pop-ups for this page then try again.'); return; }
  w.focus();
}
```

**Do not** move the `window._lastInv`/`window._lastPO` lines into `buildInvDocHtml()` — they stay in `prevInvDoc()`. This is the single most load-bearing instruction in this SPEC (REQ-WEBHOOK-001d, requirements-gate round 1 finding 1): `buildInvDocHtml()` must be callable from `saveInvApprove()`'s webhook-payload path without ever touching `window._lastInv`/`window._lastPO`, since `printDoc()` (`index.html:14610-14613`) reads those two globals to drive the operator's `Ctrl+P` "reprint last document" shortcut — a webhook-triggered call must never silently redirect that shortcut to an invoice the operator never opened a preview of.

No behavior change to `prevInvDoc()`'s own externally-visible output is intended — AC-10/AC-10b (§9) require proving this, not assuming it from the mechanical nature of the split. Changing `buildInvDocHtml()`'s *return shape* (a string → an object) is not itself an externally-visible behavior change, since `prevInvDoc()` is the only caller today and is updated in lockstep to unwrap `.html`.

**Correction from spec-gate round 2 (finding A) — returning `{grand, bal}` alongside `html` is not a nice-to-have, it closes a real defect.** Round 2 found that a bare `return html;` (the original draft) would have left `saveInvApprove()` needing to independently compute `balanceDue` for the JSON payload — and the obvious independent computation, `cInv(inv).bal` (fixed in round 1 for the `grandTotal` case), is **not the same figure** as what `invoiceHtml`'s own printed "BALANCE DUE" line shows: `cInv().bal` subtracts applied Credit Notes (`index.html:5272-5277`, `Math.max(0, grand - dep - appliedCNs)`), while `prevInvDoc()`'s own internal `bal=grand-dep` deliberately excludes CN deductions (`index.html:10026`'s own comment: "PDF shows Grand Total − Deposit Received only. CN deductions appear on the CN document."). For any Invoice with an applied Credit Note, `cInv(inv).bal` and `invoiceHtml`'s printed balance would show two different numbers in the same outgoing payload — the identical "payload internally contradicts itself" defect class round 1 already found and fixed for `grandTotal`, recurring here through a different mechanism the round-1 fix never traced. Returning the exact `grand`/`bal` values `buildInvDocHtml()` already computed for the HTML, and having `saveInvApprove()` use those same values for the JSON (§5, revised below), makes this divergence structurally impossible rather than something a future edit could silently reintroduce — this is the correct fix, not a duplicate calculation that happens to currently agree.

---

## 3. `fireWebhookRules(triggerKey, payload)` — shared dispatch (REQ-WEBHOOK-001c)

New function, placed near `sendFwdReq()` (`index.html:13390`) as its natural sibling:

```js
async function fireWebhookRules(triggerKey, payload) {
  var rules = (SS.webhookRules || []).filter(function(r){ return r.trigger === triggerKey && r.enabled; });
  if (!rules.length) return { sent: 0, failed: 0 };
  var body = JSON.stringify(payload);
  var results = await Promise.allSettled(rules.map(function(r){
    return fetch(r.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body })
      .then(function(res){ if (!res.ok) throw new Error('HTTP ' + res.status); return res; });
  }));
  var sent = results.filter(function(r){ return r.status === 'fulfilled'; }).length;
  var failed = results.length - sent;
  return { sent: sent, failed: failed };
}
```

`.then(function(res){ if (!res.ok) throw ...})` is the exact mechanism for REQ-WEBHOOK-001c's HTTP-error rule: a `fetch()` that resolves with a non-`ok` `Response` (404/500) is deliberately turned into a rejection inside the `.then()`, so `Promise.allSettled` correctly reports it as `'rejected'` (counted in `failed`) rather than `'fulfilled'` (which would silently count it as `sent`). A genuinely rejected `fetch()` (network failure, invalid host) is already `'rejected'` without any extra handling. This satisfies AC-6.

Zero matching rules is a normal no-op (`{sent:0, failed:0}`, no `fetch()` call at all) — required for every operator who hasn't configured this trigger yet (AC-1, the overwhelming majority of installs at ship time).

---

## 4. `resolveBuyerForWebhook(inv)` — precondition helper (REQ-WEBHOOK-001f)

New function, placed near `saveInvApprove()`:

```js
function resolveBuyerForWebhook(inv) {
  var buyId = inv.buyerId ? inv.buyerId : (DB.buy.find(function(b){ return b.name.toLowerCase()===(inv.buyer||'').toLowerCase(); })||{}).id || 'BUY-ADHOC';
  var buy = DB.buy.find(function(b){ return b.id === buyId; });
  if (!buy || !buy.email) return null;
  return buy;
}
```

The `buyId` resolution line is copied verbatim from the existing pattern at `index.html:8018` (`_buyMatch`) — this codebase's own established buyerId-then-name-then-`BUY-ADHOC` fallback, reused rather than reinvented. Returns `null` whenever the resolved Buyer has no usable email — covers a blank `buyerId`, an unmatched name, and the live `BUY-ADHOC` sentinel (`index.html:9377`, `email:''`), all in one guard (Decision 3, AC-8).

Any future trigger needing a buyer email must call this same helper, not re-derive the fallback chain independently (REQ-WEBHOOK-001f).

---

## 5. `saveInvApprove()` wiring (REQ-WEBHOOK-001e)

Current function (`index.html:8539-8562`) is unchanged through line 8562 (its final closing `}`). The new block is appended as new code *after* that closing brace is reached at runtime — concretely, insert it after the existing `if (G('ov-inv').classList.contains('on') ...)` block (`index.html:8558-8561`), still inside the function body, before its final `}`. Order matters only relative to the "Buyer approval recorded" `toast()` call at line 8556: the new block must run after that toast, never before — its actual position relative to the `G('ov-inv')` visibility-refresh block (before or after) has no functional effect, since neither block reads state the other writes.

```js
async function saveInvApprove() {
  if (!vInvApprove()) return;
  var inv = DB.inv.find(function(x){ return x.id === _apprInvId; });
  if (!inv) return;
  var wasApproved = !!inv.buyerApprovedAt;
  inv.buyerApprovedAt = new Date().toISOString();
  inv.buyerApprovedBy = G('ia-by').value.trim();
  inv.approvalMethod = G('ia-method').value;
  inv.approvalNote = G('ia-note').value.trim();
  inv.updAt = new Date().toISOString();
  if (_sb && localStorage.getItem('st_inv_cloud_migration_ts')) {
    await persistInvChange(inv, false);
  } else {
    sv(K.i, DB.inv);
  }
  logEv('invoice', inv.id, 'buyer_approved', 'Buyer approval recorded — ' + inv.approvalMethod + ' (by ' + inv.buyerApprovedBy + ')', 'operator');
  audit('UPDATE', 'invoice', inv.id, inv);
  closeM('ov-inv-approve');
  toast('Buyer approval recorded');
  rInv();
  if (G('ov-inv').classList.contains('on') && EI.i === inv.id) {
    G('inv-approve-btn').style.display = invApprovalActionVisible(inv) ? '' : 'none';
    G('inv-progress-btn').style.display = invProgressActionVisible(inv) ? '' : 'none';
  }
  if (!wasApproved) {
    var buy = resolveBuyerForWebhook(inv);
    if (buy) {
      var lis = inv.lineItems||[];
      if (typeof lis === 'string') { try { lis=JSON.parse(lis); } catch(e){ lis=[]; } }
      var built = buildInvDocHtml(inv);
      var payload = {
        trigger: 'inv_buyer_approved',
        invoice: {
          id: inv.id, num: inv.num, status: inv.status, cur: inv.cur||'USD', date: inv.date,
          grandTotal: built.grand, balanceDue: built.bal,
          buyerApprovedAt: inv.buyerApprovedAt, buyerApprovedBy: inv.buyerApprovedBy,
          approvalMethod: inv.approvalMethod, approvalNote: inv.approvalNote
        },
        buyer: { id: buy.id, name: buy.name, email: buy.email },
        lineItems: lis.map(function(li){ return { desc: li.desc, uom: li.uom, qty: li.qty, up: li.up, lineTotal: (+li.qty||0)*(+li.up||0) }; }),
        invoiceHtml: built.html,
        ts: new Date().toISOString()
      };
      fireWebhookRules('inv_buyer_approved', payload).then(function(r){
        if (r.sent || r.failed) toast('Webhook: ' + r.sent + ' sent' + (r.failed ? ', ' + r.failed + ' failed' : ''));
      });
    } else {
      toast('No buyer email on file — automation webhook not sent', 3200);
    }
  }
}
```

**Correction history — `grandTotal`/`balanceDue` went through two fix rounds, the second superseding the first's approach (not just its values).** Round 1 found the original draft's bare `+inv.calc_grandTotal||0`/`+inv.calc_balanceDue||0` would have silently sent `0` for both fields on the majority of real approvals (`saveInv()`'s own object literal, `index.html:8235-8261`, never populates those `calc_` fields for an ordinary interactive create/edit — only CSV import, "Import from Sheets," and the legacy migration do), while the same payload's `invoiceHtml` showed the real amount. Round 1's fix switched to `+inv.calc_grandTotal || cInv(inv).grand` (this codebase's established idiom, `index.html:14844`) and `cInv(inv).bal` directly. **Round 2 found that fix was itself still wrong for `balanceDue`**: `cInv(inv).bal` subtracts applied Credit Notes (`index.html:5272-5277`), while `invoiceHtml`'s own printed "BALANCE DUE" line deliberately does not (`index.html:10026`'s own comment: "PDF shows Grand Total − Deposit Received only. CN deductions appear on the CN document.") — so for any Invoice with an applied CN, the two numbers in one payload would still have diverged, just via a different mechanism than round 1's `||0` bug. **Superseded by the §2 structural fix above**: `grandTotal`/`balanceDue` are no longer independently computed in this function at all — they're read directly off `buildInvDocHtml()`'s own return value (`built.grand`/`built.bal`), the exact numbers already printed in `invoiceHtml`, making a future divergence between the JSON and the PDF structurally impossible rather than something a third bug could reintroduce.

Notes an implementer must not deviate from:

- `wasApproved` is captured **before** `inv.buyerApprovedAt` is overwritten — this is Decision 6's entire guard (requirements-gate round 1 finding 4, round 3 finding B). If `wasApproved` is `true` (a correction to an already-approved invoice, per `invApprovalActionVisible()`/`openInvApprove()`'s real re-entry UX at `index.html:3169-3171`/`8527-8536`), skip the whole webhook block silently — no toast, since a correction is not an error condition.
- `fireWebhookRules(...)` is called **without** `await` — a `.then()` callback, not `await fireWebhookRules(...)`. This is REQ-WEBHOOK-001c's toast-timing rule: the "Buyer approval recorded" toast at line 8556 must already have fired, and the function must be free to return, before the webhook dispatch has any chance to still be in flight. A slow/unreachable Make.com URL delays only the later `.then()` toast, never this function's own completion (AC-15).
- The "no buyer email" toast (Decision 3) fires synchronously, immediately — it's a precondition check, not a dispatch outcome, so it doesn't need the same non-blocking treatment as the dispatch summary toast.
- `payload.buyer` is exactly `{id, name, email}` — no `contactName`, no `phone` (Decision 8). AC-16 requires a test asserting these keys are genuinely absent from the actual outgoing JSON body, not merely untested.
- `buildInvDocHtml(inv)` is called exactly once, with the **current, in-memory `inv` object** (post-mutation, so it reflects the just-recorded approval fields, not a re-fetch from `DB.inv`) — its single return value (`built`) supplies `invoiceHtml`, `grandTotal`, and `balanceDue` all together, so they can never independently drift out of sync (spec-gate round 2 finding A).

---

## 6. Settings → Integrations: Automation Webhooks rule list (REQ-WEBHOOK-001b)

New HTML block inserted into the existing Integrations `card` div (`index.html:756-767`), immediately after the Forwarder Webhook block's closing `</p>` (after line 766) and before the card's closing `</div>` (line 767):

```html
    <div class="card">
      <div class="ct">Integrations</div>
      <div class="fld" style="margin-bottom:10px;">
        <label><input type="checkbox" id="cfg-autoship-toggle" onchange="saveAutoShipToggle()"> Auto-create Shipment when an Invoice is marked Paid <span style="font-size:.44rem;color:var(--m);">(default on)</span></label>
      </div>
      <div class="fld" style="margin-bottom:10px;">
        <label>Forwarder Webhook URL <span style="font-size:.44rem;color:var(--m);">(Power Automate or Zapier — receives JSON with shipmentRef + message)</span></label>
        <input type="text" id="cfg-fwd-webhook" placeholder="https://prod.example.com/triggers/..." autocomplete="off">
      </div>
      <button class="btn btn-s" onclick="saveFwdWebhook()">Save Webhook</button>
      <p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">&#9432; When a webhook URL is configured, shipment data (origin/destination ports, ETD, cargo description, forwarder contact name and email) is posted to that endpoint on each Forwarder Update Request. Only configure a URL you control or trust. Webhook is opt-in — no data is transmitted if no URL is configured.</p>

      <div style="margin-top:14px;border-top:1px solid var(--ln);padding-top:12px;">
        <div class="fld" style="margin-bottom:8px;">
          <label style="font-weight:600;">Automation Webhooks</label>
        </div>
        <div id="webhook-rules-disclosure"></div>
        <div id="webhook-rules-panel"></div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">
          <select id="whr-trigger" style="flex:1;min-width:160px;"></select>
          <input type="text" id="whr-url" placeholder="https://hook.us1.make.com/..." style="flex:2;min-width:200px;" autocomplete="off">
          <label style="display:flex;align-items:center;gap:4px;font-size:.5rem;"><input type="checkbox" id="whr-enabled" checked> Enabled</label>
          <button class="btn btn-g" onclick="addWebhookRule()">+ Add Rule</button>
        </div>
      </div>
    </div>
```

New functions:

```js
function populateWebhookTriggerSelect() {
  var sel = G('whr-trigger');
  if (!sel) return;
  sel.innerHTML = WEBHOOK_TRIGGERS.map(function(t){ return '<option value="' + t.key + '">' + san(t.label) + '</option>'; }).join('');
}

function addWebhookRule() {
  var trigger = G('whr-trigger').value;
  var url = G('whr-url').value.trim();
  var enabled = G('whr-enabled') ? G('whr-enabled').checked : true;
  if (!url || !url.startsWith('https://')) { toast('Webhook URL must start with https://'); return; }
  if (!SS.webhookRules) SS.webhookRules = [];
  SS.webhookRules.push({ id: uid(), trigger: trigger, url: url, enabled: enabled, createdAt: new Date().toISOString() });
  sv(K.ss, SS);
  G('whr-url').value = '';
  renderWebhookRulesPanel();
  toast('Webhook rule added');
}

function toggleWebhookRule(id, enabled) {
  var r = (SS.webhookRules||[]).find(function(x){ return x.id === id; });
  if (!r) return;
  r.enabled = enabled;
  sv(K.ss, SS);
}

function delWebhookRule(id) {
  SS.webhookRules = (SS.webhookRules||[]).filter(function(x){ return x.id !== id; });
  sv(K.ss, SS);
  renderWebhookRulesPanel();
  toast('Webhook rule removed');
}

var WEBHOOK_DISCLOSURE_HTML = '&#9432; A webhook rule targeting <b>Invoice: Buyer Approved</b> sends, to the URL you configure: buyer name and email; and the full rendered invoice document exactly as printed &mdash; financial detail, line items, buyer name/address, FPM\'s own company bank account details (Settings &rarr; Company (Stackd)), and anything else configured to appear on that document (e.g. a custom footer note). Only configure a URL you control or trust. Webhook rules are opt-in &mdash; no data is transmitted unless a rule exists and is enabled.';

function renderWebhookRulesPanel() {
  var disclosure = G('webhook-rules-disclosure');
  if (disclosure) disclosure.innerHTML = '<p style="font-size:.48rem;color:var(--m);margin-bottom:8px;">' + WEBHOOK_DISCLOSURE_HTML + '</p>';
  var panel = G('webhook-rules-panel');
  if (!panel) return;
  var rules = SS.webhookRules || [];
  var rows = rules.map(function(r){
    var t = WEBHOOK_TRIGGERS.find(function(x){ return x.key === r.trigger; });
    return '<div style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--ln);font-size:.5rem;">'
      + '<label style="display:flex;align-items:center;gap:4px;"><input type="checkbox"' + (r.enabled?' checked':'') + ' onchange="toggleWebhookRule(\'' + r.id + '\',this.checked)"></label>'
      + '<span style="flex-shrink:0;">' + san(t?t.label:r.trigger) + '</span>'
      + '<span style="flex:1;color:var(--m);word-break:break-all;">' + san(r.url) + '</span>'
      + '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;border-color:var(--cr);color:var(--cr);" onclick="delWebhookRule(\'' + r.id + '\')">Del</button>'
      + '</div>';
  }).join('');
  panel.innerHTML = rows || '<div style="color:var(--m);font-size:.54rem;">No automation webhook rules configured.</div>';
}
```

`rCfg()` (`index.html:12528-12556`) gains two new lines, placed immediately after the existing `cfg-autoship-toggle` line (`12537`):

```js
  if(G('whr-trigger')) populateWebhookTriggerSelect();
  if(G('webhook-rules-disclosure') || G('webhook-rules-panel')) renderWebhookRulesPanel();
```

**Correction from spec-gate round 1 (finding 2) — the original disclosure design was gated on rule count, which structurally could never satisfy "shown before the first rule is saved."** The original draft rendered `WEBHOOK_DISCLOSURE_HTML` only when `rules.some(r => r.trigger==='inv_buyer_approved')` — i.e. only *after* a matching rule already existed. On an operator's very first attempt to add such a rule, that condition is false, so the disclosure never rendered, and `addWebhookRule()` had no independent gate of its own — an operator could type a URL and click "+ Add Rule" having never seen any of the three disclosure categories, directly violating `REQ-WEBHOOK-001b`/Decision 5's explicit "cannot be added without it being seen" requirement.

**Fixed** by decoupling the disclosure from rule count entirely: `WEBHOOK_DISCLOSURE_HTML` now renders unconditionally into its own `#webhook-rules-disclosure` div, immediately above the rule list and immediately above the Add-Rule controls, every time `renderWebhookRulesPanel()` runs (on Settings load and after every add/delete) — regardless of whether any rule currently exists. Since `WEBHOOK_TRIGGERS` has exactly one entry in v1 and it is the sensitive one, showing the notice unconditionally is correct and satisfies both REQ conditions with a single mechanism: it is visible *before* the very first save (the panel renders the moment Settings opens, well before any click on "+ Add Rule") *and* it persists for as long as the feature exists in the UI (`REQ-WEBHOOK-001-v1.md:62`'s two-part requirement, both parts now genuinely met, not just the second one as before). **A future non-sensitive trigger added to `WEBHOOK_TRIGGERS` would need this logic revisited** — unconditional display stops being correct the moment a trigger that doesn't need this disclosure exists alongside one that does; that is out of scope for v1 (one trigger, always sensitive) but must not be forgotten when a second trigger is ever added.

Disclosure requirements, exact (REQ-WEBHOOK-001b/Decision 5, requirements-gate rounds 1/2/3):
- The notice text names all categories §1.3/`SEC-GAP-025` requires (buyer name/email, the full invoice document, FPM's own bank details) and does not contradict that text anywhere. Corrected in this SPEC to reference "Company (Stackd)" (`index.html:614-627`, where `c-bank`→`AS.bank` actually lives), not "Company Branding" (`index.html:628-639`, a different card feeding `getCoBrand()`) — the original draft cited the wrong card name.
- **Deliberate broadening beyond §1.3's literal wording (spec-gate round 2 finding D):** `buildPdfFooter()` (`index.html:9998-10009`) renders the "Company Branding" card's free-text `co-footer` field, whose own placeholder text ("Payment due within 30 days. Bank details: ...") actively invites an operator to put bank details there too — a second channel beyond the dedicated `AS.bank` field §1.3 names explicitly. Rather than amend the already-review-hardened REQ text to enumerate a second bank-detail channel, `WEBHOOK_DISCLOSURE_HTML` closes this catch-all-style, ending with "...and anything else configured to appear on that document (e.g. a custom footer note)" — a strictly broader, more protective disclosure than §1.3's literal enumeration, not a narrower or contradicting one, so it remains consistent with §1.3's intent even though the exact string differs.
- The notice is always visible whenever the Automation Webhooks section is on screen (AC-4, AC-14 — both revised in §9 below to test the unconditional-render design, not the old rule-count-gated one).

---

## 7. `AI_SYSTEM_PROMPT` update (REQ-WEBHOOK-001g)

Add a new bullet under the existing `## Shipments`/Settings-adjacent section of `AI_SYSTEM_PROMPT` (exact insertion point to be located at build time via `grep -n "## Shipments" index.html`, following this codebase's own established per-version practice) describing: Settings → Integrations → Automation Webhooks; the one v1 trigger (`inv_buyer_approved`, fires once per genuine unapproved→approved transition, not on a correction to an already-approved invoice); that it sends one email via an operator-configured Make.com-style webhook with the invoice PDF attached; and that no retry/delivery guarantee exists if the destination is unreachable.

---

## 8. `docs/known-gaps.md` — new entries (REQ-WEBHOOK-001h + spec-gate round 2 finding B)

**`SEC-GAP-025`**: Log at ship time, text drawn directly and verbatim-consistent with REQ-WEBHOOK-001-v1.md §1.3 (already fully drafted and review-hardened across 6 rounds — copy that paragraph, do not redraft it independently and risk reintroducing a disclosure-completeness gap this REQ's own review history already closed).

**`INV-GAP-005` (new, spec-gate round 2 finding B — disclosed, not fixed):** `saveInvApprove()`'s `await persistInvChange(inv, false)` call (`index.html:8548-8552`, unchanged by this SPEC) has no success check. `persistInvChange()` (`index.html:6350-6388`) returns silently — no throw, no rejected promise, no return value at all — both when `ensureSbAuth()` is cancelled by the operator (`index.html:6352`) and when the Supabase `.update()` itself errors (`index.html:6386`, only a `console.warn`). This means a Cloud Data operator who cancels a login prompt, or hits a transient Supabase error, at the exact moment of clicking "Mark Buyer Approved" gets the "Buyer approval recorded" toast and (per this REQ's new trigger) the automation webhook fires and the buyer receives an email — for an approval that was never actually written to the shared Cloud Data record. On next reload/refresh, the approval will appear to have silently reverted for every other device sharing that invoice, while the buyer has already been told it happened. **Not fixed by this SPEC**, deliberately: `persistInvChange()` is shared by 12+ call sites across the app, none of which currently check its success either — fixing this properly means giving that shared function an actual success/failure return contract and auditing every existing caller's behavior under both outcomes, which is a materially larger, separate piece of work than this REQ's own scope, and risks introducing a regression into paths this REQ never touched. Disclosed here, matching the precedent already established by `SHIP-GAP-001` for the identical class of "known, pre-existing, not-newly-introduced-but-newly-relevant" risk — not silently ignored, not addressed by a narrow, parallel, locally-duplicated auth/error check inside `saveInvApprove()` alone (which `CLAUDE.md`'s own coding conventions already warn against as a recurring anti-pattern in this codebase).

---

## 9. Test plan

All new functions are pure/synchronous-enough to unit test directly against `ctx.*` in `tests/run.js`, following this codebase's `resetDB()`/`mockEl()`/`mockSb()` conventions, plus two new pieces of test infrastructure this SPEC requires (spec-gate round 1 findings 6-7):

**New test infrastructure required, not optional:**
- **`mockFetch()`'s existing generic branch (`tests/run.js:71-88`) does not set `.ok`/`.status`** on its resolved response — under `fireWebhookRules()`'s `.then(function(res){ if(!res.ok) throw...})`, every such response has `res.ok === undefined`, so `!res.ok` is always `true` and every webhook call would be misread as failed by the *existing* shared mock, regardless of what any individual test intends. `mockFetch()` must gain a new, dedicated branch for webhook URLs (matching the existing `_mockAnthropic`-style override pattern, `tests/run.js:57-70`): a new `let _mockWebhookResponses = {};` — a plain object keyed by the exact rule URL, each value one of `'reject'` / `{status:<code>}`, checked before the generic `action`-based branch when `url` is a key in that map. **A single non-keyed override variable is not sufficient and must not be used** (spec-gate round 2 finding C) — AC-6 requires three rules with three simultaneous, independent outcomes (a rejected `fetch`, a `{ok:false,status:404}` response, and a normal `{ok:true}` response) firing in the same `fireWebhookRules()` call; only a per-URL map can express that. Translate `{status:<code>}` to `ok: status>=200&&status<300` before resolving — mirroring `_mockAnthropic`'s own three-state shape (reject / non-200 / 200) rather than inventing a new one.
- **`resetDB()` (`tests/run.js:181-183`) does not touch `SS`.** `SS.webhookRules` set by one test will leak into every subsequent `test()`/`testAsync()` call in the same run unless explicitly cleared. Every webhook test must explicitly reset `ctx.SS.webhookRules = []` (or the whole `ctx.SS = {}`, matching whatever the test needs) at its own start — do not rely on `resetDB()` to have done this, and do not add `SS` to `resetDB()`'s own scope without auditing every pre-existing test that reads `SS` today, per this codebase's own documented "self-marking test contamination" bug class (`CLAUDE.md`, recurred 4 times in the Cloud Data series) — a blanket change to a shared reset function is exactly the kind of edit that class of bug comes from.

Mapped to REQ-WEBHOOK-001's ACs:

| AC | Test |
|---|---|
| AC-1 | `SS.webhookRules` absent → `fireWebhookRules('inv_buyer_approved', {})` returns `{sent:0,failed:0}`, no `fetch()` call (spy/mock `fetch`, assert zero invocations) |
| AC-2 | `addWebhookRule()` with a valid `https://` URL → `SS.webhookRules` gains one entry with the right shape; `renderWebhookRulesPanel()` output contains the URL |
| AC-3 | `addWebhookRule()` with a `http://` (non-https) URL → `SS.webhookRules` unchanged, toast fired |
| AC-4 (revised, spec-gate round 1 finding 2) | `renderWebhookRulesPanel()` output contains `WEBHOOK_DISCLOSURE_HTML`'s text **with zero rules configured** — i.e. specifically the state immediately before an operator's first "+ Add Rule" click, not only after a rule already exists. A second assertion confirms it's still present after a rule is added (both states covered, not just the post-add one the original draft tested). |
| AC-5 | `delWebhookRule(id)` removes exactly that entry; a subsequent `fireWebhookRules()` call no longer reaches it |
| AC-6 | Two enabled rules, one mocked `fetch` rejecting (network failure) and one mocked `fetch` resolving with `{ok:false,status:404}` — both counted in `failed`; a third rule with a normal `{ok:true}` response counted in `sent` — all three independent, `Promise.allSettled` semantics proven by the reject-and-resolve mix not aborting each other |
| AC-7 (strengthened, spec-gate rounds 1 &amp; 2) | `saveInvApprove()` on an unapproved Invoice with a real buyer email and one enabled `inv_buyer_approved` rule → exactly one `fetch()` call, `JSON.parse(callArgs.body)` matches the documented payload shape, `invoiceHtml` non-empty. **The fixture Invoice must have real `lineItems` but no `calc_grandTotal`/`calc_balanceDue` set** (the ordinary, non-CSV-imported shape) — a fixture that happens to have `calc_grandTotal` pre-set would not catch round 1's bug. **The test must also assert `payload.invoice.grandTotal`/`balanceDue` are byte-identical to the numeric total/balance actually printed inside `payload.invoiceHtml`** (parse them back out of the HTML string, or compare against `buildInvDocHtml(inv)`'s own `built.grand`/`built.bal` directly) — a second, separate fixture with an applied Credit Note is required to actually exercise the divergence round 2 found (`cInv().bal` vs. `invoiceHtml`'s own balance), since a CN-free fixture cannot distinguish the correct fix from the round-1-only fix. |
| AC-8 | Same, but buyer resolves to `BUY-ADHOC`/blank email → zero `fetch()` calls, distinct toast fired in addition to "Buyer approval recorded" |
| AC-9 | Force the mocked `fetch` to reject → `DB.inv[].buyerApprovedAt`/etc. still set correctly (persistence unaffected by webhook outcome) |
| AC-10 | `buildInvDocHtml(inv).html`, wrapped into the same Blob-construction logic `prevInvDoc()` uses, is byte-identical to `prevInvDoc()`'s pre-refactor output for 3 fixture invoices (Draft, Pro-forma, one with every optional charge field populated). **AC-10c**: `buildInvDocHtml(inv).grand`/`.bal` are numerically correct against the same fixtures — including one with an applied Credit Note, where `.bal` must equal `grand - dep` (no CN deduction), matching `invoiceHtml`'s own printed figure, deliberately **not** matching `cInv(inv).bal` for that fixture (spec-gate round 2 finding A). |
| AC-10b | Call `buildInvDocHtml(inv)` directly; assert `window._lastInv`/`window._lastPO` are unchanged from whatever they were set to before the call |
| AC-11 | `saveInvApprove()` twice, with a genuine line-item edit (clearing `buyerApprovedAt` per the pre-existing Phase-2 auto-clear) between calls → webhook fires both times |
| AC-11b | `saveInvApprove()` twice with **no** intervening edit (a correction) → webhook fires only on the first call |
| AC-12 | A buyer/invoice field containing `<script>`/`"` reaches `buildInvDocHtml()`'s output only through existing `san()`-wrapped rendering — confirm no raw injection in the resulting HTML string |
| AC-13 | Manual review of `AI_SYSTEM_PROMPT` against shipped behavior |
| AC-14 (revised, spec-gate round 1 finding 2) | Same disclosure-visibility assertion as AC-4 above — both ACs now cover the corrected unconditional-render design; kept as two distinct AC numbers only because the REQ names them separately (creation-time vs. persistent-note), even though this SPEC's fix satisfies both with one mechanism |
| AC-15 | Mock `fetch` with a controllable, not-yet-resolved promise; call `saveInvApprove()`; assert the "Buyer approval recorded" toast and `DB.inv` mutation are both already complete before manually resolving the mock |
| AC-16 | Assert `'contactName' in payload.buyer === false` and `'phone' in payload.buyer === false` on the actual parsed request body |
| AC-17 | Manual review of the shipped `SEC-GAP-025` entry against §1.3 |

**Mutation-testing checklist (mandatory before build-gate, mirroring `REQ-SHIP-001`'s own §14 precedent):**
a. Revert the `wasApproved` guard (fire unconditionally) → confirm AC-11b fails, nothing else.
b. Revert `buildInvDocHtml()`'s exclusion of `window._lastInv`/`_lastPO` → confirm AC-10b fails.
c. Revert the `.then(function(res){ if(!res.ok) throw ... })` HTTP-error handling in `fireWebhookRules()` → confirm AC-6 fails.
d. Change `fireWebhookRules(...)` back to `await`ed before the approval toast → confirm AC-15 fails.
e. Reintroduce `contactName`/`phone` into the payload's `buyer` object → confirm AC-16 fails.
f. Remove the `resolveBuyerForWebhook()` null-check (fire regardless of buyer email) → confirm AC-8 fails.
g. Revert `renderWebhookRulesPanel()`'s disclosure back to the rule-count-gated design (only render `WEBHOOK_DISCLOSURE_HTML` when a matching rule already exists) → confirm the revised AC-4's zero-rules assertion fails, nothing else.
h. Revert `saveInvApprove()`'s `grandTotal`/`balanceDue` fields back to `+inv.calc_grandTotal||0`/`+inv.calc_balanceDue||0` → confirm AC-7 fails for a fixture Invoice with no `calc_grandTotal` set (the common, non-CSV-imported case).
i. Revert `saveInvApprove()`'s payload fields back to independently calling `cInv(inv).bal` for `balanceDue` (instead of `built.bal`) → confirm AC-7's revised assertion (below) fails for a fixture Invoice with an applied Credit Note, where `cInv().bal` and `invoiceHtml`'s own printed balance now diverge (spec-gate round 2 finding A).

---

## 10. Explicitly unchanged (confirmed by this spec, not just asserted by the REQ)

- `prevInvDoc()`'s own externally-visible behavior (opened-tab content, `window._lastInv`/`_lastPO` side effect) — unchanged, proven by AC-10/AC-10b.
- `saveInvApprove()`'s pre-existing behavior for an operator with zero webhook rules configured — identical to today, since `fireWebhookRules()` no-ops.
- `sendFwdReq()`/`saveFwdWebhook()`/the Forwarder Webhook UI — untouched; this SPEC only adds a new sibling block in the same card.
- No Cloud Data / Supabase change anywhere in this SPEC.

---

## 11. Version-ship housekeeping (on completion, per `CLAUDE.md`'s standing checklist)

Bump `CLAUDE.md` Current version/Test count; `docs/version-history.md` new row; `docs/known-gaps.md` new `SEC-GAP-025` entry; `STACKD_CONTEXT.md` Backlog-carried-forward table; `AI_SYSTEM_PROMPT` per §7; all three hardcoded version strings (`<title>`, nav badge, `AI_SYSTEM_PROMPT` self-description); `docs/user-guide.md` new Settings/Automation Webhooks section; in-app changelog; run `node scripts/check-req-citations.js` against this SPEC and the REQ one more time before raising the build-gate PR.

## 12. Review-resolution log

### Round 1 — verdict FAIL, 2 major + 2 minor + 2 test-infrastructure findings, all fixed

Citation check (`node scripts/check-req-citations.js docs/SPEC-WEBHOOK-001-v1.md`) came back clean — 11/11 citations correctly attributed on this first submission, the new standing pre-gate step working as intended. The review went beyond citations to trace actual data flow and found real code-level defects, all personally re-verified against live `index.html`/`tests/run.js` before being accepted:

1. **[MAJOR] `grandTotal`/`balanceDue` used a bare `||0` fallback** (§5) — `saveInv()`'s ordinary create/edit path never populates `calc_grandTotal`/`calc_balanceDue` (only CSV import, Import-from-Sheets, and the legacy migration do), so the payload would have sent `0` for both fields on the majority of real approvals, while the same payload's `invoiceHtml` correctly showed the live total — an internally self-contradicting payload. **Fixed**: adopted this codebase's own established live-fallback idiom (`index.html:14844`) for `grandTotal`, and `cInv(inv).bal` directly for `balanceDue` per the codebase's own documented "balance always live from `cInv`" policy (`index.html:2107`). AC-7 strengthened to require a fixture without pre-set `calc_` fields; new mutation-test item h.
2. **[MAJOR] The GDPR disclosure was gated on rule count, so it could never be seen before the very first rule was saved** (§6) — violating `REQ-WEBHOOK-001b`/Decision 5's explicit "cannot be added without it being seen" requirement, and the original AC-4 test as written would have passed while testing the wrong (non-compliant) state. **Fixed**: disclosure decoupled from rule count entirely, rendered unconditionally into its own div whenever the Automation Webhooks section is on screen — correct for v1 since its one trigger is always the sensitive one; explicitly flagged as needing revisiting if a second, non-sensitive trigger is ever added. AC-4/AC-14 rewritten to test the zero-rules state specifically; new mutation-test item g.
3. **[minor] §5's insertion-point prose contradicted its own code block** (which function block came before which) — no functional effect, but a real ambiguity for an implementer. **Fixed**: clarified insertion point and stated explicitly that ordering between the two tail blocks has no functional effect.
4. **[minor] The disclosure text cited the wrong Settings card** ("Company Branding" instead of "Company (Stackd)", where `c-bank`/`AS.bank` actually lives, `index.html:614-627` vs. `628-639`). **Fixed**: corrected in `WEBHOOK_DISCLOSURE_HTML`.
5. **[minor] The REQ's explicit "enabled checkbox" on the Add-Rule control was missing** from the SPEC's HTML, with `enabled: true` silently hardcoded instead. **Fixed**: added `#whr-enabled` checkbox to the Add-Rule row, `addWebhookRule()` reads it.
6. **[test-infrastructure] `mockFetch()`'s existing generic branch never sets `.ok`/`.status`**, so every mocked webhook `fetch()` would read as failed regardless of test intent under `fireWebhookRules()`'s `!res.ok` check. **Fixed**: §9 now specifies the required new mock branch, mirroring `_mockAnthropic`'s existing three-state pattern.
7. **[test-infrastructure] `resetDB()` doesn't reset `SS`**, risking `SS.webhookRules` leaking across sequential tests — the exact "self-marking test contamination" bug class `CLAUDE.md` already documents recurring 4 times. **Fixed**: §9 now requires every webhook test to explicitly reset `SS.webhookRules` itself, and explicitly warns against a blanket `resetDB()` change without auditing every existing `SS`-reading test first.

All fixes made directly to §5/§6/§9 in place.

### Round 2 (confirmatory) — verdict CONDITIONAL PASS, 2 substantive findings + 2 minor, all fixed

Citation check clean in both directions (`index.html` and `tests/run.js`), and all 7 round-1 fixes independently re-verified as genuinely correct — no regression. Round 2 found two new, real findings the round-1 fix pass didn't reach, plus two minor:

1. **[real, same defect class as round-1 finding 1] `balanceDue: cInv(inv).bal` could still diverge from `invoiceHtml`'s own printed balance.** `cInv().bal` subtracts applied Credit Notes (`index.html:5272-5277`); `invoiceHtml`'s own internal balance calculation deliberately does not (`index.html:10026`'s own comment: CN deductions appear on the CN's own document, not the Invoice's). For any Invoice with an applied CN, the JSON and the PDF in the same payload would show two different numbers — round 1 fixed this exact problem class for `grandTotal` but a second instance survived in `balanceDue` via a different mechanism. **Fixed structurally, not just numerically**: `buildInvDocHtml()` (§2) now returns `{html, grand, bal}` instead of a bare string, reusing the exact same local variables the HTML body already computes and prints; `saveInvApprove()` (§5) reads `built.grand`/`built.bal` directly instead of calling `cInv()` independently — making a future JSON/PDF divergence structurally impossible rather than something a third bug could reintroduce. New AC-10c, AC-7 strengthened to require a CN-bearing fixture, new mutation-test item i.
2. **[real, disclosed not fixed] `saveInvApprove()`'s `persistInvChange()` call has no success check.** `persistInvChange()` (`index.html:6350-6388`) returns silently on both a cancelled Cloud Data login and a Supabase update error — no throw, no signal. A Cloud Data operator hitting either at the moment of approval gets the webhook fired (buyer emailed) for an approval that was never actually persisted. Pre-existing `saveInvApprove()` behavior this SPEC correctly declines to alter, and `persistInvChange()` is shared by 12+ call sites none of which check its success either — fixing the shared function's contract is a materially larger, separate piece of work outside this REQ's scope, and a narrow local duplicate-check inside `saveInvApprove()` alone would be exactly the parallel-logic anti-pattern `CLAUDE.md` warns against. **Disclosed, not fixed** — new `INV-GAP-005` (§8), matching the precedent already established by `SHIP-GAP-001` for this exact risk class.
3. **[minor]** AC-6's mock-infrastructure description underspecified — framed a per-URL `_mockWebhookResponses` map as needed only "if a test needs to control two rules," when AC-6 actually requires three simultaneous independent outcomes and a single-value mock cannot satisfy it at all. **Fixed**: §9 now states the map is required, not optional, with AC-6's own three-outcome requirement stated explicitly as the reason.
4. **[minor, judgment call]** `WEBHOOK_DISCLOSURE_HTML`'s enumeration of data sources didn't account for `buildPdfFooter()`'s free-text footer field, whose own placeholder invites bank-detail entry as a second channel beyond the dedicated `AS.bank` field. **Fixed**: disclosure text broadened with a catch-all clause ("...and anything else configured to appear on that document") — strictly more protective than §1.3's literal enumeration, not contradicting it.

All fixes made directly to §2/§5/§6/§8/§9 in place.
