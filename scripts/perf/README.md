# Performance Tests

End-to-end performance tests for `reearth-serve`, focused on the **upload + archive-extraction** path using real PLATEAU CityGML zip files as the data source.

The goal is to determine how large a `.zip` the service can accept and fully extract — the deciding factor for whether PLATEAU-style workloads fit on top of `reearth-serve`.

## What it does

1. **`fetch-fixtures.ts`** — Walks the [PLATEAU datacatalog](https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets) (`.citygml` array, ~305 entries), issues HEAD requests to each `url`, and writes a size-sorted JSON list with bucket labels.
2. **`run-anon.ts`** — For each selected fixture: streams the source zip via HTTP Range requests directly into a presigned upload session (single PUT or S3 multipart), then polls the asset until extraction reaches `ready` / `failed` / timeout. Records phase timings and writes results as JSON Lines.

Anonymous (demo) mode only — uses `X-Session-Id` headers, no authentication.

## Files

| File | Purpose |
|---|---|
| `fetch-fixtures.ts` | Build size-sorted fixture list |
| `run-anon.ts` | Run upload + extraction scenarios |
| `fixtures.json` | (generated) sorted fixture list |
| `results.jsonl` | (generated) per-fixture run records |

## Size buckets

| Bucket | Upper bound | Notes |
|---|---|---|
| XS  | 50 MB  | API-direct PUT path, baseline |
| S   | 300 MB | Multipart boundary (CLI threshold is 100 MB) |
| M   | 1 GB   | Normal multipart |
| L   | 5 GB   | Multiple checkpoints expected |
| XL  | 15 GB  | Container timeout / resume territory |
| XXL | 50 GB  | ADR-001's stated upper bound |
| XXXL | ∞ | Beyond documented support |

## Prerequisites

```bash
npm install   # tsx is a devDependency
```

No credentials are needed — runs against the production endpoint in demo mode.

## Step 1: Fetch fixtures

```bash
npx tsx scripts/perf/fetch-fixtures.ts --out scripts/perf/fixtures.json
```

Options:

| Flag | Default | Purpose |
|---|---|---|
| `--out PATH` | `scripts/perf/fixtures.json` | Output path |
| `--year YYYY` | _all_ | Filter by survey year |
| `--pref CODE` | _all_ | Filter by pref code (e.g. `13` = Tokyo) |

The script HEAD-probes ~305 URLs at concurrency 16 (~30 sec). Entries without a `Content-Length` header are dropped with a warning. The resulting JSON is sorted ascending by size.

Each fixture looks like:

```json
{
  "id": "01100",
  "city": "札幌市",
  "pref": "北海道",
  "year": 2020,
  "url": "https://assets.cms.plateau.reearth.io/...zip",
  "size": 2718857710,
  "bucket": "L"
}
```

## Step 2: Run scenarios

```bash
npx tsx scripts/perf/run-anon.ts \
  --endpoint https://serve.reearth.land \
  --fixtures scripts/perf/fixtures.json \
  --buckets XS,S \
  --limit 5 \
  --out scripts/perf/results.jsonl
```

### Selection flags

| Flag | Example | Effect |
|---|---|---|
| `--ids` | `--ids 01100,13101` | Pick by city code |
| `--buckets` | `--buckets XS,S,M` | Filter by bucket |
| `--max-size` | `--max-size 2GB` | Skip larger fixtures |
| `--min-size` | `--min-size 100MB` | Skip smaller fixtures |
| `--pref` | `--pref 13` | Filter by pref code prefix |
| `--limit` | `--limit 3` | Cap fixture count |

### Behavior flags

| Flag | Default | Purpose |
|---|---|---|
| `--endpoint` | `https://serve.reearth.land` | Target API |
| `--concurrency` | `1` | Fixtures uploaded in parallel |
| `--part-concurrency` | `3` | Multipart parts in flight per fixture |
| `--part-size` | `100MB` | Multipart part size |
| `--poll-interval` | `5` (sec) | Asset status poll cadence |
| `--poll-timeout` | `7200` (sec) | Per-fixture extraction timeout |
| `--keep` | _off_ | Don't `DELETE` the asset after run |
| `--skip-extraction` | _off_ | Upload-only bench (no extraction) |
| `--dry-run` | _off_ | Print plan and exit |

### What you'll see on stderr

```
[01100 L 2.53GB] upload ok init=0.4s xfer=1m22s (31.4MB/s, multipart×26) complete=0.6s assetId=abc...
  [01100] -> extracting files=152
  [01100] -> extracting files=420
  [01100] -> ready files=812
--- summary ---
ok=1 fail=0 total=1 elapsed=3m17s
```

### Output (`results.jsonl`)

One JSON object per line:

```json
{
  "runId": "uuid",
  "fixture": { "id": "01100", "bucket": "L", "size": ... },
  "sessionId": "uuid",
  "startedAt": "2026-05-12T...",
  "finishedAt": "2026-05-12T...",
  "upload": {
    "mode": "multipart",
    "partCount": 26,
    "sizeBytes": 2718857710,
    "initMs": 412,
    "transferMs": 82340,
    "completeMs": 590,
    "throughputMBps": 31.42
  },
  "extraction": {
    "pollMs": 116000,
    "transitions": [
      { "at": "...", "status": "extracting", "fileCount": 152 },
      { "at": "...", "status": "ready", "fileCount": 812 }
    ],
    "finalStatus": "ready",
    "fileCount": 812,
    "extractedSize": 6543210000,
    "archiveFormat": "zip"
  },
  "asset": { "id": "abc...", "jobId": "abc..." },
  "ok": true
}
```

## Recommended progression

Don't jump straight to the 30 GB zips — build confidence in steps.

```bash
# S0  smoke (~50 MB)
npx tsx scripts/perf/run-anon.ts --buckets XS --limit 3

# S1  multipart boundary
npx tsx scripts/perf/run-anon.ts --buckets S --limit 5

# S2  normal operation
npx tsx scripts/perf/run-anon.ts --buckets M --limit 5

# S3  large single
npx tsx scripts/perf/run-anon.ts --buckets L --limit 1 --poll-timeout 1800

# S4  large parallel (watch container max_instances)
npx tsx scripts/perf/run-anon.ts --buckets L --limit 3 --concurrency 3

# S5  ceiling exploration
npx tsx scripts/perf/run-anon.ts --buckets XL,XXL --limit 1 --poll-timeout 7200 --keep
```

## How upload streaming works

For multipart uploads the script does **not** download the source zip to disk or memory. For each part `i`:

```
GET source URL, Range: bytes=<i*partSize>-<(i+1)*partSize-1>
  → Uint8Array (≤ partSize bytes)
PUT presigned part URL
  → ETag
```

Concurrency is bounded by `--part-concurrency`, so peak memory ≈ `partSize × partConcurrency` (default ~300 MB).

For files ≤ 100 MB a single Range GET fetches the whole file followed by one PUT.

## Cleanup

By default, each fixture's asset is `DELETE`d after the run regardless of outcome (success, failure, or polling timeout). Pass `--keep` to preserve assets for inspection — be mindful of R2 cost when keeping multi-GB archives.

If a run is interrupted mid-flight, leftover assets remain. The service's background cleanup job (`worker/cleanup`) should reconcile them eventually; otherwise enumerate via `GET /api/v1/assets` with your `X-Session-Id` and delete manually.

## Analyzing results

`results.jsonl` is plain JSON Lines — pipe through `jq`:

```bash
# throughput per bucket
jq -s 'group_by(.fixture.bucket) | map({
  bucket: .[0].fixture.bucket,
  n: length,
  ok: map(select(.ok)) | length,
  avg_mbps: (map(.upload.throughputMBps // 0) | add / length),
  avg_extract_s: (map(.extraction.pollMs // 0) | add / length / 1000)
})' scripts/perf/results.jsonl

# extraction time vs file count
jq -r '[.fixture.size, .extraction.fileCount, .extraction.pollMs] | @tsv' \
  scripts/perf/results.jsonl
```

## Caveats

- The PLATEAU source bucket (`assets.cms.plateau.reearth.io`) is hosted on GCS. Range requests are supported but throughput depends on the source — multi-GB transfers may pull substantial egress.
- Running against production affects real D1 / R2 / container usage. Prefer off-hours for L/XL scenarios.
- `extracting` status reports a running `fileCount` so progress is observable mid-flight; some intermediate transitions may be skipped between polls if extraction is fast.
- The script does not currently issue load against the **file-serving** path (`/files/:id/...`). For end-to-end PLATEAU validation, add a follow-up step that GETs sample tileset.json / b3dm files from extracted archives.
