#!/bin/bash
O=${1:-http://127.0.0.1:18731}
for c in bgzf-64k two-members-tiny plain-members-1m; do
  exp=$(curl -s $O/raw/$c | gunzip | wc -c | tr -d ' ')
  py=$(python3 -I -c "import requests,sys;print(len(requests.get(sys.argv[1]).content))" $O/$c)
  pyurllib=$(python3 -I -c "import urllib.request,gzip,sys;r=urllib.request.urlopen(urllib.request.Request(sys.argv[1],headers={'Accept-Encoding':'gzip'}));print(len(gzip.decompress(r.read())))" $O/$c)
  wg=$(wget -q --compression=auto -O - $O/$c 2>/dev/null | wc -c | tr -d ' ')
  gd=$(gdalinfo --version | cut -d, -f1)
  vsi=$(CPL_CURL_GZIP=YES python3 -I - "$O/$c" <<'PY' 2>/dev/null || echo na
import sys
from osgeo import gdal
f=gdal.VSIFOpenL('/vsicurl/'+sys.argv[1],'rb'); n=0
while True:
  b=gdal.VSIFReadL(1,1<<20,f)
  if not b: break
  n+=len(b)
print(n)
PY
)
  echo "$c expect=$exp requests=$py urllib+gzip=$pyurllib wget=$wg vsicurl=$vsi"
done
