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

function client(deps: Deps) {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const service = { kind: "service" as const, id: "cred-a" as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role: "editor" as const }, revokedAt: null };
  const layer = objectLayer(deps, service, now);
  return { layer, uploads: resumableUploads(deps, service, layer, now), clock };
}

type Client = ReturnType<typeof client>;

async function begin(c: Client, key: string): Promise<string> {
  const begun = await c.uploads.begin(BUCKET, key as ObjectKey, meta());
  if (!begun.ok) throw new Error(begun.error.code);
  return begun.value;
}

async function content(deps: Deps, c: Client, key: string): Promise<string | null> {
  const head = await c.layer.head(BUCKET, key as ObjectKey);
  if (!head.ok) return null;
  const keys = (await deps.storage.list("assets/")).keys;
  const found = keys.find((k) => k.includes(`/v/${head.value.etag}/`)) ?? keys.find((k) => k.startsWith(`assets/${head.value.etag}/`));
  const got = found ? await deps.storage.get(found) : null;
  return got ? new TextDecoder().decode(await new Response(got.body).arrayBuffer()) : null;
}

function stallFirst<T extends object>(target: T, method: keyof T, when: (...args: unknown[]) => boolean = () => true) {
  const release = gate();
  const reached = gate();
  const original = (target[method] as (...args: unknown[]) => Promise<unknown>).bind(target);
  let armed = true;
  vi.spyOn(target, method as never).mockImplementation((async (...args: unknown[]) => {
    if (armed && when(...args)) {
      armed = false;
      reached.open();
      await release.opened;
    }
    return original(...args);
  }) as never);
  return { reached: reached.opened, release: release.open };
}

const isVersionObject = (key: unknown) => typeof key === "string" && key.startsWith("assets/") && key.includes("/v/");

async function dropStaged(deps: Deps, id: string): Promise<void> {
  for (const key of (await deps.storage.list(stagingPrefix(id as UploadId))).keys) await deps.storage.delete(key);
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** The overwrite's publish lands, then its request dies before it answers. */
async function crashedAfterPublish(deps: Deps, c: Client, key: string) {
  await c.layer.put(BUCKET, key as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
  const id = await begin(c, key);
  vi.spyOn(deps.compat, "releaseLease").mockRejectedValueOnce(new Error("crash"));
  await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH)).rejects.toThrow("crash");
  const session = await deps.compat.findUpload(id as UploadId);
  if (session?.phase.state !== "committed") throw new Error(JSON.stringify(session?.phase));
  return { id, info: session.phase.result };
}

const head = (c: Client, key: string) => c.layer.head(BUCKET, key as ObjectKey);

describe("a commit publishes in one write, so a crash after it leaves nothing to finish", () => {
  test.each(STORES)("(%s) R4-A: the live object has its hashes and generation, and the sweep only drops the session", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const { id, info } = await crashedAfterPublish(deps, c, "o.bin");
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: info });
    expect(info.hashes).not.toBeNull();

    c.clock.now += UPLOAD_TTL_MS + 1;
    expect((await sweepUploads(deps, c.clock.now)).sessions).toBe(1);
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: info });
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
  });

  test.each(STORES)("(%s) R4-B1: a later write to another key leaves the object's generation alone", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const { id, info } = await crashedAfterPublish(deps, c, "o.bin");
    await c.layer.put(BUCKET, "other.bin" as ObjectKey, meta(), { stream: stream(fill(3, "x")), size: 3 });
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "committed", info } });
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: info });
    c.clock.now += HOLD_STALE_MS + 1;
    const match = await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta({ ifGenerationMatch: info.generation }), { stream: stream(fill(2, "m")), size: 2 });
    expect(match).toMatchObject({ ok: true });
  });

  test.each(STORES)("(%s) R4-B2: a newer overwrite stays live above the commit's generation", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const { id, info } = await crashedAfterPublish(deps, c, "o.bin");
    c.clock.now += HOLD_STALE_MS + 1;
    const newer = await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(3, "z")), size: 3 });
    if (!newer.ok) throw new Error(JSON.stringify(newer));
    expect(newer.value.generation).toBeGreaterThan(info.generation);
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "committed", info } });
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: newer.value });
    expect(await content(deps, c, "o.bin")).toBe("zzz");
  });

  test.each(STORES)("(%s) R4-D1: once the key is deleted the session still answers its commit, a cancel included", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const { id, info } = await crashedAfterPublish(deps, c, "o.bin");
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.layer.delete(BUCKET, "o.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });
    const answer = { ok: true, value: { kind: "committed", info } };
    expect(await c.uploads.status(id, BUCKET)).toEqual(answer);
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(answer);
    expect(await c.uploads.cancel(id, BUCKET)).toEqual(answer);
    expect(await c.uploads.status(id, BUCKET)).toEqual(answer);
    expect(await head(c, "o.bin")).toEqual({ ok: false, error: { code: "no_such_key" } });
  });

  test.each(STORES)("(%s) R4-D2: a key deleted and written again keeps the new object", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const { id, info } = await crashedAfterPublish(deps, c, "o.bin");
    c.clock.now += HOLD_STALE_MS + 1;
    await c.layer.delete(BUCKET, "o.bin" as ObjectKey);
    const again = await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(3, "n")), size: 3 });
    if (!again.ok) throw new Error(JSON.stringify(again));
    expect(again.value.generation).toBeGreaterThan(info.generation);
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "committed", info } });
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: again.value });
    expect(await content(deps, c, "o.bin")).toBe("nnn");
  });

  test.each(STORES)("(%s) R4-E1: a REST pin set after the commit stays", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "a")), size: 5 });
    const pinned = await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "b")), size: 5 });
    if (!pinned.ok) throw new Error(JSON.stringify(pinned));
    const id = await begin(c, "o.bin");
    vi.spyOn(deps.compat, "releaseLease").mockRejectedValueOnce(new Error("crash"));
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH)).rejects.toThrow("crash");
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    await deps.metadata.update(assetId, { activeVersionId: pinned.value.etag });

    expect(await c.uploads.status(id, BUCKET)).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await content(deps, c, "o.bin")).toBe("bbbbb");
    expect((await deps.metadata.find(assetId))?.activeVersionId).toBe(pinned.value.etag);
  });
});

describe("a commit stalled at its publish write", () => {
  test.each(STORES)("(%s) R4-C: a replay waits, and every answer after the write is the one commit", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "o.bin");
    const writing = stallFirst(deps.writes, "createVersion");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await writing.reached;
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual({ ok: false, error: { code: "busy" } });
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "incomplete", received: 10 } });
    writing.release();

    const committed = await pending;
    if (!committed.ok || committed.value.kind !== "committed") throw new Error(JSON.stringify(committed));
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(committed);
    expect(await c.uploads.status(id, BUCKET)).toEqual(committed);
    expect(await head(c, "o.bin")).toEqual({ ok: true, value: committed.value.info });
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    expect(await deps.versions.count(assetId)).toBe(1);
  });

  test.each(STORES)("(%s) R4-D3: a key deleted under a stale lease gets no version and no orphan hash record", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    const id = await begin(c, "o.bin");
    const writing = stallFirst(deps.writes, "createVersion");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await writing.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.layer.delete(BUCKET, "o.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });
    writing.release();

    expect(await pending).toEqual({ ok: false, error: { code: "busy" } });
    expect(await head(c, "o.bin")).toEqual({ ok: false, error: { code: "no_such_key" } });
    expect(await deps.metadata.find(assetId)).toBeNull();
    expect(await deps.compat.findRecord(assetId)).toBeNull();
    expect((await deps.storage.list(`assets/${assetId}/`)).keys).toEqual([]);
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH))
      .toEqual({ ok: false, error: { code: "precondition_failed" } });
  });

  test.each(STORES)("(%s) R4-D3: a key deleted while the owner stalls after its write leaves no orphan hash record", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    const id = await begin(c, "o.bin");
    const written = gate();
    const resume = gate();
    const createVersion = deps.writes.createVersion.bind(deps.writes);
    vi.spyOn(deps.writes, "createVersion").mockImplementationOnce(async (input) => {
      const version = await createVersion(input);
      written.open();
      await resume.opened;
      return version;
    });
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await written.opened;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.layer.delete(BUCKET, "o.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });
    resume.open();

    const committed = await pending;
    if (!committed.ok || committed.value.kind !== "committed") throw new Error(JSON.stringify(committed));
    expect(await deps.compat.findRecord(committed.value.info.etag)).toBeNull();
    expect(await deps.metadata.find(assetId)).toBeNull();
    expect(await head(c, "o.bin")).toEqual({ ok: false, error: { code: "no_such_key" } });
  });

  test.each(STORES)("(%s) P3: a cancel answers busy while the owner is fresh, and the commit lands", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "o.bin");
    const writing = stallFirst(deps.writes, "createVersion");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await writing.reached;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: false, error: { code: "busy" } });
    writing.release();
    expect(await pending).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
  });

  test.each(STORES)("(%s) P3: a sweep of the expired session leaves the object as it was", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const before = await head(c, "o.bin");
    const id = await begin(c, "o.bin");
    const writing = stallFirst(deps.writes, "createVersion");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await writing.reached;
    c.clock.now += UPLOAD_TTL_MS + 1;
    expect((await sweepUploads(deps, c.clock.now)).sessions).toBe(1);
    writing.release();
    expect(await pending).toEqual({ ok: false, error: { code: "busy" } });
    expect(await head(c, "o.bin")).toEqual(before);
    expect(await content(deps, c, "o.bin")).toBe("ooooo");
  });
});

describe("P4 a commit whose staged chunks were dropped answers busy", () => {
  test.each(STORES)("(%s) overwrite", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "s.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "s.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "v")), NO_HASH);
    const copy = stallFirst(deps.storage, "put", isVersionObject);
    const pending = c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "w")), NO_HASH);
    await copy.reached;
    await dropStaged(deps, id);
    copy.release();

    expect(await pending).toEqual({ ok: false, error: { code: "busy" } });
    expect(await content(deps, c, "s.bin")).toBe("ooooo");
  });
});

describe("P4b a commit sealed near expiry heartbeats before its first read", () => {
  test.each(STORES)("(%s) the sweep keeps the session and the commit lands", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "e.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const t0 = c.clock.now;
    const id = await begin(c, "e.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "v")), NO_HASH);
    c.clock.now = t0 + UPLOAD_TTL_MS - HOLD_STALE_MS - 60_000;
    const leasing = stallFirst(deps.compat, "lease");
    const copy = stallFirst(deps.storage, "put", isVersionObject);
    const pending = c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "w")), NO_HASH);
    await leasing.reached;
    c.clock.now = t0 + UPLOAD_TTL_MS - 60_000;
    leasing.release();
    await copy.reached;
    c.clock.now = t0 + UPLOAD_TTL_MS + 1;

    expect((await sweepUploads(deps, c.clock.now)).sessions).toBe(0);
    copy.release();
    expect(await pending).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await content(deps, c, "e.bin")).toBe("vvvvvvvvvvwwwwwwwwww");
  });
});
