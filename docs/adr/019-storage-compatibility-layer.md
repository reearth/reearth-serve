# ADR-019: Storage Compatibility Layer, GCS and S3 APIs over Serve Assets

- **Status:** Proposed
- **Date:** 2026-11-09 (revised 2026-11-19 with spike results)
- **Deciders:** @rot1024
- **Related:** ADR-005 (versions), ADR-007 (webhooks), ADR-012
  (portability), ADR-013 (site hosting), ADR-014 (access modes), ADR-016
  (service callers), ADR-017 (content-addressed blobs), ADR-018 (archives
  served in place)

## Context

Server applications that already store files in Google Cloud Storage or
Amazon S3 can move to Serve today only by rewriting their storage layer
against Serve's REST API. For Re:Earth CMS that layer is
`server/internal/infrastructure/gcp/file.go`, plus a Cloud Build job that
unpacks archives and a Pub/Sub topic that reports the result. The
rewrite is the main cost of migrating, and it is the same cost for every
application.

This ADR adds a layer in which Serve answers a subset of the GCS and S3
APIs. An application keeps its client library and changes configuration:
the endpoint, the credentials, and the public base URL. The layer turns
every call into an existing Serve operation (create an asset, upload a
version, delete, list, read), so the data ends up as ordinary Serve
assets with versions, access modes and thumbnails.

ADR-012 also mentions S3 and GCS, in the other direction. There Serve is
the client and the cloud store sits behind the `FileStorage` port. Here
Serve is the server and the application is the client. The two are
independent: this layer is a driving adapter in front of the use cases,
and it does not touch the storage ports.

### What Re:Earth CMS does with GCS

CMS is the first application to migrate and the only one that is
GCS-only, so its usage sets the first scope. From the CMS source:

| Behaviour | Where |
|-----------|-------|
| Object key `assets/{uuid[:2]}/{uuid[2:]}/{fileName}` | `getGCSObjectPath`, `file.go` |
| Public URL `{publicBase}/assets/{uuid[:2]}/{uuid[2:]}/{fileName}`, with `publicBase` configurable | `getURL`, `GetAccessInfoResolver` |
| `.zip` and `.7z` are unpacked by gcs-unzip v0.1.10 on Cloud Build, with `-skip-top -old-windows`, into a folder named after the archive (its name without the extension) **inside the asset folder** | `interactor/asset.go`, `taskrunner.go:135`, `worker/decompressor.Dockerfile`; gcs-unzip `main.go:318` |
| Completion is reported on a Pub/Sub topic and stored as `archiveExtractionStatus` | `taskrunner.go`, `pkg/asset/status.go` |
| The file list of an asset is a prefix listing of its folder | `GetAssetFiles` |
| Uploads use `Writer` after deleting any existing object; reads use `NewReader` / `NewRangeReader` with `ReadCompressed(true)` | `Upload`, `Read` |
| Private assets are toggled with the object ACL for `allUsers` | `publish` |
| Browser uploads go to a V4 signed `PUT` URL whose host can be rewritten to `publicBase` (`replaceUploadURL`) | `IssueUploadAssetLink`, `toPublicUrl` |
| Deleting assets is a prefix listing followed by per-object deletes | `batchDelete`, `deleteByPrefix` |
| The client is created with `storage.NewClient(ctx)` and no options | `bucket` |

Two consequences shape the design. A CMS asset is a **folder**, not an
object: one original file, and for an archive, its entries under
`{archive name}/` next to it.
And every folder with many files has its archive in it, so a migration
has to copy only the originals.

## Decision

### 1. One object layer, two protocol front ends

```
GCS JSON/XML front end ─┐
                        ├─▶ object layer (key → asset, mounts) ─▶ asset use cases
S3 front end ───────────┘
```

The object layer resolves a `(bucket, key)` to an asset, a version and a
path inside it. It is shared. Each front end owns only its routing, wire
format, errors and authentication. The code lives in `core/compat/`
(object layer) with `core/compat/gcs/` and `core/compat/s3/` beside it.
Because it calls use cases and not adapters, it runs unchanged on the
Node runtime.

**GCS comes first.** CMS is the application that has to move, and it
has no S3 driver. S3 follows, with the same object layer.

### 2. Buckets and keys

A **compat bucket** is a name that belongs to one project. Its objects
are that project's assets; there is no second store.

```sql
compat_buckets(name PRIMARY KEY, project_id, mount_rule, upstream)
compat_bindings(bucket, key, binding, asset_id, PRIMARY KEY (bucket, key))
```

A binding row names either one exact key (`binding = 'object'`) or one
mounted folder (`binding = 'folder'`, key ending in `/`). Its
`asset_id` is empty while a writer holds the key (below).

A key resolves in this order:

1. **Exact key.** An `object` binding names a single-file asset.
2. **Folder mount.** The bucket's `mount_rule` turns the key into a
   folder and a remainder. A `folder` binding names one asset:
   - the remainder equal to the asset's original filename → the original
     file;
   - a remainder found in the version's **entry table** → that entry,
     read through ADR-018's in-place path (§3 of that ADR for zip);
   - anything else → not found.
3. Otherwise, the upstream fallback (§7) or `404`.

A mount rule is data, not a pattern language:
`{ prefix, depth, strip }`. `prefix` is a fixed key prefix, `depth` the
number of path segments after it that form the folder, and `strip` the
rule the source used to name archive entries (`none` or `skip-top`).
CMS's `assets/{uuid[:2]}/{uuid[2:]}/` is
`{ prefix: "assets/", depth: 2, strip: "skip-top" }`. Nothing in core
knows it is a UUID.

Entries are never stored as objects of their own. The layer depends on
ADR-018's read path, not on extracted objects. Until ADR-018 reads a
format in place, an entry read of that format answers `404`, and the
upstream fallback covers it during a migration.

**Entry names must match the source byte for byte.** gcs-unzip writes
an entry to `{folder}/{archive name}/{path}`, where the archive name is
the object name without its last extension (gcs-unzip `main.go:219` and
`488-490` for the name, `312-318` for the strip and the join).
Its `-skip-top` removes a top folder only when every file's first path
segment equals that archive name. Serve's own root stripping
(`RootPrefixDetector`) decides differently in 9 of 21 cases tested
(Spike results), so it is not reused. Each version of a mounted archive
gets an entry table, computed once from the central directory with the
source's rule and stored with the version:

```
ext         = last extension of objectName, case kept
if ext is not ".zip" or ".7z": no entries
archiveName = objectName without ext
name(e)     = e.name; Shift-JIS decode when not valid UTF-8; for zip, "\" becomes "/"
isMeta(n)   = a non-final segment is "__MACOSX", or the last segment is
              ".DS_Store", "Thumbs.db" or "__MACOSX"
files       = entries that are not directories and not isMeta
strip       = strip rule is skip-top and every file's first segment == archiveName
for e in files, in central-directory order (a later entry wins):
    rel = name(e), with "archiveName/" removed when strip
    key = path.Clean(archiveName + "/" + rel)
    skip the entry when key escapes with ".."
    table[key] = e
```

Matching is byte-exact, with no case folding and no Unicode
normalization.

### 3. Operation mapping

| Operation | GCS | S3 | Serve |
|-----------|-----|----|-------|
| Write | `uploadType=media/multipart/resumable` | `PutObject`, multipart upload | New asset, or new version of the asset the key resolves to (ADR-005) |
| Read | XML path `/{bucket}/{object}`, JSON `alt=media`; `Range`; `Accept-Encoding: gzip` | `GetObject`, `HeadObject` | Existing `/files` delivery, including gzip passthrough, after the front end authorizes `read_asset` for its service principal |
| Metadata | `objects.get` | `HeadObject` | Version row; generation as below |
| List | `objects.list` (`prefix`, `delimiter=/`, `pageToken`, `startOffset`, `endOffset`) | `ListObjectsV2` | Range scan on `(bucket, key)`, merged with each mounted folder's entry table |
| Delete | `objects.delete` | `DeleteObject`, `DeleteObjects` | See below |
| Copy | `objects.copy`, `rewrite` | `CopyObject` | Metadata-only when the source has a blob key (ADR-017 §3) |
| Visibility | ACL `allUsers:READER` set / delete | `x-amz-acl: public-read` / private | ADR-014 `public` / `restricted` |
| Custom metadata | `metadata` | `x-amz-meta-*` | Version `userMeta` |

**Deletes are idempotent.** CMS lists a folder and deletes each object,
and the order is not defined. Deleting the original deletes the asset.
Deleting an entry inside a mount answers success and does nothing,
because an entry is part of an immutable version. Deleting a key that no
longer resolves (its asset already gone) also answers success. Every
order of the per-object deletes therefore ends with the asset deleted
and no errors.

**Hashes are either right or absent.** The Go GCS reader checks CRC32C
against `x-goog-hash` after a full read, and some S3 tools compare a
single-part ETag with MD5. The Node GCS client goes further and deletes
an upload whose response lacks a matching `crc32c` or `md5Hash`
(Spike results). The layer computes MD5 and CRC32C while it streams a
write and stores them per version in its own table,
`compat_hashes(version, md5, crc32c)`, because WebCrypto has neither
digest and ADR-017's ledger belongs to that ADR. It sends a hash only
when that table holds one for the exact bytes sent: a `200` whose
encoding equals the stored encoding, never a `206`. An entry read in
place carries its central-directory CRC-32 only where the protocol has
a field for it, and nothing otherwise.

**A generation is never reused for a key.** It is not the version
number: Serve numbers versions from the highest remaining one, so a
deleted version or a deleted and recreated asset would hand its number
to different bytes, and a version pinned over the REST API would make
the generation go backwards. A write through the layer stores its
version, then takes
`max(created_at in microseconds, bucket's last generation + 1)` in one
statement that also raises the bucket's high mark, and keeps it next to
the version's hashes. The high mark is per bucket, so it survives the
deletion of every object in it. An object written outside the layer
reads its creation time in microseconds. A write through the layer also
makes its version the live one, clearing a pin set over the REST API, so
`objects.get` always answers the generation the write returned.

**Writes to one key are serialized.** A writer to a new key inserts the
binding row with no asset (a claim) before it writes any byte, so two
writers cannot each create an asset. An overwrite or a delete of a bound
key first takes a lease on its binding row in one conditional update,
and checks `ifGenerationMatch` only while it holds the lease. A second
writer, or a delete during a write, gets a retryable `503`, so two
writers with the same precondition cannot both succeed and a write never
completes onto a deleted asset. A writer renews its claim or lease while
it copies, and only while it still holds it. One that went silent for a
fixed age is taken over, its old holder can never renew it again, and a
sweep removes old claims. A commit publishes only while it still holds
its session revision and, on an overwrite, the lease on a binding that
still names the asset it writes. A swept or cancelled session is marked
gone before its staged chunks are queued for cleanup, so a failed
cleanup is retried on the next sweep.

**Resumable uploads are staged, then committed once.** The Go client
uploads anything at or above its 16 MiB chunk size as a resumable
session: one `POST ...?uploadType=resumable`, then one request per chunk
with `Content-Range: bytes a-b/*` and a final `bytes a-b/total`, or
`bytes */total` with an empty body when the size is a multiple of the
chunk size (16 MiB exactly, for one). The final chunk also carries
`X-Goog-Hash: crc32c=` for the whole object, which the layer checks
against the CRC32C it computed and refuses on a mismatch. Each
chunk request carries `X-GUploader-No-308: yes`, so an incomplete chunk
answers `200` with `X-Http-Status-Code-Override: 308` and
`Range: bytes=0-N`. A bare `308` fails the client; other clients that do
not send the header get a real `308`.

Every change to a session is a compare-and-set on its revision. Each
chunk request stages its bytes through the existing `FileStorage.put`
under a key of its own, and records that key in the same step that
advances the received count and the MD5 and CRC32C state, so a slower
duplicate of a chunk can never replace bytes the session already hashed.
The first declared total is stored, and a request that declares another
one is refused. The final chunk is staged too, so the client's
`X-Goog-Hash` is checked before any asset exists.

A commit has one owner. The move to committing records a random owner
token and the ids derived from it; any other request gets a retryable
`503` until the owner finishes or has been silent for a fixed time, and
a takeover is another compare-and-set that records the new owner's ids
beside the earlier ones. While it copies staged bytes, the owner
refreshes its timestamp and its claim or key lease at a quarter of that
time, so a slow but live owner is never displaced. The owner streams the
staged chunks into the object's storage key under asset or version ids
derived from its own token, so no two owners can collide on one row or
delete each other's bytes. It then publishes in one atomic, guarded
write: the create-asset or create-version write takes an optional
publish, and the adapter applies it in the same batch that inserts the
row, its job and its usage increments. That one write fills the key's
claim with the new asset, or on an overwrite clears the asset's pinned
version so the new version is live; takes a generation above the
bucket's high mark and above every version the asset already has, so a
REST upload that added a version while the commit streamed never
outranks the published one; stores the hash record at that generation;
queues the storage prefixes of the session's earlier owners for cleanup;
and moves the session to committed with its result. It applies only
while the session is at the owner's revision and the key is still held:
by the owner's unfilled claim for a new key, or by the owner's lease on
a binding that still names the asset for an overwrite. For SQL, every
statement of the batch selects or updates only under that condition. If
the hold is lost, nothing is written, the owner deletes only the bytes
it streamed, and the request answers `503`. If the write fails any other
way, its outcome is unknown, so the owner re-reads the row it wrote. The
owner deletes its bytes only when that row is absent, and keeps them
when the row is present or the re-read fails. A leaked object costs less
than a live object without bytes. A takeover, a cancel or the expiry
sweep therefore also stops any later publish by the old owner. Nothing
about publishing happens after that write, so a crash, sweep, cancel,
REST pin or newer write never sees a half-published object: the session
is either still committing, and a replay takes it over once the owner is
stale, or committed, and every replay, status query or cancel answers
from the recorded result. The publish is an additive, optional input to
`AtomicWrites`; the storage ports do not change. A commit's heartbeat
clock starts at the owner's last refresh, and a staged chunk that has
disappeared counts as a lost hold (`503`). An overwrite records its
target asset before it writes, so a replay after the key was deleted
answers `412` and never writes the object again. A precondition that
fails at the commit ends the session with that error and drops its
staged chunks at once. `DELETE` on the session URI cancels an unfinished
session (`499`); on a committed session it answers the object, and the
session stays until the sweep. Expired sessions and their staged chunks
are swept. When a cancel, a failed commit or the sweep ends a session
that never committed, each recorded owner's prefixes are queued for
cleanup too. None of them can hold the published object, because every
owner writes under ids of its own.

Operations outside this table (bucket policies, lifecycle, object lock,
customer-supplied encryption, tagging, compose) answer the protocol's
own "not implemented" error.

### 4. Authentication

**GCS.** Serve issues a service-account-shaped key file per credential:
`client_email`, a private key Serve generated, and `token_uri` pointing
at Serve. Serve keeps the public key and never stores the private one.
The application loads the file through `GOOGLE_APPLICATION_CREDENTIALS`,
and Serve can then verify all three forms the Google client libraries
produce:

- a JWT assertion exchanged at `token_uri` for a Serve-issued access
  token, which is what the Go client v1.69 sends (Spike results);
- a self-signed JWT sent as the Bearer token, which other library
  versions send and which costs the same verifier;
- a V4 signed URL (`GOOG4-RSA-SHA256`).

The access token carries only the credential id. Serve reloads the
credential on every request, so a revoked credential stops working at
once, cached tokens included.

**S3.** Access key pairs for SigV4, header and query forms. SigV4 is a
shared-secret scheme, so the secret is stored encrypted, not hashed.
`aws-chunked` bodies with trailing checksums
(`STREAMING-UNSIGNED-PAYLOAD-TRAILER`), which current AWS SDKs send by
default, are decoded.

**Both** credentials become a service principal: principal
`service:<credentialId>` with a role, decided by the existing `POLICY`
table through `core/auth/access.ts`, the only caller of the authorizer.
The role is at most `editor`, so a leaked key file can never delete a
project. This departs from ADR-016 decision 11 in three ways, because a
Google or AWS client library cannot obtain an OIDC client-credentials
token:

1. **The credential.** It is one the client library already speaks
   (an RSA key file or a SigV4 pair), not a token from the deployment's
   OIDC issuer.
2. **The scope.** A credential holds a role on one project and one
   bucket, not on the workspaces listed in `SERVICE_CLIENTS`. This is
   new authorization code in `access.ts`: an `authorizeService` that
   checks the project and bucket, then shares the final policy decision
   with `authorizeProject`.
3. **The lifecycle.** Credentials are issued, listed and revoked
   through the REST API under `/api/v1/projects/{id}/compat/` by a
   project `admin`, not set in configuration. The new
   `project.manage_compat` action goes through ADR-016's procedure for
   a policy action (`POLICY`, the Cerbos example, the paired
   reearth-accounts PR, the pinned accounts commit bump, and the README
   table). Rotation is issue a new credential,
   deploy it, then revoke the old one.

**Signed URLs and rewritten hosts.** A V4 signature covers the `host`
header and the path. With the endpoint option of §5, the Go client signs
the **endpoint's hostname without its port** and the path
`/{bucket}/{key}`, and always writes an `https` URL (storage
`storage.go:843-854`). CMS may then rewrite the host to `publicBase` and
prefix `publicBase`'s path (`toPublicUrl`). The GCS front end therefore
verifies against the configured compat API hostname and the received
path with a configured prefix removed, never against the host it
received. With Serve as the endpoint the signed host is already Serve,
so CMS must turn `replaceUploadURL` off: its `publicBase` becomes the
read-only host of §6, and a rewritten URL would send the `PUT` there.

When a path prefix is configured, the front end reads a signed request's
path twice: as received, then with the prefix removed. It writes the
object named by the reading whose signature verifies. The signature
covers the path, so at most one reading verifies, and a bucket named
like the prefix's first segment keeps working. The XML write applies
`Content-MD5` (`400 BadDigest` on a mismatch, before the object becomes
visible), `x-goog-content-length-range`, `x-goog-if-generation-match`
and `x-goog-meta-*` from the request, for a bearer and a signed URL
alike. A URL that signs any other `x-goog-*` header is refused with
`501` rather than verified and ignored. Query keys are ordered by their
UTF-8 bytes, as the Go signer orders them, and a signed URL with more
than 64 query parameters is refused before any credential lookup. Both
runtimes resolve `.` and `..` path segments before Serve reads the path,
so such keys verify only when their slashes are sent as `%2F`. A
virtual-hosted-style URL answers `501`; the Go client signs path style
by default.

### 5. How an application connects

CMS creates its client with `storage.NewClient(ctx)` and no options. It
passes `option.WithEndpoint(conf)` instead, with the Serve-issued key
file in `GOOGLE_APPLICATION_CREDENTIALS`. That is the only change to
CMS's storage client; archive completion needs CMS changes of its own
(§7).

Spike 1 tested both ways CMS could reach Serve:

| | Code change | Authentication | Signed URLs |
|-|-------------|----------------|-------------|
| **A** (rejected) | None. `STORAGE_EMULATOR_HOST` | None: the client sends no `Authorization` header, with or without a key file | Fail: "unable to detect default GoogleAccessID" |
| **B** (chosen) | One option: `option.WithEndpoint(conf)` | The Serve-issued key file (§4), end to end | Signed locally with that key, verified by Serve |

A would need a proxy to add the credential and still a CMS code change
for signed URLs, so it has no advantage left.

The endpoint is a host of its own (`COMPAT_API_HOST`). The XML read path
`/{bucket}/{key}` has no distinctive prefix, so the API host is
recognised before Serve's site hosts in the app and in both runtime
gates, by one host classifier.

For S3 applications, the SDK's `endpoint` and path-style options are
enough. The SDK's multipart threshold and part size are set below the
Worker's 100 MB request body limit; a single `PutObject` above it is
refused with `EntityTooLarge`.

### 6. Public delivery host

A read-only host serves `/{key}` for a bucket
(`https://{bucket}.objects.<domain>/{key}`, with a path-style form for
deployments without a wildcard certificate). It resolves keys through
§2 and hands off to `/files` delivery, so ETags, `Range`, caching
(ADR-013 A2) and ADR-014 access modes apply unchanged to its anonymous
visitors. A read through the GCS API is different: its service
principal is authorized for `read_asset` first, and delivery then skips
the visitor checks, so the application reads its own `restricted` and
password assets. This is a third proof of access beside ADR-014's
delivery token and OIDC bearer, scoped to one bucket. An application
whose public URL is `publicBase + key` moves by changing `publicBase`.

URLs already stored with a host the application does not own
(`https://storage.googleapis.com/...`) cannot be redirected. Rewriting
them is the application's own data migration, and this layer does not
attempt it.

### 7. Migration

**Copy originals, not folders.** The import is driven by the
application's own records, not by a bucket listing. For CMS, each asset
document (`uuid`, `fileName`) becomes one step:

1. create the Serve asset and its `compat_bindings` row
   (`binding = 'folder'`);
2. stream the original from GCS into Serve, server-side in a container
   (the extractor's S3 client already reads GCS through HMAC interop,
   ADR-012), with the source's MD5 checked on arrival;
3. let finalisation build the container index (ADR-018 §6).

Steps are keyed by `uuid` and can be rerun. Extracted entries are not
copied: they are already readable from the original through ADR-018.

Cloudflare's bucket migration tools (Super Slurper, Sippy) are not used.
They copy keys one to one into an R2 bucket and create no ledger rows,
so the result is invisible to Serve. They filter by a single prefix, so
they would also copy every extracted entry.

**Upstream fallback.** A bucket may name an upstream (bucket and
credentials). A key that does not resolve, or an entry whose archive has
not been imported yet, is read from the upstream and returned. A miss on
the original triggers the import step for that asset. The application
can therefore switch first and let the data follow. The fallback is
removed per bucket once the import reports no remaining assets.

**Archive jobs.** Once Serve serves entries, CMS's own decompression
job must not run, and CMS still needs `archiveExtractionStatus` to
reach `done`. CMS learns it only from `POST /api/notify`
(`m2m.go`), which expects:

- a Pub/Sub push envelope whose `message.data` is base64 of
  `{"type":"assetDecompressed","assetId":"<CMS asset id>","status":"done"|"failed"}`;
- a Bearer JWT checked against the one issuer, audience and JWKS
  configured in `REEARTH_CMS_AUTHM2M_*`.

On `done`, CMS lists the asset folder through the storage API and saves
the file tree, so the entry table must exist before Serve notifies. A
Serve webhook cannot satisfy this endpoint unchanged: its body is plain
JSON with an HMAC header, Serve cannot mint a Google-signed token, and
the CMS asset id is not part of the object key. Serve sends the notify
once the entry table is built, and the remaining choice is how CMS
accepts it: a small CMS change that accepts a shared-secret variant of
the endpoint, or CMS pointing its M2M issuer at a JWKS Serve publishes,
which replaces Google as the only issuer. CMS creates its asset id only
after the upload returns (`interactor/asset.go`, upload at line 425,
`NewID` at 469), so Serve needs it from a CMS change as well: metadata
patched onto the object after the asset is created, or a lookup from
the folder's UUID to the asset id. Leaving `REEARTH_CMS_TASK_GCPPROJECT`
unset is the only CMS setting that stops the Cloud Build job today, and
it also stops CMS's import and copy tasks, so a decompression-only
switch is a CMS change too.

### 8. 7z and the limits of servable on arrival

CMS accepts `.7z`, and 7-Zip creates solid archives by default. Under
ADR-018 a solid 7z is L3. Reading its N-th entry before repacking means
decoding entries 1 to N-1 with an LZMA dictionary of 64 MB to 1.5 GB. The
Worker has 128 MB. In practice an L3 entry cannot be read by the Worker
before repacking, and even an L1 (non-solid) 7z entry has to be LZMA
decoded to be delivered.

The layer therefore states the ADR-018 gap for this case rather than
hiding it:

- before repacking, an entry of a 7z is read by a container, not the
  Worker, and costs a sequential decode;
- the repacking job for 7z is, for these assets, size-proportional and
  required, the cell ADR-018 §6 wants empty;
- the migration runs repacking as part of the import, so that the gap
  is closed before the application switches, and the upstream fallback
  covers 7z entries until then.

ADR-018 Open Question 3 (are distributed 7z files solid) is measured on
CMS's own archives first.

## Alternatives Considered

### Rewrite each application against Serve's REST API

The most direct path, and the one this ADR exists to avoid. Every
application pays it again, and the rewrite has to land before any data
can move.

### S3 only, and ask GCS applications to switch drivers

Smaller to build. Rejected because CMS has no S3 driver; writing one is
the rewrite above under another name.

### Emulate GCS with a separate store (as fake-gcs-server does)

A store that keeps objects by key would accept any client, but its
objects would not be Serve assets: no versions, no access modes, no
in-place archive reads. Migration would end with a second migration.

### One key, one asset, for every key

Simple, and right for single files. For CMS it turns every extracted
entry into an asset with its own version, events and webhooks, and it
requires copying every entry. Folder mounts keep one asset per CMS
asset.

### Copy extracted entries during migration

Rejected: the originals contain them, and ADR-018 reads them in place.
Copying them multiplies object count and GCS egress for no gain.

## Consequences

### Positive

- An application moves by configuration (or, for CMS, a few lines),
  and its data becomes ordinary Serve assets.
- Migration copies one object per application asset. Archives are
  readable as soon as their original arrives.
- The upstream fallback lets the switch happen before the copy ends.
- `rclone`, `gsutil` and the AWS CLI work against Serve for operators,
  once the corresponding front end exists.

### Negative

- Two protocol surfaces to keep compatible with client libraries that
  change, notably authentication and checksum defaults.
- Serve stores encrypted SigV4 secrets and RSA key pairs, a class of
  secret it did not hold before.
- The layer depends on ADR-018 for mount entries. Until the in-place
  read path exists for a format, its entries answer `404` unless an
  upstream covers them.
- Resumable uploads write their bytes twice (staged chunks, then the
  asset), the price of keeping the storage ports unchanged on both
  runtimes.
- Archive completion needs a CMS-side change (§7).
- 7z entries are not servable on arrival (§8).
- Stored absolute URLs on hosts the application does not own remain the
  application's problem.

## Spike Results

1. **Go GCS client against a stub** (2026-11-19, `cloud.google.com/go/storage`
   v1.69.0 and `google.golang.org/api` v0.303.0, the versions CMS pins).
   - With `option.WithEndpoint` and a Serve-shaped key file, every call
     CMS makes succeeds. The token is a jwt-bearer assertion (RS256,
     `aud` = `token_uri`) exchanged at `token_uri`; no self-signed JWT
     was sent. Reads take the XML path `GET /{bucket}/{key}` with
     `Range` and `Accept-Encoding: gzip`. Metadata, list, delete and
     ACL use the JSON API. Uploads under 16 MiB are one
     `uploadType=multipart` request; larger ones are resumable (§3).
   - `SignedURL` signs locally with the key file. The signature
     verifies with the stored public key over host = endpoint hostname
     without port, path `/{bucket}/{key}`, signed headers
     `content-encoding;content-type;host`.
   - With `STORAGE_EMULATOR_HOST`, no request carries authentication and
     `SignedURL` fails. This decides B in §5.
   - The Node client (`@google-cloud/storage` 7.22) drops authentication
     on a custom endpoint unless told otherwise, ignores the key file's
     `token_uri`, reads with JSON `alt=media`, and refuses uploads whose
     response lacks matching hashes.
2. **Root-folder stripping equivalence.** gcs-unzip v0.1.10 (CMS's
   flags, local mode with its path logic unchanged) and Serve's
   extractor ran on 21 generated zips. Entries live under
   `{archive name}/`. Serve's stripping differs on 9 cases (`__MACOSX/`,
   `.DS_Store`, `Thumbs.db`, Shift-JIS names, an empty sibling
   directory, `./` prefixes, an uppercase `.ZIP`, a `..` escape). The
   rule in §2 matches gcs-unzip on all 21. Real CMS archives were not
   available; comparing the rule with a real bucket listing remains
   before migration.
3. **Solidity of CMS 7z files.** Open. A header-only tool counts files
   per compression folder and was checked on library fixtures (solid
   and non-solid both detected). Running it needs a sample of CMS's 7z
   originals. §8 already treats every 7z as not servable on arrival, so
   no decision waits on it.
4. **CMS Pub/Sub push endpoint.** Read from the CMS source; see §7.

## Decisions

- **Mount rule syntax.** A fixed generic shape, `{ prefix, depth, strip }`
  (§2), not a pattern language. A second application with another
  layout adds a `strip` value or a field, not a parser.
- **S3 `ListObjectVersions`** and GCS `versions=true` answer "not
  implemented" until an application needs them.
- **Credential lifecycle.** Managed through the existing REST API under
  `/api/v1/projects/{id}/compat/`. Revocation is immediate (§4).
  Rotation is issue, deploy, revoke. SigV4 pairs follow the same routes.
- **S3 front end** starts after the GCS front end serves CMS on a
  deployed environment, on the same object layer.

## Open Questions

- How CMS accepts the archive-completion notify (§7): a shared-secret
  variant of `/api/notify`, or Serve as its M2M issuer. How Serve learns
  the CMS asset id, which CMS creates after the upload.
- Spike 3, on a sample of CMS's 7z originals.
- The §2 rule against a real CMS bucket listing.
