# ADR-017: Content-Addressed Blobs, Upload Integrity, and the Scope of Deduplication

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** @rot1024
- **Related:** ADR-000 (upload paths), ADR-005 (versions), ADR-010 (large
  uploads), ADR-012 (portability), ADR-014 (access modes), ADR-015 (engine
  boundary, derived slots), ADR-018 (archives served in place, job
  failure classes)

## Context

Serve's ledger (the D1 rows for assets and versions) and its bytes (the R2
objects) are linked today by **naming convention only**:

| Concern | Today |
|---------|-------|
| Object key | `assets/{assetId}/v/{versionId}/{filename}`; both IDs are random (ULID-style) and say nothing about the bytes |
| Immutability of a version | A promise in code — version keys are never overwritten — not a property of the key |
| What the ledger knows about the bytes | `size`, `contentType`, `contentEncoding`. **No hash** |
| Integrity on upload | None. Direct `PUT` streams the body into R2 as is; presigned multipart collects per-part ETags and passes them to `CompleteMultipartUpload`. No `Content-MD5`, no `x-amz-checksum-*` |
| Integrity on read | None. The store's ETag is surfaced as the HTTP `ETag` for `304`s and nothing else |
| Duplicate uploads | Two uploads of the same bytes are two assets (or two versions), stored twice |
| Order of writes | **Bytes first, ledger second** — `storage.put` then one atomic `createAsset` (asset row, job row, usage counters); presigned: complete multipart → `head` → `createAsset`. If the ledger write fails the object is deleted in compensation |
| Orphans | Cleanup is driven from the ledger (expired assets, `cleanup_pending` prefixes). An object with no row is not swept |

The one hash in the system is the CLI's `file sync`, which compares a local
MD5 with the store's ETag to skip unchanged files — a transfer optimisation,
not a statement about the ledger, and one that falls back to size
comparison because a multipart ETag is not an MD5.

Two things now want more than a convention. ADR-015 names derived
artifacts by *input hash × processor hash*, which needs an input hash to
exist. And the trust model in ADR-014 — grants, signed URLs, datasets that
are sold — makes "the bytes behind this version are the bytes that were
uploaded, and nobody swapped them" a claim Serve should be able to prove
rather than assume.

The design sketch this ADR answers:

> Put bytes at a content address (key = SHA-256) and commit only hash +
> metadata to the ledger. The hash *is* the reference, so the ledger's
> authenticity reaches the bytes: verify after fetch and a swap is detected.
> The ledger entry is the original; the object is its vessel. Content
> addressing gives immutability by construction — no cache invalidation,
> and it is the first element of the derived-artifact key. Bytes first,
> ledger second, never a signed reference to bytes that are not there.

And the objection that comes with content addressing: if two uploads of the
same bytes short-circuit, **an uploader learns that someone else already has
that file** — the cross-user deduplication leak that Dropbox once shipped.
Under ADR-014's marketplace, that means a buyer can probe whether a
partner's dataset exists here. This ADR has to say where deduplication
stops.

## Decision

### 1. Every version carries a SHA-256, and the store verifies it

The version row gains `sha256` (hex) and `integrity`:

| `integrity` | Meaning |
|-------------|---------|
| `verified` | The store or Serve computed the hash over the stored bytes and it matches the ledger |
| `pending` | Bytes are in place, hash not yet confirmed (presigned multipart, see §2) |
| `failed` | Declared hash did not match; the version is unreadable and is deleted |

Clients **may declare** the hash on upload (`X-Content-SHA256`, or a field
of the upload session). The CLI always does — the file is local, and a pass
over a few hundred MB is cheaper than the upload. When no hash is declared,
Serve computes and records one; the version is still `verified`, just not
against a client claim.

`sha256` is the hash of the **stored bytes** — after the CLI's gzip, if it
gzipped. It identifies what the store holds and what a `Range` request
slices; it is what ADR-015's derivations hash as their input. A hash of the
decompressed representation can be a second column later if a consumer
needs it; none does today.

### 2. Verification happens where the bytes land

Three upload paths, three ways to verify, one invariant: **no version is
`verified` until the stored bytes have been hashed by something other than
the client.**

| Path | How the hash is checked |
|------|-------------------------|
| Direct `PUT` through the Worker (≤ 100 MB) | The R2 binding is given the declared hash (`put(key, body, { sha256 })`); R2 rejects a mismatch and nothing is written. Without a declaration, the Worker hashes the stream as it passes and records the result |
| Presigned single `PUT` | The presigned URL carries the declared checksum header (`x-amz-checksum-sha256`) so the store verifies on write. Portable: S3 and GCS accept an equivalent |
| Presigned multipart (> 100 MB) | Per-part checksums protect the transfer, but the whole-object SHA-256 is not something the store computes. The version is created `pending`; a built-in derivation (ADR-015 §2 — deterministic, bounded, structural) streams the object once, hashes it, and flips the row to `verified` or `failed`. A `pending` version is servable — the bytes are there and the declared hash is recorded — but a `failed` one is deleted and the asset's active version is left where it was |

A version that fails verification never becomes active and never enters a
derived slot. The declared-but-wrong hash is therefore "a name nobody can
read": the harm collapses to a rejected upload.

Serve does **not** re-hash on every read. The cost would be the whole
object per request, and the store's own integrity (ETag, R2's internal
checksums) covers bit rot. What Serve does is expose the ledger's hash on
the response (`X-Content-SHA256`) so a consumer that wants proof can verify
after fetch — the ledger's authenticity reaching the bytes, on the client's
terms.

### 3. Bytes are stored by content address, under a blob layer; URLs stay ID-based

Storage gains a blob layer:

```
blobs/{scope}/{sha256}                  ← the bytes, written once (scope: see below)
assets/{assetId}/v/{versionId}/…        ← unchanged for extracted archives, slots, thumbnails
```

A version row points at its blob (`sha256` + `workspaceId` identify it).
The **URL identity does not change**: `/files/{assetId}/…` and
`/files/{versionId}/…` resolve exactly as ADR-005 says, through the
version row to the blob. Nothing about content addressing is visible in a
URL, which is deliberate:

- URL stability is the whole point of ADR-005. A hash in the path would
  change on every re-upload and give away what the file is.
- Immutability of `/files/{versionId}/…` now follows from the key: a
  version's blob is a hash, and a hash names one byte sequence. The year-long
  `immutable` cache policy (ADR-013 A2) rests on structure, not on discipline.

**Only a declared hash gets a blob key.** The key has to be known before
the first byte is written, and without a declaration the hash is known
only after the last. A direct `PUT` cannot be buffered (the Worker has
128 MB), and a presigned upload's key is fixed when the session is
created. Staging under a temporary key and copying afterwards would work,
but for a 250 GiB multipart object the copy is itself a multipart job. So:

| Upload | Stored at | Recorded |
|--------|-----------|----------|
| Hash declared | `blobs/{scope}/{sha256}` | `sha256`, `integrity` |
| No hash declared | `assets/{assetId}/v/{versionId}/{filename}`, as today | `sha256` (computed), `integrity` |

Both kinds are verified as §2 says; only the first takes part in
deduplication (§4). The CLI always declares, so in practice CLI uploads
land in `blobs/` and only direct API callers (`curl`, hand-rolled
presigned clients) stay on the per-version key. The version row records
which key holds its bytes, so readers do not have to guess.

**One writer per blob.** A store-verified write (direct `PUT` with the
declared hash, presigned single `PUT` with a checksum header) cannot leave
wrong bytes under a blob key: a mismatch writes nothing. A presigned
multipart upload can, because the store checks parts, not the whole
object, and the whole-object hash is confirmed only afterwards. To keep a
bad multipart upload from overwriting a good blob:

- if the blob already exists in the scope, the session short-circuits
  (§4) and no upload URL is issued;
- otherwise the session claims the blob in the ledger (`blob_refs` row in
  an `uploading` state); a second session for the same scope and hash is
  refused with 409 until the claim completes or expires;
- a verification failure deletes the blob only while the claim is still
  the sole reference.

**Scope.** `{scope}` is the workspace ID. A project with no workspace uses
`p_{projectId}`, and demo-mode assets use `_demo` (below). The scope is the
unit of deduplication in §4.

Extracted archive entries and derived slots keep their per-version prefix.
Their hashes are recorded in the extraction manifest and slot metadata
(ADR-015 §3), and content-addressing them individually is a follow-up — the
small-file count makes a blob-per-entry layout a different cost question.

Demo-mode assets (no project, one-hour TTL) get a blob namespace of their
own, `blobs/_demo/…`, so a demo upload never touches a workspace's blobs.

### 4. Deduplication is scoped to the workspace, and never short-circuits across it

The blob key includes the workspace ID on purpose. Deduplication — one blob
for many versions — happens **inside a workspace only**.

Within a workspace, short-circuiting is allowed and is a feature: the CLI
may send `X-Content-SHA256` with an empty body, and if the blob exists the
version is created without transfer (`ifGenerationMatch: 0`-style idempotent
upload, for free). Everyone in a workspace can already read its assets, so
"this file is already here" tells them nothing they could not see in the
list.

Across workspaces, Serve **never** answers differently for a duplicate:

- The full body is received, hashed, and — if the bytes already exist in
  *this* workspace — not written again; if they exist only in *another*
  workspace, they are written again under this workspace's key. Cross-tenant
  storage saving is given up. Cross-tenant bandwidth saving was never on the
  table, since saving it is the leak.
- The response has the same shape and the same fields whether or not the
  bytes were new. No blob creation time, no reference count.
- Storage usage (ADR-004) is charged per version, as if every version were
  a copy. A quota that fails to move on a duplicate is itself a signal.
- The body is read to the end even once a match is certain. Finishing
  early is a signal.
- The finalisation step does the same work in both cases (a duplicate does
  a no-op write of comparable cost) so the tail of the request does not
  differ measurably. Edge timing noise would likely hide the difference;
  matching the work costs nothing and removes the argument.

Public assets (`access: public`, ADR-014) are the one place where
cross-workspace sharing would be harmless — anyone can read them anyway. It
is **not** done in this ADR: an asset can go from `public` to `restricted`,
and untangling a shared blob at that moment is exactly the kind of
special case that grows. Revisit if PLATEAU-scale public datasets make the
duplicate storage cost real.

### 5. Order of writes, and orphans

The invariant stays as it is today, now with a name: **bytes, then hash,
then ledger.** A version row is written only after its blob is in place and
either verified or explicitly `pending`. There is never a signed reference
— a version row, a slot entry, a `derivedFrom` — to bytes that are not
there.

Consequences for cleanup:

- Blobs are reference-counted in the ledger (`blob_refs`: workspace, sha256,
  count). Deleting a version decrements; a blob at zero is swept by the
  cleanup cron after a grace period, not deleted inline — a concurrent
  upload of the same bytes may be about to reference it.
- A blob with no row at all (the ledger write failed after the bytes
  landed, and the compensation delete also failed) is an orphan. The
  existing D1-driven cleanup cannot see it; a periodic list of
  `blobs/{workspace}/` reconciled against `blob_refs` can, and does.
- Upload sessions keep their TTL. A session that never completes leaves a
  multipart upload the store aborts on its own schedule, as today.

### 6. What this gives ADR-015

Derived artifacts are named by *input hash × processor hash*. With §1 the
input hash exists for every version, and with §3 it is the blob key: a
derivation's identity is `sha256(input) · processorId · processorVersion`,
stable across re-uploads of identical bytes and across workspaces (the
derivation is deterministic by admission; the *storage* of its output is
still per version, per §3). Slot registration by an application records
the output's `sha256` the same way, so a slot is as verifiable as an
upload.

## Alternatives Considered

### Hash in the URL

`/files/{sha256}/…` — content addressing all the way to the consumer.
Rejected: it breaks ADR-005's stable URLs (every re-upload is a new URL),
leaks the hash of private data to anyone who sees a link, and gains
nothing the version-ID URL does not already give once the version is
backed by a blob.

### Global deduplication

One blob per hash across the whole deployment. Rejected for the reason in
the Context: it turns upload into an oracle for "does anyone here have this
file", which is unacceptable under ADR-014 and unnecessary for the storage
bill at Serve's scale. Workspace-scoped deduplication keeps the idempotent
upload where it is safe and gives up the saving where it is not.

### Proof of possession instead of scoping

Answer a hash-only upload with a challenge (send bytes at these offsets)
before short-circuiting. Rejected as the primary defence: it stops an
attacker who knows only the hash, not one who holds the file — and the
marketplace threat is the latter. It could be added on top of §4 to make
in-workspace hash-only uploads stricter, but it is not needed there.

### No hashing; keep the convention

Rejected. ADR-015 cannot name derivations without an input hash, and
ADR-014 makes "these bytes are what was uploaded" a claim worth being able
to prove. The cost — one hash column, one verification path per upload
route — is small.

## Consequences

### Positive

- The ledger's authenticity reaches the bytes. A consumer can verify after
  fetch; a swapped object is detected; a mistaken client claim rejects the
  upload rather than poisoning the store.
- Version immutability is structural. The year-long cache policy stops
  depending on nobody ever overwriting a key.
- Idempotent re-upload inside a workspace, and the CLI's `file sync` gets a
  real content hash instead of an ETag that may or may not be an MD5.
- ADR-015's derivation keys have their first element.
- Deduplication cannot be used to probe other tenants.

### Negative

- A new layer (`blobs/`) and two new ledger tables/columns; a migration
  that backfills `sha256` for existing versions by reading them once (a
  cleanup-cron job, workspace by workspace).
- Presigned multipart uploads spend one extra full read to verify, and
  are `pending` for that window. For a 250 GiB archive that is minutes.
- No cross-tenant storage saving, by design. Ten workspaces holding the
  same PLATEAU archive hold it ten times.
- The Node runtime (ADR-012) has no store-side checksum on `put`; it
  verifies by hashing the stream in-process, which is what it already does
  for everything else.

## Follow-ups

- Migration plan: backfill order, whether `integrity` may be `unknown` for
  pre-ADR versions during the backfill, and what the API shows meanwhile.
- Content-addressing extracted archive entries and slot contents
  individually (a blob-per-file layout) — a separate cost question. If
  ADR-018 serves zip entries in place from the archive's blob, an entry is
  a byte range of that blob and the question applies only to archives that
  are still extracted.
- Whether `public` assets should share blobs across workspaces once a real
  duplicate-storage bill exists.
- A `sha256` on `derivedFrom` links (ADR-015 §3a) so a loose link can at
  least say which bytes it meant.
