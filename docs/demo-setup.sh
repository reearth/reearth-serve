#!/usr/bin/env bash
# Prepare demo files and upload assets for asciinema recording.
#
# Usage: REEARTH_SERVE_ENDPOINT=https://serve.reearth.land bash docs/demo-setup.sh
set -euo pipefail

: "${REEARTH_SERVE_ENDPOINT:?Set REEARTH_SERVE_ENDPOINT}"

# Create demo files
echo 'Hello, Re:Earth Serve!' > /tmp/hello.txt
mkdir -p /tmp/my-tiles
echo '{"asset":"tileset","version":"1.0"}' > /tmp/my-tiles/tileset.json
echo '{"type":"Feature","id":1}' > /tmp/my-tiles/feature1.geojson
echo '{"type":"Feature","id":2}' > /tmp/my-tiles/feature2.geojson
cd /tmp/my-tiles && zip -r /tmp/my-tiles.zip . > /dev/null && cd - > /dev/null

# Upload text file and capture asset ID
TEXT_RESULT=$(reearth-serve --json upload /tmp/hello.txt)
TEXT_ASSET_ID=$(echo "$TEXT_RESULT" | jq -r '.asset.id')
echo "Text asset: $TEXT_ASSET_ID"

# Upload ZIP and capture asset ID
ZIP_RESULT=$(reearth-serve --json upload /tmp/my-tiles.zip)
ZIP_ASSET_ID=$(echo "$ZIP_RESULT" | jq -r '.asset.id')
echo "ZIP asset: $ZIP_ASSET_ID"

# Wait for extraction to complete
echo -n "Waiting for extraction"
for i in $(seq 1 30); do
  sleep 3
  S=$(reearth-serve --json job show "$ZIP_ASSET_ID" | jq -r .status)
  echo -n "."
  [ "$S" = "completed" ] && break
done
echo " done!"

echo "Setup complete. Now record with:"
echo "  REEARTH_SERVE_ENDPOINT=$REEARTH_SERVE_ENDPOINT asciinema rec docs/demo.cast"
