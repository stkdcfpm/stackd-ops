# SPEC-SHIP-002 v3 — Shipment↔Invoice relationship: real id-based linking, DG/port inheritance, and source-drift detection

**Requirement:** REQ-SHIP-002 v6 (clean PASS, independent requirements-gate review round 5/fourth confirmatory)
**Status:** v3 — revises v2 after independent spec-gate review round 2 (confirmatory): **PASS**, 0 blocking + 4 new advisory findings, all fixed, personally re-verified against live code before accepting any of them. **Spec-gate is now complete — ready for implementation.** Round 2 independently re-confirmed every one of round 1's claimed fixes was actually correct (not merely present), by re-deriving each one from scratch rather than trusting round 1's own word — the `docs/user-guide.md` addition fits the live file's actual current content, both corrected cross-references resolve to the right sections, the Load Calculator "no existing fixture" claim holds, and the AC-6b index-0/index-1 disclosure accurately describes the live `renderShpSourceDriftWarn()` code. Round 2's 4 new advisory findings, all fixed: (1) §11's AC-15 description repeated the exact same false "existing test pattern to follow" claim round 1 had already caught and fixed once in this section for the Load Calculator tests — a second occurrence of the identical defect class, missed by round 1, now corrected the same way, confirming (via a fresh `grep -ni "AI_SYSTEM_PROMPT" tests/run.js`) zero such tests exist today; (2) §12's `docs/data-model.md` update touched only the §2 logical-model text and left the file's own Mermaid ERD (§5, `SHIPMENT` entity block + relationship line) and its "Known Inconsistency — Mixed FK Convention" note (§3) stale/internally-inconsistent with §2 once this feature ships — §12 extended with both; (3) no test in §11 exercised `saveShp()`'s own Cloud Data `shRow` extension specifically (the two pre-existing cloud-configured `saveShp()` tests both use a blank `shf-invs`) — new test added; (4) one internal comment cited REQ §1.3 for a rule (never blocking an unresolvable invoice num) that §1.3's bullets don't literally state — reworded to describe the actual, correct reasoning without the inexact citation. Round 2 independently re-verified all 33 `index.html` citations byte-for-byte a second time, re-swept every internal `§N` cross-reference (~60 occurrences) from scratch, re-ran `node tests/run.js` (1073/1073 confirmed), and hand-traced the live-checkbox mechanism and `renderShpSourceDriftWarn()`'s XSS-safety/empty-array-handling/both drift conditions independently — all found clean, no further findings on any of that.
**Date:** 2026-10-18

---

## 0. Citation note

Every line number below was re-verified against the current `index.html` and `tests/run.js` while drafting this SPEC, **not copied from REQ-SHIP-002 v6's own citations** — those citations were written against an earlier revision of `index.html` and have since drifted by 100+ lines in most places (an unrelated feature, REQ/SPEC-LI-002, landed in between and shifted everything after it). Every citation in this document is fresh.

---

## 1. Overview

Extends the Shipment entity (`DB.sh`) with two new fields and makes four existing functions actually use them, closing the gap the REQ's own investigation found: `linkedInvs` is a bare array of invoice-number strings, never dereferenced against `DB.inv`, and DG/port are never inherited from the invoice that caused (or is later linked to) a Shipment.

1. **Schema:** `linkedInvIds[]` (real ids) + `linkedInvSnapshots[]` (compact, self-identifying `{invId, dg, pol, pod}` records) alongside the existing `linkedInvs[]` (kept, unchanged — still the operator-facing, num-keyed field).
2. **`invHasDG(inv)`** — new shared helper, used by `autoCreateShipmentFromInvoice()`, `saveShp()`, and `openLoadCalc()` (one disclosed behavior change — §4).
3. **`autoCreateShipmentFromInvoice()`** inherits DG and port from the triggering invoice instead of hardcoding `dg:false`/blank ports (§5).
4. **`saveShp()`** resolves every linked invoice into id/snapshot form, ORs their DG status into the saved `dg` (additive, never a replacement for the operator's own checkbox), and fills blank ports from the first linked invoice (§6).
5. **A new live-sync mechanism** (`shpDgManualToggle()` / `recomputeShpDgLiveState()` / `shpCurrentLinkedInvoicesHaveDG()`) keeps the `shf-dg` checkbox visually forced-true-and-disabled while a linked invoice asserts DG, while correctly preserving an operator's own independent confirmation across a transient invoice-linked period (§7) — this is the mechanism REQ-SHIP-002 v6's own 5 review rounds spent the most effort getting right, and its exact design is carried over verbatim from the REQ's own literal pseudocode.
6. **`renderShpSourceDriftWarn()`** — a new banner on the Edit Shipment modal, shown whenever a linked invoice's live DG/port state has drifted from what was snapshotted, or two linked invoices disagree on port (§8).
7. **`backfillShLinkedInvIds()`** — self-healing backfill for `linkedInvIds[]`/`linkedInvSnapshots[]` on any Shipment that predates this feature, same no-device-marker pattern as the existing `backfillShLinkedInvs()` (§9).
8. **Cloud Data** — one new migration, 4 touchpoints extended (§10).

No build step. No new external dependency. `FIELD_MAPS.sh` is explicitly NOT touched (REQ §1.3) — the two new fields are never exported to Sheets.

---

## 2. State layer additions

### 2.1 Two new session-scoped UI-state variables

Add immediately after the existing `_liApproveCtx` declaration (`index.html:3080`):

**Current (`index.html:3079-3080`):**
```js
var _invEditSnapshot = null; // G-06: pre-edit snapshot captured at unlock, cleared on save or close
var _liApproveCtx = null;    // REQ/SPEC-LI-002: {candidateId, quoteNum} while Approve is mid-flow; null otherwise. Set AFTER openLI()/editLI() (which clear it first), never before.
```

**Replace with:**
```js
var _invEditSnapshot = null; // G-06: pre-edit snapshot captured at unlock, cleared on save or close
var _liApproveCtx = null;    // REQ/SPEC-LI-002: {candidateId, quoteNum} while Approve is mid-flow; null otherwise. Set AFTER openLI()/editLI() (which clear it first), never before.
var _shpDgInvoiceDriven = false; // REQ/SPEC-SHIP-002c: is shf-dg CURRENTLY forced true/disabled by a linked invoice?
var _shpDgManualValue = false;   // REQ/SPEC-SHIP-002c: the operator's own last INDEPENDENT (non-invoice-forced) shf-dg value — must survive an invoice being linked and then unlinked again within the same modal session
```

Neither variable is part of `DB`, never persisted, never reset by `resetDB()` — same class of session-only UI state as `cRfqEditId`/`_liApproveCtx`. Both are reset only by `openShp()`/`editShp()` (§7.3/§7.4) and written only by `shpDgManualToggle()`/`recomputeShpDgLiveState()` (§7.2 — §7.1 is a pure reader, `shpCurrentLinkedInvoicesHaveDG()`, and writes neither), never by any other function.

---

## 3. `DB.sh` schema additions

```js
{
  // ...existing fields unchanged...
  linkedInvs:          string[],   // UNCHANGED — operator-facing, num-keyed, comma-separated in the form
  linkedInvIds:         string[],   // NEW — real Invoice ids, resolved from linkedInvs at save time. Not positionally parallel to linkedInvs (an unresolvable num is silently dropped, never null-padded).
  linkedInvSnapshots:    object[]   // NEW — compact, self-identifying: [{invId, dg, pol, pod}, ...]. One entry per successfully-resolved linkedInvs entry, in the same order, but matched by invId, never by array position (REQ §2/REQ-SHIP-002a — do not assume snaps[i] corresponds to linkedInvs[i]).
}
```

Per REQ §1.3, explicitly NOT done: no FK constraint on either array column; no dedup of a `linkedInvs` entry appearing twice; no change to `FIELD_MAPS.sh`.

---

## 4. `invHasDG(inv)` — new shared helper

### 4.1 Current state (two divergent inline checks)

`openLoadCalc()` (`index.html:13580-13603`), inside its `.map()` over `DB.inv`:
```js
      var hasDG = (inv.lineItems||[]).some(function(li){
        var cat = DB.li.find(function(x){ return x.id===li.lid; });
        return cat && cat.dg;
      });
```
(`index.html:13586-13589`)

`runLoadCalc()` (`index.html:13605-13627`), inside its `ids.forEach()`:
```js
    if (!hasDG) {
      hasDG = (inv.lineItems||[]).some(function(li){
        var cat = DB.li.find(function(x){ return x.id===li.lid; });
        return (cat && cat.dg) || li.dg;
      });
    }
```
(`index.html:13616-13621`)

`runLoadCalc()`'s version is the more complete one — it also checks the line's own `dg` field directly, not only the catalogue-linked `dg`. This is the logic `invHasDG(inv)` adopts as canonical.

### 4.2 New shared function

Add immediately before `getInvoicePOs()` (`index.html:9121`), i.e. right after `autoCreateShipmentFromInvoice()`'s closing brace:

```js
function invHasDG(inv) {
  return (inv.lineItems||[]).some(function(li){
    var cat = DB.li.find(function(x){ return x.id===li.lid; });
    return (cat && cat.dg) || li.dg;
  });
}
```

### 4.3 `runLoadCalc()` — no behavior change

**Replace** `index.html:13616-13621`:
```js
    if (!hasDG) {
      hasDG = (inv.lineItems||[]).some(function(li){
        var cat = DB.li.find(function(x){ return x.id===li.lid; });
        return (cat && cat.dg) || li.dg;
      });
    }
```
**with:**
```js
    if (!hasDG) hasDG = invHasDG(inv);
```
Byte-identical logic, extracted — zero behavior change, confirmed by inspection (the inline body is `invHasDG`'s own body verbatim).

### 4.4 `openLoadCalc()` — disclosed behavior change

**Replace** `index.html:13586-13589`:
```js
      var hasDG = (inv.lineItems||[]).some(function(li){
        var cat = DB.li.find(function(x){ return x.id===li.lid; });
        return cat && cat.dg;
      });
```
**with:**
```js
      var hasDG = invHasDG(inv);
```
**Disclosed behavior change (REQ-SHIP-002h):** the Load Calculator's invoice-picker DG badge (`index.html:13595`, the red "DG" tag) will now additionally appear for an invoice whose DG status comes only from a line's own `li.dg` field without a catalogue link — a case the picker previously missed but `runLoadCalc()`'s own container recommendation already accounted for. This makes the picker's badge and the calculation it feeds into consistent with each other for the first time; it was never consistent before this change. No test currently exercises `openLoadCalc()`'s badge rendering, so this is a new behavior with no regression risk, only new coverage (AC-9, §11).

---

## 5. `autoCreateShipmentFromInvoice()` — DG/port inheritance (REQ-SHIP-002b)

**Current (`index.html:9079-9119`):**
```js
async function autoCreateShipmentFromInvoice(inv) {
  if (SS.autoCreateShipmentOnPaid === false) return;
  var already = DB.sh.some(function(s){
    var linked = Array.isArray(s.linkedInvs) ? s.linkedInvs : [];
    return (s.autoCreatedFromInvIds||[]).indexOf(inv.id) > -1 || linked.indexOf(inv.num) > -1;
  });
  if (already) return;

  var ref = 'SHP-' + (inv.num || Date.now().toString(36));
  var suffix = 2;
  while (DB.sh.some(function(s){ return s.ref === ref; })) { ref = 'SHP-' + (inv.num || Date.now().toString(36)) + '-' + suffix; suffix++; }

  var seededDocs = shpSeedTradeDocs(false);
  var newShp = {
    id: uid(), ref: ref, blNum: '', vessel: '', carrier: '', originPort: '', destPort: '',
    etd: '', eta: '', containerType: '20GP', containerNum: '', dg: false,
    tradeDocs: seededDocs, docsStatus: shpComputeDocsStatus(seededDocs), status: RD_SHP_STATUS[0],
    linkedInvs: [inv.num], autoCreatedFromInvIds: [inv.id],
    forwarder: '', forwarderEmail: '', notes: '', updAt: new Date().toISOString()
  };

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var shRow = {
      ref: newShp.ref, bl_num: null, vessel: null, carrier: null, origin_port: null, dest_port: null,
      etd: null, eta: null, container_type: newShp.containerType, container_num: null, dg: false,
      docs_status: newShp.docsStatus, status: newShp.status, linked_invs: newShp.linkedInvs,
      trade_docs: newShp.tradeDocs, auto_created_from_inv_ids: newShp.autoCreatedFromInvIds,
      forwarder: null, forwarder_email: null, notes: null, upd_at: newShp.updAt
    };
    var result = await _sb.from('shipments').insert(shRow).select().single();
    if (result.error) { toast('Auto-created Shipment failed to save to Cloud Data: ' + result.error.message); return; }
    newShp.id = result.data.id;
    await refreshShFromSupabase();
  } else {
    DB.sh.push(newShp);
    sv(K.sh, DB.sh);
  }
  rShp();
  toast('Shipment ' + ref + ' auto-created — add details as they become available');
}
```

**Replace with:**
```js
async function autoCreateShipmentFromInvoice(inv) {
  if (SS.autoCreateShipmentOnPaid === false) return;
  var already = DB.sh.some(function(s){
    var linked = Array.isArray(s.linkedInvs) ? s.linkedInvs : [];
    return (s.autoCreatedFromInvIds||[]).indexOf(inv.id) > -1 || linked.indexOf(inv.num) > -1;
  });
  if (already) return;

  var ref = 'SHP-' + (inv.num || Date.now().toString(36));
  var suffix = 2;
  while (DB.sh.some(function(s){ return s.ref === ref; })) { ref = 'SHP-' + (inv.num || Date.now().toString(36)) + '-' + suffix; suffix++; }

  // REQ/SPEC-SHIP-002b: a brand-new Shipment always starts with blank ports —
  // inheriting here is never an "overwrite" per §1.3, since there is nothing
  // to overwrite yet.
  var dg = invHasDG(inv);
  var originPort = inv.pol || '';
  var destPort = inv.pod || '';
  var seededDocs = shpSeedTradeDocs(dg);
  var newShp = {
    id: uid(), ref: ref, blNum: '', vessel: '', carrier: '', originPort: originPort, destPort: destPort,
    etd: '', eta: '', containerType: '20GP', containerNum: '', dg: dg,
    tradeDocs: seededDocs, docsStatus: shpComputeDocsStatus(seededDocs), status: RD_SHP_STATUS[0],
    linkedInvs: [inv.num], linkedInvIds: [inv.id],
    linkedInvSnapshots: [{ invId: inv.id, dg: dg, pol: originPort, pod: destPort }],
    autoCreatedFromInvIds: [inv.id],
    forwarder: '', forwarderEmail: '', notes: '', updAt: new Date().toISOString()
  };

  if (_sb && localStorage.getItem('st_sh_cloud_migration_ts')) {
    if (!(await ensureSbAuth())) return;
    var shRow = {
      ref: newShp.ref, bl_num: null, vessel: null, carrier: null,
      origin_port: newShp.originPort || null, dest_port: newShp.destPort || null,
      etd: null, eta: null, container_type: newShp.containerType, container_num: null, dg: newShp.dg,
      docs_status: newShp.docsStatus, status: newShp.status, linked_invs: newShp.linkedInvs,
      linked_inv_ids: newShp.linkedInvIds, linked_inv_snapshots: newShp.linkedInvSnapshots,
      trade_docs: newShp.tradeDocs, auto_created_from_inv_ids: newShp.autoCreatedFromInvIds,
      forwarder: null, forwarder_email: null, notes: null, upd_at: newShp.updAt
    };
    var result = await _sb.from('shipments').insert(shRow).select().single();
    if (result.error) { toast('Auto-created Shipment failed to save to Cloud Data: ' + result.error.message); return; }
    newShp.id = result.data.id;
    await refreshShFromSupabase();
  } else {
    DB.sh.push(newShp);
    sv(K.sh, DB.sh);
  }
  rShp();
  toast('Shipment ' + ref + ' auto-created — add details as they become available');
}
```

**Deliberate change beyond REQ's own literal ask, disclosed here:** `shpSeedTradeDocs(false)` → `shpSeedTradeDocs(dg)`. The pre-existing call hardcoded `false`, which silently matched the pre-existing hardcoded `dg: false` — now that `dg` is a real, possibly-`true` computed value, passing the literal `false` through unchanged would mean a DG-inherited Shipment is auto-created DG-flagged but WITHOUT the 8th "Dangerous Goods Declaration" trade-doc line that `shpSeedTradeDocs(true)` seeds (confirmed by reading `shpSeedTradeDocs()`, `index.html:8948-8963` current numbering) — an inconsistency `saveShp()`'s own pre-existing DG-toggle logic (§6, `index.html:13509-13515`) exists specifically to prevent on every subsequent edit. Not passing the real `dg` value here would be the one call site that bypasses that invariant at the exact moment it first becomes possible to trigger it. Flagged explicitly for spec-gate review as a design decision, not an oversight.

---

## 6. `saveShp()` — DG rule, port-inheritance fallback, schema fields (REQ-SHIP-002c, save-time half)

**Current (`index.html:13471-13497`):**
```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    blNum: G('shf-bl').value.trim(),
    vessel: G('shf-vessel').value.trim(),
    carrier: G('shf-carrier').value.trim(),
    originPort: G('shf-op').value.trim(),
    destPort: G('shf-dp').value.trim(),
    etd: G('shf-etd').value,
    eta: G('shf-eta').value,
    containerType: G('shf-ctype').value,
    containerNum: G('shf-cnum').value.trim(),
    dg: G('shf-dg').checked,
    docsStatus: G('shf-docs').value,
    status: G('shf-st').value,
    linkedInvs: linkedInvs,
    forwarder: G('shf-fwd') ? G('shf-fwd').value.trim() : '',
    forwarderEmail: G('shf-fwde') ? G('shf-fwde').value.trim() : '',
    notes: G('shf-nt').value.trim(),
    updAt: new Date().toISOString()
  };
```

**Replace with:**
```js
async function saveShp() {
  if (!vShp()) return;
  var ref = G('shf-ref').value.trim();
  var invRaw = G('shf-invs').value.trim();
  var linkedInvs = invRaw ? invRaw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];

  // REQ/SPEC-SHIP-002c: resolve every linked invoice (still num-keyed —
  // linkedInvs itself is unchanged) into its real id plus a compact DG/port
  // snapshot. An unresolvable num (typo, since-deleted invoice) is silently
  // dropped — linkedInvs is the operator-facing source of truth; REQ §1.3
  // never asks for a picker/dropdown or a DB FK constraint on it, so there is
  // no mechanism here (or anywhere else in this SPEC) that could block or
  // reject it for containing one.
  var resolvedInvs = linkedInvs.map(function(num){ return DB.inv.find(function(i){ return i.num === num; }); })
                                .filter(Boolean);
  var linkedInvIds = resolvedInvs.map(function(inv){ return inv.id; });
  var linkedInvSnapshots = resolvedInvs.map(function(inv){
    return { invId: inv.id, dg: invHasDG(inv), pol: inv.pol || '', pod: inv.pod || '' };
  });
  var invoiceDG = linkedInvSnapshots.some(function(snap){ return snap.dg; });

  var originPort = G('shf-op').value.trim();
  var destPort = G('shf-dp').value.trim();
  // Port-inheritance fallback (REQ §1.3/Decision 1): only ever fills a BLANK
  // field from the FIRST linked invoice — never overwrites an operator's own
  // non-blank value. A later-linked invoice disagreeing is surfaced by
  // renderShpSourceDriftWarn() (§8), never silently applied here.
  if (!originPort && linkedInvSnapshots.length && linkedInvSnapshots[0].pol) originPort = linkedInvSnapshots[0].pol;
  if (!destPort && linkedInvSnapshots.length && linkedInvSnapshots[0].pod) destPort = linkedInvSnapshots[0].pod;

  var shp = {
    id: EI.sh || uid(),
    ref: ref,
    blNum: G('shf-bl').value.trim(),
    vessel: G('shf-vessel').value.trim(),
    carrier: G('shf-carrier').value.trim(),
    originPort: originPort,
    destPort: destPort,
    etd: G('shf-etd').value,
    eta: G('shf-eta').value,
    containerType: G('shf-ctype').value,
    containerNum: G('shf-cnum').value.trim(),
    dg: G('shf-dg').checked || invoiceDG,
    docsStatus: G('shf-docs').value,
    status: G('shf-st').value,
    linkedInvs: linkedInvs,
    linkedInvIds: linkedInvIds,
    linkedInvSnapshots: linkedInvSnapshots,
    forwarder: G('shf-fwd') ? G('shf-fwd').value.trim() : '',
    forwarderEmail: G('shf-fwde') ? G('shf-fwde').value.trim() : '',
    notes: G('shf-nt').value.trim(),
    updAt: new Date().toISOString()
  };
```

**`shp.dg = G('shf-dg').checked || invoiceDG` is deliberately redundant with the live-sync mechanism (§7), not dead code.** Whenever `recomputeShpDgLiveState()` has correctly run, `G('shf-dg').checked` already equals `true` if `invoiceDG` is true (the checkbox is forced). The explicit `|| invoiceDG` is a safety net for any path that calls `saveShp()` without the live-sync handlers having fired first — concretely, every one of the four pre-existing DG-toggle tests (`index.html` test suite, §11) calls `saveShp()` directly against a hand-set `mockEl('shf-dg').checked`, never through the live-sync wiring, and must keep passing unmodified.

**Everything from here to the end of `saveShp()` (`index.html:13498-13558` current numbering — the `tradeDocs`/`autoCreatedFromInvIds` carry-forward block, the DG-toggle trade-doc add/remove block, and the Cloud Data branch) is UNCHANGED except the Cloud Data `shRow` object, extended in §10.4 below.** The pre-existing `wasDg`/`dgLineIdx` logic (`index.html:13507-13515`) needs no change — it already reads `shp.dg`, which is now correctly computed above rather than taken verbatim from the checkbox.

---

## 7. Live `shf-dg` checkbox sync (REQ-SHIP-002c, UI half)

### 7.1 `shpCurrentLinkedInvoicesHaveDG()` — new helper

Add immediately after `invHasDG()` (§4.2):

```js
function shpCurrentLinkedInvoicesHaveDG() {
  var raw = G('shf-invs') ? G('shf-invs').value.trim() : '';
  var nums = raw ? raw.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
  return nums.some(function(num) {
    var inv = DB.inv.find(function(x){ return x.num === num; });
    return inv ? invHasDG(inv) : false;
  });
}
```
Resolves the form's own live, possibly-mid-edit `shf-invs` value against `DB.inv` — deliberately NOT the same code path as `saveShp()`'s `resolvedInvs`/`linkedInvSnapshots` (which only exist after a save), since this must work before any save has happened at all (the create path, AC-16b).

### 7.2 `shpDgManualToggle()` / `recomputeShpDgLiveState()`

Add immediately after `shpCurrentLinkedInvoicesHaveDG()`. **Executable logic is identical to REQ-SHIP-002 v6 §2's own literal pseudocode** (the REQ's own pseudocode, already spec-grade after 5 review rounds — hand-compared statement-by-statement, no functional translation needed); the explanatory comments below are condensed rather than copied character-for-character from the REQ's own longer rationale:

```js
function shpDgManualToggle() {
  // Wired to shf-dg's own onchange. A disabled <input> never receives a
  // user-driven change event, so this can only fire while the box is
  // enabled — i.e. NOT currently invoice-driven — which is exactly the
  // condition under which a change genuinely represents the operator's own
  // independent choice, never a forced value.
  _shpDgManualValue = G('shf-dg').checked;
}

function recomputeShpDgLiveState() {
  var cb = G('shf-dg');
  if (!cb) return;
  var invoiceDG = shpCurrentLinkedInvoicesHaveDG();
  if (invoiceDG) {
    cb.checked = true;
    cb.disabled = true;
    cb.title = 'DG is set by a linked invoice — remove it from Linked Invoices to clear.';
    _shpDgInvoiceDriven = true;
  } else {
    cb.disabled = false;
    cb.title = '';
    cb.checked = _shpDgManualValue; // ALWAYS restores the operator's own last independent value — never a hardcoded false
    _shpDgInvoiceDriven = false;
  }
}
```

### 7.3 Initialization — `openShp()`

**Current (`index.html:13433-13448`):**
```js
function openShp() {
  EI.sh = null;
  G('shp-mt').textContent = 'New Shipment';
  ['shf-ref','shf-bl','shf-vessel','shf-carrier','shf-op','shf-dp','shf-cnum','shf-invs','shf-fwd','shf-fwde','shf-nt'].forEach(function(id){ if(G(id)) G(id).value=''; });
  if(G('shf-etd')) G('shf-etd').value='';
  if(G('shf-eta')) G('shf-eta').value='';
  vClrAll(['shf-ref','shf-etd','shf-eta']);
  if(G('shf-ctype')) G('shf-ctype').value='20GP';
  if(G('shf-docs')) { G('shf-docs').value='Pending'; G('shf-docs').disabled=false; G('shf-docs').title=''; }
  if(G('shf-st')) G('shf-st').value='Pending';
  if(G('shf-dg')) G('shf-dg').checked=false;
  if(G('shp-docs-panel')) G('shp-docs-panel').innerHTML = '<div style="color:var(--m);font-size:.54rem;">Save this Shipment first, then reopen it to add trade documents.</div>';
  if(G('shp-docs-newtype')) G('shp-docs-newtype').value = '';
  G('ov-shp').classList.add('on');
  setTimeout(function(){ if(G('shf-ref')) G('shf-ref').focus(); }, 50);
}
```

**Replace** the single line `if(G('shf-dg')) G('shf-dg').checked=false;` **with:**
```js
  if(G('shf-dg')) G('shf-dg').checked=false;
  _shpDgManualValue = false; _shpDgInvoiceDriven = false;
  recomputeShpDgLiveState(); // no-op in practice (shf-invs is already blank) — starts the session's state cleanly (AC-16b)
```

### 7.4 Initialization — `editShp()`

**Current (`index.html:13450-13469`):**
```js
function editShp(id) {
  var s = DB.sh.find(function(x){ return x.id===id; });
  if (!s) return;
  EI.sh = id;
  G('shp-mt').textContent = 'Edit Shipment';
  G('shf-ref').value=s.ref||''; G('shf-bl').value=s.blNum||'';
  G('shf-vessel').value=s.vessel||''; G('shf-carrier').value=s.carrier||'';
  G('shf-op').value=s.originPort||''; G('shf-dp').value=s.destPort||'';
  G('shf-etd').value=s.etd||''; G('shf-eta').value=s.eta||'';
  G('shf-ctype').value=s.containerType||'20GP'; G('shf-cnum').value=s.containerNum||'';
  G('shf-dg').checked=!!s.dg; G('shf-docs').value=s.docsStatus||'Pending';
  G('shf-st').value=s.status||'Pending';
  G('shf-invs').value=(s.linkedInvs||[]).join(', ');
  if(G('shf-fwd')) G('shf-fwd').value=s.forwarder||'';
  if(G('shf-fwde')) G('shf-fwde').value=s.forwarderEmail||'';
  G('shf-nt').value=s.notes||'';
  if(G('shp-docs-newtype')) G('shp-docs-newtype').value = '';
  renderShpDocsPanel(id);
  G('ov-shp').classList.add('on');
}
```

**Critical ordering note, confirmed by direct read:** `shf-dg` is set at the line containing `G('shf-dg').checked=!!s.dg; G('shf-docs').value=...` — **before** `shf-invs` is set two statements later. The live-sync initialization MUST be inserted **after** `shf-invs` is populated, not after `shf-dg`, or `shpCurrentLinkedInvoicesHaveDG()` would read a stale `shf-invs` value left over from whatever modal session preceded this one.

**Replace** the single line `G('shf-invs').value=(s.linkedInvs||[]).join(', ');` **with:**
```js
  G('shf-invs').value=(s.linkedInvs||[]).join(', ');
  // REQ/SPEC-SHIP-002c: must run AFTER shf-invs is set (immediately above),
  // never after shf-dg (two lines above that) — shpCurrentLinkedInvoicesHaveDG()
  // reads shf-invs's live value, which isn't real yet until this point.
  var openInvoiceDG = shpCurrentLinkedInvoicesHaveDG();
  // The stored dg is attributable to independent confirmation only if no
  // CURRENTLY-linked invoice explains it right now. If dg was true partly or
  // wholly because of an invoice, the safe default (Decision 1) is to treat
  // the independent baseline as false — this app has never separately
  // recorded a cross-session-independent manual value (REQ §1.3).
  // Disclosed edge case: if a linked invoice's own DG status has changed
  // since this Shipment was last saved, openInvoiceDG may read false even
  // though dg was originally invoice-derived — this formula then seeds
  // _shpDgManualValue = true, conservatively preserving dg:true rather than
  // silently dropping it. The checkbox is left enabled either way, so the
  // operator can correct it if the preserved value turns out wrong.
  _shpDgManualValue = s.dg && !openInvoiceDG;
  _shpDgInvoiceDriven = false;
  recomputeShpDgLiveState(); // re-derives _shpDgInvoiceDriven and re-forces checked=true if openInvoiceDG is itself true
```

Also add, alongside the existing `renderShpDocsPanel(id);` call at the end of `editShp()`:
```js
  renderShpSourceDriftWarn(s);
```

### 7.5 HTML wiring — new `onchange`/`oninput` attributes

**`shf-dg` checkbox**, current (`index.html:2602-2605`):
```html
        <div class="fld" style="display:flex;align-items:center;gap:8px;padding-top:18px;">
          <input type="checkbox" id="shf-dg" style="width:auto;margin:0;">
          <label for="shf-dg" style="margin:0;cursor:pointer;">DG Onboard</label>
        </div>
```
**Replace with:**
```html
        <div class="fld" style="display:flex;align-items:center;gap:8px;padding-top:18px;">
          <input type="checkbox" id="shf-dg" style="width:auto;margin:0;" onchange="shpDgManualToggle()">
          <label for="shf-dg" style="margin:0;cursor:pointer;">DG Onboard</label>
        </div>
```

**`shf-invs` input**, current (`index.html:2610-2611`):
```html
        <div class="fld"><label>Linked Invoices <span style="font-size:.44rem;color:var(--m);">(comma-separated)</span></label>
          <input type="text" id="shf-invs" placeholder="INV10030, INV10031"></div>
```
**Replace with:**
```html
        <div class="fld"><label>Linked Invoices <span style="font-size:.44rem;color:var(--m);">(comma-separated)</span></label>
          <input type="text" id="shf-invs" placeholder="INV10030, INV10031" oninput="recomputeShpDgLiveState()"></div>
```

Neither `shf-invs` nor `shf-dg` had an `oninput`/`onchange` attribute before this feature (confirmed by inspecting the full Shipment form markup, `index.html:2586-2633`) — both hooks are genuinely new wiring, not a modification of an existing handler.

---

## 8. `renderShpSourceDriftWarn()` (REQ-SHIP-002d)

### 8.1 New HTML container

**Current (`index.html:2614-2618`):**
```html
        <div class="fld" style="grid-column:1/-1"><label>Notes</label>
          <textarea id="shf-nt" placeholder="Customs agent, port notes, delays..."></textarea></div>
      </div>

      <div style="margin-bottom:14px;border-top:1px solid var(--ln);padding-top:12px;">
```
**Replace with:**
```html
        <div class="fld" style="grid-column:1/-1"><label>Notes</label>
          <textarea id="shf-nt" placeholder="Customs agent, port notes, delays..."></textarea></div>
      </div>
      <div id="sh-drift-warn" style="margin-bottom:8px;"></div>

      <div style="margin-bottom:14px;border-top:1px solid var(--ln);padding-top:12px;">
```
Placement mirrors the existing `po-drift-warn` div (`index.html:2535`) — immediately after the field grid closes, before the next modal section.

### 8.2 New function

Add immediately after `renderPoSourceDriftWarn()` (`index.html:9165`, its closing brace):

```js
function renderShpSourceDriftWarn(shp) {
  var el = G('sh-drift-warn');
  if (!el) return;
  el.innerHTML = '';
  var snaps = shp.linkedInvSnapshots || [];
  if (!snaps.length) return;
  var lines = [];
  snaps.forEach(function(snap, idx) {
    var inv = DB.inv.find(function(x){ return x.id === snap.invId; });
    if (!inv) {
      lines.push('A previously linked Invoice no longer exists (was DG: ' + (snap.dg ? 'Yes' : 'No') + ', Origin: ' + (snap.pol || '-') + ', Dest: ' + (snap.pod || '-') + ').');
      return;
    }
    var parts = [];
    // Post-link drift (Decision 2): has this invoice's own live DG/port state
    // changed since it was snapshotted?
    var liveDg = invHasDG(inv);
    if (liveDg !== !!snap.dg) parts.push('DG status changed (was ' + (snap.dg ? 'Yes' : 'No') + ', now ' + (liveDg ? 'Yes' : 'No') + ')');
    if ((inv.pol || '') !== (snap.pol || '')) parts.push('Origin Port changed (was ' + (snap.pol || '-') + ', now ' + (inv.pol || '-') + ')');
    if ((inv.pod || '') !== (snap.pod || '')) parts.push('Dest Port changed (was ' + (snap.pod || '-') + ', now ' + (inv.pod || '-') + ')');
    // Multi-invoice port disagreement (Decision 1): does a non-first linked
    // invoice's snapshotted port disagree with what this Shipment actually
    // has set? (The first invoice is the one the port was inherited FROM, by
    // construction never a disagreement with itself.)
    if (idx > 0) {
      if (snap.pol && shp.originPort && snap.pol !== shp.originPort) parts.push('Origin Port (' + snap.pol + ') differs from this Shipment’s Origin Port (' + shp.originPort + ')');
      if (snap.pod && shp.destPort && snap.pod !== shp.destPort) parts.push('Dest Port (' + snap.pod + ') differs from this Shipment’s Dest Port (' + shp.destPort + ')');
    }
    if (parts.length) lines.push(inv.num + ': ' + parts.join('; ') + '.');
  });
  if (!lines.length) return;
  el.innerHTML = '<div style="background:#FFF8E1;border:1px solid #F9A825;border-radius:3px;padding:7px 10px;font-size:.5rem;color:#7F6000;">' +
    lines.map(function(l){ return '&#9888; ' + san(l); }).join('<br>') +
    '</div>';
}
```

**Design note for spec-gate review:** REQ-SHIP-002 v6 describes this requirement only in prose ("adapted from `renderPoSourceDriftWarn()`, `invId`-keyed lookups, one line per affected invoice") — unlike §6/§7 above, v6 does not hand over literal pseudocode for this function, so the two drift conditions checked here (post-link drift against the invoice's own live state, and multi-invoice port disagreement against the Shipment's own set value) are this SPEC's own design, not a transcription. Called only from `editShp()` (§7.4) — never from `openShp()`, matching `renderPoSourceDriftWarn()`'s own precedent of being edit-only (`index.html` `editPO()` calls it; `openPO()` does not).

---

## 9. `backfillShLinkedInvIds()` (REQ-SHIP-002e)

**Naming note:** this is a NEW function, distinct from the existing `backfillShLinkedInvs()` (`index.html:3179-3192`, no "Ids" suffix — a different, pre-existing function that heals `linkedInvs` itself from a string back into an array after Sheets-sync corruption, SH-GAP-002). Do not confuse the two or attempt to merge them — they heal different fields for different reasons.

Add immediately after `backfillShLinkedInvs()` (`index.html:3192`, its closing brace):

```js
function backfillShLinkedInvIds() {
  // Self-healing, no device-level marker — same pattern as the pre-existing
  // backfillShLinkedInvs()/migrateLinkedPOIds() immediately above. Any
  // Shipment saved before this feature shipped has linkedInvs but no
  // linkedInvIds/linkedInvSnapshots at all; this derives them the same way
  // saveShp() does, purely from data already on hand.
  var changed = false;
  DB.sh.forEach(function(s) {
    if (Array.isArray(s.linkedInvIds)) return; // already backfilled or created post-ship
    var linked = Array.isArray(s.linkedInvs) ? s.linkedInvs : [];
    if (!linked.length) { s.linkedInvIds = []; s.linkedInvSnapshots = []; changed = true; return; }
    var resolved = linked.map(function(num){ return DB.inv.find(function(i){ return i.num === num; }); }).filter(Boolean);
    s.linkedInvIds = resolved.map(function(inv){ return inv.id; });
    s.linkedInvSnapshots = resolved.map(function(inv){
      return { invId: inv.id, dg: invHasDG(inv), pol: inv.pol || '', pod: inv.pod || '' };
    });
    changed = true;
  });
  if (changed) saveAll();
}
```

**Wiring, two call sites (same as `backfillShLinkedInvs()`/`migrateLinkedPOIds()` immediately above it):**

`doImport()` (`index.html:13323-13324`):
```js
    migrateLinkedPOIds();
    backfillShLinkedInvs();
```
→
```js
    migrateLinkedPOIds();
    backfillShLinkedInvs();
    backfillShLinkedInvIds();
```

`initApp()` (`index.html:15962-15963`):
```js
    migrateLinkedPOIds();
    backfillShLinkedInvs();
```
→
```js
    migrateLinkedPOIds();
    backfillShLinkedInvs();
    backfillShLinkedInvIds();
```

`backfillShLinkedInvIds()` must run AFTER `backfillShLinkedInvs()` at both call sites (as shown — appended, not prepended) — it reads `s.linkedInvs` as an array, and `backfillShLinkedInvs()` is what guarantees that shape for any record still carrying the pre-fix string form.

---

## 10. Cloud Data (REQ-SHIP-002f)

### 10.1 New migration

New file `supabase/migrations/0010_shipments_linked_inv_ids.sql` (the next unused number — `0009_quotes_ins_rate.sql` is the current latest):

```sql
-- SPEC-SHIP-002: adds two nullable jsonb columns to the existing shipments
-- table for real id-based invoice linking (linkedInvIds[]) and a compact
-- DG/port snapshot per linked invoice (linkedInvSnapshots[]). Additive only —
-- no backfill, no data migration, no change to any existing column or
-- constraint. Both columns are null on every pre-existing row;
-- refreshShFromSupabase() (index.html) leaves the corresponding local field
-- absent (not []) when the column is null, same `!= null` guard pattern as
-- trade_docs/auto_created_from_inv_ids (0008_shipments_trade_docs.sql).

alter table shipments
  add column linked_inv_ids jsonb,
  add column linked_inv_snapshots jsonb;
```

### 10.2 `refreshShFromSupabase()` — read-back

**Current (`index.html:6316-6337`):**
```js
async function refreshShFromSupabase() {
  if (!_sb) return;
  if (DB.sh.length > 0 && !localStorage.getItem('st_sh_cloud_migration_ts')) return; // never migrated on this device and real local data exists — refuse to silently overwrite
  var result = await _sb.from('shipments').select('*').is('deleted_at', null);
  if (result.error) { toast('Could not load Shipments from Cloud Data.'); return; }
  DB.sh = result.data.map(function(row){
    var s = {
      id: row.id, ref: row.ref, blNum: row.bl_num || '', vessel: row.vessel || '', carrier: row.carrier || '',
      originPort: row.origin_port || '', destPort: row.dest_port || '', etd: row.etd || '', eta: row.eta || '',
      containerType: row.container_type || '', containerNum: row.container_num || '', dg: !!row.dg,
      docsStatus: row.docs_status || '', status: row.status, linkedInvs: row.linked_invs || [],
      forwarder: row.forwarder || '', forwarderEmail: row.forwarder_email || '', notes: row.notes || ''
    };
    if (row.upd_at != null) s.updAt = row.upd_at;
    if (row.trade_docs != null) s.tradeDocs = row.trade_docs;
    if (row.auto_created_from_inv_ids != null) s.autoCreatedFromInvIds = row.auto_created_from_inv_ids;
    return s;
  });
  sv(K.sh, DB.sh);
  if (!localStorage.getItem('st_sh_cloud_migration_ts')) localStorage.setItem('st_sh_cloud_migration_ts', new Date().toISOString());
  rShp(); rDash();
}
```

**Replace** the two `if (row.... != null)` lines **with (add two more of the same shape, never the bare `!= null ? val : undefined` idiom — CLAUDE.md's own documented pitfall):**
```js
    if (row.upd_at != null) s.updAt = row.upd_at;
    if (row.trade_docs != null) s.tradeDocs = row.trade_docs;
    if (row.auto_created_from_inv_ids != null) s.autoCreatedFromInvIds = row.auto_created_from_inv_ids;
    if (row.linked_inv_ids != null) s.linkedInvIds = row.linked_inv_ids;
    if (row.linked_inv_snapshots != null) s.linkedInvSnapshots = row.linked_inv_snapshots;
    return s;
```
A legacy `null` column (every pre-existing row) leaves the local field absent, not `[]` — `backfillShLinkedInvIds()` (§9) is what fills it in for a record that needs it, not this read-back.

### 10.3 `autoCreateShipmentFromInvoice()`'s `shRow` — already shown in §5

Already extended in §5's replacement block with `linked_inv_ids: newShp.linkedInvIds, linked_inv_snapshots: newShp.linkedInvSnapshots`.

### 10.4 `saveShp()`'s `shRow`

**Current (`index.html:13528-13536`):**
```js
    var shRow = {
      ref: shp.ref, bl_num: shp.blNum || null, vessel: shp.vessel || null, carrier: shp.carrier || null,
      origin_port: shp.originPort || null, dest_port: shp.destPort || null, etd: shp.etd || null, eta: shp.eta || null,
      container_type: shp.containerType || null, container_num: shp.containerNum || null, dg: !!shp.dg,
      docs_status: shp.docsStatus || null, status: shp.status, linked_invs: shp.linkedInvs || [],
      trade_docs: shp.tradeDocs, auto_created_from_inv_ids: shp.autoCreatedFromInvIds,
      forwarder: shp.forwarder || null, forwarder_email: shp.forwarderEmail || null, notes: shp.notes || null,
      upd_at: shp.updAt
    };
```
**Replace with:**
```js
    var shRow = {
      ref: shp.ref, bl_num: shp.blNum || null, vessel: shp.vessel || null, carrier: shp.carrier || null,
      origin_port: shp.originPort || null, dest_port: shp.destPort || null, etd: shp.etd || null, eta: shp.eta || null,
      container_type: shp.containerType || null, container_num: shp.containerNum || null, dg: !!shp.dg,
      docs_status: shp.docsStatus || null, status: shp.status, linked_invs: shp.linkedInvs || [],
      linked_inv_ids: shp.linkedInvIds || [], linked_inv_snapshots: shp.linkedInvSnapshots || [],
      trade_docs: shp.tradeDocs, auto_created_from_inv_ids: shp.autoCreatedFromInvIds,
      forwarder: shp.forwarder || null, forwarder_email: shp.forwarderEmail || null, notes: shp.notes || null,
      upd_at: shp.updAt
    };
```

### 10.5 `migrateShToSupabase()` — one-time migration insert

**Current (`index.html:7482-7492`):**
```js
    var result = await _sb.from('shipments').insert({
      ref: s.ref, bl_num: s.blNum || null, vessel: s.vessel || null, carrier: s.carrier || null,
      origin_port: s.originPort || null, dest_port: s.destPort || null, etd: s.etd || null, eta: s.eta || null,
      container_type: s.containerType || null, container_num: s.containerNum || null, dg: !!s.dg,
      docs_status: s.docsStatus || null, status: s.status,
      linked_invs: Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : []),
      trade_docs: Array.isArray(s.tradeDocs) ? s.tradeDocs : null,
      auto_created_from_inv_ids: Array.isArray(s.autoCreatedFromInvIds) ? s.autoCreatedFromInvIds : null,
      forwarder: s.forwarder || null, forwarder_email: s.forwarderEmail || null, notes: s.notes || null,
      upd_at: s.updAt != null ? s.updAt : null
    }).select().single();
```
**Replace with:**
```js
    var result = await _sb.from('shipments').insert({
      ref: s.ref, bl_num: s.blNum || null, vessel: s.vessel || null, carrier: s.carrier || null,
      origin_port: s.originPort || null, dest_port: s.destPort || null, etd: s.etd || null, eta: s.eta || null,
      container_type: s.containerType || null, container_num: s.containerNum || null, dg: !!s.dg,
      docs_status: s.docsStatus || null, status: s.status,
      linked_invs: Array.isArray(s.linkedInvs) ? s.linkedInvs : (typeof s.linkedInvs === 'string' && s.linkedInvs ? s.linkedInvs.split(',').map(function(t){return t.trim();}).filter(Boolean) : []),
      linked_inv_ids: Array.isArray(s.linkedInvIds) ? s.linkedInvIds : null,
      linked_inv_snapshots: Array.isArray(s.linkedInvSnapshots) ? s.linkedInvSnapshots : null,
      trade_docs: Array.isArray(s.tradeDocs) ? s.tradeDocs : null,
      auto_created_from_inv_ids: Array.isArray(s.autoCreatedFromInvIds) ? s.autoCreatedFromInvIds : null,
      forwarder: s.forwarder || null, forwarder_email: s.forwarderEmail || null, notes: s.notes || null,
      upd_at: s.updAt != null ? s.updAt : null
    }).select().single();
```
A pre-existing local Shipment being migrated for the first time via this function most likely has no `linkedInvIds`/`linkedInvSnapshots` at all yet (they're backfilled separately, §9) — `Array.isArray(...) ? ... : null` means it migrates with both columns `null`, exactly like `trade_docs`/`auto_created_from_inv_ids` already do for the same reason, rather than crashing or sending `undefined`.

**No outward/inward reference sweep needed** — `linkedInvIds`/`linkedInvSnapshots` are new fields on Shipment itself; nothing else in the app stores or resolves a Shipment id referencing them (same confirmed-no-consumer finding `migrateShToSupabase()`'s own existing comment, `index.html:7497-7500`, already documents for Shipment ids generally).

---

## 11. Tests (`tests/run.js`)

All new tests follow the existing `setupShpFormMinimal(ref)` pattern (`tests/run.js:14125-14132`) and `mkPaidInvoice()`-style fixtures already in the file. Exact assertions are left to implementation, but every test below MUST exist:

- **AC-1 (creation inherits DG):** `autoCreateShipmentFromInvoice()` on an invoice with a DG-flagged line (via catalogue `li.dg` and, separately, via a line's own `li.dg` with no catalogue link) produces `dg:true` and a seeded 8-doc `tradeDocs` (not 7).
- **AC-2 (creation inherits port):** same call, invoice has `pol`/`pod` set → new Shipment's `originPort`/`destPort` match; invoice has blank `pol`/`pod` → Shipment's ports stay blank (no crash, no `"undefined"` string).
- **AC-3 (creation sets linkedInvIds/Snapshots):** new Shipment's `linkedInvIds` is `[inv.id]`, `linkedInvSnapshots` is `[{invId, dg, pol, pod}]` matching the invoice's real values.
- **AC-4 (Cloud Data round-trip, creation path):** `autoCreateShipmentFromInvoice()` with `_sb` configured and migrated → `linked_inv_ids`/`linked_inv_snapshots` present in the mocked insert call; `refreshShFromSupabase()` reads them back onto `linkedInvIds`/`linkedInvSnapshots`.
- **AC-5 (saveShp() DG additivity — operator checkbox never loses to invoice):** operator checks `shf-dg`, no linked invoice → saved `dg:true`. Operator leaves `shf-dg` unchecked, one linked DG invoice → saved `dg:true` anyway (additive).
- **AC-5b (port-inheritance fallback, saveShp()):** blank `shf-op`/`shf-dp`, one linked invoice with real ports → saved Shipment inherits them. Non-blank `shf-op`/`shf-dp` already set, same linked invoice with DIFFERENT ports → saved Shipment's ports are UNCHANGED (never silently overwritten).
- **AC-6 (drift-warning banner, post-link drift):** a saved Shipment's `linkedInvSnapshots[0].dg` is `true`; the live invoice's lines are since edited so `invHasDG()` now returns `false`; `editShp()` → `renderShpSourceDriftWarn()` populates `#sh-drift-warn` with a line naming that invoice and "DG status changed."
- **AC-6b (drift-warning banner, multi-invoice port disagreement):** two `linkedInvSnapshots` entries with different `pol` values. **The matching one MUST be placed at index 0** — the check in §8.2 only ever compares `snaps[1..]` against `shp.originPort`/`destPort` (`idx > 0`), matching REQ Decision 1's literal "a mismatch from a LATER-linked invoice is a warning" by design; a mismatch at index 0 is never flagged and placing the matching entry there is required for this test to mean what it claims, not an arbitrary fixture choice. Assert the index-1 (non-matching) invoice is named in the banner, the index-0 (matching) one is not.
- **AC-6c (drift-warning banner, invoice deleted):** a `linkedInvSnapshots` entry whose `invId` no longer resolves against `DB.inv` → banner shows the "no longer exists" line, no crash.
- **AC-6d (drift-warning banner, nothing to report):** empty `linkedInvSnapshots` → `#sh-drift-warn` stays empty (`el.innerHTML === ''`).
- **AC-7 (backfill self-healing):** a Shipment fixture with `linkedInvs:['INV1']` and no `linkedInvIds` key at all → `backfillShLinkedInvIds()` populates both new fields correctly and calls `saveAll()` exactly once; re-running it a second time is a no-op (idempotent, confirmed by the `Array.isArray(s.linkedInvIds)` early-return).
- **AC-8 (Supabase omit-not-null on migration):** `migrateShToSupabase()` on a local Shipment with no `linkedInvIds` → the insert call's payload has `linked_inv_ids: null`, `linked_inv_snapshots: null`, not `undefined` or a thrown error.
- **AC-9 (shared `invHasDG()` + Load Calculator):** **confirmed by spec-gate round 1: there is no pre-existing Load Calculator test of any kind in `tests/run.js` today** (`runLoadCalc`/`openLoadCalc`/`lc-inv-list`/`_lcResult` — zero matches) — both tests below are new, written from scratch, not a reuse of an existing fixture. One test confirming `runLoadCalc()`'s DG detection (now via `invHasDG()`) matches what its own pre-extraction inline logic would have computed, for both a catalogue-linked-`dg` invoice and a line-only-`li.dg` invoice. One test confirming `openLoadCalc()`'s DG badge now appears for a line-only (`li.dg`, no catalogue link) invoice — the disclosed behavior change (§4.4), which this picker never covered before.
- **AC-10 (schema — linkedInvSnapshots not positionally parallel):** a Shipment with `linkedInvs:['A','B']` where only `'B'` resolves against `DB.inv` → `linkedInvSnapshots.length === 1`, and that one entry's `invId` matches `'B'`'s real id, never silently padded to length 2.
- **The 4 pre-existing DG-toggle tests** (`tests/run.js:14134-14184`, "AC-9" in their own in-file comments, predating this SPEC — unrelated numbering) **must still pass unmodified** — confirmed in §6 above: they call `saveShp()` directly with `linkedInvs` empty, so `invoiceDG` is always `false` and `shp.dg` reduces to exactly the pre-existing `G('shf-dg').checked` behavior.
- **AC-16 (checkbox resets on exit from pure-invoice-driven state):** `editShp()` on a Shipment whose `dg` is `true` purely from a currently-linked invoice (operator never checked the box) → `shf-dg` checked+disabled with the tooltip set. Remove that invoice from `shf-invs`, call `recomputeShpDgLiveState()` → checkbox re-enabled AND reset to `false`. `saveShp()` at that point → `shp.dg === false`.
- **AC-16b (create path covered):** `openShp()` then set `shf-invs` to a DG-flagged invoice number, call `recomputeShpDgLiveState()` → checkbox disabled+checked, proving the create path (not just edit) is live-synced.
- **AC-16c (manual confirmation survives a transient invoice-linked period — the REQ's own hardest scenario):** `editShp()` on a Shipment with no linked invoices and `dg:false` → operator checks `shf-dg` and fires `shpDgManualToggle()` (`_shpDgManualValue` becomes `true`) → set `shf-invs` to a DG-flagged invoice number, call `recomputeShpDgLiveState()` (checkbox forced checked+disabled, no visible change since already checked) → clear `shf-invs` again, call `recomputeShpDgLiveState()` once more, still within the same session, before ever saving. Assert the checkbox ends this sequence **re-enabled and still `checked === true`.**
- **AI_SYSTEM_PROMPT coverage (REQ-SHIP-002g, AC-15):** **confirmed by spec-gate round 2: there is no existing `AI_SYSTEM_PROMPT`-coverage test of any kind in `tests/run.js` today** (`grep -ni "AI_SYSTEM_PROMPT" tests/run.js` — zero matches) — this is a new test, written from scratch, not a reuse of an existing pattern (the same false-precedent defect round 1 already caught and fixed once in this section for the Load Calculator tests above — corrected here on its second occurrence). A grep-style substring assertion confirming the new prose (§13 below) is present in the array is sufficient; this is coverage that the prose exists, not a behavioral test.
- **`saveShp()`'s own Cloud Data `shRow` extension (§10.4) — new, round-2 finding:** the two existing cloud-configured `saveShp()` create/update tests (`tests/run.js:11183`, `:11204`) both set `shf-invs` blank, so neither exercises `linked_inv_ids`/`linked_inv_snapshots` with real content, and AC-4 above only covers the creation path (`autoCreateShipmentFromInvoice()`), never `saveShp()`'s own cloud branch — a regression stripping those two keys from `saveShp()`'s `shRow` specifically would go undetected by every other test in this list. New test: cloud-configured `saveShp()` with a non-blank `shf-invs` resolving to a real `DB.inv` record → assert the mocked insert/update call's row carries non-empty `linked_inv_ids`/`linked_inv_snapshots` matching what `saveShp()` computed.

Target: all of the above pass, plus the full pre-existing suite (currently 1073/1073) stays green. Report final pass count in `docs/version-history.md`'s own entry for this version (§16).

**Disclosure on AC numbering (spec-gate round 1 finding, resolved by disclosure):** REQ-SHIP-002 v6 §3 collapses "AC-1 through AC-15" into a single unchanged-from-v4 line, with no individual text for AC-11 through AC-14 anywhere in the only REQ revision available when drafting this SPEC. The AC labels used above (AC-1 through AC-10 with sub-letters, then AC-15/16/16b/16c) are this SPEC's own derived mapping of the behaviors REQ v6 §3's prose describes (creation-time inheritance, Cloud Data round-trip, DG save-rule additivity, port fallback, drift-warning banner, backfill self-healing, Supabase omit-not-null, shared `invHasDG` behavior change, schema compaction) — not a verbatim reproduction of whatever v4's own AC-11 through AC-14 text said, which this SPEC's author never had access to. If REQ-SHIP-002 v4's full acceptance-criteria text turns out to name additional, distinct criteria not covered by the behaviors listed above, that is a gap in this SPEC's test coverage, not in this disclosure — surfaced here for the implementer/spec-gate reviewer to cross-check against v4 if it's available.

---

## 12. Data model ERD update (`docs/data-model.md`)

Add to the existing `Shipment` block (currently `docs/data-model.md:91-95`):

```
Shipment (DB.sh / K.sh = 'st_sh')
  id                PK — uid()
  ref               Business key — user-typed (pre-existing), required, unique-validated
  linkedInvs[]       FK → Invoice.num — an ARRAY OF BUSINESS KEYS, not internal ids
                       (see §3 note)
  linkedInvIds[]     FK → Invoice.id — real ids, resolved from linkedInvs[] at save time.
                       NOT positionally parallel to linkedInvs — matched by invId inside
                       linkedInvSnapshots, never by array position (REQ/SPEC-SHIP-002, v2.9.91)
  linkedInvSnapshots[]  Compact, self-identifying: {invId, dg, pol, pod} — a point-in-time
                       capture of the linked invoice's DG/port state at save time, compared
                       against the invoice's live state by renderShpSourceDriftWarn()
                       (REQ/SPEC-SHIP-002, v2.9.91)
```

Add a new relationship line near the existing `Shipment ──(linkedInvs[])───→ Invoice.num` (`docs/data-model.md:124`):
```
Shipment       ──(linkedInvIds[])──→ Invoice.id            (real FK, array, v2.9.91)
```

**Also required — spec-gate round 2 finding: §12's own first draft updated only the §2 logical-model text above and left two other parts of this same file stale.** Leaving either of the following unfixed would make `docs/data-model.md` internally inconsistent with its own §2 the moment this SPEC's code ships:

**The Mermaid ERD (§5 of `docs/data-model.md`).** Current `SHIPMENT` entity block (`docs/data-model.md:235-238`):
```
    SHIPMENT {
        string id PK "uid() output"
        string ref UK "user-typed, pre-existing"
    }
```
Add the two new fields:
```
    SHIPMENT {
        string id PK "uid() output"
        string ref UK "user-typed, pre-existing"
        string linkedInvIds FK "array -- real ids, v2.9.91 (see §3 note)"
    }
```
And the existing relationship line (`docs/data-model.md:265`):
```
    INVOICE }o--o{ SHIPMENT : "sh.linkedInvs[] -- business-key array FK, NOT id-based (mixed convention, see §3)"
```
needs a second line added alongside it (the first is unchanged — `linkedInvs[]` itself still exists, business-key-based, as before):
```
    INVOICE }o--o{ SHIPMENT : "sh.linkedInvIds[] -- real id-based array FK, v2.9.91 (see §3 note)"
```

**§3's "Known Inconsistency — Mixed FK Convention" note (`docs/data-model.md:132-141`).** This section currently lists `sh.linkedInvs[]` as a pure example of the business-key-based convention (line 137: *"`sh.linkedInvs[]` (Shipment → Invoice) — reference the target's human-facing `num`"*) and its closing paragraph frames reconciling the two conventions as entirely future, v3.0.0-Supabase-cutover work. After this feature ships, Shipment is no longer a pure example of one side — it now stores **both** conventions for the same relationship simultaneously, the same pattern §3's own text already calls out for Credit Notes two lines earlier (line 139: *"Credit Notes even store **both** ... for the same relationship, redundantly"*). Add one sentence immediately after that existing Credit-Notes sentence:
```
Shipment (`sh.linkedInvs[]` + `sh.linkedInvIds[]`, REQ/SPEC-SHIP-002, v2.9.91) now does the same — not a new instance of the inconsistency, but a second, independent confirmation that storing both is this codebase's actual working pattern for an additive, non-breaking fix to a business-key-only FK, not an oversight to eventually clean up. `linkedInvIds[]` is the one actually dereferenced for drift detection (`renderShpSourceDriftWarn()`); `linkedInvs[]` remains the operator-facing, editable field.
```
This does not change §3's own conclusion (the mixed convention itself is still deferred to the v3.0.0 Supabase cutover) — it only keeps §3's own factual description of Shipment accurate.

---

## 13. `AI_SYSTEM_PROMPT` update (REQ-SHIP-002g, mandatory)

Add two new bullets to the `## Shipments` section, immediately after the existing DG Onboard bullet (`index.html:12182`, `'DG Onboard: tick if any product is classified as Dangerous Goods...'`):

```js
  'DG Onboard automatically ticks and locks itself whenever ANY currently-Linked Invoice is itself DG-flagged — the operator cannot uncheck it while that invoice stays linked (remove the invoice from Linked Invoices to regain manual control). An operator\'s own independent confirmation, made before or after a DG-linked invoice, is preserved and restored once that invoice is unlinked again, within the same editing session.',
  'Linking an Invoice also inherits its Origin/Destination Port into a blank port field on the Shipment (never overwrites an already-set one), and the Shipment keeps a point-in-time snapshot of each linked invoice\'s DG/port state — if that invoice\'s own data changes afterward, or two linked invoices disagree on port, a warning banner appears on the Edit Shipment modal.',
```

---

## 13b. `docs/user-guide.md` update (REQ-SHIP-002g, mandatory — spec-gate round 1 blocking finding)

REQ-SHIP-002 v6 §2 (REQ-SHIP-002g) names BOTH `AI_SYSTEM_PROMPT` (§13 above) and `docs/user-guide.md` as required updates — the first draft of this SPEC covered only the former, an undisclosed omission caught in spec-gate round 1, now fixed by adding this section. `CLAUDE.md:160` independently makes a `docs/user-guide.md` update mandatory for exactly this class of change ("new feature, changed workflow, changed field" — this feature is all three, operator-visible on the Edit Shipment modal).

Add to the end of the existing `## Shipments` section (`docs/user-guide.md:116-122`), immediately before the `## Import Data` heading:

```markdown
**DG and port now follow a linked Invoice.** If a Shipment's Linked Invoices field names an Invoice that itself has a Dangerous Goods line item, DG Onboard is automatically ticked and the checkbox is locked — you can't manually uncheck it while that invoice stays linked (remove it from Linked Invoices to regain manual control). If you'd independently confirmed DG yourself before or after linking such an invoice, that confirmation is remembered and restored once the invoice is unlinked again, within the same time you have the Shipment open for editing. Linking an Invoice also fills in a blank Origin Port or Destination Port from that invoice's own ports — it never overwrites a port you've already set. If a linked invoice's own DG status or ports change later, or two linked invoices disagree on port, a warning banner appears on the Edit Shipment form naming which invoice and what changed.
```

---

## 14. Known gaps to add to `docs/known-gaps.md` / `CLAUDE.md`

One gap, disclosed per REQ §1.3/§4 (not a defect — ship with this stated):

**SHIP-GAP-002 — DG manual-vs-invoice-derived tracking is session-scoped only, not cross-session.** `_shpDgManualValue`/`_shpDgInvoiceDriven` correctly distinguish an operator's own independent DG confirmation from an invoice-derived one WITHIN one continuous modal-open editing session (REQ's own AC-16c scenario). They do not and cannot reconstruct that distinction from a `dg` value already saved in a PRIOR session, since the single `dg` boolean persisted to `DB.sh`/Supabase has never recorded which source set it. `editShp()`'s own initialization formula (§7.4) makes the conservative choice — preserve `dg:true` as if independently confirmed whenever no currently-linked invoice explains it, rather than silently drop it — but this is a best-effort inference, not a reconstruction of real history. A fully cross-session-correct version would need a new persisted field (e.g. `shp.dgManual`) — explicitly out of scope here, logged as a candidate for a future REQ if this proves insufficient in practice.

Note the existing `SHIP-GAP-001` (Shipment/Cloud Data async double-submit race, v2.9.86) is unrelated and unaffected — this is a new, independent gap, numbered `SHIP-GAP-002`.

---

## 15. `CLAUDE.md` updates

1. Bump `**Current version: v2.9.90**` → `v2.9.91` and the test count to the final pass count from §11.
2. Add `SHIP-GAP-002` to the "Known gaps (summary)" table (§14 above).
3. Add a row to "Current sprint" noting this item done.
4. Add a new prose narrative entry (mirroring the existing v2.9.90/v2.9.89/v2.9.88 entries) describing: the `linkedInvIds[]`/`linkedInvSnapshots[]` schema addition and why it's not positionally parallel; the `invHasDG()` extraction and its one disclosed `openLoadCalc()` behavior change; the live DG-checkbox mechanism's exact manual-vs-invoice-driven distinction (worth stating explicitly, since REQ-SHIP-002 v6 spent 5 review rounds getting this right and a future maintainer "simplifying" it back to a single boolean would reintroduce the exact regression round 4 found); the drift-warning banner's two distinct conditions; and the new known gap.

---

## 16. Version delivery checklist

- Target version: **v2.9.91** (bump `<title>`, top-nav changelog button text, `AI_SYSTEM_PROMPT`'s own self-description string, new in-app changelog `<div>` block with "Current release"/"LATEST" badges moved onto it).
- `docs/version-history.md`: new top row summarizing all of §5-§10, the requirements-gate history (5 rounds, 8 blocking + 9 advisory findings, reproduced from REQ-SHIP-002 v6 §9-9e), spec-gate round count (filled in once spec-gate actually runs), new test count, and the one new disclosed gap (`SHIP-GAP-002`).
- `docs/user-guide.md`: apply §13b's addition to the Shipments section.
- `docs/data-model.md`: apply §12's three additions — the §2 logical-model block, the §5 Mermaid ERD entity/relationship lines, and the §3 Known-Inconsistency sentence (all three, not just the first — round 2 caught the first draft of §12 missing the latter two).
- Run `scripts/check-req-citations.js` against this SPEC file before submitting for spec-gate review (mandatory pre-submission step per `CLAUDE.md`'s "REQ/SPEC gate process").
- Full test suite must be green (currently 1073/1073; report new total).
