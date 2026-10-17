# REQ-LI-002 — Supplier-linked Line Item catalogue: stop silent data loss on quick-add, auto-queue catalogue promotion on Quote acceptance, and fix the picker/library UX

**Status:** v3 — revises v2 after independent requirements-gate review round 2 (confirmatory): **CONDITIONAL PASS**, 1 new blocking + 2 new advisory findings, all personally re-verified against live spec text before being accepted (§9b). Round 1's 5 blocking findings and all 3 advisories were independently re-confirmed RESOLVED by round 2. The 1 new blocking finding and both new advisories are fixed below. Not yet resubmitted.
**Type:** Entity-relationship + workflow feature, phased. Extends Invoice line items (`cIL`), `quickAddLine()`, `rILT()`, the Invoice form; extends `saveQte()` and `delQte()`; adds a new local-only top-level entity `DB.liPending[]` (fully wired per this codebase's own new-entity checklist — not a lightweight Settings field) and its UI; extends `openPicker()` and `rLI()`. No schema change to `DB.li` itself. No Supabase migration.

---

## 0. How this REQ came to be scoped this way

Operator asked, mid-conversation about an unrelated Shipment↔Invoice gap, to review the Line Items (product catalogue) feature for the same class of problem, and stated the governing principle directly: entities in this app should retain real, auditable relationships, not loosely-coupled text references, and the data model should be robust and scalable as the business grows. Direct code read found three concrete gaps (§1.1). The operator then ran this through this project's LLM Council (`docs/councils/README.md`) before deciding scope; the council verdict (reproduced in this session's transcript) was: fix Line Items as scoped, sequenced work now, don't block on a full app-wide review, but close the actively-destructive quick-add gap first, before anything else. The operator confirmed "proceed based on the feedback" and resolved three further scoping questions (§1.2) before v1 was drafted.

---

## 1. Business context

### 1.1 What exists today (check-first)

- **Gap 1 — nothing in the live quoting/ordering pipeline ever touches the catalogue.** Every `DB.li.push(...)` call site: `saveLI()` (`index.html:7948-7992`, entirely DOM-form-coupled), CSV import (`index.html:10929`, `index.html:11252`), and the one-time demo seed (`index.html:5584`). Nothing else.
- **Gap 2 — Invoice quick-add discards real pricing data and has no supplier field at all.** `quickAddLine()` (`index.html:8173-8194`) builds `cIL.push({ rid:uid(), lid:'', desc:desc, uom:uom, qty:qty, up:up, unitCost:uc, lineType:lt })` — no `supId` key anywhere. The quick-add form (`index.html:1202-1207`) has no supplier selector. `rILT()` (`index.html:8215-8254`) has no supplier column. The only existing gate, `invLineHasCostBasis(li)` (`index.html:8169-8172`), says nothing about supplier attribution. `vInv()` already has a save-time backstop reusing this same helper (`index.html:10672-10679`, confirmed by direct read) — the precedent this REQ's new supplier check (LI-002b) sits alongside.
- **Gap 3 — the "Import from Library" picker (`openPicker()`, `index.html:8255-8266`) has no search and no grouping**, unlike the main Line Items tab (`rLI()`, `index.html:7874-7910`), which already has `li-q`/`li-sf` (`index.html:291-292`) — just not visual grouping.
- **Line Items already require a supplier** (`vLI()`, `index.html:10611-10628`).
- **The CSV importer's existing Line Item match logic is the precedent to reuse** (`index.html:10915-10929`): match by `sku && supId` if a SKU is present, else by `desc.toLowerCase() === existing.desc.toLowerCase() && supId === existing.supId`. Quote lines never carry a `sku` (confirmed — `cQL`'s line shape built in `saveQte()`, `index.html:14202-14222`, has no `sku` key), so the promotion matcher (LI-002d) always uses the desc+supId fallback branch.
- **`saveQte()`'s real persistence sequence, read in full, changes where promotion-queueing can safely be inserted (round-1 finding 1 — corrected below).** `qt.id` is only the client-generated placeholder (`index.html:14252`, `EI.qt || uid()`) until the Cloud Data branch reassigns it to the real Supabase id (`index.html:14299`, `qt.id = qtResult.data.id;`) — and that branch can return early without ever reaching that line, on a cancelled login (`index.html:14280`) or a failed insert/update (`index.html:14298`). The existing code already solves exactly this problem for its own post-persist side effects: Contact-status conversion and Order-Request-stage advancement (`index.html:14311-14335`) are placed *after* both persistence branches complete, specifically so they use the real, finalized `qt.id`/`qt.num` and never run at all if the save failed or was cancelled — confirmed this is deliberate, not incidental, by the existing test proving the Supabase-assigned id (not the placeholder) is what gets used downstream (`tests/run.js:9487-9507`). **LI-002d's insertion point is corrected to the same place: after `index.html:14335`, as one more post-persist side effect, never before.**
- **`saveQte()`'s existing versioning loop already computes the exact per-line sell price this REQ needs — reuse it, don't recompute it (round-1 finding 2 — corrected below).** `index.html:14233-14235`: `var calcR = lineCalcs[i]; var effM = qteEffectiveMargin(l, markup); var sellP = +(calcR.landed * (1 + effM/100)).toFixed(2);` — `calcR.landed` already includes freight, DG surcharge, insurance, and duty (`cQteLine()`, `index.html:13823-13844`), not just raw cost. v1's formula (`cost * (1 + qteEffectiveMargin(line, quoteMarkup)/100)`) dropped all four of those and also referenced a variable, `quoteMarkup`, that doesn't exist in `saveQte()`'s scope — the real local variable (`index.html:14227`) is named `markup`. **LI-002d now captures the already-computed `sellP` per line (keyed by `rid`) during this existing loop and reuses it verbatim as `suggestedPrice` — no new formula, no risk of it diverging from what the Quote itself actually quoted.**
- **Quote currency and Line Item currency are independently selectable, and `openLI()` always resets to USD (round-1 finding 3 — corrected below).** `qf-cur` (`index.html:2773`-adjacent) offers USD/GBP/EUR/BBD; `lf-cur` (`index.html:1139`) offers USD/GBP/EUR/BBD/NGN/GHS — a superset, so every Quote currency is always a valid Line Item currency, but `openLI()` (`index.html:7930-7935`) unconditionally sets `G('lf-cur').value='USD'` regardless of context. A candidate sourced from a non-USD Quote, approved via `openLI()` unmodified, would silently mistag the catalogue record's currency.
- **This codebase's own documented convention for adding a new top-level entity, and v1's Decision 5 understated it (round-1 finding 5 — corrected below).** `CLAUDE.md`'s "Key coding conventions" section: "Adding a new top-level entity requires entries in: `K`, `DB`, `EI`, `saveAll`, `showV fns`, `renderAll`, `expAll snap`, `doImport entities`." Confirmed by direct read that today none of `K` (`index.html:3020`), `DB` (`index.html:3033`), `saveAll` (the `const saveAll = () => {...}` arrow function at `index.html:4335`, listing 12 `sv(K.x,...)` calls), or `expAll()`'s export snapshot (`index.html:13072-13097`) have any `liPending`/`lip` entry — and `tests/run.js`'s `resetDB()` (`tests/run.js:211-213`) has no `liPending: []` either. **v1's Decision 5 cited `SS.webhookRules[]` as precedent for "no extra wiring needed," but that field lives inside the already-wired `SS` settings object — a lighter-weight category than a genuine new top-level `DB.*` array with its own growing record set and resolved/unresolved lifecycle, which `DB.events[]` (an append-and-reference log, never Cloud-Data-synced either) is the more accurate precedent for.** This REQ now specifies the full wiring (LI-002e).
- **Deleting a Quote has no cascade awareness of anything queued from it (round-1 advisory 1).** `delQte()` (`index.html:14341-14368`) removes the Quote and reverts any converted Contact's status, but nothing else — a pending promotion candidate referencing a since-deleted `quoteId` would otherwise display against a dangling reference with no indication the source is gone.

### 1.2 Design decisions (resolved with the operator before drafting further)

**Decision 1 (operator-selected) — Quick-add's new supplier requirement applies to Product lines only.** Unchanged from v1.

**Decision 2 (operator-selected) — Catalogue promotion from a Quote fires on acceptance, and is review-gated, never silently automatic.** Unchanged from v1.

**Decision 3 (operator-selected) — Forward-only; no historical backfill.** Unchanged from v1.

**Decision 4 (this REQ's own, revised) — The suggested catalogue price on promotion is the exact, already-computed per-line Quote sell price (`sellP`), not a recomputed formula.** Corrected per round-1 finding 2 above — see §1.1. This is a *stronger* guarantee than v1's own stated intent ("a number the Quote already stood behind"): v1's formula approximated that number incorrectly; v2 reuses the literal value.

**Decision 5 (this REQ's own, revised) — `DB.liPending[]` is a fully-wired local-only top-level entity, not Cloud-Data-synced, and not modeled on `SS.webhookRules[]`.** Corrected per round-1 finding 5 above. "Not Cloud-Data-synced" (the genuinely load-bearing part of the original decision — nothing in this REQ's scope demands this queue survive a device switch mid-review) stands; the implied "therefore minimal wiring" does not, and is retracted. Full wiring is specified in LI-002e.

**Decision 6 (this REQ's own, disclosed, new in v2) — Candidate currency is captured and threaded through the Approve flow explicitly.** Per round-1 finding 3 — see LI-002e/LI-002f.

**Decision 7 (this REQ's own, disclosed, new in v2) — Queueing a `'new'` candidate checks already-pending candidates too, not just the live catalogue, to prevent duplicate-candidate creation when two Quotes for the same not-yet-catalogued desc+supId are both accepted before either is reviewed.** Per round-1 finding 4 — see LI-002d.

### 1.3 What this REQ deliberately does NOT do

- Does not change the `DB.li` record shape at all — no new fields on Line Item itself, no Supabase migration.
- Does not make quick-add require a supplier for Pass-through or Charge lines (Decision 1).
- Does not auto-write anything to the catalogue without an explicit operator approval action (Decision 2).
- Does not retroactively backfill supplier attribution on any existing invoice's quick-add lines (Decision 3).
- Does not refactor `saveLI()` into a parameterized, non-DOM function — the promotion-approval flow works by pre-filling the existing form instead, specifically to avoid introducing a second, parallel Cloud-Data-aware persistence path (same reasoning as v1, unchanged).
- Does not add promotion-on-acceptance for Purchase Orders — PO lines already source from an Accepted Quote's own lines, so a second trigger at PO-conversion time would just re-queue the same data with no new information (unchanged from v1).
- Does not touch the Load Calculator, container profiles, or any warehousing concept.
- Does not merge/link multiple pending candidates that happen to describe the same real item across different Quotes beyond the simple duplicate-prevention in Decision 7 — if a third, later Quote also targets the same not-yet-reviewed desc+supId, it is likewise skipped (not merged, not tracked as "3 sources"); the first-queued candidate is still the only one surfaced, and approving it is unaffected by how many Quotes would have produced the same suggestion. Tracking multiple source Quotes per candidate is a disclosed, deliberate non-goal — it would add real complexity for a case (the exact same unreviewed item quoted three times before anyone looks at the queue) that isn't the common path this REQ is built for.

---

## 2. Requirements

### LI-002a — Quick-add gains a required-for-Product supplier field
Unchanged from v1: new `qal-sup` `<select>` on the quick-add form; `quickAddLine()` reads it into a new `supId` key on the pushed `cIL` object; new shared helper `invLineHasSupplier(li)` mirroring `invLineHasCostBasis()`'s exact shape, gating only `lineType==='product'` quick-adds.

### LI-002b — `vInv()`'s save-time backstop extended, mirroring the existing cost-basis pattern exactly
Unchanged from v1 — confirmed in round 1 that `vInv()`'s existing cost-basis backstop (`index.html:10672-10679`) is real and is the precedent being extended, not an assumption.

### LI-002c — `rILT()` gains a supplier column, editable, rendered for every line type
Unchanged from v1, plus two corrections closing round-1 advisories 2 and 3:
- **AC-2b (new)** explicitly tests that the column renders (editable, unenforced) for a Pass-through/Charge line too, not only Product — closing the gap where v1's ACs only ever exercised the Product case.
- `rILT()`'s empty-state placeholder row (`index.html:8217`, `colspan="10"`) is updated to `colspan="11"` to match the new column count — a one-line, easy-to-miss detail v1 never mentioned.

### LI-002d — `saveQte()` queues eligible lines for catalogue review, after persistence completes, using the real sell price, with duplicate-candidate protection
**Insertion point (corrected — round-1 finding 1):** immediately after `index.html:14335` (after both the Cloud Data and local persistence branches, and after the existing Contact/Order-Request post-persist side effects), gated on the `isAccepted && !wasAccepted` booleans already computed earlier (`index.html:14249-14250` — still valid references, since persistence doesn't change them). Placed here, the logic automatically inherits the same correctness the existing Contact/Order-Request side effects already have: it never runs if the save failed or was cancelled (both early-return paths exit before this point), and it always has the real, finalized `qt.id`/`qt.num`/`qt.currency`.

**Per-line sell price (corrected — round-1 finding 2):** inside the existing versioning loop (`index.html:14229-14241`), capture `sellP` into a `rid`-keyed map (e.g. `var sellPByRid = {}; ...; sellPByRid[l.rid] = sellP;` added to the loop body) rather than letting it go out of scope — the promotion-queueing logic reads from this map, never recomputing it.

**Matching and queueing, for each line with a non-blank `supId`:**
1. Resolve a catalogue match using the CSV importer's own desc+supId fallback (`index.html:10915-10929`) against live `DB.li` — same comparison, exactly: `desc` compared case-insensitively (`.toLowerCase()` both sides), `supId` compared exactly.
2. Match found, cost and `sellPByRid[l.rid]` both already agree with the existing record → nothing queued.
3. Match found, either differs → **(corrected — round-2 finding, closes new blocking finding on `'update'` dedup)** check `DB.liPending` for an existing `status:'pending'`, `kind:'update'` entry with the same `matchedLiId`; if one already exists, queue nothing (a second proposed update to the same not-yet-reviewed record would only leave the review banner showing two competing, increasingly stale proposals — resolving the first is always the more current one in any ambiguous case); otherwise queue an `'update'` candidate referencing the matched id.
4. No match in `DB.li` → check `DB.liPending` for an existing `status:'pending'`, `kind:'new'` entry with the same `desc`+`supId`, **using the identical case-insensitive-desc/exact-supId comparison as step 1** (round-2 finding — v2 left this comparison unspecified, risking a differently-cased duplicate slipping past the exact check this REQ exists to add); if one already exists, queue nothing; otherwise queue a `'new'` candidate.
Lines with a blank `supId` are skipped entirely.

**Disclosed non-goal (new in v3, closes round-2 advisory 1): a dismissed candidate is never automatically re-queued, even for the same Quote.** Because the trigger is the genuine one-time `isAccepted && !wasAccepted` transition (AC-7), a Quote cannot normally re-fire queueing for its own lines without first leaving and re-entering Accepted status. If the operator dismisses a candidate and later decides the item should be catalogued after all, the existing manual `saveLI()` path remains available — this REQ does not add a "reconsider a dismissed candidate" mechanism, the same deliberate scope boundary Decision 7 already draws around multi-source tracking. A *different* Quote later targeting the same desc+supId for the first time is unaffected and queues normally (the dup-check in steps 3/4 only ever blocks on still-`'pending'` entries, never on `'dismissed'` ones).

### LI-002e — New local-only top-level entity: `DB.liPending[]`, fully wired (corrected — round-1 finding 5)
```js
{ id: uid(), status: 'pending', kind: 'new'|'update', matchedLiId: null|<id>,
  quoteId, quoteNum, supId, desc, uom, cost, suggestedPrice, currency,
  createdAt: new Date().toISOString() }
```
`currency: qt.currency` (closes round-1 finding 3's first half — captured at queue time, not left for the Approve flow to guess). Full wiring, per `CLAUDE.md`'s own new-top-level-entity checklist (§1.1):
- `K.lip: 'st_lip'` added to the `K` object (`index.html:3020`-adjacent).
- `DB.liPending: ldArr(K.lip)` added to the `DB` init object (`index.html:3033`-adjacent).
- `sv(K.lip, DB.liPending)` added inside `saveAll()` (`index.html:4335`).
- `liPending: DB.liPending` added to `expAll()`'s export snapshot (`index.html:13072-13097`) — so a backup/restore cycle preserves the queue, including resolved history, exactly as LI-002e's own "kept, not deleted" rule for `'approved'`/`'dismissed'` entries requires.
- `liPending: []` added to `tests/run.js`'s `resetDB()` (`tests/run.js:211-213`).
- No `EI.lip` entry — there is no single "currently editing" concept for this entity the way Quotes/Invoices have one; the review UI (LI-002f) operates on the list directly.
- Confirmed absent from `syncEnt()`'s entity list and `pullAll()`/`pushAll()`'s sync entity lists (AC-12, unchanged from v1) — "not Cloud-Data-synced" is still correct and still the point of Decision 5; only the "therefore minimal local wiring" half was wrong.

### LI-002f — Review UI: a banner on the Line Items tab, Approve opens the real form pre-filled (now currency-aware), Dismiss just marks it done
Unchanged from v1's core mechanism, plus the currency fix: Approve sets `G('lf-cur').value` from the candidate's own `currency` field *after* calling `openLI()`/`editLI()` (both of which would otherwise leave or reset it to USD) and *before* the operator sees the form, so the pre-filled form never silently shows the wrong currency. Everything else (pre-fill desc/supplier/cost/suggested-price for `'new'`; pre-fill only cost/price for `'update'`, leaving every other field as the existing record's own data; mark `'approved'` on successful save; `notes` entry naming the source Quote; Dismiss marks `'dismissed'` with a confirm() naming the candidate's description) is unchanged from v1.

### LI-002g — `delQte()` cascades to pending candidates (new — closes round-1 advisory 1)
`delQte(id)` (`index.html:14341-14368`) additionally removes any `DB.liPending` entries with `quoteId === id` and `status === 'pending'` — `'approved'`/`'dismissed'` entries are left untouched (they already served their review purpose and are kept as resolved history, same as LI-002e's own rule; deleting the source Quote afterward doesn't retroactively make a past review decision meaningless). This prevents the review banner from ever displaying a candidate against a Quote that no longer exists.

### LI-002h — `openPicker()` gains search + supplier grouping
Unchanged from v1.

### LI-002i — `rLI()` (the main Line Items tab) groups rows by supplier
Unchanged from v1 (renumbered from LI-002h to LI-002i to make room for LI-002g above).

---

## 3. Acceptance criteria

- **AC-1:** `quickAddLine()` with `lineType:'product'` and no supplier selected is blocked with a toast; Pass-through/Charge lines are never blocked on this.
- **AC-2:** A Product line added via quick-add with a real supplier persists `supId` on the `cIL` object, visible and editable in `rILT()`'s new supplier column.
- **AC-2b (new):** The same supplier column renders (editable, not enforced) for a Pass-through and a Charge line.
- **AC-3:** `vInv()` refuses to save an invoice containing a Product line with no supplier and no catalogue link, even if it passed quick-add's own gate and was later edited to clear the supplier directly in `rILT()`.
- **AC-4 (corrected):** Accepting a Quote (`isAccepted && !wasAccepted`, evaluated only after persistence succeeds) with one line whose desc+supId matches no existing catalogue entry and no existing pending candidate queues exactly one `'new'` candidate in `DB.liPending`, with `suggestedPrice` equal to that line's own already-computed `sellP` (not a recomputed formula) and `currency` equal to the Quote's own currency.
- **AC-4b (new):** The same acceptance, but with Cloud Data configured and the insert cancelled (simulated failed `ensureSbAuth()`), queues nothing — proving the insertion point only fires after persistence genuinely succeeds.
- **AC-5:** Accepting a Quote with a line matching an existing catalogue entry where cost and `sellP` both already agree queues nothing.
- **AC-6:** Accepting a Quote with a line matching an existing catalogue entry whose stored cost or price differs queues exactly one `'update'` candidate referencing that record's id.
- **AC-7:** Re-saving an already-Accepted Quote (no status change) queues nothing.
- **AC-8:** A Quote line with a blank `supId` is never queued.
- **AC-8b (new):** Two different Quotes, accepted in sequence, both containing a line with the identical desc+supId that matches no existing catalogue entry — the second acceptance queues nothing additional while the first candidate is still `'pending'`, proving the duplicate-candidate guard (Decision 7).
- **AC-8c (new — round-2 finding):** Same as AC-8b, but the two descs differ only by case (e.g. `"Steel Bracket"` vs `"steel bracket"`) — still queues nothing additional on the second acceptance, proving the dup-check reuses step 1's case-insensitive comparison rather than an exact-match check that casing could slip past.
- **AC-8d (new — round-2 finding):** Two different Quotes, accepted in sequence, both containing a line matching the *same* existing catalogue entry with a differing cost/price — the second acceptance queues no additional `'update'` candidate while the first is still `'pending'`.
- **AC-9:** Approving a `'new'` candidate opens the Line Item form pre-filled with the candidate's desc/supplier/cost/suggested-price/**currency**; nothing is written to `DB.li` until the operator's own save completes; on save, the `DB.liPending` entry transitions to `'approved'` and the new record's `priceHistory` names the source Quote in `notes`.
- **AC-10:** Approving an `'update'` candidate opens the existing Line Item's edit form with cost/price/**currency** overwritten to the candidate's proposed values but every other field left exactly as the existing record already has it.
- **AC-11:** Dismissing a candidate marks it `'dismissed'`, removes it from the active pending banner, performs no write to `DB.li`.
- **AC-12:** `DB.liPending` is confirmed absent from `syncEnt()`'s entity list and from `pullAll()`/`pushAll()`'s sync entity lists.
- **AC-12b (new):** `expAll()`'s export snapshot includes `liPending`; `saveAll()` persists it; `resetDB()` in the test suite initializes it to `[]`.
- **AC-13:** `delQte()` on a Quote with one `'pending'` liPending entry and one already-`'approved'` liPending entry removes only the pending one; the approved one survives.
- **AC-14:** `openPicker()`'s modal shows a search box; typing filters the same way `li-q` already does; results are grouped under supplier-name headers.
- **AC-15:** `rLI()`'s main table groups rows under supplier-name headers while the existing `li-q`/`li-sf` filters continue to work unchanged underneath.

## 4. Explicitly out of scope for v3

Unchanged from v1 (§1.3), plus: no multi-source tracking for a candidate that would have been queued by more than one Quote before review (Decision 7 / §1.3); no automatic re-queueing of a dismissed candidate, for the same Quote or otherwise (§2, LI-002d's disclosed non-goal, new in v3).

## 5. Open questions for independent review

None outstanding.

## 8. Self-review log (v3, post-round-2)

- Re-verified round 2's one new blocking finding (step 4's dup-check never specifying it reuses step 1's case-insensitive comparison) by re-reading my own v2 spec text directly — confirmed step 4 said only "the same `desc`+`supId`" with no comparison rule stated, while step 1 explicitly specifies case-insensitive desc / exact supId; a literal implementer would have had no reason to assume the two should match.
- Re-verified round 2's two new advisory findings the same way: confirmed step 3 (`'update'` kind) had no dedup logic of any kind in v2, and confirmed the `isAccepted && !wasAccepted` one-shot trigger genuinely means a dismissed candidate is never automatically reconsidered for that same Quote, a real but narrower gap than "permanently un-queueable" (a different Quote still queues normally).
- Chose to extend the *same* dup-check mechanism to `'update'` candidates (keyed on `matchedLiId`) rather than inventing a second mechanism — consistent with not having two different dedup strategies in one function for no reason.
- Chose disclosure over a new reconsideration mechanism for the dismissed-candidate gap, for the same reason Decision 7's multi-source non-goal was disclosed rather than built: this REQ's job is to stop the Quote-to-catalogue signal from being silently generated and then overwritten with no review step, not to build a complete re-triage workflow for an operator's own dismiss decisions — the existing manual `saveLI()` path already covers "I changed my mind later."
- Did not re-litigate round 1's own five blocking findings or three advisories — round 2 independently re-confirmed all eight resolved, and this v3 revision touches only the one mechanism (duplicate-candidate dedup) round 2 found incompletely specified, plus its own newly-surfaced `'update'`-kind gap.

## 9. Independent review round 1 — verdict FAIL, all findings personally re-verified and fixed (reproduced for history)

**Blocking:**
1. LI-002d's insertion point (immediately after `isAccepted && !wasAccepted` is computed, before `qt` is even built or persisted) would queue candidates for Quotes whose save then fails or is cancelled, and would read `qt.id`/`qt.num` before either is finalized. **Fixed:** moved to after `index.html:14335`, mirroring the existing Contact/Order-Request post-persist side effects' own placement exactly.
2. The suggested-price formula dropped freight/duty/insurance/DG (used `cost` alone, not `landed`) and referenced a nonexistent variable (`quoteMarkup` instead of `markup`). **Fixed:** reuses the already-computed `sellP` verbatim instead of recomputing anything.
3. Quote currency and Line Item currency are independently selectable; `openLI()` always resets to USD; the Approve flow never set a currency. **Fixed:** `currency` captured on the candidate at queue time, threaded through the Approve flow explicitly.
4. Two Quotes accepted in quick succession, both proposing the same not-yet-catalogued desc+supId, could each queue a `'new'` candidate, risking a duplicate `DB.li` record if both were approved. **Fixed in v2, refined further in v3 (see §9b):** queueing now checks already-pending candidates, not just the live catalogue, before creating a `'new'` one.
5. `DB.liPending` was never wired into `K`/`DB`/`saveAll`/`expAll`/the test suite's `resetDB()` — v1's Decision 5 cited a precedent (`SS.webhookRules[]`) that is a lighter-weight Settings field, not a comparable new top-level entity. **Fixed:** full wiring specified; Decision 5 corrected to retract the "minimal wiring" implication while keeping the still-correct "not Cloud-Data-synced" half.

**Advisory, also fixed:**
1. `delQte()` had no cascade awareness of `DB.liPending` entries referencing the deleted Quote. **Fixed:** LI-002g, new cascade removing only still-`'pending'` entries.
2. LI-002c's "rendered for every line type" claim had no AC exercising a non-Product line. **Fixed:** new AC-2b.
3. `rILT()`'s empty-state `colspan="10"` wasn't updated for the new 11th column. **Fixed:** explicit note in LI-002c.

## 9b. Independent review round 2 (confirmatory) — verdict CONDITIONAL PASS, 1 new blocking + 2 new advisory, personally re-verified and fixed

Round 1's 5 blocking findings and all 3 advisories independently re-confirmed RESOLVED by this round, via fresh reads of `saveQte()`, `cQteLine()`, the currency selects, and the five entity-wiring locations — not relitigated here.

**New blocking finding:** v2's step 4 (the `'new'`-candidate dup-check) never specified reusing step 1's case-insensitive desc comparison, risking a differently-cased duplicate slipping past the very check this REQ added to prevent duplicates. **Fixed:** step 4 now explicitly states it uses the identical comparison as step 1; new AC-8c tests the casing case directly.

**New advisory findings, also fixed:**
1. The dup-check only ever covered `'new'` candidates; `'update'` candidates had no analogous protection, so two Quotes proposing different cost/price updates to the same existing record could each queue a redundant, potentially-conflicting `'update'` candidate. **Fixed:** step 3 now applies the identical dedup pattern, keyed on `matchedLiId`; new AC-8d tests this directly.
2. A dismissed candidate is never automatically re-queued, even for the same Quote, and this wasn't disclosed anywhere. **Fixed:** new explicit disclosed non-goal in LI-002d and §4, parallel to Decision 7's existing multi-source disclosure.
