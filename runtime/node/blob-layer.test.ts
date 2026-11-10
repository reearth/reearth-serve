// The blob layer (ADR-017 §3, §5; phase P2 as amended by the post-review
// change) end to end on the Node runtime: the real routes, SQLite ledger and
// the in-memory object store. Uploads here are demo uploads, scoped to their
// anonymous session (`_demo_{sessionId}`).
//
// Presigned sessions use the same stand-in generator as the P1b suite: its
// "completed upload" writes the simulated client's bytes straight into the
// store, at whatever key the session was issued for.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { PresignedUrlGenerator } from "../../core/asset/repository";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { BLOB_GRACE_MS } from "../../core/blob/model";
import { sweepBlobs } from "../../core/blob/usecase";
import { SubrequestBudget } from "../../core/cleanup/usecase";
import { extractionMessageForJob } from "../../core/extraction/handler";
import { buildNodeRuntime, type NodeRuntime } from "./deps";
import { runCron } from "./cron";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let sessionId: string;
let uploaded: string;

const storage = () => runtime.deps.storage as MemoryFileStorage;
/** Demo uploads (no project) are scoped to their anonymous session. */
const demoPrefix = () => `blobs/_demo_${sessionId}/`;
const blobKeys = async () => (await storage().list("blobs/")).keys;

function fakePresigned(store: MemoryFileStorage): PresignedUrlGenerator {
  return {
    generatePutUrl: async (key) => ({ url: `https://store.example/${key}`, headers: {} }),
    createMultipartUpload: async () => "mp-1",
    generateUploadPartUrl: async (key, _id, part) => `https://store.example/${key}?part=${part}`,
    completeMultipartUpload: async (key) => {
      await store.put(key, new Blob([uploaded]).stream(), "application/octet-stream", uploaded.length);
    },
    abortMultipartUpload: async () => {},
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
    "Content-Type": "application/octet-stream", "Content-Length": String(body.byteLength), "X-Filename": filename, ...headers,
  });
}

async function uploadDeclared(filename: string, body: Uint8Array, contentType = "application/octet-stream") {
  const res = await upload("/api/v1/assets", body, filename, { "X-Content-SHA256": sha256(body), "Content-Type": contentType });
  expect(res.status).toBe(201);
  return (await res.json()) as { asset: Record<string, unknown> & { id: string }; url: string };
}

/** Create a presigned session (multipart unless `single`), returning the response. */
function createSession(filename: string, declared: string, single = false): Promise<Response> {
  return call("POST", "/api/v1/assets/uploads", {
    filename, contentType: "application/octet-stream", size: uploaded.length,
    ...(single ? {} : { partCount: 2 }), sha256: declared,
  });
}

async function complete(uploadId: string): Promise<Response> {
  return call("POST", `/api/v1/assets/uploads/${uploadId}/complete`, {
    parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }],
  });
}

beforeEach(async () => {
  runtime = buildNodeRuntime({ ANONYMOUS_UPLOAD_ENABLED: "true" });
  runtime.deps.presignedUrls = fakePresigned(storage());
  app = createApp(runtime.deps);
  sessionId = "";
  uploaded = "";
  const seed = await upload("/api/v1/assets", bytes("seed"), "seed.txt");
  expect(seed.status).toBe(201);
  sessionId = seed.headers.get("X-Session-Id")!;
});

describe("direct uploads", () => {
  test("a declared upload is stored at its blob key and served at the usual URL", async () => {
    const body = bytes("declared bytes");
    const { asset, url } = await uploadDeclared("data.bin", body);

    expect(await blobKeys()).toEqual([`${demoPrefix()}${sha256(body)}`]);
    expect((await storage().list(`assets/${asset.id}/`)).keys).toEqual([]);
    expect(url).toBe(`http://localhost:8788/files/${asset.id}/data.bin`);

    const file = await call("GET", `/files/${asset.id}/data.bin`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("declared bytes");
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256(body));
  });

  test("the storage key never appears in the API", async () => {
    const { asset } = await uploadDeclared("data.bin", bytes("hidden"));
    expect(asset).not.toHaveProperty("blobKey");
    const read = (await (await call("GET", `/api/v1/assets/${asset.id}`)).json()) as { asset: object };
    expect(read.asset).not.toHaveProperty("blobKey");
    const list = (await (await call("GET", "/api/v1/assets")).json()) as { assets: object[] };
    for (const a of list.assets) expect(a).not.toHaveProperty("blobKey");

    const v = await upload(`/api/v1/assets/${asset.id}`, bytes("v2"), "data.bin", { "X-Content-SHA256": sha256("v2") });
    const { version } = (await v.json()) as { version: { id: string } };
    expect(version).not.toHaveProperty("blobKey");
    const vread = (await (await call("GET", `/api/v1/assets/${asset.id}/versions/${version.id}`)).json()) as { version: object };
    expect(vread.version).not.toHaveProperty("blobKey");
  });

  test("an undeclared upload keeps the classic key", async () => {
    const res = await upload("/api/v1/assets", bytes("plain"), "plain.bin");
    const { asset } = (await res.json()) as { asset: { id: string } };
    expect((await storage().list(`assets/${asset.id}/`)).keys).toEqual([`assets/${asset.id}/plain.bin`]);
    expect(await blobKeys()).toEqual([]);
  });

  test("two assets with the same bytes share one blob; deleting one leaves the other serving", async () => {
    const body = bytes("shared bytes");
    const a = await uploadDeclared("a.bin", body);
    const b = await uploadDeclared("b.bin", body);
    const key = `${demoPrefix()}${sha256(body)}`;
    expect(await blobKeys()).toEqual([key]);
    expect(await runtime.deps.blobRefs.find(key)).toMatchObject({ refCount: 2 });

    expect((await call("DELETE", `/api/v1/assets/${a.asset.id}`)).status).toBe(204);
    expect(await blobKeys()).toEqual([key]);
    expect(await runtime.deps.blobRefs.find(key)).toMatchObject({ refCount: 1 });
    const file = await call("GET", `/files/${b.asset.id}/b.bin`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("shared bytes");

    // The last reference goes; the bytes stay through the grace period, then go.
    expect((await call("DELETE", `/api/v1/assets/${b.asset.id}`)).status).toBe(204);
    expect(await blobKeys()).toEqual([key]);
    const deps = { blobRefs: runtime.deps.blobRefs, storage: storage(), cache: runtime.deps.cache };
    await sweepBlobs(deps, new SubrequestBudget(1000), Date.now() + BLOB_GRACE_MS - 60_000);
    expect(await blobKeys()).toEqual([key]);
    await sweepBlobs(deps, new SubrequestBudget(1000), Date.now() + BLOB_GRACE_MS + 60_000);
    expect(await blobKeys()).toEqual([]);
  });

  test("two versions sharing a blob: deleting one keeps the bytes for the other", async () => {
    const first = await uploadDeclared("data.bin", bytes("v1"));
    const id = first.asset.id;
    const body = bytes("same version bytes");
    const versionIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await upload(`/api/v1/assets/${id}`, body, "data.bin", { "X-Content-SHA256": sha256(body) });
      expect(res.status).toBe(201);
      versionIds.push(((await res.json()) as { version: { id: string } }).version.id);
    }
    const key = `${demoPrefix()}${sha256(body)}`;
    expect(await runtime.deps.blobRefs.find(key)).toMatchObject({ refCount: 2 });

    expect((await call("DELETE", `/api/v1/assets/${id}/versions/${versionIds[1]}`)).status).toBe(204);
    expect(await runtime.deps.blobRefs.find(key)).toMatchObject({ refCount: 1 });
    const pinned = await call("GET", `/files/${versionIds[0]}/data.bin`);
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toBe("same version bytes");
  });

  test("a demo upload that expires releases its blob through the same delete", async () => {
    const body = bytes("short-lived");
    const { asset } = await uploadDeclared("data.bin", body);
    const key = `${demoPrefix()}${sha256(body)}`;
    await runtime.deps.metadata.update(asset.id, { expiresAt: Date.now() - 1000 });

    await runCron(runtime);

    expect(await runtime.deps.metadata.find(asset.id)).toBeNull();
    expect(await runtime.deps.blobRefs.find(key)).toMatchObject({ refCount: 0 });
  });

  test("extraction and thumbnail messages carry the blob key", async () => {
    const extraction = vi.spyOn(runtime.deps.extractionQueue!, "send");
    const thumbnail = vi.spyOn(runtime.deps.thumbnailQueue!, "send");

    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    const archive = await uploadDeclared("site.zip", zip, "application/zip");
    expect(extraction).toHaveBeenCalledWith(expect.objectContaining({ assetId: archive.asset.id, archiveKey: `${demoPrefix()}${sha256(zip)}` }));

    // The same bytes as a new version: its run reads the blob too, now and on a retry.
    const v = await upload(`/api/v1/assets/${archive.asset.id}`, zip, "site.zip", { "X-Content-SHA256": sha256(zip) });
    const { version } = (await v.json()) as { version: { id: string; jobId: string } };
    expect(extraction).toHaveBeenLastCalledWith(expect.objectContaining({ versionId: version.id, archiveKey: `${demoPrefix()}${sha256(zip)}` }));
    const job = (await runtime.deps.jobs.find(version.jobId))!;
    expect(await extractionMessageForJob(job, runtime.deps.metadata, runtime.deps.versions))
      .toMatchObject({ archiveKey: `${demoPrefix()}${sha256(zip)}` });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    await uploadDeclared("pic.png", png, "image/png");
    expect(thumbnail).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: `${demoPrefix()}${sha256(png)}` }));
  });
});

describe("demo scopes", () => {
  test("two anonymous sessions uploading the same declared bytes get different blobs, and the second reuses nothing of the first", async () => {
    const body = bytes("the same demo bytes");
    const a = await uploadDeclared("a.bin", body);
    const keyA = `${demoPrefix()}${sha256(body)}`;

    // A second anonymous session.
    const other = await call("POST", "/api/v1/assets", bytes("other seed"), {
      "Content-Type": "application/octet-stream", "Content-Length": "10", "X-Filename": "seed.txt", "X-Session-Id": "",
    });
    const sessionB = other.headers.get("X-Session-Id")!;
    expect(sessionB).not.toBe(sessionId);
    const put = vi.spyOn(storage(), "put");
    sessionId = sessionB;
    const b = await uploadDeclared("b.bin", body);
    const keyB = `${demoPrefix()}${sha256(body)}`;

    expect(keyB).not.toBe(keyA);
    // B wrote its own copy: nothing of A's was looked up as reusable.
    expect(put).toHaveBeenCalledWith(keyB, expect.anything(), expect.anything(), body.byteLength, expect.anything());
    expect(await runtime.deps.blobRefs.find(keyA)).toMatchObject({ refCount: 1 });
    expect(await runtime.deps.blobRefs.find(keyB)).toMatchObject({ refCount: 1 });
    expect(Object.keys(b.asset).sort()).toEqual(Object.keys(a.asset).sort());
  });
});

describe("presigned sessions", () => {
  test("a declared session uploads to its own classic key; a concurrent one for the same bytes does too, with no 409", async () => {
    uploaded = "multipart bytes";
    const declared = sha256(uploaded);
    const first = await createSession("data.bin", declared);
    expect(first.status).toBe(201);
    const { uploadId, parts } = (await first.json()) as { uploadId: string; parts: { url: string }[] };
    expect(parts[0].url).toContain(`assets/${uploadId}/data.bin`);

    const second = await createSession("other.bin", declared);
    expect(second.status).toBe(201);
    const secondJson = (await second.json()) as { uploadId: string; parts: { url: string }[] };
    expect(secondJson.parts[0].url).toContain(`assets/${secondJson.uploadId}/other.bin`);
    const single = await createSession("third.bin", declared, true);
    expect(single.status).toBe(201);
    expect(((await single.json()) as { url: string }).url).toContain("/assets/");

    // Sessions take no claim on the blob key.
    expect(await runtime.deps.blobRefs.find(`${demoPrefix()}${declared}`)).toBeNull();

    expect((await complete(uploadId)).status).toBe(201);
    expect(await blobKeys()).toEqual([]);
    const file = await call("GET", `/files/${uploadId}/data.bin`);
    expect(await file.text()).toBe("multipart bytes");
  });

  test("the verification job reads the classic key; with nothing to adopt the row stays there, verified", async () => {
    uploaded = "verify me";
    const send = vi.spyOn(runtime.deps.extractionQueue!, "send");
    const created = (await (await createSession("data.bin", sha256(uploaded))).json()) as { uploadId: string };
    expect((await complete(created.uploadId)).status).toBe(201);
    const key = `assets/${created.uploadId}/data.bin`;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: "integrity-verification", objectKey: key }));

    await runCron(runtime);

    const asset = await runtime.deps.metadata.find(created.uploadId);
    expect(asset).toMatchObject({ integrity: "verified", sha256: sha256(uploaded) });
    expect(asset).not.toHaveProperty("blobKey");
    expect(await storage().head(key)).not.toBeNull();
  });

  test("an archive's extraction reads the classic key", async () => {
    uploaded = "PK not really a zip";
    const send = vi.spyOn(runtime.deps.extractionQueue!, "send");
    const created = (await (await createSession("site.zip", sha256(uploaded))).json()) as { uploadId: string };
    expect((await complete(created.uploadId)).status).toBe(201);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      jobId: created.uploadId, archiveKey: `assets/${created.uploadId}/site.zip`,
    }));
  });
});
