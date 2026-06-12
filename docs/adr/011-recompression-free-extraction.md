# ADR-011: Recompression-Free Extraction (gzip transmux) and CPU Capacity

- **Status:** Accepted
- **Date:** 2026-06-12
- **Deciders:** @rot1024

## Context

After ADR-010, a 250.8 GiB PLATEAU CityGML zip (hamamatsu-shi, 8,496 entries,
~11× compression ratio) extracted **correctly** but slowly: measured Phase B
throughput was ~37 MiB/s of uncompressed data, projecting to ~30+ hours per
archive. The reference implementation (`reearth/gcs-unzip`) finishes
comparable archives in a few hours on multi-core Cloud Run instances.

Profiling by arithmetic: the per-entry pipeline was
`flate decode (~150 MB/s/core) → MD5 (~600 MB/s/core) → gzip re-encode at the
default level (~40 MB/s/core on XML) → PUT`, all sharing the single vCPU of
the `standard-2` instance. The harmonic sum is ~30–37 MB/s — exactly what we
observed. `MaxConcurrency = 48` does not help when one core is saturated;
network was idle (~3–4 MiB/s of compressed bytes each way).

The gcs-unzip approach (download the whole zip to local disk, extract, fan
out uploads) is not portable here: `standard-4` tops out at 20 GB disk, and
the archives are 10× that.

## Decision

Three changes, multiplicative in effect:

### 1. Transmux deflate zip entries into gzip objects (no re-encoding)

A gzip member is `10-byte header + raw DEFLATE stream + CRC-32/ISIZE trailer`
(RFC 1952). A zip entry compressed with method 8 contains *the same raw
DEFLATE stream*, and the zip central directory already records the CRC-32 and
uncompressed size the trailer needs. So for every entry that we would
gzip-recompress anyway (`ShouldCompress` — includes `.gml`), the worker now:

- range-GETs the entry's compressed bytes (as before, one GET per entry),
- streams them to R2 verbatim between a fixed header and a computed trailer
  (`RawDeflateExtractor` / `transmuxUpload`),
- tees the same bytes through a side-channel `flate → MD5 + CRC-32` decode to
  keep the manifest MD5 (computed over uncompressed content, unchanged
  semantics) and to verify the central-directory CRC — replacing the CRC
  check that ADR-010's fast path gave up.

Data moved per entry drops from `compressed + 2×uncompressed` of CPU work to
a network copy of the compressed bytes plus one decode pass. Stored-method or
exotic entries fall back to the old decompress path automatically.

### 2. klauspost/compress for the remaining encode/decode

The side-channel decode and every remaining `GzipReader` /
`ZipExtractor.ExtractEntry` flate path now use `github.com/klauspost/compress`
(same library gcs-unzip uses; ~2× faster decode, much faster encode).
`GzipReader` additionally drops to `BestSpeed` — it only runs for entries
that cannot be transmuxed (stored-method zip entries, tar/tar.gz), where a
few percent of extra object size is a fine trade for several-fold encode
speed.

### 3. `standard-2` → `standard-4` (1 → 4 vCPU, 6 → 12 GiB)

With recompression gone, the bottleneck moves to the decode-for-checksum
stream (~200 MB/s/core with klauspost). 4 vCPUs put the ceiling at ~800 MB/s
of uncompressed verification — beyond it, the compressed-byte network copy
dominates. Since 2025-10 Cloudflare bills container CPU on **utilization**,
not allocation, so idle vCPUs cost nothing; the fixed overhead is the
provisioned memory (12 GiB at $0.0000025/GiB-s ≈ $0.11/h) and disk
($0.005/h), which the shorter wall-clock more than pays back.

## Consequences

- Expected throughput for PLATEAU-class archives: bounded by
  `min(network copy of compressed bytes, ~800 MB/s decode)` — a 250 GiB zip
  should finish in roughly an hour instead of ~30.
- Transmuxed objects are byte-for-byte the archive's own deflate stream;
  integrity is checked against the central-directory CRC-32 *and* the
  manifest MD5, both computed from the same single decode pass.
- Object sizes for transmuxed entries match the zip's compression level
  (typically deflate level 6 — slightly *smaller* than our old default-level
  re-encode of the same data, and smaller than BestSpeed output).
- The gzip header hardcodes mtime=0/OS=unknown; clients see identical
  semantics to the previous re-encoded objects.
- In-flight jobs resume seamlessly: the transmux path takes its CRC-32 from
  the in-memory central directory, not from the persisted
  `_entry_list.jsonl`, so checkpoints written by older versions stay valid.
- Cost per extraction is dominated by R2 storage of the output, not compute;
  see the capacity notes in ADR-008 (instance-type table superseded by this
  ADR's choice of `standard-4`).
