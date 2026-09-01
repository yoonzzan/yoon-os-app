#!/usr/bin/env python3
"""Regression tests for the app repository's guarded first-publish helper."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLISHER = ROOT / "scripts" / "publish_branch.py"


def git(directory: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(directory), *args],
        check=check,
        text=True,
        capture_output=True,
    )


class PublishBranchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="app-publish-branch-")
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.local = self.root / "local"
        self.peer = self.root / "peer"
        subprocess.run(["git", "init", "--bare", str(self.remote)], check=True, capture_output=True)
        subprocess.run(["git", "clone", str(self.remote), str(self.local)], check=True, capture_output=True)
        git(self.local, "config", "user.email", "test@example.invalid")
        git(self.local, "config", "user.name", "Publisher Test")
        git(self.local, "checkout", "-b", "main")
        (self.local / "README.md").write_text("base\n", encoding="utf-8")
        git(self.local, "add", "README.md")
        git(self.local, "commit", "-m", "base")
        git(self.local, "push", "origin", "HEAD:refs/heads/main")
        git(self.remote, "symbolic-ref", "HEAD", "refs/heads/main")
        git(self.local, "fetch", "origin")
        subprocess.run(["git", "clone", str(self.remote), str(self.peer)], check=True, capture_output=True)
        git(self.peer, "config", "user.email", "peer@example.invalid")
        git(self.peer, "config", "user.name", "Publisher Peer")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def run_publisher(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(PUBLISHER)],
            cwd=self.local,
            text=True,
            capture_output=True,
        )

    def feature_commit(self, branch: str = "feat/publish") -> None:
        git(self.local, "checkout", "main")
        git(self.local, "checkout", "-b", branch)
        (self.local / "feature.md").write_text("feature\n", encoding="utf-8")
        git(self.local, "add", "feature.md")
        git(self.local, "commit", "-m", "feature")

    def remote_ref(self, branch: str) -> str | None:
        result = git(self.remote, "show-ref", "--verify", f"refs/heads/{branch}", check=False)
        return result.stdout.strip().split()[0] if result.returncode == 0 else None

    def test_rejects_protected_branch_without_pushing(self) -> None:
        before = self.remote_ref("main")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("protected", result.stdout)
        self.assertEqual(self.remote_ref("main"), before)

    def test_rejects_detached_head_without_pushing(self) -> None:
        before = self.remote_ref("main")
        git(self.local, "checkout", "--detach")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("detached", result.stdout)
        self.assertEqual(self.remote_ref("main"), before)

    def test_rejects_dirty_worktree_without_pushing(self) -> None:
        self.feature_commit("feat/dirty")
        dirty = self.local / "uncommitted.md"
        dirty.write_text("preserve\n", encoding="utf-8")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dirty", result.stdout)
        self.assertTrue(dirty.exists())
        self.assertIsNone(self.remote_ref("feat/dirty"))

    def test_rejects_protected_or_mismatched_upstream_without_pushing(self) -> None:
        self.feature_commit("feat/wrong-upstream")
        git(self.local, "branch", "--set-upstream-to=origin/main")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("upstream", result.stdout)
        self.assertIsNone(self.remote_ref("feat/wrong-upstream"))

    def test_rejects_existing_remote_feature_branch_without_pushing(self) -> None:
        git(self.peer, "checkout", "-b", "feat/existing", "origin/main")
        (self.peer / "peer.md").write_text("peer\n", encoding="utf-8")
        git(self.peer, "add", "peer.md")
        git(self.peer, "commit", "-m", "peer feature")
        git(self.peer, "push", "origin", "HEAD:refs/heads/feat/existing")
        self.feature_commit("feat/existing")
        before = self.remote_ref("feat/existing")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stdout)
        self.assertEqual(self.remote_ref("feat/existing"), before)

    def test_rejects_branch_without_origin_main_ancestry(self) -> None:
        git(self.local, "checkout", "--orphan", "feat/orphan")
        git(self.local, "rm", "-rf", ".")
        (self.local / "orphan.md").write_text("orphan\n", encoding="utf-8")
        git(self.local, "add", "orphan.md")
        git(self.local, "commit", "-m", "orphan")

        result = self.run_publisher()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("origin/main", result.stdout)
        self.assertIsNone(self.remote_ref("feat/orphan"))

    def test_publishes_clean_feature_without_upstream_to_matching_remote_ref(self) -> None:
        branch = "feat/first-publish"
        self.feature_commit(branch)
        main_before = self.remote_ref("main")
        self.assertNotEqual(git(self.local, "rev-parse", "--abbrev-ref", "@{upstream}", check=False).returncode, 0)

        result = self.run_publisher()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("published", result.stdout)
        self.assertEqual(self.remote_ref(branch), git(self.local, "rev-parse", "HEAD").stdout.strip())
        self.assertEqual(self.remote_ref("main"), main_before)
        self.assertEqual(
            git(self.local, "rev-parse", "--abbrev-ref", "@{upstream}").stdout.strip(),
            f"origin/{branch}",
        )


if __name__ == "__main__":
    unittest.main()
