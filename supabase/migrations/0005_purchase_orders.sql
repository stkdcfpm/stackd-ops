-- SPEC-CLOUD-005: extends the Cloud Data shared-database layer to Purchase Order.
--
-- Column list resolved against the union of every field savePO() (index.html:8034),
-- autoPos() (index.html:7035), and qteToPoConvert() (index.html:12367-12376) build
-- into a `po` object (REQ-CLOUD-005 §2a) — this is the first entity in this series
-- assembled from three different creation paths with slightly different field sets,
-- rather than one save function.
--
-- `sup_id`/`inv_id`/`quote_id` are deliberately NOT foreign-key-constrained: the
-- referenced entity may not have migrated (or, for Invoice, is not Cloud-eligible at
-- all yet) at the point a Purchase Order migrates. All three are `text`, not `uuid`,
-- for the same reason every prior cross-entity reference in this series is — a
-- not-yet-migrated entity's local id is never RFC-4122 format.
--
-- `date` is `text`, not `date` — matches Quote's `dt` precedent exactly: a bare
-- <input type="date">.value string, never a JS Date object, never reformatted.
--
-- `cre_at`/`upd_at` are two independent, both-nullable timestamptz columns, not one:
-- autoPos() sets `creAt` and never `updAt`; savePO() sets `updAt` and never `creAt`.
-- These reflect the app's own save-time bookkeeping and are distinct from Postgres's
-- own `created_at`/`updated_at` (insert-time only, not touched on UPDATE, matching
-- every prior migration's identical, if slightly misleading, convention).
--
-- `_demo` is deliberately excluded from this schema, matching REQ-CLOUD-003/004's
-- identical precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  num              text not null unique,
  sup_id           text,
  inv_num          text,
  inv_id           text,
  date             text,
  del              text,
  cur              text not null,
  payment_terms    text,
  line_items       jsonb not null default '[]'::jsonb,
  dep              numeric,
  fpm_funded       numeric,
  fpm_recovered    boolean,
  oth              numeric,
  notes            text,
  status           text not null,
  upd_at           timestamptz,
  cre_at           timestamptz,
  quote_id         text,
  quote_num        text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

alter table purchase_orders enable row level security;

create policy "authenticated read" on purchase_orders for select using (auth.role() = 'authenticated');
create policy "authenticated write" on purchase_orders for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on purchase_orders for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
