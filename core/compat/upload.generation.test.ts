import { afterEach, describe, expect, test, vi } from "vitest";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { buildNodeRuntime } from "../../runtime/node/deps";
import { uploadVersion } from "../asset/usecase/upload-version";
import { updateAsset } from "../asset/usecase/update-asset";
import { HOLD_STALE_MS, objectLayer } from "./layer";
import { resumableUploads, type DeclaredHashes } from "./upload";
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
  const uploads = resumableUploads(deps, service, layer, now);
  const begin = async (key: string) => {
    const begun = await uploads.begin(BUCKET, key as ObjectKey, meta());
    if (!begun.ok) throw new Error(begun.error.code);
    return begun.value;
  };
  const head = async (key: string) => {
    const r = await layer.head(BUCKET, key as ObjectKey);
    if (!r.ok) throw new Error(r.error.code);
    return r.value;
  };
  return { layer, uploads, clock, begin, head };
}

afterEach(() => { vi.restoreAllMocks(); });

describe.each(STORES)("a resumable publish (%s)", (_, mk) => {
  test("R6-10: a REST version whose insert lands after the publish is live at a higher generation", async () => {
    const deps = await mk(); const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(3, "o")), size: 3 });
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    const original = deps.writes.createVersion.bind(deps.writes);
    const restAt = gate(); const restGo = gate();
    vi.spyOn(deps.writes, "createVersion").mockImplementation(async (input) => {
      if (!input.publish && input.version.filename === "rest.bin") { restAt.open(); await restGo.opened; }
      return original(input);
    });
    const rest = uploadVersion(deps.metadata, deps.writes, deps.storage, assetId, { name: "rest.bin", type: "text/plain", body: stream(fill(4, "r")), size: 4 }, "http://x");
    await restAt.opened;
    const id = await c.begin("o.bin");
    const done = await c.uploads.append(id, BUCKET, { start: 0, size: 4, total: 4 }, stream(fill(4, "w")), NO_HASH);
    if (!done.ok || done.value.kind !== "committed") throw new Error(JSON.stringify(done));
    restGo.open();
    const restId = (await rest)?.version.id;
    const live = await c.head("o.bin");
    expect({ etag: live.etag, forward: live.generation > done.value.info.generation }).toEqual({ etag: restId, forward: true });
  });
});

describe.each(STORES)("a resumable overwrite records in version order (%s)", (_, mk) => {
  test("older REST versions with no record get generations below the published one", async () => {
    const deps = await mk(); const c = client(deps);
    await c.layer.put(BUCKET, "o.bin" as ObjectKey, meta(), { stream: stream(fill(3, "o")), size: 3 });
    const { assetId } = (await deps.compat.findBinding(BUCKET as BucketName, "o.bin" as ObjectKey))!;
    const rest = (text: string) =>
      uploadVersion(deps.metadata, deps.writes, deps.storage, assetId, { name: "rest.bin", type: "text/plain", body: stream(fill(4, text)), size: 4 }, "http://x");
    const older = [await rest("a"), await rest("b")];
    const id = await c.begin("o.bin");
    const done = await c.uploads.append(id, BUCKET, { start: 0, size: 4, total: 4 }, stream(fill(4, "w")), NO_HASH);
    if (!done.ok || done.value.kind !== "committed") throw new Error(JSON.stringify(done));
    const published = done.value.info.generation;
    expect((await c.head("o.bin")).generation).toBe(published);
    for (const v of older) {
      await updateAsset(deps.metadata, deps.versions, assetId, { activeVersionId: v!.version.id });
      expect((await c.head("o.bin")).generation).toBeLessThan(published);
    }
  });
});

test("R6-9 (memory): a reclaim queue that fails after the publish neither fails the commit nor leaves it without its asset", async () => {
  const deps = await memoryDeps(); const c = client(deps);
  const id = await c.begin("n.bin");
  const original = deps.storage.put.bind(deps.storage);
  const reached = gate(); const release = gate();
  let stalled = false;
  vi.spyOn(deps.storage, "put").mockImplementation((async (key: string, ...rest: unknown[]) => {
    const out = await (original as (...a: unknown[]) => Promise<void>)(key, ...rest);
    if (!stalled && key.startsWith("assets/") && !key.includes("/v/")) { stalled = true; reached.open(); await release.opened; }
    return out;
  }) as never);
  const first = c.uploads.append(id, BUCKET, { start: 0, size: 5, total: 5 }, stream(fill(5, "n")), NO_HASH);
  await reached.opened;
  c.clock.now += HOLD_STALE_MS + 1;
  vi.spyOn(deps.pendingCleanup, "add").mockRejectedValueOnce(new Error("queue down"));
  const committed = await c.uploads.append(id, BUCKET, { start: null, size: 0, total: 5 }, null, NO_HASH);
  expect(committed.ok && committed.value.kind).toBe("committed");
  release.open(); await first.catch(() => null);
  const session = await deps.compat.findUpload(id as UploadId);
  const binding = await deps.compat.findBinding(BUCKET as BucketName, "n.bin" as ObjectKey);
  const asset = binding ? await deps.metadata.find(binding.assetId) : null;
  expect({ phase: session?.phase.state, assetRow: asset !== null }).toEqual({ phase: "committed", assetRow: true });
});
