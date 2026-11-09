// The composite writes, against a real SQLite engine: they must land as one
// unit, so a failing statement leaves none of the other rows behind (ADR-012 §3).
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import { SqlAtomicWrites } from "./writes";
import { SqlCleanupPendingStore, SqlJobStore, SqlMetadataStore, SqlStorageUsageStore, SqlVersionStore } from "./stores";
import { SqlSiteHostStore } from "./site-hosts";
import type { SiteHost } from "../../core/site/repository";
import type { AssetMetadata } from "../../core/asset/model";
import type { AssetVersion } from "../../core/asset/model";
import type { Job } from "../../core/job/model";

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
