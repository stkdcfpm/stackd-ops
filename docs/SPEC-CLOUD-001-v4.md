# SPEC-CLOUD-001-v4: Supabase-Backed Shared Data Layer for Suppliers & Buyers

**Implements:** REQ-CLOUD-001-v3 (council decision APPROVED, formalized in that file's Council Decision section).

**Supersedes:** SPEC-CLOUD-001-v3 (independent spec-gate FAIL, round 3 — 1 new blocking finding, verified against live `index.html` on branch `claude/spec-cloud-001-supabase-build`; v3's own 5 blocking + 2 advisory fixes were all independently confirmed correct). The one new defect:

1. **`restoreFromMigrationArchive()` doesn't durably restore anything while Supabase stays configured.** v3's function overwrote the local `st_s`/`st_bu` keys from the archive and reloaded, but left `SS.supabaseUrl`/`SS.supabaseAnonKey` untouched. On reload, `initApp()` still fires `initCloudDataLayer()` fire-and-forget (per v3's own §4 fix); if a Supabase session is already cached — the normal case — the background refresh re-pulls from Supabase within about one round-trip and silently overwrites the just-restored local data right back to whatever is still in the Supabase tables. Since this function's entire documented purpose is "the migration produced bad data, undo it," and the Supabase tables still hold that same bad data after a restore, the restore is invisible in practice: it's clobbered before an operator would typically notice it happened. This directly undercuts REQ-CLOUD-001-v3's Council Decision, which conditions approval on a working rollback path. §6 below fixes this by having the restore also disconnect Cloud Data.

Also fixes four advisory notes from the same review: `cleanupExpiredMigrationArchive()`'s call-site position wasn't restated after v3 rewrote the `initApp()` snippet around it; `saveBuy()` was described as "mirrors `saveSup()`'s shape exactly" when the two functions actually differ (a duplicate-name check exists in `saveBuy()`, no `audit()` call, unlike `saveSup()`) — now written out in full to remove the ambiguity; and a trivial `DB.bu`/`DB.buy` typo in the test plan. (Two further advisory notes from the same review — a stale `expAll()` line citation and a `showQuotaModal()` mischaracterization, both in `REQ-CLOUD-001-v3.md` itself rather than in this spec — are pre-existing REQ-doc issues this spec already correctly works around; not fixed here, as they don't affect implementability of this spec.)

## 0. Design decisions — unchanged from v3

Vendoring, config storage, `BUY-ADHOC` handling, and the fire-and-forget cloud-refresh timing (§0.3 of v3) all stand — none of this round's findings touch them.

## 1–3. Vendored client, SQL migration, Settings card

Unchanged from v1/v2/v3.

## 4. Client initialization and background refresh — unchanged, with one clarification restored

Unchanged from v3's `initSbClient()`/`ensureSbAuth()`/`initCloudDataLayer()` and the `initApp()` wiring (fire-and-forget `initCloudDataLayer()` right after `renderAll()`, mirroring the real `pullAll()` precedent at `index.html:10234`). **Restoring v2's explicit wiring position for `cleanupExpiredMigrationArchive()`**, which v3's rewritten snippet dropped without saying where it now belongs:

```js
runFPMMigration(); // existing call, unchanged
repairCalcFields(); // existing call, unchanged
seedAdHocBuyer();   // existing call, unchanged
// ...existing backfill* calls, unchanged...
cleanupExpiredMigrationArchive(); // new — one-time check, order-insensitive relative to the calls above/below it
renderAll();
initCloudDataLayer().catch(function(){}); // fire-and-forget, unchanged from v3
checkOnboarding();
// ...rest of initApp(), unchanged
```

`cleanupExpiredMigrationArchive()`'s own body is unchanged from v2/v3 — this is purely restating where it's called from, since it's timing-insensitive (a pure date check against a timestamp) and was never actually ambiguous in behavior, only in the rewritten snippet's presentation.

## 5. CRUD changes — Suppliers and Buyers

**`refreshSupFromSupabase()`, `refreshBuyFromSupabase()`, `saveSup()`, `delSup()`, `delBuy()`, `quickAddBuyer()`** — all unchanged from v3, independently confirmed accurate against live code this round.

**`saveBuy()` — now written out in full**, replacing v1/v2/v3's "mirrors `saveSup()`'s shape exactly," which overstated the similarity (the real `saveBuy()`, `index.html:5443-5471`, has an inline case-insensitive duplicate-name check that `saveSup()` doesn't, and no `audit()` call, unlike `saveSup()`'s):

```js
async function saveBuy() {
  var name = G('buy-name').value.trim();
  if (!name) { vErr('buy-name', 'Company name is required'); return; }
  var dup = DB.buy.find(function(b){ return b.name.trim().toLowerCase() === name.toLowerCase() && b.id !== EI.bu; });
  if (dup) { vErr('buy-name', 'A buyer with this name already exists'); return; }
  vOk('buy-name');
  if (!(await ensureSbAuth())) return;
  var row = { name: name, contact_name: G('buy-cname').value.trim(), email: G('buy-email').value.trim(), phone: G('buy-phone').value.trim(),
    address: G('buy-addr').value.trim(), currency: G('buy-cur').value, payment_terms: G('buy-pt').value,
    credit_limit: G('buy-cl').value !== '' ? parseFloat(G('buy-cl').value) : null, notes: G('buy-notes').value.trim() };
  var result;
  if (EI.bu) {
    result = await _sb.from('buyers').update(row).eq('id', EI.bu).select().single();
  } else {
    row.num = nextRefNum(DB.buy, 'BUY');
    result = await _sb.from('buyers').insert(row).select().single();
  }
  if (result.error) { toast('Save failed: ' + result.error.message); return; }
  logEv('buyer', result.data.id, EI.bu ? 'updated' : 'created', 'Buyer ' + result.data.name + (EI.bu ? ' updated' : ' created'), 'operator');
  await refreshBuyFromSupabase();
  closeM('ov-buy');
  toast('Buyer saved');
}
```

The duplicate-name check runs client-side against local `DB.buy` before any Supabase call, exactly as it does today — REQ-CLOUD-001f requires this existing backstop preserved, and writing the function out in full (rather than "mirrors exactly") removes any risk of an implementer dropping it while converting `saveSup()`'s pattern over. No `audit()` call is added, matching the real `saveBuy()`'s current behavior (`saveSup()`'s `audit()` call is pre-existing and unrelated to this conversion — not something to newly add to Buyers).

**`editSup(id)`/`openSup()`** — unchanged, as in v1/v2/v3.

## 6. Migration and rollback — `restoreFromMigrationArchive()` corrected

`migrateSuppliersBuyersToSupabase()` and `showBlockingBackupModal()` are unchanged from v2/v3 — both stood up to this round's independent re-check with no new findings.

**`restoreFromMigrationArchive()` — corrected to also disconnect Cloud Data, so the restore actually holds:**

```js
function restoreFromMigrationArchive() {
  var archS = localStorage.getItem('st_s_pre_migration'), archB = localStorage.getItem('st_bu_pre_migration');
  if (!archS || !archB) { toast('No migration archive available to restore.'); return; }
  if (!confirm('Restore Suppliers and Buyers to their state immediately before the Supabase migration, and disconnect Cloud Data?\n\nThis does not affect Quotes, POs, Line Items, Invoices, or Contacts, which keep their current (remapped) references. Cloud Data (Supabase) will be disconnected — re-enter your Supabase URL/key in Settings → Cloud Data if you want to reconnect later.')) return;
  localStorage.setItem(K.s, archS);
  localStorage.setItem(K.bu, archB);
  SS.supabaseUrl = ''; SS.supabaseAnonKey = '';
  sv(K.ss, SS);
  toast('Restored and disconnected from Cloud Data. Reloading…');
  setTimeout(function(){ location.reload(); }, 1200);
}
```

Without clearing `SS.supabaseUrl`/`supabaseAnonKey`, `initCloudDataLayer()` would fire on the very next reload (per §4's fire-and-forget wiring) and — with a session typically still cached — re-pull from Supabase within about one round-trip, silently overwriting the just-restored local data with whatever the Supabase tables still hold. Since this function's entire purpose is undoing bad *migration* data, and the Supabase tables still contain that same bad data, restoring only the local cache while staying connected can never hold. Disconnecting is not a side-effect to minimize — it's the only way this rollback path is actually real, matching this feature's own architecture decision that Supabase, not the local cache, is the authoritative source of truth once connected (REQ-CLOUD-001-v2 §1, unchanged in v3).

## 7. `docs/dr-procedure.md` — updated

Same as v3's §7, with step 2's wording corrected to reflect the disconnect:

```markdown
2. **Fast path — data-only rollback (within 30 days of migration):** if the migration itself produced bad Supplier/Buyer data (not a reason to abandon the feature permanently, just to undo one migration run), use Settings → Cloud Data → "Restore pre-migration Suppliers/Buyers" (`restoreFromMigrationArchive()`). This restores `DB.sup`/`DB.buy` only — Quotes/POs/Line Items/Contacts/Invoices keep their current (already-remapped) references — and disconnects Cloud Data so the restored local data isn't immediately overwritten again by the next background refresh. Reconnect via Settings → Cloud Data (re-entering the Supabase URL/key) once the underlying Supabase data issue is resolved.
```

Steps 1, 3, 4, 5 unchanged from v3.

## GDPR Data Flow

Unchanged from v1/v2/v3.

## 8. Test Plan (`tests/run.js`)

Unchanged from v3, with two corrections:

- The typo'd bullet ("`DB.sup`/`DB.bu`-backing") is corrected to "`DB.sup`/`DB.buy`-backing."
- **`restoreFromMigrationArchive()` bullet expanded**: "with archive keys present, restores `DB.sup`/`DB.buy`-backing localStorage keys to the archived values **and clears `SS.supabaseUrl`/`SS.supabaseAnonKey`** (regression test for this version's fix — confirms the restore isn't immediately re-clobbered by a subsequent `initCloudDataLayer()` call); with no archive present, shows a toast and makes no changes."
- New bullet: **`saveBuy()`** — create calls `insert` with a client-generated `num` but no client-generated `id`; update calls `update().eq('id', EI.bu)`, never `insert`; the duplicate-name check still blocks before any Supabase call is made (regression test, since `saveBuy()` is now written out in full rather than assumed to mirror `saveSup()`).

All other bullets, and the required conversion of the ~9 existing synchronous tests to `testAsync()`, are unchanged from v3.

## Changelog

- v1: Initial spec implementing REQ-CLOUD-001-v3.
- v2: Fixed v1's 5 blocking findings.
- v3: Fixed v2's 5 blocking findings (false `initApp`/`async` precedent, whole-app auth-gate regression, false `showQuotaModal()` citation, missed `quickAddBuyer()` write path, unconverted tests) plus 2 advisories.
- v4: Independent spec-gate re-review, round 3, found v3's 5 blocking + 2 advisory fixes all genuinely correct, plus one new blocking issue: `restoreFromMigrationArchive()` didn't disconnect Cloud Data, so its restore was silently overwritten by the next background refresh whenever a Supabase session was still cached — the normal case. Fixed by having the restore also clear `SS.supabaseUrl`/`SS.supabaseAnonKey` before reloading. Also restores `cleanupExpiredMigrationArchive()`'s explicit call-site position (dropped from v3's rewritten `initApp()` snippet) and writes `saveBuy()` out in full instead of an overstated "mirrors `saveSup()` exactly" claim.
