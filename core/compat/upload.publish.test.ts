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

describe("P3 a cancel or sweep during an overwrite's finishing steps never loses the commit", () => {
  test.each(STORES)("(%s) cancel answers busy and every replay sees the commit", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "o.bin");
    const finishing = stallFirst(deps.compat, "nextGeneration");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await finishing.reached;
    c.clock.now += HOLD_STALE_MS + 1;

    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: false, error: { code: "busy" } });
    finishing.release();
    const committed = await pending;
    if (!committed.ok || committed.value.kind !== "committed") throw new Error(JSON.stringify(committed));
    const replay = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    expect(replay).toEqual(committed);
    expect(await c.uploads.status(id, BUCKET)).toEqual(committed);
    expect(await c.layer.head(BUCKET, "o.bin" as ObjectKey)).toEqual({ ok: true, value: committed.value.info });
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
  });

  test.each(STORES)("(%s) the sweep drops the expired session and the owner still answers committed", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "o.bin");
    const finishing = stallFirst(deps.compat, "nextGeneration");
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await finishing.reached;
    c.clock.now += UPLOAD_TTL_MS + 1;

    expect((await sweepUploads(deps, c.clock.now)).sessions).toBe(1);
    finishing.release();
    const committed = await pending;
    if (!committed.ok || committed.value.kind !== "committed") throw new Error(JSON.stringify(committed));
    expect(await c.layer.head(BUCKET, "o.bin" as ObjectKey)).toEqual({ ok: true, value: committed.value.info });
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
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
