import type { AssetMetadata } from "../model";
import type { AtomicWrites, FileStorage } from "../repository";
import type { CleanupPendingStore } from "../../cleanup/repository";
import { deleteAllR2Objects, SubrequestBudget } from "../../cleanup/usecase";
import { settleReleasedSiteHosts } from "../../site/usecase";
import type { SiteHostDeps } from "../../site/usecase";
import type { SiteHost } from "../../site/repository";

// Small inline budget so a DELETE doesn't monopolise the HTTP request's
// subrequest cap. Archive assets with huge extractions overflow this and
// are left to the cron, which drains cleanup_pending.
const INLINE_DELETE_BUDGET = 50;

export async function deleteAsset(
  writes: AtomicWrites,
  storage: FileStorage,
  asset: AssetMetadata,
  options?: {
    usageScopes?: string[];
    pendingCleanup?: CleanupPendingStore;
    budget?: SubrequestBudget;
    /** Site-host stores; omitted where the caller has no site hosts (tests). */
    siteHosts?: SiteHostDeps;
    now?: number;
  },
): Promise<void> {
  // Rows, usage counters, the cleanup_pending entry and the release of the
  // asset's site hosts go out in one atomic write (ADR-012 §3). The R2 prefix
  // is queued before any object is touched, so a failure below can no longer
  // orphan the bytes or skip the decrements. The names are released (ADR-013
  // B3: "asset deletion releases, it does not cascade") in that same write, so
  // a failed delete leaves them serving the asset that is still there
  // (compliance#258 REL-11). Released rows live out their 30-day cooldown
  // answering 410, which closes the subdomain-takeover window a cascading
  // delete would reopen.
  const prefix = `assets/${asset.id}/`;
  const { releasedSiteHosts } = await writes.deleteAsset({
    asset,
    usageScopes: options?.usageScopes,
    cleanupPrefix: prefix,
    releasedAt: options?.now,
  });
  if (options?.siteHosts) await settleReleasedSiteHosts(options.siteHosts, releasedSiteHosts);

  try {
    const budget = options?.budget ?? new SubrequestBudget(INLINE_DELETE_BUDGET);
    const r2Result = await deleteAllR2Objects(storage, prefix, budget);
    if (r2Result.done) await options?.pendingCleanup?.remove(prefix);
  } catch (e) {
    console.warn(`deleteAsset: inline R2 cleanup of ${prefix} failed; left to cron:`, e);
  }
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  const asset: AssetMetadata = {
    id: "a1", filename: "f.zip", contentType: "application/zip", size: 10, createdAt: 1, expiresAt: 0,
  };

  function mockWrites() {
    return {
      createAsset: vi.fn(),
      createVersion: vi.fn(),
      deleteVersion: vi.fn(),
      saveJob: vi.fn(),
      deleteAsset: vi.fn(async () => ({ releasedSiteHosts: [] as SiteHost[] })),
    } satisfies AtomicWrites;
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

  function mockPending() {
    return {
      add: vi.fn(async () => {}),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    } satisfies CleanupPendingStore;
  }

  test("deleteAsset writes rows atomically, clears R2, then drops the pending entry", async () => {
    const writes = mockWrites();
    const st = mockStorageWithKeys(["assets/a1/f.zip", "assets/a1/files/a.txt", "assets/other/x"]);
    const pending = mockPending();

    await deleteAsset(writes, st, asset, { usageScopes: ["project:p1"], pendingCleanup: pending });

    expect(writes.deleteAsset).toHaveBeenCalledWith({
      asset, usageScopes: ["project:p1"], cleanupPrefix: "assets/a1/", releasedAt: undefined,
    });
    expect(st.deleteMany).toHaveBeenCalledWith(["assets/a1/f.zip", "assets/a1/files/a.txt"]);
    expect(pending.remove).toHaveBeenCalledWith("assets/a1/");
  });

  test("deleteAsset leaves the prefix queued when the R2 budget runs out", async () => {
    const pages = [
      { keys: ["assets/a1/a"], cursor: "c1" },
      { keys: ["assets/a1/b"], cursor: undefined as string | undefined },
    ];
    let pageIdx = 0;
    const st: FileStorage = {
      put: vi.fn(),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(),
      deleteMany: vi.fn(async () => {}),
      list: vi.fn(async () => pages[pageIdx++] ?? { keys: [], cursor: undefined }),
    };
    const pending = mockPending();

    await deleteAsset(mockWrites(), st, asset, { pendingCleanup: pending, budget: new SubrequestBudget(2) });
    expect(pending.remove).not.toHaveBeenCalled();
  });

  test("deleteAsset succeeds and leaves the prefix queued when R2 fails", async () => {
    const st = mockStorageWithKeys(["assets/a1/f.zip"]);
    st.list = vi.fn(async () => { throw new Error("R2 503"); });
    const pending = mockPending();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(deleteAsset(mockWrites(), st, asset, { pendingCleanup: pending })).resolves.toBeUndefined();
    expect(pending.remove).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  function siteHostDepsMock() {
    return {
      hosts: {} as SiteHostDeps["hosts"],
      cache: { get: vi.fn(async () => null), put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
      provisioner: {
        provision: vi.fn(), status: vi.fn(), deprovision: vi.fn(async () => {}),
      },
      suffix: ".serve.example.test",
    } satisfies SiteHostDeps;
  }

  function released(over: Partial<SiteHost>): SiteHost {
    return {
      hostname: "map.serve.example.test", assetId: null, projectId: "p1", kind: "subdomain",
      verifiedAt: null, disabledAt: null, previews: false, releasedAt: 9000, createdAt: 1,
      createdBy: null, verificationToken: null, certificateStatus: null, ...over,
    };
  }

  test("deleteAsset drops the released names' cache and gives up verified custom certificates", async () => {
    const writes = mockWrites();
    writes.deleteAsset.mockResolvedValueOnce({
      releasedSiteHosts: [
        released({}),
        released({ hostname: "maps.example.com", kind: "custom", verifiedAt: 5 }),
        released({ hostname: "pending.example.com", kind: "custom" }),
      ],
    });
    const siteHosts = siteHostDepsMock();

    await deleteAsset(writes, mockStorageWithKeys([]), asset, { siteHosts, now: 9000 });

    expect(writes.deleteAsset).toHaveBeenCalledWith(expect.objectContaining({ releasedAt: 9000 }));
    expect(siteHosts.cache.delete).toHaveBeenCalledTimes(3);
    expect(siteHosts.provisioner.deprovision).toHaveBeenCalledExactlyOnceWith("maps.example.com");
  });

  // compliance#258 REL-11: nothing about the names may change before the write commits.
  test("deleteAsset leaves site hosts alone when the row write fails", async () => {
    const writes = mockWrites();
    writes.deleteAsset.mockRejectedValueOnce(new Error("D1 down"));
    const siteHosts = siteHostDepsMock();

    await expect(deleteAsset(writes, mockStorageWithKeys([]), asset, { siteHosts })).rejects.toThrow("D1 down");
    expect(siteHosts.cache.delete).not.toHaveBeenCalled();
    expect(siteHosts.provisioner.deprovision).not.toHaveBeenCalled();
  });

  test("deleteAsset propagates a failed row write without touching R2", async () => {
    const writes = mockWrites();
    writes.deleteAsset.mockRejectedValueOnce(new Error("D1 down"));
    const st = mockStorageWithKeys(["assets/a1/f.zip"]);

    await expect(deleteAsset(writes, st, asset)).rejects.toThrow("D1 down");
    expect(st.list).not.toHaveBeenCalled();
  });
}
