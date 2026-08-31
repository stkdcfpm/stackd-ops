# REQ-QTE-002 — Per-quote overhead charge overrides (Origin/Dest Charges, FPM Admin)

**Status:** v1 — requirements-gate CONDITIONAL PASS, no blocking findings. Three advisories, all fixed in place (see §8): an inverted claim about Sheets-sync survival in §3, two citation drifts (`prevQteDoc()`, `FIELD_MAPS.qt`), and a missing AC for the overhead-override + per-line-markup-override interaction (now AC-7).
**Type:** Small, additive feature. No data-shape change to existing records (every existing quote is unaffected — see §1.2). Touches `index.html` only.

---

## 1. Business context

### 1.1 The complaint and the diagnosis (from check-first, this session)

User, reviewing a printed Quote (QTE-0001), asked why it carried "Origin Charges $250.00 / Destination Charges $350.00 / Admin $75.00" they didn't remember setting, and why they couldn't adjust or remove them.

Found by direct code read: these three figures are **global** Rate Engine defaults (`QR_DEFAULTS`, `index.html:3433` — `originCharges:250, destCharges:350, fpmAdmin:75`), configurable only in Settings → Rates & FX (`qr-originCharges`/`qr-destCharges`/`qr-fpmAdmin` inputs, `index.html:711-715`). `qteSellTotals()` (`index.html:10542-10551`) adds `qr.originCharges + qr.destCharges + qr.fpmAdmin` to every quote's total, unmarked-up, by design (`SPEC-QTE-001`'s "overhead is never marked up, added at cost" rule — a deliberate, unrelated decision, not being revisited here). `cQte(qt)` (`index.html:10553-10564`), which computes every quote's totals for the list view, the edit-modal summary panel, and the PDF preview, always reads `qr = QR` — the **live** global Settings object, not a value frozen on the quote at creation time. There is no per-quote field or form input to override any of the three values today; the user's only lever is the global Settings, which would also silently change the displayed total on every other quote, past and present, since nothing is snapshotted per quote.

The values the user saw ($250/$350/$75) are simply the factory defaults, never customized — not something specific to that quote, and not adjustable without affecting every quote in the system.

### 1.2 The requested fix

Add an optional **per-quote override** for each of the three overhead components. Unset (blank) on a quote means "inherit the current global Settings value," exactly as `qf-mkp` (quote-level markup) already provides a fallback default for `ql-mkp` (per-line markup override) — this REQ reuses that exact established pattern (see `qteEffectiveMargin()`, `index.html:10537-10540`), not a new one. Setting a value (including `0`, to remove a charge entirely on one quote) overrides only that quote; the global default and every other quote are unaffected.

**Backward compatibility:** every quote saved before this REQ has no `originCharges`/`destCharges`/`fpmAdmin` property on its record at all — `undefined` reads identically to "inherit," so every existing quote's displayed total is byte-identical before and after this ships. No migration needed.

---

## 2. Requirements

### REQ-QTE-002a — New helper: `qteEffectiveOverhead(originVal, destVal, adminVal, qr)`
Returns `{ origin, dest, admin, total }`. For each of the three inputs: if the value is `undefined`, `null`, or `''` (exactly the same three-way blank check `qteEffectiveMargin()` already uses), fall back to the corresponding `qr` global default (`qr.originCharges`/`qr.destCharges`/`qr.fpmAdmin`); otherwise use `+value`. `total` is the sum of the three resolved values. This is the single source of truth for "effective overhead" — every other requirement below calls this helper rather than re-deriving the same fallback logic.

### REQ-QTE-002b — `qteSellTotals()` takes a resolved overhead total, not raw `qr` fields
Change `qteSellTotals(lines, lineCalcs, quoteMarkup, qr)` to `qteSellTotals(lines, lineCalcs, quoteMarkup, overheadTotal, fxGBPUSD)` — it no longer reads `qr.originCharges`/`qr.destCharges`/`qr.fpmAdmin` directly (those become the caller's job, via REQ-QTE-002a), only `fxGBPUSD` for the GBP conversion it already does. All three call sites (`cQte()`, `calcQte()`, `saveQte()`) are updated to compute the effective overhead via `qteEffectiveOverhead()` first, then pass its `.total` and `qr.fxGBPUSD` in. No change to `qteSellTotals()`'s per-line markup logic (the `sellUSD` reduce over `lines`) — only how `overhead` is sourced.

### REQ-QTE-002c — `cQte(qt)` resolves overhead from the saved quote, not raw `QR`
`cQte(qt)` (`index.html:10553-10564`) computes `qteEffectiveOverhead(qt.originCharges, qt.destCharges, qt.fpmAdmin, qr)` and uses its `.total` for `qteSellTotals()`/`quotedTotal`. This is what makes the list view (`rQte()`), the edit-modal summary panel (via `calcQte()`, see REQ-QTE-002e), and the PDF preview all correctly reflect a saved override, since all three ultimately read through `cQte()` or the same helper.

### REQ-QTE-002d — Fix the PDF preview's overhead breakdown (currently reads raw `QR`, bypassing the quote entirely)
`prevQteDoc(q)` (`index.html:11228` onward) already calls `cQte(q)` (line 11229) and correctly uses `c.sellUSD`/`c.sellGBP` for the two total rows — but its three itemized breakdown rows (`index.html:11259-11261`) read `QR.originCharges`/`QR.destCharges`/`QR.fpmAdmin` directly, ignoring `c` entirely. Today this happens to still match (both are read from the same live `QR` at the same moment, since no override exists yet) — but once REQ-QTE-002a-c ship, this becomes a real, visible bug: a quote with a per-quote override would show the correct overridden **total** (via `c.sellUSD`) but the **wrong, unoverridden** itemized Origin/Dest/Admin lines above it. Fix: have `cQte()` return the resolved `{origin, dest, admin}` breakdown (not just the summed `overhead`), and have `prevQteDoc()` read `c.overheadBreakdown.origin`/`.dest`/`.admin` instead of `QR.originCharges` etc.

### REQ-QTE-002e — Quote form: three new optional override inputs, live-recalculating
Add three new number inputs to the Quote create/edit modal, alongside `qf-mkp` (`index.html:2470` area) or directly replacing the existing read-only `qt-orig`/`qt-dest`/`qt-adm` display divs (`index.html:2497-2499`) with editable ones — implementer's call on placement, but functionally: `qf-origOv`, `qf-destOv`, `qf-admOv`, each `type="number" min="0" step="5"`, blank by default, with `oninput="calcQte()"` (matching every other live-recalculating field in this form) and a placeholder showing the current global default (e.g. `placeholder="Default: $250"`) so the operator can see at a glance what they're overriding. `calcQte()` (`index.html:10763-10785`) reads these three fields, resolves via `qteEffectiveOverhead()`, and displays the **effective** value in whatever `qt-orig`/`qt-dest`/`qt-adm` become (plus, if kept as separate display elements rather than folded into the inputs themselves, a visual indicator — e.g. a small "override" tag — when the effective value differs from the current global default, so it's clear at a glance a quote is using a non-default figure).

### REQ-QTE-002f — `openQte()`/`editQte()`/`saveQte()` wiring
- `openQte()` (`index.html:10604-10625`, new quote): clears the three new fields to `''` (inherit), matching how every other field is reset for a new quote.
- `editQte(id)` (`index.html:10627-10652`): loads `q.originCharges`/`q.destCharges`/`q.fpmAdmin` into the three fields — `String(value)` if the property is a number (including `0`), `''` if `undefined` — then calls `calcQte()` (already does, unconditionally, at the end) so the effective values render immediately.
- `saveQte()` (`index.html:10843` onward): reads the three fields; if a field is `''`, the corresponding property is **omitted** from the saved `qt` object (left `undefined`, matching exactly how `qlEffectiveMarkupInput()`'s blank case is already persisted for per-line markup — confirmed existing precedent, not a new pattern); if a field has a value (including `0`), `+value` is stored on `qt.originCharges`/`qt.destCharges`/`qt.fpmAdmin`. The same `qteEffectiveOverhead()` call REQ-QTE-002a introduces is used here too, so the persisted `calc_sellUSD`/`calc_sellGBP` snapshot fields reflect the resolved (possibly overridden) total — unchanged in spirit from how `saveQte()` already resolves per-line markup before persisting `calc_*` fields.

---

## 3. Explicitly out of scope

- **No change to the "overhead is never marked up" rule** (`SPEC-QTE-001`) — this REQ only makes the three overhead *amounts* per-quote-overridable, not how they interact with margin. Confirmed unaffected: the override total is still added to `sellUSD` after markup is applied to line items, exactly as today.
- **No historical snapshot/locking of the global defaults on quotes that don't set an override.** A quote with no override still recomputes live from whatever the current global Settings are, exactly as every quote does today — this REQ does not change that pre-existing behavior (flagged to the user as a caveat in the original conversation, not something this REQ is asked to fix). Only a quote that explicitly sets an override becomes independent of future global-default changes for that specific override.
- **No per-quote override for any other global Rate Engine field** (`lclPerCBM`, `fcl20GP`, `fcl40HQ`, `dgSurcharge`, `insRate`, FX rates) — scoped strictly to the three fields the user asked about (`originCharges`, `destCharges`, `fpmAdmin`). A future REQ could generalize the pattern if needed.
- **No change to `handleTrackerUpdate`, Apps Script, or `FIELD_MAPS.qt`** (`index.html:3978`, not extended with the three new fields). **Corrected at requirements-gate** (§8, finding 1): `qt` *is* one of the entities `syncAll()`/`pushAll()`/`pullAll()` already sync (`synEnts`/`ents`/`simpleEnts`), but leaving `FIELD_MAPS.qt` unextended does **not** put an override at risk of being dropped on a pull-and-merge cycle — `mergePulledWithLocal()` (`index.html:4012-4020`) explicitly preserves any local field not tracked in `FIELD_MAPS` by design (`Object.assign({}, localMatch, pulledMapped)`), which is exactly the same mechanism that already protects `line.priceHistory`/`inv.type`/other untracked fields today. An override set via this REQ therefore survives a Sheets pull-and-merge cycle even without touching `FIELD_MAPS.qt` — the only thing NOT extending it costs is making the override *visible or independently editable in the Google Sheet itself* (an operator using the Sheet directly, rather than the app, wouldn't see or be able to set an override column). That's a real but much smaller gap than "doesn't survive sync" — left out of scope for this REQ since it only matters for a workflow (editing quotes directly in Sheets) this app doesn't otherwise support today.
- **No AI assistant (`create_quote` action) support for setting an override at creation time** — the AI action block schema (`index.html:8989`) is not extended with `originCharges`/`destCharges`/`fpmAdmin` payload fields in this REQ; a quote created via AI action simply inherits the global default like today, and the operator can add an override afterward via the edit modal. Could be added later if requested.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A new quote, no override fields touched | Saved | The quote has no `originCharges`/`destCharges`/`fpmAdmin` properties (or they're `undefined`); its total is identical to today's pre-REQ calculation |
| AC-2 | A quote with Origin Charges override set to `0` | Saved, then reopened, then previewed as PDF | The list view, edit-modal summary, and PDF preview all show $0 for Origin Charges and a correspondingly reduced total — consistently, not just in one of the three places |
| AC-3 | A quote with only Dest Charges overridden (Origin/Admin left blank) | Global Settings' `originCharges`/`fpmAdmin` are later changed | The quote's Origin/Admin figures track the new global values (still inheriting), while Dest Charges stays at the quote's own overridden value, unaffected by the global change |
| AC-4 | Two quotes, one with an override and one without | Both are open in the list/PDF at the same time | The overridden quote's total reflects its override; the non-overridden quote's total reflects the current global default — no cross-contamination between quotes |
| AC-5 | An existing quote saved before this REQ shipped (no override properties on the record at all) | Opened, previewed, or listed after this REQ ships | Total is byte-identical to what it showed before this REQ shipped, given the same global Settings — confirms AC-1's backward-compatibility claim under a real pre-existing record, not just a freshly-created one |
| AC-6 | The PDF preview specifically (`prevQteDoc`) | A quote with any combination of overrides is previewed | The three itemized breakdown lines (Origin/Dest/Admin) and the Sell Price totals are mutually consistent — no repeat of the REQ-QTE-002d bug where the total reflects an override the breakdown lines don't |
| AC-7 (new, requirements-gate) | A quote with both an overhead override (e.g. Origin Charges set to `0`) **and** a per-line markup override on one of its lines | Saved and its total computed | Both overrides apply independently and correctly in the same calculation — the overhead override doesn't affect how the per-line margin is applied to that line's landed cost, and the per-line margin override doesn't affect the overhead total, matching the existing code shape where overhead is summed in *after* the per-line markup reduce (`qteSellTotals()`, `index.html:10543-10548`) |

---

## 5. Testing approach

Fully unit-testable in the existing Node harness (`tests/run.js`) — no Apps Script/network dependency, unlike `REQ-SYNC-002`. Extend the existing Quote test coverage (`qteEffectiveMargin`/`cQte`/`calcQte`/`saveQte` already have tests) with: `qteEffectiveOverhead()` direct unit tests (blank/zero/set cases, mirroring the existing `qteEffectiveMargin` test style), a `cQte()` test confirming a saved override changes `.overhead`/`.quotedTotal` while an unset quote doesn't, a `saveQte()` integration test confirming a blank override field leaves the property unset (not `0`) on the saved record, and a `prevQteDoc`-adjacent test if the existing suite has a way to exercise PDF-building logic without a real DOM (check `tests/run.js`'s existing coverage of `prevQteDoc`/`prevInvDoc`-style functions for precedent before deciding the test's exact shape).

---

## 6. Gate process

Standard requirements-gate → spec-gate → build-gate cycle. Lower risk than `REQ-SYNC-002` (no external backend, no financial-data-adjacent sync logic, no irreversible action) but still touches quote pricing calculations directly — do not skip the cycle, per this project's standing practice for anything touching `cQte`/`qteSellTotals`.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: no existing gap to mark fixed (this was a user question, not a previously-logged gap) — no new gap entry needed either, since this is a feature addition, not a defect fix. §3's resolved Sheets-sync question doesn't need a gap entry either (see §8, finding 1 — confirmed a non-issue, not a deferred one).
- `docs/requirements-tracker.md`: new row.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist; the data-model reference for `QR`/quote object schema (`CLAUDE.md`/`STACKD_CONTEXT.md`, the lines documenting `QR_DEFAULTS` shape and `cQte()`'s return shape) should be updated to mention the new optional per-quote fields and `overheadBreakdown` return field.

---

## 8. Review-resolution log

**Requirements-gate independent review: CONDITIONAL PASS, no blocking findings.** The core diagnosis, the PDF-bug reasoning (REQ-QTE-002d), the backward-compatibility claim (§1.2, AC-1/AC-5), and the reused-pattern justification (REQ-QTE-002a citing `qteEffectiveMargin()`) were all independently verified accurate against the real code — no changes needed there. Three advisories, all fixed:

1. **§3's Sheets-sync-survival claim was inverted.** The original v1 text said an override "would not survive a Sheets pull-and-merge cycle" without extending `FIELD_MAPS.qt`. The reviewer traced `mergePulledWithLocal()` (`index.html:4012-4020`) and found it already preserves any field not tracked in `FIELD_MAPS` by design (the same mechanism protecting `line.priceHistory`, `inv.type`, and other untracked fields today) — so an override *does* survive a pull-and-merge without touching `FIELD_MAPS.qt`; the only real cost of leaving it unextended is that the override wouldn't be visible or settable directly in the Google Sheet itself. **Fixed:** §3 rewritten to state this correctly.
2. **Two citation drifts.** `prevQteDoc()` is claimed to start at line 11229 in v1; it actually starts at 11228 (`cQte(q)` itself is called at 11229). `FIELD_MAPS.qt` was cited at line 3963 (actually inside an unrelated `delEnt()` catch block); the real entry is at line 3978. **Fixed:** both citations corrected.
3. **Missing AC for the overhead-override + per-line-markup-override interaction.** Low risk (the two mechanisms are additive and independent in the code — overhead is summed in *after* the per-line markup reduce), but nothing in v1 explicitly tested it. **Fixed:** added AC-7.

Proceeding to spec-gate.
