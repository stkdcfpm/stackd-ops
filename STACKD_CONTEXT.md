# STACKD — Project Context

> **Single source of truth for all Claude tools — Projects, Code, and new conversations.**
> Fetch this file at the start of any new session: `https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`
> Updated by Claude Code on every version delivery. Updated by Claude Projects after every strategy session.

---

## Current state

| Field | Value |
|-------|-------|
| Last updated | 10 August 2026 (verified against `main` @ `547c860`, code-level facts confirmed by running `node tests/run.js`) |
| Current version | v2.9.51 |
| Test count | 422 / 422 passing (confirmed by re-running the suite, not just read from source) |
| Build branch | main |
| Deployment | **GitHub Pages**, custom domain `app.getstackdops.com` (see `CNAME`) — live, not pending |
| CI/CD | GitHub Actions (`qa.yml`) — runs `node tests/run.js` on every push/PR to main |

**Correction from the previous version of this file:** this file was frozen at v2.9.32 / 263 tests since 21 June while the codebase moved on to v2.9.51 / 422 tests. The two items previously listed as "CRITICAL — next sprint" (demo shipment mode, MTD export) both shipped one version after this file's last edit — see Version history below. Deployment was also previously listed as "Vercel — deploy pending"; there is no Vercel reference anywhere in the repo. The live deployment is GitHub Pages on `app.getstackdops.com`.

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

- **SYNC-GAP-001 (fixed v2.9.47):** between v2.9.12 and v2.9.46, the Google Sheets "⟲ Sync" **pull** path corrupted every pulled record (fields landed under the wrong property names) and silently broke the delete buttons for those records. Any data pulled from Sheets in that window may contain blank-looking phantom records consuming reference numbers. Fixed in v2.9.47 with reverse field-mapping (`unmapRec()`) and business-key matching.
- **SEC-GAP-020 (fully resolved 2026-07-05):** GitHub Pages serves the *entire* repository, not just `index.html`. A live business data export (`Test-data/Stackd-Clean-2026-05-17.json`) and this file's supplier-contact table were publicly exposed at `app.getstackdops.com` for some period before discovery. Both were purged, git history was rewritten (`git filter-repo`) across all branches and force-pushed, GitHub deleted the 33 affected PRs at the operator's request, and a GDPR Art. 33(5) assessment concluded it was not ICO-reportable (low risk, B2B professional contacts only, same-day remediation). **Process going forward: every file in this repo is public. Never commit live data exports, backups, or PII.**

To get current KPI/entity figures, read them from the live portal (`app.getstackdops.com`) or its export, not from this file or git.

---

## Architecture

**Stack — still localStorage, now v2.9.51 (unchanged shape, more entities):**

```
index.html          — entire application: HTML + CSS + JS in one file (~654 KB)
tests/run.js         — Node.js test runner, 422 tests, Node VM sandbox
tests/fixtures.js     — shared test fixtures
apps-script/Code.gs  — Google Apps Script webhook handler (Sheets sync backend)
cloudflare-worker/worker.js — CORS proxy in front of the Apps Script endpoint
                       (validates the request path against the Apps Script
                       deployment pattern; no auth/secrets of its own — the
                       sync token still travels in the POST body)
CLAUDE.md            — Claude Code session context (technical)
STACKD_CONTEXT.md    — cross-tool master context (this file)
docs/known-gaps.md   — known gaps log (much more detailed than this file's summary)
docs/version-history.md — full version changelog
docs/dr-procedure.md — disaster recovery / backup procedure
docs/data-model.md, docs/agent-architecture.md, docs/workflow-bpmn.md,
docs/reporting-pipeline-runbook.md, docs/councils/ — supporting docs
```

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

**Entities (10, up from 7 in the last version of this file):**

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
| MTD-001 | Tax compliance | No MTD-compatible VAT export | **✓ Fixed v2.9.32** — full HMRC VAT 100 9-box export + transaction detail CSV. Two residual sub-gaps remain open: **MTD-GAP-001** (no input VAT tracking, Boxes 4/7 always £0.00) and **MTD-GAP-002** (FX rate is export-time not invoice-date) — both accepted as operator responsibility until v3.x |
| SYNC-GAP-001 | Data integrity | `pullAll()` corrupted every pulled record's field names and silently broke delete | **✓ Fixed v2.9.47** |
| SEC-GAP-020 | Security/GDPR | Entire repo (incl. live PII) publicly served via GitHub Pages | **✓ Fully resolved 2026-07-05** — history purged, PII redacted, GDPR-assessed non-reportable |
| PO-GAP-001 | Purchase orders | Quote→PO conversion misattributed every line except the first supplier's on multi-supplier quotes | **✓ Fixed v2.9.44** (one PO per distinct supplier now). **PO-GAP-002** (open, accepted): historical POs before v2.9.44 may carry incorrect attribution, not retroactively fixable |
| QTE-GAP-001 | Quote status | Convert to PO restricted to Accepted status | ✓ Fixed v2.9.25 (carried over, unchanged) |
| SEC-GAP-001 | Security | Code.gs secrets hardcoded in source | ✓ Fixed v2.9.15/23 (Script Properties) |
| BUY-GAP-001 | Buyers | Buyers entity not synced to Sheets | Open — deferred to v3.x under FM-1 |
| DATA-GAP-003 | Data integrity | Friendly ref numbers (`num`) can diverge across unsynced devices | Open, accepted as permanent localStorage-architecture trade-off |
| AI-GAP-007/008 | AI Assistant | Action-block emission is non-deterministic; `create_po` can't resolve a name to an ID for a not-yet-saved supplier | Open — `temperature:0.2` mitigation shipped v2.9.42, not a full fix |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates | Backlog, unchanged |
| SEC-GAP-003 | Security | Anthropic API key in localStorage | Accepted, inherent no-server constraint |
| SEC-GAP-004 | Security | Invoice locking is client-side UX only — not tamper-proof | Accepted by design, v3.0.0 for a real control |
| SEC-GAP-011 | Data integrity | `pullAll()` still has no timestamp-based conflict resolution — Sheets wins | Open, accepted at current operator scale |
| SDLC-GAP-003 | Staging | No same-origin PR preview environment | Backlog, unchanged |
| EVT-GAP-001 | Event log | No warning when 2,000-event cap is hit | Backlog, unchanged |

---

## Version history (v2.9.32 → v2.9.51 — everything shipped since this file was last updated)

| Version | Key changes |
|---------|------------|
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

**Completed since this file was last accurate (Sprints 1–2, referenced in the old version, remain done as recorded).**

**In progress / unmerged — needs attention:**

| Item | Status |
|------|--------|
| `claude/con-003-id-backfill` | Unmerged branch, HEAD commit titled "Version delivery for **v2.9.52**: Contact id backfill fix" |
| `claude/doc-001-user-guide` | Unmerged branch, HEAD commit **also** titled "Version delivery for **v2.9.52**: version-controlled user guide" |

**These two branches independently claim the same next version number (v2.9.52).** Only one can actually ship as v2.9.52 — whichever merges second needs to be renumbered to v2.9.53 before merge, or the two need to be combined into one release. Flagging this now so it isn't discovered as a collision at merge time. Several other feature branches exist unmerged (`ord-followup-fixes` @ v2.9.44 base, `sync-race-condition-fixes-*` @ v2.9.25 base, `triage-tool-page` @ v2.9.48 base, `inv-cogs-warning-fix` @ v2.9.49 base, `ord-005-gap-detection` @ v2.9.50 base, and others) — not investigated in this pass; worth a branch cleanup/triage session.

**Backlog carried forward from known-gaps.md (business-priority items, still open):**

| Item | Notes |
|------|-------|
| MTD-GAP-001/002 | Input VAT tracking, invoice-date FX — deferred to v3.x |
| BUY-GAP-001 | Buyers → Sheets sync — deferred to v3.x (FM-1) |
| AI-GAP-006 (remaining 3 of 9) | Invoices, Line Items, Credit Notes still lack AI-assisted creation — closed-set dropdown / no-lookup blockers documented |
| DASH-GAP-001 | Dashboard charts are hand-rolled divs, no interactivity — Chart.js vendoring recommended if picked up |
| SDLC-GAP-003 | Same-origin PR preview environment |

**v3.0.0 (still the stated target, no code-verifiable date):** Supabase backend, multi-tenancy, MFA, RBAC, server-side API proxy, referral mechanics. Prerequisite: freelance data architect engagement.

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
*Living document — last updated 10 August 2026*
