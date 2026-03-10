import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.E2E_ENDPOINT ?? "http://localhost:8787";

// Rewrite URLs returned by the API to point to the actual test server.
// The worker's BASE_URL may differ from the E2E endpoint (e.g. different port).
function rewriteUrl(url: string): string {
  const parsed = new URL(url);
  const base = new URL(BASE);
  parsed.protocol = base.protocol;
  parsed.host = base.host;
  return parsed.toString();
}

// helper: upload a file via API
async function uploadFile(
  content: Uint8Array,
  filename: string,
  contentType: string,
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append("file", new Blob([content as BlobPart], { type: contentType }), filename);
  const res = await fetch(`${BASE}/assets`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

describe("E2E: Phase 0 MVP", () => {
  // ---- Health check ----
  beforeAll(async () => {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  // ---- Happy path ----

  describe("Basic flow", () => {
    let assetId: string;
    let fileUrl: string;
    const fileContent = "hello, reearth-serve!";

    test("1. Upload returns 201 with asset metadata and URL", async () => {
      const { status, body } = await uploadFile(
        new TextEncoder().encode(fileContent),
        "greeting.txt",
        "text/plain",
      );
      expect(status).toBe(201);
      expect(body.asset).toBeDefined();
      expect(body.asset.id).toBeTypeOf("string");
      expect(body.asset.filename).toBe("greeting.txt");
      expect(body.asset.contentType).toBe("text/plain");
      expect(body.asset.size).toBe(new TextEncoder().encode(fileContent).byteLength);
      expect(body.asset.expiresAt).toBeGreaterThan(Date.now());
      expect(body.url).toContain("/files/");

      assetId = body.asset.id;
      fileUrl = rewriteUrl(body.url);
    });

    test("2. GET /assets/:id returns correct metadata", async () => {
      const res = await fetch(`${BASE}/assets/${assetId}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.asset.id).toBe(assetId);
      expect(body.asset.filename).toBe("greeting.txt");
      expect(body.asset.contentType).toBe("text/plain");
    });

    test("3. File download returns correct content", async () => {
      const res = await fetch(fileUrl);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe(fileContent);
    });

    test("4. Content-Type is correct for different file types", async () => {
      const cases = [
        { name: "data.json", type: "application/json", content: '{"a":1}' },
        { name: "data.geojson", type: "application/geo+json", content: '{"type":"Point"}' },
        { name: "image.png", type: "image/png", content: "fakepng" },
      ];

      for (const c of cases) {
        const { body } = await uploadFile(new TextEncoder().encode(c.content), c.name, c.type);
        const res = await fetch(rewriteUrl(body.url));
        expect(res.headers.get("Content-Type")).toBe(c.type);
      }
    });

    test("5. CORS header present on /files response", async () => {
      const res = await fetch(fileUrl);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    test("6. CORS preflight on /files", async () => {
      const res = await fetch(fileUrl, {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "GET",
        },
      });
      expect(res.status).toBe(204);
      // Vite dev server may intercept OPTIONS before Hono's cors middleware.
      // In production (wrangler), Access-Control-Allow-Origin: * is set by Hono.
      const acao = res.headers.get("Access-Control-Allow-Origin");
      if (acao !== null) {
        expect(acao).toBe("*");
      }
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });

    test("7. Range request returns 206 with partial content", async () => {
      const res = await fetch(fileUrl, {
        headers: { Range: "bytes=0-4" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toMatch(/^bytes 0-4\//);
      const text = await res.text();
      expect(text).toBe("hello");
    });

    test("8. Open-ended Range request", async () => {
      const res = await fetch(fileUrl, {
        headers: { Range: "bytes=7-" },
      });
      expect(res.status).toBe(206);
      const text = await res.text();
      expect(text).toBe("reearth-serve!");
    });

    test("9. DELETE returns 204", async () => {
      const res = await fetch(`${BASE}/assets/${assetId}`, { method: "DELETE" });
      expect(res.status).toBe(204);
    });

    test("10. After deletion, metadata and file return 404", async () => {
      const metaRes = await fetch(`${BASE}/assets/${assetId}`);
      expect(metaRes.status).toBe(404);

      const fileRes = await fetch(fileUrl);
      expect(fileRes.status).toBe(404);
    });
  });

  // ---- CLI ----

  describe("CLI", () => {
    let tmpDir: string;
    let tmpFile: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "serve-e2e-"));
      tmpFile = join(tmpDir, "sample.txt");
      writeFileSync(tmpFile, "cli test content");
    });

    test("11. CLI outputs a URL that works", async () => {
      const out = execSync(
        `npx tsx cli/index.ts "${tmpFile}" --endpoint ${BASE}`,
        { encoding: "utf-8" },
      ).trim();
      expect(out).toContain("/files/");
      expect(out).toContain("sample.txt");

      // verify the URL actually serves the file
      const res = await fetch(rewriteUrl(out));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("cli test content");
    });

    test("12. CLI --json outputs JSON", () => {
      const out = execSync(
        `npx tsx cli/index.ts "${tmpFile}" --endpoint ${BASE} --json`,
        { encoding: "utf-8" },
      ).trim();
      const parsed = JSON.parse(out);
      expect(parsed.asset).toBeDefined();
      expect(parsed.url).toContain("/files/");
    });

    test("13. CLI --help exits 0", () => {
      const out = execSync("npx tsx cli/index.ts --help", {
        encoding: "utf-8",
      }).trim();
      expect(out).toContain("Usage:");
    });
  });

  // ---- Error cases ----

  describe("Error handling", () => {
    test("14. GET /assets/nonexistent returns 404", async () => {
      const res = await fetch(`${BASE}/assets/nonexistent`);
      expect(res.status).toBe(404);
    });

    test("15. GET /files/nonexistent/x.txt returns 404", async () => {
      const res = await fetch(`${BASE}/files/nonexistent/x.txt`);
      expect(res.status).toBe(404);
    });

    test("16. POST /assets without file field returns 400", async () => {
      const form = new FormData();
      const res = await fetch(`${BASE}/assets`, { method: "POST", body: form });
      expect(res.status).toBe(400);
    });

    test("17. DELETE /assets/nonexistent returns 404", async () => {
      const res = await fetch(`${BASE}/assets/nonexistent`, { method: "DELETE" });
      expect(res.status).toBe(404);
    });

    test("18. CLI with non-existent file exits with error", () => {
      expect(() => {
        execSync("npx tsx cli/index.ts /tmp/does_not_exist_12345.bin", {
          encoding: "utf-8",
          stdio: "pipe",
        });
      }).toThrow();
    });
  });

  // ---- Immutability ----

  describe("Immutability", () => {
    test("19. Uploading same file twice yields different IDs", async () => {
      const content = new TextEncoder().encode("duplicate");
      const { body: b1 } = await uploadFile(content, "dup.txt", "text/plain");
      const { body: b2 } = await uploadFile(content, "dup.txt", "text/plain");
      expect(b1.asset.id).not.toBe(b2.asset.id);
    });
  });

  // ---- CORS scoping ----

  describe("CORS scoping", () => {
    test("20. Management API does NOT have CORS header", async () => {
      const content = new TextEncoder().encode("cors test");
      const { body } = await uploadFile(content, "cors.txt", "text/plain");

      const res = await fetch(`${BASE}/assets/${body.asset.id}`);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });
});
