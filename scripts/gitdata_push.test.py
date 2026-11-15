#!/usr/bin/env python3
"""gitdata_push.test.py — regression tests for the push locks.

Why this file exists
--------------------
The PR #7 push dropped two source files because the payload was collected from
`git diff --name-status HEAD` (tracked files only) while the gates had verified
the working tree (which includes untracked files). A lesson written down in a
memory file does not survive a large diff; a test does.

These tests pin the two locks:

  LOCK 1  an untracked file or an unstaged modification aborts the push;
          a staged new file *does* reach the payload.
  LOCK 2  the assembled tree must equal `git write-tree`, and every blob sha
          must equal the sha the local index already computed for it.

Run:  python3 scripts/gitdata_push.test.py
No pytest needed — the sandbox has no pytest and a stub that swallows
`pytest.skip` would turn "skipped" into "passed".
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# Do not leave a __pycache__ behind: it would be an untracked file in the
# repository, which the push gate treats as a red flag.
sys.dont_write_bytecode = True

import gitdata_push as gp  # noqa: E402

FAILURES: list[str] = []
PASSED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"PASS  {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL  {name}" + (f"\n      {detail}" if detail else ""))


def make_repo() -> str:
    path = tempfile.mkdtemp(prefix="gitdata-push-test-")
    subprocess.run(["git", "init", "-q", "."], cwd=path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=path, check=True)
    with open(os.path.join(path, "a.txt"), "w", encoding="utf-8") as handle:
        handle.write("one\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=path, check=True)
    return path


def in_repo(path: str, fn):
    """Run fn() with the process cwd inside `path` (gp.git uses os.getcwd())."""
    previous = os.getcwd()
    os.chdir(path)
    try:
        return fn()
    finally:
        os.chdir(previous)


# --------------------------------------------------------------------------- #
# LOCK 1
# --------------------------------------------------------------------------- #
def test_untracked_file_trips_the_lock():
    repo = make_repo()
    try:
        with open(os.path.join(repo, "brand-new.ts"), "w", encoding="utf-8") as handle:
            handle.write("export const x = 1;\n")
        result = in_repo(repo, lambda: _expect_push_error(gp.assert_clean_worktree))
        check("LOCK 1 — untracked file trips the lock", result is not None,
              "assert_clean_worktree() accepted a tree with an untracked file")
        check("LOCK 1 — the error names the untracked file",
              result is not None and "brand-new.ts" in str(result),
              f"error was: {result}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def test_unstaged_modification_trips_the_lock():
    repo = make_repo()
    try:
        with open(os.path.join(repo, "a.txt"), "a", encoding="utf-8") as handle:
            handle.write("two\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        with open(os.path.join(repo, "a.txt"), "a", encoding="utf-8") as handle:
            handle.write("three\n")
        result = in_repo(repo, lambda: _expect_push_error(gp.assert_clean_worktree))
        check("LOCK 1 — unstaged modification trips the lock", result is not None,
              "assert_clean_worktree() accepted an index that differs from disk")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def test_staged_tree_passes_the_lock():
    repo = make_repo()
    try:
        with open(os.path.join(repo, "b.ts"), "w", encoding="utf-8") as handle:
            handle.write("export const y = 2;\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        result = in_repo(repo, lambda: _expect_push_error(gp.assert_clean_worktree))
        check("LOCK 1 — a fully staged tree passes the lock", result is None,
              f"the lock fired on a clean staged tree: {result}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def test_payload_reads_the_index_not_head():
    """The PR #7 bug, pinned: a brand new file must reach the payload."""
    repo = make_repo()
    try:
        with open(os.path.join(repo, "new-file.ts"), "w", encoding="utf-8") as handle:
            handle.write("export const z = 3;\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        payload = in_repo(repo, gp.collect_payload)
        paths = [row["path"] for row in payload]
        check("payload — a staged new file is in the payload",
              "new-file.ts" in paths, f"payload was: {paths}")
        index = in_repo(repo, gp.git_index_entries)
        check("payload — the index carries the new file",
              "new-file.ts" in index, f"index was: {sorted(index)}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def test_deleted_and_renamed_rows():
    repo = make_repo()
    try:
        os.rename(os.path.join(repo, "a.txt"), os.path.join(repo, "c.txt"))
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        payload = in_repo(repo, gp.collect_payload)
        rows = {row["path"]: row for row in payload}
        check("payload — a rename records its old path",
              "c.txt" in rows and rows["c.txt"].get("old_path") == "a.txt",
              f"rows were: {payload}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


# --------------------------------------------------------------------------- #
# LOCK 2 (local half — the remote half needs the network and runs in the push)
# --------------------------------------------------------------------------- #
def test_index_blob_sha_matches_git():
    repo = make_repo()
    try:
        with open(os.path.join(repo, "d.ts"), "w", encoding="utf-8") as handle:
            handle.write("export const w = 4;\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        index = in_repo(repo, gp.git_index_entries)
        expected = subprocess.run(
            ["git", "rev-parse", "HEAD:d.ts"], cwd=repo, capture_output=True, text=True
        )
        # d.ts is new, so it is not in HEAD; compare against the hash-object form
        blob = subprocess.run(
            ["git", "hash-object", "d.ts"], cwd=repo, capture_output=True, text=True
        ).stdout.strip()
        check("LOCK 2 — the index sha is git's own blob sha",
              index["d.ts"]["sha"] == blob,
              f"index {index['d.ts']['sha']} vs git {blob}")
        check("LOCK 2 — the mode is carried", index["d.ts"]["mode"] in ("100644", "100755"),
              f"mode was {index['d.ts']['mode']}")
        _ = expected
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def test_write_tree_is_reproducible():
    repo = make_repo()
    try:
        with open(os.path.join(repo, "e.ts"), "w", encoding="utf-8") as handle:
            handle.write("export const v = 5;\n")
        subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
        first = in_repo(repo, lambda: gp.git("write-tree").strip())
        second = in_repo(repo, lambda: gp.git("write-tree").strip())
        check("LOCK 2 — git write-tree is stable across calls", first == second,
              f"{first} vs {second}")
    finally:
        shutil.rmtree(repo, ignore_errors=True)


def _expect_push_error(fn):
    try:
        fn()
    except gp.PushError as error:
        return error
    return None


def main() -> int:
    for test in (
        test_untracked_file_trips_the_lock,
        test_unstaged_modification_trips_the_lock,
        test_staged_tree_passes_the_lock,
        test_payload_reads_the_index_not_head,
        test_deleted_and_renamed_rows,
        test_index_blob_sha_matches_git,
        test_write_tree_is_reproducible,
    ):
        test()
    print(f"\n{PASSED} passed, {len(FAILURES)} failed")
    if FAILURES:
        for name in FAILURES:
            print(f"  failed: {name}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
