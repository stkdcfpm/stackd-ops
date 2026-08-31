# REQ-ORD-006 — Edit and delete RFQ responses

**Status:** v1 — requirements-gate CONDITIONAL PASS, no blocking findings. The highest-risk item — the §1.2 staleness-mechanism reasoning — was independently hand-traced against the real code and confirmed sound. Two advisories fixed (see §8).
**Type:** Small, additive feature closing a real UX gap. No data-shape change to existing records beyond a new (optional, backward-compatible) UI affordance. Touches `index.html` only.

---

## 1. Business context

### 1.1 The complaint and the diagnosis (from check-first, this session)

User asked: when a supplier sends an updated/revised quote for a product they'd already recorded a price for, how do they update it in Stackd Ops?

Found by direct code read: this depends on which stage the pricing is at.

- **Already converted into a Quote** (Quotes tab): fully supported today — reopen the Quote, edit the line's Cost field, save. `calcQte()`/`saveQte()` recalculate everything live and automatically version the change (`line.priceHistory[]`). No gap here.
- **Still at the sourcing stage** — an Order Request line's "Compare RFQs" panel, where multiple suppliers' RFQ responses are recorded and one is marked "Committed" before converting to a Quote (`REQ-QTE-001` Part B): **this is a real gap.** `openRfqResponse(lineId)` (`index.html:3119-3139`) always resets its form to blank — there is no code path that pre-fills it from an existing response. `saveRfqResponse()` (`index.html:3141-3163`) unconditionally does `line.rfqResponses.push({...})` — every save creates a brand-new entry, never updates one in place. Grepped the whole file for a delete function (`delRfqResponse`, `removeRfqResponse`) — none exists. The comparison table (`renderRfqComparison()`, `index.html:3190-3226`) renders only a Commit/Uncommit button per response row — no Edit, no Delete.

**Today's only workaround:** click "+ Add Response" again for the same supplier with the new numbers, then Commit the new one instead of the old. The stale, superseded response is left sitting in the comparison table forever, uncommitted, with no way to remove it — a growing pile of dead entries on any line that gets re-quoted more than once.

### 1.2 A subtlety found while designing the fix: reusing, not duplicating, the existing Quote staleness mechanism

`REQ-QTE-001` Part B already built a staleness-warning mechanism for exactly the "supplier pricing changed after a Quote was built" scenario — but only for the case of a *different* response being committed afterward. `renderQteSourceDriftWarn()` (`index.html:11392-11411`) detects drift with `ordLine.committedResponseId !== l.sourceRfqResponseId` — a straight ID comparison. If this REQ's edit feature simply mutated a response's fields **in place, keeping the same `id`**, an operator editing an already-committed, already-converted-to-Quote response would silently **not** trigger that existing warning — `committedResponseId` would never change, since it's still pointing at the same id, just with new numbers behind it. The Quote would keep showing stale figures with no banner telling the operator to check.

**Design decision: an edit generates a new response `id` and replaces the array entry, rather than mutating in place.** If the edited response was the currently-committed one, `line.committedResponseId` is updated to point at the new id. This means `renderQteSourceDriftWarn()`'s existing comparison correctly detects the drift **with zero changes to that function** — a Quote already built from the old id now has a `sourceRfqResponseId` that no longer matches `committedResponseId`, exactly the condition that function already checks for. Reusing the existing mechanism, not building a second one.

---

## 2. Requirements

### REQ-ORD-006a — `editRfqResponse(lineId, responseId)`
New function, mirroring `openRfqResponse(lineId)`'s modal-opening logic but pre-filling every field (`rfq-sup`, `rfq-cost`, `rfq-cur`, `rfq-cbm`, `rfq-dutypct`, `rfq-dg`, `rfq-moq`, `rfq-leadtime`, `rfq-payterms`, `rfq-con`, `rfq-notes`) from the existing response object. Sets a new module-level state variable, `cRfqEditId` (`null` when adding a new response — the existing flow, unchanged — set to the response's `id` when editing). Opens the same `ov-rfq` modal (no new modal needed).

### REQ-ORD-006b — `saveRfqResponse()` branches on edit vs. add
- **Unchanged path (REQ-ORD-006a's `cRfqEditId` is `null`):** behaves exactly as today — validates, pushes a new response with a fresh `id`. Zero behavior change for the existing "+ Add Response" flow.
- **New path (`cRfqEditId` is set):** validates the same way, then builds a replacement response object with a **new** `id` (not the old one — see §1.2) and the submitted field values, and replaces the entry at that position in `line.rfqResponses` (`.map()`, swapping the matched entry, not `.push()`). If `line.committedResponseId === cRfqEditId` (the response being edited was the committed one), update `line.committedResponseId` to the new id, so the line's "committed" state is preserved across the edit and `renderQteSourceDriftWarn()`'s existing mechanism (§1.2) correctly fires for any Quote already sourced from the old id. Resets `cRfqEditId` to `null` after saving, whether editing or adding, so the modal defaults back to "add" mode next time it's opened via `openRfqResponse()`.

### REQ-ORD-006c — `delRfqResponse(lineId, responseId)`
New function, `confirm()`-gated (matching the existing `delLI()`/`delSup()` pattern, `index.html:5483` onward — plain `confirm()`, not a custom modal, consistent with this codebase's existing delete UX for similarly low-stakes records). If the response being deleted is the currently-committed one (`line.committedResponseId === responseId`), the confirm message explicitly warns that deleting it will un-commit the line and that a Quote already built from it will show the existing "source pricing changed" staleness banner (§1.2's mechanism fires here too, for the same reason: `committedResponseId` becomes `null`, no longer matching any Quote's stored `sourceRfqResponseId`). On confirm: removes the response from `line.rfqResponses`, and if it was committed, sets `line.committedResponseId = null`. Deleting a non-committed response only removes that one entry — no other side effects.

### REQ-ORD-006d — Comparison panel UI: Edit and Delete buttons
`renderRfqComparison()` (`index.html:3190-3226`)'s per-response row gains two new buttons alongside the existing Commit/Uncommit button: **Edit** (calls `editRfqResponse(lineId, r.id)`) and **Delete** (calls `delRfqResponse(lineId, r.id)`), matching the existing button styling/sizing convention already used in that row (`class="btn btn-g"`, `font-size:.44rem`).

---

## 3. Explicitly out of scope

- **No version-history/audit trail for RFQ response edits.** Unlike Quote lines (`priceHistory[]`, versioned on `saveQte()`), an edited RFQ response's prior values are simply gone once replaced — the old array entry is removed, not archived. This is deliberate: RFQ responses are pre-Quote sourcing/comparison data, not the financial record of record; once a response is committed and converted, the Quote's own `priceHistory[]` becomes the authoritative versioned log. A full audit trail of RFQ response edits (who changed what, when) would be a separate, larger REQ if ever needed — not assumed here.
- **No change to `renderQteSourceDriftWarn()`, `ordConvertToQuote()`, or any other REQ-QTE-001 Part B mechanism.** §1.2's whole point is that the existing staleness detection is reused unmodified, correctly, by design — confirmed by tracing through the exact comparison it performs.
- **No change to the "+ Add Response" flow's existing behavior** for a genuinely new response — REQ-ORD-006b's unchanged path is verified byte-identical to today's `saveRfqResponse()` when `cRfqEditId` is `null`.
- **No AI capability to auto-populate an edit from a pasted supplier email.** That's a separate, explicitly-dependent REQ (`REQ-AI-GAP-011`) which requires this REQ to ship first, since there is currently no update mechanism at all for it to hook into.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | An Order Request line with one RFQ response, not committed | "+ Add Response" is used (unchanged flow) | A second, independent response is added; the first is untouched — confirms REQ-ORD-006b's "unchanged path" claim |
| AC-2 | An Order Request line with one RFQ response, not committed | It is edited via `editRfqResponse()` with new cost/terms | `line.rfqResponses` still has exactly one entry, now with the new values and a **different** `id` than before |
| AC-3 | A response that is the line's `committedResponseId` | It is edited | `line.committedResponseId` is updated to the edited response's new `id` — the line's committed state is preserved across the edit |
| AC-4 | A Quote already converted from a committed RFQ response (`sourceRfqResponseId` set, matching REQ-QTE-001 Part B's fixtures) | That same response is later edited (not re-committed to a different response — the same one, just updated) | Reopening the Quote shows the existing "Source pricing has changed" staleness banner (`renderQteSourceDriftWarn()`) — this is the AC that would have been silently broken by an in-place mutation instead of the new-id-and-repoint design in §1.2 |
| AC-5 | A response that is the line's `committedResponseId` | It is deleted | The response is removed from `line.rfqResponses`; `line.committedResponseId` becomes `null`; a Quote already converted from it shows the same staleness banner as AC-4, for the same underlying reason |
| AC-6 | A response that is **not** the line's `committedResponseId` | It is deleted | Only that entry is removed; `line.committedResponseId` (pointing at a different response) is unaffected |
| AC-7 | The comparison panel for a line with 2+ responses | Rendered | Each row shows Edit and Delete buttons alongside the existing Commit/Uncommit button |
| AC-8 (new, requirements-gate) | The currently-committed response | Delete is clicked | The `confirm()` message text explicitly names the un-commit and staleness-banner consequences described in REQ-ORD-006c — asserted via a captured-`confirm`-message test, following the existing precedent for this exact assertion style (`delSup()`'s AC-011, `tests/run.js:7467-7481`, `assertContains(capturedMsg, ...)`) |

---

## 5. Testing approach

Fully unit-testable in the existing Node harness (`tests/run.js`) — no AI/network dependency, pure DOM-mock + DB-state logic, following the same test style already used for `saveRfqResponse`/`ordCommitRfqResponse`/`renderQteSourceDriftWarn`. **Fixture citation corrected at requirements-gate:** the original draft attributed the committed-response-to-Quote-conversion fixtures to "REQ-QTE-001 Part B" — that REQ's own fixture, `mkOrdWithLine()` (`tests/run.js:7313-7325`), only models the Order-Request-side RFQ comparison (`rfqResponses[]`/`committedResponseId`), with no Quote object and no `sourceRfqResponseId` at all. The fixtures that actually model the full committed-response-to-Quote conversion, and that AC-4/AC-5 need, are `mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()` (`tests/run.js:7712-7735`), filed under **REQ/SPEC-INTEG-001 Phase 1** (`tests/run.js:7710`) — the same REQ `index.html:4542-4568`'s own code comment attributes `renderQteSourceDriftWarn()` to. Use `mkOrdWithLine()`'s `rfqResponses` shape for the response-mutation half of AC-1/AC-2/AC-3, and `mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()` for the Quote/staleness half of AC-4/AC-5 — reuse and extend both, don't build fresh fixtures for either half.

---

## 6. Gate process

Standard requirements-gate → spec-gate → build-gate cycle. Not financial-calculation-adjacent in the way `REQ-QTE-002` was, but does touch the same staleness-warning mechanism `REQ-QTE-001` Part B went through 3 independent review rounds to get right — do not shortcut the review of AC-4/AC-5 specifically.

---

## 7. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: no existing gap to mark fixed (a user question, not a previously-logged gap) — no new gap entry needed, this is a feature addition.
- `docs/requirements-tracker.md`: new row.
- `STACKD_CONTEXT.md`/`CLAUDE.md`: version-ship housekeeping per the standing checklist.
- `AI_SYSTEM_PROMPT`: review whether the existing RFQ-comparison description needs updating to mention edit/delete are now possible (currently only describes adding/committing responses).

---

## 8. Review-resolution log

**Requirements-gate independent review: CONDITIONAL PASS, no blocking findings.** Every code citation (`openRfqResponse()`, `saveRfqResponse()`, `renderRfqComparison()`, `renderQteSourceDriftWarn()`, the `delLI()`/`delSup()` confirm pattern) verified accurate to the exact line. The core diagnosis (push-only save, blank-only open, no delete function anywhere) confirmed by grep. **§1.2's staleness-mechanism reasoning — the single highest-risk claim in this REQ — was independently hand-traced against the real code with a concrete worked example** (a Quote line frozen at `sourceRfqResponseId:'r1'`, an edit generating new id `'r2'` and repointing `committedResponseId`, correctly producing a `'r2' !== 'r1'` mismatch that fires the existing banner) and confirmed sound — nothing backwards, nothing missing. AC-4/AC-5 were confirmed to be load-bearing exactly as intended: tracing both the in-place-mutation regression and the delete-without-nulling regression by hand through the ACs' own wording shows each would genuinely fail without the correct implementation. Two advisories, both fixed:

1. **Missing AC for the delete-confirm() message content.** REQ-ORD-006c requires the confirm dialog to explicitly name the un-commit/staleness consequences when deleting a committed response, but no AC tested for that text. **Fixed:** added AC-8, citing the exact existing precedent for asserting on captured `confirm()` message text (`delSup()`'s AC-011, `tests/run.js:7467-7481`).
2. **Fixture citation misattributed.** §5 originally cited "the REQ-QTE-001 Part B fixtures" for the committed-response-to-Quote-conversion test setup AC-4/AC-5 need — that REQ's actual fixture (`mkOrdWithLine()`) only models the Order-Request side, with no Quote/`sourceRfqResponseId` involved at all. The fixtures that actually model the conversion belong to REQ/SPEC-INTEG-001 Phase 1 (`mkOrdWithCommittedResponse()`/`saveQteSetupIntegLine()`, `tests/run.js:7710-7841`), which is also what `index.html:4542-4568`'s own comment attributes `renderQteSourceDriftWarn()` to. **Fixed:** §5 corrected to cite both fixtures precisely, split by which half of the ACs each covers.

Proceeding to spec-gate.
