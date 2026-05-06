# Known Gaps — Post-Pilot Review

Items deferred from initial build. Review after pilot period before wider rollout.

---

## Quote Engine

### QTE-GAP-001 — No quote status workflow enforcement
**Area:** Quotes → status field / Convert to PO button  
**Logged:** v2.9.4  
**Detail:** The quote status field (`Draft → Sent → Accepted → Declined / Expired`) is a free select with no transition guards. The Convert to PO button is available on any status (only blocked if a PO is already linked). No validation prevents advancing to a later status without prerequisite data being present (e.g. no check that all lines have CBM before a freight-stage status could be set).  
**Options for post-pilot:**
- Restrict Convert to PO to `Accepted` status only
- Add a `Freight Confirmed` status that requires CBM > 0 on all lines before it can be set
- Add a `Locked` read-only state that prevents further edits once a PO is raised
- Full FSM (finite state machine) with allowed transition map  
**Decision:** No enforcement needed at pilot stage. Revisit after real-world quote flow is understood.

---

## Library (Line Items)

### LIB-GAP-001 — `syncEnt('li')` not called on `invoiceRefs` mutation
**Area:** Library → `saveInv()` / `delInv()` — `invoiceRefs` field on `DB.li` records  
**Logged:** v2.9.7  
**Detail:** When `saveInv()` or `delInv()` mutates `invoiceRefs` on library catalogue records, it calls `sv(K.l, DB.li)` (localStorage write) but does not call `syncEnt('li', ...)` (remote Sheets push). This means the remote copy of the library will lag behind until the next explicit library save or next full sync. Acceptable at pilot stage because `invoiceRefs` is a derived index (fully recoverable from invoice data) and remote sync is not the primary persistence path.  
**Options for post-pilot:**
- Call `syncEnt('li', ...)` after each `invoiceRefs` mutation in `saveInv()` / `delInv()`
- Add a reconcile pass in the sync pull to rebuild `invoiceRefs` from pulled invoice data  
**Decision:** Deferred. The index is local-first; stale remote copy has no operational impact at current scale.
