# REQ-INV-001-v1: Fix over-broad "no library link" COGS warning

## Business Context

Reported directly by the user against a real invoice (INV10032): the invoice modal shows an amber warning — *"N line item(s) added without a library link — COGS will be £0 for these lines and profit calculations will be understated. Use Import from Library to fix."* — whenever any line item lacks a catalogue link (`lid`), regardless of whether a Unit Cost was actually entered for that line.

Confirmed by direct code read this is a false-alarm-prone warning, not accurate to what the app actually calculates:

- `_updQaWarn()` (`index.html:4449-4460`) counts a line as "at risk" purely on `!li.lid` (`index.html:4450`) — it never checks whether `li.unitCost` is populated.
- The actual COGS calculation, `cInv()` (`index.html:3634-3644`), already has a fallback: for a line with no resolved library match, it uses `li.unitCost` directly (`index.html:3639`: `return s + (+li.unitCost||0) * (+li.qty||0);`). COGS is only genuinely `£0` for a line when **both** conditions hold: no resolved `lid` match **and** `unitCost` is zero/blank. The in-modal live preview, `calcInv()` (`index.html:4531`), has the identical fallback logic, confirming this isn't a display-only quirk — the real calculation already handles this case correctly.
- `quickAddLine()` (`index.html:4438`) always writes an explicit `unitCost` field on every line it creates (never `undefined`) — for the reported invoice, all 4 quick-added lines (Ocean Freight, Customs Clearance, Local Freight, Loading Charge) had Unit Cost set equal to Unit Price (0% margin, a deliberate pass-through charge), so COGS for those lines was already computing correctly as non-zero. The warning fired anyway, because it doesn't look at `unitCost` at all.

This REQ fixes the warning's trigger condition to match the real risk `cInv()`/`calcInv()` already protect against, rather than a broader "not catalogued" condition that fires even when cost data is genuinely present.

## FM-1 Assessment

Pure bug fix to existing display logic in `index.html` — no new `K`/`DB` entity, no new field, no Sheets sync change. Outside FM-1's scope entirely (same category as the earlier `SYNC-GAP-001` fix — correcting already-shipped code, not a new feature).

## Requirements

**REQ-INV-002**: `_updQaWarn()`'s count must only include a line item if it has **both** (a) no library match — no `lid`, or a `lid` that doesn't resolve to an existing `DB.li` record (dangling reference) — **and** (b) `unitCost` is zero, blank, or otherwise falsy. A line with a populated non-zero `unitCost` (regardless of `lid`) must not count toward the warning, since `cInv()`/`calcInv()` already correctly use that value for COGS.

**REQ-INV-003**: The "dangling `lid`" case (a `lid` is set but no longer resolves to a real `DB.li` record — e.g. the catalogue item was deleted) must be treated the same as "no `lid` at all" for this check, mirroring exactly how `cInv()`'s own per-line fallback already works (`DB.li.find(...)` either resolves or falls through to `unitCost`) — not a new rule, just matching the existing calculation's actual behavior.

**REQ-INV-004**: No change to the warning's visual presentation, placement, or the "Use Import from Library to fix" call-to-action text — only the count/trigger condition changes. (Whether the wording itself should also change for legitimate zero-margin pass-through charges, per the earlier conversation, is explicitly out of scope for this REQ — the user asked specifically for the trigger-condition fix, not the wording change.)

## Acceptance Criteria

- AC-001: A line with no `lid` and `unitCost` of `0` (or blank/undefined) counts toward the warning — unchanged from today's behavior for the genuine-risk case.
- AC-002: A line with no `lid` but a populated non-zero `unitCost` does **not** count toward the warning (the fix — this is the exact INV10032 scenario: Ocean Freight, Unit Cost 4600, no library link).
- AC-003: A line with a `lid` that resolves to a real `DB.li` record does not count toward the warning (unchanged — already correctly excluded today via `!li.lid`, and remains excluded here since the true condition is stricter).
- AC-004: A line with a `lid` that does **not** resolve to any current `DB.li` record (dangling reference — e.g. deleted catalogue item) and a zero/blank `unitCost` **does** count toward the warning (new — today's `!li.lid` check misses this case entirely, since it only checks for the ID's presence, not its resolution; the actual COGS calc has the same £0 risk here as it does for a totally unlinked line with no cost, so the warning should catch it too).
- AC-005: The warning's message text and CTA are unchanged — only which lines get counted changes.
- AC-006: Re-opening/re-editing an existing invoice (not just quick-adding new lines) re-evaluates the warning correctly against its saved `lineItems[]`, using the same corrected logic.
