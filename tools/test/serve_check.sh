#!/usr/bin/env bash
#
# Serve the site the way GitHub Pages does and confirm every page and data
# file returns 200. Pages publishes a project repo under /<repo>/, so the site
# is served from a subdirectory here to catch anything that only works at the
# domain root.
#
#   ./tools/test/serve_check.sh

set -uo pipefail

cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

XCODE_BIN="/Applications/Xcode.app/Contents/Developer/usr/bin"
if python3 -c '' >/dev/null 2>&1; then PY=python3; else PY="$XCODE_BIN/python3"; fi

PORT=${PORT:-8765}
REPO_PATH=${REPO_PATH:-TMB}

# Mirror the repo into <tmp>/<repo>/ so requests are served from a subpath.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ln -s "$ROOT" "$STAGE/$REPO_PATH"

set +m # no "Terminated" job-control notice when the server is killed
"$PY" -m http.server "$PORT" --directory "$STAGE" >/dev/null 2>&1 &
SERVER=$!
trap '{ kill $SERVER; wait $SERVER; } 2>/dev/null; rm -rf "$STAGE"' EXIT

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/$REPO_PATH/index.html"; then break; fi
  sleep 0.25
done

PATHS=(
  "index.html" "day.html?d=1" "day.html?d=4" "plan.html" "stays.html"
  "money.html" "about.html" ".nojekyll"
  "assets/css/base.css" "assets/css/components.css" "assets/css/print.css"
  "assets/vendor/leaflet/leaflet.js" "assets/vendor/leaflet/leaflet.css"
  "assets/vendor/leaflet/images/marker-icon.png"
  "assets/vendor/leaflet/images/marker-icon-2x.png"
  "assets/vendor/leaflet/images/marker-shadow.png"
  "assets/vendor/leaflet/images/layers.png"
  "assets/js/core/store.js" "assets/js/core/units.js" "assets/js/core/geo.js"
  "assets/js/core/sun.js" "assets/js/core/schedule.js" "assets/js/core/money.js"
  "assets/js/ui/nav.js" "assets/js/ui/map.js" "assets/js/ui/elevation.js"
  "assets/js/pages/index.js" "assets/js/pages/day.js" "assets/js/pages/plan.js"
  "assets/js/pages/stays.js" "assets/js/pages/money.js" "assets/js/pages/about.js"
  "data/settings.json" "data/itinerary.json" "data/waypoints.json"
  "data/stays.json" "data/people.json" "data/expenses.json" "data/rates.json"
  "data/route/anchors.json" "data/route/legs/index.json"
  "data/route/tmb-main.geojson" "data/route/variants/index.json"
  "sw.js" "manifest.webmanifest"
)

for day in 01 02 03 04 05 06 07; do
  PATHS+=("data/route/legs/day-$day-shortcut.json" "data/route/legs/day-$day-classic.json")
done
PATHS+=("data/route/legs/day-06-arpette.json")

FAILED=0
COUNT=0
for path in "${PATHS[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/$REPO_PATH/$path")
  COUNT=$((COUNT + 1))
  if [ "$code" != "200" ]; then
    printf "  FAIL  %s  %s\n" "$code" "$path"
    FAILED=$((FAILED + 1))
  fi
done

# Content-type sanity: modules must be served as JavaScript or the browser
# refuses them, and JSON must not come back as HTML from an error page.
js_type=$(curl -s -o /dev/null -w "%{content_type}" "http://127.0.0.1:$PORT/$REPO_PATH/assets/js/core/store.js")
json_type=$(curl -s -o /dev/null -w "%{content_type}" "http://127.0.0.1:$PORT/$REPO_PATH/data/settings.json")
case "$js_type" in
  *javascript*) ;;
  *) printf "  FAIL  store.js served as '%s'\n" "$js_type"; FAILED=$((FAILED + 1));;
esac
case "$json_type" in
  *json*) ;;
  *) printf "  FAIL  settings.json served as '%s'\n" "$json_type"; FAILED=$((FAILED + 1));;
esac

if [ "$FAILED" != "0" ]; then
  echo "FAIL serve_check: $FAILED of $COUNT request(s) failed"
  exit 1
fi
echo "PASS serve_check: $COUNT requests OK from /$REPO_PATH/ subpath"
