-- SPEC-CLOUD-007: extends the Cloud Data shared-database layer to Shipment.
--
-- Column list resolved 1:1 against the fields saveShp() (index.html:12074-12094)
-- builds into its `shp` object — the ONLY function that ever pushes onto or
-- mutates DB.sh besides loadDemoData()'s local-only demo seed (REQ-CLOUD-007
-- §1.1a/§1.4). Unlike every prior entity in this series, there is no second
-- source of extra fields (no CSV-import-only field, no unlock/edit-audit field,
-- no calc-snapshot field) to reconcile against.
--
-- `ref` is `text not null unique`, manually entered, with no format check
-- anywhere and no case-normalization (docs/architecture-data-model-v1.md:124) —
-- REQ-CLOUD-007c's own pre-flight duplicate-ref scan (§2.1) is what keeps a
-- migration from ever hitting this constraint, exactly as every prior entity's
-- own num/ref uniqueness constraint depends on its own pre-flight scan.
--
-- `etd`/`eta` are `text`, not `date` — matches every prior entity's identical
-- <input type="date">.value convention (Quote's `dt`, Purchase Order's `date`,
-- Invoice's `date`/`expiry`/`ship_date`) — never a JS Date object, never
-- reformatted.
--
-- `linked_invs` is `jsonb not null default '[]'::jsonb` — a free-text array of
-- Invoice NUMBERS, not ids, confirmed never dereferenced against DB.inv anywhere
-- in the app (REQ-CLOUD-007 §1.1b). Matches Quote's `linked_po_ids` jsonb-array
-- precedent (supabase/migrations/0004_quotes.sql) in column shape only — unlike
-- that column, this one is never FK-adjacent even informally, since it never
-- held ids in the first place. NOT foreign-key-constrained and never will be:
-- Invoice-number matching against this field happens client-side only, never as
-- a database constraint (AC-1).
--
-- linkedInvs is also the only array-valued field in any FIELD_MAPS entry in the
-- whole app; mapRec()/unmapRec() are asymmetric for it (SH-GAP-002, logged not
-- fixed — REQ-CLOUD-007 §3), so migrateShToSupabase()'s own insert loop (§2.2)
-- defensively coerces it to an array before ever reaching this column
-- (REQ-CLOUD-007i-1) rather than relying on the column default alone.
--
-- `upd_at` is `timestamptz`, set by saveShp() on every save, both create and
-- update — unlike Purchase Order, there is no second creation path with a
-- different timestamp convention, so no cre_at/upd_at asymmetry exists here;
-- one nullable column is sufficient (loadDemoData()'s demo seed never sets it).
--
-- `_demo` is deliberately excluded, matching every prior entity's identical
-- precedent — it carries forward unchanged in the local record only, never
-- sent to Supabase.

create table shipments (
  id                 uuid primary key default gen_random_uuid(),
  ref                text not null unique,
  bl_num             text,
  vessel             text,
  carrier            text,
  origin_port        text,
  dest_port          text,
  etd                text,
  eta                text,
  container_type     text,
  container_num      text,
  dg                 boolean,
  docs_status        text,
  status             text not null,
  linked_invs        jsonb not null default '[]'::jsonb,
  forwarder          text,
  forwarder_email    text,
  notes              text,
  upd_at             timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

alter table shipments enable row level security;

create policy "authenticated read" on shipments for select using (auth.role() = 'authenticated');
create policy "authenticated write" on shipments for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on shipments for update using (auth.role() = 'authenticated');
-- deliberately no delete policy — soft-delete only, enforced by omission
