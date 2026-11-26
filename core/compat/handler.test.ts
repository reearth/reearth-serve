import { describe, expect, test } from "vitest";
import { PROJECT_ID, siteFixture } from "../../adapters/memory/site-fixture";
import { MemoryCompatStore } from "../../adapters/memory/compat";
import type { Role } from "../../shared/api";
import type { BucketName, CompatBucket } from "./model";

class DeletesAfterRead extends MemoryCompatStore {
  armed = false;
  override async findBucket(name: BucketName): Promise<CompatBucket | null> {
    const found = await super.findBucket(name);
    if (this.armed && found) {
      this.armed = false;
      await this.deleteBucket(found.projectId, name, 1);
    }
    return found;
  }
}

async function compatApp(role: Role, compat = new MemoryCompatStore()) {
  const f = await siteFixture({ role, deps: { compat, compatApiHost: "storage.example.test" } });
  const call = (method: string, path: string, body?: unknown) =>
    f.app.request(`/api/v1/projects/${PROJECT_ID}${path}`, {
      method,
      headers: { ...f.auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...f, compat, call };
}

describe("compat management routes", () => {
  test.each(["storage", "upload", "download", "batch"])("a new bucket named %s, an API path prefix, is refused", async (name) => {
    const { call, compat } = await compatApp("admin");
    const res = await call("POST", "/compat/buckets", { name });
    expect(res.status).toBe(400);
    expect(compat.buckets.size).toBe(0);
  });

  test("a bucket deleted while its credential is issued answers 404 and leaves no credential for a recreated bucket", async () => {
    const compat = new DeletesAfterRead();
    const { call } = await compatApp("admin", compat);
    expect((await call("POST", "/compat/buckets", { name: "media" })).status).toBe(201);

    compat.armed = true;
    const issued = await call("POST", "/compat/credentials", { bucket: "media", role: "editor" });

    expect(issued.status).toBe(404);
    expect(compat.credentials.size).toBe(0);
    expect((await call("POST", "/compat/buckets", { name: "media" })).status).toBe(201);
    expect(await compat.listCredentials(PROJECT_ID)).toEqual([]);
  });

  test("deleting a project removes its buckets and credentials, so the name can be created again", async () => {
    const { call, compat } = await compatApp("owner");
    await call("POST", "/compat/buckets", { name: "media" });
    expect((await call("POST", "/compat/credentials", { bucket: "media", role: "editor" })).status).toBe(201);

    expect((await call("DELETE", "")).status).toBe(204);

    expect(compat.buckets.size).toBe(0);
    expect(compat.credentials.size).toBe(0);
    expect(await compat.insertBucket({ name: "media" as BucketName, projectId: "p2", mount: null, createdAt: 1 })).toBe(true);
  });

  test("an empty label is stored as no label", async () => {
    const { call } = await compatApp("admin");
    await call("POST", "/compat/buckets", { name: "media" });
    await call("POST", "/compat/credentials", { bucket: "media", role: "viewer", label: "" });
    const { credentials } = await (await call("GET", "/compat/credentials")).json() as { credentials: { label: unknown }[] };
    expect(credentials.map((c) => c.label)).toEqual([null]);
  });

  test("a mount prefix starting with '/' is refused", async () => {
    const { call } = await compatApp("admin");
    for (const prefix of ["/", "/assets/"]) {
      expect((await call("POST", "/compat/buckets", { name: "media", mount: { prefix, depth: 1, strip: "none" } })).status).toBe(400);
    }
    expect((await call("POST", "/compat/buckets", { name: "media", mount: { prefix: "assets/", depth: 1, strip: "none" } })).status).toBe(201);
  });
});
