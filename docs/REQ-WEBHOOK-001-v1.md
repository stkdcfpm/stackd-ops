# REQ-WEBHOOK-001: Generic outbound-webhook automation rules, first rule: Invoice buyer-approval → Make.com email with invoice PDF

## 0. How this REQ came to be scoped this way

Earlier this session, two deferred workstreams were named by the operator: "webhooks/automations for the shipment/invoice workflow" and "Contacts-setup-via-Excel." The operator chose to sequence in-app automation first (shipped as `REQ/SPEC-SHIP-001`, v2.9.86 — auto-created Shipment on Invoice Paid) and explicitly deferred *outbound* webhooks to a separate future REQ, because this app's no-server architecture means an outbound webhook fired from the browser has no delivery guarantee (see §0.1). This REQ is that deferred piece.

The concrete ask, given directly by the operator after a scoping exchange:

> "when a[n] [invoice] is marked approved [i.e. the existing 'Mark Buyer Approved' action on a Pro-forma invoice] should trigger an email to the buyer. also when this happens we should automate a workflow to email the invoice to the buyer." … "one [email], I want to build this [so it] can easily be replicated for other triggers in Make.com" … "email with pdf attached"

Two corrections surfaced during scoping, both confirmed against live code before writing this REQ, not assumed:
- The operator initially said "Purchase Order marked Approved." Purchase Orders have no such status (`index.html:2448` — the fixed set is `Draft/Sent/Deposit Paid/Settled/Cancelled`) and no buyer relationship at all (POs are FPM→Supplier; buyers only relate to Invoices via `Invoice.buyerId`). The operator confirmed the real trigger is the existing Invoice-level "Mark Buyer Approved" action (`saveInvApprove()`, `index.html:8539`), which fires only while an Invoice is at `Pro-forma` status.
- "Email the invoice" was confirmed to mean one email containing a PDF attachment of the invoice document, not two separate emails and not just structured data with no visual document.

Priority, as stated directly by the operator: this REQ is priority #1 of the three now-open post-`REQ-SHIP-001` items (this REQ, an "external agent with live platform data access" idea, and Contacts-via-Excel, in that order — the middle item unranked but not deprioritized, Contacts-via-Excel explicitly ranked last).

### 0.1 What was actually researched (with sources)

Before assuming Supabase (already in this app's stack for Cloud Data) could solve outbound-webhook reliability server-side, this was checked directly rather than answered from training-data recall:

- Supabase **Database Webhooks** fire an HTTP request via the `pg_net` Postgres extension when a table row changes — this runs inside Supabase's own infrastructure, not a browser tab, so it would survive a closed tab or an operator not being logged in. [Database Webhooks | Supabase Features](https://supabase.com/features/database-webhooks)
- However, **`pg_net` does not automatically retry a failed delivery** — this is a confirmed, still-open gap, not an assumption: [Webhook Retries · supabase Discussion #17664](https://github.com/orgs/supabase/discussions/17664), [Add retries · Issue #110 · supabase/pg_net](https://github.com/supabase/pg_net/issues/110). A retry would require a hand-built `pg_cron` job polling `net._http_response`, and that table only retains failure records for 6 hours. [pg_net: Async Networking | Supabase Docs](https://supabase.com/docs/guides/database/extensions/pg_net)

Decision made from this research (§1.2 Decision 7): **do not route this trigger through a Supabase Database Webhook in v1.** `saveInvApprove()` is a deliberate, low-frequency, interactively-clicked operator action (not a high-volume or externally-driven table change), so the browser-side fire-and-forget pattern this codebase already uses for `sendFwdReq()` is simpler, requires no new Postgres/Edge Function infrastructure, and has an equivalent (not worse) reliability profile for this specific trigger — "does the operator's own browser tab survive the few seconds after they click Mark Buyer Approved" is a materially different (and better) reliability question than "does an unattended background event guarantee delivery," and this trigger is always the former. A genuinely unattended, high-reliability-requirement trigger in the future (e.g., a nightly batch process) would warrant re-litigating this via Database Webhooks; this one does not.

## 1. Business context

### 1.1 What exists today (check-first)

All confirmed directly against live `index.html` before writing this REQ:

- **`sendFwdReq()`** (`index.html:13390`) — the only existing "send something to an external party" mechanism in this codebase. A single hardcoded webhook URL (`SS.fwdWebhook`, one Settings field, `saveFwdWebhook()` at `index.html:13406`), used only by the Shipment-forwarder "request an update" action. Payload is `{shipmentRef, message, ts}` — no PII, no financial data. Fire-and-forget: `await fetch(...)` wrapped in try/catch, a toast on success/failure, no retry. This is the direct precedent this REQ extends into a generic, multi-rule mechanism.
- **`saveInvApprove()`** (`index.html:8539`) — records `buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod`/`approvalNote` on an Invoice when the operator confirms the buyer approved a Pro-forma invoice out-of-band (email/WhatsApp/WeChat/phone — never inside the app, per `REQ/SPEC-INTEG-001` Phase 2). It deliberately sends nothing today. This is this REQ's chosen trigger point.
- **No PDF generation anywhere in this codebase.** `prevInvDoc()` (`index.html:10011`) builds a complete HTML document as one local `var html` string, then wraps it in a `Blob`, opens it via `URL.createObjectURL()` in a new browser tab/window, and relies on the operator's own browser Print dialog (`window.print()`) to produce a PDF. There is no `jsPDF`/`html2canvas`/any binary-PDF library, consistent with `CLAUDE.md`'s "no CDN, no dependencies" policy (one deliberate, narrow exception: `vendor/supabase-js-v2.min.js`).
- **No email-sending capability anywhere in this codebase.** No SMTP, no transactional email API integration, no `mailto:`.
- **Buyer entity** (`DB.buy`, `REQ-BUY-001`) has an `email` field (`b.email`). `Invoice.buyerId` links to it. **`BUY-ADHOC`** (`index.html:9377`) is a real, live sentinel Buyer record — `{id:'BUY-ADHOC', email:'', ...}` — used as the fallback whenever an Invoice's `buyerId` is blank or unmatched (`BUY-GAP-002`, confirmed still-open). A meaningful fraction of real invoices in this app can resolve to a buyer with **no email address at all**.
- **`SEC-GAP-024`** already discloses `sendFwdReq()`'s arbitrary-webhook-target risk as an open, low-priority item — but that disclosure covers a payload with no PII and no financial data. This REQ's payload is categorically more sensitive (buyer name, email, invoice amounts) and needs its own explicit disclosure, not silent inheritance of the existing one (§1.3).
- **`SHIP-GAP-001`** (disclosed, not fixed, from `REQ-SHIP-001`) already establishes the precedent in this codebase for naming an async double-submit race as an accepted, disclosed limitation rather than something every new feature must re-solve. This REQ inherits the same disclosed limitation for the "Mark Buyer Approved" button's own submit path (§4).

### 1.2 Design decisions

**Decision 1 — a generic rule mechanism, not a second hardcoded webhook.** The operator explicitly asked for something "easily replicated for other triggers in Make.com." Cloning `sendFwdReq()`'s single-hardcoded-URL pattern a second time would not satisfy that — every future trigger would need its own new Settings field, its own new toggle function, and its own copy-pasted fetch call. Instead:
- `SS.webhookRules[]` — an array of `{id, trigger, url, enabled, createdAt}` records, stored the same way every other `SS.*` setting already is (`sv(K.ss, SS)`).
- A fixed, code-level `WEBHOOK_TRIGGERS` registry — `[{key, label}]` pairs. v1 ships exactly one entry: `{key:'inv_buyer_approved', label:'Invoice: Buyer Approved'}`. A future trigger (e.g. a Shipment status change) is added by (a) one new registry entry and (b) one `fireWebhookRules(key, payload)` call at the relevant existing save-function's call site — no schema change, no new Settings field, no new UI beyond the rule-creation dropdown automatically gaining the new option.
- Settings UI: a new "Automation Webhooks" list (in the existing Integrations card, alongside the pre-existing forwarder-webhook field and the Shipment auto-create toggle) — add/edit/delete rules; each rule picks its trigger from a `<select>` built from `WEBHOOK_TRIGGERS`, has a URL field (`https://` enforced, mirroring `saveFwdWebhook()`'s existing guard exactly), and an enabled checkbox.
- More than one enabled rule can target the same trigger key (e.g. testing two Make.com scenarios in parallel, or one production + one staging). Dispatch fires every matching enabled rule independently — one rule's failure must never suppress or abort another's (`Promise.allSettled` semantics, not a chain that stops at the first rejection).

**Decision 2 — payload carries data + rendered HTML, not an app-generated PDF.** This app has no PDF library and will not gain one for this feature (§1.1). `prevInvDoc()`'s existing HTML-building logic is refactored into a standalone, side-effect-free function — `buildInvDocHtml(inv)` — returning the same HTML string `prevInvDoc()` already builds internally; `prevInvDoc()` itself becomes a thin wrapper that calls it and then does its existing Blob/window-open behavior, so its own visible behavior is unchanged (a byte-identical-output regression test is required, not assumed — see AC). The webhook payload for `inv_buyer_approved` includes this same `invoiceHtml` string, so Make.com's own HTML-to-PDF/email module builds the attached PDF — this app never generates a PDF binary itself.

**Decision 3 — do not fire if there is no real buyer email.** If `inv.buyerId` is blank, equals `'BUY-ADHOC'`, or resolves to a `DB.buy` record whose `email` is blank, `fireWebhookRules('inv_buyer_approved', ...)` must not be called at all, and the operator sees a toast explaining why (mirroring `sendFwdReq()`'s existing "No webhook URL configured" toast pattern) — not a payload sent to Make.com with an empty recipient that fails silently three systems downstream.

**Decision 4 — fire-and-forget, no retry queue, in v1; must never block or endanger the approval record itself.** Same disclosed architecture constraint as `sendFwdReq()`/`SHIP-GAP-001`: if the browser tab closes moments after the click, or Make.com is briefly unreachable, that one delivery is lost with no retry. Out of scope for v1, named explicitly (§4) rather than silently downgraded. Corollary requirement: the webhook fire must happen only *after* `saveInvApprove()`'s own persistence (local or Cloud Data) has already succeeded, and its own success/failure must never be allowed to roll back or block the approval record — the approval is real and saved regardless of whether the notification succeeds.

**Decision 5 — new GDPR/security disclosure required, not inherited from `SEC-GAP-024`.** This is the first outbound-webhook mechanism in this codebase carrying real personal data (buyer name, email) and financial data (invoice amounts, line items) to an operator-configured, arbitrary external URL — categorically more sensitive than `sendFwdReq()`'s shipment-ref-plus-free-text payload. Requirements:
- The rule-creation UI must show an explicit, un-skippable inline notice — naming exactly what leaves the app (buyer name, email, invoice financial data) — before a rule targeting `inv_buyer_approved` can be saved. This is a stronger bar than a generic Settings field deserves, given the sensitivity step-up.
- A new, explicit `SEC-GAP-025` entry is logged in `docs/known-gaps.md` at ship time (§1.3), not silently folded into the existing `SEC-GAP-024` entry.

**Decision 6 — no idempotency/dedup guard needed for this trigger, unlike `REQ-SHIP-001`'s.** `autoCreateShipmentFromInvoice()` needed idempotency because it hangs off `saveInv()`, a function that runs on every edit to an Invoice regardless of relevance. `saveInvApprove()` is structurally different: it only runs when the operator deliberately clicks "Mark Buyer Approved," and Phase 2's pre-existing auto-clear-on-line-edit behavior (editing any line after approval nulls `buyerApprovedAt` and the related fields, forcing a fresh approval) means every successful call to this function represents a genuinely new approval event. Firing the webhook on every successful `saveInvApprove()` call, with no separate dedup field, is therefore correct — not an oversight. (This claim is a real design assertion, not just an assumption, and must survive independent review, not be waved through because it sounds right.)

**Decision 7 — browser-side fire, not a Supabase Database Webhook, for this trigger specifically.** See §0.1's research. Explicitly scoped to this trigger's own low-frequency, interactively-clicked nature — not a general policy against ever using Database Webhooks for a future trigger.

### 1.3 GDPR / security note

`docs/known-gaps.md` gains a new entry, `SEC-GAP-025`, at ship time: an operator who creates an `inv_buyer_approved` webhook rule is configuring this app to transmit a named buyer's name, email address, and this invoice's financial detail (amounts, line items) to a third-party URL of the operator's own choosing (typically a Make.com scenario webhook), over HTTPS but with no further guarantee — no data processing agreement tracking, no confirmation the receiving endpoint is itself GDPR-compliant, no way for this app to know or control what that endpoint does with the data afterward. This is opt-in only (a rule must be deliberately created; none exist by default) and disclosed to the operator at rule-creation time per Decision 5. This mirrors the acceptance basis already established for `SEC-GAP-002` (Sheets sync PII) and `SEC-GAP-024` (the narrower `sendFwdReq()` case) — accepted as a known, disclosed trade-off of this app's no-server architecture, not treated as a blocking defect.

## 2. Requirements

### REQ-WEBHOOK-001a — `SS.webhookRules[]` schema + `WEBHOOK_TRIGGERS` registry
A new `SS.webhookRules` array, each entry `{id, trigger, url, enabled, createdAt}`. A new top-level `WEBHOOK_TRIGGERS` constant array of `{key, label}`, v1 containing exactly one entry: `{key:'inv_buyer_approved', label:'Invoice: Buyer Approved'}`.

### REQ-WEBHOOK-001b — Settings UI: Automation Webhooks rule list
New section in the existing Settings → Integrations card. Lists existing rules (trigger label, URL, enabled state, delete button). An "Add Rule" control: trigger `<select>` built from `WEBHOOK_TRIGGERS`, URL `<input>`, enabled checkbox. URL must start with `https://` (same guard as `saveFwdWebhook()`) or the save is rejected with a toast. Before a rule targeting `inv_buyer_approved` can be saved, an inline, un-skippable notice naming what data will be sent (buyer name, email, invoice financial data) must be shown (Decision 5).

### REQ-WEBHOOK-001c — `fireWebhookRules(triggerKey, payload)` shared dispatch function
Looks up every `SS.webhookRules` entry where `trigger === triggerKey && enabled`. For each match, fires an independent `fetch(rule.url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})`, awaited via `Promise.allSettled` (never a chain that aborts remaining rules on one failure). Returns a summary (`{sent, failed}` counts) for the caller to toast. Must be callable with zero matching rules (a no-op, not an error) — a trigger existing in the registry with no rule configured for it yet is the normal, expected v1 state for every operator who hasn't set one up.

### REQ-WEBHOOK-001d — `buildInvDocHtml(inv)` extraction from `prevInvDoc()`
`prevInvDoc()`'s existing HTML-string-building logic (`index.html:10011`–`10148` at time of writing) is extracted into a standalone `buildInvDocHtml(inv)` function returning that HTML string, with no DOM/window side effects. `prevInvDoc(inv)` itself becomes `var html = buildInvDocHtml(inv); ` followed by its existing unchanged Blob/`window.open()` behavior. `prevInvDoc()`'s own externally-visible behavior (the opened tab's content) must be byte-identical before and after this refactor — an explicit regression test is required (§3), not assumed from the mechanical nature of the change.

### REQ-WEBHOOK-001e — `saveInvApprove()` wiring
After `saveInvApprove()`'s own persistence (`persistInvChange()`/`sv(K.i, DB.inv)`) has completed successfully, resolve the Invoice's buyer via the same `buyerId`-then-`BUY-ADHOC`-fallback logic already used elsewhere in this codebase (Decision 3's precondition). If a usable buyer email is found, build the payload (§ payload shape below) and call `fireWebhookRules('inv_buyer_approved', payload)`. If no usable buyer email is found, skip the call and toast an explicit reason (Decision 3) instead of the normal "Buyer approval recorded" toast alone — both messages should be visible, not one replacing the other.

**Payload shape:**
```json
{
  "trigger": "inv_buyer_approved",
  "invoice": { "id", "num", "status", "cur", "date", "grandTotal", "balanceDue", "buyerApprovedAt", "buyerApprovedBy", "approvalMethod", "approvalNote" },
  "buyer": { "id", "name", "email", "contactName", "phone" },
  "lineItems": [ { "desc", "uom", "qty", "up", "lineTotal" }, ... ],
  "invoiceHtml": "<the string buildInvDocHtml(inv) returns>",
  "ts": "<ISO timestamp>"
}
```

### REQ-WEBHOOK-001f — Precondition guard (Decision 3)
A shared helper (e.g. `resolveBuyerForWebhook(inv)`) returns the matched Buyer record or `null` if unresolvable/blank-email/`BUY-ADHOC`. `saveInvApprove()`'s wiring (REQ-WEBHOOK-001e) must use this helper rather than inlining the check, since any future trigger involving a Buyer email should reuse the identical logic rather than re-deriving it.

### REQ-WEBHOOK-001g — `AI_SYSTEM_PROMPT` update
Per `CLAUDE.md`'s mandatory-every-version rule: describe the Automation Webhooks mechanism, the `inv_buyer_approved` trigger, and the precondition/skip behavior, so the in-app AI assistant can accurately answer an operator's question about it.

### REQ-WEBHOOK-001h — `docs/known-gaps.md` — `SEC-GAP-025`
Log per §1.3 at ship time.

## 3. Acceptance criteria

1. **AC-1**: `SS.webhookRules` defaults to `[]`/absent-safe — an operator who has never configured a rule sees no behavior change anywhere (`saveInvApprove()` runs exactly as it does today, `fireWebhookRules()` is a no-op).
2. **AC-2**: Adding a rule via the new Settings UI with trigger `inv_buyer_approved` and a valid `https://` URL persists it into `SS.webhookRules` and it appears in the rule list on reload.
3. **AC-3**: A URL not starting with `https://` is rejected at save time with a toast; no rule is added.
4. **AC-4**: The PII-disclosure notice (Decision 5) is shown before a rule targeting `inv_buyer_approved` can be saved; the rule cannot be saved without it having been shown (not necessarily a checkbox-gate, but the notice must render, not be saveable-around).
5. **AC-5**: Deleting a rule removes it from `SS.webhookRules` and stops it from firing on the next trigger.
6. **AC-6**: Two enabled rules targeting the same trigger both fire independently; one URL that 404s does not prevent the other from firing or being reported as sent.
7. **AC-7**: Calling `saveInvApprove()` on an Invoice whose buyer resolves to a real email, with one enabled `inv_buyer_approved` rule configured, results in exactly one `fetch()` POST to that rule's URL, with a payload matching REQ-WEBHOOK-001e's shape, containing the correct invoice number, buyer email, line items, and a non-empty `invoiceHtml` string.
8. **AC-8**: The same call on an Invoice whose `buyerId` is blank, `'BUY-ADHOC'`, or resolves to a Buyer with a blank `email` results in zero `fetch()` calls, and a distinct toast explaining why, in addition to (not instead of) the normal approval-recorded toast.
9. **AC-9**: `saveInvApprove()`'s own persistence (the approval fields being saved to `DB.inv`) succeeds identically whether the webhook fetch succeeds, fails, or throws — verified by forcing a fetch rejection and confirming `inv.buyerApprovedAt` etc. are still set correctly afterward.
10. **AC-10**: `buildInvDocHtml(inv)` returns a string; `prevInvDoc(inv)`'s resulting Blob content is byte-identical to what it produced before the refactor, for at least one representative Invoice fixture (Draft, Pro-forma, and one with all optional charge fields populated, to exercise the conditional blocks in `prevInvDoc()`'s own logic).
11. **AC-11**: Calling `saveInvApprove()` a second time on the same Invoice after Phase 2's auto-clear-on-line-edit has fired (a fresh, genuine second approval) fires the webhook again — confirming Decision 6's no-dedup design is deliberate, not a gap.
12. **AC-12**: A malicious value in any buyer/invoice field reaching the payload (e.g. a buyer name containing `"` or `<script>`) does not break the JSON payload's own structure — `JSON.stringify()` already guarantees this structurally, but the corresponding `invoiceHtml` field must still be built through `buildInvDocHtml()`'s own existing `san()`-wrapped rendering (REQ-WEBHOOK-001d does not weaken this).
13. **AC-13**: `AI_SYSTEM_PROMPT` accurately describes the feature (manual review against the shipped behavior, per `CLAUDE.md`'s standing rule).

## 4. Explicitly out of scope for v1

- **No retry queue or delivery guarantee** beyond a single fire-and-forget `fetch()` attempt (Decision 4). A local pending-queue-with-retry-on-next-load is a possible future v2, named here, not built.
- **No PDF generation inside this app** (Decision 2) — Make.com's own HTML-to-PDF/email tooling is the intended consumer of `invoiceHtml`.
- **No trigger other than `inv_buyer_approved` ships in v1.** The registry pattern (REQ-WEBHOOK-001a) is designed to make a future trigger cheap to add, but none besides this one is built now — resist the temptation to "just add one more while we're in here."
- **No Supabase Database Webhook path** for this trigger (Decision 7) — a possible future re-evaluation for a different, genuinely unattended/high-volume trigger, not built here.
- **No double-submit / duplicate-click protection on the "Mark Buyer Approved" button itself.** This inherits the same disclosed, pre-existing async-race class as `SHIP-GAP-001` — a rapid double-click could theoretically fire the webhook twice for one logical approval. Disclosed, not fixed, consistent with the `REQ-SHIP-001` precedent for this exact risk class.
- **Local-only (no Cloud Data configured) operators are unaffected either way** — this trigger fires from the browser regardless of whether Cloud Data is configured, and never touches Supabase directly. Explicitly confirmed, not assumed, since several other recent REQs in this codebase have Cloud Data-shaped edge cases that this one genuinely does not have.
- **Editing an already-configured rule's URL does not retroactively resend any past payload.** Obvious, but stated for the record.

## 5. Resolved decisions log (previously open questions)

| # | Question | Resolution |
|---|---|---|
| 1 | Real trigger entity/status? | Invoice "Mark Buyer Approved" action on a Pro-forma invoice — not a Purchase Order, which has no Approved status and no buyer relationship. Confirmed by the operator after live-code verification. |
| 2 | One email or two? | One email. |
| 3 | What does "email the invoice" mean? | One email with a PDF of the invoice attached, built by Make.com from data + HTML this app provides — not an app-generated PDF binary. |
| 4 | Priority vs. the other two open items (external agent, Contacts-via-Excel)? | This REQ is #1. External agent is #2 (unranked internally but not deprioritized). Contacts-via-Excel is explicitly #3. |
| 5 | Route via Supabase Database Webhooks or browser fire-and-forget? | Browser fire-and-forget for this trigger specifically (Decision 7) — researched and cited, not assumed; a different future trigger could re-open this. |

## 8. Self-review log

Self-reviewed before requirements-gate:
- Verified every code citation (`sendFwdReq()`, `saveInvApprove()`, `prevInvDoc()`, PO status list, `BUY-ADHOC`) directly against live `index.html` line-by-line, not from memory of earlier summaries in this session.
- Checked for an existing "Approved" PO status and an existing PO→Buyer relationship before accepting the operator's corrected framing — both confirmed absent, not just assumed absent.
- Researched Supabase Database Webhook retry behavior via live web search rather than answering from training-data recall, per the operator's own standing instruction not to bluff on verifiable technical claims — cited sources in §0.1.
- Considered whether `inv_buyer_approved` needs an idempotency/dedup field analogous to `REQ-SHIP-001`'s `autoCreatedFromInvIds[]`, and concluded no, with an explicit reasoning chain (Decision 6) rather than silently omitting it — flagged as a claim that must survive independent review, not asserted as obviously correct.
- Considered the GDPR/security step-up from `sendFwdReq()`'s existing narrow disclosure and concluded a new, explicit `SEC-GAP-025` entry is warranted rather than folding into `SEC-GAP-024` (Decision 5, §1.3).
