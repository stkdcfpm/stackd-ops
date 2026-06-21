# Council Session — Stackd SaaS Product Trajectory

**Date:** 2026-06-21  
**Trigger:** Founder intent to commercialise Stackd as a B2B SaaS product; v3.0 as architecture inflection point  
**Questions put to council:**
1. Right product scope for v3.0 to be genuinely competitive
2. Highest-risk architectural decisions in localStorage→FastAPI/PostgreSQL migration
3. CRM/order management capabilities that are table-stakes and currently missing
4. Credible 12-month roadmap from v2.9.27 to commercially launchable v3.0
5. Artefacts to prioritise first

---

## Advisor Responses

### The Contrarian
The fatal flaw nobody is naming: you're describing a migration to a product category that's already commoditised. TradeGecko (now QuickBooks Commerce), Cin7, Unleashed, Skubana, Linnworks — these aren't startups. They've spent 10+ years and tens of millions solving exactly this problem. The v3.0 scope question is irrelevant until you answer why a trade operator would pick you over them. "We're cheaper" is not a moat. "We're better" requires proof you don't have yet.

On architecture risk specifically: The localStorage→PostgreSQL migration isn't just technical debt — it's a data integrity crisis waiting to happen. Zero schema enforcement, no referential integrity, no audit trail, and dangling foreign keys already in known-gaps. The pullAll() overwrites-unconditionally pattern is a data loss event in a multi-tenant context.

The missing question on CRM: Contacts dedup enforcement is a dealbreaker for procurement managers. The roadmap should start with 3–5 design partners, not a FastAPI migration. Prove the wedge before you build the platform.

### The First Principles Thinker
The question being asked is wrong. You're not asking "what should v3.0 contain?" — you're asking "how do I rebuild what I have but bigger?" That is a product death march. Strip it back. What problem does Stackd actually solve? One operator's coordination overhead across freight, procurement, and payments. Core value: single source of truth for a trade operation.

The right first-principles question: what is the smallest thing a second customer would pay for? You do not have product-market fit. You have one user. Every hour on multi-tenant FastAPI before validating that a second operator will pay is waste. The architecture risk is not technical — it is that you build the wrong product at scale.

Before writing a single PRD: get three non-FPM trade operators to describe their workflow without seeing the product. The real first artefact is a one-page problem statement validated by non-FPM operators.

### The Expansionist
The biggest mistake would be building v3.0 as a feature-parity migration — that's a commodity play. The hidden upside: this product already has a working landed cost calculator, quote versioning, and CRM pipeline integrated. Most trade SaaS tools in the £200-500/mo range don't do all three. The wedge is margin intelligence for importers — know your true landed cost before committing to a PO, not after receiving the invoice.

For v3.0 scope, the expansion bet: ship a shareable quote portal (a URL a supplier or customer can view/accept without an account). That transforms this from internal ops tool to network product. Leave out: Xero/accounting sync, EDI, customs filing — integration tarpits. Make the data model multi-tenant from day one with tenant_id on every table.

The 12-month moonshot: quote-to-PO with shareable link = skeleton of a trade network — Faire/Alibaba wedge at SME level.

### The Outsider
The curse of knowledge is already baked into the product name. "Trade operations portal" means nothing to someone outside freight. Pick one buyer persona — "importers, freight forwarders, AND procurement managers" is three different products.

The architectural killer: localStorage data with no migration path. If FPM can't import their records cleanly into v3.0, you lose your only reference customer before launch.

The feature buyers ask about in demo call minute two: "can my colleague log in?" Multi-user access — not multi-tenant, just colleague login. Don't write PRDs yet. Write one customer interview script. Talk to five non-FPM freight forwarders. First artefact: validated problem statement from people who haven't shaped the product.

### The Executor
Monday morning: stop scoping v3.0, start with a working auth spike. Everything is academic until you prove one user can log in, see only their data, and save a record to Postgres.

Highest-risk architectural move: the data migration. Every entity needs org_id. Design that schema wrong and you rewrite joins across every query. Do it first.

What must be in v3.0: auth (Clerk or Supabase), multi-tenancy, existing 8 entities ported, invite-a-colleague. Nothing else. Get a second operator on v3.0 by month 4. First artefacts in order: (1) Postgres schema with org_id on every table, (2) auth provider decision, (3) FastAPI repo scaffolded with one working endpoint. Everything else follows.

---

## Peer Review Summary

All 5 reviewers independently selected **The Executor (B)** as the strongest response for its concrete sequenced deliverables and testable milestones.

All 5 reviewers identified **The Expansionist (A)** as having the biggest blind spot: the shareable quote portal requires auth, multi-tenancy, and data integrity first — it skips the foundation and pitches the penthouse. The Faire/Alibaba comparison was called a category error; B2B trade network effects require trust infrastructure that cannot be bootstrapped from a GitHub Pages app.

---

## Council Verdict

### Where the Council Agrees

- **Validate before you build.** PMF evidence precedes platform investment. A second paying customer is the forcing function that matters more than any architectural decision.
- **Multi-tenancy schema (`org_id`) is the highest-risk irreversible decision.** Get it wrong and you rewrite joins across every query for the lifetime of the product.
- **FPM's live data migration is a first-class crisis, not a footnote.** A botched or lossy migration from localStorage JSON to Postgres ends the commercial story before it starts. All 5 peer reviewers flagged this independently.
- **Colleague login ("can my colleague log in?") is the single feature that will come up on every sales call.** It is the minimum viable unlock for any B2B sale.

### Where the Council Clashes

- **Competitive position:** The Contrarian said the category is commoditised; peer reviewers pushed back — Cin7 and Linnworks are inventory-first, not landed-cost-first. The niche is real but unproven at commercial scale.
- **Shareable quote portal:** Genuine differentiator (Expansionist) vs. premature moonshot (4/5 reviewers). Resolved: park as v3.1, not v3.0.
- **First artefact — auth spike vs. migration script:** Run in parallel, not sequentially.

### Blind Spots the Council Caught

1. **The 213-test suite becomes dead weight** at FastAPI migration. The entire test harness is localStorage-coupled. Rebuilding the safety net is unbudgeted and must appear in the roadmap before feature work begins.
2. **The commercial baseline is missing.** What does FPM currently pay for fragmented tools Stackd replaces? That number is the price anchor and the proof of willingness to pay. It should be the first artefact.
3. **FPM cutover continuity.** FPM is live and operational. A FastAPI cutover means either a freeze or a dual-system parallel-write period. The existing export/import pipeline is the seed of the migration tool — extend it into a proper validated migration tool with rollback.
4. **"Trade operator" is three different products.** Importer, freight forwarder, and procurement manager have different workflows and willingness-to-pay profiles. v3.0 must pick one.

### The Recommendation

Pick one persona. Build v3.0 for **importers only** — specifically, small-to-mid importers who currently manage landed cost calculations in spreadsheets and lose margin because they don't know their true all-in cost until the invoice arrives. That is the problem Stackd already solves better than anything in the market.

Scope v3.0: auth (Clerk or Supabase Auth), multi-tenancy with `org_id` on every table, the existing 8 entities ported with a clean Postgres schema, colleague invite, and nothing else.

**12-month shape:**
- Months 1–2: Data migration script + Postgres schema design + auth spike (parallel)
- Months 3–4: FPM cuts over to v3.0 with zero data loss and zero operational downtime (the milestone)
- Months 5–6: Second operator on the platform (even free), generating the second data point
- Months 7–9: First commercial contract, informed by what the second operator actually used
- Months 10–12: Shareable quote portal and second operator's identified pain

Do not begin writing PRDs or API schemas until you have spoken to five non-FPM importers and at least two have described, unprompted, the landed cost confusion problem.

### The One Thing to Do First

Write a five-question customer interview script and book calls with five non-FPM importers or small freight forwarders — before touching the codebase, before scaffolding FastAPI, before writing a schema. Ask how they currently calculate landed cost before committing to a PO, where they've lost margin because the number was wrong, and what tool they wish existed. Two of five describing the Stackd problem in their own words = commercial signal. Fewer than two = v3.0 as currently conceived is the wrong product.

---

## Action Status

| Item | Status | Notes |
|---|---|---|
| Council transcript saved | ✓ Done | This file |
| Sprint items logged to known-gaps.md | ✓ Done | V3-GAP-001 through V3-GAP-005 |
| Product roadmap created | ✓ Done | `docs/product-roadmap.md` |
| Customer interview script | ☐ Pending | Owner: founder; target: 5 non-FPM importers this week |
| Commercial baseline audit | ☐ Pending | What does FPM currently pay for tools Stackd replaces? |
| Design partner outreach | ☐ Pending | 3–5 operators; do not show product first |
