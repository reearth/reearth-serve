// Placement and sweeps of the blob layer (ADR-017 §3, §5), against the real
// SQL ledger and the in-memory object store.
import { beforeEach, describe, expect, test } from "vitest";
import { createSqliteClient } from "../../adapters/memory/sqlite-node";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { SqlBlobRefStore } from "../../adapters/sql/blob-refs";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import { SqlProjectStore } from "../../adapters/sql/stores";
import type { SqlClient } from "../sql/port";
import { SubrequestBudget } from "../cleanup/usecase";
import type { AssetMetadata } from "../asset/model";
import { ATTACH_CLOCK_SKEW_MS, BLOB_GRACE_MS, blobRefKey, type BlobRefKey } from "./model";
import {
  blobScopeFor, BlobUnavailableError, discardRejectedBlob, findReusableBlob, ORPHAN_CURSOR_KEY, ORPHAN_PAGE_SIZE,
  placeDirectUpload, reuseFailure, stillAttachable, sweepBlobs,
} from "./usecase";

const sha = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const NOW = 10 * BLOB_GRACE_MS;

let refs: SqlBlobRefStore;
let writes: SqlAtomicWrites;
let storage: MemoryFileStorage;
let cache: MemoryKeyValue;
let projects: SqlProjectStore;
let sql: SqlClient;

beforeEach(() => {
  sql = createSqliteClient();
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

/**
 * An `uploading` claim as a presigned session wrote it before the post-review
 * change. Nothing writes one any more; the sweeps and `reserve` still handle
 * the rows that exist.
 */
async function legacyClaim(ref: BlobRefKey, claimId: string, expiresAt: number, now: number): Promise<void> {
  await sql.execute(
    `INSERT INTO blob_refs (key, scope, sha256, ref_count, state, claim_id, claim_expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 0, 'uploading', ?4, ?5, ?6, ?6)`,
    [ref.key, ref.scope, ref.sha256, claimId, expiresAt, now],
  );
}

const sweep = (now = NOW, budget = new SubrequestBudget(1000)) => sweepBlobs({ blobRefs: refs, storage, cache }, budget, now);

describe("blobScopeFor", () => {
  test("follows the project's workspace, falls back to p_{id}, and is the session's own demo scope without a project", async () => {
    await projects.save({ id: "p1", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u", workspaceId: "w1" });
    await projects.save({ id: "p2", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u" });
    expect(await blobScopeFor(projects, "p1", "0123456789abcdef")).toBe("w1");
    expect(await blobScopeFor(projects, "p2")).toBe("p_p2");
    expect(await blobScopeFor(projects, null, "0123456789abcdef")).toBe("_demo_0123456789abcdef");
    expect(await blobScopeFor(projects, undefined, "fedcba9876543210")).toBe("_demo_fedcba9876543210");
    expect(await blobScopeFor(projects, null)).toBeNull();
  });
});

describe("placement", () => {
  test("a direct upload: undeclared stays classic; declared takes the blob key unless the ledger holds it", async () => {
    expect(await placeDirectUpload(refs, "w1", undefined, "assets/a/f", NOW)).toEqual({ key: "assets/a/f" });
    const ref = blobRefKey("w1", sha(1));
    expect(await placeDirectUpload(refs, "w1", sha(1), "assets/a/f", NOW)).toEqual({ key: ref.key, ref });
    // Reserved but not yet referenced: a second direct upload writes it too.
    expect(await placeDirectUpload(refs, "w1", sha(1), "assets/b/f", NOW)).toEqual({ key: ref.key, ref });

    await legacyClaim(blobRefKey("w1", sha(2)), "s1", NOW + 1000, NOW);
    expect(await placeDirectUpload(refs, "w1", sha(2), "assets/c/f", NOW)).toEqual({ key: "assets/c/f" });
  });

  test("the scope keeps workspaces and demo sessions apart", async () => {
    const a = await placeDirectUpload(refs, "w1", sha(1), "assets/a/f", NOW);
    const b = await placeDirectUpload(refs, "w2", sha(1), "assets/b/f", NOW);
    expect(a.key).toBe(`blobs/w1/${sha(1)}`);
    expect(b.key).toBe(`blobs/w2/${sha(1)}`);
    const demoA = await placeDirectUpload(refs, "_demo_aaaaaaaaaaaaaaaa", sha(1), "assets/c/f", NOW);
    const demoB = await placeDirectUpload(refs, "_demo_bbbbbbbbbbbbbbbb", sha(1), "assets/d/f", NOW);
    expect(demoA.key).not.toBe(demoB.key);
  });

  describe("reuse (ADR-017 §4)", () => {
    test("a ready, referenced blob is reused by direct uploads, in its own scope only", async () => {
      const ref = blobRefKey("w1", sha(20));
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });

      expect(await placeDirectUpload(refs, "w1", sha(20), "assets/b/f", NOW)).toEqual({ key: ref.key, ref, reuse: { since: NOW } });
      expect(await findReusableBlob(refs, "w1", sha(20), NOW)).toEqual({ key: ref.key, ref, reuse: { since: NOW } });

      // Another workspace with the same bytes writes its own blob.
      const other = blobRefKey("w2", sha(20));
      expect(await findReusableBlob(refs, "w2", sha(20))).toBeNull();
      expect(await placeDirectUpload(refs, "w2", sha(20), "assets/c/f", NOW)).toEqual({ key: other.key, ref: other });
    });

    test("a ready blob with no reference is not reused: a direct upload reserves and writes", async () => {
      const ref = blobRefKey("w1", sha(21));
      expect(await refs.reserve(ref, NOW)).toBe(true); // a reservation whose upload may have failed
      expect(await placeDirectUpload(refs, "w1", sha(21), "assets/b/f", NOW)).toEqual({ key: ref.key, ref });
      expect(await findReusableBlob(refs, "w1", sha(21))).toBeNull();
    });

    test("a verifying blob is not reused: a direct upload falls back to the classic key", async () => {
      const ref = blobRefKey("w1", sha(22));
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
      expect(await placeDirectUpload(refs, "w1", sha(22), "assets/b/f", NOW)).toEqual({ key: "assets/b/f" });
    });

    test("a blob being deleted is not reused: a direct upload falls back to the classic key", async () => {
      const ref = blobRefKey("w1", sha(23));
      await refs.markOrphanDeleting(ref, NOW);
      expect(await placeDirectUpload(refs, "w1", sha(23), "assets/b/f", NOW)).toEqual({ key: "assets/b/f" });
    });

    test("stillAttachable: referenced, or unreferenced only since the lookup; never another state", () => {
      const row = { key: "k", scope: "w1", sha256: sha(1), createdAt: 0, updatedAt: 0 };
      expect(stillAttachable({ ...row, state: "ready", refCount: 1 }, NOW)).toBe(true);
      expect(stillAttachable({ ...row, state: "ready", refCount: 0, zeroSince: NOW + 10 }, NOW)).toBe(true);
      expect(stillAttachable({ ...row, state: "ready", refCount: 0, zeroSince: NOW - ATTACH_CLOCK_SKEW_MS }, NOW)).toBe(true);
      expect(stillAttachable({ ...row, state: "ready", refCount: 0, zeroSince: NOW - ATTACH_CLOCK_SKEW_MS - 1 }, NOW)).toBe(false);
      expect(stillAttachable({ ...row, state: "ready", refCount: 0 }, NOW)).toBe(false);
      expect(stillAttachable({ ...row, state: "verifying", refCount: 1 }, NOW)).toBe(false);
      expect(stillAttachable({ ...row, state: "deleting", refCount: 0, zeroSince: NOW }, NOW)).toBe(false);
      expect(stillAttachable(null, NOW)).toBe(false);
    });

    test("a blob whose last row goes away during the upload can still be attached to: its object is in its grace period", async () => {
      const ref = blobRefKey("w1", sha(27));
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
      const found = await findReusableBlob(refs, "w1", sha(27));
      await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });
      expect(await refs.find(ref.key)).toMatchObject({ refCount: 0 });

      await writes.createAsset({ asset: assetWith("a2", ref.key), blob: { ref, state: "ready", existing: found!.reuse } });
      expect(await refs.find(ref.key)).toMatchObject({ refCount: 1, state: "ready" });
      expect((await refs.find(ref.key))?.zeroSince).toBeUndefined();
    });

    test("reuseFailure: a blob that stopped qualifying becomes BlobUnavailableError; anything else is passed through", async () => {
      const ref = blobRefKey("w1", sha(25));
      const original = new Error("D1 hiccup");
      expect(await reuseFailure(refs, ref.key, NOW, original)).toBeInstanceOf(BlobUnavailableError);
      await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "ready" } });
      expect(await reuseFailure(refs, ref.key, NOW, original)).toBe(original);
      // Unreferenced since long before the lookup: not attachable.
      await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });
      expect(await reuseFailure(refs, ref.key, Date.now() + BLOB_GRACE_MS, original)).toBeInstanceOf(BlobUnavailableError);
      // Unreferenced only since after the lookup: still attachable, so not the blob's fault.
      expect(await reuseFailure(refs, ref.key, Date.now() - 1000, original)).toBe(original);
    });
  });
});

describe("discardRejectedBlob", () => {
  test("deletes the bytes when the rejected upload was the only reference", async () => {
    const ref = blobRefKey("w1", sha(4));
    await legacyClaim(ref, "s1", NOW + 1000, NOW);
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
    await writes.deleteAsset({ asset: assetWith("a1", ref.key), cleanupPrefix: "assets/a1/" });

    expect(await discardRejectedBlob(refs, storage, ref.key, NOW)).toBe(true);
    expect(await exists(ref.key)).toBe(false);
    expect(await refs.find(ref.key)).toBeNull();
  });

  test("a reuse attempt cannot attach to a blob still verifying, so a rejection still deletes it", async () => {
    const ref = blobRefKey("w1", sha(26));
    await legacyClaim(ref, "s1", NOW + 1000, NOW);
    await putObject(ref.key);
    await writes.createAsset({ asset: assetWith("a1", ref.key), blob: { ref, state: "verifying" } });
    await expect(writes.createAsset({ asset: assetWith("a2", ref.key), blob: { ref, state: "ready", existing: { since: NOW } } })).rejects.toThrow();
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

  test("a classic object retired by adoption is deleted after the grace period, like an unreferenced blob", async () => {
    const blob = blobRefKey("w1", sha(14));
    await putObject(blob.key);
    await putObject("assets/a2/f");
    await writes.createAsset({ asset: assetWith("a1", blob.key), blob: { ref: blob, state: "ready" } });
    const retiredAt = Date.now();
    const retire = { key: "assets/a2/f", scope: "w1", sha256: sha(14) };
    await writes.createAsset({ asset: assetWith("a2", blob.key), blob: { ref: blob, state: "ready", existing: { since: retiredAt }, retire } });
    expect(await refs.find("assets/a2/f")).toMatchObject({ state: "retired", refCount: 0 });

    expect((await sweep(retiredAt + BLOB_GRACE_MS - 1000)).swept).toEqual([]);
    expect(await exists("assets/a2/f")).toBe(true);
    expect((await sweep(retiredAt + BLOB_GRACE_MS + 1000)).swept).toEqual(["assets/a2/f"]);
    expect(await exists("assets/a2/f")).toBe(false);
    expect(await refs.find("assets/a2/f")).toBeNull();
    // The blob both rows share is untouched.
    expect(await exists(blob.key)).toBe(true);
    expect(await refs.find(blob.key)).toMatchObject({ refCount: 2 });
  });

  test("a lock left by a crashed sweep is finished on the next pass", async () => {
    const ref = blobRefKey("w1", sha(8));
    await putObject(ref.key);
    await refs.markOrphanDeleting(ref, NOW);
    expect((await sweep()).swept).toEqual([ref.key]);
    expect(await exists(ref.key)).toBe(false);
    expect(await refs.find(ref.key)).toBeNull();
  });

  test("expired upload claims (from before the post-review change) are dropped, live ones kept", async () => {
    await legacyClaim(blobRefKey("w1", sha(9)), "s1", NOW - 1, 0);
    await legacyClaim(blobRefKey("w1", sha(10)), "s2", NOW + 1000, 0);
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
