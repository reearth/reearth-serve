import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, UploadId } from "./model";
import type { LeaseToken } from "./repository";
import type { Deps } from "../types";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });
const fill = (n: number, ch: string) => new TextEncoder().encode(ch.repeat(n));
const stream = (b: Uint8Array) => new Blob([new Uint8Array(b)]).stream();
const BUSY = { ok: false, error: { code: "busy" } };

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

const put = (c: Client, key: string, ch: string, n = 3) =>
  c.layer.put(BUCKET, key as ObjectKey, meta(), { stream: stream(fill(n, ch)), size: n });

async function content(deps: Deps, c: Client, key: string): Promise<string | null> {
  const head = await c.layer.head(BUCKET, key as ObjectKey);
  if (!head.ok) return null;
  const keys = (await deps.storage.list("assets/")).keys;
  const found = keys.find((k) => k.includes(`/v/${head.value.etag}/`)) ?? keys.find((k) => k.startsWith(`assets/${head.value.etag}/`));
  const got = found ? await deps.storage.get(found) : null;
  return got ? new TextDecoder().decode(await new Response(got.body).arrayBuffer()) : null;
}

const usageOn = async (store: string, deps: Deps) =>
  store === "sql" ? (await deps.storageUsage.get("project:p1"))?.totalSize ?? 0 : "not tracked";
const staged = async (deps: Deps) => (await deps.storage.list("compat-staging/")).keys;

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

const isAssetObject = (key: unknown) => typeof key === "string" && key.startsWith("assets/");
const isVersionObject = (key: unknown) => isAssetObject(key) && (key as string).includes("/v/");

async function assetIdOf(id: string, token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`compat-upload:${id}:${token}`)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a stale new-key commit loses to the writer that took the key", () => {
  test.each(STORES)("(%s) P1: a plain PUT after the claim went stale stays live", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const copy = stallFirst(deps.storage, "put", isAssetObject);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await copy.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await put(c, "n.bin", "z")).toMatchObject({ ok: true });
    copy.release();

    expect(await pending).toEqual(BUSY);
    expect(await content(deps, c, "n.bin")).toBe("zzz");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 3 : "not tracked");
  });

  test.each(STORES)("(%s) D1: a takeover commits, and the stale owner leaves no asset and no hash record", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const writing = stallFirst(deps.writes, "createAsset");
    const stalled = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "n")), NO_HASH);
    await writing.reached;
    const phase = (await deps.compat.findUpload(id as UploadId))?.phase;
    if (phase?.state !== "committing" || !phase.owner) throw new Error(JSON.stringify(phase));
    const staleAsset = await assetIdOf(id, phase.owner.token);
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH))
      .toMatchObject({ ok: true, value: { kind: "committed" } });
    writing.release();

    expect(await stalled).toEqual(BUSY);
    expect(await deps.metadata.find(staleAsset)).toBeNull();
    expect(await deps.compat.findRecord(staleAsset)).toBeNull();
    expect((await deps.storage.list(`assets/${staleAsset}/`)).keys).toEqual([]);
    expect(await content(deps, c, "n.bin")).toBe("nnnnnnnnnn");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 10 : "not tracked");
  });
});

describe("a cancel of a new-key commit whose owner went stale", () => {
  test.each(STORES)("(%s) P3: at the publish write, binds nothing", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "k.bin");
    const writing = stallFirst(deps.writes, "createAsset");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await writing.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    writing.release();

    expect(await pending).toEqual(BUSY);
    expect(await deps.compat.findBinding(BUCKET as BucketName, "k.bin" as ObjectKey)).toBeNull();
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 0 : "not tracked");
  });

  test.each(STORES)("(%s) P4: before its first read of the staged chunks, binds nothing", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "t.bin");
    const copy = stallFirst(deps.storage, "put", isAssetObject);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await copy.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    copy.release();

    expect(await pending).toEqual(BUSY);
    expect(await deps.compat.findBinding(BUCKET as BucketName, "t.bin" as ObjectKey)).toBeNull();
    expect(await staged(deps)).toEqual([]);
  });
});

describe("an overwrite owner that went stale before its first read", () => {
  test.each(STORES)("(%s) R6: after a cancel, publishes nothing", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "h.bin", "o", 5);
    const id = await begin(c, "h.bin");
    const copy = stallFirst(deps.storage, "put", isVersionObject);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await copy.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    copy.release();

    expect(await pending).toEqual(BUSY);
    expect(await content(deps, c, "h.bin")).toBe("ooooo");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 5 : "not tracked");
  });

  test.each(STORES)("(%s) R6: after a takeover, leaves the takeover's version live", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "h.bin", "o", 5);
    const id = await begin(c, "h.bin");
    const copy = stallFirst(deps.storage, "put", isVersionObject);
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await copy.reached;
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH))
      .toMatchObject({ ok: true, value: { kind: "committed" } });
    copy.release();

    expect(await pending).toEqual(BUSY);
    expect(await content(deps, c, "h.bin")).toBe("wwwwwwwwww");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 15 : "not tracked");
  });
});

describe("a cancel during an in-flight chunk", () => {
  test.each(STORES)("(%s) B3: leaves no staged chunk", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "k.bin");
    const staging = stallFirst(deps.storage, "put");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "k")), NO_HASH);
    await staging.reached;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    staging.release();

    expect(await pending).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await staged(deps)).toEqual([]);
  });
});

describe("a cancelled session", () => {
  test.each(STORES)("(%s) P2: stays gone after its removal failed once, and the next cancel removes it", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "g.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "a")), NO_HASH);
    vi.spyOn(deps.compat, "deleteUpload").mockRejectedValueOnce(new Error("blip"));
    await expect(c.uploads.cancel(id, BUCKET)).rejects.toThrow("blip");

    const gone = { ok: false, error: { code: "no_such_upload" } };
    expect(await c.uploads.status(id, BUCKET)).toEqual(gone);
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "b")), NO_HASH)).toEqual(gone);
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(gone);
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    expect(await c.uploads.cancel(id, BUCKET)).toEqual(gone);
    expect(await content(deps, c, "g.bin")).toBeNull();
    expect(await staged(deps)).toEqual([]);
  });
});

describe("a crashed holder is taken over once stale", () => {
  test.each(STORES)("(%s) P5: leases, commits and claims", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const lease = (key: string, token: string) =>
      deps.compat.lease(BUCKET as BucketName, key as ObjectKey, token as LeaseToken, c.clock.now, c.clock.now - HOLD_STALE_MS);
    const stale = () => { c.clock.now += HOLD_STALE_MS + 1; };

    await put(c, "l.bin", "o", 5);
    expect(await lease("l.bin", "crashed")).toBe(true);
    expect(await put(c, "l.bin", "z")).toEqual(BUSY);
    expect(await c.layer.delete(BUCKET, "l.bin" as ObjectKey)).toEqual(BUSY);
    stale();
    expect(await put(c, "l.bin", "z")).toMatchObject({ ok: true });
    expect(await lease("l.bin", "crashed again")).toBe(true);
    stale();
    expect(await c.layer.delete(BUCKET, "l.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });

    await put(c, "m.bin", "o", 5);
    const id = await begin(c, "m.bin");
    const copy = stallFirst(deps.storage, "put", isVersionObject);
    void c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH).catch(() => {});
    await copy.reached;
    expect(await put(c, "m.bin", "z")).toEqual(BUSY);
    stale();
    expect(await put(c, "m.bin", "z")).toMatchObject({ ok: true });
    stale();
    expect(await c.layer.delete(BUCKET, "m.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });

    await deps.compat.claim(BUCKET as BucketName, "c.bin" as ObjectKey, "object", c.clock.now, c.clock.now - HOLD_STALE_MS);
    expect(await put(c, "c.bin", "z")).toEqual(BUSY);
    stale();
    expect(await put(c, "c.bin", "z")).toMatchObject({ ok: true });
  });
});
