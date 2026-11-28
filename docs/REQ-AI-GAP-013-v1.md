# REQ-AI-GAP-013 — AI-assisted RFQ response update from an uploaded supplier quote PDF or image

**Status:** v1 — DRAFT, not yet gated. Self-review is in §9 and is **not** a substitute for `requirements-gate`; submit only after `node scripts/check-req-citations.js docs/REQ-AI-GAP-013-v1.md` is clean.
**Type:** Small, additive AI feature. A new *input format* for the already-shipped `REQ-AI-GAP-012` (CSV quote import, v2.9.85). Reuses its per-line proposal state, Apply/Discard UI and serialization lock unchanged. Touches `index.html` only (no schema change, no Supabase migration, no new `DB` key).
**Supersedes the "CSV only" limitation recorded in `AI-GAP-012` (docs/known-gaps.md) for PDF and image files.** `.xlsx` and non-comma delimiters remain out of scope.

---

## 1. Business context

### 1.1 The request and the diagnosis

Operator asked whether the Orders tab can import PDFs. Direct code read: **no.** The only file input on the RFQ path is `accept=".csv"` (`index.html:3841`) and `rfqRunFileImport()` rejects any other extension before reading (`index.html:3867-3870`). The pasted-email parse (`rfqParseUpdateFromEmail`, `index.html:4439`) takes text only.

Operator then stated the real-world shape: supplier quotes arrive from **WhatsApp, WeChat, Alibaba and Made-in-China, as PDFs** (and, by the operator's own list of channels, very likely as chat screenshots/photos too — see Decision 1). None of those channels produces a CSV or a pasteable email body, so for this operator's actual sourcing channels the shipped CSV import is effectively unusable. This is the first AI-GAP in this series justified by a stated recurring workflow rather than a hypothetical one.

### 1.2 Design decisions

**Decision 1 — Accept PDF *and* common image formats in v1, not PDF alone.**
WeChat/WhatsApp quotes are frequently a photographed price list or a chat screenshot, not a PDF; Alibaba/Made-in-China chats are routinely screenshotted. Building PDF-only would hit the same wall within weeks. The Anthropic Messages API accepts both as content blocks (a base64 `document` block for `application/pdf`; a base64 `image` block for `image/jpeg`, `image/png`, `image/webp`, `image/gif`), so the marginal cost of images is one extra branch in one helper, not a second feature. **Accepted types: `.pdf`, `.png`, `.jpg`/`.jpeg`, `.webp`. HEIC/HEIF (default iPhone camera format) is *not* supported by the API and must be rejected with a specific message telling the operator to share as JPEG or take a screenshot instead** — never silently attempted.

**Decision 2 — No client-side PDF/OCR library. The model reads the file directly.**
Many of these PDFs are scans or rendered images with no text layer, so a text-extraction library (pdf.js) would fail on exactly the files that matter and would breach `CLAUDE.md`'s no-dependency policy. Sending the file to the model as a native content block needs no new dependency and handles Chinese-language documents.

**Decision 3 — One file, one selected supplier, per run. Same fan-out model as `REQ-AI-GAP-012`.**
The operator picks the supplier first (the AI is never asked to infer the counterparty). One file → proposals for every Order Request line it can confidently match → one Apply/Discard panel per line. No multi-file batching in v1.

**Decision 4 — The pre-send confirmation step is preserved, and for images/PDFs it matters *more*, not less.**
`REQ-AI-GAP-012` §1.3 required a mandatory review of parsed rows before any AI call. A PDF/image cannot be tokenized into rows, so the equivalent checkpoint is a **visual preview of exactly what will be transmitted**, with "Send to AI" / "Cancel". The risk is materially higher than for CSV: a WhatsApp/WeChat screenshot routinely shows *other* conversations, contact names, phone numbers and other customers' messages in the margins. The operator must see the whole image before it leaves the browser. The preview uses an in-memory object URL only; the confirm screen must carry copy telling the operator to crop to the quote before sending. Cancel discards the file and sends nothing.

**Decision 5 — No new RFQ fields. Incoterm, price tier and unit basis go in `notes`.**
The extractable set stays exactly `cost, currency, moq, leadTime, paymentTerms, notes` (the existing `allowed` list, `index.html:3956`). Supplier PDFs routinely carry things this schema has no field for: Incoterm (FOB/EXW/CIF), quantity-break price tiers, per-carton vs per-unit pricing, validity date, supplier-stated HS code. These are the highest-probability sources of a silently wrong price, so the prompt must route them into `notes` verbatim and the diff panel must display `notes` prominently (it already renders every proposed field via `rfqDiffRowsHtml`, `index.html:4368`).

**Decision 6 — Cost is proposed only when the unit basis is unambiguous.**
If the document shows a price whose basis (per piece / per carton / per set / per container) or Incoterm cannot be determined, the model must **leave `cost` out of `fields`** and describe what it saw in `notes`. A missing price the operator fills in by hand is a cheap failure; a plausible-looking wrong price that gets Applied and later converted into a Quote line is the expensive one (it flows into `cQteLine()`/`cQte()` and ultimately a buyer-facing price).

---

## 2. Requirements

### REQ-AI-GAP-013a — Shared file→content-block helper
One small function (working name `aiFileToContentBlock(file)`) that, for an accepted `File`, returns `{ok:true, block}` or `{ok:false, reason}`. It owns, in one place: the extension/MIME allow-list (Decision 1), the size cap (§2e), reading via `FileReader.readAsDataURL`, stripping the `data:...;base64,` prefix so the string contains **no newlines or prefix**, and emitting the correct block shape (`document` for PDF, `image` otherwise) with the correct `media_type`. No other function in this feature may build a content block. **This is the only piece deliberately factored for reuse (§6); nothing else is generalized in v1.**

### REQ-AI-GAP-013b — Extend the existing import control; do not add a second one
`rfqOpenFileImport()` (`index.html:3826`): the file input's `accept` becomes `.csv,.pdf,.png,.jpg,.jpeg,.webp` and its label "Quote File (CSV, PDF or image)". `rfqRunFileImport()` (`index.html:3859`) branches on type: `.csv` follows the **existing path byte-for-byte unchanged** (`parseImportCSV()` → `rfqShowFileImportConfirm()`); PDF/image goes to the new path below. Any other type is rejected before any read, with a message naming the accepted types. A `.xlsx` rejection message continues to say Excel is unsupported.

### REQ-AI-GAP-013c — New confirm step for PDF/image (Decision 4)
New function (working name `rfqShowFileImportConfirmDoc(ordId, supId, file)`) renders: file name, size in MB, a visual preview (`<img>` for images; for PDFs an `<embed>`/`<iframe>` of the object URL, or first-page-only if the spec-gate judges embedding unsafe under the app's CSP — spec call), the crop/privacy warning copy, and "Send to AI" / "Cancel". The file's base64 block is built **only after** "Send to AI" is clicked, not at selection time. The object URL is revoked on Send, Cancel and panel close. Nothing is written to `localStorage`, `DB` or any persisted key at any point (same no-persistence rule as `REQ-AI-GAP-012` §1.3).

### REQ-AI-GAP-013d — New function: `rfqParseUpdateFromDoc(block, lineContexts)`
Mirrors `rfqParseUpdateFromFile()` (`index.html:3930`) exactly in architecture: `AI.key`-gated (returns `null` with no fetch if absent), single `fetch()` to the Messages API, `try/catch` returning `null` on any failure, never throws. **Differences, and only these:** the user message content is an array `[contentBlock, {type:'text', text: JSON.stringify({lines: lineContexts})}]` with the document/image block **first**; the system prompt is a new `RFQ_DOC_IMPORT_PROMPT`; `max_tokens` is raised (a multi-page quote can list many items); and the model is chosen per Decision 7 below. The response validation block (known-`lineId` check, `allowed` field filter, hallucinated-`lineId` → unmatched) is **reused, not copied** — factor the shared post-processing out of `rfqParseUpdateFromFile()` into one helper both call, so the two paths cannot drift.

**Prompt requirements** (the spec fixes exact wording): match each *item/row in the document* to at most one provided line by description/spec; extract only values the document **explicitly states**; never infer a price from another item; put Incoterm, validity, tier breaks and unit basis in `notes` verbatim; leave `cost` out when basis is ambiguous (Decision 6); documents may be in Chinese — return structured values in English and quote any copied free text in `notes` with the original wording; return a document that is not a supplier quote (e.g. a chat with no prices) as an empty `matches` plus a reason, not an error.

**Decision 7 (open, resolved at spec-gate by measurement, not by assumption):** which model. Existing RFQ paths use `claude-haiku-4-5-20251001`. Vision accuracy on dense bilingual price tables with small print is materially harder than CSV row matching, and the cost of one wrong price is far above the per-call cost difference. **Before the SPEC is approved, run a fixed set of ≥10 real (redacted) operator quotes — covering a clean PDF, a scanned PDF, a WeChat screenshot, a Chinese-only quote, and a tiered-price quote — through the candidate models and record cost-field accuracy.** Pick the cheapest model that reaches an agreed accuracy bar; do not default to the cheapest or the most expensive. Note the existing code uses a date-suffixed Haiku ID; any new ID must be taken from the current model list, not recalled.

### REQ-AI-GAP-013e — Limits and rejection
Client-side cap on file size before any read (value fixed in the SPEC; must leave headroom under the API's request cap because base64 inflates payload by ~33% — a 32 MB request limit and a per-image size limit apply, **both to be re-verified against current docs in the SPEC, not assumed**). PDFs over the page limit for the chosen model's context window are rejected by the API; that failure must surface as the existing "AI parse unavailable" fail-soft message plus, where the status code allows, a hint that the file may be too large — never a thrown error or a half-rendered panel.

### REQ-AI-GAP-013f — Reuse proposal state, Apply/Discard and the serialization lock unchanged
Results feed the existing `rfqRenderFileImportResults()` (`index.html:3978`), `cRfqFileImportProposals`, `rfqApplyFileProposal()` (`index.html:4041`) and `cRfqFileImportApplyInFlight` (`index.html:3341`). **No change to `saveRfqResponse()`, `editRfqResponse()`, or the UI-freeze mechanism.** Re-running with a second supplier's file preserves unrelated pending proposals exactly as `REQ-AI-GAP-012` specifies.

### REQ-AI-GAP-013g — AI-proposed value is never auto-applied and is visibly provenance-marked
Every PDF/image-sourced proposal panel carries a visible "Read from image/PDF — verify against the source" line. Apply remains one-click-per-line. No bulk Apply. (This is the same trust model as `REQ-AI-GAP-012`; it is restated because image-reading error is a different error class from CSV-matching error and the operator should be reminded at the point of decision.)

### REQ-AI-GAP-013h — Documentation
Per the standing checklist: `AI_SYSTEM_PROMPT` updated so the assistant answers "can I upload a PDF/screenshot of a supplier quote" accurately (yes, via the Import Supplier Quote File button; types; HEIC not supported; always verify prices); `docs/user-guide.md` updated (new operator workflow); `docs/known-gaps.md` — `AI-GAP-012`'s "CSV only" entry amended, new gaps logged (§7); every version string per `CLAUDE.md`.

---

## 3. Explicitly out of scope

- **`.xlsx`, `.docx`, non-comma CSV delimiters.** Unchanged from `AI-GAP-012`.
- **Multi-file or multi-page-set batching, and zip archives.**
- **Auto-matching the supplier from document content.** Operator selects the supplier.
- **Auto-creating Order Request lines or Suppliers from unmatched items.**
- **Bulk "Apply All".**
- **Storing the uploaded file** (in `localStorage`, Supabase, or anywhere). A stored copy of a supplier quote is a document-management feature with its own retention/GDPR design; it is a separate decision.
- **Any use of the file outside the RFQ comparison flow** (see §6 — candidates only, none specified here).
- **Fixing the date-suffixed model ID used by the existing RFQ paths.** Noted, not changed here.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | No `AI.key` | Doc parse invoked | Returns `null`, **no fetch call made** |
| AC-2 | A `.pdf` selected | Operator clicks Send to AI | Request body's first user content block is `{type:'document', source:{type:'base64', media_type:'application/pdf', data:<string without newlines or data: prefix>}}`, followed by a `text` block; the document block is **before** the text block |
| AC-3 | A `.png`/`.jpg`/`.webp` selected | Send to AI | First block is `{type:'image', source:{type:'base64', media_type:<matching>, ...}}` |
| AC-4 | A `.heic` file | Selected and Parse clicked | Rejected before any read/fetch, with a message naming JPEG/screenshot as the alternative |
| AC-5 | A `.xlsx` file | Selected | Rejected before any read; message still states Excel is unsupported |
| AC-6 | A file over the size cap | Selected | Rejected before any read/fetch, message states the cap |
| AC-7 | A PDF/image selected | Before "Send to AI" is clicked | **No fetch has occurred**, no base64 block has been built; preview and privacy copy are shown; Cancel leaves no pending state and revokes the object URL |
| AC-8 | A `.csv` selected | Full flow | Behaves **identically to v2.9.85** — the entire existing `REQ-AI-GAP-012` test group passes unmodified (regression guard for the shared-path refactor) |
| AC-9 | Model returns a match with a `lineId` not in the Order Request | Response validated | Entry moves to `unmatched` with the generic "could not verify" reason; never applied (shared post-processing, so the same guard as CSV) |
| AC-10 | Model returns `cost` omitted and a `notes` string for an ambiguous-basis item | Rendered | Panel shows no proposed cost change and displays the notes; Apply does not overwrite the existing cost with blank/zero |
| AC-11 | Model returns an Incoterm/tier in `notes` | Applied | `notes` persists via the existing edit path; `committedResponseId` repoint and staleness behavior identical to `REQ-AI-GAP-011` AC-6 |
| AC-12 | Document is not a quote (no prices) | Parsed | Empty `matches`, a visible reason, no error, no panels |
| AC-13 | Network error / non-200 / unparseable JSON / over-limit PDF | Parse attempted | Returns `null`; existing fail-soft "AI parse unavailable" message; no partial state |
| AC-14 | Two lines have pending proposals from this file | One is Applied/Discarded | The other is unaffected; the serialization lock behaves exactly as in `REQ-AI-GAP-012` AC-7/AC-7b (existing tests still pass) |
| AC-15 | Any path | At any point | No file content, base64 string, or object URL is written to `localStorage`, `DB`, or any persisted key |
| AC-16 | Mutation: block order swapped (text before document) | Test suite run | AC-2 fails (proves the order assertion is load-bearing) |

---

## 5. Testing approach

Reuse the mocked-`fetch` harness (`_mockAnthropic`) and the multi-line Order Request fixtures from the `REQ-AI-GAP-012` test group. `FileReader` is not available in the Node VM sandbox — the SPEC must state how the harness supplies a `File`/`FileReader` stub (do not assume one exists; check `tests/run.js` first, as `CLAUDE.md` records mock-DOM gotchas repeatedly). Async tests use `testAsync` (a sync `test()` with an async body never fails — recorded twice in `CLAUDE.md`). Every safety-critical assertion (AC-2 ordering, AC-7 no-send-before-confirm, AC-10 no blank-cost overwrite, AC-15 no persistence) is mutation-tested: revert in a scratch copy, confirm the predicted test fails, restore.

**Accuracy is not a unit-test question.** Mocked-fetch tests prove the plumbing; they say nothing about whether the model reads a WeChat screenshot correctly. The Decision-7 evaluation set is the only evidence of that and is a gate deliverable, not an optional extra.

---

## 6. Where else this is useful — candidates, deliberately NOT specified here

The mechanism (file → content block → structured proposal → human Apply/Discard) is not RFQ-specific. Ranked by value and by how little new risk each adds. **None is in scope for this REQ; each needs its own REQ.** Listed so the helper in §2a is built to be reusable and so the backlog is explicit.

| Rank | Candidate | Why it's attractive | Why it's risky / what's new |
|---|---|---|---|
| 1 | **Supplier proforma invoice (PI) vs Purchase Order check** | PIs arrive as PDFs on the same channels. The app already has PO↔source drift detection (`renderPoSourceDriftWarn`). Extracting PI totals/lines and diffing against the PO catches a supplier changing a price or quantity between quote and PI — a real, expensive failure. Read-only diff, writes nothing by default. | Needs PO line matching; a PI is a legal/payment document, so provenance and "verify" copy matter. |
| 2 | **Supplier price list → Line Item catalogue** | Feeds the existing review-gated promotion queue (`DB.liPending[]`, v2.9.90) — Approve/Dismiss already exists and nothing writes to `DB.li` without an operator save. | Large multi-page lists; duplicate/versioning handling (LI-GAP-001/003 are already open in exactly this area). |
| 3 | **Shipping documents (packing list, B/L, commercial invoice) → Shipment** | Container/CBM/weight/port fields and the `tradeDocs[]` checklist (v2.9.86) could be pre-filled and ticked. | Shipment records carry `linkedInvs`/DG logic with fragile history (SH-GAP-002/003, SHIP-GAP-002); wrong DG or port is a customs problem. |
| 4 | **Buyer enquiry screenshot (WhatsApp) → Order Request line** | Same pain on the demand side; `triage.html` already exists for enquiry screening. | Buyer PII in screenshots; belongs inside the triage/10-minute-screen discipline, not bypassing it. |
| 5 | **Payment proof (bank slip / WeChat Pay screenshot) → supplier payment ledger entry** | Removes retyping. | **Highest risk.** Writes money records; duplicate-payment guard exists only as a confirm dialog (PMT-GAP-004 history). A misread amount is a ledger error, not a draft. Do last, if ever, and never auto-fill without the existing duplicate guard. |
| — | AI chat assistant file attachments | Convenient. | Largest surface, weakest review gate (chat replies aren't structured diffs). Not recommended. |

**Priority-drift check on this section:** this is a menu, not a roadmap. v1 ships RFQ only. Items 1–2 are the only ones worth a REQ in the near term, and only after RFQ import has been used on real quotes for long enough to show the extraction is trustworthy.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: amend `AI-GAP-012` (CSV-only no longer true for PDF/image; `.xlsx`/delimiter limits remain). New gaps to log when real: **(a)** extraction accuracy on scanned/handwritten/low-resolution images is not guaranteed — operator-verify only; **(b)** HEIC unsupported; **(c)** Incoterm/tier/unit-basis live only in free-text `notes`, not structured (a real schema gap if this proves valuable); **(d)** no stored copy of the source file, so a later "what exactly did the supplier quote" question has no audit trail beyond the operator's own chat history.
- `docs/requirements-tracker.md` + Notion "STACKD Reqs Tracker" row (aggregate wording only — no supplier/buyer names or amounts).
- `STACKD_CONTEXT.md` backlog table: add §6 candidates 1–2 as unscheduled rows.
- `CLAUDE.md` / `docs/version-history.md` / in-app changelog / all three version strings / `AI_SYSTEM_PROMPT` / `docs/user-guide.md` per the standing delivery checklist.

---

## 8. GDPR, data-flow and FPM-domain risk flags

**GDPR — YES, and higher than `REQ-AI-GAP-012`.** The whole file is transmitted to the Anthropic API. Beyond supplier commercial pricing (already an accepted flow for the CSV/email paths), a chat screenshot can contain **third-party personal data the operator did not intend to send**: other contacts' names and phone numbers, other customers' messages, the operator's own contact list. Mitigations are mandatory, not advisory: full-image preview before send (Decision 4), crop warning, no persistence (AC-15), `AI.key`-gated, nothing sent on selection. `SEC-GAP-003` (API key in browser localStorage) is unchanged and inherited. The SPEC must restate the data flow in the repo's standard GDPR data-flow table form and the requirements-gate must review it explicitly; the Anthropic retention posture for the chosen model must be checked, not assumed (some current models require 30-day retention and are unavailable under zero-data-retention).

**FPM domain — YES.** Output feeds `RfqResponse.cost`/`currency`, which on commit flow into Quote lines (`cQteLine()`/`cQte()`) and ultimately buyer-facing prices and margin. The specific new failure modes versus CSV: misread digits or decimal/thousand separators (EU vs US formatting in supplier documents), per-carton vs per-unit confusion, RMB vs USD mislabelled, Incoterm omitted, and a price tier read as the base price. Decisions 5 and 6 and AC-10 exist to turn these into visible `notes` or a *missing* price rather than a wrong one. The currency field especially: a supplier document in RMB read as USD is a 7× error — the SPEC must require currency to be explicitly stated in the document or omitted, never defaulted.

---

## 9. Self-review (author, this session — NOT independent)

Verified directly against `index.html` in this session (not from memory): `accept=".csv"` at `:3841`; `.csv`-only rejection at `:3867-3870`; the CSV send path, `rfqParseUpdateFromFile()`'s fetch/validation/`allowed` list at `:3930-3976`; proposal state vars at `:3338-3341`; `rfqApplyFileProposal` at `:4041`; the existing model ID is `claude-haiku-4-5-20251001`. API shape (base64 `document`/`image` blocks, document-before-text ordering, 32 MB request cap, 100-page limit on 200k-context models / 600 on 1M, no newlines in base64) taken from the current `claude-api` reference loaded this session — **the per-image size limit and the exact page/size caps for the chosen model were not independently confirmed and are explicitly deferred to the SPEC (§2e).**

Known weaknesses I am aware of and have *not* resolved:
1. **Decision 7 (model choice) is genuinely open** and depends on real-quote testing the operator has to supply. The REQ cannot pass spec-gate without that evidence.
2. **PDF preview in the confirm step** may be constrained by the app's CSP / sandbox; I did not check. Spec-gate item.
3. **`FileReader` in the Node test sandbox** — I did not check whether a stub exists. Spec-gate item (§5).
4. The "ambiguous basis → omit cost" rule (Decision 6) is a prompt instruction; prompts are not guarantees. AC-10 tests the *handling* of an omitted cost, not whether the model reliably omits it. Only the Decision-7 evaluation measures that.
5. No independent requirements-gate has run. Per `CLAUDE.md`, treat every claim above as unreviewed until it has.
