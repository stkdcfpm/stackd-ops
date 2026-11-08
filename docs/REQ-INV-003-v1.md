# REQ-INV-003-v1: An invoice line carries its own actual cost (one-off supplier prices, no retroactive drift)

**Status:** v1 — DRAFT. Not yet reviewed by `requirements-gate`. Open questions in §7 need operator decisions before SPEC work.
**Type:** Behaviour change to existing invoice cost/profit calculation. New per-line field inside the existing `lineItems` structure. No new `K`/`DB` entity.
**Raised by:** operator, after a live reconciliation of INV10030 and INV10028 against the operator's own supplier cost sheets (this session).

---

## 1. Business context

Profit per order is the number the operator makes decisions on. Reconciling two real invoices showed the app cannot currently produce a trustworthy per-order profit, for three separate reasons that share one root cause: **an invoice does not own its cost.**

### 1.1 What was found, with evidence

| # | Finding | Evidence |
|---|---|---|
| F1 | **A one-off supplier price cannot be recorded on a catalogue-linked line.** | INV10028, "PVC Foam Board 34mm" ×200: catalogue cost 25, operator-confirmed one-off price actually paid 19.44 (supplier proforma). The line's Unit Cost cell is read-only when the line is catalogue-linked (`index.html:8479`, `:8506`), and COGS ignores any value on the line (`index.html:5473-5475`). The only way to record 19.44 today is to change the catalogue, which the operator confirmed would be wrong (25 is the standing cost). Net profit shown 3,603.80; real 4,715.80 (with the 1,098 freight still counted as margin). |
| F2 | **Editing a catalogue cost silently rewrites the profit of every old invoice using that item.** | `cInv()` multiplies qty by the item's *current* catalogue cost (`index.html:5473-5474`), `calcInv()` likewise (`index.html:8561`). The same 34mm item is used on INV10028 and INV10031 (confirmed live): changing it for one would have changed both, retroactively. |
| F3 | **Saved figures and live figures disagree and the dashboard uses the stale ones.** | INV10030 has 5 real line items, but `iCalc()` prefers stored `calc_*` fields (`index.html:5589-5591`) written at CSV import: stored COGS 9,527.82 / net profit 4,652.18; live (from lines) 11,800 / 2,380; operator's real cost sheet 11,733.50 / 2,446.50. The dashboard overstated net profit by 2,205.68 for that invoice (about £1,655 on the Net Profit tile). Stored values beat live values even when real lines exist. |

### 1.2 The cost is already half-captured and then ignored

`addILI()` already copies the catalogue cost onto the new line as `unitCost` at the moment the line is added (`index.html:8468`), but `cInv()`/`calcInv()` never read it for catalogue-linked lines, `rILT()` shows the *current* catalogue cost instead (`index.html:8478`), and lines created before that assignment exist carry `unitCost: 0` or no `unitCost` at all (INV10028, INV10030 — both confirmed live). So the fix is mostly "use what is already stored", plus a safe path for legacy lines.

### 1.3 Cost of leaving it

Two invoices needed a manual console correction of stored figures to be right. The operator confirmed one-off supplier prices are routine. Without this change every such order needs the same manual correction, and a later re-save of the invoice silently discards it.

---

## 2. FM-1 assessment

Changes the shape of a persisted entity (adds an optional key to each element of `DB.inv[].lineItems[]`). No new entity, no new `K` key. Invoice lines already travel as one opaque `jsonb` column to Cloud Data (`line_items: inv.lineItems` — `index.html:6569` in `persistInvChange()`, `:7421` in `migrateInvToSupabase()`; `:6558` is the credit-note branch of the same function), so no Supabase migration is expected — the same way `line.markup` rides inside Quote `lines`. Because it alters a persisted entity's structure, **the `schema-migration-reviewer` must review the SPEC** (hard gate per this repo's process).

---

## 3. Requirements

**REQ-INV-010 — Per-line actual cost is authoritative.**
Every `lineType === 'product'` invoice line must be able to carry its own actual unit cost (invoice currency). When a line carries one, it is the cost used for that line in *every* COGS, gross-profit, net-profit and margin calculation, whether or not the line is catalogue-linked.

**REQ-INV-011 — Captured from the catalogue at the moment of sale; later catalogue edits must not move an already-saved invoice.**
Adding a line from the catalogue must store the catalogue cost *at that moment* on the line as its actual cost (extending what `index.html:8468` already does). After that, editing the catalogue cost must not change that invoice's COGS or profit.

**REQ-INV-012 — The operator can edit a catalogue-linked line's actual cost on the invoice form.**
The Unit Cost cell of a catalogue-linked product line (read-only today, `index.html:8479`) must become editable. When the line's actual cost differs from the item's current catalogue cost, the line must show that clearly (for example "catalogue 25.00") so a one-off price is visible rather than hidden. Line margin and the form's live totals must use the actual cost. Pass-through and Charge lines are unchanged.

**REQ-INV-013 — One shared helper, every consumer reads it.**
A single function resolves a line's unit cost (mirroring how `invLineHasCostBasis()` at `index.html:8390` is the single shared predicate for the cost-basis gate). `cInv()` (`:5472-5476`), `calcInv()` (`:8561`), `rILT()` (`:8478`) and the PO cost written by `autoPos()` (`:9018`) must all call it, so they cannot diverge. Resolution order: the line's own actual cost if present; otherwise the current catalogue cost if the line is catalogue-linked (legacy behaviour); otherwise `0`.

**REQ-INV-014 — No reported figure changes on the day this ships.**
Lines without a recorded actual cost (every existing line) must keep resolving through the legacy fallback in REQ-INV-013, so no invoice's COGS or profit moves at release.

**REQ-INV-015 — A way to freeze legacy lines.**
Provide an idempotent way to stamp each existing catalogue-linked line with the current catalogue cost as its actual cost, so historical invoices stop being exposed to later catalogue edits (F2). By construction it must change **no** reported figure at the moment it runs. See open question Q2 (automatic vs operator-triggered).

**REQ-INV-016 — Correct a locked invoice's cost without reopening its billing.**
Invoices that are Sent/Partially Paid/Paid/Cancelled are locked (`LOCKED_STATUSES`). Correcting a cost does not change what the buyer was billed, so the operator must be able to correct a line's actual cost on a locked invoice **without** unlocking its price, quantity, buyer or status fields. The correction must write an `editHistory[]` entry (the existing G-06 mechanism, `index.html:8702`), must not clear buyer approval, and must not trigger Shipment, PO, deposit-recovery or webhook side effects. See open question Q4.

**REQ-INV-017 — Stored `calc_*` figures must not override real line items.**
For an invoice that has real line items, every tile, list, report and export must compute from the lines (live). Stored `calc_*` values apply only to invoices with no line items (CSV-imported summary records). This is a deliberate behaviour change to `iCalc()` (`index.html:5582-5593`) and contradicts the existing test `iCalc — uses calc_grandTotal over live liT` (`tests/run.js:3645`), which must be revisited by the SPEC. See open question Q1.

**REQ-INV-018 — Actual cost is never shown to a buyer.**
Actual cost must not appear in any buyer-facing output: the invoice document and preview (`buildInvDocHtml()`, `index.html:10514`; `prevInvDoc()`, `:10654`), the Buyer Approved webhook payload (which embeds the rendered invoice, `saveInvApprove()` `:8921`, `fireWebhookRules()` `:14007`), the buyer statement, and any buyer-facing export. Cost is commercially sensitive.

**REQ-INV-019 — Existing gates unchanged.**
The product-line cost-basis gate (REQ-INV-005 to -008, `invLineHasCostBasis()`) and supplier gate (REQ/SPEC-LI-002) keep their current behaviour. A catalogue-linked line still satisfies the cost-basis gate by its link alone.

**REQ-INV-020 — Cloud Data and Sheets.**
The new per-line field must round-trip through Cloud Data unchanged (inside `line_items`) and survive `refreshInvFromSupabase()`. Whether invoice lines are included in the Sheets sync must be confirmed in the SPEC; if they are, the field must not corrupt that sync.

---

## 4. Acceptance criteria (testable)

1. A catalogue-linked line with its own actual cost of 19.44 (catalogue 25) yields COGS qty × 19.44 in `cInv()`, `calcInv()` and the dashboard, and the same net profit in all three.
2. Changing the catalogue cost from 25 to 30 after the invoice was saved with an actual cost does **not** change that invoice's COGS or net profit.
3. A legacy line (no actual cost recorded) still resolves to the current catalogue cost, and an invoice made only of legacy lines has byte-identical `cInv()` output before and after this change.
4. After running the freeze (REQ-INV-015), every figure on every invoice is unchanged; running it twice changes nothing further.
5. A catalogue-linked line's Unit Cost cell is editable; editing it updates line margin and the form totals immediately; the line shows the catalogue cost when it differs.
6. The PO created by `autoPos()` for a line with a one-off actual cost uses that cost.
7. On a locked (Paid) invoice, correcting a line's actual cost changes only that line's cost and appends one `editHistory[]` entry; status, price, quantity, buyer approval, Shipments and POs are untouched.
8. An invoice with real line items and stale stored `calc_*` values shows live figures everywhere (reproduces INV10030: stored 4,652.18, live from lines 2,380 → every surface shows 2,380). A line-less imported invoice still uses its stored figures.
9. No buyer-facing artefact (document HTML, preview, webhook payload, statement) contains the actual cost values; a test searches for them and fails if found.
10. The cost-basis gate and supplier gate tests pass unmodified.
11. A Cloud Data round-trip of an invoice preserves each line's actual cost.
12. Mutation checks: reverting the shared helper to catalogue-only fails criteria 1 and 2; removing the buyer-facing exclusion fails criterion 9.

---

## 5. Out of scope

- **Actual cost of freight, delivery and other header charges** (`lf`, `ins`, `leg`, `isp`, `oth`). With "charges included" ticked these count as 100% margin because no cost is recorded (INV10028 books 1,098 of freight as profit; INV10030's sheet shows 52.50 of delivery cost against 470 billed). This is a related but separate gap and a separate REQ if wanted. See Q3.
- Multi-currency conversion of cost. Existing behaviour already assumes catalogue-cost currency equals invoice currency (`index.html:5474` does no conversion). This REQ must not make that worse and should label the currency, but does not fix it.
- Changing catalogue behaviour, catalogue price history, or Quote costing.
- Reworking the dashboard's average-margin definition.

---

## 6. Risks

- **Behaviour change to reported profit (REQ-INV-017).** Any invoice with real lines *and* stale stored figures will change on the dashboard. Today that is one invoice (INV10030, already known). The operator should see a before/after.
- **Legacy `unitCost: 0` is ambiguous.** Existing catalogue-linked lines carry `unitCost: 0` meaning "use the catalogue", so a plain zero cannot be trusted as a recorded cost. The SPEC must pick an unambiguous representation (a distinct field, or an explicit marker) rather than overloading `unitCost`.
- **Test-suite impact.** Many fixtures build `cIL` lines and rely on catalogue-cost resolution; the SPEC must audit them (precedent: REQ-INV-002 touched 20+ fixtures).
- **Freezing bakes in today's catalogue cost.** If a catalogue cost was edited after a sale, the frozen value is the edited one. This is unavoidable and must be stated to the operator.
- **Locked-invoice correction is a new write path** around the existing unlock flow; it must not become a way to alter billed amounts.

---

## 7. Open questions for the operator

| # | Question | Recommended default |
|---|---|---|
| Q1 | For invoices that have real lines, always compute from the lines (REQ-INV-017)? This changes INV10030's dashboard figure. | **Yes.** It is the root cause of F3. |
| Q2 | Freeze legacy lines automatically at load, or only when the operator clicks a button in Settings? | **Operator-triggered**, with a "no figures change" confirmation, because it writes to every invoice including Paid ones. |
| Q3 | Include freight/delivery actual cost in this REQ? | **No — separate REQ**, to keep this one reviewable. |
| Q4 | Correcting cost on a locked invoice: a narrow dedicated action (recommended), or just use the existing Unlock Invoice path? | **Narrow action**: the unlock path reopens billing fields and risks side effects. |
| Q5 | Should a recorded actual cost of exactly 0 be allowed on a catalogue-linked line (free sample)? | **No** for now; keep the existing gate behaviour (REQ-INV-019). |

---

## 8. Process

Per this repo's gate process: citation check (`node scripts/check-req-citations.js docs/REQ-INV-003-v1.md`) → independent `requirements-gate` review → SPEC → `schema-migration-reviewer` + `spec-gate` → build → `build-gate`. Review rounds should be capped up front (operator preference, set after REQ-WH-001's 19-round history): three consecutive clean rounds, then stop.

Estimated build size once specified: moderate. Touches `cInv`, `iCalc`, `calcInv`, `rILT`, `addILI`, `autoPos`, `saveInv` plus one new helper and one new narrow cost-correction action; roughly 25-35 new tests plus fixture repair.
