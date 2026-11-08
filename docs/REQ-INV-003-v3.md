# REQ-INV-003-v3: An invoice line carries its own actual cost (one-off supplier prices, no retroactive drift)

**Status:** v3 — DRAFT, resubmission for `requirements-gate` round 2. Revises v2 after round 1 (FAIL, 11 blocking + 8 advisory). Every round-1 finding was re-verified against the live code before being accepted (see §9). Supersedes `REQ-INV-003-v2.md` (kept unedited).
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

REQ-INV-016's audit trail is meaningless unless P2 is fixed first, and REQ-INV-022 sits in the same code. **Both are to be fixed as a small, separate change before this REQ is built** (REQ-INV-026).

---

## 2. FM-1 assessment

Changes the shape of a persisted entity (adds an optional key to elements of `DB.inv[].lineItems[]`). No new entity, no new `K` key. Invoice lines travel as one opaque `jsonb` column to Cloud Data (`line_items: inv.lineItems` — invoice row at `index.html:6569` in `persistInvChange()`; `:7432` in `migrateInvToSupabase()`; `:6558` and `:7421` are the credit-note branches), so no Supabase migration is expected. **`schema-migration-reviewer` must review the SPEC.**

---

## 3. Definitions

- **Recorded actual cost (RAC):** the new optional per-line unit cost, in the invoice's currency. Representation (a distinct key; never overloading legacy `unitCost`) is a SPEC decision (§8.2).
- **Applies to:** `lineType === 'product'` lines that are **catalogue-linked** (`lid` resolves). An unlinked product line already owns its cost in `unitCost` (existing behaviour, unchanged); pass-through and charge lines are unchanged (§4, REQ-INV-013).
- **Has lines:** `lineItems.length >= 1`.

---

## 4. Requirements

**REQ-INV-010 — Per-line actual cost is authoritative for catalogue-linked product lines.** Such a line may carry an RAC. When present it is the line's cost in every COGS, gross-profit, net-profit and margin calculation.

**REQ-INV-011 — Captured at the moment of sale.** Adding a line from the catalogue stores the catalogue cost *at that moment* as the line's RAC (extending `index.html:8468`) **only if that cost is greater than 0**. If it is 0 or blank, no RAC is recorded and the line behaves as a legacy line. After capture, editing the catalogue cost must not change that invoice's COGS or profit.

**REQ-INV-012 — Editable, with the difference visible.** The Unit Cost cell of a catalogue-linked product line (read-only today, `:8479`) becomes editable and edits the RAC. When the RAC differs from the item's current catalogue cost, the cell shows the text `Catalogue <cost>` (two decimals, invoice currency) next to it. Line margin and the form's live totals use the RAC. Changing a line's type (the handler at `:8510` overwrites `unitCost`) must never delete or alter an existing RAC.

**REQ-INV-013 — One shared cost resolver; every consumer uses it.** One function resolves a line's unit cost; `cInv()` (`:5472-5476`), `calcInv()` (`:8561`), `rILT()` (`:8478`), `buildInvLines()` (`:5345`) and the PO cost written by `autoPos()` (`:9018`) all call it. Resolution by line type:
- **product, catalogue-linked:** RAC if present; else the current catalogue cost.
- **product, not catalogue-linked** (including a dangling `lid`): legacy `unitCost` (else 0) — exactly today's behaviour. Quick-add lines and AI-created lines (`:12739`) land here.
- **pass-through / charge:** unchanged from today (pass-through cost equals its line price; charge uses its stored `unitCost`).

**REQ-INV-014 — No reported figure changes on release day.** Every existing line has no RAC and so resolves exactly as today. This includes `cInv()`'s existing third COGS path (stored `calc_cogs` is used when no line has a catalogue match or an explicit `unitCost`, `:5477-5482`), which **is preserved unchanged**.

**REQ-INV-015 — Freeze legacy lines (operator-triggered).** A button in Settings stamps each eligible line with the **current catalogue cost** as its RAC. Eligible: product, catalogue-linked, no RAC yet, catalogue cost greater than 0, on a non-credit-note invoice of any status. Skipped and listed (not an error): dangling `lid`, zero/blank catalogue cost, non-product lines. It must:
- (a) first show lines/invoices to be stamped and **require a completed full backup export** (the same mandatory-backup pattern the Cloud Data migration buttons use) before enabling confirmation;
- (b) require an explicit confirmation;
- (c) compute `iCalc()` `cogs`, `gp`, `np` and `mgn` for every invoice before and after (tolerance 0.005) and **abort without writing anything** if any figure would change;
- (d) be idempotent, the marker being the RAC on the line itself (no device marker);
- (e) report "N lines stamped on M invoices, 0 figures changed", and separately list lines whose add-time `unitCost` snapshot (`:8468`) differs from the current catalogue cost (they are stamped at the current cost, because anything else would change figures);
- (f) write one `logEv('invoice', id, …)` per stamped invoice;
- (g) never run on load.

**REQ-INV-016 — Correct a locked invoice's line cost (dedicated narrow action; decision Q4).** Not the Unlock Invoice path. It edits only one catalogue-linked product line's RAC. It must:
- identify the line by `rid`; a legacy line lacking `rid` is given one first (`:8626` already generates one on save);
- be unavailable for credit notes, line-less invoices and non-product lines;
- require a reason, trimmed, at least 5 characters;
- show the invoice's net profit before and after;
- **not go through `saveInv()` or the invoice form** and change nothing else: after the action the invoice differs from before only in that line's RAC, `editHistory`, and `updAt`;
- append an `editHistory[]` entry in the existing shape `{ts, reason, actor, changes:[{field,from,to}]}` with `field` = `lineItems[<rid>].actualCost`;
- not clear buyer approval or change status, and not trigger Shipment, PO, deposit-recovery or webhook side effects.

**REQ-INV-017 — Cost and profit figures come from the lines when the invoice has lines (decision Q1).** For an invoice that has lines, `iCalc()` returns `cogs`, `gp`, `np`, `mgn` from `cInv()` (live), not from stored `calc_cogs`/`calc_grossProfit`/`calc_netProfit`/`calc_margin`. **Scope is cost and profit only.** Billed amounts (`grand`, `liT`, `tax`, `dep`, `bal`) and every buyer-facing document (including `buildInvDocHtml()`'s existing preference for stored `calc_grandTotal`, `:10521`) are untouched. `cInv()` itself is unchanged. Line-less invoices keep their stored figures. This contradicts `tests/run.js:3645`, which the SPEC must revisit.

**REQ-INV-018 — Actual cost never reaches a buyer.** No RAC, resolved cost or cost-derived margin may appear in: the invoice document and preview (`buildInvDocHtml()` `:10514`, `prevInvDoc()` `:10654` including the form-fed call at `:10463`), the credit-note and pro-forma documents, the Buyer Approved webhook payload (`saveInvApprove()` `:8921`; its `lineItems` field whitelist at `:8960` **stays a whitelist** — no spread of the line object), the buyer statement, any email/PDF path, or any buyer-facing export. (The AI assistant is an internal tool; see §7.)

**REQ-INV-019 — Existing gates unchanged.** `invLineHasCostBasis()` (`:8390`) and the supplier gate keep their behaviour; a catalogue link alone still satisfies the cost-basis gate.

**REQ-INV-020 — Sheets and Cloud Data.** The RAC rides inside `line_items` and survives `refreshInvFromSupabase()`. For Sheets: the per-line `unitCost` column written by `buildInvLines()` (`:5345`, pushed at `:5362`) must show the resolved cost from REQ-INV-013; `FIELD_MAPS.inv` (`:5018`) `calc_*` sync is unchanged; a `pullAll` must not drop or alter an RAC.

**REQ-INV-021 — A recorded cost must be greater than zero (decision Q5).** Applies to operator-entered values (form cell, REQ-INV-016 action). A value of 0, blank, negative or non-numeric is refused with a message pointing to Pass-through/Charge for zero-cost items. The refusal fires when the cell loses focus or the action is submitted, and again in `vInv()` at save for any line whose RAC is not greater than 0. A legacy line with no RAC is unaffected.

**REQ-INV-022 — The RAC survives save, reopen and save.** The `lineItems` literal in `saveInv()` (`:8626`) must persist the RAC. An invoice saved, reopened in the form and saved again keeps every line's RAC. (`saveInv()`'s `unitCost:+li.unitCost||0` currently turns an undefined value into 0; the SPEC must keep "recorded" distinguishable from "not recorded".)

**REQ-INV-023 — Every cost/profit consumer reads the same figures.** After this change no consumer may read stored `calc_cogs` for an invoice that has lines. Known consumers, to be confirmed complete in the SPEC by exhaustive search:

| Consumer | Today | Required |
|---|---|---|
| Dashboard `rDash()` | `iCalc()` | follows REQ-INV-017 |
| Invoice list `rInv()`, `ordRealisedMargin()` | `iCalc()` | follows REQ-INV-017 |
| P&L report `renderPLReport()` | `iCalc()` for revenue/net profit but `+inv.calc_cogs` for COGS (`:9783`) and its zero-COGS warning (`:9755`) | same COGS as dashboard |
| P&L export `exportPLCSV()` | `iCalc()` + `+inv.calc_cogs` (`:9847`) | same COGS as dashboard |
| Invoice CSV export `expCSV()` | `cInv()` (`:13277`) | same figures as dashboard |
| Sheets lines `buildInvLines()` | catalogue cost (`:5345`) | resolved cost (REQ-INV-020) |
| AI tools `_aiExecTool` (`:12862`) | `iCalc()` | follows REQ-INV-017 |
| PO cost `autoPos()` | catalogue cost (`:9018`) | resolved cost |

**REQ-INV-024 — Cloud-safe persistence and failure semantics.** For an invoice already on Cloud Data (`st_inv_cloud_migration_ts` set), REQ-INV-015 and REQ-INV-016 persist through `persistInvChange()` and assign to the local record only after the cloud write succeeds; a cancelled login or failed update leaves local and cloud data unchanged for that invoice. A freeze across many invoices that fails part-way must report exactly which invoices were stamped and which were not, and never leave local and cloud disagreeing. Local-only invoices (the operator's current state) use the synchronous local write.

**REQ-INV-025 — Deliverables.** `AI_SYSTEM_PROMPT`, `docs/user-guide.md`, `docs/known-gaps.md`, `STACKD_CONTEXT.md` backlog, the three version strings and the in-app changelog are updated (this repo's mandatory delivery checklist). Tests for REQ-INV-023 must call the production functions, not copies of their logic (the existing P&L test near `tests/run.js:6391` duplicates logic inline and would not catch a regression).

**REQ-INV-026 — Prerequisites fixed first.** INV-GAP-009 (line `supId` not persisted) and INV-GAP-010 (`editHistory` not carried forward) are fixed in a separate small change before this REQ is built; REQ-INV-016's audit trail and REQ-INV-022 depend on it.

---

## 5. Acceptance criteria (testable)

1. A catalogue-linked line with RAC 19.44 (catalogue 25) gives COGS qty × 19.44 in `cInv()`, `calcInv()`, `iCalc()` and the dashboard, with identical net profit in all.
2. Changing the catalogue cost from 25 to 30 after the line has an RAC does not change that invoice's COGS or net profit.
3. For a corpus of invoices with no RAC (legacy lines, unlinked lines, pass-through, charge, line-less/third-path), `cInv()` output is byte-identical before and after the change.
4. Adding from the catalogue records the RAC only when the catalogue cost is > 0; for a 0/blank catalogue cost no RAC is recorded.
5. The freeze: shows counts and requires a completed backup export before confirmation; aborts with nothing written if any invoice's `cogs/gp/np/mgn` would change; lists skipped lines; reports lines whose add-time snapshot differs; stamps nothing on a second run; writes one event per stamped invoice.
6. The cost cell of a catalogue-linked line is editable; editing updates line margin and form totals immediately; `Catalogue <cost>` shows when RAC ≠ catalogue; switching lineType and back preserves the RAC.
7. The PO created by `autoPos()` for a line with an RAC uses the RAC.
8. The correction action on a Paid invoice: refuses a whitespace-only or <5-character reason, refuses 0/blank/negative/non-numeric (REQ-INV-021), refuses credit notes/line-less invoices/non-product lines; on success the invoice differs only in that line's RAC, `editHistory` (one new entry with `field` `lineItems[<rid>].actualCost`) and `updAt`; buyer approval, status, Shipments, POs and webhooks untouched.
9. After a second unlock-and-save, `editHistory` still contains the correction's entry (needs REQ-INV-026).
10. An invoice with lines and stale stored `calc_*` shows live `cogs/gp/np/mgn` on every surface in REQ-INV-023's table (reproduces INV10030: stored 4,652.18, from lines 2,380); `grand`, `bal` and the printed invoice document are unchanged.
11. The dashboard net profit equals the P&L report net profit and the P&L COGS equals dashboard COGS for the same filter; `expCSV()` agrees.
12. Buyer confidentiality: with sentinel RAC values distinct from every price, quantity and total (e.g. 7.3197), no buyer-facing artefact — invoice document, preview from the form, credit note, pro-forma, webhook payload, statement — contains the sentinel or a cost-derived margin; the webhook `lineItems` stays a whitelist.
13. An invoice saved, reopened and saved again keeps every line's RAC (REQ-INV-022).
14. On a Cloud-Data invoice, a cancelled login or failed update during the correction or freeze leaves local and cloud data unchanged for that invoice (REQ-INV-024); the part-failure report is exact.
15. Cloud Data round-trip preserves RAC; `buildInvLines()` writes the resolved cost; a `pullAll` leaves RAC unchanged.
16. A before/after list of every invoice whose cost/profit figures move under REQ-INV-017 is producible (expected on the operator's data: INV10030 only).
17. The cost-basis gate and supplier gate tests pass unmodified.
18. Mutation checks: reverting the resolver to catalogue-only fails criteria 1-2; removing the REQ-INV-017 change fails 10; removing the buyer-facing exclusion fails 12; removing the freeze's abort-on-change fails 5.

---

## 6. Out of scope

- **Actual cost of freight, delivery and other header charges** (`lf`, `ins`, `leg`, `isp`, `oth`) — decided (Q3): a separate REQ, not yet drafted. Until then billed freight counts as margin when "charges included" is ticked.
- Multi-currency conversion of cost. Existing code compares catalogue cost and invoice currency without conversion (`:5474`); this REQ does not fix that. The Unit Cost cell is labelled with the invoice currency.
- `autoPos()` hard-codes PO currency `'USD'` (`:9018` region); not changed here.
- The billed-amount preference for stored `calc_grandTotal` in `buildInvDocHtml()` (`:10521`) — noted, not changed.
- Catalogue behaviour, catalogue price history, Quote costing, dashboard average-margin definition.

---

## 7. Risks and data-flow notes

- **Behaviour change to reported profit (REQ-INV-017):** invoices with lines and stale stored figures will change. Expected today: INV10030 only; AC16 produces the proof. The operator's own sheet says INV10030's true profit is 2,446.50; from lines it will read 2,380 (a 66.50 residual) until a one-off cost is recorded via REQ-INV-016.
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

## 9. Round-1 findings and how v3 answers them

B1 resolution order → REQ-INV-013 by line type. B2 third COGS path → REQ-INV-014. B3 scope of "real lines" → §3, REQ-INV-017. B4 missed consumers → REQ-INV-023. B5 Sheets → REQ-INV-020. B6 persistence/whitelist → REQ-INV-022, §1.1 P1. B7 Cloud → REQ-INV-024. B8 editHistory → §1.1 P2, REQ-INV-016, REQ-INV-026. B9 line identification/eligibility → REQ-INV-016. B10 zero-cost conflicts → REQ-INV-011/015/021. B11 freeze safety → REQ-INV-015. A1 sentinel → AC12. A2 whitelist → REQ-INV-018. A3 citations → §2. A4 FPM migration → §1. A5 INV10030 residual → §7. A6 → REQ-INV-012. A7 currency → §6. A8 housekeeping → REQ-INV-025.

## 10. Process

Citation check (`node scripts/check-req-citations.js docs/REQ-INV-003-v3.md`) → `requirements-gate` round 2 (capped at 3 consecutive clean rounds) → SPEC → `schema-migration-reviewer` + `spec-gate` → build → `build-gate`. REQ-INV-026 (the two prerequisite fixes) ships first and independently.
