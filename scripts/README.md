# Release verifier

## Branch publisher

Run `python3 scripts/publish_branch.py` from a clean feature branch to perform its first publish. It rejects protected branches, detached HEAD, uncommitted changes, a mismatched upstream, an existing remote branch, and a branch that does not contain the latest fetched `origin/main`. It rebases onto `origin/main` before its single explicit non-force push; a rebase failure is aborted and nothing is published. Create the pull request and merge it only through the approved repository workflow.

## Release verifier

Run `node scripts/verify-release.mjs` from the repository root immediately before a manual release check.

It succeeds only when the worktree is clean, the checked-out branch is `main` tracking `origin/main`, and local `HEAD`, locally cached `origin/main`, and the live GitHub ref (`GET /repos/{owner}/{repo}/git/ref/heads/main`) all agree. It then checks the Pages Actions deployment for that exact commit (`GET /repos/{owner}/{repo}/pages/deployments/<HEAD>`) has status `succeed`. The direct project URL `https://yoonzzan.github.io/yoon-os-app/` must return HTTP 200 without following redirects.

The verifier is read-only: it uses `git --no-optional-locks status --porcelain` plus Git metadata reads, `gh api` GET, and a direct `curl` GET. It never fetches, pulls, merges, pushes, writes files, follows redirects, triggers workflows, or attempts recovery. After the URL check it re-reads both GitHub values and local worktree state; any changed observation fails verification. A stale `origin/main` is therefore reported as a mismatch; update it through the normal approved Git workflow before rerunning.

Run its isolated unit test with `node --test tests/release-verifier.test.mjs`.
