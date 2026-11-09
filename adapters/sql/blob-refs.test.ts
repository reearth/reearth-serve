// The blob ledger (ADR-017 §3, §5; migration 0009) against a real SQLite
// engine: the store's transitions, and the reference counts that ride inside
// the asset and version writes.
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { SqlBlobRefStore } from "./blob-refs";
import { SqlAtomicWrites } from "./writes";
import { SqlMetadataStore, SqlStorageUsageStore, SqlVersionStore } from "./stores";
import { blobRefKey } from "../../core/blob/model";
import type { AssetMetadata, AssetVersion } from "../../core/asset/model";

const SHA = "ab".repeat(32);
const REF = blobRefKey("w1", SHA);

function fixture() {
  const sql = createSqliteClient();
  return {
    sql,
    refs: new SqlBlobRefStore(sql),
    writes: new SqlAtomicWrites(sql),
    assets: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    usage: new SqlStorageUsageStore(sql),
  };
}

function asset(id: string, blobKey?: string): AssetMetadata {
  return {
    id, filename: "data.bin", contentType: "application/octet-stream", size: 100, createdAt: 1, expiresAt: 0,
    projectId: "p1", sha256: SHA, integrity: "verified", ...(blobKey && { blobKey }),
  };
}

function version(id: string, assetId: string, blobKey?: string): AssetVersion {
  return {
    id, assetId, version: 0, filename: "data.bin", contentType: "application/octet-stream", size: 40, createdAt: 2,
    sha256: SHA, integrity: "verified", ...(blobKey && { blobKey }),
  };
}

const READY = { ref: REF, state: "ready" as const };

describe("blob_key on rows", () => {
  test("is read back on assets and versions, and absent for the classic layout", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: asset("a1", REF.key), blob: READY });
    await f.writes.createAsset({ asset: asset("a2") });
    await f.writes.createVersion({ version: version("v1", "a1", REF.key), blob: READY });
    await f.writes.createVersion({ version: version("v2", "a1") });

    expect((await f.assets.find("a1"))?.blobKey).toBe(REF.key);
    expect(await f.assets.find("a2")).not.toHaveProperty("blobKey");
    expect((await f.versions.find("v1"))?.blobKey).toBe(REF.key);
    expect(await f.versions.find("v2")).not.toHaveProperty("blobKey");
  });

  test("never moves once written, whatever a later upsert carries", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: asset("a1", REF.key), blob: READY });
    const { blobKey: _drop, ...copy } = (await f.assets.find("a1"))!;
    await f.writes.saveJob({
      job: { id: "j", assetId: "a1", type: "archive-extraction", status: "completed", createdAt: 1, updatedAt: 2 },
      asset: { ...copy, status: "ready" },
    });
    await f.assets.save({ ...copy, blobKey: "blobs/w1/elsewhere" }, 0);
    expect((await f.assets.find("a1"))?.blobKey).toBe(REF.key);
  });
});

describe("reference counts in the row writes", () => {
  test("each row holding the key is one reference; usage stays per row", async () => {
    const f = fixture();
    const scopes = ["project:p1", "workspace:w1"];
    await f.writes.createAsset({ asset: asset("a1", REF.key), usageScopes: scopes, blob: READY });
    await f.writes.createVersion({ version: version("v1", "a1", REF.key), usageScopes: scopes, blob: READY });
    await f.writes.createVersion({ version: version("v2", "a1", REF.key), usageScopes: scopes, blob: READY });

    expect((await f.refs.find(REF.key))?.refCount).toBe(3);
    // Charged as three copies (ADR-017 §4), not one blob.
    expect((await f.usage.get("workspace:w1"))?.totalSize).toBe(100 + 40 + 40);
  });

  test("deleting one of two versions sharing a blob keeps the blob referenced", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: asset("a1") });
    await f.writes.createVersion({ version: version("v1", "a1", REF.key), usageScopes: ["project:p1"], blob: READY });
    await f.writes.createVersion({ version: version("v2", "a1", REF.key), usageScopes: ["project:p1"], blob: READY });

    expect(await f.writes.deleteVersion({ version: (await f.versions.find("v1"))!, usageScopes: ["project:p1"] })).toBe(true);
    const after = await f.refs.find(REF.key);
    expect(after).toMatchObject({ refCount: 1, state: "ready" });
    expect(after?.zeroSince).toBeUndefined();
    expect((await f.usage.get("project:p1"))?.totalSize).toBe(40);

    // A repeated delete is a no-op: no double decrement of either counter.
    expect(await f.writes.deleteVersion({ version: version("v1", "a1", REF.key), usageScopes: ["project:p1"] })).toBe(false);
    expect((await f.refs.find(REF.key))?.refCount).toBe(1);
    expect((await f.usage.get("project:p1"))?.totalSize).toBe(40);

    await f.writes.deleteVersion({ version: (await f.versions.find("v2"))!, usageScopes: ["project:p1"] });
    const zero = await f.refs.find(REF.key);
    expect(zero?.refCount).toBe(0);
    expect(zero?.zeroSince).toBeGreaterThan(0);
  });

  test("deleting an asset releases its own reference and every version's, counted from the rows", async () => {
    const f = fixture();
    const other = blobRefKey("w1", "cd".repeat(32));
    await f.writes.createAsset({ asset: asset("a1", REF.key), blob: READY });
    await f.writes.createVersion({ version: version("v1", "a1", REF.key), blob: READY });
    await f.writes.createVersion({ version: version("v2", "a1", other.key), blob: { ref: other, state: "ready" } });
    // Another asset in the scope holds the same bytes.
    await f.writes.createAsset({ asset: asset("b1", REF.key), blob: READY });

    await f.writes.deleteAsset({ asset: (await f.assets.find("a1"))!, cleanupPrefix: "assets/a1/" });

    expect(await f.refs.find(REF.key)).toMatchObject({ refCount: 1 });
    expect((await f.refs.find(REF.key))?.zeroSince).toBeUndefined();
    expect(await f.refs.find(other.key)).toMatchObject({ refCount: 0 });
    expect((await f.refs.find(other.key))?.zeroSince).toBeGreaterThan(0);

    // Repeating the delete changes nothing.
    await f.writes.deleteAsset({ asset: asset("a1", REF.key), cleanupPrefix: "assets/a1/" });
    expect(await f.refs.find(REF.key)).toMatchObject({ refCount: 1 });
  });

  test("completing a claim turns it into the first reference", async () => {
    const f = fixture();
    expect(await f.refs.claim(REF, "s1", 5000, 1000)).toBe("claimed");
    await f.writes.createAsset({ asset: asset("a1", REF.key), blob: { ref: REF, state: "verifying" } });
    const row = await f.refs.find(REF.key);
    expect(row).toMatchObject({ refCount: 1, state: "verifying" });
    expect(row?.claimId).toBeUndefined();
    await f.refs.markVerified(REF.key, 2000);
    expect((await f.refs.find(REF.key))?.state).toBe("ready");
  });
});

describe("SqlBlobRefStore", () => {
  test("reserve: a free key becomes ready with its grace clock started; a ready one is reserved again", async () => {
    const { refs } = fixture();
    expect(await refs.reserve(REF, 1000)).toBe(true);
    expect(await refs.find(REF.key)).toMatchObject({ refCount: 0, state: "ready", zeroSince: 1000 });
    expect(await refs.reserve(REF, 2000)).toBe(true);
    expect((await refs.find(REF.key))?.zeroSince).toBe(2000);
  });

  test("reserve does not restart the clock of a referenced blob", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: asset("a1", REF.key), blob: READY });
    expect(await f.refs.reserve(REF, 2000)).toBe(true);
    expect((await f.refs.find(REF.key))?.zeroSince).toBeUndefined();
  });

  test("reserve refuses a live claim, an unverified blob and a sweep's lock, and takes over an expired claim", async () => {
    const { refs, writes } = fixture();
    await refs.claim(REF, "s1", 5000, 1000);
    expect(await refs.reserve(REF, 4000)).toBe(false);
    expect(await refs.reserve(REF, 6000)).toBe(true);
    expect(await refs.find(REF.key)).toMatchObject({ state: "ready", zeroSince: 6000 });

    const verifying = blobRefKey("w1", "01".repeat(32));
    await refs.claim(verifying, "s2", 5000, 1000);
    await writes.createAsset({ asset: asset("a9", verifying.key), blob: { ref: verifying, state: "verifying" } });
    expect(await refs.reserve(verifying, 2000)).toBe(false);

    const orphan = blobRefKey("w1", "02".repeat(32));
    await refs.markOrphanDeleting(orphan, 1000);
    expect(await refs.reserve(orphan, 2000)).toBe(false);
  });

  test("claim: one session at a time, 409-busy until it expires, and never over existing bytes", async () => {
    const { refs } = fixture();
    expect(await refs.claim(REF, "s1", 5000, 1000)).toBe("claimed");
    expect(await refs.claim(REF, "s2", 9000, 2000)).toBe("busy");
    // The first claim lapses; the second session can take the key.
    expect(await refs.claim(REF, "s2", 9000, 6000)).toBe("claimed");
    expect((await refs.find(REF.key))?.claimId).toBe("s2");

    const ready = blobRefKey("w1", "03".repeat(32));
    await refs.reserve(ready, 1000);
    expect(await refs.claim(ready, "s3", 9000, 2000)).toBe("exists");
  });

  test("releaseClaim drops only the named session's claim", async () => {
    const { refs } = fixture();
    await refs.claim(REF, "s1", 5000, 1000);
    await refs.releaseClaim(REF.key, "other");
    expect(await refs.find(REF.key)).not.toBeNull();
    await refs.releaseClaim(REF.key, "s1");
    expect(await refs.find(REF.key)).toBeNull();
  });

  test("markDeleting locks only unreferenced blobs old enough, and the lock blocks new writers", async () => {
    const f = fixture();
    await f.refs.reserve(REF, 1000);
    expect(await f.refs.markDeleting(REF.key, 500, 3000)).toBe(false); // too young
    expect(await f.refs.markDeleting(REF.key, 1000, 3000)).toBe(true);
    expect(await f.refs.claim(REF, "s1", 9000, 3000)).toBe("exists");
    await f.refs.removeDeleted(REF.key);
    expect(await f.refs.find(REF.key)).toBeNull();

    const held = blobRefKey("w1", "04".repeat(32));
    await f.writes.createAsset({ asset: asset("a1", held.key), blob: { ref: held, state: "ready" } });
    expect(await f.refs.markDeleting(held.key, Number.MAX_SAFE_INTEGER, 3000)).toBe(false);
  });

  test("markOrphanDeleting only inserts where no row exists", async () => {
    const { refs } = fixture();
    expect(await refs.markOrphanDeleting(REF, 1000)).toBe(true);
    expect((await refs.find(REF.key))?.state).toBe("deleting");
    const other = blobRefKey("w1", "05".repeat(32));
    await refs.reserve(other, 1000);
    expect(await refs.markOrphanDeleting(other, 1000)).toBe(false);
    expect((await refs.find(other.key))?.state).toBe("ready");
  });

  test("listSweepable: unreferenced past the cutoff, plus abandoned locks; dropExpiredClaims: lapsed claims", async () => {
    const f = fixture();
    const old = blobRefKey("w1", "06".repeat(32));
    const young = blobRefKey("w1", "07".repeat(32));
    const locked = blobRefKey("w1", "08".repeat(32));
    const held = blobRefKey("w1", "09".repeat(32));
    await f.refs.reserve(old, 1000);
    await f.refs.reserve(young, 9000);
    await f.refs.markOrphanDeleting(locked, 9000);
    await f.writes.createAsset({ asset: asset("a1", held.key), blob: { ref: held, state: "ready" } });
    await f.refs.claim(REF, "s1", 4000, 1000);

    expect((await f.refs.listSweepable(5000, 10)).sort()).toEqual([locked.key, old.key].sort());

    expect(await f.refs.dropExpiredClaims(3000, 10)).toBe(0);
    expect(await f.refs.dropExpiredClaims(5000, 10)).toBe(1);
    expect(await f.refs.find(REF.key)).toBeNull();
  });

  test("existing reports which keys have a row", async () => {
    const { refs } = fixture();
    await refs.reserve(REF, 1000);
    expect(await refs.existing([REF.key, "blobs/w1/none"])).toEqual(new Set([REF.key]));
    expect(await refs.existing([])).toEqual(new Set());
  });
});
