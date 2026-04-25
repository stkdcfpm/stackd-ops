# Stackd Ops — System Architecture
**Version:** 1.1.0
**Date:** 2026-04-21
**Author:** FPM International
**Status:** Live — matches stackd-ops-v2.5.3
**Changes from v1.0.0:** Mermaid diagrams added throughout. Component architecture, data flows, save/pull/print/auto-PO sequences all in Mermaid. File inventory updated to v2.5.3. Security posture updated to reflect 2FA confirmed and GDPR filed.

---

## 1. System Overview

Stackd Ops is a single-page web application built as a self-contained HTML file. It operates as a lightweight operations platform for FPM International's procurement intermediary workflow. Operable in 15–60 minute time slots across multiple devices with no installation required.

**Design principles:**
1. Automation first — every manual step is a candidate for automation
2. Auditable and traceable — all state changes logged with timestamp
3. Future-proofed for TradeFlow SaaS — logic and data models documented for developer handoff
4. Designed for scale — sole trader today, team or product tomorrow
5. Seamless integration — minimal friction between tools

---

## 2. Component Architecture

```mermaid
flowchart TD
    subgraph Client["Client Layer — stackd-ops-v2.5.3.html"]
        direction TB
        AUTH["Auth Gate\nPassword hash\nsessionStorage\ninitApp() post-login"]
        UI["UI / Views\nDashboard · Suppliers\nLine Items · Invoices\nPOs · Import · Settings"]
        STATE["State Engine\nlocalStorage\n4 entities + audit + settings"]
        SYNC["Sync Engine\npullAll · pushAll · syncAll\nsyncEnt · delEnt\nIndexed for loops — ES5"]
        DOC["Document Engine\nprevInvDoc · prevPODoc\nNew window · Inline styles\nprint() with 200ms delay"]
        VAL["Validation Engine\nvSup · vLI · vInv · vPO\nEmail · InvNum · HS · Numeric"]
        TIP["Tooltip System\nwireTips · TIPS object\n50 field definitions\nHover and keyboard"]
        IMPORT["Bulk Import\ndlTemplate · bulkUpload\nprocessImport · parseCSV\nStatus normalisation"]
        ACCT["Accounts Tracker\nrenderAccts · setAcctView\nBy invoice · By supplier\nFPM deposit recovery"]
    end

    subgraph GAS["Backend Layer — Apps Script"]
        DOGET["doGet()\nping · get_all"]
        DOPOST["doPost()\nupsert · bulk_upsert · delete"]
        CALC["addCalcFields()\ncalc_* server-side\ninv + po entities"]
        GASAUDIT["writeAudit()\nEvery operation\nAuditLog tab"]
        SETUP["setup()\nCreate sheet tabs\nHeader styling\nRun once manually"]
        TESTDATA["generateTestData()\nbatchWrite()\nclearTestData()\nTEST- prefix"]
    end

    subgraph Sheets["Persistence Layer — Google Sheets"]
        SH_S["Suppliers"]
        SH_L["LineItems"]
        SH_I["Invoices\ncalc_* fields"]
        SH_P["PurchaseOrders\ncalc_* fields"]
        SH_A["AuditLog"]
    end

    AUTH --> UI
    UI --> STATE
    UI --> VAL
    UI --> TIP
    UI --> IMPORT
    UI --> ACCT
    STATE --> SYNC
    DOC --> UI
    SYNC -- "HTTPS POST/GET" --> DOGET
    SYNC -- "HTTPS POST/GET" --> DOPOST
    DOPOST --> CALC
    DOPOST --> GASAUDIT
    CALC --> SH_S
    CALC --> SH_L
    CALC --> SH_I
    CALC --> SH_P
    GASAUDIT --> SH_A
    DOGET --> SH_S
    DOGET --> SH_L
    DOGET --> SH_I
    DOGET --> SH_P
```

---

## 3. Data Flows

### 3.1 Save Operation

```mermaid
sequenceDiagram
    participant U as User
    participant V as Validation
    participant LS as localStorage
    participant UI as UI Render
    participant GAS as Apps Script
    participant SH as Google Sheets

    U->>V: Click Save (supplier/LI/invoice/PO)
    V->>V: Validate required fields, formats, ranges
    alt Validation fails
        V->>U: Toast error, field highlighted red
    else Validation passes
        V->>LS: Write record to localStorage
        LS->>UI: renderAll() — refresh views
        UI->>U: Updated table visible
        LS-->>GAS: Async syncEnt(entity, record)
        GAS->>GAS: addCalcFields() — server-side calc
        GAS->>SH: upsertRecord() — insert or update row
        GAS->>SH: writeAudit() — log to AuditLog
        GAS-->>UI: setSyncStatus('ok') — green dot
    end
```

### 3.2 Pull from Sheets

```mermaid
sequenceDiagram
    participant U as User
    participant APP as App
    participant GAS as Apps Script
    participant SH as Google Sheets
    participant LS as localStorage

    U->>APP: Click Pull (or app loads with pullOnLoad=true)
    loop For each entity: sup, li, inv, po
        APP->>GAS: GET /exec?action=get_all&entity=X
        GAS->>SH: getDataRange().getValues()
        SH-->>GAS: All rows for entity
        GAS-->>APP: JSON array of records
        APP->>APP: Merge pulled records with local\n(pulled wins on ID conflict)
    end
    APP->>LS: saveAll() — write merged state
    APP->>APP: renderAll() — refresh all views
    APP->>U: setSyncStatus('ok') — green dot
```

### 3.3 Invoice → PO Auto-Generation

```mermaid
flowchart TD
    A["User saves new invoice"] --> B["saveInv() called"]
    B --> C{"EI.i === null?\nNew invoice only"}
    C -- No/Edit --> D["Skip auto-generation"]
    C -- Yes/New --> E["autoPos(inv)"]
    E --> F["Group line items by supId\nvia DB.li lookup"]
    F --> G{"Any line items\nwith supplier link?"}
    G -- No --> H["No POs generated\nManual lines only — no supId"]
    G -- Yes --> I["For each unique supplier\ncreate PO record"]
    I --> J["Copy relevant line items\nwith cost from DB.li"]
    J --> K["Link PO to invoice\ninv.pos array updated"]
    K --> L["Push to DB.po\nsaveAll()"]
    L --> M["syncEnt for each PO\nSheets updated"]
    M --> N["Toast: N POs auto-generated"]
```

### 3.4 Print Flow

```mermaid
sequenceDiagram
    participant U as User
    participant APP as App
    participant W as New Window

    U->>APP: Click 👁 on invoice or PO row
    APP->>APP: prevInvId(id) → finds record in DB.inv
    APP->>APP: prevInvDoc(inv) — build full HTML string\nInline styles · No CSS class dependencies
    APP->>W: window.open('', '_blank')
    APP->>W: w.document.write(html)
    APP->>W: w.document.close() · w.focus()
    W->>U: Shows document with black toolbar
    U->>W: Click Print / Save PDF button
    W->>W: setTimeout(print, 200ms)
    W->>U: Browser print dialog
    U->>U: Uncheck Headers and Footers
    U->>U: Save as PDF
    Note over W: @media print hides toolbar\nDocument only in PDF output
```

### 3.5 FPM Deposit Recovery Flow

```mermaid
flowchart TD
    A["User sets invoice status to Paid\nand clicks Save Invoice"] --> B["saveInv() called"]
    B --> C["inv.status === 'Paid'?"]
    C -- No --> D["Normal save — no recovery"]
    C -- Yes --> E["Find all POs where\ninvId or invNum matches"]
    E --> F{"Any PO has\nfpmFunded > 0\nand not yet recovered?"}
    F -- No --> G["Normal save complete"]
    F -- Yes --> H["Set po.fpmRecovered = true\nfor each matching PO"]
    H --> I["syncEnt for each updated PO\nSheets updated"]
    I --> J["sv(K.p, DB.po)\nLocal state saved"]
    J --> K["Toast: FPM-funded deposits\nmarked as recovered ✓"]
    K --> L["Accounts tracker updates\nFPM Funded column shows ✓ Recovered\nTotal to Chase recalculated"]
```

---

## 4. Authentication Flow

```mermaid
flowchart TD
    A["Page loads"] --> B["Auth script runs\n(second script block)"]
    B --> C{"sessionStorage\nhas auth token?"}
    C -- Yes, matches hash --> D["Hide auth gate\nShow app-shell\ninitApp()"]
    C -- No/Invalid --> E["Show full-screen\npassword gate"]
    E --> F["User enters password"]
    F --> G["checkAuth()"]
    G --> H{"simpleHash(input)\n=== AUTH_HASH?"}
    H -- No --> I["Error message\nField cleared\nRed underline 3s"]
    I --> F
    H -- Yes --> J["sessionStorage.setItem\nauth token"]
    J --> K["Hide auth gate\nShow app-shell"]
    K --> L["initApp()\nwireTips()\nLoad settings\npullAll if configured\nrenderAll()"]
```

---

## 5. File Inventory

### Application
| File | Version | Purpose |
|------|---------|---------|
| `index.html` | Always current | Live app served by GitHub Pages |
| `app/stackd-ops-v2.5.3.html` | v2.5.3 | Versioned archive — FPM deposit tracker, accounts tracker, auto-recovery |
| `app/stackd-ops-v2.5.0.html` | v2.5.0 | Tooltips, dial codes, validation |
| `app/stackd-ops-v2.4.5.html` | v2.4.5 | Bulk import, HS codes, pro-forma |
| `app/stackd-ops-v2.3.2.html` | v2.3.2 | Password gate, print fix, GitHub Pages |

### Backend
| File | Version | Purpose |
|------|---------|---------|
| `backend/stackd-appsscript-v2.1.0.gs` | v2.1.0 | Complete Apps Script — CRUD, calc fields, audit log |
| `backend/stackd-testdata-v1.1.0.gs` | v1.1.0 | Test data generator — batchWrite, clearTestData |

### Documentation
| File | Version | Purpose |
|------|---------|---------|
| `docs/stackd-datamodel-v1.1.0.md` | v1.1.0 | Entity definitions, Mermaid ERD, status diagrams |
| `docs/stackd-architecture-v1.1.0.md` | v1.1.0 | This document — Mermaid component and flow diagrams |
| `docs/stackd-datastandards-v1.0.0.md` | v1.0.0 | Data quality rules, validation standards, glossary |
| `docs/stackd-regulatory-v1.0.0.md` | v1.0.0 | Legal and compliance — UK, Barbados, Nigeria, Ghana |
| `docs/stackd-userguide-v1.0.0.md` | v1.0.0 | Layperson operations manual — 8 workflows |
| `docs/stackd-quickref-v1.0.0.md` | v1.0.0 | One-page daily use card |
| `docs/stackd-qa-v1.1.0.md` | v1.1.0 | QA framework — 180+ test cases, full changelog |
| `docs/stackd-assessment-v1.0.2.md` | v1.0.2 | SDLC, data management, security, compliance scores |
| `docs/fpm-gdpr-statement-v1.0.0.md` | v1.0.0 | GDPR lawful basis statement — filed 2026-04-21 |

### Repository Structure
```
stackd-ops/
├── index.html                              ← live version (overwrite on release)
├── README.md
├── app/
│   ├── stackd-ops-v2.3.2.html
│   ├── stackd-ops-v2.4.5.html
│   ├── stackd-ops-v2.5.0.html
│   └── stackd-ops-v2.5.3.html
├── backend/
│   ├── stackd-appsscript-v2.1.0.gs
│   └── stackd-testdata-v1.1.0.gs
└── docs/
    ├── stackd-datamodel-v1.1.0.md
    ├── stackd-architecture-v1.1.0.md
    ├── stackd-datastandards-v1.0.0.md
    ├── stackd-regulatory-v1.0.0.md
    ├── stackd-userguide-v1.0.0.md
    ├── stackd-quickref-v1.0.0.md
    ├── stackd-qa-v1.1.0.md
    ├── stackd-assessment-v1.0.2.md
    └── fpm-gdpr-statement-v1.0.0.md
```

---

## 6. Versioning Convention

```
stackd-[component]-v[MAJOR].[MINOR].[PATCH].[ext]

MAJOR  Breaking rebuild or data model change
MINOR  New feature — backward compatible
PATCH  Bug fix or small change
```

**Commit message convention:**
```
v2.5.3 — FPM deposit tracker, auto-recovery on Paid
docs: datamodel v1.1.0 — Mermaid ERD, status diagrams
fix: net profit calculation for imported invoices
```

---

## 7. Integration Map

```mermaid
flowchart TD
    subgraph FPM["FPM International Operations Stack"]
        STACKD["Stackd Ops\nstackd-ops-v2.5.3\nGitHub Pages"]
        SHEETS["Google Sheets\nPersistent data store\nAuditLog · calc_* fields"]
        NOTION["Notion Workspace\nShipment tracker\nSupplier comms · RFQ"]
        EXCEL["Excel / Google Drive\nMaster order data\nCSV export for import"]
        GITHUB["GitHub\nstkdcfpm/stackd-ops\nVersion control · Docs"]
    end

    STACKD <-- "Apps Script sync\nPull · Push · Audit" --> SHEETS
    EXCEL -- "CSV export\nBulk import" --> STACKD
    STACKD -- "Version archive\nDocumentation" --> GITHUB
    NOTION -- "Manual reference\nShipment context" --> STACKD
```

---

## 8. Performance Characteristics

| Metric | Current value | Notes |
|--------|--------------|-------|
| App load time | ~1–2 seconds | Google Fonts load async |
| Save operation | ~200ms local, 1–3s with sync | Sync is async, non-blocking |
| Pull from Sheets | 2–5 seconds | 4 sequential API calls |
| Push all to Sheets | 3–8 seconds | Depends on record count |
| Max practical records | ~500 per entity | localStorage ~5MB limit |
| Apps Script timeout | 6 minutes | Batch writes well within limit |
| generateTestData() | Under 10 seconds | batchWrite — single read + batch insert |

---

## 9. Security Posture

| Layer | Current (v2.5.3) | Target (v2.6.0) | Target (v3.0.0) |
|-------|-----------------|-----------------|-----------------|
| App access | Simple hash password gate | Apps Script secret token | OAuth2 / JWT |
| Google account | ✅ 2FA enabled | No change | No change |
| Data in transit | HTTPS (GitHub Pages + Google) | No change | No change |
| Data at rest | Google Sheets (Google security) | No change | Encrypt sensitive fields |
| Apps Script URL | Public endpoint — no auth | Secret token validation | Per-user auth |
| Source code | Public GitHub repo | No change | Private repo |
| Sensitive data | Bank details in localStorage plain text | No change | Web Crypto API encryption |
| GDPR | ✅ Lawful basis documented | Data export function | Full GDPR toolkit |
| Session | sessionStorage — tab-scoped | 8-hour timeout | JWT with expiry |
| XSS | No sanitisation on user input | HTML entity encoding | CSP header via Cloudflare |

---

## 10. Disaster Recovery

| Scenario | Recovery |
|----------|----------|
| Browser localStorage cleared | Pull from Sheets — full restore |
| Google Sheet accidentally deleted | Google Drive Trash — 30 day restore window |
| GitHub Pages URL changes | Update bookmark — data unaffected |
| Apps Script deployment broken | Redeploy from `/backend/` source — new URL, update Settings |
| index.html corrupted | Restore from `/app/` versioned archive |
| All Sheets data lost | No automated off-Sheets backup currently — scheduled backup planned v2.6.0 |

---

## 11. Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0.0 | 2026-04-21 | Initial architecture documentation |
| v1.1.0 | 2026-04-21 | Full Mermaid diagram suite added: component architecture, save/pull/print/auto-PO/FPM recovery sequence diagrams, auth flow, integration map. File inventory updated to v2.5.3. Security posture updated: 2FA confirmed, GDPR filed. |
