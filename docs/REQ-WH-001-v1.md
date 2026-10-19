# REQ-WH-001 — Warehousing/storage cost estimate for ExWorks shipments

**Status:** v1 — first draft, not yet submitted for independent requirements-gate review.
**Type:** New fields on an existing Cloud-Data-synced entity (`DB.sh`) + new rate constants on an existing local-only settings object (`QR`) + a computed, never-persisted cost readout. **Unlike REQ-CONTAINER-001, this REQ does require a Supabase schema migration** — two new columns on the `shipments` table — because `DB.sh` is Cloud-Data-synced (REQ/SPEC-CLOUD-007) and `QR` is not.

---

## 0. How this REQ came to be scoped this way

Operator's own priority ordering for data-model robustness work: "1, shipment<>invoice. 2, container profile table. 3, warehousing/storage cost concept." Item 1 (REQ-SHIP-002, clean PASS) and item 2 (REQ-CONTAINER-001, clean PASS) are both specified but not yet implemented. This REQ addresses item 3. A direct code survey (§1.1) found the warehousing/storage concept doesn't exist in the app at all today, and surfaced a real dependency on item 1's still-unfixed gap (§1.1, Gap 4). The operator then resolved four scoping questions (§1.2) before this draft.

---

## 1. Business context

### 1.1 What exists today (check-first)

- **Gap 1 — no warehousing/storage-cost concept exists anywhere.** Confirmed by a full-file, case-insensitive search for "warehous"/"storage" (as a business concept, not the unrelated browser-`localStorage`-quota "Storage Health" dashboard card and `checkStorageQuota()`, `index.html:258-263`) and "ExWorks"/"EXW" — no entity, field, rate constant, or calculator touches this today.
- **Gap 2 — no "goods ready for collection" or "collected" date exists on any entity.** `Shipment` (`DB.sh`) has `etd`/`eta` (`index.html:2579-2580`, label map `index.html:4914`) — shipping-side dates, not warehousing ones. `Order Request` (`DB.ord`) has a `Processing → Fulfilled` stage transition (`ORD_TRANSITIONS`, `index.html:3228-3237`) — the closest existing *concept* to "goods ready," but no date field anywhere records when that transition happened or when goods were actually collected. `Invoice` has no comparable date field either.
- **Gap 3 — `incoterm` only exists on Invoice.** Confirmed absent from `DB.qt`/`DB.sh`/`DB.ord` schemas. `Invoice.incoterm` (`index.html:1192`, populated from `RD_INCOTERMS`, `index.html:4584-4598`) is a required field (`index.html:10584,10691-10692`) with `EXW` (`{code:'EXW',name:'Ex Works',...}`, `index.html:4585`) as a real, existing option.
- **Gap 4 — the only Shipment↔Invoice relationship is `Shipment.linkedInvs[]`, an array of free-text Invoice **`num`** strings, not ids — the same loose, unvalidated reference REQ-SHIP-002 (clean PASS, not yet implemented) already diagnosed and designed a fix for.** Confirmed by direct read: `saveShp()` (`index.html:13301-13326`) builds `linkedInvs` by splitting a comma-separated text field (`shf-invs`, `index.html:13304-13305`), and the demo seed stores Invoice *numbers* there (`index.html:5512`: `linkedInvs: ['DINV-0001']`), not ids. **This REQ must be built against this current, unvalidated shape — resolving an EXW-flagged invoice for a given Shipment means `DB.inv.find(function(inv){ return inv.num === numStr; })` for each string in `linkedInvs`, with no guarantee any given string actually resolves.** If REQ-SHIP-002 ships first, this REQ's own resolution logic should be revisited to use its hardened `linkedInvIds[]` instead — out of this REQ's own scope to anticipate.
- **Gap 5 — `Shipment` is Cloud-Data-synced (REQ/SPEC-CLOUD-007), with four distinct Cloud Data touchpoints that must all be extended for any new field, the same risk class REQ-SHIP-002 itself flagged (its own "4 Cloud Data touchpoints including the easily-missed `shRow` object inside `autoCreateShipmentFromInvoice()`").** Confirmed by direct read, all four:
  1. `saveShp()`'s own `shRow` object (`index.html:13358-13366`).
  2. The one-time Cloud-Data-migration push loop that inserts every existing local Shipment on first migration (`index.html:7463-7470`-adjacent).
  3. `autoCreateShipmentFromInvoice()`'s own `shRow` object, built when a Shipment is auto-created from a Paid invoice (`index.html:8946-8953`).
  4. `refreshShFromSupabase()`'s pull-side row→object mapping (`index.html:6298-6312`).
  Missing any one of these four would silently drop the new fields on exactly one of: save, first-migration, auto-creation, or pull-refresh — the same failure class REQ-SHIP-002's own §1.1 named explicitly for this same function family.
- **Precedent for a small, user-editable rate-constants object: `QR`/`QR_DEFAULTS`, already fully wired for exactly this purpose.** `QR_DEFAULTS` (`index.html:4359`) is a flat object of editable shipping-rate constants (`fxGBPUSD`, `lclPerCBM`, `fcl20GP`, `fcl40HQ`, `originCharges`, `dgSurcharge`, `fpmAdmin`, etc.); `QR` (`index.html:4360`) is the live, localStorage-backed instance (`Object.assign({}, QR_DEFAULTS, ld('st_qr') || {})`), already round-tripped by three existing functions: `qteFillRates()` (`index.html:14776-14782`, populates the Settings form from `QR`), `ratesFromForm()` (`index.html:14784-14790`, reads the form back into a plain object), and `saveRates()` (`index.html:14792-14794`-adjacent, `Object.assign(QR, QR_DEFAULTS, ratesFromForm())` then persists). All three use a single `numFields` array of field names (`index.html:14777,14786`) that a new rate constant joins by being added to that one array plus a new `qr-<name>` input in the Settings HTML — no new entity, no new wiring class, unlike `DB.containerProfiles` in REQ-CONTAINER-001. `QR` is also already in `expAll()`/`doImport()` (`index.html:13094,13142`: `qr: ld('st_qr')` / `if (data.qr) { sv('st_qr', data.qr); QR = Object.assign({}, QR_DEFAULTS, data.qr); }`), so two new keys need no additional import/export wiring at all.
- **Date-field validation precedent to reuse exactly: `vBlurDate()`/`vBlurDateAfter()`, already used for `etd`/`eta`.** `vShp()` (`index.html:10719-10729`) validates `etd` with `vBlurDate` and `eta` with `vBlurDateAfter('shf-eta','shf-etd','ETA','ETD')` — the second rejects an ETA earlier than ETD. The new `collectedDate` needs the identical "not before" check against `goodsReadyDate`.
- **`inv.cbm` parsing precedent to reuse exactly.** Free-text field (e.g. "18 CBM"), parsed everywhere via `parseFloat((inv.cbm||'').replace(/[^\d.]/g,'')) || 0` (`index.html:13444`, already cited by REQ-CONTAINER-001 for the identical reason).

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 (operator-selected) — The "goods ready" and "collected" dates live on `Shipment`, as two new fields, not on Order Request and not as a new standalone entity.** Shipment already models the pre-departure lifecycle (`etd`/`eta`, container type, docs status) and is where an operator tracking a container awaiting pickup would already be looking.

**Decision 2 (operator-selected) — EXW detection stays scoped to `Invoice.incoterm`; no incoterm field is added to Shipment or Order Request in this REQ.** Accepted limitation: storage time often begins before an Invoice exists, so this REQ cannot flag EXW-ness until at least one linked Invoice has been raised with `incoterm:'EXW'`. Revisit if it proves to matter in practice (§4).

**Decision 3 (operator-selected) — The rate model is a user-editable per-day rate plus a per-day-per-CBM rate, both added to `QR`/`QR_DEFAULTS`, not a new entity.** Mirrors how `lclPerCBM`/`fcl20GP`/etc. are already modeled — two numbers, not a multi-row table (unlike REQ-CONTAINER-001's `DB.containerProfiles`, which genuinely needed multiple rows).

**Decision 4 (operator-selected) — The calculated cost is a computed, never-persisted, on-screen estimate only; nothing is auto-written into any Invoice charge field.** The Shipment edit view shows a live-computed "Estimated Storage Cost" readout whenever the conditions in §2 WH-001c are met; the operator transcribes it into Invoice's existing free-form "Other Charges" field (`if-oth`, `index.html:1230`) by hand, if desired. No change to `vInv()`/`cInv()`/any Invoice totals logic.

### 1.3 What this REQ deliberately does NOT do

- Does not add an `incoterm` field to `Shipment` or `Order Request` (Decision 2) — EXW detection is Invoice-only, with the timing limitation that implies.
- Does not auto-write the computed estimate into any Invoice field (Decision 4) — it is a read-only, recomputed-on-render display, never a saved value, specifically so it never goes stale relative to "today" while a Shipment sits uncollected.
- Does not improve `Shipment.linkedInvs[]`'s own data integrity — this REQ consumes it exactly as it exists today (loose `num`-string array, per Gap 4), and does not duplicate or pre-empt REQ-SHIP-002's own, separate, not-yet-built fix for that relationship.
- Does not build a standalone "Storage Calculator" tool analogous to the Load Calculator — the estimate is computed and shown directly on the one Shipment record it concerns, since (unlike the Load Calculator's ad-hoc multi-invoice container-sizing problem) there is no cross-Shipment aggregation need here.
- Does not handle multi-currency storage rates beyond `QR`'s own existing `displayCurrency` convention — the new rate constants are plain numbers in whatever currency the operator's other `QR` rates are already in.
- Does not track a history/ledger of storage-cost estimates over time — only the current, live-computed figure is ever shown; nothing is logged.
- Does not change `DB.ord`'s `Processing`/`Fulfilled` stage semantics or add any date field there (Decision 1).

---

## 2. Requirements

### WH-001a — New `Shipment` fields: `goodsReadyDate`, `collectedDate`
Two new date fields, same `<input type="date">` shape as `etd`/`eta`. Added to:
- Shipment form HTML, immediately after the existing ETD/ETA fields (`index.html:2579-2580`-adjacent): new `shf-ready`/`shf-collected` date inputs.
- `saveShp()`'s object literal (`index.html:13306-13326`): `goodsReadyDate: G('shf-ready').value, collectedDate: G('shf-collected').value,`.
- `openShp()`'s clear-on-new block (`index.html:13267`-adjacent): `if(G('shf-ready')) G('shf-ready').value=''; if(G('shf-collected')) G('shf-collected').value='';`.
- `editShp()`'s pre-fill (`index.html:13288`-adjacent): `G('shf-ready').value=s.goodsReadyDate||''; G('shf-collected').value=s.collectedDate||'';`.
- `vShp()` (`index.html:10719-10729`-adjacent): `goodsReadyDate` validated with `vBlurDate`, same pattern as `etd`; `collectedDate` validated with `vBlurDateAfter('shf-collected','shf-ready','Collected Date','Goods Ready Date')`, the identical "not before" pattern already used for `eta` vs `etd`.
- The `sh` label map (`index.html:4914`): `goodsReadyDate:'Goods Ready Date', collectedDate:'Collected Date'` added.
- **All four Cloud Data touchpoints from §1.1 Gap 5, not a subset:**
  1. `saveShp()`'s `shRow` (`index.html:13358-13366`): `goods_ready_date: shp.goodsReadyDate || null, collected_date: shp.collectedDate || null,` added.
  2. The one-time migration push loop (`index.html:7463-7470`-adjacent): same two keys added to that `insert()` call's row object.
  3. `autoCreateShipmentFromInvoice()`'s `shRow` (`index.html:8946-8953`): `goods_ready_date: null, collected_date: null,` added — a Shipment auto-created from a Paid invoice has neither date yet by definition.
  4. `refreshShFromSupabase()`'s pull mapping (`index.html:6298-6312`): `goodsReadyDate: row.goods_ready_date || '', collectedDate: row.collected_date || '',` added to the mapped object.
- **Supabase schema migration required:** two new nullable `date` columns, `goods_ready_date` and `collected_date`, on the `shipments` table — the one piece of this REQ that is not purely a client-side change, and the reason this REQ's **Type** line differs from REQ-CONTAINER-001's "no Supabase migration" framing.

### WH-001b — New `QR`/`QR_DEFAULTS` rate constants: `storagePerDay`, `storagePerCBMPerDay`
Two new numeric keys added to `QR_DEFAULTS` (`index.html:4359`), e.g. `storagePerDay:15, storagePerCBMPerDay:2`. Both names added to the existing `numFields` array in **both** `qteFillRates()` and `ratesFromForm()` (`index.html:14777,14786`) — this single array addition is the entire wiring needed for display, read-back, and persistence (via `saveRates()`'s existing `Object.assign(QR, QR_DEFAULTS, ratesFromForm())`), with `expAll()`/`doImport()` already covering `QR` wholesale (§1.1). Two new `<input type="number" id="qr-storagePerDay">` / `id="qr-storagePerCBMPerDay"` fields added to the Settings rates panel (`index.html:721-728`-adjacent), same `.fld` markup shape as the existing rate inputs.

### WH-001c — Shipment edit view: computed, live "Estimated Storage Cost" readout
Shown only when **both** of the following hold for the Shipment being viewed/edited:
1. `goodsReadyDate` is set.
2. At least one entry in `linkedInvs[]` resolves (via `DB.inv.find(function(inv){ return inv.num === numStr; })`, per Gap 4) to a real Invoice with `incoterm === 'EXW'`.

When shown, computed fresh on every render (never persisted, never a saved field on `DB.sh` itself):
- `days = Math.max(0, Math.ceil((Date.parse(collectedDate || today) - Date.parse(goodsReadyDate)) / 86400000))` — uses `collectedDate` if set, else today's date, so the estimate keeps climbing for a Shipment still sitting uncollected.
- `totalCBM` = sum of `parseFloat((inv.cbm||'').replace(/[^\d.]/g,'')) || 0` (the exact existing parsing pattern, §1.1) across every EXW-incoterm Invoice resolved from `linkedInvs[]` for this Shipment — **not** across every linked Invoice regardless of incoterm, since only EXW cargo plausibly sits in the seller's own warehouse this way.
- `estimatedCost = days * QR.storagePerDay + days * totalCBM * QR.storagePerCBMPerDay`.
- Displayed as a labeled, read-only line (e.g. "Estimated Storage Cost: $NNN.NN (N days × M.MM CBM)"), in the same visual style as other computed/derived readouts already shown elsewhere in this app's edit forms (e.g. the Quote form's "Default: $X" placeholder pattern, `index.html:14110`).

---

## 3. Acceptance criteria

- **AC-1:** `saveShp()` persists `goodsReadyDate`/`collectedDate` from the new form fields; `openShp()` clears them on a new Shipment; `editShp()` pre-fills them from the record being edited.
- **AC-2:** `vShp()` rejects a `collectedDate` earlier than `goodsReadyDate`, mirroring the existing ETA-before-ETD rejection exactly.
- **AC-3:** With Cloud Data migration active (`_sb` set, `st_sh_cloud_migration_ts` present), saving a Shipment with both new dates round-trips them through `saveShp()`'s Cloud branch and back through `refreshShFromSupabase()` correctly.
- **AC-4:** The one-time Cloud Data migration push correctly carries forward `goodsReadyDate`/`collectedDate` for every pre-existing local Shipment that has them set.
- **AC-5:** A Shipment auto-created from a Paid EXW invoice (`autoCreateShipmentFromInvoice()`) is created with both new date fields present and null/blank, not missing entirely, whether or not Cloud Data migration is active.
- **AC-6:** `QR_DEFAULTS` includes `storagePerDay`/`storagePerCBMPerDay`; `qteFillRates()` populates the two new Settings inputs from `QR`; `ratesFromForm()`/`saveRates()` correctly read and persist operator edits to them; `expAll()`/`doImport()` round-trip them as part of `QR`'s existing wholesale export/restore, with no additional code.
- **AC-7:** The Estimated Storage Cost readout does **not** appear on a Shipment with no `goodsReadyDate` set, nor on a Shipment whose every linked Invoice (resolved via `linkedInvs[]`) is non-EXW or fails to resolve to a real Invoice at all.
- **AC-8:** The readout **does** appear, with a correct `days`/`totalCBM`/`estimatedCost` figure, for a Shipment with `goodsReadyDate` set and at least one resolved EXW-incoterm linked Invoice — tested both with `collectedDate` set (fixed day count) and unset (day count anchored to "today," confirmed to differ across two calls on different mock "today" dates).
- **AC-9:** `totalCBM` in the readout sums only the EXW-incoterm linked Invoices' `cbm`, excluding any non-EXW linked Invoice's `cbm` from the total, even when both are linked to the same Shipment.
- **AC-10:** A `linkedInvs[]` entry that does not resolve to any real `DB.inv` record (a dangling reference, per Gap 4) is silently skipped in the EXW-resolution/CBM-summation logic, not treated as a crash or as a false EXW match.
- **AC-11:** Editing `storagePerDay`/`storagePerCBMPerDay` in Settings changes the readout's `estimatedCost` on the next render, with no stale caching.

---

## 4. Explicitly out of scope for v1

No `incoterm` field on Shipment/Order Request (Decision 2) — a real, accepted timing limitation: storage before any Invoice exists cannot be flagged as EXW by this feature, revisit if it proves to matter in practice. No auto-write into any Invoice charge field (Decision 4). No improvement to `Shipment.linkedInvs[]`'s own data integrity — that is REQ-SHIP-002's separate, already-specified-but-unbuilt fix; if it ships first, this REQ's `linkedInvs[]`-resolution logic (§2 WH-001c) should be revisited to use the hardened `linkedInvIds[]` it would introduce, but anticipating that is out of this REQ's own scope. No standalone multi-Shipment "Storage Calculator" tool. No multi-currency rate handling beyond `QR`'s existing convention. No storage-cost history/ledger. No change to `DB.ord`'s stage semantics.

## 5. Open questions for independent review

None outstanding — ready for round 1.
