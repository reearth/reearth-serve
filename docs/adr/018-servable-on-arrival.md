# ADR-018: Servable on Arrival — Derived Artifacts Never Gate Correctness

- **Status:** Proposed
- **Date:** 2026-11-09
- **Deciders:** @rot1024
- **Related:** ADR-001 (archive extraction), ADR-009 (thumbnails),
  ADR-010 (large archive hardening), ADR-011 (gzip transmux),
  ADR-013 (static site hosting), ADR-015 (engine boundary, built-in
  derivations), ADR-017 (content-addressed blobs, upload finalisation)

## Context

An archive upload today is unusable until its extraction job finishes.
`GET /api/v1/assets/:id/files` streams `_manifest.jsonl`, and that file
exists only after Phase C of ADR-001; before then the listing is empty and
`/files/:id/<path>` has no object to serve. The asset is either `ready` or
it is not. For a 250 GiB PLATEAU zip that state lasts about an hour even
after ADR-011.

The job doing this work has two properties that do not belong together.
Its cost is proportional to the size of the input, and the asset cannot be
used without its output. A failure is therefore an availability failure,
and the job needs the full apparatus that ADR-010 built around it:
checkpoints, stuck-job reconciliation, capacity backoff and partial-failure
reporting.

The formats Serve accepts are fixed by what the extractor can unpack in one
pass: zip, tar and tar.gz. Other containers (7z, tar.bz2, tar.xz, zstd)
are refused rather than served slowly.

The design notes behind this ADR argue that both problems have the same
cause: Serve treats an artifact it derives from the upload as a
precondition for serving the upload. This ADR records the principle that
removes the precondition and what follows from it for containers, indexes,
delivery and jobs.

## Decision

### 1. Principle

Serve makes three promises:

1. **Servable on arrival.** An upload can be listed and read as soon as
   the upload completes.
2. **Faster with time.** Derived artifacts make reads cheaper as they
   appear.
3. **Content is not interpreted.** Serve understands containers and
   compression, not what the files inside mean.

The three depend on each other. Because Serve does not interpret content,
it can be closed as a domain-independent layer. Because it does not
interpret, the only derivations it makes are structural optimisations, and
a structural optimisation can always be skipped: the original can still be
read without it, only more slowly. That is what makes the first two
promises possible.

The invariant underneath is one sentence: **a derived artifact never takes
part in correctness.** Every response Serve gives must be producible from
the original bytes alone. A derived artifact may change how many requests
or how much CPU a response costs; it may not change whether the response
can be given. A feature that cannot work without a derived artifact breaks
this ADR, however useful the feature.

ADR-015 §3 already states the narrow form of this ("the original is always
servable"). This ADR extends it from the original file to the entries
inside an archive.

For a CMS built on Serve, the visible change is not a shorter wait but a
different kind of wait. Instead of "the listing appears when extraction
finishes", the listing appears when the upload finishes and becomes faster
when the jobs finish.

### 2. Archive containers: every format readable, speed in three levels

Serve does not avoid formats. It guarantees that every accepted format can
be read entry by entry, and grades only how fast.

| Level | State | Formats | Derived artifacts needed |
|-------|-------|---------|--------------------------|
| L1 | Random access as is | zip, uncompressed tar, non-solid 7z, seekable zstd | Container index only |
| L2 | Random access once an index is added | tar.gz, tar.bz2, block-split xz / zstd | Container index + access-point table |
| L3 | Sequential read only | solid 7z, single-block xz | Repacking |

The level of an upload is measured from its headers, not assumed from its
extension.

**tar.gz is L2.** The deciding quantity is the decompressor's window.
DEFLATE's dictionary is 32 KiB, so an access point costs 32 KiB of saved
window. For 1 GB of uncompressed data with an access point every 4 MB, the
windows total about 8 MB. LZMA windows are 64 MB to 1.5 GB, three to four
orders of magnitude larger, which is why the same trick does not carry
over. Random access into gzip through saved windows is established
practice (zran.c, indexed_gzip, ratarmount, rapidgzip).

tar itself is a sequence of 512-byte header blocks, so one pass yields a
`name → uncompressed offset` table. Only the outer gzip is hard. A tar.gz
therefore needs two indexes: the tar entry table and the gzip access-point
table.

- **bz2** is simpler: its 900 KB blocks are already independent, so the
  index records block boundaries (at bit granularity) and nothing else.
- **xz / zstd** are L2 when split into blocks or frames and L3 otherwise.
  The headers say which.

**L3 becomes L1 by repacking.** A solid 7z stores each folder as one LZMA2
stream; reaching the N-th file of a folder means decompressing files
1..N−1, and the window is too large for zran-style access points. A
repacking job converts it into an L1 form. All three levels therefore fall
under "faster with time". The one thing a solid archive does well, reading
front to back once, is exactly the pass that repacking and index building
need.

### 3. zip is read in place

zip compresses each entry independently, and the central directory gives
each entry's offset and compressed size. A zip can therefore be read
remotely without extraction. In Go, `zip.NewReader(io.ReaderAt, size)`
over a `ReaderAt` that issues HTTP `Range` requests is enough; ADR-001
already uses this adapter to read the central directory.

In steady state, with the central directory cached, an entry costs one
request. Strictly it is two, because the local file header's extra field
may differ in length from the central directory's copy. Reading
`[localHeaderOffset, localHeaderOffset + 30 + nameLen + 64 KiB + compressedSize)`
covers the worst case in one request.

A deflate entry read this way can be delivered without decoding. The
transmux of ADR-011 (gzip header + the entry's raw DEFLATE stream + a
trailer built from the central directory's CRC-32 and size) works at
request time as well as at extraction time: the Worker writes a 10-byte
header, streams the entry's compressed bytes, and appends an 8-byte
trailer. The response follows the existing rules for gzip-stored objects
(`core/file/handler.ts`): passed through when the client accepts gzip and
sent no `Range`, decoded otherwise.

Three pitfalls:

- **Zip64.** Archives over 65,535 entries or 4 GB use the Zip64 end of
  central directory record. The EOCD comment can be up to 65,535 bytes,
  so the tail read is about 128 KB. For small zips, reading the last 1 MB
  fetches the central directory in the same round trip.
- **Filename encoding.** Without the UTF-8 flag, a name may be CP437 or
  Shift_JIS and the bytes do not say which. `archive/zip` sets `NonUTF8`
  and converts nothing.
- **Eager parsing.** `zip.NewReader` parses the whole central directory
  into `[]*zip.File`. At 50,000 entries that is 50,000 allocations per
  request; at that scale a streaming parser is required.

**Entry hashes.** An entry read in place has only the CRC-32 that the
central directory records. The manifest MD5 that `file sync` compares
today (ADR-001) is computed during extraction, so an archive that is not
extracted has none. The listing can report `crc32:<hex>`, which a client
computes locally as cheaply as MD5, but CRC-32 detects accidental change
and is not a content address. A per-entry SHA-256 needs a full decode,
which makes it a size-proportional optimisation job (§6): the listing
shows it once it exists and never waits for it.

### 4. Two indexes, two owners

| | Container index | Content index |
|---|---|---|
| Maps | Entry name → physical byte range | Attribute value → logical offset |
| Requires knowing | The container format | The content's schema (a parser is domain knowledge) |
| Cost | zip: tail read only; others: one pass | Proportional to input size |
| Owner | Serve | The service above Serve |

Both indexes can be built in the same pass, but if Serve builds the
content index, Serve has to understand CityGML, and the boundary of
ADR-015 §2 condition 4 is gone. The single pass is kept by the shape of
Serve's API instead: Serve provides the container index and an endpoint
that streams an entry's decompressed bytes in order, and the service above
builds its content index from that stream when Serve's webhook calls it.
Serve's scope stays at the container.

**If mokuji is used, the layers are separated by tokenizer vocabulary.**
Tokenizing `udx/bldg/53394525_bldg_6697_2_op.gml` yields terms such as
`udx`, `bldg`, `gml` and the mesh code, and
`prefix:udx/bldg/ ∩ mesh:53394525` is an intersection of posting lists.
Knowing that `bldg` means "building" is domain knowledge.

- Serve's tokenizer: path segments, extensions, substrings. It does not
  interpret naming conventions.
- The upper service's tokenizer: maps `bldg` to a feature type and
  `53394525` to a second-level mesh.

Both use the same index format; the vocabulary decides the layer.

A side effect: a posting list is already an ordered ID sequence, so a
listing is a query with one term, and pagination needs no format of its
own. A sorted index also fixes the reason central-directory reads break
down at high entry counts — the central directory is a run of
variable-length records that cannot be read partially, while a name-sorted
index turns a prefix listing into a binary search plus a contiguous range.

For prefix listing alone, a sorted flat array is smaller, faster and
simpler than mokuji. mokuji wins only for infix matches (`*_bldg_*`) and
multi-term intersections. Adopting mokuji for the container index is
therefore a decision to run one index format across layers, made for
operational reasons rather than performance, and is left open (see Open
Questions).

### 5. Delivery without decoding

BGZF is a concatenation of independent gzip members, and a concatenation
of gzip members is itself a valid gzip stream. A byte range cut at member
boundaries is therefore a valid gzip stream. For a repacked BGZF object
the Worker:

1. issues a `Range` read to R2,
2. returns the bytes unchanged,
3. sets `Content-Encoding: gzip`.

The browser decodes. Workers bill CPU time and not I/O wait, so this path
costs about the same CPU as passing an uncompressed object through. The
choice between "range read and decode" and "store expanded and pass
through" disappears.

**gzip is the single encoding.** zstd reached Safari in 26.3
(2026-02-11) and became Baseline Newly Available that day; Chrome 123 and
Firefox 126 shipped it in 2024. Baseline Widely Available is expected on
2028-08-11, so clients without zstd remain for now. Support rates are not
the deciding issue. Supporting clients without zstd means either storing
two encodings, which gives back half the storage saving, or transcoding
at request time, which ends "no decoding". zstd compresses 20–30% better,
but one encoding that every client accepts unchanged is worth more here.
Serve moves to seekable zstd once `Accept-Encoding: zstd` is Widely
Available.

**Request count matters more than CPU.** R2 Class B reads cost
$0.36/million, egress is free, and a range read is one Class B operation
whatever its size.

- Designs that issue many small ranges pay in operations. Laying documents
  out so that posting lists are contiguous is correct for the bill as well
  as for latency.
- Free egress makes over-reading cheap, which favours wider access-point
  intervals.
- Worker memory is fixed at 128 MB. Any path that decodes must stream
  (`DecompressionStream`); the pass-through path is unaffected.

These figures are Cloudflare's. On another runtime (ADR-012) the same
structure holds but the balance between operations, egress and CPU has to
be rechecked.

**The exception is a second path.** An API that returns a few attributes
from inside a file cannot pass bytes through; it has to decode and parse
the XML, and it pays CPU for it. Serve's request paths are therefore
"return bytes" (cheap) and "interpret content and return it" (expensive).
The second belongs to the service above Serve, which is the same line as
§4 and as the Serve / untiled split in ROADMAP.md.

### 6. Jobs: on the existing machinery, classified on two axes

The job machinery that thumbnails and extraction already use stays, for
its retries. Derivations are put on it rather than taken off it.

| | Required | Optimisation |
|---|---|---|
| **Size-independent** | Thumbnails | Container index |
| **Size-proportional** | — | Repacking, access-point tables, content indexes |

An empty bottom-left cell is the measure of a healthy design. Today's
archive extraction sits in that cell; moving it to the bottom-right is
what this ADR changes.

**Failure handling is a separate attribute.** The columns say whether a
feature is missing until the job finishes. They do not say what a failure
means, and one job fits neither column: the whole-object hash
verification that ADR-017 §2 runs after a presigned multipart upload. It
is size-proportional, and it does not gate reads, because a `pending`
version is servable, so it does not fill the bottom-left cell. Its failure
deletes the version, which is neither a missing feature nor a slower read.
Each job therefore carries a failure class:

| Failure class | Jobs | A failure means | Handling |
|---------------|------|-----------------|----------|
| Missing feature | Thumbnails | A feature is absent | Retry; notify on final failure |
| Slower reads | Container index, repacking, access-point tables, entry hashes | Reads cost more | Retry; do not notify |
| Rejected version | Hash verification (ADR-017 §2) | The version is deleted and never becomes active | Retry transient read errors only; a mismatch is final; notify the uploader |

Alerting on every failure with the same weight buries the ones that
matter. One attribute on the job, its failure class, is enough.

**Indexing in the upload stream is rejected.** Reading the bytes as they
pass through the upload was considered and rejected because:

- zip keeps its central directory at the end, so nothing needs a full
  read. Done asynchronously the job takes a few hundred milliseconds, and
  the premise that async indexing is expensive does not hold.
- Multipart parts arrive in parallel and out of order, so a sequential
  parser loses its input order.
- It does not work with direct uploads to presigned URLs.
- In a zip with data descriptors (sizes written after the data), the end
  of an entry is not evident from the stream. The central directory gives
  it with certainty.
- An indexing failure would become an upload failure.
- Existing objects need a backfill path anyway, so there would be two
  implementations.

**The container index is built in upload finalisation.** Reading a
central directory depends on the entry count, not the input size; a 10 GB
zip has the same central directory as a 10 MB zip with the same entries.
The worst case can be bounded, so the work fits in finalisation, next to
the size and the SHA-256 that ADR-017 computes there.

As a safety valve, when the central directory exceeds a threshold (for
example 100,000 entries or 20 MB), finalisation skips the index, records
that it skipped, and continues. The index is built by another path if it
is needed. The long tail cannot stall an upload.

This works only because the index takes no part in correctness. If the
listing API required the index, a skipped or failed index would be an
availability problem and the state management of ADR-010 would come back.

### 7. Sidecar or conversion

One criterion decides: **if the original already has an internal structure
that allows random access, add a sidecar; if not, convert.**

| Format | Decision | What is needed |
|--------|----------|----------------|
| zip | The index is inside the original | The central directory (optionally a container index) |
| Tiled GeoTIFF | Sidecar | External `.ovr` overviews; no COG conversion |
| Stripped GeoTIFF | Conversion | Strips cannot be read partially across the width |
| CityGML | Sidecar | An external attribute index |
| GeoJSON | Conversion | Not partially readable by structure; JSONL + mokuji makes it so |
| Solid 7z | Conversion | Repacking |

This is more precise than "derived artifacts are cloud-optimised by
default", and it leaves the original untouched wherever it can, in line
with ADR-015 §1 (the original is the source of truth).

**GeoTIFF.** A COG is tiled, has overviews, and has its IFDs at the
front. A sidecar can add only the overviews. Whether an original is tiled
is readable from its TIFF tags, so like the solid-7z check it is measured
first. Overview generation makes smaller images, as thumbnail generation
does; a thumbnail is the top level of the pyramid and an `.ovr` is every
level, so the two may share an implementation.

**mokuji + JSONL.** An inverted index plus a row store plus offsets is the
structure of Lucene's inverted index and stored fields. Against Parquet:

- Parquet is columnar; "this column for every row" is fast. Suited to
  aggregation and analysis.
- mokuji + JSONL is "every field of a few rows" fast. Suited to search and
  lookup.

Catalogue search, geocoding and CityGML attribute retrieval are all
lookups. The index and the JSONL are kept as two files, not one: a
standalone JSONL can be read by DuckDB's `read_json_auto`, `jq` or
`ripgrep` with no mokuji at all, which lowers the cost of adoption.
Compressing the JSONL is the same block-compression problem as above; if
mokuji can describe the compressed block boundaries of an external file,
CityGML and JSONL use one mechanism.

### 8. The container index is metadata of the original

ADR-015 §2 condition 3 admits only one generation of derivation. An index
over a repacked BGZF object would be a derivation of a derivation and
would break that rule in form.

The container index is therefore classified as **metadata of the
original**, not as a derived artifact. The central directory is part of
the zip; a reformatted copy of it is metadata in the same sense as the
size or the checksum. Under this classification the conflict disappears,
and building the index in finalisation (§6) is justified the same way as
computing the checksum there. The index is keyed by the blob's SHA-256
(ADR-017 §3), so every version in a workspace that points at the same
blob shares one index.

## Alternatives Considered

### Support only the formats that are fast

Accept zip and refuse the rest, or accept only L1. Rejected: it pushes
repacking onto every uploader, and it is unnecessary once the guarantee is
"readable" and the levels grade only speed.

### Keep extraction as a precondition

Keep today's model and make extraction faster. Rejected: ADR-011 already
removed recompression and the wait is still about an hour at PLATEAU
scale. The cost is not the speed of the job but the fact that the asset
waits for it.

### Indexing in the upload stream

Rejected; see §6.

### zstd as the stored encoding

Rejected for now; see §5. Revisited when `Accept-Encoding: zstd` is
Baseline Widely Available.

### Serve builds the content index in the same pass

Rejected; see §4. It puts schema knowledge into Serve.

### Treat the container index as a derived artifact

Rejected; see §8. It conflicts with the one-generation rule for
repacked objects and would keep the index out of finalisation.

## Consequences

### Positive

- An archive can be listed and read as soon as its upload completes.
  "Ready" stops being a gate for archives.
- Archive extraction leaves the required × size-proportional cell. Its
  failures become slow reads rather than unavailable assets, and the
  recovery machinery of ADR-010 stops guarding availability.
- Every container format can be accepted. Unsupported formats become slow
  formats.
- A zip needs no storage beyond the original to be served, and its deflate
  entries are delivered without decoding.
- Alerts are limited to failures that remove a feature.

### Negative

- Serve gains format-specific read paths in the Worker (zip central
  directory, tar entry tables, gzip access points, bz2 block boundaries,
  BGZF) where today it serves only whole objects.
- Reads of an archive that has no index yet cost more requests and more
  CPU than reads of extracted objects. The cost falls as jobs complete,
  but it is a real cost during that window, and for an L3 archive before
  repacking it is a full sequential decode up to the entry.
- The listing API and static site hosting (ADR-013) must work from the
  original (central directory, or a sequential scan) when no index exists.
  Both read `_manifest.jsonl` or extracted objects today.
- ADR-001, ADR-011 and ADR-015 §4 describe extraction as the way an
  archive becomes servable. They need amending when this ADR is accepted.
- An archive that is not extracted has no per-entry MD5 (§3). `file sync`
  has to accept `crc32:` hashes, or wait for an entry-hash job, or fall
  back to comparing sizes.
- The gzip-only decision leaves the 20–30% zstd compression gain unused
  until 2028 at the earliest.

## Open Questions

### Measurements, in this order

1. **Does a browser `fetch` read a multi-member gzip to the end?** zlib
   handles it, but some HTTP stacks have historically stopped after the
   first member. If this fails, §5 fails, so it is measured before
   anything else.
2. **The distribution of zip entry counts (p99).** This decides whether a
   container index is needed at all. If p99 is around 5,000, reading the
   central directory per request is enough.
3. **Whether distributed 7z files are solid.** Read the unpack-stream
   count per folder from the header. One file per folder needs no
   repacking.
4. **The ratio of tiled to stripped GeoTIFFs.** This decides whether
   sidecars are enough.
5. **The distribution of LZ77 back-reference distances.** Whether access
   point windows can be trimmed. Research-oriented and not urgent.

### Decisions

- Whether the container index uses mokuji or a sorted flat array (§4).
- The finalisation thresholds for skipping the container index (§6).
- The shape of the decompressed-stream endpoint and the webhook that
  hands it to the service above Serve (§4).
- Which hash an in-place entry reports in the listing (`crc32:` from the
  central directory, or a SHA-256 filled in later by an optimisation
  job), and the matching change to `file sync` (§3).
- Whether zip extraction continues at all once zip entries are served in
  place, or is kept only where it measurably reduces request cost.

## Notes: research directions

Building a search index that works through gzip overlaps with existing
work. zran plus an inverted index is what zindex already does, and a
single-pass build is the natural engineering choice. Two parts look new:
minimising access-point windows by analysing back-reference distances
(the distribution for geometry-heavy XML appears unmeasured), and making
the index an immutable file format designed for HTTP `Range` and
distributed separately from the data. Existing tools pair a local index
with a local file; distributing only the index would make existing public
data searchable without touching the originals. Measuring the windows
comes first, because the more it saves, the more practical the
distributable index becomes.
