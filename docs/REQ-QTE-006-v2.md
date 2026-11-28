# REQ-QTE-006 — Freight shown as its own line on the customer quote

**Status:** v1 DRAFT — not yet through the requirements-gate; **§7 decisions need the operator's answers first.**
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

For **Separate**: a quote-level **Freight amount (USD)** field. Blank = use the engine's CBM estimate (sum of line freights); a typed value (including 0) overrides it, with the same "blank inherits, any value overrides" shape as the existing overhead overrides. A quote-level **Freight markup %** (blank = 0, i.e. at cost; see §7-1).

## 3. Requirements
- **REQ-QTE6-001 — Treatment field and persistence.** `Quote.freightTreatment` (`'included'|'separate'|'excluded'`; absent = `'included'`), `Quote.freightAmount` and `Quote.freightMarkup` (each omitted from the record when blank, never stored as `undefined`, same rule as `originCharges`/`insRate`). Form fields on the Quote modal; included in `qteFormSnapshot()` so the unsaved-changes guard sees them.
- **REQ-QTE6-002 — Engine.** `cQteLine()`/`cQte()` gain the treatment. For `separate`/`excluded`, each line's `landed` excludes freight; **insurance basis is a §7-3 decision**. For `included` nothing changes — a regression test pins every existing `cQte()` output for a fixed set of quotes.
- **REQ-QTE6-003 — Customer document.** `qteCustomerModel()` adds a `freight` charge row (label "Freight", or "Freight (estimate)" while the amount is blank and the engine estimate is used — see §7-2), printed before the overhead rows; the printed Total stays the sum of the printed lines and rows (REQ-QTE5 reconciliation rule unchanged).
- **REQ-QTE6-004 — Nothing internal leaks.** The freight row shows one buyer-facing amount only; CBM, rate, container mode costs, markup % and insurance never print. The REQ-QTE5 sentinel test is extended with the new fields.
- **REQ-QTE6-005 — Pre-send warnings.** Dialog warns when: treatment is `separate` and the amount is blank (printing an estimate — needs a tick); treatment is `excluded` and the Price basis text still says anything containing "CIF"/"freight included" (best-effort, listed only); treatment is `included` and the quote mode is unchanged (no new warning).
- **REQ-QTE6-006 — Internal costing sheet** and the Quote editor show the new treatment, freight amount and the engine estimate side by side so the operator can see estimate vs entered figure.
- **REQ-QTE6-007 — Cloud Data.** Three nullable columns on `quotes` (`freight_treatment text`, `freight_amount numeric`, `freight_markup numeric`; migration `0011_quotes_freight_treatment.sql`, additive-only); all Cloud Data touchpoints for Quote extended (insert, update, refresh mapping with the bare `!= null` guard, migration function) — `schema-migration-reviewer` required.
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

## 7. Decisions needed from the operator
1. **Markup on the freight line:** at cost (0%, default proposed) or with a margin? Any margin is visible against a forwarder's quote.
2. **While freight is unknown:** print "Freight (estimate)" from the CBM engine, or require the operator to type a figure before the document can be generated (stricter, no silent estimate)? Proposed: estimate allowed with a mandatory tick.
3. **Insurance when freight is separate:** insurance is currently 0.5% of (cost + freight). Keep it on cost + freight (CIF convention — then it stays in line prices, or becomes its own row?) or on cost only? Proposed: keep it inside line prices, computed on cost only, and say so in the user guide — this slightly lowers line prices versus today.
4. **Existing quotes:** all stay `included`. Confirm.
5. **Urgency:** the current container quote can use the interim workaround (zero line CBM, enter freight in Destination charges). Confirm you are happy to ship this REQ after that quote goes out.

## 8. Risks
- Freight at cost plus line markups means total margin on the quote falls versus today wherever freight was previously marked up — the operator's margin maths change silently if not made visible (REQ-QTE6-006).
- Moving insurance off (cost + freight) changes pricing for `separate` quotes versus `included` ones for the same cargo.
