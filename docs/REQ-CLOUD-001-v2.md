# REQ-CLOUD-001-v2: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Supersedes:** REQ-CLOUD-001-v1 (independent requirements-gate CONDITIONAL PASS — four findings, all confirmed on re-verification, three blocking: (1) `delSup()`'s pre-delete warning counts are computed by matching local `DB.po`/`DB.li` records' `supId` field against a Supplier `id` — v1 never specified how every *existing* local record's `supId`/`buyerId` gets remapped from today's `uid()`-style ID to the new Supabase `uuid` at migration time; without that remap, the warning silently matches nothing post-migration. (2) REQ-CLOUD-001f/§4.1 claimed the DB unique-name constraint "backs up" an existing client-side dedup check in *both* `saveSup()` and `saveBuy()` — confirmed `vSup()` (`index.html:6284-6291`) has no duplicate-name check at all; only `saveBuy()` has one. For Suppliers this is a genuinely new constraint, not a backstop, with real migration consequences for any account that already has duplicate-named Suppliers saved. (3) §3.1/§3.2 describe operator-created accounts "not open signup" only in prose — no requirement or AC actually requires disabling Supabase's public sign-up endpoint, and the RLS policies as specified (`auth.role() = 'authenticated'`) grant full access to anyone who self-registers if that isn't explicitly closed, which defeats the access model entirely. Two advisory items: `BUY-ADHOC` has no `num` (`index.html:5326`), conflicting with the proposed `num not null` constraint; AC-002 tested two *different* records, not the same-record conflict `SEC-GAP-011` actually describes. All five resolved below.)

## Business Context

Unchanged from v1. The operator wants a second person able to add/edit basic Supplier and Buyer information without the app's single shared password and without the existing Sheets sync path's known limitations (`SEC-GAP-011`, `SEC-GAP-002`, and `BUY-GAP-001` — Buyers has no sync mapping and no CSV import at all). Chosen over Cloudflare D1/Turso because Supabase is the already-committed v3.0.0 target — this work is the first real slice of that migration, not a throwaway.

## Council Decision Required — unchanged from v1

Still crosses FM-1, still not covered by any of the three existing exceptions, still requires an explicit council/product-owner decision before spec-gate, not a self-granted exception.

## Scope

Unchanged from v1: Suppliers and Buyers only, everything else stays local, explicitly not v3.0.0.

---

## 1. Data Architecture

### 1.1 Conceptual model, 1.2 Logical model, 1.3 Sync model

Unchanged from v1 — table definitions, `uuid` primary key + preserved `num` business key, and the live-source-of-truth decision (option A over batch-sync option B) all independently re-verified as sound. **Confirmed accurate on this round:** the SQL columns are a genuinely faithful field-for-field mapping of `saveSup()`/`saveBuy()`'s real current shapes (re-checked against both functions directly), and the `'BUY' + Date.now()` / `BUY-ADHOC` sentinel claims are accurate (`index.html:5326`, `5348`).

**New: 1.4 Migration — ID remap is a first-class requirement, not an afterthought.** v1 acknowledged local FK fields (`Quote.lines[].supId`, `PO.supId`, `Invoice.buyerId`, etc.) "now hold a Supabase uuid instead of a local `uid()` string" but never specified the mechanism. This is corrected: the one-time migration that populates `suppliers`/`buyers` from an operator's existing `DB.sup`/`DB.buy` must produce an old-ID → new-`uuid` mapping table (transient, migration-time only, not a permanent structure), and **every existing local record referencing a Supplier/Buyer by the old ID must be rewritten to the new `uuid` in the same migration pass** — not left for the app to somehow reconcile at read time. This is what REQ-CLOUD-001d (below) actually requires to hold, not an implementation detail left to spec-gate.

---

## 2. Data Management Principles

**2.1–2.4 (Ownership, Retention/deletion, Backup/recovery, Audit trail)** — unchanged from v1, all independently re-verified.

**2.5 GDPR data flow.** Unchanged from v1.

---

## 3. Security

**3.1 Row Level Security.** Unchanged: RLS enabled on both tables, `authenticated`-role policies, no client-reachable delete grant.

**3.2 Auth strategy — corrected: closing public signup is now an explicit requirement, not a prose description of intent.** v1 said accounts are "operator-created... not open signup" but specified no mechanism to guarantee it. **Corrected: Supabase project settings must have public sign-up (`auth.signUp()` / the Auth UI's sign-up flow) disabled**, and new users created exclusively via the Supabase dashboard or an admin-invoked invite, not self-registration. Without this, the anon key being necessarily public (§3.3, by design) means anyone who obtains it can self-register and immediately satisfy `auth.role() = 'authenticated'` in every RLS policy in §3.1 — silently defeating the entire access model this REQ is built around. This is now REQ-CLOUD-001h, with its own AC.

**3.3 Key handling, 3.4 Transport.** Unchanged from v1, both independently re-verified (CSP's `connect-src https:` at `index.html:7` confirmed already permissive, no change needed).

---

## 4. Data Quality

**4.1 Constraints — corrected: the Supplier unique-name index is a *new* constraint, not a backstop, and this REQ owns saying so honestly.** v1 claimed the DB-layer unique index "backs up" existing client-side dedup checks in both `saveSup()`/`saveBuy()`. Verified: **`vSup()` (`index.html:6284-6291`) performs no duplicate-name check at all** — it only requires `name` be non-empty and validates email format. Only `saveBuy()` (`index.html:5437`) has the case-insensitive exact-match check. Corrected: for Buyers, the DB constraint genuinely is a backstop to an existing rule. **For Suppliers, this REQ introduces a materially new constraint that did not exist before** — meaning any operator's existing `localStorage` data that happens to contain duplicate-named Suppliers (never previously blocked) will fail to migrate cleanly. REQ-CLOUD-001f is corrected to require the migration step (§1.4) include a pre-flight duplicate-name check against existing local Supplier data, surfacing any conflicts to the operator for manual resolution *before* the unique index is created — not discovered as a failed migration with no diagnostic.

**4.2 Referential integrity to local entities.** Unchanged in substance, now correctly load-bearing on §1.4's migration requirement rather than a standalone accepted limitation.

---

## 5. Scalability

Unchanged from v1.

---

## Requirements

**REQ-CLOUD-001a–REQ-CLOUD-001c, REQ-CLOUD-001e, REQ-CLOUD-001g:** Unchanged from v1.

**REQ-CLOUD-001d (corrected):** Deletion is soft (`deleted_at`). `delSup()`'s existing pre-delete warning behavior for linked-record counts is preserved **only if** the §1.4 migration requirement is satisfied first — this REQ makes that dependency explicit rather than assuming it away. A Buyer-side equivalent warning (if one exists — to be confirmed at spec-gate against the actual current Buyer-delete function) is subject to the same dependency.

**REQ-CLOUD-001f (corrected):** A case-insensitive unique constraint on `name` exists at the DB layer for both tables. For Buyers, this backs up the existing `saveBuy()` client-side check. **For Suppliers, this is a new constraint** — migration must include a pre-flight duplicate-name scan against existing local data, with conflicts surfaced to the operator for resolution before the constraint is created, not discovered as an opaque migration failure.

**REQ-CLOUD-001h (new):** Supabase project-level public sign-up is disabled before this feature goes live. New user accounts are created exclusively via the Supabase dashboard or an equivalent admin-only invite mechanism — never via a self-service sign-up form or API call reachable with only the (necessarily public) anon key.

**REQ-CLOUD-001i (new):** The one-time migration produces an explicit old-ID → new-`uuid` mapping and rewrites every existing local record's `supId`/`buyerId`-shaped reference fields in the same pass — not deferred, not left for read-time reconciliation (§1.4).

## Acceptance Criteria

- AC-001 through AC-003, AC-005: unchanged from v1.
- AC-002 (corrected): **the same** Supplier record, edited by two authenticated sessions within the same short window, either serializes correctly (last write wins at the DB transaction level, with both writes actually applied in sequence, not one silently dropped) or surfaces a detectable conflict — not two different records, which proves nothing about `SEC-GAP-011`'s actual failure mode (same-record silent overwrite).
- AC-004: `delSup()`'s linked-PO/invoice warning dialog shows accurate counts against Supabase-sourced Supplier data **after** a migration that included the §1.4 ID remap — tested specifically against a fixture containing pre-migration local PO/Invoice records with old-style `supId` values, confirming the remap actually happened, not just that the warning logic itself is unchanged.
- AC-006 (new): with Supabase project sign-up left enabled (a misconfiguration test), a freshly self-registered account can read/write Supplier/Buyer data — this AC is expected to **fail** once REQ-CLOUD-001h is correctly implemented (sign-up disabled), proving the fix actually closes the gap rather than just documenting intent.
- AC-007 (new): migrating a fixture containing two existing Suppliers with the same name (differently-cased) surfaces a pre-flight conflict to the operator rather than silently failing partway through the unique-index creation.

## Open Questions for Req-Gate / Council Decision

1–3, 5: unchanged from v1 (the council decision itself, region/DPA confirmation, RLS granularity, offline/cache behavior).
4. **`BUY-ADHOC` migration — sharpened, not just flagged.** Confirmed `seedAdHocBuyer()` (`index.html:5326`) creates `BUY-ADHOC` with no `num` field at all — this directly conflicts with REQ-CLOUD-001-v1's proposed `num not null` constraint (§1.2), not just a loose "needs a decision" note. Two concrete resolutions for spec-gate to choose between: (a) assign `BUY-ADHOC` a real `num` during migration (e.g. `BUY-0000` or similar reserved value, consistent with how the existing friendly-reference-number system already treats other sentinel/legacy records), or (b) keep it a local-only, non-Supabase-migrated concept. This REQ does not decide between them, but no longer leaves the schema conflict unstated.
