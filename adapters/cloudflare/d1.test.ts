// The repository layer, exercised against a real SQLite engine
// (`adapters/memory/sqlite-node.ts`) instead of a hand-written D1 mock. The SQL is
// the same string the Worker sends to D1, so a syntax or column mistake fails
// here rather than in production (ADR-012 §3).
import { describe, expect, test } from "vitest";
import { createSqliteClient } from "../memory/sqlite-node";
import type { SqlClient } from "../../core/sql/port";
import {
  D1CleanupPendingStore,
  D1JobStore,
  D1MemberStore,
  D1MetadataStore,
  D1ProjectStore,
  D1StorageUsageStore,
  D1VersionStore,
  D1WorkspaceStore,
} from "./d1";
import type { AssetMetadata } from "../../core/asset/model";
import type { Job } from "../../core/job/model";

function db(): SqlClient {
  return createSqliteClient();
}

const asset = (over: Partial<AssetMetadata> = {}): AssetMetadata => ({
  id: "a1",
  filename: "test.bin",
  contentType: "application/octet-stream",
  size: 100,
  createdAt: 1000,
  expiresAt: 2000,
  ...over,
});

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1",
  assetId: "a1",
  type: "archive-extraction",
  status: "pending",
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

describe("D1WorkspaceStore", () => {
  test("save, find, delete", async () => {
    const store = new D1WorkspaceStore(db());
    const ws = { id: "ws1", name: "Test", createdAt: 100, updatedAt: 100 };
    await store.save(ws);
    expect(await store.find("ws1")).toMatchObject(ws);
    expect(await store.find("nope")).toBeNull();
    await store.delete("ws1");
    expect(await store.find("ws1")).toBeNull();
  });
});

describe("D1MemberStore", () => {
  test("save, find, list, listByUser, delete", async () => {
    const store = new D1MemberStore(db());
    const m1 = { workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 100, updatedAt: 100 };
    const m2 = { workspaceId: "ws1", userId: "u2", role: "editor" as const, createdAt: 200, updatedAt: 200 };
    const m3 = { workspaceId: "ws2", userId: "u1", role: "viewer" as const, createdAt: 300, updatedAt: 300 };
    await store.save(m1);
    await store.save(m2);
    await store.save(m3);

    expect(await store.find("ws1", "u1")).toMatchObject(m1);
    expect(await store.find("ws1", "u3")).toBeNull();
    expect((await store.list("ws1")).map((m) => m.userId).sort()).toEqual(["u1", "u2"]);
    expect((await store.listByUser("u1")).map((m) => m.workspaceId).sort()).toEqual(["ws1", "ws2"]);

    await store.delete("ws1", "u1");
    expect(await store.find("ws1", "u1")).toBeNull();
  });
});

describe("D1ProjectStore", () => {
  test("save, find, list by owner and workspace, delete", async () => {
    const store = new D1ProjectStore(db());
    await store.save({ id: "p1", name: "P1", createdAt: 100, updatedAt: 100, ownerId: "u1", workspaceId: "ws1" });
    await store.save({ id: "p2", name: "P2", createdAt: 200, updatedAt: 200, ownerId: "u1", workspaceId: "ws2" });

    expect((await store.find("p1"))?.name).toBe("P1");
    expect(await store.list({ ownerId: "u1" })).toHaveLength(2);
    expect((await store.list({ workspaceId: "ws1" })).map((p) => p.id)).toEqual(["p1"]);
    expect(await store.list({})).toEqual([]);

    await store.delete("p1", "u1");
    expect(await store.find("p1")).toBeNull();
  });
});

describe("D1MetadataStore", () => {
  test("save, find, update, delete", async () => {
    const store = new D1MetadataStore(db());
    await store.save(asset({ userMeta: { a: 1 } }), 3600);

    const found = await store.find("a1");
    expect(found?.filename).toBe("test.bin");
    expect(found?.userMeta).toEqual({ a: 1 });

    await store.update("a1", { description: "hello", expiresAt: 4000 });
    const updated = await store.find("a1");
    expect(updated?.description).toBe("hello");
    expect(updated?.expiresAt).toBe(4000);

    await store.delete("a1");
    expect(await store.find("a1")).toBeNull();
  });

  test("meta columns round-trip through the JSON meta column", async () => {
    const store = new D1MetadataStore(db());
    await store.save(asset({ type: "archive", archiveFormat: "zip", status: "pending", fileCount: 7, jobId: "j1" }), 3600);
    const found = await store.find("a1");
    expect(found?.archiveFormat).toBe("zip");
    expect(found?.fileCount).toBe(7);
    expect(found?.jobId).toBe("j1");
  });

  test("list scopes by project and paginates with a cursor", async () => {
    const store = new D1MetadataStore(db());
    for (let i = 1; i <= 3; i++) {
      await store.save(asset({ id: `a${i}`, createdAt: i * 100, projectId: "p1" }), 3600);
    }
    await store.save(asset({ id: "other", projectId: "p2" }), 3600);

    const page1 = await store.list({ projectId: "p1", limit: 2 });
    expect(page1.items.map((a) => a.id)).toEqual(["a3", "a2"]);
    expect(page1.cursor).toBeDefined();

    const page2 = await store.list({ projectId: "p1", limit: 2, cursor: page1.cursor });
    expect(page2.items.map((a) => a.id)).toEqual(["a1"]);
    expect(page2.cursor).toBeUndefined();
  });

  test("list without a scope returns nothing", async () => {
    const store = new D1MetadataStore(db());
    await store.save(asset({ projectId: "p1" }), 3600);
    expect((await store.list()).items).toEqual([]);
    expect((await store.list({})).items).toEqual([]);
  });

  test("list scoped by accessibleByUser joins members and projects", async () => {
    const sql = db();
    const assets = new D1MetadataStore(sql);
    await new D1WorkspaceStore(sql).save({ id: "ws1", name: "W", createdAt: 1, updatedAt: 1 });
    await new D1MemberStore(sql).save({ workspaceId: "ws1", userId: "u1", role: "owner", createdAt: 1, updatedAt: 1 });
    await new D1ProjectStore(sql).save({ id: "p1", name: "P", createdAt: 1, updatedAt: 1, ownerId: "u1", workspaceId: "ws1" });
    await assets.save(asset({ id: "mine", projectId: "p1" }), 3600);
    await assets.save(asset({ id: "theirs", projectId: "p9" }), 3600);

    const result = await assets.list({ accessibleByUser: "u1" });
    expect(result.items.map((a) => a.id)).toEqual(["mine"]);
  });

  test("listExpired ignores non-expiring assets", async () => {
    const store = new D1MetadataStore(db());
    await store.save(asset({ id: "expiring", expiresAt: 500 }), 3600);
    await store.save(asset({ id: "project", expiresAt: 0 }), 3600);
    const expired = await store.listExpired(1000, 10);
    expect(expired.map((a) => a.id)).toEqual(["expiring"]);
  });
});

describe("D1VersionStore", () => {
  test("save assigns increasing version numbers per asset", async () => {
    const store = new D1VersionStore(db());
    const base = { assetId: "a1", version: 0, filename: "f", contentType: "text/plain", size: 1, createdAt: 1 };
    const v1 = await store.save({ ...base, id: "v1" });
    const v2 = await store.save({ ...base, id: "v2" });
    const other = await store.save({ ...base, id: "v3", assetId: "a2" });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(other.version).toBe(1);
    expect((await store.findLatest("a1"))?.id).toBe("v2");
    expect(await store.count("a1")).toBe(2);
  });

  test("findByAssetId, update, delete and deleteByAssetId", async () => {
    const store = new D1VersionStore(db());
    const base = { assetId: "a1", version: 0, filename: "f", contentType: "text/plain", createdAt: 1 };
    await store.save({ ...base, id: "v1", size: 10 });
    await store.save({ ...base, id: "v2", size: 20 });

    const list = await store.findByAssetId("a1");
    expect(list.items.map((v) => v.id)).toEqual(["v2", "v1"]);

    await store.update("v1", { status: "ready", userMeta: { k: "v" } });
    const updated = await store.find("v1");
    expect(updated?.status).toBe("ready");
    expect(updated?.userMeta).toEqual({ k: "v" });

    await store.delete("v2");
    expect(await store.find("v2")).toBeNull();

    expect(await store.deleteByAssetId("a1")).toEqual({ totalSize: 10, count: 1 });
    expect(await store.count("a1")).toBe(0);
  });
});

describe("D1JobStore", () => {
  test("save, find, delete", async () => {
    const store = new D1JobStore(db());
    await store.save(job({ fileCount: 3, error: "boom" }));
    const found = await store.find("j1");
    expect(found?.status).toBe("pending");
    expect(found?.fileCount).toBe(3);
    expect(found?.error).toBe("boom");
    await store.delete("j1");
    expect(await store.find("j1")).toBeNull();
  });

  test("list scopes by session", async () => {
    const store = new D1JobStore(db());
    await store.save(job({ id: "j1", sessionId: "s1", createdAt: 1 }));
    await store.save(job({ id: "j2", sessionId: "s2", createdAt: 2 }));
    const result = await store.list({ sessionId: "s1" });
    expect(result.items.map((j) => j.id)).toEqual(["j1"]);
  });

  test("listRetriable honours the retry budget, the stuck threshold and progress markers", async () => {
    const store = new D1JobStore(db());
    const now = Date.now();
    await store.save(job({ id: "failed", status: "failed", retryCount: 0, updatedAt: now }));
    await store.save(job({ id: "fresh-running", status: "running", retryCount: 0, updatedAt: now }));
    await store.save(job({ id: "stuck-running", status: "running", retryCount: 0, updatedAt: now - 10_000 }));
    await store.save(job({ id: "exhausted", status: "failed", retryCount: 99 }));
    await store.save(job({ id: "progressed", status: "failed", retryCount: 99, fileCount: 10, retryFileCount: 1 }));

    const ids = (await store.listRetriable(5_000, 3)).map((j) => j.id).sort();
    expect(ids).toEqual(["failed", "progressed", "stuck-running"]);
  });

  test("listStuckAssets joins completed jobs against unfinished assets", async () => {
    const sql = db();
    const jobs = new D1JobStore(sql);
    const assets = new D1MetadataStore(sql);
    await assets.save(asset({ id: "a1", status: "extracting" }), 3600);
    await assets.save(asset({ id: "a2", status: "ready" }), 3600);
    await jobs.save(job({ id: "j1", assetId: "a1", status: "completed" }));
    await jobs.save(job({ id: "j2", assetId: "a2", status: "completed" }));

    expect((await jobs.listStuckAssets(10)).map((j) => j.id)).toEqual(["j1"]);
  });
});

describe("D1CleanupPendingStore", () => {
  test("add, list, remove", async () => {
    const store = new D1CleanupPendingStore(db());
    await store.add("assets/a1/");
    await store.add("assets/a2/");
    expect((await store.list(10)).map((p) => p.prefix).sort()).toEqual(["assets/a1/", "assets/a2/"]);
    await store.remove("assets/a1/");
    expect((await store.list(10)).map((p) => p.prefix)).toEqual(["assets/a2/"]);
  });
});

describe("D1StorageUsageStore", () => {
  test("increment accumulates, decrement floors at zero, recalculate overwrites", async () => {
    const store = new D1StorageUsageStore(db());
    expect(await store.get("project:p1")).toBeNull();

    await store.increment("project:p1", 1000);
    await store.increment("project:p1", 500);
    expect(await store.get("project:p1")).toMatchObject({ totalSize: 1500, assetCount: 2 });

    await store.decrement("project:p1", 400);
    expect(await store.get("project:p1")).toMatchObject({ totalSize: 1100, assetCount: 1 });

    await store.decrement("project:p1", 99_999);
    expect(await store.get("project:p1")).toMatchObject({ totalSize: 0, assetCount: 0 });

    await store.recalculate("project:p1", 42, 3);
    expect(await store.get("project:p1")).toMatchObject({ totalSize: 42, assetCount: 3 });
  });
});
