# REQ-SYNC-001-v1: Fix pullAll() field-mapping and identity loss (SYNC-GAP-001)

## Business Context

`docs/known-gaps.md`'s `SYNC-GAP-001` (logged 2026-07-12, confirmed against a real corrupted user backup on the same date) documents that the two-way "⟲ Sync" Pull path (`pullAll()`, `index.html:3331-3416`) merges Google Sheets rows into `DB` without translating them back into the app's internal field names. `handlePullEntity()` (`apps-script/Code.gs:253-278`) returns each row keyed by its literal spreadsheet column header (e.g. `'Description'`, `'SKU'`, `'Supplier ID'`), while every other part of the app reads internal camelCase fields (`.desc`, `.sku`, `.id`). `mapRec()` (`index.html:3250-3262`) performs the forward (internal → header) translation on push; nothing performs the inverse on pull.

**Confirmed root cause has two distinct parts, both required to fully close this gap:**

1. **Missing reverse field-mapping.** Every field on a pulled record reads as `undefined` under its internal name, which is why pulled Suppliers/Line Items/Shipments/Invoices render blank and why their delete buttons silently fail (`onclick="delSup('` + `san(rec.id)` + `')"` resolves to `delSup('')` when `.id` is `undefined`, and the array filter `r.id !== id` never matches).

2. **No Sheet column carries the internal `id` at all, for five of the nine synced entities.** Checked directly against `FIELD_MAPS` (`index.html:3239-3249`):
   - **Have an id-mapped column** (fixed by reverse-mapping alone): `sup` (`id:'Supplier ID'`), `payments` (`id:'Payment ID'`), `co` (`id:'Contact ID'`).
   - **Have no id-mapped column at all** (reverse-mapping alone is not sufficient — a pulled record for these entities can never regain a matching `.id`, even once every other field is correctly translated): `li`, `sh`, `inv`, `po`, `cn`. `pullAll()`'s merge logic keys strictly on `.id` for these (`invPulledIds[invPulled[ii].id]`, `poPulledIds[...]`, `sPulledIds[sd.records[si].id]`) — so even after fixing the field-name translation, every pulled record for these five entities would still look "new" on every Pull (since its `.id` is permanently absent), causing local records to be duplicated or overwritten with an unlinked copy on every sync cycle, rather than genuinely merging.

**Confirmed via a corrupted real backup (2026-07-12, `Stackd-Backup-CLEANED-2026-07-12.json` remediation)**: Suppliers and Line Items each showed a fully-blank stub PLUS a data-bearing but header-keyed duplicate of a correctly-keyed twin record, exactly matching this two-part diagnosis.

## FM-1 Assessment

This is a **bug fix to existing, already-shipped sync code** — no new `K`/`DB` entity, no new field on any entity's schema, no new localStorage key. Falls outside FM-1's scope entirely (FM-1 governs new *features*; this is a correctness fix to code that has been live since before the freeze). No exception category needed.

## Requirements

**REQ-SYNC-001**: Add a reverse-mapping function (`unmapRec(entity, sheetRec)`), inverse of `mapRec()`, that translates a Sheet-header-keyed record back into internal field names for every entity with a `FIELD_MAPS` entry. Apply it to every record pulled via `pullAll()`/`sGet()` before it is merged into `DB`, for all entities currently routed through `handlePullEntity()`: `inv`, `cn`, `po`, `sup`, `li`, `payments`, `sh`, `qt`, `co`.

**REQ-SYNC-002**: For entities whose `FIELD_MAPS` has no `id` mapping (`li`, `sh`, `inv`, `po`, `cn`), change `pullAll()`'s merge/match logic from `.id`-based to each entity's real business key, mirroring the matching already used elsewhere in the app for the same purpose:
   - `li`: match by `sku` if present, else by `desc`+`supId` (mirrors `processImportRecords()`'s existing li-matching logic, `index.html:6549-6552`).
   - `sh`: match by `ref` (mirrors `BIZ_KEYS.sh` in `Code.gs`).
   - `inv`/`cn`: match by `num`.
   - `po`: match by `num`.
   - `qt`: match by `num` (has an id-less `FIELD_MAPS` entry too — confirmed at `index.html:3247`, included here for consistency even though not in the original gap's symptom list).

When a pulled record matches an existing local record by business key, the merged record must **keep the local record's internal `id`** (since the Sheet never carries it) and take every other field from the pulled (Sheets-sourced) data — preserving the existing "Sheets wins" precedent (`SEC-GAP-011`) for field values, while fixing identity continuity. When no local match exists, treat the pulled record as genuinely new and assign a fresh `id` via `uid()`.

**REQ-SYNC-003**: `sup`, `payments`, and `co` (which do have an id-mapped column) continue to merge by `.id` as today, now correctly populated via `unmapRec()`.

**REQ-SYNC-004**: No change to the push direction (`mapRec()`, `syncAll()`, `handleBulkUpsert()`) — this REQ is pull-only.

## Acceptance Criteria

- AC-001: `unmapRec('li', {'SKU':'ABC','Description':'Widget','Unit Cost':10,'Unit Price':12,'Currency':'USD','HS Code':'','Supplier':'sup1','Notes':''})` produces `{sku:'ABC', desc:'Widget', cost:10, price:12, cur:'USD', hs:'', supId:'sup1', notes:''}` — no header-named keys remain.
- AC-002: Pulling a Sheets Line Item row that matches an existing local Line Item by `sku` preserves the local record's `id` and `priceHistory`/`invoiceRefs` (fields not present in `FIELD_MAPS.li` at all, and therefore never round-tripped through Sheets), while adopting the Sheets-sourced `desc`/`cost`/`price`/etc.
- AC-003: Pulling a Sheets Invoice row that matches an existing local Invoice by `num` preserves the local `id`, `lineItems`, and `calc_*` fields per the existing preservation logic (`index.html:3346-3358`), now keyed by `num` instead of a permanently-absent `.id`.
- AC-004: A genuinely new Sheets row (no local match by business key) is assigned a fresh `id` and merges in as a new local record.
- AC-005: Regression test using the actual corrupted-backup shape (header-keyed blank stub, e.g. `{'Supplier ID':'','Name':'',...,num:'SUP-0055'}`) — after `unmapRec()`, every field is `''`/empty under its correct internal name, and this record does not spuriously "match" any real local Supplier by business key (an empty `name`/`sku`/`ref`/`num`-as-business-key never matches a populated field).
- AC-006: `sup`, `payments`, `co` pulled-and-merged correctly by `id` after `unmapRec()` (regression — these already worked once reverse-mapped, since their Sheets column set includes an id-mapped header).
- AC-007: No change to any push-direction test (`mapRec()`, `syncAll()`) — this REQ does not touch that path.

## Residual Risks (logged, not blocking)

- **SYNC-GAP-001 residual**: this REQ fixes the *ingest* path going forward. It does not retroactively repair a Sheet that already contains corrupted rows from before this fix — that was addressed as a one-off manual remediation (cleaned backup JSON + full Sync/push to rewrite the Sheet), already completed for this user's data as of 2026-07-12.
- **Adjacent, out-of-scope defect found while investigating (not part of this REQ)**: `FIELD_MAPS.sup` maps a `contact` key (`index.html:3240`) that does not exist on the internal Supplier object (the real field is `ct` — confirmed via `saveSup()`, `index.html:4063`), so the "Contact" column has silently never round-tripped on push either, independent of this pull-side bug. Also several `FIELD_MAPS.sup` keys (`payTerms`, `leadTime`, `dgCapable`) have no corresponding internal Supplier field at all. Recommend logging as a separate gap (`SYNC-GAP-003`?) rather than fixing here, to keep this REQ's scope to the pull-side identity/mapping bug it was raised to fix.
