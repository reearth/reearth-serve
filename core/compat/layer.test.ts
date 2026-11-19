import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import type { ServiceRole } from "../auth/types";
import { objectLayer } from "./layer";
import type { BucketName, CredentialId, ObjectKey, PutMeta, SizedBody } from "./model";

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
  const versionsOf = (assetId: string) => [...f.versions.versions.values()].filter((v) => v.assetId === assetId);
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

describe("put and head", () => {
  test("a new key becomes an asset at generation 1 with the hashes of its bytes", async () => {
    const f = await layerFixture();
    const put = await f.editor.put(BUCKET, key("assets/ab/a.txt"), meta({ userMeta: { k: "v" } }), body("small body"));
    if (!put.ok) throw new Error(put.error.code);
    expect(put.value).toMatchObject({ generation: 1, size: 10, contentType: "text/plain", userMeta: { k: "v" } });
    expect(hex(put.value.hashes!.md5)).toBe(md5("small body"));

    const head = await f.viewer.head(BUCKET, key("assets/ab/a.txt"));
    expect(head).toEqual({ ok: true, value: put.value });
    expect(f.assets().map((a) => a.filename)).toEqual(["a.txt"]);
  });

  test("an overwrite adds a version of the same asset at generation 2", async () => {
    const f = await layerFixture();
    await f.editor.put(BUCKET, key("k.txt"), meta(), body("one"));
    const second = await f.editor.put(BUCKET, key("k.txt"), meta(), body("two!"));
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value).toMatchObject({ generation: 2, size: 4 });
    expect(hex(second.value.hashes!.md5)).toBe(md5("two!"));
    expect(f.assets()).toHaveLength(1);
    expect(f.versionsOf(f.assets()[0].id)).toHaveLength(1);
    expect((await f.viewer.head(BUCKET, key("k.txt")))).toMatchObject({ ok: true, value: { generation: 2 } });
  });

  test("ifGenerationMatch guards both the absent and the present case", async () => {
    const f = await layerFixture();
    expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 3 }), body("x")))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
    expect((await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 0 }), body("x"))).ok).toBe(true);
    expect(await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 0 }), body("y")))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
    expect((await f.editor.put(BUCKET, key("k"), meta({ ifGenerationMatch: 1 }), body("y"))).ok).toBe(true);
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
    expect(await winner).toMatchObject({ ok: true, value: { generation: 1 } });
    expect(f.assets()).toHaveLength(1);

    const retry = await f.editor.put(BUCKET, key("race.txt"), meta(), body("second"));
    expect(retry).toMatchObject({ ok: true, value: { generation: 2 } });
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
    expect(page.value.objects.map((o) => [o.key, o.generation, hex(o.hashes!.md5)])).toEqual([["assets/ab/top.txt", 1, md5("assets/ab/top.txt")]]);
    expect(page.value.prefixes).toEqual(["assets/ab/1/", "assets/ab/2/"]);
  });
});
