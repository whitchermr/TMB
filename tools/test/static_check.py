#!/usr/bin/env python3
"""Static cross-checks between the HTML pages and their JavaScript modules.

Without a browser available to load the pages, these two checks catch the
integration mistakes that actually happen in a project shaped like this:

  1. A module reaches for an element id that no page defines (typo, or an id
     renamed in the HTML but not the JS).
  2. A named import that the target module does not export.

Also flags unused imports, which are harmless but usually mean a leftover.

    python3 tools/test/static_check.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# Which module each page loads, so element ids can be scoped to that page rather
# than pooled globally (a global pool would hide real per-page mistakes).
PAGE_MODULES = {
    "index.html": "assets/js/pages/index.js",
    "day.html": "assets/js/pages/day.js",
    "plan.html": "assets/js/pages/plan.js",
    "stays.html": "assets/js/pages/stays.js",
    "money.html": "assets/js/pages/money.js",
    "packing.html": "assets/js/pages/packing.js",
    "transit.html": "assets/js/pages/transit.js",
    "print.html": "assets/js/pages/print.js",
    "about.html": "assets/js/pages/about.js",
}

# Modules every page pulls in transitively; ids they create are available anywhere.
SHARED_MODULES = [
    "assets/js/ui/nav.js",
    "assets/js/ui/map.js",
    "assets/js/ui/elevation.js",
    "assets/js/ui/offline.js",
    "assets/js/ui/photo.js",
    "assets/js/ui/history.js",
    "assets/js/core/store.js",
    "assets/js/core/sync.js",
    "assets/js/core/units.js",
    "assets/js/core/geo.js",
    "assets/js/core/sun.js",
    "assets/js/core/schedule.js",
    "assets/js/core/money.js",
    "assets/js/core/transit.js",
    "assets/js/core/links.js",
]

ID_ATTR = re.compile(r"""\bid\s*=\s*["']([A-Za-z][\w:-]*)["']""")
GET_BY_ID = re.compile(r"""getElementById\(\s*["']([\w:-]+)["']\s*\)""")
QUERY_ID = re.compile(r"""querySelector(?:All)?\(\s*["']#([\w:-]+)""")
IMPORT_NAMED = re.compile(
    r"""import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']""", re.S
)
IMPORT_STAR = re.compile(r"""import\s*\*\s*as\s*(\w+)\s*from\s*["']([^"']+)["']""")
EXPORTED = re.compile(
    r"""^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)""", re.M
)
EXPORT_LIST = re.compile(r"""^export\s*\{([^}]+)\}""", re.M)

failures = []
warnings = []
checks = 0


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def ids_declared_in(text):
    """Element ids present in a source file, including ones built in template strings."""
    return set(ID_ATTR.findall(text))


def exports_of(path):
    text = read(path)
    names = set(EXPORTED.findall(text))
    for group in EXPORT_LIST.findall(text):
        for entry in group.split(","):
            name = entry.strip().split(" as ")[-1].strip()
            if name:
                names.add(name)
    return names


def check_ids():
    global checks
    print("== Element id references ==")

    shared_ids = set()
    for module in SHARED_MODULES:
        shared_ids |= ids_declared_in(read(module))

    for page, module in PAGE_MODULES.items():
        page_text = read(page)
        module_text = read(module)

        available = ids_declared_in(page_text) | ids_declared_in(module_text) | shared_ids
        referenced = set(GET_BY_ID.findall(module_text)) | set(QUERY_ID.findall(module_text))

        missing = sorted(referenced - available)
        checks += 1
        if missing:
            failures.append(f"{module} references ids not present in {page}: {', '.join(missing)}")
            print(f"  FAIL  {page:12s} missing: {', '.join(missing)}")
        else:
            print(f"  ok    {page:12s} {len(referenced)} ids all resolve")

        # An id declared in the page but never touched is usually fine (styling
        # hooks), so that direction is not reported.


def check_imports():
    global checks
    print("\n== Imports resolve to real exports ==")

    for path in sorted(Path(ROOT / "assets/js").rglob("*.js")):
        relative = path.relative_to(ROOT)
        text = path.read_text(encoding="utf-8")
        # Strip the import statements before scanning for usage, otherwise the
        # module paths themselves look like member access: "core/store.js" would
        # register as store.js.
        body = IMPORT_STAR.sub("", IMPORT_NAMED.sub("", text))
        problems = []
        unused = []

        for group, target in IMPORT_NAMED.findall(text):
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                problems.append(f"missing module {target}")
                continue
            available = exports_of(resolved.relative_to(ROOT))
            for entry in group.split(","):
                name = entry.strip()
                if not name:
                    continue
                local = name.split(" as ")[-1].strip()
                original = name.split(" as ")[0].strip()
                if original not in available:
                    problems.append(f"{target} does not export '{original}'")
                    continue
                if not re.search(rf"\b{re.escape(local)}\b", body):
                    unused.append(f"{local} (from {target})")

        for alias, target in IMPORT_STAR.findall(text):
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                problems.append(f"missing module {target}")
                continue
            available = exports_of(resolved.relative_to(ROOT))
            # The negative lookbehind matters: settings.money.budgetPerPerson is a
            # property of a data object, not the imported `money` module.
            pattern = rf"(?<![\w.]){re.escape(alias)}\.(\w+)"
            for used in set(re.findall(pattern, body)):
                if used not in available:
                    problems.append(f"{target} has no export '{used}' (used as {alias}.{used})")

        checks += 1
        if problems:
            failures.append(f"{relative}: " + "; ".join(problems))
            print(f"  FAIL  {relative}")
            for problem in problems:
                print(f"          {problem}")
        elif unused:
            warnings.append(f"{relative}: unused import {', '.join(unused)}")
            print(f"  ok*   {relative}  (unused: {', '.join(unused)})")
        else:
            print(f"  ok    {relative}")


def check_page_wiring():
    global checks
    print("\n== Page wiring ==")

    for page, module in PAGE_MODULES.items():
        text = read(page)
        checks += 1
        if module not in text:
            failures.append(f"{page} does not load {module}")
            print(f"  FAIL  {page} does not load its module")
            continue

        needs_leaflet = "createMap" in read(module)
        has_leaflet = "vendor/leaflet/leaflet.js" in text
        if needs_leaflet and not has_leaflet:
            failures.append(f"{page} uses the map but does not include Leaflet")
            print(f"  FAIL  {page} uses the map without loading Leaflet")
            continue
        if not needs_leaflet and has_leaflet:
            warnings.append(f"{page} loads Leaflet but never creates a map")

        for stylesheet in ("assets/css/base.css", "assets/css/components.css"):
            if stylesheet not in text:
                failures.append(f"{page} is missing {stylesheet}")

        if 'name="viewport"' not in text:
            failures.append(f"{page} has no viewport meta tag, so it will not scale on a phone")

        print(f"  ok    {page:12s} module, styles and viewport present")


def main():
    check_ids()
    check_imports()
    check_page_wiring()

    print(f"\n{checks} checks run, {len(failures)} failed, {len(warnings)} warnings")
    if warnings:
        print("\nWarnings:")
        for warning in warnings:
            print(f"  - {warning}")
    if failures:
        print("\nFailures:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("\nStatic cross-checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
