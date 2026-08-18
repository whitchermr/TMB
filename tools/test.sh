#!/usr/bin/env bash
#
# Check every JavaScript file parses, then run the logic test suite.
#
# Uses JavaScriptCore, which ships with macOS, so there is nothing to install.
#
#   ./tools/test.sh

set -uo pipefail

cd "$(dirname "$0")/.."

JSC="/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
if [ ! -x "$JSC" ]; then
  echo "JavaScriptCore not found at $JSC" >&2
  exit 1
fi

FAILED=0

echo "== Syntax check =="
while IFS= read -r file; do
  # checkModuleSyntax parses without executing, so page controllers that call
  # main() on load can be checked alongside the pure modules. The plain
  # checkSyntax would reject every import/export as illegal in script mode.
  if output=$("$JSC" -e "
      var result = checkModuleSyntax(readFile('$file'));
      if (result && String(result).length) { print(result); throw new Error('syntax'); }
    " 2>&1); then
    printf "  ok    %s\n" "$file"
  else
    printf "  FAIL  %s\n" "$file"
    echo "$output" | sed 's/^/          /'
    FAILED=1
  fi
done < <(find assets/js -name '*.js' | sort)

# The service worker is a classic script, not a module, so it gets the plain
# parser. It also lives at the root, outside assets/js, to keep its scope wide
# enough to cover the whole site.
# checkSyntax takes a path, unlike checkModuleSyntax which takes source text.
if output=$("$JSC" -e "
    var result = checkSyntax('sw.js');
    if (result && String(result).length) { print(result); throw new Error('syntax'); }
  " 2>&1); then
  printf "  ok    %s\n" "sw.js"
else
  printf "  FAIL  %s\n" "sw.js"
  echo "$output" | sed 's/^/          /'
  FAILED=1
fi

echo
echo "== Static cross-checks =="
XCODE_BIN="/Applications/Xcode.app/Contents/Developer/usr/bin"
if python3 -c '' >/dev/null 2>&1; then PY=python3; else PY="$XCODE_BIN/python3"; fi
if ! "$PY" tools/test/static_check.py; then
  FAILED=1
fi
if ! "$PY" tools/test/check_paths.py; then
  FAILED=1
fi

echo
echo "== Served-site check =="
if ! ./tools/test/serve_check.sh; then
  FAILED=1
fi

echo
echo "== Logic tests =="
if ! "$JSC" -m tools/test/run-tests.js; then
  FAILED=1
fi

echo
echo "== Page smoke tests =="
# One process per page: a page module does its work at import time, and an ES
# module is only evaluated once per realm, so they cannot share one process.
for page in index day day4 plan stays money print about; do
  if ! "$JSC" -m tools/test/page_smoke.js -- "$page"; then
    FAILED=1
  fi
done

echo
if [ "$FAILED" != "0" ]; then
  echo "TESTS FAILED"
  exit 1
fi
echo "All checks passed."
