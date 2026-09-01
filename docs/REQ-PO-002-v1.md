# REQ-PO-002 — Fix `qteToPoConvert()` field-shape mismatch corrupting Quote-converted Purchase Orders

**Status:** v1 — requirements-gate **PASS** (round 1: CONDITIONAL PASS, 2 blocking findings fixed in place; round 2: CONDITIONAL PASS, 2 non-blocking wording advisories in §7 fixed in place). Ready for SPEC. See §8 review-resolution log.

---

## 1. Business context

This REQ closes the defect documented at **`docs/architecture-data-model-v1.md` §6.1** (merged PR #123), described there as "the most consequential single finding" in that review (§4.2, line 114) and, in the document's closing synthesis, the first item of the recommended sequencing (§8, item 1: "fix `qteToPoConvert()`'s field-shape bug first, independent of any migration work"). It was surfaced during architecture research for the planned cross-platform backend migration, not reported by a user directly — but it is a live, currently-shipping defect on `main` @ v2.9.71, independent of that migration, and should be fixed regardless of when the migration itself is scoped.

**The defect.** `qteToPoConvert()` (`index.html:11472-11523`) is the function behind the "Convert to PO" button on an Accepted Quote — the application's primary, steered path for turning a won deal into a Purchase Order. It builds each generated Purchase Order object using a different field-naming scheme than every other Purchase Order code path in the application:

| Field meaning | What `qteToPoConvert()` writes | What every other PO path reads/writes |
|---|---|---|
| Line items | `lines` | `lineItems` (`savePO()` `index.html:7307`, `autoPos()` `index.html:6308`, `editPO()` `index.html:7256`, `rPO()` `index.html:7319`, `prevPODoc()`, `renderPoSourceDriftWarn()` `index.html:6332`, `FIELD_MAPS.po`) |
| Document date | `dt` | `date` |
| Currency | `currency` | `cur` |
| FPM funding amount | `fpm` | `fpmFunded` |
| FPM recovered flag | `rec` | `fpmRecovered` |

**The mismatch is not limited to top-level document fields — it goes one level deeper, into every line item too.** Each line item `qteToPoConvert()` produces (`index.html:11505-11507`) is shaped `{rid, liId:'', desc, qty, up, uom, cur}`, but every real-shaped line item (`addPLI()` at `index.html:7273`, `autoPos()` at `index.html:6302`) is shaped `{rid, lid, desc, sku, uom, qty, cost}`. Concretely: the catalogue-link field is named `liId` instead of `lid`; the unit-cost value is stored under `up` instead of `cost`; a per-line `cur` field is written that no real line item ever carries (currency is a document-level concept, held once on the parent PO); and no `sku` key is present at all. This nested mismatch is the actual reason `calcPO()`/`rPO()`'s totals compute to $0 and `renderPoSourceDriftWarn()` never fires even after the top-level `lineItems` key exists — those functions read `li.cost` and `pl.lid`, never `li.up` or `li.liId`. Any fix or migration that renames only the top-level document fields without also reshaping every nested line item will not actually resolve the defect.

**Consequence, confirmed by direct trace, not inference.** A Purchase Order created this way is inserted into `DB.po` successfully — it gets an `id`, a `num`, occupies a slot in the source Quote's `linkedPOIds[]`, and the operator sees a "PO ... created" success toast — but every downstream consumer of a Purchase Order record reads a field name this record does not have:

- `editPO()` initialises its line-item editor from `po.lineItems||[]` (`index.html:7256`) — always empty, so the edit modal opens with **no line items**, and any save through it silently discards the real (mis-shaped) data.
- `rPO()`'s table row computes its shown total from `po.lineItems` (`index.html:7319`) — shows **$0**.
- `prevPODoc()`'s print/PDF preview reads `po.lineItems` — the printed document has **no line rows**.
- `renderPoSourceDriftWarn()` reads `po.lineItems` (`index.html:6332`) — always empty for these records, so it silently never fires, not because there is no drift, but because it is looking at the wrong field.
- `rPO()`, `editPO()`, and `getPOEffectiveDepInfo()` all default to `'USD'` when `po.cur` is absent (`index.html:7260,7320,12029`), ignoring the Quote's actual currency, silently sitting unread in `po.currency`.
- Dashboard/Accounts FPM-funding totals read `fpmFunded`/`fpmRecovered` — always falsy for these records, so a Quote-converted PO is never credited toward funding totals regardless of intent.
- The Google Sheets sync field map (`FIELD_MAPS.po`) reads `date`/`cur` — both blank on a converted PO, so it syncs to the shared spreadsheet with empty Date and Currency columns.

The existing unit test for this function (`tests/run.js:1253-1301`) asserts against the buggy shape directly (e.g. `poA.lines.length`), so the test suite is green while the live feature does not work. This is not a new regression — it is present in the code as committed and has been for some time; the architecture review is simply the first time it was traced end-to-end against the real downstream consumers rather than tested only in isolation.

**Why this is scoped as its own REQ, not folded into a larger migration REQ:** it is a correctness defect in the current application, unrelated to where data is eventually stored. `docs/architecture-data-model-v1.md` §6.1 explicitly calls for this to be fixed "before any migration touches Purchase Orders... independent of where the data eventually lives," and §8's synthesis recommends it as the first step of the sequencing, ahead of any migration-specific work.

---

## 2. Requirements

**REQ-PO-002a — `qteToPoConvert()` must build Purchase Order objects using the same field names as every other Purchase Order creation path, at both the document level and the line-item level.** Document level: `lineItems` (not `lines`), `date` (not `dt`), `cur` (not `currency`), `fpmFunded` (not `fpm`), `fpmRecovered` (not `rec`). Each generated line item must use the same shape `addPLI()`/`autoPos()` produce — `{rid, lid, desc, sku, uom, qty, cost}` — mapping the Quote line's `desc`/`uom`/`qty`/`cost` fields directly, with `lid: ''` and `sku: ''` (Quote lines have neither a catalogue link nor a SKU, so both are blank, matching how a manually-typed PO line with no catalogue link already behaves), and with **no per-line `cur` field** (currency is a document-level concept in the real shape, held once on the parent PO — the current buggy code writes a redundant, non-existent-elsewhere per-line `cur`, which must be dropped, not renamed).

**REQ-PO-002b — A one-time, idempotent migration must convert any Purchase Order already created with the old (broken) shape, at both the document level and the line-item level.** The precedent for this exact class of problem is `backfillInvoicePOs()` (`index.html:2835`), which operates on the same `DB.po` array this fix targets and runs at 5 confirmed call sites: `pullAll()` (`index.html:4469`), the CSV-import Purchase Order branch of `processImport()` (`index.html:8273`), the Sheets-record-import branch of `processImportRecords()` (`index.html:8621`), `doImport()`'s full JSON restore (`index.html:10313`), and `initApp()`'s boot sequence (`index.html:12338`). (`migrateLinkedPOIds()` at `index.html:2824` is a related but *not* equivalent precedent — it operates on `DB.qt`, not `DB.po`, and is wired into only 2 of those 5 points, `doImport()` and `initApp()`; it must not be used as the template for where this migration is called.) The new migration must: detect the old shape (a `po.lines` array present with no `po.lineItems`); at the document level, map `dt→date`, `currency→cur`, `fpm→fpmFunded`, `rec→fpmRecovered`; at the line-item level, map each entry's `liId→lid`, `up→cost`, add `sku:''`, and drop the per-line `cur`; and remove every old, now-redundant key (`lines`, `dt`, `currency`, `fpm`, `rec`, and, within each converted line item, `liId`, `up`, `cur`) so a migrated record is byte-for-byte indistinguishable in shape from one that was always correct. Must run at the same 5 points `backfillInvoicePOs()` already runs, so that a Purchase Order created on one device is corrected the next time it is loaded on any device, not only on the device that happens to run a future app version first.

**REQ-PO-002c — The existing seven `qteToPoConvert()` tests must be updated to assert against the corrected field names**, and must continue to pass with no change to their actual test intent (grouping by supplier, numbering/collision handling, blocking conditions) — this REQ changes field names, not behaviour.

**REQ-PO-002d — At least one new, mutation-tested integration-level test must prove a `qteToPoConvert()`-created Purchase Order is actually usable by the real, unmodified downstream functions** — specifically that `editPO()` correctly loads its line items (proving the fix, not just the object shape, is correct) — mirroring the discipline already established in this codebase for this exact class of fix (e.g. `REQ-ORD-006`'s proof that its fix worked against the real `renderQteSourceDriftWarn()`, not merely a redesigned data shape asserted in isolation).

---

## 3. Explicitly out of scope

- **Event-log coverage for `qteToPoConvert()` and `autoPos()`.** Both automatic PO-creation paths write no `logEv()` entry today — a separate, already-identified finding (`docs/architecture-data-model-v1.md` §6.4). Adding it here would widen this REQ beyond the field-shape defect it exists to fix. Tracked separately.
- **A Quote-side drift-detection check for PO-side changes**, or a PO-side check for Quote-side changes after conversion. `renderPoSourceDriftWarn()` today only checks Invoice-sourced drift; extending it to Quote-sourced drift is a design question of its own, not a field-naming bug, and is out of scope here.
- **`PO-GAP-002`** (historical POs mis-attributed to the wrong supplier before the v2.9.44 fix) — a different, already-logged, already-accepted residual risk, unrelated to field naming.
- **Retroactively correcting the `notes` field's `'Auto-converted from ' + q.num`** text or any other cosmetic field — unchanged by this REQ.
- **Any change to `autoPos()`** — it already uses the correct field shape throughout; it is cited above only as the reference for what "correct" looks like.

---

## 4. Acceptance criteria

- **AC-1:** A Purchase Order created by `qteToPoConvert()` has a `lineItems` array (not `lines`) containing one entry per source Quote line, each shaped exactly `{rid, lid, desc, sku, uom, qty, cost}` with `lid: ''`, `sku: ''`, and **no** `liId`, `up`, or `cur` key present on the line item.
- **AC-2:** The same Purchase Order has `date` (not `dt`), `cur` (not `currency`), `fpmFunded: 0` (not `fpm`), `fpmRecovered: false` (not `rec`), and no `lines`/`dt`/`currency`/`fpm`/`rec` keys remain.
- **AC-3:** Calling the real, unmodified `editPO()` against a `qteToPoConvert()`-created Purchase Order populates its line-item editor (`cPL`) with the correct, non-empty line items, and `calcPO()` computes a non-zero total from them — proof the fix is consumable, not just differently shaped.
- **AC-4:** All seven pre-existing `qteToPoConvert()` tests (draft/sent blocking, Accepted creation, already-linked blocking, multi-supplier grouping, unassigned-supplier grouping, numbering-collision handling) pass unchanged in intent, updated only for the corrected field names.
- **AC-5:** A new migration function converts an existing, old-shape Purchase Order record — both at the document level (`lines`/`dt`/`currency`/`fpm`/`rec` present, `lineItems` absent) and within every one of its nested line items (`liId`/`up`/a per-line `cur` present, `lid`/`cost`/`sku` absent) — into the corrected shape on both levels; is idempotent (running it twice produces the same result as running it once); and does not touch a Purchase Order that already has the correct shape (including an ordinary manually-created or `autoPos()`-created PO that legitimately has no `lines` key at all).
- **AC-6:** The migration runs at all 5 points `backfillInvoicePOs()` already runs (`pullAll()`, `processImport()`'s PO branch, `processImportRecords()`'s PO branch, `doImport()`, `initApp()`), confirmed by matching call sites in the diff, not merely asserted in prose.
- **AC-7:** Zero regressions — full existing suite continues to pass.

---

## 5. Testing approach

Follows this codebase's established pattern: unit tests for `qteToPoConvert()`'s corrected output shape (AC-1, AC-2), an integration-level test calling the real `editPO()` against a generated PO (AC-3), updated versions of the seven existing tests (AC-4), unit tests for the new migration function covering the convert/idempotent/leave-correct-records-alone cases (AC-5), and a direct source check (not just a written claim) that the migration is wired into the same call sites as its two siblings (AC-6). Any test-isolation module-level state introduced must be reset per this codebase's established `resetDB()` discipline.

---

## 6. Gate process

Per `CLAUDE.md`'s standing checklist: this REQ goes through requirements-gate review before a SPEC is written; the SPEC goes through spec-gate review before implementation; the implementation goes through build-gate review before merge. Version-ship housekeeping (version bump, changelog, `docs/version-history.md`, `docs/requirements-tracker.md`, `STACKD_CONTEXT.md`) happens on completion per the same standing checklist.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: add a new entry (proposed ID `PO-GAP-005`, since `PO-GAP-001`–`004` are already in use) documenting this defect and its fix, cross-referencing `docs/architecture-data-model-v1.md` §6.1 as the source of discovery.
- `docs/requirements-tracker.md`: add `REQ-PO-002` to the active requirements table with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `docs/architecture-data-model-v1.md`: §6.1 (the defect description itself) and the `qteToPoConvert()` paragraph in §4.2 (line 114 — the one that describes the defect, not the separate Quote-entity paragraph at line 112) should be updated to note the defect is fixed as of the version this REQ ships. §8's sequencing recommendation (item 1) can stand as-is, since it correctly recommended this fix happen first. All of this is a small follow-up edit to that document, not part of this REQ's own gate-reviewed diff.

---

## 8. Review-resolution log

**Round 1: CONDITIONAL PASS.** The core diagnosis and the top-level target field names were independently verified correct against the real code (`qteToPoConvert()`, `savePO()`, `autoPos()`, `editPO()`, `rPO()`, `renderPoSourceDriftWarn()`, `prevPODoc()`, `getPOEffectiveDepInfo()`, `FIELD_MAPS.po`, `addPLI()`, and the 7 existing tests all cited and re-traced independently). Two blocking findings, both resolved in place:

- **B-1 — the REQ never stated that each Purchase Order's *nested line items* also need reshaping, only the parent document's own fields.** The reviewer traced that `qteToPoConvert()`'s line items are shaped `{rid, liId:'', desc, qty, up, uom, cur}`, while every real line item is shaped `{rid, lid, desc, sku, uom, qty, cost}` — a second, independent field-naming mismatch one level deeper than the one originally documented. Left unaddressed, a migration written to the REQ as originally worded would rename the parent object's fields correctly while leaving every line item's `up`/`liId`/stray `cur` untouched — `calcPO()`/`rPO()` read `li.cost`, not `li.up`, so migrated historical records would still show $0 totals, the exact symptom the migration exists to fix. **Resolved:** §1's diagnosis, REQ-PO-002a, REQ-PO-002b, and AC-1/AC-5 above now all explicitly name the line-item-level mapping (`liId→lid`, `up→cost`, drop the per-line `cur`, add `sku:''`) alongside the document-level one.
- **B-2 — the REQ claimed `migrateLinkedPOIds()` and `backfillInvoicePOs()` "already run at the same points," which is false.** `backfillInvoicePOs()` runs at 5 call sites (`pullAll()`, both import branches, `doImport()`, `initApp()`); `migrateLinkedPOIds()` runs at only 2 of those (`doImport()`, `initApp()`) and, separately, operates on `DB.qt` rather than `DB.po`. Since the new migration targets `DB.po`, `backfillInvoicePOs()`'s 5 sites are the correct precedent, not the intersection the original wording implied. **Resolved:** REQ-PO-002b and AC-6 now cite `backfillInvoicePOs()`'s exact 5 sites by line number and explicitly note `migrateLinkedPOIds()` is not an equivalent precedent for wiring purposes.

Advisories also resolved in place: every citation to `docs/architecture-data-model-v1.md` used an ID scheme ("Finding F-01"/"F-04") and section numbers ("§9.4", "Table 2.1/6.1") that do not exist in that document — replaced throughout with the document's real section references (§6.1, §6.4, §4.2 line 114, §8 item 1); AC-1 now explicitly defaults `sku` to `''` rather than leaving it unstated; the `getPOEffectiveDepInfo()` `'USD'`-default citation (`index.html:12029`) was added alongside the two already cited.

**Round 2: CONDITIONAL PASS, advisories only.** Independently re-verified every fix from round 1 against the real code a second time (line-item shapes, the 5 `backfillInvoicePOs()` call sites, the architecture-doc citations) and found both blocking findings correctly and completely resolved, with no new breakage introduced. Two minor wording advisories in §7 (an unclear self-reference to "§9.4-equivalent," and an ambiguous pointer to "the Quote paragraph in §4.2" when two exist) — both fixed in place above. Confirmed ready for SPEC: every field mapping, the exact migration-detection condition, the removal-key list, and the 5 call sites are specific enough for a SPEC author to write exact diffs without guessing.
