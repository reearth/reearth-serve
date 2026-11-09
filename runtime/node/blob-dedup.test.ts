// Workspace-scoped deduplication (ADR-017 §4, phase P3) end to end on the
// Node runtime: the real routes, SQLite ledger and the in-memory object store.
// Uploads here are demo uploads, so their scope is `_demo`.
//
// Presigned sessions use the same stand-in generator as the P2 suite; it
// records every call so a test can show that a reusing session touched no
// storage API.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { PresignedUrlGenerator } from "../../core/asset/repository";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { EMPTY_SHA256 } from "../../core/asset/integrity";
import { BLOB_UNAVAILABLE_MESSAGE } from "../../core/blob/usecase";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let presigned: PresignedUrlGenerator;
let sessionId: string;
let uploaded: string;

const storage = () => runtime.deps.storage as MemoryFileStorage;

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
    expect(await runtime.deps.blobRefs.find(`blobs/_demo/${sha256(body)}`)).toMatchObject({ refCount: 2 });
    expect(await (await call("GET", `/files/${second.asset.id}/a.txt`)).text()).toBe("same content twice");
  });

  test("a body that does not match the declaration is 422, as without deduplication", async () => {
    const body = bytes("genuine");
    await uploadDeclared("a.txt", body);
    const res = await upload("/api/v1/assets", bytes("forgery"), "a.txt", { "X-Content-SHA256": sha256(body) });
    expect(res.status).toBe(422);
  });

  test("Content-Length: 0 with the hash creates the asset and a version without transfer", async () => {
    const body = bytes("transfer me once");
    const first = await uploadDeclared("data.txt", body);

    const viaHash = await upload("/api/v1/assets", new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256(body) });
    expect(viaHash.status).toBe(201);
    const json = (await viaHash.json()) as UploadJson;
    expect(comparable(json)).toEqual(comparable(first));
    expect(await (await call("GET", `/files/${json.asset.id}/data.txt`)).text()).toBe("transfer me once");

    const version = await upload(`/api/v1/assets/${first.asset.id}`, new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256(body) });
    expect(version.status).toBe(201);
    const v = (await version.json()) as { version: { id: string; size: number; integrity: string } };
    expect(v.version).toMatchObject({ size: body.byteLength, integrity: "verified" });
    expect(await (await call("GET", `/files/${v.version.id}/data.txt`)).text()).toBe("transfer me once");
  });

  test("Content-Length: 0 naming bytes this workspace does not hold is 422, the natural answer for an empty body", async () => {
    const res = await upload("/api/v1/assets", new Uint8Array(0), "data.txt", { "X-Content-SHA256": sha256("never uploaded") });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("Declared SHA-256 does not match the uploaded bytes; nothing was stored");
    expect(await runtime.deps.blobRefs.find(`blobs/_demo/${sha256("never uploaded")}`)).toBeNull();
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
    expect(await runtime.deps.blobRefs.reserve({ key: `blobs/_demo/${sha256(body)}`, scope: "_demo", sha256: sha256(body) }, Date.now())).toBe(true);
    const put = vi.spyOn(storage(), "put");
    await uploadDeclared("a.txt", body);
    expect(put).toHaveBeenCalledOnce();
  });
});

describe("presigned sessions for bytes already stored", () => {
  test("the session has no parts, touches no storage API, and complete creates a verified asset", async () => {
    const body = bytes("already here, presigned");
    const first = await uploadDeclared("data.txt", body);

    const created = await call("POST", "/api/v1/assets/uploads", {
      filename: "data.txt", contentType: "text/plain", size: body.byteLength, sha256: sha256(body),
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as Record<string, unknown> & { uploadId: string };
    expect(Object.keys(session).sort()).toEqual(["expiresAt", "parts", "uploadId"]);
    expect(session.parts).toEqual([]);
    for (const fn of Object.values(presigned)) expect(fn).not.toHaveBeenCalled();

    const verificationSend = vi.spyOn(runtime.deps.extractionQueue!, "send");
    const done = await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`);
    expect(done.status).toBe(201);
    const json = (await done.json()) as UploadJson;
    expect(json.asset).toMatchObject({
      id: session.uploadId, sha256: sha256(body), integrity: "verified", size: body.byteLength, contentType: "text/plain",
    });
    expect(verificationSend).not.toHaveBeenCalled();
    expect(first.asset).not.toHaveProperty("blobKey");
    expect(await runtime.deps.blobRefs.find(`blobs/_demo/${sha256(body)}`)).toMatchObject({ refCount: 2, state: "ready" });
    expect(await (await call("GET", `/files/${session.uploadId}/data.txt`)).text()).toBe("already here, presigned");
  });

  test("a multipart request gets the same empty-parts session, completed with { parts: [] }", async () => {
    const body = bytes("multipart duplicate");
    await uploadDeclared("data.bin", body);
    const created = await call("POST", "/api/v1/assets/uploads", {
      filename: "data.bin", contentType: "application/octet-stream", size: body.byteLength, partCount: 3, sha256: sha256(body),
    });
    const session = (await created.json()) as { uploadId: string; parts: unknown[] };
    expect(session.parts).toEqual([]);
    const done = await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`, { parts: [] });
    expect(done.status).toBe(201);
  });

  test("a session the server compresses reuses gzip bytes and records the encoding it told the client", async () => {
    const raw = bytes(JSON.stringify({ features: "x".repeat(4000) }));
    const gz = new Uint8Array(gzipSync(raw));
    const direct = await upload("/api/v1/assets", gz, "a.json", {
      "Content-Type": "application/json", "Content-Encoding": "gzip", "X-Original-Size": String(raw.byteLength), "X-Content-SHA256": sha256(gz),
    });
    expect(direct.status).toBe(201);
    const first = (await direct.json()) as UploadJson;

    const created = await call("POST", "/api/v1/assets/uploads", {
      filename: "a.json", contentType: "application/json", size: raw.byteLength, sha256: sha256(gz),
    });
    const session = (await created.json()) as { uploadId: string; parts: unknown[]; contentEncoding?: string };
    expect(session).toMatchObject({ parts: [], contentEncoding: "gzip" });
    const done = (await (await call("POST", `/api/v1/assets/uploads/${session.uploadId}/complete`)).json()) as UploadJson;
    expect(comparable(done)).toEqual(comparable(first));
  });

  test("a session the server compresses does not reuse bytes that are not gzip; it uploads instead", async () => {
    const raw = bytes(JSON.stringify({ features: "y".repeat(4000) }));
    await upload("/api/v1/assets", raw, "raw.json", { "Content-Type": "application/json", "X-Content-SHA256": sha256(raw) });

    // A client that hashed the raw file although the server will tell it to gzip.
    const created = await call("POST", "/api/v1/assets/uploads", {
      filename: "raw.json", contentType: "application/json", size: raw.byteLength, sha256: sha256(raw),
    });
    const session = (await created.json()) as { uploadId: string; url?: string; contentEncoding?: string };
    expect(session.contentEncoding).toBe("gzip");
    expect(session.url).toContain(`assets/${session.uploadId}/raw.json`);
  });

  test("the bytes going away before complete: 409, and the session is spent", async () => {
    const body = bytes("gone before complete");
    const first = await uploadDeclared("data.txt", body);
    const created = await call("POST", "/api/v1/assets/uploads", {
      filename: "data.txt", contentType: "text/plain", size: body.byteLength, sha256: sha256(body),
    });
    const { uploadId } = (await created.json()) as { uploadId: string };
    expect((await call("DELETE", `/api/v1/assets/${first.asset.id}`)).status).toBe(204);

    const done = await call("POST", `/api/v1/assets/uploads/${uploadId}/complete`);
    expect(done.status).toBe(409);
    expect(((await done.json()) as { error: string }).error).toBe(BLOB_UNAVAILABLE_MESSAGE);
    expect(await runtime.deps.metadata.find(uploadId)).toBeNull();
    expect((await call("POST", `/api/v1/assets/uploads/${uploadId}/complete`)).status).toBe(404);

    // A new session uploads the bytes in full.
    const again = await call("POST", "/api/v1/assets/uploads", {
      filename: "data.txt", contentType: "text/plain", size: body.byteLength, sha256: sha256(body),
    });
    expect(((await again.json()) as { url?: string }).url).toBeDefined();
  });

  test("a blob still verifying is not reused: the session gets an upload URL for its own key", async () => {
    uploaded = "verifying, not reusable";
    const declared = sha256(uploaded);
    const first = (await (await call("POST", "/api/v1/assets/uploads", {
      filename: "a.bin", contentType: "application/octet-stream", size: uploaded.length, partCount: 2, sha256: declared,
    })).json()) as { uploadId: string };
    expect((await call("POST", `/api/v1/assets/uploads/${first.uploadId}/complete`, {
      parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }],
    })).status).toBe(201);
    expect(await runtime.deps.blobRefs.find(`blobs/_demo/${declared}`)).toMatchObject({ state: "verifying" });

    const second = (await (await call("POST", "/api/v1/assets/uploads", {
      filename: "b.bin", contentType: "application/octet-stream", size: uploaded.length, sha256: declared,
    })).json()) as { uploadId: string; url: string };
    expect(second.url).toContain(`assets/${second.uploadId}/b.bin`);
  });
});
