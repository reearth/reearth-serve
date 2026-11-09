// Hash verification of presigned uploads end to end on the Node runtime
// (ADR-017 §2, phase P1b): the real routes, SQLite stores, the cron that
// drains the queue, and the in-process verifier.
//
// The Node runtime has no presigned uploads of its own (no S3 adapter yet), so
// the generator is replaced by one whose "completed multipart upload" writes
// the bytes the simulated client sent straight into the in-memory store. The
// e2e suite cannot reach this path over HTTP for the same reason.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { PresignedUrlGenerator } from "../../core/asset/repository";
import type { MemoryFileStorage } from "../../adapters/memory/storage";
import { buildNodeRuntime, type NodeRuntime } from "./deps";
import { runCron } from "./cron";

const SECRET = "test-secret";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let sessionId: string;
/** What the simulated client uploads; the fake store writes it on completion. */
let uploaded: string;

function fakePresigned(storage: MemoryFileStorage): PresignedUrlGenerator {
  return {
    generatePutUrl: async (key) => ({ url: `https://store.example/${key}`, headers: {} }),
    createMultipartUpload: async () => "mp-1",
    generateUploadPartUrl: async (key, _id, part) => `https://store.example/${key}?part=${part}`,
    completeMultipartUpload: async (key) => {
      await storage.put(key, new Blob([uploaded]).stream(), "application/octet-stream", uploaded.length);
    },
    abortMultipartUpload: async () => {},
  };
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined && { body: typeof body === "string" || body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body) }),
    headers: {
      ...(body !== undefined && typeof body === "object" && !(body instanceof Uint8Array) && { "Content-Type": "application/json" }),
      ...(sessionId && { "X-Session-Id": sessionId }),
      ...headers,
    },
  }));
}

/** Create a multipart session, "upload", complete it. Returns the asset JSON. */
async function presignedUpload(filename: string, declared?: string): Promise<{ id: string; integrity?: string; sha256?: string }> {
  const created = await call("POST", "/api/v1/assets/uploads", {
    filename, contentType: "application/octet-stream", size: uploaded.length, partCount: 2,
    ...(declared && { sha256: declared }),
  });
  expect(created.status).toBe(201);
  const { uploadId } = (await created.json()) as { uploadId: string };
  const completed = await call("POST", `/api/v1/assets/uploads/${uploadId}/complete`, {
    parts: [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }],
  });
  expect(completed.status).toBe(201);
  return ((await completed.json()) as { asset: { id: string; integrity?: string; sha256?: string } }).asset;
}

async function verificationJobOf(assetId: string) {
  const res = await call("GET", "/api/v1/jobs");
  const { jobs } = (await res.json()) as { jobs: { id: string; assetId: string; type: string; status: string; error?: string }[] };
  return jobs.find((j) => j.assetId === assetId && j.type === "integrity-verification")!;
}

beforeEach(async () => {
  runtime = buildNodeRuntime({ ANONYMOUS_UPLOAD_ENABLED: "true", INTERNAL_API_SECRET: SECRET });
  runtime.deps.presignedUrls = fakePresigned(runtime.deps.storage as MemoryFileStorage);
  app = createApp(runtime.deps);
  sessionId = "";
  uploaded = "seed";
  const seed = await call("POST", "/api/v1/assets", new TextEncoder().encode("seed"), {
    "Content-Type": "text/plain", "Content-Length": "4", "X-Filename": "seed.txt",
  });
  expect(seed.status).toBe(201);
  sessionId = seed.headers.get("X-Session-Id")!;
});

describe("presigned multipart uploads", () => {
  test("a declared hash that matches is verified by the cron's in-process verifier", async () => {
    uploaded = "the real bytes";
    const asset = await presignedUpload("data.bin", sha256(uploaded));
    expect(asset).toMatchObject({ integrity: "pending", sha256: sha256(uploaded) });
    expect(await verificationJobOf(asset.id)).toMatchObject({ status: "pending" });

    await runCron(runtime);

    const read = (await (await call("GET", `/api/v1/assets/${asset.id}`)).json()) as { asset: object };
    expect(read.asset).toMatchObject({ integrity: "verified", sha256: sha256(uploaded) });
    expect(await verificationJobOf(asset.id)).toMatchObject({ status: "completed" });
  });

  test("an undeclared upload records the hash the verifier computed", async () => {
    uploaded = "nobody said what these bytes hash to";
    const asset = await presignedUpload("data.bin");
    expect(asset.integrity).toBe("pending");
    expect(asset.sha256).toBeUndefined();

    await runCron(runtime);

    expect(await runtime.deps.metadata.find(asset.id)).toMatchObject({ integrity: "verified", sha256: sha256(uploaded) });
  });

  test("a wrong declared hash ends with the asset, its bytes and its extraction gone", async () => {
    uploaded = "these are not the promised bytes";
    const asset = await presignedUpload("site.zip", sha256("the promised bytes"));
    // Pending is servable: the bytes are there.
    expect((await call("GET", `/files/${asset.id}/site.zip`)).status).toBe(200);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron(runtime);
    warn.mockRestore();

    expect((await call("GET", `/api/v1/assets/${asset.id}`)).status).toBe(404);
    expect((await call("GET", `/files/${asset.id}/site.zip`)).status).toBe(404);
    expect((await runtime.deps.storage.list(`assets/${asset.id}/`)).keys).toEqual([]);

    const job = await verificationJobOf(asset.id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("SHA-256 mismatch");
    expect(await runtime.deps.jobs.find(asset.id)).toMatchObject({ type: "archive-extraction", status: "failed" });
  });

  test("a declared upload takes no new version until it is verified", async () => {
    uploaded = "first upload";
    const asset = await presignedUpload("data.bin", sha256(uploaded));
    const version = () => call("POST", `/api/v1/assets/${asset.id}`, new TextEncoder().encode("v2"), {
      "Content-Type": "text/plain", "Content-Length": "2", "X-Filename": "data.bin",
    });

    expect((await version()).status).toBe(409);
    await runCron(runtime);
    expect((await version()).status).toBe(201);
  });
});

describe("the container's report on /api/internal/jobs/:id/status", () => {
  const report = (jobId: string, body: object, auth = `Bearer ${SECRET}`) =>
    call("POST", `/api/internal/jobs/${jobId}/status`, body, { Authorization: auth });

  test("requires the internal secret", async () => {
    uploaded = "bytes";
    const asset = await presignedUpload("data.bin");
    const job = await verificationJobOf(asset.id);

    expect((await report(job.id, { status: "completed", sha256: sha256(uploaded) }, "Bearer wrong")).status).toBe(401);
    expect((await call("POST", `/api/internal/jobs/${job.id}/status`, { status: "completed", sha256: sha256(uploaded) })).status).toBe(401);
    expect(await runtime.deps.metadata.find(asset.id)).toMatchObject({ integrity: "pending" });

    const ok = await report(job.id, { status: "completed", sha256: sha256(uploaded) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, outcome: "verified" });
    expect(await runtime.deps.metadata.find(asset.id)).toMatchObject({ integrity: "verified" });
  });

  test("a completed report without a hash is refused", async () => {
    uploaded = "bytes";
    const asset = await presignedUpload("data.bin");
    const job = await verificationJobOf(asset.id);
    expect((await report(job.id, { status: "completed" })).status).toBe(400);
  });

  test("a mismatch reported by the container deletes the upload; extraction's final report re-queues the prefix", async () => {
    uploaded = "actual";
    const asset = await presignedUpload("site.zip", sha256("declared"));
    const job = await verificationJobOf(asset.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await report(job.id, { status: "completed", sha256: sha256(uploaded) });
    expect(await res.json()).toEqual({ ok: true, outcome: "rejected" });
    expect(await runtime.deps.metadata.find(asset.id)).toBeNull();

    // The extractor wrote one more file before it noticed, then reported.
    await runtime.deps.storage.put(`assets/${asset.id}/_archive/_log.txt`, new Blob(["log"]).stream(), "text/plain", 3);
    expect((await report(asset.id, { status: "failed", error: "asset expired during extraction" })).status).toBe(200);
    warn.mockRestore();

    expect((await runtime.deps.pendingCleanup.list(10)).map((p) => p.prefix)).toContain(`assets/${asset.id}/`);
    await runCron(runtime);
    expect((await runtime.deps.storage.list(`assets/${asset.id}/`)).keys).toEqual([]);
  });
});
