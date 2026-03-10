export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function storageKey(id: string, filename: string): string {
  return `assets/${id}/${filename}`;
}
