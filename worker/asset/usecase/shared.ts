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
