# REQ-AI-GAP-001 v1 — AI Order Flow Actions

**Status:** Gate PASS (2026-06-21)  
**FM-1:** Approved — UI/AI layer feature, no new localStorage entities. See STACKD_CONTEXT.md FM-1 exception item 1.  
**Version target:** v2.9.30

---

## Business need

The AI assistant is a Q&A tool only. Operators must manually navigate to forms and re-enter data that the AI already understands from context (e.g. "Create a PO for 500 units of Product X from Supplier Y at $12 each"). Eliminating this friction reduces operator effort and errors on high-frequency order-flow tasks.

---

## Behaviour

1. **Action response type:** `sendAIMsg()` parses the completed AI response for an optional JSON action block embedded in the text. The block format is:

   ```
   @@ACTION
   {"action":"create_po","payload":{...}}
   @@END
   ```

   If detected, the block is stripped from the displayed reply text (not shown to the operator as raw JSON). The parsed action is surfaced via a pre-fill button rendered in the AI chat pane below the reply.

2. **Supported actions (v1 scope):**

   | Action key | Opens | Pre-fills |
   |---|---|---|
   | `create_po` | PO modal (`openPO()`) | `supId`, `cur`, `notes`, `lineItems[]` (desc, qty, cost, uom) |
   | `create_quote` | Quote modal (`openQte()`) | `client`, `freightMode`, `currency`, `notes`, `lineItems[]` (desc, qty, cost, uom, hsCode) |
   | `create_shipment` | Shipment modal (`openShp()`) | `ref`, `originPort`, `destPort`, `etd`, `eta`, `notes` |
   | `create_contact` | Contact modal (`openCon()`) | `name`, `email`, `phone`, `company`, `status`, `source` |

3. **Pre-fill button:** A "▶ Review in [modal name]" button appears below the AI reply. Clicking it calls a `handleAIAction(action)` function which opens the target modal with fields pre-populated. **No record is created without the operator explicitly clicking Save.** The button is only present when the AI returned an action block.

4. **System prompt update:** `AI_SYSTEM_PROMPT` gains a section explaining the action block format and when to use it. The AI should emit an action block when the operator's message clearly requests creation of one of the four supported entity types and sufficient detail is present. If insufficient detail exists, the AI asks clarifying questions without emitting a block.

5. **Versioning guard (quote only):** Pre-filling the quote modal uses `openQte()` then sets field values. This is identical to the existing operator flow — quote versioning only triggers on `saveQte()`, so pre-fill cannot accidentally create a version. No guard needed.

6. **No new localStorage key or DB entity.** No Sheets sync change. Action parsing is UI-only, stateless.

7. **GDPR:** The action payload contains only operational data (product descriptions, quantities, costs, ports) — no personal data except contact name/email when `create_contact` is used. This is identical to what the operator would type manually. No new GDPR basis required. Processing covered by Art.6(1)(f) legitimate interests.

---

## Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | AI response contains a valid `@@ACTION...@@END` block | Response fully streamed | Block stripped from displayed text; pre-fill button rendered below reply |
| AC-2 | AI response contains no action block | Response fully streamed | No pre-fill button shown; text displayed as-is |
| AC-3 | Pre-fill button clicked for `create_po` | — | PO modal opens with supId, cur, notes, and line items pre-filled |
| AC-4 | Pre-fill button clicked for `create_quote` | — | Quote modal opens with client, freightMode, currency, notes, and line items pre-filled |
| AC-5 | Pre-fill button clicked for `create_shipment` | — | Shipment modal opens with ref, originPort, destPort, etd, eta, notes pre-filled |
| AC-6 | Pre-fill button clicked for `create_contact` | — | Contact modal opens with name, email, phone, company, status, source pre-filled |
| AC-7 | Pre-fill button clicked | Operator clicks Cancel in modal | No record created; DB unchanged |
| AC-8 | Malformed or unparseable JSON in `@@ACTION` block | Response processed | Block stripped; pre-fill button not rendered; no error thrown; text shown without action block content |
| AC-9 | Unknown `action` key in block | Pre-fill button clicked | Toast shown: "Unsupported action type"; no modal opened |
