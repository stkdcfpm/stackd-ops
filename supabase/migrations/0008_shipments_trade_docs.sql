-- SPEC-SHIP-001: adds two nullable jsonb columns to the existing shipments
-- table for the auto-created trade-document checklist. Additive only — no
-- backfill, no data migration, no change to any existing column or
-- constraint. Both columns are null on every pre-existing row; refreshShFromSupabase()
-- (index.html) leaves the corresponding local field absent (not []) when the
-- column is null, per REQ-SHIP-001a's "absent for pre-existing records" rule.

alter table shipments
  add column trade_docs jsonb,
  add column auto_created_from_inv_ids jsonb;
