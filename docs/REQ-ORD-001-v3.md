# REQ-ORD-001 — Order Request Tracking & Action Pipeline (Enquiry → Realised Margin)

**Status:** Draft v3 — requirements-gate FAILED v2 on four findings (FM-1 justification incomplete, `unlockInv()` precedent mischaracterized, SPEC-DATA-001 reuse assumed rather than scoped as a change, `realisedMargin` storage model unspecified); this revision addresses all four (see §9 Changelog)
**Version:** 3
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** Contacts (v2.9.27), Quote Engine (v2.9.4), Buyers (v2.9.37), REQ-DATA-001-v5/SPEC-DATA-001-v6 (`num` reference numbers), Invoice CONFIRM+reason logging procedure (v2.9.12 — procedure only, see §3.2 correction), CON-GAP-004, CON-GAP-005, STACKD_CONTEXT.md FM-1 exception category 3 (`DB.events`/v2.9.28 precedent)
**Supersedes:** REQ-ORD-001-v2 (requirements-gate FAIL — see §9 Changelog)

---

## 1. Business Context

*(Unchanged from v1 — retained for continuity.)*

Order requests currently arrive from disparate sources — email, WeChat, trade show conversations, referrals, the in-app AI chat — and today land in Stackd Ops in one of two disconnected places:

- **Contacts** (`DB.con`): a lead/pipeline entity with `status` (`lead` → `qualified` → `converted` → `closed`), an append-only `enquiries[]` log (free-text summary + timestamp + source), and a one-way "→ Quote" action.
- **Quotes** (`DB.qt`): once a Quote exists, it carries `sourceContactId` back to the originating Contact, and `linkedPOId` forward to a converted Purchase Order.

**The core gap:** none of `enquiries[]`, `status`, or the Quote/PO/Invoice chain constitutes a genuine **order request** as its own trackable unit — a Contact can only hold one `status` at a time, so a company with two simultaneous, independently-progressing enquiries has no way to represent that; there is no structured action/outcome tracking between "a contact enquired" and "a quote exists"; and there is no aggregate view tracing a request through to its realised margin (`iCalc(inv).gp`/`.np`, `index.html:3166`) without manually following `sourceContactId` → Quote → `linkedPOId` → PO → Invoice by hand.

## 2. Stakeholders

*(Unchanged from v1.)*

| Role | Party | Need |
|---|---|---|
| Operator | FPM International (sole trader) | See every live order request, its current stage, what action is next, and who owns it — across all sources, in one place |
| Operator (retrospective) | FPM International | Trace any historical order request through to its realised margin outcome |
| AI Assistant | Built-in Stackd Ops AI | Answer "what order requests are open / stuck / overdue for action" from live data |
| Future migration | v3.0.0 Supabase cutover (FM-1) | A data model additive to the existing Contact/Quote/PO/Invoice chain |

## 3. Design Decisions (resolved — was v1 §3/§6 open questions)

### 3.1 New top-level entity, not a nested array on Contact

**Decision: new top-level entity.** `DB.ord` (localStorage key `st_ord`), each record with its own `id` (`uid()`) and `num` (`ORD-0001`, following the SPEC-DATA-001 convention — see §5). Each record carries a `contactId` FK back to `DB.con`. This allows one Contact to have multiple, independently-stageable, concurrently-open Order Requests — the exact case a nested `con.orders[]` array cannot cleanly represent (per v1 §3 point 1) — and is consistent with how Quotes/POs/Invoices are already modeled as top-level entities linked by ID, rather than introducing a second, differently-shaped pattern.

**FM-1 consequence (see §5):** this is new-entity complexity, not a same-shape field addition like `num` was. This must be justified explicitly to requirements-gate, not assumed.

### 3.2 Stage transitions: enforced, with an admin-only override

**Decision: enforced state machine**, following the same precedent as Invoice locking (v2.9.12) and Quote's "Convert to PO only from Accepted" hard guard (QTE-GAP-001) — both cases where an earlier soft/advisory rule proved insufficient in practice.

Normal stage progression (forward-only, system-enforced):

`New → Qualifying → Quoted → Converting → Processing → Fulfilled`

...with two terminal side-exits reachable only from `Qualifying` (→ `Declined`) or `Quoted` (→ `Lost`), per the v1 §3 workflow diagram.

**Admin override — corrected in v3 (requirements-gate finding):** v2 stated this was "modeled directly on" `unlockInv()` as if the whole mechanism transferred. Verified against `index.html:7946`/`2182`: `unlockInv()` does **not** persist any change to the Invoice record — it sets an in-memory `_unlockedInvIds[inv.id] = true` flag (declared at `index.html:2182` with the comment "in-memory override set — cleared on page reload") that is session-only, matching the already-logged SEC-GAP-004 ("Invoice locking — Client-side UX control only — not tamper-proof"). That session-only, non-persistent behavior is **not** appropriate for an Order Request stage override, which must durably change a stored field (`DB.ord[].stage`) — a session-only override would silently revert on reload, which is wrong for this use case.

**What actually transfers from the Invoice-unlock precedent is the *procedure* only** — the CONFIRM-string input, the mandatory written reason, and permanent logging via `logEv()` — not the persistence model. The Order Request override therefore: (a) requires typing `CONFIRM` and a mandatory reason, exactly as Invoice unlock does; (b) on confirmation, **permanently writes** the new `stage` value directly to the `DB.ord` record and calls `saveAll()`, unlike `unlockInv()`'s in-memory-only flag; (c) logs the override via `logEv()` with the reason text, same as Invoice unlock. This override is therefore **not** subject to a SEC-GAP-004-style "client-side only, not tamper-proof" caveat in the same sense — once written, it's a normal persisted field change like any other save, not a temporary unlock state. There is no other path to a non-sequential transition.

### 3.3 Action tracking: full dated action list

**Decision:** each Order Request carries an `actions[]` array, not a single note field:

```
actions: [
  { id, text, dueDate, done: boolean, createdAt, completedAt: string|null }
]
```

This supports a list view sortable/filterable by due date and open/overdue status (the actual stated need — "monitor and track progress... action tracking to complete and qualify orders"), not just a single evolving free-text field. Completed actions are retained (not deleted) for the historical record, mirroring the append-only pattern already used for `enquiries[]` and `editHistory[]` elsewhere in the codebase.

### 3.4 Margin rollup: latest/final Quote only feeds PO/Invoice

**Decision:** each Order Request has exactly one `activeQuoteId` at any time — the current, latest version of the linked Quote. If a Quote is revised, Quote's own existing price-versioning (`priceHistory[]`, per-line) already captures the supersession; the Order Request simply continues to point at the same Quote record (Quotes are edited in place, not re-created per revision, per the existing Quote engine — confirmed no `supersedes`/`revisionOf` field exists on `DB.qt`). **Only the current Quote's resulting PO and Invoice(s) count toward realised margin.** There is no summing across quote revisions, because earlier revisions are not separate records to sum — this decision mainly rules out double-counting if a *new*, separate Quote were ever created against the same Order Request (e.g. operator abandons one Quote and starts a fresh one for the same request): in that case, the Order Request's `activeQuoteId` is reassigned to the new Quote, and the old Quote is excluded from the margin rollup entirely, even if it happens to still have a linked PO/Invoice of its own (which would then be attributed to the Order Request only if the operator explicitly re-links it — not automatic).

**Aggregation rule:** `realisedMargin` for an Order Request = `iCalc(inv).gp` / `.np` summed across every Invoice reachable via `activeQuoteId → linkedPOId → PO.invId/invNum`, for however many Invoices that chain resolves to (handles the case of a PO fulfilled across multiple invoices/shipments) — but only via the *current* `activeQuoteId`, never a historical one.

**Storage model — added in v3 (requirements-gate finding: not independently testable without this):** `realisedMargin` is a **computed accessor, not a stored field.** There is no `DB.ord[].realisedMargin` value written at any stage transition. Instead, a function (e.g. `ordRealisedMargin(ord)`) walks the `activeQuoteId → linkedPOId → PO.invId/invNum` chain live, every time it's called — on rendering the Order Request detail view, and on any list view that displays it. Rationale: an Invoice's `iCalc()` inputs (status, line items, payments) can change after the Order Request reaches `Fulfilled` (e.g. a credit note applied later, a locked invoice unlocked and corrected per SEC-GAP-004's own caveat) — a stored snapshot would silently go stale with no defined recompute trigger to catch it, which is a worse failure mode than recomputing on every view (cheap: at most a handful of Invoices per Order Request, well within what `iCalc()` already does per-row on every Invoices-tab render today). No caching/memoization is introduced in v1 of this feature.

### 3.5 Backfill strategy: driven by what data actually exists

**Investigated against live data** (not assumed): `DB.con.enquiries[]` holds `{ id, ts, summary, source }` per entry, with no field linking an individual enquiry to a specific Quote. `DB.qt` holds `sourceContactId` per Quote (one Contact reference per Quote, not per enquiry). There is no reliable way to attribute *which* enquiry produced *which* Quote when a Contact has more than one of each.

**Decision — two-tier backfill, accuracy-first:**

1. **Primary (accurate):** for every existing Quote with a non-empty `sourceContactId`, create one backfilled Order Request: `contactId = quote.sourceContactId`, `activeQuoteId = quote.id`, stage derived from the existing Quote/PO/Invoice chain (e.g. `linkedPOId` present + PO has `invId` → `Processing` or `Fulfilled` depending on invoice status; Quote `status: Declined/Expired` → `Lost`; otherwise `Quoted`). This is fully attributable from data that already exists and requires no guessing.
2. **Secondary (marked as legacy/unstructured):** for every Contact that has one or more `enquiries[]` entries but **zero** Quotes referencing it via `sourceContactId`, create **one** backfilled Order Request per Contact (not one per enquiry entry, since individual enquiries can't be reliably separated into distinct requests) — `contactId = contact.id`, `description` compiled by concatenating all `enquiries[].summary` values with their timestamps, stage seeded from the Contact's current `status` (`lead`/`qualified` → `Qualifying`, `converted` → `Quoted` if no quote is found linked despite the status implying one exists — flagged inconsistency, not silently resolved — `closed` → `Declined`), and an explicit `_backfilled: 'legacy-unstructured'` flag so these records are visibly distinguishable from genuinely structured ones in the UI (not presented as if they'd always had proper stage/action tracking).
3. **No backfill** for Contacts with neither `enquiries[]` entries nor a linked Quote — there is nothing to backfill accurately, and inventing a placeholder Order Request would misrepresent history.

This backfill runs once, idempotently (same pattern as `backfillRefNums()` / `seedAdHocBuyer()` — checked via a presence flag before creating records, safe to call on every `initApp()`).

## 4. Scope

### In scope
- New `DB.ord` top-level entity, `K.ord = 'st_ord'`, with `num` (`ORD-0001`) per SPEC-DATA-001's established pattern
- Enforced stage state machine (§3.2) with CONFIRM+reason admin override, logged via `logEv()`
- Full dated `actions[]` list per Order Request (§3.3), with a list/filter view for open and overdue actions across all Order Requests
- `activeQuoteId` linkage and realised-margin rollup (§3.4)
- One-time idempotent backfill per §3.5, with legacy-unstructured records visibly flagged
- List view: all Order Requests, filterable by stage, overdue-action status, and Contact
- Detail view: single Order Request showing stage, action list, linked Quote/PO/Invoice chain, and realised margin once fulfilled

### Out of scope (v1 build — explicitly deferred)
- Automated reminders/notifications (no scheduling mechanism exists in this local-only app)
- AI-driven action suggestions or auto-drafted follow-ups
- Multi-operator ownership/assignment fields (FPM is currently a sole trader — no `owner` field in v1)
- Any Google Sheets sync mapping for the new entity (same fragile-sync caution as `num` — see DATA-GAP-003)
- Re-attributing a Quote's own historical `priceHistory[]` revisions into the Order Request's action/audit trail — Quote versioning remains Quote's own concern

## 5. FM-1 Compliance

**Corrected in v3 (requirements-gate finding: v2 built a from-scratch justification and missed a directly-applicable existing precedent).** STACKD_CONTEXT.md's FM-1 exception (agreed 2026-06-21, product-owner approved) lists three categories, not one. Category 2 ("new fields on existing entities") is the one `num`/SPEC-DATA-001 qualified under, and is correctly *not* what this requirement fits. But **category 3** is directly on point: "A new internal-only `K` key and `DB` entity with no Sheets sync... is permitted where the entity is operationally self-contained and does not create external data transmission obligations" — with `K.ev`/`DB.events` (the global event log, v2.9.28) cited as the existing precedent used under this exact category.

`DB.ord` as scoped in this document (§4 "Out of scope": no `FIELD_MAPS` entry, no `syncEnt` call, no Apps Script tab) satisfies the literal text of category 3 on the sync-isolation criterion. **However**, this document does not claim it therefore qualifies outright, because category 3's other qualifier — "operationally self-contained" — is a materially closer call for `DB.ord` than it was for `DB.events`. `DB.events` is a pure append-only log with no FK relationships that gate anything: nothing in the app *behaves* differently because an event exists or doesn't. `DB.ord` is different in kind: it carries a `contactId` FK, an enforced stage state machine, and (per §3.4) an `activeQuoteId` that determines what counts toward realised margin — it is a workflow entity that reads from and constrains behavior around three other entities (Contact, Quote, the PO/Invoice chain), not an operationally self-contained log sitting beside them.

**This requirement's position:** `DB.ord` satisfies category 3's explicit, literal criterion (no Sheets sync obligation) but stretches its "operationally self-contained" framing beyond the `DB.events` precedent's actual shape. This is presented to requirements-gate as a genuine judgment call, not a foregone conclusion in either direction — supporting factors are: (a) no existing entity's shape or behavior changes — `DB.ord` reads Contact/Quote/PO/Invoice data but writes only to itself; (b) no new sync mapping, Apps Script tab, or external transmission obligation is created, satisfying category 3's explicit text; (c) a v3.0.0 Supabase migration will need an equivalent workflow entity regardless of when it's built, and doing so now, on an already-understood local pattern (and reusing the already-battle-tested `num`/`backfillRefNums()` scaffolding, per AC-009's corrected scope), is lower-risk than designing it for the first time mid-migration. The counterweight — that this is meaningfully more architecturally significant than the log-only precedent category 3 was written for — is stated plainly, not minimized. **requirements-gate should make the actual approval call on this basis, not on the basis of the from-scratch argument v2 offered.**

## 6. Acceptance Criteria (draft)

- AC-001: `DB.ord` exists as a new top-level entity, present in `K`, `saveAll()`, `showV` routing, `expAll()` snapshot, and `doImport()` — per the existing "adding a new top-level entity" checklist in `CLAUDE.md`
- AC-002: Every Order Request has a `contactId` referencing an existing `DB.con` record; deleting a Contact must not silently orphan or crash on its linked Order Requests (matching the existing CON-GAP-004 caution about dangling FKs)
- AC-003: Stage transitions follow the state machine in §3.2; forward-only; the two terminal side-exits (`Declined`, `Lost`) are reachable only from their defined source stages
- AC-004: Any non-sequential stage change requires the CONFIRM+reason override flow and is logged via `logEv()` with the reason text
- AC-005: `actions[]` supports add/complete/list; completed actions are retained, not deleted; a list view surfaces open actions sorted by `dueDate`, with overdue ones visually distinguished
- AC-006: `activeQuoteId` is set when an Order Request reaches `Quoted`; if the operator creates a new Quote against the same Order Request (abandoning the prior one), `activeQuoteId` is reassigned and the prior Quote is excluded from margin rollup
- AC-007: `realisedMargin` (gp/np) is a **computed accessor** (not a stored field — see §3.4 Storage model), returning a non-zero value only once an Order Request reaches `Fulfilled`; recomputed live from every Invoice reachable via the current `activeQuoteId → linkedPOId → PO.invId/invNum` chain on every render, so it always reflects the current state of those Invoices (e.g. a later credit note or unlock-and-correct is reflected without any explicit recompute step)
- AC-008: One-time backfill runs idempotently on load, producing accurate records for Quote-linked history (§3.5.1) and clearly-flagged (`_backfilled: 'legacy-unstructured'`) records for enquiry-only history (§3.5.2), with no record created where no attributable data exists (§3.5.3)
- AC-009 — **corrected in v3 (requirements-gate finding):** `nextRefNum()`/`parseRefNum()` are already generic (take an `entityArray`/`prefix` argument, per SPEC-DATA-001-v6 §3) and can be called for `ORD` with no modification. **`backfillRefNums()` is not generic** — SPEC-DATA-001-v6 §4 hard-codes exactly four `assign(DB.x, 'PREFIX')` calls (`sup`, `li`, `buy`, `con`). Adding `ORD` numbering therefore requires an **explicit, in-scope code change**: a fifth `if (assign(DB.ord, 'ORD')) changed = true;` line inside the existing `backfillRefNums()` function, plus a `num: nextRefNum(DB.ord, 'ORD')` assignment in the new Order Request save function. This is not "follow the existing pattern" as a passive reuse — it is a modification to `backfillRefNums()`, a function that has already been through a schema-migration-reviewer FAIL (SPEC-DATA-001 v5→v6, the duplicate-number collision bug) once. **Any change to `backfillRefNums()` for this feature must be routed back through schema-migration-reviewer at spec stage**, not treated as a routine reuse of an already-approved pattern. `num` (once assigned) is never reassigned, never synced to Sheets, matching the existing four entities' convention.
- AC-010: All existing tests continue to pass; new tests cover the state machine's enforcement + override path, the backfill's two-tier logic against representative fixtures, and margin rollup arithmetic

## 7. GDPR

An Order Request record carries contact identity (via FK), commercial terms (implicitly, via the linked Quote), and free-text action/outcome notes that may reference personal circumstances (e.g. "buyer's contact is on leave until..."). This is not a new class of data — `enquiries[]` already carries equivalent free-text risk today — but as a new top-level entity it needs its own explicit basis statement rather than inheriting Contacts' GDPR card implicitly. Proposed: same basis as the linked Contact (Art. 6(1)(b) pre-contractual while open, Art. 6(1)(f) legitimate interests once closed/fulfilled) — to be confirmed at spec stage.

## 8. New Known Gap (to be logged alongside this feature's build, if it proceeds)

**ORD-GAP-001 (placeholder):** exact wording to be finalized once scope is confirmed — covers the legacy-unstructured backfill records (§3.5.2) being lower-fidelity than genuinely tracked ones, and the "abandoned Quote with its own PO/Invoice not automatically re-attributed" edge case in AC-006.

## 9. Changelog

**v3 (this version):** Resubmitted after requirements-gate FAIL on v2. Four findings addressed:
1. **§5 FM-1 justification rebuilt around the actual pre-approved exception category** (category 3 / `DB.events` precedent, STACKD_CONTEXT.md) instead of a from-scratch argument the gate had to weigh with no anchor — while explicitly stating where `DB.ord` stretches that precedent's "operationally self-contained" framing further than the log-only `DB.events` case did, rather than claiming a clean fit.
2. **§3.2 admin-override corrected** — v2 said the override was "modeled directly on" `unlockInv()`; verified against `index.html:2182`/`7946` that `unlockInv()` is a session-only, in-memory, non-persistent flag (matching SEC-GAP-004's "client-side UX control only" framing), which is the wrong persistence model for a stage override that must durably change a stored field. v3 states only the CONFIRM+reason+`logEv()` *procedure* transfers; the Order Request override itself persists directly via `saveAll()`, unlike Invoice unlock.
3. **AC-009 corrected** — v2 implied `num` for `ORD` was a drop-in reuse of SPEC-DATA-001's shared functions. `nextRefNum()`/`parseRefNum()` are generic and reusable as-is; `backfillRefNums()` is not — it hard-codes exactly four entities (SPEC-DATA-001-v6 §4) and requires an explicit added `assign(DB.ord, 'ORD')` call, which v3 now states as an in-scope code change that must be routed back through schema-migration-reviewer given that function's FAIL history (the v5→v6 collision bug).
4. **§3.4/AC-007 storage model specified** — v2 left `realisedMargin` ambiguous between a stored snapshot and a live computation, which the gate found not independently testable. v3 states it is a pure computed accessor with no stored field, recomputed on every render, with the rationale (a stored snapshot has no defined recompute trigger and would go stale against later Invoice corrections/credit notes).

**v2:** Resolved all five open design questions from v1 §3/§6 with the operator: new top-level entity (not nested on Contact); enforced stage transitions with a CONFIRM+reason admin override modeled on the existing Invoice-unlock precedent; full dated `actions[]` list rather than a single note field; margin rollup restricted to the current `activeQuoteId` only, with an explicit rule for the abandoned-Quote edge case; and a concrete, data-driven two-tier backfill strategy (accurate for Quote-linked history, explicitly flagged as lower-fidelity for enquiry-only history, and skipped entirely where no attributable data exists). Draft Acceptance Criteria and GDPR section added. FAIL — requirements-gate found the FM-1 argument missed an applicable precedent, the `unlockInv()` analogy mischaracterized its actual behavior, AC-009 assumed a drop-in reuse that isn't one, and `realisedMargin`'s storage model was unspecified.

**v1:** Initial draft — business context and candidate workflow only, five open design questions raised, no Acceptance Criteria.
