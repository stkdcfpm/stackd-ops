# REQ-QTE-004 — Link Quote lines to existing Line Items (catalogue-assisted line entry)

**Status:** v1 DRAFT — not yet through the requirements-gate.
**Type:** Feature. No Supabase migration (all new data rides inside the existing `lines` jsonb on quotes). `index.html`, `AI_SYSTEM_PROMPT`, `docs/user-guide.md`.
**Decisions already made by the operator (2026-11-27):** purpose = faster line entry; cost is a SNAPSHOT at link time with a drift badge; only USD / GBP / BBD costs convert, any other currency is blocked with "enter cost manually"; draft now (does not wait for LI-GAP-007).

---

## 1. Business context

Invoices already let the operator pull a catalogue item into a line (`openPicker()`/`doPick()`, `index.html:8661-8697`, which writes `lid` onto the invoice line). Quotes do not: every quote line is typed by hand (`addQteLine()`, `index.html:14833`) — supplier, description, UOM, cost, CBM, DG — even though the catalogue already holds all of those for repeat products. Repeat orders for the same products are expected, so this is re-keying of data that exists and a source of typo drift between catalogue and quote.

### 1.1 What the catalogue can and cannot supply

| Quote line field | From Line Item? | Rule |
|---|---|---|
| Supplier (`supId`) | Yes | `li.supId` |
| Description (`desc`) | Yes | `li.desc` |
| UOM (`uom`) | Yes | `li.uom` |
| Cost (USD) | Yes, converted | `li.cost` in `li.cur`; converted to USD only if `li.cur` is USD, GBP or BBD (§3 REQ-QTE4-004) |
| DG (`dg`) | Yes | `li.dg` |
| CBM (`cbm`, line TOTAL) | Yes, if `li.dims` | `(l×w×h/1,000,000) × qty`; recomputed when Qty changes (§3 REQ-QTE4-005) |
| Duty % | **No** | Stays manual. The catalogue has no duty field; HS code is not a rate. |
| Catalogue sell price | **No (reference only)** | Shown as a hint; never used as the quote's price — the quote engine prices from landed cost + markup (`cQteLine`, `index.html:14655`). |

### 1.2 Out of scope

- Any change to the pricing chain (`cQteLine`, markup, insurance, overhead).
- Backfilling or relinking existing quotes. Existing quotes are unchanged.
- Following the catalogue live (cost is a snapshot — decided).
- Currencies other than USD/GBP/BBD (blocked, not converted — `toGBP()`/`fromGBP()` silently return the amount unconverted for anything else, `index.html:5620-5638`, which is exactly the trap this REQ must not walk into).
- Cloud Data schema change (none needed — see §5).
- Quote → Line Item writes (the existing Quote-acceptance promotion queue stays; only its matching changes, REQ-QTE4-009).

---

## 2. Pre-existing defect this feature depends on (must be fixed in scope)

`addQteLine()` and `removeQteLine()` push/filter `cQL` and call `rQLT()`, which rebuilds every input from `cQL` values (`index.html:14833-14856`). The inputs' `oninput` handlers call only `calcQte()`, which reads the DOM through `qlFld()` (`index.html:14817`, `14945`) and **never writes back to `cQL`**. So after the operator types into a line and then clicks "+ Add Line" (or removes another line), the re-render rebuilds from stale `cQL` and **discards the unsaved typing in every other line**. (Found by code reading; to be reproduced by a test before being treated as confirmed — REQ-QTE4-010.)

Linking a catalogue item will re-render the grid, so it would hit this bug on every use. Therefore: before ANY grid re-render triggered by add / remove / link / unlink, the live DOM values must be synced into `cQL`.

---

## 3. Requirements

**REQ-QTE4-001 — "Add from catalogue" entry point.** The Quote line area gets an "Add from Catalogue" button beside "+ Add Line" (`index.html:2974`). It opens a picker listing Line Items with search (desc/SKU) and supplier grouping, reusing the same list-rendering conventions as `rPickList()` (`index.html:8668`). Selecting one or more items appends one quote line per item. Hand-typed "+ Add Line" keeps working unchanged.

**REQ-QTE4-002 — Picker is shared without regressing invoices.** The existing picker is invoice-specific (`cIL`, `addILI`, "✓ on this invoice", `doPick()`'s call). It must be generalised (a context/mode parameter or a sibling function) so the invoice flow's behavior and existing tests are unchanged. The quote picker marks items already linked on the current quote ("✓ on this quote").

**REQ-QTE4-003 — Fields filled on link.** A linked line is created with supplier, description, UOM, cost (USD), DG and CBM per §1.1; qty defaults to 1; duty % 0 (manual); markup/insRate overrides blank (inherit). Each is still individually editable afterwards (operator may override cost, etc. — editing a field does NOT unlink the line).

**REQ-QTE4-004 — Currency conversion, three currencies only.** Cost converts to USD using the same stored rates the rest of the app uses (`QR.fxGBPUSD`, `QR.fxGBPBBD`): USD ×1; GBP ×`fxGBPUSD`; BBD ÷`fxGBPBBD`×`fxGBPUSD`. If `li.cur` is anything else (EUR, NGN, GHS, RMB, blank, unknown) the item **is shown in the picker but cannot be added**: the row is disabled with the text "Cost is in <cur> — enter manually". It must NOT be added with an unconverted number. Blank/missing `li.cur` is treated as not convertible, not as USD. A catalogue cost of 0/blank links with cost 0 and shows a warning that no cost basis exists (mirrors `invLineHasCostBasis`).

**REQ-QTE4-005 — CBM from dimensions, per qty.** When `li.dims` has l, w and h, line `cbm` = `(l×w×h/1,000,000) × qty` (dims are cm per unit, same formula as `calcLICBM()`, `index.html:8195`; `cbm` on a quote line is the TOTAL for the line, not per unit). Changing Qty on a linked line recomputes CBM **only while the CBM field has not been manually overridden** by the operator; once overridden it is left alone. If `li.dims` is absent, CBM is left 0 and unflagged. (This is a deliberate asymmetry to be tested explicitly: auto-recompute until touched, then manual wins.)

**REQ-QTE4-006 — Link identity and snapshot persisted.** A linked line stores `lid` (the Line Item id) plus a snapshot `{lidCost, lidCur, lidCostUSD, lidAt}` (catalogue cost and currency at link time, converted USD cost, ISO timestamp). `saveQte()` builds each saved line from a whitelist literal (`index.html:15031`, which today carries only supId/desc/qty/uom/cost/cbm/dg/dutyPct/markup/insRate plus the three `sourceOrd*`/`sourceRfq*` fields) — it **must carry `lid` and the snapshot fields forward**, and `editQte()`'s `Object.assign` copy (`index.html:14786-14790`) already preserves unknown fields into `cQL`. Absent on every pre-existing line (= "not linked"). Unlinked lines never get the keys (omit, do not write `undefined`).

**REQ-QTE4-007 — Drift badge.** For a linked line whose Line Item still exists, if the catalogue's current cost (converted the same way) differs from `lidCostUSD` the grid shows an amber badge "Catalogue cost changed since quoted: was $X, now $Y". Comparison on a tolerance (1/1000 of a USD), not float equality. The badge is informational: it never changes the quote's cost. A "Refresh cost" action on the badge re-snapshots (updates cost field, snapshot) only on explicit click. If the Line Item has been deleted, the line shows "Catalogue item removed" and is otherwise a normal editable line (see REQ-QTE4-008). If the item's currency has since changed to a non-convertible one, the badge reads "Catalogue currency changed to <cur> — review manually" and Refresh is disabled.

**REQ-QTE4-008 — Delete protection.** `delLI()` (`index.html:8281`) already warns about invoices/POs/pending suggestions; it must also count and warn about quotes whose lines reference the item (`lid`). Deleting proceeds as today on confirm and leaves `lid` in place on those lines as a historical reference (same precedent as `delSup()`'s Supplier warning); the grid handles a dangling `lid` per REQ-QTE4-007. Supabase: `delLI()` Cloud-Data branch must behave identically (count from local `DB.qt`).

**REQ-QTE4-009 — Promotion queue matches by link.** `saveQte()`'s Accepted-quote promotion logic (v2.9.90, `index.html:15170-15210`) currently matches existing catalogue items by exact `desc`+`supId`. For a line carrying a valid `lid` it must match by `lid` (so an operator editing the description on a linked line does not spawn a duplicate "new item" suggestion); unlinked lines keep the existing desc+supId matching exactly. A `'update'` suggestion for a linked line compares against the snapshot-vs-quoted cost the line actually carries.

**REQ-QTE4-010 — Grid state survives re-render (the §2 fix).** Before `addQteLine()`, `removeQteLine()`, the new link action, "Refresh cost", and unlink re-render the grid, current DOM values for every line are read into `cQL` (a single shared `syncQLFromDOM()`), including per-line `markup`, `insRate`, `note`, `cbm` override state. Test: type into line A, click Add Line → line A's typed values are still present (this test must FAIL on today's code first, proving the defect).

**REQ-QTE4-011 — Unlink.** A linked line has an "Unlink" action that removes `lid` and the snapshot keys (line becomes an ordinary hand-typed line; values unchanged).

**REQ-QTE4-012 — Downstream behavior.** (a) `qteToPoConvert()` (`index.html:15530`) currently writes `lid:''` and `sku:''` on every PO line; for a linked quote line it must carry `lid` and the catalogue SKU so the PO's catalogue link is real (PO drift detection and `delLI()` PO scanning key on it); unlinked lines unchanged. (b) `prevQteDoc()` must not print the snapshot/drift fields or the "Catalogue" badges — the customer-facing quote document is unchanged. (c) `renderQteSourceDriftWarn()` (`index.html:15730`) and the price-history versioning on `saveQte()` (cost/dutyPct/markup/insRate triggers) are unchanged; a Refresh-cost click that changes `cost` versions the line exactly like a manual edit does.

**REQ-QTE4-013 — Cloud Data.** No schema change: `lid` and snapshot keys live inside the existing `lines` jsonb. `migrateQteToSupabase()`'s Line-Item-id sweep of `ql.lid` already exists (`index.html` ~7075); it must also remap quote lines' `lid` when Line Items migrate AFTER quotes (or the reverse) — confirm by test that both orders leave a valid `lid`, and that a quote line's snapshot is never touched by the sweep. Quote round-trip through `refreshQteFromSupabase()` preserves `lid`/snapshot keys and does not add them to unlinked lines (assert the key is absent, not `undefined`).

**REQ-QTE4-014 — Docs and assistant.** `AI_SYSTEM_PROMPT` describes the feature in accurate terms (avoid apostrophes in single-quoted strings — known harness trap); `docs/user-guide.md` Quotes section documents Add from Catalogue, the three-currency rule, the CBM rule, the drift badge and Refresh/Unlink; version strings, changelog and CLAUDE.md per the delivery checklist.

---

## 4. Acceptance criteria (testable)

1. AC-1: Link an item priced in USD → line has supplier/desc/uom/cost/dg and `lid`, snapshot present.
2. AC-2: GBP item → cost = cost × `QR.fxGBPUSD`; BBD item → cost ÷ `fxGBPBBD` × `fxGBPUSD`; both asserted to 4 dp against hand-computed numbers.
3. AC-3: EUR / NGN / GHS / RMB / blank-currency item → picker row disabled, cannot be added, nothing appended to `cQL`.
4. AC-4: Item with dims 50×40×30 cm, qty 10 → cbm = 0.6; change qty to 20 → 1.2; type 0.9 into CBM, change qty to 30 → stays 0.9.
5. AC-5: Item with no dims → cbm 0, no warning.
6. AC-6: Save and reopen a quote with a linked line → `lid` and all four snapshot keys survive (`saveQte()` whitelist); unlinked line has none of those keys (`'lid' in line === false`).
7. AC-7: Change the catalogue cost after linking → badge shows; difference below 0.001 USD → no badge; Refresh updates cost + snapshot and creates a price-history version; without clicking Refresh the quote cost never changes.
8. AC-8: Delete the Line Item → `delLI()` confirm text includes the quote count; after delete the line shows "Catalogue item removed" and still saves.
9. AC-9: Accept a quote whose linked line's description was edited → no `'new'` promotion candidate; an unlinked line with the same edit still queues one (existing behavior).
10. AC-10: Type in line A, click Add Line / Remove another line / Link an item → line A's values (cost, qty, markup override, ins override, note) unchanged. Fails on current code.
11. AC-11: Convert a quote with a linked line to a PO → PO line carries `lid` and `sku`; unlinked line carries `''` as today.
12. AC-12: `prevQteDoc()` output for a quote with a drifted linked line contains no drift/snapshot text.
13. AC-13: Existing invoice picker tests pass unmodified; invoice picker behavior byte-identical.
14. AC-14: Cloud Data: round-trip through insert/refresh preserves `lid` and snapshot; unlinked lines remain key-less; both migration orders leave a resolvable `lid`.
15. AC-15: Full suite green; no regression of the 1194 existing tests (any test touched is listed in the SPEC).

---

## 5. Data flow / GDPR

No new personal data. Catalogue costs and supplier ids already live in the same browser store and (if migrated) the same Supabase tables; the snapshot is derived pricing data inside an existing jsonb column. No new external transmission, no new webhook payload field (the quote is not part of the `inv_buyer_approved` webhook). Local backup/restore and Sheets sync: `DB.qt` is unchanged in shape except additive optional line keys; the existing Quote Sheets mapping ignores unknown line keys (SPEC to confirm by citation).

## 6. Risks and challenges to the plan (stated plainly)

1. **Snapshot goes stale by design.** The drift badge only fires if the operator opens the quote; a sent/accepted quote is not revisited. That is acceptable only because the quote is a point-in-time offer — say so in the user guide.
2. **Multi-currency is a hard wall, not a convenience.** If most of the catalogue is not USD/GBP/BBD, the feature is mostly disabled rows. SPEC step 0: count the real catalogue by currency before building. If the answer is "mostly RMB", the three-currency decision should be revisited (RMB rate exists in `QR.fxGBPRMB`) — an operator call, not an assumption.
3. **CBM auto-recompute vs manual override** is the likeliest place for a subtle bug; AC-4 pins it.
4. **The §2 defect** may already be silently costing typed data today; the fix has value even if linking were cancelled.
5. **Mutation tests required** for: the whitelist carry-forward, the currency block, and the DOM-sync-before-render (each reverted in a scratch copy, the exact predicted test must fail).

## 7. Open questions for the gate

- Is Refresh-cost allowed on an Accepted/locked quote? (Draft default: yes, with the same status rules as any cost edit — gate to confirm `saveQte()` has no accepted-lock.)
- Should "Add from Catalogue" be able to add multiple items at once (checkbox list, as invoices do)? Draft default: yes.
