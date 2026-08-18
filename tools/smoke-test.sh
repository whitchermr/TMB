#!/usr/bin/env bash
#
# Load every page in a headless Chromium-family browser and fail on any
# JavaScript error. Map tiles are deliberately unreachable so a run never waits
# on the network; the pages must degrade cleanly without them.
#
#   ./tools/smoke-test.sh [port]

set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${1:-8123}"
PAGES=(index.html day.html plan.html stays.html money.html about.html)

BROWSER=""
for candidate in \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [ -x "$candidate" ] && BROWSER="$candidate" && break
done

if [ -z "$BROWSER" ]; then
  echo "No Chromium-family browser found; skipping smoke test." >&2
  exit 0
fi

XCODE_BIN="/Applications/Xcode.app/Contents/Developer/usr/bin"
if python3 -c '' >/dev/null 2>&1; then PY=python3; else PY="$XCODE_BIN/python3"; fi

if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/index.html"; then
  echo "Starting a server on port $PORT..."
  "$PY" -m http.server "$PORT" >/tmp/tmb-smoke-server.log 2>&1 &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  sleep 1.5
fi

FAILED=0

for page in "${PAGES[@]}"; do
  profile="$(mktemp -d)"
  log="$(mktemp)"
  dom="$(mktemp)"

  # MAP * ~NOTFOUND blocks every external host (tiles) while EXCLUDE keeps the
  # local server reachable, which makes the run fast and deterministic.
  "$BROWSER" \
    --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$profile" \
    --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" \
    --enable-logging=stderr --log-level=0 \
    --virtual-time-budget=6000 \
    --dump-dom "http://127.0.0.1:$PORT/$page" >"$dom" 2>"$log" &
  browser_pid=$!

  # Hard stop: headless Chromium occasionally ignores the virtual time budget.
  ( sleep 30; kill -9 $browser_pid 2>/dev/null ) &
  killer=$!
  wait $browser_pid 2>/dev/null
  kill $killer 2>/dev/null

  errors=$(grep -iE "SEVERE|Uncaught|ERROR:CONSOLE" "$log" \
    | grep -viE "ERR_NAME_NOT_RESOLVED|Failed to load resource|net::|tile|favicon" || true)
  load_error=$(grep -c "Could not load trip data" "$dom" || true)
  rendered=$(grep -c "stat__value" "$dom" || true)

  status="ok"
  if [ -n "$errors" ]; then status="js-error"; FAILED=1; fi
  if [ "$load_error" != "0" ]; then status="data-load-failed"; FAILED=1; fi
  if [ "$rendered" = "0" ] && [ "$page" != "about.html" ]; then
    status="nothing-rendered"; FAILED=1
  fi

  printf "%-14s %-20s (%s stat blocks)\n" "$page" "$status" "$rendered"
  if [ -n "$errors" ]; then echo "$errors" | head -12 | sed 's/^/    /'; fi

  rm -rf "$profile" "$log" "$dom"
done

if [ "$FAILED" != "0" ]; then
  echo
  echo "Smoke test FAILED."
  exit 1
fi

echo
echo "All pages loaded without JavaScript errors."
