# REQ-SDLC-003 — Same-origin PR preview environment (closes SDLC-GAP-003)

**Status:** v1 — requirements-gate independent review: **PASS**. Both load-bearing claims in §1.2 (GitHub Pages' custom-domain redirect behavior; `localStorage`'s origin-only partitioning) were independently verified against GitHub's own documentation/community discussions and a direct code check (no service worker/iframe/sandboxing in `index.html` that could change the storage analysis), not merely asserted. The reviewer additionally confirmed no `stkdcfpm.github.io` user-level Pages site exists that could cascade a redirect down onto the new preview repo despite it having no `CNAME` of its own, and confirmed the REQ's `pull_request` (not `pull_request_target`) trigger choice is the fork-safe one — a malicious fork PR cannot exfiltrate `PREVIEW_DEPLOY_TOKEN`. One advisory (non-blocking): the sticky-PR-comment mechanism (REQ-SDLC-003b) should identify its own prior comment via a hidden marker plus bot-author check, not naive body-text matching, to avoid misfiring against a human's comment — folded into the SPEC.
**Type:** SDLC/infrastructure build, not an app feature — no financial data or business logic touched. Closes `SDLC-GAP-003` ("No staging/preview environment for PR review"), logged v2.9.24, revisited per its own 2026-08-25 trigger now that Payment Allocation is moving into sub-phase 2c.

---

## 1. Business context

### 1.1 The gap, as already logged

There is no way to see a PR branch running as a live app before merging it to `main`. GitHub Pages serves static files with the wrong MIME type for a branch that isn't the Pages source, so there's no quick way to "just open the branch." The existing mitigation — Demo Mode (`loadDemoData()`, shipped v2.9.31/expanded v2.9.61) plus a real but low-stakes order — works for mechanical testing but doesn't let anyone *see* a PR's UI running before merge. The 2026-08-25 revisit trigger flagged this as a growing risk given financial-automation phases (buyer approval, invoicing progression, and now the Payment Allocation build) keep shipping without ever being visually reviewed pre-merge.

### 1.2 Facts established during this REQ's check-first

- **`stkdcfpm/stackd-ops` is a public repository**, default branch `main`, with a single GitHub Actions workflow, `.github/workflows/qa.yml` (`node tests/run.js` on push/PR to `main`) — no deploy workflow exists at all. Confirmed via direct listing: `.github/workflows/` contains only `qa.yml`.
- **`CNAME` sits at the repo root** (`app.getstackdops.com`), with no `gh-pages` branch and no `.nojekyll` file present — consistent with GitHub Pages being configured (via repo Settings, not visible in the file tree) to serve `main`'s root directly. This matches `STACKD_CONTEXT.md`'s own description ("GitHub Pages, custom domain `app.getstackdops.com`... live, not pending").
- **The 2026-06-06 LLM Council recommendation is only half-correct.** It proposed a same-origin preview at `stkdcfpm.github.io/stackd-ops/preview/PR-N/` and claimed this "solves both MIME type and origin isolation in one move." The MIME-type half holds — a real HTML file served by GitHub Pages executes JS identically to production. **The origin-isolation half does not hold, and this REQ's check-first is the first place that's been verified rather than assumed:**
  1. GitHub Pages automatically redirects a repository's default `<user>.github.io/<repo>/...` URL to that repository's configured custom domain, once one is set (confirmed via GitHub's own community documentation/discussions, not merely inferred). Since `stackd-ops` already has `app.getstackdops.com` configured, any preview URL hosted *within this same repository* — on any branch, at any path — would still resolve through that redirect onto the production custom domain.
  2. `localStorage` is partitioned by origin (scheme + host + port) only, **never by path**. A preview living at `app.getstackdops.com/preview/PR-5/` would read and write the exact same `localStorage` bucket as the live production app at `app.getstackdops.com/`. A reviewer opening a PR preview would see real production data (buyer/supplier records, invoices, financials) and any save action inside the preview would mutate that same real data — the opposite of what a safe preview environment is for, and a materially worse outcome than today's "no preview at all."
- **Consequence:** a same-repository preview, in any form, cannot be made safe while `app.getstackdops.com` remains this repository's custom domain. Genuine origin isolation requires a GitHub Pages site GitHub does not redirect away from — i.e., a *different* repository, with no custom domain of its own, staying at its own default `<user>.github.io/<repo>/` address.
- **User-confirmed design direction (this session):** create a second, dedicated, public repository — `stkdcfpm/stackd-ops-preview` — with GitHub Pages enabled and no custom domain. Previews live at `stkdcfpm.github.io/stackd-ops-preview/PR-N/`, a genuinely separate origin from `app.getstackdops.com`. **Accepted, disclosed residual limitation:** all previews *within* that second repository still share one `localStorage` bucket with each other (no scheme exists for per-path storage isolation on any static host) — two PRs being reviewed at the same moment could see each other's test mutations. Mitigated, not eliminated, by defaulting every preview session to Demo Mode data rather than assuming a clean or production-matching state.

### 1.3 What this REQ does not attempt

- Does not give each PR its own isolated data store — not achievable without a genuinely separate origin per PR (a wildcard-subdomain + per-branch-TLS setup GitHub Pages custom domains don't support), which is explicitly out of scope for this pass.
- Does not modify `index.html`'s own runtime behavior (no "detect preview origin, auto-load demo data" logic) — that would be new application code touching `loadDemoData()`/`clearDemoData()`'s call graph, warranting its own REQ/SPEC/gate cycle if ever pursued. This REQ solves the infrastructure problem only; safe usage of the preview (loading Demo Mode data, not assuming a clean slate) is a documented operating instruction, not enforced in code.
- Does not touch the production deploy path in any way that could regress `app.getstackdops.com` — `main`'s existing GitHub Pages configuration (source: `main`/root, custom domain via `CNAME`) is left completely untouched. This REQ only adds new, additive GitHub Actions workflows to `stackd-ops` (triggered by `pull_request` events) and a brand-new, previously-nonexistent second repository.
- Does not implement `SDLC-GAP-002` (gate-evidence persistence) — unrelated gap, not touched.

---

## 2. Requirements

### REQ-SDLC-003a — New repository: `stkdcfpm/stackd-ops-preview`
Public (matching `stackd-ops`'s own visibility — GitHub Pages requires either a public repo or a paid plan for private-repo Pages, and there's no reason for this repo to hold anything sensitive: it contains only build output, never real data). Initialized with a commit (e.g. auto-init with a README) so it has a real default branch before any workflow ever runs against it — see SPEC §1's bootstrapping fix. GitHub Pages enabled, source: repository's default branch, root. No custom domain configured — this is the entire point; the default `stkdcfpm.github.io/stackd-ops-preview/` address is what provides origin isolation from `app.getstackdops.com`.

**Discovered during implementation, not anticipated at requirements-gate: Claude Code's GitHub integration for this session cannot create a new repository** — `create_repository` returned `403 Resource not accessible by integration`, confirming this session's GitHub App installation is scoped only to already-granted repositories (`stackd-ops`, `getstackdops`), not account-level repo creation. This moves REQ-SDLC-003a from "Claude Code creates it" to a fourth manual step (§3) — the user creates the repository (public, initialized with a README) and then grants this session access to it via `add_repo`/an installation update, after which Claude Code can push the initial content and everything else in this REQ that touches that repository.

### REQ-SDLC-003b — `preview-deploy.yml` (new workflow in `stackd-ops`)
Triggers on `pull_request` (`opened`, `synchronize`, `reopened`) targeting `main`. Steps:
1. Check out the PR's head commit.
2. Copy `index.html` (the entire application — no build step exists or is needed) to `PR-<number>/index.html` in the target repository.
3. Push that single file to `stkdcfpm/stackd-ops-preview`'s default branch, using a repository secret (`PREVIEW_DEPLOY_TOKEN`, see §4) for cross-repo write access — the workflow's own automatic `GITHUB_TOKEN` is scoped only to the repository it runs in and cannot write to a second repository.
4. Post or update a single, sticky PR comment (searched for and edited on repeat runs, not duplicated on every push) with the live preview link (`https://stkdcfpm.github.io/stackd-ops-preview/PR-<number>/`) and a short, explicit warning: *"Preview environment — click Settings → Load Demo Data before testing. Do not assume this matches production; it shares storage with every other open preview."*

### REQ-SDLC-003c — `preview-cleanup.yml` (new workflow in `stackd-ops`)
Triggers on `pull_request` (`closed` — covers both merged and closed-without-merging). Removes `PR-<number>/` from `stackd-ops-preview`'s default branch using the same `PREVIEW_DEPLOY_TOKEN`, so closed PRs don't accumulate stale previews indefinitely.

### REQ-SDLC-003d — `docs/known-gaps.md` update
`SDLC-GAP-003` marked Fixed once this ships, with the corrected origin-isolation finding (§1.2) recorded so a future reader doesn't re-propose the same flawed same-repository design the 2026-06-06 council recommendation carried.

---

## 3. Manual steps (cannot be performed by Claude Code — no credential/settings-management tool, and no repo-creation permission, available)

0. **Create the `stkdcfpm/stackd-ops-preview` repository** — public, initialized with a README (so it has a real default branch — see SPEC §1). Discovered during implementation: this session's GitHub App integration returned `403 Resource not accessible by integration` on `create_repository`, confirming it's scoped only to already-granted repositories, not account-level repo creation. Once created, grant this Claude Code session access to it (the same `add_repo` mechanism already used for `stackd-ops`/`getstackdops`) so the workflow files and any other repo content can be pushed.
1. **Create a fine-grained GitHub Personal Access Token** scoped to only the `stkdcfpm/stackd-ops-preview` repository, with **Contents: Read and write** permission (no broader scope needed — this token can only ever touch that one, non-sensitive repository).
2. **Add it as a repository secret** on `stkdcfpm/stackd-ops`, named `PREVIEW_DEPLOY_TOKEN` (Settings → Secrets and variables → Actions → New repository secret).
3. **Enable GitHub Pages** on the `stkdcfpm/stackd-ops-preview` repository (Settings → Pages → Source → Deploy from a branch → the repo's default branch → `/ (root)`).

None of these steps touch `stackd-ops`'s own Pages configuration or `app.getstackdops.com` — the production site is unaffected regardless of when (or whether) these four steps are completed. Until they are, the two new workflows will simply fail their checkout/push step harmlessly (no preview posted, no effect on `main`, `qa.yml`, or the live site) — this failure mode is itself covered by AC-4 below, and merging the workflow files ahead of these manual steps is a deliberate, safe sequencing choice, not something to wait on.

---

## 4. Acceptance criteria

| # | Given | When | Then |
|---|---|---|---|
| AC-1 | A new PR opened against `main` | `preview-deploy.yml` runs | `stkdcfpm/stackd-ops-preview`'s default branch gains `preview/PR-<N>/index.html` matching the PR head's `index.html` exactly |
| AC-2 | A PR previously previewed, then pushed again | `preview-deploy.yml` runs again | The existing PR comment is edited in place (same comment, updated link/timestamp) — not a second, duplicate comment |
| AC-3 | A PR closed (merged or not) that had a preview deployed | `preview-cleanup.yml` runs | `preview/PR-<N>/` is removed from `stackd-ops-preview` |
| AC-4 | `PREVIEW_DEPLOY_TOKEN` not yet configured (steps in §3 not yet done) | A PR is opened | `preview-deploy.yml`'s push step fails cleanly; `qa.yml` and the production Pages deployment are entirely unaffected |
| AC-5 | `stackd-ops`'s own `main`-branch Pages configuration | This REQ ships | Unchanged — no edit to `CNAME`, no new deploy workflow triggered by `push` to `main` for the production site itself |

---

## 5. Gate process

Single independent review round (not the multi-round financial-logic escalation pattern used for REQ-CUR-002/REQ-INTEG-002-2b) — this is infrastructure with no financial data or business-logic risk, but the review should verify the two claims this REQ's entire design rests on (the GitHub Pages redirect behavior, and `localStorage`'s origin-only partitioning) independently, not just trust this document's citations, since a wrong answer on either would mean building something that looks safe but isn't.

---

## 6. Tracker / known-gaps updates required on completion

- `docs/known-gaps.md`: `SDLC-GAP-003` marked Fixed, corrected origin-isolation finding recorded (§1.2).
- `docs/requirements-tracker.md`: new row (first SDLC-track REQ/SPEC pair in this tracker).
- `STACKD_CONTEXT.md`: version-ship housekeeping per the standing checklist, plus a one-line addition to the Architecture section noting the new `stkdcfpm/stackd-ops-preview` repository's existence and purpose.

---

## 7. Spec-gate note

`docs/SPEC-SDLC-003-v2.md` supersedes v1 after spec-gate review found one blocking bug: creating the preview repo with no initial commit leaves it with no default-branch ref, so `actions/checkout@v4` would fail on every workflow run, forever — checkout happens before the push step that was supposed to create that first commit, so the repo can never bootstrap itself. Fixed by creating the repository with an initial commit (`autoInit: true`) at creation time (REQ-SDLC-003a's own requirement text — "new repository," no init details specified — is unaffected; this is purely an implementation detail resolved in the SPEC). One non-blocking advisory (the sticky-comment lookup fetches only the first 100 PR comments, `octokit.paginate` not used) noted in the SPEC, not fixed — low risk in practice since the preview comment is created near the front of the list on the PR's `opened` event.
