# REQ-SHIP-002 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Status:** v3 — revises v2 after independent requirements-gate review round 2 (confirmatory): **FAIL**, 1 new blocking finding + 4 advisory findings, all personally re-verified against live code before being accepted (§9b). Round 1's 5 blocking findings were independently confirmed RESOLVED by round 2's own re-check (§9b) — not relitigated here. The 1 new blocking finding and all 4 new advisory findings are fixed below. Not yet resubmitted for a second confirmatory round.
**Type:** Entity-relationship rework. Extends the existing Shipment entity (`DB.sh`) and its Cloud Data table with two new fields (`linkedInvIds[]`, `linkedInvSnapshots[]`); extends `autoCreateShipmentFromInvoice()`, `saveShp()`, `editShp()`, and adds a new `renderShpSourceDriftWarn()` mirroring the existing Quote/PO pattern. One new migration file. No new external dependency.

---

## 0. How this REQ came to be scoped this way

Operator asked, after a user-reported Quote pricing bug led to an unrelated question about the Shipments tab: *"what is the relationship to the invoices that are linked to the shipment record — is any data inherited from the invoice or line item level?"* Direct code read found the answer was "almost none" — `linkedInvs` is a bare array of invoice-number strings, unvalidated, never dereferenced against `DB.inv`, and DG status is hardcoded `false` at auto-creation regardless of the source invoice's own DG-flagged lines. Operator's verdict, verbatim: *"This is a poor design... considering we want a robust system that runs on the dependence of entities and their relationships... to keep a way of storytelling the lifecycle of an order which also helps with automation of workflows."* Operator confirmed this as priority #1 of three (ahead of a container-profile rework and a warehousing-cost concept, both separately scoped), and answered three scoping questions up front (§1.2 Decisions 1–3) rather than leaving them for a reviewer to catch.

**Explicitly not a historical defect.** `supabase/migrations/0007_shipments.sql`'s own comment on `linked_invs` states this was a *deliberate* scoping decision at the time (`REQ-CLOUD-007 §1.1b`): "NOT foreign-key-constrained and never will be... Invoice-number matching against this field happens client-side only, never as a database constraint." That decision was correct for what REQ-CLOUD-007 was scoped to do (migrate Shipment to Cloud Data with zero new cross-entity complexity). This REQ is a deliberate, explicit reversal of that scoping call, made now because the operator's actual workflow-automation goal — order-lifecycle storytelling driven by real entity relationships — needs it, not because the original call was a mistake.

---

## 1. Business context

### 1.1 What exists today (check-first)

- `DB.sh.linkedInvs` (`index.html:13304`, `saveShp()`) — a plain array of invoice-number strings, parsed from one free-text comma-separated form field (`shf-invs`). No lookup against `DB.inv` anywhere; a typo or a renamed/deleted invoice number silently breaks the link with no warning.
- `DB.sh.autoCreatedFromInvIds` (`index.html:8940`) — real Invoice *ids*, but used **only** as an idempotency check inside `autoCreateShipmentFromInvoice()` (so the same Paid invoice never spawns a second Shipment). Never read anywhere else, never extended by a manual link via `saveShp()`.
- `autoCreateShipmentFromInvoice(inv)` (`index.html:8923-8963`) hardcodes `dg: false` at `index.html:8938` and separately calls `shpSeedTradeDocs(false)` at `index.html:8935` — DG status never flows from the source invoice, even though the invoice's own line items carry DG via the Line Item catalogue's `dg` flag. Origin/dest port (`originPort`/`destPort`) also start blank, never pre-filled from the invoice's own `pol`/`pod` fields (confirmed format-compatible — both sides use the identical free-text-with-`dl-ports`-datalist-suggestion input, `index.html:2577-2578` vs `index.html:1189-1190` — so this is a straight string copy, not a format reconciliation problem).
- **`autoCreateShipmentFromInvoice()` builds a SECOND, independent object for the Cloud Data branch — `shRow` at `index.html:8946-8952` — not just the local `newShp` object.** `shRow` hardcodes `dg: false, origin_port: null, dest_port: null` on its own, separately from `newShp`'s own fields, and the function then calls `refreshShFromSupabase()` (`index.html:8956`) immediately after inserting it, which overwrites the local `DB.sh` entry from whatever was actually written to Supabase. The Cloud Data branch is only entered when `st_sh_cloud_migration_ts` is already set (`index.html:8944`), and `refreshShFromSupabase()`'s own early-return guard only checks that same marker (`index.html:6299`) — it does **not** skip re-fetching the just-inserted record, so the overwrite is unconditional once inside this branch. **Any fix to `newShp`'s inheritance alone would be silently destroyed on first load for a Cloud-Data-configured deployment** unless `shRow` is fixed at the same time. This is the fourth of four Cloud Data touchpoints this REQ must change (§2, REQ-SHIP-002f).
- There are two independent, currently-divergent inline DG-detection checks in the Load Calculator, in two different functions, not one function as might first appear: `openLoadCalc()` (`index.html:13415-13418`, checks `cat && cat.dg` only — catalogue flag alone) and `runLoadCalc()` (`index.html:13446-13449`, checks `(cat && cat.dg) || li.dg` — catalogue flag OR the invoice line's own `dg` field). **These two are not logically equivalent today** — an invoice line with `li.dg: true` but no catalogue match (or a catalogue match that isn't itself DG-flagged) shows no DG badge in `openLoadCalc()`'s list but would correctly count as DG in `runLoadCalc()`'s calculation. Unifying them into one shared helper is therefore not a pure, zero-behavior-change refactor — it is a small, disclosed behavior change to `openLoadCalc()` specifically (§1.3, §2 REQ-SHIP-002h).
- The existing Quote↔Order-Request and PO↔Invoice "source changed since this was created" pattern (`renderQteSourceDriftWarn()`, `renderPoSourceDriftWarn()` at `index.html:8969-9009`) is the established precedent this REQ reuses, but **the PO precedent is a single-source, single-boolean design — not a loop over multiple snapshots.** `renderPoSourceDriftWarn(po)` compares exactly one `po.invId` against one live invoice and sets one `stale` flag with one generic banner message; it has no array of sources to iterate and no per-field detail in its output. `renderShpSourceDriftWarn()` must aggregate over potentially many `linkedInvSnapshots[]` entries and should name which invoice/field actually drifted — a real, necessary structural extension beyond the PO precedent's shape, not a literal copy of it (§2, REQ-SHIP-002d).
- `backfillShLinkedInvs()` (`index.html:3160-3173`) and `migrateLinkedPOIds()` (`index.html:3149-3158`) — the two existing "resolve/repair a field already in local storage" precedents this REQ's own backfill is modeled on — have **no device-level timestamp marker of any kind.** Each is idempotent purely via a per-record condition (`if (typeof s.linkedInvs === 'string')`, `if (q.linkedPOId && !q.linkedPOIds)`) and is simply called again, safely, every time its two call sites run: `index.html:13152-13153` (inside `doImport`) and `index.html:15740-15741` (inside `initApp`), always together, always at exactly those two sites.
- `linkedInvs` is explicitly not required to be 1:1 (one Shipment can consolidate multiple Invoices into one container/BL) — confirmed by `autoCreateShipmentFromInvoice()`'s own idempotency check treating `linkedInvs` as an appendable list, and by the operator's own real workflow (container consolidation across orders).
- **Four existing tests assert that `shp.dg` is driven purely by the `shf-dg` checkbox when `linkedInvs` is empty** (`tests/run.js:14131,14144,14156,14169`, all using `setupShpFormMinimal()` which blanks `shf-invs`, all toggling `shf-dg` directly and asserting on the resulting trade-doc-line add/remove logic at `index.html:13336-13343`). Any DG-recomputation rule this REQ introduces must preserve this exactly.
- **`editShp()` sets the `shf-dg` checkbox purely from the stored `dg` value** (`G('shf-dg').checked=!!s.dg;`, `index.html:13289`), with no awareness of *why* `dg` became `true` — a manual confirmation and an invoice-inherited value look identical to the form. This matters for REQ-SHIP-002c's UI affordance (below): without it, an operator could uncheck a box that visibly does nothing on save (because a still-linked DG invoice re-asserts it), with no explanation why.
- `qt.originCharges` (`index.html:4358, 6263, 6502`) — the field v1/v2 cited as precedent for "omit rather than null a key" — is a single optional **scalar** property on an object, not an array element. "Omit vs. null" has no positional consequence for a scalar key; it does for an array meant to run index-parallel to another array. This distinction is the root of round-2's one new blocking finding (§9b finding 1) and is resolved in REQ-SHIP-002a below by not claiming positional parallelism in the first place.

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 — Multi-invoice conflicts: DG is OR'd across every linked invoice (additive to, never a replacement for, the operator's own manual checkbox); destination/origin port inherit from the first-linked invoice but a mismatch from a later-linked invoice is a warning, never a silent overwrite or a block.**
Rationale (operator-selected): DG is a safety property — treating a consolidated Shipment as DG if *any* linked invoice is DG is the only conservative-by-default choice, and it must only ever add DG risk, never remove an operator's own independent confirmation of it. Destination is informational, not safety-critical, so a soft warning (not a hard block on linking) keeps the workflow unobstructed while still surfacing the real discrepancy for the operator to resolve.
**Disclosed extension beyond the literal question asked:** the operator's own answer to this question named "destination port" specifically; this REQ applies the identical inherit-once/warn-on-drift rule to *origin* port too, by direct analogy — there is no reason origin port should behave differently, but this is this REQ's own extension, not something the operator was separately asked about.

**Decision 2 — Post-link drift detection: yes, mirror the Quote/PO "snapshot at link time, compare to live on render, warn, never auto-overwrite" *contract* — adapted, not copied verbatim, into a design that handles multiple linked sources (§1.1 above).**
A `linkedInvSnapshots[]` array captures `{invId, dg, pol, pod}` for each linked invoice at the moment it's linked (auto-create, or added via `saveShp()`). On every Shipment render/open, each snapshot is compared against the live Invoice; a mismatch on `dg`, `pol`, or `pod` shows one line per differing invoice/field in the banner. The Shipment's own `dg`/`originPort`/`destPort` fields are never silently rewritten by this check.

**Decision 3 — Historical backfill: yes, existing Shipments get a self-healing resolution of `linkedInvs` (numbers) against `DB.inv` by `num` — re-run safely every time, not a one-time device-marked event.**
`backfillShLinkedInvIds()`, wired into the identical two call sites as `migrateLinkedPOIds()`/`backfillShLinkedInvs()` (`index.html:13152-13153` and `index.html:15740-15741`, always alongside them, never alone), resolves any `linkedInvs` entry not yet resolved, every time it runs — not gated behind a one-time marker. **Logs** (does not silently drop) any entry that still doesn't resolve on a given run. Non-resolving entries stay in `linkedInvs` exactly as-is.

### 1.3 What this REQ deliberately does NOT do

- Does not turn `shf-invs` into a picker/dropdown widget. The operator still types comma-separated invoice numbers in the same free-text field — `saveShp()` resolves each against `DB.inv` by `num` *after* the existing parse, same UX, new internal id layer underneath.
- Does not add a database foreign-key constraint on the array columns (Postgres can't FK-constrain individual jsonb-array elements without a join table; resolution/validation stays client-side, same posture `0007_shipments.sql` already documents for `linked_invs`).
- Does not change `originPort`/`destPort` for a Shipment that already has a non-blank value when a new invoice is linked to it — inheritance only pre-fills a **blank** field.
- Does not deduplicate a `linkedInvs` array that already contains the exact same invoice number more than once — two identical entries resolve to the same `invId`; `linkedInvIds` would carry that id twice and `linkedInvSnapshots` the same snapshot twice, and the drift banner would list that invoice's drift twice. Harmless, deliberately not special-cased.
- Does not add the two new fields to `FIELD_MAPS.sh` — the same, already-existing limitation `tradeDocs`/`autoCreatedFromInvIds` have today (neither is in `FIELD_MAPS.sh` either, confirmed at `index.html:4913`): these fields do not sync via the Google Sheets integration.
- Does not touch the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification (REQ-SHIP-002h), and does not touch any warehousing concept. Both separately scoped, REQ-SHIP-003/004, in that priority order per the operator's own instruction.
- Does not retroactively correct a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute — the backfill only populates the new `linkedInvIds`/`linkedInvSnapshots` fields, never touches `dg`/`originPort`/`destPort` on an existing record.
- **Does not require remembering the previous save's linked-invoice set.** REQ-SHIP-002c's DG rule is a full recomputation from the current form state every save (checkbox OR current-linked-invoices'-DG-status) — it needs no "what changed since last save" diffing logic at all, which is why AC-4b (operator-confirms-DG-while-removing-the-DG-invoice-in-the-same-save) is satisfiable with no hidden state.

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
**Corrected shape (round-2 finding 1):** v1/v2 claimed both "same index, same order [as `linkedInvs`]" and "sparse by omission" for `linkedInvIds` — these are mutually incompatible for any list where an unresolved entry precedes a resolved one (a `.filter()`-style omission shifts every later index left, which contradicts positional correspondence; true positional correspondence requires sparse-array holes, which was never specified and is a bad fit for ordinary array iteration anyway). **This version drops positional correspondence entirely.** `linkedInvIds` is simply the compacted list of ids that successfully resolved — built with an ordinary `.map()`+`.filter(Boolean)` or equivalent, never a sparse/hole-preserving construction. Nothing downstream needs index correspondence between `linkedInvs`/`linkedInvIds`/`linkedInvSnapshots`, because `linkedInvSnapshots` entries are self-identifying via their own `invId` field (`renderShpSourceDriftWarn()`, REQ-SHIP-002d, looks up by `invId`, never by shared array index). `qt.originCharges`'s "omit don't null" precedent is cited only for the general principle (don't fabricate a placeholder for "not applicable"), not for any claim about array positions — that mismatch in the prior version is exactly what made the claim inconsistent, since `originCharges` is a scalar with no positional meaning at all.

### REQ-SHIP-002b — `autoCreateShipmentFromInvoice(inv)` inherits DG and port on creation
Revise `index.html:8936-8942` (`newShp`): `dg` computed via `invHasDG(inv)` (REQ-SHIP-002h). `originPort`/`destPort` pre-filled from `inv.pol`/`inv.pod` (blank if the invoice itself has neither set — never fabricated). `linkedInvIds: [inv.id]` and `linkedInvSnapshots: [{invId: inv.id, dg, pol: inv.pol||'', pod: inv.pod||''}]` set alongside the existing `linkedInvs: [inv.num]`.

### REQ-SHIP-002c — `saveShp()`'s DG rule, port-inheritance fallback, and the `shf-dg` checkbox's new disabled-when-invoice-driven state
**DG rule, construction algorithm spelled out explicitly (closes round-2's "no construction algorithm" advisory gap):**
```js
// Pseudocode — the exact rebuild-from-scratch-every-save algorithm REQ-SHIP-002c specifies:
var resolved = linkedInvs.map(function(num){ return DB.inv.find(function(i){ return i.num === num; }); })
                         .filter(Boolean);                     // compaction — see REQ-SHIP-002a
var linkedInvIds = resolved.map(function(inv){ return inv.id; });
var linkedInvSnapshots = resolved.map(function(inv){
  return { invId: inv.id, dg: invHasDG(inv), pol: inv.pol || '', pod: inv.pod || '' };
});
var invHasDGAcrossCurrentlyLinkedInvoices = linkedInvSnapshots.some(function(snap){ return snap.dg; });
shp.dg = G('shf-dg').checked || invHasDGAcrossCurrentlyLinkedInvoices;
```
This operates over **this save's freshly-parsed `linkedInvs`** (the `shf-invs` field's current value, parsed the same way `saveShp()` already parses it today), never over any previously-stored set — confirmed by round 2 as the reason AC-4b needs no hidden "what was linked last time" state at all (§1.3).
- Zero linked invoices (today's only case, and all four existing DG-toggle tests' fixture): `invHasDGAcrossCurrentlyLinkedInvoices` is `false` (OR over the empty set), so `shp.dg` reduces to exactly `G('shf-dg').checked` — **byte-identical to current behavior**, satisfying AC-11/AC-12/AC-13/AC-14.
- Adding a DG-flagged invoice while the checkbox is unchecked: `shp.dg` becomes `true` (AC-3).
- Removing the only DG-flagged invoice while the checkbox is also unchecked: `shp.dg` becomes `false` (AC-4).
- Removing the only DG-flagged invoice while the operator has, in the same save, manually checked the box: `shp.dg` stays `true` (AC-4b).

**Port inheritance fallback (closes a gap carried unresolved from v1/v2, flagged again at round 2):** "the first newly-resolving linked invoice's `pol`/`pod`" means: iterate the newly-resolved invoices (this save's additions to `linkedInvIds` versus the pre-save record) in `linkedInvs` order, and use the first one whose `pol`/`pod` is non-blank. If none of the newly-linked invoices has a non-blank `pol`/`pod`, `originPort`/`destPort` are left exactly as they were (still blank if they were blank) — this REQ never blocks on or retries later; a subsequent `saveShp()` with a different/updated invoice can still fill it in later, since the "only if currently blank" guard (§1.3) means the opportunity isn't lost, just deferred.

**`shf-dg` checkbox UI (new in v3, closes round-2 advisory 2 — "unchecking silently does nothing" confusion):** when `invHasDGAcrossCurrentlyLinkedInvoices` is `true` for the Shipment currently open in the edit modal, `shf-dg` is rendered checked **and disabled**, with a tooltip/title: "DG is set by a linked invoice — remove it from Linked Invoices to clear." This is computed and applied both when `editShp()` opens the modal (so the operator sees the disabled state immediately, before touching anything) and live as `shf-invs` is edited (recomputed on the same `oninput` that already drives other live recalculation in this modal), so adding or removing a DG invoice while the modal is open immediately enables/disables the checkbox accordingly, never only after a full save/reopen cycle.

### REQ-SHIP-002d — `renderShpSourceDriftWarn(shp)` — new function, new banner on the Edit Shipment modal
Adapted from (not a literal copy of) `renderPoSourceDriftWarn()`'s snapshot-vs-live contract (`index.html:8969-9009`): for each entry in `linkedInvSnapshots` (looked up by its own `invId`, per REQ-SHIP-002a — never by shared index with any other array), look up the live Invoice by `invId`; if not found, one line naming that invoice ("Linked Invoice <num> no longer exists"); if found, compare `dg`/`pol`/`pod` against the snapshot and list every differing field, naming the invoice number — unlike the PO precedent's single boolean/single generic message, this banner must show more than one line when more than one invoice has drifted. Wired into `editShp()` the same way `renderPoSourceDriftWarn()` is wired into `editPO()` — called on open, with a dedicated `<div id="shp-drift-warn">` placeholder on the modal.

### REQ-SHIP-002e — `backfillShLinkedInvIds()` — self-healing resolution, wired at the same two call sites as its precedents, no device marker
No localStorage marker of any kind. Iterates `DB.sh`; for each record, rebuilds `linkedInvIds`/`linkedInvSnapshots` using the exact same compaction algorithm as REQ-SHIP-002c (a record whose `linkedInvs` hasn't changed and already fully resolved produces an identical result, so re-running this on every app load is cheap and safe, not merely tolerated). Wired into `index.html:13152-13153` and `index.html:15740-15741`, immediately alongside the existing `migrateLinkedPOIds()`/`backfillShLinkedInvs()` calls at both sites. Logs (via `console.warn`) any entry that still doesn't resolve, naming the Shipment `ref` and the unresolved number.

### REQ-SHIP-002f — Cloud Data: two new nullable `jsonb` columns, all four existing touchpoints extended
New migration `supabase/migrations/0010_shipments_linked_inv_ids.sql`:
```sql
alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
```
Additive only, mirrors `0008_shipments_trade_docs.sql`'s own precedent exactly. Wire into all four of the Shipment Cloud Data layer's existing field-building sites:
1. `refreshShFromSupabase()`'s read-back (`index.html:6306`-adjacent, `!= null` guard per this codebase's own standing "omit the key, don't null it" rule).
2. `saveShp()`'s create/update row builder (`index.html:13358`-adjacent).
3. `migrateShToSupabase()`'s insert loop (`index.html:7466`-adjacent).
4. **`autoCreateShipmentFromInvoice()`'s own separate `shRow` object (`index.html:8946-8952`)** — must read `dg: newShp.dg, origin_port: newShp.originPort || null, dest_port: newShp.destPort || null, linked_inv_ids: newShp.linkedInvIds, linked_inv_snapshots: newShp.linkedInvSnapshots` rather than the hardcoded `false`/`null`/`null` it has today, matching the exact snake_case column-naming convention `refreshShFromSupabase()` already expects for every other field (`row.dg`, `row.origin_port`, `row.dest_port`, confirmed at `index.html:6306`).

### REQ-SHIP-002g — `AI_SYSTEM_PROMPT` and `docs/user-guide.md` updated
Per this repo's own mandatory-on-every-version rule: the Shipments section of both needs to describe the new inheritance/drift behavior. **AC-15** requires a substring-presence test against the live `AI_SYSTEM_PROMPT` string content. **Correction (round-2 advisory 1): this is NOT an existing pattern in this test suite** — a search of `tests/run.js` for `AI_SYSTEM_PROMPT` returns zero matches; the v2.9.69 prompt-staleness fix cited as precedent was a manual prose correction caught at build-gate, never backed by an automated test. AC-15 is therefore a genuinely new kind of regression coverage for this codebase, not a reuse of an already-proven pattern — stated plainly rather than implying otherwise.

### REQ-SHIP-002h — New shared `invHasDG(inv)` helper, replacing TWO divergent inline copies (disclosed, not zero-behavior-change)
```js
function invHasDG(inv) {
  return (inv.lineItems || []).some(function(li) {
    var cat = DB.li.find(function(x){ return x.id === li.lid; });
    return (cat && cat.dg) || li.dg;
  });
}
```
Adopts `runLoadCalc()`'s existing, more-complete check (`index.html:13446-13449`) as the canonical rule — catalogue flag OR the invoice line's own `dg` field — rather than `openLoadCalc()`'s narrower one (`index.html:13415-13418`, catalogue flag only). `openLoadCalc()` is updated to call this shared helper too. **Disclosed, intentional behavior change at exactly one call site** (`openLoadCalc()`'s DG badge): an invoice whose line has `li.dg: true` directly but no DG-flagged catalogue match will now show the DG badge there, where it previously wouldn't. `runLoadCalc()`'s own call site changes to use the shared helper but produces no different output, since it already implements this exact logic inline.

---

## 3. Acceptance criteria

- **AC-1:** `autoCreateShipmentFromInvoice(inv)` on an invoice whose line items include a DG-flagged catalogue item (or a line with `li.dg: true` directly) creates a Shipment with `dg: true` and a seeded Dangerous Goods Declaration trade-doc line.
- **AC-2:** Same, for an invoice with `pol`/`pod` set — the created Shipment's `originPort`/`destPort` match, not blank.
- **AC-2b:** With Cloud Data configured, the Shipment visible in `DB.sh` immediately after `autoCreateShipmentFromInvoice()` returns (i.e. *after* its own `refreshShFromSupabase()` call) still has the correct inherited `dg`/`originPort`/`destPort` — not reverted by the `shRow` round-trip.
- **AC-3:** `saveShp()` adding a second, DG-flagged invoice number to an already-non-DG, unchecked-checkbox Shipment's `linkedInvs` flips `shp.dg` to `true` on save.
- **AC-4:** `saveShp()` removing the only DG invoice from `linkedInvs` (checkbox also unchecked) flips `shp.dg` back to `false` on save.
- **AC-4b:** `saveShp()` removing the only DG invoice from `linkedInvs` while the operator has, in the same save, manually checked `shf-dg` leaves `shp.dg` as `true`.
- **AC-5:** `saveShp()` never overwrites an already-non-blank `originPort`/`destPort` when a newly-linked invoice has a different port value.
- **AC-5b (new):** when the first newly-linked invoice (in `linkedInvs` order) has a blank `pol`, but a second newly-linked invoice has a non-blank `pol`, `originPort` is filled from the second invoice, not left blank — proving the fallback-through-the-list rule (REQ-SHIP-002c), not just a first-entry-only rule.
- **AC-6:** `renderShpSourceDriftWarn()` shows a banner naming the invoice and field when a linked invoice's `dg`/`pol`/`pod` has changed since the snapshot was taken; shows nothing when nothing has changed; shows a distinct "no longer exists" message when deleted; shows **one line per affected invoice** when two or more linked invoices have each drifted independently.
- **AC-7:** `backfillShLinkedInvIds()`, called a second time after an Invoice that a previously-unresolved `linkedInvs` entry refers to has since been created, resolves that entry on the second call.
- **AC-8:** The new Supabase columns round-trip correctly — omitted (not nulled) on the local object when the Supabase column is `null`.
- **AC-9:** `invHasDG(inv)` produces `true` for an invoice whose line has `li.dg: true` but no DG-flagged (or no) catalogue match, and `openLoadCalc()`'s DG badge for the same fixture now also shows `true` where it previously showed nothing.
- **AC-10 (corrected — round-2 finding 1):** `saveShp()`'s normal resolve-on-save path, given `linkedInvs = [unresolvableNumber, resolvableNumber]` (unresolved entry listed *first*), produces `linkedInvIds` of length **1** (containing only the resolved id — not length 2 with a hole or a `null` placeholder) and `linkedInvSnapshots` of length **1** whose single entry's `invId` matches the resolved invoice — proving compaction, not positional parallelism, and specifically exercising the unresolved-before-resolved ordering that would have silently violated v2's contradictory shape claim.
- **AC-11 through AC-14:** The four pre-existing DG-toggle tests (`tests/run.js:14131,14144,14156,14169`) pass unmodified.
- **AC-15:** A substring-presence test against the live `AI_SYSTEM_PROMPT` string confirms it describes the new inheritance/drift behavior.
- **AC-16 (new — closes round-2 advisory 2):** `editShp()` on a Shipment whose `dg` is `true` purely because a currently-linked invoice is DG (operator never checked the box) renders `shf-dg` checked **and disabled**, with the explanatory tooltip text present. Editing `shf-invs` in the same open modal to remove that invoice re-enables the checkbox live, without requiring a save/reopen cycle.

## 4. Explicitly out of scope for v3

- No picker/dropdown UI for linking invoices (§1.3).
- No FK database constraint on the array columns (§1.3).
- No deduplication of repeated identical invoice numbers within one Shipment's `linkedInvs` (§1.3).
- No change to `FIELD_MAPS.sh` / Google Sheets sync for the two new fields (§1.3).
- No change to the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification (REQ-SHIP-002h); no warehousing concept. Both separately scoped, REQ-SHIP-003/004.
- No retroactive correction of a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute.

## 5. Open questions for independent review

None outstanding.

## 8. Self-review log (v3, post-round-2)

- Re-verified round 2's one new blocking finding (the `linkedInvIds` positional-parallelism/sparse-omission contradiction) by re-reading v2's own REQ-SHIP-002a text and the `qt.originCharges` citations personally, before accepting it — confirmed `qt.originCharges` is a scalar key with no positional meaning, making it a poor fit for the parallel-array claim it was cited to support.
- Re-verified round 2's four advisory findings personally: grepped `tests/run.js` for `AI_SYSTEM_PROMPT` (zero matches, confirming the false-precedent claim), re-read `editShp()`'s checkbox-population line (`index.html:13289`) to confirm it has no provenance awareness, and confirmed `REQ-SHIP-002c` in v2 never stated a construction algorithm for the parallel arrays on the `saveShp()` path specifically (only the backfill path used index-aware language).
- Chose compaction-without-positional-correspondence (REQ-SHIP-002a) over sparse-array holes as the fix, specifically because nothing downstream actually needs index correspondence once `linkedInvSnapshots` entries carry their own `invId` — confirmed this by checking REQ-SHIP-002d's lookup mechanism, which was already `invId`-keyed, not index-keyed, even in v2.
- Added the `shf-dg` disabled-checkbox UI (REQ-SHIP-002c, AC-16) rather than merely disclosing the "unchecking silently does nothing" interaction as a known quirk — judged that a real, unprompted UX confusion risk (round-2 advisory 2) deserved an actual fix within this REQ's own scope, not a footnote, especially given this REQ's own stated goal is to make the Shipment↔Invoice relationship legible to the operator, not just correct in the database.
- Did not re-litigate round 1's own five blocking findings — round 2 independently re-confirmed all five RESOLVED, and nothing in this v3 revision touches that work.

## 9. Independent review round 1 — verdict FAIL, all findings personally re-verified and fixed (unchanged from v2, reproduced for history)

**Blocking (all fixed in v2, independently re-confirmed resolved by round 2 — see §9b):**
1. v1's `openLoadCalc()`/`runLoadCalc()` "byte-identical" DG-check claim was false.
2. v1 missed the 4th Cloud Data write site (`shRow`).
3. v1's DG-recompute rule broke 4 existing tests.
4. v1's backfill design invented a device marker not present in either cited precedent.
5. Two requirements had no AC.

**Advisory (all fixed in v2):** citation imprecision; origin-port extension undisclosed; duplicate-invoice-number handling undisclosed; `FIELD_MAPS.sh` gap undisclosed; "mirrors exactly" overstatement for the PO drift precedent.

## 9b. Independent review round 2 (confirmatory) — verdict FAIL, 1 new blocking + 4 advisory, all personally re-verified and fixed

**Round 1's five blocking findings — independently re-confirmed RESOLVED by this round**, via fresh code reads and hand-tracing against the four existing DG-toggle tests, the two backfill call sites, and the `shRow` object — not relitigated here.

**New blocking finding (1):** v2's REQ-SHIP-002a asserted both "same index, same order [as `linkedInvs`]" and "sparse by omission" for `linkedInvIds` — mutually incompatible for an unresolved-entry-before-resolved-entry case, and the `qt.originCharges` precedent cited doesn't actually support a positional-array claim (it's a scalar). AC-10 as worded didn't exercise the contradiction either. **Fixed:** REQ-SHIP-002a now specifies compaction with no positional correspondence at all; `linkedInvSnapshots` is self-identifying via `invId`; AC-10 rewritten to specifically test the unresolved-before-resolved ordering.

**New advisory findings, also fixed:**
1. AC-15's claimed "existing pattern" precedent (an automated `AI_SYSTEM_PROMPT` substring test already used elsewhere in the suite) doesn't exist — zero matches on grep. **Fixed:** REQ-SHIP-002g now states plainly this is new coverage, not a reuse of a proven pattern.
2. Unchecking `shf-dg` on a Shipment whose DG is invoice-derived silently has no effect, with no UI signal explaining why. **Fixed:** new disabled-checkbox-with-tooltip behavior (REQ-SHIP-002c, AC-16), live-recomputed as `shf-invs` changes in the open modal.
3. `invHasDGAcrossCurrentlyLinkedInvoices` had no pseudocode, recoverable only by triangulating AC examples. **Fixed:** REQ-SHIP-002c now spells out the full construction algorithm directly.
4. The "first newly-resolving linked invoice's `pol`/`pod`" port-inheritance rule never specified fallback behavior when that first invoice itself has a blank port. **Fixed:** REQ-SHIP-002c now specifies iterate-and-use-first-non-blank; new AC-5b tests the multi-invoice fallback case directly.
