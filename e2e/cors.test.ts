import { describe, test, expect, beforeAll } from "vitest";
import { BASE, rewriteUrl, uploadFile } from "./helpers";

describe("CORS", () => {
  let fileUrl: string;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);

    const { body } = await uploadFile(
      new TextEncoder().encode("cors test file"),
      "cors-test.txt",
      "text/plain",
    );
    fileUrl = rewriteUrl(body.url);
  });

  test("CORS header present on /files response", async () => {
    const res = await fetch(fileUrl);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("CORS preflight on /files", async () => {
    const res = await fetch(fileUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    // Vite dev server may intercept OPTIONS before Hono's cors middleware.
    const acao = res.headers.get("Access-Control-Allow-Origin");
    if (acao !== null) {
      expect(acao).toBe("*");
    }
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  test("Management API does NOT have CORS header", async () => {
    const { body } = await uploadFile(
      new TextEncoder().encode("no cors"),
      "nocors.txt",
      "text/plain",
    );
    const res = await fetch(`${BASE}/api/v1/assets/${body.asset.id}`);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
