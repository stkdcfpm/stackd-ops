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

**Exact change** — split into two functions. `buildInvDocHtml(inv)` is everything from `var cur = inv.cur||'USD';` (line 10014) through the `var html = '...' + '</body></html>';` assignment (ending line 10148), unchanged, with a `return html;` appended and the `function prevInvDoc(inv) {` wrapper/closing brace removed. `prevInvDoc(inv)` becomes:

```js
function prevInvDoc(inv) {
  window._lastInv = inv;
  window._lastPO  = null;
  var html = buildInvDocHtml(inv);
  var blob = new Blob([html], {type:'text/html'});
  var url = URL.createObjectURL(blob);
  var w = window.open(url, '_blank');
  if (!w) { URL.revokeObjectURL(url); alert('Allow pop-ups for this page then try again.'); return; }
  w.focus();
}
```

**Do not** move the `window._lastInv`/`window._lastPO` lines into `buildInvDocHtml()` — they stay in `prevInvDoc()`. This is the single most load-bearing instruction in this SPEC (REQ-WEBHOOK-001d, requirements-gate round 1 finding 1): `buildInvDocHtml()` must be callable from `saveInvApprove()`'s webhook-payload path without ever touching `window._lastInv`/`window._lastPO`, since `printDoc()` (`index.html:14610-14613`) reads those two globals to drive the operator's `Ctrl+P` "reprint last document" shortcut — a webhook-triggered call must never silently redirect that shortcut to an invoice the operator never opened a preview of.

No behavior change to `prevInvDoc()` itself is intended — AC-10/AC-10b (§9) require proving this, not assuming it from the mechanical nature of the split.

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

Current function (`index.html:8539-8562`) is unchanged through line 8557 (`rInv();`). Insert immediately before the final `if (G('ov-inv').classList.contains('on') ...)` block — order matters, this must come after the existing "Buyer approval recorded" `toast()` call, never before:

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
      var payload = {
        trigger: 'inv_buyer_approved',
        invoice: {
          id: inv.id, num: inv.num, status: inv.status, cur: inv.cur||'USD', date: inv.date,
          grandTotal: +inv.calc_grandTotal||0, balanceDue: +inv.calc_balanceDue||0,
          buyerApprovedAt: inv.buyerApprovedAt, buyerApprovedBy: inv.buyerApprovedBy,
          approvalMethod: inv.approvalMethod, approvalNote: inv.approvalNote
        },
        buyer: { id: buy.id, name: buy.name, email: buy.email },
        lineItems: lis.map(function(li){ return { desc: li.desc, uom: li.uom, qty: li.qty, up: li.up, lineTotal: (+li.qty||0)*(+li.up||0) }; }),
        invoiceHtml: buildInvDocHtml(inv),
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

Notes an implementer must not deviate from:

- `wasApproved` is captured **before** `inv.buyerApprovedAt` is overwritten — this is Decision 6's entire guard (requirements-gate round 1 finding 4, round 3 finding B). If `wasApproved` is `true` (a correction to an already-approved invoice, per `invApprovalActionVisible()`/`openInvApprove()`'s real re-entry UX at `index.html:3169-3171`/`8527-8536`), skip the whole webhook block silently — no toast, since a correction is not an error condition.
- `fireWebhookRules(...)` is called **without** `await` — a `.then()` callback, not `await fireWebhookRules(...)`. This is REQ-WEBHOOK-001c's toast-timing rule: the "Buyer approval recorded" toast at line 8556 must already have fired, and the function must be free to return, before the webhook dispatch has any chance to still be in flight. A slow/unreachable Make.com URL delays only the later `.then()` toast, never this function's own completion (AC-15).
- The "no buyer email" toast (Decision 3) fires synchronously, immediately — it's a precondition check, not a dispatch outcome, so it doesn't need the same non-blocking treatment as the dispatch summary toast.
- `payload.buyer` is exactly `{id, name, email}` — no `contactName`, no `phone` (Decision 8). AC-16 requires a test asserting these keys are genuinely absent from the actual outgoing JSON body, not merely untested.
- `invoiceHtml: buildInvDocHtml(inv)` is called with the **current, in-memory `inv` object** (post-mutation, so it reflects the just-recorded approval fields) — not a re-fetch from `DB.inv`.

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
        <div id="webhook-rules-panel"></div>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <select id="whr-trigger" style="flex:1;min-width:160px;"></select>
          <input type="text" id="whr-url" placeholder="https://hook.us1.make.com/..." style="flex:2;min-width:200px;" autocomplete="off">
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
  if (!url || !url.startsWith('https://')) { toast('Webhook URL must start with https://'); return; }
  if (!SS.webhookRules) SS.webhookRules = [];
  SS.webhookRules.push({ id: uid(), trigger: trigger, url: url, enabled: true, createdAt: new Date().toISOString() });
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

var WEBHOOK_DISCLOSURE_HTML = '&#9432; A webhook rule targeting <b>Invoice: Buyer Approved</b> sends, to the URL you configure: buyer name and email; the full rendered invoice document (financial detail, line items, buyer name/address); and FPM\'s own company bank account details (from Settings &rarr; Company Branding). Only configure a URL you control or trust. Webhook rules are opt-in &mdash; no data is transmitted unless a rule exists and is enabled.';

function renderWebhookRulesPanel() {
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
  var hasApprovedRule = rules.some(function(r){ return r.trigger === 'inv_buyer_approved'; });
  panel.innerHTML = (rows || '<div style="color:var(--m);font-size:.54rem;">No automation webhook rules configured.</div>')
    + (hasApprovedRule ? '<p style="font-size:.48rem;color:var(--m);margin-top:10px;border-top:1px solid var(--ln);padding-top:8px;">' + WEBHOOK_DISCLOSURE_HTML + '</p>' : '');
}
```

`rCfg()` (`index.html:12528-12556`) gains two new lines, placed immediately after the existing `cfg-autoship-toggle` line (`12537`):

```js
  if(G('whr-trigger')) populateWebhookTriggerSelect();
  if(G('webhook-rules-panel')) renderWebhookRulesPanel();
```

**Disclosure requirements, exact (REQ-WEBHOOK-001b/Decision 5, requirements-gate rounds 1/2/3):**
- `addWebhookRule()` for an `inv_buyer_approved` rule cannot be reached without the disclosure notice having been rendered — since `WEBHOOK_DISCLOSURE_HTML` renders inside `renderWebhookRulesPanel()`, and `renderWebhookRulesPanel()` runs on every Settings-tab load (`rCfg()`) and after every add/delete, the notice is present on the same screen as the "+ Add Rule" control from the moment the operator opens Settings — this satisfies "shown before it can be saved" without a separate modal step, and simultaneously satisfies the persistent-note requirement (matching `sendFwdReq()`'s own precedent at `index.html:766`) by construction, since it's the same render call in both cases (AC-4, AC-14).
- The notice text names all three categories exactly: buyer name/email, the full invoice document (financial detail, line items, buyer name/address), and FPM's own bank details — matching §1.3/`SEC-GAP-025`'s text precisely; do not let this string drift from that text independently.
- The notice appears only while at least one `inv_buyer_approved` rule exists (`hasApprovedRule`), and disappears the moment the last one is deleted — AC-14's exact, measurable condition.

---

## 7. `AI_SYSTEM_PROMPT` update (REQ-WEBHOOK-001g)

Add a new bullet under the existing `## Shipments`/Settings-adjacent section of `AI_SYSTEM_PROMPT` (exact insertion point to be located at build time via `grep -n "## Shipments" index.html`, following this codebase's own established per-version practice) describing: Settings → Integrations → Automation Webhooks; the one v1 trigger (`inv_buyer_approved`, fires once per genuine unapproved→approved transition, not on a correction to an already-approved invoice); that it sends one email via an operator-configured Make.com-style webhook with the invoice PDF attached; and that no retry/delivery guarantee exists if the destination is unreachable.

---

## 8. `docs/known-gaps.md` — new `SEC-GAP-025` entry (REQ-WEBHOOK-001h)

Log at ship time, text drawn directly and verbatim-consistent with REQ-WEBHOOK-001-v1.md §1.3 (already fully drafted and review-hardened across 6 rounds — copy that paragraph, do not redraft it independently and risk reintroducing a disclosure-completeness gap this REQ's own review history already closed).

---

## 9. Test plan

All new functions are pure/synchronous-enough to unit test directly against `ctx.*` in `tests/run.js`, following this codebase's `resetDB()`/`mockEl()`/`mockSb()` conventions. Mapped to REQ-WEBHOOK-001's ACs:

| AC | Test |
|---|---|
| AC-1 | `SS.webhookRules` absent → `fireWebhookRules('inv_buyer_approved', {})` returns `{sent:0,failed:0}`, no `fetch()` call (spy/mock `fetch`, assert zero invocations) |
| AC-2 | `addWebhookRule()` with a valid `https://` URL → `SS.webhookRules` gains one entry with the right shape; `renderWebhookRulesPanel()` output contains the URL |
| AC-3 | `addWebhookRule()` with a `http://` (non-https) URL → `SS.webhookRules` unchanged, toast fired |
| AC-4 | `renderWebhookRulesPanel()` output, with one `inv_buyer_approved` rule present, contains `WEBHOOK_DISCLOSURE_HTML`'s text; with zero rules, does not |
| AC-5 | `delWebhookRule(id)` removes exactly that entry; a subsequent `fireWebhookRules()` call no longer reaches it |
| AC-6 | Two enabled rules, one mocked `fetch` rejecting (network failure) and one mocked `fetch` resolving with `{ok:false,status:404}` — both counted in `failed`; a third rule with a normal `{ok:true}` response counted in `sent` — all three independent, `Promise.allSettled` semantics proven by the reject-and-resolve mix not aborting each other |
| AC-7 | `saveInvApprove()` on an unapproved Invoice with a real buyer email and one enabled `inv_buyer_approved` rule → exactly one `fetch()` call, `JSON.parse(callArgs.body)` matches the documented payload shape, `invoiceHtml` non-empty |
| AC-8 | Same, but buyer resolves to `BUY-ADHOC`/blank email → zero `fetch()` calls, distinct toast fired in addition to "Buyer approval recorded" |
| AC-9 | Force the mocked `fetch` to reject → `DB.inv[].buyerApprovedAt`/etc. still set correctly (persistence unaffected by webhook outcome) |
| AC-10 | `buildInvDocHtml(inv)` output, wrapped into the same Blob-construction logic `prevInvDoc()` uses, is byte-identical to `prevInvDoc()`'s pre-refactor output for 3 fixture invoices (Draft, Pro-forma, one with every optional charge field populated) |
| AC-10b | Call `buildInvDocHtml(inv)` directly; assert `window._lastInv`/`window._lastPO` are unchanged from whatever they were set to before the call |
| AC-11 | `saveInvApprove()` twice, with a genuine line-item edit (clearing `buyerApprovedAt` per the pre-existing Phase-2 auto-clear) between calls → webhook fires both times |
| AC-11b | `saveInvApprove()` twice with **no** intervening edit (a correction) → webhook fires only on the first call |
| AC-12 | A buyer/invoice field containing `<script>`/`"` reaches `buildInvDocHtml()`'s output only through existing `san()`-wrapped rendering — confirm no raw injection in the resulting HTML string |
| AC-13 | Manual review of `AI_SYSTEM_PROMPT` against shipped behavior |
| AC-14 | `renderWebhookRulesPanel()` with a rule present vs. absent — disclosure visible/absent exactly as specified |
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

(To be appended after each spec-gate round, per this repo's established convention — empty at initial draft.)
