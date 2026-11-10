// Version extraction jobs end to end through the real routes, cron and SQLite
// stores (ADR-005 amendment 2026-11-05, eukarya-inc/compliance#258 REL-09).
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../../core/app";
import { handleScheduled } from "../../core/cleanup/handler";
import type { ExtractionMessage } from "../../core/extraction/handler";
import { buildNodeRuntime, type NodeRuntime } from "./deps";

const SECRET = "test-secret";

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;
let sessionId: string;
let assetId: string;
let versionId: string;
let versionJobId: string;

async function post(path: string, body: BodyInit, headers: Record<string, string>): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", body, headers }));
}

function upload(path: string, filename: string): Promise<Response> {
  const bytes = new TextEncoder().encode(`archive ${filename}`);
  return post(path, bytes, {
    "Content-Type": "application/zip",
    "Content-Length": String(bytes.byteLength),
    "X-Filename": filename,
    ...(sessionId && { "X-Session-Id": sessionId }),
  });
}

function postStatus(jobId: string, body: object): Promise<Response> {
  return post(`/api/internal/jobs/${jobId}/status`, JSON.stringify(body), {
    "Content-Type": "application/json",
    Authorization: `Bearer ${SECRET}`,
  });
}

async function drainQueue(): Promise<ExtractionMessage[]> {
  const messages = await runtime.extractionQueue.receive();
  for (const m of messages) m.ack();
  await runtime.extractionQueue.flush();
  return messages.map((m) => m.body as ExtractionMessage);
}

beforeEach(async () => {
  runtime = buildNodeRuntime({ INTERNAL_API_SECRET: SECRET, ANONYMOUS_UPLOAD_ENABLED: "true" });
  app = createApp(runtime.deps);
  sessionId = "";

  const root = await upload("/api/v1/assets", "root.zip");
  expect(root.status).toBe(201);
  sessionId = root.headers.get("X-Session-Id")!;
  assetId = ((await root.json()) as { asset: { id: string } }).asset.id;

  const v = await upload(`/api/v1/assets/${assetId}`, "v2.zip");
  expect(v.status).toBe(201);
  const { version } = (await v.json()) as { version: { id: string; jobId: string } };
  versionId = version.id;
  versionJobId = version.jobId;
  expect(versionJobId).not.toBe(assetId);
  await drainQueue();
});

const versionMessage = () => ({
  jobId: versionJobId,
  assetId,
  versionId,
  archiveKey: `assets/${assetId}/v/${versionId}/v2.zip`,
  archiveFilename: "v2.zip",
  archiveFormat: "zip",
});

describe("version extraction jobs", () => {
  test("the upload enqueues the version's job and archive", async () => {
    await upload(`/api/v1/assets/${assetId}`, "v3.zip");
    const [message] = await drainQueue();
    expect(message).toMatchObject({ assetId, archiveFilename: "v3.zip" });
    expect(message.jobId).toBeDefined();
    expect(message.jobId).not.toBe(assetId);
  });

  test("/jobs/:id/retry re-enqueues the version's archive, not the asset's", async () => {
    const res = await post(`/api/v1/jobs/${versionJobId}/retry`, "", { "X-Session-Id": sessionId });
    expect(res.status).toBe(200);
    expect(await drainQueue()).toEqual([versionMessage()]);
  });

  test("the cron re-enqueues a stuck version job with its own archive", async () => {
    runtime.deps.extractionStuckThresholdMs = -1000;
    const rootJob = (await runtime.deps.jobs.find(assetId))!;
    await runtime.deps.jobs.save({ ...rootJob, status: "completed" });

    await handleScheduled(runtime.deps);

    expect(await drainQueue()).toEqual([versionMessage()]);
  });

  test("status callbacks for a version job update the version, not the asset", async () => {
    expect((await postStatus(versionJobId, { status: "running" })).status).toBe(200);
    expect((await runtime.deps.versions.find(versionId))!.status).toBe("extracting");

    expect((await postStatus(versionJobId, { status: "completed", fileCount: 2, extractedSize: 9 })).status).toBe(200);
    const version = (await runtime.deps.versions.find(versionId))!;
    expect(version).toMatchObject({ status: "ready", fileCount: 2, extractedSize: 9 });

    const asset = (await runtime.deps.metadata.find(assetId))!;
    expect(asset.status).toBe("pending");
    expect(asset.fileCount).toBeUndefined();
  });

  test("exhausting the retry budget fails the version, not the asset", async () => {
    runtime.deps.extractionStuckThresholdMs = -1000;
    const rootJob = (await runtime.deps.jobs.find(assetId))!;
    await runtime.deps.jobs.save({ ...rootJob, status: "completed" });
    const job = (await runtime.deps.jobs.find(versionJobId))!;
    await runtime.deps.jobs.save({ ...job, status: "failed", retryCount: 5 });

    await handleScheduled(runtime.deps);

    expect((await runtime.deps.jobs.find(versionJobId))!.status).toBe("failed");
    expect((await runtime.deps.versions.find(versionId))!.status).toBe("failed");
    expect((await runtime.deps.metadata.find(assetId))!.status).not.toBe("failed");
  });

  test("a completed version job does not mark the extracting asset ready", async () => {
    expect((await postStatus(assetId, { status: "running" })).status).toBe(200);
    const job = (await runtime.deps.jobs.find(versionJobId))!;
    await runtime.deps.jobs.save({ ...job, status: "completed" });

    await handleScheduled(runtime.deps);

    expect((await runtime.deps.metadata.find(assetId))!.status).toBe("extracting");
  });
});
