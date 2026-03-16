import { describe, test, expect, beforeAll } from "vitest";
import { BASE, rewriteUrl, uploadFile } from "./helpers";

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

    test("POST /api/internal/jobs/:id/status returns 404 for non-existent job", async () => {
      const res = await fetch(`${BASE}/api/internal/jobs/nonexistent-job-id/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      });
      expect(res.status).toBe(404);
    });

    test("Job lifecycle: upload creates job, status transitions through pending → extracting → ready", async () => {
      // Upload a ZIP — job should be auto-created
      const zipBytes = buildMiniZip({ "a.txt": "hello" });
      const { body: uploadBody } = await uploadFile(zipBytes, "lifecycle.zip", "application/zip");
      const assetId = uploadBody.asset.id;

      // Asset should have pending status
      expect(uploadBody.asset.type).toBe("archive");
      expect(uploadBody.asset.status).toBe("pending");
      expect(uploadBody.asset.archiveFormat).toBe("zip");
      expect(uploadBody.asset.jobId).toBe(assetId);

      // Job should exist and be pending
      const jobRes = await fetch(`${BASE}/api/v1/jobs/${assetId}`);
      expect(jobRes.status).toBe(200);
      const job = await jobRes.json() as any;
      expect(job.status).toBe("pending");

      // Container reports running → asset becomes extracting
      const runRes = await fetch(`${BASE}/api/internal/jobs/${assetId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "running" }),
      });
      expect(runRes.status).toBe(200);

      const assetDuring = await (await fetch(`${BASE}/api/v1/assets/${assetId}`)).json() as any;
      expect(assetDuring.asset.status).toBe("extracting");

      // Container reports completed → asset becomes ready
      const completeRes = await fetch(`${BASE}/api/internal/jobs/${assetId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", fileCount: 1, extractedSize: 5 }),
      });
      expect(completeRes.status).toBe(200);

      const assetAfter = await (await fetch(`${BASE}/api/v1/assets/${assetId}`)).json() as any;
      expect(assetAfter.asset.status).toBe("ready");
      expect(assetAfter.asset.fileCount).toBe(1);
      expect(assetAfter.asset.extractedSize).toBe(5);
    });

    test("Container extraction: upload ZIP, wait for extraction, verify files", { timeout: 120_000 }, async () => {
      const files = {
        "tileset.json": '{"root":"test"}',
        "tiles/0.json": '{"tile":0}',
        "tiles/1.json": '{"tile":1}',
      };
      const zipBytes = buildMiniZip(files);
      const { status, body: uploadBody } = await uploadFile(zipBytes, "extract-test.zip", "application/zip");
      expect(status).toBe(201);

      const assetId = uploadBody.asset.id;
      expect(uploadBody.asset.status).toBe("pending");

      // Poll job until completed or failed (max 90s)
      let jobStatus = "pending";
      let lastJob: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`${BASE}/api/v1/jobs/${assetId}`);
        lastJob = await res.json() as any;
        jobStatus = lastJob.status;
        if (jobStatus === "completed" || jobStatus === "failed") break;
      }
      if (jobStatus !== "completed") {
        console.error(`Job did not complete. assetId=${assetId}, lastJob=`, JSON.stringify(lastJob));
      }
      expect(jobStatus).toBe("completed");

      // Verify asset status is ready (poll to allow for KV eventual consistency)
      let assetStatus = "pending";
      let assetRes: any;
      for (let i = 0; i < 10; i++) {
        assetRes = await (await fetch(`${BASE}/api/v1/assets/${assetId}`)).json() as any;
        assetStatus = assetRes.asset.status;
        if (assetStatus === "ready" || assetStatus === "failed") break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(assetStatus).toBe("ready");
      expect(assetRes.asset.fileCount).toBe(Object.keys(files).length);

      // Verify file list via NDJSON API
      const filesRes = await fetch(`${BASE}/api/v1/assets/${assetId}/files`);
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
      const { body } = await uploadFile(content, "simple.txt", "text/plain");
      const assetId = body.asset.id;

      const res = await fetch(`${BASE}/api/v1/assets/${assetId}/files`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
      const entries = parseNdjson(await res.text());
      expect(entries).toHaveLength(1);
      expect(entries[0].path).toBe("simple.txt");
      expect(entries[0].size).toBe(5);
    });

    test("GET /api/v1/assets/:id/files returns empty for pending archive", async () => {
      const zipBytes = buildMiniZip({ "a.txt": "data" });
      const { body } = await uploadFile(zipBytes, "pending.zip", "application/zip");
      const assetId = body.asset.id;

      const res = await fetch(`${BASE}/api/v1/assets/${assetId}/files`);
      expect(res.status).toBe(200);
      const entries = parseNdjson(await res.text());
      expect(entries).toHaveLength(0);
    });

    test("GET /api/v1/assets/:id/files supports prefix filter", async () => {
      const content = new TextEncoder().encode("hello");
      const { body } = await uploadFile(content, "data.txt", "text/plain");
      const assetId = body.asset.id;

      // Matching prefix
      const res1 = await fetch(`${BASE}/api/v1/assets/${assetId}/files?prefix=data`);
      expect(res1.status).toBe(200);
      const entries1 = parseNdjson(await res1.text());
      expect(entries1).toHaveLength(1);

      // Non-matching prefix
      const res2 = await fetch(`${BASE}/api/v1/assets/${assetId}/files?prefix=other`);
      expect(res2.status).toBe(200);
      const entries2 = parseNdjson(await res2.text());
      expect(entries2).toHaveLength(0);
    });

    test("GET /api/v1/assets/:id/files returns 404 for non-existent asset", async () => {
      const res = await fetch(`${BASE}/api/v1/assets/nonexistent/files`);
      expect(res.status).toBe(404);
    });
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

/**
 * Build a minimal valid ZIP file with the given entries.
 * Uses a simple implementation of the ZIP format (no compression — store only).
 */
function buildMiniZip(files: Record<string, string>): Uint8Array {
  const entries = Object.entries(files);
  const localHeaders: Uint8Array[] = [];
  const centralHeaders: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const contentBytes = new TextEncoder().encode(content);
    const crc = crc32(contentBytes);

    // Local file header
    const local = new ArrayBuffer(30 + nameBytes.length + contentBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // compression: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true); // crc32
    lv.setUint32(18, contentBytes.length, true); // compressed size
    lv.setUint32(22, contentBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // name length
    lv.setUint16(28, 0, true); // extra length
    new Uint8Array(local).set(nameBytes, 30);
    new Uint8Array(local).set(contentBytes, 30 + nameBytes.length);
    localHeaders.push(new Uint8Array(local));

    // Central directory header
    const central = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(central);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // compression
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true); // crc32
    cv.setUint32(20, contentBytes.length, true); // compressed
    cv.setUint32(24, contentBytes.length, true); // uncompressed
    cv.setUint16(28, nameBytes.length, true); // name length
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    new Uint8Array(central).set(nameBytes, 46);
    centralHeaders.push(new Uint8Array(central));

    offset += 30 + nameBytes.length + contentBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const ch of centralHeaders) centralSize += ch.length;

  // End of central directory
  const eocd = new ArrayBuffer(22);
  const ev = new DataView(eocd);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true); // entries on disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true); // central dir size
  ev.setUint32(16, centralOffset, true); // central dir offset
  ev.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralSize + 22;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const lh of localHeaders) { result.set(lh, pos); pos += lh.length; }
  for (const ch of centralHeaders) { result.set(ch, pos); pos += ch.length; }
  result.set(new Uint8Array(eocd), pos);

  return result;
}

function parseNdjson(text: string): any[] {
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Simple CRC-32 implementation for ZIP. */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
