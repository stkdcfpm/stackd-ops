# REQ-ORD-001 — Order Request Tracking & Action Pipeline (Enquiry → Realised Margin)

**Status:** Draft v2 — five open design questions from v1 §3/§6 resolved with the operator; not yet submitted to requirements-gate
**Version:** 2
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** Contacts (v2.9.27), Quote Engine (v2.9.4), Buyers (v2.9.37), REQ-DATA-001-v5/SPEC-DATA-001-v6 (`num` reference numbers), Invoice locking precedent (v2.9.12, CONFIRM+reason override), CON-GAP-004, CON-GAP-005
**Supersedes:** REQ-ORD-001-v1 (initial draft — workflow and open questions only, no Acceptance Criteria yet)

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

**Admin override:** modeled directly on the existing Unlock Invoice pattern (`index.html:7946`, `unlockInv()`) — an operator can force an out-of-sequence stage change (e.g. correct a mis-set stage, or reopen a `Lost`/`Declined` record) only via a Settings → Advanced-style override requiring the literal string `CONFIRM` and a mandatory written reason, permanently logged to the event log (`logEv()`), exactly as invoice unlocking already is. There is no other path to a non-sequential transition.

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

This is a **new top-level entity** — not a same-shape field addition. Per STACKD_CONTEXT.md's FM-1 statement ("No new features on localStorage stack after v2.9.x... The following are explicitly approved for v2.9.x: new fields on existing entities...") this does not fit the pre-approved exception that `num` (SPEC-DATA-001) qualified under. **This requirement does not assume FM-1 approval — it must be argued for explicitly at requirements-gate**, on the basis that: (a) it is additive to, not a replacement or parallel duplicate of, the existing Contact/Quote/PO/Invoice chain — no existing entity's shape changes; (b) it stores no new class of data beyond what already exists in less-structured form (`enquiries[]`, Contact `status`); (c) a v3.0.0 Supabase migration would need this same entity regardless of when it's built, and building the shape now on the already-understood localStorage pattern is lower-risk than designing it for the first time mid-migration. requirements-gate should independently weigh whether this justification is sufficient or whether this should instead be deferred to v3.0.0.

## 6. Acceptance Criteria (draft)

- AC-001: `DB.ord` exists as a new top-level entity, present in `K`, `saveAll()`, `showV` routing, `expAll()` snapshot, and `doImport()` — per the existing "adding a new top-level entity" checklist in `CLAUDE.md`
- AC-002: Every Order Request has a `contactId` referencing an existing `DB.con` record; deleting a Contact must not silently orphan or crash on its linked Order Requests (matching the existing CON-GAP-004 caution about dangling FKs)
- AC-003: Stage transitions follow the state machine in §3.2; forward-only; the two terminal side-exits (`Declined`, `Lost`) are reachable only from their defined source stages
- AC-004: Any non-sequential stage change requires the CONFIRM+reason override flow and is logged via `logEv()` with the reason text
- AC-005: `actions[]` supports add/complete/list; completed actions are retained, not deleted; a list view surfaces open actions sorted by `dueDate`, with overdue ones visually distinguished
- AC-006: `activeQuoteId` is set when an Order Request reaches `Quoted`; if the operator creates a new Quote against the same Order Request (abandoning the prior one), `activeQuoteId` is reassigned and the prior Quote is excluded from margin rollup
- AC-007: `realisedMargin` (gp/np) is computed only once an Order Request reaches `Fulfilled`, summed across every Invoice reachable via the current `activeQuoteId → linkedPOId → PO.invId/invNum` chain
- AC-008: One-time backfill runs idempotently on load, producing accurate records for Quote-linked history (§3.5.1) and clearly-flagged (`_backfilled: 'legacy-unstructured'`) records for enquiry-only history (§3.5.2), with no record created where no attributable data exists (§3.5.3)
- AC-009: `num` assigned per SPEC-DATA-001's `nextRefNum()`/`backfillRefNums()` pattern, `ORD` prefix, never reassigned, never synced to Sheets
- AC-010: All existing tests continue to pass; new tests cover the state machine's enforcement + override path, the backfill's two-tier logic against representative fixtures, and margin rollup arithmetic

## 7. GDPR

An Order Request record carries contact identity (via FK), commercial terms (implicitly, via the linked Quote), and free-text action/outcome notes that may reference personal circumstances (e.g. "buyer's contact is on leave until..."). This is not a new class of data — `enquiries[]` already carries equivalent free-text risk today — but as a new top-level entity it needs its own explicit basis statement rather than inheriting Contacts' GDPR card implicitly. Proposed: same basis as the linked Contact (Art. 6(1)(b) pre-contractual while open, Art. 6(1)(f) legitimate interests once closed/fulfilled) — to be confirmed at spec stage.

## 8. New Known Gap (to be logged alongside this feature's build, if it proceeds)

**ORD-GAP-001 (placeholder):** exact wording to be finalized once scope is confirmed — covers the legacy-unstructured backfill records (§3.5.2) being lower-fidelity than genuinely tracked ones, and the "abandoned Quote with its own PO/Invoice not automatically re-attributed" edge case in AC-006.

## 9. Changelog

**v2 (this version):** Resolved all five open design questions from v1 §3/§6 with the operator: new top-level entity (not nested on Contact); enforced stage transitions with a CONFIRM+reason admin override modeled on the existing Invoice-unlock precedent; full dated `actions[]` list rather than a single note field; margin rollup restricted to the current `activeQuoteId` only, with an explicit rule for the abandoned-Quote edge case; and a concrete, data-driven two-tier backfill strategy (accurate for Quote-linked history, explicitly flagged as lower-fidelity for enquiry-only history, and skipped entirely where no attributable data exists). Draft Acceptance Criteria and GDPR section added. FM-1 justification stated explicitly rather than assumed, per the distinction between this (new entity) and SPEC-DATA-001 (same-shape field addition).

**v1:** Initial draft — business context and candidate workflow only, five open design questions raised, no Acceptance Criteria.
