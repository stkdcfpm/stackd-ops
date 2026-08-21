# REQ-DOC-001-v1: Version-controlled user guide

## Business Context

The repo has no operator-facing documentation today. Everything in `docs/` is engineering-facing: `REQ-*`/`SPEC-*` requirement/spec docs (this session's workflow), `known-gaps.md`, `version-history.md` (chronological, terse, written for a developer diffing releases), `data-model.md`/`workflow-bpmn.md`/`agent-architecture.md` (architecture), and ops runbooks (`dr-procedure.md`, `reporting-pipeline-runbook.md`). `README.md` is a single line. There is no single place answering "how do I do X in the app today" for an operator, a new hire being onboarded, or an AI session needing workflow context beyond what `AI_SYSTEM_PROMPT` (a browser-runtime prompt, not a docs artifact) already encodes.

The user wants a **living, current-state manual** — not a chronological changelog (that's what `docs/version-history.md` and the in-app Release Notes modal already are) — organized by feature/workflow area, updated in place every release so it always reflects what the app does *today*, not what changed in any one version. Intended uses: (1) day-to-day operator reference, (2) onboarding new staff, (3) a durable reference `CLAUDE.md` can point to for AI sessions needing workflow detail, the same way it already points to `STACKD_CONTEXT.md` for business context.

## FM-1 Assessment

No `K`/`DB`/`EI` change at all for the guide content itself (pure markdown, no app code). The one small piece of `index.html` UI (a quick-access link) adds no new entity, no new field, no new Sheets sync mapping — falls under FM-1 exception item 1 (`STACKD_CONTEXT.md:111`, UI feature with no new localStorage entity). No separate council decision required.

## Requirements

**REQ-DOC-001a (new file, current-state manual):** Create `docs/user-guide.md`, organized by feature/workflow area (not chronologically) — one section per major tab/entity: Dashboard, Contacts, Orders (Order Requests), Suppliers, Line Items, Buyers, Quotes, Purchase Orders, Invoices, Shipments, Import Data, Settings. Each section describes **current** behavior only — no "as of vX.X.X" framing inside the prose (that framing belongs in `version-history.md`/the in-app changelog, not here). Written for an operator, not a developer: no internal function names, `K`/`DB` schema references, or code line citations — plain description of what the feature does, how to use it, and what to expect (e.g. "Contacts can be uploaded via CSV: Import Data tab → Contacts step → Download Template, fill it in, Upload. Matched by email if present, else by name; existing contacts are updated, not duplicated.").

**REQ-DOC-001b (public-repo policy applies):** `docs/user-guide.md` is committed to a public GitHub Pages repo (per the existing `SEC-GAP-020`-driven policy already governing every file in this repo) — it must never contain live buyer/supplier PII, real financial figures, or any content that wouldn't be safe to publish. Any example data used for illustration must be clearly fictional (matching the existing convention already used in `TEMPLATES` example rows in `index.html`, e.g. `'Jinan Jinbao Equipment Co.'`, `'jane@example.com'`).

**REQ-DOC-001c (quick-access in-app link):** Add a small link/button in the app giving one-click access to the guide without leaving the browser tab — placed in the nav bar next to the existing version/changelog button (`index.html:216`, the `openChangelog()` button), opening `https://github.com/stkdcfpm/stackd-ops/blob/main/docs/user-guide.md` in a new tab (`target="_blank" rel="noopener"`). No new JS function needed beyond a plain anchor tag — this is a static link, not a modal or fetch.

**REQ-DOC-001d (AI-context pointer):** Add a one-line pointer in `CLAUDE.md` (near the existing "For full project context... read STACKD_CONTEXT.md" line at the top of the file) directing future Claude Code sessions to `docs/user-guide.md` for operator-facing workflow detail — same pattern already established for `STACKD_CONTEXT.md`.

**REQ-DOC-001e (mandatory release-checklist addition):** Add a new bullet to `CLAUDE.md`'s "On version delivery" checklist: **"`docs/user-guide.md` — update the relevant feature-area section if this release changed operator-visible behavior (new feature, changed workflow, changed field). Skip only if the change is purely internal (bug fix with no visible behavior change, test-only, refactor)."** This makes guide upkeep as mandatory as the already-required `AI_SYSTEM_PROMPT` update, but conditional (unlike `AI_SYSTEM_PROMPT`, which is unconditional per existing CLAUDE.md wording) — since not every release changes operator-visible behavior (e.g. a pure internal refactor or test-only change wouldn't need a guide update, whereas it would still need an `AI_SYSTEM_PROMPT` review to confirm no drift).

**REQ-DOC-001f (initial content scope — this REQ, not deferred):** The first version of `docs/user-guide.md` must cover the current, real feature set as of v2.9.51 (the latest merged version at time of writing) — not a stub/placeholder to be filled in later. This is a real, immediately-useful deliverable, not a scaffold.

## Acceptance Criteria

- AC-001: `docs/user-guide.md` exists with one section per tab/entity listed in REQ-DOC-001a, each describing current behavior in operator-facing language (no function names, no `K.x`/`DB.x` references, no `index.html:NNNN` citations).
- AC-002: No live/real PII, financial figures, or sensitive data appears anywhere in the file — only fictional example data consistent with existing `TEMPLATES` examples.
- AC-003: A new nav-bar link, placed adjacent to the existing changelog button, opens `docs/user-guide.md` on GitHub in a new tab; clicking it does not navigate away from or reload the running app (verified via `target="_blank"`).
- AC-004: `CLAUDE.md` contains a one-line pointer to `docs/user-guide.md` for workflow context, following the existing `STACKD_CONTEXT.md` pointer pattern.
- AC-005: `CLAUDE.md`'s "On version delivery" checklist includes the new conditional `docs/user-guide.md` update bullet, worded to make clear it's conditional (unlike the unconditional `AI_SYSTEM_PROMPT` bullet).
- AC-006: The guide's Contacts section accurately describes the CSV upload feature shipped in v2.9.51 (PR #67) and the Orders section accurately describes the per-line gap check shipped in v2.9.50 (PR #66) and the invoice section describes the corrected COGS warning from v2.9.49 (PR #65) — confirming the guide reflects genuinely current behavior, not stale/pre-session-work behavior.

## Changelog

- v1: Initial requirements draft.
