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
