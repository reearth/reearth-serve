# ADR-009: Image Thumbnail Generation

- **Status:** Proposed
- **Date:** 2026-05-19
- **Deciders:** @rot1024

## Context

Re:Earth Serve hosts user-uploaded image assets (photographs, screenshots, map captures, orthophoto previews, user-supplied icons for Cesium billboards, etc.). Consumers — the Web UI asset browser, the Re:Earth Visualizer asset picker, CesiumJS billboard rendering, and external integrations — need lightweight previews. Returning the full-resolution original for every grid tile or every billboard is wasteful at best and a hard correctness problem at worst (see "Cesium billboard constraints" below).

### Generation-strategy options considered

Four shapes were evaluated. Each cell in the table answers "what does sustained traffic against a public asset URL cost / how does it behave?"

| Option | Per-request CPU/$ | First-request latency | Storage | Failure mode under burst |
|---|---|---|---|---|
| **A. Cloudflare Images / Resizing** | Billed per request | Low | None | Cost runs away — no upper bound |
| **B. Worker WASM, no cache** | 100–500 ms CPU every hit (~$0.02 per million CPU-ms) | ~200–800 ms | None | CPU bill and origin load both unbounded; 128 MiB limit risks OOM on large photos |
| **C. On-the-fly via Container (sync), with R2 write-back cache** | Generation once per (asset×size), then zero | ~2–6 s cold start + resize on first hit; ms thereafter | Grows with actual demand | Stampede on cold key (multiple concurrent first-hits → multiple container invocations) unless lock added |
| **D. Pre-generate at upload time, static R2 delivery** | Zero | Zero (or 404 during generation window) | Grows with every uploaded image, even if never viewed | Bounded — generation runs once per version regardless of traffic |

**Why D for this codebase:**

- **Predictable latency.** Cesium billboard rendering and asset-grid UIs both need consistent sub-100 ms response. Option C's first-request cold start (Container boot ~2–5 s) is visible to end users and shows up at unpredictable times — exactly when an asset becomes newly popular.
- **Stampede risk in C.** Without a per-key lock (Durable Object or KV-based mutex), N concurrent first-requests for the same uncached thumbnail spawn N container invocations. Building stampede protection is non-trivial and is a separate failure surface from the generation itself.
- **We already have the bytes.** At upload time the source is in-process. Decoding once and producing all four sizes in a single pass is the cheapest possible generation moment. Deferring it discards that locality.
- **Demand is high for uploaded images.** Re:Earth Serve hosts assets users actively use in scenes — most uploads are viewed at least once, often at multiple sizes (UI grid + scene billboard + detail panel). The "save work on never-viewed assets" argument that favors C is weaker here than in, say, a generic CDN-cache scenario.
- **Storage cost is small.** Four WebP thumbnails for a typical 2 MB JPEG total ~30–80 KB — under 4% overhead. R2 storage is cheap relative to the operational cost of cold-start latency.

**Where C would win and we should revisit:**

- If we add a *parameterized* dimension (e.g. arbitrary `?w=` width). Pre-generating an unbounded set is infeasible; C with a cache becomes the only sane option.
- If telemetry shows a long tail of uploaded assets that are never viewed (lazy generation saves real work).
- If a particular transform is very expensive (e.g. AVIF encode is 10× WebP) and view rate is low — generate the cheap formats eagerly, defer expensive ones to C.

A **hybrid (D + C)** is therefore the natural endgame: fixed-size WebP thumbnails are pre-generated (D), and any future dimension-on-demand feature (e.g. `?w=...`) uses C with R2 write-back. This ADR commits to D for the four fixed sizes; C is left open for future parameterized transforms.

Thumbnails are also a presentation-layer concern tightly coupled to the parent asset's lifecycle (re-generate on new version, delete with parent), which fits Serve's domain regardless of strategy.

### Cesium billboard constraints

A primary downstream consumer is CesiumJS billboards in Re:Earth Visualizer. Cesium packs billboard images into a `TextureAtlas` whose size is bounded by `gl.MAX_TEXTURE_SIZE`. Exceeding it manifests as black squares — particularly on mobile where the limit is often 2048 or 4096 (vs 8192–16384 on desktop). See [Cesium issue #6477](https://github.com/CesiumGS/cesium/issues/6477).

Practical packing capacity at 64 px per image (≈85% efficiency, 1 px borders):

| Atlas limit | Unique billboard images |
|---|---|
| 2048 (older mobile) | ~800 |
| 4096 (modern mobile) | ~3000 |

At 128 px per image the corresponding numbers are ~200 and ~700. User-generated billboard icons in PLATEAU-style deployments routinely reach hundreds of unique images, which is why 64 px is a first-class size, not an edge case.

### Where to put thumbnails: storage layout

The repository already has a precedent for "files derived from a parent version, stored under that version" — archive extraction writes entries under `assets/{id}/v/{vid}/_archive/...` (see `worker/asset/usecase/shared.ts`, `versionArchivePrefix`). Treating thumbnails the same way avoids:

- A new `Asset` record per parent (no ID reservation needed, no listing filter needed).
- An extension to the `AssetType` enum (currently `"file" | "archive"`, which is on a different axis from ADR-006's `uploaded | derived | composite | external`).
- Bespoke lifecycle handling — deleting a parent version's R2 prefix removes thumbnails automatically.

The tradeoff is that thumbnails are not independently versioned, but they don't need to be: a thumbnail is always derived from exactly one parent version, and never edited independently.

ADR-006 (DerivedAsset) remains the long-term model for genuinely independent derived data (FGB, COG, tile sets). Thumbnails are explicitly *not* that case — they're a fixed-cardinality presentation artifact, more like archive entries than like a converted dataset.

### Generation runtime

Workers' 128 MiB memory limit handles small images comfortably; a 30 MB DSLR JPEG decodes to ~200 MB of raw pixels and will OOM. The repository already offloads heavy work to Cloudflare Containers (Go) via `container/archive-extractor` (ADR-001, ADR-008). The same pattern applies here.

### Event trigger

ADR-007 (webhooks and event log) is currently proposed and not yet implemented (`grep "asset.version.created"` returns no results in the worker code). Rather than block on that, thumbnail generation will be enqueued directly from the version-creation code paths (`upload.ts`, `upload-version.ts`, `complete-upload-session.ts`), mirroring how archive extraction is enqueued today. When ADR-007 lands, the trigger can migrate to event subscription without changing the generation pipeline itself.

## Decision

### 1. Storage layout

Thumbnails are stored under the parent version's R2 prefix:

```
assets/{parentId}/v/{versionId}/_thumbs/xs.webp   (64 px)
assets/{parentId}/v/{versionId}/_thumbs/sm.webp   (128 px)
assets/{parentId}/v/{versionId}/_thumbs/md.webp   (512 px)
assets/{parentId}/v/{versionId}/_thumbs/lg.webp   (1280 px)
```

A new `versionThumbsPrefix(assetId, versionId)` helper is added to `worker/asset/usecase/shared.ts` alongside `versionArchivePrefix`.

No `AssetType` enum change. No new asset records. No ID reservation. The presence of `_thumbs/` files is detected by R2 listing or by metadata flag on the version (see §3).

### 2. Sizes and format

Four fixed sizes, long-edge basis, aspect ratio preserved, never upscaled. Originals smaller than a given size simply skip that size.

| Name | Long edge | Primary use | Cesium billboard suitability |
|---|---|---|---|
| `xs` | 64 px | Dense billboard icons, user-supplied billboard images | **Recommended for all billboards** (~800 unique on 2048 atlas, ~3000 on 4096) |
| `sm` | 128 px | Sparse billboards, list icons | OK for ≤~150 unique images; safer on desktop than mobile |
| `md` | 512 px | Card grid in Web UI (Retina 2× of ~256 px display) | Not for billboards — atlas exhaustion likely |
| `lg` | 1280 px | Lightbox / detail preview | Not for billboards |

WebP only in the initial release. Quality target: 80 (Cesium-billboard sizes `xs`/`sm`) and 85 (`md`/`lg`).

Source formats supported in v1: JPEG, PNG, WebP, GIF (first frame only). Unsupported source formats (HEIC, AVIF as input, RAW, TIFF) produce no thumbnails and emit a warning to the job log — the UI falls back to the parent file or a generic placeholder. AVIF *output* and HEIC *input* are deferred to a later phase.

### 3. Marker on version metadata

A boolean `hasThumbnails` (or equivalent `thumbnails: { generatedAt, sizes }`) is set on the version record when generation succeeds. This avoids an R2 HEAD per request to determine availability. The exact shape lives in `userMeta` initially (no schema migration), and may be promoted to a top-level field if usage justifies it.

### 4. Generation pipeline

New Queue `reearth-serve-thumbnail` (producer + consumer in `wrangler.toml`).

Enqueue trigger: version creation in `worker/asset/usecase/{upload,upload-version,complete-upload-session}.ts` when `contentType` matches `image/(jpeg|png|webp|gif)`.

Consumer dispatch logic:

```
size < 20 MiB  → Worker in-process (jSquash)
size ≥ 20 MiB  → Cloudflare Container (Go + libvips)
```

The 20 MiB threshold is conservative: a 20 MiB JPEG typically decodes to <120 MiB of pixels, leaving headroom under the 128 MiB Worker limit. This boundary is a variable in `wrangler.toml` so it can be tuned without code changes.

**Worker path** (`worker/thumbnail/`):
- Packages: `@jsquash/jpeg`, `@jsquash/png`, `@jsquash/webp`, `@jsquash/resize`.
- Decode once → resize 4× (xs/sm/md/lg) → encode each to WebP → write to R2 under `_thumbs/`.
- Mark version with `hasThumbnails` on completion.

**Container path** (`container/thumbnail/`):
- Go + libvips (via `govips` or `bimg`). libvips streams JPEG/PNG decode with bounded memory.
- Follows `archive-extractor`'s shape: Dockerfile, `wrangler.toml` `[[containers]]` binding, `instance_type` per ADR-008 (likely `standard-2`).
- R2 read → resize 4× → R2 write. The Worker dispatches to the container via Durable Object fetch and writes the version metadata after the container reports success.

### 5. Delivery

Two access patterns are supported, both resolving to the same R2 objects under `_thumbs/`.

#### 5a. Canonical path

```
GET /files/:assetId/_thumbs/:size.webp
GET /files/:assetId/v/:versionId/_thumbs/:size.webp
```

`:size` ∈ `xs | sm | md | lg`. The path is intentionally part of the file tree so existing access control, Range support, and caching logic in `worker/file/handler.ts` apply unchanged.

#### 5b. Query-parameter override on the original asset URL

```
GET /files/:assetId/:filename?thumb=xs
GET /files/:assetId/v/:versionId/:filename?thumb=md
```

Adding `?thumb=xs|sm|md|lg` to *any* existing file URL returns the thumbnail instead of the original. This lets consumers that already hold an asset URL (Re:Earth Visualizer scene definitions, embedded references in external systems, hardcoded URLs in user content) opt into thumbnails without URL rewriting.

Behavior:
- The query parameter is parsed in `fileRoutes.get("/:id/:path{.+}")` before storage-key resolution. When present, the storage key is rewritten to `assets/{id}/v/{vid}/_thumbs/{size}.webp` and `Content-Type` is overridden to `image/webp`.
- Invalid values (`?thumb=foo`, `?thumb=2xl`) → 400.
- Unknown filename in the original URL is still validated — the query parameter does not bypass version resolution, so the caller cannot use it to probe arbitrary assets.
- Query string is included in the CDN cache key (Cloudflare default behavior, no extra config needed).

#### Cache headers

`Cache-Control: public, max-age=31536000, immutable` when the URL is version-pinned (`/v/:versionId/...` or content keyed by an immutable version). The unversioned path resolves to the active version and gets a shorter TTL (`max-age=300`) so active-version changes propagate.

#### Fallback policy

When a thumbnail does not exist (generation pending, in flight, source format unsupported, or non-image asset), both access patterns return **404**. The UI is responsible for fallback to a placeholder or the original asset.

Rationale for strict 404 over silent fallback to the original:
- A caller asking for a 64 px thumbnail does not want a 30 MB original served as the response — that defeats the point.
- 404 is cacheable for a short TTL (e.g. 30 s) so retries during generation don't hammer the origin.
- The `hasThumbnails` marker on version metadata (§3) lets clients avoid the round trip entirely when they have the metadata.

### 6. Lifecycle

- **Parent version created** → enqueue generation for matching content types.
- **Parent version deleted** → `_thumbs/` prefix is deleted with the rest of the version's R2 prefix (existing behavior, no change needed).
- **Parent asset deleted** → entire asset prefix removed, including thumbnails.
- **Storage usage** (ADR-004) accrues thumbnails to the same workspace as the parent.

### 7. Regeneration

`POST /api/v1/assets/:id/versions/:vid/thumbnails` (re-)generates thumbnails for a specific version, idempotent. Useful when:

- Source format support is added (HEIC, AVIF input).
- A new size is introduced and needs backfill.
- A generation previously failed.

A bulk regeneration mode (across all versions / all image assets) is deferred until concrete need.

## Consequences

### Positive

- Per-thumbnail cost is bounded: one generation per uploaded version, regardless of subsequent traffic.
- Delivery hot path has zero CPU cost — plain R2 reads through the existing file pipeline.
- Worker / Container split keeps small images fast (no cold start) while large images get the memory they need.
- No new `Asset` records, no enum changes, no ID reservation — minimal blast radius on existing code.
- `_thumbs/` mirrors `_archive/` — pattern consistency with the existing codebase.
- Cesium billboard correctness: `xs` (64 px) directly addresses the atlas-exhaustion / black-square failure mode on mobile.

### Negative

- Four sizes are baked in. Adding a fifth requires backfill via the regeneration endpoint.
- Thumbnails cannot be independently versioned or accessed across versions — acceptable for this use case.
- AVIF / HEIC deferral means clients without WebP support (rare in 2026) get no thumbnail.
- Container cold start (a few seconds) hits the first large-image upload after idle. Acceptable because generation is async.

## Implementation Plan

| Phase | Deliverable |
|---|---|
| 1 | `versionThumbsPrefix` helper. Delivery: canonical path + `?thumb=` query parameter in `worker/file/handler.ts`. 404 path. |
| 2 | `reearth-serve-thumbnail` queue. Producer wired into the three version-creation paths. |
| 3 | Worker generator (`worker/thumbnail/`) with jSquash, all four sizes, version metadata marker. |
| 4 | Container generator (`container/thumbnail/`) with libvips. ≥20 MiB dispatch. |
| 5 | Web UI integration in `app/`: thumbnail in asset list/detail, fallback handling. |
| 6 | Regeneration endpoint. Metrics: success rate, generation latency, size distribution. |
| 7 | AVIF output, HEIC input. Re-evaluate sizes against real corpus. |

## Notes on local development

jSquash WASM modules are imported via relative path
(`../../node_modules/@jsquash/.../<file>.wasm`) because the packages don't
expose those files in their `exports` field. `vite.config.ts` lists the
`@jsquash/*` packages in `ssr.noExternal` and `optimizeDeps.exclude` so
Vite's dep-optimizer does not rewrite them to `file://` URLs (which Workers
cannot fetch). In production wrangler bundles the `.wasm` files directly.

In `wrangler dev`, JPEG/WebP source decode currently works end-to-end but
the PNG codec throws inside the WASM runtime on first decode. The same
code path works in production builds; the dev breakage appears to be
specific to Vite's WASM handling for that one codec. The E2E test uses a
JPEG source to keep dev verification reliable. PNG is exercised in
production-equivalent paths via the regeneration endpoint.

## Related ADRs

- [ADR-001](./001-archive-extraction.md) — Archive extraction (`_archive/` prefix, Container precedent)
- [ADR-004](./004-storage-usage-tracking.md) — Storage usage accounting
- [ADR-005](./005-asset-versioning.md) — Asset versioning
- [ADR-006](./006-derived-asset-and-asset-edge.md) — Derived assets (consciously not used here; see §1)
- [ADR-007](./007-webhooks-and-event-log.md) — Event log (future trigger migration)
- [ADR-008](./008-extractor-capacity.md) — Container capacity sizing
