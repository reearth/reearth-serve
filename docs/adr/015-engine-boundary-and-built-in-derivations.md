# ADR-015: Serve as an Engine — the Built-in Derivation Set and the Application Boundary

- **Status:** Proposed
- **Date:** 2026-09-15
- **Deciders:** @rot1024
- **Related:** ADR-005 (versioning), ADR-006 (derived assets, edges),
  ADR-007 (events, webhooks), ADR-009 (thumbnails), ADR-011 (transmux),
  ADR-012 (portability), ADR-013 (site hosting), ADR-014 (access control)

## Context

Re:Earth Serve can be read two ways, and the codebase currently supports
both readings at once.

**Serve as an engine.** ROADMAP.md draws the line at "storage, versioning,
and delivery": Serve owns assets, versions, files and access; it does not
convert formats, render tiles or run GDAL. Everything that understands what
a file *means* lives in a separate system (reearth-untiled) that subscribes
to Serve's events and writes results back. In this reading Serve's contract
is thin — bytes in, bytes out, `Range` on every byte, an immutable version
behind every URL — and that thinness is the point: a new format needs no
change in Serve, and every existing reader (GDAL, QGIS, MapLibre, deck.gl,
CesiumJS) already knows how to consume what Serve stores.

**Serve as an application.** The earlier prototype
[reearth-serve-mvp](https://github.com/eukarya-inc/reearth-serve-mvp)
showed what a GIS-shaped product on the same foundation looks like: assets
know their format, publishing a PMTiles asset auto-creates an MVT tile
service and a TileJSON endpoint, bounds and CRS are read from file headers
at commit time and exposed as a STAC Item, and the asset detail page hands
the user copy-paste snippets for MapLibre, QGIS, `gdalinfo`, Potree and
rioxarray. Users liked that shape. It is also exactly the shape that, if it
were folded into the engine, would make every future format a change to
Serve.

Meanwhile the engine already does things ROADMAP says it does not. Image
uploads get four WebP thumbnails at upload time (ADR-009). Archive
extraction transmuxes deflate entries into gzip objects (ADR-011). The CLI
gzips compressible files before upload. Each is a transformation, each was
justified on its own, and each is indispensable in practice: a hosting
service without thumbnails is not usable from an asset picker, and archive
delivery without `Range`-friendly storage is not usable from a viewer.

So the question is not "does Serve transform?" — it does, and must — but
**which transformations belong inside the engine, by what rule, so that the
set stays small and the line stays defensible** when the next request
arrives (and the next request will be "just render COG tiles" or "just
extract the text").

The design notes behind this ADR (`tmp/idea.md`, 2026-09-12 – 14) settle on
one criterion and one shape. The criterion: a derivation belongs in the
engine when **its output is determined by the input format alone and
involves no interpretation**. The shape: Serve is **an asset store, plus
one generation of derived slots per asset, plus event notification** —
nothing more. This ADR records both, and records what is thereby placed
*outside* the engine.

## Decision

### 1. Serve is the engine

Serve's contract with everything above it is three things:

1. **Bytes.** Serve stores what was uploaded and serves it back unchanged.
   The original is the source of truth and is never rewritten in place
   (ADR-005: versions are immutable).
2. **`Range`.** Every stored object, original or derived, is served with
   `Range` support and an `ETag`. This is the property that lets
   cloud-optimized formats work without Serve understanding them.
3. **Content address.** A version ID names one immutable set of bytes.
   Derived artifacts are named by the hash of their input and of the
   processor that produced them (§3).

To this the engine adds two mechanisms, and only two:

- **Derived slots** — named, one-generation artifacts hanging off a
  version, filled either by the engine's built-in set (§2) or registered
  by an application that transformed the version (§3).
- **Events** — notification that a version was created, that a derived
  slot became ready, that an asset was deleted (ADR-007).

Serve does not know what a file is *for*. It does not carry a `format`
field that changes routing, does not create per-format service endpoints,
does not have a publish/draft state separate from versions, and does not
search or catalogue. Those are application concerns (§5).

### 2. The built-in derivation set and its admission rule

Serve ships a **built-in set** of derivations that run automatically when a
version is created. A derivation is admitted to the set only if it meets
all four of the following conditions.

| # | Condition | What it rules out |
|---|-----------|-------------------|
| 1 | **Format-determined.** Given the input bytes and the input format, there is one correct output. The user chooses nothing. | Anything with a model, a style, a colour map, a resampling choice the user would want to make, a language, a threshold. |
| 2 | **Deterministic and bounded.** Same input, same output; runtime is bounded by input size; the work cannot fail in a way that needs a human. | Best-effort ML, network-dependent enrichment, anything that retries forever. |
| 3 | **One generation.** The derivation reads one version and writes into that version's slots. It never reads another derivation's output, and nothing derives from it. | Pipelines. Composites. Multi-source outputs. |
| 4 | **Structural, not interpretive.** The output is a re-encoding, re-ordering or indexing of what is already in the input, or an extraction of metadata the format declares. | OCR, transcription, embeddings, object detection, AI search, "what is in this photo". |

"No interpretation" is about the *user*, not about Serve. Serve makes fixed
implementation choices inside a derivation — four thumbnail sizes, WebP,
a resampling kernel, a COG block size — and those choices are legitimate.
They are versioned by the processor hash (§3), so changing them invalidates
and regenerates without ambiguity. What is not legitimate is a choice that
varies per asset or per caller: the moment a derivation needs a parameter
from the user, it is an application.

Each derivation admitted to the set gets its own ADR (as ADR-009 did for
thumbnails) covering storage layout, sizes, runtime and delivery. This ADR
fixes the gate, not the contents.

### 3. Derived artifacts are slots, not assets

The lesson behind this section is Re:Earth CMS and PLATEAU CMS: when a
CityGML upload and the 3D Tiles that FME or Re:Earth Flow produced from it
are two unrelated rows in a flat list, nobody can later say which came
from which. Lineage must be recorded by the engine at the moment the
result is written back, or it is lost.

A **slot** is a named, one-generation artifact attached to one version of
one asset. It is the engine's record that "this is the same asset in
another form".

- **Where it lives.** Under its parent version in storage
  (`assets/{id}/v/{vid}/_<role>/…`, the layout ADR-009 and archive
  extraction already use). It is deleted with the version, inherits the
  asset's access mode (ADR-014) with no rule of its own, is counted
  against the parent's storage usage, and is never independently
  versioned.
- **A slot is a prefix, not a single object.** A thumbnail slot holds four
  files; a 3D Tiles slot holds a tileset and thousands of tiles. Writing
  an archive into a slot runs the built-in extraction (ADR-001, ADR-011)
  into that prefix, exactly as an archive upload is extracted today, so a
  directory-shaped result is registered with one upload.
- **Who fills it.** Either the engine's built-in set (§2) or an
  **application** that read the version and transformed it. Registration
  is one write-back call: *asset X, version V, role R, here are the
  bytes* (the internal API of ADR-006 §9, narrowed to this shape).
  Registering requires the same permission as uploading a version to the
  asset.
- **Role names.** A role is a short lowercase identifier, the key a
  consumer looks a slot up by — the same position a key in a STAC Item's
  `assets` map holds. It is **not** a media type: 3D Tiles, FlatGeobuf
  and PMTiles have no registered one, and "what this is for" and "what
  bytes these are" are different questions. Each slot separately records
  the media type of its primary entry (`tileset.json` →
  `application/json`) and which entry is primary, so `/files/:id/_3dtiles/`
  resolves the way `/files/:id/` resolves `index.html`. Names are
  reserved in three tiers, kept in a registry file in the engine (as the
  site-host reserved list of ADR-013 B2 is); adding one is a pull request,
  not an ADR:

  | Tier | Examples | Filled by | Why reserved |
  |------|----------|-----------|--------------|
  | Engine-owned | `thumbs`, `archive`, `meta`, later `cog`, `fgb` | the built-in set | applications may not write them |
  | Well-known formats | `3dtiles`, `pmtiles`, `mvt`, `copc`, `terrain`, `parquet` | applications | the same key whichever tool produced it, so a consumer asks "is there a `3dtiles` slot?" and never "was this FME or Flow?" |
  | Application namespace | `untiled.importance`, `flow.<name>` | that application | anything else; the `<app>.` prefix keeps it from colliding |

  Names for the second tier follow GDAL driver short names and file
  extensions where those exist. A variant of a well-known format
  (`3dtiles.lod2`) is `role.variant`; consumers match on the role.
- **Identity is input × processor.** For a built-in derivation the
  processor hash is the engine's own; a processor change is a new hash,
  the old artifact is stale by construction and is regenerated, and a
  cleanup sweep removes artifacts whose hash is no longer current — no
  "regenerate all thumbnails" migration is ever needed. For an
  application-registered slot the registrar declares its processor
  (a name and a version string) and the engine records it; the engine does
  not verify determinism, it only stores the claim so that a later reader
  can tell which tool produced the bytes.
- **The original is always servable.** A derivation never gates delivery
  of its source. While a slot is absent, pending or failed, requests for
  the slot answer with a defined status (404 with `Retry-After` during a
  known generation window, as ADR-009 does) and requests for the original
  are unaffected. A built-in derivation that could make an upload
  unreadable does not meet condition 2.
- **A new version has empty slots.** When a version is created, no slot
  from the previous version carries over. Built-in derivations run again
  (asynchronously, queue-driven, so upload latency does not depend on the
  size of the set). An application learns of the new version through
  `asset.version.created` and decides for itself whether to run again;
  the absent slot *is* the signal. There is no `dirty` state and nothing
  propagates. An application may mark a slot `pending` when it starts,
  so that two instances reacting to the same event do not both do the
  work; the claim expires if nothing is registered.

### 3a. Loose lineage: `derivedFrom`

Not every result fits a slot. A tileset bundled from ten uploads has no
single parent version to hang from. A result an application wants to
own — with its own access mode, its own version history, its own
lifetime — must be an asset.

For those, the engine offers one **official metadata field** on an asset
version: `derivedFrom`, a list of `{ assetId, versionId }` pairs (plus the
registrar's processor claim, as for slots). It is a **loose link**:

- The engine validates the shape and that the referenced asset exists at
  write time, and stores it. That is all.
- Nothing propagates. Deleting a source does not touch the derived asset;
  the link simply dangles, and reads as such.
- The engine never walks the links. There is no "list everything derived
  from X" query in the engine; an application that needs one keeps its
  own index (idea.md's reverse index on yashiro is that application).
- It is informational for humans and for the UI — a "derived from" label
  and filter — and for auditors who need to reconstruct provenance.

The rule for choosing between the two: **if the result should live and die
with one version of one asset, it is a slot; otherwise it is an asset
with `derivedFrom`.** A slot is strong lineage the engine enforces; a
`derivedFrom` is weak lineage the engine remembers.

### 4. Initial contents of the set

| Derivation | Input | Output | Status |
|------------|-------|--------|--------|
| Archive extraction with transmux (ADR-001, ADR-011) | zip / tar / tar.gz | individual objects, deflate→gzip | built |
| Image thumbnails (ADR-009) | JPEG / PNG / WebP / GIF | 4 fixed WebP sizes | built |
| Header metadata extraction | GeoTIFF / COG, PMTiles, GeoJSON, 3D Tiles `tileset.json`, EXIF | bounds, CRS, dimensions, zoom range — as system `meta`, exposable as a STAC Item | candidate — validated in reearth-serve-mvp |
| GeoTIFF → COG | GeoTIFF | COG (overviews, internal tiling) | candidate |
| GeoJSON → FlatGeobuf | GeoJSON | FGB with spatial index | candidate |
| MP4 faststart | MP4 | `moov`-first MP4 | candidate |
| WASM AOT | `.wasm` | `.cwasm` for the target runtime | candidate — depends on the WASM host, which is not designed here |

Candidates are listed to show the shape of the set, not to admit them.
Each enters through its own ADR against the four conditions. Some will
fail: GeoJSON → FGB is format-determined, but whether the output should
instead be GeoParquet for attribute queries is a *use* question, and a
derivation that depends on use is an application's.

Metadata extraction is the one candidate this ADR expects to admit next.
It is pure extraction (condition 4), reads a bounded header (condition 2),
and the MVP demonstrated the user value of a STAC-shaped manifest per
asset. The MVP's `format` field, however, is *not* admitted: extraction
sniffs the format from the bytes and records what it found in `meta`;
nothing in routing or delivery branches on it.

### 5. What lives above the engine

The following are **applications** on Serve. They use the engine through
its public surface (§6) and own any asset they create. None of them is
governed by this ADR.

- **Tile services and rendering.** COG → `z/x/y` tiles (a resampling and
  colour choice), MVT extraction from PMTiles at request time, MapLibre
  style rendering, terrain composition. Request-time work is by definition
  not an upload-time derivation. This is reearth-untiled's domain (ROADMAP,
  ADR-006 §8).
- **Spatial bundling and reverse indexes.** Combining many assets into one
  cloud-optimized file, and answering "which assets touch this tile".
  Multi-source (condition 3) and GIS-specific.
- **Interpretive derivations.** OCR, transcription, embeddings, detection,
  AI search. Condition 4.
- **Format-aware asset models and publish workflows.** The MVP's
  auto-created service endpoints, draft/published state, and per-format
  "How to Use" panels. Valuable product surface; belongs to whoever builds
  the product.
- **Catalogues and search.** STAC Collections and `/search`, static or
  served. Serve exposes one Item per asset (once extraction is admitted);
  aggregating Items is an application's.
- **Dependency graphs.** ADR-006's asset edges, dirty propagation and
  `dirty → pending → ready` state machine track relationships *between*
  assets and act on them. Under §1 and §3 the engine records lineage
  (slots, `derivedFrom`) but never acts on it: no propagation, no
  invalidation, no traversal. ADR-006 stays Proposed; its edge table,
  state machine and propagation are application scope unless re-admitted
  by a later ADR. Its internal write-back API (§9 there) survives,
  narrowed to slot registration and `derivedFrom` (§3, §3a).

An application may ship under the Re:Earth Serve name, as a bundled
product, or as a separate service; that is a product decision made against
business requirements and is outside this ADR. Whatever the packaging,
the engine's admission rule (§2) does not bend for it: a capability that
fails the four conditions is built as an application, however it is
branded.

### 6. The application interface

The surface an application builds on is the engine's existing public
surface, plus one write-back path. Nothing here is new API; the decision is
that this list is *complete* — an application that needs more than this is
asking for an engine change and goes through §2.

| Need | Surface |
|------|---------|
| Read source bytes | `/files/:id/…`, `Range`, `ETag`, version-ID URLs (immutable) |
| Know when there is new work | `asset.version.created`, `asset.derivation.ready` events (ADR-007) |
| Store a result of one version | **Register a slot** on that version under an application-named role (§3); an archive is extracted into the slot |
| Store a result of several sources, or one it must own | Upload a **new asset** in the same project with `derivedFrom` (§3a) |
| Claim work before starting it | Mark the slot `pending` (§3); the claim expires |
| Read system metadata | `meta` on assets and versions (extraction output, slot listing, `derivedFrom` land here) |
| Restrict who may read | Access modes, grants, signed URLs (ADR-014) |
| Authenticate as a machine | API keys (ADR-014 §3) |

A slot is served under its parent's URL (`/files/:id/_<role>/…`, and the
version-ID form for an immutable link) and is listed on the version. An
application's independent output is an ordinary asset: it has versions,
access control, events and a `/files/` URL like anything else. Serve does
not distinguish "an asset untiled produced" from "an asset a user
uploaded" except through `derivedFrom` and the rest of `meta`.

## Alternatives Considered

### Webhook-only: the engine derives nothing

Serve stores and notifies; every derivation, thumbnails included, is an
application listening to events. Cleanest boundary on paper. Rejected
because it breaks the one promise that makes the engine worth building on:
"anything put in Serve can be read with `Range`, in a form its readers
already understand." A plain GeoTIFF is not that; a zip is not that; a
20 MB JPEG is not that for an asset picker. Without a built-in set every
application must first re-implement the same structural work, and users
must run an application to get a usable file back.

### Format-aware engine: the MVP shape

Assets carry a `format`, publishing creates format-specific endpoints,
Serve serves tiles. This is what the prototype validated and what users
found delightful. Rejected as the *engine* because every new format is a
change to Serve, request-time work moves into the delivery path, and the
untiled boundary disappears. Adopted as the *reference shape for an
application* (§5).

### Every derived artifact is an independent asset

Thumbnails, COGs and 3D Tiles all become assets with a parent reference,
so that there is one kind of thing. Rejected. Four thumbnails per photo
means five assets per upload and a listing that needs a filter; access
mode must be kept in sync with the parent by rule; storage is
double-counted or special-cased; and the moment the parent gets a new
version the question "does the child get one too?" is dirty propagation
by another name — a depth-1 asset is a depth-1 DAG. Above all it is the
CMS failure mode: the link from CityGML to its 3D Tiles is one more
field somebody has to fill in, instead of the place the result was
written. Kept only for what genuinely cannot hang from one version
(§3a).

### Slots without application registration

The engine fills slots from its built-in set; applications only ever
create assets. Cleaner in one way — the engine never stores bytes it did
not derive itself — and rejected for the same CMS reason: an application's
single-source result would land as a flat sibling of its source, and
lineage would once again be a convention rather than a record.

### Dependency DAG in the engine

Keep ADR-006's edges and dirty propagation in Serve so that applications
get invalidation for free. Rejected for now: cross-asset relationships
require the engine to understand which assets are related and why, which
is domain knowledge; a one-generation slot model needs no graph, no cycle
detection and no propagation. If two applications end up building the same
graph, that is the signal to re-admit it.

## Consequences

### Positive

- One rule decides every "can Serve also…" request. The set is enumerable
  and each entry has an ADR.
- The engine stays portable (ADR-012): every built-in derivation is a pure
  function of bytes, runnable on any runtime that can run the processor.
- Applications get a usable substrate on day one — `Range`-readable,
  thumbnail-bearing, metadata-bearing assets — without becoming part of
  the engine.
- Processor-hash naming removes an entire class of migrations.
- Lineage for the common case (one source, one tool, one result) is a
  by-product of writing the result back, not a field to maintain.

### Negative

- Two of the MVP's most visible features (auto tile services, publish
  workflow) are explicitly not coming to the engine. Anyone expecting the
  MVP's UX from Serve alone will need the application that provides it.
- ADR-006 is narrowed without being rewritten. Until a follow-up either
  re-admits its cross-asset parts or moves them to an application ADR, the
  two documents disagree on where the DAG lives; this ADR wins.
- ROADMAP Phase 4 (derived assets and dependency graph) is affected the
  same way.
- The admission rule is a judgment in edge cases (GeoJSON → FGB vs
  GeoParquet). The rule reduces the argument to one question — does the
  choice depend on use? — but does not remove it.
- A slot doubles storage for its parent (GeoTIFF plus COG, CityGML plus
  3D Tiles), and it is the parent that pays. A user who only wants the
  derived form uploads that form instead.
- An application-registered slot carries an unverified processor claim.
  The engine records provenance; it does not attest to it.
- Role names are a small namespace shared by all applications on one
  Serve. Registering a role that is already filled on that version is a
  409, not a merge; registering an engine-owned role is a 403.

## Follow-ups

- ADR for header metadata extraction and the per-asset STAC Item.
- Revise ROADMAP's "Serve does NOT do" list to match §2 and §5 (done
  alongside this ADR).
- Decide whether GeoTIFF → COG enters the set or stays in untiled Phase 3;
  that ADR must answer the "depends on use" question for block size and
  overview resampling.
- ADR for slot registration and `derivedFrom`: the write-back API shape,
  the `pending` claim and its expiry, role naming, how a slot appears in
  `GET /api/v1/assets/:id/versions/:vid` and in the file listing, and
  how archive extraction is reused for a slot prefix.
- Resolve ADR-006's cross-asset scope.
