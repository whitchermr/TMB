#!/usr/bin/env python3
"""Verify every local reference resolves, case-sensitively.

GitHub Pages serves a project repo from a subpath (/<repo>/) on a
case-sensitive filesystem. macOS is case-insensitive, so a reference like
"assets/CSS/base.css" works locally and 404s once published. This walks the
HTML/CSS/JS and confirms each relative reference exists with exact case.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

HTML_REF = re.compile(r'(?:src|href)\s*=\s*"([^"]+)"')
JS_IMPORT = re.compile(r'(?:^|\s)(?:import|export)[^\'"\n]*from\s+[\'"]([^\'"]+)[\'"]')
JS_DYNAMIC = re.compile(r'import\(\s*[\'"]([^\'"]+)[\'"]\s*\)')
FETCH_REF = re.compile(r'fetch\(\s*[\'"]([^\'"]+)[\'"]')
REQUEST_REF = re.compile(r'new Request\(\s*[\'"]([^\'"]+)[\'"]')
CSS_URL = re.compile(r'url\(\s*[\'"]?([^\'")]+)[\'"]?\s*\)')

SKIP_PREFIXES = ("http://", "https://", "//", "data:", "mailto:", "#", "javascript:")


def walk_files(exts):
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [
            d for d in dirnames
            if d not in {".git", "node_modules"} and not d.startswith("Generalized")
        ]
        for name in filenames:
            if name.endswith(exts):
                yield os.path.join(dirpath, name)


def exists_exact(path):
    """os.path.exists is case-insensitive on macOS; compare against listdir."""
    path = os.path.normpath(path)
    if not os.path.exists(path):
        return False
    parent, name = os.path.split(path)
    try:
        return name in os.listdir(parent or ".")
    except OSError:
        return False


def collect(path):
    """References for a file, split by what they resolve against.

    Module specifiers resolve against the module's own URL, but `fetch()` and
    `new Request()` resolve against the *document* URL. Every page in this site
    lives at the repo root, so those are checked from the root instead of from
    the directory the script happens to sit in.
    """
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()

    relative_to_file = []
    relative_to_root = []

    if path.endswith(".html"):
        relative_to_file += HTML_REF.findall(text)
    if path.endswith((".js", ".html")):
        relative_to_file += JS_IMPORT.findall(text)
        relative_to_file += JS_DYNAMIC.findall(text)
        relative_to_root += FETCH_REF.findall(text)
        relative_to_root += REQUEST_REF.findall(text)
    if path.endswith((".css", ".html")):
        relative_to_file += CSS_URL.findall(text)

    # An HTML file *is* the document, so both kinds resolve from its directory.
    if path.endswith(".html"):
        relative_to_file += relative_to_root
        relative_to_root = []

    return relative_to_file, relative_to_root


def main():
    problems = []
    checked = 0
    for path in sorted(walk_files((".html", ".js", ".css"))):
        if "assets/vendor/" in path or "/tools/test/" in path:
            continue

        from_file, from_root = collect(path)
        for base, refs in ((os.path.dirname(path), from_file), (ROOT, from_root)):
            for ref in refs:
                ref = ref.strip()
                if not ref or ref.startswith(SKIP_PREFIXES):
                    continue
                if ref.startswith("/"):
                    problems.append(
                        f"{os.path.relpath(path, ROOT)}: root-absolute '{ref}' "
                        f"breaks on Pages project subpaths"
                    )
                    continue
                target = os.path.join(base, ref.split("?")[0].split("#")[0])
                checked += 1
                if not exists_exact(target):
                    problems.append(
                        f"{os.path.relpath(path, ROOT)}: '{ref}' not found "
                        f"(resolved {os.path.relpath(os.path.normpath(target), ROOT)})"
                    )

    # Data files loaded by the store go through a path constant, not a literal.
    for name in ("settings", "itinerary", "waypoints", "stays", "people", "expenses", "rates"):
        target = os.path.join(ROOT, "data", f"{name}.json")
        checked += 1
        if not exists_exact(target):
            problems.append(f"data/{name}.json missing")

    if problems:
        print(f"FAIL check_paths: {len(problems)} problem(s)")
        for problem in problems:
            print(f"  {problem}")
        return 1
    print(f"PASS check_paths: {checked} local references resolve with exact case")
    return 0


if __name__ == "__main__":
    sys.exit(main())
