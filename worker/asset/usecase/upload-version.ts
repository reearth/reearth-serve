import type { AssetVersion } from "../model";
import { detectArchiveFormat } from "../model";
import type { FileStorage, VersionStore, MetadataStore } from "../repository";
import type { JobStore } from "../../job/repository";
import type { Job } from "../../job/model";
import { generateId, versionStorageKey } from "./shared";

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
  options?: { extractionQueue?: Queue | null; skipExtraction?: boolean },
): Promise<UploadVersionResult | null> {
  const asset = await metadata.find(assetId);
  if (!asset) return null;

  const versionId = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  const key = versionStorageKey(assetId, versionId, file.name);
  const versionNum = await versions.nextVersion(assetId);

  await storage.put(key, file.body, contentType, file.size,
    file.contentEncoding ? { contentEncoding: file.contentEncoding } : undefined,
  );

  const archiveFormat = detectArchiveFormat(file.name);

  const version: AssetVersion = {
    id: versionId,
    assetId,
    version: versionNum,
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
    version.jobId = jobId;

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

  await versions.save(version);

  return {
    version,
    url: `${baseUrl}/files/${assetId}/${encodeURIComponent(file.name)}`,
  };
}
