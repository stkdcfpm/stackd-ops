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
**Detail:** `SPREADSHEET_ID`, `TOKEN`, `REQUIREMENTS_TRACKER_ID`, and `PROJECT_TRACKER_ID` are hardcoded in `Code.gs`, which is version-controlled. The sync token (`fpm-stackd-2026`) is a simple shared-secret guard, not a cryptographic credential. The spreadsheet IDs are Google Workspace GUIDs. Anyone with access to the private repo and the Apps Script deployment URL could call any sync action.  
**Risk level:** Medium for a private repo with controlled collaborator access. Would become HIGH if the repo is ever made public.  
**Mitigation path:** Move constants to Apps Script Script Properties (Project Settings → Script Properties). Remove hardcoded values from source.  
**Decision:** Accepted at current scale (private repo, single operator). Migrate to Script Properties before any public repo change or additional collaborators.

### SEC-GAP-002 — Sheets sync transmits PII externally without formal DPA
**Area:** `syncEnt`, `delEnt`, `syncAll`, `pushAll` — Cloudflare Worker → Google Apps Script  
**Logged:** v2.9.12 (security gate review)  
**Detail:** When Sheets sync is configured and enabled, supplier contact data (name, email, phone), buyer name/address, forwarder email, and invoice/payment records are transmitted to a Cloudflare Worker and on to Google Sheets. Under GDPR this requires a Data Processing Agreement with Google (covered by Google Workspace ToS for commercial accounts) and Cloudflare (covered by Cloudflare ToS). No in-product privacy notice is shown at data entry. The sync is opt-in — if `SS.url` is not configured, no data is transmitted.  
**Risk level:** Low while FPM operates as a sole-operator internal tool with no external client data in the system. Becomes a formal compliance obligation before onboarding first external client.  
**Decision:** Accepted. Document DPA status before ICO registration. Add brief disclosure note in Settings → Google Sheets card in a future version.

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
