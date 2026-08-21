# REQ-CON-003-v4: Backfill missing `id` on malformed Contact records

**Supersedes:** REQ-CON-003-v3 (requirements-gate FAIL — three rounds in a row, citation accuracy was still wrong: the `ord.contactId` assignment sites were off by one line each, the `delCon()`/`editCon()`/`rCon()` onclick citations in Business Context were never actually re-verified in v2/v3 despite being present since v1, and the `delCon()` internal `forEach` line was wrong. v4 re-derives every single citation in this document via `grep -n` against the live file rather than manual line-counting.)

## Business Context

Reported directly by the user: a stray, blank Contact record (no name, no email, showing `CON-0001` after a reload triggered `backfillRefNums()`) could not be deleted or edited through the UI. Root-caused by direct code read:

- `rCon()` (`index.html:9369`: `onclick="delCon('" + c.id + "')"`, part of the row's Edit/Del/Quote button group at `index.html:9367-9369`) generates each row's action buttons via string concatenation. If `c.id` is JS `undefined` (a malformed record — likely a corrupted/legacy record predating consistent `id` assignment, or a bad import/restore path), string concatenation coerces it to the literal text `undefined`, so the generated markup is `onclick="delCon('undefined')"` — a **string** `'undefined'`, not the real `undefined` value.
- `delCon(id)` (`index.html:9517-9526`) filters `DB.con = DB.con.filter(function(c){ return c.id !== id; })` (`index.html:9519`). For the malformed record, `c.id` (real `undefined`) `!== 'undefined'` (the string) evaluates `true` — so the record is always kept, and the delete silently no-ops every time.
- `editCon(id)` (`index.html:9393-9394`) uses `DB.con.find(function(x){ return x.id === id; })` — the same string/undefined mismatch means Edit also silently fails to locate the record (`if (!c) return;` at `index.html:9395` exits quietly, no error surfaced to the operator).

The user worked around this immediately via a manual browser-console fix (`DB.con = DB.con.filter(c => c.id); ...; location.reload()`), which is not a repeatable or discoverable fix for a future recurrence — the user then asked for a proper fix so any future id-less Contact record is deletable/editable normally through the UI rather than needing console surgery.

## Cross-reference risk check

`delCon()` already nulls any `DB.ord.contactId` pointing at the deleted contact (`index.html:9520`: `DB.ord.forEach(function(o){ if (o.contactId === id) o.contactId = null; });`). The requirements-gate v1 concern: if any existing `DB.ord` record holds a real `contactId: undefined` (as opposed to a real id string or an explicit `null`), assigning the malformed contact a fresh real `id` would make that stale `undefined`-valued reference permanently unmatchable by either this cleanup path or any future delete.

Checked directly (each verified via `grep -n` against the live file): every code path that sets `ord.contactId` is `index.html:2525` (`contactId: q.sourceContactId, stage: stage,` — inside `backfillOrderRequests()`'s Quote-derived backfill branch), `index.html:2541` (`contactId: c.id, stage: stage,` — inside the same function's Contact-enquiry-derived backfill branch), `index.html:2815` (`contactId: G('of-contact').value,` — the manual Order Request form's save path), and `index.html:6754` (`contactId: contact.id,` — the Order Request CSV import's contact match-or-create path). The first two always assign a real id (`q.sourceContactId`/`c.id`, both already-real ids by the time these branches run); the form path defaults to an empty string `''` when the dropdown is unset — never JS `undefined`; the CSV path's `contact` is always either a matched existing record or a freshly `uid()`-created one. `'' === undefined` is `false`, so an unset-dropdown Order Request was never coincidentally "pointing at" any id-less contact via a shared `undefined` value in the first place — there is no real orphaning scenario here, since nothing in the app ever writes literal `undefined` into `contactId`. No pre-backfill cleanup step is needed.

## `uid()` collision surface

`uid()` (`index.html:2379`: `const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,5);`) is the same generator used for every `id` assigned anywhere else in this app — this REQ does not introduce a new or different collision risk, it uses the existing, already-trusted-everywhere mechanism as-is. Its actual collision surface: two calls within the same millisecond share the `Date.now()` prefix and rely solely on a 3-character base36 random suffix (46,656 possibilities) to differ — a small but nonzero risk, already accepted implicitly by every other entity's creation path in this codebase. This REQ neither improves nor worsens that existing, accepted tradeoff; it is explicitly out of scope to address `uid()`'s collision characteristics generally.

## Known gap logged

**DATA-GAP-004** (new, also added to `docs/known-gaps.md` and `CLAUDE.md`'s summary table): The same string-concatenation onclick pattern that caused this bug in `rCon()` (`index.html:9369`: `onclick="delCon('" + c.id + "')"`) is also present in `rSup()` (`index.html:4192`: `onclick="editSup(\'' + s.id + '\')"`/`onclick="delSup(\'' + s.id + '\')"`), `rLI()` (`index.html:4331`: `onclick="editLI(\'' + li.id + '\')"`/`onclick="delLI(\'' + li.id + '\')"`), and `rPO()` (`index.html:5742`/`5744`: `onclick="editPO(\'' + po.id + '\')"`/`onclick="delPO(\'' + po.id + '\')"`). Any of those entities would exhibit the identical delete/edit no-op failure mode if a record in `DB.sup`/`DB.li`/`DB.po` were ever missing its `id`. No such malformed record has been reported for those entities — this REQ fixes only the confirmed `DB.con` defect (REQ-CON-003a) and does not preemptively backfill `id` on `sup`/`li`/`po`/`inv`/`ord`, consistent with fixing what's actually broken rather than guessing at unconfirmed failure modes elsewhere. Logged so a future report against any of those entities is recognized immediately as the same root cause, not re-diagnosed from scratch.

## FM-1 Assessment

No new `K`/`DB`/`EI` entity, no new field on the `DB.con` schema — this backfills the *existing* `id` field (which every other entity/every non-malformed contact already has) onto any record currently missing it. Same category as the existing `backfillRefNums()` precedent (`index.html:2395-2425`, function body between `function backfillRefNums()` at `2395` and the next function, `migrateLinkedPOIds()`, at `2426`), which already backfills a missing `num` the same way, at the same call sites. Falls under FM-1 exception item 1 (`STACKD_CONTEXT.md:111`) — a defensive data-integrity fix to an existing field, not a new entity or field. No separate council decision required.

## Requirements

**REQ-CON-003a (backfill function):** Add a function that assigns a fresh `id` (via the existing `uid()` helper, same generator used everywhere else in the app) to any `DB.con` record where `id` is falsy (`undefined`, `null`, or an empty string). Scope is `DB.con` only — this REQ fixes the specific, confirmed defect reported by the user; it does not preemptively backfill `id` on other entities absent any evidence they have the same defect (tracked instead as `DATA-GAP-004` above).

**REQ-CON-003b (call sites — same as `backfillRefNums()`'s precedent):** Call the new backfill function at the same points `backfillRefNums()` already runs (all four call sites confirmed via `grep -n "backfillRefNums();"`): `index.html:2550` (inside `backfillOrderRequests()`, conditional on `changed`), `index.html:3612` (inside `pullAll()`), `index.html:8452` (post-restore), and `index.html:10181` (inside `initApp()`) — so any id-less record self-heals the next time the app loads, restores a backup, or syncs, matching the existing self-healing pattern already established for missing `num`s. Placed adjacent to the existing `backfillRefNums()` call at each site.

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

- v4: Re-derived and corrected every single line citation in this document via `grep -n` against the live `index.html`, rather than the manual/approximate line-counting that produced two consecutive citation-accuracy FAILs in v2 and v3. Fixed: the `ord.contactId` assignment sites (now `2525`/`2541`/`2815`/`6754`, corrected from `2524`/`2540`/`2815`/`6754`); the `delCon()` internal `forEach` line (now `9520`, corrected from `9530`); the `rCon()`/`delCon()`/`editCon()` Business Context citations, which had never actually been re-verified since v1 despite two subsequent revisions (now `9367-9369`/`9517-9526`/`9393-9395` respectively); and the four `backfillRefNums()` call-site citations in REQ-CON-003b (now `2550`/`3612`/`8452`/`10181`, corrected from approximate "~10191 area"/"~8462 area" language that was never pinned to an exact grep-verified line). No requirement, acceptance criterion, or conclusion changed in substance — only citation accuracy (requirements-gate v3 finding).
- v3: Corrected line citations added in v2 (still contained further errors — see v4 above; not a complete fix despite the changelog entry below claiming full re-verification).
- v2: Added an explicit cross-reference risk check confirming no code path ever writes literal `undefined` into `DB.ord.contactId`, ruling out the orphaning scenario requirements-gate v1 raised. Rewrote the `uid()` collision-safety claim to honestly describe its actual (small, pre-existing, already-accepted-elsewhere) collision surface rather than asserting it as fully proven. Logged `DATA-GAP-004` documenting the same string-concatenation onclick vulnerability in `rSup()`/`rLI()`/`rPO()`, scoped as a known gap rather than silently unaddressed. Added AC-007 for the multi-record-in-one-run case.
- v1: Initial requirements draft (requirements-gate FAIL — see above).
