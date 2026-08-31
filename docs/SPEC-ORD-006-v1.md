# SPEC-ORD-006 — Edit and delete RFQ responses

**Status:** v1 — spec-gate PASS, no blocking findings. The highest-risk item (the id-rotation/repoint staleness mechanism) was verified by actually extracting and running the proposed code end-to-end against the real `renderQteSourceDriftWarn()`, not just reasoned about. Three non-blocking advisories, addressed below (see §10).
**Build baseline:** `main` @ current HEAD, 641/641 tests passing.
**Implements:** `docs/REQ-ORD-006-v1.md` (REQ-ORD-006a through REQ-ORD-006d, AC-1 through AC-8).

---

## 1. New module-level state variable

Add immediately after the existing RFQ-response state vars (`index.html:2703-2704`):

```js
var cRfqOrdId = null;
var cRfqLineId = null;
var cRfqEditId = null;
```

`null` means "add a new response" (today's only behavior, unchanged); set to a response's `id` means "editing that response."

---

## 2. `openRfqResponse()` — reset edit state and modal title (REQ-ORD-006a)

Replace (`index.html:3119-3139`):

```js
function openRfqResponse(lineId) {
  if (!EI.ord) return;
  cRfqOrdId = EI.ord;
  cRfqLineId = lineId;
  G('rfq-sup').innerHTML = '<option value="">— Supplier —</option>' +
    DB.sup.map(function(s){ return '<option value="' + san(s.id) + '">' + san(s.name) + '</option>'; }).join('');
  G('rfq-con').innerHTML = '<option value="">— none —</option>' +
    DB.con.map(function(c){ return '<option value="' + san(c.id) + '">' + san(c.name) + '</option>'; }).join('');
  G('rfq-cost').value = '';
  G('rfq-cur').value = 'USD';
  G('rfq-cbm').value = '';
  G('rfq-dutypct').value = '';
  G('rfq-dg').checked = false;
  G('rfq-moq').value = '';
  G('rfq-leadtime').value = '';
  G('rfq-payterms').value = '';
  G('rfq-con').value = '';
  G('rfq-notes').value = '';
  vClr('rfq-sup'); vClr('rfq-cost');
  G('ov-rfq').classList.add('on');
}
```

with:

```js
function openRfqResponse(lineId) {
  if (!EI.ord) return;
  cRfqOrdId = EI.ord;
  cRfqLineId = lineId;
  cRfqEditId = null;
  G('rfq-title').textContent = 'RFQ Response';
  G('rfq-sup').innerHTML = '<option value="">— Supplier —</option>' +
    DB.sup.map(function(s){ return '<option value="' + san(s.id) + '">' + san(s.name) + '</option>'; }).join('');
  G('rfq-con').innerHTML = '<option value="">— none —</option>' +
    DB.con.map(function(c){ return '<option value="' + san(c.id) + '">' + san(c.name) + '</option>'; }).join('');
  G('rfq-cost').value = '';
  G('rfq-cur').value = 'USD';
  G('rfq-cbm').value = '';
  G('rfq-dutypct').value = '';
  G('rfq-dg').checked = false;
  G('rfq-moq').value = '';
  G('rfq-leadtime').value = '';
  G('rfq-payterms').value = '';
  G('rfq-con').value = '';
  G('rfq-notes').value = '';
  vClr('rfq-sup'); vClr('rfq-cost');
  G('ov-rfq').classList.add('on');
}
```

Only two lines added (`cRfqEditId = null;`, `G('rfq-title').textContent = 'RFQ Response';`) — every existing reset line is untouched, so "+ Add Response" is byte-behaviorally identical to today (AC-1).

`rfq-title` (`index.html:440`, `<h2 id="rfq-title">RFQ Response</h2>`) already exists in the modal HTML with that exact default text — no HTML change needed for this step, only the new explicit reset so a prior "Edit" doesn't leave a stale title behind the next time "+ Add Response" is used.

---

## 3. New function: `editRfqResponse(lineId, responseId)` (REQ-ORD-006a)

Add immediately after `openRfqResponse()`:

```js
function editRfqResponse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var resp = (line.rfqResponses || []).find(function(r){ return r.id === responseId; });
  if (!resp) return;
  cRfqOrdId = EI.ord;
  cRfqLineId = lineId;
  cRfqEditId = responseId;
  G('rfq-title').textContent = 'Edit RFQ Response';
  G('rfq-sup').innerHTML = '<option value="">— Supplier —</option>' +
    DB.sup.map(function(s){ return '<option value="' + san(s.id) + '">' + san(s.name) + '</option>'; }).join('');
  G('rfq-con').innerHTML = '<option value="">— none —</option>' +
    DB.con.map(function(c){ return '<option value="' + san(c.id) + '">' + san(c.name) + '</option>'; }).join('');
  G('rfq-sup').value = resp.supId;
  G('rfq-cost').value = resp.cost;
  G('rfq-cur').value = resp.currency;
  G('rfq-cbm').value = resp.cbm || '';
  G('rfq-dutypct').value = resp.dutyPct || '';
  G('rfq-dg').checked = !!resp.dg;
  G('rfq-moq').value = resp.moq || '';
  G('rfq-leadtime').value = resp.leadTime || '';
  G('rfq-payterms').value = resp.paymentTerms || '';
  G('rfq-con').value = resp.contactId || '';
  G('rfq-notes').value = resp.notes || '';
  vClr('rfq-sup'); vClr('rfq-cost');
  G('ov-rfq').classList.add('on');
}
```

Same dropdown-population and field-reset shape as `openRfqResponse()`, just pre-filled from `resp` instead of blanked, and setting `cRfqEditId` instead of `null`. Reuses the same `ov-rfq` modal and the same `saveRfqResponse()` Save button — no new modal, no new HTML beyond the two new row buttons in §5.

**Known, accepted edge case (advisory, spec-gate):** `delSup()`'s own accepted design (`tests/run.js:7480`, AC-011) leaves a deleted supplier's `id` in place on any record that referenced it, as a historical record, rather than nulling it. If an RFQ response's original supplier has since been deleted, `G('rfq-sup').value = resp.supId` has no matching `<option>` to select — the dropdown silently shows nothing selected. Editing that response then requires picking a (different, currently-existing) supplier just to change, say, a cost figure. Not required by any AC; not fixed here, since it's the same class of accepted trade-off `delSup()` itself already made, not a new gap this SPEC introduces.

---

## 4. `saveRfqResponse()` — branch on edit vs. add (REQ-ORD-006b)

Replace (`index.html:3141-3163`):

```js
function saveRfqResponse() {
  var ord = DB.ord.find(function(o){ return o.id === cRfqOrdId; });
  if (!ord) { closeM('ov-rfq'); return; }
  var line = (ord.lines || []).find(function(l){ return l.id === cRfqLineId; });
  if (!line) { closeM('ov-rfq'); return; }
  var supId = G('rfq-sup').value;
  if (!supId) { vErr('rfq-sup', 'Supplier is required'); return; }
  var costStr = G('rfq-cost').value;
  if (costStr === '' || isNaN(+costStr) || +costStr < 0) { vErr('rfq-cost', 'A valid unit cost is required'); return; }
  vOk('rfq-sup'); vOk('rfq-cost');
  if (!line.rfqResponses) line.rfqResponses = [];
  line.rfqResponses.push({
    id: uid(), supId: supId, cost: +costStr, currency: G('rfq-cur').value,
    cbm: +G('rfq-cbm').value || 0, dutyPct: +G('rfq-dutypct').value || 0, dg: G('rfq-dg').checked,
    moq: G('rfq-moq').value.trim(), leadTime: G('rfq-leadtime').value.trim(),
    paymentTerms: G('rfq-payterms').value.trim(), notes: G('rfq-notes').value.trim(),
    contactId: G('rfq-con').value || null, ts: new Date().toISOString()
  });
  sv(K.ord, DB.ord);
  closeM('ov-rfq');
  renderRfqComparison(cRfqLineId);
  toast('RFQ response recorded');
}
```

with:

```js
function saveRfqResponse() {
  var ord = DB.ord.find(function(o){ return o.id === cRfqOrdId; });
  if (!ord) { closeM('ov-rfq'); return; }
  var line = (ord.lines || []).find(function(l){ return l.id === cRfqLineId; });
  if (!line) { closeM('ov-rfq'); return; }
  var supId = G('rfq-sup').value;
  if (!supId) { vErr('rfq-sup', 'Supplier is required'); return; }
  var costStr = G('rfq-cost').value;
  if (costStr === '' || isNaN(+costStr) || +costStr < 0) { vErr('rfq-cost', 'A valid unit cost is required'); return; }
  vOk('rfq-sup'); vOk('rfq-cost');
  if (!line.rfqResponses) line.rfqResponses = [];
  var newResp = {
    id: uid(), supId: supId, cost: +costStr, currency: G('rfq-cur').value,
    cbm: +G('rfq-cbm').value || 0, dutyPct: +G('rfq-dutypct').value || 0, dg: G('rfq-dg').checked,
    moq: G('rfq-moq').value.trim(), leadTime: G('rfq-leadtime').value.trim(),
    paymentTerms: G('rfq-payterms').value.trim(), notes: G('rfq-notes').value.trim(),
    contactId: G('rfq-con').value || null, ts: new Date().toISOString()
  };
  var wasEditing = !!cRfqEditId;
  if (wasEditing) {
    var idx = line.rfqResponses.findIndex(function(r){ return r.id === cRfqEditId; });
    if (idx > -1) {
      line.rfqResponses[idx] = newResp;
      if (line.committedResponseId === cRfqEditId) line.committedResponseId = newResp.id;
    }
    cRfqEditId = null;
  } else {
    line.rfqResponses.push(newResp);
  }
  sv(K.ord, DB.ord);
  closeM('ov-rfq');
  renderRfqComparison(cRfqLineId);
  toast(wasEditing ? 'RFQ response updated' : 'RFQ response recorded');
}
```

**Unchanged path** (`cRfqEditId` is `null`, `openRfqResponse()`'s existing reset): validation logic, `newResp` construction, and the final `push()` are byte-identical to today's code — only reformatted from an inline object literal into a named `newResp` variable so both branches can share the construction logic. Confirms REQ-ORD-006b's "unchanged path" claim (AC-1).

**Edit path** (`cRfqEditId` set by `editRfqResponse()`): `newResp` gets a **fresh `id`** (`uid()`, same call as the add path — nothing special-cased there), `line.rfqResponses[idx]` is replaced wholesale (old response's `id` no longer exists in the array afterward — per REQ-ORD-006 §3's explicit "no version history" scope decision), and if the edited response was the line's `committedResponseId`, that pointer is updated to the new id. This is the mechanism REQ-ORD-006 §1.2 and its requirements-gate review (independently hand-traced and confirmed sound) rely on: `renderQteSourceDriftWarn()` (§6 below, unmodified) will now see `ordLine.committedResponseId` (the new id) differ from any Quote's frozen `sourceRfqResponseId` (the old id), correctly flagging staleness with no changes to that function at all.

---

## 5. New function: `delRfqResponse(lineId, responseId)` (REQ-ORD-006c)

Add immediately after `saveRfqResponse()`:

```js
function delRfqResponse(lineId, responseId) {
  if (!EI.ord) return;
  var ord = DB.ord.find(function(o){ return o.id === EI.ord; });
  if (!ord) return;
  var line = (ord.lines || []).find(function(l){ return l.id === lineId; });
  if (!line) return;
  var resp = (line.rfqResponses || []).find(function(r){ return r.id === responseId; });
  if (!resp) return;
  var isCommitted = line.committedResponseId === responseId;
  var msg = isCommitted
    ? 'Delete this RFQ response? It is currently committed — deleting it will un-commit this line, and any Quote already built from it will show a "source pricing changed" warning.'
    : 'Delete this RFQ response?';
  if (!confirm(msg)) return;
  line.rfqResponses = (line.rfqResponses || []).filter(function(r){ return r.id !== responseId; });
  if (isCommitted) line.committedResponseId = null;
  sv(K.ord, DB.ord);
  renderRfqComparison(lineId);
  toast('RFQ response deleted');
}
```

**Fixed at spec-gate (advisory):** added `var resp = ...; if (!resp) return;` — the original draft would show a confirm dialog and a "deleted" toast for a stale/nonexistent `responseId` with no actual effect. Matches `editRfqResponse()`'s existing existence-guard style (§3) for consistency, even though the only real call sites are buttons bound to live `r.id` values, so the practical risk was low.

Matches the existing `confirm()`-gated delete convention (`delLI()`/`delSup()`, `index.html:5350` onward) rather than a custom modal — consistent with how this codebase already treats similarly low-stakes record deletion. The committed-response branch of the message satisfies REQ-ORD-006 §4's AC-8 (added at requirements-gate) — it names both consequences (un-commit, staleness banner) explicitly, in plain operator-facing language, not just internally.

Deleting the committed response sets `line.committedResponseId = null`, which — by the exact same `renderQteSourceDriftWarn()` comparison as the edit path — correctly flags any Quote already converted from it as stale (`null !== '<the old id>'`).

Deleting a non-committed response only removes that array entry; `committedResponseId` (pointing at a different response, if any) is untouched (AC-6).

---

## 6. `renderRfqComparison()` — Edit and Delete buttons per row (REQ-ORD-006d)

Replace the per-row action cell (`index.html:3220`, inside the `.map()` building `rows`):

```js
      '<td><button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="ordCommitRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">' + (committed ? 'Uncommit' : 'Commit') + '</button></td>' +
```

with:

```js
      '<td style="white-space:nowrap;">' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="ordCommitRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">' + (committed ? 'Uncommit' : 'Commit') + '</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;" onclick="editRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Edit</button> ' +
        '<button class="btn btn-g" style="font-size:.44rem;padding:1px 5px;border-color:var(--cr);color:var(--cr);" onclick="delRfqResponse(\'' + lineId + '\',\'' + r.id + '\')">Del</button>' +
      '</td>' +
```

`white-space:nowrap` prevents the three buttons wrapping mid-row, matching the existing convention used for similarly multi-button action cells elsewhere in this file (e.g. `rQte()`'s Edit/Preview/Del action column). Delete styled with the existing "destructive action" red border/text convention (`border-color:var(--cr);color:var(--cr);`), matching `rQte()`'s own Del button styling exactly, rather than inventing a new visual treatment.

No other part of `renderRfqComparison()` changes — the empty-state branch (`index.html:3200-3204`, "No RFQ responses recorded yet.") has no responses to attach Edit/Delete to and is untouched.

---

## 7. Test plan (`tests/run.js`)

Extends the existing Order Request / RFQ-comparison test coverage — no new mocking mechanism, pure DOM-mock + DB-state assertions throughout, matching this REQ's own §5 (fixed at requirements-gate to cite the correct fixtures):

- **`mkOrdWithLine()`** (`tests/run.js:7315-7325` — confirmed at spec-gate to be the function itself; the previously-cited `7313` line is a `console.log` section header, not part of the fixture — REQ-QTE-001 Part B's fixture) — reuse for the response-mutation half of AC-1/AC-2/AC-3/AC-6/AC-7/AC-8: seed an Order Request line with one or two `rfqResponses`, exercise `editRfqResponse()`/`saveRfqResponse()`/`delRfqResponse()` directly (bypassing the DOM open/close, matching how `saveRfqResponse()` is presumably already tested today — check the existing test for it and follow the same call style), assert on the resulting `line.rfqResponses`/`line.committedResponseId` shape.
- **`mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()`** (`tests/run.js:7712-7735`, REQ/SPEC-INTEG-001 Phase 1's fixture) — reuse for the Quote/staleness half of AC-4/AC-5: the existing fixture already produces a Quote with `sourceRfqResponseId` set from a committed response; edit or delete that same response via this SPEC's new functions, then call `renderQteSourceDriftWarn(q)` (unmodified) and assert the banner element (`qt-drift-warn`) is populated — exactly mirroring however the existing REQ-QTE-001 Part B staleness tests already assert on that same element, for consistency.
- **AC-8 (confirm-message content):** capture `confirm()`'s argument (matching the exact existing pattern for `delSup()`'s AC-011, `tests/run.js:7467-7481` — a mocked `confirm` that records its message argument, then `assertContains`), verify the committed-response delete path's message names both the un-commit and staleness-warning consequences, and that the non-committed path's message does not (simpler wording, no false alarm).
- **AC-1 regression check:** confirm that a "+ Add Response" call sequence (with `cRfqEditId` never set) still produces byte-identical `line.rfqResponses` output to what today's pre-this-SPEC tests already assert — if any existing `saveRfqResponse()` test exists, it should need **zero changes** to keep passing, since the unchanged path is untouched logic, just relocated into a named variable (§4).
- **Test-isolation requirement, added at spec-gate (§10):** `resetDB()` (`tests/run.js:181`) resets `ctx.DB` only — it does not reset module-level UI state like `cRfqOrdId`/`cRfqLineId`/the new `cRfqEditId`. Several existing RFQ tests already set `cRfqOrdId`/`cRfqLineId` by hand rather than going through `openRfqResponse()`. Any new test that calls `editRfqResponse()` without a following `saveRfqResponse()` **must** explicitly reset `ctx.cRfqEditId = null` afterward (or every "add" test must explicitly set it to `null` itself before calling `saveRfqResponse()`) — otherwise a leaked truthy `cRfqEditId` from one test silently reroutes a later, unrelated test's `saveRfqResponse()` call into the edit branch's `idx > -1` check, which finds no match against a freshly-seeded line's response ids and **skips the `push()` entirely**, causing an unrelated test to fail with no expected-value mismatch to explain why. Confirmed to be a real trap by the spec-gate reviewer tracing the exact guard condition — not a hypothetical.

---

## 8. `AI_SYSTEM_PROMPT` update (REQ-ORD-006 §7)

The existing RFQ-comparison description in `AI_SYSTEM_PROMPT` (search for "Compare RFQs" / "+ Add Response" in the prompt array) should gain a short addition noting Edit/Delete are now available per response, so the AI chat assistant can accurately describe the feature if asked — mirroring the same obligation `REQ-QTE-002` fulfilled for its own feature area.

---

## 9. `docs/requirements-tracker.md` / `STACKD_CONTEXT.md`/`CLAUDE.md` updates required on completion

Per `REQ-ORD-006` §7 — new tracker row, version-ship housekeeping, `AI_SYSTEM_PROMPT` update per §8 above.

---

## 10. Spec-gate review-resolution log

Independent spec-gate review returned **PASS**, no blocking findings. The highest-risk item — the id-rotation/repoint staleness mechanism (§4) — was verified by the reviewer actually extracting the proposed code into a standalone runnable harness and executing the exact scenario end-to-end against the real, unmodified `renderQteSourceDriftWarn()`, for both the edit path and the delete path, both committed and non-committed — not just reasoned about in prose. Every "before" diff block (§2, §4, §5, §6) was confirmed byte-identical to the real current file. Both cited test fixtures (`mkOrdWithLine()`, `mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()`) were confirmed real, correctly shaped, and genuinely reusable without building anything from scratch. Three advisories, all addressed:

1. **`delRfqResponse()` had no existence guard** — a stale/nonexistent `responseId` would still show a confirm dialog and a "deleted" toast with no actual effect. **Fixed:** added `var resp = ...; if (!resp) return;`, matching `editRfqResponse()`'s existing guard style.
2. **Edit UX gap when the response's original supplier was deleted** — `delSup()`'s own accepted design leaves a deleted supplier's id in place on referencing records rather than nulling it, so the edit form's supplier dropdown would show nothing selected in that case. **Addressed:** documented as a known, accepted edge case in §3 — the same trade-off class `delSup()` already made, not a new gap this SPEC introduces, and not required by any AC.
3. **Test-isolation risk: `cRfqEditId` can leak between tests** — `resetDB()` doesn't reset module-level UI state, and a leaked truthy `cRfqEditId` from one test would silently reroute a later, unrelated test's `saveRfqResponse()` into a no-op edit branch. **Fixed:** added an explicit test-isolation requirement to §7, with the reviewer's traced explanation of exactly how the failure mode manifests, so whoever implements the tests doesn't rediscover it the hard way.

Also corrected a minor citation: `mkOrdWithLine()`'s cited line range included a `console.log` section header rather than the function itself — fixed to the precise function-body range.

Proceeding to implementation.
