-- SPEC-SHIP-002: adds two nullable jsonb columns to the existing shipments
-- table for real id-based invoice linking (linkedInvIds[]) and a compact
-- DG/port snapshot per linked invoice (linkedInvSnapshots[]). Additive only —
-- no backfill, no data migration, no change to any existing column or
-- constraint. Both columns are null on every pre-existing row;
-- refreshShFromSupabase() (index.html) leaves the corresponding local field
-- absent (not []) when the column is null, same `!= null` guard pattern as
-- trade_docs/auto_created_from_inv_ids (0008_shipments_trade_docs.sql).

alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
