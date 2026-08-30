# SPEC-SDLC-003 — PR preview environment

**Status:** v2 — supersedes v1. v1's spec-gate review found one blocking bug (§1): creating the preview repo with no initial commit means `actions/checkout@v4` fails on every run, forever — checkout happens *before* any push, so there's no bootstrapping path that ever gets past it. Fixed by creating the repo with an initial commit (`autoInit: true`). Everything else from v1 (§2-§6) passed spec-gate unchanged, with one non-blocking advisory (§2's comment-lookup pagination, noted in place, not fixed — see the note there).
**Build baseline:** `main` @ current HEAD, 620/620 tests passing.

---

## 1. New repository: `stkdcfpm/stackd-ops-preview`

Created via `create_repository` with **`autoInit: true`** (public) — this is the fix for v1's blocking bug: a repo created with no commits has no default-branch ref for `actions/checkout@v4` to fetch, so every `preview-deploy.yml`/`preview-cleanup.yml` run would fail at the "Checkout preview repo" step before ever reaching the push step that was supposed to create that first commit. With `autoInit: true`, the repo has a real initial commit (a generated README) and an established default branch (`main`, matching the source repo's convention) before any workflow ever runs against it. GitHub Pages enabled on it is a manual step (REQ §3) — the workflows below degrade gracefully (fail their push/deploy step, no effect elsewhere) until that's done.

---

## 2. New workflow: `.github/workflows/preview-deploy.yml`

```yaml
name: PR Preview Deploy

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]

permissions:
  contents: read
  pull-requests: write

jobs:
  deploy-preview:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout PR head
        uses: actions/checkout@v4

      - name: Checkout preview repo
        uses: actions/checkout@v4
        with:
          repository: stkdcfpm/stackd-ops-preview
          token: ${{ secrets.PREVIEW_DEPLOY_TOKEN }}
          path: preview-repo
          fetch-depth: 0

      - name: Copy index.html into PR-<number>/
        run: |
          mkdir -p "preview-repo/PR-${{ github.event.pull_request.number }}"
          cp index.html "preview-repo/PR-${{ github.event.pull_request.number }}/index.html"

      - name: Commit and push preview
        working-directory: preview-repo
        run: |
          git config user.name "stackd-ops-preview-bot"
          git config user.email "actions@users.noreply.github.com"
          git add "PR-${{ github.event.pull_request.number }}/index.html"
          if git diff --cached --quiet; then
            echo "No changes to preview — skipping commit"
          else
            git commit -m "Preview for PR #${{ github.event.pull_request.number }}"
            git push
          fi

      - name: Comment on PR with preview link
        uses: actions/github-script@v7
        with:
          script: |
            const marker = '<!-- stackd-ops-preview-comment -->';
            const prNumber = context.payload.pull_request.number;
            const previewUrl = `https://stkdcfpm.github.io/stackd-ops-preview/PR-${prNumber}/`;
            const body = [
              marker,
              '### Preview deployed',
              '',
              previewUrl,
              '',
              '**Before testing:** open Settings -> Load Demo Data. This preview shares storage with every other open preview and with no production data at all -- do not assume it is empty or matches production.'
            ].join('\n');

            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              per_page: 100,
            });
            const existing = comments.find(c => c.body && c.body.includes(marker));

            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existing.id,
                body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: prNumber,
                body,
              });
            }
```

**Advisory from requirements-gate, addressed here:** the sticky-comment lookup identifies its own prior comment via the hidden `<!-- stackd-ops-preview-comment -->` marker string embedded in the comment body (`comments.find(c => c.body && c.body.includes(marker))`) — not by author-type filtering (a `c.user.type === 'Bot'` check was considered but dropped: comments posted via `actions/github-script`'s default `GITHUB_TOKEN` are authored as `github-actions[bot]`, so an author check would work too, but the marker string alone is sufficient and doesn't depend on assuming which bot identity posted it, which could change if the workflow's authentication method ever changes). This cannot match a human's comment, since no human would coincidentally include that exact HTML comment string in a PR comment.

**Trigger safety (confirmed at requirements-gate):** `pull_request` (not `pull_request_target`) is used deliberately. For a PR from a fork, GitHub Actions does not expose repository secrets to `pull_request`-triggered runs and grants only a read-only default token — a malicious fork PR modifying this workflow file cannot exfiltrate `PREVIEW_DEPLOY_TOKEN`. This also means preview deploys silently don't run for fork PRs (the checkout-preview-repo step would fail without the secret) — acceptable, since this repository's contribution model to date has been branches within the same repo, not external forks (confirmed by the branch listing used throughout this session — every `claude/...` branch lives in `stkdcfpm/stackd-ops` itself).

---

## 3. New workflow: `.github/workflows/preview-cleanup.yml`

```yaml
name: PR Preview Cleanup

on:
  pull_request:
    types: [closed]
    branches: [main]

permissions:
  contents: read

jobs:
  cleanup-preview:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout preview repo
        uses: actions/checkout@v4
        with:
          repository: stkdcfpm/stackd-ops-preview
          token: ${{ secrets.PREVIEW_DEPLOY_TOKEN }}
          path: preview-repo
          fetch-depth: 0

      - name: Remove PR-<number>/ if present
        working-directory: preview-repo
        run: |
          DIR="PR-${{ github.event.pull_request.number }}"
          if [ -d "$DIR" ]; then
            git config user.name "stackd-ops-preview-bot"
            git config user.email "actions@users.noreply.github.com"
            git rm -r "$DIR"
            git commit -m "Remove preview for closed PR #${{ github.event.pull_request.number }}"
            git push
          else
            echo "No preview directory for PR #${{ github.event.pull_request.number }} — nothing to remove"
          fi
```

`types: [closed]` fires on both a merged PR and one closed without merging — `github.event.pull_request.merged` is not checked, since cleanup should happen either way.

---

## 4. `qa.yml` — unchanged

No modification. It continues to run on push/PR to `main`, independent of both new workflows — a failure in either preview workflow cannot affect `qa.yml`'s own run or its required-check status on the PR.

---

## 5. Manual steps (unchanged from REQ §3, restated for the build)

1. Create a fine-grained PAT scoped to `stkdcfpm/stackd-ops-preview` only, Contents: Read and write.
2. Add it as a `stkdcfpm/stackd-ops` repository secret named `PREVIEW_DEPLOY_TOKEN`.
3. Enable GitHub Pages on `stkdcfpm/stackd-ops-preview` (Settings -> Pages -> Deploy from a branch -> default branch -> `/ (root)`).

Until all three are done, `preview-deploy.yml`'s "Checkout preview repo" step fails (no valid token to authenticate the cross-repo checkout) and the workflow run shows red on the PR's checks list — this does not block merging (it isn't a required check, unlike `qa.yml`) and has no effect on `main`, `qa.yml`, or the production site.

---

## 6. `docs/known-gaps.md` update (on completion)

`SDLC-GAP-003` marked Fixed, with the corrected origin-isolation finding from REQ §1.2 recorded so the flawed same-repository design in the original 2026-06-06 council recommendation isn't re-proposed by a future reader who only skims the "recommendation" line.
