# Candidates: other places AI document input (PDF / image) could be used

**Status:** idea list only. Not a roadmap, not a requirement, no backlog obligation. Split out of `REQ-AI-GAP-013` after its first requirements-gate (A1: the list was scope creep inside a v1 REQ). Each item needs its own REQ and its own gate cycle.

Mechanism common to all: file → content block → structured proposal → human Apply/Discard. The only code `REQ-AI-GAP-013` factors for reuse is the file→content-block helper.

| Rank | Candidate | Why attractive | Risk / what's new |
|---|---|---|---|
| 1 | **Supplier proforma invoice (PI) vs Purchase Order check** | PIs arrive as PDFs on the same channels. Catching a supplier changing a price or quantity between quote and PI is a real, expensive failure. Read-only diff, writes nothing by default. | The shipped `renderPoSourceDriftWarn()` compares a **PO to its source Invoice** (`PO-GAP-003`), not a PO to a supplier document — this would be a **new** comparison, not an extension. A PI is a payment document, so provenance and "verify" copy matter. |
| 2 | **Supplier price list → Line Item catalogue** | Feeds the existing review-gated promotion queue (`DB.liPending[]`, v2.9.90). Nothing writes to `DB.li` without an operator save. | Large multi-page lists; duplicate/versioning handling (`LI-GAP-001`/`003` are already open in this area). |
| 3 | **Shipping documents (packing list, B/L, commercial invoice) → Shipment** | Could pre-fill container/CBM/weight/ports and tick `tradeDocs[]` (v2.9.86). | Wrong DG or port is a customs problem. `SHIP-GAP-002` (session-scoped DG-source distinction) is still open; the earlier `SH-GAP-002`/`003` sync bugs are fixed (v2.9.82). |
| 4 | **Buyer enquiry screenshot → Order Request line** | Same pain on the demand side. | Buyer PII in screenshots; belongs inside the `triage.html` 10-minute-screen discipline, not around it. |
| 5 | **Payment proof (bank slip / WeChat Pay screenshot) → supplier payment ledger** | Removes retyping. | **Highest risk.** Writes money records; a misread amount is a ledger error, not a draft. The duplicate-payment guard is only a confirm dialog. Do last, if ever. |
| — | AI chat assistant file attachments | Convenient. | Largest surface, weakest review gate (chat replies are not structured diffs). Not recommended. |

**Priority-drift note:** items 1–2 are the only ones worth a REQ in the near term, and only after RFQ import has been used on real quotes long enough to show extraction is trustworthy.
