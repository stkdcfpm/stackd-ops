-- SPEC-CLOUD-003: extends the Cloud Data shared-database layer to Order Request.
--
-- Order Request Lines and their nested RFQ Responses stay embedded as a single
-- `lines` jsonb column, never promoted to child tables — nothing outside the
-- parent Order Request needs to resolve a nested child id to a new value after
-- migration (REQ-CLOUD-003 §1.2). `contact_id` and `active_quote_id` are
-- deliberately NOT foreign-key-constrained: Contact may not have migrated (and
-- Quote is not Cloud-Data-eligible at all yet) at the point an Order Request
-- migrates, and a real FK constraint here would reject exactly the case
-- REQ-CLOUD-003's AC-2 requires to work (an install where Contact has never
-- been Cloud-migrated).
--
-- Both columns are `text`, NOT `uuid` (spec-gate round-1 B1 finding): uid()
-- (index.html:2788) mints local ids like "lz3k9a1x2", never RFC-4122 format,
-- and every Contact created before Contact's own Cloud migration, plus every
-- Quote for the entire lifetime of this sub-phase (Quote migration is
-- REQ-CLOUD-004, still future), carries an id in that shape. A `uuid`-typed
-- column would reject those values outright with "invalid input syntax for
-- type uuid" on the very first insert/update that references one.

create table order_requests (
  id               uuid primary key default gen_random_uuid(),
  num              text not null unique,
  contact_id       text,
  stage            text not null,
  description      text,
  actions          jsonb not null default '[]'::jsonb,
  active_quote_id  text,
  outcome          jsonb,
  lines            jsonb not null default '[]'::jsonb,
  import_batch_id  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

alter table order_requests enable row level security;

create policy "authenticated read" on order_requests for select using (auth.role() = 'authenticated');
create policy "authenticated write" on order_requests for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on order_requests for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
