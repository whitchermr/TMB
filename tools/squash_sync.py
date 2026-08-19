#!/usr/bin/env python3
"""
Fold the shared operation log back into the committed data file.

Edits made on the site are appended to a log on the unpublished `sync` branch,
and every page shows `committed file + log`. That works indefinitely, but the log
is not meant to accumulate forever: it makes the committed file a less and less
honest picture of what the group actually decided, and the Worker eventually
refuses to grow it further.

Squashing applies the log to the data file and empties the log. It uses the same
reducer the browser uses — assets/js/core/sync.js under JavaScriptCore — rather
than a second implementation of the same rules, because two implementations of
"last edit wins" would eventually disagree and the disagreement would look like
data loss.

Safe by default and in two steps, so a cleared log can never outrun a published
data file:

    tools/squash_sync.py                     # what would change
    tools/squash_sync.py --write             # apply it to data/packing.json
    git commit -am "Squash the packing log." && git push
    tools/squash_sync.py --clear-log         # only then empty the log

--clear-log refuses unless the published data file already accounts for every
operation in the log, which it checks by applying the log to what is actually on
origin/main and requiring the result to be unchanged.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSC = Path(
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
)
REDUCER = ROOT / "tools" / "reduce_log.js"

# Files this can squash, and where their log lives. Mirrors COLLECTIONS in
# assets/js/core/sync.js.
FILES = {"packing": "data/packing.json"}


def run(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        raise SystemExit(f"{' '.join(args)} failed:\n{result.stderr.strip()}")
    return result.stdout


def reduce_with_site_logic(base: dict, ops: list) -> dict:
    """Apply the log using the browser's reducer, via JavaScriptCore."""
    if not JSC.exists():
        raise SystemExit(f"JavaScriptCore not found at {JSC}")

    with tempfile.TemporaryDirectory() as workspace:
        base_path = Path(workspace) / "base.json"
        ops_path = Path(workspace) / "ops.json"
        base_path.write_text(json.dumps(base), encoding="utf-8")
        ops_path.write_text(json.dumps(ops), encoding="utf-8")
        output = run(
            str(JSC),
            "-m",
            str(REDUCER),
            "--",
            str(base_path),
            str(ops_path),
        )
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        raise SystemExit(f"the reducer did not return JSON:\n{output.strip()}")


def read_log(name: str, branch: str, fetch: bool) -> list:
    if fetch:
        run("git", "fetch", "--quiet", "origin", branch, check=False)
    path = f"data/sync/{name}.log.json"
    for ref in (f"origin/{branch}", branch):
        result = subprocess.run(
            ["git", "show", f"{ref}:{path}"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            parsed = json.loads(result.stdout)
            return parsed if isinstance(parsed, list) else parsed.get("ops", [])
    return []


def published(name: str) -> dict | None:
    """data/<name>.json as it exists on origin/main, or None if unreachable."""
    run("git", "fetch", "--quiet", "origin", "main", check=False)
    result = subprocess.run(
        ["git", "show", f"origin/main:{FILES[name]}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return json.loads(result.stdout) if result.returncode == 0 else None


def describe(ops: list) -> None:
    by_kind: dict[str, int] = {}
    by_person: dict[str, int] = {}
    for op in ops:
        by_kind[op.get("op", "?")] = by_kind.get(op.get("op", "?"), 0) + 1
        who = op.get("by") or "unattributed"
        by_person[who] = by_person.get(who, 0) + 1
    print(f"  {len(ops)} operation(s) in the log")
    for kind, count in sorted(by_kind.items()):
        print(f"    {kind}: {count}")
    print(f"    from: {', '.join(f'{k} ({v})' for k, v in sorted(by_person.items()))}")


def report(base: dict, merged: dict) -> None:
    """What squashing would change, per record rather than per count.

    Counts alone hide the common case: one item removed and another added leaves
    the total identical and looks like nothing happened.
    """
    for key, before in base.items():
        if not isinstance(before, list):
            continue
        after = merged.get(key, [])
        was = {row.get("id"): row for row in before if isinstance(row, dict)}
        now = {row.get("id"): row for row in after if isinstance(row, dict)}
        groups = (
            ("added", sorted(set(now) - set(was))),
            ("removed", sorted(set(was) - set(now))),
            ("edited", sorted(i for i in set(was) & set(now) if was[i] != now[i])),
        )
        if not any(ids for _, ids in groups):
            continue
        print(f"  {key}: {len(before)} -> {len(after)}")
        for label, ids in groups:
            if ids:
                print(f"    {label}: {', '.join(ids)}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--file", default="packing", choices=sorted(FILES))
    parser.add_argument("--branch", default="sync", help="branch holding the log")
    parser.add_argument("--write", action="store_true", help="apply the log to the data file")
    parser.add_argument(
        "--clear-log",
        action="store_true",
        help="empty the log, once the squashed file is published",
    )
    parser.add_argument("--no-fetch", action="store_true", help="use local refs only")
    args = parser.parse_args()

    name = args.file
    target = ROOT / FILES[name]
    base = json.loads(target.read_text(encoding="utf-8"))
    ops = read_log(name, args.branch, fetch=not args.no_fetch)

    if not ops:
        print(f"The {name} log is empty — nothing to squash.")
        return 0

    describe(ops)

    if args.clear_log:
        remote = published(name)
        if remote is None:
            raise SystemExit(
                f"Could not read {FILES[name]} from origin/main, so it is not safe "
                "to clear the log."
            )
        if reduce_with_site_logic(remote, ops) != remote:
            raise SystemExit(
                "The published data file does not yet account for every operation "
                "in the log. Run --write, commit and push it, then try again."
            )
        clear_log(name, args.branch)
        print(f"Emptied data/sync/{name}.log.json on {args.branch}.")
        return 0

    merged = reduce_with_site_logic(base, ops)
    report(base, merged)

    if merged == base:
        print("The data file already reflects the whole log; only --clear-log is left.")
        return 0

    if not args.write:
        print(f"\nDry run. Re-run with --write to update {FILES[name]}.")
        return 0

    target.write_text(f"{json.dumps(merged, indent=2, ensure_ascii=False)}\n", encoding="utf-8")
    print(f"\nWrote {FILES[name]}.")
    print("Review it, commit and push, then re-run with --clear-log.")
    return 0


def clear_log(name: str, branch: str) -> None:
    """Empty the log on its own branch, without disturbing the working tree."""
    with tempfile.TemporaryDirectory() as workspace:
        tree = Path(workspace) / "sync"
        run("git", "worktree", "add", "--quiet", "--detach", str(tree), f"origin/{branch}")
        try:
            log_file = tree / "data" / "sync" / f"{name}.log.json"
            log_file.parent.mkdir(parents=True, exist_ok=True)
            log_file.write_text("[]\n", encoding="utf-8")
            run("git", "-C", str(tree), "add", str(log_file))
            run(
                "git",
                "-C",
                str(tree),
                "commit",
                "--quiet",
                "-m",
                f"Squash the {name} log into data/{name}.json.",
            )
            run("git", "-C", str(tree), "push", "--quiet", "origin", f"HEAD:{branch}")
        finally:
            run("git", "worktree", "remove", "--force", str(tree), check=False)


if __name__ == "__main__":
    sys.exit(main())
