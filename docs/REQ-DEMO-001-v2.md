# REQ-DEMO-001 v2 — End-to-End Demo Mode

**Status:** Awaiting gate PASS  
**FM-1:** Exception item 2 — new `_demo` field on existing entities, no new entity or K key.  
**Version target:** v2.9.31
**Supersedes:** REQ-DEMO-001-v1.md

---

## Business need

Trial conversion is 11% (R-003). When demoing Stackd to prospects and forwarders, the portal shows real FPM data with no active in-transit shipment, no quotes, no visible AI actions, and no readable event log. Prospects cannot see the product working end-to-end. A one-click demo dataset injection that showcases every major module — shipment tracking, event log, AI automation, quote-to-PO flow, data quality — is required to close the conversion gap.

---

## Behaviour

### 1. Demo flag

All demo-seeded records carry `_demo: true` on the record object. This field applies to records in: `DB.sup`, `DB.con`, `DB.qt`, `DB.po`, `DB.inv`, `DB.sh`, `DB.payments`. Event log entries seeded by demo carry `_demo: true` on `DB.events` records.

### 2. Demo data scenario

One end-to-end trade transaction seeded across all entities. All reference numbers use the `D`-prefix convention (`DQ-`, `DPO-`, `DINV-`, `DSHP-`) — operators must not create real records using these prefixes, as they are reserved for demo data.

**Supplier** — `{ id: 'demo-sup-001', name: 'Romerry International', country: 'China', cur: 'CNY', ct: 'Li Wei', email: 'sales@romerry-qd.example', _demo: true }`

**Contact** — `{ id: 'demo-con-001', name: 'Thomas Bergmann', email: 'thomas.bergmann@apex-coldchain.example', phone: '+49 30 0000 0000', company: 'Apex Cold Chain GmbH', status: 'converted', source: 'chat', gdprBasis: 'legitimate_interests', _demo: true, createdAt: <30 days before today>, lastContactedAt: <14 days before today>, enquiries: [], notes: 'Demo contact — Apex Cold Chain Berlin buyer' }`

Two activity events for the contact:
- `{ id: uid(), ts: <30 days before today>, entityType: 'contact', entityId: 'demo-con-001', verb: 'created', summary: 'Contact created', actor: 'system', _demo: true }`
- `{ id: uid(), ts: <14 days before today>, entityType: 'contact', entityId: 'demo-con-001', verb: 'converted', summary: 'Quote DQ-0001 created — contact converted', actor: 'system', _demo: true }`

**Quote** — `{ id: 'demo-qt-001', num: 'DQ-0001', client: 'Apex Cold Chain GmbH', dt: <28 days before today>, validUntil: <today + 7 days>, status: 'Converted', freightMode: 'FCL 40HQ', markup: 18, currency: 'USD', notes: 'Demo quote — vertical display freezers', sourceContactId: 'demo-con-001', _demo: true, lines: [{ rid: 'demo-ql-001', lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', uom: 'pcs', qty: 20, cost: 1450, dutyPct: 3.5, hsCode: '8418.50', priceHistory: [{ v: 1, ts: <28 days before today ISO>, cost: 1450, dutyPct: 3.5, markup: 18, landed: 1634.25, sellPrice: 1928.42, note: 'Initial quote' }] }] }`

Note: Quote line `priceHistory` uses fixed seed values (not live `QR` rates) — this is intentional. The demo quote represents a point-in-time price and will not recalculate on QR rate changes unless the operator edits and saves it.

**Purchase Order** — `{ id: 'demo-po-001', num: 'DPO-0001', supId: 'demo-sup-001', cur: 'CNY', status: 'Confirmed', date: <28 days before today>, del: '45 days from PO date', dep: 28000, oth: 0, notes: 'Demo PO — Romerry refrigeration units', lineItems: [{ rid: 'demo-pl-001', lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', uom: 'pcs', qty: 20, cost: 9875 }], _demo: true }`

**Invoice** — `{ id: 'demo-inv-001', num: 'DINV-0001', buyer: 'Apex Cold Chain GmbH', dst: 'Hamburg, Germany', status: 'Partially Paid', type: 'invoice', cur: 'USD', date: <21 days before today>, dep: 15600, lineItems: [{ lid: '', desc: 'Vertical Display Freezer VF-75L', sku: 'VF-75L', qty: 20, price: 1928.42, cost: 1450, uom: 'pcs', hs: '8418.50', duty: 3.5 }], notes: 'Demo invoice', _demo: true }`

**Payment** — `{ id: 'demo-pm-001', invId: 'demo-inv-001', invNum: 'DINV-0001', date: <21 days before today>, amount: 15600, method: 'Bank Transfer', reference: 'DEMO-DEP-001', notes: 'Demo deposit payment', type: 'buyer_payment', creAt: <21 days before today ISO>, _demo: true }`

**Shipment** — `{ id: 'demo-sh-001', ref: 'DSHP-0001', blNum: 'MSCD0001234', vessel: 'MSC Altair', carrier: 'MSC', originPort: 'CNQAO', destPort: 'DEHAM', etd: <14 days before today>, eta: <28 days from today>, containerType: '40HQ', containerNum: 'MSCU1234567', dg: false, docsStatus: 'Complete', status: 'In Transit', linkedInvs: ['DINV-0001'], forwarder: 'Kuehne+Nagel', forwarderEmail: 'ops@kn-demo.example', notes: 'Demo shipment — Apex Cold Chain refrigeration units', _demo: true }`

### 3. `loadDemoData()`

Seeds the scenario above. **Idempotency check:** scans `DB.sup`, `DB.con`, `DB.qt`, `DB.po`, `DB.inv`, `DB.sh`, `DB.payments`, and `DB.events` — if any record with `_demo === true` exists in any of these arrays, toasts `"Demo data already loaded"` and returns without seeding. Manually-created records with `_demo: true` (e.g. from an import) will also trigger this guard — this is intentional.

On success: pushes all seeded records to their respective `DB` arrays, calls `saveAll()`, calls `renderAll()`, toasts `"Demo data loaded — 6 entity records + 1 payment + 2 events seeded"`.

### 4. `clearDemoData()`

Requires `confirm('Clear all demo data? This cannot be undone.')`. On cancel: no action. On confirm: filters out all records where `x._demo === true` from `DB.sup`, `DB.con`, `DB.qt`, `DB.po`, `DB.inv`, `DB.sh`, `DB.payments`, and `DB.events` (using `e._demo === true` for events). Calls `saveAll()`. Calls `renderAll()`. Toasts `"Demo data cleared"`.

### 5. Demo badge

In every entity list table, records with `_demo === true` render a `[DEMO]` badge inline with the primary identifier cell. Badge HTML: `<span style="background:#7c3aed;color:white;font-size:.4rem;padding:1px 5px;border-radius:2px;margin-left:4px;">DEMO</span>`. Applied in these six render functions, on the specified cell:

- `rShp()` — ref cell (`s.ref`)
- `rCon()` — name cell (`c.name`)
- `rQte()` — quote number cell (`q.num`)
- `rPO()` — PO number cell (`po.num` or equivalent)
- `rInv()` — invoice number cell (`inv.num`)
- `rSup()` — supplier name cell (`s.name`)

### 6. KPI exclusion — blanket rule

**All aggregations in `rDash()` filter out records where `_demo === true` before reducing.** Specifically:

- `ai` (active invoices array) — add `&& !i._demo` to the filter
- `tBuyerDep` — derived from `ai` (already excluded by `ai` filter)
- `tGoodwillCredits` — add `&& !i._demo` to its filter
- `tPO` — add `&& !p._demo` to the PO filter
- `tSupDep` — derived from PO filter (already excluded)
- `netCash` — derived from above (already excluded)
- `inTransit` — add `&& !s._demo` to the shipment filter

**Pipeline list:** `DB.inv.slice().reverse().slice(0,10)` — add a `[DEMO]` badge on the `pref` span of demo invoices (same badge style as §5). Demo invoices are not excluded from the pipeline list — they appear with a badge so the operator can see and showcase them.

**Dashboard notice banner:** When any `DB.inv`, `DB.sh`, or `DB.po` record has `_demo === true`, render a yellow notice banner above the KPI grid:

```html
<div style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;padding:8px 12px;font-size:.52rem;border-radius:3px;margin-bottom:10px;">
  &#9888; Demo data active — financial KPIs exclude demo records.
  <button onclick="clearDemoData()" style="margin-left:8px;font-size:.48rem;padding:1px 6px;cursor:pointer;">Clear Demo Data</button>
</div>
```

If no demo records exist, no banner is rendered.

### 7. Settings UI

A new "Demo Mode" card in Settings (after the Privacy & Data card). Contains:
- Heading: `Demo Mode`
- Description: `"Load a complete end-to-end demo scenario — supplier, contact, quote, PO, invoice, payment, and in-transit shipment — to showcase Stackd to prospects. Demo records are excluded from financial KPIs."`
- `[Load Demo Data]` button → `loadDemoData()`
- `[Clear Demo Data]` button → `clearDemoData()`

### 8. `expAll()` and `doImport()`

No change required. Demo records export and import normally with their `_demo` flag intact.

### 9. GDPR

All contact data is fictional (`thomas.bergmann@apex-coldchain.example` — `.example` TLD per RFC 2606 cannot resolve to a real person). No real PII is stored. No new GDPR basis required.

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `_demo` records in any DB array | `loadDemoData()` called | 6 entity records + 1 payment + 2 events seeded; `saveAll()` and `renderAll()` called; toast `"Demo data loaded — 6 entity records + 1 payment + 2 events seeded"` |
| AC-2 | At least one `_demo` record already present | `loadDemoData()` called | No records added; toast `"Demo data already loaded"` |
| AC-3 | Demo data loaded | `rShp()`, `rCon()`, `rQte()`, `rPO()`, `rInv()`, `rSup()` each rendered | `[DEMO]` badge visible on the demo record in each of the six list tables |
| AC-4 | Demo data loaded | `rDash()` rendered | Demo invoice excluded from revenue/outstanding/netCash; demo PO excluded from PO balance; demo shipment excluded from in-transit count; yellow notice banner shown above KPIs |
| AC-5 | Demo data loaded | Pipeline list rendered | DINV-0001 appears in pipeline list with `[DEMO]` badge |
| AC-6 | Demo data loaded | `clearDemoData()` confirm OK | All `_demo` records removed from all 8 arrays; `saveAll()` and `renderAll()` called; toast `"Demo data cleared"`; notice banner gone |
| AC-7 | Demo data loaded | `clearDemoData()` confirm cancelled | No records removed |
| AC-8 | Demo shipment seeded | Shipment list viewed | DSHP-0001 shows status `In Transit`, route `CNQAO → DEHAM`, vessel `MSC Altair` |
| AC-9 | Demo contact seeded | Contact modal opened, Activity section toggled | 2 events shown: `created` and `converted`, newest first |
| AC-10 | Demo data loaded | Settings Demo card viewed | Both Load and Clear buttons present |
