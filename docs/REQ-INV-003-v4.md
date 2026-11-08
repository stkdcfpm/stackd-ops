# REQ-INV-003-v4: An invoice line carries its own actual cost (one-off supplier prices, no retroactive drift)

**Status:** v4 — DRAFT, resubmission for `requirements-gate` round 3. Revises v3 after round 2 (FAIL: 6 new blocking findings N1-N6 and 8 advisory, mostly internal contradictions introduced by the v3 rewrite). Every finding was re-verified against the live code before being accepted, and three of the code behaviours were proved by throwaway probe (§1.1). Supersedes `REQ-INV-003-v3.md` (kept unedited). Round 1 findings B1-B11 were judged fixed or partial-with-residue by round 2; the residue is closed here.
**Type:** Behaviour change to invoice cost/profit calculation, plus one new optional per-line field inside the existing `lineItems` structure. No new `K`/`DB` entity.
**Operator decisions Q1-Q5:** resolved 2026-11-08, unchanged (§8).

---

## 1. Business context

Profit per order is the number the operator decides on. Reconciling two real invoices against the operator's supplier cost sheets showed the app cannot produce a trustworthy per-order profit, for three reasons with one root cause: **an invoice does not own its cost.**

| # | Finding | Evidence |
|---|---|---|
| F1 | A one-off supplier price cannot be recorded on a catalogue-linked line. | INV10028 "PVC Foam Board 34mm" ×200: catalogue cost 25, operator-confirmed one-off price 19.44. The Unit Cost cell is read-only when catalogue-linked (`index.html:8479`, `:8506`) and COGS ignores any line value for a linked line (`index.html:5473-5474`). Shown net profit 3,603.80; real 4,715.80 (freight still counted as margin). |
| F2 | Editing a catalogue cost silently rewrites old invoices' profit. | `cInv()` uses the item's *current* catalogue cost (`index.html:5473-5474`); `calcInv()` likewise (`:8561`). The 34mm item is used on INV10028 and INV10031. |
| F3 | Stored `calc_*` figures beat the invoice's own lines. | INV10030 has 5 real lines but `iCalc()` returns stored values (`index.html:5589-5591`): stored COGS 9,527.82 / net 4,652.18; from lines 11,800 / 2,380; operator's real cost sheet 11,733.50 / 2,446.50. Dashboard overstated by 2,205.68 (about £1,655). The stored values came from `runFPMMigration()` (`index.html:16161`) as well as CSV import. |

**The cost is already half-captured then ignored.** `addILI()` already stores the catalogue cost on a new line as `unitCost` (`index.html:8468`), but `cInv()`/`calcInv()` never read it for linked lines, and `rILT()` shows the *current* catalogue cost (`:8478`). Older lines carry `unitCost: 0` or none (INV10028, INV10030 confirmed live).

### 1.1 Prerequisite defects found while reviewing (verified by throwaway probe, not by reading alone)

- **P1 — `saveInv()` drops each line's `supId`.** The saved `lineItems` literal whitelists only `rid, lid, desc, uom, qty, up, unitCost, lineType` (`index.html:8626`). A reloaded quick-added Product line has no supplier, so `vInv()`'s supplier gate (REQ/SPEC-LI-002) fails on every later re-save. Probe: saved keys `rid,lid,desc,uom,qty,up,unitCost,lineType`, `supId === undefined`, `vInv()` on the reloaded copy → `false`. Logged as **INV-GAP-009**.
- **P2 — `saveInv()` drops all earlier `editHistory` entries.** The rebuilt `inv` literal carries no `editHistory`; `saveInv()` starts from `[]` (`index.html:8702`) and pushes only the new entry. Probe: after a second unlock-and-save the history held 1 entry, not 2. Logged as **INV-GAP-010**.

- **P3 — a catalogue link wins over the line's own type and cost in `cInv()`/`calcInv()`.** Probe: a `pass-through` line (price 100, `unitCost` 100) that still carries a resolvable `lid` to a catalogue item costing 60 gives COGS 60, not 100 (`index.html:5473-5474`, `:8561` ignore `lineType`), while `rILT()` displays the line's price as its cost (`:8478`). Logged as **INV-GAP-011**; this REQ preserves today's behaviour and does not fix it.
- **P4 — deleting a catalogue item zeroes an old invoice's COGS.** Probe: a product line whose `lid` no longer resolves and whose `unitCost` is 0 gives COGS 0 (100% margin). `delLI()` only warns (`index.html:8154`). A recorded actual cost (REQ-INV-010) protects a line against this; legacy lines remain exposed (INV-GAP-008).
- **P5 — `cInv()`'s third COGS path is live.** Probe: lines with no `lid` and no `unitCost` key plus stored `calc_cogs` 60 give COGS 60 in both `cInv()` and `iCalc()` (`index.html:5477-5482`).

REQ-INV-016's audit trail is meaningless unless P2 is fixed first, and REQ-INV-022 sits in the same code. **Both are to be fixed as a small, separate change before this REQ is built** (REQ-INV-026).

---

## 2. FM-1 assessment

Changes the shape of a persisted entity (adds an optional key to elements of `DB.inv[].lineItems[]`). No new entity, no new `K` key. Invoice lines travel as one opaque `jsonb` column to Cloud Data (`line_items: inv.lineItems` — invoice row at `index.html:6569` in `persistInvChange()`; `:7432` in `migrateInvToSupabase()`; `:6558` and `:7421` are the credit-note branches), so no Supabase migration is expected. **`schema-migration-reviewer` must review the SPEC.**

---

## 3. Definitions

- **Recorded actual cost (RAC):** the new optional per-line unit cost, in the invoice's currency. **Present** means a finite number greater than 0; anything else (absent, 0, blank, negative, non-numeric, a half-typed value) is *not present*. Representation (a distinct key; never overloading legacy `unitCost`) is a SPEC decision (§8.2).
- **Applies to:** a RAC may exist only on a `lineType === 'product'` line. The requirements below set it on catalogue-linked product lines; an unlinked product line already owns its cost in `unitCost` (unchanged) and no requirement here gives it an RAC. Once a product line has an RAC, the RAC wins whether or not the line's `lid` still resolves.
- **Has lines:** `lineItems.length >= 1`.
- **Cost-less lines:** lines that, taken together, have no catalogue match and no `unitCost` key (the case `cInv()` handles with its stored-COGS third path, `:5477-5482`).

---

## 4. Requirements

**REQ-INV-010 — A product line's actual cost is authoritative when present.** A product line may carry an RAC. When present it is the line's cost in every COGS, gross-profit, net-profit and margin calculation, even if its catalogue item has since been deleted or re-linked.

**REQ-INV-011 — Captured at the moment of sale.** Adding a line from the catalogue stores the catalogue cost *at that moment* as the line's RAC (extending `index.html:8468`) **only if that cost is greater than 0**. If it is 0 or blank, no RAC is recorded and the line behaves as a legacy line. After capture, editing the catalogue cost must not change that invoice's COGS or profit.

**REQ-INV-012 — Editable, with the difference visible.** The Unit Cost cell of a catalogue-linked product line (read-only today, `:8479`) becomes editable and edits the RAC. When the RAC differs from the item's current catalogue cost, the cell shows the text `Catalogue <cost>` (two decimals, invoice currency) next to it. Line margin and the form's live totals use the RAC. "Differs" uses a tolerance of 0.005. Changing a line's type (the handler at `:8510` overwrites `unitCost`) must never delete or alter an existing RAC.

**REQ-INV-013 — One shared cost resolver; every consumer uses it.** One function resolves a line's unit cost; `cInv()` (`:5472-5476`), `calcInv()` (`:8561`), `buildInvLines()` (`:5345`) and the PO cost written by `autoPos()` (`:9018`) all call it. The resolution reproduces today's behaviour for every line without an RAC, including that today's code ignores `lineType` when a `lid` resolves:
1. a **product** line with an RAC present → the RAC;
2. otherwise, if the line's `lid` resolves to a catalogue item (any `lineType` — preserved as-is, see INV-GAP-011) → the item's **current** catalogue cost;
3. otherwise the legacy `unitCost` (else 0). Quick-add lines, AI-created lines (`:12739`) and pass-through/charge lines without a `lid` land here.

`rILT()`'s display of a pass-through line's cost as its price (`:8478`) is not changed by this REQ; it is a display concern, not a calculation input.

**REQ-INV-014 — Introducing the RAC and the resolver changes no reported figure.** Every existing line has no RAC and so resolves exactly as today (REQ-INV-013). This includes `cInv()`'s third COGS path (stored `calc_cogs` is used for cost-less lines, `:5477-5482`), which is preserved unchanged. **REQ-INV-017 is the only requirement that changes any reported figure**, and AC16 enumerates exactly which.

**REQ-INV-015 — Freeze legacy lines (operator-triggered).** A button in Settings stamps each eligible line with the **current catalogue cost** as its RAC. Eligible: product, catalogue-linked, no RAC yet, catalogue cost greater than 0, on a non-credit-note invoice of any status. Skipped and listed (not an error): dangling `lid`, zero/blank catalogue cost, non-product lines. It must:
- (a) first show lines/invoices to be stamped and **require a completed full backup export** (the same mandatory-backup pattern the Cloud Data migration buttons use) before enabling confirmation;
- (b) require an explicit confirmation;
- (c) compute `iCalc()` `cogs`, `gp`, `np` and `mgn` for every invoice before and after (tolerance 0.005) and **abort without writing anything** if any figure would change;
- (d) be idempotent, the marker being the RAC on the line itself (no device marker);
- (e) report "N lines stamped on M invoices, 0 figures changed", and separately list lines whose add-time `unitCost` snapshot (`:8468`) differs from the current catalogue cost (they are stamped at the current cost, because anything else would change figures);
- (f) write one `logEv('invoice', id, …)` per stamped invoice;
- (g) never run on load.

**REQ-INV-016 — Correct a locked invoice's line cost (dedicated narrow action; decision Q4).** Not the Unlock Invoice path. It edits only one catalogue-linked product line's RAC. It must:
- identify the line by `rid`; a legacy line lacking `rid` is given one in the same write as the RAC (`:8626` already generates one on save);
- be available only for **catalogue-linked product lines** (a `lid` that resolves) on non-credit-note invoices that have lines. Unlinked product lines (their cost is `unitCost`) and pass-through/charge lines are excluded; correcting an unlinked line on a locked invoice continues to use the existing Unlock path;
- require a reason, trimmed, at least 5 characters;
- show the invoice's net profit before and after;
- **not go through `saveInv()` or the invoice form** and change nothing else: after the action the invoice differs from before only in that line's RAC, the line's `rid` if it had to be assigned, `editHistory`, and `updAt`;
- append an `editHistory[]` entry in the existing shape `{ts, reason, actor, changes:[{field,from,to}]}` with `field` = `lineItems[<rid>].actualCost`;
- not clear buyer approval or change status, and not trigger Shipment, PO, deposit-recovery or webhook side effects.

**REQ-INV-017 — Cost and profit figures come from the lines when the invoice has lines (decision Q1).** For an invoice that has lines, `iCalc()` returns `cogs`, `gp`, `np` and `mgn` from `cInv()` (live), not from stored `calc_cogs`/`calc_grossProfit`/`calc_netProfit`/`calc_margin`. `mgn` is `cInv()`'s own `np / grand` (computed on `cInv()`'s own `grand`). **Exception, explicit:** where `cInv()` itself uses stored `calc_cogs` because the lines are cost-less (REQ-INV-014), `iCalc()` returns that result; this is the only stored-COGS path for an invoice with lines. **Scope is cost and profit only.** Billed amounts (`grand`, `liT`, `tax`, `dep`, `bal`) and every buyer-facing document (including `buildInvDocHtml()`'s existing preference for stored `calc_grandTotal`, `:10522`) are untouched; where stored and live `grand` differ, AC16's report flags the invoice. Line-less invoices keep their stored figures. This contradicts the existing test named `iCalc — uses calc_grandTotal over live liT` (`tests/run.js`), which the SPEC must revisit.

**REQ-INV-018 — Actual cost never reaches a buyer.** No RAC, resolved cost or cost-derived margin may appear in: the invoice document and preview (`buildInvDocHtml()` `:10514`, `prevInvDoc()` `:10654` including the form-fed call at `:10463`), the credit-note and pro-forma documents, the Buyer Approved webhook payload (`saveInvApprove()` `:8921`; its `lineItems` field whitelist at `:8960` **stays a whitelist** — no spread of the line object), the buyer statement, any email/PDF path, or any buyer-facing export. (The AI assistant is an internal tool; see §7.)

**REQ-INV-019 — Existing gates unchanged.** `invLineHasCostBasis()` (`:8390`) and the supplier gate keep their behaviour; a catalogue link alone still satisfies the cost-basis gate. **Known residual, unchanged:** a linked line whose catalogue cost is 0 or blank passes that gate at 100% margin (the INV-GAP-006 class).

**REQ-INV-020 — Sheets and Cloud Data.** The RAC rides inside `line_items` and survives `refreshInvFromSupabase()`. For Sheets: the per-line `unitCost` column written by `buildInvLines()` (`:5345`, pushed at `:5362`) must show the resolved cost from REQ-INV-013; `FIELD_MAPS.inv` (`:5018`) `calc_*` sync is unchanged; a `pullAll` must not drop or alter an RAC.

**REQ-INV-021 — A recorded cost must be greater than zero (decision Q5).** Applies to operator-entered values (form cell, REQ-INV-016 action). A value that is not *present* (§3) is refused with a message pointing to Pass-through/Charge for zero-cost items. The refusal fires when the cell loses focus or the action is submitted, and again in `vInv()` at save for any line whose RAC is not greater than 0. A legacy line with no RAC is unaffected.

**REQ-INV-022 — The RAC survives save, reopen and save.** The `lineItems` literal in `saveInv()` (`:8626`) must persist the RAC. An invoice saved, reopened in the form and saved again keeps every line's RAC. (`saveInv()`'s `unitCost:+li.unitCost||0` currently turns an undefined value into 0; the SPEC must keep "recorded" distinguishable from "not recorded".)

**REQ-INV-023 — Every cost/profit consumer reads the same figures.** After this change no consumer may read stored `calc_cogs` directly; the only permitted use of stored COGS for an invoice with lines is `cInv()`'s own third path for cost-less lines (REQ-INV-014/017). Known consumers, to be confirmed complete in the SPEC by exhaustive search:

| Consumer | Today | Required |
|---|---|---|
| Dashboard `rDash()` (net profit and margin tiles; it has no COGS figure) | `iCalc()` | follows REQ-INV-017 |
| Invoice list `rInv()`, `ordRealisedMargin()` | `iCalc()` | follows REQ-INV-017 |
| P&L report `renderPLReport()` | `iCalc()` for revenue/net profit but `+inv.calc_cogs` for COGS (`:9783`) and its zero-COGS warning (`:9755`) | COGS equals `iCalc(inv).cogs`. Its gross-profit definition (`grand − cogs`) is unchanged and out of scope |
| P&L export `exportPLCSV()` | `iCalc()` + `+inv.calc_cogs` (`:9847`) | COGS equals `iCalc(inv).cogs` |
| Invoice CSV export `expCSV()` | `cInv()` (`:13277`) | same figures as dashboard |
| Sheets lines `buildInvLines()` | catalogue cost (`:5345`) | resolved cost (REQ-INV-020) |
| AI tools `_aiExecTool` (`:12862`) | `iCalc()` | follows REQ-INV-017 |
| PO cost `autoPos()` | catalogue cost (`:9018`) | resolved cost |

**REQ-INV-024 — Cloud-safe persistence and failure semantics.** For an invoice already on Cloud Data (`st_inv_cloud_migration_ts` set), REQ-INV-015 and REQ-INV-016 persist through `persistInvChange()` and assign to the local record only after the cloud write succeeds; a cancelled login or failed update leaves local and cloud data unchanged for that invoice. A freeze across many invoices that fails part-way must report exactly which invoices were stamped and which were not, and never leave local and cloud disagreeing. Local-only invoices (the operator's current state) use the synchronous local write.

**REQ-INV-025 — Deliverables.** `AI_SYSTEM_PROMPT`, `docs/user-guide.md`, `docs/known-gaps.md`, `STACKD_CONTEXT.md` backlog, the three version strings and the in-app changelog are updated (this repo's mandatory delivery checklist). Tests for REQ-INV-023 must call the production functions, not copies of their logic (the existing P&L test near `tests/run.js:6391` duplicates logic inline and would not catch a regression).

**REQ-INV-026 — Prerequisites fixed first.** INV-GAP-009 (line `supId` not persisted) and INV-GAP-010 (`editHistory` not carried forward) are fixed in a separate small change before this REQ is built; REQ-INV-016's audit trail and REQ-INV-022 depend on it.

**REQ-INV-027 — Form edits of an RAC on an unlocked invoice are audited.** The Unlock Invoice flow still reaches the invoice form, where REQ-INV-012 makes the cost cell editable. When an invoice is saved after unlock, the existing G-06 change list (`index.html:8692-8701`, snapshot at `:14104`) must also record every RAC change as `{field: 'lineItems[<rid>].actualCost', from, to}`. Editing an RAC through the form never clears buyer approval (cost is not a billed amount). Invoices that were never locked (Draft) get no audit entry, as for every other field today.

---

## 5. Acceptance criteria (testable)

1. A product line with RAC 19.44 (catalogue 25) gives COGS qty × 19.44 in `cInv()`, `calcInv()`, `iCalc()` and the dashboard net profit, identical in all.
2. Changing the catalogue cost from 25 to 30 after the line has an RAC does not change that invoice's COGS or net profit.
3. **The RAC survives its catalogue item being deleted** (or its `lid` no longer resolving): COGS stays qty × RAC (the legacy line in the same situation gives 0, as today).
4. For a corpus of invoices with **no** RAC, `cInv()` output is byte-identical before and after the change. The corpus must include: a catalogue-linked product line; an unlinked product line with `unitCost`; a pass-through line with no `lid`; **a pass-through line carrying a resolvable `lid`**; a charge line; a product line with a dangling `lid` and `unitCost` 0; and a cost-less-lines invoice using stored `calc_cogs`.
5. The cost-less-lines carve-out holds: an invoice whose lines carry no `lid` and no `unitCost` key, with stored `calc_cogs`, returns that stored COGS from both `cInv()` and `iCalc()` (the existing test `iCalc — uses calc_grandTotal over live liT` is revisited, not silently deleted).
6. Adding from the catalogue records an RAC only when the catalogue cost is > 0.
7. The freeze: shows counts and requires a completed backup export before confirmation; aborts with nothing written if any invoice's `cogs/gp/np/mgn` would change; lists skipped lines; reports lines whose add-time snapshot differs; stamps nothing on a second run; writes one event per stamped invoice.
8. The cost cell of a catalogue-linked line is editable; editing updates line margin and form totals immediately; `Catalogue <cost>` shows when RAC and catalogue differ by more than 0.005; switching lineType and back preserves the RAC.
9. The PO created by `autoPos()` for a line with an RAC uses the RAC.
10. The correction action on a Paid invoice: refuses a whitespace-only or <5-character reason; refuses a value that is not present (§3); refuses credit notes, line-less invoices, unlinked product lines and non-product lines; on success the invoice differs only in that line's RAC, the line's `rid` if newly assigned, `editHistory` (one new entry, `field` `lineItems[<rid>].actualCost`) and `updAt`; approval, status, Shipments, POs and webhooks untouched.
11. After a second unlock-and-save, `editHistory` still contains the correction's entry (needs REQ-INV-026).
12. **Form edit audit:** unlock a Paid invoice, change a line's RAC in the form, save: `editHistory` gains a change `lineItems[<rid>].actualCost` from/to; buyer approval is unchanged.
13. For an invoice with lines and stale stored `calc_*`, every surface in REQ-INV-023's table shows live `cogs/gp/np/mgn` (reproduces INV10030: stored 4,652.18, from lines 2,380); `grand`, `bal` and the printed invoice document are unchanged.
14. Consistency: for the same invoice set, summed `iCalc(inv).cogs` equals the P&L report COGS and the P&L export COGS; dashboard net profit equals the P&L net profit; `expCSV()` agrees.
15. Buyer confidentiality: with sentinel RAC values distinct from every price, quantity and total (for example 7.3197), no buyer-facing artefact — invoice document, preview from the form, credit note, pro-forma, webhook payload, statement — contains the sentinel or a cost-derived margin; the webhook `lineItems` stays a whitelist.
16. An invoice saved, reopened and saved again keeps every line's RAC (REQ-INV-022). A before/after list of every invoice whose cost/profit figures move under REQ-INV-017, and every invoice whose stored and live `grand` differ, is producible; whether INV10030 is the only one is **to be confirmed by this list**, not assumed.
17. On a Cloud-Data invoice, a cancelled login or failed update during the correction or freeze leaves local and cloud unchanged for that invoice (REQ-INV-024); the part-failure report is exact.
18. Cloud Data round-trip preserves the RAC; `buildInvLines()` writes the resolved cost; a `pullAll` leaves the RAC unchanged.
19. The cost-basis gate and supplier gate tests pass unmodified.
20. Mutation checks: reverting the resolver to catalogue-only fails criteria 1-3; removing the REQ-INV-017 change fails 13; removing the buyer-facing exclusion fails 15; removing the freeze's abort-on-change fails 7; removing the G-06 extension fails 12.

---

## 6. Out of scope

- **Actual cost of freight, delivery and other header charges** (`lf`, `ins`, `leg`, `isp`, `oth`) — decided (Q3): a separate REQ, not yet drafted. Until then billed freight counts as margin when "charges included" is ticked.
- Multi-currency conversion of cost. Existing code compares catalogue cost and invoice currency without conversion (`:5474`); this REQ does not fix that. The Unit Cost cell is labelled with the invoice currency.
- `autoPos()` hard-codes PO currency `'USD'` (`:9018` region); not changed here.
- The billed-amount preference for stored `calc_grandTotal` in `buildInvDocHtml()` (`:10522`) — noted, not changed.
- The `autoPos` drift check compares only quantity and price (`:9313-9335`), so an RAC change will not flag a stale PO; `saveInv()`'s catalogue price-history push (`:8797`) records the catalogue cost, not the RAC. Both are out of scope.
- The pass-through-with-`lid` quirk (INV-GAP-011) and legacy lines exposed to catalogue deletion (INV-GAP-008) are preserved/unfixed.
- Catalogue behaviour, catalogue price history, Quote costing, dashboard average-margin definition.

---

## 7. Risks and data-flow notes

- **Behaviour change to reported profit (REQ-INV-017):** invoices with lines and stale stored figures will change. AC16's list is the proof of which invoices move; the operator expects INV10030, and the migration's stored figures for INV10028 (`:16164`) make that unverifiable from the repo alone. The operator's own sheet says INV10030's true profit is 2,446.50; from lines it will read 2,380 (a 66.50 residual) until a one-off cost is recorded via REQ-INV-016.
- **The earlier stopgap:** if the operator applied the one-off console correction to INV10030/INV10028, those stored values are ignored once REQ-INV-017 ships and both invoices revert to line-based figures until their real costs are recorded via REQ-INV-016. This is by design.
- **GDPR / data flow:** cost is commercial, not personal. It is stored on invoice lines, transmitted to Supabase (`line_items`), to Google Sheets (via `buildInvLines()`), and to Anthropic through the internal AI assistant tools. It must not reach Make.com or the buyer (REQ-INV-018). No supplier contact data is involved.
- **Legacy `unitCost: 0` is ambiguous** (means "use catalogue" on old linked lines); hence a distinct RAC key (§8.2).
- **Freeze bakes in today's catalogue cost** where a catalogue cost was edited after a sale; stated to the operator in the freeze report.
- **Locked-invoice correction is a new write path** around the unlock flow; it must not become a way to alter billed amounts (REQ-INV-016, AC8).
- **Test impact:** fixtures that rely on catalogue-cost resolution; precedent REQ-INV-002 touched 20+.

---

## 8. Operator decisions and open SPEC items

### 8.1 Decisions (resolved 2026-11-08)
Q1 lines beat stored figures for cost/profit — **Yes** (REQ-INV-017). Q2 freeze — **button** (REQ-INV-015). Q3 freight cost — **separate REQ**. Q4 locked-invoice cost correction — **narrow action** (REQ-INV-016). Q5 zero cost — **refused** (REQ-INV-021).

### 8.2 For the SPEC (technical)
Representation of RAC (distinct key); location of the freeze button and correction action in the UI; the single shared resolver's name and signature; exhaustive consumer search to confirm REQ-INV-023; whether `pullAll` touches invoice lines (REQ-INV-020); fixture audit.

---

## 9. Review findings and how they are answered

**Round 1 (v2, FAIL):** B1 resolution order → REQ-INV-013. B2 third COGS path → REQ-INV-014/017. B3 "real lines" → §3, REQ-INV-017. B4 consumers → REQ-INV-023. B5 Sheets → REQ-INV-020. B6 persistence → REQ-INV-022, §1.1. B7 Cloud → REQ-INV-024. B8 editHistory → §1.1, REQ-INV-016/026/027. B9 eligibility → REQ-INV-016. B10 zero-cost → REQ-INV-011/015/021. B11 freeze → REQ-INV-015. A1-A8 as in v3.

**Round 2 (v3, FAIL):** N1 REQ-INV-014 vs -017 → REQ-INV-014 retitled and scoped, -017 named as the only figure-changing requirement. N2 REQ-INV-023 vs third path → explicit carve-out in REQ-INV-017/023, AC5. N3 dangling-`lid` RAC → REQ-INV-010 and §3 (RAC wins), AC3. N4 pass-through with `lid` → REQ-INV-013 reproduces today's behaviour; AC4 fixture; INV-GAP-011. N5 unaudited form edit → REQ-INV-027, AC12. N6 `rid` contradiction → REQ-INV-016, AC10. A-1 margin base → REQ-INV-017. A-2 "present" → §3. A-3 AC wording → AC14, REQ-INV-023 table. A-4 INV10028 prediction → §7, AC16. A-5 PO drift/price history → §6. A-6 tolerance/approval → REQ-INV-012, -027. A-7 unlinked lines → REQ-INV-016. A-8 gate residual → REQ-INV-019. Citation drift → `:10522`; tests cited by name.

## 10. Process

Citation check (`node scripts/check-req-citations.js docs/REQ-INV-003-v4.md`) → `requirements-gate` round 3 (capped at 3 consecutive clean rounds) → SPEC → `schema-migration-reviewer` + `spec-gate` → build → `build-gate`. REQ-INV-026 (the two prerequisite fixes) ships first and independently.
