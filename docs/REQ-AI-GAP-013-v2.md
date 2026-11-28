# REQ-AI-GAP-013 — AI-assisted RFQ response update from an uploaded supplier quote PDF or image

**Status:** v2 — DRAFT, resubmitted after `requirements-gate` round 1 (v1: **FAIL**, 7 blocking B1–B7 + 7 advisory A1–A7). Every finding was re-verified against live code before being accepted (§10). Not yet re-gated. Run `node scripts/check-req-citations.js docs/REQ-AI-GAP-013-v2.md` before resubmission.
**Type:** Small-to-medium, additive AI feature: a new *input format* for the shipped `REQ-AI-GAP-012` (CSV quote import, v2.9.85). Touches `index.html` only. No schema change, no Supabase migration, no new `DB`/`K` key. One **additive** field on the in-memory proposal record (§2f).
**Amends** the "CSV only" limitation in `AI-GAP-012` (docs/known-gaps.md) for PDF and image files. `.xlsx` and non-comma delimiters remain out of scope.
**Related, not part of this REQ:** `docs/candidates-ai-document-input.md` (idea list; no backlog obligation).

---

## 1. Business context

### 1.1 The request and diagnosis
The only file input on the RFQ path is `accept=".csv"` (`index.html:3841`) and `rfqRunFileImport()` rejects any other extension (`index.html:3867-3870`); the pasted-email parse is text only (`rfqParseUpdateFromEmail`, `index.html:4439`). The operator's real sourcing channels — WhatsApp, WeChat, Alibaba, Made-in-China — deliver quotes as **PDFs and, very likely, screenshots/photos**, never CSV or pasteable email. For those channels the shipped import is effectively unusable.

### 1.2 Design decisions

**D1 — Accept PDF and common images.** Types: `.pdf`, `.png`, `.jpg`/`.jpeg`, `.webp`. **GIF is deliberately excluded** (not a realistic quote format; fewer cases to test). **HEIC/HEIF is rejected** with a message naming JPEG/screenshot as the alternative. The API accepts base64 `document` (PDF) and `image` blocks; image-vs-PDF is one branch in one helper.

**D2 — No client-side PDF/OCR library.** Scans have no text layer, so a text extractor would fail on the files that matter and breach the no-dependency policy. The model reads the file as a native content block (handles Chinese documents).

**D3 — One file, one operator-selected supplier, per run.** Same fan-out as `REQ-AI-GAP-012`. No multi-file batching. The AI is never asked to infer the supplier.

**D4 — The pre-send checkpoint is mandatory, and its form differs by type (resolves B1).**
The app's CSP (`index.html:8`) is `default-src 'none' … img-src 'self' data: blob:; object-src 'none'` with **no `frame-src`/`child-src`**. Therefore:
- **Images:** preview via `<img src="blob:…">` — permitted by the CSP. Full image shown, whole file visible.
- **PDFs: no inline preview is possible** (`<embed>`/`<object>` blocked by `object-src 'none'`; `<iframe>` falls back to `default-src 'none'`), and a first-page render would need a PDF renderer (barred by D2). **This REQ does not loosen the CSP** — its restrictions exist to contain XSS (`SEC-GAP-008`), and widening them for a convenience preview is not justified. Instead the PDF checkpoint shows: file name, size, an explicit **disclosure list** (below), and a **required acknowledgement checkbox** ("I have checked this PDF contains only the supplier's quote and nothing I don't want sent") that gates the Send button. The checkpoint copy tells the operator how to review first: open the PDF in their own viewer, or take a cropped screenshot of the quote pages and upload that instead (images *are* previewable). A convenience "open in new tab" link may be offered **only if** the SPEC demonstrates empirically that it works under the inherited blob/CSP behaviour; it is not assumed, and its absence does not weaken the checkpoint.
- **Disclosure list (both types, corrects the v1 claim that the preview is "exactly what will be transmitted"):** the *entire file* is sent, which includes content the preview does not show — image EXIF/GPS metadata, and for PDFs hidden text layers, annotations, embedded attachments and document metadata. The checkpoint states this in plain words.
- Cancel at the checkpoint discards the file and sends nothing.

**D5 — No new RFQ fields.** Extractable set stays `cost, currency, moq, leadTime, paymentTerms, notes` (`allowed`, `index.html:3956`). Incoterm, validity, tier breaks and unit basis go in `notes`.

**D6 — Cost and currency are coupled; a price without a stated unit basis or currency is never proposed (resolves B2, B3).** See §2d rules R1–R4.

**D7 — Model choice (open, decided by measurement before SPEC approval, not assumed).** Existing RFQ paths use a date-suffixed Haiku ID. Vision accuracy on dense bilingual price tables is materially harder than CSV row matching and a wrong price costs far more than the per-call price difference. Before the SPEC is approved, run **≥10 real, redacted operator quotes** (clean PDF, scanned PDF, WeChat screenshot, Chinese-only quote, tiered-price quote) through candidate models. **Proposed pass bar (operator to confirm or change before it is binding): zero "confident-wrong" cost or currency values on the set (a value is either correct or omitted), and ≥80% of price fields present in the source extracted.** The eval files live under `Test-data/` (gitignored; the repo is public — `SEC-GAP-020`) and are never committed. Sending the operator's own supplier documents to candidate models is the same trust boundary as production use and is accepted for evaluation. New model IDs come from the current model list, not recall. Whether `temperature` is accepted by each candidate model is checked per model in the SPEC (v1 silently carried over `0.2`).

---

## 2. Requirements

### REQ-AI-GAP-013a — Shared file→content-block helper
`aiFileToContentBlock(file)` → `{ok:true, block}` | `{ok:false, reason}`. Owns: the type allow-list (§2b), the size cap (§2e), `FileReader.readAsDataURL`, stripping the `data:…;base64,` prefix so the string has no prefix or newlines, and emitting the `document`/`image` block with the correct `media_type`. No other function builds a content block. This is the only piece factored for reuse.

### REQ-AI-GAP-013b — File-type detection and the single rejection trigger (resolves B7)
- **One trigger:** every rejection (type, size, zero-byte) happens on the **Parse click** in `rfqRunFileImport()` (`index.html:3859`), before any read beyond the signature check below and before any fetch. There is no change-handler on file selection. (Existing code validates only on Parse, `:3867-3870`.)
- **Detection rule:** lower-case the extension (`.JPG` ≡ `.jpg`; a double extension is judged by the last one). `media_type` is **derived from the extension via a fixed map, never from `file.type`** (which can be blank). If `file.type` is non-empty and contradicts the extension's class, reject. Then read the **first bytes** and verify the signature (`%PDF-`; PNG `89 50 4E 47`; JPEG `FF D8 FF`; WebP `RIFF….WEBP`) and reject on mismatch — this catches a HEIC renamed `.jpg` or a corrupted file before an API 400.
- Messages: unsupported type names the accepted types; `.heic/.heif` names JPEG/screenshot; `.xlsx` still says Excel is unsupported; zero-byte says the file is empty.
- `.csv` takes the existing path **unchanged** (`parseImportCSV()` → `rfqShowFileImportConfirm()`).

### REQ-AI-GAP-013c — Doc-path pending state and the checkpoint (resolves B1, B4)
New module-level state, in addition to (not replacing) `cRfqFileImportPendingRows` (`index.html:3339`): `cRfqFileImportPendingDoc = {file, supId, objectUrl|null}` (an object URL exists only for images). Nothing is built into base64 until **Send to AI** is clicked (AC-7). **The object URL (if any) and the pending file reference are released on every exit path**, enumerated so each is testable: (1) Send, (2) Cancel, (3) `rfqCloseFileImport()`, (4) re-opening `rfqOpenFileImport()` over an existing panel (`:3835` currently replaces `innerHTML` without closing — must now release first), (5) closing or navigating away from the Order Request modal, (6) a stale-panel early return (`G('ord-fileimport-'+ordId) !== panel`), (7) Parse rejection. Nothing about the file is written to `localStorage`, `DB` or any persisted key at any point.

### REQ-AI-GAP-013d — `rfqParseUpdateFromDoc(block, lineContexts)` and the doc-path response contract (resolves B2, B3, B5, A2, A4)
**Architecture** mirrors `rfqParseUpdateFromFile()` (`index.html:3930`): `AI.key`-gated (null, no fetch, if absent), one `fetch`, `try/catch` → `null`, never throws. User content is `[contentBlock, {type:'text', text: JSON.stringify({lines: lineContexts})}]`, **block first**. New prompt `RFQ_DOC_IMPORT_PROMPT`. `max_tokens` raised; a reply with `stop_reason === 'max_tokens'` is distinguished from a generic failure and surfaces "the document is too long for one pass — upload fewer pages" rather than the generic message (A2).

**Doc-path response schema (B5):**
`{ matches:[{lineId, fields}], unmatched:[{item, reason}], documentNote? }` where `item` is a short text description of the document item (a document has no "row"), and `documentNote` is an optional string (capped length) shown when `matches` is empty — e.g. "This image shows a chat with no prices." The renderer (`rfqRenderFileImportResults`, `index.html:3978`) must display `item` for doc-path unmatched entries (today it prints `JSON.stringify(u.row)`, `:4005`) and `documentNote` in place of the bare "No confident matches found" line. A non-array `unmatched` or a non-object response → `null`.

**Shared post-processing (A4).** Extract the validation currently inlined in `rfqParseUpdateFromFile()` (`:3953-3972`) into one helper, `rfqNormalizeAIFileResult(parsedObject, lineContexts)`, called by both paths so they cannot drift. **Before extracting, add characterization tests** for behaviour the existing 012 tests do not assert — the `allowed` field whitelist, non-object/array `fields`, wrongly-typed values — and run them green against the *unrefactored* code; after extraction, mutation-test them (AC-16-style). The refactor is the real CSV-path regression risk; "CSV unchanged" is a goal the tests must prove, not a statement.

**Cost/currency rules, enforced in code in the shared helper — not left to the prompt:**
- **R1 — currency vocabulary.** Valid currency = exactly one of the `rfq-cur` options (`USD`, `GBP`, `RMB`, `BBD`, `index.html:468`). A fixed normalisation table maps documented synonyms (e.g. `CNY`/`RMB`/`人民币`→`RMB`); `¥` and `$` alone are **ambiguous and not mapped**. Any other value (`EUR`, `INR`, free text) is invalid.
- **R2 — coupling.** A proposal's `cost` survives only if it is a finite number **> 0** (not `null`, `""`, a string, `0`, negative or `NaN`) **and** its `currency` is valid per R1. Otherwise **both `cost` and `currency` are dropped from `fields`** and the reason is appended to the proposal's visible message. Currency is never defaulted, in either the new-response or the edit path.
- **R3 — unit basis.** The prompt must output `cost` only when the unit basis (per piece / carton / set / container) and currency are stated in the document; per-carton or tier prices go to `notes` and `cost` is omitted. R3 is a prompt instruction and is **not a guarantee** — see §8.
- **R4 — `notes` content (B6).** `notes` may carry commercial terms only (Incoterm, validity, tier breaks, unit basis, quantities, packaging, HS code). The prompt forbids transcribing personal names, phone numbers, emails, WeChat/WhatsApp IDs, addresses and bank details. In code, `notes` is length-capped, and a simple pattern check (email-like, phone-like, long digit runs) **flags** a visible warning on the panel ("notes appear to contain contact details — review before Apply"); it warns, it does not strip. `notes` replaces the existing `notes` wholesale on Apply (the diff shows both); no append behaviour.

### REQ-AI-GAP-013e — Limits
A client-side size cap (value fixed in the SPEC) leaves headroom under the API request cap because base64 inflates ~33%. The SPEC **must cite a source** for the 32 MB request limit, per-image size/dimension limits, the PDF page limit for the chosen model's context window, supported image types, block ordering and base64 handling — none is treated as settled by this REQ (A2). An over-limit PDF/image or a malformed file that gets past the signature check surfaces as the existing fail-soft message, never a thrown error or half-rendered panel.

### REQ-AI-GAP-013f — Proposal record, provenance and Apply behaviour (resolves B3, B4)
- The proposal record `cRfqFileImportProposals[lineId] = {supId, fields}` (`index.html:3983`) gains **one additive field, `source: 'csv'|'doc'`**, set at creation. `rfqRenderFileImportResults()` reads it to show **"Read from image/PDF — verify against the source"** on doc-sourced panels only. CSV-sourced and doc-sourced proposals may coexist after a re-run (existing re-run merge semantics unchanged). This supersedes v1's claim that proposal state is "unchanged"; the change is the minimum needed to make REQ-013g true.
- **Apply when the line already has a response from the supplier (edit path):** unchanged mechanism (`editRfqResponse()` + `saveRfqResponse()`, id-rotation, `committedResponseId` repoint). If `cost` was dropped by R2, the existing cost/currency are left as they are and the panel states "no price extracted — existing price unchanged".
- **Apply when the supplier has no response yet (new-response path) and `cost` is absent (resolves B3):** `saveRfqResponse()` rejects an empty cost (`index.html:4214-4215`), so auto-Apply could never succeed and would leave the form open with a validation error. In this case **Apply is replaced by "Open pre-filled form"**: it calls `openRfqResponse()` and `rfqFillRfqFormFields()` with the surviving fields (`notes`, `moq`, `leadTime`, `paymentTerms`) and leaves the operator to type the cost and save. It never auto-saves and never leaves currency defaulted by omission (`openRfqResponse()` sets `rfq-cur` to `USD`, `index.html:4163`, which is why R2 forbids relying on that default).
- **Currency on Apply:** when `cost` survives, `currency` always survives (R2) and is always set on the form; the new-response default of `USD` therefore can never be silently inherited for an extracted price.
- Apply stays one-click-per-line; **no bulk Apply**. `saveRfqResponse()`, `editRfqResponse()` and the UI-freeze mechanism are unchanged.

### REQ-AI-GAP-013g — Documentation
Per the standing checklist: `AI_SYSTEM_PROMPT` (yes via the Import Supplier Quote File button; accepted types; HEIC unsupported; PDFs have no inline preview; always verify prices); `docs/user-guide.md`; `docs/known-gaps.md` (amend `AI-GAP-012`; new gaps §7); every version string; `CLAUDE.md`; version history; changelog.

---

## 3. Explicitly out of scope
`.xlsx`/`.docx`/non-comma CSV; GIF; multi-file or zip batching; auto-matching the supplier from the document; auto-creating Order Request lines or Suppliers from unmatched items; bulk "Apply All"; **storing the uploaded file anywhere**; any loosening of the CSP; surfacing `notes` caveats at commit or Quote-conversion time (not tied to `cQteLine()` today — logged as a gap, §7); changing the date-suffixed model ID used by the existing CSV/email paths; any use of document input outside the RFQ flow (see `docs/candidates-ai-document-input.md`).

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `AI.key` | Doc parse invoked | `null`, **no fetch** |
| AC-2 | `.pdf` selected | Send to AI | First user content block is `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`, `data` has no `data:` prefix and no newlines, and the block precedes the text block |
| AC-3 | `.png`/`.jpg`/`.webp` | Send to AI | First block is `{type:'image', …}` with the matching `media_type` |
| AC-4 | `.heic`/`.heif`, or `.xlsx`, or any unlisted type | Parse clicked | Rejected before any fetch with the type-specific message; **trigger is Parse click only** |
| AC-5 | A HEIC renamed `.jpg` | Parse clicked | Rejected by the signature check; no fetch |
| AC-5b | `.JPG` (upper-case) / blank `file.type` / `a.pdf.jpg` | Parse clicked | Upper-case accepted; blank `file.type` accepted; double extension judged by the last extension and signature-checked |
| AC-6 | File exactly at the cap / 1 byte over / zero-byte | Parse clicked | At cap accepted; over rejected with the cap stated; zero-byte rejected as empty |
| AC-7 | PDF or image selected and Parse clicked, Send not yet clicked | Checkpoint shown | **No fetch, no base64 block built**; image shows an `<img>` preview; PDF shows name, size, disclosure list and an unticked acknowledgement checkbox with **Send disabled** until ticked; Cancel leaves no pending state |
| AC-7b | An image object URL exists | Any of the seven exit paths in REQ-013c | `URL.revokeObjectURL` called once; pending doc state cleared |
| AC-8 | `.csv` | Full flow | Identical to v2.9.85; the entire existing 012 test group passes **unmodified**, plus the new characterization tests (REQ-013d) pass before and after the helper extraction |
| AC-9 | Model returns a `lineId` not in the Order Request | Validated | Entry moves to `unmatched`; never applied |
| AC-10a | Model returns `cost` with no `currency`, or an out-of-vocabulary currency (`EUR`, `¥`, `""`) | Validated | **Both** `cost` and `currency` removed from `fields`; reason shown on the panel |
| AC-10b | `cost` is `0`, `null`, `""`, `"12.5"` (string), negative, or `NaN` | Validated | `cost` (and `currency`) dropped; a valid positive finite number with a valid currency survives |
| AC-10c | New-response path, extracted `cost` present and valid | Apply | Saved with the **extracted** currency, never the `USD` default (test uses `RMB`) |
| AC-10d | New-response path, `cost` absent | Panel rendered | **No Apply button**; "Open pre-filled form" shown; clicking it opens the response modal with the surviving fields, **saves nothing**, leaves `rfq-cur` untouched by omission |
| AC-10e | Edit path, `cost` dropped | Apply | Existing `cost` and `currency` unchanged |
| AC-11 | `notes` proposed (e.g. Incoterm) | Applied | Persists via the existing edit path; `committedResponseId` repoint/staleness identical to `REQ-AI-GAP-011` AC-6 |
| AC-11b | `notes` contains an email-like or phone-like string | Panel rendered | Visible "review notes — appears to contain contact details" warning; not stripped |
| AC-12 | Document is not a quote | Parsed | `matches` empty, `documentNote` displayed, no error, no panels |
| AC-12b | Doc-path `unmatched` entry | Rendered | Shows `item` and `reason`, not `JSON.stringify(row)` |
| AC-13 | Network error / non-200 / unparseable JSON / over-limit file | Parse attempted | `null`; existing fail-soft message |
| AC-13b | Response `stop_reason === 'max_tokens'` | Parse attempted | Distinct "document too long for one pass" message, not the generic one |
| AC-14 | Two lines with pending proposals (any mix of `csv`/`doc`) | One Applied or Discarded | The other unaffected; serialization lock and UI freeze behave exactly as in 012 AC-7/AC-7b (existing tests pass) |
| AC-14b | A `doc`-sourced and a `csv`-sourced proposal coexist | Rendered | Provenance line appears on the `doc` panel only |
| AC-15 | Any path | At any point | No file content, base64, or object URL is written to `localStorage`, `DB` or any persisted key |
| AC-16 | Mutation: block order swapped; coupling rule R2 reverted; signature check removed; seven-exit-path revoke removed | Suite run | Each mutation fails exactly its predicted test(s) |

---

## 5. Testing approach
Reuse `_mockAnthropic` and the multi-line Order Request fixtures from the 012 group (`tests/run.js`). **New test infrastructure is required, not assumed to exist:** the existing stubs mock only `readAsText`; `readAsDataURL` and `FileReader.readAsArrayBuffer`/`Blob.slice` (for the signature check) must be added, and `URL.createObjectURL`/`revokeObjectURL` are stubbed only in some tests, so revocation (AC-7b) needs its own stub. Async tests use `testAsync`. Per `CLAUDE.md`, any new `mockElements` field a test sets (acknowledgement checkbox, `rfq-cur`) must be reset in shared setup or leaks into later tests. Every safety-critical assertion (AC-2 order, AC-7 no-send-before-checkpoint, AC-10a–e, AC-15) is mutation-tested. **Accuracy is not a unit-test question** — mocked fetch proves plumbing, not whether the model reads a WeChat screenshot correctly; the D7 evaluation is the only evidence of that and is a gate deliverable.

---

## 6. Gate process
requirements-gate (this resubmission) → spec-gate → build-gate, each confirmatory until a clean PASS. Spec work does not begin before a clean requirements PASS. The D7 evaluation (needs operator-supplied quotes) is a precondition for SPEC approval.

---

## 7. Tracker / known-gaps updates on completion
Amend `AI-GAP-012`. New gap IDs are assigned at ship time (placeholders): **(a)** extraction accuracy on scanned/handwritten/low-resolution images is not guaranteed — operator-verify only; **(b)** HEIC and GIF unsupported; **(c)** *FPM risk, not an enhancement:* Incoterm, tier and unit basis live only in free-text `notes`, and `notes` caveats are not surfaced at commit or Quote-conversion time (not tied to `cQteLine()`), so a caveat can be lost between Apply and a buyer-facing price; **(d)** no stored copy of the source file, so there is no audit trail of what the supplier actually quoted beyond the operator's own chat history; **(e)** PDFs have no inline pre-send preview under the current CSP. Also: `docs/requirements-tracker.md` and the Notion tracker row (aggregate wording only), `CLAUDE.md`/`STACKD_CONTEXT.md` per the delivery checklist. **No backlog rows are added for the candidates list** (removed after gate A1).

---

## 8. GDPR, data-flow and FPM-domain flags

**GDPR — YES; higher than `REQ-AI-GAP-012`.** Data flows:
1. **Browser → Anthropic API (outbound):** the *whole file* — supplier pricing (accepted flow, as CSV/email), plus anything else in it: for screenshots, third-party names/phone numbers/other customers' messages in the margins; EXIF/GPS metadata; hidden PDF text, annotations, attachments. Mitigations: mandatory checkpoint (D4 — image preview; PDF acknowledgement + disclosure), crop/screenshot guidance, nothing sent on selection, `AI.key`-gated, no persistence of the file (AC-15). **The checkpoint cannot show the operator everything that is transmitted** (hidden layers, metadata); this is disclosed to them, not claimed otherwise.
2. **Model output → localStorage and Supabase (inbound, new vs v1, B6):** `notes` is persisted into the Order Request (`DB.ord`, Cloud-Data-synced under `REQ-CLOUD-003`). A model transcription could carry personal data from a screenshot into storage the operator never saw. Mitigations: R4 (commercial terms only, length cap, contact-detail warning), `notes` shown in the diff before Apply, and the operator is told to review it. Residual risk: the prompt constraint is not a guarantee and the pattern check is heuristic.
3. **Retention / processing posture of the API for the chosen model: NOT VERIFIED here.** v1's claim about 30-day retention and zero-data-retention availability was an unverified assertion and is withdrawn. The SPEC must state the actual position for the chosen model and the operator's account. `SEC-GAP-003` (API key in browser localStorage) is inherited unchanged.

**FPM domain — YES.** Output feeds `RfqResponse.cost`/`currency`, which on commit flow into Quote lines (`cQteLine()`/`cQte()`) and buyer-facing prices. Failure modes specific to document reading: misread digits or decimal/thousand separators, per-carton vs per-unit, RMB read as USD (7×), omitted Incoterm, tier price read as base. **What this REQ actually prevents:** a price whose currency is missing/invalid or whose value is not a positive finite number never reaches the form (R1/R2, enforced in code); a currency is never silently defaulted (AC-10c); a price the model declares ambiguous is withheld (R3, prompt-level). **What it does not prevent:** a *confidently misread* number with a valid currency passes every guard and sits behind one Apply click. That residual risk is mitigated only by the "verify against the source" provenance line and the operator's own check, and is stated here rather than implied away. (v1 overstated Decisions 5/6 as preventing this.)

---

## 9. Citations verified against live code this session
`:8` CSP (`object-src 'none'`, no `frame-src`); `:468` `rfq-cur` has four options; `:3338-3341` pending/proposal/in-flight vars; `:3841`, `:3867-3870`; `:3835` re-open replaces `innerHTML`; `:3930-3976` file-parse function and its `allowed`/validation; `:3978-4010` renderer (prints `JSON.stringify(u.row)` at `:4005`; `{supId, fields}` record at `:3983`); `:4022` currency fill only when defined; `:4041-4081` Apply; `:4163` `openRfqResponse` defaults `rfq-cur` to `USD`; `:4214-4215` `saveRfqResponse` cost validation; `:4368` diff rows.

---

## 10. Disposition of requirements-gate round 1 (v1: FAIL)
All 7 blocking findings reproduced against the code above and accepted. B1 → D4/REQ-013c (CSP verified). B2 → R1/R2, AC-10a–c (default-`USD` path and 4-option select verified). B3 → REQ-013f new-response behaviour, R2, AC-10b/d/e, §8 rewritten to stop overstating (validation at `:4214` verified). B4 → additive `source` field, enumerated exit paths. B5 → doc-path schema and renderer change. B6 → R4, §8 flow 2, withdrawn retention claim. B7 → single Parse trigger, signature detection, AC-5/5b/6. Advisories: A1 candidates moved to their own doc and backlog obligation removed; A2 per-claim SPEC citation requirement, GIF decided, `temperature` per-model, `max_tokens` truncation distinguished; A3 eval location, proposed measurable bar; A4 characterization tests before extraction, helper signature stated, function names corrected (`rfqParseUpdateFromDoc(block, lineContexts)`); A5 `notes` replace-wholesale stated; A6 new test infrastructure stated; A7 placeholder gap letters labelled, (c) reframed as FPM risk.

**Still unreviewed:** this v2 has had no independent review. Treat every claim as unverified until the confirmatory gate round.
