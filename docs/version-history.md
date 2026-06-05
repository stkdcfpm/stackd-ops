# Version History

| Version | Highlights |
|---|---|
| v2.9.17 | Fix: Live FX rate source switched from frankfurter.app (301 CORS-blocked) to fawazahmed0/currency-api via jsDelivr CDN (free, no key, CORS-enabled). Fix: AI system prompt updated to describe ↻ Live Rates feature. Tests: 193/193 pass. |
| v2.9.16 | Security: CSP meta tag added (`default-src 'none'`; `connect-src https:`; `object-src 'none'`; `base-uri 'self'`) — closes SEC-GAP-008. Data safety: `checkStorageQuota()` runs on init, warns at 75%/90% of 5 MB limit — partial mitigation of BACKUP-GAP-002. Gap register: BACKUP-GAP-001 and BACKUP-GAP-002 formally documented. Tests: 193/193 pass. |
| v2.9.15 | Dashboard multi-currency fix: all KPI aggregations (revenue, profit, outstanding, PO balance, deposits) now convert to GBP equiv. via `toGBP()` helper using stored QR FX rates. KPI tiles labelled "≈ GBP". Bar charts updated. Tests: 190/190 pass. |
| v2.9.14 | Sync fixes: strengthened `syncAll()` URL guard (https:// required); `st_last_sync` timestamp + `renderSyncStatus()` display. Security fixes: `pullAll()` crash (undefined variable scope), 7 XSS gaps (`san()` on dashboard/supplier/accounts charts, CN PDF bank field, payment table), PII removed from `AS` defaults, `testConn()` token moved from URL to POST body. Token optimisation: prompt caching (`anthropic-beta: prompt-caching-2024-07-31`, `system` as content blocks array with `cache_control`), section index added to `index.html`. Tests: 174/174 pass. |
| v2.9.13 | AI compliance review mode (`AI_COMPLIANCE_PROMPT`, `toggleAIMode()`); Security gate fixes: XSS `san()` coverage on PDF blob builders (`prevInvDoc`/`prevPODoc`), `AS.bank`, colour CSS injection guard; HTTPS enforcement on `saveCfgUrl`/`saveFwdWebhook`; Cloudflare Worker deployment-ID path validation; `.catch()` on all `syncEnt`/`delEnt` calls; `vCN()` rewritten to use `vErr`/`vOk`/`vClr` helpers; `linkedInv` lookup cleanup. Data fix: INV10031 grand total corrected to $7,042.19 (was $7,248.24 — lf double-counted). Tests: +21 new tests. 169/169 pass. Known gaps: SEC-GAP-001–004 documented. |
| v2.9.12 | Invoice status locking (`LOCKED_STATUSES`, `canTransitionStatus`, read-only view, `unlockInv` with CONFIRM+reason+audit); Buyer Statement (per-buyer PDF, `renderStatement`, `openStatement`, `prevStmtPdf`); CN balance deduction (`saveCN` updates `calc_balanceDue`, `iCalc.bal` always live from `cInv`); Sheets sync rewrite (`FIELD_MAPS`, `mapRec`, `syncEnt`/`delEnt`/`syncAll`/`pushAll`, Cloudflare Worker CORS proxy, `Code.gs` `handleBulkUpsert`/`handleUpsert`/`handleDelete`/`BIZ_KEYS`/`logAudit`); `STACKD_CONTEXT.md` added |
| v2.9.11 | Dashboard KPI fixes: `calc_` fields as source of truth (`iCalc` prefers `calc_grandTotal`), CN exclusion from revenue/profit/count KPIs, `repairCalcFields` INV10028/INV10031 COGS corrections |
| v2.9.10 | EN/ZH Language Toggle (nav toggle, `setLang()`, `data-en`/`data-zh`, Settings card, AI Mandarin mode); Invoice/CN Modal Separation (dedicated `ov-cn` modal, `saveCN()`, two-section `v-inv`, CN table); Company Branding on PDFs (Settings card, logo upload, `buildPdfHeader`/`Footer`, FPM International pre-populate) |
| v2.9.9 | Line item dims (L/W/H, CBM/unit, DG flag); Load Calculator (multi-invoice CBM, container rec, DG flag, export); Forwarder Update Request (per-shipment pre-filled message, clipboard, webhook, Integrations settings); Quote Feasibility Check (DG warning, container rec, Caribbean electrical advisory) |
| v2.9.8 | Credit note system fixes: PDF routing (BUG 1), negative amount display (BUG 2), balance deduction + legacy type fallback (BUG 3); Goodwill Credit feature; Sheets Line Items tab on Push All |
| v2.9.7 | REQ-SYN-001: Sheets sync guard (`isEmptyLI` hoisted); REQ-LIB-001: invoice→library refs index (`invoiceRefs`), library picker usage indicators; Blob URL PDF previews |
| v2.9.6 | Brand lockup — Rajdhani 700 wordmark, JetBrains Mono tagline, D in #C8312E, HR rule; drops SVG container mark |
| v2.9.5 | Accounting export — generic CSV/JSON + Xero/QuickBooks/FreeAgent mappers, data quality check, export modal |
| v2.9.4 | Quote engine, rate engine, per-line price versioning, Settings Rates card |
| v2.9.3 | Incoterms + Payment Terms fields, custom ports, 5 new UN/LOCODE ports |
| v2.9.2 | Reference data audit |
| v2.9.1 | Price history on line items and invoices |
| v2.8.1 | Shipment CRUD, DG flag, linked invoices |
| v2.8.0 | Payments ledger, balance tracking |
