# SPEC-ORD-001 — Order Request Tracking & Action Pipeline (Enquiry → Realised Margin)

**Derived from:** REQ-ORD-001-v3 (requirements-gate PASS)
**Status:** Draft v4 — build-gate FAILED the v3-based implementation on 2 items requiring a spec reconciliation (§3's `ordRealisedMargin()` algorithm, §4's call-site ordering) plus several code-only fixes tracked in the build, not this doc; this revision reconciles the spec text with the concurrently-shipped SPEC-PO-001 schema change (see §12 Changelog)
**Date:** 2026-07-11
**Author:** FPM International / Claude Code
**Related:** SPEC-DATA-001-v6 (`num` reference numbers — `backfillRefNums()` modification, see §3.4), SPEC-PO-001-v3 (`Quote.linkedPOId`→`linkedPOIds`, shipped concurrently — see §3/§4 reconciliation below), `docs/data-model.md` (ERD — to be updated per §7)
**Supersedes:** SPEC-ORD-001-v3 (build-gate found undocumented deviations from the literal v3 text — see §12 Changelog)

---

## 1. New Entity Definition

A new top-level entity, `ord` (Order Requests), added to the existing state layer alongside `sup`/`li`/`buy`/`con`/etc.

```js
// K (index.html:2156)
const K = { ..., bu: 'st_buy', ord: 'st_ord' };

// DB (index.html:2169)
let DB = { ..., buy: ldArr(K.bu), ord: ldArr(K.ord) };

// saveAll() (index.html:2250)
const saveAll = () => { ...; sv(K.bu, DB.buy); sv(K.ord, DB.ord); };
```

**Record shape:**

```js
{
  id:             uid(),                 // internal PK, consistent with sup/li/con
  num:            'ORD-0001',            // business key, per SPEC-DATA-001 pattern — see §3.4
  contactId:      'con-record-id',       // FK -> DB.con[].id — required, non-null
  stage:          'New',                 // enum — see §2
  description:    'text',                // free-text summary of the request
  actions: [                             // full dated action list — REQ §3.3
    { id: uid(), text: 'string', dueDate: 'YYYY-MM-DD', done: false, createdAt: ISOString, completedAt: null }
  ],
  activeQuoteId:  '' ,                   // FK -> DB.qt[].id, set once stage reaches 'Quoted' — see §2.4
  outcome: {                             // set only when stage reaches Declined or Lost
    result:   'declined' | 'lost' | null,
    reason:   'string',
    closedAt: ISOString | null
  },
  createdAt:      ISOString,             // always set at creation — no legacy-record gap, this is a new entity
  _backfilled:    'legacy-unstructured' | undefined  // present only on backfilled records per §3.5's secondary tier
}
```

No `updatedAt` field — consistent with existing entities (none of `sup`/`li`/`buy`/`con`/`qt`/`po` track a generic last-modified timestamp today; `logEv()` (§4) is the existing mechanism for a change history, and this spec does not introduce a new pattern beyond it).

## 2. Stage State Machine

### 2.1 Stages

`New` → `Qualifying` → `Quoted` → `Converting` → `Processing` → `Fulfilled`, with two terminal side-exits: `Qualifying` → `Declined`, `Quoted` → `Lost`.

### 2.2 Transition table (enforced)

| From | Allowed forward transitions |
|---|---|
| `New` | `Qualifying` |
| `Qualifying` | `Quoted`, `Declined` |
| `Quoted` | `Converting`, `Lost` |
| `Converting` | `Processing` |
| `Processing` | `Fulfilled` |
| `Fulfilled`, `Declined`, `Lost` | *(none — terminal)* |

A new function `ordCanTransition(fromStage, toStage)` returns `true` only for pairs in the table above. `saveOrd()`'s stage-change path calls this and rejects (via `vErr()` on the stage field, no save) any non-listed transition, **except** via the admin override (§2.3).

### 2.3 Admin override

Per REQ-ORD-001-v3 §3.2 (corrected from an earlier, inaccurate analogy to `unlockInv()` — that function is session-only/non-persistent and does not apply here): a new function `ordAdminOverride(ordId, newStage, reason)`:

1. Requires the literal string `CONFIRM` typed into a dedicated confirm input (same UX pattern as `unlockInv()`'s `adv-unlock-confirm` field, `index.html:699` — the input-widget pattern is reused, not the persistence behavior)
2. Requires a non-empty `reason` string
3. On confirmation: sets `ord.stage = newStage` directly on the `DB.ord` record and calls `saveAll()` — a normal, durable, persisted write, unlike `unlockInv()`'s in-memory `_unlockedInvIds` flag
4. Calls `logEv('order', ord.id, 'stage_overridden', 'Stage force-changed to ' + newStage + ' — reason: ' + reason, 'operator')` — permanently logged, same as Invoice unlock's audit trail
5. This is the **only** path to a transition not listed in §2.2's table

### 2.4 `activeQuoteId` and reassignment

**Corrected in v2 (spec-gate finding — the write-back mechanism was named by analogy but never actually specified):** v1 said this "mirrors the existing Contact → Quote flow at `openConvertToQuote()`" as if that function already handled it. Verified: `openConvertToQuote()` (`index.html:8678`) only sets a module-level `cConvertId` variable and pre-fills two Quote-modal fields (`qf-client`, `qf-nt`) from the Contact — it has no return-linkage step, and `saveQte()` never writes anything back onto the originating Contact. There is no existing mechanism this spec can passively reuse; a new one is defined:

- A new function `ordConvertToQuote(ordId)`, analogous to `openConvertToQuote()`: sets a new module-level variable `cConvertOrdId = ordId` (alongside the existing `cConvertId`, not replacing it — an Order Request conversion also sets `cConvertId = ord.contactId` so the existing Contact pre-fill behavior is inherited unchanged), then opens the Quote modal as today.
- `saveQte()` is extended with one block, gated on `cConvertOrdId` being set (mirroring how it already checks `cConvertId` for the Contact-status-flip behavior, `index.html:8481`-adjacent): on save, if `cConvertOrdId` is set, find that `DB.ord` record, set `ord.activeQuoteId = newQ.id`, transition `ord.stage` to `'Quoted'` (via the normal `ordCanTransition()` path — from `'Qualifying'` this is always a valid forward transition per §2.2), call `saveAll()`, then clear `cConvertOrdId` (consumed-once, same pattern as `cConvertId`'s existing consume-on-save behavior).
- If the operator later abandons that Quote and calls `ordConvertToQuote(ordId)` again for the same Order Request, the same block reassigns `ord.activeQuoteId` to the new Quote's `id`; the prior Quote is not deleted and remains independently viewable in the Quotes tab, but is excluded from this Order Request's margin rollup (§3) from that point on, per REQ-ORD-001-v3 §3.4.

## 3. Realised Margin — Computed Accessor

Per REQ-ORD-001-v3 §3.4/AC-007 (corrected from an earlier ambiguous "computed once Fulfilled" wording): **no stored field.** A new function:

```js
function ordRealisedMargin(ord) {
  if (!ord.activeQuoteId) return { gp: 0, np: 0 };
  var q = DB.qt.find(function(x){ return x.id === ord.activeQuoteId; });
  if (!q || !q.linkedPOIds || !q.linkedPOIds.length) return { gp: 0, np: 0 };
  var totals = { gp: 0, np: 0 };
  q.linkedPOIds.forEach(function(poId) {
    var po = DB.po.find(function(x){ return x.id === poId; });
    if (!po) return;
    var inv = DB.inv.find(function(i){ return i.id === po.invId || i.num === po.invNum; });
    if (!inv) return;
    var c = iCalc(inv);
    totals.gp += c.gp;
    totals.np += c.np;
  });
  return totals;
}
```

**Corrected in v2 (spec-gate finding), reconciled again in v4 (build-gate finding — schema now genuinely multi-valued).** v1's aggregation rule, inherited verbatim from REQ-ORD-001-v3 §3.4, assumed a one-PO-to-many-Invoices relationship, which v2 correctly rejected: `po.invId`/`po.invNum` are still singular scalars today — one PO resolves to at most one Invoice, and that part of v2's correction stands unchanged.

**What changed in v4:** SPEC-PO-001-v3 shipped concurrently with this feature and fixed PO-GAP-001 by changing `Quote.linkedPOId` (scalar) to `Quote.linkedPOIds` (**array**) — because a single Quote spanning multiple suppliers (the exact multi-category-basket shape this Order Management feature is built for) now correctly converts to **one PO per distinct supplier**, not one PO total. This means an Order Request's `activeQuoteId` can legitimately resolve to *multiple* POs — not because one PO has multiple Invoices (still impossible, per v2's finding), but because one Quote can now have multiple POs, each independently resolving to at most one Invoice. Summing `iCalc()` across every PO the array resolves to is therefore not a re-introduction of the "multiple invoices per PO" case v2 correctly ruled out — it is the correct margin rollup for exactly the scenario this whole feature exists to serve (a multi-supplier basket's *total* realised margin, across all its supplier-split POs and their invoices). This was an undocumented deviation from the literal v3 text when first built (v3 was written before it was clear SPEC-PO-001 would land in the same delivery) — v4 makes the reconciliation explicit rather than leaving the implementation silently ahead of its own spec.

Called live from the Order Request detail view and the list view (when displaying the `Fulfilled` column) on every render — no caching, no stored snapshot, consistent with how `iCalc()` is already called per-row on every Invoices-tab render. This means a later credit note or an unlocked-and-corrected Invoice is reflected automatically without any explicit recompute step or stale-data risk.

**Note on PO→Invoice matching:** the `i.id === po.invId || i.num === po.invNum` double-check mirrors the existing redundant-but-intentional pattern already in the codebase for PO↔Invoice linkage (`po.invId`/`po.invNum` are both stored, per `docs/data-model.md`'s own documented "known inconsistency" — this spec does not introduce a new redundant-FK pattern, it uses the one that already exists).

## 3.4 `num` — Reference Numbering (extends SPEC-DATA-001)

Per REQ-ORD-001-v3's corrected AC-009: `nextRefNum()`/`parseRefNum()` (SPEC-DATA-001-v6 §3) are generic and require no change. `backfillRefNums()` (SPEC-DATA-001-v6 §4) hard-codes exactly four `assign()` calls and needs one line added:

```js
// backfillRefNums() — index.html, inside the existing function body
var changed = false;
if (assign(DB.sup, 'SUP')) changed = true;
if (assign(DB.li,  'LI'))  changed = true;
if (assign(DB.buy, 'BUY')) changed = true;
if (assign(DB.con, 'CON')) changed = true;
if (assign(DB.ord, 'ORD')) changed = true;   // NEW — added by this spec
if (changed) saveAll();
```

`num` is assigned in the new Order Request save function (`saveOrd()`, §5) only on creation, following the exact pattern of `saveSup()`/`saveLI()`/`saveCon()`: `num: existing ? existing.num : nextRefNum(DB.ord, 'ORD')`. **`saveOrd()` must never reassign `ord.num` on an edit** — assigned once, permanently, identical to the property SPEC-DATA-001 §2 states as a first-class guarantee for the other four entities, not merely an inherited implication.

**Per REQ-ORD-001-v3's AC-009 finding, this change to `backfillRefNums()` — even though it is one added line — must be independently reviewed by schema-migration-reviewer at build time**, given that function's FAIL history (SPEC-DATA-001 v5→v6 collision bug). This spec does not consider the `backfillRefNums()` change pre-cleared by SPEC-DATA-001's own prior passage — it is new surface area on an already-fragile function and gets its own review pass.

**schema-migration-reviewer PASS (with conditions), confirmed in v3:** the real, currently-shipped `backfillRefNums()` (`index.html:2209-2238`) structures each `assign()` call as a self-contained closure with its own local `max` variable and no shared state across calls — the four existing calls (`SUP`/`LI`/`BUY`/`CON`) are already mutually independent, so a fifth `assign(DB.ord, 'ORD')` call cannot interact with or corrupt the other four's numbering. This is calling an already-per-entity-scoped pure function one additional time, not "generalizing a four-entity design to five." The existing `!rec.num` check (line 2216) was also confirmed to treat `''`, `null`, and `undefined` identically as falsy, so Tier-1/Tier-2 backfilled records deliberately created with `num: ''` (§4) are picked up correctly with no special-casing required.

`num` is never synced to Sheets (no `FIELD_MAPS.ord` entry — this entity has no Sheets sync at all, per §6).

## 4. Backfill (one-time, idempotent)

Per REQ-ORD-001-v3 §3.5, a new function `backfillOrderRequests()`, called once from `initApp()` (guarded by a presence check, e.g. skip if `DB.ord.length > 0` — actual guard mechanism to be finalized at build time against the exact idempotency pattern `seedAdHocBuyer()` already uses, since this is a many-record backfill, not a single-sentinel-record seed like `seedAdHocBuyer()`; a per-source-record processed-flag is more appropriate here, e.g. checking whether an `ord` record already references a given `quote.id`/`contact.id` before creating another).

**Call-site position — pinned in v3 (schema-migration-reviewer finding), corrected in v4 (build-gate finding — an interposed call was needed but not reflected in the pinned position).** `backfillOrderRequests()` must be called in `initApp()` **immediately after** `migrateLinkedPOIds()` (SPEC-PO-001-v3 §3.2), which itself runs immediately after `backfillRefNums()` — i.e., the actual required order is `repairCalcFields() → seedAdHocBuyer() → backfillRefNums() → migrateLinkedPOIds() → backfillOrderRequests()`. **Why `migrateLinkedPOIds()` must run first:** Tier 1's stage-inference logic (below) reads `q.linkedPOIds` to determine whether a Quote's stage should be inferred as `Processing` or `Fulfilled`; if `backfillOrderRequests()` ran before the legacy `linkedPOId` scalar had been migrated to the array, Tier 1 would silently treat every not-yet-migrated Quote as if it had no linked PO at all, understating its stage. v3's text ("immediately after `backfillRefNums()`") did not anticipate this interaction because SPEC-PO-001's `linkedPOIds` migration was still in spec-gate review at the time v3 was written, not yet a build-time dependency. Since §4's own logic also calls `backfillRefNums()` a second time internally after both tiers finish (to assign `num` to newly-created `DB.ord` records), this internal second call remains harmless and expected — `backfillRefNums()` is already idempotent. The identical corrected ordering (`seedAdHocBuyer()` → `backfillRefNums()` → `migrateLinkedPOIds()` → `backfillOrderRequests()`) applies in `doImport()` per §6.

**Tier 1 — accurate, from Quotes:**
```js
DB.qt.forEach(function(q) {
  if (!q.sourceContactId) return;
  if (DB.ord.some(function(o){ return o.activeQuoteId === q.id; })) return; // already backfilled
  var stage = 'Quoted';
  if (q.status === 'Declined' || q.status === 'Expired') stage = 'Lost';
  else if (q.linkedPOId) {
    var po = DB.po.find(function(p){ return p.id === q.linkedPOId; });
    if (po) {
      var inv = DB.inv.find(function(i){ return i.id === po.invId || i.num === po.invNum; });
      stage = inv ? 'Fulfilled' : 'Processing';
    }
  }
  DB.ord.push({
    id: uid(), num: '', contactId: q.sourceContactId, stage: stage,
    description: 'Backfilled from Quote ' + q.num, actions: [],
    activeQuoteId: q.id,
    outcome: stage === 'Lost' ? { result: 'lost', reason: 'Backfilled — original reason not captured', closedAt: q.dt || null } : { result: null, reason: '', closedAt: null },
    createdAt: q.dt ? new Date(q.dt).toISOString() : new Date().toISOString()
  });
});
```

**Tier 2 — legacy/unstructured, from Contacts with enquiries but no linked Quote:**
```js
DB.con.forEach(function(c) {
  if (!c.enquiries || !c.enquiries.length) return;
  var hasQuote = DB.qt.some(function(q){ return q.sourceContactId === c.id; });
  if (hasQuote) return; // covered by Tier 1
  if (DB.ord.some(function(o){ return o.contactId === c.id && o._backfilled === 'legacy-unstructured'; })) return;
  var stage = c.status === 'closed' ? 'Declined' : (c.status === 'converted' ? 'Quoted' : 'Qualifying');
  DB.ord.push({
    id: uid(), num: '', contactId: c.id, stage: stage,
    description: c.enquiries.map(function(e){ return (e.ts||'').slice(0,10) + ': ' + e.summary; }).join(' | '),
    actions: [], activeQuoteId: '',
    outcome: stage === 'Declined' ? { result: 'declined', reason: 'Backfilled — original reason not captured', closedAt: null } : { result: null, reason: '', closedAt: null },
    createdAt: c.createdAt || new Date().toISOString(),
    _backfilled: 'legacy-unstructured'
  });
});
```

**Tier 2's `converted` → `Quoted`-with-no-quote-found case** (REQ-ORD-001-v3 §3.5.2's "flagged inconsistency, not silently resolved"): this is a genuine data-quality signal (a Contact marked `converted` implies a Quote exists, but Tier 1 found none referencing it) and must surface a `console.warn()` at backfill time so it's visible during QA, not just silently accepted.

**No backfill** for Contacts with neither `enquiries[]` nor a linked Quote — no record created, per REQ-ORD-001-v3 §3.5.3.

After both tiers run, call `backfillRefNums()` (§3.4) to assign `num` to every newly-created record (all created with `num: ''` above, deliberately — numbering is a separate concern handled by the existing shared function, not duplicated here).

## 5. New Functions & UI Surface

| Function | Purpose |
|---|---|
| `saveOrd()` | Create/update an Order Request; assigns `num` on create (§3.4); validates `contactId` references an existing Contact; enforces stage transitions via `ordCanTransition()` (§2.2) unless called from the override path |
| `delOrd(id)` | Delete an Order Request; per REQ-ORD-001-v3 AC-002, does **not** cascade-delete or block on a linked Quote/PO/Invoice — those remain independently valid; only the Order Request record itself is removed |
| `ordCanTransition(from, to)` | Pure function, the transition table (§2.2) |
| `ordAdminOverride(ordId, newStage, reason)` | The CONFIRM+reason override (§2.3) |
| `ordRealisedMargin(ord)` | Computed accessor (§3) |
| `backfillOrderRequests()` | One-time idempotent backfill (§4) |
| `rOrd()` | List view render — filterable by `stage`, by Contact, and by "has an overdue action" (any `actions[]` entry with `dueDate < today()` and `done: false`) |
| `openOrd(id)` | Detail/edit modal — shows stage, action list (add/complete), linked Quote status, and a **"Create Quote" button** (visible on existing records, `onclick="ordConvertToQuote(EI.ord)"`) that is the operator-reachable entry point for §2.4's write-back mechanism. **Added in v4 (build-gate finding — CRITICAL):** v3's function table specified the write-back mechanism (`ordConvertToQuote()`) but never specified a UI control to trigger it, so the shipped feature initially had no way for an operator to actually invoke it. A contact deleted out from under an Order Request renders as a disabled placeholder option in the contact dropdown, not a crash. |

**Added in v2 (spec-gate finding — AC-002's "must not silently orphan or crash" had no defined behavior for the dangling-`contactId` direction):** §5's `delOrd()` row above already covers one direction (deleting an Order Request doesn't cascade to its Quote/PO/Invoice). The *reverse* direction — a Contact being deleted while an Order Request still references it via `contactId` — needs its own guard, since `delSup()`'s existing FK-null pattern (nulling `supplierId` on linked Contacts before delete, per CON-GAP-004's precedent) has no equivalent today for Contact deletion cascading to Order Requests. This spec adds:

- `delCon(id)` (existing function) is extended with one line: before removing the Contact, null out `contactId` on every `DB.ord` record referencing it (`DB.ord.forEach(function(o){ if (o.contactId === id) o.contactId = null; })`), mirroring the exact pattern `delSup()` already uses for `DB.con.supplierId`.
- Every render path that dereferences `ord.contactId` (`rOrd()`'s list view, `openOrd()`'s detail view) uses a null-safe lookup: `var c = ord.contactId ? DB.con.find(function(x){return x.id===ord.contactId;}) : null;` followed by `c ? san(c.name) : '— contact deleted —'` wherever the contact name/email would otherwise render — never a direct `.name`/`.email` dereference that would throw on a null contact.

This is now testable: an Order Request whose Contact has been deleted must still render in `rOrd()`/`openOrd()` without throwing, showing a "contact deleted" placeholder rather than crashing or silently disappearing from the list.

**New tab:** "Orders" (or similar), added to the nav alongside Contacts/Buyers, following the exact wiring pattern documented in `CLAUDE.md`'s "View routing" note — entries required in `K`, `DB`, `EI` (new `EI.ord` for currently-editing ID), `saveAll`, `showV fns` map, `renderAll`, `expAll snap`, `doImport entities` handling (§6).

## 6. FM-1 / Sync / Backup Integration

- **No `FIELD_MAPS.ord` entry, no `syncEnt` call, no Apps Script sheet tab** — per REQ-ORD-001-v3 §5's FM-1 category-3 argument, this entity is Sheets-sync-isolated by design, permanently (not "for v1").
- **`expAll()` snapshot:** add `ord: DB.ord` to the snapshot object (`index.html:7560`).
- **`doImport()`:** add `ord` handling. Per REQ-ORD-001-v3's own AC-002/AC-008 reasoning and consistent with the existing Buyers/Contacts conditional-preserve pattern (not the Suppliers/Line-Items unconditional-wholesale-replace pattern) — `DB.ord` should use the **conditional preserve-if-key-absent** pattern: `if (data.ord && Array.isArray(data.ord)) { DB.ord = data.ord; sv(K.ord, DB.ord); }`. Rationale: an older backup (pre-this-feature) restored onto a device that already has live Order Request data should not silently wipe it, exactly as Buyers/Contacts already behave (CON-GAP-005's documented precedent) — Order Requests are workflow/tracking data, not primary master data like Suppliers/Line Items, so the wholesale-replace behavior is the wrong fit here.
- **Restore confirm dialog — corrected in v2 (spec-gate finding):** v1 claimed adding an Order Request count was "consistent with how every other entity is already surfaced there." Verified against the actual dialog (`doImport()`, `index.html:7608-7616`): the counts message covers `sup/li/inv/po/payments/sh/qt` plus `con` (handled one line separately) — **`buy` (Buyers) is absent from this dialog entirely**, despite being a live top-level entity since v2.9.37. "Every other entity" was false. This spec adds an Order Request count using the same one-line-separate pattern already used for `con` (`'Contacts: ' + (Array.isArray(data.con) ? data.con.length : 0)`), i.e. `'Order Requests: ' + (Array.isArray(data.ord) ? data.ord.length : 0)`. It does **not** also fix the pre-existing Buyers omission — that is a separate, already-existing gap, not introduced or worsened by this spec, and is out of scope here. It should be logged as its own gap (proposed: **IMP-GAP-001** — "Restore confirm dialog omits Buyers count," not currently in `docs/known-gaps.md`) rather than silently left unlogged.
- Call `backfillOrderRequests()` at the end of `doImport()`, after the existing `seedAdHocBuyer()`/`backfillRefNums()` calls (SPEC-DATA-001-v6's established call-site pattern), so a restored backup that predates this feature is backfilled from its own restored Contacts/Quotes.

## 7. `docs/data-model.md` Update

Add `ORDER_REQUEST` to the Mermaid ERD (§5 of `docs/data-model.md`) with:
- `string id PK`, `string num UK "ORD-0001"`, `string contactId FK`, `string stage`, `string activeQuoteId FK "optional"`
- Relationship lines: `CONTACT ||--o{ ORDER_REQUEST : "contactId"`, `ORDER_REQUEST |o--o| QUOTE : "activeQuoteId (optional)"`

## 8. GDPR

Per REQ-ORD-001-v3 §7: same legal basis as the linked Contact — Art. 6(1)(b) (pre-contractual necessity) while the Order Request is open (`New` through `Processing`), Art. 6(1)(f) (legitimate interests) once `Fulfilled`/`Declined`/`Lost`. No new lawful-basis analysis is required beyond what Contacts' existing GDPR card already covers, since Order Requests carry no PII category Contacts don't already carry (name/email via FK, free-text notes). A new GDPR disclosure card entry should be added in Settings noting the new entity exists, consistent with how Contacts (v2.9.28) and Buyers (v2.9.37) each got their own card on introduction.

## 9. New Known Gap

**ORD-GAP-001:** Legacy-backfilled Order Requests (Tier 2, §4) are lower-fidelity than genuinely tracked ones — one record represents potentially multiple historical enquiries collapsed together, with no original per-enquiry outcome/reason captured (backfilled with a placeholder reason string). Additionally, if an operator abandons a Quote and starts a new one for the same Order Request (§2.4), the abandoned Quote's own PO/Invoice (if it has one) is not automatically re-attributed or excluded from *its own* independent visibility in the Quotes/POs/Invoices tabs — it simply stops counting toward this Order Request's margin rollup. Both are accepted, documented limitations, not defects to fix in v1.

## 10. Test Plan

**Prerequisite — pinned in v3 (schema-migration-reviewer finding, TEST HARNESS: FAIL on v2):** `tests/run.js`'s `resetDB()` (`tests/run.js:117`) does not include `ord: []`. This must be added in the same commit that introduces `DB.ord` — every test below will fail or silently operate on `undefined` otherwise. Not optional, not a follow-up.

- `ordCanTransition()`: every listed pair in §2.2 returns `true`; every unlisted pair (including backward transitions and skips) returns `false`
- `ordAdminOverride()`: rejects without exact `CONFIRM` string; rejects without a reason; on success, persists the stage change via `saveAll()` (verify via `DB.ord` state, not just a return value) and emits a `logEv()` entry with the reason text
- `ordRealisedMargin()`: returns `{gp:0,np:0}` when `activeQuoteId` is empty, when the linked Quote has no `linkedPOId`, and when the PO has no matching Invoice; returns the correct `iCalc()` values for the single matched Invoice (not "invoices" plural — corrected in v2, see §3); **regression test — reassignment:** an Order Request whose `activeQuoteId` is reassigned to a new Quote must not include the old Quote's PO/Invoice in the result, even though the old PO/Invoice still exist independently
- `ordConvertToQuote()` (new in v2): saving a Quote with `cConvertOrdId` set writes `activeQuoteId`/`stage` back onto the correct `DB.ord` record and clears `cConvertOrdId`; saving a Quote with `cConvertOrdId` unset (normal Quote creation, or the existing Contact-only `cConvertId` flow) does not touch any `DB.ord` record; calling `ordConvertToQuote()` twice for the same Order Request correctly reassigns `activeQuoteId` to the second Quote
- **Dangling `contactId` (new in v2):** deleting a Contact that has a linked Order Request nulls `ord.contactId` (extended `delCon()`); `rOrd()` and `openOrd()` render without throwing for an Order Request with a null `contactId`, showing the "contact deleted" placeholder
- `backfillOrderRequests()` Tier 1: creates one Order Request per Quote with `sourceContactId`, correct stage inference for each of Quoted/Lost/Processing/Fulfilled cases; idempotent on second call (no duplicates, checked via `activeQuoteId` presence)
- `backfillOrderRequests()` Tier 2: creates one Order Request per Contact with enquiries and no linked Quote; correctly skips Contacts already covered by Tier 1; `converted`-status-but-no-Quote-found case emits a `console.warn()`; idempotent on second call
- `backfillOrderRequests()`: Contacts with neither enquiries nor a Quote produce no record
- `saveOrd()`: new record gets `num` via `nextRefNum(DB.ord, 'ORD')`; edit does not change `num`; rejects a `contactId` that doesn't resolve to an existing Contact; rejects a non-adjacent stage change via the normal (non-override) path
- `delOrd()`: does not cascade-delete or corrupt a linked Quote/PO/Invoice
- `doImport()`: an old backup without an `ord` key preserves existing local `DB.ord` (conditional-preserve pattern, matching Buyers/Contacts); a backup that does include `ord` replaces it; `backfillOrderRequests()` runs after restore
- `expAll()`: snapshot includes `ord: DB.ord`
- Regression: all existing tests continue to pass; the SPEC-DATA-001 `backfillRefNums()` tests are re-run against the five-entity version (§3.4) to confirm the added `ORD` line doesn't disturb the existing four entities' behavior

## 11. Rollout

1. Build per §1–§8 above
2. Run `node tests/run.js` — all existing + new tests pass
3. **Route the `backfillRefNums()` change (§3.4) through schema-migration-reviewer specifically**, per REQ-ORD-001-v3's AC-009 finding — do not treat it as pre-cleared by SPEC-DATA-001's own prior passage
4. `build-gate` review of the resulting diff against this spec
5. Version bump, changelog, `docs/known-gaps.md` (ORD-GAP-001), `docs/data-model.md` ERD update, `AI_SYSTEM_PROMPT` update, PR

## 12. Changelog

**v4 (this version):** build-gate ran against the first implementation attempt and found 1 CRITICAL, 4 MAJOR, and 2 MINOR issues. All addressed:
1. **CRITICAL — `ordConvertToQuote()` was never wired to a UI control**, making §2.4's entire write-back mechanism unreachable by an operator. Fixed: `openOrd()`'s modal now has a "Create Quote" button calling `ordConvertToQuote(EI.ord)`.
2. **MAJOR — `saveOrd()` didn't validate `contactId` against `DB.con`.** Fixed: validation moved into `saveOrd()` itself (using `vErr()`/`vOk()`, not raw `toast()`, per project convention), so every caller gets the guarantee, not just the UI wrapper.
3. **MAJOR — `saveOrd()` didn't call `ordCanTransition()`; the guard only existed in the UI wrapper `saveOrdFromForm()`.** Fixed: moved into `saveOrd()`, same reasoning as above.
4. **MAJOR — validation used raw `toast()` instead of `vErr()`/`vOk()`,** inconsistent with `saveBuy()`/`saveCon()`'s existing precedent. Fixed.
5. **MAJOR — `ordRealisedMargin()`'s shipped algorithm (array-based, summing across `Quote.linkedPOIds`) diverged from v3's literal scalar-based spec text**, because SPEC-PO-001's concurrent `linkedPOId`→`linkedPOIds` schema change wasn't yet reflected here. §3 reconciled: this is not a re-introduction of the "multiple invoices per PO" case v2 correctly ruled out — it's the correct rollup for one Quote resolving to multiple supplier-split POs, which is exactly this feature's target scenario.
6. **MINOR — the `cConvertOrdId` block in `saveQte()` called `sv(K.ord, DB.ord)` instead of `saveAll()`** as the spec's own text specified. Code fixed to match the spec.
7. **MINOR — call-site ordering:** `migrateLinkedPOIds()` must run between `backfillRefNums()` and `backfillOrderRequests()` (Tier 1's stage inference depends on the migrated array), which v3's pinned position didn't anticipate. §4 corrected.

Two new required tests added (§10): `saveOrd()` rejecting an unresolvable `contactId`, and rejecting a non-adjacent stage transition via the normal path.

**v3:** schema-migration-reviewer ran on the `backfillRefNums()` extension (§3.4) per REQ-ORD-001-v3's AC-009 requirement. **Result: PASS with conditions** — the core change (a fifth `assign(DB.ord, 'ORD')` call) is safe, because each `assign()` call is already a self-contained, entity-isolated closure with no shared state; it cannot reintroduce the v5→v6 collision class of bug. Three build-time items were pinned down explicitly rather than left inferable:
1. §4: `backfillOrderRequests()`'s call-site position in `initApp()` is now explicitly pinned (immediately after `backfillRefNums()`), matching the discipline SPEC-DATA-001-v6 already applied to its own call sites.
2. §3.4: `saveOrd()` never reassigning `ord.num` on edit is now a stated first-class guarantee, not an inherited implication.
3. §10: `tests/run.js`'s `resetDB()` missing `ord: []` is now called out as a required prerequisite, not an assumed harness detail.

**v2:** Resubmitted after spec-gate FAIL on v1. Four findings addressed:
1. **§3 `ordRealisedMargin()` corrected** — v1 inherited REQ-ORD-001-v3 §3.4's "multiple invoices per PO" clause verbatim and implemented a `.filter()`/reduce that could never actually return more than one record, since `po.invId`/`po.invNum` (verified at `savePO()`, `index.html:5042`) are singular scalars, not arrays. v2's function returns a single matched Invoice's `iCalc()` values (or zero); the multi-invoice clause is flagged as an unimplementable premise inherited from the requirement, which should itself be corrected at its next revision.
2. **§6 restore-dialog claim corrected** — v1 said the new Order Request count was "consistent with how every other entity is already surfaced there." Verified the actual dialog (`index.html:7608-7616`) already omits Buyers entirely. v2 states this plainly, adds the Order Request count using the same pattern already used for Contacts, and explicitly declines to also fix the pre-existing Buyers gap (proposing it be logged separately as IMP-GAP-001, not silently left unlogged).
3. **§5 dangling-`contactId` guard added** — AC-002 required "must not silently orphan or crash" but v1 never specified the reverse-FK direction (Contact deleted while an Order Request still references it). v2 adds a one-line extension to `delCon()` (null the FK, mirroring `delSup()`'s existing pattern for `DB.con.supplierId`) and specifies null-safe rendering in `rOrd()`/`openOrd()`.
4. **§2.4 `activeQuoteId` write-back mechanism specified** — v1 described this as "mirroring" `openConvertToQuote()`, but that function has no write-back step at all; nothing in v1 actually implemented AC-006's core mechanic. v2 defines a new `ordConvertToQuote()` function and a `saveQte()` extension (gated on a new `cConvertOrdId` variable, consumed-once like the existing `cConvertId`) that actually performs the linkage.

Test plan (§10) extended to cover the corrected `ordRealisedMargin()` cardinality, the new `ordConvertToQuote()` write-back, and the new dangling-`contactId` guard.

**v1:** Initial spec derived from REQ-ORD-001-v3 (requirements-gate PASS). FAIL — spec-gate found an unimplementable multi-invoice-per-PO aggregation claim, an inaccurate restore-dialog claim, a missing dangling-`contactId` render guard, and a missing `activeQuoteId` write-back mechanism.
