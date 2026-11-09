import type { ProjectStore } from "../../project/repository";

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function storageKey(id: string, filename: string): string {
  return `assets/${id}/${filename}`;
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

/**
 * Storage-usage counter scopes for a project asset: the project itself and,
 * when the project belongs to one, its workspace. Empty for session-scoped
 * (demo) assets, which are not counted (ADR-004).
 */
export async function usageScopesFor(projects: ProjectStore, projectId: string | null | undefined): Promise<string[]> {
  if (!projectId) return [];
  const scopes = [`project:${projectId}`];
  const project = await projects.find(projectId);
  if (project?.workspaceId) scopes.push(`workspace:${project.workspaceId}`);
  return scopes;
}
