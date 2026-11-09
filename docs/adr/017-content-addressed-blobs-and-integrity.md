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

- Migration plan: settled by P4 (see Implementation status). There is no
  `unknown` state; a pre-ADR row omits both fields until it is hashed.
- Content-addressing extracted archive entries and slot contents
  individually (a blob-per-file layout) — a separate cost question. If
  ADR-018 serves zip entries in place from the archive's blob, an entry is
  a byte range of that blob and the question applies only to archives that
  are still extracted.
- Whether `public` assets should share blobs across workspaces once a real
  duplicate-storage bill exists.
- A `sha256` on `derivedFrom` links (ADR-015 §3a) so a loose link can at
  least say which bytes it meant.

## Implementation status

**P1a — integrity, no storage layout change (done).** Object keys are as
before; there is no `blobs/` layer yet.

- Ledger: migration `0008_content_sha256.sql` adds `sha256` (lowercase hex)
  and `integrity` to `asset_versions` **and** `assets`. The asset row needs
  them because a first upload creates no version row (ADR-005); its hash
  lives where its `size` does. NULL on both means "stored before ADR-017";
  the API omits the fields for such rows.
- Declaring: `X-Content-SHA256` on `POST /api/v1/assets` and
  `POST /api/v1/assets/{id}` (64 hex characters, any case, stored lowercase;
  malformed → 400), and a `sha256` field on `POST /api/v1/assets/uploads`.
- Direct `PUT` through the Worker: `FileStorage.put` takes the declared hash
  and returns the SHA-256 of what it stored. The R2 adapter passes a declared
  hash to `bucket.put(…, { sha256 })` and otherwise hashes in line through
  `crypto.DigestStream`; the memory adapter (Node) hashes with `node:crypto`
  and writes nothing on a mismatch. A mismatch is `ChecksumMismatchError` →
  **422**, with no object and no row. Either way the row is `verified`.
- Presigned single `PUT`: a declared hash is signed into the URL as
  `x-amz-checksum-sha256` (base64), and the session response lists it in
  `headers`. R2's S3 API reference does not list the `x-amz-checksum-*`
  headers under `PutObject`, though its checksum table names SHA-256, so
  store-side verification there is not confirmed. Completion therefore
  trusts only what the store itself reports: when `head` returns a SHA-256
  for the object (R2 `checksums.sha256`), the row is `verified` (a
  different hash from the declared one deletes the object and answers 422);
  when it does not, the declared hash is recorded as `pending`.
- Reads: `/files` sends `X-Content-SHA256` (CORS-exposed) only when the body
  is the upload's own stored bytes — whole, ranged, or gzip passed through —
  and never for extracted entries, decompressed bodies, thumbnails or
  `404.html`. Asset and version JSON carry `sha256` and `integrity`.

**P1b — the verification job (done).** Every presigned upload the store did
not vouch for is now hashed once by Serve.

- Scope: only first uploads go through upload sessions; a new version is
  uploaded through the Worker and verified in line (P1a). So the job always
  settles an **asset** row. Completion records `integrity: "pending"` for a
  declared multipart or unconfirmed single PUT (with the declared `sha256`)
  and, new in P1b, for an undeclared presigned upload (no `sha256`), and
  writes an `integrity-verification` job in the same batch as the asset.
- Job: a new job type, `integrity-verification` (`JobType` in the OpenAPI
  document), on the existing machinery: the extraction queue carries its
  messages (`kind: "integrity-verification"`), the cleanup cron re-sends it
  when it is stuck or failed, and `/api/v1/jobs` lists it. Its ID is its own;
  the asset's `jobId` stays the extraction's. The failure class of ADR-018 §6
  is derived from the job type (`jobFailureClass`, `core/job/model.ts`)
  rather than stored, since every job of a type has the same class:
  extraction is "missing feature", verification "rejected version".
- Verdict (`core/integrity/verification.ts`): the verifier only reports the
  hash; Serve compares. Nothing declared, or a match → `verified` with the
  computed hash. A mismatch → the asset is deleted through the ordinary
  `deleteAsset` use case (rows, bytes, extracted output, usage counters, site
  hosts released), the archive's extraction job is closed, and the
  verification job ends `failed` with both hashes in `error` and its retry
  count past the budget, so nothing re-runs it. A mismatch is final. A read
  error is transient: the job fails with budget left and the cron re-runs it;
  if it runs out of retries the upload stays `pending` and servable and no
  `status` is touched. `failed` is therefore never written to a row: a
  rejected upload has no row left to carry it. The uploader is not notified
  beyond the job record; there is no notification channel yet.
- Active version: a rejected first upload has no versions to protect,
  because while a *declared* first upload is pending the asset refuses new
  versions with `409` (`UploadUnderVerificationError`). An undeclared one
  cannot fail, so it does not block. "The active version is left where it
  was" then holds trivially: the only thing deleted is the asset that never
  had another version.
- Archives: verification runs in parallel with extraction, since a pending
  upload is servable. A rejection deletes the asset while the extractor may
  still be writing; the extractor checks `/api/internal/assets/:id/exists`
  at every checkpoint and stops at the 404. Its final status report, which
  comes after its last write and its log, finds the asset gone and re-queues
  the asset's prefix in `cleanup_pending`, so the cron removes what it wrote
  after the delete. The cron also now closes extraction and verification jobs
  whose asset is gone instead of skipping them every tick.
- Where it runs. Cloudflare: the archive-extractor image in `MODE=verify`
  (`container/archive-extractor/verify.go`), launched through the extractor's
  Durable Object class under its own name (`verify:{jobId}`). It needs what
  extraction needs (S3 credentials, the callback secret, long lifetimes), so a
  separate container class would duplicate the image and the lifetime
  handling for nothing. It streams the object over the S3 API, resumes a
  broken read at the offset it reached (up to five attempts), posts
  `running` every two minutes, and reports `completed` with `sha256` or
  `failed` to `POST /api/internal/jobs/:id/status` with
  `INTERNAL_API_SECRET`. Node: `ContainerLauncher.verifyIntegrity` hashes in
  process and returns the hash, which the queue consumer settles at once.
  `core/` sees one port and does not branch on the runtime. Verifying small
  objects inside the Worker queue consumer was not done: every object still
  goes to the container.
- Ledger safety: the job-status callback rewrites the asset row from a copy
  read earlier, so the asset upsert keeps `sha256` / `integrity` once the row
  is `verified`, whatever the copy says.

**P2 — the blob layer (done).** Declared uploads are stored at
`blobs/{scope}/{sha256}`; undeclared ones keep their per-asset key. URLs,
responses and usage accounting do not change.

- Ledger: migration `0009_blob_layer.sql` adds `blob_key` to `assets` and
  `asset_versions` (NULL = the classic key) and the `blob_refs` table (`key`,
  `scope`, `sha256`, `ref_count`, `state`, `claim_id`, `claim_expires_at`,
  `zero_since`). `blob_key` is written when the row is created and never moves:
  the asset upsert keeps an existing value over the model's. Every reader
  resolves the original object through `originalKey` (`core/blob/model.ts`):
  `/files`, the file listing, extraction launches and retries, thumbnail
  messages, the verification message's `objectKey`. Extracted entries,
  thumbnails and slots stay under the asset's prefix, so site hosting
  (`core/site/hosting.ts`), which reads only extracted entries, is unchanged.
  The extractor and verifier read the key they are given (`ARCHIVE_KEY`,
  `OBJECT_KEY`) and derive only their output prefix from IDs, so the container
  contract is unchanged. `blobKey` is on the domain model but not in the API:
  responses go through `core/asset/response.ts`, which drops it.
- Scope: `blobScope` (`core/blob/model.ts`) — the project's workspace,
  `p_{projectId}` when the project has none, `_demo` without a project.
- States: `uploading` (claimed by a session, no reference yet), `verifying`
  (claim completed, hash not yet confirmed), `ready`, and `deleting` — the lock
  a sweep takes before it removes an object. Nothing reserves, claims or
  attaches to a key in `deleting`, so an object cannot be rewritten between a
  sweep's decision and its delete.
- Direct uploads (first upload and new version) are store-verified, so they
  *reserve* the key: allowed when it is free, `ready`, or held by an expired
  claim. Reserving a key no row references restarts its grace clock, so no
  sweep can take it while the bytes are in flight. The body is always written,
  which rewrites identical bytes when the blob exists; skipping the write is
  P3. When the key is claimed, unverified or being deleted, the upload goes to
  its classic key instead. The reference is taken in the same batch as the row
  (`AtomicWrites.createAsset` / `createVersion`, `blob` input), after the bytes.
  A failed row write no longer deletes the object when it is a blob: other
  rows may reference it, and the sweeps reclaim it if none does.
- Presigned sessions with a declared hash, single PUT or multipart, *claim*
  the key (R2 keeping the single PUT's checksum is still unconfirmed, so it is
  not treated as store-verified). A live claim by another session → **409**;
  the claim lasts as long as the session. When the blob already holds bytes
  (`ready`, `verifying`, `deleting`) the session falls back to its classic key:
  refusing would break a client that uploads the same file twice, and
  overwriting is what §3 forbids. P3 replaces the fallback with the
  short-circuit. Completion checks the claim is still the session's, then
  turns it into the first reference — `ready` if the store vouched for the
  hash, `verifying` otherwise. A store-reported mismatch at completion deletes
  the object before releasing the claim.
- P1b on a blob: a match marks it `ready`. A mismatch deletes the asset
  through `deleteAsset` (which releases its reference) and then the object
  only if no other row references the key (`discardRejectedBlob`). In P2
  nothing can — only a `ready` blob takes new references — but the rule is in
  place for P3.
- Deletes: `deleteAsset` releases the references the asset row and its
  versions hold, counted from the rows inside the batch so a version created
  meanwhile is not missed. Version deletion is now one atomic write
  (`AtomicWrites.deleteVersion`): row, blob reference and usage decrement; the
  usage decrement used to be separate calls in the route. Demo TTL expiry goes
  through `AtomicWrites.deleteAsset` too. No path deletes a blob object inline.
  A blob at zero gets `zero_since`.
- Cleanup cron (`sweepBlobs`, `core/blob/usecase.ts`), after the prefix
  drain and on the same subrequest budget: drop `uploading` claims past their
  expiry (a partial multipart upload is left to the store's abort policy);
  delete blobs with `ref_count = 0` for `BLOB_GRACE_MS` (24 h), finishing any
  `deleting` lock a crashed sweep left; then reconcile one page of 200 `blobs/`
  keys against `blob_refs`, deleting objects with no row whose store-reported
  write time (`FileStorage.head().uploadedAt`, R2 `uploaded`) is older than the
  grace period. The listing cursor lives in the `cache` KeyValue; losing it
  restarts the listing.
- Usage (ADR-004) is unchanged: counters move per asset and version row by
  the row's size, whether or not the bytes are shared.

**P3 — deduplication inside the scope (done).** An upload of bytes the
scope already holds no longer writes them again. Responses, URLs and usage
accounting do not change.

- When bytes can be reused (`isReusable`, `core/blob/usecase.ts`): the blob is
  `ready` and at least one row references it. Rows are written only after
  their bytes (§5) and objects are deleted only at zero references, so such a
  blob has its object. A `ready` row at zero is never reused: it may be a
  reservation whose write failed. `verifying`, `deleting` and claimed blobs
  are not reused either; uploads of them behave as in P2. The lookup is by
  the uploader's own blob key, so no other scope is ever consulted.
- Direct uploads (first upload and new version, `storeDirectUpload`,
  `core/blob/direct-upload.ts`). The body is still read to the end and hashed,
  through a new `FileStorage.digest` (R2: `crypto.DigestStream`; Node:
  `node:crypto`) that stores nothing and checks the length as `put` does. A
  mismatch is still 422 and an overrun still 400. Then, in place of the
  `put`, the blob is `head`ed: one store round trip for another, it confirms
  the object is there before a row points at it, and it gives the size.
  Matching the write's cost exactly was not done, because §4's timing argument
  is about other workspaces, and an upload whose bytes exist only in another
  workspace finds nothing in its own scope and writes like any fresh upload.
  Inside the scope, "these bytes are already here" is not a secret.
- The row a reused upload writes is the one a full upload of the same bytes
  would have written: `size` from the stored object, `contentType`,
  `contentEncoding` and `originalSize` from the request, the declared
  `sha256`, `integrity: verified`, the blob key. `/files` serves an original by
  its row's type and encoding, never the object's metadata, so the first
  writer's metadata on a shared blob does not leak into later rows.
- Empty body. A direct upload with `X-Content-SHA256` may send
  `Content-Length: 0` (or no body). That is an ordinary upload of zero bytes:
  when the scope holds the declared bytes, the asset or version is created
  from them; when it does not, the empty body is checked against the
  declaration like any other body — 422 with the usual message, and no
  reservation is taken. The SHA-256 of zero bytes matches an empty body, so
  that declaration stores (or reuses) an empty file. Without a declared hash,
  `Content-Length: 0` is still 400.
- Presigned sessions with a declared hash of reusable bytes take no claim and
  issue no URL. The response is a `MultipartUploadSession` with `parts: []`
  (whatever `partCount` was), plus `contentEncoding` when the server
  compresses the file, as for any session. That shape is the least
  disruptive one: the CLI and any client that handles multipart already
  upload nothing for an empty list and then call `complete`, which creates
  the asset (`verified`, no verification job, the blob's size, the session's
  encoding). Creating the asset at session creation instead would have given
  the session endpoint a second response type. The session records
  `blobReuse`. The 409 for a live claim and the fallback to the classic key
  for `verifying`, `deleting` and unreferenced blobs are unchanged.
- Encoding on sessions. A session's `contentEncoding` is the server's
  decision, and a client must hash the gzipped bytes it will send. A client
  that hashed the raw file would fail verification when uploading; reused, its
  asset would label raw bytes `gzip`. So a session the server compresses
  reuses a blob only if the blob starts with the gzip magic bytes (a two-byte
  range read); otherwise it falls back to an upload. A direct upload needs no
  such check, because its `Content-Encoding` is the client's own statement
  about the bytes the hash names.
- Races. The reference is attached in the same batch as the row, and on
  condition (`BlobAttach.existing`; `blobAttachExistingStatements`,
  `adapters/sql/blob-refs.ts`): the blob must still be `ready` with
  `ref_count > 0`. D1 has no interactive transaction and `RAISE()` works only
  in triggers, so a failed condition is a NOT NULL violation on
  `blob_refs.state` (an INSERT for a missing row, an UPDATE for one that does
  not qualify), which aborts the whole batch: no row, no usage, no reference.
  The use case then reads the blob row again; if it no longer qualifies the
  error is `BlobUnavailableError`, otherwise the original error is passed on,
  so no driver wording is parsed. The body is gone by then and was not
  stored, so the route answers **409** ("deleted while the upload was in
  progress … upload again"). 409 rather than 503: nothing is wrong with the
  server, the resource changed under the request, a retry succeeds at once
  (it finds no reusable blob and writes in full), and the other "retry once
  the state changes" answers on these routes are already 409. A session
  whose blob is gone at completion (head or attach) answers 409 and is
  deleted, since it can never complete; the client starts a new one. The
  condition requires a reference, not only `ready`, because a blob may reach
  zero during the read, be swept after its grace period, and be re-reserved
  by a failed upload as `ready` with no object. Sweeps need `BLOB_GRACE_MS` at
  zero and the `deleting` lock, so in practice the 409 happens only when the
  last other row holding the bytes is deleted while the body is in flight.
- Usage (ADR-004) moves per row as before: a reused upload increments the
  project and workspace counters by its size in the same batch.
- P1b. A reused upload attaches to a `ready`, already verified blob, so its
  row is `verified` and has no verification job. `discardRejectedBlob` is
  unchanged: a rejected blob never left `verifying`, the conditional attach
  refuses a `verifying` blob, so the rejected upload's reference is normally
  its only one, and `markDeleting` still requires zero references.

**P4 — backfill of pre-ADR rows (done).** Assets and versions stored before
ADR-017 get their hash recorded by a background job. URLs, responses and
usage accounting do not change, and nothing moves into the blob layer.

- Where the hash is computed: the P1b verifier, unchanged. Cloudflare runs
  the archive-extractor image in `MODE=verify` (the container only hashes
  and reports, and never sees a declared hash, so it needed no change);
  Node hashes in process through the same `ContainerLauncher.verifyIntegrity`
  port. A small-object path inside the Worker was not added: it would be a
  second hashing path to keep correct, for rows that the container handles
  anyway.
- Job: a new type, `integrity-backfill` (`JobType` in the OpenAPI document),
  rather than a mode of `integrity-verification`. Verification settles only
  asset rows and can delete the upload; the backfill settles asset and
  version rows and must never delete anything, and the job type is what
  `jobFailureClass` and the status callback branch on. Its failure class is
  a new one, `slower-reads` (ADR-018 §6's optimisation class): nothing a
  reader sees depends on the job, so a failure is retried and then closed,
  and no `status` or `integrity` is ever written by it. It rides the
  extraction queue (`kind: "integrity-backfill"`, `ContextDeps.backfillQueue`)
  and is handled after extraction in a batch. The container reports to the
  same `POST /api/internal/jobs/:id/status`, which dispatches on the job type.
- Selection and pacing (`enqueueIntegrityBackfill`, `core/integrity/backfill.ts`):
  a cleanup-cron step after the blob sweeps, on what is left of the shared
  subrequest budget. It counts the backfill jobs still open (not completed,
  retry budget left) and tops them up to `INTEGRITY_BACKFILL_BATCH_SIZE`
  (default 2) with one page of rows that have no `sha256`, no `integrity`,
  no blob key and **no `integrity-backfill` job of any status**: assets
  first, then versions, oldest first, rather than workspace by workspace as
  the Negative consequences above put it; nothing depends on the order. The
  batch size bounds open jobs, not only new ones per tick, so a few
  multi-hour reads cannot pile up and take the extractor's `max_instances`
  from extraction. `INTEGRITY_BACKFILL_ENABLED=true` turns the step on; it is
  off by default, because turning it on is a capacity decision. Migration
  `0010_integrity_backfill.sql` adds partial indexes over the unhashed rows,
  so the page does not scan every asset every tick and the index is empty
  once the backfill is over.
- No new row state. The job row is the only marker: it is saved before the
  message is sent, so the next tick never selects the row again, and a
  failed send leaves a `pending` job that the cron's retry pass re-sends once
  it is stuck. Readers see either no hash (fields omitted, as for every
  pre-ADR row) or `verified`. Marking the row `pending` while it is hashed
  was considered and rejected: a row whose object is missing would then stay
  `pending` for good, which claims a check is under way when none is.
- Writing the result (`applyBackfillResult`): one batch of the job and a
  conditional `UPDATE` (`SqlIntegrityBackfillStore.complete`) that sets
  `sha256` and `integrity: verified` only while the row still has no hash, no
  integrity and no blob key, and still has the filename its key was built
  from. A row deleted meanwhile closes the job `failed` ("no longer exists");
  a row hashed meanwhile closes it `completed` and keeps its hash. The asset
  upsert's rule that a `verified` row keeps its hash protects the result from
  stale rewrites (the extraction callback). `blob_key` stays NULL.
- Missing objects: before starting a run the consumer `head`s the row's key,
  and a `failed` report is checked the same way. When the store answers "no
  such object", the job is closed (`retryCount` past the budget, the key in
  `error`) and a warning is logged; nothing is written to the row. Because the
  row now has a job, it is never selected again. Any other read failure is
  transient and retried; when the retries run out the job is closed and the
  row stays as it was. `POST /api/v1/jobs/{id}/retry` re-runs either.

**P5 — the CLI declares every upload (done).** Every CLI upload now
declares the SHA-256 of the bytes it sends, uses deduplication where it can,
and handles the 409s by their reason. `file sync` compares by SHA-256 where
the ledger has a confirmed one. Code: `cli/transfer.ts` (uploads),
`cli/hash.ts` (streaming hashes), `cli/sync-compare.ts` (sync).

- When the hash is computed: before the first request, always. An upload
  session needs it at creation (the blob key is fixed before a byte is
  written), and so does the hash-only request below. A file of up to 1 GiB is
  already read into memory for the upload, so it is hashed from that buffer
  and costs only CPU. A larger file is streamed from disk, so it is read
  twice: once to hash it, with a progress line on stderr, and once to upload
  it. A local disk is much faster than any upload link, and that first pass
  is what lets an upload of bytes the workspace holds skip the transfer.
  Hashing while uploading and sending the hash at completion would need the
  blob key to be decided at completion, which §3 rules out.
- What the hash covers: the bytes sent, after the CLI's own gzip. Direct
  uploads already stated their encoding (`Content-Encoding`). Upload sessions
  now take it too (below), so the CLI never predicts the server.
- Gzip on sessions (the open issue from P3). `POST /api/v1/assets/uploads`
  takes an optional `contentEncoding`, `gzip` or `identity`. When given, the
  server stores exactly that encoding and the response's `contentEncoding`
  echoes it; any other value is refused by the body schema (400). When
  omitted, the server decides with `shouldCompress`, as before, so old
  clients are unaffected. The CLI always states it. If a server answers a
  different encoding (one that predates the field), the CLI stops with an
  explanation instead of uploading bytes its hash does not name. Mirroring
  `shouldCompress` in the CLI was not chosen: the two copies would have to
  agree forever, and they already disagreed for files over 1 GiB, which the
  CLI streams without gzip. Those were stored raw under a `gzip` label; they
  are now stated `identity` and stored correctly.
- The P3 gzip guard (`isGzipBlob`) now runs only for a session whose encoding
  the server decided. A stated encoding is the client's own description of
  the bytes its hash names, like a direct upload's `Content-Encoding`, so
  reusing a blob for it records what a full upload of those bytes would.
- Direct uploads (first upload with `--direct` or when presigned uploads are
  unavailable, and every new version) of 1 MiB or more send the hash alone
  first (`Content-Length: 0`). A 201 means the workspace held the bytes and
  nothing else is sent; a 422 (not held) or a 400 (a server older than P3)
  is followed by the full upload. Below 1 MiB the probe would cost about as
  much as the transfer it might save, so the file is sent at once. A version
  upload probes too, so a 409 for a pending first upload costs no transfer.
- Sessions for bytes the workspace holds come back with `parts: []`; the CLI
  uploads nothing and completes with `{ "parts": [] }`. The CLI now also
  computes `partCount` from the bytes it sends, not from the raw size; a
  compressible file between 100 MB and 1 GiB used to request parts for its
  raw size and then send empty trailing parts, which multipart completion
  refuses.
- Error codes. The `Error` schema gained an optional `code` (`ErrorCode` in
  the OpenAPI document): `checksum_mismatch` (422), `upload_under_verification`,
  `blob_claimed` and `blob_unavailable` (409). One mapper
  (`core/asset/handler/errors.ts`) turns the four errors into status, message
  and code for all four upload routes, so an error has one code everywhere.
  The CLI branches on the code, never on the message.
- What the CLI does with each 409:
  - `upload_under_verification`: it waits, polling `GET /api/v1/assets/{id}`
    (5 s, doubling to 60 s) rather than re-sending the body, and uploads the
    version once the asset is no longer `pending`. `--wait <minutes>` on
    `asset upload` bounds the wait (default 30; 0 fails at once). A 404 while
    waiting means the first upload failed verification and was deleted, and
    the CLI says that.
  - `blob_claimed`: a file the Worker accepts directly (100 MB or less after
    gzip) is uploaded directly at once; a direct upload stores at the classic
    key when the blob is claimed, so it succeeds. A larger file retries the
    session after 10, 20, 40, 60, 60 and 60 s, then stops with an explanation.
  - `blob_unavailable`: retried at once, up to twice. On a session the retry
    is a new session, since the old one is spent; it finds no reusable blob
    and uploads.
- `file sync`: the file listing's entry for a single-file asset now carries
  `sha256`, `integrity` and `contentEncoding`. Sync compares by SHA-256 when
  the hash is `verified` and the file is not stored gzipped (the hash names
  the stored bytes; the download is decompressed). A size mismatch decides
  without reading the local file. Otherwise it falls back to the listing's
  MD5 `hash`, then to size, as before. Local hashes are streamed.

All five phases are implemented.

**Open issues.**

- R2's store-side check on a presigned single `PUT` is still unconfirmed
  against a real bucket. Upload with `x-amz-checksum-sha256`, then head the
  object: if R2 keeps the hash, such uploads are `verified` at completion;
  if not, they all go through the verification job.
- The R2 adapter recognises a checksum mismatch by the error message
  (`/sha-?256|checksum|digest|10037/i`). R2 has no typed error for it; if
  the wording changes, a mismatch surfaces as 500 instead of 422.
- Verification runs in the archive-extractor container and shares its
  `max_instances`, so it competes with extraction for capacity. The P4
  backfill does too; `INTEGRITY_BACKFILL_BATCH_SIZE` bounds its share, but
  nothing yields to extraction when the instances run out.
- A rejected upload is recorded only on its job. There is no channel to
  notify the uploader (ADR-018 §6 asks for one).
- `deleteAsset` leaves job rows behind, so the jobs of a deleted asset stay
  listed. This predates ADR-017.
- A blob whose verification runs out of retries stays `verifying`: it keeps
  serving, is never reused (later uploads of it go to their classic key), and
  is swept once nothing references it. Marking a verified blob `ready` is a
  write of its own after the row's; if it is lost, the blob is in that same
  state.
- The orphan sweep needs the store to report when an object was written. R2
  and the memory adapter do; a store that does not leaves orphans alone. A full
  pass over `blobs/` takes one tick per 200 keys.
- Rows stored before P2 have `blob_key` NULL and stay at their classic keys,
  and P4 leaves its rows there too. P4 provides the hash such a move needs,
  so what is left is a copy per object into `blobs/{scope}/{sha256}` (a
  multipart job for a large one) and switching the row's key with a
  reference taken; nothing does it yet. Until then those rows take no part
  in deduplication.
- Backfill rows that cannot be hashed — the object is missing, or the reads
  kept failing until the retries ran out — stay without a hash. They are
  recorded only as closed `integrity-backfill` jobs; finding them means
  listing those jobs, and only a manual retry runs one again.
- Backfill jobs are listed under the asset's project or session like its
  other jobs, so users see maintenance jobs they did not start. The OpenAPI
  `JobType` enum gained `integrity-backfill`.
- The backfill's selection and its job insert are separate statements. Two
  cron ticks running at the same moment could both select a row; the result
  is one duplicate read, and the second write finds the row hashed and does
  nothing.
- A direct upload that reuses bytes gets 409 if the last other row holding
  them is deleted while its body is in flight: the bytes are still there, but
  the attach requires a reference. Relaxing that would need a way to tell
  such a blob from a re-reserved one with no object.
- An empty file can be uploaded directly only with
  `X-Content-SHA256: e3b0c442…b855` (the hash of zero bytes); without a
  declaration `Content-Length: 0` is still 400, as before P3.
- The gzip check on reusing bytes for a session the server decided to
  compress looks at the magic number only. It rules out the likely mistake (a
  hash of the raw file), not every byte sequence that starts with `1f 8b`.
  Since P5 it applies only to clients that do not state `contentEncoding`.
- A session's claim cannot be given up early. An interrupted upload (a CLI
  killed mid-transfer) keeps the blob claimed until its session expires, up to
  24 hours for a large file, and every other session for the same bytes in the
  workspace gets `blob_claimed` meanwhile. The CLI works around it only for
  files small enough to upload directly. An abort endpoint would release it.
- The CLI's wait for a pending first upload is 30 minutes by default. Hashing
  a 250 GiB upload can take about that long once the container is running, so
  a version uploaded right after such an upload may need a longer `--wait`.
- New versions have no upload session. `asset upload` reads the file into
  memory and sends it through the Worker, so versions are limited to what the
  Worker accepts (100 MB on Cloudflare), as before P5.
- Files over 1 GiB are uploaded by the CLI without gzip: compressing them
  would take another full pass to learn the size before the parts are cut.
- `file sync` cannot use the SHA-256 of a gzip-stored file (it names the
  compressed bytes, and the download is decompressed), and extracted archive
  entries carry only the extractor's MD5. Both fall back to MD5 or size.
- A blob's object metadata (`Content-Type`, `Content-Encoding`) is whatever its
  first writer sent. `/files` does not read it, but readers that go through
  the S3 API (the extractor and the verifier) get it with the bytes. This
  started with P2's shared blobs; P3 makes the first writer's metadata stick
  because later uploads no longer rewrite the object.
- The scope is fixed when the bytes are stored. A project that later moved to
  another workspace would keep its blobs in the old scope (reads still work,
  because the row records the key). No API moves a project today.
