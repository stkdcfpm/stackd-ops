# Known Gaps — Post-Pilot Review

Items deferred from initial build. Review after pilot period before wider rollout.

---

## Quote Engine

### QTE-GAP-001 — No quote status workflow enforcement
**Area:** Quotes → status field / Convert to PO button  
**Logged:** v2.9.4  
**Detail:** The quote status field (`Draft → Sent → Accepted → Declined / Expired`) is a free select with no transition guards. The Convert to PO button is available on any status (only blocked if a PO is already linked). No validation prevents advancing to a later status without prerequisite data being present (e.g. no check that all lines have CBM before a freight-stage status could be set).  
**Options for post-pilot:**
- Restrict Convert to PO to `Accepted` status only
- Add a `Freight Confirmed` status that requires CBM > 0 on all lines before it can be set
- Add a `Locked` read-only state that prevents further edits once a PO is raised
- Full FSM (finite state machine) with allowed transition map  
**Decision:** No enforcement needed at pilot stage. Revisit after real-world quote flow is understood.

---

## Security — Accepted Architecture Risks

### SEC-GAP-001 — Apps Script sync token and spreadsheet IDs in source control
**Area:** `apps-script/Code.gs`  
**Logged:** v2.9.12 (security gate review)  
**Code fix:** v2.9.15 — hardcoded values removed from `Code.gs` and `STACKD_CONTEXT.md`. Source now reads all four values from `PropertiesService.getScriptProperties()`. **Manual step pending:** set the four Script Properties in the Apps Script editor and redeploy. Token must be rotated to a new value before setting.  
**Detail:** `SPREADSHEET_ID`, `TOKEN`, `REQUIREMENTS_TRACKER_ID`, and `PROJECT_TRACKER_ID` were hardcoded in `Code.gs`, which is version-controlled. The sync token is a simple shared-secret guard. The spreadsheet IDs are Google Workspace GUIDs. Anyone with access to the private repo and the Apps Script deployment URL could call any sync action.  
**Risk level:** Medium for a private repo with controlled collaborator access. Would become HIGH if the repo is ever made public.  
**Decision:** Code change shipped. Awaiting manual deployment step (see walkthrough in session notes).

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

### SEC-GAP-007 — `testConn()` sync token exposed in URL query string *(FIXED v2.9.14)*
**Area:** Settings → Google Sheets card → Test Connection  
**Logged:** v2.9.14 (audit); **Fixed:** v2.9.14  
**Detail:** Prior to v2.9.14, `testConn()` appended `_token` as a URL query parameter (`?action=ping&_token=...`). Query string parameters appear in server access logs, browser history, and referrer headers. Fixed by moving to POST body: `fetch(url, { method:'POST', body: JSON.stringify({action:'ping', _token:tok}) })`.

### SEC-GAP-008 — No Content Security Policy header *(FIXED v2.9.16)*
**Area:** GitHub Pages deployment; `index.html`  
**Logged:** v2.9.14 (audit); **Fixed:** v2.9.16  
**Detail:** Prior to v2.9.16, the app shipped no `Content-Security-Policy` header or meta tag. Fixed by adding `<meta http-equiv="Content-Security-Policy">` to `<head>` with policy: `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src https:; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'`. `'unsafe-inline'` for scripts/styles is required by the single-file architecture but `connect-src https:`, `object-src 'none'`, and `base-uri 'self'` provide meaningful defence-in-depth.

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

## SDLC & Process

### SDLC-GAP-001 — Version identity inconsistency across the codebase
**Area:** `<title>`, nav version badge, in-app changelog, `AI_SYSTEM_PROMPT`, `CLAUDE.md`, `STACKD_CONTEXT.md`  
**Logged:** v2.9.14 (audit)  
**Detail:** At the time of the v2.9.14 audit, `<title>` and the nav badge displayed v2.9.10; `AI_SYSTEM_PROMPT` declared v2.9.13; `CLAUDE.md` declared v2.9.13; `STACKD_CONTEXT.md` referenced v2.9.12 as current. The in-app changelog was frozen at v2.9.10. Version identity was fractured across at least 5 locations. Fixed in v2.9.14. The "On version delivery" checklist in `CLAUDE.md` must be followed on every release to prevent recurrence.  
**Decision:** Resolved. Checklist-enforced going forward.

---

## Data Safety

### BACKUP-GAP-001 — No backup/recovery mechanism audited or enforced
**Area:** All data — `localStorage` is the sole persistence layer  
**Logged:** v2.9.15 (LLM Council audit verdict 2026-06-04)  
**Detail:** The app holds live invoices, POs, shipments, payments, quotes, and supplier records with no server-side persistence, no transaction log, and no automatic backup. `localStorage` is wiped by: browser "Clear site data", private/incognito browsing, device failure, browser profile corruption, or OS reinstall. The JSON export (Settings → Data → Export All) is the only recovery path, but it is undocumented, untested as a restore procedure, and not prompted to the user. One corrupted browser profile = total data loss with no recovery option. **The council rated this the highest-probability failure mode — above any security gap.**  
**Mitigation shipped (v2.9.15):** `checkStorageQuota()` warns at 75% and 90% storage usage, prompting an export. Does not solve the underlying gap.  
**Options for post-pilot:**
- Auto-export JSON to a user-nominated local folder on every save (File System Access API)
- Add a periodic export reminder (e.g. weekly toast with one-click export)
- Document and test the full export→import round-trip as the official DR procedure  
**Decision:** Partially mitigated (quota warning). Full DR procedure must be documented and tested before first external client.

### BACKUP-GAP-002 — localStorage quota cliff with no guard *(partially fixed v2.9.15)*
**Area:** All `localStorage` writes — `sv()`, `saveAll()`, `stackd_co_*` keys  
**Logged:** v2.9.15 (LLM Council audit verdict 2026-06-04)  
**Detail:** Browser `localStorage` has a hard limit of approximately 5–10 MB (varies by browser). When the limit is reached, `localStorage.setItem()` throws a `QuotaExceededError` silently — no data is written, no user feedback is shown, and the app continues as if the save succeeded. The `ldArr` safety wrapper catches read errors but not write errors. Large datasets (many invoices with line items), large base64 logo uploads, or extensive sync history could approach the limit undetected.  
**Mitigation shipped (v2.9.15):** `checkStorageQuota()` runs on app init and warns via toast at 75% (≈3.75 MB) and 90% (≈4.5 MB) of a conservative 5 MB baseline. Write-side error catching remains unimplemented.  
**Options for post-pilot:**
- Wrap `sv()` in try/catch for `QuotaExceededError` and surface a blocking modal before data is lost
- Add quota check before logo upload (base64 blobs are the highest risk item)
- Implement `navigator.storage.estimate()` where available for more accurate quota detection  
**Decision:** Partially mitigated. Write-side guard and logo-size check needed before wider rollout.

### SDLC-GAP-002 — Gate evidence trail exists only in chat, not in persistent artefacts
**Area:** Agent pipeline — `requirements-gate`, `spec-gate`, `build-gate`, `security-gate`  
**Logged:** v2.9.14 (BABOK / agent architecture audit)  
**Detail:** Gate agents produce structured reports in the Claude chat session. These reports are not persisted to Git, Notion, or any durable store. A gate PASS in session has no artefact that proves it ran. This means the audit trail only exists in Claude session history (ephemeral) and is not verifiable by a third party or auditor. The agent architecture doc notes "Every gate produces a logged evidence record" but this is aspirational — the Notion MCP integration is not yet wired.  
**Options for post-pilot:**
- Write gate output to a `docs/gate-evidence/` directory in Git as markdown files
- Wire Notion MCP to post gate results to the Requirements Tracker
- Add a mandatory "evidence tag" to every PR that references a gate run  
**Decision:** Deferred. Implement before ICO registration or first external client onboarding.
