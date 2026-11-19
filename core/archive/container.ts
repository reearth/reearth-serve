import type { FileStorage } from "../asset/repository";
import type { ArchiveSource } from "./reader";
import type { DirectoryRefusal } from "./zip/directory";

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

export async function buildContainerIndex(
  storage: FileStorage,
  source: ArchiveSource,
  target: string,
  limits: ContainerLimits = CONTAINER_LIMITS,
): Promise<ContainerOutcome> {
  void storage;
  void source;
  void target;
  void limits;
  throw new Error("buildContainerIndex: not implemented");
}
