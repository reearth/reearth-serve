import { describe, test, expect, beforeAll } from "vitest";
import { BASE, rewriteUrl, uploadFile } from "./helpers";

describe("Basic flow", () => {
  let assetId: string;
  let fileUrl: string;
  let sessionId: string;
  const fileContent = "hello, reearth-serve!";

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  test("Upload returns 201 with asset metadata and URL", async () => {
    const result = await uploadFile(
      new TextEncoder().encode(fileContent),
      "greeting.txt",
      "text/plain",
    );
    expect(result.status).toBe(201);
    expect(result.body.asset).toBeDefined();
    expect(result.body.asset.id).toBeTypeOf("string");
    expect(result.body.asset.filename).toBe("greeting.txt");
    expect(result.body.asset.contentType).toBe("text/plain");
    expect(result.body.asset.size).toBe(new TextEncoder().encode(fileContent).byteLength);
    expect(result.body.asset.expiresAt).toBeGreaterThan(Date.now());
    expect(result.body.url).toContain("/files/");

    assetId = result.body.asset.id;
    fileUrl = rewriteUrl(result.body.url);
    sessionId = result.sessionId!;
  });

  test("GET /api/v1/assets/:id returns correct metadata", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      headers: { "X-Session-Id": sessionId },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.asset.id).toBe(assetId);
    expect(body.asset.filename).toBe("greeting.txt");
    expect(body.asset.contentType).toBe("text/plain");
  });

  test("File download returns correct content", async () => {
    const res = await fetch(fileUrl);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(fileContent);
  });

  test("Content-Type is correct for different file types", async () => {
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

  test("Range request returns 206 with partial content", async () => {
    const res = await fetch(fileUrl, {
      headers: { Range: "bytes=0-4" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toMatch(/^bytes 0-4\//);
    const text = await res.text();
    expect(text).toBe("hello");
  });

  test("Open-ended Range request", async () => {
    const res = await fetch(fileUrl, {
      headers: { Range: "bytes=7-" },
    });
    expect(res.status).toBe(206);
    const text = await res.text();
    expect(text).toBe("reearth-serve!");
  });

  test("DELETE returns 204", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      method: "DELETE",
      headers: { "X-Session-Id": sessionId },
    });
    expect(res.status).toBe(204);
  });

  test("After deletion, metadata and file return 404", async () => {
    const metaRes = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      headers: { "X-Session-Id": sessionId },
    });
    expect(metaRes.status).toBe(404);

    const fileRes = await fetch(fileUrl);
    expect(fileRes.status).toBe(404);
  });

  test("Uploading same file twice yields different IDs", async () => {
    const content = new TextEncoder().encode("duplicate");
    const { body: b1 } = await uploadFile(content, "dup.txt", "text/plain");
    const { body: b2 } = await uploadFile(content, "dup.txt", "text/plain");
    expect(b1.asset.id).not.toBe(b2.asset.id);
  });
});
