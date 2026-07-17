# REQ-CON-003-v3: Backfill missing `id` on malformed Contact records

**Supersedes:** REQ-CON-003-v2 (requirements-gate FAIL — every citation added in v2 was off by several lines from the actual code: the four `ord.contactId` assignment sites, `uid()`'s definition line, and the `rSup()` line in `DATA-GAP-004` all pointed at the wrong location, even though the underlying conclusions held up when re-traced independently)

## Business Context

Reported directly by the user: a stray, blank Contact record (no name, no email, showing `CON-0001` after a reload triggered `backfillRefNums()`) could not be deleted or edited through the UI. Root-caused by direct code read:

- `rCon()` (`index.html:9377-9379`) generates each row's Edit/Del/Quote buttons via string concatenation: `onclick="delCon('" + c.id + "')"`. If `c.id` is JS `undefined` (a malformed record — likely a corrupted/legacy record predating consistent `id` assignment, or a bad import/restore path), string concatenation coerces it to the literal text `undefined`, so the generated markup is `onclick="delCon('undefined')"` — a **string** `'undefined'`, not the real `undefined` value.
- `delCon(id)` (`index.html:9527-9536`) filters `DB.con = DB.con.filter(function(c){ return c.id !== id; })`. For the malformed record, `c.id` (real `undefined`) `!== 'undefined'` (the string) evaluates `true` — so the record is always kept, and the delete silently no-ops every time.
- `editCon(id)` (`index.html:9403-9404`) uses `DB.con.find(function(x){ return x.id === id; })` — the same string/undefined mismatch means Edit also silently fails to locate the record (`if (!c) return;` at line 9405 exits quietly, no error surfaced to the operator).

The user worked around this immediately via a manual browser-console fix (`DB.con = DB.con.filter(c => c.id); ...; location.reload()`), which is not a repeatable or discoverable fix for a future recurrence — the user then asked for a proper fix so any future id-less Contact record is deletable/editable normally through the UI rather than needing console surgery.

## Cross-reference risk check (new in v2 — direct code investigation, per requirements-gate v1 finding)

`delCon()` already nulls any `DB.ord.contactId` pointing at the deleted contact (`index.html:9530`: `DB.ord.forEach(function(o){ if (o.contactId === id) o.contactId = null; })`). The requirements-gate v1 concern: if any existing `DB.ord` record holds a real `contactId: undefined` (as opposed to a real id string or an explicit `null`), assigning the malformed contact a fresh real `id` would make that stale `undefined`-valued reference permanently unmatchable by either this cleanup path or any future delete.

Checked directly: every code path that sets `ord.contactId` (`index.html:2524`, `2540`, `2815`, `6754`) assigns either a real contact `id` string, or (at `2815`, the manual Order Request form) `G('of-contact').value`, which defaults to an empty string `''` when unset — never JS `undefined`. `'' === undefined` is `false`, so an unset-dropdown Order Request was never coincidentally "pointing at" any id-less contact via a shared `undefined` value in the first place — there is no real orphaning scenario here, since nothing in the app ever writes literal `undefined` into `contactId`. No pre-backfill cleanup step is needed.

## `uid()` collision surface (new in v2 — honest characterization, per requirements-gate v1 finding)

`uid()` (`index.html:2379`: `Date.now().toString(36) + Math.random().toString(36).slice(2,5)`) is the same generator used for every `id` assigned anywhere else in this app (`index.html:2498`, `2524`, `2540`, `2582`, and every other entity's create path) — this REQ does not introduce a new or different collision risk, it uses the existing, already-trusted-everywhere mechanism as-is. Its actual collision surface: two calls within the same millisecond share the `Date.now()` prefix and rely solely on a 3-character base36 random suffix (46,656 possibilities) to differ — a small but nonzero risk, already accepted implicitly by every other entity's creation path in this codebase. This REQ neither improves nor worsens that existing, accepted tradeoff; it is explicitly out of scope to address `uid()`'s collision characteristics generally.

## Known gap logged (new in v2 — per requirements-gate v1 finding)

**DATA-GAP-004** (new): The same string-concatenation onclick pattern that caused this bug in `rCon()` (`onclick="delCon('" + c.id + "')"`) is also present in `rSup()` (`index.html:4192`), `rLI()` (`index.html:4331`), and `rPO()` (`index.html:5742`, `5744`) — `onclick="editSup(\'' + s.id + '\')"` and equivalents. Any of those entities would exhibit the identical delete/edit no-op failure mode if a record in `DB.sup`/`DB.li`/`DB.po` were ever missing its `id`. No such malformed record has been reported for those entities — this REQ fixes only the confirmed `DB.con` defect (REQ-CON-003a) and does not preemptively backfill `id` on `sup`/`li`/`po`/`inv`/`ord`, consistent with fixing what's actually broken rather than guessing at unconfirmed failure modes elsewhere. Logged so a future report against any of those entities is recognized immediately as the same root cause, not re-diagnosed from scratch.

## FM-1 Assessment

No new `K`/`DB`/`EI` entity, no new field on the `DB.con` schema — this backfills the *existing* `id` field (which every other entity/every non-malformed contact already has) onto any record currently missing it. Same category as the existing `backfillRefNums()` precedent (`index.html:2405-2435`), which already backfills a missing `num` the same way, at the same call sites. Falls under FM-1 exception item 1 (`STACKD_CONTEXT.md:111`) — a defensive data-integrity fix to an existing field, not a new entity or field. No separate council decision required.

## Requirements

**REQ-CON-003a (backfill function):** Add a function that assigns a fresh `id` (via the existing `uid()` helper, same generator used everywhere else in the app) to any `DB.con` record where `id` is falsy (`undefined`, `null`, or an empty string). Scope is `DB.con` only — this REQ fixes the specific, confirmed defect reported by the user; it does not preemptively backfill `id` on other entities absent any evidence they have the same defect (tracked instead as `DATA-GAP-004` above).

**REQ-CON-003b (call sites — same as `backfillRefNums()`'s precedent):** Call the new backfill function at the same points `backfillRefNums()` already runs: on `initApp()` (`index.html:10191` area), immediately after a backup restore (`index.html:8462` area), and after a Sheets pull (`index.html:3622`, inside `pullAll()`) — so any id-less record self-heals the next time the app loads or syncs, matching the existing self-healing pattern already established for missing `num`s. Placed adjacent to the existing `backfillRefNums()` call at each site.

**REQ-CON-003c (persistence):** If any record was backfilled, the function calls `sv(K.co, DB.con)` (mirroring `backfillRefNums()`'s own `if (changed) saveAll();` pattern, scoped to just the `co` entity since that's the only entity this REQ touches) so the fix survives without requiring a further save action from the operator.

**REQ-CON-003d (no change to delete/edit logic itself):** `delCon()`/`editCon()` are not modified — the fix is upstream (ensuring `id` is always real before these functions ever run), not downstream (adding defensive parsing to every id-comparison call site across the app). This keeps the fix small and localized, consistent with the existing `backfillRefNums()` precedent's own design.

**REQ-CON-003e (no cross-reference cleanup needed):** Per the "Cross-reference risk check" section above, no pre-backfill cleanup of `DB.ord.contactId` (or any other cross-reference) is needed — confirmed no code path ever writes a literal `undefined` into `contactId`, so no coincidental orphaning is possible.

## Acceptance Criteria

- AC-001: A `DB.con` record with `id: undefined` (or missing entirely) is assigned a real, non-empty `id` string after the backfill function runs.
- AC-002: A `DB.con` record that already has a real `id` is left completely unchanged (same `id` value, same reference) by the backfill function.
- AC-003: After backfill, `delCon(newlyAssignedId)` successfully removes the record — the exact failure mode reported by the user is fixed.
- AC-004: After backfill, `editCon(newlyAssignedId)` successfully locates and opens the record for editing.
- AC-005: If no record needed backfilling, `sv(K.co, DB.con)` is not called unnecessarily (mirrors `backfillRefNums()`'s own `if (changed)` guard — no wasted writes on every load).
- AC-006: The backfill function runs at `initApp()`, post-restore, and post-`pullAll()` — the same three call sites as `backfillRefNums()` — confirmed via direct code citation, not assumed.
- AC-007 (new): Two `DB.con` records both missing `id` in the same backfill run each receive distinct, non-colliding `id` values.

## Changelog

- v3: Corrected every line citation added in v2, each re-verified directly against the live file: `ord.contactId` assignment sites are `index.html:2524` (`q.sourceContactId`), `2540` (`c.id`, inside `backfillOrderRequests()`), `2815` (`G('of-contact').value`), and `6754` (`contact.id`) — not the `2535`/`2551`/`2825`/`6764` originally cited, which pointed at unrelated lines (a `.some()` call, a closing brace, a `closeM()` call, and another closing brace respectively). `uid()`'s definition is at `index.html:2379`, not `2389`. `DATA-GAP-004`'s `rSup()` citation is `index.html:4192`, not `4202`; `rLI()` is `index.html:4331`, not `4341` (`rPO()`'s `5742`/`5744` were already correct). The underlying conclusions in all three sections were unaffected by the citation errors and remain unchanged (requirements-gate v2 finding).
- v2: Added an explicit cross-reference risk check confirming no code path ever writes literal `undefined` into `DB.ord.contactId`, ruling out the orphaning scenario requirements-gate v1 raised. Rewrote the `uid()` collision-safety claim to honestly describe its actual (small, pre-existing, already-accepted-elsewhere) collision surface rather than asserting it as fully proven. Logged `DATA-GAP-004` documenting the same string-concatenation onclick vulnerability in `rSup()`/`rLI()`/`rPO()`, scoped as a known gap rather than silently unaddressed. Added AC-007 for the multi-record-in-one-run case.
- v1: Initial requirements draft (requirements-gate FAIL — see above).
