# REQ-DEMO-001 v1 — End-to-End Demo Mode

**Status:** Awaiting gate PASS  
**FM-1:** Exception item 2 — new `_demo` field on existing entities, no new entity or K key.  
**Version target:** v2.9.31

---

## Business need

Trial conversion is 11% (R-003). When demoing Stackd to prospects and forwarders, the portal shows real FPM data with no active in-transit shipment, no quotes, no visible AI actions, and no readable event log. Prospects cannot see the product working end-to-end. A one-click demo dataset injection that showcases every major module — shipment tracking, event log, AI automation, quote-to-PO flow, data quality — is required to close the conversion gap.

---

## Behaviour

### 1. Demo flag

All demo-seeded records carry `_demo: true` on the record object. This field is present on: `DB.sup`, `DB.con`, `DB.qt`, `DB.po`, `DB.inv`, `DB.sh`. Event log entries seeded by demo carry `_demo: true` on `DB.events` records.

### 2. Demo data scenario

One end-to-end trade transaction seeded across all entities:

**Supplier** — Romerry International, Qingdao, China (CNY). `_demo: true`.

**Contact** — "Thomas Bergmann", buyer at Apex Cold Chain GmbH (Berlin). Status: `converted`. Source: `chat`. `_demo: true`. Two activity events: `created` (actor: system) and `converted` (actor: system, summary: `'Quote DQ-0001 created — contact converted'`).

**Quote** — `DQ-0001`. Client: "Apex Cold Chain GmbH". Freight mode: `FCL 40HQ`. Currency: `USD`. Status: `Converted`. One line item: 20× Vertical Display Freezer VF-75L, cost $1,450, duty 3.5%, HSCode `8418.50`. `_demo: true`.

**Purchase Order** — `DPO-0001`. Supplier: Romerry International. Currency: `CNY`. Status: `Confirmed`. One line item matching the quote. Deposit paid: ¥28,000. `_demo: true`.

**Invoice** — `DINV-0001`. Status: `Partially Paid`. Grand total $31,200 USD. One payment recorded ($15,600 deposit). `_demo: true`.

**Shipment** — `DSHP-0001`. Status: `In Transit`. Origin port: `CNQAO` (Qingdao). Destination port: `DEHAM` (Hamburg). Vessel: `MSC Altair`. Carrier: `MSC`. BL: `MSCD0001234`. ETD: 14 days before today's date. ETA: 28 days from today's date. Container type: `40HQ`. DG: false. Docs status: `Complete`. Notes: `"Demo shipment — Apex Cold Chain refrigeration units"`. `_demo: true`.

### 3. `loadDemoData()`

A function that seeds the scenario above. It is **idempotent** — if any record with `_demo: true` already exists in any entity array, the function toasts `"Demo data already loaded"` and returns without seeding. On success: seeds all records, persists via `saveAll()`, re-renders all views via `renderAll()`, toasts `"Demo data loaded — 6 records seeded across all modules"`.

### 4. `clearDemoData()`

Removes all records where `x._demo === true` from `DB.sup`, `DB.con`, `DB.qt`, `DB.po`, `DB.inv`, `DB.sh`. Removes all `DB.events` entries where `e._demo === true`. Persists via `saveAll()`. Re-renders all views via `renderAll()`. Toasts `"Demo data cleared"`. Requires `confirm()` before proceeding.

### 5. Demo badge

In every entity list table, records with `_demo === true` render a `[DEMO]` badge inline with the primary identifier cell (ref, name, number). Badge style: `background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;`. Applied in: `rShp()`, `rCon()`, `rQte()`, `rPO()`, `rInv()`, `rSup()`.

### 6. KPI exclusion

Dashboard KPIs (`rDash()`) exclude records where `_demo === true` from all financial calculations. Specifically: invoice revenue, net profit, outstanding, net cash position, PO balance due, in-transit count. The dashboard shows a yellow notice banner when demo data is loaded: `"Demo data active — financial KPIs exclude demo records. Clear demo data in Settings."`.

### 7. Settings UI

A new "Demo Mode" card in Settings (after the Privacy & Data card). Contains:
- Descriptive text: `"Load a complete end-to-end demo scenario — supplier, contact, quote, PO, invoice, and in-transit shipment — to showcase Stackd to prospects."`
- `[Load Demo Data]` button → calls `loadDemoData()`
- `[Clear Demo Data]` button → calls `clearDemoData()` (confirm required)

### 8. `expAll()` and `doImport()`

No change required. Demo records export and import normally with their `_demo` flag intact. This is correct behaviour — a demo export can be shared as a full sample dataset.

### 9. GDPR

Demo records contain no real personal data (contact name is fictional, email is `thomas.bergmann@apex-coldchain.example`). No GDPR basis required for demo data. `_demo` field itself contains no personal data.

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Empty portal (or no existing demo records) | `loadDemoData()` called | 6 entity records + 2 event entries seeded; `saveAll()` called; all views re-rendered; toast shown |
| AC-2 | Demo data already present | `loadDemoData()` called again | No duplicate records created; toast `"Demo data already loaded"` |
| AC-3 | Demo data loaded | Any entity list viewed | `[DEMO]` badge visible on demo records |
| AC-4 | Demo data loaded | Dashboard KPIs rendered | Demo invoice/shipment excluded from revenue, outstanding, in-transit count; yellow notice banner shown |
| AC-5 | Demo data loaded | `clearDemoData()` called (confirm OK) | All `_demo` records removed from all entity arrays and events; `saveAll()` called; views re-rendered |
| AC-6 | Demo data loaded | `clearDemoData()` confirm cancelled | No records removed |
| AC-7 | Demo shipment seeded | Shipment list viewed | DSHP-0001 shows status `In Transit`, route CNQAO→DEHAM, vessel MSC Altair |
| AC-8 | Demo contact seeded | Contact modal opened, Activity section toggled | 2 activity events shown: `created` and `converted` |
| AC-9 | Demo data loaded | `expAll()` called | Exported JSON includes demo records with `_demo: true` |
| AC-10 | Demo scenario loaded | Settings Demo card visible | Both Load and Clear buttons present |
