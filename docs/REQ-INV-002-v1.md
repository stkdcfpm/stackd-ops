# REQ-INV-002-v1: Block saving a Product line item with no cost basis

## Business Context

Reported directly by the user, investigated live against real production data this session (INV10028, INV10029, INV10031). `quickAddLine()` (`index.html:8139-8157`) lets an operator add a `lineType: 'product'` line item with `unitCost` defaulting to `0` when the Unit Cost field is left blank, and with no catalogue link (`lid`) at all — manual entry never sets one. `_updQaWarn()` (`index.html:8159-8174`, shipped under REQ/SPEC-INV-001) already detects this condition accurately and shows an amber warning banner, but it is advisory only — nothing stops the invoice from being saved.

Confirmed live: three real, already-Paid or Sent invoices carried this exact defect before being corrected this session —

- **INV10031** (Sent): "Pallets x3" — 3 × $57 = $171 of revenue booked with `unitCost: 0`, no `lid`.
- **INV10028** (Paid): "Pallets x9" ($610.20) and the "Qingdao to BB 40FT HQ container charge..." line ($5,540.07) — both `unitCost: 0`, no `lid`. Together $6,150.27 of revenue misreported as 100% margin.
- **INV10029** (Paid): 3 Reolink SKUs, each with `unitCost` manually typed equal to sell price (a deliberate, confirmed pass-through — not this defect, but adjacent enough that it was investigated as a candidate before being ruled out).

The zero-cost lines on INV10031/INV10028 inflated GP by $6,321.27 combined and NP by the same amount (since neither line carried any charge-side offset), on invoices already Paid and already reported. This REQ closes the entry point that created them, rather than relying solely on an operator noticing a banner.

Distinct from REQ-INV-001: that REQ fixed the warning's *trigger condition* so it stops false-alarming on legitimate cost-equals-price pass-through lines (e.g. INV10032's freight lines). This REQ does not change the warning at all — it adds a hard save-time block using the same, already-correct condition REQ-INV-001 established, scoped specifically to lines that are genuinely zero-cost (never to a line where `unitCost` is populated with any positive value, including a value equal to `up`, since that is a legitimate deliberate margin-free entry per REQ-INV-001's own AC-002).

## FM-1 Assessment

Pure validation-logic change to existing entry/save functions in `index.html` — no new `K`/`DB` entity, no new field, no schema change, no Sheets sync change. Outside FM-1's scope (same category as REQ-INV-001).

## Requirements

**REQ-INV-005**: `quickAddLine()` must refuse to add a line item to `cIL` when `lineType === 'product'` and the computed `unitCost` is `0` or not a positive number. On refusal, the form must not clear, the line must not be pushed, and the operator must see a clear message naming the two ways to resolve it (enter a real cost, or change the line's Type to Pass-thru/Charge if there genuinely is no separate cost to record).

**REQ-INV-006**: This gate applies only to `lineType === 'product'`. It must never block a `'pass-through'` line (which by design always carries `unitCost === up`, per the existing `qaTypeChg()`/`quickAddLine()` sync logic) or a `'charge'` line. Note: a `'charge'` line is **not** exempt from COGS/GP/NP arithmetic itself — `calcInv()`'s cogs reduction (`index.html:8245`) and `cInv()`'s equivalent (`index.html:5339-5343`) both fold any line's `unitCost` into COGS regardless of `lineType`; `rILT()`'s "CHRG" tag (`index.html:8194-8195`) only suppresses the per-line margin *display*, it does not exempt the line from the calculation. The reason `'charge'` is exempt from this REQ's block is different: a charge line (bank fee, documentation fee, etc.) is a distinct category where `$0` cost is frequently the deliberately-correct value, not a sign of missing data — unlike a `'product'` line, where a real physical/purchased good with `$0` recorded cost is the actual defect this REQ exists to catch.

**REQ-INV-007**: A save-time backstop must exist independent of `quickAddLine()`, since an operator can still produce a zero-cost `'product'` line without going through it — most directly, by editing an already-added line's Unit Cost input in the live line-item table (`rILT()`'s `oninput` handlers, `index.html:8211`) down to `0` or blank after adding it with a valid cost, a path `quickAddLine()`'s own entry gate cannot see. `saveInv()`/`vInv()` (`index.html:10597-10647`) must refuse to save the invoice — for the non-credit-note path only — while any line in `cIL` has `lineType === 'product'` (or an absent/legacy `lineType`, which defaults to `'product'` elsewhere in this codebase, e.g. `index.html:8185`) and neither a `lid` resolving to a real `DB.li` record nor a positive `unitCost`.

**REQ-INV-008**: Within REQ-INV-007's `lineType === 'product'` scope, the "no cost basis" sub-condition itself (no `lid` match — including a dangling `lid` that no longer resolves — **and** `unitCost` falsy) must reuse `_updQaWarn()`'s already-shipped, already-correct lid-resolution/cost-falsy logic (`index.html:8160-8164`) rather than inventing a second, potentially-divergent definition. Note `_updQaWarn()`'s own condition, read verbatim, carries no `lineType` scoping of its own — it is REQ-INV-007 that supplies the `lineType === 'product'` gate this sub-condition sits inside; do not copy `_updQaWarn()`'s callback wholesale and treat that as satisfying REQ-INV-006, or a `'charge'`/`'pass-through'` line would be wrongly blocked. Two independent implementations of the "no cost basis" sub-condition is how this codebase's own documented history (`CLAUDE.md`'s "self-marking test contamination" pattern, a different bug class but the same root cause — divergent logic for one concept) keeps recurring.

**REQ-INV-009**: This REQ does not change what happens once an invoice is already locked (Sent/Partially Paid/Paid/Cancelled, `LOCKED_STATUSES`) and unlocked for a correction via Settings → Advanced → Unlock Invoice — the same `saveInv()`/`vInv()` path already governs that flow, so the new gate applies there too, automatically, with no separate code path required. This is a deliberate consequence, not an oversight: an operator correcting a locked invoice's line items is exactly the scenario where this gate should also catch a still-missing cost, not be bypassed for it.

## Implementation note — existing test-suite impact

`tests/run.js` has 45 separate `ctx.cIL = [...]` fixture declarations across 45 `saveInv()`/`saveCN()` call sites (the raw count of `ctx.cIL = [` occurrences; some use non-standard whitespace and were undercounted at 40 in an earlier pass of this audit — the 5 extra all carry a resolvable `lid` and are unaffected by this REQ), many written before this REQ existed and using a bare `{lid:'', desc:..., up:...}` or `unitCost:0` product line purely as generic save-path filler, unrelated to what each test is actually checking (Cloud Data migration behavior, `invoiceRefs` cleanup, price-history versioning, etc.). Confirmed concretely at `tests/run.js:10104-10136` (a Cloud Data create/update test), `tests/run.js:2660`, `:2785`, and at least 6 more sites in the `13100`–`13800` range. Implementing REQ-INV-005/REQ-INV-007 as specified will make `vInv()` return `false` on every one of these, breaking each test's ability to reach the assertions it actually exists to make — not a sign the fixtures are wrong, a sign they now need a positive `unitCost` (or a `lineType` other than `'product'`) added so they keep exercising what they were written to exercise. This audit-and-update pass across the existing suite is required implementation work for this REQ, not an incidental side effect to discover mid-build — scope it explicitly in the SPEC and build-gate review.

## Out of scope

- No change to `_updQaWarn()`'s own trigger condition or presentation (already correct per REQ-INV-001).
- No change to `addILI()`/`doPick()` (Import from Library) — both already always resolve a real catalogue cost when `lid` is set (`index.html:8175-8179`), so no line created through that path can trigger this gate.
- No retroactive validation or correction of existing saved invoices with this defect — that was handled as a manual, per-invoice data-correction exercise this session (unlock, edit, save), not as part of this code change.
- No change to CSV/Sheets import paths that create `DB.inv` records directly — this REQ is scoped to the UI save path (`saveInv()`/`vInv()`) only, since that is the confirmed origin of all three real defects found this session.

## Acceptance Criteria

- AC-001: `quickAddLine()` with `lineType: 'product'` and Unit Cost left blank (or typed as `0`) does not push a line to `cIL`, and shows an explanatory message.
- AC-002: `quickAddLine()` with `lineType: 'product'` and a positive Unit Cost succeeds unchanged from today's behavior.
- AC-003: `quickAddLine()` with `lineType: 'pass-through'` succeeds regardless of the Unit Cost field's value (unchanged from today — cost auto-syncs to price).
- AC-004: `quickAddLine()` with `lineType: 'charge'` succeeds with Unit Cost `0`/blank (unchanged from today — per REQ-INV-006, `$0` on a charge line is a deliberate business-intent value this REQ does not treat as an error, not a claim that charge lines are excluded from COGS arithmetic).
- AC-005: `saveInv()` (via `vInv()`) refuses to save — with a clear message, no partial save, no change to `DB.inv` — an invoice whose `cIL` contains any `'product'` line with no resolvable `lid` and `unitCost` of `0` or falsy, whether that line arrived via `quickAddLine()`'s (now-blocked) path or via directly editing an existing line's Unit Cost field down to zero in the live table.
- AC-006: `saveInv()` succeeds unchanged for an invoice whose `'product'` lines all have either a resolvable `lid` or a positive `unitCost`, including a line where `unitCost` was deliberately set equal to `up` (the confirmed-legitimate INV10029/INV10032 pattern) — this must never be treated as "zero cost."
- AC-007: `saveInv()` succeeds unchanged for an invoice containing `'pass-through'` or `'charge'` lines with `unitCost` of `0`, even when it also contains a genuinely-blocked `'product'` line elsewhere on the same invoice being fixed in the same edit (i.e., the check is per-line, not an all-or-nothing invoice-level flag).
- AC-008: The new save-time check does not fire for a credit note / goodwill credit (the `isCnForm` branch of `vInv()`, which returns before reaching the line-item area entirely).
- AC-009: The new save-time check runs correctly on the unlock-then-edit flow (a previously-locked invoice, unlocked via Settings → Advanced → Unlock Invoice, edited, then Save Invoice clicked) — no separate code path bypasses it.
