import type { AssetVersion } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage, MetadataStore } from "../repository";
import type { Job } from "../../job/model";
import { generateId, versionStorageKey } from "./shared";
import { UploadUnderVerificationError } from "../integrity";
import { reuseFailure, type BlobContext } from "../../blob/usecase";
import { storeDirectUpload } from "../../blob/direct-upload";
import { siteUrlFor } from "../../site/url";
import { enqueueThumbnail } from "../../thumbnail/queue";
import type { ThumbnailMessage } from "../../thumbnail/queue";
import type { JobQueue } from "../../queue/port";
import type { ExtractionMessage } from "../../extraction/handler";

export interface UploadVersionResult {
  version: AssetVersion;
  url: string;
  /** Site host of the asset when it is an archive (ADR-013 B1). */
  siteUrl?: string;
}

export async function uploadVersion(
  metadata: MetadataStore,
  writes: AtomicWrites,
  storage: FileStorage,
  assetId: string,
  file: {
    name: string;
    type: string;
    body: ReadableStream<Uint8Array>;
    size: number;
    contentEncoding?: string;
    originalSize?: number;
    /**
     * Declared SHA-256 of the body, lowercase hex (ADR-017 §1). The store
     * verifies it and writes nothing on a mismatch (`ChecksumMismatchError`).
     * With `size` 0 it must be the SHA-256 of zero bytes; anything else is a
     * mismatch, whatever the scope holds (§4; see `storeDirectUpload`).
     */
    sha256?: string;
  },
  baseUrl: string,
  options?: {
    extractionQueue?: JobQueue<ExtractionMessage> | null; thumbnailQueue?: JobQueue<ThumbnailMessage> | null;
    skipExtraction?: boolean; usageScopes?: string[]; siteHostSuffix?: string;
    /** Blob ledger and the asset's scope: a declared upload is stored at its blob key (ADR-017 §3). */
    blob?: BlobContext;
  },
): Promise<UploadVersionResult | null> {
  const asset = await metadata.find(assetId);
  if (!asset) return null;
  // Undeclared pending uploads cannot fail verification, so only a declared
  // hash holds versions back.
  if (asset.integrity === "pending" && asset.sha256) throw new UploadUnderVerificationError(assetId);

  const versionId = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  // As for a first upload (`uploadAsset`): reuse, blob key, or classic key.
  // A declared mismatch throws here, before any row exists, with nothing stored.
  const stored = await storeDirectUpload(storage, options?.blob, {
    body: file.body, size: file.size, contentType, contentEncoding: file.contentEncoding, sha256: file.sha256,
  }, versionStorageKey(assetId, versionId, file.name), now);
  const key = stored.key;

  const archiveFormat = detectArchiveFormat(file.name);

  // `version` is assigned by the store inside the INSERT (race-free).
  // We seed 0 here so the field exists on the model; the stored record
  // receives its real version number when save() returns.
  const versionInput: AssetVersion = {
    id: versionId,
    assetId,
    version: 0,
    filename: file.name,
    contentType,
    size: stored.size,
    createdAt: now,
    sha256: stored.sha256,
    integrity: "verified",
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!options?.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
    ...(stored.ref && { blobKey: stored.ref.key }),
  };

  // Create extraction job for archives
  let job: Job | undefined;
  if (archiveFormat && !options?.skipExtraction) {
    const jobId = generateId();
    job = {
      id: jobId,
      assetId,
      type: "archive-extraction",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      versionId,
      ...(asset.sessionId && { sessionId: asset.sessionId }),
      ...(asset.projectId && { projectId: asset.projectId }),
    };
    versionInput.jobId = jobId;
  }

  let savedVersion: AssetVersion;
  try {
    // Job row, version row and storage-usage counters in one atomic write
    // (ADR-012 §3). The version number is assigned inside that batch.
    // Reused bytes attach only while the blob still qualifies (ADR-017 §4).
    try {
      savedVersion = await writes.createVersion({
        version: versionInput,
        job,
        usageScopes: asset.projectId ? options?.usageScopes : [],
        ...(stored.ref && { blob: { ref: stored.ref, state: "ready" as const, ...(stored.reuse && { existing: stored.reuse }) } }),
      });
    } catch (e) {
      throw stored.reuse && options?.blob ? await reuseFailure(options.blob.refs, key, stored.reuse.since, e) : e;
    }

    // Enqueue only after the rows are committed: the consumer reads them.
    if (job && archiveFormat && options?.extractionQueue) {
      try {
        await options.extractionQueue.send({
          jobId: job.id,
          assetId,
          versionId,
          archiveKey: key,
          archiveFilename: file.name,
          archiveFormat,
        });
      } catch (e) {
        console.error("Failed to enqueue extraction:", e);
      }
    }

    await enqueueThumbnail(options?.thumbnailQueue ?? null, {
      assetId,
      versionId,
      sourceKey: key,
      contentType,
      size: stored.size,
    });
  } catch (e) {
    // Compensation: drop the orphaned R2 object so it doesn't leak forever
    // if the D1 version row failed to persist. Never a blob: other rows may
    // reference it, and the grace and orphan sweeps reclaim it if none does.
    if (!stored.ref) {
      try {
        await storage.delete(key);
      } catch (delErr) {
        console.error("Failed to clean up R2 object after version save failure:", delErr);
      }
    }
    throw e;
  }

  // The site host follows the asset, not the new version: uploading a version
  // is a redeploy behind the same hostname (ADR-013 B1).
  const siteUrl = siteUrlFor({
    assetId,
    baseUrl,
    siteHostSuffix: options?.siteHostSuffix,
    archive: Boolean(archiveFormat),
  });

  return {
    version: savedVersion,
    url: `${baseUrl}/files/${assetId}/${encodeURIComponent(file.name)}`,
    ...(siteUrl && { siteUrl }),
  };
}
