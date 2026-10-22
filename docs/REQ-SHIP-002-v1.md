# REQ-SHIP-002 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Status:** v1 — drafted, self-reviewed (§8). Not yet independently reviewed.
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
- `autoCreateShipmentFromInvoice(inv)` (`index.html:8923`) hardcodes `dg: false` and calls `shpSeedTradeDocs(false)` unconditionally (`index.html:8937-8938`) — DG status never flows from the source invoice, even though the invoice's own line items carry DG via the Line Item catalogue's `dg` flag (confirmed live elsewhere in this codebase — `runLoadCalc()`, `index.html:13446-13449`: `(inv.lineItems||[]).some(li => (DB.li.find(x=>x.id===li.lid)||{}).dg || li.dg)`). Origin/dest port (`originPort`/`destPort`) also start blank, never pre-filled from the invoice's own `pol`/`pod` fields (confirmed format-compatible — both sides use the identical free-text-with-`dl-ports`-datalist-suggestion input, `index.html:2577-2578` vs `index.html:1189-1190` — so this is a straight string copy, not a format reconciliation problem).
- The existing Quote↔Order-Request and PO↔Invoice "source changed since this was created" pattern (`renderQteSourceDriftWarn()`, `renderPoSourceDriftWarn()`) is the established precedent this REQ reuses rather than inventing a new mechanism: a snapshot taken at link/creation time, compared against the live source record on every render, surfaced as a non-blocking warning banner — never an automatic overwrite.
- `linkedInvs` is explicitly not required to be 1:1 (one Shipment can consolidate multiple Invoices into one container/BL) — confirmed by `autoCreateShipmentFromInvoice()`'s own idempotency check treating `linkedInvs` as an appendable list, and by the operator's own real workflow (container consolidation across orders).

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 — Multi-invoice conflicts: DG is OR'd across every linked invoice; destination port inherits from the first-linked invoice but a mismatch from a later-linked invoice is a warning, never a silent overwrite or a block.**
Rationale (operator-selected): DG is a safety property — treating a consolidated Shipment as DG if *any* linked invoice is DG is the only conservative-by-default choice. Destination is informational, not safety-critical, so a soft warning (not a hard block on linking) keeps the workflow unobstructed while still surfacing the real discrepancy for the operator to resolve.

**Decision 2 — Post-link drift detection: yes, mirror `renderQteSourceDriftWarn()`/`renderPoSourceDriftWarn()` exactly. No auto-overwrite, ever, after the initial link.**
A `linkedInvSnapshots[]` array captures `{invId, dg, pol, pod}` for each linked invoice at the moment it's linked (auto-create, or added via `saveShp()`). On every Shipment render/open, each snapshot is compared against the live Invoice; a mismatch on `dg`, `pol`, or `pod` shows a banner naming which invoice and which field changed. The Shipment's own `dg`/`originPort`/`destPort` fields are never silently rewritten — same contract as the Quote/PO precedent.

**Decision 3 — Historical backfill: yes, existing Shipments get a one-time migration resolving `linkedInvs` (numbers) against `DB.inv` by `num`.**
`backfillShLinkedInvIds()` (mirroring `migrateLinkedPOIds()`'s/`backfillShLinkedInvs()`'s existing shape and naming convention) runs once per device, populates `linkedInvIds[]` and `linkedInvSnapshots[]` for every existing Shipment whose `linkedInvs` numbers resolve against `DB.inv`, and **logs** (does not silently drop) any entry that doesn't resolve — a deleted or renamed invoice, or a typo that was never caught. Non-resolving entries stay in `linkedInvs` exactly as-is (that field is never cleared or rewritten by this migration) so no display regression occurs for a Shipment whose text link can't be resolved.

### 1.3 What this REQ deliberately does NOT do

- Does not turn `shf-invs` into a picker/dropdown widget. The operator still types comma-separated invoice numbers in the same free-text field — `saveShp()` resolves each against `DB.inv` by `num` *after* the existing parse, same UX, new internal id layer underneath. A real picker UI is a separate, much larger UX change not asked for here.
- Does not add a database foreign-key constraint on `linked_inv_ids` (jsonb array — Postgres can't FK-constrain individual array elements without a join table, which is out of scope; resolution/validation stays client-side, same posture `0007_shipments.sql` already documents for `linked_invs`).
- Does not change `originPort`/`destPort` for a Shipment that already has a non-blank value when a new invoice is linked to it — inheritance only pre-fills a **blank** field; it never overwrites an operator's own already-entered port.
- Does not touch the Load Calculator or any warehousing concept — those are REQ-SHIP-003/004, separately scoped, in that priority order per the operator's own instruction.

---

## 2. Requirements

### REQ-SHIP-002a — New Shipment schema fields: `linkedInvIds[]` and `linkedInvSnapshots[]`
```js
linkedInvIds: ['inv-uuid-1', 'inv-uuid-2'],       // real Invoice ids, parallel array to linkedInvs
linkedInvSnapshots: [
  { invId: 'inv-uuid-1', dg: false, pol: 'Qingdao', pod: 'Bridgetown' }
]
```
`linkedInvIds[i]` corresponds to the invoice resolved from `linkedInvs[i]` — same index, same order. An entry in `linkedInvs` that doesn't resolve to a real `DB.inv.id` has no corresponding entry in `linkedInvIds` (sparse by omission, not by `null` placeholder — mirrors how `qt.originCharges` etc. omit rather than null a key for "not applicable").

### REQ-SHIP-002b — `autoCreateShipmentFromInvoice(inv)` inherits DG and port on creation
Revise `index.html:8936-8942`: `dg` computed via the OR-across-lines check (Decision 1; same logic as `runLoadCalc()`'s existing check, extracted to a new shared `invHasDG(inv)` helper rather than duplicated a third time — `runLoadCalc()`'s two existing inline copies should be refactored to call it too, so this logic can never diverge across its three call sites). `originPort`/`destPort` pre-filled from `inv.pol`/`inv.pod` (blank if the invoice itself has neither set — never fabricated). `linkedInvIds: [inv.id]` and `linkedInvSnapshots: [{invId: inv.id, dg, pol: inv.pol||'', pod: inv.pod||''}]` set alongside the existing `linkedInvs: [inv.num]`.

### REQ-SHIP-002c — `saveShp()` resolves `linkedInvs` to `linkedInvIds`/`linkedInvSnapshots` on every save
After the existing `linkedInvs` parse (`index.html:13304`), resolve each number against `DB.inv` by `num`. For a number that newly resolves (wasn't in the previous `linkedInvIds`), compute its DG/pol/pod snapshot the same way as REQ-SHIP-002b and **OR it into `shp.dg`** (Decision 1 — adding a DG invoice to a non-DG shipment flips it DG; removing one does not auto-un-flip, since another remaining linked invoice might still be DG — recomputing "is any *currently* linked invoice DG" on every save, not just incrementally, is the correct & simpler rule and is what's actually specified here). `originPort`/`destPort` are pre-filled **only if currently blank** (see §1.3).

### REQ-SHIP-002d — `renderShpSourceDriftWarn(shp)` — new function, new banner on the Edit Shipment modal
Mirrors `renderPoSourceDriftWarn()`'s structure exactly (`index.html:8969`): for each entry in `linkedInvSnapshots`, look up the live Invoice by `invId`; if not found, one line ("Linked Invoice no longer exists"); if found, compare `dg`/`pol`/`pod` against the snapshot and list every field that differs, naming the invoice number. Wired into `editShp()` the same way `renderPoSourceDriftWarn()` is wired into `editPO()` — called on open, with a dedicated `<div id="shp-drift-warn">` placeholder on the modal.

### REQ-SHIP-002e — `backfillShLinkedInvIds()` — one-time historical migration
Mirrors the existing `backfillShLinkedInvs()` (string-coercion healing fix from `SH-GAP-002`) in wiring pattern: runs once per device (own localStorage marker, e.g. `st_sh_linkedinvids_backfill_ts`), iterates `DB.sh`, and for each record resolves `linkedInvs` numbers against `DB.inv`, populating `linkedInvIds`/`linkedInvSnapshots` wherever a match is found. Logs (via `console.warn`, same severity convention as other defensive-fix logging in this codebase) any `linkedInvs` entry that doesn't resolve, naming the Shipment ref and the unresolved number — does not throw, does not block, does not clear the unresolved entry from `linkedInvs`.

### REQ-SHIP-002f — Cloud Data: two new nullable `jsonb` columns, all four existing touchpoints extended
New migration `supabase/migrations/0010_shipments_linked_inv_ids.sql`:
```sql
alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
```
Additive only, mirrors `0008_shipments_trade_docs.sql`'s own precedent exactly (two new nullable jsonb columns, no backfill at the database level — the local-side backfill in REQ-SHIP-002e handles existing records, and migrating them to Supabase afterward is an ordinary `saveShp()`/sync round-trip, not a special migration step). Wire into the same four touchpoints the Shipment Cloud Data layer already has for every other field: `refreshShFromSupabase()`'s read-back (`index.html:6306`-adjacent, `!= null` guard per this codebase's own standing "omit the key, don't null it" rule), `saveShp()`'s create/update row builder (`index.html:13358`-adjacent), and `migrateShToSupabase()`'s insert loop (`index.html:7466`-adjacent).

### REQ-SHIP-002g — `AI_SYSTEM_PROMPT` and `docs/user-guide.md` updated
Per this repo's own mandatory-on-every-version rule: the Shipments section of both needs to describe the new inheritance/drift behavior, replacing the prior description's silence on this point.

---

## 3. Acceptance criteria

- **AC-1:** `autoCreateShipmentFromInvoice(inv)` on an invoice whose line items include a DG-flagged catalogue item creates a Shipment with `dg: true` and a seeded Dangerous Goods Declaration trade-doc line — not `dg: false` as today.
- **AC-2:** Same, for an invoice with `pol`/`pod` set — the created Shipment's `originPort`/`destPort` match, not blank.
- **AC-3:** `saveShp()` adding a second, DG-flagged invoice number to an already-non-DG Shipment's `linkedInvs` flips `shp.dg` to `true` on save.
- **AC-4:** `saveShp()` removing the only DG invoice from `linkedInvs` (leaving only non-DG invoices linked) flips `shp.dg` back to `false` on save.
- **AC-5:** `saveShp()` never overwrites an already-non-blank `originPort`/`destPort` when a newly-linked invoice has a different port value.
- **AC-6:** `renderShpSourceDriftWarn()` shows a banner naming the invoice and field when a linked invoice's `dg`/`pol`/`pod` has changed since the snapshot was taken; shows nothing when nothing has changed; shows a distinct "no longer exists" message when the linked invoice has been deleted.
- **AC-7:** `backfillShLinkedInvIds()` resolves every existing Shipment's `linkedInvs` against `DB.inv` exactly once per device, is idempotent on a second run, and logs (not throws) on any unresolved entry.
- **AC-8:** The new Supabase columns round-trip correctly — omitted (not nulled) on the local object when the Supabase column is `null`, per this codebase's own standing rule, confirmed via the same `'key' in obj === false` assertion style already used for `originCharges`/etc.
- **AC-9:** `invHasDG(inv)` (the new shared helper replacing the two existing inline duplicates in `runLoadCalc()`) produces byte-identical results to both of today's inline checks across the same test fixtures — refactor-only, zero behavior change at those two call sites.

## 4. Explicitly out of scope for v1

- No picker/dropdown UI for linking invoices (§1.3).
- No FK database constraint on the array columns (§1.3).
- No change to the Load Calculator or any warehousing concept (separately scoped, REQ-SHIP-003/004).
- No retroactive correction of a Shipment's `dg`/port fields that an operator has already manually set differently from what backfill/inheritance would now compute — the backfill only populates the new `linkedInvIds`/`linkedInvSnapshots` fields, never touches `dg`/`originPort`/`destPort` on an existing record.

## 5. Open questions for independent review

None outstanding — the three genuine design forks were resolved with the operator directly (§1.2) before this draft was written, rather than left for a reviewer to catch.

## 8. Self-review log

- Checked `inv.pol`/`inv.pod` against `shp.originPort`/`shp.destPort` for format compatibility before assuming a direct copy was safe — both are free-text with the identical `dl-ports` datalist, confirmed via direct citation, not assumed (§1.1).
- Checked whether `linked_invs`'s current Supabase schema comment reflects a bug or a deliberate scoping call before writing §0's framing — it's explicitly the latter (`0007_shipments.sql`'s own comment cites `REQ-CLOUD-007 §1.1b`), so this REQ is framed as a deliberate reversal, not a bug-fix, to avoid mischaracterizing a prior, correctly-scoped decision.
- Considered whether DG should be recomputed fully on every `saveShp()` (REQ-SHIP-002c) versus incrementally OR'd in on new links only, and chose full recomputation specifically because the incremental version has no correct way to un-flip DG when the DG-carrying invoice is later removed — this is called out explicitly in the requirement text rather than left for a reviewer to find.
- Did not invent a destination-port "canonical form" reconciliation layer (e.g. resolving both to UN/LOCODE codes) — confirmed neither field is actually code-constrained today, so no such layer is needed; flagged as an assumption if that changes in a future REQ.
