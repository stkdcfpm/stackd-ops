# REQ-QTE-006 — Freight shown as its own line on the customer quote

**Status:** v2 DRAFT — operator decisions (2026-11-28) folded in; not yet through the requirements-gate.
**Type:** Feature (engine presentation + customer document). Needs one additive Supabase migration (§5).
**Operator statement (2026-11-28):** "freight should be shown as its own line as I don't always have the full breakdown till production completes and the local charges become available."
**Builds on:** REQ-QTE-005 (customer quote, v2.9.106), REQ/SPEC-QTE-002 (per-quote overhead overrides), REQ/SPEC-QTE-003 (insurance override).

## 1. Problem (verified against live code)
`cQteLine()` (`index.html:14980`) computes `landed = cost + freight + dg + insurance + duty`, with freight from the line's CBM and the Freight Mode (`14984-14990`) and insurance = (cost + freight) × rate (`14997`). Each line's selling price is `landed × (1 + effective markup%)` (`qteSellTotals`, `15021`; `qteCustomerModel`, `16224`). So international freight is **always inside every line's selling price, and carries the line's markup**. The customer document has no freight line (`16232-16236` lists only origin / destination / admin). The three overhead overrides do not affect freight (a real operator was caught out by this on 2026-11-28: all three set to $0, freight still present).

Consequences for the operator: (a) the freight figure used in a quote is a CBM-rate estimate that can be wrong until the forwarder quotes after production; (b) the buyer cannot see or later adjust freight separately; (c) there is no way to quote ex-works/FOB (no freight at all).

## 2. Proposed behaviour (defaults proposed; confirm in §7)
New quote-level field **Freight treatment** with three values:
1. **Included in line prices** (default; today's behaviour, byte-identical results for every existing quote).
2. **Shown as a separate line** — line selling prices exclude freight; the customer document prints a **Freight** row after the product lines (before the overhead rows).
3. **Not included** (EXW/FOB style) — no freight anywhere on the customer document; the document's Price basis should say so (operator wording).

For **Separate**: a quote-level **Freight amount (USD)** field. Blank = use the engine's CBM estimate (sum of line freights); a typed value (including 0) overrides it, with the same "blank inherits, any value overrides" shape as the existing overhead overrides. **Freight is always passed through at cost — no markup, and no markup field** (operator decision 7-1).

## 3. Requirements
- **REQ-QTE6-001 — Treatment field and persistence.** `Quote.freightTreatment` (`'included'|'separate'|'excluded'`; absent = `'included'`), `Quote.freightAmount` (omitted from the record when blank, never stored as `undefined`, same rule as `originCharges`/`insRate`). Form fields on the Quote modal; included in `qteFormSnapshot()` so the unsaved-changes guard sees them.
- **REQ-QTE6-002 — Engine.** `cQteLine()`/`cQte()` gain the treatment. For `separate`/`excluded`, each line's `landed` excludes freight; **insurance is computed on cost only (cargo value, excluding freight), stays inside the line prices and is never shown as its own row** (decision 7-3; this lowers line prices slightly versus `included` for the same cargo, to be stated in the user guide). For `included` nothing changes — a regression test pins every existing `cQte()` output for a fixed set of quotes.
- **REQ-QTE6-003 — Customer document.** `qteCustomerModel()` adds a `freight` charge row (label "Freight" when the operator typed an amount, or "Freight (estimate)" while the amount is blank and the engine estimate is used; never marked up), printed before the overhead rows; the printed Total stays the sum of the printed lines and rows (REQ-QTE5 reconciliation rule unchanged).
- **REQ-QTE6-004 — Nothing internal leaks.** The freight row shows one buyer-facing amount only; CBM, rate, container mode costs, markup % and insurance never print. The REQ-QTE5 sentinel test is extended with the new fields.
- **REQ-QTE6-005 — Pre-send warnings.** Dialog warns when: treatment is `separate` and the amount is blank (printing an estimate — needs a tick); treatment is `excluded` and the Price basis text still says anything containing "CIF"/"freight included" (best-effort, listed only); treatment is `included` and the quote mode is unchanged (no new warning).
- **REQ-QTE6-006 — Internal costing sheet** and the Quote editor show the new treatment, freight amount and the engine estimate side by side so the operator can see estimate vs entered figure.
- **REQ-QTE6-007 — Cloud Data.** Two nullable columns on `quotes` (`freight_treatment text`, `freight_amount numeric`; migration `0011_quotes_freight_treatment.sql`, additive-only); all Cloud Data touchpoints for Quote extended (insert, update, refresh mapping with the bare `!= null` guard, migration function) — `schema-migration-reviewer` required.
- **REQ-QTE6-008 — Docs and assistant.** `AI_SYSTEM_PROMPT`, `docs/user-guide.md`, changelog, version strings, tracker rows.

## 4. Out of scope
Free-form extra charge lines (Phase 2, QTE-GAP follow-up); per-line freight override; multiple currencies (QTE-GAP-004); stored issued copies (QTE-GAP-006); changing the FCL/LCL rate engine itself.

## 5. Data / GDPR
New fields are commercial amounts on an existing record; no personal data. For Cloud-migrated quotes they travel to the existing Supabase project with the quote — no new external flow. Local-only quotes unaffected.

## 6. Acceptance criteria (draft)
1. An `included` quote's `cQte()` results are unchanged to the cent for every existing fixture.
2. `separate` with a typed amount prints that amount as one Freight row; line prices exclude freight; Total = Σ printed lines + rows.
3. `separate` with blank amount prints the engine estimate, labelled as an estimate, and the dialog requires a tick.
4. `excluded` prints no freight row and no freight inside line prices.
5. Sentinel test: CBM, rate, markup and insurance values never appear in the customer document.
6. Round trip through Cloud Data preserves the three fields; absent fields stay absent (`'x' in obj === false`).
7. Mutation tests for each guard; full suite green.

## 7. Operator decisions (answered 2026-11-28)
1. **Markup on freight:** none — at cost.
2. **While freight is unknown:** print the CBM estimate labelled "Freight (estimate)"; the pre-send dialog requires a tick.
3. **Insurance when freight is separate:** inside line prices, computed on cost only; stated in the user guide.
4. **Existing quotes:** all stay `included`.
5. **Timing:** ships after the current container quote, which uses the interim workaround (zero line CBM, freight entered in Destination charges).

## 8. Risks
- Freight at cost means total margin on the quote falls versus today wherever freight was previously marked up — the operator's margin maths change silently if not made visible (REQ-QTE6-006).
- Moving insurance off (cost + freight) changes pricing for `separate` quotes versus `included` ones for the same cargo.
