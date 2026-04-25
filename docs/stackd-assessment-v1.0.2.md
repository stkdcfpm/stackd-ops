# Stackd Ops — Build Assessment
**Document:** stackd-assessment-v1.0.0.md
**Version assessed:** stackd-ops-v2.5.3
**Assessment date:** 2026-04-21
**Assessor:** FPM International / Claude (Anthropic)
**Status:** Baseline — v1.0.0

---

## Executive Summary

This document provides a structured assessment of the Stackd Ops build against four frameworks: SDLC maturity, data management quality, security posture, and compliance readiness. It establishes a baseline score at v2.5.3 and maps all identified weaknesses to remediation actions with version targets.

| Framework | Score | RAG | Summary |
|-----------|-------|-----|---------|
| SDLC Maturity | 6.2 / 10 | 🟡 Amber | Strong versioning and documentation. Weak on automated testing and formal change control. |
| Data Management | 6.8 / 10 | 🟡 Amber | Good data model and glossary. Weak on reference data management and data lineage. |
| Security | 3.8 / 10 | 🔴 Red | Functional deterrent only. Not production-grade. Acceptable for sole trader internal use. Must be resolved before TradeFlow. |
| Compliance Readiness | 5.5 / 10 | 🟡 Amber | UK invoice requirements met. GDPR partially addressed. Customs documentation incomplete. |
| **Overall** | **5.6 / 10** | **🟡 Amber** | Fit for purpose as a sole trader internal tool. Not yet fit for multi-user or client-facing deployment. |

---

## Section 1: SDLC Maturity Assessment

**Framework:** CMMI (Capability Maturity Model Integration) adapted for solo/small team development.
**Target maturity level:** Level 3 (Defined) for TradeFlow. Currently assessed at Level 2 (Managed).

### 1.1 Requirements Management — 7/10 🟡

**What's good:**
- Feature requests captured in conversation context and memory
- Regulatory enhancement register (REG-001 to REG-010) documented
- TradeFlow scaling notes captured in data model document
- Version roadmap maintained (v2.4.x, v2.5.x, v2.6.0, v3.0.0)
- Credit note function flagged and roadmapped (v2.6.0)

**Weaknesses:**
- No formal requirements backlog or issue tracker (GitHub Issues not yet used)
- No user story format — requirements captured as conversational requests
- No acceptance criteria defined per feature before build
- No prioritisation framework beyond operator judgement

**Remediation:**
- Enable GitHub Issues on the repo — one issue per feature/bug
- Apply labels: `enhancement`, `bug`, `compliance`, `security`, `TradeFlow`
- Write acceptance criteria in issue body before marking as in-progress
- Target: v2.6.0 — formalise issues workflow

**Score rationale:** Requirements are captured and acted on consistently but lack formal structure. Adequate for sole trader, insufficient for team or product.

---

### 1.2 Version Control — 8/10 🟢

**What's good:**
- Semantic versioning adopted (MAJOR.MINOR.PATCH)
- Commit message convention established (`v2.5.3 — description`)
- Versioned file archives maintained (`/app/` folder)
- `index.html` correctly separated from versioned archives
- Apps Script versioned separately (`stackd-appsscript-v2.1.0.gs`)
- All documentation versioned (`stackd-*-v1.0.0.md`)
- GitHub provides full commit history as audit trail

**Weaknesses:**
- No branching strategy — all commits direct to `main`
- No pull request workflow — no peer review of changes
- Version increments not always applied before delivery (historical issue, now resolved)
- No release tags on GitHub (v2.3.2, v2.5.3 etc. not tagged as releases)

**Build changelog (complete to v2.5.3):**

| Version | Key changes |
|---------|-------------|
| v2.3.2 | Password gate, print fix, GitHub Pages deployment |
| v2.4.0–v2.4.2 | Bulk import, validation, HS codes, pro-forma, auto-increment (syntax fixes applied) |
| v2.4.3 | Invoice number format changed to INV##### (e.g. INV10029) |
| v2.4.4–v2.4.5 | CSV template updated with real FPM data, template array flatten fix |
| v2.5.0 | Tooltips (50 field definitions), dial code dropdown (250 countries), email/invoice/HS validation, import instructions updated |
| v2.5.1 | Net profit calculation fix for imported invoices — charges now correctly deducted |
| v2.5.2 | Accounts & deposit tracker (by invoice + by supplier pivot), Net Cash Position KPI |
| v2.5.3 | FPM funded deposit field on POs, auto-recovery when invoice marked Paid, Total to Chase column |

**Remediation:**
- Create GitHub releases for each stable version — provides downloadable snapshots
- Consider `dev` branch for work in progress, `main` for stable releases only
- Target: v2.6.0

**Score rationale:** Strong versioning discipline for a solo project. Branching and release tagging are the primary gaps.

---

### 1.3 Testing and QA — 5/10 🟡

**What's good:**
- QA framework document exists (`stackd-qa-v1.0.0.md`)
- 80+ test cases documented across 9 sections
- Calculation verification test with known expected values (Section 9)
- Node.js syntax check run on every build (`node --check`)
- Test data generator exists with reproducible dataset
- Known issues logged with BUG IDs and workarounds

**Weaknesses:**
- No automated test execution — all testing is manual
- QA checklist not formally run against each release — partial coverage only
- No regression testing — a fix in one area may break another undetected
- No browser compatibility matrix formally tested
- No performance testing — localStorage limits not monitored
- QA document not updated to reflect v2.4.x and v2.5.x features

**Remediation:**
- Update `stackd-qa-v1.0.0.md` to v1.1.0 covering all new features
- Add a pre-release checklist: minimum tests to run before any `index.html` push
- Consider Playwright or Cypress for automated browser testing at v3.0.0
- Target: QA update — immediate. Automated testing — v3.0.0

**Score rationale:** Documentation exists but execution is inconsistent. Syntax checking provides a safety net but does not replace functional testing.

---

### 1.4 Release Management — 6/10 🟡

**What's good:**
- Changelog maintained in QA document
- Clear deployment process (GitHub Desktop → push → Pages auto-deploys)
- Password gate means unintended public access is mitigated
- Rollback possible by reverting `index.html` to previous versioned archive

**Weaknesses:**
- No formal release checklist before deployment
- No staging environment — changes go directly to production
- No deployment notification process
- GitHub Pages propagation delay (2-5 minutes) not always accounted for
- Cache invalidation issues experienced in practice

**Remediation:**
- Define a release checklist: syntax check → QA minimum → deploy → verify live → commit archive
- Consider Cloudflare in front of GitHub Pages for cache control (also improves security)
- Target: v2.6.0

---

### 1.5 Documentation — 8/10 🟢

**What's good:**
- Data model document — entities, fields, relationships, business rules
- Architecture document — component diagram, data flows, file inventory
- Data standards document — DAMA-DMBOK applied, validation rules, glossary
- Regulatory document — four jurisdictions, enhancement register
- User guide — eight workflows, troubleshooting
- Quick reference — one-page daily use card
- QA framework — test cases, changelog, known issues
- All documents versioned and stored in `/docs/` in GitHub

**Weaknesses:**
- Mermaid diagrams not yet produced — all architecture described in text/ASCII
- Documents not yet updated to reflect v2.4.x and v2.5.x additions
- No API documentation (Apps Script endpoints not formally documented)
- No developer onboarding guide for TradeFlow handoff

**Remediation:**
- Produce Mermaid ERD and architecture diagrams — target docs v1.1.0
- Update all docs to reflect v2.5.3 feature set
- Add Apps Script endpoint documentation to architecture doc
- Target: docs v1.1.0 alongside v2.6.0

---

### 1.5b Financial Tracking Features — Documented for Completeness

The following financial tracking features were built after the initial assessment baseline and are noted here for completeness:

**Accounts & Deposit Tracker (v2.5.2):**
- Per-invoice view showing buyer deposit received, buyer balance due, supplier deposit paid, supplier balance due, and net cash position
- Per-supplier pivot showing total COGS committed, deposit coverage percentage, and settlement progress
- Net Cash Position KPI card on dashboard (6th KPI) — total buyer deposits minus total supplier deposits

**FPM Funded Deposit Tracker (v2.5.3):**
- FPM Funded field on each PO — records amounts paid from operator's own funds separate from buyer-funded deposits
- Auto-recovery rule: when invoice status changes to `Paid`, all linked PO FPM-funded deposits are automatically marked recovered
- Total to Chase column in accounts tracker — invoice balance due plus any unrecovered FPM-funded deposits
- FPM Exposure summary in totals bar — total outstanding operator-funded deposits across all active invoices

**Assessment note:** These features directly address cash flow visibility and recovery tracking — a gap in standard trade management tools. The auto-recovery rule creates an auditable event (toast notification + AuditLog entry) whenever FPM-funded deposits are recovered. This is good practice for reconciliation.

---

### 1.6 Change Control and Audit Trail — 6/10 🟡

**What's good:**
- AuditLog tab in Google Sheets — every create, update, delete logged with timestamp and snapshot
- Browser localStorage audit log (last 500 entries)
- GitHub commit history provides code change audit trail
- Changelog in QA document provides human-readable change history

**Weaknesses:**
- AuditLog not queryable from the app UI — only visible in Google Sheets directly
- No change approval process — operator makes and deploys all changes
- No rollback mechanism for data changes (only code rollback is possible)
- Audit log capped at 500 entries in localStorage

**Remediation:**
- Add AuditLog viewer tab to app (v2.6.0)
- Implement Google Sheets scheduled backup (v2.6.0) — provides point-in-time data restore
- Uncap audit log in Sheets (already unlimited — localStorage cap is the only limit)

---

**SDLC Overall: 6.2/10 🟡**

---

## Section 2: Data Management Assessment

**Framework:** DAMA-DMBOK (Data Management Body of Knowledge) — six quality dimensions.

### 2.1 Data Completeness — 7/10 🟡

**What's good:**
- Required fields identified and documented per entity
- Input validation added for critical fields (v2.5.0)
- Import process validates minimum required columns
- calc_* fields written server-side ensuring calculated values always present

**Weaknesses:**
- Required field enforcement is partial — not all fields validated
- Line items on imported invoices are empty by design — COGS lookup unavailable until enriched
- Supplier phone numbers not always in consistent format
- HS codes not mandatory despite being required for customs

**Remediation:**
- Complete input validation coverage (planned v2.4.0 enhancements not fully implemented)
- Add HS code as mandatory field for line items used in export invoices
- Target: v2.6.0

---

### 2.2 Data Accuracy — 6/10 🟡

**What's good:**
- Calculations verified against known expected values (QA Section 9)
- calc_* fields written by Apps Script provide independent calculation check
- Dual calculation paths (live line items + calc_ fallback) with fallback logic

**Weaknesses:**
- Items Subtotal requires manual calculation by operator — prone to error
- No cross-validation between invoice totals and sum of line items
- COGS on imported invoices is operator-entered — no verification
- Exchange rates not captured — USD values not reconcilable to GBP for tax purposes
- Deposit amounts not validated against invoice total (can exceed grand total)

**Remediation:**
- Add Items Subtotal auto-calculation from line items when present
- Add deposit validation: warn if buyer deposit exceeds grand total
- Add FX rate field on invoices (v2.5.0 roadmap)
- Target: v2.6.0

---

### 2.3 Data Consistency — 7/10 🟡

**What's good:**
- Single source of truth: Google Sheets as master record
- Auto-sync on every save maintains consistency
- Pull on load reconciles local state with Sheets
- Entity IDs are immutable — join keys never change
- Bulk import deduplication by invoice number and supplier name

**Weaknesses:**
- Two copies of data exist (localStorage + Sheets) — divergence possible if offline edits not synced
- No conflict resolution beyond last-write-wins
- PO line items denormalised from invoice line items — can drift if invoice is edited post-PO creation
- Supplier name matching in bulk import is case-insensitive but not fuzzy — typos create orphaned records

**Remediation:**
- Add sync status indicator showing last successful sync timestamp
- Add conflict detection: flag if local record is newer than Sheets record on pull
- Add fuzzy supplier name matching in import (Levenshtein distance)
- Target: v3.0.0

---

### 2.4 Data Validity — 6/10 🟡

**What's good:**
- Email regex validation (v2.5.0)
- Invoice number format enforced (INV/CN + digits, optional -D# draft suffix)
- Invoice number format matches FPM convention: INV##### (e.g. INV10029)
- HS code numeric check (v2.5.0)
- Status values normalised on import (case-insensitive: `paid`, `Paid`, `PAID` all accepted)
- Tax rate range check (0-1)
- Negative value prevention on financial fields
- Tooltip system (v2.5.0): 50 field-level guidance tooltips across all modals — reduces operator input errors
- Dial code dropdown (v2.5.0): structured phone input prevents format inconsistency

**Weaknesses:**
- Date format not validated beyond HTML date picker
- Country field is free text — no reference lookup
- Currency field uses dropdown but no exchange rate validation
- Phone number format validated only by dial code selection — number portion unchecked
- Address fields entirely free text — no postcode/zip validation

**Remediation:**
- Country field: add ISO 3166-1 country lookup (reference data)
- Phone number: add local number format validation per dial code
- Target: v2.6.0 for country lookup, v3.0.0 for phone validation

---

### 2.5 Data Uniqueness — 7/10 🟡

**What's good:**
- Invoice number uniqueness check on save
- Supplier deduplication by name in bulk import
- Invoice deduplication by number in bulk import
- Auto-generated IDs use timestamp + random suffix — collision probability negligible

**Weaknesses:**
- No supplier uniqueness check on manual entry — can create duplicate suppliers
- PO numbers not checked for uniqueness
- No entity-level duplicate detection across sessions (only within current session)

**Remediation:**
- Add supplier name uniqueness check on save (warn, not block — legitimate duplicates exist e.g. two entities of same company)
- Add PO number uniqueness check
- Target: v2.6.0

---

### 2.6 Reference Data Management — 4/10 🔴

**What's good:**
- Currency codes hardcoded as dropdown (USD, GBP, EUR, BBD, NGN, GHS)
- Country dial codes embedded (ITU E.164, 250 countries) — v2.5.0
- Tax rate presets for common rates (0%, 5%, 7.5%, 10%, 15%, 17.5%, 20%)
- Status values as controlled enumerations

**Implemented reference data (v2.5.0):**
- Country dial codes: ITU E.164 standard, 250 countries embedded in app
- Tax rate presets: 7 common rates plus custom entry
- Invoice status: 6 controlled values with import normalisation
- PO status: 5 controlled values

**Weaknesses:**
- No HS code reference database — operator must look up codes externally
- No country reference list for the Country field — free text only
- No Incoterms reference list — free text
- Currency list is hardcoded — cannot be extended without code change
- No port code reference (UNLOCODE) for POL/POD fields
- No carrier or freight forwarder reference list

**Remediation:**
- Add ISO 3166-1 country lookup to Country fields (v2.6.0)
- Add Incoterms 2020 dropdown (EXW, FOB, CIF, DAP, DDP etc.) (v2.6.0)
- Add WCO HS code lookup — major chapter headings at minimum (v3.0.0)
- Add UNLOCODE lookup for ports (v3.0.0)
- Target: country and Incoterms — v2.6.0

---

**Data Management Overall: 6.8/10 🟡**

---

## Section 3: Security Assessment

**Framework:** OWASP Top 10 (2021) adapted for client-side web applications.
**Important context:** Stackd Ops is a sole trader internal tool, not a public-facing application. The security posture is assessed against that context but with TradeFlow risks flagged.

### 3.1 Authentication — 3/10 🔴

**Current implementation:**
- Simple hash (non-cryptographic) password gate
- `simpleHash()` function uses bit-shifting — not SHA-256 or bcrypt
- Session stored in `sessionStorage` — cleared on tab close
- Single shared password for all access
- No multi-factor authentication
- No lockout after failed attempts
- Password visible in page source to anyone who views source

**Risk assessment:**
- The hash can be reversed by anyone who views page source and runs the hash function
- No brute force protection — unlimited password attempts
- Single password means no user-level audit trail
- Acceptable risk for: sole trader internal use on trusted devices
- Unacceptable risk for: any multi-user or client-accessible deployment

**Remediation:**
- Short term: Change default password, do not share the URL publicly (current practice)
- Medium term: Cloudflare Access in front of GitHub Pages — Google OAuth login (Option B previously discussed)
- Long term: JWT authentication with per-user credentials for TradeFlow
- Target: Cloudflare Access — before any external sharing. JWT — v3.0.0

---

### 3.2 Access Control — 3/10 🔴

**Current implementation:**
- Binary access — either you know the password or you don't
- No role-based access control (RBAC)
- No field-level access control
- Apps Script URL provides unauthenticated data access if discovered

**Risk assessment:**
- Anyone with the Apps Script URL can call `get_all` on any entity and retrieve all data
- No rate limiting on Apps Script endpoints
- No IP allowlisting on Apps Script
- Acceptable risk: Apps Script URL is not published anywhere — security by obscurity
- Data returned is commercial (not PII-heavy) — moderate sensitivity

**Remediation:**
- Add a shared secret token to Apps Script requests — validate on server side
- Add Apps Script execution rate limiting via Google's built-in quotas
- Target: Apps Script token — v2.6.0

---

### 3.3 Sensitive Data Exposure — 4/10 🔴

**Current implementation:**
- Bank details stored in `localStorage` in plain text
- Supplier email, phone, contact names stored unencrypted in localStorage and Google Sheets
- Buyer address, email stored unencrypted
- Google Sheets protected only by Google account security
- Source code is public on GitHub (contains no credentials, but exposes architecture)

**Risk assessment:**
- localStorage is accessible to any JavaScript running on the page
- If a malicious browser extension is installed, localStorage data is exposed
- Google Sheets data is protected by Google account — 2FA on Google account is the key control
- Bank details in localStorage is the highest risk item — could enable fraud if device is compromised

**Remediation:**
- ✅ 2FA already enabled on the Google account that owns the Sheet
- Consider encrypting bank details before storing in localStorage (Web Crypto API)
- Move to private GitHub repo (GitHub Pro £4/month) — reduces architecture exposure
- Target: Google 2FA — immediate. Encryption — v3.0.0. Private repo — when budget allows

---

### 3.4 Input Validation and Injection — 6/10 🟡

**What's good:**
- Input validation added for email, invoice numbers, HS codes, numeric fields (v2.5.0)
- No SQL injection risk — no SQL database
- HTML is built via string concatenation with no user input in `<script>` contexts
- Apps Script uses `JSON.parse` for all input — no eval()

**Weaknesses:**
- No XSS sanitisation on user input — if a supplier name contains `<script>` it would be stored and rendered
- No Content Security Policy (CSP) header — not configurable on GitHub Pages without Cloudflare
- Import CSV parsing does not sanitise cell values before storing
- Invoice notes and PO notes fields are entirely free text with no sanitisation

**Remediation:**
- Add HTML entity encoding to all user-entered strings before rendering in innerHTML
- Add CSP header via Cloudflare (when implemented)
- Sanitise CSV import values: strip `<>` characters at minimum
- Target: XSS sanitisation — v2.6.0

---

### 3.5 Security Misconfiguration — 4/10 🔴

**Current implementation:**
- Public GitHub repository — source code, architecture, and file structure are public
- No HTTPS enforcement (GitHub Pages serves HTTPS by default — this is fine)
- Apps Script deployed as "Anyone" — no authentication required
- Default Google Apps Script permissions — broad access to spreadsheet

**Risk assessment:**
- Public repo exposes the full system architecture to anyone — low direct risk but reduces security through obscurity
- Apps Script "Anyone" access means the data endpoint is publicly callable
- Google Apps Script has a 6-minute execution timeout and daily quota limits — DoS via quota exhaustion is theoretically possible

**Remediation:**
- Move to private GitHub repo
- Add secret token validation to Apps Script
- Restrict Apps Script to "Anyone with Google account" if all users have Google accounts
- Target: Apps Script token — v2.6.0. Private repo — when budget allows

---

### 3.6 Session Management — 5/10 🟡

**What's good:**
- `sessionStorage` used — auth cleared when tab closes
- No persistent "remember me" — must re-authenticate each session
- No session token transmitted to server

**Weaknesses:**
- `sessionStorage` is shared across tabs in the same browser session — opening a second tab bypasses the auth gate
- No session timeout — a logged-in session stays active indefinitely until tab is closed
- No concurrent session detection

**Remediation:**
- Add session timeout (e.g. 8 hours of inactivity) using `localStorage` timestamp check
- Target: v2.6.0

---

### 3.7 Dependency Risk — 7/10 🟢

**What's good:**
- Minimal external dependencies — only Google Fonts (CDN)
- No npm packages — no supply chain risk from package.json
- No framework dependencies (React, Vue etc.) — pure vanilla JS
- Google Apps Script is Google-maintained infrastructure
- GitHub Pages is Microsoft-maintained infrastructure

**Weaknesses:**
- Google Fonts loaded from external CDN — if CDN is unavailable, fonts fall back gracefully but this is an external dependency
- No Subresource Integrity (SRI) on the Google Fonts link

**Remediation:**
- Self-host fonts in the GitHub repo — eliminates CDN dependency entirely
- Target: v3.0.0

---

**Security Overall: 3.8/10 🔴**

**Critical actions before any external sharing:**
1. ✅ Google 2FA enabled on the account owning the Sheet
2. ✅ Default password changed from `stackd2025`
3. ✅ GDPR lawful basis statement documented
4. Do not share the Apps Script URL publicly
5. Do not share the GitHub repo URL publicly

---

## Section 4: Compliance Readiness Assessment

**Framework:** Regulatory requirements identified in `stackd-regulatory-v1.0.0.md`.

### 4.1 UK Invoice Legal Requirements — 8/10 🟢

| Requirement | Status |
|-------------|--------|
| Business name and address | ✅ In Settings, appears on invoice |
| Buyer name and address | ✅ Invoice fields present |
| Unique invoice number | ✅ Auto-increment + uniqueness check |
| Invoice date | ✅ Required field |
| Description of goods | ✅ Line item description field |
| Quantity and unit price | ✅ Line item fields |
| Total amount due | ✅ Grand total calculated |
| Payment terms | ✅ Terms field, default configurable |
| VAT number (if registered) | ❌ No VAT number field in Settings |
| VAT amount shown separately | ⚠️ Tax amount shown in charges breakdown but not labelled as VAT |

**Remediation:** Add VAT registration number field to Settings (REG-001). Add VAT label toggle (REG-002). Target: v2.6.0.

---

### 4.2 Record Retention — 6/10 🟡

| Requirement | Status |
|-------------|--------|
| 5-year Self Assessment retention | ⚠️ Data in Google Sheets indefinitely — no deletion mechanism exists yet |
| 6-year VAT record retention | ⚠️ Same as above — retention is indefinite which satisfies minimum |
| Ability to export records | ✅ CSV export function exists |
| Audit trail of changes | ✅ AuditLog tab in Sheets |
| Right to erasure (GDPR) | ❌ No mechanism to delete individual buyer/supplier personal data |

**Remediation:** Add "Delete buyer data" function for GDPR compliance (REG-008). Target: v3.0.0.

---

### 4.3 Barbados Customs Requirements — 6/10 🟡

| Requirement | Status |
|-------------|--------|
| Country of origin | ✅ COO field present |
| Port of embarkation and discharge | ✅ POL/POD fields present |
| HS codes per line item | ⚠️ HS code field exists but not mandatory |
| Incoterms | ❌ Freight Type is free text — no Incoterms dropdown |
| CIF value calculation | ❌ No landed cost calculator |
| Commercial invoice format | ✅ Invoice document meets requirements |

**Remediation:** Incoterms dropdown (REG-005). Landed cost calculator (REG-007). Mandatory HS codes (REG-004). Target: v2.6.0.

---

### 4.4 Nigeria Import Requirements — 4/10 🔴

| Requirement | Status |
|-------------|--------|
| Form M reference field | ❌ No field for Form M number |
| Pro-forma invoice status | ✅ Added in v2.4.0 |
| CIF value in USD | ✅ USD currency supported |
| SON / NAFDAC certification tracking | ❌ No certification tracker |
| PAAR reference | ❌ No field |

**Remediation:** Add Form M reference field to invoice shipping section (v2.6.0). Certification tracker is a v3.0.0 feature.

---

### 4.5 GDPR / UK Data Protection — 4/10 🔴

| Requirement | Status |
|-------------|--------|
| Lawful basis for processing | ⚠️ Legitimate interest applies — not documented |
| Data minimisation | ⚠️ Some optional fields collected without clear purpose |
| Right of access | ❌ No mechanism to export all data about a specific person |
| Right to erasure | ❌ No delete function for personal data |
| Data retention limits | ❌ No retention policy enforced in system |
| Privacy notice | ❌ No privacy notice exists |
| Data breach procedure | ❌ Not documented |

**Remediation:** ✅ Lawful basis documented — fpm-gdpr-statement-v1.0.0.md filed in Google Drive FPM/Legal/GDPR. Add data export and deletion functions in system. Target: v3.0.0.

---

**Compliance Overall: 5.5/10 🟡**

---

## Section 5: Remediation Roadmap

### Immediate Actions (no version required)
| Action | Owner | Priority | Status |
|--------|-------|----------|--------|
| Enable Google 2FA on Sheet owner account | Carman | Critical | ✅ Complete — was already enabled |
| Change default password if not already done | Carman | Critical | ✅ Complete |
| Document lawful basis for GDPR processing | Carman | High | ✅ Complete — fpm-gdpr-statement-v1.0.0.md |
| Write basic privacy notice | Carman | High | ✅ Complete — filed in Google Drive FPM/Legal/GDPR |

### v2.6.0 Target
| Enhancement | Framework | Score impact |
|-------------|-----------|-------------|
| Apps Script secret token | Security | +1.5 |
| XSS sanitisation on user input | Security | +0.8 |
| Session timeout (8 hours) | Security | +0.5 |
| VAT number field in Settings | Compliance | +0.3 |
| Incoterms 2020 dropdown | Compliance | +0.4 |
| Country ISO lookup | Data Management | +0.5 |
| Supplier uniqueness check | Data Management | +0.3 |
| AuditLog viewer in app UI | SDLC | +0.4 |
| Scheduled Sheets backup | SDLC | +0.5 |
| GitHub Issues workflow | SDLC | +0.4 |
| Form M reference field | Compliance | +0.2 |
| GitHub release tags | SDLC | +0.3 |

**Projected scores after v2.6.0:**
- SDLC: 7.2/10
- Data Management: 7.8/10
- Security: 5.5/10
- Compliance: 6.5/10
- **Overall: 6.8/10**

### v3.0.0 / TradeFlow Target
| Enhancement | Framework | Score impact |
|-------------|-----------|-------------|
| OAuth2 / JWT authentication | Security | +2.5 |
| Role-based access control | Security | +1.0 |
| Private repo + Cloudflare Access | Security | +1.0 |
| Encryption at rest for sensitive fields | Security | +0.8 |
| GDPR data export and deletion | Compliance | +1.0 |
| Automated testing (Playwright) | SDLC | +1.5 |
| Staging environment | SDLC | +0.8 |
| WCO HS code lookup | Data Management | +0.8 |
| UNLOCODE port lookup | Data Management | +0.5 |
| Normalised line items table | Data Management | +0.7 |

**Projected scores after v3.0.0:**
- SDLC: 8.5/10
- Data Management: 9.0/10
- Security: 8.5/10
- Compliance: 8.0/10
- **Overall: 8.5/10**

---

## Section 6: Assessment Methodology

### Scoring Scale
| Score | Meaning |
|-------|---------|
| 9-10 | Excellent — meets or exceeds best practice |
| 7-8 | Good — minor gaps, low risk |
| 5-6 | Adequate — gaps present, managed risk |
| 3-4 | Weak — significant gaps, elevated risk |
| 1-2 | Poor — fundamental gaps, high risk |

### RAG Criteria
| RAG | Score range | Action |
|-----|------------|--------|
| 🟢 Green | 7.0+ | Monitor, maintain |
| 🟡 Amber | 5.0-6.9 | Address in next 1-2 releases |
| 🔴 Red | Below 5.0 | Address before external deployment |

### Reassessment Schedule
- **Minor reassessment:** Every MINOR version release (v2.6.0, v2.7.0)
- **Full reassessment:** Every MAJOR version release (v3.0.0)
- **Ad hoc:** If a security incident occurs or a new jurisdiction is added

---

## Section 7: Version History

| Version | Date | Changes |
|---------|------|---------|
| v1.0.0 | 2026-04-21 | Initial baseline assessment against stackd-ops-v2.5.3 |
| v1.0.1 | 2026-04-21 | Immediate actions closed: 2FA confirmed, GDPR statement filed, password changed |
| v1.0.2 | 2026-04-21 | Added missing features: accounts tracker, FPM deposit tracker, tooltips, INV##### format. Added missing versions to changelog. |
