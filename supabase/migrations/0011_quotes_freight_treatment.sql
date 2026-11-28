-- REQ/SPEC-QTE-006: freight shown as its own line on the customer quote.
-- Additive only — two nullable columns on the existing quotes table, no backfill,
-- no change to any existing column or constraint.
--   freight_treatment: null = 'included in line prices' (every pre-existing row);
--                      'separate' | 'excluded' otherwise.
--   freight_amount:    null = no typed amount (estimate from CBM rates is used when
--                      treatment is 'separate'); a number overrides the estimate.
--
-- DEPLOY ORDER: apply this migration BEFORE the v2.9.107 app reaches any user with
-- Cloud Data configured, and confirm the PostgREST schema cache has the new columns
-- (PGRST204 = not yet). The new client sends both columns on every Cloud quote
-- write; un-migrated, saveQte toasts 'Save failed' but persistQteChange() only logs,
-- so status changes / PO links silently fail to persist.
-- Like 0009/0010 this is not idempotent (no IF NOT EXISTS): a re-run errors loudly.

alter table quotes
  add column freight_treatment text,
  add column freight_amount numeric;
