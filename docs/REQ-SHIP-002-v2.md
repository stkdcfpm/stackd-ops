# REQ-SHIP-002 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Status:** v2 — revises v1 after independent requirements-gate review round 1: **FAIL**, 5 blocking + 5 advisory findings, all personally re-verified against live code before being accepted (§9). All 5 blocking and all 5 advisory findings fixed below. Not yet resubmitted for a confirmatory round.
**Type:** Entity-relationship rework. Extends the existing Shipment entity (`DB.sh`) and its Cloud Data table with two new fields (`linkedInvIds[]`, `linkedInvSnapshots[]`); extends `autoCreateShipmentFromInvoice()`, `saveShp()`, and adds a new `renderShpSourceDriftWarn()` mirroring the existing Quote/PO pattern. One new migration file. No new external dependency.

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
- **`autoCreateShipmentFromInvoice()` builds a SECOND, independent object for the Cloud Data branch — `shRow` at `index.html:8946-8952` — not just the local `newShp` object.** This matters directly for this REQ: `shRow` hardcodes `dg: false, origin_port: null, dest_port: null` on its own, separately from `newShp`'s own fields, and the function then calls `refreshShFromSupabase()` (`index.html:8956`) immediately after inserting it, which overwrites the local `DB.sh` entry from whatever was actually written to Supabase. **Any fix to `newShp`'s inheritance alone would be silently destroyed on first load for a Cloud-Data-configured deployment** unless `shRow` is fixed at the same time. This is the fourth of four Cloud Data touchpoints this REQ must change (§2, REQ-SHIP-002f) — found only by reading the whole function, not assumed from its first half.
- There are two independent, currently-divergent inline DG-detection checks in the Load Calculator, in two different functions, not one function as might first appear: `openLoadCalc()` (`index.html:13415-13418`, checks `cat && cat.dg` only — catalogue flag alone) and `runLoadCalc()` (`index.html:13446-13449`, checks `(cat && cat.dg) || li.dg` — catalogue flag OR the invoice line's own `dg` field). **These two are not logically equivalent today** — an invoice line with `li.dg: true` but no catalogue match (or a catalogue match that isn't itself DG-flagged) shows no DG badge in `openLoadCalc()`'s list but would correctly count as DG in `runLoadCalc()`'s calculation. Unifying them into one shared helper is therefore not a pure, zero-behavior-change refactor — it is a small, disclosed behavior change to `openLoadCalc()` specifically (§1.3, §2 REQ-SHIP-002h).
- The existing Quote↔Order-Request and PO↔Invoice "source changed since this was created" pattern (`renderQteSourceDriftWarn()`, `renderPoSourceDriftWarn()` at `index.html:8969-9009`) is the established precedent this REQ reuses, but **the PO precedent is a single-source, single-boolean design — not a loop over multiple snapshots.** `renderPoSourceDriftWarn(po)` compares exactly one `po.invId` against one live invoice and sets one `stale` flag with one generic banner message; it has no array of sources to iterate and no per-field detail in its output. `renderShpSourceDriftWarn()` must aggregate over potentially many `linkedInvSnapshots[]` entries and should name which invoice/field actually drifted — a real, necessary structural extension beyond the PO precedent's shape, not a literal copy of it (§2, REQ-SHIP-002d).
- `backfillShLinkedInvs()` (`index.html:3160-3173`) and `migrateLinkedPOIds()` (`index.html:3149-3158`) — the two existing "resolve/repair a field already in local storage" precedents this REQ's own backfill is modeled on — have **no device-level timestamp marker of any kind.** Each is idempotent purely via a per-record condition (`if (typeof s.linkedInvs === 'string')`, `if (q.linkedPOId && !q.linkedPOIds)`) and is simply called again, safely, every time its two call sites run: `index.html:13152-13153` and `index.html:15740-15741`, always together, always at exactly those two sites. A function that *can't* safely re-run (e.g. because it would mean something different the second time) is not actually following this precedent, no matter how similar its name is (§2, REQ-SHIP-002e).
- `linkedInvs` is explicitly not required to be 1:1 (one Shipment can consolidate multiple Invoices into one container/BL) — confirmed by `autoCreateShipmentFromInvoice()`'s own idempotency check treating `linkedInvs` as an appendable list, and by the operator's own real workflow (container consolidation across orders).
- **Four existing tests assert that `shp.dg` is driven purely by the `shf-dg` checkbox when `linkedInvs` is empty** (`tests/run.js:14131,14144,14156,14169`, all using `setupShpFormMinimal()` which blanks `shf-invs`, all toggling `shf-dg` directly and asserting on the resulting trade-doc-line add/remove logic at `index.html:13336-13343`). Any DG-recomputation rule this REQ introduces must preserve this exactly — a design that recomputes `dg` as *solely* a function of linked invoices, with no linked invoices meaning `dg` is always forced to `false`, would break all four (§2, REQ-SHIP-002c).

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 — Multi-invoice conflicts: DG is OR'd across every linked invoice (additive to, never a replacement for, the operator's own manual checkbox); destination/origin port inherit from the first-linked invoice but a mismatch from a later-linked invoice is a warning, never a silent overwrite or a block.**
Rationale (operator-selected): DG is a safety property — treating a consolidated Shipment as DG if *any* linked invoice is DG is the only conservative-by-default choice, and it must only ever add DG risk, never remove an operator's own independent confirmation of it. Destination is informational, not safety-critical, so a soft warning (not a hard block on linking) keeps the workflow unobstructed while still surfacing the real discrepancy for the operator to resolve.
**Disclosed extension beyond the literal question asked (flagged by round-1 review, §9 finding 2):** the operator's own answer to this question named "destination port" specifically; this REQ applies the identical inherit-once/warn-on-drift rule to *origin* port too, by direct analogy — there is no reason origin port should behave differently, but this is this REQ's own extension, not something the operator was separately asked about, and is called out here rather than silently folded in.

**Decision 2 — Post-link drift detection: yes, mirror the Quote/PO "snapshot at link time, compare to live on render, warn, never auto-overwrite" *contract* — adapted, not copied verbatim, into a design that handles multiple linked sources (§1.1 above).**
A `linkedInvSnapshots[]` array captures `{invId, dg, pol, pod}` for each linked invoice at the moment it's linked (auto-create, or added via `saveShp()`). On every Shipment render/open, each snapshot is compared against the live Invoice; a mismatch on `dg`, `pol`, or `pod` shows one line per differing invoice/field in the banner. The Shipment's own `dg`/`originPort`/`destPort` fields are never silently rewritten by this check — same contract as the Quote/PO precedent, different (necessarily multi-entry) shape.

**Decision 3 — Historical backfill: yes, existing Shipments get a self-healing resolution of `linkedInvs` (numbers) against `DB.inv` by `num` — re-run safely every time, not a one-time device-marked event.**
`backfillShLinkedInvIds()`, wired into the identical two call sites as `migrateLinkedPOIds()`/`backfillShLinkedInvs()` (`index.html:13152-13153` and `index.html:15740-15741`, always alongside them, never alone), resolves any `linkedInvs` entry that doesn't yet have a corresponding `linkedInvIds` entry, every time it runs — not gated behind a one-time marker. This means a `linkedInvs` number that didn't resolve the first time (the matching Invoice didn't exist yet, or was created later via CSV import) gets picked up automatically on the next app load once that Invoice exists, matching the self-healing behavior of both precedents exactly, rather than permanently giving up after one attempt. **Logs** (does not silently drop) any entry that still doesn't resolve on a given run — a deleted or renamed invoice, or a typo that was never caught. Non-resolving entries stay in `linkedInvs` exactly as-is (that field is never cleared or rewritten) so no display regression occurs.

### 1.3 What this REQ deliberately does NOT do

- Does not turn `shf-invs` into a picker/dropdown widget. The operator still types comma-separated invoice numbers in the same free-text field — `saveShp()` resolves each against `DB.inv` by `num` *after* the existing parse, same UX, new internal id layer underneath. A real picker UI is a separate, much larger UX change not asked for here.
- Does not add a database foreign-key constraint on `linked_inv_ids` (jsonb array — Postgres can't FK-constrain individual array elements without a join table, which is out of scope; resolution/validation stays client-side, same posture `0007_shipments.sql` already documents for `linked_invs`).
- Does not change `originPort`/`destPort` for a Shipment that already has a non-blank value when a new invoice is linked to it — inheritance only pre-fills a **blank** field; it never overwrites an operator's own already-entered port.
- Does not deduplicate a `linkedInvs` array that already contains the exact same invoice number more than once beyond the natural effect of resolving by id — two identical entries resolve to the same `invId`, so `linkedInvIds`/`linkedInvSnapshots` would carry a duplicate entry and the drift banner would list that invoice's drift twice. Harmless (same invoice, same answer, just printed twice) and deliberately not special-cased — fixing operator data-entry duplication is not this REQ's concern.
- Does not add `linkedInvIds`/`linkedInvSnapshots` to `FIELD_MAPS.sh` — the same, already-existing limitation `tradeDocs`/`autoCreatedFromInvIds` have today (neither is in `FIELD_MAPS.sh` either, confirmed at `index.html:4913`): these fields do not sync via the Google Sheets integration. Consistent with existing precedent, not a new gap this REQ introduces.
- Does not touch the Load Calculator's CBM/container-recommendation logic, or any warehousing concept — those are REQ-SHIP-003/004, separately scoped, in that priority order per the operator's own instruction. The one Load Calculator change this REQ *does* make (§2, REQ-SHIP-002h) is narrowly the DG-check unification, because leaving two divergent inline copies in place while adding a third, correct one for Shipment would make the inconsistency worse, not better.

---

## 2. Requirements

### REQ-SHIP-002a — New Shipment schema fields: `linkedInvIds[]` and `linkedInvSnapshots[]`
```js
linkedInvIds: ['inv-uuid-1', 'inv-uuid-2'],       // real Invoice ids, parallel array to linkedInvs
linkedInvSnapshots: [
  { invId: 'inv-uuid-1', dg: false, pol: 'Qingdao', pod: 'Bridgetown' }
]
```
`linkedInvIds[i]` corresponds to the invoice resolved from `linkedInvs[i]` — same index, same order. An entry in `linkedInvs` that doesn't resolve to a real `DB.inv.id` has no corresponding entry in `linkedInvIds` (sparse by omission, not by `null` placeholder — mirrors how `qt.originCharges` etc. omit rather than null a key for "not applicable"; AC-10 tests this shape directly, not just indirectly through the backfill path).

### REQ-SHIP-002b — `autoCreateShipmentFromInvoice(inv)` inherits DG and port on creation
Revise `index.html:8936-8942` (`newShp`): `dg` computed via `invHasDG(inv)` (REQ-SHIP-002h). `originPort`/`destPort` pre-filled from `inv.pol`/`inv.pod` (blank if the invoice itself has neither set — never fabricated). `linkedInvIds: [inv.id]` and `linkedInvSnapshots: [{invId: inv.id, dg, pol: inv.pol||'', pod: inv.pod||''}]` set alongside the existing `linkedInvs: [inv.num]`.

### REQ-SHIP-002c — `saveShp()`'s DG rule: additive-only from linked invoices, never a replacement for the manual checkbox
**Corrected design (round-1 finding 3):** `shp.dg = G('shf-dg').checked || invHasDGAcrossCurrentlyLinkedInvoices`. This is **not** "recompute `dg` as solely a function of linked invoices" (v1's flawed design) — the checkbox and the invoice-derived signal are OR'd together, symmetrically with how Decision 1 already treats cross-invoice DG (additive, never subtractive from an explicit confirmation). Concretely:
- Zero linked invoices (today's only case, and all four existing DG-toggle tests' fixture): `invHasDGAcrossCurrentlyLinkedInvoices` is `false` (OR over the empty set), so `shp.dg` reduces to exactly `G('shf-dg').checked` — **byte-identical to current behavior**, satisfying AC-11/AC-12/AC-13/AC-14 (the four existing tests, unchanged).
- Adding a DG-flagged invoice to `linkedInvs` while the checkbox is unchecked: `shp.dg` becomes `true` (AC-3).
- Removing the only DG-flagged invoice from `linkedInvs` while the checkbox is also unchecked: `shp.dg` becomes `false` (AC-4).
- Removing the only DG-flagged invoice while the operator has also (in the same save) manually checked the box: `shp.dg` stays `true` — the operator's explicit action always wins upward, consistent with Decision 1's "additive, never subtractive from manual confirmation."
`originPort`/`destPort` are pre-filled from the first newly-resolving linked invoice's `pol`/`pod` **only if currently blank** (§1.3).

### REQ-SHIP-002d — `renderShpSourceDriftWarn(shp)` — new function, new banner on the Edit Shipment modal
Adapted from (not a literal copy of) `renderPoSourceDriftWarn()`'s snapshot-vs-live contract (`index.html:8969-9009`): for each entry in `linkedInvSnapshots`, look up the live Invoice by `invId`; if not found, one line naming that invoice ("Linked Invoice <num> no longer exists"); if found, compare `dg`/`pol`/`pod` against the snapshot and list every differing field, naming the invoice number — unlike the PO precedent's single boolean/single generic message, this banner must be able to show more than one line, since more than one invoice can be linked. Wired into `editShp()` the same way `renderPoSourceDriftWarn()` is wired into `editPO()` — called on open, with a dedicated `<div id="shp-drift-warn">` placeholder on the modal.

### REQ-SHIP-002e — `backfillShLinkedInvIds()` — self-healing resolution, wired at the same two call sites as its precedents, no device marker
Per Decision 3 (§1.2) and the corrected precedent-match (§1.1): no localStorage marker of any kind. Iterates `DB.sh`; for each record, for each `linkedInvs[i]` with no corresponding `linkedInvIds[i]` yet, attempts to resolve it against `DB.inv` by `num` and fills in both `linkedInvIds[i]` and `linkedInvSnapshots[i]` if found. Wired into `index.html:13152-13153` and `index.html:15740-15741`, immediately alongside the existing `migrateLinkedPOIds()`/`backfillShLinkedInvs()` calls at both sites — never added at only one. Logs (via `console.warn`) any entry that still doesn't resolve, naming the Shipment `ref` and the unresolved number — does not throw, does not block, does not clear the unresolved entry from `linkedInvs`.

### REQ-SHIP-002f — Cloud Data: two new nullable `jsonb` columns, **all four** existing touchpoints extended
New migration `supabase/migrations/0010_shipments_linked_inv_ids.sql`:
```sql
alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
```
Additive only, mirrors `0008_shipments_trade_docs.sql`'s own precedent exactly (two new nullable jsonb columns, no backfill at the database level — the local-side backfill in REQ-SHIP-002e handles existing records, and migrating them to Supabase afterward is an ordinary `saveShp()`/sync round-trip, not a special migration step). Wire into **all four** of the Shipment Cloud Data layer's existing field-building sites, not three (round-1 finding 2 corrected this count):
1. `refreshShFromSupabase()`'s read-back (`index.html:6306`-adjacent, `!= null` guard per this codebase's own standing "omit the key, don't null it" rule).
2. `saveShp()`'s create/update row builder (`index.html:13358`-adjacent).
3. `migrateShToSupabase()`'s insert loop (`index.html:7466`-adjacent).
4. **`autoCreateShipmentFromInvoice()`'s own separate `shRow` object (`index.html:8946-8952`)** — this one is easy to miss because it is textually distant from the other three and built from `newShp`'s fields by hand rather than reusing a shared row-builder function; it must read `dg: newShp.dg, origin_port: newShp.originPort || null, dest_port: newShp.destPort || null, linked_inv_ids: newShp.linkedInvIds, linked_inv_snapshots: newShp.linkedInvSnapshots` rather than the hardcoded `false`/`null`/`null` it has today — otherwise the very next `refreshShFromSupabase()` call three lines later (`index.html:8956`) overwrites the correctly-inherited local values with the wrong ones just written to Supabase.

### REQ-SHIP-002g — `AI_SYSTEM_PROMPT` and `docs/user-guide.md` updated
Per this repo's own mandatory-on-every-version rule: the Shipments section of both needs to describe the new inheritance/drift behavior, replacing the prior description's silence on this point. **AC-15** (new, closes round-1 finding 5's second half) requires at minimum a substring-presence test against the live `AI_SYSTEM_PROMPT` string content, mirroring the pattern already used elsewhere in this suite for prompt-content regression coverage (e.g. the existing RFQ-comparison "no response is ever deleted" claim fix, `docs/version-history.md`'s v2.9.69 entry) — not left as an unverifiable, undocumented-in-tests manual step the way REQ-SHIP-002g stood in v1.

### REQ-SHIP-002h — New shared `invHasDG(inv)` helper, replacing TWO divergent inline copies (not a zero-behavior-change refactor — disclosed)
```js
function invHasDG(inv) {
  return (inv.lineItems || []).some(function(li) {
    var cat = DB.li.find(function(x){ return x.id === li.lid; });
    return (cat && cat.dg) || li.dg;
  });
}
```
Adopts `runLoadCalc()`'s existing, more-complete check (`index.html:13446-13449`) as the canonical rule — catalogue flag OR the invoice line's own `dg` field — rather than `openLoadCalc()`'s narrower one (`index.html:13415-13418`, catalogue flag only). `openLoadCalc()` is updated to call this shared helper too. **This is a disclosed, intentional behavior change at exactly one call site** (`openLoadCalc()`'s DG badge in the invoice-selection list): an invoice whose line has `li.dg: true` directly but no DG-flagged catalogue match will now show the DG badge there, where it previously wouldn't — bringing it into agreement with what `runLoadCalc()` already computes for the same invoice today. `runLoadCalc()`'s own call site changes to use the shared helper but produces no different output, since it already implements this exact logic inline.

---

## 3. Acceptance criteria

- **AC-1:** `autoCreateShipmentFromInvoice(inv)` on an invoice whose line items include a DG-flagged catalogue item (or a line with `li.dg: true` directly) creates a Shipment with `dg: true` and a seeded Dangerous Goods Declaration trade-doc line — not `dg: false` as today.
- **AC-2:** Same, for an invoice with `pol`/`pod` set — the created Shipment's `originPort`/`destPort` match, not blank.
- **AC-2b (new):** With Cloud Data configured (`_sb` + `st_sh_cloud_migration_ts` set), the Shipment visible in `DB.sh` immediately after `autoCreateShipmentFromInvoice()` returns (i.e. *after* its own `refreshShFromSupabase()` call) still has the correct inherited `dg`/`originPort`/`destPort` — not reverted to `false`/blank by the `shRow` round-trip. Directly targets round-1 finding 2.
- **AC-3:** `saveShp()` adding a second, DG-flagged invoice number to an already-non-DG, unchecked-checkbox Shipment's `linkedInvs` flips `shp.dg` to `true` on save.
- **AC-4:** `saveShp()` removing the only DG invoice from `linkedInvs` (leaving only non-DG invoices linked, checkbox also unchecked) flips `shp.dg` back to `false` on save.
- **AC-4b (new):** `saveShp()` removing the only DG invoice from `linkedInvs` while the operator has, in the same save, manually checked `shf-dg` leaves `shp.dg` as `true` — the manual confirmation is never silently overridden downward. Directly targets round-1 finding 3.
- **AC-5:** `saveShp()` never overwrites an already-non-blank `originPort`/`destPort` when a newly-linked invoice has a different port value.
- **AC-6:** `renderShpSourceDriftWarn()` shows a banner naming the invoice and field when a linked invoice's `dg`/`pol`/`pod` has changed since the snapshot was taken; shows nothing when nothing has changed; shows a distinct "no longer exists" message when the linked invoice has been deleted; shows **one line per affected invoice** when two or more linked invoices have each drifted independently (not just one aggregated boolean). Directly targets round-1 finding E (advisory).
- **AC-7:** `backfillShLinkedInvIds()`, called a second time after an Invoice that a previously-unresolved `linkedInvs` entry refers to has since been created, resolves that entry on the second call — proving it is genuinely self-healing/re-runnable, not a one-shot. Directly targets round-1 finding 4.
- **AC-8:** The new Supabase columns round-trip correctly — omitted (not nulled) on the local object when the Supabase column is `null`, per this codebase's own standing rule, confirmed via the same `'key' in obj === false` assertion style already used for `originCharges`/etc.
- **AC-9:** `invHasDG(inv)` produces `true` for an invoice whose line has `li.dg: true` but no DG-flagged (or no) catalogue match — proving the shared helper adopts `runLoadCalc()`'s existing broader rule, and that `openLoadCalc()`'s DG badge for the same fixture now also shows `true` where it previously showed nothing. Directly targets round-1 finding 1 (replaces v1's now-withdrawn "byte-identical, zero behavior change" claim).
- **AC-10:** `saveShp()`'s normal (non-backfill) resolve-on-save path produces a `linkedInvIds`/`linkedInvSnapshots` shape that omits an unresolved entry's key rather than storing `null` in its place — tested directly against this path, not only indirectly through AC-7's backfill test. Directly targets round-1 finding 5 (first half).
- **AC-11 through AC-14:** The four pre-existing DG-toggle tests (`tests/run.js:14131,14144,14156,14169`) pass unmodified — confirms REQ-SHIP-002c's corrected OR-based rule is genuinely additive-only and introduces no regression for the zero-linked-invoices case every real Shipment today still falls into.
- **AC-15:** A substring-presence test against the live `AI_SYSTEM_PROMPT` string confirms it describes the new inheritance/drift behavior (REQ-SHIP-002g). Directly targets round-1 finding 5 (second half).

## 4. Explicitly out of scope for v2

- No picker/dropdown UI for linking invoices (§1.3).
- No FK database constraint on the array columns (§1.3).
- No deduplication of repeated identical invoice numbers within one Shipment's `linkedInvs` (§1.3).
- No change to `FIELD_MAPS.sh` / Google Sheets sync for the two new fields (§1.3).
- No change to the Load Calculator's CBM/container-recommendation logic beyond the one disclosed DG-check unification (REQ-SHIP-002h); no warehousing concept. Both separately scoped, REQ-SHIP-003/004, in that priority order per the operator's own instruction.
- No retroactive correction of a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute — the backfill only populates the new `linkedInvIds`/`linkedInvSnapshots` fields, never touches `dg`/`originPort`/`destPort` on an existing record.

## 5. Open questions for independent review

None outstanding — the three genuine design forks were resolved with the operator directly (§1.2) before v1 was drafted; all five round-1 blocking findings and all five advisory findings are addressed above (§9).

## 8. Self-review log (v2, post-round-1)

- Re-verified every one of round-1's five blocking findings against the live code personally, line by line, before accepting any of them or writing a fix — none were taken on the reviewing agent's word alone (CLAUDE.md's own stated discipline for this process). All five held up exactly as reported.
- Re-checked the corrected REQ-SHIP-002c OR-based rule against all four existing DG-toggle tests by hand-tracing each fixture's `linkedInvs`/`shf-dg` values through the new formula, not just asserting it "should" work — confirmed all four reduce to the pre-existing behavior exactly, since every one of them has `linkedInvs: []`.
- Considered whether AC-4b's "operator wins upward" rule creates its own new inconsistency with Decision 1's "DG is additive, never subtractive" framing — concluded it does not: subtractive would mean an *invoice* removal silently turning off an operator's own confirmation, which AC-4b specifically prevents; the checkbox was never claimed to be subject to the invoice-driven rule in the first place.
- Did not re-litigate any of the three operator-resolved decisions themselves — only corrected how faithfully and completely this document implements them, per the explicit instruction given before round-1 review.

## 9. Independent review round 1 — verdict FAIL, all findings personally re-verified and fixed

**Blocking:**
1. `AC-9` (v1) claimed `openLoadCalc()`/`runLoadCalc()` held two logically-equivalent inline DG checks and that unifying them was zero-behavior-change. Verified false — they diverge for `li.dg: true` with no/non-DG catalogue match. **Fixed:** REQ-SHIP-002h now adopts the broader rule explicitly, discloses the one-call-site behavior change, and AC-9 is rewritten to test the divergent case directly rather than claim byte-identity.
2. A fourth Cloud Data write site (`autoCreateShipmentFromInvoice()`'s own `shRow`, `index.html:8946-8952`) hardcodes `dg:false`/`origin_port:null`/`dest_port:null` independently of `newShp`, and is overwritten back into `DB.sh` via the function's own trailing `refreshShFromSupabase()` call — would have silently destroyed the v1 inheritance fix on any Cloud-Data deployment. **Fixed:** REQ-SHIP-002f now names and fixes this as touchpoint 4 of 4; new AC-2b tests it directly.
3. v1's "full recomputation" DG rule in REQ-SHIP-002c forced `dg` to `false` whenever `linkedInvs` was empty, regardless of the `shf-dg` checkbox — breaks 4 existing, currently-passing tests and removes the operator's independent manual DG control. **Fixed:** REQ-SHIP-002c now specifies an OR-based rule (checkbox OR invoice-derived signal) that reduces to exactly today's behavior when no invoices are linked; new AC-4b covers the "operator wins upward" case; AC-11–14 pin the four existing tests as a regression guard.
4. REQ-SHIP-002e's backfill invented a device-level timestamp marker not present in either cited precedent (`backfillShLinkedInvs()`, `migrateLinkedPOIds()` — both condition-based, re-runnable, called together at exactly two sites) and never specified wiring call sites. **Fixed:** REQ-SHIP-002e now specifies the identical two call sites and drops the marker entirely in favor of per-entry condition-based resolution; new AC-7 tests the self-healing re-run behavior directly.
5. Two lettered requirements (REQ-SHIP-002a's shape, REQ-SHIP-002g's doc/prompt updates) had no AC that would actually catch a regression in them. **Fixed:** new AC-10 (shape, tested on the normal save path, not only the backfill path) and AC-15 (prompt-content substring test).

**Advisory, also fixed:**
- A. Citation imprecision (`shpSeedTradeDocs(false)` is at line 8935, not inside the cited 8937-8938 range) — citations in §1.1 now cite the function's full range and call out the exact lines for each specific claim.
- B. §1.2 Decision 1 as originally recorded only named destination port; origin port's identical treatment is now explicitly disclosed as this REQ's own analogous extension, not silently folded in.
- C. Duplicate invoice numbers within one `linkedInvs` array — now explicitly addressed in §1.3 as a known, harmless, deliberately-unhandled case.
- D. `FIELD_MAPS.sh` gap for the two new fields — now explicitly disclosed in §1.3 as consistent with the existing, identical gap for `tradeDocs`/`autoCreatedFromInvIds`.
- E. "Mirrors exactly" overstated the PO drift-warning precedent's actual shape (single-source/single-boolean vs. this REQ's necessary multi-source/multi-line design) — §1.1, §2 REQ-SHIP-002d, and AC-6 now describe the adaptation accurately rather than claiming literal equivalence.
