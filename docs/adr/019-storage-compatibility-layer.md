# ADR-019: Storage Compatibility Layer — GCS and S3 APIs over Serve Assets

- **Status:** Proposed
- **Date:** 2026-11-09
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
| `.zip` and `.7z` are unpacked by gcs-unzip on Cloud Build, with `-skip-top`, into the **same folder** as the archive | `interactor/asset.go`, `taskrunner.go` |
| Completion is reported on a Pub/Sub topic and stored as `archiveExtractionStatus` | `taskrunner.go`, `pkg/asset/status.go` |
| The file list of an asset is a prefix listing of its folder | `GetAssetFiles` |
| Uploads use `Writer` after deleting any existing object; reads use `NewReader` / `NewRangeReader` with `ReadCompressed(true)` | `Upload`, `Read` |
| Private assets are toggled with the object ACL for `allUsers` | `publish` |
| Browser uploads go to a V4 signed `PUT` URL whose host can be rewritten to `publicBase` (`replaceUploadURL`) | `IssueUploadAssetLink`, `toPublicUrl` |
| Deleting assets is a prefix listing followed by per-object deletes | `batchDelete`, `deleteByPrefix` |
| The client is created with `storage.NewClient(ctx)` and no options | `bucket` |

Two consequences shape the design. A CMS asset is a **folder**, not an
object: one original file, and for an archive, its entries next to it.
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
compat_objects(bucket, key, asset_id, PRIMARY KEY (bucket, key))
```

A key resolves in this order:

1. **Exact key.** A row in `compat_objects` names a single-file asset.
2. **Folder mount.** The bucket's `mount_rule` turns the key into a
   folder and a remainder. For CMS the rule is
   `assets/{uuid[:2]}/{uuid[2:]}/`. The folder names
   one asset:
   - the remainder equal to the asset's original filename → the original
     file;
   - any other remainder → an entry inside the original archive, read
     through ADR-018's in-place path (§3 of that ADR for zip).
3. Otherwise, the upstream fallback (§7) or `404`.

Entries are never stored as objects of their own. The layer depends on
ADR-018's read path, not on extracted objects, so it works the same
whether or not an archive has been extracted.

**Root-folder stripping must match the source.** gcs-unzip's
`-skip-top` and Serve's automatic stripping decide differently in edge
cases (a lone file next to the top folder, `__MACOSX/`), and any
difference changes entry paths and breaks stored CMS URLs. A mount
therefore records the stripping rule it was created with, and the CMS
rule reproduces `-skip-top` exactly. The equivalence is checked on real
archives before migration (Open Questions).

### 3. Operation mapping

| Operation | GCS | S3 | Serve |
|-----------|-----|----|-------|
| Write | `uploadType=media/multipart/resumable` | `PutObject`, multipart upload | New asset, or new version of the asset the key resolves to (ADR-005) |
| Read | XML path `/{bucket}/{object}`, JSON `alt=media`; `Range`; `Accept-Encoding: gzip` | `GetObject`, `HeadObject` | Existing `/files` delivery, including gzip passthrough |
| Metadata | `objects.get` | `HeadObject` | Version row; generation = version number |
| List | `objects.list` (`prefix`, `delimiter`, `pageToken`) | `ListObjectsV2` | Range scan on `(bucket, key)`, merged with mount entries from the container index or central directory |
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
single-part ETag with MD5. The layer sends a hash header only when the
ledger holds that hash for the exact bytes sent (MD5 and CRC32C are
computed on write through the layer; SHA-256 per ADR-017). An entry read
in place carries its central-directory CRC-32 only where the protocol
has a field for it, and nothing otherwise.

Operations outside this table (bucket policies, lifecycle, object lock,
customer-supplied encryption, tagging, compose) answer the protocol's
own "not implemented" error.

### 4. Authentication

**GCS.** Serve issues a service-account-shaped key file per credential:
`client_email`, a private key Serve generated, and `token_uri` pointing
at Serve. Serve keeps the public key. The application loads the file
through `GOOGLE_APPLICATION_CREDENTIALS`, and Serve can then verify all
three forms the Google client libraries produce:

- a self-signed JWT sent as the Bearer token;
- a JWT assertion exchanged at `token_uri` for a Serve-issued access token;
- a V4 signed URL (`GOOG4-RSA-SHA256`).

Which of the first two a client sends depends on the library version, so
both are accepted.

**S3.** Access key pairs for SigV4, header and query forms. SigV4 is a
shared-secret scheme, so the secret is stored encrypted, not hashed.
`aws-chunked` bodies with trailing checksums
(`STREAMING-UNSIGNED-PAYLOAD-TRAILER`), which current AWS SDKs send by
default, are decoded.

**Both** credentials map to an ADR-016 service caller with a role on the
bucket's project, and the existing `POLICY` table decides each
operation. The layer adds a credential type, not an authorization model.

**Signed URLs and rewritten hosts.** A V4 signature covers the `host`
header. CMS rewrites the host of a signed URL to `publicBase` and
prefixes its path. The GCS front end verifies against the host and path
that were signed (`storage.googleapis.com/{bucket}/{key}`), reconstructed
from the configured `publicBase`, not against the host it received.

### 5. How an application connects

CMS creates its client with `storage.NewClient(ctx)` and no options. The
only switch that changes its endpoint without code is
`STORAGE_EMULATOR_HOST`, and in emulator mode the Go client is expected
to drop authentication. Two ways are therefore kept open until the spike
(Open Questions) settles which works:

| | Code change | Authentication | Signed URLs |
|-|-------------|----------------|-------------|
| **A** | None. `STORAGE_EMULATOR_HOST` points at a sidecar proxy that adds the credential | At the proxy | Unknown in emulator mode |
| **B** (preferred) | A few lines: pass `option.WithEndpoint(conf)` | The Serve-issued key file (§4) | Expected to be signed locally with that key; verified by Serve |

B keeps authentication end to end and needs no extra process. A is the
fallback if a code change is not possible.

For S3 applications, the SDK's `endpoint` and path-style options are
enough. The SDK's multipart threshold and part size are set below the
Worker's 100 MB request body limit; a single `PutObject` above it is
refused with `EntityTooLarge`.

### 6. Public delivery host

A read-only host serves `/{key}` for a bucket
(`https://{bucket}.objects.<domain>/{key}`, with a path-style form for
deployments without a wildcard certificate). It resolves keys through
§2 and hands off to `/files` delivery, so ETags, `Range`, caching
(ADR-013 A2) and ADR-014 access modes apply unchanged. An application
whose public URL is `publicBase + key` moves by changing `publicBase`.

URLs already stored with a host the application does not own
(`https://storage.googleapis.com/...`) cannot be redirected. Rewriting
them is the application's own data migration, and this layer does not
attempt it.

### 7. Migration

**Copy originals, not folders.** The import is driven by the
application's own records, not by a bucket listing. For CMS, each asset
document (`uuid`, `fileName`) becomes one step:

1. create the Serve asset and its `compat_objects` / mount row;
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
reach `done`. Serve reports the container index as ready through an
ADR-007 webhook shaped as a Pub/Sub push message to the endpoint CMS
already consumes. Whether that endpoint accepts it without a CMS change
depends on how it authenticates push requests (Open Questions). How the
Cloud Build launch is switched off is a CMS configuration question.

### 8. 7z and the limits of servable on arrival

CMS accepts `.7z`, and 7-Zip creates solid archives by default. Under
ADR-018 a solid 7z is L3. Reading its N-th entry before repacking means
decoding entries 1..N−1 with an LZMA dictionary of 64 MB to 1.5 GB. The
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
  read path exists, mounts need extracted objects as a stopgap.
- 7z entries are not servable on arrival (§8).
- Stored absolute URLs on hosts the application does not own remain the
  application's problem.

## Open Questions

### Spikes, in this order

1. **Go GCS client against a stub.** With `option.WithEndpoint` and a
   Serve-issued key file: which token form is sent, whether reads take
   the XML or JSON path, whether `SignedURL` signs with the file's key.
   With `STORAGE_EMULATOR_HOST`: whether authentication is dropped and
   whether `SignedURL` works. This decides A or B in §5.
2. **Root-folder stripping equivalence.** Unpack a sample of CMS
   archives with gcs-unzip `-skip-top` and list them through the mount
   rule; the path sets must be identical.
3. **Solidity of CMS 7z files.** Read the unpack-stream count per folder
   from the headers (ADR-018 Open Question 3).
4. **CMS Pub/Sub push endpoint.** How it authenticates, and whether a
   webhook can satisfy it unchanged.

### Decisions

- Mount rule syntax: a fixed set of shapes (CMS's UUID split) or a
  general pattern language.
- Whether S3 `ListObjectVersions` maps to ADR-005 versions, or is left
  unimplemented.
- Credential lifecycle: rotation and revocation of issued key files and
  SigV4 pairs, and whether they are managed through the existing API or
  a separate one.
- When the S3 front end starts, given that no current application needs
  it first.
