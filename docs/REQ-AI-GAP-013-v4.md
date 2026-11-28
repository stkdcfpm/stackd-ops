# REQ-AI-GAP-013 — AI-assisted RFQ response update from an uploaded supplier quote PDF or image

**Status:** v4 — DRAFT, resubmitted after `requirements-gate` round 3 (v3: **CONDITIONAL PASS**, 2 text-level blocking B1–B2 + advisories A1–A8; round 2: FAIL; round 1: FAIL). Every finding re-verified against live code before acceptance (§10b). Needs one confirmatory round. Run `node scripts/check-req-citations.js docs/REQ-AI-GAP-013-v4.md` before resubmission.
**Type:** Small-to-medium additive AI feature: a new *input format* for the shipped `REQ-AI-GAP-012` (CSV quote import, v2.9.85). `index.html` only. No Supabase migration, no new `DB`/`K` key. **One behaviour change to a shared function is deliberately included (§2f-2, save-time currency backstop) and is called out as such.**
**Amends** the "CSV only" limit in `AI-GAP-012` for PDF/image. `.xlsx` and non-comma delimiters stay out of scope. Idea list for other uses: `docs/candidates-ai-document-input.md` (no backlog obligation).

---

## 1. Business context

### 1.1 Diagnosis
The only file input on the RFQ path is `accept=".csv"` (`index.html:3841`); `rfqRunFileImport()` rejects any other extension (`index.html:3867-3870`); the pasted-email parse is text only (`rfqParseUpdateFromEmail`, `index.html:4439`). The operator's real channels — WhatsApp, WeChat, Alibaba, Made-in-China — deliver quotes as **PDFs and very likely screenshots/photos**. For those channels the shipped import is effectively unusable.

### 1.2 Design decisions

**D1 — Types:** `.pdf`, `.png`, `.jpg`/`.jpeg`, `.webp`. GIF excluded deliberately. HEIC/HEIF rejected with a message naming JPEG/screenshot. The API takes base64 `document` (PDF) and `image` blocks.

**D2 — No client-side PDF/OCR library.** Scans have no text layer; a text extractor fails on the files that matter and breaches the no-dependency policy. The model reads the file as a native block (handles Chinese documents).

**D3 — One file, one operator-selected supplier per run;** no batching; the AI never infers the supplier.

**D4 — The pre-send checkpoint is mandatory; its form differs by type.** The CSP (`index.html:8`) has `object-src 'none'`, no `frame-src`/`child-src`, `img-src … blob:`. So:
- **Images:** `<img src="blob:…">` preview of the **visible image**. (v2's "whole file visible" was wrong: EXIF/GPS metadata is sent but not visible — corrected here.)
- **PDFs:** no inline preview is possible and a rendered first page would need a PDF library (barred by D2). **The CSP is not loosened** (`SEC-GAP-008`). The PDF checkpoint instead shows file name, size, the **disclosure list**, and a **required acknowledgement checkbox** gating Send. Guidance copy: review the PDF in your own viewer, or upload a cropped screenshot of the quote pages (images *are* previewable). An "open in new tab" link is offered **only if** the SPEC proves it works (blob documents inherit the creator's CSP; a PDF viewer under `object-src 'none'` is not guaranteed) — never assumed.
- **Disclosure list — fixed required items, each asserted by substring in AC-7:** (i) the **entire file** is sent, including content the preview does not show; (ii) image **EXIF/GPS metadata** is included; (iii) a PDF's **hidden text layer, annotations, embedded attachments and document metadata** are included; (iv) the file is sent to the **Anthropic API**; (v) screenshots may show **other people's names, phone numbers and messages**.
- **Checkbox wording states only what the operator did:** "I have reviewed this file outside the app and am happy for all of it to be sent." (v2's "contains only the supplier's quote" asserted something the disclosure says the operator cannot verify.)
- Cancel discards the file and sends nothing.

**D5 — No new RFQ fields.** Extractable set stays `cost, currency, moq, leadTime, paymentTerms, notes` (`allowed`, `index.html:3956`). Incoterm, validity, tiers and unit basis go in `notes`.

**D6 — Cost and currency are coupled on the doc path, enforced in code (§2d, R1–R3).** A price without a document-stated unit basis/currency is never proposed.

**D7 — Model choice is open and decided by measurement before SPEC approval.** Existing RFQ paths use a date-suffixed Haiku ID; dense bilingual price tables are far harder than CSV rows and a wrong price costs far more than the per-call difference. Run **≥10 real, redacted operator quotes** (clean PDF, scanned PDF, WeChat screenshot, Chinese-only quote, tiered-price quote) through candidate models. **Proposed bar (operator confirms or changes before it is binding): zero confident-wrong cost or currency values, ≥80% of price fields present in the source extracted.** Eval files live under `Test-data/` (gitignored; repo is public — `SEC-GAP-020`), never committed. Sending the operator's own supplier documents to candidate models is the same accepted trust boundary as production use. Model IDs come from the current model list, not recall; `temperature` acceptance is checked per candidate model.

---

## 2. Requirements

### REQ-AI-GAP-013a — Shared file→content-block helper
`aiFileToContentBlock(file)` → `{ok:true, block}` | `{ok:false, reason}`. Owns the type allow-list, the size cap, `readAsDataURL`, stripping the `data:…;base64,` prefix (no newlines), and the `document`/`image` block with the correct `media_type`. No other function builds a content block.

### REQ-AI-GAP-013b — Type detection; single rejection trigger
- **Single trigger:** every rejection happens on the **Parse click** in `rfqRunFileImport()` (`index.html:3859`); no change-handler on selection.
- **Detection:** extension lower-cased, last extension wins (`a.pdf.jpg` is a `.jpg`); `media_type` comes from a fixed extension map, **never from `file.type`**. `file.type` is consulted only as a *tie-breaker to reject*: it rejects only when non-empty **and** not `application/octet-stream` **and** its class (pdf/image) contradicts the extension — blank and `application/octet-stream` (common from mobile browsers) are accepted. **The first-bytes signature check is authoritative** (`%PDF-`; PNG `89 50 4E 47`; JPEG `FF D8 FF`; WebP `RIFF….WEBP`) and rejects mismatches (catches a HEIC renamed `.jpg`).
- The signature read is asynchronous (`file.slice(0,12)` via a second `FileReader`/`readAsArrayBuffer`, or `file.arrayBuffer()`). It is guarded by a **per-run token** compared on completion, so a double Parse click or a Cancel/re-open during the read cannot resume a dead run (same intent as the stale-panel guard at `index.html:3873`).
- Messages: unsupported type lists accepted types; `.heic/.heif` names JPEG/screenshot; `.xlsx` still says Excel is unsupported; zero-byte says empty.
- `.csv` takes the existing path **unchanged**.

### REQ-AI-GAP-013c — Doc-path pending state and its release (resolves N5)
New module-level state alongside (not replacing) `cRfqFileImportPendingRows` (`index.html:3339`): `cRfqFileImportPendingDoc = {file, supId, objectUrl|null, runToken}`. No base64 is built until **Send to AI**. **Send clears `cRfqFileImportPendingDoc` synchronously, before the async base64 read** (as pending rows are cleared at `:3905`), so a double-click cannot fire two paid requests.

**The pending file and any object URL are released on each of these distinct exits** (v2's "seven" double-counted Cancel/Close and listed a vacuous Parse-rejection path; this is the corrected list; each is an AC-7b case):
1. **Send** (cleared synchronously, object URL revoked after the request is built).
2. **Cancel or Close** — all the panel's Cancel/Close buttons are `rfqCloseFileImport()` (`:3844`, `:3896`, `:3922`, `:4010`); this is **one** path.
3. **Re-opening `rfqOpenFileImport()`** over an existing panel — the function replaces `innerHTML` without closing (`:3835`); it must release first.
4. **Any `rOrdLines()` call** (add-line, delete-line, switching order via `openOrd`, etc., e.g. `:4550`, `:4563`, `:4570`, `:4577`, `:4608`) — `rOrdLines` always rewrites `of-lines-list` and recreates an **empty hidden `ord-fileimport-<ordId>` div with the same id** (`:3818-3823`), so "the panel is gone" cannot be tested by id lookup and the pending record holds no panel reference. **Stated semantics: any `rOrdLines()` call while `cRfqFileImportPendingDoc` exists releases it** (the operator re-selects the file). **Harness limit, acknowledged:** the mock `G()` returns the same object per id, so the DOM-node replacement is unobservable in tests; AC-7b for this exit asserts the release call and cleared state, not DOM identity.
5. **Order Request modal close.** There is **no `closeOrd` function**: `ov-ord` closes through the generic `closeM('ov-ord')` from inline `onclick`s (`:425`, `:427`, `:456`) and JS calls (`saveOrdFromForm`, `:4650`; `ordAdminOverrideFromForm`, `:4659`), and `EI.ord` is never cleared on close. `closeM()` (`:5662`) touches no file-import state, and `cRfqFileImportOrdId`/proposals already survive modal close today. **The only new wiring is a `closeM` special-case for `id === 'ov-ord'` that releases pending doc state** (precedent: its existing `'ov-inv'` special-case). *Switching to another order* already reaches exit 4 via `openOrd` → `rOrdLines` (`:4608`) and needs no further wiring.
6. **Stale-continuation return** — `G('ord-fileimport-'+ordId) !== panel` in an async continuation, and the new Send function's early returns when `ord` or `panel` is missing.

Nothing about the file is written to `localStorage`, `DB` or any persisted key.

### REQ-AI-GAP-013d — `rfqParseUpdateFromDoc(block, lineContexts)` and response contract
**Architecture** mirrors `rfqParseUpdateFromFile()` (`index.html:3930`): `AI.key`-gated, one `fetch`, `try/catch`, never throws. User content `[contentBlock, {type:'text', text: JSON.stringify({lines: lineContexts})}]`, **block first**; new `RFQ_DOC_IMPORT_PROMPT`; raised `max_tokens`.

**Return contract (resolves B-b):** `null` for no key / network / non-200 / unparseable / invalid shape; **`{error:'max_tokens'}`** when `stop_reason === 'max_tokens'`; otherwise the result object. The caller maps `{error:'max_tokens'}` to "the document is too long for one pass — upload fewer pages" and `null` to the existing generic message (the existing null handling is one generic string, `:3919-3924`).

**Doc-path result schema:** `{ matches:[{lineId, fields}], unmatched:[{item, reason}], documentNote? }`. `item` is a short text description of a document item (a document has no "row"); `documentNote` is an optional capped string. The renderer prints `item` for doc-path unmatched entries (today `JSON.stringify(u.row)`, `:4005`). **`documentNote` is shown as a banner above any panels whenever the current run returned it** — independent of older pending panels (resolves C-c; the renderer's existing "No confident matches" fallback shows only when `panelsHtml` is empty, `:4009`, and would otherwise hide the note after a re-run). A non-array `unmatched` or non-object response → `null`.

**Shared post-processing (resolves N1).** Extract the validation inlined at `index.html:3953-3972` into `rfqNormalizeAIFileResult(parsedObject, lineContexts, opts)` used by **both** paths. **The shared part is only what already exists** — `lineId` verification, the `allowed` whitelist, `fields`-shape guards. **R1–R4 below are applied only when `opts.strictDoc === true` (the doc path); the CSV path never sets it, so CSV behaviour is unchanged** (the shipped 012 tests use cost-only proposals such as `fields:{cost:10}`, `tests/run.js:13545,13559,13603`, and on the CSV edit path a cost-only proposal keeping the existing currency is legitimate). Before extracting, add **characterization tests** for behaviour the 012 group does not assert (the `allowed` whitelist, non-object/array `fields`, wrongly-typed values) and run them green on the *unrefactored* code; after extraction, mutation-test them.

**Doc-path rules (enforced in code, not left to the prompt):**
- **R1 — currency vocabulary.** Trim and case-fold (`usd`, ` RMB ` accepted). Valid = exactly one of the `rfq-cur` options (`USD`, `GBP`, `RMB`, `BBD`, `index.html:468`). A fixed table maps documented synonyms (`CNY`, `人民币` → `RMB`); `¥` and `$` alone are ambiguous and **not** mapped. Anything else is invalid.
- **R2 — cost/currency coupling.** `cost` survives only if it is a finite number **> 0** (a numeric *string* such as `"12.5"` is dropped — deliberately strict, trading hit-rate for safety) **and** a valid R1 currency is present. Otherwise `cost` is dropped. A **currency without a surviving cost is dropped on the edit path** (a lone currency would silently reinterpret an existing price, e.g. 100 USD → 100 RMB). On the **new-response path** a valid document-stated currency *without* a surviving cost is **kept as a hint** for the pre-filled form (§2f-3), never auto-saved. The document's currency is required even on the edit path: an existing currency cannot be assumed to match a different document.
- **R3 — unit basis.** The prompt outputs `cost` only when unit basis (per piece/carton/set/container) and currency are stated; per-carton or tier prices go to `notes`. R3 is a prompt instruction, **not a guarantee** (§8).
- **R4 — all free-text fields (resolves N6).** `moq`, `leadTime`, `paymentTerms` and `notes` must each be a **string** (objects/numbers/arrays dropped, since they would render as `[object Object]`), **length-capped per field**, and carry **commercial terms only**; the prompt forbids personal names, phone numbers, emails, WeChat/WhatsApp IDs, addresses and **bank-account/beneficiary details** (`paymentTerms` is the most likely place a quote carries them). A heuristic check (email-like, phone-like, long digit runs, IBAN/SWIFT-like patterns) **flags** a visible warning on the panel ("appears to contain contact or bank details — review before Apply"); it warns, it does not strip. **Exact patterns, thresholds and per-field length caps are fixed by the SPEC** (this REQ states only the testable behaviour: AC-11b positives and the AC-11d negatives, which exist because naive patterns would flag ordinary quote text — an 8–11-letter uppercase word such as `SHANGHAI` under a SWIFT-style rule, or a quantity such as `MOQ 500000` under a digit-run rule). `notes` replaces the existing `notes` wholesale on Apply (diff shows both).
- **Plumbing (resolves A4).** `rfqNormalizeAIFileResult(parsed, lineContexts, opts)` decides edit-vs-new from `lineContexts[i].currentValues` (present only when the selected supplier already has a response on that line, `:3913-3915`). A response may be added or deleted during the async parse; this is **fail-safe by construction** because the panel's Apply/Open decision is made at render time from the then-current `existingResp`, never from the validation-time guess. **Type guards come first:** a non-string `currency` (number/object/null) is treated as absent, never `.trim()`-ed (a throw would turn the whole result into `null` instead of dropping one field). **Hallucinated-`lineId` redirect on the doc path** pushes `{item, reason}` (not the CSV `{row, reason}` of `:3961`); the renderer prints `item` and, if `item` is absent, the literal "unidentified item". Model-supplied `item`, `reason` and `documentNote` must be strings and are length-capped, else dropped.
- **Empty after rules:** a match whose `fields` is empty after R1–R4 — **including a match whose only surviving datum is a hint currency** — is moved to `unmatched` with reason "no usable values extracted"; no empty panels, and no pre-filled form that carries nothing but a supplier and a currency.

### REQ-AI-GAP-013e — Limits
A client-side size cap (value in the SPEC) leaves headroom under the API request cap (base64 inflates ~33%). The SPEC **must cite a source** for the 32 MB request limit, per-image size/dimension limits, the PDF page limit for the chosen model, supported image types, block ordering and base64 handling — none is settled here. Malformed or over-limit files surface as the fail-soft message, never a thrown error or half-rendered panel.

### REQ-AI-GAP-013f — Proposal record, Apply, pre-filled form, and the save-time backstop

**1. Proposal record (corrects v2's "one additive field").** `cRfqFileImportProposals[lineId] = {supId, fields}` (`index.html:3983`) gains additive fields: `source: 'csv'|'doc'` (the CSV path now stamps `'csv'`), `dropReasons[]` (R2/R4 messages — stored because the renderer re-renders every pending proposal, including older ones, from this map, so reasons cannot be recomputed), `warnings[]` (R4 flags), `hintCurrency?`. `rfqRenderFileImportResults()` reads them and shows **"Read from image/PDF — verify against the source"** on `doc` panels only. **`rfqApplyFileProposal()` still reads only `proposal.fields` and `supId`; Apply's mechanics and the serialization lock are unchanged** — the data *shape* changes, the mechanics do not.

**2. Save-time currency backstop — an intentional, minimal change to `saveRfqResponse()` (resolves N3).** `saveRfqResponse()` currently reads `G('rfq-cur').value` unvalidated (`:4219`), and `editRfqResponse()` assigns the select from the stored value (`:4194`), so a stored currency outside the four options yields `''` and re-saves blank; `rfqApplyEmailParse` (`:4426`) writes an AI currency straight into the select with no vocabulary check. **Add one check to `saveRfqResponse()`: if `rfq-cur`'s value is not one of the four options, `vErr` ("Select a currency") and do not save.** The cost rule (`< 0` only) is **not** changed — a broader cost change would alter behaviour for every caller and is out of scope; the doc path enforces `> 0` itself via R2. **The refusal error must not outlive its cause (B2):** `vErr('rfq-cur', …)` appends a `ve-rfq-cur` span (`_vSpan`, `:11390-11400`) and nothing today clears one — `openRfqResponse`/`editRfqResponse` clear only `rfq-sup`/`rfq-cost` and a successful save marks only those two OK (`:4165`, `:4204`, `:4216`). **Required:** `openRfqResponse()` and `editRfqResponse()` call `vClr('rfq-cur')`, and a successful save calls `vOk('rfq-cur')` (AC-17b). This also closes the email-parse path's blank-currency exposure as a side effect, and means a legacy response with a non-option currency prompts the operator to pick one rather than being re-saved blank. **This is a behaviour change to shipped code** (tests: new refusal case; existing `saveRfqResponse` tests must still pass — they set `rfq-cur` to a valid option or are audited and fixed).

**3. Apply when a response from this supplier already exists (edit path).** Unchanged mechanism. If `cost` was dropped by R2, existing cost *and* currency are left untouched (lone currency also dropped) and the panel says "no price extracted — existing price unchanged".

**4. Apply when no response from this supplier exists yet, and a valid `cost`+currency survived.** Unchanged mechanism; saved with the **extracted** currency (R2 guarantees one).

**5. "Open pre-filled form" — new-response path with no surviving `cost` (resolves N4, B3).** `saveRfqResponse()` rejects an empty cost (`:4214-4215`), so auto-Apply could never succeed. The panel offers **Open pre-filled form** instead of Apply. Fully specified:
- **Supplier:** the handler sets `rfq-sup = proposal.supId` itself (as Apply does, `:4060`) — `rfqFillRfqFormFields()` does not touch the supplier.
- **Currency:** `openRfqResponse()` hard-sets `rfq-cur` to `USD` (`:4163`). The handler overwrites it: to the **hint currency** if one survived R2, otherwise it sets the select to **blank** (no matching option — per the HTML spec, assigning a non-matching value to a size-1 `<select>` yields `selectedIndex -1` and `value ''`, the same behaviour `editRfqResponse` already relies on at `:4194`), which the §2f-2 backstop then refuses to save — so the operator **must choose** a currency; it can never be silently inherited as `USD`. A short helper line beside the select says "Currency not stated in the document — choose one" when blank, so the operator is told why before a refused save. **The mock-DOM test cannot prove the browser behaviour** (`mockEl('rfq-cur')` is a plain object); a **real-browser Playwright check, with recorded evidence, is a mandatory build-gate item** (Playwright is available in this environment).
- **Doc-sourced proposals only.** A CSV-sourced new-response proposal with no cost keeps today's behaviour (Apply fails with the existing toast, `tests/run.js:13771`); it does **not** get this button.
- **Guards at click time, not render time (each guard states its operator feedback — resolves A5):** return if `cRfqFileImportApplyInFlight` is set (the freeze blocks pointer events on `of-lines-list`, which contains the panel, but not keyboard activation; `openRfqResponse()` writes the shared `cRfqOrdId`/`cRfqLineId`/`cRfqEditId` and form, so running it mid-Apply is the `REQ-AI-GAP-012` B1 corruption), return if `ov-rfq` is already open, and **re-check whether a response from this supplier now exists**. The in-flight and modal-open guards show a toast ("Finish the open response first"); if a response now exists, do **not** open a second new response (`saveRfqResponse()` has no duplicate-supplier check): toast "A response from this supplier now exists — re-run the import" and **remove that proposal and its panel** (its render-time Apply/Open decision is stale).
- **Lifecycle:** the proposal is **removed from `cRfqFileImportProposals` and its panel removed when the form is opened** (hand-off: the operator owns the form; if they cancel they re-run import). This prevents a second click creating a duplicate response. Because removal discards `warnings[]`, **any R4 warnings are shown as a toast on open** ("Review the pre-filled text — appears to contain contact or bank details").
- **No empty form:** the button appears only if at least one **non-currency** field survived (a hint currency alone moves the match to `unmatched`, §2d).
- It never auto-saves.

**6.** `editRfqResponse()`, the UI-freeze mechanism, and the id-rotation/`committedResponseId` repoint are unchanged. No bulk Apply.

### REQ-AI-GAP-013g — Documentation
`AI_SYSTEM_PROMPT` (button accepts PDF/images; HEIC unsupported; PDFs have no inline preview; always verify prices); `docs/user-guide.md`; `docs/known-gaps.md` (amend `AI-GAP-012`; §7); version strings; `CLAUDE.md`; version history; changelog.

---

## 3. Explicitly out of scope
`.xlsx`/`.docx`/non-comma CSV; GIF; multi-file/zip batching; auto-matching the supplier from the document; auto-creating lines or Suppliers from unmatched items; bulk Apply; **storing the uploaded file**; loosening the CSP; surfacing `notes` caveats at commit/Quote-conversion time (not tied to `cQteLine()` today — §7 gap); changing the date-suffixed model ID of the CSV/email paths; a broader cost-validation change to `saveRfqResponse()` (§2f-2 changes currency only); any use outside the RFQ flow.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `AI.key` | Doc parse invoked | `null`, **no fetch** |
| AC-2 | `.pdf` | Send | First user block is `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`; `data` has no `data:` prefix/newlines; block precedes the text block |
| AC-3 | `.png`/`.jpg`/`.webp` | Send | First block `{type:'image', …}` with matching `media_type` |
| AC-4 | `.heic/.heif`, `.xlsx`, or any unlisted type | Parse click | Rejected before any fetch, type-specific message; Parse click is the only trigger |
| AC-5 | HEIC renamed `.jpg` | Parse click | Rejected by signature check |
| AC-5b | `.JPG`; blank `file.type`; `application/octet-stream`; `a.pdf.jpg`; `file.type:'application/pdf'` with `.png` | Parse click | Upper-case, blank and octet-stream accepted; double extension judged by last extension + signature; contradicting non-empty type rejected |
| AC-5c | Double Parse click, or Cancel during the signature read | Read completes | Stale run token → no state resumed, no fetch |
| AC-6 | At cap / 1 byte over / zero-byte | Parse click | At cap accepted; over rejected naming the cap; zero-byte rejected as empty |
| AC-7 | PDF/image, Parse clicked, Send not clicked | Checkpoint shown | **No fetch, no base64 built**; image → `<img>` preview; PDF → name, size, **all five disclosure items asserted by substring**, unticked checkbox with the exact reworded text, **Send disabled until ticked**; Cancel leaves no state |
| AC-7b | An image object URL / pending doc exists | Each of the six exits in REQ-013c (incl. `rOrdLines` re-render, Order modal close, stale return, **Send double-click → exactly one fetch**) | `URL.revokeObjectURL` called once where an object URL existed; pending doc state cleared |
| AC-8 | `.csv` | Full flow | Identical to v2.9.85 **with exactly one stated, intended consequence of AC-17 (resolves B1)**: a CSV proposal whose `currency` is outside the four options (`usd`, `EUR`, `CNY`) previously reached the select as a non-matching value and was **silently saved with a blank currency**; it is now refused at save and the operator sees the existing "Could not apply automatically" toast (the CSV path is **not** given R1 normalisation — out of scope). The entire 012 group passes **unmodified**, *including* cost-only proposals with no currency (new-response Apply goes through `openRfqResponse`, which sets `USD`; edit tests load `currency:'USD'`); a CSV proposal gets `source:'csv'`. **A dedicated test covers the CSV `currency:'usd'` case.** |
| AC-8b | Extraction of `rfqNormalizeAIFileResult` | Before and after | Characterization tests (whitelist, non-object/array `fields`, wrongly-typed values) pass on the **unrefactored** code first, then on the extracted helper — the explicit CSV regression guard |
| AC-9 | Unknown `lineId` | Validated | → `unmatched`; never applied |
| AC-10a | Doc path: `cost` with no/invalid currency (`EUR`, `¥`, `""`, `undefined`) | Validated | `cost` dropped; reason in `dropReasons` and shown |
| AC-10a2 | Doc path: `' usd '`, `'cny'`, `'人民币'` | Validated | Normalised to `USD`/`RMB`/`RMB` |
| AC-10b | Doc path: `cost` `0`, `null`, `""`, `"12.5"`, negative, `NaN` | Validated | Dropped; a finite number > 0 with a valid currency survives |
| AC-10b2 | Doc path, edit path: currency present, no surviving cost | Validated | Currency dropped; existing cost and currency untouched |
| AC-10c | New-response path, valid cost + `RMB` | Apply | Saved as `RMB`, never the `USD` default |
| AC-10d | New-response path, no surviving cost | Panel | No Apply button; **Open pre-filled form** shown |
| AC-10d2 | Click Open pre-filled form | Click | Supplier pre-selected; `rfq-cur` = hint currency or **blank**; saves nothing; proposal and panel removed; clicking again is impossible; saving the form with blank currency is **refused** |
| AC-10d3 | Click while `cRfqFileImportApplyInFlight` | Click (incl. keyboard path) | No-op; shared form/globals untouched |
| AC-10d4 | A response from that supplier appeared after render | Click | No second response created; operator told one exists |
| AC-10e | Edit path, cost dropped | Apply | Existing cost and currency unchanged |
| AC-10f | Match emptied by R1–R4, no hint | Validated | Moved to `unmatched`, "no usable values extracted"; no empty panel |
| AC-11 | `notes` proposed | Apply | Persists via existing edit path; `committedResponseId` repoint/staleness identical to `REQ-AI-GAP-011` AC-6 |
| AC-11b | Any of `moq`/`leadTime`/`paymentTerms`/`notes` contains email/phone/IBAN-like text | Panel | Visible warning; not stripped |
| AC-11d | `"FOB Qingdao, 30% T/T deposit, 45 days, MOQ 10000 pcs"`, `"MOQ 500000"`, `"SHANGHAI"` | Panel | **No** contact/bank warning (negative cases) |
| AC-11c | Any of those four is an object/number/array, or over the length cap | Validated | Dropped / capped |
| AC-12 | Document is not a quote | Parsed | `matches` empty; `documentNote` banner shown; no panels; no error |
| AC-12b | Re-run with older pending panels present | Parsed | `documentNote` still shown |
| AC-12c | Doc-path `unmatched` entry | Rendered | Shows `item` + `reason` |
| AC-13 | Network error / non-200 / unparseable / over-limit | Parse | `null`; existing fail-soft message |
| AC-13b | `stop_reason==='max_tokens'` | Parse | Returns `{error:'max_tokens'}`; distinct "too long for one pass" message |
| AC-14 | Two pending proposals, any `csv`/`doc` mix | One Applied/Discarded | Other unaffected; lock/freeze as 012 AC-7/AC-7b; existing tests pass |
| AC-14b | `doc` and `csv` proposals coexist | Rendered | Provenance line on `doc` panels only |
| AC-15 | Any path | Any time | No file content, base64 or object URL in `localStorage`, `DB`, or any persisted key |
| AC-17 | `rfq-cur` blank or non-option | `saveRfqResponse()` (any caller: manual, Apply, email-parse, edit of a legacy record) | `vErr`, not saved; existing valid-currency tests still pass |
| AC-17b | A refused save set a `rfq-cur` error | `openRfqResponse()`, `editRfqResponse()`, or a later successful save | The `ve-rfq-cur` error and red border are cleared in all three cases; a form pre-filled with a valid currency shows no stale error |
| AC-16 | Mutations: block order swapped; R2 reverted; signature check removed; synchronous Send-clear removed; click-time guard removed; save-time currency backstop removed; `vClr('rfq-cur')` on open removed; proposal-removal-on-open removed | Suite | Each fails exactly its predicted test(s) |

---

## 5. Testing approach
Reuse `_mockAnthropic` and the 012 multi-line fixtures (`tests/run.js`). **New infrastructure is required, not assumed:** existing stubs mock only `readAsText`; add `readAsDataURL`, `readAsArrayBuffer`/`Blob.slice`; `URL.createObjectURL`/`revokeObjectURL` are stubbed only in some tests, so AC-7b needs its own. The mock `rfq-cur` is a plain object (no real `<select>` option semantics): the "no matching option → `''`" behaviour is simulated by setting `''`, and **a real-browser Playwright check, with recorded evidence, is a mandatory build-gate item (§2f-5)** (the review noted the mock harness would not catch it). Async tests use `testAsync`. **Known leak dependency to fix, not trip over (B1):** `tests/run.js:13020-13033` (`saveRfqResponse()`/`ordCommitRfqResponse()` AC-008) sets `rfq-sup` and `rfq-cost` but **never `rfq-cur`**, then dereferences `line.rfqResponses[0].id`; it passes today only because earlier tests (≈12935, 12969) left `'USD'` in the module-level `mockElements`. Under AC-17 a blank/leaked `''` makes that save refuse and the test throws a `TypeError`. **Fix: that test sets `mockEl('rfq-cur').value = 'USD'` explicitly, and `saveRfqResponse` shared setup resets `rfq-cur` to `'USD'` (the real default), not `''`; every new AC-17/AC-10d2 test that needs a blank sets it explicitly and restores it.** `tests/run.js:13117`, `13134`, `13148`, `9775` were audited and are safe. Any other new `mockElements` field a test sets (acknowledgement checkbox) is reset in shared setup. Every safety-critical assertion is mutation-tested (AC-16). **Accuracy is not a unit-test question** — the D7 evaluation is the only evidence of how well the model reads a WeChat screenshot.

---

## 6. Gate process
requirements-gate (this resubmission) → spec-gate → build-gate, each confirmatory until a clean PASS. No SPEC before a clean requirements PASS. The D7 evaluation (needs operator-supplied quotes) precedes SPEC approval.

---

## 7. Tracker / known-gaps updates on completion
Amend `AI-GAP-012`. New gaps (IDs assigned at ship; letters are placeholders): **(a)** accuracy on scanned/handwritten/low-resolution images not guaranteed — operator-verify only; **(b)** HEIC and GIF unsupported; **(c)** *FPM risk:* Incoterm, tier and unit basis live only in free-text `notes`, and `notes` caveats are not surfaced at commit or Quote-conversion (not tied to `cQteLine()`); **(d)** no stored copy of the source file — no audit trail beyond the operator's chat; **(e)** PDFs have no inline pre-send preview under the current CSP; **(f)** the numeric-string and `¥`/`$` strictness of R1/R2 lowers extraction hit-rate by design; **(h)** the CSV new-response path still inherits the `USD` default for a cost-only proposal; **(g)** `saveRfqResponse()`'s cost rule still allows `0` and non-finite-adjacent values on non-doc paths (manual entry, CSV, email-parse) — only currency is backstopped here. Also `docs/requirements-tracker.md` and the Notion tracker row (aggregate wording only), `CLAUDE.md`/`STACKD_CONTEXT.md` per the checklist. No backlog rows for the candidates doc.

---

## 8. GDPR, data-flow and FPM-domain flags

**GDPR — YES.**
1. **Browser → Anthropic API:** the whole file — supplier pricing (accepted flow) plus anything else in it: third-party names/phones/messages in screenshot margins; EXIF/GPS metadata; hidden PDF text, annotations, attachments. Mitigations: mandatory checkpoint (images previewed; PDFs disclosure + acknowledgement), crop/screenshot guidance, nothing sent on selection, `AI.key`-gated, no persistence (AC-15). **The checkpoint cannot show the operator everything transmitted; that is disclosed to them, not claimed otherwise.** The acknowledgement is deliberate friction plus an honest disclosure, not a verification control.
2. **Model output → localStorage and Supabase:** `moq`, `leadTime`, `paymentTerms` and `notes` are persisted into the Order Request (`DB.ord`, Cloud-Data-synced under `REQ-CLOUD-003`). A model transcription could carry personal or bank data from a screenshot into storage the operator never inspected. Mitigations: R4 on **all four** fields (string-only, length cap, commercial-terms-only prompt, heuristic warning); fields are shown in the diff before Apply. **Residual risk:** the prompt constraint is not a guarantee and the pattern check is heuristic.
3. **Retention / processing posture of the API for the chosen model: NOT VERIFIED here** (v1's claim withdrawn). The SPEC must state the actual position for the chosen model and the operator's account. `SEC-GAP-003` (API key in browser localStorage) is inherited unchanged.

**FPM — YES.** Output feeds `RfqResponse.cost`/`currency` → Quote lines (`cQteLine()`/`cQte()`) → buyer-facing prices. **What this REQ prevents, stated precisely:** on the **doc path**, a price whose currency is missing/invalid or whose value is not a finite number > 0 never reaches a saved response (R1/R2, in code); on the **doc path** a currency is never silently inherited — on the new-response path the form is either filled with the document's own currency or left blank and refused on save until the operator chooses (AC-10c/d2). **On the CSV new-response path the `USD` default is still silently inherited when a cost-only proposal omits currency (`:4163`) — unchanged, and logged as gap (h);** any save with a blank currency is refused on **every** path (AC-17, a side effect that also hardens the email-parse path); a price the model declares ambiguous is withheld (R3, prompt-level). **What it does not prevent:** a *confidently misread* number with a valid currency passes every guard and sits behind one Apply click — mitigated only by the "verify against the source" line and the operator's own check. The cost-`0` allowance in `saveRfqResponse()` is unchanged on non-doc paths (gap (g)).

---

## 9. Citations re-verified against live code this session
`:8` CSP; `:468` four `rfq-cur` options; `:444` `of-lines-list`; `:3339-3341` state vars; `:3822` `rOrdLines` sets `el.innerHTML`; `:3835` re-open replaces `innerHTML`; `:3841`, `:3867-3870`, `:3873`, `:3905`; `:3919-3924` generic null message; `:3930-3976` file-parse + validation + `allowed` (`:3956`); `:3983` proposal record; `:4005`, `:4009` renderer; `:4022` currency fill only when defined; `:4041-4081` Apply (supplier set `:4060`); `:4152-4165` `openRfqResponse` (`USD` at `:4163`); `:4194` `editRfqResponse` currency assignment; `:4207-4240` `saveRfqResponse` (cost check `:4214-4215`, currency read `:4219`, no duplicate-supplier check); `:4426` email-parse currency write; `:5662` generic `closeM`; `tests/run.js:13545,13559,13603` cost-only proposals.

---

## 10. Disposition of requirements-gate round 2 (v2: FAIL)
All six new blocking findings reproduced against the code and accepted. **N1** → R1–R4 scoped to `opts.strictDoc` (doc path only); CSV unchanged; AC-8 now true and asserted with cost-only proposals; emptied matches → `unmatched`. **N2** → lone currency dropped on the edit path; pre-filled form uses hint currency or **blank** (refused on save); §8 and AC-10d2 rewritten. **N3** → save-time currency backstop (§2f-2, AC-17) — chosen over listing it as a gap because it also hardens the email-parse path cheaply; R1 case/whitespace rule added; cost-`0` left as an explicit gap (g). **N4** → supplier pre-selected, click-time guards (in-flight, modal open, response-now-exists), proposal removed on open, no empty form (AC-10d2–d4). **N5** → exit list corrected (Cancel/Close merged, vacuous Parse-rejection removed, `rOrdLines` re-render, Order-modal close with new wiring named as new, Send synchronous clear, stale returns). **N6** → R4 extended to all four free-text fields incl. bank details, type guard, per-field cap. Advisories: A-a proposal record fields enumerated (`dropReasons`, `warnings`, `hintCurrency`, `source`; CSV stamps `'csv'`); B-b `{error:'max_tokens'}` return contract; C-c `documentNote` banner independent of older panels; D-d checkbox reworded, five disclosure items enumerated; E-e `file.type` rule defined, signature read guarded by run token; F-f §8 and D4 corrected; G-g numeric-string strictness stated deliberately. Candidates doc verified consistent with `CLAUDE.md` by the reviewer.

## 10b. Disposition of requirements-gate round 3 (v3: CONDITIONAL PASS)
N1–N6 confirmed closed by the reviewer. **B1** → AC-8 states the one CSV consequence of AC-17 and adds a dedicated test; the `tests/run.js:13020-13033` leak dependency is named with its fix (verified: that test never sets `rfq-cur`). **B2** → `vClr('rfq-cur')` on open/edit and `vOk` on success, AC-17b (verified: nothing clears a `rfq-cur` error today). A1 → mandatory Playwright evidence and a helper line on the blank select. A2/A3 → exit-4 semantics and harness limit stated; exit 5 reworded (no `closeOrd` exists; the only new wiring is a `closeM('ov-ord')` special-case). A4 → plumbing, type guards, doc-path unmatched shape. A5 → doc-only button, per-guard feedback, stale-proposal removal, warnings toast, hint-only → `unmatched`. A6 → negative ACs, patterns deferred to the SPEC. A7 → §8 scoped to the doc path, gap (h). A8 → noted, no change.

**Still unreviewed:** this v4 has had no independent review.
