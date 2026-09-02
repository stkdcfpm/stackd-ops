For full project context including business strategy, FPM data, and programme roadmap, read STACKD_CONTEXT.md in this repo root.

For operator-facing workflow detail (how to use each tab/feature today), read docs/user-guide.md.

# Stackd Ops — Claude Code Context

## What this project is
Trade operations portal for FPM (Freight + Procurement Management). Single-file browser app — all code lives in `index.html`. No build step, no framework, no dependencies (one acknowledged exception: `vendor/supabase-js-v2.min.js`, a vendored same-origin static file used for Supplier/Buyer, Line Item, Contact, Order Request, and Quote when Cloud Data is configured — REQ/SPEC-CLOUD-001, extended to Line Item/Contact by REQ/SPEC-CLOUD-002, to Order Request by REQ/SPEC-CLOUD-003, and to Quote by REQ/SPEC-CLOUD-004, no CDN, no auto-update). Deployed via GitHub Pages.

**Current version: v2.9.75**  
**Test count: 752/752 PASS** (`node tests/run.js`)

---

## Architecture

| Concern | Detail |
|---|---|
| All code | `index.html` — HTML + `<style>` + `<script>` in one file |
| Companion tools | `triage.html` — standalone "FPM Enquiry Triage — 10 Minute Screen", served at `app.getstackdops.com/triage.html`. Not linked from the main app nav. Exports a CSV matching `TEMPLATES.ord`'s exact header contract (`index.html:6312`) on a "Cleared for study" verdict, importable via the Import Data tab's Order Requests step. The two files are kept in sync manually — no build step connects them; if `TEMPLATES.ord.headers` changes, `triage.html`'s duplicated `ORD_HEADERS` literal must be updated by hand. |
| Persistence | `localStorage` only — no server, no API |
| **Public repo policy** | **GitHub Pages serves the ENTIRE repo at app.getstackdops.com. Every committed file is publicly readable. Never commit live data exports, backups, personal contact details, or credentials (SEC-GAP-020). `.gitignore` blocks `Test-data/` and `Stackd-*.json`.** |
| Tests | `tests/run.js` — Node.js VM sandbox, run with `node tests/run.js` |
| Known gaps log | `docs/known-gaps.md` |
| Version history | `docs/version-history.md` |
| DR procedure | `docs/dr-procedure.md` |
| Agent architecture | `docs/agent-architecture.md` |
| Council decisions log | `docs/councils/` — verdicts from LLM Council sessions |
| Branch for new work | `claude/csv-import-newline-fix` |

---

## State layer

```js
const K = { s, l, i, p, pm, sh, qt, ss, as, au, ai, co, ev }  // localStorage keys
let DB = { sup, li, inv, po, payments, sh, qt, con, events }   // all entity arrays
let EI = { s, l, i, cn, p, sh, qt, co }                // currently-editing ID (null = new)
let cIL = [], cPL = [], cQL = [], cCNL = []             // live line-item arrays for modals
const QR_DEFAULTS = { fxGBPUSD, fxGBPRMB, fxGBPBBD, lclPerCBM, fcl20GP,
                      fcl40HQ, originCharges, destCharges, dgSurcharge,
                      insRate, fpmAdmin }
var QR = { ...QR_DEFAULTS, ...ld('st_qr') }             // active rates (editable in Settings)
```

`saveAll()` persists every DB entity. `ldArr(k)` always returns `[]` if localStorage key is absent or malformed.

---

## Entities

| Key | Store key | Description |
|---|---|---|
| sup | st_s | Suppliers |
| li | st_l | Line items (product catalogue) |
| inv | st_i | Invoices |
| po | st_p | Purchase orders |
| payments | st_pm | Payment ledger entries |
| sh | st_sh | Shipments |
| qt | st_qt | Quotes (v2.9.4) |
| co | st_co | Contacts (v2.9.27) |
| events | st_ev | Activity event log (v2.9.28) |
| ord | st_ord | Order Requests (v2.9.44) |

---

## Quote engine (v2.9.4)

Calculation chain:

```
cQteLine(line, qr, freightMode, totalCBM)
  → { freight, dgAmt, ins, duty, landed }

qteEffectiveOverhead(originVal, destVal, adminVal, qr)   // v2.9.68
  → { origin, dest, admin, total }   // blank/undefined/null inherits qr's default; any value (incl. 0) overrides

cQte(qt)
  → { totalLanded, overhead, overheadBreakdown, quotedTotal, sellUSD, sellGBP, lineCalcs[] }
```

Versioning triggers (on `saveQte()`): cost, dutyPct, or markup changed from last saved version. First save always creates v1. Each version entry: `{ v, ts, cost, dutyPct, markup, landed, sellPrice, note }`. `sellPrice = landed × (1 + markup/100)`. Stored on `line.priceHistory[]` inside the quote record.

**Per-quote overhead overrides (v2.9.68, REQ/SPEC-QTE-002):** a quote record may optionally carry `originCharges`/`destCharges`/`fpmAdmin` — each independently overrides the corresponding `QR` global default for that one quote only, when present. Absent (the case for every quote saved before v2.9.68) means "inherit the current global default," resolved live on every `cQte()` call — same non-snapshotted-default behavior the rest of `QR` already has. `saveQte()` only sets a property when its form field is non-blank; blank omits the key entirely rather than storing `undefined`, mirroring how per-line `markup` overrides are already persisted.

**RFQ response edit/delete (v2.9.69, REQ/SPEC-ORD-006):** `editRfqResponse(lineId, responseId)`/`delRfqResponse(lineId, responseId)` let an operator correct or remove a recorded RFQ response on an Order Request line. **Editing an existing response never reuses its `id`** — `saveRfqResponse()`'s edit path (keyed by module-level `cRfqEditId`) writes a fresh `uid()` onto the replacement object and, if the edited response was `line.committedResponseId`, repoints that field to the new id (deleting a committed response nulls it instead). This is deliberate, not an oversight: `renderQteSourceDriftWarn()` (Phase 1 of REQ/SPEC-INTEG-001) detects staleness purely by comparing `ordLine.committedResponseId !== quoteLine.sourceRfqResponseId` — an in-place mutation keeping the same id would leave that comparison silently matching and the staleness banner would never fire for an edited-then-stale Quote. Do not "simplify" the edit path to mutate in place without re-deriving this consequence. `cRfqEditId` is module-level UI state, not part of `DB` — `resetDB()` does not clear it, so tests must reset it explicitly (either directly or by driving a full `saveRfqResponse()` call, which clears it as its last step).

**RFQ email-parse (v2.9.70, REQ/SPEC-AI-GAP-011):** `rfqOpenEmailParse(lineId, responseId)`/`rfqParseUpdateFromEmail(emailText, currentResponse)`/`rfqApplyEmailParse(lineId)` let an operator paste a supplier's email and get an AI-extracted diff of commercial fields to Apply or Discard. `rfqApplyEmailParse()` never persists anything itself — it calls the real `editRfqResponse()`/`saveRfqResponse()` (unmodified) after overwriting only the AI-proposed fields on the pre-filled edit form, so it inherits the id-rotation/`committedResponseId`-repoint/staleness-banner mechanism above automatically. **Cross-line gotcha, do not remove without re-deriving:** the pending-proposal state (`cRfqEmailParseLineId`/`cRfqEmailParseRespId`/`cRfqEmailParseProposed`) is tracked with an explicit `cRfqEmailParseLineId`, unlike `cRfqEditId`'s single flat var — this is required, not defensive-programming excess, because `rOrdLines()` renders every Order Request line's own comparison panel simultaneously (unlike the single global `ov-rfq` modal `cRfqEditId` is paired with), so two different lines can each have a completed, unapplied AI proposal on screen at once. `rfqApplyEmailParse(lineId)` checks `lineId !== cRfqEmailParseLineId` before doing anything, and separately checks `cRfqEditId !== responseId` right after calling `editRfqResponse()` before writing any field — removing either guard was proven live to cause real damage: mutation-testing the first guard away doesn't corrupt data (the second guard still catches it) but does silently wipe out a different, still-legitimate line's pending proposal as collateral damage, breaking that line's own subsequent Apply. All three tracking vars are module-level UI state, not part of `DB` — `resetDB()` does not clear them.

**CSV import parser (v2.9.71, REQ/SPEC-DATA-003):** `parseImportCSV()` parses the entire uploaded CSV text as one character stream with continuously-tracked quote state — a newline is a row separator only when not inside an open quote (`inQuote`). **Do not "simplify" this back to splitting on `\n` first and parsing each line independently** — that was the exact shape of a real, live production bug: a quoted multi-line Notes/Address cell (as Excel/Sheets commonly export) got torn into multiple separate phantom records, each with a real `id`/`SUP-####` number, invisible to `isPhantomRecord()` (which only checks for a missing id). This function is shared by every CSV import type (`sup`/`li`/`inv`/`po`/`ord`/`co`) via `processImport()` — fixing it fixes all six uniformly; do not add per-entity parsing logic. It also supports RFC 4180 escaped quotes (`""` inside a quoted field → one literal `"`), which the pre-v2.9.71 parser never had. One accepted, deliberate divergence: a bare standalone `\r` (not part of `\r\n`, not inside a quote) is silently dropped rather than preserved — judged harmless since no realistic CSV export produces that shape.

**Purchase Order field shape (v2.9.72, REQ/SPEC-PO-002):** every real Purchase Order record uses `lineItems`/`date`/`cur`/`fpmFunded`/`fpmRecovered` at the document level and `{rid, lid, desc, sku, uom, qty, cost}` per line item — `savePO()`, `autoPos()`, `editPO()`, `rPO()`, `prevPODoc()`, `renderPoSourceDriftWarn()`, and `FIELD_MAPS.po` all agree on this shape. **If you ever add a new code path that creates a `DB.po` record, use exactly these field names — do not invent parallel ones** (e.g. `dt`/`currency`/`lines`), even if they seem locally reasonable at the call site. This is not a hypothetical warning: `qteToPoConvert()` did exactly that for an unknown number of shipped versions, and the resulting Purchase Orders were created successfully but silently unusable everywhere downstream (empty editor, $0 totals, no drift detection) until `PO-GAP-005` was found and fixed. If a future migration or import path is found producing the old shape, `migrateQtePoShape()` (`index.html`, immediately after `backfillInvoicePOs()`) is the existing, idempotent, wired-in-5-places pattern to extend or copy — do not write a second, parallel migration function for the same class of problem.

**Cloud Data (Supabase) — per-entity independence, not a single on/off switch (v2.9.54–v2.9.75, REQ/SPEC-CLOUD-001/002/003/004):** `_sb` truthy means Cloud Data is *configured*, not that any particular entity has actually migrated — Supplier/Buyer, Line Item, Contact, Order Request, and Quote each migrate independently, on their own schedule, via their own button in Settings → Cloud Data. **Never gate a new Cloud-Data code path on bare `_sb` truthiness alone unless you are certain the entity in question is always migrated together with `_sb` being configured** (only true today for Supplier/Buyer's original `saveSup()`/`delSup()`-style branches, which is why those stayed bare-`_sb`-gated). Anything that mutates an *existing* Line Item/Contact/Order Request record by `id` outside its own `save*()`/`del*()` function (a linking/unlinking action, a cascade from another entity's delete, a status side-effect from another entity's save) must instead check that entity's own local completion marker (`st_li_cloud_migration_ts`/`st_con_cloud_migration_ts`/`st_ord_cloud_migration_ts`) before deciding whether that `id` is a real Supabase UUID or still a local `uid()` string — five existing UI sites (`unlinkSupCon`, `openSupConPicker`, `delSup()`'s Contact cascade, `saveQte()`'s Contact conversion, `delQte()`'s Contact revert) plus `saveInv()`'s Line Item price-history auto-recording were all bypassing this the first time Line Item/Contact were added to Cloud Data, discovered only in round 3 of spec-gate for REQ-CLOUD-002 — check for this class of bug explicitly (grep for direct `DB.con`/`DB.li` field mutations followed by a bare `sv(K.co,...)`/`sv(K.l,...)`) whenever a new entity is added to Cloud Data scope. Also: `refreshLIFromSupabase()`/`refreshConFromSupabase()`/`refreshOrdFromSupabase()` refuse to overwrite local data unless that entity's marker is set or there's nothing local to lose (`index.html`, immediately after `refreshBuyFromSupabase()`) — wiring a new entity's refresh unconditionally into `initCloudDataLayer()` without this guard would silently wipe every existing adopter's real local data on their first reload after the new table ships empty (REQ-CLOUD-002's round-1 finding, and REQ-CLOUD-003's spec-gate round-1 independently made the identical mistake — the refresh function existed and passed its own unit test but was never actually wired into `initCloudDataLayer()` at all). And the Supplier-migration-completion precondition (`isSupplierMigrationComplete()`) queries the live, currently-connected project rather than trusting a local flag alone, specifically so a stale marker left over from a previously-connected project can't silently pass — any new precondition of this shape should do the same, plus a live pre-flight check on the actual foreign-key values being migrated (see `migrateLineItemsToSupabase()`/`migrateContactsToSupabase()`'s `knownSupIdSet` pattern), not just on whether the precondition itself is satisfied. **Order Request has no such precondition at all** (`REQ-CLOUD-003`): its Lines/RFQ Responses live in one opaque `jsonb` column with nested ids that are never independently remapped, so there is nothing for a Postgres FK to validate against and nothing for a pre-flight check to verify — `contact_id`/`active_quote_id` are plain nullable `text` columns (not `uuid` — a not-yet-migrated Contact or a Quote, which isn't Cloud-eligible at all, always carries a `uid()`-format local id, never RFC-4122). **`persistOrdChange(ord, skipRefresh)`** is the shared helper for the ten Order Request mutation sites that update an already-existing record (`saveOrd()`'s own create path gets its own dedicated branch instead, mirroring `saveCon()`/`saveLI()`'s create-or-update shape, since `persistOrdChange()` has no way to assign a new id); pass `skipRefresh=true` plus one trailing `refreshOrdFromSupabase()` call when pushing multiple touched records in a loop (a cascade, a bulk renumber) rather than refreshing after every single record — otherwise every push after the first wastes a redundant round trip. **Converting an existing synchronous function to `async` to route it through a new Cloud-Data helper is not safe by inspection of production callers alone** — audit the *test suite's own direct calls* to that function too: an `async` function wraps every return value (even an untouched early `return false`) in a Promise, and any code placed after the function's own first `await` is deferred to a microtask that a synchronous `test()` (as opposed to `testAsync()`) will never wait for. REQ-CLOUD-003's spec-gate confirmed every production caller was safe but missed exactly this for the pre-existing test suite, breaking 12 tests undetected until an explicit trace of every direct test-suite call site was done. Relatedly, converting a `forEach(fn)` callback loop to a `for` loop so it can `await` per-iteration means every `return` inside the old callback (a "skip to next item") must become `continue` — a bare `return` inside a `for` loop exits the whole enclosing function, not just that iteration; `processImport('ord')`'s conversion needed this in three places and the existing test suite had no case where an early skip preceded a later valid item, so this class of regression went undetected until a purpose-built test was added.

**Quote (`REQ-CLOUD-004`) is the first entity in this series whose own id is referenced *outward* by other entities** — `Order Request.activeQuoteId`, `PurchaseOrder.quoteId`, `Invoice.linkedQuoteId` — every prior entity only had things pointing *into* it that its own migration never needed to touch. `migrateQteToSupabase()` therefore sweeps outward as well as archiving/remapping its own ids: match every other entity's field against the id-map built during Quote's own insert loop, never against `Quote.linkedPOIds[]` itself (that array can carry a stale entry per `PO-GAP-007`, so it's not a safe join key). Where the referencing entity has its own Supabase table already (Order Request does; Purchase Order and Invoice don't yet), a plain local field fix is not enough — push it through that entity's own `persist*Change(x, true)` helper before this function returns, or the very next `refresh*FromSupabase()` call (and there are many trigger surfaces once an entity has migrated) silently reverts it. This makes Quote's cross-phase retrofit five-directional instead of the usual one: the four existing sweep functions each gained a "push the touched Quote back to Supabase if Quote has migrated" retrofit (inward), and `migrateQteToSupabase()` itself gained the same for Order Request (outward) — expect any future entity referenced outward by others (Purchase Order, `REQ-CLOUD-005`, almost certainly qualifies via `Quote.linkedPOIds[]`/`Invoice`) to need the identical both-directions treatment.

**Wiring a new entity's refresh function into `initCloudDataLayer()` isn't just a data-loss risk for that entity — it can silently corrupt the shared test suite's `localStorage` for entities that came before it.** `initCloudDataLayer()` calls every entity's `refresh*FromSupabase()` unconditionally in sequence; each one self-marks that entity's own `st_*_cloud_migration_ts` on a successful load, including the harmless-looking "local data is empty" case a test fixture leaves behind by default. Every *pre-existing* test that mocks `_sb` and calls `initCloudDataLayer()` — there is exactly one across four entities' worth of Cloud Data history, `tests/run.js`'s own `'initCloudDataLayer — now also calls refreshOrdFromSupabase()...'` test — predates whatever entity you're adding next and does not know to stub its new refresh call; left unfixed, adding the new entity to `initCloudDataLayer()` makes that one test permanently set the new entity's migration marker, which then silently reroutes a *different*, unrelated, already-shipped test later in the file onto the Cloud-Data branch it never intended to exercise (confirmed live for Quote: it broke a pre-existing Order Request test two sections later). Whenever a new entity's refresh function is added to `initCloudDataLayer()`, retrofit that one test's `_sb` mock and stub list in the same change — don't wait for a downstream test to fail and go looking for why.

**`!= null ? val : undefined` inside an object literal does not omit the key.** `{ foo: x != null ? x : undefined }` still produces an object where `'foo' in obj` is `true` — JavaScript distinguishes "key absent" from "key present with value `undefined`," and this idiom only ever produces the latter. Any Cloud-Data field this codebase treats as optional-and-absent-when-unset locally (Quote's `originCharges`/`destCharges`/`fpmAdmin`, set only via `if (rawInput !== '') qt.field = ...`) must be added to the mapped object conditionally (`if (row.x != null) obj.field = row.x;`) when reading it back from Supabase, not assigned this way — otherwise every Quote round-tripped through Cloud Data gains three keys no local-only Quote ever had, which is exactly the kind of silent shape-drift a test asserting `'field' in obj === false` is needed to catch (assert the negative, not just the positive value).

---

## Key coding conventions

- **Validation helpers:** `vErr(id, msg)` / `vOk(id)` / `vClr(id)` / `vFormOk(modalId)`
- **XSS:** Always wrap user-supplied strings in `san()` before inserting into `innerHTML`.
- **Async save functions** are called fire-and-forget from `onclick`. `syncEnt`/`delEnt` have internal try/catch — chain `.catch(function(){})` on all calls for consistency.

Reference data helpers:
- `getAllPorts()` — merges `RD_PORTS` + `getCustomPorts()` (from `stackd_custom_ports`)
- `getPaymentTerms()` — merges `RD_PAYMENT_TERMS_BASE` + `rd_pt_cust`
- `getUOM()` — merges base UOM + `rd_uom_cust`

View routing: `showV(v, tab)` dispatches to render functions via the `fns` map. Adding a new top-level entity requires entries in: `K`, `DB`, `EI`, `saveAll`, `showV fns`, `renderAll`, `expAll snap`, `doImport entities`.

---

## Test runner notes

- Mock environment: `mockEl(id)` returns `{ value:'', checked:false, style:{}, classList:{} }` — no `focus()`, `remove()`, `querySelector()`
- `resetDB()` sets `ctx.DB = { sup:[], li:[], inv:[], po:[], payments:[], sh:[], qt:[] }`
- `let`/`const` in app script are promoted to `var` by the test harness so they appear on `ctx`
- Async save functions (e.g. `saveShp`, `saveQte`) mutate DB synchronously before any `await` — tests call them without `await` and assert DB state immediately after

---

## On version delivery

At the end of each version delivery, update:

- **This file** — bump Current version, update Test count, update branch name if changed, tick off sprint items
- **`docs/version-history.md`** — prepend new version row
- **`docs/known-gaps.md`** — add new gap entries as they are identified
- **`STACKD_CONTEXT.md`'s "Backlog carried forward" table** — add any new gap logged this delivery, remove/mark any item that shipped or was superseded, and add a row for the next explicit step of an in-flight multi-phase initiative (e.g. "sub-phase 2b is next" once 2a ships). This table exists so a fresh session (a new Cowork session, a plain Claude chat) can answer "what's next, priority-wise" without re-deriving it from `docs/known-gaps.md`/`docs/requirements-tracker.md` from scratch — treat it as stale, not optional, if it doesn't reflect this delivery's findings.
- **`AI_SYSTEM_PROMPT` in `index.html`** — **mandatory on every version, no exceptions.** Review against every change shipped. If any new entity, field, feature, workflow, setting, or known quirk was added or changed, update the prompt. Ask: "If the user asked the AI about this feature, would the answer be accurate?" A version is not complete until the prompt reflects current portal behaviour.
- **`docs/user-guide.md`** — update the relevant feature-area section if this release changed operator-visible behavior (new feature, changed workflow, changed field). Skip only if the change is purely internal (bug fix with no visible behavior change, test-only, refactor).
- **In-app changelog** — prepend a new version block with bullet-point summary of changes
- **Raise a PR** — push the branch and raise a PR so the user can test functionality in the portal before merging

---

## Known gaps (summary)

See `docs/known-gaps.md` for full entries.

| ID | Area | Summary |
|---|---|---|
| QTE-GAP-001 | Quote status | Convert to PO restricted to Accepted status — Fixed v2.9.25 |
| PO-GAP-001 | Quote→PO conversion | qteToPoConvert() attributed every line to the first line's supplier — Fixed v2.9.44 (REQ/SPEC-PO-001, one PO per distinct supplier) |
| PO-GAP-002 | Quote→PO conversion | POs created before v2.9.44 may carry incorrect supplier attribution — not retroactively corrected, no automated audit |
| LIB-GAP-001 | Library sync | `syncEnt('li')` not called when `invoiceRefs` mutates |
| SEC-GAP-001 | Code.gs secrets | Spreadsheet IDs and sync token hardcoded in source |
| SEC-GAP-002 | Sheets sync GDPR | PII transmitted externally; opt-in; accepted until first external client |
| SEC-GAP-003 | API key in browser | Anthropic key in localStorage — inherent no-server constraint |
| SEC-GAP-004 | Invoice locking | Client-side UX control only — not tamper-proof |
| AI-GAP-007 | AI assistant | Action block emission inconsistent — temperature 0.2 mitigation shipped v2.9.42, confirmed 3/3 on retest |
| AI-GAP-008 | AI assistant | create_po required internal supId with no name resolution — Fixed v2.9.55 via new get_suppliers/get_buyers read tools |
| AI-GAP-009 | AI assistant | AI_SYSTEM_PROMPT's PO status vocabulary didn't match the live po-sm dropdown — Fixed v2.9.55 (prompt + get_pos tool description both corrected to Draft/Sent/Deposit Paid/Settled/Cancelled) |
| AI-GAP-006 | AI assistant | All nine creatable entities now supported by handleAIAction() — Fixed v2.9.55 (Invoices/Line Items/Credit Notes shipped, closing out Suppliers/Buyers from v2.9.41) |
| INV-GAP-001 | Invoice rendering | Pro-forma status rendered as plain Invoice document — Fixed v2.9.40 |
| SEC-GAP-020 | Public Pages exposure | Live PII was publicly served — fully resolved 2026-07-05 (purge, history rewrite, GDPR assessment, GitHub PR/cache purge all complete) |
| SEC-GAP-011 | Sync / data integrity | `pullAll()` overwrites local records unconditionally — Sheets wins, no timestamp-based conflict resolution |
| PROC-GAP-001 | Dashboard / accounting | Multi-currency KPI aggregation without FX conversion — Fixed v2.9.15 via `toGBP()` |
| SDLC-GAP-003 | Staging / preview | Fixed — REQ-SDLC-003: a second, dedicated `stkdcfpm/stackd-ops-preview` repo (no custom domain) gives genuine origin isolation from `app.getstackdops.com`; a same-repo preview was verified to be impossible (GitHub Pages redirects a repo's own github.io URL to its configured custom domain) |
| CON-GAP-001 | Contacts / GDPR | No automated purge of stale contacts — manual deletion only; UI flags >700d |
| CLOUD-GAP-001 | Cloud Data / Suppliers | Legacy CSV/Sheets Supplier importers bypass Cloud Data — writes silently discarded on next reload once Cloud Data is configured |
| ORD-GAP-003 | Order Requests / Quotes | RFQ commit ↔ Quote drift, no back-reference or staleness warning — Fixed v2.9.58 (REQ/SPEC-INTEG-001 Phase 1) |
| PO-GAP-003 | Invoices / Purchase Orders | Invoice ↔ auto-generated PO drift, no re-sync or warning after `autoPos()`'s first-save-only guard — Fixed v2.9.58 (REQ/SPEC-INTEG-001 Phase 1) |
| CON-GAP-002 | Contacts / dedup | Email dedup is soft (force-new allowed); no enforcement of true uniqueness; edit-path email changes not deduped |
| CON-GAP-004 | Contacts / data integrity | Deleting a contact leaves dangling sourceContactId on associated quotes; runtime guards no-op safely |
| CON-GAP-005 | Contacts / import | Restoring a v2 backup (no con key) preserves live contacts rather than clearing them; WARNING dialog text is not updated to reflect this |
| MTD-GAP-001 | MTD / input VAT | Boxes 4 and 7 are always £0.00 — no purchase VAT invoices captured; input VAT reclaim not supported in v2.9.32 |
| MTD-GAP-002 | MTD / FX rates | `toGBP()` uses configured QR rates at export time, not the rate on each invoice date — historic rate variance is operator's responsibility |
| BUY-GAP-001 | Buyers / sync | Buyers not synced to Google Sheets — FM-1 freeze; deferred to v3.x |
| BUY-GAP-002 | Buyers / legacy | Legacy invoices without buyerId matched by name on edit; default BUY-ADHOC if no match |
| BUY-GAP-003 | Buyers / credit | Credit limit is display-only; no enforcement on invoice save |
| DATA-GAP-003 | Reference numbers / cross-device | `num` (SUP-/LI-/BUY-/CON-####) can diverge between two devices that haven't synced; same-device `pullAll()` stripping is mitigated (v2.9.43); cross-device divergence remains open, accepted design trade-off |
| DATA-GAP-004 | List-render onclick pattern | `rSup()`/`rLI()`/`rPO()`'s string-concatenation onclick handlers silently no-op delete/edit if a record is missing `id` — same root cause fixed for Contacts via REQ/SPEC-CON-003; backlogged for other entities absent a confirmed report |
| DATA-GAP-005 | Contacts / Sheets sync | Backfilling a Contact's `id` (REQ/SPEC-CON-003) can orphan its Sheets sync row if it was previously pushed with a blank Contact ID column — creates a duplicate row on next sync, no automated reconciliation; accepted, same class as SEC-GAP-011 |
| ORD-GAP-001 | Order Requests | Legacy-backfilled records (from Contact enquiry logs, no linked Quote) are lower-fidelity; abandoned-Quote PO/Invoice not auto-re-attributed on activeQuoteId reassignment — both accepted limitations |
| ORD-GAP-002 | Order Requests / AI assistant | update_order_line AI action has no corresponding get_order_lines read tool — same read/write asymmetry as AI-GAP-008 |
| CUR-GAP-001 | Display currency / Aging Report | Aging Report mixes currencies unconverted — pre-existing, out of scope for v2.9.46's currency toggle |
| CUR-GAP-002 | Display currency / Buyer Statement | Buyer Statement (renderStatement()) mixes currencies unconverted — pre-existing, out of scope for v2.9.46's currency toggle |
| SYNC-GAP-001 | Sync / data integrity | pullAll() merged Sheets rows keyed by display header, never translated back to internal field names — corrupted every pulled record and silently broke delete — Fixed v2.9.47 |
| CON-GAP-006 | Contacts / reference numbers | CSV/webform-created Contacts never get a CON-#### num — inherited from a pre-existing processImportRecords() gap, not fixed in v2.9.48 (out of scope) |
| SYNC-GAP-002 | Sync / performance | Fixed — REQ/SPEC-SYNC-002: `syncAll()`/`pullAll()`/`pushAll()` now send one batched request per direction instead of 8-10 sequential ones. Apps Script redeployed 2026-08-31; whether the live deployment is actually serving the new actions is unconfirmed — see SYNC-GAP-003 |
| SYNC-GAP-003 | Sync / performance | Open, backlogged — post-redeploy Network-tab evidence was inconsistent/inconclusive; may just be the Apps Script deployment needing to be re-pointed at its latest version, not a code defect |

---

## Current sprint

| ID | Item | Status |
|---|---|---|
| 8 | Quote line price versioning | ✓ done (v2.9.4) |
| 9 | Xero export | ✓ done (v2.9.5) |
| 10 | Sync URL guard + status timestamp | ✓ done (v2.9.14) |
| 11 | Security fixes (XSS, pullAll crash, testConn token, PII) | ✓ done (v2.9.14) |
| 12 | Prompt caching (Layer 4) + section index (Layer 3A) + CLAUDE.md restructure (Layer 1) | ✓ done (v2.9.14) |
| 13 | AI Compliance Review mode + AI_COMPLIANCE_PROMPT | ✓ done (v2.9.26) |
| 14 | Phase 1 visual redesign — depth, radius, refined interactions | ✓ done (v2.9.26) |
| 15 | Buyer statement fixes — Total Outstanding, ISO dates, credits negative | ✓ done (v2.9.26) |
| 16 | Contacts/Leads entity — pipeline, GDPR basis, quote integration, dedup | ✓ done (v2.9.27) |
