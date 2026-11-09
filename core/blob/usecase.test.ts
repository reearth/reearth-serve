// Placement and sweeps of the blob layer (ADR-017 §3, §5), against the real
// SQL ledger and the in-memory object store.
import { beforeEach, describe, expect, test } from "vitest";
import { createSqliteClient } from "../../adapters/memory/sqlite-node";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { SqlBlobRefStore } from "../../adapters/sql/blob-refs";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import { SqlProjectStore } from "../../adapters/sql/stores";
import { SubrequestBudget } from "../cleanup/usecase";
import type { AssetMetadata } from "../asset/model";
import { BLOB_GRACE_MS, blobRefKey } from "./model";
import {
  BlobClaimedError, blobScopeFor, BlobUnavailableError, discardRejectedBlob, findReusableBlob, ORPHAN_CURSOR_KEY, ORPHAN_PAGE_SIZE,
  placeDirectUpload, placeSessionUpload, reuseFailure, sweepBlobs,
} from "./usecase";

const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const NOW = 10 * BLOB_GRACE_MS;

let refs: SqlBlobRefStore;
let writes: SqlAtomicWrites;
let storage: MemoryFileStorage;
let cache: MemoryKeyValue;
let projects: SqlProjectStore;

beforeEach(() => {
  const sql = createSqliteClient();
  refs = new SqlBlobRefStore(sql);
  writes = new SqlAtomicWrites(sql);
  projects = new SqlProjectStore(sql);
  storage = new MemoryFileStorage();
  cache = new MemoryKeyValue();
});

async function putObject(key: string, uploadedAt = NOW): Promise<void> {
  await storage.put(key, new Blob(["x"]).stream(), "application/octet-stream", 1);
  storage.setUploadedAt(key, uploadedAt);
}

async function exists(key: string): Promise<boolean> {
  return (await storage.head(key)) !== null;
}

function assetWith(id: string, blobKey: string): AssetMetadata {
  return { id, filename: "f", contentType: "t", size: 1, createdAt: 1, expiresAt: 0, blobKey };
}

const sweep = (now = NOW, budget = new SubrequestBudget(1000)) => sweepBlobs({ blobRefs: refs, storage, cache }, budget, now);

describe("blobScopeFor", () => {
  test("follows the project's workspace, falls back to p_{id}, and is _demo without a project", async () => {
    await projects.save({ id: "p1", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u", workspaceId: "w1" });
    await projects.save({ id: "p2", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u" });
    expect(await blobScopeFor(projects, "p1")).toBe("w1");
    expect(await blobScopeFor(projects, "p2")).toBe("p_p2");
    expect(await blobScopeFor(projects, null)).toBe("_demo");
    expect(await blobScopeFor(projects, undefined)).toBe("_demo");
  });
});

describe("placement", () => {
  test("a direct upload: undeclared stays classic; declared takes the blob key unless the ledger holds it", async () => {
    expect(await placeDirectUpload(refs, "w1", undefined, "assets/a/f", NOW)).toEqual({ key: "assets/a/f" });
    const ref = blobRefKey("w1", sha(1));
    expect(await placeDirectUpload(refs, "w1", sha(1), "assets/a/f", NOW)).toEqual({ key: ref.key, ref });
    // Reserved but not yet referenced: a second direct upload writes it too.
    expect(await placeDirectUpload(refs, "w1", sha(1), "assets/b/f", NOW)).toEqual({ key: ref.key, ref });

    await refs.claim(blobRefKey("w1", sha(2)), "s1", NOW + 1000, NOW);
    expect(await placeDirectUpload(refs, "w1", sha(2), "assets/c/f", NOW)).toEqual({ key: "assets/c/f" });
  });

  test("the scope keeps workspaces apart", async () => {
    const a = await placeDirectUpload(refs, "w1", sha(1), "assets/a/f", NOW);
    const b = await placeDirectUpload(refs, "w2", sha(1), "assets/b/f", NOW);
    expect(a.key).toBe(`blobs/w1/${sha(1)}`);
    expect(b.key).toBe(`blobs/w2/${sha(1)}`);
  });

  test("a session claims a free key, 409s on a live claim, falls back on an existing blob, and retakes an expired claim", async () => {
    const ref = blobRefKey("w1", sha(3));
    expect(await placeSessionUpload(refs, "w1", sha(3), "assets/s1/f", { id: "s1", expiresAt: NOW + 1000 }, NOW))
      .toEqual({ key: ref.key, ref });
    await expect(placeSessionUpload(refs, "w1", sha(3), "assets/s2/f", { id: "s2", expiresAt: NOW + 5000 }, NOW + 10))
      .rejects.toBeInstanceOf(BlobClaimedError);
    // Past the first session's expiry the key is claimable again.
    expect(await placeSessionUpload(refs, "w1", sha(3), "assets/s2/f", { id: "s2", expiresAt: NOW + 5000 }, NOW + 2000))
      .toEqual({ key: ref.key, ref });

    // Completed and verified: the next session reuses the bytes (ADR-017 §4).
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
    expect(await placeSessionUpload(refs, "w1", sha(3), "assets/s3/f", { id: "s3", expiresAt: NOW + 5000 }, NOW + 3000))
      .toEqual({ key: ref.key, ref, reuse: true });
    // Reusing takes no claim.
    expect(await refs.find(ref.key)).toMatchObject({ state: "ready", refCount: 1 });
    expect((await refs.find(ref.key))?.claimId).toBeUndefined();
    expect(await placeSessionUpload(refs, "w1", undefined, "assets/s4/f", { id: "s4", expiresAt: NOW }, NOW))
      .toEqual({ key: "assets/s4/f" });
  });

  describe("reuse (ADR-017 §4)", () => {
    const session = (id: string) => ({ id, expiresAt: NOW + 5000 });

    test("a ready, referenced blob is reused by direct uploads and sessions, in its own scope only", async () => {
      const ref = blobRefKey("w1", sha(20));
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });

      expect(await placeDirectUpload(refs, "w1", sha(20), "assets/b/f", NOW)).toEqual({ key: ref.key, ref, reuse: true });
      expect(await placeSessionUpload(refs, "w1", sha(20), "assets/s/f", session("s1"), NOW)).toEqual({ key: ref.key, ref, reuse: true });
      expect(await findReusableBlob(refs, "w1", sha(20))).toEqual({ key: ref.key, ref, reuse: true });

      // Another workspace with the same bytes writes its own blob.
      const other = blobRefKey("w2", sha(20));
      expect(await findReusableBlob(refs, "w2", sha(20))).toBeNull();
      expect(await placeDirectUpload(refs, "w2", sha(20), "assets/c/f", NOW)).toEqual({ key: other.key, ref: other });
    });

    test("a ready blob with no reference is not reused: a direct upload reserves and writes, a session falls back", async () => {
      const ref = blobRefKey("w1", sha(21));
      expect(await refs.reserve(ref, NOW)).toBe(true); // a reservation whose upload may have failed
      expect(await placeDirectUpload(refs, "w1", sha(21), "assets/b/f", NOW)).toEqual({ key: ref.key, ref });
      expect(await placeSessionUpload(refs, "w1", sha(21), "assets/s/f", session("s1"), NOW)).toEqual({ key: "assets/s/f" });
      expect(await findReusableBlob(refs, "w1", sha(21))).toBeNull();
    });

    test("a verifying blob is not reused: both kinds fall back to the classic key", async () => {
      const ref = blobRefKey("w1", sha(22));
      await refs.claim(ref, "s0", NOW + 1000, NOW);
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
      expect(await placeDirectUpload(refs, "w1", sha(22), "assets/b/f", NOW)).toEqual({ key: "assets/b/f" });
      expect(await placeSessionUpload(refs, "w1", sha(22), "assets/s/f", session("s1"), NOW)).toEqual({ key: "assets/s/f" });
    });

    test("a blob being deleted is not reused: both kinds fall back to the classic key", async () => {
      const ref = blobRefKey("w1", sha(23));
      await refs.markOrphanDeleting(ref, NOW);
      expect(await placeDirectUpload(refs, "w1", sha(23), "assets/b/f", NOW)).toEqual({ key: "assets/b/f" });
      expect(await placeSessionUpload(refs, "w1", sha(23), "assets/s/f", session("s1"), NOW)).toEqual({ key: "assets/s/f" });
    });

    test("a live claim still answers 409 to a session", async () => {
      await refs.claim(blobRefKey("w1", sha(24)), "s0", NOW + 1000, NOW);
      await expect(placeSessionUpload(refs, "w1", sha(24), "assets/s/f", session("s1"), NOW)).rejects.toBeInstanceOf(BlobClaimedError);
    });

    test("reuseFailure: a blob that stopped qualifying becomes BlobUnavailableError; anything else is passed through", async () => {
      const ref = blobRefKey("w1", sha(25));
      const original = new Error("D1 hiccup");
      expect(await reuseFailure(refs, ref.key, original)).toBeInstanceOf(BlobUnavailableError);
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
      expect(await reuseFailure(refs, ref.key, original)).toBe(original);
      await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });
      expect(await reuseFailure(refs, ref.key, original)).toBeInstanceOf(BlobUnavailableError);
    });
  });
});

describe("discardRejectedBlob", () => {
  test("deletes the bytes when the rejected upload was the only reference", async () => {
    const ref = blobRefKey("w1", sha(4));
    await refs.claim(ref, "s1", NOW + 1000, NOW);
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
    await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });

    expect(await discardRejectedBlob(refs, storage, ref.key, NOW)).toBe(true);
    expect(await exists(ref.key)).toBe(false);
    expect(await refs.find(ref.key)).toBeNull();
  });

  test("a reuse attempt cannot attach to a blob still verifying, so a rejection still deletes it", async () => {
    const ref = blobRefKey("w1", sha(26));
    await refs.claim(ref, "s1", NOW + 1000, NOW);
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
    await expect(writes.createAsset({ asset: assetWith("a2", ref.key), blob: { ref, state: "ready", existing: true } })).rejects.toThrow();
    await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });

    expect(await discardRejectedBlob(refs, storage, ref.key, NOW)).toBe(true);
    expect(await exists(ref.key)).toBe(false);
  });

  test("keeps the bytes while another row still references them", async () => {
    const ref = blobRefKey("w1", sha(5));
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
    await writes.createAsset({ asset: assetWith("a2", ref.key), blob: { ref, state: "ready" } });
    await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });

    expect(await discardRejectedBlob(refs, storage, ref.key, NOW)).toBe(false);
    expect(await exists(ref.key)).toBe(true);
    expect(await refs.find(ref.key)).toMatchObject({ refCount: 1 });
  });
});

describe("sweepBlobs: grace period", () => {
  test("an unreferenced blob survives the grace period and is deleted after it", async () => {
    const ref = blobRefKey("w1", sha(6));
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
    const zeroAt = Date.now();
    await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });

    expect((await sweep(zeroAt + BLOB_GRACE_MS - 1)).swept).toEqual([]);
    expect(await exists(ref.key)).toBe(true);

    const result = await sweep(zeroAt + BLOB_GRACE_MS + 1000);
    expect(result.swept).toEqual([ref.key]);
    expect(await exists(ref.key)).toBe(false);
    expect(await refs.find(ref.key)).toBeNull();
  });

  test("a referenced blob is never swept, however old", async () => {
    const ref = blobRefKey("w1", sha(7));
    await putObject(ref.key, 0);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
    expect((await sweep(Date.now() + 100 * BLOB_GRACE_MS)).swept).toEqual([]);
    expect(await exists(ref.key)).toBe(true);
  });

  test("a lock left by a crashed sweep is finished on the next pass", async () => {
    const ref = blobRefKey("w1", sha(8));
    await putObject(ref.key);
    await refs.markOrphanDeleting(ref, NOW);
    expect((await sweep()).swept).toEqual([ref.key]);
    expect(await exists(ref.key)).toBe(false);
    expect(await refs.find(ref.key)).toBeNull();
  });

  test("expired upload claims are dropped, live ones kept", async () => {
    await refs.claim(blobRefKey("w1", sha(9)), "s1", NOW - 1, 0);
    await refs.claim(blobRefKey("w1", sha(10)), "s2", NOW + 1000, 0);
    expect((await sweep()).droppedClaims).toBe(1);
    expect(await refs.find(blobRefKey("w1", sha(9)).key)).toBeNull();
    expect(await refs.find(blobRefKey("w1", sha(10)).key)).not.toBeNull();
  });
});

describe("sweepBlobs: orphan reconciliation", () => {
  test("deletes an object with no row once it is older than the grace period, and nothing else", async () => {
    const oldOrphan = blobRefKey("w1", sha(11)).key;
    const freshOrphan = blobRefKey("w1", sha(12)).key;
    const tracked = blobRefKey("w1", sha(13));
    await putObject(oldOrphan, NOW - BLOB_GRACE_MS - 1);
    await putObject(freshOrphan, NOW - 1000);
    await putObject(tracked.key, 0);
    await writes.createAsset({ asset: assetWith("a1", tracked.key), blob: { ref: tracked, state: "ready" } });
    await putObject("blobs/w1/not-a-hash", 0);

    const result = await sweep();
    expect(result.orphans).toEqual([oldOrphan]);
    expect(await exists(oldOrphan)).toBe(false);
    expect(await refs.find(oldOrphan)).toBeNull();
    expect(await exists(freshOrphan)).toBe(true);
    expect(await exists(tracked.key)).toBe(true);
    expect(await exists("blobs/w1/not-a-hash")).toBe(true);
  });

  test("lists one bounded page per tick and resumes from the stored cursor", async () => {
    const total = ORPHAN_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) await putObject(blobRefKey("w1", sha(i % 256).slice(0, 60) + i.toString(16).padStart(4, "0")).key, 0);

    const first = await sweep();
    expect(first.orphans).toHaveLength(ORPHAN_PAGE_SIZE);
    expect(await cache.get(ORPHAN_CURSOR_KEY)).not.toBeNull();

    const second = await sweep();
    expect(second.orphans).toHaveLength(5);
    // The listing reached its end: the next tick starts over.
    expect(await cache.get(ORPHAN_CURSOR_KEY)).toBeNull();
    expect((await storage.list("blobs/")).keys).toEqual([]);
  });

  test("stops when the budget runs out and keeps its place", async () => {
    for (let i = 0; i < 10; i++) await putObject(blobRefKey("w1", sha(100 + i)).key, 0);
    const result = await sweep(NOW, new SubrequestBudget(20));
    expect(result.budgetExhausted).toBe(true);
    expect(result.orphans.length).toBeLessThan(10);
    expect(await cache.get(ORPHAN_CURSOR_KEY)).toBeNull();

    const rest = await sweep();
    expect(result.orphans.length + rest.orphans.length).toBe(10);
  });
});
