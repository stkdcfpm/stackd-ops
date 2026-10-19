# Agent Architecture & Delivery Framework

**Status:** Rewritten 19 October 2026 to describe the process actually in use, after this doc went unmaintained for 77 versions (last touched at v2.9.14, per `git log -- docs/agent-architecture.md`) while the real process diverged from it. See "What changed in this rewrite" at the bottom for exactly what was wrong and how it was confirmed, rather than assumed.

For the live, authoritative process description, see **`CLAUDE.md`'s "REQ/SPEC gate process" section** — that file is kept current as part of every version delivery's own checklist; this document is architecture/history context around it, not a second copy to keep in sync by hand.

---

## What's actually in use today

Every feature of real size goes through:

```
REQ doc → requirements-gate review (repeat until clean PASS) →
SPEC doc → spec-gate review (repeat until clean PASS) →
implementation → test suite (node tests/run.js) →
build-gate review (repeat until clean PASS) →
docs/version bump → PR
```

Confirmed by the actual delivery record (`docs/version-history.md`, 90+ shipped versions): this 3-stage shape — not the 6-stage one originally drafted here — is what every real delivery has followed, including a `schema-migration-reviewer`-equivalent check whenever a `localStorage`/`K`/`DB` schema change is involved.

**The load-bearing practices that make this work, none of which the original version of this doc mentioned at all:**
- **Repeat until clean.** A FAIL or CONDITIONAL PASS is always followed by another confirmatory round on the same gate — never patched and waved through. REQ-WEBHOOK-001 took 6 requirements-gate rounds and 8 spec-gate rounds before a clean PASS; REQ-SHIP-002 took 5 requirements-gate rounds.
- **Personal re-verification, always.** Every reviewing agent's finding is independently re-checked against the live code before being accepted or fixed — never taken on the reviewing agent's word. This has caught real cases of a finding being wrong, imprecisely cited, or itself introducing a new inaccuracy while fixing the thing it found.
- **Mutation testing on safety-critical fixes.** Revert the fix in a scratch copy, confirm the exact predicted test fails, restore. Used throughout — e.g. REQ/SPEC-SHIP-001's trade-document checklist, REQ/SPEC-INV-002's cost-basis gate.
- **A mandatory scripted citation check** (`scripts/check-req-citations.js`) before every gate submission, added after REQ-WEBHOOK-001's first 6 requirements-gate rounds found nothing but mechanically-checkable wrong `index.html:NNN` citations — each one costing a full review round to surface by hand.

## How a gate review is actually performed

There is no invokable `requirements-gate`/`spec-gate`/`build-gate`/`security-gate` subagent type in this environment — see "The subagent-wiring finding" below. In practice, a gate round is a general-purpose agent (or, from a Claude Code session, the `Agent` tool with `subagent_type: "general-purpose"`) given a hand-written prompt that states the review's scope and checklist for that round.

**Token-efficiency recommendation, not yet standard practice:** `.claude/agents/requirements-gate.md`, `spec-gate.md`, `build-gate.md`, `schema-migration-reviewer.md`, and `security-gate.md` still exist on disk and still contain real, usable checklists (XSS/`san()` discipline, async-safety rules, the quote-engine calc chain, view-routing entries required for a new entity, GDPR/PII checks, etc.) written specifically for this codebase. **Paste the relevant file's body into the review prompt** instead of re-deriving the checklist from scratch each round — this is the single cheapest fix available today, requires no infrastructure change, and directly addresses the token cost of every gate round re-inventing its own instructions.

## The subagent-wiring finding

Directly tested (19 October 2026): attempting `Agent({ subagent_type: "spec-gate", ... })` in this session returns `Agent type 'spec-gate' not found. Available agents: claude, claude-code-guide, Explore, general-purpose, Plan, statusline-setup` — a fixed, environment-level list, not a project-specific one. The `.claude/agents/*.md` files are well-formed (correct `name`/`description` frontmatter), but this confirms they are not being loaded as invokable subagent types in this environment. Whether that differs in a local Claude Code CLI session (as opposed to this remote/cloud session) has not been tested — worth a one-off check next time this is run locally, since the original design assumed they would be invokable this way.

## Evidence trail — Git, not Notion

**Already self-disclosed, still true 77 versions later:** `docs/known-gaps.md`'s `SDLC-GAP-002` (logged v2.9.14, the same version this file was last touched before this rewrite) states the Notion audit-trail claim this document originally made was "aspirational — the Notion MCP integration is not yet wired." Confirmed again now: zero mentions of Notion anywhere in `docs/version-history.md`'s 90+ entries.

The real, durable evidence trail is **version-controlled Markdown + git history**: each REQ/SPEC document (`docs/REQ-<ID>-vN.md`/`docs/SPEC-<ID>-vN.md`) carries its own review history inline (a numbered "Independent review round N" log with verdicts and findings, never edited in place — each revision is a new file), `docs/known-gaps.md` logs every disclosed gap, `docs/version-history.md` logs every shipped version's full account, and git commits/PRs carry the final record. This has worked, is queryable by any future session without MCP access, and needs no new infrastructure — it just isn't what this document originally claimed was happening.

## Gates that were never built, and the honest status of each

- **`security-gate`** — listed as "Active, Phase 1" in the original version of this doc. Zero mentions in `docs/version-history.md` as a formal stage ever run. Security findings in practice surface inside REQ-gate/SPEC-gate rounds (which already check GDPR/PII per their own checklists) or as standalone proactive audits (e.g. the v2.9.84 stored-XSS fix, `SEC-GAP-021`) — never as a distinct named pipeline stage. The checklist in `security-gate.md` is still good content; reuse it as review-prompt material per the recommendation above rather than as a separate stage, unless a specific recurring gap justifies building that stage for real.
- **`qa-gate`** / **`release-gate`** — never built. No change from the original "Planned, Phase 2" status; still no specific recurring pain identified that would justify building them (per the operating rule below).

## Agent operating rules (unchanged, still sound)

1. Agents are read-only by default. Only grant Write/Bash where explicitly justified.
2. Every gate's findings must be personally re-verified against live code before being accepted — never taken on the reviewing agent's word alone.
3. A FAIL or CONDITIONAL PASS is always followed by one more confirmatory round on the same gate, repeated until clean.
4. Agents review; they do not write implementation code. If a review agent starts writing code, its prompt is wrong.
5. Do not build a new gate speculatively. Build one only when a specific, recurring pain justifies it — `qa-gate`/`release-gate` remain unbuilt for exactly this reason.

## Stackd-ops specific review focus (still accurate, carried over)

- **Spec compliance / code review** must reference `index.html` as the single source file. Any suggestion to split into multiple files is out of scope unless a sprint item explicitly covers an architecture change.
- Every review must check `san()` usage on all user-supplied strings reaching `innerHTML`, no PII written to `localStorage` beyond operational necessity, and no secrets/API keys in source.
- Any rename, removal, or restructure of `K`/`DB` keys is treated as a migration requiring a backward-compatibility check and `ldArr()` safety verification — this is the one check worth explicitly calling out as its own review pass even without a dedicated invokable agent, since `localStorage`-only persistence means a bad migration has no recovery path.
- Any requirement touching freight rate calculation, duty, or quote versioning gets extra scrutiny — these are the highest-risk calculation chains in the app.

## GDPR surface (stackd-ops specific, unchanged)

- Supplier contact data stored in `localStorage` — minimise fields, no sensitive categories.
- Quote and invoice data may contain commercially sensitive pricing — treat as confidential.
- No user authentication currently — access control is environmental (GitHub Pages, private repo; Supabase RLS once Cloud Data is configured — see `CLAUDE.md`'s Cloud Data section for the current, real state of that).
- Any future feature touching PII must be flagged during the requirements-gate round before spec work begins.

---

## What changed in this rewrite

Prompted by a direct question ("is `docs/agent-architecture.md` up to date?") ahead of raising a PR. Checked against evidence rather than assumed stale by age alone:

- Confirmed via `git log` this file was last substantively edited at v2.9.14 (commit `f5395d3`) and never touched again, including through the 77 versions shipped since.
- Confirmed via grep across `docs/version-history.md` (the actual delivery record) that `requirements-gate`/`spec-gate`/`build-gate` are real and heavily used (32/30/13 mentions respectively), `schema-migration-reviewer` is real (11 mentions across `version-history.md`/`known-gaps.md`), but `security-gate` has 0 mentions as a formal stage, and `qa-gate`/`release-gate`/`Notion` have 0 mentions anywhere.
- Confirmed via a direct `Agent` tool call with `subagent_type: "spec-gate"` that the named gate agents are not invokable in this environment — not assumed from their absence in a tool listing alone.
- Cross-checked the Notion finding against `docs/known-gaps.md`'s own `SDLC-GAP-002`, which had already disclosed this exact gap at v2.9.14 and was simply never revisited.
- Rewrote the pipeline description, evidence-trail section, and gate-status list to match what the above confirmed, added the practices (`repeat-until-clean`, personal re-verification, mutation testing, the citation-check script) that evolved in real use but were never documented here, and added a concrete token-efficiency recommendation (reuse the existing agent `.md` files' checklists as review-prompt bodies) rather than leaving the mismatch purely diagnosed with no next step.
