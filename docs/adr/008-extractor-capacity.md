# ADR-008: Archive Extractor Container Capacity

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** @rot1024

## Context

The archive-extractor container (see [ADR-001](./001-archive-extraction.md)) runs Phase B with up to `MaxConcurrency` goroutines, each performing a multipart upload of one extracted entry. Each goroutine holds a working buffer up to `multipartPartSize` (10 MiB) while a part is in flight.

The default Cloudflare Containers `lite` tier (1/16 vCPU, 256 MiB memory, 2 GB disk) cannot accommodate the worst case: `48 × 10 MiB ≈ 480 MiB` of buffers alone exceeds the memory limit. In production this manifested as a silent OOM kill of the container during PLATEAU CityGML extraction — the job reached `status=extracting`, `totalFiles=285`, and then stayed frozen with `fileCount=0` because the runtime killed the process before any goroutine logged an error or checkpoint.

Two bugs compounded the symptom and were fixed independently:

1. **Pointer aliasing in `putObjectMultipart`** ([cbdb3c0](../../container/archive-extractor/r2.go)) — `&partNumber` was reused across loop iterations, so `partNumber++` mutated every already-appended `CompletedPart`, causing `CompleteMultipartUpload` to ask R2 for non-existent part numbers (`InvalidPart`).
2. **Pre-allocated 10 MiB buffer per goroutine** — replaced with a `bytes.Buffer` that grows with actual payload, so small files (PLATEAU codelists, typically 1–5 KB) no longer reserve 10 MiB each.

Both fixes were necessary but insufficient: even with dynamic buffers, a single large entry can still claim ~10 MiB, and `lite`'s 256 MiB cannot absorb that across 48 concurrent goroutines.

## Decision

### Container instance type: `standard-2`

| Field | Value |
|---|---|
| `instance_type` | `standard-2` |
| vCPU | 1 |
| Memory | 6 GiB |
| Disk | 12 GB |
| `max_instances` | 20 |

### Extraction worker tuning

| Field | Value | Rationale |
|---|---|---|
| `MaxConcurrency` | 48 | Phase B fan-out within one container |
| `multipartPartSize` | 10 MiB | S3-spec minimum 5 MiB; 10 MiB balances part count vs. memory |
| `CheckpointEvery` | 100 | One job-status POST per 100 entries |

Peak memory under worst case: `48 × 10 MiB = 480 MiB` of part buffers + gzip pipes + S3 SDK + Go runtime ≈ 1 GiB. The 6 GiB tier leaves ~5 GiB headroom for OS, runtime growth, and future feature additions.

### Why standard-2 (not basic or standard-1)

| Tier | Memory | Headroom over 480 MiB worst case | Notes |
|---|---|---|---|
| `lite` | 256 MiB | **negative** — OOM | original default; broken |
| `basic` | 1 GiB | ~544 MiB | tight; one runaway goroutine can still OOM |
| `standard-1` | 4 GiB | ~3.5 GiB | enough for now but no room for growth |
| **`standard-2`** | **6 GiB** | **~5.5 GiB** | comfortable for current + future features |
| `standard-3` | 8 GiB | ~7.5 GiB | overkill given current workload |
| `standard-4` | 12 GiB | ~11.5 GiB | reserve for very large archives |

`standard-2` was chosen because it gives meaningful runway for upcoming features (parallel checksum, larger archives, derived-asset graph traversal) without paying for unused capacity. The vCPU bump from 1/16 → 1 also matters: Phase B is mostly I/O-bound, but `archive/zip` central-directory parsing and `gzip` compression run on CPU.

## Future Expansion Considerations

These are signals to revisit this ADR rather than fixed thresholds. Bumping memory/CPU/instances is cheap; bumping the wrong dimension first wastes spend.

### When to bump `instance_type`

| Signal | Likely cause | Next step |
|---|---|---|
| Job OOM-kills despite `fileCount` progress (i.e. mid-extraction) | Single entry exceeds 10 MiB compressed AND many entries in flight | `standard-3` (8 GiB) or raise `multipartPartSize` |
| Phase A list-time > 30s for archives < 1 GB | CPU-bound central-directory parsing | `standard-3` (2 vCPU) |
| gzip throughput is the bottleneck (CPU near 100%) | Compressible files dominate | `standard-3`/`standard-4` for more vCPU |
| Disk-full errors during extraction | We started writing temp files (shouldn't happen today) | `standard-4` (20 GB) — but investigate first; the design streams |

### When to bump `max_instances`

Current setting: 20 → up to 20 PLATEAU jobs (or other archives) can extract in parallel. Each consumes its own container instance.

| Signal | Next step |
|---|---|
| Queue backlog visibly growing during batch ingest | Bump to 50 |
| Customer-facing SLA on extraction start latency | Bump to 100, monitor account-wide budget |
| Burst of 100+ cities ingested at once (full-PLATEAU batch) | Pre-warm by scheduling; consider 200+ |

Cloudflare's account-wide budget is 6 TiB memory / 1,500 vCPU / 30 TB disk across all containers. At `standard-2` (1 vCPU/6 GiB), the hard ceiling is ~1,000 concurrent extractions before hitting vCPU first. We are nowhere near it.

### When to tune `MaxConcurrency` (env var `MAX_CONCURRENCY`)

This is per-container fan-out. Higher = faster per-job, more memory pressure.

| Signal | Adjustment |
|---|---|
| Per-job extraction is wall-clock-bound on small files | Raise to 96 if memory monitoring shows < 50% used |
| Per-job extraction has CPU pegged | Lower — context-switching tax |
| OOM kills observed | Lower OR upgrade tier |

`MAX_CONCURRENCY` is overridable via env, so a one-off heavy job (e.g. 500K-entry archive) can be tuned without redeploy if we expose the binding.

### Buffer optimization options (not adopted yet)

These can reduce memory further without bumping tiers, deferred until measured pressure:

- **`sync.Pool` of part buffers** — most goroutines run brief; pooling cuts GC churn. Adds complexity; only worth it if profiling shows GC pause hurts latency.
- **Streaming uploader with bounded buffering** — instead of `io.CopyN` into a `bytes.Buffer`, push fixed-size chunks straight to `UploadPart` from a ring buffer. Cuts peak memory per goroutine to ~64 KiB regardless of part size, but couples us tighter to S3 SDK internals.
- **Adaptive `multipartPartSize`** — for known-small entries (compressible XML, codelists), skip multipart entirely and use direct `PutObject`. Eliminates the 5 MiB minimum-part rule and slashes round trips for small files.

### Cost vs. capacity reference

Cloudflare bills containers by allocated resources × runtime. Rough rule of thumb (subject to plan):

| Tier | Relative $/runtime-hour |
|---|---|
| `lite` | 1× |
| `basic` | ~4× |
| `standard-1` | ~10× |
| `standard-2` | ~16× |
| `standard-4` | ~50× |

Extractor runs are short (seconds to minutes), so absolute cost per extraction is small even at `standard-2`. The lever to watch is `max_instances` × runtime when running concurrent batch ingests.

### Operational signals to watch

- **Job `fileCount` stalls** while `status=extracting` — primary OOM symptom. Container logs in CF Dashboard should show `Container started` followed by silence.
- **`retryCount` rising on extraction jobs** — extraction is failing and being retried; check container logs.
- **`status=extracting` jobs older than the configured stuck-threshold** — `worker/cleanup` reconciles these (see [cleanup ADR work](../../worker/cleanup/)).
- **`updateJobStatus` POST gaps > 60s mid-extraction** — Phase B not making progress; suspect deadlock or upstream R2 issue.

## Consequences

- **Reliability**: PLATEAU CityGML and similar archives (small-file-heavy with gzip compressible content) now extract without OOM.
- **Cost**: ~16× the container compute price vs. `lite`. Acceptable given extractor runs are short and infrequent relative to other workloads.
- **Tunability**: `MaxConcurrency` and `max_instances` remain the primary knobs; tier upgrade is the escape hatch when those aren't enough.
- **Documentation**: This ADR is the contract — comments in `main.go` and `wrangler.toml` reference it so capacity changes get reviewed against the same rationale.
