# REQ-SHIP-002 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Status:** v5 — revises v4 after independent requirements-gate review round 4 (third confirmatory): **FAIL**, 1 new blocking finding + 1 new advisory finding, both personally re-verified against live code before being accepted (§9d). Round 3's blocking finding and both its advisories were independently re-confirmed RESOLVED for their own original scenarios by round 4 — but round 4 found v4's fix itself introduced a new, different regression in an adjacent case it never tested. Fixed below. Not yet resubmitted.
**Type:** Entity-relationship rework. Extends the existing Shipment entity (`DB.sh`) and its Cloud Data table with two new fields (`linkedInvIds[]`, `linkedInvSnapshots[]`); extends `autoCreateShipmentFromInvoice()`, `saveShp()`, `editShp()`, `openShp()`, and adds a new `renderShpSourceDriftWarn()` mirroring the existing Quote/PO pattern, plus a new `recomputeShpDgLiveState()`/`shpDgManualToggle()` pair for the live checkbox behavior. One new migration file. No new external dependency.

---

## 0. How this REQ came to be scoped this way

Operator asked, after a user-reported Quote pricing bug led to an unrelated question about the Shipments tab: *"what is the relationship to the invoices that are linked to the shipment record — is any data inherited from the invoice or line item level?"* Direct code read found the answer was "almost none" — `linkedInvs` is a bare array of invoice-number strings, unvalidated, never dereferenced against `DB.inv`, and DG status is hardcoded `false` at auto-creation regardless of the source invoice's own DG-flagged lines. Operator's verdict, verbatim: *"This is a poor design... considering we want a robust system that runs on the dependence of entities and their relationships... to keep a way of storytelling the lifecycle of an order which also helps with automation of workflows."* Operator confirmed this as priority #1 of three (ahead of a container-profile rework and a warehousing-cost concept, both separately scoped), and answered three scoping questions up front (§1.2 Decisions 1–3) rather than leaving them for a reviewer to catch.

**Explicitly not a historical defect.** `supabase/migrations/0007_shipments.sql`'s own comment on `linked_invs` states this was a *deliberate* scoping decision at the time (`REQ-CLOUD-007 §1.1b`). This REQ is a deliberate, explicit reversal of that scoping call, not a bug fix.

---

## 1. Business context

### 1.1 What exists today (check-first)

- `DB.sh.linkedInvs` (`index.html:13304`, `saveShp()`) — a plain array of invoice-number strings. No lookup against `DB.inv` anywhere.
- `DB.sh.autoCreatedFromInvIds` (`index.html:8940`) — real Invoice *ids*, used only as an idempotency check inside `autoCreateShipmentFromInvoice()`.
- `autoCreateShipmentFromInvoice(inv)` (`index.html:8923-8963`) hardcodes `dg: false` at `index.html:8938` and separately calls `shpSeedTradeDocs(false)` at `index.html:8935`. Origin/dest port also start blank — never pre-filled from `inv.pol`/`inv.pod` (confirmed format-compatible, `index.html:2577-2578` vs `index.html:1189-1190`).
- `autoCreateShipmentFromInvoice()` builds a SECOND, independent object for the Cloud Data branch — `shRow` at `index.html:8946-8952` — which hardcodes `dg: false, origin_port: null, dest_port: null`, and the function then calls `refreshShFromSupabase()` (`index.html:8956`) immediately after, overwriting the local record. The Cloud Data branch only runs once `st_sh_cloud_migration_ts` is already set (`index.html:8944`), and `refreshShFromSupabase()`'s own guard (`index.html:6299`) checks only that same marker — it does not skip re-fetching the just-inserted record.
- Two independent, currently-divergent inline DG-detection checks exist in the Load Calculator: `openLoadCalc()` (`index.html:13415-13418`, `cat && cat.dg` only) and `runLoadCalc()` (`index.html:13446-13449`, `(cat && cat.dg) || li.dg`). Not logically equivalent today.
- `renderPoSourceDriftWarn()` (`index.html:8969-9009`) is a single-source, single-boolean design. `renderShpSourceDriftWarn()` (REQ-SHIP-002d) must aggregate over potentially many `linkedInvSnapshots[]` entries.
- `backfillShLinkedInvs()` (`index.html:3160-3173`) and `migrateLinkedPOIds()` (`index.html:3149-3158`) have no device-level marker — purely condition-based, called together at `index.html:13152-13153` (`doImport`) and `index.html:15740-15741` (`initApp`).
- `linkedInvs` is explicitly not required to be 1:1.
- Four existing tests (`tests/run.js:14131,14144,14156,14169`) assert `shp.dg` is driven purely by the `shf-dg` checkbox when `linkedInvs` is empty, via `setupShpFormMinimal()`.
- **`editShp()` sets `shf-dg` purely from stored `dg`** (`G('shf-dg').checked=!!s.dg;`, `index.html:13289`), **`shf-invs` is set two lines later** (`G('shf-invs').value=(s.linkedInvs||[]).join(', ');`, `index.html:13291`) — this ordering detail matters directly for where the new live-recompute initialization call must land (§2, REQ-SHIP-002c): a call inserted right after line 13289 would run before `shf-invs` holds the opened record's real value, reading a stale DOM value left over from whatever modal session preceded it. **Round 4 found v4's own citation pointed at line 13289, not 13291, for exactly this reason.**
- **The existing `shf-docs` dropdown is the one real precedent in this codebase for "disable a field and keep its displayed value in sync with a computed value"** (`index.html:8888-8893`): `docsSelect.disabled = docs.length > 0; ...; if (docs.length > 0) docsSelect.value = s.docsStatus || 'Pending';`. **This precedent only syncs a value on *entering* the computed state — it has no symmetric "restore the pre-computed value on exit" case, because `docsStatus` has no independent, operator-set meaning distinct from the computed one once `tradeDocs` exists.** `shf-dg` is different: an operator's own independent DG confirmation is meaningful even while, before, or after a linked invoice separately asserts DG — "restore on exit" genuinely needs a remembered prior value, which this precedent doesn't model and which v4's first attempt got wrong (§9c, §9d).
- **`shf-invs` and `shf-dg` have no `oninput`/`onchange` attributes today** (confirmed by inspecting `index.html:2567-2616`, the whole Shipment form markup). Both this REQ's live-recompute hook on `shf-invs` and its new manual-tracking hook on `shf-dg` (§2, REQ-SHIP-002c) are genuinely new wiring.

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 — Multi-invoice conflicts: DG is OR'd across every linked invoice (additive to, never a replacement for, the operator's own manual checkbox); destination/origin port inherit from the first-linked invoice but a mismatch from a later-linked invoice is a warning, never a silent overwrite or a block.**
DG is a safety property — OR-ing across invoices is conservative by default and must only ever add DG risk, **never remove an operator's own independent confirmation of it, at any point in an editing session, regardless of what else happens to the linked-invoice list in between** (this last clause, round 4 found, is not automatically satisfied just by having *a* disable/enable mechanism — it requires the mechanism to actually distinguish "checked because of an invoice" from "checked because the operator said so," not just track whether an invoice is *currently* linked).

**Decision 2 — Post-link drift detection:** unchanged from v4 (§2, REQ-SHIP-002d).

**Decision 3 — Historical backfill:** unchanged from v4 (§2, REQ-SHIP-002e).

### 1.3 What this REQ deliberately does NOT do

- Does not turn `shf-invs` into a picker/dropdown widget.
- Does not add a database foreign-key constraint on the array columns.
- Does not change `originPort`/`destPort` for a Shipment that already has a non-blank value.
- Does not deduplicate a `linkedInvs` array containing the exact same invoice number more than once.
- Does not add the two new fields to `FIELD_MAPS.sh`.
- Does not touch the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification; no warehousing concept (REQ-SHIP-003/004, separately scoped).
- Does not retroactively correct a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute.
- Does not persist any new field to distinguish "DG confirmed manually" from "DG derived from an invoice" **across saves/reloads** — `shp.dg` remains the single merged boolean it is today (§2, REQ-SHIP-002c's save-time rule is unchanged from v4: `checked || invoiceDG`, still a full recomputation with no cross-save memory). The new `_shpDgManualValue` tracking (§2, REQ-SHIP-002c) is **session-scoped only** — it correctly distinguishes the two sources *within one continuous modal-open editing session*, which is all round 4's failure scenario and this REQ's own scope actually require; it does not and cannot reconstruct "was this manual or invoice-derived" from a value already saved in a prior session, since that information was never captured by the single `dg` boolean to begin with. A fully cross-session-correct version of this would need a new persisted field (e.g. `shp.dgManual`) and is explicitly out of scope here — logged as a natural candidate for a future REQ if the operator finds the session-scoped behavior insufficient in practice.

---

## 2. Requirements

### REQ-SHIP-002a — unchanged from v4
New Shipment schema fields `linkedInvIds[]`/`linkedInvSnapshots[]`, compact (not positionally-parallel to `linkedInvs`), self-identifying via `invId`.

### REQ-SHIP-002b — unchanged from v4
`autoCreateShipmentFromInvoice(inv)` inherits DG (via `invHasDG(inv)`) and port (`inv.pol`/`inv.pod`) on creation; sets `linkedInvIds`/`linkedInvSnapshots` alongside `linkedInvs`.

### REQ-SHIP-002c — `saveShp()`'s DG rule (unchanged), port-inheritance fallback (unchanged), and the `shf-dg` checkbox's live-sync behavior (revised again — round 4)

**DG rule at save time — unchanged from v4:**
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
This part of the design was never in question across rounds 3–4 — only the *live checkbox display* mechanism below was.

**Port inheritance fallback — unchanged from v4** (§1.3-equivalent text, AC-5b).

**`shf-dg` checkbox live-sync — corrected mechanism (round-4 finding; v4's version unconditionally reset `.checked` to `false` on every transition out of invoice-driven state, which is correct for round 3's scenario — pure invoice-driven DG, never manually touched — but wrong whenever an operator's own independent manual confirmation preceded or coexisted with the invoice-driven period: it silently discarded that confirmation too):**

Two new, explicitly disclosed module-level UI-state variables (session-scoped only, never part of `DB`, never persisted, reset by the functions below, never by `resetDB()` — same class of UI state as the existing `cRfqEditId` precedent):

```js
var _shpDgInvoiceDriven = false;  // is the checkbox CURRENTLY forced true/disabled by a linked invoice?
var _shpDgManualValue = false;    // the operator's own last INDEPENDENT (non-invoice-forced) checked value —
                                   // the thing that must survive an invoice being linked and then unlinked again

function shpDgManualToggle() {
  // Wired directly to shf-dg's own onchange. Because a disabled <input> never
  // receives user-driven click/change events (standard DOM behavior — disabling
  // an element makes it inert to interaction, confirmed, not assumed), this can
  // only ever fire while the box is enabled, i.e. NOT currently invoice-driven —
  // which is exactly the condition under which a change genuinely represents the
  // operator's own independent choice, never a forced value.
  _shpDgManualValue = G('shf-dg').checked;
}

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
    cb.checked = _shpDgManualValue;  // ALWAYS restores the operator's own last independent value —
                                      // never a hardcoded false — correct whether or not an invoice-driven
                                      // period happened in between
    _shpDgInvoiceDriven = false;
  }
}
```
**Why this fixes round 4's regression without reopening round 3's:** `_shpDgManualValue` is updated ONLY by a genuine, enabled-state operator click (`shpDgManualToggle()`), never by `recomputeShpDgLiveState()` itself — the two functions have strictly separate write responsibilities. Round 4's scenario (manual check → invoice linked → invoice unlinked) now correctly restores the manual `true`, because nothing ever overwrote `_shpDgManualValue` during the invoice-driven interval (the box was disabled throughout, so `shpDgManualToggle()` could not fire). Round 3's scenario (invoice-driven only, never manually touched) still correctly resets to `false` on exit, because `_shpDgManualValue` was correctly seeded to `false` at modal-open time for a record whose `dg` was itself invoice-derived (see initialization below) and nothing ever changed it.

**Initialization at modal-open (corrected citation — round-4 advisory):**
- `openShp()`: alongside its existing reset of `shf-invs`/`shf-dg` to blank/unchecked (`index.html:13265-13272`), explicitly reset `_shpDgManualValue = false; _shpDgInvoiceDriven = false;` then call `recomputeShpDgLiveState()` once — all a no-op in practice (blank `shf-invs`), but starts the session's state cleanly for the create path (AC-16b).
- `editShp()`: **after `index.html:13291`** (where `shf-invs` is actually populated — not after line 13289, which only sets `shf-dg`/`shf-docs` and precedes `shf-invs` being set; this is the exact citation round 4 found imprecise in v4), compute the record's own `openInvoiceDG` the same way (`shpCurrentLinkedInvoicesHaveDG()`, now that `shf-invs` correctly holds the opened record's real linked invoices), then: `_shpDgManualValue = s.dg && !openInvoiceDG;` (the stored `dg` is attributable to independent confirmation only if no currently-linked invoice explains it — if `dg` was true PARTLY OR WHOLLY because of an invoice, the safe default per Decision 1 is to treat the independent baseline as `false`, since this app has never separately recorded a cross-session-independent manual value, per §1.3) and `_shpDgInvoiceDriven = false;`, then call `recomputeShpDgLiveState()` once — which will correctly re-derive `_shpDgInvoiceDriven = true` and re-force `checked = true` if `openInvoiceDG` is itself true, reproducing AC-16's required initial state exactly.

**Wiring, explicitly new:**
- `oninput="recomputeShpDgLiveState()"` on the `shf-invs` input element (`index.html:2593`-adjacent).
- `onchange="shpDgManualToggle()"` on the `shf-dg` checkbox element (`index.html:2585`-adjacent, new — v4 had no handler on `shf-dg` itself at all, only on `shf-invs`, which is precisely why round 4's regression was possible: nothing was tracking genuine manual intent separately from the invoice-driven signal).

### REQ-SHIP-002d — unchanged from v4
`renderShpSourceDriftWarn(shp)`, adapted from `renderPoSourceDriftWarn()`, `invId`-keyed lookups, one line per affected invoice.

### REQ-SHIP-002e — unchanged from v4
`backfillShLinkedInvIds()`, self-healing, no device marker, wired at `index.html:13152-13153` and `index.html:15740-15741`.

### REQ-SHIP-002f — unchanged from v4
Two new nullable `jsonb` columns, all four Cloud Data touchpoints (including `autoCreateShipmentFromInvoice()`'s own `shRow`) extended.

### REQ-SHIP-002g — unchanged from v4
`AI_SYSTEM_PROMPT`/`docs/user-guide.md` updated; AC-15 is genuinely new test coverage, not a reuse of an existing pattern.

### REQ-SHIP-002h — unchanged from v4
New shared `invHasDG(inv)` helper, disclosed one-call-site behavior change at `openLoadCalc()`.

---

## 3. Acceptance criteria

- **AC-1 through AC-15:** unchanged from v4 (creation-time inheritance, Cloud Data round-trip, DG save-rule additivity, port fallback, drift-warning banner, backfill self-healing, Supabase omit-not-null, shared `invHasDG` behavior change, schema compaction, the four pre-existing DG-toggle tests, `AI_SYSTEM_PROMPT` coverage).
- **AC-16 (unchanged from v4 — round 3's own scenario, still required):** `editShp()` on a Shipment whose `dg` is `true` purely from a currently-linked invoice (operator never checked the box) renders `shf-dg` checked and disabled with the tooltip. Removing that invoice from `shf-invs` live re-enables the checkbox **and resets `.checked` to `false`**. Saving at that point (checkbox never touched) produces `shp.dg === false`.
- **AC-16b (unchanged from v4):** `openShp()` followed by typing a DG-flagged invoice number into `shf-invs` disables and checks `shf-dg` live, proving the create path is covered.
- **AC-16c (new — closes round-4's blocking finding directly):** `editShp()` on a Shipment with **no** linked invoices and `dg: false` — operator manually checks `shf-dg` (firing `shpDgManualToggle()`, setting `_shpDgManualValue = true`) — then types a DG-flagged invoice number into `shf-invs` (checkbox forced checked+disabled, no visible change since it was already checked) — then deletes that same invoice number again, still within the same open modal, before ever saving. Asserts the checkbox ends this sequence **re-enabled and still `checked === true`** — proving the operator's own independent confirmation survives a transient invoice-driven period, not just that the invoice-only case (AC-16) resets correctly. This is the exact adjacent scenario round 4 found v4 had never tested.

## 4. Explicitly out of scope for v5

Unchanged from v4, plus: no cross-session (save/reload-surviving) distinction between manually-confirmed and invoice-derived DG — session-scoped only (§1.3).

## 5. Open questions for independent review

None outstanding.

## 8. Self-review log (v5, post-round-4)

- Re-verified round 4's blocking finding by hand-tracing its exact adjacent scenario (manual check → invoice linked → invoice unlinked → save) against v4's literal pseudocode myself before accepting it — confirmed v4's unconditional `cb.checked = false` on exit-from-invoice-driven would indeed discard the manual confirmation, independent of the reviewing agent's own narrative.
- Re-verified round 4's advisory (the `editShp()` citation pointing at line 13289 instead of 13291) by reading both lines directly — confirmed line 13289 sets `shf-dg`/`shf-docs`, not `shf-invs`, and `shf-invs` is in fact set two lines later at 13291, exactly as the reviewing agent found.
- Chose a second, independent "manual value" tracking variable (`_shpDgManualValue`), written only by a genuine enabled-state `onchange` on `shf-dg` itself, over any alternative that tries to infer manual-vs-invoice-derived from `_shpDgInvoiceDriven` alone — concluded this is the only design that can actually distinguish the two sources, since a single boolean flag recording only "is an invoice currently DG" has no way to also remember "and was the box independently true before that became relevant."
- Explicitly scoped the fix to session-only correctness (§1.3) rather than attempting a cross-session-correct version requiring a new persisted field — judged that round 4's own failure scenario, and the operator's own original ask, do not require surviving a save/reload, and that silently expanding scope to a new persisted field mid-fix would itself be exactly the kind of under-disclosed scope creep this review series has been catching in smaller forms throughout.
- Did not re-litigate rounds 1–3's own findings — round 4 independently re-confirmed round 3's blocking finding and both its advisories RESOLVED for their own scenarios, and this v5 revision touches only the mechanism round 4 found incomplete.

## 9. Independent review round 1 — verdict FAIL (reproduced for history)
5 blocking + 5 advisory findings, all fixed in v2, re-confirmed RESOLVED by round 2.

## 9b. Independent review round 2 (confirmatory) — verdict FAIL (reproduced for history)
1 new blocking (`linkedInvIds` positional/sparse contradiction) + 4 new advisory, all fixed in v3, re-confirmed RESOLVED by round 3 (except checkbox UX, partial).

## 9c. Independent review round 3 (second confirmatory) — verdict FAIL (reproduced for history)
1 new blocking (`.checked` never reset on exit from invoice-driven state) + 2 new advisory (false oninput-reuse claim; create-path left to inference), all fixed in v4. Round 4 re-confirmed these RESOLVED for their own original scenarios.

## 9d. Independent review round 4 (third confirmatory) — verdict FAIL, 1 new blocking + 1 new advisory, personally re-verified and fixed

Round 3's blocking finding and both its advisories independently re-confirmed RESOLVED for their own exact scenarios by this round's own hand-trace.

**New blocking finding:** v4's `recomputeShpDgLiveState()` reset `.checked` to a hardcoded `false` on every exit from invoice-driven state, with no memory of whether the operator had independently checked the box before or during the invoice-driven period — directly violating Decision 1's "never remove an operator's own independent confirmation" invariant whenever independent confirmation preceded or coexisted with a later invoice-driven interval that then ends. No AC in v4 exercised this adjacent sequence (AC-16 only tested the pure-invoice-driven case). **Fixed:** split tracking into two variables — `_shpDgInvoiceDriven` (is the box currently forced) and `_shpDgManualValue` (the operator's own last independent value, written only by a new `shpDgManualToggle()` handler that can only fire while the box is genuinely enabled) — so exiting invoice-driven state restores the real prior independent value instead of a hardcoded `false`. New AC-16c tests this exact sequence directly.

**New advisory finding, also fixed:** v4's citation for `editShp()`'s initialization call (`index.html:13289`-adjacent) pointed at the line that sets `shf-dg`/`shf-docs`, not the line that sets `shf-invs` (two lines later, `index.html:13291`) — a literal implementation at the cited point would compute the live-sync state before `shf-invs` held the opened record's real value. **Fixed:** citation corrected to `index.html:13291` (after `shf-invs` is actually set), and the initialization logic itself (seeding `_shpDgManualValue` correctly from `s.dg && !openInvoiceDG`) is now spelled out explicitly rather than left implicit.
