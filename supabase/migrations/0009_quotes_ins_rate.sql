-- REQ/SPEC-QTE-003: adds a nullable numeric column to the existing quotes
-- table for the per-quote Insurance Rate % override, mirroring the existing
-- origin_charges/dest_charges/fpm_admin override columns (0004_quotes.sql).
-- Additive only — no backfill, no data migration, no change to any existing
-- column or constraint. Null on every pre-existing row, meaning "inherit the
-- current QR.insRate global default," resolved live on every cQte() call
-- exactly like the three existing overhead overrides.
--
-- The per-line override (line.insRate) needs no schema change — it rides
-- inside the pre-existing `lines` jsonb column alongside line.markup.

alter table quotes
  add column ins_rate numeric;
