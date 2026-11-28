# SPEC-QTE-006: Freight as its own line on the customer quote (engine contract + customer document)

**Status:** v1 DRAFT — not yet through the spec-gate. Implements `docs/REQ-QTE-006-v7.md` (requirements-gate round 4: CONDITIONAL PASS, wording findings applied).
**Version target:** v2.9.107. **Files touched:** `index.html`, `tests/run.js`, `supabase/migrations/0011_quotes_freight_treatment.sql`, docs.
**Schema impact:** two additive nullable columns on `quotes` (`freight_treatment text`, `freight_amount numeric`) — `schema-migration-reviewer` required. No localStorage key/entity change (two optional fields on an existing record).
**GDPR / data flow:** commercial amounts and an enum on an existing record; no personal data; Cloud-migrated quotes already sit in the existing Supabase project; no new external flow. The freight figure and the word "estimate" print to the buyer by design.
Citations measured at `main` aa7131e (+ docs); `node scripts/check-req-citations.js` run before submission.

**Known REQ clarification (flagged for the gate):** REQ-QTE6-007 mentions "Freight, Insurance and DG columns". No DG column exists today in `prevQteDoc` (`16419`) or `rQLT` (`15412`); only the internal sheet has Freight and Insurance columns, and the editor grid has only **Ins $**. The suffix rule therefore applies to those that exist (internal sheet: Freight, Insurance; editor grid: Ins $); the DG amount has never had its own column and is not given one.

---

## 1. Summary

| # | Change | Where |
|---|---|---|
| 1 | `qteFreightTreatment()` / `qteFreightTyped()` pure helpers | new, just before `cQteLine()` (`14980`) |
| 2 | `cQteLine()` 6th param; landed = cost + duty for non-included | `14980-15001` |
| 3 | `qteSellTotals()` 6th param `freightLine` | `15021` |
| 4 | `cQte()` computes `freightEst`, `freightLine`, `freightCbm`, passes treatment | `15031` |
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
  var freightCbm = lineCalcs.reduce(function(s,c){ return s + c.freight; }, 0);                 // CBM-driven freight only (frzero key)
  var freightEst = lineCalcs.reduce(function(s,c){ return s + c.freight + c.dgAmt + c.ins; }, 0);  // informational unless separate
  var typed = qteFreightTyped(qt.freightAmount);
  var freightLine = ft === 'separate' ? (typed !== null ? typed : freightEst) : 0;
  var totals = qteSellTotals(lines, lineCalcs, markup, overheadEff.total, qr.fxGBPUSD, freightLine);
  var quotedTotal = totalLanded + freightLine + totals.overhead;
  return { …existing keys…, quotedTotal: quotedTotal, freightTreatment: ft, freightEst: freightEst, freightCbm: freightCbm, freightLine: freightLine, freightTyped: ft === 'separate' && typed !== null };
```
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
  <input type="number" id="qf-frAmt" min="0" max="10000000" step="any" placeholder="Blank = estimate from CBM" oninput="calcQte()"></div>
```
```js
function qteFrSync() {
  var ft = qteFreightTreatment(G('qf-fr') ? G('qf-fr').value : '');
  if (G('qf-frAmt-wrap')) G('qf-frAmt-wrap').style.display = ft === 'separate' ? '' : 'none';
  if (ft !== 'separate' && G('qf-frAmt')) G('qf-frAmt').value = '';     // a stale figure can never resurrect
  rQLT(); calcQte();
}
function qteFormFreight() {   // the one reader every form-driven path uses
  var ft = qteFreightTreatment(G('qf-fr') ? G('qf-fr').value : '');
  return { ft: ft, amtRaw: ft === 'separate' && G('qf-frAmt') ? String(G('qf-frAmt').value).trim() : '' };
}
```
`vQte()` (`15590`) gains, before the `errs.length` test:
```js
  var ff = qteFormFreight();
  if (ff.ft === 'separate' && ff.amtRaw !== '' && qteFreightTyped(ff.amtRaw) === null) errs.push('Freight amount must be a number from 0 to 10,000,000, or blank');
  else if (ff.ft === 'separate' && ff.amtRaw !== '' && +ff.amtRaw > 10000000) errs.push('Freight amount must be a number from 0 to 10,000,000, or blank');
```
`openQte()` (reset block `15094-15103`): `G('qf-fr').value = 'included'; G('qf-frAmt').value = ''; qteFrSync();` — placed **before** the existing `rQLT()` call and before `_qOpenSnap = qteFormSnapshot()`. `editQte()`: `G('qf-fr').value = qteFreightTreatment(q.freightTreatment); G('qf-frAmt').value = (qteFreightTreatment(q.freightTreatment) === 'separate' && q.freightAmount !== undefined) ? String(q.freightAmount) : ''; qteFrSync();` before its `rQLT()`/`calcQte()`. `qteFormSnapshot()` header id list (`16380`) gains `'qf-fr'` and `'qf-frAmt'`. `saveQteSetup()` in `tests/run.js` (`899`) resets both (`mockEl('qf-fr').value = 'included'; mockEl('qf-frAmt').value = ''`).

## 4. Form-driven paths (REQ-QTE6-002)

- `rQLT()` (`15412`): `var ff = qteFormFreight();` `cQteLine(l, QR, mode, totalCBM, quoteInsRateRaw, ff.ft)`. Header for the **Landed** column: `ff.ft === 'included' ? 'Landed' : 'Landed (cost + duty)'`; header for **Ins $**: `'Ins $' + qteFrSuffix(ff)`.
- `qteFrSuffix(ff)`: `included` → `''`; `excluded` → `' (not charged)'`; `separate` with `qteFreightTyped(ff.amtRaw) !== null` → `' (replaced by typed freight)'`; else `' (in Freight row)'`. Used by `rQLT`, `prevQteDoc` (Freight and Insurance headers).
- `calcQte()` (`15516`): pass `ff.ft` to `cQteLine`; compute `freightCbm`, `freightEst`, `freightLine` exactly as `cQte()` (a shared helper `qteFreightFigures(lineCalcs, ff)` returns `{freightCbm, freightEst, freightLine, typed}` and is used by both `cQte()` and `calcQte()` so they cannot diverge); `qteSellTotals(..., freightLine)`. New summary cell `qt-freight` ("Freight line", `$` + `fn(freightLine,0)` + ` (estimate)` when separate & not typed; `-` otherwise) added to the grid at `3043`. Footer element `qt-fr-foot` (below the grid) renders the REQ-QTE6-007 per-treatment text exactly: `separate`/no typed → `Freight estimate $X (N lines with no CBM)`; `separate`/typed → `Freight estimate $X (N lines with no CBM) — using typed $Y. Insurance % has no effect while a typed freight amount is used`; `excluded` → `Freight not included. Insurance % has no effect while freight is not included`; `included` → empty. `N` = count of lines with `+cbm = 0`.
- `saveQte()` (`15602`): `var ff = qteFormFreight();` `cQteLine(..., insRateOvRaw, ff.ft)`; `qteSellTotals(..., freightLine)`; record: `if (ff.ft !== 'included') qt.freightTreatment = ff.ft; if (ff.ft === 'separate' && qteFreightTyped(ff.amtRaw) !== null) qt.freightAmount = +ff.amtRaw;` (keys omitted otherwise, never `undefined`); `calc_*` from the new totals.
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
Return additionally `freight: { treatment, typed: c.freightTyped, amount: frAmt, cbm: qteRound2(c.freightCbm), printed: !!freightRow }`. The Total, rows and `engineTotal: c.sellUSD` are otherwise unchanged (`engineTotal` now includes freight; `calc_sellUSD` stored the same way, so no false drift).
`qteCustomerDocHtml`: the "Shipping: <mode>" text (`16273`) is printed only when `c.freightTreatment !== 'excluded'` (the model exposes `freight.treatment`).
`qteCustWarnings(q, m, text)` (`16288`) adds:
```js
  var fr = m.freight;
  if (fr.treatment === 'separate') {
    if (fr.cbm === 0 || (fr.typed && fr.amount === 0)) out.push({ k: 'frzero', lvl: 'ack', t: 'No freight is calculated (no CBM or rate): the Freight row would show insurance only, or no row at all for a typed 0. Check before sending' });
    else if (!fr.typed && fr.amount >= 0.01) out.push({ k: 'frest', lvl: 'ack', t: 'The Freight row is an estimate from CBM rates and insurance — the forwarder’s figure may differ' });
  } else if (fr.treatment === 'excluded') out.push({ k: 'frexc', lvl: 'warn', t: 'Freight is not included — make sure your price basis says so' });
```
(`fr.cbm` is `qteRound2(Σ line.freight)`; `frzero` and `frest` are mutually exclusive.) A typed amount `> 0` raises no freight warning. Ack keys use the existing `<quote id>|<k>` convention (`16319`), so `qteCustGenerate()` re-enforcement needs no change. **Reconciliation bound:** `|printed Total − sellUSD| ≤ Σ over product lines (0.00005 × qty + 0.005) + 0.005 × 4`, asserted numerically in T-9.

## 7. Internal surfaces (REQ-QTE6-007)

- `prevQteDoc` (`16401`): `var ft = c.freightTreatment;` per-line cells unchanged (values from `c.lineCalcs[i]`); table headers: `Freight` + suffix, `Insurance` + suffix, `Landed` → `Landed (cost + duty)` when `ft !== 'included'`; header line gains `Freight: shown separately` / `Freight: not included` after `Mode:` when applicable; totals block gains a row `Freight` + `fn(c.freightLine,0)` + (estimate/typed) for `separate` before Sell Price. INTERNAL banner unchanged.
- `renderQteLineHistory` (`15480`): the `v` cell appends a muted note — `Freight: shown separately` or `Freight: not included` — when `(v.ft || 'included') !== 'included'`.
- `calcFeasibility()` untouched.

## 8. Data / privacy

Covered in the header; `schema-migration-reviewer` to confirm the additive migration, `persistQteChange` coverage and the `!= null` guard.

## 9. Backwards compatibility

A quote without the new fields behaves identically: `cQte()` output for every existing fixture is byte-identical (pinned, T-1); the editor shows "Included in line prices"; Cloud rows with null columns load with no new keys (`'freightTreatment' in q === false`).

## 10. Tests (`tests/run.js`, all `testAsync` where async; reset `qf-fr`/`qf-frAmt` in `saveQteSetup`)

| ID | Asserts |
|---|---|
| T-1 | Included regression: pinned `cQte()` results for fixtures — plain line, DG line, line `Ins %` override, quote `insRate` override, FCL 20GP and 40HQ, LCL; and `rfqLandedGBP` unchanged |
| T-2 | §3.4 table, all 4 columns incl. `freightLine`, `sellUSD`, `quotedTotal`, `landed`, line `ins` still returned |
| T-3 | `qteFreightTreatment` normalisation (undefined, '', 'foo', 'Separate' → included); `qteFreightTyped` (blank, '0', 0, -1, 'abc', NaN, '1e3') |
| T-4 | DG line: `included` landed contains `dgAmt`; `separate` moves it into `freightEst` (not landed); `excluded` drops it |
| T-5 | Per-line `Ins %` and quote `insRate` flow into `freightEst` for separate; no effect on totals with a typed amount or `excluded` |
| T-6 | `calcQte()` DOM figures equal `cQte()` for all three treatments (shared `qteFreightFigures`) |
| T-7 | `saveQte()` stores `freightTreatment`/`freightAmount` only when set (`'freightTreatment' in q === false` for included; typed 0 stored; blank omitted); `calc_*` include freight |
| T-8 | `vQte()` blocks `-1`, `abc`, `10000001`; accepts blank, `0`, `10000000` |
| T-9 | Customer doc: Freight row first, labels "Freight"/"Freight (estimate)", zero amount prints no row, reconciliation bound numeric incl. 4 sub-half-cent charges |
| T-10 | Sentinels: CBM, `lclPerCBM`, container rates, markup %, insurance %, typed-vs-estimate delta never appear in the customer document |
| T-11 | Warnings: `frest` (ack, blocks `qteCustGenerate` until ticked), `frzero` for CBM 0 with insurance > 0 and for typed 0, `frexc` warn; `frest` absent when rounded amount < 0.01 or typed > 0 |
| T-12 | `excluded`: no freight row, no "Shipping:" line; `separate`/`included` still print it |
| T-13 | Versioning: treatment change creates a new version with `ft`; typed-amount-only change does not; `''` ≡ included |
| T-14 | `qteFormSnapshot` differs when `qf-fr` or `qf-frAmt` change; `openQte`/`editQte` reset/load; switching away from separate clears the amount |
| T-15 | Cloud: four builders write both columns (mock `_sb` capturing the payload for `saveQte`, `persistQteChange`, migrate insert); refresh omits keys when null; a status change via `persistQteChange` does not null `freight_*` |
| T-16 | Sheets pull (`mergePulledWithLocal`) preserves `freightTreatment`/`freightAmount` |
| T-17 | Internal sheet headers/totals per treatment; history panel note; INTERNAL banner intact |
| T-18 | Call-site test: enumerates `cQteLine(` in `index.html` and fails on any caller not in the approved list (4263, cQte, rQLT, calcQte, saveQte) |
| T-19 | `AI_SYSTEM_PROMPT` states the three treatments and that AI-created quotes are Included |

## 11. Mutation tests (each run in a scratch copy; each must fail the predicted test)

1. `cQteLine`: landed always includes freight → T-2/T-4. 2. `qteSellTotals`: drop `freightLine` → T-2/T-9. 3. `cQte`: `freightEst` omits `ins` → T-2. 4. `cQte`: `freightEst` omits `dgAmt` → T-4. 5. `frzero` keyed on whole estimate → T-11. 6. `frest` ack removed → T-11. 7. `excluded` still prints Shipping → T-12. 8. versioning ignores `ft` → T-13. 9. `qteFormSnapshot` ids removed → T-14. 10. `persistQteChange` literal missing columns → T-15. 11. refresh uses `!= null ? val : undefined` → T-15. 12. `vQte` negative allowed → T-8. 13. freight row not first / label wrong → T-9. 14. sentinel: CBM printed → T-10. 15. `qteFrSync` fails to clear amount → T-14. 16. `calcQte` not using shared figures (diverges) → T-6.

## 12. Docs and delivery

`AI_SYSTEM_PROMPT` (three treatments; estimate/typed; insurance and DG travel with freight; AI-created quotes are Included; no apostrophes in the single-quoted strings), `docs/user-guide.md` (Quotes section: treatments, estimate tick, `calc_totalLanded` reads lower, Sheets "Grand Total" label), in-app changelog, three version strings → v2.9.107, `CLAUDE.md`, `docs/version-history.md`, `docs/known-gaps.md`, `STACKD_CONTEXT.md`, `docs/requirements-tracker.md`, Notion rows (aggregate wording), PR on request. `fmt(`/`fmtN(` call-count guards in `tests/run.js` re-checked after the build.

## 13. Risks

Insurance/DG now ride with freight, so line prices fall; the freight row carries them unmarked — operator margin on those items disappears (documented in the guide). The estimate tick is a deliberate friction. Cloud migration 0011 must be applied to Supabase **before** v2.9.107 is deployed to users with migrated quotes, or `saveQte`'s update would fail on unknown columns (deploy-order note for the PR).
