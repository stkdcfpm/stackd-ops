# SPEC-DATA-003 — Fix CSV import corruption on multi-line quoted fields

**Status:** v1 — draft, pending spec-gate.
**Implements:** `docs/REQ-DATA-003-v1.md` (requirements-gate PASS, 2 advisories fixed).
**Touches:** `index.html` only — one function rewritten (`parseImportCSV()`), no other function changed.

---

## 1. The rewrite: `parseImportCSV()`

**File:** `index.html:8074-8112` (current function, confirmed at requirements-gate to be the exact real range).

**Current:**
```js
function parseImportCSV(text) {
  var lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  var headers = lines[0].split(',').map(function(h){ return h.replace(/^"|"$/g,'').trim(); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    // Handle quoted fields with commas
    var cols = [];
    var current = '';
    var inQuote = false;
    for (var c = 0; c < lines[i].length; c++) {
      var ch = lines[i][c];
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cols.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    cols.push(current.trim());
    var row = {};
    headers.forEach(function(h, idx) {
      var val = (cols[idx]||'').replace(/^"|"$/g,'').trim();
      // Strip thousand separators from numeric-looking values e.g. "30,755.80" -> "30755.80"
      if (/^[\d,]+(\.\d+)?$/.test(val)) val = val.replace(/,/g,'');
      // Normalise date formats: DD/MM/YYYY -> YYYY-MM-DD
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(val)) {
        var dp = val.split('/');
        val = dp[2] + '-' + dp[1].padStart(2,'0') + '-' + dp[0].padStart(2,'0');
      }
      // Normalise DD-MM-YYYY -> YYYY-MM-DD
      if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(val)) {
        var dp = val.split('-');
        val = dp[2] + '-' + dp[1].padStart(2,'0') + '-' + dp[0].padStart(2,'0');
      }
      row[h] = val;
    });
    rows.push(row);
  }
  return { headers: headers, rows: rows };
}
```

**New:**
```js
function parseImportCSV(text) {
  var t = text.trim();
  if (!t) return { headers: [], rows: [] };
  var allRows = [];
  var row = [];
  var current = '';
  var inQuote = false;
  for (var i = 0; i < t.length; i++) {
    var ch = t[i];
    if (inQuote) {
      if (ch === '"') {
        if (t[i + 1] === '"') { current += '"'; i++; }
        else { inQuote = false; }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(current.trim()); current = ''; }
      else if (ch === '\r') { /* ignore — normalize CRLF row endings to the following \n */ }
      else if (ch === '\n') { row.push(current.trim()); current = ''; allRows.push(row); row = []; }
      else { current += ch; }
    }
  }
  if (current !== '' || row.length > 0) { row.push(current.trim()); allRows.push(row); }
  allRows = allRows.filter(function(r){ return r.some(function(v){ return v !== ''; }); });
  if (allRows.length < 2) return { headers: [], rows: [] };
  var headers = allRows[0].map(function(h){ return h.trim(); });
  var rows = [];
  for (var r = 1; r < allRows.length; r++) {
    var cols = allRows[r];
    var obj = {};
    headers.forEach(function(h, idx) {
      var val = (cols[idx]||'').trim();
      // Strip thousand separators from numeric-looking values e.g. "30,755.80" -> "30755.80"
      if (/^[\d,]+(\.\d+)?$/.test(val)) val = val.replace(/,/g,'');
      // Normalise date formats: DD/MM/YYYY -> YYYY-MM-DD
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(val)) {
        var dp = val.split('/');
        val = dp[2] + '-' + dp[1].padStart(2,'0') + '-' + dp[0].padStart(2,'0');
      }
      // Normalise DD-MM-YYYY -> YYYY-MM-DD
      if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(val)) {
        var dp = val.split('-');
        val = dp[2] + '-' + dp[1].padStart(2,'0') + '-' + dp[0].padStart(2,'0');
      }
      obj[h] = val;
    });
    rows.push(obj);
  }
  return { headers: headers, rows: rows };
}
```

---

## 2. Structural walkthrough — why this fixes REQ-DATA-003a/b without regressing REQ-DATA-003d

**The one load-bearing change (REQ-DATA-003a):** the old code decided row boundaries first (`text.trim().split(/\r?\n/)`), then parsed quote state independently *within* each already-decided line, with `inQuote` reset to `false` at the top of every line's inner loop (old code's `var inQuote = false;` sat inside the outer `for (var i = 1; i < lines.length; i++)` loop). The new code makes exactly one pass over the entire un-split text, and treats a `\n` as a row separator **only when `!inQuote`** (the `else if (ch === '\n')` branch lives inside the `else` of `if (inQuote) {...} else {...}` — i.e., only reachable when not inside an open quote). When `inQuote` is `true`, a `\n` (or `\r`) falls into the `else { current += ch; }` branch inside the `if (inQuote)` block and is appended to the field's content like any other character. This is the entire fix: quote state now genuinely persists across what used to be treated as separate lines, because there are no separate lines anymore during parsing — only one character stream with one `inQuote` flag that is never reset mid-field.

**Escaped-quote support (REQ-DATA-003b):** `if (ch === '"') { if (t[i+1] === '"') { current += '"'; i++; } else { inQuote = false; } }` — a `"` encountered while already inside a quote is checked against the *next* character. If it's also `"`, this is an RFC 4180 escaped literal quote: append one literal `"` to the field and skip both characters (the `i++` advances past the second quote; the `for` loop's own `i++` advances past the first). If the next character is anything else, this `"` is the real closing quote and `inQuote` becomes `false`. The old code had no equivalent — every `"` was an unconditional toggle, so `""` would toggle twice (closing then immediately reopening a zero-length quoted region) and the literal quote character itself was simply lost (never appended anywhere), rather than represented as a real `"` in the value.

**REQ-DATA-003d — preserving every other existing behavior:**
- **Quoted fields with embedded commas, single line (already worked):** unaffected — a `,` while `inQuote` still falls into the `if (inQuote) { ... else { current += ch; } }` branch, exactly as before, never triggering the comma-splitting `else if (ch === ',')` branch that only exists in the `!inQuote` half.
- **Thousand-separator stripping and date normalization:** copied verbatim into the new per-cell value-building loop (the `headers.forEach(...)` block) — same regexes, same order, same logic, unchanged.
- **Skipping blank/whitespace-only lines:** the old code's `if (!lines[i].trim()) continue;` (per pre-split line, data rows only) is replaced by `allRows = allRows.filter(function(r){ return r.some(function(v){ return v !== ''; }); });` (applied once, after all rows — including the header row — are built). A genuinely blank physical line between two real records produces a row of columns that are all empty strings after `.trim()`, and `.some(v => v !== '')` is `false` for such a row, so it's dropped — the same practical outcome, reached via a single post-pass filter instead of a per-line pre-check, which is necessary now that row boundaries aren't known until the single pass over the whole text completes.
- **The `lines.length < 2` / no-data-rows early return:** preserved as `if (allRows.length < 2) return { headers: [], rows: [] };`, checked after the blank-row filter (so a file that is only a header row plus trailing blank lines still correctly returns no rows, matching old behavior).
- **Header parsing:** the old code parsed the header line with a *separate*, simpler, non-quote-aware `lines[0].split(',')`. The new code parses the header row through the exact same unified single-pass loop as every data row (`allRows[0]`) — a deliberate simplification, not an oversight: this is strictly more correct (a header can now itself be a quoted value containing a comma, which the old code could never support), costs nothing, and every real header in `TEMPLATES` (`index.html:8009-8034`) is a plain unquoted string with no embedded commas, so no existing behavior changes for any real input.
- **Trailing-quote stripping on header/value strings (`.replace(/^"|"$/g,'')`):** removed, because it is no longer needed and was already dead code for values the old parser itself produced. The old inner per-line loop already excluded `"` characters from `current` when acting as a delimiter (`if (ch === '"') { inQuote = !inQuote; }` — note this branch never does `current += ch`), so a value coming out of that loop never contained a literal leading/trailing quote character for the `.replace()` to strip in the first place. The new loop has the identical property (quote characters used as delimiters are never appended to `current`; only an *escaped* `""` appends a literal `"`, and that lands in the middle of the value's real content, never as a spurious leading/trailing artifact). Confirmed by inspection, not assumed — this line was vestigial in the pre-image and remains unnecessary in the rewrite.

**AC-9 (malformed/unterminated quote), added at requirements-gate:** the loop is a single `for (var i = 0; i < t.length; i++)` bounded strictly by the input's length — there is no lookahead, recursion, or backtracking that could cause it to run past `t.length` or loop indefinitely. If a quote is opened and never closed, `inQuote` simply stays `true` for the rest of the input; every remaining character (including any `\n`/`,` it encounters) is appended to `current` as literal content per the `if (inQuote) { ... else { current += ch; } }` branch, and the loop terminates normally when `i` reaches `t.length`. The post-loop flush (`if (current !== '' || row.length > 0) { row.push(current.trim()); allRows.push(row); }`) then captures whatever was accumulated — the unterminated field's content up to end-of-input — as a defined, safe result. No exception is thrown; no import-blocking crash occurs; the operator gets back whatever the malformed file actually contained, not silence or a hang.

---

## 3. Explicitly unchanged

- `processImport()` (`index.html:8114` onward, all six entity branches `sup`/`li`/`inv`/`po`/`ord`/`co`) — zero modifications, per REQ-DATA-003c. Every branch consumes `parsed.rows`/`parsed.headers` exactly as it did before; none has any awareness of how row/column boundaries were determined.
- `bulkUpload()`, `dlTemplate()`, `TEMPLATES`, `impLog()` — zero modifications.
- The Google Sheets sync path (`mapRec()`/`unmapRec()`, `apps-script/Code.gs`) — confirmed at requirements-gate to have no involvement in this defect; nothing to change here.
- `backfillRefNums()`, `isPhantomRecord()` — zero modifications. This fix prevents new fragment records from being created; it does not touch either of the mechanisms that assign numbers to, or scan for, existing records.

---

## 4. Test plan

**Placement:** alongside the existing `processImport()` test coverage, immediately after the `ord`/`co` import tests (`tests/run.js:2115-2289`) rather than at the end of the file — this is genuinely where the topically-related CSV-import tests already live in this codebase, unlike the RFQ/AI-GAP-011 tests which were new functionality with no prior home.

**Direct `parseImportCSV()` tests (pure function, no DB/DOM involved — test directly, per REQ §5):**
- **AC-1/AC-6 (core reported bug):** a CSV whose last column value is a quoted field spanning three physical lines, with a comma present on more than one internal line — e.g. `Notes` = `"Address: Room 221,\n2nd Building, Dongguan City,\nGuangdong, China"` — assert `parseImportCSV(csv).rows.length === 1` (not 3+), and that the one row's `Notes` value equals the original multi-line string verbatim (newlines preserved via `assertContains`/exact-equality checks on the value, and confirm it contains embedded `\n` characters via `.indexOf('\n') >= 0`).
- **AC-2 (regression guard):** a quoted field with an embedded comma but no newline (e.g. `"Commercial refrigeration, CE certified"`) parses as one column, unchanged from current behavior.
- **AC-3 (escaped quote):** a field `"Acme ""Best"" Co"` parses to the value `Acme "Best" Co` — exactly one literal `"` at each escaped position, not two, not a broken field boundary.
- **AC-4 (CRLF):** a CSV using `\r\n` between the header and data rows, where the data row's last field is a quoted value itself containing an embedded `\r\n` — assert the row count is correct (CRLF between records still separates rows) and the field's value contains the embedded `\r\n` intact (or at minimum an embedded newline — the exact literal-preservation-of-`\r` detail is secondary to "not treated as a row break").
- **AC-5 (blank lines):** a CSV with a blank physical line between two real data rows (outside any quotes) parses to exactly 2 data rows, not 3.
- **AC-9 (malformed/unterminated quote):** a field that opens a quote and is never closed anywhere in the rest of the input — assert `parseImportCSV(...)` returns normally (does not throw, does not hang — the test itself completing at all is the primary assertion) and produces a defined row shape, not `undefined`/`null`/a thrown exception.

**End-to-end `processImport('sup', ...)` tests (closes the zero-coverage gap noted in REQ §1.3):**
- **AC-1/AC-6, full pipeline:** build a realistic Suppliers CSV reproducing the exact reported shape (one legitimate supplier row plus, in the pre-fix world, what would have become several phantom fragment rows from one multi-line Notes field) and call `ctx.processImport('sup', csv)` directly. Assert: `DB.sup.length === 1` (not the 5-6 the live corruption produced), the one record's `name`/`country`/`ct`/`email`/`phone`/`cur` match their intended columns exactly (not garbage/blank), and `notes` contains the full multi-line text. Also assert the `imp-sup-result` toast (`mockEl('imp-sup-result').textContent`) reads "1 added, 0 updated" — following the exact existing assertion convention used for `ord`/`co` import tests.
- A baseline "happy path" `processImport('sup', ...)` test with no multi-line content at all, since none exists today — establishes the basic contract (name/country/etc. map correctly, `existing` lookup by case-insensitive name works for a re-import) independent of the newline bug, so this REQ leaves the `sup` import path with real coverage going forward, not just a single bug-specific regression test.

**AC-7 (cross-entity):** repeat the AC-1-style multi-line-quoted-field test against `processImport('co', ...)` (or `li`) instead of `sup`, asserting one record is created with the multi-line field preserved — confirms the fix lives in the shared parser and isn't accidentally Supplier-specific.

**AC-8 (no regressions):** run the full existing suite (`node tests/run.js`) after the rewrite — every pre-existing `processImport()` test (`ord`, `co`, `po`, `inv`) must still pass unchanged, with no test-code modifications needed to accommodate the rewrite.

---

## 5. Version-ship housekeeping (on completion)

Per `CLAUDE.md`'s standing checklist and REQ-DATA-003 §7:
- Version bump, test count, in-app changelog, `docs/version-history.md`.
- `docs/known-gaps.md`: new `IMPORT-GAP-001` entry, documented as found-and-fixed in the same delivery.
- `docs/requirements-tracker.md`: new row.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: standard version-ship updates.
- `AI_SYSTEM_PROMPT`: confirm whether any update is needed — REQ-DATA-003 §7 flags this as "likely no" since correct behavior is invisible (it looks the same as intended behavior always did), but confirm by reading the current prompt's CSV-import description before deciding, rather than skipping the check.
