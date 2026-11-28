# SPEC-QTE-006: Freight as its own line on the customer quote (engine contract + customer document)

**Status:** v3 — resolves spec-gate round 2 (v2: FAIL, 10 findings incl. 2 blocking; map in §15). Not yet re-gated. Implements `docs/REQ-QTE-006-v7.md` (requirements-gate round 4: CONDITIONAL PASS, wording findings applied).
**Version target:** v2.9.107 (deploy order: migration 0011 first — §13). **Files touched:** `index.html`, `tests/run.js`, `supabase/migrations/0011_quotes_freight_treatment.sql`, docs.
**Schema impact:** two additive nullable columns on `quotes` (`freight_treatment text`, `freight_amount numeric`) — `schema-migration-reviewer` required. No localStorage key/entity change (two optional fields on an existing record).
**GDPR / data flow:** commercial amounts and an enum on an existing record; no personal data; Cloud-migrated quotes already sit in the existing Supabase project; no new external flow. The freight figure and the word "estimate" print to the buyer by design.
Citations measured at `main` aa7131e (+ docs); `node scripts/check-req-citations.js` run before submission.

**REQ erratum (applied to REQ-QTE-006-v7 in the same commit):** REQ-QTE6-007 said the "Freight, Insurance and DG columns" stay visible. The internal sheet has no DG-amount column (`prevQteDoc` `16419`), and the editor grid (`rQLT` `15412`) has only an **Ins $** column plus a DG *checkbox*. The suffix rule applies to the columns that exist (internal sheet: Freight, Insurance; editor: Ins $). Consequently, for `separate`, a DG line's `dgAmt` is inside the Freight row total but in no per-line cell, so the internal sheet's per-line cells do not sum to the Freight row — pre-existing (today `dgAmt` is already inside Landed with no cell). The per-line Freight cell shows `calc.freight` (CBM freight alone), not `freightEst`.

---

## 1. Summary

| # | Change | Where |
|---|---|---|
| 1 | `qteFreightTreatment()` / `qteFreightTyped()` pure helpers | new, just before `cQteLine()` (`14980`) |
| 2 | `cQteLine()` 6th param; landed = cost + duty for non-included | `14980-15001` |
| 3 | `qteSellTotals()` 6th param `freightLine` | `15021` |
| 4 | `cQte()` computes `freightEst`, `freightLine`, `freightUsd`, via `qteFreightFigures()`, passes treatment | `15031` |
| 5 | Form: `qf-fr` select, `qf-frAmt` input, `qteFrSync()`, validation in `vQte()` | modal `3002-3012`, `15590` |
| 6 | `rQLT()` / `calcQte()` / `saveQte()` read the form and pass the treatment | `15412`, `15516`, `15602` |
| 7 | Versioning trigger + history `ft` field | `saveQte()` `15642-15645` |
| 8 | Cloud Data: four row builders + migration 0011 | `6619`, `6858`, `7395`, `15687` |
| 9 | Customer model/doc: Freight row, warnings `frest`/`frzero`/`frexc`, Shipping line | `qteCustomerModel` `16224`, `qteCustWarnings` `16288` |
| 10 | Internal costing sheet, editor summary/footer, history panel | `prevQteDoc` `16401`, `3043`, `renderQteLineHistory` `15480` |
| 11 | Snapshot ids, open/edit reset/load | `qteFormSnapshot` `16377`, `openQte` `15084`, `editQte` `15114` |
| 12 | Docs, `AI_SYSTEM_PROMPT`, changelog, version strings, tests | §10, §11 |

**Unchanged (confirmed):** `rfqLandedGBP()` (`4263`, four-argument `cQteLine` call — stays `included` semantics), `qteToPoConvert()` (reads `l.cost`, never `cQte`), the promotion queue (no `cQteLine` call), `buildPdfHeader()`, the REQ-QTE5 reconciliation rule (printed Total = Σ printed lines + printed rows).

---

## 2. Pure helpers and engine (REQ-QTE6-001, -002)

```js
// The only place the three treatment values are interpreted. undefined, '' and any unknown string -> 'included'.
function qteFreightTreatment(v) { return (v === 'separate' || v === 'excluded') ? v : 'included'; }
// A typed freight amount: a finite number >= 0, else null (blank/absent/invalid never counts as typed).
function qteFreightTyped(v) { if (v === undefined || v === null || v === '') return null; var n = +v; return (isFinite(n) && n >= 0) ? n : null; }
```

```js
// The ONE place the freight figures are computed; cQte(), calcQte() and saveQte() all call it.
// ft: any value (normalised here); amountRaw: a number, a string from the form, or undefined.
function qteFreightFigures(lineCalcs, ft, amountRaw) {
  ft = qteFreightTreatment(ft);
  var freightUsd = lineCalcs.reduce(function(s,c){ return s + c.freight; }, 0);                       // CBM-driven freight in USD (NOT a CBM count) — the frzero key
  var freightEst = lineCalcs.reduce(function(s,c){ return s + c.freight + c.dgAmt + c.ins; }, 0);     // informational unless separate
  var typed = qteFreightTyped(amountRaw);
  var isTyped = ft === 'separate' && typed !== null;
  var freightLine = ft === 'separate' ? (typed !== null ? typed : freightEst) : 0;
  return { freightTreatment: ft, freightUsd: freightUsd, freightEst: freightEst, freightLine: freightLine, freightTyped: isTyped };
}
```

`cQteLine(line, qr, freightMode, totalCBM, quoteInsRateRaw, freightTreatment)` — all existing statements unchanged except the last two:

```js
  var ft = qteFreightTreatment(freightTreatment);
  var landed = ft === 'included' ? cost + freight + dgAmt + ins + duty : cost + duty;   // same expression, same order, for included
  return { freight: freight, dgAmt: dgAmt, ins: ins, insPct: insPct, duty: duty, landed: landed, freightTreatment: ft };
```
Per-line `freight`, `dgAmt`, `ins` keep returning their computed values for **every** treatment (`ins` keeps the `(cost + freight) × rate` basis; `excluded` and typed amounts simply ignore them in prices). Callers: `rfqLandedGBP` (`4263`) omits the 6th argument → `included`; `cQte`, `rQLT`, `calcQte`, `saveQte` pass the treatment (§4).

`qteSellTotals(lines, lineCalcs, quoteMarkup, overheadTotal, fxGBPUSD, freightLine)`:
```js
  sellUSD += overheadTotal;                 // unchanged
  var fl = +freightLine || 0; sellUSD += fl; // unmarked, like overhead
  return { sellUSD: sellUSD, sellGBP: sellGBP, overhead: overheadTotal, freightLine: fl };
```
Existing callers (`15040`, `15535`, `15652`) pass no sixth argument unless §4 says so.

`cQte(qt)`:
```js
  var ft = qteFreightTreatment(qt.freightTreatment);
  var lineCalcs = lines.map(function(l){ return cQteLine(l, qr, mode, totalCBM, qt.insRate, ft); });
  var totalLanded = lineCalcs.reduce(function(s,c){ return s + c.landed; }, 0);
  var fig = qteFreightFigures(lineCalcs, ft, qt.freightAmount);            // qt.freightAmount is a stored number or absent
  var totals = qteSellTotals(lines, lineCalcs, markup, overheadEff.total, qr.fxGBPUSD, fig.freightLine);
  var quotedTotal = totalLanded + fig.freightLine + totals.overhead;
  return { …existing keys…, quotedTotal: quotedTotal, freightTreatment: fig.freightTreatment, freightEst: fig.freightEst, freightUsd: fig.freightUsd, freightLine: fig.freightLine, freightTyped: fig.freightTyped };
```
**Callers of `qteFreightFigures`:** `cQte` (above, `qt.freightAmount`), `calcQte` and `saveQte` (`qteFreightFigures(lineCalcs, ff.ft, ff.amtRaw)`, the form string; `saveQte` then uses `fig.freightLine` for `qteSellTotals` and the stored `calc_*`). Because `qteFreightTyped` accepts both a number and a string, all three paths interpret the amount identically.

**Verified standalone** (`scratchpad/spec6-engine.js`, the §3.4 REQ example, 1 line cost 10,000 / CBM 20 / LCL $100 / ins 0.5% / markup 20%): included sell 14,472 quotedTotal 12,060; separate-estimate landed 10,000 freightLine 2,060 sell 14,060 quoted 12,060; separate-typed-1,800 sell 13,800 quoted 11,800; excluded sell 12,000 quoted 10,000. `calc_totalLanded` (stored, `15671`) is `totalLanded`, ex-freight/insurance/DG for non-included quotes; user guide states this.

## 3. Form (REQ-QTE6-001)

HTML after `qf-mode` (`3008`):
```html
<div class="fld"><label>Freight in the customer quote</label>
  <select id="qf-fr" onchange="qteFrSync()">
    <option value="included">Included in line prices</option>
    <option value="separate">Shown as a separate line</option>
    <option value="excluded">Not included (ex-works / FOB)</option>
  </select></div>
<div class="fld" id="qf-frAmt-wrap" style="display:none;"><label>Freight amount ($)</label>
  <input type="number" id="qf-frAmt" min="0" max="10000000" step="any" placeholder="Blank = estimate from CBM" oninput="qteFrAmtInput()"></div>
<div id="qt-fr-foot" style="font-size:.5rem;color:var(--m);margin-bottom:8px;"></div>   <!-- placed between the summary grid (3052) and #qt-feasibility -->
```
```js
function qteFrAmtInput() { syncQLFromDOM(); rQLT(); calcQte(); }      // header suffix depends on typed-or-not, so the grid re-renders; typing in lines is synced first
function qteFrApply() {                         // LOAD-SAFE: visibility + stale-amount clear only. NEVER reads the grid DOM into cQL.
  var ft = qteFreightTreatment(G('qf-fr') ? G('qf-fr').value : '');
  if (G('qf-frAmt-wrap')) G('qf-frAmt-wrap').style.display = ft === 'separate' ? '' : 'none';
  if (ft !== 'separate' && G('qf-frAmt')) G('qf-frAmt').value = '';     // a stale figure can never resurrect
  syncQLFromDOM();                              // rQLT() builds from cQL and never reads the inputs; without this a treatment change discards typed line edits
  rQLT(); calcQte();
}
function qteFormFreight() {   // the one reader every form-driven path uses
  var ft = qteFreightTreatment(G('qf-fr') ? G('qf-fr').value : '');
  return { ft: ft, amtRaw: ft === 'separate' && G('qf-frAmt') ? String(G('qf-frAmt').value).trim() : '' };
}
```
Note on `type=number`: a real browser reads non-numeric text as `''` (silently "blank = estimate"); the `abc` case in T-8 exercises only the mock, and the browser itself blocks non-numeric characters. `vQte()` (`15590`) gains, before the `errs.length` test:
```js
  var ff = qteFormFreight();
  if (ff.ft === 'separate' && ff.amtRaw !== '' && qteFreightTyped(ff.amtRaw) === null) errs.push('Freight amount must be a number from 0 to 10,000,000, or blank');
  else if (ff.ft === 'separate' && ff.amtRaw !== '' && +ff.amtRaw > 10000000) errs.push('Freight amount must be a number from 0 to 10,000,000, or blank');
```
`openQte()` (reset block `15094-15103`): `G('qf-fr').value = 'included'; G('qf-frAmt').value = ''; qteFrSync();` — placed **before** the existing `rQLT()` call and before `_qOpenSnap = qteFormSnapshot()`. `editQte()`: `G('qf-fr').value = qteFreightTreatment(q.freightTreatment); G('qf-frAmt').value = (qteFreightTreatment(q.freightTreatment) === 'separate' && q.freightAmount !== undefined) ? String(q.freightAmount) : ''; qteFrSync();` before its `rQLT()`/`calcQte()`. `qteFormSnapshot()` header id list (`16380`) gains `'qf-fr'` and `'qf-frAmt'`. `saveQteSetup()` in `tests/run.js` (`899`) resets both (`mockEl('qf-fr').value = 'included'; mockEl('qf-frAmt').value = ''`).

## 4. Form-driven paths (REQ-QTE6-002)

- `rQLT()` (`15412`): `var ff = qteFormFreight();` `cQteLine(l, QR, mode, totalCBM, quoteInsRateRaw, ff.ft)`. Header for the **Landed** column: `ff.ft === 'included' ? 'Landed' : 'Landed (cost + duty)'`; header for **Ins $**: `'Ins $' + qteFrSuffix(ff)`.
- `qteFrSuffix(ff)`: `included` → `''`; `excluded` → `' (not charged)'`; `separate` with `qteFreightTyped(ff.amtRaw) !== null` → `' (replaced by typed freight)'`; else `' (in Freight row)'`. Used by `rQLT`, `prevQteDoc` (Freight and Insurance headers).
- `calcQte()` (`15516`): `var ff = qteFormFreight();` pass `ff.ft` to `cQteLine`; `var fig = qteFreightFigures(lineCalcs, ff.ft, ff.amtRaw);` (the shared helper of §2, so `calcQte()` and `cQte()` cannot diverge); `qteSellTotals(..., freightLine)`. New summary cell `qt-freight` ("Freight line", `$` + `fn(freightLine,0)` + ` (estimate)` when separate & not typed; `-` otherwise) added to the grid at `3043`. Footer element `qt-fr-foot` (below the grid) renders the REQ-QTE6-007 per-treatment text exactly: `separate`/no typed → `Freight estimate $X (N lines with no CBM)`; `separate`/typed → `Freight estimate $X (N lines with no CBM) — using typed $Y. Insurance % has no effect while a typed freight amount is used`; `excluded` → `Freight not included. Insurance % has no effect while freight is not included`; `included` → empty. `N` = count of lines with `+cbm = 0`. The empty-state reset list at `15518` (`['qt-orig',…,'qt-sell-gbp']`) gains `'qt-freight'` and `'qt-fr-foot'` so removing every line never leaves a stale figure.
- `saveQte()` (`15602`): `var ff = qteFormFreight();` `cQteLine(..., insRateOvRaw, ff.ft)`; `var fig = qteFreightFigures(lineCalcs, ff.ft, ff.amtRaw);` `qteSellTotals(..., fig.freightLine)`; record: `if (ff.ft !== 'included') qt.freightTreatment = ff.ft; if (ff.ft === 'separate' && qteFreightTyped(ff.amtRaw) !== null) qt.freightAmount = +ff.amtRaw;` (keys omitted otherwise, never `undefined`); `calc_*` from the new totals (`totalLanded` ex-freight for non-included).
- **Versioning (REQ-QTE6-006):** inside the per-line loop at `15642`:
  `var curFt = ff.ft; var changed = !lastV || lastV.cost !== l.cost || lastV.dutyPct !== l.dutyPct || lastV.markup !== effM || lastV.insRate !== calcR.insPct || (lastV.ft || 'included') !== curFt;` and the pushed entry gains `ft: curFt`. A typed-amount-only change does not version lines.

## 5. Cloud Data (REQ-QTE6-008)

Migration `supabase/migrations/0011_quotes_freight_treatment.sql`:
```sql
-- REQ/SPEC-QTE-006: additive nullable columns. Null = Included in line prices / no typed freight amount.
alter table quotes
  add column freight_treatment text,
  add column freight_amount numeric;
```
Four row builders each gain `freight_treatment: qt.freightTreatment != null ? qt.freightTreatment : null, freight_amount: qt.freightAmount != null ? qt.freightAmount : null` (variable `q` in the migrate insert): `persistQteChange()` update literal (`6858-6868`), the `migrateQteToSupabase()` insert (`7389-7399`), `saveQte()`'s `qtRow` (`15687-15700`). The refresh mapping (`6619-6626`) adds, using the bare guard: `if (row.freight_treatment != null) q.freightTreatment = row.freight_treatment; if (row.freight_amount != null) q.freightAmount = row.freight_amount;` (never `!= null ? val : undefined`). Local branch (`15657`) writes the record as built in §4. Sheets: `FIELD_MAPS.qt` unchanged; `mergePulledWithLocal()` (`5301`) preserves local-only fields — pinned by test. Note **`persistQteChange` is called from 9 sites** (status changes etc.); without its two new columns any status change would null `freight_*` in Supabase.

## 6. Customer document (REQ-QTE6-003/-004/-005)

`qteCustomerModel(q)` (`16224`): after `var c = cQte(q)`, add a freight charge **first** in `charges[]`:
```js
  var frAmt = qteRound2(c.freightLine);
  var freightRow = (c.freightTreatment === 'separate' && frAmt > 0) ? { key: 'freight', label: c.freightTyped ? 'Freight' : 'Freight (estimate)', amount: frAmt } : null;
  var charges = (freightRow ? [freightRow] : []).concat([ …existing three, filtered by amount > 0… ]);
```
Return additionally `freight: { treatment: c.freightTreatment, typed: c.freightTyped, amount: frAmt, freightUsd: qteRound2(c.freightUsd), printed: !!freightRow }   // freightUsd is a DOLLAR amount (Σ line.freight), not CBM`. The Total, rows and `engineTotal: c.sellUSD` are otherwise unchanged (`engineTotal` now includes freight; `calc_sellUSD` stored the same way, so no false drift).
`qteCustomerDocHtml`: the "Shipping: <mode>" text (`16273`) is printed only when `c.freightTreatment !== 'excluded'` (the model exposes `freight.treatment`).
`qteCustWarnings(q, m, text)` (`16288`) adds:
```js
  var fr = m.freight;
  if (fr.treatment === 'separate') {
    if ((!fr.typed && fr.freightUsd === 0) || (fr.typed && fr.amount === 0)) out.push({ k: 'frzero', lvl: 'ack', t: 'No freight is calculated (no CBM or rate): the Freight row would show insurance only, or no row at all for a typed 0. Check before sending' });
    else if (!fr.typed && fr.amount >= 0.01) out.push({ k: 'frest', lvl: 'ack', t: 'The Freight row is an estimate from CBM rates and insurance — the forwarder’s figure may differ' });
  } else if (fr.treatment === 'excluded') out.push({ k: 'frexc', lvl: 'warn', t: 'Freight is not included — make sure your price basis says so' });
```
(`fr.freightUsd` is `qteRound2(Σ line.freight)`; the CBM test is guarded by `!fr.typed`, so a typed forwarder amount on a CBM-less quote raises nothing; `frzero` and `frest` are mutually exclusive.) A typed amount `> 0` raises no freight warning. Ack keys use the existing `<quote id>|<k>` convention (`16319`), so `qteCustGenerate()` re-enforcement needs no change. **Reconciliation bound:** `|printed Total − sellUSD| ≤ Σ over product lines (0.00005 × qty + 0.005) + 0.005 × 4`, asserted numerically in T-9.

## 7. Internal surfaces (REQ-QTE6-007)

- `prevQteDoc` (`16401`): `var ft = c.freightTreatment;` per-line cells unchanged (values from `c.lineCalcs[i]`); table headers: `Freight` + suffix, `Insurance` + suffix, `Landed` → `Landed (cost + duty)` when `ft !== 'included'`; header line gains `Freight: shown separately` / `Freight: not included` after `Mode:` when applicable; totals block gains a row `Freight` + `fn(c.freightLine,0)` + (estimate/typed) for `separate` before Sell Price. INTERNAL banner unchanged.
- `renderQteLineHistory` (`15480`): the `v` cell appends a muted note — `Freight: shown separately` or `Freight: not included` — when `(v.ft || 'included') !== 'included'`.
- `calcFeasibility()` untouched.

## 8. Data / privacy

Covered in the header; `schema-migration-reviewer` to confirm the additive migration, `persistQteChange` coverage and the `!= null` guard.

## 9. Backwards compatibility

A quote without the new fields behaves identically: `cQte()` output for every existing fixture is byte-identical (pinned, T-1); the editor shows "Included in line prices"; Cloud rows with null columns load with no new keys (`'freightTreatment' in q === false`).

## 10. Tests (`tests/run.js`; `testAsync` for any async body; every new test that sets `qf-fr`/`qf-frAmt` resets them at its own end, plus a hygiene test per the SPEC-LI-002 precedent, because only 34 of ~76 `saveQte` tests use `saveQteSetup`)

| ID | Asserts |
|---|---|
| T-1 | Included regression: pinned `cQte()` results for fixtures — plain line, DG line, line `Ins %` override, quote `insRate` override, FCL 20GP and 40HQ, LCL; and `rfqLandedGBP` unchanged |
| T-2 | §3.4 table, all 4 columns incl. `freightLine`, `sellUSD`, `quotedTotal`, `landed`; line `ins` still returned |
| T-3 | `qteFreightTreatment` normalisation (undefined, '', 'foo', 'Separate' → included); `qteFreightTyped` (blank, '0', 0, -1, 'abc', NaN, '1e3'); `qteFreightFigures` returns the documented keys and is the single source (number and string amount identical) |
| T-4 | DG line: `included` landed contains `dgAmt`; `separate` moves it into `freightEst` (not landed); `excluded` drops it |
| T-5 | Per-line `Ins %` and quote `insRate` flow into `freightEst` for separate; no effect on totals with a typed amount or `excluded` |
| T-6 | `calcQte()` DOM figures (`qt-freight`, `qt-sell-usd`, `qt-landed`) equal `cQte()` for all three treatments; `qt-fr-foot` text exactly per treatment (4 strings) and the empty-lines reset clears `qt-freight`/`qt-fr-foot` |
| T-7 | `saveQte()` stores `freightTreatment`/`freightAmount` only when set (`'freightTreatment' in q === false` for included; typed 0 stored; blank omitted); `calc_*` include freight; **a freshly saved `separate` quote raises no `drift` ack in `qteCustWarnings`** (AC 7) |
| T-8 | `vQte()` blocks `-1`, `abc`, `10000001`; accepts blank, `0`, `10000000` |
| T-9 | Customer doc: Freight row first, labels "Freight"/"Freight (estimate)", zero amount prints no row, reconciliation bound asserted numerically including 4 sub-half-cent charges |
| T-10 | Sentinels: `lclPerCBM`, container rates, markup %, insurance %, a line CBM value and a typed-vs-estimate delta, each set to a unique sentinel, never appear in the customer HTML (guards a future change that would print them) |
| T-11 | Warnings: `frest` (ack, blocks `qteCustGenerate` until ticked), `frzero` for CBM 0 with insurance > 0 and for typed 0, `frexc` warn; `frest` absent when rounded amount < 0.01; **no freight warning for a typed amount > 0 on a CBM-less quote** |
| T-12 | `excluded`: no freight row, no "Shipping:" line; `separate`/`included` still print it |
| T-13 | Versioning: treatment change creates a new version with `ft`; typed-amount-only change does not; `''` ≡ included |
| T-14 | `qteFormSnapshot` differs when `qf-fr` or `qf-frAmt` change; `openQte`/`editQte` reset/load; switching away from separate clears the amount; **line inputs typed before a treatment change (and before a typed-amount keystroke) survive the re-render** |
| T-15a-d | Cloud, **one assertion per builder** (mock `_sb` capturing payloads): `saveQte` `qtRow`, `persistQteChange` update literal, `migrateQteToSupabase` insert, `refreshQteFromSupabase` mapping (keys omitted when null, present when set, `'freightTreatment' in q === false`); a status change via `persistQteChange` keeps `freight_*` |
| T-16 | Sheets pull (`mergePulledWithLocal`) preserves `freightTreatment`/`freightAmount` |
| T-17 | Internal sheet headers (Freight/Insurance suffix, `Landed (cost + duty)`) and totals row per treatment; history panel note; INTERNAL banner intact; **`rQLT` Ins $ / Landed headers and suffix rule per treatment and typed-or-not** |
| T-18 | Call-site test: enumerates `cQteLine(` in `index.html`, maps each to its **enclosing function name** (`rfqLandedGBP`, `cQte`, `rQLT`, `calcQte`, `saveQte`) and fails on any other |
| T-19 | `AI_SYSTEM_PROMPT` states the three treatments and that AI-created quotes are Included; **behavioural: a quote created through the AI `create_quote` path has no `freightTreatment` key** |
| T-20 | `qteToPoConvert()` on a `separate` quote creates PO lines from `l.cost` only — no freight/insurance/DG amounts appear |
| T-21 | Hygiene: after the suite's freight tests, `qf-fr` is `'included'` and `qf-frAmt` is `''` (mock leak guard) |

`fmt(`/`fmtN(` call-count guards in `tests/run.js` (currently 89 and 17): this change adds `fn(`/`fmt(` calls only in `rQLT`/`prevQteDoc`/`calcQte` display strings; the implementer records the measured before/after counts and updates the guard constants deliberately, as REQ-QTE-004 did (7 → 13 → 17).

## 11. Mutation tests (each run in a scratch copy with `docs/`, `scripts/`, `triage.html`, `apps-script/`, `tests/fixtures.js` copied so unrelated tests don't add noise; each must fail the predicted test)

1. `cQteLine`: landed always includes freight → T-2/T-4. 2. `qteSellTotals`: drop `freightLine` → T-2/T-9. 3. `qteFreightFigures`: `freightEst` omits `ins` → T-2. 4. `qteFreightFigures`: omits `dgAmt` → T-4. 5. `frzero` keyed on `freightLine` (whole estimate) → T-11. 6. `frzero` missing the `!fr.typed` guard → T-11 (typed amount, CBM-less). 7. `frest` ack removed → T-11. 8. `excluded` still prints Shipping → T-12. 9. versioning ignores `ft` → T-13. 10. `qteFormSnapshot` ids removed → T-14. 11. `persistQteChange` literal missing columns → T-15b. 12. refresh uses `!= null ? val : undefined` → T-15d. 13. `vQte` allows negative → T-8. 14. freight row not first / label wrong → T-9. 15. **`excluded` branch: `freightLine` uses `ft !== 'included'` (so excluded charges freight) → T-2/T-4.** 16. `qteFrSync` omits `syncQLFromDOM()` → T-14. 17. `qteFrSync` fails to clear the amount → T-14. 18. `calcQte` computes freight inline instead of via `qteFreightFigures` and diverges → T-6. 19. Sentinel injection: temporarily print `fig.freightUsd` in the Freight row label → T-10 (proves the sentinel test would catch a leak; this is the only mutation that adds a print). 20. `saveQte` stores `calc_sellUSD` without freight → T-7 (drift ack).

## 12. Docs and delivery

`AI_SYSTEM_PROMPT` (three treatments; estimate/typed; insurance and DG travel with freight; AI-created quotes are Included; no apostrophes in the single-quoted strings), `docs/data-model.md` (Quote record shape + Mermaid ERD: `freightTreatment`, `freightAmount`, columns), `docs/dr-procedure.md` (migration 0011 before app deploy), `docs/user-guide.md` (Quotes section: treatments, estimate tick, `calc_totalLanded` reads lower, Sheets "Grand Total" label), in-app changelog, three version strings → v2.9.107, `CLAUDE.md`, `docs/version-history.md`, `docs/known-gaps.md`, `STACKD_CONTEXT.md`, `docs/requirements-tracker.md`, Notion rows (aggregate wording), PR on request. `fmt(`/`fmtN(` call-count guards in `tests/run.js` re-checked after the build.

## 13. Risks and deploy order

Insurance/DG now ride with freight, so line prices fall; the freight row carries them unmarked — operator margin on those items disappears (documented in the guide). The estimate tick is deliberate friction. **Deploy order:** migration `0011` must be applied to Supabase **before** v2.9.107 reaches any user with migrated quotes — once the new client is live, *every* Cloud `saveQte` and `persistQteChange` payload carries `freight_*` (null for Included), so every quote save would fail on unknown columns until the migration is applied, not only `separate` quotes. The PR description and `docs/dr-procedure.md` state this. **Mixed-version window (accepted):** an older cached client or second device saving a `separate`/`excluded` quote omits `freight_*`, so the stored columns remain set but that client refreshes the quote as Included and prices it accordingly; the next save from the newer client restores it. Accepted for a single-operator tool; the migration note says to hard-refresh devices after deploy.

## 14. Spec-gate round 1 map (v1 FAIL → v2)

1 `frzero` guard `!fr.typed` + T-11/mutation 6 (§6, §10, §11). 2 `qteFrSync` calls `syncQLFromDOM()` + T-14/mutation 16 (§3). 3 `qteFrAmtInput()` re-render (§3). 4 `qteFreightFigures` fully specified, single source, `cQte` uses it (§2, §4). 5 tests added: T-6 footer text, T-7 no-drift, T-15a-d per builder, T-17 `rQLT` headers, T-19 behavioural, T-20 PO, T-18 keyed by function name (§10). 6 mutations 15 (excluded branch), 6 (typed guard), 19 (sentinel injection point) (§11). 7 deploy-order and mixed-version text (§13). 8 `qt-fr-foot` HTML and empty-state reset (§3, §4). 9 REQ erratum stated and applied (header). 10 `fr.cbm` → `fr.freightUsd` (§6). 11 `type=number` note (§3). 12 hygiene test T-21 and fmt-guard recording rule (§10). 13 `docs/data-model.md` and `dr-procedure.md` (§12).
