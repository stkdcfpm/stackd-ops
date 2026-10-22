# REQ-LI-002 — Supplier-linked Line Item catalogue: stop silent data loss on quick-add, auto-queue catalogue promotion on Quote acceptance, and fix the picker/library UX

**Status:** v1 — drafted, self-reviewed (§8). Not yet independently reviewed.
**Type:** Entity-relationship + workflow feature, phased. Extends Invoice line items (`cIL`), `quickAddLine()`, `rILT()`, the Invoice form; extends `saveQte()`; adds a new local-only `DB.liPending[]` entity and its UI; extends `openPicker()` and `rLI()`. No schema change to `DB.li` itself (the Line Item record shape is untouched — only how/when records get created or suggested changes). No Supabase migration.

---

## 0. How this REQ came to be scoped this way

Operator asked, mid-conversation about an unrelated Shipment↔Invoice gap, to review the Line Items (product catalogue) feature for the same class of problem, and stated the governing principle directly: entities in this app should retain real, auditable relationships, not loosely-coupled text references, and the data model should be robust and scalable as the business grows — "I'm not sure we can call victory on any of those counts just yet."

Direct code read found three concrete gaps (§1.1). The operator then asked for this to be run through this project's LLM Council (`docs/councils/README.md`, methodology in `.claude/commands/llm-council.md`) before deciding whether to fix Line Items standalone or commission a full code-and-feature review of the whole app first. The council session ran in full (5 advisors → anonymized peer review → chairman synthesis); all five peer reviewers independently converged on the same verdict regardless of which advisor they were reviewing: fix Line Items as scoped, sequenced work now; don't block on a full review; but close the one gap every advisor missed — the Invoice quick-add path is *actively destroying* real supplier pricing data today, and that should be stopped first, before anything else, as a near-zero-risk, same-day change. The full written verdict, including the "Where the Council Clashes" and "Blind Spots Caught" sections, is reproduced in this session's transcript; the operator confirmed "proceed based on the feedback" and then resolved three further scoping questions directly (§1.2) before this document was drafted.

---

## 1. Business context

### 1.1 What exists today (check-first)

- **Gap 1 — nothing in the live quoting/ordering pipeline ever touches the catalogue.** Grepped every `DB.li.push(...)` call site in `index.html`: `saveLI()` (`index.html:7990`, the manual "+ New Line Item" form — entirely DOM-form-coupled, reads `G('lf-*').value` directly, not a parameterized/reusable function), the CSV importer (`index.html:10929`, `index.html:11252`), and the one-time demo seed (`index.html:5584`). Nothing else. An RFQ response → committed → converted to a Quote line → Quote Accepted → converted to a PO → invoiced never creates or updates a `DB.li` record anywhere in that chain.
- **Gap 2 — Invoice quick-add discards real pricing data and has no supplier field at all, not even optional.** `quickAddLine()` (`index.html:8173-8194`) builds `cIL.push({ rid:uid(), lid:'', desc:desc, uom:uom, qty:qty, up:up, unitCost:uc, lineType:lt })` — there is no `supId` key anywhere in this object, confirmed by reading the full function; the quick-add form itself (`index.html:1202-1207`, fields `qal-type`/`qal-desc`/`qal-uom`/`qal-qty`/`qal-uc`/`qal-up`) has no supplier selector at all. `rILT()` (`index.html:8215-8254`), which renders and lets the operator inline-edit every `cIL` line after adding it, also has no supplier column. The only existing gate is `invLineHasCostBasis(li)` (`index.html:8169-8172`): `!!(li.lid && DB.li.find(...)) || (+li.unitCost > 0)` — it blocks a zero-cost Product line but says nothing about supplier attribution.
- **Gap 3 — the "Import from Library" picker (`openPicker()`, `index.html:8255-8266`) has no search and no grouping**, unlike the main Line Items tab (`rLI()`, `index.html:7874-7910`), which already has a search box (`li-q`) and a supplier-filter dropdown (`li-sf`, `index.html:291-292`) — just not visual grouping. `openPicker()` dumps every `DB.li` record as an unfiltered checkbox list.
- **Line Items already require a supplier.** `vLI()` (`index.html:10611-10628`): `if (!sup) return vErr('lf-sup', 'Please select a supplier');` — this REQ's new gates (§2) are extending an *existing* hard-required-supplier rule to the pipeline that currently bypasses the catalogue entirely, not inventing a new one.
- **There is already a real, working catalogue-matching precedent to reuse, not invent.** The CSV importer's Line Item branch (`index.html:10915-10929`) matches an existing record by `sku && supId` if a SKU is present, else by `desc.toLowerCase() === existing.desc.toLowerCase() && supId === existing.supId`. Quote lines never carry a `sku` field (confirmed — `cQL`/`cQteLine()`'s line shape is `{rid, supId, desc, qty, uom, cost, cbm, dg, dutyPct, markup, insRate}`, no `sku`), so the promotion matcher in this REQ (§2, LI-002d) always uses the desc+supId fallback branch — the same branch the importer already uses for exactly this case, not a new algorithm.
- **There is already a real, working "fire once on the genuine transition into a status" precedent to reuse.** `saveQte()` (`index.html:14249-14250`) already computes `wasAccepted = existQ && existQ.status === 'Accepted'` and `isAccepted = G('qf-st').value === 'Accepted'` for its own `approvedAt`-timestamp logic — `isAccepted && !wasAccepted` is the exact "genuine first transition into Accepted" condition this REQ's promotion trigger (§2, LI-002d) hooks onto, mirroring the identical guard shape `saveInvApprove()` already uses (`!wasApproved`, per `CLAUDE.md`'s own documented REQ-WEBHOOK-001 entry) to fire a side effect exactly once per real transition, never on every subsequent save of an already-Accepted record.
- **`saveLI()` cannot be called programmatically — it only exists as a DOM-form handler.** Any new code path that wants to write a Line Item (the promotion-approval action, §2 LI-002f) cannot call it directly with data; the only safe way to reuse it without duplicating its Cloud-Data-aware persistence logic (`index.html:7966-7987`, the `_sb`/`st_li_cloud_migration_ts`-gated branch vs. the local branch at `index.html:7989-7991`) is to pre-fill the same DOM fields `openLI()`/`editLI()` already populate, then let the operator's own click of the existing "Save Line Item" button run the real, already-correct, already-tested path. **This is a load-bearing design constraint, not a simplification for convenience:** `CLAUDE.md`'s Cloud Data section explicitly warns that mutating an existing Line Item by id outside its own `save*()` function, without first checking `st_li_cloud_migration_ts`, is exactly the class of bug that bit five prior entities' own Cloud Data rollouts (REQ-CLOUD-002's own round-3 spec-gate finding, cited by name in `CLAUDE.md`) — writing a second, parallel persistence path for the promotion queue would risk reintroducing that exact, already-documented defect class. Reusing the real form/`saveLI()` path sidesteps it structurally.
- **Line Item's `priceHistory[]` entries are `{date, cost, price, invoiceRef, notes}`** (`index.html:7958`, `saveLI()`'s own append logic; confirmed identical shape in the demo seed and in existing tests). `invoiceRef` is specifically invoice-shaped in every existing use — this REQ does not repurpose it for a Quote reference (that would be a confusing, undisclosed overload of a differently-named field); instead, a promoted/updated entry's provenance goes in `notes` (e.g. `"Promoted from Quote QTE-0001 on acceptance"`), which needs no schema change and is exactly what `notes` is already used for (`"Initial catalogue price"` / `"Catalogue price updated"`, both free-text provenance strings).

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 (operator-selected) — Quick-add's new supplier requirement applies to Product lines only.**
Mirrors `invLineHasCostBasis()`'s existing scoping exactly (`lineType==='product'` only, per `REQ/SPEC-INV-002`'s own precedent, cited in `CLAUDE.md`) — a bank fee or documentation charge (Charge type) or a pure cost-pass-through (Pass-through type) frequently has no meaningful supplier at all, and forcing a pick there would just produce sentinel "N/A" noise. Product lines are where the real sourcing/pricing data this REQ exists to protect actually lives.

**Decision 2 (operator-selected) — Catalogue promotion from a Quote fires on acceptance, and is review-gated, never silently automatic.**
Per the council verdict's own convergence (every peer reviewer flagged unreviewed auto-write as the Expansionist's biggest blind spot) and the operator's own explicit choice: accepting a Quote queues each eligible line as a *candidate* (§2, LI-002d/e) for the operator to approve or dismiss — nothing is written to `DB.li` until the operator takes that action, and approving opens the real, existing Line Item form pre-filled, rather than writing silently in the background.

**Decision 3 (operator-selected) — Forward-only; no historical backfill.**
Existing invoices with quick-added, non-catalogue-linked lines keep displaying exactly as they do today. This REQ captures supplier attribution and price history going forward only; it does not attempt to retroactively reconstruct or guess supplier attribution for historical quick-add rows, consistent with the Shipment REQ's own identical "no retroactive correction" scoping for the analogous reason (the data to reconstruct it correctly often doesn't exist, and guessing wrong would be worse than leaving it alone).

**Decision 4 (this REQ's own, disclosed) — The suggested catalogue price on promotion is the Quote's own implied sell price at acceptance, computed with the Quote engine's own existing margin resolver, not a guess.**
`suggestedPrice = cost * (1 + qteEffectiveMargin(line, quoteMarkup) / 100)` — reuses `qteEffectiveMargin()` (`index.html:13851-13854`) exactly as the Quote engine itself already computes a line's sell price, so the catalogue's suggested price is never a number invented by this REQ, only a number the Quote already stood behind. The operator sees and can edit this value before anything saves (Decision 2).

**Decision 5 (this REQ's own, disclosed) — The pending-promotion queue (`DB.liPending[]`) is a new, local-only entity; not Cloud-Data-synced in this version.**
Mirrors `SS.webhookRules[]`'s own precedent (`CLAUDE.md`'s REQ-WEBHOOK-001 entry: "a new, purely local, never-Cloud-Data-synced... settings field") — nothing in this REQ's scope demands this queue survive a device switch mid-review, and adding a sixth Cloud Data table for a transient review queue is a disproportionate cost for what it buys here. If cross-device review queueing is ever needed, that's a follow-up, not silently assumed now.

### 1.3 What this REQ deliberately does NOT do

- Does not change the `DB.li` record shape at all — no new fields on Line Item itself, no Supabase migration.
- Does not make quick-add require a supplier for Pass-through or Charge lines (Decision 1).
- Does not auto-write anything to the catalogue without an explicit operator approval action (Decision 2).
- Does not retroactively backfill supplier attribution on any existing invoice's quick-add lines (Decision 3).
- Does not refactor `saveLI()` into a parameterized, non-DOM-coupled function — the promotion-approval flow works by pre-filling the existing form instead (§1.1), specifically to avoid introducing a second, parallel Cloud-Data-aware persistence path.
- Does not add promotion-on-acceptance for Purchase Orders or any entity besides Quote — PO lines are already sourced from an Accepted Quote's own lines in the existing `qteToPoConvert()` flow, so promoting at Quote-acceptance time is the single correct trigger point; promoting again at PO-conversion time would be a redundant second trigger for the same underlying data.
- Does not touch the Load Calculator, container profiles, or any warehousing concept (separate, already-scoped future work, unrelated to this REQ).
- Does not add a picker/dropdown replacement for `shf-invs`-style free-text fields anywhere else in the app — out of scope, unrelated to Line Items.

---

## 2. Requirements

### LI-002a — Quick-add gains a required-for-Product supplier field
New `qal-sup` `<select>` on the quick-add form (`index.html:1202`-adjacent, same supplier-option-list pattern already used by `lf-sup`/`shf-invs`-adjacent supplier dropdowns elsewhere in the app). `quickAddLine()` (`index.html:8173`) reads it into a new `supId` key on the pushed `cIL` object. A new shared helper, `invLineHasSupplier(li)`, mirrors `invLineHasCostBasis()`'s exact shape:
```js
function invLineHasSupplier(li) {
  var resolved = li.lid && DB.li.find(function(x){ return x.id === li.lid; });
  return !!(resolved && resolved.supId) || !!li.supId;
}
```
`quickAddLine()` blocks (same toast-and-return pattern as the existing cost-basis check) when `lt === 'product' && !invLineHasSupplier({ lid:'', supId: chosenSupId })` — Pass-through/Charge lines are never gated on this (Decision 1).

### LI-002b — `vInv()`'s save-time backstop extended, mirroring the existing cost-basis pattern exactly
Per `CLAUDE.md`'s own documented finding on `REQ/SPEC-INV-002` (`invLineHasCostBasis()`'s gate exists at `quickAddLine()`'s entry point AND as a `vInv()` save-time backstop, because an operator can edit a line's values directly in `rILT()` after adding it, bypassing the entry gate): `vInv()` gains the identical second check using `invLineHasSupplier()`, scoped to `lineType==='product'` lines only, run alongside the existing cost-basis backstop so both close together rather than one being fixed and the other left open to the exact bypass this REQ already knows about.

### LI-002c — `rILT()` gains a supplier column, editable, so the quick-add-time choice is visible and correctable afterward
A new `<select>` cell per row (`index.html:8240`-adjacent, same per-row rebuild-on-change pattern `lineType`'s own select already uses at `index.html:8249`), populated from `li.supId`, writing back into `cIL[i].supId` on change. Rendered for every line type (so an operator can still optionally attach a supplier to a Pass-through/Charge line if one genuinely applies), but only enforced by LI-002a/b for Product lines.

### LI-002d — `saveQte()` queues eligible lines for catalogue review on the genuine first transition into Accepted
Immediately after the existing `isAccepted && !wasAccepted` point is already computed (`index.html:14249-14250`), for each Quote line with a non-blank `supId`:
1. Resolve a catalogue match using the identical desc+supId fallback the CSV importer already uses (`index.html:10915-10929`) — Quote lines have no `sku` to match on, so this is always the fallback branch, never the sku branch.
2. No match found → queue a `'new'` candidate.
3. Match found, but `existing.cost !== line.cost` or `existing.price !== suggestedPrice` (Decision 4's formula) → queue an `'update'` candidate referencing the matched `DB.li` id.
4. Match found and both already agree → no candidate queued; nothing to review.
Lines with a blank `supId` are skipped entirely — nothing to promote without a supplier, consistent with Line Items' own existing hard requirement.

### LI-002e — New local-only entity: `DB.liPending[]`
```js
{ id: uid(), status: 'pending', kind: 'new'|'update', matchedLiId: null|<id>,
  quoteId, quoteNum, supId, desc, uom, cost, suggestedPrice,
  createdAt: new Date().toISOString() }
```
Per Decision 5: local-only (`localStorage` via the same `sv(K.*, ...)` pattern every other array uses, new key e.g. `K.lip`), never pushed through `syncEnt()`/Cloud Data. `status` transitions `'pending' → 'approved'|'dismissed'` only; approved/dismissed entries are kept (not deleted) as a record of what was reviewed and when, but excluded from the active review list once resolved.

### LI-002f — Review UI: a banner on the Line Items tab, Approve opens the real form pre-filled, Dismiss just marks it done
A banner at the top of the Line Items tab (same visual pattern as the existing `onboarding-bar`/quality-check-warning banners already in the app), shown only when `DB.liPending.some(p => p.status==='pending')`, listing each pending candidate with its Quote reference, supplier, description, cost, and suggested price, and two actions:
- **Approve** — for `kind:'new'`, calls `openLI()` then pre-fills `lf-d`/`lf-sup`/`lf-c`/`lf-p`/`lf-u` from the candidate (per §1.1's load-bearing constraint: no new persistence path, the operator's own click on the existing Save Line Item button is what actually writes); for `kind:'update'`, calls `editLI(matchedLiId)` then overwrites just `lf-c`/`lf-p` with the candidate's cost/suggested price, leaving every other field as the existing record's own current data, so the operator sees old vs. proposed side by side before saving. Either way, on successful save, marks the `DB.liPending` entry `'approved'`. The promoted/updated entry's resulting `priceHistory` note reads `"Promoted from Quote <quoteNum> on acceptance"` (§1.1 — reusing `notes`, no schema change).
- **Dismiss** — marks the entry `'dismissed'`, confirm()-gated with the candidate's own description named in the message (mirroring this codebase's existing confirm()-message convention, e.g. `delRfqResponse()`'s own named-consequence confirm text), no further effect.

### LI-002g — `openPicker()` gains search + supplier grouping
Add a search input and reuse the main tab's own filter predicate (`index.html:7876`'s `(!q||desc.includes(q)||sku.includes(q)) && (!sf||supId===sf)`) inside the picker modal, and group the rendered rows under a supplier-name header per group (sorted by supplier name) rather than one flat list — the same underlying `DB.li` data, restructured for display only.

### LI-002h — `rLI()` (the main Line Items tab) groups rows by supplier
Rows already filtered by the existing `li-q`/`li-sf` controls are additionally grouped under a supplier-name header, sorted by supplier name then by description within each group — the filtering logic itself is unchanged, only the render shape.

---

## 3. Acceptance criteria

- **AC-1:** `quickAddLine()` with `lineType:'product'` and no supplier selected is blocked with a toast, mirroring the existing cost-basis block's style; Pass-through/Charge lines are never blocked on this.
- **AC-2:** A Product line added via quick-add with a real supplier persists `supId` on the `cIL` object, visible and editable in `rILT()`'s new supplier column.
- **AC-3:** `vInv()` refuses to save an invoice containing a Product line with no supplier and no catalogue link (`lid`), even if that line passed quick-add's own gate and was later edited to clear the supplier directly in `rILT()` — mirroring the existing cost-basis bypass-then-backstop test shape exactly.
- **AC-4:** Accepting a Quote (the genuine `isAccepted && !wasAccepted` transition) with one line whose desc+supId matches no existing catalogue entry queues exactly one `'new'` candidate in `DB.liPending`, with `suggestedPrice` equal to `cost * (1 + effectiveMargin/100)` for that line.
- **AC-5:** Accepting a Quote with a line whose desc+supId matches an existing catalogue entry, where cost and suggested price both already agree with the existing record, queues nothing.
- **AC-6:** Accepting a Quote with a line matching an existing catalogue entry whose stored cost differs queues exactly one `'update'` candidate referencing that record's id.
- **AC-7:** Re-saving an already-Accepted Quote (no status change) queues nothing — proving the trigger fires only on the genuine first transition, mirroring `saveInvApprove()`'s own `!wasApproved` guard test shape.
- **AC-8:** A Quote line with a blank `supId` is never queued, even if its desc happens to match an existing catalogue entry belonging to a different supplier.
- **AC-9:** Approving a `'new'` candidate opens the Line Item form pre-filled with the candidate's desc/supplier/cost/suggested-price; nothing is written to `DB.li` until the operator's own save completes; on save, the `DB.liPending` entry transitions to `'approved'` and the new catalogue record's `priceHistory` includes a `notes` entry naming the source Quote.
- **AC-10:** Approving an `'update'` candidate opens the existing Line Item's edit form with cost/price overwritten to the candidate's proposed values but every other field (sku, specs, dims, dg, etc.) left exactly as the existing record already has it.
- **AC-11:** Dismissing a candidate marks it `'dismissed'`, removes it from the active pending banner, and performs no write to `DB.li`.
- **AC-12:** `DB.liPending` is confirmed absent from `syncEnt()`'s entity list and from `pullAll()`/`pushAll()`'s sync entity lists — local-only, per Decision 5, mirroring the existing confirmed-absent test shape already used for `SS.webhookRules[]`.
- **AC-13:** `openPicker()`'s modal shows a search box; typing filters the same way `li-q` already does on the main tab; results are grouped under supplier-name headers, not one flat list.
- **AC-14:** `rLI()`'s main table groups rows under supplier-name headers while the existing `li-q`/`li-sf` filters continue to work unchanged underneath the new grouping.

## 4. Explicitly out of scope for v1

- No `DB.li` schema change, no Supabase migration (§1.3).
- No supplier requirement on quick-add for Pass-through/Charge lines (Decision 1).
- No automatic/unreviewed catalogue writes (Decision 2).
- No historical backfill of existing quick-add lines (Decision 3).
- No `saveLI()` refactor into a parameterized/non-DOM function (§1.1, §1.3).
- No promotion trigger at PO-conversion time (already covered via Quote-acceptance; §1.3).
- No Cloud Data sync for `DB.liPending[]` in this version (Decision 5).
- No Load Calculator, container-profile, or warehousing work (separate, already-scoped future items).

## 5. Open questions for independent review

None outstanding — all five genuine design forks (three operator-answered, two self-resolved and disclosed) are recorded in §1.2 before this draft was written.

## 8. Self-review log

- Checked whether `saveLI()` could be called programmatically before designing the promotion-approval flow around it — confirmed it cannot (fully DOM-form-coupled), and chose the pre-fill-the-real-form approach specifically because `CLAUDE.md` already documents the exact "mutate DB.li by id outside save*()/del*()" bug class this would otherwise risk reintroducing, rather than discovering that the hard way in review.
- Checked whether Quote lines carry a `sku` field before specifying the promotion matcher — confirmed they don't (`cQL`'s own shape has no `sku` key anywhere), so the matcher always uses the CSV importer's desc+supId fallback branch, never its sku branch; stated this explicitly rather than leaving an implementer to guess which branch applies.
- Checked `priceHistory[]`'s real shape and every existing use of its `invoiceRef` field before deciding where promotion provenance goes — confirmed `invoiceRef` is consistently invoice-shaped in every existing call site, and chose `notes` instead of overloading it, rather than silently repurposing a field whose name no longer matches its contents.
- Checked the exact existing `wasAccepted`/`isAccepted` computation in `saveQte()` before specifying the promotion trigger, to hook onto the real, already-correct "genuine transition" condition rather than approximating it with a status-equality check that could double-fire on every re-save of an Accepted quote.
- Considered whether promotion should also trigger at PO-conversion time (since that's an even firmer commitment signal than Quote acceptance) — concluded no, because `qteToPoConvert()` sources its lines from the Quote's own already-accepted lines, so a second trigger there would just queue the identical candidates a second time with no new information; disclosed this reasoning in §1.3 rather than silently picking one trigger point without explaining why the other was rejected.
