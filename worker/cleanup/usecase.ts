import type { FileStorage, MetadataStore, VersionStore } from "../asset/repository";
import type { JobStore } from "../job/repository";

export interface CleanupResult {
  deletedAssets: string[];
  deletedJobs: string[];
  /** True if we bailed mid-run because the subrequest budget ran low. */
  budgetExhausted: boolean;
}

/**
 * Tracks the remaining Cloudflare Workers subrequest budget for a single
 * scheduled invocation. The scheduled handler caps at 1000 subrequests
 * total, and one expired asset with a tile-pyramid extraction can easily
 * eat all of it (list + deleteMany per 1000 R2 keys). When we blow past
 * the budget, the runtime aborts mid-loop and the D1 row never gets
 * removed, so the same asset stays in `listExpired` forever and blocks
 * every subsequent tick. Budget tracking lets us stop early, leave the
 * row in place, and let the next cron tick pick up where we left off —
 * forward progress is made by R2 list() naturally returning fewer keys
 * each pass as deletions complete.
 */
export class SubrequestBudget {
  private used = 0;
  constructor(public readonly cap: number) {}
  charge(n: number = 1): void { this.used += n; }
  canAfford(n: number): boolean { return this.used + n <= this.cap; }
  get remaining(): number { return Math.max(0, this.cap - this.used); }
  get spent(): number { return this.used; }
}

// Reserve enough budget for the post-R2 bookkeeping so we don't delete R2
// objects and then fail to remove the D1 row (which would leave the asset
// perpetually expired). versions.deleteByAssetId + metadata.delete +
// jobs.find + jobs.delete = 4 D1 subrequests.
const PER_ASSET_TAIL_BUDGET = 4;

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
  options?: { maxAssets?: number; versions?: VersionStore; budget?: SubrequestBudget },
): Promise<CleanupResult> {
  const maxAssets = options?.maxAssets ?? 100;
  // Default cap leaves headroom for the listExpired call itself and the
  // concurrent retriggerPendingJobs path in the scheduled handler.
  const budget = options?.budget ?? new SubrequestBudget(700);
  const deletedAssets: string[] = [];
  const deletedJobs: string[] = [];
  let budgetExhausted = false;

  // Use D1-based expiry query if available, otherwise fall back to R2 scan
  if (metadata.listExpired) {
    const expired = await metadata.listExpired(Date.now(), maxAssets);
    budget.charge();

    for (const asset of expired) {
      // Ensure we have enough budget for at least one list+deleteMany cycle
      // plus the post-cleanup D1 operations; otherwise bail and resume later.
      if (!budget.canAfford(2 + PER_ASSET_TAIL_BUDGET)) {
        budgetExhausted = true;
        break;
      }

      // Delete R2 objects (covers both legacy and versioned layouts). If
      // we run out of budget partway through, we leave the D1 row alone
      // so listExpired returns the asset again next tick.
      const r2Result = await deleteAllR2Objects(storage, `assets/${asset.id}/`, budget);
      if (!r2Result.done) {
        budgetExhausted = true;
        break;
      }

      // Delete all versions from D1
      if (options?.versions) {
        await options.versions.deleteByAssetId(asset.id);
        budget.charge();
      }

      // Delete metadata from D1
      await metadata.delete(asset.id);
      budget.charge();
      deletedAssets.push(asset.id);

      // Clean up associated job
      const job = await jobs.find(asset.id);
      budget.charge();
      if (job) {
        await jobs.delete(asset.id);
        budget.charge();
        deletedJobs.push(asset.id);
      }
    }
  } else {
    // Legacy R2-scan fallback (for backward compatibility during migration)
    const assetIds = new Set<string>();
    let cursor: string | undefined;

    while (assetIds.size < maxAssets && budget.canAfford(1)) {
      const batch = await storage.list("assets/", { limit: 1000, cursor });
      budget.charge();

      for (const key of batch.keys) {
        const id = extractAssetId(key);
        if (id) assetIds.add(id);
        if (assetIds.size >= maxAssets) break;
      }

      cursor = batch.cursor;
      if (!batch.cursor || assetIds.size >= maxAssets) break;
    }

    for (const assetId of assetIds) {
      if (!budget.canAfford(3 + PER_ASSET_TAIL_BUDGET)) {
        budgetExhausted = true;
        break;
      }

      const asset = await metadata.find(assetId);
      budget.charge();
      if (asset) continue; // Still alive — skip

      const r2Result = await deleteAllR2Objects(storage, `assets/${assetId}/`, budget);
      if (!r2Result.done) {
        budgetExhausted = true;
        break;
      }

      // Delete orphaned versions from D1
      if (options?.versions) {
        await options.versions.deleteByAssetId(assetId);
        budget.charge();
      }

      deletedAssets.push(assetId);

      const job = await jobs.find(assetId);
      budget.charge();
      if (job) {
        await jobs.delete(assetId);
        budget.charge();
        deletedJobs.push(assetId);
      }
    }
  }

  return { deletedAssets, deletedJobs, budgetExhausted };
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
 * Delete all R2 objects under a prefix, respecting the subrequest budget.
 *
 * Uses batch delete (up to 1000 keys per call) when supported. Returns
 * `done: false` as soon as the remaining budget cannot fund another full
 * list+deleteMany cycle; the caller treats that as "resume later" —
 * partially-deleted prefixes stay expired in D1 and are picked up again
 * on the next cron tick.
 */
async function deleteAllR2Objects(
  storage: FileStorage,
  prefix: string,
  budget: SubrequestBudget,
): Promise<{ done: boolean }> {
  let cursor: string | undefined;

  do {
    if (!budget.canAfford(2)) return { done: false };

    const batch = await storage.list(prefix, { limit: 1000, cursor });
    budget.charge();

    if (batch.keys.length > 0) {
      if (storage.deleteMany) {
        await storage.deleteMany(batch.keys);
        budget.charge();
      } else {
        // Per-key delete is pathological for big prefixes; only proceed if
        // we have budget for all of them, otherwise yield to the next tick.
        if (!budget.canAfford(batch.keys.length)) return { done: false };
        for (const key of batch.keys) {
          await storage.delete(key);
          budget.charge();
        }
      }
    }

    cursor = batch.cursor;
  } while (cursor);
  return { done: true };
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

  test("SubrequestBudget charge and canAfford", () => {
    const b = new SubrequestBudget(10);
    expect(b.canAfford(10)).toBe(true);
    expect(b.canAfford(11)).toBe(false);
    b.charge(3);
    expect(b.remaining).toBe(7);
    expect(b.canAfford(7)).toBe(true);
    expect(b.canAfford(8)).toBe(false);
  });

  test("cleanupExpiredAssets leaves asset intact when R2 budget exhausts mid-prefix", async () => {
    const expiredAsset = {
      id: "big-archive", filename: "tiles.zip", contentType: "application/zip",
      size: 100, createdAt: 1000, expiresAt: 500,
    } as import("../asset/model").AssetMetadata;

    // Mock storage whose list() returns one page at a time with keys and
    // a cursor, so cleanup will keep looping until budget runs out. Four
    // pages means we need 4 list+deleteMany cycles (8 subreqs) plus the
    // tail bookkeeping — not fundable with an 8-subreq budget.
    const pages = [
      { keys: Array.from({ length: 1000 }, (_, i) => `assets/big-archive/tile-${i}.pbf`), cursor: "c1" },
      { keys: Array.from({ length: 1000 }, (_, i) => `assets/big-archive/tile-${1000 + i}.pbf`), cursor: "c2" },
      { keys: Array.from({ length: 1000 }, (_, i) => `assets/big-archive/tile-${2000 + i}.pbf`), cursor: "c3" },
      { keys: Array.from({ length: 1000 }, (_, i) => `assets/big-archive/tile-${3000 + i}.pbf`), cursor: undefined as string | undefined },
    ];
    let pageIdx = 0;
    const storage: FileStorage = {
      put: vi.fn(),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      deleteMany: vi.fn(async () => {}),
      list: vi.fn(async () => pages[pageIdx++] ?? { keys: [], cursor: undefined }),
    };

    const md = mockMetadataWithExpired(new Set(), [expiredAsset]);
    const jb = mockJobs(new Set());

    const budget = new SubrequestBudget(8);
    const result = await cleanupExpiredAssets(md, storage, jb, { budget });

    expect(result.budgetExhausted).toBe(true);
    expect(result.deletedAssets).toEqual([]);
    // The asset's D1 row must survive so listExpired returns it again next tick.
    expect(md.delete).not.toHaveBeenCalled();
    // But we should have made forward progress on R2.
    expect(storage.deleteMany).toHaveBeenCalled();
  });

  test("cleanupExpiredAssets completes when budget is generous", async () => {
    const expiredAsset = {
      id: "small-archive", filename: "x.zip", contentType: "application/zip",
      size: 10, createdAt: 1, expiresAt: 2,
    } as import("../asset/model").AssetMetadata;

    const md = mockMetadataWithExpired(new Set(), [expiredAsset]);
    const st = mockStorage(["assets/small-archive/x.zip"]);
    const jb = mockJobs(new Set());

    const result = await cleanupExpiredAssets(md, st, jb, {
      budget: new SubrequestBudget(100),
    });

    expect(result.budgetExhausted).toBe(false);
    expect(result.deletedAssets).toEqual(["small-archive"]);
    expect(md.delete).toHaveBeenCalledWith("small-archive");
  });
}
