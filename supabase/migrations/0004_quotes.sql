-- SPEC-CLOUD-004: extends the Cloud Data shared-database layer to Quote.
--
-- Quote lines (including nested priceHistory[] and source-traceability fields)
-- stay embedded as a single `lines` jsonb column, never promoted to child
-- tables — lines have no id of their own (`rid` is a client-generated string
-- never referenced by any other entity), so nothing outside the parent Quote
-- ever needs to resolve a nested line to a new value (REQ-CLOUD-004 §1.2).
--
-- `source_contact_id` is deliberately NOT foreign-key-constrained: Contact may
-- not have migrated at the point a Quote migrates, and a real FK constraint
-- here would reject that case. It is `text`, not `uuid`, for the same reason
-- every prior migration's equivalent column is `text` — a not-yet-migrated
-- Contact's local id is never RFC-4122 format.
--
-- `dt` is `text`, not `date` — the app stores and reads back a plain
-- unreformatted YYYY-MM-DD string via a bare <input type="date">.value,
-- never a JS Date object; `text` matches `valid_until`'s own typing.
--
-- `_demo` (the local-only demo-data marker) is deliberately excluded from
-- this schema, matching REQ-CLOUD-003 AC-1's identical precedent for Order
-- Request's `_demo`/`_backfilled` markers — it carries forward unchanged in
-- the local record only, never sent to Supabase.

create table quotes (
  id                 uuid primary key default gen_random_uuid(),
  num                text not null unique,
  client             text,
  dt                 text,
  valid_until        text,
  currency           text,
  freight_mode       text,
  markup             numeric,
  status             text not null,
  notes              text,
  lines              jsonb not null default '[]'::jsonb,
  linked_po_ids      jsonb not null default '[]'::jsonb,
  source_contact_id  text,
  calc_total_landed  numeric,
  calc_sell_usd      numeric,
  calc_sell_gbp      numeric,
  approved_by        text,
  approved_reason    text,
  approved_at        timestamptz,
  origin_charges     numeric,
  dest_charges       numeric,
  fpm_admin          numeric,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table quotes enable row level security;

create policy "authenticated read" on quotes for select using (auth.role() = 'authenticated');
create policy "authenticated write" on quotes for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on quotes for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
