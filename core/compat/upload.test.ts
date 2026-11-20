import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { fixture } from "../../adapters/memory/fixture";
import { MemoryProjectStore } from "../../adapters/memory/site-fixture";
import { initialHashState } from "./hash";
import { objectLayer } from "./layer";
import { applyChunk, resumableUploads, sweepUploads, UPLOAD_TTL_MS, type Chunk, type DeclaredHashes } from "./upload";
import type { BucketName, CredentialId, ObjectKey, PutMeta, UploadId, UploadPhase, UploadSession } from "./model";

const BUCKET = "media";
const NO_HASH: DeclaredHashes = { crc32c: null, md5: null };

const OPEN: UploadPhase = { state: "open", received: 100, total: null, hashState: initialHashState, parts: [] };
const COMMITTING: UploadPhase = {
  state: "committing", size: 100, hashState: initialHashState, parts: [], owner: null, ownerTokens: [], overwritingAssetId: null,
};

function session(phase: UploadPhase = OPEN): UploadSession {
  return {
    id: "u1" as UploadId, bucket: BUCKET as BucketName, key: "k" as ObjectKey, credentialId: "c1" as CredentialId,
    meta: { contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null },
    expiresAt: 1000, revision: 0, phase,
  };
}

describe("applyChunk", () => {
  const chunk = (start: number | null, size: number, total: number | null): Chunk => ({ start, size, total });

  const committed = { state: "committed", result: {} } as UploadPhase;
  const failed: UploadPhase = { state: "failed", error: { code: "precondition_failed" } };
  const known: UploadPhase = { ...OPEN, total: 150 } as UploadPhase;

  test.each<[string, UploadPhase, Chunk, number, ReturnType<typeof applyChunk>]>([
    ["a committed session acks anything", committed, chunk(0, 10, null), 5000, { kind: "ack" }],
    ["a failed session answers its error", failed, chunk(100, 10, 110), 0, { kind: "reject", error: { code: "precondition_failed" } }],
    ["an expired session is gone", OPEN, chunk(100, 10, null), 1000, { kind: "reject", error: { code: "no_such_upload" } }],
    ["a committing session commits again on its total", COMMITTING, chunk(90, 10, 100), 0, { kind: "commit" }],
    ["a committing session refuses another total", COMMITTING, chunk(100, 10, 110), 0,
      { kind: "reject", error: { code: "invalid", message: "The upload holds 100 bytes, not 110." } }],
    ["a committing session refuses a chunk with no total", COMMITTING, chunk(90, 10, null), 0,
      { kind: "reject", error: { code: "invalid", message: "The upload holds 100 bytes, but the request declares no total." } }],
    ["an empty final request on the received size commits", OPEN, chunk(null, 0, 100), 0, { kind: "commit" }],
    ["an empty final request on another size is refused", OPEN, chunk(null, 0, 120), 0,
      { kind: "reject", error: { code: "invalid", message: "The upload holds 100 bytes, not 120." } }],
    ["a resent chunk already staged is acked", OPEN, chunk(50, 50, null), 0, { kind: "ack" }],
    ["a chunk past a gap is refused", OPEN, chunk(110, 10, null), 0,
      { kind: "reject", error: { code: "invalid", message: "The chunk starts at byte 110, but the upload holds 100 bytes." } }],
    ["a chunk overlapping the received end is refused", OPEN, chunk(90, 20, null), 0,
      { kind: "reject", error: { code: "invalid", message: "The chunk starts at byte 90, but the upload holds 100 bytes." } }],
    ["the next chunk of unknown total is staged", OPEN, chunk(100, 10, null), 0, { kind: "stage", final: false, total: null }],
    ["the chunk that reaches the total is staged as final", OPEN, chunk(100, 10, 110), 0, { kind: "stage", final: true, total: 110 }],
    ["a chunk short of a known total is staged", OPEN, chunk(100, 10, 200), 0, { kind: "stage", final: false, total: 200 }],
    ["a total declared earlier holds for a chunk without one", known, chunk(100, 50, null), 0, { kind: "stage", final: true, total: 150 }],
    ["a total declared earlier cannot change", known, chunk(100, 10, 200), 0,
      { kind: "reject", error: { code: "invalid", message: "The upload's total is 150 bytes, not 200." } }],
    ["a chunk past a total declared earlier is refused", known, chunk(100, 60, null), 0,
      { kind: "reject", error: { code: "invalid", message: "The chunk ends at byte 160, past the total of 150 bytes." } }],
  ])("%s", (_, phase, c, now, want) => {
    expect(applyChunk(session(phase), c, now)).toEqual(want);
  });
});

const CHUNK = 1024;

function bytesOf(size: number, seed = 1): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) & 0xff);
}

const stream = (b: Uint8Array) => new Blob([new Uint8Array(b)]).stream();
const md5Hex = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function crc32cOf(data: Uint8Array): number {
  let c = ~0;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
  }
  return ~c >>> 0;
}

async function uploadFixture() {
  const projects = new MemoryProjectStore();
  await projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
  const f = await fixture({ projects });
  await f.compat.insertBucket({ name: BUCKET as BucketName, projectId: "p1", mount: null, createdAt: 0 });
  const pending: string[] = [];
  f.deps.pendingCleanup = { add: async (p) => { pending.push(p); }, list: async () => [], remove: async () => {} };
  let clock = 1_000_000;
  const now = () => clock;
  const as = (id: string) => {
    const service = { kind: "service" as const, id: id as CredentialId, grant: { projectId: "p1", bucket: BUCKET as BucketName, role: "editor" as const }, revokedAt: null };
    const layer = objectLayer(f.deps, service, now);
    return { layer, uploads: resumableUploads(f.deps, service, layer, now) };
  };
  const assets = () => [...f.metadata.assets.values()].filter((a) => a.projectId === "p1");
  const staged = async () => (await f.storage.list("compat-staging/")).keys;
  const versions = () => [...f.versions.versions.values()].filter((v) => assets().some((a) => a.id === v.assetId));
  return { ...f, as, assets, versions, staged, pending, advance: (ms: number) => { clock += ms; } };
}

type Fixture = Awaited<ReturnType<typeof uploadFixture>>;
const meta = (m: Partial<PutMeta> = {}): PutMeta => ({ contentType: "text/plain", contentEncoding: null, userMeta: {}, ifGenerationMatch: null, ...m });

async function begin(f: Fixture, key = "big.bin", m = meta()) {
  const begun = await f.as("cred-a").uploads.begin(BUCKET, key as ObjectKey, m);
  if (!begun.ok) throw new Error(begun.error.code);
  return begun.value;
}

async function sendAll(f: Fixture, id: string, data: Uint8Array, declared: DeclaredHashes = { crc32c: crc32cOf(data), md5: null }) {
  const { uploads } = f.as("cred-a");
  let start = 0;
  for (; data.length - start > CHUNK; start += CHUNK) {
    const r = await uploads.append(id, BUCKET, { start, size: CHUNK, total: null }, stream(data.subarray(start, start + CHUNK)), NO_HASH);
    expect(r).toEqual({ ok: true, value: { kind: "incomplete", received: start + CHUNK } });
  }
  const last = data.subarray(start);
  return uploads.append(id, BUCKET, { start, size: last.length, total: data.length }, stream(last), declared);
}

describe("resumable uploads on the memory fixture", () => {
  test("chunks commit into one asset with the hashes of all bytes, and the staged chunks go", async () => {
    const f = await uploadFixture();
    const data = bytesOf(CHUNK * 2 + 300);
    const id = await begin(f);
    const done = await sendAll(f, id, data);
    if (!done.ok || done.value.kind !== "committed") throw new Error(JSON.stringify(done));
    expect(done.value.info).toMatchObject({ size: data.length, key: "big.bin" });
    expect(hex(done.value.info.hashes!.md5)).toBe(md5Hex(data));
    expect(done.value.info.hashes!.crc32c).toBe(crc32cOf(data));
    expect(f.assets()).toHaveLength(1);
    const stored = await f.storage.get(`assets/${f.assets()[0].id}/big.bin`);
    expect(new Uint8Array(await new Response(stored!.body).arrayBuffer())).toEqual(data);
    expect(await f.staged()).toEqual([]);
    expect(await f.as("cred-a").layer.head(BUCKET, "big.bin" as ObjectKey)).toEqual({ ok: true, value: done.value.info });
  });

  test("a size on a chunk boundary ends with an empty request and commits", async () => {
    const f = await uploadFixture();
    const data = bytesOf(CHUNK * 2);
    const id = await begin(f);
    const { uploads } = f.as("cred-a");
    for (const start of [0, CHUNK]) {
      await uploads.append(id, BUCKET, { start, size: CHUNK, total: null }, stream(data.subarray(start, start + CHUNK)), NO_HASH);
    }
    const done = await uploads.append(id, BUCKET, { start: null, size: 0, total: data.length }, null, { crc32c: crc32cOf(data), md5: null });
    expect(done).toMatchObject({ ok: true, value: { kind: "committed", info: { size: data.length } } });
    expect(f.assets()).toHaveLength(1);
  });

  test("a CRC32C mismatch on the final chunk is invalid and stores nothing", async () => {
    const f = await uploadFixture();
    const data = bytesOf(CHUNK + 10);
    const id = await begin(f);
    const done = await sendAll(f, id, data, { crc32c: crc32cOf(data) ^ 1, md5: null });
    expect(done).toEqual({ ok: false, error: { code: "invalid", message: "Provided CRC32C does not match the uploaded data." } });
    expect(f.assets()).toHaveLength(0);
    expect(f.compat.bindings.size).toBe(0);
    expect(await f.staged()).toEqual([expect.stringMatching(new RegExp(`^compat-staging/${id}/0{16}-`))]);
    expect(await f.as("cred-a").uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "incomplete", received: CHUNK } });
  });

  test("a resent chunk is acked without staging it again, and a gap leaves the session usable", async () => {
    const f = await uploadFixture();
    const data = bytesOf(CHUNK * 2 + 5);
    const id = await begin(f);
    const { uploads } = f.as("cred-a");
    await uploads.append(id, BUCKET, { start: 0, size: CHUNK, total: null }, stream(data.subarray(0, CHUNK)), NO_HASH);
    const put = vi.spyOn(f.storage, "put");
    expect(await uploads.append(id, BUCKET, { start: 0, size: CHUNK, total: null }, stream(data.subarray(0, CHUNK)), NO_HASH))
      .toEqual({ ok: true, value: { kind: "incomplete", received: CHUNK } });
    expect(await uploads.append(id, BUCKET, { start: CHUNK * 2, size: 5, total: data.length }, stream(data.subarray(CHUNK * 2)), NO_HASH))
      .toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(put).not.toHaveBeenCalled();
    await uploads.append(id, BUCKET, { start: CHUNK, size: CHUNK, total: null }, stream(data.subarray(CHUNK, CHUNK * 2)), NO_HASH);
    const done = await uploads.append(id, BUCKET, { start: CHUNK * 2, size: 5, total: data.length }, stream(data.subarray(CHUNK * 2)), NO_HASH);
    expect(done).toMatchObject({ ok: true, value: { kind: "committed" } });
    if (done.ok && done.value.kind === "committed") expect(hex(done.value.info.hashes!.md5)).toBe(md5Hex(data));
  });

  test("a chunk shorter than its Content-Range is invalid and the session does not move", async () => {
    const f = await uploadFixture();
    const id = await begin(f);
    const { uploads } = f.as("cred-a");
    expect(await uploads.append(id, BUCKET, { start: 0, size: CHUNK, total: null }, stream(bytesOf(10)), NO_HASH))
      .toEqual({ ok: false, error: { code: "invalid", message: "The chunk does not match its Content-Range." } });
    expect(await uploads.status(id, BUCKET)).toEqual({ ok: true, value: { kind: "incomplete", received: 0 } });
  });

  test("only the credential that began a session continues it, and only on its bucket", async () => {
    const f = await uploadFixture();
    const id = await begin(f);
    const other = f.as("cred-b").uploads;
    expect(await other.append(id, BUCKET, { start: 0, size: 3, total: 3 }, stream(bytesOf(3)), NO_HASH))
      .toEqual({ ok: false, error: { code: "forbidden" } });
    expect(await other.status(id, BUCKET)).toEqual({ ok: false, error: { code: "forbidden" } });
    expect(await f.as("cred-a").uploads.status(id, "other-bucket")).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await f.as("cred-a").uploads.status("nope", BUCKET)).toEqual({ ok: false, error: { code: "no_such_upload" } });
    expect(await f.staged()).toEqual([]);
  });

  test("a resumable overwrite adds a version at a higher generation", async () => {
    const f = await uploadFixture();
    const first = await sendAll(f, await begin(f), bytesOf(CHUNK + 1, 1));
    const second = await sendAll(f, await begin(f), bytesOf(CHUNK + 2, 2));
    if (!first.ok || first.value.kind !== "committed" || !second.ok || second.value.kind !== "committed") throw new Error("not committed");
    expect(second.value.info.generation).toBeGreaterThan(first.value.info.generation);
    expect(f.assets()).toHaveLength(1);
    expect(f.versions()).toHaveLength(1);
  });

  test("a final chunk resent after the commit answers the same object", async () => {
    const f = await uploadFixture();
    const data = bytesOf(CHUNK + 7);
    const id = await begin(f);
    const done = await sendAll(f, id, data);
    const final = { start: CHUNK, size: 7, total: data.length };
    expect(await f.as("cred-a").uploads.append(id, BUCKET, final, stream(data.subarray(CHUNK)), NO_HASH)).toEqual(done);
    expect(f.assets()).toHaveLength(1);
  });
});

describe("a commit replayed after a crash", () => {
  type Crash = (f: Fixture) => void;
  const CRASH = new Error("simulated crash");

  test.each<[string, boolean, Crash]>([
    ["after the asset row, before the binding", false, (f) => { vi.spyOn(f.compat, "bind").mockRejectedValueOnce(CRASH); }],
    ["after the new version, before its hashes", true, (f) => { vi.spyOn(f.compat, "putRecord").mockRejectedValueOnce(CRASH); }],
  ])("%s finds one asset and one version at most", async (_, overwrite, crash) => {
    const f = await uploadFixture();
    if (overwrite) await sendAll(f, await begin(f), bytesOf(CHUNK + 1, 9));
    const data = bytesOf(CHUNK * 2 + 3);
    const id = await begin(f);
    crash(f);
    await expect(sendAll(f, id, data)).rejects.toThrow(CRASH);
    expect((await f.compat.findUpload(id as UploadId))?.phase).toMatchObject(overwrite ? { state: "published" } : { state: "committing", owner: null });
    vi.restoreAllMocks();

    const { uploads } = f.as("cred-a");
    const replay = await uploads.append(id, BUCKET, { start: CHUNK * 2, size: 3, total: data.length }, stream(data.subarray(CHUNK * 2)), NO_HASH);
    if (!replay.ok || replay.value.kind !== "committed") throw new Error(JSON.stringify(replay));
    expect(hex(replay.value.info.hashes!.md5)).toBe(md5Hex(data));
    expect(f.assets()).toHaveLength(1);
    expect(f.versions()).toHaveLength(overwrite ? 1 : 0);
    expect(await f.as("cred-a").layer.head(BUCKET, "big.bin" as ObjectKey)).toEqual({ ok: true, value: replay.value.info });
  });
});

describe("sweepUploads", () => {
  test("drops expired sessions with their staged chunks, and stale claims", async () => {
    const f = await uploadFixture();
    const old = await begin(f, "old.bin");
    await f.as("cred-a").uploads.append(old, BUCKET, { start: 0, size: 3, total: null }, stream(bytesOf(3)), NO_HASH);
    f.advance(UPLOAD_TTL_MS / 2);
    const fresh = await begin(f, "fresh.bin");
    await f.compat.claim(BUCKET as BucketName, "claimed.bin" as ObjectKey, "object", 0, -1);
    f.advance(UPLOAD_TTL_MS / 2 + 1);

    expect(await f.as("cred-a").uploads.append(old, BUCKET, { start: 3, size: 3, total: null }, stream(bytesOf(3)), NO_HASH))
      .toEqual({ ok: false, error: { code: "no_such_upload" } });
    const swept = await sweepUploads(f.deps, 1_000_000 + UPLOAD_TTL_MS + 1);
    expect(swept).toEqual({ sessions: 1, claims: 1, leases: 0 });
    expect(f.pending).toEqual([`compat-staging/${old}/`]);
    expect(await f.compat.findUpload(old as UploadId)).toBeNull();
    expect(await f.compat.findUpload(fresh as UploadId)).not.toBeNull();
    expect(f.compat.bindings.size).toBe(0);
  });
});
