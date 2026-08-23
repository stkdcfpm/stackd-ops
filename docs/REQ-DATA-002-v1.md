# REQ-DATA-002-v1: Data Integrity Cleanup — Phantom Record Removal & Safe Renumbering

## Business Context

Reported live by the operator: several tabs (confirmed: Suppliers; suspected: most entities that ever synced through Google Sheets) contain completely blank records — no name, no identifying data — that consume a reference number and cannot be removed via the existing Delete button.

Root-caused against the live code and this project's own gap register: this matches **SYNC-GAP-001** exactly. Before v2.9.47, `pullAll()`'s two-way Sheets sync merged pulled rows keyed by the literal spreadsheet column header instead of the internal field name, so every pulled record's real fields (including its own `id`) read as `undefined`. `backfillRefNums()` still assigned these blank records a real reference number (it only checks whether `num` is set, not whether the record has a name), and the existing Delete button silently failed on them — it filters by `id !== id`, and `undefined !== ''` is always true, so the filter never matched. SYNC-GAP-001's fix (`unmapRec()`, v2.9.47) stops this from happening to **new** pulls, but nothing ever went back and removed records that were already corrupted before that fix shipped. That residue is what the operator is looking at now — confirmed to predate the recent Cloud Data/Supabase work, which is unrelated.

This affects every entity that has ever gone through the two-way Sheets pull: `sup`, `li`, `inv`, `po`, `cn` (a special-case `inv` record), `qt`, `payments`, `co`. `buy` (Buyers) and `ord` (Order Requests) never sync to Sheets (FM-1 category-3 exceptions) and should not have this specific defect, though the cleanup tool should still defensively scan them in case a different, unrelated cause produced the same symptom.

## FM-1 Assessment

No new entity, no new `K`/`DB` key, no new field on any existing entity, no new Sheets sync mapping. This is a one-time repair utility operating entirely on data already inside existing entity arrays. FM-1 category-1 (UI/AI layer feature with no new localStorage entities) — no council decision needed.

## REQ-DATA-002a (phantom-record detection criterion)

A record is a "phantom" if and only if its `id` field is falsy (missing, `null`, `undefined`, or empty string). This is the precise, verified fingerprint of the actual historical defect, not a heuristic based on "looks empty to a human": every legitimate record-creation path in this codebase assigns `id: uid()` at creation (confirmed: 35+ call sites, one `uid()` implementation, which always returns a non-empty string — `Date.now().toString(36) + Math.random().toString(36).slice(2,5)`). No legitimate record, however sparse its other fields, can ever have a falsy `id`. This criterion cannot misidentify a real record, and directly matches SYNC-GAP-001's documented mechanism (the merge that corrupted these records specifically left `id` undefined, among other fields).

Detection must scan `DB.sup`, `DB.li`, `DB.inv`, `DB.po`, `DB.qt`, `DB.payments`, `DB.con`, `DB.buy`, `DB.ord`, `DB.sh` — every top-level entity array — even though `buy`/`ord`/`sh` aren't expected to be affected by this specific historical bug, since a defensive full scan costs nothing and a `!id` record found anywhere is a bug worth surfacing regardless of its origin.

## REQ-DATA-002b (preview before any mutation)

The tool MUST run a read-only scan first and display the exact count of phantom records found per entity, with no mutation to `DB` or `localStorage` at this stage. The operator reviews this count and explicitly confirms before anything is removed. There is no "auto-clean" path.

## REQ-DATA-002c (mandatory backup gate)

Actual removal MUST be blocked behind the same style of mandatory, checkbox-gated backup-export confirmation already used by `migrateSuppliersBuyersToSupabase()` — the operator must attest a full backup was taken in this session before the cleanup can proceed. This is a genuine block, not a dismissible warning.

## REQ-DATA-002d (phantom removal)

For each scanned entity array, keep only records with a truthy `id`: `DB.<entity> = DB.<entity>.filter(function(r){ return !!r.id; });`. This is the entire removal operation — no partial-repair/reconstruction of a phantom record is attempted, since by definition none of its data is recoverable (that's precisely what "phantom" means here).

## REQ-DATA-002e (renumbering scope — explicit split by entity, not "renumber everything")

After phantom removal, close number-sequence gaps by renumbering **only**: Suppliers (`SUP-`), Line Items (`LI-`), Buyers (`BUY-`), Contacts (`CON-`), Order Requests (`ORD-`) — the five entities `backfillRefNums()` already manages, whose `num` field is confirmed (verified by exhaustive grep, zero matches) to never be used anywhere in this codebase as a relationship-lookup key; every cross-entity reference to these five is by internal `id`.

**Invoices, Purchase Orders, Quotes, and Credit Notes are explicitly excluded from renumbering, permanently, not just for this pass.** Verified in the live code: a Credit Note stores its linked Invoice's `num` as a persisted text field (`linkedInvNum`) and re-resolves it by `num`-equality lookup later (`index.html` — `DB.inv.find(i => i.id===inv.linkedInvId || i.num===inv.linkedInvNum)`); the CSV/Sheets importer matches existing Invoices/POs by `num` specifically because those entities have no `id` column in Sheets (`processImportRecords()`, mirroring SYNC-GAP-001's own documented business-key-matching design). Renumbering an Invoice or PO after the fact would silently break these `num`-keyed lookups and could desynchronize a Credit Note from the Invoice it's linked to. These numbers are also the ones most likely to already appear on documents issued to an external supplier or buyer. This exclusion is a hard requirement, not a preference — confirmed correct with the operator directly (2026-08-22) after presenting the risk.

## REQ-DATA-002f (renumbering preserves creation order)

Renumbering must not scramble the relative order of existing records. Sort the surviving records of each renumbered entity by their current valid `num`'s numeric sequence value (falling back to `createdAt` for any record that — pre-repair — never had a `num` at all, mirroring `backfillRefNums()`'s own existing tie-break convention), then reassign `PREFIX-0001`, `PREFIX-0002`, ... in that order. A record's relative position in the sequence never changes; only the gaps left behind by removed phantoms close up.

## REQ-DATA-002g (relationship safety — verify, don't just assert)

Renumbering changes only the `num` field on the five entities in scope — never `id`, and every cross-entity reference in this codebase is by `id` (confirmed by exhaustive grep across the file: zero matches for a Supplier/Line-Item/Buyer/Contact/Order-Request `.num === `-style relationship lookup anywhere). The tool's own post-run verification step must positively confirm this rather than merely relying on the design: after renumbering, re-resolve every FK field this codebase has (`supId`, `buyId`, `contactId`, `supplierId`, `linkedInvId`, etc.) against the renumbered entity's `id` set and confirm zero references became newly dangling. Since renumbering never touches `id`, this check is expected to always pass — its purpose is to catch a mistake in this feature's own implementation, not to catch a hypothetical design flaw.

## REQ-DATA-002h (audit trail)

Every phantom-record removal and every renumbering event must be logged via the existing `logEv()` mechanism (`entityType`, a synthetic reference like the entity name, verb `phantom_removed`/`renumbered`, a summary naming the affected entity and old/new number where applicable, actor `operator`), so there's a permanent record of exactly what this tool changed and when — consistent with every other data-mutating action in this app.

## REQ-DATA-002i (manual trigger only, one-time in spirit)

This is a Settings → Data tool, triggered explicitly by the operator (matching the existing `runDataRepair()` button precedent) — never run automatically on load, on sync, or on any schedule. It can be run more than once (e.g. if new phantom records somehow appear in the future), but is not a background/recurring process.

## REQ-DATA-002j (defensive hardening — close the door going forward, beyond the existing fix)

Independent of the cleanup tool, add one additional defensive guard directly in `pullAll()`'s merge step (`mergePulledWithLocal()`/the `simpleEnts` merge loop): a pulled record that resolves to a falsy `id` after `unmapRec()` translation must be dropped from the merge entirely (never written into `DB`), with a console warning for visibility. This is a second, independent layer beyond the existing `unmapRec()`/`findLocalMatchByBizKey()` fix — SYNC-GAP-001's fix already prevents the specific translation bug that caused this; this guard prevents the same *symptom* (a record with no `id` entering `DB`) from recurring via any future, different bug in that pipeline.

## Acceptance Criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | `DB.sup` contains 3 real Suppliers and 2 phantom records (`id` falsy) | The scan runs | It reports exactly 2 phantom Suppliers found; `DB.sup` is unmodified |
| AC-2 | The same fixture, backup not yet confirmed | The operator tries to run the actual cleanup | It is blocked with a clear message; `DB.sup` is unmodified |
| AC-3 | The same fixture, backup confirmed | The operator confirms cleanup | `DB.sup` now has exactly 3 records, none with a falsy `id`; the 3 real Suppliers' data is byte-for-byte unchanged except `num` |
| AC-4 | 3 real Suppliers with nums `SUP-0001`, `SUP-0003`, `SUP-0007` (gaps from removed phantoms) | Renumbering runs | They become `SUP-0001`, `SUP-0002`, `SUP-0003` in their original relative order |
| AC-5 | A real Invoice/PO/Quote/Credit Note with any `num` | Cleanup runs (even if phantom Invoices/POs also exist and get removed) | Its `num` is never modified, only phantom records with falsy `id` are removed from those arrays |
| AC-6 | A Contact with `supplierId` pointing at a real Supplier's `id` | That Supplier gets renumbered (its `num` changes, `id` doesn't) | The Contact's `supplierId` is unchanged and still resolves correctly — verified by the tool's own post-run check, not just assumed |
| AC-7 | Cleanup runs and removes 2 phantom Suppliers and renumbers 3 real ones | — | `DB.events` gains entries recording both actions |
| AC-8 | `pullAll()` receives a pulled record that resolves to a falsy `id` after existing translation | The merge runs | That record is dropped, never written to `DB`; a console warning is emitted; no other pulled record in the same batch is affected |

## Open Questions for Spec-Gate

1. Exact UI placement/wording for the scan/preview/confirm flow in Settings → Data — left to spec-gate, following the existing `runDataRepair()` button's visual pattern as the nearest precedent.
2. Whether Shipments (`DB.sh`) needs any special handling given they use a `ref` field rather than a `num` field for their own reference scheme — spec-gate should confirm `sh` is included in phantom-*detection* (REQ-DATA-002a) but confirm it is correctly excluded from the renumbering entity list (REQ-DATA-002e only lists sup/li/buy/con/ord).
