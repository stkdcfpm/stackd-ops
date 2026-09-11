# SPEC-INV-002-v1: Block saving a Product line item with no cost basis

Implements REQ-INV-002-v1 (requirements-gate: PASS, confirmatory round 2).

## 1. Shared cost-basis helper (prerequisite for REQ-INV-008)

REQ-INV-008 requires the "no cost basis" sub-condition to have exactly one implementation, reused everywhere it's needed, rather than copy-pasted and risking divergence. Add a new top-level function immediately before `quickAddLine()` (`index.html:8139`):

```js
function invLineHasCostBasis(li) {
  var resolved = li.lid && DB.li.find(function(x){ return x.id === li.lid; });
  return !!resolved || (+li.unitCost > 0);
}
```

This is `_updQaWarn()`'s existing per-line condition (`index.html:8161-8163`: `var resolved = li.lid && DB.li.find(...); var hasCost = +li.unitCost > 0; return !resolved && !hasCost;`) extracted verbatim and inverted to a positive predicate ("does have a cost basis" rather than "is at risk").

Refactor `_updQaWarn()` (`index.html:8159-8174`) to call it, with **no behavioral change** — it keeps counting every line type, exactly as REQ-INV-002's "Out of scope" section requires:

```js
function _updQaWarn() {
  var qaCount = cIL.filter(function(li){ return !invLineHasCostBasis(li); }).length;
  var el = G('inv-qa-warn');
  var ct = G('inv-qa-warn-count');
  if (!el) return;
  if (qaCount > 0) {
    if (ct) ct.textContent = qaCount;
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}
```

This is a pure extraction — the five existing `_updQaWarn()` tests (`tests/run.js:2206-2258`) must pass unmodified against the refactored function, proving no behavior changed. Do not add `lineType` scoping to `invLineHasCostBasis()` itself or to the refactored `_updQaWarn()` — the `lineType === 'product'` gate belongs only at the two new call sites below (REQ-INV-006/REQ-INV-008's explicit warning against copying the condition wholesale into a scoped context).

## 2. `quickAddLine()` entry gate (REQ-INV-005/REQ-INV-006)

In `quickAddLine()` (`index.html:8139-8157`), insert the check after the existing `!desc` guard and before the `qty === 0` normalization:

```js
function quickAddLine() {
  var desc = G('qal-desc') ? G('qal-desc').value.trim() : '';
  var uom  = G('qal-uom')  ? G('qal-uom').value.trim()  : 'pcs';
  var qty  = G('qal-qty')  ? +G('qal-qty').value  : 1;
  var up   = G('qal-up')   ? +G('qal-up').value   : 0;
  var lt   = G('qal-type') ? G('qal-type').value   : 'product';
  var uc   = lt === 'pass-through' ? up : (G('qal-uc') ? +G('qal-uc').value : 0);
  if (!desc) { toast('⚠ Enter a description'); return; }
  if (lt === 'product' && !invLineHasCostBasis({ lid:'', unitCost:uc })) {
    toast('⚠ Product lines need a Unit Cost greater than 0 — enter a real cost, or set Type to Pass-thru/Charge if there\'s no separate cost to record');
    return;
  }
  if (qty === 0) qty = 1;
  cIL.push({ rid:uid(), lid:'', desc:desc, uom:uom, qty:qty, up:up, unitCost:uc, lineType:lt });
  rILT(); calcInv();
  if (G('qal-desc')) G('qal-desc').value = '';
  if (G('qal-up'))   G('qal-up').value   = '';
  if (G('qal-uc'))   G('qal-uc').value   = '';
  if (G('qal-qty'))  G('qal-qty').value  = '1';
  if (G('qal-type')) { G('qal-type').value = 'product'; qaTypeChg(); }
  toast('✓ Line item added — click Save Invoice to keep');
}
```

Passing `{ lid:'', unitCost:uc }` (rather than `lid:'', unitCost:uc` inline) to `invLineHasCostBasis()` is deliberate: `quickAddLine()` never sets a `lid` on the line it's about to create (manual entry has no catalogue-link UI), so the `lid` half of the check is always `''` here — the call still goes through the shared helper rather than inlining `uc <= 0`, so a future change to what counts as "has cost basis" only needs to change one function.

On refusal: no `toast('✓ Line item added...')`, no `cIL.push`, no form-clear, no `rILT()`/`calcInv()` re-render. The operator's already-typed values stay in the form so they can fix and retry.

## 3. `vInv()` save-time backstop (REQ-INV-007/REQ-INV-009)

In `vInv()` (`index.html:10597-10647`), insert immediately after the existing `cIL.length === 0` fallback block (after `index.html:10631`) and before the `dep` validation:

```js
  var badProductLine = cIL.some(function(li){
    var lt = li.lineType || 'product';
    return lt === 'product' && !invLineHasCostBasis(li);
  });
  if (badProductLine) {
    toast('⚠ One or more Product lines has no Unit Cost and no linked catalogue item — enter a cost, link a catalogue item, or change that line\'s Type');
    return false;
  }
```

This runs only in the non-CN branch (the `isCnForm` branch already returns at `index.html:10624`, before this point — satisfies AC-008 with no extra code). It runs on every `saveInv()` call, including the unlock-then-edit flow, because `_unlockedInvIds`/`LOCKED_STATUSES` gate whether the *status transition* is restricted (`index.html:8321`), not whether `vInv()` itself runs — `vInv()` is called unconditionally at the top of `saveInv()` (`index.html:8296: if (!vInv()) return;`), before the lock check even executes. No separate code path is needed for AC-009; this is a structural consequence of `vInv()`'s existing call position, not new wiring.

`cIL.some(...)` naturally returns `false` on an empty array, so this is a no-op (and therefore safe) when `cIL.length === 0` and the existing-`calc_grandTotal` fallback applies — it does not need to be conditioned on `cIL.length > 0` separately.

## 4. Existing test-suite audit (REQ-INV-002's "Implementation note")

Before writing new tests, audit every `ctx.cIL = [...]` fixture in `tests/run.js` (45 raw declarations per the REQ's confirmed count) that precedes a `ctx.saveInv()`/`ctx.saveCN()` call. For each:

1. If the fixture already has a `lid` that resolves to a `DB.li` record set up earlier in the same test, or a positive `unitCost`, or an explicit non-`'product'` `lineType` — **no change needed**, it already satisfies the new gate.
2. Otherwise (bare `{lid:'', desc:..., up:...}` or `unitCost:0`, `lineType` absent/`'product'`) — the fixture will now fail `vInv()` and abort the test before its own real assertions run. Fix by adding a positive placeholder `unitCost` (e.g. `unitCost:1`, or a value matching the test's own existing numbers where one is already implied) to the fixture line itself — **do not** change the test's assertions, expected totals, or any other field; the goal is only to keep the fixture passing the new save-time gate, not to alter what the test is actually verifying. Where a test is specifically about a `'pass-through'` or generic non-cost scenario, `lineType:'pass-through'` is an equally valid fix if it doesn't change the test's own intent — prefer whichever is the smaller, more local diff for that specific test.

Confirmed sites requiring this fix (from both requirements-gate rounds' live verification — re-verify at implementation time in case the file has moved since):
`tests/run.js:2660`, `:2785`, `:10113`, `:10131`, and at least 6 more in the `13100`–`13800` range (`13156`, `13203`, `13219`, `13251`, `13354`, `13772` per direct citation in REQ-INV-002).

Run `node tests/run.js` after this pass. Every previously-passing test must still pass — a fixture fix that breaks the surrounding test's own assertions is itself a bug in the fix, not an acceptable side effect.

## 5. New tests (add to `tests/run.js`, under a new `SPEC-INV-002` section)

- `invLineHasCostBasis()` direct unit tests: resolved `lid` → true regardless of `unitCost`; dangling `lid` + `unitCost:0` → false; no `lid` + `unitCost>0` → true; no `lid` + `unitCost:0`/absent → false.
- `quickAddLine()` — `lineType:'product'`, blank/zero Unit Cost → refused: `cIL` unchanged, `toast` called, form fields not cleared.
- `quickAddLine()` — `lineType:'product'`, positive Unit Cost → succeeds, unchanged from pre-existing behavior.
- `quickAddLine()` — `lineType:'pass-through'`, blank Unit Cost → succeeds (`unitCost` auto-set to `up`).
- `quickAddLine()` — `lineType:'charge'`, blank/zero Unit Cost → succeeds.
- `vInv()`/`saveInv()` — a `'product'` line with no `lid` and `unitCost:0` → save refused, `DB.inv` unchanged (test both a new invoice and an edit of an existing one).
- `vInv()`/`saveInv()` — a `'product'` line with a resolvable `lid` and `unitCost:0` → save succeeds (catalogue link is sufficient).
- `vInv()`/`saveInv()` — a `'product'` line with no `lid` and a positive `unitCost` → save succeeds.
- `vInv()`/`saveInv()` — mixed invoice: one valid `'product'` line plus one `'pass-through'` line with `unitCost:0` → save succeeds (AC-007, proves the check is per-line and type-scoped, not invoice-wide).
- `vInv()`/`saveInv()` — mixed invoice: one valid `'product'` line plus one genuinely-bad `'product'` line → save refused (proves `.some()` catches a single bad line among otherwise-good ones).
- `vInv()` — credit note path (`isCnForm` true) with a `cIL` that would otherwise trigger the block → save proceeds to the CN-specific checks, unaffected (AC-008).
- `saveInv()` — simulate the unlock-then-edit flow (`_unlockedInvIds[id] = true`, invoice `status` in `LOCKED_STATUSES`) with a bad `'product'` line → save still refused (AC-009).
- `_updQaWarn()` — re-run the five existing tests (`tests/run.js:2206-2258`) unmodified against the refactored function; all must still pass, proving the extraction changed nothing observable.

## 6. Out of scope (unchanged from REQ)

No change to `addILI()`/`doPick()`, no change to CSV/Sheets import, no retroactive fix to already-saved invoice records, no change to `_updQaWarn()`'s trigger condition or presentation.

## 7. Mutation-test plan (build-gate / pre-merge, per CLAUDE.md safety-critical discipline)

For the `vInv()` backstop specifically (the actual enforcement point — `quickAddLine()`'s gate is UX, this is the real guarantee):

1. In a scratch copy, revert the `badProductLine` block in `vInv()`.
2. Confirm the AC-005 test (bad product line → save refused) now fails (i.e. the save wrongly succeeds).
3. Restore the block, confirm the test passes again.

Repeat the same revert/confirm/restore cycle for the `invLineHasCostBasis()` helper's `lid`-resolution branch (delete the `DB.li.find(...)` check, leaving only `unitCost > 0`) against the "resolvable `lid`, `unitCost:0` → succeeds" test, to prove that test would actually catch a regression to REQ-INV-008's exact divergence risk (a save-time check that stops honoring catalogue links as a valid cost basis).
