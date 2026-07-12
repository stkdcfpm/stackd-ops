# REQ-CUR-001-v3: Global Display-Currency Toggle

**Supersedes:** REQ-CUR-001-v2

## Business Context

Every financial aggregate in the portal is currently hardcoded to display in GBP, converted via `toGBP(amount, cur)` (`index.html:3552`) from each record's native transaction currency (USD/RMB/CNY/BBD), using the live/editable FX rates already maintained in Settings → Rates & FX (`QR.fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD`).

Confirmed by direct code read, these are the exact GBP-converted (`toGBP`) aggregate call sites in scope:
- `rDash()` (`index.html:3634` onward) — Dashboard KPIs: `tR`, `tNP`, `tOut`, `tPO`, `tBuyerDep`, `tSupDep`, credit-note totals, P&L chart (lines 3642–3706).
- `renderBuyers()` (`index.html:5083-5103`) — the Buyers list table's "Outstanding" column: `outGBP` at `5086-87`, rendered `£...` at `5096`.
- `openBuy()`'s Summary panel (`index.html:5128-5144`) — "Total invoiced" (`totalGBP`, `5132`, always rendered as `£...GBP` today) and "Outstanding" (`outstandGBP` at `5133`, then converted via `fromGBP(outstandGBP, buyer.currency)` at `5134` into the **buyer's own native currency**, not GBP).

**Corrected finding from v2 (requirements-gate FAIL)**: v2 misidentified the "Buyer Statement report" as one of these GBP-hardcoded components. It is not. `renderStatement()` (`index.html:5239` onward) contains **no `toGBP` call at all** — it picks `cur = invRecs[0].cur||'USD'` (the first invoice's own native currency) and sums `totalGrand`/`totalOut` unconverted. If a buyer has invoices in more than one currency, this already silently mixes currencies today — a pre-existing latent bug, unrelated to and out of scope for this feature. **`renderStatement()` is excluded from this REQ entirely** (see CUR-GAP-002 below); nothing here is a GBP→toggle swap for it, since it does no GBP conversion to swap.

**Explicitly out of scope**:
- The UK MTD/VAT export (`calcVATReturn`, `index.html:4602-4616`, `toGBP` calls at `4611-4612`) is a statutory HMRC filing figure and must remain GBP-only regardless of any display preference.
- The **Aging Report** (`openAgingReport()`/`renderAgingReport()`, `index.html:4799-4883`) — confirmed by code read to contain no `toGBP` call; it sums `c.bal` unconverted per due-date bucket (itself a separate pre-existing currency-mixing bug, logged as CUR-GAP-001, not this feature's problem to fix).
- **`renderStatement()` / Buyer Statement report** (`index.html:5239` onward) — confirmed by code read to contain no `toGBP` call; out of scope, logged as CUR-GAP-002.
- Per-buyer native currency display: `buyer.currency` (`index.html:5114`) already governs figures that are a single buyer's own transaction currency (e.g. Summary panel "Outstanding"). These are **not** derived via `toGBP` and are **not** in scope — see the precedence rule below.

## Precedence rule (resolves v2's REQ-CUR-003/REQ-CUR-006 contradiction)

v2 tried to define scope as "cross-buyer aggregates only," which broke down on the Summary panel's "Total invoiced" figure (a single-buyer aggregate that IS `toGBP`-derived). The rule is corrected to be mechanical, not buyer-count-based:

> **Any figure currently computed via `toGBP(...)` is in scope and switches to `QR.displayCurrency`. Any figure currently shown in `buyer.currency` (via `fromGBP` applied for buyer-native display, not as an intermediate step of a `toGBP` aggregate) is out of scope and stays in that buyer's own currency.**

Applied to the Summary panel: "Total invoiced" (`toGBP`-derived, currently GBP-locked) → follows `QR.displayCurrency`. "Outstanding" (`toGBP` then explicitly `fromGBP`'d back into `buyer.currency` for native display) → stays in `buyer.currency`, unaffected. This is consistent and matches what each figure already represents conceptually.

## FM-1 Assessment

Qualifies under **Exception 1** (UI/AI feature, no new entity) and **Exception 2** (new field on an existing entity, no new sync mapping). New field: `QR.displayCurrency` (default `'GBP'`), stored on `QR` (`st_qr` key) — confirmed `expAll()` exports `qr: ld('st_qr')` in full (`index.html:8007`) and `doImport()` restores it wholesale via `QR = Object.assign({}, QR_DEFAULTS, data.qr)` (`index.html:8056`), so the field round-trips through backup/restore for free via the existing `QR_DEFAULTS` fallback pattern — no migration function needed. `QR` has no `FIELD_MAPS` entry / is never synced to Sheets.

**FPM domain risk (flagged by requirements-gate, addressed here)**: `QR` is also read by `cQteLine`/`cQte` for `fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD` in the Quote engine. **REQ-CUR-008**: the Quote engine (`cQteLine`, `cQte`, and any function they call) must never read `QR.displayCurrency` — it is a display-only preference, irrelevant to landed-cost/quote calculation, and must not leak into pricing logic. This must be explicitly checked at build-gate (grep for `displayCurrency` usage outside the render functions named in this REQ).

## Requirements

**REQ-CUR-001**: Add a currency selector (GBP/USD/RMB/BBD) visible on the Dashboard, persisted as `QR.displayCurrency` (default `'GBP'`), saved via `sv(K.qr, QR)`.

**REQ-CUR-002**: Selecting a currency recomputes and re-renders `rDash()`'s KPI aggregates in the same render pass (no reload), via `fromGBP(toGBP(amount, recordCur), QR.displayCurrency)`.

**REQ-CUR-003**: `renderBuyers()`'s Outstanding column and `openBuy()`'s Summary panel "Total invoiced" figure must use `QR.displayCurrency` instead of hardcoded GBP, applied the next time either view is rendered after the preference changes (not live while already open — consistent with how these views already don't live-update on other Settings/`QR` changes, e.g. editing FX rates doesn't live-update an open Buyers list either).

**REQ-CUR-004**: Currency symbols/labels for figures in scope of REQ-CUR-002/003 must reflect `QR.displayCurrency` (not remain hardcoded `£`).

**REQ-CUR-005**: `calcVATReturn` (`index.html:4602-4616`) is explicitly excluded and must continue to compute in GBP unconditionally, regardless of `QR.displayCurrency`.

**REQ-CUR-006**: The Summary panel's "Outstanding" figure and any other figure shown in a buyer's own `buyer.currency` remain unaffected by `QR.displayCurrency`, per the precedence rule above.

**REQ-CUR-007**: If `QR`'s FX rates are stale (>24h, per the existing freshness indicator), the currency selector and every converted figure in scope must surface the same staleness warning shown in Settings.

**REQ-CUR-008**: The Quote engine (`cQteLine`, `cQte`) must never read `QR.displayCurrency` — verified at build-gate.

## Acceptance Criteria

- AC-001: Selecting a currency in the Dashboard toggle updates KPI figures within the same render pass, no reload.
- AC-002: Selecting a currency updates `renderBuyers()`'s Outstanding column and the Summary panel's "Total invoiced" figure the next time each is rendered.
- AC-003: `QR.displayCurrency` persists across a page reload and through a full backup export → import cycle.
- AC-004 (concrete fixture): Given 3 invoices — Inv-A: `cur:'GBP'`, `iCalc().grand = 1000.00`, `.tax = 200.00`; Inv-B: `cur:'USD'`, `.grand = 1300.00`, `.tax = 260.00` (at `QR.fxGBPUSD = 1.30`, converts to `1000.00`/`200.00` GBP); Inv-C: `cur:'RMB'`, `.grand = 9100.00`, `.tax = 1820.00` (at `QR.fxGBPRMB = 9.10`, converts to `1000.00`/`200.00` GBP) — `calcVATReturn`'s `grossGBP` must equal `3000.00` and `taxGBP` must equal `600.00`, identically whether `QR.displayCurrency` is `'GBP'`, `'USD'`, or `'RMB'` at export time.
- AC-005: If `QR`'s rates are >24h stale, the toggle and every in-scope figure show the existing staleness styling.
- AC-006: Switching `QR.displayCurrency` to a non-GBP currency and back to `'GBP'` reproduces the original GBP figures to 2 decimal places.
- AC-007: The Summary panel's "Outstanding" figure (buyer-native `buyer.currency`) is unchanged by any `QR.displayCurrency` selection — regression test asserts the same rendered value regardless of toggle state.
- AC-008: `grep`-based build-gate check confirms `cQteLine`/`cQte` (and their call graph) contain no reference to `displayCurrency`.

## Residual Risks / Known Gaps (logged, not blocking)

- **CUR-GAP-001**: Aging Report mixes currencies unconverted today (sums `c.bal` with no `toGBP`) — pre-existing, out of scope, not introduced or worsened by this feature.
- **CUR-GAP-002**: `renderStatement()` (Buyer Statement report) mixes currencies unconverted today (`cur = invRecs[0].cur`) if a buyer has invoices in more than one currency — pre-existing, out of scope, not introduced or worsened by this feature. A future REQ could extend `QR.displayCurrency` here, but that is new conversion work, not a toggle-swap, and is not part of this REQ.
- Historic invoices/POs keep their own native `cur`/`currency` field — no migration needed; only the *display* currency changes.

## Changelog

- v3: Corrected the Buyer Statement report misidentification (it's `renderStatement()`, has no `toGBP` call, excluded as CUR-GAP-002); replaced v2's buyer-count-based precedence rule (which contradicted itself on the Summary panel) with a mechanical rule based on whether a figure is `toGBP`-derived vs. already `buyer.currency`-native; added `renderBuyers()`'s Outstanding column to scope; supplied concrete AC-004 fixture numbers; added REQ-CUR-008/AC-008 to explicitly wall off the Quote engine from `QR.displayCurrency` per the FPM risk flag.
- v2: Fixed SS→QR storage location; resolved Aging Report scope; added AC-004 fixture shape (no concrete numbers yet); reconciled AC-001/AC-002 timing; introduced (but got wrong) a buyer-count-based precedence rule.
- v1: Initial draft (superseded).
