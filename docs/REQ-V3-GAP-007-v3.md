# REQ-V3-GAP-007 v3 — Global Event Log (`DB.events`)

**Status:** Awaiting gate PASS  
**FM-1:** Approved — new internal-only `K` key and `DB` entity, no Sheets sync. See STACKD_CONTEXT.md FM-1 exception item 3.  
**Version target:** v2.9.28

---

## Business need

No per-entity activity history exists. Operators cannot see what happened to a contact or supplier over time — status changes, linked quotes, link/unlink actions are invisible after they occur.

---

## Behaviour

1. New entity: `K.ev = 'st_ev'`, `DB.events = []`. Wired into `saveAll()`, `expAll()` (as `events: DB.events`), `doImport()` (`DB.events = Array.isArray(data.events) ? data.events : []`). No top-level view tab. No Sheets sync (`FIELD_MAPS` has no `ev` entry). `tests/run.js` `resetDB()` updated to include `events: []` — explicit in-scope delivery item.

2. Event record shape:
```js
{
  id:         uid(),
  ts:         new Date().toISOString(),
  entityType: 'contact' | 'supplier' | 'quote' | 'po' | 'invoice' | 'shipment',
  entityId:   string,
  verb:       'created' | 'updated' | 'status_changed' | 'linked' | 'unlinked' | 'converted' | 'note_added' | 'deleted',
  summary:    string,
  actor:      'user' | 'system'
}
```

3. `logEv(entityType, entityId, verb, summary, actor)` helper — pushes to `DB.events`, calls `sv(K.ev, DB.events)` (targeted write, not `saveAll()`). `actor` defaults to `'user'` if omitted. If `verb` is not in the defined enum, it is accepted as-is (no throw, no drop) — out-of-enum values are permissible for forward compatibility and will simply render as-supplied in the activity accordion.

4. **`actor` rules:**
   - `'user'` — emitted from functions triggered directly by an operator `onclick` (e.g. `saveCon()`, `delCon()`).
   - `'system'` — emitted from functions called programmatically without a direct user click on the triggering event (e.g. `saveQte()` updating contact status via `cConvertId`).

5. **Emission points (v1 scope):**
   - `saveCon()` new record → `logEv('contact', id, 'created', 'Contact created', 'user')`
   - `saveCon()` edit, status changed → `logEv('contact', id, 'status_changed', 'Status changed to ' + status, 'user')`
   - `saveCon()` edit, enquiry note added → `logEv('contact', id, 'note_added', 'Enquiry note added', 'user')`
   - `saveCon()` edit, no status/note change → `logEv('contact', id, 'updated', 'Contact details updated', 'user')`
   - `delCon()` → `logEv('contact', id, 'deleted', 'Contact deleted', 'user')`
   - `saveQte()` when `cConvertId` is set → `logEv('contact', cConvertId, 'converted', 'Quote ' + qt.num + ' created — contact converted', 'system')`

6. **`summary` field format:** Plain operational text using record numbers/IDs, not personal names (e.g. `'Quote QT-0012 created — contact converted'`, not `'Jane Smith converted'`). `DB.events` contains no personal data under this constraint.

7. **GDPR:** `entityId` values are contact IDs — combined with `DB.con`, the event log creates an indirect link to personal data (contact identity recoverable by join). This is covered by existing Art.6(1)(f) legitimate interests basis for operating the portal. No new GDPR basis required. The Settings GDPR disclosure note (currently covers Sheets sync and forwarder webhook) is updated in this version to reference the event log and its 2,000-event FIFO retention policy.

8. **Retention cap:** Hard cap of 2,000 events (FIFO). `logEv()` trims `DB.events` to the last 2,000 entries after push before persisting. Logged as EVT-GAP-001. At ~200 bytes/event, 2,000 events ≈ 400 KB — well within the `checkStorageQuota()` 75% warning threshold.

9. **Activity accordion — Contact modal:** An "Activity" section appended below the notes field in `ov-con`. Collapsed by default (click header to toggle). Renders all `DB.events` where `e.entityId === EI.co`, sorted newest-first, max 50 entries rendered. Each row: `[ts.slice(0,10)] verb — summary`. Empty state text: `"No activity recorded."`.

10. **Activity accordion — Supplier modal:** Same pattern in `ov-sup`, filtering `e.entityId === EI.s`. In v1, no supplier-entity events are emitted, so this accordion will always show the empty state — this is **intentional scaffolding** for emission points added in REQ-V3-GAP-006 (v2.9.29). The accordion is present and functional; it is not hidden.

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | Empty DB | `saveCon()` creates new contact | `DB.events` has one entry: `verb==='created'`, `entityType==='contact'`, `entityId===con.id`, `actor==='user'` |
| AC-2 | Existing contact, status changed | `saveCon()` saves | Event with `verb==='status_changed'` and summary containing new status present |
| AC-3 | `saveQte()` called with `cConvertId` set | Quote saved | Event on contact: `verb==='converted'`, `actor==='system'`, summary contains quote number |
| AC-4 | 2,001 events in `DB.events` | `logEv()` called | `DB.events.length === 2000` (oldest entry trimmed) |
| AC-5 | Contact with 3 events | Contact modal opened, Activity section toggled | 3 entries shown, newest first |
| AC-6 | Contact with no events | Activity section toggled | `"No activity recorded."` shown |
| AC-7 | `expAll()` called | — | Exported JSON contains `events` array |
| AC-8 | Backup with `events` array imported | `doImport()` called | `DB.events` populated from backup data |
| AC-9 | `resetDB()` called in test harness | — | `Array.isArray(ctx.DB.events) && ctx.DB.events.length === 0` |
| AC-10 | Supplier modal opened in edit mode | Activity section toggled | `"No activity recorded."` shown (no supplier events emitted in v1 — intentional) |
