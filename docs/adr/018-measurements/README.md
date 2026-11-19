# ADR-018 measurements

Scripts behind the "Measurement results" section of
[ADR-018](../018-servable-on-arrival.md). They read public URLs with HTTP
`Range` requests or run against local servers only. Run Python with `-I`
from a working directory of your own, because the corpus scripts write
into `./out/`.

## Gzip delivery (measurement 1)

`gzip-delivery/harness.mjs` serves test bodies with
`Content-Encoding: gzip` and checks in Chromium, Firefox and WebKit
(Playwright) and in Node `fetch` that the SHA-256 of the decoded body
matches the plaintext. The cases cover one member, BGZF, plain multi-member
streams, range cuts, and full-flush segments joined into one member with
`crc32_combine`.

```sh
npm i playwright && npx playwright install chromium firefox webkit
node harness.mjs                                  # direct
PORT=18731 SERVE_ONLY=1 node harness.mjs &        # origin for the Worker lane
(cd worker && npx wrangler dev --local --port 18732 --var ORIGIN:http://127.0.0.1:18731)
WORKER=http://localhost:18732 node harness.mjs    # through workerd
./clients.sh                                      # curl, wget, Python against the origin
```

`ONLY=chromium,firefox` limits the browsers. `CHROME=<path>` points
Chromium at an existing binary. The Worker's `/decode/<case>` route pipes
the body through `DecompressionStream("gzip")`.

## Corpus (measurements 2 to 5)

| Script | Measures |
|---|---|
| `list_resources.py` | PLATEAU zip and 7z resource URLs from geospatial.jp CKAN (`out/plateau_names.json` is the `package_list` result filtered to `plateau*`) |
| `general_zip_sources.py` | A seeded general zip corpus (Natural Earth, TIGER/Line, PyPI, Maven) |
| `zip_tail.py`, `zip_stats.py` | EOCD, Zip64 and central directory of each zip by `Range`, then percentiles |
| `sevenz_probe.py`, `gh_7z_sources.sh`, `other_7z_sources.py` | 7z header from the signature header and the file tail, folders and streams per folder |
| `tiff_sources.py`, `tiff_probe.py`, `tiff_stats.py`, `ortho_in_zip_tiff.py` | TIFF IFD0 tags 322/323 (tiles) or 273/278 (strips) |
| `m5_gml_distances.py`, `deflate_dist.py` | LZ77 match distances of deflate entries, with a pure-Python inflate |

Each script reads its input list and output path from `sys.argv`; the
order is in the script's last lines.
