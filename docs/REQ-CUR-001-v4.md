# REQ-CUR-001-v4: Global Display-Currency Toggle

**Supersedes:** REQ-CUR-001-v3

## Business Context

Every financial aggregate in the portal is currently hardcoded to display in GBP, converted via `toGBP(amount, cur)` (`index.html:3552`) from each record's native transaction currency, using the live/editable FX rates already maintained in Settings → Rates & FX (`QR.fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD`).

In-scope GBP-converted aggregate call sites, confirmed by direct code read:
- `rDash()` (`index.html:3634` onward) — Dashboard KPIs.
- `renderBuyers()` (`index.html:5083-5103`) — Buyers list "Outstanding" column (`outGBP`, `5086-87`, rendered `5096`).
- `openBuy()`'s Summary panel (`index.html:5128-5144`) — "Total invoiced" (`totalGBP`, `5132`, `5141`).

Excluded from scope, with reasons confirmed by code read (unchanged from v3): MTD/VAT statutory export (`calcVATReturn`, `4602-4645`), Aging Report (no `toGBP` call, CUR-GAP-001), `renderStatement()`/Buyer Statement (no `toGBP` call, mixes currencies unconverted already, CUR-GAP-002), and the Summary panel's "Outstanding" figure (`buyer.currency`-native via `fromGBP`, `5133-5134`, `5142` — precedence rule from v3 unchanged: a `toGBP`-derived figure follows the toggle, a `buyer.currency`-native figure does not).

## Corrections from v3 (requirements-gate FAIL)

**1. `i.currency` vs `inv.cur` field mismatch — folding the fix into this REQ, not logging as separate gap.**
Confirmed by grep: every other invoice consumer (`calcVATReturn:4610`, aging report, payments, quote/CN modals) reads `inv.cur`. `renderBuyers()` (`5087`) and `openBuy()`'s Summary panel (`5132-5133`) read `i.currency||'USD'` — a field that does not exist on the invoice schema, so it silently defaults every invoice to `'USD'` regardless of its real `cur`, at both sites. Since this REQ is already rewriting these exact lines to add the display-currency conversion, **REQ-CUR-003 is extended**: the fix must also correct `i.currency` → `i.cur` (matching the true field name) at both sites, as part of the same edit — not deferred as a separate gap, since leaving the bug in place while adding a new currency toggle on top of it would make the new feature convert from the wrong source currency.

**2. AC-004 referenced a `calcVATReturn` return shape that doesn't exist.**
Confirmed by reading `calcVATReturn` (`index.html:4602-4645`): it returns `{box1, box2, box3, box4, box5, box6, box7, box8, box9, rows}` — there is no top-level `grossGBP`/`taxGBP`. `box1` is the signed sum of per-invoice `taxGBP` (tax total); `box6` is the signed sum of `netGBP` (`grossGBP - taxGBP`, i.e. net-of-tax sales total) — **not** a gross total. AC-004 rewritten below against the real fields, with corrected arithmetic (`box1 = 600.00`, `box6 = 2400.00`, not `3000.00`).

**3. REQ-CUR-007/AC-005 staleness warning — mechanism now concretely specified.**
Confirmed the existing pattern: `localStorage.getItem('st_qr_ts')` holds the last live-fetch timestamp; `renderFxStatus()` (`9288-9297`) and `renderQteRatesWarn()` (`9299-9310`) both compute age from it with the same thresholds (green <8h / amber 8-24h / red >24h, using `Date.now() - new Date(ts).getTime()`). REQ-CUR-007 now specifies reusing this exact same age computation (not a new mechanism) and rendering an equivalent inline warning banner (matching `renderQteRatesWarn()`'s markup/styling: `⚠ FX rates were last refreshed Nh ago...`) directly beneath the Dashboard currency selector and beneath the Buyers list/Summary panel's converted figures, only when `QR.displayCurrency !== 'GBP'` (no warning needed when nothing is being converted) and age >24h.

## FM-1 Assessment

Qualifies under **Exception 1** (UI/AI feature, no new entity) and **Exception 2** (new field on an existing entity, no new sync mapping). New field: `QR.displayCurrency` (default `'GBP'`), stored on `QR` (`st_qr` key). Confirmed `expAll()` exports `qr: ld('st_qr')` in full (`index.html:8007`) and `doImport()` restores it wholesale via `QR = Object.assign({}, QR_DEFAULTS, data.qr)` (`8056`) — round-trips through backup/restore via the existing `QR_DEFAULTS` fallback, no migration function needed. `QR` has no `FIELD_MAPS` entry / is never synced to Sheets.

**FPM domain risk — resolved, not just flagged.** Confirmed by direct read of `cQteLine` (`8544-8560`) and `cQte` (`8562-8575`): both read only `fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD`/`lclPerCBM`/`fcl20GP`/`fcl40HQ`/`originCharges`/`destCharges`/`fpmAdmin`/`insRate`/`dgSurcharge` off `qr`. Zero references to `displayCurrency` exist anywhere in the codebase today (field doesn't exist yet). REQ-CUR-008/AC-008 (grep-based build-gate check that the Quote engine never reads `displayCurrency`) remains as a guardrail against future regression, not a currently-broken behavior.

## Requirements

**REQ-CUR-001**: Add a currency selector (GBP/USD/RMB/BBD) visible on the Dashboard, persisted as `QR.displayCurrency` (default `'GBP'`), saved via `sv(K.qr, QR)`.

**REQ-CUR-002**: Selecting a currency recomputes and re-renders `rDash()`'s KPI aggregates in the same render pass, via `fromGBP(toGBP(amount, recordCur), QR.displayCurrency)`.

**REQ-CUR-003**: `renderBuyers()`'s Outstanding column and `openBuy()`'s Summary panel "Total invoiced" figure must (a) read the invoice's currency from `i.cur||'USD'` (corrected from the dead `i.currency` field) and (b) convert to `QR.displayCurrency` instead of hardcoded GBP, applied the next time either view is rendered after the preference changes.

**REQ-CUR-004**: Currency symbols/labels for figures in scope of REQ-CUR-002/003 must reflect `QR.displayCurrency`.

**REQ-CUR-005**: `calcVATReturn` (`4602-4645`) is unaffected and must continue to compute `box1`/`box6` (and all boxes) in GBP unconditionally, regardless of `QR.displayCurrency`.

**REQ-CUR-006**: The Summary panel's "Outstanding" figure (`buyer.currency`-native) is unaffected by `QR.displayCurrency`, per the precedence rule.

**REQ-CUR-007**: When `QR.displayCurrency !== 'GBP'` and `st_qr_ts` age exceeds 24h, show an inline warning banner (matching `renderQteRatesWarn()`'s existing markup/thresholds) beneath the Dashboard selector and beneath the Buyers list/Summary panel converted figures.

**REQ-CUR-008**: The Quote engine (`cQteLine`, `cQte`) must never read `QR.displayCurrency` — verified at build-gate via grep.

## Acceptance Criteria

- AC-001: Selecting a currency in the Dashboard toggle updates KPI figures within the same render pass, no reload.
- AC-002: Selecting a currency updates `renderBuyers()`'s Outstanding column and the Summary panel's "Total invoiced" figure the next time each is rendered, using `i.cur` (not `i.currency`) as the source currency.
- AC-003: `QR.displayCurrency` persists across a page reload and a full backup export → import cycle.
- AC-004 (corrected fixture, against `calcVATReturn`'s real return shape): Given 3 invoices dated within the query range — Inv-A: `cur:'GBP'`, `iCalc().grand=1000.00`, `.tax=200.00`; Inv-B: `cur:'USD'`, `.grand=1300.00`, `.tax=260.00` (at `QR.fxGBPUSD=1.30` → `1000.00`/`200.00` GBP); Inv-C: `cur:'RMB'`, `.grand=9100.00`, `.tax=1820.00` (at `QR.fxGBPRMB=9.10` → `1000.00`/`200.00` GBP) — `calcVATReturn(...).box1` must equal `600.00` (sum of `taxGBP`) and `.box6` must equal `2400.00` (sum of `netGBP = grossGBP-taxGBP` = `800+800+800`), identically regardless of `QR.displayCurrency` at export time.
- AC-005: When `QR.displayCurrency !== 'GBP'` and `st_qr_ts` age >24h, the Dashboard and Buyers/Summary panel show the warning banner described in REQ-CUR-007; when `=='GBP'` or age ≤24h, no banner is shown.
- AC-006: Switching `QR.displayCurrency` to a non-GBP currency and back to `'GBP'` reproduces the original GBP figures to 2 decimal places.
- AC-007: The Summary panel's "Outstanding" figure is unchanged by any `QR.displayCurrency` selection (regression test asserts identical rendered value across toggle states).
- AC-008: Build-gate grep confirms no reference to `displayCurrency` inside `cQteLine`/`cQte` or their call graph.
- AC-009 (new, covers correction #1): A fixture invoice with `cur:'RMB'` and no `currency` field renders its Outstanding/Total-invoiced figures converted from RMB (via `i.cur`), not defaulted to USD — regression test proving the dead-field bug is actually fixed, not just theoretically addressed.

## Residual Risks / Known Gaps (logged, not blocking)

- **CUR-GAP-001**: Aging Report mixes currencies unconverted today — pre-existing, out of scope.
- **CUR-GAP-002**: `renderStatement()`/Buyer Statement mixes currencies unconverted today — pre-existing, out of scope. A future REQ could extend `QR.displayCurrency` here; new conversion work, not part of this REQ.
- Historic invoices/POs keep their own native `cur` field — no migration needed; only the *display* currency changes.

## Changelog

- v4: Fixed AC-004 against `calcVATReturn`'s real return shape (`box1`/`box6`, not nonexistent `grossGBP`/`taxGBP`) with corrected arithmetic (2400, not 3000); folded the `i.currency`→`i.cur` dead-field fix into REQ-CUR-003 (same lines already being edited) instead of leaving it as an unaddressed gap, and added AC-009 as its regression test; made REQ-CUR-007/AC-005's staleness warning concrete by citing the exact existing mechanism (`st_qr_ts`, `renderQteRatesWarn()`'s markup/thresholds) to reuse.
- v3: Corrected Buyer Statement misidentification; mechanical precedence rule; concrete-looking but factually wrong AC-004 fixture; FPM risk flag on Quote engine.
- v2 / v1: superseded.
