# REQ-CLOUD-001-v3: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Supersedes:** REQ-CLOUD-001-v2 (independent requirements-gate CONDITIONAL PASS on v1, resolved in v2 — see v2's own Supersedes note). **This version records the council decision v1/v2 required, and adds the condition it was given under.**

## Council Decision — RECORDED

**Decision: APPROVED.** The product owner has explicitly approved crossing FM-1 for this bounded scope (Suppliers + Buyers only, not the rest of the app, not full v3.0.0), on one stated condition: **existing data must be backed up such that a rollback is possible if the migration needs to be undone.** That condition is not a soft preference — it is now a first-class requirement of this REQ (REQ-CLOUD-001j–l, below), not left to spec-gate to infer.

This decision is recorded here, in the tracker, and should be treated as durable — it does not need re-litigating in future rounds of this REQ unless scope changes materially.

## Business Context, Scope

Unchanged from v2.

---

## 1. Data Architecture

Unchanged from v2 (§1.1–1.4, including the ID-remap migration requirement).

**New: 1.5 Rollback design principle.** The migration (§1.4) must be structured so that undoing it — abandoning Supabase and returning to pure-`localStorage` operation for Suppliers/Buyers — is possible with zero data loss, at two independent layers of protection, not one:

1. **Code-level:** this feature ships as a version bump like every other REQ in this repo (a new `index.html` commit). If the Supabase approach needs to be abandoned after the fact, redeploying the prior `index.html` version is already how this repo's git history works — no special mechanism is required for this layer, but the *data* layer (below) has to actually cooperate with that rollback, not silently assume it forward.
2. **Data-level:** the migration must not destructively overwrite or delete the pre-migration local `DB.sup`/`DB.buy` arrays, or the pre-migration values of `supId`/`buyerId`-shaped fields on other local records, until the operator has explicitly confirmed the Supabase-backed version is working correctly. A code-level rollback to the prior `index.html` is worthless if the data it expects to find has already been mutated in place with no way back.

---

## 2. Data Management Principles

Unchanged from v2 (§2.1–2.5), now explicitly reinforced by §1.5 and the new requirements below rather than standing alone.

---

## 3. Security

Unchanged from v2 (§3.1–3.4).

---

## 4. Data Quality

Unchanged from v2 (§4.1–4.2).

---

## 5. Scalability

Unchanged from v2.

---

## 6. Pre-Migration Backup & Rollback (new section — the condition the council decision was approved under)

**6.1 Reuse the existing mechanism, don't invent a new one.** `expAll()` (`index.html:8386` onward) already exports `sup`/`buy` (and every other entity) into a single JSON snapshot — this is the same mechanism `docs/dr-procedure.md` already documents as the operator's sole recovery path, and it needs no new export logic built for this REQ.

**6.2 The backup must be mandatory and blocking, not an optional step the operator might skip.** Matching the existing precedent for exactly this kind of "don't let the operator proceed without this" moment — `showQuotaModal()`'s blocking "Export Backup Now" pattern (`BACKUP-GAP-002`) — migration must not proceed until a fresh `expAll()` export has actually been triggered and the operator has confirmed it downloaded successfully. Not a dismissible reminder; a blocking step, the same UX weight the existing quota-exceeded flow already gives an equivalent risk.

**6.3 The pre-migration local data is not deleted or overwritten until Supabase is confirmed working.** Per §1.5, the migration writes Suppliers/Buyers *to* Supabase and performs the ID-remap (§1.4/REQ-CLOUD-001i) on local reference fields, but the original pre-migration `DB.sup`/`DB.buy` arrays themselves are retained locally (e.g. under a clearly-marked archival key, not the live `K.s`/`K.bu` keys the app reads from day-to-day) for a defined grace period after cutover — not immediately purged. This means the belt-and-braces JSON backup (§6.2) is the fallback for the worst case (e.g. `localStorage` itself gets cleared), while the archived local arrays are the fast, first-line rollback path for the much more likely case (the operator wants to undo this shortly after migrating, before anything else has changed).

**6.4 The rollback procedure is documented, not assumed.** `docs/dr-procedure.md` is extended with an explicit "Rolling back the Supabase migration" section: redeploy the pre-migration `index.html` version; if the archived local arrays (§6.3) are still present, they resume being read immediately; if not (grace period expired, or `localStorage` itself was cleared), restore the §6.2 JSON backup via the existing `doImport()` path. This is a documentation deliverable of this REQ, not an implied byproduct of the other requirements.

## Requirements

**REQ-CLOUD-001a–REQ-CLOUD-001i:** Unchanged from v2.

**REQ-CLOUD-001j (new):** A fresh, confirmed-successful `expAll()` export is mandatory and blocking before migration proceeds — matching the existing `showQuotaModal()` UX pattern, not a dismissible reminder (§6.2).

**REQ-CLOUD-001k (new):** The migration retains the pre-migration local `DB.sup`/`DB.buy` arrays under an archival key for a defined grace period post-cutover, rather than deleting or overwriting them immediately (§6.3). Exact grace period length is a spec-gate decision, not fixed here.

**REQ-CLOUD-001l (new):** `docs/dr-procedure.md` gains an explicit rollback section covering both the code-level revert and the data-level restore path, written and merged as part of this REQ's delivery — not deferred to a future documentation pass (§6.4).

## Acceptance Criteria

- AC-001 through AC-007: unchanged from v2.
- AC-008 (new): attempting to proceed past the migration's backup step without a confirmed successful `expAll()` export is blocked — the migration cannot start, matching the blocking (not dismissible) behavior required by REQ-CLOUD-001j.
- AC-009 (new): immediately after a successful migration, deleting/corrupting the newly-created Supabase tables (simulated) and redeploying the pre-migration `index.html` restores full Supplier/Buyer functionality from the still-present archived local arrays — no JSON import needed, proving the fast first-line rollback path in REQ-CLOUD-001k actually works, not just exists in the data.
- AC-010 (new): with the archival grace period expired (simulated) and the archived local arrays removed, restoring the §6.2 JSON backup via `doImport()` against the pre-migration `index.html` version fully recovers Supplier/Buyer state byte-for-byte — proving the slower, second-line rollback path also actually works.

## Open Questions for Spec-Gate

1–5 (from v2, renumbered): region/DPA confirmation, RLS granularity, `BUY-ADHOC` migration resolution, offline/cache behavior — unchanged from v2. (The former Open Question 1, "the council decision itself," is now resolved — see Council Decision above — and removed from this list.)
6. **(New)** Exact grace-period length for REQ-CLOUD-001k's archived local arrays — long enough to catch a "this isn't working" decision made a few days in, short enough not to leave two copies of the same data drifting indefinitely. A specific number (e.g. 30 days) is a spec-gate call, not fixed here.
