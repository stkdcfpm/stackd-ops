# REQ-INTEG-002 (Sub-phase 2c) — Buyer payment tranches

**Status:** v1 — drafted. Not yet reviewed.

---

## 0. Scoping

This is **sub-phase 2c** of the in-flight Payment Allocation build (`REQ-INTEG-002`): 2a a Supplier Payment ledger (shipped v2.9.62, stabilized through v2.9.63–v2.9.65) → 2b the Invoice→PO enumeration fix making `Invoice.pos[]` authoritative (shipped v2.9.66) → **2c, this REQ** → 2d a full allocation link (still unscoped, comes after this REQ).

Unlike 2a/2b, 2c has no prior scoping pass at all — `docs/requirements-tracker.md`/`STACKD_CONTEXT.md` both flag it as "unbriefed... likely needs a scoping/investigation pass first, similar to how 2a/2b began, rather than assuming a specific design." A check-first investigation was run before drafting this REQ, and its central finding reframes what "2c" actually needs to be:

**Buyer payments already support multiple partial payments against one invoice today — this predates 2a.** `DB.payments`/`savePayment()`/`getInvPayments()`/`renderPaymentsTab()` (all pre-existing, `index.html:13021-13217`) place no restriction on how many payment records exist against one invoice; the UI already lets an operator add payment rows one at a time. In fact 2a's own Supplier Payment ledger was explicitly built *mirroring this already-existing buyer ledger* (`docs/REQ-INTEG-002-v2.md` §1.1). So "buyer payment tranches" cannot mean "let a buyer pay in installments" — that already ships. What it can defensibly mean, and what this REQ scopes it to, is: **closing the real parity gaps between the buyer payment ledger and the now-more-mature Supplier Payment ledger**, plus fixing one confirmed-live bug found along the way that tranche-style usage (more payment rows, more edits/deletes per invoice) makes materially more likely to surface. See §1 for the specific gaps and §3 for what is explicitly not being built.

This REQ does **not** touch Cloud Data — `DB.payments` is not in Cloud Data scope (Phase 3, still unbriefed) and nothing here changes that. Every change in this REQ is local-only, same as `DB.payments` behaves today.

After this REQ ships, **2d (full allocation link)** remains the next, still-unscoped step in the Payment Allocation build — not started by this REQ, per the same "don't assume the next phase's design" discipline this series has followed throughout the Cloud Data migration.

---

## 1. Business context

### 1.1 What already works today

`DB.payments` (key `K.pm`) holds buyer-payment records shaped `{ id, invId, invNum, date, amount, method, reference, notes, type:'buyer_payment', creAt }` (`addPaymentFromForm()`, `index.html:13172-13204`). `savePayment(payment)` (`index.html:13030-13089`, already `async` since REQ-CLOUD-005) upserts by id, recomputes `inv.dep` from `getInvTotalPaid(invId)` (`index.html:13026-13028`, a raw currency-agnostic sum), and auto-transitions `inv.status` to `Partially Paid`/`Paid` once the recomputed total crosses `inv.calc_grandTotal` — mutating `inv.status` directly, bypassing `canTransitionStatus()`'s forward-only guard entirely (only `saveInv()`'s own form-save path checks it, `index.html:7031-7032`). `deletePayment(id)` (`index.html:13091-13110`) removes a record and recomputes `inv.dep`, but — confirmed by direct reading, not assumption — **never re-evaluates `inv.status`** (§1.3). `renderPaymentsTab(invId)` (`index.html:13112-13170`) inside the `ov-payments` modal, opened via a per-row "$" button on the Invoices list (`index.html:7569`), already renders every payment row against one invoice, is available regardless of the invoice's own lock state, and is already exported via `acctPmtCSV`/`acctPmtJSON`/`acctFACSV` (`index.html:11172-11248`) and read by `_aiExecTool('get_payments')`.

### 1.2 The real gap: buyer payments have zero currency awareness

Every read site treats a buyer payment's amount as implicitly denominated in the invoice's own currency — there is no `currency` field on a `DB.payments` record at all. `cInv(inv)`'s own inline reconciliation (`index.html:4763-4768`) sums `DB.payments` amounts **raw**, with no currency check whatsoever; `editInv()`'s duplicate of the same logic (`index.html:6814-6826`) does the same. Compare to the Supplier Payment ledger post-2a: `saveSupPayment()`'s records carry a `currency` field and a `rateLock` object (`lockFxRate(amount, currency)`, `index.html:4847-4865`, snapshotting all three static FX rates at save time so a later reconciliation against a *different* currency uses the historically-locked rate, not today's live rate) — `getPOTotalPaidNative(po)` (`index.html:13225-13243`) sums same-currency payments raw and pivots any different-currency payment through that record's own locked GBP-equivalent via `fromGBPLocked()`, and `getPOEffectiveDepInfo(po)` (`index.html:13251-13262`) returns `{value, source}` — `'ledger'`, `'legacy-no-records'`, or `'legacy-unsupported-currency'` (gated on `PO_DEP_RECONCILE_CURS = ['USD','GBP','RMB','CNY','BBD']`, `index.html:13219`) — as a single point of truth, never mutating `po.dep`. Nothing equivalent exists for `DB.payments`. If a buyer genuinely pays in a currency other than the invoice's own, today's code silently sums the wrong number.

**Currency-set scope, decided here rather than left open:** the Invoice currency dropdown (`if-cur`, `index.html:1150`) offers six options — USD/GBP/EUR/BBD/NGN/GHS — three more than the PO dropdown's four (`pf-cur`, `index.html:2358`: USD/CNY/GBP/EUR). But `toGBP()`/`fromGBP()` (`index.html:4827-4845`), the only FX pivot mechanism that exists anywhere in this codebase, supports exactly the same four real currencies as `PO_DEP_RECONCILE_CURS` (GBP/USD/RMB-or-CNY/BBD) and silently no-ops (returns the input unchanged, not an error) for anything else — EUR is already a logged, deliberately-not-fixed gap (`PROC-GAP-002`), and **NGN/GHS have the identical unlogged gap**, confirmed by this REQ's own research. This REQ reuses `PO_DEP_RECONCILE_CURS` as-is for Invoice reconciliation (§2c) — it does **not** extend FX coverage to EUR/NGN/GHS, matching this series' own precedent of treating that as a separate, larger currency-infrastructure gap, not something a payment-ledger REQ silently absorbs.

### 1.3 The real bug: `deletePayment()` never reverses `inv.status`

Confirmed by direct reading of `deletePayment()` (`index.html:13091-13110`): it recalculates `inv.dep` but leaves `inv.status` untouched. Today this is a narrow, low-frequency latent bug — deleting a payment is rare. A tranche-oriented feature (more payment rows recorded over an invoice's life, more chance of correcting a wrongly-entered one) makes it a real, live defect worth fixing in the same change that touches this function, not a separately-scoped follow-up: an invoice can end up permanently stuck at `Paid` or `Partially Paid` — both `LOCKED_STATUSES` (`index.html:2850`) — with a `dep`/status pairing that no longer reflects reality, and no way to correct it short of manually editing `localStorage`.

### 1.4 The "purpose" field gap

Supplier Payment records carry a required `purpose` field, a closed three-option select — `Deposit`/`Balance`/`Other` (`index.html:13351`, enforced by `vSupPay()`, `index.html:13284-13286`). Buyer payment records have no equivalent. Without it, a buyer-payment "tranche" is an undifferentiated amount+date+method — there is no way to record or report on *why* a given tranche was paid (a deposit vs. a balance vs. something else), which is the one piece of information that actually distinguishes a genuine tranche-tracking feature from the ad-hoc partial-payment recording that already exists (§1.1).

### 1.5 What this REQ deliberately does not touch

The FPM-funded-deposit auto-recovery block inside `savePayment()` (`index.html:13059-13083`, extended most recently by `REQ-CLOUD-005` to route through `persistPOChange()`/`refreshPOFromSupabase()` when Purchase Order has migrated) is business-logic-orthogonal to buyer-payment tranches — FPM funding is a supplier-side deposit concept, buyer payments are receivables — but it is **not code-orthogonal**: it lives in the same function, immediately after the auto-status logic this REQ's §1.3 fix touches, and fires only on the `prevStatus !== 'Paid' → 'Paid'` transition. Any change to `savePayment()`'s status-derivation logic must leave this block's trigger condition and Cloud Data branch completely untouched, exactly the same caution `REQ-INTEG-002`'s own 2a explicitly declared as a non-goal (`REQ-INTEG-002h`) for the analogous duplicated-logic question on the supplier side.

---

## 2. Requirements

**REQ-INTEG-002-2c-a.** Add a required `purpose` field to buyer payment records — a closed select, `Deposit`/`Balance`/`Other`, mirroring Supplier Payment's own field exactly (same three options, same "required, non-empty" validation shape). `vPay(date, amount, invId, purpose)` gains a purpose check mirroring `vSupPay()`'s (`index.html:13284-13286`); `addPaymentFromForm()` reads a new `pm-purpose` select (mirroring `spm-purpose`, `index.html:13351`) and includes `purpose` in the record it builds. Existing payment records with no `purpose` (pre-dating this REQ) render as a dash/blank in any table that shows the column, exactly how Supplier Payment's own pre-existing records would if that field were ever added retroactively there — no backfill migration.

**REQ-INTEG-002-2c-b.** Add `currency` + `rateLock` fields to buyer payment records, reusing the existing `lockFxRate(amount, currency)` helper (`index.html:4847-4865`) verbatim — no new locking mechanism. `addPaymentFromForm()` gains a new `pm-cur` select defaulting to the invoice's own currency (`inv.cur`) rather than a bare `'USD'` default (unlike Supplier Payment's own default, since a buyer payment's most common case is same-currency-as-invoice, and defaulting to the invoice's currency reduces the chance of an operator accidentally recording a same-currency payment under the wrong `currency` value). The select still allows choosing a different currency for the rarer cross-currency-payment case.

**REQ-INTEG-002-2c-c.** New `getInvTotalPaidNative(inv)` (takes the invoice object, mirroring `getPOTotalPaidNative(po)`'s signature exactly — not an id, unlike the old `getInvTotalPaid(invId)` it supersedes) and `getInvEffectiveDepInfo(inv)` (mirroring `getPOEffectiveDepInfo(po)`'s `{value, source}` contract and its three `source` values verbatim: `'ledger'`, `'legacy-no-records'`, `'legacy-unsupported-currency'`), both reusing `PO_DEP_RECONCILE_CURS` (§1.2 — no new currency-set constant) and `fromGBPLocked()` for the cross-currency pivot. `cInv()`'s inline reconciliation (`index.html:4763-4768`) and `editInv()`'s duplicate (`index.html:6814-6826`) both replace their inline logic with a call to `getInvEffectiveDepInfo(inv).value`, retiring the duplication `PROC-GAP-002`'s own area of the codebase already carries once for the PO side; `savePayment()`'s own `totalPaid` computation (`index.html:13041`) and `deletePayment()`'s recompute (`index.html:13103`) both switch to `getInvTotalPaidNative(inv)` directly (the ledger total specifically, not the "effective" fallback — a payment was just added or removed at that point, so the "no records" fallback case never legitimately applies there). The old `getInvTotalPaid(invId)` (`index.html:13026-13028`) is removed, not kept as a compatibility wrapper, once all three call sites are migrated — confirm at requirements-gate that no other call site exists beyond the three already identified in §1.1/§1.3 (`index.html:6822`, `13041`, `13103`).

**REQ-INTEG-002-2c-d.** Fix the bug in §1.3: `deletePayment()` gains the same auto-status re-derivation `savePayment()` already performs (recompute `totalPaid` via `getInvTotalPaidNative(inv)`, compare against `inv.calc_grandTotal`), but scoped narrowly — only re-derive `inv.status` when its *current* value is `Partially Paid` or `Paid` (i.e., a status this exact derivation logic could itself have produced); never touch `Draft`, `Pro-forma`, `Sent`, or `Cancelled`. When the recomputed total drops to 0, the status reverts to `Sent` — the last pre-payment status in `LOCKED_STATUSES`' own progression — via a direct assignment, the same way `savePayment()`'s own auto-status logic already bypasses `canTransitionStatus()`'s forward-only guard (a deliberate backward move correcting a wrongly-entered payment, not a violation of the guard's own intent, which governs `saveInv()`'s form-driven status field specifically).

**REQ-INTEG-002-2c-e.** `renderPaymentsTab(invId)` (`index.html:13112-13170`) gains a Purpose column (mirroring `renderPOPaymentsTab()`'s own table shape, `index.html:13322-13338`) and a Currency/GBP-equivalent column pair only when at least one rendered payment's `currency` differs from the invoice's own — mirroring how the Supplier Payment tab always shows both columns (Supplier Payment's own currency choice is far more routinely cross-currency than Buyer Payment's is expected to be, per §2b's differing default), so an all-same-currency invoice's payment table stays as uncluttered as it is today.

**REQ-INTEG-002-2c-f.** `acctPmtCSV`/`acctPmtJSON`/`acctFACSV` (`index.html:11172-11248`) and `_aiExecTool('get_payments')` gain `purpose`/`currency` in their existing per-payment field lists, matching the shape their Supplier Payment equivalents already expose.

---

## 3. Out of scope

- **A scheduled/expected-payment-plan feature** (e.g., "30% deposit due on order, 70% balance due on shipment," with due dates, reminders, or an expected-vs-actual comparison) — the word "tranche" in this sub-phase's name could be read this way, but nothing in the existing roadmap language (`docs/requirements-tracker.md`, `STACKD_CONTEXT.md`) commits to it, and it is a materially larger, separate feature with its own UX design questions. This REQ closes the parity/bug gaps in the ledger that already exists (§1); a scheduled-payment-plan feature, if the business wants one, is its own future REQ.
- **2d (full allocation link)** — the next, still-unscoped step in the Payment Allocation build; not started here.
- **`PROC-GAP-002`** (EUR excluded from `toGBP()`/`fromGBP()`) and the identical, newly-confirmed NGN/GHS gap (§1.2) — both pre-existing, unrelated to buyer payments specifically, not fixed here. Log the NGN/GHS half as a new entry in `docs/known-gaps.md` at ship time (it was previously unlogged, confirmed by this REQ's own research), cross-referenced to `PROC-GAP-002` as the same defect class.
- **Real-time per-save Sheets sync for `DB.payments`** — `savePayment()`'s own comment (`index.html:13088`, "Payments not synced to Sheets yet — handled in v3.0.0") already defers this explicitly; bulk sync via `syncAll()`/`pullAll()`/`pushAll()` already covers `DB.payments` today (per `REQ-INTEG-002-v2.md` §1.1) and is unaffected by this REQ.
- **Cloud Data migration for `DB.payments`** — Phase 3, unbriefed, not started by this REQ (§0).
- **Backfilling `purpose`/`currency` onto pre-existing payment records** — both render as blank/default for records that predate this REQ (§2a/§2b); no migration script.
- **The duplicated `fpmRecovered` auto-set logic** between `saveInv()` and `savePayment()` — an explicit non-goal already declared by `REQ-INTEG-002h` in 2a, still true, not revisited here (§1.5).

---

## 4. Acceptance criteria

- **AC-1.** A new buyer payment cannot be saved without selecting a `purpose` (`Deposit`/`Balance`/`Other`) — `vPay()` blocks with a toast, mirroring `vSupPay()`'s own purpose check exactly.
- **AC-2.** A buyer payment's `currency` defaults to the invoice's own currency when the payment form opens, but can be changed to record a genuinely cross-currency payment; the saved record carries both `currency` and a `rateLock` object shaped identically to a Supplier Payment's own (`amount`/`currency`/`gbpEquiv`/`ratesUsed`/`ts`).
- **AC-3.** `getInvTotalPaidNative(inv)` sums same-currency payments raw (zero FX rounding) and pivots any different-currency payment through that payment's own locked `rateLock`, never today's live rate — demonstrated with at least one same-currency and one different-currency payment on the same invoice.
- **AC-4.** `getInvEffectiveDepInfo(inv)` returns `'legacy-no-records'` (raw `inv.dep`) when zero payments exist, `'legacy-unsupported-currency'` (raw `inv.dep`) when the invoice's currency isn't in `PO_DEP_RECONCILE_CURS` (e.g. EUR/NGN/GHS) even though payment records exist, and `'ledger'` (the reconciled native total) otherwise — all three cases tested.
- **AC-5.** `cInv()` and `editInv()` both read the invoice's deposit-paid figure exclusively via `getInvEffectiveDepInfo(inv).value` — no remaining inline duplicate of the reconciliation logic in either function.
- **AC-6.** Deleting a payment that had pushed an invoice to `Paid` or `Partially Paid` correctly re-derives `inv.status` (down to `Partially Paid`, or all the way back to `Sent` if the deleted payment was the only one) — demonstrated for both cases; deleting a payment on an invoice in `Draft`, `Pro-forma`, or `Cancelled` status leaves `inv.status` completely untouched.
- **AC-7.** The FPM-funded-deposit auto-recovery block inside `savePayment()` (`index.html:13059-13083`) is demonstrated unaffected by every change in this REQ — same trigger condition (`prevStatus !== 'Paid' → 'Paid'`), same Cloud Data branch, verified by a regression test that predates this REQ still passing unmodified.
- **AC-8.** `renderPaymentsTab()` shows a Purpose column for every payment row; shows Currency/GBP-equivalent columns only when at least one row's currency differs from the invoice's own, matching §2e exactly.
- **AC-9.** `acctPmtCSV`/`acctPmtJSON`/`acctFACSV`/`_aiExecTool('get_payments')` all include `purpose` and `currency` in their output, matching their Supplier Payment equivalents' field shape.
- **AC-10.** Full pre-existing-test-suite audit: every direct test-suite call site of `savePayment()`/`deletePayment()`/`getInvTotalPaid()` (the function this REQ removes) traced and either updated to the new `getInvTotalPaidNative()`/`getInvEffectiveDepInfo()` names or confirmed unaffected.

---

## 5. Testing approach

Mirrors the Supplier Payment ledger's own test coverage shape (currency-mixing cases, the `{value, source}` three-way branch, ledger-vs-legacy fallback) rather than inventing a new pattern. No `mockSb()`/Cloud Data harness involved at all — this REQ is entirely local-only (§0).

---

## 6. Gate process

Follows the same rigorous SDLC pipeline as the rest of this codebase's REQ series: REQ → independent requirements-gate review (Agent) → SPEC (exact diffs) → independent spec-gate review (Agent, applies diffs to a scratch copy, runs the real test suite) → implementation → self-directed mutation testing → independent build-gate review (Agent) → PR → CI green → merge → verify main consistent.

---

## 7. Tracker updates (at ship time)

- `docs/requirements-tracker.md` — new `REQ-INTEG-002 (2c)` row.
- `docs/known-gaps.md` — new entry logging NGN/GHS's FX-pivot gap (§3), cross-referenced to `PROC-GAP-002`.
- `docs/version-history.md`/`STACKD_CONTEXT.md`/`CLAUDE.md` — version bump, test count, a note on the new `getInvEffectiveDepInfo()`/`getInvTotalPaidNative()` pair mirroring the PO-side pattern.
- `docs/user-guide.md` — Payments section updated to describe the Purpose/Currency fields.

---

## 8. Review-resolution log

*(populated by requirements-gate)*
