# Known Gaps — Post-Pilot Review

Items deferred from initial build. Review after pilot period before wider rollout.

---

## Display Currency (v2.9.46)

### CUR-GAP-001 — Aging Report mixes currencies unconverted
**Area:** `renderAgingReport()` (`index.html` ~4799-4883)
**Logged:** v2.9.46 (REQ/SPEC-CUR-001)
**Detail:** Sums `c.bal` across invoices with no `toGBP`/`toDisp` conversion — a buyer with invoices in more than one currency gets a silently-mixed total. Pre-existing, not introduced by the currency toggle; out of scope for CUR-001. Adopting `QR.displayCurrency` here would require adding conversion logic, not just a toggle-swap.

### CUR-GAP-002 — Buyer Statement report mixes currencies unconverted
**Area:** `renderStatement()`/`openStatement()` (`index.html` ~5239 onward)
**Logged:** v2.9.46 (REQ/SPEC-CUR-001)
**Detail:** Picks `cur = invRecs[0].cur||'USD'` (first invoice's native currency) and sums unconverted — same latent multi-currency bug as CUR-GAP-001, pre-existing, out of scope for CUR-001.

## Sync / Data Integrity

### SYNC-GAP-001 — pullAll() merges Sheets rows keyed by display header, never translated back to internal field names — corrupts every pulled record and silently breaks delete *(Fixed v2.9.47)*
**Fix (v2.9.47, REQ/SPEC-SYNC-001):** `unmapRec()` (inverse of `mapRec()`) reverses the header→internal field translation on every pulled record. For the 5 entities with no `id` column in Sheets (`li`, `sh`, `inv`, `po`, `cn`, plus `qt`), `pullAll()` now matches by business key (SKU/ref/num) instead of a permanently-absent `id`, via `findLocalMatchByBizKey()`. `mergePulledWithLocal()` generically preserves any field not tracked in `FIELD_MAPS` (a shallow-copy-then-overlay merge, not a maintained allowlist) — closing data-loss risk for `inv.type`, `li.priceHistory`/`invoiceRefs`, `co.enquiries`, `sup.ct`, `payments.invId`, and any other untracked field. `claimOnceMatcher()` prevents two Sheets rows sharing an accidental duplicate business key from both claiming the same local record's `id`. Went through 5 spec-gate rounds and 2 schema-migration-reviewer rounds — each round caught a genuine defect (a live-Sheet-header leak risk in an early `unmapRec()` draft, a missing credit-notes rewrite, a hardcoded field allowlist that silently dropped `inv.type`, the same untracked-field drop for `sup`/`payments`/`co`, and the duplicate-business-key identity collision). 24 new tests, full suite 384/384 pass.
**Area:** `handlePullEntity()` (`apps-script/Code.gs:253-278`), consumed by `sGet()`/`pullAll()` (`index.html:3215-3226`, `3331-3416`) — the two-way "⟲ Sync" Pull path
**Logged:** 2026-07-12 (found while investigating user-reported blank Supplier/Line Item/Shipment/Invoice records consuming `num` sequence numbers; corrected after further investigation showed a plain blank-record validation gap did not explain why the app's own delete buttons also failed to remove these records)
**Root cause, confirmed in code:** `handlePullEntity()` reads each Sheet row and returns it keyed by the **literal spreadsheet column header** (e.g. `{'SKU':'ABC123','Description':'Widget','Supplier ID':'sup-001'}`) — the same shape `mapRec()` (`index.html:3250-3262`) produces when *pushing* data out. But nothing reverses that transform on the way back in: `pullAll()`'s Invoices block (`3336-3361`, `DB.inv = invPulled.concat(invLocalOnly)`) and its `simpleEnts` block for Suppliers/Line Items/Payments/Shipments/Quotes/Contacts (`3390-3403`, `DB[dbKey] = sd.records.concat(...)`) both merge `sd.records` straight into `DB` as-is. Every internal field the rest of the app reads (`.id`, `.name`, `.desc`, `.sku`, `.ref`) is `undefined` on these pulled objects — the real data exists, just under the wrong property name (`rec['Description']` instead of `rec.desc`). `backfillRefNums()` then runs immediately after (`3405`) and assigns a fresh `num` to each of these malformed records, since they have no recognisable `num` either — consuming a sequence number for what looks like, and functionally is, a blank record in every list view.
**Why the built-in delete buttons don't remove them, not even locally (this is what disproved the earlier, shallower diagnosis):** each row's delete button is wired via `onclick="delSup('` + `san(li.id)` + `')"` etc. Since `.id` is `undefined` on a pull-corrupted record, the rendered handler becomes e.g. `delLI('')`. Inside `delLI()`, `DB.li = DB.li.filter(function(l){ return l.id !== id; })` compares `l.id` (`undefined`) against `id` (`''`) — `undefined !== ''` evaluates `true`, so the record is *kept* by the filter for every one of these records. The confirmation dialog fires normally (it's just a message box, unaffected), giving the appearance that delete "ran," but the actual array filter never matches anything, so nothing is removed — not locally, and (separately, previously logged) not on the Sheet side either, since the delete-by-business-key request sent to Apps Script is built from the same missing `.id`/`.sku`/`.ref`.
**Contrast:** the one-way **"Import from Sheets"** button (`processImportRecords()`, `index.html:6522` onward) is unaffected — it explicitly reads by real header name (`r['Description']||''`, `r['SKU']||''`) and reverse-maps into the correct internal fields itself, and also skips blank name/desc/buyer rows. Only the two-way Pull (`pullAll()`/`handlePullEntity()`) is missing this translation step.
**Relationship to existing gaps:** supersedes this entry's original, shallower diagnosis (a suspected missing blank-record guard, analogous to `processImportRecords()`'s skip logic) — that framing didn't explain why the app's own delete buttons also failed silently, which only a field-name mismatch on `.id` explains. Still a sharper, more specific instance of the already-logged **SEC-GAP-011** ("`pullAll()` overwrites local records unconditionally — Sheets wins, no timestamp-based conflict resolution") — that gap is about conflict resolution; this one is about the pulled data being structurally malformed before it ever reaches the merge step.
**Fix, if/when built:** add a reverse-mapping step (inverse of `mapRec()`) in `pullAll()`/`sGet()` that translates each pulled record's header-keyed properties back into internal field names before merging into `DB`, for every entity routed through `handlePullEntity()`. Not yet built — deferred, doc-only per current scope.
**Interim workaround (no app code touched):** the in-app delete buttons cannot remove these records — don't rely on them for this specific case. Delete the malformed rows directly in the Google Sheet itself, and consider leaving "Pull from Sheets on load" unchecked (Settings) until the reverse-mapping fix ships, so the app stops re-ingesting malformed rows on every load. Once local records are genuinely clean (e.g. via a fresh Sheet-side cleanup), a Push (`syncAll()`) rewrites each Sheet tab from scratch (`Code.gs:118`, `130`) and is unaffected by this bug, since pushing uses `mapRec()` correctly in the forward direction.

## Dashboard

### DASH-GAP-001 — Dashboard charts are hand-rolled bar divs, no interactivity (hover/tooltip/drill-down)
**Area:** Dashboard — `renderDash()` chart rendering (`index.html` ~line 3207-3230)
**Logged:** v2.9.39 (review board product/architecture pass, 2026-07-04)
**Detail:** All four dashboard charts (Net Profit by Invoice, Revenue by Destination, Margin Distribution, PO Commitments) are `<div>` elements with inline `width:X%` styles built by string concatenation — no canvas, no SVG, no charting library, no hover states, no click-to-drill-down, no export. This is a deliberate consequence of the "no dependencies" architecture (see CLAUDE.md).
**Constraint:** The CSP (`index.html:7`, fixed under SEC-GAP-008) restricts `script-src` to `'self' 'unsafe-inline'` — any CDN-hosted charting library (Chart.js from a CDN, etc.) is silently blocked. To add real interactivity without a CSP change, a library must be **vendored** (downloaded once, committed as a same-origin static `.js` file, loaded via `<script src="charts/lib.js">`).
**Options evaluated:**
- **Chart.js** (MIT, ~200KB vendored) — best fit: canvas-based, easy to theme to brand tokens, most widely known so future sessions/AI assistance is well-supported
- **uPlot** (MIT, ~45KB vendored) — smallest footprint, best if dashboard grows into time-series (shipment timelines, monthly trends)
- **ApexCharts** (MIT, ~500KB vendored) — most built-in interactivity (zoom/tooltip/export) but heaviest
**Decision:** Backlogged, not started. Recommend Chart.js vendored as a static file if picked up — keeps CSP unchanged (same-origin), MIT-licensed (no attribution burden), and is the best-documented option for future AI-assisted maintenance. Any adoption should include: file committed under a `vendor/` or `charts/` folder, a note in CLAUDE.md's "no dependencies" line acknowledging the one exception, and a version pin (no auto-update — this repo has no build step to catch breaking changes).

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

## Invoices

### INV-GAP-001 — Pro-forma invoice preview rendered as a plain Invoice document *(Fixed v2.9.40)*
**Area:** `prevInvDoc()` — invoice preview/PDF generation (`index.html`)
**Logged & Fixed:** v2.9.40 (2026-07-06)
**Detail:** Pro-forma is a `status` value on a standard invoice record (`STATUS_ORDER`), not a distinct record `type` like credit notes (`type: 'credit_note'`). `prevInvDoc()` hardcoded the document title (`'Invoice ' + invNum`) and the on-page heading (`INVOICE`) regardless of `inv.status`, so selecting "Pro-forma" status and previewing the document still rendered a plain Invoice with no Pro-forma indication anywhere. This is the same class of defect previously fixed for Credit Notes (see v-history: "Credit note PDF now opens correct CREDIT NOTE document — was incorrectly rendering as Invoice") — that fix routed CN records to a dedicated `prevCNDoc()` function via the `type` field, but no equivalent status-check existed for Pro-forma since it has no separate `type`.
**Two-part fix (first pass incomplete — caught in manual testing before merge):**
1. `prevInvDoc()` now checks `inv.status === 'Pro-forma'` and renders `"PRO-FORMA INVOICE"` as both the document `<title>` and the on-page heading when true.
2. **Root cause of why the first pass alone didn't work:** the live-preview button inside the open invoice modal (`prevInv()`, wired to "Preview Invoice") rebuilds the preview object from form field values rather than the saved DB record — and it never included `status` in that object literal at all, even before this fix. So `inv.status` was always `undefined` on that path regardless of what the status dropdown showed, meaning the dropdown's selection was silently dropped before it ever reached `prevInvDoc()`. The CN preview path (same function, `prevInv()`) already correctly included `status:G('inv-sm').value` — the invoice path was simply missing the equivalent line. Added `status:G('inv-sm')?G('inv-sm').value:''` to the invoice object literal in `prevInv()`.  
Note: the saved-record preview path (`prevInvId()`, the table's PDF eye-icon button) was **not** affected — `saveInv()` already correctly persists `status` onto the DB record, so previewing an already-saved Pro-forma invoice via the table worked correctly even before this fix. Only the in-modal live preview (before/without saving) was broken.
**Regression tests added:** `tests/run.js` — (1) `prevInvDoc` unit test with `status` passed directly: Pro-forma renders `PRO-FORMA INVOICE`, non-Pro-forma does not; (2) `prevInv()` integration test exercising the actual modal form-field path that was broken, confirming the live preview button now also renders the heading correctly.
**Follow-up worth considering (not done):** Pro-forma invoices commonly carry different legal wording ("This is not a demand for payment") and sometimes different totals language ("Estimated Total" vs "Balance Due"). Not changed in this fix — scope was limited to the reported document-identity defect. Revisit if a customer-facing distinction beyond the heading is required.

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

## Purchase Orders

### PO-GAP-001 — `qteToPoConvert()` attributes every Quote line to the first line's supplier, mis-assigning multi-supplier Quotes *(Fixed v2.9.44)*
**Area:** `qteToPoConvert()` — Quote → PO conversion (`index.html`)
**Logged:** v2.9.43 (2026-07-11), found while reviewing a real multi-category procurement basket (seeds, salt fish, mulching film, irrigation, sunflower oil, plastic bags, fertiliser, fresh produce, equipment — sourced from at least three distinct countries/suppliers in one basket) against the Order Management release
**Detail:** `qteToPoConvert()` creates exactly **one** PO from an entire Quote's `lines[]`, and assigns that PO's `supId` from whichever line happens to be first in the array with a non-empty `supId`:

```js
var firstSup = (q.lines||[]).find(function(l){ return l.supId; });
var po = {
  id: uid(), num: poNum, supId: firstSup ? firstSup.supId : '',
  ...
  lines: (q.lines||[]).map(function(l){
    return { rid:uid(), liId:'', desc:l.desc, qty:l.qty||1, up:l.cost, uom:l.uom||'pcs', cur:q.currency||'USD' };
  }),
  quoteId: id, quoteNum: q.num
};
```

Every line in `lines[]` is copied onto this single PO regardless of its own `supId` — the per-line `supId` is read once (to pick the PO's overall supplier) and then **discarded**; nothing in the mapped `lines` array retains or re-checks it. For a single-supplier Quote this is invisible and correct by coincidence. For a Quote whose lines span multiple suppliers — the normal case for a mixed-category procurement basket, not an edge case — every line **except those genuinely belonging to the first line's supplier** is silently attributed to the wrong supplier's PO. There is no error, no warning, and no split into separate POs per supplier.

**Consequence:** the resulting PO understates or misstates what is actually owed to each real supplier, and (depending on downstream PO→Invoice/shipment linkage) risks an Invoice or shipment being raised against the wrong supplier relationship entirely. This directly affects the Order Management release, since a "one order request, many product categories, many countries of origin" basket is the intended real-world shape of an Order Request (per REQ-ORD-001/SPEC-ORD-001), not an unusual input.

**Root cause:** `qteToPoConvert()` was written assuming (or only ever tested against) single-supplier Quotes. The data model already supports per-line suppliers (`q.lines[].supId`, used correctly everywhere else — quote calculation, feasibility checks) — the gap is isolated to this one conversion function not grouping by that field.

**Fixed in v2.9.44** via REQ-PO-001/SPEC-PO-001 (full requirements-gate → spec-gate → schema-migration-reviewer → build-gate cycle, not a quiet patch, since the fix changed `Quote.linkedPOId` from a scalar to `linkedPOIds`, a one-to-many relationship). `qteToPoConvert()` now groups lines by `supId` and creates one PO per distinct supplier (including a separate PO for lines with no supplier assigned), with a collision-safe numbering scheme (`-1`/`-2` suffix, falling back to a letter suffix if that number is already taken) and a one-time idempotent migration (`migrateLinkedPOIds()`) for existing Quotes. See PO-GAP-002 below for the one residual risk this fix does not retroactively resolve.

### PO-GAP-002 — Historical POs created before v2.9.44 may carry incorrect supplier attribution *(Open, accepted)*
**Area:** `DB.po` records created by the pre-fix `qteToPoConvert()` (any PO created before v2.9.44)
**Logged:** v2.9.44 (2026-07-11), per REQ-PO-001-v3 §7's required disclosure alongside the PO-GAP-001 fix
**Detail:** PO-GAP-001's fix (above) only changes `qteToPoConvert()`'s behavior going forward. Any PO created before v2.9.44, from a Quote whose lines spanned more than one supplier, may have had non-first-supplier lines silently misattributed to the wrong supplier's PO — this is not retroactively corrected, and there is no automated way to identify which historical POs are affected (the original per-line `supId` was never recorded on the generated PO's line items, only the description/qty/cost).
**Decision:** Accepted as a residual, historical risk — out of scope for REQ-PO-001, which fixed the conversion logic going forward only. If a specific supplier dispute or reconciliation issue arises referencing a pre-v2.9.44 PO, manually cross-reference the original Quote's line-level `supId` values (still intact on the Quote record) against the PO's supplier assignment.

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

### SEC-GAP-020 — Repository is publicly served via GitHub Pages; live PII was committed and exposed *(Fully resolved 2026-07-05)*
**Area:** GitHub Pages deployment — entire repository contents  
**Logged:** v2.9.39 (review board security audit, 2026-07-04)  
**Detail:** GitHub Pages serves the **entire repository** at `app.getstackdops.com`, not just `index.html`. Until v2.9.39, this publicly exposed: (1) `Test-data/Stackd-Clean-2026-05-17.json` — a live business dataset containing real supplier contact names, personal emails, mobile numbers, buyer names/addresses, and invoice financials; (2) the supplier contacts table in `STACKD_CONTEXT.md` with personal emails and a phone number; (3) `docs/known-gaps.md` (this file — the security weakness register) and all other docs at guessable URLs.  
**Remediation shipped (v2.9.39):** `Test-data/` deleted; STACKD_CONTEXT.md contacts table redacted to company-level only; real buyer name anonymised in the `index.html` import template example; `.gitignore` added blocking `Test-data/`, `Stackd-Backup-*.json`, `Stackd-Clean-*.json`.  
**History purge completed (2026-07-04):** full `git filter-repo` rewrite of all branches — `Test-data/` removed from every commit; all supplier emails, phone numbers, contact names, and the real buyer identity scrubbed from every historical blob (verified zero matches across all refs). Force-pushed to `main` and all 14 feature branches.
**GDPR assessment completed (2026-07-04):** breach documented per Art. 33(5); assessed NOT reportable to ICO (low risk — small number of B2B contacts, professional contact data only, no evidence of access, same-day remediation). Private breach record held by operator outside the repo.
**GitHub Support cache purge completed (2026-07-05):** GitHub identified the sensitive commit referenced in 33 pull requests (#21–#54, every PR merged after the original exposure on 17 May 2026, since each carried the commit in its base history). At operator's request, GitHub deleted all 33 PRs entirely (not just tracking references) to guarantee full removal, since a references-only deletion would not have covered data quoted in PR bodies/comments. GitHub confirmed cache cleared 2026-07-05 22:18 UTC.  
**Outstanding (informational only, no further action required):**
1. **Stale clones** — any clone of this repo made before 2026-07-04 still contains the old history; delete and re-clone if any exist.
2. **Deployment hardening** — docs and context files remain publicly served by design (current policy — see "Public repo policy" in CLAUDE.md); acceptable now that no PII remains in any committed file.  
**Risk level:** LOW — resolved. GitHub's standard caveat applies: any data that was ever exposed should be considered potentially compromised regardless of subsequent removal (this was assessed under the GDPR review above and found not reportable).  
**Process going forward (mandatory):** Treat every file in this repo as **publicly readable**. Never commit live data exports, backups, personal contact details, credentials, or client-identifiable records. Live data lives in the portal's localStorage and in private backups stored outside the repo.

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

### DATA-GAP-003 — Friendly reference numbers (`num`) can diverge across devices/browsers — open, unmitigated
**Area:** `nextRefNum()` / `backfillRefNums()` — Supplier/Line Item/Buyer/Contact `num` assignment (SPEC-DATA-001)  
**Logged:** v2.9.43 (REQ-DATA-001 / SPEC-DATA-001-v6)  
**Detail:** `num` is assigned locally from each device's own view of `DB`, with no central authority (Stackd Ops is localStorage-only, per FM-1). Two devices that have not synced with each other can independently assign the same `num` (e.g. `SUP-0012`) to two different real records. The same-device risk — `pullAll()` silently stripping a record's `num` on every sync pull because `num` is deliberately excluded from `FIELD_MAPS` — **is mitigated** as of this version: `backfillRefNums()` now runs immediately after every `pullAll()` completes and re-assigns any record that lost its `num`, before `saveAll()`/`renderAll()`. The cross-device divergence risk remains **open and unmitigated** — there is no reconciliation event when two independently-`num`-ed devices later sync. This is accepted as a permanent design trade-off of the localStorage-only architecture (not "for v1"), and is not considered mitigated by REQ-RPT-002's reporting pipeline — that pipeline can surface a duplicate `num` in an exported report for manual review, but does nothing to prevent or auto-resolve the divergence at assignment time.  
**Related, deferred separately:** `initApp()`'s existing data-integrity check (index.html, "Data integrity check" IIFE) was not extended to actively scan for and warn on duplicate `num` values across `DB.sup`/`DB.li`/`DB.buy`/`DB.con` at load time — this was flagged as a recommended (non-blocking) enhancement by schema-migration-reviewer and is deferred, not implemented, in this version.

### DATA-GAP-004 — Shared string-concatenation `onclick` pattern silently no-ops delete/edit if a record is missing `id`
**Area:** `rSup()` (`index.html:4202`), `rLI()` (`index.html:4341`), `rPO()` (`index.html:5752`, `5754`) — and `rCon()`, fixed for Contacts via `REQ/SPEC-CON-003`  
**Logged:** discovered while diagnosing a live user-reported Contacts bug (a malformed `DB.con` record with no `id` could not be deleted or edited through the UI)  
**Detail:** List-render functions generate row action buttons via string concatenation, e.g. `onclick="delCon('" + c.id + "')"`. If a record's `id` field is JS `undefined` (a malformed/legacy record), string concatenation coerces it to the literal text `undefined`, so the generated handler calls e.g. `delCon('undefined')` — a **string**, not the real value. The corresponding delete/edit function then compares the record's real `undefined` id against the string `'undefined'`, which never matches — the action silently no-ops with no error surfaced to the operator. `rSup()`, `rLI()`, and `rPO()` use the identical pattern and would exhibit the same failure mode if any `DB.sup`/`DB.li`/`DB.po` record were ever missing its `id`.  
**Decision:** Backlogged for `sup`/`li`/`po` — no such malformed record has been reported for those entities, so no preemptive backfill was applied (fixing confirmed defects, not guessing at unconfirmed ones). If a similar report surfaces for any of these entities, apply the same fix already shipped for Contacts (`REQ/SPEC-CON-003`): a backfill function assigning a fresh `id` via `uid()` to any record missing one, run at the same points `backfillRefNums()` already runs (`initApp()`, post-restore, post-`pullAll()`).

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

## Order Requests

### ORD-GAP-001 — Legacy-backfilled Order Requests are lower-fidelity; abandoned-Quote PO/Invoice not re-attributed *(Open, accepted)*
**Area:** `backfillOrderRequests()`, `activeQuoteId` reassignment (`index.html`)
**Logged:** v2.9.44 (2026-07-11), per SPEC-ORD-001-v3 §9
**Detail:** Two accepted, documented limitations of the Order Requests feature:
1. **Legacy-backfilled records are lower-fidelity.** Contacts with an enquiry history but no linked Quote are backfilled into one Order Request per Contact (not one per enquiry, since individual enquiries can't be reliably separated into distinct requests), marked `_backfilled: 'legacy-unstructured'`. These records have no original per-enquiry outcome/reason captured — a placeholder reason string is used where an outcome is inferred.
2. **Abandoned Quotes aren't re-attributed.** If an operator creates a new Quote for an Order Request after abandoning a previous one (via "Create Quote" a second time), `activeQuoteId` reassigns to the new Quote. The abandoned Quote's own PO/Invoice (if it has one) is not automatically re-attributed or hidden — it remains independently visible in the Quotes/POs/Invoices tabs, it simply stops counting toward this Order Request's realised margin.
**Decision:** Both accepted as documented limitations, not defects to fix. Neither is expected to cause data loss or incorrect financial calculation — only a lower level of historical detail (limitation 1) or a manual-tracing requirement if an abandoned Quote's PO/Invoice needs separate attention (limitation 2).

### ORD-GAP-002 — `update_order_line` AI action has no corresponding read tool *(Open, accepted)*
**Area:** `AI_TOOLS`, `handleAIAction()`'s `update_order_line` branch (`index.html`)
**Logged:** v2.9.45, per SPEC-ORD-002-v5 §8
**Detail:** The AI assistant can propose a line-item field update (`update_order_line`) but has no `get_order_lines`-style read tool to query an Order Request's current line state before proposing — the same read/write asymmetry already logged for other entities under AI-GAP-008's precedent (e.g. `create_po` needing a supplier name resolved with no `get_suppliers` tool). Without a read path, the AI can only act on line state the user has described to it in-conversation, not verify it against what's actually stored.
**Decision:** Accepted, explicitly out of scope per REQ-ORD-002-v2 §3. Natural follow-up once real usage shows how often this gap is actually hit in practice — same recommended fix shape as AI-GAP-008 (add a scoped read tool).

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

### CON-GAP-006 — CSV/webform-created Contacts never get a CON-#### reference number
**Area:** Contacts / reference numbers
**Logged:** v2.9.48 (found by schema-migration-reviewer while reviewing SPEC-ORD-003's new Order Request CSV import path)
**Detail:** The inline Contact-creation object in `processImport()`'s new `ord` branch omits `num` (no `nextRefNum(DB.con,'CON')` call) — this exactly mirrors a pre-existing gap already present in `processImportRecords()`'s `co` branch (`index.html:6731-6761`, also omits `num`). Not a new gap, but now propagated to a second creation path. Not a crash risk — the only render site (`con-title`) guards with `c.num ? ... : ''`. Not fixed in v2.9.48 to keep that change's scope to the CSV-import wiring itself; logged here so it isn't silently re-inherited a third time by a future import path without being noticed.

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

### AI-GAP-006 — Three of nine creatable entities still not supported by `handleAIAction()` pre-fill *(Partially resolved v2.9.41 — Suppliers and Buyers shipped)*
**Area:** AI Assistant — `handleAIAction()`, `AI_TOOLS`, `AI_SYSTEM_PROMPT`
**Logged:** v2.9.40 (2026-07-08); scope expanded same day to cover all tabs, not invoices alone; Suppliers + Buyers delivered v2.9.41 (2026-07-08)
**Detail:** `handleAIAction()` originally supported four action types — `create_po`, `create_quote`, `create_shipment`, `create_contact`. A full audit of every `open*()` modal-creation function in `index.html` found five more creatable entities with no AI action equivalent: Invoices, Suppliers, Line Items (product catalogue), Buyers, and Credit Notes. Payments are excluded from scope — always created in the context of an existing invoice, no standalone tab-level action to add.

**Delivered in v2.9.41:**
- `create_supplier` → `{ name, country, currency, contactPerson, email, phone, notes }` — pre-fills `openSup()`. Simplest of the five: only `name` is required, no dropdown dependencies, no blocking prompts.
- `create_buyer` → `{ name, contactName, email, phone, address, currency, paymentTerms, creditLimit, notes }` — pre-fills `openBuy(null)`. Name required, case-insensitive duplicate hard-blocked at save time (unchanged — pre-fill does not bypass `saveBuy()` validation).
- Both follow the existing pattern exactly: AI proposes → "Review in [Form] form" button → operator reviews and clicks Save → nothing auto-commits.
- `AI_SYSTEM_PROMPT` action block instructions updated; `actionLabels` map in the review-button renderer updated.
- 2 new regression tests (`handleAIAction: create_supplier ...`, `handleAIAction: create_buyer ...`); a test-harness gap was also fixed (`mockEl` lacked `appendChild()`, needed by `openSup()`'s `populateDialCodes()` — no test had exercised that code path before). 303/303 tests pass.

**Remaining open (three entities, unchanged from original analysis):**
1. **Invoices** (`openInv()`, `vInv()` at `index.html:5553`) — Buyer is a closed-set dropdown (`#if-b`, populated from `DB.buy`), not free text; the AI must resolve a buyer name to an existing `buyId`. The dropdown's `__new__` option triggers `quickAddBuyer()`, a blocking `window.prompt()` — incompatible with a programmatic pre-fill flow. Invoice number is already auto-generated by `nextInvNum()` on modal open — the AI action must not set `#if-n` itself. Incoterm and Payment Terms are hard-required with no AI-friendly default. At least one line item is required. The modal also handles Credit Notes via the same `isCN(num)` branch — a `create_invoice` action must not collide with that validation path.
2. **Line Items / product catalogue** (`openLI()`, `vLI()` at `index.html:5533`) — Description is required; Supplier is also a required dropdown (`#lf-sup`), same closed-set problem as Invoice's Buyer field, and Line Items has no `quickAddSupplier()`-equivalent shortcut at all — a missing supplier blocks creation with no inline remedy today, AI-driven or otherwise. **Now that `create_supplier` exists (this version), the AI could in principle create the missing supplier first in a follow-up turn, then the line item** — worth considering as the unblocking path rather than building a new quick-add UI.
3. **Credit Notes** (`openNewCN()`, `vInv()` isCN branch) — Requires either a positive credit amount + linked invoice number (standard CN) or the goodwill checkbox. Shares the invoice modal but is a distinct validation path — needs its own `create_credit_note` action type, not reuse of `create_invoice`.

**Decision:** Suppliers and Buyers shipped. Suggested next: Invoices (highest value, but the buyer-dropdown blocker still applies — same conclusion as before, now partially mitigated by `create_buyer` existing as a prerequisite step the AI could chain), then Line Items (same mitigation via `create_supplier`), then Credit Notes last.

### AI-GAP-007 — Action block emission is non-deterministic; model sometimes describes manual steps instead of emitting `@@ACTION` *(Mitigation confirmed effective on retest — v2.9.42)*
**Area:** AI Assistant — `sendAIMsg()`, `AI_SYSTEM_PROMPT`, all six `handleAIAction()` action types
**Logged:** v2.9.41 (2026-07-08), live user acceptance testing session
**Detail:** In a single live test pass covering all six supported actions with clear, unambiguous, fully-detailed requests, **3 of 6 attempts failed** — the AI described manual UI steps ("go to the X tab, click + New X, fill in these fields...") instead of emitting the structured `@@ACTION` block, even though the system prompt explicitly instructs: "When the user clearly requests creation of a [type] and sufficient detail is present, embed an action block." Failures were not confined to the two newly-shipped actions (Supplier) — they also hit **Contact and Shipment**, both unchanged since v2.9.30. Successes (Buyer, Quote) used the exact same prompt phrasing and level of detail as the failures. This rules out a code/dispatch defect — `handleAIAction()`, the action-label map, and the modal pre-fill logic are all confirmed correct via the passing tests. The failure is in the model's inconsistent adherence to the instruction, not in the surrounding application code.
**Test evidence (2026-07-08, one message per action, same session structure):**
| Action | Request detail level | Result |
|---|---|---|
| Buyer | Full detail | ✅ Action block emitted, modal pre-filled correctly |
| Supplier | Full detail | ❌ AI said "the tools available to me can only query existing data" — described manual steps |
| Purchase Order | Missing supplier (test-case error, not a system fault) | Correctly asked a clarifying question — expected behavior, not a failure |
| Quote | Full detail | ✅ Action block emitted, modal pre-filled correctly, including default markup |
| Shipment | Full detail | ❌ AI said "I don't have a direct tool to create shipments programmatically" — described manual steps |
| Contact | Full detail | ❌ AI described manual steps despite confirming a correct GDPR-basis summary in the same reply |
**Root cause hypothesis:** No `temperature` parameter was set on the Anthropic API call (`sendAIMsg()`), meaning every request ran at the model's default sampling temperature — a setting prone to inconsistent adherence to "always do X when condition Y holds" instructions across repeated similar prompts. The AI's own wording in failures ("the tools available to me...") suggests it may be conflating the read-only `AI_TOOLS` array (`get_invoices`, `get_payments`, `get_kpis`, `get_pos` — real Anthropic tool-use) with the separate `@@ACTION` text-block mechanism used for writes — two different systems the model doesn't reliably distinguish.
**Mitigation shipped (v2.9.41):** `temperature: 0.2` added to the Anthropic API call in `sendAIMsg()` (previously unset/default). Lower temperature makes an LLM substantially more likely to reliably follow a deterministic "always do X" instruction, at a small cost to conversational variety/warmth in phrasing. This is a mitigation, not a guaranteed fix — LLM instruction-following is inherently probabilistic and can never be made 100% reliable through prompting/sampling parameters alone.
**Not done (further mitigation options, if 0.2 proves insufficient):**
- Add a few-shot example pair directly in the system prompt showing a correct action-block emission for a clearly-detailed request, to reduce ambiguity between "action block" and "AI_TOOLS" framing
- Rename/re-frame the `AI_TOOLS` array in the prompt more distinctly from action blocks (e.g. explicitly label one "read tools" and the other "write actions") to reduce the conflation seen in the Supplier/Shipment failure wording
- Consider a lightweight client-side keyword/intent pre-check that nudges a retry if a clearly create-intent message produces no action block
**Retest evidence (2026-07-08, v2.9.42 build, same three previously-failing actions re-tested):**
| Action | v2.9.41 (temperature unset) | v2.9.42 (temperature 0.2) |
|---|---|---|
| Supplier | ❌ Failed | ✅ Action block emitted, "Review in Supplier form" appeared |
| Shipment | ❌ Failed | ✅ Action block emitted, "Review in Shipment form" appeared |
| Contact | ❌ Failed | ✅ Action block emitted, "Review in Contact form" appeared |
3 for 3 on retest — all previously-failing actions succeeded after the temperature change. Small sample (one retry each), so this is encouraging rather than conclusive, but directionally strong.
**Decision:** Temperature mitigation appears effective based on retest. Continue monitoring in normal use; revisit the further mitigation options listed above only if failures resurface at a noticeable rate. Not closing this gap outright — LLM instruction-following remains inherently probabilistic and a future model swap or prompt change could reintroduce the issue.

### AI-GAP-008 — `create_po` requires an internal `supId`; AI cannot resolve a newly-created (unsaved) supplier by name, producing a dead-end conversational loop *(Open)*
**Area:** AI Assistant — `create_po` action payload contract, `AI_TOOLS`, `handleAIAction()`
**Logged:** v2.9.42 (2026-07-08), live UAT session
**Detail:** During testing, a user tried the natural two-step flow "create a supplier, then create a PO for that supplier" in one conversation. The `create_po` payload requires `supId` — an internal `DB.sup` record ID — not a supplier name. This produced a genuine dead end:
1. User requests a PO with no supplier → AI correctly asks for one.
2. User asks to create the supplier → AI correctly emits `create_supplier`, pre-fills the modal. **The record is not yet saved** — pre-fill never auto-saves, by design (AI-GAP-001).
3. User returns to the PO request, names the supplier → AI (correctly, given its instructions) asks for the **Supplier ID**.
4. The ID does not exist yet, because step 2 only pre-filled a form the user has not clicked Save on. The AI has no way to know this — it cannot observe portal state, and nothing in the conversation signals whether the earlier action was actually saved.
5. AI repeatedly asks the user to go find and copy an internal ID string out of the Suppliers tab — a UX dead end no non-technical operator would know how to resolve, and one that can never succeed until the user manually saves the supplier and manually surfaces its ID back to the AI (which currently has no `get_suppliers` tool to look it up even if asked to retry).
**Root cause:** Two compounding problems, not one:
1. `create_po`'s payload contract exposes an internal database key (`supId`) as the field the AI must supply, instead of a human-usable identifier (name) that could be resolved server-side against `DB.sup` with fuzzy matching — the same kind of resolution already needed for Invoice's Buyer field (see AI-GAP-006 point 1) and Line Item's Supplier field (AI-GAP-006 point 2). This is the same underlying "closed-set dependency, no name-based resolution" problem identified there, now confirmed in a live test rather than only predicted from code review.
2. There is no `get_suppliers` read tool in `AI_TOOLS` (only `get_invoices`, `get_payments`, `get_kpis`, `get_pos` exist) — so even if the AI wanted to look up whether "Shandong Jinbao New Materials" now exists in `DB.sup` after the user saved it, it has no mechanism to check. It can only ask the user to manually find and paste the ID.
**Decision:** Backlogged. This is the same "closed-set dependency, no resolution path" problem flagged in AI-GAP-006 for Invoices and Line Items, now confirmed as a live, reproducible dead end for Purchase Orders too — despite `create_po` being one of the four original, previously-considered-solid actions. Recommended fix, in order of value: (1) add a `get_suppliers` (and likely `get_buyers`) read tool to `AI_TOOLS` so the AI can resolve a name to an ID itself mid-conversation; (2) change `create_po`'s payload to accept a supplier **name** and resolve it to `supId` inside `handleAIAction()` (case-insensitive match against `DB.sup`, same pattern as `isCN()`-style helpers elsewhere in the codebase), falling back to a clear "no matching supplier — would you like me to create one?" prompt if not found. Option (2) alone would have avoided this entire dead end. This affects `create_po` today and will affect any future `create_invoice`/`create_line_item` actions (AI-GAP-006) unless solved once, centrally.

### AI-GAP-009 — `AI_SYSTEM_PROMPT`'s documented PO status vocabulary does not match the live `<select id="po-sm">` dropdown *(Open)*
**Area:** `AI_SYSTEM_PROMPT` (`index.html:6553`) vs. the actual Purchase Order status field (`index.html:1796`)
**Logged:** v2.9.43 (2026-07-11), discovered while building `docs/workflow-bpmn.md` — a full BPMN-style Mermaid workflow diagram covering every entity's real lifecycle, cross-checked against live code rather than existing documentation
**Detail:** `AI_SYSTEM_PROMPT` tells the AI assistant: *"PO status: Draft → Sent → Confirmed → In Production → Shipped → Completed."* The real, live `<select id="po-sm">` dropdown (the only place PO status is actually set) offers exactly five options: **Draft, Sent, Deposit Paid, Settled, Cancelled** — three of the prompt's six stated values (`Confirmed`, `In Production`, `Shipped`, `Completed` — four, not three; none of these four exist in the dropdown) do not exist anywhere in the app, and two real statuses the dropdown does have (`Deposit Paid`, `Cancelled`) are entirely absent from the prompt's description.
**Consequence:** if an operator asks the AI assistant something like "what does PO status X mean" or "what statuses can a PO have," the AI's answer — driven entirely by this hardcoded prompt text, not by any live schema introspection — would be confidently wrong. This is the same class of risk `CLAUDE.md`'s "On version delivery" checklist is designed to catch ("mandatory on every version, no exceptions... Ask: 'If the user asked the AI about this feature, would the answer be accurate?'"), but this specific line was never updated after PO status was authored or last changed, and no gate previously cross-checked the prompt text against the live `<select>` options.
**Root cause:** `AI_SYSTEM_PROMPT` is free-text, hand-maintained prose describing app behavior — there is no automated or gate-level check that any given status-vocabulary claim in the prompt still matches its corresponding live `<select>`/enum in `index.html`. This is a general risk (any entity's status prompt text could drift the same way over time, not just PO), of which this is the first concretely confirmed instance.
**Decision:** Backlogged. Recommended fix: correct the `AI_SYSTEM_PROMPT` line to read "PO status: Draft → Sent → Deposit Paid → Settled. Cancelled from any non-terminal status." As a broader mitigation, consider adding a lightweight test-suite check (or a build-gate checklist item) that spot-checks each entity's status-vocabulary claim in `AI_SYSTEM_PROMPT` against its actual `<select>` options at least once per version that touches that entity's status field, rather than relying solely on manual review discipline.
