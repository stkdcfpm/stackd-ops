# SPEC-SUP-001-v2: Supplier Price Intelligence Retention & Reference View

**Supersedes:** SPEC-SUP-001-v1 (independent spec-gate CONDITIONAL PASS — no blocking defects; the aggregation logic, field-name assumptions, date-format claim, and modal wiring were all independently re-verified as correct against live code. Two advisory items: (1) the `renderDispCurWarn()` citation (`index.html:3807-3818`) was wrong — that range is actually `toGBP()`/`fromGBP()`; the real function is at `index.html:3826-3837` (an error this spec inherited uncaught from `REQ-SUP-001`'s own citation, itself never caught in that REQ's independent gate rounds); (2) REQ-SUP-001f (no export/sync of the aggregated data) had no corresponding test-plan bullet. Both resolved below — no logic changes.)

## 0. Design decisions, 1. `getSupplierPriceHistory()`, 2. `supPriceStaleness()`

Unchanged from v1 — all independently re-verified correct: source field shapes (`saveLI()` `index.html:4391-4409`, `saveQte()` `index.html:9275-9309`, `savePO()` `index.html:5731-5736`/`cPL` `5702`), the `cost`-not-`landed` decision, and the `YYYY-MM-DD` date-format claim across all three sources (`today()` at `index.html:2390` confirmed to genuinely emit `YYYY-MM-DD`; `pf-dt` confirmed `<input type="date">` at `index.html:1989`).

One clarifying note added to §2, not a logic change: `supPriceStaleness()`'s `if (!dateStr) return null` guard catches missing/empty input, but a non-empty *malformed* date string would still flow through to `NaN` rather than `null`. This is currently unreachable — every real source in this spec (`today()`, an ISO `ts`, an `<input type="date">`) can only ever produce a valid `YYYY-MM-DD` string or `''` — but the guard's actual scope is narrower than "handles any bad input," and REQ-SUP-001e's future fourth source (RFQ responses, not yet built) isn't guaranteed to preserve that property. Worth a one-line code comment at build time noting this, not a functional change now.

## 3. `renderSupPriceHistory()` — citation corrected

Unchanged code from v1. **Corrected citation:** the staleness visual treatment reuses `renderDispCurWarn()`'s established amber palette, correctly located at **`index.html:3826-3837`** (not `3807-3818`, which is actually `toGBP()`/`fromGBP()` — an unrelated currency-conversion pair). The colour values themselves (`#FFF8E1`/`#F9A825`-range) were already correct; only the line reference was wrong.

## 4. Staleness threshold setting, 5. Supplier modal wiring, 6. Cross-supplier product view, 7. REQ-SUP-001e forward-compat

Unchanged from v1 — all independently re-verified: `openSup()`/`editSup()`/`renderSupContacts()` citations confirmed exact (`index.html:4263-4272`, `4273-4284`, `4225-4235`), `sup-con-panel`'s HTML block confirmed exact (`index.html:950-957`), `getProductPriceHistory()`'s `Object.assign` confirmed collision-free (aggregation points never carry `supName`/`supId` keys) and `desc.toLowerCase()` confirmed safe (every source block defaults `desc` to `''`, never `undefined`).

## GDPR Data Flow

Unchanged from v1, independently re-verified: `po.lineItems[]` and `q.lines[].priceHistory[]` confirmed to carry no Contact-level PII, and the Quote priceHistory's free-text `note` field is correctly excluded from the pushed aggregation point (confirmed as a deliberate omission, not an oversight).

## Test Plan (`tests/run.js`)

Unchanged from v1, one bullet added closing the REQ-SUP-001f gap:

- `getSupplierPriceHistory()` through `openSup()`/`editSup()` DOM integration: unchanged from v1 (all 9 bullets).
- **(new, closes v1's REQ-SUP-001f gap)** No test in this suite calls or depends on any CSV-export or Sheets-sync function for the aggregated Price History data — confirmed by asserting `getSupplierPriceHistory()`/`getProductPriceHistory()`'s return values are plain in-memory arrays with no export/sync side effect, and that no new entry was added to `TEMPLATES`/`FIELD_MAPS` for this feature. This is a regression guard against scope creep (an implementer adding an "export" button that wasn't asked for), not just documentation that REQ-SUP-001f was read.

## Changelog

- v1: Initial spec implementing REQ-SUP-001-v2.
- v2: Independent spec-gate CONDITIONAL PASS on v1 (no blocking defects) resolved — corrected a citation inherited from the REQ, closed a test-plan gap for REQ-SUP-001f, and added a clarifying (non-functional) note on `supPriceStaleness()`'s guard scope. No calculation or wiring logic changed from v1.
