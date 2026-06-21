# Stackd Product Roadmap

**Document status:** Live  
**Last updated:** 2026-06-21  
**Council source:** `docs/councils/2026-06-21-saas-trajectory.md`  
**Current version:** v2.9.27 (single-tenant localStorage, GitHub Pages)  
**Target:** v3.0 — commercially launchable multi-tenant SaaS

---

## Strategic Context

Stackd began as an internal trade operations portal for FPM International — a single-file, localStorage-only tool with no backend, no auth, and no multi-tenancy. It now has a complete operational feature set across 8 entities: suppliers, product catalogue, invoices (with credit notes), POs, payments, shipments, quotes, and contacts/CRM.

The commercialisation thesis: **small-to-mid importers lose margin because they don't know their true all-in landed cost until the invoice arrives.** Stackd already solves this better than anything in the market for that persona. The v3.0 mandate is to take that thesis to a second paying customer.

**Target persona for v3.0:** Small-to-mid importers (not freight forwarders, not in-house procurement teams — those are different products).

---

## Phase Overview

| Phase | Scope | Target | Success Signal |
|---|---|---|---|
| **Pre-v3.0 (now)** | PMF validation | 5 customer interviews | 2/5 describe landed cost confusion unprompted |
| **v3.0 Alpha** | Architecture migration | FPM on v3.0 | Zero data loss cutover, FPM operational |
| **v3.0 Beta** | Second operator | 1 non-FPM operator | Second operator using portal for live operations |
| **v3.0 GA** | First commercial contract | 1 paying customer | Signed agreement, recurring revenue |
| **v3.1** | Growth features | Shareable quote portal | Network effect measurable |

---

## Immediate Pre-v3.0 Actions (Before Any Code)

These must happen before any architecture work begins. The council was unanimous.

### 1. Customer Interview Programme
- **Owner:** Founder
- **Target:** 5 non-FPM importers or small freight forwarders
- **Method:** 30-minute calls; do NOT show the product first
- **Script questions (draft):**
  1. Walk me through how you calculate your landed cost before you commit to a PO.
  2. Has that number ever been wrong by the time the invoice arrived? What happened?
  3. What tools are you currently using to manage supplier relationships and orders?
  4. If you could change one thing about that process, what would it be?
  5. What would a tool have to do for you to pay £X/month for it?
- **Gate:** ≥2/5 describe landed cost confusion in their own words → commercial signal → proceed to v3.0. Fewer than 2 → revisit thesis before building.

### 2. Commercial Baseline Audit
- **Owner:** Founder
- **Output:** Document what FPM currently pays (or would pay) for the fragmented tools Stackd replaces: spreadsheets, Freightos/similar, any TMS, any CRM.
- **Purpose:** This is the price anchor. Without it, every pricing conversation is speculative.

### 3. Design Partner Outreach
- **Owner:** Founder
- **Target:** 3–5 operators willing to use v3.0 Beta (even free) in exchange for feedback
- **Timing:** Identify during interview programme; formalise after PMF signal confirmed

---

## v3.0 Architecture — Scope (Locked)

### Must Be In
| Item | Rationale |
|---|---|
| Auth — Clerk or Supabase Auth (not DIY) | Table stakes for any B2B sale |
| Multi-tenancy — `org_id` on every table from day one | Highest-risk irreversible decision; retrofit = full rewrite |
| All 8 existing entities ported cleanly to Postgres | Feature parity is the job; no new features in v3.0 |
| Colleague invite ("invite a team member") | Will come up on every sales call; blocks every deal without it |
| FPM data migration with zero data loss | FPM is the only reference customer; a botched migration ends the story |
| New test suite (API + integration) | Existing 213 tests are localStorage-coupled and become dead weight post-migration |

### Must Be Left Out of v3.0
| Item | Reason |
|---|---|
| Shareable quote portal | Requires foundation first; park for v3.1 |
| EDI integration | Integration tarpit — 6 months for marginal v3.0 value |
| Xero/accounting deep sync | Already exists in v2.x; don't over-engineer for v3.0 launch |
| AI features (new) | Not a v3.0 differentiator; port existing capability only |
| New CRM features | Port what exists; validate with second operator before expanding |
| Customs filing integration | Out of scope until v4.x |

---

## v3.0 Technical Decisions

### Architecture Stack (decided — REQ-010 in Requirements Tracker)

| Layer | Decision | Notes |
|---|---|---|
| Framework | Next.js | Full-stack; API routes + server components |
| Database | PostgreSQL via Supabase | Row-level security (RLS) for multi-tenancy |
| Auth | Supabase Auth | Decided in REQ-010; do not introduce Clerk or DIY auth |
| Schema migrations | Supabase Migrations (SQL) | Versioned; schema-first approach |
| Hosting | Supabase + Vercel | Supabase for DB/auth; Vercel for Next.js deployment |
| Frontend | Port existing HTML/JS → Next.js pages | Incremental migration; do not rewrite UI from scratch in v3.0 |

*Note: The council discussed FastAPI generically but REQ-010 (Requirements Tracker, 2026-05-xx) records the decision as Next.js + Supabase. This roadmap aligns to that decision.*

### Schema Principle
Every table carries `org_id` (tenant identifier) and `updated_at`. Row-level security enforces tenant isolation at database level — not just application level. This is non-negotiable; retrofitting post-launch is a full rewrite.

### Multi-tenancy Pattern
```sql
-- Every entity table
CREATE TABLE invoices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES orgs(id),
  ...
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-level security
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (org_id = current_setting('app.current_org_id')::uuid);
```

### Data Migration Path (FPM localStorage → Postgres)
The existing export/import JSON pipeline (`expAll` / `doImport`) is the seed of the migration tool. Extend it:
1. Export FPM's full localStorage snapshot as versioned JSON (already works)
2. Write a migration script that validates each entity, maps to Postgres schema, checks referential integrity, and reports errors before writing
3. Run against a staging Postgres instance; verify all 7 invoices, 9 suppliers, 20 line items, 4 payments, 2 shipments, 1 quote import cleanly
4. Only then migrate production
5. Keep localStorage version running in parallel for 2 weeks post-cutover as fallback

---

## 12-Month Roadmap

### Months 1–2: Foundation
- [ ] Customer interview programme complete (5 interviews, gate decision)
- [ ] Commercial baseline audit complete
- [ ] Auth provider decision (Clerk vs Supabase) — by end of week 1
- [ ] Postgres schema designed with `org_id` on every table — by end of week 2
- [ ] Auth spike: one user logs in, sees only their data, saves a record to Postgres
- [ ] Data migration script written and validated against FPM's data
- [ ] FastAPI repo scaffolded; `GET /invoices` endpoint working end-to-end
- [ ] New test suite begun (replace localStorage VM harness with API integration tests)

### Months 3–4: FPM Cutover (The Real Milestone)
- [ ] All 8 entities ported to Postgres with full test coverage
- [ ] Colleague invite working (multi-user within one org)
- [ ] FPM data migrated to v3.0 staging — zero data loss verified
- [ ] FPM operational on v3.0 for 2 weeks without issues
- [ ] localStorage version decommissioned for FPM
- [ ] Design partner #1 onboarded (free, feedback agreement)

### Months 5–6: Second Operator Validation
- [ ] Design partner #1 using portal for live operations
- [ ] Weekly feedback sessions; gap log updated
- [ ] Identify 2 features design partner says are blocking or mission-critical
- [ ] Design partner #2 onboarded if available
- [ ] Pricing model drafted based on commercial baseline + willingness to pay signals

### Months 7–9: First Commercial Contract
- [ ] Product gaps from design partner #1 resolved
- [ ] First commercial contract signed (even pilot pricing)
- [ ] Billing integration (Stripe) added
- [ ] CRM/supplier-contact linkage (sprint item A from council session)
- [ ] Event log / audit trail (sprint item B from council session)
- [ ] Gate evidence trail moved from chat to Git artefacts (SDLC-GAP-002)

### Months 10–12: Growth Features
- [ ] Shareable quote portal (v3.1 feature — supplier/customer accepts quote via URL)
- [ ] Whatever the second operator's pain turned out to be
- [ ] getstackdops.com updated with v3.0 positioning and pricing page
- [ ] ICO registration reviewed; DPA status confirmed for all third-party integrations

---

## v3.1+ Backlog (Post-GA, Not v3.0 Scope)

| ID | Feature | Rationale |
|---|---|---|
| RD-001 | Shareable quote portal | Network effect; v3.1 after foundation proven |
| RD-002 | Supplier → Contact linkage | Traceability across quotes, POs, invoices to named people |
| RD-003 | Event log / audit trail | Append-only per-entity log; feeds data management policy |
| RD-004 | Automatic backup / scheduled export | BACKUP-GAP-001 remaining item |
| RD-005 | Contacts hard dedup enforcement | CON-GAP-002; dealbreaker at scale |
| RD-006 | Same-origin PR preview environment | SDLC-GAP-003; deferred post-pilot |
| RD-007 | Timestamp-based sync conflict resolution | SEC-GAP-011 / SYNC-GAP-001 architectural fix |
| RD-008 | Gate evidence trail in Git | SDLC-GAP-002; required before ICO registration |
| RD-009 | Make.com Flow D — sprint context auto-update | Automate STACKD_CONTEXT.md updates on merge |

---

## Open Questions (Blocking v3.0 Design)

| Question | Owner | Deadline |
|---|---|---|
| Auth: Clerk or Supabase? | CTO/Founder | Week 1 |
| Hosting: Supabase, Railway, Render, or Fly.io? | CTO/Founder | Week 2 |
| Pricing model: per-seat, per-org, usage-based? | CPO/Founder | Month 2 |
| Which vertical do 2/5 interviewees represent? | Founder | Month 1 |
| Does FPM have a budget to formalise (i.e. would they pay)? | Founder | Month 1 |

---

## Document History

| Date | Change |
|---|---|
| 2026-06-21 | Initial version — created from LLM Council verdict (2026-06-21-saas-trajectory.md) |
