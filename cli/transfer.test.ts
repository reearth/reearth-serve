/**
 * The CLI's side of ADR-017 P5: what it declares, that it always sends the
 * whole file, and how it reacts to each 409. `fetch` is replaced by a scripted
 * server that records every request, so each test reads as "the server
 * answered X, the CLI then sent Y".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

vi.mock("./helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./helpers")>()),
  commonHeaders: async () => ({ "X-Session-Id": "s1" }),
  adoptSessionId: () => {},
}));

const {
  bufferSource, preparePayload, uploadDirect, uploadLargeFile,
  uploadVersionDirect, uploadViaSession,
} = await import("./transfer");
const { sha256File, EMPTY_SHA256 } = await import("./hash");

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

type Reply = { status: number; json?: unknown; headers?: Record<string, string> };

/** A fake server: `respond` sees each request and answers it; all requests are kept. */
function fakeServer(respond: (req: Recorded, index: number) => Reply) {
  const requests: Recorded[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const body = init.body ? new Uint8Array(await new Response(init.body).arrayBuffer()) : new Uint8Array(0);
    const req: Recorded = {
      method: init.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body,
    };
    requests.push(req);
    const reply = respond(req, requests.length - 1);
    return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
      status: reply.status, headers: { "Content-Type": "application/json", ...reply.headers },
    });
  }));
  return requests;
}

const deps = () => ({ sleep: vi.fn(async (_ms: number) => {}), log: vi.fn(), now: () => 0 });
const assetResult = { asset: { id: "a1" }, url: "http://x/files/a1/f" };
const conflict = (code: string) => ({ status: 409, json: { error: code, code } });

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("preparePayload", () => {
  test("hashes the bytes sent: the gzipped ones for a file the CLI compresses", () => {
    const raw = new TextEncoder().encode(JSON.stringify({ features: "x".repeat(4000) }));
    const p = preparePayload("data.geojson", "application/geo+json", raw);
    expect(p.encoding).toBe("gzip");
    expect(new Uint8Array(gunzipSync(p.data))).toEqual(raw);
    expect(p.sha256).toBe(sha256(p.data));
    expect(p.sha256).not.toBe(sha256(raw));
    expect(p.originalSize).toBe(raw.byteLength);
  });

  test("leaves an incompressible file as it is", () => {
    const raw = new Uint8Array(5000).fill(7);
    const p = preparePayload("photo.png", "image/png", raw);
    expect(p.encoding).toBe("identity");
    expect(p.data).toBe(raw);
    expect(p.sha256).toBe(sha256(raw));
  });
});

describe("direct uploads", () => {
  test("a small file is sent once, with its hash and its encoding", async () => {
    const requests = fakeServer(() => ({ status: 201, json: assetResult }));
    const p = preparePayload("data.json", "application/json", new TextEncoder().encode("{}".repeat(1000)));
    await uploadDirect("http://srv", p, deps());
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["X-Content-SHA256"]).toBe(p.sha256);
    expect(requests[0].headers["Content-Encoding"]).toBe("gzip");
    expect(requests[0].headers["X-Original-Size"]).toBe("2000");
    expect(requests[0].body).toEqual(p.data);
  });

  test("an empty file declares the hash of zero bytes", async () => {
    const requests = fakeServer(() => ({ status: 201, json: assetResult }));
    await uploadDirect("http://srv", preparePayload("empty.bin", "application/octet-stream", new Uint8Array(0)), deps());
    expect(requests[0].headers["X-Content-SHA256"]).toBe(EMPTY_SHA256);
    expect(requests[0].headers["Content-Length"]).toBe("0");
  });

  test("a large file is sent whole in one request, never as a hash-only probe", async () => {
    const requests = fakeServer(() => ({ status: 201, json: assetResult }));
    const size = 2 * 1024 * 1024;
    const p = preparePayload("big.zip", "application/zip", new Uint8Array(size).fill(1));
    expect(await uploadDirect("http://srv", p, deps())).toEqual(assetResult);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["Content-Length"]).toBe(String(size));
    expect(requests[0].body.byteLength).toBe(size);
    expect(requests[0].headers["X-Content-SHA256"]).toBe(p.sha256);
  });

  test("a 422 is not followed by another request", async () => {
    const requests = fakeServer(() => ({ status: 422, json: { error: "mismatch", code: "checksum_mismatch" } }));
    const p = preparePayload("big.zip", "application/zip", new Uint8Array(2 * 1024 * 1024).fill(1));
    await expect(uploadDirect("http://srv", p, deps())).rejects.toMatchObject({ status: 422, code: "checksum_mismatch" });
    expect(requests).toHaveLength(1);
  });

  test("blob_unavailable is retried, then given up", async () => {
    const d = deps();
    const requests = fakeServer(() => conflict("blob_unavailable"));
    const p = preparePayload("a.bin", "application/octet-stream", new Uint8Array(10));
    await expect(uploadDirect("http://srv", p, d)).rejects.toMatchObject({ status: 409, code: "blob_unavailable" });
    expect(requests).toHaveLength(3);
  });
});

describe("new versions while the first upload is verified", () => {
  const p = () => preparePayload("v.bin", "application/octet-stream", new Uint8Array(10));

  test("waits for the asset to be verified, polling the asset, then uploads", async () => {
    let integrity = "pending";
    let polls = 0;
    const requests = fakeServer((req) => {
      if (req.method === "GET") {
        if (++polls === 2) integrity = "verified";
        return { status: 200, json: { asset: { id: "a1", integrity } } };
      }
      return integrity === "pending"
        ? conflict("upload_under_verification")
        : { status: 201, json: { version: { id: "v1", version: 2 }, url: "u" } };
    });
    const d = deps();
    const result = await uploadVersionDirect("http://srv", "a1", p(), 60_000, d);
    expect(result.version.id).toBe("v1");
    expect(requests.map((r) => r.method)).toEqual(["POST", "GET", "GET", "POST"]);
    expect(d.sleep).toHaveBeenCalledTimes(2);
  });

  test("says so when the first upload was rejected and the asset is gone", async () => {
    fakeServer((req) => (req.method === "GET" ? { status: 404, json: { error: "Asset not found" } } : conflict("upload_under_verification")));
    await expect(uploadVersionDirect("http://srv", "a1", p(), 60_000, deps())).rejects.toThrow(/failed verification/);
  });

  test("gives up at the deadline with an explanation", async () => {
    let t = 0;
    const d = { sleep: vi.fn(async (ms: number) => { t += ms; }), log: vi.fn(), now: () => t };
    fakeServer((req) => (req.method === "GET" ? { status: 200, json: { asset: { integrity: "pending" } } } : conflict("upload_under_verification")));
    await expect(uploadVersionDirect("http://srv", "a1", p(), 120_000, d)).rejects.toThrow(/still being verified.*asset show a1/);
    expect(t).toBe(120_000);
  });

  test("a zero wait fails at once without polling", async () => {
    const requests = fakeServer(() => conflict("upload_under_verification"));
    await expect(uploadVersionDirect("http://srv", "a1", p(), 0, deps())).rejects.toThrow(/still being verified/);
    expect(requests).toHaveLength(1);
  });
});

describe("upload sessions", () => {
  const session = (p: ReturnType<typeof preparePayload>) => ({
    fileName: p.fileName, contentType: p.contentType, originalSize: p.originalSize, encoding: p.encoding,
    sha256: p.sha256, source: bufferSource(p.data),
  });

  test("declares the hash and states the encoding it uploads", async () => {
    const requests = fakeServer((req) => {
      if (req.url.endsWith("/uploads")) {
        return { status: 201, json: { uploadId: "u1", url: "http://store/put", method: "PUT", headers: { "x-amz-checksum-sha256": "b64" }, contentEncoding: "gzip", expiresAt: 0 } };
      }
      if (req.url === "http://store/put") return { status: 200 };
      return { status: 201, json: assetResult };
    });
    const p = preparePayload("data.json", "application/json", new TextEncoder().encode("{}".repeat(1000)));
    await uploadViaSession("http://srv", session(p), deps());
    const init = JSON.parse(new TextDecoder().decode(requests[0].body));
    expect(init).toMatchObject({ sha256: p.sha256, contentEncoding: "gzip", size: 2000 });
    expect(requests[1].headers["x-amz-checksum-sha256"]).toBe("b64");
    expect(requests[1].body).toEqual(p.data);
  });

  test("a multipart session uploads every part and completes with their ETags", async () => {
    const requests = fakeServer((req) => {
      if (req.url.endsWith("/uploads")) {
        return { status: 201, json: { uploadId: "u1", parts: [{ partNumber: 1, url: "http://store/p1" }], expiresAt: 0 } };
      }
      if (req.url === "http://store/p1") return { status: 200, headers: { ETag: "\"e1\"" } };
      return { status: 201, json: assetResult };
    });
    const p = preparePayload("photo.png", "image/png", new Uint8Array(5000));
    expect(await uploadViaSession("http://srv", session(p), deps())).toEqual(assetResult);
    expect(requests[1].body).toEqual(p.data);
    expect(JSON.parse(new TextDecoder().decode(requests[2].body))).toEqual({ parts: [{ partNumber: 1, etag: "\"e1\"" }] });
  });

  test("refuses a server that ignored the stated encoding", async () => {
    fakeServer(() => ({ status: 201, json: { uploadId: "u1", parts: [{ partNumber: 1, url: "http://store/p1" }], contentEncoding: "gzip", expiresAt: 0 } }));
    const p = preparePayload("photo.png", "image/png", new Uint8Array(5000));
    await expect(uploadViaSession("http://srv", session(p), deps())).rejects.toThrow(/predates this CLI/);
  });

  test("blob_unavailable at completion starts a new session", async () => {
    let sessions = 0;
    const requests = fakeServer((req) => {
      if (req.url.endsWith("/uploads")) {
        sessions++;
        return sessions === 1
          ? { status: 201, json: { uploadId: "u1", url: "http://store/put", method: "PUT", headers: {}, expiresAt: 0 } }
          : { status: 201, json: { uploadId: "u2", url: "http://store/put", method: "PUT", headers: {}, expiresAt: 0 } };
      }
      if (req.url.includes("/uploads/u1/complete")) return conflict("blob_unavailable");
      if (req.url === "http://store/put") return { status: 200 };
      return { status: 201, json: assetResult };
    });
    const p = preparePayload("photo.png", "image/png", new Uint8Array(5000));
    expect(await uploadViaSession("http://srv", session(p), deps())).toEqual(assetResult);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/assets/uploads", "/put", "/api/v1/assets/uploads/u1/complete",
      "/api/v1/assets/uploads", "/put", "/api/v1/assets/uploads/u2/complete",
    ]);
  });

  test("a 501 means no presigned uploads", async () => {
    fakeServer(() => ({ status: 501, json: { error: "no" } }));
    const p = preparePayload("photo.png", "image/png", new Uint8Array(5000));
    expect(await uploadViaSession("http://srv", session(p), deps())).toBeNull();
  });
});

describe("large files", () => {
  test("are hashed by streaming and uploaded as is, part by part from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-transfer-"));
    const file = join(dir, "huge.geojson");
    const content = new TextEncoder().encode("y".repeat(3000));
    await writeFile(file, content);
    const requests = fakeServer((req) => (req.url.endsWith("/uploads")
      ? { status: 201, json: { uploadId: "u1", url: "http://store/put", method: "PUT", headers: {}, expiresAt: 0 } }
      : req.url === "http://store/put" ? { status: 200 } : { status: 201, json: assetResult }));
    await uploadLargeFile("http://srv", file, "huge.geojson", "application/geo+json", content.byteLength, undefined, deps());
    const init = JSON.parse(new TextDecoder().decode(requests[0].body));
    // A compressible name, but streamed files are stated identity, never predicted.
    expect(init).toMatchObject({ sha256: sha256(content), contentEncoding: "identity" });
    expect(requests[1].body).toEqual(content);
  });
});

describe("sha256File", () => {
  test("matches an in-memory hash and reports progress", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-hash-"));
    const file = join(dir, "f.bin");
    const content = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    await writeFile(file, content);
    const seen: number[] = [];
    expect(await sha256File(file, (n) => seen.push(n))).toBe(sha256(content));
    expect(seen.at(-1)).toBe(content.byteLength);
    expect(seen.length).toBeGreaterThan(1);
  });
});
