# Agent Architecture & Delivery Framework

## Overview

This project uses a Claude Code subagent system to enforce quality gates across the delivery pipeline. Agents are independent reviewers — they do not write code or make decisions. They verify exit criteria and log evidence.

**Agent files live in:** `.claude/agents/`  
**Scope:** Project-level (scoped to stackd-ops only)  
**Audit trail:** Notion (via MCP when connected)

---

## Delivery pipeline

Every feature or change must pass through these stages in order:

```
Requirement → Spec → Build → Security → QA → Release
```

No stage is skipped. No gate is bypassed. A CRITICAL issue from any gate is a hard block.

---

## Active agents (Phase 1)

| Agent | Role | Tools |
|---|---|---|
| `requirements-gate` | Verifies requirements are complete, unambiguous, testable. Flags GDPR implications. | Read only |
| `spec-gate` | Reviews technical spec against requirement. Checks data model, API contracts, GDPR data flows. | Read only |
| `build-gate` | Code review against spec. Flags deviations as defects. Severity: CRITICAL / MAJOR / MINOR. | Read, Grep |
| `security-gate` | GDPR PII handling, OWASP, auth, secrets, CVEs. Hard block on release if critical issues found. | Read, Grep |
| `schema-migration-reviewer` | Reviews any `localStorage` schema change. Flags destructive ops and missing rollbacks. | Read only |

---

## Planned agents (Phase 2)

| Agent | Role |
|---|---|
| `requirements-analyst` | Breaks feature requests into functional + non-functional requirements |
| `data-modeller` | Conceptual → logical → physical data modelling, ERDs |
| `spec-writer` | Turns rough feature ideas into full technical specs |
| `qa-gate` | Verifies tests exist and pass for every acceptance criterion |
| `release-planner` | Reads commits since last tag, produces structured release notes |
| `release-gate` | Final independent check before any release. Produces release evidence document. |

---

## Gate exit criteria

| Stage | Gate agent | Exit criteria | Evidence output |
|---|---|---|---|
| Requirement | `requirements-gate` | Complete, unambiguous, testable. GDPR implications flagged. | Signed-off requirement → Notion |
| Specification | `spec-gate` | Data model, API contracts, edge cases, GDPR data flows defined. | Spec approval / gaps listed → Notion |
| Build | `build-gate` | Code matches spec. No unresolved CRITICALs. | Code review report → Git PR |
| Security | `security-gate` | GDPR PII verified. OWASP passed. No critical CVEs. | Security clearance report → Notion |
| QA | `qa-gate` | All acceptance criteria tested and passing. Coverage threshold met. | Test evidence report → Notion |
| Release | `release-gate` | All prior gates passed and logged. Release evidence document produced. | Release artefact → Notion + Git tag |

---

## Stackd-ops specific agent behaviour

- **`build-gate`** must reference `index.html` as the single source file. Flag any suggestion to split into multiple files as out of scope unless a sprint item explicitly covers architecture change.
- **`security-gate`** must check: `san()` usage on all user-supplied strings in `innerHTML`, no PII written to `localStorage` beyond operational necessity, no secrets or API keys in source.
- **`schema-migration-reviewer`** applies to `localStorage` key changes — treat any rename, removal, or restructure of `K` keys as a migration requiring backward-compatibility check and `ldArr` safety verification.
- **`requirements-gate`** — for FPM domain: flag any requirement that touches freight rate calculation, duty, or quote versioning for extra scrutiny. These are high-risk calculation chains.

---

## Agent operating rules

1. **Agents are read-only by default.** Only grant Write or Bash access where explicitly justified.
2. **Every gate produces a logged evidence record.** An outcome in chat only is not an audit trail.
3. **CRITICAL = hard block.** Nothing proceeds until resolved and gate re-run.
4. **Agents do not write code.** If an agent starts writing implementation, the system prompt is wrong.
5. **Do not build Phase 2 agents speculatively.** Build when a specific recurring pain justifies it.

---

## Git convention

Use conventional commits tied to requirement IDs:

```
feat(REQ-042): implement consent capture flow
fix(REQ-037): correct duty calculation for DG freight
test(REQ-042): add acceptance tests for consent flow
```

---

## GDPR surface (stackd-ops specific)

- Supplier contact data stored in `localStorage` — minimise fields, no sensitive categories
- Quote and invoice data may contain commercially sensitive pricing — treat as confidential
- No user authentication currently — access control is environmental (GitHub Pages, private repo)
- Any future feature touching PII must be flagged at `requirements-gate` before spec work begins
