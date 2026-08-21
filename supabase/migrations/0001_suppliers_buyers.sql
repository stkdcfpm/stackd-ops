-- SPEC-CLOUD-001: Supabase-backed shared data layer for Suppliers & Buyers.
-- Applied via the Supabase dashboard's SQL editor or CLI migration tooling at
-- project-setup time — not run by index.html at runtime.
--
-- Public sign-up must also be disabled separately, via the Supabase dashboard:
-- Settings -> Authentication -> Auth Providers. That step cannot be expressed
-- in this file (REQ-CLOUD-001h) — the RLS policies below are only safe once
-- self-registration is off, since the anon key is necessarily public.

create table suppliers (
  id           uuid primary key default gen_random_uuid(),
  num          text not null unique,
  name         text not null,
  country      text,
  contact_name text,
  email        text,
  phone        text,
  currency     text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);
create unique index suppliers_name_ci_idx on suppliers (lower(name)) where deleted_at is null;

create table buyers (
  id            uuid primary key default gen_random_uuid(),
  num           text not null unique,
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

alter table suppliers enable row level security;
alter table buyers enable row level security;

create policy "authenticated read" on suppliers for select using (auth.role() = 'authenticated');
create policy "authenticated write" on suppliers for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on suppliers for update using (auth.role() = 'authenticated');
create policy "authenticated read" on buyers for select using (auth.role() = 'authenticated');
create policy "authenticated write" on buyers for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on buyers for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
