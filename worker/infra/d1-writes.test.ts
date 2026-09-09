// The composite writes, against a real SQLite engine: they must land as one
// unit, so a failing statement leaves none of the other rows behind (ADR-012 §3).
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "./sqlite-node";
import { D1AtomicWrites } from "./d1-writes";
import { D1JobStore, D1MetadataStore, D1StorageUsageStore, D1VersionStore } from "./d1";
import type { AssetMetadata } from "../asset/model";
import type { AssetVersion } from "../asset/model";
import type { Job } from "../job/model";

function fixture() {
  const sql = createSqliteClient();
  return {
    writes: new D1AtomicWrites(sql),
    assets: new D1MetadataStore(sql),
    versions: new D1VersionStore(sql),
    jobs: new D1JobStore(sql),
    usage: new D1StorageUsageStore(sql),
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

describe("D1AtomicWrites.createAsset", () => {
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

describe("D1AtomicWrites.createVersion", () => {
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

describe("D1AtomicWrites.saveJob", () => {
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
