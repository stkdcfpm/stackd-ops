# SPEC-AI-GAP-002-v2: AI-Assisted Invoice/Line Item/Credit Note Creation + Supplier/Buyer Read Tools

**Implements:** REQ-AI-GAP-002-v2 (requirements-gate CONDITIONAL PASS on v1, resolved in v2).

**Supersedes:** SPEC-AI-GAP-002-v1 (independent spec-gate PASS — no blocking defects; every citation and GDPR-critical claim independently re-verified correct. One advisory-only finding: §4's placement instruction for the new tool-use-guidance paragraph cited `index.html:7357`-area as the "per-line gap-check precedent paragraph" — the real location is `index.html:7456`. Fixed below, no functional change.)

All line citations re-verified against live `index.html` on `main` at v2 drafting time (line numbers drift release-to-release; the REQ's own citations were consulted but not assumed current).

## 0. Design decisions this spec has to make that the REQ left open

1. **Name→ID resolution mechanism.** The REQ requires `create_invoice`/`create_line_item` to resolve `buyId`/`supId` "via a `get_buyers`/`get_suppliers`-style lookup." **Decision: the resolution happens entirely at the AI/tool-use layer, not in `handleAIAction()`.** The model calls `get_buyers`/`get_suppliers` (this spec's new read tools) to turn a name into an `id`, then embeds the already-resolved `id` directly in the action payload — exactly the existing `create_po` contract (`p.supId`, `index.html:7797`, a raw ID read with no fuzzy-matching code anywhere). `handleAIAction()` needs zero new matching logic for either action; it reads `p.buyId`/`p.supId` the same way `create_po` already reads `p.supId`. This is "the same resolution mechanism," per REQ-AI-GAP-002's own phrasing — not a second implementation.
2. **Credit Note buyer field needs no resolution at all.** `saveCN()`'s `buyer` field (`index.html:` — see §3) is a free-text string (`buyer: G('cnf-b').value.trim()`), never a `buyerId` foreign key — confirmed by reading the live Credit Note save path in full. `create_credit_note`'s payload therefore takes a plain `buyer` name string, not a `buyId`; no `get_buyers` call is needed for this action, unlike `create_invoice`.
3. **Invoice line-item field shape differs from PO/Quote lines — must not be copy-pasted.** `cIL` (the live invoice line-item array) uses `{ rid, lid, desc, uom, qty, up, unitCost, lineType }` (confirmed via `quickAddLine()`/`addILI()`, `index.html:4678,4707`) — **not** `{desc, sku, uom, qty, cost}` like `cPL`/`cQL`. `up` is unit *sell* price, `unitCost` is unit *cost*. The action payload contract (§3) uses the same friendly field names (`desc`, `qty`, `cost`, `uom`, `price`) as every other creation action for consistency, and `handleAIAction()` maps `cost→unitCost`, `price→up` explicitly when constructing `cIL` entries — this mapping is the one place an implementer copying the `create_po`/`create_quote` pattern verbatim would silently produce lines `calcInv()` can't read (defaulting every quick-added line's cost/price to zero). `lineType` is fixed to `'product'` for AI-created lines (the `'pass-through'` distinction is an existing operator-only refinement, out of scope here).

## 1. `get_suppliers` / `get_buyers` — new `AI_TOOLS` entries

Added to the `AI_TOOLS` array (`index.html:7869-7913`), immediately after the existing `get_pos` entry (closing `}` before the array's final `];`):

```js
{
  name: 'get_suppliers',
  description: 'Look up suppliers by name to resolve a supId for other actions (e.g. create_po, create_line_item). Filter by name (partial, case-insensitive). Returns id, reference number, name, country, and currency — does not return contact/email/phone.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Supplier name — partial match, case-insensitive' }
    }
  }
},
{
  name: 'get_buyers',
  description: 'Look up buyers by name to resolve a buyId for other actions (e.g. create_invoice). Filter by name (partial, case-insensitive). Returns id, reference number, name, and currency — does not return contact name/email/phone/credit limit.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Buyer name — partial match, case-insensitive' }
    }
  }
}
```

New `_aiExecTool()` (`index.html:7915-7995`) branches, added immediately before the existing `get_pos` branch (mirroring its exact filter/map structure):

```js
if (name === 'get_suppliers') {
  var sups = DB.sup.filter(function(s) {
    if (inp.name && (s.name||'').toLowerCase().indexOf(inp.name.toLowerCase()) === -1) return false;
    return true;
  });
  return JSON.stringify(sups.map(function(s) {
    return { id: s.id, num: s.num||'', name: s.name, country: s.country||'', currency: s.cur||'' };
  }));
}
if (name === 'get_buyers') {
  var buys = DB.buy.filter(function(b) {
    if (inp.name && (b.name||'').toLowerCase().indexOf(inp.name.toLowerCase()) === -1) return false;
    return true;
  });
  return JSON.stringify(buys.map(function(b) {
    return { id: b.id, num: b.num||'', name: b.name, currency: b.currency||'' };
  }));
}
```

Directly implements REQ-AI-GAP-002a/b and AC-001/AC-002: only `id`/`num`/`name`/`country`-or-`currency` are ever serialized — `email`, `phone`, `ct`/`contactName` are never read into the returned object at all (not merely omitted by convention — the object literal above has no path to include them).

## 2. `get_pos` vocabulary fix (REQ-AI-GAP-002f)

Two locations, both confirmed live and unchanged since the REQ was drafted:

- `AI_TOOLS`'s `get_pos` entry, `status` property description (`index.html:7909`): `'PO status: Draft, Sent, Confirmed, In Production, Shipped, Completed'` → `'PO status: Draft, Sent, Deposit Paid, Settled, Cancelled'`.
- `AI_SYSTEM_PROMPT` (`index.html:7478`): `'PO status: Draft → Sent → Confirmed → In Production → Shipped → Completed.'` → `'PO status: Draft → Sent → Deposit Paid → Settled → Cancelled.'`

Both confirmed to not match the live `#po-sm` dropdown (`Draft, Sent, Deposit Paid, Settled, Cancelled`, read directly from its `<option>` list) — fixing both closes the live, previously-logged `AI-GAP-009` in the exact two places it exists.

## 3. `handleAIAction()` — three new branches (`index.html:7793-7863`)

**`create_invoice`** — added as a new `else if` branch, positioned anywhere among the existing branches (order is irrelevant, they're mutually exclusive `action.action` string checks):

```js
} else if (action.action === 'create_invoice') {
  if (!Array.isArray(p.lineItems) || !p.lineItems.length) {
    toast('At least one line item is required to create an invoice — ask for product/quantity/cost details first.');
    return;
  }
  openInv();
  if (p.buyId) G('if-b').value   = p.buyId;
  if (p.cur)   G('if-cur').value = p.cur;
  if (p.inco)  G('if-inco').value = p.inco;
  if (p.pt)    G('if-pt').value  = p.pt;
  cIL = p.lineItems.map(function(li){
    return { rid: uid(), lid: '', desc: li.desc||'', uom: li.uom||'', qty: +li.qty||1, up: +li.price||0, unitCost: +li.cost||0, lineType: 'product' };
  });
  rILT(); calcInv(); _updQaWarn();
}
```

Directly implements REQ-AI-GAP-002c and AC-003/AC-004/AC-005:
- **AC-005 (never write `#if-n`):** the handler never reads `p.num`/`p.n` at all — `openInv()`'s own `G('if-n').value = nextInvNum()` (`index.html:4549`) is the only thing that ever touches that field, exactly as today. There is no line to remove or guard — the payload contract (§ACTION BLOCKS below) simply never includes an invoice-number field, and even a malformed/adversarial payload containing one is inert since nothing in this branch reads it.
- **AC-004 (reject empty/missing lineItems before opening the modal):** the guard clause returns before `openInv()` is ever called — no modal opens, no state changes, matching "not silently pre-filled empty."
- **AC-003 (buyer resolved via `get_buyers` in-conversation):** `p.buyId` is read directly, per §0 decision 1 — the AI is instructed (§4) to call `get_buyers` first when a buyer name is mentioned without an already-known id.
- Incoterm/Payment Terms are pre-filled if present in the payload but not defensively required by this handler — `vInv()` (`index.html:6467-6470`) already hard-blocks Save without them, exactly as it does for a human-entered invoice today; REQ-AI-GAP-002c's "AI must ask, not guess" when they're missing is a system-prompt behavior (§4), not new validation code, matching every other existing branch's precedent (e.g. `create_po` never defensively requires `cur`/`notes`).

**`create_line_item`** — new branch, implementing REQ-AI-GAP-002d and AC-006:

```js
} else if (action.action === 'create_line_item') {
  if (!p.desc || !p.supId) {
    toast('Description and Supplier are required to create a line item.');
    return;
  }
  openLI();
  G('lf-d').value = p.desc;
  G('lf-sup').value = p.supId;
  if (p.sku)      G('lf-s').value  = p.sku;
  if (p.uom)      G('lf-u').value  = p.uom;
  if (p.cost != null)  G('lf-c').value = p.cost;
  if (p.price != null) G('lf-p').value = p.price;
  if (p.hsCode)   G('lf-hs').value = p.hsCode;
  if (p.notes)    G('lf-nt').value = p.notes;
  liMgn();
}
```

- The guard clause matches `vLI()`'s actual required-field set exactly (`index.html:6408,6410` — only `desc`/`sup` are hard-required), correcting v1's factual error rather than repeating it. A payload with Description+Supplier only (no Cost, no UOM) passes the guard and pre-fills correctly — satisfying AC-006's "accepted... not rejected" half; a payload missing either field is rejected before `openLI()` is called — satisfying the "clarifying question" half (the guard clause is the code-level backstop; the actual clarifying question is asked in the AI's own conversational turn per §4, matching `create_invoice`'s identical two-layer design).
- `supId` is read directly (§0 decision 1) — same mechanism as `create_invoice`'s `buyId`, per AC-006's "same resolution mechanism, not two different implementations."
- `liMgn()` (existing margin-preview function, called by `openLI()` itself at `index.html:4476`) is called again after setting cost/price so the pre-filled modal shows a correct margin preview immediately, matching what a human typing the same values would see.

**`create_credit_note`** — new branch, implementing REQ-AI-GAP-002e and AC-007:

```js
} else if (action.action === 'create_credit_note') {
  openNewCN();
  if (p.goodwill)        { G('cnf-type').value = 'goodwill_credit'; onCNTypeChg(); }
  else if (p.linkedInvNum) G('cnf-linked').value = p.linkedInvNum;
  if (p.amount != null)  G('cnf-amount').value = p.amount;
  if (p.reason)          G('cnf-reason').value = p.reason;
  if (p.buyer)           G('cnf-b').value = p.buyer;
  if (p.date)            G('cnf-dt').value = p.date;
  if (p.cur)             G('cnf-cur').value = p.cur;
  if (p.notes)           G('cnf-nt').value = p.notes;
}
```

This targets the live, primary Credit Note modal (`ov-cn`, `openNewCN()`/`vCN()`/`saveCN()`) — a structurally separate modal and validation path from `ov-inv`/`vInv()`, not the legacy `isCN(num)` branch inside the Invoice modal. This satisfies AC-007 ("cannot be routed through `create_invoice`'s validation path or vice versa") by construction: the two actions call different `open*()` functions targeting different DOM overlays entirely, so there is no shared code path to accidentally cross. `onCNTypeChg()` (`index.html:` — existing function toggling the linked-invoice field's visibility based on type) is called after setting `goodwill_credit` so the form's visible state matches what a human toggling the same dropdown would see. Per §0 decision 2, `p.buyer` is a plain name string, not an id.

## 4. `AI_SYSTEM_PROMPT` and ACTION BLOCKS updates (mandatory per `CLAUDE.md`'s "update on every version" rule)

**ACTION BLOCKS payload reference** (`index.html:7610`) — three new entries added to the existing list:

```
create_invoice → { buyId, cur, inco, pt, lineItems:[{desc,qty,cost,price,uom}] } — call get_buyers first if the buyer's id isn't already known from this conversation; if zero or multiple ambiguous matches, ask a clarifying question instead of guessing. Never include an invoice number — it is auto-assigned. Requires at least one line item; if none is known yet, ask rather than emitting an empty block. If Incoterm or Payment Terms aren't known, ask rather than guessing.
create_line_item → { desc, supId, sku, uom, cost, price, hsCode, notes } — call get_suppliers first if the supplier's id isn't already known. Only Description and Supplier are required; Cost, UOM, and HS code may be added later and should not block emitting the action.
create_credit_note → { linkedInvNum, goodwill, amount, reason, buyer, date, cur, notes } — a distinct action from create_invoice, not a variant of it. Either linkedInvNum (a standard credit note against an existing invoice) or goodwill:true (a goodwill credit, no linked invoice) must be specified, not both. buyer is a plain name, not an id.
```

**PO status vocabulary** — `index.html:7478`, fixed per §2.

**New tool-use guidance**, added near the existing per-line gap-check precedent paragraph (`index.html:7456`, exact placement a minor build-time choice): a short paragraph stating `get_suppliers`/`get_buyers` exist to resolve a name to an id before emitting `create_invoice`/`create_line_item`/`create_po` action blocks, and that these tools deliberately don't return contact/email/phone — if the user asks for a supplier's or buyer's contact details, the AI should say that information isn't available through these tools and point to the Suppliers/Buyers tab instead (directly reflecting the REQ's GDPR Assessment capability-boundary note, so the AI doesn't confidently invent an answer it has no data for).

## GDPR Data Flow

Unchanged from REQ-AI-GAP-002-v2's own assessment — no new field, no new persistence, no new external data flow beyond the same Anthropic API call pattern this app already makes (`sendAIMsg()`). The one thing this spec's code enforces beyond prose: `get_suppliers`/`get_buyers`'s return-object literals (§1) have no code path capable of including `email`/`phone`/`ct`/`contactName` — the minimization is structural, not merely a documented intention.

## Test Plan (`tests/run.js`)

New suite `AI Assistant — Invoice/Line Item/Credit Note actions + Supplier/Buyer read tools (SPEC-AI-GAP-002)`:

- `_aiExecTool('get_suppliers', {name:'Jinbao'})` against a fixture containing a matching supplier (with `email`/`phone`/`ct` populated) returns exactly `id`/`num`/`name`/`country`/`currency` — parse the JSON result and assert `email`/`phone`/`ct`/`contactName` keys are absent, not just falsy.
- `_aiExecTool('get_buyers', {name:'Apex'})` — same shape assertion for `id`/`num`/`name`/`currency`, asserting `contactName`/`email`/`phone`/`creditLimit` are absent.
- `_aiExecTool('get_pos', {})` on a fixture PO with `status:'Deposit Paid'` — confirm the tool's own description string (read directly off `AI_TOOLS`) contains `Deposit Paid`/`Settled` and not `Confirmed`/`In Production`/`Shipped` (direct string assertion, not `AI_SYSTEM_PROMPT` prose).
- `handleAIAction({action:'create_invoice', payload:{lineItems:[]}})` — `cIL` remains empty, `ov-inv` is never shown (assert `G('ov-inv').classList` unaffected / `openInv` not entered — via a spy or by asserting `if-n` was never set to a fresh `nextInvNum()` value), a toast fires.
- `handleAIAction({action:'create_invoice', payload:{buyId:'B1', lineItems:[{desc:'Widget',qty:2,cost:5,price:8,uom:'pcs'}]}})` — `cIL[0]` has `unitCost:5`, `up:8` (not `cost`/`price` keys), `G('if-b').value === 'B1'`, `G('if-n').value` is whatever `nextInvNum()` produced (never overwritten by a payload value, confirmed by additionally passing a malformed `payload.num` and asserting it's ignored).
- `handleAIAction({action:'create_line_item', payload:{desc:'Widget', supId:'S1'}})` — no Cost/UOM in payload — `G('lf-d').value==='Widget'`, `G('lf-sup').value==='S1'`, modal opened (not rejected).
- `handleAIAction({action:'create_line_item', payload:{supId:'S1'}})` — missing `desc` — rejected, `openLI` never called (assert via `G('lf-d').value` staying whatever it was before the call, i.e. not reset by `openLI()`'s own clearing logic).
- `handleAIAction({action:'create_credit_note', payload:{linkedInvNum:'INV10032', amount:50, reason:'Damaged goods', buyer:'Acme Ltd'}})` — opens `ov-cn` (not `ov-inv`), `G('cnf-linked').value==='INV10032'`, `G('cnf-type').value==='credit_note'` (not switched to goodwill).
- `handleAIAction({action:'create_credit_note', payload:{goodwill:true, amount:20, reason:'Goodwill gesture'}})` — `G('cnf-type').value==='goodwill_credit'`, linked-invoice field hidden (regression-checks `onCNTypeChg()`'s existing display-toggle still fires).
- Regression: `handleAIAction({action:'create_po', payload:{supId:'S1', lineItems:[...]}})` still behaves identically to pre-change behavior (existing branch untouched by this spec, confirmed via a snapshot-style test predating this change if one exists, or a fresh equivalent one).

## Changelog

- v1: Initial spec implementing REQ-AI-GAP-002-v2.
- v2: Independent spec-gate PASS on v1 — fixed one advisory citation error (per-line gap-check precedent paragraph is at `index.html:7456`, not `7357`). No functional/GDPR logic changed from v1.
