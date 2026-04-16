import type { FileStorage, MetadataStore, VersionStore } from "../asset/repository";
import type { JobStore } from "../job/repository";

export interface CleanupResult {
  deletedAssets: string[];
  deletedJobs: string[];
}

/**
 * Find expired assets via D1 query and delete their R2 objects + metadata + jobs.
 *
 * With D1, expired asset discovery is a simple SQL query instead of an R2 prefix scan.
 * No cursor is needed — the query is stateless and uses LIMIT for batching.
 */
export async function cleanupExpiredAssets(
  metadata: MetadataStore & { listExpired?: (now: number, limit: number) => Promise<import("../asset/model").AssetMetadata[]> },
  storage: FileStorage,
  jobs: JobStore,
  options?: { maxAssets?: number; versions?: VersionStore },
): Promise<CleanupResult> {
  const maxAssets = options?.maxAssets ?? 100;
  const deletedAssets: string[] = [];
  const deletedJobs: string[] = [];

  // Use D1-based expiry query if available, otherwise fall back to R2 scan
  if (metadata.listExpired) {
    const expired = await metadata.listExpired(Date.now(), maxAssets);

    for (const asset of expired) {
      // Delete all versions from D1
      if (options?.versions) {
        await options.versions.deleteByAssetId(asset.id);
      }

      // Delete R2 objects (covers both legacy and versioned layouts)
      await deleteAllR2Objects(storage, `assets/${asset.id}/`);

      // Delete metadata from D1
      await metadata.delete(asset.id);
      deletedAssets.push(asset.id);

      // Clean up associated job
      const job = await jobs.find(asset.id);
      if (job) {
        await jobs.delete(asset.id);
        deletedJobs.push(asset.id);
      }
    }
  } else {
    // Legacy R2-scan fallback (for backward compatibility during migration)
    const assetIds = new Set<string>();
    let cursor: string | undefined;

    while (assetIds.size < maxAssets) {
      const batch = await storage.list("assets/", { limit: 1000, cursor });

      for (const key of batch.keys) {
        const id = extractAssetId(key);
        if (id) assetIds.add(id);
        if (assetIds.size >= maxAssets) break;
      }

      cursor = batch.cursor;
      if (!batch.cursor || assetIds.size >= maxAssets) break;
    }

    for (const assetId of assetIds) {
      const asset = await metadata.find(assetId);
      if (asset) continue; // Still alive — skip

      // Delete orphaned versions from D1
      if (options?.versions) {
        await options.versions.deleteByAssetId(assetId);
      }

      await deleteAllR2Objects(storage, `assets/${assetId}/`);
      deletedAssets.push(assetId);

      const job = await jobs.find(assetId);
      if (job) {
        await jobs.delete(assetId);
        deletedJobs.push(assetId);
      }
    }
  }

  return { deletedAssets, deletedJobs };
}

/** Extract asset ID from R2 key like "assets/{id}/filename" */
function extractAssetId(key: string): string | null {
  if (!key.startsWith("assets/")) return null;
  const rest = key.slice("assets/".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  return rest.slice(0, slashIdx);
}

/**
 * Delete all R2 objects under a prefix.
 *
 * Uses batch delete (up to 1000 keys per call) when supported. Without
 * batching, an asset with thousands of extracted files (e.g. tile pyramids)
 * would single-handedly exhaust the Worker subrequest cap and abort cleanup
 * mid-flight, leaking storage indefinitely.
 */
async function deleteAllR2Objects(
  storage: FileStorage,
  prefix: string,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const batch = await storage.list(prefix, { limit: 1000, cursor });

    if (batch.keys.length > 0) {
      if (storage.deleteMany) {
        await storage.deleteMany(batch.keys);
      } else {
        for (const key of batch.keys) {
          await storage.delete(key);
        }
      }
    }

    cursor = batch.cursor;
  } while (cursor);
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockMetadata(existing: Set<string>): MetadataStore & { listExpired: (now: number, limit: number) => Promise<import("../asset/model").AssetMetadata[]> } {
    const assets = new Map<string, import("../asset/model").AssetMetadata>();
    for (const id of existing) {
      assets.set(id, { id, filename: `${id}.bin`, contentType: "application/octet-stream", size: 100, createdAt: Date.now(), expiresAt: Date.now() + 3600000 } as import("../asset/model").AssetMetadata);
    }
    return {
      save: vi.fn(),
      find: vi.fn(async (id: string) => assets.get(id) ?? null),
      update: vi.fn(async () => {}),
      delete: vi.fn(async (id: string) => { assets.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
      listExpired: vi.fn(async (_now: number, _limit: number) => []),
    };
  }

  function mockMetadataWithExpired(
    existing: Set<string>,
    expired: import("../asset/model").AssetMetadata[],
  ): MetadataStore & { listExpired: (now: number, limit: number) => Promise<import("../asset/model").AssetMetadata[]> } {
    const base = mockMetadata(existing);
    base.listExpired = vi.fn(async () => expired);
    return base;
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

  function mockJobs(existing: Set<string>): import("../job/repository").JobStore {
    return {
      save: vi.fn(),
      find: vi.fn(async (id: string) => existing.has(id) ? { id } as any : null),
      delete: vi.fn(async (id: string) => { existing.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  test("cleanupExpiredAssets deletes expired assets via D1 listExpired", async () => {
    const expiredAsset = {
      id: "expired-id", filename: "file.zip", contentType: "application/zip",
      size: 100, createdAt: 1000, expiresAt: 500,
    } as import("../asset/model").AssetMetadata;

    const md = mockMetadataWithExpired(new Set(["alive-id"]), [expiredAsset]);
    const st = mockStorage([
      "assets/expired-id/file.zip",
      "assets/expired-id/files/data.json",
    ]);
    const jb = mockJobs(new Set(["expired-id"]));

    const result = await cleanupExpiredAssets(md, st, jb);

    expect(result.deletedAssets).toEqual(["expired-id"]);
    expect(result.deletedJobs).toEqual(["expired-id"]);
    expect(md.delete).toHaveBeenCalledWith("expired-id");
    expect(st.delete).toHaveBeenCalledWith("assets/expired-id/file.zip");
    expect(st.delete).toHaveBeenCalledWith("assets/expired-id/files/data.json");
  });

  test("cleanupExpiredAssets returns empty when nothing expired", async () => {
    const md = mockMetadataWithExpired(new Set(["alive-id"]), []);
    const st = mockStorage(["assets/alive-id/file.txt"]);
    const jb = mockJobs(new Set());

    const result = await cleanupExpiredAssets(md, st, jb);

    expect(result.deletedAssets).toEqual([]);
    expect(st.delete).not.toHaveBeenCalled();
  });

  test("extractAssetId extracts ID from R2 key", () => {
    expect(extractAssetId("assets/abc123/file.txt")).toBe("abc123");
    expect(extractAssetId("assets/abc123/_archive/_manifest.jsonl")).toBe("abc123");
    expect(extractAssetId("assets/abc123/files/data.json")).toBe("abc123");
    expect(extractAssetId("other/path")).toBeNull();
    expect(extractAssetId("assets/")).toBeNull();
  });
}
