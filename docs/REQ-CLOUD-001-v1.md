# REQ-CLOUD-001-v1: Supabase-Backed Shared Data Layer for Suppliers & Buyers

## Business Context

The operator wants a second person able to add/edit basic Supplier and Buyer information without giving them the app's single shared password and without the known limitations of the existing Google Sheets sync path (`SEC-GAP-011` — no conflict resolution, Sheets always wins on pull; `SEC-GAP-002` — PII leaves the browser with only an opt-in disclosure, no formal DPA). Buyers additionally has no Sheets sync mapping at all today (`BUY-GAP-001`) and no CSV import path — it's the one entity with zero shared-editing mechanism of any kind.

Market comparison (Cloudflare D1, Turso, Neon, Supabase — all free at this scale) concluded Supabase specifically, for one reason that matters more than any feature diff: **it's already the committed v3.0.0 migration target** (`STACKD_CONTEXT.md`: "v3.0.0 — Supabase backend, multi-tenancy, MFA, RBAC..."). Building this slice on Supabase means the work is the first real piece of that migration, not a second migration later on top of a throwaway D1/Turso build.

**This REQ is deliberately NOT v3.0.0.** Multi-tenancy, MFA, RBAC beyond "authenticated operator," and a server-side AI proxy remain out of scope, unchanged from the roadmap's stated v3.0.0 prerequisites. This REQ scopes exactly two entities — Suppliers and Buyers — as a bounded, reversible first step.

## Council Decision Required — this crosses FM-1, not covered by any existing exception

`docs/requirements-tracker.md`'s FM-1 exception register lists exactly three approved categories: (1) UI/AI features with no new entity, (2) new fields on an existing entity, (3) a new local-only entity with no Sheets sync. **None of these cover introducing an external, network-dependent, third-party-hosted database.** This is a materially different kind of change than anything FM-1's exceptions were written for — it adds a live network dependency to two entities that have never had one (Sheets sync is opt-in and batch; this REQ proposes live reads/writes), a new vendor relationship, and a new authentication surface.

This REQ is submitted for an explicit council/product-owner decision, not a self-granted exception — mirroring the precedent already set for `REQ-RPT-001 G-07` ("Req gate CONDITIONAL PASS — council gate required before spec"). Proceeding past this REQ's req-gate requires that decision to be made on the record, not assumed.

## Scope

**In scope:** `Supplier` and `Buyer` records only — read, create, update, soft-delete, by an authenticated operator.
**Explicitly out of scope:** every other entity (Line Items, Invoices, POs, Payments, Shipments, Quotes, Contacts, Order Requests, Events) — all remain `localStorage`-only, unchanged. Multi-tenancy. Public/customer-facing access. MFA. Role-based permission tiers beyond "authenticated = full read/write" (see Open Question 3). Any change to the existing app password gate for the rest of the app.

---

## 1. Data Architecture

### 1.1 Conceptual model

Two independent entities, no relationship between them (unchanged from today — `Supplier` and `Buyer` don't reference each other in the current schema either). Both are referenced *from* entities that stay local (`Quote.lines[].supId`, `PO.supId`, `Invoice.buyerId`, etc.) — those references don't move; the app continues resolving them by matching the `id`/`num` it already holds, just against a Supabase-sourced list instead of a `localStorage`-sourced one.

### 1.2 Logical model — table definitions

Mapped field-for-field from the actual current shapes (`saveSup()`, `index.html:4266-4276`; `saveBuy()`, `index.html:5434-5449`) — not reinvented:

```sql
create table suppliers (
  id           uuid primary key default gen_random_uuid(),
  num          text not null unique,        -- existing 'SUP-0001' business key, unchanged UX
  name         text not null,
  country      text,
  contact_name text,                        -- was `ct`
  email        text,
  phone        text,
  currency     text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                  -- soft delete, see §2.2
);
create unique index suppliers_name_ci_idx on suppliers (lower(name)) where deleted_at is null;

create table buyers (
  id            uuid primary key default gen_random_uuid(),
  num           text not null unique,       -- existing 'BUY-0001' business key
  name          text not null,
  contact_name  text,
  email         text,
  phone         text,
  address       text,
  currency      text,
  payment_terms text,
  credit_limit  numeric,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index buyers_name_ci_idx on buyers (lower(name)) where deleted_at is null;
```

**ID strategy decision:** primary key becomes a real `uuid` (Postgres/Supabase convention), not the app's current `uid()` string or the `'BUY' + Date.now()` pattern (`saveBuy()`/`quickAddBuyer()`, already flagged in `docs/data-model.md` as an inconsistent-with-`uid()` special case worth cleaning up). The existing human-readable `num` (`SUP-0001`/`BUY-0001`) is preserved as a separate, uniquely-indexed business key — the operator-facing reference number doesn't change at all, only what the database calls a row internally changes. `BUY-ADHOC`'s special sentinel status (§ existing code) needs an explicit migration decision — see Open Question 4.

### 1.3 Sync model — the decision that determines everything else

Two real options, not a false choice:

- **(A) Live source of truth.** The app reads/writes Suppliers and Buyers directly against Supabase — no local copy is authoritative, `DB.sup`/`DB.buy` become a live-fetched cache, not independently-saved state.
- **(B) Batch sync bridge**, matching the existing Google Sheets pattern — `localStorage` stays authoritative locally, periodic push/pull reconciles against Supabase.

**Recommendation: (A).** Option (B) would just rebuild `SEC-GAP-011` (no conflict resolution, last-write-wins) on a second backend — the entire reason to move off Sheets for these two entities. A real relational database with real transactions is what actually solves the multi-user conflict problem structurally; using it as just another batch-sync target throws that away. This is a genuine design decision, not a default — flagged explicitly for req-gate sign-off, not silently assumed.

---

## 2. Data Management Principles

**2.1 Ownership.** Once shipped, Supabase is the sole source of truth for Suppliers and Buyers. The local `DB.sup`/`DB.buy` arrays become a session cache populated on load/refresh, never independently saved to `localStorage` as the authoritative copy (though a *read-only* local cache surviving offline/between sessions is reasonable for display continuity — see Open Question 5).

**2.2 Retention/deletion.** Soft-delete only (`deleted_at`), not `DELETE FROM`. Matches the audit-trail spirit already established for `DB.events`, and avoids reproducing the accidental-data-loss risk `BACKUP-GAP-001` already documents for the current architecture. `delSup()`'s existing pre-delete warning (linked PO/invoice counts, `index.html:4277-4288`) is preserved unchanged — soft-delete doesn't remove the need to warn the operator what's affected.

**2.3 Backup/recovery.** Supabase's own backup mechanism (exact free-tier retention window to be confirmed against current Supabase docs before build — not asserted here) is a floor, not the only safety net. The existing JSON export DR procedure (`docs/dr-procedure.md`) is extended to include a Suppliers/Buyers export pulled from Supabase at export time, so a full-portal backup remains genuinely complete — this REQ doesn't create a second, unbacked-up data island.

**2.4 Audit trail.** `created_at`/`updated_at` columns (above) are the DB-layer authoritative record — they can't be skipped by a missed client-side call the way `logEv()` can be (`logEv()` is a normal function call, not enforced; a code path that forgets to call it just silently doesn't log, as already true for every other entity). The existing `DB.events` log continues to record supplier/buyer create/update/delete events for in-app activity display, but the DB timestamps are the ground truth if the two ever disagree.

**2.5 GDPR data flow.** Supplier `contact_name`/`email`/`phone` and Buyer `contact_name`/`email`/`phone` are personal data about a named individual — this REQ does not change what's captured (identical fields to today), but does change *where it's stored*: authoritatively in a third-party cloud database, not just optionally synced. This requires, before build: (a) explicit Supabase project region selection — recommend an EU region given FPM is UK-based, not a US default; (b) the same DPA-diligence standard already applied to Anthropic (`docs/known-gaps.md` CHAT-GAP-001) and Google/Cloudflare (`SEC-GAP-002`) — Supabase publishes a standard DPA, to be confirmed accepted before any real contact data is written; (c) an in-product disclosure note, matching the existing pattern in Settings for the Sheets sync and forwarder webhook cards.

---

## 3. Security

**3.1 Row Level Security — mandatory, not optional.** RLS enabled on both tables from creation (Supabase tables are exposed via a REST API by default; RLS is the only thing between "authenticated operator" and "anyone with the anon key"). Given this is an internal tool for a small, known set of trusted operators (not customer-facing), the policy shape is deliberately simple rather than over-engineered: any authenticated user may `select`/`insert`/`update`; no policy permits hard `delete` from the client — soft-delete is an `update` setting `deleted_at`, enforced by having no delete grant at all, not by convention.

```sql
alter table suppliers enable row level security;
alter table buyers enable row level security;

create policy "authenticated read" on suppliers for select using (auth.role() = 'authenticated');
create policy "authenticated write" on suppliers for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on suppliers for update using (auth.role() = 'authenticated');
-- (mirrored for buyers; no delete policy on either table)
```

**3.2 Auth strategy.** Supabase Auth, operator-created accounts (email/password or magic link) — not open signup. This is a genuine improvement opportunity worth naming: today's single shared `AUTH_HASH` password gate (`index.html`) means every action is attributed to a generic `'operator'`/`'user'` string in `logEv()` — real per-person Supabase accounts would be the first time this app has actual individual identity, which the audit trail (§2.4) can then use meaningfully. This REQ scopes only Suppliers/Buyers access via Supabase Auth — it does not replace the existing app-wide password gate, which stays as-is for everything else.

**3.3 Key handling — a hard rule, not a preference.** Only the Supabase **anon key** may ever appear in client code (safe by design — RLS is the actual boundary, not key secrecy). The **service-role key must never be used anywhere in this app** — it bypasses RLS entirely, and since this is a 100%-client-side, no-build-step, no-server app, there is no legitimate place a service-role key could be used safely. This isn't a "for now" caveat; it's a permanent constraint of the architecture, the same class of accepted limitation already documented for the Anthropic API key (`SEC-GAP-003`).

**3.4 Transport.** HTTPS-only, Supabase default. No CSP change needed — `index.html`'s existing policy already allows `connect-src https:` broadly (`SEC-GAP-008`'s CSP), so Supabase's API domain is already permitted without loosening anything.

---

## 4. Data Quality

**4.1 Constraints, not just client-side checks.** `NOT NULL` on `name`; unique case-insensitive index on `name` (§1.2) enforcing the same dedup rule `saveSup()`/`saveBuy()` already apply client-side (`index.html:5437`'s duplicate-name check) — as a DB constraint, not only a client check, since RLS permits any authenticated user to call the API directly, not only through this app's own validation code. Defense in depth: client-side `vSup()`/`vBuy()`-style validation stays as the first, friendlier line; the DB constraint is the backstop that can't be bypassed.

**4.2 Referential integrity to local entities.** `Quote.lines[].supId`, `PO.supId`, `Invoice.buyerId`, etc. stay as plain string fields in `localStorage` — they now hold a Supabase `uuid` instead of a local `uid()` string, but the *shape* of the reference (an opaque ID string) is unchanged from the app's perspective. No FK constraint from Supabase back into `localStorage` is possible (different databases) — this is an accepted, unavoidable limitation of the split architecture, not a defect to fix here.

---

## 5. Scalability

At current and reasonably foreseeable scale (a handful of operators, low hundreds of Supplier/Buyer records), this is a non-issue — Supabase's connection pooling is automatic and the free tier's limits (confirmed separately: 500MB storage, ~2M rows typical) aren't remotely approached by two small reference tables. Not over-engineered for a scale this app isn't at.

---

## Requirements

**REQ-CLOUD-001a:** Supplier and Buyer CRUD operations read/write Supabase directly (§1.3 option A), not through a batch sync bridge.
**REQ-CLOUD-001b:** Both tables enforce RLS with no client-reachable hard-delete path (§3.1).
**REQ-CLOUD-001c:** Only the anon key is ever present in client code; the service-role key is never used anywhere in this codebase (§3.3).
**REQ-CLOUD-001d:** Deletion is soft (`deleted_at`), preserving `delSup()`'s existing pre-delete warning behavior for linked-record counts (§2.2).
**REQ-CLOUD-001e:** DB-level `created_at`/`updated_at` are the authoritative audit record; `DB.events` logging continues unchanged as the in-app activity display (§2.4).
**REQ-CLOUD-001f:** A case-insensitive unique constraint on `name` exists at the DB layer for both tables, in addition to (not instead of) existing client-side dedup checks (§4.1).
**REQ-CLOUD-001g:** Every other entity remains `localStorage`-only — this REQ makes no change to Line Items, Invoices, POs, Payments, Shipments, Quotes, Contacts, Order Requests, or Events.

## Acceptance Criteria

- AC-001: With RLS enabled and no delete policy granted, an attempt to `DELETE` a row via the Supabase client library fails — confirmed against a live test project, not assumed from the policy definition alone.
- AC-002: Two authenticated sessions (simulating two operators) editing different Supplier records simultaneously both persist correctly with no silent overwrite — the structural test that RLS + real transactions actually solves `SEC-GAP-011`'s problem, not just relocates it.
- AC-003: Creating a Supplier with a name matching an existing (non-deleted) Supplier, case-insensitively, is rejected at the DB layer even when the client-side check is bypassed (simulated via a direct API call).
- AC-004: `delSup()`'s linked-PO/invoice warning dialog still shows accurate counts against Supabase-sourced Supplier data.
- AC-005: A grep/code-audit of the shipped `index.html` confirms zero occurrences of a Supabase service-role key or any string resembling one.

## Open Questions for Req-Gate / Council Decision

1. **The council decision itself** — does the product owner approve crossing FM-1 for this specific, bounded scope (Suppliers + Buyers only, explicitly not the rest of the app)? This REQ cannot proceed to spec-gate without that being answered on the record, not inferred from the conversation that produced this draft.
2. **Supabase project region and DPA acceptance** — needs confirming against current Supabase terms before any real contact data is written, not assumed favorable.
3. **RLS granularity** — is "any authenticated operator can edit any row" actually acceptable long-term, or does even this small a team want per-user row ownership (e.g., only the creator or an admin can edit)? Recommended as simple/permissive for this REQ's scale, but stated as a recommendation, not decided unilaterally.
4. **`BUY-ADHOC` migration** — the existing seeded sentinel Buyer (`seedAdHocBuyer()`) needs an explicit decision: migrate it as a real row with a stable known `id`, or keep ad-hoc/unassigned buyers as a local-only concept not represented in Supabase at all.
5. **Offline/cache behavior** — if Supabase is unreachable (network issue), does the app show stale cached Supplier/Buyer data read-only, block editing entirely, or something else? Not specified here — needs a decision before spec-gate, since "live source of truth" (§1.3) has a real availability tradeoff the app's current fully-local architecture never had to consider.
