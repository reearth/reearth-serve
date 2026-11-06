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
      "/api/v1/workspaces/{id}/members",
      "/api/v1/workspaces/{id}/members/{userId}",
      "/files/{id}/{path}",
    ];
    for (const p of expectedPaths) {
      expect(paths, `missing path: ${p}`).toHaveProperty(p);
    }

    type Param = { $ref?: string; name?: string; in?: string };
    type Op = { parameters?: Param[] };
    const ops = paths as Record<string, Record<string, Op>>;
    const shared = (spec.components as { parameters?: Record<string, Param> } | undefined)?.parameters ?? {};
    const resolve = (p: Param) => (p.$ref ? shared[p.$ref.split("/").pop()!] ?? p : p);
    for (const p of ["/api/v1/assets", "/api/v1/assets/uploads"]) {
      expect(ops[p].post.parameters?.map(resolve), `${p} X-Project-Id`).toContainEqual(
        expect.objectContaining({ name: "X-Project-Id", in: "header" }),
      );
    }

    // Fetched twice on purpose: the server builds a fresh app per request, and
    // a regenerated spec once lost its named components.
    for (let i = 0; i < 2; i++) {
      const again = await (await fetch(`${BASE}/api/v1/doc`)).json() as { components: { schemas?: Record<string, unknown> } };
      expect(again.components.schemas).toHaveProperty("Asset");
    }
  });

  test("GET /api/v1/docs returns Scalar UI HTML", async () => {
    const res = await fetch(`${BASE}/api/v1/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
