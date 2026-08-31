# REQ-DATA-003 — Fix CSV import corruption on multi-line quoted fields

**Status:** v1 — draft, pending requirements-gate.
**Type:** Bug fix, `index.html` only. No schema change, no new entity, no `FIELD_MAPS`/Sheets-sync footprint.

---

## 1. Business context

### 1.1 What happened (user-reported, live production data)

The user reported their Suppliers tab had become "majorly corrupted" after importing a Suppliers CSV, and pasted the resulting table. Reading it, several rows were not real suppliers at all — they were fragments of a single other supplier's multi-line Notes/address content, each fragment split off into its own new record with a real, sequential `SUP-####` number and `-` placeholders in every other column. For example, one supplier ("Joylife Industry (Dongguan) Co.,Ltd") with a multi-line address block in its Notes field produced five extra phantom rows, one holding "Address: Room 221, 2nd Building, ...", the next "Mobile: +86 180-2829-1935", the next "Email: tammy@...", and so on — each a torn-off piece of what should have been one field's content.

The user asked two questions: (1) how to clean up the already-corrupted Suppliers data, and (2) whether the Google Sheets sync (Apps Script) is corrupting data on every sync and needs to be fixed.

### 1.2 Diagnosis (from check-first this session)

Traced end-to-end against the real code:

1. **Root cause, confirmed: `parseImportCSV()` (`index.html:8074-8112`).** This function splits the raw CSV text into "rows" by literal newline (`text.trim().split(/\r?\n/)`, line 8075) **before** any quote-state tracking exists, and its per-character quote-toggling loop (lines 8085-8090) resets `inQuote = false` for every physical line (line 8084) rather than carrying that state across lines. RFC 4180 explicitly permits a quoted CSV field to contain a literal embedded newline — exactly what a multi-line Notes/Address cell copied from Excel or Google Sheets produces when exported to CSV. This parser cannot represent that: every internal newline inside such a field is treated as a hard row boundary regardless of quote state, and if a resulting line-fragment itself contains a comma, that fragment is split again into further misaligned columns.
2. **How a fragment becomes a permanent phantom-with-a-real-id record.** `processImport()`'s `sup` branch (`index.html:8122-8133`) has exactly one guard: a non-empty value in the `Supplier Name` column (positional column 0 per `TEMPLATES.sup.headers`, `index.html:8011`). Since every newline-torn fragment lands in column 0 (the column position doesn't shift — only the row count does), each fragment passes this guard and is pushed as a brand-new record with a freshly minted `id: uid()` (line 8127). The record is never assigned a `.num` at creation time.
3. **Why the fragments carry ordinary, sequential `SUP-####` numbers, not something obviously wrong.** `backfillRefNums()` (`index.html:2761-2791`) runs on every app boot, on JSON restore, and immediately after every Sheets `pullAll()`, and assigns the next sequential `SUP-####` to *any* Supplier record lacking `.num`. It has no way to distinguish a legitimate new supplier from an import-time fragment — both simply "lack a `.num`" — so every fragment silently receives a permanent, real reference number the next time the app loads, which is why the corrupted rows in the live data look superficially like ordinary records rather than obvious garbage.
4. **Confirmed: the existing phantom-record cleanup tool cannot detect or remove any of this.** `isPhantomRecord('sup', rec)` (`index.html:2801-2806`) is `return !rec.id;` for every non-Contact entity. Every fragment record has a real, non-empty `id` (minted at line 8127) — `isPhantomRecord()` returns `false` for all of them. Settings → Data → "Scan for phantom records" (REQ/SPEC-DATA-002) was purpose-built for a structurally different defect class (`SYNC-GAP-001` — old Sheets-pull field-mapping corruption producing records with a **missing** `id`) and does not, and was never designed to, catch a record that has a valid id but garbage content in the wrong field.
5. **Confirmed, by direct code read: the Google Sheets sync path is NOT at fault.** `mapRec()`/`unmapRec()` (`index.html:4229-4251`) move data as JS object properties keyed by header name — one field per Sheet cell, no delimiter-based joining or splitting of multi-field content anywhere in that path. `apps-script/Code.gs` reads/writes exclusively via `SpreadsheetApp`'s native cell-array APIs (`getDataRange().getValues()`, `getRange(...).getValues()`) — there is no `.split(` call anywhere in that file. A comma or embedded newline inside a single Sheets cell cannot be corrupted by push or pull. This directly answers the user's second question: **the Apps Script sync is not the cause and does not need fixing for this** — the corruption is specific to re-importing a CSV file containing a multi-line quoted field, via the Import Data tab's CSV upload path.
6. **This function is shared by every CSV import type, not just Suppliers.** `parseImportCSV()` is called once, from `processImport()` (`index.html:8114-8115`), and used identically for `sup`, `li`, `inv`, `po`, `ord`, and `co` (`TEMPLATES`, `index.html:8009-8034`). The bug is not Supplier-specific — any entity's CSV import with a multi-line Notes/Address/description field is equally exposed. The fix belongs in the one shared parser, not in any per-entity branch.
7. **A second, related gap found while reading the same parser (not the reported bug, but a natural fix while rewriting it correctly):** the existing per-line quote-toggling loop treats every `"` character as a bare open/close toggle, with no way to represent an RFC 4180 escaped literal quote (`""` inside a quoted field, meaning one literal `"` character). This has no known live reproduction in the reported corruption, but a correct rewrite of the same parsing logic should handle it properly rather than leaving a second, similarly-shaped defect in place for a future report.

### 1.3 Existing test coverage gap found

`tests/run.js` has substantial coverage of `processImport()` for `ord`, `co`, `po`, and `inv` (see e.g. `tests/run.js:2115-2299` for `ord`/`co`), but **zero tests exercise `processImport('sup', ...)` at all** — the exact import path this bug lives in has no test coverage today. This REQ's test plan (§5) closes that gap alongside the newline-specific regression coverage.

---

## 2. Requirements

### REQ-DATA-003a — Rewrite `parseImportCSV()` to parse the whole file as one character stream, not per-line
Replace the "split into physical lines first, then parse each line independently" structure with a single pass over the entire input text that tracks quote state continuously. A newline character is a **row separator only when not inside an open quote**; inside an open quote, a newline (including an embedded `\r\n`) is ordinary field content, preserved verbatim in the resulting value. This is the load-bearing structural change — everything else in this REQ follows from parsing the file this way instead of pre-splitting on `\n`.

### REQ-DATA-003b — Add RFC 4180 escaped-quote support (`""` → literal `"`)
While rewriting the character-level loop, correctly interpret two consecutive double-quote characters inside an open quoted field as one literal `"` in the value, rather than as two separate open/close toggles. Bundled into the same rewrite per §1.2 point 7 — not a second, separately-scoped change.

### REQ-DATA-003c — No changes needed to `processImport()`'s per-entity branches
`processImport()`'s `sup`/`li`/`inv`/`po`/`ord`/`co` branches all consume `parsed.rows` (an array of `{header: value}` objects) — they have no knowledge of how row/column boundaries were determined. Fixing `parseImportCSV()` alone corrects every entity's import uniformly; this REQ makes no changes to `processImport()` itself.

### REQ-DATA-003d — Preserve every existing, correct behavior of the current parser
The rewrite must not regress: quoted fields with embedded commas on a single line (already handled correctly today); numeric thousand-separator stripping (`"30,755.80"` → `30755.80`); date normalization (`DD/MM/YYYY`/`DD-MM-YYYY` → `YYYY-MM-DD`); skipping blank/whitespace-only lines between records; and the `lines.length < 2` / no-data-rows early return. These are all existing, tested-by-other-means behaviors this fix must carry forward unchanged, not an invitation to redesign the surrounding logic.

---

## 3. Explicitly out of scope

- **No retroactive cleanup of already-corrupted records.** The user has already manually identified and removed the fragment records from their live data and taken a backup. This REQ prevents the defect from recurring on future imports; it does not touch any existing `DB.sup` (or other entity) records.
- **No extension of `isPhantomRecord()`/the Settings → Data phantom-scanner to detect this corruption class retroactively.** Heuristically deciding "does this record's name field look like a notes/address fragment rather than a real name" is fuzzy, not a crisp `!rec.id` check, and risks false positives against legitimately short or unusual real supplier names. If this becomes a recurring need, that is a separate, future REQ — not assumed necessary here now that the root cause is fixed at the source.
- **No change to the Google Sheets sync path (`Code.gs`, `mapRec()`/`unmapRec()`/`pullAll()`).** Confirmed not at fault (§1.2 point 5) — nothing to fix there.
- **No CSV library dependency added.** This project has a standing no-dependencies convention (one documented exception: the vendored Supabase client). The fix is a corrected hand-rolled parser, consistent with how `parseImportCSV()` already exists today, not a switch to a third-party CSV parsing library.
- **No change to `TEMPLATES`, header definitions, or the CSV template download (`dlTemplate()`).** Out of scope — this REQ fixes parsing of already-uploaded CSV text, not what the app suggests as a starting template.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A Suppliers CSV where the Notes column value is quoted and contains an embedded literal newline, with a comma also present on more than one of the internal lines (the real-world shape reported) | Imported via `processImport('sup', ...)` | Exactly **one** Supplier record is created — not one-per-internal-line — with `name`/`country`/`ct`/`email`/`phone`/`cur` correctly populated from their own columns and `notes` equal to the full multi-line text verbatim (embedded newline preserved), matching the reported corruption shape exactly |
| AC-2 | A CSV with a quoted field containing an embedded comma but **no** embedded newline (the case that already worked before this fix) | Imported | Unchanged, still correctly parsed as a single field — regression guard against the rewrite |
| AC-3 | A CSV field containing an RFC 4180 escaped quote (`""`) representing one literal `"` character | Imported | The resulting value contains exactly one literal `"` character at that position, with no premature field or row break |
| AC-4 | A CSV using CRLF (`\r\n`) line endings both between records and embedded inside a quoted multi-line field | Imported | Rows separate correctly on CRLF between records (unchanged from before); the embedded CRLF inside the quoted field is preserved as field content, not treated as a row separator |
| AC-5 | A CSV with blank/whitespace-only physical lines between real data rows, outside any quoted field | Imported | Blank lines are skipped exactly as before — no spurious empty records created |
| AC-6 | The exact real-world reproduction shape from the live corruption (a multi-line Notes/Address field with commas on more than one internal line) | Imported | Produces exactly one record, not N phantom fragment records with dash-placeholder fields in every other column |
| AC-7 | The same class of multi-line-quoted-field CSV, for a **non-Supplier** entity (e.g. Line Items or Contacts) | Imported via `processImport()` | Also produces exactly one correct record — confirming the fix is in the shared parser and applies uniformly, not accidentally Supplier-specific |
| AC-8 | Every existing `processImport()` test in `tests/run.js` (covering `ord`, `co`, `po`, `inv`) | Re-run after this fix | All continue to pass unchanged — zero regressions from the rewrite |

---

## 5. Testing approach

`tests/run.js` has no existing tests for `parseImportCSV()` in isolation or for `processImport('sup', ...)` at all (§1.3) — both need new coverage, not just the newline-specific regression case. New tests should:
- Call `parseImportCSV()` directly where the assertion is about row/column shape (AC-1 through AC-5), following the existing project convention of testing a pure helper function directly when its contract is well-defined and side-effect-free, rather than only exercising it indirectly through `processImport()`.
- Call `processImport('sup', ...)` directly for the end-to-end shape (AC-1, AC-6), following the exact assertion style of the existing `ord`/`co` import tests (`tests/run.js:2115-2299` — check `DB.sup.length`, individual field values, and the `imp-sup-result` toast text via `mockEl(...).textContent`).
- Reuse one non-Supplier entity (`li` or `co`) for AC-7 rather than building a third fixture style.
- Run the full existing test suite (not just new tests) to directly verify AC-8, since this is a shared, high-blast-radius function used by six different import branches.

---

## 6. Gate process

Standard requirements-gate → spec-gate → build-gate cycle. This is a small, self-contained, additive-only bug fix (no schema change, no new entity), but the rewritten function is genuinely high-blast-radius — every CSV import type routes through it — so the spec-gate review should verify the rewritten parser against every AC by hand-tracing concrete character-by-character examples, not just reading the diff and trusting it looks right, matching the level of rigor already applied to this codebase's other data-correctness fixes (e.g. `SYNC-GAP-001`'s `unmapRec()` fix, `REQ-DATA-002`'s `isPhantomRecord()`).

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: log this as a new, immediately-fixed-in-the-same-delivery gap entry (following the existing convention of documenting a defect even when it's fixed same-day, e.g. how `SYNC-GAP-001` and its fix are both recorded) — call it `IMPORT-GAP-001`, so a future reader searching for "CSV import" or "multi-line" finds the diagnosis even though it's already closed.
- `docs/requirements-tracker.md`: new row.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist.
- `AI_SYSTEM_PROMPT`: review whether the existing CSV-import description needs updating — likely no operator-visible behavior changes (correct behavior looks the same as intended behavior always did; only the previously-broken multi-line case now works), but confirm at spec-gate rather than assume.
