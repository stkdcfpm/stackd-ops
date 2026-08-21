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

> **⚠️ NEVER store backup files in this repository.** The repo is publicly served via GitHub Pages at app.getstackdops.com — any committed backup exposes live supplier/buyer PII and financials to the public internet (see SEC-GAP-020). Store backups in a private location: local disk, personal Google Drive, or encrypted storage. A `.gitignore` guard blocks `Stackd-Backup-*.json` but do not rely on it alone.


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

## Rolling back the Supabase migration (Suppliers & Buyers)

If the Supabase-backed Suppliers/Buyers feature (REQ/SPEC-CLOUD-001) needs to be undone:

1. **Fast path — code rollback (within 30 days of migration):** redeploy the `index.html` version from immediately before this feature's release. `st_s`/`st_bu` (the live, continuously-synced local keys) already hold the most recent cloud-mirrored data, so the prior app version reads current data immediately — no re-entry needed, no dependency on the archive.
2. **Fast path — data-only rollback (within 30 days of migration):** if the migration itself produced bad Supplier/Buyer data (not a reason to abandon the feature permanently, just to undo one migration run), use Settings → Cloud Data → "Restore Pre-Migration Suppliers/Buyers" (`restoreFromMigrationArchive()`). This restores `DB.sup`/`DB.buy` only — Quotes/POs/Line Items/Contacts/Invoices keep their current (already-remapped) references — and disconnects Cloud Data so the restored local data isn't immediately overwritten again by the next background refresh. Reconnect via Settings → Cloud Data (re-entering the Supabase URL/key) once the underlying Supabase data issue is resolved.
3. **Slow path (after the 30-day archive window, or if `localStorage` was cleared):** redeploy the pre-migration `index.html` version, then restore your most recent JSON backup (Settings → Data → Export All, or the mandatory pre-migration backup taken during setup) via Settings → Data → Import.
4. **If migration failed partway through** (some Suppliers/Buyers inserted into Supabase, some not — the app shows an error toast naming the record it stopped on): local data was never modified. In the Supabase dashboard, delete the partially-inserted rows from the `suppliers`/`buyers` tables (a fresh migration run is not safe to re-run over a partial one — it will duplicate the already-succeeded inserts), then retry "Migrate Suppliers/Buyers to Cloud" from a clean table.
5. In all cases, the Supabase project itself can be left in place or deleted at your discretion once the prior `index.html` version (or the restored local data) is in use.

---

## Known limitations

- No automatic backup — export must be triggered manually
- No incremental backup — every export is a full snapshot
- Backup file must be stored externally by the operator — the app cannot access the local filesystem automatically
- If two operators both restore from different backups, their data diverges silently — coordinate restores with all operators

See `docs/known-gaps.md` BACKUP-GAP-001 and BACKUP-GAP-002 for the formal gap register entries.
