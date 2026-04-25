# Stackd Ops — Regulatory & Legal Considerations
**Version:** 1.0.0
**Date:** 2026-04-21
**Author:** FPM International
**Disclaimer:** This document is for operational planning purposes only. It does not constitute legal or tax advice. Consult a qualified legal or tax professional before making compliance decisions.

---

## 1. Overview

FPM International operates as a UK-registered sole trader intermediary sourcing goods from China for buyers primarily in Barbados and West Africa (Nigeria, Ghana). This creates regulatory obligations across multiple jurisdictions. This document identifies key areas requiring attention and flags them as enhancement opportunities for the Stackd Ops system.

---

## 2. United Kingdom

### 2.1 VAT (Value Added Tax)
- **Registration threshold:** £90,000 turnover (2024/25). Below this, VAT registration is optional.
- **If registered:** Must charge 20% VAT on UK supplies, file quarterly VAT returns.
- **Export status:** Goods exported outside the UK are generally zero-rated for VAT purposes — this applies to shipments to Barbados, Nigeria, Ghana.
- **Invoice requirement:** VAT invoices must include VAT registration number, VAT amount, VAT rate, and supplier/buyer details.
- **Stackd enhancement:** Add VAT registration number field to Settings. Add toggle: "This is a VAT-registered business" which conditionally adds VAT number to invoice header.

### 2.2 Invoice Legal Requirements (UK)
Under UK law, a valid commercial invoice must include:
- [ ] Your business name and address
- [ ] Buyer's name and address
- [ ] Unique invoice number
- [ ] Invoice date
- [ ] Description of goods or services
- [ ] Quantity and unit price
- [ ] Total amount due
- [ ] Payment terms

**Current Stackd status:** All fields present. ✅

Missing but recommended:
- [ ] VAT number (if registered)
- [ ] Company registration number (if limited company — not applicable for sole trader)

### 2.3 Self Assessment & Tax Records
- As a sole trader, all income must be declared via Self Assessment.
- Records must be kept for **5 years** after the 31 January submission deadline.
- Stackd's AuditLog and Google Sheets provide a digital record trail.
- **Stackd enhancement:** Financial year filter on invoice export — export all invoices within a tax year for accountant submission.

### 2.4 GDPR (UK)
- Buyer and supplier contact details (name, email, phone, address) constitute personal data under UK GDPR.
- As a sole trader processing this data, FPM must:
  - Have a lawful basis for processing (legitimate interest for B2B is generally sufficient)
  - Not retain data longer than necessary
  - Be able to respond to Subject Access Requests
- **Current risk:** Buyer/supplier data stored in Google Sheets (Google's servers, US-based). Google Workspace has adequate GDPR safeguards via Standard Contractual Clauses.
- **Stackd enhancement:** Add data retention policy field. Add "Delete buyer data" function for GDPR compliance.

---

## 3. Barbados

### 3.1 Import Duties & Taxes
- Barbados applies **Common External Tariff (CET)** as a CARICOM member.
- Import duty rates vary by HS code — typically 0–45% on manufactured goods.
- **VAT (Barbados):** 17.5% on most imported goods.
- **Consumption tax:** Applied to certain categories.
- **Landed cost formula:** CIF value × (1 + duty rate) × 1.175 (VAT)
- **Stackd enhancement:** Add HS code field to Line Items (already in notes — promote to dedicated field). Add duty rate field per line item for landed cost calculation for buyer reference.

### 3.2 Invoice Requirements (Barbados Customs)
Barbados Customs requires:
- [ ] Commercial invoice with full buyer and seller details
- [ ] Country of origin
- [ ] Port of embarkation and discharge
- [ ] Description of goods with HS codes
- [ ] Quantity, unit price, and total value
- [ ] Currency
- [ ] Incoterms

**Current Stackd status:** All fields present. Country of origin, POL, POD all captured. ✅
**Missing:** HS codes — currently in line item notes field only.

### 3.3 Certificate of Origin
For CARICOM duty preferences, a Certificate of Origin may be required. This is an external document — Stackd does not generate it. Flag in documentation as operator responsibility.

---

## 4. Nigeria

### 4.1 Import Regulations
- Nigeria operates under the **Nigeria Customs Service (NCS)**.
- All imports require a **Form M** (import declaration) processed through a Nigerian bank.
- **Pre-Arrival Assessment Report (PAAR)** required for imports above certain values.
- **NAFDAC** registration required for food, drugs, cosmetics — relevant if pollock or other food products are shipped.
- **SON (Standards Organisation of Nigeria)** certification required for electrical goods — relevant for Fuzhou Bote electrical products.

### 4.2 Invoice Requirements (Nigeria)
- Commercial invoice must state CIF value in USD.
- Pro-forma invoice typically required before Form M is processed.
- **Stackd enhancement:** Add "Pro-forma" invoice status to the status dropdown. Pro-forma invoices are identical in format but explicitly labelled as non-binding.

### 4.3 Currency
- Nigeria uses NGN (Naira) but international trade invoices are typically in USD.
- Stackd supports NGN and USD — correct. ✅

### 4.4 VAT (Nigeria)
- 7.5% VAT applicable on imports.
- Already available as a selectable tax rate in Stackd. ✅

---

## 5. Ghana

### 5.1 Import Regulations
- Ghana operates under **Ghana Revenue Authority (GRA)** and **Ghana Customs Division**.
- **UNIPASS** electronic customs system used for declarations.
- **Ghana Standards Authority (GSA)** certification required for certain product categories.
- Electrical goods may require **Energy Commission of Ghana** approval.

### 5.2 Invoice Requirements (Ghana)
- Standard commercial invoice requirements apply.
- **E-Invoice mandate:** Ghana is rolling out mandatory e-invoicing — monitor for applicability.

### 5.3 VAT (Ghana)
- Standard rate: 15% VAT + 2.5% NHIL + 1% GETFund levy = **18.5% effective rate**.
- For international trade invoices from FPM to Ghanaian buyers, zero-rated export rules typically apply (FPM is UK-based exporter).

---

## 6. China (Supplier Side)

### 6.1 Export Documentation
FPM's Chinese suppliers are responsible for export compliance. Key documents FPM should request:
- [ ] Commercial invoice (from supplier)
- [ ] Packing list
- [ ] Bill of Lading or Air Waybill
- [ ] Certificate of Origin (Form A or CO)
- [ ] Customs declaration (export)
- [ ] Product certifications (CE, CB, ROHS, REACH as applicable)

### 6.2 GACC Registration
For food products (e.g. salt-dried pollock), Chinese exporters must be registered with GACC (General Administration of Customs China). Verify supplier registration before placing food orders.

### 6.3 Switch B/L
FPM uses Switch Bills of Lading to protect supplier identity from buyers. This is standard practice — ensure the freight forwarder's entity is named as shipper on the original B/L.

---

## 7. Cross-Jurisdictional Considerations

### 7.1 Incoterms
Always specify Incoterms on every invoice. Incoterms determine:
- Who is responsible for freight costs
- Who bears the risk at each stage of shipment
- Import/export obligations

**Most common for FPM:**
| Incoterm | Meaning | FPM responsibility |
|----------|---------|-------------------|
| EXW | Ex Works | Buyer arranges all transport |
| FOB | Free On Board | FPM responsible to port of origin |
| CIF | Cost, Insurance, Freight | FPM responsible to destination port |
| DAP | Delivered at Place | FPM responsible to buyer's premises |

### 7.2 Transfer Pricing
As a sole trader intermediary, FPM's margin between supplier cost and buyer price constitutes its taxable profit. This is straightforward for UK Self Assessment. If FPM ever becomes a limited company with related party transactions, transfer pricing rules may apply.

### 7.3 Anti-Money Laundering (AML)
For high-value trade transactions, UK AML regulations may require:
- Know Your Customer (KYC) checks on buyers and suppliers
- Source of funds documentation for large transactions
- Suspicious Activity Reports if required

**Threshold awareness:** No fixed threshold for trade intermediaries but be aware of obligations under the Proceeds of Crime Act 2002 (POCA).

---

## 8. Stackd Ops Enhancement Register (Regulatory)

| ID | Enhancement | Jurisdiction | Priority | Version target |
|----|-------------|-------------|----------|---------------|
| REG-001 | VAT registration number field in Settings | UK | Medium | v2.4.0 |
| REG-002 | VAT invoice toggle (adds VAT number to invoice header) | UK | Medium | v2.4.0 |
| REG-003 | Financial year filter on invoice CSV export | UK | High | v2.4.0 |
| REG-004 | HS Code as dedicated field on Line Items (not just notes) | Barbados, Nigeria, Ghana | High | v2.4.0 |
| REG-005 | Incoterms field validation — enforce selection from standard list | All | Low | v2.5.0 |
| REG-006 | Pro-forma invoice status option | Nigeria | Medium | v2.4.0 |
| REG-007 | Landed cost calculator per line item (CIF × duty × VAT) | Barbados | Medium | v2.5.0 |
| REG-008 | Data retention policy field on buyer/supplier records | UK GDPR | Low | v2.5.0 |
| REG-009 | Buyer deposit receipt document (separate from invoice) | All | Low | v2.5.0 |
| REG-010 | Document checklist per shipment (CO, health cert, GACC etc.) | All | Medium | v3.0.0 |

---

## 9. Document Retention Requirements

| Document | UK requirement | Recommended retention in Stackd |
|----------|---------------|--------------------------------|
| Sales invoices | 6 years (VAT) / 5 years (Self Assessment) | Indefinite |
| Purchase orders | 6 years | Indefinite |
| Supplier records | 6 years | Indefinite |
| Shipping documents | 4 years (Customs) | Store in Google Drive, reference in PO notes |
| Bank records | 6 years | External — Stackd does not hold bank records |

---

## 10. Disclaimer

This document reflects the regulatory environment as understood at the time of writing (April 2026). Tax laws, import regulations, and compliance requirements change. FPM International should seek professional advice from a UK accountant familiar with international trade, and from in-country advisors in Barbados, Nigeria, and Ghana as trade volumes grow.
