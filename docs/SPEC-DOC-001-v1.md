# SPEC-DOC-001-v1: Version-controlled user guide

**Implements:** REQ-DOC-001-v2 (requirements-gate PASS)

## 1. `docs/user-guide.md` — structure and per-section content requirements

New file, top-level structure:

```markdown
# Stackd Ops — User Guide

Living reference for how to use the app today. For what changed release-to-release, see `docs/version-history.md` or the in-app Release Notes (nav bar → version number).

## Dashboard
## Contacts
## Orders (Order Requests)
## Suppliers
## Line Items
## Buyers
## Quotes
## Purchase Orders
## Invoices
## Shipments
## Import Data
## Settings
```

Each section, at minimum, covers: what the tab is for, the core create/edit/view workflow, and any non-obvious behavior an operator would otherwise have to discover by trial and error (matching, validation rules, warnings, what triggers what). Per REQ-DOC-001a, no `index.html:N` citations, no `K.x`/`DB.x` schema references, no bare function-call syntax (`someFunction(`) anywhere in the prose.

Section-by-section required coverage (derived from the app's actual current behavior, verified against `index.html` and `docs/version-history.md`'s most recent entries at build time — not a fixed list of PRs):

- **Dashboard**: KPI tiles, the display-currency selector (GBP/USD/RMB/BBD) and what it does/doesn't convert, the FX-staleness warning banner.
- **Contacts**: the pipeline stages (lead/qualified/converted/closed), manual add vs. CSV upload (Import Data → Contacts step — matched by email if present else name, existing records updated not duplicated, blank columns on re-upload preserve prior values), the GDPR basis field's meaning in plain terms (why it's there, not the legal mechanics).
- **Orders (Order Requests)**: the stage flow (New → Qualifying → Quoted → Converting → Processing → Fulfilled, plus Declined/Lost), per-line fields (order volume vs. base UOM/qty, qty status), the per-line "Check gaps" button (what the structural check flags vs. the AI-assisted check, and that both are read-only/diagnostic — nothing is saved until the operator acts on it), Create Quote handoff, realised margin (shown once Fulfilled).
- **Suppliers**: manual add, CSV upload/template.
- **Line Items**: manual add, CSV upload/template, how cost/price feed Invoice COGS.
- **Buyers**: manual add, credit limit (display-only), Outstanding/statement basics.
- **Quotes**: line pricing → duty/freight/insurance landed cost, versioning on cost/duty/markup change, the Accepted-status approval fields (Approved By required, Approval Note optional), Convert to PO (one PO per distinct supplier).
- **Purchase Orders**: statuses, linking to an Invoice, deposit/balance tracking.
- **Invoices**: statuses including Pro-forma, quick-add vs. Import from Library for line items, and — plainly, not as a bug-history note — that a quick-added line needs a Unit Cost entered for profit figures to be accurate; the COGS warning only flags a line when it truly has neither a library link nor a cost entered.
- **Shipments**: what a shipment record tracks, freight mode, linking to invoices.
- **Import Data**: the six-step CSV upload flow (Suppliers → Line Items → Invoices → Purchase Orders → Order Requests → Contacts) and the Google Sheets pull as the alternate path, each step's dependency ordering (e.g. Suppliers before Line Items).
- **Settings**: AI Assistant key, Google Sheets sync connection, Rates & FX, Reference Data viewer.

## 2. Nav-bar quick-access link (`index.html:216`)

Placed immediately after the existing changelog button, before the tabs div, following the same inline-style convention as its neighbor:

```html
<button onclick="openChangelog()" style="font-family:'DM Mono',monospace;font-size:.42rem;color:#6A6060;border:1px solid #3A3537;background:transparent;padding:2px 7px;border-radius:2px;cursor:pointer;margin-right:12px;flex-shrink:0;letter-spacing:.06em;">v2.9.51</button><a href="https://github.com/stkdcfpm/stackd-ops/blob/main/docs/user-guide.md" target="_blank" rel="noopener" style="font-family:'DM Mono',monospace;font-size:.42rem;color:#6A6060;border:1px solid #3A3537;background:transparent;padding:2px 7px;border-radius:2px;cursor:pointer;margin-right:12px;flex-shrink:0;letter-spacing:.06em;text-decoration:none;display:inline-block;">User Guide</a><div class="tabs">
```

Plain anchor tag, no new JS function — satisfies REQ-DOC-001c exactly (a static link, not a modal/fetch). Label: "User Guide" (plain, matches the terse style of the adjacent version button).

## 3. `CLAUDE.md` — AI-context pointer

Added as a second pointer line at the top of the file, immediately after the existing `STACKD_CONTEXT.md` line:

```markdown
For full project context including business strategy, FPM data, and programme roadmap, read STACKD_CONTEXT.md in this repo root.

For operator-facing workflow detail (how to use each tab/feature today), read docs/user-guide.md.
```

## 4. `CLAUDE.md` — new conditional release-checklist bullet

Added to the existing "On version delivery" list (`CLAUDE.md:104-114`), positioned after the `AI_SYSTEM_PROMPT` bullet since both concern documentation-of-behavior consistency:

```markdown
- **`docs/user-guide.md`** — update the relevant feature-area section if this release changed operator-visible behavior (new feature, changed workflow, changed field). Skip only if the change is purely internal (bug fix with no visible behavior change, test-only, refactor).
```

## 5. Build-gate verification procedure for REQ-DOC-001b/AC-002 (PII/sensitive-data check)

Before the PR for this feature is raised, run a plain-text search of the new `docs/user-guide.md` for each of the following marker categories, and confirm zero matches outside the intentionally-fictional examples already used elsewhere in the app (`TEMPLATES` example rows, e.g. `Jinan Jinbao Equipment Co.`, `jane@example.com`):

1. Any email domain other than `example.com`/`example.org`/similar obvious placeholder domains.
2. Any phone number pattern (`\+?\d[\d\s\-]{7,}`) not immediately recognizable as the same placeholder style already used in `TEMPLATES` examples (e.g. `+1 246 555 0100`).
3. Any company name matching a real supplier/buyer name known from this repo's history (cross-reference `docs/known-gaps.md`'s `SEC-GAP-020` entry and `STACKD_CONTEXT.md` for names that were previously flagged as real and redacted).
4. Any populated invoice/PO/reference number that isn't obviously a template placeholder (e.g. `INV10029`-style numbers already used in existing `TEMPLATES.inv.example` are fine as illustrative reuse; a *new*, differently-formatted real-looking number would not be).

This check is a one-time manual step performed by whoever builds this feature, run once against the finished file before the PR is opened — not an automated test (no test-suite hook is added, since this is prose content review, not code behavior).

## 6. Test plan

This feature is markdown content + a static HTML link + two `CLAUDE.md` prose edits — no new JS logic, so no new entries in `tests/run.js`. Verification is manual, per §5 above, plus:

- Visual/structural check: `docs/user-guide.md` contains all 12 section headers listed in §1, in order.
- Pattern-search check (can be done via a one-off grep, not a persisted test): zero matches for `index\.html:\d+`, `\bK\.[a-z]+\b`, `\bDB\.[a-z]+\b` anywhere in `docs/user-guide.md` (satisfies AC-001's objective criteria).
- Manual click-test in a running instance: the new "User Guide" link opens the GitHub blob URL in a new tab without navigating the app away (satisfies AC-003) — noted here as a manual UI check since this repo has no browser-automation test harness for nav-bar links.

## Changelog

- v1: Initial spec implementing REQ-DOC-001-v2.
