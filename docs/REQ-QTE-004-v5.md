# REQ-QTE-004 — Link Quote lines to existing Line Items (catalogue-assisted line entry)

**Status:** v5 — confirmatory resubmission after requirements-gate round 4 (CONDITIONAL PASS, no blocking findings; 2 should-fix, 2 advisory). Maps: round 1 §8, round 2 §9, round 3 §10, round 4 §11.
**Type:** Feature. No Supabase migration (all new data rides inside the existing `lines` jsonb on quotes). `index.html`, `AI_SYSTEM_PROMPT`, `docs/user-guide.md`, comments/tests listed in §7.
**Operator decisions (2026-11-27):** purpose = faster line entry; cost is a SNAPSHOT at link time with a drift badge; quote currency stays a label and cost stays USD ("option A"); USD/GBP/BBD convert from stored rates, **every other currency is not blocked but requires a manually entered USD rate at link time**; the rate and date used are recorded on the line; no historic-rate lookup and no automatic recalculation (snapshot stays fixed); hand-typed lines can be linked after the fact.

---

## 1. Business context

Invoices let the operator pull a catalogue item into a line (`openPicker()`/`doPick()`, `index.html:8661-8697`, writing `lid`). Quotes do not: every quote line is typed by hand (`addQteLine()`, `index.html:14833`) even though the catalogue already holds supplier, description, UOM, cost, DG and dimensions for repeat products. Repeat orders for the same products are expected; this is re-keying of data that exists, and a source of drift between catalogue and quote.

### 1.1 The quote engine's cost basis (established by round 1, drives the design)

`cQteLine()` (`index.html:14655`) uses `line.cost` as-is: freight is `cbm × lclPerCBM`, insurance is `(cost+freight)×rate`, landed adds duty on `cost`. **`qty` never enters the calculation** — neither in `cQteLine()`, `qteSellTotals()` (`14692`) nor `prevQteDoc()` (qty is printed only). Therefore on a Quote line `cost` is, in effect, the **line total in USD**, and `cbm` is the **line total CBM**. (The catalogue `li.cost` is per UOM unit.) Both totals must therefore scale with qty for a linked line, or the quote under-prices landed cost (REQ-QTE4-003/005).

### 1.2 What the catalogue can and cannot supply

| Quote line field | From Line Item? | Rule |
|---|---|---|
| Supplier (`supId`) | Yes | `li.supId` if it resolves to an existing Supplier, else blank + warning (REQ-QTE4-012) |
| Description, UOM | Yes | `li.desc`, `li.uom` |
| Cost (USD, line total) | Yes, converted | unit cost × USD-per-native rate × qty (REQ-QTE4-003/004) |
| DG | Yes | `li.dg` |
| CBM (line total) | Yes, if `li.dims` | per-unit CBM × qty (REQ-QTE4-005) |
| Duty % | **No** | Stays manual (catalogue has no duty rate) |
| Catalogue sell price | **No** | Shown for reference in the picker only; quote prices from landed cost + markup |

### 1.3 Out of scope

- Any change to the pricing chain (`cQteLine`, markup, insurance, overhead) or to what the quote-level Currency field does.
- Backfilling/relinking existing quotes in bulk (an operator may link a single existing line by hand — REQ-QTE4-011).
- Following the catalogue live (snapshot — decided).
- Historic FX lookup / automatic recalculation. Today the app has no historic-rate store (`QR` holds single global rates, `fetchLiveRates()` pulls current rates only; same root as MTD-GAP-002). The recorded rate+date on each line is what makes a later recalculation possible; building it is a separate REQ.
- Writes from Quote back to the catalogue other than the existing review-gated promotion queue.
- Pre-existing issues disclosed, not fixed here: (a) unlinked-line promotion compares a line-total cost with a per-unit catalogue cost (`index.html:15184`); (b) `qteToPoConvert()` copies line `cost` onto a PO line as if per-unit and labels it with the quote's currency label (`index.html:15560-15565`); (c) `ordConvertToQuote()` fills line costs in the quote's own currency under a "Cost (USD)" column (`index.html:3640-3648`). All three are logged as new gaps (§7) rather than silently inherited.

---

## 2. Pre-existing defect this feature depends on (fixed in scope)

`addQteLine()`/`removeQteLine()` push/filter `cQL` and call `rQLT()`, which rebuilds every input from `cQL` (`index.html:14833-14856`). Input handlers call only `calcQte()`, which reads the DOM through `qlFld()` (`14817`, `14945`) and never writes back to `cQL`. After typing into a line and then adding/removing another, the re-render rebuilds from stale `cQL` and discards the typing. Fields with **no** sync at all: `desc`, `uom`, `dg`, `supId` (no `oninput` reaches `cQL`); the Version-note input is rendered with no `value` attribute at all (`index.html:14883`), so it can never be preserved by a sync alone. Confirmed by code reading in gate round 1; `addQteLine()` also never calls `calcQte()` after re-rendering.

Linking re-renders the grid, so it would hit this on every use. Therefore REQ-QTE4-010 is mandatory scope.

---

## 3. Requirements

**Definition — "linked line" (applies to the whole feature).** A quote line is *linked* iff it has a non-blank `lid` **and** the snapshot fields `lidUnitUSD` and `lidRate` (finite numbers, `lidRate` > 0). Every behavior in this REQ that depends on linkedness — the Qty rescale of Cost/CBM (REQ-QTE4-003/005), the Link/Unlink toggle (REQ-QTE4-011), the drift badge (REQ-QTE4-007), promotion matching (REQ-QTE4-009), the `delLI()` quote count (REQ-QTE4-008) and PO conversion `lid`/`sku`/per-unit cost (REQ-QTE4-013) — uses this one definition. A line with a non-blank `lid` but no usable snapshot (restored/hand-edited data) is *unlinked* for all of them: no rescale (no NaN), shows "Link to catalogue", no badge, no promotion by link, not counted by `delLI()`, PO line `lid:''`/`sku:''`/cost as typed. (`delLI()` may still count it conservatively in its warning — the SPEC decides; it must never crash.)

**REQ-QTE4-001 — "Add from Catalogue" entry point.** A button beside "+ Add Line" (`index.html:2974`) opens a Quote-specific picker (multi-select, search by desc/SKU, supplier grouping, same ordering as `rPickList()` `index.html:8668`). Each selected item appends one quote line. Hand-typed "+ Add Line" is unchanged. Adding an item already linked on this quote is allowed (different quantities are legitimate) but the picker row is marked "✓ already on this quote".

**REQ-QTE4-002 — Picker is separate from the invoice picker and sits above the Quote modal.** The invoice picker (`openPicker`/`rPickList`/`doPick`, bound to `cIL`/`addILI`, "✓ on this invoice") must remain byte-identical in behavior and its existing tests unmodified. The Quote picker is a new overlay element placed **after** `#ov-qt` in the document (`#ov-pick` at `index.html:2720` precedes `#ov-qt` at `2926`; both are `.ov`, fixed, same z-index, so reusing `#ov-pick` would render underneath the Quote modal). The same placement rule applies to the manual-rate modal of REQ-QTE4-004 (and any other overlay this feature adds): it must be placed after `#ov-qt` in the document. Acceptance is by DOM-order/z-index assertion for both overlays (not visible to the mock harness otherwise) plus a manual-test note in the SPEC. Shared list rendering may be factored into a helper both pickers call, provided the invoice output is unchanged.

**REQ-QTE4-003 — Fields and cost basis on link.** A linked line is created with supplier, description, UOM, DG, `qty` = 1 (or the qty the operator gave), and **`cost` = catalogue unit cost × `lidRate` × qty** (line total, USD — §1.1). Duty % = 0 (manual); markup/insRate overrides blank (inherit). Every field remains individually editable afterwards; editing a field does NOT unlink the line. **While the operator has not edited the Cost field by hand (`costManual` falsy), changing Qty rescales `cost` to `lidUnitUSD × qty`; once the operator types in Cost, `costManual = true` and Qty changes no longer touch it. **A manually typed Cost is a line total** (consistent with §1.1); so after typing 42 and later raising Qty from 1 to 6, the line's unit cost is 7, and that — not 42 — is what promotion compares (REQ-QTE4-009). The grid labels the Cost column "Cost (USD, line total)" to make this visible. **This relabels the header for every quote line, linked or not** (it is currently "Cost (USD)", `index.html:14857`) — accurate for the engine since qty never enters the calculation, but a visible change to pre-existing quotes, to be called out in the user guide and changelog; no existing test asserts the old header text.** `costManual` is persisted on the line (REQ-QTE4-006). **Rounding (pinned; scope = computed values only):** `lidUnitUSD` is stored unrounded; a line `cost` **computed by link/rescale/Refresh** is rounded to 4 decimal places when written. An **operator-typed Cost is never rounded** and `saveQte()` never rounds any existing stored cost, so pre-existing quotes and hand-typed lines are byte-identical on re-save and the price-history trigger (`lastV.cost !== l.cost`, `index.html:15066`) cannot fire spuriously; the 0.001 drift/promotion tolerances operate on unrounded native catalogue values and on `cost ÷ qty` computed from the stored 4-dp line cost. A PO line's `cost` = `cost ÷ qty` rounded to 4 dp, so for non-terminating divisions the PO line total (`qty × cost`) can differ from the quote line cost by up to ±0.0001 × qty — acknowledged and accepted (e.g. 100 ÷ 3 → 33.3333 → total 99.9999). A catalogue cost of 0/blank links with cost 0 and shows "no cost basis" (mirrors `invLineHasCostBasis`, `index.html` shared predicate).

**REQ-QTE4-004 — Currency and rate (option A + manual-rate prompt).**
- `li.cur` is normalised (trim, then upper-case) before use. **Trim is new behavior of this feature** — `toGBP()` (`index.html:5622`) upper-cases but does not trim, so a padded `'gbp '` would not convert through it; the linking code normalises first and then uses the same rate formulas, it does not call `toGBP()` on the raw value.
- **USD, GBP, BBD** convert from stored rates: USD per native = 1; GBP → `QR.fxGBPUSD`; BBD → `QR.fxGBPUSD ÷ QR.fxGBPBBD`. A zero/unset stored rate falls back to `QR_DEFAULTS` exactly as `toGBP()`/`fromGBP()` do (`5620-5638`), never a silent 0 or ÷0.
- **Any other currency, or blank/unrecognised** (RMB/CNY, EUR, NGN, GHS, …): the item **is selectable**. Before the line is added the operator is prompted for the USD value of 1 unit of that currency. The prompt may pre-fill a suggestion (RMB/CNY from `QR.fxGBPRMB`, `QR.fxGBPUSD ÷ fxGBPRMB`), but the operator must confirm. A blank, non-numeric, zero or negative entry cancels the add — nothing is appended and no unconverted number is ever used. A blank `li.cur` is never assumed USD.
- **Mechanism (pinned so it is testable):** the rate prompt is an in-app modal (not `window.prompt()`), reached through a single function `qteAskRate(cur, suggestion)` returning a Promise of a positive number or `null` (cancel). Tests replace that one function; no DOM modal needs driving. The prompt applies only to currencies **not convertible from stored rates** (after normalisation: anything other than USD, GBP, BBD; GBP/BBD/USD never prompt). In a multi-select add, the operator is asked **once per distinct normalised currency code in the batch, with RMB and CNY treated as one code** (they are aliases in `toGBP()`/`fromGBP()`, `index.html:5625`, `5635`); all items with a blank or unrecognised-but-non-empty code are grouped by their normalised text, and **all blank-currency items form one group** whose prompt reads "Catalogue currency is blank — enter the USD value of one unit of the currency this cost is actually in" (blank is never assumed USD) and the entered rate applies to every item of that currency in that batch; cancelling a currency's prompt skips only that currency's items, the rest are added, and a toast names the skipped items. Cancelling every prompt appends nothing. All other confirmations in this REQ (Refresh over a manual cost, link-over-typed-values, Accepted/PO-linked warning) use `confirm()` as the rest of the app does (e.g. `delLI()`), which tests stub.
- Linked lines are **always USD cost**, regardless of the quote-level Currency field (`qf-cur`), which remains a label only (§1.3).
- The rate and its source are stored on the line (`lidRate`, `lidRateSrc` = `'stored'`|`'manual'`) with the date (`lidAt`), so the conversion is auditable; nothing is ever recalculated from them automatically.

**REQ-QTE4-005 — CBM from dimensions.** If `li.dims` has l, w and h (cm), per-unit CBM = `l×w×h/1,000,000` and line `cbm` = per-unit CBM × qty, **rounded to 6 decimal places** (matching `calcLICBM()`, `index.html:8195`, `toFixed(6)`). The per-unit figure used is stored on the line as `lidUnitCBM` at link time (the recompute source — the live item is not consulted, so a later dims edit or delete cannot change an already-linked line). While `cbmManual` is falsy, changing Qty recomputes `cbm = lidUnitCBM × qty`; once the operator types in CBM, `cbmManual = true` and Qty changes no longer touch it. `cbmManual` is persisted on the line (REQ-QTE4-006). If `li.dims` is absent, `cbm` stays 0 and `lidUnitCBM` is not stored; no warning.

**REQ-QTE4-006 — Persisted shape; `saveQte()` carry-forward.** A linked line carries `lid` and a snapshot: `lidCost` (catalogue unit cost, native), `lidCur`, `lidRate`, `lidRateSrc`, `lidUnitUSD` (= `lidCost × lidRate`), `lidAt` (ISO), optional `lidUnitCBM`, and the flags `costManual`/`cbmManual` (stored only when true). `saveQte()` builds every saved line from a whitelist literal (`index.html:15034-15055`; today only supId/desc/qty/uom/cost/cbm/dg/dutyPct/markup/insRate plus the `sourceOrd*`/`sourceRfq*` fields) — it **must carry all of these forward**. New keys are added **conditionally** and are absent on unlinked lines (assert `'lid' in line === false`; note the existing literal already writes `markup: undefined`/`insRate: undefined` at `15042-15043`, so the "absent" assertion applies to the new keys only). `editQte()`'s `Object.assign` copy (`14786-14790`) already preserves unknown keys into `cQL`. A blank-string `lid` (as written by the AI `create_quote` path, `index.html:12979`) means **unlinked**, same as absent.

**REQ-QTE4-007 — Drift badge (native currency, not USD).** For a linked line whose Line Item still exists, drift is `current li.cost`/`li.cur` ≠ `lidCost`/`lidCur`, compared **in the catalogue's own currency** on a tolerance of 0.001 of that currency (so an FX-rate change on its own never triggers it — `fetchLiveRates()` rewrites `QR` rates). The badge reads "Catalogue cost changed since quoted: was <lidCost lidCur>, now <cost cur>". It never changes the quote's cost. **Refresh cost** re-links the line at current catalogue values (stored rate for USD/GBP/BBD; for any other currency the rate prompt re-appears pre-filled with the previous `lidRate`), recomputes cost = unit × rate × qty and CBM per REQ-QTE4-005, and resets `costManual`. If `costManual` is true, Refresh first asks "You overrode this line's cost — Refresh will replace it. Continue?". Refresh only edits the in-memory grid; nothing persists until the operator clicks Save Quote (it then versions the line like any manual cost edit — `saveQte()` versioning on cost/dutyPct/markup/insRate). On a quote whose status is Accepted or that has `linkedPOIds`, Refresh additionally warns "This quote is already Accepted / has Purchase Orders — changing its prices will not update them." (`saveQte()` has no Accepted lock; `index.html:15022-15029`, and re-saving an Accepted quote never re-queues promotion — `isAccepted && !wasAccepted`, `15176`). If the item was deleted: "Catalogue item removed", line otherwise editable. If the item's currency has changed, the badge says so and Refresh re-prompts the rate.

**REQ-QTE4-008 — Delete protection and dangling links.** `delLI()` (`index.html:8281`, which already warns about invoices/POs/pending suggestions) must also count quotes whose lines carry that `lid`, in the confirm text, on both the local and Cloud Data branches (Cloud soft-delete via `deleted_at` is treated identically to a local delete). Delete proceeds as today; `lid` stays on those lines as a historical reference (same precedent as `delSup()`). `verifyFkIntegrityAfterCleanup()` (`index.html:12177-12198`) currently reports any quote-line `lid` not in the catalogue as dangling; it must be changed so a quote-line `lid` pointing at a deleted Line Item is **not** reported as a defect (informational at most). Its explanatory comment and the stale "Quote.lines[].lid is dead" comments are updated (§7). **Accepted trade-offs, stated rather than hidden:** exempting the quote-line check also removes that check's ability to catch a genuinely failed `lid` remap after Line Item migration (the migration tests cover the remap directly), and the existing PO-line `lid` check (`index.html:12189`) will report dangling `lid` on POs created from quotes whose catalogue item is later deleted — this is the same already-accepted historical-reference behavior and is left as is.

**REQ-QTE4-009 — Promotion queue matches by link, with a defined cost and price basis.** In `saveQte()`'s Accepted-quote block (`index.html:15176-15210`):
- A line with a non-blank `lid` that resolves to an existing Line Item matches **that item** (not desc+supId). A line with blank/absent `lid`, or whose `lid` no longer resolves, falls back to the existing exact desc+supId matching unchanged (including its existing cost/price comparison, which is not touched).
- **For a linked line, an 'update' is queued only when the operator deliberately changed the line's cost away from what was linked:** `costManual` is true AND the line's unit cost in USD (`cost ÷ qty`) differs from `lidUnitUSD` by more than 0.001. Drift of the catalogue *itself* since linking is handled by the REQ-QTE4-007 badge and must never queue an 'update' (otherwise accepting a quote would propose reverting the catalogue to its stale snapshot). Equality of the line's cost with the catalogue's current cost also queues nothing. A price-only difference **never** queues an 'update' for a linked line: the quote's sell price is a line-total landed-cost-plus-markup figure (freight, insurance, duty, markup — `15183-15184` today compares it to a per-unit catalogue price, which can never be equal), so it is not a like-for-like catalogue price.
- The queued candidate carries, per unit and in the catalogue's own currency: `cost` = line unit cost USD ÷ `lidRate`, and `currency` = `li.cur` (never the quote's label currency, never a USD number under a native label); and `suggestedPrice` = (`sellP` ÷ qty) ÷ `lidRate` — an **indicative delivered per-unit sell price** (it includes freight, insurance, duty and markup, so it is deliberately NOT presented as a like-for-like catalogue price) converted to native, offered as a suggestion only (`approveLIPending()`, `index.html:8341`, pre-fills the form and the operator reviews it before saving; nothing is written to the catalogue without their own Save). A `'new'` candidate for an unlinked line is unchanged.
- If the line's supplier differs from `li.supId` — whether the operator changed it, or chose one because the catalogue item's supplier was blank/orphaned (REQ-QTE4-012(a)) — no 'update' is queued for the linked item. This is intended: the operator can adjust the catalogue deliberately.
- A description edit on a linked line never queues a 'new' candidate.
- A line carrying a non-blank `lid` but missing `lidUnitUSD` or `lidRate` (restored or hand-edited data) is treated as **unlinked** for promotion and for drift (no NaN comparisons; no badge).
- A linked line with a blank supplier is skipped exactly as unlinked blank-supplier lines are (`15178`).

**REQ-QTE4-009a — How the manual flags work.** `costManual` and `cbmManual` are line state held on the `cQL` entry (not DOM-backed). They are set to `true` only by an `oninput` handler on the Cost and CBM inputs that fires from operator typing; the programmatic rescale (Qty change) writes the new value to the input and to `cQL` **without** invoking that handler, so it never sets the flag. Typing a value equal to the auto value still sets the flag (conservative: the operator touched it). `saveQte()` reads both flags from `cQL`, not from `qlFld()`; `syncQLFromDOM()` must not clear or overwrite them. A blank, zero or non-positive Qty leaves Cost and CBM unchanged on a qty change (no rescale to 0).

**REQ-QTE4-010 — Grid state survives re-render (the §2 fix).** A single shared `syncQLFromDOM()` writes, for every line, the current DOM values of `supId`, `desc`, `qty`, `uom`, `cost`, `cbm`, `dg`, `dutyPct`, `markup`, `insRate` and the version note into `cQL`, and is called first in `addQteLine()`, `removeQteLine()`, the link action, Refresh cost, Unlink, and Add-from-Catalogue. `rQLT()` renders the note input from the line's note value (the note input gains a `value`). `addQteLine()` calls `calcQte()` after re-rendering. The note is transient: it is not persisted as a line field (the `saveQte()` whitelist continues not to carry it).

**REQ-QTE4-011 — Link an existing line; Unlink.** Each line has "Link to catalogue" (unlinked lines) or "Unlink" (linked lines). Linking an existing line opens the picker in single-select mode. The line's **typed Qty is kept** (a multi-select Add from Catalogue defaults Qty to 1; qty is then edited in the grid and the rescale rules apply). Linking overwrites supplier, description, UOM, cost, DG and CBM with the catalogue-derived values (cost and CBM computed for the kept Qty), resets `costManual`/`cbmManual` to false, and leaves Duty %, markup and insRate overrides untouched. It first asks for confirmation when the line is non-default, defined as: description non-blank, or supplier non-blank, or cost > 0, or cbm > 0, or DG ticked. Unlink removes `lid` and all snapshot keys **and both manual flags**; the line's values are unchanged. Bulk backfill of old quotes remains out of scope.

**REQ-QTE4-012 — Edge cases on link.** (a) `li.supId` blank or not resolving to an existing Supplier (SUP-GAP-001 shows orphans exist in real data): the line is created with supplier blank and a visible warning "Catalogue item has no valid supplier — select one"; the supplier `<select>` has no option for an unknown id (`index.html:14869`), so an unresolvable id must never be written. (b) Catalogue cost 0/blank: REQ-QTE4-003. (c) Item without dims: REQ-QTE4-005. (d) Quote status Accepted/Rejected: linking behaves as any other line edit (no new lock).

**REQ-QTE4-013 — Downstream behavior.** (a) `qteToPoConvert()` (`index.html:15530`; line literal at `15565` writes `lid:''`, `sku:''`, `cost:l.cost`): for a **linked** line, the PO line carries `lid` and `sku` read from the live Line Item at conversion time (blank if the item has since been deleted), and **PO `cost` = line cost ÷ qty** (per-unit, because a linked line's cost is a line total by construction and the PO line literal is per-unit `cost`/`qty`). Unlinked lines are unchanged (pre-existing basis mismatch disclosed in §1.3(b)). `renderPoSourceDriftWarn()` returns early when `po.invId` is blank (`index.html:9452`), so a Quote-created PO gains no new drift checking from this; the only effect is a real catalogue link for `delLI()`'s PO scan. (b) `prevQteDoc()` (`15611+`) must not print any snapshot, drift, "catalogue" or rate text; it already prints supplier and line cost (pre-existing, unchanged). (c) `renderQteSourceDriftWarn()` (`15730`) and price-history versioning are unchanged.

**REQ-QTE4-014 — Cloud Data and Sheets.**
- **No schema change**: `lid`, snapshot and flag keys live inside the existing `lines` jsonb.
- **Correct attribution of the existing sweep:** the `ql.lid` remap on Line Item migration lives in `migrateLineItemsToSupabase()` (`index.html:7027`, sweep at `7075`); `migrateQteToSupabase()` (`7256`) has no `lid` handling and needs none (lines are opaque jsonb — its own header says so). Required new behavior: (1) the existing sweep must remap only `lid` and must leave every snapshot/flag key untouched — test with a quote line carrying a full snapshot; (2) a link made **after** Line Items migrated carries a real UUID and needs no remap — test that it round-trips; (3) a link made **before** migration (local `uid()` id) is remapped by the existing sweep and pushed — the existing test at `tests/run.js:10244` covers the sweep, and gains a snapshot-untouched assertion.
- `refreshQteFromSupabase()` (`6492`) must preserve `lid`/snapshot/flag keys on lines and must not add any of them to unlinked lines (assert absent).
- **Sheets:** `FIELD_MAPS.qt` (`index.html:5146`) maps only num, client, dt, status, currency, calc_totalLanded, markup, notes — quote lines are not part of Sheets sync, so no line data (including the new keys) transits Sheets. `pullAll()` merges pulled rows with `mergePulledWithLocal()` (`index.html:5188-5196`), which is `Object.assign({}, local, pulled)` — unmapped fields, including `lines` and every new key, survive from the local record. (Pre-existing SEC-GAP-011-class overwrite behavior on *mapped* fields is unchanged by this feature.) The SPEC cites this rather than re-deriving it.
- No Line Item or Quote is read by the AI assistant tools today (no `get_quotes`); the SPEC confirms the snapshot cannot reach the assistant.

**REQ-QTE4-015 — Docs and assistant.** `AI_SYSTEM_PROMPT` describes Add from Catalogue, the cost-total/qty rule, the rate prompt and the drift badge accurately (no apostrophes inside single-quoted strings — known harness trap); `docs/user-guide.md` Quotes section documents Add from Catalogue, Link/Unlink, the three stored-rate currencies and the manual-rate prompt, the CBM rule, drift badge and Refresh; all hardcoded version strings, in-app changelog, CLAUDE.md, STACKD_CONTEXT.md backlog, version history, known gaps, requirements tracker and Notion rows per the delivery checklist.

---

## 4. Acceptance criteria (testable)

1. AC-1: Link a USD item (cost 10, qty 1) → supplier/desc/uom/dg set; `cost` 10; `lid` + `lidCost` 10, `lidCur` 'USD', `lidRate` 1, `lidRateSrc` 'stored', `lidUnitUSD` 10, `lidAt` present.
2. AC-2: GBP item cost 10 at `QR.fxGBPUSD` 1.27 → `lidRate` 1.27, `lidUnitUSD` 12.7; BBD item cost 20 at `fxGBPUSD` 1.27, `fxGBPBBD` 2.54 → `lidRate` 0.5, `lidUnitUSD` 10. Lowercase/space-padded currency ('gbp ') behaves as 'GBP' (normalisation is new here, see REQ-QTE4-004). A zeroed stored rate falls back to `QR_DEFAULTS`, never 0 or ÷0.
3. AC-3: EUR (or RMB, NGN, blank currency) item → `qteAskRate()` is called (tests stub it); entering 1.08 stores `lidRate` 1.08, `lidRateSrc` 'manual'; `null`/blank/0/negative/non-numeric appends **nothing** to `cQL`; a batch of two EUR items and one NGN item asks twice (EUR once, NGN once), and cancelling only the NGN prompt adds the EUR items and skips the NGN one with a toast.
4. AC-4 (cost × qty): link USD item cost 10 at qty 1 → cost 10; change qty to 5 with Cost untouched → cost 50; type 42 in Cost then change qty to 6 → cost stays 42; `costManual` persisted and still honoured after Save + reopen + qty change.
5. AC-5 (CBM): dims 50×40×30 cm → per-unit 0.06; qty 10 → cbm 0.6; qty 20 → 1.2; type 0.9 in CBM then qty 30 → stays 0.9; `cbmManual` persists across Save/reopen; value rounded to 6 dp; item without dims → cbm 0, no `lidUnitCBM`; deleting the Line Item or editing its dims after linking does not change the line's CBM recompute.
6. AC-6: Save + reopen: all of `lid`, `lidCost`, `lidCur`, `lidRate`, `lidRateSrc`, `lidUnitUSD`, `lidAt`, `lidUnitCBM` (when set), `costManual`/`cbmManual` (when true) survive; an unlinked line has none of those keys (`'lid' in line === false`, etc.); a line with `lid:''` is treated as unlinked everywhere.
7. AC-7 (drift): change catalogue cost 10 → 11 → badge "was 10 USD, now 11 USD"; change `QR.fxGBPUSD` only (GBP item, catalogue unchanged) → **no** badge; difference below 0.001 native → no badge; currency changed GBP→EUR → currency-changed badge; deleted item → "Catalogue item removed". Without clicking Refresh the quote cost never changes. Refresh with `costManual` true asks first; Refresh in-memory only until Save; saving versions the line.
8. AC-8 (delete): `delLI()` confirm text includes the quote count (local and Cloud branches, Cloud soft-delete); after delete the line still saves; `verifyFkIntegrityAfterCleanup()` does not report the dangling quote-line `lid`.
9. AC-9 (promotion): (a) Accept a quote whose linked line's description was edited → no 'new' candidate; an unlinked line with the same edit still queues one (unchanged). (b) Linked GBP item (catalogue cost 10 GBP, linked at rate 1.27), cost not touched → **no** 'update'. (c) Same, but the catalogue cost was later changed to 11 GBP and the line's cost was not touched → **no** 'update' (drift is the badge's job, not the queue's). (d) `costManual` true and unit cost typed so unit USD differs from `lidUnitUSD` by > 0.001 → exactly one 'update' whose `cost` is unit USD ÷ `lidRate` and `currency` is 'GBP', and whose `suggestedPrice` = (`sellP` ÷ qty) ÷ `lidRate`; (e) a price-only difference (cost untouched) never queues an 'update'; (f) line supplier changed away from `li.supId` → no 'update'; (g) dangling `lid` → falls back to desc+supId matching with the unchanged legacy comparison; (h) approving the (d) candidate via `approveLIPending()` pre-fills the form in `li.cur` with the native values, never a USD figure.
10. AC-10 (re-render): type values into line A (desc, supplier, qty, cost, dg, markup, insRate, note), then call `addQteLine()` / `removeQteLine(B)` / link an item → the rendered `G('qt-lines').innerHTML` string and `cQL[A]` both contain line A's typed values. This is asserted on the **rendered HTML string and `cQL` state** — not on the mock input's `.value`, which the module-level mock keeps across renders and would hide the defect — and the test is first shown red against the unfixed code (reverting `syncQLFromDOM()`'s call in `addQteLine()` must fail exactly this test).
11. AC-11 (PO): converting a quote with a linked line (cost 50, qty 5) → PO line has `lid`, `sku` of the live item, `cost` 10 (line cost is stored rounded to 4 dp and the PO `cost` = `cost ÷ qty` rounded to 4 dp; add a case with a non-terminating division, e.g. 100 ÷ 3 = 33.3333), `qty` 5; an unlinked line is unchanged (`lid:''`, `sku:''`, `cost` as typed); deleted item → blank `lid`/`sku`.
12. AC-12: `prevQteDoc()` output for a drifted linked line contains none of the snapshot/rate/"catalogue" strings.
13. AC-13: all existing invoice picker tests pass unmodified; invoice picker output unchanged; **both** the Quote picker overlay and the manual-rate modal appear after `#ov-qt` in the document.
14. AC-14 (Cloud): LI migration sweep remaps `lid` and leaves a full snapshot byte-identical; a post-migration link with a UUID `lid` round-trips insert → `refreshQteFromSupabase()`; unlinked lines gain no keys; self-marking test contamination checked (`localStorage.removeItem` of any marker a test sets).
15. AC-15 (edge): item with blank or unresolvable `li.supId` → line supplier blank + visible warning, no unknown id written; adding the same item twice is allowed and marked; "Link to catalogue" on a typed line asks before overwriting; Unlink removes `lid` and every snapshot/flag key and leaves values.
16. AC-16: full suite green; every touched pre-existing test listed in the SPEC; mutation tests per §6.

---

## 5. Data flow / GDPR

No new personal data. Catalogue costs, rates and supplier ids already live in the same browser store and (if migrated) the same Supabase tables; the snapshot and rate are derived pricing data inside an existing jsonb column and in backup JSON. No new external transmission: quotes are not part of the `inv_buyer_approved` webhook, no Quote line data transits Sheets (`FIELD_MAPS.qt`), and the AI assistant has no Quote read tool. A manually entered rate is operator-entered numeric data only.

## 6. Risks, challenges and test obligations

1. **Cost basis is the real risk.** The engine treats cost as a line total; the catalogue is per-unit; PO conversion treats it per-unit. v2 pins linked lines to line-total cost with a persisted manual-override flag and converts back to per-unit for the PO. Disclosed, not fixed, for unlinked lines (§1.3).
2. **Manual rates are only as good as the operator.** The rate and date are stored, shown and editable only by re-linking; there is no historic-rate source.
3. **The snapshot goes stale by design**; the drift badge only helps when a quote is opened. A sent/accepted quote is a point-in-time offer — stated in the user guide.
4. **Mutation tests required** (revert in a scratch copy; the exact predicted test must fail): the `saveQte()` carry-forward (AC-6), the non-USD rate-prompt cancel path (AC-3), cost×qty rescale and `costManual` guard (AC-4), `cbmManual` guard (AC-5), native-currency drift comparison (AC-7), by-`lid` promotion comparison basis (AC-9), `syncQLFromDOM()` call in `addQteLine()` (AC-10), PO per-unit division (AC-11).
5. **Harness hazards to respect:** `mockElements` is module-level and never cleared (reset every new per-line/quote-level mock field in `saveQteSetup()` or the test); `qlFld()` reads the mock DOM, so tests must set `mockEl('ql-…-'+rid).value` rather than only `cQL` fields; self-marking migration markers must be removed after any test that triggers them.

## 7. Artefacts touched / gaps to log

Touched pre-existing artefacts: the Quote grid Cost column header (`index.html:14857`), comments at `index.html:7072-7075`, `7078-7080` (the "touched-set will always be empty in practice today" comment, at `7079`) and `12195-12198`; tests named for "Quote.lines[].lid is dead" (`tests/run.js:8966`, `8971`) and the Line-Item-after-Quote sweep test at `10244`; `docs/known-gaps.md`, `CLAUDE.md` and STACKD_CONTEXT.md statements that Quote `lid` is unused. New gaps to log at delivery: (1) quote line `cost` is a line total in the engine but copied as per-unit to POs; (2) unlinked-line promotion compares line-total cost to per-unit catalogue cost; (3) `ordConvertToQuote()` fills costs in the quote's currency under a USD column; (4) no historic FX store (relates to MTD-GAP-002).

## 8. Gate round 1 → v2 map

| Round-1 finding | Addressed by |
|---|---|
| 1 (cost basis undefined) | §1.1, REQ-QTE4-003, AC-4, REQ-QTE4-013(a), §1.3 |
| 2 (promotion currency basis) | REQ-QTE4-009, AC-9 |
| 3 (FX-driven false drift, Refresh overwrite) | REQ-QTE4-007, AC-7 |
| 4 (re-render test unobservable; note) | §2, REQ-QTE4-010, AC-10 |
| 5 (CBM override lifetime/source/rounding) | REQ-QTE4-005/006, AC-5 |
| 6 (migration misattribution, stale comments) | REQ-QTE4-014, §7 |
| 7 (dangling lid vs integrity check) | REQ-QTE4-008, AC-8 |
| 8 (picker stacking) | REQ-QTE4-002, AC-13 |
| 9 (currency looseness, RMB, header currency) | REQ-QTE4-004 (manual-rate prompt, normalisation, fallback, always-USD) |
| 10 (entry-condition edges) | REQ-QTE4-001/011/012, REQ-QTE4-006 (blank lid), AC-15 |
| 11 (PO sku source, accepted lock, citation) | REQ-QTE4-013(a), REQ-QTE4-007, corrected citation `15176-15210` |
| 12 (Sheets claim) | REQ-QTE4-014, §5 |
| 13–16 (advisories) | REQ-QTE4-006 (`markup: undefined` note), AC-12 wording, §7 |

## 9. Gate round 2 → v3 map

| Round-2 finding | Addressed by |
|---|---|
| 1 (blocking: 'update' price basis, AC-9 unmeetable) | REQ-QTE4-009 rewritten (update only on deliberate cost override vs `lidUnitUSD`; price-only never queues; per-unit native `suggestedPrice`), AC-9 rewritten (a–h) |
| 2 (prompt UI / multi-item) | REQ-QTE4-004 "Mechanism" (`qteAskRate()`, once per currency per batch, partial cancel, `confirm()` for the rest), AC-3 |
| 3 (link-existing-line ambiguity) | REQ-QTE4-011 (qty kept, flags reset, non-default defined, Unlink clears flags) |
| 4 (wrong statements: trim, pullAll merge) | REQ-QTE4-004 wording, AC-2, REQ-QTE4-014 (`mergePulledWithLocal` 5188-5196 cited) |
| 5 (flag detection/location) | REQ-QTE4-009a (new) |
| 6 (integrity-check trade-offs) | REQ-QTE4-008 trade-offs stated |
| 7 (rounding) | AC-11 pins 4 dp and a non-terminating case |
| 8 (stale comment range) | §7 `7088-7091` |

## 10. Gate round 3 → v4 map

| Round-3 finding | Addressed by |
|---|---|
| 1 (`suggestedPrice` wording contradiction) | REQ-QTE4-009 — stated as an indicative delivered sell price, not like-for-like |
| 2 (rate modal stacking) | REQ-QTE4-002 extended to every overlay this feature adds; AC-13 |
| 3 (prompt grouping, blank currency) | REQ-QTE4-004 — prompt set = not convertible from stored rates; one prompt per normalised code; all blank-currency items one group |
| 4 (rounding only in an AC) | REQ-QTE4-003 "Rounding (pinned)"; AC-11 cross-references it |
| 5 (manual cost is a line total) | REQ-QTE4-003 statement + column label |
| 6 (lid without snapshot) | REQ-QTE4-009 — treated as unlinked |
| 7 (supplier-mismatch intent) | REQ-QTE4-009 clarified |
| 8 (reference errors) | §1.2 table → REQ-QTE4-012; §7 comment lines `7072-7075`, `7078-7080`, `12195-12198` |

## 11. Gate round 4 → v5 map

| Round-4 finding | Addressed by |
|---|---|
| 1 ("linked" defined only for promotion/drift) | New "Definition — linked line" section applied feature-wide |
| 2 (rounding scope) | REQ-QTE4-003 — computed values only; typed Cost never rounded; `saveQte()` never rounds existing costs |
| 3 (header relabel visible on all lines) | REQ-QTE4-003 note; §7 touched artefacts; user-guide/changelog |
| 4 (RMB/CNY aliases) | REQ-QTE4-004 grouping |
