// The SHA-256 backfill's ledger side (ADR-017 P4; migration 0010) against a
// real SQLite engine: which rows are selected, and when the hash is written.
import { describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, createSqliteClient, DOMAIN_MIGRATIONS_DIR } from "../memory/sqlite-node";
import { LIST_UNHASHED_SQL, SqlIntegrityBackfillStore } from "./integrity-backfill";
import { SqlJobStore, SqlMetadataStore, SqlVersionStore } from "./stores";
import type { AssetMetadata, AssetVersion } from "../../core/asset/model";
import type { Job } from "../../core/job/model";
import { JOB_MAX_RETRIES } from "../../core/job/model";

const SHA = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function fixture() {
  const sql = createSqliteClient();
  return {
    sql,
    store: new SqlIntegrityBackfillStore(sql),
    assets: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    jobs: new SqlJobStore(sql),
  };
}

/** A row as stored before ADR-017: no sha256, no integrity, classic key. */
function legacyAsset(id: string, createdAt: number, extra: Partial<AssetMetadata> = {}): AssetMetadata {
  return {
    id, filename: `${id}.bin`, contentType: "application/octet-stream", size: 10, createdAt, expiresAt: 0,
    projectId: "p1", ...extra,
  };
}

function legacyVersion(id: string, assetId: string, createdAt: number, extra: Partial<AssetVersion> = {}): AssetVersion {
  return {
    id, assetId, version: 0, filename: `${id}.bin`, contentType: "application/octet-stream", size: 5, createdAt, ...extra,
  };
}

function job(id: string, target: { assetId: string; versionId?: string }, extra: Partial<Job> = {}): Job {
  return {
    id, assetId: target.assetId, type: "integrity-backfill", status: "pending", createdAt: 1, updatedAt: 1,
    ...(target.versionId && { versionId: target.versionId }), ...extra,
  };
}

describe("listUnhashed", () => {
  test("returns pre-ADR assets, then versions, oldest first, with the asset's project and session", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a2", 20, { sessionId: "s1" }), 0);
    await f.assets.save(legacyAsset("a1", 10), 0);
    await f.versions.save(legacyVersion("v1", "a1", 30));

    expect(await f.store.listUnhashed(10)).toEqual([
      { assetId: "a1", filename: "a1.bin", projectId: "p1" },
      { assetId: "a2", filename: "a2.bin", projectId: "p1", sessionId: "s1" },
      { assetId: "a1", versionId: "v1", filename: "v1.bin", projectId: "p1" },
    ]);
  });

  test("honours the limit across both tables", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 10), 0);
    await f.versions.save(legacyVersion("v1", "a1", 30));
    await f.versions.save(legacyVersion("v2", "a1", 40));

    expect((await f.store.listUnhashed(1)).map((t) => t.versionId ?? t.assetId)).toEqual(["a1"]);
    expect((await f.store.listUnhashed(2)).map((t) => t.versionId ?? t.assetId)).toEqual(["a1", "v1"]);
    expect(await f.store.listUnhashed(0)).toEqual([]);
  });

  test("skips rows that have a hash, a pending verification, or a blob key", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("hashed", 1, { sha256: SHA, integrity: "verified" }), 0);
    await f.assets.save(legacyAsset("pending", 2, { integrity: "pending" }), 0);
    await f.assets.save(legacyAsset("blob", 3, { blobKey: `blobs/w1/${SHA}` }), 0);
    await f.assets.save(legacyAsset("legacy", 4), 0);
    await f.versions.save(legacyVersion("vh", "legacy", 5, { sha256: SHA, integrity: "verified" }));

    expect((await f.store.listUnhashed(10)).map((t) => t.versionId ?? t.assetId)).toEqual(["legacy"]);
  });

  test("never selects a row that has a backfill job, whatever its status", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1), 0);
    await f.assets.save(legacyAsset("a2", 2), 0);
    await f.assets.save(legacyAsset("a3", 3), 0);
    await f.versions.save(legacyVersion("v1", "a3", 4));
    await f.jobs.save(job("j1", { assetId: "a1" }));
    await f.jobs.save(job("j2", { assetId: "a2" }, { status: "failed", retryCount: JOB_MAX_RETRIES + 1 }));
    await f.jobs.save(job("j3", { assetId: "a3", versionId: "v1" }, { status: "running" }));
    // The asset's extraction job (same asset_id, other type) does not count.
    await f.jobs.save({ ...job("a3", { assetId: "a3" }), type: "archive-extraction" });

    expect(await f.store.listUnhashed(10)).toEqual([{ assetId: "a3", filename: "a3.bin", projectId: "p1" }]);
  });

  test("the version's job does not hide the asset row, nor the asset's job the version", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1), 0);
    await f.versions.save(legacyVersion("v1", "a1", 2));
    await f.versions.save(legacyVersion("v2", "a1", 3));
    await f.jobs.save(job("j1", { assetId: "a1", versionId: "v1" }));

    expect((await f.store.listUnhashed(10)).map((t) => t.versionId ?? t.assetId)).toEqual(["a1", "v2"]);
    await f.jobs.save(job("j2", { assetId: "a1" }));
    expect((await f.store.listUnhashed(10)).map((t) => t.versionId ?? t.assetId)).toEqual(["v2"]);
  });

  test("the page is read through the partial indexes", () => {
    const db = new DatabaseSync(":memory:");
    applyMigrations(db, DOMAIN_MIGRATIONS_DIR);
    const plan = JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${LIST_UNHASHED_SQL}`).all(2, "integrity-backfill"));
    expect(plan).toContain("idx_assets_unhashed");
    expect(plan).toContain("idx_asset_versions_unhashed");
    db.close();
  });
});

describe("countOpen", () => {
  test("counts backfill jobs not completed and with budget left", async () => {
    const f = fixture();
    await f.jobs.save(job("pending", { assetId: "a" }));
    await f.jobs.save(job("running", { assetId: "b" }, { status: "running" }));
    await f.jobs.save(job("retrying", { assetId: "c" }, { status: "failed", retryCount: 2 }));
    await f.jobs.save(job("closed", { assetId: "d" }, { status: "failed", retryCount: JOB_MAX_RETRIES + 1 }));
    await f.jobs.save(job("done", { assetId: "e" }, { status: "completed" }));
    await f.jobs.save({ ...job("other", { assetId: "f" }), type: "integrity-verification" });

    expect(await f.store.countOpen(JOB_MAX_RETRIES)).toBe(3);
  });
});

describe("complete", () => {
  const done = (j: Job): Job => ({ ...j, status: "completed", completedAt: 2, updatedAt: 2 });

  test("records the hash as verified on an asset row and saves the job", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1), 0);
    const j = job("j1", { assetId: "a1" });

    expect(await f.store.complete({ target: { assetId: "a1", filename: "a1.bin" }, sha256: SHA, job: done(j) })).toBe(true);
    expect(await f.assets.find("a1")).toMatchObject({ sha256: SHA, integrity: "verified" });
    expect((await f.assets.find("a1"))?.blobKey).toBeUndefined();
    expect(await f.jobs.find("j1")).toMatchObject({ status: "completed" });
  });

  test("records the hash on a version row", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1, { sha256: OTHER, integrity: "verified" }), 0);
    await f.versions.save(legacyVersion("v1", "a1", 2));

    const target = { assetId: "a1", versionId: "v1", filename: "v1.bin" };
    expect(await f.store.complete({ target, sha256: SHA, job: done(job("j1", target)) })).toBe(true);
    expect(await f.versions.find("v1")).toMatchObject({ sha256: SHA, integrity: "verified" });
    // The asset row is a different object and keeps its own hash.
    expect(await f.assets.find("a1")).toMatchObject({ sha256: OTHER });
  });

  test("does not overwrite a row that got a hash meanwhile", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1, { sha256: OTHER, integrity: "verified" }), 0);
    const j = job("j1", { assetId: "a1" });

    expect(await f.store.complete({ target: { assetId: "a1", filename: "a1.bin" }, sha256: SHA, job: done(j) })).toBe(false);
    expect(await f.assets.find("a1")).toMatchObject({ sha256: OTHER, integrity: "verified" });
    expect(await f.jobs.find("j1")).toMatchObject({ status: "completed" });
  });

  test("does not write a row that names another object or is gone", async () => {
    const f = fixture();
    await f.assets.save(legacyAsset("a1", 1), 0);
    await f.versions.save(legacyVersion("v1", "a1", 2));

    expect(await f.store.complete({ target: { assetId: "a1", filename: "other.bin" }, sha256: SHA, job: done(job("j1", { assetId: "a1" })) })).toBe(false);
    expect(await f.store.complete({ target: { assetId: "zz", versionId: "v1", filename: "v1.bin" }, sha256: SHA, job: done(job("j2", { assetId: "zz" })) })).toBe(false);
    expect(await f.store.complete({ target: { assetId: "gone", filename: "gone.bin" }, sha256: SHA, job: done(job("j3", { assetId: "gone" })) })).toBe(false);
    expect((await f.assets.find("a1"))?.sha256).toBeUndefined();
    expect((await f.versions.find("v1"))?.sha256).toBeUndefined();
  });

  test("a stale asset upsert after the backfill cannot erase the hash", async () => {
    const f = fixture();
    const stale = legacyAsset("a1", 1, { type: "archive", status: "extracting" });
    await f.assets.save(stale, 0);
    await f.store.complete({ target: { assetId: "a1", filename: "a1.bin" }, sha256: SHA, job: done(job("j1", { assetId: "a1" })) });

    // The extraction callback rewrites the row from a copy read before.
    await f.assets.save({ ...stale, status: "ready" }, 0);
    expect(await f.assets.find("a1")).toMatchObject({ status: "ready", sha256: SHA, integrity: "verified" });
  });
});
