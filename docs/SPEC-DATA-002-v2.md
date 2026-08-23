# SPEC-DATA-002-v2: Data Integrity Cleanup — Phantom Record Removal & Safe Renumbering

**Supersedes:** SPEC-DATA-002-v1 (independent spec-gate review — CONDITIONAL PASS. Every code citation checked out byte-for-byte, including a full "before" diff of the `pullAll()` patch, and the core mechanism was confirmed safe — no scenario found where the tool could delete real data or corrupt a genuine relationship. Three blocking findings, all fixed below: (1) `verifyFkIntegrityAfterCleanup()` omitted a `q.lines[].lid` check that REQ-DATA-002g's "not a subset" instruction requires be checked or explicitly justified as omitted — added, with a comment matching the codebase's own precedent for the already-known-dead `liId` field. (2) `renumberEntitySequentially()`'s sort-stability fallback had zero comments, directly violating REQ-DATA-002f's explicit instruction that "this must not be left implicit in the implementation's comments" — added. (3) `executeDataCleanup()`'s `logEv()` calls used the raw internal DB-key abbreviation as `entityType` and the literal placeholder `'bulk'` as `entityId`, meaning a renumbered Supplier's or Contact's own Activity tab (`renderSupActivity()`/`renderConActivity()`, which filter `DB.events` by the record's real id) would never show it was renumbered — a confirmed, concrete deviation from REQ-DATA-002h's "consistent with every other data-mutating action" requirement. Fixed by logging renumbering **per affected record**, using its real (post-renumber) `id` and the app's established singular `entityType` vocabulary (`supplier`, `contact`, `buyer`, `invoice`, `po`, `payment`, `order`, extended here with three new-but-consistent values for entities with no prior `logEv()` precedent: `line_item`, `quote`, `shipment`). Phantom-removal logging remains one aggregate entry per entity — unlike renumbering, a phantom has no real id by definition, so there is structurally no per-record Activity-tab entry it could ever appear on regardless of `entityType` naming — but now uses the correct singular vocabulary instead of the raw DB-key abbreviation, and `null` rather than the misleading placeholder `'bulk'` as `entityId`.**

**Implements:** REQ-DATA-002-v2 (REQ-DATA-002a through REQ-DATA-002j, AC-1 through AC-9).

All line citations below were re-verified against the current `index.html` (v2.9.56, 506/506 tests passing, branch `claude/req-data-002-cleanup`) independently of the REQ document's own citations.

---

## 0. Design notes

**0.1 — Reuse the backup-gate *mechanism*, not the migration's actual modal.** `showBlockingBackupModal()` (`index.html:4787-4795`) is already a generic, reusable, Promise-returning function — but the modal it opens (`ov-migration-backup`, `index.html:2409-2422`) has Supabase-migration-specific copy ("Before migrating Suppliers/Buyers to the cloud...", "Proceed with Migration"). Showing that literal text for a data-cleanup action would be actively misleading. This spec creates a second, parallel modal + function set (`ov-data-cleanup-backup` / `showDataCleanupBackupModal()` / `dataCleanupBackupAckChg()` / `dataCleanupBackupProceed()` / `dataCleanupBackupCancel()`, with its own `_dataCleanupBackupResolve` module-level variable) — byte-for-byte the same *mechanism* (checkbox-gated, Promise-based, cancel-any-pending-prior-call pattern) as the migration one, with cleanup-specific copy and its own resolver variable so the two features' pending-callback state can never collide.

**0.2 — Preview happens before the backup gate, not after.** REQ-DATA-002b requires a read-only scan and preview with no mutation; REQ-DATA-002c's backup gate blocks only the *actual removal*. The natural, safest ordering is: scan (free, read-only) → show counts → operator clicks "Clean Up Now" only if something was found → backup gate → execute. This also directly satisfies AC-9 (zero found → report it, skip the gate entirely, since there is nothing to confirm).

**0.3 — One shared `isPhantomRecord()` predicate, called from both the scan and the actual removal.** Rather than duplicating REQ-DATA-002a's criterion in two places (a preview-only check and a separate removal check that could drift apart), both the scan and `executeDataCleanup()` call the same function. The removal step re-scans fresh at execution time (not reusing a stored scan-result array) — in this single-threaded, single-operator UI nothing can change `DB` between the preview and the confirm click, but re-deriving avoids any staleness assumption entirely.

---

## 1. New pure predicate — `isPhantomRecord(entityKey, rec)`

Implements REQ-DATA-002a, including the Contacts-only compound criterion. Insert immediately after `backfillConIds()` (`index.html:2576-2582`):

```js
function isPhantomRecord(entityKey, rec) {
  if (entityKey === 'con') {
    return !rec.id || (!rec.name && !rec.email);
  }
  return !rec.id;
}
```

## 2. New scan function — `scanForPhantomRecords()`

Implements REQ-DATA-002a/b — pure, read-only, no mutation of `DB` or `localStorage`. Scans every top-level entity array per REQ-DATA-002a's explicit list:

```js
function scanForPhantomRecords() {
  var keys = ['sup', 'li', 'inv', 'po', 'qt', 'payments', 'con', 'buy', 'ord', 'sh'];
  var result = {};
  keys.forEach(function(key) {
    result[key] = (DB[key] || []).filter(function(rec) { return isPhantomRecord(key, rec); });
  });
  return result;
}
```

## 3. New HTML — Settings → Data card button, preview modal, backup-gate modal

### 3.1 New button in the existing Data card

`index.html:673-683` is the current Data card. Insert a new button immediately after the existing "Repair invoice totals" button (line 680) and before the closing `</div>` (line 681):

```html
        <button class="btn btn-g" style="border-color:var(--gold);color:var(--gold);" onclick="runDataRepair()">&#9881; Repair invoice totals</button>
        <button class="btn btn-g" style="border-color:var(--gold);color:var(--gold);" onclick="openDataCleanupScan()">&#9881; Scan for phantom records</button>
      </div>
      <div id="repair-status" style="font-size:.56rem;color:var(--m);margin-top:6px;min-height:14px;"></div>
      <div id="data-cleanup-status" style="font-size:.56rem;color:var(--m);margin-top:6px;min-height:14px;"></div>
```

(The two status lines are deliberately separate — `#repair-status` is `runDataRepair()`'s own existing element, untouched; `#data-cleanup-status` is new, used only for the final post-cleanup summary, per §7.)

### 3.2 New preview modal

Insert immediately after the `ov-sb-dup` modal's closing `</div>` (`index.html:2434`) and before the blank line + `<div class="toast" id="toast">` that follows it (`index.html:2436`), following the same `.ov`/`.modal`/`.mh`/`.mb` structure as every other modal in the file:

```html
<div class="ov" id="ov-data-cleanup-preview" onclick="if(event.target===this)closeM('ov-data-cleanup-preview')">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Data Integrity Scan</h2><button class="mx" onclick="closeM('ov-data-cleanup-preview')">&#215;</button></div>
    <div class="mb">
      <div id="data-cleanup-preview-body" style="font-size:.55rem;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button class="btn btn-g" onclick="closeM('ov-data-cleanup-preview')">Close</button>
        <button class="btn btn-s" id="data-cleanup-proceed-btn" onclick="confirmDataCleanup()" style="display:none;">Clean Up Now</button>
      </div>
    </div>
  </div>
</div>
```

### 3.3 New backup-gate modal

Insert immediately after the new preview modal's closing `</div>`, mirroring `ov-migration-backup` (`index.html:2409-2422`) structurally but with cleanup-specific copy:

```html
<div class="ov" id="ov-data-cleanup-backup">
  <div class="modal" style="max-width:460px;">
    <div class="mh"><h2 style="font-size:.75rem;">Back Up Before Cleanup</h2></div>
    <div class="mb">
      <p style="font-size:.55rem;margin-bottom:12px;"><strong>Before removing phantom records, export a full backup.</strong> This cannot be automatically verified as complete — please confirm you have downloaded and can locate the export file.</p>
      <button class="btn btn-s" style="margin-bottom:12px;" onclick="expAll()">&#8595; Export All Data</button>
      <label style="display:flex;align-items:center;gap:6px;font-size:.52rem;margin-bottom:14px;"><input type="checkbox" id="data-cleanup-backup-ack" onchange="dataCleanupBackupAckChg()"> I have downloaded and verified the backup file</label>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn btn-g" onclick="dataCleanupBackupCancel()">Cancel</button>
        <button class="btn btn-s" id="data-cleanup-backup-proceed" disabled onclick="dataCleanupBackupProceed()">Proceed with Cleanup</button>
      </div>
    </div>
  </div>
</div>
```

## 4. New module-level variable

Add alongside `_sbMigrationResolve`'s declaration (`index.html:4786`):

```js
var _dataCleanupBackupResolve = null;
```

## 5. New backup-gate functions (mirrors `showBlockingBackupModal()`/`migBackup*` exactly)

Insert immediately after `migBackupCancel()` (`index.html:4803-4806`):

```js
function showDataCleanupBackupModal() {
  return new Promise(function(resolve){
    if (_dataCleanupBackupResolve) { var _prevResolve = _dataCleanupBackupResolve; _dataCleanupBackupResolve = null; _prevResolve(false); }
    if (G('data-cleanup-backup-ack')) G('data-cleanup-backup-ack').checked = false;
    if (G('data-cleanup-backup-proceed')) G('data-cleanup-backup-proceed').disabled = true;
    _dataCleanupBackupResolve = resolve;
    G('ov-data-cleanup-backup').classList.add('on');
  });
}
function dataCleanupBackupAckChg() {
  G('data-cleanup-backup-proceed').disabled = !G('data-cleanup-backup-ack').checked;
}
function dataCleanupBackupProceed() {
  G('ov-data-cleanup-backup').classList.remove('on');
  if (_dataCleanupBackupResolve) { var r = _dataCleanupBackupResolve; _dataCleanupBackupResolve = null; r(true); }
}
function dataCleanupBackupCancel() {
  G('ov-data-cleanup-backup').classList.remove('on');
  if (_dataCleanupBackupResolve) { var r = _dataCleanupBackupResolve; _dataCleanupBackupResolve = null; r(false); }
}
```

## 6. New scan-trigger and preview-render functions

Insert immediately after the functions in §5:

```js
var DATA_CLEANUP_LABELS = { sup:'Suppliers', li:'Line Items', inv:'Invoices', po:'Purchase Orders', qt:'Quotes', payments:'Payments', con:'Contacts', buy:'Buyers', ord:'Order Requests', sh:'Shipments' };
// logEv()'s existing call sites use a human-readable singular entityType, never the raw DB-key
// abbreviation (confirmed: 'supplier','contact','buyer','invoice','po','payment','order' are the only
// values used anywhere in the file today). li/qt/sh have no prior logEv() precedent — 'line_item',
// 'quote', 'shipment' are new but consistent with that existing singular-word convention.
var DATA_CLEANUP_ENTITY_TYPE = { sup:'supplier', li:'line_item', inv:'invoice', po:'po', qt:'quote', payments:'payment', con:'contact', buy:'buyer', ord:'order', sh:'shipment' };

function openDataCleanupScan() {
  var scan = scanForPhantomRecords();
  renderDataCleanupPreview(scan);
  G('ov-data-cleanup-preview').classList.add('on');
}

function renderDataCleanupPreview(scan) {
  var body = G('data-cleanup-preview-body');
  var proceedBtn = G('data-cleanup-proceed-btn');
  var total = 0;
  var lines = [];
  Object.keys(scan).forEach(function(key) {
    var n = scan[key].length;
    if (n > 0) { total += n; lines.push(n + ' ' + DATA_CLEANUP_LABELS[key]); }
  });
  if (total === 0) {
    body.innerHTML = '<div style="color:var(--gn);">No issues found — data looks clean.</div>';
    proceedBtn.style.display = 'none';
  } else {
    body.innerHTML = '<div>Found ' + total + ' phantom record(s):</div>' +
      '<ul style="margin:8px 0;padding-left:18px;">' + lines.map(function(l){ return '<li>' + san(l) + '</li>'; }).join('') + '</ul>' +
      '<div style="color:var(--m);">These will be permanently removed. Suppliers, Line Items, Buyers, Contacts, and Order Requests will then be renumbered sequentially to close any gaps. Invoices, Purchase Orders, Quotes, and Credit Notes are never renumbered.</div>';
    proceedBtn.style.display = '';
  }
}
```

## 7. New execution functions — the actual cleanup

Insert immediately after the functions in §6:

```js
function renumberEntitySequentially(arr, prefix) {
  var sorted = arr.slice().sort(function(a, b) {
    var an = parseRefNum(a.num, prefix), bn = parseRefNum(b.num, prefix);
    var aHas = an !== null, bHas = bn !== null;
    if (aHas && bHas) return an - bn;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    // Both records lack a valid existing num at this point. Fall back to createdAt; if BOTH also lack
    // createdAt, this returns 0 for that pair, and Array.prototype.sort's stability guarantee (satisfied
    // by every browser this app supports) preserves their original relative array order deterministically.
    // This is deliberate, not an accidental fallthrough — REQ-DATA-002f requires it be spelled out here.
    var aC = a.createdAt || '', bC = b.createdAt || '';
    return aC < bC ? -1 : (aC > bC ? 1 : 0);
  });
  // Returns the list of records that actually changed (id + old/new num), not just a changed/unchanged
  // boolean — REQ-DATA-002h requires logging each renumbering per affected record, not one aggregate
  // entry per entity, so the caller needs to know exactly which records changed and what they changed to.
  var changes = [];
  sorted.forEach(function(rec, i) {
    var newNum = prefix + '-' + String(i + 1).padStart(4, '0');
    if (rec.num !== newNum) changes.push({ id: rec.id, oldNum: rec.num, newNum: newNum });
    rec.num = newNum;
  });
  return changes;
}

function verifyFkIntegrityAfterCleanup() {
  var idsOf = function(key) { var m = {}; (DB[key]||[]).forEach(function(r){ m[r.id] = true; }); return m; };
  var supIds = idsOf('sup'), liIds = idsOf('li'), buyIds = idsOf('buy'), conIds = idsOf('con');
  var dangling = [];
  DB.con.forEach(function(c){ if (c.supplierId && !supIds[c.supplierId]) dangling.push('Contact ' + c.id + ' supplierId'); });
  DB.li.forEach(function(l){ if (l.supId && !supIds[l.supId]) dangling.push('Line Item ' + l.id + ' supId'); });
  DB.inv.forEach(function(i){
    if (i.buyerId && !buyIds[i.buyerId]) dangling.push('Invoice ' + i.id + ' buyerId');
    (i.lineItems||[]).forEach(function(li){ if (li.lid && !liIds[li.lid]) dangling.push('Invoice ' + i.id + ' line lid'); });
  });
  DB.po.forEach(function(p){
    if (p.supId && !supIds[p.supId]) dangling.push('PO ' + p.id + ' supId');
    (p.lineItems||[]).forEach(function(li){ if (li.lid && !liIds[li.lid]) dangling.push('PO ' + p.id + ' line lid'); });
  });
  DB.qt.forEach(function(q){
    if (q.sourceContactId && !conIds[q.sourceContactId]) dangling.push('Quote ' + q.id + ' sourceContactId');
    (q.lines||[]).forEach(function(l){
      if (l.supId && !supIds[l.supId]) dangling.push('Quote ' + q.id + ' line supId');
      // Quote lines don't currently populate `lid` anywhere in the live code (a dead field on this
      // entity, the same class as the already-known-dead `liId` in qteToPoConvert()) — checked anyway,
      // never skipped, per REQ-DATA-002g's explicit "not a subset" instruction.
      if (l.lid && !liIds[l.lid]) dangling.push('Quote ' + q.id + ' line lid');
    });
  });
  DB.ord.forEach(function(o){
    if (o.contactId && !conIds[o.contactId]) dangling.push('Order Request ' + o.id + ' contactId');
    (o.lines||[]).forEach(function(l){
      (l.rfqResponses||[]).forEach(function(r){
        if (r.contactId && !conIds[r.contactId]) dangling.push('Order Request ' + o.id + ' rfqResponse contactId');
        if (r.supId && !supIds[r.supId]) dangling.push('Order Request ' + o.id + ' rfqResponse supId');
      });
    });
  });
  return dangling;
}

async function confirmDataCleanup() {
  closeM('ov-data-cleanup-preview');
  var backupConfirmed = await showDataCleanupBackupModal();
  if (!backupConfirmed) return;
  executeDataCleanup();
}

function executeDataCleanup() {
  var removedCounts = {};
  ['sup', 'li', 'inv', 'po', 'qt', 'payments', 'con', 'buy', 'ord', 'sh'].forEach(function(key) {
    var before = DB[key].length;
    DB[key] = DB[key].filter(function(rec) { return !isPhantomRecord(key, rec); });
    var removed = before - DB[key].length;
    if (removed > 0) {
      removedCounts[key] = removed;
      // A phantom record has no real id by definition (that's the detection criterion for every entity
      // except the Contacts compound case, and even there the record's other identifying fields are
      // blank) — there is no per-record Activity-tab entry a phantom could ever appear on regardless of
      // how this is logged, so this remains one aggregate entry per entity. Uses the app's existing
      // singular entityType vocabulary and `null` (not the misleading placeholder `'bulk'`) as entityId.
      logEv(DATA_CLEANUP_ENTITY_TYPE[key], null, 'phantom_removed', removed + ' phantom ' + DATA_CLEANUP_LABELS[key] + ' record(s) removed during data integrity cleanup', 'operator');
    }
  });

  var renumberedLabels = [];
  [['sup','SUP'], ['li','LI'], ['buy','BUY'], ['con','CON'], ['ord','ORD']].forEach(function(pair) {
    var key = pair[0], prefix = pair[1];
    var changes = renumberEntitySequentially(DB[key], prefix);
    if (changes.length) {
      renumberedLabels.push(DATA_CLEANUP_LABELS[key]);
      // Logged per affected record with its real (post-renumber) id and the app's existing singular
      // entityType vocabulary — unlike phantom removal, a renumbered record has a real, valid id, so this
      // shows up on that exact record's own Activity tab (renderSupActivity()/renderConActivity()/etc.),
      // matching every other data-mutating action in this app, per REQ-DATA-002h.
      changes.forEach(function(c) {
        logEv(DATA_CLEANUP_ENTITY_TYPE[key], c.id, 'renumbered', 'Renumbered from ' + (c.oldNum || '(none)') + ' to ' + c.newNum + ' during data integrity cleanup', 'operator');
      });
    }
  });

  var dangling = verifyFkIntegrityAfterCleanup();

  saveAll();
  renderAll();

  var totalRemoved = Object.keys(removedCounts).reduce(function(s, k) { return s + removedCounts[k]; }, 0);
  var msg = totalRemoved > 0
    ? '✓ Removed ' + totalRemoved + ' phantom record(s).' + (renumberedLabels.length ? ' Renumbered: ' + renumberedLabels.join(', ') + '.' : '')
    : '✓ No phantom records to remove.';
  if (dangling.length) msg += ' ⚠ ' + dangling.length + ' unexpected reference issue(s) found — see console.';
  if (dangling.length) console.warn('[Stackd] Data cleanup: unexpected dangling references', dangling);
  var status = G('data-cleanup-status');
  status.textContent = msg;
  status.style.color = dangling.length ? '#f87171' : '#4ade80';
}
```

## 8. `pullAll()` hardening (REQ-DATA-002j)

Current code, `index.html:3934-3946` (inside the `simpleEnts` merge loop):

```js
        var merged = pulled.map(function(p) {
          var candidate = idKeyedEnts.indexOf(eKey) > -1
            ? localArr.find(function(r){ return r.id === p.id; })
            : findLocalMatchByBizKey(eKey, localArr, p);
          var local = claim(candidate);
          var m = mergePulledWithLocal(p, local);
          if (local) {
            matchedLocalIds[local.id] = true;
          } else if (idKeyedEnts.indexOf(eKey) === -1) {
            m.id = uid(); // business-keyed, genuinely unmatched (no local record, or its match was already claimed this pull)
          }
          return m;
        });
```

Replace with:

```js
        var merged = pulled.map(function(p) {
          var candidate = idKeyedEnts.indexOf(eKey) > -1
            ? localArr.find(function(r){ return r.id === p.id; })
            : findLocalMatchByBizKey(eKey, localArr, p);
          var local = claim(candidate);
          var m = mergePulledWithLocal(p, local);
          if (local) {
            matchedLocalIds[local.id] = true;
          } else if (idKeyedEnts.indexOf(eKey) === -1) {
            m.id = uid(); // business-keyed, genuinely unmatched (no local record, or its match was already claimed this pull)
          } else if (!m.id) {
            // REQ-DATA-002j: an id-keyed entity (sup/payments/co) with no local match and no id after
            // translation would otherwise enter DB with a falsy id (the SYNC-GAP-001 symptom) — drop it.
            console.warn('[Stackd] pullAll: dropped a pulled ' + eKey + ' record with no id and no local match', p);
            return null;
          }
          return m;
        }).filter(function(m) { return m !== null; });
```

This is the entire hardening change — one new `else if` branch and a `.filter()` appended to the existing `.map()` chain. Nothing else in `pullAll()` changes.

## 9. FM-1 / scope re-confirmation

No new entity, `K`/`DB` key, field, or Sheets mapping. Every function added operates entirely on existing entity arrays already in `DB`. `logEv()` calls use the existing mechanism with no new parameters. FM-1 category-1, unchanged from the REQ's own assessment.

## 10. Test plan

| AC | Test |
|---|---|
| AC-1 | `scanForPhantomRecords()` on a `DB.sup` fixture with 3 real + 2 `id`-falsy records returns exactly 2 in `result.sup`; `DB.sup` itself is unmodified after the call |
| AC-1b | `scanForPhantomRecords()` on a `DB.con` fixture with 2 real Contacts + 1 Contact with a truthy `id` but no `name`/`email` returns exactly 1 in `result.con` |
| AC-2 | `confirmDataCleanup()` called, then `dataCleanupBackupCancel()` invoked before proceed — assert `DB` unmodified, `executeDataCleanup()` never runs (spy) |
| AC-3 | Full flow: scan → confirm → backup-proceed → assert `DB.sup` now contains only the real records, each byte-for-byte unchanged except `num` |
| AC-4 | Fixture with real Suppliers numbered `SUP-0001`, `SUP-0003`, `SUP-0007` — assert `renumberEntitySequentially()` returns a `changes` array covering the two records whose `num` actually moved (correct `oldNum`/`newNum`/`id` per entry) and leaves the array's records renumbered `SUP-0001`, `SUP-0002`, `SUP-0003` in original relative order |
| AC-5 | Fixture with a phantom PO (`id` falsy) alongside a real Invoice/PO/Quote/CN with a normal `num` — assert `executeDataCleanup()` removes the phantom PO but leaves the real records' `num` fields untouched |
| AC-6 | Fixture: a Contact with `supplierId` = a Supplier's `id`; a Quote with `sourceContactId` = a Contact's `id` and a line with `lid` = a Line Item's `id`; an Invoice line with `lid` = a Line Item's `id`. Renumber those entities, then call `verifyFkIntegrityAfterCleanup()` — assert it returns `[]` (empty — no dangling references), specifically covering the Quote-line `lid` case new in v2, not just the Invoice-line one |
| AC-7 | After a cleanup run that removes 1 phantom Supplier and renumbers 2 real Suppliers, assert `DB.events` contains exactly one `phantom_removed` entry with `entityType:'supplier'`, `entityId:null`, and exactly two `renumbered` entries, each with `entityType:'supplier'` and `entityId` equal to one of the two real Suppliers' actual `id` — not a shared placeholder value — proving the per-record logging fix, not just that the verbs exist somewhere in `DB.events` |
| AC-8 | Simulate `pullAll()`'s merge with a pulled Contact record resolving to a falsy `id` and no local match — assert it is dropped (not present in the resulting `DB.con`) and no other record in the batch is affected |
| AC-9 | `scanForPhantomRecords()` on entirely clean fixtures (zero phantoms anywhere) — `openDataCleanupScan()` / `renderDataCleanupPreview()` shows the "No issues found" message and hides the proceed button; `confirmDataCleanup()` is never reachable from the UI in this state |

## 11. Explicitly out of scope

- Editing/reconstructing a phantom record's data — by definition it has none worth reconstructing.
- Any renumbering of Invoices, Purchase Orders, Quotes, or Credit Notes, permanently, not just this version.
- Any change to `saveCon()`/`processImportRecords()`'s existing Contact validation rules (the CSV import path's looser `!name && !email` skip-guard is unchanged; REQ-DATA-002's compound criterion is safe regardless, per the REQ's own caveat).
- A generalized "find any dangling FK anywhere in the app" auditor — `verifyFkIntegrityAfterCleanup()` checks exactly the fields this cleanup could theoretically affect (per REQ-DATA-002g's explicit list), not a general data-quality scanner.
