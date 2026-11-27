import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, stagingPrefix, sweepUploads, UPLOAD_TTL_MS, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, UploadId } from "./model";
import type { Deps } from "../types";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });
const fill = (n: number, ch: string) => new TextEncoder().encode(ch.repeat(n));
const stream = (b: Uint8Array) => new Blob([new Uint8Array(b)]).stream();

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
}

async function memoryDeps(): Promise<Deps> {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects });
  await f.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  f.deps.pendingCleanup = { add: async () => {}, list: async () => [], remove: async () => {} };
  return f.deps as Deps;
}

async function sqlDeps(): Promise<Deps> {
  const { deps } = buildNodeRuntime({ SIGNING_SECRET: "x" });
  await deps.projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  await deps.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  return deps;
}

const STORES = [["memory", memoryDeps], ["sql", sqlDeps]] as const;

function client(deps: Deps, clock = { now: 1_000_000 }) {
  const now = () => clock.now;
  const service = { kind: "service" as const, id: "cred-a" as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role: "editor" as const }, revokedAt: null };
  const layer = objectLayer(deps, service, now);
  return { layer, uploads: resumableUploads(deps, service, layer, now), clock };
}
type Client = ReturnType<typeof client>;

async function begin(c: Client, key: string, m = meta()): Promise<UploadId> {
  const begun = await c.uploads.begin(BUCKET, key as ObjectKey, m);
  if (!begun.ok) throw new Error(begun.error.code);
  return begun.value;
}

async function live(deps: Deps, c: Client, key: string): Promise<string | null> {
  const head = await c.layer.head(BUCKET, key as ObjectKey);
  if (!head.ok) return null;
  const { etag } = head.value;
  const keys = (await deps.storage.list("assets/")).keys;
  const found = keys.find((k) => k.includes(`/v/${etag}/`)) ?? keys.find((k) => k.startsWith(`assets/${etag}/`) && !k.includes("/v/"));
  const got = found ? await deps.storage.get(found) : null;
  return got ? new TextDecoder().decode(await new Response(got.body).arrayBuffer()) : null;
}

const usageOn = async (store: string, deps: Deps) => (store === "sql" ? (await deps.storageUsage.get("project:p1"))?.totalSize ?? 0 : "not tracked");

function stallVersionPut(deps: Deps) {
  const release = gate();
  const reached = gate();
  const put = deps.storage.put.bind(deps.storage);
  let stalled = false;
  vi.spyOn(deps.storage, "put").mockImplementation((async (key: string, ...rest: unknown[]) => {
    if (!stalled && key.startsWith("assets/") && key.includes("/v/")) {
      stalled = true;
      reached.open();
      await release.opened;
    }
    return (put as (...a: unknown[]) => Promise<void>)(key, ...rest);
  }) as never);
  return { reached: reached.opened, release: release.open };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("an overwrite owner that lost its lease never gets it back", () => {
  test.each(STORES)("(%s) R1: a PUT during a stalled copy stays live, and the copy's ifGenerationMatch fails", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const seeded = await c.layer.put(BUCKET, "p.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    if (!seeded.ok) throw new Error(seeded.error.code);
    const id = await begin(c, "p.bin", meta({ ifGenerationMatch: seeded.value.generation }));
    const stall = stallVersionPut(deps);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await stall.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.layer.put(BUCKET, "p.bin" as ObjectKey, meta(), { stream: stream(fill(3, "z")), size: 3 })).toMatchObject({ ok: true });
    const afterPut = await c.layer.head(BUCKET, "p.bin" as ObjectKey);
    stall.release();
    expect(await pending).toEqual({ ok: false, error: { code: "busy" } });
    expect(await c.layer.head(BUCKET, "p.bin" as ObjectKey)).toEqual(afterPut);
    expect(await live(deps, c, "p.bin")).toBe("zzz");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 8 : "not tracked");
  });

  test.each(STORES)("(%s) R2: a DELETE and re-create during a stalled copy gets no version under the deleted asset", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "d.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const oldAsset = (await deps.compat.findBinding(BUCKET as BucketName, "d.bin" as ObjectKey))!.assetId;
    const id = await begin(c, "d.bin");
    const stall = stallVersionPut(deps);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await stall.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.layer.delete(BUCKET, "d.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });
    expect(await c.layer.put(BUCKET, "d.bin" as ObjectKey, meta(), { stream: stream(fill(3, "z")), size: 3 })).toMatchObject({ ok: true });
    stall.release();
    expect(await pending).toEqual({ ok: false, error: { code: "busy" } });
    expect((await deps.versions.findByAssetId(oldAsset)).items).toEqual([]);
    expect(await live(deps, c, "d.bin")).toBe("zzz");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 3 : "not tracked");
  });
});

describe("a new-key owner keeps its claim while it copies", () => {
  test.each(STORES)("(%s) R3: a sweep during a copy longer than HOLD_STALE_MS leaves the claim, and the commit binds", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    for (let i = 0; i < 3; i++) await c.uploads.append(id, BUCKET, { start: i * 10, size: 10, total: null }, stream(fill(10, "n")), NO_HASH);
    const put = deps.storage.put.bind(deps.storage);
    let swept: Awaited<ReturnType<typeof sweepUploads>> | null = null;
    vi.spyOn(deps.storage, "put").mockImplementationOnce((async (key: string, body: ReadableStream<Uint8Array>, ...rest: unknown[]) => {
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        chunks.push(r.value);
        c.clock.now += HOLD_STALE_MS / 2;
      }
      swept = await sweepUploads(deps, c.clock.now);
      return (put as (...a: unknown[]) => Promise<void>)(key, new Blob(chunks.map((b) => new Uint8Array(b))).stream(), ...rest);
    }) as never);
    const result = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 30 }, null, NO_HASH);
    expect(swept).toMatchObject({ claims: 0 });
    expect(result).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await live(deps, c, "n.bin")).toBe("n".repeat(30));
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 30 : "not tracked");
  });
});

describe("a session leaves only after its staged chunks are queued for cleanup", () => {
  const BLIP = new Error("d1 blip");

  test("(sql) R4: a sweep whose cleanup queue fails once queues the chunks on the next tick", async () => {
    const deps = await sqlDeps();
    const c = client(deps);
    const id = await begin(c, "x.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "x")), NO_HASH);
    vi.spyOn(deps.pendingCleanup, "add").mockRejectedValueOnce(BLIP);
    await expect(sweepUploads(deps, c.clock.now + UPLOAD_TTL_MS + 1)).rejects.toThrow(BLIP);
    expect(await sweepUploads(deps, c.clock.now + UPLOAD_TTL_MS + 2)).toMatchObject({ sessions: 1 });
    expect(await deps.compat.findUpload(id)).toBeNull();
    expect(await deps.pendingCleanup.list(100)).toContainEqual(expect.objectContaining({ prefix: stagingPrefix(id) }));
  });

  test("(sql) R4: a cancel whose cleanup fails leaves a gone session the sweep cleans up", async () => {
    const deps = await sqlDeps();
    const c = client(deps);
    const id = await begin(c, "y.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "y")), NO_HASH);
    vi.spyOn(deps.storage, "list").mockRejectedValueOnce(BLIP);
    vi.spyOn(deps.pendingCleanup, "add").mockRejectedValueOnce(BLIP);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(c.uploads.cancel(id, BUCKET)).rejects.toThrow(BLIP);
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await sweepUploads(deps, c.clock.now + UPLOAD_TTL_MS + 1)).toMatchObject({ sessions: 1 });
    expect(await deps.pendingCleanup.list(100)).toContainEqual(expect.objectContaining({ prefix: stagingPrefix(id) }));
  });
});
