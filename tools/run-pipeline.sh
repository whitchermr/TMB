#!/usr/bin/env bash
#
# Regenerate all route data from OpenStreetMap and the elevation services.
#
#   ./tools/run-pipeline.sh              full run
#   ./tools/run-pipeline.sh --offline    reuse the cached Overpass payload
#
# Only needed when the route definition changes. The committed JSON under data/
# is what the site actually reads, so day-to-day work never runs this.

set -euo pipefail

cd "$(dirname "$0")/.."

# On macOS the /usr/bin/python3 shim refuses to run until the Xcode licence has
# been accepted. The real interpreter inside Xcode works regardless, so prefer
# whichever is actually functional rather than failing with a confusing error.
XCODE_BIN="/Applications/Xcode.app/Contents/Developer/usr/bin"
if python3 -c '' >/dev/null 2>&1; then
  PY=python3
elif [ -x "$XCODE_BIN/python3" ] && "$XCODE_BIN/python3" -c '' >/dev/null 2>&1; then
  PY="$XCODE_BIN/python3"
  echo "note: using $PY (run 'sudo xcodebuild -license accept' to fix /usr/bin/python3)"
else
  echo "error: no working python3 found." >&2
  echo "       try: sudo xcodebuild -license accept" >&2
  exit 1
fi

OFFLINE=""
if [ "${1:-}" = "--offline" ]; then
  OFFLINE="--offline"
fi

echo "=== 1/3 Fetching route geometry from OpenStreetMap ==="
$PY tools/fetch_route.py $OFFLINE

echo
echo "=== 2/3 Splitting the loop into per-day legs ==="
$PY tools/split_legs.py

echo
echo "=== 3/3 Sampling elevation and computing stats ==="
$PY tools/fetch_elevation.py

echo
echo "Pipeline complete. Review docs/data-notes.md, then commit data/."
