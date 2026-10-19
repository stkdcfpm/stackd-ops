# REQ-SHIP-002 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Status:** v4 — revises v3 after independent requirements-gate review round 3 (second confirmatory): **FAIL**, 1 new blocking finding + 2 new advisory findings, all personally re-verified against live code before being accepted (§9c). Round 2's blocking finding and 3 of 4 advisory findings were independently re-confirmed RESOLVED by round 3; the 4th (checkbox UX) was found PARTIALLY RESOLVED — the fix's *intent* was right but its mechanism had a real, undetected gap. Fixed below. Not yet resubmitted.
**Type:** Entity-relationship rework. Extends the existing Shipment entity (`DB.sh`) and its Cloud Data table with two new fields (`linkedInvIds[]`, `linkedInvSnapshots[]`); extends `autoCreateShipmentFromInvoice()`, `saveShp()`, `editShp()`, `openShp()`, and adds a new `renderShpSourceDriftWarn()` mirroring the existing Quote/PO pattern, plus a new `recomputeShpDgLiveState()` for the live checkbox behavior. One new migration file. No new external dependency.

---

## 0. How this REQ came to be scoped this way

Operator asked, after a user-reported Quote pricing bug led to an unrelated question about the Shipments tab: *"what is the relationship to the invoices that are linked to the shipment record — is any data inherited from the invoice or line item level?"* Direct code read found the answer was "almost none" — `linkedInvs` is a bare array of invoice-number strings, unvalidated, never dereferenced against `DB.inv`, and DG status is hardcoded `false` at auto-creation regardless of the source invoice's own DG-flagged lines. Operator's verdict, verbatim: *"This is a poor design... considering we want a robust system that runs on the dependence of entities and their relationships... to keep a way of storytelling the lifecycle of an order which also helps with automation of workflows."* Operator confirmed this as priority #1 of three (ahead of a container-profile rework and a warehousing-cost concept, both separately scoped), and answered three scoping questions up front (§1.2 Decisions 1–3) rather than leaving them for a reviewer to catch.

**Explicitly not a historical defect.** `supabase/migrations/0007_shipments.sql`'s own comment on `linked_invs` states this was a *deliberate* scoping decision at the time (`REQ-CLOUD-007 §1.1b`): "NOT foreign-key-constrained and never will be... Invoice-number matching against this field happens client-side only, never as a database constraint." That decision was correct for what REQ-CLOUD-007 was scoped to do. This REQ is a deliberate, explicit reversal of that scoping call, not a bug fix.

---

## 1. Business context

### 1.1 What exists today (check-first)

- `DB.sh.linkedInvs` (`index.html:13304`, `saveShp()`) — a plain array of invoice-number strings, parsed from one free-text comma-separated form field (`shf-invs`). No lookup against `DB.inv` anywhere.
- `DB.sh.autoCreatedFromInvIds` (`index.html:8940`) — real Invoice *ids*, used only as an idempotency check inside `autoCreateShipmentFromInvoice()`.
- `autoCreateShipmentFromInvoice(inv)` (`index.html:8923-8963`) hardcodes `dg: false` at `index.html:8938` and separately calls `shpSeedTradeDocs(false)` at `index.html:8935`. Origin/dest port also start blank — never pre-filled from `inv.pol`/`inv.pod` (confirmed format-compatible — both sides use the identical free-text-with-`dl-ports`-datalist input, `index.html:2577-2578` vs `index.html:1189-1190`).
- `autoCreateShipmentFromInvoice()` builds a SECOND, independent object for the Cloud Data branch — `shRow` at `index.html:8946-8952` — which hardcodes `dg: false, origin_port: null, dest_port: null` separately from `newShp`, and the function then calls `refreshShFromSupabase()` (`index.html:8956`) immediately after, overwriting the local record. The Cloud Data branch only runs once `st_sh_cloud_migration_ts` is already set (`index.html:8944`), and `refreshShFromSupabase()`'s own guard checks only that same marker (`index.html:6299`) — it does not skip re-fetching the just-inserted record. This is the fourth of four Cloud Data touchpoints this REQ must change (§2, REQ-SHIP-002f).
- Two independent, currently-divergent inline DG-detection checks exist in the Load Calculator: `openLoadCalc()` (`index.html:13415-13418`, `cat && cat.dg` only) and `runLoadCalc()` (`index.html:13446-13449`, `(cat && cat.dg) || li.dg`). Not logically equivalent today. Unifying them (REQ-SHIP-002h) is a small, disclosed behavior change at `openLoadCalc()`'s one call site, not a pure refactor.
- `renderPoSourceDriftWarn()` (`index.html:8969-9009`) is a single-source, single-boolean design — compares exactly one `po.invId` against one live invoice, one generic message. `renderShpSourceDriftWarn()` (REQ-SHIP-002d) must aggregate over potentially many `linkedInvSnapshots[]` entries with per-field detail — a necessary structural extension, not a literal copy.
- `backfillShLinkedInvs()` (`index.html:3160-3173`) and `migrateLinkedPOIds()` (`index.html:3149-3158`) have no device-level marker — each is purely condition-based, called together at exactly `index.html:13152-13153` (`doImport`) and `index.html:15740-15741` (`initApp`).
- `linkedInvs` is explicitly not required to be 1:1 — a Shipment can consolidate multiple Invoices.
- Four existing tests (`tests/run.js:14131,14144,14156,14169`) assert `shp.dg` is driven purely by the `shf-dg` checkbox when `linkedInvs` is empty, via `setupShpFormMinimal()`. Any DG rule this REQ introduces must preserve this exactly.
- `editShp()` sets the `shf-dg` checkbox purely from the stored `dg` value (`G('shf-dg').checked=!!s.dg;`, `index.html:13289`), with no awareness of *why* `dg` is true.
- **The existing `shf-docs` dropdown is the one real precedent in this codebase for "disable a field and keep its displayed value in sync with a computed value, not just toggle `disabled` alone"** (`index.html:8888-8893`, inside `renderShpDocsPanel()`): `docsSelect.disabled = docs.length > 0; ...; if (docs.length > 0) docsSelect.value = s.docsStatus || 'Pending';` — the disable toggle and the value sync happen together, every time, not independently. **Round 3 found v3's own `shf-dg` checkbox fix violated exactly this precedent** by specifying the disable/enable toggle without specifying any corresponding `.checked` reset — see §1.1 continuation below and §9c.
- **`shf-invs` has no `oninput`/`onchange` attribute today, and neither does any other `shf-*` field on this modal** (confirmed by inspecting `index.html:2567-2616`, the whole Shipment form markup — zero such attributes). The `shf-docs` disable precedent above is driven by explicit function calls from discrete trade-document row actions (`renderShpDocsPanel()`, triggered by `onchange`/`onblur`/`onclick` on dynamically generated rows), never by an `oninput` on a typed free-text field. **v3 claimed the live-recompute hook could reuse "the same `oninput` that already drives other live recalculation in this modal" — false; no such hook exists anywhere in this modal.** This REQ's live-recompute hook (REQ-SHIP-002c) is genuinely new wiring, disclosed as such.

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 — Multi-invoice conflicts: DG is OR'd across every linked invoice (additive to, never a replacement for, the operator's own manual checkbox); destination/origin port inherit from the first-linked invoice but a mismatch from a later-linked invoice is a warning, never a silent overwrite or a block.**
DG is a safety property — OR-ing across invoices is conservative by default and must only ever add DG risk, never remove an operator's own independent confirmation of it. Destination/origin port are informational — a soft warning, not a block, on mismatch.

**Decision 2 — Post-link drift detection: yes, mirror the Quote/PO "snapshot at link time, compare to live on render, warn, never auto-overwrite" *contract* — adapted into a multi-source design.**
`linkedInvSnapshots[]` captures `{invId, dg, pol, pod}` per linked invoice at link time; compared to live Invoice data on every render; mismatches shown as a non-blocking banner, never auto-corrected.

**Decision 3 — Historical backfill: yes, self-healing, re-run safely every time, no device marker.**
`backfillShLinkedInvIds()`, wired at the identical two call sites as its two precedents, resolves any unresolved `linkedInvs` entry on every run, not gated behind a one-time marker.

### 1.3 What this REQ deliberately does NOT do

- Does not turn `shf-invs` into a picker/dropdown widget.
- Does not add a database foreign-key constraint on the array columns.
- Does not change `originPort`/`destPort` for a Shipment that already has a non-blank value.
- Does not deduplicate a `linkedInvs` array containing the exact same invoice number more than once.
- Does not add the two new fields to `FIELD_MAPS.sh`.
- Does not touch the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification, and does not touch any warehousing concept (REQ-SHIP-003/004, separately scoped).
- Does not retroactively correct a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute.
- Does not require remembering the previous save's linked-invoice set for the `saveShp()` DG rule itself (full recomputation every save, §2 REQ-SHIP-002c) — but **does** require one small, explicitly new piece of session-scoped UI state for the live checkbox behavior specifically (§2 REQ-SHIP-002c, `_shpDgInvoiceDriven`), which is a different concern (what the checkbox currently displays while the modal is open) from the save-time DG rule (what gets persisted) — the two must not be conflated.

---

## 2. Requirements

### REQ-SHIP-002a — New Shipment schema fields: `linkedInvIds[]` and `linkedInvSnapshots[]` — compact, not positionally-parallel to `linkedInvs`
```js
linkedInvs: ['INV10031', 'INV-TYPO', 'INV10032'],   // as typed — may contain an entry that never resolves
linkedInvIds: ['inv-uuid-1', 'inv-uuid-3'],          // ONLY the entries that resolved, in resolution order — length may be LESS than linkedInvs.length, and there is NO positional correspondence to linkedInvs by index
linkedInvSnapshots: [
  { invId: 'inv-uuid-1', dg: false, pol: 'Qingdao', pod: 'Bridgetown' },
  { invId: 'inv-uuid-3', dg: true,  pol: 'Ningbo',   pod: 'Bridgetown' }
]
```
`linkedInvIds` is the compacted list of ids that successfully resolved — built with an ordinary `.map()`+`.filter(Boolean)`, never a sparse/hole-preserving construction. Nothing downstream needs index correspondence between `linkedInvs`/`linkedInvIds`/`linkedInvSnapshots`, because `linkedInvSnapshots` entries are self-identifying via their own `invId` field (`renderShpSourceDriftWarn()`, REQ-SHIP-002d, looks up by `invId`, never by shared array index).

### REQ-SHIP-002b — `autoCreateShipmentFromInvoice(inv)` inherits DG and port on creation
Revise `index.html:8936-8942` (`newShp`): `dg` computed via `invHasDG(inv)` (REQ-SHIP-002h). `originPort`/`destPort` pre-filled from `inv.pol`/`inv.pod` (blank if neither set). `linkedInvIds: [inv.id]` and `linkedInvSnapshots: [{invId: inv.id, dg, pol: inv.pol||'', pod: inv.pod||''}]` set alongside the existing `linkedInvs: [inv.num]`.

### REQ-SHIP-002c — `saveShp()`'s DG rule, port-inheritance fallback, and the `shf-dg` checkbox's live-sync behavior (revised — round 3)
**DG rule at save time, construction algorithm:**
```js
var resolved = linkedInvs.map(function(num){ return DB.inv.find(function(i){ return i.num === num; }); })
                         .filter(Boolean);
var linkedInvIds = resolved.map(function(inv){ return inv.id; });
var linkedInvSnapshots = resolved.map(function(inv){
  return { invId: inv.id, dg: invHasDG(inv), pol: inv.pol || '', pod: inv.pod || '' };
});
var invoiceDG = linkedInvSnapshots.some(function(snap){ return snap.dg; });
shp.dg = G('shf-dg').checked || invoiceDG;
```
Operates over **this save's freshly-parsed `linkedInvs`**, never a previously-stored set.
- Zero linked invoices: `invoiceDG` is `false`, so `shp.dg` reduces to exactly `G('shf-dg').checked` — byte-identical to current behavior (AC-11–14).
- Adding a DG-flagged invoice while unchecked: `shp.dg` becomes `true` (AC-3).
- Removing the only DG invoice while unchecked: `shp.dg` becomes `false` (AC-4).
- Removing the only DG invoice while the operator has, in the same save, manually checked the box: `shp.dg` stays `true` (AC-4b).

**Port inheritance fallback:** iterate the newly-resolved invoices in `linkedInvs` order; use the first one whose `pol`/`pod` is non-blank. If none has a non-blank port, leave `originPort`/`destPort` exactly as they were (deferred, not lost — AC-5b).

**`shf-dg` checkbox live-sync — corrected mechanism (round-3 finding; v3's version specified the disable/enable toggle but not a matching `.checked` reset, which could leave `shp.dg` stuck `true` after the operator did exactly what the tooltip told them to do):**

New module-level UI-state flag `_shpDgInvoiceDriven` (boolean, mirrors this codebase's existing precedent for small, explicitly-disclosed session-scoped UI flags, e.g. `cRfqEditId` — not part of `DB`, not persisted, reset by the functions below, never by `resetDB()`):

```js
function recomputeShpDgLiveState() {
  var cb = G('shf-dg');
  if (!cb) return;
  var invoiceDG = shpCurrentLinkedInvoicesHaveDG(); // resolves shf-invs's live value against DB.inv, ORs invHasDG() per REQ-SHIP-002h
  if (invoiceDG) {
    cb.checked = true;
    cb.disabled = true;
    cb.title = 'DG is set by a linked invoice — remove it from Linked Invoices to clear.';
    _shpDgInvoiceDriven = true;
  } else {
    cb.disabled = false;
    cb.title = '';
    if (_shpDgInvoiceDriven) cb.checked = false; // only reset the value on the TRANSITION out of invoice-driven —
                                                   // never touches an operator's own independent checked state otherwise
    _shpDgInvoiceDriven = false;
  }
}
```
This mirrors the `shf-docs`/`renderShpDocsPanel()` precedent exactly (§1.1): disable/enable and the displayed value are kept in sync together, in one function, every time — never disable alone.

**Wiring, explicitly new (closes round-3 advisory 1 — v3's "same oninput" claim was false; there is no existing hook to reuse):**
- A new `oninput="recomputeShpDgLiveState()"` attribute is added directly to the `shf-invs` input element (`index.html:2593`-adjacent) — the first `oninput` this field has ever had.
- `editShp()` calls `recomputeShpDgLiveState()` once, immediately after setting `shf-invs`/`shf-dg`'s initial values from the record being opened (`index.html:13289`-adjacent) — this both applies the correct initial disabled/checked state for whatever's already linked, AND correctly initializes `_shpDgInvoiceDriven` for that record (so a subsequent live edit's transition-detection in `recomputeShpDgLiveState()` has the right starting point — it does not need a separate initialization branch, since the function already derives `_shpDgInvoiceDriven` purely from calling itself once with the record's real starting state).
- `openShp()` also calls `recomputeShpDgLiveState()` once, immediately after its own existing reset of `shf-invs`/`shf-dg` to blank/unchecked (`index.html:13265-13272`-adjacent) — **closes round-3 advisory 2 explicitly**: this is a no-op in practice today (blank `shf-invs` resolves to zero invoices, `invoiceDG` is `false`, nothing changes), but it means a brand-new Shipment session starts with `_shpDgInvoiceDriven` correctly `false`, and if the operator types a DG invoice number into `shf-invs` before ever saving, the same live `oninput` hook (shared by both modals, since `shf-invs` is one element) correctly disables/checks the box on the create path too, with no separate code path needed.

### REQ-SHIP-002d — `renderShpSourceDriftWarn(shp)` — new function, new banner on the Edit Shipment modal
Adapted from (not a literal copy of) `renderPoSourceDriftWarn()`'s snapshot-vs-live contract (`index.html:8969-9009`): for each entry in `linkedInvSnapshots` (looked up by its own `invId` — never by shared array index), look up the live Invoice by `invId`; if not found, one line naming that invoice; if found, compare `dg`/`pol`/`pod` against the snapshot and list every differing field. Shows one line per affected invoice. Wired into `editShp()` like `renderPoSourceDriftWarn()` is wired into `editPO()`, with a dedicated `<div id="shp-drift-warn">`.

### REQ-SHIP-002e — `backfillShLinkedInvIds()` — self-healing resolution, wired at the same two call sites as its precedents, no device marker
No localStorage marker. Iterates `DB.sh`; rebuilds `linkedInvIds`/`linkedInvSnapshots` using the exact same compaction algorithm as REQ-SHIP-002c. Wired into `index.html:13152-13153` and `index.html:15740-15741`, alongside the existing calls at both sites. Logs (via `console.warn`) any entry that still doesn't resolve.

### REQ-SHIP-002f — Cloud Data: two new nullable `jsonb` columns, all four existing touchpoints extended
New migration `supabase/migrations/0010_shipments_linked_inv_ids.sql`:
```sql
alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
```
Wire into all four of the Shipment Cloud Data layer's existing field-building sites:
1. `refreshShFromSupabase()`'s read-back (`index.html:6306`-adjacent, `!= null` guard).
2. `saveShp()`'s create/update row builder (`index.html:13358`-adjacent).
3. `migrateShToSupabase()`'s insert loop (`index.html:7466`-adjacent).
4. `autoCreateShipmentFromInvoice()`'s own separate `shRow` object (`index.html:8946-8952`) — must read `dg: newShp.dg, origin_port: newShp.originPort || null, dest_port: newShp.destPort || null, linked_inv_ids: newShp.linkedInvIds, linked_inv_snapshots: newShp.linkedInvSnapshots`, matching the snake_case convention `refreshShFromSupabase()` already expects.

### REQ-SHIP-002g — `AI_SYSTEM_PROMPT` and `docs/user-guide.md` updated
Per this repo's own mandatory-on-every-version rule: describe the new inheritance/drift behavior. **AC-15** requires a substring-presence test against `AI_SYSTEM_PROMPT`. This is genuinely new test coverage for this codebase — a grep of `tests/run.js` for `AI_SYSTEM_PROMPT` returns zero matches; no such automated check exists today to "reuse."

### REQ-SHIP-002h — New shared `invHasDG(inv)` helper, replacing TWO divergent inline copies (disclosed, not zero-behavior-change)
```js
function invHasDG(inv) {
  return (inv.lineItems || []).some(function(li) {
    var cat = DB.li.find(function(x){ return x.id === li.lid; });
    return (cat && cat.dg) || li.dg;
  });
}
```
Adopts `runLoadCalc()`'s existing, more-complete check (`index.html:13446-13449`). `openLoadCalc()` is updated to call this shared helper too — a disclosed, intentional behavior change at that one call site. `runLoadCalc()`'s own call site produces no different output.

---

## 3. Acceptance criteria

- **AC-1:** `autoCreateShipmentFromInvoice(inv)` on an invoice whose line items include a DG-flagged catalogue item (or a line with `li.dg: true` directly) creates a Shipment with `dg: true` and a seeded Dangerous Goods Declaration trade-doc line.
- **AC-2:** Same, for an invoice with `pol`/`pod` set — `originPort`/`destPort` match, not blank.
- **AC-2b:** With Cloud Data configured, the Shipment visible in `DB.sh` immediately after `autoCreateShipmentFromInvoice()` returns still has the correct inherited `dg`/`originPort`/`destPort` — not reverted by the `shRow` round-trip.
- **AC-3:** `saveShp()` adding a second, DG-flagged invoice number to an already-non-DG, unchecked-checkbox Shipment flips `shp.dg` to `true`.
- **AC-4:** `saveShp()` removing the only DG invoice (checkbox also unchecked) flips `shp.dg` back to `false`.
- **AC-4b:** `saveShp()` removing the only DG invoice while the operator has, in the same save, manually checked `shf-dg` leaves `shp.dg` as `true`.
- **AC-5:** `saveShp()` never overwrites an already-non-blank `originPort`/`destPort`.
- **AC-5b:** When the first newly-linked invoice has a blank `pol` but a second has a non-blank `pol`, `originPort` fills from the second, not left blank.
- **AC-6:** `renderShpSourceDriftWarn()` — banner naming invoice/field on drift; nothing when unchanged; distinct "no longer exists" message when deleted; one line per affected invoice for multiple drifts.
- **AC-7:** `backfillShLinkedInvIds()`, called again after a previously-unresolved invoice is created, resolves it on the second call.
- **AC-8:** New Supabase columns round-trip correctly — omitted, not nulled, locally when the column is `null`.
- **AC-9:** `invHasDG(inv)` returns `true` for `li.dg: true` with no/non-DG catalogue match; `openLoadCalc()`'s badge now agrees.
- **AC-10:** `saveShp()`'s resolve-on-save path, given `linkedInvs = [unresolvableNumber, resolvableNumber]` (unresolved listed first), produces `linkedInvIds` of length **1** and `linkedInvSnapshots` of length **1** — proving compaction over the unresolved-before-resolved ordering specifically.
- **AC-11 through AC-14:** The four pre-existing DG-toggle tests (`tests/run.js:14131,14144,14156,14169`) pass unmodified.
- **AC-15:** Substring-presence test against `AI_SYSTEM_PROMPT` confirming it describes the new behavior.
- **AC-16 (corrected — round-3 finding):** `editShp()` on a Shipment whose `dg` is `true` purely from a currently-linked invoice (operator never checked the box) renders `shf-dg` checked and disabled with the tooltip. **Then**, with the modal still open, removing that invoice from `shf-invs` (triggering `oninput`) re-enables the checkbox **AND resets `.checked` to `false`** — not just `disabled` to `false`. **Then**, saving at that point (with the checkbox never touched by the operator) produces `shp.dg === false`, not `true` — directly closing the stuck-true failure scenario round 3 found, by exercising the full disable→live-edit→re-enable→save sequence in one test, not just the disable half.
- **AC-16b (new — closes round-3 advisory 2):** `openShp()` followed immediately by typing a DG-flagged invoice number into `shf-invs` (no save yet) disables and checks `shf-dg` live, proving the create path is covered by the same live-sync wiring as the edit path, not left to inference.

## 4. Explicitly out of scope for v4

- No picker/dropdown UI for linking invoices.
- No FK database constraint on the array columns.
- No deduplication of repeated identical invoice numbers within one `linkedInvs`.
- No change to `FIELD_MAPS.sh` / Google Sheets sync for the two new fields.
- No change to the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification; no warehousing concept (REQ-SHIP-003/004).
- No retroactive correction of a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute.

## 5. Open questions for independent review

None outstanding.

## 8. Self-review log (v4, post-round-3)

- Re-verified round 3's one new blocking finding by hand-tracing the exact failure sequence it described (disable→remove invoice→re-enable→save with checkbox untouched) against v3's own specified mechanism — confirmed v3 genuinely never specified a `.checked` reset, only a `.disabled` toggle, so the stale-`true` outcome was real, not a misreading.
- Checked this codebase for an existing precedent of "disable this field and also keep its value in sync" before inventing a new mechanism from scratch — found `shf-docs`/`renderShpDocsPanel()` (`index.html:8888-8893`) already does exactly this, and modeled `recomputeShpDgLiveState()` on it directly rather than designing something novel.
- Verified, by grepping the whole Shipment modal's markup (`index.html:2567-2616`), that no `oninput`/`onchange` exists anywhere on it today — confirming v3's "reuse an existing hook" claim was false and that this REQ's wiring is genuinely new, not a refactor of something already there.
- Considered whether `_shpDgInvoiceDriven` needs any explicit initialization logic beyond "call `recomputeShpDgLiveState()` once from `editShp()`/`openShp()`" — concluded no, since the function's own if/else already derives the flag correctly from whatever `shf-invs` currently resolves to, the first time it's called for a given modal-open session.
- Did not re-litigate round 1 or round 2's own findings — round 3 independently re-confirmed round 2's blocking finding and 3 of 4 advisories RESOLVED, and this v4 revision touches only the 4th (checkbox UX mechanism) plus its own two new advisory items.

## 9. Independent review round 1 — verdict FAIL (unchanged from v2/v3, reproduced for history)

5 blocking findings (byte-identical DG-check false claim; missed 4th Cloud Data write site; DG-recompute breaking 4 existing tests; backfill device-marker mismatch; missing ACs) — all fixed in v2, re-confirmed RESOLVED by round 2. 5 advisory findings — all fixed in v2.

## 9b. Independent review round 2 (confirmatory) — verdict FAIL (unchanged from v3, reproduced for history)

Round 1's 5 blocking findings independently re-confirmed RESOLVED. 1 new blocking finding (`linkedInvIds` positional-parallelism/sparse-omission contradiction) — fixed in v3 via compaction-without-positional-correspondence. 4 new advisory findings (false AI_SYSTEM_PROMPT precedent; checkbox UX; missing `invHasDGAcrossCurrentlyLinkedInvoices` pseudocode; unspecified port fallback) — all addressed in v3.

## 9c. Independent review round 3 (second confirmatory) — verdict FAIL, 1 new blocking + 2 new advisory, personally re-verified and fixed

Round 2's blocking finding independently re-confirmed RESOLVED (compaction algorithm hand-traced against AC-10, matches). 3 of round 2's 4 advisory findings independently re-confirmed RESOLVED (false precedent correction, pseudocode, port fallback). The 4th (checkbox UX) was found **PARTIALLY RESOLVED**:

**New blocking finding:** v3's disabled-checkbox mechanism specified the disable/enable toggle but never specified resetting `.checked` back to `false` on the transition out of invoice-driven state — a literal implementation leaves `shp.dg` stuck `true` after the operator removes the DG-driving invoice and saves without separately touching the checkbox, directly contradicting the feature's own tooltip text and no AC exercised this sequence to catch it. **Fixed:** `recomputeShpDgLiveState()` now explicitly resets `.checked` on exactly this transition, modeled directly on the pre-existing `shf-docs` disable-and-sync precedent (`index.html:8888-8893`) found during the fix's own research rather than invented from scratch; AC-16 rewritten to exercise the full disable→live-edit→re-enable→save sequence.

**New advisory findings, also fixed:**
1. v3 claimed the live-recompute hook could reuse "the same `oninput` that already drives other live recalculation in this modal" — false; grepping the whole modal's markup found zero existing `oninput`/`onchange` attributes anywhere on it. **Fixed:** the `oninput` on `shf-invs` is now explicitly disclosed as new wiring, with its exact attachment point named.
2. v3's "live as `shf-invs` is edited" language only explicitly named `editShp()`'s open-time computation, leaving create-path (`openShp()`) coverage to inference. **Fixed:** `openShp()` now explicitly also calls `recomputeShpDgLiveState()`; new AC-16b tests the create path directly.
