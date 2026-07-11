# Stackd Ops — Full Trade Lifecycle Workflow (BPMN-style, Mermaid)

Swimlanes = entities (`DB` keys). One diagram, left-to-right, covering every entity's actual lifecycle and every handoff between entities, as currently implemented in `index.html`. The proposed **Order Request** lane (SPEC-ORD-001, not yet built) is included as a dashed/dotted lane so the target-state workflow is visible alongside what's live today — do not read it as shipped.

Sources verified against live code: Contact `status` (`saveCon()`), Quote `status` (`saveQte()`, `openConvertToQuote()`, `qteToPoConvert()`, QTE-GAP-001 guard), PO `status` (real `<select id="po-sm">` options: Draft/Sent/Deposit Paid/Settled/Cancelled — **not** the stale AI-prompt text "Confirmed/In Production/Shipped/Completed", which does not match the actual dropdown), Invoice `STATUS_ORDER`/`LOCKED_STATUSES` (`index.html:2180-2181`), Credit Note statuses (CN Draft/CN Issued/CN Applied, type-discriminated on the same `inv` table), Shipment `RD_SHP_STATUS` (`index.html:2507`), Buyer (`saveBuy()`/`quickAddBuyer()`/`seedAdHocBuyer()`), Payment (`savePayment()`), Event Log (`logEv()`, cross-cutting sink for every other lane).

```mermaid
flowchart LR

    %% ── CONTACT LANE ─────────────────────────────────────────
    subgraph LANE_CON["CONTACT (DB.con)"]
        direction LR
        C1([New enquiry\nemail/WeChat/trade show/AI chat]) --> C2[Create Contact\nstatus: lead]
        C2 --> C3{Dedup check\nemail match?}
        C3 -- existing --> C3m[Merge enquiry\ninto existing record]
        C3 -- new --> C4[status: qualified]
        C4 --> C5{"> 700 days\nno activity?"}
        C5 -- yes --> C5s[STALE badge\nCON-GAP-001]
        C5 -- no --> C6[status: converted]
        C6 --> C7[status: closed]
    end

    %% ── ORDER REQUEST LANE (PROPOSED — SPEC-ORD-001, not yet built) ──
    subgraph LANE_ORD["ORDER REQUEST (DB.ord) — PROPOSED, NOT SHIPPED"]
        direction LR
        O1([ord: New]):::proposed --> O2[Qualifying\nactions list]:::proposed
        O2 -- accepted --> O3[Quoted\nactiveQuoteId set]:::proposed
        O2 -- rejected --> O2d[Declined]:::proposed
        O3 -- accepted --> O4[Converting]:::proposed
        O3 -- rejected --> O3d[Lost]:::proposed
        O4 --> O5[Processing]:::proposed
        O5 --> O6[Fulfilled\nrealisedMargin computed]:::proposed
    end

    %% ── QUOTE LANE ───────────────────────────────────────────
    subgraph LANE_QT["QUOTE (DB.qt)"]
        direction LR
        Q1[Create Quote\nsourceContactId set] --> Q2[status: Draft]
        Q2 --> Q3[status: Sent]
        Q3 --> Q4{Feasibility check\nDG / container / electrical}
        Q4 --> Q5{Buyer decision}
        Q5 -- Accepted --> Q6[status: Accepted\nConvert to PO button appears]
        Q5 -- Declined --> Q7[status: Declined]
        Q5 -- no response --> Q8[status: Expired]
        Q6 --> Q9[qteToPoConvert\nQTE-GAP-001 hard guard:\nonly from Accepted]
        Q9 --> Q10["PO RAISED" badge\nlinkedPOId set]
    end

    %% ── SUPPLIER LANE ────────────────────────────────────────
    subgraph LANE_SUP["SUPPLIER (DB.sup)"]
        direction LR
        S1[Create Supplier\nnum: SUP-0001] --> S2[Linked from\nLine Items / PO / Quote lines]
        S2 --> S3[Supplier→Contact\nsub-panel, optional]
    end

    %% ── LINE ITEM LANE ───────────────────────────────────────
    subgraph LANE_LI["LINE ITEM / CATALOGUE (DB.li)"]
        direction LR
        L1[Create Line Item\nnum: LI-0001\ncost / price / HS code] --> L2[priceHistory\nversioned on change]
        L2 --> L3[Used on Invoice\nvia Import from Library]
        L2 --> L4[Used on PO / Quote line]
    end

    %% ── PURCHASE ORDER LANE ──────────────────────────────────
    subgraph LANE_PO["PURCHASE ORDER (DB.po)"]
        direction LR
        P1[Create PO\nfrom Quote conversion\nor manual] --> P2[status: Draft]
        P2 --> P3[status: Sent]
        P3 --> P4[status: Deposit Paid]
        P4 --> P5[status: Settled]
        P2 -.-> P6[status: Cancelled]
        P5 --> P7[invId/invNum linked\nwhen matched to an Invoice]
    end

    %% ── INVOICE / CREDIT NOTE LANE ───────────────────────────
    subgraph LANE_INV["INVOICE / CREDIT NOTE (DB.inv)"]
        direction LR
        I1[Create Invoice\nbuyerId, line items,\nIncoterm, Payment Terms] --> I2[status: Draft]
        I2 --> I3[status: Pro-forma]
        I3 --> I4[status: Sent\nLOCKED — read-only]
        I4 --> I5[status: Partially Paid\nLOCKED]
        I5 --> I6[status: Paid\nLOCKED]
        I4 -.-> I7[status: Cancelled\nLOCKED]
        I4 -.->|Settings→Advanced\nCONFIRM+reason, logEv| I2
        I6 --> ICN{Credit Note\nneeded?}
        ICN -- yes --> ICN1[CN Draft\ntype: credit_note/goodwill_credit] --> ICN2[CN Issued] --> ICN3[CN Applied\nreduces buyer balance]
    end

    %% ── PAYMENT LANE ─────────────────────────────────────────
    subgraph LANE_PM["PAYMENT (DB.payments)"]
        direction LR
        M1[Record Payment\nagainst Invoice] --> M2{Balance check}
        M2 -- partial --> M3[Invoice auto-flips\nto Partially Paid]
        M2 -- full --> M4[Invoice auto-flips\nto Paid]
    end

    %% ── SHIPMENT LANE ────────────────────────────────────────
    subgraph LANE_SH["SHIPMENT (DB.sh)"]
        direction LR
        H1[Create Shipment\nref, linkedInvs[] business-key array] --> H2[Booked] --> H3[Confirmed] --> H4[In Transit]
        H4 --> H5[At Origin Port] --> H6[At Destination Port] --> H7[In Customs] --> H8[Out for Delivery] --> H9[Delivered]
        H4 -.-> H10[Delayed]
        H4 -.-> H11[On Hold]
        H1 -.-> H12[Cancelled]
    end

    %% ── BUYER LANE ───────────────────────────────────────────
    subgraph LANE_BUY["BUYER (DB.buy)"]
        direction LR
        B1[Create Buyer\nnum: BUY-0001\nor quick-add from Invoice form] --> B2[Linked via buyerId\non Invoices]
        B2 --> B3[Buyer Statement\ntotal invoiced / paid / outstanding]
        BADHOC[BUY-ADHOC sentinel\nseeded on init/restore,\nnever deleted]
    end

    %% ── EVENT LOG LANE (cross-cutting sink) ──────────────────
    subgraph LANE_EV["EVENT LOG (DB.events) — cross-cutting"]
        direction LR
        E1[logEv per lane:\ncreated / updated / status_changed /\nnote_added / deleted / converted]
        E2[2,000-event FIFO cap\nEVT-GAP-001: no warning on drop]
    end

    %% ── CROSS-LANE HANDOFFS ──────────────────────────────────
    C2 -.->|"→ Quote" action\npre-fills client/email| Q1
    C6 -.->|contact converts\non quote save| Q6
    O3 -.->|proposed: same handoff\nvia ordConvertToQuote| Q1

    S2 -.-> L1
    S2 -.-> P1
    L3 -.-> I1
    L4 -.-> P1
    L4 -.-> Q1

    Q10 -.->|PO auto-generated\nfrom Quote| P1
    I1 -.->|"invNum match"\nlinks PO to Invoice| P7
    P7 -.->|realised margin chain\niCalc gp/np| O6

    B1 -.-> I1
    I5 -.-> M1
    I6 -.-> M1
    I1 -.->|invoice num added to\nlinkedInvs array| H1

    C2 -.-> E1
    Q1 -.-> E1
    S1 -.-> E1
    P1 -.-> E1
    I1 -.-> E1
    M1 -.-> E1
    B1 -.-> E1
    O1 -.-> E1

    classDef proposed fill:none,stroke:#8B1A2F,stroke-dasharray: 5 5,color:#8B1A2F;
```

## Reading this diagram

- **Solid arrows** = a real, currently-shipped code path (function call, status transition, FK write). **Dashed arrows** = either an optional/conditional path (e.g. Cancelled, Delayed) or a cross-lane handoff.
- **The Order Request lane is entirely dashed-outline** (`classDef proposed`) — it is SPEC-ORD-001's design, not yet built. Every other lane reflects the live `index.html` implementation as of v2.9.43.
- **PO status corrected here vs. `AI_SYSTEM_PROMPT`:** the AI system prompt currently describes PO status as "Draft → Sent → Confirmed → In Production → Shipped → Completed" (`index.html:6553`), but the actual `<select id="po-sm">` options (`index.html:1796`) are **Draft, Sent, Deposit Paid, Settled, Cancelled**. This diagram uses the real dropdown values. The `AI_SYSTEM_PROMPT` text appears to be stale/inaccurate and should be corrected in a future version — logging this as a candidate gap (`AI-GAP-009`, not yet formally raised) is recommended rather than silently carrying the discrepancy forward.
- **Two FK conventions coexist**, per `docs/data-model.md`'s own documented inconsistency: most cross-lane links are internal-`id`-based (`sourceContactId`, `supId`, `buyerId`, `linkedPOId`), but PO↔Invoice (`invId` **and** `invNum`, redundant) and Shipment↔Invoice (`linkedInvs[]`, an array of `inv.num` business-key strings, not IDs) are business-key-based. This diagram's cross-lane arrows follow whichever convention each real link actually uses.
- **Credit Notes share the Invoice lane's table** (`type` discriminator on the same `DB.inv` array), not a separate `DB` entity — shown as a sub-flow within the Invoice lane rather than its own swimlane, matching the actual data model.
