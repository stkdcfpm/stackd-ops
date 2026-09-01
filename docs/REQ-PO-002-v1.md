# REQ-PO-002 — Fix `qteToPoConvert()` field-shape mismatch corrupting Quote-converted Purchase Orders

**Status:** v1 — draft, pending requirements-gate.

---

## 1. Business context

This REQ closes **Finding F-01** of `docs/architecture-data-model-v1.md` (merged PR #123), assessed there as CRITICAL and "the single most consequential finding" in that review. It was surfaced during architecture research for the planned cross-platform backend migration, not reported by a user directly — but it is a live, currently-shipping defect on `main` @ v2.9.71, independent of that migration, and should be fixed regardless of when the migration itself is scoped.

**The defect.** `qteToPoConvert()` (`index.html:11472-11523`) is the function behind the "Convert to PO" button on an Accepted Quote — the application's primary, steered path for turning a won deal into a Purchase Order. It builds each generated Purchase Order object using a different field-naming scheme than every other Purchase Order code path in the application:

| Field meaning | What `qteToPoConvert()` writes | What every other PO path reads/writes |
|---|---|---|
| Line items | `lines` | `lineItems` (`savePO()` `index.html:7307`, `autoPos()` `index.html:6308`, `editPO()` `index.html:7256`, `rPO()` `index.html:7319`, `prevPODoc()`, `renderPoSourceDriftWarn()` `index.html:6332`, `FIELD_MAPS.po`) |
| Document date | `dt` | `date` |
| Currency | `currency` | `cur` |
| FPM funding amount | `fpm` | `fpmFunded` |
| FPM recovered flag | `rec` | `fpmRecovered` |

**Consequence, confirmed by direct trace, not inference.** A Purchase Order created this way is inserted into `DB.po` successfully — it gets an `id`, a `num`, occupies a slot in the source Quote's `linkedPOIds[]`, and the operator sees a "PO ... created" success toast — but every downstream consumer of a Purchase Order record reads a field name this record does not have:

- `editPO()` initialises its line-item editor from `po.lineItems||[]` (`index.html:7256`) — always empty, so the edit modal opens with **no line items**, and any save through it silently discards the real (mis-shaped) data.
- `rPO()`'s table row computes its shown total from `po.lineItems` (`index.html:7319`) — shows **$0**.
- `prevPODoc()`'s print/PDF preview reads `po.lineItems` — the printed document has **no line rows**.
- `renderPoSourceDriftWarn()` reads `po.lineItems` (`index.html:6332`) — always empty for these records, so it silently never fires, not because there is no drift, but because it is looking at the wrong field.
- `rPO()`, `editPO()`, and `getPOEffectiveDepInfo()` all default to `'USD'` when `po.cur` is absent (`index.html:7260,7320`), ignoring the Quote's actual currency, silently sitting unread in `po.currency`.
- Dashboard/Accounts FPM-funding totals read `fpmFunded`/`fpmRecovered` — always falsy for these records, so a Quote-converted PO is never credited toward funding totals regardless of intent.
- The Google Sheets sync field map (`FIELD_MAPS.po`) reads `date`/`cur` — both blank on a converted PO, so it syncs to the shared spreadsheet with empty Date and Currency columns.

The existing unit test for this function (`tests/run.js:1253-1301`) asserts against the buggy shape directly (e.g. `poA.lines.length`), so the test suite is green while the live feature does not work. This is not a new regression — it is present in the code as committed and has been for some time; the architecture review is simply the first time it was traced end-to-end against the real downstream consumers rather than tested only in isolation.

**Why this is scoped as its own REQ, not folded into a larger migration REQ:** it is a correctness defect in the current application, unrelated to where data is eventually stored. `docs/architecture-data-model-v1.md` §9.4 (Phase 0 of the migration roadmap) explicitly calls for this to be fixed "independent of the migration timeline... before any migration work touches Purchase Orders."

---

## 2. Requirements

**REQ-PO-002a — `qteToPoConvert()` must build Purchase Order objects using the same field names as every other Purchase Order creation path.** Specifically: `lineItems` (not `lines`), `date` (not `dt`), `cur` (not `currency`), `fpmFunded` (not `fpm`), `fpmRecovered` (not `rec`). Each generated line item must use the same shape `addPLI()`/`autoPos()` produce — `{rid, lid, desc, sku, uom, qty, cost}` — mapping the Quote line's `cost` field directly (Quote lines have no `lid` catalogue link, so `lid` is blank, matching how a manually-typed PO line with no catalogue link already behaves).

**REQ-PO-002b — A one-time, idempotent migration must convert any Purchase Order already created with the old (broken) shape.** This follows the codebase's own established pattern for this exact class of problem (`migrateLinkedPOIds()` at `index.html:2824`, `backfillInvoicePOs()` at `index.html:2835`): detect the old shape (a `po.lines` array present with no `po.lineItems`), map every field across, and remove the old, now-redundant keys. Must run at the same points those two sibling migrations already run (application boot, after a Sheets sync pull, after a CSV/Sheets-record import, after a full JSON restore) so that a Purchase Order created on one device is corrected the next time it is loaded on any device, not only on the device that happens to run a future app version first.

**REQ-PO-002c — The existing seven `qteToPoConvert()` tests must be updated to assert against the corrected field names**, and must continue to pass with no change to their actual test intent (grouping by supplier, numbering/collision handling, blocking conditions) — this REQ changes field names, not behaviour.

**REQ-PO-002d — At least one new, mutation-tested integration-level test must prove a `qteToPoConvert()`-created Purchase Order is actually usable by the real, unmodified downstream functions** — specifically that `editPO()` correctly loads its line items (proving the fix, not just the object shape, is correct) — mirroring the discipline already established in this codebase for this exact class of fix (e.g. `REQ-ORD-006`'s proof that its fix worked against the real `renderQteSourceDriftWarn()`, not merely a redesigned data shape asserted in isolation).

---

## 3. Explicitly out of scope

- **Event-log coverage for `qteToPoConvert()` and `autoPos()`.** Both automatic PO-creation paths write no `logEv()` entry today — a separate, already-identified finding (`docs/architecture-data-model-v1.md` Finding F-04, assessed MEDIUM, not CRITICAL). Adding it here would widen this REQ beyond the one CRITICAL defect it exists to fix. Tracked separately.
- **A Quote-side drift-detection check for PO-side changes**, or a PO-side check for Quote-side changes after conversion. `renderPoSourceDriftWarn()` today only checks Invoice-sourced drift; extending it to Quote-sourced drift is a design question of its own, not a field-naming bug, and is out of scope here.
- **`PO-GAP-002`** (historical POs mis-attributed to the wrong supplier before the v2.9.44 fix) — a different, already-logged, already-accepted residual risk, unrelated to field naming.
- **Retroactively correcting the `notes` field's `'Auto-converted from ' + q.num`** text or any other cosmetic field — unchanged by this REQ.
- **Any change to `autoPos()`** — it already uses the correct field shape throughout; it is cited above only as the reference for what "correct" looks like.

---

## 4. Acceptance criteria

- **AC-1:** A Purchase Order created by `qteToPoConvert()` has a `lineItems` array (not `lines`) containing one entry per source Quote line, each shaped `{rid, lid, desc, sku, uom, qty, cost}` with `lid: ''`.
- **AC-2:** The same Purchase Order has `date` (not `dt`), `cur` (not `currency`), `fpmFunded: 0` (not `fpm`), `fpmRecovered: false` (not `rec`).
- **AC-3:** Calling the real, unmodified `editPO()` against a `qteToPoConvert()`-created Purchase Order populates its line-item editor (`cPL`) with the correct, non-empty line items — proof the fix is consumable, not just differently shaped.
- **AC-4:** All seven pre-existing `qteToPoConvert()` tests (draft/sent blocking, Accepted creation, already-linked blocking, multi-supplier grouping, unassigned-supplier grouping, numbering-collision handling) pass unchanged in intent, updated only for the corrected field names.
- **AC-5:** A new migration function converts an existing, old-shape Purchase Order record (`lines`/`dt`/`currency`/`fpm`/`rec` present, `lineItems` absent) into the corrected shape, is idempotent (running it twice produces the same result as running it once), and does not touch a Purchase Order that already has the correct shape (including an ordinary manually-created or `autoPos()`-created PO that legitimately has no `lines` key at all).
- **AC-6:** The migration runs at every point `migrateLinkedPOIds()`/`backfillInvoicePOs()` already run (confirmed by matching call sites, not merely asserted).
- **AC-7:** Zero regressions — full existing suite continues to pass.

---

## 5. Testing approach

Follows this codebase's established pattern: unit tests for `qteToPoConvert()`'s corrected output shape (AC-1, AC-2), an integration-level test calling the real `editPO()` against a generated PO (AC-3), updated versions of the seven existing tests (AC-4), unit tests for the new migration function covering the convert/idempotent/leave-correct-records-alone cases (AC-5), and a direct source check (not just a written claim) that the migration is wired into the same call sites as its two siblings (AC-6). Any test-isolation module-level state introduced must be reset per this codebase's established `resetDB()` discipline.

---

## 6. Gate process

Per `CLAUDE.md`'s standing checklist: this REQ goes through requirements-gate review before a SPEC is written; the SPEC goes through spec-gate review before implementation; the implementation goes through build-gate review before merge. Version-ship housekeeping (version bump, changelog, `docs/version-history.md`, `docs/requirements-tracker.md`, `STACKD_CONTEXT.md`) happens on completion per the same standing checklist.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: add a new entry (proposed ID `PO-GAP-005`, since `PO-GAP-001`–`004` are already in use) documenting this defect and its fix, cross-referencing `docs/architecture-data-model-v1.md` Finding F-01 as the source of discovery.
- `docs/requirements-tracker.md`: add `REQ-PO-002` to the active requirements table with full gate history.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `docs/architecture-data-model-v1.md`: Finding F-01 (§6.1), the Quote §4.2 narrative, and the Table 2.1/Table 6.1 entries that reference this defect as open should be updated to note it is fixed as of the version this REQ ships — a small follow-up edit to that document, not part of this REQ's own gate-reviewed diff.

---

## 8. Review-resolution log

(Pending requirements-gate review.)
