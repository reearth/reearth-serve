/**
 * The extraction-completion hook (ADR-013 C3).
 *
 * `_headers` and `_redirects` are ordinary entries: the Go extractor writes
 * them like any other file, and the Worker reads them back the moment the job
 * says `completed`. This suite drives that through the real internal route, so
 * the ordering the ADR specifies — rules on the row in the same breath as the
 * status mirror — is what is actually tested.
 */
import { describe, expect, test } from "vitest";
import { ASSET_ID, fixture, seedEntry, VERSION_ID } from "../testing/fixture";
import type { AssetMetadata } from "../asset/model";
import type { AtomicWrites } from "../asset/repository";
import type { Job } from "../job/model";
import type { JobStore } from "../job/repository";
import { readSiteHosting } from "./hosting";
import { MAX_CONTROL_FILE_BYTES } from "./rules";

const SECRET = "internal-secret";

const HEADERS_TEXT = [
  "/*",
  "  X-Frame-Options: DENY",
  "  Cache-Control: forever",
].join("\n");

const REDIRECTS_TEXT = [
  "# the site's own routing",
  "/old /new 301",
  "/away https://evil.test 302",
].join("\n");

class MemoryJobStore implements JobStore {
  readonly jobs = new Map<string, Job>();
  async save(job: Job): Promise<void> { this.jobs.set(job.id, { ...job }); }
  async find(id: string): Promise<Job | null> { return this.jobs.get(id) ?? null; }
  async list(): Promise<{ items: Job[]; cursor?: string }> { return { items: [...this.jobs.values()] }; }
  async listStuck(): Promise<Job[]> { return []; }
  async listPending(): Promise<Job[]> { return []; }
  async delete(id: string): Promise<void> { this.jobs.delete(id); }
}

/** Job + asset in one write, as the SQL adapter does it with a D1 batch. */
function memoryWrites(assets: Map<string, AssetMetadata>, jobs: MemoryJobStore): AtomicWrites {
  return {
    async createAsset() {},
    async createVersion(input) { return input.version; },
    async saveJob({ job, asset }) {
      await jobs.save(job);
      if (asset) assets.set(asset.id, asset);
    },
  };
}

async function hookFixture(opts: { versionId?: string } = {}) {
  const jobs = new MemoryJobStore();
  const f = await fixture({
    jobs,
    internalApiSecret: SECRET,
    writes: undefined as never,
  });
  // `writes` needs the metadata map the fixture built, so it is wired after.
  (f.deps as { writes: AtomicWrites }).writes = memoryWrites(f.metadata.assets, jobs);

  await jobs.save({
    id: "job1",
    assetId: ASSET_ID,
    type: "archive-extraction",
    status: "running",
    createdAt: 0,
    updatedAt: 0,
    ...(opts.versionId && { versionId: opts.versionId }),
  });

  const complete = () => f.app.request("/api/internal/jobs/job1/status", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed", fileCount: 3, extractedSize: 100 }),
  });

  return { ...f, jobs, complete };
}

describe("completing an archive extraction", () => {
  test("parses both control files onto the version, warnings included", async () => {
    const f = await hookFixture({ versionId: VERSION_ID });
    await seedEntry(f.storage, "_headers", HEADERS_TEXT, "text/plain");
    await seedEntry(f.storage, "_redirects", REDIRECTS_TEXT, "text/plain");

    const res = await f.complete();
    expect(res.status).toBe(200);

    const hosting = (await f.versions.find(VERSION_ID))!.hosting!;
    expect(hosting.headers).toEqual([{ pattern: "/*", headers: { "x-frame-options": "DENY" } }]);
    expect(hosting.redirects).toEqual([{ from: "/old", to: "/new", status: 301, force: false }]);
    expect(hosting.warnings).toHaveLength(2);
    expect(hosting.warnings[0]).toContain("cache-control");
    expect(hosting.warnings[1]).toContain("must be a path inside the site");

    // The status mirror still happened.
    expect(f.metadata.assets.get(ASSET_ID)!.status).toBe("ready");
  });

  test("one control file alone is enough", async () => {
    const f = await hookFixture({ versionId: VERSION_ID });
    await seedEntry(f.storage, "_redirects", "/a /b 308", "text/plain");
    await f.complete();
    const hosting = (await f.versions.find(VERSION_ID))!.hosting!;
    expect(hosting.headers).toEqual([]);
    expect(hosting.redirects).toEqual([{ from: "/a", to: "/b", status: 308, force: false }]);
  });

  test("neither file leaves no key and no error", async () => {
    const f = await hookFixture({ versionId: VERSION_ID });
    const res = await f.complete();
    expect(res.status).toBe(200);
    expect((await f.versions.find(VERSION_ID))!.hosting).toBeUndefined();
  });

  test("a job with no version writes the rules onto the asset", async () => {
    // A first upload creates no version row (versions start at the second), so
    // a one-version site's rules have nowhere else to live.
    const f = await hookFixture();
    await f.storage.put(
      `assets/${ASSET_ID}/files/_redirects`,
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("/a /b 302")); c.close(); } }),
      "text/plain",
      9,
    );
    await f.complete();
    const asset = f.metadata.assets.get(ASSET_ID)!;
    expect(asset.hosting!.redirects).toEqual([{ from: "/a", to: "/b", status: 302, force: false }]);
  });

  test("a failed job reads nothing", async () => {
    const f = await hookFixture({ versionId: VERSION_ID });
    await seedEntry(f.storage, "_redirects", "/a /b 301", "text/plain");
    const res = await f.app.request("/api/internal/jobs/job1/status", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "failed", error: "boom" }),
    });
    expect(res.status).toBe(200);
    expect((await f.versions.find(VERSION_ID))!.hosting).toBeUndefined();
  });
});

describe("readSiteHosting", () => {
  test("an oversized control file is rejected on its stored size", async () => {
    const f = await fixture();
    // The check runs against the object's size, before a byte is decoded, so a
    // file named `_headers` cannot be used to pull an archive into the Worker.
    const oversized = new Uint8Array(MAX_CONTROL_FILE_BYTES + 1).fill(0x61);
    await f.storage.put(
      `assets/${ASSET_ID}/v/${VERSION_ID}/files/_headers`,
      new ReadableStream({ start(c) { c.enqueue(oversized); c.close(); } }),
      "text/plain",
      oversized.byteLength,
    );

    const hosting = await readSiteHosting(f.storage, { assetId: ASSET_ID, versionId: VERSION_ID });
    expect(hosting!.headers).toEqual([]);
    expect(hosting!.warnings[0]).toContain("larger than");
  });

  test("the legacy layout is searched when the versioned key is missing", async () => {
    const f = await fixture();
    await f.storage.put(
      `assets/${ASSET_ID}/files/_headers`,
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("/*\n  X-A: 1")); c.close(); } }),
      "text/plain",
      11,
    );
    const hosting = await readSiteHosting(f.storage, { assetId: ASSET_ID, versionId: VERSION_ID });
    expect(hosting!.headers).toEqual([{ pattern: "/*", headers: { "x-a": "1" } }]);
  });
});
