import { readFileSync } from "node:fs";
import { describe, test, expect, beforeAll } from "vitest";
import { BASE, buildMiniZip, crc32, internalHeaders, rawGet, rewriteUrl, uploadFile } from "./helpers";

const containerAvailable = process.env.E2E_CONTAINER === "true";
const NODE_RUNTIME = process.env.E2E_NODE_RUNTIME === "true";

describe("Archive & Job", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  // --- ZIP upload ---

  describe("ZIP upload", () => {
    test("Upload a ZIP file and download it back", async () => {
      const zipBytes = buildMiniZip({ "hello.txt": "Hello!" });
      const { status, body } = await uploadFile(zipBytes, "test.zip", "application/zip");
      expect(status).toBe(201);
      expect(body.asset.filename).toBe("test.zip");
      expect(body.asset.contentType).toBe("application/zip");
      expect(body.asset.size).toBe(zipBytes.byteLength);
      expect(body.asset.type).toBe("archive");
      expect(body.asset.status).toBe("pending");
      expect(body.asset.archiveFormat).toBe("zip");
      expect(body.asset.jobId).toBe(body.asset.id);
      expect(body.url).toContain("/files/");

      // Download the raw ZIP back
      const dlRes = await fetch(rewriteUrl(body.url));
      expect(dlRes.status).toBe(200);
      const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
      expect(dlBytes.byteLength).toBe(zipBytes.byteLength);
      // ZIP magic number: PK\x03\x04
      expect(dlBytes[0]).toBe(0x50);
      expect(dlBytes[1]).toBe(0x4b);
    });

    test("Upload a tar.gz file", async () => {
      const content = new TextEncoder().encode("fake-tar-gz-data");
      const { status, body } = await uploadFile(content, "data.tar.gz", "application/gzip");
      expect(status).toBe(201);
      expect(body.asset.filename).toBe("data.tar.gz");
      expect(body.asset.type).toBe("archive");
      expect(body.asset.status).toBe("pending");
      expect(body.asset.archiveFormat).toBe("tar.gz");
    });
  });

  // --- Job API ---

  describe("Job API", () => {
    test("GET /api/v1/jobs/:id returns 404 for non-existent job", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs/nonexistent-job-id`);
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toContain("not found");
    });

    test("POST /api/v1/jobs/:id/retry returns 404 for non-existent job", async () => {
      const res = await fetch(`${BASE}/api/v1/jobs/nonexistent-job-id/retry`, {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });

    test("POST /api/internal/jobs/:id/status without the internal secret returns 401", async () => {
      const res = await fetch(`${BASE}/api/internal/jobs/nonexistent-job-id/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      });
      expect(res.status).toBe(401);
    });

    test("POST /api/internal/jobs/:id/status returns 404 for non-existent job", async () => {
      const res = await fetch(`${BASE}/api/internal/jobs/nonexistent-job-id/status`, {
        method: "POST",
        headers: internalHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status: "running" }),
      });
      expect(res.status).toBe(404);
    });

    test("Job lifecycle: upload creates job, status transitions through pending → extracting → ready", async () => {
      // Upload a ZIP — job should be auto-created
      const zipBytes = buildMiniZip({ "a.txt": "hello" });
      const { body: uploadBody, sessionId } = await uploadFile(zipBytes, "lifecycle.zip", "application/zip");
      const assetId = uploadBody.asset.id;
      const headers: Record<string, string> = {};
      if (sessionId) headers["X-Session-Id"] = sessionId;

      // Asset should have pending status
      expect(uploadBody.asset.type).toBe("archive");
      expect(uploadBody.asset.status).toBe("pending");
      expect(uploadBody.asset.archiveFormat).toBe("zip");
      expect(uploadBody.asset.jobId).toBe(assetId);

      // Job should exist and be pending
      const jobRes = await fetch(`${BASE}/api/v1/jobs/${assetId}`, { headers });
      expect(jobRes.status).toBe(200);
      const job = await jobRes.json() as any;
      expect(job.status).toBe("pending");

      // Container reports running → asset becomes extracting
      const runRes = await fetch(`${BASE}/api/internal/jobs/${assetId}/status`, {
        method: "POST",
        headers: internalHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status: "running" }),
      });
      expect(runRes.status).toBe(200);

      const assetDuring = await (await fetch(`${BASE}/api/v1/assets/${assetId}`, { headers })).json() as any;
      expect(assetDuring.asset.status).toBe("extracting");

      // Container reports completed → asset becomes ready
      const completeRes = await fetch(`${BASE}/api/internal/jobs/${assetId}/status`, {
        method: "POST",
        headers: internalHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ status: "completed", fileCount: 1, extractedSize: 5 }),
      });
      expect(completeRes.status).toBe(200);

      const assetAfter = await (await fetch(`${BASE}/api/v1/assets/${assetId}`, { headers })).json() as any;
      expect(assetAfter.asset.status).toBe("ready");
      expect(assetAfter.asset.fileCount).toBe(1);
      expect(assetAfter.asset.extractedSize).toBe(5);
    });

    test("A version's job reports to its own job and mirrors onto the version, not the asset", async () => {
      const { body: uploadBody, sessionId } = await uploadFile(buildMiniZip({ "a.txt": "v1" }), "root.zip", "application/zip");
      const assetId = uploadBody.asset.id;
      const headers: Record<string, string> = sessionId ? { "X-Session-Id": sessionId } : {};

      const bytes = buildMiniZip({ "a.txt": "v2" });
      const versionRes = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/zip", "Content-Length": String(bytes.byteLength), "X-Filename": "v2.zip" },
        body: bytes as BodyInit,
      });
      expect(versionRes.status).toBe(201);
      const { version } = await versionRes.json() as any;
      expect(version.jobId).toBeDefined();
      expect(version.jobId).not.toBe(assetId);

      const versionJob = await (await fetch(`${BASE}/api/v1/jobs/${version.jobId}`, { headers })).json() as any;
      expect(versionJob.versionId).toBe(version.id);

      for (const body of [{ status: "running" }, { status: "completed", fileCount: 1, extractedSize: 2 }]) {
        const res = await fetch(`${BASE}/api/internal/jobs/${version.jobId}/status`, {
          method: "POST",
          headers: internalHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
      }

      const versionAfter = await (await fetch(`${BASE}/api/v1/assets/${assetId}/versions/${version.id}`, { headers })).json() as any;
      expect(versionAfter.version).toMatchObject({ status: "ready", fileCount: 1, extractedSize: 2 });

      const assetAfter = await (await fetch(`${BASE}/api/v1/assets/${assetId}`, { headers })).json() as any;
      expect(assetAfter.asset.status).toBe("pending");
      expect(assetAfter.asset.fileCount).toBeUndefined();

      const retryRes = await fetch(`${BASE}/api/v1/jobs/${version.jobId}/retry`, { method: "POST", headers });
      expect(retryRes.status).toBe(400);
    });

    test("Container extraction: upload ZIP, wait for extraction, verify files", { timeout: 120_000, skip: !containerAvailable }, async () => {
      const files = {
        "tileset.json": '{"root":"test"}',
        "tiles/0.json": '{"tile":0}',
        "tiles/1.json": '{"tile":1}',
      };
      const zipBytes = buildMiniZip(files);
      const { status, body: uploadBody, sessionId } = await uploadFile(zipBytes, "extract-test.zip", "application/zip");
      expect(status).toBe(201);

      const assetId = uploadBody.asset.id;
      expect(uploadBody.asset.status).toBe("pending");
      const headers: Record<string, string> = {};
      if (sessionId) headers["X-Session-Id"] = sessionId;

      // Poll job until completed or failed (max 90s)
      let jobStatus = "pending";
      let lastJob: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`${BASE}/api/v1/jobs/${assetId}`, { headers });
        lastJob = await res.json() as any;
        jobStatus = lastJob.status;
        if (jobStatus === "completed" || jobStatus === "failed") break;
      }
      if (jobStatus !== "completed") {
        console.error(`Job did not complete. assetId=${assetId}, lastJob=`, JSON.stringify(lastJob));
      }
      expect(jobStatus).toBe("completed");

      // Verify asset status is ready
      let assetStatus = "pending";
      let assetRes: any;
      for (let i = 0; i < 10; i++) {
        assetRes = await (await fetch(`${BASE}/api/v1/assets/${assetId}`, { headers })).json() as any;
        assetStatus = assetRes.asset.status;
        if (assetStatus === "ready" || assetStatus === "failed") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(assetStatus).toBe("ready");
      expect(assetRes.asset.fileCount).toBe(Object.keys(files).length);

      // Verify file list via NDJSON API
      const filesRes = await fetch(`${BASE}/api/v1/assets/${assetId}/files`, { headers });
      expect(filesRes.status).toBe(200);
      const fileEntries = parseNdjson(await filesRes.text());
      expect(fileEntries).toHaveLength(Object.keys(files).length);

      // Verify each extracted file's content
      for (const [path, expectedContent] of Object.entries(files)) {
        const fileUrl = `${BASE}/files/${assetId}/${path}`;
        const res = await fetch(fileUrl);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(expectedContent);
      }
    });
  });

  // --- File list API (NDJSON) ---

  describe("File list API", () => {
    test("GET /api/v1/assets/:id/files streams single entry for non-archive asset", async () => {
      const content = new TextEncoder().encode("hello");
      const { body, sessionId } = await uploadFile(content, "simple.txt", "text/plain");
      const assetId = body.asset.id;
      const headers: Record<string, string> = {};
      if (sessionId) headers["X-Session-Id"] = sessionId;

      const res = await fetch(`${BASE}/api/v1/assets/${assetId}/files`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
      const entries = parseNdjson(await res.text());
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe("simple.txt");
      expect(entries[0].size).toBe(5);
    });

    test("GET /api/v1/assets/:id/files lists a pending zip in place, from its central directory", async () => {
      const zipBytes = buildMiniZip({ "a.txt": "data" });
      const { body, sessionId } = await uploadFile(zipBytes, "pending.zip", "application/zip");
      const assetId = body.asset.id;
      const headers: Record<string, string> = {};
      if (sessionId) headers["X-Session-Id"] = sessionId;

      const res = await fetch(`${BASE}/api/v1/assets/${assetId}/files`, { headers });
      expect(res.status).toBe(200);
      const entries = parseNdjson(await res.text());
      const hash = `crc32:${crc32(new TextEncoder().encode("data")).toString(16).padStart(8, "0")}`;
      expect(entries).toEqual([{ path: "a.txt", size: 4, contentType: "text/plain; charset=utf-8", hash }]);
    });

    test("GET /api/v1/assets/:id/files supports prefix filter", async () => {
      const content = new TextEncoder().encode("hello");
      const { body, sessionId } = await uploadFile(content, "data.txt", "text/plain");
      const assetId = body.asset.id;
      const headers: Record<string, string> = {};
      if (sessionId) headers["X-Session-Id"] = sessionId;

      // Matching prefix
      const res1 = await fetch(`${BASE}/api/v1/assets/${assetId}/files?prefix=data`, { headers });
      expect(res1.status).toBe(200);
      const entries1 = parseNdjson(await res1.text());
      expect(entries1).toHaveLength(1);

      // Non-matching prefix
      const res2 = await fetch(`${BASE}/api/v1/assets/${assetId}/files?prefix=other`, { headers });
      expect(res2.status).toBe(200);
      const entries2 = parseNdjson(await res2.text());
      expect(entries2).toHaveLength(0);
    });

    test("GET /api/v1/assets/:id/files returns 404 for non-existent asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/nonexistent/files`);
      expect(res.status).toBe(404);
    });
  });

  describe("In-place listing", () => {
    test.each(["deflate.zip", "store.zip", "descriptor.zip", "prepended.zip", "shift_jis.zip", "cp437.zip", "unicode-extra.zip", "site.zip"])(
      "%s lists its golden entries the moment the upload completes",
      async (name) => {
        const { assetId, headers } = await uploadFixture(name);
        expect(await listFiles(assetId, headers)).toEqual(golden(name));
      },
    );

    test("a prefix lists only the entries under it", async () => {
      const { assetId, headers } = await uploadFixture("deflate.zip");
      expect(await listFiles(assetId, headers, "dir/sub/")).toEqual(golden("deflate.zip").filter((e) => e.path.startsWith("dir/sub/")));
    });

    test("a new version lists that version's entries", async () => {
      const { assetId, headers } = await uploadFixture("deflate.zip");
      const bytes = fixtureBytes("store.zip");
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/zip", "Content-Length": String(bytes.byteLength), "X-Filename": "store.zip" },
        body: bytes as BodyInit,
      });
      expect(res.status).toBe(201);
      expect(await listFiles(assetId, headers)).toEqual(golden("store.zip"));
    });

    test.each([
      ["a text file named .zip", () => new TextEncoder().encode("not an archive at all, only text")],
      ["a truncated zip", () => fixtureBytes("deflate.zip").slice(0, 200)],
    ])("%s answers 200 with an empty listing", async (_, make) => {
      const { status, body, sessionId } = await uploadFile(make(), "broken.zip", "application/zip");
      expect(status).toBe(201);
      expect(await listFiles(body.asset.id, sessionId ? { "X-Session-Id": sessionId } : {})).toEqual([]);
    });
  });

  describe("In-place serving", () => {
    test.each(["deflate.zip", "store.zip", "descriptor.zip", "prepended.zip", "shift_jis.zip", "cp437.zip", "unicode-extra.zip", "site.zip"])(
      "every entry of %s is served from the original the moment the upload completes",
      async (name) => {
        const { assetId } = await uploadFixture(name);
        for (const entry of golden(name)) {
          const res = entry.size > 0 ? await rawGet(entryUrl(assetId, entry.path), { Range: "bytes=0-" }) : await rawGet(entryUrl(assetId, entry.path));
          expect({ path: entry.path, status: res.status }).toEqual({ path: entry.path, status: entry.size > 0 ? 206 : 200 });
          expect(`crc32:${crc32(res.body).toString(16).padStart(8, "0")}`).toBe(entry.hash);
        }
      },
    );

    // Under the Vite dev server the worker sees Accept-Encoding gzip even from
    // a client that sent none, and miniflare's dispatchFetch decodes the body
    // but keeps the encoded Content-Length, so a whole deflate entry arrives
    // truncated. A whole-entry response is only checkable on the Node runtime.
    test.skipIf(!NODE_RUNTIME).each(["deflate.zip", "store.zip", "descriptor.zip", "shift_jis.zip", "site.zip"])(
      "every entry of %s comes back whole with its length to a client without gzip",
      async (name) => {
        const { assetId } = await uploadFixture(name);
        for (const entry of golden(name)) {
          const res = await rawGet(entryUrl(assetId, entry.path));
          expect({ path: entry.path, status: res.status, length: res.headers["content-length"] }).toEqual({ path: entry.path, status: 200, length: String(entry.size) });
          expect(`crc32:${crc32(res.body).toString(16).padStart(8, "0")}`).toBe(entry.hash);
        }
      },
    );

    test.each([["store.zip", "index.html", "bytes=5-14"], ["deflate.zip", "a.txt", "bytes=1000-1999"]])(
      "a Range on %s's %s is 206 with exactly those bytes",
      async (name, path, range) => {
        const { assetId } = await uploadFixture(name);
        const whole = (await rawGet(entryUrl(assetId, path))).body;
        const res = await rawGet(entryUrl(assetId, path), { Range: range, "Accept-Encoding": "gzip" });
        const [start, end] = range.slice(6).split("-").map(Number);
        expect(res.status).toBe(206);
        expect(res.headers["content-range"]).toBe(`bytes ${start}-${end}/${whole.byteLength}`);
        expect(res.body).toEqual(whole.subarray(start, end + 1));
      },
    );

    test("If-None-Match with the entry's ETag is 304", async () => {
      const { assetId } = await uploadFixture("store.zip");
      const etag = (await rawGet(entryUrl(assetId, "index.html"))).headers.etag as string;
      expect(etag).toBeTruthy();
      const res = await rawGet(entryUrl(assetId, "index.html"), { "If-None-Match": etag });
      expect(res.status).toBe(304);
      expect(res.body.byteLength).toBe(0);
    });

    test.each([["an encrypted entry", { flags: 1 }], ["a bzip2 entry", { method: 12 }]])(
      "%s is listed and answers 501",
      async (_, patch) => {
        const zip = patchFirstEntry(buildMiniZip({ "locked.txt": "secret" }), patch);
        const { status, body, sessionId } = await uploadFile(zip, "locked.zip", "application/zip");
        expect(status).toBe(201);
        const headers = sessionId ? { "X-Session-Id": sessionId } : ({} as Record<string, string>);
        expect((await listFiles(body.asset.id, headers)).map((e) => e.path)).toEqual(["locked.txt"]);
        expect((await rawGet(entryUrl(body.asset.id, "locked.txt"))).status).toBe(501);
      },
    );
  });

  // --- File subpath routing ---

  describe("File subpath routing", () => {
    test("GET /files/:id/filename returns the file for regular assets", async () => {
      const content = '{"key":"value"}';
      const { body } = await uploadFile(
        new TextEncoder().encode(content),
        "data.json",
        "application/json",
      );
      const url = rewriteUrl(body.url);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(content);
    });

    test("GET /files/:id/subdir/file falls back to original file for non-archive asset", async () => {
      const content = "content";
      const { body } = await uploadFile(
        new TextEncoder().encode(content),
        "single.txt",
        "text/plain",
      );
      // For non-archive assets, any subpath maps to the same storage key
      // (asset.type is not "archive", so isArchiveSubpath=false)
      const url = rewriteUrl(body.url).replace("single.txt", "subdir/nested.txt");
      const res = await fetch(url);
      // Falls back to the original file since type!="archive"
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(content);
    });
  });
});

// --- helpers ---

const FIXTURES = new URL("../scripts/fixtures/zip/data/", import.meta.url);

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

function golden(name: string): { path: string; size: number; hash: string }[] {
  const { entries } = JSON.parse(readFileSync(new URL(name.replace(/\.zip$/, ".golden.json"), FIXTURES), "utf8")) as {
    entries: { path: string; size: number; crc32: string }[];
  };
  return entries.map((e) => ({ path: e.path, size: e.size, hash: `crc32:${e.crc32}` }));
}

async function uploadFixture(name: string) {
  const { status, body, sessionId } = await uploadFile(fixtureBytes(name), name, "application/zip");
  expect(status).toBe(201);
  return { assetId: body.asset.id as string, headers: sessionId ? { "X-Session-Id": sessionId } : ({} as Record<string, string>) };
}

async function listFiles(assetId: string, headers: Record<string, string>, prefix?: string) {
  const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "";
  const res = await fetch(`${BASE}/api/v1/assets/${assetId}/files${query}`, { headers });
  expect(res.status).toBe(200);
  return parseNdjson(await res.text()).map(({ path, size, hash }) => ({ path, size, hash }));
}

function parseNdjson(text: string): any[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function entryUrl(assetId: string, path: string): string {
  return `${BASE}/files/${assetId}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function patchFirstEntry(zip: Uint8Array, patch: { flags?: number; method?: number }): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  const eocd = out.byteLength - 22;
  const cd = view.getUint32(eocd + 16, true);
  if (patch.flags !== undefined) {
    view.setUint16(6, patch.flags, true);
    view.setUint16(cd + 8, patch.flags, true);
  }
  if (patch.method !== undefined) {
    view.setUint16(8, patch.method, true);
    view.setUint16(cd + 10, patch.method, true);
  }
  return out;
}
