# REQ-V3-GAP-006 v3 — Supplier → Contact Sub-panel

**Status:** Awaiting gate PASS  
**FM-1:** Approved — field additions to existing entity (`DB.con`). See STACKD_CONTEXT.md FM-1 exception item 2.  
**Version target:** v2.9.29 (after REQ-002 / v2.9.28)

---

## Business need

Supplier records have a free-text `ct` contact person field but no link to `DB.con`. FPM needs to track named individuals at suppliers through the CRM pipeline and see all contacts per supplier in one place.

---

## Behaviour

1. `DB.con` records gain two new optional fields: `supplierId` (string | null, FK to `DB.sup.id`) and `role` (`'buyer_contact' | 'supplier_contact' | ''`). Default for both is `null` / `''` on all existing and independently-created contacts — always optional.

2. Supplier edit modal (`ov-sup`) gains a read-only "Contacts" section below existing fields — table of `DB.con` records where `c.supplierId === sup.id`. Columns: Name, Email, Status, Unlink. Hidden on new-supplier form (only shown when `EI.s` is set).

3. **Unlink** nulls `supplierId` and clears `role` to `''` on the contact record, then saves. Does not delete the contact.

4. "+ Link Contact" picker lists `DB.con` where `supplierId` is null or already equals this supplier's ID. Contacts linked to a different supplier are excluded (`supplierId` is scalar — one supplier per contact). Selecting a contact sets `c.supplierId = sup.id`, `c.role = 'supplier_contact'`, saves.

5. "+ New Contact" shortcut creates a new contact with `supplierId` pre-set to the current supplier's ID and `role: 'supplier_contact'`, then opens the contact modal pre-populated. If the operator clears the Supplier dropdown before saving in that modal, `supplierId` is null and `role` is `''` on save.

6. Contact edit modal gains a "Supplier" field — dropdown from `DB.sup` with a blank "None" option at top. Selecting a supplier sets `supplierId` and auto-sets `role: 'supplier_contact'`. Selecting "None" nulls `supplierId` and clears `role` to `''`.

7. Contacts list table gains a "Supplier" column showing linked supplier name via `gsn(c.supplierId)` or `—`.

8. `delSup(id)` nulls `supplierId` and clears `role` to `''` on all `DB.con` records where `c.supplierId === id` before removing the supplier. Contacts are preserved.

9. Event log emission on `delCon()` is **deferred** — dependent on REQ-V3-GAP-007 (`DB.events`) shipping first. `delCon()` gains no event emission in this version.

---

## Sheets sync

`supplierId` and `role` are not in `FIELD_MAPS.co` — silently omitted from sync payloads by the existing `mapRec()` mechanism. No change required. Accepted in v1; Sheets sync of these fields deferred.

---

## GDPR

`supplierId` and `role` are operational linkage fields containing no personal data. Processing purpose (managing supplier relationships) is covered by existing Art.6(1)(f) legitimate interests basis. No new GDPR basis required.

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Supplier with two linked contacts | Supplier modal opened in edit mode | Contacts section shows both; section hidden on new-supplier form |
| AC-2 | Contact A has `supplierId` set to Supplier X | Unlink clicked on Contact A in Supplier X sub-panel | `supplierId` is null, `role` is `''`, contact remains in `DB.con` |
| AC-3 | Contact B linked to Supplier X | Picker opened on Supplier Y | Contact B absent from picker |
| AC-4 | New contact created independently via `openCon()` | Contact saved | `supplierId` is null, `role` is `''` |
| AC-5 | Supplier X deleted | `delSup()` completes | All contacts with `supplierId === X.id` have `supplierId` nulled; contacts remain in `DB.con` |
| AC-6 | Contact linked via supplier sub-panel | Contact saved | `supplierId` matches supplier ID, `role === 'supplier_contact'` |
| AC-7 | Contact with `supplierId` set | Contacts list rendered | Supplier name shown in Supplier column via `gsn()` |
| AC-8 | "+ New Contact" opened from Supplier X, operator clears Supplier dropdown | Contact saved | `supplierId` is null, `role` is `''` |
