import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import type { ServiceRole } from "../auth/types";
import { objectLayer } from "./layer";
import { updateAsset } from "../asset/usecase/update-asset";
import { deleteVersion } from "../asset/usecase/delete-version";
import type { BucketName, CredentialId, ObjectInfo, ObjectKey, PutMeta, Result, SizedBody } from "./model";

const BUCKET = "media";

async function layerFixture() {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects });
  await f.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  const as = (role: ServiceRole) => objectLayer(f.deps, {
    kind: "service", id: `cred-${role}` as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role }, revokedAt: null,
  });
  const assets = () => [...f.metadata.assets.values()].filter((a) => a.projectId === "p1");
  const versionsOf = (assetId: string) =>
    [...f.versions.versions.values()].filter((v) => v.assetId === assetId).sort((a, b) => a.version - b.version);
  return { ...f, assets, versionsOf, editor: as("editor"), viewer: as("viewer") };
}

const key = (k: string) => k as ObjectKey;
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });

function body(text: string): SizedBody {
  const bytes = new TextEncoder().encode(text);
  return { stream: new Blob([bytes]).stream(), size: bytes.length };
}

function heldBody(text: string): { body: SizedBody; release: () => void } {
  const bytes = new TextEncoder().encode(text);
  let release!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise<void>((resolve) => { release = resolve; });
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { body: { stream, size: bytes.length }, release: () => release() };
}

const md5 = (text: string) => createHash("md5").update(text).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const tick = () => new Promise((r) => setTimeout(r, 0));

function written(result: Result<ObjectInfo>): ObjectInfo {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("put and head", () => {
  test("a new key becomes an asset whose generation is its creation time in microseconds, with the hashes of its bytes", async () => {
    const f = await layerFixture();
    const put = await f.editor.put(BUCKET, key("assets/ab/a.txt"), meta({ userMeta: { k: "v" } }), body("small body"));
    if (!put.ok) throw new Error(put.error.code);
    expect(put.value).toMatchObject({ generation: f.assets()[0].createdAt * 1000, size: 10, contentType: "text/plain", userMeta: { k: "v" } });
    expect(hex(put.value.hashes!.md5)).toBe(md5("small body"));

    const head = await f.viewer.head(BUCKET, key("assets/ab/a.txt"));
    expect(head).toEqual({ ok: true, value: put.value });
    expect(f.assets().map((a) => a.filename)).toEqual(["a.txt"]);
  });

  test("an overwrite adds a version of the same asset at a higher generation", async () => {
    const f = await layerFixture();
    const first = written(await f.editor.put(BUCKET, key("k.txt"), meta(), body("one")));
    const second = await f.editor.put(BUCKET, key("k.txt"), meta(), body("two!"));
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.generation).toBeGreaterThan(first.generation);
    expect(second.value).toMatchObject({ size: 4 });
    expect(hex(second.value.hashes!.md5)).toBe(md5("two!"));
    expect(f.assets()).toHaveLength(1);
    expect(f.versionsOf(f.assets()[0].id)).toHaveLength(1);
    expect((await f.viewer.head(BUCKET, key("k.txt")))).toMatchObject({ ok: true, value: { generation: second.value.generation } });
  });

  test("ifGenerationMatch guards both the absent and the present case", async () => {
    const f = await layerFixture();
    expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 3 }), body("x")))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
    const first = written(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 0 }), body("x")));
    expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 0 }), body("y")))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
    expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: first.generation + 1 }), body("y")))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
    expect((await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: first.generation }), body("y"))).ok).toBe(true);
  });

  test("a viewer cannot write, and a missing key is no_such_key", async () => {
    const f = await layerFixture();
    expect(await f.viewer.put(BUCKET, key("k"), meta(), body("x"))).toEqual({ ok: false, error: { code: "forbidden" } });
    expect(await f.viewer.head(BUCKET, key("k"))).toEqual({ ok: false, error: { code: "no_such_key" } });
    expect(await f.viewer.head("nope-bucket", key("k"))).toEqual({ ok: false, error: { code: "no_such_bucket" } });
  });
});

describe("two writers on one new key", () => {
  test("make one asset; the second is told busy while the first holds the claim", async () => {
    const f = await layerFixture();
    const first = heldBody("first");
    const winner = f.editor.put(BUCKET, key("race.txt"), meta(), first.body);
    await new Promise((r) => setTimeout(r, 0));
    const loser = await f.editor.put(BUCKET, key("race.txt"), meta(), body("second"));
    first.release();
    expect(loser).toEqual({ ok: false, error: { code: "busy" } });
    const won = written(await winner);
    expect(f.assets()).toHaveLength(1);

    const retry = written(await f.editor.put(BUCKET, key("race.txt"), meta(), body("second")));
    expect(retry.generation).toBeGreaterThan(won.generation);
    expect(f.assets()).toHaveLength(1);
  });
});

describe("delete", () => {
  test("is idempotent and deletes the asset with its binding and hashes", async () => {
    const f = await layerFixture();
    const put = await f.editor.put(BUCKET, key("k.txt"), meta(), body("x"));
    if (!put.ok) throw new Error(put.error.code);
    expect(await f.editor.delete(BUCKET, key("k.txt"))).toEqual({ ok: true, value: undefined });
    expect(f.assets()).toHaveLength(0);
    expect(f.compat.bindings.size).toBe(0);
    expect(f.compat.hashes.size).toBe(0);
    expect(await f.editor.delete(BUCKET, key("k.txt"))).toEqual({ ok: true, value: undefined });
    expect(await f.editor.delete(BUCKET, key("never-written"))).toEqual({ ok: true, value: undefined });
  });

  test("authorizes before it resolves, so a viewer cannot probe keys", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k.txt"), meta(), body("x"));
    const denied = { ok: false, error: { code: "forbidden" } };
    expect(await f.viewer.delete(BUCKET, key("k.txt"))).toEqual(denied);
    expect(await f.viewer.delete(BUCKET, key("never-written"))).toEqual(denied);
    expect(f.assets()).toHaveLength(1);
  });
});

describe("list", () => {
  test("describes the objects and folds folders under the prefix", async () => {
    const f = await layerFixture();
    for (const k of ["assets/ab/1/x.txt", "assets/ab/1/y.txt", "assets/ab/2/z.txt", "assets/ab/top.txt"]) {
      await f.editor.put(BUCKET, key(k), meta(), body(k));
    }
    const page = await f.viewer.list(BUCKET, {
      prefix: "assets/ab/", delimiter: "/", startOffset: null, endOffset: null, pageToken: null, maxResults: 1000,
    });
    if (!page.ok) throw new Error(page.error.code);
    const top = await f.viewer.head(BUCKET, key("assets/ab/top.txt"));
    expect(page.value.objects).toEqual([written(top)]);
    expect(hex(page.value.objects[0].hashes!.md5)).toBe(md5("assets/ab/top.txt"));
    expect(page.value.prefixes).toEqual(["assets/ab/1/", "assets/ab/2/"]);
  });
});

describe("generations", () => {
  test("a deleted and recreated key never repeats a generation, even within one millisecond", async () => {
    const f = await layerFixture();
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      const first = written(await f.editor.put(BUCKET, key("k"), meta(), body("one")));
      expect(await f.editor.delete(BUCKET, key("k"))).toEqual({ ok: true, value: undefined });
      const again = written(await f.editor.put(BUCKET, key("k"), meta(), body("two")));
      expect(again.generation).toBeGreaterThan(first.generation);
      expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: first.generation }), body("three")))
        .toEqual({ ok: false, error: { code: "precondition_failed" } });
    } finally {
      clock.mockRestore();
    }
  });

  test("a version deleted over REST does not hand its generation to the next write", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k"), meta(), body("one"));
    const two = written(await f.editor.put(BUCKET, key("k"), meta(), body("two")));
    const asset = f.assets()[0];
    await deleteVersion(f.versions, f.metadata, asset.id, f.versionsOf(asset.id)[0].id);
    const three = written(await f.editor.put(BUCKET, key("k"), meta(), body("three")));
    expect(three.generation).toBeGreaterThan(two.generation);
    expect(written(await f.viewer.head(BUCKET, key("k")))).toEqual(three);
  });

  test("a write becomes the live object even when REST pinned an older version", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k"), meta(), body("v0"));
    await f.editor.put(BUCKET, key("k"), meta(), body("v1"));
    await f.editor.put(BUCKET, key("k"), meta(), body("v2"));
    const asset = f.assets()[0];
    await updateAsset(f.metadata, f.versions, asset.id, { activeVersionId: f.versionsOf(asset.id)[0].id });
    const pinnedHead = written(await f.viewer.head(BUCKET, key("k")));
    expect(hex(pinnedHead.hashes!.md5)).toBe(md5("v1"));

    const fresh = written(await f.editor.put(BUCKET, key("k"), meta(), body("NEW")));
    expect(written(await f.viewer.head(BUCKET, key("k")))).toEqual(fresh);
    expect(hex(fresh.hashes!.md5)).toBe(md5("NEW"));
    expect((await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: fresh.generation }), body("X"))).ok).toBe(true);
  });

  test("an object written over REST reads its creation time in microseconds", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k"), meta(), body("one"));
    const asset = f.assets()[0];
    f.compat.hashes.delete(asset.id);
    expect(written(await f.viewer.head(BUCKET, key("k")))).toMatchObject({ generation: asset.createdAt * 1000, hashes: null });
  });
});

describe("concurrent overwrites and deletes of one key", () => {
  test("two overwrites with the same ifGenerationMatch: one succeeds and the other is refused", async () => {
    const f = await layerFixture();
    const base = written(await f.editor.put(BUCKET, key("k"), meta(), body("base")));
    const a = heldBody("A");
    const b = heldBody("B");
    const pa = f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: base.generation }), a.body);
    const pb = f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: base.generation }), b.body);
    await tick();
    a.release();
    b.release();
    const results = await Promise.all([pa, pb]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const refused = results.find((r) => !r.ok);
    expect(["precondition_failed", "busy"]).toContain(refused && !refused.ok && refused.error.code);
    expect(f.versionsOf(f.assets()[0].id)).toHaveLength(1);
  });

  test("a delete during an overwrite is told busy, and the overwrite leaves a readable object", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k"), meta(), body("one"));
    const assetId = f.assets()[0].id;
    const w = heldBody("two");
    const pending = f.editor.put(BUCKET, key("k"), meta(), w.body);
    await tick();
    expect(await f.editor.delete(BUCKET, key("k"))).toEqual({ ok: false, error: { code: "busy" } });
    w.release();
    const done = written(await pending);
    expect(written(await f.viewer.head(BUCKET, key("k")))).toEqual(done);

    expect(await f.editor.delete(BUCKET, key("k"))).toEqual({ ok: true, value: undefined });
    expect(f.assets()).toHaveLength(0);
    expect(f.versionsOf(assetId)).toHaveLength(0);
    expect(f.compat.bindings.size).toBe(0);
    expect(f.compat.hashes.size).toBe(0);
  });
});

describe("a body that does not match its declared size", () => {
  const short = (): SizedBody => ({ stream: new Blob([new TextEncoder().encode("abc")]).stream(), size: 10 });
  const long = (): SizedBody => ({ stream: new Blob([new TextEncoder().encode("abcdef")]).stream(), size: 2 });
  const refused = { ok: false, error: { code: "invalid", message: "The request body does not match its Content-Length." } };

  test("is refused as invalid on a new key, and leaves the key free", async () => {
    const f = await layerFixture();
    expect(await f.editor.put(BUCKET, key("short"), meta(), short())).toEqual(refused);
    expect(await f.editor.put(BUCKET, key("long"), meta(), long())).toEqual(refused);
    expect(f.assets()).toHaveLength(0);
    expect(f.compat.bindings.size).toBe(0);
    expect((await f.editor.put(BUCKET, key("short"), meta(), body("ok"))).ok).toBe(true);
  });

  test("is refused as invalid on an overwrite, and the object keeps its bytes", async () => {
    const f = await layerFixture();
    const before = written(await f.editor.put(BUCKET, key("k"), meta(), body("kept")));
    expect(await f.editor.put(BUCKET, key("k"), meta(), short())).toEqual(refused);
    expect(await f.editor.put(BUCKET, key("k"), meta(), long())).toEqual(refused);
    expect(written(await f.viewer.head(BUCKET, key("k")))).toEqual(before);
    expect(f.versionsOf(f.assets()[0].id)).toHaveLength(0);
  });
});
