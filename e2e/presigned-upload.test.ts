import { describe, test, expect, beforeAll } from "vitest";
import { BASE, rewriteUrl } from "./helpers";

// Auto-detect if presigned uploads are available by probing the endpoint.
// Can also be forced via E2E_PRESIGNED=true/false.
let presignedAvailable = process.env.E2E_PRESIGNED === "true";
if (!process.env.E2E_PRESIGNED) {
  const probeBase = process.env.E2E_ENDPOINT ?? "http://localhost:8787";
  try {
    const res = await fetch(`${probeBase}/api/v1/assets/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "probe.txt", contentType: "text/plain", size: 1 }),
    });
    presignedAvailable = res.status !== 501;
  } catch {
    // server unreachable — will fail in beforeAll anyway
  }
}

/** Helper: POST JSON with session */
async function postJson(path: string, body: unknown, sessionId?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  return fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Helper: POST with session (no body) */
async function post(path: string, sessionId?: string) {
  const headers: Record<string, string> = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  return fetch(`${BASE}${path}`, { method: "POST", headers });
}

/** Helper: GET with session */
async function get(path: string, sessionId?: string) {
  const headers: Record<string, string> = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  return fetch(`${BASE}${path}`, { headers });
}

/** Helper: DELETE with session */
async function del(path: string, sessionId?: string) {
  const headers: Record<string, string> = {};
  if (sessionId) headers["X-Session-Id"] = sessionId;
  return fetch(`${BASE}${path}`, { method: "DELETE", headers });
}

describe("Presigned URL upload", () => {
  let sessionId: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
    // Get a session ID for all presigned tests
    sessionId = res.headers.get("X-Session-Id") ?? "";
  });

  // ---- Local-only tests (no S3 creds) ----

  test("POST /api/v1/assets/uploads returns 501 when S3 credentials not configured", { skip: presignedAvailable }, async () => {
    const res = await postJson("/api/v1/assets/uploads", { filename: "test.txt", contentType: "text/plain", size: 5 }, sessionId);
    expect(res.status).toBe(501);
    const body = await res.json() as any;
    expect(body.error).toBeDefined();
  });

  test("POST /api/v1/assets/uploads validates required fields", async () => {
    const res = await postJson("/api/v1/assets/uploads", {}, sessionId);
    expect([400, 501]).toContain(res.status);
  });

  test("POST /api/v1/assets/uploads/:id/complete returns 404 for nonexistent session", async () => {
    const res = await post("/api/v1/assets/uploads/nonexistent/complete", sessionId);
    expect(res.status).toBe(404);
  });

  // ---- Presigned single PUT (requires S3 creds) ----

  describe("Single presigned upload", { skip: !presignedAvailable }, () => {
    const fileContent = "presigned-single-upload-test-content";
    let uploadId: string;
    let fileUrl: string;

    test("Create upload session returns presigned URL", async () => {
      const res = await postJson("/api/v1/assets/uploads",
        { filename: "single.txt", contentType: "text/plain", size: fileContent.length },
        sessionId,
      );
      expect(res.status).toBe(201);

      const body = await res.json() as any;
      expect(body.uploadId).toBeTypeOf("string");
      expect(body.url).toBeTypeOf("string");
      expect(body.method).toBe("PUT");

      uploadId = body.uploadId;

      // PUT file directly to R2
      const putRes = await fetch(body.url, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: fileContent,
      });
      expect(putRes.ok).toBe(true);
    });

    test("Complete upload session returns asset", async () => {
      const res = await post(`/api/v1/assets/uploads/${uploadId}/complete`, sessionId);
      expect(res.status).toBe(201);

      const body = await res.json() as any;
      expect(body.asset).toBeDefined();
      expect(body.asset.id).toBe(uploadId);
      expect(body.asset.filename).toBe("single.txt");
      expect(body.asset.size).toBe(fileContent.length);
      expect(body.url).toContain("/files/");

      fileUrl = rewriteUrl(body.url);
    });

    test("File is downloadable after presigned upload", async () => {
      const res = await fetch(fileUrl);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe(fileContent);
    });

    test("Asset metadata is correct", async () => {
      const res = await get(`/api/v1/assets/${uploadId}`, sessionId);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.asset.contentType).toBe("text/plain");
    });

    test("Cleanup: delete uploaded asset", async () => {
      const res = await del(`/api/v1/assets/${uploadId}`, sessionId);
      expect(res.status).toBe(204);
    });
  });

  // ---- Multipart upload (requires S3 creds) ----

  describe("Multipart presigned upload", { skip: !presignedAvailable }, () => {
    // Create a 15MB test payload split into 3 parts of 5MB
    const PART_SIZE = 5 * 1024 * 1024;
    const PART_COUNT = 3;
    const totalSize = PART_SIZE * PART_COUNT;
    let fileData: Uint8Array;
    let uploadId: string;
    let fileUrl: string;
    let partUrls: { partNumber: number; url: string }[];

    beforeAll(() => {
      // Fill with a repeating pattern so we can verify integrity
      fileData = new Uint8Array(totalSize);
      for (let i = 0; i < totalSize; i++) {
        fileData[i] = i % 256;
      }
    });

    test("Create multipart upload session returns part URLs", async () => {
      const res = await postJson("/api/v1/assets/uploads", {
        filename: "multipart.bin",
        contentType: "application/octet-stream",
        size: totalSize,
        partCount: PART_COUNT,
      }, sessionId);
      expect(res.status).toBe(201);

      const body = await res.json() as any;
      expect(body.uploadId).toBeTypeOf("string");
      expect(body.parts).toHaveLength(PART_COUNT);

      for (let i = 0; i < PART_COUNT; i++) {
        expect(body.parts[i].partNumber).toBe(i + 1);
        expect(body.parts[i].url).toBeTypeOf("string");
      }

      uploadId = body.uploadId;
      partUrls = body.parts;
    });

    test("Upload all parts in parallel and collect ETags", async () => {
      const etags: { partNumber: number; etag: string }[] = [];

      const results = await Promise.all(
        partUrls.map(async (part) => {
          const start = (part.partNumber - 1) * PART_SIZE;
          const end = start + PART_SIZE;
          const chunk = fileData.subarray(start, end);

          const res = await fetch(part.url, {
            method: "PUT",
            body: chunk as BodyInit,
          });
          expect(res.ok).toBe(true);

          const etag = res.headers.get("ETag");
          expect(etag).not.toBeNull();

          return { partNumber: part.partNumber, etag: etag! };
        }),
      );

      etags.push(...results);

      // Complete multipart upload with ETags
      const completeRes = await postJson(`/api/v1/assets/uploads/${uploadId}/complete`, { parts: etags }, sessionId);
      expect(completeRes.status).toBe(201);

      const body = await completeRes.json() as any;
      expect(body.asset).toBeDefined();
      expect(body.asset.id).toBe(uploadId);
      expect(body.asset.filename).toBe("multipart.bin");
      expect(body.asset.size).toBe(totalSize);
      expect(body.url).toContain("/files/");

      fileUrl = rewriteUrl(body.url);
    });

    test("Multipart file is downloadable and intact", async () => {
      const res = await fetch(fileUrl);
      expect(res.status).toBe(200);

      const downloaded = new Uint8Array(await res.arrayBuffer());
      expect(downloaded.byteLength).toBe(totalSize);

      // Verify integrity: check pattern at several points
      expect(downloaded[0]).toBe(0);
      expect(downloaded[255]).toBe(255);
      expect(downloaded[256]).toBe(0);
      expect(downloaded[PART_SIZE]).toBe(0); // start of part 2
      expect(downloaded[totalSize - 1]).toBe((totalSize - 1) % 256);
    });

    test("Range request works on multipart-uploaded file", async () => {
      const res = await fetch(fileUrl, {
        headers: { Range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);

      const data = new Uint8Array(await res.arrayBuffer());
      expect(data.byteLength).toBe(10);
      for (let i = 0; i < 10; i++) {
        expect(data[i]).toBe(i);
      }
    });

    test("Cleanup: delete multipart-uploaded asset", async () => {
      const res = await del(`/api/v1/assets/${uploadId}`, sessionId);
      expect(res.status).toBe(204);
    });
  });

  // ---- Error cases for multipart ----

  describe("Multipart error handling", { skip: !presignedAvailable }, () => {
    test("Complete without uploading parts returns 404", async () => {
      const initRes = await postJson("/api/v1/assets/uploads", {
        filename: "ghost.bin",
        contentType: "application/octet-stream",
        size: 10_000_000,
        partCount: 2,
      }, sessionId);
      expect(initRes.status).toBe(201);

      const { uploadId } = await initRes.json() as any;

      // Try to complete without uploading any parts — should fail
      const res = await postJson(`/api/v1/assets/uploads/${uploadId}/complete`, { parts: [] }, sessionId);
      expect(res.status).toBe(404);
    });

    test("Complete multipart without parts body returns 404", async () => {
      const initRes = await postJson("/api/v1/assets/uploads", {
        filename: "noparts.bin",
        contentType: "application/octet-stream",
        size: 10_000_000,
        partCount: 2,
      }, sessionId);
      expect(initRes.status).toBe(201);

      const { uploadId } = await initRes.json() as any;

      // Complete without providing parts at all
      const res = await post(`/api/v1/assets/uploads/${uploadId}/complete`, sessionId);
      expect(res.status).toBe(404);
    });
  });
});
