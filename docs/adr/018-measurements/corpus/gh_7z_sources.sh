#!/bin/sh
# collect .7z release assets from GitHub repos found by topic searches
for t in portable windows emulator game-engine gis opensource tools mapping 3d-models; do
  gh api -X GET search/repositories -f q="topic:$t stars:>100" -f sort=stars -f per_page=40 --jq '.items[].full_name' 2>/dev/null
done | sort -u | while read r; do
  gh api "repos/$r/releases?per_page=3" --jq '.[].assets[] | select(.name|test("\\.7z$")) | .browser_download_url' 2>/dev/null | head -2
done
