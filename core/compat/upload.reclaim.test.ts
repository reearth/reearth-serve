import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { drainPendingCleanups, SubrequestBudget } from "../cleanup/usecase";
import { uploadVersion } from "../asset/usecase/upload-version";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, sweepUploads, UPLOAD_TTL_MS, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, UploadId } from "./model";
import type { Deps } from "../types";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };
const BUSY = { ok: false, error: { code: "busy" } };
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });
const fill = (n: number, ch: string) => new TextEncoder().encode(ch.repeat(n));
const stream = (b: Uint8Array) => new Blob([new Uint8Array(b)]).stream();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const queued = new Set<string>();
  f.deps.pendingCleanup = {
    add: async (prefix) => { queued.add(prefix); },
    list: async (limit) => [...queued].slice(0, limit).map((prefix) => ({ prefix, createdAt: 0 })),
    remove: async (prefix) => { queued.delete(prefix); },
  };
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

const put = (c: Client, key: string, ch: string, n = 3) => c.layer.put(BUCKET, key as ObjectKey, meta(), { stream: stream(fill(n, ch)), size: n });

async function live(c: Client, key: string) {
  const head = await c.layer.head(BUCKET, key as ObjectKey);
  if (!head.ok) throw new Error(head.error.code);
  return head.value;
}

const committed = (info: Awaited<ReturnType<typeof live>>) => ({ ok: true, value: { kind: "committed", info } });

async function content(deps: Deps, c: Client, key: string): Promise<string | null> {
  const { etag } = await live(c, key);
  const keys = (await deps.storage.list("assets/")).keys;
  const found = keys.find((k) => k.includes(`/v/${etag}/`)) ?? keys.find((k) => k.startsWith(`assets/${etag}/`) && !k.includes("/v/"));
  const got = found ? await deps.storage.get(found) : null;
  return got ? new TextDecoder().decode(await new Response(got.body).arrayBuffer()) : null;
}

const stored = async (deps: Deps, key: string) => (await deps.storage.get(key)) !== null;

/** Objects under `assets/` that `seeded` (what the fixture stored first) does not hold. */
async function written(deps: Deps, seeded: string[]): Promise<string[]> {
  return (await deps.storage.list("assets/")).keys.filter((k) => !seeded.includes(k));
}

const seededOf = async (deps: Deps) => (await deps.storage.list("assets/")).keys;

const queued = async (deps: Deps) => (await deps.pendingCleanup.list(100)).map((p) => p.prefix);

const drain = (deps: Deps) => drainPendingCleanups(deps.storage, deps.pendingCleanup, new SubrequestBudget(500));

/** The first matching put stores its bytes, then hangs: the owner streamed and has not written. */
function stallAfterPut(deps: Deps, match: (key: string) => boolean) {
  const release = gate();
  const reached = gate();
  const original = deps.storage.put.bind(deps.storage);
  let stalled = "";
  vi.spyOn(deps.storage, "put").mockImplementation((async (key: string, ...rest: unknown[]) => {
    const out = await (original as (...a: unknown[]) => Promise<void>)(key, ...rest);
    if (!stalled && match(key)) {
      stalled = key;
      reached.open();
      await release.opened;
    }
    return out;
  }) as never);
  return { reached: reached.opened, release: release.open, key: () => stalled };
}

const isVersion = (k: string) => k.startsWith("assets/") && k.includes("/v/");
const isAsset = (k: string) => k.startsWith("assets/") && !k.includes("/v/");
const folderOf = (key: string) => key.slice(0, key.lastIndexOf("/") + 1);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a publish whose write throws after it applied keeps its bytes", () => {
  test.each(STORES)("(%s) R5-11: new key, the retry answers the live object with its bytes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const original = deps.writes.createAsset.bind(deps.writes);
    vi.spyOn(deps.writes, "createAsset").mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error("response lost after commit");
    });
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "n")), NO_HASH))
      .rejects.toThrow("response lost after commit");

    const info = await live(c, "n.bin");
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(committed(info));
    expect(await content(deps, c, "n.bin")).toBe("nnnnnnnnnn");
  });

  test.each(STORES)("(%s) R5-11: overwrite, the retry answers the live version with its bytes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "o.bin", "o");
    const id = await begin(c, "o.bin");
    const original = deps.writes.createVersion.bind(deps.writes);
    vi.spyOn(deps.writes, "createVersion").mockImplementationOnce(async (input) => {
      await original(input);
      throw new Error("response lost after commit");
    });
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH))
      .rejects.toThrow("response lost after commit");

    const info = await live(c, "o.bin");
    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(committed(info));
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
  });

  test.each(STORES)("(%s) R5-11: a write that failed before it applied deletes its bytes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const seeded = await seededOf(deps);
    const id = await begin(c, "n.bin");
    vi.spyOn(deps.writes, "createAsset").mockRejectedValueOnce(new Error("write refused"));
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "n")), NO_HASH))
      .rejects.toThrow("write refused");

    expect(await written(deps, seeded)).toEqual([]);
  });

  test.each(STORES)("(%s) R5-11: a failed write whose re-read fails keeps its bytes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const seeded = await seededOf(deps);
    const id = await begin(c, "n.bin");
    vi.spyOn(deps.writes, "createAsset").mockRejectedValueOnce(new Error("write refused"));
    vi.spyOn(deps.metadata, "find").mockRejectedValueOnce(new Error("read failed"));
    await expect(c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "n")), NO_HASH))
      .rejects.toThrow("write refused");

    expect(await written(deps, seeded)).toHaveLength(1);
  });
});

describe("a cancel after the commit", () => {
  test.each(STORES)("(%s) R5-9: answers the recorded result and leaves the session", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "o.bin", "o");
    const id = await begin(c, "o.bin");
    await c.uploads.append(id, BUCKET, { start: 0, size: 4, total: 4 }, stream(fill(4, "w")), NO_HASH);
    const answer = committed(await live(c, "o.bin"));

    expect(await c.uploads.cancel(id, BUCKET)).toEqual(answer);
    expect(await c.uploads.status(id, BUCKET)).toEqual(answer);
    expect(await c.uploads.cancel(id, BUCKET)).toEqual(answer);
    expect(await content(deps, c, "o.bin")).toBe("wwww");
  });
});

describe("the bytes of an owner that died after streaming are reclaimed", () => {
  test.each(STORES)("(%s) R5-10: new key, once another owner publishes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const s = stallAfterPut(deps, isAsset);
    void c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH);
    await s.reached;
    vi.mocked(deps.storage.put).mockRestore();
    c.clock.now += HOLD_STALE_MS + 1;

    const info = (await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)) as ReturnType<typeof committed>;
    expect(info).toEqual(committed(await live(c, "n.bin")));
    expect(await queued(deps)).toContain(folderOf(s.key()));
    expect(await queued(deps)).not.toContain(`assets/${info.value.info.etag}/`);

    await drain(deps);
    expect(await stored(deps, s.key())).toBe(false);
    expect(await content(deps, c, "n.bin")).toBe("dddddddddd");
  });

  test.each(STORES)("(%s) R5-10: overwrite, once another owner publishes", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "o.bin", "o");
    const id = await begin(c, "o.bin");
    const s = stallAfterPut(deps, isVersion);
    void c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await s.reached;
    vi.mocked(deps.storage.put).mockRestore();
    c.clock.now += HOLD_STALE_MS + 1;

    expect(await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 10 }, null, NO_HASH)).toEqual(committed(await live(c, "o.bin")));
    expect(await queued(deps)).toContain(folderOf(s.key()));

    await drain(deps);
    expect(await stored(deps, s.key())).toBe(false);
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
  });

  test.each(STORES)("(%s) R5-10: once the session is cancelled", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const seeded = await seededOf(deps);
    const id = await begin(c, "n.bin");
    const s = stallAfterPut(deps, isAsset);
    const owner = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH);
    await s.reached;
    c.clock.now += HOLD_STALE_MS + 1;

    expect(await c.uploads.cancel(id, BUCKET)).toEqual({ ok: true, value: { kind: "cancelled" } });
    expect(await queued(deps)).toContain(folderOf(s.key()));
    s.release();
    expect(await owner).toEqual(BUSY);
    await drain(deps);
    expect(await written(deps, seeded)).toEqual([]);
  });

  test.each(STORES)("(%s) R5-10: once the session is swept", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    const id = await begin(c, "n.bin");
    const s = stallAfterPut(deps, isAsset);
    void c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "d")), NO_HASH);
    await s.reached;
    c.clock.now += UPLOAD_TTL_MS + HOLD_STALE_MS + 1;

    expect((await sweepUploads(deps, c.clock.now)).sessions).toBe(1);
    expect(await deps.compat.findUpload(id as UploadId)).toBeNull();
    expect(await queued(deps)).toContain(folderOf(s.key()));
    await drain(deps);
    expect(await stored(deps, s.key())).toBe(false);
  });
});

describe("generations", () => {
  test.each(STORES)("(%s) R5-7: a REST version added while an overwrite streams does not outrank the published one", async (_, mk) => {
    const deps = await mk();
    const c = client(deps);
    await put(c, "o.bin", "o");
    const { etag } = await live(c, "o.bin");
    await sleep(3);
    const id = await begin(c, "o.bin");
    const s = stallAfterPut(deps, isVersion);
    const owner = c.uploads.append(id, BUCKET, { start: 0, size: 10, total: 10 }, stream(fill(10, "w")), NO_HASH);
    await s.reached;
    await sleep(5);
    const rest = await uploadVersion(deps.metadata, deps.writes, deps.storage, etag, { name: "o.bin", type: "text/plain", body: stream(fill(4, "r")), size: 4 }, "http://x");
    expect(rest).not.toBeNull();
    const during = await live(c, "o.bin");
    s.release();

    const end = await live(c, "o.bin");
    expect(await owner).toEqual(committed(end));
    expect(await content(deps, c, "o.bin")).toBe("wwwwwwwwww");
    expect(end.generation).toBeGreaterThan(during.generation);
  });
});
