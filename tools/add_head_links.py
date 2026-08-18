#!/usr/bin/env python3
"""One-off: add the manifest, icons and print stylesheet to every page head.

Kept in the repo rather than run and deleted so the six HTML heads can be
brought back into agreement after any future edit, instead of being fixed by
hand and drifting apart again.
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PAGES = ["index.html", "day.html", "plan.html", "stays.html", "money.html", "about.html", "print.html"]

ANCHOR = '<link rel="stylesheet" href="assets/css/components.css" />'

ADDITIONS = [
    ('<link rel="stylesheet" href="assets/css/print.css" />', 'assets/css/print.css'),
    ('<link rel="manifest" href="manifest.webmanifest" />', 'rel="manifest"'),
    (
        '<link rel="icon" href="assets/icons/icon.svg" type="image/svg+xml" />',
        'rel="icon"',
    ),
    (
        '<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png" />',
        "apple-touch-icon",
    ),
    (
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        "apple-mobile-web-app-capable",
    ),
]


def main():
    changed = []
    for name in PAGES:
        path = os.path.join(ROOT, name)
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()

        if ANCHOR not in text:
            print(f"  skip {name}: no components.css link to anchor to")
            continue

        indent = re.search(r"([ \t]*)" + re.escape(ANCHOR), text).group(1)
        missing = [tag for tag, marker in ADDITIONS if marker not in text]
        if not missing:
            continue

        block = "".join(f"\n{indent}{tag}" for tag in missing)
        text = text.replace(ANCHOR, ANCHOR + block, 1)

        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        changed.append(f"{name} (+{len(missing)})")

    print("updated: " + (", ".join(changed) if changed else "nothing, all heads already match"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
