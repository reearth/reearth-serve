import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, sweepUploads, UPLOAD_TTL_MS, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, Result } from "./model";
import type { Deps } from "../types";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };
const meta = (): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null });
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

async function begin(c: Client, key: string) {
  const begun = await c.uploads.begin(BUCKET, key as ObjectKey, meta());
  if (!begun.ok) throw new Error(begun.error.code);
  return begun.value;
}

async function seeded(mk: () => Promise<Deps>, key: string) {
  const deps = await mk();
  const c = client(deps);
  await c.layer.put(BUCKET, key as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
  return { deps, c, id: await begin(c, key) };
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

const usage = async (deps: Deps) => (await deps.storageUsage.get("project:p1"))?.totalSize ?? 0;
const usageOn = async (store: string, deps: Deps) => (store === "sql" ? usage(deps) : "not tracked");
const versionsOf = async (deps: Deps, key: string) => {
  const binding = await deps.compat.findBinding(BUCKET as BucketName, key as ObjectKey);
  return (await deps.versions.findByAssetId(binding!.assetId)).items.length;
};
const etagOf = (r: Result<unknown> | string) =>
  typeof r !== "string" && r.ok && (r.value as { kind: string }).kind === "committed" ? (r.value as { info: { etag: string } }).info.etag : r;

function hangOnce<T extends object>(target: T, method: keyof T) {
  const release = gate();
  const reached = gate();
  const original = (target[method] as (...a: unknown[]) => Promise<unknown>).bind(target);
  vi.spyOn(target as never, method as never).mockImplementationOnce((async (...a: unknown[]) => {
    reached.open();
    await release.opened;
    return original(...a);
  }) as never);
  return { release: release.open, reached: reached.opened };
}

async function stalledAtPublish(c: Client, deps: Deps, id: string) {
  const hold = hangOnce(deps.writes, "createVersion");
  const stalled = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH).catch((e) => String(e));
  await hold.reached;
  return { stalled, release: hold.release };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a commit owner that lost its hold publishes nothing", () => {
  test.each(STORES)("(%s) A1: an owner that wakes after a takeover adds no version and no usage", async (store, mk) => {
    const { deps, c, id } = await seeded(mk, "w.bin");
    const { stalled, release } = await stalledAtPublish(c, deps, id);
    c.clock.now += HOLD_STALE_MS + 1;
    const taken = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    release();
    expect(await stalled).toMatchObject({ ok: false, error: { code: "busy" } });
    const head = await c.layer.head(BUCKET, "w.bin" as ObjectKey);
    expect(head.ok && head.value.etag).toBe(etagOf(taken));
    expect(etagOf(await c.uploads.status(id, BUCKET))).toBe(etagOf(taken));
    expect(await versionsOf(deps, "w.bin")).toBe(1);
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 15 : "not tracked");
  });

  test.each(STORES)("(%s) A2: a PUT after the takeover stays live when the stale owner wakes", async (_, mk) => {
    const { deps, c, id } = await seeded(mk, "w.bin");
    const { stalled, release } = await stalledAtPublish(c, deps, id);
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toMatchObject({ ok: true });
    expect(await c.layer.put(BUCKET, "w.bin" as ObjectKey, meta(), { stream: stream(fill(3, "z")), size: 3 })).toMatchObject({ ok: true });
    release();
    await stalled;
    expect(await live(deps, c, "w.bin")).toBe("zzz");
  });

  test.each(STORES)("(%s) B1: a cancelled session never overwrites the object", async (store, mk) => {
    const { deps, c, id } = await seeded(mk, "c.bin");
    const { stalled, release } = await stalledAtPublish(c, deps, id);
    c.clock.now += HOLD_STALE_MS + 1;
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: undefined });
    release();
    expect(await stalled).toMatchObject({ ok: false });
    expect(await live(deps, c, "c.bin")).toBe("ooooo");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 5 : "not tracked");
  });

  test.each(STORES)("(%s) B2: a swept session never overwrites the object", async (_, mk) => {
    const { deps, c, id } = await seeded(mk, "s.bin");
    const { stalled, release } = await stalledAtPublish(c, deps, id);
    await sweepUploads(deps, c.clock.now + UPLOAD_TTL_MS + 1);
    release();
    expect(await stalled).toMatchObject({ ok: false });
    expect(await live(deps, c, "s.bin")).toBe("ooooo");
  });

  test.each(STORES)("(%s) A3: a copy stalled past HOLD_STALE_MS loses to the takeover", async (store, mk) => {
    const { deps, c, id } = await seeded(mk, "g.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "g")), NO_HASH);
    const release = gate();
    const reached = gate();
    const put = deps.storage.put.bind(deps.storage);
    let held = false;
    vi.spyOn(deps.storage, "put").mockImplementation((async (key: string, ...rest: unknown[]) => {
      if (!held && key.includes("/v/")) {
        held = true;
        reached.open();
        await release.opened;
      }
      return (put as (...a: unknown[]) => Promise<void>)(key, ...rest);
    }) as never);
    const slow = c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH).catch((e) => String(e));
    await reached.opened;
    c.clock.now += HOLD_STALE_MS + 1;
    const retry = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    release.open();
    expect(await slow).toMatchObject({ ok: false, error: { code: "busy" } });
    const head = await c.layer.head(BUCKET, "g.bin" as ObjectKey);
    expect(head.ok && head.value.etag).toBe(etagOf(retry));
    expect(await versionsOf(deps, "g.bin")).toBe(1);
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 15 : "not tracked");
  });
});

describe("a live owner keeps its hold", () => {
  test.each(STORES)("(%s) A3: a copy that keeps reading past HOLD_STALE_MS is never taken over", async (store, mk) => {
    const { deps, c, id } = await seeded(mk, "h.bin");
    for (let i = 0; i < 3; i++) {
      await c.uploads.append(id, BUCKET, { start: i * 10, size: 10, total: null }, stream(fill(10, "h")), NO_HASH);
    }
    const put = deps.storage.put.bind(deps.storage);
    let retry: Result<unknown> | null = null;
    let slowed = false;
    vi.spyOn(deps.storage, "put").mockImplementation((async (key: string, body: ReadableStream<Uint8Array>, ...rest: unknown[]) => {
      if (slowed || !key.includes("/v/")) return (put as (...a: unknown[]) => Promise<void>)(key, body, ...rest);
      slowed = true;
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) {
        chunks.push(r.value);
        c.clock.now += HOLD_STALE_MS / 2;
      }
      retry = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 30 }, null, NO_HASH);
      return (put as (...a: unknown[]) => Promise<void>)(key, new Blob(chunks.map((b) => new Uint8Array(b))).stream(), ...rest);
    }) as never);
    const slow = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 30 }, null, NO_HASH);
    expect(retry).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(slow).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await live(deps, c, "h.bin")).toBe("h".repeat(30));
    expect(await versionsOf(deps, "h.bin")).toBe(1);
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 35 : "not tracked");
  });

  test.each(STORES)("(%s) B2: the sweep keeps an expired session whose owner is still committing", async (_, mk) => {
    const { deps, c, id } = await seeded(mk, "e.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "e")), NO_HASH);
    c.clock.now += UPLOAD_TTL_MS - 1;
    const hold = hangOnce(deps.writes, "createVersion");
    const pending = c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    await hold.reached;
    expect(await sweepUploads(deps, c.clock.now + 2)).toMatchObject({ sessions: 0, leases: 0 });
    hold.release();
    expect(await pending).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(await live(deps, c, "e.bin")).toBe("eeeeeeeeee");
  });
});

describe("a replay after the key was bound elsewhere", () => {
  test.each(STORES)("(%s) C1: the crashed owner's asset does not outlive the replay", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const assetsIn = async () => new Set((await deps.storage.list("assets/")).keys.map((k) => k.split("/")[1]));
    const before = await assetsIn();
    const id = await begin(c, "o.bin");
    vi.spyOn(deps.compat, "findRecord").mockRejectedValueOnce(new Error("crash"));
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH)).rejects.toThrow("crash");
    vi.restoreAllMocks();
    expect(await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(5, "z")), size: 5 })).toMatchObject({ ok: true });
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toMatchObject({ ok: true });
    const bound = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!.assetId;
    const rows = [];
    for (const assetId of await assetsIn()) if (!before.has(assetId) && (await deps.metadata.find(assetId))) rows.push(assetId);
    expect(rows).toEqual([bound]);
    expect(await live(deps, c, "o.bin")).toBe("dddddddddd");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 15 : "not tracked");
  });
});
