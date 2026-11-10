// SHA-256 backfill of rows stored before ADR-017 (P4) end to end on the Node
// runtime: SQLite stores, the cron that selects rows and drains the queue, the
// in-process verifier, and the routes that read the result.
//
// Pre-ADR rows cannot be created over HTTP any more (every upload records a
// hash), so they are written straight through the stores, as an old
// deployment left them: no sha256, no integrity, classic key.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../core/app";
import type { AssetMetadata } from "../../core/asset/model";
import { newBackfillJob } from "../../core/integrity/backfill";
import { JOB_MAX_RETRIES } from "../../core/job/model";
import { buildNodeRuntime, type NodeRuntime } from "./deps";
import { runCron } from "./cron";
import { loadConfig } from "./config";

const SECRET = "test-secret";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** A real anonymous session, so the routes show the legacy rows to the test. */
let SESSION = "";

let runtime: NodeRuntime;
let app: ReturnType<typeof createApp>;

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.fetch(new Request(`http://localhost${path}`, {
    method,
    ...(body !== undefined && { body: JSON.stringify(body) }),
    headers: { ...(SESSION && { "X-Session-Id": SESSION }), ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
  })));
}

async function legacyAsset(id: string, content: string | null): Promise<AssetMetadata> {
  const asset: AssetMetadata = {
    id, filename: "data.txt", contentType: "text/plain", size: content?.length ?? 4, createdAt: 1, expiresAt: 0,
    sessionId: SESSION,
  };
  await runtime.deps.metadata.save(asset, 0);
  if (content !== null) {
    await runtime.deps.storage.put(`assets/${id}/data.txt`, new Blob([content]).stream(), "text/plain", content.length);
  }
  return asset;
}

async function backfillJobs() {
  const res = await call("GET", "/api/v1/jobs");
  const { jobs } = (await res.json()) as { jobs: { id: string; assetId: string; versionId?: string; type: string; status: string; error?: string }[] };
  return jobs.filter((j) => j.type === "integrity-backfill");
}

async function start(env: Record<string, string>): Promise<void> {
  runtime = buildNodeRuntime({ INTERNAL_API_SECRET: SECRET, ANONYMOUS_UPLOAD_ENABLED: "true", ...env });
  app = createApp(runtime.deps);
  SESSION = "";
  const seed = await app.fetch(new Request("http://localhost/api/v1/assets", {
    method: "POST",
    body: "seed",
    headers: { "Content-Type": "text/plain", "Content-Length": "4", "X-Filename": "seed.txt" },
  }));
  expect(seed.status).toBe(201);
  SESSION = seed.headers.get("X-Session-Id")!;
}

beforeEach(async () => {
  await start({ INTEGRITY_BACKFILL_ENABLED: "true", INTEGRITY_BACKFILL_BATCH_SIZE: "10" });
});

describe("config", () => {
  test("the backfill is off unless enabled, with a default batch size", () => {
    expect(loadConfig({}).backfill).toEqual({ enabled: false, batchSize: 2 });
    expect(loadConfig({ INTEGRITY_BACKFILL_ENABLED: "true", INTEGRITY_BACKFILL_BATCH_SIZE: "7" }).backfill)
      .toEqual({ enabled: true, batchSize: 7 });
    expect(loadConfig({ INTEGRITY_BACKFILL_BATCH_SIZE: "nope" }).backfill.batchSize).toBe(2);
  });
});

describe("the cron backfills pre-ADR rows", () => {
  test("an asset and its version get the hash of their stored bytes", async () => {
    await legacyAsset("a1", "first upload");
    await runtime.deps.versions.save({
      id: "v1", assetId: "a1", version: 0, filename: "data.txt", contentType: "text/plain", size: 6, createdAt: 2,
    });
    await runtime.deps.storage.put("assets/a1/v/v1/data.txt", new Blob(["second"]).stream(), "text/plain", 6);

    const before = (await (await call("GET", "/api/v1/assets/a1")).json()) as { asset: Record<string, unknown> };
    expect(before.asset.sha256).toBeUndefined();

    await runCron(runtime);

    const after = (await (await call("GET", "/api/v1/assets/a1")).json()) as { asset: Record<string, unknown> };
    expect(after.asset).toMatchObject({ sha256: sha256("first upload"), integrity: "verified" });
    const version = (await (await call("GET", "/api/v1/assets/a1/versions/v1")).json()) as Record<string, unknown>;
    expect(JSON.stringify(version)).toContain(sha256("second"));
    expect(await backfillJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetId: "a1", status: "completed" }),
      expect.objectContaining({ assetId: "a1", versionId: "v1", status: "completed" }),
    ]));
    // The hash is served back on the original bytes, as for any upload.
    const file = await call("GET", "/files/a1/data.txt");
    expect(file.headers.get("X-Content-SHA256")).toBe(sha256("second"));
  });

  test("a row whose object is missing is left as it was and not tried again", async () => {
    await legacyAsset("gone", null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runCron(runtime);
    await runCron(runtime);
    warn.mockRestore();

    const jobs = await backfillJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ assetId: "gone", status: "failed" });
    expect(jobs[0].error).toContain("missing");
    const asset = await runtime.deps.metadata.find("gone");
    expect(asset?.sha256).toBeUndefined();
    expect(asset?.integrity).toBeUndefined();
  });

  test("nothing happens while the switch is off", async () => {
    await start({});
    await legacyAsset("a1", "bytes");

    await runCron(runtime);
    expect(await backfillJobs()).toEqual([]);
    expect((await runtime.deps.metadata.find("a1"))?.sha256).toBeUndefined();
  });
});

describe("the container's report on /api/internal/jobs/:id/status", () => {
  const report = (jobId: string, body: object) =>
    call("POST", `/api/internal/jobs/${jobId}/status`, body, { Authorization: `Bearer ${SECRET}` });

  test("a completed report records the hash; a later report changes nothing", async () => {
    await legacyAsset("a1", "bytes");
    const job = newBackfillJob({ assetId: "a1", filename: "data.txt", sessionId: SESSION }, Date.now());
    await runtime.deps.jobs.save(job);

    const ok = await report(job.id, { status: "completed", sha256: sha256("bytes") });
    expect(await ok.json()).toEqual({ ok: true, outcome: "recorded" });
    expect(await runtime.deps.metadata.find("a1")).toMatchObject({ sha256: sha256("bytes"), integrity: "verified" });

    const late = await report(job.id, { status: "completed", sha256: sha256("other") });
    expect(await late.json()).toEqual({ ok: true, outcome: "settled" });
    expect(await runtime.deps.metadata.find("a1")).toMatchObject({ sha256: sha256("bytes") });
  });

  test("a failed report on a present object is retried; nothing is deleted", async () => {
    await legacyAsset("a1", "bytes");
    const job = newBackfillJob({ assetId: "a1", filename: "data.txt", sessionId: SESSION }, Date.now());
    await runtime.deps.jobs.save(job);

    const res = await report(job.id, { status: "failed", error: "read broke" });
    expect(await res.json()).toEqual({ ok: true, outcome: "retry" });
    expect(await runtime.deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: 0 });
    expect((await call("GET", "/files/a1/data.txt")).status).toBe(200);
  });

  test("a failed backfill can be retried by hand once its object is back", async () => {
    await legacyAsset("a1", null);
    const job = newBackfillJob({ assetId: "a1", filename: "data.txt", sessionId: SESSION }, Date.now());
    await runtime.deps.jobs.save({ ...job, status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
    await runtime.deps.storage.put("assets/a1/data.txt", new Blob(["restored"]).stream(), "text/plain", 8);

    expect((await call("POST", `/api/v1/jobs/${job.id}/retry`)).status).toBe(200);
    await runCron(runtime);
    expect(await runtime.deps.metadata.find("a1")).toMatchObject({ sha256: sha256("restored"), integrity: "verified" });
  });
});
