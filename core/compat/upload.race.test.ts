import { afterEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { contentRangeOf } from "./gcs/app";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, Result } from "./model";
import type { Deps } from "../types";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });
const fill = (n: number, ch: string) => new TextEncoder().encode(ch.repeat(n));
const stream = (b: Uint8Array) => new Blob([new Uint8Array(b)]).stream();
const md5Hex = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
const tick = () => new Promise((r) => setTimeout(r, 5));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
}

function gated(b: Uint8Array) {
  const g = gate();
  const s = new ReadableStream<Uint8Array>({
    async pull(c) {
      await g.opened;
      c.enqueue(new Uint8Array(b));
      c.close();
    },
  });
  return { stream: s, release: g.open };
}

function twoCallerBarrier() {
  let first: (() => void) | null = null;
  let arrived = 0;
  return async () => {
    if (++arrived > 2) return;
    if (first) {
      first();
      return;
    }
    await Promise.race([new Promise<void>((r) => { first = r; }), new Promise((r) => setTimeout(r, 50))]);
  };
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

function client(deps: Deps, clock = { now: Date.now() }) {
  const now = () => clock.now;
  const service = { kind: "service" as const, id: "cred-a" as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role: "editor" as const }, revokedAt: null };
  const layer = objectLayer(deps, service, now);
  return { layer, uploads: resumableUploads(deps, service, layer, now), clock };
}

async function begin(c: ReturnType<typeof client>, key: string, m = meta()) {
  const begun = await c.uploads.begin(BUCKET, key as ObjectKey, m);
  if (!begun.ok) throw new Error(begun.error.code);
  return begun.value;
}

async function read(deps: Deps, key: string) {
  const head = await client(deps).layer.head(BUCKET, key as ObjectKey);
  if (!head.ok) return { head, bytes: null };
  const keys = (await deps.storage.list("assets/")).keys.filter((k) => k.endsWith(`/${key}`));
  const newest = keys.find((k) => k.includes("/v/")) ?? keys[0];
  const got = newest ? await deps.storage.get(newest) : null;
  return { head, bytes: got ? new Uint8Array(await new Response(got.body).arrayBuffer()) : null };
}

const usage = async (deps: Deps) => (await deps.storageUsage.get("project:p1"))?.totalSize ?? 0;
const usageOn = async (store: string, deps: Deps) => (store === "sql" ? usage(deps) : "not tracked");
const staged = async (deps: Deps) => (await deps.storage.list("compat-staging/")).keys;
const committed = (r: Result<unknown> | string) =>
  typeof r !== "string" && r.ok && (r.value as { kind: string }).kind === "committed"
    ? (r.value as { info: { generation: number } }).info.generation
    : null;

afterEach(() => { vi.restoreAllMocks(); });

describe("chunks racing on one offset", () => {
  test.each(STORES)("(%s) the slower of two bodies at byte 0 cannot replace the bytes the session hashed", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "x.bin");
    const a = fill(10, "a");
    const slow = gated(fill(20, "b"));
    const pending = c.uploads.append(id, BUCKET, { start: 0, size: 20, total: null }, slow.stream, NO_HASH);
    await tick();
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(a), NO_HASH);
    slow.release();
    await pending;
    const tail = fill(10, "c");
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(tail), NO_HASH)).toMatchObject({ ok: true });
    const { head, bytes } = await read(deps, "x.bin");
    if (!head.ok) throw new Error(head.error.code);
    expect(text(bytes)).toBe("aaaaaaaaaacccccccccc");
    expect(hex(head.value.hashes!.md5)).toBe(md5Hex(bytes!));
  });

  test("two different bodies sent at once: the object matches its recorded hashes", async () => {
    const deps = await memoryDeps();
    const c = client(deps);
    const id = await begin(c, "y.bin");
    await Promise.all([
      c.uploads.append(id, BUCKET, { start: 0, size: 5, total: null }, stream(fill(5, "A")), NO_HASH),
      c.uploads.append(id, BUCKET, { start: 0, size: 5, total: null }, stream(fill(5, "B")), NO_HASH),
    ]);
    const done = await c.uploads.append(id, BUCKET, { start: 5, size: 5, total: 10 }, stream(fill(5, "C")), NO_HASH);
    if (!done.ok || done.value.kind !== "committed") throw new Error(JSON.stringify(done));
    const { bytes } = await read(deps, "y.bin");
    expect(hex(done.value.info.hashes!.md5)).toBe(md5Hex(bytes!));
  });

  test.each(STORES)("(%s) a final chunk with a wrong X-Goog-Hash cannot strand a good final chunk sent at the same time", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "z.bin");
    const d = fill(10, "d");
    const good = gated(d);
    const bad = gated(d);
    const pGood = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, good.stream, NO_HASH);
    await tick();
    const pBad = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, bad.stream, { crc32c: 1, md5: null });
    await tick();
    good.release();
    bad.release();
    const [rGood, rBad] = await Promise.all([pGood, pBad]);
    expect(rGood).toMatchObject({ ok: true, value: { kind: "committed" } });
    expect(rBad).toMatchObject({ ok: false });
    expect(await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(d), NO_HASH)).toEqual(rGood);
    expect(text((await read(deps, "z.bin")).bytes)).toBe("dddddddddd");
  });
});

describe("one commit at a time", () => {
  const CRASH = new Error("simulated crash");

  test.each(STORES)("(%s) two replays of a failed commit of a new key: one writes, the other waits", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const d = fill(10, "n");
    vi.spyOn(deps.writes, "createAsset").mockRejectedValueOnce(CRASH);
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(d), NO_HASH)).rejects.toThrow(CRASH);
    const meet = twoCallerBarrier();
    const find = deps.metadata.find.bind(deps.metadata);
    vi.spyOn(deps.metadata, "find").mockImplementation(async (assetId) => {
      const found = await find(assetId);
      await meet();
      return found;
    });
    const replay = () => c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH).catch((e) => String(e));
    const results = await Promise.all([replay(), replay()]);
    vi.restoreAllMocks();
    const winners = results.map(committed).filter((g) => g !== null);
    expect(winners).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, error: { code: "busy" } });
    expect(text((await read(deps, "n.bin")).bytes)).toBe("nnnnnnnnnn");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 10 : "not tracked");
    expect(committed(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH))).toBe(winners[0]);
  });

  test.each(STORES)("(%s) two replays of a failed overwrite: neither deletes the other's bytes", async (store, mk) => {
    const deps = await mk();
    const c = client(deps);
    expect(await c.layer.put(BUCKET, "w.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 })).toMatchObject({ ok: true });
    const id = await begin(c, "w.bin");
    vi.spyOn(deps.writes, "createVersion").mockRejectedValueOnce(CRASH);
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH)).rejects.toThrow(CRASH);
    const meet = twoCallerBarrier();
    const find = deps.versions.find.bind(deps.versions);
    vi.spyOn(deps.versions, "find").mockImplementation(async (versionId) => {
      const found = await find(versionId);
      await meet();
      return found;
    });
    const replay = () => c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH).catch((e) => String(e));
    const results = await Promise.all([replay(), replay()]);
    vi.restoreAllMocks();
    expect(results.map(committed).filter((g) => g !== null)).toHaveLength(1);
    const { head, bytes } = await read(deps, "w.bin");
    expect(head).toMatchObject({ ok: true, value: { size: 10 } });
    expect(text(bytes)).toBe("wwwwwwwwww");
    expect(await usageOn(store, deps)).toBe(store === "sql" ? 15 : "not tracked");
  });

  test.each([
    ["reading the staged chunks", (d: Deps) => d.storage as never, "get"],
    ["writing the asset row", (d: Deps) => d.writes as never, "createAsset"],
] as const)("a commit whose owner stops while %s is taken over once stale, and the old owner cannot finish it (sql)", async (_, target, method) => {
    const deps = await sqlDeps();
    const c = client(deps, { now: 1_000_000 });
    const id = await begin(c, "s.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "s")), NO_HASH);
    const hang = gate();
    const reached = gate();
    const object = target(deps) as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const original = object[method].bind(object);
    vi.spyOn(object, method).mockImplementationOnce(async (...a: unknown[]) => {
      reached.open();
      await hang.opened;
      return original(...a);
    });
    const stalled = c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    await reached.opened;
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual({ ok: false, error: { code: "busy" } });
    c.clock.now += HOLD_STALE_MS + 1;
    const taken = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    expect(taken).toMatchObject({ ok: true, value: { kind: "committed" } });
    hang.open();
    expect(committed(await stalled.catch(() => "failed"))).toBeNull();
    expect(text((await read(deps, "s.bin")).bytes)).toBe("ssssssssss");
    expect(await usage(deps)).toBe(10);
    expect(await c.uploads.status(id, BUCKET)).toEqual(taken);
  });
});

describe("a commit that crashed, then the object was deleted", () => {
  type Crash = { name: string; overwrite: boolean; arm(deps: Deps): void };
  const CRASH = new Error("simulated crash");
  const after = <K extends string>(target: Record<K, (...a: never[]) => Promise<unknown>>, method: K) => {
    const original = (target[method] as (...a: unknown[]) => Promise<unknown>).bind(target);
    vi.spyOn(target as never, method as never).mockImplementationOnce((async (...a: unknown[]) => {
      await original(...a);
      throw CRASH;
    }) as never);
  };
  const crashes: Crash[] = [
    { name: "after the asset row", overwrite: false, arm: (d) => { vi.spyOn(d.compat, "records").mockRejectedValueOnce(CRASH); } },
    { name: "after the hash record of a new asset", overwrite: false, arm: (d) => after(d.compat as never, "records") },
    { name: "after the binding", overwrite: false, arm: (d) => after(d.compat as never, "bind") },
    { name: "after the version row", overwrite: true, arm: (d) => { vi.spyOn(d.compat, "records").mockRejectedValueOnce(CRASH); } },
    { name: "after the hash record of a version", overwrite: true, arm: (d) => after(d.compat as never, "records") },
  ];

  test.each(crashes.map((c) => [c.name, c] as const))("crash %s: a replay never brings the deleted bytes back (sql)", async (_, crash) => {
    const deps = await sqlDeps();
    const c = client(deps);
    if (crash.overwrite) await c.layer.put(BUCKET, "d.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "d.bin");
    crash.arm(deps);
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH).catch(() => null);
    vi.restoreAllMocks();
    const visible = text((await read(deps, "d.bin")).bytes) === "dddddddddd";
    expect(await c.layer.delete(BUCKET, "d.bin" as ObjectKey)).toEqual({ ok: true, value: undefined });
    const replay = await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH);
    const { head, bytes } = await read(deps, "d.bin");
    if (visible) {
      expect(head).toEqual({ ok: false, error: { code: "no_such_key" } });
      expect(await usage(deps)).toBe(0);
    } else if (head.ok) {
      expect(text(bytes)).toBe("dddddddddd");
      expect(await usage(deps)).toBe(10);
    } else {
      expect(replay).toMatchObject({ ok: false });
    }
  });

  test.each(crashes.map((c) => [c.name, c] as const))("crash %s: a replay with no delete finishes the one commit (sql)", async (_, crash) => {
    const deps = await sqlDeps();
    const c = client(deps);
    if (crash.overwrite) await c.layer.put(BUCKET, "e.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "e.bin");
    crash.arm(deps);
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "e")), NO_HASH).catch(() => null);
    vi.restoreAllMocks();
    const replay = await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "e")), NO_HASH);
    if (!replay.ok || replay.value.kind !== "committed") throw new Error(JSON.stringify(replay));
    expect(replay.value.info.size).toBe(10);
    const { head, bytes } = await read(deps, "e.bin");
    expect(head).toEqual({ ok: true, value: replay.value.info });
    expect(text(bytes)).toBe("eeeeeeeeee");
    expect(await usage(deps)).toBe(crash.overwrite ? 15 : 10);
  });
});

describe("terminal answers", () => {
  test("a precondition that fails at the commit ends the session and frees its staged chunks", async () => {
    const deps = await memoryDeps();
    const c = client(deps);
    await c.layer.put(BUCKET, "p.bin" as ObjectKey, meta(), { stream: stream(fill(5, "o")), size: 5 });
    const id = await begin(c, "p.bin", meta({ ifGenerationMatch: 0 }));
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "a")), NO_HASH);
    const failed = { ok: false, error: { code: "precondition_failed" } };
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "b")), NO_HASH)).toEqual(failed);
    expect(await staged(deps)).toEqual([]);
    expect(await c.uploads.status(id, BUCKET)).toEqual(failed);
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "b")), NO_HASH)).toEqual(failed);
  });

  test("a total declared once cannot change", async () => {
    const deps = await memoryDeps();
    const c = client(deps);
    const id = await begin(c, "t.bin");
    expect(await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 15 }, stream(fill(10, "a")), NO_HASH))
      .toEqual({ ok: true, value: { kind: "incomplete", received: 10 } });
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 10, total: 20 }, stream(fill(10, "b")), NO_HASH))
      .toEqual({ ok: false, error: { code: "invalid", message: "The upload's total is 15 bytes, not 20." } });
    expect(await c.uploads.append(id, BUCKET, { start: 10, size: 5, total: null }, stream(fill(5, "b")), NO_HASH))
      .toMatchObject({ ok: true, value: { kind: "committed", info: { size: 15 } } });
  });

  test("a chunk with no total during a commit says the total is missing", async () => {
    const deps = await memoryDeps();
    const c = client(deps);
    const id = await begin(c, "m.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "m")), NO_HASH);
    const hang = gate();
    const get = deps.storage.get.bind(deps.storage);
    vi.spyOn(deps.storage, "get").mockImplementationOnce(async (key) => {
      await hang.opened;
      return get(key);
    });
    const stalled = c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH);
    await tick();
    expect(await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "m")), NO_HASH))
      .toEqual({ ok: false, error: { code: "invalid", message: "The upload holds 10 bytes, but the request declares no total." } });
    hang.open();
    await stalled;
  });

  test("a cancelled session is gone with its staged chunks", async () => {
    const deps = await memoryDeps();
    const c = client(deps);
    const id = await begin(c, "c.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 10, total: null }, stream(fill(10, "c")), NO_HASH);
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: { kind: "cancelled" } });
    expect(await staged(deps)).toEqual([]);
    expect(await c.uploads.status(id, BUCKET)).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: false, error: { code: "no_such_upload" } });
  });
});

describe("Content-Range", () => {
  test.each([
    ["bytes 0-4/9007199254740993", null],
    ["bytes */99999999999999999999", null],
    ["bytes 0-9007199254740992/*", null],
    ["BYTES 0-4/10", { start: 0, size: 5, total: 10 }],
    ["Bytes */*", "query"],
  ])("%s", (header, want) => {
    expect(contentRangeOf(header)).toEqual(want);
  });
});
