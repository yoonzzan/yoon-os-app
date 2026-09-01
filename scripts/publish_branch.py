#!/usr/bin/env python3
"""Publish one clean, non-protected feature branch without bypassing review."""

from __future__ import annotations

import subprocess
import sys


PROTECTED_BRANCHES = {"main", "master"}


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=check
    )


def reject(message: str) -> None:
    print(f"REFUSED: {message}")
    raise SystemExit(1)


def output(*args: str) -> str | None:
    result = run(*args, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def main() -> None:
    branch = output("branch", "--show-current")
    if not branch:
        reject("detached HEAD cannot be published")
    if branch in PROTECTED_BRANCHES:
        reject(f"protected branch '{branch}' cannot be published")
    if output("status", "--porcelain"):
        reject("dirty worktree cannot be published")
    if output("remote", "get-url", "origin") is None:
        reject("origin remote is required")

    upstream = output("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    expected_upstream = f"origin/{branch}"
    if upstream and upstream != expected_upstream:
        reject(f"upstream must be {expected_upstream}, found {upstream}")

    fetched = run("fetch", "--quiet", "origin", "main", check=False)
    if fetched.returncode != 0:
        reject("could not fetch origin/main")
    if output("rev-parse", "--verify", "origin/main") is None:
        reject("origin/main is required")

    existing = run("ls-remote", "--exit-code", "--heads", "origin", f"refs/heads/{branch}", check=False)
    if existing.returncode == 0:
        reject(f"remote branch '{branch}' already exists")
    if existing.returncode not in {0, 2}:
        reject("could not determine whether the remote branch already exists")

    ancestry = run("merge-base", "--is-ancestor", "origin/main", "HEAD", check=False)
    if ancestry.returncode != 0:
        reject("current branch must contain origin/main before publishing")

    rebase = run("rebase", "origin/main", check=False)
    if rebase.returncode != 0:
        run("rebase", "--abort", check=False)
        reject("rebase onto origin/main failed; no branch was published")

    published = run("push", "--set-upstream", "origin", f"HEAD:refs/heads/{branch}", check=False)
    if published.returncode != 0:
        reject("publish failed; no force push or fallback was attempted")
    print(f"published {branch} to origin/{branch}")


if __name__ == "__main__":
    main()
