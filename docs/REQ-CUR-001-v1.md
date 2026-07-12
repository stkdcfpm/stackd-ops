# REQ-CUR-001-v1: Global Display-Currency Toggle

## Business Context

Every financial aggregate in the portal is currently hardcoded to display in GBP, converted via `toGBP(amount, cur)` (`index.html:3552`) from each record's native transaction currency (USD/RMB/CNY/BBD), using the live/editable FX rates already maintained in Settings → Rates & FX (`QR.fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD`, with a "↻ Live Rates" fetch feature and a freshness indicator).

Confirmed by direct code read, every one of these call sites is GBP-fixed with no alternative:
- `rDash()` (`index.html:3634` onward) — Dashboard KPIs: `tR`, `tNP`, `tOut`, `tPO`, `tBuyerDep`, `tSupDep`, credit-note totals, and the P&L chart (lines 3642–3706), all via `toGBP(x, x.cur||'USD')`.
- Buyer edit modal's Summary panel (`index.html:5087`) — outstanding balance.
- Buyer Statement report (`index.html:5132–5133`) — total invoiced, outstanding.

The user's request: a way to dynamically toggle which currency these figures are displayed in, reusing the existing live FX rates, applied "across the board" if possible, or scoped to the active tab as a fallback.

**Explicitly out of scope**: the UK MTD/VAT export (`index.html:4611–4612`, `grossGBP`/`taxGBP`) is a statutory HMRC filing figure and must remain GBP-only regardless of any display preference — this is a legal reporting requirement, not a UI convenience, and toggling it would misstate a VAT return.

## FM-1 Assessment

FM-1 (STACKD_CONTEXT.md) freezes new features on the localStorage stack after v2.9.x, with three narrow exceptions. This feature qualifies under **Exception 1: UI/AI features with no new entities** — no new `K`/`DB` entity is introduced. The only new state is a single scalar display-currency preference, which will be stored as a new field on the existing Settings object (`SS`), not a new entity — arguably also satisfies **Exception 2** (new field on an existing entity, no new sync mapping — this field is never synced to Sheets, purely a local UI preference).

## Requirements

**REQ-CUR-001**: Add a currency selector (GBP/USD/RMB/BBD) visible from the Dashboard, persisted as a display preference (`SS.displayCurrency`, default `'GBP'`, localStorage-backed like other Settings fields — no Sheets sync).

**REQ-CUR-002**: When the display currency changes, `rDash()`'s KPI aggregates, the Buyer Statement report, and the Buyer edit modal's Summary panel must recompute and re-render using the selected currency, via `fromGBP(toGBP(amount, recordCur), displayCurrency)` (composing the two existing helpers — no new conversion math).

**REQ-CUR-003**: Currency symbols/labels displayed alongside converted figures must reflect the selected display currency (not remain hardcoded `£`), for every figure in scope of REQ-CUR-002.

**REQ-CUR-004**: The MTD/VAT export path (`index.html:4611–4612`) is explicitly excluded from this toggle and must continue to compute in GBP unconditionally, regardless of `SS.displayCurrency`.

**REQ-CUR-005**: If the FX rates in `QR` are stale (per the existing freshness indicator, >24h old), the currency selector must surface the same staleness warning already shown in Settings, so a toggled figure is never presented as more current than the underlying rate actually is.

## Acceptance Criteria

- AC-001: Selecting a currency in the toggle updates Dashboard KPI figures within the same render pass, no page reload.
- AC-002: Selecting a currency updates the Buyer Statement report and Buyer edit modal Summary panel figures the next time either is opened/rendered while that preference is active.
- AC-003: The preference persists across a page reload (stored in `SS`/localStorage).
- AC-004: MTD/VAT export figures are byte-for-byte identical regardless of the currently selected display currency (regression test required).
- AC-005: If `QR`'s rates are >24h stale, the toggle/converted figures show the existing staleness indicator styling.
- AC-006: Switching currency and back to GBP reproduces the original figures exactly (round-trip via `fromGBP(toGBP(x))`, allowing for floating-point rounding at 2 d.p.).

## Residual Risks (logged, not blocking)

- **CUR-GAP-001 (anticipated)**: Only Dashboard, Buyer Statement, and Buyer Summary panel are in scope for v1 — Aging Report and any other report not explicitly listed above remains GBP-only until a follow-up extends REQ-CUR-002's call-site list. Not yet confirmed whether an Aging Report exists as a distinct render path; to be checked in spec-gate.
- Historic invoices/POs carry their own native `cur`/`currency` field already — no migration needed, this feature only changes the *display* currency, never the stored transaction currency.

## Changelog

- v1: Initial draft, grounded in direct `index.html` line references for every current GBP-hardcoded call site found so far.
