import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../../core/app";
import { handleScheduled } from "../../core/cleanup/handler";
import type { Job } from "../../shared/api";
import { writeZip } from "../../adapters/memory/zip";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

const SECRET = "test-secret";

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let sessionId: string;

async function post(path: string, body: BodyInit, headers: Record<string, string>): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", body, headers }));
}

const text = (s: string) => new TextEncoder().encode(s);
const ZIP = new Uint8Array(writeZip([{ name: "a.txt", data: text("in place") }, { name: "b.txt", data: text("also in place") }]));

async function upload(path: string, filename: string): Promise<Record<string, unknown>> {
  const bytes = filename.endsWith(".zip") ? ZIP : text(`archive ${filename}`);
  const res = await post(path, bytes, {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(bytes.byteLength),
    "X-Filename": filename,
    ...(sessionId && { "X-Session-Id": sessionId }),
  });
  expect(res.status).toBe(201);
  sessionId ||= res.headers.get("X-Session-Id")!;
  return (await res.json()) as Record<string, unknown>;
}

async function uploadAsset(filename: string): Promise<string> {
  const { asset } = (await upload("/api/v1/assets", filename)) as { asset: { id: string } };
  return asset.id;
}

async function uploadVersion(assetId: string, filename: string): Promise<{ id: string; jobId: string }> {
  const { version } = (await upload(`/api/v1/assets/${assetId}`, filename)) as { version: { id: string; jobId: string } };
  return version;
}

async function report(jobId: string, body: Record<string, unknown>): Promise<void> {
  const res = await post(`/api/internal/jobs/${jobId}/status`, JSON.stringify(body), {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SECRET}`,
  });
  expect(res.status).toBe(200);
}

const reportFailed = (jobId: string) => report(jobId, { status: "failed", error: "boom" });

async function getFile(assetId: string, path: string): Promise<Response> {
  return app.fetch(new Request(`http://localhost/files/${assetId}/${path}`));
}

async function exhaustRetries(jobId: string): Promise<void> {
  runtime.deps.extractionStuckThresholdMs = -1000;
  const job = (await runtime.deps.jobs.find(jobId))!;
  await runtime.deps.jobs.save({ ...job, status: "failed", retryCount: 5 });
  await handleScheduled(runtime.deps);
}

async function dropFailureClass(jobId: string): Promise<void> {
  const { failureClass: _, ...legacy } = (await runtime.deps.jobs.find(jobId))!;
  await runtime.deps.jobs.save(legacy as Job);
  expect((await runtime.deps.jobs.find(jobId))!.failureClass).toBeUndefined();
}

const job = async (id: string) => (await runtime.deps.jobs.find(id))!;
const assetStatus = async (id: string) => (await runtime.deps.metadata.find(id))!.status;
const versionStatus = async (id: string) => (await runtime.deps.versions.find(id))!.status;

beforeEach(() => {
  runtime = buildNodeRuntime({ INTERNAL_API_SECRET: SECRET, ANONYMOUS_UPLOAD_ENABLED: "true" });
  app = createApp(runtime.deps);
  sessionId = "";
});

describe("a new extraction job", () => {
  test("carries the failure class of its format", async () => {
    expect((await job(await uploadAsset("a.zip"))).failureClass).toBe("slower-reads");
    expect((await job(await uploadAsset("a.tar.gz"))).failureClass).toBe("missing-feature");
  });
});

const finalFailures = [
  ["the extractor reports failure", reportFailed],
  ["the cron exhausts the retry budget", exhaustRetries],
] as const;

describe.each(finalFailures)("when %s", (_, fail) => {
  test("a zip asset stays ready and its job is failed with slower-reads", async () => {
    const id = await uploadAsset("a.zip");
    await fail(id);
    expect(await job(id)).toMatchObject({ status: "failed", failureClass: "slower-reads" });
    expect(await assetStatus(id)).toBe("ready");
  });

  test("a zip asset keeps serving its entries in place from the original", async () => {
    const id = await uploadAsset("a.zip");
    await fail(id);
    const res = await getFile(id, "a.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("in place");
  });

  test("a zip version keeps serving its entries in place from the original", async () => {
    const assetId = await uploadAsset("root.zip");
    await report(assetId, { status: "completed", fileCount: 0 });
    const zip = await uploadVersion(assetId, "v2.zip");
    await fail(zip.jobId);
    const res = await getFile(assetId, "b.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("also in place");
  });

  test("a tar.gz asset is failed and its job is failed with missing-feature", async () => {
    const id = await uploadAsset("a.tar.gz");
    await fail(id);
    expect(await job(id)).toMatchObject({ status: "failed", failureClass: "missing-feature" });
    expect(await assetStatus(id)).toBe("failed");
  });

  test("a zip version stays ready, a tar.gz version is failed", async () => {
    const assetId = await uploadAsset("root.tar.gz");
    await runtime.deps.jobs.save({ ...(await job(assetId)), status: "completed" });
    const zip = await uploadVersion(assetId, "v2.zip");
    const tar = await uploadVersion(assetId, "v3.tar.gz");

    await fail(zip.jobId);
    await fail(tar.jobId);

    expect(await job(zip.jobId)).toMatchObject({ status: "failed", failureClass: "slower-reads" });
    expect(await versionStatus(zip.id)).toBe("ready");
    expect(await job(tar.jobId)).toMatchObject({ status: "failed", failureClass: "missing-feature" });
    expect(await versionStatus(tar.id)).toBe("failed");
    expect(await assetStatus(assetId)).not.toBe("failed");
  });

  test("a job written before failure classes gets one stamped from its mirror", async () => {
    const zip = await uploadAsset("a.zip");
    const tar = await uploadAsset("a.tar.gz");
    await dropFailureClass(zip);
    await dropFailureClass(tar);

    await fail(zip);
    await fail(tar);

    expect((await job(zip)).failureClass).toBe("slower-reads");
    expect(await assetStatus(zip)).toBe("ready");
    expect((await job(tar)).failureClass).toBe("missing-feature");
    expect(await assetStatus(tar)).toBe("failed");
  });
});

describe("a zip whose extraction completed", () => {
  test("answers 404 for an entry the extractor did not write", async () => {
    const id = await uploadAsset("a.zip");
    await report(id, { status: "completed", fileCount: 1, extractedSize: 8 });
    expect(await assetStatus(id)).toBe("ready");
    expect((await getFile(id, "a.txt")).status).toBe(404);
  });
});
