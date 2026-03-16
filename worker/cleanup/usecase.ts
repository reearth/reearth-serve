import type { FileStorage, MetadataStore } from "../asset/repository";
import type { JobStore } from "../job/repository";

export interface CleanupResult {
  deletedAssets: string[];
  deletedJobs: string[];
  nextCursor?: string;
}

/**
 * Scan R2 for orphaned assets whose KV metadata has expired (TTL),
 * and delete all R2 objects + associated jobs.
 */
export async function cleanupExpiredAssets(
  metadata: MetadataStore,
  storage: FileStorage,
  jobs: JobStore,
  options?: { cursor?: string; maxAssets?: number },
): Promise<CleanupResult> {
  const maxAssets = options?.maxAssets ?? 100;

  // List R2 objects under assets/ to discover asset IDs
  const assetIds = new Set<string>();
  let cursor = options?.cursor;
  let scanned = 0;

  // Scan R2 keys, extracting unique asset IDs from paths like "assets/{id}/..."
  while (scanned < maxAssets) {
    const batch = await storage.list("assets/", {
      limit: 1000,
      cursor,
    });

    for (const key of batch.keys) {
      const id = extractAssetId(key);
      if (id) assetIds.add(id);
      if (assetIds.size >= maxAssets) break;
    }

    cursor = batch.cursor;
    scanned = assetIds.size;

    if (!batch.cursor || assetIds.size >= maxAssets) break;
  }

  const deletedAssets: string[] = [];
  const deletedJobs: string[] = [];

  for (const assetId of assetIds) {
    // Check if KV metadata still exists
    const asset = await metadata.find(assetId);
    if (asset) continue; // Still alive — skip

    // Asset metadata expired — clean up R2 objects
    await deleteAllR2Objects(storage, `assets/${assetId}/`);
    deletedAssets.push(assetId);

    // Clean up associated job (job ID = asset ID for archive-extraction)
    const job = await jobs.find(assetId);
    if (job) {
      await jobs.delete(assetId);
      deletedJobs.push(assetId);
    }
  }

  return { deletedAssets, deletedJobs, nextCursor: cursor };
}

/** Extract asset ID from R2 key like "assets/{id}/filename" */
function extractAssetId(key: string): string | null {
  if (!key.startsWith("assets/")) return null;
  const rest = key.slice("assets/".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  return rest.slice(0, slashIdx);
}

/** Delete all R2 objects under a prefix */
async function deleteAllR2Objects(
  storage: FileStorage,
  prefix: string,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const batch = await storage.list(prefix, { limit: 1000, cursor });

    for (const key of batch.keys) {
      await storage.delete(key);
    }

    cursor = batch.cursor;
  } while (cursor);
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockMetadata(existing: Set<string>): MetadataStore {
    return {
      save: vi.fn(),
      find: vi.fn(async (id: string) => existing.has(id) ? { id } as any : null),
      delete: vi.fn(),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  function mockStorage(keys: string[]): FileStorage {
    const remaining = new Set(keys);
    return {
      put: vi.fn(),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async (key: string) => { remaining.delete(key); }),
      list: vi.fn(async (prefix: string) => ({
        keys: [...remaining].filter((k) => k.startsWith(prefix)),
        cursor: undefined,
      })),
    };
  }

  function mockJobs(existing: Set<string>): JobStore {
    return {
      save: vi.fn(),
      find: vi.fn(async (id: string) => existing.has(id) ? { id } as any : null),
      delete: vi.fn(async (id: string) => { existing.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  test("cleanupExpiredAssets deletes orphaned R2 objects and jobs", async () => {
    const md = mockMetadata(new Set(["alive-id"]));
    const st = mockStorage([
      "assets/alive-id/file.txt",
      "assets/expired-id/file.zip",
      "assets/expired-id/_archive/_manifest.jsonl",
      "assets/expired-id/files/data.json",
    ]);
    const jb = mockJobs(new Set(["expired-id"]));

    const result = await cleanupExpiredAssets(md, st, jb);

    expect(result.deletedAssets).toEqual(["expired-id"]);
    expect(result.deletedJobs).toEqual(["expired-id"]);
    // alive-id objects should not be deleted
    expect(st.delete).not.toHaveBeenCalledWith("assets/alive-id/file.txt");
    // expired-id objects should be deleted
    expect(st.delete).toHaveBeenCalledWith("assets/expired-id/file.zip");
    expect(st.delete).toHaveBeenCalledWith("assets/expired-id/_archive/_manifest.jsonl");
    expect(st.delete).toHaveBeenCalledWith("assets/expired-id/files/data.json");
  });

  test("cleanupExpiredAssets skips assets with existing metadata", async () => {
    const md = mockMetadata(new Set(["alive-id"]));
    const st = mockStorage(["assets/alive-id/file.txt"]);
    const jb = mockJobs(new Set());

    const result = await cleanupExpiredAssets(md, st, jb);

    expect(result.deletedAssets).toEqual([]);
    expect(st.delete).not.toHaveBeenCalled();
  });

  test("cleanupExpiredAssets respects maxAssets limit", async () => {
    const md = mockMetadata(new Set());
    const st = mockStorage([
      "assets/id1/file.txt",
      "assets/id2/file.txt",
      "assets/id3/file.txt",
    ]);
    const jb = mockJobs(new Set());

    const result = await cleanupExpiredAssets(md, st, jb, { maxAssets: 2 });

    expect(result.deletedAssets.length).toBeLessThanOrEqual(2);
  });

  test("extractAssetId extracts ID from R2 key", () => {
    expect(extractAssetId("assets/abc123/file.txt")).toBe("abc123");
    expect(extractAssetId("assets/abc123/_archive/_manifest.jsonl")).toBe("abc123");
    expect(extractAssetId("assets/abc123/files/data.json")).toBe("abc123");
    expect(extractAssetId("other/path")).toBeNull();
    expect(extractAssetId("assets/")).toBeNull();
  });
}
