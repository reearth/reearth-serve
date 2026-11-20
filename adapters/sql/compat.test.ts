import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { MemoryCompatStore } from "../memory/compat";
import { SqlCompatStore } from "./compat";
import { SqlAtomicWrites } from "./writes";
import { SqlMetadataStore } from "./stores";
import type { BindingKey, ClaimToken, CompatStore, LeaseToken } from "../../core/compat/repository";
import type {
  BucketName, CompatBucket, CompatCredential, CredentialId, FolderKey, ObjectKey, UploadId, UploadSession,
} from "../../core/compat/model";
import type { AssetMetadata } from "../../core/asset/model";

const media = "media" as BucketName;
const key = "assets/aa/bb/photo.jpg" as ObjectKey;
const folder = "assets/aa/bb/" as FolderKey;

function bucket(over: Partial<CompatBucket> = {}): CompatBucket {
  return { name: media, projectId: "p1", mount: { prefix: "assets/", depth: 2, strip: "skip-top" }, createdAt: 1000, ...over };
}

function credential(over: Partial<CompatCredential> = {}): CompatCredential {
  return {
    id: "c1" as CredentialId,
    projectId: "p1",
    bucket: media,
    role: "editor",
    clientEmail: "c1@storage.example.test",
    publicJwk: { kty: "RSA", n: "abc", e: "AQAB", alg: "RS256" },
    label: "cms",
    createdBy: "u1",
    createdAt: 1000,
    revokedAt: null,
    ...over,
  };
}

async function claimed(s: CompatStore, k: BindingKey, now: number, staleBefore = 0): Promise<ClaimToken> {
  const result = await s.claim(media, k, k.endsWith("/") ? "folder" : "object", now, staleBefore);
  if (result.kind !== "claimed") throw new Error(`expected a claim, got ${result.kind}`);
  return result.token;
}

function upload(over: Partial<UploadSession> = {}): UploadSession {
  return {
    id: "up1" as UploadId,
    bucket: media,
    key,
    credentialId: "c1" as CredentialId,
    meta: { contentType: "image/jpeg", contentEncoding: null, userMeta: { a: "b" }, ifGenerationMatch: 0 },
    received: 0,
    hashState: "{}",
    state: "open",
    result: null,
    expiresAt: 5000,
    ...over,
  };
}

describe.each([
  ["SqlCompatStore", (): CompatStore => new SqlCompatStore(createSqliteClient())],
  ["MemoryCompatStore", (): CompatStore => new MemoryCompatStore()],
])("%s", (_, make) => {
  describe("buckets", () => {
    test("insert and find round-trip, and a taken name is refused in any project", async () => {
      const s = make();
      expect(await s.insertBucket(bucket())).toBe(true);
      expect(await s.insertBucket(bucket({ projectId: "p2", mount: null }))).toBe(false);
      expect(await s.findBucket(media)).toEqual(bucket());
      expect(await s.listBuckets("p1")).toEqual([bucket()]);
      expect(await s.listBuckets("p2")).toEqual([]);
    });

    test("deleting an empty bucket revokes its credentials and drops its uploads", async () => {
      const s = make();
      await s.insertBucket(bucket());
      await s.insertCredential(credential());
      await s.insertCredential(credential({ id: "c2" as CredentialId, clientEmail: "c2@x", revokedAt: 10 }));
      await s.createUpload(upload());
      expect(await s.deleteBucket("p1", media, 2000)).toBe("deleted");
      expect(await s.findBucket(media)).toBeNull();
      expect((await s.findCredential("c1" as CredentialId))?.revokedAt).toBe(2000);
      expect((await s.findCredential("c2" as CredentialId))?.revokedAt).toBe(10);
      expect(await s.findUpload("up1" as UploadId)).toBeNull();
    });

    test("a bucket that binds a key, or is claimed, is not deleted and nothing is revoked", async () => {
      const s = make();
      await s.insertBucket(bucket());
      await s.insertCredential(credential());
      await s.claim(media, key, "object", 1000, 0);
      expect(await s.deleteBucket("p1", media, 2000)).toBe("not_empty");
      expect(await s.findBucket(media)).not.toBeNull();
      expect((await s.findCredential("c1" as CredentialId))?.revokedAt).toBeNull();
    });

    test("deleting a project removes its buckets, bindings, uploads and credentials, and frees the names", async () => {
      const s = make();
      const other = "other" as BucketName;
      await s.insertBucket(bucket());
      await s.insertBucket(bucket({ name: other, projectId: "p2" }));
      await s.insertCredential(credential());
      await s.insertCredential(credential({ id: "c2" as CredentialId, clientEmail: "c2@x", projectId: "p2", bucket: other }));
      await s.bind(media, key, await claimed(s, key, 1000), "a1");
      await s.claim(other, key, "object", 1000, 0);
      await s.createUpload(upload());
      await s.createUpload(upload({ id: "up2" as UploadId, bucket: other }));

      await s.deleteProject("p1");

      expect(await s.listBuckets("p1")).toEqual([]);
      expect(await s.listCredentials("p1")).toEqual([]);
      expect(await s.findBinding(media, key)).toBeNull();
      expect(await s.findUpload("up1" as UploadId)).toBeNull();
      expect(await s.insertBucket(bucket())).toBe(true);
      expect(await s.findBinding(media, key)).toBeNull();
      expect(await s.listBuckets("p2")).toHaveLength(1);
      expect(await s.listCredentials("p2")).toHaveLength(1);
      expect(await s.claim(other, key, "object", 1000, 0)).toEqual({ kind: "busy" });
      expect(await s.findUpload("up2" as UploadId)).not.toBeNull();
    });

    test("another project's bucket, or a missing one, is absent", async () => {
      const s = make();
      await s.insertBucket(bucket());
      expect(await s.deleteBucket("p2", media, 2000)).toBe("absent");
      expect(await s.deleteBucket("p1", "nope" as BucketName, 2000)).toBe("absent");
      expect(await s.findBucket(media)).not.toBeNull();
    });
  });

  describe("claims and bindings", () => {
    test("a fresh claim wins, and a second writer is busy while it is fresh", async () => {
      const s = make();
      expect(await s.claim(media, key, "object", 1000, 500)).toEqual({ kind: "claimed", token: expect.any(String) });
      expect(await s.claim(media, key, "object", 1100, 600)).toEqual({ kind: "busy" });
      expect(await s.findBinding(media, key)).toBeNull();
    });

    test("a stale claim is taken over, and the old holder can no longer bind or release it", async () => {
      const s = make();
      const old = await claimed(s, key, 1000);
      const fresh = await claimed(s, key, 9000, 2000);
      expect(await s.bind(media, key, old, "old-asset")).toBe(false);
      await s.releaseClaim(media, key, old);
      expect(await s.bind(media, key, fresh, "new-asset")).toBe(true);
      expect(await s.findBinding(media, key)).toEqual({ kind: "object", bucket: media, key, assetId: "new-asset" });
    });

    test("claims in the same millisecond get distinct tokens, so a late release cannot free a newer claim", async () => {
      const s = make();
      const first = await claimed(s, key, 1000);
      await s.releaseClaim(media, key, first);
      const second = await claimed(s, key, 1000);
      expect(second).not.toBe(first);
      await s.releaseClaim(media, key, first);
      expect(await s.claim(media, key, "object", 1000, 0)).toEqual({ kind: "busy" });
      expect(await s.bind(media, key, first, "stale-writer")).toBe(false);
      expect(await s.bind(media, key, second, "a1")).toBe(true);
    });

    test("bind is idempotent for the same asset and refuses another", async () => {
      const s = make();
      const token = await claimed(s, folder, 1000);
      expect(await s.bind(media, folder, token, "a1")).toBe(true);
      expect(await s.bind(media, folder, token, "a1")).toBe(true);
      expect(await s.bind(media, folder, token, "a2")).toBe(false);
      expect(await s.findBinding(media, folder)).toEqual({ kind: "folder", bucket: media, key: folder, assetId: "a1" });
    });

    test("a bound key is reported as bound, never taken over however old", async () => {
      const s = make();
      await s.bind(media, key, await claimed(s, key, 1000), "a1");
      expect(await s.claim(media, key, "object", 99_000, 98_000)).toEqual({
        kind: "bound", binding: { kind: "object", bucket: media, key, assetId: "a1" },
      });
    });

    test("releasing a claim frees the key; releasing a bound key does nothing", async () => {
      const s = make();
      await s.releaseClaim(media, key, await claimed(s, key, 1000));
      const token = await claimed(s, key, 1100);
      await s.bind(media, key, token, "a1");
      await s.releaseClaim(media, key, token);
      expect(await s.findBinding(media, key)).not.toBeNull();
      await s.deleteBinding(media, key);
      expect(await s.findBinding(media, key)).toBeNull();
    });

    test("scan returns bound rows in byte order within the range, skipping claims", async () => {
      const s = make();
      for (const [i, k] of ["b/2", "b/1", "a/1", "b/é", "c/1", "b/3"].entries()) {
        const token = await claimed(s, k as ObjectKey, 1000 + i);
        if (k !== "b/3") await s.bind(media, k as ObjectKey, token, `asset-${k}`);
      }
      const keys = (await s.scanBindings(media, "b/", "b0", 10)).map((b) => b.key);
      expect(keys).toEqual(["b/1", "b/2", "b/é"]);
      expect((await s.scanBindings(media, "", null, 2)).map((b) => b.key)).toEqual(["a/1", "b/1"]);
    });
  });

  test("records store the exact hash bytes, and a record stored first keeps its generation", async () => {
    const s = make();
    await s.insertBucket(bucket());
    const md5 = new Uint8Array([0, 1, 2, 250, 255, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
    const observed = await s.records(media, [{ objectRef: "v1", assetId: "a1" }]);
    expect(observed.get("v1")).toEqual({ generation: 1, hashes: null });
    const filled = await s.records(media, [{ objectRef: "v1", assetId: "a1", hashes: { md5, crc32c: 0xffffffff } }]);
    expect(filled.get("v1")).toEqual({ generation: 1, hashes: { md5, crc32c: 0xffffffff } });
    const other = await s.records(media, [{ objectRef: "v1", assetId: "a1", hashes: { md5: new Uint8Array(16), crc32c: 1 } }]);
    expect(other.get("v1")).toEqual({ generation: 1, hashes: { md5, crc32c: 0xffffffff } });
  });

  test("a bucket issues each missing record the next generation above its high mark, and none for a bucket that is gone", async () => {
    const s = make();
    await s.insertBucket(bucket());
    const page = await s.records(media, ["v1", "v2", "v1", "v3"].map((objectRef) => ({ objectRef, assetId: "a1" })));
    expect([...page.entries()].sort()).toEqual([["v1", { generation: 1, hashes: null }], ["v2", { generation: 2, hashes: null }], ["v3", { generation: 3, hashes: null }]]);
    expect((await s.records(media, [{ objectRef: "v2", assetId: "a1" }, { objectRef: "v4", assetId: "a1" }])).get("v4")?.generation).toBe(4);
    expect((await s.records("absent" as BucketName, [{ objectRef: "v9", assetId: "a9" }])).size).toBe(0);
  });

  test("concurrent first observers of one record agree on its generation", async () => {
    const s = make();
    await s.insertBucket(bucket());
    const seen = await Promise.all([1, 2, 3, 4].map(() => s.records(media, [{ objectRef: "v1", assetId: "a1" }])));
    expect(new Set(seen.map((m) => m.get("v1")?.generation))).toEqual(new Set([1]));
    expect((await s.records(media, [{ objectRef: "v2", assetId: "a1" }])).get("v2")?.generation).toBe(2);
  });

  describe("leases", () => {
    test("one holder at a time, taken over only once stale, and only on a bound key", async () => {
      const s = make();
      const k = "k" as ObjectKey;
      const [a, b] = ["lease-a", "lease-b"] as LeaseToken[];
      expect(await s.lease(media, k, a, 1000, 0)).toBe(false);
      const token = await claimed(s, k, 1000);
      expect(await s.lease(media, k, a, 1000, 0)).toBe(false);
      await s.bind(media, k, token, "asset-1");
      expect(await s.lease(media, k, a, 1000, 0)).toBe(true);
      expect(await s.lease(media, k, b, 2000, 1000)).toBe(false);
      expect(await s.lease(media, k, b, 2000, 1001)).toBe(true);
      await s.releaseLease(media, k, a);
      expect(await s.lease(media, k, a, 2000, 0)).toBe(false);
      await s.releaseLease(media, k, b);
      expect(await s.lease(media, k, a, 2000, 0)).toBe(true);
    });
  });

  describe("credentials", () => {
    test("insert, find by id and email, and list by project", async () => {
      const s = make();
      await s.insertBucket(bucket());
      expect(await s.insertCredential(credential())).toBe(true);
      expect(await s.findCredential("c1" as CredentialId)).toEqual(credential());
      expect(await s.findCredentialByEmail("c1@storage.example.test")).toEqual(credential());
      expect(await s.listCredentials("p1")).toEqual([credential()]);
      expect(await s.listCredentials("p2")).toEqual([]);
    });

    test("a credential is not inserted for a missing bucket or another project's bucket", async () => {
      const s = make();
      expect(await s.insertCredential(credential())).toBe(false);
      await s.insertBucket(bucket({ projectId: "p2" }));
      expect(await s.insertCredential(credential())).toBe(false);
      expect(await s.findCredential("c1" as CredentialId)).toBeNull();
    });

    test("a credential issued against a bucket deleted before the insert never exists, so a recreated bucket inherits nothing", async () => {
      const s = make();
      await s.insertBucket(bucket());
      expect(await s.deleteBucket("p1", media, 2000)).toBe("deleted");
      expect(await s.insertCredential(credential())).toBe(false);
      await s.insertBucket(bucket());
      expect(await s.listCredentials("p1")).toEqual([]);
    });

    test("a role above editor is refused like the SQL CHECK", async () => {
      const s = make();
      await s.insertBucket(bucket());
      for (const role of ["admin", "owner"]) {
        await expect(s.insertCredential(credential({ role: role as CompatCredential["role"] }))).rejects.toThrow(/CHECK/);
      }
      expect(await s.listCredentials("p1")).toEqual([]);
    });

    test("revoke keeps the first time and refuses another project's credential", async () => {
      const s = make();
      await s.insertBucket(bucket());
      await s.insertCredential(credential());
      expect(await s.revokeCredential("p2", "c1" as CredentialId, 50)).toBe(false);
      expect(await s.revokeCredential("p1", "c1" as CredentialId, 100)).toBe(true);
      expect(await s.revokeCredential("p1", "c1" as CredentialId, 200)).toBe(true);
      expect((await s.findCredential("c1" as CredentialId))?.revokedAt).toBe(100);
      expect(await s.revokeCredential("p1", "nope" as CredentialId, 100)).toBe(false);
    });
  });

  describe("upload sessions", () => {
    test("advanceUpload moves the session only from the expected state", async () => {
      const s = make();
      await s.createUpload(upload());
      expect(await s.findUpload("up1" as UploadId)).toEqual(upload());
      const next = { received: 256, hashState: "{\"n\":1}", state: "open" as const, result: null };
      expect(await s.advanceUpload("up1" as UploadId, { received: 0, state: "open" }, next)).toBe(true);
      expect(await s.advanceUpload("up1" as UploadId, { received: 0, state: "open" }, next)).toBe(false);
      expect(await s.advanceUpload("up1" as UploadId, { received: 256, state: "committing" }, next)).toBe(false);
      expect(await s.findUpload("up1" as UploadId)).toEqual(upload(next));
    });

    test("expired sessions are listed oldest first, and delete removes one", async () => {
      const s = make();
      await s.createUpload(upload({ id: "late" as UploadId, expiresAt: 3000 }));
      await s.createUpload(upload({ id: "early" as UploadId, expiresAt: 2000 }));
      await s.createUpload(upload({ id: "live" as UploadId, expiresAt: 9000 }));
      expect((await s.listExpiredUploads(5000, 10)).map((u) => u.id)).toEqual(["early", "late"]);
      await s.deleteUpload("early" as UploadId);
      expect((await s.listExpiredUploads(5000, 10)).map((u) => u.id)).toEqual(["late"]);
    });
  });
});

describe("SqlAtomicWrites.deleteAsset", () => {
  test("drops the asset's bindings and hashes and leaves other assets' rows", async () => {
    const sql = createSqliteClient();
    const store = new SqlCompatStore(sql);
    const metadata = new SqlMetadataStore(sql);
    const asset: AssetMetadata = { id: "a1", filename: "f.zip", contentType: "application/zip", size: 3, createdAt: 0, expiresAt: 0, projectId: "p1" };
    await metadata.save(asset, 3600);
    const other = "assets/cc/dd/" as FolderKey;
    for (const [k, id] of [[key, "a1"], [other, "a2"]] as const) {
      await store.bind(media, k, await claimed(store, k, 1000), id);
    }
    await store.insertBucket(bucket());
    await store.records(media, [{ objectRef: "v1", assetId: "a1" }, { objectRef: "v2", assetId: "a2" }]);
    const recorded = async () => (await sql.execute("SELECT object_ref FROM compat_hashes ORDER BY object_ref")).rows.map((r) => r.object_ref);

    await new SqlAtomicWrites(sql).deleteAsset({ asset, cleanupPrefix: "assets/a1/" });

    expect(await store.findBinding(media, key)).toBeNull();
    expect(await store.findBinding(media, other)).not.toBeNull();
    expect(await recorded()).toEqual(["v2"]);
    expect(await metadata.find("a1")).toBeNull();
  });
});
