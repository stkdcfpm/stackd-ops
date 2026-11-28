# REQ-QTE-005 — Customer-facing Quote document (and the internal costing sheet it must stop being confused with)

**Status:** v1 DRAFT — not yet through the requirements-gate.
**Type:** Feature + safety fix. **Phase 1 needs no schema change** (renders from existing quote fields). Phase 2 (stored issued copies) needs one additive Supabase column and is specified separately in §7 so Phase 1 can ship first.
**Operator decisions (2026-11-28):** per-line selling price; freight and charges as separate lines, optional (the main use case is when local freight and taxes are known).
**Why now:** the operator needs to send a real container-load quote to a buyer and the app has no buyer-facing quote document.

---

## 1. The finding that triggered this

`prevQteDoc()` (`index.html:16155`, opened by the Quote modal's Preview button `3037`) is an **internal costing sheet**. Every line prints the **supplier name, cost, freight, insurance, duty and landed cost** (`index.html:16160-16170`, header row `16177`), the overhead charges are listed, and only the grand **Sell Price** is shown (`16190`-area). A buyer who receives it can compute FPM's margin (Sell − Landed − overhead) and can see exactly which factory to contact directly. It is not labelled internal. There is no per-line selling price, no payment terms, no bank details and no address header (it prints `AS.name · AS.email` only). Nothing is stored: the document is built in memory and opened in a new tab, so there is no record of what a buyer was actually sent (the invoice documents behave the same way, by design — `docs/user-guide.md` Invoices section).

There is also **no Quote → Invoice conversion** (the schema-only `sourceQuoteId` was removed in v2.9.58), so today the only buyer-facing document in the app is an invoice at Pro-forma status, with every unit price typed by hand.

## 2. How the pricing maths constrains the document (must be understood before design)

`cQteLine()` (`index.html:14930`) builds **landed = cost + freight + insurance + duty (+ DG surcharge)** per line, and the per-line selling price is **landed × (1 + markup%)** (`qteSellTotals()` `14971`); the three overhead components (origin, destination, FPM admin) are added **at cost, never marked up**. So:

- A per-line selling price **already contains** the international freight, insurance and destination duty for that line. A customer document that *also* listed "freight" as a separate line would double-charge unless the lines were re-split — which changes the engine's presentation and **exposes the markup on freight** (forwarder rates are discoverable, so a buyer can compare the freight line to a market quote). That is the main way a "separate freight line" leaks margin.
- The **only** charges that are genuinely separate in the maths today are the three overhead components. "Local freight and taxes are known" maps onto the existing **Destination Charges** (and, if used, Origin Charges / Admin) per-quote overrides (`REQ/SPEC-QTE-002`).

## 3. Decision on charge lines (proposed; operator to confirm)

The customer document prints, after the product lines, **only the overhead components that are non-zero**, each as its own line with a buyer-facing label: *Origin charges*, *Destination charges (local freight & taxes)*, *Handling & admin*. International freight, insurance and duty stay **inside the per-line selling prices** and are never itemised. Free-form extra charge lines (any description, any amount) are Phase 2 because they need a new stored field.

## 4. Requirements (Phase 1)

**REQ-QTE5-001 — Separate buttons, honest names.** The Quote modal's existing Preview button is renamed **"Internal costing sheet"**; a new **"Customer quote"** button opens the buyer-facing document. The internal sheet's document title and an on-page banner read **"INTERNAL — contains supplier and cost information. Do not send to the client."** (print-visible).

**REQ-QTE5-002 — Customer document contents.** Header from `buildPdfHeader()` (`11003`: logo/name, address, email/phone, reg/VAT); title **QUOTATION**; quote number, date, **Valid until** (only when set), client name; a product table with exactly: **Description, Qty, UOM, Unit price, Line total** (selling price: unit price = line selling price ÷ qty, qty ≤ 0 treated as 1; line total = `landed × (1 + effective markup%)` from `qteEffectiveMargin()`/`cQteLine()` — the same figures the quote already computes); the non-zero overhead lines (§3); a single **Total** (the sum of what is printed — REQ-QTE5-004); the Settings → Terms text (`AS.terms`, `8681`) as "Terms & conditions"; bank details (`fmtBankHtml(AS.bank)`, `11038`) when configured, otherwise nothing (no "pending" text on a quote); the company footer (`buildPdfFooter()` `11020`); page footer with the quote number and page x of y (same print-CSS technique as the invoice).

**REQ-QTE5-003 — Nothing internal can appear.** The customer document contains **no** supplier name, SKU/catalogue reference, cost, freight, insurance, duty, landed value, markup/margin percentage, DG surcharge amount, per-line version note, or price-history data. Tested by rendering a quote whose every internal field holds a unique sentinel string and asserting none appears in the output.

**REQ-QTE5-004 — Totals are what the buyer can add up.** Line totals and charge lines are rounded to the cent **for display**; the document **Total is the sum of the displayed (rounded) lines** so the page always adds up. The stored `calc_sellUSD` may differ by at most half a cent per printed line; the difference is neither printed nor corrected on the record, and a test bounds it.

**REQ-QTE5-005 — Currency.** The document is issued in USD (the engine's currency). If the quote's Currency field is not USD the button shows a one-line notice "The quote engine prices in USD; this document is in USD" with a **GBP total** line added only when the quote Currency is GBP (existing `sellGBP` figure, stored FX rate, rate printed). BBD/other conversion is out of scope (open question §8).

**REQ-QTE5-006 — Pre-send safety checks (confirm dialogs, never silent).** Before opening the document: (a) if any line description contains a Supplier's name (case-insensitive, any `DB.sup` name of ≥3 characters) → "Line N's description mentions supplier ‘X’. Edit it before sending?" (b) if the quote has Notes → "This quote has Notes. Print them on the customer quote?" — Notes are excluded unless the operator answers yes, because they have always been internal-by-habit; (c) if `validUntil` is blank → "No validity date is set — this quote would be open-ended. Continue?"; (d) if any line has cost 0 → "N line(s) have no cost basis — their selling price may be wrong. Continue?". Declining any prompt aborts the document.

**REQ-QTE5-007 — No status side effect.** Opening the document never changes the quote's status (the operator marks it Sent). A one-line hint after opening reminds them to set status to Sent.

**REQ-QTE5-008 — Escaping and downloads.** Every free-text value goes through `san()`; the document opens as an in-memory blob exactly like the other previews; the page title is `<quote number> — Quotation`.

**REQ-QTE5-009 — Docs and assistant.** `AI_SYSTEM_PROMPT` and `docs/user-guide.md` explain the two documents, the internal-only warning, the charge lines, the confirm prompts and how international freight is *inside* the line prices; changelog, version strings, tracker rows.

## 5. Out of scope for Phase 1 (disclosed, not forgotten)
- **A stored copy of what was sent** (Phase 2, §7). Until then a reprint reflects *today's* Settings, rates and catalogue — say so in the user guide.
- Free-form extra charge lines; per-line "hide this line's price"; Incoterm field; discounts; multiple options/alternatives per quote; e-mailing the quote from the app; a Quote → Invoice conversion.
- Changing any pricing maths.

## 6. Acceptance criteria (Phase 1)
1. AC-1: The customer document for a 2-line quote shows Description/Qty/UOM/Unit price/Line total with line total = landed × (1+markup); a per-line markup override changes only that line.
2. AC-2: A quote with every internal field set to a sentinel (supplier name, SKU, line note, version note, notes, internal cost) renders none of them (notes only when the operator opted in).
3. AC-3: The Total equals the sum of the printed rounded lines and charge lines; |printed Total − `calc_sellUSD`| ≤ 0.005 × number of printed lines.
4. AC-4: Overhead lines appear only when non-zero, with the buyer-facing labels; international freight/insurance/duty never appear as lines.
5. AC-5: The internal sheet carries the INTERNAL banner and title; its button is relabelled; the Customer quote button exists.
6. AC-6: Each pre-send prompt fires on its condition, and declining aborts (no window opened).
7. AC-7: Opening either document leaves the quote record and every other record byte-identical (read-only).
8. AC-8: Hostile text (`<img onerror>`) in client, description, notes and terms is escaped.
9. AC-9: A GBP-labelled quote adds the GBP total with the rate printed; other labels print USD only with the notice.
10. AC-10: Full suite green; mutation tests for: supplier column removed, cost leak, rounding-sum rule, notes opt-in, pre-send prompts.

## 7. Phase 2 (separate REQ/SPEC): stored issued copies
`quotes.issued_docs` (nullable `jsonb`, additive migration — all four Cloud Data touchpoints: insert, update, refresh mapping with the bare `!= null` guard, migration function — plus `schema-migration-reviewer`): an **Issue quote** action stores an immutable snapshot (`{n, issuedAt, quoteNum, clientName, lines[{desc, qty, uom, unit, total}], charges[], total, currency, termsText, bankText, headerText, validUntil}`) so a reprint is byte-for-byte what the buyer received regardless of later Settings/catalogue/rate changes; re-issuing increments `n`; the quote status moves to Sent on issue (with confirm); a read-only "Issued copies" list on the quote. GDPR: the snapshot holds the buyer name already on the quote and company/bank text already in Settings; no new external transmission. Open: size limit per quote; whether to also store the rendered HTML.

## 8. Open questions for the operator
1. Is the three-line overhead set (§3) enough for now, or do you need free-form extra charge lines in Phase 1 (then Phase 1 also needs the schema change)?
2. Which currency does the container buyer need — USD only, GBP, or BBD?
3. Should the document state a price basis (e.g. "CIF Bridgetown, duty paid") — the maths include international freight, insurance and destination duty in the line prices, so the buyer should know what they are paying for. Proposed: a one-line free-text "Price basis" printed under the table, taken from a new Settings field (no quote schema change).
4. Are line descriptions in your catalogue clean of supplier/factory references? Linking from the catalogue copies them onto quotes verbatim.

## 9. Risks (stated plainly)
- **Per-line selling prices still reveal structure.** A buyer comparing lines can spot inconsistent markups, benchmark against known market prices (these are commodity products), or compare unit prices across quote versions with different quantities (freight is allocated per CBM, so bulky lines carry more freight). Showing fewer, rounder prices or a single total hides more; per-line is the operator's decision.
- A separate freight line (if later added) exposes freight markup — hence §3.
- Reprints are not reproducible until Phase 2.
