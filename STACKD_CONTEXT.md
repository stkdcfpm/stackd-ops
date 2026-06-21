# STACKD — Project Context
> **Single source of truth for all Claude tools — Projects, Code, and new conversations.**
> Fetch this file at the start of any new session: `https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`
> Updated by Claude Code on every version delivery. Updated by Claude Projects after every strategy session.

---

## Current state

| Field | Value |
|-------|-------|
| Last updated | 21 June 2026 |
| Current version | v2.9.28 |
| Test count | 227 / 227 passing |
| Build branch | main |
| Deployment | stkdcfpm.github.io/stackd-ops |
| Website | getstackdops.com (Vercel — deploy pending) |
| CI/CD | GitHub Actions — runs on every push to main |

---

## The business

**FPM International Ltd** — Brighton-based trade intermediary. Sources from Chinese manufacturers. Supplies Caribbean markets (primarily Barbados). Registered at Companies House May 2026. SIC 46190 + 62012.

**Stackd** — the product. Trade operations platform for sole traders to mid-size firms managing international trade. FPM International is the founding client and proof of concept.

**Wedge feature** — live shipment visibility without human cover. The feature that makes operators sign up. Everything else makes them stay.

**Design principle** — Automation First. Every feature evaluated against one question: does this remove manual work or just move it? Non-negotiable.

**ICP** — UK-based sole traders to micro-firms sourcing from Asia, selling to Caribbean and West Africa. Expanding to UK-Nigeria, UK-Ghana, UK-India corridors.

---

## FPM portal — current data state

**Dashboard KPIs (verified 13 May 2026):**

| KPI | Value | Notes |
|-----|-------|-------|
| Invoice Revenue | $53,441 | 4 invoices |
| Net Profit | $11,360 | Corrected PVC-34 COGS |
| Avg Margin | 15.9% | Weighted avg margin enabled v2.9.12 |
| Outstanding from Buyers | $16,778.24 | INV10030 $9,730 + INV10031 $7,048.24 after CN deductions |
| PO Balance Due | $0 | No POs entered yet |
| Net Cash Position | $36,013 | Buyer deposits only |
| In Transit | 0 | SHP-001 Delivered, SHP-002 Booked |

**Entities:**

| Entity | Count | Notes |
|--------|-------|-------|
| Suppliers | 9 | All active, verified |
| Line Items | 20 | All SKUs across active invoices |
| Invoices | 4 | INV10028 Paid, INV10029 Paid, INV10030 Partially Paid, INV10031 Sent |
| Credit Notes | 2 | CN10030 ($450 Applied), CN10031 ($200 Applied) |
| Purchase Orders | 0 | Not yet entered — pending |
| Payments | 4 | Ledger entries for all paid/partial invoices |
| Shipments | 2 | SHP-001 MSC Mara Delivered, SHP-002 TBC Booked |
| Quotes | 0 | Engine built v2.9.4, no quotes entered yet |

**Important invoice notes:**
- INV10028: PVC-34 unit cost $19.44 (Jan 2026 order). calc_cogs $25,226. calc_balanceDue $0 (Paid)
- INV10029: calc_balanceDue $0 (Paid)
- INV10030: calc_balanceDue $9,730 after CN10030 ($450 freight credit). Status: Partially Paid
- INV10031: calc_balanceDue $7,048.24 after CN10031 ($200 freight credit). grand total corrected to $7,042.19 (landing fee double-count fixed v2.9.13). Status: Sent
- INV10032: pro-forma — pending freight figure from shipping agent. Not yet in portal
- SHP-001 BL: MEDUWA872896. Vessel: MSC Mara. Carrier: MSC

**Google Sheets sync:**
- Auto-sync: ON (re-enabled 13 May 2026 after data stabilisation)
- Apps Script URL: in Stackd Settings → Google Sheets
- Sync token: [stored in Apps Script → Script Properties as TOKEN — rotate before any new repo access]
- Tracker write bridge: live on main — actions update_requirements_tracker and update_project_tracker

---

## Architecture

**Current stack (v2.9.x — localStorage):**
```
index.html          — entire application: HTML + CSS + JS in one file
tests/run.js        — Node.js test runner, 197 tests
apps-script/Code.gs — Google Apps Script webhook handler
CLAUDE.md           — Claude Code session context (technical)
STACKD_CONTEXT.md   — Cross-tool master context (this file)
docs/known-gaps.md  — Known gaps log
docs/version-history.md — Full version changelog
```

**State layer:**
```javascript
const K = { s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
            sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au', ai:'st_ai',
            co:'st_co', ev:'st_ev' }
let DB = { sup, li, inv, po, payments, sh, qt, con, events }
let EI = { s, l, i, p, sh, qt, cn }
let cIL = [], cPL = [], cQL = [], cCNL = []
var QR = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP, fcl40HQ,
           originCharges, destCharges, dgSurcharge, insRate, fpmAdmin }
var _aiMode = 'ops' | 'compliance'  // persisted to stackd_ai_mode
```

**Hard architectural rule (FM-1 mitigation):**
No new features on localStorage stack after v2.9.x. v3.0.0 Supabase migration begins in parallel — never after. This decision is locked.

**FM-1 exception (agreed 2026-06-21) — product owner approved:**
The intent of FM-1 is to prevent storage-layer complexity that would complicate the v3.0.0 Supabase migration — not to block operational improvements with clear migration paths. The following are explicitly approved for v2.9.x:

1. **UI/AI layer features with no new localStorage entities** — AI assistant enhancements that parse model responses and pre-fill existing modals for user review (with no automatic record creation). No new `K` key, no new `DB` entity required.

2. **New fields on existing entities** — Adding fields to an existing `DB` entity (e.g. `supplierId`, `role` on `DB.con`) is permitted where the fields do not require a new sync mapping and the entity already exists in `K` and `saveAll()`. These fields are trivially migratable to Supabase as new columns on existing tables.

3. **New internal-only `K` key and `DB` entity with no Sheets sync** — A new entity that is local-only (no `FIELD_MAPS` entry, no `syncEnt` call, no Apps Script tab) is permitted where the entity is operationally self-contained and does not create external data transmission obligations. Specifically approved: `K.ev = 'st_ev'` / `DB.events` (global event log, v2.9.28).

Any feature requiring a **new Sheets sync mapping** (`FIELD_MAPS` entry, new Apps Script sheet tab, new `syncEnt` entity key) remains under the original FM-1 freeze and requires a separate council decision.

**Key field name note:**
Invoice number stored as `num` not `invNum` in current records. Dashboard and calc functions use `x.num||x.invNum` for backward compatibility. v3.0.0 should standardise on `num`.

---

## Known gaps

| ID | Area | Summary | Target |
|----|------|---------|--------|
| QTE-GAP-001 | Quote status | Convert to PO restricted to Accepted status | ✓ Fixed v2.9.25 |
| TRIAL-001 | Trial conversion | No demo shipment mode — wedge feature not delivered without active BL | CRITICAL — next sprint |
| MTD-001 | Tax compliance | No MTD-compatible export — affects VAT-registered customers | v2.9.x CRITICAL |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates | Backlog |
| SEC-GAP-001 | Security | Code.gs secrets hardcoded in source | ✓ Fixed v2.9.23 (Script Properties) |
| SEC-GAP-002 | GDPR | Sheets sync transmits PII externally | Accepted until first external client |
| SEC-GAP-003 | Security | Anthropic API key in localStorage | Inherent no-server constraint |
| SEC-GAP-004 | Security | Invoice locking is client-side UX only — not tamper-proof | v3.0.0 |
| SEC-GAP-011 | Data integrity | `pullAll()` overwrites local records unconditionally — Sheets wins | Backlog |
| SDLC-GAP-003 | Staging | No same-origin PR preview environment | Post-pilot |
| EVT-GAP-001 | Event log | No warning when 2,000-event cap is hit — oldest silently dropped | Backlog |

---

## Version history (recent)

| Version | Key changes |
|---------|------------|
| v2.9.28 | Global event log (`DB.events`, `K.ev = 'st_ev'`). `logEv()` helper with 2,000-event FIFO cap. Emission: contact created/status_changed/note_added/updated/deleted/converted. Activity accordion in Contact and Supplier modals. Privacy & Data card in Settings. EVT-GAP-001 logged. 227 tests. |
| v2.9.27 | Contacts/Leads entity (`DB.con`). Email dedup, quote integration, GDPR basis, stale flag, Sheets sync. 213 tests. |
| v2.9.26 | AI Compliance Review mode (HMRC VAT 700/21, GDPR, MTD prompts). Phase 1 CSS redesign (border-radius, box-shadow, KPI semantic left-borders, hover refinements). Buyer statement fixes (Total Outstanding, ISO dates, credits negative). 197 tests. |
| v2.9.25 | QTE-GAP-001 fix — Convert to PO restricted to Accepted status. Hard guard in qteToPoConvert(). |
| v2.9.24 | BACKUP-GAP-002 — quota error upgraded to blocking modal with one-click export. |
| v2.9.23 | BACKUP-GAP-001 — JSON backup includes QR rates, custom data, migration flags. DR procedure documented. SEC-GAP-001 closed (Script Properties). |
| v2.9.22 | pullAll() double-fetch eliminated. delEnt respects auto-sync toggle. Sync timestamp stored. |
| v2.9.21 | DATA-GAP-001 — FPM-specific calc corrections extracted to one-time runFPMMigration(). |
| v2.9.20 | expAll() snapshot includes company branding. |
| v2.9.19 | Favicon inline SVG. repairCalcFields strips stray cnAmount from non-CN invoices. |
| v2.9.18 | GDPR disclosure notes in Settings → Google Sheets and Integrations cards. |
| v2.9.17 | Live FX rate source switched to fawazahmed0/currency-api (CORS-enabled, no key). |
| v2.9.16 | CSP meta tag. checkStorageQuota() on init — warns at 75%/90% of 5 MB limit. |
| v2.9.15 | toGBP() — multi-currency KPI aggregation with FX conversion for dashboard. |
| v2.9.14 | Sync URL guard (https:// required). Sync status timestamp. Prompt caching (cache_control: ephemeral). Section index. CLAUDE.md restructure. |
| v2.9.13 | Compliance AI mode first build. XSS san() on PDF builders. vCN() validation rewrite. INV10031 grand total corrected. |
| v2.9.12 | Weighted avg margin. Invoice status locking. Buyer statement + PDF. CN Applied auto-updates calc_balanceDue. Sheets: CN/Quotes tabs. Apps Script update_shipment. STACKD_CONTEXT.md added. |
| v2.9.11 | Dashboard reads calc_ fields as source of truth. CN exclusion from KPIs. repairCalcFields corrected PVC COGS. 157 tests. |
| v2.9.10 | EN/ZH language toggle. Invoice/CN modal separation. Company branding on PDFs. |
| v2.9.9 | Line item dimensions + CBM. Load calculator. Forwarder webhook. Quote feasibility check. |
| v2.9.5 | Accounting export — Xero/QuickBooks/FreeAgent mappers. |
| v2.9.4 | Quote engine. Rate engine. Per-line price versioning. |
| v2.8.1 | Shipments tab. GitHub Actions CI/CD. |

---

## Build queue

**Sprint 1 (12-26 May 2026) — COMPLETE:**

| Version | Focus | Status |
|---------|-------|--------|
| v2.9.12 | Sheets template — CN tab, Quotes tab, invoice num field, all entity sync | ✓ Done |
| v2.9.12 | Weighted average margin in rDash() | ✓ Done |
| v2.9.12 | Apps Script update_shipment handler for Make.com Flow 2 | ✓ Done |

**Sprint 2 (27 May — 9 Jun 2026) — COMPLETE:**

| Version | Focus | Status | FM |
|---------|-------|--------|-----|
| v2.9.13–v2.9.25 | Security fixes, FX conversion, backup/DR, compliance AI mode, Phase 1 redesign, QTE-GAP-001 | ✓ Done (v2.9.26) | various |
| Demo shipment mode | Simulated live tracking, no BL required | NOT DONE — highest priority next | FM-4 CRITICAL |

**Current sprint (June 2026):**

| Item | FM | Priority |
|------|----|---------|
| Demo shipment mode — simulated tracking without BL | FM-4 | CRITICAL — trial conversion blocker |
| MTD-compatible VAT export | FM-5 | CRITICAL — do not defer to v3.x |

**Backlog (v2.9.x):**

| Item | FM | Priority |
|------|----|---------|
| MTD-compatible VAT export | FM-5 | CRITICAL — do not defer to v3.x |
| Audit log export | FM-5 | High |
| GDPR data deletion | FM-5 | High |
| Privacy policy page | FM-5 | High |
| Shipping API — Searates/MarineTraffic | FM-4 | High |
| Payments sync to Sheets | — | Medium |

**v3.0.0 (Q1 2027):**
Supabase backend, multi-tenancy, MFA, RBAC, server-side API proxy, referral mechanics. Prerequisite: freelance data architect engagement Q4 2026.

---

## Active risks

| ID | Risk | Status | Action |
|----|------|--------|--------|
| R-001 | localStorage GDPR exposure | ACTIVE | v3.0.0 resolves — hard deadline Q1 2027 |
| R-003 | Trial conversion 11% — too low | ACTIVE | Demo shipment mode — current sprint |
| R-004 | MTD compliance gap | ACTIVE | Add MTD bridge to v2.9.x — do not defer |
| R-007 | Supplier intelligence empty database | ACTIVE | Manual seeding starts now — 200 data points target |
| R-002 | Alibaba/platform competition | MONITOR | Monthly competitive scan |
| R-005 | Corridor concentration risk | MONITOR | Diversify GTM to UK-West Africa |
| R-006 | AI moat erosion | MONITOR | Prioritise data moat over feature moat |

---

## Current sprint — June 2026

| # | Item | Owner | Status |
|---|------|-------|--------|
| S3-1 | Demo shipment mode — end-to-end demo data seed across all entities | Claude Code | ✓ Done (v2.9.31) |
| S3-2 | MTD-compatible VAT export | Claude Code | To Do |
| S3-3 | ICO registration | You | Backlog |
| S3-4 | Deploy getstackdops.com to Vercel | You | Pending |

---

## China trip — 20-30 May 2026 (COMPLETED)

**Flights:** CZ304/CZ303 LHR ↔ Guangzhou (premium economy)

| Date | Day | Location | Activity |
|------|-----|----------|----------|
| Wed 20 May | Depart | London | CZ304 evening |
| Thu 21 May | Arrive | Guangzhou | Atour Hotel |
| Fri 22 May | Day 1 | Foshan | Hanse factory (Fenghuang 2 Rd, Chancheng) + Lecong market |
| Sat 23 May | Travel | → Qingdao | CAN→TAO 11:40. Romerry Hotel |
| Sun 24 May | Free | Qingdao | Rest + prep |
| Mon 25 May | Bank Holiday | Jinan day trip | Jinbao PVC — HSR ~1h20m each way |
| Tue 26 May | Day 2 | Qingdao + Jinan area | Confirmed supplier. Shandong Create Refrigeration afternoon (Boxing County, 1h45m from Jinan, hard out 16:30) |
| Wed 27 May | Day 3 | Qingdao → Guangzhou | Supplier 2 morning. TAO→CAN 08:10 |
| Thu 28 May | Day 4 | Guangzhou/Dongguan | Dongguan supplier TBC |
| Fri 29 May | Day 5 | Shenzhen | CBMmart (Bagualing Industrial Zone, Futian) morning. Huaqiangbei afternoon |
| Sat 30 May | Depart | → London | HSR Shenzhen→Guangzhou. CZ303 |

**Trip objectives:**
1. Freight forwarder — demo Stackd live, get pilot agreement, leave-behind document
2. China agents — identify 3-5, offer 60-day free Growth tier
3. Supplier meetings — update Stackd notes in real time

**Demo assets ready:**
- Stackd portal v2.9.11 live
- SHP-002 demo shipment in portal (Booked status)
- Make.com Flow 1 + Flow 2 — build before departure
- Forwarder leave-behind document — built
- Make.com setup guide — built

---

## Programme context

**Six failure modes being mitigated:**

| FM | Failure mode | Mitigation |
|----|-------------|-----------|
| FM-1 | Architecture debt | Hard cap at v2.9.x. v3.0.0 in parallel |
| FM-2 | Market corridor concentration | Multi-corridor GTM from day one |
| FM-3 | Supplier intelligence never seeded | Manual data entry after every transaction |
| FM-4 | Trial conversion 11% | Demo shipment mode — current sprint |
| FM-5 | Regulatory blindness | Monthly scan. MTD on v2.9.x not v3.x |
| FM-6 | Agent channel generates awareness not conversion | Fix FM-4 first. Then scale channel |

**Programme documents:**
- `stackd-programme-roadmap.docx` — risk register, sprint structure, GTM roadmap, decision log
- `stackd-product-strategy-v1.0.docx` — ICP, pricing, supplier intelligence, competitive positioning
- `stackd-session-summary.docx` — build log and strategy record
- `stackd-makecom-guide.docx` — Make.com + Google Forms step-by-step
- `stackd-forwarder-leavebehind.docx` — one-page forwarder partnership document

---

## Legal and IP

| Item | Status | Notes |
|------|--------|-------|
| FPM International Ltd | Registered May 2026 | Companies House. SIC 46190 + 62012 |
| STACKD trade mark | Filed May 2026 | UKIPO Classes 35 + 42. £220. 4-6 months to grant |
| EUIPO trade mark | Backlog | Apply after UK grant. £850 |
| ICO registration | Backlog | Required before first external client. £40/year |
| T&Cs + Privacy Policy | Backlog | Before v3.0.0 launch. Budget £500-£1,500 |
| getstackdops.com | Live | Vercel deploy pending |

---

## Pricing

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
| Requirements Tracker | [stored in Apps Script → Script Properties as REQUIREMENTS_TRACKER_ID] |
| Project Tracker | [stored in Apps Script → Script Properties as PROJECT_TRACKER_ID] |

Apps Script write bridge live: actions `update_requirements_tracker` and `update_project_tracker`.

---

## Key contacts

| Contact | Company | Role | Products | Notes |
|---------|---------|------|----------|-------|
| Nora | Shandong Jinbao | Sales | PVC Foam Board | jinbao106@jinbaoplastic.com. Fire cert required each shipment |
| Raisa Wu | Anhui HYY | Sales | Onion Mesh Bags | sale08@ahhyynet.com |
| Eva Zhou | Shanghai Bokni | Sales | Centrifugal Juicers | eva@bokni.com. Verify 220V |
| Michelle Zhou | Zhengzhou Rongchang | Sales | Sugar Cane Juicer | michellezhou@zzrcmm.com. 2nd: Tiffany Qin |
| XC Mach Peter | Xingtai Xingcha | Sales | Pallet Jacks | xingcha_sale003@outlook.com |
| Tina Lin | Fuzhou Bote | Sales | Freezers/Chillers/Cold Storage | sales1@cinsamlex.cn. 30% dep/70% BL. 45 day lead. CE cert |
| Jars Kuang | Zhongshan Chuhui | Sales | Solar LED Floodlights | celux2006@163.com. 2nd: Bruce Wu |
| Nina Cao | Changzhou Intelligent Weighing | Sales | Platform Scales | nina@intelweighing.com. +86 181 1834 8170 |
| Amazon Business | Reolink | Purchase | Security Cameras | amazon.com/business. US tax in COGS. Zero margin |

---

## How to use this file

**For Claude Code:** Read at start of every session. Update at end of every version delivery — bump version, test count, update build queue, add to version history, update known gaps.

**For Claude Projects:** Fetch at start of new conversation thread. Provides instant full context without lengthy re-briefing.

**For new Claude conversations:** Paste this URL into your first message:
`https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`

**Update protocol:**
1. After every version delivery — Claude Code updates version, tests, build queue, known gaps
2. After every strategy session — update sprint status, risk register, decisions
3. After every China trip meeting — update contacts, agent pipeline, trip outcomes
4. Monthly — update regulatory calendar status, competitive scan notes

---

*STACKD · Source · Supply · Ship · FPM International Ltd · getstackdops.com*
*Living document — last updated 17 June 2026*
