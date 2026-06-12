# ADR-010: Large Archive Extraction Hardening (200 GB-class ZIPs)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** @rot1024

## Context

End-to-end testing with PLATEAU CityGML archives (0.1 GiB → 250.8 GiB
hamamatsu-shi) against production exposed a chain of defects that each capped
the maximum practical archive size. The pipeline of ADR-001/ADR-008 was sound
for archives that finish within minutes, but everything beyond ~5 minutes of
wall-clock work hit a different failure.

Observed failures, in the order they were found:

1. **Presigned uploads always 404ed at complete** (demo mode). The session
   middleware mints a fresh session ID for any X-Session-Id it didn't issue,
   but the CLI never adopted the server-issued ID, so create and complete ran
   under two different sessions and the ownership check failed.
2. **Extraction silently died at 5 minutes.** The extractor container receives
   no inbound requests after start, so `@cloudflare/containers`' activity
   timeout (`sleepAfter = "5m"`) stopped a healthy container mid-extraction.
   Jobs sat in `running` forever; no log ever reached R2.
3. **Extraction throughput was <1 MiB/s.** `zip.File.Open` reads through the
   `io.ReaderAt`, and flate consumes it in ~4 KiB chunks — with `R2ReaderAt`
   every chunk became one HTTPS Range request. A 100 MB zip took ~25 minutes;
   a 200 GB zip would effectively never finish.
4. **One-hour expiries killed every long-running flow**: presigned URLs and
   the KV upload session (`min(ASSET_TTL, 1h)`), the anonymous session itself
   (1 h KV TTL), and the demo asset TTL (cleanup could delete an asset whose
   extraction was still running; the container aborts at its next existence
   check).
5. **Multi-GB entries failed with `unexpected EOF` and were silently
   skipped.** An entry's ranged GET stays open for as long as the
   decompress+reupload pipeline runs; R2 occasionally drops those long-lived
   connections. Failed entries were recorded once in the R2 log and the job
   still reported a clean `completed`.
6. **Gzip-stored files were served as binary garbage** to clients whose
   `Accept-Encoding` didn't surface in the Worker: the pass-through branch set
   `Content-Encoding: gzip` but left `encodeBody` at `"automatic"`, so the
   runtime treated the body as plain data and the edge stripped the header.

## Decision

### Container lifetime: renew while the process is alive

`ArchiveExtractorContainer.onActivityExpired` now probes the Go process's
`/health` endpoint instead of stopping unconditionally. Alive → renew the
activity timeout; gone (the process exits by itself when extraction completes
or fails) → stop. A 24 h hard ceiling (matching the cleanup cron's stuck-job
threshold) prevents a wedged process from being renewed forever.

Alternatives considered: a very long `sleepAfter` (keeps idle containers
billed for hours), or routing container→Worker status updates through the DO
to count as activity (checkpoint gaps between huge entries can still exceed
any fixed window).

### ZIP entries: one ranged GET per entry, local decompression

The Central Directory already provides each entry's data offset and compressed
size, so `ZipExtractor.ExtractEntry` fetches the whole compressed span with a
single ranged GET and decompresses locally (store/deflate). Exotic methods or
missing offsets fall back to `zip.File.Open`. This trades the per-entry CRC32
check for the manifest MD5 the worker already computes. Throughput went from
<1 MiB/s to ~50 MiB/s of extracted output on `standard-2`.

### Per-entry retries + partial-failure reporting

`extractAndUpload` retries each entry up to 3 times with backoff. Entries that
still fail are attached to the final `completed` status update as an error
summary (`N of M entries failed; first: …`) so partial failures are visible on
the job instead of only in the R2 log.

### Expiry windows scale with intent

- **Upload sessions / presigned URLs**: expiry scales with declared size
  (size ÷ 2 MiB/s, clamped to 1–24 h). R2 allows up to 7 days.
- **Anonymous sessions**: own 7-day TTL, decoupled from `ASSET_TTL_SECONDS` —
  sessions are identity, not content.
- **Demo assets under extraction**: each container status update pushes
  `expiresAt` forward (`max(current, now + TTL)`); completion restarts the
  window so the extracted asset is usable for a full TTL.
- **Cleanup cron**: skips assets whose extraction job is `pending`/`running`;
  a genuinely hung job is failed by the stuck-job path first, after which
  cleanup proceeds.

### Serving pre-compressed bodies

The gzip pass-through response sets `encodeBody: "manual"` so the runtime
passes the already-gzipped body through (and transcodes for clients that don't
accept gzip).

### CLI

- Adopts the server-issued `X-Session-Id` from every API response (required
  for any multi-request flow in demo mode).
- Files >1 GiB upload via multipart streamed from disk (`fs.read` per part)
  instead of `readFileSync`, which capped at Node's ~2 GiB buffer limit and
  held the whole file in memory.

## Results (production, serve.reearth.land)

| Archive | Zip size | Extracted | Outcome |
|---|---|---|---|
| koga-shi 2024 | 0.10 GiB | 570 files / ~1 GB | completed |
| fukushima-shi 2025 | 1.0 GiB | — | completed (pre-perf-fix image, slow) |
| tokushima-shi 2023 | 5.8 GiB | — | completed (pre-perf-fix image, slow) |
| higashiizu-cho 2023 | 12.9 GiB | 379 files / 159.2 GB | completed in ~57 min (3 DEM entries lost to EOF — motivated the retry fix) |
| izunokuni-shi 2023 | 20.5 GiB | 595 files | completed |
| hamamatsu-shi 2023 | **250.8 GiB** | — | end-to-end test of this ADR's changes |

## Consequences

- Long extractions keep their container alive indefinitely while making
  progress; the 24 h ceiling plus the stuck-job cron bound the worst case.
- Per-entry CRC32 verification is no longer performed on the fast path;
  integrity relies on the manifest MD5 and R2 upload checksums.
- Anonymous sessions persist 7 days, so demo-mode users keep access to their
  assets/jobs across long uploads (and across CLI invocations).
- A `completed` job may carry an `error` field describing partially failed
  entries; clients should surface it.

## Follow-up (2026-06-12): capacity-overflow handling

Concurrency testing planning exposed how jobs behave when all extractor
container slots (`max_instances = 20`, account ceiling ~25 at `standard-4`)
are busy:

- `CloudflareContainerLauncher` ignored `startExtraction`'s return value, so
  a capacity-exhausted start looked like success and the message was acked.
- The queue consumer retried launch failures immediately; `max_retries = 3`
  was exhausted within seconds and the message dead-lettered.
- `listRetriable` picked up `pending` jobs unconditionally, so the cron
  re-enqueued a capacity-waiting job every tick, burning one of its 5
  job-retries each pass (~50 minutes to permanent failure).

Fixes: the launcher now throws on a non-`started` result; the queue consumer
retries with exponential backoff (60s → 20min cap, `max_retries = 20`,
covering ~5h of full-capacity wait) and touches the job's `updated_at` on
each failed attempt; `listRetriable` gates `pending` behind the same stuck
threshold as `running`, so the cron only takes over after the queue stops
touching the job (DLQ). Layering: queue handles capacity waits without
spending job retries; the cron's `MAX_RETRIES` budget only meters actual
container deaths.
