# REQ-SHIP-001 — Auto-created Shipment record with a progressive trade-document checklist, triggered on Invoice → Paid

**Status:** v1 — drafted, self-reviewed (§8), all three originally-open questions resolved with the operator/by code verification (§5). Not yet independently second-reviewed — ready to run `requirements-gate` next.
**Type:** New entity-lifecycle feature. Extends the existing Shipment entity (`DB.sh`) with a new structured field and a new auto-creation trigger sourced from Invoice. Touches `index.html` and `supabase/migrations/` (Shipment's Cloud Data table needs one new column). No new external dependency.

---

## 0. How this REQ came to be scoped this way

Operator's original ask, verbatim intent: *"for a paid invoice, I want to trigger the creation of a shipment record that has a lifecycle like the invoice's draft to complete, that will allow me to add the details of the shipment as I get them — like the Purchase Invoice, Commercial Invoice, Bill of Lading, customs docs, certificates and Dangerous Goods docs — as an operator captures them over time."* Also asked that this be evaluated against real shipping/trade-compliance expertise to be "complete and robust" and to close "gaps in the market," not just satisfy the literal words of the ask.

This session has no dedicated shipping/trade-compliance reviewer agent — only software-correctness gates (`requirements-gate`, `spec-gate`, `build-gate`, `security-gate`). The honest way to ground this REQ in real domain practice, short of hiring a customs broker, is: (a) cite authoritative sources for the standard document set rather than working from training-data recall, and (b) have the operator — the actual domain expert running a real trade-intermediary business — confirm the resulting checklist before it ships, which is what §8's open questions ask for.

### 0.1 What was actually researched (with sources)

Standard ocean-freight import document set, confirmed across multiple carrier/logistics sources: Commercial Invoice, Packing List, Bill of Lading (or sea waybill), Certificate of Origin are the near-universal core; a Verified Gross Mass (VGM) declaration is also required for essentially all containerized cargo. ([iContainers — Shipping Document Checklist Generator](https://www.icontainers.com/help/shipping-document-checklist/), [Maersk — Important Shipping Documents](https://www.maersk.com/logistics-explained/shipping-documentation/2023/08/27/important-shipping-documents), [FreightAmigo — 2026 Guide: Essential Sea Freight Documents](https://www.freightamigo.com/en/blog/logistics/key-freight-documents-for-sea-freight-and-freight-forwarding-in-2026/))

**The VGM point is worth calling out specifically as a "gap in the market" catch, not a generic addition:** Verified Gross Mass declarations have been a mandatory SOLAS requirement for every containerized ocean shipment worldwide since 2016 — a genuinely universal, non-optional document that small-operator shipment-tracking tools frequently omit from their checklists because it isn't as well-known as a Bill of Lading or Commercial Invoice. Including it by default, always, regardless of destination, is a real, low-effort differentiator.

**FPM's actual trade lane matters here, and it's not what the test fixtures suggest.** `STACKD_CONTEXT.md` states FPM International sources from Chinese manufacturers and supplies Barbados today, expanding to UK-Nigeria/UK-Ghana/UK-India corridors — general goods (SIC 46190, non-specialised wholesale), not food/seafood (the "frozen tilapia" strings in this codebase's own test fixtures are arbitrary placeholder data, not a real commodity signal). Barbados-specific research surfaced two customs forms not on the operator's own list — a C-60 (customs value declaration) and a C-63 (item/weight/shipper/tariff-code declaration), alongside a CARICOM-format invoice requirement. ([trade.gov — Barbados Country Commercial Guide](https://trade.gov/country-commercial-guides/barbados-import-requirements-and-documentation), [Blue Horizon Shipping — Barbados Customs Regulations PDF](https://bluehorizonshipping.com/wp-content/uploads/2024/03/BARBADOS-CUSTOMS-REGULATIONS.pdf))

**This is exactly why the default checklist must not hardcode Barbados-specific forms** (§1.2 Decision 2 below) — the stated expansion to Nigeria/Ghana/India means a checklist hardcoded to today's one destination's customs paperwork becomes actively wrong, not just incomplete, the moment a second corridor opens. A competitor tool that bakes in one country's form set and silently misleads operators shipping elsewhere is itself a "gap in the market" this REQ should avoid recreating.

Dangerous Goods documentation (IMDG-compliant Shipper's Declaration for Dangerous Goods) is its own, separate, conditional requirement — only relevant when a shipment actually carries DG cargo, which this codebase already tracks via the existing `dg` boolean field on Shipment.

---

## 1. Business context

### 1.1 What exists today (check-first)

- `DB.sh` (Shipment) already exists as a top-level entity, Cloud-Data-migrated (`REQ-CLOUD-007`, v2.9.80). Fields relevant here: `status` (physical transit status: Booked/Confirmed/In Transit/.../Delivered — `index.html:4495-4497`), `docsStatus` (a single free-text/dropdown paperwork-completeness field: Pending/In Progress/Complete, rendered via a fixed lookup at `index.html:12871`), `dg` (boolean, already tracks Dangerous Goods presence), `linkedInvs` (array of Invoice refs — the existing, already-bidirectional-in-spirit join between Shipment and Invoice).
- `DB.inv` (Invoice) has a `status` field driven by a manual operator dropdown (`inv-sm`: Draft/Pro-forma/Sent/Partially Paid/Paid/Cancelled — `index.html:1133`, `STATUS_ORDER` at `index.html:2960`). `saveInv()` (`index.html:8203`) already captures the pre-save status (`_invOldStatus`) and, after the save completes, logs a `status_changed` event (`index.html:8444`) whenever it actually changed — this is the existing, already-correct hook point for detecting a transition *into* Paid specifically (`_invOldStatus !== 'Paid' && inv.status === 'Paid'`), not just "is the invoice Paid" (which would also match on every subsequent unrelated save of an already-Paid invoice).
- `autoPos()` (`index.html:8572`) is the direct precedent for "one Invoice save event triggers creation of a different entity's record(s)," fired today only from `saveInv()`'s interactive path (`if(!EI.i) autoPos(inv);`, `index.html:8448`) — **never** from CSV import or Google Sheets pull, which write `DB.inv`/`DB.po` directly and bypass `saveInv()`/`autoPos()` entirely. This REQ's new trigger follows the identical scoping: **fires only from `saveInv()`'s interactive save path, never from bulk import or sync paths.** A CSV backfill of historical already-Paid invoices, or a Sheets pull that happens to change an invoice's status field, must not spawn Shipment records — the operator is not present to review what gets created, and `autoPos()` already established this exact boundary for a materially similar risk (see `PO-GAP-003`/`SH-GAP-003`'s own history of unbounded-record-creation bugs from exactly this class of oversight).
- `saveShp()` (`index.html:12915`) shows that `ref` is a manually-entered, non-blank (≥2 chars), globally-unique field (`vShp()`, `index.html:10352`) — there is no auto-numbering scheme for Shipment today (unlike `SUP-####`/`LI-####`/etc.). An auto-created Shipment must synthesize its own collision-free `ref` since no operator is present at creation time to type one in, mirroring `autoPos()`'s own `'PO-'+(inv.num||Date.now().toString(36))+'-'+(idx+1)` fallback-numbering pattern for exactly the same reason.
- `linkedInvs` is the only existing join between Shipment and Invoice, and it is **not required to be 1:1** — a real Shipment can (and in practice, per this entity's own design, does) consolidate multiple Invoices into one container/BL. This matters directly for idempotency (§1.2 Decision 3).

### 1.2 Design decisions

**Decision 1 — New structured field, `tradeDocs[]`, added to the Shipment schema; `docsStatus` becomes a computed rollup for any Shipment that has one, and stays manually-set (unchanged behavior) for every Shipment that predates this feature.**

```js
tradeDocs: [
  { id: uid(), type: 'Commercial Invoice', status: 'Pending', refNum: '', fileLocation: '', receivedDate: '', notes: '' },
  ...
]
```
- `status` per document: `'Pending' | 'Received' | 'N/A'`.
- `fileLocation`: free text — a link or path to where the actual file lives (a Google Drive URL, a network share path, an email reference), **not a file upload**. Per operator's own explicit scoping: no file storage anywhere in this codebase today (only Postgres tables via `supabase-js` — no Supabase Storage bucket use exists), and standing one up is a separate infrastructure decision this REQ does not make. This field is rendered through `san()` like every other free-text field in the app; it is not validated as a well-formed URL (an operator might reasonably record a shelf/folder location for a physical paper archive, not just a link), only sanitized for safe display.
- `docsStatus` computed rule, recalculated on every `tradeDocs` mutation, for any Shipment that has a `tradeDocs` array at all: every entry `Received` or `N/A` → `'Complete'`; at least one `Received` but not all → `'In Progress'`; none `Received` → `'Pending'`. A Shipment with no `tradeDocs` array (every record created before this feature ships) keeps today's exact behavior — `docsStatus` stays a plain manually-set field, no forced backfill, no migration run against existing records. This preserves `shpStatusClass()`'s existing render logic and `FIELD_MAPS.sh`'s existing Sheets-sync mapping for `docsStatus` completely unchanged; `tradeDocs` is additive.

**Decision 2 — Default seed list is destination-agnostic and universal; nothing destination-specific is hardcoded.**

Per §0.1's research: FPM's stated ICP is multi-corridor (Barbados today, UK-Nigeria/UK-Ghana/UK-India next), and Barbados-specific customs forms (C-60/C-63/CARICOM invoice) would be actively wrong defaults the moment a second corridor ships. The seeded default list, applied to every auto-created Shipment regardless of destination:

1. Purchase Invoice — **resolved with the operator as a genuinely separate document from Commercial Invoice below**: this is the supplier's own bill to FPM for the goods (received from the supplier, distinct from both `autoPos()`'s auto-generated Purchase Order — FPM's order *to* the supplier — and the Commercial Invoice below). Seeded as a plain checklist line like every other entry, `status: 'Pending'`, **no auto-population from the linked PO or Invoice record** — those are different documents and conflating them would misrepresent what's actually been received.
2. Commercial Invoice
3. Packing List
4. Bill of Lading
5. Certificate of Origin
6. Verified Gross Mass (VGM) Declaration
7. Insurance Certificate
8. Dangerous Goods Declaration — **seeded only when the Shipment's own `dg` field is `true`** (reusing the existing boolean, not inventing a parallel flag; if `dg` is toggled on manually after creation, this entry should be added at that point too — see REQ-SHIP-001e)

The operator can freely add a custom document line (any free-text `type`) or remove/mark N/A any seeded line, per shipment — this is how destination-specific paperwork (Barbados' C-60/C-63, an ISPM-15 fumigation certificate for wood packaging, a phytosanitary certificate, an import permit) gets tracked without this codebase hardcoding a specific country's rules anywhere. A "save this shipment's current document set as a reusable preset for this lane" convenience is a plausible future enhancement but is explicitly **out of scope for v1** — noted here so it isn't silently forgotten, not built now.

**Decision 3 — Idempotency: match against existing `linkedInvs`, and do not assume 1:1.**

Before creating a new Shipment, scan `DB.sh` for any existing record whose `linkedInvs` already contains this invoice's `id` or `num`. If one is found, do not create a second Shipment — this covers: a human having already manually created the Shipment ahead of the trigger firing, a re-save of an already-Paid invoice that doesn't represent a real Draft→Paid transition (already excluded by the `_invOldStatus` check, but this is a second, independent guard against the exact class of bug this codebase has been bitten by twice this session already — duplicate payment ledger rows, `SH-GAP-003`'s unbounded phantom Shipments from an unmatchable-blank-`ref` join), and a Cloud Data refresh re-delivering a stale local copy of an invoice that looks like a fresh transition.

This explicitly does **not** attempt to detect "this invoice's line items obviously belong to a Shipment that already exists for a *different*, related invoice" — that would require inferring shipment consolidation logic (which invoices ship together) this REQ has no reliable signal for. One Paid invoice with no already-linked Shipment always creates exactly one new Shipment; consolidating multiple invoices onto one Shipment afterward remains a manual operator action (editing `linkedInvs` on the auto-created record, or on a pre-existing one), unchanged from today.

**Verified by direct code read (not left as an open question): `linkedInvs` is keyed by Invoice `num`, not `id`.** `saveShp()` (`index.html:12919`) populates it from a free-text comma-separated operator input (`shf-invs`); the demo fixture holds `['DINV-0001']` (a display reference, not a `uid()`); and the code comment at `index.html:7324` states explicitly that `linkedInvs` "carries no FK field of any kind." The idempotency check (this Decision) and the new record's own `linkedInvs` value (REQ-SHIP-001c) both match against/write `inv.num`, matching this existing, already-live convention exactly.

**Decision 5 — A Settings toggle exists, defaulting on, and its off-state is surfaced persistently, not just at the point someone happens to open Settings.**

Resolved with the operator: a checkbox toggle (`SS.autoCreateShipmentOnPaid`, default `true`, stored alongside the existing `SS.fwdWebhook`-style settings) turns the whole trigger off. Given `CON-GAP-001`-class precedent for "a setting silently left off and forgotten," a bare Settings checkbox with no other signal is not enough — a `dev`/`ops` person who flips it off during testing, or an operator who disables it once for a one-off reason, can otherwise forget it's off indefinitely with zero visible consequence until they notice a Paid invoice quietly produced no Shipment. **Mitigation:** when the toggle is off, a persistent (not one-time-dismissible, not a toast) banner is shown on both the Invoices tab and the Shipments tab headers — `'⚠ Shipment auto-creation is OFF — Paid invoices will not create a Shipment record automatically. Turn back on in Settings → Integrations.'` — reusing this codebase's existing banner/notice rendering pattern (e.g. the GDPR disclosure note already present in the Integrations card, `index.html:757`) rather than inventing a new one. The banner disappears immediately once the toggle is switched back on; no snooze/dismiss state is introduced; it is not itself gated by Cloud Data or any migration marker (it's pure local UI state, `SS`-driven, exactly like `fwdWebhook`).

**Decision 4 — Cloud Data.** Shipment is already Cloud-Data-eligible (`REQ-CLOUD-007`). The auto-creation function must branch exactly like `autoPos()` does: if `_sb && localStorage.getItem('st_sh_cloud_migration_ts')`, insert via `_sb.from('shipments').insert(...)` (requiring a new `trade_docs jsonb` column on the `shipments` table — a small, additive Supabase migration, no backfill needed since it's a new nullable column); else push directly to local `DB.sh`/`sv(K.sh, DB.sh)`. Per `CLAUDE.md`'s standing Cloud Data conventions: gate on the entity's own migration marker, not bare `_sb` truthiness, and if a `refreshShFromSupabase()`-style function exists and is wired into `initCloudDataLayer()`, confirm this new field round-trips through it without the `!= null ? val : undefined` key-presence trap already documented as a recurring bug class in this codebase.

### 1.3 GDPR / security note

No new PII category is introduced — `tradeDocs[]` contains shipment/document metadata (document type, a reference number, a free-text location string, a date), not personal data beyond what Shipment already carries (forwarder name/email, already covered by existing gaps `SEC-GAP-002`/`CON-GAP-001`-class handling). `fileLocation` being a free-text field that *could* contain a sensitive internal path or a shared-drive link with its own access controls is a mild, low-severity consideration — no different in kind from `notes` fields already present on every entity in this app — not a new category of risk requiring new mitigation.

---

## 2. Requirements

### REQ-SHIP-001a — New Shipment schema field: `tradeDocs[]`
Added to `DB.sh` records. Absent (`undefined`/not present) on any Shipment created before this feature ships — no forced migration, no backfill. `docsStatus` remains a plain field on such records, computed nowhere.

### REQ-SHIP-001b — New function: `autoCreateShipmentFromInvoice(inv)`
Called from `saveInv()`, immediately after the existing `_invOldStatus` comparison already used for the G-05 `status_changed` event (`index.html:8444`), and **only** when: `_invOldStatus !== null && _invOldStatus !== 'Paid' && inv.status === 'Paid'`. Never called from `processImportRecords()`/`processImport('inv')`, `pullAll()`, or any Cloud Data refresh path — matching `autoPos()`'s own established scope boundary (§1.1). Bails immediately, before the idempotency check, if `SS.autoCreateShipmentOnPaid === false` (REQ-SHIP-001k) — no toast, no side effect of any kind. Otherwise performs the idempotency check (Decision 3); if an existing linked Shipment is found, does nothing (no toast, no duplicate, no error — a silent, correct no-op, mirroring how `autoPos()` silently returns when `cnt` is 0).

### REQ-SHIP-001c — Synthesized `ref` and default field values
The new Shipment record: `ref` synthesized as `'SHP-' + (inv.num || Date.now().toString(36))`, with a collision-avoidance suffix (`-2`, `-3`, ...) appended only if that exact `ref` already exists in `DB.sh` — mirroring `autoPos()`'s numbering-fallback pattern, satisfying `vShp()`'s uniqueness rule even though this path bypasses `vShp()` entirely (same relationship `autoPos()` has to `vPO()`). `status` (physical transit) defaults to `'Booked'` — the first value in `SH_STATUSES` (`index.html:4495`). `linkedInvs` set to `[inv.num]`, matching the verified existing convention (Decision 3). `etd`/`eta`/`vessel`/`carrier`/`blNum`/`containerNum`/`forwarder`/`forwarderEmail` all blank — populated by the operator as they become known, exactly as asked. `dg` defaults to `false` unless a reliable signal exists on the Invoice to infer otherwise (none does today — leave `false`, operator toggles it manually, which per Decision 2 also adds the DG Declaration checklist line at that point).

### REQ-SHIP-001d — `tradeDocs[]` seeded per Decision 2
The universal seven-item default list (Purchase Invoice, Commercial Invoice, Packing List, Bill of Lading, Certificate of Origin, VGM Declaration, Insurance Certificate), plus an eighth (Dangerous Goods Declaration) only when `dg` is `true` at creation time.

### REQ-SHIP-001e — Toggling `dg` after creation adds/removes the DG checklist line
If an operator edits an existing auto-created (or any) Shipment and changes `dg` from `false` to `true`, and no `tradeDocs` entry of type `'Dangerous Goods Declaration'` already exists, one is added (status `'Pending'`). Toggling `dg` back to `false` does **not** delete an existing DG checklist entry if it has already progressed (a `status` other than `'Pending'`, or has any `refNum`/`fileLocation`/`notes` filled in) — only a still-untouched, still-`'Pending'`, no-data DG line may be silently removed on `dg` becoming `false`, to avoid destroying an operator's already-recorded work.

### REQ-SHIP-001f — Per-document CRUD on `tradeDocs[]`
New functions to add a custom document line, edit one (status/refNum/fileLocation/receivedDate/notes), remove one, mirroring this codebase's existing per-line-item edit patterns (e.g. Shipment's own `editShp()`/`saveShp()` shape, or Order Request line editing) rather than inventing a new interaction pattern. Exact UI placement/layout is a spec-gate/implementation call.

### REQ-SHIP-001g — `docsStatus` computed rollup
Recomputed per Decision 1's rule on every `tradeDocs` mutation (add/edit/remove/status-change), for any Shipment that has a `tradeDocs` array. Never recomputed for a Shipment with no `tradeDocs` array — that Shipment's `docsStatus` stays exactly as manually set today.

### REQ-SHIP-001h — Cloud Data
New `trade_docs jsonb` nullable column on the Supabase `shipments` table (new migration file). `autoCreateShipmentFromInvoice()` and the new per-document CRUD functions (REQ-SHIP-001f) branch on `st_sh_cloud_migration_ts` exactly as every other Shipment mutation site already does. `tradeDocs` round-trips through `refreshShFromSupabase()` (if one exists) without introducing the `!= null ? val : undefined` key-presence bug already documented in `CLAUDE.md`.

### REQ-SHIP-001i — `AI_SYSTEM_PROMPT` update
Per the standing "mandatory on every version" rule — describe the new auto-creation trigger and the trade-document checklist so the chat assistant answers accurately if asked "does marking an invoice Paid do anything else" or "how do I track shipping documents."

### REQ-SHIP-001j — Toast / operator visibility on auto-creation
When `autoCreateShipmentFromInvoice()` actually creates a new record (not the idempotent no-op case, and not the toggle-off bail-out), the operator sees a toast (`'Shipment ' + ref + ' auto-created — add details as they become available'`) so the new record isn't silently invisible after an invoice save, matching this codebase's existing `autoPos()` precedent (`toast(cnt+' PO'+(cnt!==1?'s':'')+' auto-generated')`).

### REQ-SHIP-001k — Settings toggle + persistent off-state banner
New `SS.autoCreateShipmentOnPaid` boolean, default `true`, editable via a new checkbox in Settings → Integrations (alongside the existing Forwarder Webhook URL field), persisted via the existing `sv(K.ss, SS)` pattern. Per Decision 5: while `false`, a persistent (non-dismissible, non-toast) banner renders at the top of both the Invoices and Shipments tab views, and disappears the moment the toggle is switched back on. The banner is pure local UI state — not migrated, not synced, not gated on Cloud Data.

---

## 3. Acceptance criteria

- **AC-1:** Saving an Invoice whose status changes from any non-Paid value to `'Paid'`, with no existing Shipment linking it, creates exactly one new Shipment record with the seeded default `tradeDocs[]` (7 entries; 8 if `dg` is true), a synthesized unique `ref`, and `linkedInvs` containing this invoice's `num`.
- **AC-2:** Saving an already-Paid Invoice again (no real status transition) creates no new Shipment.
- **AC-3:** Saving an Invoice that transitions to Paid, when a Shipment already exists with this invoice in its `linkedInvs`, creates no second Shipment (idempotency).
- **AC-4:** CSV-importing an Invoice record with `status: 'Paid'` set directly (bypassing `saveInv()`) creates no Shipment.
- **AC-5:** A Google Sheets pull (`pullAll()`) that updates an Invoice's status to Paid creates no Shipment.
- **AC-6:** The synthesized `ref` never collides with an existing Shipment `ref` — verified with a test that pre-seeds a colliding `ref` and confirms the suffix logic produces a unique one.
- **AC-7:** `docsStatus` is `'Pending'` immediately after auto-creation (all seeded docs `'Pending'`), moves to `'In Progress'` once at least one is marked `'Received'` (with others still `'Pending'`), and to `'Complete'` once every entry is `'Received'` or `'N/A'`.
- **AC-8:** A Shipment created before this feature (no `tradeDocs` array) is unaffected — its `docsStatus` remains exactly as stored, no computed override, no crash on render.
- **AC-9:** Setting `dg: true` on a Shipment with no existing DG checklist line adds one; setting `dg: false` afterward removes it only if it is still untouched/`'Pending'` with no recorded data, and leaves it in place otherwise.
- **AC-10:** Cloud Data: with Shipment migrated, auto-creation inserts via Supabase including the new `trade_docs` column; without migration, it writes to local `DB.sh` only — both paths tested.
- **AC-11:** `fileLocation` is rendered through `san()` — a value containing `<script>`/`"` does not break out of its containing markup (mirrors this session's own `SEC-GAP-021` fix pattern; verified by test, not assumed).
- **AC-12:** With `SS.autoCreateShipmentOnPaid` set to `false`, an Invoice transitioning to Paid creates no Shipment and shows no toast; the Invoices and Shipments tab views both render the persistent off-state banner; switching the toggle back to `true` makes the banner disappear on next render with no page reload required.
- **AC-13:** With the toggle at its default (`true`, or unset — an existing operator's `SS` predates this field), auto-creation behaves exactly as AC-1 with no banner shown.

---

## 4. Explicitly out of scope for v1

- Actual file upload/attachment storage (Supabase Storage or otherwise) — metadata/location-reference tracking only, per operator's own explicit scoping decision this session.
- Any destination-country-specific hardcoded document requirement (Barbados C-60/C-63 or otherwise) — operator-added custom lines only, per Decision 2.
- Multi-invoice shipment consolidation logic (inferring which Paid invoices belong on the same physical shipment) — remains a manual `linkedInvs` edit, unchanged from today.
- Reusable per-lane document-set presets — noted as a plausible future enhancement, not built now.
- Outbound webhooks/external automation triggered by this event — this REQ is the "in-app automation rules" half of the earlier scoping conversation; webhooks were explicitly deferred to a separate, later REQ.

---

## 5. Resolved decisions log (previously open questions)

1. **"Purchase Invoice" vs. "Commercial Invoice"** — resolved with the operator: two genuinely separate documents. Reflected in Decision 2/REQ-SHIP-001d as an 8-line default checklist (7 universal + conditional DG). Corrected one flawed idea floated while asking this question — the Purchase Invoice line must **not** auto-link to the `autoPos()`-generated PO, since the PO (FPM's order to the supplier) and the Purchase Invoice (the supplier's bill to FPM) are different documents; conflating them would misrepresent what's actually been received.
2. **`linkedInvs` join key** — resolved by direct code read, not a business decision: keyed by Invoice `num` (§1.2 Decision 3's verification note). No operator input needed; this was a check-first item, not a genuine open question.
3. **Toggle + off-state visibility** — resolved with the operator: a Settings toggle (default on) per Decision 5, paired with a persistent (non-dismissible) banner on the Invoices/Shipments tabs while off, addressing the "silently forgotten setting" risk the operator's own answer ("a toggle but with a reminder") flagged.

---

## 8. Self-review log

Reviewed against: `CLAUDE.md`'s stated architecture constraints (localStorage-only, single-file, no CDN/dependencies), the existing `autoPos()`/`saveInv()`/`saveShp()`/`vShp()` code read directly (not assumed), the existing Cloud Data conventions for Shipment specifically, the verified (not assumed) `linkedInvs` join-key convention, and two rounds of web research grounding the document taxonomy in cited sources rather than training-data recall. All three items originally raised as open questions are now resolved — two by direct operator decision, one by code verification that turned out not to need operator input at all (a useful distinction to keep making explicitly: not everything that feels uncertain while drafting is actually the operator's call).

Not yet independently second-reviewed. Recommend running `requirements-gate` next.
