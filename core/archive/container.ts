import type { FileStorage } from "../asset/repository";
import { encodeIndex } from "./index-format";
import { directoryTable, surveyBytes, surveyStream, type ArchiveSource } from "./reader";
import { locateDirectory, type DirectoryRefusal } from "./zip/directory";

export interface DirectorySpan {
  offset: number;
  size: number;
}

export interface ContainerLimits {
  maxEntries: number;
  maxDirectoryBytes: number;
}

export const CONTAINER_LIMITS: ContainerLimits = { maxEntries: 100_000, maxDirectoryBytes: 20 * 1024 * 1024 };

export type ContainerOutcome =
  | { ok: true; index: string; directory: DirectorySpan; rootPrefix: string }
  | { ok: true; skipped: "small" | "too-large"; directory: DirectorySpan; rootPrefix: string }
  | { ok: false; reason: DirectoryRefusal };

/**
 * Write the container index for `source` to `target`. Refusals come back as
 * values; a failed put throws. The bytes are a pure function of the original,
 * so a rerun overwrites an orphan with identical bytes.
 */
export async function buildContainerIndex(
  storage: FileStorage,
  source: ArchiveSource,
  target: string,
  limits: ContainerLimits = CONTAINER_LIMITS,
): Promise<ContainerOutcome> {
  const located = await locateDirectory(storage, source.key, source.size);
  if (!located.ok) return located;
  const directory = located.directory;
  const span: DirectorySpan = { offset: directory.offset, size: directory.size };

  if (directory.bytesFromTail) {
    const rules = surveyBytes(directory.bytesFromTail, directory, source.filename);
    return rules ? { ok: true, skipped: "small", directory: span, rootPrefix: rules.rootPrefix } : { ok: false, reason: "corrupt" };
  }
  if (directory.size > limits.maxDirectoryBytes) {
    const survey = await surveyStream(storage, source, directory);
    return survey ? { ok: true, skipped: "too-large", directory: span, rootPrefix: survey.rules.rootPrefix } : { ok: false, reason: "corrupt" };
  }

  const read = await directoryTable(storage, source, directory);
  if (!read.ok) return read;
  if (read.directoryRecordCount > limits.maxEntries) return { ok: true, skipped: "too-large", directory: span, rootPrefix: read.rules.rootPrefix };
  const bytes = encodeIndex({ ...read, directory, sourceSize: source.size });
  if (!bytes) throw new Error(`container index for ${source.key}: the etag or root prefix does not fit the index header`);
  await storage.put(target, new Blob([bytes as BlobPart]).stream(), "application/octet-stream", bytes.byteLength);
  return { ok: true, index: target, directory: span, rootPrefix: read.rules.rootPrefix };
}
