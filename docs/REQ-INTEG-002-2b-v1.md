# REQ-INTEG-002 (Sub-phase 2b) — Invoice→PO enumeration fix

**Status:** v1 — pre-review draft.
**Scope:** Sub-phase 2b of 4 in the larger Payment Allocation build (2a Supplier ledger → **2b Invoice→PO enumeration fix** → 2c Buyer payment tranches → 2d full allocation link). 2a shipped v2.9.62, stabilized over three fix-forward rounds (v2.9.63, v2.9.64, v2.9.65, the last two closing the currency-mixing defect class). This sub-phase makes "which POs belong to this invoice" a reliable, single-source-of-truth question — a prerequisite for 2c/2d, which will need to allocate a buyer's payment across the correct supplier obligations.

**Design direction:** confirmed with the user — make `inv.pos[]` the authoritative record (not the alternative of extracting the existing ad-hoc filter into a shared read-only helper with no new field semantics). This is the larger of the two options considered: it requires a one-time backfill migration and a new PO-deletion cleanup step, in exchange for a real, actively-maintained foreign-key-array relationship that 2c/2d can build on directly.

---

## 1. Business context

### 1.1 Facts established during check-first (against `main` @ `74dab27`, 609/609 tests passing)

**`inv.pos[]` exists, is written in three places, and is read in zero.** It's an array of PO ids on the Invoice record:
- Populated by `autoPos(inv)` (`index.html:5963-5981`) when an invoice's line items generate POs — `if(ii>-1){DB.inv[ii].pos=DB.inv[ii].pos||[];DB.inv[ii].pos.push(po.id);}` (`index.html:5976`). `autoPos()` is only ever called on an invoice's first save (`saveInv()`, `index.html:5858`: `if(!EI.i) autoPos(inv);`) — never again afterward, confirmed the same guard already documented by `PO-GAP-003`'s investigation.
- Preserved (not recomputed) on later invoice edits — `inv.pos=existing.pos||[]` (`index.html:5750`).
- Preserved on CSV import/re-import merges — `pos:existing?existing.pos:[]` (`index.html:7864`, `8199`).
- **Never read anywhere.** Grepped every occurrence of `.pos` referencing the Invoice record across `index.html` and `tests/run.js` — the three write sites above are the entire footprint. No render function, no `_aiExecTool` tool, no report, and no test ever inspects `inv.pos[]` to answer "what POs does this invoice have."

**The actual live mechanism, used everywhere "this invoice's POs" is needed, is an ad-hoc filter independently retyped at each call site: `po.invId === inv.id || po.invNum === inv.num`.** Confirmed exactly three such forward (Invoice→PO) sites in the app today:
- `renderAccts()`'s per-invoice view — `linkedPOs = DB.po.filter(function(p){ return p.invId === inv.id || p.invNum === inv.num; })` (`index.html:4723-4724`), the basis for `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` (REQ-CUR-002, v2.9.65).
- `saveInv()`'s FPM-deposit auto-recovery block — `DB.po.forEach(function(po){ if ((po.invId === inv.id || po.invNum === inv.num) && po.fpmFunded > 0 && !po.fpmRecovered) {...} })` (`index.html:5860-5869`).
- `savePayment()`'s identical FPM-deposit auto-recovery block (`index.html:11444-11454`) — an independent copy of the same logic, already flagged as an explicit non-goal to consolidate in `REQ-INTEG-002h` (2a). That non-goal is about not merging these two blocks' duplicated *business logic*; it does not bear on what each one enumerates from, which this REQ does change (see §2, REQ-INTEG-002-2b-d).

Two further sites do the reverse lookup (PO→Invoice, given a PO's own `invId`/`invNum`, find its one invoice) — `ordRealisedMargin()` (`index.html:2815`) and `backfillOrderRequests()` (`index.html:2864`). These are a single-record `.find()`, not an enumeration problem (a PO always knows its own one `invId` directly) — confirmed out of scope, unchanged by this REQ (§3).

**`inv.pos[]` actively goes stale today, silently, because nothing cleans it up.** `delPO(id)` (`index.html:7000-7007`) removes the PO from `DB.po` and logs the deletion, but has no cleanup logic of any kind — confirmed by direct read, matching the same "no cascade" characteristic already documented for `PO-GAP-003`. A deleted PO's id remains in whichever invoice's `inv.pos[]` referenced it, forever. This has caused zero visible harm to date only because nothing reads the field — but it means today's `inv.pos[]` cannot be trusted as-is; a backfill that merges with the existing (corrupted) data would preserve that corruption. The correct backfill source is the live ad-hoc filter itself, which self-corrects on every read (a deleted PO simply vanishes from `DB.po`, so the filter never returns it).

**`autoPos()` is the only PO-creation path that ever links a PO to an invoice.** `qteToPoConvert()` (Quote→PO conversion, `index.html:11074` onward) creates POs with `quoteId`/`quoteNum` set and `invId`/`invNum` explicitly blank (`index.html:11104`: `invNum: '', invId: ''`) — these POs are never linked to any invoice unless/until one is later raised against the same line items, which triggers `autoPos()` on that invoice's own first save, generating separate PO records. A Quote-converted PO's `invId` is never set by any other code path — confirmed by grep, no assignment to `po.invId` anywhere outside `autoPos()` and `savePO()`.

**`savePO()` re-derives `po.invId`/`po.invNum` from a UI field on every single save — but the field is `readonly`, so in practice this is a no-op echo, with one latent edge case flagged but not fixed here.** `savePO()` (`index.html:6963-6968`) does `var invNumVal = G('pf-inv').value.trim(); var linkedInv = DB.inv.find(function(i){ return i.num === invNumVal; }); ... invNum:invNumVal, invId:linkedInv?linkedInv.id:''`. The `pf-inv` input is marked `readonly` in its HTML (`index.html:2217`, labelled "Linked Invoice # (auto)") and is only ever populated from `po.invNum` when the edit form opens (`index.html:6922`) — so an operator cannot manually change or set this value, and every ordinary PO save simply re-derives the same `invId` it already had. **One latent, narrow edge case, newly observed during this check-first, logged as a new gap rather than folded into this REQ's scope (§3):** if an invoice's own `num` is ever changed after a PO has been linked to it, the next time that PO is edited and saved, `linkedInv` will fail to resolve by the now-stale `invNumVal` text, silently clearing that PO's `invId` to `''` (while `po.invNum` itself, the stale text, is left unchanged). This is a `savePO()` behavior, not an Invoice→PO enumeration behavior, and is unrelated to the fix in this REQ — logged as `PO-GAP-004` (§3).

### 1.2 Why 2b matters now, concretely

2c (buyer payment tranches) and 2d (full allocation link) will need to reliably answer "which supplier obligations does this buyer invoice fund," in order to allocate a buyer's payment across the correct POs. Building that on either (a) a dead, silently-stale field, or (b) three independently-retyped copies of the same filter condition, repeats the exact shape of risk that produced the currency-mixing defect class fixed across v2.9.64/v2.9.65 — a correctness-critical calculation resting on an unreliable or duplicated foundation. This REQ closes that foundation gap before 2c/2d are briefed.

---

## 2. Requirements

### REQ-INTEG-002-2b-a — Backfill migration: `backfillInvoicePOs()`
A new migration function, mirroring the existing `migrateLinkedPOIds()` pattern (`index.html:2763-2773`: per-record check, mutate if needed, track a `changed` flag, call `saveAll()` once at the end if anything changed). For every invoice in `DB.inv`, **replace** `inv.pos` with the array of ids of every PO in `DB.po` where `po.invId === inv.id || po.invNum === inv.num` — not a merge with whatever `inv.pos` currently holds, since that field is confirmed stale (§1.1). This is idempotent: re-running it recomputes the same, currently-correct result every time, so it's safe to call unconditionally on every boot/import, exactly like its sibling migrations. Wired into the same two call sites as `migrateLinkedPOIds()`/`backfillOrderRequests()` — `doImport()`'s restore path (`index.html:9946-9948`) and app boot (`index.html:11937-11939`).

### REQ-INTEG-002-2b-b — New shared helper: `getInvoicePOs(inv)`
Placed near `autoPos()`: `function getInvoicePOs(inv) { return (inv.pos||[]).map(function(id){ return DB.po.find(function(p){ return p.id===id; }); }).filter(Boolean); }`. Resolves stored ids to live `DB.po` records, defensively dropping any id that no longer resolves (belt-and-suspenders against a future code path that mutates `DB.po`/`inv.pos` without going through `delPO()`'s new cleanup step, REQ-INTEG-002-2b-c — never surfaces a broken reference to a caller as `undefined`). This becomes the one canonical answer to "which POs belong to this invoice," used by every call site named in REQ-INTEG-002-2b-d and available for 2c/2d to build on directly.

### REQ-INTEG-002-2b-c — `delPO()` removes the deleted PO's id from every invoice's `pos[]`
`delPO(id)` (`index.html:7000-7007`) gains one new step: after removing the PO from `DB.po`, iterate `DB.inv` and remove `id` from any invoice's `pos[]` that contains it (`DB.inv.forEach(function(i){ if (i.pos && i.pos.length) { var idx = i.pos.indexOf(id); if (idx > -1) i.pos.splice(idx,1); } })`, persisted via the existing `sv(K.i, DB.inv)` call already made elsewhere in `saveInv()`'s pattern — `delPO()` needs its own new `sv(K.i, DB.inv)` call, since it doesn't currently touch `DB.inv` at all). This is the one behavior change needed to keep `inv.pos[]` from silently going stale going forward, closing the exact gap identified in §1.1. Ordinarily this touches zero or one invoice per deleted PO (a PO belongs to at most one invoice); no cascade-delete of the invoice itself, matching the existing "no cascade" precedent in the other direction (`delInv()` never touches `DB.po`).

### REQ-INTEG-002-2b-d — Switch the three forward-enumeration call sites to `getInvoicePOs(inv)`
- `renderAccts()`'s per-invoice `linkedPOs` (`index.html:4723-4724`, currently `DB.po.filter(...)`) → `getInvoicePOs(inv)`. No change to anything computed from `linkedPOs` afterward (`supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase`, REQ-CUR-002) — only the source of the array changes.
- `saveInv()`'s FPM-deposit auto-recovery block (`index.html:5860-5869`) → replace `DB.po.forEach(function(po){ if ((po.invId===inv.id||po.invNum===inv.num) && ...) {...} })` with `getInvoicePOs(inv).forEach(function(po){ if (po.fpmFunded > 0 && !po.fpmRecovered) {...} })` — identical side effects (`po.fpmRecovered = true`, `po.updAt`, `syncEnt('po', po)`), only the enumeration source changes.
- `savePayment()`'s identical block (`index.html:11444-11454`) → the same mechanical substitution. **This is not the REQ-INTEG-002h-deferred consolidation** — the two blocks remain two separately-maintained copies of the same business logic, exactly as 2a's non-goal left them; only what each one iterates over changes, from an inline re-derivation to the shared enumeration helper.

### REQ-INTEG-002-2b-e — `autoPos()` unchanged
Already correctly pushes each newly-created PO's id into `inv.pos[]` (`index.html:5976`) — this is the one existing write path that was already right. No change.

---

## 3. Explicitly out of scope

- **Reverse PO→Invoice lookups** (`ordRealisedMargin()` `index.html:2815`; `backfillOrderRequests()` `index.html:2864`) — a PO already knows its own single `invId` directly; this is a `.find()`, not an enumeration problem, and neither call site is touched.
- **`PO-GAP-004` (new, logged not fixed):** `savePO()`'s re-derivation of `po.invId` from the readonly `pf-inv` field (`index.html:6965-6968`) would silently clear a PO's `invId` on its next save if the linked invoice's `num` was renamed in between — a `savePO()` behavior, unrelated to Invoice→PO enumeration, newly observed during this REQ's check-first. Logged to `docs/known-gaps.md` on completion, not fixed here.
- **No consolidation of the two independently-duplicated `fpmRecovered` auto-set blocks** themselves (`REQ-INTEG-002h`, 2a) — they remain two separate copies of the same logic; only their enumeration source changes (REQ-INTEG-002-2b-d).
- **No change to Quote-converted POs' linking behavior** — a Quote-converted PO with no `invId` correctly never appears in any invoice's `pos[]`; this matches existing, correct behavior and needs no fix.
- **No cascade-delete of an invoice's linked POs on `delInv()`**, and no new cleanup of a PO's `invId`/`invNum` when its linked invoice is deleted — matches the existing, accepted "no cascade" precedent in the other direction; not part of this REQ.
- **No buyer payment tranches (2c) or allocation linking (2d)** — those remain separate, future briefs. This REQ removes a foundation blocker for them; it does not begin either.
- **No change to `toDisp()`/currency-conversion logic anywhere** — this REQ is about which POs are enumerated, not how their figures are converted or summed (that's REQ-CUR-002's already-shipped territory).

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | An invoice with 2 linked POs (both from `autoPos()`) whose `inv.pos[]` was never touched | `getInvoicePOs(inv)` is called | Returns both PO records, resolved from the stored ids |
| AC-2 | An invoice whose `inv.pos[]` contains an id for a PO that has since been deleted via `delPO()` before this REQ's fix (a pre-existing stale entry) | `backfillInvoicePOs()` runs | The stale id is removed — `inv.pos[]` is rebuilt from the live `po.invId===inv.id\|\|po.invNum===inv.num` match, not merged with the stale prior contents |
| AC-3 | An invoice with 2 linked POs | One of those POs is deleted via `delPO()` | The deleted PO's id is removed from that invoice's `pos[]`; `getInvoicePOs(inv)` now returns only the remaining PO |
| AC-4 | An invoice with no linked POs (e.g. a service invoice with no supplier-linked line items) | `getInvoicePOs(inv)` is called | Returns `[]`, not an error |
| AC-5 | `backfillInvoicePOs()` run twice in a row with no intervening data change | Second run | No-op — `inv.pos[]` is unchanged the second time (idempotency) |
| AC-6 | `renderAccts()`'s per-invoice view, an invoice with 2 linked POs | Rendered | Produces the identical `supDepPaid`/`fpmFunded`/`supBalDue`/`totalToChase` figures as before this REQ (regression guard — enumeration source changed, output must not) |
| AC-7 | An invoice reaching `Paid` status via `saveInv()`, with 1 linked PO carrying an unrecovered `fpmFunded` deposit | The invoice is saved | The linked PO's `fpmRecovered` is set `true`, exactly as before this REQ (regression guard on `saveInv()`'s auto-recovery block, now sourced via `getInvoicePOs()`) |
| AC-8 | The same scenario as AC-7, reached via `savePayment()` instead of `saveInv()` | The triggering payment is saved | The linked PO's `fpmRecovered` is set `true`, exactly as before this REQ (regression guard on `savePayment()`'s independent copy of the same block) |
| AC-9 | A brand-new invoice whose line items generate 2 POs via `autoPos()` | The invoice is saved for the first time | Both new POs' ids appear in `inv.pos[]`, and `getInvoicePOs(inv)` returns both — confirms the one already-correct write path still works unmodified |
| AC-10 | The full existing test suite (609/609 as of this REQ's check-first pass) | This phase is built | All pre-existing tests still pass unchanged |

---

## 5. Gate process

Full requirements-gate → spec-gate → build-gate — this touches the FPM-deposit auto-recovery logic (real financial state, `po.fpmRecovered`) and the Accounts page's per-invoice figures (already the subject of REQ-CUR-002's careful gate process). Do not shortcut.

---

## 6. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: log `PO-GAP-004` (new, per §3) as Open — Backlog, not fixed. No existing gap entries to mark fixed (2b doesn't close a previously-logged gap; it's a foundation fix ahead of 2c/2d).
- `docs/requirements-tracker.md`: new row, or an addition to `REQ-INTEG-002`'s existing row following the established fix-forward-annotation convention used for 2a's own row.
- `STACKD_CONTEXT.md`'s Backlog carried forward table: update the `REQ-INTEG-002 (Sub-phase 2b)` row to reflect 2b shipped and name 2c as the next explicit step, per the standing "On version delivery" checklist item.
