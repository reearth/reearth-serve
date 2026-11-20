import type { ProjectStore } from "../../project/repository";
import { HoldLost, type FileStorage, type Publishing } from "../repository";

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function storageKey(id: string, filename: string): string {
  return `assets/${id}/${filename}`;
}

export function assetPrefix(id: string): string {
  return `assets/${id}/`;
}

export function versionPrefix(assetId: string, versionId: string): string {
  return `assets/${assetId}/v/${versionId}/`;
}

export function versionStorageKey(assetId: string, versionId: string, filename: string): string {
  return `assets/${assetId}/v/${versionId}/${filename}`;
}

export function versionFilesPrefix(assetId: string, versionId: string): string {
  return `assets/${assetId}/v/${versionId}/files/`;
}

export function versionArchivePrefix(assetId: string, versionId: string): string {
  return `assets/${assetId}/v/${versionId}/_archive/`;
}

export function versionThumbsPrefix(assetId: string, versionId: string): string {
  return `assets/${assetId}/v/${versionId}/_thumbs/`;
}

export function versionThumbKey(assetId: string, versionId: string, filename: string): string {
  return `assets/${assetId}/v/${versionId}/_thumbs/${filename}`;
}

// Legacy (no-version) thumbnail layout — used when an asset has no version row
// (initial upload via POST /api/v1/assets that did not go through the versioned
// path). Once all assets carry versions this can go away.
export function legacyThumbsPrefix(assetId: string): string {
  return `assets/${assetId}/_thumbs/`;
}

export function legacyThumbKey(assetId: string, filename: string): string {
  return `assets/${assetId}/_thumbs/${filename}`;
}

export async function usageScopesFor(
  projects: Pick<ProjectStore, "find">,
  projectId: string | null | undefined,
): Promise<string[]> {
  if (!projectId) return [];
  const scopes = [`project:${projectId}`];
  const project = await projects.find(projectId);
  if (project?.workspaceId) scopes.push(`workspace:${project.workspaceId}`);
  return scopes;
}

/**
 * After a create write threw, delete the bytes it was to point at, unless the
 * write may have applied: a publish that failed other than by `HoldLost` and
 * whose row a re-read finds, or cannot rule out, keeps its bytes. A leak is
 * cheaper than a live object without bytes.
 */
export async function dropUnwrittenBytes(storage: FileStorage, key: string, error: unknown, publishing?: Pick<Publishing<unknown>, "applied">): Promise<void> {
  if (publishing && !(error instanceof HoldLost) && (await publishing.applied().catch(() => true))) return;
  try {
    await storage.delete(key);
  } catch (e) {
    console.error(`Failed to clean up ${key} after its metadata write failed:`, e);
  }
}
