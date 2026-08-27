# STACKD — Project Context

> **Single source of truth for all Claude tools — Projects, Code, and new conversations.**
> Fetch this file at the start of any new session: `https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`
> Updated by Claude Code on every version delivery. Updated by Claude Projects after every strategy session.

---

## Current state

| Field | Value |
|-------|-------|
| Last updated | 27 August 2026 (verified against branch `claude/req-integ-002-2a-fix`, code-level facts confirmed by running `node tests/run.js`; v2.9.63 pending merge) |
| Current version | v2.9.63 (pending merge — v2.9.62 is the current `main` release) |
| Test count | 594 / 594 passing (confirmed by re-running the suite, not just read from source) |
| Build branch | main |
| Deployment | **GitHub Pages**, custom domain `app.getstackdops.com` (see `CNAME`) — live, not pending |
| CI/CD | GitHub Actions (`qa.yml`) — runs `node tests/run.js` on every push/PR to main |

**Correction from the previous version of this file:** this file was frozen at v2.9.51 / 422 tests since 10 August while the codebase moved on to v2.9.57 / 521 tests across six shipped versions (v2.9.52–v2.9.57 — per-line quote margins, Supplier price intelligence, the first Supabase-backed layer (Suppliers/Buyers Cloud Data), three new AI Assistant capabilities, RFQ supplier comparison, and a data-integrity cleanup tool). See Version history below for the full list, including v2.9.58 (Phase 1 of an Order Request/RFQ → Quote → Invoice referential integrity build), v2.9.59 (removes v2.9.58's unused `sourceQuoteId` field, confirmed unnecessary post-merge), v2.9.60 (Phase 2 of the same initiative — buyer-approval capture on Invoice), v2.9.61 (Demo Mode expanded with 7 scenarios so Phase 1/2 can be tested locally instead of against production data — interim mitigation for `SDLC-GAP-003`), v2.9.62 (REQ-INTEG-002 sub-phase 2a — a Supplier Payment ledger, the first standalone piece of a larger Payment Allocation build), all shipped and merged as of this update, and v2.9.63 (REQ-INTEG-002-2a-fix — reconciling `PO.dep` display with that same ledger, since real-world testing found v2.9.62's ledger had zero visible effect anywhere until this fix — **pending merge**, not yet on `main`).

---

## The business

*(Business/legal facts below are carried forward from the prior version of this file. They live outside the git repo — Companies House, UKIPO, ICO, bank/pricing records — so they cannot be verified or refuted from source code. Treat them as last-known, not code-verified.)*

**FPM International Ltd** — Brighton-based trade intermediary. Sources from Chinese manufacturers. Supplies Caribbean markets (primarily Barbados). Registered at Companies House May 2026. SIC 46190 + 62012.

**Stackd** — the product. Trade operations platform for sole traders to mid-size firms managing international trade. FPM International is the founding client and proof of concept.

**Wedge feature** — live shipment visibility without human cover. The feature that makes operators sign up. Everything else makes them stay.

**Design principle** — Automation First. Every feature evaluated against one question: does this remove manual work or just move it? Non-negotiable.

**ICP** — UK-based sole traders to micro-firms sourcing from Asia, selling to Caribbean and West Africa. Expanding to UK-Nigeria, UK-Ghana, UK-India corridors.

---

## FPM portal — data state

**Not verifiable from this repo.** The portal is `localStorage`-only (see Architecture below) — there is no server, no database, and no data file committed to git. The KPI/entity figures in the previous version of this file (Invoice Revenue $53,441, 4 invoices, 9 suppliers, etc., "verified 13 May 2026") cannot be confirmed or refuted from source control, and are now three months stale regardless. Two facts *are* code-verifiable and matter for interpreting any such figures:

- **SYNC-GAP-001 (fixed v2.9.47; residue cleanup shipped v2.9.57):** between v2.9.12 and v2.9.46, the Google Sheets "⟲ Sync" **pull** path corrupted every pulled record (fields landed under the wrong property names) and silently broke the delete buttons for those records. Any data pulled from Sheets in that window may contain blank-looking phantom records consuming reference numbers. Fixed in v2.9.47 with reverse field-mapping (`unmapRec()`) and business-key matching — but records already corrupted *before* that fix were never cleaned up, and this is exactly what the operator reported seeing in the live portal (blank/undeletable Supplier and other records) in August 2026. **REQ/SPEC-DATA-002 (v2.9.57)** added a Settings → Data "Scan for phantom records" tool: a read-only scan, a mandatory backup gate, then removal plus sequential renumbering of Supplier/Line Item/Buyer/Contact/Order Request reference numbers (Invoice/PO/Quote/Credit Note numbers are permanently excluded from renumbering, since those are real cross-entity lookup keys elsewhere and appear on documents already sent out). Also hardened `pullAll()` itself so a live recurrence of this defect class is dropped at the source with a console warning, not just historical residue.
- **SEC-GAP-020 (fully resolved 2026-07-05):** GitHub Pages serves the *entire* repository, not just `index.html`. A live business data export (`Test-data/Stackd-Clean-2026-05-17.json`) and this file's supplier-contact table were publicly exposed at `app.getstackdops.com` for some period before discovery. Both were purged, git history was rewritten (`git filter-repo`) across all branches and force-pushed, GitHub deleted the 33 affected PRs at the operator's request, and a GDPR Art. 33(5) assessment concluded it was not ICO-reportable (low risk, B2B professional contacts only, same-day remediation). **Process going forward: every file in this repo is public. Never commit live data exports, backups, or PII.**

To get current KPI/entity figures, read them from the live portal (`app.getstackdops.com`) or its export, not from this file or git.

---

## Architecture

**Stack — still localStorage as the primary store, now v2.9.57 (same shape, one new optional cloud layer for two entities):**

```
index.html           — entire application: HTML + CSS + JS in one file (~850 KB)
tests/run.js         — Node.js test runner, 521 tests, Node VM sandbox
tests/fixtures.js     — shared test fixtures
apps-script/Code.gs  — Google Apps Script webhook handler (Sheets sync backend)
cloudflare-worker/worker.js — CORS proxy in front of the Apps Script endpoint
                       (validates the request path against the Apps Script
                       deployment pattern; no auth/secrets of its own — the
                       sync token still travels in the POST body)
vendor/supabase-js-v2.min.js — vendored Supabase JS client (same-origin static
                       file, no CDN, no auto-update) — Cloud Data feature only
supabase/migrations/0001_suppliers_buyers.sql — the one Supabase table pair
                       (Suppliers, Buyers) built so far — see Cloud Data below
CLAUDE.md            — Claude Code session context (technical)
STACKD_CONTEXT.md    — cross-tool master context (this file)
docs/known-gaps.md   — known gaps log (much more detailed than this file's summary)
docs/version-history.md — full version changelog
docs/requirements-tracker.md — every REQ/SPEC feature's gate history (req-gate →
                       spec-gate → build-gate), the FM-1 exception register, and
                       the full backlog/unscoped list (including the G-01…G-10
                       reporting-compliance items and v3.0.x-deferred items)
docs/dr-procedure.md — disaster recovery / backup procedure
docs/data-model.md, docs/agent-architecture.md, docs/workflow-bpmn.md,
docs/reporting-pipeline-runbook.md, docs/councils/ — supporting docs
```

**Cloud Data (v2.9.54, REQ/SPEC-CLOUD-001) — the first crack in "pure localStorage":** Settings → Cloud Data lets an operator connect Suppliers and Buyers specifically to a shared Supabase project, so more than one browser/device sees the same Supplier/Buyer records. This is genuinely useful prior art for any v3.0 multi-tenant redesign, but it is explicitly **not** multi-tenant: it is one shared Postgres table pair behind Row Level Security that grants any authenticated user full read/write access — there is no tenant/org column, no per-customer isolation, and no role distinction. Migrating existing local Suppliers/Buyers to it is a one-time, explicit, backup-gated action; everything else in the app (Quotes, Invoices, POs, Contacts, Order Requests, the event log) stays local-only, per-browser. A real v3.0 multi-tenant schema would need to design tenant isolation from scratch — this pilot answers "can this app talk to Supabase at all" (yes) but not "how do we partition data between paying customers."

**State layer:**

```js
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai, co, ev, bu, ord }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt, con, events, buy, ord }  // all entity arrays
let EI = { s, l, i, cn, p, sh, qt, co }   // currently-editing ID (null = new)
let cIL = [], cPL = [], cQL = [], cCNL = []
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin }
var QR = { ...QR_DEFAULTS, ...ld('st_qr') }   // includes QR.displayCurrency (v2.9.46)
```

**Entities (10, unchanged since the last version of this file — no new top-level `DB` entity has shipped since v2.9.51; new capability in this period extended existing entities/fields instead, e.g. `rfqResponses[]` on Order Request lines):**

| Key | Store key | Description | Synced to Sheets? |
|---|---|---|---|
| sup | st_s | Suppliers | Yes |
| li | st_l | Line items (product catalogue) | Yes |
| inv | st_i | Invoices | Yes |
| po | st_p | Purchase orders | Yes |
| payments | st_pm | Payment ledger entries | Yes |
| sh | st_sh | Shipments | Yes |
| qt | st_qt | Quotes (v2.9.4) | Yes |
| co | st_co | Contacts (v2.9.27) | Yes |
| events | st_ev | Activity event log (v2.9.28) | No — local-only, FM-1 exception |
| buy | st_buy | Buyers (v2.9.37) | **No** — BUY-GAP-001, deferred to v3.x under FM-1 freeze |
| ord | st_ord | Order Requests (v2.9.44) | No — FM-1 category-3 exception (local-only, no sync mapping) |

**Hard architectural rule (FM-1 mitigation) — unchanged and still in force:** No new features requiring a **new Sheets sync mapping** (`FIELD_MAPS` entry, new Apps Script tab, new `syncEnt` key) on the localStorage stack. v3.0.0 Supabase migration is the exit path. The three FM-1 exceptions from the prior version of this file (UI/AI pre-fill features, new fields on existing entities, new local-only `K`/`DB` entities with no sync mapping) are still the operative carve-outs, and both Buyers and Order Requests were built under them.

**Key field name note:** unchanged — invoice number is `num` not `invNum` in records; `x.num||x.invNum` fallback still used for backward compatibility.

---

## Known gaps (selected — full log is `docs/known-gaps.md`, ~500 lines, far more detailed than this table)

| ID | Area | Summary | Status |
|----|------|---------|--------|
| TRIAL-001 / Demo Mode | Trial conversion | No demo shipment mode | **✓ Fixed v2.9.31** — `loadDemoData()` seeds a full cross-entity scenario, excluded from KPI aggregates, `[DEMO]` badges |
| MTD-001 | Tax compliance | No MTD-compatible VAT export | **✓ Fixed v2.9.32** — full HMRC VAT 100 9-box export + transaction detail CSV. Two residual sub-gaps remain open: **MTD-GAP-001** (no input VAT tracking, Boxes 4/7 always £0.00) and **MTD-GAP-002** (FX rate is export-time not invoice-date) — both accepted as operator responsibility until v3.x. A formal council-gated attempt to close MTD-GAP-001 (tracked as **REQ-RPT-001 G-07**) reached requirements-gate CONDITIONAL PASS in v2.9.33 but was explicitly deferred 2026-08-22: building input-VAT tracking against the single-file, no-server, no-real-audit-trail v2.9.x stack was judged higher-risk than closing it just ahead of the v3.0 migration, where server-side validation makes it safer to get right |
| SYNC-GAP-001 | Data integrity | `pullAll()` corrupted every pulled record's field names and silently broke delete | **✓ Fixed v2.9.47.** Residue from before the fix (phantom blank records already in operators' data) went unaddressed until **✓ v2.9.57** shipped a Settings → Data cleanup tool (REQ/SPEC-DATA-002) — read-only scan, backup-gated removal, safe renumbering, FK-integrity self-check |
| SEC-GAP-020 | Security/GDPR | Entire repo (incl. live PII) publicly served via GitHub Pages | **✓ Fully resolved 2026-07-05** — history purged, PII redacted, GDPR-assessed non-reportable |
| PO-GAP-001 | Purchase orders | Quote→PO conversion misattributed every line except the first supplier's on multi-supplier quotes | **✓ Fixed v2.9.44** (one PO per distinct supplier now). **PO-GAP-002** (open, accepted): historical POs before v2.9.44 may carry incorrect attribution, not retroactively fixable |
| QTE-GAP-001 | Quote status | Convert to PO restricted to Accepted status | ✓ Fixed v2.9.25 (carried over, unchanged) |
| SEC-GAP-001 | Security | Code.gs secrets hardcoded in source | ✓ Fixed v2.9.15/23 (Script Properties) |
| AI-GAP-006/008/009 | AI Assistant | Three of nine creatable entities lacked AI pre-fill; `create_po` couldn't resolve an unsaved supplier by name; `AI_SYSTEM_PROMPT`'s PO status vocabulary didn't match the live dropdown | **✓ All resolved v2.9.55** — Invoice/Line Item/Credit Note AI creation shipped, new `get_suppliers`/`get_buyers` PII-minimized read tools added, prompt vocabulary corrected |
| BUY-GAP-001 | Buyers | Buyers entity not synced to Sheets | Open — deferred to v3.x under FM-1 |
| CLOUD-GAP-001 | Cloud Data / Suppliers | Legacy CSV/Sheets Supplier importers bypass Cloud Data — writes silently discarded on next reload once Cloud Data is configured | Open, logged v2.9.54 |
| DATA-GAP-003 | Data integrity | Friendly ref numbers (`num`) can diverge across unsynced devices | Open, accepted as permanent localStorage-architecture trade-off |
| AI-GAP-007 | AI Assistant | Action-block emission is non-deterministic | Mitigation (`temperature:0.2`) shipped v2.9.42, confirmed effective on retest — not a full fix |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates | Backlog, unchanged |
| SEC-GAP-003 | Security | Anthropic API key in localStorage | Accepted, inherent no-server constraint |
| SEC-GAP-004 | Security | Invoice locking is client-side UX only — not tamper-proof | Accepted by design, v3.0.0 for a real control |
| SEC-GAP-011 | Data integrity | `pullAll()` still has no timestamp-based conflict resolution — Sheets wins | Open, accepted at current operator scale |
| SDLC-GAP-003 | Staging | No same-origin PR preview environment | Backlog, unchanged |
| EVT-GAP-001 | Event log | No warning when 2,000-event cap is hit | Backlog, unchanged |
| REQ-RPT-001 G-08/G-09/G-10 | Compliance / Operational / Data Integrity | Intrastat report; supplier performance tracking; HS-code duty recalculation on existing invoices | Deferred to v3.0.x, unscoped |
| ORD-GAP-003 | Order Requests / Quotes | RFQ commit ↔ Quote drift — no back-reference, no staleness warning | **✓ Fixed v2.9.58** (REQ/SPEC-INTEG-001 Phase 1) — Quote lines now carry a source back-reference; a warning banner appears if the source RFQ commitment changes afterward |
| PO-GAP-003 | Invoices / Purchase Orders | Invoice ↔ auto-generated PO drift — edits after first save never re-sync, no warning | **✓ Fixed v2.9.58** (REQ/SPEC-INTEG-001 Phase 1) — `autoPos()`-generated POs now capture a price snapshot; a warning banner appears if the source Invoice changes afterward (price, qty, or a newly-added line). One accepted residual gap: a brand-new-supplier line with no PO at all is not flagged |

---

## Version history (v2.9.32 → v2.9.63 — everything shipped since this file was last updated)

| Version | Key changes |
|---------|------------|
| v2.9.63 | Fix (pending merge): **Reconcile `PO.dep` display with the Supplier Payment ledger** (REQ-INTEG-002-2a-fix, a fix-forward against v2.9.62's Sub-phase 2a). Real-world testing found recording a payment through the new ledger had zero visible effect anywhere — 10 separate read sites across `editPO()`, `rPO()`, `prevPODoc()`, `rDash()` (KPIs and the PO Commitments chart), `renderAccts()` (per-invoice, per-supplier, totals bar), and `_aiExecTool()` all read the raw, disconnected `PO.dep` field directly. New `getPOEffectiveDep(po)` is now the single point of truth for all 10: once a PO has linked Supplier Payment records, its Deposit Paid figure is reconciled — same-currency payments summed as exact raw amounts, cross-currency payments converted via that record's own historically-locked FX rate (`lockFxRate()` now snapshots the full static rate table at save time, not just the one rate it applied, so this second conversion leg is genuinely historical too, not derived from today's live rate). A PO with no ledger records, or a currency this mechanism can't yet safely reconcile (EUR — logged as `PROC-GAP-002`, a pre-existing gap in the shared FX mechanism, not something this fix introduces), keeps showing its manually-entered figure unchanged, with an explanatory note. The "Supplier Deposit Paid" field becomes read-only once ledger records exist, avoiding two ways to change the same number. Went through 2 independent review rounds each for requirements-gate and spec-gate; round-1s each caught a real blocking defect (a missed 10th read site, and a EUR-currency PO that would have shown a silently wrong, mislabeled figure on its own PDF — worse than today's un-reconciled-but-honest behavior; and a read-only/note state that could leak from an edited PO into a freshly-opened new one, confirmed real by tracing the actual "new PO" trigger function). 19 new tests. **594/594.** |
| v2.9.62 | New: **Supplier Payment ledger, sub-phase 2a of a larger Payment Allocation build** (REQ/SPEC-INTEG-002: 2a Supplier ledger → 2b Invoice→PO enumeration fix → 2c Buyer payment tranches → 2d full allocation link). Every payment FPM makes to a supplier can now be recorded individually against its PO — date, amount, native currency, purpose (Deposit/Balance/Other), method, reference, notes — via a new "$" action on the Purchase Orders tab, replacing `PO.dep`/`PO.fpmFunded`'s single-overwrite fields with no history. Each payment locks in a GBP-equivalent snapshot (`lockFxRate()`) at save time via the existing `toGBP()` mechanism, so historical totals stay accurate even after FX rates change later. New `getPOTotalPaid()` sums a PO's payments correctly across multiple native currencies by summing locked GBP-equivalents, not raw amounts. Standalone ledger — does not read/write the existing PO fields, no link to buyer-side payments yet (later sub-phases). Went through 2 independent review rounds each for requirements-gate and spec-gate; round-1s each caught a real blocking defect (a false claim that buyer-side Payments is unsynced, which would have wrongly justified an inert field-map entry for the new entity — corrected to follow the genuine no-sync precedent, Order Requests/Buyers; and a missing backup/restore wiring that would have made the new ledger's only backup, the local JSON export, silently drop every record on restore). 12 new tests. **575/575.** |
| v2.9.61 | Expanded Demo Mode (`loadDemoData()`) with 7 new scenarios so REQ-INTEG-001 Phase 1/2 can actually be exercised locally instead of against production data (interim mitigation for `SDLC-GAP-003`, no staging environment) — not a REQ/SPEC-gated feature, test/demo-data tooling only. Added: an Order Request (DORD-0001) with 2 RFQ responses from different suppliers for the comparison panel; a Quote (DQ-0002) converted from it whose source RFQ response was re-committed afterward, reproducing the Phase 1 Quote staleness banner; an unapproved Pro-forma invoice (DINV-0002); an approved, non-stale invoice (DINV-0003) for the clean "Progress to Invoicing" path; an invoice (DINV-0004) that was approved then had a line edited, showing Phase 2's automatic approval-clearing already having fired (both events present in the log); and an invoice/PO pair (DINV-0005/DPO-0002) reproducing the Phase 1 PO staleness banner. One scenario from the original brief — an illegal Order-Request-stage auto-advance triggered by "Progress to Invoicing" — was not built: check-first confirmed Progress to Invoicing never touches Order Request stage in the shipped Phase 2 design (a confirmed decision from that build, not an oversight), so there is no such transition to exercise. Also fixed a real pre-existing gap surfaced while doing this: `loadDemoData()`/`clearDemoData()` never included Order Requests or the Line Item catalogue at all — both are now covered by the idempotency check and cleanup. 6 new tests. **563/563.** |
| v2.9.60 | New: **Buyer-approval capture on Invoice, Phase 2 of 4** (REQ/SPEC-INTEG-001 Phase 2) — while an invoice is at Pro-forma status, "Mark Buyer Approved" records `buyerApprovedAt`/`buyerApprovedBy`/`approvalMethod` (closed-set: Email, WhatsApp, WeChat, Phone / Verbal, Other)/`approvalNote`, confirming the buyer's out-of-band approval. Editing any line item (price, quantity, or an added/removed line) after approval automatically clears all four fields, forcing re-approval — header-only edits never clear it. "Progress to Invoicing," available once approved, never changes status; it only logs the action and optionally records a manual, non-binding Quote link (`linkedQuoteId`/`linkedQuoteNum`) for audit trail — there is no automatic Quote→Invoice path in the codebase, so this is a deliberate manual selection. Both new actions bypass `saveInv()`'s form-rebuild (direct record mutation) so unrelated in-progress edits in the main modal can't interfere. Also extended the `pos`-style field-preservation pattern to both CSV-import code paths, which otherwise would have silently dropped an already-recorded approval on re-import. Went through 2 independent review rounds each for requirements-gate and spec-gate; both round-1s caught real blocking defects (a false "reuses an existing mechanism" claim for the line-comparison logic; a real, demonstrated approval-loss path via CSV re-import), both fixed and confirmed in round 2. One further build-time bug (a rid-matching fallback that never actually matched) found via test-writing and fixed before merge. 19 new tests. **557/557.** |
| v2.9.59 | Removed: Invoice's schema-only `sourceQuoteId` field, added in v2.9.58 as forward-compatibility for a possible future Quote-aware Invoice-creation path. Confirmed with the business post-merge: direct Quote→Invoice traceability is not needed — the real workflow is always Quote → PO → Invoice, and that chain is already fully covered by two pre-existing mechanisms, `qteToPoConvert()` (`quoteId`/`quoteNum` on PO) and `autoPos()` (`invId`/`invNum` on PO). Everything else from Phase 1 (Quote-line source back-references, both staleness-warning banners) is unaffected. 1 test removed. **538/538.** |
| v2.9.58 | New: **Order Request/RFQ → Quote → Invoice referential integrity, Phase 1 of 4** (REQ/SPEC-INTEG-001) — traceability and read-only staleness detection only, closing `ORD-GAP-003` and `PO-GAP-003`. A Quote line created from a committed RFQ response now carries a back-reference to the exact Order Request line/response it came from; a warning banner appears if a *different* response is later committed. An `autoPos()`-generated PO now captures the invoice's unit price at generation time; a warning banner appears if the invoice's price, quantity, or line items (including a newly-added line for the same supplier) change afterward. Neither banner auto-fixes anything — detection and a visible warning only. Invoice also gains a schema-only `sourceQuoteId` field with no automatic population (no Quote→Invoice conversion path exists in the codebase to populate it from). Went through 2 independent review rounds each for requirements-gate and spec-gate; both round-1s caught a real blocking defect (the original PO check could only catch 2 of 3 named drift types; the price-comparison mechanism would have permanently false-flagged every pre-existing PO), both fixed and confirmed in round 2. 18 new tests. **539/539.** Build-gate independent review PASS, no findings. |
| v2.9.57 | New: **Data Integrity Cleanup** (REQ/SPEC-DATA-002) — Settings → Data "Scan for phantom records": read-only scan → mandatory backup gate → removal of blank/corrupted records (residue of SYNC-GAP-001, predating the v2.9.47 fix) → sequential renumbering of Supplier/Line Item/Buyer/Contact/Order Request numbers only (Invoice/PO/Quote/Credit Note numbers permanently excluded — real lookup keys elsewhere) → post-cleanup FK-integrity self-check. Also hardens `pullAll()` so a live recurrence is dropped at the source, not just cleaned up after the fact. 15 new tests. **521/521.** |
| v2.9.56 | New: **RFQ supplier comparison & commit** (REQ/SPEC-QTE-001 Part B) — each Order Request line gets a "Compare RFQs" panel recording multiple suppliers' quoted responses, ranked by landed cost converted to a common currency; exactly one response can be committed per line, and committing feeds a Quote hand-off with correct currency conversion. Fix: closes the last open item from REQ-V3-GAP-006 (Contact link/unlink event logging). 14 new tests. 506/506. |
| v2.9.55 | New: **AI Assistant** gains Invoice/Line Item/Credit Note creation plus PII-minimized Supplier/Buyer read tools (REQ/SPEC-AI-GAP-002) — closes AI-GAP-006/008/009. New: **AI-assisted enquiry intake check** (REQ/SPEC-CON-004) — flags ambiguous Contact enquiry text via a single-shot Anthropic call, PII-scoped payload. 23 new tests. 492/492. |
| v2.9.54 | New: **Cloud Data** — first Supabase-backed layer, Suppliers/Buyers only (REQ/SPEC-CLOUD-001). One shared Postgres table pair behind RLS, not multi-tenant (see Architecture above). Backup-gated one-time migration with automatic reference remapping across Quotes/POs/Line Items/Contacts/Invoices; 30-day local rollback archive. Went through 4 independent requirements-gate and 4 independent spec-gate rounds before build. 19 new tests. 473/473. |
| v2.9.53 | New: **Supplier price intelligence** (REQ/SPEC-SUP-001) — Price History panel aggregating every recorded price point for a Supplier across Line Items/Quotes/POs, with staleness flagging. 10 new tests. 454/454. |
| v2.9.52 | New: **Per-line quote margin override** (REQ/SPEC-QTE-001 Part A) — each Quote line can override the quote-level margin; overhead charges no longer marked up (deliberate behavior change, recomputes existing quotes' Grand Total). 12 new tests. 434/434. |
| v2.9.51 | New: Contacts CSV upload (Import Data tab, 6th step) — reuses existing Sheets-pull dedup/mapping logic. 10 new tests. **422/422.** |
| v2.9.50 | New: Order Request per-line gap check — structural (instant) + AI-assisted semantic check, manual trigger, nothing persisted. 11 new tests. 412/412. |
| v2.9.49 | Fix: invoice quick-add COGS warning fired on legitimate zero-margin pass-through lines. 6 new tests. 401/401. |
| v2.9.48 | New: Order Request CSV import; Quote approval audit trail (Approved By/Note). 11 new tests. 395/395. |
| v2.9.47 | Fix: **SYNC-GAP-001** — `pullAll()` field-mapping/identity loss, closed with `unmapRec()`/business-key matching. 24 new tests. 384/384. |
| v2.9.46 | New: Global display-currency toggle (GBP/USD/RMB/BBD) on Dashboard/Buyers. 9 new tests. 372/372. |
| v2.9.45 | New: Order Request line items, append-only `lineUpdates[]` provenance log. 13 new tests. 363/363. |
| v2.9.44 | Fix: **PO-GAP-001** — one PO per supplier on multi-supplier Quote conversion. New: Order Management (`DB.ord`, full Orders tab + stage state machine). 27 new tests. 349/349. |
| v2.9.43 | New: Friendly reference numbers (SUP-/LI-/BUY-/CON-####). New: Excel/Power Query reporting pipeline (docs only). 19 new tests. 322/322. |
| v2.9.42 | Fix: AI action-block reliability — `temperature:0.2` added after live UAT found 3/6 create-flows silently falling back to describing manual steps. 303/303. |
| v2.9.41 | New: AI-assisted Supplier and Buyer creation via `handleAIAction()`. 303/303. |
| v2.9.40 | Fix: Pro-forma invoice preview/PDF rendered as a plain Invoice. 301/301. |
| v2.9.39 | **Security: SEC-GAP-020 PII purge** — live dataset and contact PII removed from the public repo; `.gitignore` hardened. 298/298. |
| v2.9.38 | Security: logo-URI sanitisation, sync token stripped from backup export, sync-token header attempt reverted (Apps Script can't read custom headers). 298/298. |
| v2.9.37 | New: Buyers entity (`DB.buy`), ad-hoc buyer seed, invoice Buyer field converted to closed-set dropdown. 298/298. |
| v2.9.36 | New: Full entity event log coverage (Invoice/PO/Payment/Supplier); invoice edit delta/audit trail. 289/289. |
| v2.9.35 | New: Aging Report (DSO, overdue buckets) and P&L Report, both with CSV export. 280/280. |
| v2.9.34 | New: AI date filters on `get_invoices`/`get_payments`; quick-add COGS warning (amber banner). 270/270. |
| v2.9.33 | New: AI live data tools — `get_invoices`/`get_payments`/`get_kpis`/`get_pos` via Anthropic tool use. 263/263. |
| v2.9.32 | New: **MTD-compatible VAT Return export** (9-box HMRC VAT 100 + transaction detail CSV). 11 new tests. 263/263. *(This file was last updated at this version — everything above is new since.)* |

*Full history back to v2.8.1 is in `docs/version-history.md`.*

---

## Build queue

**Completed since this file was last accurate:** all eleven versions v2.9.52–v2.9.62 shipped and merged to `main` via PR. v2.9.52–v2.9.58, v2.9.60, and v2.9.62 each went through the full requirements-gate → spec-gate → build → independent build-gate review pipeline documented in `docs/requirements-tracker.md`; v2.9.59 was a small, low-risk post-merge cleanup (removing one confirmed-dead schema field) verified by check-first and a full test-suite run rather than a full gate cycle. v2.9.61 is test/demo-data tooling, not a REQ/SPEC-gated feature — standard build-gate review only (independent review PASS), no `docs/requirements-tracker.md` entry, per its own brief. **v2.9.63 (REQ-INTEG-002-2a-fix) has completed requirements-gate (PASS, v2, after a v1 FAIL) and spec-gate (PASS, v2, after a v1 FAIL) and is built with 594/594 tests passing — build-gate review and merge are still pending as of this update.**

**Stale unmerged branches — still present on the remote, now confirmed superseded, worth deleting in a cleanup pass:**

| Branch | Status |
|--------|--------|
| `claude/con-003-id-backfill` | Superseded — Contact id backfill (`backfillConIds()`) shipped on `main` under REQ/SPEC-CON-003 |
| `claude/doc-001-user-guide` | Superseded — `docs/user-guide.md` has since been fully rewritten and shipped on `main` directly |
| `claude/inv-cogs-warning-fix` | Superseded — the invoice quick-add COGS warning fix shipped as v2.9.49 |
| `claude/ord-005-gap-detection` | Superseded — Order Request per-line gap detection shipped as v2.9.50 |

**Unmerged branches not verified this pass** (`claude/ord-followup-fixes`, `claude/sync-race-condition-fixes-*`, `claude/triage-tool-page`) — still exist on the remote, content not checked against what's since shipped on `main`. A full branch cleanup/triage session (delete confirmed-superseded branches, check the rest for unique unshipped work) remains outstanding.

**Backlog carried forward from `docs/known-gaps.md` / `docs/requirements-tracker.md` (business-priority items, still open):**

| Item | Notes |
|------|-------|
| MTD-GAP-001/002 (REQ-RPT-001 G-07) | Input VAT tracking, invoice-date FX — requirements-gate reached CONDITIONAL PASS in v2.9.33 but explicitly deferred to v3.0.x on 2026-08-22 rather than building it against the pre-Supabase stack |
| REQ-RPT-001 G-08/09/10 | Intrastat report, supplier performance tracking, HS-code duty recalculation — all deferred to v3.0.x, unscoped |
| BUY-GAP-001 | Buyers → Sheets sync — deferred to v3.x (FM-1) |
| AI-GAP-001 (broad) | Agentic multi-step order flow — deferred to v3.0.x, requires a server-side proxy |
| DASH-GAP-001 | Dashboard charts are hand-rolled divs, no interactivity — Chart.js vendoring recommended if picked up |
| CLOUD-GAP-001 | Legacy CSV/Sheets Supplier importers bypass Cloud Data once configured |
| SDLC-GAP-003 | Same-origin PR preview environment |

**v3.0.0 (still the stated target, no code-verifiable date):** Supabase backend, multi-tenancy, MFA, RBAC, server-side API proxy, referral mechanics. Prerequisite: freelance data architect engagement. See `docs/v3-architect-handoff.md` for the consolidated technical/business handoff packet assembled for that engagement.

---

## Active risks

*(Updated against what's actually shipped; unresolved items unchanged from the prior version of this file.)*

| ID | Risk | Status | Notes |
|----|------|--------|--------|
| R-001 | localStorage GDPR exposure | ACTIVE | v3.0.0 resolves. SEC-GAP-020 (public-repo PII exposure, a related but distinct risk) is now closed. |
| R-003 | Trial conversion too low | **Mitigation shipped** | Demo shipment mode shipped v2.9.31 — whether it actually moved the conversion number is a business-side question this repo can't answer |
| R-004 | MTD compliance gap | **Mitigation shipped** | VAT Return export shipped v2.9.32; MTD-GAP-001/002 remain as documented residual gaps, not full closure |
| R-007 | Supplier intelligence empty database | Unverifiable from repo | Data lives in operator's localStorage |
| R-002 | Alibaba/platform competition | MONITOR | Business-side, unchanged |
| R-005 | Corridor concentration risk | MONITOR | Business-side, unchanged |
| R-006 | AI moat erosion | MONITOR | Business-side, unchanged |

---

## Legal and IP

*(Unverifiable from this repo — carried forward unchanged from the prior version of this file. Confirm current status directly with Companies House / UKIPO / ICO rather than trusting this table.)*

| Item | Status (last known) | Notes |
|------|--------|-------|
| FPM International Ltd | Registered May 2026 | Companies House. SIC 46190 + 62012 |
| STACKD trade mark | Filed May 2026 | UKIPO Classes 35 + 42. £220. 4-6 months to grant |
| EUIPO trade mark | Backlog | Apply after UK grant |
| ICO registration | Backlog | Required before first external client |
| T&Cs + Privacy Policy | Backlog | Before v3.0.0 launch |
| getstackdops.com / app.getstackdops.com | Live | GitHub Pages, confirmed via `CNAME` in repo |

---

## Pricing

*(Business-side, unverifiable from this repo — carried forward unchanged.)*

| Tier | Price | Users | Key threshold |
|------|-------|-------|---------------|
| Starter | £49/mo | 1 | Up to 5 active shipments |
| Growth | £149/mo | Up to 3 | Unlimited shipments + API tracking |
| Scale | £399/mo | Up to 10 | Supplier portal + MTD |
| Enterprise | Custom | Unlimited | Never shown on pricing page |

Enterprise base: £1,200/month + £25/user beyond 10 + integration fees.

---

## Google Sheets tracker IDs

| Tracker | Sheet ID |
|---------|----------|
| Requirements Tracker | stored in Apps Script → Script Properties as `REQUIREMENTS_TRACKER_ID` |
| Project Tracker | stored in Apps Script → Script Properties as `PROJECT_TRACKER_ID` |

Apps Script write bridge live: actions `update_requirements_tracker` and `update_project_tracker`. Sync now routes through a Cloudflare Worker CORS proxy in front of Apps Script (`cloudflare-worker/worker.js`) — confirmed present in repo, not documented in the prior version of this file.

---

## Key contacts

**PII REDACTED (2026-07-04, reaffirmed under SEC-GAP-020's 2026-07-05 full resolution).** Supplier contact names, emails, and phone numbers were removed from this file because this repository is publicly served via GitHub Pages. Contact details live in the Stackd Ops portal (Suppliers entity) — the portal's localStorage is the canonical store. Operational notes retained below without personal identifiers:

| Company | Products | Notes |
|---------|----------|-------|
| Shandong Jinbao | PVC Foam Board | Fire cert required each shipment |
| Anhui HYY | Onion Mesh Bags | — |
| Shanghai Bokni | Centrifugal Juicers | Verify 220V |
| Zhengzhou Rongchang | Sugar Cane Juicer | — |
| Xingtai Xingcha | Pallet Jacks | — |
| Fuzhou Bote | Freezers/Chillers/Cold Storage | 30% dep/70% BL. 45 day lead. CE cert |
| Zhongshan Chuhui | Solar LED Floodlights | — |
| Changzhou Intelligent Weighing | Platform Scales | — |
| Amazon Business (Reolink) | Security Cameras | amazon.com/business. US tax in COGS. Zero margin |

---

## How to use this file

**For Claude Code:** Read at start of every session. Update at end of every version delivery — bump version, test count, update build queue, add to version history, update known gaps. **This file drifted three months out of date last time (frozen at v2.9.32 while code moved to v2.9.51) — follow the "On version delivery" checklist in `CLAUDE.md` every single release, no exceptions.**

**For Claude Projects:** Fetch at start of new conversation thread.

**For new Claude conversations:** Paste this URL into your first message: `https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`

**Update protocol:**
1. After every version delivery — Claude Code updates version, tests, build queue, known gaps.
2. After every strategy session — update sprint status, risk register, decisions.
3. After every China trip / business-development meeting — update contacts, agent pipeline, trip outcomes.
4. Monthly — update regulatory calendar status, competitive scan notes.
5. **When re-verifying this file, distinguish code-verifiable facts (version, tests, entities, gaps — check against `main` directly) from business-side facts (legal, pricing, contacts) that this repo cannot confirm or deny.**

---

*STACKD · Source · Supply · Ship · FPM International Ltd · getstackdops.com*
*Living document — last updated 24 August 2026*
