import type { AssetVersion } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage, MetadataStore } from "../repository";
import type { Job } from "../../job/model";
import { generateId, versionStorageKey } from "./shared";
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
  },
  baseUrl: string,
  options?: { extractionQueue?: JobQueue<ExtractionMessage> | null; thumbnailQueue?: JobQueue<ThumbnailMessage> | null; skipExtraction?: boolean; usageScopes?: string[]; siteHostSuffix?: string },
): Promise<UploadVersionResult | null> {
  const asset = await metadata.find(assetId);
  if (!asset) return null;

  const versionId = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  const key = versionStorageKey(assetId, versionId, file.name);

  await storage.put(key, file.body, contentType, file.size,
    file.contentEncoding ? { contentEncoding: file.contentEncoding } : undefined,
  );

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
    size: file.size,
    createdAt: now,
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!options?.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
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
    savedVersion = await writes.createVersion({
      version: versionInput,
      job,
      usageScopes: asset.projectId ? options?.usageScopes : [],
    });

    // Enqueue only after the rows are committed: the consumer reads them.
    if (job && archiveFormat && options?.extractionQueue) {
      try {
        await options.extractionQueue.send({
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
      size: file.size,
    });
  } catch (e) {
    // Compensation: drop the orphaned R2 object so it doesn't leak forever
    // if the D1 version row failed to persist.
    try {
      await storage.delete(key);
    } catch (delErr) {
      console.error("Failed to clean up R2 object after version save failure:", delErr);
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
