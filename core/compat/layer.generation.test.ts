import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { uploadVersion } from "../asset/usecase/upload-version";
import { updateAsset } from "../asset/usecase/update-asset";
import { objectLayer } from "./layer";
import type { BucketName, CredentialId, ObjectInfo, ObjectKey, PutMeta, Result } from "./model";
import type { Deps } from "../types";

const BUCKET = "media";
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });
const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (text: string) => new Blob([bytes(text)]).stream();

async function memoryDeps(): Promise<Deps> {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects });
  await f.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  return f.deps as Deps;
}

async function sqlDeps(): Promise<Deps> {
  const { deps } = buildNodeRuntime({ SIGNING_SECRET: "x" });
  await deps.projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  await deps.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  return deps;
}

const STORES = [["memory", memoryDeps], ["sql", sqlDeps]] as const;

function client(deps: Deps) {
  const layer = objectLayer(deps, {
    kind: "service", id: "cred-a" as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role: "editor" }, revokedAt: null,
  });
  const put = (key: string, text: string) => layer.put(BUCKET, key as ObjectKey, meta(), { stream: stream(text), size: bytes(text).length });
  const head = async (key: string) => written(await layer.head(BUCKET, key as ObjectKey));
  const list = async () => {
    const page = await layer.list(BUCKET, { prefix: "", delimiter: null, pageToken: null, startOffset: null, endOffset: null, maxResults: 1000 });
    if (!page.ok) throw new Error(page.error.code);
    return page.value.objects;
  };
  const assetOf = async (key: string) =>
    (await deps.compat.findBinding(BUCKET as BucketName, key as ObjectKey) as { assetId: string }).assetId;
  const restVersion = (assetId: string, text: string, name = "rest.bin") =>
    uploadVersion(deps.metadata, deps.writes, deps.storage, assetId, { name, type: "text/plain", body: stream(text), size: bytes(text).length }, "http://x");
  const content = async (key: string) => {
    const { etag } = await head(key);
    const keys = (await deps.storage.list("assets/")).keys;
    const found = keys.find((k) => k.includes(`/v/${etag}/`)) ?? keys.find((k) => k.startsWith(`assets/${etag}/`) && !k.includes("/v/"));
    const got = found ? await deps.storage.get(found) : null;
    return got ? new TextDecoder().decode(await new Response(got.body).arrayBuffer()) : null;
  };
  return { layer, put, head, list, assetOf, restVersion, content };
}

function written(result: Result<ObjectInfo>): ObjectInfo {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe.each(STORES)("generations (%s)", (_, mk) => {
  test("an overwrite takes the bucket's next generation and head answers it", async () => {
    const c = client(await mk());
    const one = written(await c.put("k", "one")).generation;
    expect(written(await c.put("k", "two")).generation).toBe(one + 1);
    expect((await c.head("k")).generation).toBe(one + 1);
  });

  test("a key written after its bucket is deleted and recreated gets a higher generation (R7-1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const deps = await mk(); const c = client(deps);
    const first = written(await c.put("k", "old"));
    expect((await c.layer.delete(BUCKET, "k" as ObjectKey)).ok).toBe(true);
    expect(await deps.compat.deleteBucket("p1", BUCKET as BucketName, Date.now())).toBe("deleted");
    vi.setSystemTime(1_700_000_000_001);
    expect(await deps.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: Date.now() })).toBe(true);
    expect(written(await c.put("k", "new")).generation).toBeGreaterThan(first.generation);
  });

  test("a REST version that lands after a layer write is live at a higher generation (R6-11)", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("o.bin", "o"));
    const assetId = await c.assetOf("o.bin");
    const original = deps.writes.createVersion.bind(deps.writes);
    const restAt = gate(); const restGo = gate();
    vi.spyOn(deps.writes, "createVersion").mockImplementation(async (input) => {
      if (input.version.filename === "rest.bin") { restAt.open(); await restGo.opened; }
      return original(input);
    });
    const rest = c.restVersion(assetId, "rest");
    await restAt.opened;
    const put = written(await c.put("o.bin", "p"));
    restGo.open();
    const restId = (await rest)?.version.id;
    const live = await c.head("o.bin");
    expect({ etag: live.etag, forward: live.generation > put.generation }).toEqual({ etag: restId, forward: true });
  });

  test("a REST version in the same millisecond as a layer write is live at a higher generation (R6-12)", async () => {
    const deps = await mk(); const c = client(deps);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    written(await c.put("o.bin", "o"));
    vi.setSystemTime(1_700_000_001_000);
    written(await c.put("other.bin", "x"));
    const put = written(await c.put("o.bin", "w"));
    await c.restVersion(await c.assetOf("o.bin"), "rest", "o.bin");
    expect((await c.head("o.bin")).generation).toBeGreaterThan(put.generation);
  });

  test("a REST version first seen by a listing is above every generation issued before (R6-10)", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("a", "a"));
    await c.restVersion(await c.assetOf("a"), "rest");
    const b = written(await c.put("b", "b"));
    const [listedA] = (await c.list()).filter((o) => o.key === "a");
    expect(listedA.generation).toBeGreaterThan(b.generation);
    expect((await c.head("a")).generation).toBe(listedA.generation);
  });

  test("every generation a bucket answers is unique and each key's live generation only rises", async () => {
    const deps = await mk(); const c = client(deps);
    const seen = new Map<number, string>();
    const last = new Map<string, number>();
    const observe = (info: ObjectInfo) => {
      const owner = seen.get(info.generation);
      if (owner !== undefined) expect(owner).toBe(info.etag);
      seen.set(info.generation, info.etag);
      expect(info.generation).toBeGreaterThanOrEqual(last.get(info.key) ?? 0);
      last.set(info.key, info.generation);
    };
    for (let round = 0; round < 3; round++) {
      for (const key of ["a", "b"]) {
        observe(written(await c.put(key, `${key}${round}`)));
        await c.restVersion(await c.assetOf(key), `${key}${round}r`);
        for (const listed of await c.list()) observe(listed);
        observe(await c.head(key));
      }
    }
    expect(seen.size).toBe(12);
  });

  test("concurrent first observers of a REST version agree on its generation", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("k", "one"));
    await c.restVersion(await c.assetOf("k"), "rest");
    const [h1, h2, listed, h3] = await Promise.all([c.head("k"), c.head("k"), c.list(), c.head("k")]);
    expect(new Set([h1.generation, h2.generation, listed[0].generation, h3.generation]).size).toBe(1);
  });

  test("a REST pin to an older version answers that version's stored generation", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("k", "v0"));
    const v1 = written(await c.put("k", "v1"));
    written(await c.put("k", "v2"));
    await updateAsset(deps.metadata, deps.versions, await c.assetOf("k"), { activeVersionId: v1.etag });
    expect(await c.head("k")).toEqual(v1);
  });

  test("a listing stores the missing records of its whole page in one store call", async () => {
    const deps = await mk(); const c = client(deps);
    for (const key of ["a", "b", "c"]) {
      written(await c.put(key, key));
      await c.restVersion(await c.assetOf(key), `${key}r`);
    }
    const calls = vi.spyOn(deps.compat, "records");
    const listed = await c.list();
    expect({ objects: listed.length, calls: calls.mock.calls.length }).toEqual({ objects: 3, calls: 1 });
  });
});

describe.each(STORES)("records in version order (%s)", (_, mk) => {
  test("a REST version seen between a plain overwrite's version insert and its record is above the overwrite", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("o.bin", "o"));
    const assetId = await c.assetOf("o.bin");
    const original = deps.compat.records.bind(deps.compat);
    let fired = false;
    vi.spyOn(deps.compat, "records").mockImplementation(async (bucket, refs) => {
      if (!fired && refs.some((r) => r.hashes)) {
        fired = true;
        await c.restVersion(assetId, "rest");
        await c.head("o.bin");
      }
      return original(bucket, refs);
    });
    const put = written(await c.put("o.bin", "p"));
    const live = await c.head("o.bin");
    expect({ forward: live.generation > put.generation, putHashed: put.hashes !== null }).toEqual({ forward: true, putHashed: true });
  });

  test("observing a version first records every older unrecorded version of its asset, oldest first", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("k", "v0"));
    const assetId = await c.assetOf("k");
    const v1 = await c.restVersion(assetId, "v1");
    const v2 = await c.restVersion(assetId, "v2");
    const v3 = await c.restVersion(assetId, "v3");
    const live = await c.head("k");
    expect(live.etag).toBe(v3?.version.id);
    for (const pin of [v1, v2]) {
      await updateAsset(deps.metadata, deps.versions, assetId, { activeVersionId: pin!.version.id });
      expect((await c.head("k")).generation).toBeLessThan(live.generation);
    }
    await updateAsset(deps.metadata, deps.versions, assetId, { activeVersionId: v1!.version.id });
    const g1 = (await c.head("k")).generation;
    await updateAsset(deps.metadata, deps.versions, assetId, { activeVersionId: v2!.version.id });
    expect((await c.head("k")).generation).toBeGreaterThan(g1);
  });
});

describe.each(STORES)("a plain overwrite that fails after streaming (%s)", (_, mk) => {
  test("keeps its bytes when the version row landed before the write threw (R6-7)", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("o.bin", "o"));
    const original = deps.writes.createVersion.bind(deps.writes);
    vi.spyOn(deps.writes, "createVersion").mockImplementationOnce(async (input) => { await original(input); throw new Error("lost"); });
    await expect(c.put("o.bin", "p")).rejects.toThrow("lost");
    expect(await c.content("o.bin")).toBe("p");
  });

  test("keeps its bytes when the re-read after the failure throws", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("o.bin", "o"));
    const original = deps.writes.createVersion.bind(deps.writes);
    vi.spyOn(deps.writes, "createVersion").mockImplementationOnce(async (input) => { await original(input); throw new Error("lost"); });
    vi.spyOn(deps.versions, "find").mockRejectedValueOnce(new Error("read failed"));
    await expect(c.put("o.bin", "p")).rejects.toThrow("lost");
    expect(await c.content("o.bin")).toBe("p");
  });

  test("deletes its bytes when the version row never landed", async () => {
    const deps = await mk(); const c = client(deps);
    written(await c.put("o.bin", "o"));
    const before = (await deps.storage.list("assets/")).keys.sort();
    vi.spyOn(deps.writes, "createVersion").mockRejectedValueOnce(new Error("down"));
    await expect(c.put("o.bin", "p")).rejects.toThrow("down");
    expect((await deps.storage.list("assets/")).keys.sort()).toEqual(before);
    expect(await c.content("o.bin")).toBe("o");
  });
});
