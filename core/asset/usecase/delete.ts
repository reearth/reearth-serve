import type { AssetMetadata } from "../model";
import type { AtomicWrites, FileStorage, MetadataStore } from "../repository";
import type { CleanupPendingStore } from "../../cleanup/repository";
import { deleteAllR2Objects, SubrequestBudget } from "../../cleanup/usecase";
import { releaseAssetSiteHosts } from "../../site/usecase";
import type { SiteHostDeps } from "../../site/usecase";

// Small inline budget so a DELETE doesn't monopolise the HTTP request's
// subrequest cap. Archive assets with huge extractions overflow this and
// fall through to the pending-cleanup queue drained by cron.
const INLINE_DELETE_BUDGET = 50;

export async function deleteAsset(
  metadata: MetadataStore,
  storage: FileStorage,
  id: string,
  options?: {
    pendingCleanup?: CleanupPendingStore;
    budget?: SubrequestBudget;
    /** Site-host stores; omitted where the caller has no site hosts (tests). */
    siteHosts?: SiteHostDeps;
    now?: number;
  },
): Promise<boolean> {
  const asset = await metadata.find(id);
  if (!asset) return false;

  // Release the asset's names before the row goes; ADR-013 B3: "asset deletion
  // releases, it does not cascade". The rows live out their 30-day cooldown
  // answering 410 and cannot be re-claimed meanwhile, which is what closes the
  // subdomain-takeover window a cascading delete would reopen.
  if (options?.siteHosts) {
    await releaseAssetSiteHosts(options.siteHosts, id, options.now);
  }

  // Drop the D1 row first so the asset is immediately unreachable via the
  // API. R2 cleanup is best-effort inline; any leftover object under the
  // prefix is picked up by the cron via cleanup_pending.
  await metadata.delete(id);

  const prefix = `assets/${id}/`;
  const budget = options?.budget ?? new SubrequestBudget(INLINE_DELETE_BUDGET);
  const r2Result = await deleteAllR2Objects(storage, prefix, budget);

  if (!r2Result.done) {
    if (options?.pendingCleanup) {
      await options.pendingCleanup.add(prefix);
    } else {
      // No background cleanup wired up — this path should only happen in
      // tests. Log so we notice if it ever happens in production.
      console.warn(`deleteAsset: R2 cleanup incomplete and no pendingCleanup store provided for ${prefix}`);
    }
  }

  return true;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockMetadata(): MetadataStore {
    const store = new Map<string, AssetMetadata>();
    return {
      save: vi.fn(async (asset: AssetMetadata, _ttl: number) => { store.set(asset.id, asset); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      update: vi.fn(async () => {}),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  function mockStorage(): FileStorage {
    return {
      put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>, _ct: string, _size: number) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
      }),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], cursor: undefined })),
    };
  }

  function mockStorageWithKeys(keys: string[]): FileStorage {
    const remaining = new Set(keys);
    return {
      put: vi.fn(),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async (key: string) => { remaining.delete(key); }),
      deleteMany: vi.fn(async (ks: string[]) => { for (const k of ks) remaining.delete(k); }),
      list: vi.fn(async (prefix: string) => ({
        keys: [...remaining].filter((k) => k.startsWith(prefix)),
        cursor: undefined,
      })),
    };
  }

  function mockPending(): { add: any; list: any; remove: any } {
    return {
      add: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
  }

  test("deleteAsset removes metadata and every R2 object under the asset prefix", async () => {
    const md = mockMetadata();
    // AtomicWrites over the metadata mock: uploadAsset writes through the port.
    const writes: AtomicWrites = {
      createAsset: async ({ asset }) => { await md.save(asset, 0); },
      createVersion: async () => { throw new Error("not used"); },
      saveJob: async () => {},
    };
    const { uploadAsset } = await import("./upload");
    const data = new TextEncoder().encode("data");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(data); c.close(); } });

    const st = mockStorageWithKeys([]);
    const { asset } = await uploadAsset(writes, st, { name: "f.bin", type: "application/octet-stream", body, size: 4 }, 3600, "https://example.com");
    // Simulate that archive extraction left files under the prefix.
    const stWithFiles = mockStorageWithKeys([
      `assets/${asset.id}/f.bin`,
      `assets/${asset.id}/files/a.txt`,
      `assets/${asset.id}/files/b.txt`,
    ]);

    const pending = mockPending();
    const deleted = await deleteAsset(md, stWithFiles, asset.id, { pendingCleanup: pending });
    expect(deleted).toBe(true);
    expect(md.delete).toHaveBeenCalledWith(asset.id);
    expect(stWithFiles.deleteMany).toHaveBeenCalledWith([
      `assets/${asset.id}/f.bin`,
      `assets/${asset.id}/files/a.txt`,
      `assets/${asset.id}/files/b.txt`,
    ]);
    expect(pending.add).not.toHaveBeenCalled();
  });

  test("deleteAsset stashes prefix in cleanup_pending when R2 budget runs out", async () => {
    const md = mockMetadata();
    // Pre-populate the D1 mock so find() returns something.
    await md.save({
      id: "big", filename: "big.zip", contentType: "application/zip",
      size: 1, createdAt: 1, expiresAt: 0,
    }, 0);

    // Multi-page R2 list so the budget can't finish inline.
    const pages = [
      { keys: ["assets/big/a"], cursor: "c1" },
      { keys: ["assets/big/b"], cursor: "c2" },
      { keys: ["assets/big/c"], cursor: undefined as string | undefined },
    ];
    let pageIdx = 0;
    const storage: FileStorage = {
      put: vi.fn(),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      deleteMany: vi.fn(async () => {}),
      list: vi.fn(async () => pages[pageIdx++] ?? { keys: [], cursor: undefined }),
    };

    const pending = mockPending();
    const budget = new SubrequestBudget(2); // enough for 1 cycle (list+deleteMany)
    const deleted = await deleteAsset(md, storage, "big", { pendingCleanup: pending, budget });
    expect(deleted).toBe(true);
    expect(pending.add).toHaveBeenCalledWith("assets/big/");
    // D1 row gone; R2 prefix queued for cron drain.
    expect(md.delete).toHaveBeenCalledWith("big");
  });

  test("deleteAsset returns false for non-existent asset", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const pending = mockPending();

    const deleted = await deleteAsset(md, st, "nonexistent", { pendingCleanup: pending });
    expect(deleted).toBe(false);
    expect(pending.add).not.toHaveBeenCalled();
  });
}
