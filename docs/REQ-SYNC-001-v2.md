# REQ-SYNC-001-v2: Fix pullAll() field-mapping and identity loss (SYNC-GAP-001)

**Supersedes:** REQ-SYNC-001-v1 (requirements-gate PASS, two non-blocking tightening notes folded in below)

## Business Context

(Unchanged from v1 — see that document's Business Context section for the full root-cause grounding: `pullAll()` never reverse-translates Sheet header-keyed rows back to internal field names, and 5 of 9 synced entities have no `id`-mapped column in `FIELD_MAPS` at all.)

## FM-1 Assessment

(Unchanged from v1 — confirmed by requirements-gate against `STACKD_CONTEXT.md`: FM-1's freeze targets *new* FIELD_MAPS entries/Sheets tabs/sync mappings; this REQ adds none, only fixes existing mapping/merge logic.)

## Requirements

**REQ-SYNC-001**: Add `unmapRec(entity, sheetRec)`, inverse of `mapRec()`, translating Sheet-header-keyed fields back to internal names for every entity with a `FIELD_MAPS` entry. Apply to every record from `sGet()` before merging into `DB`, for `inv`, `cn`, `po`, `sup`, `li`, `payments`, `sh`, `qt`, `co`.

**General merge rule (new in v2, addresses gate note on ambiguity)**: for any merged record, a field tracked in `FIELD_MAPS` takes the Sheets-sourced value (existing "Sheets wins" precedent, `SEC-GAP-011`); any local field *not* present in that entity's `FIELD_MAPS` (e.g. `li.priceHistory`, `li.invoiceRefs`, `inv.lineItems`/`inv.pos`/`calc_*` per the existing special-cased preservation, any other untracked field) survives verbatim from the local record when a match is found. A pulled record with no local match keeps only what the Sheet provided (untracked fields absent, same as any new record built via any other creation path in the app).

**REQ-SYNC-002**: For entities with no `id` mapping in `FIELD_MAPS` (`li`, `sh`, `inv`, `po`, `cn`, `qt`), change `pullAll()`'s merge/match key from `.id` to each entity's business key:
   - `li`: `sku` if present, else `desc`+`supId` (mirrors `processImportRecords()`, `index.html:6549-6552`).
   - `sh`: `ref`.
   - `inv`/`cn`/`po`/`qt`: `num`.

   On a business-key match, the merged record keeps the **local record's `id`** and applies the general merge rule above for every other field. On no match, treat as new and assign a fresh `id` via `uid()`.

   **New in v2 (addresses gate note on the inner `.find()` lookups)**: this business-key switch applies to *every* place `pullAll()` currently looks up a local counterpart for these five entities — not just the outer dedup/merge step, but also the existing inline preservation lookups already in `pullAll()` for `inv` (`index.html:3347`: `DB.inv.find(function(r){ return r.id === invPulled[ii].id; })`) and `po` (`index.html:3382`: `DB.po.find(function(r){ return r.id === poPulled[pi].id; })`). Both must be rewritten to find by `num` instead of `.id`, or the existing `lineItems`/`pos`/`calc_*` preservation logic silently stops finding a match and no-ops post-fix, since the pulled record's `.id` remains permanently absent for these entities even after `unmapRec()`.

**REQ-SYNC-003**: `sup`, `payments`, `co` (which do have an id-mapped column) continue to merge by `.id`, now correctly populated via `unmapRec()`.

**REQ-SYNC-004**: No change to the push direction (`mapRec()`, `syncAll()`, `handleBulkUpsert()`) — pull-only fix.

## Acceptance Criteria

- AC-001: `unmapRec('li', {'SKU':'ABC','Description':'Widget','Unit Cost':10,'Unit Price':12,'Currency':'USD','HS Code':'','Supplier':'sup1','Notes':''})` → `{sku:'ABC', desc:'Widget', cost:10, price:12, cur:'USD', hs:'', supId:'sup1', notes:''}`.
- AC-002: Pulling a Sheets Line Item matching a local one by `sku` preserves the local `id`, `priceHistory`, `invoiceRefs` (untracked fields, per the general merge rule), while adopting Sheets-sourced `desc`/`cost`/`price`.
- AC-003: Pulling a Sheets Invoice matching a local one by `num` preserves the local `id`, `lineItems`, and `calc_*` fields via the existing preservation logic at `index.html:3346-3358`, now correctly triggered because the inner `.find()` at `3347` matches by `num` instead of a permanently-absent `.id`. Same for PO at `3381-3385`/`3382`.
- AC-004: A genuinely new Sheets row (no local business-key match) is assigned a fresh `id` and merges in as new.
- AC-005: Regression test using the actual corrupted-backup shape (header-keyed blank stub, e.g. `{'Supplier ID':'','Name':'',...,num:'SUP-0055'}`) — after `unmapRec()`, every field is empty under its correct internal name, and this record does not spuriously match any real local Supplier by business key (empty `name`/`sku`/`ref`/`num` never matches a populated field).
- AC-006: `sup`/`payments`/`co` merge correctly by `.id` after `unmapRec()` (regression).
- AC-007: No change to any push-direction test (`mapRec()`, `syncAll()`).

## Residual Risks (logged, not blocking)

(Unchanged from v1 — see that document: SYNC-GAP-001's retroactive-repair caveat, already handled via the one-off cleaned-backup remediation; and the adjacent, out-of-scope `FIELD_MAPS.sup` `contact`/`ct` key mismatch and phantom `payTerms`/`leadTime`/`dgCapable` keys, recommended for a separate gap entry rather than fixing here.)

## Changelog

- v2: Folded in requirements-gate's two non-blocking notes — added an explicit general merge rule (FIELD_MAPS-tracked fields take Sheets value, untracked fields survive verbatim) instead of leaving it to be inferred per-entity from the ACs; made explicit that the existing inline `.find()` preservation lookups for `inv`/`po` (not just the outer merge/dedup step) must also switch from `.id` to business-key comparison.
- v1: Initial draft, requirements-gate PASS.
