# Release verifier

Run `node scripts/verify-release.mjs` from the repository root immediately before a manual release check.

It succeeds only when the worktree is clean, the checked-out branch is `main` tracking `origin/main`, and local `HEAD`, locally cached `origin/main`, the live GitHub ref (`GET /repos/{owner}/{repo}/git/ref/heads/main`), and the legacy Pages build (`GET /repos/{owner}/{repo}/pages/builds/latest`, `{ "commit": "<HEAD>", "status": "built" }`) all agree. The direct project URL `https://yoonzzan.github.io/yoon-os-app/` must return HTTP 200 without following redirects.

The verifier is read-only: it uses `git --no-optional-locks status --porcelain` plus Git metadata reads, `gh api` GET, and a direct `curl` GET. It never fetches, pulls, merges, pushes, writes files, follows redirects, triggers workflows, or attempts recovery. After the URL check it re-reads both GitHub values and local worktree state; any changed observation fails verification. A stale `origin/main` is therefore reported as a mismatch; update it through the normal approved Git workflow before rerunning.

Run its isolated unit test with `node --test tests/release-verifier.test.mjs`.
