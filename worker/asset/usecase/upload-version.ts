import type { AssetVersion } from "../model";
import { detectArchiveFormat } from "../model";
import type { FileStorage, VersionStore, MetadataStore } from "../repository";
import type { JobStore } from "../../job/repository";
import type { Job } from "../../job/model";
import { generateId, versionStorageKey } from "./shared";
import { enqueueThumbnail } from "../../thumbnail/queue";

export interface UploadVersionResult {
  version: AssetVersion;
  url: string;
}

export async function uploadVersion(
  metadata: MetadataStore,
  versions: VersionStore,
  storage: FileStorage,
  jobs: JobStore,
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
  options?: { extractionQueue?: Queue | null; thumbnailQueue?: Queue | null; skipExtraction?: boolean },
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

  let savedVersion: AssetVersion;
  try {
    // Create extraction job for archives
    if (archiveFormat && !options?.skipExtraction) {
      const jobId = generateId();
      const job: Job = {
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
      await jobs.save(job);
      versionInput.jobId = jobId;

      if (options?.extractionQueue) {
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
    }

    savedVersion = await versions.save(versionInput);

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

  return {
    version: savedVersion,
    url: `${baseUrl}/files/${assetId}/${encodeURIComponent(file.name)}`,
  };
}
