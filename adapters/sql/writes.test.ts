// The composite writes, against a real SQLite engine: they must land as one
// unit, so a failing statement leaves none of the other rows behind (ADR-012 §3).
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { SqlAtomicWrites } from "./writes";
import { SqlCleanupPendingStore, SqlJobStore, SqlMetadataStore, SqlStorageUsageStore, SqlVersionStore } from "./stores";
import { SqlSiteHostStore } from "./site-hosts";
import type { SiteHost } from "../../core/site/repository";
import type { AssetMetadata } from "../../core/asset/model";
import type { AssetVersion } from "../../core/asset/model";
import type { Job } from "../../core/job/model";
import { SqlCompatStore } from "./compat";
import { HoldLost } from "../../core/asset/repository";
import type { CompatPublish, LeaseToken } from "../../core/compat/repository";
import type { BucketName, CredentialId, ObjectKey, UploadId } from "../../core/compat/model";

function fixture() {
  const sql = createSqliteClient();
  return {
    sql,
    hosts: new SqlSiteHostStore(sql),
    writes: new SqlAtomicWrites(sql),
    assets: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    jobs: new SqlJobStore(sql),
    usage: new SqlStorageUsageStore(sql),
    pending: new SqlCleanupPendingStore(sql),
  };
}

const asset: AssetMetadata = {
  id: "a1",
  filename: "data.zip",
  contentType: "application/zip",
  size: 500,
  createdAt: 1000,
  expiresAt: 0,
  projectId: "p1",
  type: "archive",
  status: "pending",
  archiveFormat: "zip",
  jobId: "a1",
};

const job: Job = {
  id: "a1",
  assetId: "a1",
  type: "archive-extraction",
  status: "pending",
  createdAt: 1000,
  updatedAt: 1000,
  projectId: "p1",
};

const version: AssetVersion = {
  id: "v1",
  assetId: "a1",
  version: 0,
  filename: "data.zip",
  contentType: "application/zip",
  size: 500,
  createdAt: 1000,
};

describe("SqlAtomicWrites.createAsset", () => {
  test("writes the asset, its job and every usage counter", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset, job, usageScopes: ["project:p1", "workspace:ws1"] });

    expect((await f.assets.find("a1"))?.jobId).toBe("a1");
    expect((await f.jobs.find("a1"))?.status).toBe("pending");
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500, assetCount: 1 });
    expect(await f.usage.get("workspace:ws1")).toMatchObject({ totalSize: 500, assetCount: 1 });
  });

  test("writes nothing but the asset when there is no job and no project", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: { ...asset, jobId: undefined, projectId: undefined } });
    expect(await f.assets.find("a1")).not.toBeNull();
    expect(await f.jobs.find("a1")).toBeNull();
  });

  test("matches what MetadataStore.save writes for the same asset", async () => {
    const viaBatch = fixture();
    const viaStore = fixture();
    await viaBatch.writes.createAsset({ asset });
    await viaStore.assets.save(asset, 3600);
    expect(await viaBatch.assets.find("a1")).toEqual(await viaStore.assets.find("a1"));
  });
});

describe("SqlAtomicWrites.createVersion", () => {
  test("returns the assigned version number and increments the counters", async () => {
    const f = fixture();
    const first = await f.writes.createVersion({ version, job, usageScopes: ["project:p1"] });
    const second = await f.writes.createVersion({ version: { ...version, id: "v2" } });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect((await f.jobs.find("a1"))?.status).toBe("pending");
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500, assetCount: 1 });
  });

  test("a failing statement rolls the whole batch back", async () => {
    const f = fixture();
    await f.writes.createVersion({ version, usageScopes: ["project:p1"] });

    // Same version id: the INSERT violates the primary key, so the job row and
    // the usage increment queued alongside it must not survive either.
    await expect(
      f.writes.createVersion({
        version,
        job: { ...job, id: "should-not-exist" },
        usageScopes: ["project:p1"],
      }),
    ).rejects.toThrow();

    expect(await f.jobs.find("should-not-exist")).toBeNull();
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500, assetCount: 1 });
    expect(await f.versions.count("a1")).toBe(1);
  });
});

describe("SqlAtomicWrites with a compat publish", () => {
  const media = "media" as BucketName;
  const key = "j.zip" as ObjectKey;
  const hashes = { md5: new Uint8Array(16).fill(7), crc32c: 42 };

  const NOW = 1_700_000_000_000;
  const seed = NOW * 1000;
  afterEach(() => { vi.useRealTimers(); });

  async function leased() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const f = fixture();
    const compat = new SqlCompatStore(f.sql);
    await compat.insertBucket({ name: media, projectId: "p1", mount: null, createdAt: 0 });
    const claim = await compat.claim(media, key, "object", 1000, 0);
    if (claim.kind !== "claimed") throw new Error(claim.kind);
    await f.writes.createAsset({ asset: { ...asset, jobId: undefined, activeVersionId: "pinned" } });
    await compat.bind(media, key, claim.token, asset.id);
    await compat.lease(media, key, "lease-1" as LeaseToken, 1000, 0);
    await compat.createUpload({
      id: "up1" as UploadId, bucket: media, key, credentialId: "c1" as CredentialId,
      meta: { contentType: "application/zip", contentEncoding: null, userMeta: {}, ifGenerationMatch: null },
      expiresAt: 10_000, revision: 3, phase: { state: "failed", error: { code: "busy" } },
    });
    const publish = (revision: number, token: string, reclaim: string[] = []): CompatPublish => ({
      upload: { id: "up1" as UploadId, revision },
      hold: { kind: "lease", bucket: media, key, token, assetId: asset.id },
      record: { objectRef: "v9", hashes },
      result: {
        bucket: media, key, size: 500, contentType: "application/zip", contentEncoding: null, metageneration: 1, etag: "v9",
        created: new Date(1000), updated: new Date(1000), hashes, userMeta: {},
      },
      reclaim,
    });
    const write = (p: CompatPublish) =>
      f.writes.createVersion({ version: { ...version, id: "v9" }, job: { ...job, id: "j9", versionId: "v9" }, usageScopes: ["project:p1"], publish: p });
    return { f, compat, publish, write };
  }

  test.each([
    ["the session moved on", 2, "lease-1"],
    ["the lease was taken over", 3, "lease-2"],
  ])("R5: a publish whose %s writes no row", async (_, revision, token) => {
    const { f, compat, publish, write } = await leased();
    await expect(write(publish(revision, token, ["assets/earlier/"]))).rejects.toBeInstanceOf(HoldLost);

    expect(await f.versions.find("v9")).toBeNull();
    expect(await f.jobs.find("j9")).toBeNull();
    expect(await f.usage.get("project:p1")).toBeNull();
    expect((await f.assets.find(asset.id))?.activeVersionId).toBe("pinned");
    expect([await compat.findRecord("v9"), await compat.findRecord(asset.id)]).toEqual([null, null]);
    expect(await compat.findUpload("up1" as UploadId)).toMatchObject({ revision: 3, phase: { state: "failed" } });
    expect((await compat.records(media, [{ objectRef: "probe", assetId: "x" }])).get("probe")?.generation).toBe(seed + 1);
    expect(await f.pending.list(10)).toEqual([]);
  });

  test("R5: a publish that holds writes every row, at the bucket's next generation", async () => {
    const { f, compat, publish, write } = await leased();
    expect((await compat.records(media, [{ objectRef: "observed", assetId: "x" }])).get("observed")?.generation).toBe(seed + 1);
    const written = await write(publish(3, "lease-1", ["assets/earlier/", "assets/a1/v/earlier/"]));

    expect(written).toMatchObject({ id: "v9", version: 1, generation: seed + 3 });
    expect(await compat.findRecord(asset.id)).toEqual({ generation: seed + 2, hashes: null });
    expect(await f.jobs.find("j9")).not.toBeNull();
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500 });
    expect((await f.assets.find(asset.id))?.activeVersionId ?? null).toBeNull();
    expect(await compat.findRecord("v9")).toEqual({ generation: seed + 3, hashes });
    expect(await compat.findUpload("up1" as UploadId)).toMatchObject({
      revision: 4, phase: { state: "committed", result: { etag: "v9", generation: seed + 3, hashes } },
    });
    expect((await f.pending.list(10)).map((p) => p.prefix).sort()).toEqual(["assets/a1/v/earlier/", "assets/earlier/"]);
  });

  test("a publish first records the asset's older unrecorded versions, oldest first, below its own generation", async () => {
    const { f, compat, publish, write } = await leased();
    await f.writes.createVersion({ version: { ...version, id: "v8", createdAt: 9_999_999_999_999 } });
    const written = await write(publish(3, "lease-1"));

    expect(written).toMatchObject({ id: "v9", version: 2, generation: seed + 3 });
    expect(await compat.findUpload("up1" as UploadId)).toMatchObject({ phase: { state: "committed", result: { generation: seed + 3 } } });
    expect([await compat.findRecord(asset.id), await compat.findRecord("v8")])
      .toEqual([{ generation: seed + 1, hashes: null }, { generation: seed + 2, hashes: null }]);
  });
});

describe("SqlAtomicWrites.saveJob", () => {
  test("writes the job and the asset that mirrors it", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset, job });

    await f.writes.saveJob({
      job: { ...job, status: "completed", fileCount: 12 },
      asset: { ...asset, status: "ready", fileCount: 12 },
    });

    expect(await f.jobs.find("a1")).toMatchObject({ status: "completed", fileCount: 12 });
    expect(await f.assets.find("a1")).toMatchObject({ status: "ready", fileCount: 12 });
  });

  test("writes the job alone when the asset is gone", async () => {
    const f = fixture();
    await f.writes.saveJob({ job: { ...job, status: "failed" } });
    expect((await f.jobs.find("a1"))?.status).toBe("failed");
    expect(await f.assets.find("a1")).toBeNull();
  });
});

describe("SqlAtomicWrites.deleteAsset", () => {
  test("removes rows, decrements usage by asset plus versions, and queues the prefix", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset, usageScopes: ["project:p1"] });
    await f.writes.createVersion({ version: { ...version, size: 300 }, usageScopes: ["project:p1"] });

    await f.writes.deleteAsset({ asset, usageScopes: ["project:p1"], cleanupPrefix: "assets/a1/" });

    expect(await f.assets.find("a1")).toBeNull();
    expect((await f.versions.findByAssetId("a1")).items).toEqual([]);
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 0 });
    expect((await f.pending.list(10)).map((p) => p.prefix)).toEqual(["assets/a1/"]);
  });

  test("a repeated delete does not decrement usage again", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset: { ...asset, id: "a2" }, usageScopes: ["project:p1"] });
    await f.writes.createAsset({ asset, usageScopes: ["project:p1"] });

    await f.writes.deleteAsset({ asset, usageScopes: ["project:p1"], cleanupPrefix: "assets/a1/" });
    await f.writes.deleteAsset({ asset, usageScopes: ["project:p1"], cleanupPrefix: "assets/a1/" });

    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500, assetCount: 1 });
  });

  function siteHost(over: Partial<SiteHost>): SiteHost {
    return {
      hostname: "map.serve.example.test", assetId: "a1", projectId: "p1", kind: "subdomain",
      verifiedAt: null, disabledAt: null, previews: false, releasedAt: null, createdAt: 1000,
      createdBy: "u1", verificationToken: null, certificateStatus: null, ...over,
    };
  }

  test("releases the asset's active site hosts in the same write and returns them", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset });
    await f.writes.createAsset({ asset: { ...asset, id: "a2", jobId: undefined } });
    await f.hosts.insert(siteHost({}));
    await f.hosts.insert(siteHost({ hostname: "maps.example.com", kind: "custom", verifiedAt: 1500 }));
    await f.hosts.insert(siteHost({ hostname: "old.serve.example.test" }));
    await f.hosts.release("old.serve.example.test", 100);
    await f.hosts.insert(siteHost({ hostname: "other.serve.example.test", assetId: "a2" }));

    const { releasedSiteHosts } = await f.writes.deleteAsset({ asset, cleanupPrefix: "assets/a1/", releasedAt: 9000 });

    expect(releasedSiteHosts.map((h) => h.hostname).sort()).toEqual(["map.serve.example.test", "maps.example.com"]);
    expect(releasedSiteHosts.find((h) => h.kind === "custom")).toMatchObject({ verifiedAt: 1500, releasedAt: 9000, assetId: null });
    expect(await f.hosts.find("map.serve.example.test")).toMatchObject({ releasedAt: 9000, assetId: null });
    // An earlier release keeps its own cooldown; another asset's name is untouched.
    expect((await f.hosts.find("old.serve.example.test"))?.releasedAt).toBe(100);
    expect(await f.hosts.find("other.serve.example.test")).toMatchObject({ releasedAt: null, assetId: "a2" });
  });

  // compliance#258 REL-11: the release used to commit on its own first.
  test("a failed delete leaves the asset's site hosts serving it", async () => {
    const f = fixture();
    await f.writes.createAsset({ asset, usageScopes: ["project:p1"] });
    await f.hosts.insert(siteHost({}));
    await f.sql.execute(
      "CREATE TRIGGER fail_asset_delete BEFORE DELETE ON assets BEGIN SELECT RAISE(ABORT, 'D1 down'); END",
    );

    await expect(
      f.writes.deleteAsset({ asset, usageScopes: ["project:p1"], cleanupPrefix: "assets/a1/" }),
    ).rejects.toThrow();

    expect(await f.assets.find("a1")).not.toBeNull();
    expect(await f.hosts.find("map.serve.example.test")).toMatchObject({ releasedAt: null, assetId: "a1" });
    expect(await f.usage.get("project:p1")).toMatchObject({ totalSize: 500, assetCount: 1 });
    expect(await f.pending.list(10)).toEqual([]);
  });
});
