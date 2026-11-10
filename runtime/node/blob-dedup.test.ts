// Workspace-scoped deduplication (ADR-017 §4, phase P3 as amended by the
// post-review change) end to end on the Node runtime: the real routes, SQLite
// ledger and the in-memory object store. Uploads here are demo uploads, so
// their scope is their anonymous session's (`_demo_{sessionId}`).
//
// The rule under test: deduplication is never visible to the uploader. Every
// upload sends its whole body; a session always gets upload URLs for its own
// key; a duplicate is noticed only after the bytes are confirmed, and then
// changes nothing but where the row's bytes are stored.
//
// Presigned sessions use the same stand-in generator as the P2 suite. A
// single PUT is simulated by writing the client's bytes at the URL's key; a
// multipart upload's completion writes `uploaded` at its key.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { PresignedUrlGenerator } from "../../core/asset/repository";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { EMPTY_SHA256 } from "../../core/asset/integrity";
import { BLOB_GRACE_MS } from "../../core/blob/model";
import { sweepBlobs } from "../../core/blob/usecase";
import { SubrequestBudget } from "../../core/cleanup/usecase";
import { runCron } from "./cron";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let presigned: PresignedUrlGenerator;
let sessionId: string;
let uploaded: string;

const storage = () => runtime.deps.storage as MemoryFileStorage;
const blobKeyOf = (body: Uint8Array | string) => `blobs/_demo_${sessionId}/${sha256(body)}`;

function fakePresigned(store: MemoryFileStorage): PresignedUrlGenerator {
  return {
    generatePutUrl: vi.fn(async (key: string) => ({ url: `https://store.example/${key}`, headers: {} })),
    createMultipartUpload: vi.fn(async () => "mp-1"),
    generateUploadPartUrl: vi.fn(async (key: string, _id: string, part: number) => `https://store.example/${key}?part=${part}`),
    completeMultipartUpload: vi.fn(async (key: string) => {
      await store.put(key, new Blob([uploaded]).stream(), "application/octet-stream", uploaded.length);
    }),
    abortMultipartUpload: vi.fn(async () => {}),
  };
}

async function call(method: string, path: string, body?: Uint8Array | object, headers: Record<string, string> = {}): Promise<Response> {
  const json = body !== undefined && !(body instanceof Uint8Array);
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined && { body: json ? JSON.stringify(body) : body as BodyInit }),
    headers: {
      ...(json && { "Content-Type": "application/json" }),
      ...(sessionId && { "X-Session-Id": sessionId }),
      ...headers,
    },
  }));
}

function upload(path: string, body: Uint8Array, filename: string, headers: Record<string, string> = {}): Promise<Response> {
  return call("POST", path, body, {
    "Content-Type": "text/plain", "Content-Length": String(body.byteLength), "X-Filename": filename, ...headers,
  });
}

type UploadJson = { asset: Record<string, unknown> & { id: string }; url: string };

async function uploadDeclared(filename: string, body: Uint8Array): Promise<UploadJson> {
  const res = await upload("/api/v1/assets", body, filename, { "X-Content-SHA256": sha256(body) });
  expect(res.status).toBe(201);
  return (await res.json()) as UploadJson;
}

/** Everything in an upload response but identity and time. */
function comparable(json: UploadJson) {
  const { id: _id, createdAt: _c, expiresAt: _e, ...asset } = json.asset;
  return { keys: Object.keys(json).sort(), asset, path: new URL(json.url).pathname.split("/").slice(3).join("/") };
}

beforeEach(async () => {
  runtime = buildNodeRuntime({ ANONYMOUS_UPLOAD_ENABLED: "true" });
  presigned = fakePresigned(storage());
  runtime.deps.presignedUrls = presigned;
  app = createApp(runtime.deps);
  sessionId = "";
  uploaded = "";
  const seed = await upload("/api/v1/assets", bytes("seed"), "seed.txt");
  expect(seed.status).toBe(201);
  sessionId = seed.headers.get("X-Session-Id")!;
});

describe("direct uploads of bytes already stored", () => {
  test("the response is the same as for the first upload, and the bytes are stored once", async () => {
    const body = bytes("same content twice");
    const put = vi.spyOn(storage(), "put");
    const first = await uploadDeclared("a.txt", body);
    const second = await uploadDeclared("a.txt", body);

    expect(put).toHaveBeenCalledOnce();
    expect(comparable(second)).toEqual(comparable(first));
    expect(second.asset).toMatchObject({ integrity: "verified", sha256: sha256(body), size: body.byteLength });
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 2 });
    expect(await (await call("GET", `/files/${second.asset.id}/a.txt`)).text()).toBe("same content twice");
  });

  test("a body that does not match the declaration is 422, as without deduplication", async () => {
    const body = bytes("genuine");
    await uploadDeclared("a.txt", body);
    const res = await upload("/api/v1/assets", bytes("forgery"), "a.txt", { "X-Content-SHA256": sha256(body) });
    expect(res.status).toBe(422);
  });

  test("Content-Length: 0 with the hash of stored bytes is 422 for an asset and for a version: there is no hash-only upload", async () => {
    const body = bytes("transfer me every time");
    const first = await uploadDeclared("data.txt", body);
    const find = vi.spyOn(runtime.deps.blobRefs, "find");

    const viaHash = await upload("/api/v1/assets", new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256(body) });
    expect(viaHash.status).toBe(422);
    expect(await viaHash.json()).toMatchObject({ code: "checksum_mismatch" });
    const version = await upload(`/api/v1/assets/${first.asset.id}`, new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256(body) });
    expect(version.status).toBe(422);
    // The answer was decided without looking at what the scope holds.
    expect(find).not.toHaveBeenCalled();
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 1 });
  });

  test("Content-Length: 0 naming bytes this workspace does not hold is 422, the natural answer for an empty body", async () => {
    const res = await upload("/api/v1/assets", new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256("never uploaded") });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("Declared SHA-256 does not match the uploaded bytes; nothing was stored");
    expect(await runtime.deps.blobRefs.find(blobKeyOf("never uploaded"))).toBeNull();
  });

  test("Content-Length: 0 with the empty-string hash uploads an empty file", async () => {
    const res = await upload("/api/v1/assets", new Uint8Array(0), "empty.txt", { "X-Content-SHA256": EMPTY_SHA256 });
    expect(res.status).toBe(201);
    const { asset } = (await res.json()) as UploadJson;
    expect(asset).toMatchObject({ size: 0, sha256: EMPTY_SHA256, integrity: "verified" });
    const file = await call("GET", `/files/${asset.id}/empty.txt`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("");
  });

  test("Content-Length: 0 without a hash is still refused", async () => {
    const res = await upload("/api/v1/assets", new Uint8Array(0), "data.txt");
    expect(res.status).toBe(400);
  });

  test("a ready blob nothing references is written, not reused", async () => {
    const body = bytes("reserved, never landed");
    expect(await runtime.deps.blobRefs.reserve({ key: blobKeyOf(body), scope: `_demo_${sessionId}`, sha256: sha256(body) }, Date.now())).toBe(true);
    const put = vi.spyOn(storage(), "put");
    await uploadDeclared("a.txt", body);
    expect(put).toHaveBeenCalledOnce();
  });
});

type Session = Record<string, unknown> & { uploadId: string; url?: string; parts?: { partNumber: number; url: string }[] };

function createSession(filename: string, body: Uint8Array | string, partCount?: number): Promise<Response> {
  return call("POST", "/api/v1/assets/uploads", {
    filename, contentType: "text/plain", size: typeof body === "string" ? body.length : body.byteLength,
    ...(partCount && { partCount }), sha256: sha256(body), contentEncoding: "identity",
  });
}

/** The client's single PUT: its bytes land at the key the URL names (the store verifies the checksum). */
async function putAsClient(session: Session, body: Uint8Array<ArrayBuffer>): Promise<void> {
  const key = decodeURIComponent(new URL(session.url!).pathname.slice(1));
  await storage().put(key, new Blob([body]).stream(), "text/plain", body.byteLength, { sha256: sha256(body) });
}

/** Create, upload and complete a single-PUT session; returns the session and the completion. */
async function sessionUpload(filename: string, body: Uint8Array<ArrayBuffer>): Promise<{ session: Session; done: Response }> {
  const created = await createSession(filename, body);
  expect(created.status).toBe(201);
  const session = (await created.json()) as Session;
  await putAsClient(session, body);
  return { session, done: await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`) };
}

/** A session response with identity and time removed, and its URL reduced to the shape of its key. */
function sessionShape(s: Session) {
  const { uploadId, expiresAt: _e, url, parts, ...rest } = s;
  const shape = (u: string) => new URL(u).pathname.replace(uploadId, "{id}");
  return { ...rest, keys: Object.keys(s).sort(), ...(url && { url: shape(url) }), ...(parts && { parts: parts.map((p) => shape(p.url)) }) };
}

describe("presigned sessions for bytes already stored", () => {
  test("a session gets real upload URLs for its own key, exactly as for bytes the scope does not hold", async () => {
    const body = bytes("already here, presigned");
    const fresh = (await (await createSession("data.txt", bytes("not stored anywhere"))).json()) as Session;
    const freshMulti = (await (await createSession("data.txt", bytes("not stored anywhere"), 3)).json()) as Session;
    await uploadDeclared("data.txt", body);

    const dup = (await (await createSession("data.txt", body)).json()) as Session;
    const dupMulti = (await (await createSession("data.txt", body, 3)).json()) as Session;
    expect(sessionShape(dup)).toEqual(sessionShape(fresh));
    expect(sessionShape(dupMulti)).toEqual(sessionShape(freshMulti));
    expect(dup.url).toContain(`/assets/${dup.uploadId}/data.txt`);
    expect(dupMulti.parts).toHaveLength(3);
    // Nothing about the blob was claimed or touched.
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 1 });
  });

  test("completion confirmed by the store adopts the blob: same response, classic object retired until the grace sweep", async () => {
    const body = bytes("adopt me at completion");
    // Without anything to adopt: the scope has no blob of these bytes yet.
    const plain = await sessionUpload("data.txt", body);
    expect(plain.done.status).toBe(201);
    const plainJson = (await plain.done.json()) as UploadJson;
    expect(await runtime.deps.metadata.find(plainJson.asset.id)).not.toHaveProperty("blobKey");

    // A direct upload puts the bytes in the blob layer; the next session adopts them.
    await uploadDeclared("other.txt", body);
    const put = vi.spyOn(storage(), "put");
    const adopted = await sessionUpload("data.txt", body);
    expect(adopted.done.status).toBe(201);
    const adoptedJson = (await adopted.done.json()) as UploadJson;
    expect(comparable(adoptedJson)).toEqual(comparable(plainJson));
    expect(adoptedJson.asset).not.toHaveProperty("blobKey");
    expect(put).toHaveBeenCalledOnce(); // the client's own PUT, nothing more

    const id = adopted.session.uploadId;
    const classic = `assets/${id}/data.txt`;
    expect(await runtime.deps.metadata.find(id)).toMatchObject({ blobKey: blobKeyOf(body), integrity: "verified" });
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 2 });
    expect(await runtime.deps.blobRefs.find(classic)).toMatchObject({ state: "retired" });
    // Still there for a reader that resolved the classic key just before the switch.
    expect(await storage().head(classic)).not.toBeNull();
    expect(await (await call("GET", `/files/${id}/data.txt`)).text()).toBe("adopt me at completion");

    const deps = { blobRefs: runtime.deps.blobRefs, storage: storage(), cache: runtime.deps.cache };
    await sweepBlobs(deps, new SubrequestBudget(1000), Date.now() + BLOB_GRACE_MS - 60_000);
    expect(await storage().head(classic)).not.toBeNull();
    await sweepBlobs(deps, new SubrequestBudget(1000), Date.now() + BLOB_GRACE_MS + 60_000);
    expect(await storage().head(classic)).toBeNull();
    expect(await storage().head(blobKeyOf(body))).not.toBeNull();
    expect(await (await call("GET", `/files/${id}/data.txt`)).text()).toBe("adopt me at completion");
  });

  test("a multipart upload is adopted when its verification matches, with the same jobs and verdict as one that is not", async () => {
    uploaded = "multipart, adopted after verification";
    const parts = { parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }] };
    const run = async (filename: string) => {
      const session = (await (await createSession(filename, uploaded, 2)).json()) as Session;
      const done = await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`, parts);
      expect(done.status).toBe(201);
      const json = (await done.json()) as UploadJson;
      expect(json.asset).toMatchObject({ integrity: "pending" });
      await runCron(runtime);
      // What `/api/v1/jobs` would list for the asset.
      const listed = (await (await call("GET", "/api/v1/jobs")).json()) as { jobs: { assetId: string; type: string; status: string }[] };
      const jobs = listed.jobs.filter((j) => j.assetId === session.uploadId).map((j) => ({ type: j.type, status: j.status }));
      return { id: session.uploadId, json, jobs };
    };

    const plain = await run("a.txt");
    await uploadDeclared("held.txt", bytes(uploaded));
    const adopted = await run("a.txt");

    expect(comparable(adopted.json)).toEqual(comparable(plain.json));
    expect(adopted.jobs).toEqual(plain.jobs);
    expect(adopted.jobs).toEqual([{ type: "integrity-verification", status: "completed" }]);
    const plainRow = (await runtime.deps.metadata.find(plain.id))!;
    const adoptedRow = (await runtime.deps.metadata.find(adopted.id))!;
    expect(plainRow).toMatchObject({ integrity: "verified" });
    expect(plainRow).not.toHaveProperty("blobKey");
    expect(adoptedRow).toMatchObject({ integrity: "verified", blobKey: blobKeyOf(uploaded) });
    expect(await runtime.deps.blobRefs.find(`assets/${adopted.id}/a.txt`)).toMatchObject({ state: "retired" });
    expect(await (await call("GET", `/files/${adopted.id}/a.txt`)).text()).toBe(uploaded);
  });

  test("two sessions in flight for the same bytes both upload and both complete; neither gets a 409", async () => {
    const body = bytes("two at once");
    const a = (await (await createSession("a.txt", body)).json()) as Session;
    const b = (await (await createSession("b.txt", body)).json()) as Session;
    // Meanwhile the bytes land in the blob layer through a direct upload.
    await uploadDeclared("c.txt", body);
    for (const s of [a, b]) {
      await putAsClient(s, body);
      expect((await call("POST", `/api/v1/assets/uploads/${s.uploadId}/complete`)).status).toBe(201);
      expect(await runtime.deps.metadata.find(s.uploadId)).toMatchObject({ blobKey: blobKeyOf(body) });
    }
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 3 });
  });

  test("a blob that stops qualifying before the completion's write: the row stays on its own key and is served", async () => {
    const body = bytes("raced at completion");
    const holder = await uploadDeclared("held.txt", body);
    const created = (await (await createSession("data.txt", body)).json()) as Session;
    await putAsClient(created, body);

    // The lookup sees a reusable blob; then its last row is deleted and a sweep locks it.
    const find = runtime.deps.blobRefs.find.bind(runtime.deps.blobRefs);
    let raced = false;
    vi.spyOn(runtime.deps.blobRefs, "find").mockImplementation(async (key) => {
      const row = await find(key);
      if (key === blobKeyOf(body) && !raced) {
        raced = true;
        expect((await call("DELETE", `/api/v1/assets/${holder.asset.id}`)).status).toBe(204);
        await runtime.deps.blobRefs.markDeleting(key, Number.MAX_SAFE_INTEGER, Date.now());
      }
      return row;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const done = await call("POST", `/api/v1/assets/uploads/${created.uploadId}/complete`);
    warn.mockRestore();

    expect(done.status).toBe(201);
    const row = await runtime.deps.metadata.find(created.uploadId);
    expect(row).toMatchObject({ integrity: "verified", sha256: sha256(body) });
    expect(row).not.toHaveProperty("blobKey");
    expect(await runtime.deps.blobRefs.find(`assets/${created.uploadId}/data.txt`)).toBeNull();
    expect(await (await call("GET", `/files/${created.uploadId}/data.txt`)).text()).toBe("raced at completion");
  });

  test("an undeclared session is never adopted", async () => {
    const body = bytes("undeclared but stored");
    await uploadDeclared("held.txt", body);
    const created = await call("POST", "/api/v1/assets/uploads", { filename: "data.txt", contentType: "text/plain", size: body.byteLength });
    const session = (await created.json()) as Session;
    await putAsClient(session, body);
    expect((await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`)).status).toBe(201);
    expect(await runtime.deps.metadata.find(session.uploadId)).not.toHaveProperty("blobKey");
    expect(await runtime.deps.blobRefs.find(blobKeyOf(body))).toMatchObject({ refCount: 1 });
  });
});
