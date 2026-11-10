// SHA-256 backfill of rows stored before ADR-017 (P4), against the real SQL
// stores and the in-memory object store.
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
import { SqlBlobRefStore } from "../../adapters/sql/blob-refs";
import { SqlIntegrityBackfillStore } from "../../adapters/sql/integrity-backfill";
import { NoopProvisioner } from "../site/provisioner";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { ContainerLauncher } from "../container/port";
import { JOB_MAX_RETRIES, jobFailureClass, type Job } from "../job/model";
import { handleQueue, type ExtractionMessage } from "../extraction/handler";
import { handleScheduled } from "../cleanup/handler";
import { SubrequestBudget } from "../cleanup/usecase";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";
import type { VerificationMessage } from "./verification";
import {
  applyBackfillResult, enqueueIntegrityBackfill, handleBackfillQueue, newBackfillJob, type BackfillMessage,
} from "./backfill";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const BODY = "bytes uploaded before ADR-017";
const ACTUAL = sha256(BODY);

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

type AnyMessage = ExtractionMessage | VerificationMessage | BackfillMessage;

let deps: Deps;
let storage: MemoryFileStorage;
let queue: MemoryJobQueue<AnyMessage>;
let backfills: SqlIntegrityBackfillStore;

beforeEach(async () => {
  const sql = createSqliteClient();
  storage = new MemoryFileStorage();
  queue = new MemoryJobQueue();
  backfills = new SqlIntegrityBackfillStore(sql);
  const projects = new SqlProjectStore(sql);
  await projects.save({ id: "p1", name: "p", createdAt: 1, updatedAt: 1, ownerId: "u1", workspaceId: "w1" });
  deps = {
    metadata: new SqlMetadataStore(sql),
    versions: new SqlVersionStore(sql),
    writes: new SqlAtomicWrites(sql),
    jobs: new SqlJobStore(sql),
    storage,
    pendingCleanup: new SqlCleanupPendingStore(sql),
    blobRefs: new SqlBlobRefStore(sql),
    storageUsage: new SqlStorageUsageStore(sql),
    projects,
    siteHosts: new SqlSiteHostStore(sql),
    cache: new MemoryKeyValue(),
    customHostnames: new NoopProvisioner("serve.example.test"),
    siteHostSuffix: undefined,
    extractionQueue: queue,
    verificationQueue: queue,
    backfillQueue: queue,
    integrityBackfills: backfills,
    containers: launcher(),
    extractionStuckThresholdMs: 30 * 60 * 1000,
    limits: { subrequestBudget: 1000 },
    backfillSettings: { enabled: true, batchSize: 2 },
  } as unknown as Deps;
});

/** An asset stored before ADR-017: no hash, classic key, object in place. */
async function legacyAsset(id: string, options: { object?: boolean; createdAt?: number } = {}): Promise<AssetMetadata> {
  const asset: AssetMetadata = {
    id, filename: "data.bin", contentType: "application/octet-stream", size: BODY.length,
    createdAt: options.createdAt ?? 1, expiresAt: 0, projectId: "p1",
  };
  await deps.metadata.save(asset, 0);
  if (options.object !== false) {
    await storage.put(`assets/${id}/data.bin`, new Blob([BODY]).stream(), "application/octet-stream", BODY.length);
  }
  return asset;
}

async function legacyVersion(id: string, assetId: string): Promise<AssetVersion> {
  const version: AssetVersion = {
    id, assetId, version: 0, filename: "v.bin", contentType: "application/octet-stream", size: BODY.length, createdAt: 5,
  };
  const saved = await deps.versions.save(version);
  await storage.put(`assets/${assetId}/v/${id}/v.bin`, new Blob([BODY]).stream(), "application/octet-stream", BODY.length);
  return saved;
}

async function backfillJobs(): Promise<Job[]> {
  const { items } = await deps.jobs.list({ scope: { kind: "project", projectId: "p1" }, limit: 100 });
  return items.filter((j) => j.type === "integrity-backfill");
}

function messages(): QueueMessage<AnyMessage>[] {
  return queue.bodies.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }) as unknown as QueueMessage<AnyMessage>);
}

describe("jobFailureClass", () => {
  test("a backfill failure is a slower-reads failure: nothing is rejected or marked failed", () => {
    expect(jobFailureClass({ type: "integrity-backfill" })).toBe("slower-reads");
  });
});

describe("enqueueIntegrityBackfill", () => {
  test("does nothing when disabled, without a queue, or without a verifier", async () => {
    await legacyAsset("a1");
    const budget = new SubrequestBudget(100);
    const off = { ...deps, backfillSettings: { enabled: false, batchSize: 2 } };
    expect((await enqueueIntegrityBackfill(off, budget, off.backfillSettings)).enqueued).toEqual([]);
    expect((await enqueueIntegrityBackfill({ ...deps, backfillQueue: null }, budget, deps.backfillSettings)).enqueued).toEqual([]);
    const noVerifier = { ...deps, containers: launcher({ integrityVerifierAvailable: false }) };
    expect((await enqueueIntegrityBackfill(noVerifier, budget, deps.backfillSettings)).enqueued).toEqual([]);
    expect(budget.spent).toBe(0);
    expect(await backfillJobs()).toEqual([]);
  });

  test("creates one job per row and sends its message, assets and versions alike", async () => {
    await legacyAsset("a1");
    await legacyVersion("v1", "a1");

    const result = await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings, 10);
    expect(result.enqueued).toHaveLength(2);
    const jobs = await backfillJobs();
    expect(jobs.map((j) => ({ assetId: j.assetId, versionId: j.versionId ?? undefined, status: j.status, projectId: j.projectId })))
      .toEqual(expect.arrayContaining([
        { assetId: "a1", versionId: undefined, status: "pending", projectId: "p1" },
        { assetId: "a1", versionId: "v1", status: "pending", projectId: "p1" },
      ]));
    expect(queue.bodies).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "integrity-backfill", assetId: "a1", objectKey: "assets/a1/data.bin" }),
      expect.objectContaining({ kind: "integrity-backfill", assetId: "a1", versionId: "v1", objectKey: "assets/a1/v/v1/v.bin" }),
    ]));
  });

  test("keeps at most batchSize jobs open and never enqueues a row twice", async () => {
    for (const id of ["a1", "a2", "a3", "a4"]) await legacyAsset(id, { createdAt: Number(id.slice(1)) });

    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    expect(queue.bodies.map((m) => m.assetId)).toEqual(["a1", "a2"]);
    // Next tick: both still open, nothing new.
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    expect(queue.bodies).toHaveLength(2);

    // One finishes; the next tick fills its slot with a row not yet taken.
    const [first] = await backfillJobs();
    await deps.jobs.save({ ...first, status: "completed" });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    expect(queue.bodies.map((m) => m.assetId)).toEqual(["a1", "a2", "a3"]);
  });

  test("stops when the budget runs low and charges what it spends", async () => {
    for (const id of ["a1", "a2", "a3"]) await legacyAsset(id);
    const settings = { enabled: true, batchSize: 10 };

    expect(await enqueueIntegrityBackfill(deps, new SubrequestBudget(3), settings)).toEqual({ enqueued: [], budgetExhausted: true });
    expect(await backfillJobs()).toEqual([]);

    const budget = new SubrequestBudget(6);
    const result = await enqueueIntegrityBackfill(deps, budget, settings);
    // count + page + two job/message pairs, then not enough for the third.
    expect(result.enqueued).toHaveLength(2);
    expect(result.budgetExhausted).toBe(true);
    expect(budget.spent).toBe(6);

    // The next tick picks up the row that was left.
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), settings);
    expect(queue.bodies.map((m) => m.assetId)).toEqual(["a1", "a2", "a3"]);
  });

  test("a failed send keeps the job, so the row is not picked again and the cron re-sends it", async () => {
    await legacyAsset("a1");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { ...deps, backfillQueue: { send: async () => { throw new Error("queue down"); } } };
    await enqueueIntegrityBackfill(failing, new SubrequestBudget(100), deps.backfillSettings);
    error.mockRestore();

    expect(await backfillJobs()).toMatchObject([{ status: "pending" }]);
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), { enabled: true, batchSize: 5 });
    expect(queue.bodies).toEqual([]);
  });
});

describe("applyBackfillResult", () => {
  async function jobFor(target: { assetId: string; versionId?: string }): Promise<Job> {
    const job = newBackfillJob({ ...target, filename: "x", projectId: "p1" }, 1);
    await deps.jobs.save(job);
    return job;
  }

  test("records the computed hash as verified, on an asset and on a version", async () => {
    await legacyAsset("a1");
    await legacyVersion("v1", "a1");
    const assetJob = await jobFor({ assetId: "a1" });
    const versionJob = await jobFor({ assetId: "a1", versionId: "v1" });

    expect(await applyBackfillResult(deps, assetJob, { status: "completed", sha256: ACTUAL.toUpperCase() })).toBe("recorded");
    expect(await applyBackfillResult(deps, versionJob, { status: "completed", sha256: ACTUAL })).toBe("recorded");
    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: ACTUAL, integrity: "verified" });
    expect(await deps.versions.find("v1")).toMatchObject({ sha256: ACTUAL, integrity: "verified" });
    expect((await deps.metadata.find("a1"))?.blobKey).toBeUndefined();
    expect(await deps.jobs.find(assetJob.id)).toMatchObject({ status: "completed" });
  });

  test("a row deleted meanwhile: the job is closed and nothing is written", async () => {
    const job = await jobFor({ assetId: "gone" });
    expect(await applyBackfillResult(deps, job, { status: "completed", sha256: ACTUAL })).toBe("settled");
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1, error: "asset no longer exists" });
  });

  test("a row hashed meanwhile keeps its hash", async () => {
    const other = sha256("something else");
    await legacyAsset("a1");
    const job = await jobFor({ assetId: "a1" });
    await deps.metadata.save({ ...(await deps.metadata.find("a1"))!, sha256: other, integrity: "verified" }, 0);

    expect(await applyBackfillResult(deps, job, { status: "completed", sha256: ACTUAL })).toBe("settled");
    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: other });
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "completed" });
  });

  test("a read failure on an object that is missing closes the job and records nothing", async () => {
    await legacyAsset("a1", { object: false });
    const job = await jobFor({ assetId: "a1" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await applyBackfillResult(deps, job, { status: "failed", error: "head: not found" })).toBe("missing");
    warn.mockRestore();
    const closed = await deps.jobs.find(job.id);
    expect(closed).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
    expect(closed?.error).toContain("missing");
    const row = await deps.metadata.find("a1");
    expect(row?.sha256).toBeUndefined();
    expect(row?.integrity).toBeUndefined();
    // Closed and not re-selected.
    expect(await backfills.listUnhashed(10)).toEqual([]);
  });

  test("a read failure on an object that is there is transient", async () => {
    await legacyAsset("a1");
    const job = await jobFor({ assetId: "a1" });

    expect(await applyBackfillResult(deps, job, { status: "failed", error: "connection reset" })).toBe("retry");
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: 0, error: "connection reset" });
    expect(await applyBackfillResult(deps, job, { status: "completed", sha256: "nothex" })).toBe("retry");
    expect((await deps.metadata.find("a1"))?.sha256).toBeUndefined();
  });

  test("running is recorded; a closed job ignores late reports", async () => {
    await legacyAsset("a1");
    const job = await jobFor({ assetId: "a1" });
    expect(await applyBackfillResult(deps, job, { status: "running" })).toBe("running");
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "running" });

    const closed = { ...job, status: "failed" as const, retryCount: JOB_MAX_RETRIES + 1 };
    expect(await applyBackfillResult(deps, closed, { status: "completed", sha256: ACTUAL })).toBe("settled");
    expect((await deps.metadata.find("a1"))?.sha256).toBeUndefined();
  });
});

describe("handleBackfillQueue", () => {
  test("an in-process verifier's hash is recorded at once", async () => {
    await legacyAsset("a1");
    deps.containers = launcher({ archiveExtractorAvailable: false, verifyIntegrity: async () => ({ sha256: ACTUAL }) });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    const batch = messages();

    await handleQueue(batch, deps);
    expect(batch[0].ack).toHaveBeenCalled();
    expect(await deps.metadata.find("a1")).toMatchObject({ sha256: ACTUAL, integrity: "verified" });
  });

  test("a container run is started on the row's current key and settles later", async () => {
    await legacyVersion("v1", (await legacyAsset("a1")).id);
    const verifyIntegrity = vi.fn(async () => ({ started: true as const }));
    deps.containers = launcher({ verifyIntegrity });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);

    await handleBackfillQueue(messages() as QueueMessage<BackfillMessage>[], deps);
    expect(verifyIntegrity).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1", objectKey: "assets/a1/data.bin" }));
    expect(verifyIntegrity).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1", objectKey: "assets/a1/v/v1/v.bin" }));
    expect((await deps.metadata.find("a1"))?.sha256).toBeUndefined();
  });

  test("a missing object is closed without starting a run", async () => {
    await legacyAsset("a1", { object: false });
    const verifyIntegrity = vi.fn();
    deps.containers = launcher({ verifyIntegrity });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    const batch = messages();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleBackfillQueue(batch as QueueMessage<BackfillMessage>[], deps);
    warn.mockRestore();
    expect(verifyIntegrity).not.toHaveBeenCalled();
    expect(batch[0].ack).toHaveBeenCalled();
    expect(await backfillJobs()).toMatchObject([{ status: "failed", retryCount: JOB_MAX_RETRIES + 1 }]);
  });

  test("a row deleted before the run starts closes the job without a run", async () => {
    await legacyAsset("a1");
    const verifyIntegrity = vi.fn();
    deps.containers = launcher({ verifyIntegrity });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    await deps.writes.deleteAsset({ asset: (await deps.metadata.find("a1"))!, cleanupPrefix: "assets/a1/" });

    await handleBackfillQueue(messages() as QueueMessage<BackfillMessage>[], deps);
    expect(verifyIntegrity).not.toHaveBeenCalled();
    expect(await backfillJobs()).toMatchObject([{ status: "failed", error: "asset no longer exists" }]);
  });

  test("a launch failure retries the message and keeps the job pending", async () => {
    await legacyAsset("a1");
    deps.containers = launcher({ verifyIntegrity: async () => { throw new Error("no instance available"); } });
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    const batch = messages();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleBackfillQueue(batch as QueueMessage<BackfillMessage>[], deps);
    error.mockRestore();
    expect(batch[0].retry).toHaveBeenCalled();
    expect(await backfillJobs()).toMatchObject([{ status: "pending" }]);
  });

  test("without a verifier every message backs off", async () => {
    await legacyAsset("a1");
    await enqueueIntegrityBackfill(deps, new SubrequestBudget(100), deps.backfillSettings);
    deps.containers = launcher({ integrityVerifierAvailable: false });
    const batch = messages();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handleBackfillQueue(batch as QueueMessage<BackfillMessage>[], deps);
    error.mockRestore();
    expect(batch[0].retry).toHaveBeenCalledWith({ delaySeconds: 300 });
  });
});

describe("cron", () => {
  test("the scheduled pass enqueues the backfill", async () => {
    await legacyAsset("a1");
    await handleScheduled(deps);
    expect(queue.bodies).toEqual([expect.objectContaining({ kind: "integrity-backfill", assetId: "a1" })]);
  });

  test("a failed backfill is re-sent, and one out of retries is closed with the row untouched", async () => {
    await legacyAsset("a1");
    const job = newBackfillJob({ assetId: "a1", filename: "data.bin", projectId: "p1" }, 1);
    await deps.jobs.save({ ...job, status: "failed", retryCount: 1, error: "read failed" });
    deps.backfillSettings = { enabled: false, batchSize: 2 };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleScheduled(deps);
    expect(queue.bodies).toEqual([expect.objectContaining({ kind: "integrity-backfill", jobId: job.id })]);
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "pending", retryCount: 2 });

    await deps.jobs.save({ ...job, status: "failed", retryCount: JOB_MAX_RETRIES });
    await handleScheduled(deps);
    log.mockRestore();
    expect(await deps.jobs.find(job.id)).toMatchObject({ status: "failed", retryCount: JOB_MAX_RETRIES + 1 });
    const row = await deps.metadata.find("a1");
    expect(row?.status ?? undefined).toBeUndefined();
    expect(row?.integrity).toBeUndefined();
  });

  test("a failed backfill whose row was hashed meanwhile is closed, not re-sent", async () => {
    await legacyAsset("a1");
    const job = newBackfillJob({ assetId: "a1", filename: "data.bin", projectId: "p1" }, 1);
    await deps.jobs.save({ ...job, status: "failed", retryCount: 1 });
    await deps.metadata.save({ ...(await deps.metadata.find("a1"))!, sha256: ACTUAL, integrity: "verified" }, 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleScheduled(deps);
    log.mockRestore();
    expect(queue.bodies.filter((m) => "kind" in m && m.kind === "integrity-backfill")).toEqual([]);
    expect(await deps.jobs.find(job.id)).toMatchObject({ retryCount: JOB_MAX_RETRIES + 1 });
  });
});
