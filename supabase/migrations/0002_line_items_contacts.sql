-- SPEC-CLOUD-002: extends the Cloud Data shared-database layer (SPEC-CLOUD-001)
-- to Line Item and Contact.
--
-- Deliberately NOT following 0001's unique-name-index pattern for either table:
-- line_items.sku is non-unique by design (REQ-CLOUD-002e; docs/data-model.md:37),
-- and Contact has no hard uniqueness constraint today (soft email dedup only,
-- CON-GAP-002) which this migration must not silently turn into a hard one.

create table line_items (
  id             uuid primary key default gen_random_uuid(),
  num            text not null unique,
  sku            text,
  "desc"         text,
  specs          text,
  hs             text,
  sup_id         uuid not null references suppliers(id),
  uom            text,
  cost           numeric,
  price          numeric,
  currency       text,
  notes          text,
  dg             boolean not null default false,
  dims           jsonb,
  price_history  jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create table contacts (
  id                 uuid primary key default gen_random_uuid(),
  num                text not null unique,
  name               text not null,
  email              text not null,
  phone              text,
  company            text,
  status             text,
  source             text,
  gdpr_basis         text,
  created_at         timestamptz not null default now(),
  last_contacted_at  timestamptz,
  enquiries          jsonb not null default '[]'::jsonb,
  notes              text,
  supplier_id        uuid references suppliers(id),
  role               text,
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table line_items enable row level security;
alter table contacts   enable row level security;

create policy "authenticated read" on line_items for select using (auth.role() = 'authenticated');
create policy "authenticated write" on line_items for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on line_items for update using (auth.role() = 'authenticated');
create policy "authenticated read" on contacts for select using (auth.role() = 'authenticated');
create policy "authenticated write" on contacts for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on contacts for update using (auth.role() = 'authenticated');
-- deliberately no delete policy on either table — soft-delete only, enforced by omission
