# Known Gaps — Post-Pilot Review

Items deferred from initial build. Review after pilot period before wider rollout.

---

## MTD / VAT Return

### MTD-GAP-001 — Input VAT not tracked; Boxes 4 and 7 always £0.00 *(Open)*
**Area:** MTD VAT Return — purchase-side VAT  
**Logged:** v2.9.32  
**Detail:** `DB.po` records purchase costs in supplier currency but no UK VAT invoices are captured. Input VAT reclaim (Box 4) and total purchases (Box 7) cannot be derived from current data. Both boxes are hardcoded £0.00 in `calcVATReturn()`. Operator must enter these figures manually in their MTD bridging tool before submission.  
**Resolution:** Capture purchase VAT invoices in a future version (v3.x). Until then, operator responsibility acknowledged.

### MTD-GAP-002 — FX rates at export time, not invoice date *(Open)*
**Area:** MTD VAT Return — currency conversion  
**Logged:** v2.9.32  
**Detail:** `toGBP()` uses live-configured QR rates at export time, not the rate prevailing on each invoice date. Historic rate variance between invoice date and export date is the operator's responsibility. HMRC does not mandate a specific FX rate method for bridging software VAT returns; operator must apply judgment.  
**Resolution:** Store per-invoice exchange rates at save time (v3.x). Until then, operator responsibility acknowledged (MTD-GAP-002).

---

## Buyers

### BUY-GAP-001 — Buyers not synced to Google Sheets *(Open — deferred FM-1)*
**Area:** Buyers → Sheets sync  
**Logged:** v2.9.37  
**Detail:** `DB.buy` is excluded from all Sheets sync operations (push/pull/sync). FM-1 freeze prohibits new sync mappings on v2.9.x.  
**Resolution:** Add `buy` sync mapping in v3.x after FM-1 freeze is lifted.

### BUY-GAP-002 — Legacy invoice buyer field text fallback *(Open)*
**Area:** Buyers → Invoice backward compatibility  
**Logged:** v2.9.37  
**Detail:** Invoices created before v2.9.37 carry `inv.buyer` (free-text string) but no `inv.buyerId`. When editing such an invoice, a case-insensitive name match attempts to resolve to a buyer record; if no match, it defaults to BUY-ADHOC. If the operator has multiple buyers with similar names, the wrong record may be pre-selected.  
**Resolution:** Operator should verify buyer assignment when editing legacy invoices. Full migration deferred to v3.x.

### BUY-GAP-003 — Credit limit enforcement is display-only *(Open)*
**Area:** Buyers → credit limit  
**Logged:** v2.9.37  
**Detail:** The credit limit field on a buyer record is stored and displayed in the buyer summary panel but is not enforced — no warning or block is raised when invoices exceed the limit.  
**Resolution:** Add credit limit breach warning on invoice save in a future sprint.

---

## Quote Engine

### QTE-GAP-001 — No quote status workflow enforcement *(Fixed v2.9.25)*
**Area:** Quotes → status field / Convert to PO button  
**Logged:** v2.9.4; **Fixed:** v2.9.25  
**Detail:** The quote status field (`Draft → Sent → Accepted → Declined / Expired`) was a free select with no transition guards. The Convert to PO button was available on any status (only blocked if a PO was already linked).  
**Fixed in v2.9.25:**
- Convert to PO button hidden unless `status === 'Accepted'`; updates live when status dropdown changes (`updQtePoBtn()` called on `onchange`)
- `qteToPoConvert()` hard-guards against non-Accepted status (defensive — button is the primary control)
- "PO RAISED" badge shown in edit modal title once `linkedPOId` is set
**Remaining open items (deferred):**
- `Freight Confirmed` status requiring CBM > 0 on all lines — deferred until real-world freight workflow is established
- Full read-only lock after PO raised (status/notes still editable) — deferred post-pilot

---

## Security — Accepted Architecture Risks

### SEC-GAP-001 — Apps Script sync token and spreadsheet IDs in source control *(FIXED)*
**Area:** `apps-script/Code.gs`  
**Logged:** v2.9.12 (security gate review)  
**Code fix:** v2.9.15 — hardcoded values removed from `Code.gs` and `STACKD_CONTEXT.md`. Source now reads all four values from `PropertiesService.getScriptProperties()`.  
**Manual step:** Complete — Script Properties set (`SPREADSHEET_ID`, `TOKEN`, `REQUIREMENTS_TRACKER_ID`, `PROJECT_TRACKER_ID`), token rotated, Apps Script redeployed. Test Connection confirmed ✓ (2026-06-06).  
**Detail:** `SPREADSHEET_ID`, `TOKEN`, `REQUIREMENTS_TRACKER_ID`, and `PROJECT_TRACKER_ID` were hardcoded in `Code.gs`, which is version-controlled. The sync token is a simple shared-secret guard. The spreadsheet IDs are Google Workspace GUIDs. Anyone with access to the private repo and the Apps Script deployment URL could call any sync action.  
**Decision:** Fully resolved.

### SEC-GAP-002 — Sheets sync transmits PII externally without formal DPA
**Area:** `syncEnt`, `delEnt`, `syncAll`, `pushAll` — Cloudflare Worker → Google Apps Script  
**Logged:** v2.9.12 (security gate review)  
**Detail:** When Sheets sync is configured and enabled, supplier contact data (name, email, phone), buyer name/address, forwarder email, and invoice/payment records are transmitted to a Cloudflare Worker and on to Google Sheets. Under GDPR this requires a Data Processing Agreement with Google (covered by Google Workspace ToS for commercial accounts) and Cloudflare (covered by Cloudflare ToS). No in-product privacy notice is shown at data entry. The sync is opt-in — if `SS.url` is not configured, no data is transmitted.  
**Risk level:** Low while FPM operates as a sole-operator internal tool with no external client data in the system. Becomes a formal compliance obligation before onboarding first external client.  
**Decision:** Accepted. Document DPA status before ICO registration. **In-product disclosure note added to Settings → Google Sheets card (v2.9.18).** Becomes a formal compliance obligation before onboarding first external client.

### SEC-GAP-003 — Anthropic API key stored in browser localStorage
**Area:** Settings → AI Assistant card; `AI.key` in `localStorage`  
**Logged:** v2.9.x (pre-existing, flagged at security gate review)  
**Detail:** The Claude API key is stored in `localStorage` and transmitted directly from the browser to the Anthropic API (`anthropic-dangerous-direct-browser-access: true` header required by Anthropic). Any XSS vulnerability on the page could exfiltrate the key. This is a known limitation of all no-server browser AI integrations.  
**Risk level:** Low while XSS vectors are mitigated (all user inputs wrapped in `san()` before innerHTML). Medium if an XSS is introduced in future.  
**Decision:** Accepted as an inherent no-server design constraint. Anthropic's own header naming acknowledges this pattern. XSS hygiene is the primary mitigation.

### SEC-GAP-004 — Invoice locking is a client-side UX control, not a tamper-proof security control
**Area:** Invoice status locking — `LOCKED_STATUSES`, `_unlockedInvIds`, `canTransitionStatus`  
**Logged:** v2.9.12  
**Detail:** Invoice locking prevents accidental edits via the UI but can be bypassed by direct localStorage modification, browser DevTools, or JSON import. The lock re-engages on page reload. This is the correct design for a no-server app and is consistent with HMRC guidance that electronic audit trails supplement rather than replace paper records. It must not be presented to auditors as a cryptographic or tamper-proof control.  
**Decision:** By design. Document in operator guide.

### SEC-GAP-005 — Forwarder webhook transmits shipment data without in-product notice
**Area:** Settings → Integrations → Power Automate Webhook URL; `sendFwdRequest()`  
**Logged:** v2.9.14 (audit)  
**Detail:** When a forwarder webhook URL is configured, `sendFwdRequest()` POSTs shipment data (origin/destination ports, ETD, cargo description, forwarder contact details) to an external endpoint. No in-product notice is shown at configuration time. The webhook is opt-in — if `SS.fwdWebhook` is not set, no data is transmitted. Forwarder contact data (name, email) is PII.  
**Risk level:** Low at current scale. Becomes a formal compliance obligation before onboarding external clients.  
**Decision:** Accepted. **In-product disclosure note added to Settings → Integrations card (v2.9.18).** Becomes a formal compliance obligation before onboarding external clients.

### SEC-GAP-006 — `stackd_co_*` localStorage keys outside the `K` registry
**Area:** Company branding — `stackd_co_name`, `stackd_co_addr`, `stackd_co_accent`, `stackd_co_footer`, `stackd_co_vat`, `stackd_co_logo`, `stackd_co_powered`  
**Logged:** v2.9.14 (audit)  
**Detail:** Company branding settings are stored directly under `stackd_co_*` keys without registration in the `K` constant. This means they are invisible to `saveAll()`, the snapshot export (`expAll`), and the import handler (`doImport`). A full data export/import will silently omit branding settings. The `ldArr` safety wrapper also does not apply.  
**Risk level:** Low — branding is cosmetic and easily re-entered. Medium if logo (base64 blob) is large and causes silent localStorage quota pressure.  
**Decision:** Partially fixed v2.9.20 — `expAll()` now includes `branding: getCoBrand()` in the snapshot; `doImport()` calls `saveCoBrand(data.branding)` on restore. Keys remain outside `K` (formal registration deferred to a future settings consolidation). The `ldArr` safety wrapper gap remains open.

### SEC-GAP-007 — Sync token transmitted in request body *(Partially fixed; Apps Script constraint)*
**Area:** `sPost()`, `sGet()`, `testConn()` — all Sheets sync call sites  
**Logged:** v2.9.14 (token in URL query string); v2.9.38 (token in POST body)  
**History:**
- v2.9.14: Fixed URL query string exposure — token moved to POST body (`{ _token: tok }`)
- v2.9.38: Attempted to move token to `Authorization: Bearer` header to prevent it appearing in request body logs. Reverted in v2.9.38 hotfix — Google Apps Script's `doPost(e)` event object does not expose HTTP headers (no `e.headers` property); the token in the `Authorization` header was silently ignored, breaking all sync auth.
**Current state:** Token transmitted in POST body as `_token`. `Content-Type: application/json` header added. POST body is less likely to appear in CDN access logs than URL query strings, making this an improvement over the v2.9.14 state.  
**Full fix path:** A Cloudflare Worker proxy sitting in front of the Apps Script endpoint could receive the `Authorization: Bearer` header, extract the token, and inject it as `payload._token` before forwarding — keeping the credential out of the browser's outbound body. Deferred: requires Cloudflare Worker deployment.  
**Decision:** Accepted as an Apps Script architectural constraint. Token-in-body is the correct approach for direct browser → Apps Script calls.

### SEC-GAP-008 — No Content Security Policy header *(FIXED v2.9.16)*
**Area:** GitHub Pages deployment; `index.html`  
**Logged:** v2.9.14 (audit); **Fixed:** v2.9.16  
**Detail:** Prior to v2.9.16, the app shipped no `Content-Security-Policy` header or meta tag. Fixed by adding `<meta http-equiv="Content-Security-Policy">` to `<head>` with policy: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https:; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'`. `'unsafe-inline'` for scripts/styles is required by the single-file architecture but `connect-src https:`, `object-src 'none'`, and `base-uri 'self'` provide meaningful defence-in-depth.

### SEC-GAP-011 — `pullAll()` overwrites local records with no conflict resolution
**Area:** `pullAll()` — sync pull merge logic  
**Logged:** v2.9.23 (sync layer review); see also SYNC-GAP-001 (push-side equivalent)  
**Detail:** When `pullAll()` fetches records from Sheets, the merge for any record that exists both locally and in Sheets is unconditional: Sheets wins. No `updAt` timestamp comparison is performed. If Operator A edits a record locally and has not yet pushed, and Operator B pushes their version in the interim, Operator A's next pull silently overwrites their local edits with no warning, no diff, and no audit entry. Records carry `updAt` fields but these are not consulted during pull merge. Note: the push-side equivalent (bulk_upsert clear-and-rewrite destroying records the operator doesn't hold locally) is documented separately as SYNC-GAP-001.  
**Risk level:** Low if operators work on disjoint datasets. Medium if two operators edit the same record within the same session before either syncs — silent data loss with no indication a conflict occurred.  
**Decision:** Accepted at 3-operator scale with process discipline (pull before editing, push after saving). Architectural fix — timestamp-based merge in `pullAll()` using `updAt` — deferred; requires `updAt` to be added to `FIELD_MAPS` so it survives a Sheets round-trip. Full resolution: server-side conflict resolution (Supabase backend, v3.0.0 roadmap).

---

## Library (Line Items)

### LIB-GAP-001 — `syncEnt('li')` not called on `invoiceRefs` mutation
**Area:** Library → `saveInv()` / `delInv()` — `invoiceRefs` field on `DB.li` records  
**Logged:** v2.9.7  
**Detail:** When `saveInv()` or `delInv()` mutates `invoiceRefs` on library catalogue records, it calls `sv(K.l, DB.li)` (localStorage write) but does not call `syncEnt('li', ...)` (remote Sheets push). This means the remote copy of the library will lag behind until the next explicit library save or next full sync. Acceptable at pilot stage because `invoiceRefs` is a derived index (fully recoverable from invoice data) and remote sync is not the primary persistence path.  
**Options for post-pilot:**
- Call `syncEnt('li', ...)` after each `invoiceRefs` mutation in `saveInv()` / `delInv()`
- Add a reconcile pass in the sync pull to rebuild `invoiceRefs` from pulled invoice data  
**Decision:** Deferred. The index is local-first; stale remote copy has no operational impact at current scale.

---

## Code Quality

### CODE-GAP-001 — `pullAll()` undefined variable crash *(FIXED v2.9.14)*
**Area:** `pullAll()` — entity merge block  
**Logged:** v2.9.14 (audit); **Fixed:** v2.9.14  
**Detail:** Prior to v2.9.14, the merge line `DB.inv = pulledInv.concat(localOnlyInv)` sat outside the per-entity `if` block and referenced variables (`pulledInv`, `localOnlyInv`) that do not exist in scope. The loop uses `pulled` and `localOnly`. This caused a ReferenceError crash on every `pullAll()` invocation. Fixed by moving the assignment inside the `if` block and using the correct variable names: `DB[ent] = pulled.concat(localOnly)`.

---

## Data Quality

### DATA-GAP-001 — `repairCalcFields()` contains FPM-specific hardcoded invoice IDs *(FIXED v2.9.21)*
**Area:** `repairCalcFields()` — dashboard KPI correction utility  
**Logged:** v2.9.14 (DAMA DMBOK audit); **Fixed:** v2.9.21  
**Detail:** `repairCalcFields()` previously contained hardcoded corrections for FPM invoice IDs (`INV10028`–`INV10032`) with hardcoded COGS values, running on every `initApp()`. Fixed by extracting the FPM-specific data into `runFPMMigration()` — a one-time migration guarded by a `st_fpm_repair_v1` localStorage flag. `repairCalcFields()` now contains only the generic cnAmount strip (operator-safe, no hardcoded IDs). `runDataRepair()` (Settings → ⚙ Repair invoice totals) updated to call the generic repair only. New operators start with the migration flag pre-satisfied and are never touched by FPM data.

### DATA-GAP-002 — PII hardcoded in company settings defaults *(FIXED v2.9.14)*
**Area:** `let AS = ld(K.as) || { ... }` — company branding defaults  
**Logged:** v2.9.14 (audit); **Fixed:** v2.9.14  
**Detail:** Prior to v2.9.14, `AS` defaults included FPM International's real company name, address, bank details, and contact information. This meant any operator who deployed Stackd Ops without configuring company settings would unknowingly use FPM data on their PDFs, and the data would be visible in source control. Fixed by replacing all defaults with empty strings.

---

## Sync

### SYNC-GAP-001 — `Push All` / `Sync` is a destructive clear-and-rewrite for other operators' Sheets records
**Area:** `syncAll()` / `pushAll()` → `handleBulkUpsert` in `apps-script/Code.gs`  
**Logged:** v2.9.22 (sync layer review)  
**Detail:** The `bulk_upsert` action in `Code.gs` clears all data rows from a sheet tab and rewrites it entirely from the calling operator's local data. If Operator A runs Push All or Sync while Operator B has records in Sheets that A doesn't have locally (because A hasn't pulled since B pushed), those records are silently deleted from Sheets. Individual record auto-saves (`syncEnt`, called on every save) use row-level upsert and are safe for concurrent use. Only the bulk operations (`syncAll`, `pushAll`) are destructive.  
**Risk level:** Low if operators work on disjoint datasets (separate buyers/invoices). HIGH if operators share or cross-reference the same records.  
**Process rule (enforced by discipline, not code):** Only one operator runs Push All at a time. Always pull before pushing. Individual save auto-sync is safe at all times.  
**Decision:** Accepted at 3-operator scale with process discipline. Architectural fix (server-side merge) is out of scope for a localStorage-first app.

---

## SDLC & Process

### SDLC-GAP-001 — Version identity inconsistency across the codebase
**Area:** `<title>`, nav version badge, in-app changelog, `AI_SYSTEM_PROMPT`, `CLAUDE.md`, `STACKD_CONTEXT.md`  
**Logged:** v2.9.14 (audit)  
**Detail:** At the time of the v2.9.14 audit, `<title>` and the nav badge displayed v2.9.10; `AI_SYSTEM_PROMPT` declared v2.9.13; `CLAUDE.md` declared v2.9.13; `STACKD_CONTEXT.md` referenced v2.9.12 as current. The in-app changelog was frozen at v2.9.10. Version identity was fractured across at least 5 locations. Fixed in v2.9.14. The "On version delivery" checklist in `CLAUDE.md` must be followed on every release to prevent recurrence.  
**Decision:** Resolved. Checklist-enforced going forward.

---

## Data Safety

### BACKUP-GAP-001 — No backup/recovery mechanism audited or enforced *(Partially resolved v2.9.23)*
**Area:** All data — `localStorage` is the sole persistence layer  
**Logged:** v2.9.15 (LLM Council audit verdict 2026-06-04)  
**Detail:** The app holds live invoices, POs, shipments, payments, quotes, and supplier records with no server-side persistence, no transaction log, and no automatic backup. `localStorage` is wiped by: browser "Clear site data", private/incognito browsing, device failure, browser profile corruption, or OS reinstall. The JSON export (Settings → Data → Export All) is the only recovery path. **The council rated this the highest-probability failure mode — above any security gap.**  
**Resolved in v2.9.23:**
- DR procedure documented and tested — see `docs/dr-procedure.md`
- Export expanded to include QR rates, custom ports, custom payment terms, custom UOM, and migration flags (previously missing from backup)
- Export snapshot version bumped to `_version: 2`
**Remaining gap:** No automatic backup — export must be triggered manually by the operator. No periodic reminder prompt implemented.  
**Decision:** DR procedure complete. Automatic backup / periodic reminder deferred to post-pilot. Full resolution: Supabase backend (v3.0.0) provides server-side persistence.

### BACKUP-GAP-002 — localStorage quota cliff with no guard *(Fixed v2.9.24)*
**Area:** All `localStorage` writes — `sv()`, `saveAll()`, `stackd_co_*` keys  
**Logged:** v2.9.15 (LLM Council audit verdict 2026-06-04); **Fixed:** v2.9.24  
**Detail:** Browser `localStorage` has a hard limit of approximately 5–10 MB (varies by browser). When the limit is reached, `localStorage.setItem()` throws a `QuotaExceededError` silently — no data is written, no user feedback is shown, and the app continues as if the save succeeded.  
**Fixed in v2.9.24:**
- `sv()` `QuotaExceededError` handler upgraded from a 9-second dismissible toast to `showQuotaModal()` — a blocking overlay modal with a one-click "Export Backup Now" button that immediately triggers `expAll()`. Cannot be silently missed.
- `onCoLogoUpload()` `localStorage.setItem` wrapped in try/catch with `showQuotaModal()` on quota error — logo write was previously outside `sv()` and had no error handling at all.
- `checkStorageQuota()` init-time 75%/90% toasts remain as early warnings.
**Remaining open item:** `navigator.storage.estimate()` (more accurate than byte-counting) — deferred; current heuristic is sufficient for practical purposes.

### SDLC-GAP-003 — No staging/preview environment for PR review
**Area:** SDLC — branch preview, PR testing before merge  
**Logged:** v2.9.24 (LLM Council verdict 2026-06-06)  
**Detail:** There is no way to preview a PR branch as a running app before merging. GitHub Pages serves static HTML without executing JS (wrong MIME type). The obvious fix — Netlify PR preview deployments — is blocked by a structural constraint: `localStorage` is origin-scoped, so a preview on `*.netlify.app` presents an empty app to reviewers with no data. The council unanimously identified this as a show-stopper for Netlify-style previews.  
**What is in place:** GitHub Actions CI (`qa.yml`) runs `node tests/run.js` on every PR — 193 tests, catches regressions automatically. This is the primary regression guard.  
**Council recommendation (2026-06-06):** Same-origin preview via a GitHub Actions workflow that deploys each PR branch to `stkdcfpm.github.io/stackd-ops/preview/PR-N/` — solves both MIME type and origin isolation in one move. Defer Netlify until there is a concrete need for serverless functions.  
**Decision:** CI covers regression detection. Same-origin gh-pages preview deferred to post-pilot. Netlify deferred indefinitely unless SEC-GAP-003 (API key in browser) is escalated to require a server-side proxy.

### SDLC-GAP-002 — Gate evidence trail exists only in chat, not in persistent artefacts
**Area:** Agent pipeline — `requirements-gate`, `spec-gate`, `build-gate`, `security-gate`  
**Logged:** v2.9.14 (BABOK / agent architecture audit)  
**Detail:** Gate agents produce structured reports in the Claude chat session. These reports are not persisted to Git, Notion, or any durable store. A gate PASS in session has no artefact that proves it ran. This means the audit trail only exists in Claude session history (ephemeral) and is not verifiable by a third party or auditor. The agent architecture doc notes "Every gate produces a logged evidence record" but this is aspirational — the Notion MCP integration is not yet wired.  
**Options for post-pilot:**
- Write gate output to a `docs/gate-evidence/` directory in Git as markdown files
- Wire Notion MCP to post gate results to the Requirements Tracker
- Add a mandatory "evidence tag" to every PR that references a gate run  
**Decision:** Deferred. Implement before ICO registration or first external client onboarding.

---

## Process & Accounting

### PROC-GAP-001 — Multi-currency KPI aggregation without FX conversion *(FIXED v2.9.15)*
**Area:** Dashboard → KPI tiles (Invoice Revenue, Net Profit, Outstanding from Buyers, Net Cash Position)  
**Logged:** v2.9.x (LLM Council audit verdict 2026-06-04); **Fixed:** v2.9.15  
**Detail:** Prior to v2.9.15, dashboard KPI aggregations totalled amounts across USD, GBP, and BBD invoices as if they were the same currency — no FX conversion applied, no warning shown. An operator making margin or cash flow decisions from the dashboard was working from silently incorrect mixed-currency figures. The council rated this a business-correctness failure, not a display issue, and required an interim warning before any second operator was onboarded. Fixed in v2.9.15 by adding `toGBP()` helper (converts via stored `QR` FX rates) and applying it to all dashboard KPI aggregations. KPI tiles are now labelled "≈ GBP" to indicate converted values. Residual risk: KPI accuracy depends on QR FX rates being current; stale rates produce approximations rather than hard errors, which is acceptable for operational dashboards.  
**Decision:** Resolved. Fixed before any second operator was onboarded, satisfying the council's pre-rollout condition.

---

## External Services — FPM Website (fpmsg.co.uk)

### CHAT-GAP-001 — AI chat conversation history includes prospect PII in Anthropic API calls

**Area:** fpmsg.co.uk — AI chat assistant (`index.html` chat IIFE) → Cloudflare Worker → Anthropic API  
**Logged:** v1.0 AI chat release (2026-06-19); SPEC-001 §9  
**Detail:** Once a prospect enters their name (turn N in `contact_capture` phase) and email (turn N+1), both values are present in `state.messages`. The full message history is sent to `/api/chat` on every subsequent turn, meaning name and email are transmitted to Anthropic's servers as part of the conversation context. SPEC-001 §9 documents this as architecturally incompatible with strict withholding: removing prior messages would break conversational coherence.

**Mitigation in place:**  
- Anthropic's standard Commercial Terms incorporate a Data Processing Addendum with Standard Contractual Clauses (Module 2) and UK GDPR Addendum — applicable automatically, no separate signing required.  
- Anthropic does not train on API inputs or outputs under Commercial Terms.  
- Default retention: inputs and outputs deleted within 30 days.  
- Privacy notice at fpmsg.co.uk/privacy.html discloses the Anthropic data flow and retention period (published 2026-06-19).  

**AC-DM-001.5 — Zero Data Retention (ZDR):** Assessed 2026-06-19. ZDR requires a minimum ~$100K/year annual commitment reviewed per-organisation — not appropriate at pilot scale. Standard DPA + SCCs + 30-day retention is the applicable safeguard. Gate closed; no further action required at current volume.  

**AC-DM-001.6 — Web3Forms DPA:** DPA request email sent to hello@web3forms.com on 2026-06-19. Status: **pending response**. Web3Forms stores form submissions for 30 days (free plan) / 1 year (pro plan). Full lead payload (name, email, transcript) is transmitted on confirm-click.  

**Risk level:** Low at pilot scale. Becomes a formal review point before onboarding first external client or ICO registration.  
**Decision:** Accepted. Standard Anthropic DPA is sufficient safeguard at current scale. Web3Forms DPA to be confirmed and recorded here when received.

---

## Contacts

### CON-GAP-001 — No automated purge of stale contacts
**Area:** Contacts / GDPR
**Detail:** Contacts not contacted in >700 days are flagged with a "Stale" badge in the UI. No automated deletion or purge mechanism exists — manual deletion only.

### CON-GAP-002 — Soft email dedup only
**Area:** Contacts / dedup
**Detail:** Email deduplication is soft: the user can force-create a separate record for a duplicate email. Edit-path email changes are not checked for duplicates. No hard uniqueness enforcement on the email field.

### CON-GAP-004 — Deleting a contact leaves dangling sourceContactId on quotes
**Area:** Contacts / data integrity
**Detail:** Deleting a contact does not remove or null the `sourceContactId` reference on associated quotes. Runtime guards in `saveQte()` and `delQte()` use `if (convC && ...)` / `if (relC && ...)` — these no-op safely if the contact is not found.

### CON-GAP-005 — Restoring v2 backup preserves live contacts
**Area:** Contacts / import
**Detail:** If a backup file does not contain a `con` key (e.g. a pre-v2.9.27 backup), `doImport()` preserves the current live DB.con rather than clearing it. The WARNING dialog text ("This will replace ALL current local data") is not updated to reflect this contact-specific exception.

---

## Event Log

### EVT-GAP-001 — No user-visible warning when 2,000-event cap is hit
**Area:** Event log / UX
**Logged:** v2.9.28
**Detail:** When `DB.events` reaches 2,000 entries and a new event is logged via `logEv()`, the oldest entries are silently dropped (FIFO trim). No toast, modal, or indicator is shown to the user. Oldest events are lost without warning. At ~200 bytes/event, the cap is reached after sustained high-frequency activity. Expected impact: low in pilot phase.

---

## AI Assistant

### AI-GAP-001 — No agentic order flow actions *(Narrow scope resolved v2.9.30)*
**Area:** AI Assistant — `sendAIMsg()`, `AI_SYSTEM_PROMPT`
**Logged:** v2.9.27 (audit 2026-06-21)
**Resolved (narrow scope):** v2.9.30
**Detail:** The AI assistant was a conversational Q&A tool only with no ability to pre-fill portal modals.
**Delivered in v2.9.30 (narrow scope — REQ-AI-GAP-001):** `parseAIAction()` detects and strips `@@ACTION...@@END` blocks from AI replies. `handleAIAction()` pre-fills PO, Quote, Shipment, and Contact modals from the AI-suggested payload. A "Review in [Form]" button appears below the reply. No record is created without explicit operator Save. `AI_SYSTEM_PROMPT` updated with action block instructions. 7 unit tests added (242/242 pass).
**Remaining open (broad scope — v3.0.x):** Agentic multi-step flow — AI reads context (quote, contact, rates), proposes a sequence of operations (create PO → notify forwarder → log shipment), operator approves each step. Requires significant architectural change beyond current single-file, no-server design. Intersects with SEC-GAP-003 (API key in browser) and would require server-side proxy.
**Decision (broad scope):** Deferred to v3.0.x. Requires requirements gate before any build work begins.
