# STACKD — Project Context
> **Single source of truth for all Claude tools — Projects, Code, and new conversations.**
> Fetch this file at the start of any new session: `https://raw.githubusercontent.com/stkdcfpm/stackd-ops/main/STACKD_CONTEXT.md`
> Updated by Claude Code on every version delivery. Updated by Claude Projects after every strategy session.

---

## Current state

| Field | Value |
|-------|-------|
| Last updated | 16 May 2026 |
| Current version | v2.9.12 |
| Test count | 157 / 157 passing |
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
| Avg Margin | 15.9% | Simple average — change to weighted (21.3%) in backlog |
| Outstanding from Buyers | $17,428 | INV10030 $9,730 + INV10031 $7,248 after CN deductions |
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
- INV10028: PVC-34 unit cost $19.44 (Jan 2026 order). calc_cogs $25,226
- INV10030: balance due $9,730 after CN10030 ($450 freight credit)
- INV10031: balance due $7,048 after CN10031 ($200 freight credit). Status: Sent
- INV10032: pro-forma — pending freight figure from shipping agent. Not yet in portal
- SHP-001 BL: MEDUWA872896. Vessel: MSC Mara. Carrier: MSC

**Google Sheets sync:**
- Auto-sync: ON (re-enabled 13 May 2026 after data stabilisation)
- Apps Script URL: in Stackd Settings → Google Sheets
- Sync token: fpm-stackd-2026
- Tracker write bridge: live on main — actions update_requirements_tracker and update_project_tracker

---

## Architecture

**Current stack (v2.9.x — localStorage):**
```
index.html          — entire application: HTML + CSS + JS in one file
tests/run.js        — Node.js test runner, 157 tests
apps-script/Code.gs — Google Apps Script webhook handler
CLAUDE.md           — Claude Code session context (technical)
STACKD_CONTEXT.md   — Cross-tool master context (this file)
docs/known-gaps.md  — Known gaps log
```

**State layer:**
```javascript
const K = { s:'st_s', l:'st_l', i:'st_i', p:'st_p', pm:'st_pm',
            sh:'st_sh', qt:'st_qt', ss:'st_ss', as:'st_as', au:'st_au' }
let DB = { sup, li, inv, po, payments, sh, qt }
let EI = { s, l, i, p, sh, qt, cn }
let cIL = [], cPL = [], cQL = [], cCNL = []
var QR = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP, fcl40HQ,
           originCharges, destCharges, dgSurcharge, insRate, fpmAdmin }
```

**Hard architectural rule (FM-1 mitigation):**
No new features on localStorage stack after v2.9.x. v3.0.0 Supabase migration begins in parallel — never after. This decision is locked.

**Key field name note:**
Invoice number stored as `num` not `invNum` in current records. Dashboard and calc functions use `x.num||x.invNum` for backward compatibility. v3.0.0 should standardise on `num`.

---

## Known gaps

| ID | Area | Summary | Target |
|----|------|---------|--------|
| QTE-GAP-001 | Quote status | No workflow enforcement — Convert to PO available on any status | Backlog |
| TRIAL-001 | Trial conversion | No demo shipment mode — wedge feature not delivered without active BL | v2.9.13 CRITICAL |
| PRICE-001 | Price versioning | Static catalogue — no price history per SKU | v2.9.14 |
| MTD-001 | Tax compliance | No MTD-compatible export — affects VAT-registered customers | v2.9.x CRITICAL |

---

## Version history (recent)

| Version | Key changes |
|---------|------------|
| v2.9.12 | Weighted avg margin (weighted, not simple). Invoice status locking (Sent/Partially Paid/Paid/Cancelled immutable). Buyer statement view + PDF. CN Applied auto-updates linked invoice calc_balanceDue. Sheets: CN tab, Quotes tab, inv.num field fix. Apps Script update_shipment. STACKD_CONTEXT.md added. |
| v2.9.11 | Dashboard reads calc_ fields as source of truth. CN exclusion from KPIs. repairCalcFields corrected PVC COGS. 157 tests. |
| v2.9.10 | EN/ZH language toggle. Invoice/CN modal separation. Company branding on PDFs (FPM International Ltd). |
| v2.9.9 | Line item dimensions + CBM. Load calculator. Forwarder update request + webhook. Quote feasibility check. |
| v2.9.8 | Credit note PDF fix. CN balance deduction. Goodwill credit. |
| v2.9.7 | Sheets sync guard. Invoice→library refs index. PDF Blob URL fix. |
| v2.9.5 | Accounting export — Xero/QuickBooks/FreeAgent mappers. |
| v2.9.4 | Quote engine. Rate engine. Per-line price versioning. |
| v2.8.1 | Shipments tab. GitHub Actions CI/CD. seedINV10029Payments removed. |

---

## Build queue

**Immediate (Sprint 1 — 12-26 May 2026):**

| Version | Focus | Status |
|---------|-------|--------|
| v2.9.12 | Sheets template — CN tab, Quotes tab, invoice num field, all entity sync | Done |
| v2.9.12 | Weighted average margin in rDash() | Done |
| v2.9.12 | Apps Script update_shipment handler for Make.com Flow 2 | Done |

**Sprint 2 (27 May — 9 Jun 2026):**

| Version | Focus | FM |
|---------|-------|-----|
| v2.9.13 | Demo shipment mode — simulated live tracking, no BL required | FM-4 CRITICAL |
| v2.9.14 | Price versioning — per-SKU history array, invoice override recording | FM-3 |

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
| R-003 | Trial conversion 11% — too low | ACTIVE | v2.9.13 demo shipment mode — Sprint 2 |
| R-004 | MTD compliance gap | ACTIVE | Add MTD bridge to v2.9.x — do not defer |
| R-007 | Supplier intelligence empty database | ACTIVE | Manual seeding starts now — 200 data points target |
| R-002 | Alibaba/platform competition | MONITOR | Monthly competitive scan |
| R-005 | Corridor concentration risk | MONITOR | Diversify GTM to UK-West Africa |
| R-006 | AI moat erosion | MONITOR | Prioritise data moat over feature moat |

---

## Current sprint — Sprint 1 (12-26 May 2026)

Theme: Stabilise and ship before China trip

| # | Item | Owner | Status |
|---|------|-------|--------|
| S1-1 | v2.9.12 — Sheets template + weighted margin | Claude Code | To Do |
| S1-2 | Make.com Flow A — daily standup digest | You | To Do |
| S1-3 | Make.com Flow B — overdue alert | You | To Do |
| S1-4 | Make.com Flow C — regulatory reminder | You | To Do |
| S1-5 | Deploy getstackdops.com to Vercel | You | To Do |
| S1-6 | China trip — freight forwarder pilot agreement | You | In Progress |
| S1-7 | China trip — 3-5 agent conversations | You | In Progress |

---

## China trip — 20-30 May 2026

**Trip objectives:**
1. Freight forwarder — demo Stackd live, get pilot agreement, leave-behind document
2. China agents — identify 3-5, offer 60-day free Growth tier
3. Supplier meetings — update Stackd notes in real time

**Flights (BOOKED):**
- CZ304: Wed 20 May, 22:10 LHR → Thu 21 May 16:55 CAN (Premium Economy)
- CZ303: Sat 30 May, 13:40 CAN → 19:20 LHR (Premium Economy)

**Domestic flights (TO BOOK):**
- CAN→TAO: Sat 23 May, 11:40 departure (NOT early morning)
- TAO→CAN: Wed 27 May, 08:10 departure (early morning)

**Hotels (8 nights total):**

| Hotel | Nights | Dates | Cost | Status |
|-------|--------|-------|------|--------|
| Guangzhou Atour Hotel | 3 | Thu 21, Fri 22, Wed 27 | £135 (£45/night) | TO BOOK |
| Romerry Hotel Qingdao | 4 | Sat 23–Tue 26 | £152 (£38/night) | TO BOOK |
| Shenzhen (TBC) | 1 | Fri 29 | £50 | TO BOOK |

**Itinerary:**

| Date | Day | Location | Activity | Accommodation |
|------|-----|----------|----------|---------------|
| Wed 20 May | 0 | London → GZ | CZ304 22:10 departure | On flight |
| Thu 21 May | 1 | Guangzhou | Arrive 16:55, rest, jet lag recovery | Atour Hotel (1) |
| Fri 22 May | 2 | Foshan | Hanse factory (Fenghuang 2 Rd, Chancheng) + Lecong market | Atour Hotel (2) |
| Sat 23 May | 3 | → Qingdao | CAN→TAO 11:40, arrive afternoon | Romerry Hotel (1) |
| Sun 24 May | 4 | Qingdao | Rest + prep | Romerry Hotel (2) |
| Mon 25 May | 5 | Jinan day trip | Jinbao PVC (Nora) — HSR round-trip ~1h20m each way | Romerry Hotel (3) |
| Tue 26 May | 6 | Qingdao + Boxing | Confirmed supplier (AM) + Shandong Create (PM, Boxing County, 1h45m from Jinan, hard out 16:30) ⚠️ | Romerry Hotel (4) |
| Wed 27 May | 7 | → Guangzhou | Supplier 2 (AM) + TAO→CAN 08:10 | Atour Hotel (3) |
| Thu 28 May | 8 | Dongguan | Supplier TBC | Shenzhen area |
| Fri 29 May | 9 | Shenzhen | CBMmart (Bagualing Industrial Zone, Futian) AM + Huaqiangbei PM | Shenzhen hotel (1) |
| Sat 30 May | 10 | → London | HSR Shenzhen→Guangzhou, CZ303 13:40 | Home in Brighton |

**Confirmed suppliers:**

| Supplier | Contact | Location | Meeting | Notes |
|----------|---------|----------|---------|-------|
| Hanse factory | TBC | Fenghuang 2 Rd, Chancheng District, Foshan | Fri 22 May | Lecong market same day |
| Shandong Jinbao | Nora (jinbao106@jinbaoplastic.com) | Jinan | Mon 25 May | PVC Foam Board. Fire cert each shipment. HSR day trip from Qingdao |
| Confirmed supplier | TBC | Qingdao | Tue 26 May AM | Name not yet specified |
| Shandong Create Refrigeration | TBC | Boxing County (via Jinan) | Tue 26 May PM | Hard out 16:30. 1h45m from Jinan |
| Supplier 2 | TBC | Qingdao | Wed 27 May AM | Before 08:10 flight |
| Dongguan supplier | TBC | Dongguan | Thu 28 May | Status: TBC |
| CBMmart | TBC | Bagualing Industrial Zone, Futian, Shenzhen | Fri 29 May AM | — |

**HSR bookings needed** (book Sat 26 Apr when 30-day window opens):
- Mon 25 May: Qingdao ↔ Jinan return (£16)
- Sat 30 May: Shenzhen → Guangzhou (£8, don't pre-book — trains every 10 min)

**⚠️ Critical issue — Tue 26 May routing:**

Context file states both: (a) Qingdao confirmed supplier morning, (b) Shandong Create afternoon in Boxing County.

Problem: Boxing County is 280km from Qingdao (not near). It's 1h45m from Jinan.

Possible solutions:
- **Option A:** Very early Qingdao supplier (06:00–09:00) → HSR to Jinan 10:00 → Taxi to Boxing 12:00–14:00 → Meeting 14:00–16:30
- **Option B:** Move Qingdao supplier to Wed morning slot, use Tue for Jinan → Boxing only
- **Option C:** Skip Boxing supplier (not recommended — already confirmed)

**Action required:** Confirm supplier meeting times and resolve Tue 26 logistics before booking HSR.

**Pre-departure checklist:**

| Date | Action | Status |
|------|--------|--------|
| Week of 23–29 Mar | Book all 3 hotels | TO DO |
| Tue 24 Mar @ 3pm | Book domestic flights (CAN→TAO 11:40, TAO→CAN 08:10) | TO DO |
| Sat 26 Apr | Book HSR tickets (30-day window) | TO DO |
| Early Apr | Order 100 bilingual business cards | TO DO |
| Early Apr | Get £100–150 CNY cash (¥800–1,200) | TO DO |
| Sun 18 May | VPN setup (ExpressVPN) — CRITICAL, cannot do in China | TO DO |
| Mon 19 May | eSIM install (Saily) — 5GB, 10 days, £11 | TO DO |
| Mon 19 May | Download all apps + offline maps | TO DO |
| Mon 19 May | Final pack | TO DO |

Apps to download in UK before departure: WeChat, Baidu Maps (offline maps for all 6 cities), Alipay, Didi, Trip.com, Pleco, Google Translate (Chinese offline pack 800MB)

**Demo assets ready for freight forwarder meetings:**
- Stackd portal v2.9.12 live at stkdcfpm.github.io/stackd-ops
- SHP-002 demo shipment in portal (Booked status)
- Make.com flows (build before departure)
- Forwarder leave-behind document (built)

**Documents created (19 May 2026):** China_Trip_Full_With_Prices.docx, China_Trip_Cost_Scale.docx, China_Trip_Quick_Summary.docx, Qingdao_Guide.docx, Everything_Else_You_Need.docx, What_You_Need_To_Do.docx

---

## Programme context

**Six failure modes being mitigated:**

| FM | Failure mode | Mitigation |
|----|-------------|-----------|
| FM-1 | Architecture debt | Hard cap at v2.9.x. v3.0.0 in parallel |
| FM-2 | Market corridor concentration | Multi-corridor GTM from day one |
| FM-3 | Supplier intelligence never seeded | Manual data entry after every transaction |
| FM-4 | Trial conversion 11% | v2.9.13 demo shipment mode — Sprint 2 |
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
| Requirements Tracker | 1q05sSoCMmiqaNNixDWVk2_aJPwEqx37vDbOPNh2gqGw |
| Project Tracker | 1gC6d7ClOFpaocK_lNI685x5yMK5_UHiMgriFlF_UrLg |

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
*Living document — last updated 16 May 2026*
