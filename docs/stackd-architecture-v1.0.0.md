# Stackd Ops — System Architecture
**Version:** 1.0.0
**Date:** 2026-04-21
**Author:** FPM International
**Status:** Live — matches stackd-ops-v2.3.2.html

---

## 1. System Overview

Stackd Ops is a single-page web application built as a self-contained HTML file. It operates as a lightweight operations platform for FPM International's procurement intermediary workflow. The system is designed to be operable in 15–60 minute time slots across multiple devices with no installation required.

**Design principles (non-negotiable):**
1. Automation first — every manual step is a candidate for automation
2. Auditable and traceable — all state changes logged with timestamp
3. Future-proofed for TradeFlow SaaS — logic and data models documented for developer handoff
4. Designed for scale — sole trader today, team or product tomorrow
5. Seamless integration — minimal friction between tools in the workflow

---

## 2. Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                    │
│  stackd-ops-v2.3.2.html                                         │
│  Hosted: GitHub Pages (https://stkdcfpm.github.io/stackd-ops/) │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Auth Gate     │  │ UI / Views   │  │ Document Engine      │  │
│  │ Password hash │  │ Dashboard    │  │ prevInvDoc()         │  │
│  │ sessionStorage│  │ Suppliers    │  │ prevPODoc()          │  │
│  └──────────────┘  │ Line Items   │  │ Opens new window     │  │
│                    │ Invoices     │  │ Self-contained HTML   │  │
│  ┌──────────────┐  │ POs          │  │ Print via browser    │  │
│  │ State / DB   │  │ Settings     │  └──────────────────────┘  │
│  │ localStorage │  └──────────────┘                            │
│  │ 4 entities   │                                              │
│  │ Audit log    │  ┌──────────────────────────────────────┐   │
│  └──────────────┘  │ Sync Engine                          │   │
│                    │ pullAll() / pushAll() / syncAll()    │   │
│                    │ syncEnt() / delEnt()                 │   │
│                    │ Indexed for loops (no for...of)      │   │
│                    └──────────────────────────────────────┘   │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ HTTPS
                                  │ POST: upsert, bulk_upsert, delete
                                  │ GET:  get_all, ping
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  BACKEND LAYER                                                   │
│  stackd-appsscript-v2.1.0.gs                                    │
│  Hosted: Google Apps Script (Web App deployment)                │
│                                                                  │
│  doGet()  ── ping, get_all                                      │
│  doPost() ── upsert, bulk_upsert, delete                        │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Entity      │  │ Calc Engine  │  │ Audit Writer         │  │
│  │ Router      │  │ addCalcFields│  │ writeAudit()         │  │
│  │ getSheet()  │  │ inv, po      │  │ Every operation      │  │
│  └─────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  PERSISTENCE LAYER                                               │
│  Google Sheets                                                   │
│                                                                  │
│  Tab: Suppliers        │  Tab: LineItems                        │
│  Tab: Invoices         │  Tab: PurchaseOrders                   │
│  Tab: AuditLog         │                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow

### 3.1 Save Operation (online)
```
User fills form → saveInv() / saveSup() / saveLI() / savePO()
  → Write to localStorage (immediate, offline-safe)
  → Update UI (renderAll)
  → Async: syncEnt(entity, record)
      → POST to Apps Script
          → addCalcFields() — server-side calculation
          → upsertRecord() — find existing row or append
          → applyStatusColor() — colour-code by status
          → writeAudit() — log to AuditLog tab
      → setSyncStatus('ok') — green dot in nav
```

### 3.2 Pull Operation (load from Sheets)
```
User clicks Pull (or app loads with pullOnLoad=true)
  → GET /exec?action=get_all&entity=sup
  → GET /exec?action=get_all&entity=li
  → GET /exec?action=get_all&entity=inv
  → GET /exec?action=get_all&entity=po
  → Each response: merge pulled records with local
    (pulled records win on ID conflict)
  → saveAll() — write merged state to localStorage
  → renderAll() — refresh all views
```

### 3.3 Invoice → PO Auto-Generation
```
saveInv() — new invoice only (not edits)
  → autoPos(inv)
      → Group invoice line items by supId
      → For each unique supplier:
          → Create PO record
          → Copy relevant line items (with cost from DB.li)
          → Link PO back to invoice (inv.pos array)
          → Push to DB.po
      → saveAll()
      → syncEnt for each PO
      → Toast: "N POs auto-generated"
```

### 3.4 Print Flow
```
User clicks 👁 on invoice row
  → prevInvId(id) → finds invoice in DB.inv
  → prevInvDoc(inv)
      → Build full HTML string with inline styles
      → window.open('', '_blank')
      → w.document.write(html)
      → w.document.close()
      → w.focus()
      → New window: user clicks Print / Save PDF
          → setTimeout(function(){print();}, 200)
          → Browser print dialog
          → Uncheck Headers and Footers → Save as PDF
```

---

## 4. Authentication

**Current implementation (v2.3.2):**
Simple client-side password gate using a hash comparison stored in `sessionStorage`. Prevents casual access. Not cryptographically secure.

```
Page load
  → Check sessionStorage for auth token
  → If present and matches hash: show app
  → If not: show full-screen password prompt
      → User enters password
      → simpleHash(input) compared to AUTH_HASH
      → Match: set sessionStorage, show app
      → No match: clear input, show error
```

**Planned (v3.0.0 / TradeFlow):**
OAuth2 with Google Sign-In or Cloudflare Access in front of GitHub Pages. Per-user session management. Role-based access control.

---

## 5. File Inventory

### Application
| File | Version | Purpose |
|------|---------|---------|
| `index.html` | Always current | Live app served by GitHub Pages |
| `stackd-ops-v2.3.2.html` | v2.3.2 | Versioned archive — password gate, print fix, version control |

### Backend
| File | Version | Purpose |
|------|---------|---------|
| `stackd-appsscript-v2.1.0.gs` | v2.1.0 | Complete Apps Script — CRUD, calc fields, audit log |
| `stackd-testdata-v1.1.0.gs` | v1.1.0 | Test data generator — batch write, clearTestData |

### Documentation
| File | Version | Purpose |
|------|---------|---------|
| `stackd-datamodel-v1.0.0.md` | v1.0.0 | Entity definitions, field glossary, relationships |
| `stackd-architecture-v1.0.0.md` | v1.0.0 | This document |
| `stackd-datastandards-v1.0.0.md` | v1.0.0 | Data quality rules, validation standards |
| `stackd-regulatory-v1.0.0.md` | v1.0.0 | Legal and compliance considerations |
| `stackd-userguide-v1.0.0.md` | v1.0.0 | Layperson operations manual |
| `stackd-quickref-v1.0.0.md` | v1.0.0 | One-page daily use cheat sheet |
| `stackd-qa-v1.0.0.md` | v1.0.0 | QA framework, test checklist, changelog |

### Repository Structure
```
stackd-ops/ (GitHub)
├── index.html                          ← live version (always overwrite)
├── README.md
├── app/
│   └── stackd-ops-v2.3.2.html         ← versioned archive
├── backend/
│   ├── stackd-appsscript-v2.1.0.gs
│   └── stackd-testdata-v1.1.0.gs
└── docs/
    ├── stackd-datamodel-v1.0.0.md
    ├── stackd-architecture-v1.0.0.md
    ├── stackd-datastandards-v1.0.0.md
    ├── stackd-regulatory-v1.0.0.md
    ├── stackd-userguide-v1.0.0.md
    ├── stackd-quickref-v1.0.0.md
    └── stackd-qa-v1.0.0.md
```

---

## 6. Versioning Convention

```
stackd-[component]-v[MAJOR].[MINOR].[PATCH].[ext]

MAJOR  Significant rebuild or breaking data model change
MINOR  New feature added, backward compatible
PATCH  Bug fix or small change

Examples:
  stackd-ops-v2.3.2.html      Current live app
  stackd-ops-v2.4.0.html      Next feature release
  stackd-ops-v3.0.0.html      TradeFlow migration
```

**Commit message convention:**
```
v[version] — [description]

Examples:
  v2.3.2 — password gate, print fix, version control
  v2.4.0 — data validation, invoice number auto-increment
  v2.3.3 — fix PO deposit calculation edge case
```

---

## 7. Integration Map

```
┌──────────────────────────────────────────────────────────────┐
│                    FPM INTERNATIONAL                         │
│                    OPERATIONS STACK                          │
└──────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
  ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
  │ Stackd Ops  │    │ Google Sheets│    │ Notion Workspace │
  │ (this app)  │◄──►│ (data store) │    │ (ops hub)        │
  │             │    │              │    │                  │
  │ Invoices    │    │ Suppliers    │    │ Shipment tracker │
  │ POs         │    │ LineItems    │    │ Supplier comms   │
  │ Suppliers   │    │ Invoices     │    │ RFQ tracking     │
  │ Line Items  │    │ POs          │    │                  │
  └─────────────┘    │ AuditLog     │    └──────────────────┘
                     └──────────────┘
         │
         ▼
  ┌─────────────┐    ┌──────────────┐
  │ FPM Order   │    │ GitHub       │
  │ Sheet       │    │ (code repo + │
  │ (CSV export │    │  version     │
  │  → import)  │    │  history)    │
  └─────────────┘    └──────────────┘
```

**Planned integrations (TradeFlow roadmap):**
- WhatsApp Business API — supplier communication log
- PICC / cargo insurance portal — shipment insurance tracking
- MSC / freight forwarder APIs — live shipment status
- Xero or Wave — accounting system sync for invoices

---

## 8. Performance Characteristics

| Metric | Current value | Notes |
|--------|--------------|-------|
| App load time | ~1-2 seconds | Google Fonts load async |
| Save operation | ~200ms local, 1-3s with sync | Sync is async, non-blocking |
| Pull from Sheets | 2-5 seconds | 4 sequential API calls |
| Push all to Sheets | 3-8 seconds | Depends on record count |
| Max practical records | ~500 per entity | localStorage limit ~5MB |
| Apps Script timeout | 6 minutes | Batch writes stay well within |

---

## 9. Security Posture

| Layer | Current | Planned |
|-------|---------|---------|
| App access | Simple hash password gate | Cloudflare Access + Google OAuth |
| Data in transit | HTTPS (GitHub Pages + Google) | No change needed |
| Data at rest | Google Sheets (Google security) | No change needed |
| Apps Script URL | Public but data-only endpoint | Apps Script key or Cloudflare |
| Source code | Public GitHub repo | Move to private repo + GitHub Pro |
| Sensitive data | Bank details in localStorage | Encrypt at rest |

**Current risk assessment:** Low. No PII beyond buyer/supplier contact details. No payment processing. No direct database exposure. Primary risk is Apps Script URL being discoverable — mitigated by the fact it returns no data without knowing entity keys and returns empty arrays to unauthenticated enumeration.

---

## 10. Disaster Recovery

| Scenario | Recovery |
|----------|----------|
| Browser localStorage cleared | Pull from Sheets — full restore |
| Google Sheet accidentally deleted | Restore from Google Drive Trash (30 days) |
| GitHub Pages URL changes | Update bookmark — data unaffected |
| Apps Script deployment broken | Redeploy from source — new URL, update Settings |
| index.html corrupted | Restore from versioned archive in `/app/` folder |
| All data lost | No recovery — no off-Sheets backup currently |

**Recommended addition (v2.4.0):** Scheduled Apps Script trigger to copy Sheet data to a second backup Sheet weekly.
