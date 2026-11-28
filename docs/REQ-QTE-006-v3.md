# REQ-QTE-006 — Freight shown as its own line on the customer quote

**Status:** v3 DRAFT — resolves requirements-gate round 1 (v2: FAIL, findings 1-12). Not yet re-gated.
**Type:** Feature (engine contract + customer document). One additive Supabase migration. Single phase; sizing: touches `cQteLine`, `cQte`, `qteSellTotals`, `saveQte`, `calcQte`, `rQLT`, `prevQteDoc`, `renderQteLineHistory`, `qteCustomerModel`, `qteCustWarnings`, `qteFormSnapshot`, `openQte`/`editQte`, three Cloud Data functions + migration `0011` — expect several gate rounds, as REQ-QTE-005 needed.
**Operator decisions (2026-11-28):** freight at cost (no markup); print the CBM estimate labelled "Freight (estimate)" with a tick; insurance on cost only; existing quotes stay Included; ships after the current container quote (interim workaround meanwhile). **Defaults I have set for gate findings 3 and 5 and need confirming:** D6 `excluded` insurance, D7 DG surcharge placement — see §8.

## 1. Problem (verified against live code)
`cQteLine()` (`index.html:14980`) computes `landed = cost + freight + dgAmt + ins + duty` (`14999`): freight from the line's CBM and the Freight Mode (`14984-14990`), `ins = (cost + freight) × rate` (`14997`), `duty = cost × dutyPct` (`14998`), `dgAmt = QR.dgSurcharge` for a DG line (`14991`). A line's selling price is `landed × (1 + effective markup%)` (`qteSellTotals`, `15021`; `qteCustomerModel`, `16224`), so international freight, and the insurance charged on it, are **always inside every line's price and carry the line's markup**. The customer document has no freight row (`16232-16236`); the three overhead overrides never touch freight.

## 2. Treatment field
`Quote.freightTreatment`: **`'included'`** (default; today's behaviour), **`'separate'`**, **`'excluded'`**. Stored **only for `separate`/`excluded`**; for `included` the key is **omitted** (never stored as `'included'`, never `undefined`) — identical rule in the local record, the form, the Cloud column (`freight_treatment` is `null` for included) and every test. `Quote.freightAmount` (USD, number): present only for `separate` and only when the operator typed a value (a typed `0` is stored); blank = key omitted.

## 3. Engine contract (resolves gate findings 1-3)
**3.1 Signature.** `cQteLine(line, qr, freightMode, totalCBM, quoteInsRateRaw, freightTreatment)` — new 6th parameter; `undefined`/`'included'` = exactly today's arithmetic. **Callers:** `rfqLandedGBP` (`4263`, four arguments) is unchanged and stays on `included` — RFQ landed-cost ranking needs freight; `cQte` (`15036`) passes `qt.freightTreatment`; the three form-driven paths `rQLT` (`15428`), `calcQte` (`15529`) and `saveQte` (`15629`) read the new form field and pass it, so editor, saved record and document cannot disagree. A test enumerates every `cQteLine(` call site and fails if one is added without a decision.
**3.2 `separate` / `excluded` line arithmetic.** `freight` is still computed per line (returned as `freightEst` for display) but **excluded from `landed`**; `ins = cost × insPct/100` (**base is cost only**; the per-line `Ins %` and quote-level `qf-insRate` cascade is unchanged, only the base changes); `duty` unchanged; `dgAmt` stays inside `landed` and is marked up (D7). Landed = `cost + dgAmt + ins + duty`.
**3.3 Totals.** `cQte()` returns two new fields: `freightEst = Σ line freightEst` and `freightLine` = `0` for `included`/`excluded`; for `separate`, the typed `freightAmount` if present else `freightEst`. Then: `totalLanded = Σ line landed` (ex-freight for non-included); `quotedTotal = totalLanded + freightLine + overhead`; **`sellUSD = Σ line sell + freightLine + overhead`** (freight is added **unmarked**, like overhead); `sellGBP = sellUSD / fx`. `qteSellTotals()` gains a `freightLine` argument (default 0). `saveQte` stores `calc_totalLanded`, `calc_sellUSD`, `calc_sellGBP` from these, so `qteCustomerModel.engineTotal` (`16238`) and the stored value agree and the drift acknowledgement (`16307`) does not fire falsely. REQ-QTE6 regression: every existing `cQte()` output is pinned for `included`; new fixtures pin `separate` and `excluded`.
**3.4 Worked example** (1 line, cost $10,000, CBM 20 at $100/CBM LCL → freight est $2,000, insurance 0.5%, duty 0, markup 20%, no DG, no overhead):

| | Included | Separate (amount blank → estimate) | Separate (typed $1,800) | Excluded |
|---|---|---|---|---|
| ins | (10,000+2,000)×0.5% = 60.00 | 10,000×0.5% = 50.00 | 50.00 | 50.00 |
| landed | 12,060.00 | 10,050.00 | 10,050.00 | 10,050.00 |
| line sell (×1.20) | 14,472.00 | 12,060.00 | 12,060.00 | 12,060.00 |
| freightLine | 0 | 2,000.00 (est.) | 1,800.00 | 0 |
| **sellUSD / printed Total** | **14,472.00** | **14,060.00** | **13,860.00** | **12,060.00** |
| quotedTotal | 12,060.00 | 12,050.00 | 11,850.00 | 10,050.00 |

## 4. Requirements
- **REQ-QTE6-001 — Persistence.** As §2. Form: a select `qf-fr` placed with `qf-mode` (`3002-3012`) and a number input `qf-frAmt` shown only when `qf-fr = separate` (placeholder "Blank = estimate from CBM"). Switching away from `separate` clears `qf-frAmt` visibly, so a stale figure can never resurrect. `openQte`/`editQte` reset/load both fields; `qteFormSnapshot()` (`16377-16385`, hard-coded id list) gains `qf-fr`, `qf-frAmt`; `saveQteSetup()` in `tests/run.js` resets both (module-level `mockElements` never clears).
- **REQ-QTE6-002 — Engine.** §3, including the pinned regression and the `cQteLine(` call-site test.
- **REQ-QTE6-003 — Customer document.** `qteCustomerModel()` adds a `freight` row **first** in `charges[]` (print order = array order, `16232`): label **"Freight"** when a typed amount exists, **"Freight (estimate)"** when the engine estimate is used. A zero amount (typed `0` or a zero estimate, e.g. all line CBM 0) prints **no row**, matching the existing `amount > 0` filter (`16236`), and needs no tick. The header line "Shipping: <mode>" (`16273`) prints as today for `separate`/`included` and is **omitted for `excluded`**. Reconciliation rule unchanged: printed Total = Σ printed lines + Σ printed rows (`16237`); the stated bound against `sellUSD` gains **+0.005** for the freight row; AC restates it.
- **REQ-QTE6-004 — No leak.** Only the one freight amount prints. CBM, rates, container costs, markup %, insurance, `freightEst` vs typed delta and the treatment name never print; the REQ-QTE5 sentinel test is extended with sentinels for CBM, `lclPerCBM`/container rates, markup %, insurance % and a typed-vs-estimate delta.
- **REQ-QTE6-005 — Pre-send warnings.** New `qteCustWarnings` entry **`{k:'frest', lvl:'ack'}`** ("Freight is an estimate from CBM rates — the forwarder's figure may differ") when `separate`, no typed amount and the estimate is `> 0`; `qteCustGenerate` re-enforces it like the other acks (test via `testAsync`). The estimate is recomputed live from current `QR` rates, so a reprint after a Settings change can print a different amount; the existing drift acknowledgement (`16307`) also catches it because `calc_sellUSD` now includes freight. Best-effort text warning dropped as untestable. For `excluded`, a **warn** (not ack) says "Freight is not included — make sure your price basis says so".
- **REQ-QTE6-006 — Versioning (resolves finding 4).** `history.push` entries gain `ft` (`'included'|'separate'|'excluded'`); the change detector (`15642`) also compares `(lastV.ft||'included') !== currentTreatment`, so switching treatment (which changes every line's `landed`/`ins`/`sellPrice`) creates a new version. A typed freight amount is quote-level, not per-line, and does not version lines.
- **REQ-QTE6-007 — Other surfaces (resolves finding 7).** `prevQteDoc` (internal sheet): per-line Freight column stays (shows `freightEst`), Landed column header becomes "Landed (ex-freight)" when not `included`; totals block gains a **Freight** row (`separate`) and prints the treatment; INTERNAL banner unchanged. `rQLT` live grid: same header rule, plus an editor footer line showing estimate vs typed amount. `renderQteLineHistory` shows the treatment marker. `qteToPoConvert` (`16126-16170`) reads `l.cost`, never `cQte`, so freight never reaches a Purchase Order — stated, with a test. The promotion queue has no `cQteLine` call (verified by the call-site test).
- **REQ-QTE6-008 — Cloud Data & carry-forward.** Two nullable columns on `quotes`: `freight_treatment text`, `freight_amount numeric` (migration `0011_quotes_freight_treatment.sql`, additive; latest existing is `0010`). Touchpoints, each in the test plan: refresh mapping (`6614-6622`) with `if (row.x != null) obj.x = row.x` (never `!= null ? val : undefined`); `migrateQteToSupabase` insert (`6861`) and retrofit loop (`7393`); `saveQte`'s `qtRow` (`15693`); the local-branch object literal (`15657`), which is a full replace, so the fields are set only from the form. `schema-migration-reviewer` required. **Sheets sync:** the new fields are not in `FIELD_MAPS.qt` (the existing quote overrides aren't either); the SPEC must verify a Sheets pull cannot reset a `separate` quote to `included`.
- **REQ-QTE6-009 — Docs/assistant.** `AI_SYSTEM_PROMPT`, `docs/user-guide.md` (incl. cost-only insurance lowers `separate` line prices versus `included`), changelog, three version strings, tracker/Notion rows.

## 5. Out of scope
Free-form charge lines; per-line freight override; freight markup (decided: none); non-USD currencies (QTE-GAP-004); stored issued copies (QTE-GAP-006); changing the FCL/LCL rate engine; Sheets sync of the new fields.

## 6. Data / GDPR
Commercial amounts and an enum on an existing record; no personal data; Cloud-migrated quotes already travel to the existing project; no new external flow. The word "estimate" and the freight amount are disclosed to the buyer by design.

## 7. Acceptance criteria
1. `included`: every existing fixture's `cQte()` output unchanged to the cent (fixture set listed in the SPEC, including a DG line, a line-level `Ins %` override and an FCL mode); Cloud round-trip leaves `'freight_treatment' in obj === false`.
2. §3.4 example reproduces exactly for all four columns; for `separate`, printed Total = Σ printed lines + rows, within the stated bound of `sellUSD`.
3. `separate` + blank amount prints "Freight (estimate)" and Generate refuses without the tick; typed amount prints "Freight" with no tick; zero amount prints no row.
4. `excluded`: no freight row, no "Shipping:" line, the warn appears.
5. Sentinel test per REQ-QTE6-004 passes; internal sheet still carries the INTERNAL banner.
6. Switching treatment creates a new price-history version; changing only the typed amount does not.
7. `calc_*` stored values include freight for `separate`, so no false drift acknowledgement on a freshly saved quote.
8. `rfqLandedGBP` output unchanged; no `cQteLine(` caller unaccounted for.
9. Mutation tests: revert each of the cost-only insurance base, `freightLine` in `sellUSD`, the `frest` ack, the version trigger, the `qteFormSnapshot` ids, the Cloud `!= null` guard — each fails its predicted test.

## 8. Defaults needing operator confirmation
- **D6 — `excluded` insurance:** keep cost-only insurance inside line prices (same as `separate`). Alternative: no insurance at all for FOB/EXW quotes (buyer insures).
- **D7 — DG surcharge:** stays inside the line price and is marked up. Alternative: move it into the Freight row at cost (consistent with "freight at cost"), at the price of a more complex row definition.

## 9. Risks
Margin on freight disappears (and falls wherever freight was previously marked up); cost-only insurance lowers `separate` prices versus `included` for identical cargo; estimate wording is hard-coded and visible to the buyer.
