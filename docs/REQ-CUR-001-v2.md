# REQ-CUR-001-v2: Global Display-Currency Toggle

**Supersedes:** REQ-CUR-001-v1

## Business Context

Every financial aggregate in the portal is currently hardcoded to display in GBP, converted via `toGBP(amount, cur)` (`index.html:3552`) from each record's native transaction currency (USD/RMB/CNY/BBD), using the live/editable FX rates already maintained in Settings → Rates & FX (`QR.fxGBPUSD`/`fxGBPRMB`/`fxGBPBBD`, with a "↻ Live Rates" fetch feature and a freshness indicator).

Confirmed by direct code read, these call sites are GBP-fixed with no alternative:
- `rDash()` (`index.html:3634` onward) — Dashboard KPIs: `tR`, `tNP`, `tOut`, `tPO`, `tBuyerDep`, `tSupDep`, credit-note totals, and the P&L chart (lines 3642–3706), all via `toGBP(x, x.cur||'USD')`.
- Buyer edit modal's Summary panel (`index.html:5087`) — outstanding balance.
- Buyer Statement report (`index.html:5132–5133`) — total invoiced, outstanding.

**Explicitly out of scope**:
- The UK MTD/VAT export (`index.html:4611–4612`, `grossGBP`/`taxGBP`) is a statutory HMRC filing figure and must remain GBP-only regardless of any display preference — this is a legal reporting requirement, not a UI convenience.
- The **Aging Report** (`openAgingReport()`/`renderAgingReport()`, `index.html:4799–4885`, nav-linked and in the changelog) is a real, distinct render path — confirmed by code read it does **not** call `toGBP` at all today; it buckets invoices by due date, not by converted totals. It performs no currency conversion currently, so it is out of scope for v1 (no existing GBP-hardcoded behavior to toggle). Logged as CUR-GAP-001 below, not an open question.
- Per-buyer native currency display: `buyer.currency` (set in the Buyer edit form, `index.html:5114`) is already used in some Buyer-panel figures as a per-record display currency, independent of any global aggregate. This existing convention is **not replaced or overridden** by the new global toggle — see REQ-CUR-006 for the precedence rule.

## FM-1 Assessment

FM-1 (STACKD_CONTEXT.md) freezes new features on the localStorage stack after v2.9.x, with three narrow exceptions. This feature qualifies under **Exception 1: UI/AI features with no new entities** — no new `K`/`DB` entity is introduced. The only new state is a single scalar display-currency preference.

**Storage location correction from v1**: v1 incorrectly proposed storing this on `SS` (`index.html:2244`), describing it as "the existing Settings object." In the actual code, `SS = ld(K.ss)` is specifically the **Sheets sync/connection config** (`{url, auto, pol, token}`) — and `expAll()` (`index.html:8004`) exports only `{url, auto, pol}` from it, dropping any other field silently on every backup; `doImport()` (`index.html:8053`) replaces `SS` wholesale on restore. A field placed there would be lost on every export/import round-trip.

**Corrected location: `QR`** (`index.html:2248`-ish, `st_qr` key). Confirmed `expAll()` exports `qr: ld('st_qr')` in full (`index.html:8007`) and `doImport()` restores it wholesale — the entire object round-trips through backup/restore for free, and it is already the object holding the FX rates this feature is built on. New field: `QR.displayCurrency` (default `'GBP'`), merged via the existing `QR_DEFAULTS` fallback pattern (`var QR = {...QR_DEFAULTS, ...ld('st_qr')}`) so pre-existing backups without the field simply default to `'GBP'` on load — no migration function needed.

This also satisfies **Exception 2** (new field on an existing entity, no new sync mapping) — `QR` has no `FIELD_MAPS` entry / is never synced to Google Sheets.

## Requirements

**REQ-CUR-001**: Add a currency selector (GBP/USD/RMB/BBD) visible on the Dashboard, persisted as `QR.displayCurrency` (default `'GBP'`), saved via the existing `sv(K.qr, QR)` — no Sheets sync.

**REQ-CUR-002**: When the display currency changes, `rDash()`'s KPI aggregates must recompute and re-render in the same render pass (no reload), via `fromGBP(toGBP(amount, recordCur), QR.displayCurrency)`.

**REQ-CUR-003**: The Buyer Statement report and Buyer edit modal's Summary panel must use `QR.displayCurrency` for their GBP-aggregated figures (total invoiced, outstanding) the next time either is opened/rendered after the preference changes — these are modal-open renders, not live-while-open, since neither currently re-renders on external state change while already displayed (consistent with how these modals already behave for any other Settings change, e.g. editing `QR` rates does not live-update an open Buyer Statement either).

**REQ-CUR-004**: Currency symbols/labels displayed alongside converted figures in scope of REQ-CUR-002/003 must reflect `QR.displayCurrency` (not remain hardcoded `£`).

**REQ-CUR-005**: The MTD/VAT export (`index.html:4611–4612`) is explicitly excluded and must continue to compute in GBP unconditionally, regardless of `QR.displayCurrency` — verified by a fixture-based regression test (see AC-004).

**REQ-CUR-006**: The existing per-buyer `buyer.currency` display convention (`index.html:5114`, `5134-5135`) is unaffected by this feature — it continues to show that buyer's own figures in their own transaction currency. `QR.displayCurrency` only applies to the *aggregate* totals in scope (REQ-CUR-002/003), never to a single buyer's own-currency figures. Where both could apply to the same rendered panel, the per-buyer currency wins for that buyer's own-currency figures, and the new toggle applies only to totals explicitly aggregated across multiple buyers/records.

**REQ-CUR-007**: If `QR`'s rates are stale (per the existing freshness indicator, >24h old), the currency selector and every converted figure in scope must surface the same staleness warning already shown in Settings.

## Acceptance Criteria

- AC-001: Selecting a currency in the Dashboard toggle updates KPI figures within the same render pass, no page reload.
- AC-002: Selecting a currency updates the Buyer Statement report and Buyer edit modal Summary panel figures the next time either is opened while that preference is active (not live while already open — matches REQ-CUR-003).
- AC-003: `QR.displayCurrency` persists across a page reload (round-trips through `sv(K.qr, QR)`/`ld(K.qr)`) and through a full backup export → import cycle (round-trips through `expAll()`'s `qr` key).
- AC-004: Using a fixed fixture dataset (3 invoices: one GBP, one USD, one RMB, each with a known `iCalc().grand`/`.tax`), the MTD/VAT export's `grossGBP`/`taxGBP` totals are identical whether `QR.displayCurrency` is `'GBP'`, `'USD'`, or `'RMB'` at export time — pinned to specific expected numeric totals in the test, not just "unchanged."
- AC-005: If `QR`'s rates are >24h stale, the toggle and every converted figure in scope show the existing staleness indicator styling.
- AC-006: Switching `QR.displayCurrency` to a non-GBP currency and back to `'GBP'` reproduces the original GBP figures exactly to 2 decimal places (round-trip via `fromGBP(toGBP(x, cur), 'GBP')` composing back to `toGBP(x, cur)` — no double conversion drift beyond standard rounding).
- AC-007: A Buyer Statement/Summary panel figure that is a single buyer's own-currency amount (via `buyer.currency`) is unaffected by `QR.displayCurrency` — only cross-buyer aggregate totals convert.

## Residual Risks / Known Gaps (logged, not blocking)

- **CUR-GAP-001**: Aging Report performs no currency conversion today (works off due-date buckets, not converted totals) and is out of scope for v1. If a future version adds multi-currency aggregation to Aging Report, it should adopt `QR.displayCurrency` at that time — no retrofit planned now.
- Historic invoices/POs carry their own native `cur`/`currency` field already — no migration needed; this feature only changes the *display* currency, never the stored transaction currency.
- Mid-session rate edits: if an operator edits `QR`'s FX rates in Settings while a converted figure is already on-screen (e.g. Dashboard open in one context, Settings open in another), the on-screen figure will not live-update until next render — consistent with existing behavior for GBP figures today (they are not live-updated on rate change either), so this is not a new risk introduced by this feature, only inherited from existing `toGBP()` usage.

## Changelog

- v2: Fixed storage-location error (`SS` → `QR`, with an accurate description of what `SS` actually is and why it would silently drop the field on backup/restore); resolved CUR-GAP-001's "not yet confirmed" language (Aging Report exists, confirmed no currency conversion, explicitly out of scope); added a concrete fixture/expected-value basis for AC-004; reconciled AC-001 vs AC-002 re-render timing with an explicit rationale (REQ-CUR-003); added REQ-CUR-006/AC-007 to state the precedence rule between per-buyer native currency and the new global toggle.
- v1: Initial draft (superseded — storage location and Aging Report claims were incorrect).
