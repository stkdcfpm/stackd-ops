# SPEC-INV-001-v1: Fix over-broad "no library link" COGS warning

**Implements:** REQ-INV-001-v1 (requirements-gate PASS)

## 1. `_updQaWarn()` (`index.html:4449-4460`)

```js
function _updQaWarn() {
  var qaCount = cIL.filter(function(li){
    var resolved = li.lid && DB.li.find(function(x){ return x.id === li.lid; });
    var hasCost = +li.unitCost > 0;
    return !resolved && !hasCost;
  }).length;
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

Mirrors `cInv()`'s (`index.html:3636-3640`) and `calcInv()`'s (`index.html:4531`) exact resolution logic — `DB.li.find(x => x.id === li.lid)` — rather than inventing a new rule. A line counts toward the warning only when it has **neither** a resolved library match **nor** a positive `unitCost`, matching REQ-INV-002/003 exactly:

- No `lid`, `unitCost` 0/blank → counted (AC-001, unchanged behavior for the genuine-risk case).
- No `lid`, `unitCost` > 0 → not counted (AC-002, the fix — INV10032's exact scenario).
- `lid` resolves to a real `DB.li` record → not counted regardless of `unitCost` (AC-003, unchanged).
- `lid` set but doesn't resolve (dangling — e.g. catalogue item deleted since), `unitCost` 0/blank → counted (AC-004, new — today's `!li.lid` check misses this entirely since it only checks presence of the string, not resolution).
- `lid` dangling but `unitCost` > 0 → not counted (implied by the same "neither resolved nor cost" rule — not explicitly called out as a separate AC, but falls out correctly from the formula rather than needing special-casing).

## 2. No other changes

Warning text, CTA, display element, and every call site (`index.html:4318`, `4409`, and inside `quickAddLine()`) are unchanged — only `_updQaWarn()`'s internal counting logic changes, per REQ-INV-004.

## 3. Tests (`tests/run.js`)

New suite `Invoice quick-add COGS warning (SPEC-INV-001)`:
- Line with no `lid`, `unitCost: 0` → counted.
- Line with no `lid`, `unitCost: 4600` → not counted (the INV10032 regression case).
- Line with `lid` resolving to a real `DB.li` record → not counted, regardless of `unitCost` value.
- Line with a dangling `lid` (set, but no matching `DB.li` record exists) and `unitCost: 0` → counted.
- Line with a dangling `lid` and `unitCost: 262` → not counted.
- Mixed invoice (2 genuinely-at-risk lines + 2 safe lines) → count reflects only the 2 at-risk lines.
- Since `_updQaWarn()` reads/writes DOM elements (`cIL`, `inv-qa-warn`, `inv-qa-warn-count`) rather than being a pure function, tests call it directly against `ctx.cIL` (set up per-case) and assert `mockEl('inv-qa-warn-count').textContent` / `mockEl('inv-qa-warn').style.display`, mirroring how other DOM-coupled functions are already tested in the existing suite.

## Changelog

- v1: Initial spec, translating REQ-INV-001-v1's corrected trigger condition into `_updQaWarn()`.
