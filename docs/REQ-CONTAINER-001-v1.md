# REQ-CONTAINER-001 — Container profile table: shared capacity/weight model for the Load Calculator and Quote feasibility check, including Reefer

**Status:** v1 — first draft, not yet submitted for independent requirements-gate review.
**Type:** New reference entity + de-duplication of existing hardcoded logic. No change to `DB.inv`/`DB.qt`/`DB.sh` record shapes. No Supabase migration (local-only entity, same category as `DB.events`).

---

## 0. How this REQ came to be scoped this way

Operator's own priority ordering for data-model robustness work, set explicitly: "1, shipment<>invoice. 2, container profile table. 3, warehousing/storage cost concept." With REQ-SHIP-002 (clean PASS, implementation pending) and REQ-LI-002/SPEC-LI-002 (both clean PASS, implementation paused in preview) addressing item 1, this REQ addresses item 2. A direct code survey (§1.1) found the "container profile" concept doesn't exist in the app at all today — container capacity is two bare numbers, copy-pasted in two places, with no weight limit and no Reefer type anywhere. The operator then resolved three scoping questions (§1.2) before this draft.

---

## 1. Business context

### 1.1 What exists today (check-first)

- **Gap 1 — no container-profile data structure exists anywhere.** The only "model" of container capacity is two bare numbers — `25` and `65` (CBM) — hardcoded inline and duplicated verbatim in two unrelated places: `runLoadCalc()` (`index.html:13455-13456`: `totalCBM <= 25 ? '20GP' : totalCBM <= 65 ? '40HQ' : 'Multiple 40HQ'`) and the Quote feasibility check (`index.html:14157`: `totalCBM <= 25 ? '20GP' : totalCBM <= 65 ? '40HQ' : null`). No array, object, or constant of container types/capacities exists to extend — confirmed by direct read of both sites and a full-file search for "reefer"/"container" turning up nothing else.
- **Gap 2 — no Reefer container type exists anywhere.** Confirmed by search: the only container-type strings in the app are the free-text options on the Shipment form's `containerType` dropdown (`index.html:2582`: `20GP`/`40HQ`/`LCL`/`Other`) and the Quote's `freightMode` dropdown (`index.html:722-723` area, options include `LCL`/`FCL 20GP`/`FCL 40HQ`) — neither has a Reefer option, and neither carries any capacity data (they're plain labels/pricing-mode selectors, not profiles).
- **Gap 3 — no weight-limit checking exists anywhere, despite a weight field already existing on Invoice.** `inv.wt` (`index.html:1186`, label "Est. Gross Weight", free-text like `inv.cbm`, e.g. "2200 KGS") is captured, saved, and displayed on invoices and documents, but nothing in the Load Calculator or the Quote feasibility check ever reads it. Both checks are CBM-only.
- **Gap 4 — the CBM-threshold logic is duplicated, not shared, so fixing one site's thresholds (e.g. correcting them, or adding a type) doesn't fix the other.** `runLoadCalc()` and the Quote feasibility check (`calcFeasibility()`, called from `index.html:14141`, body at `index.html:14144-14166`) each independently re-derive the same `<=25`/`<=65` recommendation from their own local `totalCBM`, with their own separately-written ternary chains. There is no shared function either calls.
- **`inv.cbm`/`inv.wt` parsing precedent, to reuse exactly.** Both are free-text fields (not typed numbers) parsed the same way in `runLoadCalc()` (`index.html:13444`): `parseFloat((inv.cbm||'').replace(/[^\d.]/g,'')) || 0`. This REQ's new weight check reuses the identical pattern against `inv.wt`, not a new parsing approach.
- **Precedent for a small, user-editable, local-only reference entity: `DB.events[]`** (an append-and-reference log, never Cloud-Data-synced) — the same precedent REQ-LI-002's `DB.liPending[]` already established and had fully wired per `CLAUDE.md`'s 8-item new-top-level-entity checklist (`K`, `DB`, `EI`, `saveAll`, `showV fns`, `renderAll`, `expAll snap`, `doImport entities`). This REQ's new `DB.containerProfiles[]` follows the identical wiring discipline, not the simpler flat-string-array pattern used by `customUOM`/`customPorts`/`customPaymentTerms` (`index.html:4716-4780`), because a profile needs multiple fields (type code, label, max CBM, max weight, isReefer) per entry, not a single string.
- **Settings tab already has a pattern for a small, user-managed list with add/edit/delete** — the custom Payment Terms / UOM / Ports lists (`index.html:4716-4780`, rendered in Settings) are the closest existing UI precedent, though those are flat string lists; this REQ's new UI needs its own small CRUD block (§2, LI-CONTAINER-002... see requirements) since each row carries more than one field.

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 (operator-selected) — Container profiles are a new, user-editable top-level entity, not hardcoded constants.** `DB.containerProfiles[]`, seeded with built-in industry-standard defaults on first use, editable (add/edit/delete) via a new Settings sub-section — so FPM can add non-standard types or correct a limit without a code change.

**Decision 2 (operator-selected) — Weight is checked against each profile's max payload, using the existing `inv.wt` field, with the same severity pattern as the existing CBM/DG warnings.** Not a disclosed non-goal — built now, not deferred.

**Decision 3 (operator-selected) — Both existing call sites (the Load Calculator and the Quote feasibility check) are unified to read from the new profile table, closing Gap 4, rather than leaving the Quote feasibility check's own hardcoded thresholds as a second, now-inconsistent copy.**

### 1.3 What this REQ deliberately does NOT do

- Does not change `DB.inv`, `DB.qt`, or `DB.sh`'s own record shapes — `inv.wt`/`inv.cbm` are read as-is; Shipment's `containerType` free-text field is not replaced with a profile reference (that would be a larger, riskier change touching an existing field many other places already read — out of scope here; see Decision boundary below).
- Does not do real 3D bin-packing or multi-item load optimization — the recommendation logic stays a simple "does total CBM/weight fit within one profile's limits" threshold check, the same level of sophistication as today, just correctly modeled and de-duplicated instead of guessed.
- Does not warn about DG-cargo/Reefer compatibility (e.g. certain DG classes disallowed in reefer units) — Reefer is added here only as another profile with its own CBM/weight limits; the existing DG warning (unchanged) fires independently of container type.
- Does not change `Shipment.containerType`'s own free-text dropdown to reference a `DB.containerProfiles` id — Shipment keeps its existing plain string field; linking the two is a disclosed non-goal (§4), revisit if it proves to matter in practice.
- Does not backfill or re-run historical Load Calculator results — the calculator has never persisted its own output beyond the current in-memory `_lcResult` (`index.html:13456`), so there is nothing to backfill.
- Does not touch warehousing/storage costs or ExWorks incoterm tracking — that is REQ-CONTAINER-001's sibling, the next priority item, scoped separately.

---

## 2. Requirements

### CONTAINER-001a — New entity: `DB.containerProfiles[]`, fully wired, seeded with built-in defaults
```js
{ id: uid(), code: string, label: string, maxCBM: number, maxWeightKg: number, isReefer: boolean, builtIn: boolean }
```
Full wiring, per `CLAUDE.md`'s own new-top-level-entity checklist, mirroring `DB.liPending`'s own precedent exactly:
- `K.cp: 'st_cp'` added to `K`.
- `DB.containerProfiles: ldArr(K.cp)` added to `DB`'s init object; on first load (array empty and never previously seeded — tracked by a `localStorage` marker, same pattern as `st_li_cloud_migration_ts`-style one-time markers elsewhere in the app, e.g. `st_fpm_repair_v1`), seed 5 built-in rows (`builtIn: true`, not deletable, but editable): `20GP` (max 25 CBM / 21,600 kg), `40GP` (max 58 CBM / 24,000 kg), `40HQ` (max 65 CBM / 26,000 kg), `20RF` (Reefer, max 22 CBM / 20,000 kg, `isReefer: true`), `40RF` (Reefer, max 55 CBM / 24,000 kg, `isReefer: true`). (Weight/CBM figures are standard industry nominal maximums — operator may edit any of them.)
- `sv(K.cp, DB.containerProfiles)` added inside `saveAll()`.
- `containerProfiles: DB.containerProfiles` added to `expAll()`'s export snapshot; a corresponding `doImport()` restore line added in the same style as every entity added after the original 7 (mirroring REQ-LI-002's own round-6/round-7 corrected precedent for this exact step — citing the real lines, not guessed ones, at SPEC time).
- `containerProfiles: []` added to `tests/run.js`'s `resetDB()`.
- No `EI.cp` entry — profiles are managed in a flat list UI (add/edit/delete inline), the same shape as the custom Payment Terms/UOM/Ports lists, not a modal-based single-record editor.
- Confirmed absent from `syncEnt()`/`pullAll()`/`pushAll()` — not Cloud-Data-synced, same category as `DB.events`.
- `showV fns`/`renderAll` — the new management UI lives inside the existing Settings view/`rCfg()`, so (pending SPEC-time confirmation against live code, the same discipline REQ-LI-002 applied) likely no new entry needed, same conclusion as `DB.liPending`'s.

### CONTAINER-001b — Settings UI: add/edit/delete container profiles
A new sub-section in Settings (alongside the existing custom Payment Terms/UOM/Ports lists), listing all `DB.containerProfiles` rows (code, label, max CBM, max weight, Reefer flag) with inline edit and a delete button — disabled/hidden for `builtIn: true` rows' delete action specifically (built-in rows can be edited but not removed, so the Load Calculator always has at least one profile to recommend). An "Add profile" row/button creates a new `builtIn: false` entry.

### CONTAINER-001c — Shared recommendation function, replacing both hardcoded sites
A new function, e.g. `recommendContainer(totalCBM, totalWeightKg)`, returns the smallest-capacity non-Reefer profile (by `maxCBM`, ascending) whose `maxCBM >= totalCBM` **and** `maxWeightKg >= totalWeightKg`, or `null` if none fits (meaning: exceeds the largest available profile — same "exceeds, consider split shipment" outcome as today, just weight-aware too). Reefer profiles (`isReefer: true`) are excluded from this general recommendation — DG/ambient cargo should not be silently recommended into a reefer unit; a Reefer-specific selector, scoped only to the Load Calculator UI (an explicit "This load needs refrigeration" toggle that filters to `isReefer: true` profiles instead), is the only path to a Reefer recommendation.

**Both existing call sites switch to this one function:**
- `runLoadCalc()` (`index.html:13435-13472`): replace the inline `totalCBM <= 25 ? ... : ...` ternary with a call to `recommendContainer(totalCBM, totalWeightKg)`, where `totalWeightKg` is summed from each selected invoice's `inv.wt`, parsed with the identical `parseFloat(...).replace(/[^\d.]/g,'')` pattern already used for `inv.cbm` at `index.html:13444`. A weight-exceeded warning (same visual severity as the existing DG banner) is added alongside the existing CBM-based recommendation when weight, not CBM, is the limiting factor.
- The Quote feasibility check (`index.html:14149-14166`): replace its own `totalCBM <= 25 ? ... : ...` ternary with the same `recommendContainer()` call. Quote lines have no weight field today — confirmed absent from `cQL`'s line shape as built in `saveQte()` (`index.html:14202-14222`: `rid, supId, desc, qty, uom, cost, cbm, dg, dutyPct, markup, insRate` — no weight key), the identical line shape REQ-LI-002 already cited for its own "no `sku` key" finding — so the Quote-side call passes `totalWeightKg: 0` (never the limiting factor there), CBM-only, same behavior as today for this call site; this is a disclosed non-goal (§4), not a regression, since Quote genuinely has no weight data to pass.

### CONTAINER-001d — Load Calculator surfaces weight alongside CBM
`runLoadCalc()`'s result table gains a Weight column (per invoice, parsed from `inv.wt`) and a Total Weight row, displayed the same way the existing Total CBM row is. `exportLoadSummary()` (`index.html:13474-13497`) includes the new weight figures in its text export, in the same style as the existing CBM/container-rec lines.

---

## 3. Acceptance criteria

- **AC-1:** On first load after this version ships, `DB.containerProfiles` is seeded with exactly the 5 built-in rows (§2, CONTAINER-001a) if and only if it was previously empty and never seeded before (checked via the one-time marker) — a device that already has custom profiles from a prior session is never re-seeded or overwritten.
- **AC-2:** Adding a new profile via Settings persists it to `DB.containerProfiles` and makes it immediately selectable/recommendable by `recommendContainer()`.
- **AC-3:** Editing a built-in profile's `maxCBM`/`maxWeightKg` changes what `recommendContainer()` returns for loads near that boundary; the built-in row's Delete action is disabled/hidden.
- **AC-4:** Deleting a non-built-in profile removes it from `DB.containerProfiles` and from future recommendations.
- **AC-5:** `recommendContainer(totalCBM, totalWeightKg)` returns the smallest-capacity fitting non-Reefer profile when both CBM and weight fit; returns the next-larger profile when the smallest would fit on CBM alone but not weight; returns `null` when no non-Reefer profile fits either dimension.
- **AC-6:** `runLoadCalc()` with invoices whose total weight exceeds the CBM-recommended profile's `maxWeightKg` (but whose CBM would fit a smaller profile) recommends the next larger profile and/or shows a weight-specific warning, not silently recommending the CBM-only answer.
- **AC-7:** `runLoadCalc()`'s Reefer toggle, when enabled, recommends only from `isReefer: true` profiles.
- **AC-8:** The Quote feasibility check's existing CBM-based notices (`index.html:14149-14166`) still fire with the same `recContainer`/mode-mismatch logic as today, now sourced from `recommendContainer()` instead of the inline ternary — confirmed by a test asserting identical notice output for the same CBM inputs pre/post this change.
- **AC-9:** `expAll()`/`doImport()` round-trip `containerProfiles` correctly (export includes it; restoring a backup with a different set replaces the in-memory list, not silently discarded).
- **AC-10:** `tests/run.js`'s `resetDB()` includes `containerProfiles: []`.

---

## 4. Explicitly out of scope for v1

No linkage between `DB.containerProfiles` and `Shipment.containerType`'s own free-text field (§1.3) — a Shipment's recorded container type is not validated against, or auto-filled from, a profile; this is a disclosed non-goal, revisit if the operator wants that integration later. The Quote feasibility check's weight input is always `0` (Quote lines carry no weight field) — a disclosed limitation, not a regression, since no weight data exists on Quote lines to pass. No DG/Reefer compatibility warnings (§1.3). No 3D load optimization (§1.3). No historical backfill (§1.3, nothing to backfill).

## 5. Open questions for independent review

None outstanding — ready for round 1.
