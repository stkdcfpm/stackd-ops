# Disaster Recovery Procedure — Stackd Ops

**Last tested:** 2026-06-06  
**Applies to:** v2.9.23+  
**Audience:** Operators

---

## What this covers

Stackd Ops stores all data in browser `localStorage`. There is no server-side persistence. This means:

- Clearing browser site data wipes everything
- Using a different browser profile starts fresh
- Device failure or OS reinstall = data gone

The **JSON backup** (Settings → Data → Export All) is the only recovery mechanism. This document tells you how to use it.

---

## How to take a backup

1. Open Stackd Ops
2. Go to **Settings → Data**
3. Click **↓ Backup All JSON**
4. A file named `Stackd-Backup-YYYY-MM-DD.json` downloads automatically
5. Move it somewhere safe — cloud storage (Google Drive, Dropbox), not just the Downloads folder

**What the backup contains:**
- All invoices, POs, shipments, payments, suppliers, line items, quotes
- Settings (sync URL, preferences)
- Company branding (name, address, logo, VAT, colours)
- FX and freight rates (QR)
- Custom ports, custom payment terms, custom UOM
- Migration flags (prevents data repair running twice)

**What it does NOT contain:**
- Your Anthropic AI API key — re-enter this after restore in Settings → AI Assistant
- The Apps Script sync token — already stored in the portal settings object, but verify Test Connection after restore

**When to take a backup:**
- After any significant data entry session (new invoices, POs, shipments)
- Before clearing your browser or switching devices
- Weekly minimum during active use

---

## How to restore from a backup

> **Warning: restore replaces all current local data. There is no undo.**

1. Open Stackd Ops on the target browser/device
2. Go to **Settings → Data**
3. Click **↑ Restore from JSON**
4. Select your `.json` backup file
5. A confirmation dialog shows record counts from the file — verify they look right
6. Click **OK** to proceed
7. The page reloads with restored data

**After restore — verify:**
- [ ] Dashboard shows expected invoice count and KPI figures
- [ ] Settings → Google Sheets → Test Connection → ✓ Connected
- [ ] Settings → AI Assistant → re-enter API key if needed
- [ ] Spot-check one invoice PDF renders correctly
- [ ] If you use custom ports/payment terms, confirm they appear in dropdowns

---

## Recovery scenarios

### Browser data cleared accidentally
1. Source your most recent backup file
2. Follow the restore procedure above
3. If the backup is more than a day old, check Sheets sync for any records added since — pull from Sheets to recover them

### Device failure / new device
1. Install a modern browser (Chrome or Firefox recommended)
2. Open the Stackd Ops URL
3. Follow the restore procedure above
4. Re-enter AI API key in Settings → AI Assistant
5. Verify Sheets sync Test Connection passes

### Accidental data deletion (single record)
The JSON backup is a full snapshot — there is no partial record restore. Options:
- If Sheets sync is configured and the record was pushed before deletion, pull from Sheets to recover it
- Otherwise restore from the most recent backup, then re-enter any data added after that backup

### Corrupt localStorage (app won't load)
Open browser DevTools → Application → Local Storage → delete all `st_` keys → reload → restore from backup.

---

## Backup schedule recommendation

| Frequency | Trigger |
|---|---|
| After every session | Any session with new invoices, POs, or payments |
| Weekly | Even if no changes — belt and braces |
| Before any browser update or device change | Preventive |

---

## Known limitations

- No automatic backup — export must be triggered manually
- No incremental backup — every export is a full snapshot
- Backup file must be stored externally by the operator — the app cannot access the local filesystem automatically
- If two operators both restore from different backups, their data diverges silently — coordinate restores with all operators

See `docs/known-gaps.md` BACKUP-GAP-001 and BACKUP-GAP-002 for the formal gap register entries.
