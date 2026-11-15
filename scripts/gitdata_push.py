#!/usr/bin/env python3
"""gitdata_push.py — push a change set to GitHub through the Git Data API, with
hard locks against the "half-pushed tree" failure that this repository has
already paid for once.

Why this exists
---------------
The PR #7 push silently dropped two source files. The cause was a *split
verification data source*:

  * the local gates (``guard.cjs``, ``bundle-server.mjs``, the dangling-import
    scan) read the **working tree** — including untracked files;
  * the push script collected its payload from ``git diff --name-status HEAD``,
    which only sees **tracked** files, so a brand new file was invisible.

Writing that lesson into memory does not help: memory depends on the operator
remembering it, under load, with a large diff. This script makes both failure
modes impossible to pass silently:

  LOCK 1 — untracked / unstaged interception.
          At entry, ``git status --porcelain`` is inspected.  Any untracked file
          (``??``) or unstaged modification (a dirty second column) aborts the
          run with a non-zero exit code.  The payload is always collected from
          the index (``git diff --cached --name-status HEAD``), so what is
          verified is exactly what is pushed.

  LOCK 2 — tree reconciliation.
          Every blob is cross-checked against the sha the local index already
          computed for it; the assembled tree is compared byte-for-byte with
          ``git write-tree``; and after the push the remote commit is re-read
          and its ``tree.sha`` is compared with ``git write-tree`` again.  One
          differing bit fails the run.

Usage
-----
  REPO=dongkai905/OpenMausBot BASE=main BRANCH=feat/pr9-xyz \\
      python3 scripts/gitdata_push.py --message "..." --title "..." --body-file pr.md

  # verify an already pushed branch against the local index (no writes)
  python3 scripts/gitdata_push.py --verify-branch feat/pr9-xyz

  # after a merge, assert the merged tree equals the local tree
  python3 scripts/gitdata_push.py --verify-branch main --base-merge

Exit codes
----------
  0  success
  1  a lock fired (untracked files, sha mismatch, missing file on the remote)
  2  usage / environment problem
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"
EVIDENCE_PATH = ".git/push-evidence.json"


class PushError(RuntimeError):
    """A hard lock fired. The push must not proceed (or must be considered failed)."""


# --------------------------------------------------------------------------- #
# plumbing
# --------------------------------------------------------------------------- #
def token() -> str:
    for name in ("GITHUB_OAUTH_TOKEN", "GITHUB_TOKEN"):
        value = os.environ.get(name)
        if value:
            return value
    raise PushError("neither GITHUB_OAUTH_TOKEN nor GITHUB_TOKEN is set")


def api(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + token())
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    request.add_header("User-Agent", "omb-gitdata-push")
    if data:
        request.add_header("Content-Type", "application/json")
    # GitHub's blob endpoint drops the connection or answers "malformed request"
    # under load, and the same request then succeeds. A push that dies on a
    # transient 400 would be indistinguishable from a real one, so both are
    # retried before the push is called a failure.
    last: Exception | None = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read().decode()
            return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            detail = error.read().decode()[:900]
            last = PushError(f"GitHub API {method} {path} -> HTTP {error.code}: {detail}")
            if error.code not in (400, 409, 422, 429, 500, 502, 503, 504):
                raise last from error
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last = PushError(f"GitHub API {method} {path} -> {type(error).__name__}: {error}")
        time.sleep(1.5 * (attempt + 1))
    raise last if last else PushError(f"GitHub API {method} {path} failed")


def git(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args], capture_output=True, text=True, cwd=os.getcwd()
    )
    if check and result.returncode != 0:
        raise PushError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def git_index_entries() -> dict:
    """path -> {mode, sha} for every file in the index (the exact push payload)."""
    entries: dict = {}
    for line in git("ls-files", "-s", "-z").split("\0"):
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode, blob, stage = meta.split()
        if stage != "0":
            raise PushError(f"index has an unmerged entry (stage {stage}): {path}")
        entries[path] = {"mode": mode, "sha": blob}
    return entries


# --------------------------------------------------------------------------- #
# LOCK 1 — untracked / unstaged interception
# --------------------------------------------------------------------------- #
def assert_clean_worktree() -> None:
    """Refuse to push while the working tree holds anything the index does not.

    ``git status --porcelain`` line format: XY<space>path.  X is the index
    status, Y the working-tree status.  A staged change (X != ' ') is the
    payload and is fine.  ``??`` is untracked.  A dirty Y column means the file
    on disk differs from the index — the payload would not be what gets
    verified.
    """
    raw = git("status", "--porcelain", "--untracked-files=all")
    untracked: list[str] = []
    unstaged: list[str] = []
    staged: list[str] = []

    for line in raw.split("\n"):
        if not line.strip():
            continue
        code, path = line[:2], line[3:].strip()
        if code == "??":
            untracked.append(path)
        elif code[1] != " ":
            unstaged.append(f"{path} ({code.strip()})")
        elif code[0] != " ":
            staged.append(path)

    if untracked or unstaged:
        print("LOCK 1 tripped — the working tree is not fully staged.\n", file=sys.stderr)
        if untracked:
            print("  untracked files (invisible to `git diff HEAD` — the PR #7 bug):",
                  file=sys.stderr)
            for path in untracked[:40]:
                print(f"    ?? {path}", file=sys.stderr)
            if len(untracked) > 40:
                print(f"    … {len(untracked) - 40} more", file=sys.stderr)
        if unstaged:
            print("  unstaged modifications (on disk differ from the index):",
                  file=sys.stderr)
            for path in unstaged[:40]:
                print(f"    {path}", file=sys.stderr)
        print("\n  Run `git add -A` (and commit or drop what you do not want), then"
              " push again.\n  Nothing was pushed.", file=sys.stderr)
        # The message is self-contained: a log line that only says "not staged"
        # does not tell the next operator which file was left behind.
        detail = []
        if untracked:
            detail.append("untracked: " + ", ".join(untracked[:10])
                          + (f" (+{len(untracked) - 10} more)" if len(untracked) > 10 else ""))
        if unstaged:
            detail.append("unstaged: " + ", ".join(unstaged[:10])
                          + (f" (+{len(unstaged) - 10} more)" if len(unstaged) > 10 else ""))
        raise PushError("working tree is not fully staged — " + "; ".join(detail))

    print(f"LOCK 1 clear — working tree fully staged ({len(staged)} paths staged).")


# --------------------------------------------------------------------------- #
# payload collection
# --------------------------------------------------------------------------- #
def collect_payload() -> list[dict]:
    """The change set, read from the INDEX (never from `git diff HEAD`)."""
    rows = []
    for line in git("diff", "--cached", "--name-status", "HEAD").split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        path = parts[-1]
        row = {"status": status, "path": path}
        if status[0] in ("R", "C"):
            row["old_path"] = parts[1]
        rows.append(row)
    return rows


# --------------------------------------------------------------------------- #
# LOCK 2 — tree reconciliation
# --------------------------------------------------------------------------- #
BLOB_CACHE_PATH = ".git/push-blob-cache.json"


def _cache_load() -> dict:
    try:
        with open(BLOB_CACHE_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _cache_save(cache: dict) -> None:
    """Merge into whatever is on disk before writing: two runs must not erase
    each other's progress (an interrupted run leaves its successor a shorter
    cache, and the push starts over)."""
    try:
        on_disk = _cache_load()
        on_disk.update(cache)
        with open(BLOB_CACHE_PATH, "w", encoding="utf-8") as handle:
            json.dump(on_disk, handle)
    except OSError:
        pass


def upload_blob(path: str) -> str:
    """Upload one blob, remembering it so an interrupted push can resume.

    A push of this size is thousands of requests; an interrupted run must not
    start over. The cache is keyed by size and mtime, so a file that changed
    since the last run is uploaded again.
    """
    cache = _cache_load()
    try:
        stat = os.stat(path)
        key = f"{stat.st_size}:{stat.st_mtime_ns}"
    except OSError as error:
        raise PushError(f"{path} is in the diff but not readable: {error}") from error
    hit = cache.get(path)
    if isinstance(hit, dict) and hit.get("key") == key:
        return hit["sha"]
    with open(path, "rb") as handle:
        raw = handle.read()
    blob = api("POST", f"/repos/{repo()}/git/blobs", {
        "content": base64.b64encode(raw).decode(),
        "encoding": "base64",
    })
    cache[path] = {"key": key, "sha": blob["sha"]}
    _cache_save(cache)
    return blob["sha"]


def build_remote_tree(base_tree: str, payload: list[dict], index: dict) -> str:
    """Upload every changed blob, assemble the tree, and reconcile it."""
    entries = []
    deleted = 0
    uploaded = 0

    for row in payload:
        status, path = row["status"], row["path"]
        if status[0] == "R" and row.get("old_path"):
            old = row["old_path"]
            mode = head_mode(old)
            entries.append({"path": old, "mode": mode, "type": "blob", "sha": None})
            deleted += 1

        if status[0] == "D":
            entries.append({
                "path": path, "mode": head_mode(path), "type": "blob", "sha": None,
            })
            deleted += 1
            continue

        local = index.get(path)
        if local is None:
            raise PushError(f"{path} is in the diff but missing from the index")
        if local["mode"] == "160000":
            raise PushError(f"{path} is a submodule (mode 160000); unsupported")

        remote_sha = upload_blob(path)
        if remote_sha != local["sha"]:
            raise PushError(
                f"blob sha mismatch for {path}: local index {local['sha']} vs "
                f"uploaded {remote_sha}"
            )
        entries.append({
            "path": path, "mode": local["mode"], "type": "blob", "sha": remote_sha,
        })
        uploaded += 1

    tree = api("POST", f"/repos/{repo()}/git/trees", {
        "base_tree": base_tree, "tree": entries,
    })
    print(f"  uploaded {uploaded} blob(s), removed {deleted} path(s)")

    local_tree = git("write-tree").strip()
    if tree["sha"] != local_tree:
        raise PushError(
            "LOCK 2 tripped — assembled tree differs from the local tree:\n"
            f"  remote assembled : {tree['sha']}\n"
            f"  local write-tree  : {local_tree}\n"
            "  A differing bit means the payload is not what the gates verified."
        )
    print(f"  tree sha reconciled: {tree['sha']} == git write-tree")
    return tree["sha"]


def head_mode(path: str) -> str:
    for line in git("ls-tree", "HEAD", "--", path).split("\n"):
        if line.strip():
            meta = line.split("\t", 1)[0].split()
            if meta[1] == "commit":
                raise PushError(f"{path} is a submodule (mode 160000); unsupported")
            return meta[0]
    return "100644"


def walk_remote_tree(sha: str, prefix: str = "") -> dict:
    """Every blob in a remote tree, as path -> (mode, blob sha)."""
    out: dict = {}
    for node in api("GET", f"/repos/{repo()}/git/trees/{sha}?recursive=1")["tree"]:
        if node["type"] != "blob":
            continue
        out[f"{prefix}{node['path']}"] = (node["mode"], node["sha"])
    return out


def assert_remote_matches_index(branch: str) -> dict:
    """After the push: the remote tree must equal the local index, file by file."""
    ref = api("GET", f"/repos/{repo()}/git/ref/heads/{branch}")
    commit = api("GET", f"/repos/{repo()}/git/commits/{ref['object']['sha']}")
    remote_tree_sha = commit["tree"]["sha"]
    local_tree_sha = git("write-tree").strip()

    if remote_tree_sha != local_tree_sha:
        raise PushError(
            "LOCK 2 tripped — pushed tree differs from the local tree:\n"
            f"  remote commit.tree.sha : {remote_tree_sha}\n"
            f"  local git write-tree    : {local_tree_sha}"
        )

    remote_files = walk_remote_tree(remote_tree_sha)
    local_files = {
        path: (entry["mode"], entry["sha"]) for path, entry in git_index_entries().items()
    }
    missing = sorted(set(local_files) - set(remote_files))
    extra = sorted(set(remote_files) - set(local_files))
    differing = sorted(
        path for path in set(local_files) & set(remote_files)
        if local_files[path][1] != remote_files[path][1]
    )
    if missing or extra or differing:
        for label, paths in (("missing on remote", missing),
                             ("extra on remote", extra),
                             ("content differs", differing)):
            for path in paths[:40]:
                print(f"  {label}: {path}", file=sys.stderr)
        raise PushError(
            f"remote tree does not match the local index "
            f"({len(missing)} missing, {len(extra)} extra, {len(differing)} differing)"
        )

    print(f"  remote commit.tree.sha  : {remote_tree_sha}")
    print(f"  local git write-tree    : {local_tree_sha}")
    print(f"  file-by-file match      : {len(local_files)} files identical")
    return {
        "branch": branch,
        "commit": ref["object"]["sha"],
        "remoteTreeSha": remote_tree_sha,
        "localTreeSha": local_tree_sha,
        "fileCount": len(local_files),
    }


# --------------------------------------------------------------------------- #
# repo plumbing
# --------------------------------------------------------------------------- #
_REPO = None


def repo() -> str:
    global _REPO
    if _REPO is None:
        raise PushError("repository not configured")
    return _REPO


def resolve_ref(ref: str) -> str:
    if ref.startswith("refs/"):
        ref = ref[len("refs/"):]
    try:
        return api("GET", f"/repos/{repo()}/git/ref/heads/{ref}")["object"]["sha"]
    except PushError:
        return api("GET", f"/repos/{repo()}/git/ref/tags/{ref}")["object"]["sha"]


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=os.environ.get("REPO", "dongkai905/OpenMausBot"))
    parser.add_argument("--base", default=os.environ.get("BASE", "main"))
    parser.add_argument("--branch", default=os.environ.get("BRANCH", ""))
    parser.add_argument("--message", default=os.environ.get("MSG", ""))
    parser.add_argument("--title", default=os.environ.get("TITLE", ""))
    parser.add_argument("--body-file", default=os.environ.get("BODY_FILE", ""))
    parser.add_argument("--body", default=os.environ.get("BODY", ""))
    parser.add_argument("--no-pr", action="store_true", help="push the branch, skip the PR")
    parser.add_argument("--verify-branch", default="",
                        help="verify an existing remote branch against the local index")
    parser.add_argument("--verify-merged", action="store_true",
                        help="with --verify-branch: also assert the branch is merged into base")
    args = parser.parse_args()

    global _REPO
    _REPO = args.repo

    try:
        if args.verify_branch:
            print(f"verifying remote branch {args.verify_branch} against the local index")
            evidence = assert_remote_matches_index(args.verify_branch)
            if args.verify_merged:
                base_sha = resolve_ref(args.base)
                merged = api("GET", f"/repos/{repo()}/pulls?state=closed&head={repo().split('/')[0]}:{args.verify_branch}")
                if not merged:
                    raise PushError(f"no merged PR found for {args.verify_branch}")
                print(f"  merged PR: #{merged[0]['number']} → {merged[0]['merge_commit_sha']}")
            write_evidence(evidence, "verify")
            print("verification passed")
            return 0

        if not args.branch:
            raise PushError("--branch is required")
        if not args.message:
            raise PushError("--message is required")

        # LOCK 1 first: nothing is uploaded from a tree we have not verified.
        assert_clean_worktree()

        base_sha = resolve_ref(args.base)
        base_commit = api("GET", f"/repos/{repo()}/git/commits/{base_sha}")
        base_tree = base_commit["tree"]["sha"]
        local_base_tree = git("rev-parse", "HEAD^{tree}").strip()
        print(f"base {args.base}: {base_sha[:9]}  tree {base_tree[:9]}")

        payload = collect_payload()
        if not payload:
            raise PushError("the index holds no change against HEAD — nothing to push")
        index = git_index_entries()
        print(f"payload: {len(payload)} path(s) from `git diff --cached --name-status HEAD`")

        tree_sha = build_remote_tree(base_tree, payload, index)
        commit = api("POST", f"/repos/{repo()}/git/commits", {
            "message": args.message,
            "tree": tree_sha,
            "parents": [base_sha],
        })
        print(f"commit: {commit['sha'][:9]}")

        try:
            api("POST", f"/repos/{repo()}/git/refs",
                {"ref": f"refs/heads/{args.branch}", "sha": commit["sha"]})
            print(f"branch created: {args.branch}")
        except PushError as error:
            if "422" not in str(error):
                raise
            api("PATCH", f"/repos/{repo()}/git/refs/heads/{args.branch}",
                {"sha": commit["sha"], "force": True})
            print(f"branch updated: {args.branch}")

        evidence = assert_remote_matches_index(args.branch)
        evidence.update({"base": args.base, "baseSha": base_sha,
                         "baseTreeSha": base_tree, "localBaseTreeSha": local_base_tree,
                         "payloadPaths": [row["path"] for row in payload]})
        write_evidence(evidence, "push")

        if not args.no_pr:
            body = args.body
            if args.body_file:
                with open(args.body_file, encoding="utf-8") as handle:
                    body = handle.read()
            title = args.title or args.message
            try:
                pr = api("POST", f"/repos/{repo()}/pulls", {
                    "title": title,
                    "head": args.branch,
                    "base": args.base,
                    "body": body,
                })
                print(f"PR: #{pr['number']} {pr['html_url']}")
            except PushError as error:
                if "422" not in str(error):
                    raise
                existing = api("GET", f"/repos/{repo()}/pulls?state=open&head="
                                       f"{args.repo.split('/')[0]}:{args.branch}")
                print("PR already exists:",
                      [(p["number"], p["html_url"]) for p in existing])

        print("\nreconciliation evidence:")
        print(json.dumps(evidence, indent=2, ensure_ascii=False))
        return 0

    except PushError as error:
        print(f"\nFAILED: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - top level guard
        print(f"\nFAILED (unexpected): {error!r}", file=sys.stderr)
        return 2


def write_evidence(evidence: dict, kind: str) -> None:
    evidence = dict(evidence)
    evidence["kind"] = kind
    evidence["at"] = subprocess.run(["date", "-Is"], capture_output=True,
                                     text=True).stdout.strip()
    try:
        with open(EVIDENCE_PATH, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        print(f"evidence written to {EVIDENCE_PATH}")
    except OSError as error:
        print(f"could not write {EVIDENCE_PATH}: {error}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
