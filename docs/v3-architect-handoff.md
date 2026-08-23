# Stackd — v3.0.0 Architect Handoff

**Purpose of this document:** everything a freelance data architect needs to scope the v3.0.0 rebuild — the stated target being a Supabase backend, real multi-tenancy, MFA, RBAC, a server-side API proxy, and referral mechanics. This is a handoff for scoping and technical design, not a finished spec — several of the open questions below are genuine forks that need an architect's judgment or a business decision, not a predetermined answer.

Prepared: 23 August 2026, against `main` @ `fcd912f` (v2.9.57, 521/521 tests passing).

---

## 1. The business, in brief

- **Product:** Stackd — a trade operations platform for sole traders to mid-size firms managing international trade (sourcing, quoting, purchase orders, invoicing, shipment tracking).
- **Founding client / proof of concept:** FPM International Ltd, a Brighton-based trade intermediary sourcing from Chinese manufacturers and supplying Caribbean markets (primarily Barbados).
- **ICP:** UK-based sole traders to micro-firms sourcing from Asia, selling into the Caribbean and West Africa, expanding toward UK–Nigeria, UK–Ghana, UK–India corridors.
- **Wedge feature:** live shipment visibility without needing a human to chase it — this is what gets operators to sign up. Everything else is what keeps them.
- **Design principle (non-negotiable):** "Automation First" — every feature is evaluated on whether it removes manual work or just moves it around.
- **Pricing tiers already defined** (business-side, not yet technically enforced anywhere in the code):

| Tier | Price | Users | Key threshold |
|------|-------|-------|---------------|
| Starter | £49/mo | 1 | Up to 5 active shipments |
| Growth | £149/mo | Up to 3 | Unlimited shipments + API tracking |
| Scale | £399/mo | Up to 10 | Supplier portal + MTD |
| Enterprise | Custom | Unlimited | Not shown on the pricing page |

This pricing table is the clearest signal of what "multi-tenancy" needs to mean here: **other trade operators become paying tenants of one shared product**, each with their own isolated Suppliers/Buyers/Quotes/Invoices/etc., seat limits, and feature gates by tier — not just FPM's internal team using the tool. That has direct implications for the tenant model (see §4).

---

## 2. Current technical state — what actually exists today

**The entire application is a single static file with no backend.**

```
index.html            — the whole app: HTML + CSS + JS in one file (~850 KB), no build step, no framework
tests/run.js          — 521 Node.js tests, run in a Node VM sandbox against the same file
tests/fixtures.js     — shared test fixtures
apps-script/Code.gs   — Google Apps Script webhook handler (the only "backend" that exists — Sheets sync)
cloudflare-worker/worker.js — a CORS proxy in front of the Apps Script endpoint (no auth of its own)
vendor/supabase-js-v2.min.js — vendored Supabase JS client (same-origin static file, no CDN)
supabase/migrations/0001_suppliers_buyers.sql — the one Supabase schema that exists (see §3)
```

- **Hosting:** static GitHub Pages, custom domain `app.getstackdops.com`. **The entire repository is publicly readable** — there is a standing rule (learned the hard way, see SEC-GAP-020 below) that no live data, backups, or PII may ever be committed to it.
- **Data model:** everything lives in the browser's `localStorage`, per-browser, per-device. Ten entity types: Suppliers, Line Items (product catalogue), Invoices, Purchase Orders, Payments, Shipments, Quotes, Contacts, Buyers, Order Requests — plus a local-only Activity event log. All shapes are informally defined in code (`DB.*` arrays, `FIELD_MAPS` for the Sheets-sync subset) — **there is no formal schema document**; the closest thing to one is reading `tests/fixtures.js` and `FIELD_MAPS` in `index.html`, or the field lists in `docs/known-gaps.md`.
- **Sync (not sharing):** an optional one-way-per-action Google Sheets sync exists via the Apps Script + Cloudflare Worker path, for cross-device convenience at a single-operator scale. It is not a real multi-user data layer — no conflict resolution, no isolation, "Sheets wins" on pull.
- **Auth:** a single shared app password gates the whole portal. That's it — no per-user accounts, no roles, no MFA anywhere in the current stack.
- **AI Assistant:** an in-app chat calls the Anthropic API directly from the browser, using an API key the operator pastes into Settings and that sits in `localStorage`. This is a known, accepted gap (SEC-GAP-003) and exactly the kind of thing a server-side proxy is meant to fix.
- **Test suite as behavior spec:** `tests/run.js` (521 tests) is the closest thing this project has to an executable specification. Whatever the v3.0 migration does, this suite describes exactly what today's behavior is — worth treating as a reference for "did we accidentally change this" during any rebuild, even though the tests themselves are written against the old architecture and won't survive verbatim.

---

## 3. The existing Supabase pilot — real prior art, not a starting schema

In v2.9.54 (REQ/SPEC-CLOUD-001), a first, deliberately narrow Supabase integration shipped: **Settings → Cloud Data** lets an operator connect Suppliers and Buyers — those two entities only — to a shared Supabase project, so more than one browser/device sees the same records.

**What this proves:** the app can talk to Supabase, a vendored `@supabase/supabase-js` client works fine under the existing CSP, and a real backup-gated, one-time migration path (with automatic FK remapping across Quotes/POs/Line Items/Contacts/Invoices, and a 30-day local rollback archive) is achievable from this codebase.

**What this does *not* answer, and why it's not a template to copy:**
- It is **one shared table pair behind Row Level Security that grants any authenticated user full read/write access.** There is no tenant/org column anywhere, no per-customer data isolation, and no role distinction — anyone who signs in sees everyone's Suppliers and Buyers. This is fine for "does the plumbing work" but is the opposite of what multi-tenancy needs.
- Every other entity (Quotes, Invoices, POs, Contacts, Order Requests, the event log — 8 of 10 entity types) is still local-only, per-browser.
- The migration SQL (`supabase/migrations/0001_suppliers_buyers.sql`) is worth reading for the soft-delete pattern used (`deleted_at`, no hard delete, no delete RLS policy) — that convention should probably carry forward, but the schema itself will need a full redesign for tenant isolation.
- This pilot went through 4 independent requirements-gate rounds and 4 independent spec-gate rounds before build — each round caught a genuine defect (an incomplete FK remap, a design that would have gated the whole app behind Supabase login instead of just two entities, fabricated precedent claims, a missed second buyer-creation code path, a restore that didn't actually hold). The review history is in `docs/requirements-tracker.md` under `REQ-CLOUD-001` if useful context on what kinds of mistakes were made and caught the first time a server dependency was introduced into this codebase.

---

## 4. Open questions only the architect (or the business) can resolve

These are genuine forks, not gaps in this document:

1. **Tenant isolation model.** Fully isolated per-tenant schemas/databases, or a shared-schema-plus-RLS model (extending the pattern already piloted in §3, but now with a real `tenant_id`/`org_id` on every table and RLS policies that actually check it)? This is the single biggest architectural decision and should probably be made first, since it shapes everything else.
2. **Auth model and MFA.** Today there is one shared app password and, separately, a Supabase login gate for Cloud Data only. v3.0 needs real per-user accounts. Does each tenant organization have its own users, or is a user global across tenants (e.g., one person consulting for two trade operators)? What MFA method (TOTP, WebAuthn, SMS) fits the ICP (sole traders / micro-firms, likely non-technical)?
3. **RBAC role definitions.** No roles exist today. What are the actual roles this product needs — owner, operator, read-only/viewer, accountant, something else? Is RBAC per-tenant-org (most likely, given the pricing tiers) or does it also need a platform-admin tier (FPM/Stackd staff support access)?
4. **Server-side API proxy scope.** At minimum this needs to solve SEC-GAP-003 (Anthropic key in browser localStorage) — but does it also need to proxy Sheets sync (for tenants who still want that), and does the AI Assistant's tool-use loop move server-side entirely, or just the credential?
5. **Referral mechanics.** This appears nowhere in the codebase, the gap register, or the requirements tracker. It's a pure product/business decision with zero existing technical precedent — the architect will need this defined by the business before it can be scoped technically, not derived from anything in this repo.
6. **Migration path for existing FPM data.** FPM's own live data is currently a single browser's `localStorage`. Data volume is genuinely small (a handful of operators, not thousands of records) — the migration itself is low-risk data-wise, but it's the proof case for whatever tenant-onboarding flow gets designed for every subsequent customer.
7. **Hosting and budget.** The current deployment is static GitHub Pages — free, zero-maintenance, but structurally incompatible with a server-side proxy or a real multi-tenant backend. Supabase itself hosts the database/auth, but a server-side proxy needs compute somewhere (Supabase Edge Functions, a small serverless function host, or a real app server) — this has direct cost and hosting-provider implications the business needs to weigh in on.
8. **Compliance runway.** ICO registration is listed as "required before first external client" and still backlogged; Terms & Conditions / Privacy Policy are backlogged for "before v3.0.0 launch." These aren't technical blockers to *building* v3.0 but are launch blockers worth the architect knowing about, since a multi-tenant SaaS product has materially higher compliance stakes than FPM's current single-operator internal tool.

---

## 5. Known gaps v3.0 is specifically meant to close

Full detail in `docs/known-gaps.md` (~500 lines) — these are the ones most directly relevant to the v3.0 scope:

| ID | Gap | Why it matters for v3.0 |
|----|-----|--------------------------|
| **R-001** | localStorage GDPR exposure — all data lives in the operator's browser, no server-side control, backup, or access governance | This is the core reason a real backend is needed at all |
| **SEC-GAP-003** | Anthropic API key stored in browser localStorage, sent directly from the browser | Exactly what the server-side API proxy needs to fix |
| **SEC-GAP-004** | Invoice status locking is a client-side UX control only, not tamper-proof (bypassable via DevTools/localStorage edit) | A real backend can make this an actual enforced control, not just UX |
| **SEC-GAP-011** | No timestamp-based conflict resolution in the current Sheets sync — "Sheets wins," accepted only at current single-operator scale | Multi-tenant, multi-user-per-tenant concurrent editing needs real conflict handling, not this |
| **SEC-GAP-002 / SEC-GAP-005** | PII (supplier contacts, buyer details, forwarder contacts) transmitted to Google Sheets / a forwarder webhook with no formal DPA and only an in-product disclosure notice | Becomes a *formal* compliance obligation the moment there's a first external paying client — which v3.0 is explicitly for |
| **BUY-GAP-001** | Buyers entity was deliberately never given a Sheets sync mapping — held under a hard freeze ("FM-1": no new Sheets sync mappings on the localStorage stack, precisely because v3.0's Supabase migration is meant to be the real exit path) | Confirms the team has already been building *around* this migration for months, not just talking about it |
| **REQ-RPT-001 G-07 (MTD-GAP-001)** | Input VAT tracking (HMRC MTD VAT Return Boxes 4 & 7) reached requirements-gate CONDITIONAL PASS but was explicitly deferred rather than built against the pre-Supabase stack, specifically because a proper audit trail and server-side validation only exist after this migration | A concrete example of a real, live compliance gap that's been deliberately parked waiting for this project |
| **SEC-GAP-020** *(fully resolved, included for context)* | The entire repo — including a live data export and a PII table — was briefly publicly exposed via GitHub Pages before remediation (history purged, GDPR-assessed non-reportable) | Establishes why "never commit live data to this public repo" is a hard rule the architect should also follow for anything they produce during scoping (sample data, schema dumps, etc.) |

---

## 6. Where to go for more depth

- `docs/known-gaps.md` — full gap register (~500 lines), organized by area, each with area/logged-date/detail/decision.
- `docs/requirements-tracker.md` — every shipped feature's full requirements-gate → spec-gate → build-gate review history, the FM-1 exception register, and the full backlog of deferred/unscoped items (including the `REQ-RPT-001 G-01`–`G-10` reporting/compliance items, several explicitly deferred to v3.0.x).
- `docs/REQ-CLOUD-001-v3.md` / `docs/SPEC-CLOUD-001-v4.md` — the full requirement and implementation spec for the existing Supabase pilot described in §3.
- `docs/version-history.md` — the complete version-by-version changelog.
- `docs/dr-procedure.md` — current disaster-recovery/backup procedure (relevant baseline for whatever v3.0's real backup story becomes).
- `STACKD_CONTEXT.md` (repo root) — the single cross-tool master context document this handoff was drawn from; kept current after every version delivery.
- The live app itself: `app.getstackdops.com` — the fastest way to see current behavior firsthand, including the Cloud Data pilot in Settings.

---

*Prepared by Claude Code against `stkdcfpm/stackd-ops` @ `main` (`fcd912f`, v2.9.57). Code-level facts above were verified directly against source and a live test run, not recalled from memory — treat the business-side facts in §1 as last-known rather than independently re-verified here.*
