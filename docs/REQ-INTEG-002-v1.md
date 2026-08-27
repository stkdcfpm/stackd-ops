# REQ-INTEG-002 (Sub-phase 2a) — Supplier Payment Ledger

**Status:** v1 — first draft, check-first complete against `main` @ `cd552f4` (563/563 tests passing).
**Scope:** Sub-phase 2a of 4 in a larger Payment Allocation build (2a Supplier ledger → 2b Invoice→PO enumeration fix → 2c Buyer payment tranches → 2d full allocation link). This sub-phase stands alone: it solves a real, currently-felt problem (no record anywhere of payments made to suppliers) without depending on 2b/2c/2d.

---

## 1. Business context

There is currently no record anywhere in the app of payments FPM makes to suppliers. `PO.dep` ("Supplier Deposit Paid") and `PO.fpmFunded` ("FPM Funded (out of pocket)") are single, manually-overwritten currency amounts with no history, no tranche support, and no timestamp — every time the operator pays a supplier, they overwrite the same number, destroying the record of what was paid when. This sub-phase adds a real, append-only ledger of individual supplier payments per PO, mirroring the existing buyer-side Payments ledger (`DB.payments`) that already solves the identical problem on the buyer side.

This sub-phase does **not** build buyer-side payment requests (2c), does not fix `inv.pos[]`/Invoice→PO enumeration (2b), and does not build any allocation or rollup linking buyer and supplier money (2d). Those are separate, future briefs.

### 1.1 Facts established during check-first (against `main` @ `cd552f4`, 563/563 tests passing)

- **`PO.dep`/`PO.fpmFunded` are single overwritable fields, confirmed unchanged.** `dep` ("Supplier Deposit Paid," `index.html:2179`) and `fpmFunded` ("FPM Funded (out of pocket)," `index.html:2180`) are both built into the PO object at save time as raw form values with no history: `dep:+G('pf-dep').value||0, fpmFunded:+G('pf-fpm').value||0` (`index.html:6824`). Neither is ever summed from a ledger — each save simply replaces the prior number.
- **`PO.fpmRecovered`'s auto-set logic is duplicated in two places, confirmed still present, not touched by this REQ.** Once inside `saveInv()` (`index.html:5755-5769`, condition at `5759`) and once inside `savePayment()` (`index.html:11291-11305`, condition at `11295`) — byte-for-byte independent copies of the same "if this PO's linked invoice just reached Paid and the deposit hasn't been recovered yet, mark it recovered" logic. **Per explicit instruction, this sub-phase does not consolidate this duplication** — both blocks are left exactly as they are; REQ-INTEG-002h below makes this an explicit non-goal.
- **`toGBP()`/`fromGBP()` confirmed as the sole conversion mechanism, unchanged.** `index.html:4266-4274` / `4276-4284`. GBP is the fixed pivot — there is no direct USD↔RMB path. Rates come from the `QR` object (`index.html:3346`), which loads from `localStorage` (`ld('st_qr')`) or falls back to `QR_DEFAULTS` (`index.html:3345`: `fxGBPUSD:1.27, fxGBPRMB:9.20, fxGBPBBD:2.54`, plus non-FX fields irrelevant here). `toGBP(amount, cur)` inspects `cur` and applies exactly one of `QR.fxGBPUSD`/`QR.fxGBPRMB`/`QR.fxGBPBBD` (or none, for GBP itself) — never more than one rate per call. This sub-phase's `lockFxRate()` wrapper (REQ-INTEG-002b) calls `toGBP()` unmodified; `toGBP()`/`fromGBP()` themselves are not touched.
- **`getPaymentTerms()`/`RD_PAYMENT_TERMS_BASE` confirmed as a distinct, unrelated concept.** `index.html:3573-3577` (base list: `'Net 30','Net 60','Net 90','LC at sight',...` — free-text labels for a PO/Invoice's overall payment terms) and `getPaymentTerms()` (`index.html:3700-3703`, adds operator-defined custom strings from `localStorage`). This sub-phase's `purpose` field (Deposit/Balance/Other, REQ-INTEG-002a) is a new, separate concept on the individual payment record — it is not read from or written to this list, and this REQ does not modify `RD_PAYMENT_TERMS_BASE`/`getPaymentTerms()` in any way.
- **The buyer-side Payments ledger is the direct precedent this sub-phase mirrors.** `DB.payments` (`K.pm` → `st_pm`, `index.html:2604`), created via `addPaymentFromForm()` (`index.html:11394-11419`) with shape `{ id, invId, invNum, date, amount, method, reference, notes, type:'buyer_payment', creAt }`, saved via `savePayment()` (`index.html:11262-11311`), queried via `getInvPayments(invId)`/`getInvTotalPaid(invId)` (`index.html:11253-11260`), displayed via `renderPaymentsTab(invId)` inside a dedicated modal (`ov-payments`, `index.html:1235-1244`) opened by a per-row "$" button on the Invoices list (`openPayments(inv.id, inv.num)`, triggered at `index.html:6093`, defined at `8157-8162`). `PAYMENT_METHODS` (`index.html:11249`: `'Bank Transfer','Wire Transfer','Cash','Cheque','PayPal/Stripe','Other'`) is generic — no buyer-specific wording — and is safe to reuse for supplier payments as-is.
- **No cascade-delete of payment records on parent-record deletion is the established precedent, not a gap to fix here.** `delInv()` (`index.html:6753-6767`) removes the Invoice and cleans up `DB.li[].invoiceRefs`, but never touches `DB.payments` — any payment record referencing the deleted invoice's `id` becomes orphaned (its `invId` no longer resolves, though `invNum` remains as a text remnant). `delPO()` (`index.html:6855-6862`) is a bare `confirm()` + filter, with no cleanup logic of any kind. **This sub-phase follows the same established precedent**: deleting a PO does not cascade-delete its linked Supplier Payment records (REQ-INTEG-002f) — this mirrors existing behavior exactly, it is not a new gap introduced by this REQ.
- **`FIELD_MAPS` has a more nuanced precedent than "Order Requests/Buyers" for a payments-shaped entity — flagged per explicit instruction to flag if the cited precedent doesn't cleanly apply.** `FIELD_MAPS` (`index.html:3879`) has **no** `ord:` or `bu:` key at all (the true "never had a sync mapping" precedent) — but it **does** have a `payments:` key (`index.html:3885`: `{ id:'Payment ID', invNum:'Invoice #', date:'Date', amount:'Amount', cur:'Currency', method:'Method', notes:'Notes' }`), even though `savePayment()` itself carries an explicit code comment stating sync was never wired up: `// Payments not synced to Sheets yet — handled in v3.0.0` (`index.html:11310`). So buyer Payments is in a **third, distinct category** from both "actively synced" and "never intended to sync": a field-map entry exists (documenting an intended future shape) but no live `syncEnt()`/`pullAll()`/`pushAll()` code path uses it. Since the new Supplier Payments entity is the direct structural sibling of buyer Payments (not of Order Requests/Buyers), **this REQ defaults to mirroring buyer Payments' exact precedent** — add an equivalent `FIELD_MAPS.supPayments`-style entry for future-shape documentation, but no live sync wiring, consistent with the "not synced yet, handled in v3.0.0" comment already established for its direct sibling. This default is flagged explicitly in §5 for the user/spec-gate to confirm or override, since it is not the literal "Order Requests/Buyers, category 3, no field-map entry at all" precedent originally cited in the brief.

---

## 2. Requirements

### REQ-INTEG-002a — New entity: Supplier Payments
A new top-level array, `DB.supPayments` (backed by a new `K.spm` → `st_spm` localStorage key, following the existing `K` naming convention — `index.html:2604` — and the existing `let DB = {...}` initialization pattern — `index.html:2617`). Each record:
- `id` (uid()), `creAt` (ISO timestamp) — standard housekeeping, matching every other entity's convention.
- `poId`, `poNum` — **required**, not optional. `poId` is the authoritative link; `poNum` is a denormalized display copy, following the exact same pattern as buyer Payments' `invId`/`invNum` pair (`index.html:11406-11407`) — including that same pair's known, accepted characteristic that `poNum` can go stale as plain text if the PO's own `num` is later edited, since only `poId` is re-resolved. No new validation beyond what buyer Payments already has is introduced for this.
- `date` — required.
- `amount`, `currency` — the **native** currency actually paid (e.g. RMB, USD). Never store only a GBP-converted figure as the source of truth for the amount itself.
- `purpose` — closed-set: `Deposit`, `Balance`, `Other`. Required. (No conditional-note-on-Other requirement was asked for and none is added — unlike Phase 2's `approvalMethod`, this is a plain required dropdown.)
- `method`, `reference`, `notes` — mirror buyer Payments' shape exactly (`method` from the existing, shared `PAYMENT_METHODS` constant, `index.html:11249` — not a new list).
- `rateLock` — an object, `{ amount, currency, gbpEquiv, ratesUsed, ts }`, produced by `lockFxRate()` (REQ-INTEG-002b) at save time and stored verbatim, never recomputed on read.
- `type: 'supplier_payment'` — a literal constant, mirroring buyer Payments' own `type:'buyer_payment'` literal (`index.html:11413`), so the two ledgers remain trivially distinguishable if ever queried together in a future phase (2d).

### REQ-INTEG-002b — `lockFxRate(amount, currency)`
A new, small wrapper function, placed near `toGBP()`/`fromGBP()` (`index.html:4266-4284`):
- Calls `toGBP(amount, currency)` unmodified to compute `gbpEquiv`. Does not modify `toGBP()`/`fromGBP()` themselves in any way.
- Returns `{ amount: amount, currency: currency, gbpEquiv: <result>, ratesUsed: {...}, ts: new Date().toISOString() }`.
- `ratesUsed` contains only the single QR rate field actually applied by `toGBP()` for the given currency (e.g. `{ fxGBPRMB: QR.fxGBPRMB }` for an RMB payment; `{}` for a GBP payment, since `toGBP()` applies no rate at all when `cur==='GBP'`) — not the whole `QR` object. This makes the snapshot a true point-in-time record of what was actually used, not an unrelated dump of every rate that happened to exist at the time.
- This snapshot is captured once, at save time, and never recomputed — reading a `rateLock` back later must return the same `gbpEquiv`/`ratesUsed` regardless of what `QR` currently holds (this is the entire point of "rate-lock").

### REQ-INTEG-002c — `saveSupPayment()`, `getPOPayments(poId)`, `getPOTotalPaid(poId)`
Mirroring the buyer-side trio exactly:
- `getPOPayments(poId)` — mirrors `getInvPayments(invId)` (`index.html:11253-11256`): filters `DB.supPayments` by `poId`, sorted by `date` ascending.
- `getPOTotalPaid(poId)` — mirrors `getInvTotalPaid(invId)` (`index.html:11258-11260`): sums `getPOPayments(poId)`'s records' `rateLock.gbpEquiv` (not raw `amount`, since records may span multiple native currencies — summing raw amounts across currencies would be meaningless; summing the locked GBP-equivalent is the only sound aggregate). This function does **not** feed any dashboard KPI and does **not** cross-reference the buyer side in any way — that join is explicitly out of scope (2d).
- `saveSupPayment(payment)` — mirrors `savePayment()`'s persistence pattern (`index.html:11262-11266`: find-by-id-or-push, `sv(K.spm, DB.supPayments)`, `audit('SAVE','sup_payment',...)`, `logEv('sup_payment', payment.id, 'created', ..., 'operator')`) but explicitly does **not** replicate `savePayment()`'s Invoice-side side effects (updating `inv.dep`, auto-status transitions, `syncEnt()`) — those are Invoice-specific behaviors with no supplier-side equivalent asked for in this phase. It also does **not** write anything back onto the linked PO's `dep`/`fpmFunded` fields — per explicit scope, this phase adds a ledger *alongside* those fields, it does not repurpose or auto-update them (doing so would silently change existing PO-balance-calculation behavior, which is not asked for and would need its own explicit sign-off).

### REQ-INTEG-002d — "Record Supplier Payment" UI
A new modal (e.g. `ov-po-payments`), structurally mirroring `ov-payments` (`index.html:1235-1244`) exactly — header title, a payment-history table, and a "RECORD PAYMENT" form section below it (mirroring `renderPaymentsTab()`'s layout, `index.html:11334-11392`, with `purpose` added as an extra required dropdown field alongside Date/Amount/Method/Reference/Notes). Opened via a new per-row action button on the PO list (`rPO()`, `index.html:6835-6853`), mirroring the Invoices list's "$" button (`index.html:6093`) and its `openPayments(inv.id, inv.num)` trigger (`index.html:8157-8162`) — a new `openPOPayments(po.id, po.num)` opens the new modal and renders the new payments-tab container for that PO. A supplier payment cannot be created without a `poId` — there is no "new payment" entry point that isn't reached from a specific PO's row/modal, so no orphaned/unlinked record is ever possible by construction (matching the brief's explicit requirement).

### REQ-INTEG-002e — Supplier Payment history display
The new modal's payment-history table (per REQ-INTEG-002d) shows, per linked Supplier Payment record: date, amount + native currency, GBP-equivalent (from the stored `rateLock.gbpEquiv`, not recomputed), and purpose. This replaces the operator's current mental math of "what have I actually paid this supplier so far" — today, the only visible number is `PO.dep`/`PO.fpmFunded`, a single overwritten figure with no breakdown.

### REQ-INTEG-002f — PO deletion/edit interaction (explicit, matches existing precedent — not a new gap)
Deleting a PO (`delPO()`, `index.html:6855-6862`) does **not** cascade-delete its linked Supplier Payment records, exactly matching `delInv()`'s existing, unchanged treatment of buyer Payments (§1.1). A Supplier Payment record whose `poId` no longer resolves becomes an orphaned historical record (its `poNum` remains as text) — this is a known, accepted characteristic inherited from the identical existing behavior on the buyer side, not a defect introduced by this phase. Editing a PO's own fields (including its `num`) has no effect on already-saved Supplier Payment records — `poId` remains valid; `poNum` on existing records is not retroactively updated (again, exactly matching buyer Payments' existing `invNum`-staleness characteristic).

### REQ-INTEG-002g — FM-1 compliance
Per §1.1's finding, this REQ defaults to mirroring buyer Payments' own FM-1 category (a `FIELD_MAPS` entry present for future-shape documentation, no live sync wiring — "not synced yet"), not the literal "Order Requests/Buyers, no field-map entry at all" precedent. A new `FIELD_MAPS.supPayments` entry (mirroring `FIELD_MAPS.payments`'s field selection, `index.html:3885`) is added; no `syncEnt`/`pullAll`/`pushAll` code path is wired for it, matching `index.html:11310`'s existing "handled in v3.0.0" deferral for its direct sibling. **This is flagged as an open question in §5** — if the intent was the stricter "no field-map entry at all" reading, REQ-INTEG-002g is replaced with a one-line statement that no `FIELD_MAPS` change is made at all.

### REQ-INTEG-002h — Explicit non-goal: `fpmRecovered` duplication
The two independent `fpmRecovered` auto-set blocks (`saveInv()` `index.html:5755-5769`; `savePayment()` `index.html:11291-11305`) are left exactly as they are. This REQ adds no new call site that touches `fpmRecovered`, and does not consolidate the existing duplication. Per explicit instruction, this can only be revisited with explicit sign-off in a separate, dedicated change — not as a side effect of this ledger build.

---

## 3. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A PO with no Supplier Payment records | `openPOPayments(po.id, po.num)` is used and a payment recorded (date, amount, currency, method, purpose) | A new `DB.supPayments` record is created with all required fields, `poId`/`poNum` correctly set, a `rateLock` snapshot present |
| AC-2 | A payment recorded in RMB when `QR.fxGBPRMB` is `9.20` | The payment is saved | `rateLock.ratesUsed` contains exactly `{ fxGBPRMB: 9.20 }` (or the then-current value), and `rateLock.gbpEquiv` equals `amount / 9.20` |
| AC-3 | A Supplier Payment record saved with a given `rateLock` | `QR.fxGBPRMB` is later changed in Settings, then the record is read back (not re-saved) | The stored `rateLock.gbpEquiv`/`ratesUsed` are unchanged — the snapshot is never recomputed on read |
| AC-4 | A PO with 3 Supplier Payment records in 3 different currencies (e.g. RMB, USD, GBP) | `getPOTotalPaid(poId)` is called | The result equals the sum of each record's stored `rateLock.gbpEquiv` — not a sum of raw `amount` values across currencies |
| AC-5 | A payment record with `purpose` unset/empty | The save action is attempted | Blocked — `purpose` is required |
| AC-6 | A payment record with no `poId` | Attempted via any code path | Cannot occur — there is no UI entry point to create a Supplier Payment without an already-selected PO (REQ-INTEG-002d) |
| AC-7 | A PO with 2 linked Supplier Payment records | The PO is deleted (`delPO()`) | The PO record is removed; the 2 Supplier Payment records remain in `DB.supPayments`, now referencing a `poId` that no longer resolves — no error, no cascade delete (matches AC-analogous existing behavior for buyer Payments on Invoice deletion) |
| AC-8 | A PO's `num` is edited after 1 Supplier Payment record already exists for it | The PO is saved with the new number | The existing Supplier Payment record's `poId` still resolves correctly (same PO); its `poNum` text is unchanged (stale), exactly matching buyer Payments' existing `invNum` characteristic |
| AC-9 | `saveInv()`'s and `savePayment()`'s `fpmRecovered` blocks (`index.html:5755-5769`, `11291-11305`) | This phase is built | Both blocks are byte-for-byte unchanged — full-suite regression confirms no behavior change to FPM-recovery logic |
| AC-10 | The full existing test suite (563/563 as of this REQ's check-first pass) | This phase is built | All pre-existing tests still pass unchanged |

---

## 4. Explicitly out of scope

- No buyer-side payment request/tranche entity (2c).
- No fix to `inv.pos[]` or Invoice→PO enumeration (2b) — `getPOTotalPaid()` operates on a single already-known `poId`, it does not attempt to discover "all POs for an Invoice."
- No allocation linking a buyer payment to specific supplier payments, no cross-side rollup, no dashboard KPI integration (2d).
- No changes to the existing buyer-side Payments tab/ledger (`DB.payments`, `savePayment()`, `renderPaymentsTab()`) of any kind.
- No consolidation of the duplicated `fpmRecovered` logic (REQ-INTEG-002h).
- No auto-update of `PO.dep`/`PO.fpmFunded` from the new ledger — those fields are left exactly as they are, manually maintained, alongside the new ledger.
- No live Sheets sync wiring for the new entity (REQ-INTEG-002g).

---

## 5. Open questions for spec-gate (and one for the user)

1. **For the user:** confirm REQ-INTEG-002g's default (mirror buyer Payments' "FIELD_MAPS entry present, no live sync" category) versus the brief's originally-cited "Order Requests/Buyers, no field-map entry at all" precedent. This REQ proceeds on the former (the closer structural sibling) unless corrected.
2. Exact placement/styling of the new "Record Supplier Payment" trigger button on the PO list row (REQ-INTEG-002d mandates a button exists and what it does, not its exact icon/position — left to spec-gate, mirroring the Invoices list's "$" button as the starting point).
3. Exact `logEv()`/`audit()` string wording for the new entity type (`'sup_payment'` used as a working label throughout this REQ — spec-gate may finalize a different string as long as it's applied consistently).

---

## 6. Test plan (maps to §3)

One test per acceptance criterion at minimum (AC-1 through AC-10), plus: a dedicated multi-currency `getPOTotalPaid()` test (AC-4) constructed with at least one GBP-native record (`ratesUsed:{}`) to confirm the identity case is handled correctly, not just the converted cases; a dedicated "rate changes after save" test (AC-3) that mutates `QR` between save and read to prove the snapshot truly isn't recomputed; and a full-suite regression run confirming the existing `fpmRecovered` blocks and all buyer-side Payments tests are unaffected (AC-9).
