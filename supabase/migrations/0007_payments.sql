-- SPEC-CLOUD-008: extends the Cloud Data shared-database layer to Buyer Payment and
-- Supplier Payment (Phase 3 sub-phase 3 of 3). One migration file, two independent
-- tables — mirrors 0002_line_items_contacts.sql's shape (REQ-CLOUD-008 §0.2), not
-- 0001's combined-table exception.
--
-- inv_id/po_id are deliberately NOT foreign-key-constrained and stay plain `text`,
-- matching every other cross-entity reference column in this series — even though,
-- uniquely among every entity migrated so far, neither value is ever remapped at
-- insert time (Invoice/Purchase Order already completed their own, separate, prior
-- migrations by the time either of these tables' own migration can run — REQ §0.3/
-- §1.4). Carried through verbatim.
--
-- buyer_payments.currency/purpose/rate_lock/type/cre_at are all independently
-- NULLABLE — REQ-INTEG-002-2c added purpose/currency/rateLock/type/creAt after this
-- ledger's own genesis shape, so a legacy pre-2c local record, and both of saveInv()'s/
-- saveCN()'s goodwill-credit pushes (which never set any of these five fields), are
-- real, currently-reachable record shapes this table must accept as-is (AC-1).
--
-- buyer_payments.ref (distinct from `reference`) preserves the goodwill-credit pushes'
-- own, narrower field verbatim, matching the ledger's own already-accepted, not-fixed-
-- here reference/ref display quirk (REQ §1.3, REQ-INTEG-002-2c §3) rather than merging
-- it into `reference` or silently dropping it.
--
-- supplier_payments.currency/purpose/rate_lock/type/cre_at are all NOT NULL — every
-- creation path for this ledger (addSupPaymentFromForm(), the only one) unconditionally
-- sets all five; there is no legacy-record or secondary-creation-path gap on this side
-- (REQ §1.3, AC-1).
--
-- Neither table has a `num`/reference-number field of any kind — no pre-flight
-- duplicate-number scan is needed for either ledger (REQ-CLOUD-008d), and no unique
-- constraint beyond the primary key is added.

create table buyer_payments (
  id          uuid primary key default gen_random_uuid(),
  inv_id      text,
  inv_num     text,
  date        text,
  amount      numeric,
  method      text,
  purpose     text,
  currency    text,
  rate_lock   jsonb,
  reference   text,
  ref         text,
  notes       text,
  type        text,
  cre_at      timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table supplier_payments (
  id          uuid primary key default gen_random_uuid(),
  po_id       text,
  po_num      text,
  date        text,
  amount      numeric,
  currency    text not null,
  purpose     text not null,
  method      text,
  reference   text,
  notes       text,
  rate_lock   jsonb not null,
  type        text not null default 'supplier_payment',
  cre_at      timestamptz not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

alter table buyer_payments    enable row level security;
alter table supplier_payments enable row level security;

create policy "authenticated read"   on buyer_payments    for select using (auth.role() = 'authenticated');
create policy "authenticated write"  on buyer_payments    for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on buyer_payments    for update using (auth.role() = 'authenticated');
create policy "authenticated read"   on supplier_payments for select using (auth.role() = 'authenticated');
create policy "authenticated write"  on supplier_payments for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on supplier_payments for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
