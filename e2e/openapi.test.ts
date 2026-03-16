import { describe, test, expect, beforeAll } from "vitest";
import { BASE } from "./helpers";

describe("OpenAPI", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/v1/health`);
    if (!res.ok) throw new Error(`Server not reachable at ${BASE}`);
  });

  test("GET /api/v1/doc returns valid OpenAPI 3.1 spec", async () => {
    const res = await fetch(`${BASE}/api/v1/doc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const spec = await res.json() as Record<string, unknown>;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toMatchObject({
      title: "Re:Earth Serve API",
      version: "1.0.0",
    });

    const paths = spec.paths as Record<string, unknown>;
    expect(paths).toBeDefined();

    // Verify key API paths are documented
    const expectedPaths = [
      "/api/v1/assets",
      "/api/v1/assets/{id}",
      "/api/v1/assets/{id}/files",
      "/api/v1/assets/{id}/extract",
      "/api/v1/assets/uploads",
      "/api/v1/assets/uploads/{id}/complete",
      "/api/v1/jobs",
      "/api/v1/jobs/{id}",
      "/api/v1/jobs/{id}/retry",
      "/api/v1/me",
      "/api/v1/projects",
      "/api/v1/projects/{id}",
      "/api/v1/workspaces",
      "/api/v1/workspaces/{id}",
      "/api/v1/workspaces/{workspaceId}/members",
      "/api/v1/workspaces/{workspaceId}/members/{userId}",
    ];
    for (const p of expectedPaths) {
      expect(paths, `missing path: ${p}`).toHaveProperty(p);
    }
  });

  test("GET /api/v1/docs returns Scalar UI HTML", async () => {
    const res = await fetch(`${BASE}/api/v1/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
