// Hash verification of presigned uploads (ADR-017 §2, P1b), against the real
// SQL stores and the in-memory object store.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createSqliteClient } from "../../adapters/memory/sqlite-node";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { MemoryJobQueue } from "../../adapters/memory/memory-queue";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { SqlAtomicWrites } from "../../adapters/sql/writes";
import {
  SqlCleanupPendingStore, SqlJobStore, SqlMetadataStore, SqlProjectStore, SqlStorageUsageStore, SqlVersionStore,
} from "../../adapters/sql/stores";
import { SqlSiteHostStore } from "../../adapters/sql/site-hosts";
import { NoopProvisioner } from "../site/provisioner";
import type { AssetMetadata } from "../asset/model";
import type { ContainerLauncher } from "../container/port";
import { JOB_MAX_RETRIES, type Job } from "../job/model";
import type { ExtractionMessage } from "../extraction/handler";
import { handleQueue } from "../extraction/handler";
import { handleScheduled } from "../cleanup/handler";
import { retryDelaySeconds } from "../extraction/backoff";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";
import {
  applyVerificationResult, handleVerificationQueue, newVerificationJob, verificationMessage, type VerificationMessage,
} from "./verification";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const BODY = "the bytes that were actually uploaded";
const ACTUAL = sha256(BODY);
const OTHER = sha256("the bytes the client said it would upload");

function launcher(overrides: Partial<ContainerLauncher> = {}): ContainerLauncher {
  return {
    archiveExtractorAvailable: true,
    thumbnailGeneratorAvailable: false,
    integrityVerifierAvailable: true,
    launchArchiveExtractor: async () => {},
    generateThumbnails: async () => { throw new Error("unused"); },
    verifyIntegrity: async () => ({ started: true }),
    ...overrides,
  };
}

let deps: Deps;
let storage: MemoryFileStorage;
let usage: SqlStorageUsageStore;
let pending: SqlCleanupPendingStore;
let queue: MemoryJobQueue<ExtractionMessage | VerificationMessage>;

beforeEach(async () => {
  const sql = createSqliteClient();
  storage = new MemoryFileStorage();
  usage = new SqlStorageUsageStore(sql);
  pending = new SqlCleanupPendingStore(sql);
  queue = new MemoryJobQueue();
  const projects = new SqlProjectStore(sql);
  await projects.save({ id: "p1", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u1", workspaceId: "w1" });
  deps = {
    metadata: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    writes: new SqlAtomicWrites(sql),
    jobs: new SqlJobStore(sql),
    storage,
    pendingCleanup: pending,
    storageUsage: usage,
    projects,
    siteHosts: new SqlSiteHostStore(sql),
    cache: new MemoryKeyValue(),
    customHostnames: new NoopProvisioner("serve.example.test"),
    siteHostSuffix: undefined,
    extractionQueue: queue,
    verificationQueue: queue,
    containers: launcher(),
    extractionStuckThresholdMs: 30 * 60 * 1000,
    limits: { subrequestBudget: 1000 },
  } as unknown as Deps;
});

/** A completed presigned upload, as `completeUploadSession` writes it. */
async function seed(options: { declared?: string; archive?: boolean } = {}): Promise<{ asset: AssetMetadata; job: Job }> {
  const id = "a1";
  const filename = options.archive ? "data.zip" : "data.bin";
  const asset: AssetMetadata = {
    id, filename, contentType: "application/octet-stream", size: BODY.length, createdAt: 1, expiresAt: 0,
    projectId: "p1", integrity: "pending",
    ...(options.declared && { sha256: options.declared }),
    ...(options.archive && { type: "archive" as const, status: "pending" as const, archiveFormat: "zip" as const, jobId: id }),
  };
  const extraction: Job | undefined = options.archive
    ? { id, assetId: id, type: "archive-extraction", status: "pending", createdAt: 1, updatedAt: 1, projectId: "p1" }
    : undefined;
  const job = newVerificationJob(asset, 1);
  await storage.put(`assets/${id}/${filename}`, new Blob([BODY]).stream(), "application/octet-stream", BODY.length);
  await deps.writes.createAsset({ asset, job: extraction, verificationJob: job, usageScopes: ["project:p1", "workspace:w1"] });
  return { asset, job };
}

describe("applyVerificationResult", () => {
  test("an undeclared upload is verified with the computed hash", async () => {
    const { job } = await seed();
    expect(await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL })).toBe("verified");

    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: ACTUAL, integrity: "verified" });
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "completed" });
  });

  test("a matching declared hash is verified (any case)", async () => {
    const { job } = await seed({ declared: ACTUAL });
    expect(await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL.toUpperCase() })).toBe("verified");
    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: ACTUAL, integrity: "verified" });
  });

  test("a mismatch deletes the upload, its counters and its extraction job, and is final", async () => {
    const { job } = await seed({ declared: OTHER, archive: true });
    await storage.put("assets/a1/files/readme.txt", new Blob(["x"]).stream(), "text/plain", 1);
    expect((await usage.get("project:p1"))?.totalSize).toBe(BODY.length);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL })).toBe("rejected");
    warn.mockRestore();

    expect(await deps.metadata.find("a1")).toBeNull();
    expect(storage.size).toBe(0);
    expect((await usage.get("project:p1"))?.totalSize).toBe(0);
    expect((await usage.get("workspace:w1"))?.assetCount).toBe(0);

    const closed = (await deps.jobs.find(job.id))!;
    expect(closed).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
    expect(closed.error).toContain(`declared ${OTHER}`);
    expect(closed.error).toContain(ACTUAL);
    expect(await deps.jobs.find("a1")).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });

    // Final: a repeated report changes nothing, and the cron neither re-runs
    // the verification nor relaunches the extraction.
    expect(await applyVerificationResult(deps, closed, { status: "completed", sha256: OTHER })).toBe("settled");
    await handleScheduled(deps);
    expect(queue.sent).toEqual([]);
  });

  test("a read failure leaves the row pending and the job retriable", async () => {
    const { job } = await seed({ declared: OTHER });
    expect(await applyVerificationResult(deps, job, { status: "failed", error: "read failed: EOF" })).toBe("retry");

    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: OTHER, integrity: "pending" });
    const failed = (await deps.jobs.find(job.id))!;
    expect(failed).toMatchObject({ status: "failed", error: "read failed: EOF" });

    // The cron re-runs it on its next tick…
    await handleScheduled(deps);
    expect(queue.sent.map((s) => s.body)).toEqual([verificationMessage(job, { id: "a1", filename: "data.bin" })]);
    // …and a later report still reaches a verdict.
    const rerun = (await deps.jobs.find(job.id))!;
    expect(rerun).toMatchObject({ status: "pending", retryCount: 1 });
    expect(await applyVerificationResult(deps, rerun, { status: "completed", sha256: OTHER })).toBe("verified");
  });

  test("a malformed hash from the verifier is a transient failure, not a mismatch", async () => {
    const { job } = await seed({ declared: OTHER });
    expect(await applyVerificationResult(deps, job, { status: "completed", sha256: "nope" })).toBe("retry");
    expect(await deps.metadata.find("a1")).not.toBeNull();
  });

  test("running records progress without touching the row", async () => {
    const { job } = await seed({ archive: true });
    expect(await applyVerificationResult(deps, job, { status: "running" }, 5000)).toBe("running");
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "running", startedAt: 5000 });
    expect(await deps.metadata.find("a1")).toMatchObject({ status: "pending", integrity: "pending" });
  });

  test("a report for a deleted asset only closes the job", async () => {
    const { job, asset } = await seed();
    await deps.writes.deleteAsset({ asset, cleanupPrefix: "assets/a1/" });
    expect(await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL })).toBe("settled");
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", error: "asset no longer exists" });
  });

  test("a stale full-row write after the verdict cannot undo it", async () => {
    const { job, asset } = await seed({ archive: true });
    await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL });
    // The extraction status callback writes the whole row from a copy it read
    // while the upload was still pending.
    await deps.writes.saveJob({
      job: { ...(await deps.jobs.find("a1"))!, status: "completed" },
      asset: { ...asset, status: "ready" },
    });
    expect(await deps.metadata.find("a1")).toMatchObject({ status: "ready", sha256: ACTUAL, integrity: "verified" });
  });
});

describe("cron", () => {
  test("a verification job out of retries fails alone: the row stays pending and its status untouched", async () => {
    const { job } = await seed({ declared: OTHER, archive: true });
    await deps.jobs.save({ ...job, status: "failed", retryCount: JOB_MAX_RETRIES });
    await deps.jobs.save({ ...(await deps.jobs.find("a1"))!, status: "completed" });

    await handleScheduled(deps);

    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
    // `ready` comes from the completed extraction job, not from this one.
    expect(await deps.metadata.find("a1")).toMatchObject({ status: "ready", integrity: "pending", sha256: OTHER });
  });

  test("a completed verification job does not mark the extracting asset ready", async () => {
    const { job, asset } = await seed({ archive: true });
    await deps.metadata.save({ ...asset, status: "extracting" }, 0);
    await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL });

    await handleScheduled(deps);

    expect(await deps.metadata.find("a1")).toMatchObject({ status: "extracting", integrity: "verified" });
  });

  test("a job whose asset is gone is closed instead of found again every tick", async () => {
    const { job, asset } = await seed();
    await deps.writes.deleteAsset({ asset, cleanupPrefix: "assets/a1/" });
    await deps.jobs.save({ ...job, status: "failed" });

    await handleScheduled(deps);

    expect(queue.sent).toEqual([]);
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
  });
});

describe("handleVerificationQueue", () => {
  async function deliver(message: VerificationMessage) {
    await queue.send(message);
    const [received] = queue.receive();
    const spied = { ...received, ack: vi.fn(received.ack), retry: vi.fn(received.retry) };
    await handleQueue([spied], deps);
    return spied;
  }

  test("an in-process verifier's hash is settled at once", async () => {
    const { job, asset } = await seed({ declared: OTHER });
    deps.containers = launcher({ archiveExtractorAvailable: false, verifyIntegrity: async () => ({ sha256: ACTUAL }) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await deliver(verificationMessage(job, asset));
    warn.mockRestore();

    expect(queue.size).toBe(0);
    expect(await deps.metadata.find("a1")).toBeNull();
  });

  test("a started container leaves the job to its report", async () => {
    const { job, asset } = await seed();
    const verifyIntegrity = vi.fn(async () => ({ started: true as const }));
    deps.containers = launcher({ verifyIntegrity });

    await deliver(verificationMessage(job, asset));

    expect(verifyIntegrity).toHaveBeenCalledWith({ jobId: job.id, assetId: "a1", objectKey: "assets/a1/data.bin" });
    expect(queue.size).toBe(0);
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "pending" });
    expect(await deps.metadata.find("a1")).toMatchObject({ integrity: "pending" });
  });

  test("a launch or read error retries with backoff and keeps the row", async () => {
    const { job, asset } = await seed({ declared: OTHER });
    deps.containers = launcher({ verifyIntegrity: async () => { throw new Error("no instance available"); } });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const message = await deliver(verificationMessage(job, asset));
    err.mockRestore();

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: retryDelaySeconds(1) });
    expect(message.ack).not.toHaveBeenCalled();
    expect(await deps.metadata.find("a1")).toMatchObject({ integrity: "pending" });
  });

  test("no verifier backs every message off without launching anything", async () => {
    const { job, asset } = await seed();
    const verifyIntegrity = vi.fn();
    deps.containers = launcher({ integrityVerifierAvailable: false, verifyIntegrity });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await queue.send(verificationMessage(job, asset));
    const [received] = queue.receive();
    const retry = vi.fn(received.retry);
    await handleVerificationQueue([{ ...received, retry } as QueueMessage<VerificationMessage>], deps);
    err.mockRestore();

    expect(verifyIntegrity).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });

  test("a message for a settled asset is acked without a read", async () => {
    const { job, asset } = await seed();
    await applyVerificationResult(deps, job, { status: "completed", sha256: ACTUAL });
    const verifyIntegrity = vi.fn();
    deps.containers = launcher({ verifyIntegrity });

    await deliver(verificationMessage(job, asset));

    expect(verifyIntegrity).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  test("verification messages are not held back when the extractor is unavailable", async () => {
    const { job, asset } = await seed();
    deps.containers = launcher({ archiveExtractorAvailable: false, verifyIntegrity: async () => ({ sha256: ACTUAL }) });

    await deliver(verificationMessage(job, asset));

    expect(await deps.metadata.find("a1")).toMatchObject({ integrity: "verified" });
  });
});
