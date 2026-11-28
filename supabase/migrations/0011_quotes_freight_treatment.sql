-- REQ/SPEC-QTE-006: freight shown as its own line on the customer quote.
-- Additive only — two nullable columns on the existing quotes table, no backfill,
-- no change to any existing column or constraint.
--   freight_treatment: null = 'included in line prices' (every pre-existing row);
--                      'separate' | 'excluded' otherwise.
--   freight_amount:    null = no typed amount (estimate from CBM rates is used when
--                      treatment is 'separate'); a number overrides the estimate.
--
-- DEPLOY ORDER: apply this migration BEFORE the v2.9.107 app reaches users with
-- migrated quotes — the new client sends both columns on every Cloud quote save,
-- so every save would fail on unknown columns until this is applied.

alter table quotes
  add column freight_treatment text,
  add column freight_amount numeric;
