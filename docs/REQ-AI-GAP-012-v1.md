# REQ-AI-GAP-012 — AI-assisted RFQ response update from an uploaded supplier quote file (CSV)

**Status:** v1 — drafted and self-reviewed against this repo's requirements-gate criteria (completeness / unambiguous / testable / scope / FPM risk / GDPR). No independent second-reviewer pass has occurred yet — that is the next step, not this document.
**Type:** Small-to-medium, additive AI feature. Extends the already-shipped `REQ-AI-GAP-011` (RFQ response update from a pasted email) and depends on the already-shipped `REQ-ORD-006` (`editRfqResponse()`/`saveRfqResponse()` edit-in-place mechanism). Both are shipped (v2.9.69, v2.9.70) — **no blocking ship-order dependency**, unlike REQ-AI-GAP-011's own relationship to REQ-ORD-006. Touches `index.html` only.

---

## 1. Business context

### 1.1 The request and the diagnosis (check-first, this session)

Operator asked to extend the existing "Parse update from email" RFQ feature (`REQ-AI-GAP-011`) so a supplier's quote returned as a spreadsheet (Excel or CSV), rather than pasted into an email body, can be imported the same way.

Found by direct code read:

- `rfqOpenEmailParse(lineId, responseId)` / `rfqRunEmailParse(lineId)` / `rfqParseUpdateFromEmail(emailText, currentResponse)` / `rfqApplyEmailParse(lineId)` (`index.html:3602-3743`) today accept only pasted free text, anchored to **one already-existing RFQ response** on **one already-known Order Request line** (the button lives on that response's own row in `renderRfqComparison()`, `index.html:3592`). There is no file-upload affordance anywhere in this feature.
- The general CSV import pipeline (`parseImportCSV()`, `index.html:10169-10220`; `processImport()`, `index.html:10222` onward) handles bulk Supplier/Line Item/Invoice/PO/Order Request/Contact imports today. Neither Quotes nor RFQ responses are in that pipeline, and `processImport()`'s per-entity `FIELD_MAPS`-driven write model does not fit RFQ responses' shape anyway (`ord.lines[].rfqResponses[]`, an array nested inside one Order Request document, not a standalone entity table). `parseImportCSV()` itself — the tokenizer — is a good fit to reuse directly; `processImport()` is not.
- Grepped the whole repo for `xlsx`/`sheetjs`/`spreadsheetml`: **zero hits**, apart from `vendor/supabase-js-v2.min.js`, the one acknowledged dependency exception named in `CLAUDE.md`. No `.xlsx`-capable parser exists anywhere in this codebase, vendored or otherwise, and `CLAUDE.md`'s stated architecture policy ("no CDN, no dependencies," one narrow acknowledged exception) forecloses silently adding one. Confirmed by direct grep, not assumed.

### 1.2 Design decisions (resolving the three open questions raised at scoping, not left ambiguous)

**Decision 1 — File format: CSV only in v1. `.xlsx` is an explicit, documented out-of-scope limitation, not silently assumed away.**
No `.xlsx` parser exists in this codebase and none can be added without a new, separate architecture decision (vendoring a binary-spreadsheet parser same-origin, which this REQ does not make — see §3). This REQ reuses `parseImportCSV()` (`index.html:10169`) directly as a new caller — the same RFC 4180 / quoted-multi-line-field-safe tokenizer already relied on by every other CSV import in the app, inheriting that fix for free rather than hand-rolling a second CSV parser (which `parseImportCSV()`'s own header comment explicitly warns against: "This function is shared by every CSV import type... fixing it fixes all... do not add per-entity parsing logic"). The file-upload control only accepts `.csv` (`accept=".csv"`), and the handler rejects a non-CSV file by extension/MIME check before ever attempting to read it as text — never attempts to parse binary `.xlsx` content as a text stream, which would silently produce garbage rather than a clear error.

**Decision 2 — Scope: one file → proposals for every matching line in the Order Request, not one file → one line.**
Rejected the narrower "one file → one line" framing (matching today's exact per-response-row trigger) because it does not match the stated real-world shape of the problem: a supplier's own quote spreadsheet routinely covers multiple line items from one Order Request in a single file, and forcing the operator to re-upload the same file once per line (manually indicating which line each time) would not meaningfully reduce the manual-re-entry pain this feature exists to remove. The wider scope is **not** materially riskier or larger to build than the narrow one: every actual data mutation still goes through the exact same, already-shipped, already-reviewed `editRfqResponse()`/`saveRfqResponse()` functions (§1.2 of `REQ-ORD-006`), one line at a time — the only genuinely new surface is (a) matching spreadsheet rows to Order Request lines, and (b) rendering N independent review panels instead of one. Concretely:
- A new "Import Supplier Quote File" control lives **once per Order Request** (not per line, not per RFQ response row) — placed in `rOrdLines(ord)`'s existing per-order UI area; exact pixel placement is an implementer/spec-gate call, not mandated here.
- The operator explicitly selects the **supplier** the file is from (a dropdown, matching `editRfqResponse()`'s existing supplier `<select>` fill) before parsing. The AI is never asked to infer or guess the counterparty's identity from spreadsheet content — this removes an entire class of ambiguity the pasted-email version never had to deal with either (there, the supplier is already fixed by which response row the operator clicked).
- For each Order Request line the AI confidently matches a spreadsheet row to (see Decision 3): if the selected supplier **already has** an RFQ response recorded on that line, the proposal is an **update** to it (identical mechanism to `REQ-AI-GAP-011` — same diff UI, same `editRfqResponse()`/`saveRfqResponse()` edit path, same new-id-and-`committedResponseId`-repoint behavior). If the selected supplier has **no** existing response yet on that line, the proposal is a **new** response (the existing, unmodified "+Add Response" `saveRfqResponse()` add path — `cRfqEditId` stays `null`), shown in the diff as "(none) → proposed value" per field. Both cases reuse existing, already-tested persistence paths; neither introduces a new way of writing to `DB.ord`.
- Each matched line gets its **own independent** diff/Apply/Discard panel (visually N copies of the existing single-line panel from `rfqRunEmailParse()`'s success branch — the per-field diff-row rendering logic there should be factored into a shared helper and reused, not duplicated a third time, per this codebase's stated reuse convention; exact factoring is a spec-gate call). There is **no bulk "Apply All" action in v1** — each proposal is reviewed and applied/discarded individually, preserving the existing "AI output never silently changes a live value, one operator click per record" trust model exactly, rather than introducing a new one-click-applies-many-records risk surface.

**Decision 3 — Row-to-line matching confidence: flag for operator review, never guess, never block the whole file.**
Matches this codebase's established convention for AI uncertainty (`AI-GAP-007`/`AI-GAP-008`, `docs/known-gaps.md`: surface uncertainty to the operator, don't guess and don't fail silently). The AI is given the full list of the Order Request's own lines (`category`, `itemSpec`, `orderVolumeQty`/`orderVolumeUnit` — the same fields `ordAddLine()` populates, `index.html:3800-3818`) alongside the parsed spreadsheet rows, and for each row must either (a) match it with confidence to exactly one existing line, or (b) return it as **unmatched**, with a brief AI-stated reason, taking no action on it. Unmatched rows are displayed verbatim to the operator in a distinct "Needs manual review" list — never silently dropped, never guessed at, and **never block processing of the file's other, confidently-matched rows** (a bad or ambiguous row degrades gracefully to "one more thing for the operator to handle manually," not a failed import).

### 1.3 A GDPR-relevant difference from REQ-AI-GAP-011's pasted-email precedent, addressed with a new mitigation

`REQ-AI-GAP-011`'s accepted residual risk (§2b of that REQ) is that the *entire* pasted email text is sent to the Anthropic API, since extraction needs full context, with the only mitigation being inline UI copy nudging the operator to paste only the relevant portion before pasting — a natural, low-friction check point, since the operator is already looking at and manually copying the specific text.

A file upload removes that natural checkpoint: an operator can select and upload a `.csv` file without having actually read every column of it first (an extraneous "Prepared by" column, a stray contact's email address in a notes column, a column the operator forgot was even in the sheet). This is a **materially different, higher risk** than the pasted-email case, not the same risk restated — treating it identically to REQ-AI-GAP-011's inline-nudge-text mitigation would be under-mitigating a new failure mode.

**Mitigation (mandatory, not optional, unlike the email version's soft nudge):** after parsing (tokenizing) the file and before any AI call is made, the operator is shown the parsed rows/columns as plain text and must explicitly confirm before the data is sent — canceling at this step discards the parsed file state and sends nothing. This is a genuinely new UI step this REQ requires that REQ-AI-GAP-011 did not (see AC-9).

---

## 2. Requirements

### REQ-AI-GAP-012a — New control: "Import Supplier Quote File" (once per Order Request)
Added to `rOrdLines(ord)`'s rendered output, not to any individual line or RFQ-response row. Opens a small modal: a supplier `<select>` (populated exactly as `editRfqResponse()`'s `rfq-sup` dropdown, `index.html:3459-3460`), a file input restricted to `.csv` (`accept=".csv"`), and a "Parse" button. No file is read and no AI call happens until the operator selects both a supplier and a file and clicks Parse.

### REQ-AI-GAP-012b — New function: `rfqOpenFileImport(ordId)` / `rfqRunFileImport(ordId)`
`rfqRunFileImport()` rejects (with a clear operator-facing message, no parse attempt) any selected file whose name does not end in `.csv` (case-insensitive). For an accepted file, reads it via `FileReader.readAsText()` (matching `bulkUpload()`'s existing pattern, `index.html:10152-10167`), then calls `parseImportCSV()` (`index.html:10169`) — **the existing tokenizer, unmodified, no second CSV parser written**. If `parseImportCSV()` returns fewer than 1 data row (its own existing empty/malformed-input contract), shows "No data rows found in that file" and stops — no AI call made on an empty parse.

### REQ-AI-GAP-012c — Mandatory pre-send confirmation of parsed rows (§1.3)
Before any AI call, the parsed rows (headers + values, as tokenized) are rendered as plain text for the operator to review, with an explicit "Send to AI" / "Cancel" choice. Cancel discards the parsed state entirely — re-invoking the feature requires re-selecting the file. This step cannot be skipped or disabled.

### REQ-AI-GAP-012d — New function: `rfqParseUpdateFromFile(rows, supId, lineContexts)`
Mirrors `rfqParseUpdateFromEmail()`'s exact architecture (`index.html:3706-3743`): `AI.key`-gated (returns `null` immediately if not configured), single `fetch()` to the Anthropic Messages API, same model (`claude-haiku-4-5-20251001`), same `temperature: 0.2`, `try/catch` returning `null` on any failure — never throws.

**Payload:** the parsed CSV rows (headers + row values, as returned by `parseImportCSV()`), the selected supplier's id, and a context array built from `ord.lines` — each line's `id`, `category`, `itemSpec`, `orderVolumeQty`, `orderVolumeUnit`, and (if the selected supplier already has a response on that line) that response's current `cost`/`currency`/`moq`/`leadTime`/`paymentTerms` for diffing, exactly as `rfqParseUpdateFromEmail()` already does per-line.

**Prompt design (extending `RFQ_EMAIL_PARSE_PROMPT`'s style):** "Given these supplier quote spreadsheet rows and a list of this Order Request's own line items, match each row to at most one line item using its description/spec. For each row you can confidently match to exactly one line, extract any of {cost, currency, moq, leadTime, paymentTerms, notes} the row states a value for. If you cannot confidently match a row to exactly one line item, do not guess — return it as unmatched with a brief reason. Respond with ONLY a JSON object `{matches: [{lineId, fields: {...}}], unmatched: [{row: {...}, reason: '...'}]}` — no prose, no markdown fences." Response validated the same way `rfqParseUpdateFromEmail()` validates its object contract (`index.html:3736`, reject anything that isn't a plain object, reject arrays) — extended here to also validate `matches`/`unmatched` are arrays, and that every `matches[].lineId` corresponds to a real line in `lineContexts` (an AI-hallucinated `lineId` is treated as unmatched-with-reason, not applied blindly).

### REQ-AI-GAP-012e — Per-line proposal state, multi-line by default
Tracks pending proposals keyed by `lineId` (e.g. an object/map, not a single flat variable) — this REQ makes the multi-line case its **default** scenario, not an edge case discovered later, unlike `REQ-AI-GAP-011`'s own build-gate history where the equivalent fix (`cRfqEmailParseLineId`) was added only after a cross-line corruption bug was found in review. Applying or discarding one line's proposal must have zero effect on any other line's still-pending proposal from the same file import — this is a first-class acceptance criterion here (AC-7), not something discovered after the fact.

### REQ-AI-GAP-012f — Diff/Apply/Discard UI, one panel per matched line, reusing existing mechanics
Each entry in the AI's `matches[]` renders its own review panel (old → proposed, one row per field), reusing the exact per-field diff-row rendering already built for `rfqRunEmailParse()`'s success branch (`index.html:3668-3671`) rather than a third re-implementation. **Apply** for a given line calls `editRfqResponse()`/`saveRfqResponse()` (update case) or the existing blank-add path (new-response case) exactly as `rfqApplyEmailParse()` already does for the single-line case (`index.html:3680-3702`), scoped to that one `lineId` only. **Discard** removes only that line's pending proposal. The `unmatched[]` list renders separately as read-only text (row content + AI's stated reason) with no Apply/Discard action of its own — it exists purely so the operator knows what to key in manually.

### REQ-AI-GAP-012g — `AI_SYSTEM_PROMPT` update
Per the standing "mandatory on every version" rule (`CLAUDE.md`) — the existing RFQ-comparison / email-parse description in `AI_SYSTEM_PROMPT` should be extended to mention the file-upload path exists too, so the chat assistant answers "can I upload a supplier's quote spreadsheet" accurately (pointing at the actual button, CSV-only, not implying `.xlsx` works).

---

## 3. Explicitly out of scope

- **`.xlsx` (binary Excel) files.** No parser exists in this codebase or is being added by this REQ (§1.2, Decision 1). If this proves a frequent operator blocker, vendoring a same-origin binary spreadsheet parser (mirroring how `vendor/supabase-js-v2.min.js` was accepted) is a separate, explicit architecture decision for a future REQ — not assumed or half-built here.
- **Bulk "Apply All" for a file's confidently-matched proposals.** Every proposal is reviewed and applied individually, matching the existing one-click-per-record trust model (§1.2, Decision 2). A convenience bulk-apply action is a natural, separate follow-up if manual per-line Apply proves to be real friction in practice — not assumed needed here.
- **Outbound Excel-template generation for RFQs.** Explicitly scoped out by the operator at the start (inbound-only, this round).
- **A rigid, Stackd-defined header-matching importer as an alternative to AI extraction.** Explicitly rejected by the operator at scoping — a supplier's own file will never reliably follow a Stackd-defined column convention, which is the whole reason AI extraction (not `processImport()`'s `FIELD_MAPS` header-matching model) was chosen for this feature.
- **Any change to `parseImportCSV()`, `processImport()`, `editRfqResponse()`, `saveRfqResponse()`, or `renderQteSourceDriftWarn()`.** This REQ is a new caller of the first, and reuses the latter three completely unmodified — the entire point of §1.2 Decision 2 is that no new persistence mechanism is introduced.
- **No persisted history of what the AI proposed** (matched, unmatched, applied, or discarded) — same accepted non-goal as `REQ-AI-GAP-011` §3, for the same reason (one-time, in-session review, not an audit trail).

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `AI.key` configured | A CSV file is parsed and sent | `rfqParseUpdateFromFile()` returns `null` immediately, no fetch call made — matching the existing `rfqParseUpdateFromEmail()`/`ordCheckLineGapsSemantic()` convention |
| AC-2 | A CSV file with 2+ rows, each confidently corresponding to a distinct existing Order Request line | Parsed | `matches[]` contains an entry per correctly-identified line; `unmatched[]` is empty |
| AC-3 | A CSV file with one row whose description matches no existing line item | Parsed | That row appears in `unmatched[]` with a non-empty reason string; the file's other, confidently-matched rows still appear correctly in `matches[]` — a single bad row degrades gracefully rather than failing the whole parse |
| AC-4 | A file named e.g. `quote.xlsx` is selected | Import is attempted | The handler rejects it before any read/parse attempt, with a clear "CSV only" message — never attempts to decode binary content as CSV text |
| AC-5 | A matched line where the selected supplier has **no** existing RFQ response on that line | Reviewed and Applied | A **new** RFQ response is created via the existing add path (`saveRfqResponse()`, `cRfqEditId` null) with the AI-proposed field values; `line.rfqResponses` gains one new entry |
| AC-6 | A matched line where the selected supplier **already has** an RFQ response on that line | Reviewed and Applied | The response is updated via the existing edit path exactly as `REQ-AI-GAP-011` AC-6 specifies — including new-id-and-`committedResponseId`-repoint behavior if the response is committed |
| AC-7 | Two lines both have pending, unapplied proposals from the same file import | One line's proposal is Applied or Discarded | The other line's pending proposal, and its own eventual Apply/Discard, is completely unaffected — asserted directly, not assumed, mirroring the regression test `REQ-AI-GAP-011`'s build-gate had to add after the fact for its own single-file cross-line bug |
| AC-8 | A network error, non-200 response, or malformed AI response | Parsing is attempted | Returns `null`; UI shows the same fail-soft "AI parse unavailable" message as `REQ-AI-GAP-011`, no partial state left behind, no thrown error |
| AC-9 | A file has been tokenized into rows | Before any AI call | The operator is shown the parsed rows and must explicitly confirm; choosing Cancel at this step sends nothing to the AI and discards the parsed state (§1.3's mitigation) |

---

## 5. Testing approach

Reuses the existing mocked-`fetch` (`_mockAnthropic`) harness in `tests/run.js` for AC-1, AC-8. Reuses `mkOrdWithLine()`-style fixtures (extended to 2+ lines with genuinely distinct `category`/`itemSpec` text, so a matching test is not trivially satisfiable by a single-line fixture) for AC-2, AC-3, AC-5, AC-6, AC-7. **`parseImportCSV()`'s own tokenizer behavior (RFC 4180 quoting, multi-line quoted fields) is already fully covered by its existing tests (`REQ/SPEC-DATA-003`) and must not be re-tested here** — this REQ's tests should exercise the row-to-line matching/fan-out/state-isolation logic that is actually new, not the already-proven tokenizer. AC-7 in particular should be written as an adversarial two-line fixture (deliberately similar-looking `itemSpec` text between the two lines), not a trivially-distinct pair, so the test would actually fail if line-isolation were broken — matching the spirit of `REQ-AI-GAP-011`'s own build-gate mutation-test discipline.

---

## 6. Gate process

Standard requirements-gate → spec-gate → build-gate cycle. No blocking ship-order dependency (both `REQ-ORD-006` and `REQ-AI-GAP-011` are already shipped), but spec-gate should apply the same level of scrutiny to REQ-AI-GAP-012e/f's per-line state isolation (AC-7) that `REQ-AI-GAP-011`'s build-gate ultimately had to apply reactively — an independent hand-trace or mutation test of the cross-line guard, done proactively this time since multi-line is this REQ's stated default case, not a later-discovered edge case.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: no existing gap to mark fixed — new feature, not a defect fix.
- `docs/requirements-tracker.md`: new row, noting this as a `REQ-AI-GAP-011` extension (file-upload input path) rather than a standalone unrelated feature.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist; `AI_SYSTEM_PROMPT` update per REQ-AI-GAP-012g.
- `docs/user-guide.md`: new feature, operator-visible workflow change — update required per the standing checklist (not optional; this is not a bug fix or refactor).

---

## 8. Self-review against this repo's requirements-gate criteria (this session)

Every code citation was verified directly against the current file, not assumed from the description supplied for scoping:

- `rfqOpenEmailParse`/`rfqCloseEmailParse`/`rfqRunEmailParse`/`rfqApplyEmailParse`/`rfqParseUpdateFromEmail`: read in full at `index.html:3602-3743`. Confirmed the exact shape claimed — single-response-anchored, `AI.key`-gated, fail-soft, object-contract validation, `cRfqEmailParseLineId`/`cRfqEmailParseRespId`/`cRfqEmailParseProposed` module-level state.
- `editRfqResponse`/`saveRfqResponse`/`delRfqResponse`: read in full at `index.html:3447-3531`. Confirmed the edit path's new-id-and-`committedResponseId`-repoint behavior this REQ relies on for AC-6, and the unmodified blank-add path (`cRfqEditId` null → `push()`) this REQ relies on for AC-5.
- `parseImportCSV`/`processImport`/`bulkUpload`: read at `index.html:10152-10230`. Confirmed the tokenizer's `{headers, rows}` contract and its own header-comment warning against a second hand-rolled parser; confirmed `processImport()`'s `FIELD_MAPS`-driven entity-write model does not fit RFQ responses' nested-array shape, justifying reuse of the tokenizer only, not the whole pipeline.
- `ordAddLine`: read at `index.html:3800-3818`. Confirmed the exact line-context fields (`category`, `itemSpec`, `orderVolumeQty`, `orderVolumeUnit`) available for the AI's row-to-line matching — there is no SKU/code field on an Order Request line, so matching is necessarily description-based, which is itself the reason AC-3's "flag, don't guess" behavior is load-bearing rather than a nice-to-have.
- `.xlsx`/SheetJS/vendor dependency: grepped the whole repo (`index.html`, `CLAUDE.md`) — zero hits beyond the one acknowledged Supabase exception. Confirmed by direct search, not asserted from the task description alone.

**FPM domain risk (flagged per this repo's own gate criteria):** YES. This feature writes to `RfqResponse.cost`/`currency` fields that, once a response is committed and converted, feed `cQteLine()`/`cQte()` indirectly (same risk class already accepted for `REQ-AI-GAP-011`). The new risk this REQ adds on top is **volume**: a single file can produce several proposed writes across several lines in one sitting, so a matching-confidence bug (silently matching row 3 to line 7 instead of line 4) is more consequential here than in the single-response email case, where the target line is already fixed by which button the operator clicked. This is exactly why AC-3's "unmatched, don't guess" behavior and AC-7's cross-line isolation are both mandatory ACs here, not advisories — spec-gate must not accept a design that weakens either to ship faster.

**GDPR (flagged per this repo's own gate criteria):** YES — real risk, addressed, not a residual risk merely restated from `REQ-AI-GAP-011`. Supplier commercially-sensitive pricing data is sent to the Anthropic API on every use, same trust boundary already accepted for the email-parse feature (an internal, single-operator B2B tool handling correspondence/records the operator already holds). The genuinely new risk is that a file upload is not self-screened by the act of composing/copying text the way pasting an email is — an operator can upload a file without having read every column of it — so this REQ requires (AC-9), not merely suggests, an explicit pre-send confirmation step showing the parsed rows before any AI call, which `REQ-AI-GAP-011` did not need and did not have. No new `localStorage` field or key structure — this REQ writes through the exact same `rfqResponses[]` shape (`K.ord`/`DB.ord`) `REQ-ORD-006`/`REQ-AI-GAP-011` already established; no schema change, so `K`/`DB` are unaffected. No new external transmission target — same Anthropic Messages API endpoint already covered by the existing feature, not a new integration.

**Completeness / unambiguous / testable / scope check:** every requirement in §2 names the exact function(s) it adds or reuses and the exact existing code it must not duplicate; §3 closes off three real "could this have quietly grown" directions (bulk-apply, outbound templates, a second importer style) explicitly rather than leaving them implied; §4's nine ACs are each phrased as an observable, single-outcome behavior with no "should probably" language; the single-file-architecture/no-build-step constraint (`index.html` only, CSV via the existing tokenizer, `.xlsx` explicitly rejected rather than silently assumed) was checked against `CLAUDE.md`'s stated policy directly, not inferred.

Not yet done, and out of scope for this document: an **independent** second-reviewer pass (this self-review was conducted by the same session that drafted the REQ, which is a weaker form of verification than the two-person gate pattern this repo's own shipped REQs went through — see `REQ-AI-GAP-011`'s and `REQ-ORD-006`'s own §8 logs, both of which record findings from a reviewer distinct from the drafting pass). Recommend a genuinely independent requirements-gate pass before this proceeds to spec-gate, per the standing process.
