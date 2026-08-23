# REQ-DATA-002-v2: Data Integrity Cleanup — Phantom Record Removal & Safe Renumbering

**Supersedes:** REQ-DATA-002-v1 (independent requirements-gate review — CONDITIONAL PASS. Two blocking findings, both resolved below: (1) `backfillConIds()` (`index.html:2576-2582`) runs on every app load, after every `pullAll()`, and after every data restore, and assigns a fresh, real `uid()` to any Contact missing an `id` with no check of whether the record has any other real data — meaning any Contact actually corrupted by the historical SYNC-GAP-001 bug has almost certainly already been silently "healed" into a zombie record (truthy `id`, still blank name/email) by ordinary app usage since v2.9.47 shipped, defeating v1's `!id`-only detection criterion for Contacts specifically. Resolved via REQ-DATA-002a's new compound Contact criterion below. (2) REQ-DATA-002g's illustrative FK-field list cited `buyId`, which is not a real persisted field anywhere in the app (only a transient AI-chat-action parameter name) — the real field is `buyerId` — and omitted two real, in-scope FK fields, `lid` (Line Item FK embedded in Invoice/PO/Quote line arrays) and `sourceContactId` (Quote → Contact FK). Both fixed below. Several advisory corrections also folded in: the claim "one `uid()` implementation" is corrected to note Cloud-Data-configured Suppliers/Buyers take their id from Supabase's own generated key, and one local Buyer-creation path uses `'BUY' + Date.now()` — both still always-truthy, so the safety conclusion is unchanged, but the mechanism description is now accurate. The known-gaps.md-inherited claim about the delete-button's exact broken comparison (`undefined !== ''`) is corrected — the real code has no `san()` wrapper on that particular `onclick`, so string concatenation actually produces `undefined !== "undefined"`, same practical symptom (delete silently fails), different literal mechanism.**

## Business Context

Reported live by the operator: several tabs (confirmed: Suppliers; suspected: most entities that ever synced through Google Sheets) contain completely blank records — no name, no identifying data — that consume a reference number and cannot be removed via the existing Delete button.

Root-caused against the live code and this project's own gap register: this matches **SYNC-GAP-001** exactly. Before v2.9.47, `pullAll()`'s two-way Sheets sync merged pulled rows keyed by the literal spreadsheet column header instead of the internal field name, so every pulled record's real fields (including its own `id`) read as `undefined`. `backfillRefNums()` still assigned these blank records a real reference number (it only checks whether `num` is set, not whether the record has a name), and the existing Delete button silently fails on them — its `onclick` handler concatenates the record's `id` directly into the string (e.g. `onclick="delSup('" + s.id + "')"`, no `san()` wrapper on this particular call), so a corrupted record's `undefined` id becomes the literal text `"undefined"` at render time; the delete function's `filter(function(s){ return s.id!==id; })` then compares the record's real `id` (`undefined`) against the string `"undefined"` — never equal, so the record is never removed. SYNC-GAP-001's fix (`unmapRec()`, v2.9.47) stops this from happening to **new** pulls, but nothing ever went back and removed records that were already corrupted before that fix shipped. That residue is what the operator is looking at now — confirmed to predate the recent Cloud Data/Supabase work, which is unrelated.

This affects every entity that has ever gone through the two-way Sheets pull: `sup`, `li`, `inv`, `po`, `cn` (a special-case `inv` record), `qt`, `payments`, `co`. `buy` (Buyers) and `ord` (Order Requests) never sync to Sheets (FM-1 category-3 exceptions) and should not have this specific defect, though the cleanup tool should still defensively scan them in case a different, unrelated cause produced the same symptom.

**New in v2 — a second, independently-confirmed live defect feeding the same symptom for Contacts specifically:** `pullAll()`'s merge logic (`idKeyedEnts = ['sup','payments','co']`) explicitly skips its fresh-`uid()`-assignment fallback for exactly these three entities — meaning a pulled Contact/Supplier/Payment row whose `id` resolves falsy after `unmapRec()` translation (e.g. a blank "Contact ID" column in the sheet) and finds no local match still enters `DB` with a falsy `id` today, on the current, already-shipped code — this is not a historical, already-fixed bug, it is live. This directly motivates REQ-DATA-002j below and is not merely a defensive "just in case."

## FM-1 Assessment

No new entity, no new `K`/`DB` key, no new field on any existing entity, no new Sheets sync mapping. This is a one-time repair utility operating entirely on data already inside existing entity arrays. FM-1 category-1 (UI/AI layer feature with no new localStorage entities) — no council decision needed.

## REQ-DATA-002a (phantom-record detection criterion)

**Primary criterion (all entities):** a record is a phantom if its `id` field is falsy (missing, `null`, `undefined`, or empty string). Every legitimate record-creation path in this codebase assigns a real, always-truthy id at creation — most via `id: uid()` (`uid()` = `Date.now().toString(36) + Math.random().toString(36).slice(2,5)`, which can never return a falsy value), with two confirmed alternates that are equally always-truthy: a Cloud-Data-configured Supplier/Buyer takes its `id` from Supabase's own generated key (`result.data.id`) instead of calling `uid()` locally, and one local Buyer-creation path assigns `id: 'BUY' + Date.now()`. No legitimate record, however sparse its other fields, can ever have a falsy `id` under any of these three paths. This criterion directly matches SYNC-GAP-001's documented mechanism and the live `idKeyedEnts` gap described above.

**Compound criterion (Contacts only — resolves the v1 blocking finding):** a Contact record is *also* a phantom if `!c.id || (!c.name && !c.email)`. This is necessary because `backfillConIds()` (`index.html:2576-2582`) runs unconditionally on every app load, after every `pullAll()`, and after every data restore, and assigns a fresh, real `uid()` to any Contact missing one — with no check of whether the record has a name, email, or any other real content. A Contact corrupted by the historical bug has therefore almost certainly already been "healed" into a zombie record: a real, truthy `id`, but still no name and no email. `saveCon()` (`index.html:10244-10249`) hard-requires both `name` and `email` on every legitimate save — a real Contact can never have both blank — so `!name && !email` is a safe, precise, zero-false-positive signal restricted to exactly this entity's known self-healing blind spot. No equivalent self-healing function exists for any other entity (confirmed: `backfillConIds` is the only `backfill*Ids`-style function in the file) — the plain `!id` criterion is sufficient everywhere else.

Detection must scan `DB.sup`, `DB.li`, `DB.inv`, `DB.po`, `DB.qt`, `DB.payments`, `DB.con`, `DB.buy`, `DB.ord`, `DB.sh` — every top-level entity array — even though `buy`/`ord`/`sh` aren't expected to be affected by this specific historical bug, since a defensive full scan costs nothing and a phantom record found anywhere is a bug worth surfacing regardless of its origin.

## REQ-DATA-002b (preview before any mutation)

The tool MUST run a read-only scan first and display the exact count of phantom records found per entity, with no mutation to `DB` or `localStorage` at this stage. The operator reviews this count and explicitly confirms before anything is removed. There is no "auto-clean" path. A scan that finds zero phantom records in every entity must report that plainly (e.g. "No issues found — data looks clean," mirroring `runDataRepair()`'s own existing no-op message) and must not proceed to any confirmation/backup-gate step at all in that case — there is nothing to confirm.

## REQ-DATA-002c (mandatory backup gate)

Actual removal MUST be blocked behind the same style of mandatory, checkbox-gated backup-export confirmation already used by `migrateSuppliersBuyersToSupabase()`/`showBlockingBackupModal()` — the operator must attest a full backup was taken in this session before the cleanup can proceed. This is a genuine block (the confirm action stays disabled until the checkbox is checked), not a dismissible warning.

## REQ-DATA-002d (phantom removal)

For each scanned entity array, keep only records that pass REQ-DATA-002a's criterion for that entity (the plain `!id` check for every entity except Contacts, the compound check for Contacts): `DB.<entity> = DB.<entity>.filter(function(r){ return <not a phantom>; });`. This reassignment pattern (`DB.x = DB.x.filter(...)`) is the established, universal convention already used by every existing delete function in this codebase (`delSup`, `delLI`, `delBuy`, `delCon`, `delInv`, `delPO`, `delOrd`, etc. — confirmed zero uses of `.splice()` anywhere in the file, and zero places holding a stale direct alias to a `DB.x` array that a reassignment could leave stale). No partial-repair/reconstruction of a phantom record is attempted, since by definition none of its data is recoverable.

## REQ-DATA-002e (renumbering scope — explicit split by entity, not "renumber everything")

After phantom removal, close number-sequence gaps by renumbering **only**: Suppliers (`SUP-`), Line Items (`LI-`), Buyers (`BUY-`), Contacts (`CON-`), Order Requests (`ORD-`) — the five entities `backfillRefNums()` already manages, whose `num` field is confirmed — by two independent, from-scratch full-file searches, not a single grep re-run — to never be used anywhere in this codebase as a relationship-lookup key; every cross-entity reference to these five is by internal `id`.

**Invoices, Purchase Orders, Quotes, and Credit Notes are explicitly excluded from renumbering, permanently, not just for this pass.** Verified in the live code: a Credit Note stores its linked Invoice's `num` as a persisted text field (`linkedInvNum`) and re-resolves it by `num`-equality lookup later (`index.html:7917`: `DB.inv.find(i => i.id===inv.linkedInvId || i.num===inv.linkedInvNum)`); the CSV/Sheets importer matches existing Invoices/POs by `num` specifically because those entities have no `id` column in Sheets (`processImportRecords()`, `index.html:7618,7639,7670,7688`, mirroring SYNC-GAP-001's own documented business-key-matching design); `pullAll()`'s `findLocalMatchByBizKey()` (`index.html:3781`) does the same for inv/cn/po/qt. Renumbering an Invoice or PO after the fact would silently break these `num`-keyed lookups and could desynchronize a Credit Note from the Invoice it's linked to. These numbers are also the ones most likely to already appear on documents issued to an external supplier or buyer. This exclusion is a hard requirement, not a preference — confirmed correct with the operator directly (2026-08-22) after presenting the risk.

## REQ-DATA-002f (renumbering preserves creation order)

Renumbering must not scramble the relative order of existing records. Sort the surviving records of each renumbered entity by their current valid `num`'s numeric sequence value, falling back to `createdAt` for any record that — pre-repair — never had a `num` at all (mirroring `backfillRefNums()`'s own existing tie-break, `index.html:2553-2559`), then reassign `PREFIX-0001`, `PREFIX-0002`, ... in that order. For the residual edge case of two records lacking *both* a valid `num` and a `createdAt`, the comparator returns `0` for that pair and relies on `Array.prototype.sort`'s stability guarantee (satisfied by every browser this app supports) to preserve their original array order deterministically — this must not be left implicit in the implementation's comments, given it was flagged as ambiguous during review. A record's relative position in the sequence never changes; only the gaps left behind by removed phantoms close up.

## REQ-DATA-002g (relationship safety — verify, don't just assert)

Renumbering changes only the `num` field on the five entities in scope — never `id`, and every cross-entity reference in this codebase is by `id`. The tool's own post-run verification step must positively confirm this rather than merely relying on the design: after renumbering, re-resolve every one of the following real, confirmed FK fields against the renumbered entity's `id` set and confirm zero references became newly dangling:

- `supplierId` (Contact → Supplier)
- `supId` (Line Item / PO / RFQ response → Supplier)
- `buyerId` (Invoice → Buyer — **corrected in v2; `buyId` is not a persisted field, it is only a transient AI-chat-action parameter name**)
- `contactId` (Order Request → Contact, and nested `rfqResponses[].contactId` → Contact)
- `sourceContactId` (Quote → Contact — **added in v2, omitted from v1**)
- `lid` (the embedded Line-Item FK inside Invoice/PO/Quote `lineItems`/`lines` arrays → Line Item — **added in v2, omitted from v1; arguably the single most important FK to re-verify, since Line Items are in the renumbering scope**)

Since renumbering never touches `id`, this check is expected to always pass — its purpose is to catch a mistake in this feature's own implementation, not to catch a hypothetical design flaw. This list is the actual verification target, not an illustrative "etc." sample — the implementation must check every field named above, not a subset.

## REQ-DATA-002h (audit trail)

Every phantom-record removal and every renumbering event must be logged via the existing `logEv()` mechanism (`entityType`, `entityId`, `verb` `phantom_removed`/`renumbered`, a `summary` naming the affected entity and old/new number where applicable, `actor` `'operator'`), so there's a permanent record of exactly what this tool changed and when — consistent with every other data-mutating action in this app.

## REQ-DATA-002i (manual trigger only, one-time in spirit)

This is a Settings → Data tool, triggered explicitly by the operator (matching the existing `runDataRepair()` button precedent) — never run automatically on load, on sync, or on any schedule. It can be run more than once (e.g. if new phantom records somehow appear in the future), but is not a background/recurring process.

## REQ-DATA-002j (defensive hardening — close a live gap, not a hypothetical one)

Independent verification confirmed this is not a defensive-just-in-case ask: `pullAll()`'s current merge logic (`index.html:3765-3964`) defines `idKeyedEnts = ['sup','payments','co']` and, for entities in this list, explicitly skips the fresh-`uid()`-assignment fallback that other entities get when a pulled record's `id` resolves falsy after translation. Concretely: today, on the currently-shipped code, a pulled Supplier/Payment/Contact row whose `id` column is blank or fails `unmapRec()` translation, with no matching local record, enters `DB` with a falsy `id` — the exact same symptom SYNC-GAP-001 originally produced, via a different, still-live code path.

Add a guard directly in this merge step: a pulled record that resolves to a falsy `id` after translation, for any of `sup`/`payments`/`co` (and defensively, any other entity routed through this merge), must be dropped entirely — never written into `DB` — with a console warning naming the entity and the raw pulled row for visibility. This closes the live gap, not merely a historical one.

## Acceptance Criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | `DB.sup` contains 3 real Suppliers and 2 phantom records (`id` falsy) | The scan runs | It reports exactly 2 phantom Suppliers found; `DB.sup` is unmodified |
| AC-1b (new) | `DB.con` contains 2 real Contacts and 1 Contact with a real, truthy `id` (assigned by `backfillConIds()`) but no `name` and no `email` | The scan runs | It reports exactly 1 phantom Contact found — proving the compound criterion, not just `!id`, is actually applied |
| AC-2 | The same fixture, backup not yet confirmed | The operator tries to run the actual cleanup | It is blocked with a clear message; `DB.sup`/`DB.con` are unmodified |
| AC-3 | The same fixture, backup confirmed | The operator confirms cleanup | `DB.sup` now has exactly 3 records passing the criterion; the real Suppliers' data is byte-for-byte unchanged except `num` |
| AC-4 | 3 real Suppliers with nums `SUP-0001`, `SUP-0003`, `SUP-0007` (gaps from removed phantoms) | Renumbering runs | They become `SUP-0001`, `SUP-0002`, `SUP-0003` in their original relative order |
| AC-5 | A real Invoice/PO/Quote/Credit Note with any `num` | Cleanup runs (even if phantom Invoices/POs also exist and get removed) | Its `num` is never modified, only phantom records with falsy `id` are removed from those arrays |
| AC-6 | A Contact with `supplierId` pointing at a real Supplier's `id`, a Quote with `sourceContactId` pointing at a real Contact's `id`, and an Invoice line item with `lid` pointing at a real Line Item's `id` | The referenced Supplier/Contact/Line Item gets renumbered (its `num` changes, `id` doesn't) | All three FK fields are unchanged and still resolve correctly — verified by the tool's own post-run check against the real field list in REQ-DATA-002g, not just assumed |
| AC-7 | Cleanup runs and removes 2 phantom Suppliers and renumbers 3 real ones | — | `DB.events` gains entries recording both actions |
| AC-8 | `pullAll()` receives a pulled Contact record that resolves to a falsy `id` after existing translation | The merge runs | That record is dropped, never written to `DB`; a console warning is emitted; no other pulled record in the same batch is affected |
| AC-9 (new) | Every entity's `DB` array contains zero phantom records | The scan runs | It reports 0 found for every entity and does not proceed to the backup-gate/confirm step at all |

## Open Questions for Spec-Gate

1. Exact UI placement/wording for the scan/preview/confirm flow in Settings → Data — left to spec-gate, following the existing `runDataRepair()` button's visual pattern as the nearest precedent.
2. Whether Shipments (`DB.sh`) needs any special handling given they use a `ref` field rather than a `num` field for their own reference scheme — spec-gate should confirm `sh` is included in phantom-*detection* (REQ-DATA-002a) but confirm it is correctly excluded from the renumbering entity list (REQ-DATA-002e only lists sup/li/buy/con/ord).
3. (New) `known-gaps.md`'s SYNC-GAP-001 entry's delete-button mechanism description (`undefined !== ''`) is now known to be slightly inaccurate against the live code (real mechanism: `undefined !== "undefined"` via unescaped string concatenation) — worth a small, separate documentation correction, out of scope for this REQ's implementation.
